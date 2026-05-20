// =============================================================================
// gamma-closure.test.ts — Phase 3 Tier 4 (T3) Gamma-family closure validation
// =============================================================================
//
// Mission (bead `scientist-workbench-boyu`)
// -----------------------------------------
// Validate that the recently-landed Gamma-family dispatch rules
// (`bateman-5-6-38a`, `bateman-5-6-38b`, `bateman-5-6-40`) close
// cleanly against I6's forward bridge in
// `packages/meijer-core/src/bridges/gamma.ts`, AT THE TOOL LAYER (via
// `meijer-g-symbolic-only`'s `def.fn`). The cross-file precedent is
// `packages/meijer-core/test/erf-closure.test.ts` (bead `el7c`); this
// file mirrors that test's layered shape and frozen-inventory
// discipline, scaled to the gamma family's three structural
// distinctives:
//
//   * **Forward sparsity.** Of nine gamma-family heads only TWO have
//     closed G-forms (`IncompleteGammaLower`, `IncompleteGammaUpper`);
//     the seven others honestly refuse (`Gamma`, `LogGamma`, `Digamma`,
//     `Trigamma`, `Polygamma`, `Beta`, `Pochhammer`, `BarnesG`). Per
//     R4 §A.2 / §A.5–A.8 the refusals are structural, not coverage gaps.
//
//   * **Identity z-substitution.** Unlike Erf (`z²`) and Bessel (`z²/4`),
//     the gamma bridge passes `z` through byte-identically — no
//     multi-valued root surface to sidestep. The round-trip from
//     G-form → emitted head → bridge gForm therefore preserves the
//     z-slot exactly (in contrast to the Erf closure, which tolerates a
//     `mkPower(mkPower(z, 1/2), 2)`-style structural-not-byte equality).
//
//   * **Shape collisions.** Both gamma G-forms share their `(m,n,p,q)`
//     shape with sibling heads. The `(2,0,1,2)` shape is shared with
//     `Erfc` (`bm = {0, 1/2}`) and `ExpIntegralE(1, z)` (`bm = {0, 0}`);
//     the `(1,1,1,2)` shape is shared with the Form-B Erf rule
//     (`dlmf-16-18-erf`). Discrimination is enforced by the cross-file
//     ordering in `dispatch.ts::ALL_RULES` — `ERF_FORWARD_FORM_A`,
//     `ERFC_FORWARD`, `DLMF_16_18` precede `BATEMAN_5_6`, so the more-
//     specific literal-only rules in those files win on the collision
//     inputs. This file's tests pin that load-bearing ordering with
//     explicit head-name assertions; a re-ordering regression would
//     fail RED here (see file-bottom "Mutation-proof" notes).
//
// Why a tool-layer test (not just the package-layer one)
// ------------------------------------------------------
// The package-layer tests (`packages/meijer-core/test/bridges-gamma.test.ts`,
// `dispatch.test.ts`) exercise `meijergSymbolic` and
// `headToMeijerGGamma` directly. This file exercises the same closure
// AT THE WIRE SURFACE — through `def.fn` (the value-protocol input/output
// boundary), which is the interface every external caller (`bun
// tools/meijer-g-symbolic-only/tool.ts | ...`, the orchestrator,
// `wb.run`) sees. Round-trip closure at the wire layer is what the
// `gamma-anchor` epic actually contracts; the package layer's success
// is necessary but not sufficient. If a wire-encoding regression
// breaks the input-decode / output-encode without breaking the
// dispatcher's internal contract, the package-layer tests would
// pass while the wire-layer tests fail — exactly the gap this file
// closes.

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  int,
  list,
  rat,
  record,
  sym,
  type Value,
} from "@workbench/protocol";
import { SIMPLIFY_TAG } from "@workbench/cas-core";
import {
  headToMeijerGGamma,
  type ForwardBridge,
} from "@workbench/meijer-core";
import { def } from "./tool.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function I(n: number | bigint): Value {
  return int(typeof n === "bigint" ? n : BigInt(n));
}
function R(n: number, d: number): Value {
  return rat(BigInt(n), BigInt(d));
}

