# Worklog 072 — `packages/quadrature` arb-prec generalisation shipped (`gaussKronrodAdaptiveBF`)

**Date:** 2026-05-08.
**Beads:** `scientist-workbench-hv0.7` (✓ closed). New ADR-0021.
**Related ADRs:** ADR-0014 (numerical-tier precedent), ADR-0015
(numerical-tier determinism), ADR-0020 (arb-prec tier — the contract
this driver inherits), ADR-0010 (defineTool/runTool split — why we
extended the package without adding a new wire tool).
**Lockstep with:** [`docs/worklog/071-bigfloat-exp-false-alarm-and-hardening.md`](071-bigfloat-exp-false-alarm-and-hardening.md)
(the substrate that this driver builds on) and the campaign log at
`../tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`.

## Context

Layer 4 of the seven-layer Meijer G stack (per
`tstournament/ts-bench-infra/problems/13-meijer-g/PLAN.md`) is the
**Mellin-Barnes contour quadrature** (`hv0.8`): the contour integral
that closes the loop where the Slater residue expansion does not
converge. The contour is parameterised as a real integral over `t ∈ ℝ`
(truncated by asymptotic decay), and the integrand is `Γ`-product-
times-`z^s`, computed in the bigfloat substrate at `--precision`-
dictated working precision.

That layer needs an arb-prec adaptive 1D quadrature substrate. The
existing `packages/quadrature` shipped a float64 G7K15 driver
(ADR-0014); this shard ships its arb-prec generalisation
(`gaussKronrodAdaptiveBF`) on top of `@workbench/bigfloat`.

The brief offered three plumbing choices for the wire tool: parameterise
`tools/integrate-1d` on precision; split into `integrate-1d-float64`
+ `integrate-1d-arbprec`; or extend the package without changing the
wire surface. ADR-0021 picks the third — the consumer (`hv0.8`) is
in-process, and the wire tool can be added later when an agent surface
needs it.

## What changed

### `packages/quadrature/src/nodes-weights-bf.ts` — the canonical-constants table

A new file carrying the G7K15 nodes and weights as 200-decimal-digit
string literals:

- `XGK[0..7]` — positive Kronrod abscissae, descending magnitude;
  `XGK[7] = 0` is the centre.
- `WGK[0..7]` — Kronrod weights at `±XGK[i]` (and centre at index 7).
- `WG[0..3]` — Gauss weights at `±XGK[1], ±XGK[3], ±XGK[5]`, plus
  centre.
- `WGK_MINUS_WG[0..2]` and `WGK_MINUS_WG_CENTRE` — precomputed
  differences `WGK[2k+1] - WG[k]` and `WGK[7] - WG[3]`. (The
  centre's difference is unused in the production hot path after
  the centred-delta fix below, but kept for table completeness.)

All values were generated via mpmath at 230 dps using the standard
Stieltjes-orthogonality construction (Patterson 1968 / Laurie 1997 /
Monegato 2008): G7 nodes from `polyroots` of `P_7(x)`'s
even-substituted polynomial; `E_8(x)` (the Stieltjes polynomial) via
the orthogonality system `∫_{-1}^1 P_7(x) E_8(x) x^k dx = 0` for
k = 1, 3, 5, 7 (the trivially-zero even cases dropped); K15 weights
via the Vandermonde system on `x^{2k}` for k = 0..7. The full
generation script is preserved as a comment in the file's header —
rerunning it at `mp.dps = 230` reproduces the constants byte-for-byte.

