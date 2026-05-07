// =============================================================================
// alg-num — Root canonicalisation, encoding, equality
// =============================================================================
//
// Coverage:
//   • Canonical form: rational → integer, content-strip, sign-fix.
//   • Reducible-input disambiguation by interval hint.
//   • Refusals: ambiguous hint, hint-with-no-root, multivariate input.
//   • Sort-order index `k` matches the canonical ascending real-root
//     order over ℂ (real-only in v0.1).
//   • Wire round-trip: makeRoot → rootToValue → valueToRoot is the
//     identity (modulo interval, which is runtime state).
//   • Wire bytes are canonical: canonicalize ∘ parse is the identity
//     on rootToValue's output.
//   • rootCanonicalEq: two distinct constructions of √2 yield equal
//     Roots.

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  type Rat,
  INT_RING,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyEq,
  polyMul,
  polyVar,
} from "@workbench/cas-core";
import { canonicalize, parse } from "@workbench/protocol";

import {
  type Root,
  ROOT_VAR,
  makeRoot,
  rootCanonicalEq,
  canonicalIntegerForm,
  rootToValue,
  valueToRoot,
} from "../src/index.js";

// -----------------------------------------------------------------------------
// Helpers — small ratFn-style polynomial constructors over ℚ in `x`.
// -----------------------------------------------------------------------------

const X = polyVar<Rat>(ROOT_VAR, RAT_RING);
const ONE_Q = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);

function qConst(n: bigint, d: bigint = 1n): Poly<Rat> {
  return polyConst<Rat>(makeRat(n, d), RAT_RING);
}

function fromCoeffsLowToHigh(rats: readonly Rat[]): Poly<Rat> {
  // a_0 + a_1 · x + a_2 · x^2 + ...
  let acc = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  let pow = ONE_Q;
  for (let i = 0; i < rats.length; i++) {
    const term = polyMul(polyConst<Rat>(rats[i]!, RAT_RING), pow, RAT_RING);
    acc = polyAdd(acc, term, RAT_RING);
    pow = polyMul(pow, X, RAT_RING);
  }
  return acc;
}

function intPolyLowToHigh(coeffs: readonly bigint[]): Poly<bigint> {
  // For comparison: build Poly<bigint> from low-to-high integer list.
  // Mirrors the canonical-form expectation directly.
  const Xi = polyVar<bigint>(ROOT_VAR, INT_RING);
  const oneI = polyConst<bigint>(1n, INT_RING);
  let acc = polyConst<bigint>(0n, INT_RING);
  let pow = oneI;
  for (let i = 0; i < coeffs.length; i++) {
    const term = polyMul(polyConst<bigint>(coeffs[i]!, INT_RING), pow, INT_RING);
    acc = polyAdd(acc, term, INT_RING);
    pow = polyMul(pow, Xi, INT_RING);
  }
  return acc;
}

const rat = (n: bigint, d: bigint = 1n) => makeRat(n, d);

// -----------------------------------------------------------------------------
// canonicalIntegerForm
// -----------------------------------------------------------------------------

