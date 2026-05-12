// =============================================================================
// simplex — exact-rational two-phase revised simplex method
// =============================================================================
//
// What this module is
// -------------------
// The algorithmic heart of `tools/lp-solve` (ADR-0031). A direct port of the
// revised-simplex method (Dantzig 1947, refined by Bland 1977 with the
// finite-pivoting rule that makes it provably terminating) executed in
// arbitrary-precision rational arithmetic — every comparison, every ratio,
// every pivot operation runs over ℚ via `Rat` from `@workbench/cas-core`.
//
// The substrate above this module is the `BasisInverse` from `./basis.ts`,
// which stores the inverse of the current basis matrix explicitly and offers
// an O(m²) rank-1 product-form update per pivot. The substrate below is
// `@workbench/cas-core`'s `Rat` arithmetic. Nothing else.
//
// The two-phase shape
// -------------------
// LP in standard form:
//
//     minimise  cᵀ x        (n unknowns)
//     subject to  A x = b   (m linear equalities)
//                  x  ≥ 0
//
// We do not assume an initial basic feasible solution exists. Phase 1
// synthesises one: introduce m artificial variables `a_1, …, a_m`, augment
// the system to
//
//     A1 x' = b,     x' = (x; a),     x' ≥ 0,
//     A1 = [A | I_m]
//
// with the Phase 1 cost vector
//
//     c1 = (0, …, 0,   1, …, 1)
//             ↑ n          ↑ m
//
// The initial basis is the identity columns of `I_m`, which is trivially
// invertible and gives `x_B = b`. The Phase 1 objective `sum(a_i)` is
// non-negative; minimising drives the artificials toward zero. Two
// outcomes:
//
//     • Phase 1 optimum > 0  ⟹  no feasible point for `A x = b, x ≥ 0`
//       exists. The final dual `y` is a Farkas certificate of
//       infeasibility (`yᵀ A ≤ 0`, `yᵀ b > 0`).
//
//     • Phase 1 optimum = 0  ⟹  every artificial is at zero. If any
//       artificial is still basic-at-zero, we attempt to drive it out via
//       degenerate pivots; if a row's artificial cannot be replaced
//       (every non-artificial column has a zero entry in that row of
//       `B⁻¹ A`), the row is a linear combination of the others — we
//       drop it and continue. Then Phase 2 begins with the surviving
//       feasible basis.
//
// Phase 2 runs the same main loop with the original cost vector `c` and
// restricts pricing to non-artificial columns. Three outcomes:
//
//     • All reduced costs ≥ 0  ⟹  optimal. The current basic solution
//       is a vertex of the feasible polytope minimising `cᵀ x`.
//     • Entering column has no positive ratio-test entry  ⟹  unbounded.
//       The direction `d` with `d_j = 1`, `d_B = -η`, `d_else = 0`
//       certifies cost `→ -∞` along `x + t d` for `t ≥ 0`.
//     • Iteration cap exhausted before either of the above.
//
// Pricing and the Bland-rule anti-cycling guard
// ---------------------------------------------
// Pricing is the choice of which non-basic variable to bring into the
// basis at each step. Dantzig's original rule — choose the column with
// the most-negative reduced cost — is the default because in practice it
// terminates in O(m + n) pivots on well-behaved problems. But Dantzig's
// rule does not have a *proof* of termination; pathological inputs can
// cycle through the same basis indefinitely (Beale 1955 is the canonical
// six-variable counter-example).
//
// Bland 1977 fixes this with the rule: when degenerate (ratio = 0), choose
// the smallest-index column with negative reduced cost, and break
// leaving-variable ties by smallest basis index. The rule has a beautiful
// short proof of termination — assume for contradiction that a cycle
// exists, consider the largest-indexed variable that enters during the
// cycle, derive a contradiction in two pages. The downside is that
// Bland's rule pivots more often in practice; well-known instances pivot
// over 10× more under Bland than under Dantzig.
//
// We hybridise: Dantzig by default, with a switch to Bland whenever
// `blandThreshold` consecutive degenerate pivots have occurred. The
// switch is local (next `2m` iterations) and reverts to Dantzig after.
// Exact arithmetic makes the switch *bulletproof*: "ratio = 0" is a
// real test, not a tolerance, and degeneracy is detected without false
// positives.
//
// Output contract
// ---------------
// `SimplexResult` is a discriminated union over the engine's view of the
// problem. The `status` field is the engine's native taxonomy:
//
//     optimal | infeasible | unbounded | iter-cap | coefficient-explosion
//
// Each variant carries exactly the artefacts an agent needs to act:
//
//     optimal           ⟹  x, basis, objective, dual, slack
//     infeasible        ⟹  farkas (the dual certifying infeasibility)
//     unbounded         ⟹  ray (the unbounded direction), x (the
//                            current basic solution from which the ray
//                            departs)
//     iter-cap          ⟹  iterations
//     coefficient-      ⟹  achieved bit length, cap, iteration where
//       explosion              the cap was hit
//
// `tools/lp-solve/tool.ts` (the wire wrapper) maps this taxonomy onto
// ADR-0030's public taxonomy (see ADR-0031 §C); the engine itself stays
// closer to the mathematical taxonomy because it is consumed by tests
// and by future internal lanes too.
//
// What is *not* in this module
// ----------------------------
// • Float64 ↔ Rat conversion: the wire layer's job. The engine consumes
//   `StandardLP` over `Rat` and produces `SimplexResult` over `Rat`.
// • Free-variable splitting (`x = x⁺ − x⁻`): the wire layer's job. The
//   engine assumes `x ≥ 0` for every column it sees.
// • Cone-vocabulary parsing (`NonNegCone`, etc.): the wire layer's job.
// • Provenance / canonical-bytes I/O: `runTool`'s job, one level up.
//
// References
// ----------
// Dantzig 1947 *Maximization of a Linear Function of Variables Subject
// to Linear Inequalities*. Bland 1977 *New Finite Pivoting Rules for
// the Simplex Method*, Math. Oper. Res. 2:103–107. Vanderbei *Linear
// Programming* 4th ed., Ch. 6–8 (the textbook of choice). Bertsimas and
// Tsitsiklis *Introduction to Linear Optimisation*, Ch. 3 (two-phase
// initialisation) and Ch. 4 (Bland-rule proof). Beale 1955 *Cycling in
// the dual simplex algorithm*, Naval Res. Logist. Quart. 2:269–276
// (the cycling exemplar).

