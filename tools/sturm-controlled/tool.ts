// =============================================================================
// sturm-controlled — quantum-control a Sturm channel by an external wire
// =============================================================================
//
// Intent
// ------
// `sturm-controlled` is the IR-level realisation of the v3 spec's §8.2
// `controlled(c, f)` combinator. Given a quantum control wire `c` and a
// channel `f`, it returns the channel `controlled(c, f)` whose semantics
// are: when `c` is `|1⟩`, the body of `f` fires; when `c` is `|0⟩`, the
// body is the identity. The lowering is mechanical: every `ry`/`rz`
// inside `f`'s body picks up `c` as an additional entry in its `controls`
// list. `cases` arms recurse — every rotation inside either arm gets the
// new control too.
//
// The closed IR vocabulary (ADR-0006) only admits `controls` on `ry` and
// `rz`. Prepare, observe, oracle, and discard have no `controls` field
// because coherent control on non-unitary channels is not well-defined
// (you can't quantum-control a wire allocation, a measurement, an
// information-loss step, or a reversible-circuit subroutine that has its
// own ancilla discipline). A channel whose body contains any of these
// ops is out-of-scope for `sturm-controlled`; we boundary-tag with
// `tagged "sturm-controlled/out-of-scope"` per ADR-0003 rather than
// inventing a coherent-control semantics for non-unitary ops.
//
// Wire-ID conflicts are also out-of-scope. The control wire is by
// definition external to the inner channel, so its ID must not collide
// with any wire ID the inner channel already references (in its input
// signature, its output signature, or anywhere in its body). When the
// caller wants to compose channels that internally use the same wire IDs,
// `sturm-tensor` is the right combinator — it does the rename-on-merge
// bookkeeping.
//
// Input shape
// -----------
//   record {
//     control_wire: integer,    // wire ID for the new quantum control
//     channel:      channel     // ADR-0006 IR channel to be controlled
//   }
//
// Output shape
// ------------
//   - happy path: an ADR-0006 channel whose input/output signatures have
//     been augmented with the control wire (added at index 0), and whose
//     body has every `ry`/`rz` (recursively, descending into `cases`
//     arms) updated to include the control wire in its `controls` list.
//   - out-of-scope: `tagged "sturm-controlled/out-of-scope" <reason>`
//     where the reason string explains either the wire-ID conflict or
//     the non-unitary op encountered.
//
// Algorithm
// ---------
// 1. Collect the set of wire IDs referenced anywhere in the input
//    channel — inputs, outputs, and every wireId / controls / cases-arm
//    descendant in the body. If `control_wire` is in that set, return a
//    wire-conflict tag.
// 2. Walk the body. For each op:
//      - `ry` / `rz`: copy with `control_wire` appended to the existing
//        controls list. (We append rather than prepend to make repeated
//        application produce the natural left-to-right history; the set
//        semantics of controls — sturm-simplify's job — make order
//        irrelevant downstream.)
//      - `cases`: recurse into both arms with the same control.
//      - `prepare` / `observe` / `oracle` / `discard`: throw a local
//        out-of-scope error (caught at the top level and turned into a
//        tagged reason).
// 3. Build the output channel: prepend the control wire (as a quantum
//    qubit-dim wire record) to the inputs and outputs, install the
//    rewritten body.
//
// We deliberately do *not* canonicalise the resulting `controls` lists
// (sort / deduplicate). That is `sturm-simplify`'s job. Keeping the two
// concerns separate means `controlled(c, controlled(c, f))` still
// composes mechanically — the second application appends `c` again,
// producing a body where each rotation has `c` listed twice. A downstream
// `sturm-simplify` pass deduplicates. If we collapsed here, we'd have a
// rewrite engine in two places.

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
  channel,
  channelSchema,
  decodeChannel,
  encodeChannel,
  prepareOp,
  ryOp,
  rzOp,
  observeOp,
  casesOp,
  discardOp,
  oracleOp,
  wire,
  type Channel,
  type Op,
  type Wire,
} from "@workbench/sturm-ir";

const NAME = "sturm-controlled";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Out-of-scope sentinel
// -----------------------------------------------------------------------------
//
// A local error class that the body throws on the two boundary
// conditions — wire-ID conflict and non-unitary op encountered. The
// top-level `fn` catches it and converts to the tagged Value. Throwing
// is cleaner than threading a Result type through the tree-walker.

class OutOfScope extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "OutOfScope";
  }
}

// -----------------------------------------------------------------------------
// Wire-ID collection
// -----------------------------------------------------------------------------

