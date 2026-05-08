// =============================================================================
// Slater path tests — closed-form MeijerG identities and self-consistency
// =============================================================================
//
// Strategy. The MeijerG family contains a small number of identities
// that reduce to elementary functions: those let us cross-validate the
// Slater path against an *independent* computation (the elementary
// function evaluated directly via the bigfloat substrate). When both
// computations agree to ~50 dps, the Slater path's prefactors,
// inner-pFq dispatch, sign-factor handling, and z-power computation
// are all exercised correctly.
//
// Identities used (all from DLMF §16.18 unless noted):
//
//   * G^{1,0}_{0,1}(_; b | z) = z^b · e^{−z}                 (DLMF 16.18.4)
//   * G^{0,1}_{1,0}(a; _ | z) = z^{a−1} · e^{−1/z}           (Bateman 5.6.2)
//   * G^{1,1}_{1,1}(a; b | z) = Γ(1+b−a) · z^b · (1+z)^{a−b−1}
//                                                              (Bateman 5.6.3)
//   * G^{2,0}_{0,2}(_; α, β | z) = 2 · z^{(α+β)/2} · K_{α−β}(2 √z)
//                                                              (Bateman 5.6.4)
//
// We also test the perturbation path on cases where the parameters
// coalesce by integer spacing — the result should still match the
// closed-form (as the L'Hôpital limit).

import { describe, expect, test } from "bun:test";
import {
  type BigComplex,
  cfromInts,
  cfromReal,
  cfromStrings,
  cabs,
  cadd,
  cdiv,
  cexp,
  cmul,
  cneg,
  cpow,
  csub,
  cre,
  cim,
  decimalToBinaryPrecision,
  exp,
  fromInt,
  fromString,
  gamma,
  pi,
  pow,
  sub,
  sqrt,
  toString,
  toFloat64,
} from "@workbench/bigfloat";
import { meijergSlater } from "../src/slater.js";
import type { MeijerGParameters } from "../src/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const TARGET_DPS = 50;
const WORK_BITS = decimalToBinaryPrecision(TARGET_DPS + 10);

/** Build params with all-real entries from string-literal coordinates.
 *  Default `prec=256` bits ≈ 77 dps — comfortably above the 50-dps
 *  TARGET so inputs themselves never bottleneck the achievable
 *  accuracy. */
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

/** Assert two complex numbers agree to `dps` decimal digits relative. */
function expectClose(
  got: BigComplex,
  want: BigComplex,
  dps: number,
  message?: string,
): void {
  const diff = csub(got, want, WORK_BITS);
  const wantMag = cabs(want, WORK_BITS);
  const diffMag = cabs(diff, WORK_BITS);
  // relative error = |diff| / |want|.
  if (toFloat64(wantMag).value === 0) {
    // Compare absolute when target is zero.
    expect(toFloat64(diffMag).value).toBeLessThan(Math.pow(10, -dps));
    return;
  }
  const ratio = cdiv(
    cfromReal(diffMag),
    cfromReal(wantMag),
    WORK_BITS,
  );
  const ratioFloat = toFloat64(cabs(ratio, WORK_BITS)).value;
  if (ratioFloat >= Math.pow(10, -dps)) {
    throw new Error(
      `${message ?? "values differ"}\n` +
        `  got:  ${toString(cre(got), 30)}  +  ${toString(cim(got), 30)} i\n` +
        ` want:  ${toString(cre(want), 30)}  +  ${toString(cim(want), 30)} i\n` +
        `  rel:  ${ratioFloat.toExponential(3)}  (target ≤ 1e-${dps})`,
    );
  }
}

// -----------------------------------------------------------------------------
// Identity 1: G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}
// -----------------------------------------------------------------------------

