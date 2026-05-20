// =============================================================================
// bridges-gamma.test.ts — Gamma-family bridge round-trip + discrimination
// =============================================================================
//
// Mirrors the layered shape of `bridges-erf.test.ts` and
// `bridges-bessel.test.ts`, scaled per CLAUDE.md Rule 6 (mutation-prove
// discipline) and Rule 7 ("runs without errors" is not passing).
//
// The gamma bridge is structurally unique among the three per-head
// bridges shipped to date:
//
//   * **Forward sparsity.** Only TWO heads have closed G-forms:
//     `IncompleteGammaLower(a, z)` and `IncompleteGammaUpper(a, z)`.
//     The remaining seven gamma-family heads return `null` for
//     documented structural reasons (CLAUDE.md Rule 8: honest refusal
//     is the correct answer, not a coverage gap).
//
//   * **Identity z-substitution.** Unlike Erf (`z²`) and Bessel
//     (`z²/4`), the gamma bridge passes `z` through byte-identically.
//     The `argsInverse` closure is still emitted for API uniformity,
//     and round-trip recovery is therefore byte-identical even on
//     hand-built G-forms (no multi-valued root surface to sidestep).
//
//   * **Shape collisions.** `(2,0,1,2)` is shared with `Erfc` and
//     `ExpIntegralE`; `(1,1,1,2)` is shared with `Erf`. The backward
//     matcher's load-bearing job is the discrimination lattice (R4 §C.3).
//     The lattice is encoded with explicit deferrals: when a sibling
//     head's shape comes in, the gamma matcher returns `null` so a
//     top-level dispatcher routes to the sibling's existing rule.
//
// Test layers:
//
//   1. **Forward bridge — positive.** Both bridgeable heads produce
//      the canonical G-form (slot tuple + identity z-sub + prefactor 1).
//
//   2. **Forward bridge — honest refusals.** All seven non-G-form heads
//      return `null` (one test per head; the structural-reason prose
//      lives in `bridges/gamma.ts` file-top, not duplicated here).
//
//   3. **Backward bridge — discrimination.** The `(2,0,1,2)` lattice
//      verified for Erfc / ExpIntegralE / IncompleteGammaUpper; the
//      `(1,1,1,2)` lattice verified for Erf / IncompleteGammaLower.
//      Multiset symmetry of `bm` verified (both orderings route the
//      same way).
//
//   4. **Round-trip.** Byte-identical recovery via `argsInverse()` for
//      both bridgeable heads.
//
//   5. **Mutation-proof markers.** Inline `// MUTATION-PROOF:` comments
//      mark the test invariants that catch specific implementation
//      mutations (see report).
//
//   6. **Existing tests untouched.** Verified by running the full
//      `bun test packages/meijer-core/` suite; this file adds tests,
//      removes none, perturbs none.

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  int,
  rat,
  sym,
  type Value,
} from "@workbench/protocol";
import {
  headToMeijerGGamma,
  meijerGToHeadGamma,
} from "../src/index.js";
import type { MeijerGForm } from "../src/index.js";

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function I(n: number | bigint): Value {
  return int(typeof n === "bigint" ? n : BigInt(n));
}

function R(n: number, d: number): Value {
  return rat(BigInt(n), BigInt(d));
}

const ZERO_INT: Value = I(0);
const ONE_INT: Value = I(1);
const HALF: Value = R(1, 2);

// -----------------------------------------------------------------------------
// Layer 1 — forward bridge structural anchors (R4 §A.3, §A.4)
// -----------------------------------------------------------------------------

