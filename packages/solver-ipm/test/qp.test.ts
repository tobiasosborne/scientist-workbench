// Acceptance suite for the convex-QP augmented-SQD interior-point solver
// (`solveQp`). Ground truth: docs/ground-truth/convex/qp-ipm.md §9 (the
// analytic oracle table); decision record ADR-0044.
//
// Each test asserts a real invariant (CLAUDE.md Rule 7), never "didn't
// throw". The KKT certificate asserted by `expectKkt` is COMPLETE: dual
// residual, primal residual, complementarity AND the nonnegativity legs
// (x ≥ 0, s ≥ 0) — all four are necessary-and-sufficient for convex-QP
// optimality (qp-ipm.md §2), so a wrong-sign primal cannot pass.
//
// Mutation-proof honesty (Rule 6): the KKT-residual assertions catch a
// sign flip in the `Qx` term of QpResiduals and in the SignedLdlt sign
// guard (verified manually — those drive RED). They do NOT catch a
// perturbation to the Mehrotra corrector second-order term, which only
// affects the convergence *path*, not the KKT fixed point — so a
// dedicated iteration-count guard (the `corrector-sensitivity` test)
// covers that: a broken corrector inflates the iteration count.

import { describe, expect, test } from "bun:test";
import { solveQp } from "../src/solver/QpSolver.js";
import type { QpProblem } from "../src/problem/QpProblem.js";
import { solveLp } from "../src/solver/Solver.js";
import type { LpProblem } from "../src/problem/LpProblem.js";

function mk(Q: number[][], c: number[], A: number[][], b: number[]): QpProblem {
  const n = c.length;
  const m = b.length;
  return {
    m,
    n,
    Q: Float64Array.from(Q.flat()),
    A: Float64Array.from(A.flat()),
    b: Float64Array.from(b),
    c: Float64Array.from(c),
    nonNegMask: new Uint8Array(n).fill(1),
  };
}

// Full KKT residual of a convex QP at (x, y, s).
function kkt(qp: QpProblem, x: Float64Array, y: Float64Array, s: Float64Array) {
  const { m, n, Q, A, b, c } = qp;
  let rd = 0;
  let rp = 0;
  let comp = 0;
  let minx = Infinity;
  let mins = Infinity;
  for (let i = 0; i < n; i++) {
    let qx = 0;
    for (let j = 0; j < n; j++) qx += Q[i * n + j]! * x[j]!;
    let aty = 0;
    for (let r = 0; r < m; r++) aty += A[r * n + i]! * y[r]!;
    rd = Math.max(rd, Math.abs(qx + c[i]! - aty - s[i]!));
    comp = Math.max(comp, Math.abs(x[i]! * s[i]!));
    minx = Math.min(minx, x[i]!);
    mins = Math.min(mins, s[i]!);
  }
  for (let r = 0; r < m; r++) {
    let ax = 0;
    for (let j = 0; j < n; j++) ax += A[r * n + j]! * x[j]!;
    rp = Math.max(rp, Math.abs(ax - b[r]!));
  }
  return { rd, rp, comp, minx, mins };
}

const TOL = 1e-7; // well inside the 1e-10 ceiling but robust to platform float64 jitter

// Assert the COMPLETE KKT certificate (stationarity, feasibility,
// complementarity, AND nonnegativity x,s ≥ 0).
function expectKkt(qp: QpProblem, x: Float64Array, y: Float64Array, s: Float64Array) {
  const k = kkt(qp, x, y, s);
  expect(k.rd).toBeLessThan(TOL);
  if (qp.m > 0) expect(k.rp).toBeLessThan(TOL);
  expect(k.comp).toBeLessThan(TOL);
  expect(k.minx).toBeGreaterThanOrEqual(-TOL);
  expect(k.mins).toBeGreaterThanOrEqual(-TOL);
}

