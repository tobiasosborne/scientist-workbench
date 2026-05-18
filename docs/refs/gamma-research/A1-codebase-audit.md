# A1 — Gamma Family Codebase Audit

**Bead:** `scientist-workbench-t4bc`
**Date:** 2026-05-18
**Epic:** `scientist-workbench-xqc7` (Gamma family)
**Role:** A1 — CODEBASE AUDIT — gap matrix between existing Gamma substrate and the Erf/Bessel bar

---

## Executive summary (inline, 200-400 lines)

### Top-line headline

The Gamma family is the **most deeply embedded special function in the
workbench** — it is a first-class building block in `meijer-core/src/series.ts`
(~12 `cgamma` calls per Slater residue), in `coalescence.ts` (digamma/polygamma
cited for v0.2 higher-order residue handling), and in every Bateman dispatch
rule that emits a `Gamma(...)` factor (~4 output sites in `bateman-5-6.ts`
alone). Its arb-prec real and complex layers are genuinely strong in the narrow
band already implemented: Stirling + recurrence + reflection, near-pole
cancellation retry (bead `oj5j` complex, bead `zhrm` real), and Bernoulli-number
series. Diff rules for Gamma/Digamma/Polygamma are DLMF-cited and complete.

However, against the Erf/Bessel bar, **five of seven axes are missing
entirely**, and the two axes that ship have significant quality gaps. The existing
substrate is essentially a **"Phase 0" version of what it should become** — enough
to bootstrap the MeijerG engine but not enough to carry the "world's best Gamma"
claim.

### The 10 biggest gaps ranked by uplift cost

| Rank | Gap | Axes | Uplift |
|------|-----|------|--------|
| 1 | No `gamma-float64.ts` — Gamma family absent from `SPECIAL_HEADS` in `eval-numeric-expr.ts` | Axis 5 | Large: verbatim-port discipline for lgamma/gamma/digamma/trigamma/polygamma from SunPro/glibc/Cephes; complex gamma float64 (Stirling or Lanczos port) |
| 2 | No `gamma-identities.ts` — zero symbolic identity rules for Gamma family | Axis 1 | Large: DLMF Ch.5 has ~60 identities (functional equations, special values, reflection, duplication, Gauss multiplication, asymptotic series, inequalities, connections to Beta, zeta); a v0.1 shippable subset is 20-30 rules |
| 3 | No `bridges/gamma.ts` — Gamma family absent from Meijer-G bridge | Axis 6 | Medium-large: Γ-functions appear extensively IN Meijer-G rules as output factors; the standalone head-as-MeijerG direction (forward bridge: Γ(z) ↔ a 1×1 G-function; Π(z)/Β(...) ↔ ratios of G-functions) is entirely missing |
| 4 | `digamma` negative-argument support deferred and throws (`special.ts:340`) | Axis 3 | Medium: the reflection formula `ψ(1-z) - ψ(z) = π·cot(πz)` is already stated in the header comment (lines 27-28) and the fix is wired in complex (`cdigammaReflect`); needs `cos` import + real cot path |
| 5 | `polygamma` m≥2 throws (Hurwitz-zeta route deferred, `special.ts:472`) | Axes 3+4 | Medium: Hurwitz ζ(m+1, z) route is documented; real polygamma needs zeta; complex polygamma m≥2 is also missing entirely |
| 6 | `special.ts` is NOT in `bigfloat/src/special-funcs/` sub-directory; lives at root of `bigfloat/src/` | Axis 3 | Small: reorganisation/relocation bead; no algorithm changes but required to match the per-head layout pattern ADR-0040 §Decision 2 pins |
| 7 | No oracle cross-validation — no `bench/gamma-anchor/` directory exists | All axes | Medium: the Phase 1 corpus/oracle harness pattern needs a `generate-corpus.ts` covering 8 tiers (real positive, real negative, near-poles, complex Q1-Q4, half-integers, large |z|, digamma near negative integers, polygamma) and 5 oracle adapters |
| 8 | Gamma family absent from `tools/special-eval` dispatch table | Axis 7 | Small-medium: extend `ADMITTED_HEADS` and `SPECIAL_DISPATCH` with Gamma/LogGamma/Digamma/Trigamma/Polygamma once float64 module ships |
| 9 | No `applyGammaRewrites` pre-pass in `cas-simplify` | Axis 1 | Small: the architecture is explicitly pre-wired (`simplify.ts:253` says "Adding the next per-head substrate (Gamma, …) ships as a literally additive new pre-pass function") — the hook exists, the function does not |
| 10 | Mutation-proof test markers are incomplete — only 2 mutation-proof inline comments exist across all gamma tests vs 23 (Erf) and 47 (Bessel) | Quality | Small-medium: each existing test cluster should have at least 3 discriminating mutation documents; near-pole tests in `special.test.ts:158` and `complex.test.ts:315` do carry mutation-proof notes but the main numeric tests do not |

### Top 5 compatibility risks

1. **meijer-core/series.ts uses `cgamma` at ~12 call sites** — any signature
   change to `cgamma` or `clgamma` breaks the Slater residue engine. The
   current API (`cgamma(z: BigComplex, prec: number): BigComplex`) must be
   preserved byte-identically across all changes.

2. **coalescence.ts references `digamma`/`polygamma` for future higher-order
   residue work** — if `polygamma` m≥2 implementation breaks the m=0 or m=1
   fast-path, the Meijer-G engine downstream will silently regress.

3. **bateman-5-6.ts emits `"Gamma"` AST nodes in its output** — if the
   `Gamma` vocabulary head is renamed, changed in arity, or dropped from
   `SPECIAL_FUNCTION_HEADS`, ~4 dispatch-rule outputs will silently produce
   un-evaluable AST.

4. **The `digamma: negative argument support deferred` throw at `special.ts:340`**
   is an undocumented API restriction. Any downstream code that calls `digamma`
   on a negative non-integer argument will receive a `RangeError`; callers
   may not be expecting this constraint. The existing test suite does NOT
   cover negative digamma — so fixing this adds coverage but removing the
   throw without coverage would be unsafe.

5. **`special.ts:107` golden strings** (`"52.342777784553520181149008492418193679490132376114"`)
   are Wolfram-cross-validated but NOT part of a frozen corpus file. These
   are inline golden strings. If Stirling arithmetic changes (e.g. Bernoulli
   table changes, new working precision margins), these strings can silently
   shift. The Bessel pattern (frozen `corpus.json` + `agreement-matrix.md`)
   is the robustness upgrade needed.

### Green-field-rewrite vs incremental-uplift per module

| Module | Recommendation |
|--------|---------------|
| `bigfloat/src/special.ts` | **Incremental uplift** — the algorithms are correct and well-commented at the function level. Three targeted changes: (a) fix `digamma` negative-arg path (blocked only by `cos` import that exists in `transcendental.ts`); (b) add `polygamma` m≥2 via Hurwitz-zeta; (c) relocate to `special-funcs/gamma.ts`. |
| `bigfloat/src/complex.ts` (gamma section) | **Incremental uplift** — the `clgamma`, `clgammaReflect`, `clgammaShifted`, `clgammaStirling`, `cgamma`, `cdigamma`, `cdigammaReflect`, `cdigammaShifted`, `cdigammaStirling` functions are high quality (near-pole fix is load-bearing and correct). Add `ctrigamma` and `cpolygamma` m≥2 in place per ADR-0040 §Decision 2 (complex extensions belong in `complex.ts`). |
| `cas-core/src/special-functions.ts` | **Already complete for the shipped subset** (Gamma/Digamma/Polygamma diff rules with DLMF citations). Nothing needs changing here unless vocabulary expands. |
| `cas-core/src/special-funcs/gamma-identities.ts` | **New file** — zero overlap with anything existing. Full new module following the `erf-identities.ts` / `bessel-identities.ts` template; 20-30 rule v0.1 subset. |
| `quadrature/src/special-funcs/gamma-float64.ts` | **New file** — no partial work exists. Verbatim ports from SunPro/glibc lgamma/gamma; Cephes digamma/polygamma; Stirling-series complex gamma float64. |
| `meijer-core/src/bridges/gamma.ts` | **New file** — no partial work. The canonical Meijer-G representations of Γ(z) are in the literature (Bateman Vol. I, DLMF §16); the API template is `bridges/erf.ts`. |
| `tools/special-eval/tool.ts` | **Additive extension** — the per-head dispatch table extension is a small edit (as done for Bessel on top of Erf). Blocked on `gamma-float64.ts` shipping. |

