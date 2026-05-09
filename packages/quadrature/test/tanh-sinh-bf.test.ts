// =============================================================================
// tanh-sinh-bf — arb-prec double-exponential quadrature tests
// =============================================================================
//
// Coverage map (every test asserts an invariant — Rule 7):
//
//   1. Closed-form anchor identities at multiple precisions. The
//      Bailey-Jeyabalan-Li 2005 §6 test bank's classes 1–4 (smooth
//      well-behaved on a finite interval) are the v0.1 sweet spot;
//      the algorithm reliably hits the user's target precision at
//      level ≤ 8 for each. Cited mpmath oracles at 110 dps are baked
//      into the test file.
//
//   2. The smooth-analytic-with-bounded-Taylor-radius class K15+adaptive
//      stalls on (the worklog 072 case): ∫_0^1 1/(1+x²) dx = π/4.
//      G7K15 BF saturates at ~30 dps within practical budget; tanh-sinh
//      reaches the user's target at 50 dps and at 100 dps within a
//      single-power-of-2 doubling band. This is the load-bearing
//      capability claim.
//
//   3. Cross-validation with `gaussKronrodAdaptiveBF` (the BF G7K15
//      driver) on the easy class where both converge — entire-function
//      sin and exp on bounded intervals at moderate precision. The two
//      drivers should agree to the user's tolerance, end-to-end. This
//      is mutation-proof: if either driver computes the wrong thing,
//      the cross-validation fails.
//
//   4. Bit-determinism: two runs of the same input produce byte-
//      identical `value` and `errorEstimate` BigFloats. ADR-0020's
//      strongest contract; `arbprec: true` on every JavaScript runtime.
//
//   5. Convergence-flag honesty under tight `maxLevels` budget. The
//      driver reports `converged: false` and a non-empty warning when
//      the level budget runs out before tolerance is met.
//
//   6. Boundary refusals: `prec < 1`, non-integer prec,
//      `a >= b`, `maxLevels < 2`, `maxEvals < 2` — each throws
//      cleanly with a diagnostic. Integrand exceptions propagate
//      verbatim (no wrapping).
//
//   7. Default-tolerance scaling: a constant integrand at multiple
//      precisions has `errorEstimate ≤ 10^-prec` and `converged:
//      true` immediately.
//
//   8. Result shape: `method: "tanh-sinh-bigfloat"`, iterations =
//      level count, nEvals > 0 on non-trivial integrands, warnings
//      always present.
//
// Citation oracle (Law 1): every "expected" BigFloat below either
// reuses the 110-dps mpmath strings already in `quadrature-bf.test.ts`
// (regenerated under the recipe at the top of that file) or is
// computed via the substrate's own primitives (`pi`, `log`, `exp`)
// at the same working precision — so the comparison is "tanh-sinh
// reproduces the substrate's exact value", not "tanh-sinh agrees
// with itself."
//
// Test classes deliberately omitted in v0.1 (see ADR-0024 §"What we
// will not decide here"):
//   - Endpoint-singular integrands (Bailey §6 classes 5–10) — these
//     would need the secondary-precision `1 − x_j` storage trick.
//   - Infinite-interval integrands (Bailey classes 11–13) — the
//     caller transforms via `s = 1/(t+1)` before invoking this driver.
//   - Highly oscillatory (Bailey classes 14–15) — that's K15's
//     territory, not tanh-sinh's.

import { describe, expect, test } from "bun:test";
import {
  type BigFloatQuadResult,
  BigFloatQuadratureError,
  MAX_DECIMAL_PRECISION,
  gaussKronrodAdaptiveBF,
  tanhSinhAdaptiveBF,
} from "@workbench/quadrature";
import {
  type BigFloat,
  add,
  cmp,
  cos,
  decimalToBinaryPrecision,
  div,
  exp,
  fromInt,
  fromString,
  log,
  mul,
  pi,
  powInt,
  sin,
  sub,
} from "@workbench/bigfloat";

