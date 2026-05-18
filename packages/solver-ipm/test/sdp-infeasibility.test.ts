// SDP infeasibility / unboundedness classification — bead `io2v` regression.
//
// Background. Bead `jb1x`'s SDPLIB stress test (`scripts/sdplib-stress.ts`)
// surfaced that the four explicitly-infeasible SDPLIB cases (infp1, infp2
// primal-infeasible; infd1, infd2 dual-infeasible / primal-unbounded) all
// returned wire `status=optimal` with `achieved_precision` in the 1e+1 to
// 1e+5 range. Two distinct bugs upstream of `tools/sdp-solve`:
//
//   1. NT path (`NtSdpSolver.ts`). `bestStatus = "dual-feasible"` was set
//      unconditionally whenever the best-iterate `achieved` metric improved.
//      The status-map `dual-feasible → optimal` (worklog 095, kept for the
//      control2/control3/hinf2 soft-success path) then turned every
//      best-iterate snapshot — including iter-0 snapshots on infeasible
//      inputs — into wire `optimal`. Fix: gate the stamp on `couldDualFeas`
//      (the iterate honestly meets one of abs_gap / rel_dual / abs_dual).
//
//   2. HSDE-NT path (`HsdeNtSdpSolver.ts`). `checkHsdeTermination` gated
//      *both* the OPTIMAL classification and the infeasibility-certificate
//      classifications on `max(ρ_p, ρ_d, ρ_g) ≤ 1`. On actually-infeasible
//      problems the iterate heads to a τ→0 limit, the purified ρ-metrics
//      inflate, the gate never trips, and the soft-success best-iterate
//      stamp fired the same lie as path (1). Fix: split the test. Optimal
//      keeps the ρ-gate; infeasibility certificates use UNPURIFIED
//      residual+witness tests (Mosek `hom_terminatelo` shape — decomp
//      `003f8460`; Andersen 2009 §3 ART03 dichotomy).
//
// Strategy. These tests pin four small constructed problems — two primal-
// infeasible, two dual-infeasible — that exhibit the same classification
// pattern as the SDPLIB infp/infd cases without needing the SDPLIB tarball
// on disk. Each test asserts:
//
//   - HSDE-NT returns the correct classification (primal-infeasible /
//     dual-infeasible) with a witness — `b^T y > 0` for primal-infeasible,
//     `⟨C, X⟩ < 0` for dual-infeasible.
//   - NT path does NOT lie. Pre-fix it returned `status="dual-feasible"`
//     (wire `optimal`); post-fix it returns numerical-error / numerical-
//     difficulty / iter-limit (any non-success status), or — for problems
//     where the iterate trajectory transiently looks dual-feasible — at
//     worst `dual-feasible` with `couldDualFeas` having honestly held.
//     The point is no false `optimal` from a snapshot with huge residuals.

import { describe, expect, test } from "bun:test";
import {
  solveSdpNt,
  solveHsdeSdpNt,
  type SdpProblem,
} from "../src/index.js";

const I2 = new Float64Array([1, 0, 0, 1]);
const E11 = new Float64Array([1, 0, 0, 0]);
const E22 = new Float64Array([0, 0, 0, 1]);
const E12sym = new Float64Array([0, 1, 1, 0]);

// ── Construction helpers ────────────────────────────────────────────────

// Primal-infeasible: 2×2 PSD block with four constraints that pin
// X_11 = 1, X_22 = 1, X_12 = 0, AND trace(X) = 3. The first three force
// X = I, which has trace 2; the fourth requires trace 3 — no PSD X
// satisfies all four. Direct analog of the SDPLIB infp* "over-constrained
// equality with contradictory RHS" pattern.
function makePrimalInfeasibleA(): SdpProblem {
  return {
    m: 4,
    blocks: [{ size: 2, C: I2, A: [E11, E22, E12sym, I2] }],
    b: new Float64Array([1, 1, 0, 3]),
    maximize: false,
  };
}

// Primal-infeasible: 2×2 PSD with trace(X) = 0 AND trace(X) = 1. The first
// constraint with X ⪰ 0 forces X = 0 (a PSD matrix with zero trace is zero);
// the second then can't hold. Different magnitudes / witness profile from A.
function makePrimalInfeasibleB(): SdpProblem {
  return {
    m: 2,
    blocks: [{ size: 2, C: I2, A: [I2, I2] }],
    b: new Float64Array([0, 1]),
    maximize: false,
  };
}

// Dual-infeasible (primal-unbounded): 2×2 PSD with X_11 = 0. The PSD
// constraint on a 2×2 matrix with X_11 = 0 forces X_12 = 0 too, leaving
// X = diag(0, t) for any t ≥ 0. The objective ⟨C, X⟩ = -t → -∞ as t → ∞.
function makeDualInfeasibleA(): SdpProblem {
  return {
    m: 1,
    blocks: [{ size: 2, C: new Float64Array([0, 0, 0, -1]), A: [E11] }],
    b: new Float64Array([0]),
    maximize: false,
  };
}

