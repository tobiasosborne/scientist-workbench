// Primal-dual IPM main loop for the LP path. Mehrotra 1992
// predictor-corrector with size-3 Tikhonov regularization on the Schur
// complement and a Cholesky-factored normal-equations solve.

import { type Iterate, makeIterate, type SolverStatus } from "./Iterate.js";
import type { IpmParams } from "./Defaults.js";
import { DEFAULT_PARAMS } from "./Defaults.js";
import type { LpProblem } from "../problem/LpProblem.js";
import { updateResiduals, vecNormInf } from "./Residuals.js";
import { checkConvergence } from "./Convergence.js";
import { schurAssembleNormalEq } from "../linalg/SchurAssembler.js";
import {
  predictorDirection,
  correctorDirection,
} from "./Direction.js";
import { maxStepToBoundary, safeguardStep } from "./StepLength.js";
import {
  factorWith3Way,
  makeLpDiagnose,
  regParamsFromIpm,
} from "./Regularization.js";

export interface SolveResult {
  status: SolverStatus;
  iterate: Iterate;
  log: IterLogLine[];
}

export interface IterLogLine {
  iter: number;
  primalObj: number;
  dualObj: number;
  compl: number;
  primalInf: number;
  dualInf: number;
  timeSec: number;
}

/**
 * Verbose per-iter trace — every diagnostic scalar the solver computed
 * this iteration, in a unified schema across LP and SDP solvers. Fields
 * irrelevant to the current solver kind carry `NaN`. This is the
 * *in-process* trace type: consumed by the `verbose:` callback and by
 * `formatVerboseLine` for human-readable console traces.
 *
 * The *persisted* JSONL schema is `TraceLine` in `TraceLog.ts` — a
 * superset that also covers the external-log parser kinds (`"copt"`,
 * `"mosek"`) and permits `null` for every solver-internal field. A
 * compile-time assertion in that file proves every `VerboseIterLine` is a
 * valid `TraceLine`, so a field added here that is not mirrored there is a
 * build error, not a silently-skewed trace. Add new fields to **both**.
 *
 * The `kind` discriminator tells consumers which solver variant produced
 * the line and which fields are populated:
 *   "lp"           — legacy LP path (`solveLp` in this file). `eigMin{X,S}` are NaN.
 *   "sdp-nt"       — legacy NT direction (`solveSdpNt`).
 *   "sdp-aho"      — legacy AHO direction (`solveSdpAho`).
 *   "sdp-hkm"      — legacy HKM direction (`solveSdp` in `SdpSolver.ts`).
 *   "lp-hsde"      — HSDE LP path (`solveHsdeLp` in `HsdeLpSolver.ts`, Phase 1).
 *   "sdp-hsde-nt"  — HSDE NT SDP path (`solveHsdeSdpNt` in `HsdeNtSdpSolver.ts`, Phase 2).
 *
 * The regularization bumps are per-iter (delta from iter start), not
 * cumulative — the cumulative jitter values are in `jitter*`. `failRow`
 * is the Cholesky-reported failure row index for the most-recent failed
 * factorisation attempt this iter, or `null` if the first attempt
 * succeeded. Phase timings (`t*Ms`) are derived from `Bun.nanoseconds()`
 * deltas; they bracket distinct work units of the iteration.
 *
 * HSDE-only fields (`tau`, `kappa`, `gfeas`, `prstatus`) are NaN for
 * non-HSDE kinds. Per ADR-0033 §"Decision 8": the schema extends
 * additively; the diff harness already treats `null` (JSON-serialised
 * NaN) as "missing"; a future kind extension is wire-compatible via
 * `TraceLine`. These fields land in Phase 0 so the trace pipeline is
 * ready when the
 * HSDE algorithm work begins (HANDOFF §3.8 "instrument before
 * fixing" — the verbose trace was what turned worklog 095's stall
 * diagnosis from a multi-day investigation into a 5-minute read).
 *
 * IR-counter fields (`nitref1/2/3`) are the Phase-5 diagnostic slots
 * for ECOS/SDPT3-style iterative refinement on the three Schur back-
 * substitutions. Tier 0 populates them with 0 in HSDE solvers and NaN
 * elsewhere; Tier 1 increments them when refinement actually runs.
 */
