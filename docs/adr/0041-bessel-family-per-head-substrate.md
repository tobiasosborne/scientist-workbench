# ADR-0041 — Per-head substrate applied to the canonical Bessel family (J, Y, I, K)

**Status:** Proposed — 2026-05-17.
**Beads:** `scientist-workbench-zcam` (epic — World-class Bessel J + Y + I + K).
Phase 0 research children all closed: `cela` (R1 symbolic identities), `dn76`
(R2 arb-prec algorithms), `1272` (R3 float64 algorithms), `wi4t` (R4 Meijer-G
bridge), `gimq` (R5 oracle landscape). This ADR (`oibh` / A0) is the Phase 0
gate. Phase 1 (golden corpus G1–G9), Phase 2 (substrate impl I1a/I1b/I2a/I2b/
I3a/I3b/I4/I5a/I6/I6a + the R-discovered `I6b` pattern primitives and
`I6-prep` API rename), Phase 3 (T1/T2/T3), and Phase 4 (V1/D1) are filed and
blocked on this ADR.
**Related:** **ADR-0040** (per-head substrate prototype #1 — Erf; this ADR is
prototype #2 and validates the pattern generalises), ADR-0023 (closed
special-function vocabulary; this ADR amends with 4 new heads — `HankelH1`,
`HankelH2`, `SphericalBesselJ`, `SphericalBesselY`), ADR-0025 (Meijer-G
symbolic dispatch pattern-rule design), ADR-0027 (Meijer-G dispatcher
umbrella), ADR-0020 (`arbprec: true` determinism contract — bit-identical
cross-platform forever given `--precision=N`), ADR-0015 (`numerical: true`
determinism contract — bit-identical given platform fingerprint), ADR-0011
(typed flags; `--precision` is a standard flag), ADR-0007 (per-output
determinism-tier precedent), ADR-0014 (first numerical tier — substrate-
package pattern). Bead `d6s` (per-head arbprec evaluator) and bead `gp75`
(runtime mutex amendment for cross-tier tools) are inherited from the Erf
epic and remain the relevant cross-tier touchpoints.

## Context

ADR-0040 pinned the per-head special-function substrate using Erf as the
v0.1 instantiation: a five-layer architecture (symbolic identities in
`cas-core`; diff rules in `cas-core`; arb-prec real+complex in `bigfloat`;
float64 real+complex in `quadrature`; bidirectional Meijer-G bridge in
`meijer-core`) plus a single wire surface (`tools/special-eval`) dispatching
behind `--head=<name>` + `--precision=<int>`. The Erf epic (worklog 142)
shipped 47 beads, ~4100 LOC across 6 packages, 761 new test cases, 0
failures, 0 regressions. The acceptance criterion that pinned the *pattern
generalises* claim was deferred to the second head — this ADR is that
second head.

Bessel (J, Y, I, K) is the natural choice because:
1. It is the canonical multi-argument special-function family (every entry
   takes `(ν, z)`, where `ν` ranges over `ℤ` / `ℤ+1/2` / `ℝ` / `ℂ`). This
   is the first per-head substrate test of 2-argument heads — Erf was
   1-argument throughout. The Meijer-G bridge's `zInverse` closure
   (ADR-0040 §Decision 5) must generalise to multiple slots.
2. The cas-core vocabulary already admits all four: `BesselJ`, `BesselY`,
   `BesselI`, `BesselK` are in `SPECIAL_FUNCTION_HEADS` (lines 121-124,
   174-177 of `packages/cas-core/src/special-functions.ts`) with arity-2
   declarations (lines 210-213) and diff rules `ruleBesselFirstKind`,
   `ruleBesselI`, `ruleBesselK` (lines 331-337, 564-606) already shipping.
   The vocabulary substrate is in place; the arb-prec / float64 / Meijer-G
   layers are silent for the entire family.
3. Bessel is the **canonical** physics special-function family — quantum
   scattering, signal processing, PDE separation of variables in cylindrical
   geometry, etc. — so reference-quality substrate has the broadest
   downstream consumer pool.
