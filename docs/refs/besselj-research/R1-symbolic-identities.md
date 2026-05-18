# R1 — Canonical Symbolic Identities for the Bessel Family
## `BesselJ`, `BesselY`, `BesselI`, `BesselK` (with `HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY` boundary)

**Bead:** `scientist-workbench-cela` (Phase 0 / R1 — symbolic identities). Parent
epic: `scientist-workbench-zcam` (world-class Bessel reference implementation,
the second per-head substrate prototype after Erf — see ADR-0040 and
`docs/HANDOFF_per_head_special_function_methodology.md`).
**Author:** deep-research subagent, 2026-05-17.
**Status:** Research artefact. Not a source-of-truth; cite the primary
references when porting any identity into a rule file. Direct downstream
consumers: ADR-0041 (the per-head substrate ADR for Bessel, to be drafted by
the orchestrator from this artefact plus R2–R5), then
`packages/cas-core/src/special-funcs/bessel-identities.ts` (the rule table
this artefact specifies, target ≈30 v0.1-shippable rules), then
`packages/cas-core/src/simplify.ts` (the wiring layer that admits Bessel-family
rewrites to the `casSimplify` pipeline alongside the existing
`applyErfRewrites` pre-pass).

**Scope.** Exhaustive pattern table of *symbolic* identities — pattern shapes
suitable for dispatch in a CAS pattern rewriter — for the four heads already
admitted to ADR-0023's vocabulary (`BesselJ`, `BesselY`, `BesselI`,
`BesselK`), with a clearly-bounded "boundary" treatment of the *related* heads
(`HankelH1`, `HankelH2`, the four spherical Bessel families) that this
artefact recommends for vocabulary admission. The 12 identity classes
mandated by the bead prompt — recurrences, half-integer-ν closed forms,
integer-ν parity, Wronskians, inter-family bridges, integer-ν special cases,
derivatives, addition theorems, integral representations, ODE invariants,
asymptotic-equality identities, limit/value identities — are each addressed
as a numbered section.

**Notation.**
- `z`, `w`: complex variables. Conditions per identity.
- `ν`, `μ`: complex orders. `n`, `m`, `k` denote (non-negative) integers
  unless stated otherwise.
- `J_ν(z)`, `Y_ν(z)`, `I_ν(z)`, `K_ν(z)`: the cylinder Bessel of the first
  and second kinds and their modified counterparts, principal branches per
  DLMF §10.2 / §10.25.
- `H^{(1)}_ν(z)`, `H^{(2)}_ν(z)`: Hankel functions, principal branches per
  DLMF §10.2(ii).
- `j_n(z)`, `y_n(z)`, `h^{(1)}_n(z)`, `h^{(2)}_n(z)`: spherical Bessel,
  `i^{(1)}_n`, `i^{(2)}_n`, `k_n`: modified spherical Bessel, all per
  DLMF §10.47, with `n ∈ ℤ_{≥0}` (DLMF restricts to non-negative integer
  order — the A&S convention extending to negative `n` is *not* DLMF's).
- `C_ν(z)`: a cylinder function — DLMF's umbrella symbol denoting any of
  `J_ν`, `Y_ν`, `H^{(1)}_ν`, `H^{(2)}_ν`, or a nontrivial linear
  combination with coefficients independent of `z` and `ν` (DLMF §10.2(ii)).
- `Z_ν(z)`: a modified cylinder function — `I_ν`, `e^{ν π i} K_ν`, or a
  nontrivial linear combination (DLMF §10.25(ii)).
- `Γ(z)`: gamma; `ψ(z)`: digamma; `C^{(λ)}_k(x)`: Gegenbauer polynomial.
- `M(a, b, z) ≡ ₁F₁(a; b; z)`: Kummer confluent hypergeometric (first kind).
- `U(a, b, z)`: Tricomi confluent hypergeometric (second kind).
- `M_{κ, μ}(z)`, `W_{κ, μ}(z)`: Whittaker functions.
- `W{f, g} = f g' − f' g`: Wronskian, sign convention per DLMF (1.13.5).

**Source priority (when sources disagree).**
DLMF > NIST Handbook (Olver et al., 2010, same numbering as DLMF) > SymPy >
mpmath > Wikipedia > Wolfram Functions. Wolfram Functions URLs returned
HTTP 403 during this pass (consistent with the Erf R1 observation in
`docs/refs/erf-research/R1-symbolic-identities.md` §0), so where Wolfram's
catalogue would normally provide an additional formula-ID, the rule is
cited against the equivalent DLMF / SymPy form instead. Watson's 1944
*A Treatise on the Theory of Bessel Functions* — universally cited by
DLMF in chapter 10 — returned HTTP 403 from archive.org during the pass
(`treatiseontheory0000wats.pdf`), so DLMF's own "see Watson (1944, pp.
…)" citations are quoted-through-DLMF rather than verified line-by-line
against Watson. None of the *substance* below depends on Watson; he is
named as the historical source DLMF cites, not as primary truth.

---

## 0. Source manifest

Files live under
`/home/tobias/Projects/scientist-workbench/docs/refs/besselj-research/sources/symbolic/`.
Every rule entry cites the primary source by short tag; the tag resolves to a
local file via this table.

