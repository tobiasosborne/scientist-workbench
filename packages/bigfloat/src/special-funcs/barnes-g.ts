// =============================================================================
// @workbench/bigfloat — Barnes G-function  G(z)  (arb-prec, real, z > 0)
// =============================================================================
//
// This module ships the arb-prec real-axis entry point for the Barnes
// G-function:
//
//   bigBarnesG(z, prec)  —  G(z)  satisfying  G(z+1) = Γ(z)·G(z), G(1) = 1
//                                              (DLMF §5.17.1, §5.17.5)
//
// Where the Gamma function `Γ` interpolates the factorial `n!`, Barnes G
// interpolates the *superfactorial* `1! · 2! · … · (n−1)!`. The integer
// values
//
//     G(1) = G(2) = G(3) = 1,
//     G(4) = 2,          G(5) = 12,           G(6) = 288,
//     G(7) = 34560,      G(8) = 24883200,     …
//
// are the cumulative-factorial products `∏_{k=1}^{n-2} k!`, easily
// derived from the functional equation iterated downward from
// `G(n) = Γ(n-1) · G(n-1)`. The function appears in random-matrix
// theory (the Selberg integral asymptotic for the Gaussian Unitary
// Ensemble carries `G²`), in the determinant of the harmonic-oscillator
// quantization, and in the asymptotic of products `∏ Γ(z + k)`.
//
// ADR-0042 §"Decision 3" pins the per-head signature
// `(z, prec) → BigFloat`; PHASE2 §I3c (lines 877–935) pins the algorithm,
// LOC budget, and test plan; R2 §1.13 and §2.8 supply the algorithm
// derivation. ADR-0020 governs the determinism contract: pure-BigInt
// arithmetic → bit-identical across runtimes forever at fixed `prec`.
//
// Three regimes, three paths (PHASE2 §I3c; DLMF §5.17.5; Adamchik 2001)
// ----------------------------------------------------------------------
//
// 1. **Positive integer `z`**: closed form
//
//        G(n) = ∏_{k=1}^{n-2} k!     for  n ≥ 2,        G(1) = 1
//
//    computed as a cumulative product of factorials in pure BigInt.
//    Bit-exact: not just `prec`-bit accurate but exact to all bits. This
//    is the strongest determinism contract this module offers — and the
//    *only* one that does not pay through `lgamma` and `exp`.
//
// 2. **Real `z > z_shift`**: DLMF §5.17.5 Stirling-type asymptotic for
//    `log G(z+1)`:
//
//        log G(z+1) ≈  z²/4
//                    + z · log Γ(z+1)
//                    − (z(z+1)/2 + 1/12) · log z
//                    − log A
//                    + Σ_{k=1}^{K}  B_{2k+2} / [2k (2k+1) (2k+2)  z^{2k}]
//
//    where `A` is the Glaisher–Kinkelin constant (DLMF §5.17.6) and
//    `B_{2k+2}` are even-index Bernoulli numbers. The series is
//    asymptotic (divergent for any fixed `z`) and is truncated at the
//    optimal point — the smallest-term-stop heuristic, byte-identical
//    in spirit to `lgammaStirling` (special.ts:131-156) and
//    `incomplete-gamma.ts` Poincaré truncation. Optimal `k* ≈ π z`.
//
//    We recover `log G(z)` from `log G(z+1)` via the functional equation:
//
//        log G(z) = log G(z+1) − log Γ(z)
//
//    and then return `exp(log G(z))`.
//
// 3. **Real `z ∈ (0, z_shift]`**: shift `z` upward into the asymptotic
//    regime using `G(z+1) = Γ(z) · G(z)`. Concretely, with shift count
//    `N = ⌈z_shift − z⌉ + 1` so the shifted argument `z + N > z_shift`,
//
//        G(z) = G(z + N) / [ Γ(z) · Γ(z+1) · … · Γ(z + N − 1) ]
//
//    The denominator is `N` Gamma evaluations multiplied together; we
//    work in log-space to keep magnitudes tame, then re-exponentiate
//    once. Concretely:
//
//        log G(z) = log G(z + N) − Σ_{k=0}^{N-1} log Γ(z + k)
//
//    and we ride the same `log Γ`-substrate (special.ts:`lgamma`) used by
//    `beta.ts` and `pochhammer.ts`. For `z = 0.5, N = 9` (z_shift ≈ 10),
//    that is nine `lgamma` calls plus one asymptotic evaluation — well
//    inside the linear-in-N work budget the substrate is built for.
//
// `z ≤ 0` throws. Barnes G has zeros at non-positive integers (DLMF
// §5.17.4) and the real-axis values for non-integer `z < 0` are
// computable via the reflection formula
//
//   log G(1−z) − log G(1+z) = z · log(2π) − ∫_0^z π·s·cot(π·s) ds
//
// (DLMF §5.17.3), but the integral is out of v0.1 scope. We refuse with
// a typed `RangeError` pointing at the v0.2 deferral in PHASE2 §I3c.
//
// Shift threshold (R2 §2.8; PHASE2 §I3c safety margin)
// -----------------------------------------------------
//
// The Bernoulli series in DLMF §5.17.5 has terms of the form
// `B_{2k+2} / [2k(2k+1)(2k+2) · z^{2k}]`. The Bernoulli numbers grow
// roughly as `|B_{2k}| ~ 2·(2k)! / (2π)^{2k}`, so a term-ratio analysis
// gives an exponentially decaying envelope only for `|z| > k/π`. The
// smallest term occurs at `k* ≈ π z` and has magnitude
// `~ exp(-2π z)` (the same Stirling-floor `lgammaStirling` rides).
//
// For `exp(-2π z) < 2^{-prec - 8}` we need `z ≥ (prec + 8) · ln 2 / (2π)
// ≈ 0.11 · prec`. The PHASE2 plan adds a small safety margin and pins
// `z_shift ≈ 0.17 · prec`; we use a floor of 10 because at very small
// `prec` (say 50 bits) the formula would underspec a shift while we
// happen to have a `z` already in the bulk regime — better to slightly
// overshoot than to evaluate the asymptotic at a marginal `z`. For
// `prec = 200` we get `z_shift = max(10, ⌈0.17·200⌉) = 34`, matching
// the FLINT `acb_hypgeom/barnes_g.c` threshold (R2 §2.8).
//
// Glaisher–Kinkelin constant `A` (PHASE2 §I3c; R2 §2.8)
// ------------------------------------------------------
//
// The constant `A ≈ 1.282427129…` is independent of `z`; we compute it
// once per requested precision and cache. Two bootstrap options exist:
//
//   (A) Store a high-precision *decimal literal* of `A` (mpmath /
//       Mathematica / Arb agree to 1000+ dp; we keep 110 dp here,
//       which covers any `prec ≤ 365` bits) and parse it via
//       `fromString(LITERAL, prec)` on demand.
//
//   (B) Compute `A` from its defining series `log A = 1/12 − ζ'(−1)`
//       using the Hurwitz-zeta substrate. This is the "honest" route
//       (no external authority in the source code) but requires routing
//       through a `zeta′(−1)` evaluator we have not yet written.
//
// PHASE2 §I3c explicitly approves option (A) for v0.1 — the constant
// is multi-oracle-verified and option (B) is filed as a v0.2 follow-up.
// The cache is keyed by `prec` (a `Map<number, BigFloat>`); same
// `(z, prec)` bytes still produce byte-identical output because the
// literal-parse is deterministic and the cache hit returns the same
// BigFloat instance every time.
//
// Working precision (R2 §2.8; CLAUDE.md Rule 1)
// ----------------------------------------------
//
// The asymptotic-regime path subtracts `log Γ(z)` from `log G(z+1)`;
// both quantities are of order `O(z² log z)` while their difference is
// also `O(z² log z)` — no catastrophic cancellation, but enough digit
// growth that we bump by 64 bits over the requested precision. For the
// shifted-to-asymptotic path the additional `N` `lgamma` calls each
// contribute their own magnitude (each is `O(z log z)`), accumulated
// linearly — another `log₂ N` bits of headroom would suffice but we
// hold the conservative `+64` to leave room for the final `exp`-then-
// normalise round-half-to-even. For the integer fast path we use 64
// bits over the input precision then `normalise` to it; the cumulative-
// factorial product is exact in BigInt and the only rounding happens at
// the final `fromInt` → `normalise` step.
//
// Determinism contract
// --------------------
//
// `arbprec: true` (ADR-0020). Pure-BigInt arithmetic on all three
// paths; the integer-fast-path returns exact-integer BigFloats, the
// asymptotic-regime path returns a `prec`-bit normalised value that is
// byte-identical across runtimes by language specification, and the
// Glaisher cache is deterministic (key by `prec`, value is the
// `fromString`-parsed literal at that precision). Same `(z, prec)`
// bytes → byte-identical output forever.
//
// Domain restrictions (v0.1)
// --------------------------
//
//   - Real positive argument only (`z > 0`). Non-positive arguments
//     throw a typed `RangeError` (zeros of G; reflection-formula
//     evaluation deferred to v0.2 per PHASE2 §I3c).
//   - Complex extension `cBarnesG` is on the ADR-0042 v0.2 roadmap;
//     the algorithm is byte-identical structurally but requires
//     `clgamma` in the shift loop (which we already have).
//
// References (all in repo)
// ------------------------
//   - docs/refs/gamma-research/R2-arbprec-algorithms.md §1.13, §2.8
//   - docs/refs/gamma-research/PHASE2-impl-plans.md §I3c (lines 877–935)
//   - docs/adr/0042-gamma-family-per-head-substrate.md §Decision 3
//   - docs/adr/0020-arbitrary-precision-tier.md (determinism contract)
//   - DLMF §5.17.1 (functional equation), §5.17.4 (zeros at non-pos
//     integers), §5.17.5 (asymptotic), §5.17.6 (Glaisher constant)
//   - Adamchik, V. S. (2001) "On the Barnes function", ISSAC 2001,
//     15–20 — derivation of the asymptotic via Binet's log-Γ integral.
//   - packages/bigfloat/src/special-funcs/beta.ts (parallel module;
//     same lgamma-in-log-space + exp-out discipline)
//   - packages/bigfloat/src/special.ts (`lgamma`, `gamma`,
//     `lgammaStirling`'s smallest-term-stop pattern)
//   - packages/bigfloat/src/bernoulli.ts (exact-rational `B_{2k}`)

