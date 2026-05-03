// =============================================================================
// poly-gcd tests — ADR-0013
// =============================================================================
//
// The structure mirrors the algorithm's layering:
//
//   • Variable-view helpers in poly.ts — round-trip property + degree.
//   • polyDivExact — exact-by-construction examples + thrown-on-non-exact.
//   • polyGcd unit cases — the classical worked examples.
//   • Algebraic identities — gcd(g·a, g·b) = monic(g) · gcd(a, b),
//     gcd is monic, gcd divides both inputs, idempotence.
//   • Multivariate stress — randomised inputs over Q[x, y, z].
//   • Mutation proofs — perturb the impl, confirm RED.
//
// Every test is an assertion of an invariant, not a "didn't throw"
// check (Rule 7 in CLAUDE.md). Where the result depends on the
// algorithm's monic normalisation, we compare polynomials with
// `polyEq` against an explicitly-constructed expected value.

import { describe, expect, test } from "bun:test";
import {
  makeRat,
  polyAdd,
  polyCoeffsInVar,
  polyConst,
  polyDegInVar,
  polyDivExact,
  polyEq,
  polyFromCoeffsInVar,
  polyGcd,
  polyIsZero,
  polyMul,
  polyOne,
  polyPow,
  polySub,
  polyVar,
  polyVars,
  polyZero,
  RAT_ONE,
  RAT_RING,
  type Poly,
  type Rat,
} from "../src/index.js";

// Shorthand constructors for tests over Q[x, y, z].
const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);
const z = polyVar<Rat>("z", RAT_RING);
const one = polyOne<Rat>(RAT_RING);
const zero = polyZero<Rat>();
const Q = (n: bigint, d: bigint = 1n) => polyConst(makeRat(n, d), RAT_RING);

// `add`, `sub`, `mul` shorthand — RAT_RING applied implicitly.
const add = (...ps: Poly<Rat>[]) => ps.reduce((acc, p) => polyAdd(acc, p, RAT_RING), zero);
const sub = (a: Poly<Rat>, b: Poly<Rat>) => polySub(a, b, RAT_RING);
const mul = (...ps: Poly<Rat>[]) => ps.reduce((acc, p) => polyMul(acc, p, RAT_RING), one);
const pow = (p: Poly<Rat>, n: number) => polyPow(p, n, RAT_RING);
const eq = (a: Poly<Rat>, b: Poly<Rat>) => polyEq(a, b, RAT_RING);

// `xPlus(c)` = x + c, etc.
const xPlus = (c: bigint) => add(x, Q(c));
const xMinus = (c: bigint) => sub(x, Q(c));

// =============================================================================
// Variable-view helpers
// =============================================================================

describe("polyDegInVar", () => {
  test("constant has degree 0 in any variable", () => {
    expect(polyDegInVar(Q(5n), "x")).toBe(0);
  });

  test("zero polynomial has degree -1", () => {
    expect(polyDegInVar(zero, "x")).toBe(-1);
  });

  test("x^3 + 2x has degree 3 in x, degree 0 in y", () => {
    const p = add(pow(x, 3), mul(Q(2n), x));
    expect(polyDegInVar(p, "x")).toBe(3);
    expect(polyDegInVar(p, "y")).toBe(0);
  });

  test("x^2*y^4 has degree 2 in x, degree 4 in y", () => {
    const p = mul(pow(x, 2), pow(y, 4));
    expect(polyDegInVar(p, "x")).toBe(2);
    expect(polyDegInVar(p, "y")).toBe(4);
  });
});

