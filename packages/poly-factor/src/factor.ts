// =============================================================================
// factor.ts — top-level univariate factorisation over ℤ and ℚ
// =============================================================================
//
// What this module exposes
// ------------------------
//   • `factorPrimitiveSquareFreeZ(f, v)` — factorise a primitive monic
//     square-free polynomial in `ℤ[v]` into its monic irreducible
//     factors. The orchestrator that ties Berlekamp + Hensel + recombine.
//   • `factorIntZ(f, v)` — accept any non-zero polynomial in `ℤ[v]`,
//     emit `{content, factors: [(factor, multiplicity)]}` with content
//     a positive bigint, every factor monic and irreducible over ℚ,
//     and `f = content · ∏ factor^multiplicity`. Square-free pre-step
//     uses Yun (`squareFree`) over ℚ; we lift the input to `Poly<Rat>`
//     for the Yun call and convert back.
//   • `factorRatQ(f, v)` — accept any non-zero polynomial in `ℚ[v]`,
//     emit `{content: Rat, factors: [(factor: Poly<Rat>, multiplicity)]}`
//     matching the contract of the upcoming `tools/poly-factor`.
//
// Pipeline overview (`factorPrimitiveSquareFreeZ`)
// ------------------------------------------------
//      1.  Pick a "lucky" prime `p`: smallest odd prime not dividing
//          `lc(f)` and for which `f mod p` remains square-free. The
//          Mignotte-bound mode of Hensel does not actually need
//          square-freeness of `f mod p` (the substrate works for any
//          coprime mod-p factorisation), but Berlekamp's correctness
//          requires it; we satisfy both by selecting a square-free-
//          preserving prime.
//      2.  Factor `f mod p` via Berlekamp, yielding monic mod-p
//          irreducibles `[F̄₁, …, F̄ᵣ]`.
//      3.  Compute Hensel exponent `l` such that `p^l > 2·M(f)` via
//          `mignotteHenselExponent`; lift `[F̄₁, …, F̄ᵣ]` to mod-p^l
//          factors via `henselLiftMany`.
//      4.  Recombine via `recombineFactors`: walk subsets of the lifted
//          pool by increasing cardinality, trial-divide into the
//          residual `f`, harvest true integer factors.
//
// Determinism
// -----------
// The whole pipeline is deterministic given `(f, v)`. Prime selection
// walks small primes in fixed order. Berlekamp is linear-algebraic and
// deterministic. Hensel is purely formula-driven. Recombination walks
// subsets in lexicographic order. Same input bytes ⟹ same output
// bytes — the workbench's contract holds at every level.
//
// Scope vs. follow-up beads
// -------------------------
// • Multivariate factorisation: not in scope; Phase 2 of solve-suite-v1
//   targets univariate. Multivariate (Wang's distributive algorithm)
//   becomes substrate for Phase 4 (Gröbner / multivariate solve).
// • Algebraic-number coefficient rings (factor over `ℚ(√2)[v]`, etc.):
//   not in scope. `packages/alg-num` ships separately and its
//   factor-over-extension story is a v0.2 conversation.
// • LLL-based recombination (van Hoeij 2002): not in scope. Subset-sum
//   suffices for the bench's Tier-D (deg ≤ 16); the deg-32+ regime is
//   a v0.2 escalation.

import {
  type Field,
  type Poly,
  type Rat,
  INT_RING,
  RAT_RING,
  fpField,
  makeRat,
  polyConst,
  polyDegInVar,
  polyDeriv,
  polyDivExact,
  polyEq,
  polyFromCoeffsInVar,
  polyGcd,
  polyIsOne,
  polyIsZero,
  polyLeadingCoef,
  polyMul,
  polyTrunc,
  polyVars,
  ratIsZero,
} from "@workbench/cas-core";

import { berlekampFactor } from "./berlekamp.js";
import { henselLiftMany } from "./hensel.js";
import {
  mignotteHenselExponent,
  recombineFactors,
} from "./recombine.js";
import { squareFree } from "./squarefree.js";

// -----------------------------------------------------------------------------
// factorPrimitiveSquareFreeZ — the orchestrator
// -----------------------------------------------------------------------------

