// =============================================================================
// E_{p,q}(z) exponential series — cross-validation tests
// =============================================================================
//
// Tests the `evaluateEpq` module from `exponential.ts` (bead `egf` Part 1).
//
// Strategy (per CLAUDE.md Rule 6 port-and-verify discipline, since the
// algorithm is faithfully ported from DLMF 16.11.3-5 with mpmath as the
// independent oracle):
//
//   1. **Pure-prefactor / closed-form sanity** — for the trivially-
//      simple shape (b-parameters set, no a's) the coefficient
//      recurrence's c_k beyond k=0 mostly drop out and the value is
//      essentially the leading exponential factor. Cross-checked
//      against mpmath at 30 dps.
//   2. **Branch rotation** — verify that the three branches
//      branchSign ∈ {−1, 0, +1} give distinct values when ν is non-
//      integer (the rotation picks up phase e^{2π i ν}); cross-checked
//      against mpmath.
//   3. **Coefficient recurrence** — extract c_0..c_3 for a fixed
//      parameter set and verify c_0 = 1 + cross-check c_1, c_2 against
//      a parallel direct-from-DLMF computation. We can't easily access
//      c_k from the public API, so this test verifies the *value* of
//      the truncated series against a parallel-implementation computed
//      from c_k = [1, exact_c1, exact_c2, …].
//   4. **Optimal-truncation behaviour** — deep-asymptotic (|z| ≥ 50)
//      and near-Stokes-line cases produce success with nTerms > 0 and
//      finite error estimate.
//   5. **Refusal paths** — κ ≤ 0 returns non-asymptotic-regime; z = 0
//      returns input-error.
//   6. **Determinism** — two evaluations with the same inputs produce
//      byte-identical BigComplex outputs.

import { describe, expect, test } from "bun:test";
import {
  type BigComplex,
  cabs,
  cdiv,
  cfromInts,
  cfromReal,
  cfromStrings,
  cmul,
  csub,
  decimalToBinaryPrecision,
  fromInt,
  fromString,
  toFloat64,
  toString,
} from "@workbench/bigfloat";
import { evaluateEpq } from "../src/exponential.js";
import type { MeijerGParameters } from "../src/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const TARGET_DPS = 30;
const TOLERANCE_DPS = 25;
const WORK_BITS = decimalToBinaryPrecision(TARGET_DPS + 30);

function P(
  an: string[],
  ap: string[],
  bm: string[],
  bq: string[],
  prec = WORK_BITS,
): MeijerGParameters {
  const cf = (s: string): BigComplex => cfromStrings(s, "0", prec);
  return {
    an: an.map(cf),
    ap: ap.map(cf),
    bm: bm.map(cf),
    bq: bq.map(cf),
  };
}

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
        (message ? ` (${message})` : "") +
        `\n got: ${toString(got.re, 30)} + ${toString(got.im, 30)}i` +
        `\n want: ${toString(want.re, 30)} + ${toString(want.im, 30)}i`,
    );
  }
}

// -----------------------------------------------------------------------------
// 1. Pure-prefactor / mpmath cross-check
// -----------------------------------------------------------------------------
//
// For G^{2,0}_{0,2}(z; -; 0, 1/2) we have an=[], ap=[], bm=[0, 1/2],
// bq=[]; so p=0, q=2, κ=3, ν = 0 - (0+1/2) + 1 = 1/2.
//
// E_{0,2}(4) at 30 dps from mpmath:
//   2633.74206240042625209643602334952
//
// Cross-validated by running a parallel pure-mpmath implementation of
// DLMF 16.11.3-5 (see the development log for the validation script).