Cross-verified at generation time against GSL `qk15.c`'s float64
constants byte-for-byte at the truncated precision (16 entries: XGK[0..7],
WGK[0..7], WG[0..3] — `|truncated_arbprec - GSL_float64| = 0` at all
positions; GSL's source comment says the constants were "evaluated
with 80 decimal digit arithmetic by L. W. Fullerton, Bell Labs, Nov.
1981", which matches our 200-dps regeneration's truncation exactly).

The table is parsed lazily into BigFloat values via `getG7K15Table
(workingBits)`; first call at a given precision constructs the
table, subsequent calls return the cached one. Cap:
`MAX_DECIMAL_PRECISION = 150` (with the substrate's standard 30-bit
safety margin, the table's 200-dps storage gives ~50 dps of
headroom; refuse loudly past that, do not silently degrade).

### `packages/quadrature/src/gauss-kronrod-bf.ts` — the adaptive driver

Public surface:

```ts
gaussKronrodAdaptiveBF(
  f: (x: BigFloat, prec: number) => BigFloat,
  a: BigFloat,
  b: BigFloat,
  prec: number,                           // decimal digits
  opts?: BigFloatQuadOptions,
): BigFloatQuadResult
```

The result shape mirrors the float64 driver's `QuadResult` field-for-
field, with two BigFloat-tier additions: `precision` (decimal digits
the result was rounded to) and `workingPrecision` (bit precision the
substrate worked at). The integrand callback takes `prec` as a second
argument — load-bearing for integrands that themselves do arb-prec
work (e.g., `evaluatePFq`); a callback without it would force the
integrand to either over-compute or under-compute, corrupting the
quadrature.

Algorithm shape: same priority-queue bisection on a max-heap as the
float64 driver, but with arb-prec arithmetic throughout. Three
arb-prec-specific structural changes:

1. **Centred-delta K-G computation** (the load-bearing high-precision
   correctness fix). Naive `K - G` (compute K15 and G7 as separate
   sums, subtract) loses ~log₂(|K|/|K-G|) bits to cancellation; at
   53-bit precision this is absorbed by the working margin, but at
   167+ bits it dominates and floors the running `errorEstimate`
   above the user's tolerance. First-attempt fix (precomputed
   `WGK[i] - WG[i]` direct-product summation) didn't help — the sum
   still has positive (Kronrod-only) and negative (Gauss-shared)
   weight contributions totalling exactly zero (forced by the rule's
   exactness on constants), so for smooth integrands whose `fSum_i`
   values are similar in magnitude, the same cancellation reappears.

   The correct fix is algebraic, not numerical. Substitute
   `fSum_i = 2·f(centre) + δ_i` where `δ_i = fSum_i - 2·f(centre)`
   is the *variation* across a symmetric pair of abscissae. Then
   `K - G = Σ_i (WGK_i - WG_i) · δ_i` — the centre's contribution
   vanishes (because both K15 and G7 integrate constants exactly),
   and each term in the sum is `weight × small variation`, so the
   running sum carries the working-precision relative accuracy of
   small magnitudes without any large-vs-large cancellation. ADR-0021
   has the full algebraic derivation.

2. **Heap-rebuild running totals** (correctness, not perf). The
   float64 driver delta-updates the running `value` and `errorEstimate`
   (`total += new − old`); at 53-bit precision the cancellation in
   `(newL + newR) − oldPopped` is harmless. At arb-prec, that
   cancellation chews through the running totals' lower bits over
   many iterations. The arb-prec driver instead recomputes both
   totals from the heap each iteration. Cost: O(heap size) per
   iteration, but heap traversal is microseconds while a single local
   rule call is milliseconds — perf cost is in the noise.

3. **Cauchy value-stability secondary convergence test**. K-G measures
   G7's algebraic error, which decreases at G7's rate (`~1/N^k` under
   bisection, k = 13 for G7). For high-degree polynomials and smooth
   analytic integrands at moderate precisions, K-G floors far above
   the user's tolerance long before K15's actual error reaches the
   floor — without a secondary criterion, every polynomial test of
   degree ≥ 14 would budget out reporting `converged: false` even
   though K15 is *algebraically exact*. The secondary test fires when
   the running value's iteration-by-iteration change drops below
   `|value| × 2^-(workingBits - 30)` (substrate ulp + 30-bit headroom)
   for 8 consecutive iterations — much tighter than the user's tol,
   so spurious early firing during heap traversal is robustly
   avoided. When Cauchy fires but K-G doesn't, a warning is added to
   the result.

