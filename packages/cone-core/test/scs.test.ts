// SCS-iteration integration tests — `scsSolve` end to end.
//
// Each test pins a *known* fact about the problem: an LP whose optimum
// is computed by hand, an infeasible LP, an unbounded LP, the
// iteration-cap branch, the determinism contract, and the option /
// cone-scope guards. The headline integration invariant is the KKT
// re-derivation: an `optimal` result's (x, y, s) is fed back through the
// problem data and the primal / dual / gap residuals must come out small
// — the solver is not trusted to self-report; the residuals are
// recomputed independently here.

import { describe, expect, test } from "bun:test";
import { matrixFromRows } from "@workbench/linalg-core";
import {
  type Cone,
  type ConeProblem,
  type SCSResult,
  ConeError,
  DEFAULT_SCS_OPTS,
  inCone,
  nonNeg,
  psd,
  scsSolve,
  soc,
  zero,
} from "../src/index.js";

// Independent KKT residual re-derivation — never trusts the solver's
// self-report (CLAUDE.md Rule 7 + worklog 089 "status is honest").
function kktResiduals(
  problem: ConeProblem,
  x: Float64Array,
  y: Float64Array,
  s: Float64Array,
): { primal: number; dual: number; gap: number } {
  const { A, b, c } = problem;
  const m = A.rows;
  const n = A.cols;
  // p = A x + s − b
  let primal = 0;
  for (let i = 0; i < m; i++) {
    let axi = 0;
    for (let j = 0; j < n; j++) axi += A.data[i * n + j]! * x[j]!;
    const pi = axi + s[i]! - b[i]!;
    primal += pi * pi;
  }
  // d = Aᵀ y + c
  let dual = 0;
  for (let j = 0; j < n; j++) {
    let atyj = 0;
    for (let i = 0; i < m; i++) atyj += A.data[i * n + j]! * y[i]!;
    const dj = atyj + c[j]!;
    dual += dj * dj;
  }
  // g = cᵀx + bᵀy
  let cTx = 0;
  for (let j = 0; j < n; j++) cTx += c[j]! * x[j]!;
  let bTy = 0;
  for (let i = 0; i < m; i++) bTy += b[i]! * y[i]!;
  return { primal: Math.sqrt(primal), dual: Math.sqrt(dual), gap: cTx + bTy };
}

function expectOptimal(r: SCSResult): Extract<SCSResult, { status: "optimal" }> {
  expect(r.status).toBe("optimal");
  if (r.status !== "optimal") throw new Error("unreachable");
  return r;
}

// ── known-optimum LPs ───────────────────────────────────────────────────────

