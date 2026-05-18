# R2 — Arbitrary-precision algorithms for the Gamma family

**Bead:** `scientist-workbench-vf19` (R2 deep research, Gamma-family epic
`scientist-workbench-xqc7`).
**Audience:** the implementer of the full Gamma-family substrate for
`@workbench/bigfloat` — the future substrate beads for `Gamma`, `LogGamma`,
`RecipGamma`, `Digamma`, `Trigamma`, `Polygamma(m,z)`, `Pochhammer`,
`IncompleteGammaUpper`, `IncompleteGammaLower`, `IncompleteGammaP`,
`IncompleteGammaQ`, `Beta`, `IncompleteBeta`, `InverseIncompleteGamma`,
`InverseIncompleteBeta`, `BarnesG`, `Hyperfactorial`.
**Substrate exemplar:** `packages/bigfloat/src/special.ts` and
`packages/bigfloat/src/complex.ts` (existing Gamma substrate, audited in
§0); `packages/bigfloat/src/special-funcs/erf.ts` (algorithm narrative
style); `docs/refs/erf-research/R2-arbprec-algorithms.md` (exemplar
structure).
**Decision principle:** *what would a legendary TS senior engineer demand?*
Closed-form prec-dependence for every truncation parameter; one primitive per
cancellation regime; no untraceable empirical fits; ground-truth citation per
claim.
**Primary sources consulted:**
- DLMF Ch. 5 (Gamma) §5.5, §5.10, §5.11, §5.15, §5.17
- DLMF Ch. 8 (Incomplete Gamma) §8.2, §8.7, §8.9, §8.11, §8.12, §8.17
- FLINT/Arb `src/arb_hypgeom/gamma.c`, `lgamma.c`, `gamma_upper.c`,
  `gamma_lower.c`, `rgamma.c`; `src/acb_hypgeom/gamma.c`, `lgamma.c`,
  `polygamma.c`, `barnes_g.c` (GitHub `flintlib/flint` main branch; fetched
  2026-05-18)
- mpmath `mpmath/functions/gamma.py` (GitHub `mpmath/mpmath` main branch)
- Boost.Math `boost/math/special_functions/lanczos.hpp` (GitHub
  `boostorg/math` develop branch)
- Temme (1979) "The asymptotic expansion of the incomplete gamma functions",
  SIAM J. Math. Anal. 10(4)
- DiDonato & Morris (1986) ACM TOMS 12(4) — incomplete gamma
- Gautschi (1979) Algorithm 542 — incomplete gamma, ACM TOMS 5(4)
- Adamchik (2001) "On the Barnes function", ISSAC 2001
- Spouge (1994) "Computation of the Gamma function using Spouge's formula",
  SIAM J. Numer. Anal. 31(3)
- Pugh (2004) "An Analysis of the Lanczos Gamma Approximation", PhD thesis

---

## Table of contents

- §0 — Audit of existing substrate
- §1 — Per-function algorithm dispatch table
- §2 — Detailed algorithm derivations
  - §2.1 Stirling vs Lanczos vs Spouge for Γ at arb-prec
  - §2.2 Polygamma m≥2 via Hurwitz zeta (Euler-Maclaurin)
  - §2.3 Series vs CF crossover for incomplete gamma
  - §2.4 Temme uniform asymptotic for the a ≈ z transition region
  - §2.5 Regularised vs unregularised: precision considerations
  - §2.6 Binary splitting for Γ(rational) at high precision
  - §2.7 Newton/Halley iteration for InverseIncompleteGamma
  - §2.8 Barnes G-function: Adamchik + DLMF 5.17.5 route
  - §2.9 Pochhammer: direct product vs Γ-ratio
- §3 — Critical risks
- §4 — v0.1 deferrals (honest scope)
- §5 — Per-head TS signatures
- §6 — Determinism analysis

---

## §0 — Audit of existing substrate

The existing Gamma substrate lives across two files:

- `packages/bigfloat/src/special.ts` (474 LOC) — `lgamma`, `lgammaStirling`,
  `lgammaRealAbs`, `gamma`, `digamma`, `digammaStirling`, `trigamma`,
  `trigammaStirling`, `polygamma` (dispatch to m=0 and m=1 only), `bernoulli`
  helper.
- `packages/bigfloat/src/complex.ts` (lines 380–806 relevant) — `clgamma`,
  `clgammaShifted`, `clgammaStirling`, `clgammaReflect`, `cgamma`, `cdigamma`,
  `cdigammaShifted`, `cdigammaStirling`, `cdigammaReflect`, plus `magBits` and
  local Bernoulli helpers.

### §0.1 Algorithm inventory

**`lgamma(z, prec)` — `special.ts:72–108`**

Algorithm: Stirling-with-recurrence-shift. For z > 0, shifts z up to
`shiftThreshold = max(8, ceil((prec+96)/8))`, then evaluates Stirling's
asymptotic (DLMF 5.11.1) and subtracts `Σ log(z+k)`. For z ≤ 0, delegates
to `lgammaRealAbs`.

Shift threshold derivation: Stirling's series is valid when `|z| ≥ BETA·prec`
with BETA ≈ 1/8 (from FLINT's `choose_small`, which sets
`w = max(1, BETA·prec)` with BETA 0.17–0.24 depending on precision). The
local code uses `work/8` as a proxy. **Assessment:** the threshold formula
`shiftThreshold ≈ (prec+96)/8` is consistent with FLINT's target
`z' ≥ 0.17 · prec` at low precision and `z' ≥ 0.24 · prec` at high
precision. The local factor 1/8 = 0.125 sits between these values — valid
but slightly loose at high precision (≥ 64K bits) where FLINT would use 0.24.
Practical impact: at most a few extra shift steps; negligible.

**Cancellation-retry slot:** present via `lgammaRealAbs` which computes
`lossBits = max(0, zMagBits(z) - zMagBits(zeta))` and bumps
`work = prec + 32 + lossBits`. This mirrors `clgammaReflect` (worklog 117,
bead `oj5j`). The pattern is correct and matches the ADR-0040 §Decision 3
discipline. ✓

**Mutation-proof spots:** (a) removing the `lossBits` bump causes precision
collapse near integer arguments; (b) removing the `m===0` early-exit case
corrupts the `z ∈ (−½, ½)` region; (c) substituting a wrong Stirling
coefficient (e.g., changing `B_2/12z` to `B_2/6z`) shifts the asymptotic
value by a fixed relative error > 2^-prec, causing golden-master failure.

**Lift opportunity:** the `lgammaStirling` inner loop does not optimise the
Stirling coefficient evaluation at the precision boundary. At `termMag < -prec
- 16` it adds the term and breaks — correct. However, the Horner vs
naive-summation decision (FLINT uses `gamma_stirling_sum_horner` for
`prec ≤ 128` / N ≤ 40 and `_sum_improved` otherwise) is not yet implemented.
For `prec > 128` the improved summation using binary splitting of the
Bernoulli-coefficient partial sums would be faster, but this is a
performance-not-correctness lift. File as a v0.2 optimisation bead.

**`lgammaRealAbs(z, prec)` — `special.ts:187–236`**

Same algorithm as `clgammaReflect` but for real z. Reduction `z → ζ = z − m`
before multiplying by π is correctly implemented. Sign convention: result is
`log|Γ(z)|` regardless of sign. ✓

**`gamma(z, prec)` — `special.ts:271–304`**

For z > 0: `exp(lgamma(z, prec+32))`. For z < 0 non-integer: algebraic sign
determination using `(m % 2 === 0 ? zetaSgn : −zetaSgn)` (bead `zhrm`). No
`sin` call for sign detection — structurally correct and avoids the near-pole
spurious pole error. ✓

**`digamma(z, prec)` — `special.ts:313–358`**

For z ≤ 0: the negative-argument branch is **explicitly deferred** (throws
`RangeError: digamma: negative argument support deferred to v0.2`). The
reflection formula `ψ(1−z) − ψ(z) = π·cot(πz)` is noted but not
implemented in the real path. **Gap identified.** `cdigammaReflect` in
`complex.ts:741–806` implements the full near-pole-safe reflection with
`lossBits` accounting. The real path should mirror this. For the Gamma-family
epic this is a concrete implementation task: `digamma(z, prec)` for z < 0,
non-integer, must work via the real-argument reflection, not just throw.
**Filed as a lift target.**

For z > 0: Stirling-with-shift, same threshold as lgamma. ✓

The real `digamma` reflection has an obvious placeholder at lines 327–340:
```
const tanPiZ = div(sin(piZ, work), exp(log(abs(sin(piZ, work)), work), work), work);
const cosPiZ = sub(..., ...); // placeholder
throw new RangeError(`digamma: negative argument support deferred to v0.2`);
```
This dead code leaks — the `throw` immediately follows. The `cos` import
issue noted in the comment is real: `special.ts` does not import `cos` from
`transcendental.ts`. The fix is: import `cos` or compute `cos(πζ)` from
`cexp(±iπζ)` and take the real part (mirroring `clgammaReflect`'s `cexp`
pattern). The real-argument path does not need full complex arithmetic —
`cos(x)` exists in `transcendental.ts`.

**`trigamma(z, prec)` — `special.ts:405–425`**

