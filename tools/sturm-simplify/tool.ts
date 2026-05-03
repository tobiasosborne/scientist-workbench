// =============================================================================
// sturm-simplify — IR canonicaliser for Sturm channels
// =============================================================================
//
// Intent
// ------
// `sturm-simplify` is to a Sturm channel what `cas-simplify` is to an
// algebraic Value: a deterministic, idempotent rewrite that produces
// the canonical form of an in-scope IR. It does not optimise gate
// counts in any clever way (that's `sturm-equivalent`'s job up to a
// matrix check, and a hypothetical `sturm-optimise`'s job for
// peephole transformations across non-commuting ops). It applies the
// minimal, locally-correct rewrites that every downstream tool wants
// to assume have already happened:
//
//   1. Angle-zero elimination. A `ry(α)` whose `α` simplifies (via
//      cas-simplify) to literal zero is the identity channel — drop
//      it. Same for `rz`.
//   2. Same-axis same-target same-controls merging. Two consecutive
//      `ry`s on the same wire with the same control set fuse to a
//      single `ry` whose angle is the sum (computed via cas-simplify
//      so symbolic π-rationals fold). If the sum is zero, both
//      ops vanish. `ry` and `rz` do *not* commute, so we never fuse
//      across axes.
//   3. Control-list canonicalisation. Controls are conceptually a
//      set, not a list — `controlled-ry by [1,2]` and `controlled-ry
//      by [2,1]` are the same operation. We sort controls in
//      ascending order and de-duplicate; this is what makes
//      same-controls comparison in step 2 a byte-equality test.
//   4. Cases-arm recursive simplification. Both arms of a `cases`
//      are themselves op-lists; we recurse. A `cases` whose arms
//      both simplify to empty is a no-op and is dropped.
//
// Out of scope, deliberately. We do *not*:
//
//   • Lower controls into Bennett-style decompositions. The IR
//     vocabulary is closed (P5); the controls field stays.
//   • Re-order non-commuting ops. ry and rz on the same wire don't
//     commute; commuting them changes the channel.
//   • Optimise across `cases` arms (e.g., factor a common prefix
//     out of both arms). That's a peephole pass for a different
//     tool.
//   • Touch the `circuit` payload of an `oracle` op. The embedded
//     channel is the responsibility of whoever produced it
//     (typically `sturm-bennett-oracle`); recursing into it would
//     conflate two different layers of canonicalisation. The hash
//     of an `oracle.circuit` is its identity; we preserve it
//     verbatim.
//   • Decide static `cases` collapse — the classical-ref binding is
//     dynamic, so we cannot statically resolve which arm fires.
//
// Input / Output shape
// --------------------
// Input and output are both `channelSchema` (ADR-0006). The runner
// validates the input shape before `fn` runs and the output shape
// after. The well-formedness check is *not* run by the tool — that
// is `checkWellFormed`'s job, and the v0.1 contract is "well-formed
// in ⇒ well-formed out, but the tool does not gate on it." A caller
// that wants well-formedness as a precondition should compose it
// before piping into sturm-simplify.
//
// Algorithm
// ---------
// One linear pass per nesting level:
//
//   1. Walk the body left-to-right. For each op:
//        a. Canonicalise control lists (sort + dedup).
//        b. For `ry`/`rz`: simplify the angle via cas-simplify;
//           if zero, drop the op.
//        c. For `cases`: recurse into each arm.
//        d. Otherwise: keep the op verbatim (with canonicalised
//           controls if applicable).
//   2. Adjacent-pair merging pass over the resulting list. If two
//      consecutive ops match on (head ∈ {ry, rz}, wireId, controls),
//      fuse their angles via cas-simplify. If the fused angle is
//      zero, both vanish.
//
// Idempotence: after step 2, every adjacent-pair check would either
// fail to match or produce a fused angle that's already simplified,
// and step 1's per-op simplifications are themselves idempotent
// (cas-simplify is idempotent). A second pass is therefore a no-op.
// Property tested.

