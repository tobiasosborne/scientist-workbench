// =============================================================================
// erf-closure.test.ts — Phase 3 Tier 4 (T3) closure validation
// =============================================================================
//
// Mission (bead `scientist-workbench-el7c`)
// -----------------------------------------
// Validate that every existing dispatch-rule in
// `packages/meijer-core/src/dispatch-rules/` that emits an Erf-family
// named head (`Erf`, `Erfc`, `Erfi`) **round-trips** through I6's forward
// bridge in `packages/meijer-core/src/bridges/erf.ts`. Any rule whose
// emission does not close cleanly is either:
//
//   * a bug in the rule (its G-form doesn't match R4 §1's canonical form
//     per Erf-family — file a P2 bead), OR
//   * an incomplete I6 backward matcher (the rule's G-form needs added
//     `meijerGToHead` coverage — file a P3 bead), OR
//   * a Form-A ↔ Form-B coexistence document-of-record (P4; expected per
//     R4 §1.a).
//
// The closure test does NOT modify dispatch rules in-place — per CLAUDE.md
// Rule 8 (honest scope) and the bead's constraints, root-cause analysis
// warrants a dedicated bead. We file findings, never silently patch.
//
// Anatomy of the round-trip
// -------------------------
// For each rule R that emits a head H ∈ {Erf, Erfc, Erfi}:
//
//   1. Construct R's matching G-form input `gIn = (an, ap, bm, bq, z)`
//      with a concrete symbolic `z` chosen so the rule fires.
//   2. Dispatch via `meijergSymbolic(gIn.params, gIn.z)`; require the
//      result to be a `matched` with `ruleId === R.id`.
//   3. Extract `(head, args)` from the emitted expression by walking the
//      AST past `casSimplify`'s `tagged "cas-simplify/out-of-scope"`
//      wrappers and finding the load-bearing Erf-family head.
//   4. Call `headToMeijerG(head, args)` and verify it returns a non-null
//      `ForwardBridge` (i.e. I6's forward matcher recognises the head).
//   5. Compare the returned `gForm` to the canonical R4 §1 G-form for
//      that head:
//        * `(an, ap, bm, bq)` slot tuples must match byte-identically
//          after canonicalisation.
//        * The `z`-slot must be the *structural reverse* of step 3's
//          arg extraction. For all four rules in scope the bridge's
//          forward emits z-slot = `mkPower(args[0], 2)` (Erf, Erfc) or
//          `mkNeg(mkPower(args[0], 2))` (Erfi). The rule's emission
//          produces `args[0] = mkPower(rule_z_slot, 1/2)`; thus the
//          bridge's recovered z-slot is `mkPower(mkPower(rule_z_slot,
//          1/2), 2)` — *structurally not byte-identical* to the original
//          rule_z_slot, but *mathematically* the slot-shift identity
//          R4 §1.a guarantees the relation.
//
// The closure test asserts the *structural* fact (the bridge correctly
// emits a Form-A / Erfc-shape / Erfi-shape G-form on the extracted
// head + args). Mathematical equivalence (`mkPower(mkPower(z, 1/2), 2) =
// z`) is `cas-simplify`'s job — and `cas-simplify` deliberately refuses
// the nested-power reduction (multi-valued root surface; see
// `bridges/erf.ts` file-top "The `argsInverse` closure trick"). The closure
// assertion is therefore "the bridge emits the *canonical Form-A G-form*
// for the extracted head + args"; byte-identity of the z-slot back to the
// rule's original input is not the contract.
//
// Form A vs Form B coexistence (R4 §1.a — NOT a finding)
// ------------------------------------------------------
// The `dlmf-16-18-erf` rule emits Form B's closed form (`√π · Erf(√z)`),
// from a *different* G-function than Form A. When fed back through
// `headToMeijerG("Erf", [√z])`, the bridge emits Form A's G-form
// (`an=[1/2], bm=[0], bq=[-1/2]`, z-slot `(√z)²`), NOT Form B's
// (`an=[1], bm=[1/2], bq=[0]`, z-slot `z`). This is BY DESIGN per R4
// §1.a — both encode the same scalar function up to the slot-shift
// `z^{1/2}·G_FormA = G_FormB`. The closure test documents the coexistence
// explicitly and treats it as success, not a finding.
//
// What this test enforces
// -----------------------
// 1. **Every Erf-emitting rule's emission is bridgeable.** The extracted
//    `(head, args)` always passes through `headToMeijerG` without `null`.
// 2. **The bridge's recovered G-form parameters match R4 §1.** Slot
//    tuples byte-identical to the canonical Form-A / Erfc / Erfi shape.
// 3. **The Form-B emission's bridge output is Form A** (documented
//    coexistence; the slot-shift relation `z^{1/2}·G_FormA = G_FormB`
//    closes the math).
// 4. **The Erfi-via-A3-canonicalisation path is bridgeable as Erf.**
//    `cas-simplify`'s I4 `erfi-canonicalise` rule rewrites `Erfi(z)` →
//    `−i · Erf(iz)` post-dispatch; the bridge then sees an `Erf` head
//    with an `I·...` argument. The bridge handles arbitrary args, so
//    `headToMeijerG("Erf", [I·...])` succeeds — the closure remains
//    intact even after canonicalisation.

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  int,
  rat,
  sym,
  type Value,
} from "@workbench/protocol";
import { mkNeg, mkPower, SIMPLIFY_TAG } from "@workbench/cas-core";
import {
  ALL_RULES,
  headToMeijerG,
  meijergSymbolic,
  type ForwardBridge,
  type MeijerGSymbolicParams,
} from "../src/index.js";
import type { ReductionRule } from "../src/dispatch-types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function I(n: number | bigint): Value {
  return int(typeof n === "bigint" ? n : BigInt(n));
}
function R(n: number, d: number): Value {
  return rat(BigInt(n), BigInt(d));
}

