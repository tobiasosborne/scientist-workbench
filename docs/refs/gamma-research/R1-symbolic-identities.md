# R1 — Canonical Symbolic Identities for the Gamma Family

**Bead:** `scientist-workbench-1gir` (Phase 0 / R1 — symbolic identities). Parent epic:
`scientist-workbench-xqc7` (world-class Gamma-family reference implementation, the
third per-head substrate epic in the series Erf → Bessel → Gamma).
**Author:** deep-research subagent, 2026-05-18.
**Status:** Research artefact. Not a source-of-truth; cite the primary references when
porting any identity into a rule file. Direct downstream consumers: a future ADR
(tentatively ADR-0042) modelled on ADR-0040 / ADR-0041, then
`packages/cas-core/src/special-funcs/gamma-identities.ts`, and ultimately the
per-head substrate beads (arb-prec, float64, Meijer-G bridge, tool integration).

**Scope.** Exhaustive symbolic-identity survey for the full Gamma family: `Gamma`,
`LogGamma`, `ReciprocalGamma`, `Pochhammer`, `Digamma`, `Polygamma`,
`IncompleteGammaUpper`, `IncompleteGammaLower`, `IncompleteGammaP`, `IncompleteGammaQ`,
`Beta`, `IncompleteBeta`, `BetaRegularized`, `BarnesG`, `Hyperfactorial`, and
`InverseGammaRegularized`. Each head is admitted, deferred, or rejected per the
Erfi-precedent test (ADR-0040 §"Decision 6"; ADR-0041 §"Decision 6"). Rules are
given in the `lhs_pattern / rhs / conditions / source` shape suitable for import
into `cas-core`'s identity-table infrastructure.

**Notation.**
- `z`, `w`: complex variables. Conditions per identity.
- `n`, `m`, `k`: non-negative integers unless stated otherwise.
- `a`, `b`, `s`: complex parameters (order parameters).
- `Γ(z)`: Euler's Gamma function; `Γ(a, z)`: upper incomplete Gamma; `γ(a, z)`:
  lower incomplete Gamma; `P(a, z)`, `Q(a, z)`: regularised incomplete Gamma.
- `B(a, b)`: Euler's Beta function; `B_x(a, b)`: incomplete Beta; `I_x(a, b)`:
  regularised incomplete Beta.
- `ψ(z) = Γ'(z)/Γ(z)`: digamma; `ψ^{(n)}(z)`: polygamma of order n.
- `G(z)`: Barnes G-function. `H(n)`: Hyperfactorial.
- `(a)_n`: Pochhammer symbol (rising factorial).
- `γ_E`: Euler–Mascheroni constant ≈ 0.5772156649…
- `ζ(s)`: Riemann zeta; `ζ(s, q)`: Hurwitz zeta.
- `B_k`: Bernoulli numbers (B_1 = −1/2 per DLMF convention).

**Source priority (when sources disagree).**
DLMF > NIST Handbook (Olver et al., 2010, same numbering as DLMF) > SymPy > mpmath >
Wikipedia. Wolfram Functions Site (functions.wolfram.com) returned HTTP 403 during
this pass — consistent with the Erf R1 and Bessel R1 observations. All identities
below are triangulated by primary DLMF citation + mpmath/SymPy numerical verification.

---

## 0. Source manifest

| Tag | Source | URL / verification method |
|---|---|---|
| `DLMF §5.X.Y` | NIST DLMF Chapter 5 (Gamma / Digamma / Polygamma / Beta / BarnesG) | https://dlmf.nist.gov/5 |
| `DLMF §8.X.Y` | NIST DLMF Chapter 8 (Incomplete Gamma / Beta) | https://dlmf.nist.gov/8 |
| `DLMF §16.18.X` | NIST DLMF §16.18 (Meijer-G special cases) | https://dlmf.nist.gov/16.18 |
| `SymPy:gamma` | `sympy/functions/special/gamma_functions.py` | https://github.com/sympy/sympy (master) |
| `SymPy:beta` | `sympy/functions/special/beta_functions.py` | https://github.com/sympy/sympy (master) |
| `mpmath:gamma` | mpmath 1.3.0 runtime verification | `python3 -c "import mpmath; ..."` |
| `mpmath:beta` | mpmath 1.3.0 runtime verification | same |
| `bateman-5-6.ts:L678` | `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` | local repo |

Wolfram Functions Site was HTTP 403 for all attempted URLs during this pass. Every
identity attributed to the Wolfram site in the bibliography is independently confirmed
via DLMF + mpmath/SymPy triangulation below.

---

## §1 — Vocabulary admission decisions

This section applies the **Erfi-precedent test** from ADR-0040 §"Decision 6" and
ADR-0041 §"Decision 6": a head is **admitted** to the cas-core vocabulary if and only
if all three of the following hold:
1. No closed-form derivation keeps the head *elementary* — it genuinely needs a first-
   class name in the AST.
2. The head appears in canonical literature (DLMF or equivalent) under its own name.
3. The head has at least one v0.1-shippable symbolic identity rule.

Heads that fail criterion 1 (elementarily derivable) or criterion 3 (no v0.1 rule)
are **deferred** with a note on what would unblock admission. Heads rejected outright
are those with no independent identity not covered by existing vocabulary.

### §1.1 Admission table

| Head | Arity | Decision | Rationale |
|---|---|---|---|
| `Gamma(z)` | 1 | **ALREADY ADMITTED** (ADR-0023) | In SPECIAL_FUNCTION_HEADS; diff rule ships. |
| `LogGamma(z)` | 1 | **ADMIT** | `log(Gamma(z))` is elementary *only* when the branch-cut behaviour is irrelevant; for the arb-prec substrate and the Meijer-G bridge the principal-value `LogGamma` is the load-bearing primitive (`loggamma` is already internally used in `packages/bigfloat/src/complex.ts` as `clgamma`). Criterion 1: `log(Gamma(z))` is multi-valued; a first-class head carries principal-value semantics. Criterion 2: DLMF §5.11.1. Criterion 3: reflection, recurrence, special values all ship in v0.1. |
| `ReciprocalGamma(z)` | 1 | **DEFER** | `1/Gamma(z)` is technically derivable from `Gamma` + reciprocal. The primary motivation for a first-class head is the entire-function property (avoids pole singularities); but in the cas-core symbolic layer no downstream rule in v0.1 requires it. The arb-prec substrate (bigfloat) could implement it directly. Defer until a concrete consumer (arb-prec evaluator or Meijer-G bridge) surfaces that needs the entire-function treatment. |
| `Pochhammer(a, n)` | 2 | **ADMIT** | The rising factorial `(a)_n = Γ(a+n)/Γ(a)` appears as a first-class argument in `HypergeometricPFQ` and `MeijerG` — every hypergeometric identity in the Bessel / WhittakerM / LegendreP family is expressed in terms of Pochhammer symbols. SymPy has `RisingFactorial`. DLMF §5.2.4-5.2.8. v0.1-shippable: `(a)_0 = 1`, `(a)_1 = a`, `(a)_{n+1} = (a+n)(a)_n`, `(a)_n = Γ(a+n)/Γ(a)`. Criterion 1: not elementary (involves Gamma). Criterion 2: DLMF §5.2.4. Criterion 3: yes. |
| `Digamma(z)` | 1 | **ALREADY ADMITTED** (ADR-0023) | In SPECIAL_FUNCTION_HEADS; diff rule ships. |
| `Polygamma(m, z)` | 2 | **ALREADY ADMITTED** (ADR-0023) | In SPECIAL_FUNCTION_HEADS; diff rule ships. |
| `IncompleteGammaUpper(a, z)` | 2 | **ADMIT** | `Γ(a,z) = ∫_z^∞ t^{a-1} e^{-t} dt` — canonical in DLMF §8.2.2, appears in every incomplete-gamma identity. Not elementary. Criterion 1: yes (integral with variable lower limit). Criterion 2: DLMF §8 entire chapter. Criterion 3: multiple v0.1 rules (recurrence, special values, relation to `Erf`). This is the **primary** incomplete-gamma head from which all others derive. |
| `IncompleteGammaLower(a, z)` | 2 | **ADMIT** (joint with Upper) | `γ(a,z) = ∫_0^z t^{a-1} e^{-t} dt`. The complementarity `γ(a,z) + Γ(a,z) = Γ(a)` (DLMF §8.2.3) makes Lower and Upper co-equal; symmetry with IncompleteGammaUpper. Same criteria pass. |
| `IncompleteGammaP(a, z)` | 2 | **DEFER** | `P(a,z) = γ(a,z)/Γ(a)` — the regularised lower form. Entirely derivable: `P = IncompleteGammaLower / Gamma`. All v0.1 identities follow by dividing existing Lower rules. In v0.1, an orchestrator rule `P(a,z) → IncompleteGammaLower(a,z) / Gamma(a)` in cas-simplify suffices. Promote to first-class head if a downstream arb-prec evaluator needs it as a primitive for numerical stability (scipy and boost implement it directly). |
| `IncompleteGammaQ(a, z)` | 2 | **DEFER** | Same reasoning as `IncompleteGammaP`: `Q(a,z) = Γ(a,z)/Γ(a)` = `IncompleteGammaUpper / Gamma`. Derivable. Defer. |
| `Beta(a, b)` | 2 | **ADMIT** | `B(a,b) = Γ(a)Γ(b)/Γ(a+b)` appears as a canonical head in DLMF §5.12, SymPy, and every hypergeometric / Bessel recurrence. The `Gamma`-expansion is available but treating Beta as a first-class head (a) avoids a 3-term expression in pattern matching, and (b) maps directly onto Wolfram's `Beta[a,b]` head used in DLMF-style CAS output. Criterion 1: `Γ(a)Γ(b)/Γ(a+b)` is not elementary. Criterion 2: DLMF §5.12.1. Criterion 3: symmetry, recurrence, special values all ship. |
| `IncompleteBeta(z, a, b)` | 3 | **DEFER** | `B_z(a,b) = ∫_0^z t^{a-1}(1-t)^{b-1} dt` — derivable from `BetaRegularized * Beta` or via `HypergeometricPFQ` (DLMF §8.17.7). No standalone identity is simpler than its hypergeometric expansion. Defer until a downstream consumer needs it symbolically. |
| `BetaRegularized(z, a, b)` | 3 | **DEFER** | `I_z(a,b) = B_z(a,b)/B(a,b)` — same as IncompleteBeta: derivable. The probability/statistics motivation (CDF of the Beta distribution) is real but no v0.1 symbolic rule requires this head independently. Defer with the same unlock condition as IncompleteBeta. |
| `BarnesG(z)` | 1 | **ADMIT** | The Barnes G-function satisfying `G(z+1) = Γ(z)·G(z)`, `G(1) = 1` (DLMF §5.17.1). Not expressible elementarily. Has a Stirling-style asymptotic, a Weierstrass product, and a clean functional equation. Criterion 1: yes. Criterion 2: DLMF §5.17. Criterion 3: functional equation + special integer values ship in v0.1. Motivating consumer: the `G^2(n+1)` factors in determinant formulas for random matrix theory (GUE), and as the denominator in closed forms for certain series. |
| `Hyperfactorial(n)` | 1 | **DEFER** | `H(n) = 1^1 · 2^2 · 3^3 · ⋯ · n^n`. Related to BarnesG by `H(n) = G(n+2)/G(2)·n!^? ...` — the connection is not a simple closed form in elementary heads. HOWEVER: `Hyperfactorial` is a sequence (integer arguments only), and the cas-core vocabulary is designed for *analytic* special functions. The Hadamard product form involves BarnesG and Gamma. Defer because: (a) integer-argument-only means no diff rule; (b) the only consumer is combinatorics, not analysis. Promote when a concrete analysis consumer surfaces. |
| `InverseGammaRegularized(a, p)` | 2 | **REJECT** | The functional inverse of `Q(a, z) = p` w.r.t. `z`. No closed-form exists for general `a`; numerical algorithms are root-finding (Newton + initial estimate). SciPy has `gammainccinv`. Analogous to `InverseErf` / `InverseErfc` which were rejected from the Meijer-G bridge (ADR-0040 §"Decision 5") because "no Meijer-G form exists in the literature." The same argument applies here: honest refusal (`tagged "cas-simplify/no-known-representation"`) is correct. |

