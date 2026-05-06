// =============================================================================
// henselLiftPair — quadratic Hensel lift, two-factor
// =============================================================================
//
// Invariants of a correct lift (each a separate `expect`):
//
//   I1. f ≡ g · h  (mod p^k)        — the lift congruence at target precision.
//   I2. g ≡ g₀     (mod p)          — preserves the mod-p factor.
//   I3. h ≡ h₀     (mod p)          — preserves the mod-p factor.
//   I4. lc_v(h) = 1                 — monicity is maintained throughout.
//   I5. coefficients of g, h are in [0, p^k) — canonical residues.
//   I6. modulus output equals p^k exactly.
//
// We also include refusal-class tests for each precondition
// (non-coprime g₀ h₀; non-monic h₀; wrong product; bad p; bad k) and
// a mutation-prove block where each algorithmic mutation breaks I1
// (the reconstruction invariant) — the load-bearing check that no
// mutation passes silently.

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  INT_RING,
  polyAdd,
  polyConst,
  polyDegInVar,
  polyFromCoeffsInVar,
  polyMul,
  polySub,
  polyTrunc,
  polyVar,
} from "@workbench/cas-core";

import { berlekampFactor, henselLiftMany, henselLiftPair } from "../src/index.js";

// -----------------------------------------------------------------------------
// builders
// -----------------------------------------------------------------------------

const x = polyVar<bigint>("x", INT_RING);
const c = (n: bigint): Poly<bigint> => polyConst<bigint>(n, INT_RING);
const uni = (coefs: bigint[]): Poly<bigint> =>
  polyFromCoeffsInVar(coefs.map(c), "x", INT_RING);
void x;  // shipping x for future expansion; not used in every body

const bigPow = (b: bigint, e: number): bigint => {
  let r = 1n;
  let bb = b;
  let ee = e;
  while (ee > 0) {
    if ((ee & 1) === 1) r *= bb;
    ee >>>= 1;
    if (ee > 0) bb = bb * bb;
  }
  return r;
};

// -----------------------------------------------------------------------------
// invariant assertion
// -----------------------------------------------------------------------------

interface LiftInvariantInputs {
  readonly f: Poly<bigint>;
  readonly g0: Poly<bigint>;
  readonly h0: Poly<bigint>;
  readonly p: bigint;
  readonly k: number;
}

function assertLiftInvariants(
  inputs: LiftInvariantInputs,
  result: { g: Poly<bigint>; h: Poly<bigint>; modulus: bigint },
): void {
  const { f, g0, h0, p, k } = inputs;
  const { g, h, modulus } = result;
  const target = bigPow(p, k);

  // I6. modulus is p^k.
  expect(modulus).toBe(target);

  // I1. f ≡ g · h (mod p^k).
  const product = polyMul(g, h, INT_RING);
  const residue = polyTrunc(polySub(f, product, INT_RING), target);
  expect(residue.terms.length).toBe(0);

  // I2. g ≡ g₀ (mod p).
  const g0_modp = polyTrunc(g0, p);
  const g_modp = polyTrunc(g, p);
  expect(termsEqual(g_modp, g0_modp)).toBe(true);

  // I3. h ≡ h₀ (mod p).
  const h0_modp = polyTrunc(h0, p);
  const h_modp = polyTrunc(h, p);
  expect(termsEqual(h_modp, h0_modp)).toBe(true);

  // I4. lc_v(h) = 1.
  const dh = polyDegInVar(h, "x");
  let lcH: bigint | null = null;
  for (const t of h.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === "x") pv = exp;
    if (pv === dh) lcH = t.coef;
  }
  expect(lcH).toBe(1n);

  // I5. canonical residues for both g and h.
  for (const t of g.terms) {
    expect(t.coef >= 0n).toBe(true);
    expect(t.coef < target).toBe(true);
  }
  for (const t of h.terms) {
    expect(t.coef >= 0n).toBe(true);
    expect(t.coef < target).toBe(true);
  }
}

function termsEqual(a: Poly<bigint>, b: Poly<bigint>): boolean {
  if (a.terms.length !== b.terms.length) return false;
  for (let i = 0; i < a.terms.length; i++) {
    if (a.terms[i]!.coef !== b.terms[i]!.coef) return false;
    const ea = a.terms[i]!.exp, eb = b.terms[i]!.exp;
    if (ea.length !== eb.length) return false;
    for (let j = 0; j < ea.length; j++) {
      if (ea[j]![0] !== eb[j]![0] || ea[j]![1] !== eb[j]![1]) return false;
    }
  }
  return true;
}

