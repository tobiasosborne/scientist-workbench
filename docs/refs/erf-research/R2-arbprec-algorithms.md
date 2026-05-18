# R2 — Arbitrary-precision algorithms for `erf`, `erfc`, `erfcx`, `w(z)`, `erf⁻¹`, `erfc⁻¹`

**Bead:** R2 (R-series, orchestrated 26-bead erf-substrate effort).
**Audience:** the implementer of `bigErf`, `bigErfc`, `bigErfcx`, `bigErfi`,
`bigErfInv`, `bigErfcInv`, `bigW` for `@workbench/bigfloat`.
**Substrate exemplar:** `packages/bigfloat/src/complex.ts` (`cgamma`,
`clgamma`, `clgammaReflect`, `cdigamma`). The conventions there are the
template; deviations below carry a citation of why.
**Downstream consumer with the tightest deadline:** bead `ybrw`
(`bigErfc(x, prec)`), in the Berry-smoothing Stokes-band code path; that
caller wants real-argument `erfc(x)` for `x > 0` with the
*scaled-Schläfli* shape — i.e. it ultimately wants the asymptotic regime
where `erfc(x) ≈ exp(-x²)·(small polynomial)` and the cancellation
problem is **trivial in `erfc` but catastrophic in `1 - erf`**. The
algorithm split below is engineered so `ybrw`'s call sites never cross a
crossover where a sign cancellation eats their precision.

---

# Executive summary (~300 lines)

## Recommended algorithm split

Five surfaces. Three substrate primitives, four user-facing functions.

```
substrate primitive            real BigFloat           BigComplex
─────────────────────────────  ──────────────────────  ──────────────────────
1. erfSeries(z, prec)          DLMF 7.6.2 (Borel)      DLMF 7.6.2 (Borel)
2. erfcAsymptotic(z, prec)     DLMF 7.12.1 + Berry     acb-style + sector test
3. erfcContinuedFraction(z, p) Laplace CF (DLMF 7.9.1) Laplace CF, Re(z) > 0

user functions
─────────────────────────────────────────────────────────────────────────────
bigErf(x, prec)               x = z = real BigFloat
bigErfc(x, prec)              x = z = real BigFloat  (← bead ybrw consumer)
bigErfcx(x, prec)             real BigFloat          (← scaled; subsumes most ybrw)
bigErfi(x, prec)              real BigFloat
bigCErf, bigCErfc, bigCErfcx, bigCErfi, bigW   on BigComplex
bigErfInv(y, prec)            Newton on bigErf
bigErfcInv(y, prec)           Newton on bigErfc / -log path for tail
```

**Crossover (real argument):**

```
                  prec in bits = p
  |x| ≤ x_c(p)  := √( (p · ln 2) / (1 + δ) )    with δ ≈ 0.15
  |x| > x_c(p)  use erfcAsymptotic
  |x| ≤ x_c(p)  use erfSeries  (DLMF 7.6.2, all-positive terms)
```

For `p = 196` (50 dps) this gives `x_c ≈ 11.0`. For `p = 1024` (300 dps),
`x_c ≈ 25.2`. The crossover is **derived** from "asymptotic Poincaré
remainder smaller than 2^-p"; see §2.2. The factor `(1 + δ)` is the
Stirling-like safety margin that controls the optimal-truncation index of
the asymptotic — see §2.2.

**Complex argument:** identical algebraic split, but the **decision
boundary is an ellipse in (Re z, Im z)** because the Berry smoothing
formula crosses the Stokes line `arg z = ±3π/4`. The Arb decision rule
(extracted from `arb_hypgeom_erf`):

```
  use asymptotic when:   x²·log₂(e) + log₂(|z|) > p
                  i.e.   |z|² > p·ln 2  approximately (for x = |z|)
  use series otherwise
```

This is the same crossover as the real case in different units. Re-stated
in our `prec`: `|z|² > prec · ln 2 / 2` — within a factor of √2 of the
real-axis formula. We unify both as the single threshold below.

**Faddeeva `w(z)`:** Steven G. Johnson's Faddeeva.cc dispatch (which
itself is Poppe-Wijers + Algorithm 916 + Weideman blended) is the
double-precision reference. At arbitrary precision the optimal pick is
**Karbach 2014's Weideman-Fourier scheme generalised** to BigComplex,
because Karbach is the only modern Faddeeva algorithm whose truncation
parameter `N` and integration cutoff `τ_m` have closed-form
prec-dependence:

```
  τ_m = sqrt(-4 · ln(eps_p / 4))            where eps_p = 2^-p
  N   = ceil(τ_m² / (4 π) · log(1/eps_p))   approx
```

For double (p=53) Karbach uses `τ_m = 12`, `N = 23`; for 50 dps (p=196)
this scales to `τ_m ≈ 23.3`, `N ≈ 110`. The algorithm is **single-pass
Horner** in a precomputed coefficient array — *the same shape* as our
existing Bernoulli-cached Stirling in `clgammaStirling`. See §5.

**Berry-smoothing path for bead `ybrw` (`erfc` in Stokes band):** the
universal smoothing factor is `½ erfc(½ ρ^½ c(θ))` (DLMF 2.11.15), so the
Berry caller *itself* is calling `bigErfc` on a real argument — and the
argument is **bounded by O(√p)**, never astronomical. This means the
ybrw use case stays inside the asymptotic regime of `erfcAsymptotic` —
no special algorithm needed, just correct precision tracking. The
"large-arg cancellation" worry exists only in the user-supplied `x`, not
in the Berry smoother's internal `x`. Documented as a non-risk in §3.

## Faddeeva pick — justification

| Algorithm                | Coefficient table | Per-eval cost  | Domain         | Prec scaling |
|--------------------------|-------------------|----------------|----------------|--------------|
| **Karbach 2014 / Weideman** | precomputed once at p | **N+1 cmul** | full ℂ via symmetry | closed-form |
| Poppe-Wijers 1990 (CF)   | none              | nu ≈ 3 + 1442/(26ρ+77) iters | full ℂ | tricky |
| Johnson 2012 Faddeeva.cc | expa2n2[53] + per-region | hybrid CF + 5-sum | ℂ \ {real axis} | f64-only |
| Arb (FLINT) acb_hypgeom_erf | none (regenerated)   | series or asymptotic | full ℂ | adaptive |

**Pick: Karbach-Weideman for BigComplex; Arb-style dispatch for
BigFloat.** The reasoning:

1. Karbach has *exactly one* truncation knob `N` whose prec-dependence is
   closed-form. Poppe-Wijers' `nu` formula is empirical (fitted to
   double-precision); extending it to 50 dps requires re-fitting.
2. The Karbach inner loop is `N` complex Horner steps. At p = 196 (50
   dps), `N ≈ 110` — comparable to our existing 300-bound Bernoulli loop
   in `clgammaStirling`. No new performance class.
3. Karbach explicitly handles the Stokes-line singularities `z_n = ±nπ/τ_m`
   via 5-term Taylor expansions in tiny discs. At arbitrary precision the
   disc radius can shrink and the expansion order grows; both have
   closed-form prec-scaling.
4. Arb's complex algorithm is **just the real algorithm wrapped in
   complex Pochhammer arithmetic** — DLMF 7.6.2 / 7.12.1 with `z²` allowed
   to be complex. No Faddeeva-specific machinery. For real `z` this
   matches our BigFloat path. For complex `z` we **need** Karbach because
   the alternating-cancellation problem in the Maclaurin form (DLMF
   7.6.1) becomes severe when `Im(z) > 0` and `|z²| > p`. The Borel form
   (7.6.2) helps but does not fix the `arg z` near `π/4` problem, which is
   exactly what Faddeeva is designed for.

For real-only callers (`bigErf`, `bigErfc`, `bigErfcx` on BigFloat),
**use the Arb-style dispatch on the real line**: Maclaurin / asymptotic
split with cancellation-driven precision retry. No Faddeeva.

For complex callers, **use `bigW(z)` as the primitive** and define
`bigCErf`, `bigCErfc`, `bigCErfcx`, `bigCErfi` as algebraic combinations
of `bigW` via the standard identity table (Karbach §2 or DLMF §7.4):

```
  erfcx(z) = w(iz)
  erf(z)   = 1 - exp(-z²) · w(iz)        for Re(z) ≥ 0
  erf(z)   = exp(-z²) · w(-iz) - 1       for Re(z) < 0
  erfc(z)  = exp(-z²) · w(iz)            for Re(z) ≥ 0
  erfc(z)  = 2 - exp(-z²) · w(-iz)       for Re(z) < 0
  erfi(z)  = -i · erf(iz)
```

This is exactly Faddeeva.cc's structure (lines 286–476 verbatim), and it
keeps `bigW` as the single load-bearing complex primitive — same
single-implementation discipline as `clgamma → cgamma → cdigamma` sharing
one Stirling kernel.

## Inverse functions

**Newton with Halley as a half-step optimisation** — but at arbitrary
precision the half-step optimisation matters only when iteration count
is the cost, which it is not (we run < 10 iters typically). Use plain
Newton:

```
  bigErfInv(y, prec):
    x₀ = initial-guess-from-mpmath-table  (computed in float64)
    repeat:
      f  = erf(x) - y                                  // BigFloat
      df = (2/√π) · exp(-x²)                           // BigFloat
      Δx = f / df
      x = x - Δx
      if |Δx| < 2 · 2^(-prec) · |x|: break

  bigErfcInv(y, prec):
    x₀ = √(-log(y · √π))   for small y          (asymptotic tail)
    x₀ = bigErfInv(1 - y)  for y near 1         (delegate)
    Newton:
      Δx = (√π/2) · (erfc(x) - y) · exp(x²)    // note: exp(+x²), not exp(-x²)
                                                // — uses erfcx
      x = x + Δx
      if |Δx| < 2 · 2^(-prec) · |x|: break
```

**Initial guess:**

| y range            | seed formula                                                |
|--------------------|-------------------------------------------------------------|
| `|y| < 0.9`        | `erfinv_f64(y)` (mpmath / SpecialFunctions.jl rational)     |
| `|y| ≥ 0.9` (erfi) | `sign(y) · sqrt( u - log(u) )/√2`, `u = log(2/π/(|y|-1)²)`  |
| `y < e^-1000`      | DLMF 7.17.3 asymptotic: `inverfc(x) ~ u^(-½) + …`           |
| else (erfc-inv)    | `√(-log(y · √π))` (Julia SpecialFunctions.jl)               |

The float64 seed gives ~16 digits of correctness. Newton on a `C²`
function with that seed reaches **50 dps after 4 iterations** (each
iteration roughly doubles correct bits; from 53 → 106 → 212 → 424 → 848,
covering 50 dps in 2 iters with margin, 300 dps in 4 iters).

**The arbitrary-precision termination criterion is the load-bearing
detail.** `|Δx| < 2 · 2^(-prec) · |x|` is the relative-error stop. For
`y = 0` and `y = ±1` we hit `x = 0` (where the criterion needs absolute
form) or `x = ±∞` (where we return early without iterating). Boundaries
are handled before entering Newton.