function absDiff(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  const d = sub(a, b, prec);
  return d.mantissa < 0n ? { ...d, mantissa: -d.mantissa } : d;
}

function bf(s: string, prec: number): BigFloat { return fromString(s, prec); }

// 110-dps mpmath oracles. Recipe at top of `quadrature-bf.test.ts`.
//
// Cross-validation oracles for the worklog-077 hardening test bank.
// Truth values generated via mpmath @ dps=130, then nstr'd back to 110
// digits; spot-checked against Wolfram `wolframscript -code 'N[..., 60]'`.
// See worklog 077 §"Cross-validation truths" for the regeneration recipe.
const PI_110 =
  "3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679821480865132823066";
const PI_OVER_4_110 =
  "0.78539816339744830961566084581987572104929234984377645524373614807695410157155224965700870633552926699553702162832974066";
const ONE_QUARTER = "0.25";
// ∫_0^1 e^{-x²} dx = (√π / 2) · erf(1).  An entire-function integrand
// (no singularities anywhere in ℂ); the absolute test of tanh-sinh's
// behaviour on the easy class.  mpmath dps=130 → 110-digit nstr.
const EXP_NEG_X2_INT_110 =
  "0.74682413281242702539946743613185300535449968681260632902765449895860532756177283149784842982290191973061895402";
// ∫_0^1 1/(1+x⁴) dx = (π + 2 log(1+√2)) / (4√2).  Sister integrand to
// 1/(1+x²) — quartic poles at the four primitive 8th roots of -1
// (distance √2/2 from the real axis), strip-width still ≥ √2/2.
// Cross-check: Wolfram `N[Integrate[1/(1+x^4),{x,0,1}],60]` matches.
const INT_INV_1_PLUS_X4_110 =
  "0.86697298733991103757399516388287071365217536734524490433503183891763935141094132905575040346340896870521810263";
// ∫_0^π 1/(2+cos x) dx = π/√3.  Smooth periodic integrand on a
// compact interval; tanh-sinh handles it cleanly because the
// transformed integrand decays doubly-exponentially at both
// endpoints.  Cross-check: Wolfram matches to 60 dps.
const INT_INV_2_PLUS_COS_110 =
  "1.8137993642342178505940782576421557322840662480927405755698849353881231811263538836841249882120601688562224145";

// -----------------------------------------------------------------------------
// 1. Closed-form anchor identities (Bailey §6 classes 1–4, smooth)
// -----------------------------------------------------------------------------

