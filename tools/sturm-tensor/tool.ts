// =============================================================================
// sturm-tensor — parallel composition of two Sturm channels
// =============================================================================
//
// Intent
// ------
// `sturm-tensor` is the IR-level realisation of v3 spec §4.1's
// `tensor(f, g)` combinator: the monoidal product on the channel
// category. Given two channels with disjoint operand spaces, it
// produces the channel that runs both in parallel, side-by-side. The
// composite's signature is the disjoint union of left and right's
// signatures (in that order), and its body is left.body followed by
// right.body — sequencing in the body is irrelevant under the
// commuting-on-disjoint-wires fact, but we pick a canonical order
// (left first) so the encoding is byte-deterministic.
//
// Wire-id discipline
// ------------------
// Wire ids are local to each channel (ADR-0006). To merge them into a
// single namespace we alpha-rename one side. Convention:
//   1. `left` keeps its wire ids verbatim.
//   2. Every wire id in `right` is shifted by `max(left.ids) + 1`.
// The shift guarantees no collision with left's wires regardless of
// the original id ranges. A smarter compact-renumbering pass is an
// optimisation a downstream `sturm-renumber` could apply if anyone
// wanted contiguous ids; for `sturm-tensor` itself, the simple offset
// is enough.
//
// Tensor is *total* — every pair of channels has a tensor product.
// There is no signature-mismatch failure mode; the output schema is
// just `channelSchema`.
//
// Classical refs are *not* renamed. If both sides independently bind
// the same ref name (e.g., both end with `observe(_, "r")`), the
// composite contains a duplicate `observe` for "r" — a well-formedness
// flaw that `checkWellFormed` catches on the composite. This is a
// known v0.1 limitation: a future iteration could add a classical-ref
// renaming pass either here or as a separate `sturm-rename-refs`
// tool. For now, the workaround is to keep ref names unique across
// channels you intend to tensor. Documented in the README.
//
// Input shape
// -----------
//   record { left: channel, right: channel }
//
// Output shape
// ------------
//   channel
//
// Algorithm
// ---------
// 1. Decode both sides. Compute `offset = max(left.ids) + 1`.
// 2. Walk right.body, right.inputs, right.outputs through `renameOp` /
//    `renameWire` with the constant-shift function.
// 3. Build the composite:
//      inputs  = left.inputs  ++ rename(right.inputs)
//      outputs = left.outputs ++ rename(right.outputs)
//      body    = left.body    ++ rename(right.body)
//
// Properties (machine-checked in `--test`):
//   - identity-left:  tensor(empty, c) byte-equals c (max(empty.ids) = -1
//     so offset = 0; right's ids unshifted)
//   - identity-right: tensor(c, empty) byte-equals c (right has no wires
//     to rename and contributes nothing)
//   - associativity:  tensor(tensor(a, b), c) byte-equals tensor(a, tensor(b, c))
//
// The latter two follow from the offset arithmetic — all three forms
// produce the wire-id range `a.ids ∪ (b.ids + max_a + 1) ∪ (c.ids +
// max_a + max_b + 2)` — and from the order-preserving body
// concatenation.