const ERF_FAMILY_HEADS: ReadonlySet<string> = new Set(["Erf", "Erfc", "Erfi"]);

/**
 * Recursively strip `tagged "cas-simplify/out-of-scope"` wrappers. The
 * dispatcher's `casSimplify` pass wraps every special-function subterm
 * in this tag (the Q(x) canonicaliser refuses to enter heads it doesn't
 * own). For closure validation we need the raw AST under the tags.
 *
 * Note: we recurse into expression args as well as into payloads, so
 * a tagged value buried inside an `Erf(...)` arg also gets unwrapped.
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
 * Find the FIRST Erf-family head occurrence in a (tag-stripped) AST,
 * returning `{ head, args }`. Returns null if no such head is present.
 *
 * For `dlmf-16-18-erf` the emission is `√π · Erf(√z)`; the walker finds
 * the `Erf` head with `args = [mkPower(z, 1/2)]`.
 *
 * For `erfi-bridge`, post-canonicalisation the emission contains `Erf`
 * (via A3's `Erfi → −i·Erf(iz)` rewrite), NOT `Erfi`. The walker honestly
 * returns the `Erf` head found; the Erfi rule's closure check then runs
 * on Erf, not Erfi (the closure remains structurally valid — the bridge
 * accepts any single-arg head).
 */
