# `@workbench/meijer-core`

Algorithmic substrate for the Meijer G-function `G^{m,n}_{p,q}`.
Layers 3, 4, 5, 6, **and 7** of the seven-layer stack laid out in
`tstournament/ts-bench-infra/problems/13-meijer-g/PLAN.md`:
- Layer 3 (Slater residue summation, arbprec numerical),
- Layer 4 (Adamchik–Marichev + Roach symbolic dispatch),
- Layer 5 (Mellin–Barnes contour quadrature, arbprec numerical),
- Layer 6 (Braaksma far-field asymptotic, arbprec numerical, v0.1),
- Layer 7 (top-level dispatcher composing 3 + 4 + 5 + 6, ADR-0027).

## What this package exposes

Three evaluation paths, each with structured-refusal envelope:

```ts
import { meijergSlater, meijergContour } from "@workbench/meijer-core";
import { cfromInts } from "@workbench/bigfloat";

// G^{1,0}_{0,1}(_; 1 | 2)  =  2 · e^{-2}
const params = {
  an: [],
  ap: [],
  bm: [cfromInts(1n, 0n, 256)],
  bq: [],
};
const z = cfromInts(2n, 0n, 256);

// Slater path — fast for parameters in the (p, q, m, n, |z|) regime
// where one of the two residue series converges.
const r1 = meijergSlater(params, z, 50);

// Contour path — direct numerical evaluation via Mellin-Barnes vertical
// contour quadrature. The fallback for the |z| ≈ 1 quarantine band
// where neither Slater series converges; also a cross-check for the
// regime where both paths apply.
const r2 = meijergContour(params, z, 15);

if (r1.status === "success") {
  console.log(r1.value, r1.method);     // "slater-series-1"
}
if (r2.status === "success") {
  console.log(r2.value, r2.method);     // "mellin-barnes"
  console.log(r2.contourRe, r2.truncate); // diagnostic: c, T
}
```

Public API:

| Export                | Purpose                                                                  |
|-----------------------|--------------------------------------------------------------------------|
| `meijergSlater`       | Slater entry point. Series selection + perturbation + cancellation control.|
| `meijergContour`      | Mellin-Barnes contour entry point. Auto-selects c and T; structured refusal on non-convergent contours / overlapping pole clusters.|
| `meijergSymbolic`     | Symbolic-dispatch entry point. Pattern-table driven; emits closed-form AST in the special-function vocabulary or `no-known-reduction`. ADR-0025.|
| `meijergAsymptotic`   | **Braaksma far-field asymptotic** (v0.1, ADR-0026). Principal-sector algebraic dominant asymptotic for `\|z\| → ∞`; truncates the n-pole Slater Series 2 at its optimal index per Olver §3.7. Structured refusal on Stokes lines, secondary sectors, and `\|z\| < 1`.|
| `meijergDispatch`     | **Top-level dispatcher** (Layer 7, ADR-0027). Composes `meijergSymbolic` + `meijergSlater` + `meijergContour` + `meijergAsymptotic` with cost-ascending dispatch (symbolic → Slater → contour → asymptotic → refuse). Returns one of three honest output shapes (symbolic AST / numerical record / structured refusal). Branch convention pinned at `arg z ∈ (−π, π]`. Optional Schwarz-reflection self-test. |
| `canUseSymbolic` / `canUseSlater` / `canUseContour` / `canUseAsymptotic` | Per-lane pre-filter predicates. Each returns `{ ok, reason }`; the dispatcher reads them before invoking the layer so refusals carry honest reasons. |
| `classifySector`      | Three-way sector classification (`principal` / `stokes` / `secondary`) used by the asymptotic kernel.|
| `asymptoticTerms`     | Generator yielding successive terms of the per-pole asymptotic series. Low-level diagnostic primitive.|
| `findOptimalTruncation` | Reads the term magnitudes off `asymptoticTerms` and returns the optimal-truncation index, partial sum, and error estimate.|
| `ALL_RULES`           | The aggregated reduction-rule table from all `dispatch-rules/*.ts` files. Read-only; introspect at the package boundary for diagnostic / catalogue purposes. |
| `evaluateSeries1`/`2` | Per-residue-line kernels. Useful for diagnostic / per-line introspection.|
| `selectSeries`        | The (p, q, m, n, |z|) selection rule alone.                              |
| `detectCoalescence`   | Integer-spaced-pair detection across the parameter sub-tuples.           |
| `perturbParameters`   | The deterministic odd-coefficient perturbation.                          |
| `headToMeijerG`       | **Forward bridge** (ADR-0040 §"Decision 5"; closure renamed per ADR-0041 §"Decision 5"). Given a head + args, returns the canonical `MeijerGForm` + prefactor `wrap` + `argsInverse` closure for byte-identical round-trip; or `null` for honestly-refused heads (`InverseErf`, `InverseErfc`). v0.1: Erf family + Bessel family. The Gamma family ships its own pair (`headToMeijerGGamma` / `meijerGToHeadGamma`, ADR-0042 §"Decision 5"), uniquely asymmetric — only `IncompleteGammaUpper` / `IncompleteGammaLower` have G-forms; the other 7 Gamma heads return `null` as honest structural refusals (Γ is the *building block* of the Mellin-Barnes kernel, not a value G produces). |
| `meijerGToHead`       | **Standalone backward bridge** (ADR-0040 §"Decision 5"). Pattern-matches a `MeijerGForm` against the canonical Erf-family shapes; emits `{head, args}` or `null`. The Erf/Erfi disambiguation rides on the z-slot sign. |
| Type exports          | `MeijerGParameters`, `MeijerGSlaterOptions`, `MeijerGContourOptions`, `MeijerGAsymptoticOptions`, `MeijerGSymbolicParams`, `DispatchResult`, `ReductionRule`, `PatternSpec`, `MeijerGForm`, `ForwardBridge`, all result discriminants. |