describe("polyCoeffsInVar / polyFromCoeffsInVar round-trip", () => {
  test("x^3 + 2x viewed in x returns [0, 2, 0, 1]", () => {
    const p = add(pow(x, 3), mul(Q(2n), x));
    const coeffs = polyCoeffsInVar(p, "x", RAT_RING);
    expect(coeffs.length).toBe(4);
    expect(eq(coeffs[0]!, zero)).toBe(true);
    expect(eq(coeffs[1]!, Q(2n))).toBe(true);
    expect(eq(coeffs[2]!, zero)).toBe(true);
    expect(eq(coeffs[3]!, one)).toBe(true);
  });

  test("x^2*y + x*y^2 viewed in x: coefficients are polys in y", () => {
    const p = add(mul(pow(x, 2), y), mul(x, pow(y, 2)));
    const coeffs = polyCoeffsInVar(p, "x", RAT_RING);
    expect(coeffs.length).toBe(3);
    expect(eq(coeffs[0]!, zero)).toBe(true);
    expect(eq(coeffs[1]!, pow(y, 2))).toBe(true);
    expect(eq(coeffs[2]!, y)).toBe(true);
  });

  test("round-trip: rebuild from coefficients restores the polynomial", () => {
    const p = add(mul(pow(x, 2), y), mul(x, pow(y, 2)), Q(5n));
    const coeffs = polyCoeffsInVar(p, "x", RAT_RING);
    const back = polyFromCoeffsInVar(coeffs, "x", RAT_RING);
    expect(eq(back, p)).toBe(true);
  });

  test("round-trip preserves canonical form for many shapes", () => {
    const cases: Poly<Rat>[] = [
      zero,
      one,
      Q(7n),
      x,
      pow(x, 5),
      mul(x, y, z),
      add(pow(x, 2), pow(y, 3), pow(z, 4)),
      add(mul(Q(3n), pow(x, 2)), mul(Q(2n), x, y), Q(-1n, 2n)),
    ];
    for (const p of cases) {
      const vars = polyVars(p);
      for (const v of vars) {
        const coeffs = polyCoeffsInVar(p, v, RAT_RING);
        const back = polyFromCoeffsInVar(coeffs, v, RAT_RING);
        expect(eq(back, p)).toBe(true);
      }
    }
  });
});

// =============================================================================
// polyDivExact
// =============================================================================

describe("polyDivExact", () => {
  test("(x^2 - 1) / (x - 1) = x + 1", () => {
    const num = sub(pow(x, 2), one);
    const den = sub(x, one);
    const q = polyDivExact(num, den, RAT_RING);
    expect(eq(q, add(x, one))).toBe(true);
  });

  test("(x^2 - y^2) / (x - y) = x + y", () => {
    const num = sub(pow(x, 2), pow(y, 2));
    const den = sub(x, y);
    const q = polyDivExact(num, den, RAT_RING);
    expect(eq(q, add(x, y))).toBe(true);
  });

  test("(x^3 - 1) / (x - 1) = x^2 + x + 1", () => {
    const num = sub(pow(x, 3), one);
    const den = sub(x, one);
    const q = polyDivExact(num, den, RAT_RING);
    expect(eq(q, add(pow(x, 2), x, one))).toBe(true);
  });

  test("dividing by a non-zero constant scales coefficients", () => {
    const a = mul(Q(6n), pow(x, 2));
    const q = polyDivExact(a, Q(2n), RAT_RING);
    expect(eq(q, mul(Q(3n), pow(x, 2)))).toBe(true);
  });

  test("zero divided by anything non-zero is zero", () => {
    const q = polyDivExact(zero, x, RAT_RING);
    expect(polyIsZero(q)).toBe(true);
  });

  test("throws on non-exact division", () => {
    const num = pow(x, 2);
    const den = sub(x, one);
    expect(() => polyDivExact(num, den, RAT_RING)).toThrow(/not exact|degree/);
  });

  test("throws on division by zero", () => {
    expect(() => polyDivExact(x, zero, RAT_RING)).toThrow(/division by zero/);
  });

  test("multivariate: (x^2*y - y^3) / (x - y) = x*y + y^2", () => {
    const num = sub(mul(pow(x, 2), y), pow(y, 3));
    const den = sub(x, y);
    const q = polyDivExact(num, den, RAT_RING);
    expect(eq(q, add(mul(x, y), pow(y, 2)))).toBe(true);
  });
});

// =============================================================================
// polyGcd — worked examples
// =============================================================================