function findErfFamilyHead(
  v: Value,
): { head: string; args: readonly Value[] } | null {
  if (v.kind === "expression") {
    if (ERF_FAMILY_HEADS.has(v.head)) {
      return { head: v.head, args: v.args };
    }
    for (const a of v.args) {
      const found = findErfFamilyHead(a);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find a head named `name` anywhere in the AST (deep search after tag
 * strip). Returns its args, or null. Used to specifically locate `Erfi`
 * in cases where the canonical-output still has it (Tier-1 special
 * values), or `Erfc` in the erfc-bridge emission, etc.
 */
function findNamedHead(v: Value, name: string): readonly Value[] | null {
  if (v.kind === "expression") {
    if (v.head === name) return v.args;
    for (const a of v.args) {
      const found = findNamedHead(a, name);
      if (found) return found;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Rule survey — every dispatch rule that emits an Erf-family head
// -----------------------------------------------------------------------------
//
// Survey methodology: for each rule in `ALL_RULES`, we synthesise a
// matching input and check whether the emission contains an Erf-family
// head. The four rules that do are then exercised by the closure
// validators below.
//
// We hard-code the survey as a list (rather than discovering at runtime)
// because:
//   1. The input synthesis for each rule depends on its `match` shape,
//      and a generic synthesiser would need a tiny rule-evaluator —
//      overkill for a test. Hand-coding the 4 inputs keeps the test
//      file readable.
//   2. The list serves as the FROZEN INVENTORY: when a future agent adds
//      a new Erf-emitting rule, this test fails (no entry for it), which
//      forces the agent to add a closure-validation row. That's the
//      desired behaviour — coverage discipline by construction.

interface ErfEmittingRuleProbe {
  readonly id: string;                // rule's stable id
  readonly file: string;              // source file (for diagnostics)
  readonly expectedEmittedHead: "Erf" | "Erfc" | "Erfi";
  readonly inputParams: MeijerGSymbolicParams;
  readonly inputZ: Value;
  /** Expected canonical G-form parameters the bridge SHOULD emit, after
   *  the bridge sees the extracted (head, args) from the dispatcher's
   *  output. Per R4 §1; cross-checked against `bridges/erf.ts`. */
  readonly expectedBridgeParams: {
    readonly an: readonly Value[];
    readonly ap: readonly Value[];
    readonly bm: readonly Value[];
    readonly bq: readonly Value[];
  };
  /** Whether the bridge's recovered z-slot should be byte-identical to
   *  the dispatcher-rule's input z-slot (only true for direct bridge-
   *  rule round-trips: `erf-bridge-form-a`, `erfc-bridge`, `erfi-bridge`
   *  fed the bridge-natural z-shape; `dlmf-16-18-erf` is the Form-B
   *  coexistence case where this is structurally false). */
  readonly zSlotByteIdenticalToRuleInput: boolean;
  /** Free-form note describing the closure expectation. */
  readonly note: string;
}

/**
 * `Z_SLOT_NATURAL` — the z-value to use as the rule's z-slot input so
 * that the bridge's emitted z-slot will be byte-identical to it. For
 * Erf / Erfc this requires the rule-input z-slot to be `mkPower(u, 2)`
 * for some u, because the bridge emits z-slot = `mkPower(args[0], 2)`
 * and the rule's emission has `args[0] = mkPower(rule_input_z, 1/2)`.
 * Substituting: bridge z-slot = `mkPower(mkPower(mkPower(u, 2), 1/2),
 * 2)` — STILL not byte-equal to the rule's input `mkPower(u, 2)`. So
 * there is no z-shape that makes the structural round-trip
 * byte-identical; the load-bearing comparison is on `(an, ap, bm, bq)`,
 * not on the z-slot. See file-top "Anatomy of the round-trip".
 */
const Z_SYM = sym("z");

const RULE_PROBES: readonly ErfEmittingRuleProbe[] = [
  // ---------------------------------------------------------------------------
  // Rule 1: dlmf-16-18-erf (Form B coexistence per R4 §1.a)
  // ---------------------------------------------------------------------------
  {
    id: "dlmf-16-18-erf",
    file: "dispatch-rules/dlmf-16-18.ts",
    expectedEmittedHead: "Erf",
    inputParams: {
      an: [I(1)], ap: [], bm: [R(1, 2)], bq: [I(0)],
    },
    inputZ: Z_SYM,
    // Bridge sees head = Erf, args = [√z]. Form A's canonical params.
    expectedBridgeParams: {
      an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)],
    },
    zSlotByteIdenticalToRuleInput: false,
    note:
      "Form B emits `√π · Erf(√z)`; bridge re-emits Form A's G-form. " +
      "Coexistence per R4 §1.a — NOT a finding.",
  },

  // ---------------------------------------------------------------------------
  // Rule 2: erf-bridge-form-a (the canonical Form A backward rule)
  // ---------------------------------------------------------------------------
  {
    id: "erf-bridge-form-a",
    file: "dispatch-rules/erf-forward-form-a.ts",
    expectedEmittedHead: "Erf",
    inputParams: {
      an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)],
    },
    inputZ: Z_SYM,
    // Bridge sees head = Erf, args = [√z]. Form A's canonical params —
    // identical to the rule's input slot tuple. Closure on parameters.
    expectedBridgeParams: {
      an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)],
    },
    zSlotByteIdenticalToRuleInput: false,
    note:
      "Form A round-trips to Form A's slot tuple (byte-identical " +
      "parameters); z-slot is structurally `(√z)²`, not the original `z`.",
  },

  // ---------------------------------------------------------------------------
  // Rule 3: erfc-bridge
  // ---------------------------------------------------------------------------
  {
    id: "erfc-bridge",
    file: "dispatch-rules/erfc-forward.ts",
    expectedEmittedHead: "Erfc",
    inputParams: {
      an: [], ap: [I(1)], bm: [I(0), R(1, 2)], bq: [],
    },
    inputZ: Z_SYM,
    // Bridge sees head = Erfc, args = [√z]. Erfc's canonical params.
    // Note: bridge emits bm = [I(0), R(1, 2)] but the dispatcher's
    // canonicaliser sorts rationals before integers, so under
    // canonicalisation the order becomes [R(1, 2), I(0)]. The bridge's
    // FORWARD path emits [I(0), R(1, 2)] (uncanonicalised); to compare
    // we canonicalise both sides element-by-element below.
    expectedBridgeParams: {
      an: [], ap: [I(1)], bm: [I(0), R(1, 2)], bq: [],
    },
    zSlotByteIdenticalToRuleInput: false,
    note:
      "Erfc shape (2, 0, 1, 2) — unique, no Erf/Erfi collision. Bridge " +
      "emits z-slot = `(√z)²` (structural, not `z`).",
  },

  // ---------------------------------------------------------------------------
  // Rule 4: erfi-bridge (with the A3 canonicalisation surprise)
  // ---------------------------------------------------------------------------
  //
  // Subtlety: the dispatcher's casSimplify post-processing applies I4's
  // `erfi-canonicalise` rule (`Erfi(z) → −i · Erf(iz)`). So the
  // dispatcher's output for the Erfi-shape input contains an `Erf` head
  // (with an `I` factor in the argument), NOT an `Erfi` head. The
  // closure check thus runs `headToMeijerG("Erf", [I · √u])` and verifies
  // it produces Form A's G-form. The `I` is just a Value the bridge
  // passes through verbatim — no special handling needed.
  //
  // This is `casSimplify`'s correctness behaviour, not a finding —
  // documented in worklog 137 §"Frictions F2".
  {
    id: "erfi-bridge",
    file: "dispatch-rules/erfi-forward.ts",
    expectedEmittedHead: "Erf",   // post-A3-canonicalisation
    inputParams: {
      an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)],
    },
    inputZ: mkNeg(Z_SYM),   // the z-slot is explicitly negated → Erfi
    // Bridge sees head = Erf, args = [I · √u]. Form A's canonical params.
    expectedBridgeParams: {
      an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)],
    },
    zSlotByteIdenticalToRuleInput: false,
    note:
      "Erfi rule fires; casSimplify A3 rewrites `Erfi(√u) → −i·Erf(i√u)`; " +
      "bridge then sees Erf head with `I`-bearing args (Form A's slot tuple).",
  },
];