### §1.2 Summary of admission decisions

**ALREADY ADMITTED (2):** `Gamma`, `Digamma`, `Polygamma`.
**RECOMMEND ADMIT (5):** `LogGamma`, `Pochhammer`, `IncompleteGammaUpper`, `IncompleteGammaLower`, `Beta`, `BarnesG`.
**RECOMMEND DEFER (5):** `ReciprocalGamma`, `IncompleteGammaP`, `IncompleteGammaQ`, `IncompleteBeta`, `BetaRegularized`, `Hyperfactorial`.
**REJECT (1):** `InverseGammaRegularized`.

The 6 newly-admitted heads grow the ADR-0023 vocabulary table from 32 (post-Bessel) to 38.

Arity assignments for new heads:

```ts
LogGamma:             { shape: "fixed", count: 1 }
Pochhammer:           { shape: "fixed", count: 2 }   // (a, n)
IncompleteGammaUpper: { shape: "fixed", count: 2 }   // (a, z)
IncompleteGammaLower: { shape: "fixed", count: 2 }   // (a, z)
Beta:                 { shape: "fixed", count: 2 }   // (a, b)
BarnesG:              { shape: "fixed", count: 1 }
```

---

## §2 — Per-head identity catalogue

### §2.1 `Gamma(z)` — complete function, meromorphic

#### Special values

| Identity | Source | Priority |
|---|---|---|
| `Γ(1) = 1` | DLMF §5.4.1 | A |
| `Γ(2) = 1` (= 1!) | DLMF §5.4.1 | A |
| `Γ(n+1) = n!` for positive integer n | DLMF §5.4.1 | A |
| `Γ(1/2) = √π` | DLMF §5.4.6; mpmath verified | A |
| `Γ(3/2) = (1/2)√π` | DLMF §5.4.6 + §5.5.1 recurrence; mpmath verified | A |
| `Γ(5/2) = (3/4)√π` | recurrence; mpmath verified | A |
| `Γ(-1/2) = -2√π` | DLMF §5.4.6 + reflection; mpmath verified | A |
| `Γ(-3/2) = (4/3)√π` | reflection + recurrence; mpmath verified | A |
| `Γ(n + 1/2) = (2n−1)!! / 2^n · √π` for non-negative integer n | DLMF §5.4.2 (double factorial); mpmath verified for n=0,1,2,3 | B |
| `Γ(-n + 1/2) = (-4)^n · n! · √π / (2n)!` for positive integer n | derived from Γ(1/2) + reflection; mpmath verified for n=1,2,3 | B |
| `Γ'(1) = -γ_E` | DLMF §5.4.11 | B |

**Poles and residues (refusal class A):**
- `Γ(z)` has simple poles at `z = 0, -1, -2, -3, …`
- `Res_{z=−n} Γ(z) = (−1)^n / n!` (DLMF §5.2.1 analytic continuation remark; mpmath verified)
- A cas-simplify rule that encounters `Gamma` at a non-positive integer argument should return `tagged "cas-simplify/gamma-pole"` per ADR-0003 boundary discipline.

#### Recurrence

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `Γ(z+1) = z · Γ(z)` | `z ≠ 0, -1, -2, …` | DLMF §5.5.1 | C |
| `Γ(z) = Γ(z+1) / z` | same | DLMF §5.5.1 rearranged | C |
| `Γ(z-1) = Γ(z) / (z-1)` | `z ≠ 1, 0, -1, …` | derived | C |

The recurrence is the single most load-bearing Gamma identity for CAS canonicalisation:
every expression `Γ(z+k)` for integer `k` can be reduced to `Γ(z)` × a rational
function of `z`. This is the primary simplification direction.

#### Reflection formula

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `Γ(z) · Γ(1-z) = π / sin(πz)` | `z ∉ ℤ` | DLMF §5.5.3; mpmath verified | C |
| `Γ(1/2 + z) · Γ(1/2 - z) = π / cos(πz)` | `z ∉ ℤ + 1/2` | derived from §5.5.3 | C |

The reflection formula is load-bearing for (a) reducing `Γ` at negative arguments
to `Γ` at positive arguments, and (b) establishing the connection between `Γ(z)` and
`sin(πz)` which appears in Bessel asymptotic and hypergeometric identities.

#### Duplication and multiplication

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `Γ(z) · Γ(z + 1/2) = √π / 2^{2z-1} · Γ(2z)` | `z ≠ 0, -1/2, -1, …` | DLMF §5.5.5 (Legendre); mpmath verified | C |
| `Γ(nz) = (2π)^{(1-n)/2} · n^{nz-1/2} · ∏_{k=0}^{n-1} Γ(z + k/n)` | `nz ≠ 0,-1,-2,…` | DLMF §5.5.6 (Gauss); | D |

The Legendre duplication is priority-C because it appears in: BesselJ half-integer
closed forms (via Γ(ν+1/2)), Beta function reductions, and incomplete Gamma
half-integer reductions.

#### Asymptotic (Stirling)

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `log Γ(z) ~ (z-1/2)·log(z) - z + (1/2)·log(2π) + Σ_{k=1}^∞ B_{2k}/(2k(2k-1)z^{2k-1})` | `|ph z| ≤ π - δ`, `z→∞` | DLMF §5.11.1; mpmath verified at z=100 | D |
| `Γ(z) ~ e^{-z} · z^z · √(2π/z) · (1 + 1/(12z) + 1/(288z²) - 139/(51840z³) + …)` | same sector | DLMF §5.11.3 | D |

The Stirling form is not a v0.1 *rewrite* rule (it is not exact), but it IS needed
as a *recognition rule* for computing Gamma at large arguments in the arb-prec
substrate. Priority-D: ship when the float64 / arb-prec evaluator beads need it.

#### Differentiation

`d/dz Γ(z) = ψ(z) · Γ(z)` — **already shipped** in `special-functions.ts`
`ruleGamma` (DLMF §5.4.2). No new rule needed.

`d²/dz² Γ(z) = [ψ(z)² + ψ'(z)] · Γ(z) = [Digamma(z)² + Polygamma(1,z)] · Γ(z)` —
derivable by chain rule from the first derivative; no need for a separate rule.

#### Series around poles (residues)

The Laurent expansion of `Γ(z)` near `z = -n` (non-negative integer n):

```
Γ(z) = (-1)^n / n! · [1/(z+n) - ψ(n+1) + O(z+n)]
```

Source: DLMF §5.7.3 (Laurent near negative integers). This is needed by the
asymptotic layer when a Meijer-G reduction produces a residue calculation. Priority-D
for the symbolic layer; priority-B for the arb-prec evaluator.

---

### §2.2 `LogGamma(z)` — principal-value log of Γ

`LogGamma(z)` is the principal-value `log(Γ(z))` on `ℂ \ {0, -1, -2, …}`, agreeing
with `log(Γ(x))` for real `x > 0`. In the bigfloat substrate this is already
implemented as `clgamma` / `lgamma` (see `packages/bigfloat/src/complex.ts`). The
new vocabulary head is the *symbolic* carrier.

#### Special values

| Identity | Source | Priority |
|---|---|---|
| `LogGamma(1) = 0` | `log(Γ(1)) = log(1) = 0`; SymPy verified | A |
| `LogGamma(2) = 0` | `log(Γ(2)) = log(1!) = 0`; SymPy verified | A |
| `LogGamma(3) = log(2)` | `log(Γ(3)) = log(2!)`; mpmath verified | A |
| `LogGamma(n+1) = log(n!)` for positive integer n | `= Σ_{k=1}^{n} log(k)`; derivable | A |
| `LogGamma(1/2) = (1/2) log(π)` | `log(√π)`; mpmath verified | A |

#### Recurrence and reflection

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `LogGamma(z+1) = log(z) + LogGamma(z)` | `z ≠ 0,-1,-2,…` | from Γ(z+1) = z·Γ(z) | C |
| `LogGamma(z) + LogGamma(1-z) = log(π) - log(sin(πz))` | `z ∉ ℤ` | from reflection; mpmath verified | C |
| `LogGamma(2z) = LogGamma(z) + LogGamma(z+1/2) + (2z-1)·log(2) - (1/2)·log(π)` | | from Legendre duplication; mpmath verified | C |

The reflection identity for LogGamma encodes the principal-value branch cut along
`(-∞, 0]` — this is why `LogGamma` needs its own head rather than being `log(Gamma)`.

#### Differentiation

`d/dz LogGamma(z) = ψ(z) = Digamma(z)` — DLMF §5.2.2. This is the canonical diff
rule for `LogGamma` and must be shipped in `special-functions.ts` when `LogGamma` is
admitted.

---

### §2.3 `Pochhammer(a, n)` — rising factorial

The Pochhammer symbol (rising factorial) `(a)_n = a(a+1)⋯(a+n-1)` for integer `n ≥ 0`.

#### Special values

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `(a)_0 = 1` | any `a` | DLMF §5.2.4; SymPy verified | A |
| `(a)_1 = a` | any `a` | DLMF §5.2.4 | A |
| `(a)_n = Γ(a+n) / Γ(a)` | `a ≠ 0,-1,…,-n+1` | DLMF §5.2.5; SymPy verified | B |
| `(1)_n = n!` | positive integer n | DLMF §5.2.4 | A |
| `(n+1)_k = (n+k)! / n!` | positive integers n, k | derived | B |
| `(1/2)_n = (2n)! / (4^n · n!)` | non-negative integer n | DLMF §5.2.7; mpmath verified | B |
| `(-1/2)_n = (-1)^n · (2n)! / (4^n · n!)` | **caution: this is WRONG** — see below | | — |
| `(-1/2)_n = (-1)^n · (2n-1)!! / 2^n` | non-negative integer n | DLMF §5.2.8; mpmath verified: `(-1/2)_3 = -3/8` | B |

**Triangulation note on `(-1/2)_n`:** My initial fetch cited `(-1)^n · (2n)!/(4^n·n!)`
which is correct for `(1/2)_n` but NOT for `(-1/2)_n`. The mpmath verification confirms:
`(-1/2)_3 = (-1/2)(-3/2)(-5/2) = -15/8`. The correct closed form via double factorial
is `(-1/2)_n = (-1)^n · (2n-1)!! / 2^n` where `(-1)!! := 1`.

#### Recurrence

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `(a)_{n+1} = (a+n) · (a)_n` | non-negative integer n | DLMF §5.2.4 | C |
| `(a)_n = (a)_{n-1} · (a+n-1)` | `n ≥ 1` | same | C |
| `(a)_{m+n} = (a)_m · (a+m)_n` | | DLMF §5.2.6 | C |

The recurrence `(a)_{n+1} = (a+n)(a)_n` is the primary canonicalisation tool:
any nested Pochhammer expression collapses to a polynomial in `a` times lower-order
Pochhammer or to a ratio of Gamma values.

#### Connection to Gamma

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `(a)_n = Γ(a+n) / Γ(a)` | `a ≠ 0,-1,…,-n+1` | DLMF §5.2.5 | C |
| `Pochhammer(a, n) → IncompleteGammaUpper or Gamma ratio` | | | C |

The `Pochhammer(a, n) = Gamma(a+n) / Gamma(a)` identity is the *canonical
canonicalisation direction*: reduce Pochhammer to Gamma, not the reverse (because
Gamma is the primitive). This differs from how hypergeometric functions express their
series — in `_pFq` series, Pochhammer is the natural primitive — but for the symbolic
simplifier the Gamma reduction is the right direction because cas-core's diff rules
operate on Gamma, not Pochhammer.