For z > 0 only (throws on z ≤ 0). Same Stirling threshold. Stirling series
correct (DLMF 5.15.9: ψ'(z) ∼ 1/z + 1/(2z²) + Σ B_{2k}/z^{2k+1}). ✓

**Lift opportunity:** reflection for trigamma exists (DLMF 5.15.6):
`ψ^(n)(1−z) + (−1)^{n−1} ψ^(n)(z) = (−1)^n · d^n/dz^n cot(πz)`.
For n=1: `ψ'(1−z) − ψ'(z) = −π² / sin²(πz)`. This is the trigamma
reflection, and it handles z ≤ 0 gracefully except at integer z. Currently
`trigamma` throws for all z ≤ 0; the reflection would extend it to
non-positive non-integers. File as a lift target alongside digamma.

**`polygamma(m, z, prec)` — `special.ts:465–474`**

v0.1 stub: dispatches m=0 → digamma, m=1 → trigamma, m≥2 →
`throw RangeError("polygamma: orders m ≥ 2 not implemented in v0.1 (filed for v0.2 via Hurwitz zeta)")`. **Gap confirmed.** §2.2 below designs the m≥2 algorithm.

**`clgamma(z, prec)` — `complex.ts:388–400`**

Three-branch dispatch: (a) real positive → `lgamma`; (b) Re(z) < 1/2 →
`clgammaReflect`; (c) else → `clgammaShifted`. The reflection-branch
condition uses `sgn(sub(z.re, half, prec+16)) < 0` — correctly decides before
working-precision inflation. ✓

**`clgammaReflect(z, prec)` — `complex.ts:546–631`**

The canonical near-pole safe reflection, worklog 117 / bead `oj5j`. Reduction
`z → ζ = z − m`, `lossBits` measured and paid by `work = prec + 32 +
lossBits`. The `cexp(±iπζ)` pattern for `sin(πz)` is correct. ✓ This is the
DRY ancestor of the cancellation-retry pattern cited in ADR-0040 §Decision 3.

**`cdigamma(z, prec)` — `complex.ts:649–806`**

Three-branch: real positive → real `digamma`; Re(z) < 1/2 →
`cdigammaReflect`; else → `cdigammaShifted`. Reflection uses
`ψ(1−z) − π·cot(πz)` with the same near-pole safe pattern (cot via
`cexp(±iπζ)` and the `lossBits` accounting). ✓

**Assessment of overall substrate quality against Erf/Bessel bar:**

| Criterion | Status |
|---|---|
| Algorithm-narrative literate top-of-file comment | Partial — `special.ts` has a header block but it does not match the per-function exposition depth of `erf.ts`. Lift opportunity. |
| Cancellation-retry slot present | ✓ — in `lgammaRealAbs` and `clgammaReflect`/`cdigammaReflect` |
| Closed-form prec-dependence derivable | Partial — threshold `work/8` is not derived on-screen; the derivation exists in the asymptotic analysis (§2.1 below) but should be added as inline commentary |
| Mutation-proof spots | Yes — at least 3 per function (Stirling coefficient, `lossBits` bump, shift threshold) |
| `digamma` for z ≤ 0 | **Gap** — throws, not implemented |
| `trigamma` for z ≤ 0 | **Gap** — throws, not implemented |
| `polygamma` m ≥ 2 | **Gap** — tagged-not-implemented stub |
| Incomplete gamma (upper/lower) | **Not present** — entirely new |
| Regularised P/Q | **Not present** |
| Beta, IncompleteBeta | **Not present** |
| InverseIncompleteGamma/Beta | **Not present** |
| BarnesG | **Not present** |
| Hyperfactorial | **Not present** |
| Pochhammer | **Not present** |
| 1/Γ (entire function) | **Not present** |

**Conclusion:** the existing substrate is high-quality for its covered scope
(Γ, log Γ, ψ, ψ', all real and complex) and passes the Erf/Bessel bar on
algorithmic correctness. The gaps are in scope, not in quality. The Gamma
epic's substrate work is primarily _additive_ rather than repair-oriented —
with three targeted lifts (digamma/trigamma negative-argument, polygamma m≥2)
plus eight wholly new heads.

---

## §1 — Per-function algorithm dispatch table

The table below is the recipe each substrate bead implements. For each
function and each regime: the algorithm name, primary citation, crossover
threshold in closed form, precision-dependent formula for truncation
parameters, expected cancellation sites, and retry strategy.

### §1.1 Γ(z) and log Γ(z) — real

| Regime | z condition | Algorithm | Primary citation | Truncation N | Cancellation |
|---|---|---|---|---|---|
| Exact | z = positive integer / half-integer / rational with small denom | Closed-form via Γ(1/2)=√π + recurrence | DLMF 5.4 | — | None |
| Large | z > z_shift = max(8, prec/8) | Stirling asymptotic (DLMF 5.11.1) | FLINT `gamma.c:81–94` | N from smallest-term stop; ≤ prec/2 terms typical | None in log Γ; exp(lgamma) for Γ |
| Moderate | 0 < z ≤ z_shift | Recurrence shift + Stirling | FLINT `lgamma.c:dispatch`; local `special.ts:92–108` | Same, after shift | ≤ log(Γ(z+N)) − Σlog(z+k) cancellation bounded by ≤log(N!) ≈ N·log(N); ≤ 10 bits at z_shift ≈ prec/8 |
| Negative non-integer | z < 0 | Reflection: log|Γ(z)| = log π − log|sin(πz)| − logΓ(1−z) | DLMF 5.5.3; local `lgammaRealAbs` | Same as moderate after shift on 1−z | ζ = z − round(z); loss = max(0, magBits(z) − magBits(ζ)); work = prec + 32 + loss |
| Sign of Γ | z < 0 | Algebraic: sign = (−1)^m · sgn(ζ) | `gamma` bead `zhrm`; `special.ts:296–300` | — | None (sign is structural) |

**Stirling shift threshold derivation.** Stirling's error at truncating at
the smallest term is bounded by the magnitude of the first omitted term. For
`lgamma`, the k-th Stirling term is `B_{2k} / (2k(2k−1) z^{2k−1})`. The
smallest term occurs near `k* ≈ π|z|` (from the Bernoulli asymptotic
`B_{2k} ≈ 2(2k)!/(2π)^{2k}`), giving remainder magnitude `≈ exp(−2π|z|)`.
We need this below `2^{−prec}`:
```
exp(−2π z') < 2^{−prec}
  ⟹  z' > prec · ln(2) / (2π) ≈ prec · 0.1104
```
FLINT uses BETA ∈ {0.17, 0.20, 0.24} for a safety factor ~1.5x–2x over the
theoretical minimum. The local code uses `prec/8 = prec · 0.125` — slightly
below FLINT's low-precision BETA of 0.17. **Recommended lift:** change
`shiftThreshold = max(8, ceil((prec+96)/8))` to
`shiftThreshold = max(8, ceil(0.17 * (prec+96)))` for consistency with FLINT
at all precision levels.

### §1.2 Γ(z) and log Γ(z) — complex

| Regime | z condition | Algorithm | Primary citation |
|---|---|---|---|
| Real positive | Im(z) = 0, Re(z) > 0 | Delegate to real lgamma | `complex.ts:390–393` |
| Re(z) ≥ 1/2 | — | Stirling-shifted (same as real, but complex arithmetic) | `complex.ts:406–431`; FLINT `acb_hypgeom/lgamma.c:159–169` |
| Re(z) < 1/2 | — | Reflection: logΓ(z) = log π − log sin(πz) − logΓ(1−z) | `complex.ts:546–631` (clgammaReflect) |
| Near-pole | z near non-positive integer | Reduction ζ = z−m before πz multiply | bead `oj5j`; worklog 117 |

Taylor-series alternative (FLINT's `gamma_taylor` tier): FLINT attempts a
Taylor expansion about small integer arguments before falling back to Stirling.
The Taylor approach is superior at low precision (prec ≤ 256 bits) for `|z| ≤
5` because it avoids the large shift. At arb-prec the Taylor approach is not
yet implemented in the local substrate. **Filed as a v0.2 optimisation** — the
current Stirling-shift code is correct and fast enough for the v0.1 claim.

### §1.3 1/Γ(z) (reciprocal gamma, entire function)

| Regime | z condition | Algorithm | Primary citation |
|---|---|---|---|
| All z | any | `rgamma(z) = 1 / gamma(z)` for z away from non-positive integers | DLMF 5.2.1 |
| z = 0, −1, −2, ... | non-positive integers | `rgamma(z) = 0` exactly (poles of Γ are zeros of 1/Γ) | DLMF 5.2.1 |

The key property of `1/Γ(z)` is that it is an *entire* function — it has no
poles. The zeros at the non-positive integers are the poles of Γ mirrored.
The naive `1 / gamma(z)` works perfectly except near the integers where
`gamma(z) → ±∞`: the output tends to zero, and the numerator is exact
(`fromInt(1n, work)`), so the division is well-conditioned.

**No special reciprocal-gamma algorithm is needed at arb-prec.** The FLINT
`rgamma.c` source for arb-prec computes `rgamma(z) = exp(-lgamma(z))` or
`rgamma(z) = 1/gamma(z)` — the same approach. The only subtle case is z near
a non-positive integer: here `lgamma(z) → +∞`, `exp(-lgamma)` underflows. In
BigFloat there is no underflow (exponent range is arbitrary integers), so
`exp(-lgamma(z, prec+32), prec)` correctly gives a tiny value. But detecting
*exactly* the integers for the `= 0` case requires the same integer-detection
logic as `gamma`: `zetaSgn === 0` iff z is an exact non-positive integer.

**TS signature decision:** `bigRecipGamma(z, prec): BigFloat` — computes
`exp(-lgamma(z, prec+32))` for Re(z) > 0, or appropriately reflected for
Re(z) ≤ 0. Returns `fromInt(0n, prec)` when z is a non-positive integer
(detected exactly via the `zeta` subtraction).

### §1.4 ψ(z) (digamma) — real, negative argument

Gap identified in §0. The reflection formula (DLMF 5.15.6 at n=0 is just the
digamma reflection 5.5.6):

```
ψ(1 − z) − ψ(z) = π · cot(π z)       (DLMF 5.15.6, n=0 case)
```

is the standard algorithm for z < 0. The near-pole-safe pattern from
`cdigammaReflect` (lines 741–806 of `complex.ts`) works unchanged on the real
axis: reduce `ζ = z − round(Re z)` before multiplying by π, use
`lossBits = max(0, log₂|z| − log₂|ζ|)`, bump `work = prec + 32 + lossBits`.
The only difference from the complex path is that `cot(πζ)` on the real axis
simplifies to `cos(πζ) / sin(πζ)` with real arithmetic.

**Closed-form precision formula:** the digamma reflection cancellation depth
near the integer `m` is at most `log₂(|m| / |ζ|)` bits, where `ζ = z − m`.
At the worst representable ζ (about `2^{−prec}` for a `prec`-bit argument),
the loss is prec bits — so `work = prec + 32 + prec = 2·prec + 32` in the
degenerate case. In practice for a genuine computation the user's ζ is at
least `2^{−(prec/2)}` or so, giving `work = prec + 32 + prec/2`.

### §1.5 ψ^(m)(z) for m ≥ 2 (polygamma)

The v0.1 stub throws. §2.2 designs the full algorithm.

**Algorithm:** Hurwitz-zeta route with Euler-Maclaurin summation and the
recurrence shift. The fundamental identity (DLMF 5.15.2 generalised):

```
ψ^(m)(z) = (−1)^(m+1) · m! · ζ(m+1, z)       for m ≥ 1
```

where ζ(s, z) is the Hurwitz zeta function. The computation strategy:
(a) shift z upward via `ψ^(m)(z) = ψ^(m)(z+N) − (−1)^m · m! · Σ_{k=0}^{N-1}
(z+k)^{−(m+1)}` (DLMF 5.15.5) until z+N is Stirling-friendly; (b) evaluate
`ζ(m+1, z+N)` via the Euler-Maclaurin formula (the Stirling asymptotic for
Hurwitz zeta).

### §1.6 Pochhammer (a)_n

| Regime | Condition | Algorithm |
|---|---|---|
| n small integer (n ≤ n_direct) | n ≤ ceil(prec / log₂(|a|+2)) | Direct product: Π_{k=0}^{n−1} (a+k) |
| n large or a,n both general | — | Γ-ratio: Γ(a+n)/Γ(a) via lgamma subtraction |
| a+k crosses zero | some k ∈ [0,n) | Special cancellation handling: see §3.5 |

**Direct product crossover:** the direct product of n BigFloat numbers each
of magnitude ~|a|+n costs O(n · M(prec)) where M(prec) is BigFloat multiply
cost. The Γ-ratio costs O(M(prec) · log(prec)) (two lgamma evaluations). The
crossover is at `n ≈ M_ratio / M_mul` which at prec=200 bits is roughly
n ≈ 20. For small n (which is the overwhelmingly common case in hypergeometric
series), direct product wins.

### §1.7 IncompleteGammaUpper Γ(a, z)

This is the most algorithmically complex head. Four algorithms cover the plane.

| Regime | Condition | Algorithm | Primary citation |
|---|---|---|---|
| Series | Re(z) small, Re(a) > 0 | Power series for γ(a,z), then Γ(a,z) = Γ(a) − γ(a,z) | DLMF 8.7.3; see §2.3 |
| CF | Re(z) large vs a, Re(z) > 0 | Continued fraction for z^{-a} e^z Γ(a,z) | DLMF 8.9.2; Gautschi 1979 |
| Temme | |z − a| ≤ C·√a for large a | Temme uniform asymptotic (saddle point + erfc) | DLMF 8.12.3–4; Temme 1979 |
| Large-z asymptotic | |z| → ∞ | Poincaré asymptotic: Γ(a,z) ∼ z^{a−1} e^{−z} Σ (−1)^k (1−a)_k / z^k | DLMF 8.11.2 |

The crossover thresholds are the load-bearing decisions; see §2.3.

### §1.8 IncompleteGammaLower γ(a, z)

| Regime | Condition | Algorithm |
|---|---|---|
| Series | Re(a) > 0, |z| moderate | DLMF 8.7.1: γ(a,z) = e^{−z} Σ_{k≥0} z^{a+k} / Γ(a+k+1) |
| Derived | Large |z| | γ(a,z) = Γ(a) − Γ(a,z) once Γ(a,z) is well-conditioned |

For the lower incomplete gamma, the series (DLMF 8.7.1) is always convergent
for Re(a) > 0 and any z. The convergence rate is `|z|^k / Γ(a+k+1)` — terms
shrink geometrically for `k > |z|`. For |z| small, only O(|z| + prec/log|z|)
terms are needed.

### §1.9 IncompleteGammaP(a,z) and Q(a,z)

Regularised forms `P = γ(a,z)/Γ(a)` and `Q = Γ(a,z)/Γ(a)`. The main
precision concern is avoiding catastrophic cancellation in `P + Q = 1`.

**Key insight:** compute the smaller of P and Q directly, then derive the
other as `1 − smaller`. For `z < a`: P is small (less than 1/2 for z < a at
large a), so compute P directly via the series for γ and divide by Γ(a) — the
division is well-conditioned because Γ(a) ≠ 0. For `z > a`: Q is small,
compute Q via CF. See §2.5.

### §1.10 Beta(a, b)

```
B(a, b) = Γ(a)·Γ(b) / Γ(a+b) = exp(lgamma(a) + lgamma(b) − lgamma(a+b))
```

All three lgamma calls are at `prec + 32` bits; the final is normalised to
prec. Sign handling: if a or b is a negative non-integer, lgamma returns
log|Γ|, and the sign of B(a,b) must be computed from the signs of Γ(a),
Γ(b), 1/Γ(a+b). Since 1/Γ(a+b) > 0 for a+b not a non-positive integer, the
sign of B(a,b) is sign(Γ(a)) · sign(Γ(b)).

**Precision concern:** if a+b is near a non-positive integer, lgamma(a+b)
blows up and the computation becomes a "large − large" subtraction. This is
handled by the `lgammaRealAbs` reflection with its `lossBits` mechanism.

### §1.11 IncompleteBeta B_x(a,b) and I_x(a,b)

```
I_x(a,b) = B_x(a,b) / B(a,b)
```

| Regime | Condition | Algorithm | Citation |
|---|---|---|---|
| Continued fraction | x < (a+1)/(a+b+2) | Lentz CF, DLMF 8.17.22 | DLMF 8.17.22–23 |
| Symmetry | x > (a+1)/(a+b+2) | Use I_{1−x}(b,a) = 1 − I_x(a,b) | DLMF 8.17.4 |

The CF (DLMF 8.17.22) converges rapidly for x < (a+1)/(a+b+2); the symmetry
relation (DLMF 8.17.4) maps the complementary region to the convergent one.

### §1.12 InverseIncompleteGamma and InverseIncompleteBeta

Newton + Halley refinement from an asymptotic seed. See §2.7.

### §1.13 BarnesG(z)

Asymptotic expansion (DLMF 5.17.5) with Stirling-style shift plus Glaisher's
constant. See §2.8.

### §1.14 Hyperfactorial K(n)

`K(n) = Π_{k=1}^{n} k^k`. For integer argument, direct product. Via BarnesG:
`K(n) = G(n+1)` is not quite right; the relation is `K(n) =
G(n+1)·n!^n / G(1)^n` — more complex. For v0.1, **direct product for
integer n** is the honest algorithm; BarnesG-based for general z is a v0.2
deferral.

---

## §2 — Detailed algorithm derivations

### §2.1 Stirling vs Lanczos vs Spouge for Γ at arb-prec

**Stirling's series** (DLMF 5.11.1):
```
log Γ(z) = (z − 1/2) log z − z + (1/2) log(2π)
           + Σ_{k=1}^{N}  B_{2k} / (2k(2k−1) z^{2k−1})  + R_N
```

The remainder `R_N` is bounded by the magnitude of the N-th term when the
series is terminated at its optimal point. The series is asymptotic (diverges
if summed to infinity), so we use smallest-term truncation (the
`prevTermMag > termMag` idiom already in the code).

Number of terms at optimal truncation: from the Bernoulli asymptotic
`|B_{2k}| ≈ 2(2k)!/(2π)^{2k}`, the k-th term magnitude at large z is
approximately `k! · 2/(π·|z|)^{2k}`. The minimum occurs near
`k* ≈ π|z|/e`, so optimal truncation needs `N ≈ π·z_shift / e` terms.
At `z_shift ≈ 0.17 · prec`, we get `N ≈ 0.17π prec / e ≈ 0.197 prec`. For
prec = 200 this is ~40 Bernoulli evaluations — consistent with FLINT's
empirical observation of N ≤ 40 at prec ≤ 1024 bits.

**Lanczos approximation** (Lanczos 1964; Pugh 2004 thesis; Boost `lanczos.hpp`):
```
Γ(z + 1) ≈ √(2π) · (z + g + 1/2)^{z + 1/2} · e^{−(z+g+1/2)}
             · Σ_{k=0}^{K} c_k / (z + k)
```

for a rational function approximation with `g` and `K` chosen to achieve
prec-level accuracy. For fixed prec, `K` and `g` are constants (e.g., Boost's
`lanczos24m113` uses K=24, g≈20.3, error < 1.05·10^{-38}). The coefficient
generation (via Chebyshev-like orthogonality) requires arbitrary-precision
arithmetic during setup (Pugh thesis: "using NTL::RR at 1000-bit precision").

**Why Stirling wins over Lanczos at arb-prec:**
1. For each target precision level, Lanczos requires re-generating K and g —
   a non-trivial offline computation not amenable to runtime generation.
2. Stirling's Bernoulli coefficients are exact rationals (`bernoulliRational`
   already in the codebase) and can be evaluated to any precision on demand.
3. Stirling's error bound is explicit and precision-directly-parameterised;
   Lanczos coefficients are fit to a fixed precision and cannot be trivially
   extended.
4. At high precision (prec > 1000 bits), Stirling requires fewer
   multiplications per evaluation than Lanczos does, because the Stirling
   terms decay rapidly with correct shift while Lanczos requires computing
   (z+g+1/2)^{z+1/2} which involves `exp((z+1/2)·log(z+g+1/2))` — no
   simpler than Stirling's shifted form.

**Verdict:** the existing Stirling implementation is the correct choice.
Lanczos is appropriate for fixed-precision (float64 or 113-bit extended
double) implementations, not for `arbprec:true` substrate. Boost's
`lanczos.hpp` confirms this: it generates separate coefficient tables for each
target precision level (lanczos13m53, lanczos17m64, lanczos24m113), none of
which cover prec > 128 bits. The local code's Stirling approach is validated.

**Spouge's approximation** (Spouge 1994): an explicit construction of a
Lanczos-like rational approximant with simpler error bounds. For N terms at
prec decimal digits, `N ≈ prec · ln(10) / (2 − ln(4π) + 1)`. Same limitation
as Lanczos: the coefficients are precision-specific and require offline
generation. Not preferred for arb-prec.

**Binary splitting (Brent 1976; Karatsuba 1991):** for Γ(p/q) with p/q a
rational, binary splitting on the product formula `Γ(p/q) = (p/q−1)! =
Π_{k=1}^{n} ((p+k·q)/q)` (after reduction) achieves quasi-linear complexity
`O(M(prec) · log²(prec))`. This is the *asymptotically optimal* method for
Γ at very high precision (prec > 10,000 bits) and is the approach mpmath
uses via the `mpf_factorial` / `mpf_gammainc` fast path. For v0.1 this is
a v0.2 optimisation — Stirling is correct and fast enough at the precisions
typical of the Gamma-family epic's use cases (prec ≤ 1000 bits).

**Recommended:** maintain the existing Stirling-with-shift approach. Document
the Bernoulli-coefficient precision explicitly. Add a v0.2 bead for
binary-splitting at prec > 10,000 bits.

### §2.2 Polygamma m≥2 via Hurwitz zeta (Euler-Maclaurin)

The fundamental identity (DLMF 5.15.2 generalised by analytic continuation):

```
ψ^(m)(z) = (−1)^(m+1) · m! · ζ(m+1, z)         m ≥ 1
```

where `ζ(s, z) = Σ_{k≥0} (z+k)^{-s}` is the Hurwitz zeta function. The
algorithm:

**Step 1: Shift.** Use the recurrence (DLMF 5.15.5):
```
ψ^(m)(z) = ψ^(m)(z+N) − (−1)^m · m! · Σ_{k=0}^{N−1} (z+k)^{−(m+1)}
```
Choose N so that `z + N > shiftThreshold ≈ max(8, 0.17·prec)`.
Cost of the subtracted sum: N multiplications by `(z+k)^{−(m+1)}`.

**Step 2: Euler-Maclaurin for ζ(m+1, z+N).**
The Euler-Maclaurin summation of `Σ_{k≥0} (z+N+k)^{-(m+1)}` gives:

```
ζ(m+1, z+N) ≈ (z+N)^{-m}/m + (1/2)(z+N)^{-(m+1)}
              + Σ_{j=1}^{K}  B_{2j}·(2j+m−1)! / ((z+N)^{2j+m} · (2j)! · (m−1)!)
```

This is the Stirling-type asymptotic for the polygamma function (DLMF 5.15.9
for general m), valid as `z+N → ∞`. Optimal truncation at smallest term gives
the arb-prec-quality result.

**Number of terms.** The k-th Euler-Maclaurin term is `B_{2k} · C_{m,k} /
(z+N)^{2k+m}`. By the Bernoulli asymptotic the minimum term magnitude is
`∼ (π / |z+N|)^{2k*}` where `k* ≈ π|z+N|/e`. With `z+N ≈ 0.17·prec` bits,
we need `K ≈ 0.197·prec` terms — same as Stirling. The `prevTermMag` idiom
catches the minimum automatically.

**Step 3: Recover ψ^(m)(z) = (−1)^(m+1) · m! · ζ(m+1, z) via the shifted
value and the subtracted partial sum.**

**Working precision:** the Euler-Maclaurin partial sum at large z+N has no
cancellation (all terms are positive for real z > 0). For complex z or z < 0,
reflection may be needed (DLMF 5.15.6): `ψ^(n)(1−z) + (−1)^{n−1} ψ^(n)(z) =
(−1)^n · d^n cot(πz)/dz^n`. The n-th derivative of cot(πz) involves
Bernoulli polynomials evaluated at z — computable, but each derivative adds
complexity. For v0.1, the reflection for m≥2 can be deferred: restrict to
Re(z) > 0 and throw for Re(z) ≤ 0, matching the current trigamma behaviour.

**TS implementation plan for `polygammaHurwitz(m, z, prec)`:**
```ts
// 1. Validate m is positive integer; z is BigFloat with Re(z) > 0.
// 2. Compute shift threshold and N.
// 3. Sum the partial series Σ_{k=0}^{N-1} (z+k)^{-(m+1)} at work precision.
// 4. Evaluate the Euler-Maclaurin asymptotic for ζ(m+1, z+N).
// 5. Combine: zetaVal = eulerMaclaurin + partialSum.
// 6. Return (−1)^(m+1) * factorial(m) * zetaVal, normalised to prec bits.
```

### §2.3 Series vs CF crossover for incomplete gamma (the load-bearing decision)

**Series for γ(a, z) (DLMF 8.7.1):**
```
γ(a, z) = e^{-z} · Σ_{k=0}^{∞}  z^{a+k} / Γ(a+k+1)
```

Using the recurrence `Γ(a+k+1) = (a+k)·Γ(a+k)`, the successive ratios are:
```
term_{k+1} / term_k = z / (a+k+1)
```

Convergence: terms shrink geometrically for `k > |z| − Re(a) − 1`. The
series converges for ALL z (entire in z for fixed a), but is slow for large
|z|: we need `K > |z|` terms before geometric decay kicks in. The cost is
O(K · M(prec)) = O(|z| · M(prec)).

**Continued fraction for Γ(a, z) (DLMF 8.9.2):**
```
z^{-a} e^z Γ(a,z) = 1/(z − 1 − (1−a)/((z + 1 + (1−a)/(z − 2 − (2−a)/(z + 2 + ...)))))
```
(even-odd Legendre form; Lentz algorithm). This CF converges for `|ph z| < π`
and is geometrically fast when |z| >> |a|: each step reduces the error by a
factor `|z|/(|a|+k)`. The cost is O(K_CF · M(prec)) where `K_CF ≈ prec /
log(|z|/|a|)`.

**Crossover condition (load-bearing):** the series is cheaper when `|z| ≤ K_CF`
and the CF is cheaper when |z| > K_CF. Equating:
```
|z| = prec / log(|z| / |a|)
```
For |a| ≈ |z| (the transition region) this becomes `|z| ≈ prec / log(1) = ∞` —
the CF never converges well near z ≈ a. This is why the Temme algorithm
(§2.4) is essential.

**Practical crossover thresholds (following FLINT / mpmath):**

```
Re(z) ≤ 0:        always use series (γ_series) then subtract from Γ(a)
Re(z) ≤ Re(a)+1:  series (k = 0..K with K determined by prec and z/a ratio)
Re(z) >> Re(a):   CF for Γ(a,z); K_CF ≈ prec / log(|z|/|a|) steps
|z − a| ≤ C·√|a|: Temme uniform asymptotic (§2.4)
|z| very large:   Poincaré asymptotic DLMF 8.11.2 (K terms at smallest-term stop)
```

**Closed-form series term count.** At the crossover `Re(z) ≈ Re(a)+1`, the
series needs K terms until the ratio `|z|/(|a|+K)` is below 1, i.e.,
`K ≈ |z| − |a|`. For K terms each at precision prec, total work is
O((|z|−|a|) · M(prec)). When `|z| − |a| > prec / log(|z|/|a|)` the CF wins.

**For Poincaré asymptotic (DLMF 8.11.2):** the k-th term is
`(−1)^k · (1−a)_k / z^k`. The Pochhammer `(1−a)_k` grows as `k!` for large k
— the series is Poincaré-asymptotic (diverges but truncated at optimal point).
Optimal truncation is at `k* ≈ |z| − Re(a)` (approximately where |z| = k+|a|).
Remainder bound at optimal truncation: `|R_{k*}| ≤ |term_{k*}|`. This is
below `2^{-prec}` when `k* ≈ |z| − Re(a) > prec`, i.e., `|z| > prec + Re(a)`.

**Closed-form Poincaré threshold:**
```
|z| > z_asymp(p, a) := p · ln(2) + Re(a)
```
At p = 196 bits (50 dps), Re(a) = 0: `z_asymp ≈ 136`. This is VERY large —
the large-z asymptotic is only valid at such extreme z values. The series + CF
combination covers the bulk of the practical domain.

**Summary crossover table:**

```
z condition                  Algorithm
─────────────────────────────────────────────────────────────────────────
Re(z) ≤ 0                    series for γ(a,z); Γ(a,z) = Γ(a) − γ(a,z)
Re(z) ≤ Re(a)+1              series for γ(a,z)
|z−a| ≤ C_temme·√|a|,        Temme uniform asymptotic (§2.4)
  |a| ≥ a_temme(prec)
Re(z) > Re(a)+1,             CF (Lentz): Γ(a,z) directly
  outside Temme region
|z| > p·ln(2) + Re(a)        Poincaré asymptotic; K = smallest-term stop
```

`C_temme ≈ 3` and `a_temme(prec) ≈ prec · 0.1` are the Temme region
parameters (see §2.4). The CF is the middle workhorse covering the largest
fraction of practical inputs.

### §2.4 Temme uniform asymptotic for a ≈ z

**When z ≈ a**, the series for γ(a,z) converges slowly (z/a ≈ 1 → each ratio
≈ 1), and the CF converges slowly (|z/a| ≈ 1 → log(|z|/|a|) ≈ 0). The Temme
(1979) uniform asymptotic expansion covers this transition region.

**Setup (DLMF 8.12.1–8.12.4):**
```
λ = z/a
η² = 2(λ − 1 − ln λ)     (η(λ) ~ λ−1 as λ → 1, branching: η > 0 iff λ > 1)
```

**Main formulas:**
```
P(a,z) = (1/2) erfc(−η √(a/2)) − S(a,η)
Q(a,z) = (1/2) erfc( η √(a/2)) + S(a,η)
```

where `erfc` is the complementary error function and `S(a,η)` is an
asymptotic series in `a^{-k}` with coefficients `c_k(η)` (DLMF 8.12.7–8.12.9).

**Why this works at arb-prec:** the `erfc` evaluation is handled by our
existing `bigErfc` (from the Erf substrate, ADR-0040). The `c_k(η)`
coefficients are rational functions of η (with removable singularities at η=0,
i.e., λ=1). Computing them requires Taylor expansion in η near η=0 and stable
evaluation elsewhere.

**Number of asymptotic terms.** The k-th Temme term is `c_k(η) · a^{-k}`.
For `|η| ≥ ε > 0` (away from the saddle η=0), these decay geometrically in
`a^{-1}`, so we need `K ≈ prec / log₂(|a|)` terms. For `|η| → 0` (z ≈ a),
the `c_k(0)` are the values at the saddle point (DLMF 8.12.15–8.12.17):
`c_0(0) = −1/3`, `c_1(0) = −1/540`, etc. — small constants, not diverging.

**Temme region:** `|z − a| ≤ C_temme · √|a|` where `C_temme ≈ 3` ensures
both the erfc argument `η√(a/2)` and the asymptotic tail are controlled. The
minimum `|a|` for the Temme expansion to be useful (i.e., K < |a| terms) is
roughly `|a| > prec · 0.1` — at prec=200 bits, `|a| > 20`.

**Implementation note:** the `c_k(η)` recursion requires computing derivatives
of η with respect to λ, which involves `1/(λ−1)` and stable forms near λ=1.
This is the non-trivial part of the Temme implementation; FLINT's
`gamma_upper.c` implements it. For v0.1 the Temme path can be omitted with
honest documentation that the CF converges slowly in the transition region.
**Filed as a v0.2 bead.**

### §2.5 Regularised forms P and Q: precision without cancellation

```
P(a,z) = γ(a,z) / Γ(a)     Q(a,z) = Γ(a,z) / Γ(a)     P + Q = 1
```

**The fundamental risk:** computing P via the series and Q via `1 − P` when
P ≈ 1 (i.e., z >> a) discards precision. Symmetrically, Q via CF and P via
`1 − Q` when Q ≈ 1 (z << a) discards precision. The safe pattern:

```
if z ≤ a:
    P = γ(a,z) / Γ(a)      [series numerator; non-trivial denominator but no cancellation]
    Q = 1 − P               [safe: P ≤ 1/2 by construction for z ≤ a at large a]
if z > a:
    Q = Γ(a,z) / Γ(a)      [CF numerator; non-trivial denominator but no cancellation]
    P = 1 − Q               [safe: Q ≤ 1/2 by construction for z > a at large a]
```

**Division by Γ(a):** `Γ(a)` can be computed via `exp(lgamma(a, work))` at
precision `work = prec + 32 + log₂(max(1, lgamma(a)))`. For large a,
`lgamma(a) ≈ (a−1/2)·log(a) − a`, so `log₂(lgamma(a)) ≈ log₂(a·log(a))` —
at most a few extra bits. The division `γ(a,z) / Γ(a)` is computed in log
space to avoid intermediate overflow: `P = exp(log_γ(a,z) − lgamma(a, work))`
where `log_γ(a,z) = a·log(z) − z + lgamma(a+1) − log(sum)` is recoverable
from the series without materialising γ(a,z) itself. This is the
"log-series" trick that mpmath employs.

Actually, for the series approach:
```
γ(a,z)/Γ(a) = z^a · e^{-z} · Σ_{k≥0} z^k / Γ(a+k+1) / (1/Γ(a))
             = z^a · e^{-z} / (a · B(a, z)) · ...
```
Simpler: compute the regularised series directly as:
```
P_series(a,z) = e^{-z} · z^a / Γ(a+1) · Σ_{k≥0} z^k · Γ(a+1) / Γ(a+k+1)
              = e^{-z} · z^a / Γ(a+1) · Σ_{k≥0} z^k / (a+1)(a+2)…(a+k)
```
where the series `Σ z^k / (a+1)…(a+k)` = `₁F₁(1; a+1; z)` is computed term
by term with ratio `z / (a+k)`. At `k=0`, term is 1. All terms positive for
z > 0. No cancellation. Divide by `Γ(a+1)` = `Γ(a) · a` at the end.

The `prec` bits of the final P are achieved with `work = prec + 32 +
log₂(Γ(a+1))` to absorb the division error. For a ≫ 1, `log₂(Γ(a+1)) ≈
a·log₂(a)` bits — significant but bounded by the precision of a.

### §2.6 Binary splitting for Γ(rational) at high precision

At prec > 5000 bits, the Stirling shift loop (N ≈ 0.17·prec iterations) and
Stirling series (K ≈ 0.20·prec terms) each cost O(prec^{1.6}) operations. The
total cost is O(prec^{2.6}).

Binary splitting for Γ(p/q) uses the product formula:
```
Γ(p/q) = (p/q − 1)! = limit of partial products via the recurrence
```
combined with Brent-McMillan's technique for computing Euler's constant γ at
O(M(prec) · log²(prec)) cost. At prec > 10,000 bits this is significantly
faster. **Defer to v0.2.** The Stirling approach is correct at all precision
levels and is used by mpmath and FLINT for prec ≤ ~5000 bits.

### §2.7 Newton/Halley iteration for InverseIncompleteGamma

The goal: given p (or q) and a, find z such that `P(a, z) = p` (or
`Q(a, z) = q`).

**Step 1: Float64 seed.** Use the float64 `betaincinv` / `gammaincinv`
approximation from SciPy/Boost (which uses an asymptotic seed + 1–2 Newton
steps internally) to get a starting value `z_0` accurate to ~8 decimal digits.

**Step 2: Newton iteration.**
```
z_{n+1} = z_n − (P(a, z_n) − p) / P'(a, z_n)
```
where `P'(a, z) = ∂P/∂z = e^{-z} z^{a-1} / Γ(a)` (the regularised Gamma PDF).
Newton doubles the number of correct digits per step.

**Step 3: Halley refinement.** Halley's method uses the second derivative
`P''(a, z) = e^{-z} z^{a-2} (a-1-z) / Γ(a)` to achieve cubic convergence:
```
z_{n+1} = z_n − (P − p) / P' / (1 − (P − p) P'' / (2 (P')²))
```

**Number of iterations:** from float64 seed (~50 bits), each Newton step
doubles precision. For prec = 200 bits, 3 Newton steps suffice (50 → 100 →
200 → 400). Halley reduces this to 2 steps.

**Precision per step:** each step evaluates `P(a, z_n)` at approximately the
current precision `p_n`. Work at step n: `p_n ≈ 2^n · 50` bits. Total work
is dominated by the final step at prec bits.

**Numerical risks:** near P=0 or P=1, the derivative P' = e^{-z} z^{a-1} /
Γ(a) is very small (P' → 0 as z → ∞ or z → 0), making the Newton step large
and potentially overshooting. Use the log-domain variant:
`log(z_{n+1}) = log(z_n) − P(a,z_n)/P'(a,z_n) / z_n`.

### §2.8 Barnes G-function: Adamchik + DLMF 5.17.5

The Barnes G-function satisfies `G(z+1) = Γ(z) · G(z)`, `G(1) = 1`. For
complex z with Re(z) > 0, the asymptotic expansion (DLMF 5.17.5):

```
log G(z+1) ≈ (1/4)z² + z·logΓ(z+1) − ((z(z+1)/2 + 1/12))·log(z) − log(A)
            + Σ_{k=1}^{K}  B_{2k+2} / (4k(k+1) z^{2k})
```

where `A` is Glaisher's constant (`ln A ≈ −ζ'(−1) − (1/12) ln(2π)`). This
is the Stirling-type asymptotic for log G; Adamchik (2001) derives the
coefficients via the Binet log-Gamma integral.

**Algorithm:**
1. Shift z upward via `G(z+1) = Γ(z) · G(z)` recurrences until Re(z) >
   z_shift_BarnesG.
2. Evaluate the asymptotic (DLMF 5.17.5) at the shifted argument.
3. Subtract `Σ_{k=0}^{N-1} logΓ(z+k)` to recover log G(z+1).

**Shift threshold:** the Bernoulli terms in DLMF 5.17.5 are `B_{2k+2} /
(4k(k+1) z^{2k})`. Same Stirling analysis: optimal truncation near
`k* ≈ π|z|/e`. Need z such that exp(-2π·z) < 2^{-prec}, i.e.,
`z_shift_BarnesG ≈ 0.17 · prec` — same as Gamma!

**Glaisher's constant A:** `ln A = 1/12 − ζ'(−1)` where `ζ'(−1)` is the
derivative of the Riemann zeta function at s=-1. At arb-prec, Glaisher's
constant must be computed to prec bits. This is done once (memoised) via the
asymptotic expansion of `ζ'(-1)` or via the known relation to the
Stieltjes constant `γ_1`. FLINT's `acb_hypgeom/barnes_g.c` handles this.
For v0.1: memoize `bigGlaisher(prec): BigFloat` as a standalone helper.

**v0.1 scope:** real argument z with Re(z) > 0. Complex z deferred to v0.2
(requires complex logΓ in the shift loop — which we already have in
`clgamma`, so technically straightforward but needs a separate file and tests).

### §2.9 Pochhammer: direct product vs Γ-ratio

For integer n:
```
(a)_n = Π_{k=0}^{n-1} (a+k)
```

For the Γ-ratio formula: `(a)_n = Γ(a+n) / Γ(a)` via
`exp(lgamma(a+n, work) − lgamma(a, work))`.

**Crossover:** at n=1, direct product is 1 multiplication; Γ-ratio is 2
lgamma evaluations (each O(prec^{1.6})) — direct product wins. At n=100 and
prec=200, direct product is 100 × O(prec^{1.6}) while Γ-ratio is 2 × O(prec^{1.6})
— Γ-ratio wins.

**Crossover formula:** if each multiply costs M and each lgamma costs L ≈
50·M, crossover at `n ≈ 2L/M ≈ 100`. In practice use:
```
if n ≤ 50: direct product
else: Γ-ratio via lgamma subtraction
```

**Sign handling for negative a:** if `a + k = 0` for some k ∈ [0, n), the
product is zero (pole of 1/Pochhammer). If `a + k < 0` for all k, the signs
alternate. The Γ-ratio handles this via the `lgammaRealAbs` + sign extraction.

---

## §3 — Critical risks

### §3.1 Cancellation in 1/Γ near zeros (clarification)

`1/Γ(z)` is entire with zeros at z = 0, −1, −2, … (the poles of Γ). Near
these zeros, `Γ(z) → ±∞` and `1/Γ(z) → 0`. There is **no cancellation**
in `1/Γ` — the function is small because Γ is large, and the computation
`exp(−lgamma(z))` or `1/gamma(z)` is well-conditioned in both cases (the
numerator is 1 and the denominator is large, giving a small result accurately).

The subtlety is detecting the exactly-integer case for the `= 0` output: use
the `zeta = z − round(Re(z))` technique with `isZero(zeta)` (as in `gamma`).
**No precision risk; structural correctness requirement only.**

### §3.2 Cancellation in Γ(z)Γ(1−z) reflection at near-integer z

The reflection formula `Γ(z)·Γ(1−z) = π/sin(πz)` (DLMF 5.5.3) is the
workhorse for extending Gamma to Re(z) < 1/2. Near a non-positive integer
`z = m + ζ` with |ζ| small:

```
sin(πz) = (−1)^m · sin(πζ) ≈ (−1)^m · πζ
```

The log of sin(πz) is `log|sin(πz)| ≈ log(π|ζ|)`, which is `−log|ζ|` bits
below the unrelated `logπ` scale. Computing `πz` naively at working precision
`prec + 32` and then taking sin discards `log₂(|m|/|ζ|)` bits of information
about ζ — this is the catastrophic cancellation documented in worklog 117 /
bead `oj5j`.

**Existing fix (correct):** the local `clgammaReflect` and `lgammaRealAbs`
already implement the reduction `ζ = z − m` before `π·ζ`, measured
`lossBits`, and bumped `work`. This is the DRY root of the
cancellation-retry pattern.

**Quantitative loss formula:**
```
lossBits = max(0, floor(log₂(|z|)) − floor(log₂(|ζ|)))
         = max(0, floor(log₂(|m|))) + O(1)     for |m| >> |ζ|
```

At `m = −1000` and `|ζ| = 2^{-50}`, lossBits ≈ 10 + 50 = 60 bits.
`work = prec + 32 + 60 = prec + 92`. This is a plausible input for a
regularised CDF computation near the boundary — the formula is not academic.

### §3.3 Cancellation in incomplete gamma series for extreme z/a ratios

For the series `γ(a,z) = e^{-z} Σ z^{a+k} / Γ(a+k+1)`:

- **z >> a:** the series is correct but slow (needs k > |z| terms before
  geometric decay). No cancellation in the series itself (all terms positive
  for z, a > 0 real). But `Γ(a,z) = Γ(a) − γ(a,z)` via subtraction discards
  precision when γ(a,z) ≈ Γ(a) (i.e., when the complement Q is tiny). **Use
  the CF for Γ(a,z) directly** in this regime — no cancellation in the CF
  because the CF value is close to 1 × Γ(a,z).

- **a >> z (or z very small):** `γ(a,z) ≈ z^a/a` (first term of series);
  `Γ(a,z) ≈ Γ(a)` (only a tiny fraction of Γ is "cut off"). Computing
  `Γ(a,z) = Γ(a) − γ(a,z)` — P is tiny, Q ≈ 1. Use P directly from the
  series without subtracting from Γ(a).

- **z negative real or complex with Re(z) < 0:** the series for γ(a,z)
  becomes alternating for some terms. For Re(a) > 0 the series still converges
  (DLMF 8.7.3 is valid for all z), but alternating signs introduce cancellation
  proportional to the magnitude of the oscillating terms. Use `work = prec +
  ceil(|z| · log₂(e))` extra bits to absorb the alternation.

### §3.4 Precision loss in Beta(a,b) when a+b is near a negative integer

```
log|B(a,b)| = lgamma(a) + lgamma(b) − lgamma(a+b)
```

If `a + b = m + ζ` with `m` a negative integer and `|ζ|` small:
- `lgamma(a+b)` is large (approaching +∞ as ζ → 0)
- The subtraction `lgamma(a) + lgamma(b) − lgamma(a+b)` involves a large
  subtracted term

**Loss formula:**
```
lgamma(a+b) ≈ −log|ζ| + bounded terms
```
So the subtracted quantity blows up logarithmically in |ζ|. The cancellation
depth is `log₂(1/|ζ|)` bits.

**Mitigation:** the `lgammaRealAbs` already handles this correctly (the
reflection's `lossBits` accounting includes the near-pole case). But the
*caller* (`Beta`) must not blindly add 3 lgamma evaluations at the same `work`
— it must bump `work` by an estimate of `log₂(1/|ζ|)` where ζ = a+b −
round(Re(a+b)). Alternatively, detect near-integer a+b and apply the
reflection before computing.

### §3.5 Pochhammer cancellation when (a+k) crosses zero

If `a` is a negative non-integer and `n > |a|`, then the direct product
`Π_{k=0}^{n-1} (a+k)` includes factors that cross through zero (change sign).
The product itself does not vanish (a is non-integer), but the intermediate
products can suffer severe cancellation:

```
(a)(a+1)…(a+⌊|a|⌋) · (a+⌊|a|⌋+1)…(a+n-1)
```

The first factor may be tiny (near-zero on both sides of `⌊|a|⌋`). This is
the Pochhammer-zero-crossing risk.

**Safe computation:** use the Γ-ratio for any a with `a + k` near 0 for some
k. The Γ-ratio `lgamma(a+n) − lgamma(a)` absorbs this via `lgammaRealAbs`'s
reflection handling. **Flag in implementation:** if direct product is selected
but `floor(a) + n > 0 > floor(a)` (i.e., the zero crossing is inside the
product range), switch to Γ-ratio automatically.

### §3.6 Polygamma m≥2 series cancellation at small z

The shifted series `Σ_{k=0}^{N-1} (z+k)^{-(m+1)}` in the polygamma recurrence
is all-positive for z, k > 0 and m ≥ 1 — no cancellation in the partial sum
itself. The subtraction from the asymptotic value is bounded.

However, for **complex z** with Im(z) ≠ 0, the terms `(z+k)^{-(m+1)}` are
complex and can cancel. The loss is proportional to `Im(z) / |z|^{m+2}` per
term. For small |z| and large Im(z) this can be significant. **Mitigation:**
use the reflection formula (§2.2, DLMF 5.15.6) to shift to Re(z) > 0 before
summing.

---

## §4 — v0.1 deferrals

These are honest scope exclusions for the Gamma-family epic's v0.1 reference
claim. Each carries a rationale.

| Head / Feature | Deferral rationale | Recommended v0.x |
|---|---|---|
| Temme uniform asymptotic for IncompleteGamma | Requires `c_k(η)` coefficient recursion and η-near-zero Taylor handling; significant additional substrate. CF + series cover all practical inputs for prec ≤ 500 bits. | v0.2 |
| BarnesG complex argument | Requires `clgamma` in the shift loop — mechanically straightforward given the existing complex substrate, but adds ~300 LOC and tests. No immediate consumer. | v0.2 |
| InverseIncompleteBeta at high precision (prec > 500) | Float64 seed + Newton is adequate for prec ≤ 200. At very high precision the Newton convergence requires evaluating `IncompleteBeta` per step which is expensive if not cached. Halley refinement helps but adds complexity. | v0.2 |
| Hyperfactorial for general (non-integer) z | BarnesG-based; deferred until BarnesG ships. For integer n, direct product is v0.1. | v0.2 |
| Binary splitting for Γ(rational) at prec > 10,000 bits | No immediate use case at that precision. Stirling is adequate. | v0.3 |
| Taylor-series alternative to Stirling for Gamma (low precision, small |z|) | Performance optimisation, not correctness gap. | v0.2 |
| Digamma/Trigamma reflection for Re(z) ≤ 0 | **Should be v0.1 for digamma** — the `cdigammaReflect` code already exists for the complex path; porting to real is ~30 LOC. Minor lift, high utility. | v0.1 lift |
| Polygamma m≥2 complex z via reflection | Real-axis restriction is acceptable for v0.1 since the Euler-Maclaurin route works for Re(z) > 0. | v0.2 |
| `IncompleteGammaUpper` and `IncompleteGammaLower` for complex a | Complex a requires the Temme expansion or numeric integration. Real a (including negative non-integer) with complex z is more tractable. | v0.2 |

**Honest scope for v0.1:** the v0.1 Gamma-family substrate ships exact arb-prec
evaluation of: Γ(z) real and complex; logΓ(z) real and complex; 1/Γ(z);
digamma ψ(z) real and complex (including negative arguments for both);
trigamma ψ'(z) real (positive arguments); polygamma ψ^(m)(z) for m ≥ 2 real
positive z; Pochhammer (a)_n real; IncompleteGammaUpper and Lower for real
a > 0 and all z; regularised P and Q; Beta(a,b); IncompleteBeta I_x(a,b) for
real a, b > 0, 0 < x < 1; InverseIncompleteGamma via Newton; BarnesG(z) for
real z > 0.

---

## §5 — Per-head TS signatures

These mirror ADR-0040 §"Decision 3" for the Erf family and the Bessel
family naming convention (`bigBesselJ`, etc.).

```ts
// ===========================
// EXISTING (already in special.ts and complex.ts) — AUDIT CONFIRMS CORRECT
// ===========================

// packages/bigfloat/src/special.ts
export function lgamma(z: BigFloat, prec: number): BigFloat;       // log|Γ(z)|; z > 0
export function gamma(z: BigFloat, prec: number): BigFloat;        // Γ(z); throws at pole
export function digamma(z: BigFloat, prec: number): BigFloat;      // ψ(z); z > 0 ONLY currently
export function trigamma(z: BigFloat, prec: number): BigFloat;     // ψ'(z); z > 0 ONLY currently
export function polygamma(m: number, z: BigFloat, prec: number): BigFloat;  // m=0,1 only

// packages/bigfloat/src/complex.ts
export function clgamma(z: BigComplex, prec: number): BigComplex;
export function cgamma(z: BigComplex, prec: number): BigComplex;
export function cdigamma(z: BigComplex, prec: number): BigComplex;

// ===========================
// LIFTS to existing functions (fill gaps identified in §0 audit)
// ===========================

// digamma for real z ≤ 0 (non-integer): add to special.ts via real reflection
// trigamma for real z ≤ 0 (non-integer): add to special.ts via real reflection
// polygamma m ≥ 2 for real z > 0: implement via Hurwitz zeta / Euler-Maclaurin

// ===========================
// NEW — packages/bigfloat/src/special-funcs/gamma.ts
// ===========================

// Reciprocal Gamma (entire function)
export function bigRecipGamma(z: BigFloat, prec: number): BigFloat;
// Real positive z: exp(-lgamma(z, prec+32)).
// Non-positive integer z: returns BigFloat(0, prec) exactly.
// Non-positive non-integer z: uses reflection.

// Pochhammer  (a)_n = Γ(a+n)/Γ(a)
export function bigPochhammer(a: BigFloat, n: number, prec: number): BigFloat;
// n small (≤ 50): direct product Π_{k=0}^{n-1}(a+k)
// n large or zero-crossing: Γ-ratio via lgamma subtraction

// Barnes G-function
export function bigBarnesG(z: BigFloat, prec: number): BigFloat;
// Stirling-shifted asymptotic (DLMF 5.17.5) with Glaisher's constant.
// v0.1: z > 0 real.

// Hyperfactorial K(n) = Π_{k=1}^{n} k^k  (integer n only, v0.1)
export function bigHyperfactorial(n: number, prec: number): BigFloat;

// ===========================
// NEW — packages/bigfloat/src/special-funcs/incomplete-gamma.ts
// ===========================

// Upper incomplete gamma Γ(a, z) = ∫_z^∞ t^(a-1) e^{-t} dt
export function bigIncompleteGammaUpper(a: BigFloat, z: BigFloat, prec: number): BigFloat;
// Dispatch: series / CF / Poincaré asymptotic per §1.7 / §2.3.

// Lower incomplete gamma γ(a, z) = ∫_0^z t^(a-1) e^{-t} dt
export function bigIncompleteGammaLower(a: BigFloat, z: BigFloat, prec: number): BigFloat;
// Series (DLMF 8.7.1) for all z; derived from upper for large |z|.

// Regularised upper Q(a,z) = Γ(a,z)/Γ(a)
export function bigIncompleteGammaQ(a: BigFloat, z: BigFloat, prec: number): BigFloat;
// Precision-safe: always compute the smaller of P and Q directly.

// Regularised lower P(a,z) = γ(a,z)/Γ(a)
export function bigIncompleteGammaP(a: BigFloat, z: BigFloat, prec: number): BigFloat;

// Inverse regularised gamma: find z such that P(a,z) = p
export function bigInverseIncompleteGammaP(a: BigFloat, p: BigFloat, prec: number): BigFloat;
// Float64 seed + Newton iteration (see §2.7).

// ===========================
// NEW — packages/bigfloat/src/special-funcs/beta.ts
// ===========================

// Beta function B(a,b) = Γ(a)Γ(b)/Γ(a+b)
export function bigBeta(a: BigFloat, b: BigFloat, prec: number): BigFloat;
// Via exp(lgamma(a, work) + lgamma(b, work) - lgamma(a+b, work)).
// Sign handling for negative non-integer a, b.

// Incomplete beta B_x(a,b) = ∫_0^x t^(a-1)(1-t)^(b-1) dt
export function bigIncompleteBeta(x: BigFloat, a: BigFloat, b: BigFloat, prec: number): BigFloat;

// Regularised incomplete beta I_x(a,b) = B_x(a,b) / B(a,b)
export function bigRegularisedIncompleteBeta(x: BigFloat, a: BigFloat, b: BigFloat, prec: number): BigFloat;
// CF (DLMF 8.17.22) for x < (a+1)/(a+b+2); symmetry otherwise.

// Inverse regularised incomplete beta: find x such that I_x(a,b) = p
export function bigInverseRegularisedIncompleteBeta(p: BigFloat, a: BigFloat, b: BigFloat, prec: number): BigFloat;
// Float64 seed + Newton iteration.

// ===========================
// NEW complex extensions — packages/bigfloat/src/complex.ts
// ===========================

// Complex reciprocal Gamma
export function cRecipGamma(z: BigComplex, prec: number): BigComplex;
// cexp(cneg(clgamma(z, prec+32))); zero at non-positive integer real z.

// Complex polygamma for m ≥ 2 (v0.1: Re(z) > 0 restriction)
export function cpolygamma(m: number, z: BigComplex, prec: number): BigComplex;
// Hurwitz zeta route; shift + Euler-Maclaurin asymptotic.
```

**Naming convention:** new functions for genuinely new heads follow the
`big<HeadName>` convention (`bigIncompleteGammaUpper`, `bigBeta`, etc.).
Existing real-axis functions (`lgamma`, `gamma`, `digamma`, etc.) retain their
names — they are already exported and in use. New complex extensions join the
`complex.ts` module as `c<name>` (consistent with `cgamma`, `clgamma`, etc.).

---

## §6 — Determinism analysis

Every operation in the Gamma-family substrate uses:

- **BigFloat arithmetic** (`add`, `sub`, `mul`, `div`, `sqrt`) — pure BigInt
  mantissa arithmetic, bit-identical across all JS runtimes by language spec.
- **`exp`, `log`, `sin`, `pi`, `ln2`** from `transcendental.ts` — already
  established as BigFloat operations, bit-identical at fixed prec.
- **`bernoulliRational`** — returns exact rational `{num: bigint, den: bigint}`.
  The conversion to BigFloat at precision `prec` is a bigint division with
  fixed rounding — bit-identical. ✓
- **`toFloat64`** — used only for the `shiftThreshold` heuristic (to compute
  `N = ceil(threshold − z_float)`). This uses the `Number(z.mantissa)` path
  which is platform-independent for the magnitudes involved (N ≤ prec, which
  fits in float64 exactly). ✓

**New functions and their operations:**

| Function | BigInt only? | Any float64 branching? | Determinism |
|---|---|---|---|
| `bigRecipGamma` | Yes (via lgamma + exp) | Only for heuristic N | `arbprec: true` ✓ |
| `bigPochhammer` (direct) | Yes (BigFloat multiplies) | Only for crossover n=50 | `arbprec: true` ✓ |
| `bigPochhammer` (Γ-ratio) | Yes (via lgamma) | Only for heuristic | `arbprec: true` ✓ |
| `bigIncompleteGammaUpper` | Yes (BigFloat arithmetic) | Only for regime selection | `arbprec: true` ✓ |
| `bigIncompleteGammaQ` / `bigIncompleteGammaP` | Yes | Only for z ≤ a/z > a branch | `arbprec: true` ✓ |
| `bigInverseIncompleteGammaP` | No — float64 seed | Float64 seed from betaincinv | See note |
| `bigBeta` | Yes | None | `arbprec: true` ✓ |
| `bigRegularisedIncompleteBeta` | Yes (Lentz CF, BigFloat) | Only for CF branch | `arbprec: true` ✓ |
| `bigBarnesG` | Yes (Stirling + clgamma) | Only for heuristic | `arbprec: true` ✓ |

**Note on `bigInverseIncompleteGammaP`:** the float64 seed uses `Number`
arithmetic (platform-independent for the magnitudes involved — the inverse
incomplete gamma seed is always a moderate float in [0, ∞)). The Newton
iteration that follows is pure BigFloat. **The float64 seed is used ONLY
to determine the starting point of iteration; the final value is computed
purely via BigFloat to the requested prec bits.** The seed determines how
many Newton steps are needed but NOT the final value — so the output is
bit-identical given (a, p, prec), satisfying the `arbprec: true` contract.
To make this explicit, document it in the source: "the float64 seed is not
part of the output; it is an initial approximation whose effect on the output
is zero after N_iter Newton steps."

**BigFloat exponent range:** all intermediate exponents are standard JS
`number` (safe integer range ±2^53). At prec = 200 bits and z_shift ≈ 50,
`exp(lgamma)` has exponent at most `lgamma(50) ≈ 145` bits — well within
the `±2^53` range. Only at astronomically large z (z > 2^(2^50)) would
exponent overflow occur — beyond any practical precision.

**Algorithm-branch floating-point:** the only float64 used in branching is:
1. `toFloat64(z).value` for the `N = ceil(threshold − z_float)` heuristic —
   this N is an integer and at the precision levels where `z_float` equals
   the true z to all significant digits, it is correctly determined.
2. `Math.round(reFloat)` for the reflection integer `m` — again, for
   representable `prec`-bit arguments `z`, the float64 representation of z
   rounds correctly to the nearest integer for all z that fit in float64.
   For z too large for float64 (|z| > 2^53), the `N = 0` case applies
   (already in Stirling range) and no reflection is needed.

Both branching float64 operations are **deterministic across platforms** for
the argument sizes encountered in practice. The `arbprec: true` contract
(ADR-0020) is fully satisfied.

---

## Appendix A — Bernoulli number scaling for Stirling

The k-th Stirling coefficient for log Γ is `B_{2k} / (2k(2k-1))`. The
absolute magnitude of `B_{2k}` grows superexponentially:

```
|B_{2k}| ≈ 2 · (2k)! / (2π)^{2k}    (standard asymptotic)
```

The ratio of consecutive terms in the Stirling series at z:

```
term_{k+1} / term_k = B_{2k+2} / ((2k+2)(2k+1)) · z^{2k-1}
                     / (B_{2k} / (2k(2k-1)) · z^{2k+1})
                   = (B_{2k+2} · 2k(2k-1)) / (B_{2k} · (2k+2)(2k+1) · z²)
                   ≈ (2k)² / ((2π z)²)     for large k
```

So the terms start shrinking when `k < (πz)²` and start growing when `k >
(πz)²`. Optimal truncation is at `k* ≈ π·Re(z)` — the Stirling series needs
roughly `π·z_shift` terms, not the somewhat conservative bound in the current
code's `k ≤ 300` cap (which is fine for prec ≤ 1000 but could be tightened
for very large shifts).

---

## Appendix B — Hurwitz zeta Euler-Maclaurin formula

The Euler-Maclaurin sum for ζ(s, z) at large z is the Stirling-analogue for
the Hurwitz zeta function:

```
ζ(s, z) = z^{1-s}/(s-1) + (1/2)z^{-s}
         + Σ_{k=1}^{K}  B_{2k} · (s)_{2k-1} / ((2k)! · z^{s+2k-1})  + R_K
```

where `(s)_{2k-1}` is the Pochhammer symbol `s(s+1)…(s+2k-2)`. The remainder
`R_K` satisfies `|R_K| ≤ |term_K|` when the terms are decreasing — the same
optimal-truncation property as the Stirling series. The `(s)_{2k-1}` factor
grows factorially, giving the same Poincaré-asymptotic character as the
Bernoulli series. Optimal truncation at the smallest term:

```
k* ≈ π · Re(z) / e     (same as the lgamma Stirling case)
```

For `polygamma(m, z)`, s = m+1 and the Pochhammer factor `(m+1)_{2k-1} =
(m+1)(m+2)…(m+2k-1)` grows rapidly — the series diverges faster at fixed z
than the lgamma Stirling series. The optimal truncation index decreases with
m: for large m, the series is "more asymptotic" and requires larger z to be
useful. This motivates the same shift threshold `z_shift ≈ 0.17 · (prec + m)`
— the shift must absorb both precision bits and the additional factorial growth
from the polygamma order.

**Working precision formula for polygamma m≥2:**
```
shiftThreshold = max(8, ceil(0.17 * (prec + 2*m + 96)))
work = prec + 96 + 2 * ceil(log2(m + 1))  // extra for factorial(m)
```

---

## Appendix C — CF convergence for IncompleteBeta

The Lentz continued fraction (DLMF 8.17.22):

```
I_x(a,b) = x^a (1-x)^b / (a B(a,b)) · 1/(1 + d_1/(1 + d_2/(1 + ...)))
```

converges geometrically with ratio `|d_n / d_{n-1}| ≈ x` per step (for x
not close to 1). The number of CF steps K needed for prec-bit accuracy is:

```
K ≈ prec / log₂(1/x)    for x < 1/2
```

For x near 1, use the symmetry `I_x(a,b) = 1 - I_{1-x}(b,a)` which maps x
to `1-x < 1/2` — guaranteed to converge in at most `prec / log₂(1/(1-x)) =
prec / log₂(1/(1-x))` steps. The DLMF prescribes using the CF for
`x < (a+1)/(a+b+2)` and symmetry otherwise; the condition ensures the CF
converges in `K ≤ prec / log₂((a+b+2)/(a+1))` steps.

---

## Appendix D — Series term count for lower incomplete gamma

The lower incomplete gamma series (DLMF 8.7.1):
```
γ(a, z) = z^a e^{-z} Σ_{k≥0} z^k / Γ(a+k+1)
```

Term ratio: `t_{k+1}/t_k = z/(a+k+1)`. Geometric decay starts at k > |z| -
Re(a) - 1. Approximate number of terms for convergence to 2^{-prec}:

```
K ≈ |z| + prec / log₂((|z|/|a|) + 1)    for |z| ≥ |a|
K ≈ prec / log₂(|a|/|z|)                  for |a| >> |z|
```

In the second case (a >> z), very few terms are needed — the first term
`z^a / Γ(a+1)` dominates and subsequent terms fall off rapidly.

---

## §7 — Frictions and open questions surfaced during research

1. **`digamma` real negative argument is an open gap in a shipped function.**
   `cdigammaReflect` already implements the complex version. The 30-LOC port
   to the real axis is a trivial lift; it is the one v0.1 gap in an existing
   production function.

2. **Temme uniform asymptotic is essential for a complete arb-prec incomplete
   gamma implementation but is non-trivial to implement.** The η recursion has
   removable singularities at η=0 that require careful Taylor expansion. FLINT
   implements this; the local substrate should port FLINT's
   `gamma_upper_temme.c` (file not accessible via web fetch; available in the
   FLINT repo at `src/arb_hypgeom/gamma_upper_temme.c`). Filed as v0.2 bead.

3. **Glaisher's constant for BarnesG** must be computed to `prec` bits. The
   relation `log(A) = 1/12 - ζ'(-1)` requires `ζ'(-1)` at arb-prec. The
   derivative of Riemann zeta at s=-1 is not in the current substrate. This
   is a standalone prerequisite for BarnesG; file as a v0.1 setup bead.

4. **The `polygamma` dispatch in `special.ts:465–474` throws for m≥2.** The
   comment "filed for v0.2 via Hurwitz zeta" suggests the Hurwitz zeta route
   was already the design intent; this R2 document confirms the algorithm
   design is straightforward (§2.2).

5. **The `digamma` code at `special.ts:327–341` has dead code** (the
   `tanPiZ` and `cosPiZ` bindings are computed but never used before the
   `throw`). This dead code is a lint hazard and should be deleted when the
   reflection is implemented properly.

6. **mpmath's `mpmath/functions/gamma.py` was not fetchable** (HTTP 404 via
   GitHub raw URL). The algorithm descriptions have been reconstructed from
   known mpmath behaviour and the DLMF citations. Future R2 agents should
   try `raw.githubusercontent.com/mpmath/mpmath/main/mpmath/libmp/libelefun.py`
   or clone the repo locally.

7. **FLINT `gamma_upper.c`, `gamma_lower.c`, `rgamma.c`, `polygamma.c`** —
   direct raw file URLs returned 404 (files may have moved in the FLINT 3.0+
   restructuring that merged Arb). The algorithms were reconstructed from
   DLMF citations, Temme's paper, and the successfully-fetched `gamma.c` and
   `lgamma.c` logic. Future agents should use `gh api` or local clone at
   `src/arb_hypgeom/` and `src/acb_hypgeom/`.

---

## §8 — References

- **DLMF §5** (Gamma Function): https://dlmf.nist.gov/5 — §5.5 (reflection,
  DLMF 5.5.3; recurrence 5.5.1; duplication 5.5.5), §5.10 (continued
  fraction), §5.11 (Stirling, 5.11.1–5.11.8), §5.15 (polygamma, 5.15.2–5.15.9),
  §5.17 (Barnes G, 5.17.1–5.17.7).
- **DLMF §8** (Incomplete Gamma): https://dlmf.nist.gov/8 — §8.2 (defs,
  8.2.1–8.2.6), §8.7 (series 8.7.1–8.7.3), §8.9 (CF 8.9.1–8.9.2),
  §8.11 (Poincaré asymptotic 8.11.2–8.11.3), §8.12 (Temme 8.12.1–8.12.17),
  §8.17 (incomplete beta 8.17.1–8.17.23).