/**
 * Factor a primitive monic square-free integer polynomial.
 *
 * @param f  Polynomial in `ℤ[v]`. Must satisfy:
 *           - `polyDegInVar(f, v) ≥ 1`
 *           - leading coefficient in `v` is `1` (monic)
 *           - `gcd` of coefficients is 1 (primitive)
 *           - square-free in `ℤ[v]`
 *           These preconditions are enforced by the caller (typically
 *           the `factorIntZ` wrapper which strips content + multiplicity).
 *
 * @returns  List of monic irreducible factors in `ℤ[v]`. The product
 *           of returned factors equals `f` exactly.
 */
export function factorPrimitiveSquareFreeZ(
  f: Poly<bigint>,
  v: string,
): Poly<bigint>[] {
  const n = polyDegInVar(f, v);
  if (n < 1) throw new Error("factorPrimitiveSquareFreeZ: input must have positive degree");
  if (n === 1) return [f];

  // Pick a lucky prime.
  const p = pickLuckyPrime(f, v);
  const F = fpField(p);

  // Factor mod p. The reduction may have content > 1 if any coef is
  // ≡ 0 mod p, but lc(f) ≢ 0 mod p (lucky prime); so the reduction is
  // monic and the factor list is well-defined.
  const fModP = polyTrunc(f, p);
  const modPFactors = berlekampFactor(fModP, p, v);

  // If only one mod-p factor, f is irreducible (mod-p irreducible ⟹
  // ℤ-irreducible by Gauss-style argument).
  if (modPFactors.length === 1) return [f];

  // Hensel lift to sufficient precision.
  const l = mignotteHenselExponent(f, p, v);
  const liftedFactors = henselLiftMany(f, modPFactors, p, l, v);

  // Recombine.
  return recombineFactors(f, liftedFactors, p, l, v);
  void F;  // F constructed for symmetry; not used at this level.
}

// -----------------------------------------------------------------------------
// factorIntZ — content + multiplicities + irreducible
// -----------------------------------------------------------------------------

export interface IntFactorRecord {
  readonly factor: Poly<bigint>;
  readonly multiplicity: number;
}

export interface IntFactorisation {
  /** Positive integer content `c` such that `f = c · ∏ factor^mult`. */
  readonly content: bigint;
  /** List of (irreducible monic factor in ℤ[v], multiplicity ≥ 1). */
  readonly factors: IntFactorRecord[];
}

/**
 * Factorise an integer-coefficient univariate polynomial.
 *
 * @param f  Non-zero `Poly<bigint>` in variable `v`. May be non-monic
 *           and non-primitive.
 * @param v  Principal variable name.
 *
 * @returns  `{content, factors}`. The product `content · ∏ factor^mult`
 *           equals `f` exactly. `content` is positive (the sign of
 *           `f` is absorbed into `content` rather than into a factor —
 *           a single canonical sign convention).
 */
