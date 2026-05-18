// =============================================================================
// anderson-type-i.ts — Stabilised Type-I Anderson acceleration (AA-I-S-m)
// =============================================================================
//
// This module is the v0.2 companion of `anderson.ts`. Where AA-II (the
// classical Walker-Ni 2011 method shipped in `anderson.ts`) finds the
// smallest-residual convex combination of recent images, AA-I builds an
// explicit multi-secant Jacobian estimate and takes one Newton-like step
// against it. The two are duals — same input data, different recipe —
// but in the *non-smooth* fixed-point regime SCS lives in, AA-I tends to
// converge faster *when stabilised* and to diverge faster *when not*.
// The whole point of this module is the stabilisation.
//
// Ground truth: `docs/ground-truth/convex/anderson-acceleration.md` §6
// (the bare AA-I-m algorithm, eq 4–9) and §7 (the AA-I-S-m globalisation,
// eq 10–14 + Algorithm 3 + Theorem 6 + hyper-parameter defaults). The
// algorithm is **AA-I-S-m**, Algorithm 3 of Zhang-O'Donoghue-Boyd 2018
// (arXiv:1808.03971, p. 13; staged PDF at
// `docs/refs/zhang-odonoghue-boyd-2018-type-i-anderson.pdf`). Ported
// from the paper, never from the `scs` C library's `aa` module
// (ADR-0030 §E discipline). ADR-0036 §F is the design rationale.
//
// ── The three pillars (paper §7.7, Theorem 6) ───────────────────────────────
//
// AA-I-m without globalisation is documented in the paper as a
// *theoretical* method. The *practical*, globally-convergent algorithm
// AA-I-S-m is vanilla AA-I plus three interleaved modifications, and
// **all three** are load-bearing for the convergence proof:
//
//   1. **Powell-type regularisation** of the rank-one update (eq 10–13)
//      — conditionally scales the secant target `y_i` back toward
//      `B_k^i s_i` when the column is suspect, so `B_k` stays
//      invertible with `|det(B_k)| ≥ θ̄^{m_k}` (Lemma 2).
//
//   2. **Gram-Schmidt restart rule** (eq 14) — drops the entire window
//      when either the rolling window saturates (`m_k = m + 1`) or the
//      orthogonalised iterate-diff `ŝ_{k-1}` is shorter than a
//      `τ`-fraction of the raw `s_{k-1}` (strong-linear-independence
//      violation). Keeps `‖B_k‖` and `‖H_k‖` uniformly bounded
//      (Corollary 4).
//
//   3. **Residual-decrease safe-guarding** (lines 12–14 of Algorithm 3)
//      — accepts the AA-I step only when the *current* residual `‖g_k‖`
//      passes the `D Ū (n_AA + 1)^{−(1+ε)}` schedule; otherwise falls
//      back to a KM-averaged step `f_α(x_k) = (1−α)x_k + α f(x_k)`.
//      The summable schedule is what makes the proof's eq 22 finite.
//
// An implementation that ships Powell + restart but skips the
// safeguard does not satisfy Theorem 6. An implementation that ships
// Powell + safeguard but skips restart does not satisfy Theorem 6. The
// three are not independently optional — this is why the spec carries
// all five hyper-parameters as required fields.
//
// ── The matrix-free state (paper §7.5 "Matrix-free updates") ────────────────
//
// Computing and storing the dense `n × n` matrix `H_k` would defeat the
// point — for the SCS embedding `n = 2N` (the embedding pair `[u; v]`)
// runs into the thousands. The paper's trick: never materialise `H_k`;
// instead store the per-iteration tuple `(ŝ_j, c_j, d_j)` where
//
//   c_j = s_j − H_{j−1} ỹ_j           (numerator vector, paper eq 13)
//   d_j = ŝ_jᵀ H_{j−1} ỹ_j            (denominator scalar, paper eq 13)
//
// and represent `H_k` as the recurrence `H_k = I + Σ c_j ŝ_jᵀ / d_j`
// applied sequentially. For any vector `v`, `H_k v` unrolls as
//
//   w := v
//   for j = 0 … L−1:                  # L = number of stored tuples
//     w := w + c_j · (ŝ_jᵀ w) / d_j   # rank-one correction in order
//   return w
//
// — `O(n · L)` per application, the same complexity as AA-II. The
// implementer's apply-H subroutine *must* iterate over the stored
// list in oldest-first order: each rank-one correction acts on the
// output of the previous correction, not on the original `v`.
//
// ── The s_{k−1} = x̃^k − x^{k−1} subtlety (paper §7.4 closing paragraph) ────
//
// In AA-I-S-m, `s_{k−1}` and `y_{k−1}` are defined using the **trial**
// AA-I update `x̃^k`, not the accepted `x^k`:
//
//   s_{k−1} = x̃^k − x^{k−1}
//   y_{k−1} = g(x̃^k) − g(x^{k−1})
//
// This is essential. It preserves the identity
// `B_{k−1} s_{k−1} = −g_{k−1}` that lets the implementer drop the
// explicit `B_k^i` maintenance, so wherever `B_k^i s_{k−m_k+i}` appears
// (in eq 10's `ỹ` definition) it can be substituted by `−g_{k−1}`. If
// instead `s_{k−1}` were defined off the safeguard-accepted `x^k`, that
// identity breaks and the simplification becomes invalid.
//
// The cost is one extra `g(·)` evaluation per iteration — `f(x̃^k)`
// AND `f(x^{k−1})` rather than `f(x^k)` alone. The accelerator's
// `next(xAccepted, fxAccepted, xTrial, fxTrial)` signature surfaces
// that cost in the type: the caller must provide both `f` values.
//
// ── Determinism ─────────────────────────────────────────────────────────────
//
// Bit-identical given `(problem, opts, platform)`, exactly as AA-II is
// (ADR-0015, `numerical: true`). A fixed memory window, a fixed-order
// Gram-Schmidt, a fixed-order rank-one update, no implicit-zero gates.
// The Powell scalar `θ` is a piecewise-continuous function of one real
// scalar; the safeguard test is one comparison on `‖g_k‖`. No
// random-tie-breaking, no implementation-defined order.