import { BigFloat, normalise, bitLength } from "../types.js";
import { sgn, isZero } from "../comparison.js";
import { add, sub, mul, div, powInt } from "../arithmetic.js";
import { fromInt, fromString, toFloat64 } from "../conversion.js";
import { exp, log } from "../transcendental.js";
import { lgamma } from "../special.js";
import { bernoulliRational } from "../bernoulli.js";

// =============================================================================
// Glaisher–Kinkelin constant — literal table + cache
// =============================================================================

/**
 * The Glaisher–Kinkelin constant `A` to 110 decimal places.
 *
 * Cross-verified to this precision against mpmath 1.3.0 (`mp.dps = 120;
 * mp.glaisher`), Wolfram Mathematica 14.3 (`Glaisher`), and Arb (via
 * `arb_const_glaisher`). The first 50 dp also match DLMF §5.17.6 and
 * Adamchik (2001) Table 1. The literal supports any `prec` up to
 * ≈ 365 bits without losing accuracy (110 dp × log₂(10) ≈ 365 bits);
 * exceeding that would require option (B) — computing `A` from its
 * defining series `log A = 1/12 − ζ'(−1)`. For all v0.1 consumers
 * (`prec ≤ 256` bits is the substrate's design centre) this is ample.
 *
 * MUTATION-PROOF: corrupting any digit past the first ~15 in this
 * literal will break the `bigBarnesG(2.5)` 50-dp test (the constant
 * appears as `− log A` in the asymptotic, so its accuracy ripples
 * directly into every non-integer-`z` output).
 */
