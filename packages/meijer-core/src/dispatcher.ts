// =============================================================================
// dispatcher.ts — top-level Meijer G evaluator (Layer 7, ADR-0027)
// =============================================================================
//
// `meijergDispatch(symbolicParams, numericalParams, z, precision, opts)`
// composes the four algorithmic layers
//
//   Layer 4 — symbolic dispatch (`meijergSymbolic`, ADR-0025)
//   Layer 3 — Slater residue summation (`meijergSlater`, hv0.5)
//   Layer 5 — Mellin–Barnes contour quadrature (`meijergContour`, ADR-0022)
//   Layer 6 — Braaksma asymptotic (`meijergAsymptotic`, ADR-0026)
//
// in **cost-ascending order** (ADR-0027 §1) into a single integrated
// evaluator. Every input lands in one of three honest output shapes:
//
//   * `{ kind: "symbolic", expr, ruleId, ruleSource, note, method: "symbolic-dispatch" }`
//   * `{ kind: "numerical", value, achievedPrecision, method: "slater-…|mellin-barnes|braaksma-algebraic", warnings, … }`
//   * `{ kind: "refused", class: "out-of-region|branch-cut-ambiguous|non-finite-input|degenerate-shape", reason, ruledOutMethods }`
//
// The dispatcher is **mechanical**: the dispatch loop is a flat switch
// over four lanes; each lane has a fast pre-filter (one of the
// `canUse…` predicates) that decides "applicable here?" before any
// numerical work runs; refusals from each lane fold into the
// integrated `out-of-region` envelope identically. There is no
// bespoke envelope handling per lane — that's the load-bearing
// shape, mirrored from `tools/solve` (worklog 054).
//
// Branch-cut convention (ADR-0027 §3, DLMF §16.17.1)
// --------------------------------------------------
// `log z = log|z| + i · arg z` with `arg z ∈ (−π, π]`.
// All numerical layers consume `z` and call `clog(z, …)` from
// `@workbench/bigfloat`, which implements this branch. The
// dispatcher does *not* re-pre-process `z`; it does centralise the
// degenerate-input checks (z = 0, z = NaN/Inf, z on the cut with
// Im(z) = 0).
//
// Schwarz reflection self-test (ADR-0027 §6)
// ------------------------------------------
// For non-cut z with real parameters,
// `G(params; z̄) = conj(G(params; z))`. The dispatcher exposes an
// opt-in `schwarzCheck: true` mode that computes both, asserts
// agreement to user precision, and surfaces a warning on mismatch
// rather than failing hard (a hard failure would conflict with the
// asymptotic layer's per-pole error estimate, which itself absorbs
// a few digits of precision). Off by default in production; on by
// default in `tool.test.ts`.
//
// Determinism contract
// --------------------
// `arbprec: true`. Same `(symbolicParams, numericalParams, z,
// precision, opts)` ⇒ same output bytes, on every platform, forever.
// `BigInt` arithmetic is bit-identical across runtimes by language
// specification; the bigfloat / bigcomplex substrate inherits this;
// every layer's orchestrator inherits it from the substrate.

import {
  type BigComplex,
  type BigFloat,
  cabs,
  cconj,
  cmp,
  csub,
  decimalToBinaryPrecision,
  div,
  fromInt,
  isZero,
  mul,
  toFloat64,
} from "@workbench/bigfloat";
import type { Value } from "@workbench/protocol";
import {
  meijergAsymptotic,
  type MeijerGAsymptoticOptions,
  type MeijerGAsymptoticResult,
} from "./asymptotic.js";
import {
  meijergContour,
  type MeijerGContourOptions,
  type MeijerGContourResult,
} from "./contour.js";
import { meijergSymbolic } from "./dispatch.js";
import type { MeijerGSymbolicParams } from "./dispatch-types.js";
import { meijergSlater } from "./slater.js";
import { selectSeries } from "./series-select.js";
import type {
  MeijerGParameters,
  MeijerGSlaterOptions,
  MeijerGSlaterResult,
} from "./types.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * Which method (lane) was tried.
 *
 * The `string` literals are stable diagnostic strings; the wire tool
 * surfaces them as the `method` field of the success record.
 */
export type DispatchMethod =
  | "symbolic-dispatch"
  | "slater-series-1"
  | "slater-series-2"
  | "mellin-barnes"
  | "braaksma-algebraic";

/**
 * Forced-method override. `undefined` (the default) runs the full
 * cost-ascending dispatch ladder.
 */
export type ForceMethod =
  | "symbolic"
  | "slater"
  | "contour"
  | "asymptotic";

/**
 * Caller-facing request mode. `auto` is the default cost-ascending
 * dispatch; the other two modes constrain the ladder.
 */
