// =============================================================================
// sturm-equivalent — decide equivalence of two Sturm channels
// =============================================================================
//
// Intent
// ------
// `sturm-equivalent` answers "do these two channels denote the same arrow in
// CPTP?" — given a `record { lhs, rhs }` of two Sturm channel IRs (ADR-0006).
// It mirrors the shape of `cas-verify` (record-with-flag, ADR-0003): the
// output is a `record { equal, reason?, witness?, detail? }` carrying a
// boolean verdict and, on inequality or boundary, an explanation.
//
// In v0.1 the tool is a *necessary* but not always *sufficient* equivalence
// checker. It composes two existing tools:
//
//   1. `sturm-simplify` is run on each side to put both into canonical form
//      (eliminates `ry(0)`/`rz(0)`, fuses same-axis adjacent rotations,
//      sorts/dedupes controls). Two circuits whose only difference is
//      simplifiable bookkeeping become byte-equal at this point.
//   2. If the canonical bytes match → `equal=true reason="syntactic"`.
//   3. Else `sturm-execute` is run on each side to compute the post-circuit
//      distribution (on the implicit `|0…0⟩` initial state). The two
//      distributions are compared:
//        - same set of classical_refs and same probabilities (within
//          1e-9 tolerance) → `equal=false reason="out-of-scope"
//          detail="distribution-match-but-not-syntactic"`. Distribution
//          equality is *necessary* but not *sufficient* for unitary
//          equivalence (different unitaries can produce the same |0⟩^n
//          measurement distribution; consider RY(π) vs an X gate plus a
//          dead-letter arm). The honest answer is "I can't decide."
//        - different classical_refs or differing probabilities →
//          `equal=false reason="not-equivalent" witness=<record>`. The
//          witness names a classical-resolution key whose probability
//          disagrees, with both sides' values.
//        - either side returns `tagged "sturm-execute/out-of-scope"` →
//          `equal=false reason="out-of-scope" detail=<the tool's
//          reason>`. The simulator could not handle one side of the
//          comparison.
//
// What's deliberately not done in v0.1
// ------------------------------------
// Matrix equivalence over Q[√2, i] (or any algebraic-number ring) is the
// natural payoff for the "Clifford+T circuit equivalence" framing in the
// issue body, and the strongest equivalence check available short of a
// full unitary matrix comparison. It is deferred along with the rest of
// the exact-symbolic path (scientist-workbench-jfj). Once that lands, the
// "out-of-scope: distribution-match-but-not-syntactic" branch can be
// upgraded to a sound matrix-equivalence verdict for the in-scope
// fragment.
//
// Equivalence-up-to-global-phase is also not separately handled — the
// distribution check is *insensitive* to global phase (Born's rule
// quotients it out), so circuits differing only by global phase produce
// identical distributions and end up in the "out-of-scope-by-distribution-
// match" branch. That's the right answer for v0.1: we can't certify
// equivalence, and we can't soundly deny it either.
//
// Input shape
// -----------
// `record { lhs, rhs }` where each field is a Sturm channel `expression`
// (channelSchema). The two channels do *not* need to share the same wire
// IDs in a meaningful way; this tool compares observable behaviour, which
// is invariant under wire-ID renaming.
//
// Output shape
// ------------
// `record { equal: boolean, reason?, witness?, detail? }`:
//   - `equal: true` (with no other fields) when the two simplified IRs are
//     byte-equal.
//   - `equal: false, reason: "not-equivalent", witness: <record>` when the
//     two distributions differ on at least one outcome. Witness shape:
//       {
//         classical_resolutions: <list of {ref, value} pairs>,
//         lhs_prob: <float64>,  // either side's prob may be 0 (outcome
//         rhs_prob: <float64>,  //   absent on that side).
//       }
//     The first differing outcome (in canonical resolution-key order) is
//     emitted; in principle a complete witness could enumerate every
//     differing outcome but the first is enough to refute equivalence.
//   - `equal: false, reason: "out-of-scope", detail: <string>` when the
//     equivalence can't be decided. Three sub-cases:
//       - one or both sides are out-of-scope for `sturm-execute` (e.g.
//         contain `oracle` or `discard`). `detail` echoes the underlying
//         reason.
//       - the two distributions match but the simplified bytes differ.
//         `detail = "distribution-match-but-not-syntactic"`.
//       - the two distributions have different classical_ref sets.
//         `detail = "different-classical_refs"`. (This is in fact a
//         soundly-not-equal case — the type signatures differ — but
//         "out-of-scope" is the most conservative phrasing while we
//         haven't pinned down whether structurally-different output
//         types qualify as "not equivalent." Folded into out-of-scope
//         for honesty.)
//
// Implementation note: tools depending on tools
// ---------------------------------------------
// This tool spawns `sturm-simplify` and `sturm-execute` as subprocesses
// via `spawnBun`. Tool-on-tool composition is unusual in the workbench —
// most tools depend on `packages/`. We do it here because:
//   (a) extracting `simplifyChannel` / `executeChannel` into a shared
//       library would be a bigger refactor than the tool warrants for
//       v0.1, and would push the rewrites/simulation logic into either
//       `packages/sturm-ir` (whose stated scope is "pure data + structural
//       checks") or a new package (bureaucratic);
//   (b) subprocess composition keeps `sturm-equivalent` in lockstep with
//       its dependencies by construction — if `sturm-simplify` learns a
//       new rewrite, `sturm-equivalent`'s syntactic check picks it up
//       without changes.
// The cost is ~200 ms latency per invocation (4 subprocess spawns in the
// worst case: simplify×2 + execute×2). Acceptable for v0.1; if it becomes
// a bottleneck, the right move is the shared-library refactor.