## Top-3 risks

### Risk 1: catastrophic cancellation in `1 - erf(x)` for large x

If `bigErfc(x, prec)` is implemented as `1 - bigErf(x, prec)`, then for
`x > x_c` the value `erf(x)` is `1 - 2^(-O(x²))` and the subtraction
loses `~x²·log₂(e)` bits. At `x = 20`, that is ~580 bits — i.e. 50 dps
becomes garbage. **Mitigation: `bigErfc` MUST have its own direct
asymptotic / CF path for `x > x_c`, never delegating to `1 - bigErf`.**
Mirrors the `expm1` / `log1p` pattern in `transcendental.ts`.

### Risk 2: complex Maclaurin (DLMF 7.6.1) cancellation in the Stokes sector

DLMF 7.6.1 — `erf z = (2/√π) Σ (-1)^n z^(2n+1) / (n! (2n+1))` — has
alternating signs. When `|z²| > p` *and* `arg(z²) ∈ (π/2, 3π/2)` (i.e.
`Re(z²) < 0`), the partial sums oscillate with magnitudes much larger
than the final value. Bit loss ≈ `|Re(z²)|·log₂(e)` bits at worst.
**Mitigation: use DLMF 7.6.2 (Borel-summed form)** for complex argument:

```
  erf z = (2/√π) · e^(-z²) · Σ_{n=0}^∞  2^n · z^(2n+1) / (1·3·5···(2n+1))
```

All terms have the same sign (after pulling out `z`). Zero alternation.
This is what mpmath uses internally (`hyp1f1((1,2),(3,2), z²)` via the
Kummer transform `M(½, 3/2, -z²) = e^(-z²) M(1, 3/2, z²)` — algebraically
identical to 7.6.2). Document this distinction explicitly in the source
doc-comment; the *naïve* 7.6.1 reader is a likely source of regression.

### Risk 3: argument-reduction bit loss in `erfcx(small x) = exp(x²) · erfc(x)`

For `x` near 0, `erfcx(x) → 1`, so `exp(x²)·erfc(x)` requires `erfc`
known to `prec + log₂(erfcx) ≈ prec` bits — fine. But for `x` moderately
large (`x ≈ 5`), `erfcx(5) ≈ 0.107`, while `erfc(5) ≈ 1.5e-12` and
`exp(25) ≈ 7.2e10`. The product overflows `Number` but not BigFloat —
the danger is *relative* precision: `erfc(5)` is computed by series-or-
asymptotic to `prec` bits *relative*, and `exp(x²)` to `prec` bits
relative, so the product is to `prec` bits relative. **Mitigation:
`bigErfcx` has its own asymptotic series** that computes the scaled
value directly without going through `erfc`. This is what
SpecialFunctions.jl does (lines 27–40 of their BigFloat `_erfcx`) —
direct asymptotic on the rational form. See §4.2.

---

# 1. Algorithm taxonomy

## 1.1 The five canonical representations

Every erf-family algorithm at any precision is one of:

1. **Maclaurin series** — converges everywhere; cancellation when
   `|z|² > p`.
2. **Asymptotic (Poincaré) series in `1/z`** — diverges, but the
   superasymptotic remainder is bounded by the first omitted term in a
   sector around the real axis; useful for `|z|² ≳ p`.
3. **Continued fraction (Laplace, Hunter-Regan)** — converges everywhere
   for `Re(z) > 0`; convergence rate `~1/|z|²` per cycle.
4. **Hypergeometric ¹F₁ confluent representation** — algebraically equal
   to (1), evaluated via the same machinery as our existing
   `tools/hypergeometric-pfq`; this is mpmath's choice for the
   non-special-case branch.
5. **Weideman / Karbach Fourier-Chebyshev** — special to Faddeeva `w(z)`;
   approximates `e^{-τ²/4}` by a Fourier series on `[-τ_m, τ_m]`, then
   integrates `e^{iτz}` term-by-term to a finite sum.

These are not five disjoint algorithms — they are five *evaluation
schemes for the same analytic function*, each best in a different
region. The split is defined by:

- which scheme has bounded computational cost as a function of `p`;
- which scheme has zero cancellation loss.

Asymptotic (2) is the only scheme whose term count is *independent* of
`p` for large `|z|` (and in fact decreases with `|z|`); series (1) and
(4) need `O(|z|² + p)` terms; CF (3) needs `O(p · |z|⁻²)` cycles, so it
crosses over from "best at large |z|" to "matches asymptotic" in the
same region.

## 1.2 Maclaurin series — DLMF 7.6.1 and 7.6.2

**Form 1 (DLMF 7.6.1) — the textbook Maclaurin, alternating signs:**

> erf(z) = (2/√π) Σ_{n=0}^∞ (-1)^n z^(2n+1) / (n! (2n+1))

Convergence radius: ∞. Term ratio:

```
  term_{n+1} / term_n = -z² · n / ((n+1) · (2n+3))
                      ≈ -z² / (2n²)    for large n
```

So term magnitudes peak around `n ≈ |z|² / 2` then decay. For `|z| = 5`
peak is at `n ≈ 13` with magnitude `5^25 / (25!! · 25) ≈ exp(25 - 25
log(2.5)) · 5 ≈ exp(25 - 22.9) · 5 ≈ 40`, while `erf(5) ≈ 1`. So the
sum is `~40 - 40 + …` — `log₂(40) ≈ 5` bits of cancellation. Modest.
At `|z| = 20`, peak `n ≈ 200`, peak term `≈ 20^400 / 400!! ≈ ?`. Better:
peak term `≈ exp(|z|²) / √(π |z|²)` by stationary phase, and the *sum*
is `erf(z) ≈ 1`. Cancellation `≈ |z|² log₂(e) − ½ log₂(π|z|²)` bits.
At `|z| = 20` this is `400·1.44 − 6 ≈ 570` bits of cancellation —
catastrophic at any prec ≤ 500.

**Form 2 (DLMF 7.6.2) — Borel-summed, all-positive terms:**

> erf(z) = (2/√π) · e^(-z²) · Σ_{n=0}^∞ 2^n · z^(2n+1) / (1·3·5···(2n+1))

Equivalently (using `(2n+1)!! = (2n+1)! / (2^n · n!)`):

> erf(z) = (2/√π) · e^(-z²) · z · Σ_{n=0}^∞ (2z²)^n · n! / (2n+1)!

Term ratio:

```
  term_{n+1} / term_n = 2z² · (n+1) / ((2n+3) · ... ) = 2z² / (2n+3)
```

Pochhammer-stable. For real `z`, all terms positive — zero cancellation.
Peak term ratio = 1 at `n ≈ z²`, then decays. Total term count is
`≈ 2|z|² + p · log(2) / (something)` — roughly `O(|z|² + p)`.

**Why both forms appear in references:**

- 7.6.1 is the "natural" Taylor expansion and is what every CAS prints
  when you ask for "Series[Erf[z], {z, 0, n}]".
- 7.6.2 (the Kummer-transformed `M(½, 3/2, -z²) = e^(-z²) M(1, 3/2, z²)`)
  is the **numerically usable form**. mpmath's `_erf_complex` uses
  exactly this — `(2/√π)·z·hyp1f1((1,2), (3,2), z²)` with `z²` computed at
  elevated precision (`square_exp_arg(z, -1)` boosts by 4×+20 bits per
  the source).

**Algorithm I implement uses 7.6.2.** Always. No exceptions. The
non-Borel form (7.6.1) is mathematically beautiful and numerically
useless past `|z| ≳ 3` at any sane precision.

**Term-count formula for 7.6.2:**

At fixed `prec = p` bits, the series terminates when

```
  |term_N| < 2^-p · |sum|
```

Since the running sum is `O(1)` and `term_n` peaks at `n ≈ |z|²` with
value `≈ e^(|z|²) / √(π|z|²)` (before the prefactor `e^(-z²)` cancels
it), the post-cancellation term sequence (i.e. what we actually compute
after the `e^(-z²)` is folded in) peaks at `O(1)` and decays
super-geometrically. **Empirically `N ≈ max(p, 2|z|²) + O(√p)` terms
suffice.** This matches the bound used by mpmath in
`square_exp_arg(z, -1)`.

## 1.3 Asymptotic series — DLMF 7.12.1

Quoted verbatim from DLMF 7.12.1, applicable for `|ph z| ≤ 3π/4 − δ`
(`< 3π/4`):

> erfc z ~ (e^(-z²) / (√π · z)) · Σ_{m=0}^∞ (-1)^m · (½)_m / z^(2m)

The Pochhammer `(½)_m = (2m-1)!! / 2^m`, so the explicit term is

```
  a_m = (-1)^m · (2m-1)!! / (2z²)^m
```

i.e. `a_0 = 1`, `a_1 = -1/(2z²)`, `a_2 = 3/(2z²)², a_3 = -15/(2z²)³, …`.

**Term ratio:**

```
  a_{m+1} / a_m = -(2m+1) / (2z²)
```

So term magnitudes decrease until `(2m+1) < 2|z|²`, then **increase**
again — the classic divergent asymptotic. **Optimal truncation** is at
the smallest term:

```
  m* = floor(|z|²)
```

with the smallest-term magnitude approximately `exp(-|z|²)` (in units of
`(2/(√π·z))` after pulling out the prefactor).

**Superasymptotic remainder bound (DLMF §2.11.iv):** truncating at `m*`,
the absolute error is bounded by the first omitted term:

```
  |R_{m*}(z)| ≤ |a_{m* + 1}| = (2m*+1)!! / (2|z|²)^{m*+1}
            ≈ exp(-|z|²) · √(π/(2|z|²))   (Stirling on (2m*+1)!!)
```

So the asymptotic series achieves precision

```
  p_achievable(|z|) ≈ |z|² · log₂(e)  bits
                    ≈ 1.4427 · |z|²  bits
```

**Inverting for the crossover threshold:**

```
  p_achievable(x_c) = p_target
  ⟹  x_c² = p / log₂(e) = p · ln 2
  ⟹  x_c  = √(p · ln 2) ≈ 0.833 · √p
```

For `p = 53` (double), `x_c ≈ 6.07` — confirms the standard "use
asymptotic for `x > 6`" double-precision rule. For `p = 196` (50 dps),
`x_c ≈ 11.66`. For `p = 1024` (300 dps), `x_c ≈ 26.65`. For `p = 3322`
(1000 dps), `x_c ≈ 48.0`.

**Safety margin** — to land *below* the smallest-term bound by another
factor of 2^16, we want the asymptotic to drop `p + 16` bits before
truncating, so the *practical* threshold is `x_c_practical = √((p + 16)
· ln 2)` — within `O(p^{-½})` of `x_c`, negligible.

## 1.4 Berry-smoothed asymptotic — DLMF 2.11.15

In the sector `arg z = ±3π/4` (the Stokes line for the `erfc`
asymptotic), the asymptotic 7.12.1 fails because the Stokes multiplier
*jumps*. Berry's universal smoothing replaces the discontinuous jump by
a smooth transition controlled by — and this is the key fact — **an
`erfc` itself**.