import {
  S,
  expr,
  int,
  list,
  rat,
  record,
  str,
  sym,
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

const NAME = "sturm-tensor";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Wire-id collection (used for offset computation)
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
// Renaming (constant-offset shift)
// -----------------------------------------------------------------------------

function renameOp(op: Op, shift: (id: bigint) => bigint): Op {
  switch (op.head) {
    case "prepare":
      return prepareOp(op.p, shift(op.wireId));
    case "ry":
      return ryOp(shift(op.wireId), op.delta, op.controls.map(shift));
    case "rz":
      return rzOp(shift(op.wireId), op.delta, op.controls.map(shift));
    case "observe":
      return observeOp(shift(op.wireId), op.classicalRef);
    case "discard":
      return discardOp(shift(op.wireId));
    case "oracle":
      // Embedded `circuit` Value has its own wire-id namespace and is
      // not renamed (its hash is its identity). Only the outer
      // wire-references that name wires in the enclosing channel
      // get rewritten.
      return oracleOp(
        op.circuit,
        op.inWires.map(shift),
        op.outWires.map(shift)
      );
    case "cases":
      return casesOp(
        op.classicalRef,
        op.trueArm.map((o) => renameOp(o, shift)),
        op.falseArm.map((o) => renameOp(o, shift))
      );
  }
}

function renameWire(w: Wire, shift: (id: bigint) => bigint): Wire {
  return w.dim === undefined
    ? wire(shift(w.id), w.kind)
    : wire(shift(w.id), w.kind, w.dim);
}

// -----------------------------------------------------------------------------
// Main entry
// -----------------------------------------------------------------------------

function tensorChannels(left: Channel, right: Channel): Channel {
  const offset = maxId(channelWireIds(left)) + 1n;
  const shift = (id: bigint) => id + offset;
  const renamedInputs = right.inputs.map((w) => renameWire(w, shift));
  const renamedOutputs = right.outputs.map((w) => renameWire(w, shift));
  const renamedBody = right.body.map((op) => renameOp(op, shift));
  return channel(
    [...left.inputs, ...renamedInputs],
    [...left.outputs, ...renamedOutputs],
    [...left.body, ...renamedBody]
  );
}

// -----------------------------------------------------------------------------
// Schema declarations
// -----------------------------------------------------------------------------
//
// Tensor is total — there is no signature-mismatch boundary failure
// mode. Output schema is just `channelSchema`.

const inputSchema: Schema<Value> = S.record({
  left: channelSchema,
  right: channelSchema,
});

const outputSchema: Schema<Value> = channelSchema;

// -----------------------------------------------------------------------------
// Example helpers
// -----------------------------------------------------------------------------

function inputRecord(left: Channel, right: Channel): Value {
  return record({ left: encodeChannel(left), right: encodeChannel(right) });
}

const Q = (id: bigint): Wire => wire(id, "quantum");
const PI = sym("π");
const piOver = (n: bigint): Value => expr("/", [PI, int(n)]);

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Sturm channel combinator: parallel composition (monoidal product); wire-id-renamed right concatenated onto left verbatim",
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "tensor of two empty channels — empty composite",
      input: inputRecord(channel([], [], []), channel([], [], [])),
      output: encodeChannel(channel([], [], [])),
    },
    {
      description: "identity-left: tensor(empty, c) = c (offset = 0, no shift)",
      input: inputRecord(
        channel([], [], []),
        channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])])
      ),
      output: encodeChannel(
        channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])])
      ),
    },
    {
      description: "identity-right: tensor(c, empty) = c (right has nothing to rename)",
      input: inputRecord(
        channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]),
        channel([], [], [])
      ),
      output: encodeChannel(
        channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])])
      ),
    },
    {
      description: "two single-wire channels merge with disjoint ids",
      input: inputRecord(
        channel([Q(0n)], [Q(0n)], [ryOp(0n, piOver(2n), [])]),
        channel([Q(0n)], [Q(0n)], [rzOp(0n, PI, [])])
      ),
      // left.maxId = 0; offset = 1. right's wire 0 -> 1.
      output: encodeChannel(
        channel(
          [Q(0n), Q(1n)],
          [Q(0n), Q(1n)],
          [ryOp(0n, piOver(2n), []), rzOp(1n, PI, [])]
        )
      ),
    },
    {
      description: "right channel with multiple wires shifts uniformly",
      input: inputRecord(
        channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]),
        channel(
          [Q(0n), Q(1n)],
          [Q(0n), Q(1n)],
          [ryOp(1n, piOver(2n), [0n])]
        )
      ),
      // offset = 1: right's 0->1, 1->2.
      output: encodeChannel(
        channel(
          [Q(0n), Q(1n), Q(2n)],
          [Q(0n), Q(1n), Q(2n)],
          [ryOp(0n, PI, []), ryOp(2n, piOver(2n), [1n])]
        )
      ),
    },
    {
      description: "left's max id determines offset, not just count",
      input: inputRecord(
        channel(
          [Q(7n)],
          [Q(7n)],
          [ryOp(7n, PI, [])]
        ),
        channel([Q(0n)], [Q(0n)], [rzOp(0n, PI, [])])
      ),
      // offset = 8: right's 0 -> 8.
      output: encodeChannel(
        channel(
          [Q(7n), Q(8n)],
          [Q(7n), Q(8n)],
          [ryOp(7n, PI, []), rzOp(8n, PI, [])]
        )
      ),
    },
    {
      description: "tensor preserves prepare ops on both sides",
      input: inputRecord(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel([], [Q(0n)], [prepareOp(rat(1n, 2n), 0n)])
      ),
      // offset = 1: right's 0 -> 1.
      output: encodeChannel(
        channel(
          [],
          [Q(0n), Q(1n)],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(1n, 2n), 1n),
          ]
        )
      ),
    },
    {
      description: "cases inside right's body gets renamed recursively",
      input: inputRecord(
        channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]),
        channel(
          [Q(0n)],
          [Q(0n)],
          [casesOp("r", [ryOp(0n, PI, [])], [rzOp(0n, piOver(2n), [])])]
        )
      ),
      // offset = 1: right's 0 -> 1; classical_ref unchanged.
      output: encodeChannel(
        channel(
          [Q(0n), Q(1n)],
          [Q(0n), Q(1n)],
          [
            ryOp(0n, PI, []),
            casesOp(
              "r",
              [ryOp(1n, PI, [])],
              [rzOp(1n, piOver(2n), [])]
            ),
          ]
        )
      ),
    },
    {
      description: "controls list gets shifted alongside target wireId",
      input: inputRecord(
        channel([Q(0n), Q(1n)], [Q(0n), Q(1n)], [ryOp(1n, PI, [0n])]),
        channel([Q(2n), Q(3n)], [Q(2n), Q(3n)], [ryOp(3n, PI, [2n])])
      ),
      // left.maxId = 1; offset = 2. right's 2 -> 4, 3 -> 5.
      output: encodeChannel(
        channel(
          [Q(0n), Q(1n), Q(4n), Q(5n)],
          [Q(0n), Q(1n), Q(4n), Q(5n)],
          [ryOp(1n, PI, [0n]), ryOp(5n, PI, [4n])]
        )
      ),
    },
    {
      description: "Bell-pair × independent-rotation: parallel composition",
      input: inputRecord(
        // left: Bell pair on wires 0, 1
        channel(
          [],
          [Q(0n), Q(1n)],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            ryOp(0n, piOver(2n), []),
            ryOp(1n, PI, [0n]),
          ]
        ),
        // right: a single rotation on its wire 0
        channel(
          [],
          [Q(0n)],
          [prepareOp(rat(0n, 1n), 0n), ryOp(0n, piOver(4n), [])]
        )
      ),
      // left.maxId = 1; offset = 2. right's 0 -> 2.
      output: encodeChannel(
        channel(
          [],
          [Q(0n), Q(1n), Q(2n)],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            ryOp(0n, piOver(2n), []),
            ryOp(1n, PI, [0n]),
            prepareOp(rat(0n, 1n), 2n),
            ryOp(2n, piOver(4n), []),
          ]
        )
      ),
    },
    {
      description: "tensor of empty + empty is byte-equal to empty",
      input: inputRecord(channel([], [], []), channel([], [], [])),
      output: encodeChannel(channel([], [], [])),
    },
    {
      description: "right's discard op gets shifted",
      input: inputRecord(
        channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
        channel([Q(0n)], [], [discardOp(0n)])
      ),
      // offset = 1: right's 0 -> 1.
      output: encodeChannel(
        channel(
          [Q(1n)],
          [Q(0n)],
          [prepareOp(rat(0n, 1n), 0n), discardOp(1n)]
        )
      ),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
    {
      name: "left-preserved-verbatim",
      statement:
        "left's wire ids and body are unchanged; the composite's first len(left.body) ops are byte-equal to left.body",
      machine_checkable: true,
    },
    {
      name: "right-shifted-by-offset",
      statement:
        "every wire id in right is shifted by max(left.ids)+1 (or 0 if left has no wires)",
      machine_checkable: true,
    },
    {
      name: "identity-left",
      statement: "tensor(empty, c) byte-equals c",
      machine_checkable: true,
    },
    {
      name: "identity-right",
      statement: "tensor(c, empty) byte-equals c",
      machine_checkable: true,
    },
    {
      name: "associativity",
      statement:
        "tensor(tensor(a, b), c) byte-equals tensor(a, tensor(b, c)) under the chosen rename discipline",
      machine_checkable: true,
    },
    {
      name: "totality",
      statement:
        "every pair of channels has a tensor product — no signature-mismatch boundary failure mode",
      machine_checkable: false,
    },
  ],
  fn: (input, _flags): Value => {
    if (input.kind !== "record") {
      throw new Error("sturm-tensor: internal: input not a record");
    }
    const l = input.fields.left;
    const r = input.fields.right;
    if (l === undefined || r === undefined) {
      throw new Error("sturm-tensor: internal: missing required fields");
    }
    const left = decodeChannel(l);
    const right = decodeChannel(r);
    return encodeChannel(tensorChannels(left, right));
  },
  test: () => {
    void list;
    void str;

    const empty = channel([], [], []);
    const c = channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]);
    const c2 = channel(
      [Q(0n), Q(1n)],
      [Q(0n), Q(1n)],
      [ryOp(0n, piOver(2n), []), rzOp(1n, PI, [0n])]
    );

    // Determinism.
    const a1 = encodeChannel(tensorChannels(c, c2));
    const a2 = encodeChannel(tensorChannels(c, c2));
    if (JSON.stringify(a1) !== JSON.stringify(a2)) {
      throw new Error("sturm-tensor test: not deterministic");
    }

    // Identity-left: tensor(empty, c) byte-equals c.
    const idLeft = encodeChannel(tensorChannels(empty, c));
    if (JSON.stringify(idLeft) !== JSON.stringify(encodeChannel(c))) {
      throw new Error("sturm-tensor test: identity-left failed");
    }

    // Identity-right: tensor(c, empty) byte-equals c.
    const idRight = encodeChannel(tensorChannels(c, empty));
    if (JSON.stringify(idRight) !== JSON.stringify(encodeChannel(c))) {
      throw new Error("sturm-tensor test: identity-right failed");
    }

    // Left-preserved-verbatim.
    const composite = tensorChannels(c, c2);
    if (composite.body.length < c.body.length) {
      throw new Error("sturm-tensor test: left body length not preserved");
    }
    for (let i = 0; i < c.body.length; i++) {
      const lhs = JSON.stringify(encodeOp(composite.body[i]!));
      const rhs = JSON.stringify(encodeOp(c.body[i]!));
      if (lhs !== rhs) {
        throw new Error(
          `sturm-tensor test: left body[${i}] not preserved verbatim`
        );
      }
    }

    // Associativity: tensor(tensor(a, b), c) byte-equals tensor(a, tensor(b, c)).
    const a = channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]);
    const b = channel([Q(0n), Q(1n)], [Q(0n), Q(1n)], [ryOp(1n, PI, [0n])]);
    const cc = channel([Q(0n)], [Q(0n)], [rzOp(0n, piOver(2n), [])]);
    const lhs = encodeChannel(tensorChannels(tensorChannels(a, b), cc));
    const rhs = encodeChannel(tensorChannels(a, tensorChannels(b, cc)));
    if (JSON.stringify(lhs) !== JSON.stringify(rhs)) {
      throw new Error(
        `sturm-tensor test: associativity failed.\nlhs=${JSON.stringify(lhs)}\nrhs=${JSON.stringify(rhs)}`
      );
    }
  },
});

if (import.meta.main) void runTool(def);
