// =============================================================================
// Slater residue-summation formulae — Series 1 and Series 2
// =============================================================================
//
// Series 1 (residues at the `Γ(b_j − s)` poles, j = 1..m):
//
//     G^{m,n}_{p,q}(z)
//       = Σ_{h=1}^m   A_h · z^{b_h} · pF_{q-1}\big(\!\;\!\;\;\;; \zeta_1·z\big)
//
//   where
//
//                ∏_{j ≠ h,  j ≤ m}  Γ(b_j − b_h)
//                · ∏_{j ≤ n}        Γ(1 + b_h − a_j)
//        A_h = ─────────────────────────────────────────────────
//                ∏_{j > m,  j ≤ q}  Γ(1 + b_h − b_j)
//                · ∏_{j > n,  j ≤ p}  Γ(a_j − b_h)
//
//   inner pFq:
//        upper (p)   : 1 + b_h − a_j     for j = 1..p
//        lower (q-1) : 1 + b_h − b_j     for j = 1..q  (j = h omitted)
//        argument    : (−1)^{p − m − n} · z
//
// Series 2 (residues at the `Γ(1 − a_j + s)` poles, j = 1..n) is the
// h ↔ a-side mirror, with
//
//        upper (q)   : 1 + b_j − a_h     for j = 1..q
//        lower (p-1) : 1 + a_j − a_h     for j = 1..p  (j = h omitted)
//        argument    : (−1)^{q − m − n} / z
//
// The implementations below are direct transcriptions: every product is
// a straight line of `cmul`/`cdiv` against `cgamma` factors at the
// declared working precision. The only cleverness is the residue-line
// sign in `(−1)^{p − m − n}` (resp. `q − m − n`), which we apply once
// up front by negating `z` rather than threading it through every
// inner-pFq call.
//
// Each function returns the residue-line list — an array of complex
// values, one per residue line — *without* summing them. The caller
// (`slater.ts`) sums the list and tracks `max_h |term_h|` against
// `|sum|` to decide whether the working precision was sufficient or a
// retry-at-higher-precision is needed.

import {
  type BigComplex,
  cadd,
  cdiv,
  cfromReal,
  cgamma,
  cmul,
  cneg,
  cpow,
  csub,
  fromInt,
} from "@workbench/bigfloat";
import { evaluatePFq, type PFqResult } from "@workbench/hypergeometric";
import type { MeijerGParameters } from "./types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Build `1 + a − b` at the specified working precision. */
function onePlusSub(
  a: BigComplex,
  b: BigComplex,
  workPrec: number,
): BigComplex {
  const one = cfromReal(fromInt(1n, workPrec));
  return cadd(one, csub(a, b, workPrec), workPrec);
}

/** Plain `a − b` at the specified working precision. */
function diff(a: BigComplex, b: BigComplex, workPrec: number): BigComplex {
  return csub(a, b, workPrec);
}

/**
 * Negate `z` iff `(−1)^k = −1`, i.e. iff `k` is odd. Used for the
 * `(−1)^{p−m−n}` (or `(−1)^{q−m−n}`) sign factor in the inner-pFq
 * argument. We work in BigComplex, not BigFloat, so the sign threads
 * cleanly through the rest of the pipeline.
 */
export function applySign(z: BigComplex, k: number): BigComplex {
  // `k` may be negative (e.g., `p − m − n = -2`); modular arithmetic
  // on the parity is what we want.
  const odd = ((k % 2) + 2) % 2 === 1;
  return odd ? cneg(z) : z;
}

// -----------------------------------------------------------------------------
// Result type — one residue line
// -----------------------------------------------------------------------------

/**
 * Single residue-line value plus a refusal slot for the inner pFq.
 *
 * The orchestrator surveys this list: if any entry has `pfq.status`
 * other than `"success"`, the whole Slater path falls through to the
 * non-convergent-pfq refusal.
 */
export interface ResidueTerm {
  readonly value: BigComplex;
  readonly innerPFq: PFqResult;
  /** Number of inner-pFq summands, for diagnostics. */
  readonly nTerms: number;
}

// -----------------------------------------------------------------------------
// Series 1
// -----------------------------------------------------------------------------

/**
 * Evaluate the `m` residue lines of Slater Series 1 at the given
 * working precision (decimal digits). Returns the per-line values; the
 * caller is responsible for summing.
 *
 * Throws on mathematical impossibility (an exact non-positive integer
 * argument to `Γ` in the prefactor); structured pFq refusals are
 * folded into the `innerPFq` field of each `ResidueTerm`.
 */