## Dispatch layer (Layer 4)

`meijergSymbolic(params, z) → DispatchResult` walks a curated table
of reduction rules organised one-file-per-source under
`src/dispatch-rules/`. v0.1 ships ≥30 rules from Bateman §5.6 pp.
215–222 plus DLMF §16.17–§16.18, plus the Erf-family forward bridges
(`erf-forward-form-a.ts` / `erfi-forward.ts` / `erfc-forward.ts`,
ADR-0040), plus the BesselY / BesselI canonical-form backward rules
(`bessel-backward.ts`, R4 §E.3 / beads `1xqq` + `lfet`) that close
the dispatcher's Bessel-family symbolic-recognition gap left open by
v0.1's Bateman-only Bessel coverage. The bulk of the rule corpus
(~1300 rules from PBM Vol 3 §8.4 + Mathai 1993 + Wolfram Functions
Site) lands in follow-up beads under `hv0.6.*`.

```ts
import { meijergSymbolic } from "@workbench/meijer-core";
import { int, sym } from "@workbench/protocol";

// G^{1,0}_{0,1}(_; 0 | z) = e^{-z}  (Bateman §5.6 (8))
const r = meijergSymbolic(
  { an: [], ap: [], bm: [int(0n)], bq: [] },
  sym("z"),
);
if (r.kind === "matched") {
  console.log(r.expr, r.ruleId, r.ruleSource);
  // → AST for `exp(-z)`, "bateman-5-6-8", "Bateman §5.6 (8)"
}
```

Inputs are canonicalised by sorting each sub-tuple (`an`, `ap`, `bm`,
`bq`) by canonical-bytes order before matching, so permutations
within a sub-tuple match the same rule (the Mellin–Barnes integrand's
Γ-products are symmetric within each sub-tuple). See ADR-0025 for
the design and `docs/worklog/076-meijerg-symbolic-dispatch.md` for
the shipping shard.

The `no-known-reduction` envelope (per ADR-0003 boundary-failure
contract) lets callers route to the numerical paths
(`meijergSlater` / `meijergContour`) without ambiguity.

## Bridge layer (head ↔ Meijer-G, per-head, ADR-0040 §"Decision 5")

Per-head bidirectional bridges live under `src/bridges/<head>.ts`,
sibling to `src/dispatch-rules/`. Each bridge ships a forward direction
(`headToMeijerG(head, args)`) emitting the canonical G-form per the
literature-pinned table, and a standalone backward direction
(`meijerGToHead(form)`) pattern-matching G-forms back to heads. The
forward bridge returns a `ForwardBridge` record carrying the G-form, a
prefactor `wrap` closure, and the load-bearing `argsInverse` closure that
recovers the head's original arguments byte-identically — sidestepping
the multi-valued `√(z²)` problem inherent in the naive backward path
(see R4 §3.b in `docs/refs/erf-research/R4-meijer-g-bridge.md`). The
closure was named `zInverse` in v0.1 (Erf-only era); ADR-0041 §"Decision
5" renames it to `argsInverse` arity-agnostically so the same interface
field carries Bessel's `[ν, z]` recovery (and any future N-arg head)
without further API change.

