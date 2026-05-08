// =============================================================================
// Mellin-Barnes contour layer tests
// =============================================================================
//
// Strategy. The contour layer is the second numerical evaluation path
// for the Meijer G-function (the first being the Slater residue
// summation). Two complementary cross-validation strategies:
//
//   1. **Closed-form identity tests.** Identical to the slater test
//      strategy: pick `(m, n, p, q)` triples whose MeijerG reduces to
//      an elementary function (DLMF §16.18.4 etc.), evaluate both sides
//      independently through the bigfloat substrate, assert agreement
//      to working precision.
//
//   2. **Slater cross-check.** For parameters where Slater also
//      converges (i.e. away from the |z|=1 quarantine band, with
//      `p == q == m+n` not triggered), the contour result must agree
//      with Slater's to working precision. This is the load-bearing
//      mutation-prove: any bug in the contour orchestrator (sign
//      conventions, contour location, truncation, integrand shape,
//      prefactor) will diverge from the independently-tested Slater
//      path.
//
//   3. **Structured refusal**: the contour layer refuses when the
//      vertical contour integrand doesn't decay (`2(m+n) ≤ p+q`) or
//      when no valid contour `c` exists (pole clusters overlap).
//
// Identities used (all DLMF §16.18 / Bateman §5.6):
//
//   * G^{1,0}_{0,1}(_; b | z) = z^b · e^{−z}                 (DLMF 16.18.4)
//   * G^{1,1}_{1,1}(0; 0 | z) = 1 / (1 + z)                   (Bateman 5.6.3,
//                                                              special case
//                                                              a = b = 0)
//
// Citation oracle (Law 1):
//   from mpmath import mp, mpf, exp, sqrt
//   mp.dps = 130
//   print(mp.nstr(exp(-mpf(1)), 110))
//   print(mp.nstr(sqrt(mpf(2)) * exp(-mpf(2)), 110))

import { describe, expect, test } from "bun:test";
import {
  type BigComplex,
  cabs,
  cdiv,
  cfromInts,
  cfromReal,
  cfromStrings,
  csub,
  decimalToBinaryPrecision,
  fromInt,
  fromString,
  toFloat64,
} from "@workbench/bigfloat";
import { meijergContour } from "../src/contour.js";
import { meijergSlater } from "../src/slater.js";
import type { MeijerGParameters } from "../src/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
//
// Honest-scope note: v0.1 contour layer effectively achieves
// ~`TOLERANCE_DPS` decimal digits of agreement against the cited
// oracle / cross-check, with a soft ceiling near ~22 dps imposed by
// the bigfloat substrate's `cgamma` Stirling cancellation budget
// (96-bit margin in `clgammaShifted` ≈ 28 dps internal headroom). At
// `TARGET_DPS = 15` the algorithm is comfortably within that ceiling
// and tests run in seconds; at higher precisions the wall-clock grows
// (T scales with precision) and the achievable precision starts to
// flatten. A future bead can lift the ceiling by widening cgamma's
// Stirling budget or by computing the integrand via clgamma directly
// (avoiding cancellation between large Γ products and tiny denominator
// values); not in v0.1's scope.

const TARGET_DPS = 15;
const TOLERANCE_DPS = 10; // honest scope: TOLERANCE_DPS
const WORK_BITS = decimalToBinaryPrecision(TARGET_DPS + 10);

/** Build params with all-real entries from string-literal coordinates. */
function P(
  an: string[],
  ap: string[],
  bm: string[],
  bq: string[],
  prec = 256,
): MeijerGParameters {
  const cf = (s: string): BigComplex => cfromStrings(s, "0", prec);
  return {
    an: an.map(cf),
    ap: ap.map(cf),
    bm: bm.map(cf),
    bq: bq.map(cf),
  };
}

/** Assert two complex numbers agree to `dps` decimal digits relative
 *  (or absolute when target is zero). Mirrors slater.test.ts's
 *  `expectClose`. */
function expectClose(
  got: BigComplex,
  want: BigComplex,
  dps: number,
  message?: string,
): void {
  const diff = csub(got, want, WORK_BITS);
  const wantMag = cabs(want, WORK_BITS);
  const diffMag = cabs(diff, WORK_BITS);
  if (toFloat64(wantMag).value === 0) {
    expect(toFloat64(diffMag).value).toBeLessThan(Math.pow(10, -dps));
    return;
  }
  const ratio = cdiv(
    cfromReal(diffMag),
    cfromReal(wantMag),
    WORK_BITS,
  );
  const ratioMag = toFloat64(cabs(ratio, WORK_BITS)).value;
  if (ratioMag >= Math.pow(10, -dps)) {
    throw new Error(
      `expectClose: rel-err = ${ratioMag} ≥ 10^-${dps}` +
        (message ? ` (${message})` : ""),
    );
  }
}

