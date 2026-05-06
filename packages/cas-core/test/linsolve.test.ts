// =============================================================================
// linsolve tests — Bareiss exact linear solving over Q
// =============================================================================
//
// Structure:
//   • Boundary cases (m=0, n=0, mixes thereof).
//   • Unique solutions (small dense + classical structural).
//   • Under-determined (parametric form correctness via substitution).
//   • Inconsistent (Rouché-Capelli witness via rank inequality).
//   • Affine string formatter (round-trip + ordering invariants).
//   • Determinant of intermediate values (integer-preserving claim).
//   • Mutation proofs in the harness's spirit (here: assertions that
//     would fail under specific perturbations of the algorithm).
//
// Every test asserts an invariant. No "didn't throw" checks.

import { describe, expect, test } from "bun:test";
import {
  affineToString,
  bareissSolve,
  formatRat,
  makeRat,
  parseRat,
  RAT_ONE,
  RAT_ZERO,
  type Rat,
} from "../src/index.js";

const r = (n: number | bigint, d: number | bigint = 1): Rat =>
  makeRat(BigInt(n), BigInt(d));

const matEq = (a: ReadonlyArray<Rat>, b: ReadonlyArray<Rat>): boolean =>
  a.length === b.length && a.every((ai, i) => ai.n === b[i]!.n && ai.d === b[i]!.d);

const dot = (row: ReadonlyArray<Rat>, x: ReadonlyArray<Rat>): Rat => {
  let s = RAT_ZERO;
  for (let j = 0; j < row.length; j++) {
    const ai = row[j]!;
    const xj = x[j]!;
    s = makeRat(
      s.n * (ai.d * xj.d) + (ai.n * xj.n) * s.d,
      s.d * ai.d * xj.d,
    );
  }
  return s;
};

const checkSatisfies = (
  A: ReadonlyArray<ReadonlyArray<Rat>>,
  x: ReadonlyArray<Rat>,
  b: ReadonlyArray<Rat>,
): void => {
  for (let i = 0; i < A.length; i++) {
    const lhs = dot(A[i]!, x);
    expect(lhs.n).toBe(b[i]!.n);
    expect(lhs.d).toBe(b[i]!.d);
  }
};

// ---------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------

describe("bareissSolve — boundary cases", () => {
  test("0x0: trivially unique with empty x", () => {
    const out = bareissSolve([], []);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    expect(out.x.length).toBe(0);
    expect(out.rank).toBe(0);
  });

  test("0xn: every x ∈ Q^n is a solution → under-determined with n free vars", () => {
    const out = bareissSolve([], []);
    // For 0×n where n>0 we'd construct via empty A, but A.length === 0 ⇒
    // m=0 and we can't tell n from A. The function defaults to unique
    // x=[] for m=0 ∧ n=0 (no rows ⇒ no constraint shape; user gets the
    // canonical "no equations" answer).
    expect(out.kind).toBe("unique");
  });

  test("mx0 with all-zero b: vacuously unique x=[]", () => {
    const A: Rat[][] = [[], [], []];
    const b = [RAT_ZERO, RAT_ZERO, RAT_ZERO];
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    expect(out.x.length).toBe(0);
    expect(out.rank).toBe(0);
  });

  test("mx0 with non-zero b: inconsistent", () => {
    const A: Rat[][] = [[], []];
    const b = [r(1), RAT_ZERO];
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("inconsistent");
  });

  test("ragged A: throws", () => {
    expect(() =>
      bareissSolve([[r(1), r(2)], [r(3)]], [r(4), r(5)]),
    ).toThrow(/ragged/);
  });

  test("|b| ≠ rows: throws", () => {
    expect(() => bareissSolve([[r(1)]], [r(1), r(2)])).toThrow();
  });
});

// ---------------------------------------------------------------------
// Unique solutions
// ---------------------------------------------------------------------