import {
  bool,
  canonicalize,
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  parse,
  rat,
  record,
  S,
  str,
  sym,
  tagged,
  type Schema,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool, spawnBun } from "@workbench/contract";
import { channel, channelSchema, encodeChannel, observeOp, prepareOp, ryOp, rzOp, wire, type Channel } from "@workbench/sturm-ir";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "sturm-equivalent";
const VERSION = "0.1.0";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const STURM_SIMPLIFY = join(ROOT, "tools", "sturm-simplify", "tool.ts");
const STURM_EXECUTE = join(ROOT, "tools", "sturm-execute", "tool.ts");

// -----------------------------------------------------------------------------
// Probability comparison
// -----------------------------------------------------------------------------
//
// `PROB_TOLERANCE` is the float64 tolerance for "two probabilities are
// equal." Slightly wider than `sturm-execute`'s 1e-12 floor because we're
// comparing across two independent simulations whose IEEE-754 paths can
// diverge by a few ulps. 1e-9 is much smaller than any meaningful
// probability difference and large enough to absorb the cumulative
// rounding.
const PROB_TOLERANCE = 1e-9;

function probsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= PROB_TOLERANCE;
}

// -----------------------------------------------------------------------------
// Subprocess helpers
// -----------------------------------------------------------------------------
//
// `runSubtool(toolPath, inputBytes)` spawns a workbench tool with the given
// canonical input and returns the parsed output Value, or throws on
// non-zero exit. The standard error output is captured and propagated in
// the thrown error message — useful for debugging when the subtool fails
// validation.

async function runSubtool(toolPath: string, inputBytes: string): Promise<Value> {
  const r = await spawnBun([toolPath], inputBytes);
  if (r.code !== 0) {
    throw new Error(
      `${toolPath} failed with code ${r.code}: ${r.stderr.trim() || r.stdout.slice(0, 200)}`
    );
  }
  return parse(r.stdout);
}

// -----------------------------------------------------------------------------
// Distribution shape — read-only access to sturm-execute outputs
// -----------------------------------------------------------------------------
//
// We don't statically import sturm-execute's output schema (cross-tool
// schema-sharing isn't yet wired up); instead we walk the parsed Value at
// runtime. This is fragile if the output shape evolves, but the schema is
// pinned in ADR-0007 + the worklog shard and changes there are
// coordinated. The runtime check throws loudly on shape drift.

interface ParsedDistribution {
  precision: string;
  classicalRefs: string[];
  outcomes: ParsedOutcome[];
}

interface ParsedOutcome {
  resolutions: Map<string, 0 | 1>;
  prob: number;
}