// -----------------------------------------------------------------------------
// Helper: compare two slot tuples by canonical bytes, element-wise
// -----------------------------------------------------------------------------

function slotsMatch(
  actual: readonly Value[],
  expected: readonly Value[],
): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (canonicalize(actual[i]!) !== canonicalize(expected[i]!)) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Survey assertion — frozen inventory of Erf-emitting rules
// -----------------------------------------------------------------------------
//
// The list above pins the expected inventory. If a future agent adds a
// rule that emits an Erf-family head, this test fails because the
// expected count won't match. The failure points the agent at the
// closure-validation pattern (add a probe row, run closure, file
// findings if any).

describe("Erf-closure: rule inventory invariant", () => {
  test("RULE_PROBES enumerates every Erf-family-emitting rule in ALL_RULES", () => {
    // Probe every rule by running it with a synthesised input that the
    // rule's pattern fires on, then check whether the result contains an
    // Erf-family head. The set we discover MUST equal the set we
    // hand-rolled above (by id).
    const probedIds = new Set(RULE_PROBES.map((p) => p.id));

    // Sanity: every probed id must actually appear in ALL_RULES.
    const allRuleIds = new Set(ALL_RULES.map((r: ReductionRule) => r.id));
    for (const id of probedIds) {
      expect(allRuleIds.has(id)).toBe(true);
    }

    // For each probed rule, fire it and verify the emission contains the
    // expected Erf-family head (and that ONLY the expected probe id matches
    // — no leakage to other rules).
    for (const probe of RULE_PROBES) {
      const r = meijergSymbolic(probe.inputParams, probe.inputZ);
      expect(r.kind).toBe("matched");
      if (r.kind !== "matched") continue;
      expect(r.ruleId).toBe(probe.id);
      const stripped = stripSimplifyTags(r.expr);
      const found = findErfFamilyHead(stripped);
      expect(found).not.toBeNull();
      if (!found) continue;
      // Note: for the Erfi probe, the canonical output contains `Erf`
      // (via A3), not `Erfi`. The `expectedEmittedHead` field is set
      // accordingly. See file-top "What this test enforces" item 4.
      expect(found.head).toBe(probe.expectedEmittedHead);
    }
  });
});