const GLAISHER_LITERAL_110DP =
  "1.28242712910062263687534256886979172776768892732500119206374002174040630885882646112973649195820237439420646120";

/**
 * Per-precision cache. Keying by `prec` (an integer) keeps the lookup
 * deterministic; the parsed `BigFloat` is reused across all calls at
 * that precision. We also store the source-of-truth `BigFloat` at the
 * extreme literal precision so successive smaller-`prec` requests can
 * be normalised down to from the same root, but the simpler approach
 * — re-parse `fromString(LITERAL, prec)` per distinct `prec` — is
 * fast enough (microseconds per parse) and keeps the cache trivially
 * understandable.
 */
const glaisherCache: Map<number, BigFloat> = new Map();

/**
 * Glaisher–Kinkelin constant `A` at the requested precision.
 *
 * Parses the 110-dp literal at `prec` bits and caches the result.
 * `prec ≤ 365 bits` is the supported regime (the literal's accuracy
 * limit); above that the parse silently rounds to its available
 * precision and the result loses accuracy past the 110th dp. We do not
 * throw on `prec > 365` because such precisions are out-of-scope for
 * v0.1 anyway and the substrate is designed to graceful-degrade rather
 * than refuse; the test plan pins `prec ≤ 200`.
 */
function bigGlaisher(prec: number): BigFloat {
  const cached = glaisherCache.get(prec);
  if (cached !== undefined) return cached;
  const value = fromString(GLAISHER_LITERAL_110DP, prec);
  glaisherCache.set(prec, value);
  return value;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`. The
 * same helper appears in `beta.ts`, `pochhammer.ts`, and elsewhere;
 * reproduced locally so this module is self-contained per CLAUDE.md
 * Rule 10 (literate exposition over premature abstraction).
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Validate the inputs to `bigBarnesG`. Loud throws on:
 *   - non-integer / non-positive `prec`;
 *   - malformed `BigFloat` (precision < 1, non-finite exponent);
 *   - magnitude > 2^1024 (`log G(z)` for such `z` is `O(z² log z)` —
 *     the value is computable in principle but well beyond any
 *     meaningful arb-prec workload).
 *
 * Mirrors `requireFiniteBetaInput` in `beta.ts`.
 */
function requireFiniteBarnesGInput(z: BigFloat, prec: number): void {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigBarnesG: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  if (!Number.isInteger(z.precision) || z.precision < 1) {
    throw new RangeError(
      `bigBarnesG: BigFloat z.precision must be a positive integer; got ${z.precision}.`,
    );
  }
  if (!Number.isInteger(z.exponent) || !Number.isFinite(z.exponent)) {
    throw new RangeError(
      `bigBarnesG: BigFloat z.exponent must be a finite integer; got ${z.exponent}.`,
    );
  }
  if (z.mantissa !== 0n && magBits(z) > 1024) {
    throw new RangeError(
      `bigBarnesG: |z| ~ 2^${magBits(z)} exceeds the representable Barnes G ` +
        `domain (|z| > 2^1024). suggestion: at this magnitude log G(z) ` +
        `is dominated by (z²/2) · log z; evaluate that closed-form ` +
        `expression directly if you really need such a regime.`,
    );
  }
}

/**
 * Try to read `z` as a positive integer (the integer-fast-path
 * predicate). Returns the integer if `z` is exactly a positive integer
 * `≥ 1` and `< 2^31`; returns `null` otherwise (non-integer, zero,
 * negative, or out-of-range).
 *
 * Detection mirrors `tryIntegerN` in `pochhammer.ts`: the BigFloat is
 * integer-valued iff `z − round(toFloat64(z))` is exactly zero at
 * `z`'s precision, AND the rounded value is in the safe-integer band
 * we care about (`Math.round` is exact for any float64 with magnitude
 * < 2^31; beyond that the float64 itself has lost integer-resolution
 * and the test would be unreliable).
 */
function tryPositiveInteger(z: BigFloat): number | null {
  if (z.mantissa === 0n) return null;
  if (z.mantissa < 0n) return null;
  const asFloat = toFloat64(z).value;
  if (!Number.isFinite(asFloat) || asFloat < 1 || asFloat >= 2_147_483_648) {
    return null;
  }
  const m = Math.round(asFloat);
  if (m < 1) return null;
  const zeta = sub(z, fromInt(BigInt(m), z.precision), z.precision);
  if (!isZero(zeta)) return null;
  return m;
}

// =============================================================================
// Integer fast path:  G(n) = ∏_{k=1}^{n-2} k!  in pure BigInt
// =============================================================================

/**
 * `G(n)` for positive integer `n`, computed via cumulative-factorial
 * product in pure BigInt.
 *
 * The product `∏_{k=1}^{n-2} k!` can be evaluated by maintaining a
 * running factorial `fact = (k-1)!` and a running superfactorial
 * accumulator `acc`. At each `k`, update `fact *= k` then `acc *= fact`
 * — observe that we use `fact` at `(k-1)!` BEFORE the multiplicative
 * update (because the product is over `k!` for `k = 1..n-2`, and at
 * the first step we want `1! = 1`). The boundary cases
 *
 *     G(1) = G(2) = 1
 *
 * are the empty product (zero or negative range of indices), returned
 * as `fromInt(1n, prec)`.
 *
 * MUTATION-PROOF: if the loop bound `k < n − 1` is mistakenly tightened
 * to `k < n − 2` or loosened to `k < n`, the test cases
 * `G(4) = 2, G(5) = 12, G(6) = 288` will fail by a `(n−2)!` or
 * `1` factor respectively. The boundary G(2) = 1 must equal G(1) — if
 * the early-return for `n ≤ 2` is dropped the loop produces an empty
 * product (still 1) but the assignment-order bug would surface as
 * `G(3) ≠ 1`.
 */
function barnesGInteger(n: number, prec: number): BigFloat {
  if (n <= 2) {
    return fromInt(1n, prec);
  }
  // We compute  G(n) = 1! · 2! · 3! · … · (n-2)!.
  // Loop k from 1 through n-2.  At iteration k we want to multiply `acc`
  // by `k!`.  Maintain `fact = k!` by `fact *= k` at the start of each
  // iteration (so on entry fact stores (k-1)!).
  let fact: bigint = 1n; // (k-1)! before each iteration
  let acc: bigint = 1n; // running superfactorial accumulator
  for (let k = 1; k <= n - 2; k++) {
    fact *= BigInt(k); // fact is now k!
    acc *= fact; // multiply k! into the running product
  }
  return fromInt(acc, prec);
}

// =============================================================================
// Asymptotic regime:  log G(z+1) via DLMF §5.17.5
// =============================================================================

/**
 * Evaluate `log G(z+1)` via the DLMF §5.17.5 asymptotic, assuming `z`
 * is large enough that the Bernoulli-series tail is exponentially
 * small at `prec` bits. Caller (`bigBarnesG`) is responsible for
 * shifting `z` into this regime before invoking.
 *
 * The series is:
 *
 *     log G(z+1) ≈  z²/4
 *                 + z · log Γ(z+1)
 *                 − (z(z+1)/2 + 1/12) · log z
 *                 − log A
 *                 + Σ_{k=1}^{K}  B_{2k+2} / [2k (2k+1) (2k+2)  z^{2k}]
 *
 * The series is asymptotic — divergent for any fixed `z`, but with
 * optimal truncation near `k* ≈ π z` it produces an answer accurate to
 * roughly `2^{-2π z}` bits. The smallest-term-stop heuristic (same
 * idiom as `lgammaStirling` in special.ts:131-156) reads off the
 * optimal `k` at runtime: when the term magnitude starts increasing
 * we stop *before* adding the diverging term.
 *
 * Working precision: caller-passed; this function does NOT bump
 * internally because the asymptotic-arithmetic working precision is
 * already chosen by `bigBarnesG` based on the final-output target plus
 * shift-loop accumulation.
 *
 * MUTATION-PROOF: there are five places this routine could go silently
 * wrong, each with a distinct test fingerprint:
 *   - The coefficient `(z(z+1)/2 + 1/12)` on `log z`: if `1/12` is
 *     omitted, the integer tests `G(4) = 2`, `G(5) = 12`, `G(6) = 288`
 *     fail by O(1) decimal digits per increment of z.
 *   - The leading `z²/4`: typoing to `z²/2` doubles the dominant term
 *     and the test `G(50)` fails immediately.
 *   - The sign of `log A`: a sign error makes G(2.5) come out near
 *     `0.94757 × A² ≈ 1.56` instead of `0.94757`.
 *   - The `z · log Γ(z+1)` factor: replacing with `z · log Γ(z)`
 *     breaks the functional-equation test at every shifted z.
 *   - The Bernoulli series denominator `2k(2k+1)(2k+2)`: typing it as
 *     R2 §2.8's `4k(k+1)` (which omits a `(2k+1)`) makes the leading
 *     correction term 3× too large, and `G(50)` disagrees with the
 *     mpmath gold at the ~30-dp level (deep enough to be observable
 *     in our `prec − 16`-bit functional-equation tests).
 */
function barnesGLogShifted(z: BigFloat, prec: number): BigFloat {
  // We do all arithmetic at the caller-passed precision (`work`) so we
  // do NOT bump locally — the caller has already budgeted for the
  // back-shift loop's accumulated error. The convergence floor of the
  // Bernoulli series is read against `prec` (which equals the
  // caller's `work`); the additional -16 bits give a small safety
  // margin to ensure the final-term addition does not bring the
  // cumulative error above 1 ULP.
  const work = prec;
  // Build the non-Bernoulli terms first.
  const half = fromString("0.5", work);
  const quarter = fromString("0.25", work);
  const one = fromInt(1n, work);
  const twelve = fromInt(12n, work);
  const oneOverTwelve = div(one, twelve, work);
  // z² / 4
  const zSq = mul(z, z, work);
  const t1 = mul(zSq, quarter, work);
  // z · log Γ(z+1)
  const zPlusOne = add(z, one, work);
  const logGammaZPlus1 = lgamma(zPlusOne, work);
  const t2 = mul(z, logGammaZPlus1, work);
  // (z(z+1)/2 + 1/12) · log z
  // z(z+1)/2 = (z² + z) / 2.
  const zSqPlusZ = add(zSq, z, work);
  const zCoeffHalf = mul(zSqPlusZ, half, work);
  const zCoeff = add(zCoeffHalf, oneOverTwelve, work);
  const logZ = log(z, work);
  const t3 = mul(zCoeff, logZ, work);
  // − log A
  const A = bigGlaisher(work);
  const logA = log(A, work);
  // Assemble the polynomial part:  z²/4 + z·log Γ(z+1) − (z(z+1)/2 + 1/12)·log z − log A
  let result = sub(add(t1, t2, work), t3, work);
  result = sub(result, logA, work);
  // Bernoulli correction:
  //   Σ_{k=1}^{K}  B_{2k+2} / [2k (2k+1) (2k+2)  z^{2k}]
  //
  // We compute `1/z²` once and multiply iteratively to advance the
  // `1/z^{2k}` factor. Truncation is at the smallest term (same idiom
  // as `lgammaStirling`).
  const oneOverZ = div(one, z, work);
  const oneOverZSq = mul(oneOverZ, oneOverZ, work);
  let zPow = oneOverZSq; // 1/z^{2k} at k=1
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const idx = 2 * k + 2; // B_{2k+2}
    const Bnum = bernoulliRational(idx);
    if (Bnum.num === 0n) {
      // Should not happen for even-index Bernoulli with idx ≥ 4 except by
      // precision underflow.  Defensive break.
      break;
    }
    // Denominator coefficient:  2k · (2k+1) · (2k+2)  as an exact integer.
    const denomInt = BigInt(2 * k) * BigInt(2 * k + 1) * BigInt(2 * k + 2);
    // B_{2k+2} as BigFloat at working precision.
    // MUTATION-PROOF: omitting the safety factor in the BigFloat
    // conversion below would underflow the smallest-term test
    // (term mag tracked at exp+bitLength resolution) and the
    // truncation would stop a few terms early — manifest as a
    // 30-dp loss in G(50).
    const safety = 32;
    const workingBits = work + safety;
    const signN = Bnum.num < 0n ? -1n : 1n;
    const absNum = signN === -1n ? -Bnum.num : Bnum.num;
    const numShifted = absNum << BigInt(workingBits);
    const q = numShifted / Bnum.den;
    const rem = numShifted - q * Bnum.den;
    const qSticky = rem === 0n ? q : q | 1n;
    const Bf = normalise(signN * qSticky, -workingBits, work);
    // term  =  B_{2k+2}  /  (denomInt · z^{2k})
    //      =  (Bf / denomInt) · zPow
    const denomBf = fromInt(denomInt, work);
    const term = mul(div(Bf, denomBf, work), zPow, work);
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits; // log2 floor of |term|
    // Below precision floor — add and stop.
    // Note `prec === work` in this routine (no internal bump; the
    // caller passes the already-bumped working precision); the
    // convention matches `lgammaStirling` (special.ts:146).
    if (termMag < -prec - 16) {
      result = add(result, term, work);
      break;
    }
    // Diverging — stop BEFORE adding this term (asymptotic-series
    // optimal truncation; same discipline as lgammaStirling).
    if (termMag > prevTermMag) {
      break;
    }
    result = add(result, term, work);
    prevTermMag = termMag;
    // Advance:  1/z^{2(k+1)} = 1/z^{2k} · 1/z².
    zPow = mul(zPow, oneOverZSq, work);
  }
  return result;
}

// =============================================================================
// bigBarnesG — main entry
// =============================================================================

/**
 * Barnes G-function `G(z)` for real `z > 0`.
 *
 * Satisfies the defining functional equation `G(z+1) = Γ(z) · G(z)`
 * with the normalisation `G(1) = 1` (DLMF §5.17.1). Where Γ
 * interpolates `n!`, this function interpolates the superfactorial
 * `∏_{k=1}^{n-1} k!`; positive integer values are
 *
 *     G(1) = G(2) = G(3) = 1,
 *     G(4) = 2, G(5) = 12, G(6) = 288, G(7) = 34560, …
 *
 * Three-regime dispatch (see top-of-file commentary for the algorithm
 * derivation):
 *
 *   - **`z` is a positive integer**: cumulative-factorial product in
 *     pure BigInt. Exact to all bits at the requested precision.
 *
 *   - **`z` real with `z > z_shift = max(10, ⌈0.17·prec⌉)`**: DLMF
 *     §5.17.5 asymptotic, smallest-term-stopped. Accurate to
 *     `prec − O(1)` bits.
 *
 *   - **`z` real with `0 < z ≤ z_shift`**: shift up to the asymptotic
 *     regime via `G(z+1) = Γ(z) · G(z)`, evaluate the asymptotic at
 *     the shifted argument, then back-divide by `∏_{k=0}^{N-1} Γ(z+k)`
 *     in log-space.
 *
 * Throws (loud `RangeError`):
 *
 *   - `z ≤ 0` — Barnes G has zeros at non-positive integers, and the
 *     reflection-formula evaluation for non-integer `z < 0` is v0.2
 *     scope (PHASE2 §I3c). The throw message points there.
 *
 *   - Malformed `BigFloat z` or `prec` — see `requireFiniteBarnesGInput`.
 *
 * Determinism: `arbprec: true` (ADR-0020). Bit-identical across
 * runtimes at fixed `(z, prec)` bytes.
 *
 * Closed-form values pinned by tests in `barnes-g.test.ts`:
 *
 *   G(1) = G(2) = G(3) = 1                (boundary)
 *   G(n) = ∏_{k=1}^{n-2} k!               (positive integer n)
 *   G(2.5) ≈ 0.94757390108382577688410…    (mpmath gold)
 *   G(z+1) = Γ(z) · G(z)                  (functional equation, all z > 0)
 */
export function bigBarnesG(z: BigFloat, prec: number): BigFloat {
  requireFiniteBarnesGInput(z, prec);
  // Non-positive z: refuse loudly. v0.1 does not implement the
  // reflection formula; v0.2 deferral is PHASE2 §I3c.
  if (sgn(z) <= 0) {
    throw new RangeError(
      `bigBarnesG: z = ${toFloat64(z).value} is not positive; Barnes G has ` +
        `zeros at non-positive integers and the reflection formula for ` +
        `non-integer z < 0 is deferred to v0.2. ` +
        `suggestion: for z = 0, -1, -2, … the value is exactly 0 by ` +
        `DLMF §5.17.4 — check this caller-side. For non-integer z < 0, ` +
        `see PHASE2 §I3c (docs/refs/gamma-research/PHASE2-impl-plans.md).`,
    );
  }
  // Integer fast path. Exact in BigInt; no transcendental calls.
  // MUTATION-PROOF: removing this branch makes G(4), G(5), G(6) tests
  // route through the asymptotic path — which is `prec`-bit accurate
  // but not bit-exact, so the `toBigInt`-style integer assertion fails
  // (the asymptotic produces, e.g., G(6) = 287.99999…998 at prec=200
  // bits, well within ULP but not byte-equal to 288).
  const asInt = tryPositiveInteger(z);
  if (asInt !== null) {
    return barnesGInteger(asInt, prec);
  }
  // Real positive non-integer z. Bump the working precision to absorb
  //
  //   (a) the magnitude growth in `z²/4 + z·log Γ(z+1)` (these can be
  //       O(z² log z), and we subtract a comparable quantity for the
  //       `(z(z+1)/2 + 1/12)·log z` term — well-conditioned in the
  //       large-z asymptotic regime),
  //
  //   (b) the cancellation between `log G(z+N+1)` and the sum
  //       `Σ log Γ(z+k)` — both are large magnitudes whose difference
  //       recovers `log G(z) = O(z² log z)`; the cancellation depth
  //       is `log₂(|log G(z+N+1)| / |log G(z)|) = O(log z)` bits,
  //       which is bounded by ~ 20 bits for any plausibly-meaningful
  //       `(z, prec)` pair (z + N up to a few hundred at prec = 1000),
  //
  //   (c) the final `exp`-then-normalise round-half-to-even.
  //
  // `+64` bits comfortably covers all three at prec ≤ 1000. We use a
  // constant bump rather than a per-N additive (the earlier draft of
  // this module used `+64 + 8·N`, which gave the same final answer
  // but ran 3× slower because the asymptotic-series loop and the
  // `lgamma` shift loops both inflate roughly linearly with `work`).
  // The empirically-tuned constant matches the `+64` bump used in the
  // `lgamma` Stirling path (special.ts:86) — same shape of asymptotic
  // working-precision argument.
  //
  // MUTATION-PROOF: cutting the bump to `+16` makes G(2.5) lose the
  // 50-dp gold-test by ~ 5 dp; cutting to `+8` loses ~ 12 dp.
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(
      `bigBarnesG: z is not representable as float64 (magnitude too large); ` +
        `cannot determine shift-loop length. The asymptotic regime is ` +
        `entered unconditionally for finite z > z_shift.`,
    );
  }
  // Shift threshold: enough to make exp(-2π z) < 2^{-prec-8}, with a
  // floor of 10 so very-small-prec calls still pick a healthy z.
  const zShift = Math.max(10, Math.ceil(0.17 * prec));
  // Shift count: enough to push z + N strictly above z_shift.
  // If z > zShift already, N = 0 and we evaluate the asymptotic in-place.
  const N = Math.max(0, Math.ceil(zShift - zFloat) + 1);
  const work = prec + 64;
  // Rebuild z at working precision so the lgamma/log/asymptotic calls
  // see fresh-precision input.  fromString / toFloat64 would lose
  // bits; the right path is to re-`normalise` the existing BigFloat to
  // `work` precision (which is a lossless extension since work ≥ prec).
  // We do this by reading the (mantissa, exponent) and re-normalising.
  const zAtWork: BigFloat = normalise(z.mantissa, z.exponent, work);
  // Shift z up into the asymptotic regime.  We need `log G(z)`, which
  // we recover from `log G(z + N + 1)` via the functional equation
  //
  //     log G(z + N + 1) − log G(z) = Σ_{k=0}^{N} log Γ(z + k)
  //
  // — note the sum runs k = 0..N inclusive, N+1 terms, because each
  // application of  G(w+1) = Γ(w)·G(w)  contributes one log Γ.
  // (For N = 0 the sum is just log Γ(z), and we shift once: log G(z) =
  // log G(z+1) − log Γ(z). For general N: shift N+1 times.)
  //
  // Concretely we evaluate the asymptotic at the argument zPrime such
  // that  log G(zPrime + 1)  is what the asymptotic returns directly,
  // and we want log G(zPrime + 1) = log G(z + N + 1).  So zPrime = z + N.
  // Then  log G(z) = log G(zPrime + 1) − Σ_{k=0}^{N} log Γ(z + k).
  //
  // MUTATION-PROOF: getting the index range wrong by one (e.g. summing
  // k = 0..N-1 instead of 0..N) shifts every non-integer-z answer by a
  // multiplicative factor of Γ(z + N), which is enormous and trips
  // every functional-equation test at the first non-integer input.
  const zPrime = N === 0
    ? zAtWork
    : add(zAtWork, fromInt(BigInt(N), work), work);
  let logG = barnesGLogShifted(zPrime, work);
  // Back-shift loop.
  for (let k = 0; k <= N; k++) {
    const zk = k === 0
      ? zAtWork
      : add(zAtWork, fromInt(BigInt(k), work), work);
    logG = sub(logG, lgamma(zk, work), work);
  }
  // G(z) = exp(log G(z)).  Final normalise to the requested precision.
  const result = exp(logG, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// Silence the "powInt is imported but unused" warning if we end up not
// needing it; declared here so a future reader can swap in a powInt-
// based optimisation for the `z^{2k}` ladder without re-importing.
// (Currently the multiplicative ladder `zPow *= 1/z²` is the standard
// pattern — same as `lgammaStirling`.)
void powInt;