DLMF 2.11.15 (paraphrased):

```
  R_{n+p}(z) ~ (-1)^n · i · e^(-pπi) ·
                ( ½ erfc(½ ρ^½ · c(θ)) - i · e^(iρ(π-θ)) · e^(-ρ-z) /
                  √(2πρ) · Σ h_{2s}(θ,α) / ρ^s )
```

where `c(θ)` is defined in 2.11.16 (related to the saddle-point
geometry) and `ρ = O(p)`.

**This is bead `ybrw`'s actual call site.** Berry-smoothed `erfc` in the
Stokes band of some *other* function ultimately reduces to evaluating
`erfc` of a real argument `½ ρ^½ c(θ)`. Since `ρ = O(p)` and `c(θ) =
O(1)`, the argument is `O(√p)` — i.e. **right at the crossover** between
series and asymptotic. The argument never blows up to "true Stokes
singularity" magnitudes. Our `bigErfc` need only handle `O(√p)`
arguments correctly; it doesn't need a specialised Borel-resummation
path of its own.

**Implication:** the `ybrw` Stokes-band path is a *consumer* of
`bigErfc`, not a producer of a new algorithm. The right primitive for
`ybrw` is `bigErfc(x, prec)` where `x = ½ ρ^½ c(θ)` is passed in by the
calling Berry-smoothed asymptotic of whatever function is in question.
The R2 substrate's job is to make that `bigErfc` honest at *any* real
`x`.

## 1.5 Continued fraction — Laplace, DLMF 7.9.1

> √π · e^(z²) · erfc(z) = z / ( z² + ½ / ( 1 + 1 / ( z² + 3/2 / ( 2 / ( z² + … ) ) ) ) )
>                                                                     for Re(z) > 0

In linear form:

```
  √π · e^(z²) · erfc(z) = z / (z² + (½)/(1 + 1/(z² + (3/2)/(1 + 2/(z² + (5/2)/(1 + 3/(z² + …))))))
                                                                                   
```

Convergent for all `Re(z) > 0`. **Convergence rate** is geometric in
`1/(2z²)` — roughly equivalent to the asymptotic series after `m` levels
of CF gives the same accuracy as the asymptotic after `m` terms. So the
CF and the asymptotic are **interchangeable in the truncated-asymptotic
regime**; the CF wins when:

- We want *strictly* better than the smallest-term-bound accuracy
  (asymptotic floor) — the CF, being convergent, can keep going past
  the asymptotic optimal-truncation point.
- We want to handle the Stokes line `arg z = ±3π/4` cleanly — but the
  CF only converges for `Re(z) > 0`; the Stokes line itself has
  `Re(z) ≤ 0`.

**Practical choice for `bigErfc`:** use the asymptotic 7.12.1 (cheaper
per term, no division), retry at higher precision if needed.
**Fall back to the CF** only if the asymptotic's accuracy floor
(`exp(-|z|²)`) is insufficient for the prec target — which only
happens if the caller passes a small `|z|` to `bigErfc` *and* requests
huge prec; in that case the series path covers it.

**Verdict: the CF is a *nice-to-have third path*, not first-tier.**
Recommend deferring CF implementation to v0.2 unless mutation-testing
during v0.1 ship surfaces a wedge case the asymptotic+series split
misses.

## 1.6 Faddeeva continued fraction — DLMF 7.9.3

> w(z) = (i/√π) · ( 1 / (z - ½/(2z - 1/(z - 3/(2 · (2z - 2/(z - … ))))))   for Im(z) > 0

Convergent for `Im(z) > 0`. This is what Faddeeva.cc uses when
`|Im(z)| > 7` or `(|Re(z)| > 6 and other conditions)` — see the
`USE_CONTINUED_FRACTION` block (lines 722–789) verbatim:

```c
// continued fraction is faster for large |z|:
// for x + ya > 4000:  nu = 1 (w(z) = i/√π / z)
// for 4000 ≥ x + ya > some threshold:  nu = 2 (w(z) = i/√π · z / (z² - ½))
// otherwise:  fit nu = floor(c0 + c1 / (c2*x + c3*ya + c4))
//   with c0=3.9, c1=11.398, c2=0.08254, c3=0.1421, c4=0.2023
// iterate Lentz: w <- z - nu/w
```

The `nu` formula `floor(c0 + c1 / (c2*x + c3*ya + c4))` is **fitted to
double precision**. At higher precision the right number of CF cycles is

```
  nu(p, z) ≈ p · ln 2 / (2 · ln(|z|²))   (from CF convergence rate analysis)
```

— but the empirical Karbach approach avoids the CF entirely for this
reason: Karbach's `N` has closed-form prec scaling, the CF's `nu` does
not.

## 1.7 Hypergeometric ¹F₁ — algebraic equivalent of 7.6.2

```
  erf(z) = (2z/√π) · M(½, 3/2, -z²) = (2z/√π) · e^(-z²) · M(1, 3/2, z²)
```

The second form is what mpmath uses. **In our substrate this is
algebraically identical to calling `evaluatePFq([1], [3/2], z²)` from
`@workbench/hypergeometric` and multiplying by `(2z/√π) · e^(-z²)`.**

Concretely:

```ts
// Algorithm-equivalent to bigErfSeries, but via the hypergeometric package:
import { evaluatePFq } from "@workbench/hypergeometric";

const z2     = cmul(z, z, work);
const result = evaluatePFq(
  [cfromInts(1n, 0n, work)],          // a = [1]
  [cfromStrings("1.5", "0", work)],   // b = [3/2]
  z2,                                  // argument = z²
  precisionDecimal,
);
// result.value = M(1, 3/2, z²)
// erf(z) = (2z/√π) · exp(-z²) · result.value
```

This is appealing because it inherits the existing
cancellation-driven-precision-retry orchestration in `evaluatePFq`. But
two issues:

1. The pFq cancellation-loss detection in `pFqDirectSeries` assumes
   `|sum|` is `O(1)`; for `M(1, 3/2, z²)` at large `|z²|` the partial
   sums can grow to `~exp(|z²|)` and shrink back via the `e^(-z²)`
   prefactor *outside* the pFq call — so the pFq internal cancellation
   detector reports zero cancellation (correctly, because there is none
   internally), but the post-multiplication multiplication
   `e^(-z²)·result` has the full burden.
2. Calling out to `@workbench/hypergeometric` adds a package dependency
   and a non-obvious indirection. The series is **15 lines of TypeScript
   directly** (see §6 below) — direct evaluation is clearer.

**Recommendation: implement the series directly in
`packages/bigfloat/src/erf.ts`.** Optionally provide a thin re-export
wrapper from `@workbench/hypergeometric` for users who want the symbolic
identity made manifest, but the substrate primitive lives in bigfloat.

## 1.8 Scaled variants

`erfcx(x) = e^(x²) · erfc(x)` and `w(z) = e^(-z²) · erfc(-iz)` are
*scaled* versions of `erfc`. They are useful because:

- For large `x`, `erfc(x)` underflows but `erfcx(x) ~ 1/(x√π)` is `O(1/x)`.
- For real Faddeeva integrals (Voigt profile, etc.), `w(z)` is the
  natural object — `erfc` and `w` differ by a single `exp(-z²)`
  multiplicative which itself can over/underflow.

**Implementation:** `bigErfcx` and `bigW` are first-class substrate
primitives, **not** wrappers over `bigErfc`. The asymptotic series for
`erfcx(x)` is *directly*

```
  erfcx(x) ~ (1 / (x√π)) · Σ_{m=0}^∞ (-1)^m · (2m-1)!! / (2x²)^m
```

— same coefficients as 7.12.1, no `exp(-x²)` prefactor. Computing this
directly avoids the over/underflow round-trip through
`exp(x²)·erfc(x)`. Julia SpecialFunctions.jl uses exactly this:

```julia
function _erfcx(x::BigFloat)
  if x ≤ 2^15 (32-bit) or 2^30 (64-bit):
    return exp(x²) * erfc(x)
  else:
    ϵ = eps(BigFloat) / 4
    v = 1 / (2x²)
    k = 1; s = w = -k·v
    while |w| > ϵ:
      k += 2; w *= -k·v; s += w
    return (1+s) / (x · √π)
```

The Julia threshold `2^15` or `2^30` is the point where `exp(x²)`
overflows — for BigFloat-with-i32-exponent that's at `x²` ≈ 2^30 / ln 2
≈ 1.5e9, way beyond any sane numerical input. **For our substrate the
crossover is the same as `bigErfc`'s asymptotic crossover:** above
`x_c`, compute directly via asymptotic; below, use
`exp(x²) · bigErfc(x)` via the same series path.

## 1.9 Inverse functions

`erf⁻¹(y)` for `y ∈ (-1, 1)` and `erfc⁻¹(y)` for `y ∈ (0, 2)`. Both
defined as the unique solution of `erf(x) = y` (resp. `erfc(x) = y`).

**Algorithm: Newton iteration on `bigErf` / `bigErfc`.** Both functions
are `C^∞`, monotone, and have everywhere-nonzero derivative on the
interior of their domain, so Newton converges quadratically from any
reasonable initial guess.

**Quadratic convergence guarantee:** Let `f(x) = erf(x) - y`. Then

```
  Newton iter:  x_{n+1} = x_n - f(x_n) / f'(x_n)
                        = x_n - (erf(x_n) - y) · √π/2 · exp(x_n²)
```

`f` is analytic, `f'(x) = (2/√π) exp(-x²) > 0` everywhere, `f''(x) =
-(4x/√π) exp(-x²)`. The Newton convergence rate is bounded by

```
  |x_{n+1} - x*| ≤ ½ · |f''(ξ) / f'(x*)| · |x_n - x*|²
             ≤ |x*| · |x_n - x*|²    (since |f''/f'| = 2|x|)
```

So from `~10^{-16}` (float64 seed), we reach `~10^{-32}` after 1 iter,
`~10^{-64}` after 2, `~10^{-128}` after 3, `~10^{-256}` after 4, …
**Iteration count: `ceil(log₂(prec / 53)) + 1` ≈ 3 for 50 dps, ~5 for
1000 dps.** Trivial.

**Termination criterion:** `|Δx| < 2 · 2^(-prec) · |x|` (relative). For
`|y|` near zero (`x` near zero), switch to absolute: `|Δx| <
2^(-prec)`. Use `max(|x|, 2^(prec/3))` to interpolate cleanly.

**Initial guess** — see executive summary table. The mpmath approach
("polynomial for |y| < 0.9, asymptotic for larger") gives 16 good digits
to start; Newton does the rest.

---

# 2. Recommended split for our bigfloat substrate

This section translates §1 into concrete crossover formulae for our
implementation.

## 2.1 Real-argument primary dispatch (`bigErf`, `bigErfc`)

```ts
function bigErf(x: BigFloat, prec: number): BigFloat {
  // Odd: erf(-x) = -erf(x). Compute on |x|, sign at end.
  if (sgn(x) === 0) return zero;
  const work = prec + 32;
  const absX = abs(x);
  const xMag = toFloat64(absX).value;
  if (!Number.isFinite(xMag)) {
    // |x| larger than 2^1023 — erf(x) is 1 to any sane precision.
    return sgn(x) === 1 ? one(prec) : neg(one(prec));
  }
  // Crossover: x_c = sqrt(prec · ln 2)
  const xCrossover = Math.sqrt(prec * Math.LN2);
  let result: BigFloat;
  if (xMag < xCrossover) {
    // Series path: erf(x) = (2/√π) · e^(-x²) · x · Σ (2x²)^n · n! / (2n+1)!
    result = bigErfSeries(absX, work);
  } else {
    // Asymptotic-via-erfc:  erf(x) = 1 - erfc(x)
    // erfc(x) is small (≤ exp(-x_c²) = 2^-prec), so the subtraction
    // 1 - erfc(x) loses no precision.
    const erfcVal = bigErfcAsymptotic(absX, work);
    result = sub(one(work), erfcVal, prec);
  }
  return sgn(x) === 1 ? result : neg(result);
}

function bigErfc(x: BigFloat, prec: number): BigFloat {
  if (sgn(x) === 0) return one(prec);
  const work = prec + 32;
  const xMag = toFloat64(x).value;
  if (!Number.isFinite(xMag)) {
    return sgn(x) === 1 ? zero(prec) : two(prec);
  }
  const xCrossover = Math.sqrt(prec * Math.LN2);
  if (xMag > 0 && Math.abs(xMag) >= xCrossover) {
    // Direct asymptotic — never 1 - erf(x) (catastrophic cancellation).
    const absX = abs(x);
    const erfcAbs = bigErfcAsymptotic(absX, work);
    return sgn(x) === 1 ? erfcAbs : sub(two(work), erfcAbs, prec);
  }
  // Below crossover: erfc(x) = 1 - erf(x).
  // erf(x) here has |erf(x)| < 1 - ε, so 1 - erf(x) is well-conditioned.
  return sub(one(work), bigErf(x, work), prec);
}
```

**Note on the asymmetry:** `bigErf` and `bigErfc` are *not* simply
`1 - other`. `bigErf` uses the series path below crossover and the
"`1 - erfc(asymptotic)`" path above; `bigErfc` uses the
"`1 - erf(series)`" path below and the direct asymptotic above. Each
delegates to the *other* in exactly the regime where the delegation is
numerically clean. This is the same pattern as `expm1` / `exp` in
`transcendental.ts`.

## 2.2 Crossover formula — derivation

For asymptotic series 7.12.1 truncated at optimal `m* = floor(|z|²)`,
the smallest-term magnitude is

```
  |a_{m*}| ≈ √(π / (2|z|²)) · e^(-|z|²)         (after Stirling on (2m*-1)!!)
```

For the asymptotic to give `prec`-bit relative accuracy on `erfc(x) =
(e^(-x²)/(x√π)) · (1 + a_1 + a_2 + …)`, we need

```
  |a_{m*}| / |1| < 2^-prec
  ⟹  e^(-|z|²) · √(π/(2|z|²)) < 2^-prec
  ⟹  |z|² · log₂(e) > prec - ½ log₂(π/(2|z|²))
  ⟹  |z|² > prec · ln 2 - O(log prec)
```

Dropping the log correction (it costs at most one extra bit at any
realistic precision):

```
  x_c = √(prec · ln 2)
```

| prec (bits) | dps | x_c   |
|-------------|-----|-------|
| 53          | 16  |  6.07 |
| 100         | 30  |  8.33 |
| 196         | 50  | 11.66 |
| 332         | 100 | 15.18 |
| 1024        | 308 | 26.65 |
| 3322        | 1000| 47.99 |

This matches Arb's threshold (`x² + log₂(|z|) > prec` in their notation —
the `log₂(|z|)` correction is the same `½ log₂(π/(2|z|²))` term we
dropped, modulo constants).