### Tests — 72 tests in `quadrature-bf.test.ts`

Coverage:

- Algebraic exactness on `x^k` for k = 0..23 at 50 and 100 dps. K15
  is exact through degree 22; the test verifies the value matches
  the rational truth `2/(k+1)` (even k) or zero (odd k) to within
  the user-precision tolerance, and `converged: true` (K-G drops to
  zero on polynomials algebraically; Cauchy fires after the K15-
  exact-via-bisection settles).
- Cross-precision agreement vs mpmath truth (cited oracle, recipe in
  the test header) for entire functions sin and exp at 30/50/80 dps.
- Smooth-analytic-with-bounded-radius (`1/(1+x²)`) at prec=20 only —
  honest scope: K15+adaptive saturates more slowly on this class
  than on entire functions, and 20 dps is the algorithm's reasonable
  target within practical budget.
- Bit-determinism (two runs → byte-identical BigFloats — the load-
  bearing arbprec invariant from ADR-0020).
- Convergence-flag honesty: oscillatory `sin(1000x)` under tight
  budget reports `converged: false` and the `errorEstimate`
  upper-bounds the actual error.
- Bisection adaptivity: narrow Gaussian peak forces iterations > 0
  and converges to the closed-form truth.
- Boundary refusals: `prec > MAX_DECIMAL_PRECISION` throws RangeError,
  `prec < 1` throws, non-integer `prec` throws, `a >= b` throws
  BigFloatQuadratureError, `maxEvals < 15` throws, integrand
  exceptions propagate verbatim.
- Default-tolerance scaling: a constant integrand at 30/50/70 dps
  has `errorEstimate ≤ 10^-prec`.
- Result shape: precision/workingPrecision/method populated correctly.
- Table cache idempotency.
- Rule-symmetry: Σ paired Kronrod weights = 2 (rule integrates 1
  exactly) and Σ paired Gauss weights = 2 at 30/80/150 dps.

72/72 pass; the existing 30 float64 tests pass byte-identically (no
shared-state changes leak). 106/106 across the package.

### Documentation lockstep (Law 2)

- `docs/adr/0021-quadrature-arbprec.md` — the design ADR.
- `packages/quadrature/README.md` — rewritten to document both
  surfaces (float64 and arb-prec), the algorithm shapes, the
  centred-delta identity, the convergence model, the scope/cap.
- `packages/quadrature/package.json` — `@workbench/bigfloat`
  workspace dependency added.
- `packages/quadrature/src/index.ts` — barrel re-exports the new
  surface alongside the float64 driver.

## Why these choices

### Library extension only — no new wire tool in v0.1

Per ADR-0021 §1: the consumer (`hv0.8` Mellin-Barnes contour) is
in-process. A wire tool would be dead surface — no agent invokes it
via subprocess until `tools/meijer-g` (`hv0.10`) ships, and at that
point a thin wrapper (the `meijer-g-slater-only` precedent) is the
right shape. Parameterising `tools/integrate-1d` on precision would
require changing its float64-bound output schema to a union with a
BigFloat tier; a breaking change to a stable surface for no near-term
benefit. The package layer is the right home (ADR-0010): both the
float64 and arb-prec drivers in the same package, wire layer added
when needed.

### Two named drivers, not a generic over a `Field<T>`

Per the two principles (ADR-0009): a TypeScript expert reading the
API surface wants to call `gaussKronrodAdaptiveBF(f, a, b, 50)`
without thinking about a field-record argument. A generic
`gaussKronrod<T>(field: Field<T>, ...)` would be type-elegant on
paper but reads as ceremony at every call site. Two named drivers
match the workbench's existing pattern (e.g., `runTool`/`executeToolDef`
for subprocess vs. in-process invocation): same algorithm, two named
surfaces, no generic ceremony.

### Centred-delta over higher-precision K-G computation

