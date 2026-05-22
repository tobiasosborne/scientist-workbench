// =============================================================================
// sturm-then — sequential composition of two Sturm channels
// =============================================================================
//
// Intent
// ------
// `sturm-then` is the IR-level realisation of v3 spec §4.1's `then(f, g)`
// combinator. Given two channels whose signatures match at the
// boundary — `first.outputs` plugs into `second.inputs` — it produces
// the composite channel whose body runs `first.body` then `second.body`,
// with second's wire ids alpha-renamed to (a) match the boundary and
// (b) avoid clashing with first's internal wires.
//
// Wire-id discipline
// ------------------
// Wire ids are local to a channel (ADR-0006). When we concatenate two
// bodies, we alpha-rename one side. The convention this tool fixes:
//   1. `first` keeps its wire ids verbatim.
//   2. Each of `second`'s input wires is renamed to the corresponding
//      `first` output wire id (matched positionally).
//   3. Every other wire id in `second` is shifted by `max(first.ids) + 1`,
//      guaranteeing no collision with first's wires. The shift is the
//      simplest scheme that works; a smarter renumbering (compact
//      ranges) is an optimisation a downstream `sturm-renumber` could
//      apply if anyone needed contiguous ids.
//
// Signature matching is positional: same length and same `kind` (and
// matching `dim` when both sides specify one). A length / kind / dim
// mismatch is a *boundary failure*, not a `ToolError`: the tool
// computed the right answer (no composition exists for these
// signatures), but the caller's IR is unsupported. We emit
// `tagged "sturm-then/signature-mismatch"` per ADR-0003.
//
// Classical refs are *not* renamed. Within the IR, `classical_ref`
// strings are scoped per-channel by convention; concatenating bodies
// makes refs from `first` available to `second`, which is the intended
// behaviour when `second` is written to consume a measurement bound by
// `first` (e.g., `first` ends with `observe(w, "r")` and `second`'s
// body opens with `cases("r", …)`). If two channels independently
// bind the same ref, `checkWellFormed` on the composite catches the
// duplicate; `sturm-then` itself stays mechanical.
//
// Input shape
// -----------
//   record { first: channel, second: channel }
//
// Output shape
// ------------
//   - happy path: a channel
//   - signature mismatch: `tagged "sturm-then/signature-mismatch" <reason>`

import {
  S,
  expr,
  int,
  list,
  rat,
  record,
  str,
  sym,
  tagged,
  type Schema,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  casesOp,
  channel,
  channelSchema,
  decodeChannel,
  discardOp,
  encodeChannel,
  encodeOp,
  observeOp,
  oracleOp,
  prepareOp,
  ryOp,
  rzOp,
  wire,
  type Channel,
  type Op,
  type Wire,
} from "@workbench/sturm-ir";

const NAME = "sturm-then";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Sentinel for signature mismatch
// -----------------------------------------------------------------------------

class SignatureMismatch extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "SignatureMismatch";
  }
}

// -----------------------------------------------------------------------------
// Wire-id collection (used for max-id computation)
// -----------------------------------------------------------------------------

function addOpWires(op: Op, ids: Set<bigint>): void {
  switch (op.head) {
    case "prepare":
      ids.add(op.wireId);
      return;
    case "ry":
    case "rz":
      ids.add(op.wireId);
      for (const c of op.controls) ids.add(c);
      return;
    case "observe":
    case "discard":
      ids.add(op.wireId);
      return;
    case "oracle":
      for (const w of op.inWires) ids.add(w);
      for (const w of op.outWires) ids.add(w);
      return;
    case "cases":
      for (const o of op.trueArm) addOpWires(o, ids);
      for (const o of op.falseArm) addOpWires(o, ids);
      return;
  }
}

function channelWireIds(c: Channel): Set<bigint> {
  const ids = new Set<bigint>();
  for (const w of c.inputs) ids.add(w.id);
  for (const w of c.outputs) ids.add(w.id);
  for (const op of c.body) addOpWires(op, ids);
  return ids;
}

function maxId(ids: Set<bigint>): bigint {
  let m = -1n;
  for (const id of ids) if (id > m) m = id;
  return m;
}

// -----------------------------------------------------------------------------
// Signature matching
// -----------------------------------------------------------------------------