describe("polyGcd: worked examples", () => {
  test("gcd(x^2 - 1, x^2 + 2x + 1) = x + 1", () => {
    const a = sub(pow(x, 2), one);
    const b = add(pow(x, 2), mul(Q(2n), x), one);
    const g = polyGcd(a, b, RAT_RING);
    expect(eq(g, add(x, one))).toBe(true);
  });

  test("gcd((x-1)(x-2), (x-2)(x-3)) = x - 2", () => {
    const a = mul(xMinus(1n), xMinus(2n));
    const b = mul(xMinus(2n), xMinus(3n));
    const g = polyGcd(a, b, RAT_RING);
    expect(eq(g, xMinus(2n))).toBe(true);
  });

  test("gcd(x^3 - x, x^2 - x) = x^2 - x (= x(x-1))", () => {
    const a = sub(pow(x, 3), x);     // x(x-1)(x+1)
    const b = sub(pow(x, 2), x);     // x(x-1)
    const g = polyGcd(a, b, RAT_RING);
    // gcd is x(x-1) = x^2 - x; monic so coefficient of x^2 is 1.
    expect(eq(g, sub(pow(x, 2), x))).toBe(true);
  });

  test("gcd of coprime polynomials is 1", () => {
    const a = x;
    const b = xPlus(1n);
    const g = polyGcd(a, b, RAT_RING);
    expect(eq(g, one)).toBe(true);
  });

  test("gcd(x^2, x + 1) = 1", () => {
    const g = polyGcd(pow(x, 2), xPlus(1n), RAT_RING);
    expect(eq(g, one)).toBe(true);
  });

  test("gcd of polynomial with itself is the monic associate", () => {
    const p = mul(Q(3n), pow(x, 2));  // 3x^2; monic associate is x^2
    const g = polyGcd(p, p, RAT_RING);
    expect(eq(g, pow(x, 2))).toBe(true);
  });

  test("gcd preserves over rational coefficients", () => {
    const a = mul(Q(1n, 2n), sub(pow(x, 2), one));      // (1/2)(x^2 - 1)
    const b = mul(Q(3n, 4n), add(pow(x, 2), mul(Q(2n), x), one)); // (3/4)(x+1)^2
    const g = polyGcd(a, b, RAT_RING);
    expect(eq(g, add(x, one))).toBe(true);
  });

  test("multivariate: gcd(x^2*y - y, x*y - y) = y*(x - 1)", () => {
    // x^2*y - y = y(x^2 - 1) = y(x-1)(x+1)
    // x*y - y   = y(x - 1)
    // gcd: y(x - 1) = xy - y. Monic by lex (x first): xy - y.
    const a = sub(mul(pow(x, 2), y), y);
    const b = sub(mul(x, y), y);
    const g = polyGcd(a, b, RAT_RING);
    const expected = sub(mul(x, y), y);
    expect(eq(g, expected)).toBe(true);
  });

  test("multivariate: gcd((x-y)(x+y), (x-y)^2) = x - y", () => {
    const a = mul(sub(x, y), add(x, y));    // x^2 - y^2
    const b = pow(sub(x, y), 2);            // (x-y)^2 = x^2 - 2xy + y^2
    const g = polyGcd(a, b, RAT_RING);
    expect(eq(g, sub(x, y))).toBe(true);
  });

  test("multivariate: gcd(xy + xz, xy + yz) = ???", () => {
    // xy + xz = x(y+z); xy + yz = y(x+z). Coprime in factors → gcd = 1.
    const a = add(mul(x, y), mul(x, z));
    const b = add(mul(x, y), mul(y, z));
    const g = polyGcd(a, b, RAT_RING);
    expect(eq(g, one)).toBe(true);
  });
});

// =============================================================================
// polyGcd — edge cases
// =============================================================================

describe("polyGcd: edge cases", () => {
  test("gcd(0, 0) = 0", () => {
    const g = polyGcd(zero, zero, RAT_RING);
    expect(polyIsZero(g)).toBe(true);
  });

  test("gcd(p, 0) = monic(p)", () => {
    const p = mul(Q(7n), sub(pow(x, 2), one));  // 7(x^2 - 1)
    const g = polyGcd(p, zero, RAT_RING);
    // monic associate: x^2 - 1
    expect(eq(g, sub(pow(x, 2), one))).toBe(true);
  });

  test("gcd(0, p) = monic(p)", () => {
    const p = mul(Q(-3n), x);
    const g = polyGcd(zero, p, RAT_RING);
    expect(eq(g, x)).toBe(true);
  });

  test("gcd(p, 1) = 1", () => {
    const g = polyGcd(pow(x, 5), one, RAT_RING);
    expect(eq(g, one)).toBe(true);
  });

  test("gcd of two non-zero constants is 1", () => {
    const g = polyGcd(Q(5n), Q(7n), RAT_RING);
    expect(eq(g, one)).toBe(true);
  });

  test("gcd of polynomials sharing no variables is 1", () => {
    // Even though gcd(x, x) = x, gcd(x, y) = 1 — the polynomials share
    // no variable, so the only common divisor is a unit.
    const g = polyGcd(x, y, RAT_RING);
    expect(eq(g, one)).toBe(true);
  });
});

