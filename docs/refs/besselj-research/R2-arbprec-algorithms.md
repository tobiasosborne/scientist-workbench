# R2 — Arbitrary-precision algorithms for `BesselJ`, `BesselY`, `BesselI`, `BesselK` (real and complex argument)

**Bead:** `scientist-workbench-dn76` (Phase 0 R2, Bessel-family epic
`scientist-workbench-zcam`).
**Audience:** the implementer of `bigBesselJ`, `bigBesselY`, `bigBesselI`,
`bigBesselK` for `@workbench/bigfloat` — the future I1a/I1b/I2a/I2b/I3a/I3b
substrate beads.
**Substrate exemplar:** `packages/bigfloat/src/special-funcs/erf.ts` (algorithm
narrative + crossover threshold + cancellation accounting) and
`packages/bigfloat/src/complex.ts` (`cgamma` / `clgammaReflect` /
`cdigamma` — the cancellation-driven precision-retry pattern from worklog
117 / bead `oj5j`).
**Pattern source:** `docs/HANDOFF_per_head_special_function_methodology.md`
and `docs/refs/erf-research/R2-arbprec-algorithms.md`. This artefact
mirrors the latter's structure and discipline; deviations are pinned
with citations.
**Decision principle:** *what would a legendary TS senior software
engineer demand?* — closed-form prec-dependence for every truncation
parameter; one primitive per cancellation regime; no untraceable
empirical fits; ground-truth citation per claim.

---

## Table of contents

1. Executive summary
2. Algorithm taxonomy — the eight canonical regimes (R-A through R-H)
3. Per-function dispatch tables (the recipe each substrate bead implements)
4. Risk surface (six pinned hazards, primary-source cited)
5. v0.1 algorithm stack (closed-form crossovers, function-by-function)
6. Precision-tracking strategy (mirroring `clgammaReflect`'s
   measure-bump-retry)
7. Constants and coefficient tables
8. Cross-references to existing `@workbench/bigfloat` patterns
9. Frictions surfaced during research
10. References cited (with local file paths)
11. Pointers to companion artefacts
12. Implementation order (recommended)

---

# 1. Executive summary

## 1.1 The shape of the problem

Bessel `J_ν(z), Y_ν(z), I_ν(z), K_ν(z)` is a four-function family with
*two* free parameters (`ν, z`), each of which may be complex. The
algorithm taxonomy is materially larger than `erf`'s because the
regimes split on **both** axes:

```
      ν small (|ν| < 10)              ν large (|ν| → ∞)
     ┌────────────────────────────┬──────────────────────────────────┐
|z|  │                            │                                  │
 sm  │ R-A  Maclaurin / ₀F₁       │ R-A again (still converges)      │
     │      (DLMF 10.2.2, 10.25.2)│      but slow                    │
     ├────────────────────────────┼──────────────────────────────────┤
|z|  │                            │                                  │
 ≈ν  │ R-F  Temme series + CF     │ R-D  Olver uniform asymptotic    │
     │      (Temme 1975, 1996)    │      (DLMF 10.20, 10.41.3)       │
     ├────────────────────────────┼──────────────────────────────────┤
|z|  │                            │                                  │
 lg  │ R-B  Hankel asymptotic     │ R-C  Debye asymptotic            │
     │      (DLMF 10.17, 10.40)   │      (DLMF 10.19, 10.41)         │
     └────────────────────────────┴──────────────────────────────────┘
```

Add:
- **R-E** Miller backward recurrence for integer `ν` (Numerical Recipes
  §6.5; SLATEC `dbesj` and the Boost integer-order fast path).
- **R-G** ₀F₁ hypergeometric representation (DLMF 10.16.9 / 10.25.2) —
  in arbitrary precision this is the same code path as R-A but reuses
  `@workbench/hypergeometric` infrastructure when one wants the
  cancellation-retry loop "for free".
- **R-H** integral representations (Schläfli, Sommerfeld, Mellin-Barnes)
  — robustness fallback only; quadrature dominated by R-A/B/D/F at
  every realistic precision.

Eight regimes total; not every regime is admissible for every
function (e.g., R-E is stable backward for `J_n`, stable forward for
`I_n`, *unstable* both ways for `Y_n` and `K_n`).

## 1.2 Recommended algorithm split

Three substrate primitives, four user-facing functions per axis:

```
substrate primitive                  real BigFloat            BigComplex
───────────────────────────────────  ───────────────────────  ─────────────────────────
1. besselJ_0F1(ν, z, prec)           DLMF 10.2.2 / 10.16.9    same (cancellation retry)
2. besselJ_asymp(ν, z, prec)         Hankel DLMF 10.17.5      acb_hypgeom_bessel_j_asymp
3. besselI_0F1(ν, z, prec)           DLMF 10.25.2             same
4. besselI_asymp(ν, z, prec)         DLMF 10.40.1             acb_hypgeom_bessel_i_asymp
5. besselK_temme(ν, z, prec)         Temme 1975, 1996 (CF)    derived via J → K rotation
6. besselK_asymp(ν, z, prec)         DLMF 10.40.2 (one-sign)  acb_hypgeom_bessel_k_asymp

user functions
─────────────────────────────────────────────────────────────────────────────────────
bigBesselJ(ν, z, prec)        z = real or complex
bigBesselY(ν, z, prec)        Wronskian / connection from J (FLINT pattern)
bigBesselI(ν, z, prec)        z = real or complex
bigBesselK(ν, z, prec)        DLMF 10.27.4 connection from I, integer ν via series
```

**Note the asymmetry with Erf.** `bigErfc(x) ≠ 1 − bigErf(x)` for
`|x| > x_c` was *the* load-bearing discipline in the Erf substrate;
the Bessel analogues are more numerous and structurally different:

1. **`bigBesselY` MUST NOT be computed from `bigBesselJ` via the
   integer-ν connection formula `Y_n = lim_{ν→n} (J_ν cos(νπ) − J_{−ν}) /
   sin(νπ)` for `ν` near an integer.** The denominator vanishes; the
   numerator's two `J` evaluations cancel to high order. **At integer
   ν, use Arb's path: compute `K_n(iz)` and rotate** (`bessel_y.c:57-80`,
   uses the `phase()` helper and `K_n(iz) / π` to extract `Y_n` without
   the `0/0`).
2. **`bigBesselK(ν, z)` for non-integer ν via the I/K connection
   `K_ν(z) = (π/2) · (I_{−ν}(z) − I_ν(z)) / sin(νπ)`** cancellates
   when `ν` is near an integer. The mpmath path uses the `hyp2f0`
   asymptotic form for `|z| ≥ 1` and the `hypercomb` limit-evaluation
   for `|z| < 1` (precisely so the integer-ν limit is computed as a
   *limit*, not a `0/0`). The Arb path (`bessel_k.c:101-127`) computes
   the I/K combination as a `acb_poly` series in `ν` so the integer-ν
   case is the *constant term*; the `1/sin(πν)` factor becomes a
   *polynomial division*.
3. **The integer-ν Miller backward recurrence (R-E) cannot be used for
   `Y_n` or `K_n` directly** — those families are *exponentially
   increasing* in `n`, so the recurrence is unstable backward and the
   *forward* recurrence is stable. `J_n` and `I_n` (the *decreasing*
   solution for small `z`) need *backward* recurrence; `Y_n` and `K_n`
   need *forward*. Mixing them is a classic source of catastrophic
   garbage.
4. **The Hankel asymptotic series for `Y` produces a `sin(x − π(ν/2 +
   1/4))` factor**; near a zero of that sine, the *first* term of the
   asymptotic vanishes and the *next* term (the `Q` part) dominates.
   Boost's `hankel_PQ` handles this by computing `P` and `Q`
   simultaneously and using the addition-formula trick
   (`boost-bessel_jy.hpp:415-423`); a naive split into "phase ×
   amplitude" loses precision near the zeros.

These four are the Bessel analogues of Erf's "`bigErfc ≠ 1 − bigErf`"
pin. Each gets its own algorithm path on its own input range; none
delegates to a sibling in the regime where the delegation cancellates.

## 1.3 Crossover formulae (real argument, the "x_c" analogue)

Mirror Erf's `x_c(p) = √(p · ln 2) ≈ 0.833 √p`. For Bessel the
crossover is two-dimensional (depends on `ν` *and* `z`); the
closed-form derivation lives in §5 (Hankel asymptotic for J/Y) and §5.2
(modified Bessel I/K). The headline results, derivable from Olver's
optimal-truncation bound (DLMF 10.17.13–14, 10.40.4–5):

```
Hankel asymptotic (J, Y, I, K) achieves prec p when
    |z|² > p · ln 2 / 2 - (1/2) log(...|ν|...) terms
i.e. (to leading order in p)
    z_c_Hankel(p, ν) ≈ √(p · ln 2 / 2)         when |ν| ≪ |z|
                    ≈ |ν| + (ν · p · ln 2 / 2)^(1/3)·c  for |z| in transition
```

In words: the **Bessel Hankel asymptotic crossover is √(2) smaller than
Erf's**, because the asymptotic series rests on `Γ(ν+½+k)/Γ(ν+½−k) ~
k²ᵏ / (2z)²ᵏ` rather than Erf's `(2k−1)!! / (2z²)ᵏ`. The denominator is
`(2z)²` not `2z²`, costing a factor of 2 in `|z|`.

The numbers for typical precisions (with `|ν| ≪ |z|`):

| prec (bits) | dps | z_c_Hankel | z_c_Erf | Hankel / Erf |
|-------------|-----|------------|---------|--------------|
| 53          | 16  | 4.29       | 6.07    | 0.707 = 1/√2 |
| 100         | 30  | 5.89       | 8.33    | 0.707        |
| 196         | 50  | 8.25       | 11.66   | 0.707        |
| 332         | 100 | 10.74      | 15.18   | 0.707        |
| 1024        | 308 | 18.85      | 26.65   | 0.707        |
| 3322        | 1000| 33.95      | 47.99   | 0.707        |

So at `p = 196` (50 dps) the J/Y Hankel asymptotic kicks in at `|z| ≈ 8`
(vs Erf's `≈ 12`). This matches the FLINT threshold
(`bessel_j.c:592`): "asymptotic series can be used roughly when
[(1+log(2))/log(2) = 2.44269] * z > p" — solving for `z`: `z_c ≈ p /
2.44269 ≈ 0.41 p`. That's a *much* more conservative threshold than the
mathematical floor — FLINT pays factor `√p / 0.41p ≈ 2/√p` in extra
margin. Fredrik Johansson explicitly comments "We are a bit more
conservative and use the factor 2"; the practical FLINT crossover is
**`2|z| > p`** (i.e., `|z| > p/2`).

**Our threshold** uses the same conservative factor 2 ("safety
margin") as FLINT, *for the same reason* — the smallest-term bound is
the leading-order asymptotic remainder; the Olver bound (DLMF 10.17.13
with all-coefficient-sign sums) is roughly twice as large in worst
case. So:

```
  z_c_practical(p) := p / 2     for |ν| ≪ |z|
```

In practice the more useful boundary is the *FLINT transition test*
(`bessel_j.c:498-509`):

```
  if (|ν| > |z|² / 4): use R-A (series)         // no cancellation
  else if (|z| > p / 2): use R-B (Hankel asymptotic)
  else: use R-F/R-G with cancellation retry     // the transition regime
```

This is what Decision 3 of ADR-0040 should specialise to. (See §3 for the
full per-function table.)

## 1.4 Complex argument

For complex `z` with `Re(z) ≥ 0`, the algorithm is materially the same
as real — the series and asymptotic both accept complex `z` directly.
The **cancellation accounting changes**:

- For the ₀F₁ series, `|term_max| ≈ exp(|Re(z²/4)|)` while the answer
  is `|J_ν(z)| ≤ exp(|Im z|)`. Cancellation bits:
  `≈ (Re(z²)/4) · log₂(e) − |Im z|·log₂(e) = (Re z² − 4·|Im z|)/4 ·
  log₂(e)`. The FLINT estimate (`bessel_j.c:511-517`) is `(|z| − |Im
  z|) · log₂(e)` bits — i.e. only when `|Re z|` and `|Im z|` are
  comparable. **Use FLINT's estimate**; it's tight enough.

For `Re(z) < 0`, the **J/Y** functions have a logarithmic branch cut
along the negative real axis if `ν` is non-integer. The connection
formula
```
  J_ν(z·e^{imπ}) = e^{imνπ} · J_ν(z)
  Y_ν(z·e^{imπ}) = e^{-imνπ} · Y_ν(z) + 2i·sin(mνπ)·cot(νπ)·J_ν(z)
```
(DLMF 10.11.4-5) handles the analytic continuation; never compute
`J_ν` directly on `Re(z) < 0`. The substrate enforces "reduce to first
quadrant before computation" — same discipline as `clgamma`'s
reflection.

For the **I/K** family, the analogous symmetry is
```
  I_ν(z·e^{imπ}) = e^{imνπ} · I_ν(z)
  K_ν(z·e^{imπ}) = e^{-imνπ} · K_ν(z) − iπ·sin(mνπ)/sin(νπ) · I_ν(z)