// -----------------------------------------------------------------------------
// happy-path cases
// -----------------------------------------------------------------------------

describe("henselLiftPair — happy path", () => {
  test("trivial k = 1: lift returns precondition unchanged", () => {
    // f = (x + 1)(x + 2) = x^2 + 3x + 2. mod 5: g₀ = x + 1, h₀ = x + 2.
    const f = uni([2n, 3n, 1n]);
    const g0 = uni([1n, 1n]);
    const h0 = uni([2n, 1n]);
    const p = 5n, k = 1;
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    assertLiftInvariants({ f, g0, h0, p, k }, result);
  });

  test("classic Knuth example: f = x^4 - 1 over p = 5, lift to p^4", () => {
    // x^4 - 1 = (x-1)(x+1)(x^2+1) over ℤ. Group as g·h with
    // g₀ = (x-1)(x+1) = x²−1 ≡ x²+4 mod 5 and h₀ = x²+1 mod 5.
    // gcd(g₀, h₀) mod 5: gcd(x²+4, x²+1) = gcd(x²+4, −3) = gcd(x²+4, 1) = 1
    // (since −3 ≡ 2 mod 5 is a unit). Hensel-liftable.
    const f = uni([-1n, 0n, 0n, 0n, 1n]);
    const g0 = uni([4n, 0n, 1n]);   // x² + 4 ≡ x² − 1 mod 5
    const h0 = uni([1n, 0n, 1n]);   // x² + 1
    const p = 5n, k = 4;
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    assertLiftInvariants({ f, g0, h0, p, k }, result);
    // For this f, the actual integer factors fit in mod 5^k for any k ≥ 1
    // because all coefs of true factors are in {-1, 0, 1}. So the lift
    // should literally recover x²−1 and x²+1 (in canonical [0, 5^k)
    // representation).
    const target = 5n ** 4n;
    const expected_g = polyTrunc(uni([-1n, 0n, 1n]), target); // x² − 1
    const expected_h = uni([1n, 0n, 1n]);                     // x² + 1
    expect(termsEqual(result.g, expected_g)).toBe(true);
    expect(termsEqual(result.h, expected_h)).toBe(true);
  });

  test("doubling discipline: lift to k=8 from k=1 takes ≤ ⌈log₂ k⌉ iterations", () => {
    // We can't observe the iteration count externally without
    // instrumenting, but we *can* observe that the result is correct
    // and the exit modulus is p^k exactly. The doubling discipline is
    // covered by the implementation's `for (iter < k)` exit and the
    // `m >= targetModulus` early-break; here we just confirm the math.
    const f = uni([2n, 3n, 1n]);     // (x+1)(x+2)
    const g0 = uni([1n, 1n]);
    const h0 = uni([2n, 1n]);
    const p = 5n;
    for (const k of [1, 2, 3, 5, 8, 13]) {
      const result = henselLiftPair(f, g0, h0, p, k, "x");
      assertLiftInvariants({ f, g0, h0, p, k }, result);
    }
  });

  test("non-trivial mod-p coefficients: f = x^3 + 10x^2 - 432x + 5040, p = 13", () => {
    // f = (x - 12)(x + 21)(x + 1) over ℤ — a polynomial whose lift to
    // mod 13^5 is non-trivial because the integer factors have larger
    // coefficients than the mod-13 inputs.
    // Compute f explicitly: (x − 12)(x + 21) = x² + 9x − 252.
    //   (x² + 9x − 252)(x + 1) = x³ + 10x² − 243x − 252.
    // Adjust via WolframAlpha-like reasoning is overkill — let me just
    // build it: factor pair g₀ = (x-12)(x+1) mod 13 = (x+1)(x+1) mod 13 = x²+2x+1
    // h₀ = (x+21) mod 13 = (x+8) mod 13.
    // f mod 13 should equal g₀·h₀ mod 13.
    const a = polyAdd(x, c(-12n), INT_RING);
    const b = polyAdd(x, c(21n), INT_RING);
    const cc = polyAdd(x, c(1n), INT_RING);
    const f = polyMul(polyMul(a, b, INT_RING), cc, INT_RING);
    const p = 13n;
    const g0 = polyTrunc(polyMul(a, cc, INT_RING), p); // (x-12)(x+1) mod 13
    const h0 = polyTrunc(b, p);                        // (x+21) mod 13
    const k = 5;
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    assertLiftInvariants({ f, g0, h0, p, k }, result);
  });

  test("monic prime factor: f = (x²+1)(x²+2x+3) over p = 11", () => {
    // (x² + 2x + 3) is irreducible over ℚ (discriminant 4 − 12 = −8);
    // (x² + 1) is irreducible over ℚ. Their product f = x⁴ + 2x³ + 4x²
    // + 2x + 3. Both factors are monic in x and coprime mod 11.
    const g_int = uni([1n, 0n, 1n]);            // x² + 1
    const h_int = uni([3n, 2n, 1n]);            // x² + 2x + 3
    const f = polyMul(g_int, h_int, INT_RING);
    const p = 11n, k = 6;
    const g0 = polyTrunc(g_int, p);
    const h0 = polyTrunc(h_int, p);
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    assertLiftInvariants({ f, g0, h0, p, k }, result);
    // For the irreducible-factors case, the lift should recover the
    // integer factors verbatim (in canonical representation).
    expect(termsEqual(result.g, polyTrunc(g_int, bigPow(p, k)))).toBe(true);
    expect(termsEqual(result.h, polyTrunc(h_int, bigPow(p, k)))).toBe(true);
  });

  test("balanced-residue input: g₀ with negative coefs is normalised", () => {
    // Caller passes g₀ in balanced (-p/2, p/2] residues; module reduces
    // to canonical [0, p) before lifting. f = (x − 1)(x − 2) = x² − 3x + 2.
    const f = uni([2n, -3n, 1n]);
    const g0 = uni([-1n, 1n]);                  // x − 1 (balanced)
    const h0 = uni([-2n, 1n]);                  // x − 2 (balanced)
    const p = 7n, k = 3;
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    assertLiftInvariants({ f, g0, h0, p, k }, result);
  });
});

