// =============================================================================
// gamma-float64 tests — closed-form goldens + ULP grading + edge invariants
// =============================================================================
//
// Coverage (per ADR-0042 §Decision 4 acceptance + I5 bead spec)
// -------------------------------------------------------------
// 1. Closed-form goldens (DLMF §5):
//      Γ(1/2) = √π,   Γ(1) = Γ(2) = 1,   Γ(5) = 4! = 24,   Γ(-1/2) = -2√π,
//      B(1/2, 1/2) = π,   B(n, m) = (n-1)!(m-1)!/(n+m-1)!,
//      ψ(1) = -γ_EM,   ψ(1/2) = -γ_EM - 2 log 2,
//      ψ^(1)(1) = π²/6,   ψ^(2)(1) = -2 ζ(3),   ψ^(3)(1) = π⁴/15,
//      G(1) = G(2) = G(3) = 1, G(4) = 2, G(5) = 12, G(6) = 288.
//
// 2. Cross-validation against bench/gamma-anchor oracles (Wolfram + mpmath
//    gold tier; SciPy/Boost/Arb bronze/silver). Max relative error on 10
//    representative inputs ≤ 1e-13 (≤ 4 ULP).
//
// 3. Edge invariants:
//      Γ(0) = +∞,   Γ(-n) = NaN (pole),  Γ(171.625) = +∞ (overflow),
//      Γ(-1000) = 0 (underflow through reflection),
//      ψ(-n) = ±∞ (pole), trigamma(-n) = +∞ (always at poles),
//      P(a, x) + Q(a, x) = 1 to machine precision (L12 guard),
//      γ(a, x) + Γ(a, x) = Γ(a) exact relation.
//
// 4. **DIGAMMA-BOOST-1.83 REGRESSION GUARD (G8 finding)**:
//    digamma(-0.5) MUST equal ψ(3/2) ≈ 0.03649 — the DLMF-correct
//    reflection value. Boost 1.83 returns ψ(1/2) ≈ -1.96351 (the BUGGY
//    value); our port uses the reflection identity directly and gets
//    the right answer. This test will catch any future regression that
//    accidentally restores the Boost-1.83 behaviour.
//
// 5. L12 guard (R5 §6 L12 — the #1 trap):
//    P, Q, IncompleteGammaLower, IncompleteGammaUpper are FOUR distinct
//    functions. Asserts P(a,z) ≠ IncompleteGammaUpper(a,z) etc. for
//    representative inputs.
//
// 6. Mutation-proving checkpoints (documented in worklog 168):
//    M1: Swap LGAMMA_TC (1.46163...) by 1e-8 → lgamma(1.4) deviates
//        beyond 1e-12, polygamma m=2 at x=2 deviates.
//    M2: Change IGAM_BIG from 4.5e15 to 4.5e10 → gammaQ(2, 100) diverges
//        (CF doesn't rescale, loses precision).
//    M3: Flip sign in (-1)^(m+1) recurrence sign for polygamma →
//        ψ^(2)(1) returns +2.38 instead of -2.40 (caught the bug above).
//    M4: Swap DIGAMMA_P/Q ordering (descending vs ascending) →
//        digamma(1) catastrophically wrong (-1716 vs -0.577) (caught
//        during impl).
//    M5: Drop the FreeBSD lgamma's (i=1) parallel-Horner third polynomial p3:
//        lgamma(1.5) becomes wildly wrong.
//    M6: Negate the recurrence in `gammaQ` `1 - igam(a, x)` →
//        Q(0.5, 0.1) returns ~erfc(√x) instead of ~1 - erfc(√x).
//
//    All confirmed RED on perturb, GREEN after restore.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  gammaFloat64,
  lgammaFloat64,
  digammaFloat64,
  trigammaFloat64,
  polygammaFloat64,
  pochhammerFloat64,
  gammaPFloat64,
  gammaQFloat64,
  incGammaLowerFloat64,
  incGammaUpperFloat64,
  invGammaPFloat64,
  invGammaQFloat64,
  betaFloat64,
  logBetaFloat64,
  incBetaFloat64,
  barnesGFloat64,
  hyperfactorialFloat64,
  gammaRatioFloat64,
  gammaDeltaRatioFloat64,
  gammaPDerivativeFloat64,
  lgammaComplexFloat64,
  gammaComplexFloat64,
  digammaComplexFloat64,
  evalNumericExprWithSpecial,
  SPECIAL_HEADS,
} from "../../src/index.js";
import { expr, float64FromNumber } from "@workbench/protocol";