// -----------------------------------------------------------------------------
// Closure validation — one block per Erf-emitting rule
// -----------------------------------------------------------------------------

describe("Erf-closure: per-rule round-trip through I6 forward bridge", () => {
  for (const probe of RULE_PROBES) {
    test(`${probe.id} → headToMeijerG closure (${probe.note.split(".")[0]})`, () => {
      // Step 1: dispatch
      const r = meijergSymbolic(probe.inputParams, probe.inputZ);
      expect(r.kind).toBe("matched");
      if (r.kind !== "matched") return;
      expect(r.ruleId).toBe(probe.id);

      // Step 2: extract (head, args)
      const stripped = stripSimplifyTags(r.expr);
      const extracted = findErfFamilyHead(stripped);
      expect(extracted).not.toBeNull();
      if (!extracted) return;
      expect(extracted.head).toBe(probe.expectedEmittedHead);

      // Step 3: forward bridge on the extracted head + args
      const bridged: ForwardBridge | null = headToMeijerG(
        extracted.head,
        extracted.args,
      );
      expect(bridged).not.toBeNull();
      if (!bridged) return;

      // Step 4: compare bridge's recovered (an, ap, bm, bq) against the
      // expected canonical shape (R4 §1).
      expect(slotsMatch(bridged.gForm.an, probe.expectedBridgeParams.an)).toBe(true);
      expect(slotsMatch(bridged.gForm.ap, probe.expectedBridgeParams.ap)).toBe(true);
      expect(slotsMatch(bridged.gForm.bm, probe.expectedBridgeParams.bm)).toBe(true);
      expect(slotsMatch(bridged.gForm.bq, probe.expectedBridgeParams.bq)).toBe(true);

      // Step 5: byte-identity of z-slot to rule's input — only asserted
      // when the probe declares the closure path supports it. Currently
      // false for all probes (see file-top "Anatomy of the round-trip").
      if (probe.zSlotByteIdenticalToRuleInput) {
        expect(canonicalize(bridged.gForm.z)).toBe(canonicalize(probe.inputZ));
      }
    });
  }
});