describe("scsSolve — LP with a known optimum", () => {
  test("min x s.t. x ≥ 1 → x = 1, objective = 1", () => {
    // −x + s = −1, s ≥ 0.
    const p: ConeProblem = {
      A: matrixFromRows([[-1]]),
      b: new Float64Array([-1]),
      c: new Float64Array([1]),
      cones: [nonNeg(1)],
    };
    const r = expectOptimal(scsSolve(p));
    expect(r.x[0]).toBeCloseTo(1, 5);
    expect(r.objective).toBeCloseTo(1, 5);
    // the condition estimate of the subspace system is a real number ≥ 1
    expect(Number.isFinite(r.conditionEstimate)).toBe(true);
    expect(r.conditionEstimate).toBeGreaterThanOrEqual(1);
    // independent KKT check — the solver's (x, y, s) really is a solution
    const res = kktResiduals(p, r.x, r.y, r.s);
    expect(res.primal).toBeLessThan(1e-5);
    expect(res.dual).toBeLessThan(1e-5);
    expect(Math.abs(res.gap)).toBeLessThan(1e-5);
  });

  test("min x + 2y s.t. x + y ≥ 3, x ≥ 0, y ≥ 0 → x = 3, y = 0, objective = 3", () => {
    const p: ConeProblem = {
      A: matrixFromRows([
        [-1, -1],
        [-1, 0],
        [0, -1],
      ]),
      b: new Float64Array([-3, 0, 0]),
      c: new Float64Array([1, 2]),
      cones: [nonNeg(3)],
    };
    const r = expectOptimal(scsSolve(p));
    expect(r.x[0]).toBeCloseTo(3, 4);
    expect(r.x[1]).toBeCloseTo(0, 4);
    expect(r.objective).toBeCloseTo(3, 4);
    const res = kktResiduals(p, r.x, r.y, r.s);
    expect(res.primal).toBeLessThan(1e-4);
    expect(res.dual).toBeLessThan(1e-4);
    expect(Math.abs(res.gap)).toBeLessThan(1e-4);
  });

  test("min x + y s.t. x ≥ 1, y ≥ 1 → x = y = 1, objective = 2", () => {
    const p: ConeProblem = {
      A: matrixFromRows([
        [-1, 0],
        [0, -1],
      ]),
      b: new Float64Array([-1, -1]),
      c: new Float64Array([1, 1]),
      cones: [nonNeg(2)],
    };
    const r = expectOptimal(scsSolve(p));
    expect(r.x[0]).toBeCloseTo(1, 5);
    expect(r.x[1]).toBeCloseTo(1, 5);
    expect(r.objective).toBeCloseTo(2, 5);
  });

  test("equality constraint via the zero cone: x = 5 → objective = 5", () => {
    // x + s = 5 with s ∈ {0} pins x = 5. Exercises the zero cone, and
    // hence dualCone(zero) = free in the embedding cone 𝒞.
    const p: ConeProblem = {
      A: matrixFromRows([[1]]),
      b: new Float64Array([5]),
      c: new Float64Array([1]),
      cones: [zero(1)],
    };
    const r = expectOptimal(scsSolve(p));
    expect(r.x[0]).toBeCloseTo(5, 5);
    expect(r.objective).toBeCloseTo(5, 5);
    const res = kktResiduals(p, r.x, r.y, r.s);
    expect(res.primal).toBeLessThan(1e-5);
  });
});

// ── infeasible and unbounded ────────────────────────────────────────────────

describe("scsSolve — infeasible / unbounded", () => {
  test("x ≥ 1 ∧ x ≤ 0 is infeasible — status `infeasible`, Farkas cert bᵀcert = −1", () => {
    const p: ConeProblem = {
      A: matrixFromRows([[-1], [1]]),
      b: new Float64Array([-1, 0]),
      c: new Float64Array([1]),
      cones: [nonNeg(2)],
    };
    const r = scsSolve(p);
    expect(r.status).toBe("infeasible");
    if (r.status !== "infeasible") throw new Error("unreachable");
    // bᵀcert = −1 by construction of the certificate
    let bTcert = 0;
    for (let i = 0; i < p.b.length; i++) bTcert += p.b[i]! * r.certificate[i]!;
    expect(bTcert).toBeCloseTo(-1, 5);
  });

  test("min −x s.t. x ≥ 0 is unbounded — status `unbounded`, ray cert cᵀcert = −1", () => {
    const p: ConeProblem = {
      A: matrixFromRows([[-1]]),
      b: new Float64Array([0]),
      c: new Float64Array([-1]),
      cones: [nonNeg(1)],
    };
    const r = scsSolve(p);
    expect(r.status).toBe("unbounded");
    if (r.status !== "unbounded") throw new Error("unreachable");
    let cTcert = 0;
    for (let j = 0; j < p.c.length; j++) cTcert += p.c[j]! * r.certificate[j]!;
    expect(cTcert).toBeCloseTo(-1, 5);
  });
});

// ── iteration cap ───────────────────────────────────────────────────────────

