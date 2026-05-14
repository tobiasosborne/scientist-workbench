// Cone-primitive tests — `coneDim`, `projectCone`, `dualCone`, `inCone`.
//
// Every test asserts a mathematical invariant, not "didn't throw"
// (CLAUDE.md Rule 7). The headline invariants for a projection onto a
// closed convex cone are:
//
//   - idempotence:        Π_K(Π_K(z)) = Π_K(z)
//   - range:              Π_K(z) ∈ K
//   - non-expansiveness:   ‖Π_K(a) − Π_K(b)‖ ≤ ‖a − b‖
//   - Moreau decomposition: z = Π_K(z) − Π_{K*}(−z), and the two
//                           summands are orthogonal — the single most
//                           load-bearing identity SCS relies on.
//
// For the self-dual nonnegative orthant the Moreau identity reads
// `z = max(0,z) − max(0,−z)` with `max(0,z) · max(0,−z) = 0`.

import { describe, expect, test } from "bun:test";
import {
  type Cone,
  ConeError,
  coneDim,
  dualCone,
  free,
  inCone,
  nonNeg,
  projectCone,
  zero,
} from "../src/index.js";

const arr = (v: Float64Array): number[] => Array.from(v);
const dot = (a: Float64Array, b: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
const norm2 = (a: Float64Array): number => Math.sqrt(dot(a, a));

// ── coneDim ─────────────────────────────────────────────────────────────────

describe("coneDim", () => {
  test("nonneg / zero / free / soc report their `dim`", () => {
    expect(coneDim(nonNeg(5))).toBe(5);
    expect(coneDim(zero(3))).toBe(3);
    expect(coneDim(free(7))).toBe(7);
    expect(coneDim({ kind: "soc", dim: 4 })).toBe(4);
  });
  test("psd reports the triangular-vectorisation length side·(side+1)/2", () => {
    expect(coneDim({ kind: "psd", side: 1 })).toBe(1);
    expect(coneDim({ kind: "psd", side: 2 })).toBe(3);
    expect(coneDim({ kind: "psd", side: 3 })).toBe(6);
    expect(coneDim({ kind: "psd", side: 4 })).toBe(10);
  });
  test("exp / pow are fixed dimension 3", () => {
    expect(coneDim({ kind: "exp" })).toBe(3);
    expect(coneDim({ kind: "pow", alpha: 0.3 })).toBe(3);
  });
});

// ── constructors ────────────────────────────────────────────────────────────

describe("smart constructors", () => {
  test("build the tagged spec", () => {
    expect(nonNeg(3)).toEqual({ kind: "nonneg", dim: 3 });
    expect(zero(2)).toEqual({ kind: "zero", dim: 2 });
    expect(free(4)).toEqual({ kind: "free", dim: 4 });
  });
  test("reject negative or non-integer dimensions", () => {
    expect(() => nonNeg(-1)).toThrow(ConeError);
    expect(() => zero(2.5)).toThrow(ConeError);
    expect(() => free(Number.NaN)).toThrow(ConeError);
  });
});

// ── projectCone — nonnegative orthant ───────────────────────────────────────

describe("projectCone — nonneg", () => {
  const K = nonNeg(4);

  test("clamps negatives to zero, keeps positives", () => {
    const z = new Float64Array([-2, 3, 0, -0.5]);
    expect(arr(projectCone(z, K))).toEqual([0, 3, 0, 0]);
  });

  test("does not mutate its input", () => {
    const z = new Float64Array([-1, 2, -3, 4]);
    projectCone(z, K);
    expect(arr(z)).toEqual([-1, 2, -3, 4]);
  });

  test("idempotence: Π(Π(z)) = Π(z)", () => {
    const z = new Float64Array([-7, 1.5, -0.1, 9]);
    const p = projectCone(z, K);
    expect(arr(projectCone(p, K))).toEqual(arr(p));
  });

  test("range: Π(z) ∈ K", () => {
    const z = new Float64Array([-7, 1.5, -0.1, 9]);
    expect(inCone(projectCone(z, K), K, 0)).toBe(true);
  });

  test("Moreau decomposition: z = Π_+(z) − Π_+(−z), the parts orthogonal", () => {
    const z = new Float64Array([-7, 1.5, -0.1, 9]);
    const pos = projectCone(z, K);
    const negZ = new Float64Array(z.length);
    for (let i = 0; i < z.length; i++) negZ[i] = -z[i]!;
    const neg = projectCone(negZ, K);
    // reconstruction
    for (let i = 0; i < z.length; i++) {
      expect(pos[i]! - neg[i]!).toBeCloseTo(z[i]!, 12);
    }
    // orthogonality of the two summands
    expect(dot(pos, neg)).toBeCloseTo(0, 12);
  });

  test("non-expansiveness: ‖Π(a) − Π(b)‖ ≤ ‖a − b‖", () => {
    const a = new Float64Array([3, -2, 5, -1]);
    const b = new Float64Array([-4, 1, -6, 8]);
    const pa = projectCone(a, K);
    const pb = projectCone(b, K);
    const dProj = new Float64Array(4);
    const dRaw = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      dProj[i] = pa[i]! - pb[i]!;
      dRaw[i] = a[i]! - b[i]!;
    }
    expect(norm2(dProj)).toBeLessThanOrEqual(norm2(dRaw) + 1e-12);
  });
});

// ── projectCone — zero and free ─────────────────────────────────────────────

describe("projectCone — zero", () => {
  test("projects everything to the origin", () => {
    expect(arr(projectCone(new Float64Array([1, -2, 3]), zero(3)))).toEqual([0, 0, 0]);
  });
  test("the result is in the cone", () => {
    expect(inCone(projectCone(new Float64Array([9, 9]), zero(2)), zero(2), 0)).toBe(true);
  });
});