// Dual-infeasible: same shape as A but with two constraints (m=2),
// X_11 = 0 AND X_12 = 0 (the second is redundant given PSD but exercises
// a different Schur-matrix conditioning regime). Objective minimises -X_22.
function makeDualInfeasibleB(): SdpProblem {
  return {
    m: 2,
    blocks: [{ size: 2, C: new Float64Array([0, 0, 0, -1]), A: [E11, E12sym] }],
    b: new Float64Array([0, 0]),
    maximize: false,
  };
}

// ── Assertions ──────────────────────────────────────────────────────────

const HONEST_NT_STATUSES = new Set([
  "numerical-error",
  "numerical-difficulty",
  "iter-limit",
  "time-limit",
  "primal-infeasible",
  "dual-infeasible",
]);

function frobInner(A: Float64Array, B: Float64Array): number {
  let s = 0;
  for (let i = 0; i < A.length; i++) s += A[i]! * B[i]!;
  return s;
}

describe("HSDE-NT classifies infeasibility correctly (bead io2v)", () => {
  test("primal-infeasible A (4 contradictory equalities)", () => {
    const prob = makePrimalInfeasibleA();
    const res = solveHsdeSdpNt(prob);
    expect(res.status).toBe("primal-infeasible");
    // Farkas y witness: b^T y > 0 on the unpurified iterate.
    let bTyUnpur = 0;
    // The returned y is purified (divided by τ*); unpurify back via τ.
    for (let i = 0; i < prob.m; i++) bTyUnpur += prob.b[i]! * res.y[i]! * res.tau;
    expect(bTyUnpur).toBeGreaterThan(0);
    // τ near zero, κ substantial — the κ-dominant regime.
    expect(res.tau).toBeLessThan(0.01);
    expect(res.kappa).toBeGreaterThan(0.1);
  });

  test("primal-infeasible B (contradictory traces)", () => {
    const prob = makePrimalInfeasibleB();
    const res = solveHsdeSdpNt(prob);
    expect(res.status).toBe("primal-infeasible");
    expect(res.tau).toBeLessThan(0.01);
  });

  test("dual-infeasible A (X_11=0 with min -X_22)", () => {
    const prob = makeDualInfeasibleA();
    const res = solveHsdeSdpNt(prob);
    expect(res.status).toBe("dual-infeasible");
    // Recession ray witness: ⟨C, X⟩ < 0 on the unpurified iterate.
    let cTxUnpur = 0;
    for (const b of prob.blocks) {
      const Xunpur = new Float64Array(b.size * b.size);
      // X is purified (X*/τ*); multiply back by τ to get the unpurified ray.
      const Xpure = res.X[prob.blocks.indexOf(b)]!;
      for (let k = 0; k < Xunpur.length; k++) Xunpur[k] = Xpure[k]! * res.tau;
      cTxUnpur += frobInner(b.C, Xunpur);
    }
    expect(cTxUnpur).toBeLessThan(0);
    expect(res.tau).toBeLessThan(0.01);
    expect(res.kappa).toBeGreaterThan(0.1);
  });

  test("dual-infeasible B (X_11=0, X_12=0 with min -X_22)", () => {
    const prob = makeDualInfeasibleB();
    const res = solveHsdeSdpNt(prob);
    expect(res.status).toBe("dual-infeasible");
    expect(res.tau).toBeLessThan(0.01);
  });
});

describe("NT path does NOT lie on infeasible inputs (bead io2v)", () => {
  // Pre-fix: every case returned status="dual-feasible" (which Status.ts
  // maps to wire `optimal`). Post-fix: the status is honest — typically
  // numerical-error (NT factor fails when X or S leaves the cone on a
  // problem with no valid optimal trajectory), occasionally numerical-
  // difficulty / iter-limit. Never `optimal`, never `dual-feasible` with
  // huge residuals.

  test("primal-infeasible A", () => {
    const res = solveSdpNt(makePrimalInfeasibleA());
    expect(res.status).not.toBe("optimal");
    expect(res.status).not.toBe("dual-feasible");
    expect(HONEST_NT_STATUSES.has(res.status)).toBe(true);
  });

  test("primal-infeasible B", () => {
    const res = solveSdpNt(makePrimalInfeasibleB());
    expect(res.status).not.toBe("optimal");
    expect(res.status).not.toBe("dual-feasible");
    expect(HONEST_NT_STATUSES.has(res.status)).toBe(true);
  });

  test("dual-infeasible A", () => {
    const res = solveSdpNt(makeDualInfeasibleA());
    expect(res.status).not.toBe("optimal");
    expect(res.status).not.toBe("dual-feasible");
    expect(HONEST_NT_STATUSES.has(res.status)).toBe(true);
  });

  test("dual-infeasible B", () => {
    const res = solveSdpNt(makeDualInfeasibleB());
    expect(res.status).not.toBe("optimal");
    expect(res.status).not.toBe("dual-feasible");
    expect(HONEST_NT_STATUSES.has(res.status)).toBe(true);
  });
});