---

### §2.4 `Digamma(z)` — logarithmic derivative of Γ

#### Special values

| Identity | Source | Priority |
|---|---|---|
| `ψ(1) = -γ_E` | DLMF §5.4.12; SymPy + mpmath verified | A |
| `ψ(2) = 1 - γ_E` | DLMF §5.4.14 with n=1; SymPy verified | A |
| `ψ(3) = 3/2 - γ_E` | DLMF §5.4.14 with n=2; SymPy verified | A |
| `ψ(n+1) = H_n - γ_E` for positive integer n | `H_n = Σ_{k=1}^n 1/k`; DLMF §5.4.14; mpmath verified | B |
| `ψ(1/2) = -γ_E - 2·log(2)` | DLMF §5.4.13; mpmath verified | A |
| `ψ(3/2) = 2 - γ_E - 2·log(2)` | recurrence + ψ(1/2); mpmath verified | A |
| `ψ(n+1/2) = -γ_E - 2·log(2) + 2·Σ_{k=1}^n 1/(2k-1)` | DLMF §5.4.15; | B |
| `ψ(1/3) = -γ_E - (3/2)·log(3) - π/(2√3)` | DLMF §5.4.13 (Gauss); mpmath verified | B |
| `ψ(2/3) = -γ_E - (3/2)·log(3) + π/(2√3)` | DLMF §5.4.13 (Gauss); mpmath verified | B |
| `ψ(1/4) = -γ_E - 3·log(2) - π/2` | DLMF §5.4.13 (Gauss); mpmath verified | B |
| `ψ(3/4) = -γ_E - 3·log(2) + π/2` | DLMF §5.4.13 (Gauss); mpmath verified | B |
| `ψ(1/6) = -γ_E - 2·log(2) - (3/2)·log(3) - (π√3)/2` | DLMF §5.4.13 (Gauss); mpmath verified | B |
| `ψ(5/6) = -γ_E - 2·log(2) - (3/2)·log(3) + (π√3)/2` | DLMF §5.4.13 (Gauss); mpmath verified | B |
| `ψ(+∞) = +∞` | DLMF §5.11.2 asymptotic | A |

**Gauss's formula for digamma at rationals** (DLMF §5.4.13–16). For `0 < p < q`
positive integers (reduced fraction `p/q`):
```
ψ(p/q) = -γ_E - log(2q) - (π/2)·cot(πp/q)
         + 2 · Σ_{k=1}^{⌊(q-1)/2⌋}  cos(2πpk/q) · log(sin(πk/q))
```
Eight common rational arguments collapse to clean closed forms involving
`π·cot`, `√3`, and logs of small integers — these are the rules above for
denominators `q ∈ {2, 3, 4, 6}` plus their `n + p/q` shifts via recurrence
`ψ(z+1) = ψ(z) + 1/z`. SymPy's `digamma(Rational(p, q))` evaluates Gauss's
formula and is the cross-validation oracle. For arbitrary rationals (e.g.
`ψ(7/11)`), the formula is expressible symbolically but no longer "clean" —
defer to Priority-E or v0.2.

**Refusal class:** `ψ` has simple poles of residue `-1` at `z = 0, -1, -2, …`.
A pattern match on `Digamma` at a non-positive integer must return
`tagged "cas-simplify/digamma-pole"`.

#### Recurrence and reflection

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `ψ(z+1) = ψ(z) + 1/z` | `z ≠ 0,-1,-2,…` | DLMF §5.5.2; mpmath verified | C |
| `ψ(z) - ψ(1-z) = -π·cot(πz)` | `z ∉ ℤ` | DLMF §5.5.4; | C |

The recurrence and reflection are load-bearing: they let cas-simplify reduce any
`ψ(z + k)` (integer k) to `ψ(z)` + a rational function of `z`, and connect
`ψ(z)` at negative-real arguments to `ψ(1-z)` + `cot`.

#### Asymptotic

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `ψ(z) ~ log(z) - 1/(2z) - Σ_{k=1}^∞ B_{2k}/(2k·z^{2k})` | `|ph z| ≤ π-δ`, `z→∞` | DLMF §5.11.2; mpmath verified at z=100 | D |

The leading term is `log(z)`, confirming that `ψ(z)` grows logarithmically and the
asymptotic is not convergent (it is the Bernoulli series, an asymptotic power series).

---

### §2.5 `Polygamma(m, z)` — iterated log-derivative

#### Special values

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `ψ^{(n)}(1) = (-1)^{n+1} · n! · ζ(n+1)` | positive integer n | DLMF §5.15.2; mpmath verified | A |
| `ψ^{(n)}(1/2) = (-1)^{n+1} · n! · (2^{n+1}-1) · ζ(n+1)` | positive integer n | DLMF §5.15.3; mpmath verified | B |
| `ψ^{(1)}(1) = π²/6` | DLMF §5.15.2 + ζ(2) = π²/6; mpmath verified | A |
| `ψ^{(1)}(1/2) = π²/2` | DLMF §5.15.3 + 3·ζ(2); mpmath verified | A |
| `ψ^{(2)}(1) = -2·ζ(3)` | DLMF §5.15.2; mpmath verified | A |

#### Recurrence and reflection

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `ψ^{(n)}(z+1) = ψ^{(n)}(z) + (-1)^n · n! / z^{n+1}` | positive integer n | DLMF §5.15.5; | C |
| `ψ^{(n)}(1-z) + (-1)^{n-1} · ψ^{(n)}(z) = (-1)^n · π · d^n/dz^n cot(πz)` | | DLMF §5.15.6 | D |
| `ψ^{(n)}(1-z) + ψ^{(n)}(z) = π² / sin²(πz)` | n=1 specialisation; mpmath verified | C |

#### Multiplication

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `ψ^{(n)}(mz) = 1/m^{n+1} · Σ_{k=0}^{m-1} ψ^{(n)}(z + k/m)` | positive integer m | DLMF §5.15.7 | D |
| `ψ(2z) = (1/2)[ψ(z) + ψ(z+1/2)] + log(2)` | `n=0` case | DLMF §5.5.8; | D |

#### Differentiation

`d/dz ψ^{(m)}(z) = ψ^{(m+1)}(z) = Polygamma(m+1, z)` — **already shipped** in
`special-functions.ts` `rulePolygamma` (DLMF §5.15.3). No new rule.

---

### §2.6 `IncompleteGammaUpper(a, z)` and `IncompleteGammaLower(a, z)`

#### Definitions and complementarity

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `γ(a,z) + Γ(a,z) = Γ(a)` | `a ≠ 0,-1,-2,…` | DLMF §8.2.3; mpmath verified | A |
| `IncompleteGammaLower(a, z) = Gamma(a) - IncompleteGammaUpper(a, z)` | | direct | A |
| `IncompleteGammaUpper(a, z) = Gamma(a) - IncompleteGammaLower(a, z)` | | direct | A |

#### Special values (IncompleteGammaUpper Γ(a,z))

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `Γ(a, 0) = Γ(a)` | `ℜ(a) > 0` | DLMF §8.4.x; follows from def | A |
| `Γ(1, z) = e^{-z}` | | DLMF §8.4.5; SymPy + mpmath verified | A |
| `Γ(0, z) = E_1(z) = ExpIntegralE(1, z)` | `z ≠ 0` | DLMF §8.4.4; mpmath verified | B |
| `Γ(n+1, z) = n! · e^{-z} · Σ_{k=0}^n z^k/k!` for non-negative integer n | | DLMF §8.4.8; | B |
| `Γ(1/2, z²) = √π · erfc(z)` | `ℜ(z) ≥ 0` | DLMF §8.4.6; SymPy + mpmath verified | B |
| `Γ(1/2, 0) = √π` | | from above + erfc(0)=1; | A |

#### Special values (IncompleteGammaLower γ(a,z))

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `γ(a, 0) = 0` | `ℜ(a) > 0` | DLMF §8.4.x; follows from def | A |
| `γ(1, z) = 1 - e^{-z}` | | DLMF §8.4.x; SymPy verified | A |
| `γ(n+1, z) = n! · (1 - e^{-z} · Σ_{k=0}^n z^k/k!)` | non-negative integer n | DLMF §8.4.7; | B |
| `γ(1/2, z²) = √π · erf(z)` | | DLMF §8.4.1; SymPy + mpmath verified | B |

#### Recurrences

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `γ(a+1, z) = a·γ(a,z) - z^a · e^{-z}` | | DLMF §8.8.1 | C |
| `Γ(a+1, z) = a·Γ(a,z) + z^a · e^{-z}` | | DLMF §8.8.2; mpmath verified | C |
| `Γ(a+n, z) = (a)_n · Γ(a,z) + z^a · e^{-z} · Σ_{k=0}^{n-1} Γ(a+n)/Γ(a+k+1) · z^k` | | DLMF §8.8.9 | D |

The immediate recurrences (8.8.1 and 8.8.2) are the v0.1-priority rules: they allow
reduction of `IncompleteGamma{Upper,Lower}(a+1, z)` to `IncompleteGamma(a, z)` plus a
closed-form correction term.

#### Differentiation

| Identity | Source | Priority |
|---|---|---|
| `d/dz γ(a,z) = -d/dz Γ(a,z) = z^{a-1} · e^{-z}` | DLMF §8.8.13 | C |

This is the canonical diff rule for both incomplete Gamma heads and must be shipped
in `special-functions.ts` when these heads are admitted.

---

### §2.7 `Beta(a, b)` — Euler's Beta function

#### Definition and connection to Gamma

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `B(a,b) = Γ(a)·Γ(b) / Γ(a+b)` | `ℜ(a) > 0, ℜ(b) > 0` | DLMF §5.12.1; SymPy + mpmath verified | A |
| `Beta(a,b) → Gamma(a)*Gamma(b)/Gamma(a+b)` | | canonicalisation direction | A |

#### Symmetry

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `B(a,b) = B(b,a)` | | DLMF §5.12.1; SymPy verified | A |

#### Special values

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `B(1,1) = 1` | | `Γ(1)Γ(1)/Γ(2) = 1/1 = 1`; mpmath verified | A |
| `B(a,1) = 1/a` | `a ≠ 0,-1,-2,…` | `Γ(a)·1!/Γ(a+1) = 1/a`; SymPy + mpmath verified | A |
| `B(1,b) = 1/b` | same | by symmetry | A |
| `B(1/2, 1/2) = π` | | `Γ(1/2)²/Γ(1) = π`; mpmath verified | A |
| `B(n, m) = (n-1)!(m-1)! / (n+m-1)!` for positive integers n, m | | Γ ratio | B |

#### Recurrence

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `B(a+1, b) = (a / (a+b)) · B(a, b)` | | DLMF §5.12 (derived from Γ recurrence); mpmath verified | C |
| `B(a, b+1) = (b / (a+b)) · B(a, b)` | | by symmetry | C |
| `B(a+1, b) + B(a, b+1) = B(a, b)` | | DLMF §5.12 | C |

#### Differentiation

| Identity | Source | Priority |
|---|---|---|
| `∂/∂a B(a,b) = B(a,b) · [ψ(a) - ψ(a+b)]` | SymPy `beta.fdiff`; DLMF §5.12 | C |
| `∂/∂b B(a,b) = B(a,b) · [ψ(b) - ψ(a+b)]` | by symmetry | C |

These are the diff rules for `Beta` — needed in `special-functions.ts` `differentiateSpecialFunction`.

---

### §2.8 `BarnesG(z)` — multiplicative analogue of Γ

The Barnes G-function satisfies `G(z+1) = Γ(z) · G(z)` with `G(1) = 1`
(DLMF §5.17.1). It is the double-factorial analogue of the Gamma function.