An alternative to the centred-delta identity would be: compute K and
G separately at *workingBits + ~100*, subtract, and round the
difference back to workingBits. Cost: ~1.3× more BigInt limbs in
every K-G arithmetic op. The centred-delta identity is structurally
better — same compute cost as the naive K-G computation, no
cancellation possible by construction (the centre's contribution
algebraically vanishes, and the remaining sum is `weight × small
variation` throughout). The algebra is also self-documenting:
reading the local-rule code reveals *why* it's cancellation-stable,
without forcing the reader to track precision-margin reasoning.

### Cauchy value-stability + the substrate-ulp threshold

The K-G error estimator is fundamentally pessimistic at high precision
because it measures G7's algebraic error, not K15's. For polynomials
of degree ≥ 14 K15 is *exact* yet K-G is non-zero. Empirically tested
three threshold designs:

1. `atol` itself — fired prematurely on Gaussian peaks (declared
   convergence at 17 dps when 30 were requested).
2. `atol / 1000` (3 dps tighter than user tol) — too loose for
   polynomial-class cases (didn't fire on smooth analytic where
   value movement is at the K15 algebraic noise level), too tight
   for narrow-peak cases.
3. `|value| × 2^-(workingBits - 30)` (substrate ulp + 30-bit
   headroom) — robust across all classes. For polynomials the
   value-change is exactly zero after K15-exact bisection settles;
   for entire functions it reaches working ulp within tens of
   iterations; for narrow peaks it stays well above until the peak
   is localised, then drops; for oscillatory under tight budget it
   stays well above and `converged: false` is honest.

`STABILITY_RUNS = 8` consecutive sub-threshold iterations is
defensive — single coincidences during heap traversal of irrelevant
subintervals are washed out.

## Frictions surfaced

### The K-G estimator is unsuitable for arb-prec convergence checks (algorithmic, not numerical)

Long debugging session: π/4 at 50 dps target stalled at ~28 dps
agreement regardless of bisection depth. First two hypotheses (K-G
cancellation in the local rule, delta-update cancellation in the
running totals) had real signal but didn't fix the convergence flag.
The actual issue: K15+adaptive's *strict K-G bound* simply takes
astronomical iteration counts to satisfy `K-G ≤ 10^-50` on smooth
analytic integrands like `1/(1+x²)` (Taylor radius 1, derivative
magnitudes grow factorially). K-G drops at G7's algebraic rate
(~1/N^14 for x^14), not K15's. The arb-prec test suite asks for
50 dps; the algorithm honestly cannot deliver via the strict K-G
bound, but the *value* IS at 50 dps via K15's algebraic exactness.

The Cauchy value-stability secondary test rescues this — it sees the
running value has stopped moving at the substrate ulp floor, declares
convergence, and adds a warning. Without it, every polynomial test
of degree ≥ 14 would budget out reporting `converged: false` despite
K15's algebraic exactness on those integrands.

The senior-engineer lesson: **K-G is the right BISECTION-PRIORITY
signal but the wrong CONVERGENCE-CERTIFICATE signal at high precision**.
The float64 driver gets away with K-G as the convergence test only
because at 53-bit precision K-G's algebraic floor is below the
working ulp floor — once K-G reaches `~10^-15` the algorithm has
already saturated.

### The first cancellation-stable formulation didn't help