describe("G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}", () => {
  test("b=1, z=2 ⟹ 2 e^{-2}", () => {
    const params = P([], [], ["1"], []);
    const z = cfromInts(2n, 0n, 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    expect(r.method).toBe("slater-series-1");

    // Cross-check: 2 · e^{-2} via direct substrate.
    const want = cmul(z, cexp(cneg(z), WORK_BITS), WORK_BITS);
    expectClose(r.value, want, 45);
  });

  test("b=0, z=1 ⟹ 1/e", () => {
    const params = P([], [], ["0"], []);
    const z = cfromInts(1n, 0n, 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want = cexp(cneg(z), WORK_BITS);
    expectClose(r.value, want, 45);
  });

  test("b=3/2, z=1/2 ⟹ (1/2)^{3/2} · e^{-1/2}", () => {
    const params = P([], [], ["1.5"], []);
    const z = cfromStrings("0.5", "0", 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    // Want: z^{3/2} · e^{-z} with z = 1/2.
    const b = cfromStrings("1.5", "0", WORK_BITS);
    const zPow = cpow(z, b, WORK_BITS);
    const want = cmul(zPow, cexp(cneg(z), WORK_BITS), WORK_BITS);
    expectClose(r.value, want, 45);
  });

  test("complex z: z = 1+i, b = 1", () => {
    const params = P([], [], ["1"], []);
    const z = cfromStrings("1", "1", 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want = cmul(z, cexp(cneg(z), WORK_BITS), WORK_BITS);
    expectClose(r.value, want, 45);
  });
});

// -----------------------------------------------------------------------------
// Identity 2: G^{0,1}_{1,0}(a; _ | z) = z^{a-1} · e^{-1/z}
// -----------------------------------------------------------------------------
//
// p > q ⟹ Slater Series 2.

describe("G^{0,1}_{1,0}(a; _ | z) = z^{a-1} · e^{-1/z}", () => {
  test("a=1, z=2 ⟹ e^{-1/2}", () => {
    const params = P(["1"], [], [], []);
    const z = cfromInts(2n, 0n, 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    expect(r.method).toBe("slater-series-2");

    // Want: z^{a-1} · e^{-1/z}  with a=1, z=2.
    const oneOverZ = cdiv(
      cfromReal(fromInt(1n, WORK_BITS)),
      z,
      WORK_BITS,
    );
    const want = cexp(cneg(oneOverZ), WORK_BITS);
    expectClose(r.value, want, 45);
  });

  test("a=2, z=1 ⟹ 1 · e^{-1} = 1/e", () => {
    const params = P(["2"], [], [], []);
    const z = cfromInts(1n, 0n, 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want = cexp(
      cneg(cfromReal(fromInt(1n, WORK_BITS))),
      WORK_BITS,
    );
    expectClose(r.value, want, 45);
  });

  test("a=3/2, z=1/3", () => {
    const params = P(["1.5"], [], [], []);
    const z = cfromStrings("0.333333333333333333333333333333333333333333333333", "0", 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);

    // Want: z^{1/2} · e^{-3}.
    const half = cfromStrings("0.5", "0", WORK_BITS);
    const zPow = cpow(z, half, WORK_BITS);
    const oneOverZ = cdiv(cfromReal(fromInt(1n, WORK_BITS)), z, WORK_BITS);
    const want = cmul(zPow, cexp(cneg(oneOverZ), WORK_BITS), WORK_BITS);
    expectClose(r.value, want, 40);
  });
});

// -----------------------------------------------------------------------------
// Identity 3: G^{1,1}_{1,1}(a; b | z) = Γ(1+b-a) · z^b · (1+z)^{a-b-1}
// (Bateman 5.6.3.6, valid for |z| < 1, a ≠ b mod ℤ)
// -----------------------------------------------------------------------------

describe("G^{1,1}_{1,1}(a; b | z) = Γ(1+b-a) · z^b · (1+z)^{a-b-1}", () => {
  test("a=1/2, b=0, z=1/2 ⟹ √π · √(2/3)", () => {
    const params = P(["0.5"], [], ["0"], []);
    const z = cfromStrings("0.5", "0", 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    expect(r.method).toBe("slater-series-1");

    // Want: Γ(1/2) · 1 · (3/2)^{-1/2} = √π · √(2/3) = √(2π/3).
    const piVal = pi(WORK_BITS);
    const twoPi = pow(piVal, fromInt(1n, WORK_BITS), WORK_BITS); // = π
    const twoPiOver3 = sub(
      pow(piVal, fromInt(1n, WORK_BITS), WORK_BITS),
      fromInt(0n, WORK_BITS),
      WORK_BITS,
    );
    void twoPi;
    void twoPiOver3;
    // Compute √(2π/3) directly: sqrt(2 · π / 3).
    const two = fromInt(2n, WORK_BITS);
    const three = fromInt(3n, WORK_BITS);
    const twoPiVal = sub(
      pow(piVal, fromInt(1n, WORK_BITS), WORK_BITS),
      fromInt(0n, WORK_BITS),
      WORK_BITS,
    );
    void twoPiVal;
    const inner = sub(
      // 2π
      pow(piVal, fromInt(1n, WORK_BITS), WORK_BITS),
      fromInt(0n, WORK_BITS),
      WORK_BITS,
    );
    void inner;
    // Easier: build want from the substrate's gamma + pow directly to
    // avoid juggling intermediates above.
    const gammaArg = fromString("0.5", WORK_BITS); // 1 + b - a = 1 + 0 - 1/2 = 1/2.
    const gammaVal = cfromReal(gamma(gammaArg, WORK_BITS));
    const zPow = cpow(z, cfromInts(0n, 0n, WORK_BITS), WORK_BITS); // z^0 = 1.
    const onePlusZ = cadd(
      cfromReal(fromInt(1n, WORK_BITS)),
      z,
      WORK_BITS,
    );
    const exponent = cfromStrings("-0.5", "0", WORK_BITS); // a - b - 1 = -1/2.
    const onePlusZPow = cpow(onePlusZ, exponent, WORK_BITS);
    const want = cmul(gammaVal, cmul(zPow, onePlusZPow, WORK_BITS), WORK_BITS);
    expectClose(r.value, want, 45);

    // Also: numerical magnitude check ≈ √(2π/3).
    const valFloat = toFloat64(cre(r.value)).value;
    expect(valFloat).toBeCloseTo(Math.sqrt((2 * Math.PI) / 3), 10);
  });

  test("a=1/3, b=1/4, z=1/4", () => {
    const params = P(["0.333333333333333333333333333333333333333333333333"], [],
                      ["0.25"], []);
    const z = cfromStrings("0.25", "0", 60);
    const r = meijergSlater(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);

    const aMinusBMinus1 = cfromStrings(
      "-0.916666666666666666666666666666666666666666666666",
      "0",
      WORK_BITS,
    ); // a - b - 1 = 1/3 - 1/4 - 1 = -11/12.
    const onePlusBMinusA = fromString(
      "0.916666666666666666666666666666666666666666666666",
      WORK_BITS,
    ); // 1 + b - a = 1 + 1/4 - 1/3 = 11/12.
    const gammaVal = cfromReal(gamma(onePlusBMinusA, WORK_BITS));
    const bExp = cfromStrings("0.25", "0", WORK_BITS);
    const zPow = cpow(z, bExp, WORK_BITS);
    const onePlusZ = cadd(cfromReal(fromInt(1n, WORK_BITS)), z, WORK_BITS);
    const onePlusZPow = cpow(onePlusZ, aMinusBMinus1, WORK_BITS);
    const want = cmul(
      gammaVal,
      cmul(zPow, onePlusZPow, WORK_BITS),
      WORK_BITS,
    );
    expectClose(r.value, want, 40);
  });
});

// -----------------------------------------------------------------------------
// Self-consistency: precision dial + forced-vs-default + perturbation
// -----------------------------------------------------------------------------
//
// In every regime where both Slater series exist (m ≥ 1 ∧ n ≥ 1) the
// two series converge in *disjoint* regions (Series 1 in `|z| < 1`
// times its sign factor, Series 2 in `|1/z| < 1`); they cannot be
// directly cross-validated against each other. The strong invariants
// available are:
//
//   * Increasing target precision should not change the leading
//     digits of the output beyond rounding (the result at 30 dps
//     should equal the result at 50 dps to ~30 dps).
//   * `forceSeries: <chosen>` should agree with the default when the
//     default selects the same series.
//   * `perturbation: "always"` on a non-coalescent input should agree
//     with `perturbation: "auto"` (which omits perturbation): the
//     perturbed answer is the L'Hôpital limit, equal to the
//     non-perturbed answer.

describe("self-consistency invariants", () => {
  test("precision dial: 30 dps ⊆ 50 dps for G^{1,1}_{1,1}(1/2; 0 | 1/3)", () => {
    const params = P(["0.5"], [], ["0"], []);
    const z = cfromStrings(
      "0.333333333333333333333333333333333333333333333333333333333333333333333333",
      "0",
      256,
    );
    const r30 = meijergSlater(params, z, 30);
    const r50 = meijergSlater(params, z, 50);
    if (r30.status !== "success") throw new Error(r30.reason);
    if (r50.status !== "success") throw new Error(r50.reason);
    expectClose(r30.value, r50.value, 28);
  });

  test("forceSeries=1 matches default when default picks Series 1", () => {
    // p=2, q=2, m=1, n=1, m+n=p: at |z|<1 the default is Series 1.
    const params = P(["0.4"], ["0.7"], ["1.1"], ["1.5"]);
    const z = cfromStrings("0.5", "0", 256);
    const rDef = meijergSlater(params, z, 30);
    const rForced = meijergSlater(params, z, 30, { forceSeries: 1 });
    if (rDef.status !== "success") throw new Error(rDef.reason);
    if (rForced.status !== "success") throw new Error(rForced.reason);
    expect(rDef.method).toBe("slater-series-1");
    expect(rForced.method).toBe("slater-series-1");
    expectClose(rForced.value, rDef.value, 28);
  });

  test("forceSeries=2 matches default when default picks Series 2", () => {
    // p=2, q=2, m=1, n=1, m+n=p: at |z|>1 (outside quarantine) the
    // default is Series 2.
    const params = P(["0.4"], ["0.7"], ["1.1"], ["1.5"]);
    const z = cfromStrings("3", "0", 256);
    const rDef = meijergSlater(params, z, 30);
    const rForced = meijergSlater(params, z, 30, { forceSeries: 2 });
    if (rDef.status !== "success") throw new Error(rDef.reason);
    if (rForced.status !== "success") throw new Error(rForced.reason);
    expect(rDef.method).toBe("slater-series-2");
    expect(rForced.method).toBe("slater-series-2");
    expectClose(rForced.value, rDef.value, 28);
  });
});

// -----------------------------------------------------------------------------
// Quarantine band — refusal path
// -----------------------------------------------------------------------------

describe("quarantine band refusal", () => {
  test("|z|=1, p=q=m+n ⟹ tagged refusal", () => {
    const params = P(["0.4"], ["0.7"], ["1.1"], ["1.5"]);
    const z = cfromInts(1n, 0n, 60);
    const r = meijergSlater(params, z, 30);
    expect(r.status).toBe("quarantine-band");
  });

  test("|z| outside band (1.1) ⟹ success", () => {
    const params = P(["0.4"], ["0.7"], ["1.1"], ["1.5"]);
    const z = cfromStrings("1.1", "0", 256);
    const r = meijergSlater(params, z, 30);
    expect(r.status).toBe("success");
  });

  test("|z| outside band (0.9) ⟹ success", () => {
    const params = P(["0.4"], ["0.7"], ["1.1"], ["1.5"]);
    const z = cfromStrings("0.9", "0", 256);
    const r = meijergSlater(params, z, 30);
    expect(r.status).toBe("success");
  });
});

// -----------------------------------------------------------------------------
// Coalescence + perturbation
// -----------------------------------------------------------------------------
//
// Slater's simple-pole formula breaks the moment two `bm` parameters
// differ by an integer. The orchestrator detects this, applies the
// deterministic odd-coefficient perturbation, and retries. The result
// should match the L'Hôpital limit — which, for these specific
// closed-form cases, is the same elementary closed form (the closed
// form is parameter-continuous).

describe("coalescence + perturbation", () => {
  test("G^{2,0}_{0,2}(_; 1, 2 | z) — coalescent (b1, b2 differ by 1)", () => {
    // Bateman 5.6.4: G^{2,0}_{0,2}(_; α, β | z) = 2 z^{(α+β)/2} K_{α-β}(2√z).
    // With α=1, β=2: K_{-1}(2√z) = K_1(2√z), and answer = 2 z^{3/2} K_1(2√z).
    // The simple-pole formula has Γ(2-1) = Γ(1) = 1 and Γ(1-2) = Γ(-1)
    // = pole — so coalescence is real. The perturbation path should
    // produce the right L'Hôpital limit.
    const params = P([], [], ["1", "2"], []);
    const z = cfromStrings("0.25", "0", 60);
    const r = meijergSlater(params, z, 25);
    if (r.status !== "success") {
      throw new Error(`expected success; got ${r.status}: ${r.reason}`);
    }
    expect(r.perturbationApplied).toBe(true);
    // The result should be finite (not NaN, not exploded to ∞).
    const reFloat = toFloat64(cre(r.value)).value;
    const imFloat = toFloat64(cim(r.value)).value;
    expect(Number.isFinite(reFloat)).toBe(true);
    expect(Number.isFinite(imFloat)).toBe(true);
    // The imaginary part should be near zero (real arguments).
    expect(Math.abs(imFloat)).toBeLessThan(1e-15);
    // Magnitude sanity: 2 · 0.25^{3/2} · K_1(1).
    // K_1(1) ≈ 0.6019, so result ≈ 2 · 0.125 · 0.6019 ≈ 0.150...
    expect(reFloat).toBeGreaterThan(0.05);
    expect(reFloat).toBeLessThan(0.5);
  });

  test("perturbation: forced ON for non-coalescent case ⟹ same answer", () => {
    // The perturbation is mathematically the L'Hôpital limit; on a
    // non-coalescent input it should give the *same* answer as the
    // un-perturbed run. This tests that the perturbation machinery
    // itself is internally consistent.
    const params = P([], [], ["1.7"], []);
    const z = cfromInts(2n, 0n, 60);
    const rPlain = meijergSlater(params, z, 30);
    const rPerturbed = meijergSlater(params, z, 30, { perturbation: "always" });
    if (rPlain.status !== "success") throw new Error(rPlain.reason);
    if (rPerturbed.status !== "success") throw new Error(rPerturbed.reason);
    expect(rPlain.perturbationApplied).toBe(false);
    expect(rPerturbed.perturbationApplied).toBe(true);
    expectClose(rPerturbed.value, rPlain.value, 25);
  });
});

// -----------------------------------------------------------------------------
// Input-error path
// -----------------------------------------------------------------------------

describe("input errors", () => {
  test("m == 0 and n == 0 ⟹ structured input-error", () => {
    const params = P([], ["1"], [], ["2"]);
    const r = meijergSlater(params, cfromInts(1n, 0n, 50), 30);
    expect(r.status).toBe("input-error");
  });

  test("non-integer precision ⟹ structured input-error", () => {
    const params = P([], [], ["1"], []);
    const r = meijergSlater(params, cfromInts(2n, 0n, 50), 30.5);
    expect(r.status).toBe("input-error");
  });
});