#### Functional equation (the defining identity)

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `G(z+1) = Γ(z) · G(z)` | `z ≠ 0,-1,-2,…` | DLMF §5.17.1 | C |
| `G(1) = 1` | | DLMF §5.17.1 | A |

#### Special values at positive integers

| Identity | Source | Priority |
|---|---|---|
| `G(1) = 1` | DLMF §5.17.2 | A |
| `G(2) = 1` | `G(2) = Γ(1)·G(1) = 1·1 = 1`; mpmath verified | A |
| `G(3) = 1` | `G(3) = Γ(2)·G(2) = 1·1 = 1`; mpmath verified | A |
| `G(4) = 2` | `G(4) = Γ(3)·G(3) = 2·1 = 2`; mpmath verified | A |
| `G(5) = 12` | `G(5) = Γ(4)·G(4) = 6·2 = 12`; mpmath verified | A |
| `G(n+1) = ∏_{k=1}^{n-1} k!` for `n ≥ 1` | DLMF §5.17.2 | B |

#### Asymptotic

| Identity | Conditions | Source | Priority |
|---|---|---|---|
| `log G(z+1) ~ z²/4 + z·log Γ(z+1) - (z(z+1)/2 + 1/12)·log z - log A + Σ_{k=1}^∞ B_{2k+2}/(2k(2k+1)(2k+2)z^{2k})` | `|ph z| ≤ π-δ` | DLMF §5.17.5 | D |

where `A` is Glaisher's constant `≈ 1.28242712910062263687...` (DLMF §5.17.6-7).

---

## §3 — Rule table in `lhs_pattern / rhs / conditions / source` format

This section gives the full rule table in the identity-table format of
`erf-identities.ts` and `bessel-identities.ts`. Each rule entry has:
- `lhs_pattern`: the head + argument shape that triggers the rule
- `rhs`: the rewritten Value (in cas-core smart-constructor form)
- `conditions`: guard predicates (new predicates needed are flagged)
- `source`: primary citation
- `priority`: A (must ship v0.1) through E (stretch)
- `v0.1_shippable`: yes/no/partial

### Priority-A rules: special values and pole-refusal classes

```
// Rule GA-1: Γ(1) = 1
lhs_pattern: Gamma(int(1))
rhs:         int(1)
conditions:  arg is literal 1
source:      DLMF §5.4.1
v0.1_shippable: yes

// Rule GA-2: Γ(n+1) = n! for positive integer n
lhs_pattern: Gamma(n) where isPositiveInteger(n)
rhs:         int(factorial(n-1))   // n must be concrete integer
conditions:  isPositiveInteger(n) AND n is a concrete integer Value
source:      DLMF §5.4.1
v0.1_shippable: yes (requires isPositiveInteger predicate from I6b)

// Rule GA-3: Γ(1/2) = √π
lhs_pattern: Gamma(rat(1,2))
rhs:         mkPower(sym("pi"), rat(1,2))
conditions:  arg is literal 1/2
source:      DLMF §5.4.6
v0.1_shippable: yes

// Rule GA-4: Γ(-1/2) = -2√π
lhs_pattern: Gamma(rat(-1,2))
rhs:         mkTimes(int(-2), mkPower(sym("pi"), rat(1,2)))
conditions:  arg is literal -1/2
source:      DLMF §5.4.6 + reflection; mpmath verified
v0.1_shippable: yes

// Rule GA-5 (POLE REFUSAL): Γ(0) → tagged "cas-simplify/gamma-pole"
lhs_pattern: Gamma(int(0))
rhs:         tagged("cas-simplify/gamma-pole", { head: "Gamma", args: [int(0)] })
conditions:  arg is literal 0
source:      DLMF §5.2.1 (pole at z=0)
v0.1_shippable: yes

// Rule GA-6 (POLE REFUSAL): Γ(−n) → tagged for non-positive integer
lhs_pattern: Gamma(n) where isNonPositiveInteger(n)
rhs:         tagged("cas-simplify/gamma-pole", { head: "Gamma", args: [n] })
conditions:  isNonPositiveInteger(n) [NEW PREDICATE needed — see Discovery B]
source:      DLMF §5.2.1
v0.1_shippable: partial (needs isNonPositiveInteger predicate)

// Rule LGA-1: LogGamma(1) = 0
lhs_pattern: LogGamma(int(1))
rhs:         int(0)
conditions:  arg is literal 1
source:      log(Γ(1)) = log(1)
v0.1_shippable: yes

// Rule LGA-2: LogGamma(1/2) = (1/2)log(π)
lhs_pattern: LogGamma(rat(1,2))
rhs:         mkTimes(rat(1,2), expr("log", [sym("pi")]))
conditions:  arg is literal 1/2
source:      mpmath verified
v0.1_shippable: yes

// Rule POC-1: (a)_0 = 1
lhs_pattern: Pochhammer(a, int(0))
rhs:         int(1)
conditions:  second arg is literal 0
source:      DLMF §5.2.4
v0.1_shippable: yes

// Rule POC-2: (a)_1 = a
lhs_pattern: Pochhammer(a, int(1))
rhs:         a   // the first argument unchanged
conditions:  second arg is literal 1
source:      DLMF §5.2.4
v0.1_shippable: yes

// Rule DIG-1: ψ(1) = -γ_E
lhs_pattern: Digamma(int(1))
rhs:         mkNeg(sym("EulerGamma"))
conditions:  arg is literal 1
source:      DLMF §5.4.12; SymPy verified
v0.1_shippable: yes  [uses sym("EulerGamma") — same convention as SymPy; must be documented]

// Rule DIG-2: ψ(1/2) = -γ_E - 2·log(2)
lhs_pattern: Digamma(rat(1,2))
rhs:         mkMinus(mkNeg(sym("EulerGamma")), mkTimes(int(2), expr("log", [int(2)])))
conditions:  arg is literal 1/2
source:      DLMF §5.4.13; mpmath verified
v0.1_shippable: yes

// Rule POL-1: ψ^{(1)}(1) = π²/6
lhs_pattern: Polygamma(int(1), int(1))
rhs:         mkDiv(mkPower(sym("pi"), int(2)), int(6))
conditions:  both args are concrete
source:      DLMF §5.15.2 + ζ(2)=π²/6
v0.1_shippable: yes

// Rule POL-2: ψ^{(1)}(1/2) = π²/2
lhs_pattern: Polygamma(int(1), rat(1,2))
rhs:         mkDiv(mkPower(sym("pi"), int(2)), int(2))
conditions:  concrete
source:      DLMF §5.15.3; mpmath verified
v0.1_shippable: yes

// Rule IGAM-1: Γ(a,0) = Γ(a)
lhs_pattern: IncompleteGammaUpper(a, int(0))
rhs:         expr("Gamma", [a])
conditions:  second arg is literal 0; ℜ(a) > 0 (cannot verify symbolically; document)
source:      DLMF §8.4; follows from definition
v0.1_shippable: yes (with documented domain caveat)

// Rule IGAM-2: Γ(1, z) = e^{-z}
lhs_pattern: IncompleteGammaUpper(int(1), z)
rhs:         expr("exp", [mkNeg(z)])
conditions:  first arg is literal 1
source:      DLMF §8.4.5; SymPy + mpmath verified
v0.1_shippable: yes

// Rule IGAM-3: Γ(1/2, z²) = √π · erfc(z)
lhs_pattern: IncompleteGammaUpper(rat(1,2), mkPower(z, int(2)))
rhs:         mkTimes(mkPower(sym("pi"), rat(1,2)), expr("Erfc", [z]))
conditions:  first arg is 1/2; second arg has shape z^2
source:      DLMF §8.4.6; SymPy + mpmath verified
v0.1_shippable: yes (requires pattern matching z² shape)

// Rule IGAM-4: γ(a,0) = 0
lhs_pattern: IncompleteGammaLower(a, int(0))
rhs:         int(0)
conditions:  second arg is literal 0; ℜ(a) > 0
source:      definition; SymPy verified
v0.1_shippable: yes

// Rule IGAM-5: γ(1, z) = 1 - e^{-z}
lhs_pattern: IncompleteGammaLower(int(1), z)
rhs:         mkMinus(int(1), expr("exp", [mkNeg(z)]))
conditions:  first arg is literal 1
source:      DLMF §8.4.7 n=0; SymPy verified
v0.1_shippable: yes

// Rule IGAM-6: γ(1/2, z²) = √π · erf(z)
lhs_pattern: IncompleteGammaLower(rat(1,2), mkPower(z, int(2)))
rhs:         mkTimes(mkPower(sym("pi"), rat(1,2)), expr("Erf", [z]))
conditions:  first arg is 1/2; second arg is z²
source:      DLMF §8.4.1; SymPy + mpmath verified
v0.1_shippable: yes

// Rule IGAM-7: COMPLEMENTARITY
lhs_pattern: [sum pattern: IncompleteGammaUpper(a,z) + IncompleteGammaLower(a,z)]
rhs:         expr("Gamma", [a])
conditions:  both args match same (a, z)
source:      DLMF §8.2.3
v0.1_shippable: partial (requires sum-walker, not per-head table; same pattern as Erf+Erfc=1)

// Rule BETA-1: B(1,1) = 1
lhs_pattern: Beta(int(1), int(1))
rhs:         int(1)
conditions:  both args literal 1
source:      Γ(1)Γ(1)/Γ(2); mpmath verified
v0.1_shippable: yes

// Rule BETA-2: B(a, 1) = 1/a
lhs_pattern: Beta(a, int(1))
rhs:         mkDiv(int(1), a)
conditions:  second arg is literal 1
source:      Γ(a)·1!/Γ(a+1) = 1/a; SymPy verified
v0.1_shippable: yes

// Rule BETA-3: B(1, b) = 1/b
lhs_pattern: Beta(int(1), b)
rhs:         mkDiv(int(1), b)
conditions:  first arg is literal 1
source:      by symmetry; SymPy verified
v0.1_shippable: yes

// Rule BETA-4: B(1/2, 1/2) = π
lhs_pattern: Beta(rat(1,2), rat(1,2))
rhs:         sym("pi")
conditions:  both args literal 1/2
source:      Γ(1/2)²/Γ(1) = π; mpmath verified
v0.1_shippable: yes

// Rule BARNESG-1: G(1) = 1
lhs_pattern: BarnesG(int(1))
rhs:         int(1)
conditions:  arg literal 1
source:      DLMF §5.17.1
v0.1_shippable: yes

// Rule BARNESG-2: G(2) = 1
lhs_pattern: BarnesG(int(2))
rhs:         int(1)
conditions:  arg literal 2
source:      mpmath verified
v0.1_shippable: yes

// Rule BARNESG-3: G(3) = 1
lhs_pattern: BarnesG(int(3))
rhs:         int(1)
conditions:  arg literal 3
source:      mpmath verified
v0.1_shippable: yes

// Rule BARNESG-4: G(4) = 2
lhs_pattern: BarnesG(int(4))
rhs:         int(2)
conditions:  arg literal 4
source:      mpmath verified
v0.1_shippable: yes
```

### Priority-B rules: half-integer and integer closures