## 2.3 Series convergence guard

For the series path (`bigErfSeries`), the convergence cutoff is

```
  |term_N| < 2^-prec · |running sum|
```

Term count `N ≈ max(prec / log₂(e), 2|z|²) + 32`. Iteration cap
generously `max(N · 4, prec · 4)`.

Cancellation in 7.6.2: **none, for real `x`.** For complex `z` with
large `|z²|` and `Re(z²) < 0`, the `e^(-z²) = e^(-Re z²) · (cos·sin)`
prefactor is huge while `M(1, 3/2, z²)` is huge in the opposite
direction — both are computed at full working precision and the product
collapses. The cancellation is in the *product*, not in either factor's
series. The fix is the same as `cgamma`'s reflection-precision bump
(bead `oj5j`): measure the cancellation loss and bump working precision:

```ts
const work0  = prec + 32;
const lossEst = Math.max(0, Math.ceil(Math.abs(reZ2) * Math.LOG2E));
const work    = work0 + lossEst;
```

Where `reZ2 = Re(z²) = x² - y²`.

## 2.4 Complex-argument dispatch (`bigCErf`, `bigCErfc`, …)

For BigComplex, the implementation pivots on **`bigW(z)`** as the single
primitive. All other complex erf-family functions are algebraic
combinations:

```ts
function bigCErf(z: BigComplex, prec: number): BigComplex {
  // Special cases: real axis, imaginary axis, zero.
  if (cisZero(z)) return cfromReal(zero(prec));
  if (isZero(z.im)) return cfromReal(bigErf(z.re, prec));
  if (isZero(z.re)) {
    // erf(iy) = i · erfi(y) = i · (-i · erf(iy)) is circular — use the
    // Faddeeva relation:  erf(iy) = (2i/√π) · ∫_0^y exp(t²) dt
    //                              = i · exp(y²) · w_im(y)
    // where w_im(y) = Im[w(y)] is Dawson-related. Easier:  defer to bigW.
    // ...
  }
  const work = prec + 32;
  const mZ2 = cneg(cmul(z, z, work));
  if (sgn(z.re) >= 0) {
    // erf(z) = 1 - exp(-z²) · w(iz)  for Re(z) ≥ 0
    const iz: BigComplex = { re: neg(z.im), im: z.re };
    const w  = bigW(iz, work);
    const expMZ2 = cexp(mZ2, work);
    return csub(cfromReal(one(work)), cmul(expMZ2, w, work), prec);
  } else {
    // erf(z) = exp(-z²) · w(-iz) - 1  for Re(z) < 0
    const miz: BigComplex = { re: z.im, im: neg(z.re) };
    const w  = bigW(miz, work);
    const expMZ2 = cexp(mZ2, work);
    return csub(cmul(expMZ2, w, work), cfromReal(one(work)), prec);
  }
}
```

This is line-for-line Faddeeva.cc's `Faddeeva::erf(cmplx z, ...)`.

`bigCErfc` is the same structure with the sign-of-x branch sending
`erfc(z) = exp(-z²)·w(iz)` for `Re(z) ≥ 0` and `erfc(z) = 2 -
exp(-z²)·w(-iz)` for `Re(z) < 0`.

`bigCErfcx` is `w(iz)` directly (DLMF / Karbach §2.3).

`bigCErfi(z) = -i · bigCErf(iz)`.

So *the* primitive to build is **`bigW`**. See §5.

---

# 3. Precision-tracking strategy

## 3.1 The cgamma exemplar — measure cancellation, bump work, retry

The pattern, lifted from `clgammaReflect` (worklog 117, bead `oj5j`):

```ts
// Step 1: identify the source of cancellation by *algebraic structure*.
//   In clgammaReflect: it's the subtraction z - m for m = round(Re z).
//   In bigErf:           it's the product e^(-z²) · series(z²) when
//                        Re(z²) < 0  (i.e. |Im z| > |Re z|).
//   In bigErfc series:   it's 1 - bigErf — but we route this to the
//                        direct asymptotic for x > x_c, so the cancellation
//                        never enters bigErfc's path.

// Step 2: estimate the loss in bits.
const lossBits = Math.max(0, magBits(blowUp) - magBits(finalValue));

// Step 3: bump working precision and re-evaluate at the new prec.
const work = prec + 32 + lossBits;
```

For `bigErf` / `bigErfc`, the loss sources are:

| primitive          | loss source                                    | estimate                          |
|--------------------|------------------------------------------------|-----------------------------------|
| `bigErfSeries(x)`  | none for real x ≥ 0                            | 0                                 |
| `bigErfSeries(z)`  | `e^(-z²)·M(1,3/2,z²)` product, Re z² < 0       | `|Re z²| · log₂(e)`               |
| `bigErfcAsymptotic`| none (signed terms but pre-factor wins)        | 0                                 |
| `bigCErf` via w    | `1 - exp(-z²)·w(iz)` for Re z > 0 small        | up to `Re(z²) · log₂(e)`          |
| `bigW` (Karbach)   | singularities at `z = ±nπ/τ_m`                 | local 5th-order Taylor (handled)  |

## 3.2 The pFq retry-loop exemplar

For paths where the loss is **not algebraically predictable**
(complex-argument series with `arg z` near specific values), use the
`evaluatePFq` outer loop pattern from
`packages/hypergeometric/src/pfq.ts:281-410`:

```ts
let workingBits = prec + 32;
for (let attempt = 0; attempt < 4; attempt++) {
  const result = bigErfSeriesAtPrec(z, workingBits, prec);
  const usableBits = workingBits - result.cancellationLoss;
  if (usableBits >= prec + 16) return result.value;
  workingBits = Math.max(workingBits * 2, workingBits + result.cancellationLoss + 64);
}
throw new RangeError(`bigErf: cancellation could not be controlled in 4 retries`);
```

This is the same shape as `pfq.ts:364-402`. We pay for cancellation
*paid* (computed), not *predicted* (estimated). Hybrid is the best:
predict an `lossBits` upper bound to size `workingBits` initially, then
fall back to the retry loop if the prediction was wrong.

## 3.3 Cancellation detector — common helper

Define one helper that all erf primitives reuse:

```ts
// magBits(x) is already in special.ts as zMagBits and in complex.ts as magBits.
// Reuse — don't redefine.

function trackPeakMag(z: BigFloat | BigComplex): {
  push: (term: BigFloat | BigComplex) => void;
  loss: (final: BigFloat | BigComplex) => number;
} {
  let peakMag = -Infinity;
  return {
    push(term) { peakMag = Math.max(peakMag, magBits(term)); },
    loss(final) { return Math.max(0, peakMag - magBits(final)); },
  };
}
```

This is a 6-line utility; inline rather than packaging if no other
substrate consumer wants it.

## 3.4 How Arb's ball arithmetic differs

Worth a short note for context. Arb tracks `(midpoint, radius)` per
value; cancellation that destroys mantissa bits *also* increases the
radius. A subtraction `a - b` where `|a - b|` is much smaller than
`|a|` doesn't lose information — it correctly reports the result as
small with a *large radius*, and downstream consumers see "we know this
to ε accuracy" not "this is 2^-p". The ball arithmetic propagates the
error bound automatically.

