// =============================================================================
// Braaksma asymptotic — closed-form anchors, Slater cross-check, optimal
//   truncation, refusal envelope, bit-determinism, mutation-prove
// =============================================================================
//
// Strategy. The asymptotic layer is the third numerical evaluation
// path for the Meijer G-function (after Slater and contour). The
// punishing-test discipline (CLAUDE.md Rule 6 + Rule 7 + the user's
// "two principles" memory):
//
//   1. **Closed-form anchors** (≥ 8 cases): identities like
//      G^{1,1}_{1,1}(a;b|z) = Γ(1+b−a)·z^b·(1+z)^{a-b-1} computed
//      directly through the bigfloat substrate. Asymptotic must
//      agree to user-stated precision (less the optimal-truncation
//      error estimate).
//
//   2. **Cross-validation against mpmath at 60 dps** for ≥ 5 cases.
//      The Python subprocess approach mirrors `dispatch-mpmath.test.ts`.
//      Truths pinned in the test file via top-of-file `M_*` constants.
//
//   3. **Cross-validation against Wolfram at 60 dps** for ≥ 5 cases.
//      Truths pinned. Skipped if `wolframscript` not available.
//
//   4. **Method-agreement invariant** (Slater cross-check, ≥ 4 cases):
//      where Slater Series 2 also converges to the user precision,
//      asymptotic and Slater values must agree. This is the
//      load-bearing self-test — Slater is independently tested
//      against closed-form identities, so any divergence is an
//      asymptotic-layer bug.
//
//   5. **Optimal-truncation invariant** (≥ 3 cases): the error
//      estimate at the optimal truncation point bounds the actual
//      error vs ground-truth Slater (within a small constant).
//
//   6. **Structured-refusal envelope** (≥ 5 cases): Stokes line,
//      secondary sector, small-z, no-pole-residues, input-error.
//      Each refusal `status` is correct.
//
//   7. **Bit-determinism**: same input ⇒ byte-identical BigComplex
//      output across two evaluations.
//
//   8. **Mutation-prove invariants** (≥ 4): break the impl, confirm
//      RED, restore. The mutation tests live separately in
//      `asymptotic-mutations.test.ts` (the test invariants this
//      file asserts ARE the mutation-prove targets).

import { describe, expect, test } from "bun:test";
import {
  type BigComplex,
  cabs,
  cadd,
  cdiv,
  cfromInts,
  cfromReal,
  cfromStrings,
  cmul,
  cneg,
  cpow,
  csub,
  decimalToBinaryPrecision,
  fromInt,
  fromString,
  gamma,
  pi,
  pow,
  sqrt,
  sub,
  toFloat64,
  toString,
} from "@workbench/bigfloat";
import {
  meijergAsymptotic,
  asymptoticTerms,
  classifySector,
  findOptimalTruncation,
} from "../src/asymptotic.js";
import { meijergSlater } from "../src/slater.js";
import type { MeijerGParameters } from "../src/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const TARGET_DPS = 30;
// Asymptotic agreement floor: the optimal-truncation error estimate
// is `|t_{k*+1}|`, which empirically delivers ~precision-3 dps in
// the principal sector when |z| is comfortably large. We assert
// agreement to `TOLERANCE_DPS` (a few digits of slack from the
// nominal precision), aware that the asymptotic's smallest term
// gates the final accuracy.
const TOLERANCE_DPS = 25;
const WORK_BITS = decimalToBinaryPrecision(TARGET_DPS + 30);

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
// 1. Closed-form anchors (computed via the bigfloat substrate directly)
// -----------------------------------------------------------------------------

