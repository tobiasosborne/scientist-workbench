// =============================================================================
// fp — finite prime field 𝔽_p and the integer ring ℤ as Ring/Field instances
// =============================================================================
//
// What this module exposes
// ------------------------
//   • `INT_RING : Ring<bigint>`         — ℤ, the integer ring. Every
//     polynomial with integer coefficients (Hensel intermediate state,
//     Mignotte-bound checks, mod-p reductions, factor reconstruction)
//     uses `Poly<bigint>` over `INT_RING`.
//   • `fpField(p) : Field<bigint>`      — 𝔽_p, the field of integers
//     mod prime `p`, in canonical residues `[0, p)`. Field operations
//     for polynomial GCD over `𝔽_p[x]` (the Berlekamp factorisation
//     stage and the Hensel Bezout-coefficient stage).
//   • `polyTrunc(f, m) : Poly<bigint>`  — coefficient-wise reduction
//     of a `Poly<bigint>` modulo `m`, with canonical residues in
//     `[0, m)`. Used between Hensel lift steps so coefficients stay
//     bounded.
//
// Why these instances live in cas-core
// ------------------------------------
// Following the precedent set by `RAT_RING` (in `rat.ts`) and
// `algebraicRing` (in `algebraic.ts`): every coefficient ring that the
// generic `Poly<T>` / `polyGcd` / `polyDivExact` machinery is designed
// to consume is a Ring/Field dictionary, and dictionaries live with
// their element type. `bigint` is native to TS, so there is no element
// type to author — the ring instance lives here.
//
// Integer-ring is a `Ring`, not a `Field`. ℤ has units only at ±1, so
// `inv` is undefined for everything else. Algorithms that need
// division (polynomial GCD via subresultant PRS, ratFn arithmetic) do
// not consume `INT_RING`; they consume `RAT_RING` (or some other
// `Field<T>`). Algorithms that need only ring operations (polynomial
// addition, multiplication, derivative, monic long division) accept
// `INT_RING` happily.
//
// `fpField(p)` does NOT verify primality. The caller is responsible
// for passing a prime; the ring trusts it for `inv` (which calls
// `modInv` and throws if the gcd is not 1). Algorithms reaching for
// `fpField` (Berlekamp, Hensel) pre-select a prime that does not
// divide either `lc(f)` or the discriminant of `f`, so primality of
// the user-supplied `p` is the wrong question to litigate at the ring
// boundary; an off-prime `p` would produce a wrong factorisation
// before any `inv` call ever fired.
//
// The `polyTrunc` helper: every Hensel iteration multiplies polynomials
// in `ℤ[x]` and then reduces the result mod `p^{2m}`. Doing so via
// `INT_RING + polyAdd / polyMul` keeps coefficients exact during the
// inner loop; `polyTrunc` is the explicit reduction step at iteration
// boundaries. Canonical [0, m) residues are chosen over balanced
// (-m/2, m/2] residues for two reasons: (1) they are unique on the
// nose with no sign-of-zero corner, (2) the Mignotte-bound argument
// needed at recombination time will need to switch to balanced
// representation only at the very end of factor lifting, so doing
// the switch in one place rather than maintaining it throughout
// keeps the substrate simpler.

import { modInv } from "@workbench/mod-core";
import { type Poly } from "./poly.js";
import { type Field, type Ring } from "./ring.js";

// -----------------------------------------------------------------------------
// INT_RING — the integers as Ring<bigint>
// -----------------------------------------------------------------------------

export const INT_RING: Ring<bigint> = {
  zero: 0n,
  one: 1n,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  neg: (a) => -a,
  eq: (a, b) => a === b,
  isZero: (a) => a === 0n,
  isOne: (a) => a === 1n,
  fromInt: (n) => n,
};

// -----------------------------------------------------------------------------
// fpField — 𝔽_p as Field<bigint>, canonical residues [0, p)
// -----------------------------------------------------------------------------
//
// Every operation lands in [0, p). The constructor caches the
// dictionary per `p`, so repeated calls with the same prime are
// effectively free; this matters for Hensel, which reaches for the
// same `fpField(p)` on every iteration of every factor pair.

const fpFieldCache = new Map<bigint, Field<bigint>>();

export function fpField(p: bigint): Field<bigint> {
  if (p < 2n) throw new RangeError(`fpField: modulus must be ≥ 2 (got ${p})`);
  const cached = fpFieldCache.get(p);
  if (cached) return cached;

  const reduce = (a: bigint): bigint => {
    let r = a % p;
    if (r < 0n) r += p;
    return r;
  };

  const ring: Field<bigint> = {
    zero: 0n,
    one: 1n,
    add: (a, b) => reduce(a + b),
    sub: (a, b) => reduce(a - b),
    mul: (a, b) => reduce(a * b),
    neg: (a) => (a === 0n ? 0n : p - reduce(a)),
    eq: (a, b) => reduce(a) === reduce(b),
    isZero: (a) => reduce(a) === 0n,
    isOne: (a) => reduce(a) === 1n,
    fromInt: (n) => reduce(n),
    inv: (a) => {
      const r = modInv(a, p);
      if (!r.invertible) {
        throw new Error(
          `fpField(${p}).inv: ${a} is not invertible mod ${p} (gcd = ${r.gcd}); is p prime?`,
        );
      }
      return r.inverse!;
    },
    div: (a, b) => {
      const r = modInv(b, p);
      if (!r.invertible) {
        throw new Error(
          `fpField(${p}).div: divisor ${b} is not invertible mod ${p} (gcd = ${r.gcd})`,
        );
      }
      return reduce(a * r.inverse!);
    },
  };

  fpFieldCache.set(p, ring);
  return ring;
}

// -----------------------------------------------------------------------------
// polyTrunc — coefficient-wise reduction mod m
// -----------------------------------------------------------------------------
//
// Canonical residues in [0, m). Zero-coef terms drop. Used by Hensel at
// iteration boundaries to keep coefficients bounded when working in
// ℤ[x]/(m).
//
// Returns a fresh `Poly<bigint>` in canonical form (no trailing zero
// coefs, terms still sorted). The input is not mutated.

export function polyTrunc(f: Poly<bigint>, m: bigint): Poly<bigint> {
  if (m < 1n) throw new RangeError(`polyTrunc: modulus must be ≥ 1 (got ${m})`);
  const out = [];
  for (const t of f.terms) {
    let r = t.coef % m;
    if (r < 0n) r += m;
    if (r !== 0n) out.push({ exp: t.exp, coef: r });
  }
  return { terms: out };
}