The Erf family (`Erf`, `Erfc`, `Erfi`) ships as v0.1 (bead `tc2c`,
worklog 137). The inverse-erf heads (`InverseErf`, `InverseErfc`) are
**honestly refused on both directions** — no Meijer-G representation
exists in the literature per DLMF §7.17.

`src/bridges/gamma.ts` (ADR-0042 §"Decision 5", bead `5hnr`, worklog
175) is the third bridge and the most structurally asymmetric. For Erf
and Bessel the head is a *value* a Meijer-G evaluation produces; for the
Gamma family, Γ is the *building block* of the Mellin-Barnes kernel
itself, so `Gamma(z)` as a function of its argument **has no G-form** —
encoding it would require z in a parameter slot rather than the z-slot.
Only `IncompleteGammaUpper` (`G^{2,0}_{1,2}`, `bm = [a, 0]`) and
`IncompleteGammaLower` (`G^{1,1}_{1,2}`, `bm = [a]`, `bq = [0]`) carry
G-forms; `headToMeijerGGamma` returns a non-null `ForwardBridge` for
those two and `null` for the other seven (`Gamma`, `LogGamma`,
`Digamma`, `Polygamma`, `Pochhammer`, `Beta`, `BarnesG`) with per-head
structural-refusal prose. The backward direction
(`meijerGToHeadGamma`) discriminates the `(2,0,1,2)` shape it shares
with Erfc and ExpIntegralE: `bm = [0, ½]` → Erfc, `bm = [0, 0]` →
ExpIntegralE(1, z), else → UpperIncompleteGamma. The two Bateman
§5.6 (38)/(40) incomplete-gamma dispatch rules
(`bateman-5-6.ts`, bead `0pvl`) round-trip byte-identically through
this bridge.

```ts
import { headToMeijerG, meijerGToHead } from "@workbench/meijer-core";
import { sym } from "@workbench/protocol";

const z = sym("z");
const fwd = headToMeijerG("Erf", [z]);
// fwd = {
//   gForm: { an: [1/2], ap: [], bm: [0], bq: [-1/2], z: z² },
//   wrap: g => (z / √π) · g,
//   argsInverse: () => [z],
// }

// Round-trip via the forward closure (byte-identical):
const args = fwd!.argsInverse();    // [z], byte-identical to the input

// Standalone backward path on an arbitrary G-form:
const bwd = meijerGToHead({
  an: [{ kind: "rational", num: "1", den: "2" }],
  ap: [],
  bm: [{ kind: "integer", value: "0" }],
  bq: [{ kind: "rational", num: "-1", den: "2" }],
  z: sym("u"),
});
// bwd = { head: "Erf", args: [√u] }
```

Erf and Erfi share an identical Meijer-G parameter tuple — the z-sub
sign (`z²` vs `−z²`) is the only discriminator. The dispatcher honours
this via the additive `PatternSpec.zMatch?` predicate (a minimal
extension that defaults absent → "match every z", so every legacy rule
fires exactly as before).

The bridge's three new dispatch rules (`erf-bridge-form-a`,
`erfc-bridge`, `erfi-bridge`) sit alongside the existing
`dlmf-16-18-erf` (Form B Erf reduction). Form A and Form B are *distinct*
Meijer G-functions; both backward paths coexist. ADR-0040 §"Decision 5"
and R4 §1.a pin the choice of Form A (SymPy / diofant / PBM canonical)
as the forward bridge's canonical output.

## Asymptotic layer (Layer 6, v0.1)

`meijergAsymptotic(params, z, precision, opts) → MeijerGAsymptoticResult`
ships the **principal-sector algebraic dominant asymptotic** for
`|z| → ∞`. The recurrence is the same one Slater Series 2 uses for
its inner pFq sum; the difference is **how we sum it**:

* Convergent Slater Series 2 (in `meijergSlater` when `q ≥ p`)
  sums until the relative term magnitude drops below the target.
* The asymptotic path (here) **truncates at the optimal index `k*`**
  — the index at which `|t_{k*+1}|` first equals or exceeds
  `|t_{k*}|` — and reports `|t_{k*+1}|` as the error estimate
  (Olver 1974 §3.7, "superasymptotic").

```ts
import { meijergAsymptotic } from "@workbench/meijer-core";
import { cfromInts, cfromStrings } from "@workbench/bigfloat";

// G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 100)
const r = meijergAsymptotic(
  {
    an: [cfromStrings("0.5", "0", 256)],
    ap: [],
    bm: [cfromInts(0n, 0n, 256)],
    bq: [cfromInts(1n, 0n, 256)],
  },
  cfromInts(100n, 0n, 256),
  50,
);
if (r.status === "success") {
  console.log(r.value, r.method);                 // "braaksma-algebraic"
  console.log(r.optimalTermIndices);              // per-pole k*
  console.log(r.errorEstimate, r.workingPrecision);
}
```