export interface VerboseIterLine extends IterLogLine {
  kind: "lp" | "sdp-nt" | "sdp-aho" | "sdp-hkm" | "lp-hsde" | "sdp-hsde-nt";
  // Centering / step
  sigma: number;
  sigmaRaw: number;       // (muAff / mu)^3 pre-clip
  muAff: number;
  alphaPrimal: number;
  alphaDual: number;
  alphaPrimalRaw: number; // pre-safeguard maxStepToBoundary
  alphaDualRaw: number;
  // Regularization (3-way Tikhonov)
  jitterPrimal: number;
  jitterDual: number;
  jitterGap: number;
  bumpsPrimalThisIter: number;
  bumpsDualThisIter: number;
  bumpsGapThisIter: number;
  refactorsThisIter: number;
  failRow: number | null;
  // Schur conditioning proxies
  schurDiagMin: number;
  schurDiagMax: number;
  // SDP-only (NaN for "lp", "lp-hsde")
  eigMinX: number;
  eigMinS: number;
  // HSDE-only (NaN for non-HSDE kinds). Per ADR-0033 §"Decision 8":
  //   tau      — homogenization scalar τ, > 0 strictly on trial iterates
  //   kappa    — homogenization slack κ, > 0 strictly on trial iterates
  //   gfeas    — |r_g| = |−cᵀx + bᵀy − κ| (Mosek GFEAS log column)
  //   prstatus — (bᵀy − cᵀx) / max(‖b‖_∞, ‖c‖_∞, 1), → +1 on optimal
  //              branch, → −1 on infeasibility-certificate branch
  tau: number;
  kappa: number;
  gfeas: number;
  prstatus: number;
  // Iterative-refinement counters (HSDE Phase 5). For HSDE kinds:
  //   nitref1 — data-direction Schur back-substitution
  //   nitref2 — affine-direction Schur back-substitution
  //   nitref3 — combined-direction Schur back-substitution
  // Non-HSDE kinds carry NaN.
  nitref1: number;
  nitref2: number;
  nitref3: number;
  // Phase timings (milliseconds)
  tSchurMs: number;
  tFactorMs: number;
  tDirectionMs: number;
  tStepMs: number;
}

export interface SolveOptions {
  params?: Partial<IpmParams>;
  initialPoint?: (lp: LpProblem) => { x: Float64Array; y: Float64Array; s: Float64Array };
  /** COPT-format-compatible per-iter callback. Slim, byte-stable. */
  log?: (line: IterLogLine, it: Iterate) => void;
  /** Diagnostic per-iter callback. Rich schema (see `VerboseIterLine`). */
  verbose?: (line: VerboseIterLine) => void;
}

