# R1 — Canonical Symbolic Identities for Erf, Erfc, Erfi, Erf⁻¹, Erfc⁻¹

**Bead:** R1 (research, deep-source). Parent campaign: world-class
reference Erf implementation for scientist-workbench.
**Author:** subagent, 2026-05-16.
**Status:** Research artefact. Not source-of-truth; cite the primary
references when porting any identity into a rule file.

**Scope.** Exhaustive table of *symbolic* identities — pattern shapes
suitable for dispatch in a CAS pattern rewriter — for the five heads
`Erf`, `Erfc`, `Erfi`, `Erf^-1` (`InverseErf`), `Erfc^-1`
(`InverseErfc`). Cross-source: DLMF Ch. 7 (primary), SymPy
`error_functions.py` (working-CAS perspective), Wikipedia
(consolidated cross-check), Wolfram Functions site (gated under
HTTP 403 during this pass — substituted by the DLMF-equivalent and
SymPy reductions).

**Notation.**
- `z`: complex variable. Conditions stated per identity.
- `H_n(z)`: physicists' Hermite polynomials.
- `M(a,b,z) = ₁F₁(a;b;z)`: Kummer confluent hypergeometric (first kind).
- `U(a,b,z)`: Tricomi confluent hypergeometric (second kind).
- `γ(s,x)`, `Γ(s,x)`: lower / upper incomplete gamma.
- `E_n(z)`: generalised exponential integral.
- `w(z)`: Faddeeva function — definition 7.2.3.
- `F(z)`: Dawson's integral — definition 7.2.5.
- `C(z)`, `S(z)`: Fresnel integrals — definitions 7.2.7–7.2.8.
- `inverf x`, `inverfc x`: DLMF spellings for `Erf^-1`, `Erfc^-1`.

**Source priority (when sources disagree).**
DLMF > NIST Handbook (Olver et al.) > SymPy > Wikipedia > Mathematica.
The few divergences encountered are flagged inline.

---

## 0. Source manifest

| Tag | Source | URL / pin |
|---|---|---|
| `DLMF §X.Y.Z` | NIST Digital Library of Mathematical Functions, Ch. 7 (N. M. Temme, ed.) | https://dlmf.nist.gov/7 |
| `Olver et al. §X.Y.Z` | NIST Handbook of Mathematical Functions (CUP 2010) | textbook, same numbering as DLMF |
| `SymPy:erf` etc. | `sympy/functions/special/error_functions.py` master branch | https://raw.githubusercontent.com/sympy/sympy/master/sympy/functions/special/error_functions.py |
| `Wiki:erf` | Wikipedia "Error function" | https://en.wikipedia.org/wiki/Error_function |
| `Wiki:inverf` | Wikipedia "Inverse error function" | https://en.wikipedia.org/wiki/Inverse_error_function |
| `Wiki:Faddeeva` | Wikipedia "Faddeeva function" | https://en.wikipedia.org/wiki/Faddeeva_function |
| `Wiki:Dawson` | Wikipedia "Dawson function" | https://en.wikipedia.org/wiki/Dawson_function |
| `Wolfram` | `functions.wolfram.com/GammaBetaErf/Erf/...` | **HTTP 403 during this pass** — the identities Wolfram catalogues are recovered through DLMF + SymPy cross-section. Future re-pull may add Wolfram formula-IDs (e.g. `06.27.16.0001.01`). |

---

## 1. Special values

Citations are pinned per row. Where two sources differ in conventions
(e.g. `Erfc(±∞)` is sometimes given over the extended real line and
sometimes for `|ph z| ≤ π/4 − δ`), the principal-value row reflects
the DLMF cone.

### 1.1 Erf

| Argument | Value | Source |
|---|---|---|
| `Erf(0)` | `0` | DLMF §7.2.1 (definition); SymPy:erf |
| `Erf(+∞)` (real) | `1` | DLMF §7.2.4; SymPy:erf |
| `Erf(−∞)` (real) | `−1` | Symmetry §7.4.1 + 7.2.4; SymPy:erf |
| `Erf(∞)` (`|ph z| ≤ π/4 − δ`) | `1` | DLMF §7.2.4 |
| `Erf(i·∞)` | `i·∞` | SymPy:erf (`erf(I*oo) = I*oo`); follows from §7.5.1 via Dawson asymptotic |
| `Erf(−i·∞)` | `−i·∞` | SymPy:erf |
| `Erf(z)` real-line iff | `z ∈ ℝ_ext` | SymPy:erf (`_eval_is_real`) |

### 1.2 Erfc

| Argument | Value | Source |
|---|---|---|
| `Erfc(0)` | `1` | DLMF §7.2.2 + 7.2.1 |
| `Erfc(+∞)` (real) | `0` | DLMF §7.2.4 |
| `Erfc(−∞)` (real) | `2` | Symmetry §7.4.2 + 7.2.4; SymPy:erfc |
| `Erfc(i·∞)` | `−i·∞` | SymPy:erfc |
| `Erfc(−i·∞)` | `i·∞` | SymPy:erfc |

### 1.3 Erfi

| Argument | Value | Source |
|---|---|---|
| `Erfi(0)` | `0` | Defn `Erfi(z) = −i·Erf(iz)` + 1.1 |
| `Erfi(+∞)` (real) | `+∞` | SymPy:erfi; defn + asymptotic |
| `Erfi(−∞)` (real) | `−∞` | Odd symmetry |
| `Erfi(i·∞)` | `i` | SymPy:erfi — `Erfi(iz) = i·Erf(z)`, so `Erfi(i·∞) = i·Erf(∞) = i·1 = i` |
| `Erfi(−i·∞)` | `−i` | SymPy:erfi |

### 1.4 Inverse functions

| Argument | Value | Source |
|---|---|---|
| `Erf^-1(0)` | `0` | DLMF §7.17.2 (series starts at order 1); SymPy:erfinv |
| `Erf^-1(1)` | `+∞` | DLMF §7.17.1 + 7.2.4; SymPy:erfinv |
| `Erf^-1(−1)` | `−∞` | Symmetry; SymPy:erfinv |
| `Erfc^-1(0)` | `+∞` | DLMF §7.17.1; SymPy:erfcinv |
| `Erfc^-1(1)` | `0` | DLMF §7.17.1; SymPy:erfcinv |
| `Erfc^-1(2)` | `−∞` | DLMF §7.17.1; SymPy:erfcinv |

### 1.5 Two-argument `Erf2(x, y) := Erf(y) − Erf(x)` (SymPy convention)

Pattern-table opportunity; SymPy ships these collapses:

| Pattern | Value | Source |
|---|---|---|
| `Erf2(0, 0)` | `0` | SymPy:erf2 |
| `Erf2(x, x)` | `0` | SymPy:erf2 |
| `Erf2(x, ∞)` | `1 − Erf(x)` = `Erfc(x)` | SymPy:erf2 |
| `Erf2(x, −∞)` | `−1 − Erf(x)` | SymPy:erf2 |
| `Erf2(∞, y)` | `Erf(y) − 1` = `−Erfc(y)` | SymPy:erf2 |
| `Erf2(−∞, y)` | `Erf(y) + 1` | SymPy:erf2 |

`Erf2` is not in `cas-core`'s vocabulary today; consider whether to
admit it (low coverage cost; useful for normal-CDF region patterns).

---

## 2. Symmetry, parity, conjugation

| Identity | Conditions | Source |
|---|---|---|
| `Erf(−z) = −Erf(z)` | all `z ∈ ℂ` (entire, odd) | DLMF 7.4.1 |
| `Erfc(−z) = 2 − Erfc(z)` | all `z ∈ ℂ` | DLMF 7.4.2 |
| `Erfi(−z) = −Erfi(z)` | all `z ∈ ℂ` (entire, odd) | SymPy:erfi; from §7.4.1 + defn |
| `Erf(z̄) = Erf(z)̄` | all `z ∈ ℂ` (Schwarz reflection) | SymPy:erf (`_eval_conjugate`) |
| `Erfc(z̄) = Erfc(z)̄` | all `z ∈ ℂ` | SymPy:erfc |
| `Erfi(z̄) = Erfi(z)̄` | all `z ∈ ℂ` | SymPy:erfi |
| `Erf^-1(−x) = −Erf^-1(x)` | `x ∈ (−1, 1)` (odd on principal branch) | SymPy:erfinv |
| `w(−z) = 2·e^(−z²) − w(z)` | all `z ∈ ℂ` | DLMF 7.4.3 |
| `w(−z̄) = w(z)̄` | all `z ∈ ℂ` | Wiki:Faddeeva |
| `F(−z) = −F(z)` | all `z ∈ ℂ` | DLMF 7.4.4 |

**Pattern note.** The Erf reflection `Erf(−z) → −Erf(z)` collides with
the canonicalisation policy: most CAS engines fold `−z` *into* the
multiplicand, so the pattern fires as a sign-extraction pre-pass that
runs before the head-table lookup. SymPy's `eval` does this in the
"Real reduction" branch of the `@classmethod eval`.

---

## 3. Algebraic / interrelation identities

Five definitional relations interconnect the five heads. These are
the *first-rank* rules a pattern table fires on input.

| ID | Identity | Source |
|---|---|---|
| A1 | `Erfc(z) = 1 − Erf(z)` | DLMF 7.2.2 (the *defining* identity) |
| A2 | `Erf(z) = 1 − Erfc(z)` | A1 rearranged |
| A3 | `Erfi(z) = −i · Erf(iz)` | SymPy:erfi (definition); equivalently `Erf(iz) = i·Erfi(z)` |
| A4 | `Erf(z) = −i · Erfi(iz)` | A3 inverted (`z ↦ iz`, then divide by `−i`) |
| A5 | `Erfc(iz) = 1 + i · Erfi(z)` (equivalently `Erfc(iz) − 1 = i·Erfi(z)`) | SymPy:erfc rewrite; DLMF 7.2.2 + A4 |
| A6 | `w(z) = e^(−z²) · Erfc(−iz)` | DLMF 7.2.3 |
| A7 | `w(iz) = e^(z²) · Erfc(z)` (the "erfcx" identity) | Wiki:Faddeeva from A6 |
| A8 | `F(z) = (√π / 2) · e^(−z²) · Erfi(z)` | Wiki:Dawson |
| A9 | `F(z) = (1/(2iπ)) · (e^(−z²) − w(z)) = −(1/(2iπ)) · e^(−z²) · Erf(iz)` | DLMF 7.5.1 |
| A10 | `C(z) + i·S(z) = ((1+i)/2) · Erf(((1−i)/2)·√π · z)` (Fresnel via Erf at change-of-variable `ζ = ½√π(1∓i)z`) | DLMF 7.5.7 + 7.5.8 |
| A11 | `Erfc^-1(1 − z) = Erf^-1(z)` (equivalently `Erfc^-1(y) = Erf^-1(1 − y)`) | SymPy:erfcinv; DLMF §7.17 implicit |
| A12 | `Erf(Erf^-1(y)) = y` for `y ∈ (−1, 1)` | SymPy:erfinv |
| A13 | `Erf^-1(Erf(z)) = z` for real `z`, principal branch otherwise | SymPy:erfinv |
| A14 | `Erfc(Erfc^-1(y)) = y` for `y ∈ (0, 2)` | SymPy:erfcinv |
| A15 | `Erf(Erfc^-1(y)) = 1 − y` | A11 + A12 |

**Discipline note for the dispatcher.** A3 / A4 / A5 mean any
`Erfi`-headed expression with imaginary argument is fully reducible
to `Erf` (and vice versa). In a normalising pass, choose *one*
canonical: SymPy prefers `Erf` (and folds `Erfi(z) → −i·Erf(iz)`
inside `_eval_rewrite_as_erf`). Mathematica does the opposite for
purely imaginary arguments. Pick `Erf` as canonical to match the
DLMF and `cas-diff` conventions already shipped in `cas-core`
(`Erfi` is *not* in the ADR-0023 vocabulary — A3/A4 normalise it
out).

---

## 4. Differential equations

| ID | ODE | Source |
|---|---|---|
| D1 | `y' = (2/√π) · e^(−z²)` for `y = Erf(z)` | DLMF §7.10 (implicit); ADR-0023 row "Erf(z)" |
| D2 | `y'' + 2z·y' = 0` for `y ∈ {Erf, Erfc, Erfi}` (linear, 2nd-order, with the Gaussian as the integrating factor) | DLMF §7.18.5 (the `n=0` case); standard |
| D3 | `y' = −(2/√π) · e^(−z²)` for `y = Erfc(z)` | DLMF §7.10 + A1 |
| D4 | `y' = (2/√π) · e^(z²)` for `y = Erfi(z)` | A3 differentiated |
| D5 | `dⁿ⁺¹Erf(z) / dzⁿ⁺¹ = (−1)ⁿ · (2/√π) · Hₙ(z) · e^(−z²)` | DLMF 7.10.1 |
| D6 | `w'(z) = −2z·w(z) + 2i/√π` | DLMF 7.10.2 |
| D7 | `w^(n+2)(z) + 2z·w^(n+1)(z) + 2(n+1)·w^(n)(z) = 0` | DLMF 7.10.3 |
| D8 | `dF/dz + 2z·F = 1`, `F(0) = 0` (Dawson) | Wiki:Dawson |
| D9 | `(Erf^-1)'(x) = (√π / 2) · exp((Erf^-1(x))²)` | SymPy:erfinv |
| D10 | `(Erfc^-1)'(x) = −(√π / 2) · exp((Erfc^-1(x))²)` | SymPy:erfcinv |
| D11 | `dⁿ/dzⁿ (eᶻ² · Erfc z) = (−1)ⁿ · 2ⁿ · n! · eᶻ² · iⁿerfc(z)` | DLMF 7.18.4 |