v0.1 deliberately refuses out-of-scope inputs with structured
classes:

* `stokes-line` — `|arg z|` near `π/2 - π/64`; v0.1's
  algebraic-only answer is unreliable across the Stokes line.
* `secondary-sector` — `|arg z| > π/2 - π/64`; full Braaksma
  connection coefficients are deferred to `hv0.9.5`.
* `small-z` — `|z| < 1`; the `|z| → ∞` asymptotic doesn't apply.
* `non-asymptotic-regime` — `|t_1| ≥ |t_0|` at the first step;
  not asymptotic enough at this `|z|`.
* `no-pole-residues` — `n = 0` (empty `an`); the right-closing
  asymptotic requires at least one upper pole. The dual `|z| → 0`
  asymptotic is `hv0.9.4`.
* `input-error` — invalid precision or Γ-prefactor pole.

ADR-0026 pins the design; `docs/worklog/078-meijerg-asymptotic.md`
ships the layer.

## Dispatcher (Layer 7, ADR-0027)

`meijergDispatch(symbolicParams, numericalParams, zValue, z, precision, opts)`
composes the four lower layers into a single integrated evaluator
with cost-ascending dispatch:

```ts
import { meijergDispatch } from "@workbench/meijer-core";
import { cfromInts } from "@workbench/bigfloat";
import { int, sym } from "@workbench/protocol";

// G^{1,0}_{0,1}(_; 0 | 2) = e^{-2}.  Symbolic match wins.
const symbolicParams = { an: [], ap: [], bm: [int(0n)], bq: [] };
const numericalParams = {
  an: [], ap: [], bm: [cfromInts(0n, 0n, 256)], bq: [],
};
const z = cfromInts(2n, 0n, 256);
const r = meijergDispatch(
  symbolicParams, numericalParams,
  sym("z"),              // symbolic z-view (AST)
  z,                     // numerical z (BigComplex)
  50,                    // precision (decimal digits)
);
if (r.kind === "symbolic") {
  console.log(r.expr, r.method);  // "symbolic-dispatch"
}
```

Dispatch order (cost-ascending, ADR-0027 §1):

1. **symbolic** — Adamchik–Marichev rule walk; < 1 ms when matches.
2. **Slater** — residue summation; refuses in the `|z|≈1` quarantine band.
3. **contour** — Mellin–Barnes vertical contour; refuses on
   `2(m+n) ≤ p+q`, on overlapping pole clusters, and (predicate
   strengthening) on one-sided clusters at `|z| ≥ 1`
   (cost-unbound regime).
4. **asymptotic** — Braaksma far-field; refuses outside the
   principal sector and for `|z| < 1`.
5. **refuse** — emits the integrated `out-of-region` envelope.

Each lane's pre-filter (`canUseSymbolic`, `canUseSlater`,
`canUseContour`, `canUseAsymptotic`) decides "applicable here?"
before any numerical work runs. The dispatch loop is a flat
switch over four lanes; no bespoke per-layer envelope handling.

The output is a discriminated union (`MeijerGDispatchResult`):
`MeijerGSymbolicSuccess | MeijerGNumericalSuccess | MeijerGRefusal`.
The wire wrapper `tools/meijer-g` exposes this surface to the
value protocol; ADR-0027 §4 pins the wire shapes.

`opts.forceMethod` short-circuits the cascade to a single lane
(useful for the method-agreement self-test). `opts.schwarzCheck`
enables the Schwarz-reflection invariant check on numerical
success.

ADR-0027 pins the design; `docs/worklog/080-meijerg-dispatcher.md`
ships the layer.

## What this package does *not* do

- **Stokes-line connection coefficients** (`hv0.9.2`) and the
  full E_{p,q} exponential series (`hv0.9.1`) for the
  algebraic+exponential combination across sector boundaries.
- **Olde Daalhuis–Olver hyperasymptotic refinement** (`hv0.9.3`).
- **Secondary-sector handling** for `|arg z| > π/2 − π/64`
  (`hv0.9.5`).
- **Symmetric `|z| → 0` asymptotic** for `n = 0` shapes (`hv0.9.4`).
- ~~**Top-level orchestration** (Layer 7 — `hv0.10`).~~ **Shipped:**
  see Dispatcher section above. ADR-0027 + worklog 080.