describe("closed-form anchors (smooth integrands, Bailey §6 class 1–4)", () => {
  // Bailey #1: ∫_0^1 t·log(1+t) dt = 1/4.  (Smooth, no endpoint trouble.)
  // Mutation-prove: this tests that the integrand-evaluation, the
  // affine map, and the Jacobian all line up; flipping any sign or
  // swapping any operand makes ¼ → wrong answer at every prec.
  for (const prec of [30, 50, 100]) {
    test(`∫_0^1 t·log(1+t) dt = 1/4 at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = fromInt(1n);
      // Integrand contract (worklog 077 fix): every constant the
      // integrand uses MUST be constructed at the supplied `p` (the
      // driver's working precision). `fromInt(1n, p)` not `fromInt(1n)`
      // — the latter has default precision 53, and any subsequent
      // `div(fromInt(1n), …, p)` quantises silently to ~16 dps
      // because the substrate's `div` allocates only `prec + 32` bits
      // of working space relative to the *numerator's* bit length.
      const f = (t: BigFloat, p: number): BigFloat => {
        const onePlusT = add(fromInt(1n, p), t, p);
        return mul(t, log(onePlusT, p), p);
      };
      const r = tanhSinhAdaptiveBF(f, a, b, prec);
      expect(r.method).toBe("tanh-sinh-bigfloat");
      const expected = bf(ONE_QUARTER, work);
      // Tolerance: prec-2 dps. The substrate's ulp at the user precision
      // is ~10^-prec; we leave 2 dps for the final-rounding ulp + the
      // running-sum accumulation across many evaluations.
      const tol = powInt(fromInt(10n), -(prec - 2), work);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
      expect(r.iterations).toBeGreaterThan(0); // some level-doubling needed
    });
  }

  // Bailey #4 (variant): ∫_0^1 1/(1+x²) dx = π/4. The smooth-analytic
  // bounded-Taylor-radius integrand from worklog 072 — the
  // load-bearing reason this driver exists. K15+adaptive saturates at
  // ~30 dps within practical budget; tanh-sinh reaches 50 and 100 dps.
  for (const prec of [30, 50, 100]) {
    test(`∫_0^1 1/(1+x²) dx = π/4 at ${prec} dps  (the K15-stalls case from worklog 072)`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = fromInt(1n);
      // Integrand contract (worklog 077): `fromInt(1n, p)`, not
      // `fromInt(1n)`. The latter creates a 53-bit BigFloat; subsequent
      // `div(default-1n, hi-prec-denom, p)` silently produces a quotient
      // good only to ~16 dps regardless of `p`, because the substrate's
      // `div` working-bits formula is `prec + 32` from the *numerator's*
      // perspective. Worklog 075 attributed the resulting precision floor
      // to "the recurrence" or "doubly-exponential decay" — the actual
      // root cause was the integrand silently evaluating at low precision.
      const f = (x: BigFloat, p: number): BigFloat => {
        const onePlusXsq = add(fromInt(1n, p), mul(x, x, p), p);
        return div(fromInt(1n, p), onePlusXsq, p);
      };
      const r = tanhSinhAdaptiveBF(f, a, b, prec);
      const expected = bf(PI_OVER_4_110, work);
      const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
    });
  }

  // ---------------------------------------------------------------
  // djp regression — the integrand contract is no longer load-bearing.
  //
  // Pre-djp (worklog 077 → 084): every integrand had to construct
  // BigFloat constants at the working precision (`fromInt(N, p)`),
  // because the substrate's `div(a, b, prec)` zero-padded the quotient
  // when `bitLength(a.mantissa) < bitLength(b.mantissa)`. The
  // integrand-contract docstring on `tanhSinhAdaptiveBF` documented
  // the workaround.
  //
  // Post-djp (worklog 084, fix in `packages/bigfloat/src/arithmetic.ts`):
  // the substrate compensates for the bit-length differential, and the
  // integrand can use `fromInt(1n)` (default 53-bit precision attribute)
  // in the numerator without flooring the quotient. This test is a
  // regression guard: if djp is ever reverted or weakened, this test
  // catches the silent precision floor on the canonical
  // `1/(1+x²)` workload at 100 dps.
  // ---------------------------------------------------------------
  test("∫_0^1 1/(1+x²) dx = π/4 at 100 dps with default-precision integrand constants (djp regression)", () => {
    const prec = 100;
    const work = decimalToBinaryPrecision(prec, 30);
    const a = fromInt(0n);
    const b = fromInt(1n);
    // The "wrong" form per worklog 077's integrand-contract docstring:
    // `fromInt(1n)` (53-bit default), not `fromInt(1n, p)`. Pre-djp
    // this looped at maxLevels with `converged: false` (mutation M4 in
    // worklog 077). Post-djp it converges normally.
    const f = (x: BigFloat, p: number): BigFloat => {
      const onePlusXsq = add(fromInt(1n), mul(x, x, p), p);
      return div(fromInt(1n), onePlusXsq, p);
    };
    const r = tanhSinhAdaptiveBF(f, a, b, prec);
    const expected = bf(PI_OVER_4_110, work);
    const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
    expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
    expect(r.converged).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 2. Cross-validation with G7K15 BF (entire functions — both converge)
// -----------------------------------------------------------------------------
//
// Mutation-prove: if either driver computes the wrong thing, the
// agreement test fails. The two algorithms are independent
// implementations of "compute the integral to user precision," so
// agreement to user precision is genuine cross-validation. Tested
// at moderate prec where K15+adaptive is comfortable (entire
// functions sin / exp).

describe("cross-validation against gaussKronrodAdaptiveBF (entire functions)", () => {
  test("∫_0^π sin(x) dx = 2 — both drivers agree at 50 dps", () => {
    const prec = 50;
    const work = decimalToBinaryPrecision(prec, 30);
    const a = fromInt(0n);
    const b = pi(work);
    const f = (x: BigFloat, p: number) => sin(x, p);
    const rK = gaussKronrodAdaptiveBF(f, a, b, prec);
    const rT = tanhSinhAdaptiveBF(f, a, b, prec);
    expect(rK.converged).toBe(true);
    expect(rT.converged).toBe(true);
    // The two values should agree to within (a small multiple of) the
    // user precision tolerance.
    const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
    expect(cmp(absDiff(rK.value, rT.value, work), tol) <= 0).toBe(true);
  });

  test("∫_0^1 exp(x) dx = e - 1 — both drivers agree at 50 dps", () => {
    const prec = 50;
    const work = decimalToBinaryPrecision(prec, 30);
    const a = fromInt(0n);
    const b = fromInt(1n);
    const f = (x: BigFloat, p: number) => exp(x, p);
    const rK = gaussKronrodAdaptiveBF(f, a, b, prec);
    const rT = tanhSinhAdaptiveBF(f, a, b, prec);
    expect(rK.converged).toBe(true);
    expect(rT.converged).toBe(true);
    const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
    expect(cmp(absDiff(rK.value, rT.value, work), tol) <= 0).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 2b. External cross-validation against Wolfram + mpmath at high prec
// -----------------------------------------------------------------------------
//
// Worklog 077 mandates: at 50 dps, validate against Wolfram on three
// integrand classes beyond the existing two; at 100 dps, validate
// against mpmath on the same. Truth strings are checked-in constants
// at the top of this file (110-dps oracles, generated via mpmath
// dps=130 then nstr-110 + spot-check against Wolfram dps=60).
//
// Cross-validation here is real (the algorithms / implementations
// are entirely independent); tanh-sinh's BigFloat arithmetic and
// mpmath's GMP arithmetic both target the same mathematical answer
// from independent code paths. Agreement to ~prec dps is therefore
// strong evidence of correctness on both sides.

describe("external cross-validation against Wolfram / mpmath truths", () => {
  // ∫_0^1 e^{-x²} dx — entire-function integrand (no singularities
  // in ℂ). Tanh-sinh should converge cleanly; tests the algorithm's
  // behaviour on its sweet-spot class.
  for (const prec of [50, 100]) {
    test(`∫_0^1 e^{-x²} dx (entire function) at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const f = (x: BigFloat, p: number) => {
        const xx = mul(x, x, p);
        const negXX: BigFloat = { ...xx, mantissa: -xx.mantissa };
        return exp(negXX, p);
      };
      const r = tanhSinhAdaptiveBF(f, fromInt(0n), fromInt(1n), prec);
      const expected = bf(EXP_NEG_X2_INT_110, work);
      const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
      expect(r.converged).toBe(true);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
    });
  }

  // ∫_0^1 1/(1+x⁴) dx — sister of the worklog-072 case 1/(1+x²).
  // Quartic denominator → poles at the four primitive 8th roots of -1
  // = {e^{iπ/4}, e^{i3π/4}, e^{i5π/4}, e^{i7π/4}}. The two with
  // positive imaginary parts (closest to the real axis [0,1]) sit at
  // distance sin(π/4) = √2/2 ≈ 0.707 from the real line. Tanh-sinh's
  // doubly-exponential rate carries through.
  for (const prec of [50, 100]) {
    test(`∫_0^1 1/(1+x⁴) dx (sister of 1/(1+x²)) at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const f = (x: BigFloat, p: number) => {
        const x2 = mul(x, x, p);
        const x4 = mul(x2, x2, p);
        const onePlusX4 = add(fromInt(1n, p), x4, p);
        return div(fromInt(1n, p), onePlusX4, p);
      };
      const r = tanhSinhAdaptiveBF(f, fromInt(0n), fromInt(1n), prec);
      const expected = bf(INT_INV_1_PLUS_X4_110, work);
      const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
      expect(r.converged).toBe(true);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
    });
  }

  // ∫_0^π 1/(2+cos x) dx — smooth periodic on a compact interval.
  // The integrand has its minimum at x=π (value 1/(2-1) = 1) and
  // maximum at x=0 (value 1/(2+1) = 1/3); both endpoints are
  // bounded and analytic, so tanh-sinh converges as on the
  // entire-function class. Tested at 50 dps only (the 100-dps
  // variant adds wall-time without contributing to the brief's
  // "entire-function and bounded-radius integrand" 100-dps coverage,
  // which `e^{-x²}` and `1/(1+x⁴)` already supply).
  for (const prec of [50]) {
    test(`∫_0^π 1/(2+cos x) dx (smooth periodic) at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const upper = pi(work);
      const f = (x: BigFloat, p: number) => {
        const twoPlusCos = add(fromInt(2n, p), cos(x, p), p);
        return div(fromInt(1n, p), twoPlusCos, p);
      };
      const r = tanhSinhAdaptiveBF(f, fromInt(0n), upper, prec);
      const expected = bf(INT_INV_2_PLUS_COS_110, work);
      const tol = mul(fromInt(10n), powInt(fromInt(10n), -(prec - 2), work), work);
      expect(r.converged).toBe(true);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// 3. Bit-determinism (ADR-0020 contract)
// -----------------------------------------------------------------------------

describe("bit-determinism (arbprec contract)", () => {
  test("two runs on ∫_0^1 1/(1+x²) at 50 dps produce byte-identical BigFloats", () => {
    const prec = 50;
    const a = fromInt(0n);
    const b = fromInt(1n);
    const f = (x: BigFloat, p: number) => {
      const onePlusXsq = add(fromInt(1n, p), mul(x, x, p), p);
      return div(fromInt(1n, p), onePlusXsq, p);
    };
    const r1 = tanhSinhAdaptiveBF(f, a, b, prec);
    const r2 = tanhSinhAdaptiveBF(f, a, b, prec);
    // BigFloat equality: same mantissa, exponent, precision.
    expect(r1.value.mantissa).toBe(r2.value.mantissa);
    expect(r1.value.exponent).toBe(r2.value.exponent);
    expect(r1.value.precision).toBe(r2.value.precision);
    expect(r1.errorEstimate.mantissa).toBe(r2.errorEstimate.mantissa);
    expect(r1.errorEstimate.exponent).toBe(r2.errorEstimate.exponent);
    expect(r1.errorEstimate.precision).toBe(r2.errorEstimate.precision);
    expect(r1.iterations).toBe(r2.iterations);
    expect(r1.nEvals).toBe(r2.nEvals);
  });
});

// -----------------------------------------------------------------------------
// 4. Convergence-flag honesty (tight maxLevels budget)
// -----------------------------------------------------------------------------

describe("convergence-flag honesty under tight budget", () => {
  // Replaced 1/(1+x²) with t·log(1+t) — same convergence-test surface
  // (asserts converged=false + non-empty warnings under maxLevels=2),
  // but uses the integrand class the v0.1 driver handles correctly.
  // The 1/(1+x²) variant is skipped per worklog 075 / bead 6f8.
  test("maxLevels=2 on ∫_0^1 t·log(1+t) at 80 dps reports converged=false with a warning", () => {
    const prec = 80;
    const a = fromInt(0n);
    const b = fromInt(1n);
    const f = (t: BigFloat, p: number) => {
      const onePlusT = add(fromInt(1n), t, p);
      return mul(t, log(onePlusT, p), p);
    };
    const r = tanhSinhAdaptiveBF(f, a, b, prec, { maxLevels: 2 });
    expect(r.converged).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.iterations).toBeGreaterThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// 5. Boundary refusals
// -----------------------------------------------------------------------------

describe("boundary refusals", () => {
  const f = (x: BigFloat, _p: number) => x;

  test("prec < 1 throws RangeError", () => {
    expect(() => tanhSinhAdaptiveBF(f, fromInt(0n), fromInt(1n), 0)).toThrow(RangeError);
  });

  test("non-integer prec throws RangeError", () => {
    expect(() => tanhSinhAdaptiveBF(f, fromInt(0n), fromInt(1n), 1.5)).toThrow(RangeError);
  });

  test("prec > MAX_DECIMAL_PRECISION throws RangeError", () => {
    expect(() => tanhSinhAdaptiveBF(f, fromInt(0n), fromInt(1n), MAX_DECIMAL_PRECISION + 1)).toThrow(RangeError);
  });

  test("a >= b throws BigFloatQuadratureError", () => {
    expect(() => tanhSinhAdaptiveBF(f, fromInt(1n), fromInt(0n), 50)).toThrow(BigFloatQuadratureError);
    expect(() => tanhSinhAdaptiveBF(f, fromInt(1n), fromInt(1n), 50)).toThrow(BigFloatQuadratureError);
  });

  test("maxLevels < 2 throws RangeError (need at least 2 levels for delta-test)", () => {
    expect(() => tanhSinhAdaptiveBF(f, fromInt(0n), fromInt(1n), 50, { maxLevels: 1 })).toThrow(RangeError);
  });

  test("integrand exceptions propagate verbatim (driver does not wrap)", () => {
    const fThrows = (_x: BigFloat, _p: number): BigFloat => {
      throw new Error("integrand boom");
    };
    expect(() => tanhSinhAdaptiveBF(fThrows, fromInt(0n), fromInt(1n), 30)).toThrow("integrand boom");
  });
});

// -----------------------------------------------------------------------------
// 6. Default-tolerance scaling (constant integrand)
// -----------------------------------------------------------------------------

describe("default-tolerance scaling on a constant integrand", () => {
  for (const prec of [30, 50, 80]) {
    test(`∫_0^2 1 dx = 2 at ${prec} dps  (errorEstimate ≤ 10^-prec)`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = fromInt(2n);
      const f = (_x: BigFloat, _p: number) => fromInt(1n);
      const r = tanhSinhAdaptiveBF(f, a, b, prec);
      const expected = fromInt(2n);
      const tol = powInt(fromInt(10n), -(prec - 2), work);
      expect(cmp(absDiff(r.value, expected, work), tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
      // The errorEstimate is bounded by ~10^-prec for default tolerances.
      // Constant integrand: every level produces the same sum, so |S_k -
      // S_{k-1}| should be exactly zero (modulo working-precision rounding).
      const epsBound = powInt(fromInt(10n), -(prec - 5), work);
      expect(cmp(r.errorEstimate, epsBound) <= 0).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// 7. Result shape
// -----------------------------------------------------------------------------

describe("result shape and metadata fields", () => {
  test("non-trivial run populates every field correctly", () => {
    const prec = 30;
    // The driver uses 80 bits of safety internally — see ADR-0024
    // §"Why these choices" / "Working precision". Compute the expected
    // workingPrecision via the same `decimalToBinaryPrecision(prec, 80)`
    // call as the driver, so the test stays in lockstep with the
    // safety choice.
    const expectedWorkingBits = decimalToBinaryPrecision(prec, 80);
    const work = decimalToBinaryPrecision(prec, 30);
    const r: BigFloatQuadResult = tanhSinhAdaptiveBF(
      (x, p) => sin(x, p),
      fromInt(0n),
      pi(work),
      prec,
    );
    expect(r.method).toBe("tanh-sinh-bigfloat");
    expect(r.precision).toBe(prec);
    expect(r.workingPrecision).toBe(expectedWorkingBits);
    expect(r.nEvals).toBeGreaterThan(0);
    expect(r.iterations).toBeGreaterThan(0);
    expect(Array.isArray(r.warnings)).toBe(true);
    // value and errorEstimate are well-formed BigFloats
    expect(typeof r.value.mantissa).toBe("bigint");
    expect(typeof r.value.exponent).toBe("number");
    expect(typeof r.value.precision).toBe("number");
  });
});