describe("scsSolve — iteration cap", () => {
  const p: ConeProblem = {
    A: matrixFromRows([[-1]]),
    b: new Float64Array([-1]),
    c: new Float64Array([1]),
    cones: [nonNeg(1)],
  };

  test("a mid-convergence maxIter stops at `iter-cap`, never an `optimal` lie", () => {
    // `andersonMemory: 0` pins this to the *plain* SCS trajectory, whose
    // convergence on this LP is ~47 iterations — 10 is well short of it,
    // but long enough that some iterate has u_τ > 0, so a best-effort
    // candidate exists with a finite (sub-target) honest precision.
    const r = scsSolve(p, { precision: 1e-8, maxIter: 10, alpha: 1.5, andersonMemory: 0 });
    expect(r.status).toBe("iter-cap");
    if (r.status !== "iter-cap") throw new Error("unreachable");
    expect(r.iterations).toBe(10);
    expect(r.x).toBeDefined();
    expect(Number.isFinite(r.achievedPrecision)).toBe(true);
    expect(r.achievedPrecision).toBeGreaterThan(1e-8);
  });

  test("an iter-cap before any u_τ > 0 reports achievedPrecision = +∞, not a false finite", () => {
    // After only 2 iterations no iterate has had u_τ > 0, so there is no
    // candidate to read off — the honest answer is "+∞ precision", never
    // a fabricated finite number. Plain SCS (`andersonMemory: 0`).
    const r = scsSolve(p, { precision: 1e-8, maxIter: 2, alpha: 1.5, andersonMemory: 0 });
    expect(r.status).toBe("iter-cap");
    if (r.status !== "iter-cap") throw new Error("unreachable");
    expect(r.iterations).toBe(2);
    expect(r.x).toBeUndefined();
    expect(r.achievedPrecision).toBe(Infinity);
  });
});

// ── the determinism contract (ADR-0030, numerical: true) ────────────────────

describe("scsSolve — determinism", () => {
  test("solving the same problem twice is bit-identical", () => {
    const make = (): ConeProblem => ({
      A: matrixFromRows([
        [-1, -1],
        [-1, 0],
        [0, -1],
      ]),
      b: new Float64Array([-3, 0, 0]),
      c: new Float64Array([1, 2]),
      cones: [nonNeg(3)],
    });
    const r1 = expectOptimal(scsSolve(make()));
    const r2 = expectOptimal(scsSolve(make()));
    expect(r1.iterations).toBe(r2.iterations);
    expect(r1.objective).toBe(r2.objective); // exact, not toBeCloseTo
    expect(r1.achievedPrecision).toBe(r2.achievedPrecision);
    expect(r1.conditionEstimate).toBe(r2.conditionEstimate);
    expect(Array.from(r1.x)).toEqual(Array.from(r2.x));
    expect(Array.from(r1.y)).toEqual(Array.from(r2.y));
    expect(Array.from(r1.s)).toEqual(Array.from(r2.s));
  });

  test("over-relaxation α = 1 (basic iteration) also converges", () => {
    const p: ConeProblem = {
      A: matrixFromRows([[-1]]),
      b: new Float64Array([-1]),
      c: new Float64Array([1]),
      cones: [nonNeg(1)],
    };
    // `andersonMemory: 0` isolates the basic (un-accelerated) iteration.
    const r = expectOptimal(
      scsSolve(p, { precision: 1e-8, maxIter: 5000, alpha: 1, andersonMemory: 0 }),
    );
    expect(r.x[0]).toBeCloseTo(1, 5);
  });
});

// ── option and cone-scope guards ────────────────────────────────────────────

describe("scsSolve — guards", () => {
  const p: ConeProblem = {
    A: matrixFromRows([[-1]]),
    b: new Float64Array([-1]),
    c: new Float64Array([1]),
    cones: [nonNeg(1)],
  };

  test("rejects a non-positive or non-finite precision", () => {
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, precision: 0 })).toThrow(ConeError);
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, precision: -1e-8 })).toThrow(ConeError);
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, precision: Number.NaN })).toThrow(ConeError);
  });
  test("rejects maxIter < 1 or non-integer", () => {
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, maxIter: 0 })).toThrow(ConeError);
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, maxIter: 10.5 })).toThrow(ConeError);
  });
  test("rejects alpha outside the open interval ]0, 2[", () => {
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, alpha: 0 })).toThrow(ConeError);
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, alpha: 2 })).toThrow(ConeError);
    expect(() => scsSolve(p, { ...DEFAULT_SCS_OPTS, alpha: 2.5 })).toThrow(ConeError);
  });

  test("rejects an unimplemented cone (exp / pow) at setup, naming the sub-bead", () => {
    // soc / psd are projectable now (bead 0wc7); exp / pow are still
    // deferred (bead j282), and `scsSolve` must refuse them *at setup*
    // rather than mid-iteration.
    for (const K of [{ kind: "exp" }, { kind: "pow", alpha: 0.5 }] as Cone[]) {
      const p: ConeProblem = {
        A: matrixFromRows([
          [-1, 0, 0],
          [0, -1, 0],
          [0, 0, -1],
        ]),
        b: new Float64Array([0, 0, 0]),
        c: new Float64Array([1, 0, 0]),
        cones: [K],
      };
      expect(() => scsSolve(p)).toThrow(/j282/);
    }
  });
});

