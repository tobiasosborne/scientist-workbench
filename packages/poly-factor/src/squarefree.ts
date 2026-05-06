// =============================================================================
// squarefree.ts — Yun's square-free factorization (1976) over ℚ
// =============================================================================
//
// What this module computes
// -------------------------
// Given `f ∈ ℚ[x]` of positive degree, return a list `[(a_1, 1),
// (a_2, 2), …]` such that
//
//     f = lc(f) · ∏_i a_i^i
//
// with each `a_i` **monic, square-free, and pairwise coprime** to every
// other `a_j`. The reconstruction is exact in ℚ[x]; lc(f) is the
// leading coefficient of `f` in the principal variable. Multiplicities
// not realized in `f` are absent from the list (so `f = (x-1)^3·(x+1)^2`
// returns just `[(x+1, 2), (x-1, 3)]`, not entries for `i = 1` or
// `i ≥ 4`).
//
// Why this is the right entry point for poly-factor
// -------------------------------------------------
// The full ℚ-factorization pipeline (`tools/poly-factor`) splits into
// four phases: (1) square-free decomposition, (2) factor each
// square-free piece over `𝔽_p`, (3) Hensel-lift to `ℤ/p^k`, (4)
// recombine to `ℤ`. Square-free decomposition is the cheapest step and
// the one with the cleanest invariants, so it ships first as substrate
// for the more involved beads. It is also useful on its own: `tools/
// poly-roots` consumes squarefree-decomposed input to avoid working
// with multiplicity, and `real-root-isolate` (Sturm) requires
// squarefree input as a precondition.
//
// Algorithm — Yun 1976 (single-variable, characteristic 0)
// --------------------------------------------------------
// The classical "squarefree factorization in characteristic 0" via
// repeated GCD with the derivative. Pseudocode (where `b'` denotes
// `polyDeriv(b, "x")`):
//
//     a = gcd(f, f')                  // collects all multi-roots
//     b = f / a                        // squarefree-of-distinct-roots of f
//     c = f' / a − b'                  // recursion seed: deg(c) < deg(b)
//     i = 1, output = []
//     while b ≠ 1:
//         d = gcd(b, c)
//         if d ≠ 1: output.append((d, i))
//         b = b / d
//         c = c / d − b'
//         i += 1
//     return output
//
// Correctness rests on a calculus identity: for `f = ∏_k g_k^k`
// (each g_k monic square-free pairwise coprime), `gcd(f, f') = ∏_k g_k^(k-1)`.
// One Yun iteration peels off the smallest-multiplicity factor (k=1
// outermost), and `c` carries the bookkeeping that lets the recursion
// progress without repeated derivatives.
//
// Implementation notes
// --------------------
// • Leading-coefficient preservation: `polyGcd` and `polyDivExact`
//   produce monic results, so every `a_i` in the output is monic. The
//   original `lc(f)` lives outside the factor list — the caller
//   reconstructs `f = lc(f) · ∏ a_i^i`. Exposing `lc(f)` separately is
//   the cleanest API: callers that don't care can ignore it; callers
//   that do (e.g., `tools/poly-factor` for content extraction) reach
//   for `polyLeadingCoef(f)` themselves.
// • Empty output for constant input: a degree-0 polynomial has no
//   non-constant factors. Yun returns `[]` and leaves all the structure
//   in `lc(f)`.
// • Zero input rejection: `f = 0` is malformed (no defined leading
//   coefficient, infinite multiplicities). Throws.
// • Loop bound: `i` is capped at `deg(f) + 1` to defend against any
//   future bug producing infinite iteration; under correct algorithm
//   semantics the loop always terminates within `deg(f)` iterations
//   (each `i` peels at least one degree off `b` once `d ≠ 1`).
//
// Reference: Yun, *On square-free decomposition algorithms*, SYMSAC
// '76. Reproduced verbatim in Cox-Little-O'Shea §4.5 (local PDF
// `docs/ground-truth/factor/cox-little-oshea-ideals-varieties-algorithms-4th.pdf`).

import {
  type Poly,
  polyDeriv,
  polyDegInVar,
  polyDivExact,
  polyGcd,
  polyIsOne,
  polyIsZero,
  polySub,
  RAT_RING,
  type Rat,
} from "@workbench/cas-core";

export interface SquareFreeFactor {
  /** Monic square-free polynomial; pairwise coprime to other factors. */
  readonly factor: Poly<Rat>;
  /** Multiplicity ≥ 1 with which this factor appears in the input. */
  readonly multiplicity: number;
}

/**
 * Yun's square-free factorization of `f ∈ ℚ[x]`.
 *
 * Returns `[(a_i, i), …]` such that `f = lc(f) · ∏_i a_i^i`, with each
 * `a_i` monic and square-free, and every pair `(a_i, a_j)` coprime.
 * Multiplicities not present in `f` are omitted from the result.
 *
 * @param f - Univariate polynomial over ℚ. Must be non-zero.
 * @param v - Name of the principal variable (typically "x").
 *            Polynomials in cas-core are multivariate `Poly<Rat>`; a
 *            "univariate polynomial in v" is one whose only mentioned
 *            variable is `v`.
 * @throws {Error} if `f` is the zero polynomial.
 */
export function squareFree(f: Poly<Rat>, v: string): SquareFreeFactor[] {
  if (polyIsZero(f)) {
    throw new Error("squareFree: input polynomial is zero");
  }
  // Constant input: no non-constant factors. Whatever the constant is
  // lives in lc(f) (which is f itself when deg = 0).
  if (polyDegInVar(f, v) === 0) {
    return [];
  }

  const fPrime = polyDeriv(f, v, RAT_RING);
  const a = polyGcd(f, fPrime, RAT_RING);
  let b = polyDivExact(f, a, RAT_RING);
  let c = polySub(
    polyDivExact(fPrime, a, RAT_RING),
    polyDeriv(b, v, RAT_RING),
    RAT_RING,
  );

  const output: SquareFreeFactor[] = [];
  let i = 1;
  const safety = polyDegInVar(f, v) + 2;

  // Loop until `b` has no polynomial structure left. We exit on
  // `deg(b) == 0` rather than `polyIsOne(b)` because Yun assumes monic
  // input — if `f` is non-monic, the residual after the last extraction
  // is the constant `lc(f) / 1 = lc(f)`, not 1. That residual is
  // correctly carried by the reconstruction `f = lc(f) · ∏ a_i^i` and
  // does not belong in the factor list.
  while (polyDegInVar(b, v) > 0) {
    if (i > safety) {
      throw new Error(`squareFree: loop bound (${safety}) exceeded; algorithm bug`);
    }
    const d = polyGcd(b, c, RAT_RING);
    if (!polyIsOne(d, RAT_RING)) {
      output.push({ factor: d, multiplicity: i });
    }
    const bNew = polyDivExact(b, d, RAT_RING);
    const cNew = polySub(
      polyDivExact(c, d, RAT_RING),
      polyDeriv(bNew, v, RAT_RING),
      RAT_RING,
    );
    b = bNew;
    c = cNew;
    i++;
  }

  return output;
}