export function solveLp(lp: LpProblem, opts: SolveOptions = {}): SolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const it = makeIterate(lp.m, lp.n);
  it.startMs = Date.now();
  const init = (opts.initialPoint ?? defaultInitialPoint)(lp);
  it.x.set(init.x);
  it.y.set(init.y);
  it.s.set(init.s);
  // Initial regularisation: only primal carries the spec §6.2 floor
  // `initialJitter = 1e-12`; dual and gap start at exact 0. This keeps
  // the iter-0 Cholesky lift identical to the legacy single-tier path
  // (`1e-12`, not `3e-12`), preventing the trajectory from diverging
  // at the noise floor when Cholesky never needs the multi-tier scheme
  // (well-conditioned LPs like NETLIB lotfi never bump beyond iter-0).
  // Once any tier bumps, `tryBump` raises from 0 via the `Math.max(_, 1e-12)`
  // floor in Regularization.ts.
  it.jitterPrimal = params.initialJitter;
  it.jitterDual = 0;
  it.jitterGap = 0;

  // Pre-compute the LP diagnose-kind helper once per solve. Row norms of
  // A don't change between iterations, so this is iteration-invariant.
  //
  // LP-specific cap tuning. The spec §6.4 values `cap_p=1e-2, cap_d=1e+2,
  // cap_g=1e+2` cover the SDP path; for LP we widen `cap_p` to `1e+2` as
  // well. Rationale: the LP path's failures are primal-routed by
  // `makeLpDiagnose` (the constraint matrix's row scaling is the
  // dominant signal for LP ill-conditioning), so the primal cap is
  // load-bearing. The pre-spec-alignment LP code achieved its robustness
  // on degenerate cases (NETLIB brandy, lp-small F_infeasible_3var_sum)
  // by exploiting an `attempt < 6 OR primal < cap` shortcut that let
  // primal grow well past the nominal `1e-2` cap (effectively to ~1e+6
  // on the proportional-rows case) — a bug-as-feature that produced
  // heavy regularisation without spilling into dual/gap. Widening the
  // primal cap directly to `1e+2` recovers that headroom under the
  // spec-correct semantics. Dual cap held at `1e-2` (small lift only
  // when primal saturates and the diagnose hands off — limits the sum
  // to ~2·1e+2 in the worst case, which is the same magnitude as
  // baseline's effective regularisation).
  //
  // MAX_REFACTOR=20 (vs spec §6.4's 10) for parity with the legacy
  // factorWithRegularization behaviour; narrowing to 10 is safe once the
  // diagnose routing is validated end-to-end on the full NETLIB corpus.
  const lpDiagnose = makeLpDiagnose(lp.A, lp.m, lp.n);
  const regParams = regParamsFromIpm(
    { ...params, jitterMaxDual: 1e-2, jitterMaxGap: 1e-2 },
    /*maxRefactor=*/ 20,
  );

  const log: IterLogLine[] = [];

  // High-resolution clock for phase timings. `Bun.nanoseconds()` returns
  // an integer nanosecond count from a monotonic clock; we convert to ms
  // at emission time. `performance.now()` would also work but is float
  // and accumulates rounding under the noise floor of our sub-ms phases.
  const nowNs = (): number => Bun.nanoseconds();

  for (it.iter = 0; it.iter <= params.iterLimit; it.iter++) {
    updateResiduals(it, lp);

    const conv = checkConvergence(it, lp, params);
    const line: IterLogLine = {
      iter: it.iter,
      primalObj: it.primalObj,
      dualObj: it.dualObj,
      compl: it.mu,
      primalInf: it.primalInf,
      dualInf: it.dualInf,
      timeSec: (Date.now() - it.startMs) / 1000,
    };
    log.push(line);
    opts.log?.(line, it);

    if (conv.status !== "running") {
      it.status = conv.status;
      return { status: it.status, iterate: it, log };
    }

    // Snapshot reg counters at iter start so we can emit per-iter deltas
    // (the absolute counts are also in `it.bumps*` if a caller wants them).
    const bumpsPSnap = it.bumpsPrimal;
    const bumpsDSnap = it.bumpsDual;
    const bumpsGSnap = it.bumpsGap;
    const refactorsSnap = it.refactors;

    // Build LP Schur complement M = A · diag(x/s) · A^T.
    const tSchurStart = nowNs();
    const d = new Float64Array(lp.n);
    for (let j = 0; j < lp.n; j++) d[j] = it.x[j]! / it.s[j]!;
    schurAssembleNormalEq(lp.A, lp.m, lp.n, d, it.M);

    // Schur-diag conditioning proxy: min/max of M's diagonal pre-lift.
    // For a well-conditioned LP this range is tight; large ratios herald
    // upcoming Cholesky retries.
    let schurDiagMin = Infinity;
    let schurDiagMax = -Infinity;
    for (let i = 0; i < lp.m; i++) {
      const d_ii = it.M[i * lp.m + i]!;
      if (d_ii < schurDiagMin) schurDiagMin = d_ii;
      if (d_ii > schurDiagMax) schurDiagMax = d_ii;
    }
    const tSchurMs = (nowNs() - tSchurStart) / 1e6;

    // 3-way regularization retry loop — shared helper in Regularization.ts.
    // δ counters carry across iterations (legacy behaviour; spec §6.3's
    // "reset unless heavy refactor" pattern is a v2 refinement).
    const tFactorStart = nowNs();
    const factorRes = factorWith3Way(it.M, it.m, it.Lchol, it, regParams, lpDiagnose);
    const tFactorMs = (nowNs() - tFactorStart) / 1e6;
    if (!factorRes.success) {
      it.status = "numerical-error";
      return { status: it.status, iterate: it, log };
    }

    // Predictor: σ = 0.
    const tDirStart = nowNs();
    predictorDirection(it, lp);
    const dxAff = new Float64Array(it.dx);
    const dyAff = new Float64Array(it.dy);
    const dsAff = new Float64Array(it.ds);
    const tStepStart = nowNs();
    const alphaPaff = maxStepToBoundary(it.x, dxAff);
    const alphaDaff = maxStepToBoundary(it.s, dsAff);
    let tStepMs = (nowNs() - tStepStart) / 1e6;

    // σ = (μ_aff / μ)^3, Mehrotra centering heuristic.
    //
    // Spec §2 step 5 specifies the clip [1e-8, 0.9]. For the LP path we keep
    // the wider [0, 1] clip — the lower bound 1e-8 damps the pure-affine
    // direction enough to suppress the Farkas y → ∞ growth needed for
    // infeasibility certificates (NETLIB lotfi and lp-small F_infeasible_*
    // regress at the spec floor). Revisit once dual-infeasibility detection
    // uses a magnitude-aware certificate test rather than the raw
    // y_∞ > 1e8 threshold in Convergence.ts.
    let muAff = 0;
    const aP = Math.min(1, alphaPaff);
    const aD = Math.min(1, alphaDaff);
    for (let j = 0; j < lp.n; j++) {
      muAff += (it.x[j]! + aP * dxAff[j]!) * (it.s[j]! + aD * dsAff[j]!);
    }
    muAff /= Math.max(1, lp.n);
    const sigmaRaw = (muAff / Math.max(it.mu, 1e-300)) ** 3;
    const sigma = Math.max(0, Math.min(1, sigmaRaw));
    const sigmaMu = sigma * it.mu;

    // Corrector: rc = -XSe + σμ - Δx_aff ∘ Δs_aff, reusing Cholesky factor.
    correctorDirection(it, lp, sigmaMu, dxAff, dsAff);
    const tDirectionMs = (nowNs() - tDirStart) / 1e6 - tStepMs;

    // Step lengths with Mehrotra safeguard.
    const tStep2Start = nowNs();
    const alphaPraw = Math.min(1, maxStepToBoundary(it.x, it.dx));
    const alphaDraw = Math.min(1, maxStepToBoundary(it.s, it.ds));
    tStepMs += (nowNs() - tStep2Start) / 1e6;
    const alphaP = safeguardStep(alphaPraw, params.stepFactor);
    const alphaD = safeguardStep(alphaDraw, params.stepFactor);

    // Update iterate (LP branch).
    for (let j = 0; j < lp.n; j++) it.x[j] = it.x[j]! + alphaP * it.dx[j]!;
    for (let i = 0; i < lp.m; i++) it.y[i] = it.y[i]! + alphaD * it.dy[i]!;
    for (let j = 0; j < lp.n; j++) it.s[j] = it.s[j]! + alphaD * it.ds[j]!;

    // Stall detection — increment when μ decreased by less than 1%
    // (threshold 0.99 per CLEANROOM_SPEC.md §3.3); reset on real progress.
    // The pre-alignment 0.9 threshold (10% required progress) was too eager:
    // declared stall even when iterates were making normal 1–5% late-stage
    // progress. Triggers `numerical-difficulty` after stallIterCap=10
    // consecutive stalls.
    const muBefore = it.mu;
    let muNew = 0;
    for (let j = 0; j < lp.n; j++) muNew += it.x[j]! * it.s[j]!;
    muNew /= Math.max(1, lp.n);
    if (muNew > 0.99 * muBefore) it.stallCount++;
    else it.stallCount = 0;

    // Verbose trace emission — fire after the iter is fully resolved so
    // every diagnostic field reflects the work done. `log?` already fired
    // at the top of the iter; verbose fires at the bottom on purpose
    // (sigma/alpha/reg-deltas/timings only exist post-iter).
    if (opts.verbose) {
      const v: VerboseIterLine = {
        ...line,
        kind: "lp",
        sigma,
        sigmaRaw,
        muAff,
        alphaPrimal: alphaP,
        alphaDual: alphaD,
        alphaPrimalRaw: alphaPraw,
        alphaDualRaw: alphaDraw,
        jitterPrimal: it.jitterPrimal,
        jitterDual: it.jitterDual,
        jitterGap: it.jitterGap,
        bumpsPrimalThisIter: it.bumpsPrimal - bumpsPSnap,
        bumpsDualThisIter: it.bumpsDual - bumpsDSnap,
        bumpsGapThisIter: it.bumpsGap - bumpsGSnap,
        refactorsThisIter: it.refactors - refactorsSnap,
        failRow: factorRes.lastFailRow,
        schurDiagMin,
        schurDiagMax,
        eigMinX: NaN,
        eigMinS: NaN,
        tau: NaN,
        kappa: NaN,
        gfeas: NaN,
        prstatus: NaN,
        nitref1: NaN,
        nitref2: NaN,
        nitref3: NaN,
        tSchurMs,
        tFactorMs,
        tDirectionMs,
        tStepMs,
      };
      opts.verbose(v);
    }
  }

  it.status = "iter-limit";
  return { status: it.status, iterate: it, log };
}