// ── SOC / PSD: scsSolve end-to-end on the cones bead 0wc7 added ──────────────
//
// The SCS iteration is cone-agnostic by construction — `projectProduct`
// walks `projectCone` block by block — so once `cones.ts` projects soc /
// psd, `scsSolve` handles them with no further wiring. These tests prove
// that integration on problems with a hand-derived unique optimum. They
// are not a convergence *benchmark* (worklog 113 is explicit that plain
// SCS is not bench-competitive); they prove the projections compose
// correctly into the solver and that `status: "optimal"` stays honest —
// the §3.5 termination test still judges the *actual* residuals.

describe("scsSolve — SOC / PSD with a known optimum", () => {
  test("SOC: min x₀ s.t. (x₀+2, x₁) ∈ soc₂ → apex x = (−2, 0), objective = −2", () => {
    // A = −I₂, b = (2,0): s = b − Ax = (2 + x₀, x₁), constrained to the
    // second-order cone {(t, u) : t ≥ |u|}. Minimising x₀ drives the
    // slack to the cone apex — the unique optimum is x₀ = −2, x₁ = 0.
    const p: ConeProblem = {
      A: matrixFromRows([
        [-1, 0],
        [0, -1],
      ]),
      b: new Float64Array([2, 0]),
      c: new Float64Array([1, 0]),
      cones: [soc(2)],
    };
    const r = expectOptimal(scsSolve(p));
    expect(r.x[0]).toBeCloseTo(-2, 4);
    expect(r.x[1]).toBeCloseTo(0, 4);
    expect(r.objective).toBeCloseTo(-2, 4);
    // independent checks — KKT residuals small, and the slack genuinely
    // lands in the second-order cone (the solver never self-certifies)
    const res = kktResiduals(p, r.x, r.y, r.s);
    expect(res.primal).toBeLessThan(1e-4);
    expect(res.dual).toBeLessThan(1e-4);
    expect(Math.abs(res.gap)).toBeLessThan(1e-4);
    expect(inCone(r.s, soc(2), 1e-4)).toBe(true);
  });

  test("PSD: max tr(X) s.t. X ⪯ diag(2,3) → X = diag(2,3), objective = −5", () => {
    // svec coordinates (√2 off-diagonal). A = I₃, b = svec(diag(2,3)) =
    // (2,0,3): s = b − x is the svec of B − X, constrained PSD, so
    // X ⪯ B. c = svec(−I₂) = (−1,0,−1) makes cᵀx = −tr(X); minimising it
    // maximises tr(X), whose unique maximiser under X ⪯ B is X = B
    // (a PSD matrix of zero trace is zero). Optimum x = (2,0,3),
    // objective = −tr(B) = −5.
    const p: ConeProblem = {
      A: matrixFromRows([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
      b: new Float64Array([2, 0, 3]),
      c: new Float64Array([-1, 0, -1]),
      cones: [psd(2)],
    };
    const r = expectOptimal(scsSolve(p));
    expect(r.x[0]).toBeCloseTo(2, 3);
    expect(r.x[1]).toBeCloseTo(0, 3);
    expect(r.x[2]).toBeCloseTo(3, 3);
    expect(r.objective).toBeCloseTo(-5, 3);
    const res = kktResiduals(p, r.x, r.y, r.s);
    expect(res.primal).toBeLessThan(1e-3);
    expect(res.dual).toBeLessThan(1e-3);
    expect(Math.abs(res.gap)).toBeLessThan(1e-3);
    // the slack X recovered from s really is positive-semidefinite
    expect(inCone(r.s, psd(2), 1e-3)).toBe(true);
  });
});