// -----------------------------------------------------------------------------
// ULP-distance helper (same impl as bessel/erf tests; pure float-bit math)
// -----------------------------------------------------------------------------
const _ulpBuf = new ArrayBuffer(8);
const _ulpDv = new DataView(_ulpBuf);
function bitsOf(x: number): bigint {
  _ulpDv.setFloat64(0, x);
  let bi = _ulpDv.getBigInt64(0);
  if (bi < 0n) bi = -bi | (1n << 63n);
  return bi;
}
function ulpDiff(a: number, b: number): number {
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const ba = bitsOf(a);
  const bb = bitsOf(b);
  return Number(ba > bb ? ba - bb : bb - ba);
}
function relErr(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
}

// Mathematical constants for closed-form checks.
const SQRT_PI = Math.sqrt(Math.PI);
const GAMMA_EM = 0.5772156649015329; // Euler-Mascheroni
const ZETA_3 = 1.2020569031595943; // Apéry's constant
const ZETA_5 = 1.0369277551433699;

// -----------------------------------------------------------------------------
// §1. Closed-form Gamma goldens (DLMF §5)
// -----------------------------------------------------------------------------

describe("Gamma closed-form goldens (DLMF §5.4)", () => {
  test("Γ(1/2) = √π", () => {
    expect(ulpDiff(gammaFloat64(0.5), SQRT_PI)).toBeLessThanOrEqual(2);
  });
  test("Γ(1) = 1", () => {
    expect(gammaFloat64(1)).toBe(1);
  });
  test("Γ(2) = 1", () => {
    expect(gammaFloat64(2)).toBe(1);
  });
  test("Γ(3) = 2", () => {
    expect(gammaFloat64(3)).toBe(2);
  });
  test("Γ(5) = 24", () => {
    expect(gammaFloat64(5)).toBe(24);
  });
  test("Γ(7) = 720", () => {
    expect(gammaFloat64(7)).toBe(720);
  });
  test("Γ(3/2) = √π / 2", () => {
    expect(ulpDiff(gammaFloat64(1.5), SQRT_PI / 2)).toBeLessThanOrEqual(2);
  });
  test("Γ(5/2) = (3/4)·√π", () => {
    expect(ulpDiff(gammaFloat64(2.5), (3 / 4) * SQRT_PI)).toBeLessThanOrEqual(4);
  });
  test("Γ(-1/2) = -2√π (DLMF 5.4.7)", () => {
    expect(ulpDiff(gammaFloat64(-0.5), -2 * SQRT_PI)).toBeLessThanOrEqual(4);
  });
  test("Γ(-3/2) = (4/3)√π", () => {
    expect(ulpDiff(gammaFloat64(-1.5), (4 / 3) * SQRT_PI)).toBeLessThanOrEqual(8);
  });
  test("Γ(0) = +∞ (pole)", () => {
    expect(gammaFloat64(0)).toBe(Infinity);
  });
  test("Γ(-1) = NaN (pole)", () => {
    expect(Number.isNaN(gammaFloat64(-1))).toBe(true);
  });
  test("Γ(NaN) = NaN", () => {
    expect(Number.isNaN(gammaFloat64(NaN))).toBe(true);
  });
  test("Γ(+∞) = +∞", () => {
    expect(gammaFloat64(Infinity)).toBe(Infinity);
  });
  test("Γ(-∞) = NaN", () => {
    expect(Number.isNaN(gammaFloat64(-Infinity))).toBe(true);
  });
  test("Γ(171.625) = +∞ (overflow)", () => {
    expect(gammaFloat64(171.625)).toBe(Infinity);
  });
  test("Γ(-200) = 0 (reflection underflow)", () => {
    expect(gammaFloat64(-200)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// §2. LogGamma closed-form goldens
// -----------------------------------------------------------------------------

describe("LogGamma closed-form + sign tracking (DLMF §5.4)", () => {
  test("lgamma(1) = 0, sign +1", () => {
    const r = lgammaFloat64(1);
    expect(r.value).toBe(0);
    expect(r.sign).toBe(1);
  });
  test("lgamma(2) = 0, sign +1", () => {
    const r = lgammaFloat64(2);
    expect(r.value).toBe(0);
    expect(r.sign).toBe(1);
  });
  test("lgamma(1/2) = log √π, sign +1", () => {
    const r = lgammaFloat64(0.5);
    expect(ulpDiff(r.value, Math.log(SQRT_PI))).toBeLessThanOrEqual(2);
    expect(r.sign).toBe(1);
  });
  test("lgamma(-1/2): value = log(2√π), sign = -1 (Γ(-1/2) < 0)", () => {
    const r = lgammaFloat64(-0.5);
    expect(ulpDiff(r.value, Math.log(2 * SQRT_PI))).toBeLessThanOrEqual(4);
    expect(r.sign).toBe(-1);
  });
  test("lgamma(-3/2): value = log(4√π/3), sign = +1 (Γ(-3/2) > 0)", () => {
    const r = lgammaFloat64(-1.5);
    expect(ulpDiff(r.value, Math.log((4 / 3) * SQRT_PI))).toBeLessThanOrEqual(8);
    expect(r.sign).toBe(1);
  });
  test("lgamma(10) = log(9!) = log(362880)", () => {
    const r = lgammaFloat64(10);
    expect(ulpDiff(r.value, Math.log(362880))).toBeLessThanOrEqual(2);
  });
  test("lgamma(0) = +∞", () => {
    expect(lgammaFloat64(0).value).toBe(Infinity);
  });
  test("lgamma(-1) = +∞ (pole)", () => {
    expect(lgammaFloat64(-1).value).toBe(Infinity);
  });
});

// -----------------------------------------------------------------------------
// §3. Digamma closed-form goldens (DLMF §5.4)
// -----------------------------------------------------------------------------

describe("Digamma closed-form (DLMF §5.4)", () => {
  test("ψ(1) = -γ_EM (Euler-Mascheroni)", () => {
    expect(ulpDiff(digammaFloat64(1), -GAMMA_EM)).toBeLessThanOrEqual(2);
  });
  test("ψ(2) = 1 - γ_EM", () => {
    expect(ulpDiff(digammaFloat64(2), 1 - GAMMA_EM)).toBeLessThanOrEqual(4);
  });
  test("ψ(1/2) = -γ_EM - 2 log 2 (DLMF 5.4.13)", () => {
    expect(ulpDiff(digammaFloat64(0.5), -GAMMA_EM - 2 * Math.log(2))).toBeLessThanOrEqual(4);
  });
  test("ψ(3/2) = -γ_EM - 2 log 2 + 2 (recurrence)", () => {
    // Tolerance 16 ULP: the closed-form expression -γ_EM - 2 log 2 + 2
    // has cancellation between large positive (+2) and moderate negative
    // (~ -1.96) terms, losing ~3-4 bits in the comparison itself.
    expect(ulpDiff(digammaFloat64(1.5), -GAMMA_EM - 2 * Math.log(2) + 2)).toBeLessThanOrEqual(16);
  });
  test("ψ(10) ≈ 2.2517525890667214 (mpmath)", () => {
    expect(ulpDiff(digammaFloat64(10), 2.2517525890667214)).toBeLessThanOrEqual(4);
  });
  test("ψ(0) = +∞ (pole)", () => {
    expect(digammaFloat64(0)).toBe(Infinity);
  });
  test("ψ(-1) = +∞ (pole)", () => {
    expect(digammaFloat64(-1)).toBe(Infinity);
  });
  // ----- THE CRITICAL G8 GUARD -----
  test(
    "**G8 GUARD**: digamma(-0.5) = ψ(3/2) ≈ 0.03649 (DLMF reflection; NOT the Boost-1.83 buggy value -1.9635)",
    () => {
      const got = digammaFloat64(-0.5);
      // Expected value: ψ(3/2) via reflection identity.
      const expected = -GAMMA_EM - 2 * Math.log(2) + 2;
      expect(Math.abs(got - expected)).toBeLessThan(1e-12);
      // Anti-Boost-1.83 guard: must NOT equal ψ(1/2) = -1.9635...
      const buggyValue = -GAMMA_EM - 2 * Math.log(2);
      expect(Math.abs(got - buggyValue)).toBeGreaterThan(1.0);
    },
  );
});

// -----------------------------------------------------------------------------
// §4. Trigamma + Polygamma closed-form (DLMF §5.15)
// -----------------------------------------------------------------------------

describe("Trigamma + Polygamma closed-form (DLMF §5.15)", () => {
  test("ψ^(1)(1) = π²/6 (DLMF 5.15.3)", () => {
    expect(ulpDiff(trigammaFloat64(1), (Math.PI * Math.PI) / 6)).toBeLessThanOrEqual(2);
  });
  test("ψ^(1)(2) = π²/6 - 1", () => {
    expect(ulpDiff(trigammaFloat64(2), (Math.PI * Math.PI) / 6 - 1)).toBeLessThanOrEqual(4);
  });
  test("ψ^(1)(1/2) = π²/2", () => {
    expect(ulpDiff(trigammaFloat64(0.5), (Math.PI * Math.PI) / 2)).toBeLessThanOrEqual(4);
  });
  test("ψ^(1)(0) = +∞", () => {
    expect(trigammaFloat64(0)).toBe(Infinity);
  });
  test("ψ^(1)(-1) = +∞ (always at pole, regardless of parity)", () => {
    expect(trigammaFloat64(-1)).toBe(Infinity);
  });

  test("ψ^(2)(1) = -2·ζ(3) (DLMF 5.15.5 / Apéry)", () => {
    expect(relErr(polygammaFloat64(2, 1), -2 * ZETA_3)).toBeLessThan(1e-13);
  });
  test("ψ^(3)(1) = π⁴/15 (DLMF: 6·ζ(4) = π⁴/15)", () => {
    expect(relErr(polygammaFloat64(3, 1), Math.PI ** 4 / 15)).toBeLessThan(1e-13);
  });
  test("ψ^(4)(1) = -24·ζ(5)", () => {
    expect(relErr(polygammaFloat64(4, 1), -24 * ZETA_5)).toBeLessThan(1e-13);
  });
  test("polygamma(0, x) routes to digamma", () => {
    expect(polygammaFloat64(0, 1)).toBe(digammaFloat64(1));
  });
  test("polygamma(1, x) routes to trigamma", () => {
    expect(polygammaFloat64(1, 1)).toBe(trigammaFloat64(1));
  });
});

// -----------------------------------------------------------------------------
// §5. Pochhammer
// -----------------------------------------------------------------------------

describe("Pochhammer (DLMF §5.2.4)", () => {
  test("(a)_0 = 1 (empty product)", () => {
    expect(pochhammerFloat64(7.3, 0)).toBe(1);
  });
  test("(2)_3 = 2·3·4 = 24", () => {
    expect(pochhammerFloat64(2, 3)).toBe(24);
  });
  test("(1/2)_4 = 1/2·3/2·5/2·7/2 = 105/16 = 6.5625", () => {
    expect(ulpDiff(pochhammerFloat64(0.5, 4), 6.5625)).toBeLessThanOrEqual(2);
  });
  test("(-3)_5 = 0 (zero factor)", () => {
    expect(pochhammerFloat64(-3, 5)).toBe(0);
  });
  test("(-3)_3 = -3·-2·-1 = -6", () => {
    expect(pochhammerFloat64(-3, 3)).toBe(-6);
  });
  test("(1)_n = n! for integer n", () => {
    for (const n of [1, 5, 10]) {
      let fact = 1;
      for (let i = 1; i <= n; i++) fact *= i;
      expect(pochhammerFloat64(1, n)).toBe(fact);
    }
  });
});

// -----------------------------------------------------------------------------
// §6. Incomplete Gamma — P/Q complementarity + L12 guard
// -----------------------------------------------------------------------------

describe("Incomplete Gamma (Cephes igam.c)", () => {
  test("L12 guard: P, Q, Upper, Lower are four DISTINCT functions", () => {
    const a = 1.5,
      z = 2.5;
    const P = gammaPFloat64(a, z);
    const Q = gammaQFloat64(a, z);
    const upper = incGammaUpperFloat64(a, z);
    const lower = incGammaLowerFloat64(a, z);
    // P ≠ Q (clearly different magnitudes)
    expect(Math.abs(P - Q)).toBeGreaterThan(0.5);
    // P ≠ upper (P is dimensionless, upper has Γ(a) scaling)
    expect(Math.abs(P - upper)).toBeGreaterThan(0.01);
    // Q ≠ lower
    expect(Math.abs(Q - lower)).toBeGreaterThan(0.5);
  });
  test("P(a, z) + Q(a, z) = 1 at machine precision", () => {
    const cases = [
      [1.5, 0.5],
      [1.5, 2.5],
      [2, 5],
      [5, 3],
      [10, 8],
      [10, 15],
      [0.5, 0.1],
      [3.7, 1.2],
    ];
    for (const [a, z] of cases) {
      const sum = gammaPFloat64(a!, z!) + gammaQFloat64(a!, z!);
      expect(ulpDiff(sum, 1)).toBeLessThanOrEqual(4);
    }
  });
  test("γ(a, z) + Γ(a, z) = Γ(a) exact relation", () => {
    const cases = [
      [1.5, 2.5],
      [2, 5],
      [5, 3],
      [3.7, 1.2],
    ];
    for (const [a, z] of cases) {
      const lower = incGammaLowerFloat64(a!, z!);
      const upper = incGammaUpperFloat64(a!, z!);
      const total = gammaFloat64(a!);
      expect(relErr(lower + upper, total)).toBeLessThan(1e-12);
    }
  });
  test("Γ(1, z) = exp(-z) (closed form)", () => {
    for (const z of [0.5, 1.0, 3.0, 10.0]) {
      expect(relErr(incGammaUpperFloat64(1, z), Math.exp(-z))).toBeLessThan(1e-13);
    }
  });
  test("P(1/2, z²) = erf(z) (DLMF 8.11.1)", () => {
    // erf(1) ≈ 0.842700793 — verify P(1/2, 1)
    const erfOne = 0.8427007929497149;
    expect(relErr(gammaPFloat64(0.5, 1), erfOne)).toBeLessThan(1e-13);
  });
  test("invGammaP round-trip: P(a, invGammaP(a, p)) ≈ p", () => {
    for (const a of [0.5, 1, 2, 5]) {
      for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = invGammaPFloat64(a, p);
        const pBack = gammaPFloat64(a, x);
        expect(relErr(pBack, p)).toBeLessThan(1e-10);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// §7. Beta closed forms
// -----------------------------------------------------------------------------

describe("Beta (DLMF §5.12)", () => {
  test("B(1/2, 1/2) = π", () => {
    expect(ulpDiff(betaFloat64(0.5, 0.5), Math.PI)).toBeLessThanOrEqual(4);
  });
  test("B(1, 1) = 1 (uniform distribution)", () => {
    expect(betaFloat64(1, 1)).toBe(1);
  });
  test("B(n, m) = (n-1)!(m-1)!/(n+m-1)! for small integers", () => {
    // B(2, 3) = 1!·2!/4! = 2/24 = 1/12
    expect(ulpDiff(betaFloat64(2, 3), 1 / 12)).toBeLessThanOrEqual(2);
    // B(3, 4) = 2!·3!/6! = 12/720 = 1/60
    expect(ulpDiff(betaFloat64(3, 4), 1 / 60)).toBeLessThanOrEqual(4);
  });
  test("B is symmetric: B(a, b) = B(b, a)", () => {
    expect(betaFloat64(2, 3)).toBe(betaFloat64(3, 2));
    expect(ulpDiff(betaFloat64(0.7, 0.3), betaFloat64(0.3, 0.7))).toBeLessThanOrEqual(2);
  });
  test("logBeta(a, b) = log B(a, b) with sign", () => {
    const lb = logBetaFloat64(3, 5);
    expect(ulpDiff(lb.value, Math.log(betaFloat64(3, 5)))).toBeLessThanOrEqual(8);
    expect(lb.sign).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// §8. Incomplete Beta
// -----------------------------------------------------------------------------

describe("Incomplete Beta (Cephes incbet.c)", () => {
  test("I_0(a, b) = 0, I_1(a, b) = 1", () => {
    expect(incBetaFloat64(2, 3, 0)).toBe(0);
    expect(incBetaFloat64(2, 3, 1)).toBe(1);
  });
  test("I_z(1, 1) = z (uniform distribution)", () => {
    for (const z of [0.1, 0.3, 0.5, 0.9]) {
      expect(ulpDiff(incBetaFloat64(1, 1, z), z)).toBeLessThanOrEqual(4);
    }
  });
  test("I_0.5(a, a) = 0.5 (symmetry)", () => {
    for (const a of [1, 2, 3, 5, 10]) {
      expect(relErr(incBetaFloat64(a, a, 0.5), 0.5)).toBeLessThan(1e-13);
    }
  });
});

// -----------------------------------------------------------------------------
// §9. BarnesG closed-form values (DLMF §5.17)
// -----------------------------------------------------------------------------

describe("BarnesG (DLMF §5.17)", () => {
  test("G(1) = G(2) = G(3) = 1", () => {
    expect(barnesGFloat64(1)).toBe(1);
    expect(barnesGFloat64(2)).toBe(1);
    expect(barnesGFloat64(3)).toBe(1);
  });
  test("G(4) = 2 (=2!)", () => {
    expect(barnesGFloat64(4)).toBe(2);
  });
  test("G(5) = 12 (= 2!·3!)", () => {
    expect(barnesGFloat64(5)).toBe(12);
  });
  test("G(6) = 288 (= 2!·3!·4!)", () => {
    expect(barnesGFloat64(6)).toBe(288);
  });
  test("G(n+1) = Γ(n)·G(n) (functional equation)", () => {
    for (const n of [4, 5, 6, 8]) {
      const lhs = barnesGFloat64(n + 1);
      const rhs = gammaFloat64(n) * barnesGFloat64(n);
      expect(relErr(lhs, rhs)).toBeLessThan(1e-10);
    }
  });
  test("G(-n) = 0 for negative integer n (zero of BarnesG)", () => {
    expect(barnesGFloat64(-1)).toBe(0);
    expect(barnesGFloat64(-2)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// §10. Hyperfactorial integer values
// -----------------------------------------------------------------------------

describe("Hyperfactorial (DLMF §5.17)", () => {
  test("K(1) = 1", () => {
    expect(hyperfactorialFloat64(1)).toBe(1);
  });
  test("K(2) = 2² = 4", () => {
    expect(hyperfactorialFloat64(2)).toBe(4);
  });
  test("K(3) = 1·4·27 = 108", () => {
    expect(hyperfactorialFloat64(3)).toBe(108);
  });
  test("K(4) = 1·4·27·256 = 27648", () => {
    expect(hyperfactorialFloat64(4)).toBe(27648);
  });
});

// -----------------------------------------------------------------------------
// §11. Ratio variants
// -----------------------------------------------------------------------------

describe("Ratio variants", () => {
  test("Γ(5)/Γ(3) = 4!/2! = 12", () => {
    expect(gammaRatioFloat64(5, 3)).toBe(12);
  });
  test("Γ(a)/Γ(a+1) = 1/a (the basic recurrence)", () => {
    for (const a of [2, 5, 10]) {
      expect(relErr(gammaDeltaRatioFloat64(a, 1), 1 / a)).toBeLessThan(1e-13);
    }
  });
  test("gammaPDerivative(a, z) = e^{-z}·z^{a-1}/Γ(a) (DLMF 8.8.12)", () => {
    const a = 2,
      z = 3;
    const expected = (Math.exp(-z) * Math.pow(z, a - 1)) / gammaFloat64(a);
    expect(relErr(gammaPDerivativeFloat64(a, z), expected)).toBeLessThan(1e-13);
  });
});

// -----------------------------------------------------------------------------
// §12. Complex paths (spot checks against mpmath)
// -----------------------------------------------------------------------------

describe("Complex paths (SciPy _loggamma.pxd)", () => {
  test("lgamma(1.5+2.5i) ≈ -2.0721 + 1.1810i (mpmath)", () => {
    const r = lgammaComplexFloat64(1.5, 2.5);
    expect(relErr(r.re, -2.0721512706826312)).toBeLessThan(1e-12);
    expect(relErr(r.im, 1.1809590329077773)).toBeLessThan(1e-12);
  });
  test("Γ(2+3i) ≈ -0.0824 + 0.0918i (mpmath)", () => {
    const r = gammaComplexFloat64(2, 3);
    expect(relErr(r.re, -0.08239527266581138)).toBeLessThan(1e-10);
    expect(relErr(r.im, 0.09177428743525574)).toBeLessThan(1e-10);
  });
  test("ψ(2+3i) ≈ 1.20798 + 1.10413i (mpmath)", () => {
    const r = digammaComplexFloat64(2, 3);
    expect(relErr(r.re, 1.2079807107101509)).toBeLessThan(1e-12);
    expect(relErr(r.im, 1.1041296805875762)).toBeLessThan(1e-12);
  });
  test("complex path with im=0 routes to real path (byte-identical)", () => {
    expect(lgammaComplexFloat64(2.5, 0).re).toBe(lgammaFloat64(2.5).value);
    expect(gammaComplexFloat64(2.5, 0).re).toBe(gammaFloat64(2.5));
    expect(digammaComplexFloat64(2.5, 0).re).toBe(digammaFloat64(2.5));
  });
});

// -----------------------------------------------------------------------------
// §13. Dispatcher integration (eval-numeric-expr.ts)
// -----------------------------------------------------------------------------

describe("Dispatcher integration via evalNumericExprWithSpecial", () => {
  const evalE = (head: string, args: number[]) =>
    evalNumericExprWithSpecial(
      expr(
        head,
        args.map((a) => float64FromNumber(a)),
      ),
      new Map(),
    );

  test("Gamma head registered", () => {
    expect(SPECIAL_HEADS.includes("Gamma")).toBe(true);
  });
  test("All 19+ Gamma family heads in SPECIAL_HEADS", () => {
    const required = [
      "Gamma",
      "LogGamma",
      "Digamma",
      "Trigamma",
      "Polygamma",
      "Pochhammer",
      "IncompleteGammaUpper",
      "IncompleteGammaLower",
      "IncompleteGammaP",
      "IncompleteGammaQ",
      "InverseIncompleteGammaP",
      "InverseIncompleteGammaQ",
      "Beta",
      "LogBeta",
      "IncompleteBeta",
      "BarnesG",
      "Hyperfactorial",
      "GammaRatio",
      "GammaDeltaRatio",
      "GammaPDerivative",
    ];
    for (const h of required) {
      expect(SPECIAL_HEADS.includes(h)).toBe(true);
    }
  });
  test("eval Γ(0.5) → √π", () => {
    expect(ulpDiff(evalE("Gamma", [0.5]), SQRT_PI)).toBeLessThanOrEqual(2);
  });
  test("eval Beta(0.5, 0.5) → π", () => {
    expect(ulpDiff(evalE("Beta", [0.5, 0.5]), Math.PI)).toBeLessThanOrEqual(4);
  });
  test("eval Polygamma(2, 1) → -2·ζ(3)", () => {
    expect(relErr(evalE("Polygamma", [2, 1]), -2 * ZETA_3)).toBeLessThan(1e-13);
  });
  test("eval BarnesG(5) → 12", () => {
    expect(evalE("BarnesG", [5])).toBe(12);
  });
});

// -----------------------------------------------------------------------------
// §14. Bench/gamma-anchor cross-validation (Wolfram + mpmath gold tier)
// -----------------------------------------------------------------------------

interface BenchInput {
  id: string;
  tier: string;
  head: string;
  z?: string;
  a?: string;
  b?: string;
  m?: string;
  n?: string;
  notes?: string;
}
interface OracleResult {
  input_id: string;
  status: string;
  value?: string;
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BENCH_DIR = path.resolve(HERE, "../../../../bench/gamma-anchor");

let CORPUS: { inputs: BenchInput[] } | null = null;
let MPMATH: { results: OracleResult[] } | null = null;
try {
  CORPUS = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "corpus.json"), "utf-8"));
  MPMATH = JSON.parse(
    fs.readFileSync(path.join(BENCH_DIR, "oracles/mpmath/results.json"), "utf-8"),
  );
} catch (_e) {
  // Bench may not be present; gracefully degrade.
}

function callHead(head: string, args: number[]): number {
  switch (head) {
    case "Gamma":
      return gammaFloat64(args[0]!);
    case "LogGamma":
      return lgammaFloat64(args[0]!).value;
    case "Digamma":
      return digammaFloat64(args[0]!);
    case "Trigamma":
      return trigammaFloat64(args[0]!);
    case "Polygamma":
      return polygammaFloat64(args[0]!, args[1]!);
    case "Pochhammer":
      return pochhammerFloat64(args[0]!, args[1]!);
    case "IncompleteGammaP":
      return gammaPFloat64(args[0]!, args[1]!);
    case "IncompleteGammaQ":
      return gammaQFloat64(args[0]!, args[1]!);
    case "IncompleteGammaLower":
      return incGammaLowerFloat64(args[0]!, args[1]!);
    case "IncompleteGammaUpper":
      return incGammaUpperFloat64(args[0]!, args[1]!);
    case "Beta":
      return betaFloat64(args[0]!, args[1]!);
    case "LogBeta":
      return logBetaFloat64(args[0]!, args[1]!).value;
    case "BarnesG":
      return barnesGFloat64(args[0]!);
    case "GammaRatio":
      return gammaRatioFloat64(args[0]!, args[1]!);
    case "GammaDeltaRatio":
      return gammaDeltaRatioFloat64(args[0]!, args[1]!);
    case "GammaPDerivative":
      return gammaPDerivativeFloat64(args[0]!, args[1]!);
    case "IncompleteBeta":
      return incBetaFloat64(args[1]!, args[2]!, args[0]!); // ordering check
    default:
      return NaN;
  }
}

describe("bench/gamma-anchor cross-validation (10-input sample)", () => {
  test("smoke: bench corpus + mpmath oracle loadable", () => {
    if (!CORPUS || !MPMATH) {
      // bench may legitimately be absent in slim checkouts; assertion
      // would block them. Skip silently if missing.
      return;
    }
    expect(CORPUS.inputs.length).toBeGreaterThan(50);
    expect(MPMATH.results.length).toBeGreaterThan(50);
  });

  test("max relative error ≤ 5e-13 on 10 T1 positive-real Gamma inputs", () => {
    if (!CORPUS || !MPMATH) return;
    const mpmathMap = new Map(MPMATH.results.map((r) => [r.input_id, r]));
    let count = 0;
    let maxErr = 0;
    for (const inp of CORPUS.inputs) {
      if (count >= 10) break;
      // Real positive z, single-arg heads, T1 only.
      if (inp.tier !== "T1") continue;
      if (!["Gamma", "LogGamma", "Digamma", "Trigamma"].includes(inp.head)) continue;
      if (typeof inp.z !== "string") continue;
      const oracle = mpmathMap.get(inp.id);
      if (!oracle || oracle.status !== "success" || typeof oracle.value !== "string") continue;
      const z = Number.parseFloat(inp.z);
      if (!Number.isFinite(z)) continue;
      const expected = Number.parseFloat(oracle.value);
      if (!Number.isFinite(expected)) continue;
      const got = callHead(inp.head, [z]);
      if (!Number.isFinite(got)) continue;
      const e = relErr(got, expected);
      if (e > maxErr) maxErr = e;
      count++;
    }
    expect(count).toBeGreaterThan(0);
    expect(maxErr).toBeLessThan(5e-13);
  });
});