export type RequestMode =
  | "auto"
  | "symbolic-required"
  | "numerical-required";

/**
 * Caller options. All fields are optional; the dispatcher's defaults
 * are documented inline.
 */
export interface MeijerGDispatchOptions {
  /** Default `auto`. */
  readonly requestMode?: RequestMode;
  /** Default `undefined` (full ladder). */
  readonly forceMethod?: ForceMethod;
  /**
   * If true, after a successful numerical evaluation, run the
   * Schwarz-reflection self-test: compute G(z̄) and assert it equals
   * conj(G(z)) to user precision (less a 5-digit margin for the
   * per-method error estimate). On mismatch, the dispatcher attaches
   * a warning to the success record. Off by default; on in tests.
   */
  readonly schwarzCheck?: boolean;
  /** Forwarded to `meijergSlater`. */
  readonly slaterOpts?: MeijerGSlaterOptions;
  /** Forwarded to `meijergContour`. */
  readonly contourOpts?: MeijerGContourOptions;
  /** Forwarded to `meijergAsymptotic`. */
  readonly asymptoticOpts?: MeijerGAsymptoticOptions;
}

/** Per-layer refusal record carried in the integrated refusal envelope. */
export interface RuledOutMethod {
  readonly method: DispatchMethod | "symbolic-dispatch";
  readonly status: string;
  readonly reason: string;
}

/** Symbolic-success result. */
export interface MeijerGSymbolicSuccess {
  readonly kind: "symbolic";
  readonly expr: Value;
  readonly ruleId: string;
  readonly ruleSource: string;
  readonly note: string;
  readonly method: "symbolic-dispatch";
}

/** Numerical-success result. */
export interface MeijerGNumericalSuccess {
  readonly kind: "numerical";
  readonly value: BigComplex;
  readonly achievedPrecision: number;
  readonly method: Exclude<DispatchMethod, "symbolic-dispatch">;
  readonly warnings: readonly string[];
  /** Substrate-layer-specific diagnostics. */
  readonly diagnostics: Readonly<Record<string, number | string | boolean>>;
}

/** Refusal result. */
export interface MeijerGRefusal {
  readonly kind: "refused";
  readonly class:
    | "out-of-region"
    | "branch-cut-ambiguous"
    | "non-finite-input"
    | "degenerate-shape"
    | "symbolic-required-no-match"
    | "forced-method-refused"
    | "input-error";
  readonly reason: string;
  readonly ruledOutMethods: readonly RuledOutMethod[];
}

export type MeijerGDispatchResult =
  | MeijerGSymbolicSuccess
  | MeijerGNumericalSuccess
  | MeijerGRefusal;

// -----------------------------------------------------------------------------
// Pre-filter predicates (ADR-0027 §2)
// -----------------------------------------------------------------------------
//
// Each `canUse…` returns one of:
//   * `{ ok: true }` — the layer is *applicable* to this input;
//   * `{ ok: false, reason }` — the layer's pre-filter says no.
//
// The dispatcher reads these *before* invoking the layer; the
// reason string is folded into the integrated refusal envelope when
// every lane refuses.