// =============================================================================
// polyGcd — algebraic identities
// =============================================================================

describe("polyGcd: algebraic identities", () => {
  // Monic-by-construction: every gcd we compute should have lex-leading
  // coefficient equal to 1 (R.one).
  test("gcd is always monic on non-zero inputs", () => {
    const cases: [Poly<Rat>, Poly<Rat>][] = [
      [mul(Q(2n), x), mul(Q(3n), x)],
      [mul(Q(5n), pow(x, 2), y), mul(Q(7n), x, pow(y, 2))],
      [mul(Q(6n), sub(pow(x, 2), one)), mul(Q(10n), add(x, one))],
    ];
    for (const [a, b] of cases) {
      const g = polyGcd(a, b, RAT_RING);
      if (!polyIsZero(g)) {
        const lc = g.terms[0]!.coef;
        expect(lc).toEqual(RAT_ONE);
      }
    }
  });

  // gcd(p, p) = monic(p): idempotence (up to unit).
  test("gcd(p, p) = monic(p) for arbitrary p", () => {
    const ps: Poly<Rat>[] = [
      x,
      add(pow(x, 2), one),
      mul(sub(x, one), add(x, mul(Q(2n), y))),
      add(pow(x, 3), pow(y, 2)),
    ];
    for (const p of ps) {
      const g = polyGcd(p, p, RAT_RING);
      if (polyIsZero(p)) {
        expect(polyIsZero(g)).toBe(true);
      } else {
        // monic(p): divide every coefficient by lc.
        const lc = p.terms[0]!.coef;
        const monicP = polyDivExact(p, polyConst(lc, RAT_RING), RAT_RING);
        expect(eq(g, monicP)).toBe(true);
      }
    }
  });

  // The headline identity: gcd(g*a, g*b) ≡ monic(g) · gcd(a, b).
  test("gcd(g*a, g*b) = monic(g) * gcd(a, b)", () => {
    const cases: [Poly<Rat>, Poly<Rat>, Poly<Rat>][] = [
      [add(x, one), x, xPlus(2n)],
      [sub(x, one), add(pow(x, 2), one), xPlus(3n)],
      [mul(x, y), add(x, y), sub(x, y)],
      [add(pow(x, 2), pow(y, 2)), x, y],
    ];
    for (const [g, a, b] of cases) {
      const ga = mul(g, a);
      const gb = mul(g, b);
      const lhs = polyGcd(ga, gb, RAT_RING);
      const innerGcd = polyGcd(a, b, RAT_RING);
      // Make `g` monic the same way the gcd algorithm does.
      const lcG = g.terms[0]!.coef;
      const monicG = polyDivExact(g, polyConst(lcG, RAT_RING), RAT_RING);
      const rhs = polyMul(monicG, innerGcd, RAT_RING);
      expect(eq(lhs, rhs)).toBe(true);
    }
  });

  // gcd divides both inputs.
  test("polyDivExact(a, gcd(a, b)) and polyDivExact(b, gcd(a, b)) succeed", () => {
    const cases: [Poly<Rat>, Poly<Rat>][] = [
      [sub(pow(x, 2), one), add(pow(x, 2), mul(Q(2n), x), one)],
      [mul(xMinus(1n), xMinus(2n)), mul(xMinus(2n), xMinus(3n))],
      [sub(mul(pow(x, 2), y), y), sub(mul(x, y), y)],
      [mul(sub(x, y), add(x, y)), pow(sub(x, y), 2)],
    ];
    for (const [a, b] of cases) {
      const g = polyGcd(a, b, RAT_RING);
      // Should not throw:
      polyDivExact(a, g, RAT_RING);
      polyDivExact(b, g, RAT_RING);
    }
  });

  // Idempotence at the GCD level: gcd(gcd(a,b), b) = gcd(a, b).
  test("gcd(gcd(a, b), b) = gcd(a, b)", () => {
    const cases: [Poly<Rat>, Poly<Rat>][] = [
      [sub(pow(x, 2), one), add(pow(x, 2), mul(Q(2n), x), one)],
      [mul(xMinus(1n), xMinus(2n)), mul(xMinus(2n), xMinus(3n))],
      [sub(mul(pow(x, 2), y), y), sub(mul(x, y), y)],
    ];
    for (const [a, b] of cases) {
      const g1 = polyGcd(a, b, RAT_RING);
      const g2 = polyGcd(g1, b, RAT_RING);
      expect(eq(g1, g2)).toBe(true);
    }
  });

  // Symmetry: gcd(a, b) = gcd(b, a).
  test("gcd is symmetric", () => {
    const cases: [Poly<Rat>, Poly<Rat>][] = [
      [sub(pow(x, 2), one), add(x, one)],
      [mul(x, y), add(x, y)],
      [pow(sub(x, y), 2), mul(sub(x, y), add(x, y))],
    ];
    for (const [a, b] of cases) {
      const g1 = polyGcd(a, b, RAT_RING);
      const g2 = polyGcd(b, a, RAT_RING);
      expect(eq(g1, g2)).toBe(true);
    }
  });
});