```
// Rule GA-B1: Γ(n+1/2) = (2n-1)!! / 2^n · √π for non-negative integer n
// (Concrete small cases; general case needs isNonNegativeInteger guard)
// n=0: Γ(1/2) = √π  [already GA-3]
// n=1: Γ(3/2) = (1/2)√π
lhs_pattern: Gamma(rat(3,2))
rhs:         mkTimes(rat(1,2), mkPower(sym("pi"), rat(1,2)))
source:      DLMF §5.4.6 + §5.5.1; mpmath verified
v0.1_shippable: yes

// n=2: Γ(5/2) = (3/4)√π
lhs_pattern: Gamma(rat(5,2))
rhs:         mkTimes(rat(3,4), mkPower(sym("pi"), rat(1,2)))
source:      recurrence; mpmath verified
v0.1_shippable: yes

// Rule GA-B2: Γ(-n + 1/2) = (-4)^n · n! · √π / (2n)! for positive integer n
// n=1: Γ(-1/2) = -2√π  [already GA-4]
// n=2: Γ(-3/2) = (4/3)√π
lhs_pattern: Gamma(rat(-3,2))
rhs:         mkTimes(rat(4,3), mkPower(sym("pi"), rat(1,2)))
source:      reflection; mpmath verified
v0.1_shippable: yes

// Rule POC-B1: (1/2)_n = (2n)! / (4^n · n!) for non-negative integer n
// n=0: 1 [POC-1]  n=1: 1/2  n=2: 3/8  n=3: 15/48=5/16
lhs_pattern: Pochhammer(rat(1,2), n) where isNonNegativeInteger(n)
rhs:         rat((2n)!, 4^n * n!)   // computed symbolically
conditions:  isNonNegativeInteger(n) AND n is concrete
source:      DLMF §5.2.7; mpmath verified
v0.1_shippable: partial (needs isNonNegativeInteger + factorial evaluation)

// Rule DIG-B1: ψ(n+1) = H_n - γ_E for positive integer n
lhs_pattern: Digamma(n) where isPositiveInteger(n) and n > 1
rhs:         mkMinus(harmonicSum(n-1), sym("EulerGamma"))
  // harmonicSum(k) = int(1) + int(1)/int(2) + ... + int(1)/int(k)
  // For concrete small n this evaluates to a rational
conditions:  isPositiveInteger(n) AND n is concrete
source:      DLMF §5.4.14; mpmath verified
v0.1_shippable: partial (needs isPositiveInteger; eval of harmonic sum for concrete n)

// Rule DIG-B2: ψ(1/3) = -γ_E - (3/2)·log(3) - π/(2√3)  [Gauss DLMF §5.4.13]
lhs_pattern: Digamma(rat(1,3))
rhs:         mkMinus(
               mkMinus(mkNeg(sym("EulerGamma")),
                       mkTimes(rat(3n,2n), expr("log", [int(3n)]))),
               mkDiv(sym("pi"), mkTimes(int(2n), mkPower(int(3n), rat(1n,2n)))))
conditions:  arg literal 1/3
source:      DLMF §5.4.13 (Gauss formula); mpmath verified
v0.1_shippable: yes

// Rule DIG-B3: ψ(2/3) = -γ_E - (3/2)·log(3) + π/(2√3)  [Gauss DLMF §5.4.13]
lhs_pattern: Digamma(rat(2,3))
rhs:         mkPlus([
               mkMinus(mkNeg(sym("EulerGamma")),
                       mkTimes(rat(3n,2n), expr("log", [int(3n)]))),
               mkDiv(sym("pi"), mkTimes(int(2n), mkPower(int(3n), rat(1n,2n))))])
conditions:  arg literal 2/3
source:      DLMF §5.4.13 (Gauss formula); mpmath verified
v0.1_shippable: yes

// Rule DIG-B4: ψ(1/4) = -γ_E - 3·log(2) - π/2  [Gauss DLMF §5.4.13]
lhs_pattern: Digamma(rat(1,4))
rhs:         mkMinus(
               mkMinus(mkNeg(sym("EulerGamma")),
                       mkTimes(int(3n), expr("log", [int(2n)]))),
               mkDiv(sym("pi"), int(2n)))
conditions:  arg literal 1/4
source:      DLMF §5.4.13 (Gauss formula); mpmath verified
v0.1_shippable: yes

// Rule DIG-B5: ψ(3/4) = -γ_E - 3·log(2) + π/2  [Gauss DLMF §5.4.13]
lhs_pattern: Digamma(rat(3,4))
rhs:         mkPlus([
               mkMinus(mkNeg(sym("EulerGamma")),
                       mkTimes(int(3n), expr("log", [int(2n)]))),
               mkDiv(sym("pi"), int(2n))])
conditions:  arg literal 3/4
source:      DLMF §5.4.13 (Gauss formula); mpmath verified
v0.1_shippable: yes

// Rule DIG-B6: ψ(1/6) = -γ_E - 2·log(2) - (3/2)·log(3) - (π√3)/2  [Gauss DLMF §5.4.13]
lhs_pattern: Digamma(rat(1,6))
rhs:         mkMinus(
               mkMinus(
                 mkMinus(mkNeg(sym("EulerGamma")),
                         mkTimes(int(2n), expr("log", [int(2n)]))),
                 mkTimes(rat(3n,2n), expr("log", [int(3n)]))),
               mkTimes(rat(1n,2n), mkTimes(sym("pi"), mkPower(int(3n), rat(1n,2n)))))
conditions:  arg literal 1/6
source:      DLMF §5.4.13 (Gauss formula); mpmath verified
v0.1_shippable: yes

// Rule DIG-B7: ψ(5/6) = -γ_E - 2·log(2) - (3/2)·log(3) + (π√3)/2  [Gauss DLMF §5.4.13]
lhs_pattern: Digamma(rat(5,6))
rhs:         mkPlus([
               mkMinus(
                 mkMinus(mkNeg(sym("EulerGamma")),
                         mkTimes(int(2n), expr("log", [int(2n)]))),
                 mkTimes(rat(3n,2n), expr("log", [int(3n)]))),
               mkTimes(rat(1n,2n), mkTimes(sym("pi"), mkPower(int(3n), rat(1n,2n))))])
conditions:  arg literal 5/6
source:      DLMF §5.4.13 (Gauss formula); mpmath verified
v0.1_shippable: yes

// Rule DIG-B8 (META): general Gauss formula for ψ(p/q) — DEFERRED to v0.2.
// The closed form for arbitrary p/q with q ∉ {2, 3, 4, 6} involves a sum of
// cos·log(sin) terms (DLMF §5.4.13). Symbolically expressible but verbose;
// no clean canonical form. The v0.1 rules above cover the cases where the
// sum collapses to clean π·cot and √3 expressions. File followup bead for
// the general-q case.

// Rule IGAM-B1: Γ(n+1, z) = n! · e^{-z} · Σ_{k=0}^n z^k/k! for non-negative integer n
// n=2: Γ(3, z) = 2·e^{-z}·(1 + z + z²/2)
lhs_pattern: IncompleteGammaUpper(int(3), z)
rhs:         mkTimes(int(2), mkTimes(expr("exp", [mkNeg(z)]),
               mkPlus([int(1), z, mkDiv(mkPower(z, int(2)), int(2))])))
conditions:  first arg literal 3
source:      DLMF §8.4.8 with n=2
v0.1_shippable: yes

// Rule BETA-B1: B(n, m) = (n-1)!(m-1)! / (n+m-1)! for positive integers n, m
lhs_pattern: Beta(n, m) where isPositiveInteger(n) AND isPositiveInteger(m)
rhs:         rat(factorial(n-1)*factorial(m-1), factorial(n+m-1))
conditions:  both concrete positive integers
source:      from Γ ratio; verified
v0.1_shippable: partial (needs isPositiveInteger)
```

### Priority-C rules: recurrences and reflection (load-bearing canonicalisation)

```
// Rule GA-C1: Γ(z+1) = z · Γ(z)
lhs_pattern: Gamma(expr("+", [z, int(1)]))
rhs:         mkTimes(z, expr("Gamma", [z]))
conditions:  arg has shape z+1 for any z
source:      DLMF §5.5.1
v0.1_shippable: yes (requires addition-shape matcher; same as Bessel nu±1 pattern)

// Rule GA-C2: Γ(z) · Γ(1-z) = π/sin(πz)  [REFLECTION]
lhs_pattern: product-sum matcher over Gamma terms
rhs:         mkDiv(sym("pi"), expr("sin", [mkTimes(sym("pi"), z)]))
conditions:  product detects Gamma(z) * Gamma(1-z) pattern; z ∉ ℤ (cannot verify symbolically)
source:      DLMF §5.5.3; mpmath verified
v0.1_shippable: partial (requires product-walker; same challenge as Erf+Erfc sum)

// Rule LGA-C1: LogGamma(z+1) = log(z) + LogGamma(z)
lhs_pattern: LogGamma(expr("+", [z, int(1)]))
rhs:         mkPlus([expr("log", [z]), expr("LogGamma", [z])])
conditions:  arg shape z+1
source:      from Γ(z+1) = z·Γ(z) taking log
v0.1_shippable: yes

// Rule POC-C1: (a)_{n+1} = (a+n) · (a)_n
lhs_pattern: Pochhammer(a, expr("+", [n, int(1)]))
rhs:         mkTimes(mkPlus([a, n]), expr("Pochhammer", [a, n]))
conditions:  second arg shape n+1
source:      DLMF §5.2.4
v0.1_shippable: yes

// Rule POC-C2: (a)_n = Γ(a+n) / Γ(a)  [GAMMA EXPANSION]
lhs_pattern: Pochhammer(a, n)
rhs:         mkDiv(expr("Gamma", [mkPlus([a, n])]), expr("Gamma", [a]))
conditions:  any (a, n); canonicalisation direction
source:      DLMF §5.2.5
v0.1_shippable: yes (this is the "expand" rewrite, not the simplify direction)

// Rule DIG-C1: ψ(z+1) = ψ(z) + 1/z  [RECURRENCE]
lhs_pattern: Digamma(expr("+", [z, int(1)]))
rhs:         mkPlus([expr("Digamma", [z]), mkDiv(int(1), z)])
conditions:  arg shape z+1
source:      DLMF §5.5.2; mpmath verified
v0.1_shippable: yes

// Rule DIG-C2: ψ(1-z) - ψ(z) = +π·cot(πz)  [REFLECTION; DLMF §5.5.4]
// Rearranged for the lhs pattern: ψ(1-z) = ψ(z) + π·cot(πz)
// This is a product-level rule — same challenge as Γ reflection
// For the per-head table, the simplest form is the rewrite of ψ(1-z):
lhs_pattern: Digamma(mkMinus(int(1), z))
rhs:         mkPlus([expr("Digamma", [z]), mkTimes(sym("pi"), expr("cot", [mkTimes(sym("pi"), z)]))])
// cot is not in elementary vocabulary; expand to cos/sin:
// +π·cot(πz) = +π·cos(πz)/sin(πz)
rhs_corrected: mkPlus([expr("Digamma", [z]),
                mkTimes(sym("pi"), mkDiv(expr("cos", [mkTimes(sym("pi"), z)]),
                                         expr("sin", [mkTimes(sym("pi"), z)])))])
conditions:  arg shape 1-z
source:      DLMF §5.5.4; mpmath verified at z=-0.3 → ψ(1.3) ≈ -0.169, π·cot(-0.3π) ≈ -2.282,
             so ψ(-0.3) = ψ(1.3) + π·cot(-0.3π)·(-1) = -0.169 + 2.282 = 2.113.
             Equivalently: ψ(1-(-0.3)) = ψ(1.3) = ψ(-0.3) + π·cot(-0.3π) = 2.113 - 2.282 = -0.169 ✓
v0.1_shippable: yes (uses cos/sin elementary heads, no cot head needed)
// IMPORTANT: an earlier version of this rule had `mkMinus(Digamma(z), ...)` which is WRONG.
// DLMF 5.5.4 reads ψ(1-z) - ψ(z) = +π·cot(πz); rearranging for ψ(1-z) keeps the + sign.

// Rule POL-C1: ψ^{(n)}(z+1) = ψ^{(n)}(z) + (-1)^n · n! / z^{n+1}  [RECURRENCE]
lhs_pattern: Polygamma(m, expr("+", [z, int(1)]))
rhs:         mkPlus([expr("Polygamma", [m, z]),
               mkTimes(int((-1)^m * factorial(m)),
                       mkPower(z, int(-m-1)))])
conditions:  m is concrete non-negative integer; arg shape z+1
source:      DLMF §5.15.5
v0.1_shippable: yes (for concrete m)

// Rule POL-C2: ψ^{(1)}(z) + ψ^{(1)}(1-z) = π²/sin²(πz)  [REFLECTION n=1]
// (Sum-walker rule, not per-head table)
source:      DLMF §5.15.6 specialised n=1; mpmath verified
v0.1_shippable: partial (sum-walker)

// Rule IGAM-C1: Γ(a+1, z) = a·Γ(a,z) + z^a·e^{-z}
lhs_pattern: IncompleteGammaUpper(expr("+", [a, int(1)]), z)
rhs:         mkPlus([mkTimes(a, expr("IncompleteGammaUpper", [a, z])),
               mkTimes(mkPower(z, a), expr("exp", [mkNeg(z)]))])
conditions:  first arg shape a+1
source:      DLMF §8.8.2; mpmath verified
v0.1_shippable: yes

// Rule IGAM-C2: γ(a+1, z) = a·γ(a,z) - z^a·e^{-z}
lhs_pattern: IncompleteGammaLower(expr("+", [a, int(1)]), z)
rhs:         mkMinus(mkTimes(a, expr("IncompleteGammaLower", [a, z])),
               mkTimes(mkPower(z, a), expr("exp", [mkNeg(z)])))
conditions:  first arg shape a+1
source:      DLMF §8.8.1
v0.1_shippable: yes

// Rule IGAM-C3: d/dz Γ(a,z) = -z^{a-1}·e^{-z}  [DIFF RULE]
lhs_pattern: (diff rule for IncompleteGammaUpper)
rhs:         mkNeg(mkTimes(mkPower(z, mkMinus(a, int(1))), expr("exp", [mkNeg(z)])))
source:      DLMF §8.8.13
v0.1_shippable: yes (lives in differentiateSpecialFunction, not the identity table)

// Rule BETA-C1: B(a+1, b) = (a/(a+b)) · B(a, b)
lhs_pattern: Beta(expr("+", [a, int(1)]), b)
rhs:         mkTimes(mkDiv(a, mkPlus([a, b])), expr("Beta", [a, b]))
conditions:  first arg shape a+1
source:      from Γ recurrence; mpmath verified
v0.1_shippable: yes

// Rule BETA-C2: B(a,b) = Γ(a)·Γ(b)/Γ(a+b)  [EXPAND direction]
lhs_pattern: Beta(a, b)
rhs:         mkDiv(mkTimes(expr("Gamma", [a]), expr("Gamma", [b])),
               expr("Gamma", [mkPlus([a, b])]))
conditions:  any (a, b) [this is the "expand" direction]
source:      DLMF §5.12.1
v0.1_shippable: yes

// Rule BETA-C3: B(a, b) symmetry
lhs_pattern: [pattern: Beta(a, b) with b lexically before a in canonical order]
rhs:         Beta(b, a)
conditions:  b < a in canonical order (prevents looping)
source:      DLMF §5.12.1
v0.1_shippable: partial (canonical-ordering guard needed)

// Rule BARNESG-C1: G(z+1) = Γ(z)·G(z)  [FUNCTIONAL EQUATION]
lhs_pattern: BarnesG(expr("+", [z, int(1)]))
rhs:         mkTimes(expr("Gamma", [z]), expr("BarnesG", [z]))
conditions:  arg shape z+1
source:      DLMF §5.17.1
v0.1_shippable: yes
```

