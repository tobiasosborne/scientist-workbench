# `bench/gamma-anchor/` corpus specification

**Bead:** `scientist-workbench-0kq3` (G1 — Phase 1 of the Gamma family epic)
**ADR:** `docs/adr/0042-gamma-family-per-head-substrate.md`
**Author of input manifest:** `bench/gamma-anchor/generate-corpus.ts`
**Seed:** `20260519` (Park-Miller LCG, `a=48271`, `m=2^31−1`)
**Filing date convention:** YYYYMMDD; one day after Bessel (20260517) and three after Erf (20260516).
**Total inputs:** 377 — within the bead's 250-400 target band, weighted to the upper end because Gamma family is broader than Erf (19 ADMITTED_HEADS vs 6 erf heads).

This document is the human-readable companion to `corpus.json` (the wire artefact). The corpus is the source of truth for the entire Phase 1 golden-master pipeline: oracle adapters (G2 Wolfram, G3 mpmath, G4 SciPy, G5 Boost, G6 libm, G7 Arb) consume `corpus.json`, evaluate each head against the canonical input, and the G8 cross-agreement comparator grades the oracles against each other on this shared set.

If you want to know *what is in the corpus*, read `corpus.json`'s `totals` block. If you want to know *why each tier was designed the way it was*, this document explains it.

---

## Why this corpus exists

The Gamma family carries unusually many landmines per evaluation: P/Q convention inversions, four distinct oracle behaviors at the poles, SciPy's `loggamma(real_negative) → NaN`, SciPy's `polygamma(complex) → TypeError`, the Temme uniform-asymptotic transition region where v0.1 has a documented carve-out. Each landmine forces a structural decision in either the substrate or the adapter; the corpus must include explicit cells that exercise each decision so the carve-outs and conventions are *measured* rather than *assumed*.

The Erf corpus was the prototype (271 inputs, 8 tiers). The Bessel corpus (~1700 inputs, 10 tiers) is the broader precedent for multi-argument heads. The Gamma corpus inherits Bessel's discriminated-`*_kind` argument encoding (R5 §6 L1 mitigation) and Erf's `formatDecimal` discipline verbatim; what changes is *which functions* and *which regimes* the tiers cover.

---

## Reproducibility check

The generator is a pure-TS Park-Miller LCG; re-running produces a byte-identical `corpus.json`.

```sh
bun bench/gamma-anchor/generate-corpus.ts && sha256sum bench/gamma-anchor/corpus.json
```

Expected hash (re-record after any change to the generator):

```
1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5  bench/gamma-anchor/corpus.json
```

This invariant is load-bearing for the downstream pipeline: oracles are content-addressed by input hash, and a flaky corpus would break every cached oracle response.

---

## Wire-format conventions

### Number formatting (R5 §6 L1 — Wolfram input-trap)

Every numeric input — real `z`, complex `re`/`im`, decimal-class arg — emits as a 60-digit fixed-format decimal string. JS Number has ~15.95 decimal digits of precision; trailing digits past ~15 are filler zeros. This is intentional: it canonicalises what "exact input" means at the oracle level. `N[Gamma[1.5], 50]` returns 17 digits because `1.5` parses as a machine double; `N[Gamma[Rational[3,2]], 50]` returns 50 digits. The adapter converts decimal-class arguments to rationals before passing to Wolfram.

### Discriminated argument encoding (carry from Bessel's `nu_kind`)

Scalar arguments (`a`, `b`, `m`, `n` — *not* the primary `z` variable) carry a `kind` discriminator:

```jsonc
{ "kind": "integer",       "value": "3"   }   // → Integer[3]
{ "kind": "half-integer",  "value": "3/2" }   // → Rational[3, 2]
{ "kind": "decimal",       "value": "1.7000…" } // → Rational from 60-dp string
```

The primary `z` (and complex `re`/`im`) stays in the simpler 60-digit decimal-string form because `z` is the head's analytic variable; oracles all accept decimal-string `z` without the rational-cast trap.

The arity table per head:

| Head | Arity | Fields |
|---|---|---|
| `Gamma`, `LogGamma`, `Digamma`, `Trigamma`, `BarnesG` | 1 | `z` |
| `Polygamma` | 2 | `m`, `z` |
| `Pochhammer` | 2 | `a`, `n` (and a redundant `z` mirror of `a` for wire-schema uniformity) |
| `IncompleteGamma{Upper, Lower, P, Q}` | 2 | `a`, `z` |
| `InverseIncompleteGamma{P, Q}` | 2 | `a`, `z` (where `z` semantically is `q` ∈ (0, 1)) |
| `Beta`, `LogBeta`, `GammaRatio`, `GammaDeltaRatio` | 2 | `a`, `b` (no `z`) |
| `GammaPDerivative` | 2 | `a`, `z` |
| `IncompleteBeta` | 3 | `z`, `a`, `b` |

---

## Head admission — ADR-0042 §Decision 4 ADMITTED_HEADS

The float64 dispatcher's ADMITTED_HEADS list is the corpus's head set. ADR-0042 enumerates 19 entries; all 19 appear in the corpus. The list is broader than the cas-core vocabulary admission list (6 new heads — `LogGamma`, `Pochhammer`, `IncompleteGammaUpper`, `IncompleteGammaLower`, `Beta`, `BarnesG`) because numerical evaluation can serve heads that exist purely as evaluation shortcuts. The Erfi precedent applies: Erf's float64 dispatcher admits `Erfcx` as a numerically-stable variant without `Erfcx` being a cas-core head; Gamma's dispatcher admits P/Q analogously.

`IncompleteGammaP` and `IncompleteGammaQ` are kept as separate heads from `IncompleteGammaUpper` and `IncompleteGammaLower` for the L12 reason discussed below — even though P = Lower/Γ and Q = Upper/Γ symbolically, the numerical paths are distinct (Cephes `igam.c` implements P and Q directly via series/CF, not as ratios).

---

## L12 — Incomplete-gamma regularisation convention (THE critical gamma landmine)

This is the #1 trap in the gamma family. SciPy's `gammainc` returns `P` (lower regularised); Wolfram's `Gamma[a, z]` returns the *upper unregularised* (`Γ(a, z)`); mpmath follows Wolfram. The same function name (`gammainc`) means *different things* in different oracles.

The corpus's discipline: **emit each of Upper, Lower, P, Q as a SEPARATE input record.** Never share. The adapter, for each head, tags the call with `// L12` and consults R5 §6 L12's convention table:

```
WOLFRAM:
  Gamma[a, z]              = Γ(a, z) upper UNregularised   → Upper
  Gamma[a, 0, z]           = γ(a, z) lower UNregularised   → Lower
  GammaRegularized[a, z]   = Q(a, z) = Γ(a,z)/Γ(a)         → Q
  GammaRegularized[a, 0, z]= P(a, z) = γ(a,z)/Γ(a)         → P

MPMATH:
  gammainc(a, z)                       = Γ(a, z)           → Upper
  gammainc(a, 0, z)                    = γ(a, z)           → Lower
  gammainc(a, z, regularized=True)     = Q(a, z)           → Q
  gammainc(a, 0, z, regularized=True)  = P(a, z)           → P

SCIPY:
  gammainc(a, z)     = P(a, z)  LOWER REGULARISED          → P   ← OPPOSITE name
  gammaincc(a, z)    = Q(a, z)                             → Q
  gammaincinv(a, p)  inverse of P                          → InverseIncompleteGammaP
  gammainccinv(a, q) inverse of Q                          → InverseIncompleteGammaQ

BOOST:
  tgamma(a, z)       = Γ(a, z) upper UNregularised         → Upper
  tgamma_lower(a, z) = γ(a, z) lower UNregularised         → Lower
  gamma_p(a, z)      = P(a, z)                             → P
  gamma_q(a, z)      = Q(a, z)                             → Q
```

By making the heads distinct at the corpus level, the comparator can also cross-check identities:

- `IncompleteGammaP(a, z) + IncompleteGammaQ(a, z) = 1`
- `IncompleteGammaLower(a, z) + IncompleteGammaUpper(a, z) = Γ(a)`

These identities turn the corpus into a sanity-check matrix for the adapter conventions independent of the closed-form values.

---

## Tier-by-tier rationale

### T1 — real positive z+a (92 inputs)

The bread-and-butter tier. Every one of the 19 ADMITTED_HEADS gets exercised on the positive-real regime `z ∈ (0, 20], a ∈ (0, 20]`. This is where:

- **Gamma / LogGamma**: Stirling kicks in beyond `shiftThreshold = max(8, ceil(0.17·prec))` (R2 §1.1, FLINT's `choose_small`). z near 1-3 exercises the recurrence path; z near 10-20 exercises the asymptotic Stirling path directly. Canonical anchors at z=1 (Γ(1)=1, ψ(1)=−γ) and z=2 (Γ(2)=1, ψ(2)=1−γ) appear so the comparator has known-exact cross-checks.
- **Digamma / Trigamma**: same dispatch as Gamma; reflection inactive for positive z.
- **IncompleteGamma{Upper, Lower, P, Q}**: Cephes `igam.c` (R3 §3.3) chooses series-for-Lower vs CF-for-Upper at `z ≈ a + 1`. The 5-point `(a, z)` grid puts cells on both sides of that boundary so both branches are exercised.
- **Beta / LogBeta**: lgamma-subtraction with sign tracking trivial in this regime. The pair `B(1/2, 1/2) = π` is the canonical anchor.
- **Pochhammer**: direct product (small `n`) vs lgamma-ratio (large `n`) crossover at `n ≈ 20` (R2 §1.4). The corpus samples `n ∈ {1, 10, 25}` to bracket the crossover.
- **GammaRatio / GammaDeltaRatio**: ratio-stable variants per R3 §5; avoid the catastrophic-cancellation cliff that direct `Γ(a)/Γ(b)` hits when `a, b > 170`.
- **GammaPDerivative**: ∂P/∂x = exp(−x)·x^(a−1)/Γ(a); covered at `(a, z)` cells where the closed-form is bounded.
- **IncompleteBeta**: `I_z(a, b)` on `z ∈ (0, 1)`.

### T2 — real negative z (43 inputs)

Negative real `z` is where the substrate's analytic-continuation paths live:

- **Gamma**: poles at `z = 0, -1, -2, ...`; finite between poles with alternating sign.
- **LogGamma**: analytic continuation has `Im` ≠ 0 for `x < 0` non-integer. SciPy's `loggamma(real_negative) → NaN` (R5 §6 L15) so the adapter passes `x + 0j`. The v0.1 substrate (`lgammaRealAbs` + sign tracking) returns `log|Γ(x)| + iπk` where `k` counts poles crossed; the corpus exercises that the `+iπk` term matches Wolfram's branch choice.
- **Digamma**: lift unblocked by ADR-0042 §Decision 3 (the `cdigammaReflect` pattern in real arithmetic). Before the lift, `special.ts:340` threw on negative z.
- **Trigamma / Polygamma**: reflection via `z ↦ 1 − z`.

Cells sit strictly *between* integer poles; the near-pole cancellation cliff is T3's job. The grid `z ∈ {-0.3, -0.7, -1.3, -2.7, -3.5, -5.7, -8.3}` covers seven inter-pole intervals.

### T3 — near-poles (54 inputs)

The reflection formula `Γ(z)·Γ(1−z) = π/sin(πz)` has a `sin(πz)` factor that has zeros at every integer. When `z` is near an integer, `sin(πz) ≈ π·(z − n)` loses precision unless evaluated with the reduced argument `ζ = z − n`. Trigamma/polygamma reflection are even more delicate because `ψ(1−z) − ψ(z) = π·cot(πz)` has higher-order singularities.

Per ADR-0042 §Decision 3:
```
lossBits = max(0, log₂|z| − log₂|ζ|)
work_prec = prec + 32 + lossBits
```

The grid: `z = -n + δ` for `n ∈ {0, -1, -2, -3}` and `δ ∈ {0, ±1e-2, ±1e-4}`. At `δ = 1e-4`, `lossBits ≈ 13`; at `δ = 1e-6` (in T8), `lossBits ≈ 20`. The substrate must grow work-precision accordingly; the corpus is what proves this is happening at the 50-dp gold tier.

The `δ = 0` row exists for L17 — the comparator must special-case the exact-pole cells because each oracle returns a different shape (Wolfram `ComplexInfinity`, mpmath `ValueError`, SciPy `+∞`, libm `NaN`).

### T4 — complex Q1-Q4 (40 inputs)

Per ADR-0042 §Decision 4, the complex paths through the substrate are:

- **Gamma / LogGamma / Digamma** — `cgamma`, `clgamma`, `cdigamma` ALREADY SHIP
- **Trigamma / Polygamma** — NEW (`cpolygamma` via Hurwitz zeta)
- **IncompleteGamma{Upper, Lower}** — NEW (`cIncompleteGamma*`)
- **Beta** — NEW (`cBeta` via lgamma)
- **BarnesG** — gold-only (Wolfram + mpmath; no Boost/SciPy complex)

Magnitudes span `(0.5, 12)` so the Maclaurin/asymptotic crossover regions (different per head) are exercised. Each quadrant is independently sampled to drive the four-quadrant sign-tracking branches in the reflection/continuation paths.

R5 §6 L14 applies: SciPy 1.11.4's `polygamma(m, complex)` raises `TypeError: ufunc '_zeta' not supported for the input types`. The SciPy adapter refuses with `tagged "oracle-scipy/polygamma-complex-unsupported"`; the comparator uses Wolfram + mpmath only on T4 polygamma cells.

### T5 — half-integer a (40 inputs)

The R1 priority-A/B closed-form rules live here:

- `Γ(1/2) = √π`                           (DLMF §5.4.1)
- `Γ(3/2) = √π/2`
- `Γ(5/2) = 3√π/4`
- `Γ(-1/2) = -2√π`                        (DLMF §5.4.6)
- `Digamma(1/2) = -γ - 2·log(2)`          (DLMF §5.4.13)
- `(1/2)_n = (2n)! / (4ⁿ · n!)`           Pochhammer half-integer
- `B(1/2, 1/2) = π`                       (DLMF §5.12.1 + Γ(1/2)²/Γ(1))
- `B(1/2, n+1/2) = π / 2^(2n+1) · C(2n, n)`
- `Γ(1/2, z) = √π · erfc(√z)`             IncompleteGammaUpper half-int closed form
- `Γ(-1/2, z) = 2·e⁻ᶻ/√z - 2√π·erfc(√z)`

These cells are golden tests of the closed-form simplifier (Phase 2 I4 rules in `gamma-identities.ts`). The G8 comparator must verify oracle values land on these exact-form numerics at full precision; the simplifier must reproduce the closed forms symbolically.

### T6 — large |z| ∈ (100, 1000] (28 inputs)

The asymptotic regime:

- **Gamma / LogGamma**: Stirling series converges in O(1) terms; the algorithm is essentially "evaluate at this `z` directly." Float64 `tgamma` overflows past `~171.6` (R3 §3.1), so unary-Gamma cells stop at `z = 170`; LogGamma has no such constraint and goes to `z = 1000`.
- **Digamma / Trigamma**: Boost's `digamma.hpp` switches to the DLMF §5.11.2 asymptotic series.
- **IncompleteGammaUpper / Q**: DLMF §8.11.2 Poincaré asymptotic (R2 §1.7). For `z >> a`, `Γ(a, z) ≈ z^(a-1)·e^(-z)·[1 + (a-1)/z + ...]` and `Q(a, z) → 0`.
- **BarnesG**: at `z = 20, 50` exercises the Adamchik asymptotic; we stop at 50 because the value at z=50 already involves ~10⁹⁰⁰ magnitude — oracle round-trips would need log-domain.

### T7 — near a ≈ z, Temme uniform asymptotic transition (40 inputs)

Per ADR-0042 §"What we will not decide" — **v0.1 carve-out**. v0.1 ships series + CF dispatch only for IncompleteGamma. In the saddle region `|z − a| ≤ C·√|a|` with `|a| ≥ 20`, both series and CF degrade: series convergence is slow, CF near-stagnation. The carve-out: v0.1 may lose up to `log₂(|a|)` bits relative to requested precision. At prec = 200, a = 100, z = 100, the dispatch may achieve only ~190 bits of agreement.

**The corpus MUST measure this gap explicitly** so v0.2's Temme implementation can prove the closure. The G8 cross-agreement comparator tolerates the carve-out on T7 cells: passes at `precision − log₂(|a|)` bits instead of `precision − 4`. The V1 verification gate (Phase 4) MUST not block on saddle-region cells achieving full precision.

Grid: `a ∈ {20, 100, 200}`, `z = a + δ·√a` for `δ ∈ {-1, 0, +1}`. The `δ = 0` cell is the exact saddle point. All four L12 heads (Upper/Lower/P/Q) get the grid. Half-integer-a Temme cells (`a = 21/2, 101/2`) exercise the closed-form/Temme interaction.

### T8 — digamma near negative integers (40 inputs)

Digamma's poles are at `z = 0, -1, -2, ...` (simple poles, residue −1). The reflection formula `ψ(1 − z) − ψ(z) = π·cot(πz)` is the bedrock of negative-z evaluation: compute `ψ(1 − x)` via positive-x asymptotic, then apply reflection.

`cot(πz)` has the same simple poles, so when `z` is near an integer, the reflection picks up large `π·cot(πz)` values that must cancel against the `ψ(1 − z)` contribution. The cancellation depth is `lossBits ≈ log₂(1/|δ|)` where `δ = z − round(z)`. The substrate must scale `work_prec` accordingly; this tier proves the scaling is happening at the 50-dp gold tier.

Grid: `z = -n + δ` for `n ∈ {-1, -2, -3}` and `δ ∈ {±1e-2, ±1e-6}` (`lossBits ∈ {7, 20}`). Three heads — Digamma, Trigamma, Polygamma(m=2) — get the grid because higher-order poles have more brutal cancellation. Plus 4 off-axis complex cells (`z = n + r·e^(iθ)`) exercising the complex-cot path.

---

## Landmines pinned in `corpus.json.landmines_pinned`

For traceability, the JSON manifest records the landmine pins:

- **L1** Wolfram input-trap: all numerics as Rational strings / 60-dp decimals.
- **L12** Incomplete-gamma regularisation: Upper, Lower, P, Q are FOUR DISTINCT HEADS — never share an input record.
- **L14** SciPy 1.11.4 polygamma complex `TypeError` — T4 polygamma cells are gold-only (Wolfram + mpmath).
- **L15** SciPy `loggamma(real_negative) → NaN`; adapter passes `x + 0j`.
- **L17** Γ at non-positive integers: four oracle behaviors (`ComplexInfinity`, `ValueError`, `+∞`, `NaN`); comparator special-cases poles.
- **v0.1-carve-out** T7 Temme region: G8 comparator tolerates `precision − log₂(|a|)` bits instead of `precision − 4`.

R5 §6 lists L2, L_carryover, L11, L13, L16 as well; those are adapter-level (rounding, syntax, trailing-noise stripping, third-voice gaps) rather than corpus-level decisions, so the corpus does not encode them directly. The adapter authors (G2-G7) read R5 §6 in full.

---

## Acceptance check transcript

```sh
# 1. Generator runs cleanly
$ bun bench/gamma-anchor/generate-corpus.ts
Wrote /home/tobias/Projects/scientist-workbench/bench/gamma-anchor/corpus.json
Total inputs: 377
By tier: { T1: 92, T2: 43, T3: 54, T4: 40, T5: 40, T6: 28, T7: 40, T8: 40 }
By head: { all 19 ADMITTED_HEADS present }

# 2. corpus.json validates as JSON — yes

# 3. Reproducibility — byte-identical on re-run
$ sha256sum bench/gamma-anchor/corpus.json > /tmp/h1
$ bun bench/gamma-anchor/generate-corpus.ts
$ sha256sum bench/gamma-anchor/corpus.json > /tmp/h2
$ diff /tmp/h1 /tmp/h2   # (empty)

# 4. Sanity: 250 ≤ totals.total ≤ 400 — 377 ✓
# 5. Sanity: 8 tiers populated, all 19 ADMITTED_HEADS covered — verified ✓
```

---

## Pointers

- `docs/adr/0042-gamma-family-per-head-substrate.md` — the architectural spine; ADMITTED_HEADS (§Decision 4), vocab admission (§Decision 6), oracle landscape (§Decision 8).
- `docs/refs/gamma-research/R5-oracle-landscape.md` §6 — full landmine list L1-L17.
- `docs/refs/gamma-research/R3-float64-algorithms.md` §1, §6 — per-head verbatim-port table and the canonical 19-entry ADMITTED_HEADS list.
- `docs/refs/gamma-research/R2-arbprec-algorithms.md` §1 — algorithm dispatch tables (Stirling shift threshold, series/CF crossover, Temme region).
- `docs/refs/gamma-research/PHASE2-impl-plans.md` lines 1171-1190 — corpus design notes that this manifest implements.
- `bench/erf-anchor/generate-corpus.ts` — single-arg-head precedent.
- `bench/besselj-anchor/generate-corpus.ts` — multi-arg-head precedent (closer to gamma family in spirit).
- `bench/gamma-anchor/generate-corpus.ts` — the generator this spec describes.
- `bench/gamma-anchor/corpus.json` — the wire artefact.