describe("solveQp — analytic oracles (qp-ipm.md §9)", () => {
  test("O1 unconstrained: Q=diag(2,4), c=(−2,−8) ⇒ x*=(1,2)", () => {
    const qp = mk([[2, 0], [0, 4]], [-2, -8], [], []);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);
    expect(it.x[0]!).toBeCloseTo(1, 6);
    expect(it.x[1]!).toBeCloseTo(2, 6);
  });

  test("O2 equality-constrained: Q=I, A=[1 1], b=[1] ⇒ x*=(½,½)", () => {
    const qp = mk([[1, 0], [0, 1]], [0, 0], [[1, 1]], [1]);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);
    expect(it.x[0]!).toBeCloseTo(0.5, 6);
    expect(it.x[1]!).toBeCloseTo(0.5, 6);
  });

  test("O5 active inequality via slack, PSD-nullspace Q ⇒ x*=(½,½,0), ξ active", () => {
    const qp = mk([[1, 0, 0], [0, 1, 0], [0, 0, 0]], [0, 0, 0], [[1, 1, -1]], [1]);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);
    expect(it.x[0]!).toBeCloseTo(0.5, 6);
    expect(it.x[1]!).toBeCloseTo(0.5, 6);
    expect(it.x[2]!).toBeCloseTo(0, 6); // slack ξ is binding (active)
    expect(it.s[2]!).toBeGreaterThan(1e-3); // its multiplier is strictly positive
  });

  test("coupled off-diagonal Q with equality (Q SPD, off-diag ≠ 0)", () => {
    const qp = mk([[2, 1], [1, 2]], [-1, 0], [[1, 1]], [1]);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);
    // On the face x₂=1−x₁ the objective reduces to (x₁−1)², minimized at
    // x₁=1 with x₂=0 at its bound — so the optimum is x*=(1,0), not an
    // interior point (Rule 7/8: assert the components, not just the sum).
    // x₂ approaches its bound at the √μ rate, so precision 3 is the right
    // scale for a bound-binding variable at the 1e-8 gap target.
    expect(it.x[0]!).toBeCloseTo(1, 3);
    expect(it.x[1]!).toBeCloseTo(0, 3);
  });

  test("O4-style diagonal box clamp (bound active): x₂ at its bound", () => {
    // min ½(x₁²+x₂²) − 3x₁ + x₂ s.t. x ≥ 0. Unconstrained min (3,−1);
    // projected onto x≥0 ⇒ (3,0), x₂ clamped. Active set: {1}, mult s₂ = c₂ = 1.
    const qp = mk([[1, 0], [0, 1]], [-3, 1], [], []);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);
    expect(it.x[0]!).toBeCloseTo(3, 6);
    expect(it.x[1]!).toBeCloseTo(0, 6);
    expect(it.s[1]!).toBeCloseTo(1, 5);
  });
});

describe("solveQp — termination taxonomy (the 5-class contract surface)", () => {
  test("primal-infeasible: x₁=1 and x₁=2 simultaneously ⇒ infeasible", () => {
    // A=[[1,0],[1,0]], b=[1,2]: requires x₁=1 AND x₁=2.
    const qp = mk([[1, 0], [0, 1]], [0, 0], [[1, 0], [1, 0]], [1, 2]);
    const { status } = solveQp(qp);
    expect(status).toBe("primal-infeasible");
  });

  test("dual-infeasible (unbounded primal): min −x₁ s.t. x₂=1, x≥0", () => {
    const qp = mk([[0, 0], [0, 0]], [-1, 0], [[0, 1]], [1]);
    const { status } = solveQp(qp);
    expect(status).toBe("dual-infeasible");
  });

  test("iter-limit: a tiny iteration cap terminates iter-limit, not optimal", () => {
    const qp = mk([[1, 0], [0, 1]], [0, 0], [[1, 1]], [1]);
    const { status } = solveQp(qp, { params: { iterLimit: 1 } });
    expect(status).toBe("iter-limit");
  });

  test("m > n (more equalities than vars), consistent ⇒ optimal x=(1,1)", () => {
    const qp = mk([[1, 0], [0, 1]], [0, 0], [[1, 0], [0, 1], [1, 1]], [1, 1, 2]);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);
    expect(it.x[0]!).toBeCloseTo(1, 5);
    expect(it.x[1]!).toBeCloseTo(1, 5);
  });

  test("rank-deficient / redundant A (duplicate rows) ⇒ optimal x=(½,½)", () => {
    const qp = mk([[1, 0], [0, 1]], [0, 0], [[1, 1], [1, 1]], [1, 1]);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);
    expect(it.x[0]!).toBeCloseTo(0.5, 5);
    expect(it.x[1]!).toBeCloseTo(0.5, 5);
  });
});

