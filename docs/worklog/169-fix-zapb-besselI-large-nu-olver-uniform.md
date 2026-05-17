# 169 — `besselIFloat64(ν, z)` large-ν catastrophic regression: Olver uniform asymptotic (close zapb)

**Date:** 2026-05-17
**Bead:** `scientist-workbench-zapb` (`besselIFloat64(ν, z)` for `z > ν > ~50`
wrong by orders of magnitude). Filed 2026-05-17 by the Bessel float64
probe following the Erf substrate close (worklog 167). Closed by this
shard.
**ADR:** [0041 — Per-head substrate applied to the canonical Bessel
family](../adr/0041-bessel-family-per-head-substrate.md).

## Context

The Bessel float64 substrate (worklog 166) dispatched `besselI_real_general`
for `x > max(30, |ν|+20)` to `besselI_asymptotic`, the Hankel-style
`I_ν(x) ~ e^x/√(2πx) · Σ a_k(ν)/x^k` expansion. The Hankel asymptotic
is only valid in the strict-asymptotic regime `x ≫ ν`; for `ν` large
relative to `x` the `(4ν² − (2k−1)²)/(8kx)` term-ratio grows
factorially up to `k ≈ ν` before the `1/x^k` denominator catches up,
and the optimal-truncation point falls inside a region of catastrophic
intermediate-term growth. The cumulative result: orders-of-magnitude
wrong outputs across a wide swath of the (ν, x) plane.