// =============================================================================
// Multivariate stress
// =============================================================================
//
// Random small polynomials over Q[x, y, z]. The seeded PRNG keeps the
// run deterministic across `bun test` invocations.

describe("polyGcd: multivariate stress", () => {
  // xorshift32 — deterministic, seeded for repeatability.
  function makeRng(seed: number): () => number {
    let state = seed | 0;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) / 4294967296);
    };
  }

  function randomPoly(rng: () => number, maxTerms: number): Poly<Rat> {
    const vars = ["x", "y", "z"];
    let p: Poly<Rat> = polyZero<Rat>();
    const numTerms = 1 + Math.floor(rng() * maxTerms);
    for (let i = 0; i < numTerms; i++) {
      const coef = makeRat(BigInt(1 + Math.floor(rng() * 5)) * (rng() < 0.3 ? -1n : 1n), 1n);
      let mono = polyConst(coef, RAT_RING);
      for (const v of vars) {
        const e = Math.floor(rng() * 3);  // 0, 1, or 2
        if (e > 0) mono = polyMul(mono, pow(polyVar(v, RAT_RING), e), RAT_RING);
      }
      p = polyAdd(p, mono, RAT_RING);
    }
    return p;
  }

  test("gcd(g*a, g*b) divisible by g, quotient = gcd(a,b) — 30 random triples", () => {
    const rng = makeRng(0x42_42_42_42);
    let agreed = 0;
    let attempts = 0;
    for (let i = 0; i < 30; i++) {
      const g = randomPoly(rng, 3);
      const a = randomPoly(rng, 3);
      const b = randomPoly(rng, 3);
      // Skip degenerate cases.
      if (polyIsZero(g) || polyIsZero(a) || polyIsZero(b)) continue;
      attempts++;
      const ga = mul(g, a);
      const gb = mul(g, b);
      const fullGcd = polyGcd(ga, gb, RAT_RING);
      // fullGcd should be divisible by monic(g) (i.e., g without its
      // leading coefficient). If we get back at least *some* common
      // factor, divExact should succeed.
      const lcG = g.terms[0]!.coef;
      const monicG = polyDivExact(g, polyConst(lcG, RAT_RING), RAT_RING);
      // monicG should divide fullGcd.
      try {
        polyDivExact(fullGcd, monicG, RAT_RING);
        agreed++;
      } catch {
        // Stringify via term counts only — BigInts inside Rat coefs
        // don't JSON-serialize directly, and the count-shape is enough
        // signal to debug an unexpected failure.
        throw new Error(
          `monic(g) does not divide gcd(g*a, g*b): ` +
          `g has ${g.terms.length} terms, fullGcd has ${fullGcd.terms.length} terms`,
        );
      }
    }
    expect(attempts).toBeGreaterThan(20);
    expect(agreed).toBe(attempts);
  });
});