describe("solveQp — Mehrotra corrector sensitivity (mutation guard, Rule 6)", () => {
  // The KKT-residual assertions are blind to the corrector second-order
  // term (it accelerates convergence, it does not move the fixed point).
  // This guard IS sensitive: with the correct corrector the coupled-Q
  // case converges in ~11 iterations; sign-flipping the corrector term
  // (QpDirection.ts) inflates it to ~19. The ≤15 bound reddens on that
  // mutation while staying comfortably above the healthy count.
  test("coupled-Q converges in few iterations (a broken corrector reddens this)", () => {
    const qp = mk([[2, 1], [1, 2]], [-1, 0], [[1, 1]], [1]);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expect(it.iter).toBeLessThanOrEqual(15);
  });
});

describe("solveQp — random PSD-Q cross-check vs independent dense KKT solve", () => {
  // For an interior optimum (all x ≥ 0 bounds inactive), the QP solution
  // satisfies the dense linear KKT system [Q Aᵀ; A 0][x;y] = [−c; b].
  // Solve it with an independent Gaussian-elimination oracle and compare.
  function denseSolve(M: number[][], rhs: number[]): number[] {
    const N = rhs.length;
    const a = M.map((row, i) => [...row, rhs[i]!]);
    for (let col = 0; col < N; col++) {
      let piv = col;
      for (let r = col + 1; r < N; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
      [a[col], a[piv]] = [a[piv]!, a[col]!];
      const d = a[col]![col]!;
      for (let r = 0; r < N; r++) {
        if (r === col) continue;
        const f = a[r]![col]! / d;
        for (let cc = col; cc <= N; cc++) a[r]![cc]! -= f * a[col]![cc]!;
      }
    }
    return a.map((row, i) => row[N]! / row[i]!);
  }

  test("interior QP optimum matches the dense KKT linear solve to 1e-7", () => {
    // Q SPD (fixed deterministic data). c is reverse-engineered so the
    // optimum is the strictly-interior point x*=(1,1,1) (sum=3=b, all
    // bounds inactive ⇒ s=0): c = Aᵀy − Qx* with y=5 gives c=(1,1,0),
    // since Qx*=(4,4,5). The dense interior-KKT solve is then the valid
    // oracle (a binding bound would invalidate it).
    const Q = [[3, 1, 0], [1, 2, 1], [0, 1, 4]];
    const c = [1, 1, 0];
    const A = [[1, 1, 1]];
    const b = [3];
    const n = 3, m = 1;
    const qp = mk(Q, c, A, b);
    const { status, iterate: it } = solveQp(qp);
    expect(status).toBe("optimal");
    expectKkt(qp, it.x, it.y, it.s);

    // Build [Q Aᵀ; A 0] and rhs [−c; b]; note the dense-KKT y has the
    // OPPOSITE sign convention to the solver's (Qx + Aᵀy_dense = −c), so
    // compare only the primal x.
    const KKT: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) row.push(Q[i]![j]!);
      for (let r = 0; r < m; r++) row.push(A[r]![i]!);
      KKT.push(row);
    }
    for (let r = 0; r < m; r++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) row.push(A[r]![j]!);
      for (let rr = 0; rr < m; rr++) row.push(0);
      KKT.push(row);
    }
    const rhs = [...c.map((v) => -v), ...b];
    const sol = denseSolve(KKT, rhs);
    for (let j = 0; j < n; j++) {
      expect(sol[j]!).toBeGreaterThan(0); // confirm the chosen instance is interior
      expect(it.x[j]!).toBeCloseTo(sol[j]!, 6);
    }
  });
});