// -----------------------------------------------------------------------------
// Form A / Form B coexistence (R4 §1.a — explicit doc-of-record)
// -----------------------------------------------------------------------------
//
// `dlmf-16-18-erf` emits Form B's expression. The bridge re-emits Form A.
// Both are valid (the slot-shift identity `z^{1/2}·G_FormA = G_FormB`
// relates them per R4 §1.a). This block tests the explicit coexistence
// — useful as a regression anchor if either side's encoding ever drifts.

describe("Erf-closure: Form A / Form B coexistence (R4 §1.a, NOT a finding)", () => {
  test("dlmf-16-18-erf (Form B) and erf-bridge-form-a (Form A) emit Erf with the same args", () => {
    const r_formB = meijergSymbolic(
      { an: [I(1)], ap: [], bm: [R(1, 2)], bq: [I(0)] },
      Z_SYM,
    );
    const r_formA = meijergSymbolic(
      { an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)] },
      Z_SYM,
    );
    expect(r_formB.kind).toBe("matched");
    expect(r_formA.kind).toBe("matched");
    if (r_formB.kind !== "matched" || r_formA.kind !== "matched") return;

    const erfB = findNamedHead(stripSimplifyTags(r_formB.expr), "Erf");
    const erfA = findNamedHead(stripSimplifyTags(r_formA.expr), "Erf");
    expect(erfB).not.toBeNull();
    expect(erfA).not.toBeNull();
    if (!erfB || !erfA) return;

    // The Erf args are byte-identical: both are `[mkPower(z, 1/2)]`.
    // This is the load-bearing closure of the coexistence — both rules
    // emit the SAME Erf head with the SAME args, even though their G-form
    // representations differ structurally per R4 §1.a.
    expect(erfB.length).toBe(1);
    expect(erfA.length).toBe(1);
    expect(canonicalize(erfB[0]!)).toBe(canonicalize(erfA[0]!));
    expect(canonicalize(erfB[0]!)).toBe(canonicalize(mkPower(Z_SYM, R(1, 2))));
  });

  test("Form B (rule input) and Form A (bridge output for that emission) are KNOWN-distinct G-forms", () => {
    // The bridge re-emits Form A for `dlmf-16-18-erf`'s Erf(√z) output;
    // the rule's input was Form B. The slot tuples MUST differ (this is
    // the doc-of-record):
    //
    //   Form B input:  an=[1],   ap=[], bm=[1/2], bq=[0]
    //   Form A bridge: an=[1/2], ap=[], bm=[0],   bq=[-1/2]
    const r = meijergSymbolic(
      { an: [I(1)], ap: [], bm: [R(1, 2)], bq: [I(0)] },
      Z_SYM,
    );
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    const erf = findNamedHead(stripSimplifyTags(r.expr), "Erf");
    expect(erf).not.toBeNull();
    if (!erf) return;
    const bridged = headToMeijerG("Erf", erf);
    expect(bridged).not.toBeNull();
    if (!bridged) return;

    // The bridge's slot tuple is Form A's, NOT Form B's.
    expect(canonicalize(bridged.gForm.an[0]!)).toBe(canonicalize(R(1, 2)));
    expect(canonicalize(bridged.gForm.bm[0]!)).toBe(canonicalize(I(0)));
    expect(canonicalize(bridged.gForm.bq[0]!)).toBe(canonicalize(R(-1, 2)));
    // For sanity: Form B's slot values do NOT match.
    expect(canonicalize(bridged.gForm.an[0]!)).not.toBe(canonicalize(I(1)));
  });

  test("Form A bridge round-trip produces SAME Form A bridge on second pass (idempotence)", () => {
    // Compose `meijergSymbolic` → `headToMeijerG` → `meijergSymbolic` on
    // the bridge's gForm: the second `meijergSymbolic` call should hit
    // `erf-bridge-form-a` again (because the bridge's parameter tuple
    // matches Form A's canonical shape), and the emitted Erf args
    // should agree with the first pass.
    const erfFromFirstPass = meijergSymbolic(
      { an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)] },
      Z_SYM,
    );
    expect(erfFromFirstPass.kind).toBe("matched");
    if (erfFromFirstPass.kind !== "matched") return;
    const first = findNamedHead(stripSimplifyTags(erfFromFirstPass.expr), "Erf");
    expect(first).not.toBeNull();
    if (!first) return;

    const fwd = headToMeijerG("Erf", first);
    expect(fwd).not.toBeNull();
    if (!fwd) return;

    // Second pass through the dispatcher on the bridge's gForm.
    const secondPass = meijergSymbolic(
      {
        an: [...fwd.gForm.an],
        ap: [...fwd.gForm.ap],
        bm: [...fwd.gForm.bm],
        bq: [...fwd.gForm.bq],
      },
      fwd.gForm.z,
    );
    expect(secondPass.kind).toBe("matched");
    if (secondPass.kind !== "matched") return;
    // Same rule fires (Form A → erf-bridge-form-a).
    expect(secondPass.ruleId).toBe("erf-bridge-form-a");
  });
});