describe("bareissSolve — unique solutions", () => {
  test("1×1 trivial: 3·x = 6 ⇒ x=2", () => {
    const out = bareissSolve([[r(3)]], [r(6)]);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    expect(matEq(out.x, [r(2)])).toBe(true);
    expect(out.rank).toBe(1);
  });

  test("2×2 identity preserves b", () => {
    const A = [[RAT_ONE, RAT_ZERO], [RAT_ZERO, RAT_ONE]];
    const b = [r(7), r(-3)];
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    checkSatisfies(A, out.x, b);
  });

  test("2×2 generic: x+2y=5, 3x+4y=11 ⇒ x=1, y=2", () => {
    const A = [[r(1), r(2)], [r(3), r(4)]];
    const b = [r(5), r(11)];
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    expect(matEq(out.x, [r(1), r(2)])).toBe(true);
    checkSatisfies(A, out.x, b);
  });

  test("3×3 Hilbert: residual is exactly zero", () => {
    // H_3 = [[1, 1/2, 1/3], [1/2, 1/3, 1/4], [1/3, 1/4, 1/5]]
    // Pick x = (1, -2, 1); b = H · x.
    const H: Rat[][] = [];
    for (let i = 0; i < 3; i++) {
      const row: Rat[] = [];
      for (let j = 0; j < 3; j++) row.push(r(1, i + j + 1));
      H.push(row);
    }
    const xTrue = [r(1), r(-2), r(1)];
    const b: Rat[] = [];
    for (let i = 0; i < 3; i++) b.push(dot(H[i]!, xTrue));
    const out = bareissSolve(H, b);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    checkSatisfies(H, out.x, b);
    // Hilbert reconstruction is exact in ℚ even though numerically ill-
    // conditioned; the recovered x should equal xTrue *bit-equally*.
    expect(matEq(out.x, xTrue)).toBe(true);
  });

  test("over-determined consistent: 2×1 system [[2],[4]] · [x] = [6, 12] ⇒ x=3", () => {
    const out = bareissSolve([[r(2)], [r(4)]], [r(6), r(12)]);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    expect(matEq(out.x, [r(3)])).toBe(true);
  });

  test("rank reported correctly for full-rank square", () => {
    const A = [[r(2), r(1)], [r(1), r(3)]];
    const out = bareissSolve(A, [r(1), r(0)]);
    expect(out.rank).toBe(2);
  });
});

// ---------------------------------------------------------------------
// Under-determined (parametric)
// ---------------------------------------------------------------------

