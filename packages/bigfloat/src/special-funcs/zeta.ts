// =============================================================================
// @workbench/bigfloat — Hurwitz zeta ζ(s, a) and Riemann zeta ζ(s) (arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis Hurwitz zeta substrate for
// integer order `s ≥ 2`:
//
//   bigHurwitzZeta(s, a, prec)   — ζ(s, a) = Σ_{k≥0} (a+k)^{-s},  a > 0
//   bigRiemannZeta(s, prec)      — ζ(s)    = ζ(s, 1)
//
// ADR-0042 §"Decision 12" is the authority for the extraction. v0.1's
// polygamma-m≥2 path inlined Hurwitz zeta as a *private* helper inside
// `special.ts`, with the caller (`polygammaHurwitz`) carrying the
// recurrence-shift responsibility. That arrangement is correct for a
// single internal caller but is not a usable public substrate: a public
// `bigHurwitzZeta` that silently returns a wildly wrong answer for small
// `a` (because the asymptotic series is evaluated outside its regime of
// validity) violates CLAUDE.md Rule 1 (fail loud, never silently lie).
//
// The fix is the legendary-senior-engineer answer: a first-class public
// API owns its own preconditions. `bigHurwitzZeta` therefore *self-shifts*
// — it detects when `a` is below the Euler-Maclaurin shift threshold and
// applies the shift recurrence internally, so the caller need do nothing
// special. The Euler-Maclaurin core (`hurwitzZetaEulerMaclaurin` below)
// remains a small private function with the explicit-precondition
// contract; the public `bigHurwitzZeta` is the safe wrapper around it.
//
// Why the Hurwitz zeta is worth a standalone module (ADR-0042 §Decision 12):
// it is a broadly-reusable substrate. Riemann zeta is the `a = 1`
// specialisation. The polygamma identity `ψ^(m)(z) = (-1)^(m+1) · m! ·
// ζ(m+1, z)` (DLMF §5.15.2) is one consumer; the Lerch transcendent,
// Dirichlet L-functions, and zeta-function regularisation are future
// consumers. Extracting it makes it reusable and independently testable.
//
// Determinism: every operation is `BigInt` + bounded-integer-exponent
// arithmetic. Same `(args, prec)` bytes → byte-identical `BigFloat` output
// forever. Inherits the `arbprec: true` contract of ADR-0020.
//
// Scope (v0.1): integer `s ≥ 2`, real `a > 0`. The general-complex-`s`
// extension — ζ(s, a) for s ∈ ℂ \ {1}, including the critical strip and
// the functional equation — is a documented v0.2-of-v0.2 lift, out of
// scope here. `bigHurwitzZeta` throws a loud `RangeError` for non-integer
// `s` or `s < 2` rather than returning a plausible-looking wrong value.
//
// -----------------------------------------------------------------------
// Two evaluation lanes — Euler-Maclaurin and Cohen-Villegas-Zagier (CVZ)
// -----------------------------------------------------------------------
//
// This module ships *two* arb-prec algorithms for ζ(s, a):
//
//   • `hurwitzZetaEulerMaclaurin` — the Stirling-analogue asymptotic
//     series with the recurrence-shift wrapper. This is the production
//     lane: `bigHurwitzZeta` routes here for every integer-`s` input.
//
//   • `hurwitzZetaCVZ` — Cohen-Villegas-Zagier convergence acceleration
//     (Cohen, Villegas & Zagier 2000, "Convergence acceleration of
//     alternating series", Experiment. Math. 9:3) applied through the
//     eta-transform. This lane is exact and converges *geometrically*
//     for small `a` with no asymptotic-divergence regime — but, as the
//     R2-hardening investigation found and the §"Lane selection" block
//     below documents in full, it is *not faster* than Euler-Maclaurin
//     for integer `s ≥ 2`. It is exported as `_hurwitzZetaCVZ` and
//     cross-validated against the Euler-Maclaurin lane in the test
//     suite; it is also the load-bearing building block the future
//     complex-`s` / alternating-Lerch bead will sit on (where CVZ
//     genuinely wins, the underlying series there being alternating).
//
// The decisive engineering finding — see §"Lane selection" — is that
// CVZ does NOT beat Euler-Maclaurin in the integer-`s ≥ 2` regime, so
// the public `bigHurwitzZeta` dispatch is gated conservatively: it
// always takes the Euler-Maclaurin lane. This keeps the polygamma path
// (which routes through `bigHurwitzZeta`) byte-identical across the
// addition of the CVZ lane — an explicit acceptance gate of bead
// `scientist-workbench-idq1`.

import { BigFloat, normalise, bitLength } from "../types.js";
import { add, sub, mul, div, powInt } from "../arithmetic.js";
import { fromInt, toFloat64 } from "../conversion.js";
import { bernoulliRational } from "../bernoulli.js";