function parseDistribution(v: Value): ParsedDistribution | { tagged: string } {
  if (v.kind === "tagged" && v.tag === "sturm-execute/out-of-scope") {
    return { tagged: v.payload.kind === "string" ? v.payload.value : v.tag };
  }
  if (v.kind !== "record") {
    throw new Error(
      `expected record from sturm-execute, got kind ${v.kind}`
    );
  }
  const refsList = v.fields["classical_refs"];
  if (refsList === undefined || refsList.kind !== "list") {
    throw new Error("sturm-execute output missing classical_refs list");
  }
  const refs = refsList.items.map((item, i) => {
    if (item.kind !== "string") {
      throw new Error(`classical_refs[${i}] not a string`);
    }
    return item.value;
  });
  const precisionVal = v.fields["precision"];
  if (precisionVal === undefined || precisionVal.kind !== "string") {
    throw new Error("sturm-execute output missing precision string");
  }
  const outcomesList = v.fields["outcomes"];
  if (outcomesList === undefined || outcomesList.kind !== "list") {
    throw new Error("sturm-execute output missing outcomes list");
  }
  const outcomes: ParsedOutcome[] = [];
  for (let i = 0; i < outcomesList.items.length; i++) {
    const o = outcomesList.items[i]!;
    if (o.kind !== "record") {
      throw new Error(`outcome ${i} not a record`);
    }
    const resolutionsField = o.fields["classical_resolutions"];
    if (resolutionsField === undefined || resolutionsField.kind !== "list") {
      throw new Error(`outcome ${i} missing classical_resolutions list`);
    }
    const res: Map<string, 0 | 1> = new Map();
    for (let j = 0; j < resolutionsField.items.length; j++) {
      const pairVal = resolutionsField.items[j]!;
      if (pairVal.kind !== "record") {
        throw new Error(`outcome ${i}.resolutions[${j}] not a record`);
      }
      const refVal = pairVal.fields["ref"];
      const valueVal = pairVal.fields["value"];
      if (refVal === undefined || refVal.kind !== "string") {
        throw new Error(`outcome ${i}.resolutions[${j}].ref not a string`);
      }
      if (valueVal === undefined || valueVal.kind !== "integer") {
        throw new Error(`outcome ${i}.resolutions[${j}].value not an integer`);
      }
      const v01 = valueVal.value;
      if (v01 !== "0" && v01 !== "1") {
        throw new Error(
          `outcome ${i}.resolutions[${j}].value must be 0 or 1, got ${v01}`
        );
      }
      res.set(refVal.value, v01 === "0" ? 0 : 1);
    }
    const probField = o.fields["prob"];
    if (probField === undefined) {
      throw new Error(`outcome ${i} missing prob`);
    }
    let prob: number;
    if (probField.kind === "float64") {
      prob = float64ToNumber(probField);
    } else if (probField.kind === "rational") {
      prob = Number(BigInt(probField.num)) / Number(BigInt(probField.den));
    } else {
      throw new Error(
        `outcome ${i}.prob must be float64 or rational, got ${probField.kind}`
      );
    }
    outcomes.push({ resolutions: res, prob });
  }
  return { precision: precisionVal.value, classicalRefs: refs, outcomes };
}

// -----------------------------------------------------------------------------
// Distribution comparison
// -----------------------------------------------------------------------------
//
// Compare two parsed distributions. Returns either { match: true } or
// { match: false, witness: <record> } where the witness is the first
// resolution-key whose probabilities differ.
//
// Resolution-key ordering matches `sturm-execute`'s canonical output:
// outcomes are emitted sorted by the bit-string formed from the refs in
// classical_refs declaration order. Walking both lists in that order and
// merging by key gives a stable comparison.

function resolutionKey(
  refs: readonly string[],
  res: ReadonlyMap<string, 0 | 1>
): string {
  let s = "";
  for (const r of refs) {
    const v = res.get(r);
    s += v === undefined ? "?" : String(v);
  }
  return s;
}

interface DistributionMismatch {
  resolutions: ReadonlyMap<string, 0 | 1>;
  lhs_prob: number;
  rhs_prob: number;
}

