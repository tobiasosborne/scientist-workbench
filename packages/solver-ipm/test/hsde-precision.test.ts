// Phase 5 Tier 1 — iterative refinement on the regularised Cholesky back-sub.
//
// These tests target `solveWithIR` directly, on hand-built linear systems
// where the true solution is known by construction. The point of IR is a
// *precision* claim — "the regularised back-sub is sharpened back toward the
// unperturbed system" — so the tests assert precision, not merely that the
// loop runs (Rule 7).
//
// Construction: `M = L0 · L0ᵀ` for a chosen lower-triangular `L0`, which makes
// `M` symmetric positive-definite by construction, and ill-conditioned when
// `L0`'s diagonal spans many decades. With a known `dyTrue`, `rhs = M · dyTrue`
// is exact-ish in float64 for the small integerish entries used here, so
// `dyTrue` is a genuine oracle.
//
// End-to-end coverage that IR doesn't perturb solver trajectories is the
// existing solver-ipm suite (hsde-lp / hsde-sdp / netlib / sdp-*): those still
// pass unchanged, which *is* the "same wire output as Tier 0" evidence. The
// deep hinf2 / Mosek-oracle precision campaign is Tier 2 (`fsr7`); see
// worklog 110 for the hinf2 diagnostic run.

import { describe, expect, test } from "bun:test";
import { cholesky, choleskySolveInPlace } from "../src/linalg/Cholesky.js";
import { solveWithIR } from "../src/linalg/IterativeRefinement.js";

/** Dense symmetric `M·v` for row-major `m × m` `M`. */
function matVec(M: Float64Array, m: number, v: Float64Array): Float64Array {
  const out = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += M[i * m + j]! * v[j]!;
    out[i] = s;
  }
  return out;
}

function infNorm(v: Float64Array): number {
  let n = 0;
  for (const x of v) n = Math.max(n, Math.abs(x));
  return n;
}

/** `‖M·dy − rhs‖∞` — the residual against the *unperturbed* M. */
function resNorm(M: Float64Array, m: number, dy: Float64Array, rhs: Float64Array): number {
  const Mdy = matVec(M, m, dy);
  let n = 0;
  for (let i = 0; i < m; i++) n = Math.max(n, Math.abs(Mdy[i]! - rhs[i]!));
  return n;
}

/** `M = L0 · L0ᵀ` for row-major lower-triangular `L0` (`m × m`). SPD by construction. */
function gram(L0: number[][], m: number): Float64Array {
  const M = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += L0[i]![k]! * L0[j]![k]!;
      M[i * m + j] = s;
    }
  }
  return M;
}

describe("solveWithIR — ill-conditioned system", () => {
  // L0 diagonal spans 1e4 … 1e-3, so cond(M) ≈ (1e4 / 1e-3)² ≈ 1e14 — the
  // regime that pins hinf2 at its precision floor (Schur Mdiag ~ [1e7, 1e13]).
  const m = 3;
  const L0 = [
    [1e4, 0, 0],
    [1, 1, 0],
    [1, 1, 1e-3],
  ];
  const M = gram(L0, m);
  const dyTrue = Float64Array.from([1, 1, 1]);
  const rhs = matVec(M, m, dyTrue);
  // The solver's default Tikhonov cap. Against M's tiny ~2e-6 corner this is a
  // huge relative perturbation — exactly what IR has to undo.
  const reg = 1e-2;
  const Mreg = new Float64Array(M);
  for (let i = 0; i < m; i++) Mreg[i * m + i] = Mreg[i * m + i]! + reg;
  const { factored: Lchol, info } = cholesky(Mreg, m);

  test("the regularised factor is well-formed (sanity)", () => {
    expect(info).toBe(-1);
  });

  test("IR fires (nitref ≥ 1) and strictly improves the residual", () => {
    // Baseline: the plain regularised back-sub — what Tier 0 shipped.
    const dyReg = new Float64Array(rhs);
    choleskySolveInPlace(Lchol, m, dyReg);
    const regRes = resNorm(M, m, dyReg, rhs);

    // IR path.
    const dyIR = new Float64Array(m);
    const workE = new Float64Array(m);
    const workCorr = new Float64Array(m);
    const nitref = solveWithIR(M, m, Lchol, rhs, dyIR, workE, workCorr);

    expect(nitref).toBeGreaterThanOrEqual(1);
    expect(nitref).toBeLessThanOrEqual(9);
    // The decisive invariant: IR's residual against the *unperturbed* M is
    // strictly smaller than the regularised solve's.
    expect(resNorm(M, m, dyIR, rhs)).toBeLessThan(regRes);
  });

  test("IR moves the iterate closer to the true solution", () => {
    const dyReg = new Float64Array(rhs);
    choleskySolveInPlace(Lchol, m, dyReg);

    const dyIR = new Float64Array(m);
    solveWithIR(M, m, Lchol, rhs, dyIR, new Float64Array(m), new Float64Array(m));

    const regErr = infNorm(Float64Array.from(dyReg, (v, i) => v - dyTrue[i]!));
    const irErr = infNorm(Float64Array.from(dyIR, (v, i) => v - dyTrue[i]!));
    expect(irErr).toBeLessThan(regErr);
  });

  test("IR never returns a worse residual than the initial regularised solve", () => {
    // The trial-and-rollback contract: every accepted step reduces the
    // residual, and a non-improving step is rolled back — so the returned
    // residual is bounded above by the initial back-sub's, always.
    const dyReg = new Float64Array(rhs);
    choleskySolveInPlace(Lchol, m, dyReg);
    const regRes = resNorm(M, m, dyReg, rhs);

    const dyIR = new Float64Array(m);
    solveWithIR(M, m, Lchol, rhs, dyIR, new Float64Array(m), new Float64Array(m));
    expect(resNorm(M, m, dyIR, rhs)).toBeLessThanOrEqual(regRes);
  });
});