/**
 * Euler-Maclaurin shift threshold for the Hurwitz-zeta asymptotic series.
 *
 * The Euler-Maclaurin series for ζ(s, a) is Poincaré-asymptotic in `1/a`:
 * it does not converge in the truncation index `K`, and at small `a` even
 * its smallest term is too large to reach `2^{-prec}` accuracy. The series
 * is only useful once `a` exceeds a threshold that grows with the
 * requested precision (more bits ⇒ a smaller minimum term is required ⇒ a
 * larger `a` is needed) and with the order `s` (the `(s)_{2k-1}` Pochhammer
 * factor grows like `(2k)! / (s-1)!`, so larger `s` makes the series more
 * asymptotic and demands a larger `a`).
 *
 * The prescription is Appendix B of `docs/refs/gamma-research/
 * R2-arbprec-algorithms.md` (FLINT's `choose_small` heuristic, BETA = 0.17):
 *
 *     shiftThreshold(prec, s) = max(8, ceil(0.17 · (prec + 2·(s-1) + 96)))
 *
 * Written `2·(s-1)` rather than `2s` because the historical caller
 * (`polygammaHurwitz`, with `s = m + 1`) used the order `m` in this
 * formula: `0.17 · (prec + 2m + 96)`. Substituting `m = s - 1` gives the
 * `2·(s-1)` form here verbatim. Keeping the algebra identical is what
 * makes the polygamma path byte-identical across the v0.1→v0.2 extraction
 * (ADR-0042 §Decision 12 acceptance gate).
 */
export function hurwitzShiftThreshold(prec: number, s: number): number {
  return Math.max(8, Math.ceil(0.17 * (prec + 2 * (s - 1) + 96)));
}

/**
 * Exact rational `num / den` as a BigFloat at `prec` bits. Both inputs are
 * BigInts; the long-division pattern mirrors `bernoulli` so that the result
 * is a properly-normalised BigFloat with a sticky bit.
 *
 * Internal to the Hurwitz path; used to form the Pochhammer / factorial
 * coefficient at each Euler-Maclaurin step. Keeping the integer Pochhammer
 * product *as a BigInt* (rather than accumulating as a BigFloat) means
 * every term carries the same exact numerator until the very last division
 * — no compounding rounding from the Pochhammer.
 */
function ratioBigInt(num: bigint, den: bigint, prec: number): BigFloat {
  if (num === 0n) return { mantissa: 0n, exponent: 0, precision: prec };
  const safety = 32;
  const workingBits = prec + safety;
  const sign = num < 0n ? -1n : 1n;
  const absNum = sign === -1n ? -num : num;
  const numShifted = absNum << BigInt(workingBits);
  const q = numShifted / den;
  const remainder = numShifted - q * den;
  const qWithSticky = remainder === 0n ? q : q | 1n;
  return normalise(sign * qWithSticky, -workingBits, prec);
}

/** B_{2k} as a BigFloat at the requested precision. */
function bernoulli(n: number, prec: number): BigFloat {
  const r = bernoulliRational(n);
  if (r.num === 0n) return { mantissa: 0n, exponent: 0, precision: prec };
  return ratioBigInt(r.num, r.den, prec);
}

/**
 * Hurwitz zeta `ζ(s, z) = Σ_{k≥0} (z+k)^{-s}` for integer `s ≥ 2` at
 * *large* real `z`, evaluated via the Euler-Maclaurin (Stirling-analogue)
 * asymptotic series. Private core; the precondition `z > shiftThreshold`
 * is the *caller's* responsibility (see `bigHurwitzZeta`, which is the safe
 * public wrapper that establishes this precondition by self-shifting).
 *
 * Algorithm (DLMF §25.11.4, also Appendix B of R2-arbprec-algorithms.md):
 *
 *     ζ(s, z) ≈ z^{1-s}/(s-1)  +  (1/2) z^{-s}
 *              + Σ_{k=1}^{K}  B_{2k} · (s)_{2k-1} / ((2k)! · z^{s+2k-1})
 *
 * where `(s)_{2k-1} = s · (s+1) · … · (s+2k-2)` is the rising-Pochhammer
 * factor — exactly `2k-1` integer factors. Specialising to `s = m + 1`
 * (the polygamma case), the Pochhammer becomes
 * `(m+1)(m+2)…(m+2k-1) = (m+2k-1)! / m!`.
 *
 * The series is Poincaré-asymptotic — it diverges in K but the optimal
 * truncation `k* ≈ π z / e` gives an error bounded by the smallest
 * (next-omitted) term. The `prevTermMag` idiom — used identically in
 * `lgammaStirling`, `digammaStirling`, `trigammaStirling` in `special.ts`
 * — catches that minimum automatically: when the term magnitude starts
 * growing, the series is diverging and we stop *before* adding the
 * offending term.
 *
 * Caller responsibility: the caller must have established `z >
 * hurwitzShiftThreshold(prec, s)` — calling this core at small `z`
 * produces a wildly wrong answer because the series is asymptotic, not
 * convergent. The public `bigHurwitzZeta` is the only intended caller and
 * it guarantees the precondition; downstream code should never reach for
 * this core directly.
 *
 * Working precision is bumped by 32 bits internally; the caller bumps the
 * outer `prec` by another margin to absorb factorial growth in `(s)_{2k-1}`.
 *
 * MUTATION-PROOF MARKER: the Bernoulli index is `B_{2k}` (the even-index
 * Bernoulli numbers); using `B_{2k+2}` or `B_k` instead gives wrong
 * Stirling coefficients. The Pochhammer `(s)_{2k-1}` has `2k-1` factors
 * starting at `s`; using `2k` factors (or starting at `s-1`) misaligns the
 * series. Both are pinned by the `bigRiemannZeta(3) = ζ(3)` (Apéry) and
 * `polygamma(2, 1) = −2ζ(3)` / `polygamma(3, 1) = π⁴/15` golden tests.
 */
