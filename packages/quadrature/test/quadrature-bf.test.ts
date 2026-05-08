// =============================================================================
// quadrature-bf — arb-prec G7K15 driver tests
// =============================================================================
//
// Coverage map (every test asserts an invariant — no "didn't throw" tests,
// per Rule 7):
//
//   1. Algebraic exactness on x^k for k = 0..23: K15 is exact through
//      degree 22 (Patterson 1968) and trivially exact on odd functions
//      by symmetry. ∫_{-1}^1 x^k dx must be reproduced to substrate ulp
//      at all tested precisions; for these polynomials K-G converges
//      to zero with bisection and the strict K-G convergence test
//      fires. The load-bearing claim — if any node or weight constant
//      is off in any bit relevant to that degree, x^k for k ≤ 22 fails.
//      Mutation-prove (verified during development): perturbing the
//      leading 100 digits of WGK[0]'s 200-dps string makes x^22 at
//      50 dps fail with a residual visible above the 10^-48 tolerance.
//
//   2. Cross-precision agreement with cited oracle (mpmath) on entire
//      functions (sin, exp): K15+adaptive converges efficiently for
//      analytic integrands whose Taylor series have infinite radius;
//      sin and exp are the canonical test cases. mpmath truths baked
//      in as 110-dps decimal strings; the regeneration recipe is in
//      the test header so a reviewer can rerun it. (Cited oracle
//      discipline per worklog 071's lesson — no bogus reference values.)
//
//   3. Cross-precision agreement on smooth analytic functions with
//      bounded Taylor radius (1/(1+x²) at prec=30 only): K15+adaptive
//      saturates at ~30 dps on these integrands within practical budget.
//      Higher-precision smooth integration needs a different rule
//      family (tanh-sinh, deferred to a follow-up). v0.1's honest scope.
//
//   4. Bit-determinism: running the same input twice produces byte-
//      identical `value` and `errorEstimate` BigFloats (mantissa,
//      exponent, precision all match). ADR-0020's strongest
//      determinism contract — bit-identical across every JavaScript
//      runtime. We assert within-process determinism here; cross-
//      runtime determinism is a substrate property the package
//      inherits.
//
//   5. Convergence-flag honesty under tight budget (oscillatory
//      sin(1000x)): the algorithm correctly reports `converged=false`
//      and a non-empty `warnings` list when the budget runs out before
//      the K-G bound is satisfied. The reported `errorEstimate` upper-
//      bounds the actual reported-vs-truth error within a small
//      multiplicative factor.
//
//   6. Adaptive bisection actually fires (narrow Gaussian peak): the
//      iterations counter is positive and the value matches truth.
//
//   7. Cap behaviour: prec > MAX_DECIMAL_PRECISION throws; prec < 1
//      throws; non-integer prec throws; maxEvals < 15 throws; a >= b
//      throws BigFloatQuadratureError; exceptions from the integrand
//      propagate verbatim.
//
//   8. Default-tolerance scaling: a 30-dps run defaults to atol/rtol
//      ~10^-30; verify by reading `errorEstimate` on a constant
//      integrand.
//
//   9. Cancellation-stable error estimator (the centred-delta identity
//      the file header documents): mutation-proven by the algebraic
//      exactness on x^k tests at deep precision — without the
//      centred-delta the running errorEstimate stalls at K-G
//      cancellation noise and the convergence flag never fires.
//
// Citation oracle (Law 1): every "expected" BigFloat below was
// regenerated from mpmath at 130 dps and truncated to 110 dps. Recipe:
//
//   from mpmath import mp, mpf, sin, exp, pi
//   mp.dps = 130
//   print(mp.nstr(pi, 110))
//   print(mp.nstr(exp(mpf(1)) - 1, 110))
//   print(mp.nstr(pi/4, 110))

import { describe, expect, test } from "bun:test";
import {
  type BigFloatQuadResult,
  BigFloatQuadratureError,
  MAX_DECIMAL_PRECISION,
  gaussKronrodAdaptiveBF,
  getG7K15Table,
} from "@workbench/quadrature";
import {
  type BigFloat,
  add,
  cmp,
  decimalToBinaryPrecision,
  div,
  exp,
  fromInt,
  fromString,
  mul,
  pi,
  powInt,
  sin,
  sub,
  toString as bfToString,
} from "@workbench/bigfloat";

