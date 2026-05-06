// =============================================================================
// squareFree (Yun 1976) — invariant tests
// =============================================================================
//
// We test the *invariants* of square-free decomposition, not specific
// output bytes:
//
//   I1. (reconstruction) lc(f) · ∏_i a_i^i == f
//   I2. (square-free) gcd(a_i, a_i') == 1 for every i (each factor has
//       no repeated roots)
//   I3. (pairwise coprime) gcd(a_i, a_j) == 1 for i ≠ j
//   I4. (monic) every a_i is monic in the principal variable
//   I5. (multiplicity discipline) result entries have strictly increasing
//       distinct multiplicities
//   I6. (no spurious entries) every a_i has positive degree
//
// The reconstruction invariant is the load-bearing one — every other
// invariant is a refinement of "the candidate's claim about f's
// structure is internally consistent." Reconstruction makes the claim
// fall on the actual polynomial.

import { describe, expect, test } from "bun:test";
import {
  makeRat,
  polyAdd,
  polyDeriv,
  polyDivExact,
  polyEq,
  polyGcd,
  polyIsOne,
  polyLeadingCoef,
  polyMul,
  polyNeg,
  polyOne,
  polyPow,
  polyVar,
  polyConst,
  ratEq,
  RAT_ONE,
  RAT_RING,
  type Poly,
  type Rat,
} from "@workbench/cas-core";

import { squareFree, type SquareFreeFactor } from "../src/index.js";

const r = (n: number | bigint, d: number | bigint = 1): Rat =>
  makeRat(BigInt(n), BigInt(d));

const x = polyVar<Rat>("x", RAT_RING);
const constP = (c: Rat) => polyConst<Rat>(c, RAT_RING);

/** (x - a) over Q built via the trusted cas-core API. */
const lin = (a: Rat | number | bigint): Poly<Rat> => {
  const aRat = typeof a === "object" ? a : r(a);
  return polyAdd(x, polyConst({ n: -aRat.n, d: aRat.d }, RAT_RING), RAT_RING);
};

/** Reconstruct f from a list of (a_i, i): lc(f) · ∏ a_i^i. */
function reconstruct(
  result: SquareFreeFactor[],
  lc: Rat,
): Poly<Rat> {
  let acc = constP(lc);
  for (const { factor, multiplicity } of result) {
    acc = polyMul(acc, polyPow(factor, multiplicity, RAT_RING), RAT_RING);
  }
  return acc;
}

/** Assert all stated Yun invariants hold for `result` decomposing `f`. */
function assertYunInvariants(
  f: Poly<Rat>,
  result: SquareFreeFactor[],
): void {
  const lc = polyLeadingCoef(f, RAT_RING);

  // I1. Reconstruction.
  const reconstructed = reconstruct(result, lc);
  expect(polyEq(reconstructed, f, RAT_RING)).toBe(true);

  // I2. Each factor is square-free: gcd(a_i, a_i') == 1.
  for (const { factor } of result) {
    const d = polyDeriv(factor, "x", RAT_RING);
    const g = polyGcd(factor, d, RAT_RING);
    expect(polyIsOne(g, RAT_RING)).toBe(true);
  }

  // I3. Pairwise coprime.
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const g = polyGcd(result[i]!.factor, result[j]!.factor, RAT_RING);
      expect(polyIsOne(g, RAT_RING)).toBe(true);
    }
  }

  // I4. Each factor is monic.
  for (const { factor } of result) {
    const facLc = polyLeadingCoef(factor, RAT_RING);
    expect(ratEq(facLc, RAT_ONE)).toBe(true);
  }

  // I5. Strictly increasing distinct multiplicities.
  for (let i = 1; i < result.length; i++) {
    expect(result[i]!.multiplicity).toBeGreaterThan(result[i - 1]!.multiplicity);
  }

  // I6. No spurious entries.
  for (const { factor } of result) {
    expect(polyIsOne(factor, RAT_RING)).toBe(false);
  }
}