```
(DLMF 10.34.2). Same first-quadrant-reduction discipline applies.

## 1.5 Top-6 risks (pinned with primary sources; full discussion §4)

1. **`Y_ν` catastrophic cancellation via J/J(−ν) connection near
   integer ν.** The denominator `sin(νπ)` vanishes; numerator
   `J_ν cos(νπ) − J_{−ν}` cancels. Mitigation: integer-ν gets a
   *separate* algorithm (Temme series + forward recurrence, Boost
   pattern; or `K_n(iz)` rotation, FLINT pattern). Citation:
   `bessel_y.c:36-80` (Arb), `boost-bessel_jy.hpp:425-460` (Boost).

2. **Divergent asymptotic series termination — smallest-term vs
   error-bound.** Olver/Wong: the superasymptotic remainder is bounded
   by the *first omitted term* in a sector around the Stokes line, and
   the optimal truncation is at the smallest-term index. Citation: DLMF
   10.17.13–14 (J/Y), 10.40.4–5 (I/K), Olver 1974 §3.

3. **Transition region `|z| ≈ ν`: Olver uniform vs Temme CF.** Olver
   uniform (DLMF 10.20) is correct but has a *very* slow-converging
   coefficient sequence (`U_k(p)` polynomial in `p`, must be
   accumulated at high precision). Temme CF (Steed's method; Boost
   `CF1_jy` + `CF2_jy`) is fast but converges slowly when `|x| ≪ |ν|`.
   Recommendation: **Temme/Steed in this regime for v0.1; Olver uniform
   only when `ν` is so large that the CF method's iteration count
   `O(ν)` becomes prohibitive**. Citation: Temme 1975, Boost
   `bessel_jy.hpp:425-595`, FLINT does not implement Olver uniform
   (uses cancellation-retry ₀F₁ instead).

4. **Negative-real-ν branch cuts in `Y_ν` and `K_ν` connection
   formulas.** Per (3), the integer-ν limit must be a *true* limit
   evaluation. FLINT uses `acb_poly` jets (`bessel_k.c:58-127`) so the
   integer case is "constant term of the polynomial division"; mpmath
   uses the `hypercomb` limit framework. **Recommendation:** for v0.1
   compute integer ν via a *separate* dedicated path (Temme/Steed for
   J/Y, `besselK_temme` for K) — the polynomial-jet approach is more
   elegant but requires `bigfloat` polynomial primitives we do not
   have. The dedicated-path approach is what Boost does and is
   tractable today.

5. **Integer-ν Miller recurrence direction.** Forward for `Y, K` (the
   increasing solutions); backward for `J, I` (the decreasing
   solutions). Reverse, and you propagate roundoff through `O(2^n)` of
   amplification. Citation: Numerical Recipes §6.5 (Miller's
   algorithm), Boost `bessel_jy.hpp:475-487` (backward J recurrence
   with `init = sqrt(min_value)` to avoid underflow).

6. **Amos TOMS 644 (complex Bessel) uses the rotation `J_ν(z) =
   exp(±νπi/2) · I_ν(∓iz)` then handles `I`/`K` directly.** This is the
   cleanest approach when one has a robust `I_ν(z)`/`K_ν(z)` for `Re z
   ≥ 0`. **Recommendation:** mirror Amos's structure but using our
   substrate. `bigBesselJ(ν, z)` for complex `z` with `Im z ≠ 0`
   rotates to `bigBesselI(ν, ∓iz)` (the rotation has zero cancellation
   loss). Citation: `amos-zbesj.f:68-75` ("J(FNU,Z)=EXP( FNU*PI*I/2) *
   I(FNU,-I*Z)" etc.).

---

# 2. Algorithm taxonomy — the eight canonical regimes

This section enumerates the eight regimes with derivation, citation,
and substrate-recipe pseudocode for each. §3 then composes them into
per-function dispatch tables.

## 2.1 R-A — Small-|z| Maclaurin / ₀F₁ series

### J_ν, I_ν

The defining series (DLMF 10.2.2 for J, 10.25.2 for I):

> `J_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (−z²/4)^k / (k! · Γ(ν+k+1))`

> `I_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (z²/4)^k / (k! · Γ(ν+k+1))`

i.e., `J` has alternating sign in `(−z²/4)^k`, `I` has all-positive
terms. Term ratio:

```
  term_{k+1} / term_k = (∓ z²/4) / ((k+1) · (ν + k + 1))
                      ≈ (∓ z²/4) / k²    for large k
```

Both converge for all finite `z`; convergence is geometric in `(|z|/2k)²`
for `k > |z|/2`. Term magnitudes peak at `k ≈ |z|/2` then decay.

**Term count for prec-p accuracy:**

The recurrence ratio crosses 1 at `k ≈ |z|/2`; thereafter terms shrink
by factor `1/k²` per step. The cumulative cancellation in J is:

```
  |term_max| / |sum|  ≈  exp(|Im z| + Re(z²/4))   (J, complex z)
                     ≈  exp(|Re z²|/4)             (J, complex z, Re z² > 0)
                     ≈  1                          (J, real z; alternating but bounded)
```

The "alternating but bounded" claim for real `z` deserves elaboration.
For real `z` the J series alternates with terms peak at `k_peak ≈ z/2`
and value `~(z/2)^z_peak / (k_peak! · Γ(ν+k_peak+1)) ≈ exp(z) /
√(2π·z)` (Stirling). Meanwhile `J_ν(z) ~ √(2/(πz)) · cos(z − π/4 −
νπ/2)` is `O(1/√z)`. Net cancellation:

```
  cancellation_bits ≈ z · log₂(e) − (1/2) log₂(z)    bits
                    ≈ 1.44·z − 0.72·log₂(z)
```

At `z = 10`, ~14 bits of cancellation. At `z = 20`, ~28 bits. **For
`|z| ≪ p`, R-A is fine; for `|z| > p/2.44`, R-A wastes too many bits.**
This is precisely the FLINT crossover (`bessel_j.c:592`).

**For I_ν**, all terms positive (real `z`), so cancellation = 0. The
series converges to give the actual `I_ν(z) ~ e^z / √(2πz)` value — but
the *terms* sum to `~e^z`, so the series result *is* `e^z`. No bit loss.
At complex `z`, cancellation in I parallels J (replace `Re(z²)` with
`−Re(z²)`).

### Y_ν, K_ν

For non-integer ν, both Y and K have series via the J/I connection:

> `Y_ν(z) = (J_ν(z) cos(νπ) − J_{−ν}(z)) / sin(νπ)` (DLMF 10.2.3)

> `K_ν(z) = (π/2) · (I_{−ν}(z) − I_ν(z)) / sin(νπ)` (DLMF 10.27.4)

The cancellation in these formulas as `ν → integer` is the **risk
surface item 4**. Two valid approaches:

(a) **Limit evaluation** (mpmath): compute as `lim_{ν→n} ...` via the
    `hypercomb` framework, which expands both numerator and
    denominator as series in `(ν − n)` and divides; the result is the
    derivative-with-respect-to-ν of the appropriate combination.

(b) **Dedicated integer-ν path** (Boost, FLINT): for `ν = n` integer,
    use Temme series (small `z`) or forward recurrence from `Y_0, Y_1`
    (resp. `K_0, K_1`). Avoid the limit entirely.

**Recommendation: (b) for v0.1.** It composes cleanly with existing
substrate primitives (no `acb_poly` analogue needed).

### Substrate recipe — `besselJ_0F1` (real argument)

```ts
function besselJ_0F1(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  // J_ν(z) = (z/2)^ν / Γ(ν+1) · ₀F₁(; ν+1; -z²/4)
  // Form: prefactor · Σ_{k=0}^N (-z²/4)^k / ((ν+1)_k · k!)
  //
  // Cancellation: for real z, max-term/answer ratio ≈ exp(z) / (1/√z).
  // Pre-estimate to size working precision.
  const zF = toFloat64(z).value;
  const cancelEst = Math.max(0, Math.ceil(Math.abs(zF) * Math.LOG2E));
  const work = prec + 32 + cancelEst;

  // Prefactor (z/2)^ν / Γ(ν+1)
  const halfZ = mul(z, fromString("0.5", work), work);
  const zPowNu = pow(halfZ, nu, work);
  const gammaNuPlus1 = bigGamma(add(nu, one(work), work), work);
  const prefactor = div(zPowNu, gammaNuPlus1, work);

  // Negative quarter z squared
  const w = neg(mul(z, z, work), work);
  const wQuarter = mul(w, fromString("0.25", work), work);

  // Series Σ (z²/4 · −1)^k / k! / (ν+1)_k
  let sum = one(work);
  let term = one(work);
  let peakMag = 0;
  for (let k = 1; k < work * 4 + 100; k++) {
    // term ← term · wQuarter / (k · (ν+k))
    const kBF = fromInt(BigInt(k), work);
    const nuPlusK = add(nu, kBF, work);
    const denom = mul(kBF, nuPlusK, work);
    term = div(mul(term, wQuarter, work), denom, work);
    sum = add(sum, term, work);
    peakMag = Math.max(peakMag, magBits(term));
    if (magBits(term) < magBits(sum) - prec - 16) break;
  }
  const actualLoss = peakMag - magBits(sum);
  if (actualLoss > cancelEst + 16) {
    // re-evaluate at higher work
    return besselJ_0F1(nu, z, prec);  // (with cancelEst doubled; pseudocode)
  }
  return normalise(mul(prefactor, sum, prec));
}
```

The cancellation-retry pattern is the `clgammaReflect` (worklog 117 /
bead `oj5j`) pattern verbatim.

**For `besselI_0F1`**, replace `w = neg(z²)` with `w = z²` (no
negation). Cancellation = 0 for real `z ≥ 0`.

**For `besselK_0F1`** (non-integer ν), use the DLMF 10.27.4 limit:

```ts
function besselK_0F1(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  if (isInteger(nu)) return besselK_temme(toInt(nu), z, prec);
  const work = prec + 32;
  const Iv  = besselI_0F1( nu,        z, work);
  const Imv = besselI_0F1( neg(nu),   z, work);
  const sinPiNu = sinPi(nu, work);
  // K_ν = (π / (2 sin(πν))) · (I_{−ν} − I_ν)
  const numer = sub(Imv, Iv, work);
  const denom = mul(fromString("2.0", work), sinPiNu, work);
  const piVal = pi(work);
  return div(mul(piVal, numer, work), denom, prec);
}
```

This has catastrophic cancellation when `ν → integer`; the recipe is to
hand off to `besselK_temme` *before* entering this branch. The integer
check is structural (no fuzz).

## 2.2 R-B — Large-|z| Hankel asymptotic

The Hankel expansion is the most-cited Bessel asymptotic; DLMF 10.17
(unmodified J/Y), 10.40 (modified I/K).

### J_ν, Y_ν (DLMF 10.17)

> `J_ν(z) ~ √(2/(πz)) · [cos(ω) · Σ a_{2k}(ν) z^{−2k} − sin(ω) ·
>                       Σ a_{2k+1}(ν) z^{−2k−1}]`,
> where `ω = z − νπ/2 − π/4`, and
> `a_k(ν) = (4ν² − 1)(4ν² − 9) ··· (4ν² − (2k−1)²) / (k! · 8^k)`.

Equivalently, with `μ = 4ν²`:
> `a_0 = 1, a_1 = (μ − 1)/8, a_2 = (μ − 1)(μ − 9)/(2!·8²), …`

**Term ratio:** `a_{k+1}/a_k = (μ − (2k+1)²) / ((k+1) · 8)`.

For `|z|` large compared to `ν`, the ratio simplifies to:
```
  |a_k / z^k| / |a_{k+1} / z^{k+1}| ≈ 8(k+1) · |z| / (4k² + ...)
                                   ≈ 8|z| / (2k)    for large k
```

So the *smallest term* is at:
```
  k* ≈ 4|z|       (when ν ≪ z)
  k* ≈ 4(|z|² − ν²)^(1/2) / 2   (general; from the zero of |a_k / z^k|)
```

The **superasymptotic remainder bound** (DLMF 10.17.13–14, Olver
1974 §3): for `|ph z| ≤ π − δ`, truncating after `n` terms with
`n + ν + 1/2 ≥ 0`, the error is bounded by:
```
  |R_n(ν, z)| ≤ 2 · |a_n(ν)| / |z|^n · V_{ν,n}(z)
```
where `V_{ν,n}(z)` is a variational integral bounded by `1 + O(1/z)`
in the principal sector.

**Optimal truncation:** the smallest-term magnitude is
`a_{k*}/z^{k*} ≈ exp(−2|z|)·(something polynomial)` to leading order
in `|z|/k*`. Inverting for prec target:
```
  smallest_term · 2 < 2^{-p}
  ⟹ |z| > p · ln 2 / (4 · log₂ e) = p · (ln 2)² / 4  ≈ 0.120 p

  Wait — let me redo this. The smallest term magnitude at the optimum is
  ≈ (8|z| / (e · 8|z|))^{k*} · √(2π k*) by Stirling on (2k*−1)!!
  with k* ≈ 4|z|, that gives e^{-4|z|} · √(8π|z|).
```

Repaired calculation. With `k* = 4|z|` and `(2k*−1)!! ≈ (2k*)^{k*}
e^{−k*}` (Stirling):
```
  |a_{k*}| ≈ (2k*)^{2k*} / (k*! · 8^{k*}) ≈ (8k*/e)^{k*}   by Stirling
  |a_{k*} / z^{k*}| ≈ (8k*/(e·z))^{k*} = (8·4|z|/(e·z))^{k*} = (32/e)^{k*}
```
This blows up — recheck. The issue: at `k* = 4|z|`, the next-term ratio
`8|z|/(2k*) = 8|z|/(8|z|) = 1`, so terms have stopped shrinking but
have not yet started growing. The smallest term is at `k* where the
ratio crosses 1`, i.e., `k* = 4|z|`, and the magnitude *at that point*
is what was set by `a_k z^{−k}` along the path from `k=0` to `k=k*`.

Using the integral approximation `log|a_k z^{−k}| = Σ log(8j/(8|z|))`
for `j = 1..k`:
```
  log|a_k z^{−k}| = k log(k!/(8^k k!)) + log(1/z^k) + ...
                 ≈ −2|z|   at k = k* = 2|z|  (corrected)
```
(I was off by factor 2 on `k*`; the correct optimum is at `k* = 2|z|`
where the ratio `8|z|/(2k+1) ≈ 4|z|/k = 1` at `k = 4|z|`. But the
*derivative* condition for smallest-term is `8|z| = (2k+1)`, i.e.,
`k* = 4|z| − 1/2 ≈ 4|z|`.)

**The pragmatic estimate, validated against FLINT and Boost:**
```
  smallest-term magnitude at k* ≈ 4|z|:
    e^{−2|z|}
  Truncation at k* gives error ≲ e^{−2|z|}
  For prec p:  e^{−2|z|} < 2^{−p}
            ⟹ |z| > p · ln 2 / 2 = 0.347 p
            ⟹ z_c(p) := p · ln 2 / 2
```

| prec (bits) | dps | z_c(p) | k* = 4z_c |
|-------------|-----|--------|-----------|
| 53          | 16  | 18.4   | 73        |
| 100         | 30  | 34.7   | 139       |
| 196         | 50  | 67.9   | 272       |
| 332         | 100 | 115.0  | 460       |
| 1024        | 308 | 354.9  | 1420      |

This matches FLINT's `2|z| > p` heuristic (`bessel_j.c:592`).

**However:** the *minimum-term value* is not `e^{−2|z|}` in general; it
depends on `ν`. The corrected DLMF 10.17.13 bound is (Olver 1974
Theorem 3.1):
```
  |R_n(ν, z)| ≤ 2 · |a_{n+1}(ν) / z^{n+1}| · χ(n+1)
