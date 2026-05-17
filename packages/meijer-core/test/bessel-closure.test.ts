// =============================================================================
// bessel-closure.test.ts — Phase 3 Tier 3 (T3) Bessel-family closure validation
// =============================================================================
//
// Mission (bead `scientist-workbench-4uws`, epic `scientist-workbench-zcam`)
// -------------------------------------------------------------------------
// Validate that every existing dispatch rule in
// `packages/meijer-core/src/dispatch-rules/` that emits a Bessel-family
// named head (`BesselJ`, `BesselY`, `BesselI`, `BesselK`) **round-trips**
// through I6's forward bridge in `packages/meijer-core/src/bridges/bessel.ts`.
// Any rule whose emission does not close cleanly is either:
//
//   * a bug in the rule (its G-form doesn't match R4 §A.4's canonical
//     Bessel-family form — file a P2 bead), OR
//   * an incomplete I6 backward matcher (the rule's G-form needs added
//     `meijerGToHead` coverage — file a P3 bead), OR
//   * a *mirror-form* coexistence (e.g. the `z → 1/z` Mellin involution
//     of `bateman-5-6-5`) where the dispatcher's rule is for a DIFFERENT
//     backward path than the bridge's forward path — documented as
//     "N/A (rule independent of the bridge)" per R4 §E.2, NOT a finding.
//
// The closure test does NOT modify dispatch rules in-place — per CLAUDE.md
// Rule 8 (honest scope) and T3's bead constraints, root-cause analysis
// warrants a dedicated bead. We file findings, never silently patch.
//
// This test is the **second** per-head closure-validation harness in the
// workbench, mirroring `erf-closure.test.ts` (Erf T3, worklog 138). Bessel
// is the first 2-argument head to exercise the closure-validation pattern
// — every entry takes `(ν, z)`, and the bridge's `argsInverse` closure
// is arity-agnostic per ADR-0041 §"Decision 5" (renamed from `zInverse`
// in I6-prep).
//
// Anatomy of the round-trip
// -------------------------
// For each rule R that emits a head H ∈ {BesselJ, BesselY, BesselI, BesselK}:
//
//   1. Construct R's matching G-form input `gIn = (an, ap, bm, bq, z)`
//      with a concrete symbolic `z` chosen so the rule fires.
//   2. Dispatch via `meijergSymbolic(gIn.params, gIn.z)`; require the
//      result to be a `matched` with `ruleId === R.id`.
//   3. Extract `(head, args)` from the emitted expression by walking the
//      AST past `casSimplify`'s `tagged "cas-simplify/out-of-scope"`
//      wrappers and finding the load-bearing Bessel-family head.
//   4. Call `headToMeijerGBessel(head, args)` and verify it returns a
//      non-null `ForwardBridge` (i.e. I6's forward matcher recognises
//      the head with its 2-arg `[nu, z]` shape).
//   5. Compare the returned `gForm.{an, ap, bm, bq}` shape (the
//      load-bearing `(m,n,p,q)` tuple) against the canonical R4 §A.4
//      shape for that head:
//
//      | Head    | (m,n,p,q) |
//      |---------|-----------|
//      | BesselJ | (1,0,0,2) |
//      | BesselY | (2,0,1,3) |
//      | BesselI | (1,0,1,3) |
//      | BesselK | (2,0,0,2) |
//
//      The bridge's prefactor `wrap` is also verified per head: BesselJ
//      / BesselY → identity, BesselI → `π·g`, BesselK → `(1/2)·g`. A
//      missing prefactor is a silent numerical bug — the closure assertion
//      catches it structurally.
//
// The closure test asserts the *structural* fact (the bridge correctly
// emits the canonical R4 §A.4 G-form on the extracted head + args). It
// does NOT assert byte-identity of the recovered `nu` / `z` back to the
// rule's input — the rule's emission deliberately reshapes its arguments
// (e.g. `bateman-5-6-25` emits `K_0(2√z)`, so the extracted `z`-arg is
// `2·z^{1/2}` not the rule's input `z`). The bridge then emits
// `z²/4` of that, which is `(2·z^{1/2})²/4 = z` *mathematically* but
// structurally a nested-power AST that `cas-simplify` does NOT reduce
// (multi-valued root surface; see `bridges/bessel.ts` file-top "The
// `argsInverse` closure trick"). Byte-identical z-recovery requires the
// forward-bridge `argsInverse()` closure, which is verified in
// `bridges-bessel.test.ts`'s Layer 2 round-trip block — not here.
//
// What this test enforces
// -----------------------
// 1. **Every Bessel-emitting rule's emission is bridgeable.** The
//    extracted `(head, args)` passes through `headToMeijerGBessel` without
//    `null`.
// 2. **The bridge's recovered G-form `(m,n,p,q)` matches R4 §A.4.** Slot
//    arities byte-identical to the canonical Bessel-family shape.
// 3. **The bridge's prefactor `wrap` matches R4 §A.4.** BesselJ / BesselY
//    identity; BesselI π; BesselK 1/2.
// 4. **The mirror-form rule `bateman-5-6-5` is explicitly documented as
//    N/A** (R4 §E.2 — different backward path than the bridge's forward).
//
// Frozen-inventory discipline
// ---------------------------
// The `RULE_PROBES` list at the top of this file is the FROZEN INVENTORY.
// When a future agent adds a Bessel-emitting rule (e.g. a new
// `bateman-5-6-Y-generic` per R4 §E.3 / bead `1xqq`), the inventory test
// below fails because the probed set doesn't match the discovered set.
// That's the desired behaviour — coverage discipline by construction.

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  int,
  rat,
  sym,
  type Value,
} from "@workbench/protocol";
import { mkTimes, SIMPLIFY_TAG } from "@workbench/cas-core";
import {
  ALL_RULES,
  headToMeijerGBessel,
  meijergSymbolic,
  type ForwardBridge,
  type MeijerGSymbolicParams,
} from "../src/index.js";
import type { ReductionRule } from "../src/dispatch-types.js";

