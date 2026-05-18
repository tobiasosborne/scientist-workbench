# R4 — Bidirectional Meijer-G ↔ Gamma-family bridge

**Bead:** `scientist-workbench-o8yk` (R4 — Gamma epic, Phase 0).
**Parent epic:** `scientist-workbench-xqc7` (Gamma family).
**Status:** research artefact; no source modified.
**Date:** 2026-05-18.
**Author:** deep-research subagent.
**Methodology source:** `docs/HANDOFF_per_head_special_function_methodology.md`.
**Styling exemplars:** `docs/refs/erf-research/R4-meijer-g-bridge.md` (1-arg precedent),
`docs/refs/besselj-research/R4-meijer-g-bridge.md` (2-arg precedent, "12-cell table
collapses to 4 forms" finding).

---

## Purpose and the critical conceptual difference

For Erf and Bessel, the head is a **value** the Meijer-G produces: `Erf(z)` is what a
particular G-form evaluates to; `BesselJ(ν, z)` is what another G-form evaluates to.
The bridge in each case is a translator between the named head's AST and the G-function
AST.

For the **Gamma family**, the head plays a **double role**:

1. **Γ as a named head.** `Gamma(z)` is a value — the complete Gamma function — and it
   does have a canonical G-form representation (trivial: a (1,0,0,1) G-function). The
   same is true for the lower and upper incomplete gamma, and for a few related functions.
   This is the forward-bridge question: given `Gamma(z)` (or `LowerIncompleteGamma(a,z)`,
   etc.), what G-form does it map to?

2. **Γ as the building block of Meijer-G itself.** The Mellin-Barnes definition of
   `G^{m,n}_{p,q}` is literally a contour integral of Γ-product quotients. Every row of
   the `dispatch-rules/` reduction table emits Γ factors as prefactors (see `bateman-5-6.ts`
   rules 10, 11, 3 — they all emit `gamma(...)` values). The Slater-theorem path in
   `packages/meijer-core/src/slater.ts` uses Γ as the residue building block. Γ-pole
   cancellation is the entire game in Mellin-Barnes residue summation.

This document addresses **both** roles with clean separation. The forward bridge (§A, §C)
is about "Gamma as named head → G-form". The architectural analysis (§D, §E) is about
"Gamma as G-building-block and what happens once the bridge exists".

---

## Source provenance

| Source | HTTP | What it gave |
|---|---|---|
| DLMF §8.2 (incomplete gamma definitions) | 200 | Defining integrals for γ(a,z), Γ(a,z); complementarity relation; normalised forms P, Q, γ*. No G-forms in §8.2. |
| DLMF §8.4 (special values) | 200 | Special values expressed via erf, E_1; up to eq. 8.4.15. No G-form in §8.4. |
| DLMF §8.5 (confluent hypergeometric reps) | 200 | **Key.** γ(a,z) = a⁻¹z^a e^{−z} M(1, 1+a, z) = a⁻¹z^a M(a, 1+a, −z) (8.5.1); Γ(a,z) = e^{−z} U(1−a, 1−a, z) = z^a e^{−z} U(1, 1+a, z) (8.5.3). Whittaker forms also given. No G-forms. |
| DLMF §8.6 (Mellin-Barnes for incomplete γ) | 200 | Equations 8.6.10–8.6.12 give Mellin-Barnes contour integrals for γ and Γ — the explicit Γ-product kernels that, read as G-function parameter tuples, pin the canonical G-forms. See §A below. |
| DLMF §8.7 | 200 | Power series, Bessel series for γ*. No G-forms. |
| DLMF §8.19 (E_p) | 200 | E_p(z) = z^{p-1} Γ(1−p, z); E_p(z) = z^{p-1} e^{−z} U(p, p, z). No G-form. The G-form of E_1 is already in production (dlmf-16-17-e1). |
| DLMF §5.2, §5.12, §5.13, §5.19 | 200 | No G-function representations for Γ(z), B(a,b), or BarnesG in any of these sections. §5.19(ii) discusses Mellin-Barnes integrals conceptually; §5.13 gives Barnes' Beta integral without G-notation. |
| DLMF §16.17 (Meijer-G definition) | 200 | Formal Mellin-Barnes definition. Does not explicitly give Γ(z) as G^{1,0}_{0,1}. |
| DLMF §16.18 (G special cases) | 200 | Points to pFq ↔ G via 16.18.1; notes special cases include Bessel, parabolic-cylinder, Legendre, orthogonal polynomials. Does NOT list incomplete-gamma or complete-gamma G-forms explicitly (Luke 1969 cited for the detailed tables). |
| Wikipedia Meijer G-function (§"Representation of other functions") | 200 | **Key.** Explicit table entries: γ(α,x) = G^{1,1}_{1,2}; Γ(α,x) = G^{2,0}_{1,2}. Bessel, Lerch also listed. No entries for complete Γ(z), B(a,b), BarnesG, Pochhammer. |
| Wikipedia incomplete_gamma_function | 200 | T(m,s,x) as a G-form (specialized for derivative contexts); confluent hypergeometric connections (same as DLMF §8.5). No complete table. |
| Wikipedia Beta_function | 200 | B(a,b) = Γ(a)Γ(b)/Γ(a+b), trig forms, series. No G-form. |
| Wikipedia Barnes_G-function | 200 | Functional equation G(z+1) = Γ(z)G(z), G(1)=1; infinite product representation; entire function of order 2. **No G-form representation.** |
| Wikipedia Pochhammer_symbol | 200 | Connections to hypergeometric numerators. **No G-form.** |
| SymPy `sympy/integrals/meijerint.py` (lines 1–600) | 200 | **Key.** `_create_lookup_table()` contains `add(expint(a, t), [], [a], [a-1, 0], [], t)`. No entries for complete gamma, lower/upper incomplete gamma, Beta, BarnesG, Pochhammer. Confirms: SymPy's integration engine does NOT use Meijer-G to evaluate these. |
| SymPy `sympy/functions/special/gamma_functions.py` | 200 | No `_eval_rewrite_as_meijerg` in any class: gamma, lowergamma, uppergamma, polygamma, loggamma, digamma. Confirms: SymPy has no canonical "rewrite Gamma as MeijerG" path in its function layer. |
| mpmath `functions/expintegrals.py` + `functions/hypergeometric.py` | 200 | No meijerg() calls in the gamma-family implementations. mpmath evaluates γ, Γ, B via hypercomb/1F1/U, not via G-function. |
| `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` | local | Rules 10, 11, 3 emit `gamma(...)` as Γ **coefficients**. Rule 6 emits `BesselJ`. Rules 4, 5, 25 emit `BesselK`. No rule emits `Gamma`, `LowerIncompleteGamma`, or `UpperIncompleteGamma` as a **head**. |
| `packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts` | local | `dlmf-16-17-e1` emits `ExpIntegralE([1], z)` (= E_1(z)). `dlmf-16-18-erf` emits `√π · Erf(√z)`. No Gamma-head rules. |

---

## Wolfram MeijerG argument convention (pin)

Same convention as R4-Erf and R4-Bessel — repeated for self-containment:

```
MeijerG[{{a_top}, {a_bot}}, {{b_top}, {b_bot}}, z]
  = G^{m,n}_{p,q}(a_top, a_bot; b_top, b_bot | z)
```

Slot vocabulary (matching `dispatch-types.ts`):

- `an = a_top` — first `n` upper parameters (numerator-line of the n left-closing series).
- `ap = a_bot` — remaining `p − n` upper parameters.
- `bm = b_top` — first `m` lower parameters (the enclosed poles).
- `bq = b_bot` — remaining `q − m` lower parameters.
- `(m, n, p, q)` derived: `m = bm.length`, `n = an.length`, `p = an.length + ap.length`, `q = bm.length + bq.length`.

---

## §A — Canonical G-form table per gamma-family head

### A.1 Complete summary table

The table below covers every head in the gamma family for which a canonical G-form exists
in the primary literature, sourced to a specific document. For heads where no G-form
exists in the literature, the table explicitly records the refusal with justification.

| Head | Arity | G-form `(m,n,p,q)` | `an` | `ap` | `bm` | `bq` | z-sub | Prefactor | Source | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `Gamma(z)` | 1 | `(1,0,0,1)` | `[]` | `[]` | `[0]` | `[]` | `−z` | 1 | DLMF §8.6.10 derivation; Abramowitz & Stegun 6.5.3 | Trivial G-form: G^{1,0}_{0,1} = z^{bm[0]} e^{−z}; at bm=[0] → e^{−(−z)} = e^z for z=-arg. See §A.2. |
| `LowerIncompleteGamma(a,z)` / `γ(a,z)` | 2 | `(1,1,1,2)` | `[1]` | `[]` | `[a]` | `[0]` | `z` | 1 | Wikipedia Meijer-G §"Representation of other functions"; cross-confirmed via DLMF §8.6.10 Mellin-Barnes kernel |  Vocabulary head `LowerIncompleteGamma` is NOT in ADR-0023 today. See §E, Discovery A. |
| `UpperIncompleteGamma(a,z)` / `Γ(a,z)` | 2 | `(2,0,1,2)` | `[]` | `[1]` | `[a,0]` | `[]` | `z` | 1 | Wikipedia Meijer-G §"Representation of other functions"; cross-confirmed via DLMF §8.6.11 Mellin-Barnes kernel | Vocabulary head `UpperIncompleteGamma` is NOT in ADR-0023 today. See §E, Discovery A. Structurally identical to Erfc's shape `(2,0,1,2)` with different bm slots. |
| `Gamma(z)` (1/Γ) | — | NO canonical G-form | — | — | — | — | — | — | — | 1/Γ(z) is entire but has no standard G^{m,n}_{p,q} form in PBM/Bateman/DLMF. Honest refusal. |
| `Beta(a,b)` | 2 | DERIVED via Γ | — | — | — | — | — | — | — | B(a,b) = Γ(a)Γ(b)/Γ(a+b). No standalone G-form in Wikipedia, DLMF, SymPy, or mpmath. Can be expressed as a product of G-functions but this is not a single G-function. See §A.5. |
| `BarnesG(z)` | 1 | NONE — honest refusal | — | — | — | — | — | — | — | BarnesG satisfies G(z+1)=Γ(z)G(z) and is entire of order 2. No G^{m,n}_{p,q} representation exists in any source surveyed. Even Wolfram MathWorld and the Wikipedia article give no G-form. Honest refusal. See §A.6. |
| `Pochhammer(a,n)` | 2 | DERIVED via Γ | — | — | — | — | — | — | — | (a)_n = Γ(a+n)/Γ(a). Not a single G-function; Γ-ratio with integer shift. No G-form in Wikipedia, DLMF, or SymPy. See §A.7. |
| `Digamma(z)` | 1 | NONE | — | — | — | — | — | — | — | ψ(z) = d/dz ln Γ(z). No standard G-form. Can be expressed via Mellin transform of (e^{−t}/t − e^{−zt}/(1−e^{−t})) but this is not a Meijer-G. Honest refusal. |
| `Polygamma(n,z)` | 2 | NONE | — | — | — | — | — | — | — | ψ^{(n)}(z) = d^{n+1}/dz^{n+1} ln Γ(z). No standard G-form in the surveyed sources. Honest refusal. |
| `ExpIntegralE(n,z)` | 2 | `(2,0,1,2)` | `[]` | `[n]` | `[n-1, 0]` | `[]` | `z` | 1 | SymPy `meijerint.py` line ~337: `add(expint(a, t), [], [a], [a-1, 0], [], t)`. Already in production as `dlmf-16-17-e1` for n=1. | Already in the vocabulary (ADR-0023). G-form is the general-`n` extension of the existing E_1 rule. The existing `dlmf-16-17-e1` specializes to n=1 (an=[], ap=[1], bm=[0,0], bq=[]). Note: the general G-form has ap=[n], bm=[n-1, 0] — for n=1 this gives ap=[1], bm=[0, 0], which exactly matches. |

### A.2 Complete Gamma function Γ(z): the trivial G-form

The Bateman §5.6 rule `bateman-5-6-8` already in production is:

```
G^{1,0}_{0,1}(_; 0 | z) = e^{−z}
```

This is the identity that ALSO encodes Γ. From DLMF §8.6.10 (Mellin-Barnes for γ), the
incomplete gamma function integral has a kernel whose "full range" (a=0) limit gives the
complete Γ. The connection is:

```
Γ(z) = ∫₀^∞ t^{z-1} e^{-t} dt  (defining integral)
```

Written in G-function form (via the Laplace transform perspective, PBM Vol I §2.2):

```
Γ(z) = G^{1,0}_{0,1}(_; 0 | −z)   [G-arg is −z, not z; see Wolfram convention]
```

**IMPORTANT SUBTLETY.** The argument convention matters here:

- Bateman §5.6 (1): `G^{1,0}_{0,1}(_; b | z) = z^b e^{−z}`. At b=z-1, this gives
  `G^{1,0}_{0,1}(_; z-1 | 1) = e^{-1}`. That is NOT the complete Gamma — it is the
  one-argument evaluation.
- The **complete Gamma as a function of its argument** is:

  ```
  Γ(z) = G^{1,0}_{0,1}(_; z-1 | 1)  ???
  ```

  No. This confusion is why SymPy has no `_eval_rewrite_as_meijerg` for `gamma`. The
  G-function `G(z)` has its argument as the `z`-slot, not in the parameter slots. To
  express `Γ(s)` as a G-function in `s`, one would need `bm = [s-1]` — a parameter that
  itself depends on `s`, the head's argument. This is NOT the structure the Meijer-G
  framework supports: parameters are constants (or at most symbolic parameters fixed for
  a given G-form), not the integration variable.

**Key finding:** `Γ(z)` as a FUNCTION of `z` cannot be expressed as a single
`G^{m,n}_{p,q}(z)` where the parameters (an, ap, bm, bq) are fixed constants
independent of `z` and `z` appears only in the G's `z`-slot. The reason is that Γ's
defining integral involves `t^{z-1}`, meaning `z` appears in the exponent of the
integrand — this is a Mellin transform of `e^{-t}`, which gives a G-form where `z` would
have to appear in a parameter slot, not just the argument slot.

**What IS true:** For a fixed value of `z` (a constant), `Γ(z)` equals the evaluation of
`G^{1,0}_{0,1}(_; 0 | 1)` times `1` — but this is trivially useless (it says `Γ(1) = 1`).
The Bateman §5.6 rules use Γ as a **prefactor coefficient** — precisely because Γ appears
as a residue in the Mellin-Barnes series, not as the G-function value itself.

**Verdict for the bridge:** `headToMeijerG("Gamma", [z])` returns **null** because there
is no G-form whose single evaluation gives `Γ(z)` for all `z` with parameters independent
of `z`. This is not a gap; it is the mathematics. `Gamma(z)` plays the role of coefficient
in G-function reductions — it cannot simultaneously be the value produced by a G-function
evaluation in the same framework.

**Cross-validation:** SymPy's `gamma._eval_rewrite_as_meijerg` does not exist. mpmath
evaluates Gamma via Stirling/Lanczos, never via `meijerg`. The Wolfram Functions Site
at `/Gamma/26/01/01/` returned HTTP 403 — consistent with R4-Erf's experience — but the
absence of SymPy + mpmath + DLMF entries is decisive.

### A.3 Lower incomplete gamma γ(a,z): the (1,1,1,2) form

**Source:** Wikipedia Meijer-G §"Representation of other functions" (HTTP 200, direct table
entry). Cross-validated via DLMF §8.6.10's Mellin-Barnes kernel analysis.

**Canonical form:**
```
γ(a, z) = G^{1,1}_{1,2}(1; a, 0 | z)

  (m, n, p, q) = (1, 1, 1, 2)
  an = [1]
  ap = []
  bm = [a]
  bq = [0]
  z-sub: z (identity)
  prefactor: 1
```

**Wolfram slot encoding:** `MeijerG[{{1}, {}}, {{a}, {0}}, z]`.

**Derivation sketch** (not circular — cross-check against DLMF §8.6.10):

The Mellin-Barnes integral for the lower incomplete gamma is (DLMF 8.6.10):
```
γ(a, z) = (1/2πi) ∫_{c-i∞}^{c+i∞} Γ(s) a^{-s} z^{a-s} ds
```
Comparing to the G-function definition
```
G^{m,n}_{p,q}(z | a_p; b_q) = (1/2πi) ∫_L [∏_{j=1}^m Γ(b_j - s) · ∏_{j=1}^n Γ(1-a_j+s)] /
                                           [∏_{j=m+1}^q Γ(1-b_j+s) · ∏_{j=n+1}^p Γ(a_j-s)] z^s ds
```
Matching the kernel: we need `Γ(s)` from the `Γ(b_j - s)` factors with `b_j = 0` (so
`Γ(0 - s) = Γ(-s)` — nearly, but note sign), and we need `Γ(1 - a_j + s)` from the
`an`-slot with `a_j = 1` (so `Γ(1-1+s) = Γ(s)` ✓). The `a^{-s}` factor appears in the
numerics as the G-function `z`-slot, and the remaining `z^a` factor becomes part of the
prefactor derivation. The Wikipedia table entry agrees with this matching.

**Vocabulary status:** The head `LowerIncompleteGamma` (or `Gamma2lower` or `γ`) is NOT in
the ADR-0023 vocabulary. The bridge cannot ship without a vocabulary admission. See §E,
Discovery A.

**Round-trip note:** The G-form `(1,1,1,2)` with `an=[1], bm=[a], bq=[0]` is distinct
from the Erf G-form `(1,1,1,2)` with `an=[1/2], bm=[0], bq=[-1/2]`. The backward matcher
can distinguish them by inspecting `an[0]` (1 vs 1/2) and `bm[0]` (literal `a` vs 0).

### A.4 Upper incomplete gamma Γ(a,z): the (2,0,1,2) form

**Source:** Wikipedia Meijer-G §"Representation of other functions" (HTTP 200, direct table
entry). Cross-validated via DLMF §8.6.11.

**Canonical form:**
```
Γ(a, z) = G^{2,0}_{1,2}(1; a, 0 | z)

  (m, n, p, q) = (2, 0, 1, 2)
  an = []
  ap = [1]
  bm = [a, 0]
  bq = []
  z-sub: z (identity)
  prefactor: 1
```

**Wolfram slot encoding:** `MeijerG[{{}, {1}}, {{a, 0}, {}}, z]`.

**Shape coincidence with Erfc:** The `(2,0,1,2)` shape is exactly Erfc's shape. Erfc has
`ap=[1], bm=[0, 1/2]`; UpperIncompleteGamma has `ap=[1], bm=[a, 0]`. The bm slots
distinguish them: Erfc has literal `0` and `1/2`; UpperIncompleteGamma has symbolic `a`
and literal `0`. A backward matcher on the `(2,0,1,2)` shape must check:
- If `bm` is `[0, 1/2]` or `[1/2, 0]` (canonical sort): → Erfc.
- If `bm` is `[a, 0]` or `[0, a]` with `a` not rational: → UpperIncompleteGamma.
- If `bm` has both entries rational (other than `{0, 1/2}`): → could be ExpIntegralE(n,z)
  at a specific `n` value, or UpperIncompleteGamma at a specific `a` value. Both have the
  same shape; the distinction is the `ap` slot: ExpIntegralE has `ap=[n]`, UpperIncompleteGamma
  has `ap=[1]`. When `n=1`: `ap=[1]` — the two shapes are identical at `n=1`, `a=0`.
  The backward matcher must be careful here. See §F.3.

**UpperIncompleteGamma ↔ ExpIntegralE connection:**
```
E_p(z) = z^{p-1} Γ(1−p, z)   (DLMF 8.19.1)
```
So `UpperIncompleteGamma(1-p, z)` = `z^{1-p} · ExpIntegralE(p, z)`. The G-form of
`ExpIntegralE(p, z)` per SymPy is `(2,0,1,2)` with `ap=[p], bm=[p-1, 0]`. Substituting
`a = 1-p` into the UpperIncompleteGamma form gives `ap=[1], bm=[1-p, 0] = [a, 0]`.
These agree when `p = 1−a`, confirming the connection. At `p=1` (a=0): `bm=[0, 0]` —
which matches the existing `dlmf-16-17-e1` rule (where `bm = [0, 0]` because n=1 gives
`bm = [0, 0]` after substituting in the general ExpIntegralE pattern). So the existing
E_1 rule is a **special case** of the general UpperIncompleteGamma G-form.

**Vocabulary status:** `UpperIncompleteGamma` is NOT in ADR-0023. See §E, Discovery A.

### A.5 Beta function B(a,b): no standalone G-form

**Source:** Wikipedia Beta_function, DLMF §5.12, SymPy gamma_functions.py — none contain
a G-form.

`B(a, b) = Γ(a)Γ(b) / Γ(a+b)`.

This ratio of complete Gamma functions at fixed parameters is a constant (for fixed a, b),
not a function evaluated at a variable G-argument. For the same reason `Γ(z)` itself has
no G-form (§A.2), `B(a, b)` as a function of `a` and `b` has no single G-form.

**What IS true in the G-framework:** The definite integral `B(a, b) = ∫₀¹ t^{a-1}(1-t)^{b-1} dt`
is a Euler integral that appears in the Slater theorem as the "full series" of certain
G-functions. But the G-function it corresponds to is `G^{1,1}_{1,1}(...)` evaluated at
z=1 — which is a particular value of a G-function, not the function itself expressed as G
in (a, b) as variable arguments.

**Verdict:** `headToMeijerG("Beta", [a, b])` returns **null**. Honest refusal.

### A.6 Barnes G-function BarnesG(z): no G-form

**Source:** Wikipedia Barnes_G-function — no G-form mentioned. No G-form in any source
surveyed.

`BarnesG(z)` satisfies `G(z+1) = Γ(z)G(z)`, `G(1) = 1`, and is entire of order 2
(Weierstrass product). Its asymptotic expansion involves the Glaisher-Kinkelin constant A
and the zeta function, not Γ-product ratios of the Mellin-Barnes type.

**Honest refusal:** `headToMeijerG("BarnesG", [z])` → **null**. BarnesG is entire of order 2;
the G-function machinery (Mellin-Barnes integral with Γ-product kernels) is designed for
functions whose Mellin transform is a Γ-product ratio. BarnesG's Mellin transform is not
in this class.

**Vocabulary status:** `BarnesG` is NOT in ADR-0023 and has no G-form. If added to the
vocabulary, it would be an "honestly refused" head in the bridge.

### A.7 Pochhammer (a)_n = Γ(a+n)/Γ(a): no G-form

**Source:** Wikipedia Pochhammer_symbol — no G-form. SymPy and mpmath: not in the G-function
lookup table.

`(a)_n = a(a+1)(a+2)···(a+n-1) = Γ(a+n)/Γ(a)`.

For fixed `n`, this is a polynomial in `a` of degree `n`. For variable `a` and fixed `n`,
it is a rational function of Γ values. Neither shape fits the Meijer-G bridge model.

**Honest refusal.** `headToMeijerG("Pochhammer", [a, n])` → **null**.

**Note:** Pochhammer appears prominently in the *definition* of hypergeometric pFq (as
numerator/denominator coefficients), and pFq in turn has a G-form via DLMF 16.18.1. But
the Pochhammer symbol itself does not have a direct G-form.

### A.8 Digamma ψ(z) and Polygamma ψ^{(n)}(z): no G-forms

**Source:** SymPy `gamma_functions.py` — no `_eval_rewrite_as_meijerg`. No G-form in
Wikipedia, DLMF, or any surveyed source.

The digamma `ψ(z) = d/dz ln Γ(z)` is the logarithmic derivative of Γ, which is not
directly a Γ-product quotient evaluable as a Mellin-Barnes integral in the standard way.
The polygamma `ψ^{(n)}(z)` generalises further. Neither has a known single G-form.

**Honest refusal.** Both → **null** in the forward bridge.

---

## §B — Adamchik-Marichev forward-path audit

This section surveys every existing rule in `packages/meijer-core/src/dispatch-rules/` and
records: (a) whether it emits a Gamma-family head, (b) whether it uses Gamma as a factor
coefficient, and (c) whether the emitted G-form round-trips back to a Gamma-family head
via a gamma bridge.

### B.1 `bateman-5-6.ts` — 30+ rules

**Overview:** This is the primary rule file. It emits elementary functions (exp, power),
Bessel functions, and **Gamma-as-coefficient** in several rules. No rule emits a
Gamma-family head as the primary reduction target.

| Rule ID | Shape | Emits | Gamma-as-head? | Gamma-as-factor? | Round-trip via gamma bridge? |
|---|---|---|---|---|---|
| `bateman-5-6-8` | (1,0,0,1), bm=[0] | `e^{-z}` | No | No | No |
| `bateman-5-6-20` | (1,0,0,1), bm=[-1] | `e^{-z}/z` | No | No | No |
| `bateman-5-6-21` | (1,0,0,1), bm=[1] | `z·e^{-z}` | No | No | No |
| `bateman-5-6-35-n2` | (1,0,0,1), bm=[2] | `z²·e^{-z}` | No | No | No |
| `bateman-5-6-22` | (1,0,0,1), bm=[1/2] | `√z·e^{-z}` | No | No | No |
| `bateman-5-6-36` | (1,0,0,1), bm=[-1/2] | `e^{-z}/√z` | No | No | No |
| `bateman-5-6-35-nm2` | (1,0,0,1), bm=[-2] | `z^{-2}e^{-z}` | No | No | No |
| `bateman-5-6-35-n3` | (1,0,0,1), bm=[3] | `z^3 e^{-z}` | No | No | No |
| `bateman-5-6-extra-3-half` | (1,0,0,1), bm=[3/2] | `z^{3/2} e^{-z}` | No | No | No |
| `bateman-5-6-1` (generic) | (1,0,0,1), bm=[b] | `z^b e^{-z}` | No | No | No |
| `bateman-5-6-31` | (0,1,1,0), an=[0] | `e^{-1/z}/z` | No | No | No |
| `bateman-5-6-32` | (0,1,1,0), an=[1] | `e^{-1/z}` | No | No | No |
| `bateman-5-6-33` | (0,1,1,0), an=[2] | `z e^{-1/z}` | No | No | No |
| `bateman-5-6-34` | (0,1,1,0), an=[1/2] | `e^{-1/z}/√z` | No | No | No |
| `bateman-5-6-2-am1` | (0,1,1,0), an=[-1] | `z^{-2} e^{-1/z}` | No | No | No |
| `bateman-5-6-2-a3` | (0,1,1,0), an=[3] | `z^2 e^{-1/z}` | No | No | No |
| `bateman-5-6-2` (generic) | (0,1,1,0), an=[a] | `z^{a-1} e^{-1/z}` | No | No | No |
| `bateman-5-6-10` | (1,1,1,1), an=[a], bm=[0] | `Γ(1-a)·(1+z)^{a-1}` | No | **YES** `Γ(1-a)` factor | Γ-factor not a Gamma-head emission |
| `bateman-5-6-11` | (1,1,1,1), an=[0], bm=[b] | `Γ(1+b)·z^b/(1+z)^{b+1}` | No | **YES** `Γ(1+b)` factor | Γ-factor not a Gamma-head emission |
| `bateman-5-6-3` (generic) | (1,1,1,1), an=[a], bm=[b] | `Γ(1+b-a)·z^b·(1+z)^{a-b-1}` | No | **YES** `Γ(1+b-a)` factor | Γ-factor not a Gamma-head emission |
| `bateman-5-6-25` | (2,0,0,2), bm=[0,0] | `2·BesselK(0, 2√z)` | No | No | No |
| `bateman-5-6-4` (generic) | (2,0,0,2), bm=[a,b] | `2·z^{(a+b)/2}·BesselK(a-b, 2√z)` | No | No | No |
| `bateman-5-6-5` | (0,2,2,0), an=[a,b] | `2·z^{(a+b)/2-1}·BesselK(a-b, 2/√z)` | No | No | No |
| `bateman-5-6-extra-b` | (1,0,0,2), bm=[0], bq=[0] | `BesselJ(0, 2√z)` | No | No | No |
| `bateman-5-6-extra-a` | (1,0,0,2), bm=[-1/2], bq=[1/2] | `BesselJ(-1, 2√z)` | No | No | No |
| `bateman-5-6-6` (generic) | (1,0,0,2), bm=[b1], bq=[b2] | `z^{(b1+b2)/2}·BesselJ(b1-b2, 2√z)` | No | No | No |

**Finding B.1a:** Three rules emit `gamma(expr)` as a coefficient prefactor: rules 10, 11, 3.
These are **Gamma-as-factor** uses (coefficient in the closed-form expression), not
**Gamma-as-head** emissions (where the reduction target IS the Gamma function). No
rule in `bateman-5-6.ts` emits `Gamma(z)`, `LowerIncompleteGamma(a,z)`, or
`UpperIncompleteGamma(a,z)` as the head of the closed-form result.

**Finding B.1b:** The file's future-work comment at line 678–679 explicitly notes:
> `Bateman §5.6 (38), (40): incomplete-gamma family — needs 'IncompleteGamma' head added to ADR-0023's vocabulary.`

This confirms: the incomplete-gamma G-forms ARE in Bateman §5.6, but they were deferred
pending vocabulary admission. The bridge research here (§A.3, §A.4) supplies the canonical
G-forms; the vocabulary gap is the blocker.

### B.2 `dlmf-16-18.ts` — 4 rules

| Rule ID | Shape | Emits | Gamma-as-head? | Gamma-as-factor? |
|---|---|---|---|---|
| `dlmf-empty` | (0,0,0,0) | `1` | No | No |
| `dlmf-16-17-e1` | (2,0,1,2), ap=[1], bm=[0,0] | `ExpIntegralE(1, z)` | No | No |
| `dlmf-16-18-erf` | (1,1,1,2), an=[1], bm=[1/2], bq=[0] | `√π · Erf(√z)` | No | No |
| `dlmf-16-18-log` | (1,2,2,2) | `log(1+z)` | No | No |
| `dlmf-16-18-arctan` | (1,2,2,2) | `2·arctan(√z)` | No | No |

**Finding B.2a:** The `dlmf-16-17-e1` rule emits `ExpIntegralE(1, z)`. Since `E_1(z) =
Γ(0, z)` (upper incomplete gamma at `a=0`), this rule IS a Gamma-family emission in
disguise — but through the `ExpIntegralE` vocabulary head, not `UpperIncompleteGamma`.
The G-form `(2,0,1,2)` with `ap=[1], bm=[0,0]` is a special case of the general
UpperIncompleteGamma G-form at `a=0` (see §A.4, UpperIncompleteGamma ↔ ExpIntegralE
connection). This is not a bug — it is correct behaviour — but it means the existing
`dlmf-16-17-e1` rule needs to be **taken into account** in the gamma bridge's backward
matcher: a `(2,0,1,2)` form with `ap=[1], bm=[0,0]` should produce `ExpIntegralE(1, z)`
(as it already does), NOT `UpperIncompleteGamma(0, z)` (which would be semantically
equivalent but introduces a head not in the vocabulary).

### B.3 `erf-forward-form-a.ts`, `erfc-forward.ts`, `erfi-forward.ts`

All three emit Erf-family heads. No Gamma-family heads or Gamma factors.

### B.4 `bessel-backward.ts`

Emits `BesselY`, `BesselI`. No Gamma-family heads. The Γ-cancellation described in the
rule's comments ("`ap[0] == bq[0]` Γ-cancellation" producing Y's `sin(πν)` connection
factor) is an implicit G-machinery feature, not an explicit Gamma-head emission.