import { dot, isFiniteVec } from "./anderson-shared.js";
import { ConeError } from "./cones.js";

// =============================================================================
// Hyper-parameters
// =============================================================================
//
// The five hyper-parameters of Algorithm 3. The paper reports a single
// set worked across all numerical experiments (§5.2.1); these are those
// defaults. They are *parallel* fields rather than a single nested
// `options` because each one independently corresponds to a named
// algorithmic mechanism in the paper, and the `--accelerator=type-i`
// wire flag (ADR-0036 §F) may eventually surface them one-by-one for
// tuning. Bundling them would obscure that mapping.

export interface AndersonISpec {
  /**
   * Memory window `m > 0`. The rolling-window length: when the stored
   * list reaches `m` entries, the next iteration's restart test
   * (eq 14, "if m_k = m + 1") fires unconditionally. Paper default 5,
   * with `m ∈ [2, 50]` all reasonable per §5.2.1; `m` close to the
   * variable dimension `n` becomes unstable.
   */
  readonly memory: number;
  /**
   * Powell regularisation strength `θ̄ ∈ (0, 1)`. The Powell scalar
   * `θ_k^i` is constrained to lie in `[1 − θ̄, 1 + θ̄]` by the formula
   * `φ_θ̄`. Paper default 0.01. **Empirically should not be set too
   * large** (paper §5.2.1, "rules of thumb") — too large breaks the
   * acceleration.
   */
  readonly thetaBar: number;
  /**
   * Gram-Schmidt restart threshold `τ ∈ (0, 1)`. The restart fires
   * when `‖ŝ_{k-1}‖ < τ · ‖s_{k-1}‖` — the orthogonalised iterate-diff
   * is shorter than a `τ`-fraction of the raw iterate-diff (i.e. the
   * latest secant is `cos⁻¹(τ)`-aligned with the existing column span).
   * Paper default 0.001. `τ ∈ [0.001, 0.1]` is all reasonable; larger
   * forces more frequent restarts (in the limit, behaves like `m = 1`).
   */
  readonly tau: number;
  /**
   * KM-averaging weight `α ∈ (0, 1)` for the safeguard fall-back step:
   * `f_α(x) = (1 − α) x + α f(x)`. Paper default 0.1.
   */
  readonly kmAlpha: number;
  /**
   * Safeguard scale `D > 0`. The threshold the accepted-AA-step residual
   * `‖g_k‖` is compared against is `D · Ū · (n_AA + 1)^{−(1+ε)}`. Paper
   * default `1e6`. Small `D` ⇒ safeguards fire more often (useful when
   * the problem is easy and the safeguard test is wasted work).
   */
  readonly safeguardD: number;
  /**
   * Safeguard schedule exponent `ε > 0`. The `(1 + ε)` exponent on
   * `(n_AA + 1)` makes the schedule's series `Σ n^{−(1+ε)}` finite,
   * which is exactly what Theorem 6's eq 22 needs. Paper default `1e-6`.
   * **Must be strictly positive** — `ε = 0` would make the series
   * non-summable and break the convergence proof.
   */
  readonly safeguardEps: number;
}