describe("squareFree (Yun 1976)", () => {
  test("linear x: returns [(x, 1)]", () => {
    const result = squareFree(x, "x");
    assertYunInvariants(x, result);
    expect(result.length).toBe(1);
    expect(result[0]!.multiplicity).toBe(1);
  });

  test("(x - 3): returns [(x - 3, 1)]", () => {
    const f = lin(3);
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(1);
  });

  test("(x - 1)^2: returns [(x - 1, 2)]", () => {
    const f = polyPow(lin(1), 2, RAT_RING);
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(1);
    expect(result[0]!.multiplicity).toBe(2);
  });

  test("(x - 1)^5: returns [(x - 1, 5)]", () => {
    const f = polyPow(lin(1), 5, RAT_RING);
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(1);
    expect(result[0]!.multiplicity).toBe(5);
  });

  test("(x - 1)·(x + 1): returns [(squarefree, 1)] of degree 2", () => {
    const f = polyMul(lin(1), lin(-1), RAT_RING);    // x^2 - 1
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(1);
    expect(result[0]!.multiplicity).toBe(1);
  });

  test("(x - 1)^2·(x + 1)^3: returns squarefree pieces at multiplicities 2 and 3", () => {
    const f = polyMul(
      polyPow(lin(1), 2, RAT_RING),
      polyPow(lin(-1), 3, RAT_RING),
      RAT_RING,
    );
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(2);
    expect(result.map((p) => p.multiplicity).sort()).toEqual([2, 3]);
  });

  test("(x - 1)^3·(x + 1)^2·(x - 2): mixed multiplicities 1, 2, 3", () => {
    const f = polyMul(
      polyMul(
        polyPow(lin(1), 3, RAT_RING),
        polyPow(lin(-1), 2, RAT_RING),
        RAT_RING,
      ),
      lin(2),
      RAT_RING,
    );
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(3);
    expect(result.map((p) => p.multiplicity).sort()).toEqual([1, 2, 3]);
  });

  test("3·(x - 1)^2: rational leading coefficient is preserved in reconstruction", () => {
    // f = 3·(x - 1)^2 = 3·x^2 - 6·x + 3
    const f = polyMul(constP(r(3)), polyPow(lin(1), 2, RAT_RING), RAT_RING);
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(1);
    expect(result[0]!.multiplicity).toBe(2);
  });

  test("non-trivial: (x^2 + 1)^3·(x - 2)^2 — irreducible quadratic at mult 3", () => {
    // x^2 + 1 has no roots over Q, so squareFree treats it as a single
    // irreducible factor at multiplicity 3.
    const xSq = polyPow(x, 2, RAT_RING);
    const xSqPlus1 = polyMul(constP(RAT_ONE), xSq, RAT_RING);
    const xSqPlus1Full = {
      terms: [
        { exp: [] as [string, number][], coef: RAT_ONE },
        { exp: [["x", 2]] as [string, number][], coef: RAT_ONE },
      ],
    } as Poly<Rat>;
    const f = polyMul(
      polyPow(xSqPlus1Full, 3, RAT_RING),
      polyPow(lin(2), 2, RAT_RING),
      RAT_RING,
    );
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(2);
    expect(result.map((p) => p.multiplicity).sort()).toEqual([2, 3]);
  });

  test("idempotence on already-squarefree input: f = f (single mult-1 factor)", () => {
    // f = (x - 1)·(x + 1)·(x - 2): squarefree, three roots.
    const f = polyMul(
      polyMul(lin(1), lin(-1), RAT_RING),
      lin(2),
      RAT_RING,
    );
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(1);
    expect(result[0]!.multiplicity).toBe(1);
    // The single mult-1 factor IS f itself (modulo monicization;
    // f is already monic since each linear piece is monic).
    expect(polyEq(result[0]!.factor, f, RAT_RING)).toBe(true);
  });

  test("zero polynomial throws", () => {
    expect(() => squareFree(polyOne<Rat>(RAT_RING), "x")).not.toThrow();
    // Zero is the malformed case.
    const zero = { terms: [] } as Poly<Rat>;
    expect(() => squareFree(zero, "x")).toThrow();
  });

  test("constant polynomial returns empty list", () => {
    const seven = constP(r(7));
    const result = squareFree(seven, "x");
    expect(result).toEqual([]);
  });

  test("deep multiplicity (x - 1)^7: returns single factor at mult 7", () => {
    const f = polyPow(lin(1), 7, RAT_RING);
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(1);
    expect(result[0]!.multiplicity).toBe(7);
  });

  test("rational coefficients: (x - 1/2)^2·(x + 1/3)", () => {
    const xMinusHalf = lin(makeRat(1n, 2n));
    const xPlusThird = lin(makeRat(-1n, 3n));
    const f = polyMul(
      polyPow(xMinusHalf, 2, RAT_RING),
      xPlusThird,
      RAT_RING,
    );
    const result = squareFree(f, "x");
    assertYunInvariants(f, result);
    expect(result.length).toBe(2);
    expect(result.map((p) => p.multiplicity).sort()).toEqual([1, 2]);
  });

  // ---------------------------------------------------------------
  // Property-based stress: 30 deterministic random products.
  //
  // Each iteration picks 1-5 distinct linear roots in {-9..9} and
  // assigns each a multiplicity in {1..4}, then asserts all Yun
  // invariants hold. Catches off-by-one / sign / canonicalisation
  // bugs that small fixed cases miss.
  // ---------------------------------------------------------------
  test("property: 30 random products of (x - a_k)^m_k pass Yun invariants", () => {
    // xorshift32 seeded — deterministic across runs.
    let state = 0x9e3779b9 | 0;
    const rng = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) % 1_000_000) / 1_000_000;
    };
    const randint = (lo: number, hi: number) =>
      lo + Math.floor(rng() * (hi - lo + 1));

    for (let trial = 0; trial < 30; trial++) {
      const numRoots = randint(1, 5);
      const usedRoots = new Set<number>();
      const factors: Array<{ root: number; mult: number }> = [];
      for (let k = 0; k < numRoots; k++) {
        let root = randint(-9, 9);
        let attempts = 0;
        while (usedRoots.has(root) && attempts < 50) {
          root = randint(-9, 9);
          attempts++;
        }
        if (usedRoots.has(root)) break;
        usedRoots.add(root);
        const mult = randint(1, 4);
        factors.push({ root, mult });
      }
      if (factors.length === 0) continue;

      // Build f = ∏_k (x - root_k)^mult_k.
      let f: Poly<Rat> | null = null;
      for (const { root, mult } of factors) {
        const piece = polyPow(lin(root), mult, RAT_RING);
        f = f === null ? piece : polyMul(f, piece, RAT_RING);
      }
      if (f === null) continue;

      const result = squareFree(f, "x");
      assertYunInvariants(f, result);

      // Plus a structural witness: the multiplicity-set in `result`
      // equals the distinct multiplicities of the input.
      const inputMults = new Set(factors.map((f) => f.mult));
      const outputMults = new Set(result.map((r) => r.multiplicity));
      expect([...outputMults].sort((a, b) => a - b))
        .toEqual([...inputMults].sort((a, b) => a - b));
    }
  });

  // ---------------------------------------------------------------
  // Adversarial: high-degree perfect powers stress the loop's
  // multiplicity counting.
  // ---------------------------------------------------------------
  test("adversarial: (x - 1)^k for k ∈ {1..15} all decompose correctly", () => {
    for (let k = 1; k <= 15; k++) {
      const f = polyPow(lin(1), k, RAT_RING);
      const result = squareFree(f, "x");
      assertYunInvariants(f, result);
      expect(result.length).toBe(1);
      expect(result[0]!.multiplicity).toBe(k);
    }
  });

  // ---------------------------------------------------------------
  // Adversarial: alternating-multiplicity composite forces every
  // iteration of the Yun loop to extract a non-trivial factor.
  // ---------------------------------------------------------------
  test("adversarial: ∏_{k=1..6} (x − k)^k forces all 6 multiplicities", () => {
    let f: Poly<Rat> | null = null;
    for (let k = 1; k <= 6; k++) {
      const piece = polyPow(lin(k), k, RAT_RING);
      f = f === null ? piece : polyMul(f, piece, RAT_RING);
    }
    const result = squareFree(f!, "x");
    assertYunInvariants(f!, result);
    expect(result.length).toBe(6);
    expect(result.map((r) => r.multiplicity)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