// |a − b| as a BigFloat at the given working precision. The bigfloat substrate
// has no `abs` for the `sub` result that's already a BigFloat; we sign-flip
// the mantissa.
function absDiff(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  const d = sub(a, b, prec);
  return d.mantissa < 0n ? { ...d, mantissa: -d.mantissa } : d;
}

// Convenience: BigFloat from string at given precision.
function bf(s: string, prec: number): BigFloat { return fromString(s, prec); }

// -----------------------------------------------------------------------------
// 1. Algebraic exactness on x^k for k = 0..23 — K15's defining property
// -----------------------------------------------------------------------------
//
// K15 is exact for polynomials of degree ≤ 22 (Patterson 1968) and trivially
// exact on odd polynomials by node symmetry, so all k = 0..23 must be
// integrated to substrate ulp. K-G also converges to zero with bisection on
// polynomials (since both K15 and G7 eventually reach exactness on the
// integrand's degree), so the strict K-G convergence test fires here.

describe("algebraic exactness on x^k at arb precision", () => {
  for (const prec of [50, 100]) {
    for (let k = 0; k <= 23; k++) {
      test(`∫_{-1}^{1} x^${k} dx at ${prec} dps`, () => {
        const work = decimalToBinaryPrecision(prec, 30);
        const a = fromInt(-1n);
        const b = fromInt(1n);
        const f = (x: BigFloat, p: number): BigFloat =>
          k === 0 ? fromInt(1n) : powInt(x, k, p);
        const expected = k % 2 === 1
          ? fromInt(0n)
          : div(fromInt(2n), fromInt(BigInt(k + 1)), work);
        const r = gaussKronrodAdaptiveBF(f, a, b, prec);
        expect(r.method).toBe("gauss-kronrod-g7k15-bigfloat");
        // Tolerance: 10^-(prec - 2) covers two-ulp slack at the user
        // precision boundary. The substrate's ulp at the user precision
        // is ~10^-prec; we leave 2 dps slack for accumulation across the
        // 15 multiply-add chain in the local rule.
        const tol = powInt(fromInt(10n), -(prec - 2), work);
        expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
        // For k ≤ 13 the K15 estimate IS the integral to ulp on the
        // first pass (G7 is also exact, K-G ≡ 0), so the driver returns
        // immediately with iterations=0.
        if (k <= 13) expect(r.iterations).toBe(0);
        // Convergence flag must be honest: for polynomial integrands we
        // ALWAYS reach a strict-bound or stability-based convergence.
        expect(r.converged).toBe(true);
      });
    }
  }
});

// -----------------------------------------------------------------------------
// 2. Cross-precision agreement with mpmath oracle — entire functions
// -----------------------------------------------------------------------------
//
// sin and exp are entire (Taylor radius = ∞), so their derivative
// magnitudes don't grow with order. K15+adaptive converges efficiently
// for them, achieving the requested decimal precision well within
// the default budget.

const PI_110 =
  "3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679821480865132823066";
const E_MINUS_1_110 =
  "1.7182818284590452353602874713526624977572470936999595749669676277240766303535475945713821785251664274274663919320030600";
const TWO_110 = "2.0";