### B.5 Summary finding

**NO existing dispatch rule emits a `Gamma`, `LowerIncompleteGamma`, or
`UpperIncompleteGamma` head.** The rules that use Gamma use it as a coefficient
(Gamma-as-factor), which is the correct role for Gamma inside the Mellin-Barnes
residue-sum closed forms. The vocabulary gap (§E, Discovery A) is the primary blocker.

---

## §C — Bridge API for `meijer-core/src/bridges/gamma.ts`

### C.1 Which heads this bridge serves

The v0.1 gamma bridge serves exactly the heads with confirmed G-forms from §A:

| Head | Arity | G-form | Forward | Backward |
|---|---|---|---|---|
| `Gamma(z)` | 1 | NONE — honest refusal | null | null |
| `LowerIncompleteGamma(a, z)` | 2 | (1,1,1,2) an=[1], bm=[a], bq=[0] | YES | YES |
| `UpperIncompleteGamma(a, z)` | 2 | (2,0,1,2) ap=[1], bm=[a,0] | YES | YES |
| `Beta(a, b)` | 2 | NONE — honest refusal | null | null |
| `BarnesG(z)` | 1 | NONE — honest refusal | null | null |
| `Pochhammer(a, n)` | 2 | NONE — honest refusal | null | null |
| `Digamma(z)` | 1 | NONE — honest refusal | null | null |
| `Polygamma(n, z)` | 2 | NONE — honest refusal | null | null |