/**
 * The Algorithm 3 paper defaults (§5.2.1, Table). One set worked across
 * all of the paper's numerical experiments; cone-core v0.2 ships with
 * these unless the bench measures a better tuning for the lp-netlib
 * corpus.
 */
export const DEFAULT_ANDERSON_I_SPEC: AndersonISpec = {
  memory: 5,
  thetaBar: 0.01,
  tau: 0.001,
  kmAlpha: 0.1,
  safeguardD: 1e6,
  safeguardEps: 1e-6,
};

// =============================================================================
// Powell scalar φ_θ̄ — exported for the --test hook
// =============================================================================
//
// The Powell test (paper eq 11) maps a real input `η` to a scalar
// `θ ∈ [1 − θ̄, 1 + θ̄]`:
//
//   φ_θ̄(η) = 1                              if |η| ≥ θ̄
//          = (1 − sign(η) · θ̄) / (1 − η)    if |η| < θ̄
//
// with the convention `sign(0) = 1` (paper §3.2). Read `η` as
// "alignment of the secant target with the orthogonalised iterate-diff":
// when `|η|` is large the secant carries genuine non-degenerate
// information and `θ = 1` recovers the unregularised update; when
// `|η|` is small (the secant nearly orthogonal to new information) `θ`
// is pulled away from 1, dampening the update.
//
// Exported because the Group 5 mutation-proof test (`anderson-type-i.
// test.ts`) needs to assert the trigger condition directly: it walks the
// iteration and verifies at least one Powell-test call produces
// `|γ| < θ̄`. Re-deriving this scalar at the call site would risk
// drifting from the impl; sharing the function makes the test pin the
// exact formula the algorithm uses.
export function phiPowell(eta: number, thetaBar: number): number {
  if (Math.abs(eta) >= thetaBar) return 1;
  // sign convention: sign(0) = 1.
  const sgn = eta >= 0 ? 1 : -1;
  return (1 - sgn * thetaBar) / (1 - eta);
}

// =============================================================================
// The accelerator interface
// =============================================================================

/**
 * A stateful AA-I-S-m accelerator. Drive it one step at a time; each
 * call to `next` represents one iteration of Algorithm 3.
 *
 * **Per-iteration inputs.** AA-I needs *both* the current safeguard-
 * accepted iterate `x^k` and the current trial iterate `x̃^k` (with
 * their respective `f`-images), because the iterate-diff `s_{k-1}` is
 * defined off the trial — `s_{k-1} = x̃^k − x^{k-1}` (paper §7.4
 * closing paragraph, preserving the `B s = −g` identity). The
 * accelerator holds `x^{k-1}` and `f(x^{k-1})` internally across calls,
 * so the caller does not need to remember the previous accepted iterate
 * — it is part of the accelerator's state, not the public surface.
 *
 * **Returned values.** `xNext` is `x^{k+1}` — the next accepted iterate
 * after applying the safeguard test on `‖g(x^k)‖`. `xTrialNext` is
 * `x̃^{k+1} = x^k − H_k g_k` — the next trial iterate, to feed back to
 * the next `next` call as `xTrial` after the caller has applied `f` to
 * it.
 *
 * **First call.** The caller passes `xTrial = xAccepted = x^0` with the
 * corresponding `f(x^0)` for both — the accelerator returns
 * `xNext = xTrialNext = f_α(x^0)`, matching the paper's initialisation
 * line `x^1 = x̃^1 = f_α(x^0)`. This special case keeps the iteration's
 * one-call-per-iter discipline uniform without requiring a separate
 * `init` method.
 */