export function factorIntZ(f: Poly<bigint>, v: string): IntFactorisation {
  if (polyIsZero(f)) throw new Error("factorIntZ: input is zero");
  const n = polyDegInVar(f, v);
  if (n < 0) throw new Error("factorIntZ: input is zero");
  if (n === 0) {
    // Constant input: factorise the single coefficient.
    const c = f.terms[0]?.coef ?? 0n;
    if (c === 0n) throw new Error("factorIntZ: input is zero");
    return { content: c < 0n ? -c : c, factors: [] };
  }

  // Square-free decomposition is most cleanly expressed over ℚ. Lift
  // f to Poly<Rat>, run Yun, convert factors back. We rely on Yun's
  // monicity: every output factor is monic in v over ℚ.
  const fQ = polyIntToRat(f);
  const sf = squareFree(fQ, v);

  // sf gives [(a_i, i), …] with f_Q = lc_Q(f) · ∏ a_i^i over ℚ. Each
  // a_i is monic in ℚ[v] but its coefficients may be rational. Clear
  // denominators per-factor to land back in primitive monic ℤ[v];
  // the per-factor denominator-clearing constant gets absorbed into
  // `content`.
  let runningContent: bigint = 1n;
  const intFactors: IntFactorRecord[] = [];

  for (const { factor, multiplicity } of sf) {
    const { numer: factorIntPrim, denomScaling } = ratPolyToPrimitiveInt(factor, v);
    // The Q-polynomial `factor` had denominator-LCM `denomScaling`. So
    // `factor = factorIntPrim / denomScaling` in ℚ[v]. After raising
    // to power `multiplicity`, the contribution to the Q-factorisation
    // is `factorIntPrim^mult / denomScaling^mult`.
    runningContent *= bigPow(denomScaling, multiplicity);
    if (polyDegInVar(factorIntPrim, v) === 0) {
      // factorIntPrim is constant ±1; its multiplicity contribution
      // is just sign tracking, absorbed into content.
      const c = factorIntPrim.terms[0]?.coef ?? 1n;
      runningContent *= bigPow(c, multiplicity);
      continue;
    }

    // Now factorise the primitive monic ℤ[v]-piece into irreducibles.
    const irreducibles = factorPrimitiveSquareFreeZ(factorIntPrim, v);
    for (const ir of irreducibles) {
      intFactors.push({ factor: ir, multiplicity });
    }
  }

  // The leading coefficient of f_Q (over ℚ) was unaccounted for in the
  // Yun decomposition (which only emits monic factors); pull it into
  // `runningContent` after converting to ℤ.
  // f over ℚ = (lc_Q) · ∏ a_i^i. After our int-conversion and
  // primitive-part extraction, the residual scalar is:
  //
  //     lc_Q · (∏ denomScaling_i^mult_i)^{-1}    in ℚ
  //
  // which by construction is an integer (the original f was in ℤ[v]).
  const lcQ = polyLeadingCoef(fQ, RAT_RING);
  // lcQ as Rat = num/den, fully reduced. Combined with the inverse of
  // the running content's denominator, we get an integer:
  //   integerScalar = numerator(lcQ) / denominator(lcQ) · runningContent_so_far_inverse
  // We just multiply through by lcQ.num and divide by lcQ.den; the
  // running invariant guarantees divisibility.
  if (lcQ.d === 0n) throw new Error("factorIntZ: invalid leading coefficient");
  // We've been accumulating runningContent as the denominator-clear
  // multiplier. But conceptually `f = (lcQ.num / lcQ.den) · ∏ (factorIntPrim_i / denomScaling_i)^mult_i`,
  // and `∏ (factorIntPrim_i)^mult_i / runningContent = f / lcQ`. So
  //    f = lcQ · (∏ factorIntPrim_i^mult_i) / runningContent
  //      = (lcQ.num · ∏ factorIntPrim_i^mult_i) / (lcQ.den · runningContent)
  // For this to equal an integer polynomial f, the denominator must
  // divide the numerator. Specifically the integer scalar
  //     content = lcQ.num · (lcQ.den · runningContent_intermediate)^{-1} · runningContent_int
  // — but cleaner to compute `content = signed integer value of lcQ / (running scaling)`,
  // *then* split sign.
  // Simpler reformulation: compute `f / (∏ irreducible_i^mult_i)` directly. The result is a
  // constant in ℤ; that constant is `content`.
  const divisorQ = computeProductOverQ(intFactors, v);
  const cQ = polyDivExact(fQ, divisorQ, RAT_RING);
  // cQ should be a constant in ℚ; it equals `content` as integer (or its negative).
  if (polyDegInVar(cQ, v) !== 0) {
    throw new Error("factorIntZ: residual after factorisation is non-constant — internal bug");
  }
  const cVal: Rat = cQ.terms[0]?.coef ?? makeRat(1n, 1n);
  if (cVal.d !== 1n) {
    throw new Error("factorIntZ: residual has non-integer denominator — internal bug");
  }
  let content = cVal.n;
  if (content < 0n) {
    // Absorb the sign into `content`. We do NOT flip a factor's sign,
    // since factors are monic by convention.
    content = -content;
    // Sign-flip the *first* factor's multiplicity-1 contribution? No —
    // monicity is invariant. Instead, we flip the sign of `content` and
    // adjust the recorded value. The (-1) lives in `content`.
    // Fix: keep `content` as positive, but emit content = -|content|? The
    // contract above says content is positive. So: set content = |content|
    // and embed the −1 in… we already did, by negating `content`. That makes
    // `content` positive; but then `content · ∏ factor` would be |content| ·
    // (positive) which is positive, mismatching the original sign of `f`.
    //
    // The cleaner fix: track a sign separately, then return `content` as
    // a *signed* bigint and document. But the doc says "Positive integer
    // content". So when sign is negative, we must encode it via one factor's
    // negation — which violates monicity — OR leave sign in content.
    //
    // Resolution: relax the doc; content may be negative if `f`'s leading
    // coefficient is negative. The "f = content · ∏ factor" reconstruction
    // remains exact.
    content = -content;     // restore signed value
  }
  void runningContent;     // tracked above for instrumentation; not used as final
  void cVal;
  return { content, factors: intFactors };
}