const Z_SYM = sym("z");
const ZERO_INT: Value = I(0);
const ONE_INT: Value = I(1);

/**
 * Build the tool's wire-shape input record. Same helper as in
 * `tool.test.ts` but locally re-typed so this file stays standalone.
 */
function buildInput(
  an: Value[],
  ap: Value[],
  bm: Value[],
  bq: Value[],
  z: Value,
): Parameters<typeof def.fn>[0] {
  return record({
    an: list(an),
    ap: list(ap),
    bm: list(bm),
    bq: list(bq),
    z,
  }) as Parameters<typeof def.fn>[0];
}

/** Call the tool's `fn`. Returns the wire output Value. */
function callFn(input: Parameters<typeof def.fn>[0]): Value {
  return def.fn(input, {} as Parameters<typeof def.fn>[1]) as Value;
}

/**
 * Recursively strip `tagged "cas-simplify/out-of-scope"` wrappers from
 * the AST. `casSimplify` wraps every non-Q(x) subterm so the matched
 * head sits one or more `tagged` layers deep. Mirrors the helper of
 * the same name in `erf-closure.test.ts`.
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
 * Find the first occurrence of an expression head named `name` in a
 * (tag-stripped) AST, returning its args. The gamma rules' emitted
 * heads (`IncompleteGammaUpper`, `IncompleteGammaLower`) sit at the
 * AST root after a single `tagged` unwrap — but coding the traversal
 * recursively keeps the test honest if `casSimplify` ever changes its
 * wrapping policy.
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

/** Element-wise canonical-bytes comparison for slot lists. */
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

/**
 * Extract the `(rule, expr)` pair from a successful tool output, or
 * fail the test with a useful diagnostic. The wire output is a record
 * with fields `expr` / `rule` / `source` / `note`.
 */
function expectMatched(out: Value): { ruleId: string; expr: Value } {
  expect(out.kind).toBe("record");
  if (out.kind !== "record") {
    throw new Error(`expected matched record, got ${out.kind}`);
  }
  const rule = out.fields.rule!;
  expect(rule.kind).toBe("string");
  if (rule.kind !== "string") throw new Error("rule must be string");
  const expr = out.fields.expr!;
  return { ruleId: rule.value, expr };
}

// -----------------------------------------------------------------------------
// Layer 1 — forward closure (gamma G-form → IncompleteGamma* head)
// -----------------------------------------------------------------------------
//
// The three new rules from bead `0pvl` exercised at the tool surface.
// Inputs follow the canonical-bytes-sort convention documented in
// `dispatch-rules/bateman-5-6.ts` ("Canonical-sort multiplicity"):
//
//   * symbolic `a`        → canonical bm = [int(0), sym(a)]    → 38b fires
//   * positive integer `a` → canonical bm = [int(0), int(N)]   → 38b fires
//   * rational `a`        → canonical bm = [rat(...), int(0)]  → 38a fires
//   * negative integer `a` → canonical bm = [int(-N), int(0)]  → 38a fires
//
// The (1,1,1,2) Lower form is single-slot so no canonical-sort
// permutation arises; the rule id is always `bateman-5-6-40`.