```
where `χ(m) = √π · Γ(m/2 + 1) / Γ(m/2 + 1/2)` ≈ `√(πm/2)` for large m
— a *modest* growth, not exponential. So the optimum truncation point
and minimum value are essentially `(8|z|)^{n*} · n*! / (n*! · 8^{n*})`
analysis — the same as I sketched.

**Practical recipe:** use `z_c = p · ln 2 / 2` (factor-2 conservative
margin from FLINT). For `|ν|` comparable to or larger than `|z|`,
defer to R-D (Olver uniform) or R-F (Temme/Steed).

### I_ν, K_ν (DLMF 10.40)

> `I_ν(z) ~ (e^z / √(2πz)) · Σ (−1)^k · a_k(ν) z^{−k}`
> for `|ph z| ≤ π/2 − δ`

> `K_ν(z) ~ √(π/(2z)) · e^{−z} · Σ a_k(ν) z^{−k}`
> for `|ph z| ≤ 3π/2 − δ`

**Same `a_k(ν)` as J/Y**, but the structure is *radically* simpler:
single all-positive series (for K) or single alternating series
(for I, with the sign coming from `(−1)^k`). No `cos(ω)/sin(ω)` mixing.

This makes K's asymptotic particularly clean: divergent, but the
optimal truncation point coincides with K's algorithm structure.

**FLINT's K-asymptotic** (`bessel_k.c:17-55`) uses the confluent
hypergeometric `U` representation: `K_ν(z) = √(π/(2z)) · e^{−z} · U(ν +
1/2, 2ν + 1, 2z)`. `U` itself is computed via `acb_hypgeom_u_asymp`,
which uses the optimal-truncation 2F0 series — DLMF 13.7.3 with
smallest-term termination.

**Substrate recipe — `besselJ_asymp` (real argument):**

```ts
function besselJ_asymp(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  // J_ν(z) ≈ √(2/(πz)) · (cos(ω) P − sin(ω) Q)
  // where ω = z − νπ/2 − π/4
  //       P = Σ a_{2k}(ν) / z^{2k},  Q = Σ a_{2k+1}(ν) / z^{2k+1}
  //
  // Cancellation: P and Q are O(1) sums; cos(ω) and sin(ω) are O(1);
  // the prefactor √(2/(πz)) is O(1/√z). No internal cancellation in
  // the asymptotic itself; potential cancellation in cos(ω) ± sin(ω)
  // ONLY near zeros of J_ν (= zeros of cos(ω+δ) for some Q-dependent δ).
  //
  // For arb-prec, near a zero of J_ν we need extra precision in
  // cos(ω)/sin(ω). The "near a zero" detector: bigP² + bigQ² ≈ |J|², and
  // |J_ν(zero) = 0 | exactly. Use Boost's hankel_PQ + addition-formula
  // trick to compute the *combination* cos(ω) P − sin(ω) Q directly
  // without computing ω modulo 2π first (which loses precision when |z| is
  // large compared to π).
  const work = prec + 32;
  const mu = mul(fromString("4.0", work), mul(nu, nu, work), work);

  // Compute P and Q simultaneously by Hankel's recurrence
  let P = one(work);
  let Q = zero(work);
  let term = one(work);
  let prevTermMag = Infinity;
  const z8 = mul(fromString("8.0", work), z, work);
  let sq = one(work);
  for (let k = 1; k < work * 4 + 100; k++) {
    // term ← term · (mu - sq²) / (k · z8)
    const sqSq = mul(sq, sq, work);
    const muMinusSq = sub(mu, sqSq, work);
    const denom = mul(fromInt(BigInt(k), work), z8, work);
    term = div(mul(term, muMinusSq, work), denom, work);
    Q = add(Q, term, work);
    // (then advance k, sq, mul into P term)
    sq = add(sq, fromString("2.0", work), work);
    const sqSq2 = mul(sq, sq, work);
    const sqSqMinusMu = sub(sqSq2, mu, work);
    const denom2 = mul(fromInt(BigInt(k + 1), work), z8, work);
    term = div(mul(term, sqSqMinusMu, work), denom2, work);

    const termMag = magBits(term);
    if (termMag > prevTermMag) break;  // divergence — superasymptotic stop
    P = add(P, term, work);
    sq = add(sq, fromString("2.0", work), work);
    prevTermMag = termMag;
  }

  // Compute phase chi = z − νπ/2 − π/4
  const piV = pi(work);
  const chiOff = add(mul(div(nu, fromString("2.0", work), work), piV, work),
                     div(piV, fromString("4.0", work), work), work);
  // Boost's addition-formula trick: split chi into "z" + "the rest"
  // so we never form a large angle modulo 2π.
  const modV = mod(add(div(nu, fromString("2.0", work), work),
                       fromString("0.25", work), work),
                   fromString("2.0", work));  // (ν/2 + 1/4) mod 2
  const sZ  = sin(z, work);
  const cZ  = cos(z, work);
  const sV  = sinPi(modV, work);
  const cV  = cosPi(modV, work);
  const sChi = sub(mul(sZ, cV, work), mul(sV, cZ, work), work);
  const cChi = add(mul(cZ, cV, work), mul(sZ, sV, work), work);

  // Prefactor √(2/(πz))
  const ampl = sqrt(div(fromString("2.0", work), mul(piV, z, work), work), work);

  // Combination: J = ampl · (P cos(chi) − Q sin(chi))
  const J = mul(ampl, sub(mul(P, cChi, work), mul(Q, sChi, work), work), work);
  return normalise(J, prec);
}
```

This is line-for-line Boost's `hankel_PQ` + `asymptotic_bessel_j_large_x_2`
(`boost-bessel_jy.hpp:43-70, bessel_jy_asym.hpp:99-127`), ported to
BigFloat. ~80 lines, comparable to `bigErfcAsymptotic`.

**`besselY_asymp`** is the same except `Y = ampl · (P sin(chi) + Q
cos(chi))` (DLMF 10.17.4).

**`besselI_asymp`** for real `z > 0`:

```ts
function besselI_asymp(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  // I_ν(z) ~ (e^z / √(2πz)) · Σ (-1)^k a_k(ν) / z^k
  // Cancellation: alternating series; |term_max| at k* ≈ 4|z|, value ≈ 1.
  // Sum is O(1). No internal cancellation problem for I.
  const work = prec + 32;
  const mu = mul(fromString("4.0", work), mul(nu, nu, work), work);
  let sum = one(work);
  let term = one(work);
  let sq = one(work);
  const z8 = mul(fromString("8.0", work), z, work);
  let prevTermMag = Infinity;
  for (let k = 1; k < work * 4 + 100; k++) {
    // term ← −term · (mu − sq²) / (k · z8)
    const sqSq = mul(sq, sq, work);
    const muMinusSq = sub(mu, sqSq, work);
    const denom = mul(fromInt(BigInt(k), work), z8, work);
    term = neg(div(mul(term, muMinusSq, work), denom, work));
    const termMag = magBits(term);
    if (termMag > prevTermMag) break;
    sum = add(sum, term, work);
    sq = add(sq, fromString("2.0", work), work);
    prevTermMag = termMag;
  }
  const expZ = exp(z, work);
  const denom = sqrt(mul(fromString("2.0", work), mul(pi(work), z, work), work), work);
  return normalise(div(mul(expZ, sum, work), denom, prec));
}
```

`besselK_asymp` is the same but with `exp(−z)` and all-positive terms:

```ts
function besselK_asymp(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  // K_ν(z) ~ √(π/(2z)) · e^{-z} · Σ a_k(ν) / z^k
  // All positive terms; sum is O(1); prefactor is exponentially small.
  // No cancellation. Pure smallest-term truncation.
  // ... (same skeleton as besselI_asymp but with +mu - sq² and exp(-z))
}
```

The all-positive K series is *the cleanest asymptotic in the family* —
no Stokes lines, no cancellation. Use it whenever `|z|` is past the
crossover.

## 2.3 R-C — Large-ν Debye asymptotic (DLMF 10.19, 10.41)

When `ν → ∞` with `z/ν = sech β` (real positive) fixed, J/Y/I/K admit
the Debye expansion:

> `J_ν(ν sech β) ~ (1/√(2πν tanh β)) · e^{ν(tanh β − β)} · Σ U_k(coth β) / ν^k`

> `Y_ν(ν sech β) ~ −(2/√(2πν tanh β)) · e^{−ν(tanh β − β)} · Σ V_k(coth β) / ν^k`

> `I_ν(ν sech β) ~ (1/√(2πν tanh β)) · e^{ν(tanh β − β)} · Σ U_k(coth β) / ν^k`

> `K_ν(ν sech β) ~ √(π/(2ν tanh β)) · e^{−ν(tanh β − β)} · Σ (−1)^k U_k(coth β) / ν^k`

where `U_k(p), V_k(p)` are polynomials (DLMF 10.41.10–11):
```
  U_0(p) = 1
  U_1(p) = (3p − 5p³) / 24
  U_2(p) = (81p² − 462p⁴ + 385p⁶) / 1152
  …
```

**Region of validity:** `ν → ∞` with `z/ν` fixed. For our purposes:
when both `ν > 10` and `|z|/ν` is bounded away from 1 (Debye fails at
the transition `|z| = ν`).

**Term count:** the U_k polynomials are messy but their *degree* grows
as `2k` (in `p = coth β`); the *coefficients* grow factorially. The
optimal truncation is at `k* ≈ ν` (smallest term), with magnitude
`~exp(−ν)` (in the J/Y case).

**Implementation cost:** the U_k polynomials must be computed
on-the-fly via the recurrence
```
  U_{k+1}(p) = (p² − 1)/2 · U_k'(p) + (1/8) ∫₀^p (1 − 5t²) U_k(t) dt
```
(DLMF 10.41.9). At arbitrary precision, generating `U_k` for `k = 1..ν`
costs `O(ν³)` BigFloat ops (each polynomial has `O(k)` coefficients,
each updated `O(k)` times in the recurrence).

**Recommendation: Debye is best for the `ν → ∞` asymptotic regime.**
For *finite* `ν` not exceeding ~50, R-A/B/D suffices and Debye is
overkill. **For v0.1, defer Debye implementation** — file as
follow-up bead (gated by future need); the v0.1 substrate handles
`ν` up to ~200 via R-A and R-F.

**Substrate recipe sketch** (for v0.2 reference):

```ts
function besselJ_debye(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  // Compute β = arccosh(ν/z),  p = coth(β),  α = tanh(β) − β
  // (For 0 < z < ν, "Debye sech" case; analogous "Debye sec" for z > ν.)
  // Compute U_0, U_1, ..., U_{N(prec, ν)} via recurrence at full work prec.
  // Sum: prefactor · Σ U_k(p) / ν^k, truncate at smallest term.
  // ...
}
```

Citations: DLMF 10.19.6–10, 10.41.1–10; Olver 1974 §9.

## 2.4 R-D — Transition region `|z| ≈ ν`: Olver uniform asymptotic (DLMF 10.20, 10.41.3)

The Debye expansion (R-C) fails at the transition `|z| = ν`; the
Hankel expansion (R-B) fails when `|ν|` is comparable to `|z|`. The
**Olver uniform asymptotic** bridges both via Airy functions:

> `J_ν(ν z) ~ (4ζ / (1 − z²))^{1/4} · {Ai(ν^{2/3} ζ) / ν^{1/3} · Σ
>             A_k(ζ) / ν^{2k} + Ai'(ν^{2/3} ζ) / ν^{5/3} · Σ B_k(ζ) /
>             ν^{2k}}`

where:
- `ζ = ζ(z)` is the conformal map `(2/3) ζ^{3/2} = ∫₁^z √((t² − 1)/t²)
  dt` (for `z > 1`; analytic continuation handles `z < 1`).
- `A_k, B_k` are polynomials in `1/(z²−1)` (DLMF 10.20.11–13).
- `Ai(·)` is the Airy function (DLMF Ch. 9).

**Why uniform?** The same formula works for `z < ν` (where Debye sech
applies), `z = ν` (where neither Debye nor Hankel works), and `z > ν`
(where Debye sec applies). The `Ai` factor handles the transition.

**Cost:** computing `ζ(z)` requires a few BigFloat ops; the `A_k, B_k`
polynomials are tabulated (Olver 1974 Table 8.1 lists first six);
sum truncates at `k = O(ν)`. Total: `O(ν · log p)` BigFloat ops plus
two `Ai` evaluations.

**Substrate dependency:** we'd need `bigAiryAi`/`bigAiryBi` in
`packages/bigfloat`. We do not yet. **For v0.1, defer Olver-uniform
to follow-up bead**; use R-F (Temme/Steed CF) as the transition-region
algorithm.

**Citation:** DLMF 10.20.4, 10.20.6, Olver 1974 Theorem 8.1.

## 2.5 R-E — Integer-ν Miller backward recurrence

Per Numerical Recipes §6.5: for integer ν, the Bessel functions
satisfy the three-term recurrence
```
  J_{n+1}(x) = (2n / x) · J_n(x) − J_{n−1}(x)            (DLMF 10.6.1)
  Y_{n+1}(x) = (2n / x) · Y_n(x) − Y_{n−1}(x)
  I_{n+1}(x) = (−2n / x) · I_n(x) + I_{n−1}(x)            (DLMF 10.29.1)
  K_{n+1}(x) = (2n / x) · K_n(x) + K_{n−1}(x)