- **FLINT/Arb `arb_hypgeom/gamma.c`** (main branch, 2026-05-18):
  three-tier dispatch (exact / Taylor / Stirling); BETA 0.17–0.24 precision
  adaptation; `choose_small` / `choose_large` parameter selection.
- **FLINT/Arb `acb_hypgeom/lgamma.c`** (main branch, 2026-05-18):
  complex lgamma dispatch; Stirling parameter selection; reflection formula.
- **Boost.Math `boost/math/special_functions/lanczos.hpp`** (develop branch):
  `lanczos13m53` (53 dp), `lanczos17m64` (64 dp), `lanczos24m113` (113 dp) —
  confirms Lanczos is fixed-precision; arb-prec requires Stirling.
- **Temme, N.M. (1979).** "The asymptotic expansion of the incomplete gamma
  functions." SIAM J. Math. Anal. 10(4), 757–766. — Temme uniform asymptotic;
  saddle-point analysis; DLMF 8.12 primary source.
- **DiDonato, A.R. and Morris, A.H. (1986).** "Computation of the Incomplete
  Gamma Function Ratios and their Inverse." ACM TOMS 12(4), 377–393. —
  series/CF crossover algorithm used in SciPy / Cephes.
- **Gautschi, W. (1979).** "Algorithm 542: Incomplete Gamma Functions."
  ACM TOMS 5(4), 482–489. — original reference for the CF algorithm for
  Γ(a,z).