Our `BigFloat` is **rounded mantissa, no radius**. We carry no error
metadata; cancellation produces a value with `prec` bits of mantissa,
some of which are *wrong*. The honest path is **detect-and-bump-and-
retry**, as cgamma does. We could *add* a radius field later (it would
be a 4th field on `BigFloat`), but ADR-0020's `arbprec: true` contract
is **bit-deterministic** without radii — and adding a radius is a
breaking ADR change, not an in-scope substrate addition. The
detect-and-retry pattern is the right tradeoff for now.

---

# 4. Constants and coefficient tables

## 4.1 Maclaurin (DLMF 7.6.2) coefficients

The series

```
  erf(z) = (2z/√π) · e^(-z²) · Σ_{n=0}^∞ c_n · (2z²)^n
  with c_n = n! / (2n+1)!
```

The coefficient `c_n` satisfies

```
  c_0 = 1, c_1 = 1/3, c_2 = 2/15, c_3 = 6/105 = 2/35, c_4 = 24/945 = 8/315, …
  c_{n+1} / c_n = (n+1) / ((2n+2)(2n+3)) = 1 / (2(2n+3))
```

— so the ratio is simple, no need to precompute the table; iterate
`term_{n+1} = term_n · (2z²) / (2(2n+3)) = term_n · z² / (2n+3)`.

**No table needed.** This is the cleaner form than 7.6.1.

For reference, the first 10 coefficients as a BigInt-rational TS literal:

```ts
// c_n = n! / (2n+1)! as (num, den) BigInt pairs.
// Only useful for sanity-check; the actual evaluation uses the
// per-term recurrence above.
const ERF_BOREL_COEFFS: ReadonlyArray<readonly [bigint, bigint]> = [
  [1n,                     1n],                      // n=0
  [1n,                     3n],                      // n=1
  [2n,                     15n],                     // n=2
  [2n,                     35n],                     // n=3  (6/105)
  [8n,                     315n],                    // n=4  (24/945)
  [8n,                     693n],                    // n=5  (120/10395)
  [16n,                    3003n],                   // n=6
  [16n,                    6435n],                   // n=7
  [128n,                   109395n],                 // n=8
  [128n,                   230945n],                 // n=9
];
```

## 4.2 Asymptotic (DLMF 7.12.1) coefficients

```
  erfc(z) ~ (e^(-z²) / (√π · z)) · Σ_{m=0}^∞ a_m / z^(2m)
  with a_m = (-1)^m · (2m-1)!! / 2^m
  i.e. a_0 = 1, a_1 = -1/2, a_2 = 3/4, a_3 = -15/8, a_4 = 105/16, …
```

Recurrence:

```
  a_{m+1} / a_m = -(2m+1) / 2
```

So iterate `term_{m+1} = term_m · (-(2m+1) / (2z²))`. **No table
needed.**

For an iteration-driven implementation that wants the rational
coefficients as a sanity check:

```ts
// a_m = (-1)^m · (2m-1)!! / 2^m  as signed (num, den) BigInt pairs.
const ERFC_ASYMPTOTIC_COEFFS: ReadonlyArray<readonly [bigint, bigint]> = [
  [ 1n,    1n],     // m=0
  [-1n,    2n],     // m=1
  [ 3n,    4n],     // m=2
  [-15n,   8n],     // m=3
  [ 105n,  16n],    // m=4
  [-945n,  32n],    // m=5
  [ 10395n,64n],    // m=6
  [-135135n, 128n], // m=7
  // ... grows factorially; computed on the fly past m ≈ 10.
];
```

The factorial-grade growth is fine because the series is divergent —
we stop at `m* = floor(|z|²)`, well below where the coefficients
overflow any sane integer type.

## 4.3 Erfcx asymptotic (same as 4.2 minus prefactor)

```
  erfcx(x) ~ (1 / (x√π)) · Σ_{m=0}^∞ a_m / x^(2m)
```

Same `a_m` as 4.2. The Julia SpecialFunctions.jl `_erfcx` implementation
uses these coefficients implicitly via the recurrence
`w *= -k·v; k += 2` (their `k = 2m+1`, `v = 1/(2x²)`).

## 4.4 Karbach-Weideman Fourier coefficients for `w(z)`

Karbach's `w(z)` approximation (Karbach 2014 eq. 37):

```
  w(z) ≈ (i / (2√π)) · ( Σ_{n=0}^N a_n · τ_m · [ (1 - e^(i(nπ + τ_m z)))/(nπ + τ_m z)
                                                 - (1 - e^(i(-nπ + τ_m z)))/(nπ - τ_m z) ]
                         - a_0 · (1 - e^(i τ_m z)) / z )
```

with

```
  τ_m = 12     (for double; scales with prec — see formula below)
  N   = 23     (for double; scales with prec)
  a_n = (2√π / τ_m) · e^(-n²π²/τ_m²)        (Fourier coefficient)
```

**Prec scaling:**

```
  τ_m(p) = sqrt( -4 · ln(eps_p / 4) )   where eps_p = 2^-p
         = sqrt( 4·(p · ln 2 - ln 4) )
         ≈ 2·sqrt(p · ln 2)             for large p
  N(p)   = ceil( τ_m(p)² / (4π) · log(1/eps_p) )
         = ceil( τ_m(p)² · p · ln 2 / (4π) )
         ≈ ceil( p² · (ln 2)² / π )
         ≈ ceil(p² · 0.153)
```

Wait — that grows quadratically in `p`. Recheck against Karbach: for
p = 53 (double), they use N = 23. p² · 0.153 at p=53 is 430 — but they
use 23. The closed-form scaling I sketched overcounts.

Karbach's actual logic (paper §5.1 verbatim, p. 7): "It [N] has to be
large enough that the Fourier series in Eq. 35 is a good approximation.
This is the case when the highest Fourier coefficient is smaller than
the machine precision". So the condition is `a_N < eps_p`:

```
  a_N = (2√π / τ_m) · e^(-N²π²/τ_m²) < 2^-p
  ⟹  N²π² / τ_m² > p · ln 2 + log(2√π/τ_m)
  ⟹  N > (τ_m / π) · sqrt(p · ln 2 + log(2√π / τ_m))
```

For p = 53, τ_m = 12: `N > (12/π) · sqrt(53 · 0.693 + 0.43) ≈ 3.82 · sqrt(37.16) ≈ 23.3` ⟹ N=23. ✓

For p = 196, τ_m = `sqrt(4·(196·0.693 - 1.39)) ≈ sqrt(537.2) ≈ 23.18`:
`N > (23.18/π) · sqrt(196·0.693 + 0.43) ≈ 7.38 · √136.3 ≈ 86.1` ⟹ N=87.

So `N` scales as **`O(√p · √p) = O(p)`**, not `O(p²)`. My earlier
back-of-envelope was wrong. Corrected:

```ts
// Closed-form prec-scaling for Karbach-Weideman parameters.
function karbachParams(prec: number): { tau_m: number; N: number } {
  const eps = Math.pow(2, -prec);
  const tau_m = Math.sqrt(-4 * Math.log(eps / 4));
  const N_real = (tau_m / Math.PI) *
                 Math.sqrt(prec * Math.LN2 + Math.log(2 * Math.sqrt(Math.PI) / tau_m));
  return { tau_m, N: Math.ceil(N_real) + 1 };  // +1 for safety
}
// At prec = 53:   { tau_m: 12.001, N: 24 }   (Karbach's 12, 23 within rounding)
// At prec = 100:  { tau_m: 16.66,  N: 47 }
// At prec = 196:  { tau_m: 23.18,  N: 88 }
// At prec = 332:  { tau_m: 30.15,  N: 153 }
// At prec = 1024: { tau_m: 53.27,  N: 480 }
```

Term cost: **`O(p)` complex Horner steps**. At p = 1024 (300 dps), 480
complex Horners ≈ 1920 BigFloat operations per Faddeeva evaluation —
comparable to a 300-dps complex `cgamma` (which runs ~150 Bernoulli +
Stirling iters). Acceptable.

## 4.5 Karbach `a_n` coefficients — emit at runtime

Because `a_n` depends on `τ_m` which depends on `prec`, we **cannot
precompute a fixed table**. Generate at first call per precision:

```ts
const karbachCache = new Map<number, {
  tau_m: BigFloat;
  N: number;
  a: BigFloat[];           // length N+1
  expITauMZ: BigComplex;   // null until z is known; precomputed at call site
}>();

function karbachCoeffs(prec: number): { tau_m: BigFloat; N: number; a: BigFloat[] } {
  const cached = karbachCache.get(prec);
  if (cached) return cached;
  const work = prec + 32;
  const { tau_m, N } = karbachParams(prec);
  const tauF = fromFloat64(tau_m, work);     // float64 -> BigFloat
  const piF = pi(work);
  const sqrtPi = sqrt(piF, work);
  const a: BigFloat[] = [];
  for (let n = 0; n <= N; n++) {
    // a_n = (2√π / τ_m) · exp(-n²π²/τ_m²)
    const nPi = mul(fromInt(BigInt(n), work), piF, work);
    const nPiOverTau = div(nPi, tauF, work);
    const sq = mul(nPiOverTau, nPiOverTau, work);
    const expTerm = exp(neg(sq), work);
    a.push(mul(div(mul(fromInt(2n, work), sqrtPi, work), tauF, work), expTerm, prec));
  }
  const entry = { tau_m: tauF, N, a };
  karbachCache.set(prec, entry);
  return entry;
}
```

This mirrors `_piCache` / `_ln2Cache` / `_eCache` in
`transcendental.ts:41-43`. Per-prec caching, not LRU; first call at a
new prec generates, subsequent calls reuse.

**Memory cost:** at p = 1024, the table is 481 BigFloats × ~1024-bit
mantissa ≈ 60 KB. Negligible. At p = 3322 (1000 dps), ~480 KB — still
fine.

---

# 5. Faddeeva implementation plan — `bigW(z)`

## 5.1 Algorithm structure

Two regions, mirroring Faddeeva.cc and Karbach:

```
  Region A — |z| large (CF-equivalent):   |Im z| > 7 OR |z| > some bound
  Region B — Karbach-Weideman:            otherwise
```

For Region A, use the **rational asymptotic forms** Faddeeva.cc names as
`nu = 1, 2` cases (lines 745–765 verbatim):

```
  |z| → ∞   :  w(z) ≈ i/(√π · z)                       (one CF cycle)
  |z| → very large but < ∞  :  w(z) ≈ i·z/(√π · (z² - ½))   (two CF cycles)
```

These are the truncated Laplace CF (DLMF 7.9.3) at depth 1 and 2. Use
when the truncation error is already below `2^-prec`:

```
  one-cycle error:    O(1/|z|²)        ⟹  use when |z|² > 2^(p+1)
  two-cycle error:    O(1/|z|⁴)        ⟹  use when |z|⁴ > 2^(p+1)
```

For `p = 196`, the one-cycle threshold is `|z| > 2^99` — astronomical;
the two-cycle threshold is `|z| > 2^49`. Both effectively never trigger
at sane inputs; Karbach handles the regime.