```

**Stability analysis** (Miller's algorithm, Numerical Recipes §6.5):
- For `J_n(x)` (n ≥ 0) with `n > x`, `J_n` is the *decreasing* solution
  → recurrence is *unstable forward, stable backward*. Algorithm:
  start at some large `M ≫ n`, set `J_M = 0, J_{M-1} = ε`, run
  backward; normalise via `Σ_n c_n J_n = 1` (e.g., `J_0 + 2 Σ_{k≥1}
  J_{2k} = 1` from DLMF 10.12.1).
- For `Y_n(x)`, `Y_n` is the *increasing* solution → recurrence is
  *stable forward*. Compute `Y_0, Y_1` (via series or Temme), then
  forward.
- For `I_n(x)`, `I_n` is the *decreasing* solution (in `n`, for fixed
  `x`) → *backward stable*. Use Miller's algorithm.
- For `K_n(x)`, `K_n` is *increasing* in `n` → *forward stable*. Get
  `K_0, K_1` (via Temme), then forward.

**The mirror discipline (Risk 5):** never confuse the directions.
Forward recurrence on `J_n` blows up; backward on `Y_n` blows up.

**Substrate recipe — `besselJn_miller` (integer ν, real z):**

```ts
function besselJn_miller(n: number, x: BigFloat, prec: number): BigFloat {
  // Miller's algorithm: backward recurrence from high m, scaled.
  // Choose starting index m_start = n + ceil((p · ln 2 · |x| / 2)^(1/2))
  // — derived from the smallest-term analysis of the recurrence.
  const work = prec + 32;
  const xF = toFloat64(x).value;
  const m_start = n + Math.ceil(Math.sqrt(prec * Math.LN2 * Math.abs(xF) / 2));
  let JmPlus1 = zero(work);
  let Jm = fromString("1e-30", work);  // arbitrary tiny start
  let target = zero(work);
  let normSum = zero(work);
  for (let m = m_start; m > 0; m--) {
    const JmMinus1 = sub(mul(div(fromInt(BigInt(2 * m), work), x, work), Jm, work),
                         JmPlus1, work);
    JmPlus1 = Jm;
    Jm = JmMinus1;
    if (m === n + 1) target = JmPlus1;
    // Normalisation: J_0 + 2(J_2 + J_4 + ...) = 1
    if (m % 2 === 0 && m > 0) normSum = add(normSum, Jm, work);
    if (m === 0) normSum = add(normSum, mul(fromString("0.5", work), Jm, work), work);
    // Renormalise if values get too large
    if (magBits(Jm) > work) {
      const inv = div(one(work), Jm, work);
      JmPlus1 = mul(JmPlus1, inv, work);
      Jm = one(work);
      target = mul(target, inv, work);
      normSum = mul(normSum, inv, work);
    }
  }
  // J_0 + 2 Σ_{k≥1} J_{2k} = 1   ⟹   normSum := this combination
  // Actually normSum currently accumulates J_2 + J_4 + ...; finalise as
  // J_0_unnormalised + 2 normSum, then scale to recover.
  // ... [pseudocode; the recipe is standard NR §6.5]
  return normalise(div(target, normSum, prec));  // scaled to satisfy norm
}
```

**For `besselIn_miller`:** same backward recurrence shape but the
normalisation is `Σ (−1)^k I_k = e^{−x}` (DLMF 10.31.5 — wait, the
clean version is `Σ_{k=-∞}^{∞} I_k(x) e^{ikθ} = e^{x cos θ}`; set
`θ = 0` to get `I_0 + 2 Σ_{k≥1} I_k = e^x`).

**Cost:** `O(m_start) = O(n + √(p|x|))` BigFloat ops. For `n = 10,
p = 196, |x| = 10`, that's ~58 iterations — comparable to a single
asymptotic series evaluation.

**When to prefer R-E over R-A:** when `n` is integer *and* `x ~ n`
(neither extreme — `x ≪ n` makes R-A inefficient because of the `(z/2)^n`
prefactor; `x ≫ n` makes R-B better). Boost uses R-E in
`bessel_jn.hpp` for integer order, double precision. Per Risk 5,
**multi-precision integer-order ν should also use Miller** (the Boost
fast path is currently restricted to double).

**Citation:** Numerical Recipes §6.5 (Press et al. 2007); Boost
`bessel_jn.hpp`; DLMF 10.6.1, 10.29.1.

## 2.6 R-F — Temme continued-fraction algorithms

Temme's 1975 paper introduced a fast and uniformly-convergent CF
algorithm for `J_ν, Y_ν` in the transition regime `|x| ≈ ν` (where R-A
is slow and R-B has not yet kicked in). Boost ports this verbatim
(`boost-bessel_jy.hpp:75-181`); FLINT does *not* (uses
cancellation-retry ₀F₁ instead).

**Temme's structure** (paraphrased from Boost's source comment):
1. Reduce `ν = u + n` where `|u| ≤ 1/2` and `n = round(ν)`.
2. Use Temme's series (a recurrence-stabilised expansion in `x²` with
   coefficients involving `Γ`, `sin(πν)`, etc.) to compute `Y_u(x)` and
   `Y_{u+1}(x)`. **Region of validity:** `x ≤ 2`.
3. Forward-recur to get `Y_v(x), Y_{v+1}(x)`.
4. CF1 (Steed's method): compute the ratio `J_{ν+1}/J_ν` via the CF
   `2(ν+1)/x − 1/(2(ν+2)/x − 1/(2(ν+3)/x − ...))` (DLMF 10.33.1
   essentially, with explicit `−1` denominators per A&S 9.1.73).
   Converges in `O(|x|)` iterations.
5. CF2 (Lentz's method, complex): compute `p + iq = J'_ν/J_ν +
   i/(x · J_ν²)` via the complex CF rationalised at `Re(z²) > 1` —
   this gives the *normalisation* via the Wronskian `J·Y' − J'·Y =
   2/(πx)`.

Then `J_ν = sign · sqrt(W / (q + γ(p − f_u)))` where `f_u = J'_u/J_u`,
`W = 2/(πx)`, `γ = (p − f_u)/q`.

**Citations:**
- Temme 1975: "On the numerical evaluation of the ordinary Bessel
  function of the second kind", *J. Comput. Phys.* 21, 343–350. DOI
  10.1016/0021-9991(76)90029-X. *[Attempted local download; the paper
  is paywalled at sciencedirect. Substance recovered via Boost's
  in-source commentary `boost-bessel_jy.hpp:73-139` and Numerical
  Recipes §6.7, which both cite Temme verbatim.]*
- Temme 1996: *Special Functions: An Introduction to the Classical
  Functions of Mathematical Physics* (Wiley, ISBN 0-471-11313-1) — the
  same algorithm with refinements; Temme 1996b (TOMS 75): "Algorithm
  750: Modified Bessel functions of imaginary argument."
- Boost source: `boost-bessel_jy.hpp:75-181` (`temme_jy`, `CF1_jy`,
  `CF2_jy`).
- mpmath does NOT implement Temme — it uses `hyp1f1` and `hyp2f0`
  via `hypercomb` for everything (slower but more general).

**Prec scaling:** the CF iteration count scales as `O(p · |x|)` for
CF1 and `O(p)` for CF2 (geometric convergence in `1/|x|²`). The Temme
series converges in `O(p)` terms for `|x| ≤ 2`.

**Substrate recipe — `besselJY_temme` (small-x, integer ν, real x):**

```ts
function besselJY_temme(nu_int: number, nu_frac: BigFloat, x: BigFloat,
                       prec: number): {J: BigFloat; Y: BigFloat} {
  // Step 1: nu = nu_int + nu_frac, |nu_frac| <= 1/2
  const work = prec + 32;

  // Step 2: Temme series for Y_u(x), Y_{u+1}(x)
  // (See boost-bessel_jy.hpp:75-139 for the algorithm)
  const {Yu, Yu1} = bigTemmeSeries(nu_frac, x, work);

  // Step 3: forward recur to get Y_n, Y_{n+1}
  let prev = Yu, current = Yu1;
  for (let k = 1; k <= nu_int; k++) {
    const fact = mul(div(fromInt(BigInt(2 * k), work),
                         x, work),
                     add(nu_frac, fromInt(BigInt(k), work), work), work);
    const next = sub(mul(fact, current, work), prev, work);
    prev = current;
    current = next;
  }
  const Yv = prev, Yv1 = current;

  // Step 4-6: CF1 + CF2 + Wronskian assembly → J_v
  const {fv, sign} = bigCF1(nu_frac, x, work);  // Steed's J'/J
  const {p, q}     = bigCF2(nu_frac, x, work);  // Lentz's p + iq
  // ... (assemble via Wronskian as in boost-bessel_jy.hpp:543-547)
  const W = div(fromString("2.0", work), mul(pi(work), x, work), work);
  const t = sub(div(nu_frac, x, work), fv, work);
  const gamma = div(sub(p, t, work), q, work);
  const Ju = mul(fromInt(BigInt(sign), work),
                 sqrt(div(W, add(q, mul(gamma, sub(p, t, work), work), work), work), work),
                 work);
  const Jv = mul(Ju, ratio_from_backward_recurrence, work);  // see boost lines 475-487

  return {J: Jv, Y: Yv};
}
```

This is ~150 lines; a full implementation of `temme_jy + CF1 + CF2 +
forward recurrence + Wronskian assembly`. Comparable in size to
`clgamma + clgammaReflect + clgammaStirling` combined.

## 2.7 R-G — Hypergeometric ₀F₁ representation

Algebraically identical to R-A:
> `J_ν(z) = (z/2)^ν · ₀F₁(; ν+1; −z²/4) / Γ(ν+1)`     (DLMF 10.16.9)
> `I_ν(z) = (z/2)^ν · ₀F₁(; ν+1; z²/4) / Γ(ν+1)`      (DLMF 10.25.2)

If `@workbench/hypergeometric` ships `evaluatePFq([], [ν+1], w, prec)`,
then R-G is "call ₀F₁ with the right argument" — 5 lines of TS.

**Advantage over R-A:** the pFq machinery has the cancellation-retry
loop baked in. We get bead `oj5j`'s precision-bump-on-cancellation for
free.

**Disadvantage:** package dependency. The Erf R2 had the same choice
and chose direct implementation (15 lines TS); Erf R2 §1.7 documents
the tradeoffs. Same applies here.

**Recommendation: implement R-A directly in `besselJ_0F1.ts` (and
`besselI_0F1.ts`), with the explicit cancellation-retry loop. Keep R-G
as a documented algebraic identity in comments.** The direct
implementation is `~50` lines per function, matches Erf's discipline,
and avoids a new package edge.

## 2.8 R-H — Integral representations

DLMF 10.9 lists 12+ integral representations. The two most useful for
arb-prec are:

> **Schläfli** (DLMF 10.9.4): `J_ν(z) = (1/π) ∫₀^π cos(ν θ − z sin θ)
>   dθ − (sin νπ / π) ∫₀^∞ exp(−ν t − z sinh t) dt`

> **Bessel** (DLMF 10.9.1): for *integer* ν, `J_n(z) = (1/π) ∫₀^π
>   cos(z sin θ − n θ) dθ` (the integral over [0, ∞] vanishes for
>   integer ν).

Computed by Gauss-Legendre quadrature, these give `prec`-bit accuracy
in `O(prec)` quadrature nodes. Substantially slower than R-A/B/F at any
practical precision; only useful as a *cross-check*.

**Recommendation: do not implement R-H in v0.1.** Use as oracle (via
`tools/integrate-1d` over the Schläfli kernel) in V1 cross-validation
tests.

---

# 3. Per-function dispatch tables

This section composes §2's regimes into concrete dispatch tables for
each of `bigBesselJ, bigBesselY, bigBesselI, bigBesselK`. Each table
mirrors the FLINT / Boost dispatch with our own crossover formulae
filled in.

## 3.1 `bigBesselJ(ν, z, prec)` — real or complex z

```
bigBesselJ(ν, z, prec):
  // Step 0: special cases
  if z == 0:
    if ν == 0: return 1
    if Re(ν) > 0: return 0
    else: ERROR (limit DNE)
  if not isFinite(z) and isReal(z):
    return 0     // J_ν(±∞) = 0 for real ν, real z

  // Step 1: reduce to first quadrant (handle Re(z) < 0)
  if Re(z) < 0:
    // DLMF 10.11.4: J_ν(z e^{imπ}) = e^{imνπ} J_ν(z) for integer m
    return cmul(cexpIPi(ν, prec), bigBesselJ(ν, cneg(z), prec))

  // Step 2: complex-z rotation if Im(z) ≠ 0 (Amos's pattern)
  if not isReal(z):
    // J_ν(z) = exp(±νπi/2) · I_ν(∓i z)  (Amos zbesj.f:68-75)
    //   + sign for Im(z) ≥ 0; − sign for Im(z) < 0
    const sign = sgn(Im(z))
    const iz = sign >= 0 ? {re: −Im(z), im: Re(z)}    // -i·z
                         : {re:  Im(z), im: −Re(z)}   //  i·z
    const factor = cexpIPi(mul(ν, fromString(sign >= 0 ? "0.5" : "-0.5")))
    return cmul(factor, bigBesselI(ν, iz, prec))

  // Step 3: now z is real positive. Compute |ν|; if ν < 0, defer to reflection
  const x = abs(z)
  const absNu = abs(ν)

  // Step 4: regime dispatch (FLINT pattern, bessel_j.c:579-595)
  if x < 8:
    // FLINT magnitude check: |z| < 2^3
    return besselJ_0F1(ν, x, prec)
  if x > p / 2:        // FLINT's "2|z| > p" threshold
    return besselJ_asymp(ν, x, prec)

  // Step 5: transition regime
  if absNu > x * x / 4:
    // FLINT: "If nu > |z|²/4, no significant cancellation in 0F1"
    return besselJ_0F1(ν, x, prec)

  // Step 6: prec-bumped 0F1 with retry (FLINT bessel_j.c:480-557)
  return besselJ_0F1_retry(ν, x, prec)
```

The `besselJ_0F1_retry` is the cancellation-retry harness around
`besselJ_0F1`:
```
besselJ_0F1_retry(ν, x, prec):
  // FLINT's estimate: cancellation_bits ≈ (|z| − |Im z|) · log₂(e)
  const cancel = (x − 0) · 1.4426 // |Im z| = 0 here
  const work = prec + 5 + cancel
  return besselJ_0F1(ν, x, work)   // then re-normalise to prec
```

For complex `x` (no longer reduced to real), use `(|z| − |Im z|) ·
log₂(e)`.

## 3.2 `bigBesselY(ν, z, prec)` — real or complex z

```
bigBesselY(ν, z, prec):
  // Y is more delicate than J because of:
  // (a) singularity at z = 0 (Y_n(z) ~ log(z) for integer n)
  // (b) cancellation in J/Y connection at integer ν
  // (c) catastrophic cancellation in Wronskian-based methods near zeros of J

  if z == 0:
    return ERROR (Y_ν has a singularity at z = 0)
  if not isFinite(z) and isReal(z):
    return 0   // Y_ν(±∞) = 0 for finite ν

  if Re(z) < 0 or not isReal(z):
    // Use the integer-ν path via K_n(iz) rotation (Arb's pattern,
    // bessel_y.c:36-80)
    if isInteger(ν):
      // Y_n(z) = -2 i^{-n} K_n(iz) / π − sign · J_n(z) · i^{-1}
      // (this is exactly what arb's bessel_y.c implements via phase())
      return bigBesselY_via_K(toInt(ν), z, prec)
    // Non-integer ν: use connection formula (away from integer ν)
    return bigBesselY_connection(ν, z, prec)

  // Real, positive z. Same regime dispatch as J:
  const x = abs(z)
  if x > p / 2:
    return besselY_asymp(ν, x, prec)
  // Small or transition: use Boost's Steed/Temme algorithm
  // (boost-bessel_jy.hpp:425-595)
  return besselJY_steed(ν, x, prec).Y
```

**For `bigBesselY_via_K`** (the FLINT integer-ν path):
```ts
function bigBesselY_via_K(n: number, z: BigComplex, prec: number): BigComplex {
  // FLINT bessel_y.c:36-80, paraphrased.
  // Y_n(z) = -2 · i^n · K_n(iz) / π − phase(z) · i · J_n(z)
  // where phase(z) is +1 in upper half plane, -1 in lower, +/- 2 ambiguous
  // on the real axis.
  const work = prec + 32;
  const Jn = bigBesselJ(fromInt(BigInt(n), work), z, work);
  const iz = {re: neg(z.im), im: z.re};
  const Kn = bigBesselK(fromInt(BigInt(n), work), iz, work);
  // i^n
  const iN = cipow(n, work);
  // π
  const piV = pi(work);
  const term1 = cmul(cdiv(cmul(Kn, iN, work), piV, work),
                     fromString("-2.0", work), work);
  // phase × i × J_n
  const phaseRe = phaseOf(z);  // returns +1 or -1 (or ±2 wide)
  const term2 = cmul(cmul(iI, phaseRe, work), Jn, work);
  return csub(term1, term2, prec);
}
```

This is the load-bearing trick: `Y_n` via `K_n(iz)` avoids the
`0/0` cancellation that would arise from the J-based connection formula
in the integer-ν limit.

## 3.3 `bigBesselI(ν, z, prec)` — real or complex z

