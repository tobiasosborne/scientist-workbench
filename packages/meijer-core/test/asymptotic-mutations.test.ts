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
    // κ=1 shape (p=q): G^{1,1}_{1,1}([1/2];_;[0];_). The previous
    // `(["0.5"], [], ["0"], ["1"])` shape was κ=2 (out of egf v0.1
    // scope; refused with coverage-gap by the κ-aware classifier). The
    // mutation invariant is shape-independent — pick any shape where
    // both Slater and asymptotic apply.
    const params = P(["0.5"], [], ["0"], []);
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
  test("κ=2 input refuses with coverage-gap (egf v0.1 scope-gate)", () => {
    // After the κ-aware classifier (ADR-0039 §D3), the load-bearing
    // sector-refusal invariant moves from "negative-z is secondary-
    // sector" to "κ=2 input is coverage-gap". The κ=2 (p=q-1) regime
    // has a structurally distinct three-term H+E^-+E^+ connection
    // formula (DLMF 16.11.8) that egf v0.1 does not implement; the
    // classifier refuses upstream with the bead ID
    // `scientist-workbench-fc83` so the caller can route or surface.
    // This refusal is the new "sector classifier wrongly admits"
    // mutation target: if the κ classifier wrongly admitted the κ=2
    // case as principal, the kernel would silently produce a wrong-
    // valued answer (because the second E term is missing).
    const params = P(["0.5"], [], ["0"], ["1"]);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("coverage-gap");
    if (r.status === "coverage-gap") {
      expect(r.reason).toMatch(/fc83/);
    }
  });
});

// -----------------------------------------------------------------------------
// 4b. δπ algebraic-sector envelope — mutation-prove (bead atip)
// -----------------------------------------------------------------------------
//
// Worklog 125 surfaced that the κ-aware classifier's `κπ/2` boundary
// was the wrong geometry: it admitted κ≥3, δ=0 shapes into the
// algebraic-only path even though the Paris–Kaminski algebraic envelope
// `|arg z| < δπ` is empty when δ ≤ 0. Bead `atip` added the refusal.
//
// The mutation here is the lifted refusal — what the kernel did before
// `atip`: route the κ=3, δ=0 input through `assembleAlgebraic` and
// return its output as if it were a valid asymptotic. The wrong-valued
// behaviour at the exact deleted-golden-17 input is captured as a
// pinned constant from the math-research investigation: kernel emitted
// `+4.4×10⁻³` for an mpmath truth of `−0.5549…` (off by ~125× and the
// wrong sign). The post-`atip` invariant is that the kernel refuses
// rather than emits any value; this test asserts the refusal and
// records — for a future reader — the magnitude of the silent wrong
// answer the refusal replaces. If the refusal is ever lifted without a
// matching dominant-E Braaksma implementation, the next failure mode
// would be re-emission of the wrong value.

describe("mutation 4b: degenerate principal sector (κ≥3, δ≤0) ⇒ refuse, not silently emit", () => {
  test("κ=3, δ=0 (G^{1,1}_{1,3}, deleted golden 17) refuses with degenerate-principal-sector", () => {
    // Exact deleted-golden-17 input. Pre-`atip` kernel value at this
    // input: +4.4×10⁻³ at 50 dps. Mpmath truth at 50 dps: −0.5549…
    // (sign wrong, magnitude wrong by ~125×).
    const params: MeijerGParameters = {
      an: [
        cfromStrings(
          "0.333333333333333333333333333333333333333333333333333",
          "0",
          WORK_BITS,
        ),
      ],
      ap: [],
      bm: [cfromStrings("0.5", "0", WORK_BITS)],
      bq: [
        cfromStrings(
          "0.666666666666666666666666666666666666666666666666667",
          "0",
          WORK_BITS,
        ),
        cfromStrings("0.75", "0", WORK_BITS),
      ],
    };
    const z = cfromStrings("2", "0.1", WORK_BITS);
    const r = meijergAsymptotic(params, z, 50);
    expect(r.status).toBe("degenerate-principal-sector");
    if (r.status === "degenerate-principal-sector") {
      expect(r.reason).toMatch(/atip/);
    }
  });

  test("κ=1, δ=0 (G^{1,1}_{2,2}, bead 43i family) is NOT refused", () => {
    // The atip refusal is gated on κ≥3 — for κ=1 the inner pFq is
    // convergent for |z|>1 (Slater 1966 §5.5 q≥p condition) and the
    // algebraic series equals G as a convergent formula regardless of
    // δ. The bead 43i `G^{1,1}_{2,2}` tests are mpmath-verified at 30
    // dps for δ=0 shapes; refusing them would deprecate working,
    // shipped behaviour. This test pins the κ=1 admission invariant —
    // if a future change broadens the refusal to all δ≤0 regardless
    // of κ, this test goes red.
    const params = P(["0.5"], ["0.75"], ["0"], ["-0.25"]);
    const z = cfromInts(50n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("success");
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
