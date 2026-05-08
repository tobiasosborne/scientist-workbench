// =============================================================================
// quadrature-bc — arb-prec G7K15 driver tests (BigComplex codomain)
// =============================================================================
//
// The BigComplex-codomain generalisation of `gaussKronrodAdaptiveBF`. Same
// algorithm shape (priority-queue bisection on the centred-delta K-G
// identity); the integrand returns BigComplex; the error estimate is the
// real `cabs(K-G) · |halfLength|`. ADR-0022 is the design pin.
//
// Coverage map (every test asserts an invariant — no "didn't throw" tests,
// per Rule 7):
//
//   1. Faithful-extension byte-equality. For real-only integrands (im≡0)
//      the BC driver's `value.re` must match `gaussKronrodAdaptiveBF`'s
//      output byte-for-byte. This is the load-bearing guarantee that the
//      BC driver is "the BF driver, lifted to BigComplex" — *not* an
//      independent reimplementation that happens to give similar
//      answers. A single bit drift would mean a TS expert reading the
//      two surfaces could no longer reason that "BC handles complex,
//      degenerate to BF on real" without caveat.
//
//   2. Algebraic exactness on `(c0 + i·c1) · t^k` for k = 0..23. K15 is
//      exact for polynomials of degree ≤ 22 (Patterson 1968) and trivially
//      exact on odd functions by node symmetry. Linear in the integrand,
//      so a complex prefactor `(c0 + i·c1)` separates into independent
//      real and imaginary tests on each `t^k`. Mutation-prove (verified
//      during development): perturbing any 200-dps weight bit makes
//      `(1 + i)·t^22` at 50 dps fail visibly.
//
//   3. `∫_0^{2π} e^{i·t} dt = 0`. The canonical complex-codomain test:
//      both real and imaginary parts must vanish to substrate ulp.
//      Doubly nontrivial — `cos` and `sin` are entire, but their
//      integration over a full period is the strongest cancellation
//      probe possible.
//
//   4. Cross-precision agreement with mpmath: `∫_0^1 (cos(t) + i·sin(t))
//      dt = sin(1) + i·(1 - cos(1))`. Tests both components on
//      non-trivial entire functions. Truth values cited from mpmath at
//      130 dps (recipe in header); rounded ulp-cleanly to 110 dps.
//
//   5. Bit-determinism (ADR-0020): two runs produce byte-identical
//      BigComplex value (both components) and BigFloat errorEstimate.
//
//   6. Convergence-flag honesty: oscillatory complex integrand under
//      tight budget reports `converged: false` with a non-empty
//      warnings list.
//
//   7. Boundary behaviour: prec out of range, a >= b, maxEvals < 15,
//      integrand exceptions all behave as the BF driver does — the
//      driver is the same shell, the codomain change is internal.
//
//   8. Default-tolerance scaling: a constant-im integrand has
//      errorEstimate ≤ 10^-prec at the chosen precision.
//
//   9. Result shape: precision / workingPrecision / method /
//      value.re.precision / value.im.precision populate correctly.
//
// Citation oracle (Law 1):
//
//   from mpmath import mp, mpf, sin, cos, pi
//   mp.dps = 130
//   print(mp.nstr(sin(mpf(1)), 110))
//   print(mp.nstr(1 - cos(mpf(1)), 110))
//   print(mp.nstr(2 * pi, 110))