function compareDistributions(
  lhs: ParsedDistribution,
  rhs: ParsedDistribution
):
  | { match: true }
  | { match: false; mismatch: DistributionMismatch }
  | { match: false; differentRefs: true } {
  // Same classical_refs set (unordered comparison; order is canonical
  // declaration-order on each side, which may legitimately differ
  // between two structurally-different circuits that share an ABI).
  if (lhs.classicalRefs.length !== rhs.classicalRefs.length) {
    return { match: false, differentRefs: true };
  }
  const lhsSet = new Set(lhs.classicalRefs);
  for (const r of rhs.classicalRefs) {
    if (!lhsSet.has(r)) return { match: false, differentRefs: true };
  }
  // Build maps from resolution-key to (resolutions, prob). Use lhs's
  // ref-order as the canonical key order.
  const refs = lhs.classicalRefs;
  const lhsByKey = new Map<string, ParsedOutcome>();
  for (const o of lhs.outcomes) {
    lhsByKey.set(resolutionKey(refs, o.resolutions), o);
  }
  const rhsByKey = new Map<string, ParsedOutcome>();
  for (const o of rhs.outcomes) {
    rhsByKey.set(resolutionKey(refs, o.resolutions), o);
  }
  // For every key in either side, compare. If only present on one side,
  // the other side has implicit prob 0 — a difference iff the present
  // prob is non-zero (above tolerance).
  const allKeys = new Set([...lhsByKey.keys(), ...rhsByKey.keys()]);
  // Stable iteration: sort the keys.
  const sortedKeys = [...allKeys].sort();
  for (const k of sortedKeys) {
    const lo = lhsByKey.get(k);
    const ro = rhsByKey.get(k);
    const lp = lo?.prob ?? 0;
    const rp = ro?.prob ?? 0;
    if (!probsEqual(lp, rp)) {
      // Use whichever side has the resolutions; both should agree.
      const resolutions = lo?.resolutions ?? ro?.resolutions;
      if (resolutions === undefined) {
        // Should not happen — at least one side has the key.
        continue;
      }
      return {
        match: false,
        mismatch: { resolutions, lhs_prob: lp, rhs_prob: rp },
      };
    }
  }
  return { match: true };
}

// -----------------------------------------------------------------------------
// Witness encoding
// -----------------------------------------------------------------------------

function encodeMismatchWitness(m: DistributionMismatch): Value {
  const resolutions: Value[] = [];
  const refs = [...m.resolutions.keys()].sort();
  for (const r of refs) {
    resolutions.push(
      record({
        ref: str(r),
        value: int(BigInt(m.resolutions.get(r)!)),
      })
    );
  }
  return record({
    classical_resolutions: list(resolutions),
    lhs_prob: float64FromNumber(m.lhs_prob),
    rhs_prob: float64FromNumber(m.rhs_prob),
  });
}

// -----------------------------------------------------------------------------
// Top-level decide
// -----------------------------------------------------------------------------
//
// The orchestrator: simplify both sides; check byte-equality; on
// mismatch, run sturm-execute on each side and compare distributions.
// All boundary failures funnel through the record-with-flag pattern from
// ADR-0003.