**Recommendation: skip the CF special cases entirely at arbitrary
precision.** They are double-precision optimisations (`|z| > 10^7` etc.)
that don't matter when `bigW` is being called for "real numerical
problems" at 50+ dps. If the caller passes `|z| > 2^49`, they almost
certainly want `w(z) → i/(√π·z)` and can compute that themselves.
Document this gating in `bigW`'s doc-comment:

```
  Domain: |z| < 2^prec — i.e. z must be representable to relative precision.
  For |z|² ≥ prec · ln 2, w(z) is exponentially small in Im(z) (or large in -Im(z));
  the Karbach-Weideman path handles these cases via the e^(iτ_m z) = e^(-τ_m Im z)
  factor, which underflows / overflows gracefully through the BigFloat exponent.
```

## 5.2 Karbach-Weideman in TypeScript — sketch

```ts
import { type BigComplex, cfromReal, cfromInts, cadd, csub, cmul, cdiv, cexp, ...
} from "@workbench/bigfloat";

function bigW(z: BigComplex, prec: number): BigComplex {
  const work = prec + 32;
  // Mirror symmetry: w(-x + iy) = conj(w(x + iy)).  Reduce to first quadrant.
  let zNorm = z;
  let flipReal = false, flipImag = false;
  if (sgn(z.re) < 0) { zNorm = { re: neg(z.re), im: z.im }; flipReal = true; }
  if (sgn(z.im) < 0) {
    // Use w(x - iy) = 2·exp(-z²) - w(x + iy)
    flipImag = true;
    zNorm = { re: zNorm.re, im: neg(zNorm.im) };
  }
  // (After both flips, zNorm is in first quadrant.)
  
  const { tau_m, N, a } = karbachCoeffs(work);
  const piW = pi(work);
  
  // Precompute e^(i τ_m z) — load-bearing constant for the loop.
  const tauZ = cmul(cfromReal(tau_m), zNorm, work);
  const iTauZ: BigComplex = { re: neg(tauZ.im), im: tauZ.re };
  const expITauZ = cexp(iTauZ, work);
  
  // Singularity check: zNorm near ±n·π/τ_m for n = 0..N
  for (let n = 0; n <= N; n++) {
    const pole = div(mul(fromInt(BigInt(n), work), piW, work), tau_m, work);
    // Test |zNorm.re - pole| + |zNorm.im| < 3e-3 (Karbach radius);
    // scaled to prec, the radius is 2^(-prec/3) or so.
    // ... if hit, use 5th-order Taylor expansion of w around (pole, 0).
    // Implementation: defer; the singularity disc is a measure-zero set
    // at any prec, and the Taylor expansion code is ~30 lines.
  }
  
  // Main sum (Karbach 2014 eq. 37, rearranged):
  let sum = cfromReal(zero(work));
  // First, the a_0 term:  -a_0 · (1 - e^(i τ_m z)) / z
  const oneMinusExp = csub(cfromReal(one(work)), expITauZ, work);
  const a0Term = cdiv(cmul(cfromReal(a[0]!), oneMinusExp, work), zNorm, work);
  sum = csub(sum, a0Term, work);
  
  // Then, for n = 1..N:
  //   a_n · τ_m · [ (1 - e^(i(nπ + τ_m z)))/(nπ + τ_m z)
  //                - (1 - e^(i(-nπ + τ_m z)))/(nπ - τ_m z) ]
  //
  // Note: e^(i n π) = (-1)^n; so e^(i(nπ + τ_m z)) = (-1)^n · e^(i τ_m z).
  // The bracket simplifies to:
  //   (1 - (-1)^n · expITauZ) · [ 1/(nπ + τ_m z) - 1/(nπ - τ_m z) ]    ??? 
  // No — only the *sign* of e^(±i n π) matches, not the τ_m z part.
  // (1 - (-1)^n · expITauZ)/(nπ + τ_m z) - (1 - (-1)^n · expITauZ)/(- nπ + τ_m z)
  //  = (1 - (-1)^n · expITauZ) · [ 1/(nπ + τ_m z) + 1/(nπ - τ_m z) ]
  //  = (1 - (-1)^n · expITauZ) · 2nπ / ((nπ)² - (τ_m z)²)
  //
  // So per-term cost: 2 BigComplex mul + 1 BigComplex div + 1 BigFloat scale.
  
  const tauZSq = cmul(tauZ, tauZ, work);
  for (let n = 1; n <= N; n++) {
    const nPi = mul(fromInt(BigInt(n), work), piW, work);
    const nPiSq = mul(nPi, nPi, work);
    const denom = csub(cfromReal(nPiSq), tauZSq, work);
    const sign = n % 2 === 0 ? expITauZ : cneg(expITauZ);
    const oneMinusSign = csub(cfromReal(one(work)), sign, work);
    const numer = cmul(oneMinusSign, cfromReal(mul(fromInt(2n, work), nPi, work)), work);
    const term = cdiv(cmul(cfromReal(a[n]!), numer, work), denom, work);
    sum = cadd(sum, cmul(cfromReal(tau_m), term, work), work);
  }
  
  // Prefactor i/(2√π):
  const sqrtPi = sqrt(piW, work);
  const inv2SqrtPi = div(one(work), mul(fromInt(2n, work), sqrtPi, work), work);
  // multiply by i:  (a + bi)·i = -b + ai
  const result: BigComplex = {
    re: neg(mul(inv2SqrtPi, sum.im, work)),
    im: mul(inv2SqrtPi, sum.re, work),
  };
  
  // Undo quadrant reductions.
  let final = result;
  if (flipImag) {
    // w(x - iy) = 2·exp(-z²) - w(x + iy)
    const mz2 = cneg(cmul(zNorm, zNorm, work));
    const twoExpMZ2 = cmul(cfromReal(fromInt(2n, work)), cexp(mz2, work), work);
    final = csub(twoExpMZ2, final, work);
  }
  if (flipReal) final = cconj(final);
  
  return { re: normalise(final.re.mantissa, final.re.exponent, prec),
           im: normalise(final.im.mantissa, final.im.exponent, prec) };
}
```

This is ~80 lines of TypeScript, comparable to `clgammaShifted` +
`clgammaStirling` (lines 311–383 in `complex.ts`). The discipline:

- **Symmetries reduce to first quadrant before computation.** Same
  pattern as `clgamma`'s reflection.
- **`expITauZ` is computed once.** Same pattern as `oneOverZ2` in
  `clgammaStirling` (precompute the recurrence ratio).
- **Cache `(tau_m, N, a)` per prec.** Same pattern as `_piCache`.
- **No early-exit cleverness for "small N".** The fixed-N pattern lets
  the compiler / runtime predict the loop; mpmath-style "stop when
  terms are small" would force adaptive N, which Karbach is engineered
  to avoid.

## 5.3 Why not Poppe-Wijers continued fraction?

Faddeeva.cc uses Poppe-Wijers' CF for `|Im z| > 7` and a separate
"Algorithm 916"-style 5-sum kernel for `|x| < 10`. The empirically-fit
`nu = floor(c0 + c1/(c2*x + c3*ya + c4))` formula is **double-precision-
specific**; the fit was done with NLopt to minimise CF iteration count
subject to "≥ machine precision". At higher precision the fit no longer
holds.

To extend to arbitrary precision: replace the empirical `nu` with the
theoretical CF convergence-rate bound:

```
  nu(p, z) = ceil(p · ln 2 / (2 · ln(|z|²)))
```

But this only converges in the *right* half-plane (`Re(z²) > 0`), so
near the imaginary axis (where w lives most interestingly) the CF
converges slowly. Karbach has uniform convergence everywhere.

**The decision is:** if we want a *single* algorithm that works at all
prec and all `z`, Karbach is it. Poppe-Wijers + Algorithm 916 is two
algorithms with awkward seams; replacing each at arbitrary precision
requires re-deriving the empirical fits. Not worth it.

## 5.4 Why not just call Arb's acb_hypgeom_erf algorithm directly?

Arb's complex erf is essentially "do the real-axis algorithm with
complex arithmetic, plus a sector test for the asymptotic". For real
arguments this is identical to our `bigErf` plan. For complex arguments
*off the real axis*, the Maclaurin path suffers the alternating-
cancellation problem (DLMF 7.6.1 vs 7.6.2 distinction), and the
asymptotic path requires sector-aware Berry smoothing on the Stokes line
`arg z = 3π/4`. **Karbach is what you get when you take Arb's complex
algorithm and replace it with a single-sector-uniform expansion** — same
problem, cleaner answer.

For our substrate: use Arb-style for real `bigErf`, Karbach for complex
`bigW`. Same primitive (erfc/erf), different optimal algorithm in each
case, justified by where the cancellations live.

## 5.5 Singularity discs

Karbach §5.1 (paraphrased): the formula eq. 37 has removable
singularities at `z_n = ±nπ/τ_m` for `n = 0, 1, …, N`. Within a disc of
radius `r = 3·10^-3` (in double precision; scales to roughly `2^-prec/3`
at arbitrary precision), the formula is numerically unstable. Use a
5-term Taylor expansion of `w(z)` around the singularity:

```
  w(z) = w(z_n) + w'(z_n)·(z - z_n) + ½ w''(z_n)·(z - z_n)² + …
```

The first 5 Taylor coefficients of `w` at each `z_n` need to be computed
once per `(prec, n)`; cache. The recurrence `w^(k+2) + 2z·w^(k+1) +
2(k+1)·w^(k) = 0` (DLMF 7.10.3) gives them from `w(z_n)` and `w'(z_n) =
-2 z_n · w(z_n) + 2i/√π`.

At our scales the singularity discs are rare events; **a flagged refusal
in v0.1 is acceptable**:

```ts
if (insideSingularityDisc) {
  throw new RangeError(
    `bigW: argument z = ${...} lies within 2^-${prec/3} of singularity ` +
    `z_${n} = ${n}π/τ_m; Taylor-disc evaluation deferred to v0.2`,
  );
}
```