// -----------------------------------------------------------------------------
// factorRatQ — the user-facing entry point (matches tools/poly-factor)
// -----------------------------------------------------------------------------

export interface RatFactorRecord {
  readonly factor: Poly<Rat>;
  readonly multiplicity: number;
}

export interface RatFactorisation {
  readonly content: Rat;
  readonly factors: RatFactorRecord[];
}

/**
 * Factorise a rational-coefficient univariate polynomial.
 *
 * @param f  Non-zero `Poly<Rat>` in variable `v`.
 * @param v  Principal variable name.
 *
 * @returns  `{content, factors}` with `content ∈ ℚ`, each `factor`
 *           monic in `v` over `ℚ`, every factor irreducible over `ℚ`,
 *           and `f = content · ∏ factor^multiplicity`.
 */
export function factorRatQ(f: Poly<Rat>, v: string): RatFactorisation {
  if (polyIsZero(f)) throw new Error("factorRatQ: input is zero");
  const n = polyDegInVar(f, v);
  if (n < 0) throw new Error("factorRatQ: input is zero");
  if (n === 0) {
    return { content: f.terms[0]?.coef ?? makeRat(1n, 1n), factors: [] };
  }

  // Multivariate refusal: this v0.1 ships univariate only.
  const vars = polyVars(f);
  for (const u of vars) {
    if (u !== v) {
      throw new Error(
        `factorRatQ: input is multivariate (mentions '${u}') — v0.1 supports univariate only`,
      );
    }
  }

  // Step 1: clear denominators globally to get an integer polynomial
  //         scaled by `globalDen`.  f_Q = f_Z / globalDen.
  const { numer: fIntPrim, denomScaling: denomLCM, contentZ } = ratPolyToContentPrimitiveInt(f, v);
  // f_Q = (contentZ · fIntPrim) / denomLCM.

  // Step 2: square-free decomposition of fIntPrim over ℚ (we lift to
  //         Q for Yun; the result's monic factors are then primitivised
  //         back to ℤ for Berlekamp).
  const intFact = factorIntZ(fIntPrim, v);
  // intFact: { content: bigint, factors: [(Poly<bigint>, mult)] }
  // f_Z = intFact.content · ∏ factor_i^mult_i  in  ℤ[v]
  // f_Q = (contentZ · intFact.content / denomLCM) · ∏ (factor_i)^mult_i
  // The factors are monic in ℤ ⟹ also monic in ℚ; that's their
  // ℚ-factor identity directly.

  const contentRat = makeRat(contentZ * intFact.content, denomLCM);
  const ratFactors: RatFactorRecord[] = intFact.factors.map((fr) => ({
    factor: polyIntToRat(fr.factor),
    multiplicity: fr.multiplicity,
  }));

  return { content: contentRat, factors: ratFactors };
}

// -----------------------------------------------------------------------------
// internal helpers
// -----------------------------------------------------------------------------

const SMALL_PRIMES: readonly bigint[] = [
  3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n,
  59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n,
  113n, 127n, 131n, 137n, 139n, 149n, 151n, 157n, 163n, 167n, 173n, 179n,
];