---

## §1 — Per-file inventory of current Gamma substrate

### 1.1 `packages/bigfloat/src/special.ts` (474 LOC)

**Location:** `/home/tobiasosborne/Projects/scientist-workbench/packages/bigfloat/src/special.ts`

**Exported entry points:**

```ts
export function lgamma(z: BigFloat, prec: number): BigFloat      // line 72
export function gamma(z: BigFloat, prec: number): BigFloat       // line 271
export function digamma(z: BigFloat, prec: number): BigFloat     // line 313
export function trigamma(z: BigFloat, prec: number): BigFloat    // line 405
export function polygamma(m: number, z: BigFloat, prec: number): BigFloat  // line 465
```

**Internal helpers (not exported):**

```ts
function bernoulli(n: number, prec: number): BigFloat   // line 49 — B_{2k} at prec bits
function lgammaStirling(...)                            // line 117
function lgammaRealAbs(...)                             // line 187 — log|Γ| for all real z
function zMagBits(...)                                  // line 243
function digammaStirling(...)                           // line 364
function trigammaStirling(...)                          // line 431
```

**Top-of-file algorithm narrative:** 36 lines before first `import` statement
(lines 1-36). The narrative describes the 3 algorithms for lgamma (Stirling,
recurrence, reflection) and digamma, plus the polygamma Hurwitz-zeta route.

**Comparison to bar:** `erf.ts` has **225 lines** before first `import` (a full
algorithm exposition including cancellation analysis, Borel vs textbook form
comparison, optimal-truncation idiom, continued-fraction lane, cancellation-retry
slot explanation, and a References section). `besselj.ts` has **154 lines**.
`special.ts`'s 36-line narrative is **6-7× shorter** than the bar.

**Per-function literate prose (presence and quality):**
- `lgamma` (lines 66-108): Has a 13-line doc comment with algorithm explanation.
  **Partial.** Missing: crossover threshold derivation, primary literature citation,
  working-precision margin justification, and comparison to alternative algorithms.
- `lgammaStirling` (lines 111-161): 4-line doc comment. **Terse.** The Stirling
  formula itself is cited but without DLMF section number or book reference.
- `lgammaRealAbs` (lines 163-236): **Excellent** — 35-line doc comment explaining
  the near-pole cancellation problem in full (two compounding cancellations,
  reduction strategy, `lossBits` accounting, byte-identical m=0 region, bead
  `zhrm` citation). This is the quality bar that the other functions should match.
- `gamma` (lines 249-304): **Excellent** — 30-line doc comment explaining the
  algebraic sign-detection identity `sgn(Γ(z)) = (−1)^m · sgn(ζ)`, why it's
  better than the pre-fix `sgn(sin(πz))` approach, bead `zhrm` citation.
- `digamma` (lines 306-358): 9-line doc comment. **Terse.** The throw at line 340
  (`negative argument support deferred to v0.2`) is the most significant quality
  gap — there's no `cos` import, and the `cot` formula in the comment at lines
  327-338 is visibly incomplete (a partial derivation appears then throws).
- `digammaStirling` (lines 361-391): 3-line doc comment. **Very terse.**
- `trigamma` (lines 393-425): 8-line doc comment. **Adequate** for the
  algorithm (recurrence + Stirling). Missing primary citation (DLMF §5.15.2).
- `trigammaStirling` (lines 428-455): 3-line doc comment. **Very terse.**
- `polygamma` (lines 457-474): 7-line doc comment. **Adequate** for current
  scope (m=0 and m=1 dispatch, throw for m≥2 with clear message).

**Algorithm citations (primary source per algorithm):**
- The 36-line file header names Stirling's asymptotic series, the recurrence,
  and the reflection formula — but cites NO primary source (no DLMF section,
  no Abramowitz & Stegun, no Johansson/Arb paper).
- The diff rules in `special-functions.ts` ARE DLMF-cited (§5.4.2, §5.7.1,
  §5.15.3) — but that's the CAS side, not the arb-prec evaluator side.
- Compare: `erf.ts` cites DLMF §7.6.2 (Borel form), R2 §1.2, `docs/adr/0040`,
  `docs/adr/0020`, `docs/refs/erf-research/R2-arbprec-algorithms.md §1.2, §2.1`,
  and the DLMF sections for the asymptotic and CF. `besselj.ts` similarly cites
  DLMF Ch.10 per algorithm.
- **Gap: No DLMF citations in `special.ts` for lgamma/digamma/trigamma algorithms.**

**Cancellation-retry slot wired:**
- `lgammaRealAbs` (lines 216-218): **YES** — `lossBits` measured, `work = prec + 32 + lossBits`. This is the real-argument mirror of `clgammaReflect`'s `oj5j` fix.
- `lgammaStirling`, `digammaStirling`, `trigammaStirling`: **NO** — fixed `work = prec + 32` or `prec + 96`. No cancellation measurement or retry. For `lgammaStirling` this is acceptable because Stirling is entered only when z is large (no catastrophic cancellation); but the function doesn't document this invariant.
- `gamma` (line 301): calls `lgammaRealAbs(z, prec + 32)` — fixed 32-bit bump. Adequate for `gamma`, which only loses ~1 bit to the final `exp`.

**Direct-path discipline:**
- `gamma` is computed as `exp(lgamma(z))` for z > 0 (line 273) — **not independent**. The Erf precedent ("`bigErfc` is NOT `1 - bigErf`") would demand a direct `gamma` path for cases where `exp(lgamma(z))` loses bits. For `gamma(z) > 0` with `z > 0` this is safe (no cancellation in `exp`). For `z < 0`, `gamma` calls `lgammaRealAbs` then `exp` then negates — also safe (log|Γ| is positive-valued, `exp` is monotone). Direct-path discipline is **not violated** here, but the design should be **explicitly documented** as intentional. `erf.ts`'s top-of-file makes this explicit with "bigErfc is not 1 - bigErf."
- `digamma` dispatches to `digammaStirling` for all positive arguments — **no separate `digamma` series** for small z. This is correct (recurrence shifts z up to the Stirling-friendly region), but the design is **not explained** at the function level.
- `polygamma` dispatches m=0 → `digamma`, m=1 → `trigamma` — correct and documented.

**Mutation-proof tests:**
- `special.test.ts:158`: inline comment says "Mutation proof: reverting `lgammaRealAbs` to the `πz`-first form collapses the ε = 1e-69 cases to ~20 / ~40 digit agreement at 30 / 50 dps — a hard RED." **One documented mutation** for `lgammaRealAbs`.
- `gamma` function: the algebraic sign-detection has a mutation comment in `complex.test.ts:315` (for the complex version), but NO documented mutation for the real `gamma` sign path.
- `lgammaStirling`: **no mutation-proof documentation**.
- `digammaStirling`, `trigammaStirling`: **no mutation-proof documentation**.
- Total: **1 documented mutation** (at the near-pole path) vs 23 (Erf) and 47 (Bessel).

**Oracle cross-validation:**
- The golden strings in `special.test.ts` (lines 107-108, 237-241, 248, 252-270, 278-292) are Wolfram/mpmath cross-validated by provenance (the comment header at lines 6-15 gives reference values "from mpmath at 50 dps").
- **No `bench/gamma-anchor/` directory exists.** There is no frozen corpus file, no `generate-corpus.ts`, no `cross-agreement.ts`, no oracle adapter scripts.
- Compare: Erf has `bench/erf-anchor/` with `corpus.json`, `generate-corpus.ts`, `cross-agreement.ts`, `oracles/{wolfram,mpmath,boost,scipy}/results.json`, `agreement-matrix.md`. Bessel has the same structure at `bench/besselj-anchor/`.
- **Gap: 0% of the oracle-harness infrastructure exists for Gamma.**

**Precision contract:**
- The `arbprec: true` contract (ADR-0020) applies: every operation is BigInt + bounded-integer-exponent, bit-identical cross-platform forever given same `(input, prec)`.
- The per-function precision claim is not explicitly stated in `special.ts`, unlike `erf.ts` which says "produces a result with precision exactly `prec` bits (post-normalisation)."

---

### 1.2 `packages/bigfloat/src/complex.ts` (gamma sections, lines 388-836)