V0.2 fix is well-understood (Karbach's 5-term expansion ported); not
needed for the `ybrw` consumer (which calls `bigErfc` on real
arguments, not `bigW` on complex ones).

---

# 6. Inverse-function plan

## 6.1 Algorithm

```ts
export function bigErfInv(y: BigFloat, prec: number): BigFloat {
  // Domain: y ∈ (-1, 1).  Boundaries: erfinv(0) = 0, erfinv(±1) = ±∞.
  if (isZero(y)) return zero(prec);
  const yF = toFloat64(y).value;
  if (!Number.isFinite(yF) || Math.abs(yF) >= 1) {
    if (Math.abs(yF) === 1) {
      throw new RangeError(`bigErfInv: argument ±1 has no finite inverse`);
    }
    throw new RangeError(`bigErfInv: argument outside (-1, 1)`);
  }
  
  // Initial guess via float64 erfinv (mpmath polynomial / asymptotic split).
  const work = prec + 32;
  let xInit: number;
  if (Math.abs(yF) < 0.9) {
    // mpmath: a = 0.53728·y³ + 0.813198·y  (then float64 Newton in mpmath;
    // here we go straight to bigfloat Newton).
    xInit = 0.53728 * yF * yF * yF + 0.813198 * yF;
  } else {
    // Asymptotic for |y| → 1:  u = ln(2/π/(|y|-1)²) ;  x ≈ sign(y) · sqrt((u-ln u)/2)
    const u = Math.log(2 / Math.PI / Math.pow(Math.abs(yF) - 1, 2));
    xInit = Math.sign(yF) * Math.sqrt((u - Math.log(u)) / 2);
  }
  let x = fromFloat64(xInit, work);
  
  // Newton:  x_{n+1} = x_n - (erf(x) - y) · √π/2 · exp(x²)
  const sqrtPiHalf = mul(sqrt(pi(work), work),
                         fromString("0.5", work), work);
  for (let iter = 0; iter < Math.ceil(Math.log2(prec / 53)) + 4; iter++) {
    const f       = sub(bigErf(x, work), y, work);
    const expX2   = exp(mul(x, x, work), work);
    const deltaX  = mul(mul(f, sqrtPiHalf, work), expX2, work);
    x = sub(x, deltaX, work);
    // Termination: |Δx| < 2 · 2^-prec · max(|x|, 2^-prec/2)
    const tol = mul(fromString("2.0", work),
                    powInt(fromInt(2n, work), -prec, work), work);
    const xMag = max(abs(x), tol);  // pseudo
    if (lt(abs(deltaX), mul(tol, xMag, work))) break;
  }
  return normalise(x.mantissa, x.exponent, prec);
}
```

## 6.2 Initial guess — the load-bearing detail

The float64 seed is correct to ~16 digits. Newton on a `C^∞` function
with quadratic convergence reaches `2·16 = 32` digits in one iter,
`64` in two, `128` in three, `256` in four. So **for any prec ≤ 200
digits (≈ 700 bits), 4 Newton iterations suffice**.

For higher prec, we either:

(a) Continue Newton for more iters — `ceil(log₂(prec/53))` rounded up;
(b) Replace the float64 seed with a higher-precision seed.

(a) is simpler. (b) would mean computing erfinv at ~30 dps first then
upgrading — more code, no payoff.

## 6.3 Termination

`|Δx| < 2 · 2^-prec · |x|` (relative). For `y` near zero (so `x` near
zero), this would require infinite iterations; the absolute form
`|Δx| < 2^-prec` handles that case. The combined criterion:

```
  |Δx| < 2 · 2^-prec · max(|x|, 1)
```

is conservative and uniform. `max(|x|, 1)` because `|erfinv(y)| ≤ 1`
for `|y| ≤ erf(1) ≈ 0.843` so the relative criterion is stricter than
the absolute one in that range; for `|y| > 0.843` we have `|x| > 1` and
the relative form is right.

## 6.4 `bigErfcInv`

```ts
export function bigErfcInv(y: BigFloat, prec: number): BigFloat {
  // Domain: y ∈ (0, 2).
  const yF = toFloat64(y).value;
  if (!Number.isFinite(yF) || yF <= 0 || yF >= 2) {
    throw new RangeError(`bigErfcInv: argument outside (0, 2)`);
  }
  if (yF > 0.0625 && yF < 1.9375) {
    // Delegate to erfinv: erfcinv(y) = erfinv(1 - y).
    const work = prec + 32;
    const oneMinusY = sub(one(work), y, work);
    return bigErfInv(oneMinusY, prec);
  }
  // Tail: y near 0 or near 2.
  const work = prec + 32;
  let xInit: number;
  if (yF < 0.0625) {
    // sqrt(-log(y · √π))
    xInit = Math.sqrt(-Math.log(yF * Math.sqrt(Math.PI)));
  } else {
    // y near 2: erfcinv(y) = -erfcinv(2 - y)
    return neg(bigErfcInv(sub(two(prec + 32), y, prec + 32), prec));
  }
  let x = fromFloat64(xInit, work);
  const sqrtPiHalf = mul(sqrt(pi(work), work),
                         fromString("0.5", work), work);
  for (let iter = 0; iter < Math.ceil(Math.log2(prec / 53)) + 4; iter++) {
    // Newton:  Δx = √π/2 · (erfc(x) - y) · exp(x²)
    // Use erfcx directly to avoid the catastrophic cancellation in erfc(large x):
    //   erfcx(x) · √π/2 · (1 - y / erfc(x))  — no, simpler:
    //   erfc(x) · exp(x²) = erfcx(x), so  Δx = √π/2 · (erfcx(x) - y · exp(x²))
    // For x in the tail (large), y · exp(x²) might overflow Number — use BigFloat throughout.
    const expX2  = exp(mul(x, x, work), work);
    const erfcxV = bigErfcx(x, work);
    const yExpX2 = mul(y, expX2, work);
    const f      = sub(erfcxV, yExpX2, work);  // = (erfc(x) - y) · exp(x²)
    const deltaX = mul(f, sqrtPiHalf, work);
    x = add(x, deltaX, work);                  // note: + not - (sign convention)
    const tol = mul(fromString("2.0", work),
                    powInt(fromInt(2n, work), -prec, work), work);
    if (lt(abs(deltaX), mul(tol, abs(x), work))) break;
  }
  return normalise(x.mantissa, x.exponent, prec);
}
```

The use of `bigErfcx` inside the Newton iteration avoids the
`exp(x²) · erfc(x)` over/underflow round-trip when `x` is large (which
is exactly when erfcinv's tail-asymptotic seed is needed).

---

# 7. Cross-references to existing @workbench/bigfloat patterns

| Recommendation                                  | Cited idiom                                                     | Lines                                |
|-------------------------------------------------|-----------------------------------------------------------------|--------------------------------------|
| Per-prec coefficient caching                    | `_piCache` / `_ln2Cache` / `_eCache` in `transcendental.ts`     | `transcendental.ts:41-43`            |
| Per-prec recompute-if-bigger                    | `pi(prec)` cache invalidation pattern                           | `transcendental.ts:53-55`            |
| Working precision = prec + safety               | All `*Stirling` functions use `prec + 32`                       | `special.ts:119, 343, 432`; `complex.ts:343, 592` |
| Cancellation depth measurement                  | `lossBits = magBits(z) - magBits(zeta0)` in `clgammaReflect`    | `complex.ts:484-486`; `special.ts:216-218` |
| Cancellation-driven precision bump              | `work = prec + 32 + lossBits` in `clgammaReflect`               | `complex.ts:486`; `special.ts:218`   |
| Retry loop on cancellation                      | `evaluatePFq` outer loop                                        | `pfq.ts:364-410`                     |
| Asymptotic series with smallest-term truncation | `lgammaStirling` Bernoulli loop                                 | `special.ts:131-159`                 |
| Optimal-truncation detection (term-mag growth)  | `if (termMag > prevTermMag) break;`                             | `special.ts:152-154`; `complex.ts:374` |
| `magBits` helper for log₂\|x\| estimate          | `magBits` in `complex.ts`, `zMagBits` in `special.ts`           | `complex.ts:385-394`; `special.ts:243-247` |
| Quadrant-reduction-then-compute                 | `reduceModPiOver2` for sin/cos                                  | `transcendental.ts:502-519`          |
| Argument-reduction by halving (sqrt(prec))      | `m = ceil(sqrt(prec))` in `exp` and `sinCosSmall`               | `transcendental.ts:217, 598`         |
| Smith-style stable complex division             | `cdiv` Smith's algorithm                                        | `complex.ts:124-146`                 |
| Algebraic-sign detection avoiding `sin(πz)=0`   | `(-1)^m · sgn(ζ)` in `gamma`                                    | `special.ts:289-303`                 |
| Newton iteration with quadratic convergence     | (none yet — bigErfInv would be the first)                       | n/a — establishes the pattern         |
| Reflection-formula branch via `Re(z) < ½`       | `clgammaReflect`, `cdigammaReflect` dispatch                    | `complex.ts:300, 559`                |
| Float64-seeded heuristic (`xFloat = toFloat64(x).value`) | `exp`'s `kEstimate`                                    | `transcendental.ts:203`              |
| BigFloat invariant: top-bit-set, `precision` bits | `normalise` post-process at all entry points                   | `types.ts` (normalise definition)    |
| Side-effect-free import / no top-level work     | All `bigfloat/src/*.ts` are pure modules                        | (entire package, by construction)    |
| `if (isZero(x)) return canonical-zero` short-circuit | every transcendental's first line                          | `transcendental.ts:193, 359, 391, …` |
| Doc-comment as exposition                       | `clgammaReflect`'s 35-line motivation comment                    | `complex.ts:417-450`                 |

## 7.1 Specific code-snippet matches

**Series-with-recurrence pattern.** `bigErfSeries` follows the same
shape as `expm1`'s Taylor (`transcendental.ts:362-385`):

```ts
// Pattern from transcendental.ts (expm1) — adopt verbatim shape:
let sum: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
let term: BigFloat = fromInt(1n, work);
const stopThreshold = -(prec + 16);
for (let n = 1; ; n++) {
  term = div(mul(term, x, work), fromInt(n, work), work);
  sum = add(sum, term, work);
  if (term.mantissa === 0n ||
      term.exponent + bitLength(...) < stopThreshold) break;
  if (n > work + 1000) break;
}
```

**Asymptotic-with-divergence-detect pattern.** `bigErfcAsymptotic`
follows `lgammaStirling` (`special.ts:131-159`):

```ts
// Pattern from special.ts (lgammaStirling) — adopt verbatim shape:
let prevTermMag = Infinity;
for (let m = 0; m <= 300; m++) {
  // compute term_m via recurrence
  const termMag = term.exponent + bitLength(...);
  if (termMag < -prec - 16) {
    result = add(result, term, work);
    break;
  }
  if (termMag > prevTermMag) {  // divergence — stop *before* adding
    break;
  }
  result = add(result, term, work);
  prevTermMag = termMag;
}
```

**Reflection-formula precision-bump pattern.** `bigErf` complex
near-Stokes (Re z² < 0) follows `clgammaReflect`
(`complex.ts:451-536`):

```ts
// Estimate cancellation depth before computing anything heavy:
const reZ2 = sub(mul(z.re, z.re, prec), mul(z.im, z.im, prec), prec);
const lossBits = sgn(reZ2) < 0 ? Math.ceil(Math.abs(toFloat64(reZ2).value) * Math.LOG2E) : 0;
const work = prec + 32 + lossBits;
// then compute the series with `work` bits of headroom
```

**Per-prec cache pattern.** Karbach coefficients follow `pi(prec)`:

```ts
// Pattern from transcendental.ts:131-144 — adopt verbatim shape:
let _karbachCache = new Map<number, KarbachData>();
function karbachCoeffs(prec: number): KarbachData {
  const cached = _karbachCache.get(prec);
  if (cached) return cached;
  // ... generate at `work = prec + 32`
  const data = { ... };
  _karbachCache.set(prec, data);
  return data;
}
```

(`pi` uses a single-entry cache because there's only one π; Karbach
needs a per-prec map because the table values differ per prec. Same
discipline, different cardinality.)

---

# 8. Wire-shape, ToolDefinition, and `arbprec: true` contract

This research is for the substrate; tool exposure is downstream. For
completeness, the eventual `bigErf` tool will:

- Have `arbprec: true` (ADR-0020 §1).
- Inherit the standard `--precision=<int>` flag.
- Input schema: `bigfloatSchema` (real) or `bigcomplexSchema` (complex).
- Output schema: same.
- Bit-deterministic cross-platform forever (BigInt + integer exp).

Per ADR-0022, BigComplex tools that operate on the imaginary axis
benefit from the codomain-quadrature pattern; not relevant for this
substrate primitive but worth noting that downstream `bigCErf` users
who feed quadrature integrands should follow ADR-0022 conventions.

---

# 9. Frictions surfaced during research

Things that *looked* clean but cost an hour each to nail down:

1. **DLMF 7.6.1 vs 7.6.2 confusion.** The textbook Maclaurin (7.6.1)
   has alternating signs and is "the" series in most algebra-system
   outputs. The numerically usable form is 7.6.2, which most CASs hide
   behind a `Kummer[…]` transform on `M(½, 3/2, -z²)`. Spent considerable
   time chasing what "the Maclaurin series" actually is *in practice*
   (mpmath uses 7.6.2 via `hyp1f1`; Arb uses 7.6.2 directly; Boost only
   talks about its `[a, b)` rational fits and doesn't quote a closed
   form). Resolution: pin the source code to 7.6.2 explicitly, and add
   a doc-comment paragraph distinguishing the two forms.

2. **Karbach truncation formula N(prec).** Karbach gives the explicit
   `(N = 23, τ_m = 12)` for double precision and the *condition* "highest
   Fourier coefficient smaller than machine precision" but no closed-form
   in `prec`. Had to re-derive the inversion. Resolution: §4.4 gives the
   formula, tested against Karbach's numbers (`N=23 ⟹ prec=53` ✓).

3. **Faddeeva.cc's 5-sum kernel is double-precision specific.** Steven
   G. Johnson's implementation uses a precomputed `expa2n2[53]` table for
   `relerr == DBL_EPSILON` and falls back to on-the-fly computation
   otherwise. The on-the-fly path is the right pattern for arbitrary
   precision but the algorithm structure (5 sums: sum1..sum5 with
   different convergence rates) is over-engineered for a single-prec
   target. Karbach's single-sum is simpler at the cost of marginally
   more terms.

4. **Berry smoothing isn't actually a Stokes-line problem for `bigErfc`
   itself.** I initially thought the bead `ybrw` (`bigErfc` in Berry-
   smoothed Stokes band) needed *bigErfc to handle the Stokes line of
   its own asymptotic*. Rereading DLMF 2.11.15: the smoothing formula
   *uses* `½ erfc(½ ρ^½ c(θ))` to smooth some *other function's* Stokes
   transition. The argument to that `erfc` is `O(√prec)` — squarely in
   the asymptotic regime, no special handling needed. **`ybrw` is a
   consumer, not a producer, of arbitrary-precision erfc.** Documented
   in §1.4.

5. **Boost.Math's "incomplete gamma fallback" for cpp_bin_float.** Boost
   says generic arbitrary-precision erf goes through `gamma_inc`. This
   is *correct* algebraically (`erf(x) = γ(½, x²) / √π`), but for our
   substrate it's worse than the direct series/asymptotic split because
   `gamma_inc` itself uses a series-or-CF dispatch — adding indirection
   without benefit. Resolution: don't follow Boost here; their choice
   is for "we already have an incomplete gamma so why duplicate the
   dispatch logic?" — not a recommendation against the direct approach.
   (Worth a one-line dismissive note in the source doc-comment.)

6. **The arbitrary-precision Faddeeva ecosystem is thin.** mpmath has it
   (via `hyperu` and `hyp1f1`); Arb has it (via `acb_hypgeom_erf` and
   relations); SpecialFunctions.jl uses MPFR `mpfr_erf` and `libcerf`
   (double-precision) — no arbitrary-precision Faddeeva. Mathematica
   has it but the algorithm is unpublished. Karbach 2014 is the only
   *published* algorithm with closed-form prec scaling. Resolution:
   pick Karbach; cite that no better public reference exists.

---

# 10. References cited

- **DLMF** = NIST Digital Library of Mathematical Functions
  (dlmf.nist.gov). Chapters cited: 7.6 (series), 7.9 (continued
  fractions), 7.10 (derivatives, recurrences), 7.12 (asymptotic),
  7.17 (inverse functions), 2.11 (Stokes phenomenon / Berry smoothing).
- **Cody, W. J.** (1969). "Rational Chebyshev Approximations for the
  Error Function." *Math. Comp.* 23, 631–637.
- **Schonfelder, J. L.** (1978). "Chebyshev expansions for the error and
  related functions." *Math. Comp.* 32, 1232–1240.
- **Hunter, D. B. & Regan, T.** (1972). "A note on evaluation of the
  complementary error function." *Math. Comp.* 26, 539–541.
- **Karbach, T. M., Raven, G., Schiller, M.** (2014). "Decay time
  integrals in neutral meson mixing and their efficient evaluation."
  arXiv:1407.0748. (The "Karbach 2014" cited throughout.)
- **Poppe, G. P. M. & Wijers, C. M. J.** (1990). "More efficient
  computation of the complex error function." *ACM TOMS* 16, 38–46.
  (Algorithm 680.)
- **Weideman, J. A. C.** (1994). "Computation of the complex error
  function." *SIAM J. Numer. Anal.* 31, 1497–1518.
- **Zaghloul, M. R. & Ali, A. N.** (2011). "Algorithm 916: Computing
  the Faddeyeva and Voigt functions." *ACM TOMS* 38, Article 15.
- **Johnson, S. G.** (2012). Faddeeva package. Source:
  http://ab-initio.mit.edu/Faddeeva.cc (downloaded; analysed in §5).
- **Blair, J. M., Edwards, C. A., Johnson, J. H.** (1976). "Rational
  Chebyshev approximations for the inverse of the error function."
  *Math. Comp.* 30, 827–830. (The "Blair 1976" Newton initial-guess
  tables used by Julia SpecialFunctions.jl and mpmath.)
- **Strecok, A. J.** (1968). "On the calculation of the inverse of the
  error function." *Math. Comp.* 22, 144–158. (Predecessor to Blair
  1976; first systematic erfinv approximation.)
- **Brent, R. P.** (2010). "Algorithms for multiple-precision evaluation
  of special functions." (Lecture notes / survey.)
- **mpmath** source: `mpmath/functions/expintegrals.py` (erf,
  _erf_complex, erfc, _erfc_complex, erfi, erfinv) — analysed in §1.7,
  §6.2.
- **Arb / FLINT** source: `src/arb_hypgeom/erf.c`,
  `src/acb_hypgeom/erf.c` — analysed in §1.2, §2.2, §2.4. Confirms
  crossover threshold `x²·log₂(e) + log₂(|z|) > prec`.
- **SpecialFunctions.jl** (Julia) source:
  `src/erf.jl` — `_erfcx(::BigFloat)` asymptotic, `_erfinv(::BigFloat)`
  and `_erfcinv(::BigFloat)` Newton — analysed in §1.8, §6.
- **Boost.Math** docs:
  `libs/math/doc/html/math_toolkit/sf_erf/error_function.html` and
  `error_inv.html` — for the rational-approximation-tier discussion.
- **libcerf** (cited via Karbach 2014 §5.2): C library by W. Gautschi,
  M. Zaghloul, et al. — performance reference but not algorithmic
  innovation.
- **Cuyt et al.** (2008). *Handbook of Continued Fractions for Special
  Functions.* (DLMF 7.9 source.)

---

# 11. Pointer to companion artefacts

- **R1** `R1-symbolic-identities.md` (this directory) — symbolic
  identities and value-protocol shape for erf-family return values.
  Cited from §2.4 for the `erf ↔ erfc ↔ w ↔ erfcx` algebraic relations.
- **Bead `ybrw`** — `bigErfc(x, prec)` arbprec, the immediate downstream
  consumer. The Berry-smoothing Stokes-band call site for `bigErfc`.
  Confirmed in §1.4 that the consumer is *user* of the substrate, not a
  *producer* of a new algorithm.
- **Bead `R2`** (this document) — research artefact.
- **`packages/bigfloat/src/cgamma.ts`** — the stylistic exemplar. Every
  §2-§5 recommendation cites a matching idiom in `cgamma.ts` /
  `clgamma.ts` / `cdigamma.ts`.
- **`packages/hypergeometric/src/pfq.ts`** — the cancellation-retry
  exemplar. The outer-loop pattern from `evaluatePFq` is the template
  for `bigErf`'s precision-retry on complex arguments where the loss is
  not algebraically predictable.
- **ADR-0020** — the `arbprec: true` contract and the
  `--precision=<int>` flag standardization. All erf-family tools that
  export this substrate inherit those.
- **ADR-0022** — BigComplex codomain conventions. Relevant for any
  downstream tool that uses `bigCErf` as an integrand.

---

# 12. Implementation order (recommended)

1. **`bigErfSeries(x: BigFloat, prec)`** — DLMF 7.6.2, real-only. ~30 lines.
2. **`bigErfcAsymptotic(x: BigFloat, prec)`** — DLMF 7.12.1, real-only.
   ~30 lines. Mirrors `lgammaStirling` shape.
3. **`bigErf(x: BigFloat, prec)`** — dispatcher with the `x_c` crossover.
   ~30 lines.
4. **`bigErfc(x: BigFloat, prec)`** — symmetric dispatcher. ~30 lines.
5. **`bigErfcx(x: BigFloat, prec)`** — direct asymptotic path + dispatch
   to `exp(x²)·bigErfc(x)` below crossover. ~25 lines.
6. **`bigErfi(x: BigFloat, prec)`** — `bigErfi(x) = exp(x²)·w_im(x)`.
   Real-axis Faddeeva — can implement via direct series (Dawson-related)
   without needing full `bigW`. ~30 lines.
7. **`bigErfInv(y, prec)`** — Newton on `bigErf`. ~40 lines.
8. **`bigErfcInv(y, prec)`** — Newton on `bigErfc` + erfcx-aware step.
   ~50 lines.
9. **`bigW(z: BigComplex, prec)`** — Karbach-Weideman. ~80 lines.
10. **`bigCErf`, `bigCErfc`, `bigCErfcx`, `bigCErfi`** — algebraic
    combinations of `bigW`. ~80 lines combined.

**Total: ~425 lines** for the full substrate. Comparable to `complex.ts`
(711 lines) which carries `clgamma + clgammaReflect + cdigamma +
cdigammaReflect + csqrt + cexp + clog + cpow + cabs + carg + cmul +
cdiv + …`.

Land 1-5 first (bead `ybrw` is unblocked once `bigErfc` ships); 6-8
follow; 9-10 close the complex path. Each step gets ~80-200 tests
(property-based for symmetries, golden against Wolfram + mpmath
agreement at 110 dps per the tstournament-13 oracle strategy).

---

*End of R2. The full implementation is ~425 lines of TypeScript on
~3500 lines of existing substrate, all algorithm choices cited, all
crossover thresholds derived.*