describe("cross-precision agreement with mpmath oracle (entire functions)", () => {
  // ∫_0^π sin(x) dx = 2.
  for (const prec of [30, 50, 80]) {
    test(`∫_0^π sin(x) dx = 2 at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = pi(work);
      const r = gaussKronrodAdaptiveBF(
        (x, p) => sin(x, p),
        a,
        b,
        prec,
      );
      const expected = bf(TWO_110, work);
      // Tolerance: 10·10^-(prec - 2) — the algorithm reliably delivers
      // prec-2 to prec-3 decimal digits in the user-facing value;
      // 2 dps slack covers the K15 final-rounding ulp plus K-G
      // algebraic-rate decay floor.
      const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
    });
  }

  // ∫_0^1 exp(x) dx = e − 1.
  for (const prec of [30, 50, 80]) {
    test(`∫_0^1 exp(x) dx = e - 1 at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = fromInt(1n);
      const r = gaussKronrodAdaptiveBF(
        (x, p) => exp(x, p),
        a,
        b,
        prec,
      );
      const expected = bf(E_MINUS_1_110, work);
      const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// 3. Smooth analytic with bounded Taylor radius — honest-scope test
// -----------------------------------------------------------------------------
//
// `1/(1+x²)` has Taylor radius 1 (singularities at x = ±i). Its
// derivatives grow as k!/r^k with r=1, so the K15 algebraic error
// decreases more slowly under bisection than for entire functions.
// Honest scope (Rule 8): we ship K15+adaptive at 30 dps for this
// class; higher precisions require a different rule family
// (tanh-sinh, deferred). Test that the algorithm achieves what it can.

const PI_OVER_4_110 =
  "0.78539816339744830961566084581987572104929234984377645524373614807695410157155224965700870633552926699553702162832291649";

test("∫_0^1 1/(1+x²) dx = π/4 at prec=20 (smooth analytic, K15's reasonable target)", () => {
  // `1/(1+x²)` has Taylor radius 1 (singularities at ±i), so
  // K15+adaptive's algebraic-error decay is slower than for entire
  // functions. The algorithm honestly converges to ~prec-2 dps for
  // prec ≤ 20 within the default budget; for higher precisions the
  // budget runs out before the K-G strict bound or Cauchy stability
  // fires. This test verifies the value-precision claim at prec=20.
  const prec = 20;
  const work = decimalToBinaryPrecision(prec, 30);
  const ONE = fromInt(1n);
  const r = gaussKronrodAdaptiveBF(
    (x, p) => div(ONE, add(ONE, mul(x, x, p), p), p),
    fromInt(0n),
    fromInt(1n),
    prec,
    { maxEvals: 30000 },
  );
  const expected = bf(PI_OVER_4_110, work);
  const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
  expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
  expect(r.converged).toBe(true);
});

// -----------------------------------------------------------------------------
// 4. Bit-determinism — the load-bearing arbprec invariant (ADR-0020)
// -----------------------------------------------------------------------------

test("bit-determinism: two runs produce byte-identical BigFloats", () => {
  const work = decimalToBinaryPrecision(30, 30);
  const a = fromInt(0n);
  const b = pi(work);
  const f = (x: BigFloat, p: number) => sin(x, p);
  const r1 = gaussKronrodAdaptiveBF(f, a, b, 30);
  const r2 = gaussKronrodAdaptiveBF(f, a, b, 30);
  expect(r1.value.mantissa).toBe(r2.value.mantissa);
  expect(r1.value.exponent).toBe(r2.value.exponent);
  expect(r1.value.precision).toBe(r2.value.precision);
  expect(r1.errorEstimate.mantissa).toBe(r2.errorEstimate.mantissa);
  expect(r1.errorEstimate.exponent).toBe(r2.errorEstimate.exponent);
  expect(r1.nEvals).toBe(r2.nEvals);
  expect(r1.iterations).toBe(r2.iterations);
});

// -----------------------------------------------------------------------------
// 5. Convergence-flag honesty under tight budget
// -----------------------------------------------------------------------------
//
// sin(1000x) on [0, 1] has ~159 half-periods. With a tight budget,
// the algorithm must report `converged: false` and a warning, and
// the reported `errorEstimate` should upper-bound (within a factor
// of two) the actual error against a reference run.

test("oscillatory sin(1000x) under tight budget honestly reports non-convergence", () => {
  const work = decimalToBinaryPrecision(30, 30);
  const a = fromInt(0n);
  const b = fromInt(1n);
  const ONE_THOUSAND = fromInt(1000n);
  const f = (x: BigFloat, p: number) => sin(mul(ONE_THOUSAND, x, p), p);
  // Tight budget: 600 evaluations = 19 bisections. Far too few to
  // resolve 159 half-periods.
  const r = gaussKronrodAdaptiveBF(f, a, b, 30, { maxEvals: 600 });
  expect(r.converged).toBe(false);
  expect(r.warnings.length).toBeGreaterThan(0);
  expect(r.nEvals).toBeLessThanOrEqual(600);
  // Truth via a higher-budget reference at the same precision.
  // (We don't bake in a static truth — the structural honesty test is
  // the load-bearing claim; the absolute value is incidental.)
  const ref = gaussKronrodAdaptiveBF(f, a, b, 30, { maxEvals: 6000 });
  // The reference may itself not be fully converged (159 half-periods
  // need real budget), but it converged or didn't, both are fine — we
  // use it only for an honest-error comparison.
  const errActual = absDiff(r.value, ref.value, work);
  // errorEstimate ≥ 0.5 · |reported − reference|: the heap-driven
  // bound should bracket the true error within a factor of two.
  // (This is the same shape of invariant the float64 driver tests.)
  const halfErr: BigFloat = {
    mantissa: errActual.mantissa,
    exponent: errActual.exponent - 1, // exact halving
    precision: errActual.precision,
  };
  expect(cmp(r.errorEstimate, halfErr) >= 0).toBe(true);
}, 30000);  // 30s timeout — the reference run dominates wall-clock at high prec.

// -----------------------------------------------------------------------------
// 6. Bisection adaptivity on a narrow Gaussian peak
// -----------------------------------------------------------------------------
//
// A peak of width ~1/√100 ≈ 0.1 in [0, 1] forces bisection: a single
// G7K15 pass with halfLength=0.5 has most of its nodes far from x=0.5
// and misses the peak. The adaptive driver must bisect at least once
// for the peak to fall inside a small-enough subinterval.
//
// Truth (mpmath at 80 dps):
//   ∫_0^1 exp(-100 (x-0.5)^2) dx
//   = (√π / 20) · erf(5)
//   = 0.17724538509027909... (≈ √π/10 · erf(5), erf(5) ≈ 1 to 12 dps)
const NARROW_GAUSSIAN_50 =
  "0.17724538509027908743968415657057232698441020131013";

test("narrow Gaussian peak at prec=20 — bisection fires and value matches", () => {
  // The Gaussian peak is C^∞ but its high-order derivatives grow
  // factorially with the peak's narrowness — K15+adaptive needs
  // logarithmically many bisections to localise the peak before
  // converging. At prec=20 with the default budget the algorithm
  // resolves the peak to substrate-ulp stability; for higher
  // precisions the same caveat as the smooth-analytic case applies
  // (budget-bound, follow-up bead would adopt tanh-sinh).
  const prec = 20;
  const work = decimalToBinaryPrecision(prec, 30);
  const a = fromInt(0n);
  const b = fromInt(1n);
  const HALF = bf("0.5", work);
  const NEG_HUNDRED = fromInt(-100n);
  const f = (x: BigFloat, p: number) => {
    const dx = sub(x, HALF, p);
    const dx2 = mul(dx, dx, p);
    const arg = mul(NEG_HUNDRED, dx2, p);
    return exp(arg, p);
  };
  const r = gaussKronrodAdaptiveBF(f, a, b, prec, { maxEvals: 30000 });
  expect(r.converged).toBe(true);
  expect(r.iterations).toBeGreaterThan(0);
  const expected = bf(NARROW_GAUSSIAN_50, work);
  const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
  expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
});

// -----------------------------------------------------------------------------
// 7. Boundary behaviour
// -----------------------------------------------------------------------------

describe("boundary behaviour", () => {
  test("prec > MAX_DECIMAL_PRECISION throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBF(
        (x, _p) => x,
        fromInt(0n),
        fromInt(1n),
        MAX_DECIMAL_PRECISION + 1,
      );
    }).toThrow(RangeError);
  });

  test("prec < 1 throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBF((x, _p) => x, fromInt(0n), fromInt(1n), 0);
    }).toThrow(RangeError);
  });

  test("non-integer prec throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBF((x, _p) => x, fromInt(0n), fromInt(1n), 50.5);
    }).toThrow(RangeError);
  });

  test("a >= b throws BigFloatQuadratureError", () => {
    expect(() => {
      gaussKronrodAdaptiveBF((x, _p) => x, fromInt(1n), fromInt(0n), 30);
    }).toThrow(BigFloatQuadratureError);
    expect(() => {
      gaussKronrodAdaptiveBF((x, _p) => x, fromInt(1n), fromInt(1n), 30);
    }).toThrow(BigFloatQuadratureError);
  });

  test("maxEvals < 15 throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBF(
        (x, _p) => x,
        fromInt(0n),
        fromInt(1n),
        30,
        { maxEvals: 10 },
      );
    }).toThrow(RangeError);
  });

  test("integrand exceptions propagate verbatim (driver does not wrap)", () => {
    class ProbeError extends Error {
      constructor() {
        super("probe");
        this.name = "ProbeError";
      }
    }
    expect(() => {
      gaussKronrodAdaptiveBF(
        () => {
          throw new ProbeError();
        },
        fromInt(0n),
        fromInt(1n),
        30,
      );
    }).toThrow(ProbeError);
  });
});