The relevant **confluent hypergeometric ODE** comes via §5: with
`y = (2z/√π) · M(½, 3/2, −z²)` substituted, `y` solves the
Kummer ODE `z·y'' + (b − z)·y' − a·y = 0` for `a = ½`, `b = 3/2`
(DLMF §13.2.1) — which restates D2 once the prefactor differential
is folded in.

---

## 5. Reductions to other special functions

A1–A5 already cover the inter-Erf family. The cross-family
reductions land below.

### 5.1 Incomplete gamma

| ID | Identity | Source |
|---|---|---|
| G1 | `Erf(z) = (1/√π) · γ(½, z²)` | DLMF 7.11.1 |
| G2 | `Erfc(z) = (1/√π) · Γ(½, z²)` | DLMF 7.11.2 |
| G3 | `Erfc(z) = (z/√π) · E_{½}(z²)` (generalised exponential integral) | DLMF 7.11.3 |

(Mind the convention: DLMF 7.11.1 prints as `(1/√π)·γ(½, z²)` —
several texts hide the `1/√π` as `2/Γ(½)`. Equivalent.)

### 5.2 Confluent hypergeometric `₁F₁` (Kummer M and U)

| ID | Identity | Source |
|---|---|---|
| H1 | `Erf(z) = (2z/√π) · M(½, 3/2, −z²)` | DLMF 7.11.4 |
| H2 | `Erf(z) = (2z/√π) · e^(−z²) · M(1, 3/2, z²)` | DLMF 7.11.4 (Kummer transformation) |
| H3 | `Erfc(z) = (1/√π) · e^(−z²) · U(½, ½, z²)` | DLMF 7.11.5 |
| H4 | `Erfc(z) = (z/√π) · e^(−z²) · U(1, 3/2, z²)` | DLMF 7.11.5 |
| H5 | `Erfi(z) = (2z/√π) · M(½, 3/2, z²)` | A3 + H1 (sign flip inside `M`) |

### 5.3 Generalised hypergeometric `₂F₂` (via `M`)

Not strictly necessary — the `M` forms above are the canonical
hypergeometric reductions — but the Fresnel cousins (DLMF 7.11.7,
7.11.8) use `₂F₃`-style forms; recorded for completeness only.

### 5.4 Parabolic cylinder

| ID | Identity | Source |
|---|---|---|
| P1 | `iⁿ Erfc(z) = (e^(−z²/2) / (2^(n−1) · √π)) · U(n + ½, z·√2)` (DLMF parabolic-cylinder `U`, equivalent to `D_{−n−1}`) | DLMF 7.18.11 |
| P2 | `Erfc(z) = e^(−z²/2) · D_{−1}(z·√2)` (the `n = 0` case of P1 with `U(½, z·√2) ↔ D_{−1}`) | DLMF 7.18.11 (n=0) + standard `U ↔ D` |

### 5.5 Fresnel integrals

| ID | Identity | Source |
|---|---|---|
| F1 | `C(z) + i·S(z) = ((1+i)/2) · Erf(((1−i)/2)·√π · z)` | DLMF 7.5.7–7.5.8 |
| F2 | `Erf(z) = (1+i) · (C(arg) − i·S(arg))` where `arg = (1−i)·z/√π` | SymPy:erf `_eval_rewrite_as_fresnels` |
| F3 | `Erfi(z) = (1−i) · (C(arg) − i·S(arg))` where `arg = (1+i)·z/√π` | SymPy:erfi |

### 5.6 Meijer G

The canonical Meijer-G form for Erf is already shipped as
`dispatch-rules/dlmf-16-18.ts` rule `dlmf-16-18-erf`:

> `G^{1,1}_{1,2}(1; 1/2, 0 | z) = √π · Erf(√z)`

Equivalently, the *outgoing* G representation a CAS wants is:

| ID | Identity | Source |
|---|---|---|
| M1 | `Erf(z) = (1/√π) · G^{1,1}_{1,2}(1; 1/2, 0 | z²)` (substitute `z → z²` in the dispatch rule, divide by `√π`) | DLMF §16.18 / Wolfram functions site / `dlmf-16-18.ts` |
| M2 | `Erf(z) = (z/√π) · G^{1,0}_{1,2}([], [1]; [0], [−1/2] | z²)` (the SymPy `_eval_rewrite_as_meijerg` form) | SymPy:erf |

Detailed coverage in the campaign's R4 artefact; the Meijer reduction
is a *fallback* path, not a primary pattern in cas-simplify.

### 5.7 Hermite (via §7.18.8)

| ID | Identity | Source |
|---|---|---|
| He1 | `(−1)ⁿ · iⁿerfc(z) + iⁿerfc(−z) = (i^(−n) / (2^(n−1) · n!)) · Hₙ(iz)` | DLMF 7.18.8 |
| He2 | `iⁿerfc(z) = (1 / (2^(n−1) · √π)) · 𝐻ℎₙ(z·√2)` (probability-Hermite form) | DLMF 7.18.12 |

### 5.8 Generalised exponential integral

Reusing G3: `Erfc(z) = (z/√π) · E_{½}(z²)`. (DLMF 7.11.3.)

---

## 6. Series expansions

### 6.1 Maclaurin