function addWiresFromOp(op: Op, ids: Set<bigint>): void {
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
      for (const o of op.trueArm) addWiresFromOp(o, ids);
      for (const o of op.falseArm) addWiresFromOp(o, ids);
      return;
  }
}

function allWireIds(c: Channel): Set<bigint> {
  const ids = new Set<bigint>();
  for (const w of c.inputs) ids.add(w.id);
  for (const w of c.outputs) ids.add(w.id);
  for (const op of c.body) addWiresFromOp(op, ids);
  return ids;
}

// -----------------------------------------------------------------------------
// Body rewrite — append control to every ry/rz, recurse into cases arms
// -----------------------------------------------------------------------------

function applyControlToOp(op: Op, controlId: bigint): Op {
  switch (op.head) {
    case "ry":
      return ryOp(op.wireId, op.delta, [...op.controls, controlId]);
    case "rz":
      return rzOp(op.wireId, op.delta, [...op.controls, controlId]);
    case "cases":
      return casesOp(
        op.classicalRef,
        op.trueArm.map((o) => applyControlToOp(o, controlId)),
        op.falseArm.map((o) => applyControlToOp(o, controlId))
      );
    case "prepare":
      throw new OutOfScope(
        "channel body contains prepare op — coherent control of allocation is not supported"
      );
    case "observe":
      throw new OutOfScope(
        "channel body contains observe op — coherent control of measurement is not supported"
      );
    case "discard":
      throw new OutOfScope(
        "channel body contains discard op — coherent control of partial trace is not supported"
      );
    case "oracle":
      throw new OutOfScope(
        "channel body contains oracle op — coherent control of an embedded reversible circuit requires lifting controls into the circuit, which is out-of-scope for v0.1"
      );
  }
}

// -----------------------------------------------------------------------------
// Main entry — full transform
// -----------------------------------------------------------------------------

function controlChannel(c: Channel, controlId: bigint): Channel {
  const used = allWireIds(c);
  if (used.has(controlId)) {
    throw new OutOfScope(
      `control_wire ${controlId} conflicts with a wire id already used by the inner channel`
    );
  }
  const ctrlWire: Wire = wire(controlId, "quantum");
  const newBody = c.body.map((op) => applyControlToOp(op, controlId));
  return channel(
    [ctrlWire, ...c.inputs],
    [ctrlWire, ...c.outputs],
    newBody
  );
}

// -----------------------------------------------------------------------------
// Schema declarations
// -----------------------------------------------------------------------------
//
// Output is a union of the channel-on-success shape and the
// boundary-tag-on-failure shape. The runner first-match-wins among
// alternatives; channel is listed first because it's the happy path.

const inputSchema: Schema<Value> = S.record({
  control_wire: S.kind("integer"),
  channel: channelSchema,
});

const outputSchema: Schema<Value> = S.union([
  channelSchema,
  S.tagged("sturm-controlled/out-of-scope", S.kind("string")),
]);

// -----------------------------------------------------------------------------
// Example helpers
// -----------------------------------------------------------------------------
//
// Examples build canonical input records out of channel-Value pieces. The
// helpers below keep the example block legible.

function inputRecord(controlId: bigint, c: Channel): Value {
  return record({
    control_wire: int(controlId),
    channel: encodeChannel(c),
  });
}

function piOver(n: bigint): Value {
  return expr("/", [sym("π"), int(n)]);
}

const PI = sym("π");

