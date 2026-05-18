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
// Layer 6 — Stokes-line connection coefficients: RETRACTED (worklog 125)
// -----------------------------------------------------------------------------
//
// ADR-0039 §D3 (bead `egf`) originally shipped a connection-formula
// assembly (`G(z) ~ H(z) + Σ_k S_k · E_{p,q}(z e^{2πik/κ})`) with two
// supporting modules: `exponential.ts` for the `E_{p,q}` series and
// `stokes.ts` for the `S_k` multiplier table. The math-research
// subagent verified empirically (2026-05-15) that the workbench's
// `H^{m,n}_{p,q}(z)` (right-closing Slater residues) equals `G(z)`
// directly on the principal Riemann sheet for `δ = m + n − (p+q)/2
// ≥ 1`, without any compound-asymptotic correction. The two modules
// and their exports have been retracted; the asymptotic layer is now
// the algebraic series alone, tagged `"braaksma-algebraic"` in the
// principal sector and `"braaksma-stokes"` past the κ-aware boundary
// (the wire-schema tag is retained for diagnostic continuity).
//
// The `δ = 0` regime is genuinely broken (the kernel emits a wrong
// answer for κ≥3 δ=0 shapes such as G^{1,1}_{1,3}) and is filed as
// bead `scientist-workbench-atip`. See `docs/worklog/125-*.md` for the
// empirical verification.

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
// Bidirectional head ↔ Meijer-G bridge (ADR-0040 §"Decision 5")
// -----------------------------------------------------------------------------
//
// Per-head modules under `src/bridges/<head>.ts`. Each bridge exports
// `headToMeijerG(head, args)` (forward) and `meijerGToHead(form,
// prefactor?)` (standalone backward). The forward bridge returns a
// `ForwardBridge` (G-form + prefactor `wrap` + `argsInverse` closure for
// byte-identical round-trip; ADR-0040 §"Decision 5" pinned the 1-arg
// closure under the name `zInverse`, ADR-0041 §"Decision 5" renamed it
// to `argsInverse` arity-agnostically for 2-arg+ heads like Bessel); the
// standalone backward bridge pattern-matches a G-form against the
// canonical shapes and emits `{head, args}` or `null` (honest refusal
// per ADR-0003 boundary failure).
//
// Inverse error functions (`InverseErf`, `InverseErfc`) are honestly
// refused on both directions — no Meijer-G representation exists per
// DLMF §7.17. The bridge returns `null` rather than emitting a
// wrong-shaped form.

export {
  type ForwardBridge,
  type MeijerGForm,
} from "./bridges/types.js";

export {
  headToMeijerG,
  meijerGToHead,
} from "./bridges/erf.js";

// Bessel-family bridge (ADR-0041 §"Decision 5" + Bessel R4 §A.4):
// per-head sister module to `bridges/erf.ts`, the first 2-arg bridge
// (`(ν, z)`). Re-exported under disambiguated names so callers can
// route head → bridge explicitly; the top-level `headToMeijerG`
// dispatcher (when it lands) will iterate over both modules' bridges
// and return the first non-null hit.
export {
  headToMeijerG as headToMeijerGBessel,
  meijerGToHead as meijerGToHeadBessel,
} from "./bridges/bessel.js";

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
