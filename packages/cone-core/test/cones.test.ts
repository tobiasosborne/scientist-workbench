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
  psd,
  soc,
  zero,
} from "../src/index.js";

const arr = (v: Float64Array): number[] => Array.from(v);
const dot = (a: Float64Array, b: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
const norm2 = (a: Float64Array): number => Math.sqrt(dot(a, a));
const neg = (a: Float64Array): Float64Array => a.map((x) => -x);
const SQRT2 = Math.SQRT2;

// Build the √2-scaled upper-triangular `svec` of a symmetric matrix given
// as nested rows — the test-side mirror of `cones.ts`'s internal `svec`,
// kept here so the projection tests can state inputs and expected outputs
// as honest matrices, not as opaque vectors. Off-diagonal entries carry
// the √2 factor (ADR-0030 OQ4); the diagonal is verbatim.
const svec = (m: readonly (readonly number[])[]): Float64Array => {
  const n = m.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      out.push(i === j ? m[i]![j]! : SQRT2 * m[i]![j]!);
    }
  }
  return new Float64Array(out);
};

// The headline invariant battery for a Euclidean projection onto a closed
// convex cone — asserted once here and reused by every self-dual cone
// (nonneg, soc, psd). For self-dual `K`, the Moreau decomposition reads
// `z = Π_K(z) − Π_K(−z)` with the two summands orthogonal (Parikh-Boyd
// §6.3, p. 183 — see docs/ground-truth/convex/cone-projections.md §1).
const assertProjectionInvariants = (K: Cone, samples: readonly Float64Array[]): void => {
  for (const z of samples) {
    const p = projectCone(z, K);
    // idempotence: Π(Π(z)) = Π(z). Closeness, not bit-equality — the psd
    // path runs through the iterative `eigh`, and soc's case-3 boundary
    // value is one rounding away from re-triggering case 3.
    const pp = projectCone(p, K);
    for (let i = 0; i < p.length; i++) expect(pp[i]!).toBeCloseTo(p[i]!, 9);
    // range: Π(z) ∈ K (exact membership — the projection lands *in* K)
    expect(inCone(p, K, 1e-9)).toBe(true);
    // Moreau decomposition: z = Π_K(z) − Π_K(−z), summands orthogonal
    const pNeg = projectCone(neg(z), K);
    for (let i = 0; i < z.length; i++) {
      expect(p[i]! - pNeg[i]!).toBeCloseTo(z[i]!, 9);
    }
    expect(dot(p, pNeg)).toBeCloseTo(0, 9);
  }
  // non-expansiveness: ‖Π(a) − Π(b)‖ ≤ ‖a − b‖ over every sample pair
  for (const a of samples) {
    for (const b of samples) {
      const d = projectCone(a, K).map((x, i) => x - projectCone(b, K)[i]!);
      const raw = a.map((x, i) => x - b[i]!);
      expect(norm2(d)).toBeLessThanOrEqual(norm2(raw) + 1e-9);
    }
  }
};

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
    expect(soc(4)).toEqual({ kind: "soc", dim: 4 });
    expect(psd(3)).toEqual({ kind: "psd", side: 3 });
  });
  test("reject negative or non-integer dimensions", () => {
    expect(() => nonNeg(-1)).toThrow(ConeError);
    expect(() => zero(2.5)).toThrow(ConeError);
    expect(() => free(Number.NaN)).toThrow(ConeError);
    expect(() => soc(-1)).toThrow(ConeError);
    expect(() => psd(1.5)).toThrow(ConeError);
  });
  test("soc / psd reject dimension 0 — a soc needs its scalar apex, a psd a 1×1 block", () => {
    expect(() => soc(0)).toThrow(ConeError);
    expect(() => psd(0)).toThrow(ConeError);
    // soc(1) and psd(1) are the degenerate-but-valid floor (the
    // nonnegative half-line) and must construct.
    expect(soc(1)).toEqual({ kind: "soc", dim: 1 });
    expect(psd(1)).toEqual({ kind: "psd", side: 1 });
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

// ── projectCone — second-order (Lorentz) cone ───────────────────────────────
//
// Parikh-Boyd §6.3.2. cone-core's ordering is scalar-first: z = (t, x),
// in the cone iff t ≥ ‖x‖₂. Three branches: already-in (identity),
// polar-to-apex (→ 0), and the genuine boundary projection.

describe("projectCone — soc", () => {
  const K = soc(3);

  test("case 1 — a point already in the cone is its own projection", () => {
    // (5, 3, 0): t = 5 ≥ ‖(3,0)‖ = 3 → identity.
    expect(arr(projectCone(new Float64Array([5, 3, 0]), K))).toEqual([5, 3, 0]);
  });

  test("case 2 — a point in the polar cone projects to the apex", () => {
    // (−5, 3, 4): ρ = 5 ≤ −t = 5 → the origin.
    expect(arr(projectCone(new Float64Array([-5, 3, 4]), K))).toEqual([0, 0, 0]);
  });

  test("case 3 — boundary projection lands exactly on t = ‖x‖₂", () => {
    // (1, 3, 4): ρ = 5, scale = (5+1)/(2·5) = 0.6 → (3, 1.8, 2.4).
    const p = projectCone(new Float64Array([1, 3, 4]), K);
    expect(p[0]).toBeCloseTo(3, 12);
    expect(p[1]).toBeCloseTo(1.8, 12);
    expect(p[2]).toBeCloseTo(2.4, 12);
    // the result sits on the cone boundary: t = ‖x‖₂
    expect(p[0]!).toBeCloseTo(Math.hypot(p[1]!, p[2]!), 12);
  });

  test("does not mutate its input", () => {
    const z = new Float64Array([1, 3, 4]);
    projectCone(z, K);
    expect(arr(z)).toEqual([1, 3, 4]);
  });

  test("dim-1 soc degenerates to the nonnegative half-line", () => {
    expect(arr(projectCone(new Float64Array([3]), soc(1)))).toEqual([3]);
    expect(arr(projectCone(new Float64Array([-2]), soc(1)))).toEqual([0]);
  });

  test("projection invariants — idempotence, range, Moreau, non-expansiveness", () => {
    assertProjectionInvariants(K, [
      new Float64Array([5, 3, 0]), // in-cone
      new Float64Array([-5, 3, 4]), // polar
      new Float64Array([1, 3, 4]), // boundary
      new Float64Array([0, 3, 4]), // boundary, t = 0
      new Float64Array([2, -1, 0.5]),
      new Float64Array([-0.3, 4, -2]),
    ]);
    assertProjectionInvariants(soc(1), [
      new Float64Array([3]),
      new Float64Array([-2]),
      new Float64Array([0]),
    ]);
  });
});

// ── projectCone — positive-semidefinite cone ────────────────────────────────
//
// Parikh-Boyd §6.3.3 eq (6.6): Π(V) = Σ (λᵢ)₊ uᵢuᵢᵀ. The block is the
// √2-scaled upper-triangular svec; the √2 makes svec a Frobenius isometry,
// so the coordinate-wise Euclidean projection equals svec of the matrix
// projection. The exact-value and Moreau-orthogonality tests below are the
// ones that catch a wrong (or absent) √2 scaling — ADR-0030 OQ4.

describe("projectCone — psd", () => {
  const K = psd(2);

  test("an already-PSD matrix is its own projection", () => {
    // diag(2, 3) ⪰ 0 → identity.
    const z = svec([
      [2, 0],
      [0, 3],
    ]);
    expect(arr(projectCone(z, K))).toEqual(arr(z));
  });

  test("a negative-definite matrix projects to the zero matrix", () => {
    const z = svec([
      [-1, 0],
      [0, -2],
    ]);
    expect(arr(projectCone(z, K))).toEqual([0, 0, 0]);
  });

  test("an indefinite diagonal matrix drops its negative eigenvalue", () => {
    // diag(1, −1) → diag(1, 0).
    const z = svec([
      [1, 0],
      [0, -1],
    ]);
    expect(arr(projectCone(z, K))).toEqual(
      arr(
        svec([
          [1, 0],
          [0, 0],
        ]),
      ),
    );
  });

  test("off-diagonal case — the √2 scaling carries the projection exactly", () => {
    // V = [[0,1],[1,0]] has eigenvalues ±1; clamping keeps the +1 mode
    // with eigenvector (1,1)/√2, giving Π(V) = [[½,½],[½,½]].
    // This input distinguishes the correct √2-svec from plain stacking:
    // with no scaling the recovered matrix and its projection both differ.
    const z = svec([
      [0, 1],
      [1, 0],
    ]);
    const expected = svec([
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    const p = projectCone(z, K);
    for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(expected[i]!, 12);
  });

  test("does not mutate its input", () => {
    const z = svec([
      [1, 2],
      [2, -3],
    ]);
    const before = arr(z);
    projectCone(z, K);
    expect(arr(z)).toEqual(before);
  });

  test("side-1 psd degenerates to the nonnegative half-line", () => {
    expect(arr(projectCone(new Float64Array([4]), psd(1)))).toEqual([4]);
    expect(arr(projectCone(new Float64Array([-4]), psd(1)))).toEqual([0]);
  });

  test("projection invariants — idempotence, range, Moreau, non-expansiveness", () => {
    assertProjectionInvariants(K, [
      svec([
        [2, 0],
        [0, 3],
      ]),
      svec([
        [-1, 0],
        [0, -2],
      ]),
      svec([
        [1, 0],
        [0, -1],
      ]),
      svec([
        [0, 1],
        [1, 0],
      ]),
      svec([
        [3, -1],
        [-1, 2],
      ]),
      svec([
        [-2, 1.5],
        [1.5, 0.5],
      ]),
    ]);
    assertProjectionInvariants(psd(3), [
      svec([
        [2, -1, 0],
        [-1, 2, -1],
        [0, -1, 2],
      ]),
      svec([
        [-1, 0.5, 0.2],
        [0.5, -2, 1],
        [0.2, 1, 0.3],
      ]),
      svec([
        [0, 1, 0],
        [1, 0, 1],
        [0, 1, 0],
      ]),
    ]);
  });
});

// ── projectCone — dimension and scope guards ────────────────────────────────

describe("projectCone — guards", () => {
  test("rejects a length / dimension mismatch", () => {
    expect(() => projectCone(new Float64Array([1, 2]), nonNeg(3))).toThrow(ConeError);
    expect(() => projectCone(new Float64Array([1, 2]), soc(3))).toThrow(ConeError);
    expect(() => projectCone(new Float64Array([1, 2]), psd(2))).toThrow(ConeError);
  });

  test("a malformed soc / psd cone literal (dim < 1) throws ConeError", () => {
    // The smart constructors forbid this, but a raw object literal can
    // still reach projectCone — it must refuse loudly, not divide by an
    // absent coordinate or hand an empty matrix to `eigh`.
    expect(() => projectCone(new Float64Array(0), { kind: "soc", dim: 0 })).toThrow(ConeError);
    expect(() => projectCone(new Float64Array(0), { kind: "psd", side: 0 })).toThrow(ConeError);
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
  test("soc: membership is `t ≥ ‖x‖₂`, tolerance-gated", () => {
    expect(inCone(new Float64Array([5, 3, 4]), soc(3), 0)).toBe(true); // 5 ≥ 5
    expect(inCone(new Float64Array([4.9, 3, 4]), soc(3), 0)).toBe(false); // 4.9 < 5
    // a small boundary violation is admitted within tol
    expect(inCone(new Float64Array([5 - 1e-9, 3, 4]), soc(3), 1e-8)).toBe(true);
    expect(inCone(new Float64Array([5 - 1e-7, 3, 4]), soc(3), 1e-8)).toBe(false);
    // a NaN coordinate poisons the comparison → never a member
    expect(inCone(new Float64Array([Number.NaN, 0, 0]), soc(3), 1)).toBe(false);
  });
  test("psd: membership is `λ_min(smat(z)) ≥ 0`, tolerance-gated", () => {
    expect(
      inCone(
        svec([
          [2, 0],
          [0, 3],
        ]),
        psd(2),
        0,
      ),
    ).toBe(true);
    expect(
      inCone(
        svec([
          [1, 0],
          [0, -1],
        ]),
        psd(2),
        0,
      ),
    ).toBe(false);
    // a slightly-negative eigenvalue is admitted within tol
    expect(inCone(new Float64Array([-1e-9]), psd(1), 1e-8)).toBe(true);
    expect(inCone(new Float64Array([-1e-7]), psd(1), 1e-8)).toBe(false);
    // a non-finite block is never a member — pre-scanned, returns false
    expect(inCone(new Float64Array([Number.NaN, 0, 0]), psd(2), 1)).toBe(false);
  });
  test("exp / pow throw with their sub-bead pointer", () => {
    expect(() => inCone(new Float64Array(3), { kind: "exp" }, 0)).toThrow(/j282/);
    expect(() => inCone(new Float64Array(3), { kind: "pow", alpha: 0.5 }, 0)).toThrow(/j282/);
  });
});