| ID | Identity | Source |
|---|---|---|
| S1 | `Erf(z) = (2/√π) · Σ_{n=0}^∞ ((−1)ⁿ · z^(2n+1)) / (n! · (2n+1))` | DLMF 7.6.1 |
| S2 | `Erf(z) = (2/√π) · e^(−z²) · Σ_{n=0}^∞ (2ⁿ · z^(2n+1)) / (1·3·5···(2n+1))` (Glaisher's form — converges faster for moderate `z`) | DLMF 7.6.2 |
| S3 | `Erfi(z) = (2/√π) · Σ_{n=0}^∞ z^(2n+1) / (n! · (2n+1))` (all-positive twin of S1) | Wiki:erf; from A3 |
| S4 | `iⁿerfc(z) = Σ_{k=0}^∞ ((−1)ᵏ · zᵏ) / (2^(n−k) · k! · Γ(1 + ½(n−k)))` (Taylor for repeated-integral) | DLMF 7.18.6 |

The first few coefficients of S1: `Erf(z) ≈ (2/√π)·(z − z³/3 + z⁵/10
− z⁷/42 + z⁹/216 − …)`.

### 6.2 Asymptotic (`|z| → ∞`)

| ID | Identity | Source |
|---|---|---|
| AS1 | `Erfc(z) ∼ (e^(−z²) / (√π · z)) · Σ_{m=0}^∞ ((−1)ᵐ · (½)_m / z^(2m))` for `|ph z| < 3π/4` (Poincaré-asymptotic; `(½)_m` is the Pochhammer) | DLMF 7.12.1 |
| AS2 | Equivalent re-indexed: `Erfc(z) ∼ (e^(−z²) / (z·√π)) · (1 − 1/(2z²) + 3/(4z⁴) − 15/(8z⁶) + ⋯)` | DLMF 7.12.1 |
| AS3 | `Erfi(z) ∼ −i + (e^(z²) / (√π · z)) · Σ_{m=0}^∞ ((½)_m / z^(2m))` for `|ph z| < π/4` | SymPy:erfi `_eval_aseries` |
| AS4 | Continued fraction (Laplace 1805): `√π · e^(z²) · Erfc(z) = z / (z² + 1/2 / (1 + 1/(z² + 3/2 / (1 + 2/(z² + ⋯)))))` for `ℜ z > 0` | DLMF 7.9.1 |
| AS5 | Continued fraction (Jacobi): `√π · e^(z²) · Erfc(z) = 2z / (2z² + 1 − 1·2/(2z² + 5 − 3·4/(2z² + 9 − ⋯)))` for `ℜ z > 0` | DLMF 7.9.2 |
| AS6 | Bürmann series: `Erf(x) = (2/√π) · sgn(x) · √(1 − e^(−x²)) · (√π/2 + Σ_{k=1}^∞ cₖ · e^(−k·x²))` | Wiki:erf |

### 6.3 Series of (spherical) Bessel / Hermite

| ID | Identity | Source |
|---|---|---|
| SB1 | `Erf(z) = (2z/√π) · Σ_{n=0}^∞ (−1)ⁿ · [i^{(1)}_{2n}(z²) − i^{(1)}_{2n+1}(z²)]` (modified spherical Bessel `i^{(1)}_ν`) | DLMF 7.6.8 |
| SB2 | Chebyshev expansion `Erf(a·z)` valid `−1 ≤ a ≤ 1` (DLMF 7.6.9 — coefficients tabulated in Luke 1969 vol II) | DLMF 7.6.9 |

---

## 7. Integral representations

| ID | Identity | Source |
|---|---|---|
| I1 | `Erf(z) = (2/√π) · ∫_0^z e^(−t²) dt` (defining) | DLMF 7.2.1 |
| I2 | `Erfc(z) = (2/√π) · ∫_z^∞ e^(−t²) dt` (defining) | DLMF 7.2.2 |
| I3 | `Erfc(z) = (2/π) · e^(−z²) · ∫_0^∞ e^(−z²·t²) / (t² + 1) dt` for `|ph z| ≤ π/4` (Glaisher-type) | DLMF 7.7.1 |
| I4 | `w(z) = (1/(πi)) · ∫_{−∞}^∞ e^(−t²) / (t − z) dt` for `ℑ z > 0` (Plemelj / Cauchy) | DLMF 7.7.2 |
| I5 | `∫_0^∞ e^(−a·t)/(t + z²) dt = √(π/a) · e^(a·z²) · Erfc(√a · z)` for `ℜ a, ℜ z > 0` | DLMF 7.7.4 |
| I6 | `∫_x^∞ e^(−(a·t² + 2b·t + c)) dt = ½ · √(π/a) · e^((b² − a·c)/a) · Erfc(√a · x + b/√a)` | DLMF 7.7.6 |
| I7 | `∫_x^∞ e^(−(a²·t² − b²/t²)) dt = (√π / (4a)) · [e^(2ab) · Erfc(a·x + b/x) + e^(−2ab) · Erfc(a·x − b/x)]` | DLMF 7.7.7 |
| I8 | `∫_0^x Erf(t) dt = x·Erf(x) + (e^(−x²) − 1)/√π` | DLMF 7.7.9 |
| I9 | Craig's formula: `Erfc(x) = (2/π) · ∫_0^{π/2} exp(−x²/sin²θ) dθ`, `x ≥ 0` | Wiki:erf |
| I10 | `Erfi(z) = −i · Erf(iz)` with `Erfi(z) = (2/√π) · ∫_0^z e^(t²) dt` (direct integral form) | Wiki:erf; defn |
| I11 | `iⁿerfc(z) = (2/√π) · ∫_z^∞ ((t − z)ⁿ / n!) · e^(−t²) dt` | DLMF 7.18.2 |
| I12 | Mills' ratio: `M(x) := e^(x²) · ∫_x^∞ e^(−t²) dt = (√π/2) · e^(x²) · Erfc(x)` (a renormalised Erfc) | DLMF 7.8.1 |

---

## 8. Addition / multiplication theorems

| ID | Claim | Source |
|---|---|---|
| Add1 | **No closed-form `Erf(a + b)` in elementary functions.** Wikipedia notes explicitly: "No single closed-form addition formula `Erf(x+y)` exists in elementary functions." | Wiki:erf |
| Add2 | The *only* additive structure is the iterated-integral relation: `iⁿerfc(z) = ∫_z^∞ i^(n−1)erfc(t) dt`, with `i⁻¹erfc(z) = (2/√π)·e^(−z²)`, `i⁰erfc(z) = Erfc(z)`. This is a "lift-by-one" operator on `n`, not an additive in `z`. | DLMF 7.18.1–7.18.2 |
| Mul1 | **No closed-form `Erf(n·z)` for general integer `n`.** Half-integer multiples can sometimes be derived via repeated application of Hermite (D5) but do not produce a finite closed form. | (absence; Wiki:erf, by inspection) |
| Mul2 | The Erf/Erfc *value-protocol-relevant* "multiplication" is the recurrence DLMF 7.18.7: `iⁿerfc(z) = −(z/n) · i^(n−1)erfc(z) + (1/(2n)) · i^(n−2)erfc(z)`. This is a parameter recurrence on the iteration index, not the variable. | DLMF 7.18.7 |

**Implication for the pattern table.** No rule of form
`Erf(a + b) → ...` is admissible. Add1/Mul1 are *negative* facts the
dispatcher uses to refuse synthesis attempts honestly (`tagged
"cas-simplify/erf-no-addition-theorem"`-shaped boundary), not to
generate output.

---

## 9. Inverse-function rules

### 9.1 Special values and structural identities — see §1.4, §2 (parity), and §3 (A11–A15).

### 9.2 Series expansion of `Erf^-1(x)` around `x = 0`

Direct DLMF form (7.17.2):

> `inverf(x) = t + (1/3)·t³ + (7/30)·t⁵ + (127/630)·t⁷ + ⋯ = Σ_{m=0}^∞ aₘ · t^(2m+1)`,
> where `t = ½·√π·x`, valid for `|x| < 1`.

Coefficient recursion (DLMF 7.17.2.5):

> `a_{m+1} = (1/(2m+3)) · Σ_{n=0}^m [(2n+1)/(m−n+1)] · aₙ · a_{m−n}`, with `a₀ = 1`.

First few `aₘ`: `1, 1, 7/6, 127/90, 4369/2520, 34807/16200, …`

A consolidated re-statement (Wikipedia / Steinbrecher–Shaw 2008):

> `Erf^-1(z) = Σ_{k=0}^∞ (cₖ / (2k + 1)) · ((√π/2)·z)^(2k+1)` with
> `c₀ = 1`, `cₖ = Σ_{m=0}^{k−1} cₘ · c_{k−1−m} / ((m + 1)(2m + 1))`.

The two formulations agree: `aₘ = cₘ / (2m + 1)` after the variable
change `t = (√π/2)·x`. Use the DLMF form for citation, the
Steinbrecher form for direct coefficient generation.

### 9.3 Asymptotic expansion of `Erfc^-1(x)` for `x → 0⁺`

DLMF 7.17.3:

> `inverfc(x) ∼ u^(−1/2) + a₂ · u^(3/2) + a₃ · u^(5/2) + a₄ · u^(7/2) + ⋯`

where (7.17.4–7.17.6):
- `a₂ = v/8`
- `a₃ = −(v² + 6v − 6)/32`
- `a₄ = (4v³ + 27v² + 108v − 300)/384`
- `u = −2 / ln(π·x² · ln(1/x))`
- `v = ln(ln(1/x)) − 2 + ln π`

(The complementary asymptotic `Erfc^-1(x) → +∞` as `x → 0⁺` is
encoded in §1.4.)

### 9.4 Derivative formulas

Restated from §4 D9–D10 for pattern-table convenience:

- `(Erf^-1)'(x) = (√π / 2) · exp((Erf^-1(x))²)`
- `(Erfc^-1)'(x) = −(√π / 2) · exp((Erfc^-1(x))²)`

### 9.5 Antiderivative

- `∫ Erf^-1(x) dx = ?` — *no closed form in elementary functions.*
  Symbolic CAS engines (Mathematica's `Integrate`) refuse or echo
  the integral. Skip — this is a refusal-class identity for our
  dispatcher.

---

## 10. Branch cuts / domain

### 10.1 Erf, Erfc, Erfi

- `Erf(z)`: **entire function** (no branch cuts). DLMF §7.4 implies
  it by stating the symmetry relation 7.4.1 over all `z ∈ ℂ`.
- `Erfc(z) = 1 − Erf(z)`: entire (algebraic identity preserves
  entirety).
- `Erfi(z) = −i·Erf(iz)`: entire.
- `w(z) = e^(−z²)·Erfc(−iz)`: entire (composition of entire).
- `F(z)`: entire (composition).

**Implication.** No `assuming |ph z| < ...` conditions on the
algebraic identities A1–A8. The *asymptotic series* AS1 carries the
cone `|ph z| < 3π/4`, but the underlying value is well-defined
everywhere — the cone bounds Poincaré asymptoticity, not the
function.

### 10.2 Inverse functions

- `Erf^-1(x)`: the principal branch is the real-analytic odd
  function on `(−1, 1)` defined by `Erf(Erf^-1(x)) = x`. Extension
  to complex `z`:
  - Maclaurin series at `0` converges on `|z| < 1`.
  - Branch points at `z = ±1` (where the principal branch reaches
    `±∞`).
  - Standard branch cut: real axis `(−∞, −1] ∪ [1, ∞)`. Conventions
    vary; SymPy's `erfinv` is real-only by default; Mathematica's
    `InverseErf` follows the principal-branch convention with cuts
    along `(−∞, −1)` and `(1, ∞)`.
- `Erfc^-1(x)`: principal branch real-analytic on `(0, 2)`. Via
  A11 `Erfc^-1(y) = Erf^-1(1 − y)`, the branch structure transfers
  to branch points at `z = 0` and `z = 2`, with cuts on `(−∞, 0]
  ∪ [2, ∞)`.

**Implication for the pattern table.** Inverse-function rules must
carry `conditions: { real_range: "(-1, 1)" }` (or the Erfc analogue)
to avoid silently producing nonsense at branch points. The
substrate's representation today does not have a "domain witness"
type; emit as a `conditions` string field and let downstream consumers
(`cas-simplify`) decide whether to fire.

---

## 11. Pattern-table proposal (TypeScript-ready)

The dispatch shape matches ADR-0025 `ReductionRule` style: a literal
record per identity, citable, machine-readable. The Erf rule table
lives at `packages/cas-core/src/simplify-rules/erf.ts` (proposed).

### 11.1 Helper aliases

```ts
// Imports assumed:
import { expr, int, rat, sym, type Value } from "@workbench/protocol";
import { mkDiv, mkMinus, mkNeg, mkPlus, mkPower, mkTimes }
  from "@workbench/cas-core";

const PI       = sym("pi");
const SQRT_PI  = mkPower(PI, rat(1n, 2n));
const TWO_OVER_SQRT_PI = mkDiv(int(2n), SQRT_PI);   // 2/√π — appears in every derivative
const I_UNIT   = expr("complex", [int(0n), int(1n)]); // i (assuming a complex node)
```

(The complex unit `i` requires either a dedicated node — not in
cas-core's elementary vocab today — or staying inside the
`Erf/Erfi/Erfc` head family. For the v0.1 rules below we restrict to
*real-argument-friendly* identities and the imaginary-argument ones
that fold via head substitution.)

### 11.2 Rule shape (modeled on `ReductionRule` from `dispatch-types.ts`)

```ts
interface ErfRule {
  readonly id: string;                    // "erf-special-zero", etc.
  readonly source: string;                // "DLMF 7.2.1"
  readonly note?: string;                 // free-form
  readonly head: "Erf" | "Erfc" | "Erfi" | "InverseErf" | "InverseErfc";
  readonly match: {
    readonly argPattern: ArgPattern;      // see below
    readonly conditions?: readonly string[];
  };
  readonly rewrite: (bindings: Bindings) => Value;
}

type ArgPattern =
  | { kind: "lit-zero" }                                  // arg is 0
  | { kind: "lit-int";  value: number }                   // arg is a specific integer
  | { kind: "lit-rat";  num: number; den: number }
  | { kind: "lit-pos-infinity" }                          // arg is +∞
  | { kind: "lit-neg-infinity" }                          // arg is −∞
  | { kind: "neg-free"; inner: string }                   // arg is −y for any y; capture y
  | { kind: "i-times-free"; inner: string }               // arg is i·y; capture y
  | { kind: "neg-i-times-free"; inner: string }
  | { kind: "head-call"; head: string; argPattern: ArgPattern } // arg is f(...)
  | { kind: "free"; name: string };                       // any value, capture
```

### 11.3 The rule list

#### Tier 1 — special values (section 1)

```ts
// 1.1 Erf
{ id: "erf-zero",    source: "DLMF 7.2.1", head: "Erf",  match: { argPattern: { kind: "lit-zero" } },           rewrite: () => int(0n) },
{ id: "erf-pinfty",  source: "DLMF 7.2.4", head: "Erf",  match: { argPattern: { kind: "lit-pos-infinity" } },   rewrite: () => int(1n) },
{ id: "erf-ninfty",  source: "DLMF 7.2.4+7.4.1", head: "Erf", match: { argPattern: { kind: "lit-neg-infinity" } }, rewrite: () => int(-1n) },

// 1.2 Erfc
{ id: "erfc-zero",   source: "DLMF 7.2.2+7.2.1", head: "Erfc", match: { argPattern: { kind: "lit-zero" } },        rewrite: () => int(1n) },
{ id: "erfc-pinfty", source: "DLMF 7.2.4", head: "Erfc", match: { argPattern: { kind: "lit-pos-infinity" } },     rewrite: () => int(0n) },
{ id: "erfc-ninfty", source: "DLMF 7.4.2", head: "Erfc", match: { argPattern: { kind: "lit-neg-infinity" } },     rewrite: () => int(2n) },

// 1.3 Erfi
{ id: "erfi-zero",   source: "SymPy:erfi (defn)", head: "Erfi", match: { argPattern: { kind: "lit-zero" } },       rewrite: () => int(0n) },
{ id: "erfi-pinfty", source: "SymPy:erfi", head: "Erfi", match: { argPattern: { kind: "lit-pos-infinity" } },     rewrite: () => expr("complex-infinity", [int(1n), int(0n)]) /* +∞ */ },
{ id: "erfi-ninfty", source: "SymPy:erfi", head: "Erfi", match: { argPattern: { kind: "lit-neg-infinity" } },     rewrite: () => expr("complex-infinity", [int(-1n), int(0n)]) /* −∞ */ },

// 1.4 Inverses
{ id: "inverf-zero",  source: "DLMF 7.17.2", head: "InverseErf",  match: { argPattern: { kind: "lit-zero" } },    rewrite: () => int(0n) },
{ id: "inverf-one",   source: "DLMF 7.17.1+7.2.4", head: "InverseErf", match: { argPattern: { kind: "lit-int", value: 1 } }, rewrite: () => sym("infinity") },
{ id: "inverf-neg-one", source: "Symmetry", head: "InverseErf",   match: { argPattern: { kind: "lit-int", value: -1 } }, rewrite: () => mkNeg(sym("infinity")) },
{ id: "inverfc-zero", source: "DLMF 7.17.1", head: "InverseErfc", match: { argPattern: { kind: "lit-zero" } },    rewrite: () => sym("infinity") },
{ id: "inverfc-one",  source: "DLMF 7.17.1", head: "InverseErfc", match: { argPattern: { kind: "lit-int", value: 1 } }, rewrite: () => int(0n) },
{ id: "inverfc-two",  source: "DLMF 7.17.1", head: "InverseErfc", match: { argPattern: { kind: "lit-int", value: 2 } }, rewrite: () => mkNeg(sym("infinity")) },
```

#### Tier 2 — sign / parity (section 2)

```ts
{ id: "erf-neg-arg",  source: "DLMF 7.4.1", head: "Erf",  match: { argPattern: { kind: "neg-free", inner: "y" } }, rewrite: ({ y }) => mkNeg(expr("Erf",  [y])) },
{ id: "erfi-neg-arg", source: "From A3+7.4.1", head: "Erfi", match: { argPattern: { kind: "neg-free", inner: "y" } }, rewrite: ({ y }) => mkNeg(expr("Erfi", [y])) },
{ id: "erfc-neg-arg", source: "DLMF 7.4.2", head: "Erfc", match: { argPattern: { kind: "neg-free", inner: "y" } }, rewrite: ({ y }) => mkMinus(int(2n), expr("Erfc", [y])) },
{ id: "inverf-neg-arg", source: "SymPy:erfinv", head: "InverseErf", match: { argPattern: { kind: "neg-free", inner: "y" } }, rewrite: ({ y }) => mkNeg(expr("InverseErf", [y])) },
```

#### Tier 3 — interrelations (section 3, A1–A5)

```ts
// A3: Erfi(z) = −i · Erf(iz)  — normalise Erfi to Erf
{ id: "erfi-of-anything",
  source: "A3 / SymPy:erfi (defn)",
  head: "Erfi",
  match: { argPattern: { kind: "free", name: "z" } },
  rewrite: ({ z }) => mkTimes(mkNeg(I_UNIT), expr("Erf", [mkTimes(I_UNIT, z)])) },

// A4: Erf(iz) = i · Erfi(z) — opposite direction, off by default; user may toggle
// (provided for round-trip auditability; do not enable concurrently with A3)
// { id: "erf-of-i-times", source: "A4", head: "Erf", match: { argPattern: { kind: "i-times-free", inner: "y" } }, rewrite: ({ y }) => mkTimes(I_UNIT, expr("Erfi", [y])) },

// A5: Erfc(iz) = 1 + i·Erfi(z)
{ id: "erfc-of-i-times",
  source: "SymPy:erfc rewrite",
  head: "Erfc",
  match: { argPattern: { kind: "i-times-free", inner: "z" } },
  rewrite: ({ z }) => mkPlus([int(1n), mkTimes(I_UNIT, expr("Erfi", [z]))]) },

// A11: Erfc^-1(1 − y) = Erf^-1(y)  — recognise the (1 − y) shape inside InverseErfc
// (left as a deeper-pattern rule; sketch only)
// { id: "inverfc-of-one-minus", source: "SymPy:erfcinv", head: "InverseErfc",
//   match: { argPattern: { kind: "one-minus-free", inner: "y" } },
//   rewrite: ({ y }) => expr("InverseErf", [y]) }
```

#### Tier 4 — incomplete gamma / hypergeometric rewrites (sections 5.1, 5.2)

These fire only when the consumer requests a `rewrite_as_gamma` or
`rewrite_as_hyper` pass — they are *not* canonicalising rules
(they expand, not contract).

```ts
// G1: Erf(z) = (1/√π) · γ(½, z²)
{ id: "erf-as-lower-incomplete-gamma",
  source: "DLMF 7.11.1",
  head: "Erf",
  match: { argPattern: { kind: "free", name: "z" } },
  rewrite: ({ z }) => mkTimes(
    mkDiv(int(1n), SQRT_PI),
    expr("LowerIncompleteGamma", [rat(1n, 2n), mkPower(z, int(2n))]),
  ),
  enabledBy: "rewrite-as-gamma" },

// G2: Erfc(z) = (1/√π) · Γ(½, z²)
{ id: "erfc-as-upper-incomplete-gamma",
  source: "DLMF 7.11.2",
  head: "Erfc",
  match: { argPattern: { kind: "free", name: "z" } },
  rewrite: ({ z }) => mkTimes(
    mkDiv(int(1n), SQRT_PI),
    expr("UpperIncompleteGamma", [rat(1n, 2n), mkPower(z, int(2n))]),
  ),
  enabledBy: "rewrite-as-gamma" },

// H1: Erf(z) = (2z/√π) · M(½, 3/2, −z²)
{ id: "erf-as-1F1",
  source: "DLMF 7.11.4",
  head: "Erf",
  match: { argPattern: { kind: "free", name: "z" } },
  rewrite: ({ z }) => mkTimes(
    mkDiv(mkTimes(int(2n), z), SQRT_PI),
    expr("HypergeometricPFQ", [
      [rat(1n, 2n)],
      [rat(3n, 2n)],
      mkNeg(mkPower(z, int(2n))),
    ]),
  ),
  enabledBy: "rewrite-as-hyper" },

// H3: Erfc(z) = (1/√π) · e^(−z²) · U(½, ½, z²)
{ id: "erfc-as-kummer-U",
  source: "DLMF 7.11.5",
  head: "Erfc",
  match: { argPattern: { kind: "free", name: "z" } },
  rewrite: ({ z }) => mkTimes(
    mkTimes(
      mkDiv(int(1n), SQRT_PI),
      expr("exp", [mkNeg(mkPower(z, int(2n)))]),
    ),
    expr("KummerU", [rat(1n, 2n), rat(1n, 2n), mkPower(z, int(2n))]),
  ),
  enabledBy: "rewrite-as-hyper" },
```

(Note: `LowerIncompleteGamma`, `UpperIncompleteGamma`, `KummerU` are
*not* in the ADR-0023 vocabulary as separate heads — `Gamma` is, but
the incomplete forms are not. A follow-up vocabulary ADR is needed
before these rules can be enabled. The rule shape above is the
target, not v0.1-shippable.)

#### Tier 5 — Fresnel-rewrite path (F2, F3)

```ts
// F2: Erf(z) = (1+i) · (C(arg) − i·S(arg)), arg = (1−i)·z/√π
{ id: "erf-as-fresnel",
  source: "SymPy:erf _eval_rewrite_as_fresnels",
  head: "Erf",
  match: { argPattern: { kind: "free", name: "z" } },
  rewrite: ({ z }) => {
    const arg = mkDiv(mkTimes(mkMinus(int(1n), I_UNIT), z), SQRT_PI);
    return mkTimes(
      mkPlus([int(1n), I_UNIT]),
      mkMinus(expr("FresnelC", [arg]), mkTimes(I_UNIT, expr("FresnelS", [arg]))),
    );
  },
  enabledBy: "rewrite-as-fresnel" },
```

#### Tier 6 — Meijer G dispatch (section 5.6)

Already shipped at `dispatch-rules/dlmf-16-18.ts` (rule
`dlmf-16-18-erf`). The *reverse* direction (collapse `MeijerG` →
`Erf`) is the existing dispatcher's job; no new rule needed here.

#### Tier 7 — series (section 6)

Series identities are *not* pattern-rewrite rules — they're
expansion-on-request operations a separate `series-of` engine
consumes. The pattern table records them as `expand`-tier entries:

```ts
{ id: "erf-maclaurin",
  source: "DLMF 7.6.1",
  head: "Erf",
  match: { argPattern: { kind: "free", name: "z" } },
  series: { variable: "z", expansionPoint: "0",
            generalTerm: ({z, n}) => /* (-1)^n · z^(2n+1) / (n! · (2n+1)) */ ...,
            prefactor: TWO_OVER_SQRT_PI } }
```

(The `series` field is conceptual — out of scope of v0.1 dispatch.
Recorded here so the rule table doesn't lose the citation.)

#### Tier 8 — derivative / antiderivative (mirror of `cas-diff`)

These are already shipped in
`packages/cas-core/src/special-functions.ts` `ruleErf`. The pattern
table redundantly records them so a `cas-simplify`-mediated
"differentiate symbolically" path has a citation.

```ts
{ id: "erf-derivative", source: "DLMF 7.7.1 (deriv of 7.2.1)",
  head: "Erf",
  match: { argPattern: { kind: "free", name: "z" } },
  derivative: ({z}) => mkTimes(TWO_OVER_SQRT_PI, expr("exp", [mkNeg(mkPower(z, int(2n)))])) },
{ id: "erfc-derivative", source: "DLMF 7.7.1 + A1", head: "Erfc",
  match: { argPattern: { kind: "free", name: "z" } },
  derivative: ({z}) => mkNeg(mkTimes(TWO_OVER_SQRT_PI, expr("exp", [mkNeg(mkPower(z, int(2n)))]))) },
{ id: "erfi-derivative", source: "DLMF 7.10 + A3", head: "Erfi",
  match: { argPattern: { kind: "free", name: "z" } },
  derivative: ({z}) => mkTimes(TWO_OVER_SQRT_PI, expr("exp", [mkPower(z, int(2n))])) },
{ id: "inverf-derivative", source: "SymPy:erfinv", head: "InverseErf",
  match: { argPattern: { kind: "free", name: "x" } },
  derivative: ({x}) => mkTimes(
    mkDiv(SQRT_PI, int(2n)),
    expr("exp", [mkPower(expr("InverseErf", [x]), int(2n))])) },
{ id: "inverfc-derivative", source: "SymPy:erfcinv", head: "InverseErfc",
  match: { argPattern: { kind: "free", name: "x" } },
  derivative: ({x}) => mkNeg(mkTimes(
    mkDiv(SQRT_PI, int(2n)),
    expr("exp", [mkPower(expr("InverseErfc", [x]), int(2n))]))) },
{ id: "erf-antiderivative", source: "Wiki:erf",
  head: "Erf",
  match: { argPattern: { kind: "free", name: "z" } },
  antiderivative: ({z}) => mkPlus([
    mkTimes(z, expr("Erf", [z])),
    mkDiv(expr("exp", [mkNeg(mkPower(z, int(2n)))]), SQRT_PI),
  ]) },
```

### 11.4 Refusal class

The pattern table also encodes *negative facts* — these are not
rewrite rules but boundary-tag emitters. Honest scope; see Add1/Mul1.

```ts
{ id: "erf-no-addition-theorem",
  source: "Wiki:erf (explicit absence)",
  head: "Erf",
  match: { argPattern: { kind: "head-call", head: "+", argPattern: { kind: "free", name: "args" } } },
  refuse: { tag: "cas-simplify/erf-no-addition-theorem",
            reason: "Erf has no closed-form addition theorem; argument is a sum." } }
```

### 11.5 Total rule count

| Tier | Rules | Notes |
|---|---:|---|
| 1 — Special values | 15 | Erf/Erfc/Erfi × {0, ±∞}; inverses × {0, ±1, 2} |
| 2 — Sign / parity | 4 | The four parity rules |
| 3 — Interrelations | 3 (active) + 2 (provided, off) | A3/A5/A11 canonicalisations |
| 4 — Gamma / hyper rewrites | 4 | Conditional on `rewrite-as-X` flag |
| 5 — Fresnel rewrites | 1 | Conditional |
| 6 — MeijerG | (shipped elsewhere) | reference back to `dlmf-16-18.ts` |
| 7 — Series | 5 (citations) | Not rewrite rules; `series` field |
| 8 — Derivatives / antideriv | 6 | Already shipped in `cas-diff`; redundant cite |
| 9 — Refusals | 1+ | Honest-scope boundary tags |

**~38 rules total**, of which ~22 are v0.1-shippable inside the
current `cas-core` vocabulary; the rest require either (a) a new
vocabulary head (incomplete-gamma, `KummerU`, `complex`) or (b) the
`series`/`derivative`/`antiderivative` field extensions to the rule
shape.

---

## 12. Contradictions / divergences

The cross-source pass found a small number of genuine divergences.
Documenting so a future agent doesn't relitigate.

1. **Wolfram Functions site unreachable.** All `functions.wolfram.com/
   GammaBetaErf/{Erf,Erfc,Erfi,InverseErf,InverseErfc}/` URLs returned
   HTTP 403 during this pass. The Wolfram identities are recovered
   through DLMF + SymPy + the Wikipedia consolidated article. A
   future pull (perhaps via a Wolfram-licensed mirror) should add
   Wolfram formula-IDs (e.g., `06.27.16.0001.01`) for the rules where
   they would add audit value. None of the *substance* below should
   change.

2. **`Erfc(±i·∞)` sign convention.** SymPy reports `Erfc(I·∞) =
   −I·∞`, deriving from `Erfc(z) = 1 − Erf(z)` and `Erf(I·∞) = I·∞`.
   The DLMF reports the asymptotic `Erfc(z) ∼ e^(−z²)/(z·√π)` with
   the cone `|ph z| < 3π/4`; at `ph z = π/2` the asymptotic is *on
   the boundary* of validity, so the "infinite-direction" limit is
   not directly stated. SymPy's value is consistent with continuity
   along the imaginary axis from below; treat it as the canonical
   answer.

3. **Inverse-function series coefficients — `aₘ` vs `cₘ`.** DLMF
   7.17.2 uses `aₘ` with `t = (√π/2)·x`; Wikipedia / Steinbrecher
   use `cₘ` with the entire `(√π/2)·x` raised to the
   `(2k+1)`. The conversion `aₘ = cₘ / (2m + 1)` resolves the
   apparent disagreement. Cite **DLMF 7.17.2** in the rule table —
   the recursion in 7.17.2.5 is the authoritative form.

4. **`Erfi` parity over the imaginary axis.** Some texts state
   `Erfi(i·x) = i·Erf(x)` *with no sign issue* (correct: A3 inverted
   yields exactly this). Others restate via `Erf(i·x) = i·Erfi(x)`.
   These are the same identity; the apparent disagreement is just
   which side of A3 / A4 the author writes first. No real conflict.

5. **`Erf2(x, y)` ordering.** SymPy's `Erf2(x, y) = Erf(y) − Erf(x)`
   convention is *not* universal — some sources reverse the
   arguments. If a future bead admits `Erf2` to the vocabulary, pin
   SymPy's convention explicitly in the ADR and the README.

6. **Repeated-integral notation.** Three notations co-exist for the
   "repeated complementary error function":
   - DLMF: `iⁿerfc(z)` (script `i` superscript)
   - SymPy: `erfc(z, n)` (would-be — SymPy does not currently
     name this; computes via Hermite)
   - Mathematica: `Erfc[n, z]`
   The DLMF spelling is the workbench's canonical form. Should this
   head ever be admitted to the vocabulary, prefer `RepeatedErfc(n,
   z)` as the head name for readability.

---

## 13. Pointer trail

- This artefact: `/home/tobias/Projects/scientist-workbench/docs/refs/erf-research/R1-symbolic-identities.md`
- ADR-0023 (vocabulary discipline): `/home/tobias/Projects/scientist-workbench/docs/adr/0023-cas-core-special-function-vocabulary.md`
- ADR-0025 (dispatch shape): `/home/tobias/Projects/scientist-workbench/docs/adr/0025-meijerg-symbolic-dispatch.md`
- Current Erf vocabulary handling (`ruleErf`): `/home/tobias/Projects/scientist-workbench/packages/cas-core/src/special-functions.ts:418-432`
- Existing MeijerG → Erf reduction: `/home/tobias/Projects/scientist-workbench/packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts:118-134`
- `cas-simplify` engine: `/home/tobias/Projects/scientist-workbench/packages/cas-core/src/simplify.ts`

---

*End of R1.*