export interface AndersonAcceleratorI {
  /**
   * Consume one iteration's input quadruple; return the next accepted
   * and trial iterates. All four input arrays are read-only — none is
   * mutated or aliased into the output. The output arrays are fresh.
   *
   * - `xAccepted`   = `x^k` (the current safeguard-accepted iterate;
   *                  on first call, the user-supplied `x^0`)
   * - `fxAccepted`  = `f(x^k)`
   * - `xTrial`      = `x̃^k` (the current trial iterate; on first call,
   *                  equal to `xAccepted`)
   * - `fxTrial`     = `f(x̃^k)` (on first call equal to `fxAccepted`)
   */
  next(
    xAccepted: Float64Array,
    fxAccepted: Float64Array,
    xTrial: Float64Array,
    fxTrial: Float64Array,
  ): { xNext: Float64Array; xTrialNext: Float64Array };

  /** Drop all stored state; the next call restarts from initialisation. */
  reset(): void;
}

// =============================================================================
// Constructor
// =============================================================================
//
// All input validation lives here. Range checks are loud `ConeError`
// (CLAUDE.md Rule 1): a hyper-parameter outside its declared open
// interval is a programming error, not a refusal envelope to surface
// downstream. The error messages name the offending field.

export function makeAndersonI(spec: AndersonISpec): AndersonAcceleratorI {
  // ── input validation ──────────────────────────────────────────────────────
  if (!Number.isInteger(spec.memory) || spec.memory < 1) {
    throw new ConeError(
      `makeAndersonI: memory must be a positive integer, got ${spec.memory}`,
    );
  }
  if (!(spec.thetaBar > 0 && spec.thetaBar < 1)) {
    throw new ConeError(
      `makeAndersonI: thetaBar must lie in the open interval (0, 1), got ${spec.thetaBar}`,
    );
  }
  if (!(spec.tau > 0 && spec.tau < 1)) {
    throw new ConeError(
      `makeAndersonI: tau must lie in the open interval (0, 1), got ${spec.tau}`,
    );
  }
  if (!(spec.kmAlpha > 0 && spec.kmAlpha < 1)) {
    throw new ConeError(
      `makeAndersonI: kmAlpha must lie in the open interval (0, 1), got ${spec.kmAlpha}`,
    );
  }
  if (!(spec.safeguardD > 0) || !Number.isFinite(spec.safeguardD)) {
    throw new ConeError(
      `makeAndersonI: safeguardD must be a positive finite number, got ${spec.safeguardD}`,
    );
  }
  if (!(spec.safeguardEps > 0) || !Number.isFinite(spec.safeguardEps)) {
    throw new ConeError(
      `makeAndersonI: safeguardEps must be a positive finite number, got ${spec.safeguardEps}`,
    );
  }

  const { memory, thetaBar, tau, kmAlpha, safeguardD, safeguardEps } = spec;

  // ── persistent state ──────────────────────────────────────────────────────
  //
  // The matrix-free representation of H_{k-1}: a list of stored
  // rank-one corrections in oldest-first order. Each entry is a triple
  // (ŝ_j, c_j, d_j) with the meaning at the file header. The list
  // length is the number of corrections layered on the identity to form
  // `H_{k-1}`; the paper's `m_k` is implicit (we never track it
  // separately — `sHatCols.length` carries the same information after
  // restart-account corrections).
  //
  // The window-saturation restart test fires when `sHatCols.length >=
  // memory`: at the next iteration's step 1 the paper computes
  // `m_k = m_{k-1} + 1`, and `m_{k-1} = sHatCols.length`; the condition
  // `m_k = memory + 1` thus reads as `sHatCols.length = memory`. The
  // strong-linear-independence trigger fires when `‖ŝ_{k-1}‖ < τ · ‖s_{k-1}‖`
  // (paper eq 14, the second arm).
  const sHatCols: Float64Array[] = [];
  const cCols: Float64Array[] = [];
  const denoms: number[] = [];

  // `nAA` is the running count of accepted AA-I steps (paper Algorithm 3
  // line 13). Only the *accepted* steps tick it forward; a safeguard
  // fall-back leaves `nAA` unchanged. The threshold the safeguard
  // compares `‖g_k‖` against is `D · Ū · (nAA + 1)^{−(1+ε)}`.
  let nAA = 0;

  // `UBar` is the captured `‖g_0‖₂`. The very first `next` call sees
  // `g_0 = xTrial − fxTrial` (which on the first call equals
  // `xAccepted − fxAccepted` since trial = accepted = x^0). The
  // threshold is undefined before `UBar` is captured — but the first
  // call always takes the unconditional KM step, not an AA-I step,
  // so the threshold is never tested at that point.
  let UBar: number | undefined;

  // `xPrev` / `fxPrev` are `x^{k-1}` and `f(x^{k-1})` — the *previous*
  // safeguard-accepted iterate, carried internally so the caller's
  // per-iteration interface stays four-args (current-accepted, current-
  // trial). On the first call both are undefined; on the second and
  // later calls they are the `xAccepted` / `fxAccepted` of the previous
  // call. They are updated at the end of every `next` call.
  let xPrev: Float64Array | undefined;
  let fxPrev: Float64Array | undefined;

  // `firstCall` distinguishes the initialisation step from the proper
  // AA-I iteration. On first call the accelerator emits `f_α(x^0)` for
  // both `xNext` and `xTrialNext` (paper init line). From the second
  // call onwards, the rolling iterate-diff `s_{k-1} = x̃^k − x^{k-1}`
  // is well-defined.
  let firstCall = true;

  const reset = (): void => {
    sHatCols.length = 0;
    cCols.length = 0;
    denoms.length = 0;
    nAA = 0;
    UBar = undefined;
    xPrev = undefined;
    fxPrev = undefined;
    firstCall = true;
  };

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Apply the current `H_{k-1}` to a vector `v` matrix-free, unrolling
   * the stored rank-one corrections in oldest-first order. Returns a
   * fresh array; `v` is not mutated. When the stored list is empty
   * (post-restart) this returns `v.slice()` — `H_{k-1} = I`.
   */
  const applyH = (v: Float64Array): Float64Array => {
    const w = v.slice();
    for (let j = 0; j < sHatCols.length; j++) {
      const sHatJ = sHatCols[j]!;
      const cJ = cCols[j]!;
      const dJ = denoms[j]!;
      const coeff = dot(sHatJ, w) / dJ;
      for (let i = 0; i < w.length; i++) w[i]! += cJ[i]! * coeff;
    }
    return w;
  };

  /**
   * The KM-averaged step `f_α(x) = (1 − α) · x + α · f(x)`. Uses the
   * `f(x)` value the caller already computed for this iteration — so
   * the safeguard fall-back is *cheap*, costing no extra `f` evaluation
   * beyond what AA-I already needed.
   */
  const kmStep = (x: Float64Array, fx: Float64Array): Float64Array => {
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = (1 - kmAlpha) * x[i]! + kmAlpha * fx[i]!;
    return out;
  };

  /**
   * The fixed-point residual `g(x) = x − f(x)`. The accelerator never
   * sees the map `f` itself; the caller computes `f(x)` and passes it
   * in. Computed inline here for clarity at the use sites.
   */
  const residual = (x: Float64Array, fx: Float64Array): Float64Array => {
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i]! - fx[i]!;
    return out;
  };

  /**
   * Drop all stored state for a Gram-Schmidt restart (paper eq 14).
   * `H_{k-1}` is implicitly set back to identity (the empty list).
   * Does *not* touch `nAA` or `UBar` — those track the safeguard
   * schedule across the full iteration history, not per-window.
   */
  const restartWindow = (): void => {
    sHatCols.length = 0;
    cCols.length = 0;
    denoms.length = 0;
  };

  // ── the iteration step ─────────────────────────────────────────────────────

  const next = (
    xAccepted: Float64Array,
    fxAccepted: Float64Array,
    xTrial: Float64Array,
    fxTrial: Float64Array,
  ): { xNext: Float64Array; xTrialNext: Float64Array } => {
    // First call: paper's initialisation line — x^1 = x̃^1 = f_α(x^0).
    // Capture `UBar = ‖g_0‖` from `(xAccepted, fxAccepted)` here (the
    // only point known at construction time). After this call, the
    // accelerator's `xPrev` slot holds `x^0` so that the next call's
    // `s` and `y` differences are well-defined.
    if (firstCall) {
      const g0 = residual(xAccepted, fxAccepted);
      let g0NormSq = 0;
      for (let i = 0; i < g0.length; i++) g0NormSq += g0[i]! * g0[i]!;
      UBar = Math.sqrt(g0NormSq);
      firstCall = false;
      const xInit = kmStep(xAccepted, fxAccepted);
      // Stash x^0 as the *previous accepted* iterate for the next call.
      xPrev = xAccepted.slice();
      fxPrev = fxAccepted.slice();
      // Return the same array for both — the next call will receive
      // xAccepted = xTrial = xInit, computed once. We slice to keep
      // ownership clean: the caller can write to one without aliasing
      // the other.
      return { xNext: xInit, xTrialNext: xInit.slice() };
    }

    // From here on the iteration is one pass through Algorithm 3
    // steps 1–7. The "k" of the paper is implicit; the indexing is:
    //   xAccepted  = x^k        (current safeguard-accepted iterate)
    //   fxAccepted = f(x^k)
    //   xTrial     = x̃^k        (current trial iterate)
    //   fxTrial    = f(x̃^k)
    //   xPrev      = x^{k-1}    (held from previous `next` call)
    //   fxPrev     = f(x^{k-1})
    //
    // The accelerator forms `s_{k-1} = x̃^k − x^{k-1}` and
    // `y_{k-1} = g(x̃^k) − g(x^{k-1})` from these, runs steps 3–6 to
    // produce H_k and the trial step x̃^{k+1} = x^k − H_k · g(x^k),
    // then runs the safeguard test on ‖g(x^k)‖ to decide x^{k+1}.

    // ── steps 1–2: form the iterate- and residual-differences ────────────
    //
    // Critical: s_{k-1} uses x̃^k − x^{k-1}, NOT x^k − x^{k-1} (paper
    // §7.4 closing paragraph). The trial-based definition preserves
    // the B s = −g identity used in step 5's simplification.
    const dim = xAccepted.length;
    const xPrevLocal = xPrev!;
    const fxPrevLocal = fxPrev!;
    const s = new Float64Array(dim);
    const y = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      s[i] = xTrial[i]! - xPrevLocal[i]!;
      // y = g(x̃^k) − g(x^{k-1}) = (x̃^k − f(x̃^k)) − (x^{k-1} − f(x^{k-1}))
      //   = (xTrial − fxTrial) − (xPrev − fxPrev)
      y[i] = xTrial[i]! - fxTrial[i]! - (xPrevLocal[i]! - fxPrevLocal[i]!);
    }

    // ── step 3: Gram-Schmidt against the stored columns ──────────────────
    //
    // ŝ = s − Σ_j (ŝ_jᵀ s / ŝ_jᵀ ŝ_j) · ŝ_j, oldest-first. The
    // denominators `ŝ_jᵀ ŝ_j` are the squared norms of the stored
    // orthogonalised columns; they are nonzero by construction (a
    // would-be zero-norm new column is what the eq 14 strong-
    // linear-independence test catches at the next iteration).
    const sHat = s.slice();
    for (let j = 0; j < sHatCols.length; j++) {
      const sHatJ = sHatCols[j]!;
      const sHatJNormSq = dot(sHatJ, sHatJ);
      const coeff = dot(sHatJ, s) / sHatJNormSq;
      for (let i = 0; i < dim; i++) sHat[i]! -= coeff * sHatJ[i]!;
    }

    // ── step 4: restart test (paper eq 14) ───────────────────────────────
    //
    // Two triggers — both unconditional:
    //   (a) window saturation: stored count is already at `memory`
    //       (next append would push to memory + 1).
    //   (b) strong-linear-independence violation: ‖ŝ‖ < τ ‖s‖, i.e. the
    //       latest secant carries too little new column-span information.
    //
    // On either trigger, drop all stored state, set `ŝ = s` (the raw
    // iterate-diff replaces the now-meaningless orthogonalised one), and
    // implicitly reset `H_{k-1} = I` by emptying the list. After this,
    // the iteration continues — the new pair (ŝ, c, d) computed below
    // is appended on top of identity, so `H_k` carries one rank-one
    // update by the time we exit the function.
    const sNormSq = dot(s, s);
    let sHatNormSq = dot(sHat, sHat);
    const windowSaturated = sHatCols.length >= memory;
    const linDepViolated = Math.sqrt(sHatNormSq) < tau * Math.sqrt(sNormSq);
    if (windowSaturated || linDepViolated) {
      restartWindow();
      // ŝ ← s: copy the raw iterate-diff into the orthogonalised slot.
      for (let i = 0; i < dim; i++) sHat[i] = s[i]!;
      sHatNormSq = sNormSq;
    }

    // ── step 5: Powell-regularised secant target (paper eq 10–11 simplified) ─
    //
    // The implementer-form Powell test (paper §7.1 closing paragraph,
    // matches Algorithm 3 line 9). The variable `gamma` here is the
    // paper's `γ_{k-1}` = `η_k^{m_k - 1}` (the Powell test input):
    //
    //   γ = ŝᵀ · H_{k-1} · y  /  ‖ŝ‖²
    //
    // Note `applyH(y)` uses the current stored list which may have just
    // been reset to identity by step 4. The `Hy` computation is what
    // distinguishes the inverse-form rank-one update from a Type-II
    // normal-equations solve: it never materialises `H_{k-1}`, just
    // applies it to the single vector `y` matrix-free.
    //
    // The Powell scalar `θ_{k-1} = φ_θ̄(γ)` lies in `[1 − θ̄, 1 + θ̄]` by
    // construction (Lemma 2). The regularised secant target:
    //
    //   ỹ = θ · y − (1 − θ) · g_{k-1}        (eq 10, B s = −g substitution)
    //
    // uses `g_{k-1} = g(x^{k-1})` — the residual at the *previous
    // accepted* iterate (not at the trial, not at the current accepted!).
    // The identity `B_{k-1} s_{k-1} = −g_{k-1}` is what justifies this
    // — the matrix-free substitute for `B_k^i s_{k-m_k+i}` in eq 10 is
    // exactly the residual at the iterate the rank-one update is
    // *between*, which is x^{k-1}.
    const Hy = applyH(y);
    const gamma = dot(sHat, Hy) / sHatNormSq;
    const theta = phiPowell(gamma, thetaBar);

    const gPrev = residual(xPrevLocal, fxPrevLocal);
    const yTilde = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      yTilde[i] = theta * y[i]! - (1 - theta) * gPrev[i]!;
    }

    // ── step 6: rank-one inverse-Jacobian update + trial step ────────────
    //
    // c = s − H_{k-1} · ỹ        (numerator vector of eq 13)
    // d = ŝᵀ · H_{k-1} · ỹ        (denominator scalar of eq 13)
    //
    // Append (ŝ, c, d) to the stored list — that *is* the rank-one
    // update; from here on `applyH` includes this new correction.
    //
    // The trial iterate: x̃^{k+1} = x^k − H_k · g_k, where g_k = g(x^k)
    // is the residual at the *currently accepted* iterate (xAccepted in
    // our notation — the one whose safeguard test produced it at the
    // previous `next` call). The trial step is centred on x^k, not on
    // x̃^k: the rank-one update H_k is layered for use at the current
    // accepted iterate.
    const HyTilde = applyH(yTilde);
    const c = new Float64Array(dim);
    for (let i = 0; i < dim; i++) c[i] = s[i]! - HyTilde[i]!;
    const d = dot(sHat, HyTilde);

    // Numerical guard: if `d` rounds to zero (Powell should prevent
    // this in the convergence regime — `|det(B_k)| ≥ θ̄^{m_k}` makes
    // `d` non-zero in exact arithmetic — but float64 underflow on a
    // degenerate secant pair is real). Restart the window unconditionally
    // and fall back to the KM step from x^k for this iteration: `d = 0`
    // means the rank-one update would be undefined, and the safest
    // recovery is to drop the current window and rebuild from scratch.
    if (!Number.isFinite(d) || d === 0) {
      restartWindow();
      const xNext = kmStep(xAccepted, fxAccepted);
      xPrev = xAccepted.slice();
      fxPrev = fxAccepted.slice();
      return { xNext, xTrialNext: xNext.slice() };
    }

    sHatCols.push(sHat);
    cCols.push(c);
    denoms.push(d);

    // Now apply the updated `H_k` to `g(x^k) = xAccepted − fxAccepted`
    // to form the trial step x̃^{k+1} = x^k − H_k · g(x^k).
    const gK = residual(xAccepted, fxAccepted);
    const Hg = applyH(gK);
    const xTilde = new Float64Array(dim);
    for (let i = 0; i < dim; i++) xTilde[i] = xAccepted[i]! - Hg[i]!;

    // Defensive: if the trial step is non-finite (a degenerate H_k
    // application can explode in float64 even when `d ≠ 0`), restart
    // and take the KM step. This complements the Powell + restart
    // boundedness guarantees with a pure-float64 sanity check.
    if (!isFiniteVec(xTilde)) {
      restartWindow();
      const xNext = kmStep(xAccepted, fxAccepted);
      xPrev = xAccepted.slice();
      fxPrev = fxAccepted.slice();
      return { xNext, xTrialNext: xNext.slice() };
    }

    // ── step 7: safeguard test ───────────────────────────────────────────
    //
    // ‖g_k‖ ≤ D · Ū · (n_AA + 1)^{−(1+ε)}: accept the AA-I trial.
    // Otherwise: fall back to f_α(x^k) — the KM-averaged step from the
    // currently accepted iterate (paper Algorithm 3 line 14).
    //
    // The gate is `‖g_k‖` where g_k = g(x^k) — the residual at the
    // currently accepted iterate (xAccepted), already computed above as
    // `gK`. The trial AA-I point `xTilde` is `x̃^{k+1}`. The accepted
    // next iterate `x^{k+1}` is *either* `xTilde` (accept) *or* a fresh
    // KM step from xAccepted (fall back). Either way, `xTrialNext` is
    // `xTilde` — the trial track continues regardless of the safeguard
    // decision, because the safeguard only filters which iterate gets
    // promoted to "accepted" status, not what the trial would have been.
    let gKNormSq = 0;
    for (let i = 0; i < dim; i++) gKNormSq += gK[i]! * gK[i]!;
    const gKNorm = Math.sqrt(gKNormSq);
    const threshold = safeguardD * (UBar ?? 0) * Math.pow(nAA + 1, -(1 + safeguardEps));

    let xNext: Float64Array;
    if (gKNorm <= threshold) {
      // Accept: the new accepted iterate is the AA-I trial.
      xNext = xTilde.slice();
      nAA++;
    } else {
      // Fall back to the KM-averaged step from x^k. The AA-I state
      // (sHatCols, cCols, denoms) is *not* cleared here — only the
      // current trial step is "rejected" for promotion. The next
      // iteration's restart test decides independently whether to reset.
      xNext = kmStep(xAccepted, fxAccepted);
    }

    // Roll the accepted-iterate slot forward for the next call.
    xPrev = xAccepted.slice();
    fxPrev = fxAccepted.slice();

    return { xNext, xTrialNext: xTilde };
  };

  return { next, reset };
}