describe("projectCone — free", () => {
  test("is the identity", () => {
    const z = new Float64Array([1, -2, 3.5]);
    expect(arr(projectCone(z, free(3)))).toEqual([1, -2, 3.5]);
  });
  test("returns a fresh array (no aliasing of the input)", () => {
    const z = new Float64Array([1, 2]);
    const p = projectCone(z, free(2));
    expect(p).not.toBe(z);
    p[0] = 99;
    expect(z[0]).toBe(1);
  });
  test("idempotence holds trivially", () => {
    const z = new Float64Array([4, -5]);
    expect(arr(projectCone(projectCone(z, free(2)), free(2)))).toEqual([4, -5]);
  });
});

// ── projectCone — dimension and scope guards ────────────────────────────────

describe("projectCone — guards", () => {
  test("rejects a length / dimension mismatch", () => {
    expect(() => projectCone(new Float64Array([1, 2]), nonNeg(3))).toThrow(ConeError);
  });

  test("soc / psd throw, naming sub-bead 0wc7", () => {
    for (const K of [{ kind: "soc", dim: 3 }, { kind: "psd", side: 2 }] as Cone[]) {
      try {
        projectCone(new Float64Array(coneDim(K)), K);
        throw new Error("expected ConeError");
      } catch (e) {
        expect(e).toBeInstanceOf(ConeError);
        expect((e as ConeError).message).toContain("0wc7");
      }
    }
  });

  test("exp / pow throw, naming sub-bead j282", () => {
    for (const K of [{ kind: "exp" }, { kind: "pow", alpha: 0.5 }] as Cone[]) {
      try {
        projectCone(new Float64Array(3), K);
        throw new Error("expected ConeError");
      } catch (e) {
        expect(e).toBeInstanceOf(ConeError);
        expect((e as ConeError).message).toContain("j282");
      }
    }
  });
});

// ── dualCone ────────────────────────────────────────────────────────────────

describe("dualCone", () => {
  test("nonneg / soc / psd are self-dual", () => {
    expect(dualCone(nonNeg(3))).toEqual(nonNeg(3));
    const soc: Cone = { kind: "soc", dim: 4 };
    expect(dualCone(soc)).toEqual(soc);
    const psd: Cone = { kind: "psd", side: 3 };
    expect(dualCone(psd)).toEqual(psd);
  });
  test("zero and free are duals of each other", () => {
    expect(dualCone(zero(5))).toEqual(free(5));
    expect(dualCone(free(5))).toEqual(zero(5));
    // involution
    expect(dualCone(dualCone(zero(5)))).toEqual(zero(5));
  });
  test("exp / pow throw — their dual has no v0.1 representation", () => {
    expect(() => dualCone({ kind: "exp" })).toThrow(ConeError);
    expect(() => dualCone({ kind: "pow", alpha: 0.4 })).toThrow(ConeError);
  });
});

// ── inCone ──────────────────────────────────────────────────────────────────

describe("inCone", () => {
  test("nonneg: membership is `every zᵢ ≥ −tol`", () => {
    expect(inCone(new Float64Array([0, 1, 2]), nonNeg(3), 0)).toBe(true);
    expect(inCone(new Float64Array([0, -1, 2]), nonNeg(3), 0)).toBe(false);
    // tolerance gating: a small negative is admitted within tol
    expect(inCone(new Float64Array([-1e-9]), nonNeg(1), 1e-8)).toBe(true);
    expect(inCone(new Float64Array([-1e-7]), nonNeg(1), 1e-8)).toBe(false);
  });
  test("zero: membership is `every |zᵢ| ≤ tol`", () => {
    expect(inCone(new Float64Array([0, 0]), zero(2), 0)).toBe(true);
    expect(inCone(new Float64Array([1e-9, -1e-9]), zero(2), 1e-8)).toBe(true);
    expect(inCone(new Float64Array([1e-7, 0]), zero(2), 1e-8)).toBe(false);
  });
  test("free: every finite vector is a member; NaN / Infinity are not", () => {
    expect(inCone(new Float64Array([1e300, -1e-300, 0]), free(3), 0)).toBe(true);
    expect(inCone(new Float64Array([Number.NaN]), free(1), 0)).toBe(false);
    expect(inCone(new Float64Array([Number.POSITIVE_INFINITY]), free(1), 0)).toBe(false);
  });
  test("NaN is never in the nonneg or zero cone (the `!(…)` gate rejects it)", () => {
    expect(inCone(new Float64Array([Number.NaN]), nonNeg(1), 1)).toBe(false);
    expect(inCone(new Float64Array([Number.NaN]), zero(1), 1)).toBe(false);
  });
  test("rejects a negative or non-finite tolerance", () => {
    expect(() => inCone(new Float64Array([1]), nonNeg(1), -1)).toThrow(ConeError);
    expect(() => inCone(new Float64Array([1]), nonNeg(1), Number.NaN)).toThrow(ConeError);
  });
  test("rejects a length / dimension mismatch", () => {
    expect(() => inCone(new Float64Array([1, 2]), nonNeg(3), 0)).toThrow(ConeError);
  });
  test("soc / psd / exp / pow throw with their sub-bead pointers", () => {
    expect(() => inCone(new Float64Array(3), { kind: "soc", dim: 3 }, 0)).toThrow(/0wc7/);
    expect(() => inCone(new Float64Array(3), { kind: "exp" }, 0)).toThrow(/j282/);
  });
});