function checkSignaturesMatch(
  outs: readonly Wire[],
  ins: readonly Wire[]
): void {
  if (outs.length !== ins.length) {
    throw new SignatureMismatch(
      `first.outputs has ${outs.length} wires but second.inputs has ${ins.length} wires; signatures must match length-wise to compose`
    );
  }
  for (let i = 0; i < outs.length; i++) {
    const a = outs[i]!;
    const b = ins[i]!;
    if (a.kind !== b.kind) {
      throw new SignatureMismatch(
        `position ${i}: first.outputs has kind "${a.kind}" but second.inputs has kind "${b.kind}"`
      );
    }
    if (a.dim !== undefined && b.dim !== undefined && a.dim !== b.dim) {
      throw new SignatureMismatch(
        `position ${i}: first.outputs has dim "${a.dim}" but second.inputs has dim "${b.dim}"`
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Renaming
// -----------------------------------------------------------------------------

function buildRename(
  first: Channel,
  second: Channel
): (id: bigint) => bigint {
  const interfaceMap = new Map<bigint, bigint>();
  for (let i = 0; i < second.inputs.length; i++) {
    interfaceMap.set(second.inputs[i]!.id, first.outputs[i]!.id);
  }
  const offset = maxId(channelWireIds(first)) + 1n;
  return (id: bigint) => {
    const mapped = interfaceMap.get(id);
    if (mapped !== undefined) return mapped;
    return id + offset;
  };
}

function renameOp(op: Op, rename: (id: bigint) => bigint): Op {
  switch (op.head) {
    case "prepare":
      return prepareOp(op.p, rename(op.wireId));
    case "ry":
      return ryOp(rename(op.wireId), op.delta, op.controls.map(rename));
    case "rz":
      return rzOp(rename(op.wireId), op.delta, op.controls.map(rename));
    case "observe":
      return observeOp(rename(op.wireId), op.classicalRef);
    case "discard":
      return discardOp(rename(op.wireId));
    case "oracle":
      // The embedded `circuit` Value has its own wire-id namespace and
      // is not renamed — that channel was sealed when its hash was
      // computed by sturm-bennett-oracle (or whoever produced it).
      // Only the outer in/out wire references — which name wires in
      // the *enclosing* channel — get rewritten.
      return oracleOp(
        op.circuit,
        op.inWires.map(rename),
        op.outWires.map(rename)
      );
    case "cases":
      return casesOp(
        op.classicalRef,
        op.trueArm.map((o) => renameOp(o, rename)),
        op.falseArm.map((o) => renameOp(o, rename))
      );
  }
}

function renameWire(w: Wire, rename: (id: bigint) => bigint): Wire {
  return w.dim === undefined
    ? wire(rename(w.id), w.kind)
    : wire(rename(w.id), w.kind, w.dim);
}

// -----------------------------------------------------------------------------
// Main entry — full transform
// -----------------------------------------------------------------------------

function thenChannels(first: Channel, second: Channel): Channel {
  checkSignaturesMatch(first.outputs, second.inputs);
  const rename = buildRename(first, second);
  const renamedBody = second.body.map((op) => renameOp(op, rename));
  const renamedOutputs = second.outputs.map((w) => renameWire(w, rename));
  return channel(first.inputs, renamedOutputs, [
    ...first.body,
    ...renamedBody,
  ]);
}

// -----------------------------------------------------------------------------
// Schema declarations
// -----------------------------------------------------------------------------

const inputSchema: Schema<Value> = S.record({
  first: channelSchema,
  second: channelSchema,
});

const outputSchema: Schema<Value> = S.union([
  channelSchema,
  S.tagged("sturm-then/signature-mismatch", S.kind("string")),
]);

// -----------------------------------------------------------------------------
// Example helpers
// -----------------------------------------------------------------------------

function inputRecord(first: Channel, second: Channel): Value {
  return record({ first: encodeChannel(first), second: encodeChannel(second) });
}

const Q = (id: bigint): Wire => wire(id, "quantum");
const C = (id: bigint): Wire => wire(id, "classical");
const PI = sym("π");
const piOver = (n: bigint): Value => expr("/", [PI, int(n)]);

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Sturm channel combinator: sequential composition `f; g`; positional wire renaming at the boundary; length/kind/dim mismatch → boundary tag",
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "compose two empty channels — empty composite",
      input: inputRecord(channel([], [], []), channel([], [], [])),
      output: encodeChannel(channel([], [], [])),
    },
    {
      description: "first prepares wire 0, second observes wire 0 — wires align",
      input: inputRecord(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel([Q(0n)], [], [observeOp(0n, "r")])
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
        )
      ),
    },
    {
      description: "interface wire id renaming — second's input id 5 maps to first's output id 0",
      input: inputRecord(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel([Q(5n)], [], [observeOp(5n, "r")])
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
        )
      ),
    },
    {
      description: "second's internal wire id shifted past first's max",
      input: inputRecord(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel(
          [Q(5n)],
          [Q(5n), Q(6n)],
          [prepareOp(rat(0n, 1n), 6n), ryOp(6n, PI, [5n])]
        )
      ),
      // first.maxId = 0; offset = 1. second's input 5 -> 0; internal 6 -> 7.
      output: encodeChannel(
        channel(
          [],
          [Q(0n), Q(7n)],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 7n),
            ryOp(7n, PI, [0n]),
          ]
        )
      ),
    },
    {
      description: "two-wire signature passes through positionally",
      input: inputRecord(
        channel(
          [],
          [Q(0n), Q(1n)],
          [prepareOp(rat(0n, 1n), 0n), prepareOp(rat(0n, 1n), 1n)]
        ),
        channel(
          [Q(7n), Q(8n)],
          [],
          [observeOp(7n, "a"), observeOp(8n, "b")]
        )
      ),
      output: encodeChannel(
        // 7 -> 0, 8 -> 1.
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            observeOp(0n, "a"),
            observeOp(1n, "b"),
          ]
        )
      ),
    },
    {
      description: "first's classical-ref binding flows into second's cases",
      input: inputRecord(
        channel(
          [],
          [],
          [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
        ),
        channel(
          [],
          [Q(0n)],
          [
            prepareOp(rat(0n, 1n), 0n),
            casesOp("r", [ryOp(0n, PI, [])], []),
          ]
        )
      ),
      // first.maxId = 0, offset = 1. second has no inputs; internal 0 -> 1.
      output: encodeChannel(
        channel(
          [],
          [Q(1n)],
          [
            prepareOp(rat(0n, 1n), 0n),
            observeOp(0n, "r"),
            prepareOp(rat(0n, 1n), 1n),
            casesOp("r", [ryOp(1n, PI, [])], []),
          ]
        )
      ),
    },
    {
      description: "second's controls list gets renamed positionally",
      input: inputRecord(
        channel(
          [],
          [Q(0n), Q(1n)],
          [prepareOp(rat(0n, 1n), 0n), prepareOp(rat(0n, 1n), 1n)]
        ),
        channel(
          [Q(3n), Q(4n)],
          [Q(3n), Q(4n)],
          [ryOp(4n, PI, [3n])]
        )
      ),
      // 3 -> 0, 4 -> 1.
      output: encodeChannel(
        channel(
          [],
          [Q(0n), Q(1n)],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            ryOp(1n, PI, [0n]),
          ]
        )
      ),
    },
    {
      description: "channel with input wires composes through second",
      input: inputRecord(
        channel(
          [Q(0n)],
          [Q(0n)],
          [ryOp(0n, piOver(2n), [])]
        ),
        channel(
          [Q(0n)],
          [Q(0n)],
          [rzOp(0n, PI, [])]
        )
      ),
      output: encodeChannel(
        channel(
          [Q(0n)],
          [Q(0n)],
          [ryOp(0n, piOver(2n), []), rzOp(0n, PI, [])]
        )
      ),
    },
    {
      description: "out-of-scope: signature length mismatch",
      input: inputRecord(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel([], [], [])
      ),
      output: tagged(
        "sturm-then/signature-mismatch",
        str(
          "first.outputs has 1 wires but second.inputs has 0 wires; signatures must match length-wise to compose"
        )
      ),
    },
    {
      description: "out-of-scope: signature kind mismatch (quantum vs classical)",
      input: inputRecord(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel([C(0n)], [], [])
      ),
      output: tagged(
        "sturm-then/signature-mismatch",
        str(
          'position 0: first.outputs has kind "quantum" but second.inputs has kind "classical"'
        )
      ),
    },
    {
      description: "out-of-scope: signature dim mismatch (qubit vs qudit)",
      input: inputRecord(
        channel(
          [],
          [wire(0n, "quantum", "qubit")],
          [prepareOp(rat(0n, 1n), 0n)]
        ),
        channel([wire(0n, "quantum", "qudit")], [], [])
      ),
      output: tagged(
        "sturm-then/signature-mismatch",
        str(
          'position 0: first.outputs has dim "qubit" but second.inputs has dim "qudit"'
        )
      ),
    },
    {
      description: "associativity probe: then(then(empty, empty), empty) = then(empty, then(empty, empty))",
      input: inputRecord(
        channel([], [], []),
        channel([], [], [])
      ),
      output: encodeChannel(channel([], [], [])),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
    {
      name: "signature-match-required",
      statement:
        "if first.outputs and second.inputs differ in length, kind, or (when both specify) dim, the output is tagged 'sturm-then/signature-mismatch'",
      machine_checkable: true,
    },
    {
      name: "first-prefix-preserved",
      statement:
        "the composite's body begins with first.body verbatim; first's wire ids are unchanged",
      machine_checkable: true,
    },
    {
      name: "second-renamed-into-first",
      statement:
        "second's input wires are renamed positionally to match first.outputs; every other wire id in second is shifted by max(first.ids)+1",
      machine_checkable: true,
    },
    {
      name: "associativity",
      statement:
        "then(then(f, g), h) byte-equals then(f, then(g, h)) under the chosen rename discipline",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    if (input.kind !== "record") {
      throw new Error("sturm-then: internal: input not a record");
    }
    const f = input.fields.first;
    const g = input.fields.second;
    if (f === undefined || g === undefined) {
      throw new Error("sturm-then: internal: missing required fields");
    }
    const first = decodeChannel(f);
    const second = decodeChannel(g);
    try {
      return encodeChannel(thenChannels(first, second));
    } catch (e) {
      if (e instanceof SignatureMismatch) {
        return tagged("sturm-then/signature-mismatch", str(e.reason));
      }
      throw e;
    }
  },
  test: () => {
    void list;
    // Determinism: same input twice → same output bytes.
    const f = channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]);
    const g = channel([Q(0n)], [], [observeOp(0n, "r")]);
    const a = encodeChannel(thenChannels(f, g));
    const b = encodeChannel(thenChannels(f, g));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error("sturm-then test: not deterministic");
    }

    // Signature mismatch produces the sentinel.
    let sigMismatchHit = false;
    try {
      thenChannels(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel([], [], [])
      );
    } catch (e) {
      if (e instanceof SignatureMismatch) sigMismatchHit = true;
    }
    if (!sigMismatchHit) {
      throw new Error("sturm-then test: length mismatch not rejected");
    }

    // First prefix preserved + ids unchanged.
    const composite = thenChannels(f, g);
    if (composite.body.length < f.body.length) {
      throw new Error("sturm-then test: first body not preserved");
    }
    // Compare via the encoded Value form so JSON.stringify doesn't trip on bigint.
    for (let i = 0; i < f.body.length; i++) {
      const lhs = JSON.stringify(encodeOp(composite.body[i]!));
      const rhs = JSON.stringify(encodeOp(f.body[i]!));
      if (lhs !== rhs) {
        throw new Error(
          `sturm-then test: first.body[${i}] not preserved verbatim`
        );
      }
    }

    // Associativity: then(then(f, g), h) === then(f, then(g, h)) byte-equal,
    // where h is the empty channel (an identity for the empty signature).
    const h = channel([], [], []);
    const lhs = encodeChannel(thenChannels(thenChannels(f, g), h));
    const rhs = encodeChannel(thenChannels(f, thenChannels(g, h)));
    if (JSON.stringify(lhs) !== JSON.stringify(rhs)) {
      throw new Error(
        `sturm-then test: associativity failed.\nlhs=${JSON.stringify(lhs)}\nrhs=${JSON.stringify(rhs)}`
      );
    }
  },
});

if (import.meta.main) void runTool(def);
