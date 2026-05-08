# ADR-0024 — Tanh-sinh (double-exponential) quadrature, arb-prec library extension

**Status:** Accepted (design); v0.1 implementation **PARTIAL** — driver
shipped with a known precision-floor issue on smooth-analytic
bounded-Taylor-radius integrands (the `1/(1+x²)` class — exactly the
case worklog 072 motivated this driver to address). 4 tests skipped per
worklog 075. See `scientist-workbench-6f8` (still open) and worklog 075
for the diagnosis snapshot and the next-agent handoff. — 2026-05-08
**Beads:** scientist-workbench-6f8 (this ADR + the
`packages/quadrature/src/tanh-sinh-bf.ts` driver it specifies); parent
ADR-0014 (the numerical-tier seed) and ADR-0020 (arb-prec tier).
**Related:** ADR-0021 (the `gaussKronrodAdaptiveBF` driver this sibling
parallels — same result shape, same `arbprec: true` determinism
contract); ADR-0022 (the BigComplex codomain extension to G7K15;
mentioned only because this ADR pins the BF-codomain v0.1 — a BC
extension is a separate ADR if motivated); ADR-0009 (TS-native idiom —
"two named drivers, not a generic over an algorithm enum").
**Reference:** Bailey, D. H., Jeyabalan, K. & Li, X. S. (2005),
"A Comparison of Three High-Precision Quadrature Schemes,"
*Experimental Mathematics* 14(3), 317–329 (preprint at
https://www.davidhbailey.com/dhbpapers/quadrature-em.pdf). Section 3
(QUADTS) for the algorithm; Section 4 for the Euler-Maclaurin
justification; Section 5 for the heuristic error estimator. Underlying
method: Takahasi & Mori (1974), "Double exponential formulas for
numerical integration," *Publ. RIMS* 9, 721-741.

## Context

`gaussKronrodAdaptiveBF` (ADR-0021) is the workbench's arb-prec
quadrature substrate. Worklog 072 §"Frictions surfaced" surfaces an
honest-scope realisation: K15+adaptive's *algebraic* error decay
under bisection (~`1/N^k` with k = 13 for G7) saturates slowly on
smooth-analytic integrands with bounded Taylor radius. Concretely:
`∫_0^1 1/(1+x²) dx` at 50 dps required astronomical iteration counts
to satisfy the strict K-G bound; the bigfloat driver *had* to add a
Cauchy-stability secondary convergence test (substrate ulp floor) to
ship green at all on this class.

Tanh-sinh quadrature is the canonical algorithm for the integrand
class K15+adaptive does not handle well. Bailey-Jeyabalan-Li 2005
(Section 4) gives the reason: under the variable transformation
`x = g(t) = tanh((π/2)·sinh t)`, the transformed integrand
`f(g(t))·g'(t)` is bell-shaped with all derivatives vanishing at
`±∞` *doubly-exponentially*, so by Euler-Maclaurin the trapezoidal
rule on this transformed integrand converges *faster than any power
of h*. In practice: doubling the number of points roughly doubles
the number of correct digits — the algorithm hits 400-digit
accuracy with `~7.2 · 2^m` evaluations at level `m` (~50 evaluations
at level 3, ~115 at level 4, ~230 at level 5), and stays in a
single-power-of-2 doubling range up to thousands of digits.

The bead `6f8` was filed at the end of hv0.7 as a deferred follow-up
("speculative — claim only if a real workload reports the
limitation"). The user asked for "fun next" after `hv0.2` shipped; the
algorithm is one of the most beautiful in numerical analysis and
closes a documented limitation. Promoting from speculative-deferred
to shipped.

## The axioms (re-applied)

ADR-0009 — *what would a TS expert reach for, without thinking*:

* `tanhSinhAdaptiveBF(f, a, b, prec, opts?)` — the suffix `BF` matches
  the `gaussKronrodAdaptiveBF` precedent. Same call site, same return
  shape, same determinism contract. A reader who knows the G7K15 BF
  driver predicts every call site of the new driver without reading
  any docs.
* The driver returns `BigFloatQuadResult` — *byte-identical type* to
  the G7K15 BF driver's result. The `method` field discriminates:
  `"gauss-kronrod-g7k15-bigfloat"` vs `"tanh-sinh-bigfloat"`. Agents
  branch on `method` only when the algorithm choice matters; for the
  common case "this is my arb-prec quadrature result" they don't have
  to.
* The codomain stays BigFloat (real). The hv0.8 contour layer uses
  `gaussKronrodAdaptiveBC` for its complex-valued integrands; tanh-sinh
  is for *real* smooth-analytic integrands and there is no near-term
  consumer asking for a BC-codomain extension. A BC variant is a
  separate ADR if motivated.

ADR-0020 — *arbprec is bit-identical cross-platform forever*:

* Every operation in this driver bottoms out in BigInt arithmetic
  (BigFloat substrate). Same input bytes + same `prec` → same output
  bytes on any JavaScript runtime, by language specification. No
  platform fingerprint needed.

## The algorithm (Bailey-Jeyabalan-Li 2005 §3)

**Variable transformation** (the substitution that makes
Euler-Maclaurin convergence "compound exponential"):

```
x = g(t)  = tanh((π/2) · sinh t)        ∈ (-1, 1)  for t ∈ ℝ
g'(t)     = (π/2 · cosh t) / cosh²((π/2) · sinh t)
```

(Bailey's Section 4 has a typo `sinh t / cosh²(...)` in the displayed
formula; Section 3's `u₁ = (π/2)·cosh(jh)` is the correct numerator,
verified by direct chain-rule derivation. The driver follows Section
3.)

**Affine map [a, b] → [-1, 1]:** `y(x) = (a+b)/2 + (b-a)/2 · x`,
`dy = (b-a)/2 · dx`. The user-coordinate integrand is evaluated at
`y(g(jh))`; the result is multiplied by `(b-a)/2` at the very end.

**Level structure** (Bailey §3): level `k` uses step `h_k = 2^{-k}`.
The full set of abscissas at level `k` is `{j · h_k : j ∈ ℤ}`, and
the *even-indexed* pairs at level `k` coincide *exactly* with the
full set at level `k-1` (because `2j · 2^{-k} = j · 2^{-(k-1)}`).
Consequence: at each new level the integrand is evaluated only at
the *odd-indexed* abscissas — a 2× saving each step.

**Recurrence:** writing `S_k` for the trapezoidal sum
`h_k · Σ_{j ∈ ℤ} f(g(j·h_k)) · g'(j·h_k)`,

```
S_k = (S_{k-1}) / 2  +  h_k · Σ_{j odd} f(g(j·h_k)) · g'(j·h_k)
```

This is the standard trapezoid-doubling identity, and it is the
load-bearing implementation reason this algorithm is fast: each
level reuses every previous evaluation.

**Pair-generation cutoff** (Bailey §3, "secondary epsilon" omitted in
v0.1): at each level we iterate `j = 1, 3, 5, ...` (positive side;
negative side is symmetric and processed in the same loop) and stop
when `w_j < ε`, the target tolerance. The doubly-exponential decay
of `g'(t)` makes this cutoff happen at moderate `|j|` (typically
20–30 for prec = 50–100 dps; ~50–80 for prec = 200+).

**Convergence test** (v0.1 — simpler than Bailey §5): declare
convergence when `|S_k − S_{k-1}| ≤ atol + rtol · |S_k|`. The
quadratic-convergence-on-correct-digits behaviour means this
typically fires at level 4–6 for smooth integrands at 50 dps.
Bailey §5's `d = max(d₁²/d₂, 2d₁, d₃, d₄)` heuristic is more
aggressive (it predicts the *next* level's error from the *quadratic-
convergence* assumption); v0.1 uses the simpler form, follow-up
bead lifts the heuristic.

## What this ships in v0.1

**Public surface:**

```ts
tanhSinhAdaptiveBF(
  f: (x: BigFloat, prec: number) => BigFloat,
  a: BigFloat,
  b: BigFloat,
  prec: number,
  opts?: TanhSinhBFOptions,
): BigFloatQuadResult
```

**Result shape:** the existing `BigFloatQuadResult` type from
ADR-0021. `method: "tanh-sinh-bigfloat"`. `iterations` reports the
*level count* (not the bisection count, since this is a level-
doubling rule); `nEvals` is the integrand evaluation count.

**Options shape:** `TanhSinhBFOptions` — same `atol / rtol / maxEvals`
as G7K15 BF, plus a `maxLevels` (default `prec`) cap so a pathological
integrand cannot run away. `maxEvals` defaults to `prec * 200`
heuristically (matches G7K15 BF; the level structure typically uses
`~7.2 · 2^level` pairs so the eval-budget bound is hit only on
runaways).

**Working precision:** `decimalToBinaryPrecision(prec, 30)` — same
30-bit safety margin as the G7K15 BF driver. The doubly-exponential
convergence does not put high-cancellation pressure on the substrate;
30 bits suffices for the smooth-analytic class v0.1 targets.

**Determinism:** unconditional. `arbprec: true`. Same `(input bytes,
prec)` → same output bytes, every runtime, every architecture, every
platform.

**Termination thresholds:**

* Pair-generation `ε`: `10^{-prec}` (same magnitude as the convergence
  tolerance). Truncation tail's contribution is bounded by `ε ·
  (number of dropped terms)` ≤ `ε · O(1)` since the doubly-exponential
  decay sums geometrically.
* Per-level `m`-iteration cap: `prec · 50` (defensive — the actual
  cutoff fires much earlier).

## What we will not decide here

* **Endpoint-singular integrands.** Bailey §3 describes a "secondary
  epsilon" scheme: store `1 − x_j = 1/(e^{u₂} · cosh u₂)` separately
  to avoid the `1 − tanh(big)` cancellation when the integrand has a
  blow-up singularity at `±1` (e.g., `√t/√(1−t²)`, `log²t`,
  `√(tan t)`). v0.1 does **not** ship this — pre-storing `1 − x_j` at
  a higher secondary precision adds significant book-keeping, and the
  immediate consumers of this driver (smooth-analytic at high prec)
  do not need it. A follow-up bead (`6f8.1` or similar) ships
  endpoint-singular support if a real workload reports it.
* **BC-codomain extension.** The contour layer (`hv0.8`) uses K15 for
  oscillatory BigComplex integrands; tanh-sinh is for *real* smooth-
  analytic integrands. A BC extension is a separate ADR if motivated
  by a future workload.
* **Pre-computed abscissa-weight table cache across calls.** Bailey
  pre-computes table entries at maximum precision once at startup
  (Section 3); we compute on-demand via the substrate's `sinh / cosh /
  tanh`. For typical use (level 4–6, ~30 abscissas per level, ~150
  total at 50 dps) the cost is in the few-hundred-millisecond range —
  acceptable for v0.1. A `getTanhSinhTable(workingBits)` cache
  paralleling `getG7K15Table` (ADR-0021) is a follow-up if motivated
  by amortisation needs.
* **Bailey §5's `d = max(d₁²/d₂, 2d₁, d₃, d₄)` heuristic error
  estimator.** The simpler `|S_k − S_{k-1}|` test is sufficient for
  v0.1; the d-formula is a follow-up.
* **Wire tool.** Same reasoning as ADR-0021 §1: the consumer is
  in-process. A wire tool would be dead surface until the day a real
  agent invokes tanh-sinh through stdin/stdout, at which point a
  thin wrapper (the precedent: `tools/integrate-1d`) ships.

## Why these choices

### Two named drivers, not an algorithm-enum

`gaussKronrodAdaptive(f, a, b, opts?, opts.method = "g7k15" | "tanh-sinh")`
would have been one option. Rejected: the integrand classes the two
algorithms target are mostly disjoint, the appropriate convergence
test differs (K-G ulp bound vs. successive-level delta), and the
appropriate options shape differs (atol/rtol/maxEvals vs. atol/rtol/
maxLevels/maxEvals). Two named drivers match how a TS expert
predicts the call site without thinking.

### Same `BigFloatQuadResult` type, different `method` tag

Driver-internal state (`workingPrecision`, `precision`, `nEvals`,
`converged`, `iterations`, `warnings`, `value`, `errorEstimate`) is
isomorphic across both drivers. Reusing the existing type means a
caller's result-handling code is method-agnostic — they read
`r.value` either way. The `method` discriminator is for callers who
*want* to branch (e.g., the eventual `tools/integrate-1d` arb-prec
mode would advertise both algorithms and pick by integrand-class
inference); the typical caller doesn't read it.

### Working precision = `decimalToBinaryPrecision(prec, 30)`

Same margin as G7K15 BF (ADR-0021). Tanh-sinh has *less*
cancellation pressure than K15's K-G error estimator (which led to
the 30-bit margin in the first place; we inherit the conservative
choice). Deviation could happen at endpoint-singular integrands
where `1 − x_j` cancellation eats precision; v0.1 explicitly defers
that class.

### `(b - a)/2` Jacobian out of the inner loop

Multiplying by the constant `(b-a)/2` at the end (rather than
folding it into each integrand evaluation) is faster — N
multiplications saved across N abscissas — and produces *byte-
identical* results because BigFloat multiplication is associative
in the bit-exact sense at the working precision (modulo a single
final round, which we get either way). Mutation-prove: moving the
factor inside the loop and re-running the suite produces the same
output bytes (there is exactly one fewer rounding event per
evaluation, but the per-evaluation rounding error sits below
working-precision ulp anyway and the running sum is the dominant
ulp source).

## Acceptance

- `packages/quadrature/src/tanh-sinh-bf.ts` shipped (~400-500 LOC
  including the literate prose deriving the algorithm).
- `packages/quadrature/test/tanh-sinh-bf.test.ts` shipped with
  closed-form anchor tests at multiple precisions, bit-determinism
  probes, convergence-flag honesty, and at least one cross-validation
  against `gaussKronrodAdaptiveBF` (where both converge — sin / exp
  on bounded intervals at moderate prec — they should agree to user
  precision).
- `gaussKronrodAdaptiveBF` byte-identical (existing 72 + 30 + 35
  tests pass unchanged).
- `packages/quadrature/src/index.ts` re-exports the new surface.
- `packages/quadrature/README.md` updated in lockstep (add to the
  driver matrix at the top).
- Worklog shard 075.
- `bun run check` green.
- ADR pinned (this file).