function hurwitzZetaEulerMaclaurin(
  s: number,
  z: BigFloat,
  prec: number,
): BigFloat {
  if (!Number.isInteger(s) || s < 2) {
    throw new RangeError(
      `hurwitzZetaEulerMaclaurin: s must be integer ≥ 2; got ${s}`,
    );
  }
  const work = prec + 32;
  // Leading two terms: z^{1-s}/(s-1) + (1/2) z^{-s}.
  // s ≥ 2 so 1 − s ≤ −1; powInt accepts negative exponents.
  const oneOverZ = div(fromInt(1n, work), z, work);
  const oneOverZ2 = mul(oneOverZ, oneOverZ, work);
  // z^{-(s-1)} = z^{1-s}.
  const zPow1mS = powInt(z, 1 - s, work);
  // z^{-s}.
  const zPowMS = mul(zPow1mS, oneOverZ, work);
  const half = div(fromInt(1n, work), fromInt(2n, work), work);
  let result = add(
    div(zPow1mS, fromInt(BigInt(s - 1), work), work),
    mul(half, zPowMS, work),
    work,
  );
  // Correction series. At k=1 the term is
  //     B_2 · (s)_1 / (2! · z^{s+1})
  //   = (1/6) · s / (2 · z^{s+1}).
  // We track `zPow` = 1/z^{s+2k-1} starting at 1/z^{s+1} for k=1 and
  // advance by *1/z² each iteration.
  //
  // We also track the Pochhammer numerator (s)_{2k-1} as a BigInt running
  // product, and the (2k)! denominator likewise. Both are exact integers;
  // we form the BigFloat ratio once per term.
  let zPow = mul(zPowMS, oneOverZ, work); // 1/z^{s+1}.
  // Pochhammer (s)_1 = s. After k=1, push to (s)_3 = s(s+1)(s+2), etc.
  // We maintain `pochNum` so that at the top of iteration k it equals
  // (s)_{2k-1}.
  let pochNum = BigInt(s);
  // (2k)! similarly.
  let factDen = 2n; // 2! at k=1.
  let prevTermMag = Infinity;
  for (let k = 1; k <= 600; k++) {
    const B2k = bernoulli(2 * k, work);
    if (B2k.mantissa === 0n) {
      // B_{2k} should be nonzero for all k ≥ 1; only happens at precision
      // underflow, which means we've reached the noise floor.
      break;
    }
    // Coefficient as a BigFloat: pochNum / factDen. Built via the same
    // long-division pattern as `bernoulli` so we get a properly-normalised
    // BigFloat without round-tripping through fromInt + div twice.
    const coeff = ratioBigInt(pochNum, factDen, work);
    const term = mul(mul(B2k, coeff, work), zPow, work);
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits;
    if (termMag < -prec - 16) {
      result = add(result, term, work);
      break;
    }
    // Divergence guard — Poincaré-asymptotic series.
    if (termMag > prevTermMag) {
      break;
    }
    result = add(result, term, work);
    prevTermMag = termMag;
    // Advance Pochhammer: (s)_{2(k+1)-1} = (s)_{2k+1} =
    //   (s)_{2k-1} · (s + 2k - 1) · (s + 2k).
    pochNum = pochNum * BigInt(s + 2 * k - 1) * BigInt(s + 2 * k);
    // Advance factorial: (2(k+1))! = (2k)! · (2k+1) · (2k+2).
    factDen = factDen * BigInt(2 * k + 1) * BigInt(2 * k + 2);
    // Advance zPow: 1/z^{s+2(k+1)-1} = 1/z^{s+2k+1} = current · 1/z².
    zPow = mul(zPow, oneOverZ2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// CVZ lane — Cohen-Villegas-Zagier acceleration via the eta-transform
// =============================================================================
//
// The Euler-Maclaurin lane above is *asymptotic* in `1/a`: at small `a`
// it has no convergent regime at all and must first shift `a` up past
// `hurwitzShiftThreshold` before its series is usable. The
// Cohen-Villegas-Zagier (CVZ) method offers the structurally opposite
// trade — a *geometrically* convergent evaluation with no divergence
// regime — at the cost of only working on *alternating* series. The two
// pieces below bridge that gap: a CVZ accelerator for an alternating
// series, and the eta-transform that turns the (non-alternating) Hurwitz
// zeta into something the accelerator can consume.
//
// Piece 1 — the CVZ accelerator (Algorithm 1 of the 2000 paper)
// -------------------------------------------------------------
//
// Given an alternating series `S = Σ_{k≥0} (-1)^k t_k` whose terms `t_k`
// are the moments `t_k = ∫_0^1 x^k dμ(x)` of a positive measure on
// `[0, 1]`, CVZ Algorithm 1 estimates `S` from the first `n` terms by a
// weighted partial sum that is *exact* to `(3 + √8)^{-n}` — i.e. it
// converges geometrically at `log₂(3 + √8) ≈ 2.5429` bits per term,
// regardless of how slowly `t_k` itself decays. The construction:
//
//   d_n   = the integer with d_0 = 1, d_1 = 3, d_n = 6·d_{n-1} − d_{n-2}
//           (equivalently d_n = ½·((3+√8)^n + (3−√8)^n) — a Chebyshev /
//           Pell-style integer sequence; the `d_n` are *exact integers*,
//           which is what keeps the whole lane inside the `arbprec`
//           determinism contract — no transcendental √8 ever appears).
//   b     ← −1
//   c     ← −d_n
//   S_acc ← 0
//   for k = 0 … n−1:
//       c     ← b − c
//       S_acc ← S_acc + c · t_k
//       b     ← b · (k+n)(k−n) / ((k+½)(k+1))
//   return S_acc / d_n
//
// The `b` factor is a rational running product; written with an exact
// integer numerator/denominator it is `b · 2(k+n)(k−n) / ((2k+1)(k+1))`.
// `(k+n)(k−n) = k² − n²` is negative for every `k < n`, so the sign of
// `b` walks deterministically — the `b ← −1` initialiser (NOT `+1`) is
// load-bearing; starting at `+1` produces a completely wrong sum (it was
// the first transcription bug caught during this lane's bring-up).
//
// Why the moment-sequence hypothesis holds for Hurwitz zeta: each term
// `(a+k)^{-s}` is a moment, because
//
//     (a+k)^{-s} = (1/Γ(s)) ∫_0^∞ x^{s-1} e^{-(a+k)x} dx
//                = (1/Γ(s)) ∫_0^1 u^{a+k-1} (−ln u)^{s-1} du   (u = e^{-x})
//
// so `t_k = (a+k)^{-s}` is `∫_0^1 u^k · [u^{a-1}(−ln u)^{s-1}/Γ(s)] du`,
// the k-th moment of a positive measure on `[0, 1]`. CVZ therefore
// applies and delivers the full geometric rate.
//
// Piece 2 — the eta-transform (non-alternating ζ ⇒ alternating)
// -------------------------------------------------------------
//
// CVZ accelerates an *alternating* series; the Hurwitz zeta
// `Σ (a+k)^{-s}` has all-positive terms. The bridge is the alternating
// Hurwitz eta function
//
//     η(s, a) = Σ_{k≥0} (-1)^k (a+k)^{-s}
//
// — which CVZ evaluates directly in one geometric pass — together with
// the exact even/odd split of the defining sum:
//
//     ζ(s,a) − η(s,a) = 2 · Σ_{k odd} (a+k)^{-s}
//                     = 2 · Σ_{j≥0} (a + 2j + 1)^{-s}
//                     = 2 · 2^{-s} · Σ_{j≥0} ((a+1)/2 + j)^{-s}
//                     = 2^{1-s} · ζ(s, (a+1)/2)
//
// Rearranged, this is the recurrence the CVZ lane runs:
//
//     ζ(s, a) = η(s, a) + 2^{1-s} · ζ(s, (a+1)/2)
//
// Unrolling — with a_0 = a and a_{j+1} = (a_j + 1)/2 — gives the exact
// telescoped form
//
//     ζ(s, a) = Σ_{j≥0} 2^{j(1-s)} · η(s, a_j).
//
// The prefactor `2^{j(1-s)}` halves (at least) every step for `s ≥ 2`,
// so the series converges *geometrically* in `j`: stopping after
// `J ≈ prec / (s−1)` steps leaves a tail bounded by `2^{J(1-s)}` times a
// bounded `Σ η`, i.e. below `2^{-prec}`. Each step is one CVZ-accelerated
// `η` evaluation, itself `O(prec)` terms; the whole lane is therefore
// `O(prec)` η-evaluations of `O(prec)` terms each.
//
// Lane selection — why the production dispatch stays on Euler-Maclaurin
// ---------------------------------------------------------------------
//
// The CVZ lane is correct and geometrically convergent with no
// asymptotic-divergence regime — exactly the structural property the R2
// critical review wanted for small `a`. But the cost accounting is
// decisive and, for the integer-`s ≥ 2` regime, settles the question
// *against* CVZ:
//
//   • Euler-Maclaurin-with-shift: the shift count `N` is *capped* at
//     `hurwitzShiftThreshold(prec, s) ≈ 0.17·prec` and does NOT grow as
//     `a → 0` (a smaller `a` just means `N` reaches the cap; the first
//     shift term `a^{-s}` is large but exact). The EM core then runs
//     `K ≈ π·N/e` Bernoulli terms. Total: `O(prec)` BigFloat ops, with
//     a small constant. Measured: 1–5 ms for `a` from 10⁻⁶ to 1 at
//     prec = 200–400 (see the task report's timing block).
//
//   • CVZ via eta-transform: `J ≈ prec/(s−1)` recurrence steps, each a
//     CVZ `η` evaluation of `n ≈ prec/log₂(3+√8) ≈ prec/2.54` terms.
//     Total: `O(prec²/(s−1))` BigFloat ops — asymptotically *worse* than
//     Euler-Maclaurin, and slower in absolute terms at every integer `s`
//     and precision measured.
//
// The reason CVZ wins for the Lerch transcendent but not here: the
// Lerch series `Σ z^k (a+k)^{-s}` at `|z| < 1` is *already* geometric,
// and at `z = −1` it is *already* alternating — one CVZ pass suffices.
// Plain Hurwitz zeta is `z = 1`: neither geometric nor alternating, so
// the eta-transform's `O(prec)`-step recurrence is unavoidable and the
// per-step CVZ cost compounds.
//
// Per CLAUDE.md's "honest scope" rule and the bead's explicit
// instruction — *"if the dispatch turns out not worth it for the
// integer-`s` regime, that is an honest finding — say so and gate
// conservatively rather than shipping a slower path"* — `bigHurwitzZeta`
// therefore always routes to the Euler-Maclaurin lane. The CVZ lane is
// retained, exported as `_hurwitzZetaCVZ`, cross-validated bit-for-bit
// against Euler-Maclaurin in the test suite, and documented as the
// foundation for the future complex-`s` extension. Keeping the public
// dispatch on Euler-Maclaurin is also what makes the polygamma path —
// `polygamma(m≥2, ·)` routes through `bigHurwitzZeta` — byte-identical
// across the addition of this lane.

/**
 * CVZ-accelerated evaluator of the alternating Hurwitz eta function
 *
 *     η(s, a) = Σ_{k≥0} (-1)^k (a+k)^{-s}        integer s ≥ 2, a > 0.
 *
 * Implements Cohen-Villegas-Zagier Algorithm 1 (see the §"CVZ lane"
 * block above for the derivation and the moment-sequence justification).
 * The accelerator is exact to `(3+√8)^{-n} ≈ 2^{-2.54 n}`, so `n` terms
 * deliver `≈ 2.54·n` bits; the caller passes `n` already sized for the
 * target precision plus margin.
 *
 * The `d_n` weights are the exact integer Pell-Chebyshev sequence
 * `d_0 = 1, d_1 = 3, d_k = 6 d_{k-1} − d_{k-2}`; the `b` running factor
 * is an exact BigInt ratio `bNum / bDen`. No transcendental ever enters,
 * so the lane inherits the `arbprec: true` determinism contract — same
 * `(s, a, n, prec)` bytes ⇒ byte-identical `BigFloat` forever.
 *
 * MUTATION-PROOF MARKER: the CVZ recurrence is initialised `b ← −1`,
 * `c ← −d_n`. Starting `b ← +1` (the natural-looking but wrong choice)
 * inverts the weight signs and the accelerated sum is grossly wrong —
 * pinned by the `_hurwitzZetaCVZ`-vs-Euler-Maclaurin agreement tests.
 * The `d_n` recurrence is `6 d_{k-1} − d_{k-2}`; using `+` or a wrong
 * coefficient breaks the geometric exactness and the agreement tests
 * go RED.
 */
function hurwitzEtaCVZ(
  s: number,
  a: BigFloat,
  n: number,
  prec: number,
): BigFloat {
  const work = prec + 32;
  // Exact integer CVZ weight d_n via the recurrence d_0 = 1, d_1 = 3,
  // d_k = 6·d_{k-1} − d_{k-2}. Only `d_n` itself is needed (CVZ
  // Algorithm 1 uses the single final weight), so we carry the running
  // pair rather than the whole array.
  let dPrev = 1n; // d_0
  let dn = 3n; // d_1 (also the answer when n === 1)
  if (n === 0) {
    dn = 1n;
  } else {
    for (let k = 2; k <= n; k++) {
      const next = 6n * dn - dPrev;
      dPrev = dn;
      dn = next;
    }
  }
  // CVZ Algorithm 1. `b` is kept as the exact BigInt ratio bNum / bDen;
  // `c` is an integer (b − c stays integral because b is integral until
  // the first non-trivial `b` update — see below). To stay exact we
  // accumulate `c` as a BigInt and form `c · t_k` as a BigFloat per term.
  //
  // Subtlety: after the first `b ← b · 2(k+n)(k−n)/((2k+1)(k+1))` update
  // `b` is generally a non-integer rational. We therefore carry `b` and
  // `c` BOTH as exact BigInt ratios over a common denominator. The
  // denominator is the running product `Π (2k+1)(k+1)`, which we divide
  // out only when forming the BigFloat term — keeping every weight exact
  // until the single rounding at term assembly.
  let bNum = -1n; // b starts at −1.
  let bDen = 1n;
  let cNum = -dn; // c starts at −d_n.
  let cDen = 1n;
  let acc: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
  for (let k = 0; k < n; k++) {
    // c ← b − c, over the common denominator.
    const num = bNum * cDen - cNum * bDen;
    const den = bDen * cDen;
    cNum = num;
    cDen = den;
    // term contribution: (cNum / cDen) · (a+k)^{-s}.
    const ak = add(a, fromInt(BigInt(k), work), work);
    const akPow = powInt(ak, -s, work);
    const weight = ratioBigInt(cNum, cDen, work);
    acc = add(acc, mul(weight, akPow, work), work);
    // b ← b · 2(k+n)(k−n) / ((2k+1)(k+1)).
    // (k+n)(k−n) = k² − n²  (negative for k < n).
    const factorNum = 2n * BigInt(k + n) * BigInt(k - n);
    const factorDen = BigInt(2 * k + 1) * BigInt(k + 1);
    bNum = bNum * factorNum;
    bDen = bDen * factorDen;
    // Reduce the b ratio so the BigInts do not grow without bound. The
    // gcd reduction is exact — it never changes the value, only the
    // representation — and is what keeps the loop's BigInt arithmetic
    // O(n·prec)-bit rather than O(n²)-bit.
    const g = bigintGcd(bNum < 0n ? -bNum : bNum, bDen);
    if (g > 1n) {
      bNum /= g;
      bDen /= g;
    }
  }
  // η(s, a) = acc / d_n.
  const result = div(acc, fromInt(dn, work), work);
  return normalise(result.mantissa, result.exponent, prec);
}

/** Exact BigInt gcd (Euclid). Used to keep the CVZ `b`-ratio reduced. */
function bigintGcd(x: bigint, y: bigint): bigint {
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Hurwitz zeta `ζ(s, a) = Σ_{k≥0} (a+k)^{-s}` for integer order `s ≥ 2`,
 * real `a > 0`, evaluated through the Cohen-Villegas-Zagier lane: the
 * eta-transform recurrence
 *
 *     ζ(s, a) = Σ_{j≥0} 2^{j(1-s)} · η(s, a_j),   a_0 = a, a_{j+1} = (a_j+1)/2,
 *
 * with each `η(s, a_j)` evaluated by `hurwitzEtaCVZ`. See the §"CVZ lane"
 * block above for the full derivation, the moment-sequence justification,
 * and — critically — the §"Lane selection" finding that this lane is
 * *not* on the production dispatch (it is slower than Euler-Maclaurin for
 * integer `s ≥ 2`).
 *
 * This function is exported as `_hurwitzZetaCVZ` for cross-validation
 * testing and as a documented building block for the future complex-`s`
 * extension. It is exact to `prec` bits — the test suite pins it against
 * the Euler-Maclaurin lane to `prec − 8` bits across the small-`a`
 * regime.
 *
 * Geometric convergence: the recurrence is truncated after `J` steps,
 * where `J` is chosen so the prefactor `2^{J(1-s)}` is below `2^{-prec}`.
 * The dropped tail `Σ_{j≥J} 2^{j(1-s)} η(s,a_j)` is bounded by
 * `2^{J(1-s)} · sup_j|η(s,a_j)| / (1 − 2^{1-s})`, hence below the noise
 * floor. Each `η` call uses `n ≈ prec/2.5 + margin` CVZ terms — enough
 * for the `(3+√8)^{-n}` accelerator to clear `prec` bits.
 *
 * MUTATION-PROOF MARKER: the eta-transform recurrence prefactor is
 * `2^{j(1-s)}` (a *negative*-exponent power, shrinking) and the recurred
 * argument is `(a_j + 1)/2` (moving toward 1). Using `2^{j(s-1)}`
 * (growing) or recurring `2 a_j − 1` (moving away from 1) diverges; the
 * cross-validation-against-Euler-Maclaurin tests pin both.
 */
export function _hurwitzZetaCVZ(
  s: number,
  a: BigFloat,
  prec: number,
): BigFloat {
  if (!Number.isInteger(s) || s < 2) {
    throw new RangeError(
      `_hurwitzZetaCVZ: s must be integer ≥ 2; got ${s}`,
    );
  }
  const work = prec + 64;
  // CVZ term count: the accelerator is exact to (3+√8)^{-n} ≈ 2^{-2.54 n},
  // so n ≈ prec/2.54 clears `prec` bits; +16 absorbs the assembly rounding.
  const n = Math.ceil(work / 2.5) + 16;
  // Recurrence step count: 2^{J(1-s)} < 2^{-work} ⇒ J > work/(s-1). The
  // +8 margin pushes the dropped tail comfortably below the noise floor.
  const J = Math.ceil(work / (s - 1)) + 8;
  let total: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
  let aj = a;
  const half = div(fromInt(1n, work), fromInt(2n, work), work);
  for (let j = 0; j < J; j++) {
    // prefactor 2^{j(1-s)} = 2^{-j(s-1)}.
    const prefExp = -j * (s - 1);
    // 2^{prefExp} as a BigFloat: mantissa 1, exponent prefExp.
    const pref: BigFloat = { mantissa: 1n, exponent: prefExp, precision: work };
    const eta = hurwitzEtaCVZ(s, aj, n, work);
    total = add(total, mul(pref, eta, work), work);
    // Early-out: once the prefactor is below the noise floor, every
    // remaining term is too, and `η` is O(1)-bounded — stop.
    if (prefExp < -work - 16) break;
    // a_{j+1} = (a_j + 1)/2.
    aj = mul(add(aj, fromInt(1n, work), work), half, work);
  }
  return normalise(total.mantissa, total.exponent, prec);
}

/**
 * Hurwitz zeta `ζ(s, a) = Σ_{k≥0} (a+k)^{-s}` for integer order `s ≥ 2`
 * and real `a > 0`.
 *
 * This is the first-class public Hurwitz-zeta substrate. Unlike the v0.1
 * private helper it replaces, it is *self-shifting*: the caller does NOT
 * pre-shift `a`. The function detects when `a` is below the
 * Euler-Maclaurin shift threshold and applies the shift recurrence
 * internally.
 *
 * Algorithm:
 *
 *   1. Shift recurrence (telescoping the defining series):
 *          ζ(s, a) = Σ_{k=0}^{N-1} (a+k)^{-s}  +  ζ(s, a+N).
 *      This is exact — it just splits the sum `Σ_{k≥0}` at index `N`. We
 *      choose `N` so that `a + N > hurwitzShiftThreshold(prec, s)`, large
 *      enough for the Euler-Maclaurin asymptotic at step 3 to converge to
 *      the noise floor.
 *
 *   2. Compute the finite shift sum `Σ_{k=0}^{N-1} (a+k)^{-s}` directly.
 *      Each term is `powInt(a+k, -s)` — `powInt` accepts negative exponents
 *      and inverts once at the end (a single division per term). `s` is
 *      small and `N` is `O(prec)`, so this is the right cost shape.
 *
 *   3. Evaluate `ζ(s, a+N)` via the Euler-Maclaurin core
 *      `hurwitzZetaEulerMaclaurin`, whose precondition `a+N >
 *      shiftThreshold` is now guaranteed.
 *
 *   4. Return `shiftSum + ζ(s, a+N)`.
 *
 * Why self-shifting is non-negotiable for a public API: the Euler-Maclaurin
 * series is Poincaré-asymptotic in `1/a`, so at small `a` even its smallest
 * term is large and `2^{-prec}` accuracy is unreachable. A public function
 * that called the core directly on a small-`a` input would return a
 * plausible-looking but *wrong* value — a silent lie, which CLAUDE.md
 * Rule 1 forbids. The shift trades `N ≈ shiftThreshold − a` cheap
 * arithmetic operations for an asymptotic series that actually converges.
 *
 * Domain: integer `s ≥ 2`, real `a > 0`. Non-integer `s`, `s ≤ 1`
 * (including the `s = 1` pole of ζ), and `a ≤ 0` throw a loud `RangeError`
 * — v0.1 scope is integer `s ≥ 2`; the general-complex-`s` extension is a
 * documented v0.2-of-v0.2 lift (see the module header).
 *
 * Lane: this function always routes to the Euler-Maclaurin lane. The
 * Cohen-Villegas-Zagier lane (`_hurwitzZetaCVZ`) is correct and
 * geometrically convergent but, as the §"Lane selection" block above
 * establishes, it is *slower* than Euler-Maclaurin for integer `s ≥ 2` —
 * so it is deliberately kept off the public dispatch. Keeping the
 * dispatch unconditionally on Euler-Maclaurin is also what makes the
 * polygamma path (`polygamma(m≥2, ·)` routes through this function)
 * byte-identical across the addition of the CVZ lane.
 *
 * MUTATION-PROOF MARKER: the shift recurrence is `ζ(s,a) = Σ_{k<N}(a+k)^{-s}
 * + ζ(s,a+N)` — the shift sum is *added*, not subtracted, because we are
 * splitting `Σ_{k≥0}` into a head and a tail. Subtracting it (or evaluating
 * the EM core at `a` without the shift) collapses precision. Pinned by the
 * below-threshold-`a` self-shift tests and by the `bigRiemannZeta(s)` tests
 * (where `a = 1` is itself below threshold and must shift correctly).
 */
export function bigHurwitzZeta(s: number, a: BigFloat, prec: number): BigFloat {
  if (!Number.isInteger(s) || s < 2) {
    throw new RangeError(
      `bigHurwitzZeta: order s must be an integer ≥ 2 (v0.1 scope); ` +
        `got ${s}. General complex s is a documented v0.2 extension.`,
    );
  }
  const aFloat = toFloat64(a).value;
  if (!Number.isFinite(aFloat)) {
    throw new RangeError(`bigHurwitzZeta: argument a is not finite`);
  }
  if (aFloat <= 0) {
    throw new RangeError(
      `bigHurwitzZeta: argument a must be > 0; got ${aFloat}. ` +
        `ζ(s, a) has poles at a = 0, -1, -2, … for this branch.`,
    );
  }
  // Working precision is `prec` directly: the shift sum and the
  // Euler-Maclaurin tail are both computed at `prec`, and the EM core bumps
  // its own working precision by 32 bits internally. This schedule is
  // deliberately *not* given an extra outer `+32` bump — it reproduces, to
  // the bit, what the v0.1 inline helper did when its caller passed an
  // already-margined `prec`. Callers that need headroom for downstream
  // amplification (e.g. `polygamma`'s `m!` multiplier) pass an enlarged
  // `prec` themselves; the public API does not silently inflate precision,
  // which keeps the polygamma path byte-identical across the extraction
  // (ADR-0042 §Decision 12 acceptance gate).
  const shiftThreshold = hurwitzShiftThreshold(prec, s);
  // Number of recurrence steps so that `a + N` clears the threshold.
  const N = Math.max(0, Math.ceil(shiftThreshold - aFloat));
  // Shift sum: Σ_{k=0}^{N-1} (a+k)^{-s}.
  let shiftSum: BigFloat = { mantissa: 0n, exponent: 0, precision: prec };
  for (let k = 0; k < N; k++) {
    const ak = add(a, fromInt(BigInt(k), prec), prec);
    const inv = powInt(ak, -s, prec);
    shiftSum = add(shiftSum, inv, prec);
  }
  // Euler-Maclaurin tail at the shifted argument a + N.
  const aShifted = N > 0 ? add(a, fromInt(BigInt(N), prec), prec) : a;
  const tail = hurwitzZetaEulerMaclaurin(s, aShifted, prec);
  const total = add(shiftSum, tail, prec);
  return normalise(total.mantissa, total.exponent, prec);
}

/**
 * Riemann zeta `ζ(s) = Σ_{k≥1} k^{-s}` for integer order `s ≥ 2`.
 *
 * The Riemann zeta is the `a = 1` specialisation of the Hurwitz zeta:
 * `ζ(s) = ζ(s, 1)` because `Σ_{k≥0} (1+k)^{-s} = Σ_{j≥1} j^{-s}`. We simply
 * delegate to `bigHurwitzZeta(s, 1, prec)`.
 *
 * Note `a = 1` is itself well below `hurwitzShiftThreshold`, so the call
 * exercises `bigHurwitzZeta`'s self-shift in full — the shift recurrence
 * walks `1 → 1 + N` and the Euler-Maclaurin core sees the shifted
 * argument. This is correct (and is exactly the path that would have been
 * wrong under the v0.1 private helper without a caller pre-shift).
 *
 * Closed-form anchors: ζ(2) = π²/6 (Basel), ζ(4) = π⁴/90, ζ(6) = π⁶/945,
 * and the odd-`s` value ζ(3) = 1.2020569031595942853997… (Apéry's constant).
 *
 * Domain: integer `s ≥ 2`. `s = 1` (the pole of ζ) and `s ≤ 0` throw via
 * `bigHurwitzZeta`'s order check.
 */
export function bigRiemannZeta(s: number, prec: number): BigFloat {
  return bigHurwitzZeta(s, fromInt(1n, prec), prec);
}