**Location:** `/home/tobiasosborne/Projects/scientist-workbench/packages/bigfloat/src/complex.ts`

**Exported entry points (gamma-related):**

```ts
export function clgamma(z: BigComplex, prec: number): BigComplex   // line 388
export function cgamma(z: BigComplex, prec: number): BigComplex    // line 637
export function cdigamma(z: BigComplex, prec: number): BigComplex  // line 649
```

**Internal helpers (gamma-related):**

```ts
function clgammaShifted(z, prec)      // line 406
function clgammaStirling(z, prec)     // line 437
function magBits(z)                   // line 480
function bernoulliRationalLocal(n)    // line 495
function bernoulliFloat(r, prec)      // line 498
function clgammaReflect(z, prec)      // line 546
function cdigammaShifted(z, prec)     // line 660
function cdigammaStirling(z, prec)    // line 686
function cdigammaReflect(z, prec)     // line 741
```

**Top-of-file algorithm narrative:** The file-level header (lines 1-96) covers
the full module including the Bessel extensions (I3a, I3b). The Gamma-specific
narrative is part of the initial module comment (lines 10-18 listing the
"minimum surface needed to bootstrap the Slater path" including `cgamma`/`clgamma`/`cdigamma`).
The load-bearing per-function narrative is concentrated in `clgammaReflect`'s
doc comment (lines 511-545, ~35 lines) and `cdigammaReflect`'s doc comment
(lines 722-740, ~19 lines) — both fully literate with the `oj5j` cancellation
analysis.