4. Bessel is harder than Erf in three specific ways that stress the
   per-head substrate pattern: (a) 4 distinct functions (vs Erf's family of
   4 closely-related transforms) couple non-trivially through the J↔I
   rotation `I_ν(z) = i^{-ν} J_ν(iz)`; (b) the Hankel asymptotic series is
   divergent (vs Erf's convergent Borel form) with smallest-term
   termination; (c) the "transition region" `|z| ≈ ν` is the
   algorithmically hardest regime in classical analysis. If the per-head
   pattern survives these stresses without architectural change, the
   pattern is robust.

### Phase 0 research findings (load-bearing for the decisions)

Five Opus deep-research subagents produced 6754 lines of literature-cited
material at `docs/refs/besselj-research/`. Total downloaded ground truth:
~11 MB across `sources/{symbolic,arbprec,float64,meijer-g,oracles}/`
including DLMF Ch.10 + §16, FLINT/Arb Bessel C sources, mpmath/SymPy
`bessel.py`, Boost.Math headers, AMOS TOMS 644 Fortran (`ZBESJ`/`ZBESY`/
`ZBESI`/`ZBESK`), SLATEC `dbesj.f` etc., musl SunPro `j0.c`/`j1.c`/`jn.c`,
SciPy Cephes `k0.c`/`k1.c`, and 26 oracle-probe artefacts. The findings
that pin this ADR:

* **R1** (symbolic, `docs/refs/besselj-research/R1-symbolic-identities.md`,
  1260 lines): 85 identities surveyed across 12 classes; **30 v0.1-shippable
  rules** in five priority classes (A — 6 special values + 2 refusal classes;
  B — 6 integer-ν parity; C — 8 half-integer closures the load-bearing
  user-visible feature; D — 4 Hankel/spherical rewrite-on-request; E — 3
  spherical small-n closures). **Verified finding**:
  `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` already ships 5
  Bessel-emitting rules in production; this ADR's bridge layer plugs into
  them. **Discovery A** — admit **4 new heads** to the ADR-0023 vocabulary
  table (`HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY`)
  per the Erfi-precedent test; defer `SphericalBesselI`/`SphericalBesselK`
  pending a clean resolution of the DLMF §10.47.7-8 `i^{(1)}` / `i^{(2)}`
  ambiguity. **Discovery B** — cas-core's pattern language needs 3 new
  predicate helpers: `isPositiveInteger`, `isNonNegativeInteger`,
  `isHalfInteger`. None of priority-class C ships without
  `isHalfInteger`; load-bearing.
* **R2** (arb-prec, `docs/refs/besselj-research/R2-arbprec-algorithms.md`,
  2367 lines): per-function dispatch tables aligned to FLINT/Arb
  (`bessel_j.c` / `bessel_y.c` / `bessel_i.c` / `bessel_k.c`); the
  load-bearing crossover threshold is `z_c_Hankel(p) = p/2` — **linear in
  precision**, fundamentally different scaling from Erf's `x_c(p) = √(p ln
  2)` because Bessel's Hankel terms shrink only as `1/(8|z|)` per step (Erf's
  shrank as `1/(2z²)`). Real algorithms: ₀F₁ Maclaurin for `|z| < 8` (or
  `2|z| < p`); Hankel asymptotic for `|z| > p/2`; cancellation-retry ₀F₁ in
  between (FLINT's pattern, replacing Olver-uniform / Temme CF which need
  Airy / specialised CF substrates this ADR defers). **Complex algorithms
  via Amos rotation** `J_ν(z) = exp(±νπi/2) · I_ν(∓iz)` (AMOS ZBESJ
  pattern) — this is the single non-obvious architectural insight: complex
  J/Y are computed via complex I/K internally, so the substrate's complex
  layer ships J + Y + I + K together rather than splitting J/Y in Round 2
  and I/K in Round 3 as originally planned. **6 risks pinned** with primary-
  source citations. **v0.1 deferrals**: Olver-uniform (needs `bigAiryAi`),
  Debye large-ν (needs `U_k` polynomial generator), Temme/Steed CF for the
  `|x| ≪ |ν|` robustness corner — none gate the v0.1 reference claim.
* **R3** (float64, `docs/refs/besselj-research/R3-float64-algorithms.md`,
  2174 lines): per-function verbatim-port table — **musl SunPro `j0.c` /
  `j1.c` / `jn.c`** for integer-ν J and Y (the canonical libm lineage
  already running across glibc / musl / FreeBSD / Apple's libm, the same
  Sun-1993 family Erf I5 ported); **Boost `bessel_jy.hpp`** (Steed CF1+CF2
  + `temme_jy`) for general-ν J and Y; **Boost `bessel_i0.hpp` / `i1.hpp`**
  (Holoborodko 2015, ≤ 1.5 ULP — the most-accurate available) for integer-ν
  I; **SciPy `scipy_iv.c::ikv_temme`** (Boost ported to C) jointly for
  general-ν I and K; **Cephes `k0.c` / `k1.c`** (Moshier 2000) for
  integer-ν K; **AMOS TOMS 644** (`zbesj.f` / `zbesy.f` / `zbesi.f` /
  `zbesk.f` plus ~30 Fortran callees) for all complex paths — the canonical
  free-of-charge reference impl; SciPy and Julia both wrap it. **Scaled
  variants** `besselIScaledFloat64` (= `e^{-|x|}·I_ν(x)`) and
  `besselKScaledFloat64` (= `e^x·K_ν(x)`) ship in v0.1 (Erf `erfcx`
  precedent) to avoid the `x > 700` overflow / underflow cliff. **Verbatim
  port discipline pinned** at §0.0 with the Erf friction-#11 citation;
  Bessel is harder than Erf (8 entry points × 4-6 algorithm pieces) so this
  rule matters more.
* **R4** (Meijer-G bridge, `docs/refs/besselj-research/R4-meijer-g-bridge.md`,
  1690 lines): **the 12-cell canonical-G-form table collapses to 4 forms** —
  one per head, **uniform in ν** (no integer / half-integer / general
  branching at the bridge layer). Closed-form ν-specific reductions
  (`J_{1/2} = √(2/πz)·sin(z)`) and integer-ν recurrences live in
  `cas-simplify` (driven by I4), not the bridge. Canonical forms (Wolfram
  convention, triangulated via SymPy `meijerint.py:240-285` + mpmath 30-40
  dp verification across (ν ∈ {1.7, 2, 0.5, -2, 0, 1, 3}) × (z ∈ {1.3, 1.5,
  2.5, 0, ±real})):
  - `BesselJ(ν,z) = G^{1,0}_{0,2}([],[]; [ν/2],[-ν/2]; z²/4)` — prefactor 1
  - `BesselY(ν,z) = G^{2,0}_{1,3}([],[-(ν+1)/2]; [ν/2,-ν/2],[-(ν+1)/2]; z²/4)` — prefactor 1
  - `BesselI(ν,z) = π · G^{1,0}_{1,3}([],[(ν+1)/2]; [ν/2],[-ν/2,(ν+1)/2]; z²/4)`
  - `BesselK(ν,z) = (1/2) · G^{2,0}_{0,2}([],[]; [ν/2,-ν/2],[]; z²/4)`
  **API recommendation: Design A** — rename `zInverse` → `argsInverse`
  (closure returns `readonly Value[]` arity-agnostic; mechanical 3-site
  refactor in `packages/meijer-core/src/bridges/{types.ts,erf.ts}` + tests;
  Erf becomes `argsInverse() => [origArg]` 1-element list, backward-
  compatible). This rename is filed as bead `qt6m` (I6-prep, P1) that gates
  the Bessel I6 bead (`kgky`). **2 backward-dispatch gaps discovered**:
  no `BesselY` or `BesselI` backward dispatch rules in
  `dispatch-rules/`; standalone `meijerGToHead` covers them but a
  dispatcher rule is recommended (filed P2 as `1xqq` and `lfet` for post-
  T3).
* **R5** (oracle landscape, `docs/refs/besselj-research/R5-oracle-landscape.md`,
  1263 lines): 4 oracle voices available locally — **Wolfram Mathematica
  14.3** (gold, all 24 cells); **mpmath 1.3.0** (gold, all 24 cells); **Boost
  1.83 + cpp_bin_float<50>** (silver, real only — complex template fails
  identically to Erf, and the Y_ν entry point is `cyl_neumann` not
  `cyl_bessel_y`); **SciPy 1.17.0** (bronze, all 24 cells via Amos
  internally); libm (bronze, integer-ν J and Y real only). **Julia /
  SpecialFunctions.jl** deferred per orchestrator decision (algorithmically
  redundant with SciPy — both wrap Amos). **Arb / python-flint** install
  authorised by user 2026-05-17 → unblocks G7. **Critical correction to Erf
  R5**: the Erf-era recommendation `apt install libflint-dev
  libflint-arb-dev` is **stale** for Ubuntu 24.04 — FLINT 3.0+ has Arb
  merged in; the correct command is `apt install libflint-dev` + `pip
  install --user --break-system-packages python-flint`. The Ubuntu `libarb`
  package is an unrelated phylogenetic-analysis project — do NOT install
  it. **11 landmines pinned** (L1-L11): 3 Erf carryovers (Wolfram input-
  trap, mpmath/Wolfram rounding mismatch, Wolfram `*^` exponent) + 8 Bessel-
  specific (L3 negative-ν branch convention, L4 Boost Y-tail
  cancellation, L5 SciPy `jv` silent underflow, L6 Julia deferred bug, L7
  zero-divergence tolerance band, L8 integer-vs-near-integer-ν
  discontinuity, L9 K underflow, L10 I overflow, L11 Wolfram trailing-noise
  digits, L_boost_yspell `cyl_neumann` spelling). Each pinned in the
  oracle-adapter prompts so G2-G7 subagents don't re-discover them.

## Decision

We pin the per-head substrate for the Bessel family under the architecture
ADR-0040 established, extended in five specific places to handle the 2-arg
ν+z parameter shape and the algorithmic couplings R2 + R4 surfaced. Erf
remains the reference for the 1-arg case; Bessel becomes the reference for
the multi-arg case.

### Decision 1 — Substrate layering (inherited from ADR-0040)

| Axis | Package | Per-head landing | Determinism tier |
|---|---|---|---|
| Symbolic identities | `@workbench/cas-core` | `src/special-funcs/bessel-identities.ts` | symbolic |
| Diff rules | `@workbench/cas-core` | `src/special-functions.ts` (already shipping) | symbolic |
| Arb-prec real + complex | `@workbench/bigfloat` | `src/special-funcs/{besselj,bessely,besseli,besselk}.ts` + extension to `src/complex.ts` | `arbprec: true` (ADR-0020) |
| Float64 real + complex | `@workbench/quadrature` | `src/special-funcs/bessel-float64.ts` + extension to `src/eval-numeric-expr.ts` `applySpecial` | `numerical: true` (ADR-0015) |
| Meijer-G bridge | `@workbench/meijer-core` | `src/bridges/bessel.ts` (after I6-prep refactors the bridge API) | symbolic |
| Wire surface | `tools/special-eval/` | per-head dispatch table extended with `BesselJ`/`BesselY`/`BesselI`/`BesselK` | per-tier conditional (ADR-0040 §Decision 9) |

The per-axis package boundaries are preserved exactly as ADR-0040 pinned
them. No new top-level package; the Bessel-specific modules live as sister
files to the Erf-specific modules already in production.

### Decision 2 — Per-head module layout

```
packages/cas-core/src/special-funcs/bessel-identities.ts
packages/cas-core/src/special-functions.ts                  # extend SPECIAL_FUNCTION_HEADS + arity + diff
packages/cas-core/src/pattern.ts                            # extend with isPositiveInteger / isNonNegativeInteger / isHalfInteger (I6b)
packages/bigfloat/src/special-funcs/besselj.ts              # bigBesselJ real (all-ν dispatch per R2)
packages/bigfloat/src/special-funcs/bessely.ts              # bigBesselY real (joint with J in FLINT pattern)
packages/bigfloat/src/special-funcs/besseli.ts              # bigBesselI real
packages/bigfloat/src/special-funcs/besselk.ts              # bigBesselK real
packages/bigfloat/src/complex.ts                            # extend with bigCBesselJ/Y/I/K + bigCHankelH1/H2 (joint module per the J↔I rotation)
packages/quadrature/src/special-funcs/bessel-float64.ts     # real + complex per R3 verbatim-port table
packages/quadrature/src/eval-numeric-expr.ts                # extend applySpecial dispatcher
packages/meijer-core/src/bridges/types.ts                   # I6-prep: zInverse → argsInverse rename
packages/meijer-core/src/bridges/erf.ts                     # I6-prep: same rename (Erf compat)
packages/meijer-core/src/bridges/bessel.ts                  # I6: forward + backward bridge for J/Y/I/K
tools/special-eval/                                         # per-head dispatch table extended
```

Substrate-package boundaries identical to ADR-0040's Decision 2. Per-head
landing sub-directories (`bigfloat/src/special-funcs/`,
`cas-core/src/special-funcs/`, `meijer-core/src/bridges/`) exactly match.
This ADR validates the per-head landing-sub-directory pattern generalises
without modification.

### Decision 3 — Arb-prec evaluator contract (per R2)

Per-head signature (uniform across the family):

```ts
// Real path. Throws RangeError on non-finite input; returns BigFloat with
// precision exactly `prec` bits post-normalisation.
export function bigBesselJ(nu: BigFloat, z: BigFloat, prec: number): BigFloat;
export function bigBesselY(nu: BigFloat, z: BigFloat, prec: number): BigFloat;
export function bigBesselI(nu: BigFloat, z: BigFloat, prec: number): BigFloat;
export function bigBesselK(nu: BigFloat, z: BigFloat, prec: number): BigFloat;
export function bigBesselIScaled(nu: BigFloat, z: BigFloat, prec: number): BigFloat;   // e^{-|z|}·I_nu(z); avoids overflow for |z| > 700/ln(2) bits worth
export function bigBesselKScaled(nu: BigFloat, z: BigFloat, prec: number): BigFloat;   // e^{z}·K_nu(z); avoids underflow