import {
  canonicalize,
  expr,
  hash,
  int,
  list,
  parse,
  rat,
  S,
  sym,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import { casSimplify } from "@workbench/cas-core";
import {
  channel,
  channelSchema,
  decodeChannel,
  encodeChannel,
  observeOp,
  prepareOp,
  ryOp,
  rzOp,
  type CasesOp,
  type Channel,
  type Op,
} from "@workbench/sturm-ir";

const NAME = "sturm-simplify";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Local helpers
// -----------------------------------------------------------------------------

function isZeroValue(v: Value): boolean {
  // After cas-simplify, a literal zero comes out as either an integer
  // value of "0" or a rational with num === "0". We do not consider
  // float64 0 — exact zero is what we need for safe elimination, and
  // a numeric float64 angle that "looks zero" might be the result of
  // a tiny but non-zero accumulation we should not drop.
  if (v.kind === "integer" && v.value === "0") return true;
  if (v.kind === "rational" && v.num === "0") return true;
  return false;
}

function compareBigInts(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicaliseControls(controls: readonly bigint[]): readonly bigint[] {
  // Conceptually a set; canonical order is ascending. Skipping the
  // allocation when controls is already canonical keeps the hot path
  // (most ops have empty or single-element controls) trivial.
  if (controls.length <= 1) return controls;
  const dedup = new Set(controls);
  if (
    dedup.size === controls.length &&
    isAscendingStrict(controls)
  ) {
    return controls;
  }
  return [...dedup].sort(compareBigInts);
}

function isAscendingStrict(xs: readonly bigint[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i - 1]! >= xs[i]!) return false;
  }
  return true;
}

function controlsEqual(
  a: readonly bigint[],
  b: readonly bigint[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Simplify a single op (no merging). Returns null when the op
// canonicalises to identity and should be dropped.
function simplifyOp(op: Op): Op | null {
  switch (op.head) {
    case "ry":
    case "rz": {
      const delta = casSimplify(op.delta);
      if (isZeroValue(delta)) return null;
      const controls = canonicaliseControls(op.controls);
      return op.head === "ry"
        ? { head: "ry", wireId: op.wireId, delta, controls }
        : { head: "rz", wireId: op.wireId, delta, controls };
    }
    case "cases": {
      const trueArm = simplifyBody(op.trueArm);
      const falseArm = simplifyBody(op.falseArm);
      if (trueArm.length === 0 && falseArm.length === 0) return null;
      const out: CasesOp = {
        head: "cases",
        classicalRef: op.classicalRef,
        trueArm,
        falseArm,
      };
      return out;
    }
    case "oracle": {
      // Oracle's circuit is opaque to this tool (see header). We do
      // not recurse into it. Sort the in/out wire lists for canonical
      // form? They're positional for the oracle's semantics — sorting
      // would change which classical bit maps to which output. Leave
      // them as the producer set them.
      return op;
    }
    case "prepare":
    case "observe":
    case "discard":
      return op;
  }
}

function mergeAdjacent(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      (op.head === "ry" || op.head === "rz") &&
      last.head === op.head &&
      last.wireId === op.wireId &&
      controlsEqual(last.controls, op.controls)
    ) {
      const merged = casSimplify(expr("+", [last.delta, op.delta]));
      if (isZeroValue(merged)) {
        out.pop();
        continue;
      }
      const fused: Op =
        op.head === "ry"
          ? { head: "ry", wireId: op.wireId, delta: merged, controls: op.controls }
          : { head: "rz", wireId: op.wireId, delta: merged, controls: op.controls };
      out[out.length - 1] = fused;
      continue;
    }
    out.push(op);
  }
  return out;
}

function simplifyBody(ops: readonly Op[]): Op[] {
  const stage1: Op[] = [];
  for (const op of ops) {
    const r = simplifyOp(op);
    if (r === null) continue;
    stage1.push(r);
  }
  return mergeAdjacent(stage1);
}