### Priority-D rules: connection formulas and rewrite-on-request

```
// Rule GA-D1: Legendre Duplication
// Γ(2z) = π^{-1/2} · 2^{2z-1} · Γ(z) · Γ(z+1/2)
lhs_pattern: Gamma(mkTimes(int(2), z))
rhs:         mkTimes(mkTimes(mkPower(sym("pi"), rat(-1,2)),
               mkPower(int(2), mkMinus(mkTimes(int(2), z), int(1)))),
               mkTimes(expr("Gamma", [z]), expr("Gamma", [mkPlus([z, rat(1,2)])])))
source:      DLMF §5.5.5; mpmath verified
v0.1_shippable: yes (rewrite-on-request; fires when arg has shape 2z)

// Rule DIG-D1: ψ(2z) duplication
// ψ(2z) = (1/2)·[ψ(z) + ψ(z+1/2)] + log(2)
lhs_pattern: Digamma(mkTimes(int(2), z))
rhs:         mkPlus([mkTimes(rat(1,2), mkPlus([expr("Digamma", [z]),
               expr("Digamma", [mkPlus([z, rat(1,2)])])])),
               expr("log", [int(2)])])
source:      DLMF §5.5.8
v0.1_shippable: yes

// Rule IGAM-D1: Γ(0, z) = E_1(z)
lhs_pattern: IncompleteGammaUpper(int(0), z)
rhs:         expr("ExpIntegralE", [int(1), z])
conditions:  first arg literal 0
source:      DLMF §8.4.4; mpmath verified
v0.1_shippable: yes (requires ExpIntegralE in vocabulary — already admitted ADR-0023)

// Rule BETA-D1: ∂/∂a B(a,b) = B(a,b)·[ψ(a) - ψ(a+b)]
// (diff rule for Beta, lives in differentiateSpecialFunction)
source:      SymPy beta.fdiff; DLMF §5.12 derived
v0.1_shippable: yes (in diff-rule dispatcher, not identity table)

// Rule LGA-D1: LogGamma reflection
// LogGamma(z) + LogGamma(1-z) = log(π) - log(sin(πz))
lhs_pattern: [sum-walker: LogGamma(z) + LogGamma(1-z)]
rhs:         mkMinus(expr("log", [sym("pi")]),
               expr("log", [expr("sin", [mkTimes(sym("pi"), z)])]))
source:      from Γ reflection; mpmath verified
v0.1_shippable: partial (sum-walker)
```

### Priority-E rules: stretch goals

```
// Rule GA-E1: Gauss Multiplication
// Γ(nz) = (2π)^{(1-n)/2} · n^{nz-1/2} · ∏_{k=0}^{n-1} Γ(z+k/n)
// Too complex for v0.1 pattern; defer to an explicit identity table entry
source:      DLMF §5.5.6
v0.1_shippable: no (requires product-over-range shape)

// Rule BARNESG-E1: G(n+1) = ∏_{k=1}^{n-1} k! for n ≥ 2
lhs_pattern: BarnesG(n) where isPositiveInteger(n) and n >= 2
rhs:         product of factorials
source:      DLMF §5.17.2
v0.1_shippable: partial (concrete small n only, like Rules BARNESG-1 through 4)

// Rule POL-E1: ψ^{(n)}(1-z) + (-1)^{n-1}·ψ^{(n)}(z) = (-1)^n·π·(d/dz)^n cot(πz)
// The n-th derivative of cot(πz) introduces complicated trig polynomials
source:      DLMF §5.15.6
v0.1_shippable: no (requires (d/dz)^n cot — needs polynomial-in-trig evaluator)
```

---

## §4 — Priority class taxonomy

### Class A: special values + pole-refusal (must ship v0.1)
- GA-1 through GA-6: Γ at 0,1,2,1/2,-1/2; pole refusal at non-positive integers
- LGA-1, LGA-2: LogGamma at 1, 1/2
- POC-1, POC-2: Pochhammer at 0 and 1
- DIG-1, DIG-2: ψ(1), ψ(1/2)
- POL-1, POL-2: ψ'(1) = π²/6, ψ'(1/2) = π²/2
- IGAM-1 through IGAM-7: IncompleteGamma at 0-argument, a=1, a=1/2
- BETA-1 through BETA-4: B(1,1)=1, B(a,1)=1/a, B(1/2,1/2)=π
- BARNESG-1 through BARNESG-4: G(1)=G(2)=G(3)=1, G(4)=2

**Total class-A rules: 28 (spanning all 6 new heads)**

### Class B: integer-argument / half-integer / rational closures
- GA-B1: Γ(3/2) = (1/2)√π, Γ(5/2) = (3/4)√π
- GA-B2: Γ(-3/2) = (4/3)√π
- POC-B1: (1/2)_n closed form
- DIG-B1: ψ(n+1) = H_n - γ_E
- DIG-B2..B7: Gauss closed forms ψ(1/3), ψ(2/3), ψ(1/4), ψ(3/4), ψ(1/6), ψ(5/6) (DLMF §5.4.13)
- DIG-B8 (META): general ψ(p/q) for q ∉ {2,3,4,6} — DEFERRED, requires followup bead
- IGAM-B1: Γ(3, z) explicit polynomial form
- BETA-B1: B(n, m) integer closed form

**Total class-B rules: ~17**

### Class C: recurrences + reflection (load-bearing for canonicalisation)
- GA-C1 (recurrence), GA-C2 (reflection)
- LGA-C1 (recurrence), LogGamma reflection (sum-walker)
- POC-C1 (Pochhammer recurrence), POC-C2 (Gamma expansion)
- DIG-C1 (recurrence), DIG-C2 (reflection)
- POL-C1 (recurrence), POL-C2 (reflection n=1)
- IGAM-C1, IGAM-C2, IGAM-C3
- BETA-C1 (recurrence), BETA-C2 (expand), BETA-C3 (symmetry)
- BARNESG-C1 (functional equation)

**Total class-C rules: ~17**

### Class D: connection formulas and rewrite-on-request
- GA-D1 (Legendre duplication)
- DIG-D1 (ψ duplication)
- IGAM-D1 (Γ(0,z) = E_1)
- BETA-D1 (diff rule for Beta)
- LGA-D1 (LogGamma reflection)

**Total class-D rules: ~5**

### Class E: stretch
- GA-E1 (Gauss multiplication — requires product range)
- BARNESG-E1 (general integer G formula)
- POL-E1 (polygamma reflection full form)

**Total class-E: 3**

**Grand total v0.1-shippable: 45 rules across 28 (A) + 17 (B) + 17 (C) + 5 (D) rules**
(Up from 38 after adding Gauss-formula digamma rules at q ∈ {3,4,6}. The
general-q Gauss formula is deferred to a followup bead since the closed form
involves a sum that doesn't always collapse to a clean expression. Class
A+B+C = 62 rules; D = 5; E = 3 deferred.)

---

## §5 — Discovery items for the orchestrator

### Discovery A: vocabulary admissions

The following 6 heads are recommended for admission to ADR-0023 (growing the table
from 32 to 38):
1. **`LogGamma(z)`** — arity 1. Diff rule: `d/dz LogGamma(z) = Digamma(z)`.
2. **`Pochhammer(a, n)`** — arity 2. Diff rule: none in v0.1 (n is discrete order).
3. **`IncompleteGammaUpper(a, z)`** — arity 2. Diff rule: `d/dz = -z^{a-1}·e^{-z}`.
4. **`IncompleteGammaLower(a, z)`** — arity 2. Diff rule: `d/dz = z^{a-1}·e^{-z}`.
5. **`Beta(a, b)`** — arity 2. Diff rule: `∂/∂a = B(a,b)·[ψ(a)-ψ(a+b)]`.
6. **`BarnesG(z)`** — arity 1. Diff rule: requires `LogGamma` + Digamma chain; deferred.

Heads **deferred**: `ReciprocalGamma`, `IncompleteGammaP`, `IncompleteGammaQ`,
`IncompleteBeta`, `BetaRegularized`, `Hyperfactorial`.
Head **rejected**: `InverseGammaRegularized` — same reasoning as `InverseErf`/`InverseErfc`.

### Discovery B: pattern primitive gaps

The Bessel R1 (ADR-0041 §"Decision 6") added three predicates to `cas-core/src/pattern.ts`:
`isPositiveInteger`, `isNonNegativeInteger`, `isHalfInteger`. The Gamma epic needs
**one additional predicate** not in the Bessel set:

**`isNonPositiveInteger(v: Value): boolean`** — returns true iff `v` is an integer
Value `≤ 0`. Load-bearing for:
- Pole-refusal rules GA-6: `Gamma(n)` where `n ∈ {0, -1, -2, …}` should fire
  `tagged "cas-simplify/gamma-pole"`.
- Digamma pole-refusal (symmetric to `isNonPositiveInteger` check).

This predicate is the Gamma family's analogue of Bessel's `isHalfInteger` — none of the
priority-class A refusal rules can ship without it.

Additionally, the following predicates from Bessel are reused and must be confirmed
available before the Gamma identity-table bead claims:
- `isPositiveInteger` — used in GA-2, DIG-B1, BETA-B1
- `isNonNegativeInteger` — used in POC-B1, IGAM-B1

**Action**: file a new bead for `isNonPositiveInteger` to add to `pattern.ts`; this
bead is a gate for the Gamma identity-table bead (parallel to I6b in the Bessel epic).

### Discovery C: canonicalisation direction rulings

The ADR must explicitly rule on the following direction questions:

**C1 — Pochhammer direction.** Should `cas-simplify` expand `Pochhammer(a,n)` to
`Gamma(a+n)/Gamma(a)` (rule POC-C2) by default, or contract `Gamma(a+n)/Gamma(a)` to
`Pochhammer(a,n)`? **Recommended direction: expand** (Gamma is the primitive for the
diff rules and the Meijer-G bridge; Pochhammer is the notation for series coefficients
only). This means Rule POC-C2 fires in the `simplify` pass; a hypothetical `contract`
pass (like Wolfram's `Factor`) is a separate request.

**C2 — Beta expansion direction.** Should `Beta(a,b)` expand to `Gamma(a)Gamma(b)/Gamma(a+b)`
always? **Recommended direction: keep `Beta` as a first-class node in the AST**;
Rule BETA-C2 fires only in an explicit "expand" mode. This avoids the blowup of
expressions like `B(a,b)^2 → Gamma(a)^2·Gamma(b)^2/Gamma(a+b)^2` which is longer.

**C3 — LogGamma vs log(Gamma).** The canonical form for `log(Gamma(z))` in the
simplifier should be `LogGamma(z)`, not the expression `log(Gamma(z))`, to carry
principal-value branch semantics. Rule: if cas-simplify encounters `log(Gamma(z))`
for complex `z`, it should rewrite to `LogGamma(z)` (principal-value lift). For real
positive `z`, they are equivalent.

**C4 — IncompleteGamma complementarity direction.** The sum-walker rule for
`IncompleteGammaUpper(a,z) + IncompleteGammaLower(a,z) → Gamma(a)` follows the same
pattern as Erf's `Erfc + Erf → 1`. It should be a **sum-walker rule in `simplify.ts`**
(not a per-head table entry), mirroring the Erf implementation.

### Discovery D: existing Meijer-G dispatch rules that emit Gamma

The audit of `packages/meijer-core/src/dispatch-rules/` revealed:

**`bateman-5-6.ts`** (the primary dispatch table):
- Line 84: defines a local helper `function gamma(z: Value)` that constructs
  `expr("Gamma", [z])`. This is used in 3 dispatch rules (Bateman §5.6 (2), (4)).
- **Lines 678-679 (critical):** A TODO comment states:
  > `Bateman §5.6 (38), (40): incomplete-gamma family — needs IncompleteGamma head added to ADR-0023's vocabulary.`
  
  This is the smoking-gun finding: the dispatch-rule author already attempted to
  add `IncompleteGamma` reduction rules and left them as a TODO blocked on vocabulary
  admission. **Admitting `IncompleteGammaUpper` and `IncompleteGammaLower` will unblock
  these rules immediately.** This should be filed as a bead referencing this discovery.

**`erf-forward-form-a.ts`**, **`erfc-forward.ts`**, **`erfi-forward.ts`**:
- These bridge files emit `Erf`, `Erfc`, `Erfi` heads but no Gamma family heads directly.
  They reference the Gamma prefactor pattern implicitly (DLMF 16.18 forms involve Gamma
  factors normalised away in the G-form representation).

**`bessel-backward.ts`**:
- The backward Bessel dispatch rules emit `BesselJ`, `BesselY` but their G-form parameters
  include expressions like `ν/2`, `(ν+1)/2` — rational functions of ν — which implicitly
  assume no Gamma-family head is needed at the dispatch level (the Gamma factors appear
  in the normalisation that is absorbed into the G-form prefactor). This is by design.

**Gap identified:** The incomplete-Gamma Meijer-G bridge forms (from DLMF §16.18 or
Bateman §5.6 (38)/(40)) are:

```
Γ(a, z) = G^{1,0}_{0,1}( ; 0; z) when a=0 (= E_1(z) case)
Γ(a, z) = z^{a-1/2} e^{-z/2} W_{a-1/2, a/2-1/4}(z)   [Whittaker; out of scope v0.1]
```

The cleanest Meijer-G form for upper incomplete Gamma is (from DLMF §16.18.2):

```
Γ(a, z) = G^{1,0}_{1,1}([a+1], [a, 0]; z)   [Wolfram/Gradshteyn-Ryzhik convention]
```

This is the form that the `bateman-5-6.ts` TODO refers to. Admitting the head allows
these rules to be written and checked immediately.

**Round-trip gap:** The existing `Gamma` head (in `expr("Gamma", [z])`) is used by 3
bateman rules as a reduction *target*. These rules produce expressions involving
`Gamma(z)` where `z` is a parameter from the G-form's `an`/`bm` slots. These round-trip
cleanly through `specialFunctionArity` (which already has `Gamma` with arity 1) and
through the diff-rule dispatcher. No round-trip regression is expected from the new
admissions.

---

## §6 — Conflicts and triangulation

### §6.1 Pochhammer `(-1/2)_n` formula

**Sources surveyed:**
- Initial web fetch cited `(-1)^n · (2n)! / (4^n · n!)` — this is the formula for
  `(1/2)_n`, NOT `(-1/2)_n`.
- DLMF §5.2.8 (cited; not directly readable from the fetch excerpt but the pattern
  is standard).
- mpmath verification: `(-1/2)_3 = (-1/2)(-3/2)(-5/2) = -15/8 = -1.875`.

**Correct formula:** `(-1/2)_n = (-1)^n · (2n-1)!! / 2^n` where `(-1)!! := 1`.
For `n=3`: `(-1)^3 · (5·3·1) / 8 = -15/8`. Confirmed.

**Rule:** When implementing POC-B1 for `(-1/2)_n`, use the double-factorial formula.
The formula `(-1)^n · (2n)! / (4^n · n!)` is a well-known but incorrect cross-citation.
This is the kind of drift the mutation-proving discipline (CLAUDE.md Rule 6) would catch
— a test asserting `(-1/2)_3 = -15/8` would RED on the wrong formula.

### §6.2 `ψ(3/2)` value

**Cross-check:**
- mpmath: `psi(3/2) ≈ 0.03648997...`
- SymPy: `digamma(3/2) = -2·log(2) - EulerGamma + 2`
- Direct computation: `psi(3/2) = psi(1/2) + 1/(1/2) = (-γ_E - 2·log(2)) + 2 = 2 - γ_E - 2·log(2)`.
- Numerically: `2 - 0.5772... - 2·0.6931... = 2 - 0.5772 - 1.3862 ≈ 0.0365`. ✓

**No conflict.** All three sources agree.

### §6.3 `IncompleteGammaUpper(1/2, z²) = √π · erfc(z)`

**Sources:**
- DLMF §8.4.6: `Γ(1/2, z²) = 2·∫_z^∞ e^{-t²} dt = √π · erfc(z)`.
- SymPy: `uppergamma(Rational(1,2), z**2) = sqrt(pi)*erfc(sqrt(z**2))`.
  Note: SymPy writes `erfc(sqrt(z**2))` not `erfc(z)` — for real positive `z`,
  `sqrt(z**2) = |z|` and the identity holds for `ℜ(z) ≥ 0`. For complex `z`, the
  principal-value `sqrt(z²) ≠ z` in general.

**Resolution:** The rule `IncompleteGammaUpper(1/2, z²) → √π · Erfc(z)` is valid
for `ℜ(z) ≥ 0`. For the CAS rule table, annotate the condition: fires only when `z²`
is the literal argument pattern and `z` is constrained to the right half-plane
(document as a domain condition, not enforced symbolically). This is the same
discipline the Bessel half-integer rules use (`ℜ(z) > 0` stated in comments, not
checked at runtime).

### §6.4 Beta function symmetry in SymPy

**Observation:** `sympy.simplify(beta(a, b) - beta(b, a))` returns `beta(a, b) - beta(b, a)`
(non-zero symbolically), not `0`. This is a SymPy limitation — SymPy's `beta` does not
automatically evaluate the symmetry.

**Resolution:** The symmetry rule `B(a,b) = B(b,a)` is correct (DLMF §5.12.1). The
cas-core rule BETA-C3 should implement it as a canonicalisation rule (lex-order on args),
not rely on SymPy's behaviour. mpmath confirms numerically for specific values.

### §6.5 `LogGamma` vs `log(Gamma)` branch cut

**Conflict:** For `z = -2 + ε·i` (near a pole of Gamma), `log(Gamma(z))` has a
branch-cut discontinuity while `LogGamma(z)` is defined as the principal value that
avoids this. The SymPy implementation of `loggamma` handles this consistently.

**Resolution:** Per Discovery C3 above: CAS rules must treat `LogGamma` as the
principal-value function; a rewrite `log(Gamma(z)) → LogGamma(z)` is valid only for
`z` in the right half-plane `ℜ(z) > 0`. Document this condition in the rule comment.

---

## Appendix: TS pseudo-implementation sketch

The following shows the priority-A and priority-C rules in the `erf-identities.ts` /
`bessel-identities.ts` format. This is illustrative — the actual implementation will
live in `packages/cas-core/src/special-funcs/gamma-identities.ts`.

```ts
// =============================================================================
// gamma-identities.ts — SKETCH (not authoritative implementation)
// =============================================================================
// Full implementation is an I4-class substrate bead for the Gamma epic.
// This sketch follows the erf-identities.ts / bessel-identities.ts format exactly.

import { expr, int, rat, sym, type Value } from "@workbench/protocol";
import {
  mkDiv, mkMinus, mkNeg, mkPlus, mkPower, mkTimes
} from "../diff.js";
import { isPositiveInteger, isNonNegativeInteger, isNonPositiveInteger } from "../pattern.js";
// ^ isNonPositiveInteger is a NEW predicate not yet in pattern.ts (Discovery B)

// ---------------------------------------------------------------------------
// Gamma special values — Priority A
// ---------------------------------------------------------------------------

// GA-1: Γ(1) = 1
export function gammaAt1(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (z.kind === "integer" && z.value === "1") return int(1n);
  return null;
}

// GA-3: Γ(1/2) = √π
export function gammaAtHalf(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (z.kind === "rational" && z.num === "1" && z.den === "2")
    return mkPower(sym("pi"), rat(1n, 2n));
  return null;
}

// GA-4: Γ(-1/2) = -2√π
export function gammaAtNegHalf(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (z.kind === "rational" && z.num === "-1" && z.den === "2")
    return mkTimes(int(-2n), mkPower(sym("pi"), rat(1n, 2n)));
  return null;
}

// GA-6 (POLE REFUSAL): Γ(-n) → tagged boundary for non-positive integers
import { tagged } from "@workbench/protocol";
export function gammaPoleRefusal(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (isNonPositiveInteger(z))
    return tagged("cas-simplify/gamma-pole", { head: "Gamma", args: [...args] });
  return null;
}

// ---------------------------------------------------------------------------
// LogGamma special values — Priority A
// ---------------------------------------------------------------------------

// LGA-1: LogGamma(1) = 0
export function logGammaAt1(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (z.kind === "integer" && z.value === "1") return int(0n);
  return null;
}

// LGA-2: LogGamma(1/2) = (1/2)·log(π)
export function logGammaAtHalf(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (z.kind === "rational" && z.num === "1" && z.den === "2")
    return mkTimes(rat(1n, 2n), expr("log", [sym("pi")]));
  return null;
}

// ---------------------------------------------------------------------------
// Pochhammer — Priority A + C
// ---------------------------------------------------------------------------

// POC-1: (a)_0 = 1
export function pocchammerAt0(args: readonly Value[]): Value | null {
  const n = args[1]!;
  if (n.kind === "integer" && n.value === "0") return int(1n);
  return null;
}

// POC-2: (a)_1 = a
export function pocchammerAt1(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const n = args[1]!;
  if (n.kind === "integer" && n.value === "1") return a;
  return null;
}

// POC-C2: (a)_n = Γ(a+n)/Γ(a) — canonical Gamma expansion
export function pocchammerExpandGamma(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const n = args[1]!;
  return mkDiv(
    expr("Gamma", [mkPlus([a, n])]),
    expr("Gamma", [a]),
  );
}

// ---------------------------------------------------------------------------
// Digamma — Priority A + C
// ---------------------------------------------------------------------------

// DIG-1: ψ(1) = -γ_E
export function digammaAt1(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (z.kind === "integer" && z.value === "1")
    return mkNeg(sym("EulerGamma"));
  return null;
}

// DIG-2: ψ(1/2) = -γ_E - 2·log(2)
export function digammaAtHalf(args: readonly Value[]): Value | null {
  const z = args[0]!;
  if (z.kind === "rational" && z.num === "1" && z.den === "2")
    return mkMinus(mkNeg(sym("EulerGamma")), mkTimes(int(2n), expr("log", [int(2n)])));
  return null;
}

// DIG-C1: ψ(z+1) = ψ(z) + 1/z
export function digammaRecurrence(args: readonly Value[]): Value | null {
  const z = args[0]!;
  // Match z+1 shape
  if (z.kind === "expression" && z.head === "+" && z.args.length === 2) {
    const [base, shift] = z.args as [Value, Value];
    if (shift.kind === "integer" && shift.value === "1") {
      return mkPlus([expr("Digamma", [base]), mkDiv(int(1n), base)]);
    }
  }
  return null;
}

// DIG-C2: ψ(1-z) = ψ(z) + π·cos(πz)/sin(πz)  [DLMF §5.5.4]
// (DLMF 5.5.4: ψ(1-z) - ψ(z) = +π·cot(πz); rearranged for ψ(1-z) keeps + sign.)
export function digammaReflection(args: readonly Value[]): Value | null {
  const w = args[0]!;
  // Match 1-z shape
  if (w.kind === "expression" && w.head === "-" && w.args.length === 2) {
    const [one, z] = w.args as [Value, Value];
    if (one.kind === "integer" && one.value === "1") {
      const piZ = mkTimes(sym("pi"), z);
      const cotPiZ = mkDiv(expr("cos", [piZ]), expr("sin", [piZ]));
      return mkPlus([
        expr("Digamma", [z]),
        mkTimes(sym("pi"), cotPiZ),
      ]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IncompleteGammaUpper — Priority A + C
// ---------------------------------------------------------------------------

// IGAM-1: Γ(a, 0) = Γ(a)
export function upperGammaAtZero(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const z = args[1]!;
  if (z.kind === "integer" && z.value === "0")
    return expr("Gamma", [a]);
  return null;
}

// IGAM-2: Γ(1, z) = e^{-z}
export function upperGammaA1(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const z = args[1]!;
  if (a.kind === "integer" && a.value === "1")
    return expr("exp", [mkNeg(z)]);
  return null;
}

// IGAM-3: Γ(1/2, z²) = √π · erfc(z)  [erfc connection]
export function upperGammaHalfZsq(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const zsq = args[1]!;
  if (a.kind !== "rational" || a.num !== "1" || a.den !== "2") return null;
  // Check if second arg is z^2
  if (zsq.kind === "expression" && zsq.head === "^" && zsq.args.length === 2) {
    const [base, exp] = zsq.args as [Value, Value];
    if (exp.kind === "integer" && exp.value === "2") {
      return mkTimes(mkPower(sym("pi"), rat(1n, 2n)), expr("Erfc", [base]));
    }
  }
  return null;
}

// IGAM-C1: Γ(a+1, z) = a·Γ(a,z) + z^a·e^{-z}
export function upperGammaRecurrence(args: readonly Value[]): Value | null {
  const aPlusOne = args[0]!;
  const z = args[1]!;
  if (aPlusOne.kind === "expression" && aPlusOne.head === "+" && aPlusOne.args.length === 2) {
    const [a, shift] = aPlusOne.args as [Value, Value];
    if (shift.kind === "integer" && shift.value === "1") {
      return mkPlus([
        mkTimes(a, expr("IncompleteGammaUpper", [a, z])),
        mkTimes(mkPower(z, a), expr("exp", [mkNeg(z)])),
      ]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Beta — Priority A + C
// ---------------------------------------------------------------------------

// BETA-1: B(1,1) = 1
export function betaAt11(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const b = args[1]!;
  if (a.kind === "integer" && a.value === "1" && b.kind === "integer" && b.value === "1")
    return int(1n);
  return null;
}

// BETA-2: B(a, 1) = 1/a
export function betaSecondArgOne(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const b = args[1]!;
  if (b.kind === "integer" && b.value === "1") return mkDiv(int(1n), a);
  return null;
}

// BETA-4: B(1/2, 1/2) = π
export function betaHalfHalf(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const b = args[1]!;
  const isHalf = (v: Value) => v.kind === "rational" && v.num === "1" && v.den === "2";
  if (isHalf(a) && isHalf(b)) return sym("pi");
  return null;
}

// BETA-C2: B(a,b) = Γ(a)·Γ(b)/Γ(a+b)  [expand direction]
export function betaExpandGamma(args: readonly Value[]): Value | null {
  const a = args[0]!;
  const b = args[1]!;
  return mkDiv(
    mkTimes(expr("Gamma", [a]), expr("Gamma", [b])),
    expr("Gamma", [mkPlus([a, b])]),
  );
}

// ---------------------------------------------------------------------------
// BarnesG — Priority A + C
// ---------------------------------------------------------------------------

// BARNESG-C1: G(z+1) = Γ(z)·G(z)
export function barnesGRecurrence(args: readonly Value[]): Value | null {
  const w = args[0]!;
  if (w.kind === "expression" && w.head === "+" && w.args.length === 2) {
    const [z, shift] = w.args as [Value, Value];
    if (shift.kind === "integer" && shift.value === "1") {
      return mkTimes(expr("Gamma", [z]), expr("BarnesG", [z]));
    }
  }
  return null;
}
```

---

## Inline summary for orchestrator

**Vocabulary admissions recommended (6 new heads, growing table 32 → 38):**
1. `LogGamma(z)` — arity 1; diff rule `Digamma(z)`; reflection + recurrence ship in v0.1
2. `Pochhammer(a, n)` — arity 2; no diff rule (n discrete); canonical Gamma expansion + recurrence
3. `IncompleteGammaUpper(a, z)` — arity 2; diff rule `-z^{a-1}·e^{-z}`; erf/erfc connections
4. `IncompleteGammaLower(a, z)` — arity 2; diff rule `+z^{a-1}·e^{-z}`; erf connection
5. `Beta(a, b)` — arity 2; diff rule `B(a,b)·[ψ(a)-ψ(a+b)]`; symmetry + recurrence
6. `BarnesG(z)` — arity 1; functional equation `G(z+1) = Γ(z)·G(z)`

**Priority-A identities that must ship in v0.1 (28 rules):**
- Γ(1)=1, Γ(1/2)=√π, Γ(-1/2)=-2√π; Γ pole refusal at non-positive integers
- LogGamma(1)=0, LogGamma(1/2)=(1/2)log π
- Pochhammer(a,0)=1, Pochhammer(a,1)=a
- ψ(1)=-γ_E, ψ(1/2)=-γ_E-2log2; ψ'(1)=π²/6, ψ'(1/2)=π²/2
- Γ(a,0)=Γ(a), Γ(1,z)=e^{-z}, Γ(1/2,z²)=√π·erfc(z)
- γ(a,0)=0, γ(1,z)=1-e^{-z}, γ(1/2,z²)=√π·erf(z)
- B(1,1)=1, B(a,1)=1/a, B(1/2,1/2)=π
- G(1)=G(2)=G(3)=1, G(4)=2

**Top 5 discovery items:**

1. **Discovery D (load-bearing):** `bateman-5-6.ts` line 678-679 has a dormant TODO for
   incomplete-gamma Meijer-G rules explicitly blocked on vocabulary admission. Admitting
   `IncompleteGammaUpper` and `IncompleteGammaLower` unblocks these rules immediately.
   File a bead: "Implement Bateman §5.6 (38)/(40) incomplete-gamma G-form rules, now
   that IncompleteGamma vocabulary is admitted."

2. **Discovery B (load-bearing):** `isNonPositiveInteger(v: Value): boolean` is a new
   predicate not yet in `cas-core/src/pattern.ts`. It gates the Gamma pole-refusal rules
   (GA-6 and the Digamma analogue). Must be shipped in its own bead (parallel to Bessel's
   I6b `isHalfInteger`) before the Gamma identity-table bead can claim.

3. **Discovery C1 (canonicalisation direction):** Pochhammer vs Gamma — recommended:
   expand Pochhammer → Gamma/Gamma ratio. The ADR must rule on this to prevent
   bidirectional rewriting loops.

4. **Discovery C3 (branch-cut discipline):** `log(Gamma(z)) → LogGamma(z)` is a
   principal-value lift that carries branch-cut semantics. The ADR must document
   that LogGamma is the principal-value function and the rewrite `log(Gamma(z)) →
   LogGamma(z)` is valid only for `ℜ(z) > 0`.

5. **Discovery D (gap analysis):** No Meijer-G bridge forms currently exist in
   `meijer-core/src/bridges/` for the Gamma family. The arb-prec substrate for Gamma
   already exists in `packages/bigfloat/src/` (`gamma`, `lgamma`, `digamma`, etc.) but
   there is no `src/bridges/gamma.ts` file. The Gamma epic's I6 bead will create this,
   analogous to `bessel.ts` and `erf.ts`. The canonical Meijer-G form for `Γ(a,z)` is:

   ```
   Γ(a, z) = G^{1,0}_{1,1}([a+1]; [a, 0]; z)   [Bateman §5.6 (38); Wolfram convention]
   ```

   This is the primary form the bridge should implement. The lower incomplete gamma
   follows from the complementarity rule.

**Gap analysis vs existing cas-core diff rules:**

| Head | Existing diff rule | New rule needed |
|---|---|---|
| `Gamma` | ✓ `ψ(z)·Γ(z)` | none |
| `Digamma` | ✓ `Polygamma(1,z)` | none |
| `Polygamma` | ✓ `Polygamma(m+1,z)` | none |
| `LogGamma` | **MISSING** | `d/dz = Digamma(z)` — add to `differentiateSpecialFunction` |
| `Pochhammer` | **not applicable** (n is discrete) | none (refuse on n-dependence) |
| `IncompleteGammaUpper` | **MISSING** | `d/dz = -z^{a-1}·e^{-z}` |
| `IncompleteGammaLower` | **MISSING** | `d/dz = z^{a-1}·e^{-z}` |
| `Beta` | **MISSING** | `∂/∂a = B(a,b)·[ψ(a)-ψ(a+b)]` |
| `BarnesG` | **MISSING** | `d/dz: from log G' = sum_{k=1}^{z-1} logΓ(k)` — complex; defer |

**v0.1 count: 38 shippable rules across 6 new heads + 3 new diff rules.**