// Reusable wire builders for examples.
const Q = (id: bigint): Wire => wire(id, "quantum");

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Sturm channel combinator: prepends a control wire to every `ry`/`rz` in the body; refuses on `prepare`/`observe`/`oracle`/`discard` or wire-id collision",
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "control an empty channel — output has only the control wire",
      input: inputRecord(0n, channel([], [], [])),
      output: encodeChannel(channel([Q(0n)], [Q(0n)], [])),
    },
    {
      description: "control a single ry — control appended to the rotation's controls",
      input: inputRecord(
        9n,
        channel([Q(1n)], [Q(1n)], [ryOp(1n, PI, [])])
      ),
      output: encodeChannel(
        channel([Q(9n), Q(1n)], [Q(9n), Q(1n)], [ryOp(1n, PI, [9n])])
      ),
    },
    {
      description: "control a single rz",
      input: inputRecord(
        9n,
        channel([Q(1n)], [Q(1n)], [rzOp(1n, piOver(2n), [])])
      ),
      output: encodeChannel(
        channel([Q(9n), Q(1n)], [Q(9n), Q(1n)], [rzOp(1n, piOver(2n), [9n])])
      ),
    },
    {
      description: "control a ry + rz pair on same wire — both pick up the control",
      input: inputRecord(
        9n,
        channel(
          [Q(1n)],
          [Q(1n)],
          [ryOp(1n, piOver(2n), []), rzOp(1n, PI, [])]
        )
      ),
      output: encodeChannel(
        channel(
          [Q(9n), Q(1n)],
          [Q(9n), Q(1n)],
          [ryOp(1n, piOver(2n), [9n]), rzOp(1n, PI, [9n])]
        )
      ),
    },
    {
      description: "control a ry that already has a control — new control appended",
      input: inputRecord(
        9n,
        channel(
          [Q(1n), Q(2n)],
          [Q(1n), Q(2n)],
          [ryOp(2n, PI, [1n])]
        )
      ),
      output: encodeChannel(
        channel(
          [Q(9n), Q(1n), Q(2n)],
          [Q(9n), Q(1n), Q(2n)],
          [ryOp(2n, PI, [1n, 9n])]
        )
      ),
    },
    {
      description: "control a ry on multi-wire body — every rotation picks up the control",
      input: inputRecord(
        9n,
        channel(
          [Q(1n), Q(2n)],
          [Q(1n), Q(2n)],
          [
            ryOp(1n, piOver(2n), []),
            ryOp(2n, piOver(4n), []),
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [Q(9n), Q(1n), Q(2n)],
          [Q(9n), Q(1n), Q(2n)],
          [
            ryOp(1n, piOver(2n), [9n]),
            ryOp(2n, piOver(4n), [9n]),
          ]
        )
      ),
    },
    {
      description: "control descends into cases arms",
      input: inputRecord(
        9n,
        channel(
          [Q(1n), Q(2n)],
          [Q(1n), Q(2n)],
          [
            casesOp(
              "r",
              [ryOp(2n, PI, [])],
              [rzOp(2n, piOver(2n), [])]
            ),
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [Q(9n), Q(1n), Q(2n)],
          [Q(9n), Q(1n), Q(2n)],
          [
            casesOp(
              "r",
              [ryOp(2n, PI, [9n])],
              [rzOp(2n, piOver(2n), [9n])]
            ),
          ]
        )
      ),
    },
    {
      description: "out-of-scope: control wire conflicts with an inner wire",
      input: inputRecord(
        1n,
        channel([Q(1n)], [Q(1n)], [ryOp(1n, PI, [])])
      ),
      output: tagged(
        "sturm-controlled/out-of-scope",
        str(
          "control_wire 1 conflicts with a wire id already used by the inner channel"
        )
      ),
    },
    {
      description: "out-of-scope: prepare in body cannot be coherently controlled",
      input: inputRecord(
        9n,
        channel([], [Q(1n)], [prepareOp(rat(0n, 1n), 1n)])
      ),
      output: tagged(
        "sturm-controlled/out-of-scope",
        str(
          "channel body contains prepare op — coherent control of allocation is not supported"
        )
      ),
    },
    {
      description: "out-of-scope: observe in body cannot be coherently controlled",
      input: inputRecord(
        9n,
        channel([Q(1n)], [], [observeOp(1n, "r")])
      ),
      output: tagged(
        "sturm-controlled/out-of-scope",
        str(
          "channel body contains observe op — coherent control of measurement is not supported"
        )
      ),
    },
    {
      description: "out-of-scope: discard in body cannot be coherently controlled",
      input: inputRecord(
        9n,
        channel([Q(1n)], [], [discardOp(1n)])
      ),
      output: tagged(
        "sturm-controlled/out-of-scope",
        str(
          "channel body contains discard op — coherent control of partial trace is not supported"
        )
      ),
    },
    {
      description: "out-of-scope: oracle in body — controlled-oracle requires lifting into the embedded circuit",
      input: inputRecord(
        9n,
        channel(
          [Q(1n)],
          [Q(1n)],
          [oracleOp(encodeChannel(channel([], [], [])), [1n], [1n])]
        )
      ),
      output: tagged(
        "sturm-controlled/out-of-scope",
        str(
          "channel body contains oracle op — coherent control of an embedded reversible circuit requires lifting controls into the circuit, which is out-of-scope for v0.1"
        )
      ),
    },
    {
      description: "out-of-scope: cases-arm contains a non-unitary op (observe)",
      input: inputRecord(
        9n,
        channel(
          [Q(1n), Q(2n)],
          [Q(1n), Q(2n)],
          [
            casesOp(
              "r",
              [observeOp(2n, "s")],
              []
            ),
          ]
        )
      ),
      output: tagged(
        "sturm-controlled/out-of-scope",
        str(
          "channel body contains observe op — coherent control of measurement is not supported"
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
      name: "control-stamping",
      statement:
        "every ry/rz in the body — recursively through cases arms — has control_wire appended to its controls list (and no rotation in the output is missing it)",
      machine_checkable: true,
    },
    {
      name: "non-unitary-rejected",
      statement:
        "any prepare/observe/oracle/discard in the body produces tagged 'sturm-controlled/out-of-scope'",
      machine_checkable: true,
    },
    {
      name: "wire-conflict-rejected",
      statement:
        "control_wire colliding with any wire id used by the inner channel produces tagged 'sturm-controlled/out-of-scope'",
      machine_checkable: true,
    },
    {
      name: "signature-augmented",
      statement:
        "on success the output channel's inputs and outputs each begin with the control wire followed by the inner channel's signature, in order",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    if (input.kind !== "record") {
      // Schema validation makes this unreachable, but TS doesn't know.
      throw new Error("sturm-controlled: internal: input not a record");
    }
    const ctrl = input.fields.control_wire;
    const ch = input.fields.channel;
    if (ctrl === undefined || ch === undefined) {
      throw new Error("sturm-controlled: internal: missing required fields");
    }
    if (ctrl.kind !== "integer") {
      throw new Error("sturm-controlled: internal: control_wire not integer");
    }
    const controlId = BigInt(ctrl.value);
    const channelTyped = decodeChannel(ch);
    try {
      return encodeChannel(controlChannel(channelTyped, controlId));
    } catch (e) {
      if (e instanceof OutOfScope) {
        return tagged("sturm-controlled/out-of-scope", str(e.reason));
      }
      throw e;
    }
  },
  test: () => {
    void list;
    // Deterministic + control-stamping + rejection on a small probe set.
    // Build IR by hand (no encode/decode round-trip needed since the
    // probes are TS-side; encode at the boundary).
    const probe1 = channel(
      [Q(1n)],
      [Q(1n)],
      [ryOp(1n, PI, []), rzOp(1n, piOver(2n), [])]
    );
    const out1 = controlChannel(probe1, 9n);
    // Every rotation should mention 9n in its controls.
    for (const op of out1.body) {
      if (op.head !== "ry" && op.head !== "rz") {
        throw new Error("sturm-controlled test: probe1 produced non-rotation op");
      }
      if (!op.controls.includes(9n)) {
        throw new Error(
          "sturm-controlled test: probe1 op missing the new control wire"
        );
      }
    }
    // Determinism: same input twice → same output bytes.
    const a = encodeChannel(controlChannel(probe1, 9n));
    const b = encodeChannel(controlChannel(probe1, 9n));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error("sturm-controlled test: not deterministic on probe1");
    }
    // Wire conflict probe.
    let wireConflictHit = false;
    try {
      controlChannel(probe1, 1n);
    } catch (e) {
      if (e instanceof OutOfScope) wireConflictHit = true;
    }
    if (!wireConflictHit) {
      throw new Error("sturm-controlled test: wire conflict not rejected");
    }
    // Non-unitary rejection probe (observe).
    const probe2 = channel([Q(1n)], [], [observeOp(1n, "r")]);
    let nonUnitaryHit = false;
    try {
      controlChannel(probe2, 9n);
    } catch (e) {
      if (e instanceof OutOfScope) nonUnitaryHit = true;
    }
    if (!nonUnitaryHit) {
      throw new Error("sturm-controlled test: non-unitary op not rejected");
    }
    // Cases recursion probe — non-unitary inside an arm should also reject.
    const probe3 = channel(
      [Q(1n), Q(2n)],
      [Q(1n), Q(2n)],
      [casesOp("r", [observeOp(2n, "s")], [])]
    );
    let nestedRejectHit = false;
    try {
      controlChannel(probe3, 9n);
    } catch (e) {
      if (e instanceof OutOfScope) nestedRejectHit = true;
    }
    if (!nestedRejectHit) {
      throw new Error(
        "sturm-controlled test: non-unitary op inside cases-arm not rejected"
      );
    }
    // Signature augmentation probe.
    if (
      out1.inputs.length !== probe1.inputs.length + 1 ||
      out1.inputs[0]!.id !== 9n
    ) {
      throw new Error(
        "sturm-controlled test: control wire not prepended to inputs"
      );
    }
    if (
      out1.outputs.length !== probe1.outputs.length + 1 ||
      out1.outputs[0]!.id !== 9n
    ) {
      throw new Error(
        "sturm-controlled test: control wire not prepended to outputs"
      );
    }
  },
});

if (import.meta.main) void runTool(def);
