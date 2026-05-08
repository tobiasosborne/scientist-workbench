# Worklog 073 — `packages/meijer-core` Mellin-Barnes contour layer + BigComplex G7K15 driver shipped (`hv0.8`)

**Date:** 2026-05-08.
**Beads:** `scientist-workbench-hv0.8` (✓ closed). New ADR-0022.
**Related ADRs:** ADR-0021 (arb-prec real-codomain G7K15 driver — the
direct predecessor whose centred-delta K-G identity ports verbatim);
ADR-0020 (arb-prec tier — the unconditional bit-determinism contract);
ADR-0014 (numerical-tier float64 G7K15 — the lineage's start);
ADR-0010 (defineTool/runTool split — why the algorithm lives in the
package and the wire layer is deferred); ADR-0009 (TS-native idiom —
"two named drivers" beats "one generic over a field record").
**Lockstep with:** [`docs/worklog/072-quadrature-arbprec.md`](072-quadrature-arbprec.md)
(the substrate this consumer needs) and the campaign log at
`../tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`.

## Context

Layer 5 of the seven-layer Meijer G stack: the Mellin-Barnes contour
quadrature. The contour integral that closes the loop where neither
Slater series converges (the `|z| ≈ 1 ∧ p == q ∧ m + n == p`
quarantine band) and serves as a cross-check elsewhere. ADR-0021 §"What
we will not decide" deferred the BigComplex codomain question to this
layer's design; that decision is the load-bearing one for hv0.8.

Worklog 072 shipped the BigFloat-codomain arb-prec G7K15 driver
(`gaussKronrodAdaptiveBF`). The Mellin-Barnes integrand
`Π Γ(b_j − s) · Π Γ(1 − a_j + s) · z^s / [Π Γ(1 − b_j + s) · Π Γ(a_j − s)]`
is intrinsically complex-valued: the contour `Re(s) = c, t ∈ ℝ` is a
real interval but the integrand evaluates to BigComplex at every `t`.
The driver this consumer wants is "G7K15 over a real interval, integrand
returns BigComplex, error estimate is `|K − G|`."

## What changed

### `packages/quadrature/src/gauss-kronrod-bc.ts` — the BigComplex driver

A new ~520 LOC file (driver + literate prose). Public surface:

```ts
gaussKronrodAdaptiveBC(
  f: (t: BigFloat, prec: number) => BigComplex,
  a: BigFloat,
  b: BigFloat,
  prec: number,
  opts?: BigComplexQuadOptions,
): BigComplexQuadResult
```

The result shape mirrors `BigFloatQuadResult` field-for-field with
`value: BigComplex` (instead of `BigFloat`) and `errorEstimate:
BigFloat` (the natural scalar `cabs(K − G) · |halfLength|`). Method
tag is `"gauss-kronrod-g7k15-bigcomplex"`.

Algorithm shape: identical to the BF driver. Centred-delta K-G
identity `K - G = Σ (WGK_i - WG_i) · (fSum_i - 2·f(centre))` ports
verbatim component-wise — `δ_i.re` and `δ_i.im` are each small (~
`f'(centre).re/im · halfLength · 2·xgk_i`), the centre's contribution
algebraically vanishes (proof in the BF driver's header), and neither
component sum suffers large-vs-large cancellation. Heap key is the
real `cabs(K − G) · halfLength`. Cauchy value-stability test fires
when `cabs(value − prevValue) ≤ cabs(value) × 2^-(workingBits − 30)`
for 8 consecutive iterations — component-wise interpretation: both
real and imaginary parts have stabilised at the substrate ulp floor.

**Faithful-extension contract.** On real-only integrands (`im ≡ 0`)
the BC driver's `value.re` and `errorEstimate` bytes match the BF
driver's outputs *byte-for-byte*. The 9 byte-equality tests (3
integrand classes × 3 precisions) at the top of `quadrature-bc.test.ts`
are the load-bearing mutation-prove: the BC driver is "the BF driver,
lifted" — not an independent reimplementation that happens to give
similar answers. Any drift in the BC inner loop that violates the lift
shows up immediately as a byte mismatch.

### `packages/meijer-core/src/contour.ts` — the Mellin-Barnes orchestrator

A new ~370 LOC file (orchestrator + literate prose). Public surface:

```ts
meijergContour(
  params: MeijerGParameters,
  z: BigComplex,
  precision: number,
  opts?: MeijerGContourOptions,
): MeijerGContourResult
```

Returns a discriminated `MeijerGContourSuccess | MeijerGContourRefusal`.
Success carries the value plus diagnostics — contour parameter `c`,
truncation `T`, evaluation count, working precision, warnings.
Structured refusals:

* `non-convergent-contour` — `2(m+n) ≤ p+q`, vertical contour does
  not decay (Stirling rate analysis below). Caller routes to the
  asymptotic layer (hv0.9, forthcoming) or back to Slater.
* `no-valid-contour` — `max{Re(a_j)} − 1 ≥ min{Re(b_j)}`, the upper-
  pole and lower-pole clusters overlap; no vertical contour separates
  them. A future bead can introduce contour deformation
  (DLMF §16.17.2 case 3); v0.1 refuses.
* `input-error` — invalid precision; `z = 0` (where `z^s` is
  undefined); driver-level errors.

Algorithm:

1. **Validate inputs.** Refuse non-decaying contour and overlapping
   pole clusters before any compute.
2. **Choose `c`.** Default: midpoint of the safe interval
   `(max{Re(a_j)} − 1, min{Re(b_j)})`. Caller may override via
   `opts.contourRe`. The midpoint is bit-deterministic and avoids the
   trivial "land on a pole" hazard for non-degenerate inputs.
3. **Build integrand.** `t ↦ M(c + it)` with all `cgamma` and `cexp`
   at workingBits. `clog(z)` cached once and closed over (the
   integrand is invoked O(15·iterations) times during quadrature plus
   the truncation search; avoiding repeated `clog` matters).
4. **Choose `T`.** Asymptotic estimate `T_init = ceil(X · log(2) /
   (π · α))` where `X = precision · log2(10) + 20` (precision-relative
   threshold with 20-bit headroom for the truncated tail) and `α =
   (2(m+n) − (p+q))/2` is the Stirling decay rate. Verify by sampling
   the integrand at `±T_init` against `peakAbs · 2^-X`; double T (cap
   at 20 doublings) until both tails fall below threshold.
5. **Quadrature.** `gaussKronrodAdaptiveBC(integrand, -T, T,
   precision)`. Driver result is folded into the contour result.
6. **Prefactor `1/(2π)`.** The `1/(2πi)` of the integral definition
   combines with `ds = i dt` on the contour to leave a real `1/(2π)`.
7. **Round** to user precision and pack the result, with diagnostic
   warnings on auto-selected `c` and `T`.

### Tests — 35 + 10 new tests, faithful-extension byte-equality + closed-form + cross-check

`packages/quadrature/test/quadrature-bc.test.ts` — 35 tests. Three
tiers:

- Faithful-extension byte-equality with BF driver on real-only
  integrands (9 tests; 3 integrand classes × 3 precisions).
  Algebraic exactness on `(c0 + i·c1)·t^k` (7 tests).
- `∫_0^{2π} e^{i·t} dt = 0` value-correctness probe (3 precisions).
  `∫_0^1 (cos+i·sin) dt = sin(1) + i·(1−cos(1))` against mpmath at
  30/50/80 dps (3 tests, 110-dps cited oracle).
- Bit-determinism, oscillatory budget honesty, boundary refusals
  (matching BF driver semantics), default-tolerance scaling, result
  shape, integrand-linearity probe.

`packages/meijer-core/test/contour.test.ts` — 10 tests. Three
mutation-prove strategies:

- Closed-form identities: `G^{1,0}_{0,1}(_; 0 | 1) = e^{-1}` and
  `G^{1,0}_{0,1}(_; 0 | 2) = e^{-2}` (DLMF §16.18.4, 110-dps cited
  oracle from mpmath).
- Slater cross-check: contour and Slater on the same params must
  agree to working precision (the load-bearing mutation-prove —
  Slater is independently tested against closed forms in
  `slater.test.ts`).
- Structured refusals (4 tests covering the three refusal classes),
  bit-determinism, result shape.

### Documentation lockstep (Law 2)

- `docs/adr/0022-bigcomplex-codomain-quadrature.md` — the design ADR
  for the BigComplex driver. Names the alternatives considered
  (per-component split with caching, codomain-generic field-record
  generic) and explains why "parallel named driver" wins per the two
  principles (ADR-0009).
- `packages/quadrature/README.md` — three-driver matrix at the top;
  BC surface documented alongside BF; tests count updated to 141.
- `packages/meijer-core/README.md` — promoted from "Slater only" to
  "Slater + Contour" with both entry points in the synopsis; the
  honest-scope ceiling note (~22 dps from cgamma's Stirling budget)
  is in the Tests section.
- Main `README.md` — meijer-core row updated to mention Layer 5,
  ADR-0022, and the `@workbench/quadrature` dependency.
- `packages/meijer-core/package.json` — `@workbench/quadrature`
  workspace dep added.
- `tsconfig.json` — collateral cleanup of stale `paths` (added
  `@workbench/{alg-num, real-roots, solve, poly-factor}`; these
  packages exist and are imported but were missing from the path
  table — pre-existing drift from worklogs 052/053/054/059/065 that
  was preventing `bun run check:quick` from passing globally).

## Why these choices

### BigComplex codomain shape — parallel named driver, not generic

ADR-0022 §"Decision" pins this. The TS-expert irresistibility test
rules out the codomain-generic option: `gaussKronrodAdaptive<T>(field:
Field<T>, …)` would force every call site to construct a field record,
the generic doesn't propagate cleanly through `(x: BigFloat) => T`
callbacks, and TypeScript inference loses a step. The per-component
split with caching is brittle (the Re-pass and Im-pass heaps bisect
differently because their local K-G estimates differ; the cache hit
rate is poor; "joint convergence" ends up looking exactly like a
complex-codomain driver anyway). One driver, one heap, one convergence
flag — what a TS expert reaches for without thinking.

### Library extension only, no wire tool in v0.1

Same reasoning as ADR-0021 §1. The near-term consumer (`hv0.8`'s
contour layer + the eventual `tools/meijer-g` dispatcher in `hv0.10`)
is in-process. A wire tool would be dead surface; when `tools/meijer-g`
ships, the right shape is a thin wrapper analogous to
`tools/meijer-g-slater-only` (worklog 070).

### Symmetric truncation around `t = 0` (v0.1)

For real `z` with `arg(z) = 0`, the integrand peak is at `t = 0` and
symmetric truncation is optimal. For complex `z` with `arg(z) ≠ 0`, the
`e^{-t · arg(z)}` factor in `z^s` shifts the peak but doesn't change the
worst-case decay; symmetric `[-T, T]` is conservative (correct, not
optimal) since both tails fall below the same threshold by construction
of the truncation search. A future v0.2 can centre the contour on the
actual peak; not in v0.1's scope.

### Honest-scope precision ceiling near 22 dps

The contour algorithm's effective achieved precision tops out near 22
dps regardless of the user's target, due to the bigfloat substrate's
`cgamma` Stirling cancellation budget (96-bit margin in
`clgammaShifted`, ≈ 28 dps internal headroom that the Mellin-Barnes
integrand's repeated `cgamma` calls eat through). At low precision
targets (≤ 20 dps) the algorithm achieves target + 1 dps reliably; at
higher targets it flattens to 21-22 dps. v0.1 ships honest about this:
test assertions are `TARGET_DPS - 5` (15-dps target → 10-dps
tolerance), which fits the ceiling comfortably and runs in seconds. A
future bead can lift the ceiling by widening `cgamma`'s Stirling budget
or by computing the integrand via `clgamma` directly (avoiding
cancellation between large Γ products and their reciprocals); not in
v0.1's scope.

### Decay-rate refusal

`2(m+n) ≤ p+q` is the precise condition under which the integrand fails
to decay along a vertical line — derived from Stirling: each `Γ(σ ±
it)` factor contributes `e^{-π|t|/2}` net for large `|t|`, so net
exponent is `((m+n) − (p+q−m−n))/2 · π · |t| = α · π · |t|` with `α =
(2(m+n) − (p+q))/2`. For `α ≤ 0` the integrand grows or oscillates
without decay. We refuse rather than emit a divergent quadrature; the
asymptotic layer (`hv0.9`) is the right home for these cases.

## Frictions surfaced

### `∫_0^{2π} e^{i·t} dt = 0` value-correctness vs convergence-flag

The first BC test pass had two failures: at 50/80 dps the algorithm's
*value* was correct (truth-comparison passed silently) but
`r.converged` was `false`. Diagnosis: when the integral is *exactly
zero* on a non-polynomial integrand, the strict K-G convergence test
`errorEstimate ≤ atol + rtol·|value|` collapses to `errorEstimate ≤
atol`, which K15+adaptive cannot satisfy within practical budget at high
precision (~6900 subintervals needed for atol=10⁻⁵⁰ vs default budget
of `prec·200`). The Cauchy stability test also can't fire because its
threshold `cabs(value) × ε → 0` as value → 0.

This is the algorithm being *honest*, not a bug. Same shape as the BF
driver's `1/(1+x²)` honest-scope test (capped at prec=20). Updated the
∫=0 test to assert value-correctness (the load-bearing capability claim)
and convergence-flag honesty (a `false` flag must be accompanied by a
warning). The BF driver has the same potential behaviour for ∫=0 cases
on non-polynomial integrands; just hasn't been tested there.

### Pre-existing tsconfig drift surfaced

`bun run check:quick` failed on phases 2 (typecheck) and 4 (workspace
tests) because `@workbench/{alg-num, real-roots, solve, poly-factor}`
packages were missing from `tsconfig.json`'s `paths` table — they
exist as packages and are imported, but the path entries were never
added during the ports in worklogs 052/053/054/059/065. Confirmed via
`git stash` + re-run that the failures are unrelated to hv0.8's diff.
Fixed in lockstep (4 lines added to `tsconfig.json`); collateral
cleanup, not scope creep — keeps `check:quick` green for everyone.

### Wall-clock cost of arbprec contour at moderate precision

A full `meijergContour` run at prec=30 takes ~75 seconds; at prec=20,
~21 seconds; at prec=15, ~12 seconds. The cost is dominated by the
integrand's `cgamma` calls (cgamma at 130-bit working precision is
moderate; per-evaluation cost is several milliseconds; the truncation
search adds tens of evaluations and the quadrature does 600-1000
evaluations). For tests, picked TARGET_DPS = 15 (9 tests in ~130s);
at user-call sites the precision-vs-wall-clock tradeoff is in the
caller's hands.

### `cgamma` working-precision ceiling vs user precision

Related to the wall-clock issue but a distinct concern. The substrate's
`cgamma` adds 96 bits of margin (`work = prec + 96` in
`clgammaShifted`) for Stirling cancellation. At prec=130 bits (=
workingBits for a 30-dps user request), cgamma works internally at 226
bits — but the Mellin-Barnes integrand calls cgamma multiple times and
the per-call ulp accumulation eats that margin. The empirical ceiling
is ~22 dps achieved regardless of higher targets. Honest scope; future
bead to revisit.

## Acceptance

- Bead `hv0.8` claimed at session start; closed at session end.
- ADR-0022 written and accepted.
- `packages/quadrature/src/gauss-kronrod-bc.ts` shipped (~520 LOC
  including literate prose).
- `packages/meijer-core/src/contour.ts` shipped (~370 LOC).
- `packages/quadrature/test/quadrature-bc.test.ts` shipped with 35
  tests; all green.
- `packages/meijer-core/test/contour.test.ts` shipped with 10 tests;
  all green.
- Existing tests pass byte-identically: 30 float64 quadrature, 76
  arb-prec real quadrature, 29 meijer-core series-select+slater, 6
  tools/meijer-g-slater-only.
- `bun run check:quick` green (4/4 phases: conventions, codegen,
  typecheck, workspace tests). Pre-existing tsconfig drift fixed in
  lockstep so this passes globally.
- Documentation lockstep: `packages/quadrature/README.md`,
  `packages/meijer-core/README.md`, main `README.md` row,
  `tsconfig.json`, both package.json files updated. Worklog shard
  this file, ADR-0022 the design pin, campaign log
  `WORKLOG-13.md` to be updated.

## Pointers

- Design ADR: `docs/adr/0022-bigcomplex-codomain-quadrature.md`.
- BigComplex driver: `packages/quadrature/src/gauss-kronrod-bc.ts`.
- Contour orchestrator: `packages/meijer-core/src/contour.ts`.
- Tests: `packages/quadrature/test/quadrature-bc.test.ts` (35),
  `packages/meijer-core/test/contour.test.ts` (10).
- Campaign log: `../tstournament/ts-bench-infra/problems/13-meijer-g/
  WORKLOG-13.md` (this shard's tournament-side counterpart).

## Next pickup

The campaign now has 5 of 12 child beads closed (`hv0.1` ✓ bigfloat,
`hv0.3` ✓ pFq, `hv0.5` ✓ Slater, `hv0.7` ✓ arb-prec quadrature,
`hv0.8` ✓ contour layer). Open and unblocked:

* `hv0.2` — `cas-core` special-function AST extension (no upstream).
* `hv0.4` — `bench/hypergeometric-pfq` tier-graded battery.
* `hv0.9` — Braaksma asymptotic + hyperasymptotic (depends on `hv0.1`,
  `hv0.2`).
* `hv0.6` — Adamchik-Marichev + Roach symbolic dispatch (depends on
  `hv0.2`).

Recommended next: `hv0.2` (cas-core special-function vocabulary
extension) — it's the next prerequisite for both `hv0.6` (symbolic
dispatch) and `hv0.9` (asymptotic), and unblocks the most downstream
work. Alternative algorithmic siblings: `hv0.4` (bench/pFq tier-graded
battery), or filing follow-ups on the contour ceiling (lift cgamma's
Stirling budget or compute integrand via clgamma) and the asymmetric
truncation refinement.