// Mehrotra warm-start (LP, infeasible-start). Standard heuristic
// from Wright 1997 §11: ξ = max(1, 10·‖b‖∞), η = max(1, 10·‖c‖∞).
// Suitable for small dense problems; a more elaborate workspace
// builder (Andersen-Andersen 2000) is the natural extension if the
// iteration count climbs on individual NETLIB cases.
function defaultInitialPoint(lp: LpProblem): {
  x: Float64Array;
  y: Float64Array;
  s: Float64Array;
} {
  const { m, n, b, c } = lp;
  const bNorm = vecNormInf(b);
  const cNorm = vecNormInf(c);
  const xi = Math.max(1, 10 * bNorm);
  const eta = Math.max(1, 10 * cNorm);
  const x = new Float64Array(n).fill(xi);
  const s = new Float64Array(n).fill(eta);
  const y = new Float64Array(m);
  return { x, y, s };
}

// 3-way Tikhonov regularization retry loop — CLEANROOM_SPEC.md §6.
//
// Bump strategy when Cholesky reports a non-positive pivot:
//   - Primal first (×10, cap 1e-2): primal-degenerate rows, small lift suffices.
//   - Then dual (×100, cap 1e+2): dual-degenerate rows, large headroom.
//   - Then gap (×100, cap 1e+2): generic ill-conditioning, large headroom.
//
// The heuristic for "which to bump" is currently `attempt < 6 → primal, then
// dual, then gap` — a blind escalation order. Spec §6.5's row-based diagnose
// rule (||A_r||_∞, |h_r| magnitudes) is the v2 upgrade (CholeskyDiagnose
// task #9). Until that lands, blind escalation needs the wider attempt
// budget (20, not the spec's 10) to recover infeasibility cases like
// `F_infeasible_3var_sum` (rank-deficient Schur from proportional rows).
// The narrower budget is admissible once diagnose-kind picks the gap
// regularizer directly rather than burning attempts on irrelevant primal
// bumps. Cross-reference: tasks #8 (shared helper) and #9 (diagnose-kind).