export function evaluateSeries1(
  params: MeijerGParameters,
  z: BigComplex,
  workingDecimal: number,
  workingBits: number,
): ResidueTerm[] {
  const { an, ap, bm, bq } = params;
  const m = bm.length;
  const n = an.length;
  const p = n + ap.length;
  const q = m + bq.length;

  const zArg = applySign(z, p - m - n);

  const terms: ResidueTerm[] = [];

  for (let h = 0; h < m; h++) {
    const bh = bm[h]!;

    // Prefactor numerator.
    let numer = cfromReal(fromInt(1n, workingBits));
    for (let j = 0; j < m; j++) {
      if (j === h) continue;
      numer = cmul(numer, cgamma(diff(bm[j]!, bh, workingBits), workingBits), workingBits);
    }
    for (let j = 0; j < n; j++) {
      numer = cmul(numer, cgamma(onePlusSub(bh, an[j]!, workingBits), workingBits), workingBits);
    }

    // Prefactor denominator.
    let denom = cfromReal(fromInt(1n, workingBits));
    for (let j = 0; j < bq.length; j++) {
      denom = cmul(denom, cgamma(onePlusSub(bh, bq[j]!, workingBits), workingBits), workingBits);
    }
    for (let j = 0; j < ap.length; j++) {
      denom = cmul(denom, cgamma(diff(ap[j]!, bh, workingBits), workingBits), workingBits);
    }

    const A = cdiv(numer, denom, workingBits);
    const zPow = cpow(z, bh, workingBits);

    // Inner-pFq parameter lists.
    const upper: BigComplex[] = [];
    for (let j = 0; j < n; j++) upper.push(onePlusSub(bh, an[j]!, workingBits));
    for (let j = 0; j < ap.length; j++) upper.push(onePlusSub(bh, ap[j]!, workingBits));

    const lower: BigComplex[] = [];
    for (let j = 0; j < m; j++) {
      if (j === h) continue;
      lower.push(onePlusSub(bh, bm[j]!, workingBits));
    }
    for (let j = 0; j < bq.length; j++) {
      lower.push(onePlusSub(bh, bq[j]!, workingBits));
    }

    const inner = evaluatePFq(upper, lower, zArg, workingDecimal);

    if (inner.status !== "success") {
      // Carry the refusal up; the caller decides whether to retry,
      // perturb, or surface a structured `non-convergent-pfq` refusal.
      terms.push({
        value: cfromReal(fromInt(0n, workingBits)),
        innerPFq: inner,
        nTerms: 0,
      });
      continue;
    }

    const piece = cmul(A, cmul(zPow, inner.value, workingBits), workingBits);
    terms.push({ value: piece, innerPFq: inner, nTerms: inner.nTerms });
  }

  return terms;
}

// -----------------------------------------------------------------------------
// Series 2
// -----------------------------------------------------------------------------

/**
 * Evaluate the `n` residue lines of Slater Series 2 at the given
 * working precision. Mirror of `evaluateSeries1` with the a-side
 * playing the residue-line role.
 */
export function evaluateSeries2(
  params: MeijerGParameters,
  z: BigComplex,
  workingDecimal: number,
  workingBits: number,
): ResidueTerm[] {
  const { an, ap, bm, bq } = params;
  const m = bm.length;
  const n = an.length;
  const p = n + ap.length;
  const q = m + bq.length;

  const oneOverZ = cdiv(cfromReal(fromInt(1n, workingBits)), z, workingBits);
  const zArg = applySign(oneOverZ, q - m - n);

  const terms: ResidueTerm[] = [];

  for (let h = 0; h < n; h++) {
    const ah = an[h]!;

    // Prefactor numerator.
    let numer = cfromReal(fromInt(1n, workingBits));
    for (let j = 0; j < n; j++) {
      if (j === h) continue;
      numer = cmul(numer, cgamma(diff(ah, an[j]!, workingBits), workingBits), workingBits);
    }
    for (let j = 0; j < m; j++) {
      numer = cmul(numer, cgamma(onePlusSub(bm[j]!, ah, workingBits), workingBits), workingBits);
    }

    // Prefactor denominator.
    let denom = cfromReal(fromInt(1n, workingBits));
    for (let j = 0; j < ap.length; j++) {
      denom = cmul(denom, cgamma(onePlusSub(ap[j]!, ah, workingBits), workingBits), workingBits);
    }
    for (let j = 0; j < bq.length; j++) {
      denom = cmul(denom, cgamma(diff(ah, bq[j]!, workingBits), workingBits), workingBits);
    }

    const B = cdiv(numer, denom, workingBits);

    // z^{a_h - 1}.
    const ahMinusOne = csub(ah, cfromReal(fromInt(1n, workingBits)), workingBits);
    const zPow = cpow(z, ahMinusOne, workingBits);

    // Inner-pFq parameter lists.
    const upper: BigComplex[] = [];
    for (let j = 0; j < m; j++) upper.push(onePlusSub(bm[j]!, ah, workingBits));
    for (let j = 0; j < bq.length; j++) upper.push(onePlusSub(bq[j]!, ah, workingBits));

    const lower: BigComplex[] = [];
    for (let j = 0; j < n; j++) {
      if (j === h) continue;
      lower.push(onePlusSub(an[j]!, ah, workingBits));
    }
    for (let j = 0; j < ap.length; j++) {
      lower.push(onePlusSub(ap[j]!, ah, workingBits));
    }

    const inner = evaluatePFq(upper, lower, zArg, workingDecimal);

    if (inner.status !== "success") {
      terms.push({
        value: cfromReal(fromInt(0n, workingBits)),
        innerPFq: inner,
        nTerms: 0,
      });
      continue;
    }

    const piece = cmul(B, cmul(zPow, inner.value, workingBits), workingBits);
    terms.push({ value: piece, innerPFq: inner, nTerms: inner.nTerms });
  }

  return terms;
}