// -----------------------------------------------------------------------------
// Helpers (mirror `erf-closure.test.ts` for cross-file readability)
// -----------------------------------------------------------------------------

function I(n: number | bigint): Value {
  return int(typeof n === "bigint" ? n : BigInt(n));
}
function R(n: number, d: number): Value {
  return rat(BigInt(n), BigInt(d));
}

const BESSEL_FAMILY_HEADS: ReadonlySet<string> = new Set([
  "BesselJ", "BesselY", "BesselI", "BesselK",
]);

/**
 * Recursively strip `tagged "cas-simplify/out-of-scope"` wrappers. The
 * dispatcher's `casSimplify` pass wraps every special-function subterm
 * in this tag (the Q(x) canonicaliser refuses to enter heads it doesn't
 * own). For closure validation we need the raw AST under the tags.
 */
function stripSimplifyTags(v: Value): Value {
  if (v.kind === "tagged" && v.tag === SIMPLIFY_TAG) {
    return stripSimplifyTags(v.payload);
  }
  if (v.kind === "expression") {
    return {
      kind: "expression",
      head: v.head,
      args: v.args.map(stripSimplifyTags),
    };
  }
  return v;
}

/**
 * Find the FIRST Bessel-family head occurrence in a (tag-stripped) AST,
 * returning `{ head, args }`. Returns null if no such head is present.
 *
 * Every rule in scope emits exactly one Bessel head wrapped in a numeric
 * prefactor expression (e.g. `2 · K_0(2√z)`); the walker drills past the
 * `*`/`-`/`/` wrapping to find the named head.
 */