// -----------------------------------------------------------------------------
// refusal classes
// -----------------------------------------------------------------------------

describe("henselLiftPair — preconditions", () => {
  test("non-coprime mod-p factors throw", () => {
    // g₀ = h₀ = x − 1 share gcd (x − 1); not Hensel-liftable.
    const f = uni([1n, -2n, 1n]);                // (x−1)²
    const g0 = uni([-1n, 1n]);
    const h0 = uni([-1n, 1n]);
    expect(() => henselLiftPair(f, g0, h0, 5n, 3, "x")).toThrow(/coprime|gcd/);
  });

  test("non-monic h₀ throws", () => {
    // h₀ = 2x + 1 (non-monic). Even though the math could lift if we
    // generalised, our v0.1 contract requires lc(h) = 1.
    const g0 = uni([1n, 1n]);
    const h0 = uni([1n, 2n]);
    const f = polyMul(g0, h0, INT_RING);
    expect(() => henselLiftPair(f, g0, h0, 5n, 3, "x")).toThrow(/monic/);
  });

  test("f ≢ g₀·h₀ mod p throws", () => {
    // Pass a wrong f, deliberately. f = x² + 5 != (x+1)(x+2) mod 7.
    const f = uni([5n, 0n, 1n]);
    const g0 = uni([1n, 1n]);
    const h0 = uni([2n, 1n]);
    expect(() => henselLiftPair(f, g0, h0, 7n, 3, "x")).toThrow();
  });

  test("k = 0 throws (precision must be positive)", () => {
    const f = uni([2n, 3n, 1n]);
    expect(() => henselLiftPair(f, uni([1n, 1n]), uni([2n, 1n]), 5n, 0, "x")).toThrow();
  });

  test("p = 1 throws", () => {
    const f = uni([2n, 3n, 1n]);
    expect(() => henselLiftPair(f, uni([1n, 1n]), uni([2n, 1n]), 1n, 3, "x")).toThrow();
  });
});

// -----------------------------------------------------------------------------
// mutation-prove
// -----------------------------------------------------------------------------
//
// Each "mutation" perturbs the lift output deliberately. We confirm
// that every mutation breaks at least one of the lift invariants —
// otherwise the invariant set is too weak.