import {
  type Rat,
  ratAdd,
  ratSub,
  ratMul,
  ratNeg,
  ratIsZero,
  RAT_ZERO,
} from "@workbench/cas-core";
import { ratCompare, ratLt, ratIsPositive, ratBitLength } from "./rat-cmp.js";
import {
  type BasisInverse,
  type RatMatrix,
  type RatVector,
  identityBasisInverse,
  solveBasis,
  solveBasisT,
  pivotUpdate,
  basisBitLength,
  ratDot,
} from "./basis.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * An LP in the standard form the simplex engine accepts:
 *
 *     min  cᵀ x   s.t.  A x = b,  x ≥ 0
 *
 * Constraints on the caller:
 *   • `A.length === b.length` (= m, the number of equalities).
 *   • `A[i].length === c.length` (= n, the number of variables) for every i.
 *   • Every variable is non-negative. Free variables must be split by the
 *     caller into `x = x⁺ - x⁻` before this struct is constructed.
 *   • `b` is *not* required to be non-negative; the engine normalises
 *     rows with `b[i] < 0` by negating the row in its working copy.
 */
export interface StandardLP {
  readonly c: RatVector;
  readonly A: RatMatrix;
  readonly b: RatVector;
}

export interface SimplexOpts {
  /**
   * Cap on total pivots (Phase 1 + Phase 2 combined). Default `10·(m+n)`
   * per ADR-0030 §A.1. Hitting the cap emits `iter-cap` and is reported
   * faithfully — the engine does not silently return the partial answer.
   */
  readonly maxIter?: number;
  /**
   * Cap on `max(bitlen(num), bitlen(den))` over any entry of `B⁻¹`.
   * Exceeding this triggers the `coefficient-explosion` refusal envelope.
   * Default 2²⁰ = 1 048 576 bits per coefficient (~315 000 decimal
   * digits), which is a very generous ceiling; pathological NETLIB
   * problems hit it only in genuinely ill-scaled cases.
   */
  readonly maxBitLength?: number;
  /**
   * Number of consecutive degenerate pivots (ratio = 0) before we switch
   * from Dantzig pricing to Bland's rule. Default `10`. The switch
   * reverts to Dantzig after `2·m` iterations without a degenerate pivot.
   * Lowering this gives a more cautious solver; raising it gives a
   * faster solver on non-pathological instances at the (theoretical)
   * cost of slower termination on pathological ones — but bounded by
   * Bland's proof either way.
   */
  readonly blandThreshold?: number;
}

export type SimplexResult =
  | SimplexOptimal
  | SimplexInfeasible
  | SimplexUnbounded
  | SimplexIterCap
  | SimplexCoeffExplosion;

/** All variants share the iteration count and the observed max bit length. */
interface SimplexCommon {
  readonly iterations: number;
  readonly maxBitLength: number;
}

export interface SimplexOptimal extends SimplexCommon {
  readonly status: "optimal";
  /** Primal solution, length `n`. */
  readonly x: RatVector;
  /** Indices of the optimal basis, length `m`, values in `[0, n)`. */
  readonly basis: ReadonlyArray<number>;
  /** Objective value `cᵀ x` at the optimum. */
  readonly objective: Rat;
  /** Dual solution `y`, length `m`. */
  readonly dual: RatVector;
  /** Slacks `s = c - Aᵀ y`, length `n`. Zero for basic variables. */
  readonly slack: RatVector;
}

export interface SimplexInfeasible extends SimplexCommon {
  readonly status: "infeasible";
  /** Farkas certificate: `yᵀ A ≤ 0` componentwise, `yᵀ b > 0`. Length `m`. */
  readonly farkas: RatVector;
}

export interface SimplexUnbounded extends SimplexCommon {
  readonly status: "unbounded";
  /**
   * A primal point `x` (length `n`) plus a recession direction `ray`
   * (length `n`) such that `A(x + t·ray) = b`, `x + t·ray ≥ 0`, and
   * `cᵀ(x + t·ray) → -∞` as `t → ∞`.
   */
  readonly x: RatVector;
  readonly ray: RatVector;
}