interface PrefilterVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Pre-filter for the symbolic layer. Symbolic dispatch is *always*
 * applicable as a first try — the rule table either matches or
 * doesn't. The pre-filter returns true unconditionally; the actual
 * "did we match?" decision is the rule walk inside `meijergSymbolic`.
 *
 * The argument is accepted for symmetry with the other pre-filters
 * (and to permit a future v0.2 to short-circuit when the parameter
 * shape is structurally outside any rule's `(m, n, p, q)` envelope).
 */
export function canUseSymbolic(
  _params: MeijerGSymbolicParams,
): PrefilterVerdict {
  return { ok: true, reason: "" };
}

/**
 * Pre-filter for the Slater layer. Refuses when:
 *   * `m + n = 0` (both residue-line clusters empty — neither
 *     series can close);
 *   * `|z| ≈ 1 ∧ p = q ∧ m + n = p` (the quarantine band — both
 *     Slater series have inner-pFq radius of convergence 1).
 *
 * The selection rule (`series-select.ts`) carries the same logic;
 * we shadow it here so the pre-filter result is available *before*
 * any work runs. (Re-running `selectSeries` is cheap — it's a
 * float64 |z| compare.)
 */
export function canUseSlater(
  params: MeijerGParameters,
  z: BigComplex,
  opts?: MeijerGSlaterOptions,
): PrefilterVerdict {
  const m = params.bm.length;
  const n = params.an.length;
  if (m + n === 0) {
    return {
      ok: false,
      reason:
        "m = n = 0: neither Slater series has Γ-poles to close around",
    };
  }
  const sel = selectSeries(params, z, opts);
  if (sel.quarantine) {
    return {
      ok: false,
      reason:
        `|z| ≈ 1 with p = q = ${sel.p} and m + n = p; both Slater series ` +
        `inner-pFq sit at the radius of convergence`,
    };
  }
  return { ok: true, reason: "" };
}

/**
 * Pre-filter for the contour layer. Refuses when:
 *   * `m + n = 0` (same as Slater — at least one Γ-pole cluster
 *     must be active);
 *   * `2(m + n) ≤ p + q` (Stirling-derived: the Mellin–Barnes
 *     integrand does not decay along a vertical contour — see
 *     `contour.ts` §"decay-rate check");
 *   * `max{Re(a_j) − 1} ≥ min{Re(b_j)}` (the Γ-pole clusters
 *     overlap; no vertical contour separates them);
 *   * `m = 0` or `n = 0` *with* `|z| ≥ 1` (one-sided pole cluster
 *     on a non-symmetric input — the contour layer's
 *     `pickTruncation` searches an unbounded T range in this regime,
 *     and the quadrature driver hits `maxEvals` without convergence;
 *     route to Slater or asymptotic instead).
 *
 * The third and fourth checks shadow the layer's own validation; we
 * replicate them here so the dispatcher can refuse *without* a call.
 * The fourth is the load-bearing one for ADR-0027 §2 cost-bound
 * discipline: the contour layer is *correct* but cost-unbounded on
 * one-sided large-|z| inputs, and the cost-ascending dispatch
 * routes around it cleanly.
 */
export function canUseContour(
  params: MeijerGParameters,
  z: BigComplex,
): PrefilterVerdict {
  const m = params.bm.length;
  const n = params.an.length;
  const p = n + params.ap.length;
  const q = m + params.bq.length;

  if (m + n === 0) {
    return { ok: false, reason: "m = n = 0: trivial Γ-products, no decay" };
  }
  const decayOrder = 2 * (m + n) - (p + q);
  if (decayOrder <= 0) {
    return {
      ok: false,
      reason:
        `2(m + n) = ${2 * (m + n)} ≤ p + q = ${p + q}: vertical contour does not decay`,
    };
  }
  // One-sided cluster + |z| ≥ 1: contour-truncation cost-unbounded.
  if (m === 0 || n === 0) {
    const reF = toFloat64(z.re).value;
    const imF = toFloat64(z.im).value;
    const zMag = Math.hypot(reF, imF);
    if (Number.isFinite(zMag) && zMag >= 1) {
      return {
        ok: false,
        reason:
          `${m === 0 ? "m" : "n"} = 0 with |z| = ${zMag.toExponential(3)} ≥ 1: ` +
          `one-sided contour-truncation is cost-unbounded`,
      };
    }
  }
  // Pole-cluster overlap: float64 check (the contour layer does the
  // BigFloat check internally on the actual `c` chosen, but the
  // pre-filter wants a fast yes/no).
  const allUpper = [...params.an, ...params.ap];
  const allLower = [...params.bm, ...params.bq];
  if (allUpper.length > 0 && allLower.length > 0) {
    let maxAReMinus1 = -Infinity;
    for (const a of allUpper) {
      const r = toFloat64(a.re).value - 1;
      if (Number.isFinite(r) && r > maxAReMinus1) maxAReMinus1 = r;
    }
    let minBRe = Infinity;
    for (const b of allLower) {
      const r = toFloat64(b.re).value;
      if (Number.isFinite(r) && r < minBRe) minBRe = r;
    }
    if (Number.isFinite(maxAReMinus1) && Number.isFinite(minBRe)) {
      if (maxAReMinus1 >= minBRe) {
        return {
          ok: false,
          reason:
            `max{Re(a_j) − 1} = ${maxAReMinus1} ≥ min{Re(b_j)} = ${minBRe}: ` +
            `Γ-pole clusters overlap`,
        };
      }
    }
  }
  return { ok: true, reason: "" };
}

/**
 * Pre-filter for the asymptotic layer. Refuses when:
 *   * `n = 0` (no upper poles to close on the right);
 *   * `|z| < 1` (asymptotic does not apply at small |z|);
 *   * `|arg z| ≥ π/2 − π/64` (outside the v0.1 principal sector).
 *
 * The `precision` parameter is forwarded so the layer's own
 * Stokes-band margin (which scales with working precision) can be
 * pre-checked. We use float64 |arg z| here — the band is
 * `2^{−workingBits/4}` wide, well above float64's angular precision.
 */
export function canUseAsymptotic(
  params: MeijerGParameters,
  z: BigComplex,
  precision: number,
  opts?: MeijerGAsymptoticOptions,
): PrefilterVerdict {
  const n = params.an.length;
  if (n === 0) {
    return {
      ok: false,
      reason: "n = 0: no upper poles available for the right-closing asymptotic",
    };
  }
  if (isZero(z.re) && isZero(z.im)) {
    return {
      ok: false,
      reason: "z = 0: |z| → ∞ asymptotic does not apply at the origin",
    };
  }
  const reF = toFloat64(z.re).value;
  const imF = toFloat64(z.im).value;
  const zMag = Math.hypot(reF, imF);
  if (!Number.isFinite(zMag) || zMag < 1) {
    return {
      ok: false,
      reason: `|z| = ${zMag.toExponential(3)} < 1: not in the |z| → ∞ regime`,
    };
  }
  const absArg = Math.abs(Math.atan2(imF, reF));
  const angle = opts?.principalSectorAngle ?? Math.PI / 2 - Math.PI / 64;
  // Use the float64 working-bit estimate; matches the layer's own.
  const workingBits = decimalToBinaryPrecision(precision, 30);
  const margin = Math.pow(2, -workingBits / 4);
  if (absArg >= angle - margin) {
    return {
      ok: false,
      reason:
        `|arg z| = ${absArg.toFixed(6)} ≥ ${(angle - margin).toFixed(6)}: ` +
        `outside the principal sector`,
    };
  }
  return { ok: true, reason: "" };
}

// -----------------------------------------------------------------------------
// Branch / shape pre-checks (centralised; ADR-0027 §3)
// -----------------------------------------------------------------------------

/**
 * Validate `z` and the parameter shape *before* any layer runs.
 * Three classes of structural refusal are caught here so every layer
 * can assume well-formed input:
 *
 *   * `non-finite-input` — z contains NaN or Inf in either component.
 *     `BigFloat` mantissa = 0n with extreme exponent shows up as
 *     `toFloat64` returning NaN/Inf; we test for it.
 *   * `degenerate-shape` — m + n = 0. Slater, contour, and
 *     asymptotic all require ≥ 1 Γ-pole cluster; symbolic typically
 *     can match (e.g. `G^{0,0}_{0,0}(_;_|z) = 1`) but if it doesn't,
 *     the dispatcher emits the structural refusal directly.
 *   * `branch-cut-ambiguous` — z is exactly on the negative real
 *     axis (`Im(z) = 0 ∧ Re(z) < 0`). The principal-branch convention
 *     places this *above* the cut; the dispatcher returns the
 *     value but warns. (For caller code that genuinely lives on the
 *     cut, pass z with a small +i imag part for "above" or −i for
 *     "below".)
 *
 * Returns null if the input is well-formed; a `MeijerGRefusal`
 * otherwise.
 */
function checkInputShape(
  numericalParams: MeijerGParameters,
  z: BigComplex,
): MeijerGRefusal | { onCut: boolean } {
  const reF = toFloat64(z.re).value;
  const imF = toFloat64(z.im).value;
  if (!Number.isFinite(reF) || !Number.isFinite(imF)) {
    return {
      kind: "refused",
      class: "non-finite-input",
      reason: `z has non-finite components: re=${reF}, im=${imF}`,
      ruledOutMethods: [],
    };
  }
  // Parameter components: defensive check. cgamma raises on Inf
  // anyway, but we want to surface it as a clean refusal envelope
  // rather than a layer's input-error.
  for (const lst of [
    numericalParams.an,
    numericalParams.ap,
    numericalParams.bm,
    numericalParams.bq,
  ]) {
    for (const v of lst) {
      const pre = toFloat64(v.re).value;
      const pim = toFloat64(v.im).value;
      if (!Number.isFinite(pre) || !Number.isFinite(pim)) {
        return {
          kind: "refused",
          class: "non-finite-input",
          reason:
            `parameter has non-finite components: re=${pre}, im=${pim}`,
          ruledOutMethods: [],
        };
      }
    }
  }
  // Branch-cut detection: Im(z) = 0 ∧ Re(z) < 0.
  const onCut = isZero(z.im) && reF < 0;
  return { onCut };
}

// -----------------------------------------------------------------------------
// Public entry: meijergDispatch
// -----------------------------------------------------------------------------

/**
 * Dispatch `G^{m,n}_{p,q}(an, ap, bm, bq | z)` through the
 * cost-ascending ladder. Returns one of three result shapes:
 *
 *   * `MeijerGSymbolicSuccess` — symbolic match fired.
 *   * `MeijerGNumericalSuccess` — one of the three numerical layers
 *     succeeded; `method` names which one.
 *   * `MeijerGRefusal` — every applicable layer refused; the
 *     `ruledOutMethods` list names them.
 *
 * The dispatcher takes **both** the symbolic and numerical views of
 * the parameters: the symbolic layer pattern-matches against the
 * Value-AST view (`symbolicParams` + `zValue`), while the numerical
 * layers consume the BigComplex view (`numericalParams` + `z`). The
 * wire tool builds both side-by-side from the value-protocol input;
 * pure-numerical callers pass `zValue = undefined` and constrain
 * `requestMode = "numerical-required"`.
 */
export function meijergDispatch(
  symbolicParams: MeijerGSymbolicParams,
  numericalParams: MeijerGParameters,
  zValue: Value | undefined,
  z: BigComplex,
  precision: number,
  opts: MeijerGDispatchOptions = {},
): MeijerGDispatchResult {
  // ----------------------------------------------------- input gates
  if (!Number.isInteger(precision) || precision < 1) {
    return {
      kind: "refused",
      class: "input-error",
      reason: `precision must be a positive integer; got ${precision}`,
      ruledOutMethods: [],
    };
  }

  const m = numericalParams.bm.length;
  const n = numericalParams.an.length;

  const shapeCheck = checkInputShape(numericalParams, z);
  if ("kind" in shapeCheck) {
    return shapeCheck;
  }
  const onCut = shapeCheck.onCut;

  // ----------------------------------------------------- forced-method short-circuit
  // ADR-0027 §7: --force-method=<lane> bypasses the dispatch ladder.
  if (opts.forceMethod !== undefined) {
    return runForced(
      opts.forceMethod,
      symbolicParams,
      numericalParams,
      zValue,
      z,
      precision,
      opts,
    );
  }

  // ----------------------------------------------------- request-mode prelude
  const requestMode: RequestMode = opts.requestMode ?? "auto";
  const tryNumerical = requestMode !== "symbolic-required";
  // Symbolic dispatch needs `zValue` (the AST view of z); pure-
  // numerical callers pass undefined, in which case symbolic is
  // skipped silently.
  const trySymbolic =
    requestMode !== "numerical-required" && zValue !== undefined;

  const ruledOut: RuledOutMethod[] = [];

  // ====================================================== Lane 1 — symbolic
  // ADR-0027 §1: cheapest first. Symbolic walk is one-table-walk over
  // a small rule list; it is essentially free.
  if (trySymbolic && zValue !== undefined) {
    const symVerdict = canUseSymbolic(symbolicParams);
    if (symVerdict.ok) {
      const sym = meijergSymbolic(symbolicParams, zValue);
      if (sym.kind === "matched") {
        return {
          kind: "symbolic",
          expr: sym.expr,
          ruleId: sym.ruleId,
          ruleSource: sym.ruleSource,
          note: sym.note ?? "",
          method: "symbolic-dispatch",
        };
      }
      ruledOut.push({
        method: "symbolic-dispatch",
        status: "no-known-reduction",
        reason: sym.reason,
      });
    } else {
      ruledOut.push({
        method: "symbolic-dispatch",
        status: "pre-filter-refused",
        reason: symVerdict.reason,
      });
    }
    if (requestMode === "symbolic-required") {
      return {
        kind: "refused",
        class: "symbolic-required-no-match",
        reason:
          `request_mode = symbolic-required and no rule matched in the v0.1 dispatch table`,
        ruledOutMethods: ruledOut,
      };
    }
  }

  // ====================================================== Lane 2 — Slater
  if (tryNumerical) {
    const slVerdict = canUseSlater(numericalParams, z, opts.slaterOpts);
    if (slVerdict.ok) {
      const sl = meijergSlater(numericalParams, z, precision, opts.slaterOpts);
      if (sl.status === "success") {
        const result: MeijerGNumericalSuccess = {
          kind: "numerical",
          value: sl.value,
          achievedPrecision: sl.achievedPrecision,
          method: sl.method,
          warnings: sl.warnings,
          diagnostics: {
            seriesTerms: sl.seriesTerms,
            perturbationApplied: sl.perturbationApplied,
            cancellationDigitsLost: sl.cancellationDigitsLost,
            workingPrecision: sl.workingPrecision,
            onBranchCut: onCut,
          },
        };
        return finaliseNumerical(
          result,
          symbolicParams,
          numericalParams,
          zValue,
          z,
          precision,
          opts,
        );
      }
      ruledOut.push({
        method: "slater-series-1",
        status: sl.status,
        reason: sl.reason,
      });
      // Higher-order-residue refusal short-circuits the remaining
      // numerical lanes (bead `scientist-workbench-fwsz`).  The
      // ≥3-pole integer-spaced coalescence is a property of the
      // *input parameters* — not of the Slater path specifically.
      // Contour-quadrature and Braaksma asymptotic both hit the same
      // Γ-pole-cluster structure on these inputs and become
      // cost-unbounded, so the dispatcher folds Slater's structured
      // refusal directly into the integrated envelope rather than
      // chase a hang on lanes that can't help either.
      if (sl.status === "coalescence-needs-higher-order-residue") {
        return {
          kind: "refused",
          class: "out-of-region",
          reason:
            `≥3-pole integer-spaced coalescence detected; every numerical lane ` +
            `requires the higher-order Slater 1966 §5 closed-form residue ` +
            `(digamma/polygamma) which v0.1 does not implement`,
          ruledOutMethods: ruledOut,
        };
      }
    } else {
      ruledOut.push({
        method: "slater-series-1",
        status: "pre-filter-refused",
        reason: slVerdict.reason,
      });
    }
  }

  // ====================================================== Lane 3 — contour
  if (tryNumerical) {
    const ctVerdict = canUseContour(numericalParams, z);
    if (ctVerdict.ok) {
      const ct = meijergContour(
        numericalParams,
        z,
        precision,
        opts.contourOpts,
      );
      if (ct.status === "success") {
        const result: MeijerGNumericalSuccess = {
          kind: "numerical",
          value: ct.value,
          achievedPrecision: ct.achievedPrecision,
          method: ct.method,
          warnings: ct.warnings,
          diagnostics: {
            nEvals: ct.nEvals,
            converged: ct.converged,
            workingPrecision: ct.workingPrecision,
            onBranchCut: onCut,
          },
        };
        return finaliseNumerical(
          result,
          symbolicParams,
          numericalParams,
          zValue,
          z,
          precision,
          opts,
        );
      }
      ruledOut.push({
        method: "mellin-barnes",
        status: ct.status,
        reason: ct.reason,
      });
    } else {
      ruledOut.push({
        method: "mellin-barnes",
        status: "pre-filter-refused",
        reason: ctVerdict.reason,
      });
    }
  }

  // ====================================================== Lane 4 — asymptotic
  if (tryNumerical) {
    const asVerdict = canUseAsymptotic(
      numericalParams,
      z,
      precision,
      opts.asymptoticOpts,
    );
    if (asVerdict.ok) {
      const as = meijergAsymptotic(
        numericalParams,
        z,
        precision,
        opts.asymptoticOpts,
      );
      if (as.status === "success") {
        const result: MeijerGNumericalSuccess = {
          kind: "numerical",
          value: as.value,
          achievedPrecision: as.achievedPrecision,
          method: as.method,
          warnings: as.warnings,
          diagnostics: {
            nTerms: as.nTerms,
            sector: as.sector,
            workingPrecision: as.workingPrecision,
            onBranchCut: onCut,
          },
        };
        return finaliseNumerical(
          result,
          symbolicParams,
          numericalParams,
          zValue,
          z,
          precision,
          opts,
        );
      }
      ruledOut.push({
        method: "braaksma-algebraic",
        status: as.status,
        reason: as.reason,
      });
    } else {
      ruledOut.push({
        method: "braaksma-algebraic",
        status: "pre-filter-refused",
        reason: asVerdict.reason,
      });
    }
  }

  // ====================================================== Lane 5 — refuse
  // Every applicable lane refused. Surface the integrated envelope.
  if (m + n === 0) {
    return {
      kind: "refused",
      class: "degenerate-shape",
      reason:
        `m = n = 0: no Γ-pole cluster for any numerical layer; ` +
        `symbolic dispatch has no rule for this trivial case`,
      ruledOutMethods: ruledOut,
    };
  }

  return {
    kind: "refused",
    class: "out-of-region",
    reason:
      `every applicable method refused; see ruled_out_methods for per-layer reasons`,
    ruledOutMethods: ruledOut,
  };
}

// -----------------------------------------------------------------------------
// Forced-method short-circuit
// -----------------------------------------------------------------------------

function runForced(
  forced: ForceMethod,
  symbolicParams: MeijerGSymbolicParams,
  numericalParams: MeijerGParameters,
  zValue: Value | undefined,
  z: BigComplex,
  precision: number,
  opts: MeijerGDispatchOptions,
): MeijerGDispatchResult {
  switch (forced) {
    case "symbolic": {
      if (zValue === undefined) {
        return {
          kind: "refused",
          class: "forced-method-refused",
          reason:
            "forced method 'symbolic' requires a Value-encoded z; pure-numerical callers cannot force this lane",
          ruledOutMethods: [],
        };
      }
      const sym = meijergSymbolic(symbolicParams, zValue);
      if (sym.kind === "matched") {
        return {
          kind: "symbolic",
          expr: sym.expr,
          ruleId: sym.ruleId,
          ruleSource: sym.ruleSource,
          note: sym.note ?? "",
          method: "symbolic-dispatch",
        };
      }
      return {
        kind: "refused",
        class: "forced-method-refused",
        reason: `forced method 'symbolic' refused: ${sym.reason}`,
        ruledOutMethods: [
          {
            method: "symbolic-dispatch",
            status: "no-known-reduction",
            reason: sym.reason,
          },
        ],
      };
    }
    case "slater": {
      const sl = meijergSlater(numericalParams, z, precision, opts.slaterOpts);
      return forcedNumericalResult(
        "slater",
        slaterToResult(sl, z),
        symbolicParams,
        numericalParams,
        zValue,
        z,
        precision,
        opts,
      );
    }
    case "contour": {
      // Honour the predicate even on forced invocation — the
      // one-sided-cluster cost-unbound case (canUseContour §4) would
      // otherwise hang. The user explicitly forced contour; the
      // structured refusal carries the predicate's reason.
      const ctVerdict = canUseContour(numericalParams, z);
      if (!ctVerdict.ok) {
        return forcedNumericalResult(
          "contour",
          {
            method: "mellin-barnes",
            status: "pre-filter-refused",
            reason: ctVerdict.reason,
          },
          symbolicParams,
          numericalParams,
          zValue,
          z,
          precision,
          opts,
        );
      }
      const ct = meijergContour(numericalParams, z, precision, opts.contourOpts);
      return forcedNumericalResult(
        "contour",
        contourToResult(ct, z),
        symbolicParams,
        numericalParams,
        zValue,
        z,
        precision,
        opts,
      );
    }
    case "asymptotic": {
      const as = meijergAsymptotic(
        numericalParams,
        z,
        precision,
        opts.asymptoticOpts,
      );
      return forcedNumericalResult(
        "asymptotic",
        asymptoticToResult(as, z),
        symbolicParams,
        numericalParams,
        zValue,
        z,
        precision,
        opts,
      );
    }
  }
}

function forcedNumericalResult(
  forced: ForceMethod,
  outcome: MeijerGNumericalSuccess | RuledOutMethod,
  symbolicParams: MeijerGSymbolicParams,
  numericalParams: MeijerGParameters,
  zValue: Value | undefined,
  z: BigComplex,
  precision: number,
  opts: MeijerGDispatchOptions,
): MeijerGDispatchResult {
  if ("kind" in outcome && outcome.kind === "numerical") {
    return finaliseNumerical(
      outcome,
      symbolicParams,
      numericalParams,
      zValue,
      z,
      precision,
      opts,
    );
  }
  return {
    kind: "refused",
    class: "forced-method-refused",
    reason: `forced method '${forced}' refused: ${(outcome as RuledOutMethod).reason}`,
    ruledOutMethods: [outcome as RuledOutMethod],
  };
}

function slaterToResult(
  r: MeijerGSlaterResult,
  z: BigComplex,
): MeijerGNumericalSuccess | RuledOutMethod {
  if (r.status === "success") {
    return {
      kind: "numerical",
      value: r.value,
      achievedPrecision: r.achievedPrecision,
      method: r.method,
      warnings: r.warnings,
      diagnostics: {
        seriesTerms: r.seriesTerms,
        perturbationApplied: r.perturbationApplied,
        cancellationDigitsLost: r.cancellationDigitsLost,
        workingPrecision: r.workingPrecision,
        onBranchCut: isZero(z.im) && toFloat64(z.re).value < 0,
      },
    };
  }
  return {
    method: "slater-series-1",
    status: r.status,
    reason: r.reason,
  };
}

function contourToResult(
  r: MeijerGContourResult,
  z: BigComplex,
): MeijerGNumericalSuccess | RuledOutMethod {
  if (r.status === "success") {
    return {
      kind: "numerical",
      value: r.value,
      achievedPrecision: r.achievedPrecision,
      method: r.method,
      warnings: r.warnings,
      diagnostics: {
        nEvals: r.nEvals,
        converged: r.converged,
        workingPrecision: r.workingPrecision,
        onBranchCut: isZero(z.im) && toFloat64(z.re).value < 0,
      },
    };
  }
  return {
    method: "mellin-barnes",
    status: r.status,
    reason: r.reason,
  };
}

function asymptoticToResult(
  r: MeijerGAsymptoticResult,
  z: BigComplex,
): MeijerGNumericalSuccess | RuledOutMethod {
  if (r.status === "success") {
    return {
      kind: "numerical",
      value: r.value,
      achievedPrecision: r.achievedPrecision,
      method: r.method,
      warnings: r.warnings,
      diagnostics: {
        nTerms: r.nTerms,
        sector: r.sector,
        workingPrecision: r.workingPrecision,
        onBranchCut: isZero(z.im) && toFloat64(z.re).value < 0,
      },
    };
  }
  return {
    method: "braaksma-algebraic",
    status: r.status,
    reason: r.reason,
  };
}

// -----------------------------------------------------------------------------
// Schwarz-reflection self-test (ADR-0027 §6)
// -----------------------------------------------------------------------------
//
// For non-cut z with all parameters real,
// `G(params; z̄) = conj(G(params; z))`. The check runs after a
// successful numerical evaluation when `opts.schwarzCheck = true`;
// on disagreement the dispatcher attaches a warning to the success
// record (not a hard failure — different layers have different
// per-method error margins, and the working-precision bookkeeping
// would surface a "match within precision − 5 digits" check as
// noise rather than signal).

function paramsAreReal(params: MeijerGParameters): boolean {
  const all = [...params.an, ...params.ap, ...params.bm, ...params.bq];
  for (const v of all) {
    if (!isZero(v.im)) return false;
  }
  return true;
}

function finaliseNumerical(
  result: MeijerGNumericalSuccess,
  symbolicParams: MeijerGSymbolicParams,
  numericalParams: MeijerGParameters,
  zValue: Value | undefined,
  z: BigComplex,
  precision: number,
  opts: MeijerGDispatchOptions,
): MeijerGNumericalSuccess {
  if (opts.schwarzCheck !== true) return result;
  // Schwarz only applies for real parameters; complex parameters
  // have a more general identity that v0.1 does not encode.
  if (!paramsAreReal(numericalParams)) return result;
  // On the cut, the principal-branch convention puts the value
  // above the cut; conj(G(z)) and G(z̄) genuinely differ. Skip.
  if (isZero(z.im)) return result;

  const workingBits = decimalToBinaryPrecision(precision, 30);
  const zbar: BigComplex = cconj(z);
  // Re-dispatch with schwarzCheck disabled to avoid recursion.
  // Force the same method for the mirror call so the comparison is
  // method-internal: a mismatch on `mellin-barnes` vs the layer's
  // own conjugation-symmetry would otherwise be masked by inter-
  // method drift.
  const forceMap: Record<string, ForceMethod> = {
    "slater-series-1": "slater",
    "slater-series-2": "slater",
    "mellin-barnes": "contour",
    "braaksma-algebraic": "asymptotic",
  };
  const force = forceMap[result.method];
  if (force === undefined) return result;
  const mirrorOpts: MeijerGDispatchOptions = {
    ...opts,
    schwarzCheck: false,
    forceMethod: force,
  };

  const mirror = meijergDispatch(
    symbolicParams,
    numericalParams,
    zValue,
    zbar,
    precision,
    mirrorOpts,
  );
  if (mirror.kind !== "numerical") {
    return {
      ...result,
      warnings: [
        ...result.warnings,
        `schwarz-check: mirror evaluation at z̄ refused (${mirror.kind === "refused" ? mirror.class : "unknown"}); skipping`,
      ],
    };
  }
  // Compare conj(G(z)) with G(z̄). Use a generous tolerance —
  // precision − 5 digits is the verifier's spec.
  const conjVal = cconj(result.value);
  const diff = csub(conjVal, mirror.value, workingBits);
  const diffMag = cabs(diff, workingBits);
  // Tolerance in BigFloat: 10^{-(precision − 5)}.
  const tolDigits = Math.max(1, precision - 5);
  // Build 10^{-tolDigits} as an integer division: 1 / 10^tolDigits.
  const ten = fromInt(10n, workingBits);
  let tenPow = fromInt(1n, workingBits);
  for (let i = 0; i < tolDigits; i++) {
    tenPow = mul(tenPow, ten, workingBits);
  }
  const tol = div(fromInt(1n, workingBits), tenPow, workingBits);
  if (cmp(diffMag, tol) > 0) {
    return {
      ...result,
      warnings: [
        ...result.warnings,
        `schwarz-check: |conj(G(z)) − G(z̄)| > 10^{-${tolDigits}}; ` +
          `principal-branch convention may be inconsistent across layers`,
      ],
    };
  }
  return result;
}

// `BigFloat` is imported as a type only — kept for forward
// compatibility (a future v0.2 may surface BigFloat scalars in the
// public types, e.g. an `errorEstimate` field on the integrated
// success record once we unify the per-layer error reporting).
type _UnusedBigFloat = BigFloat;