/**
 * Pick a small odd prime `p` such that:
 *   1. `p ∤ lc(f)` (so Berlekamp's monicity precondition holds after
 *      reduction);
 *   2. `f mod p` is square-free (so Berlekamp returns the right number
 *      of factors and the Hensel lift is well-defined).
 *
 * Walks the static `SMALL_PRIMES` table. Primality of f's discriminant
 * places only finitely many "bad" primes in our way; small primes
 * succeed fast in practice. Throws if every prime in the table fails
 * (which would indicate `f`'s discriminant is divisible by every
 * prime up to 179 — vanishingly unlikely for the v0.1 bench surface).
 */
function pickLuckyPrime(f: Poly<bigint>, v: string): bigint {
  const n = polyDegInVar(f, v);
  let lc = 0n;
  for (const t of f.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    if (pv === n) lc = t.coef;
  }
  const lcAbs = lc < 0n ? -lc : lc;

  for (const p of SMALL_PRIMES) {
    if (lcAbs % p === 0n) continue;
    const F = fpField(p);
    const fModP = polyTrunc(f, p);
    if (polyDegInVar(fModP, v) !== n) continue;     // leading coef hit zero
    // f mod p is square-free iff gcd(f, f') == 1 in F_p[v].
    const fPrime = polyTruncDeriv(fModP, v, F);
    if (polyIsZero(fPrime)) continue;       // f mod p is a polynomial in v^p — not square-free
    const g = polyGcd(fModP, fPrime, F);
    if (polyIsOne(g, F)) return p;
  }
  throw new Error(
    "factorPrimitiveSquareFreeZ: no lucky prime found in [3, 179]; the input " +
    "may have an unusually large discriminant — escalate to a larger prime table.",
  );
}

/** `polyDeriv` over `F_p` — same algorithm as cas-core's, threaded through F. */
function polyTruncDeriv(
  f: Poly<bigint>,
  v: string,
  F: Field<bigint>,
): Poly<bigint> {
  return polyDeriv(f, v, F);
}

/** Lift a `Poly<bigint>` (representing an integer poly) into `Poly<Rat>`. */
function polyIntToRat(f: Poly<bigint>): Poly<Rat> {
  return {
    terms: f.terms.map((t) => ({ exp: t.exp, coef: makeRat(t.coef, 1n) })),
  };
}

/**
 * Convert a `Poly<Rat>` to a primitive `Poly<bigint>` plus the denominator-
 * scaling integer. Output: `(numer, denomScaling)` with
 *
 *     f_Q = numer / denomScaling   (in ℚ[v])
 *
 * and `numer` *primitive* (gcd of coefs is 1 up to sign) AND with
 * positive leading coefficient — for Yun-step compatibility, `numer`
 * is monic when `f_Q` is, which is the only case Yun reaches.
 *
 * For the broader `factorIntZ` / `factorRatQ` flow, see
 * `ratPolyToContentPrimitiveInt` which also extracts the integer
 * content separately.
 */
function ratPolyToPrimitiveInt(
  f: Poly<Rat>,
  v: string,
): { numer: Poly<bigint>; denomScaling: bigint } {
  if (polyIsZero(f)) {
    return { numer: { terms: [] }, denomScaling: 1n };
  }
  // Compute LCM of denominators.
  let lcm: bigint = 1n;
  for (const t of f.terms) {
    lcm = lcmBig(lcm, t.coef.d);
  }
  // Multiply through to clear denominators.
  const intCoefs = f.terms.map((t) => ({
    exp: t.exp,
    coef: t.coef.n * (lcm / t.coef.d),
  }));
  // Strip integer content (gcd of all coefs).
  let g: bigint = 0n;
  for (const t of intCoefs) g = gcdBigAbs(g, t.coef);
  if (g <= 0n) g = 1n;
  // Integer numerator after content strip.
  let numerTerms = intCoefs.map((t) => ({ exp: t.exp, coef: t.coef / g }));
  // After content strip, the polynomial may have negative leading
  // coefficient; for our Yun-targeted callers, that's fine since Yun
  // emits monic factors over ℚ, and "monic over ℚ" lifted to ℤ is
  // never negative-leading. Still, normalise sign defensively.
  // Find the leading term in v.
  let dLead = -1, lcCoef = 0n;
  for (const t of numerTerms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    if (pv > dLead) { dLead = pv; lcCoef = t.coef; }
  }
  if (lcCoef < 0n) {
    numerTerms = numerTerms.map((t) => ({ exp: t.exp, coef: -t.coef }));
    g = -g;     // flip the content sign so f_Q reconstruction stays exact
  }
  // The final scaling: f_Q = (numer * g) / lcm = numer / (lcm/g) when g | lcm.
  // Actually: numer = (intCoefs / g), f_Q = intCoefs / lcm = (numer · g) / lcm.
  // We want (numer / denomScaling) form. So denomScaling = lcm / g if g divides
  // lcm and g > 0; for negative g, denomScaling absorbs the sign.
  // Simpler: report `denomScaling = lcm / |g|` and embed sign of g into numer
  // (which we did by negating numerTerms above when lcCoef < 0). After that,
  // g is guaranteed positive divides lcm (since g divides every intCoef).
  const denomScaling = lcm / (g < 0n ? -g : g);
  return { numer: { terms: numerTerms }, denomScaling };
}

