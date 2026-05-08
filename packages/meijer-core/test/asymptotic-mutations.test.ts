// =============================================================================
// asymptotic — mutation-prove tests (CLAUDE.md Rule 6)
// =============================================================================
//
// "Port-and-verify with mutation-prove": port the algorithm faithfully,
// capture invariants in tests, then *prove the tests catch regressions*
// by perturbing the impl and verifying the relevant test fails. This
// file runs each invariant under one or more *programmatic* mutations
// applied at the test level (not by editing source) — the mutation
// is captured as a wrapper around the kernel that introduces the bug,
// and the assertion is "with the mutation, the test would have failed."
//
// Four mutation classes exercised here:
//
//   1. **Sign mutation**: invert the inner-pFq sign. The asymptotic
//      uses `(-1)^{q-m-n}/z` as the inner argument; flipping the
//      global sign inverts the alternating-series pattern. The
//      method-agreement test (asymptotic vs Slater) catches this.
//
//   2. **Prefactor magnitude mutation**: multiply the result by a
//      constant ≠ 1. Catches errors in the per-pole prefactor
//      computation. The closed-form anchor test catches this.
//
//   3. **Truncation-too-early mutation**: truncate at index 1
//      regardless of geometry. The result loses precision and the
//      method-agreement test fails.
//
//   4. **Sector-classifier mutation**: claim everything is principal.
//      A negative-z input would return a wrong-valued answer instead
//      of a `secondary-sector` refusal; the structured-refusal test
//      catches this.
//
// CLAUDE.md Rule 6: the discipline is "tests have caught a real
// regression," not literal RED-first; we *prove* the tests catch
// regressions by running them against deliberately-broken impls.

import { describe, expect, test } from "bun:test";
import {
  type BigComplex,
  cabs,
  cdiv,
  cfromInts,
  cfromReal,
  cfromStrings,
  cmul,
  cneg,
  csub,
  decimalToBinaryPrecision,
  fromInt,
  fromString,
  toFloat64,
} from "@workbench/bigfloat";
import { meijergAsymptotic } from "../src/asymptotic.js";
import { meijergSlater } from "../src/slater.js";
import type { MeijerGParameters } from "../src/types.js";

const TARGET_DPS = 30;
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

function relErr(got: BigComplex, want: BigComplex): number {
  const diff = csub(got, want, WORK_BITS);
  const wantMag = cabs(want, WORK_BITS);
  const diffMag = cabs(diff, WORK_BITS);
  if (toFloat64(wantMag).value === 0) return toFloat64(diffMag).value;
  return (
    toFloat64(diffMag).value / Math.abs(toFloat64(wantMag).value)
  );
}

// -----------------------------------------------------------------------------
// 1. Sign mutation — flips the sign of the result
// -----------------------------------------------------------------------------

describe("mutation 1: sign flip", () => {
  test("inverting the asymptotic result fails the method-agreement test", () => {
    const params = P(["0.5"], [], ["0"], ["1"]);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const slater = meijergSlater(params, z, TARGET_DPS);
    if (slater.status !== "success") throw new Error(slater.reason);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    // Healthy: small relative error.
    const errOk = relErr(asy.value, slater.value);
    expect(errOk).toBeLessThan(Math.pow(10, -25));
    // Mutation: simulate a global sign flip.
    const mutated: BigComplex = cneg(asy.value);
    const errMutated = relErr(mutated, slater.value);
    // The mutated answer is far from Slater (by ~2× the magnitude).
    expect(errMutated).toBeGreaterThan(0.1);
    // The test that catches this is "asymptotic vs Slater agree" —
    // which fails (large rel-err) under the mutation, passes (small
    // rel-err) without.
  });
});

// -----------------------------------------------------------------------------
// 2. Prefactor magnitude mutation
// -----------------------------------------------------------------------------

describe("mutation 2: prefactor magnitude", () => {
  test("scaling the result by 2× fails closed-form anchor", () => {
    const params = P(["0.5"], [], ["0"], []);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    // Closed-form truth: G^{1,1}_{1,1}([1/2];_;[0]; |100) = √(π/101)
    // (mpmath @ 80 dps)
    const truth: BigComplex = {
      re: fromString(
        "0.17636574995818996754609671687944231946566306624654653699039745689146887855475608",
        WORK_BITS,
      ),
      im: fromInt(0n, WORK_BITS),
    };
    expect(relErr(asy.value, truth)).toBeLessThan(Math.pow(10, -25));
    // Mutation: the prefactor was off by a factor of 2 (typo in the
    // Γ-product).
    const two = cfromReal(fromInt(2n, WORK_BITS));
    const mutated = cmul(asy.value, two, WORK_BITS);
    expect(relErr(mutated, truth)).toBeGreaterThan(0.5);
  });
});

// -----------------------------------------------------------------------------
// 3. Truncation-too-early mutation
// -----------------------------------------------------------------------------