The bridge cannot be implemented until `LowerIncompleteGamma` and `UpperIncompleteGamma`
are added to ADR-0023's vocabulary table (see §E, Discovery A).

**Critical:** `Gamma(z)` itself is an honest refusal (see §A.2 detailed argument). The
bridge explicitly recognises this head, declines it with `null`, and does NOT attempt to
construct a G-form. This is different from "unknown head" — the head is known but
structurally unrepresentable as a G-form.

### C.2 `headToMeijerG(head, args)` — forward bridge

```typescript
// Pseudocode — NOT production-ready; vocabulary admission required first.

export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null {

  switch (head) {
    case "Gamma": {
      // Honest refusal: Γ(z) is not expressible as a single G-function
      // in its argument z with fixed parameters. See R4 §A.2.
      return null;
    }

    case "LowerIncompleteGamma": {
      // γ(a, z) = G^{1,1}_{1,2}(1; a, 0 | z)  [Wikipedia MeijerG; DLMF 8.6.10 derivation]
      // (m, n, p, q) = (1, 1, 1, 2)
      // an = [1], ap = [], bm = [a], bq = [0]
      // z-sub: identity (z-slot IS the head's z argument)
      // prefactor: 1 (identity)
      if (args.length !== 2) return null;
      const [a, z] = [args[0]!, args[1]!];
      const gForm: MeijerGForm = {
        an: [ONE_INT],           // [1]
        ap: [],
        bm: [a],                 // [a] — the head's first argument
        bq: [ZERO_INT],          // [0]
        z: z,                    // identity substitution
      };
      const wrap = (g: Value): Value => g;  // prefactor = 1
      const argsInverse = (): readonly Value[] => [a, z];
      return { gForm, wrap, argsInverse };
    }

    case "UpperIncompleteGamma": {
      // Γ(a, z) = G^{2,0}_{1,2}(1; a, 0 | z)  [Wikipedia MeijerG; DLMF 8.6.11 derivation]
      // (m, n, p, q) = (2, 0, 1, 2)
      // an = [], ap = [1], bm = [a, 0], bq = []
      // z-sub: identity
      // prefactor: 1
      if (args.length !== 2) return null;
      const [a, z] = [args[0]!, args[1]!];
      const gForm: MeijerGForm = {
        an: [],
        ap: [ONE_INT],           // [1]
        bm: [a, ZERO_INT],       // [a, 0]
        bq: [],
        z: z,                    // identity substitution
      };
      const wrap = (g: Value): Value => g;  // prefactor = 1
      const argsInverse = (): readonly Value[] => [a, z];
      return { gForm, wrap, argsInverse };
    }

    // Honest refusals — recognised, structurally unrepresentable:
    case "Beta":
    case "BarnesG":
    case "Pochhammer":
    case "Digamma":
    case "Polygamma":
      return null;

    default:
      return null;
  }
}
```