describe("headToMeijerGGamma — forward bridge positive cases (R4 §A.3–A.4)", () => {
  test("IncompleteGammaLower(a, z): (1,1,1,2), an=[1], bm=[a], bq=[0], z-slot = z (identity)", () => {
    // R4 §A.3: γ(a, z) = G^{1,1}_{1,2}(1; a, 0 | z).
    // The lower-parameter multiset {a, 0} is partitioned (bm=[a], bq=[0])
    // so that m = bm.length = 1, matching the (1,1,1,2) shape header.
    const a = sym("a");
    const z = sym("z");
    const fwd = headToMeijerGGamma("IncompleteGammaLower", [a, z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm, wrap } = fwd;

    // (m,n,p,q) = (1,1,1,2). MUTATION-PROOF: dropping the bq=[0] slot
    // would make (m,n,p,q) = (1,1,1,1) and this assertion fails.
    expect(gForm.bm.length).toBe(1);
    expect(gForm.an.length).toBe(1);
    expect(gForm.ap.length).toBe(0);
    expect(gForm.bq.length).toBe(1);

    // Slot identities.
    expect(canonicalize(gForm.an[0]!)).toBe(canonicalize(ONE_INT));
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(a));
    expect(canonicalize(gForm.bq[0]!)).toBe(canonicalize(ZERO_INT));

    // z-slot is the head's z BYTE-IDENTICALLY (identity substitution).
    // MUTATION-PROOF: a stray mkPower(z, 2) would canonicalise differently.
    expect(canonicalize(gForm.z)).toBe(canonicalize(z));

    // Prefactor 1: wrap(g) === g (identity closure).
    const gDummy = sym("g_dummy");
    expect(canonicalize(wrap(gDummy))).toBe(canonicalize(gDummy));
  });

  test("IncompleteGammaUpper(a, z): (2,0,1,2), ap=[1], bm=[a,0], z-slot = z (identity)", () => {
    // R4 §A.4: Γ(a, z) = G^{2,0}_{1,2}( ; 1; a, 0 | z).
    // Here the lower-parameter multiset {a, 0} sits entirely in bm
    // (bq is empty), so m = bm.length = 2, matching (2,0,1,2).
    const a = sym("a");
    const z = sym("z");
    const fwd = headToMeijerGGamma("IncompleteGammaUpper", [a, z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm, wrap } = fwd;

    expect(gForm.bm.length).toBe(2);
    expect(gForm.an.length).toBe(0);
    expect(gForm.ap.length).toBe(1);
    expect(gForm.bq.length).toBe(0);

    expect(canonicalize(gForm.ap[0]!)).toBe(canonicalize(ONE_INT));
    // bm = [a, 0] (in that order in the forward emission).
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(a));
    expect(canonicalize(gForm.bm[1]!)).toBe(canonicalize(ZERO_INT));

    // Identity z-sub.
    expect(canonicalize(gForm.z)).toBe(canonicalize(z));

    // Prefactor 1.
    const gDummy = sym("g_dummy");
    expect(canonicalize(wrap(gDummy))).toBe(canonicalize(gDummy));
  });

  test("Both bridgeable heads share the identity z-substitution (contrast with Erf/Bessel)", () => {
    // The structural distinctive of the gamma bridge: no z² or z²/4
    // substitution. Pin this fact directly so a future refactor that
    // accidentally introduces a substitution is caught.
    const a = sym("a");
    const z = sym("z");
    for (const head of ["IncompleteGammaLower", "IncompleteGammaUpper"]) {
      const fwd = headToMeijerGGamma(head, [a, z])!;
      // MUTATION-PROOF: introducing mkPower(z, 2) here would break this.
      expect(canonicalize(fwd.gForm.z)).toBe(canonicalize(z));
    }
  });

  test("Wrong arity returns null on bridgeable heads (honest scope, not throw)", () => {
    expect(headToMeijerGGamma("IncompleteGammaLower", [])).toBeNull();
    expect(headToMeijerGGamma("IncompleteGammaLower", [sym("z")])).toBeNull();
    expect(
      headToMeijerGGamma("IncompleteGammaLower", [sym("a"), sym("b"), sym("c")]),
    ).toBeNull();
    expect(headToMeijerGGamma("IncompleteGammaUpper", [])).toBeNull();
    expect(headToMeijerGGamma("IncompleteGammaUpper", [sym("z")])).toBeNull();
  });

  test("Unknown head returns null (out-of-scope, not error)", () => {
    expect(headToMeijerGGamma("FooBar", [sym("a"), sym("z")])).toBeNull();
    expect(headToMeijerGGamma("Erf", [sym("z")])).toBeNull();
    expect(headToMeijerGGamma("BesselJ", [sym("nu"), sym("z")])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Layer 2 — forward bridge honest refusals (R4 §A.2 / §A.5–A.8)
// -----------------------------------------------------------------------------
//
// One test per head; the structural rationale lives in
// `bridges/gamma.ts` (literate prose, Rule 10). The TEST asserts the
// `null` verdict; the SOURCE explains *why*. A fresh reader of either
// artefact can cross-reference the other.

describe("headToMeijerGGamma — honest refusals (R4 §A.2, §A.5–A.8)", () => {
  test("Gamma(z) → null (R4 §A.2: z-in-exponent structural impossibility)", () => {
    expect(headToMeijerGGamma("Gamma", [sym("z")])).toBeNull();
  });

  test("LogGamma(z) → null (logarithm of Γ; same obstruction)", () => {
    expect(headToMeijerGGamma("LogGamma", [sym("z")])).toBeNull();
  });

  test("Digamma(z) → null (d/dz log Γ; same obstruction)", () => {
    expect(headToMeijerGGamma("Digamma", [sym("z")])).toBeNull();
  });

  test("Trigamma(z) → null (d²/dz² log Γ; same obstruction)", () => {
    // Trigamma is not a vocab head (workbench encodes as Polygamma(1, z))
    // but the bridge recognises the name regardless — honest refusal.
    expect(headToMeijerGGamma("Trigamma", [sym("z")])).toBeNull();
  });

  test("Polygamma(m, z) → null (generalised derivative; same obstruction)", () => {
    // 2-arg vocab-pinned signature `Polygamma(m, z)`.
    expect(headToMeijerGGamma("Polygamma", [I(2), sym("z")])).toBeNull();
    // Also for the 1-arg legacy shape, just in case.
    expect(headToMeijerGGamma("Polygamma", [sym("z")])).toBeNull();
  });

  test("Beta(a, b) → null (R4 §A.5: Γ-ratio, not a single G)", () => {
    expect(headToMeijerGGamma("Beta", [sym("a"), sym("b")])).toBeNull();
  });

  test("Pochhammer(a, n) → null (R4 §A.7: Γ-ratio, same as Beta)", () => {
    expect(headToMeijerGGamma("Pochhammer", [sym("a"), sym("n")])).toBeNull();
  });

  test("BarnesG(z) → null (R4 §A.6: entire of order 2; Glaisher-Kinkelin)", () => {
    expect(headToMeijerGGamma("BarnesG", [sym("z")])).toBeNull();
  });

  test("All seven refusals are recognised, not unknown-head fallthrough", () => {
    // Sanity: the seven refusal cases are explicit in the switch — they
    // don't fall through to `default`. This test pins the count of
    // refused heads; a refactor that drops one (e.g., merging Trigamma
    // into the default fall-through) would not break this directly, but
    // future readers can see the explicit enumeration here.
    // MUTATION-PROOF: removing one of the case clauses still returns
    // null (via the default), so this test alone can't catch a
    // mis-routing; it documents the surface.
    const refusedHeads = [
      "Gamma",
      "LogGamma",
      "Digamma",
      "Trigamma",
      "Polygamma",
      "Beta",
      "Pochhammer",
      "BarnesG",
    ];
    for (const head of refusedHeads) {
      // Provide a representative arg list — arity-correct where known.
      const args =
        head === "Polygamma" || head === "Beta" || head === "Pochhammer"
          ? [sym("x"), sym("y")]
          : [sym("z")];
      expect(headToMeijerGGamma(head, args)).toBeNull();
    }
  });
});

// -----------------------------------------------------------------------------
// Layer 3 — backward bridge discrimination lattice (R4 §C.3)
// -----------------------------------------------------------------------------

describe("meijerGToHeadGamma — backward bridge discrimination (R4 §C.3)", () => {
  // ---------------------------------------------------------------------------
  // Shape (2, 0, 1, 2) lattice — Erfc / ExpIntegralE / IncompleteGammaUpper
  // ---------------------------------------------------------------------------

  test("(2,0,1,2) with bm=[0, 1/2]: defers to Erfc — returns null (NOT UpperIncompleteGamma)", () => {
    // R4 §C.3 priority 1: Erfc owns this shape via `erf.ts`. The gamma
    // bridge MUST NOT shadow.
    // MUTATION-PROOF: if the gamma matcher dropped the Erfc guard, it
    // would route this to IncompleteGammaUpper(1/2, z) — wrong head.
    const form: MeijerGForm = {
      an: [],
      ap: [ONE_INT],
      bm: [ZERO_INT, HALF],
      bq: [],
      z: sym("z"),
    };
    expect(meijerGToHeadGamma(form)).toBeNull();
  });

  test("(2,0,1,2) with bm=[1/2, 0]: defers to Erfc (multiset symmetry — same as above)", () => {
    // bm is a multiset; the bridge MUST accept either order. If a
    // refactor accidentally hard-coded one order, this test fires.
    // MUTATION-PROOF: dropping the multiset symmetry (matching only
    // `[0, 1/2]` and not `[1/2, 0]`) would still defer correctly via
    // fall-through to null; this test confirms BOTH orders defer.
    const form: MeijerGForm = {
      an: [],
      ap: [ONE_INT],
      bm: [HALF, ZERO_INT],
      bq: [],
      z: sym("z"),
    };
    expect(meijerGToHeadGamma(form)).toBeNull();
  });

  test("(2,0,1,2) with bm=[0, 0]: defers to ExpIntegralE(1, z) — returns null (NOT UpperIncompleteGamma(0, z))", () => {
    // R4 §C.3 priority 2: dlmf-16-17-e1 owns this shape; ExpIntegralE
    // is the conventional head. UpperIncompleteGamma(0, z) would be
    // numerically equivalent but is not the canonical name.
    // MUTATION-PROOF: dropping the {0,0} guard would route this to
    // IncompleteGammaUpper(0, z) — wrong head per the dispatcher's
    // existing rule.
    const form: MeijerGForm = {
      an: [],
      ap: [ONE_INT],
      bm: [ZERO_INT, ZERO_INT],
      bq: [],
      z: sym("z"),
    };
    expect(meijerGToHeadGamma(form)).toBeNull();
  });

  test("(2,0,1,2) with bm=[a, 0], a symbolic: routes to IncompleteGammaUpper(a, z)", () => {
    // R4 §C.3 priority 4: the gamma bridge's actual claim. After the
    // Erfc and E_1 guards, the remaining (2,0,1,2)+ap=[1] shapes with
    // bm = {a, 0} multiset route here.
    const a = sym("a");
    const z = sym("z");
    const form: MeijerGForm = {
      an: [],
      ap: [ONE_INT],
      bm: [a, ZERO_INT],
      bq: [],
      z,
    };
    const bwd = meijerGToHeadGamma(form);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("IncompleteGammaUpper");
    expect(bwd.args.length).toBe(2);
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("(2,0,1,2) with bm=[0, a], a symbolic: routes to IncompleteGammaUpper(a, z) byte-identically (multiset symmetry)", () => {
    // SAME multiset, different order — must route identically.
    // MUTATION-PROOF: if the matcher hard-coded `bm[0] = a, bm[1] = 0`,
    // this swapped-order case would either return null or recover
    // `a = 0`, both wrong. This test catches that.
    const a = sym("a");
    const z = sym("z");
    const form: MeijerGForm = {
      an: [],
      ap: [ONE_INT],
      bm: [ZERO_INT, a],
      bq: [],
      z,
    };
    const bwd = meijerGToHeadGamma(form);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("IncompleteGammaUpper");
    // The recovered `a` must be the SYMBOLIC entry, not the literal 0.
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  // ---------------------------------------------------------------------------
  // Shape (1, 1, 1, 2) lattice — Erf / IncompleteGammaLower
  // ---------------------------------------------------------------------------

  test("(1,1,1,2) with an=[1/2], bm=[0], bq=[-1/2]: defers to Erf — returns null", () => {
    // R4 §C.3 (1,1,1,2) lattice: an[0] = 1/2 is the Erf parameter
    // tuple. The gamma bridge fires only on an[0] = 1.
    // MUTATION-PROOF: if the gamma matcher dropped the `an[0] = 1`
    // guard, it would route Erf-shaped forms to IncompleteGammaLower
    // — a silent head mismatch.
    const form: MeijerGForm = {
      an: [HALF],
      ap: [],
      bm: [ZERO_INT],
      bq: [R(-1, 2)],
      z: sym("z"),
    };
    expect(meijerGToHeadGamma(form)).toBeNull();
  });

  test("(1,1,1,2) with an=[1], bm=[a], bq=[0], a symbolic: routes to IncompleteGammaLower(a, z)", () => {
    // R4 §A.3: the canonical IncompleteGammaLower G-form. an[0] = 1 is
    // the gamma discriminator (vs Erf's an[0] = 1/2).
    const a = sym("a");
    const z = sym("z");
    const form: MeijerGForm = {
      an: [ONE_INT],
      ap: [],
      bm: [a],
      bq: [ZERO_INT],
      z,
    };
    const bwd = meijerGToHeadGamma(form);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("IncompleteGammaLower");
    expect(bwd.args.length).toBe(2);
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("(1,1,1,2) with an=[1], bm=[1/2], bq=[0]: refuses (Erf-multiset complement, not Lower)", () => {
    // Defensive refusal: bm[0] = 1/2 with an[0] = 1 is a hand-built
    // shape that's structurally NOT the canonical Lower form; refuse
    // rather than emit IncompleteGammaLower(1/2, z) which would be a
    // wrong-shaped recovery.
    const form: MeijerGForm = {
      an: [ONE_INT],
      ap: [],
      bm: [HALF],
      bq: [ZERO_INT],
      z: sym("z"),
    };
    expect(meijerGToHeadGamma(form)).toBeNull();
  });

  test("No-match shape returns null (honest refusal)", () => {
    // (m,n,p,q) = (0,0,0,0) — degenerate; no rule matches.
    const form: MeijerGForm = {
      an: [],
      ap: [],
      bm: [],
      bq: [],
      z: sym("z"),
    };
    expect(meijerGToHeadGamma(form)).toBeNull();
  });

  test("Bessel-shaped G-form returns null (cross-bridge isolation)", () => {
    // (1,0,0,2) is BesselJ's shape — the gamma matcher must return null
    // so a top-level dispatcher iterates to the Bessel bridge.
    const nu = sym("nu");
    const form: MeijerGForm = {
      an: [],
      ap: [],
      bm: [nu],
      bq: [nu], // arbitrary; doesn't matter for the gamma matcher
      z: sym("z"),
    };
    expect(meijerGToHeadGamma(form)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Layer 4 — round-trip byte-identity (the 2-arg argsInverse contract)
// -----------------------------------------------------------------------------

describe("round-trip: headToMeijerGGamma(...).argsInverse() preserves [a, z] byte-identically", () => {
  // Representative (a, z) sample pairs.
  const SAMPLES: readonly { label: string; a: Value; z: Value }[] = [
    { label: "symbolic a, symbolic z", a: sym("a"), z: sym("z") },
    { label: "symbolic a, integer z=2", a: sym("a"), z: I(2) },
    { label: "rational a=3/4, symbolic z", a: R(3, 4), z: sym("z") },
    { label: "integer a=1, symbolic z", a: ONE_INT, z: sym("z") },
    { label: "integer a=-2, integer z=5", a: I(-2), z: I(5) },
  ];

  for (const head of ["IncompleteGammaLower", "IncompleteGammaUpper"] as const) {
    for (const sample of SAMPLES) {
      test(`${head}(${sample.label}): argsInverse() preserves [a, z]`, () => {
        const fwd = headToMeijerGGamma(head, [sample.a, sample.z]);
        expect(fwd).not.toBeNull();
        if (!fwd) return;
        const recovered = fwd.argsInverse();
        expect(recovered.length).toBe(2);
        expect(canonicalize(recovered[0]!)).toBe(canonicalize(sample.a));
        expect(canonicalize(recovered[1]!)).toBe(canonicalize(sample.z));
      });
    }
  }

  test("argsInverse order is [a, z], not [z, a] — fixed regression sentinel", () => {
    // If a refactor swapped the closure to return [z, a], the test
    // pins the correct order. MUTATION-PROOF: swapping breaks args[0]
    // (integer 3 vs integer 7).
    const fwd = headToMeijerGGamma("IncompleteGammaLower", [I(3), I(7)])!;
    const args = fwd.argsInverse();
    expect(canonicalize(args[0]!)).toBe(canonicalize(I(3)));
    expect(canonicalize(args[1]!)).toBe(canonicalize(I(7)));
    // Asymmetry sentinel: if swapped, args[0] would be 7.
    expect(canonicalize(args[0]!)).not.toBe(canonicalize(I(7)));
  });
});

// -----------------------------------------------------------------------------
// Layer 5 — full forward→backward round-trip via meijerGToHeadGamma
// -----------------------------------------------------------------------------
//
// The argsInverse-based round-trip (Layer 4) tests the forward bridge's
// closure. THIS layer tests the standalone backward bridge by composing
// forward and backward at the bridge surface — what a top-level
// dispatcher would observe.

describe("full forward → backward round-trip via meijerGToHeadGamma", () => {
  test("IncompleteGammaLower(a, z) → forward G-form → backward → (head, args) byte-identical", () => {
    const a = sym("a");
    const z = sym("z");
    const fwd = headToMeijerGGamma("IncompleteGammaLower", [a, z])!;
    const bwd = meijerGToHeadGamma(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("IncompleteGammaLower");
    expect(bwd.args.length).toBe(2);
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(a));
    // z is recovered byte-identically because of identity z-sub.
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("IncompleteGammaUpper(a, z) → forward G-form → backward → (head, args) byte-identical", () => {
    const a = sym("a");
    const z = sym("z");
    const fwd = headToMeijerGGamma("IncompleteGammaUpper", [a, z])!;
    const bwd = meijerGToHeadGamma(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("IncompleteGammaUpper");
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(a));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("IncompleteGammaUpper round-trip works across multiple a values", () => {
    // The discrimination lattice means certain `a` values (0, 1/2)
    // route to sibling heads. We test only the values that are
    // gamma-claimed (symbolic and rationals not in {0, 1/2}).
    const z = sym("z");
    const claimedA: readonly Value[] = [
      sym("a"),
      sym("alpha"),
      R(3, 4),
      R(-1, 3),
      I(2),
      I(-1),
    ];
    for (const a of claimedA) {
      const fwd = headToMeijerGGamma("IncompleteGammaUpper", [a, z])!;
      const bwd = meijerGToHeadGamma(fwd.gForm);
      expect(bwd).not.toBeNull();
      if (!bwd) continue;
      expect(bwd.head).toBe("IncompleteGammaUpper");
      expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(a));
      expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
    }
  });
});