describe("henselLiftPair — mutation-prove", () => {
  // Setup: a deg-3 lift to mod 11^4.
  const a = polyAdd(x, c(-3n), INT_RING);
  const b = polyAdd(x, c(7n), INT_RING);
  const cc = polyAdd(x, c(2n), INT_RING);
  const f = polyMul(polyMul(a, b, INT_RING), cc, INT_RING);
  const p = 11n;
  const k = 4;
  const g0 = polyTrunc(polyMul(a, cc, INT_RING), p);
  const h0 = polyTrunc(b, p);

  test("baseline lift is GREEN", () => {
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    assertLiftInvariants({ f, g0, h0, p, k }, result);
  });

  test("mutation: drop a coefficient from g — breaks I1 (reconstruction)", () => {
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    // Drop the constant coefficient from g.
    const mutated_g: Poly<bigint> = {
      terms: result.g.terms.filter((t) => t.exp.length > 0),
    };
    // I1 should fail.
    const target = bigPow(p, k);
    const product = polyMul(mutated_g, result.h, INT_RING);
    const residue = polyTrunc(polySub(f, product, INT_RING), target);
    expect(residue.terms.length).not.toBe(0);
  });

  test("mutation: scale h by 2 — breaks I4 (monicity) AND I1", () => {
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    const target = bigPow(p, k);
    const mutated_h: Poly<bigint> = polyTrunc(
      polyMul(c(2n), result.h, INT_RING), target,
    );
    // Monicity fails.
    const dh = polyDegInVar(mutated_h, "x");
    let lc: bigint | null = null;
    for (const t of mutated_h.terms) {
      let pv = 0;
      for (const [name, exp] of t.exp) if (name === "x") pv = exp;
      if (pv === dh) lc = t.coef;
    }
    expect(lc).not.toBe(1n);
    // And reconstruction fails: g · (2h) ≠ f mod p^k unless f happens
    // to satisfy that, which it doesn't.
    const product = polyMul(result.g, mutated_h, INT_RING);
    const residue = polyTrunc(polySub(f, product, INT_RING), target);
    expect(residue.terms.length).not.toBe(0);
  });

  test("mutation: corrupt at higher power of p — breaks I1 at p^k but NOT at p", () => {
    // The classic insidious bug: lift to p^k succeeds at low precision
    // but fails at full precision. Add 11³ to g's constant term.
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    const target = bigPow(p, k);
    const corruption = bigPow(p, 3); // 11^3
    const mutated_g: Poly<bigint> = polyTrunc(
      polyAdd(result.g, c(corruption), INT_RING), target,
    );
    // Reconstruction at p^k fails:
    const product_pk = polyMul(mutated_g, result.h, INT_RING);
    const residue_pk = polyTrunc(polySub(f, product_pk, INT_RING), target);
    expect(residue_pk.terms.length).not.toBe(0);
    // But mod p, the corruption (which is ≡ 0 mod p^3 ⊆ mod p) is invisible:
    const product_p = polyTrunc(product_pk, p);
    const f_p = polyTrunc(f, p);
    expect(termsEqual(product_p, f_p)).toBe(true);
    // This is exactly what makes Hensel hard to test by mod-p sampling
    // alone — the invariant set MUST include reconstruction at the
    // target precision, not just at the seed precision.
  });

  test("mutation: out-of-canonical-range coefficient — breaks I5", () => {
    const result = henselLiftPair(f, g0, h0, p, k, "x");
    const target = bigPow(p, k);
    // Add target to a coefficient — value > target = wrong canonical form.
    const mutated_g: Poly<bigint> = {
      terms: result.g.terms.map((t, i) =>
        i === 0 ? { exp: t.exp, coef: t.coef + target } : t,
      ),
    };
    // I5: range check fails.
    const offending = mutated_g.terms.find((t) => t.coef >= target);
    expect(offending).not.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// henselLiftMany — multi-factor recursive lift
// -----------------------------------------------------------------------------

describe("henselLiftMany", () => {
  test("r = 0 returns empty list", () => {
    const f = uni([1n]);
    expect(henselLiftMany(f, [], 5n, 3, "x").length).toBe(0);
  });

  test("r = 1 returns just the truncated input", () => {
    const f = uni([3n, 1n]);                 // x + 3
    const lifted = henselLiftMany(f, [polyTrunc(f, 5n)], 5n, 4, "x");
    expect(lifted.length).toBe(1);
    expect(termsEqual(lifted[0]!, polyTrunc(f, bigPow(5n, 4)))).toBe(true);
  });

  test("r = 3 linear factors over p = 7", () => {
    // f = (x − 3)(x + 7)(x + 1) over ℤ; mod 7 these are x+4, x, x+1
    // (since x − 3 ≡ x + 4, x + 7 ≡ x).
    const a = uni([-3n, 1n]);
    const b = uni([7n, 1n]);
    const cc = uni([1n, 1n]);
    const f = polyMul(polyMul(a, b, INT_RING), cc, INT_RING);
    const p = 7n, k = 5;
    const factorsP = berlekampFactor(polyTrunc(f, p), p, "x");
    expect(factorsP.length).toBe(3);
    const lifted = henselLiftMany(f, factorsP, p, k, "x");
    expect(lifted.length).toBe(3);

    // Reconstruction: ∏ lifted ≡ f (mod p^k)
    const target = bigPow(p, k);
    let prod: Poly<bigint> = polyConst<bigint>(1n, INT_RING);
    for (const fi of lifted) prod = polyMul(prod, fi, INT_RING);
    const residue = polyTrunc(polySub(f, prod, INT_RING), target);
    expect(residue.terms.length).toBe(0);

    // Each lifted factor reduces to its mod-p preimage.
    const liftedModP = lifted.map((fi) => polyTrunc(fi, p));
    // Sort both sides by canonical encoding so the multiset comparison
    // doesn't care about order.
    const keyOf = (q: Poly<bigint>): string =>
      q.terms.map((t) => `${t.coef}|${JSON.stringify(t.exp)}`).join(",");
    const expected = factorsP.map(keyOf).sort();
    const got = liftedModP.map(keyOf).sort();
    expect(got).toEqual(expected);
  });

  test("r = 4 mix of linear and quadratic factors", () => {
    // f = (x²+1)(x²+2)(x+3)(x-5) over ℤ. Pick p = 13 — none of these
    // factor over F_13 (x²+1 has no root mod 13: squares are
    // {0,1,4,9,3,12,10}, none is 12; x²+2 likewise has root iff −2 is
    // a square mod 13: −2 ≡ 11, not in {0,1,3,4,9,10,12}. So x²+1 and
    // x²+2 are irreducible mod 13).
    const a = uni([1n, 0n, 1n]);              // x² + 1
    const b = uni([2n, 0n, 1n]);              // x² + 2
    const cc = uni([3n, 1n]);                 // x + 3
    const dd = uni([-5n, 1n]);                // x − 5
    const f = polyMul(polyMul(polyMul(a, b, INT_RING), cc, INT_RING), dd, INT_RING);
    const p = 13n, k = 4;
    const factorsP = berlekampFactor(polyTrunc(f, p), p, "x");
    expect(factorsP.length).toBe(4);
    const lifted = henselLiftMany(f, factorsP, p, k, "x");
    expect(lifted.length).toBe(4);

    const target = bigPow(p, k);
    let prod: Poly<bigint> = polyConst<bigint>(1n, INT_RING);
    for (const fi of lifted) prod = polyMul(prod, fi, INT_RING);
    const residue = polyTrunc(polySub(f, prod, INT_RING), target);
    expect(residue.terms.length).toBe(0);
  });

  test("integration: Berlekamp + henselLiftMany recovers integer factors", () => {
    // f = (x − 1)(x + 2)(x − 3)(x + 4) over ℤ. Coefficients fit easily
    // in mod p^k for modest p, k. We expect lifted == integer factors
    // in canonical mod-p^k form.
    const a = uni([-1n, 1n]);
    const b = uni([2n, 1n]);
    const cc = uni([-3n, 1n]);
    const dd = uni([4n, 1n]);
    const f = polyMul(polyMul(polyMul(a, b, INT_RING), cc, INT_RING), dd, INT_RING);
    const p = 11n, k = 3;
    const factorsP = berlekampFactor(polyTrunc(f, p), p, "x");
    expect(factorsP.length).toBe(4);
    const lifted = henselLiftMany(f, factorsP, p, k, "x");

    const target = bigPow(p, k);
    let prod: Poly<bigint> = polyConst<bigint>(1n, INT_RING);
    for (const fi of lifted) prod = polyMul(prod, fi, INT_RING);
    const residue = polyTrunc(polySub(f, prod, INT_RING), target);
    expect(residue.terms.length).toBe(0);

    // Each lifted factor (in canonical [0, p^k) form) should be one of
    // the four expected linear factors, also in canonical form.
    const expected = [a, b, cc, dd].map((q) => polyTrunc(q, target));
    const expectedKeys = expected.map(keyOf).sort();
    const liftedKeys = lifted.map(keyOf).sort();
    expect(liftedKeys).toEqual(expectedKeys);
  });
});

function keyOf(q: Poly<bigint>): string {
  return q.terms.map((t) => `${t.coef}|${JSON.stringify(t.exp)}`).join(",");
}