| Tag | Source | URL | Local path |
|---|---|---|---|
| `DLMF §10.X.Y` | NIST Digital Library of Mathematical Functions, Ch. 10 (F. W. J. Olver & L. C. Maximon, eds.) | https://dlmf.nist.gov/10.X | `sources/symbolic/dlmf-10.X.html` (+ extracted `.txt`) |
| `Olver et al. §10.X.Y` | NIST Handbook of Mathematical Functions (CUP 2010) | textbook, same numbering as DLMF | not on disk; identical content to DLMF |
| `SymPy:besselj` etc. | `sympy/functions/special/bessel.py` master branch | https://raw.githubusercontent.com/sympy/sympy/master/sympy/functions/special/bessel.py | `sources/symbolic/sympy-bessel.py` |
| `mpmath:besselj` etc. | `mpmath/functions/bessel.py` master branch | https://raw.githubusercontent.com/mpmath/mpmath/master/mpmath/functions/bessel.py | `sources/symbolic/mpmath-bessel.py` |
| `Wiki:Bessel` | Wikipedia "Bessel function" | https://en.wikipedia.org/wiki/Bessel_function | `sources/symbolic/wiki-bessel.html` |
| `Wiki:ModifiedBessel` | Wikipedia "Modified Bessel function" | https://en.wikipedia.org/wiki/Modified_Bessel_function | `sources/symbolic/wiki-modified-bessel.html` |
| `Watson 1944, p. X` | G. N. Watson, *A Treatise on the Theory of Bessel Functions*, CUP 1944 | https://archive.org/download/treatiseontheory0000wats/treatiseontheory0000wats.pdf | **NOT on disk — HTTP 403 from archive.org during this pass.** Quoted via DLMF citations. |
| `A&S Ref X.Y.Z` | Abramowitz & Stegun, *Handbook of Mathematical Functions*, NBS 1964 | DLMF cross-references it inline per equation | image-based scans at personal.math.ubc.ca only; not text-extractable; trusted via DLMF's `A&S Ref:` cross-reference field |
| `Wolfram FunctionsSite` | functions.wolfram.com/Bessel-TypeFunctions/* | https://functions.wolfram.com/... | **HTTP 403 during this pass — confirmed unreliable across multiple campaigns (cf. Erf R1 §0). Cited only when SymPy's `_eval_rewrite_as_*` methods quote a Wolfram formula-ID directly.** |

DLMF section coverage downloaded:
§§10.2 (definitions, Bessel ODE), 10.4 (connection formulas, integer-ν
parities, Hankel decomposition), 10.5 (Wronskians), 10.6 (recurrences and
derivatives), 10.7 (limiting forms at 0 and ∞), 10.9 (integral
representations), 10.16 (relations to other functions — half-integer
closures, M / U / W reductions, ₀F₁), 10.17 (asymptotic for large
argument — Hankel's expansions), 10.19 (asymptotic for large order),
10.20 (uniform asymptotic for large order — Olver's complete uniform
expansion), 10.21 (zeros), 10.23 (sums — addition theorems, including
Graf and Gegenbauer), 10.25 (modified Bessel ODE), 10.27 (modified
Bessel connection formulas — `I` ↔ `K` parities, `J` / `I` bridge),
10.28 (modified Wronskians), 10.29 (modified recurrences + derivatives),
10.30 (modified limiting forms), 10.32 (modified integral
representations), 10.38 (derivatives with respect to order of `I`, `K`),
10.44 (modified sums — Neumann, Graf, Gegenbauer), 10.47 (spherical
Bessel definitions), 10.48 (spherical Bessel graphs — pictures only;
included for completeness), 10.49 (spherical Bessel explicit formulas),
10.50 (spherical Wronskians and cross-products).

---

## 1. Recurrence relations (DLMF §§10.6, 10.29)

The two recurrences are the *load-bearing* identities for any Bessel
reference implementation: every closed-form half-integer ladder, every
parameter-bumping integration, every `Y_n` ↔ `Y_{n±2}` chain in the
modified-Bessel asymptotic improvement uses them.

### 1.1 Cylinder Bessel `J`, `Y`, `H^{(1)}`, `H^{(2)}` — DLMF 10.6.1

For any cylinder function `C_ν(z)`:

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `bessel-rec-three-term` | `C_{ν−1}(z) + C_{ν+1}(z)` | `(2ν / z) · C_ν(z)` | `C ∈ {J, Y, H^{(1)}, H^{(2)}}` | DLMF 10.6.1 (first) | https://dlmf.nist.gov/10.6.E1 |
| `bessel-rec-deriv-symmetric` | `C_{ν−1}(z) − C_{ν+1}(z)` | `2 · C′_ν(z)` | `C ∈ {J, Y, H^{(1)}, H^{(2)}}` | DLMF 10.6.1 (second) | https://dlmf.nist.gov/10.6.E1 |
| `bessel-rec-deriv-down` | `C′_ν(z)` | `C_{ν−1}(z) − (ν / z) · C_ν(z)` | `C ∈ {J, Y, H^{(1)}, H^{(2)}}` | DLMF 10.6.2 (first) | https://dlmf.nist.gov/10.6.E2 |
| `bessel-rec-deriv-up` | `C′_ν(z)` | `−C_{ν+1}(z) + (ν / z) · C_ν(z)` | `C ∈ {J, Y, H^{(1)}, H^{(2)}}` | DLMF 10.6.2 (second) | https://dlmf.nist.gov/10.6.E2 |
| `bessel-deriv-zero` | `J′_0(z)` | `−J_1(z)` | (special case of `bessel-rec-deriv-up` at `ν = 0`) | DLMF 10.6.3 | https://dlmf.nist.gov/10.6.E3 |
| `bessely-deriv-zero` | `Y′_0(z)` | `−Y_1(z)` | (special case) | DLMF 10.6.3 | https://dlmf.nist.gov/10.6.E3 |

**Implementation note.** The current `ruleBesselFirstKind` /
`ruleBesselI` / `ruleBesselK` in
`packages/cas-core/src/special-functions.ts:539-611` ships the *symmetric*
derivative form (DLMF 10.6.1 second; the average of 10.6.2 first and
10.6.2 second): `d/dz J_ν(z) = (J_{ν−1}(z) − J_{ν+1}(z)) / 2`. This is
the canonical CAS-output choice because it stays symmetric in the
neighbouring orders and (unlike `J_{ν−1} − (ν/z) J_ν`) does not introduce
a `1/z` factor that would risk a spurious removable singularity at
`z = 0` after foreign-pass-through. **Do not change the cas-diff output
shape** in any v0.1 rule-table work; the symmetric form is the one
downstream consumers (`integrate-1d`, `eval-numeric-expr`) have been
verified against.

**Higher-order derivative ladder.** DLMF 10.6.6 gives the closed-form
descent / ascent ladder

```
(1/z · d/dz)^k (z^ν · C_ν(z)) = z^{ν − k} · C_{ν − k}(z)
(1/z · d/dz)^k (z^{−ν} · C_ν(z)) = (−1)^k · z^{−ν − k} · C_{ν + k}(z)
```
(DLMF 10.6.6) — useful as a *rewrite-on-request* rule, not a canonical
simplifier. The k-th derivative formula
```
C^{(k)}_ν(z) = (1/2^k) · Σ_{n=0}^{k} (−1)^n · C(k, n) · C_{ν − k + 2n}(z)
```
(DLMF 10.6.7) is the binomial-sum form that expands `d^k/dz^k J_ν(z)`
into a linear combination of `J_{ν−k}, J_{ν−k+2}, …, J_{ν+k}`. For our
purposes (single-step diff in `cas-diff`) the symmetric 10.6.1-second
form is enough; the binomial sum belongs in a future `series-expand`
companion engine.

### 1.2 Modified Bessel `I`, `K` — DLMF 10.29.1

For any modified cylinder function `Z_ν(z)` (i.e. `I_ν`, `e^{νπi}·K_ν`,
or a non-trivial linear combination):

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `mbessel-rec-three-term` | `Z_{ν−1}(z) − Z_{ν+1}(z)` | `(2ν / z) · Z_ν(z)` | `Z ∈ {I, e^{νπi}·K}` | DLMF 10.29.1 (first) | https://dlmf.nist.gov/10.29.E1 |
| `mbessel-rec-deriv-symmetric` | `Z_{ν−1}(z) + Z_{ν+1}(z)` | `2 · Z′_ν(z)` | `Z ∈ {I, e^{νπi}·K}` | DLMF 10.29.1 (second) | https://dlmf.nist.gov/10.29.E1 |
| `mbessel-rec-deriv-down` | `Z′_ν(z)` | `Z_{ν−1}(z) − (ν / z) · Z_ν(z)` | `Z ∈ {I, e^{νπi}·K}` | DLMF 10.29.2 (first) | https://dlmf.nist.gov/10.29.E2 |
| `mbessel-rec-deriv-up` | `Z′_ν(z)` | `Z_{ν+1}(z) + (ν / z) · Z_ν(z)` | `Z ∈ {I, e^{νπi}·K}` | DLMF 10.29.2 (second) | https://dlmf.nist.gov/10.29.E2 |
| `besseli-deriv-zero` | `I′_0(z)` | `I_1(z)` | (special case of derivative-down at `ν = 0`) | DLMF 10.29.3 (first) | https://dlmf.nist.gov/10.29.E3 |
| `besselk-deriv-zero` | `K′_0(z)` | `−K_1(z)` | (special case) | DLMF 10.29.3 (second) | https://dlmf.nist.gov/10.29.E3 |

**Sign-pattern trap.** Cylinder `C` has `C_{ν−1} + C_{ν+1} = (2ν/z) C_ν`
and `C_{ν−1} − C_{ν+1} = 2 C′_ν`. Modified `Z` swaps the signs:
`Z_{ν−1} − Z_{ν+1} = (2ν/z) Z_ν` and `Z_{ν−1} + Z_{ν+1} = 2 Z′_ν`. The
cas-core diff implementation already encodes the correct sign convention
(`ruleBesselI` emits `(I_{ν−1} + I_{ν+1})/2`, `ruleBesselK` emits the
negation per DLMF 10.27.4's `K = (π/2)·(I_{-ν} − I_ν)/sin(νπ)` derived
sign). A new rule-table author **must** consult `special-functions.ts:
564-611` before adding a recurrence to confirm the canonical-output sign
matches what `cas-diff` already emits.

### 1.3 Spherical Bessel recurrences — DLMF §10.51 (deferred)

DLMF §10.51 supplies the spherical-Bessel recurrence — analogous to
10.6 with the substitution `C_{ν} → f_n` where `f_n = j_n, y_n,
h^{(1)}_n, h^{(2)}_n`:
```
f_{n−1}(z) + f_{n+1}(z) = ((2n + 1) / z) · f_n(z)
n · f_{n−1}(z) − (n + 1) · f_{n+1}(z) = (2n + 1) · f′_n(z)
```
**v0.1 disposition.** Deferred — spherical Bessel is not in the
ADR-0023 vocabulary today. See §13 ("Vocabulary expansion
recommendations") for the case to admit. Until then, any input
containing `SphericalBesselJ(n, z)` is foreign-pass-through.

---

## 2. Half-integer-ν closed forms (DLMF §§10.16, 10.47–10.49)

These are the *load-bearing closure rules* the spherical-Bessel "ladder"
implementations depend on, and the primary motivator for admitting
`SphericalBesselJ` to the cas-core vocabulary (§13 Discovery A).

### 2.1 Elementary half-integer closures — DLMF 10.16.1

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besselj-half` | `J_{1/2}(z)` | `√(2 / (π z)) · sin(z)` | `z ∉ (−∞, 0]` (principal branch) | DLMF 10.16.1 (first) | https://dlmf.nist.gov/10.16.E1 |
| `besselj-neg-half` | `J_{−1/2}(z)` | `√(2 / (π z)) · cos(z)` | `z ∉ (−∞, 0]` | DLMF 10.16.1 (second) | https://dlmf.nist.gov/10.16.E1 |
| `bessely-half` | `Y_{1/2}(z)` | `−√(2 / (π z)) · cos(z)` | `z ∉ (−∞, 0]` | DLMF 10.16.1 (second, via `J_{−1/2} = −Y_{1/2}`) | https://dlmf.nist.gov/10.16.E1 |
| `bessely-neg-half` | `Y_{−1/2}(z)` | `√(2 / (π z)) · sin(z)` | `z ∉ (−∞, 0]` (via `Y_{−1/2} = J_{1/2}`) | DLMF 10.16.1 (first) | https://dlmf.nist.gov/10.16.E1 |
| `hankel1-half` | `H^{(1)}_{1/2}(z)` | `−i · √(2 / (π z)) · e^{i z}` | `z ∉ (−∞, 0]` | DLMF 10.16.2 (first) | https://dlmf.nist.gov/10.16.E2 |
| `hankel2-half` | `H^{(2)}_{1/2}(z)` | `i · √(2 / (π z)) · e^{−i z}` | `z ∉ (−∞, 0]` | DLMF 10.16.2 (second) | https://dlmf.nist.gov/10.16.E2 |
| `hankel1-neg-half` | `H^{(1)}_{−1/2}(z)` | `√(2 / (π z)) · e^{i z}` | (via `H^{(1)}_{1/2} = −i · H^{(1)}_{−1/2}`) | DLMF 10.16.2 | https://dlmf.nist.gov/10.16.E2 |
| `hankel2-neg-half` | `H^{(2)}_{−1/2}(z)` | `√(2 / (π z)) · e^{−i z}` | analogously | DLMF 10.16.2 | https://dlmf.nist.gov/10.16.E2 |

### 2.2 Modified half-integer closures (analogously derived; DLMF §10.47(ii))

These are derived by the bridge `I_ν(z) = i^{−ν} · J_ν(i z)` (DLMF
10.27.6) applied to 10.16.1:

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besseli-half` | `I_{1/2}(z)` | `√(2 / (π z)) · sinh(z)` | `z ∉ (−∞, 0]` | derived from DLMF 10.16.1 + 10.27.6 | https://dlmf.nist.gov/10.27.E6 |
| `besseli-neg-half` | `I_{−1/2}(z)` | `√(2 / (π z)) · cosh(z)` | `z ∉ (−∞, 0]` | analogously | https://dlmf.nist.gov/10.27.E6 |
| `besselk-half` | `K_{1/2}(z)` | `√(π / (2 z)) · e^{−z}` | `z ∉ (−∞, 0]` | DLMF 10.47.9 + 10.16.2 chain | https://dlmf.nist.gov/10.47.E9 |
| `besselk-neg-half` | `K_{−1/2}(z)` | `√(π / (2 z)) · e^{−z}` | by parity `K_{−ν} = K_ν` (DLMF 10.27.3) | https://dlmf.nist.gov/10.27.E3 |

### 2.3 Spherical-Bessel definitions — DLMF 10.47.3–10.47.9 (the bridge to half-integer ν)

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `sph-j-defn` | `j_n(z)` | `√(π / (2 z)) · J_{n + 1/2}(z)` | `n ∈ ℤ_{≥0}` | DLMF 10.47.3 | https://dlmf.nist.gov/10.47.E3 |
| `sph-y-defn` | `y_n(z)` | `√(π / (2 z)) · Y_{n + 1/2}(z)` | `n ∈ ℤ_{≥0}` | DLMF 10.47.4 | https://dlmf.nist.gov/10.47.E4 |
| `sph-h1-defn` | `h^{(1)}_n(z)` | `√(π / (2 z)) · H^{(1)}_{n + 1/2}(z)` | `n ∈ ℤ_{≥0}` | DLMF 10.47.5 | https://dlmf.nist.gov/10.47.E5 |
| `sph-h2-defn` | `h^{(2)}_n(z)` | `√(π / (2 z)) · H^{(2)}_{n + 1/2}(z)` | `n ∈ ℤ_{≥0}` | DLMF 10.47.6 | https://dlmf.nist.gov/10.47.E6 |
| `sph-i1-defn` | `i^{(1)}_n(z)` | `√(π / (2 z)) · I_{n + 1/2}(z)` | `n ∈ ℤ_{≥0}` | DLMF 10.47.7 | https://dlmf.nist.gov/10.47.E7 |
| `sph-i2-defn` | `i^{(2)}_n(z)` | `√(π / (2 z)) · I_{−n − 1/2}(z)` | `n ∈ ℤ_{≥0}` | DLMF 10.47.8 | https://dlmf.nist.gov/10.47.E8 |
| `sph-k-defn` | `k_n(z)` | `√(π / (2 z)) · K_{n + 1/2}(z)` | `n ∈ ℤ_{≥0}` (note `k_n = k_{−n − 1}` by `K_{−ν} = K_ν`) | DLMF 10.47.9 | https://dlmf.nist.gov/10.47.E9 |

### 2.4 Closed-form ladder for `j_n`, `y_n` at small `n` — DLMF 10.49.3, 10.49.5

DLMF 10.49.2 / 10.49.4 give the general closed form in terms of
trigonometric polynomials in `1/z`. The small-`n` cases (which are the
*useful* ones for a v0.1 simplifier):

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `sph-j0` | `j_0(z)` | `sin(z) / z` | `z ≠ 0` | DLMF 10.49.3 (first) | https://dlmf.nist.gov/10.49.E3 |
| `sph-j1` | `j_1(z)` | `sin(z) / z² − cos(z) / z` | `z ≠ 0` | DLMF 10.49.3 (second) | https://dlmf.nist.gov/10.49.E3 |
| `sph-j2` | `j_2(z)` | `(−1/z + 3/z³) · sin(z) − (3/z²) · cos(z)` | `z ≠ 0` | DLMF 10.49.3 (third) | https://dlmf.nist.gov/10.49.E3 |
| `sph-y0` | `y_0(z)` | `−cos(z) / z` | `z ≠ 0` | DLMF 10.49.5 (analogue) | https://dlmf.nist.gov/10.49.E5 |
| `sph-y1` | `y_1(z)` | `−cos(z) / z² − sin(z) / z` | `z ≠ 0` | DLMF 10.49.5 (analogue) | https://dlmf.nist.gov/10.49.E5 |

**Rayleigh's formula** (DLMF 10.49.13) supplies the general
operator-rep:
```
j_n(z) = (−z)^n · (1/z · d/dz)^n (sin z / z)
y_n(z) = −(−z)^n · (1/z · d/dz)^n (cos z / z)
```
A *rewrite-on-request* rule, not a canonical simplifier (it spawns `n+1`
nested derivatives — the small-`n` explicit forms in the table above
collapse cleanly, the operator form should be avoided in
v0.1 canonicalisation).

### 2.5 The `j_n` exhaustion principle

A v0.1 simplifier with the spherical-Bessel vocabulary admitted should
fire `sph-j0` through `sph-j2` (and modified `i^{(1)}_0 = sinh z / z`,
etc.) on literal-integer `n`. For symbolic `n`, the spherical Bessel
stays in the AST. This is the same "named-cases-up-to-K, symbolic
otherwise" pattern the existing `LaguerreL(n, z)` and `HermiteH(n, z)`
treatment in cas-core already uses for the orthogonal polynomial heads.

---

## 3. Integer-ν parity (DLMF §§10.4, 10.27)

These rules normalise *integer-order Bessel* with a sign-flipped order.
Per the discussion in §15 (canonicalisation conflicts), `J_{−n}` for
integer `n` always canonicalises down to `J_n` modulo `(−1)^n`; the
fact that `J_{−ν}` for *non-integer* `ν` is a *linearly independent
solution* of Bessel's ODE (DLMF §10.4 opening; "Other solutions of
(10.2.1) include `J_{−ν}(z)`, ...") means the rule fires *only* when
`ν` is a literal integer.

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besselj-neg-integer-order` | `J_{−n}(z)` | `(−1)^n · J_n(z)` | `n ∈ ℤ` | DLMF 10.4.1 (first) | https://dlmf.nist.gov/10.4.E1 |
| `bessely-neg-integer-order` | `Y_{−n}(z)` | `(−1)^n · Y_n(z)` | `n ∈ ℤ` | DLMF 10.4.1 (second) | https://dlmf.nist.gov/10.4.E1 |
| `hankel1-neg-integer-order` | `H^{(1)}_{−n}(z)` | `(−1)^n · H^{(1)}_n(z)` | `n ∈ ℤ` | DLMF 10.4.2 (first) | https://dlmf.nist.gov/10.4.E2 |
| `hankel2-neg-integer-order` | `H^{(2)}_{−n}(z)` | `(−1)^n · H^{(2)}_n(z)` | `n ∈ ℤ` | DLMF 10.4.2 (second) | https://dlmf.nist.gov/10.4.E2 |
| `besseli-neg-integer-order` | `I_{−n}(z)` | `I_n(z)` | `n ∈ ℤ` (no sign — `I` is invariant) | DLMF 10.27.1 | https://dlmf.nist.gov/10.27.E1 |
| `besselk-neg-order` | `K_{−ν}(z)` | `K_ν(z)` | `ν ∈ ℂ` (the rare *unconditional* parity) | DLMF 10.27.3 | https://dlmf.nist.gov/10.27.E3 |

**Crucial asymmetry — flag for ADR-0041.** `K_{−ν} = K_ν` holds for
*all* `ν` (DLMF 10.27.3, no condition), but `I_{−n} = I_n` only when
`n` is a *literal integer* (DLMF 10.27.1); for general `ν`,
`I_{−ν}(z) = I_ν(z) + (2/π) · sin(νπ) · K_ν(z)` (DLMF 10.27.2). The
canonicalisation conflict is documented in §15. SymPy's classmethod
`besselj.eval` (`sympy-bessel.py:180-213`) shows the working-CAS
discipline: it only rewrites `J_{−n}` for integer `n` (checks
`nu.is_integer and nu.could_extract_minus_sign()`), leaves
non-integer-order signed-negative Bessel inputs in the AST.

### 3.1 Connection formulas for non-integer ν (DLMF 10.4.5, 10.4.7, 10.4.8)

For non-integer `ν`, the related identities express `J_ν` in terms of
`Y_{±ν}`:

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besselj-from-Y-conn` | `J_ν(z)` | `csc(ν π) · (Y_{−ν}(z) − Y_ν(z) · cos(ν π))` | `ν ∉ ℤ` | DLMF 10.4.5 | https://dlmf.nist.gov/10.4.E5 |
| `hankel1-from-J-conn` | `H^{(1)}_ν(z)` | `i · csc(ν π) · (e^{−ν π i} · J_ν(z) − J_{−ν}(z))` | `ν ∉ ℤ` | DLMF 10.4.7 (first) | https://dlmf.nist.gov/10.4.E7 |
| `hankel2-from-J-conn` | `H^{(2)}_ν(z)` | `i · csc(ν π) · (J_{−ν}(z) − e^{ν π i} · J_ν(z))` | `ν ∉ ℤ` | DLMF 10.4.8 (first) | https://dlmf.nist.gov/10.4.E8 |
| `bessely-from-J-defn` | `Y_ν(z)` | `(J_ν(z) · cos(ν π) − J_{−ν}(z)) / sin(ν π)` | `ν ∉ ℤ` | DLMF 10.2.3 | https://dlmf.nist.gov/10.2.E3 |

These are **rewrite-on-request** identities, not canonicalisers — they
expand a single-head input into a more complex shape. Useful for the
`rewrite-as-J` / `rewrite-as-Y` flag families analogous to Erf R1's
`rewrite-as-gamma` / `rewrite-as-hyper` tiers.

---

## 4. Wronskians (DLMF §§10.5, 10.28)

Wronskians collapse to constants — they're cas-simplify *gold* (a sum
of two Bessel-bilinear terms reduces to a single rational expression).
The dispatcher fires on `+`-headed expressions whose two summands match
the Wronskian template; emits the closed-form value.

### 4.1 Cylinder Wronskians — DLMF 10.5

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `wronskian-J-Jneg` | `J_{ν+1}(z) · J_{−ν}(z) + J_ν(z) · J_{−ν−1}(z)` | `−2 sin(ν π) / (π z)` | `ν ∉ ℤ` | DLMF 10.5.1 | https://dlmf.nist.gov/10.5.E1 |
| `wronskian-J-Y` | `J_{ν+1}(z) · Y_ν(z) − J_ν(z) · Y_{ν+1}(z)` | `2 / (π z)` | (none) | DLMF 10.5.2 | https://dlmf.nist.gov/10.5.E2 |
| `wronskian-J-H1` | `J_{ν+1}(z) · H^{(1)}_ν(z) − J_ν(z) · H^{(1)}_{ν+1}(z)` | `2 i / (π z)` | (none) | DLMF 10.5.3 | https://dlmf.nist.gov/10.5.E3 |
| `wronskian-J-H2` | `J_{ν+1}(z) · H^{(2)}_ν(z) − J_ν(z) · H^{(2)}_{ν+1}(z)` | `−2 i / (π z)` | (none) | DLMF 10.5.4 | https://dlmf.nist.gov/10.5.E4 |
| `wronskian-H1-H2` | `H^{(1)}_{ν+1}(z) · H^{(2)}_ν(z) − H^{(1)}_ν(z) · H^{(2)}_{ν+1}(z)` | `−4 i / (π z)` | (none) | DLMF 10.5.5 | https://dlmf.nist.gov/10.5.E5 |

The two-term Wronskian identity that the textbooks usually print —
`W{J_ν, Y_ν} = 2 / (π z)`, derived via `W{f, g} = f g' − f' g` and
substituting 10.6.2 into the cross-product 10.5.2 — is what most CAS
users *expect*. Its rewrite form is

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `wronskian-J-Y-classical` | `J_ν(z) · Y′_ν(z) − J′_ν(z) · Y_ν(z)` | `2 / (π z)` | (none) | DLMF 10.5.2 + 10.6.2 chain | https://dlmf.nist.gov/10.5.E2 |

(This is equivalent to `wronskian-J-Y` via the recurrence; both should
fire in a v0.1 simplifier so users can write the Wronskian in either
the textbook `W{f, g} = f g' − f' g` form or the recurrence-rearranged
form 10.5.2 prints.)

### 4.2 Modified Wronskians — DLMF 10.28

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `wronskian-I-Ineg` | `I_ν(z) · I_{−ν−1}(z) − I_{ν+1}(z) · I_{−ν}(z)` | `−2 sin(ν π) / (π z)` | `ν ∉ ℤ` | DLMF 10.28.1 | https://dlmf.nist.gov/10.28.E1 |
| `wronskian-K-I` | `I_ν(z) · K_{ν+1}(z) + I_{ν+1}(z) · K_ν(z)` | `1 / z` | (none) | DLMF 10.28.2 | https://dlmf.nist.gov/10.28.E2 |

The cas-simplify dispatch shape mirrors §4.1: fire on a `+` /`−` head
with two Bessel-product summands; collapse to the closed form.

---

## 5. Inter-family bridges (DLMF §§10.4(iii), 10.27)

These are the load-bearing rewrites for the per-head substrate's
Meijer-G bridge (R4 territory; not in this artefact's scope but
referenced here so the R1 → R4 hand-off is explicit).

### 5.1 Hankel decomposition — DLMF 10.4.3, 10.4.4

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `hankel1-def` | `H^{(1)}_ν(z)` | `J_ν(z) + i · Y_ν(z)` | `ν ∈ ℂ` | DLMF 10.4.3 (first) | https://dlmf.nist.gov/10.4.E3 |
| `hankel2-def` | `H^{(2)}_ν(z)` | `J_ν(z) − i · Y_ν(z)` | `ν ∈ ℂ` | DLMF 10.4.3 (second) | https://dlmf.nist.gov/10.4.E3 |
| `besselj-from-hankel` | `J_ν(z)` | `(H^{(1)}_ν(z) + H^{(2)}_ν(z)) / 2` | `ν ∈ ℂ` | DLMF 10.4.4 (first) | https://dlmf.nist.gov/10.4.E4 |
| `bessely-from-hankel` | `Y_ν(z)` | `(H^{(1)}_ν(z) − H^{(2)}_ν(z)) / (2 i)` | `ν ∈ ℂ` | DLMF 10.4.4 (second) | https://dlmf.nist.gov/10.4.E4 |

`besselj-from-hankel` and `bessely-from-hankel` are **rewrite-on-
request** (the Hankel functions have not yet been canonicalised as
elementary heads in cas-core); admitting `HankelH1` and `HankelH2` to
the vocabulary makes these v0.1-shippable. See §13 Discovery A.

### 5.2 Hankel parity for negative ν — DLMF 10.4.6

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `hankel1-neg-order` | `H^{(1)}_{−ν}(z)` | `e^{ν π i} · H^{(1)}_ν(z)` | `ν ∈ ℂ` | DLMF 10.4.6 (first) | https://dlmf.nist.gov/10.4.E6 |
| `hankel2-neg-order` | `H^{(2)}_{−ν}(z)` | `e^{−ν π i} · H^{(2)}_ν(z)` | `ν ∈ ℂ` | DLMF 10.4.6 (second) | https://dlmf.nist.gov/10.4.E6 |

### 5.3 Cylinder ↔ modified bridges — DLMF 10.27.6 – 10.27.11

These are the *core* inter-family identities a Meijer-G bridge (R4)
will exploit; documented here for completeness.

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besseli-from-J` | `I_ν(z)` | `e^{∓ν π i / 2} · J_ν(z · e^{±π i / 2})` | `−π ≤ ±ph(z) ≤ π/2` (principal branch) | DLMF 10.27.6 | https://dlmf.nist.gov/10.27.E6 |
| `besseli-from-hankel` | `I_ν(z)` | `(1/2) · e^{∓ν π i / 2} · (H^{(1)}_ν(z e^{±π i/2}) + H^{(2)}_ν(z e^{±π i/2}))` | `−π ≤ ±ph(z) ≤ π/2` | DLMF 10.27.7 | https://dlmf.nist.gov/10.27.E7 |
| `besselk-from-hankel-pos-phase` | `K_ν(z)` | `(1/2) π i · e^{ν π i / 2} · H^{(1)}_ν(z · e^{π i / 2})` | `−π ≤ ph(z) ≤ π/2` | DLMF 10.27.8 (first) | https://dlmf.nist.gov/10.27.E8 |
| `besselk-from-hankel-neg-phase` | `K_ν(z)` | `−(1/2) π i · e^{−ν π i / 2} · H^{(2)}_ν(z · e^{−π i / 2})` | `−π/2 ≤ ph(z) ≤ π` | DLMF 10.27.8 (second) | https://dlmf.nist.gov/10.27.E8 |
| `besselj-from-K` | `π i · J_ν(z)` | `e^{−ν π i / 2} · K_ν(z · e^{−π i / 2}) − e^{ν π i / 2} · K_ν(z · e^{π i / 2})` | `|ph(z)| ≤ π/2` | DLMF 10.27.9 | https://dlmf.nist.gov/10.27.E9 |
| `bessely-from-K` | `−π · Y_ν(z)` | `e^{−ν π i / 2} · K_ν(z · e^{−π i / 2}) + e^{ν π i / 2} · K_ν(z · e^{π i / 2})` | `|ph(z)| ≤ π/2` | DLMF 10.27.10 | https://dlmf.nist.gov/10.27.E10 |
| `bessely-from-I-K` | `Y_ν(z)` | `e^{±(ν+1) π i / 2} · I_ν(z · e^{∓π i / 2}) − (2/π) · e^{∓ν π i / 2} · K_ν(z · e^{∓π i / 2})` | `−π/2 ≤ ±ph(z) ≤ π` | DLMF 10.27.11 | https://dlmf.nist.gov/10.27.E11 |
| `besselk-from-I-defn` | `K_ν(z)` | `(π / 2) · (I_{−ν}(z) − I_ν(z)) / sin(ν π)` | `ν ∉ ℤ` (limit value for integer ν per DLMF 10.27.5) | DLMF 10.27.4 | https://dlmf.nist.gov/10.27.E4 |
| `besseli-from-J-K-defn` | `I_{−ν}(z)` | `I_ν(z) + (2 / π) · sin(ν π) · K_ν(z)` | `ν ∈ ℂ` | DLMF 10.27.2 | https://dlmf.nist.gov/10.27.E2 |

**v0.1 disposition.** `besselj-from-hankel`, `bessely-from-hankel`,
and the Hankel-decomposition rules are *cleanest* v0.1 candidates if
`HankelH1` / `HankelH2` are admitted. The full phase-rotation bridges
(10.27.6 – 10.27.11) require the `complex` notion (the `i` encoding
question §13 Discovery B); they belong to a future "rewrite-as-modified"
rule family. The `besselk-from-I-defn` (DLMF 10.27.4) is **the** rule
the Meijer-G bridge R4 will likely use for `K_ν` decomposition.

---

## 6. Integer-ν special cases (DLMF §§10.2, 10.7, 10.30)

### 6.1 `J_0`, `J_1` series anchors (the closed power-series shape)

Both `J_0(z)` and `J_1(z)` are *entire* (DLMF 10.2 first ¶ on
"When ν = n (∈ ℤ), J_ν(z) is entire in z"), so their Maclaurin series
start at `z = 0`:
```
J_0(z) = Σ_{k=0}^∞ (−1)^k · (z/2)^{2k} / (k!)²
       = 1 − (z/2)² + (z/2)⁴ / 4 − (z/2)⁶ / 36 + ...
J_1(z) = Σ_{k=0}^∞ (−1)^k · (z/2)^{2k+1} / (k! · (k+1)!)
       = z/2 − (z/2)³ / 2 + (z/2)⁵ / 12 − ...
```
(DLMF 10.2.2 with `ν = 0` and `ν = 1`.) Neither has a closed *elementary*
form (the closed forms in this section are only the half-integer
spherical-Bessel ones above — `J_0` is a transcendent without any
closed-form reduction). The Maclaurin coefficients themselves are
*rewrite-as-series* candidates, **not** simplifier rules. The pattern
table should record them for `cas-simplify`'s `series-expand` companion
engine when it lands.

### 6.2 Limiting forms at `z = 0` — DLMF §10.7(i), §10.30(i)

These are the *boundary values* — they fire when the input has `z` set
to a literal zero or to a value cas-simplify can prove is zero.

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besselj-zero-arg-zero-order` | `J_0(0)` | `1` | (limit) | DLMF 10.7.1 (first) | https://dlmf.nist.gov/10.7.E1 |
| `besselj-zero-arg-pos-order` | `J_ν(0)` | `0` | `Re ν > 0` (integer) | DLMF 10.7.3 (limit; sets the leading coefficient via Γ) | https://dlmf.nist.gov/10.7.E3 |
| `bessely-zero-arg-zero-order` | `Y_0(0+)` | `−∞` (asymptotic `(2/π) ln z → −∞`) | (limit; logarithmic singularity) | DLMF 10.7.1 (second) | https://dlmf.nist.gov/10.7.E1 |
| `bessely-zero-arg-pos-order` | `Y_ν(0+)` | `−∞` (algebraic `−(1/π) Γ(ν) (z/2)^{−ν} → ∞` in magnitude) | `Re ν > 0` | DLMF 10.7.4 | https://dlmf.nist.gov/10.7.E4 |
| `hankel-zero-arg` | `H^{(1,2)}_0(0+)` | `∞` (logarithmic) | (limit) | DLMF 10.7.2 | https://dlmf.nist.gov/10.7.E2 |
| `besseli-zero-arg-zero-order` | `I_0(0)` | `1` | (limit) | DLMF 10.30.1 with `ν = 0` | https://dlmf.nist.gov/10.30.E1 |
| `besseli-zero-arg-pos-order` | `I_ν(0)` | `0` | `Re ν > 0` (integer) | DLMF 10.30.1 | https://dlmf.nist.gov/10.30.E1 |
| `besselk-zero-arg-zero-order` | `K_0(0+)` | `+∞` (logarithmic; `K_0(z) ~ −ln z`) | (limit) | DLMF 10.30.3 | https://dlmf.nist.gov/10.30.E3 |
| `besselk-zero-arg-pos-order` | `K_ν(0+)` | `+∞` (algebraic `(1/2) Γ(ν) (z/2)^{−ν}`) | `Re ν > 0` | DLMF 10.30.2 | https://dlmf.nist.gov/10.30.E2 |

**SymPy parallel.** `sympy-bessel.py:181-191` shows the analogous
`besselj.eval` cases:
- `z.is_zero` and `nu.is_zero` → `S.One`
- `z.is_zero` and `(nu.is_integer and nu.is_zero is False) or
  re(nu).is_positive` → `S.Zero`
- `z.is_zero` and `re(nu).is_negative and not nu.is_integer` →
  `S.ComplexInfinity`
- `z in (S.Infinity, S.NegativeInfinity)` → `S.Zero`

SymPy's `S.ComplexInfinity` is what we encode as the boundary tag
`tagged "cas-simplify/bessel-singular-at-zero"` (the `int / 0`-equivalent
output value cas-core's elementary vocabulary has no first-class
representation for). The v0.1 rule set should refuse these singular
cases honestly rather than emit `+∞`-shaped symbols downstream tools
cannot handle (per CLAUDE.md Rule 8).

### 6.3 Limiting forms at `z → ∞` (real, principal-branch) — DLMF 10.7.8 + 10.30.4

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besselj-infinity-arg` | `J_ν(+∞)` | `0` (oscillatory damp `z^{−1/2}`) | (limit) | DLMF 10.7.8 (first) | https://dlmf.nist.gov/10.7.E8 |
| `bessely-infinity-arg` | `Y_ν(+∞)` | `0` (oscillatory damp `z^{−1/2}`) | (limit) | DLMF 10.7.8 (second) | https://dlmf.nist.gov/10.7.E8 |
| `besseli-pos-real-infinity` | `I_ν(+∞)` | `+∞` (`e^z / √(2πz)`) | (limit) | DLMF 10.30.4 | https://dlmf.nist.gov/10.30.E4 |
| `besselk-pos-real-infinity` | `K_ν(+∞)` | `0` (`√(π/(2z)) · e^{−z}`) | (limit) | DLMF 10.25.3 | https://dlmf.nist.gov/10.25.E3 |

These rules must be treated with great care: they are *asymptotic
equalities*, not finite-value rules. Emitting them when the input is a
*symbolic-but-not-literal* infinity is fine; emitting them when `z` is
a large float64 is a *type error*. The shipped rule fires only when the
argument matches `sym("infinity")` (R1's literal-of-record per Erf
precedent).

---

## 7. Derivative identities (DLMF §§10.6, 10.15, 10.29, 10.38)

### 7.1 Derivative with respect to `z` — single-step (already shipped in cas-core)

These rules **already ship** in `packages/cas-core/src/special-functions.ts`
(`ruleBesselFirstKind`, `ruleBesselI`, `ruleBesselK`). They are listed
here for cross-reference completeness — adding them to a new
`bessel-identities.ts` rule table would *duplicate* the diff rules and
risk drift. Source-of-truth is `special-functions.ts`.

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | shipped at |
|---|---|---|---|---|---|
| `besselj-deriv` | `d/dz J_ν(z)` | `(J_{ν−1}(z) − J_{ν+1}(z)) / 2` | `ν` not depending on `z` | DLMF 10.6.1 (second), 10.6.2 average | `special-functions.ts:539-561` |
| `bessely-deriv` | `d/dz Y_ν(z)` | `(Y_{ν−1}(z) − Y_{ν+1}(z)) / 2` | (analogously) | DLMF 10.6.1 | same |
| `besseli-deriv` | `d/dz I_ν(z)` | `(I_{ν−1}(z) + I_{ν+1}(z)) / 2` | (analogously) | DLMF 10.29.1 | `special-functions.ts:564-585` |
| `besselk-deriv` | `d/dz K_ν(z)` | `−(K_{ν−1}(z) + K_{ν+1}(z)) / 2` | (analogously) | DLMF 10.29.1 | `special-functions.ts:588-611` |

### 7.2 Derivative with respect to ν (deferred — needs `Digamma`, `LerchPhi`)

DLMF 10.15.1 / 10.38.1 give the closed forms for `∂J_ν / ∂ν`
and `∂I_ν / ∂ν` in terms of digamma and an infinite Bessel-ψ series:

```
∂J_ν(z)/∂ν = J_ν(z) · ln(z/2)
           − (z/2)^ν · Σ_{k=0}^∞ ((−1)^k · ψ(k + 1 + ν) / Γ(k + 1 + ν)) · (z²/4)^k / k!
```
(DLMF 10.15.1, paralleled by 10.38.1 for `I_ν`.)

**v0.1 disposition.** Deferred. ADR-0023's `cas-diff` does not
differentiate with respect to the order parameter `ν` — every
`rule*Bessel*` checks `dependsOnWrt(nu, wrt, recurDiff)` and returns
`null` (= refuses) if it does. The rule above is a *closed-form
output*, not a closed-form *pattern* (the RHS involves a divergent-
series-shaped Σ that cas-core's elementary vocabulary cannot encode
without admitting a `BesselPsi`-like new head). A future
"derivative-wrt-order" sub-engine can land it; it is **not** in v0.1
scope.

### 7.3 Higher-order ladders — DLMF 10.6.6, 10.29.4

Per §1.1 / 1.2: the operator forms
```
(1/z · d/dz)^k (z^ν · C_ν(z)) = z^{ν − k} · C_{ν − k}(z)
(1/z · d/dz)^k (z^{−ν} · C_ν(z)) = (−1)^k · z^{−ν − k} · C_{ν + k}(z)
```
collapse repeated derivative chains. They are *rewrite-on-request*, not
canonicalisation rules. Cross-source-of-truth: `mpmath:besselj`
(`mpmath-bessel.py:15-81` has a `derivative=0` kwarg implementing this
ladder for numeric evaluation).

---

## 8. Addition theorems (DLMF §§10.23, 10.44)

The non-existence of an elementary `J_ν(a + b)` closed form is
discussed below as a *negative fact* (analogously to the Erf addition
theorem absence in `docs/refs/erf-research/R1-symbolic-identities.md`
§8 Add1). The *existing* addition theorems are infinite series, useful
for series-expand workflows but **not** v0.1 canonical simplifier
rules.

### 8.1 Negative fact — refusal class

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besselj-no-elementary-addition` | `J_ν(u + v)` | (no elementary closed form) | (refusal) | DLMF §10.23 implicit; see 10.23.1 (multiplication theorem) and 10.23.2 (Neumann's addition theorem, *infinite series*) | https://dlmf.nist.gov/10.23 |

The pattern table records the absence so the dispatcher emits a tagged
boundary error (`tagged "cas-simplify/bessel-no-elementary-addition"`)
rather than silently trying to apply a non-applicable rule.

### 8.2 Neumann's addition theorem (infinite series) — DLMF 10.23.2

```
C_ν(u ± v) = Σ_{k=−∞}^∞ C_{ν ∓ k}(u) · J_k(v),       |v| < |u|
```
(DLMF 10.23.2; the `|v| < |u|` restriction is *unnecessary* when `C = J`
and `ν` is an integer.)

Special cases (DLMF 10.23.3 – 10.23.5):
```
J_0(z)² + 2 · Σ_{k=1}^∞ J_k(z)² = 1                          (DLMF 10.23.3)
Σ_{k=0}^n J_k(z) · J_{n−k}(z) + 2 · Σ_{k=1}^∞ (−1)^k · J_k(z) · J_{n+k}(z) = J_n(2z)  (DLMF 10.23.5)
```

**v0.1 disposition.** Deferred. These are infinite-series identities;
the `series-expand` companion engine is the right consumer, not
`cas-simplify`. The 10.23.3 special case (the "Parseval-like" sum) is
useful in physics-leaning workflows but the rule shape is fundamentally
*recognising* an infinite sum, which is not in the v0.1 dispatcher's
remit.

### 8.3 Graf's addition theorem — DLMF 10.23.7

With `w² = u² + v² − 2uv cos α`:
```
C_ν(w) · {cos | sin}(ν χ) = Σ_{k=−∞}^∞ C_{ν+k}(u) · J_k(v) · {cos | sin}(k α),
                            |v · e^{±i α}| < |u|.
```
(DLMF 10.23.7.)

### 8.4 Gegenbauer's addition theorem — DLMF 10.23.8

```
C_ν(w) / w^ν = 2^ν · Γ(ν) · Σ_{k=0}^∞ (ν + k) · (C_{ν+k}(u) / u^ν) · (J_{ν+k}(v) / v^ν) · C^{(ν)}_k(cos α),
               ν ≠ 0, −1, …, |v · e^{±i α}| < |u|.
```
(DLMF 10.23.8.) The `C^{(ν)}_k` here is Gegenbauer's polynomial
(DLMF 18.3; cas-core already admits `GegenbauerC` per ADR-0023). A
v0.2 series-expand engine could collapse the truncation.

### 8.5 Modified addition theorems — DLMF 10.44.3

Analogous to 10.23.2 with `Z` substituted for `C` and `I` for `J`:
```
Z_ν(u ± v) = Σ_{k=−∞}^∞ (±1)^k · Z_{ν+k}(u) · I_k(v),       |v| < |u|.
```
(DLMF 10.44.3.) Deferred for the same v0.2 series-expand reason.

### 8.6 Multiplication theorem — DLMF 10.23.1, 10.44.1

```
C_ν(λ z) = λ^{±ν} · Σ_{k=0}^∞ (∓1)^k · (λ² − 1)^k · (z/2)^k / k! · C_{ν ± k}(z),
           |λ² − 1| < 1.
```
(DLMF 10.23.1; the restriction is unnecessary when `C = J` and the
upper signs are taken.) Useful for nearby-scaling problems; deferred to
the series-expand engine.

---

## 9. Integral representations (DLMF §§10.9, 10.32)

These are the *defining-and-equivalent* integral forms. They're not
canonical-simplifier rules (the dispatcher should not turn `J_0(z)`
into an integral); they're *rewrite-as-integral* rules a deeper
integration-by-parts engine can consume. Recorded for citation
completeness.

### 9.1 Bessel's integral — DLMF 10.9.1, 10.9.2

```
J_0(z) = (1/π) · ∫_0^π cos(z sin θ) dθ
       = (1/π) · ∫_0^π cos(z cos θ) dθ           (DLMF 10.9.1)
J_n(z) = (1/π) · ∫_0^π cos(z sin θ − n θ) dθ
       = (i^{−n} / π) · ∫_0^π e^{i z cos θ} · cos(n θ) dθ,  n ∈ ℤ   (DLMF 10.9.2)
```

### 9.2 Neumann's integral for `Y_0` — DLMF 10.9.3

```
Y_0(z) = (4 / π²) · ∫_0^{π/2} cos(z cos θ) · (γ + ln(2 z sin² θ)) dθ
```
(DLMF 10.9.3; `γ` is Euler's constant.)

### 9.3 Poisson's integral — DLMF 10.9.4

```
J_ν(z) = ((z/2)^ν / (π^{1/2} · Γ(ν + 1/2))) · ∫_0^π cos(z cos θ) · (sin θ)^{2ν} dθ
       = (2 (z/2)^ν / (π^{1/2} · Γ(ν + 1/2))) · ∫_0^1 (1 − t²)^{ν − 1/2} · cos(z t) dt,
       Re ν > −1/2.
```
(DLMF 10.9.4.)

### 9.4 Schläfli's integral — DLMF 10.9.6

```
J_ν(z) = (1/π) · ∫_0^π cos(z sin θ − ν θ) dθ
       − (sin(ν π) / π) · ∫_0^∞ e^{−z sinh t − ν t} dt,
       |ph z| < π/2.
```
(DLMF 10.9.6; analogous Schläfli–Sommerfeld integrals for `Y_ν`,
`H^{(1,2)}_ν`, `K_ν` at DLMF 10.9.7 – 10.9.30, 10.32.7+.)

### 9.5 Modified Bessel — DLMF 10.32.1, 10.32.2, 10.32.3

```
I_0(z) = (1/π) · ∫_0^π e^{±z cos θ} dθ = (1/π) · ∫_0^π cosh(z cos θ) dθ   (10.32.1)
I_ν(z) = ((z/2)^ν / (π^{1/2} · Γ(ν + 1/2))) · ∫_0^π e^{±z cos θ} · (sin θ)^{2ν} dθ
       = ((z/2)^ν / (π^{1/2} · Γ(ν + 1/2))) · ∫_{−1}^1 (1 − t²)^{ν − 1/2} · e^{±z t} dt,
       Re ν > −1/2.   (10.32.2)
I_n(z) = (1/π) · ∫_0^π e^{z cos θ} · cos(n θ) dθ.   (10.32.3)
```
(DLMF 10.32.1 – 10.32.3.)

### 9.6 `K_ν` integral representations — DLMF 10.32.7+

```
K_0(z) = ∫_0^∞ cos(z sinh t) dt = ∫_0^∞ cos(z t) / (t² + 1) dt,  z > 0.   (10.32.6)
K_ν(z) = sec(ν π / 2) · ∫_0^∞ cos(z sinh t) · cosh(ν t) dt
       = csc(ν π / 2) · ∫_0^∞ sin(z sinh t) · sinh(ν t) dt,  |Re ν| < 1, z > 0.   (10.32.7)
```

**v0.1 disposition.** All integral-representation rules are **deferred**.
None go in the v0.1 `bessel-identities.ts`. They live in the future
`rewrite-as-integral` rule family, useful for handing off a closed-form
Bessel input to `tools/integrate-1d` for numeric verification.

---

## 10. Differential-equation invariants (DLMF §§10.2, 10.25)

These ODEs are *signatures*: a v0.1 `cas-simplify` does *not* solve
ODEs, but it *can* recognise a Bessel-shaped second-order linear ODE
and admit it as a "this is a Bessel equation" tagged value. Useful for
`integrate-ode-*` tool integration in a future bead.

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `bessel-ode` | `z² · w''(z) + z · w'(z) + (z² − ν²) · w(z)` | `0` (recognise as Bessel ODE for `w ∈ {J_ν, Y_ν, H^{(1)}_ν, H^{(2)}_ν}`) | `ν ∈ ℂ` | DLMF 10.2.1 | https://dlmf.nist.gov/10.2.E1 |
| `mbessel-ode` | `z² · w''(z) + z · w'(z) − (z² + ν²) · w(z)` | `0` (recognise as modified Bessel ODE for `w ∈ {I_ν, K_ν}`) | `ν ∈ ℂ` | DLMF 10.25.1 | https://dlmf.nist.gov/10.25.E1 |
| `sph-bessel-ode` | `z² · w''(z) + 2z · w'(z) + (z² − n(n + 1)) · w(z)` | `0` (recognise as spherical Bessel ODE for `w ∈ {j_n, y_n, h^{(1)}_n, h^{(2)}_n}`) | `n ∈ ℤ_{≥0}` | DLMF 10.47.1 | https://dlmf.nist.gov/10.47.E1 |
| `sph-mbessel-ode` | `z² · w''(z) + 2z · w'(z) − (z² + n(n + 1)) · w(z)` | `0` (modified spherical Bessel ODE) | `n ∈ ℤ_{≥0}` | DLMF 10.47.2 | https://dlmf.nist.gov/10.47.E2 |

The Bessel ODE has *two* irregular-singularity properties (regular
singularity at `z = 0` with indices `±ν`; irregular singularity at
`z = ∞` of rank 1; DLMF 10.2). These are useful as *recognition tags*
when a future asymptotic-expansion engine wants to dispatch.

**v0.1 disposition.** Deferred — `cas-simplify` does not pattern-match
on ODE LHS shapes today; the existing infrastructure (`simplify.ts`)
operates on `+`-headed expressions in the closed elementary vocabulary,
not on `d²/dz²`-headed differential operators. This rule lands when a
future ODE-recognition engine (sister to `integrate-ode-*`) joins the
workbench. Documented here for completeness; *not* in the v0.1
rule-count.

---

## 11. Asymptotic-equality identities (DLMF §§10.7(ii), 10.17, 10.19, 10.30(ii))

The asymptotic expansions are *not* simplifier rules (they're series
that diverge but truncate well); they live in the future asymptotic-
expansion engine. Recorded here for completeness with the citation
trail intact.

### 11.1 Hankel's expansion for `J_ν`, `Y_ν` — DLMF 10.17.3 – 10.17.4

```
J_ν(z) ~ √(2 / (π z)) · (cos ω · Σ_{k=0}^∞ (−1)^k · a_{2k}(ν) / z^{2k}
                         − sin ω · Σ_{k=0}^∞ (−1)^k · a_{2k+1}(ν) / z^{2k+1}),
         |ph z| ≤ π − δ.   (DLMF 10.17.3)
Y_ν(z) ~ √(2 / (π z)) · (sin ω · Σ_{k=0}^∞ (−1)^k · a_{2k}(ν) / z^{2k}
                         + cos ω · Σ_{k=0}^∞ (−1)^k · a_{2k+1}(ν) / z^{2k+1}),
         |ph z| ≤ π − δ.   (DLMF 10.17.4)
ω = z − (1/2) ν π − (1/4) π                                                 (DLMF 10.17.2)
a_0(ν) = 1, a_k(ν) = (4 ν² − 1²)(4 ν² − 3²) ⋯ (4 ν² − (2k − 1)²) / (k! · 8^k),  k ≥ 1   (DLMF 10.17.1)
```

The leading-term forms (DLMF 10.7.8):

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `besselj-leading-asymptotic` | `J_ν(z) ~ <leading>` | `√(2 / (π z)) · cos(z − (1/2) ν π − (1/4) π)` | `|z| → ∞`, `|ph z| ≤ π − δ` | DLMF 10.7.8 / 10.17.3 leading | https://dlmf.nist.gov/10.7.E8 |
| `bessely-leading-asymptotic` | `Y_ν(z) ~ <leading>` | `√(2 / (π z)) · sin(z − (1/2) ν π − (1/4) π)` | (analogously) | DLMF 10.7.8 / 10.17.4 | https://dlmf.nist.gov/10.7.E8 |
| `besseli-leading-asymptotic` | `I_ν(z) ~ <leading>` | `e^z / √(2 π z)` | `|z| → ∞`, `|ph z| ≤ π/2 − δ` | DLMF 10.30.4 | https://dlmf.nist.gov/10.30.E4 |
| `besselk-leading-asymptotic` | `K_ν(z) ~ <leading>` | `√(π / (2 z)) · e^{−z}` | `|z| → ∞`, `|ph z| ≤ 3π/2 − δ` | DLMF 10.25.3 | https://dlmf.nist.gov/10.25.E3 |

### 11.2 Uniform asymptotic for large order — DLMF §10.19, §10.20

DLMF §10.19 covers the *large-ν* asymptotic for `J_ν`, `Y_ν`. The
transition region (Airy-function regime) is covered by DLMF 10.19.8 –
10.19.10 in terms of Airy functions. **Far beyond v0.1 simplifier
scope**; recorded so a future asymptotic-expansion engine has the
citation trail.

DLMF §10.20 gives Olver's *uniform* asymptotic — the gold-standard
large-order expansion valid uniformly in `z`, `ν`. This is what the
R2 (arb-prec) and R3 (float64) algorithm research will draw on.

---

## 12. Limit / value identities (DLMF §§10.7, 10.30)

Cross-reference §6.2 (limiting forms at zero) and §6.3 (limiting forms
at infinity). They are listed *here* (per the bead prompt's class-12
ordering) as the v0.1-shippable subset for the simplifier:

| ID | `lhs_pattern` | `rhs` | `conditions` | `source` | `source_link` |
|---|---|---|---|---|---|
| `bessel-j0-at-zero` | `J_0(0)` | `1` | (literal) | DLMF 10.7.1 | https://dlmf.nist.gov/10.7.E1 |
| `bessel-jn-at-zero` | `J_n(0)` | `0` | `n ∈ ℤ_{>0}` | DLMF 10.7.3 | https://dlmf.nist.gov/10.7.E3 |
| `bessel-i0-at-zero` | `I_0(0)` | `1` | (literal) | DLMF 10.30.1 | https://dlmf.nist.gov/10.30.E1 |
| `bessel-in-at-zero` | `I_n(0)` | `0` | `n ∈ ℤ_{>0}` | DLMF 10.30.1 | https://dlmf.nist.gov/10.30.E1 |

(The `Y_ν` and `K_ν` cases at `z = 0` are *singular* and must be
*refused* — see §6.2. The `±∞` cases for argument also refuse cleanly,
not silently coerce to a number.)

---

## 13. Vocabulary expansion recommendations (Discovery A)

The current cas-core vocabulary (ADR-0023, amended by ADR-0040 §
"Decision 6") admits four Bessel heads: `BesselJ`, `BesselY`, `BesselI`,
`BesselK`. None of `HankelH1`, `HankelH2`, `SphericalBesselJ`,
`SphericalBesselY`, `SphericalBesselI` (any of the two `i^{(1,2)}`
forms), `SphericalBesselK` is admitted. This section answers the bead's
Discovery A: should they be?

### 13.1 The Erfi precedent (the test we apply)

The Erf R1 / I6a admitted `Erfi` to the vocabulary table because *no
closed-form rewrite kept Erfi inside the existing elementary
vocabulary at the level of substrate computation*. The Meijer-G bridge
needed `Erfi` as a first-class head — the symmetric forward table
(`an = [1/2]`, `bm = [0]`, `bq = [−1/2]`) parameterised by sign of the
z-argument was the load-bearing argument. The discriminating question
was: "can a substrate-level pattern table dispatch on this head
non-redundantly?"

We apply the same test per Bessel-family candidate:

### 13.2 `HankelH1`, `HankelH2`

| Test | Verdict |
|---|---|
| Does it reduce to `J_ν` + `Y_ν` via a closed elementary identity? | **Yes** — DLMF 10.4.3: `H^{(1)}_ν = J_ν + i · Y_ν`. |
| Does the reduction *avoid* admitting a `complex` head? | **No**. The reduction has `i` as a load-bearing first-class element. |
| Does the substrate (R2 arbprec / R3 float64) need it as a first-class head? | **Likely yes.** Numeric evaluation of `H^{(1)}_ν` in the upper half-plane uses Hankel's expansion (DLMF 10.17.5) directly *without* decomposition through `J_ν + i Y_ν` (which would lose precision in cancellation between large `Y_ν` and `i J_ν`). A substrate that emits Hankel-direct arithmetic needs Hankel as a head. |
| Is the Meijer-G representation distinct? | **Yes** — DLMF 10.16.8 gives the Whittaker `W_{0, ν}` form for `H^{(1,2)}_ν` directly, distinct from the `J_ν` Meijer-G representation. |
| Does a working CAS (SymPy, mpmath) treat it as a first-class head? | **Yes for both.** SymPy `hankel1` / `hankel2` (defined in the same `sympy/functions/special/bessel.py` file). mpmath `hankel1` / `hankel2` (`mpmath-bessel.py:182, 189`). |

**Recommendation: ADMIT `HankelH1` and `HankelH2` to ADR-0023's
vocabulary table** as `{shape: "fixed", count: 2}` heads in the Bessel
family (sorted just after `BesselK`, before `HypergeometricPFQ`). Diff
rules ship the same shape as cylinder Bessel:
```
d/dz H^{(1)}_ν(z) = (H^{(1)}_{ν−1}(z) − H^{(1)}_{ν+1}(z)) / 2
d/dz H^{(2)}_ν(z) = (H^{(2)}_{ν−1}(z) − H^{(2)}_{ν+1}(z)) / 2
```
(both follow from DLMF 10.6.1 with `C_ν = H^{(1,2)}_ν`).

### 13.3 `SphericalBesselJ`, `SphericalBesselY`, `SphericalBesselI`, `SphericalBesselK`

| Test | Verdict |
|---|---|
| Do they reduce to `J_{n+1/2}` + `√(π/(2z))` via a closed elementary identity? | **Yes** — DLMF 10.47.3 – 10.47.9: `j_n(z) = √(π/(2z)) · J_{n+1/2}(z)`, etc. The reductions are *purely* in the elementary vocabulary plus the half-integer Bessel. |
| Is the reduction *lossless*? | **Yes** — bijection between `j_n(z)` for `n ∈ ℤ_{≥0}` and the half-integer Bessel ladder. (DLMF restricts spherical Bessel `n` to `≥ 0` precisely because the negative-`n` cases are redundant via the half-integer parity rules; see DLMF 10.47 opening note.) |
| Does the substrate need it? | **Yes** — physics applications (electromagnetism Mie scattering, quantum scattering partial-wave decomposition, gravitational-wave spherical harmonic expansions) routinely express results as `j_n(kr)`, not as `√(π/(2kr)) · J_{n+1/2}(kr)`. Refusing to admit spherical Bessel forces every consumer to re-do the substitution at the value-protocol boundary. |
| Is the Meijer-G representation distinct? | **No, redundant.** Spherical Bessel reduces to half-integer Bessel before Meijer-G dispatch. |
| Does a working CAS treat it first-class? | **Yes for SymPy** (`jn`, `yn`, `hn1`, `hn2` are first-class classes in `sympy/functions/special/bessel.py`). mpmath does not (it uses `besselj(n + 1/2, z) * sqrt(pi / (2z))` directly). |

**Recommendation: ADMIT `SphericalBesselJ` and `SphericalBesselY`** as
fixed-2 heads. `SphericalBesselI` / `SphericalBesselK` are weaker
admits — the modified spherical Bessel has two distinct `i^{(1)}` and
`i^{(2)}` variants per DLMF 10.47.7 / 10.47.8 (encoding ambiguity is a
liability), and physics applications usually express the modified
spherical forms via `k_n(z) = √(π/(2z)) · K_{n + 1/2}(z)` directly. A
*tighter* recommendation is:
- v0.1: admit only `SphericalBesselJ`, `SphericalBesselY`,
  `HankelH1`, `HankelH2` — the four heads with unambiguous DLMF
  definitions and load-bearing physics use.
- v0.2: revisit `SphericalBesselI` (which of the two `i^{(1)}` /
  `i^{(2)}` is canonical?), `SphericalBesselK` when a consumer files
  the use case.

Spherical Bessel diff rules (DLMF §10.51, parametrised by the half-
integer Bessel relations 10.47):
```
d/dz j_n(z) = j_{n−1}(z) − ((n + 1) / z) · j_n(z)             (or symmetric form)
            = (n · j_{n−1}(z) − (n + 1) · j_{n+1}(z)) / (2n + 1)
```
(DLMF 10.51.2 + 10.51.1.) Both forms are admissible; the symmetric
`(n · j_{n−1} − (n + 1) · j_{n+1}) / (2n + 1)` form is the canonical
v0.1 choice mirroring the cylinder Bessel convention.

### 13.4 Net vocabulary change

ADR-0023 grows from 28 heads to **32**:
- + `HankelH1`, `HankelH2` (Bessel family, between `BesselK` and
  `HypergeometricPFQ`)
- + `SphericalBesselJ`, `SphericalBesselY` (Bessel family, after the
  Hankels)

**Cost.** Per-head additions to: `SPECIAL_FUNCTION_HEADS`,
`ARITY_TABLE`, `SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS`, and the
`differentiateSpecialFunction` `switch` block. Per ADR-0023 §"Diff-rule
output stays in the closed vocabulary", the four new heads should emit
diff outputs *within the post-amendment vocabulary*:
- `H^{(1,2)}_ν` derivatives emit `H^{(1,2)}_{ν±1}` (closure within
  Hankel).
- `j_n` derivatives emit `j_{n±1}` (closure within spherical-J ladder).

This satisfies the "rules emit special-function heads recursively
differentiable in the same vocabulary" invariant ADR-0023 mandates.

---

## 14. Pattern-primitive gaps (Discovery B)

The current cas-core "pattern language" is *not* a formal `PatternSpec`
DSL — it is implemented per-head as TypeScript predicates against the
canonical AST shape (see
`packages/cas-core/src/special-funcs/erf-identities.ts:181-260` for
the Erf-family pattern table; the function `isZeroLiteral`,
`isPosInfinity`, etc. are bespoke per-shape predicates). This section
inventories the *new* predicate primitives the Bessel rule set needs.

### 14.1 Predicates needed but already in cas-core

- `isZeroLiteral(v)` — `v = int(0n)` after canonicalisation. ✅
- `isPosInfinity(v)` — `v = sym("infinity")`. ✅
- `isNegInfinity(v)` — `mkNeg(sym("infinity"))`. ✅
- `isIntegerLiteral(v, n)` — `v = int(BigInt(n))`. ✅

### 14.2 New predicates needed for Bessel

- **`isPositiveInteger(v)`** — `v.kind === "integer" && v.value > 0`.
  Needed for the `J_n(0) = 0` rule (fires for `n ∈ ℤ_{>0}`, not for
  general non-integer `ν` which would silently produce a wrong-shaped
  answer).
- **`isNonNegativeInteger(v)`** — `v.kind === "integer" && v.value ≥ 0`.
  Needed for the spherical-Bessel `n` parameter (DLMF restricts `n ≥ 0`;
  any pattern firing on `j_n` must check this).
- **`isHalfInteger(v)`** — `v.kind === "rational" && v.den === 2n &&
  abs(v.num) is odd`. Needed for the closed-form `J_{1/2}` etc. ladder
  (§2.1). **This is the load-bearing new primitive.** The pattern table
  for half-integer-closure rules **cannot ship without it**.
- **`isIntegerLiteralCondition(v, predicate)`** — a generalisation:
  pass an explicit integer-predicate (`(n: bigint) => boolean`)
  returning true on `v.kind === "integer" && predicate(v.value)`.
  Subsumes `isPositiveInteger`, `isNonNegativeInteger`,
  `isIntegerLiteral`. Less critical; a refactoring opportunity, not a
  v0.1 gap.
- **`isSpecificHalfInteger(v, k)`** — `v = rat(k, 2)` for the
  half-integer closures `J_{1/2}`, `J_{-1/2}`, etc. specifically
  (k = ±1, ±3, ...). A specialisation of `isHalfInteger`. Convenient
  but not strictly necessary; `isHalfInteger` + a numeric-value
  extraction does the job.
- **`isNegationOf(v, x)`** — symbolic predicate "is `v` the
  `−x` shape?", returning the `x` if so. Already used implicitly in
  `tryErfSimplify` (the `Erfi(-z) → -Erfi(z)` parity rule). Needed for
  the integer-ν parity rules `J_{-n}(z) = (-1)^n J_n(z)` (§3),
  fired on the *order* parameter. Concretely: the rule needs to
  match `expr("BesselJ", [neg_of(n), z])` where `neg_of(n)` is `mkNeg`
  applied to a non-negative integer literal. The existing
  `isExpressionNeg` and `extractInnerOfNeg` in `erf-identities.ts:
  201-260` are the *exact* primitives we need; promoting them to a
  shared utility module is the right move.

### 14.3 Rewrite primitives needed (output side)

- **`negativePower(z)`** — `mkPower(z, mkNeg(...))`. Already
  expressible.
- **`rational(p, q)`** — for `1/2`, `−1/2`. Already
  expressible via `rat(p, q)`.
- **`sqrtOfRationalArgument(arg)`** — `mkPower(arg, rat(1n, 2n))`. The
  ADR-0040 canonical encoding choice for `√π` ; should be used
  consistently here for `√(2 / (π z))` etc. (cf. the cas-core
  Decision-6 unification follow-up bead `c4cr`).

### 14.4 Conditions that **cannot** be expressed today

The pattern table cannot today express:
- **`Re(z) > 0`** (a *complex* condition) — Bessel asymptotic
  identities (e.g. DLMF 10.17.3's `|ph z| ≤ π − δ` cone) cannot be
  matched against runtime input. The pattern table can only fire on
  *literal* inputs the dispatcher can reason about without a complex-
  analysis decision procedure. **v0.1 disposition: skip
  asymptotic-identity dispatch entirely** (they're not canonical
  simplifier rules anyway).
- **`ν is a positive real (non-integer)`** — needed for the connection
  formula `Y_ν(z) = (J_ν cos(νπ) − J_{−ν}) / sin(νπ)` (DLMF 10.2.3)
  whose RHS is *singular* at integer ν (where the LHS is well-defined
  via 10.2.4's limiting form). The dispatcher can refuse to fire when
  `ν` is integer; it cannot reliably *prove* `ν` is non-integer for a
  symbolic `ν`. **Disposition: condition-string** `ν ∉ ℤ` (a string,
  enforced informally — the dispatcher fires only if the order literal
  is not integer; symbolic-order calls just don't trigger).
- **`|v · e^{±i α}| < |u|`** (the Graf / Gegenbauer addition theorem
  domain bound) — only an infinite-precision arithmetic CAS can check
  this. **Disposition: deferred; never a v0.1 simplifier rule.**

### 14.5 Net pattern-primitive gap

| Primitive | Status | Required for |
|---|---|---|
| `isPositiveInteger` | **new** | §6.2 (Bessel J/I at zero, non-zero order) |
| `isNonNegativeInteger` | **new** | §2.3 (spherical Bessel order constraint) |
| `isHalfInteger` | **new (load-bearing)** | §2.1 (half-integer closed forms) |
| `isNegationOfInteger` | refactor (extract from `erf-identities.ts`) | §3 (integer-ν parity) |
| `Re(z) > 0` / `ν ∉ ℤ` / `|v·e^{iα}| < |u|` | **cannot express** | §11 asymptotic, §3.1 connection formula, §8 addition theorems — all deferred |

**Recommendation for ADR-0041 §"Pattern-primitive amendments":** ship
`isPositiveInteger`, `isNonNegativeInteger`, `isHalfInteger` as new
helpers in `packages/cas-core/src/special-funcs/predicates.ts` (a new
file extracted from `erf-identities.ts`'s pattern utilities). Bessel
rules then use the shared module. No DSL refactor in v0.1.

---

## 15. Canonicalisation conflicts (Discovery C)

The Erf R1 / I4 epic surfaced a `√π` encoding conflict between
`expr("sqrt", [sym("pi")])` (`ruleErf` shape) and `mkPower(sym("pi"),
rat(1n, 2n))` (`ruleErfi` shape) — recorded as bead `c4cr`. This
section enumerates the analogous canonicalisation conflicts for the
Bessel family.

### 15.1 Integer-order sign canonicalisation

| Issue | Severity |
|---|---|
| `J_{−n}(z)` (where `n` is a positive integer literal) ↔ `(−1)^n · J_n(z)` (DLMF 10.4.1) | **HIGH** |

SymPy `besselj.eval` (`sympy-bessel.py:196-197`) canonicalises
`J_{−n} → (−1)^n · J_n` when `n.is_integer and n.could_extract_minus_sign()`.
This is the *canonical CAS direction*. Mathematica's `BesselJ[-n, z]`
also normalises in this direction (verifiable via the conventional
`FunctionExpand[BesselJ[-3, z]]` reduction).

**Decision.** The v0.1 dispatcher should canonicalise toward
*non-negative-order Bessel*. Pattern rule fires on `J_{−n}` (for `n`
positive integer) → output `(−1)^n · J_n`. The pattern does **not**
fire on `J_{−ν}` for non-integer `ν` (the rule's condition is "order
is negative *integer* literal"), because `J_{−ν}` is *linearly
independent* of `J_ν` per DLMF §10.4 opening.

### 15.2 `Y` vs `J` direction

| Issue | Severity |
|---|---|
| `Y_ν(z) = (J_ν cos(νπ) − J_{−ν}) / sin(νπ)` (DLMF 10.2.3) — should the dispatcher canonicalise `Y` → `J` shape for non-integer ν? | **MEDIUM** |

SymPy `bessely._eval_rewrite_as_besselj` does this rewrite *only on
request* (`y.rewrite(besselj)`), not by default. The default `Y_ν(z)`
stays as `Y_ν(z)` in SymPy's canonical form. Mathematica's `BesselY`
behaves the same.

**Decision.** Treat `Y` and `J` as **distinct canonical heads**. The
rewrite is *available* via a rewrite-on-request rule
(`rewrite-as-J` flag analogous to Erf R1's `rewrite-as-gamma`); it is
**not** a default canonicalisation. Same for `H^{(1,2)}` ↔ `J + i Y`:
keep separate; rewrite-on-request only.

### 15.3 `K` invariance vs `I` integer-restricted parity

| Issue | Severity |
|---|---|
| `K_{−ν} = K_ν` (DLMF 10.27.3, all ν) vs `I_{−n} = I_n` (DLMF 10.27.1, integer n only) | **LOW** (well-understood; no conflict in well-typed inputs) |

The canonicalisation rules are *both* in the v0.1 table but with
*different* conditions:
- `K_{−ν}(z) → K_ν(z)` for **all** ν (no condition string).
- `I_{−n}(z) → I_n(z)` for **integer n only** (condition string `n ∈ ℤ`,
  enforced by `isPositiveInteger` predicate on `−n`).

The risk: a user writes `I_{−ν}(z)` with non-integer-symbolic `ν`. The
v0.1 rule does not fire (correct — the answer would be wrong); it
leaves `I_{−ν}(z)` in the AST. A future bead can ship the closed-form
`I_{−ν} = I_ν + (2/π) sin(νπ) K_ν` (DLMF 10.27.2) as a
`rewrite-as-I-plus-K` rule — that rule is *deeper* than the v0.1 scope
and would expand the AST size by ~3×, so it should be flagged as a
gate-by-default rule (off in canonical simplification, on in user
opt-in).

### 15.4 Spherical-Bessel ↔ half-integer Bessel canonical direction

| Issue | Severity |
|---|---|
| If `SphericalBesselJ` is admitted (per §13.3), should `j_n(z)` canonicalise *down* to `√(π/(2z)) · J_{n+1/2}(z)`, or stay as `j_n(z)`? | **MEDIUM** |

SymPy's `jn` stays as `jn(n, z)` in canonical form (not expanded);
SymPy provides the expansion via `jn(n, z).rewrite(besselj)`.
Mathematica's `SphericalBesselJ[n, z]` likewise stays first-class.

**Decision.** Stay first-class. The rewrite to half-integer Bessel is
a `rewrite-as-bessel` flagged rule; canonical form keeps the spherical
heads. **Inverse direction** — should `J_{n+1/2}(z)` for literal
half-integer order canonicalise *up* to `√(2/(πz)) · sin z`-shape
(elementary) or `√(π/(2z)) · j_n(z)` (spherical)? The elementary
collapse (DLMF 10.16.1) is the *most informative*: an integral over
`J_{1/2}(z)` should display as `∫ √(2/(πz)) sin z dz`, not as
`∫ j_0(z) √(2z/π) dz`. **Direct elementary canonicalisation wins** when
the order is a *small* half-integer (`±1/2`, `±3/2`, `±5/2`); for
larger orders the rule should *prefer the spherical-Bessel form* (less
verbose) but this is a v0.2 polish question.

### 15.5 The `i` (imaginary unit) encoding question

| Issue | Severity |
|---|---|
| The Hankel definition `H^{(1)}_ν = J_ν + i · Y_ν` and the `besseli-from-J` bridge `I_ν(z) = i^{−ν} J_ν(i z)` both rely on a first-class `i`. cas-core encodes it as `sym("I")` per `erf-identities.ts:164` (bead `c4cr` documents this). | **MEDIUM** |

**Decision.** Use `sym("I")` per the existing `erf-identities.ts`
convention. Defer the question of admitting a `complex` head or
formalising an `I` constant to the cross-head canonicalisation
unification follow-up bead (`c4cr` / future work). The Bessel rules
follow the existing convention; if `c4cr` lands with a different
canonical encoding, the Bessel rules update via the same migration.

### 15.6 The `√(π / (2z))` and `√(2 / (π z))` encoding question

| Issue | Severity |
|---|---|
| The half-integer closures use prefactors `√(2/(πz))` (DLMF 10.16.1 first), `√(π/(2z))` (10.47.3). Should these encode as `mkPower(mkDiv(int(2n), mkTimes(sym("pi"), z)), rat(1n, 2n))` (ADR-0040 convention) or `expr("sqrt", [mkDiv(...)])` (older convention)? | **LOW** (decided already by ADR-0040 §"Decision 6"; just follow it) |

**Decision.** Use `mkPower(arg, rat(1n, 2n))` per ADR-0040 §
"Decision 6" pin. No new conflict; the Erf precedent already pins this.

---

## 16. v0.1 scope — the shippable rule list (priority order)

Out of the ~85 distinct identities catalogued in §§1–12 above, the
following **30 rules** are v0.1-shippable in
`packages/cas-core/src/special-funcs/bessel-identities.ts` against the
current vocabulary + the **4 head amendments** in §13 (`HankelH1`,
`HankelH2`, `SphericalBesselJ`, `SphericalBesselY`) + the **3 new
predicate helpers** in §14 (`isPositiveInteger`, `isNonNegativeInteger`,
`isHalfInteger`).

**Priority A (special values; ~10 rules):**
1. `bessel-j0-at-zero` — `J_0(0) → 1` (DLMF 10.7.1)
2. `bessel-jn-at-zero-positive-integer` — `J_n(0) → 0` for `n ∈ ℤ_{>0}` (DLMF 10.7.3)
3. `bessel-i0-at-zero` — `I_0(0) → 1` (DLMF 10.30.1)
4. `bessel-in-at-zero-positive-integer` — `I_n(0) → 0` for `n ∈ ℤ_{>0}` (DLMF 10.30.1)
5. `bessel-deriv-J0` — `d/dz J_0(z) → −J_1(z)` (DLMF 10.6.3) — actually redundant with `ruleBesselFirstKind` recurrence; **skip** as separate rule
6. `bessel-deriv-I0` — `d/dz I_0(z) → I_1(z)` (DLMF 10.29.3) — redundant; **skip**
7. `besselj-leading-infinity` — `J_ν(+∞) → 0` (refusal / asymptotic; DLMF 10.7.8) — **boundary tag, not value rule**
8. `bessely-singular-at-zero` — `Y_ν(0+) → tagged "bessel/singular-at-zero"` (DLMF 10.7.1, 10.7.4) — **refusal class**
9. `besselk-singular-at-zero` — `K_ν(0+) → tagged "bessel/singular-at-zero"` (DLMF 10.30.2, 10.30.3) — **refusal class**

**Net after de-duplication:** ~6 special-value rules + 2 refusal rules.

**Priority B (integer-ν parity; 6 rules):**
10. `besselj-neg-integer-order` — `J_{−n}(z) → (−1)^n · J_n(z)`, `n ∈ ℤ_{≥0}` (DLMF 10.4.1)
11. `bessely-neg-integer-order` — `Y_{−n}(z) → (−1)^n · Y_n(z)`, `n ∈ ℤ_{≥0}` (DLMF 10.4.1)
12. `besseli-neg-integer-order` — `I_{−n}(z) → I_n(z)`, `n ∈ ℤ_{≥0}` (DLMF 10.27.1)
13. `besselk-neg-order` — `K_{−ν}(z) → K_ν(z)`, all `ν` (DLMF 10.27.3)
14. `hankel1-neg-integer-order` — `H^{(1)}_{−n}(z) → (−1)^n · H^{(1)}_n(z)`, `n ∈ ℤ_{≥0}` (DLMF 10.4.2)
15. `hankel2-neg-integer-order` — `H^{(2)}_{−n}(z) → (−1)^n · H^{(2)}_n(z)`, `n ∈ ℤ_{≥0}` (DLMF 10.4.2)

**Priority C (half-integer closures; 8 rules):**
16. `besselj-pos-half` — `J_{1/2}(z) → √(2/(πz)) · sin(z)` (DLMF 10.16.1)
17. `besselj-neg-half` — `J_{−1/2}(z) → √(2/(πz)) · cos(z)` (DLMF 10.16.1)
18. `bessely-pos-half` — `Y_{1/2}(z) → −√(2/(πz)) · cos(z)` (DLMF 10.16.1)
19. `bessely-neg-half` — `Y_{−1/2}(z) → √(2/(πz)) · sin(z)` (DLMF 10.16.1, derived)
20. `besseli-pos-half` — `I_{1/2}(z) → √(2/(πz)) · sinh(z)` (DLMF 10.16.1 + 10.27.6)
21. `besseli-neg-half` — `I_{−1/2}(z) → √(2/(πz)) · cosh(z)` (analogously)
22. `besselk-pos-half` — `K_{1/2}(z) → √(π/(2z)) · e^{−z}` (DLMF 10.47.9 chain)
23. `besselk-neg-half` — `K_{−1/2}(z) → √(π/(2z)) · e^{−z}` (DLMF 10.27.3 + 22)

**Priority D (Hankel / spherical-Bessel canonicalisation; 4 rules):**
24. `hankel1-from-J-Y` — `H^{(1)}_ν(z) → J_ν(z) + I · Y_ν(z)` (DLMF 10.4.3) — **rewrite-as-J-Y flag, default off**
25. `hankel2-from-J-Y` — `H^{(2)}_ν(z) → J_ν(z) − I · Y_ν(z)` (DLMF 10.4.3) — same
26. `sph-j-from-half-integer-J` — `j_n(z) → √(π/(2z)) · J_{n+1/2}(z)`, `n ∈ ℤ_{≥0}` (DLMF 10.47.3) — **rewrite-as-bessel flag**
27. `sph-y-from-half-integer-Y` — `y_n(z) → √(π/(2z)) · Y_{n+1/2}(z)`, `n ∈ ℤ_{≥0}` (DLMF 10.47.4) — **rewrite-as-bessel flag**

**Priority E (spherical Bessel small-n closures; 3 rules):**
28. `sph-j0-elementary` — `j_0(z) → sin(z) / z` (DLMF 10.49.3 first)
29. `sph-j1-elementary` — `j_1(z) → sin(z)/z² − cos(z)/z` (DLMF 10.49.3 second)
30. `sph-y0-elementary` — `y_0(z) → −cos(z) / z` (DLMF 10.49.5 analogue)

**Total: 30 distinct rules** (after eliminating the redundant 5–6 derivative
rules that the existing `ruleBesselFirstKind` etc. already ship).

**Implementation order (the recommended bead sequence for the I4
cas-core identities bead in Phase 2 of the methodology):**
1. Priority A (special values + refusal classes) — easy; no
   vocabulary amendment required (uses only existing heads).
2. Priority B (integer-ν parity) — easy; depends on
   `isPositiveInteger` + the `isNegationOfInteger` refactor.
3. Priority C (half-integer closures) — depends on `isHalfInteger`;
   the load-bearing user-visible feature; ship before D / E.
4. Priority D / E (Hankel + spherical-Bessel) — depend on vocabulary
   amendment (ADR-0023 amendment in I6a bead).

---

## 17. References

### 17.1 Primary sources (downloaded, on disk)

All under `/home/tobias/Projects/scientist-workbench/docs/refs/besselj-research/sources/symbolic/`:

| Tag | Local path | Section coverage |
|---|---|---|
| DLMF §10.2 | `dlmf-10.2.html` + `.txt` | Definitions, Bessel ODE, standard solutions, principal branches |
| DLMF §10.4 | `dlmf-10.4.html` + `.txt` | Connection formulas (integer-ν parities, Hankel decomp) |
| DLMF §10.5 | `dlmf-10.5.html` + `.txt` | Wronskians and cross-products |
| DLMF §10.6 | `dlmf-10.6.html` + `.txt` | Recurrences and derivatives (cylinder Bessel) |
| DLMF §10.7 | `dlmf-10.7.html` + `.txt` | Limiting forms at 0 and ∞ |
| DLMF §10.9 | `dlmf-10.9.html` + `.txt` | Integral representations (cylinder Bessel) |
| DLMF §10.16 | `dlmf-10.16.html` + `.txt` | Half-integer closed forms, M/U/W reductions, ₀F₁ |
| DLMF §10.17 | `dlmf-10.17.html` + `.txt` | Hankel's asymptotic expansion (large argument) |
| DLMF §10.19 | `dlmf-10.19.html` + `.txt` | Asymptotic for large order, Debye expansion |
| DLMF §10.20 | `dlmf-10.20.html` + `.txt` | Uniform asymptotic for large order (Olver) |
| DLMF §10.21 | `dlmf-10.21.html` + `.txt` | Zeros of Bessel functions |
| DLMF §10.23 | `dlmf-10.23.html` + `.txt` | Sums (addition theorems) |
| DLMF §10.25 | `dlmf-10.25.html` + `.txt` | Modified Bessel ODE |
| DLMF §10.27 | `dlmf-10.27.html` + `.txt` | Modified Bessel connection formulas |
| DLMF §10.28 | `dlmf-10.28.html` + `.txt` | Modified Wronskians |
| DLMF §10.29 | `dlmf-10.29.html` + `.txt` | Modified recurrences and derivatives |
| DLMF §10.30 | `dlmf-10.30.html` + `.txt` | Modified Bessel limiting forms |
| DLMF §10.32 | `dlmf-10.32.html` + `.txt` | Modified Bessel integral representations |
| DLMF §10.38 | `dlmf-10.38.html` + `.txt` | Derivatives with respect to order |
| DLMF §10.44 | `dlmf-10.44.html` + `.txt` | Modified sums (Neumann, Graf, Gegenbauer) |
| DLMF §10.47 | `dlmf-10.47.html` + `.txt` | Spherical Bessel definitions |
| DLMF §10.48 | `dlmf-10.48.html` + `.txt` | Spherical Bessel graphs (figures only) |
| DLMF §10.49 | `dlmf-10.49.html` + `.txt` | Spherical Bessel explicit formulas, Rayleigh's formula |
| DLMF §10.50 | `dlmf-10.50.html` + `.txt` | Spherical Wronskians |
| SymPy bessel.py | `sympy-bessel.py` | Working-CAS reference (canonicalisation conventions, `_eval_rewrite_as_*` reductions) |
| mpmath bessel.py | `mpmath-bessel.py` | Numeric-reference (`besselj` / `bessely` / `besseli` / `besselk` / `hankel1` / `hankel2` / `besseljzero` / `besselyzero`) |
| Wikipedia: Bessel | `wiki-bessel.html` | Consolidated cross-check |
| Wikipedia: Modified Bessel | `wiki-modified-bessel.html` | Consolidated cross-check |

### 17.2 Primary sources NOT obtained (honest failure notes)

| Source | Why not obtained |
|---|---|
| Watson, *A Treatise on the Theory of Bessel Functions* (1944, CUP) | HTTP 403 from archive.org's CDN (`treatiseontheory0000wats.pdf`). DLMF cites Watson extensively; the citations are quoted-through-DLMF (e.g., "Watson 1944, pp. 45, 66, 73-74" per DLMF 10.6's notes); no Bessel substance below depends on direct Watson verification. |
| Abramowitz & Stegun (1964) Chapter 9, page-by-page | The personal.math.ubc.ca mirror serves *image-based* HTML wrappers (`<img src="page_358.jpg">`), not text. Not text-extractable; DLMF's "A&S Ref:" inline annotations are the proxy. |
| Wolfram Functions site (`functions.wolfram.com/Bessel-TypeFunctions/*`) | HTTP 403 (consistent with the Erf R1 / R4 / Erf epic outcome). Where SymPy quotes a Wolfram formula-ID directly (e.g., the `nseries` docstring references), the SymPy quote is the secondary citation. |

### 17.3 Anchor documents inside the scientist-workbench

| Path | Content |
|---|---|
| `docs/HANDOFF_per_head_special_function_methodology.md` | The methodology this Phase 0 R1 is the first artefact of |
| `docs/adr/0023-cas-core-special-function-vocabulary.md` | Closed-vocabulary discipline; the constitutional document for §13's amendments |
| `docs/adr/0025-meijerg-symbolic-dispatch.md` | Dispatch shape `ReductionRule` (rule list shape pattern this artefact's §1-12 mirror) |
| `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md` | The Erf template ADR this Bessel epic repeats |
| `docs/refs/erf-research/R1-symbolic-identities.md` | Styling exemplar; section structure modelled on this |
| `packages/cas-core/src/special-functions.ts` | Current 4-head Bessel vocabulary + diff rules (lines 121-124, 174-177, 210-213, 539-611) |
| `packages/cas-core/src/special-funcs/erf-identities.ts` | The implementation template for `bessel-identities.ts` |
| `packages/cas-core/src/simplify.ts` | The dispatcher (`applyErfRewrites` pre-pass) that the Bessel identity layer will mirror |

---

## 18. Pointer trail (what the orchestrator does with this artefact)

1. **Synthesise R1 → R5 into ADR-0041** — model on ADR-0040; this
   document supplies the symbolic-identity layer; R2 supplies the
   arb-prec algorithm taxonomy; R3 the float64 algorithm choice; R4
   the Meijer-G bridge proposal; R5 the oracle landscape.
2. **In Phase 1 corpus design** (G1 — `bench/besselj-anchor/`), use
   §15.4's spherical-vs-half-integer canonicalisation decision to
   parameterise the T2 / T3 corpus tiers (small / medium / large `ν`,
   spanning integer, half-integer, generic-real).
3. **In Phase 2 substrate work** (I4 — `bessel-identities.ts`), use §16's
   30-rule scope as the rule-count target.
4. **In Phase 2 vocabulary amendment** (I6a — ADR-0023 update + the
   four new heads in `special-functions.ts`), use §13.4's diff list.
5. **In Phase 2 pattern-primitive helpers** (a new bead under I4),
   ship `isPositiveInteger`, `isNonNegativeInteger`, `isHalfInteger`
   per §14.5.
6. **In Phase 3 tool integration** (T1 / T2 / T3), validate that:
   - `integrate-1d ∫_0^1 J_0(z) dz` evaluates numerically (the
     existing `evalNumericExpr` dispatcher has Bessel float64 via
     `cephes` once R3 / I5 land);
   - `tools/special-eval --head=BesselJ --nu=0.5 --re=2.0` returns the
     elementary closure `√(4/π) · sin(2)` per rule 16 in §16;
   - the closed-vocabulary `Y` / `J` foreign-pass-through invariant
     survives Bessel-rule expansion (CLAUDE.md hallucination-callout:
     "Foreign-pass-through is a hard invariant").

---

*End of R1. The 30 v0.1-shippable rules in §16 are the canonical
target for `packages/cas-core/src/special-funcs/bessel-identities.ts`
once ADR-0041 lands.*