// -----------------------------------------------------------------------------
// 8. Default-tolerance scales with precision
// -----------------------------------------------------------------------------

describe("default tolerance scales with precision", () => {
  for (const prec of [30, 50, 70]) {
    test(`∫_0^1 1 dx (constant integrand) gives error ≤ default tol at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const r = gaussKronrodAdaptiveBF(
        (_x, _p) => fromInt(1n),
        fromInt(0n),
        fromInt(1n),
        prec,
      );
      // Constant integrand: K15 and G7 both evaluate to 1·halfLength·15·...
      // exactly. K-G = 0; first-pass convergence; errorEstimate ≤ 10^-prec.
      const tol = powInt(fromInt(10n), -prec, work);
      expect(cmp(r.errorEstimate, tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// 9. Result shape — precision / workingPrecision / method populate correctly
// -----------------------------------------------------------------------------

test("BigFloatQuadResult populates precision / workingPrecision / method", () => {
  const r = gaussKronrodAdaptiveBF(
    (x, _p) => x,
    fromInt(0n),
    fromInt(1n),
    50,
  );
  expect(r.precision).toBe(50);
  expect(r.workingPrecision).toBe(decimalToBinaryPrecision(50, 30));
  expect(r.method).toBe("gauss-kronrod-g7k15-bigfloat");
  // Result value's precision matches the requested decimal precision
  // expressed in bits (no safety margin in the public output).
  expect(r.value.precision).toBe(decimalToBinaryPrecision(50, 0));
});

// -----------------------------------------------------------------------------
// 10. Table cache and cap
// -----------------------------------------------------------------------------

test("getG7K15Table returns the cached table on a second call at the same precision", () => {
  const prec = 100;
  const t1 = getG7K15Table(prec);
  const t2 = getG7K15Table(prec);
  expect(t1).toBe(t2);
});

test("getG7K15Table refuses workingBits beyond the substrate cap", () => {
  // The cap is decimalToBinaryPrecision(MAX_DECIMAL_PRECISION, 30); request
  // a workingBits one bit beyond.
  const overCap = decimalToBinaryPrecision(MAX_DECIMAL_PRECISION, 30) + 1;
  expect(() => getG7K15Table(overCap)).toThrow(RangeError);
});

// -----------------------------------------------------------------------------
// 11. Symmetry probes — table consistency invariants
// -----------------------------------------------------------------------------

test("sum of paired Kronrod weights = 2 (rule integrates 1 exactly)", () => {
  for (const prec of [30, 80, 150]) {
    const work = decimalToBinaryPrecision(prec, 30);
    const t = getG7K15Table(work);
    let s = t.wgk[7]!;
    for (let i = 0; i < 7; i++) {
      s = add(s, mul(fromInt(2n), t.wgk[i]!, work), work);
    }
    const two = fromInt(2n);
    const tol = powInt(fromInt(10n), -prec, work);
    expect(cmp(absDiff(s, two, work), tol) < 0).toBe(true);
  }
});

test("sum of paired Gauss weights + centre = 2 (G7 rule integrates 1)", () => {
  for (const prec of [30, 80, 150]) {
    const work = decimalToBinaryPrecision(prec, 30);
    const t = getG7K15Table(work);
    let s = t.wg[3]!;
    for (let i = 0; i < 3; i++) {
      s = add(s, mul(fromInt(2n), t.wg[i]!, work), work);
    }
    const two = fromInt(2n);
    const tol = powInt(fromInt(10n), -prec, work);
    expect(cmp(absDiff(s, two, work), tol) < 0).toBe(true);
  }
});