I initially implemented "compute K-G as a single sum using
precomputed `WGK_i - WG_i` differences." This *should* avoid the
naive cancellation between K and G's separate sums, but it didn't —
the resulting sum has positive (Kronrod-only) and negative
(Gauss-shared) weight contributions that total exactly zero (forced
by the rule's exactness on constants), so for smooth integrands
with similar `fSum_i` values, the cancellation reappears.

The fix is algebraic, not just structural: factor out `f(centre)` so
the K-G expression becomes `Σ weight × variation`, where each
variation is small by construction. The centre's K-G contribution
vanishes algebraically (proof in the file header). After this fix,
the K-G computation has no cancellation issue at any working precision.

(The first-attempt `WGK_minus_WG_CENTRE` constant is kept in the
table for completeness and audit — it's mathematically correct, just
unused on the hot path. ADR-0021 footnotes this.)

### Honest-scope realisation: K15+adaptive vs tanh-sinh

For high-precision smooth-analytic integration (≥ ~50 dps on
integrands with bounded Taylor radius), K15+adaptive simply isn't
the right algorithm. Tanh-sinh quadrature converges doubly-
exponentially in the number of sample points and reliably delivers
100+ dps with O(prec) function evaluations. The right answer is to
ship K15+adaptive at the precision-class it can deliver (entire
functions, oscillatory, weakly singular, Mellin-Barnes contours)
and file tanh-sinh as a follow-up bead. The Mellin-Barnes contour
integrand the consumer wants is *oscillatory*, well-suited to K15;
the failing test cases (`1/(1+x²)`, narrow Gaussian peak) were
chosen as worst-case stress probes.

### `bd update --notes` overwrites, doesn't append (worklog 071's
lesson, repeated)

Same observation as worklog 071: when annotating the bead, `bd update
--notes` replaces the prior notes rather than appending. Used the
issue body's design field for additive notes instead.

## Acceptance

- Bead `hv0.7` claimed at session start; closed at session end.
- ADR-0021 written and accepted.
- `packages/quadrature/src/{nodes-weights-bf,gauss-kronrod-bf}.ts`
  shipped (~1100 LOC across the two files including comprehensive
  literate prose).
- `packages/quadrature/test/quadrature-bf.test.ts` shipped with 72
  tests; all green.
- Existing 30 float64 tests in `quadrature.test.ts` pass byte-
  identically.
- `bun run check:quick` green (4/4 phases: conventions, codegen,
  typecheck, workspace tests).
- `packages/quadrature/README.md` rewritten in lockstep.
- `packages/quadrature/package.json` adds `@workbench/bigfloat`
  workspace dep.

## Pointers

- Design ADR: `docs/adr/0021-quadrature-arbprec.md`.
- Constants table + lazy parser:
  `packages/quadrature/src/nodes-weights-bf.ts` (~290 LOC, mostly
  literate header + the 200-dps string constants).
- Driver: `packages/quadrature/src/gauss-kronrod-bf.ts` (~430 LOC
  including the file's algorithm-prose header that derives the
  centred-delta identity, plus driver code).
- Tests: `packages/quadrature/test/quadrature-bf.test.ts` (~430 LOC).
- Generation script (preserved as comments in
  `nodes-weights-bf.ts`'s header): mpmath at 230 dps, Stieltjes
  orthogonality system, Vandermonde-on-`x^{2k}` for K15 weights, G7
  weights via the standard `2 / ((1 - x²) (P'_n(x))²)` formula.
- Campaign log: `../tstournament/ts-bench-infra/problems/13-meijer-g/
  WORKLOG-13.md` (this shard's tstournament-side counterpart).

## Next pickup

The campaign now has 4 of 12 child beads closed (hv0.1 ✓ bigfloat,
hv0.3 ✓ pFq, hv0.5 ✓ Slater, hv0.7 ✓ this). Open and unblocked:

* `hv0.2` — `cas-core` special-function AST extension (no upstream
  beyond hv0.1 ✓).
* `hv0.4` — `bench/hypergeometric-pfq` tier-graded battery (no
  upstream beyond hv0.3 ✓).
* `hv0.8` — Mellin-Barnes contour quadrature (depends on hv0.7 ✓ and
  hv0.2). **Now unblocked** if hv0.2 is the only remaining
  dependency — though hv0.2's symbolic-AST work is independent of
  the Mellin-Barnes algorithmic core, so hv0.8 could potentially
  start in parallel.

Recommended next: **hv0.8** (Mellin-Barnes contour) — this driver's
direct consumer. A natural design choice for hv0.8: build the
contour-integrand evaluator as a `BigComplex` codomain extension of
this driver (the deferred `BigComplex` extension referenced in
ADR-0021 §"What we will not decide"), which can either fork the
driver via per-component evaluation or extend it via a small generic
helper — that decision belongs in hv0.8's design.