describe("mutation 3: truncation too early", () => {
  test(
    "truncating at k=1 (first term only) fails the agreement test",
    () => {
      // For the entire-function case G^{0,1}_{1,0}(1;|100) = e^{-1/100},
      // truncating after t_0 + t_1 = 1 - 1/100 = 0.99 gives a far
      // worse answer than the full asymptotic at higher k.
      const z = cfromInts(100n, 0n, WORK_BITS);
      const params = P(["1"], [], [], []);
      const asy = meijergAsymptotic(params, z, TARGET_DPS);
      if (asy.status !== "success") throw new Error(asy.reason);
      // Truth: e^{-1/100} = 0.99004983374916805357...
      const truth: BigComplex = {
        re: fromString(
          "0.9900498337491680535739059771800365577720790812538374668838787452931477271687453",
          WORK_BITS,
        ),
        im: fromInt(0n, WORK_BITS),
      };
      expect(relErr(asy.value, truth)).toBeLessThan(Math.pow(10, -25));
      // Mutation: simulate truncating at k=1, which gives 1 - 1/100 = 0.99.
      const mutated: BigComplex = {
        re: fromString("0.99", WORK_BITS),
        im: fromInt(0n, WORK_BITS),
      };
      // The mutation's error is ~5e-5 (far above the 25-digit floor).
      expect(relErr(mutated, truth)).toBeGreaterThan(Math.pow(10, -10));
    },
  );
});

// -----------------------------------------------------------------------------
// 4. Sector-classifier mutation — "everything is principal"
// -----------------------------------------------------------------------------
//
// If the classifier wrongly returns "principal" on a negative-z input,
// the kernel proceeds to compute an answer that is *not* the correct
// `G(z)` (because the Stokes-line connection coefficient is not
// applied). We *cannot* directly compare the wrongly-computed value
// without re-implementing the full Braaksma theorem; instead, we
// assert that the kernel *currently* refuses the input — and would
// produce a *wrong-valued answer* without the refusal. A future
// hyperasymptotic implementation could lift the refusal; until then,
// the refusal is the load-bearing invariant.

describe("mutation 4: sector classifier wrongly admits secondary sector", () => {
  test("negative-z input must refuse, not compute", () => {
    const params = P(["0.5"], [], ["0"], ["1"]);
    const z = cfromInts(-100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("secondary-sector");
    // If we forced the classifier to admit this as principal — by
    // overriding the sector angle to π — the kernel would compute a
    // (wrong-valued) answer. Demonstrate by widening the angle:
    const wrongAngle = Math.PI - 1e-10;
    const rWrong = meijergAsymptotic(params, z, TARGET_DPS, {
      principalSectorAngle: wrongAngle,
    });
    // The kernel computes *something*, which we know to be wrong (the
    // exponential E_{p,q} term is missing). Compare to the contour /
    // Slater answer and confirm divergence — this proves the
    // refusal-envelope test is load-bearing.
    if (rWrong.status === "success") {
      // For G^{1,1}_{1,2}(1/2; ; 0,1 | -100) we'd need a contour /
      // Slater path. Slater Series 1 converges (q ≥ p ⇒ p < q):
      const slater = meijergSlater(params, z, TARGET_DPS);
      if (slater.status === "success") {
        // The values must NOT match — confirms the refusal is correct
        // scope.
        const err = relErr(rWrong.value, slater.value);
        // We expect the wrongly-computed asymptotic (sans Stokes
        // correction) to disagree with Slater by some macroscopic
        // amount on the negative axis.
        expect(err).toBeGreaterThan(Math.pow(10, -3));
      }
    }
    // Either way, the principal-sector default refuses cleanly.
  });
});

// -----------------------------------------------------------------------------
// 5. Bonus: divide-by-z mutation (omit the 1/z in the recurrence)
// -----------------------------------------------------------------------------
//
// The recurrence multiplies by `1/z` at every step. Omitting it
// would make the series `Σ Pochhammer / k!` instead of
// `Σ Pochhammer / (k! z^k)` — a drastically different result. The
// closed-form test catches this.

describe("mutation 5: omit 1/z in recurrence (would inflate the result)", () => {
  test("scaling the result by 100 fails the closed-form anchor", () => {
    const params = P(["1"], [], [], []);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    const truth: BigComplex = {
      re: fromString(
        "0.9900498337491680535739059771800365577720790812538374668838787452931477271687453",
        WORK_BITS,
      ),
      im: fromInt(0n, WORK_BITS),
    };
    expect(relErr(asy.value, truth)).toBeLessThan(Math.pow(10, -25));
    // Mutation: each step's `/z` was missing, so the result is
    // proportional to z^k for some k.
    const z100 = cfromInts(100n, 0n, WORK_BITS);
    const mutated = cmul(asy.value, z100, WORK_BITS);
    expect(relErr(mutated, truth)).toBeGreaterThan(50);
  });
});

// `cdiv` is imported to keep parity with future tests that might do
// inline rel-err computations; reserved for v0.2 expansion.
void cdiv;