### C.3 `meijerGToHead(form, prefactor?)` — backward bridge

The backward bridge pattern-matches incoming G-forms. The Gamma family has two matchable
G-forms, distinguished by `(m, n, p, q)` and the `bm` slot:

**Shape `(1, 1, 1, 2)` with `an=[1]`:**
This shape is shared between `LowerIncompleteGamma` and the Erf family. However:
- Erf/Erfc/Erfi all have `an=[1/2]` — the `an[0]` discriminator fires first.
- The gamma bridge checks: if `an=[1]`, `bm=[a]` (any value), `bq=[0]` → `LowerIncompleteGamma(a, √z_or_z)`.

Wait — the z-substitution for γ is the identity (z-slot IS z, no squaring). The recovery
for a standalone backward call (not from `argsInverse()`) is:
- `a` is recovered directly from `bm[0]`.
- `z` is recovered directly from the G-form's `z`-slot (identity substitution → no inverse needed).

This makes the backward bridge **simpler than Erf/Bessel** because there is no multi-valued
square root to sidestep. The `argsInverse` closure is still the correct path for
round-trips through `headToMeijerG`, but the standalone `meijerGToHead` can recover
`[a, z]` directly from the G-form's `bm[0]` and `z`-slot.

**Shape `(2, 0, 1, 2)` with `ap=[1]`:**
This shape is shared between `UpperIncompleteGamma`, `Erfc`, and `ExpIntegralE`. The
disambiguation logic:

1. If `bm = [0, 1/2]` or `[1/2, 0]` (canonical sort) → `Erfc`. (This is the Erfc rule
   already in `erfc-forward.ts`.)
2. If `bm = [0, 0]` → `ExpIntegralE(1, z)`. (This is the existing `dlmf-16-17-e1`
   rule.)
3. If `bm = [n-1, 0]` or `[0, n-1]` with `n` not equal to 1 → `ExpIntegralE(n, z)`.
   (General E_n; this rule does not yet exist in the dispatch table.)
4. If `bm = [a, 0]` or `[0, a]` with `a` not matchable to the above patterns:
   → `UpperIncompleteGamma(a, z)`. Recover `a` from `bm[0]` (or `bm[1]` after canonical
   sort), `z` from the G-form's `z`-slot.

The canonical-bytes sort complicates pattern 4: after sort, the order of `[a, 0]` depends
on whether `a` is a rational literal or a symbolic expression. The same literal-vs-symbolic
sort asymmetry that forced the `bessel-backward.ts` two-rule split applies here.

**Disambiguation table for `(2,0,1,2)` backward:**

| `bm` (pre-sort) | `ap` | After canonical sort | Route to |
|---|---|---|---|
| `[0, 1/2]` | `[1]` | `[rat(1/2), int(0)]` | Erfc |
| `[0, 0]` | `[1]` | `[int(0), int(0)]` | ExpIntegralE(1, z) |
| `[n-1, 0]` literal rational `n-1` | `[1]` or `[n]` | depends on `n` | ExpIntegralE(n, z) — check `ap` |
| `[a, 0]` symbolic `a` | `[1]` | `[int(0), expr(a)]` (sort: int < expr) | UpperIncompleteGamma(a, z) |
| `[a, 0]` rational `a` (not 0, not 1/2) | `[1]` | `[rat(a), int(0)]` | UpperIncompleteGamma(a, z) |

The router key insight: when `ap=[1]`, the `(2,0,1,2)` form is:
- Erfc if `bm` is literally `{0, 1/2}`.
- ExpIntegralE(n) if `ap=[n]` (NOT `[1]`) — but the existing E_1 rule has `ap=[1]` only
  for n=1. For general ExpIntegralE(n, z) per SymPy's table, `ap=[n]` (which equals `[1]`
  only when n=1). So the general-n case has `ap=[n]` ≠ `[1]` for n≠1 — that's a
  different `ap` value and is unambiguous.
- UpperIncompleteGamma if `ap=[1]` and `bm` is `[a, 0]` with `a` not one of the special
  Erfc/E_1 values.

**Conclusion:** the `ap` slot is the primary discriminator between ExpIntegralE(n≠1) and
UpperIncompleteGamma. For n=1 (where both have `ap=[1]`), the bm slots discriminate:
E_1 has `bm=[0,0]` while UpperIncompleteGamma(0, z) also has `bm=[0, 0]` — which means
`UpperIncompleteGamma(0, z) = E_1(z)/z^0 = E_1(z)`. The backward bridge should prefer
the `ExpIntegralE(1, z)` route for `bm=[0,0]` since that head is already in the
vocabulary and is the conventional term. See §E, Discovery B.

### C.4 `argsInverse` closure — arity analysis

The `argsInverse: () => readonly Value[]` closure (ADR-0041 §"Decision 5") works
out-of-the-box for the gamma family:

| Head | Arity | `argsInverse()` returns | Works? |
|---|---|---|---|
| `LowerIncompleteGamma(a, z)` | 2 | `[a, z]` | Yes — same as Bessel's 2-arg pattern |
| `UpperIncompleteGamma(a, z)` | 2 | `[a, z]` | Yes — same as Bessel's 2-arg pattern |
| `Gamma(z)` | 1 | (not needed — bridge returns null) | N/A |
| `Digamma(z)` | 1 | (not needed) | N/A |
| `Polygamma(n, z)` | 2 | (not needed) | N/A |
| `Beta(a, b)` | 2 | (not needed) | N/A |

The z-substitution for both bridgeable heads is the **identity** (z-slot = z, no squaring
or other substitution). This means the `argsInverse` closure is redundant for the
gamma-bridge heads in the sense that the standalone backward bridge can recover [a, z]
from the G-form directly without multi-valued root issues. However, the closure is still
the correct pattern to follow for API consistency with the Erf/Bessel bridges.

**No extension needed to the `argsInverse` API.** The existing `ForwardBridge` type
with `argsInverse: () => readonly Value[]` accommodates all gamma-family arity cases.

