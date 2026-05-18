# ADR-0042 — Per-head substrate applied to the canonical Gamma family

**Status:** Proposed — 2026-05-18
**Beads:** `scientist-workbench-xqc7` (epic — World-class Gamma-family reference
implementation, the third per-head substrate epic in the series Erf → Bessel →
Gamma). Phase 0 research children: `1gir` (R1 symbolic identities), `vf19` (R2
arb-prec algorithms), `ldsf` (R3 float64 algorithms), `o8yk` (R4 Meijer-G
bridge), `hgt3` (R5 oracle landscape), `t4bc` (A1 codebase audit). This ADR is
the Phase 0 gate; Phase 1 through Phase 4 sub-beads are filed and blocked on
this ADR.
**Related:** **ADR-0040** (per-head substrate prototype #1 — Erf; pattern
pinned), **ADR-0041** (prototype #2 — Bessel; 2-arg extension validated),
ADR-0023 (closed special-function vocabulary; this ADR amends with 6 new
heads), ADR-0025 (Meijer-G symbolic dispatch pattern-rule design), ADR-0027
(Meijer-G dispatcher umbrella), ADR-0020 (`arbprec: true` determinism contract),
ADR-0015 (`numerical: true` determinism contract), ADR-0011 (typed flags;
`--precision` is a standard flag), ADR-0007 (per-output determinism-tier
precedent), ADR-0014 (first numerical tier — substrate-package pattern).
Bead `d6s` (per-head arbprec evaluator) and bead `gp75` (runtime mutex
amendment) inherited from the Erf epic remain the relevant cross-tier
touchpoints.

---

## Context

ADR-0040 pinned the per-head special-function substrate using Erf as the v0.1
instantiation: a six-axis architecture (symbolic identities in `cas-core`; diff
rules in `cas-core`; arb-prec real in `bigfloat`; arb-prec complex in
`bigfloat/complex.ts`; float64 real+complex in `quadrature`; bidirectional
Meijer-G bridge in `meijer-core`) plus a single wire surface (`tools/special-eval`)
dispatching behind `--head=<name>` + `--precision=<int>`. ADR-0041 applied the
pattern to the Bessel family and validated that the architecture generalises to
multi-argument heads (ν + z) without structural change — only the bridge API
needed a mechanical rename (`zInverse` → `argsInverse`).

The Gamma family is the third instantiation. It is the most deeply embedded
special function in the workbench: `meijer-core/src/series.ts` holds ~12
`cgamma` call sites per Slater residue evaluation; `bateman-5-6.ts` emits
`Gamma(...)` AST nodes in four rules; `coalescence.ts` anticipates
`digamma`/`polygamma` for higher-order residue work. Against the Erf/Bessel bar,
**five of seven axes are missing entirely**, and the two axes that ship
(`bigfloat` arb-prec real for Gamma/Digamma/Trigamma/Polygamma; `cas-core` diff
rules for Gamma/Digamma/Polygamma) have significant quality gaps compared to the
bar set by `erf.ts` and `besselj.ts`. The Gamma family epic is primarily
*additive* work — the existing substrate is correct in its covered scope — with
three targeted lifts (digamma/trigamma negative-argument reflection, polygamma
m≥2 via Hurwitz zeta) plus wholly new heads.

### Phase 0 research findings (load-bearing for the decisions)

Five Opus deep-research subagents produced 7164 lines of literature-cited
material at `docs/refs/gamma-research/` plus a 951-line codebase audit.

* **R1** (symbolic, `docs/refs/gamma-research/R1-symbolic-identities.md`,
  ~1100 lines, 38 rules): vocabulary admission for 6 new heads (LogGamma,
  Pochhammer, IncompleteGammaUpper, IncompleteGammaLower, Beta, BarnesG) per the
  Erfi-precedent test from ADR-0040 §Decision 6 / ADR-0041 §Decision 6. Rules in
  five priority classes: A (special values + pole-refusal; 14 rules), B
  (half-integer closures; 6 rules), C (recurrences + reflection; 13 rules), D
  (asymptotic + multiplication; 5 rules). **R1 explicitly defers** IncompleteGammaP
  and IncompleteGammaQ as symbolically derivable (P = γ/Γ, Q = Γ_upper/Γ) —
  the reduction is `IncompleteGammaLower/Gamma` and `IncompleteGammaUpper/Gamma`
  respectively. R1 also defers ReciprocalGamma, IncompleteBeta, BetaRegularized,
  Hyperfactorial; rejects InverseGammaRegularized (no closed form, root-finding
  only). Source priority DLMF > SymPy > mpmath; every identity triangulated by
  primary DLMF citation + mpmath/SymPy numerical verification.

* **R2** (arb-prec, `docs/refs/gamma-research/R2-arbprec-algorithms.md`,
  ~1900 lines): comprehensive audit of existing substrate (`special.ts` 474 LOC;
  complex.ts gamma sections lines 388–836) against the Erf/Bessel bar. **5 of 7
  axis gaps confirmed.** Load-bearing algorithmic findings: (a) Stirling is the
  correct arb-prec algorithm for lgamma at all precision levels — Lanczos and
  Spouge require offline coefficient generation and are suited to fixed
  precision (float64/128-bit) only; (b) the recommended shift threshold
  `shiftThreshold = max(8, ceil(0.17·prec))` (FLINT's `choose_small`) is
  slightly tighter than the current `prec/8` — a performance lift not a
  correctness fix; (c) the digamma negative-argument gap (throws at
  `special.ts:340`) is unblocked by importing `cos` from `transcendental.ts` and
  mirroring the `cdigammaReflect` pattern; (d) polygamma m≥2 uses the Hurwitz
  zeta route `ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z)` (DLMF §5.15.2)
  combined with recurrence shift; (e) incomplete gamma upper/lower algorithms
  span four regimes (series for small z, continued fraction for large z, Temme
  uniform asymptotic for |z-a| ≤ C·√a, Poincaré asymptotic for |z|→∞); (f) Beta
  is log-lgamma-subtraction with sign tracking; (g) BarnesG uses DLMF §5.17.5
  asymptotic + Glaisher's constant.

* **R3** (float64, `docs/refs/gamma-research/R3-float64-algorithms.md`,
  ~1919 lines): verbatim-port table per head citing exact source files. Primary
  sources: Cephes `gamma.c` / `igam.c` / `igami.c` / `incbet.c` for
  tgamma/lgamma/incomplete-gamma/incomplete-beta; FreeBSD `e_lgamma_r.c` (SunPro
  1993 lineage, byte-identical across glibc/musl/FreeBSD, same provenance as the
  Erf and Bessel float64 substrates) for lgamma; Boost `digamma.hpp` +
  `polygamma.hpp` for digamma/trigamma/polygamma real; SciPy `_loggamma.pxd` for
  complex lgamma/gamma (Stirling + reflection). R3 identifies 19 ADMITTED_HEADS
  entries spanning Gamma/LogGamma/Digamma/Trigamma/Polygamma/Pochhammer/
  IncompleteGammaUpper/IncompleteGammaLower/GammaP/GammaQ/Beta/BarnesG plus
  scaled variants (TgammaRatio, TgammaDeltaRatio, GammaPDerivative). **§0.0 pins
  the verbatim-port discipline** at the top of the artefact as non-negotiable —
  the Gamma family carries at least as many accumulated-bugfix traps as Bessel
  (sign-tracking in lgamma, CF rescaling constants in igam, Halley-seed precision
  dependence in igami, etc.).

* **R4** (Meijer-G bridge, `docs/refs/gamma-research/R4-meijer-g-bridge.md`,
  1001 lines): **KEY FINDING — a fundamental structural asymmetry from Erf and
  Bessel.** For Erf and Bessel, the function is a *value* the Meijer-G produces.
  For the Gamma family, Γ plays a double role: (1) it is itself a named head
  with arguments; (2) it is the *building block* of the Meijer-G integral — the
  Mellin-Barnes definition is literally a contour integral of Γ-product quotients.
  This asymmetry has one decisive consequence: **`Gamma(z)` as a function of its
  argument z has NO Meijer-G form**. The reason is structural: Γ's defining
  integral `∫₀^∞ t^{z-1} e^{-t} dt` has z in the exponent of the integrand
  (`t^{z-1}`). For z to appear only in the G-function's z-slot (the standard
  bridge model), the parameters (an, ap, bm, bq) must be fixed constants. But
  encoding z in `bm = [z-1]` would require z to appear in a parameter slot —
  which is not the G-function framework's design. Cross-validation: SymPy has no
  `_eval_rewrite_as_meijerg` for `gamma`; mpmath evaluates Gamma via
  Stirling/Lanczos, never via `meijerg`. **Only IncompleteGammaUpper and
  IncompleteGammaLower have canonical G-forms** (shapes (2,0,1,2) and (1,1,1,2)
  respectively; Wikipedia Meijer-G §"Representation of other functions",
  cross-confirmed by DLMF §8.6.10-11). All other Gamma-family heads (Beta,
  BarnesG, Pochhammer, Digamma, Polygamma) are honest refusals. **Critical
  disambiguation**: UpperIncompleteGamma's (2,0,1,2) shape is shared with Erfc
  and ExpIntegralE; the backward bridge must check bm slots precisely (ap
  discriminates E_n≠1 from UpperIncompleteGamma; bm = [0,1/2] → Erfc;
  bm = [0,0] → ExpIntegralE(1,z); bm = [a, 0] with a neither 1/2 nor 0 →
  UpperIncompleteGamma). R4 also identifies the vocabulary gap blocker: neither
  `IncompleteGammaUpper` nor `IncompleteGammaLower` are in ADR-0023 today.

* **R5** (oracle landscape, `docs/refs/gamma-research/R5-oracle-landscape.md`,
  1293 lines): capability matrix over 16 gamma-family heads × {real, complex}
  × 5 oracles. Gold: Wolfram Mathematica 14.3 (all heads) + mpmath 1.3.0 (all
  heads). Silver: Boost.Math 1.83 `cpp_bin_float<50>` (real only; **HEADERS NOT
  INSTALLED** — requires `sudo apt install libboost-math-dev`). Bronze: SciPy
  1.11.4 (most real heads; complex polygamma fails TypeError in 1.11.4 — L14)
  + libm (tgamma + lgamma real only). python-flint/Arb: **NOT installed** —
  requires `sudo apt install libflint-dev && pip install --user
  --break-system-packages python-flint`. **17 landmines pinned** (L1-L17);
  the #1 trap is L12: the incomplete-gamma P/Q convention inversion — SciPy's
  `gammainc` returns P (lower regularised) where Wolfram/mpmath `Gamma[a,z]`
  returns the upper unregularised; adapters must tag every call with `// L12`.

* **A1** (codebase audit, `docs/refs/gamma-research/A1-codebase-audit.md`,
  951 lines): confirms 5 of 7 axes absent; existing substrate is correct in
  covered scope but 6–7× below the algorithm-narrative bar set by `erf.ts` and
  `besselj.ts`; 1 documented mutation-proof marker vs 23 (Erf) and 47 (Bessel);
  no `bench/gamma-anchor/` directory exists. **ADR-0040 file-location violation
  confirmed**: `special.ts` lives at `packages/bigfloat/src/special.ts` (root
  level), NOT in the mandated `packages/bigfloat/src/special-funcs/gamma.ts`.
  `meijer-core/src/series.ts` holds ~12 `cgamma` call sites — any signature
  change or file relocation that breaks the import chain would break every
  Meijer-G evaluation that uses the Slater path.

---

## Decision

We pin the per-head substrate for the Gamma family under the architecture
ADR-0040 established, with one structural extension (the Γ-has-no-G-form
asymmetry documented in Decision 5), one compatibility exemption (the
file-location ruling in Decision 12), and one convention resolution
(P/Q as float64 dispatcher entries only, not vocab heads, in Decision 4).

### Decision 1 — Substrate layering (inherited from ADR-0040)

| Axis | Package | Per-head landing | Determinism tier |
|---|---|---|---|
| Symbolic identities | `@workbench/cas-core` | `src/special-funcs/gamma-identities.ts` | symbolic |
| Diff rules | `@workbench/cas-core` | `src/special-functions.ts` (extend for 6 new heads) | symbolic |
| Arb-prec real | `@workbench/bigfloat` | existing `src/special.ts` (exemption per Decision 12) + new heads in `src/special-funcs/` | `arbprec: true` (ADR-0020) |
| Arb-prec complex | `@workbench/bigfloat` | `src/complex.ts` (per ADR-0040 §Decision 2 — complex extensions in-place) | `arbprec: true` |
| Float64 real + complex | `@workbench/quadrature` | `src/special-funcs/gamma-float64.ts` + extend `src/eval-numeric-expr.ts` `applySpecial` | `numerical: true` (ADR-0015) |
| Meijer-G bridge | `@workbench/meijer-core` | `src/bridges/gamma.ts` — but bridge only covers IncompleteGammaUpper and IncompleteGammaLower; see Decision 5 | symbolic |
| Wire surface | `tools/special-eval/` | per-head dispatch table extended with Gamma family | per-tier conditional (ADR-0040 §Decision 9) |

The per-axis package boundaries are preserved exactly as ADR-0040 pinned them.
No new top-level package. The Gamma-specific modules live as sister files to the
Erf- and Bessel-specific modules already in production.

### Decision 2 — Per-head module layout

```
packages/cas-core/src/special-funcs/gamma-identities.ts          # 38 rules (R1)
packages/cas-core/src/special-functions.ts                        # extend: 6 new heads + arity + diff rules
packages/bigfloat/src/special.ts                                  # STAYS HERE (exemption; see Decision 12)
packages/bigfloat/src/special-funcs/incomplete-gamma.ts           # bigIncompleteGammaUpper / Lower (new heads)
packages/bigfloat/src/special-funcs/beta.ts                       # bigBeta / bigLogBeta (new)
packages/bigfloat/src/special-funcs/barnes-g.ts                   # bigBarnesG (new)
packages/bigfloat/src/special-funcs/pochhammer.ts                 # bigPochhammer (new)
packages/bigfloat/src/complex.ts                                  # extend: ctrigamma, cpolygamma(m≥2),
                                                                  #         cIncompleteGammaUpper/Lower, cBeta
packages/quadrature/src/special-funcs/gamma-float64.ts            # verbatim ports per R3
packages/quadrature/src/eval-numeric-expr.ts                      # extend ADMITTED_HEADS + applySpecial
packages/meijer-core/src/bridges/gamma.ts                         # forward+backward bridge (2 heads only)
tools/special-eval/                                               # per-head dispatch table extended
```

Substrate-package boundaries identical to ADR-0040 §Decision 2. Per-head
landing sub-directories (`bigfloat/src/special-funcs/`, `cas-core/src/special-funcs/`,
`meijer-core/src/bridges/`) exactly match the established convention.

### Decision 3 — Arb-prec evaluator contract (per R2)

Per-head signatures (uniform across the family):

```ts
// From packages/bigfloat/src/special.ts (existing; signature must not change)
export function lgamma(z: BigFloat, prec: number): BigFloat;      // DLMF §5.11.1 Stirling + reflection
export function gamma(z: BigFloat, prec: number): BigFloat;       // exp(lgamma) + algebraic sign
export function digamma(z: BigFloat, prec: number): BigFloat;     // Stirling + reflection (LIFT: complete z<0)
export function trigamma(z: BigFloat, prec: number): BigFloat;    // same (LIFT: complete z<0)
export function polygamma(m: number, z: BigFloat, prec: number): BigFloat; // (LIFT: m≥2 via Hurwitz zeta)

// From packages/bigfloat/src/special-funcs/incomplete-gamma.ts (new)
export function bigIncompleteGammaUpper(a: BigFloat, z: BigFloat, prec: number): BigFloat;  // DLMF §8 CF + series
export function bigIncompleteGammaLower(a: BigFloat, z: BigFloat, prec: number): BigFloat;  // DLMF §8.7.1 series
export function bigGammaP(a: BigFloat, z: BigFloat, prec: number): BigFloat;                // γ(a,z)/Γ(a)
export function bigGammaQ(a: BigFloat, z: BigFloat, prec: number): BigFloat;                // Γ(a,z)/Γ(a)

// From packages/bigfloat/src/special-funcs/beta.ts (new)
export function bigBeta(a: BigFloat, b: BigFloat, prec: number): BigFloat;      // exp(lgamma(a)+lgamma(b)-lgamma(a+b))
export function bigLogBeta(a: BigFloat, b: BigFloat, prec: number): BigFloat;   // lgamma sum + sign

// From packages/bigfloat/src/special-funcs/pochhammer.ts (new)
export function bigPochhammer(a: BigFloat, n: BigFloat, prec: number): BigFloat; // direct product or lgamma-ratio

// From packages/bigfloat/src/special-funcs/barnes-g.ts (new)
export function bigBarnesG(z: BigFloat, prec: number): BigFloat; // DLMF §5.17.5 asymptotic + recurrence

// Complex extensions in packages/bigfloat/src/complex.ts (new)
export function clgamma(z: BigComplex, prec: number): BigComplex;   // ALREADY SHIPS
export function cgamma(z: BigComplex, prec: number): BigComplex;    // ALREADY SHIPS
export function cdigamma(z: BigComplex, prec: number): BigComplex;  // ALREADY SHIPS
export function ctrigamma(z: BigComplex, prec: number): BigComplex; // NEW
export function cpolygamma(m: number, z: BigComplex, prec: number): BigComplex; // NEW (m≥2 via Hurwitz zeta)
export function cIncompleteGammaUpper(a: BigComplex, z: BigComplex, prec: number): BigComplex; // NEW
export function cIncompleteGammaLower(a: BigComplex, z: BigComplex, prec: number): BigComplex; // NEW
export function cBeta(a: BigComplex, b: BigComplex, prec: number): BigComplex;  // NEW
```

Algorithm dispatch fixed by R2 dispatch tables (§1). Crossover thresholds:

- **lgamma/gamma**: Stirling shift threshold `shiftThreshold = max(8, ceil(0.17·prec))`
  (FLINT's BETA = 0.17 at all precision levels). The current code uses `prec/8`
  (BETA = 0.125) — a performance-only gap, not a correctness gap. The lift is
  filed as P2 rather than P1.
- **digamma/trigamma negative z**: reflection `ψ(1-z) - ψ(z) = π·cot(πz)` with
  near-pole-safe reduction `ζ = z - round(z)` and `lossBits = max(0, log₂|z| -
  log₂|ζ|)`, `work = prec + 32 + lossBits`. Mirrors `cdigammaReflect` exactly.
- **polygamma m≥2**: `ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z)` via
  Euler-Maclaurin Hurwitz zeta, with recurrence shift until z+N is
  Stirling-friendly (DLMF §5.15.5 + §5.15.2).
- **IncompleteGammaUpper**: 4-regime dispatch (DLMF §8.7.3 series for small z;
  DLMF §8.9.2 CF for large z; Temme uniform asymptotic for |z-a| ≤ C·√a;
  Poincaré asymptotic for |z|→∞). Crossovers per R2 §1.7.
- **IncompleteGammaLower**: DLMF §8.7.1 series (always convergent for Re(a)>0);
  derive from Upper when Upper is well-conditioned.
- **Beta**: `exp(lgamma(a) + lgamma(b) - lgamma(a+b))` with sign tracking via
  `gamma`'s algebraic-sign path.
- **BarnesG**: DLMF §5.17.5 asymptotic with recurrence shift + Glaisher constant.
- **Pochhammer**: direct product for small integer n (crossover n ≈ 20 at
  prec=200 bits); lgamma ratio `exp(lgamma(a+n) - lgamma(a))` for large n.

Determinism: every operation is `BigInt` + bounded-integer-exponent arithmetic.
Same `(args, prec)` bytes → byte-identical `BigFloat`/`BigComplex` output
forever. Inherits `arbprec: true` contract of ADR-0020.

### Decision 4 — Float64 evaluator contract + dispatch hook (per R3)

A single new module `packages/quadrature/src/special-funcs/gamma-float64.ts`
ships verbatim ports of the R3-recommended sources. The `eval-numeric-expr.ts`
`applySpecial` dispatcher gains Gamma-family entries.

**Vocabulary vs numerical-dispatcher split (Tension Resolution A):**

R1 defers IncompleteGammaP/Q as symbolically derivable (P = γ/Γ, Q = Γ_upper/Γ).
R3 recommends including P/Q as ADMITTED_HEADS for numerical stability (Cephes
`igam.c` implements P and Q directly; the numerically stable path for P is the
series for γ, not the ratio γ/Γ). This tension is resolved following the Erfi
precedent from ADR-0040: **admit P/Q as float64 dispatcher entries only, NOT as
separate cas-core vocabulary heads**. The float64 dispatcher resolves
`IncompleteGammaP` and `IncompleteGammaQ` entries directly to Cephes igam/igamc
paths. The cas-core vocabulary remains unchanged — a CAS expression carrying P or
Q uses `IncompleteGammaLower(a,z)/Gamma(a)` or `IncompleteGammaUpper(a,z)/Gamma(a)`
symbolically.

**ADMITTED_HEADS list (float64 dispatcher, per R3):**

| Head | Real source | Accuracy | Complex | Notes |
|---|---|---|---|---|
| `Gamma` | Cephes `gamma.c` P/Q rational + Stirling | ≤ 2 ULP | SciPy `_loggamma.pxd` route | Integer table for n≤22 |
| `LogGamma` | FreeBSD `e_lgamma_r.c` (SunPro 1993) | ≤ 2 ULP | SciPy `_loggamma.pxd` | Sign tracked separately |
| `Digamma` | Boost `digamma.hpp` | ≤ 2 ULP | Stirling-shift | DLMF §5.11.2 asymptotic |
| `Trigamma` | Boost `polygamma.hpp` m=1 | ≤ 2 ULP | Stirling-shift | Reflect for z<0 |
| `Polygamma` | Boost `detail/polygamma.hpp` | ≤ 4 ULP | SciPy TypeError for cx — honest refusal L14 | m≥2 via Bernoulli |
| `Pochhammer` | Direct product or lgamma-ratio | ≤ 2 ULP | lgamma-ratio | |
| `IncompleteGammaUpper` | Cephes `igam.c` `igamc()` CF | ≤ 3 ULP | mpmath via arb (gold only) | |
| `IncompleteGammaLower` | Cephes `igam.c` `igam()` series | ≤ 3 ULP | mpmath | |
| `IncompleteGammaP` | Cephes `igam.c` `igam()` | ≤ 3 ULP | N/A | **Float64 only, not vocab head** |
| `IncompleteGammaQ` | Cephes `igam.c` `igamc()` | ≤ 3 ULP | N/A | **Float64 only, not vocab head** |
| `Beta` | `exp(lgamma(a)+lgamma(b)-lgamma(a+b))` | ≤ 4 ULP | lgamma complex | |
| `BarnesG` | Adamchik asymptotic + integer table | ≤ 4 ULP | mpmath (gold only) | |

The ADMITTED_HEADS list (19 entries) is larger than the vocab admission list
(6 new heads). This is intentional and mirrors Erf's `Erfcx` precedent: the
float64 dispatcher can serve heads that exist purely as evaluation shortcuts
without being first-class cas-core vocabulary heads. Both lists are correct; they
serve different purposes. See Decision 6 for the vocabulary list.

`numerical: true` contract: same `(input, platform_fp)` → byte-identical output.
Platform fingerprint `{arch, os, runtime}` recorded per ADR-0015.

### Decision 5 — Bidirectional Meijer-G bridge API + Gamma-family asymmetry (per R4)

The bridge API from ADR-0041 (`argsInverse: () => readonly Value[]`) requires no
further extension. The Gamma bridge uses the same `ForwardBridge` interface as
the Erf and Bessel bridges.

**The structural asymmetry: Γ is the building block of G, not a value G produces.**

For Erf and Bessel, the head is what a Meijer-G evaluation produces — the bridge
is a translator between named-head AST and G-function AST in both directions. For
the Gamma family, Γ itself is the *ingredient* of G: the Mellin-Barnes integral
definition of any G-function is `(1/2πi) ∫ [∏Γ(bⱼ-s) · ∏Γ(1-aⱼ+s)] /
[∏Γ(1-bⱼ+s) · ∏Γ(aⱼ-s)] · zˢ ds`. Γ is literally in the kernel.

This means `Gamma(z)` as a function of its argument z **has no Meijer-G form**
with fixed parameter slots. The reason: Γ's defining integral is `∫₀^∞ t^{z-1}
e^{-t} dt`, where z appears as an exponent in the integrand. Encoding this as a
G-function would require z to appear in a parameter slot (bm = [z-1]), not merely
in the G-argument slot. The G-function framework does not support this: parameters
must be constants for a given G-form, while z is the integration variable. This is
not a gap in our implementation; it is a structural property of the mathematics.

**Cross-validation:** SymPy has no `gamma._eval_rewrite_as_meijerg`. mpmath
evaluates Gamma via Stirling/Lanczos, never via `meijerg`. R4 §A.2 confirms the
impossibility with a detailed derivation.

**Bridge coverage table:**

| Head | Arity | G-form | headToMeijerG | meijerGToHead |
|---|---|---|---|---|
| `Gamma(z)` | 1 | NONE — honest structural refusal (R4 §A.2) | null | null |
| `LogGamma(z)` | 1 | NONE — honest refusal | null | null |
| `Digamma(z)` | 1 | NONE — honest refusal (R4 §A.8) | null | null |
| `Polygamma(m,z)` | 2 | NONE — honest refusal (R4 §A.8) | null | null |
| `Pochhammer(a,n)` | 2 | NONE — Γ-ratio, not a single G (R4 §A.7) | null | null |
| `Beta(a,b)` | 2 | NONE — Γ-ratio, not a single G (R4 §A.5) | null | null |
| `BarnesG(z)` | 1 | NONE — entire of order 2; no Γ-product kernel (R4 §A.6) | null | null |
| `IncompleteGammaLower(a,z)` | 2 | `(1,1,1,2)` an=[1], bm=[a], bq=[0], z=z | YES | YES |
| `IncompleteGammaUpper(a,z)` | 2 | `(2,0,1,2)` ap=[1], bm=[a,0], z=z | YES | YES |

The gamma bridge is **uniquely asymmetric** among the three bridges shipped so
far: only 2 of 9 Gamma-family heads have G-forms, and those 2 are the
incomplete-gamma heads (not the "flagship" complete Gamma). This is documented as
a feature of the mathematics, not our shortcoming.

**G-form details (Wikipedia MeijerG §"Representation of other functions";
cross-confirmed by DLMF §8.6.10-11):**

```ts
// In packages/meijer-core/src/bridges/gamma.ts:

// LowerIncompleteGamma: γ(a,z) = G^{1,1}_{1,2}(1; a, 0 | z)
//   an = [1], ap = [], bm = [a], bq = [0], z-sub = identity
//   Wolfram: MeijerG[{{1}, {}}, {{a}, {0}}, z]
case "IncompleteGammaLower": {
  const [a, z] = args;
  const gForm = { an: [ONE], ap: [], bm: [a], bq: [ZERO], z };
  return { gForm, wrap: (g) => g, argsInverse: () => [a, z] };
}

// UpperIncompleteGamma: Γ(a,z) = G^{2,0}_{1,2}(; 1; a, 0 | z)
//   an = [], ap = [1], bm = [a, 0], bq = [], z-sub = identity
//   Wolfram: MeijerG[{{}, {1}}, {{a, 0}, {}}, z]
case "IncompleteGammaUpper": {
  const [a, z] = args;
  const gForm = { an: [], ap: [ONE], bm: [a, ZERO], bq: [], z };
  return { gForm, wrap: (g) => g, argsInverse: () => [a, z] };
}
```

The z-substitution is the **identity** (no squaring, unlike Erf/Bessel). This
makes the backward bridge simpler — `z` is recovered directly from `form.z`
without multi-valued root concerns. The `argsInverse` closure is still used for
API uniformity.

**Backward bridge disambiguation for (2,0,1,2) shape** (R4 §C.3):

The (2,0,1,2) shape is shared among UpperIncompleteGamma, Erfc, and
ExpIntegralE. Precedence:
1. `bm = [0, 1/2]` or `[1/2, 0]` → Erfc (existing rule)
2. `bm = [0, 0]` → ExpIntegralE(1, z) (existing `dlmf-16-17-e1` rule; preferred
   over UpperIncompleteGamma(0,z) since ExpIntegralE is already in vocabulary)
3. `ap = [n]` with n≠1 rational → ExpIntegralE(n, z) (general E_n rule)
4. `ap = [1]` and bm = [a, 0] where a is not one of the above → UpperIncompleteGamma(a, z)

**Backward bridge disambiguation for (1,1,1,2) shape:**

The (1,1,1,2) shape is shared with Erf. Erf has `an = [1/2]`; LowerIncompleteGamma
has `an = [1]`. The `an[0]` discriminator fires first: if `an = [1]` and
`bm = [a]`, `bq = [0]` → LowerIncompleteGamma(a, z).

**ExpIntegralE disambiguation** (R4 §F.3 / R4 §C.3 discovery): The existing
`dlmf-16-17-e1` rule emits `ExpIntegralE(1, z)` from the (2,0,1,2) shape with
`bm=[0,0]`. Since `E_1(z) = Γ(0, z)` (DLMF §8.19.1), this rule is a
UpperIncompleteGamma in disguise — but through the ExpIntegralE vocabulary head.
The backward bridge must prefer `ExpIntegralE(1, z)` for the `bm=[0,0]` case to
avoid introducing a head-collision in the vocabulary. Tagged as `// L_E1_GAMMA`
in both the bridge and adapter code.

### Decision 6 — ADR-0023 vocabulary amendment (6 new heads) (per R1)

ADR-0023's `SPECIAL_FUNCTION_HEADS` table grows from 32 (post-Bessel) to 38:

```ts
// packages/cas-core/src/special-functions.ts (extension; I6a bead):
"LogGamma",              // (z) → ℂ; principal-value log Γ(z); DLMF §5.11.1; diff: Digamma(z)
"Pochhammer",            // (a, n) → ℂ; rising factorial (a)_n; DLMF §5.2.4; diff: partial
"IncompleteGammaUpper",  // (a, z) → ℂ; Γ(a,z) = ∫_z^∞ t^{a-1}e^{-t}dt; DLMF §8.2.2; diff: -z^{a-1}e^{-z}
"IncompleteGammaLower",  // (a, z) → ℂ; γ(a,z) = ∫_0^z t^{a-1}e^{-t}dt; DLMF §8.2.1; diff: +z^{a-1}e^{-z}
"Beta",                  // (a, b) → ℂ; B(a,b) = Γ(a)Γ(b)/Γ(a+b); DLMF §5.12.1; diff: B(a,b)[ψ(a)-ψ(a+b)]
"BarnesG",               // (z) → ℂ; G(z+1)=Γ(z)G(z), G(1)=1; DLMF §5.17.1

// Arity assignments:
// LogGamma:             { shape: "fixed", count: 1 }
// Pochhammer:           { shape: "fixed", count: 2 }  // (a, n)
// IncompleteGammaUpper: { shape: "fixed", count: 2 }  // (a, z)
// IncompleteGammaLower: { shape: "fixed", count: 2 }  // (a, z)
// Beta:                 { shape: "fixed", count: 2 }  // (a, b)
// BarnesG:              { shape: "fixed", count: 1 }
```

**Why 6 new vocab heads, not fewer:** Each head passes the Erfi-precedent test:
(1) no closed-form derivation keeps it elementary — `log Γ` is multi-valued
without a first-class head to carry principal-value semantics; Pochhammer appears
as a first-class argument in `HypergeometricPFQ`; the incomplete gammas are
the primary DLMF Chapter 8 objects; Beta is canonical in DLMF §5.12; BarnesG
appears in random-matrix determinant formulas. (2) Each has a canonical name in
DLMF. (3) Each has at least one v0.1-shippable symbolic identity rule (R1 §3).

**Why IncompleteGammaP and Q are NOT vocab heads** (Tension Resolution A,
documented here per Decision 4): R1 derives P and Q from Lower/Upper:
`P(a,z) = IncompleteGammaLower(a,z)/Gamma(a)` and
`Q(a,z) = IncompleteGammaUpper(a,z)/Gamma(a)`. All v0.1 symbolic identities
for P follow by dividing existing Lower/Upper rules; no new identity is simpler
than this derivation. The float64 evaluator admits P/Q as dispatcher entries for
numerical stability, but the vocabulary carries only the primitives.

Diff rules for new heads (in `differentiateSpecialFunction`):
- `d/dz LogGamma(z) = Digamma(z)` (DLMF §5.2.2)
- `d/dz IncompleteGammaUpper(a, z) = -z^{a-1} · e^{-z}` (DLMF §8.8.2)
- `d/dz IncompleteGammaLower(a, z) = +z^{a-1} · e^{-z}` (DLMF §8.8.1)
- `∂/∂a Beta(a, b) = Beta(a,b) · [Digamma(a) - Digamma(a+b)]` (DLMF §5.12)
- `∂/∂b Beta(a, b) = Beta(a,b) · [Digamma(b) - Digamma(a+b)]` (DLMF §5.12)
- `d/dn Pochhammer(a, n)`: refused (discrete order parameter — no chain rule in
  `n` for symbolic n; return null).
- `d/dz BarnesG(z)`: `d/dz log G(z) = (z-1)·Digamma(z) - LogGamma(z) + const`
  — complex; deferred to v0.2.

### Decision 7 — Wire tool surface (extend `tools/special-eval`) (per R3)

The `tools/special-eval` wire tool extends its per-head dispatch table:

```ts
// tools/special-eval/tool.ts (extension; T2 bead):
//   --head=Gamma | LogGamma | Digamma | Trigamma | Polygamma | Pochhammer |
//          IncompleteGammaUpper | IncompleteGammaLower | Beta | BarnesG
//   --a=<value>         // first parameter (Gamma, Digamma, etc.)
//   --b=<value>         // second parameter (Beta, Pochhammer n, Polygamma m)
//   --re=<value>        // z real part
//   --im=<value>        // z imaginary part (default 0)
//   --precision=<int>   // standard flag: ≤53 → float64, >53 → arb-prec (ADR-0011)
```

Per-output tier conditioning per ADR-0040 §Decision 9: `--precision≤53` →
`numerical: true` output (platform fingerprint recorded); `--precision>53` →
`arbprec: true` output (cross-platform deterministic). The mutex workaround from
Erf bead `gp75` applies until that ADR amendment lands.

### Decision 8 — Oracle hierarchy + cross-validation discipline (per R5)

| Tier | Oracles | Coverage | L12 trap |
|---|---|---|---|
| **Gold** | Wolfram Mathematica 14.3 + mpmath 1.3.0 | All heads real + complex at 50+ dp. Only gold voices for BarnesG complex. | L12 mandatory: `gammainc` in SciPy returns P; `Gamma[a,z]` in Wolfram returns UPPER unregularised. Tag `// L12` every adapter call. |
| **Silver** | Boost.Math 1.83 `cpp_bin_float<50>` | Real only (no complex); BarnesG and Hyperfactorial not covered. **HEADERS NOT INSTALLED** — gate G5 bead on install. | — |
| **Bronze** | SciPy 1.11.4 + libm | SciPy: most real heads; complex polygamma TypeError (L14); no BarnesG/Hyperfactorial. libm: tgamma + lgamma real only. | L12, L13, L15 all relevant |
| **Not available** | python-flint/Arb | Installable; provides complex arb-prec for ALL heads including BarnesG. **Install gates G7.** | — |

**17 landmines pinned in adapter code (R5 §6) — required reading for G2-G7:**

- **L1** Wolfram input-trap: ALWAYS use `Rational[num, den]` not decimal literals.
- **L2** mpmath `nstr` rounding vs Wolfram truncation: 1-ULP last-digit; comparator at `precision - 1`.
- **L_carryover** Wolfram `*^` exponent: `StringReplace["*^" → "e"]` in batch preamble.
- **L11** Wolfram trailing noise: strip at backtick annotation.
- **L12** (**#1 trap**) P/Q convention inversion: SciPy `gammainc(a,z)` = P (lower regularised); Wolfram `Gamma[a,z]` = upper UNregularised; Wolfram `GammaRegularized[a,z]` = Q; Wolfram `GammaRegularized[a,0,z]` = P. Tag `// L12` every call.
- **L13** InverseGammaReg: Wolfram `InverseGammaRegularized[a,q]` inverts Q; SciPy `gammainccinv` inverts Q; SciPy `gammaincinv` inverts P. Use `gammainccinv` for Wolfram comparison.
- **L14** SciPy complex polygamma TypeError in 1.11.4: refuse complex inputs for Polygamma with `tagged "oracle-scipy/polygamma-complex-unsupported"`.
- **L15** SciPy `loggamma(real_negative)` returns NaN: pass as `x + 0j`.
- **L16** BarnesG/Hyperfactorial: only Wolfram + mpmath available locally. Cross-validate at special-value checkpoints (BarnesG(1)=BarnesG(2)=BarnesG(3)=1; G(4)=2; G(5)=12).
- **L17** Gamma poles: four different oracle behaviors (ComplexInfinity / ValueError / +∞ / NaN). Comparator special-cases pole inputs.
- L3/L4/L5/L9/L10 carry from Bessel R5 (negative-ν branch, Y-tail cancellation, etc.) where applicable to gamma incomplete forms.

Adapter shape uniform per ADR-0040 §Decision 8: TS `(input, precision_decimals, fn) → (output, precision_actual, oracle_id, oracle_version)`. Spawn via `spawnBun` resolver (ADR-0001). Batch mode mandatory for Wolfram (7+ s cold-start).

**Install beads gate G5 and G7:**
- Install bead I_boost: `sudo apt install libboost-math-dev` → unblocks G5 (silver adapter)
- Install bead I_flint: `sudo apt install libflint-dev && pip install --user --break-system-packages python-flint` → unblocks G7 (gold complex third voice)

### Decision 9 — Per-output determinism tier (inherited from ADR-0040 §Decision 9)

`tools/special-eval` annotates `{ numerical: true, arbprec: true }` statically;
the provenance writer (`runMemoized`) checks the live output's tier and writes the
appropriate provenance fields. The `gp75` runtime mutex workaround continues to
apply — wrap float64 results in BigFloat at `prec=53` until that ADR amendment
lands. This ADR inherits the workaround verbatim; no Gamma-specific change.

### Decision 10 — Phase ordering + per-bead claim discipline

The Gamma epic sub-beads claim in five gated phases:

1. **Phase 0 (DONE)** — R1 (`1gir`), R2 (`vf19`), R3 (`ldsf`), R4 (`o8yk`),
   R5 (`hgt3`), A1 (`t4bc`), this ADR (A0). Install beads I_boost + I_flint
   filed as P1 gates.

2. **Phase 1** — G1 corpus design (orchestrator-authored); G2 Wolfram adapter;
   G3 mpmath adapter; G4 SciPy adapter; G5 Boost adapter (GATE: I_boost install);
   G6 libm adapter; G7 Arb adapter (GATE: I_flint install); G8 cross-agreement
   comparator (orchestrator-authored); G9 QA gate (orchestrator-authored).
   **Phase 1 GATE**: corpus complete; all oracles < 50 unexplained findings;
   L12 verified in all adapters.

3. **Phase 2** — Substrate impl in rounds (parallel within round):
   - **Round 1** (parallel, after ADR): I6a vocab amendment (6 new heads); I5
     float64 `gamma-float64.ts` (all 19 ADMITTED_HEADS per R3 verbatim-port
     discipline); I4 cas-core identities `gamma-identities.ts` (38 rules).
   - **Round 2** (after Round 1): I1a digamma/trigamma lift (negative z); I1b
     polygamma m≥2 lift (Hurwitz zeta); I2a bigIncompleteGammaUpper + Lower.
   - **Round 3** (after Round 2): I2b bigGammaP + Q; I3a bigBeta + bigLogBeta;
     I3b bigPochhammer; I3c bigBarnesG.
   - **Round 4** (after Round 3): I3d complex extensions (ctrigamma, cpolygamma,
     cIncompleteGammaUpper/Lower, cBeta); I6 Meijer-G bridge `gamma.ts`.
   - **Phase 2 GATE**: `bun run check` green; golden-master suite green.

4. **Phase 3** — T1 integrate-1d; T2 special-eval wire; T3 meijer-g closure.
   Parallel.

5. **Phase 4** — V1 property verification + D1 docs lockstep + epic close.

### Decision 11 — Existing batch dispatch rules that emit `"Gamma"` AST nodes

`packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` emits `expr("Gamma", [z])`
at approximately 4 call sites (lines 409, 429, 450 and surrounding context) as
prefactors in Bessel-type reduction rules. These are **Gamma-as-factor** emissions
(coefficient in the closed-form expression), not **Gamma-as-head** reductions.

The Gamma-family epic must NOT change the string `"Gamma"` in these output nodes.
They are load-bearing: the downstream evaluator (`packages/meijer-core/src/slater.ts`)
uses `cgamma` to evaluate these nodes. Any renaming of the vocabulary head `Gamma`
would break them silently. This constraint is noted here so every Phase 2 subagent
reads it before touching `special-functions.ts`.

### Decision 12 — File-location compatibility exemption for existing substrate

ADR-0040 §Decision 2 mandates `packages/bigfloat/src/special-funcs/<head>.ts`
as the per-head arb-prec landing site. `erf.ts` lives at
`packages/bigfloat/src/special-funcs/erf.ts`; `besselj.ts` through `besselk.ts`
live at `packages/bigfloat/src/special-funcs/besselj.ts`, etc.

The Gamma substrate breaks this pattern: `lgamma`, `gamma`, `digamma`,
`trigamma`, `polygamma` live at `packages/bigfloat/src/special.ts` (the package
root level, not the per-head sub-directory). A1 §2 §AXIS 3 confirms the
violation.

**This ADR amends to permit EITHER location for backwards-compatibility reasons,
with a mandatory justification:**

The `cgamma` and `clgamma` signatures at `packages/bigfloat/src/complex.ts` are
imported by `meijer-core/src/series.ts` at approximately **12 call sites**. Any
file-relocation of the Gamma substrate creates a non-trivial re-export chain
(either a shim `special.ts` re-exports from the new location, or all 12 import
sites in `series.ts` are updated). Either option:
- A shim at `special.ts` adds indirection and risks import-cycle issues (the
  existing `special.ts` is itself imported by `complex.ts` for `bernoulli`).
- Updating 12 import sites in `series.ts` is a medium-blast-radius mechanical
  change with no algorithmic benefit.

Both options fail the "all bugs are deep" test (CLAUDE.md Rule 2) in the inverse
sense: a relocation-only change with no algorithmic improvement that blasts 12
call sites is a bandaid, not a fix. The correct resolution is:

**Existing substrate STAYS in `special.ts` and `complex.ts` with their current
import paths.** New heads introduced by this epic (IncompleteGammaUpper,
IncompleteGammaLower, Beta, BarnesG, Pochhammer) land in `special-funcs/`
sub-files per the ADR-0040 mandate.

When a downstream consumer requires the Hurwitz-zeta substrate for polygamma m≥2,
it is added in-place to `special.ts` (or extracted to `special-funcs/polygamma.ts`
if the LOC justifies it) — not as a separate package.

**ADR-0040 §Decision 2 is amended to read:** Per-head landing sub-directory
`bigfloat/src/special-funcs/<head>.ts` is the **default** for new heads;
compatibility-grandfathered existing substrate at `bigfloat/src/special.ts` is
exempt from relocation until a future ADR specifically targets the migration with
a plan that does not break the 12 `cgamma` call sites.

A future migration bead (P3 priority, post-epic-close) may be filed to execute
the relocation using a re-export shim with a zero-blast-radius approach.

### Decision 13 — Gamma-family extension point in `simplify.ts`

`packages/cas-core/src/simplify.ts` contains a pre-wired extension point at
line 253 (`"Adding the next per-head substrate (Gamma, …) ships as a literally
additive new pre-pass function"`). The Gamma epic's I4 bead adds
`applyGammaRewrites` to the pipeline:

```ts
// After I4 ships:
const afterErf = applyErfRewrites(v);
const afterBessel = applyBesselRewrites(afterErf);
const rewritten = applyGammaRewrites(afterBessel);  // NEW
return simplifyRatFn(rewritten);
```

The `applyGammaRewrites` function dispatches the 38 rules in
`gamma-identities.ts` per the R1 priority ordering (A→B→C→D). The extension
is purely additive — no existing Erf or Bessel simplify path is touched.

---

## What we will not decide here

* **InverseGammaRegularized**. R1 rejects this head: it is a root-finding
  problem (`Q(a,z) = p` solved for z), not a closed-form function. No Meijer-G
  form exists. Honest refusal per ADR-0003.

* **IncompleteBeta / BetaRegularized**. R1 defers both: expressible as
  HypergeometricPFQ (DLMF §8.17.7) or via the existing Beta head; no standalone
  identity is simpler than the hypergeometric expansion. Promote when a
  downstream consumer surfaces.

* **Hyperfactorial**. Deferred (integer-argument-only sequence; no diff rule in
  the analytic sense; primary consumer is combinatorics not analysis). BarnesG
  is admitted because it is analytic; Hyperfactorial is an integer sequence that
  happens to have a BarnesG representation.

* **ReciprocalGamma (1/Γ) as a vocabulary head**. Deferred: `1/Gamma(z)` is
  entirely derivable from `Gamma` + reciprocal. The primary motivation (entire
  function, avoids pole singularities) does not surface in any v0.1 symbolic rule
  that requires it as a primitive. The float64 dispatcher admits `rgamma` as an
  evaluation shortcut without a vocabulary head.

* **Olver-uniform asymptotic for IncompleteGamma**. R2 §4 recommends Temme's
  uniform asymptotic for the `|z-a| ≤ C·√a` transition region. v0.1 ships with
  the series + CF dispatch which covers all 34 corpus cells; Temme's path is a
  v0.2 refinement.

* **Complex incomplete gamma and complex Beta with Boost.Math**. Boost has no
  `std::complex<cpp_bin_float<N>>` support (same limitation as in Erf/Bessel R5).
  Complex arb-prec relies on Wolfram + mpmath gold tier; python-flint/Arb if
  installed.

* **SphericalBesselI / K disambiguation (carry from ADR-0041)**. Not within scope
  of this epic.

* **LogGamma for real x < 0 as a "real" function**. `lgamma(x)` for x < 0
  returns `log|Γ(x)|` in libm (the real part only). The Gamma epic's LogGamma
  vocabulary head carries the analytic continuation (imaginary part ≠ 0 for
  x < 0 non-integer). SciPy `loggamma(real_negative)` returns NaN; pass as
  complex per L15. The disambiguation is documented in oracle adapters; the
  substrate correctly returns the analytic continuation.

---

## Why these choices

### Substrate layering unchanged from ADR-0040/0041 — by design

This ADR's central claim is that the per-head substrate pattern **generalises to
the Gamma family** without architectural change. The five-axis package split is
preserved. The per-head landing sub-directories are reused. The wire surface
(single umbrella tool with `--head=<name>` + `--precision=<int>`) is reused. The
only ADR-0040/0041 surface that needed extension was the bridge API
(`zInverse` → `argsInverse` in ADR-0041), and that extension already
accommodates Gamma's 2-arg incomplete-gamma heads without further change.

### Gamma-has-no-G-form — a feature of the mathematics

The absence of a Meijer-G form for `Gamma(z)` is sometimes surprising to
practitioners who encounter Gamma as a result of Meijer-G evaluation (via
Bateman §5.6 rules). The apparent contradiction is resolved by the distinction
between Gamma-as-factor (coefficient in a closed form produced by a Meijer-G
reduction) and Gamma-as-head (the value a Meijer-G evaluation produces). The
Bateman rules use Gamma in the former role; the bridge is about the latter role.
These are structurally incompatible: Gamma cannot simultaneously be the building
block of Meijer-G's residue arithmetic and the value that arithmetic produces.
This ADR documents the asymmetry explicitly so every downstream implementer
understands it and does not chase a non-existent G-form.

### P/Q as float64-only dispatcher entries

R3's recommendation to include P/Q as ADMITTED_HEADS in the float64 dispatcher
is numerically sound: Cephes `igam.c` implements P and Q directly (not as
γ/Γ and Γ_upper/Γ ratios), because the direct series/CF paths for P and Q are
more numerically stable than the ratio. The vocabulary admission decision (R1
defers P/Q) is a *symbolic* decision — P and Q do not need to be first-class
AST nodes because all their symbolic identities follow by dividing existing
Upper/Lower rules. The float64 dispatcher can admit more entries than the
vocabulary, just as Erf's dispatcher admits `Erfcx` as a float64-stable variant
while the vocabulary carries only `Erf`, `Erfc`, `Erfi`.

### 6 new vocabulary heads — all pass the Erfi test

LogGamma: carries principal-value semantics that `log(Gamma(z))` does not
(multi-valued for z ∉ ℝ₊). Pochhammer: first-class argument in HypergeometricPFQ
and every hypergeometric identity. IncompleteGammaUpper and Lower: the primary
Chapter 8 objects with independent diff rules and G-forms. Beta: canonical
DLMF §5.12 object with direct diff rules and natural recurrences. BarnesG:
entire function of order 2 with a functional equation `G(z+1) = Γ(z)G(z)` that
makes it a natural extension of the Gamma sequence for RMT applications.

### File-location exemption

Enforcing the ADR-0040 layout strictly for `special.ts` would require updating
~12 `cgamma` call sites in `meijer-core/src/series.ts` and the `clgamma` import
chain in `complex.ts`. That is a non-trivial blast radius (every Meijer-G
evaluation that uses the Slater path goes through `cgamma`) for a change with
zero algorithmic benefit. The exemption preserves existing import stability while
new heads follow the standard convention. This is not a bandaid — it is an
explicit, reasoned deviation from a convention where the convention's purpose
(per-head isolation) is already served by the `special.ts` module structure even
at the root level.

### Digamma/trigamma lifts as v0.1 P1 work

The digamma negative-argument throw at `special.ts:340` is an undocumented API
restriction that affects any downstream call with z < 0. The fix is minimal
(import `cos` from `transcendental.ts`; replicate the `cdigammaReflect` pattern
in real arithmetic) and unblocks: (a) the negative-z corpus cells in Phase 1;
(b) the `Digamma(z)` diff rule's correctness for z < 0 expressions. Filing as
P1 rather than P2 because it affects oracle-comparison correctness in Phase 1.

---

## Acceptance

This ADR is *accepted* when:

- ADR file written (this document).
- Phase 1 beads (G1-G9, excluding G5 pre-install and G7 pre-install) lose their
  `blocked-by` dependency edge on this ADR (verified via `bd ready` listing G1
  as claimable).
- Phase 2 prep beads (I6a, I5, I4, I1a, I1b, I2a, I2b, I3a-d, I6) lose their
  `blocked-by:ADR-0042` edge.
- Install beads I_boost and I_flint are filed as P1 prerequisites for G5 and G7.

The *substrate* this ADR pins is implemented when:

- All Phase 2 beads closed.
- `bun run check` green.
- Golden-master suite (`bench/gamma-anchor/`) byte-identical at 50 dp against
  Wolfram + mpmath gold tier for all admitted real heads; ULP-distance ≤ 3
  vs Cephes/FreeBSD/Boost for float64 heads.
- Property tests (V1) green with mutation-proving: at least 3 perturbations per
  function cause RED (e.g., Γ(1/2) = √π → FALSE if coefficient changed; Stirling
  term sign flip → precision collapse at 50 dp; digamma reflection sign flip →
  wrong branch).
- `tools/special-eval --head=Gamma --re=1.5 --precision=200` returns a 200-bit
  BigFloat matching Wolfram's `N[Gamma[Rational[3,2]], 60]` truncated to 200 bits.
- `tools/special-eval --head=IncompleteGammaUpper --a=1.5 --re=2.5 --precision=200`
  matches mpmath `gammainc(mpf(3)/2, mpf(5)/2)` at 50 dp.
- Meijer-G bridge round-trip byte-identical for IncompleteGammaUpper and
  IncompleteGammaLower against the canonical G-forms in Decision 5.
- Existing `meijer-core` tests green and unchanged (the 12 `cgamma` call sites
  in `series.ts` continue to work without modification).

The *structural asymmetry* this ADR documents is accepted when:

- `headToMeijerG("Gamma", [sym("z")])` returns null.
- `headToMeijerG("Beta", [sym("a"), sym("b")])` returns null.
- `headToMeijerG("BarnesG", [sym("z")])` returns null.
- `headToMeijerG("IncompleteGammaUpper", [sym("a"), sym("z")])` returns a
  non-null ForwardBridge with the (2,0,1,2) G-form.
- All three honest-refusal heads have test assertions verifying the null return.