import { describe, expect, test } from "bun:test";
import {
  type BigComplexQuadResult,
  BigComplexQuadratureError,
  MAX_DECIMAL_PRECISION,
  gaussKronrodAdaptiveBC,
  gaussKronrodAdaptiveBF,
} from "@workbench/quadrature";
import {
  type BigFloat,
  type BigComplex,
  add,
  cabs,
  cadd,
  cfromInts,
  cfromReal,
  cmp,
  cmul,
  cos,
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

// |a − b| as a BigFloat at the given working precision.
function absDiff(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  const d = sub(a, b, prec);
  return d.mantissa < 0n ? { ...d, mantissa: -d.mantissa } : d;
}

// |a − b|_∞ over BigComplex components at the given working precision.
function cabsDiffMax(a: BigComplex, b: BigComplex, prec: number): BigFloat {
  const dr = absDiff(a.re, b.re, prec);
  const di = absDiff(a.im, b.im, prec);
  return cmp(dr, di) >= 0 ? dr : di;
}

// Convenience: BigFloat from string at given precision.
function bf(s: string, prec: number): BigFloat { return fromString(s, prec); }

// -----------------------------------------------------------------------------
// 1. Faithful-extension byte-equality vs BigFloat driver
// -----------------------------------------------------------------------------
//
// For an integrand whose imaginary component is exactly zero, the BC
// driver and the BF driver must produce *byte-identical* `value.re` and
// `errorEstimate`. The BC driver lifts BF; under the cfromReal embedding
// the algorithm is bit-equivalent. Tested across three integrand classes:
//
//   * a polynomial (K-G identically zero, single-pass convergence)
//   * sin (entire function, multi-iteration K-G convergence)
//   * a constant (constant integrand, K-G zero on first pass)
//
// at three precisions (30, 50, 80 dps) to exercise different working-bit
// regimes. If any single bit differs, the test fails. This is the
// mutation-prove per Rule 6: changing any line in the BC inner loop
// that violates "lift of BF" makes these tests fail visibly.

describe("BC driver byte-equals BF driver on real-only integrands", () => {
  for (const prec of [30, 50, 80]) {
    test(`x^7 polynomial at ${prec} dps`, () => {
      const a = fromInt(-1n);
      const b = fromInt(1n);
      const fBF = (x: BigFloat, p: number) => powInt(x, 7, p);
      const fBC = (x: BigFloat, p: number) =>
        cfromReal(powInt(x, 7, p));
      const rBF = gaussKronrodAdaptiveBF(fBF, a, b, prec);
      const rBC = gaussKronrodAdaptiveBC(fBC, a, b, prec);
      // value.re bytes match BF.value bytes
      expect(rBC.value.re.mantissa).toBe(rBF.value.mantissa);
      expect(rBC.value.re.exponent).toBe(rBF.value.exponent);
      expect(rBC.value.re.precision).toBe(rBF.value.precision);
      // value.im bytes are exact zero at the same precision
      expect(rBC.value.im.mantissa).toBe(0n);
      // errorEstimate bytes match
      expect(rBC.errorEstimate.mantissa).toBe(rBF.errorEstimate.mantissa);
      expect(rBC.errorEstimate.exponent).toBe(rBF.errorEstimate.exponent);
      // structural fields match
      expect(rBC.nEvals).toBe(rBF.nEvals);
      expect(rBC.iterations).toBe(rBF.iterations);
      expect(rBC.converged).toBe(rBF.converged);
    });

    test(`sin(x) on [0, π] at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = pi(work);
      const fBF = (x: BigFloat, p: number) => sin(x, p);
      const fBC = (x: BigFloat, p: number) => cfromReal(sin(x, p));
      const rBF = gaussKronrodAdaptiveBF(fBF, a, b, prec);
      const rBC = gaussKronrodAdaptiveBC(fBC, a, b, prec);
      expect(rBC.value.re.mantissa).toBe(rBF.value.mantissa);
      expect(rBC.value.re.exponent).toBe(rBF.value.exponent);
      expect(rBC.value.im.mantissa).toBe(0n);
      expect(rBC.errorEstimate.mantissa).toBe(rBF.errorEstimate.mantissa);
      expect(rBC.errorEstimate.exponent).toBe(rBF.errorEstimate.exponent);
      expect(rBC.iterations).toBe(rBF.iterations);
      expect(rBC.converged).toBe(rBF.converged);
    });

    test(`constant 1 on [0, 1] at ${prec} dps`, () => {
      const fBF = (_x: BigFloat, _p: number) => fromInt(1n);
      const fBC = (_x: BigFloat, _p: number) =>
        cfromReal(fromInt(1n));
      const rBF = gaussKronrodAdaptiveBF(fBF, fromInt(0n), fromInt(1n), prec);
      const rBC = gaussKronrodAdaptiveBC(fBC, fromInt(0n), fromInt(1n), prec);
      expect(rBC.value.re.mantissa).toBe(rBF.value.mantissa);
      expect(rBC.value.re.exponent).toBe(rBF.value.exponent);
      expect(rBC.value.im.mantissa).toBe(0n);
      expect(rBC.errorEstimate.mantissa).toBe(rBF.errorEstimate.mantissa);
    });
  }
});

// -----------------------------------------------------------------------------
// 2. Algebraic exactness on (c0 + i·c1) · t^k for k = 0..23
// -----------------------------------------------------------------------------
//
// Linear in the integrand, so each component decouples. ∫_{-1}^1 t^k dt =
// 0 for odd k, 2/(k+1) for even k. The complex prefactor scales each.
// Subset of k tested at 50 dps (covering the full degree range as 0..23
// would 144 tests at this point — focused subset is enough to catch
// node-bit drift, the full BF coverage already exercises every k).

describe("algebraic exactness on (c0 + i·c1) · t^k at 50 dps", () => {
  const prec = 50;
  const work = decimalToBinaryPrecision(prec, 30);
  // c = 3 + 4i — non-trivial scaling of both components.
  const c = cfromInts(3n, 4n, work);
  for (const k of [0, 1, 2, 5, 12, 22, 23]) {
    test(`∫_{-1}^{1} (3+4i) · t^${k} dt`, () => {
      const a = fromInt(-1n);
      const b = fromInt(1n);
      const f = (x: BigFloat, p: number): BigComplex => {
        const tk = k === 0 ? fromInt(1n) : powInt(x, k, p);
        return cmul(c, cfromReal(tk), p);
      };
      // Truth: c · (k%2===1 ? 0 : 2/(k+1))
      let truth: BigComplex;
      if (k % 2 === 1) {
        truth = cfromReal(fromInt(0n));
      } else {
        const realPart = div(fromInt(2n), fromInt(BigInt(k + 1)), work);
        truth = cmul(c, cfromReal(realPart), work);
      }
      const r = gaussKronrodAdaptiveBC(f, a, b, prec);
      expect(r.method).toBe("gauss-kronrod-g7k15-bigcomplex");
      const tol = powInt(fromInt(10n), -(prec - 2), work);
      expect(cmp(cabsDiffMax(r.value, truth, work), tol) <= 0).toBe(true);
      // For k ≤ 13 K15 is exact in one pass.
      if (k <= 13) expect(r.iterations).toBe(0);
      expect(r.converged).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// 3. ∫_0^{2π} e^{it} dt = 0 — the canonical complex-codomain probe
// -----------------------------------------------------------------------------
//
// e^{it} = cos t + i sin t. Both components integrate to zero over the
// full period. Cancellation is total — the load-bearing claim is that
// the centred-delta K-G identity, ported component-wise, doesn't
// introduce per-component bias on either real or imaginary part.
//
// Honest-scope caveat (mirrors the BF driver's `1/(1+x²)` honest-scope
// test): for an integral whose true value is *exactly zero* on a
// non-polynomial integrand, the strict K-G convergence test
// `errorEstimate ≤ atol + rtol·|value|` collapses to `errorEstimate ≤
// atol`, which K15+adaptive cannot satisfy within practical budget at
// high precision (~10^(prec/13) bisections required vs the default
// budget's `prec·200`). The Cauchy value-stability test also cannot
// fire on `value → 0` because its threshold scales with `cabs(value)`.
// Both are *honest* algorithm limits — the value is correct; the
// convergence flag accurately reflects "K-G error estimator's algebraic
// rate hasn't reached atol within the iteration budget." We assert
// value-correctness (the load-bearing capability claim) and
// convergence-flag honesty (a `false` flag is accompanied by a warning
// that explains why).

describe("∫_0^{2π} e^{i·t} dt = 0 (value correctness; convergence honest about budget)", () => {
  // 30 dps fits in the default budget; 50 / 80 dps run out of K-G
  // iterations before reaching `errorEstimate ≤ atol = 10^-prec`.
  // Both regimes assert value-correctness; the second additionally
  // checks the convergence flag is *honestly* `false` with a warning.
  for (const prec of [30, 50, 80]) {
    test(`at ${prec} dps — value matches zero to working precision`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = mul(fromInt(2n), pi(work), work);
      const f = (t: BigFloat, p: number): BigComplex => {
        return { re: cos(t, p), im: sin(t, p) };
      };
      // Bump budget a bit at high precision so 80 dps doesn't hit
      // wall-clock; even at this budget K-G can't satisfy `≤ 10^-50`
      // for an integral that is *exactly zero* — that's the honest
      // limit.
      const r = gaussKronrodAdaptiveBC(f, a, b, prec, {
        maxEvals: Math.max(prec * 200, 6000),
      });
      const truth = cfromReal(fromInt(0n));
      // Both components below 10^-(prec-2) — load-bearing claim.
      const tol = mul(
        fromInt(10n),
        powInt(fromInt(10n), -(prec - 2), work),
        work,
      );
      expect(cmp(cabsDiffMax(r.value, truth, work), tol) <= 0).toBe(true);
      // Convergence flag is honest: if `false`, there must be a
      // warning explaining why (budget hit before strict K-G).
      if (!r.converged) {
        expect(r.warnings.length).toBeGreaterThan(0);
      }
    }, 30000);
  }
});

// -----------------------------------------------------------------------------
// 4. Cross-precision agreement with mpmath oracle
// -----------------------------------------------------------------------------
//
// ∫_0^1 (cos(t) + i·sin(t)) dt = sin(1) + i·(1 - cos(1))
//
// (Both real and imag are entire; the F.T. of cos/sin to its definite
// integrals is the textbook test; numbers cited from mpmath at 130 dps
// truncated/rounded to 110 dps.)

const SIN_1_110 =
  "0.84147098480789650665250232163029899962256306079837106567275170999191040439123966894863974354305269585434903791";
const ONE_MINUS_COS_1_110 =
  "0.45969769413186028259906339255702339626768957938207777232990274461889960522552823548204814391281691065642826884";

describe("∫_0^1 (cos(t) + i·sin(t)) dt = sin(1) + i·(1 - cos(1))", () => {
  for (const prec of [30, 50, 80]) {
    test(`at ${prec} dps`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const a = fromInt(0n);
      const b = fromInt(1n);
      const f = (t: BigFloat, p: number): BigComplex => ({
        re: cos(t, p),
        im: sin(t, p),
      });
      const r = gaussKronrodAdaptiveBC(f, a, b, prec);
      const truth: BigComplex = {
        re: bf(SIN_1_110, work),
        im: bf(ONE_MINUS_COS_1_110, work),
      };
      const tol = mul(
        fromInt(10n),
        powInt(fromInt(10n), -(prec - 2), work),
        work,
      );
      expect(cmp(cabsDiffMax(r.value, truth, work), tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// 5. Bit-determinism — ADR-0020's strongest guarantee
// -----------------------------------------------------------------------------

test("bit-determinism: two runs produce byte-identical BigComplex result", () => {
  const work = decimalToBinaryPrecision(30, 30);
  const a = fromInt(0n);
  const b = pi(work);
  const f = (t: BigFloat, p: number): BigComplex => ({
    re: sin(t, p),
    im: cos(t, p),
  });
  const r1 = gaussKronrodAdaptiveBC(f, a, b, 30);
  const r2 = gaussKronrodAdaptiveBC(f, a, b, 30);
  expect(r1.value.re.mantissa).toBe(r2.value.re.mantissa);
  expect(r1.value.re.exponent).toBe(r2.value.re.exponent);
  expect(r1.value.re.precision).toBe(r2.value.re.precision);
  expect(r1.value.im.mantissa).toBe(r2.value.im.mantissa);
  expect(r1.value.im.exponent).toBe(r2.value.im.exponent);
  expect(r1.value.im.precision).toBe(r2.value.im.precision);
  expect(r1.errorEstimate.mantissa).toBe(r2.errorEstimate.mantissa);
  expect(r1.errorEstimate.exponent).toBe(r2.errorEstimate.exponent);
  expect(r1.nEvals).toBe(r2.nEvals);
  expect(r1.iterations).toBe(r2.iterations);
});

// -----------------------------------------------------------------------------
// 6. Convergence-flag honesty under tight budget
// -----------------------------------------------------------------------------
//
// Same shape as the BF driver's oscillatory test, lifted to complex.
// `e^{1000·i·t}` over [0, 1] has 159 cycles; tight budget cannot resolve
// them. Convergence must report false with a warning.

test("oscillatory complex integrand under tight budget honestly reports non-convergence", () => {
  const work = decimalToBinaryPrecision(30, 30);
  const a = fromInt(0n);
  const b = fromInt(1n);
  const ONE_THOUSAND = fromInt(1000n);
  const f = (t: BigFloat, p: number): BigComplex => {
    const arg = mul(ONE_THOUSAND, t, p);
    return { re: cos(arg, p), im: sin(arg, p) };
  };
  const r = gaussKronrodAdaptiveBC(f, a, b, 30, { maxEvals: 600 });
  expect(r.converged).toBe(false);
  expect(r.warnings.length).toBeGreaterThan(0);
  expect(r.nEvals).toBeLessThanOrEqual(600);
  // Reference at higher budget for an honest-error comparison.
  const ref = gaussKronrodAdaptiveBC(f, a, b, 30, { maxEvals: 6000 });
  const errActualReal = absDiff(r.value.re, ref.value.re, work);
  const errActualImag = absDiff(r.value.im, ref.value.im, work);
  // errorEstimate is real |K-G|·|h| — should upper-bound (within factor
  // of two) the per-component actual errors. Use the larger of the two
  // since cabs ≥ |re|, |im| always.
  const errMax = cmp(errActualReal, errActualImag) >= 0
    ? errActualReal
    : errActualImag;
  const halfErr: BigFloat = {
    mantissa: errMax.mantissa,
    exponent: errMax.exponent - 1,
    precision: errMax.precision,
  };
  expect(cmp(r.errorEstimate, halfErr) >= 0).toBe(true);
}, 30000);

// -----------------------------------------------------------------------------
// 7. Boundary behaviour
// -----------------------------------------------------------------------------

describe("boundary behaviour", () => {
  test("prec > MAX_DECIMAL_PRECISION throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBC(
        (x, _p) => cfromReal(x),
        fromInt(0n),
        fromInt(1n),
        MAX_DECIMAL_PRECISION + 1,
      );
    }).toThrow(RangeError);
  });

  test("prec < 1 throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBC(
        (x, _p) => cfromReal(x),
        fromInt(0n),
        fromInt(1n),
        0,
      );
    }).toThrow(RangeError);
  });

  test("non-integer prec throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBC(
        (x, _p) => cfromReal(x),
        fromInt(0n),
        fromInt(1n),
        50.5,
      );
    }).toThrow(RangeError);
  });

  test("a >= b throws BigComplexQuadratureError", () => {
    expect(() => {
      gaussKronrodAdaptiveBC(
        (x, _p) => cfromReal(x),
        fromInt(1n),
        fromInt(0n),
        30,
      );
    }).toThrow(BigComplexQuadratureError);
    expect(() => {
      gaussKronrodAdaptiveBC(
        (x, _p) => cfromReal(x),
        fromInt(1n),
        fromInt(1n),
        30,
      );
    }).toThrow(BigComplexQuadratureError);
  });

  test("maxEvals < 15 throws RangeError", () => {
    expect(() => {
      gaussKronrodAdaptiveBC(
        (x, _p) => cfromReal(x),
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
      gaussKronrodAdaptiveBC(
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
// 8. Default-tolerance scaling
// -----------------------------------------------------------------------------

describe("default tolerance scales with precision", () => {
  for (const prec of [30, 50, 70]) {
    test(`constant complex integrand at ${prec} dps gives error ≤ default tol`, () => {
      const work = decimalToBinaryPrecision(prec, 30);
      const r = gaussKronrodAdaptiveBC(
        (_x, _p) => cfromInts(1n, 2n, _p),
        fromInt(0n),
        fromInt(1n),
        prec,
      );
      // Constant integrand: K-G = 0; first-pass convergence;
      // errorEstimate ≤ 10^-prec.
      const tol = powInt(fromInt(10n), -prec, work);
      expect(cmp(r.errorEstimate, tol) <= 0).toBe(true);
      expect(r.converged).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// 9. Result shape
// -----------------------------------------------------------------------------

test("BigComplexQuadResult populates precision / workingPrecision / method", () => {
  const r = gaussKronrodAdaptiveBC(
    (x, _p) => ({ re: x, im: x }),
    fromInt(0n),
    fromInt(1n),
    50,
  );
  expect(r.precision).toBe(50);
  expect(r.workingPrecision).toBe(decimalToBinaryPrecision(50, 30));
  expect(r.method).toBe("gauss-kronrod-g7k15-bigcomplex");
  // Both result components precision matches the requested decimal
  // precision expressed in bits (no safety margin in public output).
  expect(r.value.re.precision).toBe(decimalToBinaryPrecision(50, 0));
  expect(r.value.im.precision).toBe(decimalToBinaryPrecision(50, 0));
});

// -----------------------------------------------------------------------------
// 10. Linearity probe — ∫ (a·f + b·g) = a·∫f + b·∫g
// -----------------------------------------------------------------------------
//
// Check that the BC driver respects integrand linearity in the complex
// codomain to working precision. We integrate sin(t), cos(t), and
// cos(t) + i·sin(t) separately, then verify the third equals the
// component-wise combination.

test("linearity: ∫(cos + i·sin) = ∫cos + i·∫sin (component-wise)", () => {
  const prec = 50;
  const work = decimalToBinaryPrecision(prec, 30);
  const a = fromInt(0n);
  const b = fromInt(1n);
  const fSin = (t: BigFloat, p: number) => sin(t, p);
  const fCos = (t: BigFloat, p: number) => cos(t, p);
  const fCombined = (t: BigFloat, p: number): BigComplex => ({
    re: cos(t, p),
    im: sin(t, p),
  });
  const rSin = gaussKronrodAdaptiveBF(fSin, a, b, prec);
  const rCos = gaussKronrodAdaptiveBF(fCos, a, b, prec);
  const rCombined = gaussKronrodAdaptiveBC(fCombined, a, b, prec);
  // Both runs should reach the same K-G/Cauchy convergence state.
  // We only require value agreement to working precision tol.
  const tol = mul(
    fromInt(10n),
    powInt(fromInt(10n), -(prec - 2), work),
    work,
  );
  expect(cmp(absDiff(rCombined.value.re, rCos.value, work), tol) <= 0).toBe(true);
  expect(cmp(absDiff(rCombined.value.im, rSin.value, work), tol) <= 0).toBe(true);
});