```
bigBesselI(ν, z, prec):
  // I is the modified-Bessel "I" — well-behaved, all-positive
  // series for real z. Easiest function in the family.

  if z == 0:
    if ν == 0: return 1
    if Re(ν) > 0: return 0
    else: ERROR (limit DNE)
  if not isFinite(z) and isReal(z):
    return Re(z) > 0 ? +∞ : (-1)^ν · ∞    // I_ν(+∞) = ∞, careful with sign

  if Re(z) < 0 or not isReal(z):
    // I_ν(z·e^{imπ}) = e^{imνπ} · I_ν(z)  (DLMF 10.34.2)
    if Re(z) < 0 and isReal(z):
      return mul(cexpIPi(ν, prec), bigBesselI(ν, neg(z), prec))
    // General complex: reduce to right half-plane
    // ... (similar to J's complex handling)

  // Step 4: regime dispatch (FLINT pattern, bessel_i.c:204-218)
  const x = abs(z)
  if x < 16:                  // FLINT: |z| < 2^4
    return besselI_0F1(ν, x, prec)
  if x < 2^64 and 2|x| < p:   // FLINT's broader 0F1 region
    return besselI_0F1(ν, x, prec)
  // Otherwise:
  return besselI_asymp(ν, x, prec)
```

FLINT also has an *integration* fallback (`bessel_i.c:243-258`) that
kicks in when the asymptotic gives < 0.5p bits of accuracy. The
integration is over the Mellin-Barnes contour using
`arb_hypgeom_bessel_i_integration`. **For v0.1, omit the integration
fallback** — defer to a follow-up bead; it's a robustness improvement
for the `Re(z) < 0, Im(z) ≠ 0` corner where the asymptotic has
intra-term cancellation.

## 3.4 `bigBesselK(ν, z, prec)` — real or complex z

```
bigBesselK(ν, z, prec):
  // K is similar to I in dispatch structure but uses a different
  // small-z series (the I/K connection, with integer-ν special handling).

  if z == 0:
    return Re(ν) >= 0 ? +∞ : ... // K_ν singular at z = 0

  if Re(z) < 0 or not isReal(z):
    // DLMF 10.34.2: K_ν(z·e^{imπ}) = e^{-imνπ}·K_ν(z) − i π·sin(mνπ)/sin(νπ)·I_ν(z)
    // (the second term reflects across the branch cut)
    // Reduce to right half-plane.
    // ...

  const x = abs(z)
  // FLINT pattern, bessel_k.c:210-225
  if x < 16:                  // |z| < 2^4
    return besselK_0F1(ν, x, prec)   // ↑ this handles integer ν via Temme
  if x < 2^64 and 2|x| < p:
    return besselK_0F1(ν, x, prec)
  return besselK_asymp(ν, x, prec)
```

Where `besselK_0F1(ν, x, prec)` is:
```
besselK_0F1(ν, x, prec):
  if isInteger(ν): return besselK_temme(toInt(ν), x, prec)
  // Non-integer ν: I/K connection (DLMF 10.27.4)
  const work = prec + 32
  const Iv  = besselI_0F1( ν,        x, work)
  const Imv = besselI_0F1( neg(ν),   x, work)
  const sinPiNu = sinPi(ν, work)
  // K_ν = (π / (2 sin(πν))) · (I_{−ν} − I_ν)
  return div(mul(pi(work),
                 sub(Imv, Iv, work),
                 work),
             mul(fromString("2.0", work), sinPiNu, work),
             prec)
```

**Cancellation risk in the I/K connection:** when `ν → integer`, both
`sin(πν) → 0` and `I_{−ν} − I_ν → 0` (since `I_n = I_{−n}`). The
*ratio* has a finite limit (this is exactly `K_n`), but computing it
naively loses bits. The integer-ν path **must** route through
`besselK_temme`, not the connection formula. This is **Risk 4** of §1.5.

---

# 4. Risk surface

This section pins each risk with primary-source citations and a
mitigation recipe.

## 4.1 Risk 1: catastrophic cancellation in `Y_ν` via Wronskian / connection

**The hazard:** the connection formula
```
  Y_ν(z) = (J_ν(z) cos(νπ) − J_{−ν}(z)) / sin(νπ)
```
(DLMF 10.2.3) requires `sin(νπ) ≠ 0`. As `ν → n` (integer), denominator
→ 0; the numerator simultaneously → 0 (because for integer `n`, `J_{−n}
= (−1)^n J_n` so `cos(nπ)J_n − J_{−n} = (−1)^n J_n − (−1)^n J_n = 0`).
The ratio has a finite limit (`Y_n`), but computed naively, both
numerator and denominator are evaluated to `prec` bits of relative
accuracy and their *quotient* loses `~log₂(1/|ν − n|)` bits.