**Per-function literate prose:**
- `clgamma` (lines 388-400): 5-line doc comment. **Terse.** Adequate as a dispatch wrapper, but missing citation.
- `clgammaShifted` (lines 402-431): 3-line doc comment. **Very terse.**
- `clgammaStirling` (lines 433-478): 3-line doc comment. **Very terse.** The function is structurally a straight port of `lgammaStirling` but for BigComplex; this deserves an explanation of why the real algorithm generalises to complex directly (the Stirling expansion is analytic everywhere in the right half-plane; the complex extension is not a new algorithm but the same formula with complex arithmetic).
- `clgammaReflect` (lines 511-631): **Excellent** — 35-line doc comment with the full bead `oj5j` analysis. Mutation-proof documentation inline (line 315 of complex.test.ts: "Mutation proof: reverting either *Reflect to the πz-first form collapses the ε = 1e-69 cases to ~21 / ~41 agreeing digits at the 30 / 50 dps requests — a hard RED").
- `cgamma` (lines 633-643): 2-line doc comment. **Very terse.** The `cexp(clgamma(z, prec + 16), prec)` delegation chain deserves a note on why 16 extra bits suffice (analogous to `gamma`'s `prec + 32` margin).
- `cdigamma` (lines 645-658): 3-line doc comment. **Terse.**
- `cdigammaShifted` (lines 660-683): **No doc comment.** Should explain that it is the complex analogue of `digamma`'s recurrence path.
- `cdigammaStirling` (lines 686-720): **No doc comment.** Same gap.
- `cdigammaReflect` (lines 722-836): **Good** — 19-line doc comment explaining the `cot(πz) = cot(πζ)` reduction and the `oj5j` pattern applied to cotangent poles.

**Algorithm citations:** Same gap as `special.ts` — no DLMF section numbers for the Stirling / recurrence / reflection algorithms. The `oj5j`/`zhrm` bead citations exist for the near-pole paths, but not for the primary algorithm choices.

**Cancellation-retry slot:**
- `clgammaReflect` (lines 579-581): **YES** — `lossBits = Math.max(0, magBits(z) - magBits(zeta0))`, `work = prec + 32 + lossBits`. Fully wired.
- `cdigammaReflect` (lines 763-766): **YES** — same pattern.
- `clgammaShifted`, `clgammaStirling`, `cdigammaShifted`, `cdigammaStirling`: **NO** — fixed `prec + 96` or `prec + 32` bump.

**Direct-path discipline:** `cgamma` = `cexp(clgamma(z, prec + 16), prec)` — same pattern as real `gamma`. No independent complex gamma path. Acceptable for the same reason: `cexp` of a complex log-gamma has no catastrophic cancellation for normal inputs. Same documentation gap.

**Missing:** No `ctrigamma`, no `cpolygamma`. The real `trigamma` and `polygamma(m≥2)` have complex analogues that are not implemented. The `coalescence.ts` note (line 105) says these are needed for higher-order Meijer-G residues.

---

### 1.3 `packages/cas-core/src/special-functions.ts` (gamma sections)

**Exported functionality:**
- `SPECIAL_FUNCTION_HEADS` includes `"Gamma"`, `"Digamma"`, `"Polygamma"` (lines 136-138, 180).
- `SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS` includes all three (lines 190-194).
- `ARITY_TABLE`: `Gamma` fixed-1, `Digamma` fixed-1, `Polygamma` fixed-2 (lines 238-240).
- `differentiateSpecialFunction`: dispatches `ruleGamma`, `ruleDigamma`, `rulePolygamma` (lines 346-349).

**Diff rule quality:**
- `ruleGamma` (lines 427-441): `d/dz Γ(z) = ψ(z)·Γ(z)` — DLMF §5.4.2 cited inline. **Complete and DLMF-cited.** Chain-rule aware.
- `ruleDigamma` (lines 443-453): `d/dz ψ(z) = ψ⁽¹⁾(z)` — DLMF §5.7.1 cited. **Complete.**
- `rulePolygamma` (lines 456-469): `d/dz ψ⁽ⁿ⁾(z) = ψ⁽ⁿ⁺¹⁾(z)` — DLMF §5.15.3 cited. **Complete.** Discrete-order `n` refuses correctly.

**Quality assessment:** This section is the **strongest part of the existing
Gamma substrate** — fully DLMF-cited, literate, and correctly wired. The
5 tests in `cas-core/test/special-functions.test.ts` (lines 199-237) cover
the basic rules and chain-rule cases.

**Missing diff rules:**
- `IncompleteGamma`, `Beta`, `BarnesG`, `Pochhammer` — these heads don't exist in the vocabulary yet.
- Parameter-derivative of Polygamma w.r.t. the order `n` — correctly refused (returns null per line 466).

---

### 1.4 `packages/cas-core/src/simplify.ts` (gamma extension point)

**Location:** lines 245-264 (the "Bessel-family pre-pass" comment block)

At line 253: _"Adding the next per-head substrate (Gamma, Whittaker, …) ships as a literally additive new pre-pass function"_ — the extension point is explicitly pre-wired. The current pipeline is:

```ts
const afterErf = applyErfRewrites(v);       // line 98
const rewritten = applyBesselRewrites(afterErf);  // line 99
return simplifyRatFn(rewritten);
```

Adding Gamma will become:
```ts
const afterErf = applyErfRewrites(v);
const afterBessel = applyBesselRewrites(afterErf);
const rewritten = applyGammaRewrites(afterBessel);  // NEW
return simplifyRatFn(rewritten);
```

**Gap:** `applyGammaRewrites` does not exist. `gamma-identities.ts` does not exist.

---

### 1.5 `packages/quadrature/src/eval-numeric-expr.ts`

**ADMITTED_HEADS / SPECIAL_HEADS (lines 107-123):**
```ts
export const SPECIAL_HEADS: readonly string[] = [
  "Erf", "Erfc", "Erfcx", "Erfi", "InverseErf", "InverseErfc",
  "BesselJ", "BesselY", "BesselI", "BesselK",
];
```

**Gamma family is NOT in `SPECIAL_HEADS`.** No `Gamma`, `Digamma`,
`Polygamma`, `Trigamma`, `LogGamma` entries. No `SPECIAL_DISPATCH` entries
for any Gamma head. No import from any `gamma-float64.ts` module.

**Compare to Bessel:** When Bessel shipped (ADR-0041 I5a), `eval-numeric-expr.ts`
gained 4 new `SPECIAL_HEADS` entries and 4 `SPECIAL_DISPATCH` entries, each
delegating to `besselJFloat64`, `besselYFloat64`, `besselIFloat64`, `besselKFloat64`
from `quadrature/src/special-funcs/bessel-float64.ts`.

**Gap:** The entire float64 dispatch hook for the Gamma family is missing.

---

### 1.6 `packages/quadrature/src/special-funcs/` directory

**Contents:** `bessel-float64.ts`, `erf-float64.ts`.

**`gamma-float64.ts` does not exist.** No partial implementation. The
contrast with `erf-float64.ts` (1101 LOC, SunPro 1993 verbatim port +
Faddeeva-Johnson MIT) and `bessel-float64.ts` (1863 LOC, 6 verbatim ports)
is stark.

**What should be here:**
- `lgammaFloat64(x: number): number` — SunPro 1993 / glibc `__ieee754_lgamma` port (real)
- `gammaFloat64(x: number): number` — glibc `__ieee754_gamma` or FreeBSD `tgamma` verbatim port
- `digammaFloat64(x: number): number` — Cephes `psi.c` verbatim port (most widely deployed)
- `trigammaFloat64(x: number): number` — Cephes or Boost `trigamma` port
- `polygammaFloat64(m: number, x: number): number` — Cephes `psi.c`-based, m-derivative recurrence
- `lgammaComplexFloat64(re: number, im: number): {re: number, im: number}` — Stirling-series float64 (no verbatim-port candidate; SciPy uses mpmath for complex; Wolfram Mathematica's kernel is closed — will need R3 research to pin)

---

### 1.7 `packages/meijer-core/src/dispatch-rules/` (Gamma as OUTPUT factor)

**Files surveyed:**
- `bateman-5-6.ts` (686 LOC): Uses `gamma()` helper (line 83-85) to emit `expr("Gamma", [z])` nodes in rule outputs. ~4 call sites in the actual rule bodies (lines 409, 429, 450 — Gamma appears in prefactors for Bessel-family rules).
- `dlmf-16-18.ts` (195 LOC): The Erf forward rules. No Gamma output nodes.
- `bessel-backward.ts` (323 LOC): Bessel backward-direction rules. No Gamma output nodes directly (Gamma is a factor in the mathematical derivation but the rules emit Bessel heads).
- `erf-forward-form-a.ts`, `erfc-forward.ts`, `erfi-forward.ts`: Erf/Erfc/Erfi G-function rules. No Gamma output nodes.

**Role of Gamma in dispatch rules:** Gamma appears as an **output factor** — the
Bateman §5.6 reduction formulas express certain G-functions as prefactor×Gamma×simpler-function
combinations. The `gamma()` builder at `bateman-5-6.ts:83-85` is the sole
production site of `"Gamma"` AST nodes from the Meijer-G dispatch layer.

**Future note (lines 678-679):** Comment says Bateman §5.6 (38), (40) — the
incomplete-gamma family — need `IncompleteGamma` head added to ADR-0023's
vocabulary. This is a downstream gap that will require the Gamma family epic to
first land `IncompleteGamma` in the vocabulary table before these rules can ship.

---

### 1.8 `packages/meijer-core/src/bridges/` directory

**Contents:** `bessel.ts`, `erf.ts`, `types.ts`.

**`bridges/gamma.ts` does not exist.** No partial implementation.

The `types.ts` module (173 LOC) is well-documented and fully generalises to
any head (including Gamma) via `argsInverse`. The API contract is fully ready
for a `gamma.ts` bridge to be added.

**What Gamma Meijer-G bridge would cover:**
- `Γ(z)` as a G-function: `G^{1,0}_{0,1}({} | {0} | z)` — the trivial 1-pole G-function that evaluates by the residue formula. This is the formal bridge; in practice `Γ(z)` is used as a building block in larger G-functions, and the interesting direction is `B(a,b) = Γ(a)Γ(b)/Γ(a+b)` → G-function form (DLMF §16.2.2).
- The Pochhammer symbol `(a)_n = Γ(a+n)/Γ(a)` as a G-ratio.
- The Beta function `B(a,b) = G^{2,0}_{1,2}(...)`.

---

### 1.9 `packages/meijer-core/src/series.ts` and `coalescence.ts`

**Downstream consumers of Gamma substrate — the load-bearing dependency chain:**

`series.ts` (the Slater residue evaluator): imports `cgamma` from `@workbench/bigfloat`
at line 48. Uses it at ~12 call sites in the residue formula body (lines 144, 147,
153, 156, 229, 232, 238, 241 and surrounding lines). Every Meijer-G evaluation
that uses the Slater path goes through `cgamma` for each pole.

`coalescence.ts` (near-integer-spacing handler): references `digamma`/`polygamma`
at lines 23 and 105 as the future higher-order residue path. Currently uses only
the bit-magnitude perturbation approach; the `digamma`/`polygamma` route is the
planned v0.2 upgrade for clusters of 3+ coalesced poles.

`contour.ts`: imports `cgamma` at line 108.

**Compatibility constraint:** The `cgamma(z: BigComplex, prec: number): BigComplex`
signature is a hard API surface that must not change. The `clgamma`, `cdigamma`
signatures are less exposed externally but still load-bearing for the test suite.

---

### 1.10 `tools/special-eval/tool.ts`

**Per-head dispatch table (lines 261-275):**
```ts
const ADMITTED_HEADS = [
  "Erf", "Erfc", "Erfcx", "Erfi", "InverseErf", "InverseErfc",  // Erf family
  "BesselJ", "BesselY", "BesselI", "BesselK", "BesselIScaled", "BesselKScaled",  // Bessel family
];
```

**Gamma family is completely absent.** The tool's golden string at line 1230
explicitly says "head not in {Erf, Erfc, Erfcx, Erfi, InverseErf, InverseErfc,
BesselJ, BesselY, BesselI, BesselK, BesselIScaled, BesselKScaled} → tagged
'special-eval/unknown-head'". A Gamma request would receive `unknown-head`.

---

### 1.11 Test files

**`packages/bigfloat/test/special.test.ts` (310 LOC, 32 tests):**

Tests cover: Bernoulli numbers (3 tests), gamma at integers (5), gamma at
half-integers (3), gamma at negative non-integers (2), poles (2), near-pole
reflection precision bead zhrm (8 parametric tests), lgamma (3), digamma (4),
trigamma (3), polygamma dispatch (3).

Quality issues:
- The near-pole tests (bead zhrm, lines 138-229) are **genuine mutation-proof tests** with documented mutation markers. Excellent.
- The `digamma`, `trigamma`, `lgamma` tests assert specific 50-dp string values cross-validated against Wolfram/mpmath. Good.
- **Missing:** tests for negative-argument digamma (currently throws), complex-valued digamma (in separate file), polygamma m≥2 (currently throws), large-z behavior, near-zero behavior.
- **Missing:** mutation-proof documentation for the Stirling series (lgammaStirling / digammaStirling / trigammaStirling). A mutation perturbation (e.g. change `prec + 96` to `prec + 8`) should cause visible precision loss; no such test is documented.

**`packages/bigfloat/test/complex.test.ts` (395 LOC, 40 tests total, ~10 gamma-related):**

Gamma-related describes: `cgamma` (4 tests), `cdigamma` (2 tests), `clgamma/cdigamma — near-pole reflection precision` (10 parametric tests = 5 cases × 2 functions + 2 controls).

Quality: The near-pole tests (oj5j bead, lines 298-394) are excellent — genuine mutation-proof tests. The basic `cgamma` and `cdigamma` tests check only float64-precision values (`.toBeCloseTo(..., 13)`), not 50-dp arb-prec strings.

**Missing:** No 50-dp arb-prec golden tests for complex gamma. No tests for ctrigamma or cpolygamma (don't exist). No tests for cgamma on the imaginary axis, near Re(z) = 1/2, in Q2/Q3/Q4.

**`packages/cas-core/test/special-functions.test.ts` (822 LOC, 67 tests total, ~5 gamma-related):**

5 tests in the "differentiate — Gamma family" describe block (lines 199-237):
- `d/dz Γ(z) = ψ(z)·Γ(z)`, `d/dz ψ(z) = ψ⁽¹⁾(z)`, `d/dz ψ⁽ⁿ⁾(z) = ψ⁽ⁿ⁺¹⁾(z)`, discrete-order refusal, chain rule `d/dz Γ(2z)`.

Quality: Complete for the shipped diff rules. No mutation-proof documentation.

---

## §2 — Per-axis gap matrix

### AXIS 1 — Symbolic identities (`cas-core/src/special-funcs/<head>-identities.ts`)

| Item | Status |
|------|--------|
| `gamma-identities.ts` exists | **NO** |
| `applyGammaRewrites` in simplify.ts | **NO** (placeholder comment exists at line 253) |
| Gamma identity rules shipped | 0 (zero) |
| Erf identity rules for comparison | 19 rules (690 LOC file, 522 LOC test) |
| Bessel identity rules for comparison | 29 rules (966 LOC file, 518 LOC test) |

**What SHOULD be here (DLMF Ch.5 identities, v0.1 subset):**

Priority A (fundamental values and symmetry — 8 rules):
1. `Γ(1) = 1` (DLMF §5.4.1)
2. `Γ(n+1) = n·Γ(n)` for positive integer n — recurrence (DLMF §5.4.1)
3. `Γ(1/2) = √π` (DLMF §5.4.3)
4. `Γ(3/2) = √π/2` (follows from above + recurrence)
5. `Γ(n) = (n-1)!` for positive integer n
6. Reflection: `Γ(z)·Γ(1-z) = π/sin(πz)` (DLMF §5.5.3)
7. Duplication: `Γ(z)·Γ(z+1/2) = (√π/2^{2z-1})·Γ(2z)` (DLMF §5.5.5)
8. `Γ(n + 1/2) = ((2n-1)!!/2^n)·√π` for non-negative integer n

Priority B (digamma / polygamma values — 6 rules):
9. `ψ(1) = -γ` (Euler-Mascheroni constant, DLMF §5.2.3)
10. `ψ(n+1) = ψ(1) + H_n` (harmonic number relation, DLMF §5.4.5)
11. `ψ(1/2) = -γ - 2·log(2)` (DLMF §5.4.6)
12. `ψ(n + 1) = ψ(n) + 1/n` (recurrence, DLMF §5.4.7)
13. `ψ⁽¹⁾(1) = π²/6` (trigamma at 1, DLMF §5.15.3)
14. `ψ⁽¹⁾(1/2) = π²/2` (trigamma at 1/2)

Priority C (connection formulas — 4 rules):
15. `Γ(z+1) = z·Γ(z)` (shift = recurrence, most-used)
16. `Γ(-n-ε) ≈ (-1)^n/(n!·ε) - ψ(n+1)·(-1)^n/n! + O(ε)` near-pole expansion
17. `log Γ(z) ~ (z-1/2)·log(z) - z + (1/2)·log(2π)` — leading Stirling term as symbolic approx
18. Half-integer: `Γ(n + 1/2) = Γ(1/2) · (1/2)·(3/2)·...·((2n-1)/2)`

Priority D (special-function connections — 4 rules):
19-22. Beta, Pochhammer, incomplete gamma connections — blocked on vocabulary heads landing.

**Gap estimate:** 20-30 rules for a v0.1-shippable subset. Each rule ~25-40 LOC
with commentary + test. Total: ~600-900 LOC new file + ~400-600 LOC test file.

---

### AXIS 2 — Diff rules (`cas-core/src/special-functions.ts`)

| Function | Shipped | Quality |
|----------|---------|---------|
| `d/dz Γ(z) = ψ(z)·Γ(z)` | YES (line 427) | DLMF §5.4.2 cited. Complete. |
| `d/dz ψ(z) = ψ⁽¹⁾(z)` | YES (line 443) | DLMF §5.7.1 cited. Complete. |
| `d/dz ψ⁽ⁿ⁾(z) = ψ⁽ⁿ⁺¹⁾(z)` | YES (line 456) | DLMF §5.15.3 cited. Complete. |
| `d/dz B(a,z)` | NO | Missing head |
| `d/dz Γ(a,z)` (incomplete gamma) | NO | Missing head |
| `d/dz P(a,z)`, `d/dz Q(a,z)` | NO | Missing heads |
| `d/dz (a)_n` (Pochhammer) | NO | Missing head |
| `d/da Γ(z)` (parameter derivative) | Not applicable (Gamma is 1-arg) | — |
| `d/dn ψ⁽ⁿ⁾(z)` (order derivative) | Refused correctly (line 466) | Honest refusal |

**Gap:** The shipped rules are correct and complete for the 3 heads currently in
the vocabulary. The gap is the missing heads (IncompleteGamma, Beta, Pochhammer,
BarnesG) that are not yet in `SPECIAL_FUNCTION_HEADS`.

---

### AXIS 3 — Arb-prec real (`bigfloat/src/special-funcs/`)

| Function | Status | Quality | Gaps |
|----------|--------|---------|------|
| `lgamma(z, prec)` real z>0 | SHIPS in `special.ts:72` | Good algorithm, terse docs | No primary citation; no cancer-retry for Stirling; not in `special-funcs/` sub-dir |
| `lgamma(z, prec)` real z<0 | SHIPS via `lgammaRealAbs` | Excellent near-pole fix | — |
| `gamma(z, prec)` real z>0 | SHIPS in `special.ts:271` | Good | — |
| `gamma(z, prec)` real z<0 non-integer | SHIPS | Excellent algebraic sign | — |
| `digamma(z, prec)` real z>0 | SHIPS in `special.ts:313` | Good | — |
| `digamma(z, prec)` real z≤0 | **THROWS** at `special.ts:340` | DEFERRED | Blocked on `cos` import |
| `trigamma(z, prec)` real z>0 | SHIPS in `special.ts:405` | Adequate | z≤0 throws |
| `polygamma(m, z, prec)` m=0,1 | SHIPS via dispatch | Adequate | — |
| `polygamma(m, z, prec)` m≥2 | **THROWS** at `special.ts:472` | DEFERRED | Hurwitz-zeta route unimplemented |
| `reciprocalGamma(z, prec)` 1/Γ(z) | MISSING | — | Entire function |
| `logBeta(a,b, prec)` log B(a,b) | MISSING | — | Entire function |
| `beta(a,b, prec)` B(a,b) | MISSING | — | Entire function |
| `pochhammer(a,n, prec)` (a)_n | MISSING | — | Entire function |
| `lowerIncompleteGamma(a,z, prec)` | MISSING | — | Entire function |
| `upperIncompleteGamma(a,z, prec)` | MISSING | — | Entire function |
| `barnesG(z, prec)` | MISSING | — | Entire function |
| `bigGammaP(a,z, prec)` (regularized) | MISSING | — | Entire function |

**File layout gap:** `special.ts` lives at `packages/bigfloat/src/special.ts`
(the package root level), NOT in `packages/bigfloat/src/special-funcs/gamma.ts`.
ADR-0040 §Decision 2 mandates `bigfloat/src/special-funcs/<head>.ts` as the
per-head landing site. Erf is at `bigfloat/src/special-funcs/erf.ts`; Bessel
is at `bigfloat/src/special-funcs/besselj.ts` etc. The Gamma substrate predates
this convention and was not migrated.

---

### AXIS 4 — Arb-prec complex (`bigfloat/src/complex.ts` gamma sections)

| Function | Status | Quality | Gaps |
|----------|--------|---------|------|
| `clgamma(z, prec)` complex | SHIPS at `complex.ts:388` | Good, near-pole excellent | Terse Stirling/shifted docs |
| `cgamma(z, prec)` complex | SHIPS at `complex.ts:637` | Good | — |
| `cdigamma(z, prec)` complex | SHIPS at `complex.ts:649` | Good, reflection excellent | — |
| `ctrigamma(z, prec)` complex | **MISSING** | — | Entire function |
| `cpolygamma(m, z, prec)` m≥2 complex | **MISSING** | — | Entire function |
| `cbeta(a,b, prec)` complex Beta | **MISSING** | — | Entire function |
| `clogBeta(a,b, prec)` | **MISSING** | — | Entire function |
| `clowerIncompleteGamma(a,z, prec)` | **MISSING** | — | Entire function |
| `cupperIncompleteGamma(a,z, prec)` | **MISSING** | — | Entire function |
| `cbarnesG(z, prec)` | **MISSING** | — | Entire function |

**ADR-0040 §Decision 2 compliance:** ADR-0040 says complex extensions belong in `complex.ts`. This is already satisfied for the shipped functions. New complex functions (ctrigamma, cpolygamma, cbeta, etc.) should be added in-place in `complex.ts`.

---

### AXIS 5 — Float64 (`quadrature/src/special-funcs/<head>-float64.ts` + ADMITTED_HEADS)

| Item | Status |
|------|--------|
| `gamma-float64.ts` exists | **NO** |
| Gamma family in `ADMITTED_HEADS` | **NO** |
| Gamma family in `SPECIAL_DISPATCH` | **NO** |
| Gamma family in `SPECIAL_HEADS` | **NO** |

**What should be here:**
- `lgammaFloat64`: SunPro 1993 / glibc `__ieee754_lgamma_r` verbatim port. Industry standard; ≤ 1 ULP.
- `gammaFloat64`: glibc `tgamma` or FreeBSD/musl `tgamma` verbatim port. The algorithm is based on a rational approximant over intervals (Lanczos or piecewise Chebyshev). R3 research will identify the canonical port.
- `digammaFloat64`: Cephes `psi.c` is the most widely-deployed (SciPy uses it). Port verbatim.
- `trigammaFloat64`: Cephes trigamma or Boost `trigamma.hpp` rational approximant.
- `polygammaFloat64(m, x)`: Cephes `psi.c` generalized to m-th derivative; or Boost `polygamma`.
- `lgammaComplexFloat64(re, im)`: No obvious verbatim-port candidate (no open-source "SunPro" for complex lgamma). R3 research needed. Options: Stirling series directly in float64 (standard approach); or Lanczos-family rational approximant.

**LOC estimate:** Analogous to `erf-float64.ts` (1101 LOC) and `bessel-float64.ts` (1863 LOC). A `gamma-float64.ts` targeting lgamma/gamma/digamma/trigamma/polygamma real + lgamma/gamma complex would be ~800-1200 LOC.

---

### AXIS 6 — Meijer-G bridge (`meijer-core/src/bridges/<head>.ts`)

| Item | Status |
|------|--------|
| `bridges/gamma.ts` exists | **NO** |
| Gamma as OUTPUT in dispatch rules | YES (~4 sites in `bateman-5-6.ts`) |
| Forward bridge `headToMeijerG("Gamma", args)` | **MISSING** |
| Backward bridge `meijerGToHead(form)` for Gamma G-form | **MISSING** |

**What the forward bridge would look like:**
The simplest Gamma G-form is `Γ(z) = G^{1,0}_{0,1}({} | {z-1} | 1)` (DLMF
§16.2.2 or Bateman §5.6(1)). The `z-1` parameter shift is the `argsInverse`
closure's job: record `origArgs = [z]`, emit `bm = [z-1]`, `zSlot = 1`.

More practically useful are the Beta and Pochhammer bridges:
- `B(a,b) = Γ(a)·Γ(b)/Γ(a+b)` — this can be expressed as a 2×2 G-function (DLMF §16.2.2).
- `(a)_n = Γ(a+n)/Γ(a)` — ratio of Gamma evaluated at shifted points.

The `argsInverse` closure pattern from `types.ts` generalises directly.

---

### AXIS 7 — Wire surface (`tools/special-eval/tool.ts`)

| Item | Status |
|------|--------|
| Gamma family in `ADMITTED_HEADS` (tool) | **NO** |
| Gamma dispatch in `dispatchReal` / `dispatchRealBessel` | **NO** |
| Gamma dispatch in `dispatchComplex` | **NO** |
| Golden tests for Gamma in tool goldens | **NO** |

This axis is fully blocked on Axis 5 (float64 module) and Axis 3 (arb-prec completeness for missing m≥2 polygamma). Once those ship, extending `tool.ts` is a small additive edit (the Bessel extension took ~150 LOC of new dispatch code + 24 new goldens).

---

## §3 — Heads inventory

### Currently shipped (confirmed):

| Head | Real arb-prec | Complex arb-prec | Float64 | Symbolic diff | Identity rules | Wire tool |
|------|--------------|-----------------|---------|--------------|----------------|-----------|
| `Gamma` | YES (special.ts) | YES (complex.ts) | NO | YES | 0 | NO |
| `Digamma` (= LogGamma ψ) | YES (special.ts) | YES (complex.ts) | NO | YES | 0 | NO |
| `Trigamma` | YES (special.ts) | NO | NO | via Polygamma | 0 | NO |
| `Polygamma(m, z)` m=0,1 | YES (special.ts) | NO | NO | YES | 0 | NO |
| `LogGamma` (lgamma) | YES (special.ts) | YES (complex.ts) | NO | — (not in vocab) | 0 | NO |

Note: `LogGamma` is implemented (`lgamma`, `clgamma`) but is NOT in
`SPECIAL_FUNCTION_HEADS` (not in the vocabulary table at `special-functions.ts:135-180`).
Only `Gamma`, `Digamma`, `Polygamma` are in the vocabulary. `LogGamma` as a first-class
head (distinct from `log(Gamma(z))`) would need a vocabulary amendment.

### Missing — high priority for Gamma epic v0.1:

| Head | Notes |
|------|-------|
| `LogGamma` (as vocabulary head) | ADR-0023 amendment needed; `lgamma` implementation exists |
| `Polygamma(m, z)` m≥2 | Hurwitz-zeta route; real + complex both missing |
| `Trigamma` complex (`ctrigamma`) | Missing |
| `RecipGamma` (1/Γ(z)) | Entire function; avoids pole issues; useful for series |

### Missing — medium priority (v0.1 or v0.2):

| Head | Notes |
|------|-------|
| `Pochhammer(a, n)` = (a)_n | Rising factorial; vocabulary amendment needed |
| `Beta(a, b)` | B(a,b) = Γ(a)Γ(b)/Γ(a+b); vocabulary amendment needed |
| `LogBeta(a, b)` | log B(a,b); more numerically stable for large args |
| `IncompleteGamma(a, z)` upper | DLMF §8.2.2; vocabulary amendment needed |
| `IncompleteGamma(a, z)` lower | DLMF §8.2.1; or separate head `LowerIncompleteGamma` |
| `RegularizedGammaP(a, z)` | P(a,z) = γ(a,z)/Γ(a); DLMF §8.2.4 |
| `RegularizedGammaQ(a, z)` | Q(a,z) = Γ(a,z)/Γ(a); DLMF §8.2.4 |
| `InverseRegularizedGammaP` | Newton root of P(a,z) = y; DLMF §8.17 |
| `IncompleteBeta(x, a, b)` | B(x; a,b); DLMF §8.17 |

### Missing — low priority (v0.2+):

| Head | Notes |
|------|-------|
| `BarnesG(z)` | Super-zeta function; DLMF §5.17 |
| `Hyperfactorial(n)` | H(n) = prod_{k=1}^{n} k^k |
| Complex versions of all missing heads | Follows real implementation |

---

## §4 — Quality audit per existing module

### `special.ts` quality scorecard

| Criterion | Erf bar | Bessel bar | special.ts score |
|-----------|---------|------------|-----------------|
| Algorithm narrative lines (top of file) | 225 (erf.ts) | 154 (besselj.ts) | 36 |
| Primary algorithm citations | DLMF §7.6.2 etc. | DLMF §10.2 etc. | NONE |
| Per-function doc comment quality | Full literate | Full literate | 2/8 functions excellent; 4/8 terse; 2/8 none |
| Cancellation-retry wired | YES (every sub-path) | YES | Partial (lgammaRealAbs only) |
| Mutation-proof tests | 23 documented | 47 documented | 1 documented |
| Oracle cross-validation | `bench/erf-anchor/` full | `bench/besselj-anchor/` full | NONE |
| File location | `special-funcs/erf.ts` | `special-funcs/besselj.ts` | `special.ts` (root level) |
| Direct-path discipline | Explicit in docs | Explicit in docs | Not documented |

### `complex.ts` gamma section quality scorecard

| Criterion | Bar | complex.ts score |
|-----------|-----|-----------------|
| `clgammaReflect` doc comment | High quality | Excellent (35 lines, full oj5j analysis) |
| `clgammaStirling` doc comment | Literate | Very terse (3 lines) |
| `cgamma` doc comment | Literate | 2 lines |
| `cdigammaReflect` doc comment | High quality | Good (19 lines) |
| Algorithm citations | DLMF §7.6 etc | None |
| ctrigamma / cpolygamma | Would be present | Missing entirely |
| Oracle cross-validation (complex) | Full arb-prec suite | 4 basic tests only |

### `cas-core/src/special-functions.ts` gamma section quality scorecard

| Criterion | Bar | Score |
|-----------|-----|-------|
| Diff rules DLMF-cited | YES | YES (§5.4.2, §5.7.1, §5.15.3) |
| Chain-rule correctness | Tested | Tested |
| Discrete-order refusal | Correct | Correct |
| Test coverage | Full | 5 tests — adequate for shipped subset |

---

## §5 — Uplift estimate per gap

### Small (< 50 LOC, < 1 day wall-time)

- **S1:** Fix `digamma` negative-argument path (`special.ts:340`) — add `cos` function, implement `cot(πz)` via `cos/sin`, remove the `throw`. The `clgammaReflect`/`cdigammaReflect` pattern already shows exactly what to do. **v0.1 must-fix.**
- **S2:** Add `applyGammaRewrites` skeleton in `simplify.ts` (the function body fires when `gamma-identities.ts` lands). 20-30 LOC.
- **S3:** Add algorithm citations (DLMF section numbers) to `lgammaStirling`, `digammaStirling`, `trigammaStirling` doc comments. 15 LOC edits.
- **S4:** Wire mutation-proof documentation to the 3 Stirling functions. Add test comments to `special.test.ts`.
- **S5:** Extend `special.test.ts` to cover `digamma` at negative non-integers (once S1 ships).

### Medium (50-200 LOC, 1-2 days)

- **M1:** Add `ctrigamma(z, prec)` and `cpolygamma(m, z, prec)` (m=0,1) to `complex.ts`. ~80-100 LOC. The real `trigamma` recurrence + Stirling generalises to complex identically to how `digamma`'s recurrence + Stirling generalised.
- **M2:** Implement `polygamma(m≥2, z, prec)` via Hurwitz zeta series. Needs `hurwitzZeta(s, z, prec)` as a prerequisite. ~120-150 LOC for the full polygamma + hurwitz-zeta substrate.
- **M3:** Write `cas-core/src/special-funcs/gamma-identities.ts` v0.1 subset (Priority A + B, ~18 rules). ~450-600 LOC.
- **M4:** Relocate `special.ts` → `special-funcs/gamma.ts` with a re-export shim at `special.ts` for backward compatibility. ~30 LOC move + 10 LOC shim.

### Large (200+ LOC, 2-5 days + research)

- **L1:** Write `quadrature/src/special-funcs/gamma-float64.ts`. Requires R3 research to identify verbatim-port candidates for each function. Estimated 800-1200 LOC. **Blocked on R3 research bead.**
- **L2:** Write `meijer-core/src/bridges/gamma.ts`. Requires R4 research for canonical G-forms. Estimated 300-500 LOC.
- **L3:** Phase 1 oracle harness (`bench/gamma-anchor/` corpus + 5 oracle adapters + cross-agreement). Estimated 3-5 days including adapter tuning.
- **L4:** New vocabulary heads (IncompleteGamma, Beta, Pochhammer, BarnesG) in ADR-0023 amendment + full per-head substrate. Each head is a separate epic-scale item comparable to the Erf or Bessel epics.

### v0.1 must-fix vs v0.2 nice-to-have

**Must-fix for v0.1 "world's best Gamma" claim:**
- S1 (digamma negative args), M1 (ctrigamma/cpolygamma), M3 (gamma-identities.ts v0.1 subset), M4 (file relocation to special-funcs/), L1 (gamma-float64.ts), L2 (bridges/gamma.ts), L3 (oracle harness).

**v0.2 nice-to-have:**
- M2 (polygamma m≥2 via Hurwitz zeta), L4 (new vocabulary heads), S2-S5 (quality improvements that don't block the v0.1 claim).

---

## §6 — Compatibility risks

### 6.1 Tests that touch the Gamma family

| Test file | Tests | Risk level |
|-----------|-------|-----------|
| `packages/bigfloat/test/special.test.ts` | 32 | Medium — Stirling golden strings will catch any precision regression |
| `packages/bigfloat/test/complex.test.ts` | ~10 gamma-related | Medium — near-pole tests are mutation-proof |
| `packages/cas-core/test/special-functions.test.ts` | 5 + vocabulary tests | Low — diff rules only |
| `packages/cas-core/test/diff.test.ts` | indirect (line 775) | Low |
| All meijer-core tests | indirect via cgamma | HIGH — every Slater residue test uses cgamma |

**Meijer-G tests that depend on `cgamma`:** Any test file in
`packages/meijer-core/test/` that exercises the Slater series path
uses `cgamma` indirectly. These are the highest-risk tests to watch
when making any change to `complex.ts`'s gamma sections.

### 6.2 Downstream consumers — API surface

| Consumer | API used | Break risk |
|----------|---------|-----------|
| `meijer-core/src/series.ts` (12 sites) | `cgamma(z, prec)` | HIGH if signature changes |
| `meijer-core/src/contour.ts` | `cgamma` | HIGH |
| `meijer-core/src/coalescence.ts` | `digamma`, `polygamma` (future) | MEDIUM (future dependency) |
| `bateman-5-6.ts` (4 sites) | `expr("Gamma", [z])` AST nodes | HIGH if `"Gamma"` removed from vocab |
| `tools/special-eval/tool.ts` | `lgamma`, `clgamma` from bigfloat | LOW (currently used indirectly) |
| Any downstream importing `@workbench/bigfloat` | `gamma`, `lgamma`, `digamma`, `trigamma`, `polygamma`, `cgamma`, `clgamma`, `cdigamma` | MEDIUM — all are exported via `index.ts` |

### 6.3 Meijer-G dispatch rules that use Gamma

Every rule in `bateman-5-6.ts` that emits `expr("Gamma", [z])` outputs:
- **Line 409:** `gamma(mkMinus(I(1), a!))` — a Gamma-prefactor in a Bessel-type rule
- **Line 429:** `mkTimes(gamma(mkPlus([I(1), b!])), powZ(z, b!))` — Gamma · z^b prefactor
- **Line 450:** `gamma(mkPlus([I(1), mkMinus(b!, a!)]))` — a ratio-like Gamma factor

If the `"Gamma"` head were renamed, these outputs would silently produce
un-evaluable AST that downstream tools (like `tools/meijer-g-symbolic-only`)
would pass through as foreign nodes rather than throwing. The risk is silent
semantic breakage, not immediate errors.

### 6.4 Goldens that depend on Gamma output

The `bench/erf-anchor/` and `bench/besselj-anchor/` golden corpora do NOT
depend on Gamma directly — they verify Erf and Bessel values. However:
- `bench/besselj-anchor/oracles/` frozen results include Bessel values computed
  via AMOS rotation (`J = exp(νπi/2) · I(-iz)`), which internally uses `cgamma`.
  A `cgamma` precision regression would manifest as a test failure in `bench/besselj-anchor/cross-agreement.ts`.
- Any Meijer-G evaluation golden (in `packages/meijer-core/test/`) depends on
  `cgamma` being correct.

---

## §7 — Bead-able task list, ordered by dependency

All tasks are claimable independently except where noted. LOC estimates are conservative.

### Round 0 (Research — parallel, no code prereqs)

| Task | Type | LOC | Dependency |
|------|------|-----|-----------|
| R1-Gamma: symbolic identities research | New research | 800-1200 (markdown) | None |
| R2-Gamma: arb-prec algorithms research | New research | 1000-1500 (markdown) | None |
| R3-Gamma: float64 algorithms research | New research | 800-1200 (markdown) | None |
| R4-Gamma: Meijer-G bridge research | New research | 600-900 (markdown) | None |
| R5-Gamma: oracle landscape | Verify-existing | 200-400 (markdown) | None |
| A0: ADR for Gamma epic | New ADR | 600-900 (markdown) | Blocks Phase 1 |

### Round 1 (Phase 1 — oracle harness, parallel)

| Task | Type | LOC | Dependency |
|------|------|-----|-----------|
| G1: Corpus design + generate-corpus.ts | New | 200-300 | A0 |
| G2-G6: Oracle adapters (Wolfram, mpmath, SciPy, Boost, Arb) | New | 150-250 each | G1 |
| G7: Cross-oracle agreement matrix | New | 200-300 | G2-G6 |

### Round 2 (Phase 2 — substrate, some parallel)

| Task | Type | LOC | Dependency |
|------|------|-----|-----------|
| I0: Fix digamma negative-arg (`special.ts:340`) | Uplift-existing | 30-50 | None |
| I0a: Add algorithm citations to Stirling functions | Uplift-existing | 15-25 | None |
| I1: Relocate `special.ts` → `special-funcs/gamma.ts` + shim | Uplift-existing | 30-50 | None (but breaks imports) |
| I2: Add `ctrigamma`, `cpolygamma` m=0,1 to `complex.ts` | Add-new | 80-100 | I1 (preferred, not required) |
| I3: Implement `polygamma(m≥2)` via Hurwitz zeta (real) | Add-new | 120-150 | I0, R2 |
| I4: Write `gamma-identities.ts` + `applyGammaRewrites` | Add-new | 500-700 + 300-400 test | R1 |
| I5: Write `gamma-float64.ts` + `eval-numeric-expr.ts` extension | Add-new | 800-1200 | R3, G7 |
| I6: Write `bridges/gamma.ts` | Add-new | 300-500 | R4, A0 |
| I6a: Vocabulary amendment (LogGamma, Pochhammer if v0.1) | Uplift-existing | 30-50 | A0 |

### Round 3 (Phase 3 — tool integration, parallel after I4/I5)

| Task | Type | LOC | Dependency |
|------|------|-----|-----------|
| T1: `integrate-1d` learns Gamma family | Verify-existing / small add | 50-100 | I5 |
| T2: `tools/special-eval` extension for Gamma | Add-new | 150-200 + 20+ goldens | I5, I3 |
| T3: Meijer-G closure validation (existing gamma-emitting rules round-trip) | Verify-existing | 100-150 test | I6 |

### Round 4 (Phase 4 — verification + docs)

| Task | Type | LOC | Dependency |
|------|------|-----|-----------|
| V1: Cross-cutting integration tests | New test file | 200-300 | All of Phase 2/3 |
| D1: Docs lockstep + epic close worklog | New doc | 300-400 | V1 |

---

## §8 — Architecture recommendations

### 8.1 Should `special.ts` move to `special-funcs/gamma.ts`?

**Recommendation: YES** — relocate in a dedicated bead (I1 above). Rationale:

ADR-0040 §Decision 2 pins `bigfloat/src/special-funcs/<head>.ts` as the
per-head landing site. The Erf pattern (`special-funcs/erf.ts`) and Bessel
pattern (`special-funcs/besselj.ts`, `bessely.ts`, `besseli.ts`, `besselk.ts`)
establish the expectation. A reader looking for "where is the arb-prec Gamma
implementation?" will look in `special-funcs/`, not at the package root.

The move is mechanical: rename file, update the one import in `index.ts`.
No algorithm changes. The bead is a pure reorganisation. The backward-compat
shim at the old path (exporting the same 5 functions) keeps any code that
imports from `./special.js` directly working.

### 8.2 Should `clgamma/cgamma/cdigamma` stay in `complex.ts`?

**Recommendation: YES** — keep in `complex.ts` as ADR-0040 §Decision 2 says.

ADR-0040 §Decision 2: "extension to `src/complex.ts` (complex on BigComplex)."
The Erf complex functions (`bigW`, `bigCErf`, etc.) were added to `complex.ts`
(lines 28-31 of the module header). Bessel complex functions (`bigCBesselI`,
`bigCBesselK`, `bigCBesselJ`, etc.) were added to `complex.ts` (lines 29-51).
Gamma's complex functions (`clgamma`, `cgamma`, `cdigamma`) already follow this
pattern.

New complex Gamma functions (`ctrigamma`, `cpolygamma`, `cbeta`, etc.) go in the
same place.

### 8.3 Should `polygamma(m≥2)` extend existing `polygamma()` or introduce `bigPolygammaM`?

**Recommendation: Extend existing `polygamma()`** — the current API is
`polygamma(m: number, z: BigFloat, prec: number): BigFloat`, and the
existing m=0 and m=1 fast-path dispatch is correct. The throw for m≥2
should simply be replaced with a call to the new `polygammaHighOrder(m, z, prec)`
internal function implementing the Hurwitz-zeta route. No new exported
function is needed.

The clean API is:
```ts
// Internal, but could be exported for testing:
function hurwitzZeta(s: BigFloat, a: BigFloat, prec: number): BigFloat
function polygammaHighOrder(m: number, z: BigFloat, prec: number): BigFloat

// Existing exported surface, extended:
export function polygamma(m: number, z: BigFloat, prec: number): BigFloat
// → dispatches m=0 to digamma, m=1 to trigamma, m≥2 to polygammaHighOrder
```

### 8.4 File-level structure proposal for new heads

For v0.1 of the Gamma epic, new functions go in existing files:
```
packages/bigfloat/src/special-funcs/gamma.ts   ← RENAME from special.ts; add new real functions
packages/bigfloat/src/complex.ts               ← extend with ctrigamma, cpolygamma, cbeta, etc.
packages/cas-core/src/special-funcs/gamma-identities.ts  ← NEW
packages/quadrature/src/special-funcs/gamma-float64.ts  ← NEW
packages/meijer-core/src/bridges/gamma.ts      ← NEW
```

For v0.2 (new vocabulary heads like IncompleteGamma, Beta):
```
packages/bigfloat/src/special-funcs/incomplete-gamma.ts  ← NEW
packages/bigfloat/src/special-funcs/beta.ts              ← NEW
packages/bigfloat/src/special-funcs/barnes-g.ts          ← NEW
packages/cas-core/src/special-funcs/incomplete-gamma-identities.ts  ← NEW
packages/cas-core/src/special-funcs/beta-identities.ts   ← NEW
packages/quadrature/src/special-funcs/incomplete-gamma-float64.ts  ← NEW
packages/quadrature/src/special-funcs/beta-float64.ts    ← NEW
```

Each new head follows the full 7-axis pattern of ADR-0040/ADR-0041.
The Beta function is the natural next head after Gamma because (a) it
is expressible entirely in terms of Gamma via `B(a,b) = Γ(a)Γ(b)/Γ(a+b)`,
(b) it has a natural Meijer-G form (DLMF §16.2.2), and (c) it is the
denominator in the regularized incomplete beta function which appears in
probability distributions the workbench's integrate-1d tool encounters.

---

## Appendix A — File paths and line numbers

All line numbers verified against the current HEAD of `main` (commit 56b4085).

| File | Key lines |
|------|-----------|
| `packages/bigfloat/src/special.ts` | Algorithm narrative: 1-36; `lgamma`: 72; `lgammaStirling`: 117; `lgammaRealAbs`: 163-236; `zMagBits`: 243; `gamma`: 271; `digamma`: 313; digamma-negative-throw: 340; `digammaStirling`: 364; `trigamma`: 405; `trigammaStirling`: 431; `polygamma`: 465; polygamma-m≥2-throw: 472 |
| `packages/bigfloat/src/complex.ts` | Module header: 1-96; Gamma narrative: 10-18; `clgamma`: 388; `clgammaShifted`: 406; `clgammaStirling`: 437; `magBits`: 480; Bernoulli helpers: 491-509; `clgammaReflect`: 511-631; `cgamma`: 637; `cdigamma`: 649; `cdigammaShifted`: 660; `cdigammaStirling`: 686; `cdigammaReflect`: 741 |
| `packages/cas-core/src/special-functions.ts` | SPECIAL_FUNCTION_HEADS Gamma: 136-138; ARITY_TABLE Gamma: 238-240; ruleGamma: 427; ruleDigamma: 443; rulePolygamma: 456 |
| `packages/cas-core/src/simplify.ts` | Gamma extension point comment: 253; applyBesselRewrites: 265; pipeline: 98-99 |
| `packages/quadrature/src/eval-numeric-expr.ts` | SPECIAL_HEADS (no Gamma): 107-123; SPECIAL_DISPATCH (no Gamma): 136-207 |
| `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` | gamma() builder: 83-85; rule outputs using gamma: 409, 429, 450; IncompleteGamma future note: 678-679 |
| `packages/meijer-core/src/bridges/` | gamma.ts: MISSING |
| `packages/meijer-core/src/series.ts` | cgamma imports: 48; usage: 144, 147, 153, 156, 229, 232, 238, 241 |
| `packages/meijer-core/src/coalescence.ts` | digamma/polygamma future note: 23, 105 |
| `packages/bigfloat/test/special.test.ts` | Mutation-proof comment: 158; near-pole tests: 138-229 |
| `packages/bigfloat/test/complex.test.ts` | Mutation-proof comment: 315; cgamma tests: 250-280; cdigamma tests: 282-296; oj5j tests: 298-394 |
| `tools/special-eval/tool.ts` | ADMITTED_HEADS (no Gamma): 261-275; golden string citing admitted heads: 1230 |

---

*End of A1 — Gamma Family Codebase Audit*