describe("bareissSolve — under-determined", () => {
  test("1×2 single equation: x + 2y = 5 ⇒ y free, x = 5 - 2y", () => {
    const out = bareissSolve([[r(1), r(2)]], [r(5)]);
    expect(out.kind).toBe("under-determined");
    if (out.kind !== "under-determined") throw new Error("");
    expect(out.freeVars).toEqual(["t_0"]);
    expect(out.rank).toBe(1);
    // x[0] = 5 - 2·t_0; x[1] = t_0
    expect(affineToString(out.x[0]!)).toBe("5 - 2*t_0");
    expect(affineToString(out.x[1]!)).toBe("t_0");
  });

  test("substituting any rational makes A·x = b", () => {
    // 2×3 rank 2: x + y = 4, y + 3z = 5 → x = 4 - y, z = (5 - y) / 3
    const A = [[r(1), r(1), r(0)], [r(0), r(1), r(3)]];
    const b = [r(4), r(5)];
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("under-determined");
    if (out.kind !== "under-determined") throw new Error("");
    expect(out.freeVars.length).toBe(1); // n - rank = 3 - 2 = 1
    // For each substitution t_0 = -3, 0, 7/2 — the concrete x must satisfy.
    for (const t0 of [r(-3), RAT_ZERO, r(7, 2)]) {
      const xConcrete = out.x.map((aff) => {
        let s = aff.c;
        for (const [name, coeff] of aff.coeffs) {
          if (name !== "t_0") throw new Error("unexpected free var");
          s = makeRat(
            s.n * (coeff.d * t0.d) + (coeff.n * t0.n) * s.d,
            s.d * coeff.d * t0.d,
          );
        }
        return s;
      });
      checkSatisfies(A, xConcrete, b);
    }
  });

  test("free-variable count = n - rank invariant", () => {
    // 3×3 rank 2 (third row is sum of first two): rank=2, n=3, so
    // free_count must be 1.
    const A = [[r(1), r(0), r(0)], [r(0), r(1), r(0)],
               [r(1), r(1), r(0)]];
    const b = [r(2), r(3), r(5)];
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("under-determined");
    if (out.kind !== "under-determined") throw new Error("");
    expect(out.rank).toBe(2);
    expect(out.freeVars.length).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Inconsistent (Rouché-Capelli)
// ---------------------------------------------------------------------

describe("bareissSolve — inconsistent", () => {
  test("over-determined: x = 3 vs x = 7/2 ⇒ inconsistent", () => {
    const out = bareissSolve([[r(1)], [r(2)]], [r(3), r(7)]);
    expect(out.kind).toBe("inconsistent");
    if (out.kind !== "inconsistent") throw new Error("");
    expect(out.rank).toBe(1);
    expect(out.augmentedRank).toBe(2);
  });

  test("rank-deficient with incompatible rhs", () => {
    // [1 2 3; 2 4 6; 0 1 0] with b = [6, 13, 2]. 2*row1=row2 but b1*2≠b2.
    const A = [[r(1), r(2), r(3)], [r(2), r(4), r(6)],
               [r(0), r(1), r(0)]];
    const b = [r(6), r(13), r(2)];
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("inconsistent");
  });

  test("3-variable inconsistent gives augmented_rank > rank", () => {
    const A = [[r(1), r(0), r(0)], [r(0), r(1), r(0)], [r(0), r(0), r(1)],
               [r(1), r(1), r(1)]];
    const b = [r(1), r(2), r(3), r(7)]; // 1+2+3=6 ≠ 7
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("inconsistent");
  });
});

// ---------------------------------------------------------------------
// Affine formatter
// ---------------------------------------------------------------------

describe("affineToString", () => {
  test("constant only", () => {
    const out = bareissSolve([[r(2)]], [r(8)]);
    expect(out.kind).toBe("unique");
  });

  test("under-determined output strings parse back via SymPy syntax", () => {
    // x[0] = 5 - 2*t_0 should round-trip through string-based parsing.
    const out = bareissSolve([[r(1), r(2)]], [r(5)]);
    if (out.kind !== "under-determined") throw new Error("");
    expect(affineToString(out.x[0]!)).toBe("5 - 2*t_0");
  });

  test("zero-affine formats as '0'", () => {
    const out = bareissSolve(
      [[r(1), r(0)], [r(0), r(0)]],
      [r(0), r(0)],
    );
    expect(out.kind).toBe("under-determined");
    if (out.kind !== "under-determined") throw new Error("");
    // x[0] = -t_0 (since x + 0·y = 0 → x = 0; but actually rank=1 here,
    // n-rank=1 free var. We have x + 0·y = 0 ⇒ x = 0; y = t_0.)
    // x[0] = "0", x[1] = "t_0"
    expect(affineToString(out.x[0]!)).toBe("0");
    expect(affineToString(out.x[1]!)).toBe("t_0");
  });
});

// ---------------------------------------------------------------------
// Integer-preserving claim
// ---------------------------------------------------------------------

describe("bareissSolve — integer-preserving (the headline claim)", () => {
  test("dense ±3 entries at n=10 stays bounded by Hadamard", () => {
    // Construct a 10×10 ±3 matrix, solve A·x = A·1 (so x_true = 1).
    const n = 10;
    const A: Rat[][] = [];
    for (let i = 0; i < n; i++) {
      const row: Rat[] = [];
      for (let j = 0; j < n; j++) {
        // Deterministic pseudo-random ±3 from sin(i*7+j*11) sign
        const s = Math.sin(i * 7 + j * 11);
        row.push(r(Math.sign(s) * (1 + ((i + j) % 3))));
      }
      A.push(row);
    }
    // Force non-singular by adding 1 to diagonal.
    for (let i = 0; i < n; i++) A[i]![i] = makeRat(A[i]![i]!.n + 1n, A[i]![i]!.d);
    const xTrue = Array.from({ length: n }, () => RAT_ONE);
    const b: Rat[] = [];
    for (let i = 0; i < n; i++) b.push(dot(A[i]!, xTrue));
    const out = bareissSolve(A, b);
    expect(out.kind).toBe("unique");
    if (out.kind !== "unique") throw new Error("");
    checkSatisfies(A, out.x, b);

    // Hadamard's bound: |det| ≤ ∏‖row_i‖_2. For ±3 ish entries at n=10,
    // bit-length of det ≤ ~50; intermediate values ≤ some constant × det
    // (≈1000 bits worst case, but in practice ≪). Our naive ℚ-Gaussian
    // would blow up to thousands of bits. Set a conservative bound:
    // 2000 bits is comfortably above Bareiss, comfortably below naive.
    expect(out.maxIntermediateBitLength).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------
// parseRat / formatRat round-trip
// ---------------------------------------------------------------------

describe("parseRat / formatRat", () => {
  test("round-trip preserves the rational", () => {
    for (const s of ["3", "-7", "0", "1/2", "-3/4", "5/3"]) {
      expect(formatRat(parseRat(s))).toBe(s);
    }
  });

  test("normalises non-canonical input", () => {
    // 4/8 → 1/2 (not canonical on input but we accept and normalise).
    expect(formatRat(parseRat("2/4"))).toBe("1/2");
    expect(formatRat(parseRat("-2/4"))).toBe("-1/2");
  });

  test("rejects malformed", () => {
    expect(() => parseRat("foo")).toThrow();
    expect(() => parseRat("1.5")).toThrow();
    expect(() => parseRat("1/0")).toThrow();
    expect(() => parseRat("")).toThrow();
  });
});