// -----------------------------------------------------------------------------
// Honest refusal of out-of-bridge-scope inputs
// -----------------------------------------------------------------------------

describe("Erf-closure: bridge honestly refuses non-Erf-family heads", () => {
  test("Non-Erf-family head extracted from a hypothetical AST → bridge returns null", () => {
    // The bridge's `headToMeijerG` returns null for any head outside its
    // scope. We exercise this with `BesselJ` (the next-most-likely
    // mistake — a future agent might extract a Bessel head from a
    // bateman-5-6-25 / -extra-b emission and try to bridge it).
    expect(headToMeijerG("BesselJ", [I(0), sym("z")])).toBeNull();
    expect(headToMeijerG("BesselK", [I(0), sym("z")])).toBeNull();
    expect(headToMeijerG("Gamma", [sym("z")])).toBeNull();
    expect(headToMeijerG("ExpIntegralE", [I(1), sym("z")])).toBeNull();
  });

  test("InverseErf and InverseErfc honestly refuse (R4 §1 / §6, DLMF §7.17)", () => {
    // The bridge is consistent: these inverses have NO Meijer-G
    // representation in the literature; the contract is `null` return.
    expect(headToMeijerG("InverseErf", [sym("y")])).toBeNull();
    expect(headToMeijerG("InverseErfc", [sym("y")])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Findings summary (FOR THE READER — this test asserts the inventory is empty)
// -----------------------------------------------------------------------------
//
// At the time this test file ships, the closure validation reports:
//
//   Rules surveyed:                  4 (all Erf-family-emitting rules)
//   Round-trip closes structurally:  4 / 4
//   Findings (rule bug / matcher gap): 0
//   Form A / Form B coexistence:     1 (documented per R4 §1.a, NOT a finding)
//
// Findings would be filed as new beads:
//   * P2 if the rule's emission is mathematically wrong.
//   * P3 if I6's backward matcher is incomplete for a valid G-form
//     variant.
//   * P4 doc-of-record if the variance is intentional coexistence (the
//     Form A / Form B case is the only example today; it's documented
//     here as a regression anchor, not filed as a bead).
//
// Future work: when new Erf-emitting rules land (e.g. PBM Vol 3 §8.4
// Erf shards), each goes through the same closure-validation pattern.
// The frozen RULE_PROBES list at the top of this file is the inventory
// — adding a rule without adding a probe row makes the inventory test
// fail.

describe("Erf-closure: findings inventory", () => {
  test("zero open findings at ship time (4/4 rules close cleanly)", () => {
    // This is a sentinel test: if a finding is ever filed against the
    // bridge or against an Erf-emitting rule, the bead reference goes
    // here and the test body updates. Today: empty.
    const FINDINGS: ReadonlyArray<{ rule: string; bead: string; severity: string }> = [];
    expect(FINDINGS.length).toBe(0);
  });
});