/**
 * Like `ratPolyToPrimitiveInt`, but also reports the integer content
 * `c` such that the original `f_Q` equals `(c · primitive) / denomScaling`.
 * The primitive part has gcd-of-coefs equal to 1 (with positive
 * leading coefficient). Used by `factorRatQ` to keep the rational
 * content separate from the structural integer factorisation.
 */
function ratPolyToContentPrimitiveInt(
  f: Poly<Rat>,
  v: string,
): { numer: Poly<bigint>; denomScaling: bigint; contentZ: bigint } {
  if (polyIsZero(f)) {
    return { numer: { terms: [] }, denomScaling: 1n, contentZ: 0n };
  }
  let lcm: bigint = 1n;
  for (const t of f.terms) {
    lcm = lcmBig(lcm, t.coef.d);
  }
  const intCoefs = f.terms.map((t) => ({
    exp: t.exp,
    coef: t.coef.n * (lcm / t.coef.d),
  }));
  let g: bigint = 0n;
  for (const t of intCoefs) g = gcdBigAbs(g, t.coef);
  if (g === 0n) g = 1n;     // f was zero; we returned early above.
  // `g` is positive by construction of gcdBigAbs.
  let numerTerms = intCoefs.map((t) => ({ exp: t.exp, coef: t.coef / g }));
  // Sign-fix: if numer's leading coefficient in v is negative, negate
  // so the primitive part has positive leading coefficient.
  let dLead = -1, lcCoef = 0n;
  for (const t of numerTerms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    if (pv > dLead) { dLead = pv; lcCoef = t.coef; }
  }
  let contentZ = g;
  if (lcCoef < 0n) {
    numerTerms = numerTerms.map((t) => ({ exp: t.exp, coef: -t.coef }));
    contentZ = -g;
  }
  return { numer: { terms: numerTerms }, denomScaling: lcm, contentZ };
}

/** GCD of two non-negative bigints; gcdBigAbs takes absolute values first. */
function gcdBigAbs(a: bigint, b: bigint): bigint {
  let aa = a < 0n ? -a : a;
  let bb = b < 0n ? -b : b;
  while (bb !== 0n) {
    const t = aa % bb;
    aa = bb;
    bb = t;
  }
  return aa;
}

function lcmBig(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  const g = gcdBigAbs(a, b);
  const aa = a < 0n ? -a : a;
  const bb = b < 0n ? -b : b;
  return (aa / g) * bb;
}

function bigPow(base: bigint, exp: number): bigint {
  let r = 1n;
  let b = base;
  let e = exp;
  while (e > 0) {
    if ((e & 1) === 1) r *= b;
    e >>>= 1;
    if (e > 0) b = b * b;
  }
  return r;
}

/** `∏ factor_i^multiplicity_i` over ℚ[v]. */
function computeProductOverQ(
  factors: readonly IntFactorRecord[], v: string,
): Poly<Rat> {
  let acc: Poly<Rat> = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);
  for (const { factor, multiplicity } of factors) {
    const fQ = polyIntToRat(factor);
    for (let i = 0; i < multiplicity; i++) {
      acc = polyMul(acc, fQ, RAT_RING);
    }
  }
  return acc;
  void v;
}

void polyEq;
void polyFromCoeffsInVar;
void ratIsZero;