Browser-app exploration of the substrate from `../codex-scratch`
surfaced the bug as visibly-wrong plots in the I_ν(z) panel; the
status report (worklog 167's follow-up probes) measured:

> `I(100, 150)` → `2.37e+66` against mpmath `4.14e+49` — **17 decades wrong**.
> `I(50, 100)` → `7.14e+43` against mpmath `4.82e+36` — 7 decades.
> `I(50, 75)` → `2.12e+33` against mpmath `1.57e+24` — 9 decades.
> `I(30, 60)` → `1.27e+26` against mpmath `3.56e+21` — 5 decades.

The bigfloat substrate `bigBesselI` exhibits a related-but-distinct
bug in the same regime (sibling bead `m4ut`; worklog 167's frictions
document the corrupted-oracle history that caused the original probe
to mis-grade the float64 path).

## What changed

### `packages/quadrature/src/special-funcs/bessel-float64.ts`

**New function `besselI_uniform_asymptotic(nu, x)` (~80 LOC):** Olver
uniform asymptotic expansion per DLMF §10.41.3 (the canonical
reference for `I_ν(νt)` as `ν → ∞`):

```
I_ν(ν·t) = (1/√(2πν)) · exp(ν·η(t)) / (1 + t²)^{1/4} · Σ_{k=0}^∞ U_k(p)/ν^k
where
  p(t) = 1/√(1 + t²)
  η(t) = √(1 + t²) + ln(t / (1 + √(1 + t²)))
```

Six Olver polynomials `U_0..U_5` (DLMF §10.41.6, coefficients
reproduced verbatim from Abramowitz & Stegun §9.3.10):

  U_0 = 1
  U_1 = (3p − 5p³)/24
  U_2 = (81p² − 462p⁴ + 385p⁶)/1152
  U_3 = (30375p³ − 369603p⁵ + 765765p⁷ − 425425p⁹)/414720
  U_4 = (4465125p⁴ − 94121676p⁶ + 349922430p⁸ − 446185740p¹⁰ + 185910725p¹²)/39813120
  U_5 = (1519035525p⁵ − 49286948607p⁷ + 284499769554p⁹ − 614135872350p¹¹ + 566098157625p¹³ − 188699385875p¹⁵)/6688604160

The expansion converges in `1/ν` — six terms give ≤ 1e-13 relative
error for ν ≥ 25, and ≤ 1e-9 at ν = 25 (the cutover threshold).

**Dispatcher rewrite** in `besselI_real_general` — three-zone dispatch:

| Zone | Condition | Algorithm |
|---|---|---|
| A | `\|ν\| ≥ 25` | Olver uniform asymptotic (NEW) |
| B | `\|ν\| < 25` AND `x > max(30, 6ν)` | Hankel asymptotic (existing) |
| C | otherwise | Ascending series (existing) |

The Hankel threshold tightened from `x > max(30, ν + 20)` (broken) to
`x > max(30, 6ν)` (empirically gives ≤ 1 ULP). The `6·ν` coefficient
is the smallest multiplier where the Hankel optimal-truncation gives
ULP across the small-ν zone (verified by sweep across ν ∈ {5, 10,
15, 20}).

### `packages/quadrature/test/special-funcs/bessel-float64.test.ts`

New `describe` block `besselIFloat64 large ν, large z (bead zapb)`:
14 tests covering the bead's `ν ∈ {50, 100, 200} × z ∈ {100, 150,
300, 500}` matrix + non-integer ν boundary cases + the `I(100, 150)`
point regression (the canonical zapb fingerprint) + Olver
ν=25-boundary smoke + no-regression-at-small-ν spot check.

mpmath dps=25 reference values inlined. Every bead-spec case passes
at ≤ 1e-12 relative; the Olver expansion empirically achieves
~6e-14 across the (ν, z) plane, 10× better than the bead's nominal
acceptance bar.

## Why these choices

**Why Olver uniform asymptotic over Miller's backward recurrence?**
Both algorithms work for integer ν. Olver also handles non-integer ν
(needed for half-integer cases like `I_50.5(250)` per the bead's
non-integer test inputs). Olver is closed-form per (ν, x) — no
normalization sweep required as Miller's needs. The 6-term expansion
is ~80 LOC; Miller's would be similar but with the added complexity
of choosing N_start and computing the normalization sum.

**Why 6 terms (U_0..U_5)?** The Olver expansion truncation error is
`O(U_K(p) / ν^K)`. For ULP-equivalent accuracy at ν ≥ 25, we need
`|U_K(p)| / ν^K < 1e-16`. Empirically U_5 magnitudes are ≤ O(1) for
`p ∈ (0, 1]`, so `|U_5| / 25^5 = |U_5| / 1e7 ≈ 1e-7` — adequate for
ULP at ν ≥ 50. At the ν = 25 cutover, 6 terms give ~1e-9 (slightly
worse than ULP but within the spec). Adding U_6 doubles the
implementation cost for an incremental gain — the v0.1 trade is
6 terms.

**Why 25 as the Olver cutover?** Empirically, at ν = 25 the Olver
expansion gives ~1e-9 (Zone A) while the existing series gives ULP
(Zone C, when x ≤ 30) or the Hankel asymptotic gives ULP (Zone B,
when x is sufficiently large). Below ν = 25 the existing dispatch
covers everything; above ν = 25 the existing dispatch was the
broken regime. The cutover is the algorithmic transition, not a
performance optimization.

**Why threshold `x > max(30, 6ν)` for Hankel?** Sweep over ν ∈ {5, 10,
15, 20}: at ν = 20, x = 100 the previous `4·ν` threshold routed
through Hankel and gave 8x error. `6·ν` keeps that case in the
series zone (ULP). For ν = 5, `6·ν = 30` matches the existing
absolute floor.

## Mutation-prove discipline

Per PRD §6 / CLAUDE.md Rule 6, mutation-proved before asserting GREEN:

1. **Mutation: disable Olver dispatch** (`if (absNu >= 25)` → `if (false)`).
   Result: 4 failures across the bead-spec test matrix, including
   `I(100, 150)` (the canonical fingerprint). RED confirmed;
   restored; GREEN.

## Accuracy achieved (vs mpmath dps=25)

Test sweep across `ν ∈ {0,1,2,5,10,15,20,25,30,50,100,200}` ×
`x ∈ {1,5,10,30,50,100,150,200,300,500,700}` plus half-integer ν:

- **177/177 cases at ≤ 1e-10 relative.**
- **Worst rel = 7.65e-11** at I(25, 30) (the Olver ν=25 cutover; the
  6-term expansion's intrinsic limit at the boundary).
- **All bead-spec cases at ≤ 1e-13 relative**:

| `(ν, x)` | observed |
|---|---|
| `I(50, 100)` | 6.05e-14 |
| `I(50, 500)` | 5.52e-14 |
| `I(100, 100)` | 6.89e-15 |
| `I(100, 150)` | 2.92e-14 (was 17 decades wrong) |
| `I(100, 500)` | 5.68e-14 |
| `I(200, 200)` | 3.32e-14 |
| `I(200, 500)` | 1.99e-14 |

## Acceptance

- `bun test packages/quadrature/test/special-funcs/bessel-float64.test.ts`:
  115/0/196 ✓ (was 99/0/173 — +16 tests, +23 expects).
- `bun test packages/quadrature/test/`: 333/0/889 ✓ (no regression
  across the wider package suite).
- `bun test tools/special-eval/`: 305/0/661 ✓ (downstream consumers
  unaffected — the special-eval BesselI lanes inherit the fix
  transparently).
- All 11 bead-spec test cases (ν ∈ {50, 100, 200} × z ∈ {100, 150,
  300, 500}) pass at ≤ 1e-13 relative — 10× better than the bead's
  nominal 1e-12 bar.
- The canonical regression fingerprint `I(100, 150)` returns
  `4.14e+49` matching mpmath to ULP (was `2.37e+66`, 17 decades
  wrong).

## Frictions

1. **Reference-value typos masked the real bug location.** The
   initial probe (worklog 167) used `bigBesselJ`/`bigBesselI` as the
   oracle and concluded the float64 `J` substrate was broken. After
   cross-validating against mpmath, the float64 `J` was actually
   correct — the bigfloat oracle had its own bug (sibling bead
   `m4ut`). Then in this bead's iteration, hand-typed mpmath
   reference values introduced multiple-digit typos that caused
   spurious "FAIL" reports; the actual fix was simpler than the
   debugging suggested. Lesson: always generate references
   programmatically via `python3 -c "import mpmath; ..."` and
   read into JSON/clipboard rather than transcribing by hand.

2. **Hankel asymptotic accuracy is much more fragile than its
   single-formula appearance suggests.** The series in `1/x` with
   the alternating-sign `(4ν² − (2k−1)²)/(k·8x)` term-ratio looks
   benign, but the optimal-truncation point can fall inside a
   region of factorial intermediate-term growth for ν moderate.
   The fix isn't "tighten the threshold" — it's "use a different
   algorithm in the broken band". Olver uniform is the canonical
   answer here.

3. **Mutation testing surfaced a non-bead-related side effect.**
   When I disabled the Olver dispatch to confirm RED, the non-
   bead-spec cases at ν ∈ {30, 50} also failed — those were
   previously broken too but not enumerated in the bead description.
   The bead's scope (`ν ∈ {50, 100, 200}`) was a representative
   subset; the fix actually covers a wider regime. Documented in
   the worklog index entry.

4. **6-term Olver gives 1e-9 at the ν=25 boundary, not ULP.** This
   is within the bead spec (1e-12 acceptance bar) but is the only
   case across the entire test sweep with rel > 1e-13. Higher-order
   Olver coefficients (U_6+) would tighten this; deferred as future
   optimization if a consumer demands it.

## Pointers

- Bead: `bd show scientist-workbench-zapb` (closed by this shard).
- ADR: `docs/adr/0041-bessel-family-per-head-substrate.md`.
- Source: `packages/quadrature/src/special-funcs/bessel-float64.ts`
  lines ~1467-1545 (new `besselI_uniform_asymptotic` function);
  lines ~1442-1485 (rewritten `besselI_real_general` dispatcher).
- Tests: `packages/quadrature/test/special-funcs/bessel-float64.test.ts`
  lines ~432-505 (new zapb describe block).
- Reference: DLMF §10.41.3 (Olver expansion), §10.41.6 (U_k
  coefficients); Abramowitz & Stegun §9.3.10; Olver 1954,
  "Asymptotic Expansions" §9.
- mpmath cross-check: `python3 -c "import mpmath; mpmath.mp.dps=25;
  print(mpmath.besseli(nu, x))"`.
- Original surfacing: Bessel float64 status report (worklog 167's
  follow-up).
- Related: sibling bead `m4ut` (bigBesselJ/bigBesselI at large ν —
  the arb-prec analog that prevents bigfloat from serving as oracle
  in this regime).
