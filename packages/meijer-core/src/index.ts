// =============================================================================
// @workbench/meijer-core — algorithmic substrate for the Meijer G-function
// =============================================================================
//
// The Meijer G-function `G^{m,n}_{p,q}` is the most general entry in the
// special-function hierarchy that admits a closed Mellin-Barnes integral
// representation; almost every named special function (Bessel, Legendre,
// hypergeometric, Whittaker, the elementary transcendentals, …) is one
// or another `G^{m,n}_{p,q}` instance. Numerical evaluation of MeijerG
// is the unifying capability that the tstournament problem-13 mega-test
// (epic `scientist-workbench-hv0`) is built around.
//
// The full numerical evaluator is a layered cake:
//
//   Layer 3  — Slater residue summation         (this package, v0.1)
//   Layer 5  — Mellin-Barnes contour quadrature (forthcoming, hv0.8)
//   Layer 6  — Braaksma asymptotic              (forthcoming, hv0.9)
//   Layer 7  — top-level dispatcher             (forthcoming, hv0.10)
//
// This v0.1 ships **layer 3 only** — the Slater residue path that
// covers the bulk of the `(p, q, m, n, |z|)` parameter space when
// `p ≤ q + 1` and `|z|` is away from the unit circle in the awkward
// `p == q` regime. Layers 5/6/7 will land in subsequent commits and
// extend coverage to the boundary, the asymptotic far-field, and the
// honest-refusal envelope.
//
// What this package exposes
// -------------------------
//
//   * `meijergSlater(params, z, precision, opts?)`
//        The orchestrator. Returns either a successful `MeijerGSlaterSuccess`
//        record (with the value + diagnostics) or a structured
//        `MeijerGSlaterRefusal`. The Slater path itself never throws on
//        a coalescence — it perturbs and retries.
//
//   * `evaluateSeries1` / `evaluateSeries2`
//        The two residue-summation kernels, exposed for tests and for
//        callers that want to inspect the per-residue-line contributions
//        directly (e.g., the "self-test that the two series agree where
//        both converge" tier of the verifier).
//
//   * `selectSeries`
//        The `(p, q, m, n, |z|)` selection rule, available for callers
//        that need to know in advance which series will be tried.
//
//   * `detectCoalescence` / `perturbParameters`
//        The coalescence-handling primitives. Useful for diagnostic
//        callers (e.g., a benchmark harness that wants to flag
//        "perturbed" cases for separate scoring).
//
// All numerical computation runs on `BigComplex` from
// `@workbench/bigfloat`; the package itself takes no opinion on the
// wire encoding. The `tools/meijer-g-slater-only` thin wrapper (in
// `tools/`) handles the value-protocol round-trip.

export {
  type MeijerGParameters,
  type MeijerGSlaterOptions,
  type MeijerGSlaterResult,
  type MeijerGSlaterSuccess,
  type MeijerGSlaterRefusal,
  type SeriesChoice,
} from "./types.js";

export { meijergSlater } from "./slater.js";

export {
  type SeriesSelection,
  selectSeries,
} from "./series-select.js";

export {
  type ResidueTerm,
  evaluateSeries1,
  evaluateSeries2,
  applySign,
} from "./series.js";

export {
  detectCoalescence,
  differsByInteger,
  hasIntegerSpacedPair,
  perturbParameters,
} from "./coalescence.js";

export {
  type MeijerGContourOptions,
  type MeijerGContourResult,
  type MeijerGContourSuccess,
  type MeijerGContourRefusal,
  meijergContour,
} from "./contour.js";

// -----------------------------------------------------------------------------
// Layer 6 — Braaksma asymptotic (v0.1: principal-sector algebraic only)
// -----------------------------------------------------------------------------
//
// Far-field asymptotic at |z| → ∞ in the principal sector
// `|arg z| < π/2 - π/64`. Truncates the n-pole Slater Series 2 at
// its optimal index (Olver §3.7 superasymptotic). Refuses on Stokes
// lines, in secondary sectors, for `|z| < 1`, and in
// non-asymptotic-regime inputs. ADR-0026 pins the design.

export {
  type MeijerGAsymptoticOptions,
  type MeijerGAsymptoticResult,
  type MeijerGAsymptoticSuccess,
  type MeijerGAsymptoticRefusal,
  type SectorVerdict,
  asymptoticTerms,
  classifySector,
  findOptimalTruncation,
  meijergAsymptotic,
} from "./asymptotic.js";

// -----------------------------------------------------------------------------
// Layer 6 — Stokes-line connection coefficients (ADR-0039, bead egf)
// -----------------------------------------------------------------------------
//
// Pure-math modules for the v0.1 connection-formula scope. Part 2 of
// bead `egf` (hv0.9.2) wires these into `meijergAsymptotic` and the
// dispatcher; they ship here as standalone so the math is independently
// testable. See `docs/refs/dlmf-16-11.md` §§3, 4 for the specification.

export {
  type EpqResult,
  type EpqSuccess,
  type EpqRefusal,
  evaluateEpq,
} from "./exponential.js";

export {
  type StokesMultiplier,
  stokesMultiplier,
  principalSectorBound,
} from "./stokes.js";

// -----------------------------------------------------------------------------
// Layer 4 — symbolic dispatch (Adamchik–Marichev + Roach)
// -----------------------------------------------------------------------------
//
// Pattern-table dispatcher of curated reduction rules. Returns AST
// in the special-function vocabulary (ADR-0023) when a rule fires;
// returns `no-known-reduction` otherwise. ADR-0025 pins the design.

export {
  type Bindings,
  type DispatchResult,
  type MeijerGSymbolicParams,
  type PatternSpec,
  type ReductionRule,
  type RelationSpec,
  type SlotSpec,
} from "./dispatch-types.js";

export { ALL_RULES, meijergSymbolic } from "./dispatch.js";

// -----------------------------------------------------------------------------
// Layer 7 — top-level dispatcher (ADR-0027)
// -----------------------------------------------------------------------------
//
// Composes Layers 3 (Slater), 4 (symbolic), 5 (contour), 6
// (asymptotic) into a single integrated evaluator with cost-ascending
// dispatch and honest refusal. The pre-filters are exported
// individually for callers that want to introspect "which lanes
// would apply?" without invoking the dispatcher (e.g. the wire
// tool's request-mode handling, the method-agreement self-test).

export {
  type DispatchMethod,
  type ForceMethod,
  type MeijerGDispatchOptions,
  type MeijerGDispatchResult,
  type MeijerGNumericalSuccess,
  type MeijerGRefusal,
  type MeijerGSymbolicSuccess,
  type RequestMode,
  type RuledOutMethod,
  canUseAsymptotic,
  canUseContour,
  canUseSlater,
  canUseSymbolic,
  meijergDispatch,
} from "./dispatcher.js";