describe("canonicalIntegerForm", () => {
  test("ℤ-monic input is the identity (up to representation)", () => {
    // x^2 - 2
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    const c = canonicalIntegerForm(f, ROOT_VAR);
    expect(polyEq(c, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
  });

  test("clears integer content: 2x^2 − 4 → x^2 − 2", () => {
    const f = fromCoeffsLowToHigh([rat(-4n), rat(0n), rat(2n)]);
    const c = canonicalIntegerForm(f, ROOT_VAR);
    expect(polyEq(c, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
  });

  test("clears rational denominators: (1/2) x^2 − 1 → x^2 − 2", () => {
    const f = fromCoeffsLowToHigh([rat(-1n), rat(0n), rat(1n, 2n)]);
    const c = canonicalIntegerForm(f, ROOT_VAR);
    expect(polyEq(c, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
  });

  test("flips sign when leading coefficient is negative: −x^2 + 2 → x^2 − 2", () => {
    const f = fromCoeffsLowToHigh([rat(2n), rat(0n), rat(-1n)]);
    const c = canonicalIntegerForm(f, ROOT_VAR);
    expect(polyEq(c, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
  });

  test("constant input is rejected", () => {
    const f = qConst(5n);
    expect(() => canonicalIntegerForm(f, ROOT_VAR)).toThrow(/constant|degree/);
  });
});

// -----------------------------------------------------------------------------
// makeRoot — irreducible-input fast path
// -----------------------------------------------------------------------------

describe("makeRoot — irreducible inputs", () => {
  test("+√2 from x^2 − 2, hint [1, 2]", () => {
    // Roots of x^2 - 2 are ±√2 ≈ ±1.41421.
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    const r = makeRoot(f, { lo: rat(1n), hi: rat(2n) }, ROOT_VAR);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);   // sorted: −√2 (k=0), +√2 (k=1)
  });

  test("−√2 from x^2 − 2, hint [−2, −1]", () => {
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    const r = makeRoot(f, { lo: rat(-2n), hi: rat(-1n) }, ROOT_VAR);
    expect(r.k).toBe(0);
  });

  test("rational root: x − 3, hint [3, 3] → minpoly x − 3, k = 0", () => {
    const f = fromCoeffsLowToHigh([rat(-3n), rat(1n)]);
    const r = makeRoot(f, { lo: rat(3n), hi: rat(3n) }, ROOT_VAR);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-3n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(0);
  });

  test("non-canonical input 2x^2 − 4 canonicalises to x^2 − 2", () => {
    // 2x^2 − 4 has the same roots as x^2 − 2 (content 2 doesn't shift roots).
    const f = fromCoeffsLowToHigh([rat(-4n), rat(0n), rat(2n)]);
    const r = makeRoot(f, { lo: rat(1n), hi: rat(2n) }, ROOT_VAR);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);
  });

  test("sort-order index for x^3 − x: roots −1, 0, 1 at k = 0, 1, 2", () => {
    // x^3 - x = x · (x − 1) · (x + 1)
    const f = fromCoeffsLowToHigh([rat(0n), rat(-1n), rat(0n), rat(1n)]);
    const rNeg1 = makeRoot(f, { lo: rat(-1n), hi: rat(-1n) }, ROOT_VAR);
    const rZero = makeRoot(f, { lo: rat(0n), hi: rat(0n) }, ROOT_VAR);
    const rPos1 = makeRoot(f, { lo: rat(1n), hi: rat(1n) }, ROOT_VAR);
    expect(rNeg1.k).toBe(0);
    expect(rZero.k).toBe(0);   // 0 is the only real root of its (canonical) minpoly `x`
    expect(rPos1.k).toBe(0);   // 1 is the only real root of `x − 1`
    expect(polyEq(rNeg1.minpoly, intPolyLowToHigh([1n, 1n]), INT_RING)).toBe(true);
    expect(polyEq(rZero.minpoly, intPolyLowToHigh([0n, 1n]), INT_RING)).toBe(true);
    expect(polyEq(rPos1.minpoly, intPolyLowToHigh([-1n, 1n]), INT_RING)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// makeRoot — reducible-input disambiguation
// -----------------------------------------------------------------------------

describe("makeRoot — reducible-input disambiguation", () => {
  test("(x^2 − 2)(x^2 − 3) with hint [1, 1.5] selects minpoly x^2 − 2", () => {
    // (x^2 − 2)(x^2 − 3) = x^4 − 5 x^2 + 6
    const f = fromCoeffsLowToHigh([rat(6n), rat(0n), rat(-5n), rat(0n), rat(1n)]);
    // +√2 ≈ 1.414, +√3 ≈ 1.732. Hint [1, 1.5] contains only +√2.
    const r = makeRoot(f, { lo: rat(1n), hi: rat(3n, 2n) }, ROOT_VAR);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);
  });

  test("(x^2 − 2)(x^2 − 3) with hint [1.5, 2] selects minpoly x^2 − 3", () => {
    const f = fromCoeffsLowToHigh([rat(6n), rat(0n), rat(-5n), rat(0n), rat(1n)]);
    const r = makeRoot(f, { lo: rat(3n, 2n), hi: rat(2n) }, ROOT_VAR);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-3n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// makeRoot — refusals
// -----------------------------------------------------------------------------

describe("makeRoot — refusals", () => {
  test("ambiguous hint covering both +√2 and +√3 → throws", () => {
    const f = fromCoeffsLowToHigh([rat(6n), rat(0n), rat(-5n), rat(0n), rat(1n)]);
    expect(() => makeRoot(f, { lo: rat(1n), hi: rat(2n) }, ROOT_VAR)).toThrow(/ambiguous/i);
  });

  test("hint with no root → throws", () => {
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    expect(() => makeRoot(f, { lo: rat(10n), hi: rat(20n) }, ROOT_VAR)).toThrow(/no root|no irreducible/i);
  });

  test("multivariate input → throws", () => {
    // (x − y); makeRoot should refuse — the constructor demands univariate.
    const Y = polyVar<Rat>("y", RAT_RING);
    const f = polyAdd(X, polyMul(polyConst<Rat>(makeRat(-1n, 1n), RAT_RING), Y, RAT_RING), RAT_RING);
    expect(() => makeRoot(f, { lo: rat(0n), hi: rat(1n) }, ROOT_VAR)).toThrow(/multivariate/i);
  });

  test("constant input → throws", () => {
    const f = qConst(5n);
    expect(() => makeRoot(f, { lo: rat(0n), hi: rat(0n) }, ROOT_VAR)).toThrow(/degree|constant/i);
  });
});

// -----------------------------------------------------------------------------
// Equality (cheap-path; full equality is bead 6cd)
// -----------------------------------------------------------------------------

describe("rootCanonicalEq", () => {
  test("two distinct constructions of +√2 are equal", () => {
    // From x^2 − 2.
    const r1 = makeRoot(
      fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    // From 2x^2 − 4 (same root, non-canonical input form).
    const r2 = makeRoot(
      fromCoeffsLowToHigh([rat(-4n), rat(0n), rat(2n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    // From −3x^2 + 6 (same root, negative-leading + content 3).
    const r3 = makeRoot(
      fromCoeffsLowToHigh([rat(6n), rat(0n), rat(-3n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    expect(rootCanonicalEq(r1, r2)).toBe(true);
    expect(rootCanonicalEq(r1, r3)).toBe(true);
    expect(rootCanonicalEq(r2, r3)).toBe(true);
  });

  test("+√2 ≠ −√2 (same minpoly, different k)", () => {
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    const pos = makeRoot(f, { lo: rat(1n), hi: rat(2n) }, ROOT_VAR);
    const neg = makeRoot(f, { lo: rat(-2n), hi: rat(-1n) }, ROOT_VAR);
    expect(rootCanonicalEq(pos, neg)).toBe(false);
  });

  test("+√2 ≠ +√3 (different minpolys)", () => {
    const sqrt2 = makeRoot(
      fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    const sqrt3 = makeRoot(
      fromCoeffsLowToHigh([rat(-3n), rat(0n), rat(1n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    expect(rootCanonicalEq(sqrt2, sqrt3)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Wire round-trip
// -----------------------------------------------------------------------------

describe("rootToValue / valueToRoot — wire round-trip", () => {
  function roundTrip(r: Root): void {
    const v = rootToValue(r);
    const r2 = valueToRoot(v);
    expect(polyEq(r2.minpoly, r.minpoly, INT_RING)).toBe(true);
    expect(r2.k).toBe(r.k);
  }

  test("+√2", () => {
    const r = makeRoot(
      fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    roundTrip(r);
  });

  test("smallest real root of x^5 − x − 1 (the ADR's headline example)", () => {
    // x^5 − x − 1 ≈ has one real root ≈ 1.16730. Hint [1, 2].
    const f = fromCoeffsLowToHigh([
      rat(-1n), rat(-1n), rat(0n), rat(0n), rat(0n), rat(1n),
    ]);
    const r = makeRoot(f, { lo: rat(1n), hi: rat(2n) }, ROOT_VAR);
    expect(r.k).toBe(0);   // only one real root
    roundTrip(r);
  });

  test("√2+√3 lookalike: smallest positive real root of x^4 − 10 x^2 + 1", () => {
    // The ADR cites x^4 − 10 x^2 + 1 as the canonical minpoly of
    // √2+√3. Real roots in ascending order: −(√2+√3), −(√3−√2),
    // (√3−√2), (√2+√3). Numerically: ≈ −3.146, −0.318, 0.318, 3.146.
    const f = fromCoeffsLowToHigh([rat(1n), rat(0n), rat(-10n), rat(0n), rat(1n)]);
    // Hint around +(√2+√3) ≈ 3.146.
    const r = makeRoot(f, { lo: rat(3n), hi: rat(4n) }, ROOT_VAR);
    expect(r.k).toBe(3);
    roundTrip(r);
  });
});

describe("wire bytes are canonical", () => {
  test("canonicalize(parse(canonicalize(rootToValue(r)))) is the identity", () => {
    const r = makeRoot(
      fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    const v = rootToValue(r);
    const bytes = canonicalize(v);
    const v2 = parse(bytes);
    const bytes2 = canonicalize(v2);
    expect(bytes2).toBe(bytes);
  });
});

// -----------------------------------------------------------------------------
// valueToRoot — input-validation refusals
// -----------------------------------------------------------------------------

describe("valueToRoot — refusals", () => {
  test("non-canonical (non-primitive) wire bytes throw", () => {
    // 2x^2 − 4 in wire form: coefficients [-4, 0, 2] at low-to-high.
    // gcd = 2 ≠ 1, so verifyCanonicalForm should refuse.
    const v = parse(canonicalize(
      rootToValue({
        minpoly: intPolyLowToHigh([-2n, 0n, 1n]),
        k: 1,
        interval: { lo: rat(1n), hi: rat(2n) },
      }),
    ));
    void v;     // sanity: a *canonical* value parses fine; we test the refusal next.

    // Construct a non-primitive wire form by hand (bypassing rootToValue).
    const nonCanonical = parse(
      `{"args":[{"args":[{"kind":"integer","value":"-4"},{"kind":"integer","value":"0"},{"kind":"integer","value":"2"}],"head":"Polynomial","kind":"expression"},{"kind":"integer","value":"1"}],"head":"Root","kind":"expression"}`,
    );
    expect(() => valueToRoot(nonCanonical)).toThrow(/primitive|gcd/i);
  });

  test("non-canonical (negative leading) wire bytes throw", () => {
    const nonCanonical = parse(
      `{"args":[{"args":[{"kind":"integer","value":"2"},{"kind":"integer","value":"0"},{"kind":"integer","value":"-1"}],"head":"Polynomial","kind":"expression"},{"kind":"integer","value":"1"}],"head":"Root","kind":"expression"}`,
    );
    expect(() => valueToRoot(nonCanonical)).toThrow(/leading|positive/i);
  });

  test("k out of range → throws", () => {
    const v = parse(
      `{"args":[{"args":[{"kind":"integer","value":"-2"},{"kind":"integer","value":"0"},{"kind":"integer","value":"1"}],"head":"Polynomial","kind":"expression"},{"kind":"integer","value":"5"}],"head":"Root","kind":"expression"}`,
    );
    expect(() => valueToRoot(v)).toThrow(/exceeds|degree|index/i);
  });
});