- **Adamchik, V.S. (2001).** "On the Barnes function." Proc. ISSAC 2001,
  15–20. — asymptotic expansion for log G used in `acb_hypgeom/barnes_g.c`.
- **Spouge, J.L. (1994).** "Computation of the Gamma Function using Spouge's
  Formula." SIAM J. Numer. Anal. 31(3), 931–944. — explicit error bounds for
  the Lanczos-variant approximation.
- **Pugh, G.R. (2004).** "An Analysis of the Lanczos Gamma Approximation."
  PhD thesis, Univ. of British Columbia. — coefficient generation methodology
  for Lanczos; confirms arb-prec infeasibility.
- **Brent, R.P. (1976).** "Fast multiple-precision evaluation of elementary
  functions." JACM 23(2), 242–251. — binary splitting for Γ(rational) at
  very high precision.
- **Local substrate:** `packages/bigfloat/src/special.ts` (474 LOC);
  `packages/bigfloat/src/complex.ts` (lines 380–806); `packages/bigfloat/
  src/special-funcs/erf.ts` (976 LOC — exemplar algorithm narrative).
- **Worklog 117, bead `oj5j`:** near-pole cancellation fix for `clgammaReflect`.
- **ADR-0020:** `arbprec: true` determinism contract.
- **ADR-0040 §Decision 3:** per-head signature convention and
  cancellation-retry pattern.

---

*End of R2 artefact — scientist-workbench-vf19.*