async function decideEquivalent(
  lhs: Value,
  rhs: Value
): Promise<Value> {
  // Step 1: simplify both sides.
  let lhsSimplifiedBytes: string;
  let rhsSimplifiedBytes: string;
  try {
    const lhsSimplified = await runSubtool(STURM_SIMPLIFY, canonicalize(lhs));
    const rhsSimplified = await runSubtool(STURM_SIMPLIFY, canonicalize(rhs));
    lhsSimplifiedBytes = canonicalize(lhsSimplified);
    rhsSimplifiedBytes = canonicalize(rhsSimplified);
  } catch (e) {
    return record({
      detail: str(`sturm-simplify failure: ${(e as Error).message}`),
      equal: bool(false),
      reason: str("out-of-scope"),
    });
  }
  // Step 2: byte-equal on simplified IRs.
  if (lhsSimplifiedBytes === rhsSimplifiedBytes) {
    return record({ equal: bool(true) });
  }
  // Step 3: simulate both. Run sequentially so failure on the first is
  // surfaced before the second spends 50ms on a circuit we won't use.
  let lhsDist: ParsedDistribution | { tagged: string };
  let rhsDist: ParsedDistribution | { tagged: string };
  try {
    lhsDist = parseDistribution(
      await runSubtool(STURM_EXECUTE, lhsSimplifiedBytes)
    );
    rhsDist = parseDistribution(
      await runSubtool(STURM_EXECUTE, rhsSimplifiedBytes)
    );
  } catch (e) {
    return record({
      detail: str(`sturm-execute failure: ${(e as Error).message}`),
      equal: bool(false),
      reason: str("out-of-scope"),
    });
  }
  if ("tagged" in lhsDist) {
    return record({
      detail: str(`lhs out-of-scope: ${lhsDist.tagged}`),
      equal: bool(false),
      reason: str("out-of-scope"),
    });
  }
  if ("tagged" in rhsDist) {
    return record({
      detail: str(`rhs out-of-scope: ${rhsDist.tagged}`),
      equal: bool(false),
      reason: str("out-of-scope"),
    });
  }
  // Step 4: compare distributions.
  const cmp = compareDistributions(lhsDist, rhsDist);
  if (cmp.match) {
    // Distributions match but simplified bytes differ — this is the
    // "necessary but not sufficient" branch. Honest answer: we can't
    // decide. The future exact-symbolic path (jfj) plus a matrix-
    // equivalence check would resolve this branch.
    return record({
      detail: str("distribution-match-but-not-syntactic"),
      equal: bool(false),
      reason: str("out-of-scope"),
    });
  }
  if ("differentRefs" in cmp) {
    return record({
      detail: str("different-classical_refs"),
      equal: bool(false),
      reason: str("out-of-scope"),
    });
  }
  // Distributions disagree on at least one outcome.
  return record({
    equal: bool(false),
    reason: str("not-equivalent"),
    witness: encodeMismatchWitness(cmp.mismatch),
  });
}

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  lhs: channelSchema,
  rhs: channelSchema,
});

const outputSchema: Schema<Value> = S.record(
  {
    equal: S.kind("boolean"),
    reason: S.union([
      S.literal(str("not-equivalent")),
      S.literal(str("out-of-scope")),
    ]),
    witness: S.any(),
    detail: S.kind("string"),
  },
  { optional: ["reason", "witness", "detail"] }
);

// -----------------------------------------------------------------------------
// Example helpers
// -----------------------------------------------------------------------------

const piOver = (n: bigint): Value => expr("/", [sym("π"), int(n)]);

function bellPair(): Channel {
  return channel(
    [],
    [],
    [
      prepareOp(rat(0n, 1n), 0n),
      prepareOp(rat(0n, 1n), 1n),
      ryOp(0n, piOver(2n), []),
      ryOp(1n, sym("π"), [0n]),
      observeOp(0n, "r0"),
      observeOp(1n, "r1"),
    ]
  );
}

function bellPairWithRedundantRy0(): Channel {
  // Same channel structurally, but with an extra ry(0) that
  // sturm-simplify will eliminate.
  return channel(
    [],
    [],
    [
      prepareOp(rat(0n, 1n), 0n),
      prepareOp(rat(0n, 1n), 1n),
      ryOp(0n, piOver(2n), []),
      ryOp(0n, int(0n), []), // identity
      ryOp(1n, sym("π"), [0n]),
      observeOp(0n, "r0"),
      observeOp(1n, "r1"),
    ]
  );
}

