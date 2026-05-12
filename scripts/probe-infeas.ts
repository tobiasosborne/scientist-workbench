// scripts/probe-infeas.ts — diagnostic for SDP infeasibility classification.
//
// Companion to bead `io2v` / worklog 097. Constructs minimal primal-
// infeasible and dual-infeasible SDPs in-memory (no SDPLIB tarball
// required) and runs them through both `solveSdpNt` and `solveHsdeSdpNt`.
// Prints one line per (case, method) with status / iter / pObj / dObj /
// τ / κ / achievedPrecision. Useful when:
//
//   - Iterating on `checkHsdeTermination` thresholds (`WITNESS_FLOOR`,
//     `TAU_KAPPA_FLOOR`, the `prstatus < −0.5` regime guard).
//   - Investigating whether the NT path's `couldDualFeas` gate fires
//     on a new infeasibility-like trajectory.
//   - Verifying the wire status reported by `tools/sdp-solve` matches
//     the in-memory solver call.
//
// `packages/solver-ipm/test/sdp-infeasibility.test.ts` is the
// authoritative regression for the same four cases (assertions, not
// just prints); use this probe for *iterative debugging* and the
// test file for *acceptance*.
import { solveSdpNt, solveHsdeSdpNt, type SdpProblem } from "@workbench/solver-ipm";

// ── Primal-infeasible SDP ──
// 2×2 PSD block. Constraints: X_11 = 1, X_22 = 1, 2*X_12 = 0, trace(X) = 3.
// X_11 + X_22 = 2 but trace required = 3 ⇒ contradiction.
const I2 = new Float64Array([1, 0, 0, 1]);
const E11 = new Float64Array([1, 0, 0, 0]);
const E22 = new Float64Array([0, 0, 0, 1]);
const E12sym = new Float64Array([0, 1, 1, 0]);

const primalInfeas: SdpProblem = {
  m: 4,
  blocks: [{
    size: 2,
    C: I2,                          // objective: minimize trace
    A: [E11, E22, E12sym, I2],
  }],
  b: new Float64Array([1, 1, 0, 3]),
  maximize: false,
};

// ── Dual-infeasible SDP (primal unbounded) ──
// 2×2 PSD block. m=1: ⟨A_1, X⟩ = X_11 = 0. Feasible set: {diag(0, t) : t ≥ 0}.
// C = -E22 ⇒ ⟨C, X⟩ = -t → -∞ as t → ∞.
const dualInfeas: SdpProblem = {
  m: 1,
  blocks: [{
    size: 2,
    C: new Float64Array([0, 0, 0, -1]),
    A: [E11],
  }],
  b: new Float64Array([0]),
  maximize: false,
};

function run(name: string, prob: SdpProblem) {
  console.log(`\n=== ${name} ===`);
  for (const [tag, fn] of [
    ["NT     ", () => solveSdpNt(prob)],
    ["HSDE-NT", () => solveHsdeSdpNt(prob)],
  ] as const) {
    try {
      const r = fn();
      const pObj = r.primalObj;
      const dObj = r.dualObj;
      // HSDE result has extra tau/kappa
      const tau = "tau" in r ? (r as { tau: number }).tau : "n/a";
      const kappa = "kappa" in r ? (r as { kappa: number }).kappa : "n/a";
      const ap = "achievedPrecision" in r
        ? (r as { achievedPrecision: number }).achievedPrecision
        : "n/a";
      console.log(`  ${tag}: status=${r.status} iter=${r.iter} ` +
        `pObj=${pObj.toExponential(3)} dObj=${dObj.toExponential(3)} ` +
        `pInf=${r.primalInf.toExponential(2)} dInf=${r.dualInf.toExponential(2)} ` +
        `mu=${r.mu.toExponential(2)} tau=${typeof tau === "number" ? tau.toExponential(2) : tau} ` +
        `kappa=${typeof kappa === "number" ? kappa.toExponential(2) : kappa} ap=${typeof ap === "number" ? ap.toExponential(2) : ap}`);
    } catch (e) {
      console.log(`  ${tag}: THREW ${(e as Error).message}`);
    }
  }
}

run("primal-infeasible (4 contradictory eq's on 2x2 PSD)", primalInfeas);
run("dual-infeasible/primal-unbounded (X_11=0 with min -X_22)", dualInfeas);
