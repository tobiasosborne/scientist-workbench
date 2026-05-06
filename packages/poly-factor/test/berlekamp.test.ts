// =============================================================================
// berlekampFactor — invariant tests + mutation-prove
// =============================================================================
//
// Invariants (each a separate `expect`):
//
//   I1. Reconstruction:  ∏_i factor_i ≡ f  (mod p)
//   I2. Each factor is monic in v.
//   I3. Each factor has positive degree.
//   I4. Pairwise coprime over 𝔽_p[v]: gcd(f_i, f_j) = 1 for i ≠ j.
//   I5. Number of factors equals the dimension of the Berlekamp
//       subalgebra (cross-checked by manual count for the Lagrange
//       interpolation cases).
//   I6. Irreducibility (proxy): no factor of positive degree splits
//       further when fed back through `berlekampFactor`.
//
// Reconstruction is the load-bearing invariant. The "no further split"
// check is a proxy for true irreducibility (cheap, sufficient for
// confidence at the unit-test level).

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  fpField,
  polyAdd,
  polyConst,
  polyDegInVar,
  polyEq,
  polyFromCoeffsInVar,
  polyGcd,
  polyIsOne,
  polyMul,
  polyVar,
} from "@workbench/cas-core";

import { berlekampFactor } from "../src/index.js";

function uni(coefs: bigint[], p: bigint): Poly<bigint> {
  const F = fpField(p);
  const c = (n: bigint): Poly<bigint> => polyConst<bigint>(F.fromInt(n), F);
  return polyFromCoeffsInVar(coefs.map(c), "x", F);
}

function leadingCoef(f: Poly<bigint>, v: string): bigint {
  if (f.terms.length === 0) return 0n;
  const d = polyDegInVar(f, v);
  for (const t of f.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    if (pv === d) return t.coef;
  }
  return 0n;
}

function assertBerlekampInvariants(
  f: Poly<bigint>, p: bigint, factors: Poly<bigint>[],
): void {
  const F = fpField(p);
  // I1. Reconstruction.
  let prod: Poly<bigint> = polyConst<bigint>(1n, F);
  for (const fi of factors) prod = polyMul(prod, fi, F);
  expect(polyEq(prod, f, F)).toBe(true);

  // I2 + I3. Each factor monic, positive degree.
  for (const fi of factors) {
    expect(polyDegInVar(fi, "x")).toBeGreaterThan(0);
    expect(leadingCoef(fi, "x")).toBe(1n);
  }

  // I4. Pairwise coprime.
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const g = polyGcd(factors[i]!, factors[j]!, F);
      expect(polyIsOne(g, F)).toBe(true);
    }
  }

  // I6. Irreducibility proxy: re-factoring any factor returns itself.
  for (const fi of factors) {
    const sub = berlekampFactor(fi, p, "x");
    expect(sub.length).toBe(1);
    expect(polyEq(sub[0]!, fi, F)).toBe(true);
  }
}