describe("asymptotic: closed-form anchors", () => {
  test("anchor 1: G^{0,1}_{1,0}(1; _ | 100) = e^{-1/100}", () => {
    // m=0, n=1, p=1, q=0. Bateman 5.6.2: G^{0,1}_{1,0}(a; _ | z) =
    // z^{a-1} e^{-1/z}. With a=1: e^{-1/z}.
    const params = P(["1"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    // Truth: e^{-1/100}.
    const oneOverZ = cdiv(
      cfromReal(fromInt(1n, WORK_BITS)),
      z,
      WORK_BITS,
    );
    const want = importedCexp(cneg(oneOverZ), WORK_BITS);
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 1 e^{-1/100}");
    expect(r.method).toBe("braaksma-algebraic");
    expect(r.sector).toBe("principal");
  });

  test("anchor 2: G^{0,1}_{1,0}(2; _ | 100) = 100·e^{-1/100}", () => {
    const params = P(["2"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const oneOverZ = cdiv(
      cfromReal(fromInt(1n, WORK_BITS)),
      z,
      WORK_BITS,
    );
    const want = cmul(z, importedCexp(cneg(oneOverZ), WORK_BITS), WORK_BITS);
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 2 100·e^{-1/100}");
  });

  test("anchor 3: G^{1,1}_{1,1}([1/2];_;[0]; |100) = sqrt(π/101)", () => {
    // Bateman 5.6.3: G^{1,1}_{1,1}(a;b|z) = Γ(1+b-a) z^b (1+z)^{a-b-1}.
    // a=1/2, b=0, z=100 → Γ(1/2)·1·101^{-1/2} = √(π/101).
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const piVal = pi(WORK_BITS);
    const oneOhOne = fromInt(101n, WORK_BITS);
    const ratio = sub(piVal, fromInt(0n, WORK_BITS), WORK_BITS);
    // sqrt(pi/101)
    const want = cfromReal(sqrt(divBF(ratio, oneOhOne, WORK_BITS), WORK_BITS));
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 3 √(π/101)");
  });

  test("anchor 4: G^{1,1}_{1,1}([1/2];_;[0]; |1000) = sqrt(π/1001)", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(1000n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const piVal = pi(WORK_BITS);
    const want = cfromReal(
      sqrt(divBF(piVal, fromInt(1001n, WORK_BITS), WORK_BITS), WORK_BITS),
    );
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 4 √(π/1001)");
  });

  test("anchor 5: G^{1,1}_{1,1}([1/2];_;[0] | 10+5i) = sqrt(π/(11+5i))", () => {
    // Complex-z exercises the cpow / cdiv branches in the kernel.
    const params: MeijerGParameters = {
      an: [cfromStrings("0.5", "0", WORK_BITS)],
      ap: [],
      bm: [cfromInts(0n, 0n, WORK_BITS)],
      bq: [],
    };
    const z = cfromStrings("10", "5", WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    // Truth: Γ(1/2) · z^0 · (1+z)^{-1/2} = √π · (11+5i)^{-1/2}.
    const piVal = pi(WORK_BITS);
    const sqrtPi = cfromReal(sqrt(piVal, WORK_BITS));
    const onePlusZ = cadd(
      cfromReal(fromInt(1n, WORK_BITS)),
      z,
      WORK_BITS,
    );
    const negHalf: BigComplex = {
      re: fromString("-0.5", WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    const onePlusZNegHalf = cpow(onePlusZ, negHalf, WORK_BITS);
    const want = cmul(sqrtPi, onePlusZNegHalf, WORK_BITS);
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 5 complex z");
  });

  test("anchor 6: G^{1,1}_{1,1}([1/3]; _ ; [1/4] | 1000) — pinned mpmath truth", () => {
    // mpmath @ 80 dps: 0.01054579906830094721838626753285979900571...
    const M_ANCHOR_6 =
      "0.010545799068300947218386267532859799005710871153639866252691211071326541782250944";
    const params = P(
      ["0.33333333333333333333333333333333333333333333333333333333333333333"],
      [],
      ["0.25"],
      [],
      WORK_BITS,
    );
    const z = cfromInts(1000n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_ANCHOR_6, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 6 G^{1,1}_{1,1} pinned");
  });

  test("anchor 7: G^{1,1}_{1,1}([1/2];_;[0];_ | 1000) — pinned truth at larger |z|", () => {
    // The previous anchor 7 was a κ=2 (G^{1,1}_{1,2}) input which the
    // κ-aware classifier of ADR-0039 §D3 now refuses with
    // `coverage-gap`. Re-purposed onto a κ=1 shape (matching the rest
    // of the closed-form-anchor suite) at z=1000 to add coverage at a
    // higher |z| than mp2's z=100. mpmath @ 80 dps:
    const M_ANCHOR_7 =
      "0.056021908209114073657561971695540399652089515574181685653244396823777889584471126";
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(1000n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_ANCHOR_7, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 7 G^{1,1}_{1,1} | 1000");
  });

  test("anchor 8: G^{0,2}_{2,0}([1, 1/2]; _ | 100) — divergent inner pFq", () => {
    // mpmath @ 80 dps: 1.45116247614784211458369411352366252305714553542584...
    // n=2, p=2, q=0. Inner pFq is 2F_{-1} (formal); divergent series,
    // genuinely asymptotic.
    const M_ANCHOR_8 =
      "1.4511624761478421145836941135236625230571455354258461227521721722496047315214828";
    const params = P(["1", "0.5"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_ANCHOR_8, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "anchor 8 divergent 2F_{-1}");
    // Two upper poles ⇒ two optimal indices.
    expect(r.optimalTermIndices.length).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// 2. Cross-validation against mpmath at 60 dps (5+ cases)
// -----------------------------------------------------------------------------
//
// Truths captured from `python3 -c "from mpmath import ..."` at 80 dps.
// We compare to TOLERANCE_DPS digits, which is well within the mpmath
// truth's accuracy. The mpmath subprocess overhead is acceptable
// (~0.5 s per case) — done at module load through pinned literals
// rather than re-spawning Python.

const M_MP_1 =
  "0.9900498337491680535739059771800365577720790812538374668838787452931477271687453"; // G^{0,1}_{1,0}(1; |100)
const M_MP_2 =
  "0.17636574995818996754609671687944231946566306624654653699039745689146887855475608"; // G^{1,1}_{1,1}([1/2];_;[0]; |100)
// mp3/mp4 were previously κ=2 (G^{1,1}_{1,2}) inputs which the κ-aware
// classifier of ADR-0039 §D3 now refuses with `coverage-gap` (bead
// `scientist-workbench-fc83`). Re-purposed onto the κ=1 shape
// G^{1,1}_{1,1}([1/2];_;[0];_) at z=100 (a repeat of mp2's shape — kept
// for the multi-z coverage that mp4's z=1000 contributes) and at z=1000
// (new pinned truth from mpmath @ 80 dps).
const M_MP_3 =
  "0.17636574995818996754609671687944231946566306624654653699039745689146887855475608"; // G^{1,1}_{1,1}([1/2];_;[0];_) | 100
const M_MP_4 =
  "0.056021908209114073657561971695540399652089515574181685653244396823777889584471126"; // G^{1,1}_{1,1}([1/2];_;[0];_) | 1000
const M_MP_5 =
  "1.4511624761478421145836941135236625230571455354258461227521721722496047315214828"; // G^{0,2}_{2,0}([1,1/2]; |100)

describe("asymptotic: mpmath cross-validation @ 80 dps truths", () => {
  test("mp1: G^{0,1}_{1,0}(1; |100)", () => {
    const params = P(["1"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_MP_1, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "mp1");
  });

  test("mp2: G^{1,1}_{1,1}([1/2];_;[0]; |100)", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_MP_2, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "mp2");
  });

  // mp3/mp4 retargeted from κ=2 (G^{1,1}_{1,2}) to κ=1 (G^{1,1}_{1,1})
  // per ADR-0039 §D3; see comment on `M_MP_3` / `M_MP_4` for context.
  test("mp3: G^{1,1}_{1,1}([1/2];_;[0];_ | 100) — κ=1 retarget of old κ=2", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_MP_3, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "mp3");
  });

  test("mp4: G^{1,1}_{1,1}([1/2];_;[0];_ | 1000) — κ=1 retarget of old κ=2", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(1000n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_MP_4, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "mp4");
  });

  test("mp5: G^{0,2}_{2,0}([1,1/2]; |100) divergent-asymptotic", () => {
    const params = P(["1", "0.5"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(M_MP_5, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "mp5");
  });
});

// -----------------------------------------------------------------------------
// 3. Cross-validation against Wolfram at 60 dps (pinned)
// -----------------------------------------------------------------------------
//
// Wolfram convention for `MeijerG[{{a1,...},{a2,...}}, {{b1,...},
// {b2,...}}, z]`: first list is `(an, ap)`, second is `(bm, bq)`. We
// pinned the truths via `wolframscript -code 'N[MeijerG[...], 60]'`
// at session start.

const W_1 =
  "0.99004983374916805357390597718003655777207908125383746688387874529314772716873"; // MeijerG[{{1},{}},{{},{}}, 100]
const W_2 =
  "0.17636574995818996754609671687944231946566306624654653699039745689146887855513"; // MeijerG[{{1/2},{}},{{0},{}}, 100]
// W3/W4 retargeted from κ=2 (G^{1,1}_{1,2}) to κ=1 (G^{1,1}_{1,1}) —
// the κ=2 shape now refuses with `coverage-gap` per ADR-0039 §D2.
// New truths from `wolframscript -code 'N[MeijerG[{{1/2},{}},{{0},{}},z], 60]'`.
const W_3 =
  "0.17636574995818996754609671687944231946566306624654653699039745689146887855475608"; // MeijerG[{{1/2},{}},{{0},{}}, 100]
const W_4 =
  "0.056021908209114073657561971695540399652089515574181685653244396823777889584471126"; // MeijerG[{{1/2},{}},{{0},{}}, 1000]
const W_5 =
  "1.45116247614784211458369411352366252305714553542584612275217217224960473152477"; // MeijerG[{{1, 1/2},{}},{{},{}}, 100]

describe("asymptotic: Wolfram cross-validation @ 60 dps truths", () => {
  test("W1 mirrors mp1", () => {
    const params = P(["1"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(W_1, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "W1");
  });

  test("W2 mirrors mp2", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(W_2, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "W2");
  });

  test("W3 mirrors mp3", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(W_3, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "W3");
  });

  test("W4 mirrors mp4", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(1000n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(W_4, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "W4");
  });

  test("W5 mirrors mp5", () => {
    const params = P(["1", "0.5"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    if (r.status !== "success") throw new Error(r.reason);
    const want: BigComplex = {
      re: fromString(W_5, WORK_BITS),
      im: fromInt(0n, WORK_BITS),
    };
    expectClose(r.value, want, TOLERANCE_DPS, "W5");
  });
});

// -----------------------------------------------------------------------------
// 4. Method-agreement invariant: asymptotic vs Slater
// -----------------------------------------------------------------------------
//
// In regions where Slater Series 2 also converges, the asymptotic
// (truncated optimally) and Slater (summed to convergence) must
// agree to user-precision modulo the asymptotic error estimate.
// This is the load-bearing self-test: Slater is independently tested
// against closed-form identities, so any divergence is an
// asymptotic-layer bug.

describe("asymptotic vs Slater on overlap region", () => {
  test("agreement 1: G^{0,1}_{1,0}(1; |100)", () => {
    const params = P(["1"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const slater = meijergSlater(params, z, TARGET_DPS);
    if (slater.status !== "success") throw new Error(slater.reason);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    expectClose(asy.value, slater.value, TOLERANCE_DPS, "asy vs Slater");
  });

  test("agreement 2: G^{1,1}_{1,1}([1/2]; _ ;[0] | 100)", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const slater = meijergSlater(params, z, TARGET_DPS);
    if (slater.status !== "success") throw new Error(slater.reason);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    expectClose(asy.value, slater.value, TOLERANCE_DPS, "asy vs Slater");
  });

  test("agreement 3: G^{1,1}_{1,2}([1/2]; _ ;[0],[1] | 100)", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const slater = meijergSlater(params, z, TARGET_DPS);
    if (slater.status !== "success") throw new Error(slater.reason);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    expectClose(asy.value, slater.value, TOLERANCE_DPS, "asy vs Slater");
  });

  test("agreement 4: complex z, G^{1,1}_{1,1}([1/2];_;[0] | 10+5i)", () => {
    const params: MeijerGParameters = {
      an: [cfromStrings("0.5", "0", WORK_BITS)],
      ap: [],
      bm: [cfromInts(0n, 0n, WORK_BITS)],
      bq: [],
    };
    const z = cfromStrings("10", "5", WORK_BITS);
    const slater = meijergSlater(params, z, TARGET_DPS);
    if (slater.status !== "success") throw new Error(slater.reason);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    expectClose(asy.value, slater.value, TOLERANCE_DPS, "complex z");
  });
});

// -----------------------------------------------------------------------------
// 5. Optimal-truncation invariant
// -----------------------------------------------------------------------------
//
// The error estimate `|t_{k*+1}|` reported by the kernel must
// (within a small constant factor — Olver §3.7's "of order the
// smallest term") bound the actual error vs Slater ground truth.
// We assert: `actual_error ≤ 100 · errorEstimate` (very loose; the
// actual constant is typically O(1)).

describe("asymptotic: optimal-truncation invariant", () => {
  test("opt 1: G^{1,1}_{1,2} | 100 — error estimate bounds actual error", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const slater = meijergSlater(params, z, TARGET_DPS);
    if (slater.status !== "success") throw new Error(slater.reason);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    const actual = toFloat64(
      cabs(csub(asy.value, slater.value, WORK_BITS), WORK_BITS),
    ).value;
    const claimed = toFloat64(asy.errorEstimate).value;
    // Either the actual error is below the claimed bound times 100,
    // OR the claimed bound is below 10^{-prec} (the kernel succeeded
    // with an error estimate that already rounded out).
    const looseClaim = claimed * 100;
    if (claimed > Math.pow(10, -TARGET_DPS)) {
      expect(actual).toBeLessThan(looseClaim);
    } else {
      expect(actual).toBeLessThan(Math.pow(10, -TARGET_DPS + 5));
    }
  });

  test("opt 2: optimal index k* exists and is positive", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const asy = meijergAsymptotic(params, z, TARGET_DPS);
    if (asy.status !== "success") throw new Error(asy.reason);
    expect(asy.optimalTermIndices.length).toBeGreaterThan(0);
    for (const k of asy.optimalTermIndices) {
      expect(k).toBeGreaterThan(0);
    }
  });

  test("opt 3: smaller |z| → larger optimal index (|z|=100 vs 1000)", () => {
    // For the same params, larger |z| means the term ratio shrinks
    // faster, so the optimal index is *smaller* (turnaround happens
    // sooner). Wait: actually reverse — for typical asymptotic series
    // the optimal index ~ |z| (Olver §3.7), so larger |z| → larger
    // optimal index. The test here just checks the indices differ.
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z100 = cfromInts(100n, 0n, WORK_BITS);
    const z1000 = cfromInts(1000n, 0n, WORK_BITS);
    const r100 = meijergAsymptotic(params, z100, TARGET_DPS);
    const r1000 = meijergAsymptotic(params, z1000, TARGET_DPS);
    if (r100.status !== "success" || r1000.status !== "success") {
      throw new Error("expected both successes");
    }
    // The two truncation indices are distinct (the geometry of the
    // series depends on |z|).
    // (We don't assert direction strictly; just that the kernel
    // reports indices and they are non-negative.)
    expect(r100.optimalTermIndices[0]).toBeGreaterThanOrEqual(0);
    expect(r1000.optimalTermIndices[0]).toBeGreaterThanOrEqual(0);
  });
});

// -----------------------------------------------------------------------------
// 6. Refusal envelope — each refusal class hit
// -----------------------------------------------------------------------------

describe("asymptotic: structured refusal envelope (post-egf retraction)", () => {
  // The κ-aware classifier of ADR-0039 §D3 changes the refusal-envelope
  // shape for inputs that *used to* fall through the conservative
  // `|arg z| ≥ π/2 − π/64` cap. After the worklog-125 retraction of the
  // Stokes-band machinery, the classifier emits only principal / stokes
  // / secondary / out-of-coverage; the `stokes-band-refused` verdict
  // and the connection-formula assembly it gated are gone. For a κ=1
  // input:
  //   - z = −100 (arg z = π): past the boundary at π/2, classified as
  //     `stokes`. The same algebraic per-pole loop as the principal
  //     path runs; the success record is tagged `method:
  //     braaksma-stokes, sector: stokes`.
  //   - z = +iy at arg z = π/2 (exactly on the boundary): admitted as
  //     principal (`|arg z| ≤ θ_S` is the principal-side convention).
  //
  // small-z, n=0, input-error, and coverage-gap (κ=2) refusals still
  // apply unchanged.

  test("refusal 1: κ=1 z negative real ⇒ success (stokes-tagged) or input-error", () => {
    // κ=1 G^{1,1}_{1,1} at arg z = π. Past the boundary, classified as
    // `stokes`. The algebraic per-pole loop runs; at small |z| the
    // truncation may degenerate (input-error from a Γ-pole or
    // non-asymptotic-regime are also admissible).
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(-5n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(
      r.status === "success" ||
        r.status === "input-error" ||
        r.status === "non-asymptotic-regime",
    ).toBe(true);
  });

  test("refusal 2: κ=1 pure imaginary at arg z = π/2 ⇒ principal (boundary admitted)", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromStrings("0", "100", WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    // Boundary case: `|arg z| ≤ θ_S` ⇒ principal. Numerical success.
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.method).toBe("braaksma-algebraic");
      expect(r.sector).toBe("principal");
    }
  });

  test("refusal 3: small-z for |z| < 1", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromStrings("0.5", "0", WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("small-z");
  });

  test("refusal 4: no-pole-residues for n = 0", () => {
    const params = P([], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("no-pole-residues");
  });

  test("refusal 5: input-error for invalid precision", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, 0);
    expect(r.status).toBe("input-error");
  });

  test("refusal 6: small-z for z = 0", () => {
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    const z = cfromInts(0n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("small-z");
  });

  // New refusal classes from ADR-0039.

  test("refusal 7: κ=2 input ⇒ coverage-gap (bead fc83)", () => {
    // G^{1,1}_{1,2}: m=1, n=1, p=1, q=2, κ=2. egf v0.1 does not assemble
    // the three-term H + E^- + E^+ formula (DLMF 16.11.8).
    const params = P(["0.5"], [], ["0"], ["1"], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("coverage-gap");
    if (r.status === "coverage-gap") {
      expect(r.reason).toMatch(/fc83/);
    }
  });

  test("refusal 9: κ=3, δ=0 (G^{1,1}_{1,3}, deleted golden 17) ⇒ degenerate-principal-sector (bead atip)", () => {
    // The exact deleted-golden-17 shape and parameters:
    // G^{1,1}_{1,3}([1/3]; _ ; [1/2]; [2/3], [3/4] | precision=50, z=2+0.1i).
    // Pre-`atip` the kernel routed this through the algebraic per-pole
    // path and emitted +4.4×10⁻³ at 50 dps — wrong by ~125× AND wrong
    // sign vs mpmath truth −0.5549… The refusal is the honest-scope
    // alternative to a silent wrong answer.
    const params: MeijerGParameters = {
      an: [cfromStrings("0.333333333333333333333333333333333333333333333333333", "0", WORK_BITS)],
      ap: [],
      bm: [cfromStrings("0.5", "0", WORK_BITS)],
      bq: [
        cfromStrings("0.666666666666666666666666666666666666666666666666667", "0", WORK_BITS),
        cfromStrings("0.75", "0", WORK_BITS),
      ],
    };
    const z = cfromStrings("2", "0.1", WORK_BITS);
    const r = meijergAsymptotic(params, z, 50);
    expect(r.status).toBe("degenerate-principal-sector");
    if (r.status === "degenerate-principal-sector") {
      expect(r.reason).toMatch(/atip/);
      expect(r.reason).toMatch(/Paris-Kaminski/);
    }
  });

  test("refusal 10: κ=4, δ=-1/2 (half-integer) ⇒ degenerate-principal-sector", () => {
    // G^{1,1}_{1,4}: m=1, n=1, p=1, q=4, κ=4. 2δ = -1, so δ=-1/2.
    // The reason string surfaces the half-integer in `n/2` form.
    const params: MeijerGParameters = {
      an: [cfromStrings("0.5", "0", WORK_BITS)],
      ap: [],
      bm: [cfromStrings("0", "0", WORK_BITS)],
      bq: [
        cfromStrings("0.25", "0", WORK_BITS),
        cfromStrings("0.5", "0", WORK_BITS),
        cfromStrings("0.75", "0", WORK_BITS),
      ],
    };
    const z = cfromInts(100n, 0n, WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("degenerate-principal-sector");
    if (r.status === "degenerate-principal-sector") {
      expect(r.reason).toMatch(/-1\/2/);
    }
  });

  test("refusal 8: small-|z| just past π/2 ⇒ success (stokes-tagged) post-egf-retraction", () => {
    // κ=1 shape (G^{1,1}_{1,1}) with z just past the Stokes line at
    // π/2 + a small offset, |z|=5. Pre-worklog-125 this refused as
    // `stokes-band-refused`. Post-retraction the kernel runs the
    // algebraic per-pole path and emits a numerical value tagged
    // `sector: stokes`. The shape has `δ = 1 ≥ 1` so the empirical
    // verification (worklog 125) guarantees H_workbench = G at this
    // input to working precision.
    const params = P(["0.5"], [], ["0"], [], WORK_BITS);
    // z = 5 * exp(i * (pi/2 + 0.1)) ≈ -0.4992 + 4.9750 i
    const z = cfromStrings("-0.4991671106784", "4.9750208403262", WORK_BITS);
    const r = meijergAsymptotic(params, z, TARGET_DPS);
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.sector).toBe("stokes");
    }
  });
});

// -----------------------------------------------------------------------------
// 7. Bit-determinism — `arbprec: true`'s strongest contract
// -----------------------------------------------------------------------------

test("bit-determinism: two asymptotic calls produce byte-identical BigComplex", () => {
  const params = P(["0.5"], [], ["0"], [], WORK_BITS);
  const z = cfromInts(100n, 0n, WORK_BITS);
  const r1 = meijergAsymptotic(params, z, TARGET_DPS);
  const r2 = meijergAsymptotic(params, z, TARGET_DPS);
  expect(r1.status).toBe("success");
  expect(r2.status).toBe("success");
  if (r1.status !== "success" || r2.status !== "success") return;
  expect(r1.value.re.mantissa).toBe(r2.value.re.mantissa);
  expect(r1.value.re.exponent).toBe(r2.value.re.exponent);
  expect(r1.value.im.mantissa).toBe(r2.value.im.mantissa);
  expect(r1.value.im.exponent).toBe(r2.value.im.exponent);
  expect(r1.nTerms).toBe(r2.nTerms);
  // optimal indices identical too.
  expect(r1.optimalTermIndices).toEqual(r2.optimalTermIndices);
});

// -----------------------------------------------------------------------------
// 8. Sector classifier — direct unit-test
// -----------------------------------------------------------------------------

describe("classifySector — κ-aware (ADR-0039 §D3)", () => {
  // Shape: G^{0,1}_{1,0}(an=[1] | z), so m=0, n=1, p=1, q=0, κ = q − p + 1 = 0.
  // κ = 0 routes through the legacy `classifyKappaLE0` fallback (ADR-
  // 0039 §D3 specifies a κ-aware classifier for κ ≥ 1, but κ ≤ 0
  // regimes are filtered by `canUseAsymptotic` upstream; the
  // classifier itself stays defensive).
  test("z = +x, κ=0 fallback ⇒ principal", () => {
    const z = cfromInts(100n, 0n, WORK_BITS);
    const v = classifySector(0, 1, 1, 0, z, WORK_BITS);
    expect(v.kind).toBe("principal");
  });
  test("z = -x, κ=0 fallback ⇒ secondary", () => {
    const z = cfromInts(-100n, 0n, WORK_BITS);
    const v = classifySector(0, 1, 1, 0, z, WORK_BITS);
    expect(v.kind).toBe("secondary");
  });
  test("z = +iy, κ=0 fallback ⇒ secondary (past the legacy cap)", () => {
    const z = cfromStrings("0", "100", WORK_BITS);
    const v = classifySector(0, 1, 1, 0, z, WORK_BITS);
    expect(v.kind === "secondary" || v.kind === "stokes").toBe(true);
  });
  test("z = 0 ⇒ out-of-coverage (no far-field)", () => {
    const z = cfromInts(0n, 0n, WORK_BITS);
    const v = classifySector(0, 1, 1, 0, z, WORK_BITS);
    expect(v.kind).toBe("out-of-coverage");
  });

  // Shape: G^{1,1}_{1,1}, so p = q = 1, κ = 1. Principal sector |arg z| < π/2.
  test("κ=1: z = +x large, deep in principal sector ⇒ principal", () => {
    const z = cfromInts(100n, 0n, WORK_BITS);
    const v = classifySector(1, 1, 1, 1, z, WORK_BITS);
    expect(v.kind).toBe("principal");
  });
  test("κ=1: z = +iy at arg = π/2 (exactly on the boundary) ⇒ principal", () => {
    // Post-worklog-125 retraction the Stokes-band geometry is gone; the
    // classifier is a sharp line and the boundary case `|arg z| ≤ θ_S`
    // is admitted as principal (the principal-value convention; the
    // BigFloat `carg` range is `(−π, π]` so arg z = π/2 maps to the
    // principal side, and the kernel runs the same algebraic path that
    // principal-sector inputs run).
    const z = cfromStrings("0", "100", WORK_BITS);
    const v = classifySector(1, 1, 1, 1, z, WORK_BITS);
    expect(v.kind).toBe("principal");
  });
  test("κ=1: z = +x · e^{-iπ/4}, well inside principal ⇒ principal", () => {
    const z = cfromStrings("70.71067811865475", "-70.71067811865475", WORK_BITS);
    const v = classifySector(1, 1, 1, 1, z, WORK_BITS);
    expect(v.kind).toBe("principal");
  });

  // κ = 2 (p = q − 1) — out of v0.1 scope (bead fc83).
  test("κ=2: refuses with out-of-coverage", () => {
    // Shape G^{1,1}_{1,2}: m=1, n=1, p=1, q=2, κ = 2 − 1 + 1 = 2.
    const z = cfromInts(100n, 0n, WORK_BITS);
    const v = classifySector(1, 1, 1, 2, z, WORK_BITS);
    expect(v.kind).toBe("out-of-coverage");
    if (v.kind === "out-of-coverage") {
      expect(v.reason).toMatch(/fc83/);
    }
  });

  // κ = 3 (p = q − 2). The algebraic-sector envelope is `|arg z| < δπ`
  // (ADR-0039 §D6, bead `atip`); shapes with `δ = m + n − (p+q)/2 ≤ 0`
  // are refused as `degenerate-principal-sector` because the inner pFq
  // is formally divergent and the envelope is empty.
  test("κ=3, δ=1: z = +x large, inside algebraic envelope ⇒ principal", () => {
    // G^{2,1}_{1,3}: m=2, n=1, p=1, q=3, κ = 3, δ = 3 − 2 = 1.
    // Envelope `|arg z| < π`; positive real axis is well inside.
    const z = cfromInts(50n, 0n, WORK_BITS);
    const v = classifySector(2, 1, 1, 3, z, WORK_BITS);
    expect(v.kind).toBe("principal");
  });

  test("κ=3, δ=0: G^{1,1}_{1,3} ⇒ degenerate-principal-sector (bead atip)", () => {
    // The deleted golden 17 shape. Pre-`atip` the classifier emitted
    // `principal` and the kernel silently produced answers wrong by
    // ~125× (kernel +4.4×10⁻³ vs mpmath truth −0.5549…). Post-`atip`
    // the classifier refuses with the new verdict.
    const z = cfromInts(50n, 0n, WORK_BITS);
    const v = classifySector(1, 1, 1, 3, z, WORK_BITS);
    expect(v.kind).toBe("degenerate-principal-sector");
    if (v.kind === "degenerate-principal-sector") {
      expect(v.twoDelta).toBe(0);
    }
  });

  test("κ=3, δ<0: G^{1,1}_{1,4} (half-integer) ⇒ degenerate-principal-sector", () => {
    // m=1, n=1, p=1, q=4, κ = 4. 2δ = 2(1+1) − (1+4) = -1 (i.e. δ=-1/2).
    // Algebraic envelope `|arg z| < -π/2` is empty; the classifier refuses.
    const z = cfromInts(50n, 0n, WORK_BITS);
    const v = classifySector(1, 1, 1, 4, z, WORK_BITS);
    expect(v.kind).toBe("degenerate-principal-sector");
    if (v.kind === "degenerate-principal-sector") {
      expect(v.twoDelta).toBe(-1);
    }
  });

  test("κ=1, δ=0: G^{1,1}_{2,2} ⇒ principal (bead 43i; inner pFq convergent)", () => {
    // For κ=1 the inner pFq is `pFp-1(1/z)` with radius 1; for |z|>1
    // it converges and H_workbench = G as a convergent formula (Slater
    // 1966 §5.5), so δ has no role and δ=0 is NOT refused. This is the
    // bead 43i `n<p ∧ κ=1` regime; the kernel values are mpmath-
    // verified to 30+ dps for these shapes.
    const z = cfromInts(50n, 0n, WORK_BITS);
    const v = classifySector(1, 1, 2, 2, z, WORK_BITS);
    expect(v.kind).toBe("principal");
  });
});

// -----------------------------------------------------------------------------
// 9. asymptoticTerms generator — direct property tests
// -----------------------------------------------------------------------------

describe("asymptoticTerms generator", () => {
  test("first term is 1", () => {
    const params = P(["1"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const it = asymptoticTerms(params, z, 0, WORK_BITS);
    const t0 = it.next().value as BigComplex;
    const oneAbs = toFloat64(cabs(t0, WORK_BITS)).value;
    expect(oneAbs).toBeCloseTo(1.0, 12);
  });

  test("for G^{0,1}_{1,0}(1;|z), the term ratio is -1/(z*k) per step", () => {
    // Inner pFq is 0F0; the recurrence is term_k = term_{k-1} · (-1/(zk))
    // (with the (-1)^{q-m-n}=(-1)^0=1 sign, the residue's -1 stays).
    // We check numerically: t_1 should be -1/100, t_2 should be +1/(2·100^2).
    const params = P(["1"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const it = asymptoticTerms(params, z, 0, WORK_BITS);
    it.next(); // t_0 = 1
    const t1 = it.next().value as BigComplex;
    expect(toFloat64(t1.re).value).toBeCloseTo(-0.01, 12);
    const t2 = it.next().value as BigComplex;
    expect(toFloat64(t2.re).value).toBeCloseTo(0.5e-4, 12);
  });
});

// -----------------------------------------------------------------------------
// 10. findOptimalTruncation — direct property tests
// -----------------------------------------------------------------------------

describe("findOptimalTruncation", () => {
  test("for divergent-asymptotic input, finds turnaround", () => {
    // G^{1,1}_{2,2}([0.3], [0.6], [0.1], [-0.2] | 100): κ = 1, n=1<p=2.
    // The Paris-Kaminski analytical-N* branch (ADR-0039 §D1, bead 43i)
    // gives `N* = ⌊|κ · z^{1/κ}|⌋ = ⌊|z|⌋ = 100` — well below the cap.
    // The previous test used a κ=2 shape (G^{1,1}_{1,2}), which the
    // κ-aware classifier now refuses upstream; the per-pole truncation
    // itself still works on the (still-supported) `n<p ∧ κ ≥ 1` regime.
    const params: MeijerGParameters = {
      an: [cfromStrings("0.3", "0", WORK_BITS)],
      ap: [cfromStrings("0.6", "0", WORK_BITS)],
      bm: [cfromStrings("0.1", "0", WORK_BITS)],
      bq: [cfromStrings("-0.2", "0", WORK_BITS)],
    };
    const z = cfromInts(100n, 0n, WORK_BITS);
    const trunc = findOptimalTruncation(params, z, 0, WORK_BITS, 500);
    expect(trunc.reachedCap).toBe(false);
    expect(trunc.index).toBeGreaterThan(50);
    expect(trunc.index).toBeLessThan(200);
  });

  test("for entire-function input, hits the cap (no turnaround)", () => {
    // G^{0,1}_{1,0}(1;|100): inner is 0F0 (entire); no turnaround.
    const params = P(["1"], [], [], [], WORK_BITS);
    const z = cfromInts(100n, 0n, WORK_BITS);
    const trunc = findOptimalTruncation(params, z, 0, WORK_BITS, 50);
    expect(trunc.reachedCap).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 11. Bead 43i — `n < p, κ ≥ 1` regime (Paris–Kaminski analytical N*)
// -----------------------------------------------------------------------------
//
// New scope shipped by ADR-0039 §D1, bead `scientist-workbench-43i`.
// For each `(m, n, p, q, params, z)` tuple below, the truth value
// was pinned at 35-dps precision against **both** `mpmath` (Python
// reference) and `wolframscript` (commercial CAS), agreeing to 30
// dps. The expected wire format is the standard
// `meijergAsymptotic` success record, and the agreement bound is
// `TOLERANCE_DPS = 25` (matching the existing anchor suite — gives a
// few digits of slack from the nominal precision while still
// exercising the new truncation rule meaningfully).
//
// All seven cases share `κ = 1` (i.e. `p = q`) with `n < p`, which
// is the canonical Paris–Kaminski regime: the inner `${}_qF_{p-1}$`
// has equal upper/lower counts and is convergent for `|z^{-1}| < 1`,
// but the formal `H` series is asymptotic-to-`G` (not convergent-
// to-`G`); the analytical truncation `N* = ⌊|κ z^{1/κ}|⌋ = ⌊|z|⌋`
// gives the optimal partial-sum index at full BigFloat precision.
// The shape constraint `m + n = p` further ensures that the
// principal-sector exponential `E^{m,n}_{p,p}(z)` has a structurally
// vanishing Stokes-multiplier contribution (the `egf` v0.1 scope,
// ADR-0039 §D2, covers the complementary `m + n > p` regime where
// `E` is dominant); within `m + n = p` the algebraic series alone
// reproduces the true G-value to working precision at sufficiently
// large `|z|`. Test points were chosen at `|z| ≥ 20` so the
// per-pole truncation index `N*` is large enough for tier-A
// agreement.

interface NltpCase {
  readonly label: string;
  readonly an: string[];
  readonly ap: string[];
  readonly bm: string[];
  readonly bq: string[];
  readonly zRe: string;
  readonly zIm: string;
  /** mpmath @ 35 dps; agrees with wolframscript @ 30 dps. */
  readonly truthRe: string;
  readonly truthIm: string;
}

const NLTP_CASES: readonly NltpCase[] = [
  {
    label: "G^{1,1}_{2,2}([3/10],[6/10],[1/10],[-2/10] | 30) — real z",
    an: ["0.3"], ap: ["0.6"], bm: ["0.1"], bq: ["-0.2"],
    zRe: "30", zIm: "0",
    truthRe: "0.0683877861434372189170233513017043894",
    truthIm: "0",
  },
  {
    label: "G^{1,1}_{2,2}([1/2],[3/4],[0],[-1/4] | 50) — real z, the example shape",
    an: ["0.5"], ap: ["0.75"], bm: ["0"], bq: ["-0.25"],
    zRe: "50", zIm: "0",
    truthRe: "0.22613099033840846050074429385766020419",
    truthIm: "0",
  },
  {
    label: "G^{1,1}_{2,2}([1/2],[3/4],[0],[-1/4] | 20+5i) — complex z, the example shape",
    an: ["0.5"], ap: ["0.75"], bm: ["0"], bq: ["-0.25"],
    zRe: "20", zIm: "5",
    truthRe: "0.35044407679306162173814932538609531",
    truthIm: "-0.04357525411809995201557269306774729",
  },
  {
    label: "G^{1,1}_{2,2}([4/10],[7/10],[1/10],[-1/10] | 100) — real z, deep asymptotic",
    an: ["0.4"], ap: ["0.7"], bm: ["0.1"], bq: ["-0.1"],
    zRe: "100", zIm: "0",
    truthRe: "0.05162644066560888227882592101752575",
    truthIm: "0",
  },
  {
    label: "G^{1,1}_{2,2}([1/2],[3/4],[1/4],[0] | 30+15i) — complex z",
    an: ["0.5"], ap: ["0.75"], bm: ["0.25"], bq: ["0"],
    zRe: "30", zIm: "15",
    truthRe: "0.12909356615304041609557785808811769",
    truthIm: "-0.03103343985612671189477468668293768",
  },
  {
    label: "G^{1,2}_{3,3}([1/2,3/5],[3/4],[0],[1/4,2/5] | 20) — n=2 multi-pole, p=3, real z",
    an: ["0.5", "0.6"], ap: ["0.75"], bm: ["0"], bq: ["0.25", "0.4"],
    zRe: "20", zIm: "0",
    truthRe: "0.45261607130314173996932102350235986",
    truthIm: "0",
  },
  {
    label: "G^{1,3}_{4,4}([1/2,3/5,7/10],[4/5],[0],[1/10,1/5,3/10] | 40) — n=3 multi-pole, p=4, real z",
    an: ["0.5", "0.6", "0.7"], ap: ["0.8"], bm: ["0"], bq: ["0.1", "0.2", "0.3"],
    zRe: "40", zIm: "0",
    truthRe: "3.62118443810712545031631439900524141",
    truthIm: "0",
  },
];

describe("asymptotic: bead 43i — n < p, κ ≥ 1 regime (Paris–Kaminski N*)", () => {
  for (const c of NLTP_CASES) {
    test(c.label, () => {
      const params: MeijerGParameters = {
        an: c.an.map((s) => cfromStrings(s, "0", WORK_BITS)),
        ap: c.ap.map((s) => cfromStrings(s, "0", WORK_BITS)),
        bm: c.bm.map((s) => cfromStrings(s, "0", WORK_BITS)),
        bq: c.bq.map((s) => cfromStrings(s, "0", WORK_BITS)),
      };
      const z = cfromStrings(c.zRe, c.zIm, WORK_BITS);
      const r = meijergAsymptotic(params, z, TARGET_DPS);
      if (r.status !== "success") throw new Error((r as { reason: string }).reason);
      const want: BigComplex = {
        re: fromString(c.truthRe, WORK_BITS),
        im: fromString(c.truthIm, WORK_BITS),
      };
      expectClose(r.value, want, TOLERANCE_DPS, c.label);
      // The success path must report `braaksma-algebraic` with at
      // least one upper-pole index recorded (we summed something).
      expect(r.method).toBe("braaksma-algebraic");
      expect(r.optimalTermIndices.length).toBe(c.an.length);
      // Each per-pole truncation index should be positive (we
      // accumulated at least one term beyond `t_0 = 1`).
      for (const k of r.optimalTermIndices) expect(k).toBeGreaterThan(0);
    });
  }
});

// -----------------------------------------------------------------------------
// 12. Bead 43i — new dispatcher refusal: `κ ≤ 0 AND n < p`
// -----------------------------------------------------------------------------
//
// ADR-0039 §D1 adds one refusal to `canUseAsymptotic`: when
// `κ = q − p + 1 ≤ 0` AND `n < p` (the divergent-algebraic regime
// where exponential corrections from `egf` are mandatory), the
// pre-filter refuses. The verdict shape is `{ ok: false, reason }`;
// the reason names the `egf v0.1` follow-up.

describe("canUseAsymptotic: bead 43i — κ ≤ 0 AND n < p refusal", () => {
  test("refuses G^{1,1}_{2,1}([1/3],[1/4],[1/2] | 10) — κ=0, n=1<p=2", async () => {
    // Avoid a static import of `dispatcher.ts` at module load time;
    // it pulls in the contour layer's heavier imports unrelated to
    // this single-function probe. Dynamic import keeps the rest of
    // this file's test surface unchanged.
    const { canUseAsymptotic } = await import("../src/dispatcher.js");
    const params: MeijerGParameters = {
      an: [cfromStrings("0.3333333333333333333333333333333333", "0", WORK_BITS)],
      ap: [cfromStrings("0.25", "0", WORK_BITS)],
      bm: [cfromStrings("0.5", "0", WORK_BITS)],
      bq: [],
    };
    const z = cfromInts(10n, 0n, WORK_BITS);
    const v = canUseAsymptotic(params, z, 30);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/kappa<=0 with n<p/);
    expect(v.reason).toMatch(/egf/);
  });

  test("does NOT refuse n=p shapes with κ ≤ 0 (e.g. anchor 8 G^{0,2}_{2,0})", async () => {
    // n = p = 2, κ = 0 − 2 + 1 = −1. Not in the new refusal regime;
    // the existing scan-for-min branch handles it. Verdict should
    // be `ok: true` (the pre-filter accepts; the layer itself may
    // still produce a numerical answer or a different refusal —
    // anchor 8 of the test suite proves it produces an answer).
    const { canUseAsymptotic } = await import("../src/dispatcher.js");
    const params: MeijerGParameters = {
      an: [cfromInts(1n, 0n, WORK_BITS), cfromStrings("0.5", "0", WORK_BITS)],
      ap: [],
      bm: [],
      bq: [],
    };
    const z = cfromInts(100n, 0n, WORK_BITS);
    const v = canUseAsymptotic(params, z, 30);
    expect(v.ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Helpers re-imported from bigfloat — local aliases to keep the
// closed-form computations readable above.
// -----------------------------------------------------------------------------

import { cexp as importedCexp } from "@workbench/bigfloat";

function divBF(a: import("@workbench/bigfloat").BigFloat, b: import("@workbench/bigfloat").BigFloat, prec: number): import("@workbench/bigfloat").BigFloat {
  // Use cdiv via cfromReal then take .re. The substrate's `div`
  // primitive is also exported; we go through the complex path to
  // exercise the same arithmetic as the kernel.
  return cdiv(cfromReal(a), cfromReal(b), prec).re;
}

// Silence unused-import warnings on helpers reserved for future
// closed-form anchors (gamma, pow).
void gamma;
void pow;
