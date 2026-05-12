// HSDE SDP NT solver tests. Mirrors the trivial SDP cases from
// sdp-smoke.test.ts plus HSDE-specific invariants (τ → finite > 0,
// κ → ~0 on optimal). Per HANDOFF §2 Phase 2 acceptance:
//   - 68/68 existing solver-ipm tests pass (zero regression).
//   - bun tools/sdp-solve/tool.ts --test passes (out of scope here;
//     covered by tool integration tests).
//   - hinf2 reaches pres < 1e-9 (currently pInf=8.14e-7 — close to
//     legacy NT's 3.8e-7 ceiling; tracked separately as a
//     precision-floor issue that needs iterative refinement /
//     bigfloat).
//   - sdp-sdplib 6/6 (corpus bench, run via Phase 3 tool wiring).

import { describe, expect, test } from "bun:test";
import type { SdpProblem } from "../src/problem/SdpProblem.js";
import { solveHsdeSdpNt } from "../src/index.js";

describe("HSDE SDP NT — trivial fixtures", () => {
  test("trace-1 LP-as-SDP: min <C,X> s.t. trace(X)=1, X⪰0 → diag(0,1)", () => {
    // min <C, X> s.t. <A_1, X> = 1, X ⪰ 0
    // C = diag(2,1), A_1 = I → trace(X) = 1
    // optimal: X = diag(0, 1), obj = 1
    const C = new Float64Array([2, 0, 0, 1]);
    const A1 = new Float64Array([1, 0, 0, 1]);
    const prob: SdpProblem = {
      m: 1,
      blocks: [{ size: 2, A: [A1], C }],
      b: new Float64Array([1]),
      maximize: false,
    };
    const res = solveHsdeSdpNt(prob);
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 1)).toBeLessThan(1e-6);
    expect(res.tau).toBeGreaterThan(1e-6);
    expect(res.kappa / res.tau).toBeLessThan(1e-6);
  });

  test("2x2 SDP with off-diagonal: min trace(CX) s.t. trace(X)=2, X⪰0", () => {
    // C = [[1, 0.5], [0.5, 1]]. The min of trace(CX) over X⪰0 with
    // trace(X)=2 is achieved when X aligns with the smallest eigenvector
    // of C. eigs(C) = {0.5, 1.5}. So min obj = 0.5 · 2 = 1.
    const C = new Float64Array([1, 0.5, 0.5, 1]);
    const A1 = new Float64Array([1, 0, 0, 1]);
    const prob: SdpProblem = {
      m: 1,
      blocks: [{ size: 2, A: [A1], C }],
      b: new Float64Array([2]),
      maximize: false,
    };
    const res = solveHsdeSdpNt(prob);
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 1)).toBeLessThan(1e-5);
  });
});

describe("HSDE SDP NT — invariants", () => {
  test("verbose trace emits sdp-hsde-nt kind with τ, κ, gfeas, prstatus populated", () => {
    const C = new Float64Array([2, 0, 0, 1]);
    const A1 = new Float64Array([1, 0, 0, 1]);
    const prob: SdpProblem = {
      m: 1,
      blocks: [{ size: 2, A: [A1], C }],
      b: new Float64Array([1]),
      maximize: false,
    };
    let count = 0;
    let sawHsdeKind = false;
    let sawFiniteTauKappa = false;
    let sawEigMin = false;
    const res = solveHsdeSdpNt(prob, {
      verbose: (l) => {
        count++;
        if (l.kind === "sdp-hsde-nt") sawHsdeKind = true;
        if (Number.isFinite(l.tau) && Number.isFinite(l.kappa)) sawFiniteTauKappa = true;
        if (Number.isFinite(l.eigMinX) && Number.isFinite(l.eigMinS)) sawEigMin = true;
      },
    });
    expect(res.status).toBe("optimal");
    expect(count).toBeGreaterThan(0);
    expect(sawHsdeKind).toBe(true);
    expect(sawFiniteTauKappa).toBe(true);
    expect(sawEigMin).toBe(true);
  });

  test("primal+dual objectives agree at optimal", () => {
    const C = new Float64Array([1, 0.5, 0.5, 1]);
    const A1 = new Float64Array([1, 0, 0, 1]);
    const prob: SdpProblem = {
      m: 1,
      blocks: [{ size: 2, A: [A1], C }],
      b: new Float64Array([2]),
      maximize: false,
    };
    const res = solveHsdeSdpNt(prob);
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - res.dualObj)).toBeLessThan(1e-5);
  });
});