- **Steepest-descent contour deformation.** The contour layer uses a
  vertical line (parallel to the imaginary axis), the simplest contour
  that admits the v0.1 algorithm. Saddle-point deformation
  (Paris-Kaminski 2001 ch.2) is deferred to a future bead when the
  asymptotic layer lands and the dispatcher can route between paths
  intelligently.
- **Adaptive contour offset for asymmetric `arg(z)`.** The contour is
  symmetric around `t = 0`; for `arg(z) ≠ 0` the integrand peak shifts
  and symmetric truncation is conservative (correct, not optimal).
  Future v0.2.

## Design points

* **Pure TypeScript on `BigInt` mantissas.** Inherits the substrate's
  `arbprec: true` determinism contract — bit-identical output across
  runtimes, given the precision dial. ADR-0020.

* **Per-value precision.** Every operation takes `precision` (decimal
  digits) explicitly; no ambient state. The orchestrator computes its
  working precision in bits internally.

* **Deterministic perturbation.** The standard "Johansson hmag"
  approach in textbooks/mpmath is randomly signed, which would break
  the bit-determinism contract. The deterministic odd-coefficient
  pattern (`δ_i = (2i+1) · 2^{-pertBits}`) breaks all integer-spaced
  pairs by construction and produces the same L'Hôpital limit value.

* **Cancellation-driven retry.** The `m` (or `n`) residue terms can be
  exponentially large with a sum exponentially small; the orchestrator
  tracks `max_h |term_h|` against `|sum|` and bumps working precision
  when the gap exceeds the safety margin.

* **Structured refusal.** Every input that cannot be evaluated within
  the Slater path's competence falls through to one of three tagged
  refusals (`quarantine-band`, `non-convergent-pfq`, `input-error`).
  The contract is "produce a numerically correct value, or tell the
  caller honestly *why* not".

## Tests

`packages/meijer-core/test/`:
* `series-select.test.ts` — 10 tests on the dispatcher across the
  decision boundaries.
* `slater.test.ts` — 19 tests cross-checking the Slater path against
  closed-form MeijerG identities (DLMF 16.18, Bateman 5.6) computed
  directly through the bigfloat substrate.
* `contour.test.ts` — 10 tests for the Mellin-Barnes contour layer:
  closed-form identities (`G^{1,0}_{0,1}` reductions to `e^{-z}`),
  contour-vs-Slater cross-check (the load-bearing mutation-prove,
  since Slater is independently tested against closed forms),
  structured refusals (non-convergent contour, no-valid-contour,
  invalid precision), bit-determinism, result shape.
* `asymptotic.test.ts` — 40 tests for the Braaksma asymptotic
  layer: 8 closed-form anchors (e^{-1/z}, √(π/(1+z)) family,
  complex z, divergent inner pFq), 5 mpmath-pinned cross-validation
  cases at 80 dps, 5 Wolfram-pinned cases at 60 dps, 4 Slater
  agreement tests on overlap regions, 3 optimal-truncation
  invariant tests, 6 refusal-class tests, bit-determinism, sector
  classifier tests, and direct property tests on `asymptoticTerms`
  / `findOptimalTruncation`.
* `asymptotic-mutations.test.ts` — 5 mutation-prove tests
  (CLAUDE.md Rule 6): sign flip, prefactor magnitude, truncation-
  too-early, sector-classifier mis-admit, and 1/z omission. Each
  perturbs the result programmatically, confirms the mutation
  produces RED on the corresponding invariant test, and proves the
  test catches that class of regression.

Achievable accuracy is governed by the algorithm's own ulp budget.
For Slater: empirically the clean integer-input cases deliver ~75+
dps at 50 dps target; harder cases (rational parameters, `|z|` near a
convergence boundary) deliver ~45-50 dps. For contour: ~prec − 5 dps
at modest precision targets (TARGET_DPS ≤ 20), with a soft ceiling
near ~22 dps imposed by the bigfloat substrate's `cgamma` Stirling
cancellation budget — a future bead can lift the ceiling. The
bigfloat substrate is not the bottleneck (see worklog 071 for the
diagnosis of an earlier "substrate regression" that turned out to be
a false alarm).

## References

* Slater, *Generalized Hypergeometric Functions* (1966), §5 (residue
  closure of the Mellin-Barnes contour).
* DLMF §16.17 (case structure), §16.18 (closed-form identities).
* Bateman, *Higher Transcendental Functions* Vol. 1, §5.6.
* F. Johansson 2009 blog post, "Numerical evaluation of MeijerG"
  (algorithm-level description; permitted source under the
  no-direct-porting clause).