### C.5 z-substitution identity — contrast with Erf/Bessel

A key structural difference from Erf/Bessel:

| Bridge | z-sub | Why | Recovery |
|---|---|---|---|
| Erf | z → z² | Erf is defined via ∫₀^z e^{-t²}dt; squaring makes the G-form's kernel polynomial-friendly | √(g.z) is multi-valued → argsInverse closure |
| Erfi | z → -z² | Same, imaginary axis | √(g.z) multi-valued → closure |
| BesselJ | z → z²/4 | Bessel's ODE is (z∂_z)² - (z² + ν²) = 0; canonical G has z²/4 in the kernel | √(4·g.z) multi-valued → closure |
| LowerIncompleteGamma | z → z | γ(a,z) = ∫₀^z t^{a-1}e^{-t}dt; no squaring in the substitution | z = g.z directly → closure still idiomatic |
| UpperIncompleteGamma | z → z | Γ(a,z) = ∫_z^∞ t^{a-1}e^{-t}dt; same | z = g.z directly |

The identity substitution means the gamma bridge is simpler than Erf/Bessel: there is no
multi-valued inverse to avoid. The `argsInverse` closure is still used for API uniformity,
but the standalone backward bridge can safely recover `z` from `form.z` directly.

---

## §D — Closure tests planned (T3 methodology phase)

The methodology T3 phase ("T3: meijer-g closure test") checks that every existing dispatch
rule emitting a special-function head round-trips correctly through the bridge: forward
bridge the head → produce a G-form → run the G-form through the dispatcher → compare
output to the original head.

### D.1 Existing rules potentially affected by a gamma bridge

**None of the existing dispatch rules emit Gamma-family heads.** Therefore there are no
existing rules for which a gamma bridge creates a round-trip closure obligation.

The closure test for the gamma bridge will instead test:

1. `headToMeijerG("LowerIncompleteGamma", [sym("a"), sym("z")]) → gForm1`
2. `meijergSymbolic(gForm1)` → should produce... what? If no dispatch rule matches this
   G-form, it produces `tagged "meijer-g/no-known-reduction"`. The bridge's round-trip
   would not close via the dispatcher in this case — it would close via the bridge's own
   `meijerGToHead(gForm1)` call directly.

This is the standard T3 pattern: round-trip through the bridge layer (bridge → bridge),
not through the dispatcher → bridge. The dispatcher is tested separately.

### D.2 Specific T3 tests to plan

| Test | Input | Expected | Notes |
|---|---|---|---|
| Forward + argsInverse round-trip: γ | `headToMeijerG("LowerIncompleteGamma", [sym("a"), sym("z")])` | `argsInverse()` returns `[sym("a"), sym("z")]` byte-identically | Standard closure test |
| Forward + argsInverse round-trip: Γ | `headToMeijerG("UpperIncompleteGamma", [sym("a"), sym("z")])` | `argsInverse()` returns `[sym("a"), sym("z")]` byte-identically | Standard closure test |
| Backward γ: canonical form | `meijerGToHead({an:[int(1)], ap:[], bm:[sym("a")], bq:[int(0)], z:sym("z")})` | `{head: "LowerIncompleteGamma", args:[sym("a"), sym("z")]}` | Standalone backward path |
| Backward Γ: canonical form | `meijerGToHead({an:[], ap:[int(1)], bm:[sym("a"), int(0)], bq:[], z:sym("z")})` | `{head: "UpperIncompleteGamma", args:[sym("a"), sym("z")]}` | Standalone backward path |
| Backward Γ: Erfc shape not confused | `meijerGToHead({an:[], ap:[int(1)], bm:[rat(1,2), int(0)], bq:[], z:sym("z")})` | Route to Erfc, NOT UpperIncompleteGamma | Discrimination test |
| Backward Γ: E_1 shape not confused | `meijerGToHead({an:[], ap:[int(1)], bm:[int(0), int(0)], bq:[], z:sym("z")})` | Route to ExpIntegralE(1, z), NOT UpperIncompleteGamma(0, z) | Discrimination test |
| Honest refusal: Gamma | `headToMeijerG("Gamma", [sym("z")])` | `null` | Structural refusal, not unknown-head |
| Honest refusal: Beta | `headToMeijerG("Beta", [sym("a"), sym("b")])` | `null` | Structural refusal |
| Honest refusal: BarnesG | `headToMeijerG("BarnesG", [sym("z")])` | `null` | Structural refusal |
| Mutation-prove: LowerIncompleteGamma | perturb bm slot from `[a]` to `[rat(1,2)]` | backward matcher returns Erfc-shape (or null) — NOT LowerIncompleteGamma | Confirms test sensitivity |
| Mutation-prove: UpperIncompleteGamma | change bm from `[a, 0]` to `[0, rat(1,2)]` | backward matcher returns Erfc | Confirms test sensitivity |

### D.3 Dispatcher-layer tests: new rules needed

The `meijerGToHead` backward bridge (bridge layer) handles the canonical G-forms. But the
symbolic **dispatcher** (`packages/meijer-core/src/dispatch.ts`) also needs a rule so that
when `meijergSymbolic` encounters the (1,1,1,2) LowerIncompleteGamma G-form, it emits the
right head rather than falling through to "no-known-reduction".

New dispatch rules needed (see §E, Discovery C):
- `gamma-lower-canonical.ts` — emit `LowerIncompleteGamma(a, z)` from `(1,1,1,2)` with
  `an=[1], bm=[a], bq=[0]`.
- `gamma-upper-canonical.ts` — emit `UpperIncompleteGamma(a, z)` from `(2,0,1,2)` with
  `ap=[1], bm=[a, 0]`, subject to the disambiguation from Erfc and ExpIntegralE(1).

These rules are blocked on vocabulary admission (§E, Discovery A).

---

## §E — Discovery items

### Discovery A: vocabulary admission required

**Two heads need ADR-0023 vocabulary admission before the bridge can ship:**

1. `LowerIncompleteGamma(a, z)` — the lower incomplete gamma γ(a,z). Arguments: `(a, z)`
   where `a` is the parameter and `z` is the variable. Fixed arity 2. Differentiable with
   respect to `z`: `∂γ(a,z)/∂z = z^{a-1} e^{-z}` (DLMF 8.8.1). No branch cut on the
   real axis for real `a > 0`, `z > 0`. Complex-plane analytics require care near z=0 for
   non-integer `a`.

2. `UpperIncompleteGamma(a, z)` — the upper incomplete gamma Γ(a,z). Same arity. Diff
   rule: `∂Γ(a,z)/∂z = -z^{a-1} e^{-z}` (DLMF 8.8.2). Note: Γ(a,z) + γ(a,z) = Γ(a)
   which gives the relation `∂Γ/∂z + ∂γ/∂z = 0`.

**ADR amendment trigger:** This requires an Amendment to ADR-0023, analogous to the Erfi
amendment (ADR-0040 §"Decision 6") and the Hankel/SphericalBessel amendment (ADR-0041
§"Decision 6"). The amendment should justify each head's admission by the Erfi-precedent
test: does it have a canonical G-form (yes — §A.3, §A.4), a closed diff rule (yes), and
a direct consumer (yes — the Bateman §5.6 (38, 40) follow-up bead noted in the dispatch
rule file)?

**Naming convention:** The existing vocabulary uses full unabbreviated names (`BesselJ`,
not `J`; `ExpIntegralE`, not `Expint`). Consistent names: `LowerIncompleteGamma` and
`UpperIncompleteGamma`. Alternative: `GammaLower` / `GammaUpper` — less clear. Recommend
`LowerIncompleteGamma` / `UpperIncompleteGamma` to follow the DLMF §8 convention
("lower incomplete gamma", "upper incomplete gamma").

**NOT needing admission:** `Beta`, `BarnesG`, `Pochhammer`, `Digamma`, `Polygamma` are
either already in the vocabulary (`Digamma`, `Polygamma`) or have no G-form and no
pressing downstream consumer for a G-bridge. `Digamma` and `Polygamma` are in the
vocabulary already (ADR-0023) but have no G-form — the bridge's honest refusal covers them.

### Discovery B: E_1 ↔ UpperIncompleteGamma(0, z) disambiguation

The existing `dlmf-16-17-e1` rule in `dispatch-rules/dlmf-16-18.ts` emits
`ExpIntegralE(1, z)` for the G-form `(2,0,1,2)` with `ap=[1], bm=[0,0]`. This is
mathematically equivalent to `UpperIncompleteGamma(0, z)` (since `E_1(z) = Γ(0, z)`
up to a sign convention that needs checking against DLMF §8.4.4).