describe("berlekampFactor — happy path", () => {
  test("constant f returns []", () => {
    const f = uni([1n], 5n);
    expect(berlekampFactor(f, 5n, "x").length).toBe(0);
  });

  test("linear f returns [f]", () => {
    const f = uni([3n, 1n], 7n);                // x + 3
    const factors = berlekampFactor(f, 7n, "x");
    expect(factors.length).toBe(1);
    assertBerlekampInvariants(f, 7n, factors);
  });

  test("(x+1)(x+2) over F_5 splits into two linear factors", () => {
    // (x+1)(x+2) = x² + 3x + 2 mod 5
    const f = uni([2n, 3n, 1n], 5n);
    const factors = berlekampFactor(f, 5n, "x");
    expect(factors.length).toBe(2);
    assertBerlekampInvariants(f, 5n, factors);
  });

  test("(x+1)(x+2)(x+3) over F_7 splits into three linear factors", () => {
    // (x+1)(x+2)(x+3) = x³ + 6x² + 11x + 6 ≡ x³ + 6x² + 4x + 6 mod 7
    const F = fpField(7n);
    const x = polyVar<bigint>("x", F);
    const c = (n: bigint) => polyConst<bigint>(F.fromInt(n), F);
    const f = polyMul(polyMul(
      polyAdd(x, c(1n), F),
      polyAdd(x, c(2n), F),
      F),
      polyAdd(x, c(3n), F),
      F,
    );
    const factors = berlekampFactor(f, 7n, "x");
    expect(factors.length).toBe(3);
    assertBerlekampInvariants(f, 7n, factors);
  });

  test("irreducible quadratic stays irreducible", () => {
    // x² + 1 is irreducible mod 3 (no roots: 0²+1=1, 1²+1=2, 2²+1=2 — none = 0).
    const f = uni([1n, 0n, 1n], 3n);
    const factors = berlekampFactor(f, 3n, "x");
    expect(factors.length).toBe(1);
    assertBerlekampInvariants(f, 3n, factors);
  });

  test("(x²+1)(x²+x+1) over F_3 — mixed irreducibles", () => {
    // x²+1 irreducible mod 3 (above). x²+x+1 irreducible mod 3
    // (no roots: 0+0+1=1, 1+1+1=0… wait, x²+x+1 at x=1: 1+1+1=3≡0! So
    // it DOES factor mod 3). Let me pick a different irreducible:
    // x²+x+2 mod 3: at x=0: 2, x=1: 4≡1, x=2: 8≡2. No roots → irreducible.
    const F = fpField(3n);
    const a = uni([1n, 0n, 1n], 3n);              // x² + 1
    const b = uni([2n, 1n, 1n], 3n);              // x² + x + 2
    const f = polyMul(a, b, F);                   // deg 4
    const factors = berlekampFactor(f, 3n, "x");
    expect(factors.length).toBe(2);
    assertBerlekampInvariants(f, 3n, factors);
  });

  test("higher prime: (x-1)(x-2)(x²+1) over F_11", () => {
    const F = fpField(11n);
    const x = polyVar<bigint>("x", F);
    const c = (n: bigint) => polyConst<bigint>(F.fromInt(n), F);
    const a = polyAdd(x, c(-1n), F);              // x − 1
    const b = polyAdd(x, c(-2n), F);              // x − 2
    const cc = uni([1n, 0n, 1n], 11n);            // x² + 1 (irreducible mod 11)
    const f = polyMul(polyMul(a, b, F), cc, F);
    const factors = berlekampFactor(f, 11n, "x");
    expect(factors.length).toBe(3);
    assertBerlekampInvariants(f, 11n, factors);
  });

  test("p = 2 corner case: (x)(x+1) splits", () => {
    // f = x² + x = x·(x+1) over F_2.
    const f = uni([0n, 1n, 1n], 2n);
    const factors = berlekampFactor(f, 2n, "x");
    expect(factors.length).toBe(2);
    assertBerlekampInvariants(f, 2n, factors);
  });

  test("rejects non-monic input", () => {
    // 2x² + x + 1 over F_5 (lc = 2, not monic).
    const f = uni([1n, 1n, 2n], 5n);
    expect(() => berlekampFactor(f, 5n, "x")).toThrow(/monic/);
  });

  test("rejects p < 2", () => {
    const f = uni([1n, 1n], 5n);
    expect(() => berlekampFactor(f, 1n, "x")).toThrow();
  });

  test("rejects zero polynomial", () => {
    const zero: Poly<bigint> = { terms: [] };
    expect(() => berlekampFactor(zero, 5n, "x")).toThrow();
  });
});

describe("berlekampFactor — five distinct linear factors over F_7", () => {
  test("(x)(x+1)(x+2)(x+3)(x+4) — full degree-5 splitting", () => {
    const F = fpField(7n);
    const x = polyVar<bigint>("x", F);
    const c = (n: bigint) => polyConst<bigint>(F.fromInt(n), F);
    let f: Poly<bigint> = polyConst<bigint>(1n, F);
    for (let i = 0; i < 5; i++) {
      f = polyMul(f, polyAdd(x, c(BigInt(i)), F), F);
    }
    const factors = berlekampFactor(f, 7n, "x");
    expect(factors.length).toBe(5);
    assertBerlekampInvariants(f, 7n, factors);
  });
});
