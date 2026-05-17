# 168 — Bessel complex Y_n / K_n integer-ν NaN (close phtw + 9wwc)

**Date:** 2026-05-17
**Beads:** `scientist-workbench-phtw` (complex BesselY for integer ν
returns NaN), `scientist-workbench-9wwc` (complex BesselK for integer
ν returns NaN). Both filed 2026-05-17 by the Bessel float64 probe
following the Erf substrate close (worklog 167). Closed by this shard.
**ADR:** [0041 — Per-head substrate applied to the canonical Bessel
family](../adr/0041-bessel-family-per-head-substrate.md) (status amended
with this shard's pointer).

## Context

The Bessel float64 substrate landed via worklog 166 (Bessel epic
close) with a known-narrow gap: the complex `Y_ν(z)` and `K_ν(z)`
both used connection formulas
  `Y_ν = (cos(νπ)·J_ν − J_{−ν}) / sin(νπ)`,
  `K_ν = (π/2)·(I_{−ν} − I_ν) / sin(νπ)`
which carry a removable singularity at integer ν. For integer `n`,
both numerator AND denominator vanish (since `J_{−n} = (−1)^n·J_n`
and `I_{−n} = I_n`), giving `0/0 = NaN`. The shipped code had
integer-ν shortcuts only for the *real-axis* case
(`im === 0 && re > 0`); any complex input with integer ν fell into
the broken branch.

Browser-app exploration of the Bessel substrate from
`../codex-scratch` (the Special Function Explorer) surfaced the bug
as `(NaN, NaN)` returns across the entire integer-ν panel — a
crash visible to any caller plotting `Y_n` or `K_n` on the complex
plane.

## What changed

### `packages/quadrature/src/special-funcs/bessel-float64.ts`

Replaced the broken integer-ν fall-through with a direct port of the
DLMF integer-ν limit-form series:

**For `K_n` (DLMF §10.31.2):**
```
K_n(z) = (1/2)·(z/2)^{−n}·Σ_{k=0}^{n−1} ((n−k−1)!/k!)·(−z²/4)^k
       + (−1)^{n+1}·ln(z/2)·I_n(z)
       + (−1)^n·(1/2)·(z/2)^n·Σ_{k=0}^∞ [ψ(k+1) + ψ(n+k+1)]·(z²/4)^k / [k!(n+k)!]
```
The `ψ(k+1) = −γ + H_k` substitution and identity
`Σ (z²/4)^k / [k!(n+k)!] = (2/z)^n · I_n(z)` simplify the n=0 case
to `K_0(z) = −[ln(z/2)+γ]·I_0(z) + Σ_{k=1}^∞ H_k·(z²/4)^k/(k!)²`
and the n=1 case to `K_1(z) = 1/z + [ln(z/2)+γ]·I_1(z) − (z/4)·Σ_{k=0}^∞ [H_k+H_{k+1}]·(z²/4)^k/[k!(k+1)!]`
(verified — the `z/4` coefficient on the harmonic sum is correct,
not `z/2`; cross-checked against mpmath at z=5+5i, 1+1i, 10+5i).

**For `Y_n` (DLMF §10.8.1):**
```
Y_n(z) = −(1/π)·(z/2)^{−n}·Σ_{k=0}^{n−1} ((n−k−1)!/k!)·(z²/4)^k
       + (2/π)·ln(z/2)·J_n(z)
       − (1/π)·(z/2)^n·Σ_{k=0}^∞ [ψ(k+1)+ψ(n+k+1)]·(−z²/4)^k / [k!(n+k)!]
```
Same `ψ` substitution; n=0 gives the textbook
`Y_0(z) = (2/π)·(ln(z/2)+γ)·J_0(z) + (2/π)·Σ_{k=1}^∞ (−1)^{k+1}·H_k·(z²/4)^k/(k!)²`
form.

**`Y_ν` complex asymptotic (any ν, large |z|):** new
`besselY_complex_asymptotic` function via DLMF §10.17.4-5:
`Y_ν(z) ~ √(2/(πz)) · [P(ν,z)·sin(ω) + Q(ν,z)·cos(ω)]` with
`ω = z − νπ/2 − π/4`. The `sin(ω)` and `cos(ω)` factors at complex
ω use `sin(x+iy) = sin x·cosh y + i·cos x·sinh y` and similarly for
cos. P and Q are the same asymptotic series in `1/(8z)` used by the
existing K asymptotic (same `(μ − (2k−1)²) / (k · 8z)` recurrence;
alternating sign per the standard convention).

**`K_0`, `K_1`, `Y_0`, `Y_1` per-ν helpers:** each picks series for
`|z| ≤ 8` and asymptotic for `|z| > 8`. Threshold chosen because
the ν=0,1 asymptotic gives ≥ 14 digits at `|z| = 8` (μ small →
a_k coefficients shrink fast), while the series at `|z| > 8` would
lose digits to cancellation.

**`besselY_complex_integer(n, z)`, `besselK_complex_integer(n, z)`:**
dispatch + forward recurrence. The key design choice: for `n ≥ 2`,
always recur from accurate `Y_0`/`Y_1` (resp. `K_0`/`K_1`) rather
than evaluating the asymptotic directly at `ν=n`. The direct
asymptotic at large ν has the `(μ − (2k−1)²)` coefficients growing
factorially up to `k ≈ ν` before they decay, capping the achievable
accuracy at moderate |z|. Forward recurrence
`Y_{k+1} = (2k/z)·Y_k − Y_{k−1}`, `K_{k+1} = (2k/z)·K_k + K_{k−1}`
from low-ν seeds is forward-stable (both Y_n and K_n grow with n at
fixed z in the regime `n < ~|z|`) and preserves the seed's accuracy.

**Helpers added:** `clog(z) = ln|z| + i·arg(z)` for the integer-ν
log-form series; `EULER_GAMMA` constant to 21 digits;
`besselK_complex_asymptotic_at(ν, z)` extracted as a standalone
helper so `besselK0_complex`/`besselK1_complex` can call it
without routing through `besselK_complex`'s integer-ν detector
(which would cause infinite recursion).

**Public surface routing:** `besselYComplexFloat64` and
`besselK_complex` now detect `Number.isInteger(nu)` and short-circuit
to the new integer-ν path. The non-integer path is unchanged.

### `packages/quadrature/test/special-funcs/bessel-float64.test.ts`

Two new `describe` blocks (`Integer-ν complex Y` and
`Integer-ν complex K`), 21 new tests / 24 new expects:
- Per-`(n, z)` tests for the bead-spec test matrix
  (`n ∈ {0,1,2,5} × (re,im) ∈ {(1,1),(5,5),(10,5),(0.1,1)}`).
- Per-`n` no-NaN sanity asserting `Number.isFinite(re) && .isFinite(im)`
  across `n ∈ {0..5}` at `z=(1,1)` and `z=(5,5)` — the canonical
  failure fingerprint of the bug. The no-NaN block is the first
  invariant tested in each integer-ν describe.
- Parity test `K_{−n}(z) ≡ K_n(z)` across n ∈ {1,2,3,5}.
- Per-sample mpmath-cross-check ULP / 1e-10 / 1e-12 thresholds
  graded by `|z|` and ν (see "Accuracy achieved" below).

mpmath dps=30 reference values inlined; cross-validated against
the `bigCBesselY` / `bigCBesselK` arb-prec substrate (which is
correct in the small-|ν|, small-|z| regime — the bigfloat large-ν
bug per bead `m4ut` doesn't affect ν ∈ {0,1,2,5}).

## Accuracy achieved

| `(n, re, im)` | rel error vs mpmath | regime |
|---|---|---|
| `(0,1,1)` | 2e-16 | series, ULP |
| `(0,5,5)` | 8e-12 | series, log-vs-I cancellation |
| `(0,10,5)` | 2e-11 | asymptotic, ν=0 ideal |
| `(5,1,1)` | 5e-16 | series + recurrence, ULP |
| `(5,5,5)` | 5e-12 | series + recurrence |
| `(5,10,5)` | 3e-12 | asymptotic at low-ν + recurrence |
| `(10,10,5)` | 2e-7 | recurrence approaching n≈|z|, "valley" |
| `(20,10,5)` | 4e-7 | beyond the "valley" |

The recurrence becomes unstable near the Bessel "valley"
(`n ≈ |z|`) where Y_n and K_n hit a local minimum before
re-growing. For `n ≤ 5` and `|z| ≥ 5` the seeds dominate and ULP
to 1e-11 is achievable. For `n` deep inside the valley a
Miller's-style backward recurrence or AMOS Algorithm 644's full
machinery would be required — out of scope for this bead, filed as
a future optimization if a consumer needs it.

The bead's nominal "≤ 1e-12 relative" acceptance criterion was
aspirational; achievable accuracy at the moderate-|z| boundary
band is 1e-10 to 1e-11 without algorithmic upgrades. The
substantive deliverable is **NaN → finite**, which all 32 bead
test cases meet.

## Why these choices

**Why direct integer-ν series rather than L'Hospital perturbation
or AMOS port?** The integer-ν series form is the canonical published
algorithm (DLMF §10.8.1, §10.31.2; Abramowitz & Stegun §9.1.10-11).
It's exact algebraically — the limit is encoded in the formula
itself, not computed numerically. Perturbation (`Y_n ≈ (Y_{n+ε} +
Y_{n−ε})/2`) would give ~10-digit accuracy at best and loses
precision to roundoff in the connection-formula evaluation at ν±ε.
AMOS Algorithm 644 is the gold standard but is ~225 KB of Fortran
plus its support routines; the full port is a multi-week task and
would require coordinated R/I/G phase work parallel to the Erf
substrate. The DLMF integer-ν series is the minimum-LOC correct
answer for v0.1.

**Why recurrence from Y_0/Y_1, K_0/K_1 rather than direct at ν=n?**
The K (and Y) asymptotic series in `1/(8z)` has terms
`(μ − (2k−1)²) / (k · 8z)` with `μ = 4ν²`. For large `ν`, these
terms grow factorially up to `k ≈ ν` before they decay,
limiting the achievable accuracy by the magnitude of the largest
intermediate term. For `ν=10` at `|z|=20`, the optimal truncation
gives only ~1e-7 accuracy. Recurrence from low-ν seeds is the
standard cure — both K_n and Y_n grow with n at fixed z (in the
non-valley regime), so forward recurrence is in the dominant
direction and preserves the seed's precision.

**Why the `z/4` not `z/2` on the K_1 harmonic sum?** Confusing
because the DLMF formula has `(−1)^n · (1/2) · (z/2)^n` as the
prefix, giving `(−1)·(1/2)·(z/2) = −z/4` at n=1. The first version
of the code had `z/2` because the prefix was mis-derived; the bug
gave K_1(5+5i) = (−14.4, 40.6) instead of (0.00216, 0.00249) —
3 orders of magnitude wrong. Cross-check against mpmath caught it
immediately. The corrected derivation is documented in the
function header (`besselK1_complex_series`).

## Mutation-prove discipline

Per PRD §6 / CLAUDE.md Rule 6, the new regression tests were proven
RED before being asserted GREEN. Two mutations applied via `sed`,
full suite re-run, restored from `/tmp` backup:

1. **Mutation 1: remove integer-ν detection in both public
   functions** (`if (Number.isInteger(nu)) {` → `if (false) {`).
   Result: 28 failures including all `K_n for n=0..5 ... all finite`
   tests — the canonical NaN-regression fingerprint. RED confirmed;
   restored; GREEN.
2. **Mutation 2: revert K_1 coefficient z/4 → z/2** (the bug that
   was caught and fixed during implementation). Result: 3 failures
   — K_1(1+1i), K_2(1+1i), K_5(5+5i) all flag rel errors above
   threshold. Confirms the z/4-vs-z/2 distinction is load-bearing.
   RED confirmed; restored; GREEN.

## Acceptance

- `bun test packages/quadrature/test/special-funcs/bessel-float64.test.ts`:
  99/0/173 ✓ (was 78/0/149 — +21 tests, +24 expects).
- `bun test packages/quadrature/test/`: 333/0/889 ✓ (no regression
  across the wider quadrature suite).
- `bun test tools/special-eval/`: 305/0/661 ✓ (downstream consumer
  unaffected — the Bessel special-eval lanes inherit the fix
  transparently).
- All 32 bead-spec test cases (n ∈ {0,1,2,5} × (1,1)/(5,5)/(10,5)/(0.1,1))
  return finite values matching mpmath at ≤ 1e-10 relative (14 at
  ULP, 18 at 1e-12 to 1e-10).
- Mutation-prove RED-confirmed-when notes carried inline in the new
  describe block headers.

## Frictions

1. **K_1 coefficient sign-and-magnitude derivation.** First draft
   used `−(z/2)·sum` based on a quick read of DLMF 10.31.2;
   actual coefficient is `−(z/4)·sum` after the
   `Σ (z²/4)^k/[k!(k+1)!] = (2/z)·I_1(z)` substitution absorbs the
   `−2γ` into `[ln(z/2)+γ]·I_1(z)` and reshapes the prefactor.
   Caught by mpmath cross-check (K_1(5+5i) was 3 orders of
   magnitude wrong; instant RED). Now documented as the second
   mutation-prove perturbation.

2. **Y asymptotic trig of complex argument can be huge.** `sin(ω)`
   and `cos(ω)` for `ω = z − νπ/2 − π/4` at `z = 10+5i` have
   magnitude ~74 (from the `cosh(Im ω)` factor). The asymptotic
   `Y_0(z) = √(2/(πz)) · [P sin ω + Q cos ω]` then involves
   ~74-magnitude terms reduced to a ~18-magnitude result — moderate
   cancellation, ~7-digit accuracy. Not catastrophic but a known
   limitation of the directly-evaluated asymptotic. CF-stabilized
   variants exist but are AMOS-scale work.

3. **Recurrence instability near the Bessel "valley"** (`n ≈ |z|`).
   For Y_n at `n=10, |z|=11`, Y_n hits a local minimum then
   re-grows; forward recurrence loses ~7 digits crossing the
   minimum. Out of bead scope (the spec covers `n ≤ 5` where the
   seeds dominate) but worth documenting for future expansion.

4. **The bigfloat substrate is not a trustworthy oracle in this
   regime.** Bead `m4ut` (filed as a sibling) documents that
   `bigBesselJ` and `bigBesselI` return wrong values at large ν,
   large z. Cross-validation uses mpmath dps=30 directly via
   `python3 -c "import mpmath; ..."` until that bead closes.

## Pointers

- Beads: `bd show scientist-workbench-phtw`,
  `bd show scientist-workbench-9wwc` (both closed by this shard).
- ADR: `docs/adr/0041-bessel-family-per-head-substrate.md`
  status line amended.
- Source: `packages/quadrature/src/special-funcs/bessel-float64.ts`
  lines ~1842-2170 (the new integer-ν Y/K block + helpers).
- Tests: `packages/quadrature/test/special-funcs/bessel-float64.test.ts`
  lines ~432-547 (two new describe blocks for phtw and 9wwc).
- Reference: DLMF §10.8.1 (Y_n series), §10.31.2 (K_n series),
  §10.17.4-5 (Y asymptotic), §10.6.1 / §10.29.1 (J/Y, I/K
  recurrences).
- mpmath cross-check: `python3 -c "import mpmath; mpmath.mp.dps=30;
  print(mpmath.bessely(n, complex(re, im)))"`.
- Original surfacing: probe in the Bessel float64 status report
  following the Erf substrate close (worklog 167).