describe("solveWithIR — already-accurate factor", () => {
  // A benign 2×2 with an *exact* factor (reg = 0, so Lchol = chol(M)). The
  // initial back-sub is already at float64 accuracy — well inside
  // `tolRel·(1 + ‖rhs‖∞)` — so IR must recognise that and do nothing. This is
  // the nitref = 0 branch: in the solver it is what a well-conditioned iter,
  // or one where the Tikhonov lift is negligible against M, looks like.
  const m = 2;
  const M = Float64Array.from([4, 1, 1, 3]);
  const dyTrue = Float64Array.from([2, -1]);
  const rhs = matVec(M, m, dyTrue);
  const { factored: Lchol } = cholesky(M, m);

  test("nitref is 0 — the initial back-sub is already within tolerance", () => {
    const dyIR = new Float64Array(m);
    const nitref = solveWithIR(M, m, Lchol, rhs, dyIR, new Float64Array(m), new Float64Array(m));
    expect(nitref).toBe(0);
  });

  test("with nitref 0, the result is exactly the plain back-substitution", () => {
    const dyPlain = new Float64Array(rhs);
    choleskySolveInPlace(Lchol, m, dyPlain);

    const dyIR = new Float64Array(m);
    solveWithIR(M, m, Lchol, rhs, dyIR, new Float64Array(m), new Float64Array(m));
    // Bit-identical: a 0-step IR is just the initial back-sub.
    expect(Array.from(dyIR)).toEqual(Array.from(dyPlain));
  });

  test("the solution is accurate to the true answer", () => {
    const dyIR = new Float64Array(m);
    solveWithIR(M, m, Lchol, rhs, dyIR, new Float64Array(m), new Float64Array(m));
    expect(infNorm(Float64Array.from(dyIR, (v, i) => v - dyTrue[i]!))).toBeLessThan(1e-12);
  });
});

describe("solveWithIR — trial-and-rollback with a poor preconditioner", () => {
  // The rollback path: a refinement step that *increases* the residual must be
  // undone, so `solveWithIR` is never worse than its own initial back-sub.
  //
  // In exact arithmetic IR with the true factor of `M + reg·I` is monotone, so
  // the rollback only earns its keep when the factor is a *poor* approximation
  // of M. We provoke exactly that: hand `solveWithIR` the factor of the
  // identity instead of a factor of M. With `M = 10·I` the correction
  // recurrence `dy ← dy + (rhs − M·dy)` has spectral radius 9 — it diverges —
  // so the first trial step overshoots hugely (residual 90 → 810). A correct
  // implementation rejects it, rolls `dy` back, and returns nitref = 0 with
  // the *initial* residual intact. (Removing the rollback leaves `dy` at the
  // overshot iterate and fails the residual assertion below.)
  const m = 2;
  const M = Float64Array.from([10, 0, 0, 10]);
  const dyTrue = Float64Array.from([1, 1]);
  const rhs = matVec(M, m, dyTrue);
  const { factored: badLchol } = cholesky(Float64Array.from([1, 0, 0, 1]), m);

  test("an overshooting correction is rolled back, not committed", () => {
    const dyInit = new Float64Array(rhs);
    choleskySolveInPlace(badLchol, m, dyInit);
    const initRes = resNorm(M, m, dyInit, rhs);

    const dyIR = new Float64Array(m);
    const nitref = solveWithIR(M, m, badLchol, rhs, dyIR, new Float64Array(m), new Float64Array(m));

    // The bad step was rejected: it counts as no accepted refinement…
    expect(nitref).toBe(0);
    // …and `dy` is exactly the initial back-sub, residual unchanged — IR with
    // a useless preconditioner does no harm.
    expect(resNorm(M, m, dyIR, rhs)).toBe(initRes);
    expect(Array.from(dyIR)).toEqual(Array.from(dyInit));
  });
});