function simplifyChannel(c: Channel): Channel {
  return channel(c.inputs, c.outputs, simplifyBody(c.body));
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: channelSchema,
    output: channelSchema,
  },
  examples: [
    {
      description: "empty channel passes through",
      input: encodeChannel(channel([], [], [])),
      output: encodeChannel(channel([], [], [])),
    },
    {
      description: "ry(0) eliminated",
      input: encodeChannel(
        channel(
          [],
          [],
          [prepareOp(rat(0n, 1n), 0n), ryOp(0n, int(0n), [])]
        )
      ),
      output: encodeChannel(
        channel([], [], [prepareOp(rat(0n, 1n), 0n)])
      ),
    },
    {
      description: "rz(0) eliminated",
      input: encodeChannel(
        channel(
          [],
          [],
          [prepareOp(rat(0n, 1n), 0n), rzOp(0n, int(0n), [])]
        )
      ),
      output: encodeChannel(
        channel([], [], [prepareOp(rat(0n, 1n), 0n)])
      ),
    },
    {
      description: "adjacent ry on same wire merges",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, sym("a"), []),
            ryOp(0n, sym("b"), []),
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, expr("+", [sym("a"), sym("b")]), []),
          ]
        )
      ),
    },
    {
      description: "ry α then ry -α cancels both",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, sym("a"), []),
            ryOp(0n, expr("-", [sym("a")]), []),
          ]
        )
      ),
      output: encodeChannel(
        channel([], [], [prepareOp(rat(0n, 1n), 0n)])
      ),
    },
    {
      description: "different axes do not merge (ry then rz)",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, sym("a"), []),
            rzOp(0n, sym("b"), []),
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, sym("a"), []),
            rzOp(0n, sym("b"), []),
          ]
        )
      ),
    },
    {
      description: "different controls do not merge",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            prepareOp(rat(0n, 1n), 2n),
            ryOp(2n, sym("a"), [0n]),
            ryOp(2n, sym("b"), [1n]),
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            prepareOp(rat(0n, 1n), 2n),
            ryOp(2n, sym("a"), [0n]),
            ryOp(2n, sym("b"), [1n]),
          ]
        )
      ),
    },
    {
      description: "controls are sorted and deduplicated",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            prepareOp(rat(0n, 1n), 2n),
            ryOp(2n, sym("a"), [1n, 0n, 1n]),
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            prepareOp(rat(0n, 1n), 2n),
            ryOp(2n, sym("a"), [0n, 1n]),
          ]
        )
      ),
    },
    {
      description: "Bell-pair channel passes through unchanged",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
            ryOp(1n, sym("π"), [0n]),
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
            ryOp(1n, sym("π"), [0n]),
          ]
        )
      ),
    },
    {
      description: "cases with both arms empty is dropped",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            observeOp(0n, "r"),
            { head: "cases", classicalRef: "r", trueArm: [], falseArm: [] },
          ]
        )
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
      description: "cases simplifies its arms recursively",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            observeOp(0n, "r"),
            {
              head: "cases",
              classicalRef: "r",
              trueArm: [
                ryOp(1n, sym("a"), []),
                ryOp(1n, sym("b"), []),
              ],
              falseArm: [ryOp(1n, int(0n), [])],
            },
          ]
        )
      ),
      output: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            observeOp(0n, "r"),
            {
              head: "cases",
              classicalRef: "r",
              trueArm: [ryOp(1n, expr("+", [sym("a"), sym("b")]), [])],
              falseArm: [],
            },
          ]
        )
      ),
    },
  ],
  invariants: [
    {
      name: "idempotent",
      statement: "simplify(simplify(c)) = simplify(c)",
      machine_checkable: true,
    },
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
    {
      name: "wire-and-classical-ref-preservation",
      statement:
        "simplify never renames wires, never invents or drops classical refs that an observe binds",
      machine_checkable: true,
    },
    {
      name: "no-cross-axis-fusion",
      statement: "consecutive ry then rz on the same wire are not fused",
      machine_checkable: true,
    },
    {
      name: "oracle-circuits-untouched",
      statement: "the embedded circuit Value of an oracle op is preserved verbatim",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    const c = decodeChannel(input);
    const simplified = simplifyChannel(c);
    return encodeChannel(simplified);
  },
  test: () => {
    void S;
    void list;
    // Idempotence + determinism on a small probe set covering each
    // rewrite branch. A failure here means the tool's contract has
    // drifted; goldens catch the per-input answer.
    const probes: Channel[] = [
      channel([], [], []),
      channel(
        [],
        [],
        [prepareOp(rat(0n, 1n), 0n), ryOp(0n, int(0n), [])]
      ),
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          ryOp(0n, sym("b"), []),
        ]
      ),
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          ryOp(0n, expr("-", [sym("a")]), []),
        ]
      ),
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
          ryOp(1n, sym("π"), [0n]),
        ]
      ),
    ];
    for (const c of probes) {
      const v = encodeChannel(c);
      const once = canonicalize(encodeChannel(simplifyChannel(decodeChannel(v))));
      const twice = canonicalize(
        encodeChannel(simplifyChannel(decodeChannel(parse(once))))
      );
      if (once !== twice) {
        throw new Error(`sturm-simplify not idempotent on ${canonicalize(v)}`);
      }
      const ha = hash(encodeChannel(simplifyChannel(decodeChannel(v))));
      const hb = hash(encodeChannel(simplifyChannel(decodeChannel(v))));
      if (ha !== hb) throw new Error(`sturm-simplify not deterministic`);
    }
  },
});

if (import.meta.main) void runTool(def);