// Complex path. The complex J / Y / I / K are computed jointly because
// Amos's rotation J(z) = exp(±νπi/2) · I(∓iz) tangles them at the
// substrate level (R2 §3.3, AMOS ZBESJ pattern).
export function bigCBesselJ(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCBesselY(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCBesselI(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCBesselK(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCHankelH1(nu: BigComplex, z: BigComplex, prec: number): BigComplex; // = J + i·Y; load-bearing intermediate
export function bigCHankelH2(nu: BigComplex, z: BigComplex, prec: number): BigComplex; // = J - i·Y
```

Algorithms are fixed by R2 dispatch tables (§3):
- **Real path crossover**: `z_c_Hankel(p) = p/2` (FLINT factor-2
  conservative margin from `bessel_j.c:592`). For `|z| < min(8, 2|z|/p)`
  use ₀F₁ Maclaurin direct; for `|z| > z_c_Hankel(p)` use Hankel
  asymptotic with smallest-term termination; otherwise ₀F₁ with
  cancellation-retry per R2 §3.2.
- **Y_ν path**: integer ν via `Y_n = -2i^n·K_n(iz)/π − phase·i·J_n` (FLINT
  pattern, `bessel_y.c:36-80`); non-integer via the J(ν) / J(-ν) connection
  formula with cancellation-retry on near-integer ν.
- **K_ν path**: integer ν via dedicated Temme path (`bessel_k.c`); non-
  integer via I_ν / I_{-ν} connection with cancellation-retry.
- **Complex paths**: AMOS-style rotation per R2 §3.3 — `J_ν(z) =
  exp(±νπi/2)·I_ν(∓iz)` and symmetric for Y and K. The substrate computes
  the complex modified family (I, K) first, then derives J, Y, H¹, H²
  algebraically.

Cancellation-driven precision retry mirrors `clgammaReflect` (worklog 117,
bead `oj5j`) and `bigErf` (Erf I1 q30j): measure loss as `magBits(blowUp) -
magBits(finalValue)`, bump `work = prec + 32 + lossBits`, recompute. R2's
algorithm dispatch tables identify the cancellation sites explicitly per
regime.

Determinism: every operation is `BigInt` + bounded-integer-exponent
arithmetic; inherits the `arbprec: true` contract of ADR-0020 — same
`(nu, z, prec)` bytes → byte-identical `BigFloat` / `BigComplex` output
forever. The `prec` argument is the standard `--precision` flag (ADR-0011);
its value is part of the input identity, so different precisions cache to
different output hashes.

### Decision 4 — Float64 evaluator contract + dispatch hook (per R3)

A single new module `packages/quadrature/src/special-funcs/bessel-float64.ts`
ships verbatim ports of the R3-recommended sources, plus the
`eval-numeric-expr.ts` `applySpecial` dispatcher entry per head.

Per-head signature:

```ts
// Real (Float64); pure JS, no FFI. Inherits the numerical: true platform
// fingerprint of V8's Math.exp/log/sqrt + the few DataView helpers.
export function besselJFloat64(nu: number, z: number): number;
export function besselYFloat64(nu: number, z: number): number;
export function besselIFloat64(nu: number, z: number): number;
export function besselKFloat64(nu: number, z: number): number;
export function besselIScaledFloat64(nu: number, z: number): number;
export function besselKScaledFloat64(nu: number, z: number): number;

// Complex (paired float64). The complex path uses AMOS verbatim per R3 §0.4.
export function besselJComplexFloat64(nu: number, re: number, im: number): { re: number; im: number };
export function besselYComplexFloat64(nu: number, re: number, im: number): { re: number; im: number };
export function besselIComplexFloat64(nu: number, re: number, im: number): { re: number; im: number };
export function besselKComplexFloat64(nu: number, re: number, im: number): { re: number; im: number };
```

Algorithm dispatch per R3 (verbatim ports, NOT re-derivations):

| Head + regime | Source | Accuracy |
|---|---|---|
| `J_0` / `J_1` / `J_n` integer-ν real | musl `j0.c` / `j1.c` / `jn.c` (SunPro 1993) | ≤ 2-4 ULP |
| `J_ν` general-ν real | Boost `bessel_jy.hpp` (Steed CF1+CF2 + `temme_jy`) | ≤ 3 ULP |
| `Y_0` / `Y_1` / `Y_n` integer-ν real | musl (Y bundled with J) | ≤ 4 ULP |
| `Y_ν` general-ν real | Boost `bessel_jy.hpp` (joint with J) | ≤ 3 ULP |
| `I_0` / `I_1` real | Boost `bessel_i0.hpp` / `i1.hpp` (Holoborodko 2015) | ≤ 1.5 ULP |
| `I_ν` general-ν real | SciPy `scipy_iv.c::ikv_temme` (Boost ported to C) | ≤ 3 ULP |
| `K_0` / `K_1` real | Cephes `k0.c` / `k1.c` (Moshier 2000) | ≤ 5 ULP |
| `K_ν` general-ν real | SciPy `scipy_iv.c::ikv_temme` (joint with I) | ≤ 3 ULP |
| Complex `J_ν` / `Y_ν` / `I_ν` / `K_ν` | **AMOS TOMS 644** (`zbesj.f` / `zbesy.f` / `zbesi.f` / `zbesk.f` + ~30 callees) | ≤ 18 dp |

The `applySpecial` dispatcher extends `ADMITTED_HEADS` with `BesselJ`,
`BesselY`, `BesselI`, `BesselK`. `HankelH1` / `HankelH2` / `SphericalBesselJ`
/ `SphericalBesselY` (new vocab per Decision 6) are admitted symbolically but
NOT given float64 evaluators in v0.1 — they pretty-print via cas-simplify's
rewrite-on-request rules (R1 priority-class D).

`numerical: true` contract: same `(nu, z, platform_fp)` → byte-identical
output. Platform fingerprint `{arch, os, runtime}` recorded in provenance
per ADR-0015.

### Decision 5 — Bidirectional Meijer-G bridge API (per R4)

The single architectural extension to ADR-0040 §Decision 5 is the closure
shape:

```ts
// In packages/meijer-core/src/bridges/types.ts (after I6-prep rename):
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly argsInverse: () => readonly Value[];   // renamed from zInverse; returns ALL original head args byte-identically
}
```

`argsInverse` returns a `readonly Value[]` of arbitrary length —
arity-agnostic. Erf becomes `argsInverse() => [origZ]` (1-element list,
mechanical rewrite at 3 sites per R4 §C). Bessel becomes `argsInverse() =>
[origNu, origZ]` (2-element list). Future 3-arg heads (`WhittakerM(κ, μ, z)`,
etc.) become `[origK, origMu, origZ]` without further API change.

The rename ships as a separate bead `qt6m` (I6-prep, P1) that **gates I6**.
Erf round-trip suite must remain byte-identical post-rename — this is the
acceptance gate for I6-prep.

The 4 canonical G-forms per R4 §A.4 (uniform in ν; no class branching at
the bridge layer):

```ts
// In packages/meijer-core/src/bridges/bessel.ts:
// J(ν,z) = G^{1,0}_{0,2}([], []; [ν/2], [-ν/2]; z²/4)                    prefactor 1
// Y(ν,z) = G^{2,0}_{1,3}([], [-(ν+1)/2]; [ν/2,-ν/2], [-(ν+1)/2]; z²/4)    prefactor 1
// I(ν,z) = π · G^{1,0}_{1,3}([], [(ν+1)/2]; [ν/2], [-ν/2,(ν+1)/2]; z²/4)
// K(ν,z) = (1/2) · G^{2,0}_{0,2}([], []; [ν/2,-ν/2], []; z²/4)
```

Round-trip property byte-identical via `argsInverse` (which sidesteps the
multi-valued `√(z²)` recovery problem):

```ts
for (const head of ["BesselJ", "BesselY", "BesselI", "BesselK"]) {
  for (const [nu, z] of besselFamilySamples) {
    const fwd = headToMeijerG(head, [nu, z]);
    const bwd = meijerGToHead(fwd!.gForm);
    assert(bwd!.head === head);
    assert(canonicalize(value(bwd!.args)) === canonicalize(value([nu, z])));
  }
}
```

### Decision 6 — ADR-0023 vocabulary amendment (4 new heads) + pattern primitive extension (3 new helpers)

ADR-0023's `SPECIAL_FUNCTION_HEADS` table grows from 28 (post-Erfi) to 32 by
admitting:

```ts
// packages/cas-core/src/special-functions.ts (extension; I6a bead vsvl):
"HankelH1",                        // (ν, z) → ℂ; = J_ν + i·Y_ν
"HankelH2",                        // (ν, z) → ℂ; = J_ν - i·Y_ν
"SphericalBesselJ",                // (n, z) → ℝ; n ∈ ℤ_{≥0}; = √(π/(2z)) · J_{n+1/2}(z)
"SphericalBesselY",                // (n, z) → ℝ; n ∈ ℤ_{≥0}; = √(π/(2z)) · Y_{n+1/2}(z)

// specialFunctionArity — all fixed-2.
// differentiateSpecialFunction — diff rules per R1 §10 (deferable to I6a if R1's coverage tightens).
```

R1 §17 (Discovery A) applies the Erfi-precedent test: each of these heads
has no closed-form derivation that keeps it elementary; each appears in
canonical literature with its own name; each has at least one v0.1-shippable
identity rule. Pass. `SphericalBesselI` and `SphericalBesselK` are **NOT**
admitted in v0.1 because DLMF §10.47.7-8 defines two distinct conventions
(`i^{(1)}_n` and `i^{(2)}_n`) and the cas-core vocabulary cannot represent
"this is one of two distinct spherical-modified-Bessel functions" without
a tag-disambiguator the substrate doesn't yet support. Filed as P3 follow-
up; revisit when a downstream consumer surfaces.

`packages/cas-core/src/pattern.ts` extends with three predicate helpers
(R1 Discovery B; bead `7j02` I6b):

```ts
export function isPositiveInteger(v: Value): boolean;
export function isNonNegativeInteger(v: Value): boolean;
export function isHalfInteger(v: Value): boolean;       // load-bearing for R1 priority-class C
```

These are pure predicates over the cas-core `Value` AST; no new pattern-
matcher infrastructure required. I6b ships independently of I6a (vocab
amendment) and I4 (the rules that use the helpers).

### Decision 7 — Wire tool surface (extend `tools/special-eval`)

The `tools/special-eval` wire tool (ADR-0040 §Decision 7) extends its
per-head dispatch table:

```ts
// tools/special-eval/tool.ts (extension; T2 bead unno):
//   --head=BesselJ | BesselY | BesselI | BesselK
//   --nu=<value>      // NEW for 2-arg heads
//   --re=<value>      // z real part
//   --im=<value>      // z imaginary part (default 0)
//   --precision=<int> // standard flag; ≤53 routes float64, >53 routes arb-prec
//   --scaled          // optional boolean for I and K only (selects besselIScaled / besselKScaled)
```

Per-output tier conditioning per ADR-0040 §Decision 9: `--precision≤53` →
`numerical: true` output (platform fingerprint recorded); `--precision>53` →
`arbprec: true` output (cross-platform deterministic). The mutex
workaround from Erf bead `gp75` applies until that ADR amendment lands.

The wire tool's input schema for 2-arg heads accepts both flag form
(`--nu=2 --re=1.23 --im=0`) and JSON-on-stdin form. The 1-arg legacy form
(Erf) remains supported via Erf's existing dispatch entries — no breakage.

### Decision 8 — Oracle hierarchy + cross-validation discipline (per R5)

| Tier | Oracles | Coverage | Use |
|---|---|---|---|
| **Gold** | Wolfram Mathematica 14.3 + mpmath 1.3.0 + **Arb (FLINT 3.0+) via python-flint** | All 24 cells (4 heads × 3 ν-classes × {real, complex}) | Arb-prec deep masters at 50+ decimals. Three-way independent agreement is the cross-validation baseline. **Arb closes the silver-tier complex arb-prec gap** that Erf left open — this matters more for Bessel than for Erf because Bessel has 12 complex cells vs Erf's 1. Install: `sudo apt install libflint-dev && pip install --user --break-system-packages python-flint` (Ubuntu 24.04; FLINT 3.0+ ships Arb merged in — the Erf-era `libflint-arb-dev` package is stale). |
| **Silver** | Boost.Math 1.83 `cpp_bin_float<50>` | 12 real cells (Boost has no `std::complex<cpp_bin_float<N>>` per Erf R5 §1; Y_ν uses `cyl_neumann` spelling not `cyl_bessel_y`) | Arb-prec real cross-check at 50 dp. |
| **Bronze** | SciPy 1.17.0 + libm + (Julia deferred) | SciPy all 24 cells (Amos under the hood); libm 4 cells (J_0/J_1/Y_0/Y_1 only) | Float64 evaluator validation; agreement target ULP-distance ≤ 2 vs mpmath truncated to float64. |

**11 landmines pinned in adapter code (R5 §6) — required reading for G2-G7
subagent prompts:**

- L1 — Wolfram input-trap (carry Erf R5 §3.1): `BesselJ[3, 1.23]` parses
  `1.23` as machine-precision double. ALWAYS use `Rational[num, den]`.
- L2 — mpmath `nstr` vs Wolfram `N[]` rounding mismatch (carry Erf R5 §3.2):
  comparator canonicalises before equality at the per-tier dp threshold.
- L_carryover — Wolfram `*^` exponent normalisation (`StringReplace[...,
  "*^" → "e"]` in the .wls batch preamble) — carries from Erf G2a.
- L3 — negative-real-ν branch convention varies per oracle (Y_ν,
  K_ν connection formulas involve `cos(νπ)` / `sin(νπ)`). Comparator
  tolerates documented convention deltas.
- L4 — Boost Y_ν tail cancellation (observed-bounded per R5 §6).
- L5 — SciPy `jv` silent underflow at large `ν + z`. Comparator flags
  result < `1e-300` as `info` severity.
- L6 — Julia SpecialFunctions Y-bug at large ν — deferred-not-installed; if
  re-considered, comparator carries the bug-tolerance band.
- L7 — **zero-crossing tolerance band**: where `J_ν(z) ≈ 0` (relative
  error blows up), G8 comparator uses absolute error within `|z - z_root| <
  0.01`. Pinned in G8 from the outset.
- L8 — integer-vs-near-integer-ν algorithm-discontinuity per oracle.
  Comparator gives this `info` severity inside the discontinuity band.
- L9 — K_ν underflow boundary (`z > 700`): G3 / G4 / G7 must emit scaled
  variants `e^z·K_ν(z)` for `|z| > 700` corpus inputs.
- L10 — I_ν overflow boundary (`z > 700`): same scaled-variant treatment.
- L11 — Wolfram trailing-noise digits at the emit-precision floor.
  Comparator truncates one digit below emit-precision for gold-gold
  comparisons.
- L_boost_yspell — Boost Y_ν is `boost::math::cyl_neumann`, NOT
  `boost::math::cyl_bessel_y`. G5 subagent prompt pins this.

Adapter shape uniform per ADR-0040 §Decision 8: TS `(input,
precision_decimals, fn) → (output, precision_actual, oracle_id,
oracle_version)`. Spawn via `spawnBun` resolver (ADR-0001). Batch mode
mandatory for Wolfram (cold-start 7.6 s / batch 1.4 s/call per R5 §1) and
recommended for Python adapters.

### Decision 9 — Per-output determinism tier (inherited from ADR-0040 §Decision 9)

`tools/special-eval` annotates `{ numerical: true, arbprec: true }`
statically; the provenance writer (`runMemoized`) checks the live output's
tier and writes the appropriate provenance fields. The runtime mutex
workaround from Erf bead `gp75` continues to apply — wrap float64 in
`BigFloat` at `prec=53` until that ADR amendment lands.

### Decision 10 — Phase ordering + per-bead claim discipline

The 36 sub-beads (31 pre-staged + 5 discovered from R1/R3/R4) under the
`zcam` epic claim in five gated phases:

1. **Phase 0 (DONE)** — R1 (cela), R2 (dn76), R3 (1272), R4 (wi4t), R5
   (gimq); this ADR (A0 = `oibh`). Plus 5 discovered: I6-prep (qt6m, P1
   gates I6), I6b (7j02, pattern primitives), BesselY-backward-dispatch
   (1xqq, P2 post-T3), BesselI-backward-dispatch (lfet, P2 post-T3),
   ADR-0040-footnote (18hv, P3 post-D1).
2. **Phase 1** — G1 corpus (qccc; orchestrator-authored); G2-G5 gold/silver
   adapters (z9fq Wolfram + g70g mpmath + qvnm SciPy + 5zxc Boost) parallel;
   G6 Julia (hx7g) closed-as-deferred per orchestrator decision; G7 Arb
   (rlg2) parallel after install; G8 cross-agreement (s2n1;
   orchestrator-authored); G9 QA gate (92db; orchestrator-authored).
   **Phase 1 GATE**: corpus + matrix complete; < 50 unexplained findings.
3. **Phase 2** — Substrate impl in 3 rounds (parallel within round):
   - **Round 1** (after I6-prep refactors the bridge API): I6a (vsvl) vocab
     + I6b (7j02) pattern primitives + I5a (rkoo) float64 dispatcher all 4
     functions.
   - **Round 2** (after Round 1 + I6a + I6b): I1a (5zkv) bigBesselJ + I1b
     (1doz) bigBesselY (real arb-prec, joint per the FLINT pattern).
   - **Round 3** (after Round 2): I2a (kml3) bigBesselI + I2b (q0wr)
     bigBesselK (real modified arb-prec, joint per Temme CF) + I4 (lrmo)
     cas-core identities + I3a (q7ty) bigCBesselJ + bigCBesselY complex.
   - **Round 4** (after Round 3): I3b (t73h) bigCBesselI + bigCBesselK
     complex (algebraic from I3a via the Amos rotation) + I6 (kgky) Meijer-G
     bridge.
   - **Phase 2 GATE**: `bun run check` green; golden-master suite green
     against Phase 1 corpus.
4. **Phase 3** — T1 (pp7j) integrate-1d; T2 (unno) special-eval; T3 (4uws)
   meijer-g closure. Parallel.
5. **Phase 4** — V1 (g5vo) verification + D1 (5zqt) docs lockstep + epic
   close.

### Decision 11 — Complex-z J/Y/I/K computed jointly (Amos rotation)

This is the single non-obvious algorithmic insight from R2 §3.3 that
**changes the substrate-bead round ordering** vs the ADR-0040 / Erf
default. The complex-Bessel substrate computes I and K first (via
direct series + modified-Hankel asymptotic), then derives J and Y
algebraically via the AMOS rotation:

```
J_ν(z) = exp(±νπi/2) · I_ν(∓iz)                  AMOS ZBESJ pattern
Y_ν(z) = ±(2i/π)·exp(±νπi/2)·K_ν(∓iz)            AMOS ZBESY pattern
                   - exp(±νπi)·J_ν(z)
H¹_ν(z) = J_ν(z) + i·Y_ν(z)                      from above
H²_ν(z) = J_ν(z) - i·Y_ν(z)                      from above
```

The substrate's complex layer therefore ships **all 4 functions together**
in Round 4 (after I3a real-Y + complex-J/Y is in place from Round 3 and
I3b adds the modified-side primitives). The original plan split complex
J/Y in Round 2 and complex I/K in Round 3 (mirroring Erf's tier split);
the R2 finding inverts this. Decision 10 above reflects the new ordering.

This is the substrate-coupling that makes Bessel a more demanding test of
the per-head pattern than Erf was. The pattern survives — the per-axis
package boundaries are unchanged, the wire surface is unchanged, the
bridge API is unchanged. Only the round ordering changes.

### Decision 12 — Zero-crossing tolerance band in the cross-agreement comparator (G8)

Where `J_ν(z) ≈ 0` (the infinite ladder of zeros along the positive real
axis), relative-error comparison between oracles is unbounded — a tiny
absolute disagreement on a near-zero value becomes a huge relative
disagreement. The G8 comparator (`bench/besselj-anchor/cross-agreement.ts`)
extends the Erf G8 comparator with a zero-crossing tolerance band:

```
if |z - z_root| < 0.01 for any z_root in zerosOf(J_nu) ∪ zerosOf(Y_nu):
    use absolute error against gold-tier value at the same tier threshold
else:
    use relative error per ADR-0040 §Decision 8 thresholds
```

`zerosOf(J_nu)` for the relevant ν is supplied by mpmath's `besseljzero`
function (pre-computed at corpus generation time and baked into the corpus
JSON; the comparator does not re-compute). For Y_ν, `besselyzero`. For
I_ν, K_ν: no real zeros — the band is N/A.

### Decision 13 — Negative-real-ν branch convention pinned

Y_ν and K_ν for non-integer negative ν are defined via the J / I
connection formulas with `cos(νπ)` / `sin(νπ)` factors (DLMF §10.2.3,
§10.27.4). For non-integer ν near an integer, the connection cancellates —
each oracle handles this differently:
- **Wolfram**: uses `Limit[]` for exactly-integer ν, formula otherwise.
- **mpmath**: cancellation-driven precision retry; can underflow at very
  small `(ν - n)`.
- **SciPy** (Cephes): explicit integer-ν shortcut; otherwise formula.

The substrate's `bigBesselY(nu, z, prec)` matches Wolfram's behaviour:
exactly-integer ν → integer-ν path; non-integer ν → connection formula
with cancellation-retry per Decision 3. The cross-agreement comparator
tolerates documented per-oracle convention deltas at non-integer ν
near-integer at `info` severity (L3 from Decision 8).

## What we will not decide here

* **Bessel-function evaluation outside the standard four (J, Y, I, K)**.
  `SphericalBesselI` and `SphericalBesselK` are deferred over the DLMF
  §10.47.7-8 `i^{(1)}` / `i^{(2)}` ambiguity (R1 Discovery A). `Kelvin
  ber/bei/ker/kei` (DLMF §10.61) and the Anger / Weber functions (DLMF
  §11.10) are out of scope.
* **Olver-uniform asymptotic + Debye large-ν asymptotic + Temme/Steed CF**.
  R2 §10 recommends these as v0.2 refinements; v0.1 ships with FLINT-pattern
  cancellation-retry ₀F₁ + Hankel asymptotic which covers all 24 cells but
  needs more cycles in the transition region `|z| ≈ ν`. Olver-uniform needs
  a `bigAiryAi` substrate we have not yet built. Debye needs a `U_k`
  polynomial generator. Temme/Steed needs the CF tooling. Filed as P3 v0.2
  follow-ups.
* **Bessel zeros as float64 substrate** (`besseljzeroFloat64`). R3 §0.3
  follow-up #2 recommends Boost's `bessel_jy_zero.hpp` (McMahon + Newton)
  if T9 corpus tier needs in-substrate computation. Currently the corpus
  uses mpmath's `besseljzero` at generation time and bakes zeros into
  `corpus.json`; in-substrate computation is not required for v0.1.
* **K_0 / K_1 Holoborodko-style refit** to ≤ 1.5 ULP. R3 §0.3 follow-up #1.
  Cephes ports ship at ≤ 5 ULP, adequate for bronze tier. P3 v0.2.
* **Julia SpecialFunctions.jl oracle adapter**. Deferred per orchestrator
  decision based on R5 §7 — Julia's Bessel goes through Amos internally
  (same as SciPy); no algorithmic diversity gained. Re-open if v0.2 wants
  additional bronze-tier voice.
* **Pretty-printer for spherical-Bessel and Hankel heads**. Same precedent
  as ADR-0040 — no general human-readable pretty-printer exists for the
  special-function vocabulary today. Lands when a consumer needs it.
* **`SphericalBesselI` / `SphericalBesselK` vocab admission**. Deferred per
  R1 Discovery A (DLMF i^{(1)} vs i^{(2)} ambiguity). Filed as P3.

## Why these choices

### Substrate layering unchanged from ADR-0040 — by design

This ADR's central claim is that the per-head substrate pattern
**generalises without architectural change**. The five-axis package split
(cas-core / bigfloat / quadrature / meijer-core / contract) is preserved
byte-for-byte. The per-head landing sub-directories
(`bigfloat/src/special-funcs/`, etc.) are reused exactly. The wire surface
(`tools/special-eval` with `--head=<name>` + `--precision=<int>` dispatch)
is reused exactly. The only ADR-0040 surface that changes is the bridge
API (`zInverse` → `argsInverse`) — a mechanical 3-site rename, not an
architectural shift. **The pattern is robust.**

### `z_c_Hankel(p) = p/2` — linear, not sqrt

R2's load-bearing crossover. Erf's `x_c(p) = √(p · ln 2)` derived from
Borel-form term ratio `z²/(n + 1/2)`; Bessel's derives from the much
slower-shrinking ratio `1/(8|z|)` per Hankel-asymptotic step. At `p =
196` (50 dps), `x_c_Erf ≈ 11.0`; `z_c_Hankel_Bessel ≈ 98`. Bessel needs
**an order of magnitude larger** `|z|` to enter the asymptotic regime. This
ripples into corpus design (T3 large-z tier must reach |z| ≈ 200-300 at
50 dps to validate the asymptotic path) and substrate work (the
cancellation-retry ₀F₁ band is much wider than Erf's series band).

### Complex-Bessel via Amos rotation — not separate complex algorithms per function

Computing complex `J_ν(z)` via independent series + Hankel asymptotic
(the naive parallel to the real path) costs ~4× the work of computing
`I_ν(∓iz)` once and rotating. AMOS's 40-year proven choice; FLINT's pin
identical. Substrate decision: ship the modified-Bessel complex primitives
first (I3b's `bigCBesselI` / `bigCBesselK`) then derive J / Y / H¹ / H²
via the rotation in I3a / I6 / wherever it's needed. This is the
Round 3 → Round 4 ordering Decision 10 reflects.

### `argsInverse` rename — arity-agnostic closure

Erf's `zInverse: () => Value` was 1-arg by construction. Bessel needs to
recover both `ν` and `z`. The cheapest API extension that handles both is
to make the closure return `readonly Value[]` (R4 §C Design A). Erf
becomes `argsInverse() => [origZ]`; Bessel becomes `[origNu, origZ]`;
future heads (Whittaker, Lerch) become `[arg1, arg2, arg3]` without
further bridge-API change. Filed as bead `qt6m` (I6-prep) that gates I6.

### 12-cell G-form table collapses to 4 forms — bridge layer separated from ν-class branching

R4's load-bearing finding. Naive intuition: integer ν, half-integer ν,
general ν need different Meijer-G representations. Actual: the canonical
G-form is uniform in ν (the slot tuples `[ν/2]`, `[-ν/2]` etc. carry ν
straight through). ν-class-specific reductions live in `cas-simplify` (the
R1 priority-class C half-integer closures, the parity rules, etc.) — not
in the bridge. The bridge is **purely a syntactic transformer between
named-head AST and G-function AST**; the simplifier is what knows about
ν-class structure. This separation of concerns is exactly the ADR-0040
substrate-axis discipline applied recursively.

### Verbatim port discipline pinned at §0.0 of R3 — Bessel is harder than Erf

Erf shipped 1 SunPro port (`erf-float64.ts`, 1101 LOC). Bessel ships 6
verbatim ports across 8 entry points × 4-6 algorithm pieces each. The
"port C / Fortran source verbatim, don't re-derive from the paper"
discipline (worklog 142 friction #11) matters more here. R3 §0.0 pins
the discipline at the top of its artefact for exactly this reason; I5a's
subagent prompt must cite §0.0 explicitly.

### Per-output tier dispatch carries the `gp75` workaround

ADR-0040 §Decision 9 documented the runtime-mutex collision between
`{numerical: true, arbprec: true}`. The Erf T2 workaround (declare
`arbprec: true` only, wrap float64 in BigFloat at `prec=53`) loses
bronze-tier platform fingerprint but is the v0.1 path until the ADR
amendment in bead `gp75` (P2) lands. This ADR inherits the workaround
verbatim — no Bessel-specific change.

### Oracle install gating handled in Phase 0, not Phase 1

R5's STRONG Arb-install recommendation surfaced before Phase 1
dispatched, so G7 (Arb adapter) ships in v0.1 rather than being filed as
deferred-on-install. This is the Erf-bench-discipline lesson applied:
landmines discovered in research land BEFORE adapters dispatch, not as
mid-Phase-1 surprises. The Julia-deferred decision was made on the same
basis (R5 §7 quantified the algorithmic redundancy with SciPy; the
diversity gain wasn't worth the install + adapter cost).

### Pattern primitives separated from vocab amendments

R1 Discovery A (vocab heads) and Discovery B (pattern predicates) are
distinct concerns:
- Vocab admission requires an ADR-0023 amendment and changes the
  `SPECIAL_FUNCTION_HEADS` table + arity entries + diff dispatcher.
- Pattern primitives extend `cas-core/src/pattern.ts` with pure
  predicates; no ADR change, no vocab change.

I6a (vsvl) ships vocab; I6b (7j02) ships predicates; I4 (lrmo) depends on
both. Splitting the work surfaces each concern cleanly and lets a single
subagent claim each. Erf had only the vocab axis (I6a m114 admitted Erfi);
Bessel adds the predicate axis as a clean parallel.

## Acceptance

This ADR is *accepted* when:

- ADR file written (this document).
- Bead `oibh` (A0) closed with "ADR-0041 landed; Phase 1 unblocked"
  notes referencing this file.
- Phase 1 beads (G1-G9, except G6 already closed-as-deferred) lose their
  `blocked-by:oibh` dependency edge (verified via `bd ready` listing G1 as
  claimable).
- Phase 2 prep beads (I6-prep qt6m + I6a vsvl + I6b 7j02 + I5a rkoo + I4
  lrmo + I6 kgky) lose their `blocked-by:oibh` edge.

The *substrate* this ADR pins is implemented when:

- All Phase 2 beads (I6-prep, I6a, I6b, I1a, I1b, I2a, I2b, I3a, I3b, I4,
  I5a, I6) closed.
- `bun run check` green.
- Golden-master suite (Phase 1 G2-G7) byte-identical against
  `@workbench/bigfloat::bigBessel*` at 50 and 200 decimals (gold tier:
  Wolfram + mpmath + Arb three-way agreement); byte-identical at 50
  decimals against Boost `cpp_bin_float<50>` for real (silver tier); ULP-
  distance ≤ 2 vs SciPy / libm / Amos for `besselFloat64*` (bronze tier).
- Property tests (V1) green with mutation-proving completed for each
  invariant (8 Erf-inherited invariants + 2 Bessel-specific: Wronskian
  `J_ν Y_{ν+1} - J_{ν+1} Y_ν = -2/(πz)` for real positive z, ν; integer-ν
  parity `J_{-n} = (-1)^n J_n`).
- `tools/special-eval --head=BesselJ --nu=3 --re=2 --im=0 --precision=200`
  returns a 200-bit BigFloat byte-identical to Wolfram's `N[BesselJ[3,
  Rational[2,1]], 60]` truncated to 200 bits.
- `tools/special-eval --head=BesselK --nu=0 --re=10 --precision=200`
  matches mpmath at 50 dp; `tools/special-eval --head=BesselI --nu=1 --re=5
  --precision=53 --scaled` returns `e^{-5}·I_1(5)` matching SciPy `ive(1,
  5)` to ≤ 2 ULP.
- Meijer-G bridge round-trip byte-identical for BesselJ / BesselY /
  BesselI / BesselK against the canonical G-forms in Decision 5.

The *pattern* this ADR validates as generalising:

- All five ADR-0040 substrate axes (cas-core / bigfloat / quadrature /
  meijer-core / wire) accommodated Bessel via per-head sister files
  without architectural change.
- The bridge API extension (`zInverse` → `argsInverse`) is the only
  ADR-0040 surface that changed, and the rename is mechanical with
  byte-identical Erf compatibility.
- The next head (Whittaker, ParabolicCylinder, Legendre family,
  LerchPhi — beads `zmfs`, `5e1i`, `4eze`, `h6o1` already filed) will
  reuse the same shape without further ADR.

When all of the above hold, the Bessel family is the reference
implementation the workbench's "world's best Bessel" claim rests on, and
the per-head substrate pattern is validated as the canonical way to add
any special function to the workbench.