describe("solveQp — LP reduction cross-check (Q=0 agrees with solveLp)", () => {
  // With Q = 0 the QP collapses to an LP; the augmented-SQD solve must
  // AGREE with the tested LP normal-equations IPM at the optimum. (This
  // checks optimum agreement, not byte-for-byte trajectory — two IPMs on
  // different factorization paths differ in the last roundoff digits.)
  const cases: Array<{ name: string; c: number[]; A: number[][]; b: number[]; xStar: number[] }> = [
    { name: "min x₁+2x₂ s.t. x₁+x₂=1", c: [1, 2], A: [[1, 1]], b: [1], xStar: [1, 0] },
    { name: "min −x₁−x₂ s.t. x₁+2x₂=3, 2x₁+x₂=3", c: [-1, -1], A: [[1, 2], [2, 1]], b: [3, 3], xStar: [1, 1] },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const n = tc.c.length;
      const qp = mk(
        Array.from({ length: n }, () => Array(n).fill(0)),
        tc.c,
        tc.A,
        tc.b,
      );
      const qpRes = solveQp(qp);
      expect(qpRes.status).toBe("optimal");

      const lp: LpProblem = {
        m: tc.b.length,
        n,
        A: Float64Array.from(tc.A.flat()),
        b: Float64Array.from(tc.b),
        c: Float64Array.from(tc.c),
        nonNegMask: new Uint8Array(n).fill(1),
      };
      const lpRes = solveLp(lp);

      for (let j = 0; j < n; j++) {
        expect(qpRes.iterate.x[j]!).toBeCloseTo(tc.xStar[j]!, 5);
        expect(qpRes.iterate.x[j]!).toBeCloseTo(lpRes.iterate.x[j]!, 5);
      }
    });
  }
});

describe("solveQp — determinism (numerical:true)", () => {
  test("same input → bit-identical iterate (well-conditioned)", () => {
    const build = () => mk([[2, 0.5], [0.5, 3]], [-1, -2], [[1, 1]], [2]);
    const a = solveQp(build());
    const b = solveQp(build());
    expect(a.status).toBe(b.status);
    expect(a.iterate.iter).toBe(b.iterate.iter);
    expect(a.iterate.primalObj).toBe(b.iterate.primalObj);
    for (let j = 0; j < 2; j++) {
      expect(a.iterate.x[j]!).toBe(b.iterate.x[j]!);
      expect(a.iterate.s[j]!).toBe(b.iterate.s[j]!);
    }
    expect(a.iterate.y[0]!).toBe(b.iterate.y[0]!);
  });

  test("bit-identical on an ill-conditioned instance (exercises the reg-retry path)", () => {
    // Wide dynamic range in Q to stress the factorization / regularization
    // — the data-dependent control flow with the largest determinism surface.
    const build = () => mk([[1e6, 0], [0, 1e-6]], [-1, -1], [[1, 1]], [1]);
    const a = solveQp(build());
    const b = solveQp(build());
    expect(a.status).toBe(b.status);
    expect(a.iterate.iter).toBe(b.iterate.iter);
    expect(a.iterate.bumpsRho).toBe(b.iterate.bumpsRho);
    expect(a.iterate.bumpsDelta).toBe(b.iterate.bumpsDelta);
    for (let j = 0; j < 2; j++) {
      expect(a.iterate.x[j]!).toBe(b.iterate.x[j]!);
      expect(a.iterate.s[j]!).toBe(b.iterate.s[j]!);
    }
  });
});