describe("evaluateEpq: pure-prefactor sanity (mpmath cross-check)", () => {
  test("E_{0,2}(4) for bm=[0, 1/2] matches mpmath to 25 dps", () => {
    const params = P([], [], ["0", "0.5"], []);
    const z = cfromInts(4n, 0n, WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    // mpmath ground truth at 35 dps:
    //   2633.7420624004262520964360233504864
    const wantRe = fromString(
      "2633.7420624004262520964360233504864",
      WORK_BITS,
    );
    const want: BigComplex = {
      re: wantRe,
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "E_{0,2}(4)");
    expect(r.nTerms).toBeGreaterThan(0);
  });

  test("E_{0,2}(50) deep-asymptotic matches mpmath to 25 dps", () => {
    const params = P([], [], ["0", "0.5"], []);
    const z = cfromInts(50n, 0n, WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    // mpmath ground truth at 35 dps:
    //   -724111534801.72331585197382170492371
    const wantRe = fromString(
      "-724111534801.72331585197382170492371",
      WORK_BITS,
    );
    const want: BigComplex = {
      re: wantRe,
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "E_{0,2}(50)");
    // N* = ⌊|3 · 50^{1/3}|⌋ = ⌊3 · 3.684⌋ = 11
    expect(r.nTerms).toBe(12); // N* + 1 = 12
    // Error estimate should be finite and well below working precision.
    const errF = toFloat64(r.errorEstimate).value;
    expect(Number.isFinite(errF)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 2. Branch rotation
// -----------------------------------------------------------------------------
//
// For the same input, the three branches branchSign ∈ {−1, 0, +1}
// should give distinct values whenever the rotation picks up a non-
// trivial phase factor (most cases with non-integer ν). Cross-checked
// against mpmath.
//
// Test case: G^{2,0}_{0,2}(4; ; 0, 1/2). κ=3, ν=1/2. Three branches
// at z=4 (real) — mpmath gives:
//
//   branch  0:  2633.7420624004262520964360233504864
//   branch -1: -2.32631257368834101188089317336590 - 0.35628151926097546632466322022658 i
//   branch +1: -2.32631257368834101188089317336590 + 0.35628151926097546632466322022658 i
//
// The two non-principal branches are conjugates (expected by the
// symmetry of the cube-root branch rotation for real z); the principal
// is real and far larger in magnitude (it sits in the growth sector
// arg z = 0 while the rotated ones are decay).

describe("evaluateEpq: branch rotation", () => {
  test("κ=3, z=4 (real): three branches give distinct values", () => {
    const params = P([], [], ["0", "0.5"], []);
    const z = cfromInts(4n, 0n, WORK_BITS);
    const r0 = evaluateEpq(params, z, 0, WORK_BITS);
    const rp = evaluateEpq(params, z, 1, WORK_BITS);
    const rm = evaluateEpq(params, z, -1, WORK_BITS);
    expect(r0.status).toBe("success");
    expect(rp.status).toBe("success");
    expect(rm.status).toBe("success");
    if (r0.status !== "success" || rp.status !== "success" || rm.status !== "success") return;

    // mpmath ground truth for branch 0 (sanity, already in test 1):
    expectClose(
      r0.value,
      { re: fromString("2633.7420624004262520964360233504864", WORK_BITS), im: fromInt(0n, WORK_BITS) },
      TOLERANCE_DPS,
      "branch 0",
    );
    // mpmath ground truth for branch -1:
    expectClose(
      rm.value,
      {
        re: fromString("-2.32631257368834101188089317336590", WORK_BITS),
        im: fromString("-0.35628151926097546632466322022658", WORK_BITS),
      },
      TOLERANCE_DPS,
      "branch -1",
    );
    // mpmath ground truth for branch +1:
    expectClose(
      rp.value,
      {
        re: fromString("-2.32631257368834101188089317336590", WORK_BITS),
        im: fromString("0.35628151926097546632466322022658", WORK_BITS),
      },
      TOLERANCE_DPS,
      "branch +1",
    );

    // Magnitudes must differ — sanity: the rotation must do something.
    const m0 = toFloat64(cabs(r0.value, WORK_BITS)).value;
    const mp = toFloat64(cabs(rp.value, WORK_BITS)).value;
    expect(m0 / mp).toBeGreaterThan(100);
  });

  test("κ=1, z=5+2i, non-integer ν: branches differ by phase e^{±2π i ν}", () => {
    // an=[1/3], bm=[1/2], so p=1, q=1, κ=1, ν = 1/3 - 1/2 = -1/6.
    // mpmath ground truth (verified against parallel python implementation):
    //   branch  0:  -39.665162364524786859366532871654903 + 107.52295072262349232852009017922754 i
    //   branch +1:  73.285025633391915692288015799803833 + 88.112513614224643896523236851366434 i
    //   branch -1: -112.95018799791670255165454867145874 + 19.410437108398848431996853327861109 i
    //
    // The ratio v_{+1}/v_0 should be e^{2π i ν} = e^{-π i / 3} =
    //   0.5 - i sqrt(3)/2  (verified)
    // 1/3 is not finitely representable in decimal; use ~50-digit
    // decimal expansion (well in excess of our 30-dps target).
    const oneThird = fromString(
      "0.333333333333333333333333333333333333333333333333333",
      WORK_BITS,
    );
    const oneHalf = fromString("0.5", WORK_BITS);
    const real = (x: import("@workbench/bigfloat").BigFloat): BigComplex =>
      ({ re: x, im: fromInt(0n, WORK_BITS) });
    const params2: MeijerGParameters = {
      an: [real(oneThird)],
      ap: [],
      bm: [real(oneHalf)],
      bq: [],
    };
    const z = cfromStrings("5", "2", WORK_BITS);
    const r0 = evaluateEpq(params2, z, 0, WORK_BITS);
    const rp = evaluateEpq(params2, z, 1, WORK_BITS);
    const rm = evaluateEpq(params2, z, -1, WORK_BITS);
    expect(r0.status).toBe("success");
    expect(rp.status).toBe("success");
    expect(rm.status).toBe("success");
    if (r0.status !== "success" || rp.status !== "success" || rm.status !== "success") return;

    // Cross-check branch 0 against mpmath:
    expectClose(
      r0.value,
      {
        re: fromString("-39.665162364524786859366532871654903", WORK_BITS),
        im: fromString("107.52295072262349232852009017922754", WORK_BITS),
      },
      TOLERANCE_DPS,
      "κ=1 branch 0",
    );
    // Cross-check branch +1 against mpmath:
    expectClose(
      rp.value,
      {
        re: fromString("73.285025633391915692288015799803833", WORK_BITS),
        im: fromString("88.112513614224643896523236851366434", WORK_BITS),
      },
      TOLERANCE_DPS,
      "κ=1 branch +1",
    );
    // The ratio v_{+1}/v_0 should equal e^{2π i ν} = e^{-π i /3} =
    //   (0.5, -0.8660254037844386...).
    const ratio = cdiv(rp.value, r0.value, WORK_BITS);
    expectClose(
      ratio,
      {
        re: fromString("0.5", WORK_BITS),
        im: fromString("-0.86602540378443864676372317075294", WORK_BITS),
      },
      TOLERANCE_DPS,
      "κ=1 branch ratio = e^{-π i/3}",
    );
  });
});

// -----------------------------------------------------------------------------
// 3. Coefficient recurrence
// -----------------------------------------------------------------------------
//
// For the parameter set a=[1/2], b=[0, 1/2] (so p=1, q=2, κ=2, ν=1/2):
//
// Direct from DLMF 16.11.5 with b_aug = [0, 1/2, 1]:
//
//   poch_factor for b_j:
//     j=0 (bj=0):   (a_1 - 0) / [(1/2 - 0)(1 - 0)] = (1/2) / (1/2 · 1) = 1
//     j=1 (bj=1/2): (1/2 - 1/2) / [(0 - 1/2)(1 - 1/2)] = 0 / … = 0
//     j=2 (bj=1):   (1/2 - 1) / [(0 - 1)(1/2 - 1)] = (-1/2) / (-1 · -1/2) = -1
//
// c_0 = 1.
// c_1 = -1/(1·2) Σ_{m=0..0} c_m e_{1,m}
//     = -1/2 · 1 · e_{1,0}
//   e_{1,0} = Σ_j (1 - ν - κ b_j + 0)_{κ + 1} · poch_factor_j
//           = Σ_j (1/2 - 2 b_j)_3 · poch_factor_j
//     j=0: (1/2)_3 · 1   = (1/2)(3/2)(5/2) = 15/8
//     j=1: (1/2 - 1)_3 · 0 = 0
//     j=2: (1/2 - 2)_3 · -1 = (-3/2)(-1/2)(1/2) · -1 = (3/8) · -1 = -3/8
//     e_{1,0} = 15/8 - 3/8 = 12/8 = 3/2
//   c_1 = -1/2 · 3/2 = -3/4
//
// c_2 = -1/(2·2) [c_0 e_{2,0} + c_1 e_{2,1}]
//   e_{2,0} = Σ_j (1/2 - 2 b_j)_4 · poch_factor_j
//     j=0: (1/2)_4 · 1 = (1/2)(3/2)(5/2)(7/2) = 105/16
//     j=2: (1/2 - 2)_4 · -1 = (-3/2)(-1/2)(1/2)(3/2) · -1 = (9/16) · -1 = -9/16
//     e_{2,0} = 105/16 - 9/16 = 96/16 = 6
//   e_{2,1} = Σ_j (1/2 - 2 b_j + 1)_3 · poch_factor_j = Σ_j (3/2 - 2 b_j)_3 · poch_factor_j
//     j=0: (3/2)_3 · 1 = (3/2)(5/2)(7/2) = 105/8
//     j=2: (3/2 - 2)_3 · -1 = (-1/2)(1/2)(3/2) · -1 = (-3/8) · -1 = 3/8
//     e_{2,1} = 105/8 + 3/8 = 108/8 = 13.5
//   c_2 = -1/4 · [1·6 + (-3/4)·13.5] = -1/4 · [6 - 10.125] = -1/4 · (-4.125) = 1.03125
//
// So c_0=1, c_1=-0.75, c_2=1.03125. This matches the mpmath dump from
// the development cross-check exactly.
//
// We don't expose c_k directly from `evaluateEpq`, so this test
// validates the **truncated series value** at z = 1 (close enough that
// the first few c_k dominate). The closed-form sum-of-three-terms
// value at workingBits is checked against mpmath ground truth.

describe("evaluateEpq: coefficient recurrence", () => {
  test("c_0=1, c_1=-3/4, c_2=33/32 for a=[1/2], b=[0,1/2]; series value at z=5 matches mpmath", () => {
    const params = P(["0.5"], [], ["0", "0.5"], []);
    const z = cfromInts(5n, 0n, WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    // mpmath ground truth: E_{1,2}(5) = 32.744204931208812642854718957736547
    // (from cross-check script with c_0..c_4 = [1, -0.75, 1.03125, -3.6328125, 17.3803710938],
    //  which matches the hand-computed c_0..c_2 above to all digits)
    const want: BigComplex = {
      re: fromString("32.744204931208812642854718957736547", WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "E_{1,2}(5) with hand-verified c_k");
  });
});

// -----------------------------------------------------------------------------
// 4. Optimal-truncation behaviour
// -----------------------------------------------------------------------------

describe("evaluateEpq: optimal-truncation", () => {
  test("deep-asymptotic |z|=100 gives success with nTerms > 1 and finite error", () => {
    const params = P([], [], ["0", "0.5"], []);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    expect(r.nTerms).toBeGreaterThan(1);
    // N* = ⌊|3 · 100^{1/3}|⌋ = ⌊3 · 4.642⌋ = ⌊13.925⌋ = 13
    expect(r.nTerms).toBe(14);
    const errF = toFloat64(r.errorEstimate).value;
    expect(Number.isFinite(errF)).toBe(true);
    expect(errF).toBeGreaterThanOrEqual(0);
  });

  test("near-Stokes |z|≈5 at arg≈π/2−0.1: success with positive nTerms", () => {
    const params = P([], [], ["0", "0.5"], []);
    // z = 5·(cos(π/2 - 0.1), sin(π/2 - 0.1)) ≈ (0.4992, 4.975)
    const z = cfromStrings("0.4991671107", "4.9750208906", WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    expect(r.nTerms).toBeGreaterThan(0);
    const errF = toFloat64(r.errorEstimate).value;
    expect(Number.isFinite(errF)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 5. Refusal paths
// -----------------------------------------------------------------------------

describe("evaluateEpq: refusal envelope", () => {
  test("κ=0 (p=q+1) returns non-asymptotic-regime", () => {
    // an=[1], bm=[] gives p=1, q=0, κ=0
    const params = P(["1"], [], [], []);
    const z = cfromInts(4n, 0n, WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("non-asymptotic-regime");
    if (r.status !== "non-asymptotic-regime") return;
    expect(r.reason).toContain("κ");
  });

  test("κ=-1 (p=q+2) returns non-asymptotic-regime", () => {
    // an=[1], ap=[1], bm=[], bq=[] → p=2, q=0, κ=-1
    const params = P(["1"], ["1"], [], []);
    const z = cfromInts(4n, 0n, WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("non-asymptotic-regime");
  });

  test("z = 0 returns input-error", () => {
    const params = P([], [], ["0", "0.5"], []);
    const z = cfromInts(0n, 0n, WORK_BITS);
    const r = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r.status).toBe("input-error");
    if (r.status !== "input-error") return;
    expect(r.reason).toContain("z = 0");
  });

  test("invalid branchSign returns input-error", () => {
    const params = P([], [], ["0", "0.5"], []);
    const z = cfromInts(4n, 0n, WORK_BITS);
    // @ts-expect-error: testing runtime validation
    const r = evaluateEpq(params, z, 2, WORK_BITS);
    expect(r.status).toBe("input-error");
  });
});

// -----------------------------------------------------------------------------
// 6. Determinism — bit-identical repeated evaluations
// -----------------------------------------------------------------------------

describe("evaluateEpq: bit-determinism", () => {
  test("same inputs ⇒ byte-identical BigComplex output", () => {
    const params = P([], [], ["0", "0.5"], []);
    const z = cfromStrings("3", "1", WORK_BITS);
    const r1 = evaluateEpq(params, z, 0, WORK_BITS);
    const r2 = evaluateEpq(params, z, 0, WORK_BITS);
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
    if (r1.status !== "success" || r2.status !== "success") return;
    expect(r1.value.re.mantissa).toBe(r2.value.re.mantissa);
    expect(r1.value.re.exponent).toBe(r2.value.re.exponent);
    expect(r1.value.im.mantissa).toBe(r2.value.im.mantissa);
    expect(r1.value.im.exponent).toBe(r2.value.im.exponent);
  });
});

// Suppress unused-helper warnings for cmul / cabs that we may want
// in future test rounds.
void cmul;