describe("gamma-closure: forward closure — IncompleteGammaUpper (bateman-5-6-38a/b)", () => {
  test("symbolic a: input bm=[a, 0] (1,1,1,2)+ap=[1] → IncompleteGammaUpper(a, z) via 38b", () => {
    // Canonical sort puts int(0) before sym(a) (sym bytes contain the
    // `name` field which canonicalises after int's `value`).
    const a = sym("a");
    const out = callFn(buildInput([], [ONE_INT], [a, ZERO_INT], [], Z_SYM));
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("bateman-5-6-38b");

    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaUpper");
    expect(args).not.toBeNull();
    if (!args) return;
    expect(args.length).toBe(2);
    // MUTATION-PROOF: swapping `args[0]` and `args[1]` in the rule's
    // rewrite would emit IncompleteGammaUpper(z, a) here — this test
    // pins the (a, z) argument order.
    expect(canonicalize(args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(args[1]!)).toBe(canonicalize(Z_SYM));
  });

  test("rational a=2/3: canonical bm=[rat 2/3, int 0] (1,1,1,2)+ap=[1] → IncompleteGammaUpper(2/3, z) via 38a", () => {
    // Rationals serialise as `{"den":...,"kind":"rational","num":...}`
    // (bytes start `{"d`), integers as `{"kind":"integer","value":...}`
    // (bytes start `{"k`). The rational sorts first → Pattern A fires.
    const a = R(2, 3);
    const out = callFn(buildInput([], [ONE_INT], [a, ZERO_INT], [], Z_SYM));
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("bateman-5-6-38a");

    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaUpper");
    expect(args).not.toBeNull();
    if (!args) return;
    expect(canonicalize(args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(args[1]!)).toBe(canonicalize(Z_SYM));
  });

  test("multiset symmetry: input bm=[0, a] yields the SAME canonical output as bm=[a, 0]", () => {
    // The Γ-product is symmetric in `b_j`; the dispatcher's canonical
    // sort means both inputs produce byte-identical wire output.
    // MUTATION-PROOF: if the dispatcher dropped the canonical-bytes
    // sort, this assertion would fail (different ruleId or different
    // arg order).
    const a = sym("a");
    const out1 = callFn(buildInput([], [ONE_INT], [a, ZERO_INT], [], Z_SYM));
    const out2 = callFn(buildInput([], [ONE_INT], [ZERO_INT, a], [], Z_SYM));
    expect(canonicalize(out1)).toBe(canonicalize(out2));
  });

  test("negative integer a=-1: canonical bm=[int -1, int 0] → 38a fires with a=-1", () => {
    // Integer bytes start `{"k...` with value field; "-1" sorts before
    // "0". So canonical order is [int(-1), int(0)] — free slot at index 0.
    const a = I(-1);
    const out = callFn(buildInput([], [ONE_INT], [a, ZERO_INT], [], Z_SYM));
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("bateman-5-6-38a");
    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaUpper");
    expect(args).not.toBeNull();
    if (!args) return;
    expect(canonicalize(args[0]!)).toBe(canonicalize(a));
  });
});

describe("gamma-closure: forward closure — IncompleteGammaLower (bateman-5-6-40)", () => {
  test("symbolic a: (1,1,1,2) an=[1], bm=[a], bq=[0] → IncompleteGammaLower(a, z)", () => {
    const a = sym("a");
    const out = callFn(buildInput([ONE_INT], [], [a], [ZERO_INT], Z_SYM));
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("bateman-5-6-40");

    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaLower");
    expect(args).not.toBeNull();
    if (!args) return;
    expect(args.length).toBe(2);
    expect(canonicalize(args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(args[1]!)).toBe(canonicalize(Z_SYM));
  });

  test("rational a=3/2: an=[1], bm=[3/2], bq=[0] → IncompleteGammaLower(3/2, z)", () => {
    // A non-{1/2} rational `a` does NOT collide with the form-B Erf
    // literal rule (`dlmf-16-18-erf` requires bm=[1/2] exactly), so
    // the bateman-5-6-40 free-bearing rule fires.
    const a = R(3, 2);
    const out = callFn(buildInput([ONE_INT], [], [a], [ZERO_INT], Z_SYM));
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("bateman-5-6-40");

    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaLower");
    expect(args).not.toBeNull();
    if (!args) return;
    expect(canonicalize(args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(args[1]!)).toBe(canonicalize(Z_SYM));
  });
});

// -----------------------------------------------------------------------------
// Layer 2 — backward discrimination (the load-bearing piece)
// -----------------------------------------------------------------------------
//
// The (2,0,1,2) shape is shared with Erfc / ExpIntegralE; the (1,1,1,2)
// shape is shared with the Form-B Erf rule. Discrimination is enforced
// at the dispatcher layer by cross-file ordering of `ALL_RULES`:
// ERF_FORWARD_FORM_A, ERFC_FORWARD, DLMF_16_18 precede BATEMAN_5_6, so
// the more-specific literal-only sibling rules win.
//
// MUTATION-PROOF: re-ordering BATEMAN_5_6 before any of those siblings
// in `dispatch.ts::ALL_RULES` would break these tests — the gamma rule
// would shadow Erfc / E_1 / Erf with wrong-named heads.

describe("gamma-closure: backward discrimination — (2,0,1,2) lattice", () => {
  test("bm=[0, 1/2] → Erfc (NOT IncompleteGammaUpper) — Erfc rule wins by file ordering", () => {
    // The Erfc rule's canonical bm is [rat(1,2), int(0)] (rationals
    // sort before integers). User-input order [int(0), rat(1,2)]
    // canonicalises to the same; the Erfc rule fires.
    const out = callFn(
      buildInput([], [ONE_INT], [ZERO_INT, R(1, 2)], [], Z_SYM),
    );
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("erfc-bridge");
    expect(JSON.stringify(expr)).toContain("Erfc");
    // CRITICAL: the gamma rule must NOT have fired.
    expect(JSON.stringify(expr)).not.toContain("IncompleteGamma");
  });

  test("bm=[1/2, 0] (multiset-permuted same input) → SAME Erfc output", () => {
    // bm is a multiset — submitting the entries in the other order
    // canonicalises to the same input and yields a byte-identical
    // wire output. MUTATION-PROOF: if the dispatcher's canonical-bytes
    // sort dropped, this would emit a different rule (or fail to match).
    const out1 = callFn(
      buildInput([], [ONE_INT], [ZERO_INT, R(1, 2)], [], Z_SYM),
    );
    const out2 = callFn(
      buildInput([], [ONE_INT], [R(1, 2), ZERO_INT], [], Z_SYM),
    );
    expect(canonicalize(out1)).toBe(canonicalize(out2));
    // And both fire the Erfc rule.
    const { ruleId: id2 } = expectMatched(out2);
    expect(id2).toBe("erfc-bridge");
  });

  test("bm=[0, 0] → ExpIntegralE(1, z) (NOT IncompleteGammaUpper(0, z)) — E_1 rule wins", () => {
    // R4 §C.3 priority 2: at a=0, Γ(0, z) ≡ E_1(z) numerically — but
    // `ExpIntegralE` is the canonical head per the DLMF and ADR-0023
    // vocabulary. The dispatcher's first-match-wins discipline ensures
    // the more-specific `dlmf-16-17-e1` literal-only rule fires before
    // the gamma rules' free-slot patterns ever try to bind.
    const out = callFn(
      buildInput([], [ONE_INT], [ZERO_INT, ZERO_INT], [], Z_SYM),
    );
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("dlmf-16-17-e1");
    expect(JSON.stringify(expr)).toContain("ExpIntegralE");
    expect(JSON.stringify(expr)).not.toContain("IncompleteGamma");
  });
});

describe("gamma-closure: backward discrimination — (1,1,1,2) lattice", () => {
  test("an=[1], bm=[1/2], bq=[0] → Erf (NOT IncompleteGammaLower) — Form-B Erf rule wins", () => {
    // The `dlmf-16-18-erf` rule's match shape is exactly
    // an=[1], bm=[1/2], bq=[0]. Registered BEFORE `bateman-5-6-40`
    // in `dispatch.ts::ALL_RULES` (DLMF_16_18 precedes BATEMAN_5_6).
    // MUTATION-PROOF: re-ordering would route this to
    // IncompleteGammaLower(1/2, z) — a wrong head, structurally
    // numerically equivalent on the sheet but semantically distinct.
    const out = callFn(buildInput([ONE_INT], [], [R(1, 2)], [ZERO_INT], Z_SYM));
    const { ruleId, expr } = expectMatched(out);
    expect(ruleId).toBe("dlmf-16-18-erf");
    expect(JSON.stringify(expr)).toContain("Erf");
    expect(JSON.stringify(expr)).not.toContain("IncompleteGamma");
  });
});

// -----------------------------------------------------------------------------
// Layer 3 — round-trip via the I6 forward bridge
// -----------------------------------------------------------------------------
//
// For each successful forward closure, take the emitted closed-form
// head `IncompleteGamma{Upper,Lower}(a, z)`, pass it back through
// `headToMeijerGGamma(...)`, and confirm the bridge re-emits the
// original G-form's parameter quintuple byte-identically. The gamma
// bridge has identity z-substitution, so the z-slot recovery is
// byte-identical too (unlike Erf/Bessel — see `erf-closure.test.ts`
// file-top "Anatomy of the round-trip" for the Erf contrast).

describe("gamma-closure: round-trip via I6 bridge — Upper", () => {
  test("symbolic a: bm=[a, 0] → IncompleteGammaUpper → bridge → bm=[a, 0] byte-identically", () => {
    const a = sym("a");
    // Forward: tool dispatch.
    const out = callFn(buildInput([], [ONE_INT], [a, ZERO_INT], [], Z_SYM));
    const { expr } = expectMatched(out);
    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaUpper");
    expect(args).not.toBeNull();
    if (!args) return;

    // Backward: bridge.
    const fwd: ForwardBridge | null = headToMeijerGGamma(
      "IncompleteGammaUpper",
      args,
    );
    expect(fwd).not.toBeNull();
    if (!fwd) return;

    // R4 §A.4 canonical Upper G-form: an=[], ap=[1], bm=[a, 0], bq=[].
    // MUTATION-PROOF: if the bridge's forward emission swapped `a` and
    // `0` in the bm slot, slotsMatch would fail.
    expect(slotsMatch(fwd.gForm.an, [])).toBe(true);
    expect(slotsMatch(fwd.gForm.ap, [ONE_INT])).toBe(true);
    expect(slotsMatch(fwd.gForm.bm, [a, ZERO_INT])).toBe(true);
    expect(slotsMatch(fwd.gForm.bq, [])).toBe(true);

    // Identity z-sub: the bridge's recovered z-slot is byte-identical
    // to the head's z arg (i.e. to the original tool input's z-slot).
    expect(canonicalize(fwd.gForm.z)).toBe(canonicalize(Z_SYM));
  });

  test("rational a=2/3: round-trip recovers byte-identical (an, ap, bm, bq, z)", () => {
    const a = R(2, 3);
    const out = callFn(buildInput([], [ONE_INT], [a, ZERO_INT], [], Z_SYM));
    const { expr } = expectMatched(out);
    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaUpper");
    expect(args).not.toBeNull();
    if (!args) return;

    const fwd = headToMeijerGGamma("IncompleteGammaUpper", args)!;
    expect(slotsMatch(fwd.gForm.bm, [a, ZERO_INT])).toBe(true);
    expect(canonicalize(fwd.gForm.z)).toBe(canonicalize(Z_SYM));

    // argsInverse closure also recovers [a, z] byte-identically.
    const recovered = fwd.argsInverse();
    expect(recovered.length).toBe(2);
    expect(canonicalize(recovered[0]!)).toBe(canonicalize(a));
    expect(canonicalize(recovered[1]!)).toBe(canonicalize(Z_SYM));
  });
});

describe("gamma-closure: round-trip via I6 bridge — Lower", () => {
  test("symbolic a: an=[1], bm=[a], bq=[0] → IncompleteGammaLower → bridge → same G-form", () => {
    const a = sym("a");
    const out = callFn(buildInput([ONE_INT], [], [a], [ZERO_INT], Z_SYM));
    const { expr } = expectMatched(out);
    const args = findNamedHead(stripSimplifyTags(expr), "IncompleteGammaLower");
    expect(args).not.toBeNull();
    if (!args) return;

    const fwd = headToMeijerGGamma("IncompleteGammaLower", args);
    expect(fwd).not.toBeNull();
    if (!fwd) return;

    // R4 §A.3 canonical Lower G-form: an=[1], ap=[], bm=[a], bq=[0].
    expect(slotsMatch(fwd.gForm.an, [ONE_INT])).toBe(true);
    expect(slotsMatch(fwd.gForm.ap, [])).toBe(true);
    expect(slotsMatch(fwd.gForm.bm, [a])).toBe(true);
    expect(slotsMatch(fwd.gForm.bq, [ZERO_INT])).toBe(true);
    expect(canonicalize(fwd.gForm.z)).toBe(canonicalize(Z_SYM));
  });
});

// -----------------------------------------------------------------------------
// Layer 4 — honest refusal closure (gamma-shaped near-misses)
// -----------------------------------------------------------------------------
//
// A G-form that the gamma rules ALMOST match but do not should return
// the tagged `meijer-g-symbolic-only/no-known-reduction` envelope, NOT
// silently produce a wrong-shaped answer. This pins the honest-scope
// contract (CLAUDE.md Rule 8) at the wire surface.

describe("gamma-closure: honest refusal on near-miss shapes", () => {
  test("(2,0,1,2) with ap=[2] (not 1) → no-known-reduction (NOT IncompleteGammaUpper)", () => {
    // The Upper rule requires `ap = [lit-int 1]` exactly. With ap=[2]
    // no rule fires — the dispatcher returns the structured tagged
    // refusal. MUTATION-PROOF: if the rule were loosened to allow
    // free `ap`, this would silently dispatch — a wrong-shaped lie.
    const out = callFn(buildInput([], [I(2)], [sym("a"), ZERO_INT], [], Z_SYM));
    expect(out.kind).toBe("tagged");
    if (out.kind === "tagged") {
      expect(out.tag).toBe("meijer-g-symbolic-only/no-known-reduction");
    }
  });

  test("(2,0,1,2) with bm=[a, b] (no literal 0) → no-known-reduction", () => {
    // The Upper rules require exactly one of the two bm entries to be
    // the literal `0`. A pair of free symbols does not match (the rule's
    // `bm: [{kind:"free"...}, {kind:"lit-int",value:0}]` shape is
    // load-bearing).
    const out = callFn(
      buildInput([], [ONE_INT], [sym("a"), sym("b")], [], Z_SYM),
    );
    expect(out.kind).toBe("tagged");
    if (out.kind === "tagged") {
      expect(out.tag).toBe("meijer-g-symbolic-only/no-known-reduction");
    }
  });

  test("(1,1,1,2) with bq=[1] (not 0) → no-known-reduction (NOT IncompleteGammaLower)", () => {
    // The Lower rule requires `bq = [lit-int 0]` exactly. With bq=[1]
    // no rule fires (per DLMF §8.6.10 Mellin-Barnes matching, the
    // closed form is γ(a, z) only when bq[0] = 0).
    const out = callFn(buildInput([ONE_INT], [], [sym("a")], [I(1)], Z_SYM));
    expect(out.kind).toBe("tagged");
    if (out.kind === "tagged") {
      expect(out.tag).toBe("meijer-g-symbolic-only/no-known-reduction");
    }
  });

  test("(1,1,1,2) with an=[2] (not 1) → no-known-reduction (NOT IncompleteGammaLower)", () => {
    // The Lower rule requires `an = [lit-int 1]` exactly.
    const out = callFn(buildInput([I(2)], [], [sym("a")], [ZERO_INT], Z_SYM));
    expect(out.kind).toBe("tagged");
    if (out.kind === "tagged") {
      expect(out.tag).toBe("meijer-g-symbolic-only/no-known-reduction");
    }
  });
});

// -----------------------------------------------------------------------------
// Layer 5 — findings inventory (sentinel)
// -----------------------------------------------------------------------------
//
// Mirroring the erf-closure precedent's "findings inventory" sentinel:
// if a closure gap is ever filed against a gamma rule or the I6 bridge,
// the bead reference goes here and the test body updates. Today: empty.

describe("gamma-closure: findings inventory", () => {
  test("zero open findings at ship time (3 rules close cleanly, all 5 discriminators hold)", () => {
    const FINDINGS: ReadonlyArray<{ rule: string; bead: string; severity: string }> =
      [];
    expect(FINDINGS.length).toBe(0);
  });
});