export interface SimplexIterCap extends SimplexCommon {
  readonly status: "iter-cap";
}

export interface SimplexCoeffExplosion {
  readonly status: "coefficient-explosion";
  readonly iterations: number;
  readonly achieved: number;
  readonly cap: number;
}

// -----------------------------------------------------------------------------
// Internal state — mutable inside `simplexSolve`, never exposed.
// -----------------------------------------------------------------------------

interface SimplexState {
  /** Augmented constraint matrix `A1 = [A_norm | I_m]`, with rows
   *  multiplied by `sign(b_i)` so that the Phase-1 initial basic
   *  solution `x_B = b_norm` has `b_norm ≥ 0`. */
  A1: RatMatrix;
  b: RatVector;
  /** Length `n + m`. Cost vector currently in use (changes between phases). */
  c: RatVector;
  /** Per-row sign multiplier: `+1` for rows kept as-is, `-1` for rows
   *  multiplied through. The dual `y_internal` is for the normalised
   *  rows; the user-facing dual is `signs[i] · y_internal[i]`. */
  readonly signs: Int8Array;
  /** Indices into columns of `A1`. Length = number of basis rows
   *  (initially m; may shrink if redundant rows are dropped). */
  basis: number[];
  /** `B⁻¹` for the current basis. */
  invB: BasisInverse;
  /** Current basic variable values `x_B`. Length = basis.length. */
  xB: Rat[];
  /** Row indices into A1 that are *active* — i.e., have not been
   *  declared redundant during Phase 1 cleanup. */
  activeRows: number[];
  /** Total iterations (Phase 1 + Phase 2). */
  iter: number;
  /** Largest bit length seen so far across `B⁻¹`. */
  maxBitLength: number;
  /** Consecutive degenerate (ratio = 0) pivots; resets on a non-degen pivot. */
  degenStreak: number;
  /** Remaining iterations of "Bland mode" before reverting to Dantzig.
   *  When `>0` we use Bland's smallest-index rule for both entering and
   *  leaving. When `0` we use Dantzig's most-negative reduced cost. */
  blandMode: number;
  /** Bookkeeping: which columns are artificials (≥ n). */
  readonly n: number;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export function simplexSolve(
  lp: StandardLP,
  opts: SimplexOpts = {},
): SimplexResult {
  const m0 = lp.A.length;
  const n = lp.c.length;
  validateInput(lp, m0, n);

  // ----- Phase 1 setup -----
  //
  // Normalise b ≥ 0 by negating rows where b is negative. This is the
  // standard precondition that makes the initial artificial basis
  // feasible (x_B = b ≥ 0). The normalisation flips both A[i] and b[i];
  // since the augmented matrix is A1 = [A | I_m], the artificials end up
  // with -1 on the diagonal for negated rows. That is fine — the simplex
  // does not require A1's columns to be identity, only the *basis*
  // columns to span. After the artificial drives out, the sign is gone.
  //
  // Edge case: a row of all zeros with b = 0 stays degenerate from the
  // start (artificial basic at zero); the artificial-drive-out step at
  // the end of Phase 1 will drop the row. A row of all zeros with b ≠ 0
  // is detected immediately and the LP is infeasible — we still drive
  // through Phase 1 so the Farkas certificate emerges naturally.
  const { A1, b, signs } = augmentAndNormaliseRows(lp, m0, n);

  // Phase-1 cost: zero for original columns, +1 for every artificial.
  // Minimising sum-of-artificials drives every a_i toward zero, which
  // is exactly the standard Phase 1 objective.
  const c1: Rat[] = new Array(n + m0);
  for (let j = 0; j < n; j++) c1[j] = RAT_ZERO;
  for (let j = n; j < n + m0; j++) c1[j] = { n: 1n, d: 1n };

  const state: SimplexState = {
    A1,
    b,
    c: c1,
    signs,
    basis: makeRange(n, n + m0),
    invB: identityBasisInverse(m0),
    xB: b.slice(),
    activeRows: makeRange(0, m0),
    iter: 0,
    maxBitLength: 0,
    degenStreak: 0,
    blandMode: 0,
    n,
  };

  const maxIter = opts.maxIter ?? 10 * (m0 + n);
  const maxBitLength = opts.maxBitLength ?? 1 << 20;
  const blandThreshold = opts.blandThreshold ?? 10;

  // ----- Phase 1 main loop -----
  //
  // Entering pool: any non-basic column (originals + artificials). In
  // Phase 1 we permit artificials to re-enter, because the bookkeeping
  // is simpler than tracking which artificials have "exited
  // permanently" — and an artificial re-entering at zero is a harmless
  // degenerate pivot.
  const phase1 = mainLoop(state, "phase1", maxIter, maxBitLength, blandThreshold);
  if (phase1.kind === "iter-cap") {
    return { status: "iter-cap", iterations: state.iter, maxBitLength: state.maxBitLength };
  }
  if (phase1.kind === "coefficient-explosion") {
    return phase1.result;
  }
  if (phase1.kind === "unbounded") {
    // Phase 1's objective `sum(a_i) ≥ 0` cannot be unbounded below. If
    // the main loop reports unbounded here, something is structurally
    // wrong — bail out as iter-cap (the safest non-lying status).
    return { status: "iter-cap", iterations: state.iter, maxBitLength: state.maxBitLength };
  }
  // Phase 1 optimal. Check infeasibility.
  const phase1Obj = computeObjective(state);
  if (ratIsPositive(phase1Obj)) {
    // Infeasible. The Farkas certificate is the final dual.
    const cB = readBasisVec(state.c, state.basis);
    const farkasInternal = solveBasisT(state.invB, cB);
    // The internal dual is for the row-normalised A1; flip signs to
    // recover the dual for the user's A. After flipping, the Farkas
    // certificate `yᵀ A ≤ 0`, `yᵀ b > 0` holds against the user's
    // unnegated `A` and `b`.
    const farkas = unflipSigns(farkasInternal, state.signs, state.activeRows, m0);
    return {
      status: "infeasible",
      farkas,
      iterations: state.iter,
      maxBitLength: state.maxBitLength,
    };
  }

  // ----- Phase 1 → Phase 2 transition -----
  //
  // Drive any artificial that is still basic out of the basis. If a
  // row's artificial cannot be swapped for a non-artificial (every
  // candidate column has a zero entry in that row of B⁻¹A), the
  // constraint is a linear combination of the others — drop the row.
  driveOutArtificials(state);

  // ----- Phase 2 setup -----
  //
  // Switch the cost vector to the original `c` extended with zero on
  // the artificial columns (which are no longer in the basis after the
  // drive-out step). Pricing in Phase 2 ignores artificial columns.
  const c2: Rat[] = new Array(n + m0);
  for (let j = 0; j < n; j++) c2[j] = lp.c[j]!;
  for (let j = n; j < n + m0; j++) c2[j] = RAT_ZERO;
  state.c = c2;
  // Reset anti-cycling state for the new phase. The two phases are
  // independent for cycling-detection purposes.
  state.degenStreak = 0;
  state.blandMode = 0;

  const phase2 = mainLoop(state, "phase2", maxIter, maxBitLength, blandThreshold);
  if (phase2.kind === "iter-cap") {
    return { status: "iter-cap", iterations: state.iter, maxBitLength: state.maxBitLength };
  }
  if (phase2.kind === "coefficient-explosion") {
    return phase2.result;
  }
  if (phase2.kind === "unbounded") {
    return packUnbounded(state, phase2.j, phase2.eta);
  }
  // Phase 2 optimal.
  return packOptimal(state, lp);
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------

type LoopOutcome =
  | { kind: "optimal" }
  | { kind: "unbounded"; j: number; eta: RatVector }
  | { kind: "iter-cap" }
  | { kind: "coefficient-explosion"; result: SimplexCoeffExplosion };

/**
 * One pricing iteration plus one ratio-test iteration plus one pivot
 * update. The loop terminates with one of the four outcomes above.
 *
 * The `phase` argument controls which columns are eligible to enter:
 *   • "phase1" — every non-basic column (originals + artificials).
 *   • "phase2" — original columns only; artificials are blocked.
 *
 * The cost vector is whatever is in `state.c` — `simplexSolve` swaps it
 * between phases.
 */
function mainLoop(
  state: SimplexState,
  phase: "phase1" | "phase2",
  maxIter: number,
  maxBitLength: number,
  blandThreshold: number,
): LoopOutcome {
  const { n } = state;
  // After Phase 1 cleanup may drop all rows; the unconstrained LP
  // `min cᵀ x, x ≥ 0` has optimum at 0 iff `c ≥ 0`, else unbounded.
  if (state.basis.length === 0) {
    for (let j = 0; j < n; j++) {
      if (phase === "phase2" && ratLt(state.c[j]!, RAT_ZERO)) {
        // Unbounded direction: e_j. Build it as the synthetic eta.
        const ray: Rat[] = [];
        return { kind: "unbounded", j, eta: ray };
      }
    }
    return { kind: "optimal" };
  }
  // The augmented matrix A1 has `n + m_original` columns regardless of
  // how many rows survived Phase 1 cleanup. Read the count from any row.
  const totalCols = state.A1[0]!.length;
  while (true) {
    if (state.iter >= maxIter) return { kind: "iter-cap" };

    // --- Pricing ---
    //
    // Compute the dual `y = B⁻ᵀ c_B`, then the reduced cost
    // `c̄_j = c_j - A1_jᵀ y` for every non-basic candidate.
    const cB = readBasisVec(state.c, state.basis);
    const y = solveBasisT(state.invB, cB);

    const basisSet = new Set(state.basis);
    let entering = -1;
    let bestReducedCost: Rat | null = null;
    const useBland = state.blandMode > 0;

    for (let j = 0; j < totalCols; j++) {
      if (basisSet.has(j)) continue;
      if (phase === "phase2" && j >= n) continue; // artificial blocked in Phase 2
      // c̄_j = c_j - sum_i A1[i][j] * y[i]
      const colJ = readColumn(state.A1, j);
      const cBarJ = ratSub(state.c[j]!, ratDot(colJ, y));
      if (!ratLt(cBarJ, RAT_ZERO)) continue; // not improving
      if (useBland) {
        // Bland: smallest j wins. First negative-reduced-cost column.
        entering = j;
        bestReducedCost = cBarJ;
        break;
      }
      // Dantzig: most-negative wins.
      if (bestReducedCost === null || ratCompare(cBarJ, bestReducedCost) === -1) {
        bestReducedCost = cBarJ;
        entering = j;
      }
    }

    if (entering === -1) return { kind: "optimal" };

    // --- Ratio test ---
    //
    // η = B⁻¹ a_q is the entering column expressed in basis coordinates.
    // Candidate leaving rows are those with η_i > 0; the chosen leaving
    // row is the one minimising x_B[i] / η_i. Ties (degeneracy) are
    // broken by smallest *basis index* (Bland's leaving rule), which
    // along with Bland's entering rule gives the provably terminating
    // pair.
    const aq = readColumn(state.A1, entering);
    const eta = solveBasis(state.invB, aq);

    let leaving = -1;
    let bestRatio: Rat | null = null;
    let bestBasisIdx = Number.POSITIVE_INFINITY;
    for (let i = 0; i < state.xB.length; i++) {
      const etaI = eta[i]!;
      if (!ratIsPositive(etaI)) continue;
      const ratio = { n: state.xB[i]!.n * etaI.d, d: state.xB[i]!.d * etaI.n };
      // Above is x_B[i] / eta[i] computed inline as a Rat literal; we
      // skip `makeRat` because we only need to *compare* ratios, never
      // to use them as values. The `ratCompare` call below cross-
      // multiplies exactly, so unreduced fractions are fine.
      // (We *do* re-normalise when this becomes the chosen ratio, so
      // that the value handed to the pivot update is well-formed.)
      if (bestRatio === null) {
        bestRatio = ratio;
        bestBasisIdx = state.basis[i]!;
        leaving = i;
        continue;
      }
      const cmp = ratCompare(ratio, bestRatio);
      if (cmp === -1) {
        bestRatio = ratio;
        bestBasisIdx = state.basis[i]!;
        leaving = i;
      } else if (cmp === 0) {
        // Tie: Bland's leaving rule picks the basis index with smallest
        // value. (This is the rule that makes the entering+leaving pair
        // finite — without the leaving-side tie-breaker, even Bland's
        // entering rule can cycle.)
        const candidateBasisIdx = state.basis[i]!;
        if (candidateBasisIdx < bestBasisIdx) {
          bestBasisIdx = candidateBasisIdx;
          leaving = i;
        }
      }
    }

    if (leaving === -1) {
      // No positive ratio — primal unbounded.
      return { kind: "unbounded", j: entering, eta };
    }

    // --- Pivot update ---
    //
    // We have everything we need: the entering column `aq`, its basis-
    // space representation `eta`, the leaving row `leaving`, and the
    // pivot ratio `bestRatio`. Update the basis index, `B⁻¹`, and
    // `x_B`. The `x_B` update is O(m) using the same eta-product form
    // as `pivotUpdate` (which is O(m²)), so we do it inline.
    const pivotRatio = { n: bestRatio!.n, d: bestRatio!.d };
    // Normalise the chosen ratio to canonical form (lowest terms).
    const normalisedRatio = lazyNormalise(pivotRatio);

    // Update x_B *before* mutating the basis index — we need eta[leaving]
    // and x_B[k] in their pre-pivot states.
    const newXB: Rat[] = new Array(state.xB.length);
    for (let k = 0; k < state.xB.length; k++) {
      if (k === leaving) {
        newXB[k] = normalisedRatio;
        continue;
      }
      // x_B[k]' = x_B[k] - eta[k] * ratio
      newXB[k] = ratSub(state.xB[k]!, ratMul(eta[k]!, normalisedRatio));
    }
    state.xB = newXB;
    state.basis[leaving] = entering;
    state.invB = pivotUpdate(state.invB, eta, leaving);

    // --- Coefficient-growth monitor ---
    const bl = basisBitLength(state.invB);
    if (bl > state.maxBitLength) state.maxBitLength = bl;
    if (state.maxBitLength > maxBitLength) {
      return {
        kind: "coefficient-explosion",
        result: {
          status: "coefficient-explosion",
          iterations: state.iter + 1,
          achieved: state.maxBitLength,
          cap: maxBitLength,
        },
      };
    }

    // --- Anti-cycling bookkeeping ---
    //
    // A degenerate pivot is one where the chosen ratio is zero (the
    // leaving basic variable was already at zero). Repeated degenerate
    // pivots are the warning sign of cycling. Count them; flip to Bland
    // mode after `blandThreshold` consecutive degenerates; flip back to
    // Dantzig after `2m` further pivots without a degenerate.
    if (ratIsZero(normalisedRatio)) {
      state.degenStreak += 1;
      if (state.degenStreak >= blandThreshold && state.blandMode === 0) {
        state.blandMode = 2 * state.xB.length;
      }
    } else {
      state.degenStreak = 0;
    }
    if (state.blandMode > 0) state.blandMode -= 1;

    state.iter += 1;
  }
}


// -----------------------------------------------------------------------------
// Phase 1 → Phase 2 transition: drive artificials out of the basis.
// -----------------------------------------------------------------------------

/**
 * After Phase 1 terminates with optimum = 0, every artificial is at zero
 * but some may still be basic (degeneracy). We attempt to swap each
 * remaining basic artificial out for a non-artificial column. If a row's
 * artificial cannot be swapped — every non-artificial column has a zero
 * entry in that row of `B⁻¹ A` — the constraint is linearly dependent on
 * the others, and we drop the row.
 *
 * The pivots performed here are degenerate (ratio = 0) and do not
 * change `x_B`. They do change `B⁻¹` and `basis`. The Bland-rule guard
 * is irrelevant: we are doing *forced* pivots in a fixed order.
 *
 * Cost: O(m³) worst case (one O(m²) pivot per row, m rows). For typical
 * problems where Phase 1 already drove most artificials out organically,
 * the cost is far less.
 */
function driveOutArtificials(state: SimplexState): void {
  const { n } = state;
  const newActiveRows: number[] = [];
  const newBasis: number[] = [];
  const newXB: Rat[] = [];

  for (let row = 0; row < state.basis.length; row++) {
    if (state.basis[row]! < n) {
      // Non-artificial basic — keep.
      newActiveRows.push(state.activeRows[row]!);
      newBasis.push(state.basis[row]!);
      newXB.push(state.xB[row]!);
      continue;
    }
    // Artificial basic — try to swap for a non-artificial column.
    let swappedJ = -1;
    let etaFound: RatVector | null = null;
    for (let j = 0; j < n; j++) {
      if (state.basis.includes(j)) continue;
      const colJ = readColumn(state.A1, j);
      const eta = solveBasis(state.invB, colJ);
      if (!ratIsZero(eta[row]!)) {
        swappedJ = j;
        etaFound = eta;
        break;
      }
    }
    if (swappedJ === -1) {
      // Row is redundant — drop. (Do not push to newBasis / newXB.)
      // The active-rows list also shrinks. We still need to keep
      // invB / xB consistent for the *retained* rows — handled by
      // rebuilding below.
      continue;
    }
    // Perform the swap: pivotUpdate, basis swap, x_B update (degenerate,
    // so newXB row stays at zero).
    state.invB = pivotUpdate(state.invB, etaFound!, row);
    state.basis[row] = swappedJ;
    // x_B[row] was 0 and pivot ratio is 0, so x_B is unchanged structurally.
    newActiveRows.push(state.activeRows[row]!);
    newBasis.push(swappedJ);
    newXB.push(RAT_ZERO);
  }

  // If any rows were dropped, the basis and invB need to be
  // *re-projected* onto the surviving row set. The simplest correct
  // construction is to refactor invB from scratch over the retained
  // basis indices.
  if (newBasis.length !== state.basis.length) {
    const retainedRowIndexInActive = newActiveRows.map((r) =>
      state.activeRows.indexOf(r),
    );
    // Rebuild A1 row-restricted to the retained rows. We don't actually
    // need a new A1; we can just project as needed during the main loop
    // by keeping `state.activeRows`. The B⁻¹ does need to be rebuilt.
    const newM = newBasis.length;
    const restrictedBasis: Rat[][] = [];
    for (let i = 0; i < newM; i++) {
      const sourceRow = retainedRowIndexInActive[i]!;
      const row: Rat[] = new Array(newM);
      for (let k = 0; k < newM; k++) {
        const col = newBasis[k]!;
        row[k] = state.A1[sourceRow]![col]!;
      }
      restrictedBasis.push(row);
    }
    // Project b similarly.
    const restrictedB: Rat[] = new Array(newM);
    for (let i = 0; i < newM; i++) {
      restrictedB[i] = state.b[retainedRowIndexInActive[i]!]!;
    }
    // Now build the *restricted* A1 by selecting the active rows
    // (we don't modify A1 itself; we rebuild the row projection).
    const restrictedA1: Rat[][] = [];
    for (let i = 0; i < newM; i++) {
      restrictedA1.push(state.A1[retainedRowIndexInActive[i]!]! as Rat[]);
    }
    state.A1 = restrictedA1;
    state.b = restrictedB;
    state.invB = invertSmallRational(restrictedBasis);
    state.basis = newBasis;
    state.xB = solveBasis(state.invB, restrictedB);
    state.activeRows = newActiveRows;
  } else {
    state.basis = newBasis;
    state.xB = newXB;
    state.activeRows = newActiveRows;
  }
}

// -----------------------------------------------------------------------------
// Result packing
// -----------------------------------------------------------------------------

function packOptimal(state: SimplexState, lp: StandardLP): SimplexOptimal {
  const n = state.n;
  const m = state.basis.length;
  const x: Rat[] = new Array(n);
  for (let j = 0; j < n; j++) x[j] = RAT_ZERO;
  // Only basic variables that are *original* (< n) appear in x.
  for (let i = 0; i < m; i++) {
    const bj = state.basis[i]!;
    if (bj < n) x[bj] = state.xB[i]!;
  }
  // Dual: y_internal = B⁻ᵀ c_B is for the *normalised* A1. Flip signs
  // to recover the dual for the user's A.
  const cB: Rat[] = new Array(m);
  for (let i = 0; i < m; i++) cB[i] = state.c[state.basis[i]!]!;
  const yActive = solveBasisT(state.invB, cB);
  // Lift y_internal back to the original m0-row indexing AND flip
  // signs per row. Rows dropped during Phase 1 cleanup carry y_i = 0
  // (a redundant equality contributes zero to the dual).
  const m0 = lp.b.length;
  const dual: Rat[] = new Array(m0);
  for (let i = 0; i < m0; i++) dual[i] = RAT_ZERO;
  for (let i = 0; i < m; i++) {
    const row = state.activeRows[i]!;
    const flip = state.signs[row] === -1;
    dual[row] = flip ? ratNeg(yActive[i]!) : yActive[i]!;
  }
  // Slack: s = c - Aᵀ y over original columns. Zero on basic vars by
  // complementary slackness; we compute by formula to verify.
  const slack: Rat[] = new Array(n);
  for (let j = 0; j < n; j++) {
    let aTy: Rat = RAT_ZERO;
    for (let i = 0; i < m0; i++) {
      const aij = lp.A[i]![j]!;
      if (ratIsZero(aij)) continue;
      aTy = ratAdd(aTy, ratMul(aij, dual[i]!));
    }
    slack[j] = ratSub(lp.c[j]!, aTy);
  }
  const objective = ratDot(lp.c, x);
  return {
    status: "optimal",
    x,
    basis: state.basis,
    objective,
    dual,
    slack,
    iterations: state.iter,
    maxBitLength: state.maxBitLength,
  };
}

function packUnbounded(
  state: SimplexState,
  enteringJ: number,
  eta: RatVector,
): SimplexUnbounded {
  const n = state.n;
  const m = state.basis.length;
  const x: Rat[] = new Array(n);
  for (let j = 0; j < n; j++) x[j] = RAT_ZERO;
  for (let i = 0; i < m; i++) {
    const bj = state.basis[i]!;
    if (bj < n) x[bj] = state.xB[i]!;
  }
  // Ray: d_j = 1 for entering, d_B = -η for basis, d_else = 0. Restrict
  // to original variables (drop artificial components if any are basic;
  // they shouldn't be after Phase 1 cleanup, but defensive).
  const ray: Rat[] = new Array(n);
  for (let j = 0; j < n; j++) ray[j] = RAT_ZERO;
  if (enteringJ < n) ray[enteringJ] = { n: 1n, d: 1n };
  for (let i = 0; i < m; i++) {
    const bj = state.basis[i]!;
    if (bj < n) ray[bj] = ratNeg(eta[i]!);
  }
  return {
    status: "unbounded",
    x,
    ray,
    iterations: state.iter,
    maxBitLength: state.maxBitLength,
  };
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function validateInput(lp: StandardLP, m: number, n: number): void {
  if (lp.b.length !== m) {
    throw new Error(`simplexSolve: |b|=${lp.b.length} but A has ${m} rows`);
  }
  for (let i = 0; i < m; i++) {
    if (lp.A[i]!.length !== n) {
      throw new Error(
        `simplexSolve: ragged A — row 0 has ${n} cols, row ${i} has ${lp.A[i]!.length}`,
      );
    }
  }
}

/**
 * Build the augmented Phase-1 matrix `A1 = [A_norm | I]`, where
 * `A_norm` is `A` with rows multiplied by `sign(b_i)` to enforce
 * `b_norm ≥ 0`, and `I` is the m×m identity (the artificial columns).
 *
 * Tracking the row signs is critical for the dual interpretation: the
 * internal y is the dual for `A_norm x = b_norm`, whose i-th row is
 * `sign(b_i)` times the user's i-th row. The dual for the user's
 * system at row i is therefore `sign(b_i) · y_internal[i]`. The sign
 * vector is threaded through `SimplexState` and applied on output
 * via `packOptimal` / the infeasible branch.
 *
 * Why this convention and not "D-signed artificials" (keeping `A`
 * verbatim and using `D = diag(sign(b_i))` as the artificial block):
 * the D-signed approach has a clean primal side but imposes spurious
 * sign constraints on `y_i` at Phase 2 dual feasibility — the dual
 * loses its "unconstrained for equalities" property. Row negation
 * with explicit sign-flip on output keeps the dual mathematically
 * clean while keeping the algorithm in pristine standard-form.
 */
function augmentAndNormaliseRows(
  lp: StandardLP,
  m: number,
  n: number,
): { A1: RatMatrix; b: Rat[]; signs: Int8Array } {
  const A1: Rat[][] = [];
  const b: Rat[] = new Array(m);
  const signs = new Int8Array(m);
  for (let i = 0; i < m; i++) {
    const isNeg = ratLt(lp.b[i]!, RAT_ZERO);
    signs[i] = isNeg ? -1 : 1;
    const row: Rat[] = new Array(n + m);
    for (let j = 0; j < n; j++) {
      const a = lp.A[i]![j]!;
      row[j] = isNeg ? ratNeg(a) : a;
    }
    for (let j = 0; j < m; j++) {
      row[n + j] = i === j ? { n: 1n, d: 1n } : RAT_ZERO;
    }
    A1.push(row);
    b[i] = isNeg ? ratNeg(lp.b[i]!) : lp.b[i]!;
  }
  return { A1, b, signs };
}

/**
 * Lift a length-`active.length` dual vector back to length `m0` and
 * apply per-row sign flips. Rows not in `activeRows` (dropped during
 * Phase 1 cleanup) become zero.
 */
function unflipSigns(
  yActive: ReadonlyArray<Rat>,
  signs: Int8Array,
  activeRows: ReadonlyArray<number>,
  m0: number,
): Rat[] {
  const out: Rat[] = new Array(m0);
  for (let i = 0; i < m0; i++) out[i] = RAT_ZERO;
  for (let i = 0; i < yActive.length; i++) {
    const row = activeRows[i]!;
    out[row] = signs[row] === -1 ? ratNeg(yActive[i]!) : yActive[i]!;
  }
  return out;
}

function makeRange(lo: number, hi: number): number[] {
  const out: number[] = new Array(hi - lo);
  for (let i = 0; i < hi - lo; i++) out[i] = lo + i;
  return out;
}

function readBasisVec(c: RatVector, basis: ReadonlyArray<number>): Rat[] {
  const out: Rat[] = new Array(basis.length);
  for (let i = 0; i < basis.length; i++) out[i] = c[basis[i]!]!;
  return out;
}

function readColumn(A: RatMatrix, j: number): Rat[] {
  const out: Rat[] = new Array(A.length);
  for (let i = 0; i < A.length; i++) out[i] = A[i]![j]!;
  return out;
}

function computeObjective(state: SimplexState): Rat {
  let obj: Rat = RAT_ZERO;
  for (let i = 0; i < state.basis.length; i++) {
    obj = ratAdd(obj, ratMul(state.c[state.basis[i]!]!, state.xB[i]!));
  }
  return obj;
}

/**
 * Take a `{n, d}` literal that may not be in canonical form (lowest terms,
 * positive denominator) and return the canonical `Rat`. Used inside the
 * ratio test, where we construct intermediate Rats without going through
 * `makeRat` to skip GCD cost on values we only compare.
 */
function lazyNormalise(r: { n: bigint; d: bigint }): Rat {
  // Inlined makeRat. Avoids the import-cycle and the redundant zero
  // check (caller knows r is the chosen pivot ratio; we may or may not
  // have a zero numerator — degenerate pivot — but no zero denominator).
  let nn = r.n;
  let dd = r.d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  if (nn === 0n) return RAT_ZERO;
  // Inline GCD.
  let a = nn < 0n ? -nn : nn;
  let b = dd;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return { n: nn / a, d: dd / a };
}

/**
 * Invert a small `m × m` rational matrix via Gauss-Jordan elimination
 * with partial pivoting. Used only by the Phase-1-cleanup row-drop
 * branch, which rebuilds `B⁻¹` over the surviving row subset. O(m³).
 *
 * For the main inner loop we never call this — pivoting maintains
 * `B⁻¹` incrementally via `pivotUpdate`. This function exists for the
 * rare "reproject after dropping redundant rows" path.
 */
function invertSmallRational(M: RatMatrix): BasisInverse {
  const m = M.length;
  // [M | I] → [I | M⁻¹]
  const aug: Rat[][] = new Array(m);
  for (let i = 0; i < m; i++) {
    const row: Rat[] = new Array(2 * m);
    for (let j = 0; j < m; j++) row[j] = M[i]![j]!;
    for (let j = 0; j < m; j++) row[m + j] = i === j ? { n: 1n, d: 1n } : RAT_ZERO;
    aug[i] = row;
  }
  for (let col = 0; col < m; col++) {
    // Partial pivot — any non-zero row at or below `col`.
    let pivotRow = -1;
    for (let i = col; i < m; i++) {
      if (!ratIsZero(aug[i]![col]!)) {
        pivotRow = i;
        break;
      }
    }
    if (pivotRow === -1) {
      throw new Error(
        `invertSmallRational: matrix is singular at column ${col} — should be unreachable after Phase 1 row-drop`,
      );
    }
    if (pivotRow !== col) {
      const tmp = aug[col]!;
      aug[col] = aug[pivotRow]!;
      aug[pivotRow] = tmp;
    }
    // Scale the pivot row so that aug[col][col] = 1.
    const pivot = aug[col]![col]!;
    for (let j = 0; j < 2 * m; j++) {
      aug[col]![j] = (function divInline(a: Rat, b: Rat): Rat {
        // ratDiv inline — avoids the throw path since pivot ≠ 0.
        return lazyNormalise({ n: a.n * b.d, d: a.d * b.n });
      })(aug[col]![j]!, pivot);
    }
    // Eliminate from every other row.
    for (let i = 0; i < m; i++) {
      if (i === col) continue;
      const factor = aug[i]![col]!;
      if (ratIsZero(factor)) continue;
      for (let j = 0; j < 2 * m; j++) {
        aug[i]![j] = ratSub(aug[i]![j]!, ratMul(factor, aug[col]![j]!));
      }
    }
  }
  const invB: Rat[][] = new Array(m);
  for (let i = 0; i < m; i++) {
    const row: Rat[] = new Array(m);
    for (let j = 0; j < m; j++) row[j] = aug[i]![m + j]!;
    invB[i] = row;
  }
  return { invB, m };
}

// Local re-export — keeps `ratBitLength` available for callers of this
// module without forcing them to import from `rat-cmp` directly. Pure
// re-export, no behaviour.
export { ratBitLength };