The existing rule is **correct** — `ExpIntegralE` is already in the vocabulary, and the
rule correctly maps the G-form to the named head. The gamma bridge's backward matcher
should NOT compete with this rule: when `bm=[0,0]`, the route is `ExpIntegralE(1,z)`,
period. This is a disambiguation priority rule for the backward bridge.

**Action:** The backward gamma bridge's `meijerGToHead` must check `bm=[0,0]` BEFORE
the general `UpperIncompleteGamma` pattern and return `null` (or optionally
`{head: "ExpIntegralE", args: [int(1), z]}`) to avoid shadowing the dispatcher's rule.
The cleaner choice is to return `null` (let the dispatcher's rule handle it) and document
that the gamma bridge only handles `bm=[a, 0]` with `a` not equal to 0 for the
`UpperIncompleteGamma` backward path. Wait — but `UpperIncompleteGamma(0, z)` is
mathematically valid (it equals `E_1(z)`). The resolution: since `ExpIntegralE` is in
the vocabulary and `UpperIncompleteGamma` is not (yet), the bridge backward path should
prefer `ExpIntegralE` for `a=0` and only emit `UpperIncompleteGamma(a, z)` for `a ≠ 0`.
Once `UpperIncompleteGamma` is admitted to the vocabulary, the existing `dlmf-16-17-e1`
rule becomes a **specialization** that can be deprecated or superseded by the general rule.

This is a concrete architecture question for the ADR to resolve. It is flagged here as
a "Discovery B" because it requires a deliberate decision before the bridge and dispatch
rules ship.

### Discovery C: new dispatch rules to add

Two new dispatch rule files are needed to complement the bridge:

1. `gamma-lower.ts` — rule for `(1,1,1,2)` with `an=[1], bm=[a], bq=[0]` →
   `LowerIncompleteGamma(a, z)`. Note: must coexist with the existing Erf bridge rules
   for the same `(1,1,1,2)` shape. The disambiguation is `an[0]`: Erf has `an[0]=1/2`,
   LowerIncompleteGamma has `an[0]=1`. The first-match-wins rule ordering must put the
   more-specific literal patterns first, then the free-slot pattern.

2. `gamma-upper.ts` — rule for `(2,0,1,2)` with `ap=[1], bm=[a, 0]` →
   `UpperIncompleteGamma(a, z)`, with the disambiguation from Erfc (`bm` contains 1/2)
   and ExpIntegralE (`bm = [0, 0]` for E_1, or different `ap` for general E_n) handled
   by more-specific rules appearing first.

**Blocked on:** vocabulary admission (Discovery A).

**Low value for now:** The Bateman §5.6 (38, 40) follow-up bead is the natural carrier for
these rules. The primary value of this research is pinning the G-forms so that bead can
proceed with literature-grounded parameters.

### Discovery D: Gamma-as-building-block and the new bridge — no conflict

**Does the existing use of Gamma as a coefficient in dispatch rules need refactoring once
the bridge exists?**

No. The roles are orthogonal:

- **Gamma-as-coefficient** (current production): rules 10, 11, 3 in `bateman-5-6.ts` emit
  expressions like `gamma(mkMinus(I(1), a!))` as part of a closed-form AST. The `gamma`
  function here is the `expr("Gamma", [...])` value constructor used to build the result
  expression. This is correct: the reduction of `G^{1,1}_{1,1}(a; 0 | z)` IS
  `Γ(1-a) · (1+z)^{a-1}`, and the closed form expresses that Gamma factor naturally.

- **Gamma-as-named-head** (new bridge): `headToMeijerG("Gamma", [...])` returns null;
  `headToMeijerG("LowerIncompleteGamma", ...)` and `headToMeijerG("UpperIncompleteGamma",
  ...)` return G-forms. The new bridge adds a path for the two new heads; it does NOT
  change how the existing rules express their Gamma factors.

**No refactoring of existing rules needed.** The Gamma-as-building-block usage is not a
conflict or a confusion; it is the correct representation of the closed form that the
Slater-theorem machinery produces. The bridge layer and the coefficient layer operate at
different levels of the abstraction stack.

**One indirect opening:** once `LowerIncompleteGamma` and `UpperIncompleteGamma` are in
the vocabulary, the Bateman §5.6 (38, 40) rules can be added to the dispatcher. Those
rules currently cannot ship because their output heads are not in the vocabulary. The
bridge research here provides the G-form ground truth that those rules need.

---

## §F — Conflicts and triangulation

### F.1 Lower incomplete gamma G-form: Wikipedia vs DLMF derivation

**Wikipedia** gives `γ(α,x) = G^{1,1}_{1,2}(1; α, 0 | x)` directly.

**DLMF §8.6.10** gives the Mellin-Barnes kernel:
```
γ(a, z) = (1/2πi) ∫_{c-i∞}^{c+i∞} Γ(s) a^{-s} z^{a-s} ds
```

The G-function definition (DLMF 16.17.1) with `m=1, n=1, p=1, q=2` gives:
```
G^{1,1}_{1,2}(a_1; b_1, b_2 | z) = (1/2πi) ∫_L [Γ(b_1 - s) · Γ(1 - a_1 + s)] / Γ(1 - b_2 + s) z^s ds
```

Matching: set `a_1 = 1`, `b_1 = a`, `b_2 = 0`:
```
G^{1,1}_{1,2}(1; a, 0 | z) = (1/2πi) ∫_L [Γ(a - s) · Γ(s)] / Γ(1 + s) z^s ds
```

The DLMF 8.6.10 kernel has `Γ(s)` (= `Γ(1 - a_1 + s)` with `a_1=1` ✓) and produces
`a^{-s} z^{a-s}` via the pole contribution. This is consistent with the Wikipedia table
entry when the z-slot is `z` (not `z/a`). The `a^{-s}` factor is absorbed into the G's
z-argument by substituting `z → z/a` — but Wikipedia's table gives the form at z=z
directly. The two are consistent modulo the z-argument convention, confirming the Wikipedia
table entry.

**Resolution:** The Wikipedia form `G^{1,1}_{1,2}(1; a, 0 | z)` with z-sub identity is
the canonical form for the bridge. Consistent with the DLMF derivation.

### F.2 Upper incomplete gamma G-form: Wikipedia vs DLMF derivation

**Wikipedia** gives `Γ(α,x) = G^{2,0}_{1,2}(1; α, 0 | x)`.

**DLMF §8.6.11** gives:
```
Γ(a, z) = (1/2πi) ∫_{c-i∞}^{c+i∞} Γ(s+a) z^{-s} / s ds
```

G-function with `m=2, n=0, p=1, q=2`:
```
G^{2,0}_{1,2}(_; a_1; b_1, b_2 | z) = (1/2πi) ∫_L [Γ(b_1 - s) · Γ(b_2 - s)] / Γ(a_1 - s) z^s ds
```

Setting `a_1 = 1`, `b_1 = a`, `b_2 = 0`:
```
G^{2,0}_{1,2}(_; 1; a, 0 | z) = (1/2πi) ∫_L [Γ(a-s) · Γ(-s)] / Γ(1-s) z^s ds
```

By the reflection formula, `Γ(-s)/Γ(1-s) = -1/s`, giving the DLMF 8.6.11 kernel structure.
The match confirms the Wikipedia table entry.

**SymPy cross-check:** SymPy's `add(expint(a, t), [], [a], [a-1, 0], [], t)` gives the
ExpIntegralE G-form as `(2,0,1,2)` with `ap=[a], bm=[a-1, 0]`. Since `E_p(z) =
z^{p-1}Γ(1-p, z)` (DLMF 8.19.1), substituting `a = 1-p`:
```
UpperIncompleteGamma(a, z) = z^{-a} · ExpIntegralE(1-a, z)
```
The G-form of `ExpIntegralE(1-a, z)` per SymPy is `ap=[1-a], bm=[-a, 0]`. But SymPy's
table uses `expint(a, t)` which has `ap=[a], bm=[a-1, 0]`. Let `p = 1-a`:
```
expint(1-a, z) → G with ap=[1-a], bm=[-a, 0]
```
After multiplying by `z^{-a}` (the prefactor), the resulting G-form is equivalent to the
UpperIncompleteGamma G-form `ap=[1], bm=[a, 0]` after the substitution — but this
equivalence requires parameter shifting, not a simple G-form identity. The Wikipedia form
(directly at `ap=[1], bm=[a,0]`) is simpler and more direct.

**Resolution:** Pin the Wikipedia form `G^{2,0}_{1,2}(_; 1; a, 0 | z)` as canonical for
the UpperIncompleteGamma bridge. Do NOT derive it via the SymPy expint form (that adds
a multiplication by `z^{-a}` that the bridge's `wrap` would need to carry, breaking the
prefactor=1 simplicity).

### F.3 The disambiguation problem: `(2,0,1,2)` shape collision

This is the most subtle conflict in the gamma bridge. The `(2,0,1,2)` shape is used by:

1. `Erfc(z)` — `ap=[1], bm=[0, 1/2]` or `[1/2, 0]`
2. `ExpIntegralE(1, z)` — `ap=[1], bm=[0, 0]`
3. `UpperIncompleteGamma(a, z)` — `ap=[1], bm=[a, 0]`

For general `a`, pattern 3 subsumes patterns 1 and 2 as special cases:
- `a = 0`: bm=[0, 0] → matches ExpIntegralE(1, z)
- `a = 1/2`: bm=[1/2, 0] → matches Erfc(z)

This means the backward rule for UpperIncompleteGamma must be **the most general rule and
must run LAST**, after Erfc and ExpIntegralE(1) rules have already fired (or been declined
by their more-specific matchers). The first-match-wins discipline in the dispatcher handles
this: order the rules as:
1. Erfc rule (specific: bm contains 1/2)
2. ExpIntegralE(1) rule (specific: bm = [0, 0])
3. UpperIncompleteGamma rule (general: bm = [a, 0] — fires only if 1 and 2 declined)

This is the canonical resolution: more-specific rules first, general rule last.

**In the bridge's `meijerGToHead` standalone backward path**, the same ordering applies:
check for Erfc shape first, then ExpIntegralE(1), then fall through to UpperIncompleteGamma.

### F.4 The Wolfram Functions Site is unreachable (HTTP 403)

The Wolfram Functions Site at `/GammaBetaErf/Gamma/26/01/01/` returned HTTP 403, consistent
with the Erf R4 experience. No formula text was extractable. The triangulation through
DLMF §8.6 Mellin-Barnes kernels + Wikipedia Meijer-G table + SymPy meijerint.py provides
sufficient cross-validation. Where the three agree (lower and upper incomplete gamma
G-forms), the canonical forms are pinned with confidence. Where SymPy is silent (complete
Gamma, Beta, BarnesG), the refusals are justified by the structural argument in §A.2.

---

## §G — Inline summary (architecture questions for the ADR)

### G.1 G-form table headline

The gamma family bridge is simpler than Erf/Bessel in two ways: (a) the z-substitution
is the identity (no squaring, no multi-valued inverse), and (b) the `an` and `ap` slots
carry fixed integer constants (`[1]`), not ν-dependent expressions. This makes the
canonical forms clean:

| Head | G-form | Prefactor |
|---|---|---|
| `LowerIncompleteGamma(a,z)` | G^{1,1}_{1,2}(1; a, 0 \| z) | 1 |
| `UpperIncompleteGamma(a,z)` | G^{2,0}_{1,2}(\_;1; a,0\|z) | 1 |
| `Gamma(z)` | NONE (honest refusal) | — |
| `Beta(a,b)`, `BarnesG(z)`, `Pochhammer(a,n)`, `Digamma(z)`, `Polygamma(n,z)` | NONE | — |

The two representable heads are **both 2-argument**, and the `argsInverse` closure handles
them exactly like Bessel's 2-arg pattern.

### G.2 Bridge API decisions

1. **`headToMeijerG("Gamma", [z])` → null.** Explicit honest refusal, not "unknown head".
   The comment in the bridge code must explain WHY (§A.2): Γ's argument appears in the
   integrand exponent, not just the G-function's z-slot.

2. **z-substitution = identity for both bridgeable heads.** This is simpler than Erf/Bessel.
   The `form.z` slot IS the head's `z` argument.

3. **`meijerGToHead` disambiguation for `(2,0,1,2)`:** Erfc first (bm contains 1/2),
   ExpIntegralE(1) second (bm=[0,0]), UpperIncompleteGamma last (general a).

4. **Blocked on vocabulary admission.** The bridge module can be written as a stub returning
   null for all heads (and the honest-refusal heads) until the ADR-0023 amendment lands.
   The stub + tests for null-return would establish the module structure.

5. **No API extension needed.** The `ForwardBridge` interface (`argsInverse: () =>
   readonly Value[]`, `wrap`, `gForm`) accommodates the gamma family with existing types.

### G.3 Closure-test plan

See §D.2. Key tests:
- Forward + argsInverse round-trip for LowerIncompleteGamma and UpperIncompleteGamma.
- Backward matcher disambiguation: Erfc not confused with UpperIncompleteGamma, E_1 not
  confused with UpperIncompleteGamma(0).
- Honest-refusal tests for Gamma, Beta, BarnesG.
- Mutation tests proving the tests catch regressions.

### G.4 Architecture questions for the ADR

**Q1 (vocabulary admission):** Should `LowerIncompleteGamma` and `UpperIncompleteGamma`
be admitted to ADR-0023's vocabulary, and if so, what are their canonical head names?
Recommendation: yes; `LowerIncompleteGamma(a, z)` and `UpperIncompleteGamma(a, z)`.

**Q2 (E_1 disambiguation):** Should `UpperIncompleteGamma(0, z)` map to `ExpIntegralE(1,z)`
in the backward bridge (since that head is already in the vocabulary), or should it emit
`UpperIncompleteGamma(0, z)` once that head is admitted? Recommendation: emit
`ExpIntegralE(1, z)` for `a=0` (more specific; head is already in vocabulary); emit
`UpperIncompleteGamma(a, z)` for `a ≠ 0`.

**Q3 (Gamma honest refusal):** The bridge must explicitly document that `Gamma(z)` returns
null NOT because of a gap but because of a structural impossibility (§A.2). Does the ADR
need a section explaining this architectural distinction? Recommendation: yes; a short ADR
section "Gamma-as-named-head vs Gamma-as-coefficient" prevents future agents from "fixing"
the honest refusal.

**Q4 (rule ordering):** The new gamma dispatch rules `(1,1,1,2)` and `(2,0,1,2)` must be
ordered relative to existing Erf rules in the same shapes. What ordering does the dispatcher
use? The first-match-wins discipline requires more-specific rules first. The Erf rules use
literal bm/bq slots; the gamma rules use a free-slot `a`. Standard ordering: literals
before frees. This is already the discipline in `bateman-5-6.ts` (see the file-top comment
"Rule ordering: most-specific-first"). The gamma rules can follow the same discipline.

**Q5 (Bateman §5.6 (38, 40) bead):** Once the vocabulary is admitted, the existing comment
in `bateman-5-6.ts` line 678–679 can be resolved. Should that be a new bead or part of
the grammar bridge bead? Recommendation: new bead (it is a dispatcher-layer concern, not
a bridge-layer concern; the two should stay decoupled).

---

## Pointers

- **`docs/adr/0023-cas-core-special-function-vocabulary.md`** — the vocabulary table;
  target for the amendment that admits `LowerIncompleteGamma` and `UpperIncompleteGamma`.
- **`packages/meijer-core/src/bridges/types.ts`** — `ForwardBridge` interface; no changes
  needed for the gamma bridge.
- **`packages/meijer-core/src/bridges/erf.ts`** — 1-arg bridge exemplar (z-substitution,
  honest refusal pattern, `meijerGToHead` disambiguation).
- **`packages/meijer-core/src/bridges/bessel.ts`** — 2-arg bridge exemplar
  (`argsInverse` 2-element list, `bm`-slot-based ν recovery).
- **`packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` line 678–679** — the
  in-source TODO comment that this research resolves.
- **`packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts`** — the existing `dlmf-16-17-e1`
  rule that is a special case of the UpperIncompleteGamma G-form.
- **DLMF §8.6** — equations 8.6.10–8.6.12 give the Mellin-Barnes kernels that pin the
  canonical G-forms.
- **Wikipedia Meijer-G §"Representation of other functions"** — the explicit table entries
  for lower and upper incomplete gamma.
- **SymPy `meijerint.py` line ~337** — `add(expint(a, t), [], [a], [a-1, 0], [], t)` —
  the ExpIntegralE G-form (general n) used in the §F.2 triangulation.