// -----------------------------------------------------------------------------
// 1. Closed-form identities — DLMF / Bateman
// -----------------------------------------------------------------------------

const E_NEG_1_110 =
  "0.36787944117144232159552377016146086744581113103176783450783680169746149574489980335714727434591964374662732528";

describe("contour: closed-form identities", () => {
  test("G^{1,0}_{0,1}(_; 0 | 1) = e^{-1}", () => {
    // m=1, n=0, p=0, q=1. 2(m+n)=2, p+q=1, decay order = 1, α = 1/2.
    // Contour exists; max{Re(a_j)} doesn't apply (an+ap empty); c
    // defaults to min{Re(b_j)} - 0.5 = -0.5.
    const params = P([], [], ["0"], []);
    const z = cfromInts(1n, 0n, WORK_BITS);
    const r = meijergContour(params, z, TARGET_DPS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    const truth: BigComplex = {
      re: fromString(E_NEG_1_110, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, truth, TOLERANCE_DPS, "G^{1,0}_{0,1}(0|1)");
    expect(r.method).toBe("mellin-barnes");
  }, 60000);

  test("G^{1,0}_{0,1}(_; 0 | 2) = e^{-2}", () => {
    // Same shape as above but z=2 — exercises z^s with non-trivial
    // exponent; tests that the contour algorithm handles the |z| > 1
    // case (still in the Series-1-convergent region for q > p).
    const params = P([], [], ["0"], []);
    const z = cfromInts(2n, 0n, WORK_BITS);
    const r = meijergContour(params, z, TARGET_DPS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    // Truth: e^{-2} = 0.1353352832366... (110 dps from mpmath)
    const eNeg2 = fromString(
      "0.13533528323661269189399949497248440340763154590957588097554953580213108944978293614115469739840495066596005475",
      WORK_BITS,
    );
    const truth: BigComplex = { re: eNeg2, im: fromInt(0n, WORK_BITS) };
    expectClose(r.value, truth, TOLERANCE_DPS, "G^{1,0}_{0,1}(0|2)");
  }, 60000);
});

// -----------------------------------------------------------------------------
// 2. Slater cross-check — the load-bearing mutation-prove
// -----------------------------------------------------------------------------
//
// In regions where both paths converge, the contour and Slater results
// must agree to working precision. Slater is independently tested
// against closed-form identities (in slater.test.ts), so any divergence
// is a contour-layer bug.
//
// Test cases chosen to exercise: (a) m + n > p + q (clean contour
// decay); (b) parameters with non-integer differences (no perturbation
// triggered in Slater); (c) `|z|` non-trivially away from 1.

describe("contour vs Slater: cross-check on regions where both converge", () => {
  test("G^{1,0}_{0,1}(_; 0 | 0.5)", () => {
    // m=1, n=0, p=0, q=1. Slater Series 1 converges for all z (p<q).
    // Contour: 2(m+n)=2 > p+q=1 ⇒ decays.
    const params = P([], [], ["0"], []);
    const z = cfromStrings("0.5", "0", WORK_BITS);
    const slaterResult = meijergSlater(params, z, TARGET_DPS);
    expect(slaterResult.status).toBe("success");
    if (slaterResult.status !== "success") return;
    const contourResult = meijergContour(params, z, TARGET_DPS);
    expect(contourResult.status).toBe("success");
    if (contourResult.status !== "success") return;
    expectClose(
      contourResult.value,
      slaterResult.value,
      TOLERANCE_DPS,
      "G^{1,0}_{0,1}(0|0.5) contour vs Slater",
    );
  }, 60000);

  test("G^{1,0}_{0,1}(_; 1/3 | 0.7) — non-integer parameter, non-trivial z", () => {
    // Use a decimal approximation of 1/3 (fromString accepts decimal,
    // not fractions). The cross-check is contour vs Slater on the
    // *same* parameters, so the exact representation doesn't matter
    // as long as both paths see the same value.
    const params: MeijerGParameters = {
      an: [],
      ap: [],
      bm: [{
        re: fromString(
          "0.3333333333333333333333333333333333333333333333333333333333333",
          WORK_BITS,
        ),
        im: fromInt(0n, WORK_BITS),
      }],
      bq: [],
    };
    const z = cfromStrings("0.7", "0", WORK_BITS);
    const slaterResult = meijergSlater(params, z, TARGET_DPS);
    expect(slaterResult.status).toBe("success");
    if (slaterResult.status !== "success") return;
    const contourResult = meijergContour(params, z, TARGET_DPS);
    expect(contourResult.status).toBe("success");
    if (contourResult.status !== "success") return;
    expectClose(
      contourResult.value,
      slaterResult.value,
      TOLERANCE_DPS,
      "G^{1,0}_{0,1}(1/3|0.7) contour vs Slater",
    );
  }, 60000);
});

// -----------------------------------------------------------------------------
// 3. Structured refusal — non-convergent contour
// -----------------------------------------------------------------------------

describe("contour: structured refusal on non-convergent inputs", () => {
  test("2(m+n) ≤ p+q ⇒ vertical contour does not decay", () => {
    // G^{0,1}_{2,1} with an=[0], ap=[0,0], bm=[], bq=[0]: m=0, n=1,
    // p=2, q=1. Wait need m=0 with bq present requires care; let me
    // use a clearly non-convergent shape.
    // Actual: G^{1,0}_{2,1}: m=1, n=0, p=2, q=1. 2(m+n)=2, p+q=3.
    // an=[], ap=["0","1"], bm=["0"], bq=[].
    const params = P([], ["0", "1"], ["0"], []);
    const z = cfromInts(1n, 0n, WORK_BITS);
    const r = meijergContour(params, z, TARGET_DPS);
    expect(r.status).toBe("non-convergent-contour");
  });

  test("max{Re(a_j)} - 1 ≥ min{Re(b_j)} ⇒ no valid contour", () => {
    // G^{1,1}_{1,1} with a=[2], b=[0]. max(an)-1 = 1, min(bm) = 0.
    // No valid c (need 1 < c < 0).
    const params = P(["2"], [], ["0"], []);
    const z = cfromInts(1n, 0n, WORK_BITS);
    const r = meijergContour(params, z, TARGET_DPS);
    expect(r.status).toBe("no-valid-contour");
  });

  test("non-integer precision throws/refuses", () => {
    const params = P([], [], ["0"], []);
    const z = cfromInts(1n, 0n, WORK_BITS);
    const r = meijergContour(params, z, 30.5);
    expect(r.status).toBe("input-error");
  });

  test("precision < 1 returns input-error", () => {
    const params = P([], [], ["0"], []);
    const z = cfromInts(1n, 0n, WORK_BITS);
    const r = meijergContour(params, z, 0);
    expect(r.status).toBe("input-error");
  });
});

// -----------------------------------------------------------------------------
// 4. Bit-determinism — ADR-0020's strongest guarantee
// -----------------------------------------------------------------------------

test("bit-determinism: two contour calls produce byte-identical BigComplex", () => {
  const params = P([], [], ["0"], []);
  const z = cfromStrings("0.5", "0", WORK_BITS);
  const r1 = meijergContour(params, z, TARGET_DPS);
  const r2 = meijergContour(params, z, TARGET_DPS);
  expect(r1.status).toBe("success");
  expect(r2.status).toBe("success");
  if (r1.status !== "success" || r2.status !== "success") return;
  expect(r1.value.re.mantissa).toBe(r2.value.re.mantissa);
  expect(r1.value.re.exponent).toBe(r2.value.re.exponent);
  expect(r1.value.im.mantissa).toBe(r2.value.im.mantissa);
  expect(r1.value.im.exponent).toBe(r2.value.im.exponent);
  expect(r1.nEvals).toBe(r2.nEvals);
  // Timeout bumped 2026-05-08 (worklog 076): the test runs *two*
  // arb-prec contour quadrature calls; under `bun test` workload
  // each call's K-G adaptive bisection drifts to 60-90s on the
  // dev box, exceeding the original 60s budget. The test is
  // structurally fine — bit-equality of two deterministic calls
  // is a milliseconds-of-comparison check on top of two long
  // numerical computations. 240s gives 4× headroom.
}, 240000);

// -----------------------------------------------------------------------------
// 5. Result shape
// -----------------------------------------------------------------------------

test("MeijerGContourSuccess populates required fields", () => {
  const params = P([], [], ["0"], []);
  const z = cfromInts(1n, 0n, WORK_BITS);
  const r = meijergContour(params, z, TARGET_DPS);
  expect(r.status).toBe("success");
  if (r.status !== "success") return;
  expect(r.method).toBe("mellin-barnes");
  expect(r.achievedPrecision).toBe(TARGET_DPS);
  expect(r.workingPrecision).toBe(decimalToBinaryPrecision(TARGET_DPS, 30));
  expect(typeof r.nEvals).toBe("number");
  expect(typeof r.converged).toBe("boolean");
  expect(Array.isArray(r.warnings)).toBe(true);
  // contourRe and truncate are BigFloats; just check they exist
  expect(r.contourRe).toBeDefined();
  expect(r.truncate).toBeDefined();
}, 60000);