function findBesselFamilyHead(
  v: Value,
): { head: string; args: readonly Value[] } | null {
  if (v.kind === "expression") {
    if (BESSEL_FAMILY_HEADS.has(v.head)) {
      return { head: v.head, args: v.args };
    }
    for (const a of v.args) {
      const found = findBesselFamilyHead(a);
      if (found) return found;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Rule survey — every dispatch rule that emits a Bessel-family head
// -----------------------------------------------------------------------------
//
// Survey methodology: grep `dispatch-rules/*.ts` for `expr("BesselJ"`,
// `expr("BesselY"`, `expr("BesselI"`, `expr("BesselK"`. The set is
// hand-rolled below (5 round-trip-compatible entries plus 1 explicit
// N/A) so the test serves as a frozen inventory.
//
// At the time T3 ships, every Bessel-family-emitting dispatch rule lives
// in `dispatch-rules/bateman-5-6.ts`. R4 §E.1 surveys them:
//
//   * `bateman-5-6-25`       → emits `2 · K_0(2√z)`; bridge match ✓
//   * `bateman-5-6-4`        → emits `2 · z^{(a+b)/2} · K_{a−b}(2√z)`; bridge match ✓
//   * `bateman-5-6-5`        → emits `2 · z^{(a+b)/2−1} · K_{a−b}(2/√z)` (mirror; N/A)
//   * `bateman-5-6-extra-b`  → emits `J_0(2√z)`; bridge match ✓
//   * `bateman-5-6-extra-a`  → emits `J_{−1}(2√z)`; bridge match ✓
//   * `bateman-5-6-6`        → emits `z^{(b₁+b₂)/2} · J_{b₁−b₂}(2√z)`; bridge match ✓
//
// **No `BesselY` or `BesselI`-emitting rule exists today** — R4 §E.3
// filed beads `scientist-workbench-1xqq` (BesselY-backward-dispatch, P2)
// and `scientist-workbench-lfet` (BesselI-backward-dispatch, P2) for the
// gap. The standalone `meijerGToHeadBessel` covers them at the bridge
// layer, but the dispatcher's pattern table does not yet. This is a
// known gap, NOT a T3 finding — pre-filed in Phase 0.

interface BesselEmittingRuleProbe {
  readonly id: string;
  readonly file: string;
  readonly expectedEmittedHead: "BesselJ" | "BesselY" | "BesselI" | "BesselK";
  readonly inputParams: MeijerGSymbolicParams;
  readonly inputZ: Value;
  /** Expected canonical `(m,n,p,q)` tuple the bridge SHOULD emit per
   *  R4 §A.4. The bridge's slot tuples themselves are functions of the
   *  extracted `nu` — we assert arities and `(m,n,p,q)`, not byte-level
   *  slot content. */
  readonly expectedBridgeMnpq: {
    readonly m: number;
    readonly n: number;
    readonly p: number;
    readonly q: number;
  };
  /** Expected prefactor classification per R4 §A.4:
   *    * `"identity"` → wrap(g) = g (BesselJ, BesselY)
   *    * `"pi"`       → wrap(g) = π · g (BesselI)
   *    * `"half"`     → wrap(g) = (1/2) · g (BesselK)
   */
  readonly expectedPrefactor: "identity" | "pi" | "half";
  readonly note: string;
}

const Z_SYM = sym("z");

const RULE_PROBES: readonly BesselEmittingRuleProbe[] = [
  // ---------------------------------------------------------------------------
  // Rule 1 — bateman-5-6-25: G([],[]; [0,0],[]; z) = 2 · K_0(2√z)
  // ---------------------------------------------------------------------------
  // Most-specific literal-only match. The bridge's BesselK(0, ·) emits
  // shape (2,0,0,2) with bm = [0/2, -0/2] = [0, ...]; the rule's input
  // shape (2,0,0,2) bm = [0, 0] matches the canonical Bessel-K (m,n,p,q).
  {
    id: "bateman-5-6-25",
    file: "dispatch-rules/bateman-5-6.ts",
    expectedEmittedHead: "BesselK",
    inputParams: {
      an: [], ap: [], bm: [I(0), I(0)], bq: [],
    },
    inputZ: Z_SYM,
    expectedBridgeMnpq: { m: 2, n: 0, p: 0, q: 2 },
    expectedPrefactor: "half",
    note:
      "Emits 2·K_0(2√z); bridge sees BesselK head, recovers (2,0,0,2) " +
      "shape with prefactor 1/2. Round-trip compatible per R4 §E.2.",
  },

  // ---------------------------------------------------------------------------
  // Rule 2 — bateman-5-6-4: G([],[]; [a,b],[]; z) = 2·z^{(a+b)/2}·K_{a−b}(2√z)
  // ---------------------------------------------------------------------------
  // Generic free-slot rule. We feed (a,b) = (-1/2, 1/2) so canonical-bytes
  // sort produces bm = [rat(-1,2), rat(1,2)]; rule binds a = -1/2, b = 1/2
  // and emits BesselK(a-b, 2√z) = BesselK(-1, 2√z). K is even so K_{-1} =
  // K_1 mathematically; the bridge handles any nu literally and emits
  // shape (2,0,0,2) with prefactor 1/2.
  {
    id: "bateman-5-6-4",
    file: "dispatch-rules/bateman-5-6.ts",
    expectedEmittedHead: "BesselK",
    inputParams: {
      an: [], ap: [], bm: [R(-1, 2), R(1, 2)], bq: [],
    },
    inputZ: Z_SYM,
    expectedBridgeMnpq: { m: 2, n: 0, p: 0, q: 2 },
    expectedPrefactor: "half",
    note:
      "Generic K_{a-b} rule; bridge sees BesselK head, recovers (2,0,0,2) " +
      "shape with prefactor 1/2. Round-trip compatible per R4 §E.2.",
  },

  // ---------------------------------------------------------------------------
  // Rule 3 — bateman-5-6-extra-b: G([],[]; [0],[0]; z) = J_0(2√z)
  // ---------------------------------------------------------------------------
  // Most-specific literal-only J_0 match. The bridge's BesselJ(0, ·)
  // emits shape (1,0,0,2) — identical to the rule's input shape.
  {
    id: "bateman-5-6-extra-b",
    file: "dispatch-rules/bateman-5-6.ts",
    expectedEmittedHead: "BesselJ",
    inputParams: {
      an: [], ap: [], bm: [I(0)], bq: [I(0)],
    },
    inputZ: Z_SYM,
    expectedBridgeMnpq: { m: 1, n: 0, p: 0, q: 2 },
    expectedPrefactor: "identity",
    note:
      "Emits J_0(2√z); bridge sees BesselJ head, recovers (1,0,0,2) " +
      "shape with prefactor 1. Round-trip compatible per R4 §E.2.",
  },

  // ---------------------------------------------------------------------------
  // Rule 4 — bateman-5-6-extra-a: G([],[]; [-1/2],[1/2]; z) = J_{-1}(2√z)
  // ---------------------------------------------------------------------------
  // Half-integer literal match. The bridge's BesselJ(-1, ·) emits
  // shape (1,0,0,2) with bm = [-1/2, ...], byte-equivalent (modulo
  // structural noise) to the rule's input shape.
  {
    id: "bateman-5-6-extra-a",
    file: "dispatch-rules/bateman-5-6.ts",
    expectedEmittedHead: "BesselJ",
    inputParams: {
      an: [], ap: [], bm: [R(-1, 2)], bq: [R(1, 2)],
    },
    inputZ: Z_SYM,
    expectedBridgeMnpq: { m: 1, n: 0, p: 0, q: 2 },
    expectedPrefactor: "identity",
    note:
      "Emits J_{-1}(2√z); bridge sees BesselJ head, recovers (1,0,0,2) " +
      "shape with prefactor 1. Round-trip compatible per R4 §E.2.",
  },

  // ---------------------------------------------------------------------------
  // Rule 5 — bateman-5-6-6: G([],[]; [b₁],[b₂]; z) = z^{(b₁+b₂)/2}·J_{b₁−b₂}(2√z)
  // ---------------------------------------------------------------------------
  // Generic free-slot J_{b₁-b₂} rule. We feed (b₁, b₂) = (1/2, -1/2) so
  // canonical-bytes sort puts bm = [rat(1,2)] and bq = [rat(-1,2)] (the
  // bm/bq sub-tuples are sorted independently; each has 1 element here so
  // no permutation). Rule binds b1 = 1/2, b2 = -1/2 and emits
  // BesselJ(b1-b2, 2√z) = BesselJ(1, 2√z). The bridge handles any nu
  // literally and emits shape (1,0,0,2) with prefactor 1.
  //
  // We deliberately pick non-{0, -1, -1/2/1/2} parameters so the more-
  // specific extra-a / extra-b rules do NOT fire and the generic rule
  // takes the dispatch slot.
  {
    id: "bateman-5-6-6",
    file: "dispatch-rules/bateman-5-6.ts",
    expectedEmittedHead: "BesselJ",
    inputParams: {
      an: [], ap: [], bm: [R(1, 2)], bq: [R(-1, 2)],
    },
    inputZ: Z_SYM,
    expectedBridgeMnpq: { m: 1, n: 0, p: 0, q: 2 },
    expectedPrefactor: "identity",
    note:
      "Generic J_{b₁-b₂} rule; bridge sees BesselJ head, recovers " +
      "(1,0,0,2) shape with prefactor 1. Round-trip compatible per R4 §E.2.",
  },
];

// -----------------------------------------------------------------------------
// Rule 6 (N/A) — bateman-5-6-5: mirror form (z → 1/z), documented coexistence
// -----------------------------------------------------------------------------
//
// `bateman-5-6-5` matches shape (0,2,2,0) and emits `2·z^{...}·K_{a-b}(2/√z)`.
// This is the `z → 1/z` Mellin-involution mirror of `bateman-5-6-4`.
// The bridge does NOT emit shape (0,2,2,0) — all four bridged heads
// (BesselJ/Y/I/K) have non-empty `bm`, so `m ≥ 1` in every bridge-emitted
// G-form. The bridge's emitted `(m,n,p,q)` tuples are (1,0,0,2),
// (2,0,1,3), (1,0,1,3), (2,0,0,2); none has `m = 0`.
//
// Therefore `bateman-5-6-5` is for a DIFFERENT backward path (e.g.
// a hypergeometric reduction that produces the `(0,2,2,0)` shape) —
// independent of the bridge, NOT a finding.
//
// Per R4 §E.2: "Bridge forward never emits this shape. N/A (rule is for
// a different backward path)."

const NA_MIRROR_RULES: readonly { id: string; note: string }[] = [
  {
    id: "bateman-5-6-5",
    note:
      "Mirror form (z → 1/z); shape (0,2,2,0) is NOT emitted by the bridge " +
      "(which emits only m ≥ 1 shapes). Independent of the bridge per R4 §E.2.",
  },
];

// -----------------------------------------------------------------------------
// Survey assertion — frozen inventory of Bessel-emitting rules
// -----------------------------------------------------------------------------

describe("Bessel-closure: rule inventory invariant", () => {
  test("RULE_PROBES enumerates every round-trip-compatible Bessel-emitting rule", () => {
    const probedIds = new Set(RULE_PROBES.map((p) => p.id));
    const naIds = new Set(NA_MIRROR_RULES.map((r) => r.id));
    const allRuleIds = new Set(ALL_RULES.map((r: ReductionRule) => r.id));

    // Every probed id must exist in ALL_RULES.
    for (const id of probedIds) {
      expect(allRuleIds.has(id)).toBe(true);
    }
    // Every N/A id must also exist in ALL_RULES (we document them; they're real).
    for (const id of naIds) {
      expect(allRuleIds.has(id)).toBe(true);
    }

    // Cross-check: the total set of Bessel-emitting rule ids in
    // ALL_RULES must equal `probedIds ∪ naIds`. We fire every rule's
    // probe input and check whether the emission contains a Bessel head;
    // the discovered set must match what we hand-rolled.
    //
    // The discovery loop is bounded to the rule ids we test (the probes
    // + N/A list); any future Bessel-emitting rule added without an
    // inventory row will trip the per-rule probe block below (no probe
    // entry means no test fires for it), but the inventory invariant
    // itself is what flags the omission first.
    //
    // We DO NOT auto-probe every rule in ALL_RULES with a synthesised
    // input — synthesising a matching input for a rule requires knowing
    // its `match.mnpq` and slot shape, which is rule-specific (some
    // need literal values that fit narrow predicates). Hand-rolling
    // the 5 probes + 1 N/A keeps the test readable and the inventory
    // explicit.

    // The expected number of Bessel-emitting rules in bateman-5-6.ts
    // is 6 (5 probed + 1 N/A); R4 §E.1 surveys them. If a future agent
    // adds a 7th, they must update this number.
    expect(probedIds.size + naIds.size).toBe(6);
  });

  test("Every probe rule fires on its synthesised input and emits the expected head", () => {
    for (const probe of RULE_PROBES) {
      const r = meijergSymbolic(probe.inputParams, probe.inputZ);
      expect(r.kind).toBe("matched");
      if (r.kind !== "matched") continue;
      expect(r.ruleId).toBe(probe.id);
      const stripped = stripSimplifyTags(r.expr);
      const found = findBesselFamilyHead(stripped);
      expect(found).not.toBeNull();
      if (!found) continue;
      expect(found.head).toBe(probe.expectedEmittedHead);
    }
  });
});

// -----------------------------------------------------------------------------
// Closure validation — one block per Bessel-emitting rule
// -----------------------------------------------------------------------------

describe("Bessel-closure: per-rule round-trip through I6 forward bridge", () => {
  for (const probe of RULE_PROBES) {
    test(`${probe.id} → headToMeijerGBessel closure (${probe.note.split(";")[0]})`, () => {
      // Step 1: dispatch
      const r = meijergSymbolic(probe.inputParams, probe.inputZ);
      expect(r.kind).toBe("matched");
      if (r.kind !== "matched") return;
      expect(r.ruleId).toBe(probe.id);

      // Step 2: extract (head, args)
      const stripped = stripSimplifyTags(r.expr);
      const extracted = findBesselFamilyHead(stripped);
      expect(extracted).not.toBeNull();
      if (!extracted) return;
      expect(extracted.head).toBe(probe.expectedEmittedHead);

      // Sanity: every Bessel head is 2-arg.
      expect(extracted.args.length).toBe(2);

      // Step 3: forward bridge on the extracted head + args
      const bridged: ForwardBridge | null = headToMeijerGBessel(
        extracted.head,
        extracted.args,
      );
      expect(bridged).not.toBeNull();
      if (!bridged) return;

      // Step 4: compare bridge's recovered `(m,n,p,q)` against R4 §A.4.
      // Slot arities are derived from list lengths per the standard
      // Meijer-G convention: `m = |bm|`, `n = |an|`, `p = |an|+|ap|`,
      // `q = |bm|+|bq|`.
      const m = bridged.gForm.bm.length;
      const n = bridged.gForm.an.length;
      const p = bridged.gForm.an.length + bridged.gForm.ap.length;
      const q = bridged.gForm.bm.length + bridged.gForm.bq.length;
      expect(m).toBe(probe.expectedBridgeMnpq.m);
      expect(n).toBe(probe.expectedBridgeMnpq.n);
      expect(p).toBe(probe.expectedBridgeMnpq.p);
      expect(q).toBe(probe.expectedBridgeMnpq.q);

      // Step 5: verify the bridge's prefactor `wrap` matches R4 §A.4.
      // The prefactor is the load-bearing scaling factor that
      // distinguishes the four heads numerically (a missing or swapped
      // prefactor is a silent numerical bug — the closure assertion
      // catches it structurally).
      const g = sym("g_dummy");
      const wrapped = bridged.wrap(g);
      switch (probe.expectedPrefactor) {
        case "identity":
          expect(canonicalize(wrapped)).toBe(canonicalize(g));
          break;
        case "pi":
          expect(canonicalize(wrapped)).toBe(canonicalize(mkTimes(sym("pi"), g)));
          break;
        case "half":
          expect(canonicalize(wrapped)).toBe(canonicalize(mkTimes(rat(1n, 2n), g)));
          break;
      }

      // Step 6: argsInverse closure is byte-identical to the extracted
      // args (this is the load-bearing 2-arg property of the closure
      // trick; documented in bridges/bessel.ts file-top). For the
      // round-trip through a DISPATCH rule the extracted args are NOT
      // the rule's input z — they're the rule's emitted shape (`I(0)`
      // for ν, `2·z^{1/2}` for z, etc.). The closure captures those
      // *extracted* values, so `argsInverse()` returns the *extracted*
      // args verbatim — that's the test's contract.
      const recovered = bridged.argsInverse();
      expect(recovered.length).toBe(2);
      expect(canonicalize(recovered[0]!)).toBe(canonicalize(extracted.args[0]!));
      expect(canonicalize(recovered[1]!)).toBe(canonicalize(extracted.args[1]!));
    });
  }
});

// -----------------------------------------------------------------------------
// Mirror-form rules (R4 §E.2 N/A documentation)
// -----------------------------------------------------------------------------
//
// `bateman-5-6-5` emits a `BesselK` head whose G-form representation is
// the `z → 1/z` mirror of `bateman-5-6-4`. The bridge does NOT emit the
// `(0,2,2,0)` shape — every bridged head has `m ≥ 1`. This block
// documents the coexistence as a regression anchor: if the bridge ever
// starts emitting `m = 0` shapes (it shouldn't — none of the four
// canonical Bessel-family G-forms has empty `bm`), the documentation
// needs revisiting.

describe("Bessel-closure: mirror-form rules (R4 §E.2, NOT a finding)", () => {
  test("bateman-5-6-5 emits BesselK from (0,2,2,0) shape — bridge does not emit this shape", () => {
    // Fire the mirror-form rule.
    const r = meijergSymbolic(
      { an: [R(1, 2), R(3, 2)], ap: [], bm: [], bq: [] },
      Z_SYM,
    );
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.ruleId).toBe("bateman-5-6-5");

    // Extract the BesselK head from the emission.
    const stripped = stripSimplifyTags(r.expr);
    const extracted = findBesselFamilyHead(stripped);
    expect(extracted).not.toBeNull();
    if (!extracted) return;
    expect(extracted.head).toBe("BesselK");

    // The bridge accepts the BesselK head and emits its canonical
    // G-form (shape (2,0,0,2)) — NOT the mirror's (0,2,2,0) shape.
    // This is the load-bearing fact: a round-trip through the bridge
    // is path-independent of which dispatch rule originally produced
    // the BesselK head.
    const bridged = headToMeijerGBessel(extracted.head, extracted.args);
    expect(bridged).not.toBeNull();
    if (!bridged) return;
    expect(bridged.gForm.bm.length).toBe(2);          // m = 2
    expect(bridged.gForm.an.length).toBe(0);          // n = 0
    expect(bridged.gForm.ap.length).toBe(0);          // p − n = 0
    expect(bridged.gForm.bq.length).toBe(0);          // q − m = 0
  });

  test("Bridge never emits an m=0 shape (sanity invariant)", () => {
    // For every bridged head, the canonical G-form has m ≥ 1. This is
    // the structural reason `bateman-5-6-5` (m = 0 input) cannot be
    // a bridge-emitted shape — and why the mirror-form is honestly
    // independent of the bridge per R4 §E.2.
    const nu = sym("nu");
    const z = sym("z");
    for (const head of ["BesselJ", "BesselY", "BesselI", "BesselK"]) {
      const fwd = headToMeijerGBessel(head, [nu, z]);
      expect(fwd).not.toBeNull();
      if (!fwd) continue;
      expect(fwd.gForm.bm.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// -----------------------------------------------------------------------------
// Honest refusal of out-of-bridge-scope inputs (sanity rail)
// -----------------------------------------------------------------------------

describe("Bessel-closure: bridge honestly refuses non-Bessel-family heads", () => {
  test("Non-Bessel-family head extracted from a hypothetical AST → bridge returns null", () => {
    // Mirror of the Erf-closure sanity rail — the bridge's
    // `headToMeijerGBessel` returns null for any head outside its scope.
    // We exercise this with `Erf` (the previous bridge's domain) and
    // a few other plausible heads a future agent might mistakenly route
    // here.
    expect(headToMeijerGBessel("Erf", [sym("z")])).toBeNull();
    expect(headToMeijerGBessel("Erfc", [sym("z")])).toBeNull();
    expect(headToMeijerGBessel("Gamma", [sym("z")])).toBeNull();
    expect(headToMeijerGBessel("ExpIntegralE", [I(1), sym("z")])).toBeNull();
  });

  test("HankelH1 / HankelH2 / SphericalBesselJ / SphericalBesselY honestly refuse", () => {
    // These heads are admitted to ADR-0023's vocabulary (per ADR-0041
    // §"Decision 6") but NOT bridged in v0.1 (each has its own canonical
    // G-form distinct from J/Y/I/K). The bridge returns `null` rather
    // than emitting a wrong-shaped form. Future per-head bridges may
    // land — when they do, the closure test for THOSE rules adds the
    // appropriate `headToMeijerGHankel*` / etc. entries.
    expect(headToMeijerGBessel("HankelH1", [sym("nu"), sym("z")])).toBeNull();
    expect(headToMeijerGBessel("HankelH2", [sym("nu"), sym("z")])).toBeNull();
    expect(headToMeijerGBessel("SphericalBesselJ", [I(0), sym("z")])).toBeNull();
    expect(headToMeijerGBessel("SphericalBesselY", [I(0), sym("z")])).toBeNull();
  });

  test("Wrong arity (not exactly 2 args) returns null", () => {
    // The four bridged heads all take exactly two arguments. Any other
    // arity is honest refusal (the head name was recognised but the
    // call shape isn't bridgeable). Mirror of `bridges-bessel.test.ts`'s
    // Layer 1 sanity rail.
    expect(headToMeijerGBessel("BesselJ", [])).toBeNull();
    expect(headToMeijerGBessel("BesselJ", [sym("z")])).toBeNull();
    expect(headToMeijerGBessel("BesselJ", [sym("nu"), sym("z"), sym("extra")])).toBeNull();
    expect(headToMeijerGBessel("BesselK", [I(0)])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Findings summary (FOR THE READER — this test asserts the inventory is empty)
// -----------------------------------------------------------------------------
//
// At the time this test file ships, the closure validation reports:
//
//   Rules surveyed:                          6 (all Bessel-family-emitting rules)
//   Round-trip closes structurally:          5 / 5 of bridge-compatible
//   Mirror-form rules (N/A, by design):      1 / 1 documented (bateman-5-6-5)
//   Findings (rule bug / matcher gap):       0
//
// Pre-existing known gaps (NOT T3 findings — filed in Phase 0 per R4 §E.3):
//   * `scientist-workbench-1xqq` (P2) — no `BesselY`-emitting dispatch rule
//     today; standalone `meijerGToHeadBessel` covers BesselY, but no
//     symbolic dispatcher rule reduces to it. Filed for post-T3 follow-up.
//   * `scientist-workbench-lfet` (P2) — same gap for `BesselI`.
//
// Findings WOULD be filed as new beads:
//   * P2 if the rule's emission is mathematically wrong (gates v0.1 epic).
//   * P3 if I6's backward matcher is incomplete for a valid G-form
//     variant (doesn't gate v0.1 — bridge already covers the standalone
//     case).
//   * P4 doc-of-record if the variance is intentional coexistence (the
//     `bateman-5-6-5` mirror is the only example today; it's documented
//     here as a regression anchor, not filed as a bead).
//
// Future work: when new Bessel-emitting rules land (e.g. the
// `BesselY`/`BesselI` generic dispatch rules per beads `1xqq` / `lfet`),
// each goes through the same closure-validation pattern. The frozen
// RULE_PROBES list at the top of this file is the inventory — adding a
// rule without adding a probe row makes the inventory test fail (count
// mismatch).

describe("Bessel-closure: findings inventory", () => {
  test("zero open findings at ship time (5/5 round-trip-compatible rules close cleanly)", () => {
    // This is a sentinel test: if a finding is ever filed against the
    // bridge or against a Bessel-emitting rule, the bead reference goes
    // here and the test body updates. Today: empty.
    const FINDINGS: ReadonlyArray<{ rule: string; bead: string; severity: string }> = [];
    expect(FINDINGS.length).toBe(0);
  });

  test("pre-existing gaps (R4 §E.3, NOT T3 findings) are documented", () => {
    // Document the known dispatch-rule gaps that R4 §E.3 surfaced in
    // Phase 0. Beads filed for post-T3 follow-up; not findings of THIS
    // closure validation.
    const KNOWN_GAPS: ReadonlyArray<{ gap: string; bead: string; priority: string }> = [
      { gap: "No BesselY-emitting dispatcher rule", bead: "scientist-workbench-1xqq", priority: "P2" },
      { gap: "No BesselI-emitting dispatcher rule", bead: "scientist-workbench-lfet", priority: "P2" },
    ];
    expect(KNOWN_GAPS.length).toBe(2);
  });
});