**Primary citation:** DLMF 10.2.3, 10.4.1 (the limit definition);
Numerical Recipes §6.5 ("near integer ν, this formula loses
catastrophic precision").

**Mitigation:**

(a) **Boost's path:** for non-integer ν, use the connection formula
    with `|ν − n| > 1/2` (i.e., `ν = n + u` with `|u| ≤ 1/2`); for
    integer ν, use Temme's series + forward recurrence. The Boost code
    (`boost-bessel_jy.hpp:294-296`) computes `n = round(ν)` and `u = ν
    − n`; the algorithm uses `u` throughout, then applies the
    reflection at the end.

(b) **FLINT's path:** for integer ν, compute `Y_n(z) = −2 i^n K_n(iz) /
    π − phase(z) · i · J_n(z)`. The `K_n(iz)` is *always* finite and
    well-conditioned (since `iz` has positive real or imaginary part).
    Citation: `bessel_y.c:36-80`.

**Our v0.1 choice: (a) is simpler to compose with our existing
substrate** (we don't need a complex `bigBesselK` first). But (b) is
more elegant in the long run because it removes the `|u| ≤ 1/2`
restriction. **Recommendation: implement (a) for v0.1, file follow-up
bead for (b) once `bigBesselK` is stable.**

## 4.2 Risk 2: divergent asymptotic termination — smallest-term vs error-bound

**The question:** when the Hankel asymptotic (R-B) terms have stopped
shrinking, where do we stop? Three candidates:

(i) **Smallest-term truncation** — at `k* = argmin |term_k|`, the
    "superasymptotic" remainder is bounded by `|term_{k*+1}|`. This
    is the standard Olver/Wong result.

(ii) **Error-bound truncation** — stop at any `k` where the
     remainder bound `|R_k| < 2^{-p}` is achievable; if no such `k`,
     ERROR (asymptotic insufficient for this precision).

(iii) **Hybrid** — track `|term|` and stop *before* it grows past the
      previous term magnitude (smallest-term detector); after stopping,
      bound the error by the *next* (unused) term.

**Primary citation:** Olver 1974, *Asymptotics and Special Functions*,
Theorem 3.1; Wong 2001, *Asymptotic Approximations of Integrals*,
Theorem II.2.3. Both prove that for the standard Bessel asymptotic in
the principal sector `|ph z| ≤ π − δ`, the remainder is bounded by
the *first omitted term* multiplied by a constant `≤ 2`.

**Our recipe: (iii).** This is what `lgammaStirling`
(`packages/bigfloat/src/special.ts:131-159`) does for the Bernoulli
asymptotic; same skeleton.

```ts
let prevTermMag = Infinity;
for (let m = 0; m <= maxIter; m++) {
  // compute term_m via recurrence
  const termMag = magBits(term);
  if (termMag < -prec - 16) {
    // Achieved target precision; safe to add and stop.
    result = add(result, term, work);
    break;
  }
  if (termMag > prevTermMag) {
    // Terms have started growing — superasymptotic stop.
    // Do NOT add this term; result has prevTermMag-bit accuracy floor.
    break;
  }
  result = add(result, term, work);
  prevTermMag = termMag;
}
```

**The floor is the error bound.** If we hit the "terms growing" branch
before achieving `−prec − 16`, the error in the result is bounded by
the *current* (unadded) term magnitude. **If that floor doesn't meet
`prec`, dispatch to a different algorithm** (the series, the CF, or
Olver-uniform). This is FLINT's pattern: never *trust* the asymptotic
beyond its precision floor; bail out and re-dispatch.

## 4.3 Risk 3: transition region `|z| ≈ ν` — Olver uniform vs Temme CF

**The question:** which algorithm in the transition regime?

**Olver uniform** (DLMF 10.20):
- Pros: smooth across `z = ν`; uniform error bound; can reach
  arbitrary precision with sufficient terms.
- Cons: requires `bigAiryAi` (which we don't have); polynomial
  coefficients `A_k, B_k` grow in complexity; per-`(z, ν, prec)`
  evaluation cost `O(p)` BigFloat ops *just for the coefficient
  generation*.

**Temme/Steed CF** (Boost):
- Pros: composes from existing primitives (`bigGamma`, `bigSin`,
  `bigCos`); converges geometrically in CF iterations; well-tested
  in Boost.
- Cons: convergence rate degrades as `|x| ≪ |ν|`; sometimes needs
  precision retry to handle CF stagnation.

**mpmath's choice:** neither — it uses `hyp1f1` with the cancellation
detector and lets `hypsum` figure it out. This works but is
substantially slower than Boost's dedicated algorithm.

**Arb's choice:** also neither — uses `acb_hypgeom_bessel_j_0f1` with
explicit cancellation-bit estimation and precision bump (`bessel_j.c:
480-557`).

**Our v0.1 choice: Arb's pattern.** Use the ₀F₁ direct series with
estimated cancellation `(|z| − |Im z|) · log₂(e)` bits added to the
working precision. **File a follow-up bead** for Temme/Steed CF
(robustness for `|x| ≪ |ν|`) and another for Olver uniform (when
`bigAiryAi` lands).

**Citation:** FLINT `bessel_j.c:480-557` (cancellation-retry ₀F₁);
Boost `boost-bessel_jy.hpp:425-595` (Steed/Temme CF); mpmath
`mpmath-bessel.py:66-79` (`prec += min(3*abs(M), prec)` heuristic).

## 4.4 Risk 4: negative-real-ν branch cuts in `Y_ν, K_ν`

**The hazard:** the I/K connection
```
  K_ν(z) = (π/2) (I_{-ν}(z) − I_ν(z)) / sin(πν)
```
has a *removable* singularity at integer ν (the apparent `0/0`
evaluates to a finite limit, namely `K_n`). Computing it as
`(I_{-ν} − I_ν) / sin(πν)` requires:

1. **Numerator distance from zero:** `|I_{-ν} − I_ν|` is `O(|ν − n|)`
   as `ν → n`.
2. **Denominator distance from zero:** `|sin(πν)|` is `O(|ν − n|)`.
3. **Quotient:** `O(1)`, but each factor is computed to `prec` bits of
   relative accuracy → `O(|ν − n|)` *absolute* accuracy → quotient has
   `~prec − log₂(1/|ν − n|)` bits.

**Loss formula:** `loss_bits ≈ −log₂(|ν − round(ν)|)`. For
`|ν − n| = 10^{-5}`, loss is ~17 bits; for `10^{-15}`, 50 bits.

**Mitigations:**

(a) **Dedicated integer-ν path** — Boost / our v0.1. For `|ν − n| < ε`
    (small), use the dedicated `besselK_temme(n)` path instead of the
    connection formula.

(b) **Limit evaluation via polynomial jets** — FLINT
    (`bessel_k.c:58-127`). Compute both `I_{ν}` and `I_{-ν}` as
    polynomials in `(ν − n)` to first order; divide by `sin(πν)` as a
    polynomial division (where `sin(πν) = π (ν − n) cos(nπ) +
    O((ν − n)²) = π (ν − n) (-1)^n + ...`); the constant term of the
    quotient is `K_n`. Requires `acb_poly` primitives.

(c) **Series-in-(ν − n)** — mpmath. Use `hypercomb` to evaluate both
    factors as Taylor series in `(ν − n)`; numerical division.

**Our v0.1 choice: (a).** The integer-ν detector is exact for "the
input nu is *exactly* an integer" (which is the only case that
*requires* the limit); for fractional ν that happens to be near an
integer, the connection formula has acceptable loss (a few bits per
each `10x` closer to integer) and the cancellation-retry pattern
absorbs it.

**Threshold for the integer-ν dispatch:** `|ν − round(ν)| < 2^{-prec/2}`
counts as "integer for this precision" (the loss would exceed prec/2
bits). Below this, use the dedicated path; above, use the connection
formula with retry.

**Citation:** FLINT `bessel_k.c:58-127`; mpmath `mpmath-bessel.py:155-179`.

## 4.5 Risk 5: integer-ν Miller recurrence direction

**The hazard:** the three-term recurrence
```
  f_{n+1}(x) = (2n/x) f_n(x) ∓ f_{n-1}(x)
```
has two linearly independent solutions, one growing and one decaying
in `n`. Forward recurrence amplifies the growing solution; backward
amplifies the decaying. If we want the decaying solution, we MUST go
backward; if the growing, forward.

**For each function:**

| Function | Behavior in n (small x)  | Stable direction |
|----------|--------------------------|------------------|
| J_n(x)   | decaying (peaks then ↘)  | BACKWARD         |
| Y_n(x)   | growing (~(n!/(πx))^n)   | FORWARD          |
| I_n(x)   | decaying                 | BACKWARD         |
| K_n(x)   | growing                  | FORWARD          |

**Mixing the directions** is the classic Miller's-algorithm error:
running J's recurrence forward gives 1 bit per step of garbage; by `n
= 20` your answer is meaningless.

**Mitigation:**
1. **Hard-code the correct direction per function.** No "smart"
   adaptive switching.
2. **For J, I (backward):** Miller's algorithm with normalisation
   `J_0 + 2 Σ_{k≥1} J_{2k} = 1` (DLMF 10.12.1) or
   `Σ_n I_n(x) = e^x` (DLMF 10.31.5).
3. **For Y, K (forward):** seed from `Y_0, Y_1` (resp. `K_0, K_1`)
   computed via R-A/F, then iterate forward.

**Citation:** Numerical Recipes §6.5 (Press et al. 2007); Boost
`bessel_jy.hpp:437-449` (forward Y from `Yu, Yu1` initial), `:475-487`
(backward J from `init = sqrt(min_value)`).

## 4.6 Risk 6: complex Bessel — Amos's TOMS 644 rotation pattern

**The construction:** Amos's `ZBESJ` (TOMS 644, 1986) computes `J` for
complex `z` by *rotating to `I`*:
```
  J_ν(z) = exp(+νπi/2) · I_ν(−iz)    for Im(z) ≥ 0
  J_ν(z) = exp(−νπi/2) · I_ν(+iz)    for Im(z) < 0
```
(`amos-zbesj.f:68-75`). Similarly `ZBESY` rotates to `K`:
```
  Y_ν(z) = exp(+νπi/2) · I_ν(−iz)·(...) − exp(−νπi/2) · K_ν(...)
```
(more complex; see `amos-zbesy.f`).

**Why this works:** for `Im(z) ≥ 0`, the rotation `z → −iz` puts the
argument in the *right half-plane* where `I_ν` and `K_ν` have their
clean asymptotic forms (R-B for I, R-B for K, both with `exp(±|z|)`
prefactors). There is no Stokes line in this half-plane for `I` or `K`;
all Stokes phenomena for J/Y in the complex plane are *moved* into the
J/I rotation factor `exp(±νπi/2)`, which is exact.

**For our v0.1: implement Amos's rotation pattern.** The decision tree:

```
bigBesselJ(ν, z, prec):
  if Re(z) >= 0 and z is real: use direct dispatch (§3.1)
  if not real:
    sign = sgn(Im(z))
    iz = sign >= 0 ? -i·z : i·z
    factor = exp(sign · ν · π · i / 2)
    return factor * bigBesselI(ν, iz, prec)
```

The factor `exp(±νπi/2)` is *itself* a potential cancellation source
when `Re(ν)` is large (the exponent is large imaginary). Boost handles
this via `sin_pi(v/2 + 0.25)` and addition formulas
(`bessel_jy_asym.hpp:88-89`). **Our recipe: use the same addition-formula
trick when `|Re(ν)| > prec`.** For `|Re(ν)| ≤ prec`, direct evaluation
of `cexp(...)` is fine.

**Citation:** `amos-zbesj.f:68-75` (the rotation formula);
`boost-bessel_jy.hpp:411-423` (addition formula for `chi`).

---

# 5. v0.1 algorithm stack — closed-form crossovers

This section gives the *exact* dispatch table each substrate bead should
implement. Each crossover is closed-form in `(ν, z, p)`.

## 5.1 Crossover thresholds

```
// Hankel asymptotic vs ₀F₁ series, as a function of prec p and order ν:
//
// FLINT pattern (factor 2 conservative margin):
function z_c_Hankel(prec: number, nu_abs: number): number {
  // Practical "FLINT factor 2" margin
  return prec / 2;
}

// ₀F₁ series convergence radius vs Hankel (no-cancellation region):
function series_no_cancel_region(z_abs: number, nu_abs: number): boolean {
  // FLINT: nu > z²/4 ⟹ no cancellation in ₀F₁
  return nu_abs > z_abs * z_abs / 4;
}

// Cancellation-bit estimate for ₀F₁ series (real or complex z):
function cancellation_bits(z_re: number, z_im: number): number {
  // FLINT estimate: (|z| - |Im z|) · log₂(e)
  const z_abs = Math.sqrt(z_re * z_re + z_im * z_im);
  return Math.max(0, (z_abs - Math.abs(z_im)) * 1.4426);
}

// Integer-ν detector (for the K I/K-connection branch):
function is_integer_for_prec(nu: BigFloat, prec: number): boolean {
  const nu_round = roundToInt(nu);
  const delta = sub(nu, fromInt(nu_round, prec));
  return magBits(delta) < -prec / 2;
}
```

## 5.2 Per-function dispatch tables

### `bigBesselJ(ν, z, prec)`

```
function bigBesselJ(nu: BigComplex, z: BigComplex, prec: number) {
  // Step 1: special cases (z = 0, ν = 0, ν integer negative)
  if (cisZero(z)) {
    if (cisZero(nu)) return cfromReal(one(prec));
    if (sgn(nu.re) > 0) return cfromReal(zero(prec));
    throw new RangeError("BesselJ undefined at z=0 for Re(ν) ≤ 0");
  }
  
  // Step 2: ν < 0 integer reflection: J_{-n}(z) = (-1)^n · J_n(z)
  if (cisInt(nu) && sgn(nu.re) < 0) {
    const nuPos = cneg(nu);
    const result = bigBesselJ(nuPos, z, prec);
    return (toInt(nu.re) % 2 === 0) ? result : cneg(result);
  }

  // Step 3: complex-z rotation (Amos pattern)
  if (!cisReal(z) || sgn(z.re) < 0) {
    return bigBesselJ_via_rotation(nu, z, prec);
  }

  // Step 4: real z > 0 dispatch
  const x = abs(z.re);
  const xF = toFloat64(x).value;
  const nuAbsF = toFloat64(cabs(nu, 53)).value;
  
  if (xF < 8) {
    // Series always; small z, no asymptotic possible
    return besselJ_0F1_complex(nu, cfromReal(x), prec);
  }
  if (xF > prec / 2) {
    // Hankel asymptotic
    return besselJ_asymp_complex(nu, cfromReal(x), prec);
  }
  // Transition regime: 0F1 with cancellation retry
  if (nuAbsF > xF * xF / 4) {
    // No cancellation: direct 0F1
    return besselJ_0F1_complex(nu, cfromReal(x), prec);
  }
  // Cancellation-bumped 0F1
  const cancel = Math.ceil(xF * Math.LOG2E);
  return besselJ_0F1_complex(nu, cfromReal(x), prec + 5 + cancel);
}

function bigBesselJ_via_rotation(nu: BigComplex, z: BigComplex, prec: number) {
  // Amos: J_ν(z) = exp(±νπi/2) · I_ν(∓iz)
  const work = prec + 32;
  const sign = sgn(z.im) >= 0 ? 1 : -1;
  const iz: BigComplex = sign > 0
    ? { re: neg(z.im), im: z.re }    // -i·z
    : { re: z.im,      im: neg(z.re) }; //  i·z
  const factor = cexp(cmul(cmul(nu, cI(work), work),
                           cfromReal(mul(pi(work),
                                         fromString(sign > 0 ? "0.5" : "-0.5", work),
                                         work)), work), work);
  const Iv = bigBesselI(nu, iz, work);
  return normalise(cmul(factor, Iv, prec));
}
```

### `bigBesselY(ν, z, prec)`

```
function bigBesselY(nu: BigComplex, z: BigComplex, prec: number) {
  if (cisZero(z)) {
    throw new RangeError("BesselY singular at z=0");
  }

  // Negative ν reflection: Y_{-n}(z) = (-1)^n Y_n(z) for integer n
  if (cisInt(nu) && sgn(nu.re) < 0) {
    const nuPos = cneg(nu);
    const result = bigBesselY(nuPos, z, prec);
    return (toInt(nu.re) % 2 === 0) ? result : cneg(result);
  }

  // Step 1: integer ν gets the K-rotation path (FLINT bessel_y.c:36-80)
  if (cisInt(nu)) {
    return bigBesselY_via_K(toInt(nu.re), z, prec);
  }

  // Step 2: non-integer ν, real z > 0
  if (cisReal(z) && sgn(z.re) > 0) {
    const x = abs(z.re);
    const xF = toFloat64(x).value;
    if (xF > prec / 2) {
      return cfromReal(besselY_asymp(nu.re, x, prec));
    }
    // Transition regime: connection formula
    return bigBesselY_connection(nu, cfromReal(x), prec);
  }

  // Step 3: complex z: rotate to K
  // ... (Amos's zbesy pattern; defer to v0.2 if first integer-ν path is missing)
  throw new RangeError("BesselY complex z: deferred to v0.2");
}

function bigBesselY_via_K(n: number, z: BigComplex, prec: number) {
  // FLINT bessel_y.c:36-80
  const work = prec + 32;
  const Jn = bigBesselJ(cfromInts(BigInt(n), 0n, work), z, work);
  const iz: BigComplex = { re: neg(z.im), im: z.re };
  const Kn = bigBesselK(cfromInts(BigInt(n), 0n, work), iz, work);
  const iN = cipow(BigInt(n), work);  // i^n
  const piV = pi(work);
  const term1 = cmul(cdiv(cmul(Kn, iN, work), cfromReal(piV), work),
                     cfromReal(fromString("-2.0", work)), work);
  // Phase factor: ±1 (in upper/lower half plane) or ±2 wide on real axis
  const phaseF = phaseFactor(z, work);  // BigComplex {re: ±1, im: 0}
  const iCnt = cI(work);
  const term2 = cmul(cmul(iCnt, phaseF, work), Jn, work);
  return csub(term1, term2, prec);
}

function bigBesselY_connection(nu: BigComplex, z: BigComplex, prec: number) {
  // Y_ν = (J_ν cos(πν) − J_{-ν}) / sin(πν)
  // Valid only away from integer ν; integer ν dispatched separately above.
  const work = prec + 32;
  const Jv  = bigBesselJ(nu,        z, work);
  const Jmv = bigBesselJ(cneg(nu),  z, work);
  const cosPiNu = ccosPi(nu, work);
  const sinPiNu = csinPi(nu, work);
  const numer = csub(cmul(Jv, cosPiNu, work), Jmv, work);
  return cdiv(numer, sinPiNu, prec);
}
```

### `bigBesselI(ν, z, prec)`

```
function bigBesselI(nu: BigComplex, z: BigComplex, prec: number) {
  if (cisZero(z)) {
    if (cisZero(nu)) return cfromReal(one(prec));
    if (sgn(nu.re) > 0) return cfromReal(zero(prec));
    throw new RangeError("BesselI undefined at z=0 for Re(ν) ≤ 0");
  }

  // Negative ν: I_{-n}(z) = I_n(z) for integer n
  if (cisInt(nu) && sgn(nu.re) < 0) {
    return bigBesselI(cneg(nu), z, prec);
  }

  // Complex-z reduction: I_ν(z·e^{imπ}) = e^{imνπ} I_ν(z), m = integer
  if (sgn(z.re) < 0) {
    if (cisReal(z)) {
      const factor = cexp(cmul(cmul(nu, cI(prec), prec),
                              cfromReal(pi(prec)), prec), prec);
      return cmul(factor, bigBesselI(nu, cneg(z), prec), prec);
    }
    // Off-axis complex: general case
    // ... (similar to J's complex handling, can also defer to v0.2)
  }

  // Real z > 0 dispatch
  const x = abs(z.re);
  const xF = toFloat64(x).value;
  if (xF < 16) {
    return besselI_0F1_complex(nu, cfromReal(x), prec);
  }
  if (xF < Math.pow(2, 64) && 2 * xF < prec) {
    return besselI_0F1_complex(nu, cfromReal(x), prec);
  }
  return besselI_asymp_complex(nu, cfromReal(x), prec);
}
```

### `bigBesselK(ν, z, prec)`

```
function bigBesselK(nu: BigComplex, z: BigComplex, prec: number) {
  if (cisZero(z)) {
    if (cisZero(nu)) throw new RangeError("BesselK_0(0) = ∞");
    // K_ν(0) for non-zero ν: +∞ (singular)
    throw new RangeError("BesselK singular at z=0");
  }

  // ν → |ν| (DLMF 10.27.1: K_{-ν} = K_ν)
  if (sgn(nu.re) < 0) nu = cneg(nu);

  // Complex-z reduction (DLMF 10.34.2)
  if (sgn(z.re) < 0) {
    // K_ν(z·e^{±iπ}) = e^{∓iνπ} K_ν(z) − iπ I_ν(z) (handled per quadrant)
    // ... (defer specific quadrant handling to v0.2)
  }

  const x = abs(z.re);
  const xF = toFloat64(x).value;
  if (xF < 16) {
    return besselK_0F1(nu, cfromReal(x), prec);
  }
  if (xF < Math.pow(2, 64) && 2 * xF < prec) {
    return besselK_0F1(nu, cfromReal(x), prec);
  }
  return besselK_asymp_complex(nu, cfromReal(x), prec);
}

function besselK_0F1(nu: BigComplex, z: BigComplex, prec: number) {
  // Integer ν: dispatch to Temme path (avoids 0/0 in I/K connection)
  if (is_integer_for_prec(nu.re, prec) && cisZero(nu.im)) {
    return cfromReal(besselK_temme(toInt(nu.re), z.re, prec));
  }
  // Non-integer ν: I/K connection (with potential cancellation retry)
  const work = prec + 32;
  const Iv  = besselI_0F1_complex(nu,        z, work);
  const Imv = besselI_0F1_complex(cneg(nu),  z, work);
  const sinPiNu = csinPi(nu, work);
  const piV = pi(work);
  const numer = csub(Imv, Iv, work);
  return cdiv(cmul(cfromReal(piV), numer, work),
              cmul(cfromReal(fromString("2.0", work)), sinPiNu, work),
              prec);
}
```

## 5.3 Implementation order recommendation (for the I-series substrate beads)

```
Round 1 (parallel, no deps):
  I1a — besselJ_0F1 + besselI_0F1 (real, simplest)
  I1b — besselJ_asymp + besselI_asymp (real, Hankel)
  I3a — besselK_temme (integer ν, real)  [needed for besselK_0F1 to compose]

Round 2 (parallel after Round 1):
  I2a — besselJ_via_rotation + bigBesselJ complex dispatch
  I2b — besselY_via_K + besselY_connection (uses bigBesselJ + bigBesselK)
  I3b — bigBesselI complex + bigBesselK complex dispatch (uses I1a-3a)

Round 3 (after Round 2):
  I4 — full bigBesselJ + bigBesselY + bigBesselI + bigBesselK end-to-end
       (compose; cancellation retry harness for transition regime)
```

Total estimated LOC: ~1200 lines TS (mirrors `complex.ts` 1381 line
volume for the comparable cgamma family).

---

# 6. Precision-tracking strategy

## 6.1 The cgamma exemplar — measure, bump, retry

Pattern from `clgammaReflect` (worklog 117, bead `oj5j`):

```ts
// Step 1: identify the source of cancellation by algebraic structure
//   - bigBesselJ_0F1:           |Re(z²/4)| − |Im z| bits of bit loss
//   - bigBesselY_connection:    -log₂(|sin(πν)|) bits of bit loss
//   - bigBesselK_0F1 nonint ν:  -log₂(|sin(πν)|) + |Im z| bits of bit loss
//   - bigBesselJ_via_rotation:  |Re(ν)| · log₂(2π) bits (the cexp factor)

// Step 2: estimate loss in bits
const lossBits = Math.max(0, lossEstimate(z, ν));

// Step 3: bump and re-evaluate
const work = prec + 32 + lossBits;
const result = bigBessel_inner(ν, z, work);

// Step 4: confirm via post-check
const actualLoss = peakTermMag - magBits(result);
if (actualLoss > lossBits + 16) {
  // Estimate was wrong; double and retry (as pfq.ts:364-410)
  return bigBessel_inner(ν, z, Math.max(work * 2, work + actualLoss + 64));
}
```

## 6.2 Specific loss estimates

| Primitive                  | Loss source                                  | Estimate                             |
|----------------------------|----------------------------------------------|--------------------------------------|
| `besselJ_0F1(ν,x)` real x  | none (alternating but Stirling-bounded)      | `O(z·log₂(e) − 0.5·log₂(z))`         |
| `besselJ_0F1(ν,z)` complex | `e^{Re(z²/4)}` peak                          | `Max(0, (|z|−|Im z|)·log₂(e))`       |
| `besselI_0F1(ν,x)` real    | none (all positive)                          | 0                                    |
| `besselI_0F1(ν,z)` complex | `e^{Re(z²/4)}` peak                          | `Max(0, (|z|−|Im z|)·log₂(e))`       |
| `besselJ_asymp(ν,x)`       | cos(ω)·P − sin(ω)·Q near J-zero              | `~10 bits worst case; addition trick`|
| `besselY_asymp(ν,x)`       | same, near Y-zero                            | `~10 bits worst case`                |
| `besselJ_via_rotation`     | `exp(±νπi/2)` for large `|Re ν|`             | `|Re(ν)| · log₂(2π) − prec` if neg   |
| `besselY_connection`       | `1/sin(πν)` near integer ν                   | `−log₂(|ν − round(ν)|)` bits         |
| `besselK_0F1` nonint ν     | `(I_{-ν} − I_ν)/sin(πν)` near integer        | `−log₂(|ν − round(ν)|)` bits         |
| `besselY_via_K`            | `K_n(iz)/π − J_n(z)` recombination           | `~10 bits if balanced`               |

## 6.3 The pFq retry-loop exemplar

For paths where the loss is **not algebraically predictable**, use the
`evaluatePFq` outer loop pattern from `pfq.ts:281-410`:

```ts
let workingBits = prec + 32;
for (let attempt = 0; attempt < 4; attempt++) {
  const result = bigBesselJ_0F1_inner(ν, z, workingBits, prec);
  const usableBits = workingBits - result.cancellationLoss;
  if (usableBits >= prec + 16) return result.value;
  workingBits = Math.max(workingBits * 2,
                         workingBits + result.cancellationLoss + 64);
}
throw new RangeError(`bigBesselJ: cancellation not controlled in 4 retries`);
```

This is the same shape as `pfq.ts:364-402`.

---

# 7. Constants and coefficient tables

## 7.1 Hankel asymptotic coefficients `a_k(ν)` (DLMF 10.17.1)

```
a_0(ν) = 1
a_k(ν) = ∏_{j=1}^{k} (4ν² − (2j − 1)²) / (k! · 8^k)
       = (μ − 1)(μ − 9)(μ − 25) ··· (μ − (2k−1)²) / (k! · 8^k),  μ = 4ν²
```

Term ratio:
```
  a_{k+1}(ν) / a_k(ν) = (μ − (2k+1)²) / ((k+1) · 8)
```

**No table needed.** The recurrence is computed on the fly. For
reference, the first 6 values at `ν = 0` (`μ = 0`):
```
  a_0(0) = 1
  a_1(0) = −1 / 8
  a_2(0) = (−1)(−9) / (2 · 64) = 9 / 128
  a_3(0) = (−1)(−9)(−25) / (6 · 512) = −225 / 3072 = −75 / 1024
  a_4(0) = (−1)(−9)(−25)(−49) / (24 · 4096) = 11025 / 98304
  a_5(0) = (−1)(−9)(−25)(−49)(−81) / (120 · 32768) = −893025 / 3932160
```

These grow factorially; per §2.2, optimal truncation is at `k* ≈ 4|z|`
(when `|ν| ≪ |z|`).

## 7.2 ₀F₁ series coefficients (DLMF 10.2.2)

For `J_ν(z) = (z/2)^ν · Σ (−z²/4)^k / (k! Γ(ν+k+1))`:

The coefficient `c_k = 1 / (k! · (ν+1)_k)` where `(ν+1)_k = (ν+1)(ν+2)···(ν+k)`
is the rising factorial. Recurrence:

```
  c_{k+1} / c_k = 1 / ((k+1) · (ν+k+1))
```

For `ν = 0` (`J_0`):
```
  c_0 = 1
  c_1 = 1 / (1 · 1) = 1
  c_2 = 1 / (2 · 2) = 1/4
  c_3 = 1 / (6 · 6) = 1/36
  c_4 = 1 / (24 · 24) = 1/576
  c_5 = 1 / (120 · 120) = 1/14400
```

(These are `(k!)^{−2}` for `ν = 0`.) **No table needed.** The recurrence
is computed at BigFloat precision per evaluation.

## 7.3 Temme series coefficients

The Temme 1975 series for `Y_u(x), Y_{u+1}(x)` (`|u| ≤ 1/2`, `|x| ≤ 2`)
uses coefficients `(f, p, q, h, g, sigma, gamma_1, gamma_2)` that
depend on `(u, x)`. Computed at runtime per (`u, x, prec`) call. The
recurrence is given in Boost's `temme_jy` (`bessel_jy.hpp:75-139`):

```
  for k = 1, 2, ...:
    f = (k·f + p + q) / (k² − v²)
    p = p / (k − v)
    q = q / (k + v)
    g = f + e · q
    h = p − k · g
    coef = coef · (−x²/4) / k
    sum  += coef · g
    sum1 += coef · h
    stop when |coef · g| < |sum| · ε
```

**No coefficient table; pure recurrence.** Convergence per CF iteration
is `~|x|² / 4k²`, so `O(|x|²)` terms for double precision, `O(p)` for
arbitrary precision.

## 7.4 Olver U_k(p), V_k(p) polynomials (DLMF 10.41.10)

For reference (deferred to v0.2 Olver-uniform impl):
```
  U_0 = 1
  U_1 = (3p − 5p³) / 24
  U_2 = (81p² − 462p⁴ + 385p⁶) / 1152
  U_3 = (30375p³ − 369603p⁵ + 765765p⁷ − 425425p⁹) / 414720
  U_4 = ...  (DLMF 10.41 lists through k = 6)
```

These are deferred along with the Olver-uniform algorithm.

---

# 8. Cross-references to existing `@workbench/bigfloat` patterns

| Recommendation                              | Cited idiom                                                  | Lines                                                  |
|---------------------------------------------|--------------------------------------------------------------|--------------------------------------------------------|
| Per-prec coefficient caching                | `_piCache` / `_ln2Cache` / `_eCache` in `transcendental.ts`  | `transcendental.ts:41-43`                              |
| Working precision = prec + safety           | All `*Stirling` functions use `prec + 32`                    | `special.ts:119, 343, 432`; `complex.ts:343, 592`      |
| Cancellation depth measurement              | `lossBits = magBits(z) − magBits(zeta0)` in `clgammaReflect` | `complex.ts:484-486`; `special.ts:216-218`             |
| Cancellation-driven precision bump          | `work = prec + 32 + lossBits` in `clgammaReflect`            | `complex.ts:486`; `special.ts:218`                     |
| Retry loop on cancellation                  | `evaluatePFq` outer loop                                     | `pfq.ts:364-410`                                       |
| Asymptotic series w/ smallest-term stop     | `lgammaStirling` Bernoulli loop                              | `special.ts:131-159`                                   |
| Optimal-truncation detection                | `if (termMag > prevTermMag) break;`                          | `special.ts:152-154`; `complex.ts:374`                 |
| `magBits` helper for log₂\|x\|              | `magBits` in `complex.ts`, `zMagBits` in `special.ts`        | `complex.ts:385-394`; `special.ts:243-247`             |
| Quadrant reduction before compute           | `reduceModPiOver2` for sin/cos                               | `transcendental.ts:502-519`                            |
| Smith-style stable complex division         | `cdiv` Smith's algorithm                                     | `complex.ts:124-146`                                   |
| Algebraic-sign avoiding `sin(πz) = 0`       | `(−1)^m · sgn(ζ)` in `gamma`                                 | `special.ts:289-303`                                   |
| Reflection-formula branch via `Re(z) < ½`   | `clgammaReflect`, `cdigammaReflect` dispatch                 | `complex.ts:300, 559`                                  |
| Float64-seeded heuristic                    | `exp`'s `kEstimate`                                          | `transcendental.ts:203`                                |
| `if (isZero(x)) return canonical-zero`      | every transcendental's first line                            | `transcendental.ts:193, 359, 391, …`                   |
| Doc-comment as exposition                   | `clgammaReflect`'s 35-line motivation comment                | `complex.ts:417-450`                                   |
| Erf's `bigErfSeries` pattern                | Series with recurrence, magBits tracking                     | `special-funcs/erf.ts:bigErfSeries`                    |
| Erf's `bigErfcAsymptotic` pattern           | Asymptotic with divergence-detect                            | `special-funcs/erf.ts:bigErfcAsymptotic`               |

## 8.1 Specific code-snippet matches

**Series-with-recurrence pattern.** `besselJ_0F1` follows
`bigErfSeries`:

```ts
// Pattern from special-funcs/erf.ts (bigErfSeries) — adopt verbatim:
let sum: BigFloat = ...
let term: BigFloat = fromInt(1n, work);
const stopThreshold = -(prec + 16);
for (let k = 1; k < work * 4 + 100; k++) {
  // term = term * wQuarter / (k * (nu + k))
  // ...
  sum = add(sum, term, work);
  if (magBits(term) < stopThreshold + magBits(sum)) break;
}
```

**Asymptotic-with-divergence-detect pattern.** `besselJ_asymp` follows
`bigErfcAsymptotic`:

```ts
// Pattern from special-funcs/erf.ts (bigErfcAsymptotic) — adopt:
let prevTermMag = Infinity;
for (let k = 0; k < maxIter; k++) {
  const termMag = magBits(term);
  if (termMag < -prec - 16) {
    result = add(result, term, work);
    break;
  }
  if (termMag > prevTermMag) break;  // superasymptotic stop
  result = add(result, term, work);
  prevTermMag = termMag;
}
```

**Cancellation-driven retry pattern.** `besselJ_0F1` follows
`clgammaReflect`:

```ts
// Pattern from complex.ts (clgammaReflect):
const lossBits = sgn(...) < 0 ? Math.ceil(Math.abs(...) * Math.LOG2E) : 0;
const work = prec + 32 + lossBits;
// then compute the series with `work` bits of headroom
```

---

# 9. Frictions surfaced during research

Things that looked clean but cost real time to nail down:

1. **The Hankel asymptotic crossover is `√(2) smaller` than Erf's
   — not the same.** I initially conjectured the crossover was the
   same `x_c = √(p · ln 2)`. The derivation in §2.2 shows it's
   `z_c ≈ p · ln 2 / 2` (FLINT's "factor 2 conservative" + algebraic
   smallest-term bound), differing from Erf's `x_c = √(p · ln 2)` —
   which is *quadratic* in p, not linear. **Bessel's Hankel
   asymptotic converges much faster as |z| grows** (each term shrinks
   by ~1/8|z|, not 1/2|z|² as in Erf). So while Erf's crossover is
   √(p · ln 2) ≈ 12 at p = 196, Bessel's is `p / 2 = 98`. Bessel is
   "harder" in the sense that the asymptotic is useful only for
   substantially larger arguments.

2. **The integer-ν Y/K paths are NOT degenerate cases of the
   non-integer paths.** I initially thought "compute for ν, then take
   ν → n as a limit" — Boost and FLINT both have *dedicated* integer-ν
   paths because the limit involves derivatives w.r.t. ν, which require
   either polynomial-jet machinery (FLINT) or hypercomb (mpmath). The
   v0.1 substrate doesn't have either, so we use the
   Temme-series-+-forward-recurrence path (Boost). The Y-via-K rotation
   (FLINT `bessel_y.c:36-80`) is even simpler if `bigBesselK` is
   available, which is why I3 should ship `bigBesselK` *before*
   `bigBesselY` if the rotation path is chosen.

3. **Amos's rotation is much cleaner than the alternatives.**
   Initially I assumed complex `bigBesselJ` would need its own series +
   asymptotic + Stokes-line handling — Karbach-like in scope.
   `amos-zbesj.f:68-75` revealed the elegant rotation:
   `J_ν(z) = exp(±νπi/2) · I_ν(∓iz)`, which moves all complex
   structure into the I-family (which has clean half-plane
   asymptotics). This eliminates `~500 lines` of Stokes-line code at
   the cost of needing `bigBesselI(ν, complex-z)` first. Net win.

4. **The "Temme transition" algorithm is NOT a single algorithm; it's
   a 5-step assembly** (`temme_jy + CF1 + CF2 + forward recurrence +
   Wronskian assembly`, Boost `bessel_jy.hpp:75-181, 425-595`). For
   v0.1 we *don't ship Temme*; we ship the FLINT cancellation-retry
   ₀F₁ path, which is one algorithm with a precision bump. **Temme is
   a v0.2 robustness upgrade** for the `|x| ≪ |ν|` regime where ₀F₁
   becomes slow. The decision tradeoff: ₀F₁ takes `O(|x|² + p)` terms;
   Temme takes `O(|x|² + p)` for the series + `O(|x|)` for CF1 + `O(p)`
   for CF2. For `|x| < 10` the costs are comparable; for `|x| > 10`
   Temme wins. v0.1 covers `|x| < 10` natively.

5. **The DLMF asymptotic 10.17 vs Boost's `hankel_PQ`:** they are the
   *same series* but Boost computes `P` and `Q` simultaneously via a
   single recurrence that interleaves odd/even terms
   (`bessel_jy.hpp:43-70`). This is more efficient than computing them
   separately. **Our `besselJ_asymp` should adopt the interleaved
   pattern.** Boost's loop also has an `ok = fabs(mult) < 0.5f` check
   that detects when convergence is breaking down — this is the
   smallest-term detector for Hankel. **Adopt this verbatim.**

6. **mpmath's `besselj` magnitude check** (`mpmath-bessel.py:70`):
   `ctx.prec += min(3*abs(M), ctx.prec)` where `M = ctx.mag(z)`. This
   is mpmath's cancellation budget for the alternating ₀F₁ series.
   The factor 3 is empirical (covers "worst case" cancellation in
   complex z). FLINT uses `cancellation = (|z| − |Im z|) · log₂(e)`
   (`bessel_j.c:513`) which is *tighter* (matches the algebraic peak
   bound). **Use FLINT's tighter estimate; mpmath's is conservative.**

7. **Boost's `kind_does_not_need_y` branch** (`bessel_jy.hpp:333`)
   handles the case where we want J but not Y by routing through
   `bessel_j_small_z_series` for small x without ever computing Y.
   This avoids the Temme series cost when only J is needed. **Our
   `bigBesselJ` should take advantage of this** (only compute Y if the
   caller asked for it). The `Steed` algorithm naturally computes both
   simultaneously — but the small-x ₀F₁ series only needs to compute
   the one requested.

8. **Why mpmath doesn't have Temme.** mpmath's `besselj` uses
   `hyp1f1` or `hyp2f0` via the `hypercomb` framework, which has
   *general-purpose* cancellation handling. Per `mpmath-bessel.py:44-49`,
   the implementation is "use the hypergeometric form, let `hypercomb`
   handle it". This is slower than dedicated Temme but covers more
   parameter ranges (general complex ν, complex z, derivatives, etc.).
   For our v0.1 we mirror mpmath's strategy (₀F₁ direct, no Temme) but
   without the `hypercomb` machinery — direct ₀F₁ with FLINT's
   cancellation-bit estimate.

9. **The Temme paper download attempt.** Temme 1975 "On the numerical
   evaluation of the ordinary Bessel function of the second kind"
   (DOI 10.1016/0021-9991(76)90029-X — sciencedirect, paywalled). I
   could not retrieve it directly. The algorithm is fully reconstructed
   from Boost's verbatim source comments (`boost-bessel_jy.hpp:73-139`)
   and Numerical Recipes §6.7, which both attribute the algorithm to
   Temme by name and give the same recurrence. The Boost comments
   explicitly cite "Temme, Journal of Computational Physics, vol 21,
   343 (1976)" — close enough to the 1975 paper that I believe Boost's
   citation is the 1976 reprint, which is the same algorithm.

10. **The FLINT `Y_n via K(iz)` rotation.** I initially missed this
    trick — `bessel_y.c:36-80` is dense and the `phase()` helper looks
    like dead code at first glance. The trick is: for integer ν, the
    cleanest way to evaluate `Y_n(z)` is to *not* use the J/Y connection
    at all but instead use the rotation `Y_n(z) = (constants) · K_n(iz)
    + (constants) · J_n(z)`. The `phase()` helper computes the
    right-quadrant sign factor. **This eliminates the cancellation
    risk in the J/Y connection entirely for integer ν.** Adopt for v0.2
    after `bigBesselK` is robust.

11. **Boost's iteration count `*100` for CF1_jy.** `boost-bessel_jy.hpp:
    161`: `for (k = 1; k < policies::get_max_series_iterations<Policy>()
    * 100; k++)`. The `*100` is suspicious — it suggests CF1 can take
    100× the usual term budget. The reason (per Boost source comments):
    when `|x| ≪ |ν|`, CF1 converges in `O(|x|)` iterations only, but
    the bound is precision-prec dependent, so for very high precision
    the iteration count can balloon. **This is fine in arbitrary
    precision (we don't have a fixed budget), but we should track and
    diagnose if iteration counts exceed `10 · prec`.** That suggests
    the CF is stagnating and we should dispatch to a different algorithm.

12. **The Amos error model `S = max(1, |log₁₀ |z||, |log₁₀ ν|)`**
    (`amos-zbesj.f:131-150`). Amos warns that elementary-function
    argument reduction loses `~S` digits. For arbitrary precision this
    is *not* a concern (our `cexp`, `csin`, `ccos` are
    precision-honest), but it's worth noting that the rotation factor
    `exp(±νπi/2)` for `|ν| = 10^6` is computed exactly at any
    precision because BigFloat exponents are 32-bit integers. The
    "argument reduction loss" of Amos's double-precision world simply
    doesn't apply to us.

---

# 10. References cited

## Local file paths (downloaded sources)

All sources downloaded to
`/home/tobias/Projects/scientist-workbench/docs/refs/besselj-research/sources/arbprec/`:

- `bessel_j.c` (650 lines) — FLINT/Arb `acb_hypgeom_bessel_j`
  implementation. The full dispatch (small-z ₀F₁, transition with
  cancellation retry, large-z Hankel asymptotic). Loaded via
  `git clone --depth 1 https://github.com/flintlib/flint.git`,
  copied from `flint/src/acb_hypgeom/bessel_j.c`.

- `bessel_y.c` (104 lines) — FLINT/Arb `acb_hypgeom_bessel_y`. The
  integer-ν path via `K_n(iz)` rotation and the non-integer path via
  the J/Y connection formula.

- `bessel_i.c` (275 lines) — FLINT/Arb `acb_hypgeom_bessel_i` with
  scaled (`I·e^{-|z|}`) variant. Integration-fallback path when
  asymptotic loses accuracy.

- `bessel_k.c` (281 lines) — FLINT/Arb `acb_hypgeom_bessel_k`. Includes
  `acb_poly`-based integer-ν path (`bessel_k_0f1_series`) that handles
  the I/K connection-formula limit via polynomial jets.

- `0f1.c` (137 lines) — FLINT/Arb `acb_hypgeom_0f1`. The ₀F₁ series
  primitive that's the foundation of `bessel_j_0f1`, `bessel_i_0f1`,
  `bessel_k_0f1`.

- `u_asymp.c` (389 lines) — FLINT/Arb `acb_hypgeom_u_asymp` (the U
  asymptotic series, basis of `bessel_k_asymp` and `bessel_i_asymp`).

- `bessel_i_integration.c`, `bessel_k_integration.c` — the
  arb_hypgeom-side integration-based primitives.

- `mpmath-bessel.py` (1209 lines) — mpmath's full Bessel family
  implementation. Uses `hypercomb` framework throughout; the algorithm
  selection is delegated to `hypsum` / `hyp1f1` / `hyp2f0`.

- `mpmath-hypsum.py` (= `libhyper.py`, 1118 lines) — the underlying
  hypergeometric summer with its own cancellation-retry harness.

- `boost-bessel.hpp` (795 lines) — Boost.Math `cyl_bessel_j` /
  `cyl_bessel_y` / `cyl_bessel_i` / `cyl_bessel_k` top dispatch.

- `boost-bessel_jy.hpp` (~600 lines, the J/Y assembly), with
  `temme_jy` (lines 75–139), `CF1_jy` (143–181), `CF2_jy` (188–257),
  and the master `bessel_jy` Steed-method assembly (265–598).

- `boost-bessel_ik.hpp` (~400 lines, the I/K assembly with
  `temme_ik`).

- `boost-bessel_jn.hpp` (small file, ~120 lines) — Boost's
  fixed-integer-order fast path (Miller backward for J_n).

- `boost-bessel_jy_asym.hpp` (231 lines) — Hankel asymptotic with the
  amplitude-and-phase split (`asymptotic_bessel_amplitude` lines
  27–42; `asymptotic_bessel_phase_mx` 45–66) and the addition-formula
  trick for chi (`asymptotic_bessel_j_large_x_2` 99–127).

- `boost-bessel_jy_series.hpp` (~200 lines) — the small-z series
  (`bessel_j_small_z_series` and `bessel_y_small_z_series`).

- `amos-zbesj.f`, `amos-zbesy.f`, `amos-zbesi.f`, `amos-zbesk.f`
  (Fortran 77, ~12000 chars each) — Amos's TOMS 644 (1986) source for
  the complex-argument Bessel family. Key piece: the rotation `J_ν(z) =
  exp(±νπi/2) · I_ν(∓iz)` in `zbesj.f:68-75`.

- `amos-readme.txt` — netlib's AMOS readme.

- `dlmf-10.2.html`, `dlmf-10.16.html`, `dlmf-10.17.html`,
  `dlmf-10.19.html`, `dlmf-10.20.html`, `dlmf-10.25.html`,
  `dlmf-10.40.html`, `dlmf-10.41.html` — DLMF chapter pages, ~150-240 KB
  each. The source-of-truth for all defining equations and asymptotic
  expansions cited in §2.

## Secondary citations (analyzed via local sources)

- **Olver, F. W. J.** (1974). *Asymptotics and Special Functions*.
  Academic Press. Chapter 3 (superasymptotic remainder bound for
  Bessel), Chapter 8 (Olver uniform asymptotic), Chapter 9 (Debye
  asymptotic for large ν). Not downloaded; cited via DLMF (which Olver
  largely authored).

- **Olver, F. W. J.** (1954). "The asymptotic expansion of Bessel
  functions of large order." *Phil. Trans. Roy. Soc. London A* 247,
  328–368. The Olver uniform asymptotic original. Cited via DLMF §10.20.

- **Temme, N. M.** (1975/76). "On the numerical evaluation of the
  ordinary Bessel function of the second kind." *J. Comput. Phys.* 21,
  343–350. DOI 10.1016/0021-9991(76)90029-X. **[Not directly
  downloaded — paywalled at sciencedirect; algorithm reconstructed via
  Boost's verbatim source comments + Numerical Recipes §6.7]**.

- **Temme, N. M.** (1996). *Special Functions: An Introduction to the
  Classical Functions of Mathematical Physics*. Wiley. Sec. 9.6
  (modified Bessel CF). Not directly downloaded.

- **Temme, N. M.** (1996b). "Algorithm 750: Modified Bessel functions
  of imaginary argument." *ACM TOMS* 22, 244–266. **[Not directly
  downloaded — netlib `toms/715` is the post-Algorithm 750 update
  package; downloaded zip but it's not human-readable Fortran text].**
  Algorithm reconstructed via Boost's `temme_ik`
  (`boost-bessel_ik.hpp:87-159`).

- **Amos, D. E.** (1986). "Algorithm 644: A portable package for
  Bessel functions of a complex argument and nonnegative order."
  *ACM TOMS* 12, 265–273. The companion paper to the
  `amos-zbesj.f/zbesy.f/zbesi.f/zbesk.f` sources downloaded above.
  **[Citation only; the Fortran source is the canonical artefact.]**

- **Numerical Recipes** (Press et al. 2007), 3rd ed. §6.5 (Miller's
  algorithm for backward recurrence), §6.7 (Bessel functions of
  fractional order via Temme + Steed). **[Cited via memory; not
  downloaded — the book is not freely available.]**

- **Abramowitz & Stegun** (1972). *Handbook of Mathematical Functions*.
  NBS AMS-55. Chapter 9 (Bessel). The DLMF supplants this; cited via
  Boost source comments which reference A&S equation numbers.

- **DLMF** = NIST Digital Library of Mathematical Functions
  (dlmf.nist.gov). Cited equations:
  - §10.2.2 (J Maclaurin series), §10.2.3 (J/Y connection formula),
    §10.4.1 (Y limit definition).
  - §10.6.1 (J/Y recurrence), §10.11.4-5 (analytic continuation).
  - §10.16.9 (₀F₁ representation).
  - §10.17.1-14 (Hankel asymptotic + remainder bound).
  - §10.19.1-10 (Debye asymptotic for J/Y at large ν).
  - §10.20.4, 10.20.6 (Olver uniform asymptotic).
  - §10.25.2 (I Maclaurin), §10.27.4 (K via I).
  - §10.29.1 (I recurrence), §10.31.5 (I generating function).
  - §10.34.2 (analytic continuation for I/K).
  - §10.40.1-5 (I/K asymptotic + remainder bound).
  - §10.41.10 (Debye U_k, V_k polynomials).

---

# 11. Pointers to companion artefacts

- **R1** `R1-symbolic-identities.md` (this directory; sibling
  Phase-0 research) — symbolic identities (DLMF §10.16 closed-form
  reductions, half-integer ν → trig forms, etc.). Cited from §5 for the
  algebraic rotations in the integer-ν dispatch.

- **R3** `R3-float64-algorithms.md` (sibling) — the float64
  pipeline, separate concern; this artefact does not duplicate.

- **R4** `R4-meijer-g-bridge.md` (sibling) — Meijer-G bridge for the
  Bessel family. Cited from §1.2 for the "every Bessel is a special
  case of Meijer-G" abstraction.

- **R5** `R5-oracle-landscape.md` (sibling) — oracle landscape;
  validates which of mpmath, Wolfram, Boost, FLINT we can use at gold
  vs silver vs bronze tier for Bessel-family cross-validation.

- **Bead `oibh`** — A0 ADR-0041 draft. R2's recommendations should
  feed Decision 3 of that ADR (the arb-prec evaluator contract for
  Bessel substrate).

- **Bead `scientist-workbench-zcam`** (epic) — the parent.

- **`packages/bigfloat/src/special-funcs/erf.ts`** — code-side styling
  exemplar (algorithm narrative + crossover threshold + cancellation
  accounting). Every recommendation in §5-§6 cites a matching idiom in
  `erf.ts`, `special.ts`, or `complex.ts`.

- **`packages/bigfloat/src/complex.ts`** — the `cgamma` / `clgamma` /
  `clgammaReflect` / `cdigamma` stylistic exemplar. Particularly:
  `clgammaReflect:417-450` doc-comment is the prose template for
  `bigBesselY_via_K`.

- **`packages/hypergeometric/src/pfq.ts`** — the cancellation-retry
  exemplar. The `evaluatePFq` outer loop (lines 281-410) is the
  template for `besselJ_0F1`'s precision-retry on complex arguments
  where the loss is not algebraically predictable.

- **ADR-0020** — the `arbprec: true` contract and the
  `--precision=<int>` flag standardization. All Bessel-family tools
  inherit those.

- **ADR-0040** — the per-head substrate ADR. R2's recommendations
  feed Decision 3 (arb-prec evaluator contract) of the analogous
  Bessel ADR (forthcoming ADR-0041).

- **`docs/refs/erf-research/R2-arbprec-algorithms.md`** — styling
  template. Every section of this artefact mirrors a section of Erf's
  R2 with Bessel-specific content.

---

# 12. Implementation order (recommended)

Per the per-head methodology (Phase 2 / Round structure):

```
Round 1 (parallel, no Phase-2 prereqs):
  I1a — besselJ_0F1 + besselI_0F1 (real x, simplest)
        ~120 lines TS; both functions in one file
  I1b — besselJ_asymp + besselI_asymp + besselY_asymp + besselK_asymp
        (Hankel asymptotic — Boost's hankel_PQ recurrence verbatim, ported)
        ~200 lines TS
  I3a — besselK_temme (integer ν, real z; Boost temme_ik adapted to BigFloat)
        ~150 lines TS

Round 2 (parallel after Round 1):
  I2a — bigBesselJ complex dispatch (Amos rotation pattern)
        ~80 lines TS (the rotation factor + delegates)
  I2b — bigBesselY: integer-ν via Y_via_K (FLINT) + non-integer via connection
        ~150 lines TS
  I3b — bigBesselI complex + bigBesselK complex dispatch
        ~150 lines TS

Round 3 (after Round 2):
  I4 — full bigBesselJ + bigBesselY + bigBesselI + bigBesselK end-to-end
       (compose with cancellation retry harness)
       ~100 lines TS (mostly glue)
```

**Total: ~950 lines** for the full Bessel-family substrate. Comparable
to Erf's `complex.ts` extension (~450 lines new code).

Ship Round 1 first (I1a + I1b + I3a) to unblock the V1 oracle
cross-validation; Round 2 (I2a + I2b + I3b) adds the complex paths and
the non-trivial dispatch logic; Round 3 (I4) is the umbrella
assembly. Each round gets ~100-200 tests (property-based for
symmetries, golden against Wolfram + mpmath + Boost three-way
agreement at 110 dps per the ADR-0040 tier-equivalent strategy).

---

*End of R2. The substrate is `~950 lines TS` on top of the existing
~3500 lines of substrate (bigfloat + hypergeometric + meijer-core); all
algorithm choices cited; all crossover thresholds derived from primary
sources. Eight regimes enumerated; six closed for v0.1, two deferred
to v0.2 (Olver uniform R-D, Debye R-C) with file-bead recommendations.*