function bellPairWithSwappedRotations(): Channel {
  // ry(π/2) then ry(π/2) on wire 0 = ry(π) — different unitary action
  // (full NOT instead of superposition), so observable difference.
  return channel(
    [],
    [],
    [
      prepareOp(rat(0n, 1n), 0n),
      prepareOp(rat(0n, 1n), 1n),
      ryOp(0n, piOver(2n), []),
      ryOp(0n, piOver(2n), []),
      ryOp(1n, sym("π"), [0n]),
      observeOp(0n, "r0"),
      observeOp(1n, "r1"),
    ]
  );
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Decide whether two Sturm channels denote the same arrow via canonical-form comparison + distribution comparison; sound on equal and on witness-backed inequality",
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "byte-identical empty channels — equal",
      input: record({
        lhs: encodeChannel(channel([], [], [])),
        rhs: encodeChannel(channel([], [], [])),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description: "ry(0) collapsed by sturm-simplify ⇒ syntactic equality",
      input: record({
        lhs: encodeChannel(
          channel(
            [],
            [],
            [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
          )
        ),
        rhs: encodeChannel(
          channel(
            [],
            [],
            [
              prepareOp(rat(0n, 1n), 0n),
              ryOp(0n, int(0n), []),
              observeOp(0n, "r"),
            ]
          )
        ),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description:
        "ry(α) ry(β) and ry(α+β) merge to byte-identical post-simplify",
      input: record({
        lhs: encodeChannel(
          channel(
            [],
            [],
            [
              prepareOp(rat(0n, 1n), 0n),
              ryOp(0n, sym("α"), []),
              ryOp(0n, sym("β"), []),
              observeOp(0n, "r"),
            ]
          )
        ),
        rhs: encodeChannel(
          channel(
            [],
            [],
            [
              prepareOp(rat(0n, 1n), 0n),
              ryOp(0n, expr("+", [sym("α"), sym("β")]), []),
              observeOp(0n, "r"),
            ]
          )
        ),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description: "Bell pair vs Bell pair — equal",
      input: record({
        lhs: encodeChannel(bellPair()),
        rhs: encodeChannel(bellPair()),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description:
        "Bell pair vs Bell-with-redundant-ry(0) — equal after simplify",
      input: record({
        lhs: encodeChannel(bellPair()),
        rhs: encodeChannel(bellPairWithRedundantRy0()),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      // The channels are not equivalent; the witness pins the first
      // resolution where the distributions diverge. `output` is
      // omitted: the witness probabilities are float64 simulation
      // results that land a ULP away from the analytic `0.5`, so the
      // byte-exact record is pinned by the folded golden (ADR-0043 /
      // issue ixnv.3).
      description:
        "Bell pair vs Bell-with-extra-ry(π/2) — distributions differ",
      input: record({
        lhs: encodeChannel(bellPair()),
        rhs: encodeChannel(bellPairWithSwappedRotations()),
      }),
    },
    {
      description: "deterministic 0 vs deterministic 1 — distributions differ",
      input: record({
        lhs: encodeChannel(
          channel(
            [],
            [],
            [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
          )
        ),
        rhs: encodeChannel(
          channel(
            [],
            [],
            [prepareOp(int(1n), 0n), observeOp(0n, "r")]
          )
        ),
      }),
      output: record({
        equal: bool(false),
        reason: str("not-equivalent"),
        witness: record({
          classical_resolutions: list([
            record({ ref: str("r"), value: int(0n) }),
          ]),
          lhs_prob: float64FromNumber(1.0),
          rhs_prob: float64FromNumber(0.0),
        }),
      }),
    },
    {
      description:
        "out-of-scope: lhs uses oracle, sturm-execute can't simulate",
      input: record({
        lhs: encodeChannel(
          channel(
            [],
            [],
            [
              prepareOp(rat(0n, 1n), 0n),
              {
                head: "oracle",
                circuit: sym("placeholder"),
                inWires: [0n],
                outWires: [0n],
              },
            ]
          )
        ),
        rhs: encodeChannel(
          channel([], [], [prepareOp(rat(0n, 1n), 0n)])
        ),
      }),
      output: record({
        detail: str("lhs out-of-scope: oracle op not supported in v0.1"),
        equal: bool(false),
        reason: str("out-of-scope"),
      }),
    },
    {
      description:
        "out-of-scope: lhs uses discard, sturm-execute can't simulate",
      input: record({
        lhs: encodeChannel(
          channel(
            [],
            [],
            [
              prepareOp(rat(0n, 1n), 0n),
              { head: "discard", wireId: 0n },
            ]
          )
        ),
        rhs: encodeChannel(channel([], [], [])),
      }),
      output: record({
        detail: str("lhs out-of-scope: discard op not supported in v0.1"),
        equal: bool(false),
        reason: str("out-of-scope"),
      }),
    },
    {
      description: "different classical_refs ⇒ out-of-scope",
      input: record({
        lhs: encodeChannel(
          channel(
            [],
            [],
            [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r0")]
          )
        ),
        rhs: encodeChannel(
          channel(
            [],
            [],
            [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "different_name")]
          )
        ),
      }),
      output: record({
        detail: str("different-classical_refs"),
        equal: bool(false),
        reason: str("out-of-scope"),
      }),
    },
    {
      description:
        "input signature with quantum wires preserved — same channel",
      input: record({
        lhs: encodeChannel(
          channel(
            [wire(0n, "quantum", "qubit")],
            [],
            [ryOp(0n, sym("π"), []), observeOp(0n, "r")]
          )
        ),
        rhs: encodeChannel(
          channel(
            [wire(0n, "quantum", "qubit")],
            [],
            [ryOp(0n, sym("π"), []), observeOp(0n, "r")]
          )
        ),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description:
        "rz alone is unobservable on standard basis (distribution-only equality)",
      input: record({
        lhs: encodeChannel(
          channel(
            [],
            [],
            [
              prepareOp(rat(1n, 2n), 0n),
              rzOp(0n, sym("π"), []),
              observeOp(0n, "r"),
            ]
          )
        ),
        rhs: encodeChannel(
          channel(
            [],
            [],
            [prepareOp(rat(1n, 2n), 0n), observeOp(0n, "r")]
          )
        ),
      }),
      // Same standard-basis distribution; different unitary on the
      // state vector. Out-of-scope is the honest answer.
      output: record({
        detail: str("distribution-match-but-not-syntactic"),
        equal: bool(false),
        reason: str("out-of-scope"),
      }),
    },
  ],
  invariants: [
    {
      name: "soundness-on-equal-true",
      statement:
        "if equal=true is returned, the two channels produce byte-identical IRs after sturm-simplify, so they denote the same arrow",
      machine_checkable: false,
    },
    {
      name: "soundness-on-not-equivalent",
      statement:
        "if equal=false reason='not-equivalent' is returned, the witness names a classical-resolution outcome whose probabilities provably differ between lhs and rhs",
      machine_checkable: false,
    },
    {
      name: "honest-scope",
      statement:
        "if the equivalence cannot be decided (distributions match but bytes differ; either side out-of-scope for sturm-execute) the tool returns equal=false reason='out-of-scope', never an unwarranted equal=true",
      machine_checkable: false,
    },
    {
      name: "symmetry",
      statement:
        "equivalent(a, b).equal === equivalent(b, a).equal for every pair (a, b)",
      machine_checkable: true,
    },
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
  ],
  fn: async (input, _flags): Promise<Value> => {
    const lhs = input.fields.lhs;
    const rhs = input.fields.rhs;
    return await decideEquivalent(lhs, rhs);
  },
  test: async () => {
    // Symmetry probe: equivalent(a, b).equal === equivalent(b, a).equal
    // for a small set of in-scope channels. We re-decide each pair both
    // ways and compare just the `equal` field.
    const probes: Array<{ a: Channel; b: Channel; description: string }> = [
      { a: channel([], [], []), b: channel([], [], []), description: "empty" },
      {
        a: bellPair(),
        b: bellPairWithRedundantRy0(),
        description: "bell vs bell+ry(0)",
      },
      {
        a: bellPair(),
        b: bellPairWithSwappedRotations(),
        description: "bell vs not-bell",
      },
    ];
    for (const probe of probes) {
      const ab = await decideEquivalent(
        encodeChannel(probe.a),
        encodeChannel(probe.b)
      );
      const ba = await decideEquivalent(
        encodeChannel(probe.b),
        encodeChannel(probe.a)
      );
      if (ab.kind !== "record" || ba.kind !== "record") {
        throw new Error(
          `sturm-equivalent test: unexpected output kind on ${probe.description}`
        );
      }
      const abEqual = ab.fields["equal"];
      const baEqual = ba.fields["equal"];
      if (
        abEqual === undefined ||
        baEqual === undefined ||
        abEqual.kind !== "boolean" ||
        baEqual.kind !== "boolean" ||
        abEqual.value !== baEqual.value
      ) {
        throw new Error(
          `sturm-equivalent test: symmetry violated on ${probe.description}`
        );
      }
    }
    // Determinism probe: same input → same output bytes on repeat.
    const detProbe = record({
      lhs: encodeChannel(bellPair()),
      rhs: encodeChannel(bellPairWithRedundantRy0()),
    });
    const out1 = canonicalize(
      await decideEquivalent(detProbe.fields.lhs, detProbe.fields.rhs)
    );
    const out2 = canonicalize(
      await decideEquivalent(detProbe.fields.lhs, detProbe.fields.rhs)
    );
    if (out1 !== out2) {
      throw new Error(
        `sturm-equivalent test: nondeterministic on bell-pair probe`
      );
    }
  },
});

if (import.meta.main) void runTool(def);
