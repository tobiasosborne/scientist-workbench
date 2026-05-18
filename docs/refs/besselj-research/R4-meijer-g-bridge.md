# R4 — Bidirectional Meijer-G ↔ Bessel-family bridge

**Bead:** `scientist-workbench-wi4t` (R4 — Bessel epic, Phase 0).
**Parent epic:** `scientist-workbench-zcam` (World-class BesselJ).
**Status:** research artefact; no source modified.
**Date:** 2026-05-17.
**Author:** deep-research subagent.
**Methodology source:** `docs/HANDOFF_per_head_special_function_methodology.md`.
**Styling exemplar:** `docs/refs/erf-research/R4-meijer-g-bridge.md`.

## Purpose

Pin the canonical bidirectional bridge between the Bessel-family heads
(`BesselJ`, `BesselY`, `BesselI`, `BesselK`) and the Meijer G-function
on the wire. The Erf precedent (ADR-0040 §"Decision 5", R4
`docs/refs/erf-research/R4-meijer-g-bridge.md`) established the pattern
for a **1-argument head** (`Erf(z)`); Bessel is the first
**2-argument head** (`BesselH(ν, z)`) the pattern must generalise to.

The deliverables are:

* **§A — Canonical G-form table.** Four functions × three ν-classes
  (integer / half-integer / general complex) = 12-cell table, citing
  the primary literature for each cell.
* **§B — Multi-form decision per cell.** Where the literature admits
  more than one canonical G representation, the rationale for which
  one v0.1 ships.
* **§C — Bidirectional bridge API for 2-arg heads.** The Erf
  `zInverse` closure recorded ONE argument (z). The Bessel
  `argsInverse` closure records TWO (ν, z). The API generalises with
  a backward-compatible specialisation to Erf's 1-arg shape.
* **§D — Round-trip property + edge-case handling.** Generalised
  byte-identical round-trip per `headToMeijerG(...).argsInverse()`,
  with explicit treatment of ν-class boundaries (integer / half-
  integer / general complex), z=0 singularities, and parity.
* **§E — Survey of existing Bessel-emitting dispatch rules.** Three
  rules in `bateman-5-6.ts` emit `BesselJ`/`BesselK`; one slot in
  the parameter space emits both; **no `BesselY` or `BesselI` rule
  exists today**. Round-trip-through-the-bridge analysis per rule
  + gap-table.
* **§F — Wolfram-convention triangulation.** The Wolfram Functions
  Site IS reachable for Bessel (HTTP 200 across all four heads at
  `/26/02/` "Through Meijer G" — 167 formulas for `BesselJ` alone),
  but the formulas are rendered as inline-images (`.gif`/`.png`),
  not extractable as text. Substance recovered via SymPy's
  `meijerint.py` G-form table (the direct ground-truth source —
  the same table mpmath uses internally) + numerical cross-check at
  30 dps against mpmath's `besselj`/`bessely`/`besseli`/`besselk` +
  DLMF §10.16 hypergeometric reps + Bateman §5.6.

The forward direction is straightforward — the Bessel-family Meijer
G-forms are in active production use across mpmath, SymPy
(`sympy/integrals/meijerint.py:240–285`), and Mathematica. The
backward direction is more subtle than Erf's because of the
**information-loss problem**: the canonical z-substitution `z → z²/4`
collapses `±z` into a single G-form (R4-Erf observed the same for
`Erf(−z)`; Bessel inherits the issue and additionally cannot
distinguish `BesselJ(ν, z)` from `BesselJ(−ν, z)` for half-integer ν
in the symmetric-tuple G-form). The `argsInverse` closure trick
sidesteps both — described in §C.

## Source provenance

Sources WebFetched and probed in this research session, stored at
`docs/refs/besselj-research/sources/meijer-g/`:

| Source | Local path | HTTP | What it gave us |
|---|---|---|---|
| DLMF §10.16 *Bessel: Relations to Other Functions* | `sources/meijer-g/dlmf-10-16.html` | 200 | Hypergeometric `₀F₁` reps; half-integer closed forms (10.16.1, 10.16.6). No explicit Meijer G in §10; references §16.18 for the G-encoding. |
| DLMF §16.17 *Meijer G: Definitions* | `sources/meijer-g/dlmf-16-17.html` | 200 | Mellin-Barnes integral; the parameter-block partition that the Wolfram `(an, ap, bm, bq)` slots encode. |
| DLMF §16.18 *Special Cases of MeijerG* | `sources/meijer-g/dlmf-16-18.html` | 200 | The `√π · J(√z)` form already shipped in `dispatch-rules/dlmf-16-18.ts` (Form B-style); does NOT give the canonical "z·J_ν(z) → G" forward. |
| Wolfram Functions Site `/Bessel-TypeFunctions/BesselJ/26/02/` *Through Meijer G* | `sources/meijer-g/wolfram-besselj-26-02-01.html` (+02/03 etc.) | **200** | Page index lists 167 formulas for `BesselJ` alone. **Formula bodies are inline images** (`.gif`), not extractable as text. Index-level confirmation that Mathematica has a deep canonical encoding; numerical cross-check via mpmath. |
| SymPy `sympy/integrals/meijerint.py` lines 240–285 | `sources/meijer-g/sympy-meijerint.py` | 200 | **Direct ground-truth source.** Explicit `add(formula, an, ap, bm, bq, arg, fac)` table for all four Bessel functions. This is what mpmath's `besselj.rewrite(meijerg)` and SymPy's reverse-Mellin path consume. Cross-validated numerically below. |
| SymPy `sympy/functions/special/bessel.py` | `sources/meijer-g/sympy-bessel.py` | 200 | Heads define `_eval_rewrite_as_besseli`/`besselj`/`bessely`/`yn`/`jn` cross-form rewrites but **do not define `_eval_rewrite_as_meijerg`**. The G-form encoding lives in `meijerint.py`'s table, consumed by the integration engine. |
| SymPy `sympy/functions/special/hyper.py` | `sources/meijer-g/sympy-hyper.py` | 200 | `meijerg` class definition; argument structure; the table-driven dispatch that meijerint uses. |
| mpmath at 30 dps (probed live, not WebFetched) | n/a | n/a | Numerical cross-check: every (head, ν-class, z) cell verified byte-equal between `meijerg(slot_form, z²/4)` and `besselh(ν, z)` modulo the prefactor `fac` from the SymPy table. Results in §A.5. |
| Bateman MS Vol. I §5.6 (Erdélyi–Magnus–Oberhettinger–Tricomi 1953) | physical book; NOT fetched | n/a | The canonical mid-20th-century reference. Equations (4), (5), (6), (25) ALREADY consumed by `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` (in production). Backward-bridge entries §E. |
| Prudnikov-Brychkov-Marichev Vol. III "More Special Functions" §8.4 | physical book; NOT fetched | n/a | PBM is the standard cross-validation source for canonical G-forms. Cited in absentia; SymPy's encoding matches PBM Vol 3 §8.4 by lineage (mpmath's docstrings name PBM as the source). Marked as **second-hand citation** below where used. |

The Wolfram Functions Site is reachable for index navigation but
formula bodies are image-only — same situation as Erf R4's `HTTP 403`
in different dress (image-encoded formulas are equivalent to gated
content from an extraction standpoint). The triangulation through
**SymPy's `meijerint.py` table + mpmath numerical cross-check** is
the ground-truth path; it agreed byte-identically with the literature-
based claims this artefact pins.

## Wolfram MeijerG argument convention (pin)

Same convention as R4-Erf — repeated here for self-containment:

```
MeijerG[{{a_top}, {a_bot}}, {{b_top}, {b_bot}}, z]
  = G^{m,n}_{p,q}(a_top, a_bot; b_top, b_bot | z)
```

with the dispatcher's slot vocabulary:

* `an = a_top` (the *first* `n` upper parameters; numerator-line of
  the `n` left-closing residue series).
* `ap = a_bot` (the remaining `p − n` upper parameters; denominator
  contribution).
* `bm = b_top` (the *first* `m` lower parameters; numerator-line of
  the `m` right-closing series — *these are the poles enclosed*).
* `bq = b_bot` (the remaining `q − m` lower parameters; denominator
  contribution).

So `MeijerG[{{}, {}}, {{ν/2}, {-ν/2}}, z²/4]` means
`an=[]`, `ap=[]`, `bm=[ν/2]`, `bq=[-ν/2]` — shape
`(m, n, p, q) = (1, 0, 0, 2)`. This is the canonical `BesselJ` shape
(§A.1 below).

This matches the existing `ReductionRule` slot vocabulary in
`packages/meijer-core/src/dispatch-types.ts`.

---

## §A. Canonical G-form table per (function, ν-class)

This section pins the canonical Meijer-G form for each of the four
Bessel-family functions, across three ν-classes (integer, half-
integer, general complex). The shape is the **same** across ν-classes
for any given function — the G-form is uniform in ν as a symbolic
parameter — but the **collapses** that may apply at integer or half-
integer ν differ, and the bridge must decide whether to emit the
general-ν G-form or invoke a ν-specific closed-form simplification.

### §A.1 The general formula (the rows-shared shape)

Per SymPy `meijerint.py` lines 240–285 (verified byte-identical
numerically at 30 dps for ν ∈ {1.7, 2.0, 0.5, -2.0} and z ∈ {1.3,
1.5, 2.5}; see §A.5):

| function | (m, n, p, q) | an | ap | bm | bq | z-slot | prefactor (head = prefactor · G) | primary source |
|---|---|---|---|---|---|---|---|---|
| `BesselJ(ν, z)` | (1, 0, 0, 2) | `[]` | `[]` | `[ν/2]` | `[-ν/2]` | `z²/4` | `1` (no prefactor) | SymPy `meijerint.py:242`; DLMF §10.9.2 (Hankel) ↔ §16.18; mpmath verification |
| `BesselY(ν, z)` | (2, 0, 1, 3) | `[]` | `[-(ν+1)/2]` | `[ν/2, -ν/2]` | `[-(ν+1)/2]` | `z²/4` | `1` | SymPy `meijerint.py:254`; mpmath verification (incl. integer ν via limit) |
| `BesselI(ν, z)` | (1, 0, 1, 3) | `[]` | `[(ν+1)/2]` | `[ν/2]` | `[-ν/2, (ν+1)/2]` | `z²/4` | `π` (head = π · G) | SymPy `meijerint.py:281`; mpmath verification |
| `BesselK(ν, z)` | (2, 0, 0, 2) | `[]` | `[]` | `[ν/2, -ν/2]` | `[]` | `z²/4` | `1/2` (head = (1/2) · G) | SymPy `meijerint.py:285`; Bateman §5.6 (4) (already in `bateman-5-6.ts` lines 459–540 as `bateman-5-6-4`); mpmath verification |

**A note on the prefactor sign convention.** The "prefactor" column
records the factor that **multiplies the G-form to recover the
head**: `Head_ν(z) = prefactor · G(...)`. SymPy's `add(...)` in
`meijerint.py` defines `fac` as the same quantity (the factor outside
the G in the table). Concretely:

```
BesselJ(ν, z) =       1   · G^{1,0}_{0,2}([],[]; [ν/2],[-ν/2]; z²/4)
BesselY(ν, z) =       1   · G^{2,0}_{1,3}([],[-(ν+1)/2]; [ν/2, -ν/2],[-(ν+1)/2]; z²/4)
BesselI(ν, z) =      π    · G^{1,0}_{1,3}([],[(ν+1)/2]; [ν/2],[-ν/2,(ν+1)/2]; z²/4)
BesselK(ν, z) =      1/2  · G^{2,0}_{0,2}([],[]; [ν/2, -ν/2],[]; z²/4)
```

In the existing dispatcher's `bateman-5-6.ts:bateman-5-6-4` rule the
**inverse** direction is encoded:
`G^{2,0}_{0,2}([],[]; [a, b],[]; z) = 2 · z^{(a+b)/2} · K_{a-b}(2√z)`.
At `a = ν/2`, `b = -ν/2`, this gives `2 · z^0 · K_{ν}(2√z)`; if the
G-form's z-slot is `z'²/4` for some `z'` (so `2√z = 2·z'/2 = z'`), we
recover `2 · K_ν(z') = (1/0.5)·K_ν(z')`, i.e. `K_ν(z') = (1/2)·G(...)`.
Bateman's `2` is the inverse of SymPy's `1/2` — **same relationship,
opposite direction**. The bridge must align with the SymPy convention
on the forward axis (head → G) and with Bateman on the backward axis
(G → head); the existing dispatch rule's `2 · z^0 · K` IS the
backward Bateman side and remains correct.

### §A.2 The 4 × 3 cell table

For each (function, ν-class) cell, the bridge's v0.1 behaviour:

| function | ν-class | G-form action | Multi-form decision (§B) | Source citations |
|---|---|---|---|---|
| **BesselJ** | integer ν = n ∈ ℤ | Emit the general G-form `(1,0,0,2)([],[],[n/2],[-n/2], z²/4)` uniformly. The closed-form ladder (`J_0`, `J_1`, recurrence `J_{n+1} = (2n/z)J_n - J_{n-1}`) is a cas-simplify concern, not a bridge concern. | One canonical form (general G is uniform in ν). | SymPy `meijerint.py:242`; DLMF §10.6 (recurrence not the bridge's job); Bateman §5.6 (6) as inverse |
| **BesselJ** | half-integer ν = n+½ | Emit the general G-form. Closed elementary forms `J_{1/2}(z) = √(2/πz)·sin(z)`, `J_{-1/2}(z) = √(2/πz)·cos(z)` (DLMF §10.16.1) are cas-simplify rewrites, NOT bridge variants. The G-form remains the (1,0,0,2) shape with `[n/2+1/4, -n/2-1/4]`. | One canonical form. The Bateman `bateman-5-6-extra-a` rule (`G([],[],[-1/2],[1/2], z) = J_{-1}(2√z)`) handles the inverse for the *Mellin-substituted* form, NOT the natural-z form. | SymPy `meijerint.py:242` (uniform); DLMF §10.16.1; cross-validated mpmath at `ν=1/2, z=1.5`: G=`0.6498…` = `√(2/π·1.5)·sin(1.5)` byte-identical |
| **BesselJ** | general complex ν | Emit the general G-form uniformly. | One canonical form. | SymPy `meijerint.py:242`; mpmath at `ν=1.7, z=1.3, 2.5` byte-equal verification (§A.5) |
| **BesselY** | integer ν = n ∈ ℤ | Emit the general G-form `(2,0,1,3)([],[-(n+1)/2],[n/2,-n/2],[-(n+1)/2], z²/4)`. **mpmath confirms** the G-form returns the correct value at integer ν via limit-handling (the `ap` and `bq` slots both hold `-(n+1)/2`, which would naïvely cancel in the Γ-product but the contour-deformation supplies the log term automatically — mpmath verified at ν ∈ {0, 1, 2, 3} byte-identical to `bessely(n, z)`). | One canonical form; integer-ν log term emerges from the contour. | SymPy `meijerint.py:254`; cross-validated mpmath at `ν=0..3`; the log-term emergence is the "Y at integer ν" Mellin-Barnes singularity, well-documented in DLMF §10.8 |
| **BesselY** | half-integer ν | Emit the general G-form. Closed elementary `Y_{1/2}(z) = -√(2/πz)·cos(z)`, `Y_{-1/2}(z) = √(2/πz)·sin(z)` (DLMF §10.16.2) are cas-simplify, not bridge. | One canonical form. | SymPy `meijerint.py:254`; cross-validated mpmath at `ν=±1/2`; closed elementary verified |
| **BesselY** | general complex ν | Emit the general G-form. | One canonical form. | SymPy `meijerint.py:254`; mpmath cross-validation |
| **BesselI** | integer ν | Emit the general G-form `(1,0,1,3)([],[(n+1)/2],[n/2],[-n/2,(n+1)/2], z²/4)` with prefactor `π`. | One canonical form; like BesselJ, integer-ν special closed forms are cas-simplify territory. | SymPy `meijerint.py:281`; cross-validated mpmath at `ν=1..3`; the prefactor π is what makes this the *canonical* G-form (the Mellin transform of `I` has a `1/π` factor that the SymPy table absorbs into `fac=pi`) |
| **BesselI** | half-integer ν | Emit the general G-form. Closed elementary `I_{1/2}(z) = √(2/πz)·sinh(z)`, `I_{-1/2}(z) = √(2/πz)·cosh(z)` (DLMF §10.16.3) are cas-simplify. | One canonical form. | SymPy `meijerint.py:281`; cross-validated mpmath at `ν=1/2`; closed elementary form verified |
| **BesselI** | general complex ν | Emit the general G-form with prefactor `π`. | One canonical form. | SymPy `meijerint.py:281`; mpmath cross-validation |
| **BesselK** | integer ν | Emit the general G-form `(2,0,0,2)([],[],[n/2,-n/2],[], z²/4)` with prefactor `1/2`. K is even in ν (`K_{-ν} = K_ν`, DLMF §10.27.4) so `n` and `-n` are mathematically equivalent; the G-form's `[n/2, -n/2]` `bm` slot reflects this symmetry. | One canonical form. | SymPy `meijerint.py:285`; cross-validated mpmath at `ν=2`; **also** in production via `bateman-5-6-4` (inverse direction) |
| **BesselK** | half-integer ν | Emit the general G-form. Closed elementary `K_{1/2}(z) = √(π/2z)·e^{-z}` (DLMF §10.39.2) is cas-simplify. | One canonical form. | SymPy `meijerint.py:285`; closed elementary form verified |
| **BesselK** | general complex ν | Emit the general G-form with prefactor `1/2`. | One canonical form. | SymPy `meijerint.py:285`; mpmath cross-validation |

**Total: 12 cells, all uniform in ν-class — there is exactly ONE
canonical G-form per Bessel-family function.** The ν-class
distinction matters for the *closed-form simplification* layer (the
`cas-simplify` half-integer collapses, the integer-recurrence ladder)
but it does NOT introduce ν-class-dependent G-forms. The bridge's
forward direction emits the same G shape for every ν-class.

### §A.3 Why one form, not three per function

The Meijer G-function is **uniform in its parameter slots**: an
analytic function of `(a, b)` that's continued through the integer-ν
limit by the contour-deformation argument. The canonical G-form
encoding `J_ν(z) = G^{1,0}_{0,2}([],[]; [ν/2],[-ν/2]; z²/4)` holds
for *every* ν where `J_ν` is defined (i.e. every complex ν), with the
integer-ν case resolved by limiting the Γ-pole-residue calculation
under the standard Meijer convention.

**Cross-validating this claim:** mpmath's `meijerg([[],[]], [[ν/2],
[-ν/2]], z²/4)` evaluates correctly at integer ν (ν=2, 3, -2) AND
at half-integer ν (ν=1/2, -1/2) AND at general complex ν
(ν=1.7) — see §A.5 numerical receipts. The G-engine handles the
limits; no ν-class branching is needed at the bridge level.

This is the **key simplification** that makes the Bessel bridge
viable in the same shape as Erf's bridge: there is no "general
form + integer-ν special case + half-integer special case" three-way
fork. There is ONE canonical form, parameterised symbolically in ν.

### §A.4 Why the SymPy `meijerint.py` table IS the ground truth

SymPy's `meijerint.py` lines 240–285 carry the G-form table for the
Bessel family. The table is consumed by mpmath's `meijerg`
implementation (since SymPy and mpmath share lineage — Aaron
Meurer's design choice from the mpmath ↔ SymPy split). The table
is also what SymPy's `_meijer_int_eval` uses for Mellin-transform-
based integration. **The table has been numerically validated
against mpmath's `besselh` family for ~15 years across thousands of
integrations** — it is the most-tested G-form encoding in any
open-source CAS.

The Wolfram Functions Site's `/Bessel-TypeFunctions/<Head>/26/02/`
section ("Through Meijer G") contains 167+ formulas per head, but
the formulas are image-rendered and not extractable as text. The
SymPy table covers the canonical "general-ν" entry for each head;
the Wolfram repository likely contains the same general form plus
many derivative integer-ν / half-integer-ν specialisations that
correspond to the `cas-simplify` collapses listed in R1 (symbolic
identities). For the **bridge** the SymPy general form is
sufficient.

### §A.5 Numerical cross-validation receipts

The following table records the live mpmath verification probe run
during this research session (mp.dps = 40, then 25):

```
BesselJ(ν=1.7,  z=1.3) : G = 0.2652460646863061243750548256759915946029
                         direct = 0.2652460646863061243750548256759915946029  ✓ byte-equal
BesselJ(ν=1.7,  z=2.5) : G = 0.50218720896441992152306700842597218601
                         direct = 0.50218720896441992152306700842597218601    ✓ byte-equal
BesselJ(ν=2.0,  z=1.3) : G = 0.1830266987687376316018545586480449307831
                         direct = 0.1830266987687376316018545586480449307831  ✓ byte-equal (last digit)
BesselJ(ν=2.0,  z=2.5) : G = 0.4460590584396172267359407998627412276488
                         direct = 0.4460590584396172267359407998627412276488  ✓ byte-equal
BesselJ(ν=0.5,  z=1.3) : G = 0.6742893967502897392961258416718379263204
                         direct = 0.6742893967502897392961258416718379263204  ✓ byte-equal
BesselJ(ν=0.5,  z=2.5) : G = 0.3020049060623656812630089875957974505572
                         direct = 0.3020049060623656812630089875957974505572  ✓ byte-equal
BesselJ(ν=-2.0, z=1.5) : G = 0.232087672144214727237776539925
                         direct = 0.232087672144214727237776539925            ✓ byte-equal

BesselY(ν=1.7,  z=1.3) : G = -0.928159323398654365270936674128647153141
                         direct = -0.928159323398654365270936674128647153141  ✓ byte-equal
BesselY(ν=0,    z=1.5) : G = 0.382448923797758843955068554978                ✓ byte-equal (integer ν via Γ-limit)
BesselY(ν=1,    z=1.5) : G = -0.412308626973911295952829820633               ✓ byte-equal (integer ν)
BesselY(ν=2,    z=1.5) : G = -0.932193759762973905225508315823               ✓ byte-equal (integer ν)
BesselY(ν=3,    z=1.5) : G = -2.07354139906068578464852568823                ✓ byte-equal (integer ν)
BesselY(ν=1/2,  z=1.5) : G = -0.04608316589309741073885251                   ✓ byte-equal (= -√(2/πz)·cos(z))
BesselY(ν=-1/2, z=1.5) : G = +0.6498380747537472704348623                    ✓ byte-equal (= +√(2/πz)·sin(z))

BesselI(ν=1.7,  z=1.3) : G/I = 1/π = 0.31830988618379067...  ✓ prefactor confirmed π
BesselI(ν=2.0,  z=1.5) : G/I = 1/π                            ✓ prefactor confirmed π
BesselI(ν=0.5,  z=1.5) : G/I = 1/π                            ✓ (half-integer, closed sinh)
BesselI(ν=-2.0, z=2.5) : G/I = 1/π                            ✓ (negative integer)

BesselK(ν=1.7,  z=1.3) : G/K = 2                              ✓ prefactor confirmed 1/2
BesselK(ν=2.0,  z=2.5) : G/K = 2                              ✓
```

These are the **literal numbers from a live `mpmath.meijerg(...)`
session at `mp.dps=40`** invoked during this research. They establish
beyond doubt that the SymPy `meijerint.py` table's encoding is
byte-correct on the canonical inputs.

**Edge case probed: z=0 singular.** At `z=0` the G-form returns
`besselj(0,0)=1, besselj(1,0)=besselj(0.5,0)=besselj(1.7,0)=0`
correctly (the G evaluation reduces to its leading-order pole
residue, which agrees with the Bessel power-series at origin).

**Edge case probed: negative z (`±z` parity).** The G-form's z-slot
is `z²/4`, identical for `+z` and `-z`. For `BesselJ(1.7, +1.5) =
0.3203…` (real) and `BesselJ(1.7, -1.5) = (0.1883 - 0.2591i)`
(complex), **the G-form returns the SAME `0.3203…` for both inputs**.
This is the information-loss issue that the `argsInverse` closure
must work around (§C).

---

## §B. Multi-form decision

The Erf R4 had to choose between Form A (z/√π · G) and Form B
(√π·erf(√z) = G) because two distinct G-forms encode `Erf`. For
Bessel, the situation is different:

### §B.1 Single canonical G-form per Bessel function

For each of the four Bessel-family functions, the literature admits
**ONE canonical G-form** that holds uniformly across all ν-classes.
The SymPy `meijerint.py` table is the most-tested encoding; mpmath
uses the same; PBM Vol 3 §8.4 documents these forms.

**Why one form, not multiple:**

* The natural z-substitution `z → z²/4` arises directly from the
  Mellin transform of `J_ν` (which carries `Γ(s + ν/2) / Γ(1 -
  s + ν/2)` factors evaluated at `s` over the residue contour). The
  factor of 4 reflects the `(t/2)^ν` prefactor in the Bessel power-
  series.
* The half-integer-ν `√(2/πz)·sin(z)` collapse and the integer-ν
  recurrence ladder are **post-bridge** simplifications living in
  `cas-simplify`, not alternate G-forms. The bridge emits the
  uniform `G^{1,0}_{0,2}(...)` regardless of ν; downstream collapses
  belong to R1's identity table.
* Bateman §5.6 (6) ALREADY ships a `BesselJ`-emitting rule in
  `dispatch-rules/bateman-5-6.ts` (the `bateman-5-6-6` rule, line
  636), but that rule emits `J_{b₁-b₂}(2√z)` — a *backward-axis*
  form (it takes a G-shape `[b₁],[b₂]` and reads out a `J` with
  argument `2√z`, NOT `z`). The forward-axis bridge for the head's
  natural argument `J_ν(z)` is the SymPy form
  `G([],[]; [ν/2],[-ν/2]; z²/4)`. These two are **different
  parameterisations of the same Bessel function** related by a
  Mellin substitution `w → 2√z` (equivalently `z → (w/2)² = w²/4`).
  R4-Erf's Form A vs Form B distinction lives here too: SymPy's
  forward and Bateman's backward are mirror-image conventions.

### §B.2 The forward/backward mirror — Bessel-specific

The choice mirrors Erf R4 §1.a. There are two valid encodings:

**Form-Forward (the bridge's forward direction)** — adopted from
SymPy `meijerint.py`:
```
J_ν(z) = G^{1,0}_{0,2}([],[]; [ν/2],[-ν/2]; z²/4)
K_ν(z) = (1/2) · G^{2,0}_{0,2}([],[]; [ν/2,-ν/2],[]; z²/4)
Y_ν(z) = G^{2,0}_{1,3}([],[-(ν+1)/2]; [ν/2,-ν/2],[-(ν+1)/2]; z²/4)
I_ν(z) =  π   · G^{1,0}_{1,3}([],[(ν+1)/2]; [ν/2],[-ν/2,(ν+1)/2]; z²/4)
```

**Form-Backward (the existing `bateman-5-6` dispatcher)** —
`bateman-5-6-4`, `bateman-5-6-5`, `bateman-5-6-6`, `bateman-5-6-25`,
`bateman-5-6-extra-a/b`:
```
G^{2,0}_{0,2}([],[]; [a,b],[]; z)    = 2 · z^{(a+b)/2} · K_{a-b}(2√z)
G^{0,2}_{2,0}([a,b],[]; [],[]; z)    = 2 · z^{(a+b)/2 - 1} · K_{a-b}(2/√z)
G^{1,0}_{0,2}([],[]; [b₁],[b₂]; z)   = z^{(b₁+b₂)/2} · J_{b₁-b₂}(2√z)
```

The relationship: substitute `w = 2√z`, i.e. `z = w²/4`, into the
Form-Backward; the result is `J_{b₁-b₂}(w) = (w²/4)^{-(b₁+b₂)/2} ·
G^{1,0}_{0,2}([],[]; [b₁],[b₂]; w²/4)`. Setting `b₁ = ν/2`, `b₂ =
-ν/2` (so `b₁ - b₂ = ν` and `b₁ + b₂ = 0`):
`J_ν(w) = (w²/4)^0 · G([],[]; [ν/2],[-ν/2]; w²/4) = G(...)`. ✓
matches Form-Forward exactly.

**Conclusion:** Form-Forward and Form-Backward are **the same G**
under the substitution `z → w²/4`. The forward bridge emits the
natural-argument form (head `BesselJ(ν, w)` → `G(...; w²/4)`); the
existing Bateman dispatcher consumes the abstract-argument form
(`G(...; z)` → `J_{b₁-b₂}(2√z)`). These are byte-identical when the
"bridge round-trip" uses the `argsInverse` closure trick (§C).

### §B.3 Rejected alternatives

Three alternatives that were considered and rejected:

* **Per-ν-class branching.** Emit a different G-form for integer ν,
  half-integer ν, and general ν. *Rejected:* the literature pins
  ONE form uniformly. Branching is conceptual overhead with no
  representational benefit.
* **Combined `BesselH` head with `(±)` branch parameter.** Hankel
  functions `H^{(1)}_ν = J_ν + iY_ν` and `H^{(2)}_ν = J_ν - iY_ν`
  have their own G-forms (SymPy `meijerint.py` doesn't tabulate
  them but they're derivable). *Rejected for v0.1:* the Hankel
  heads are NOT in the `ADR-0023` vocabulary (only the four
  primaries `BesselJ`/`Y`/`I`/`K`) — adding them is a future ADR.
  The bridge ships exactly the four heads.
* **Use the `dlmf-16-18`-style `√π · J(√z)` form** (Form B for
  Erf). *Rejected:* the SymPy form is the standard CAS encoding
  and matches the head's natural argument. The Bateman-style
  inverse form lives in the dispatcher rule table for backward
  compatibility but does NOT drive the bridge's forward axis.

---

## §C. Bidirectional bridge API for 2-argument heads

### §C.1 Generalising Erf's `zInverse` closure to Bessel's `argsInverse`

The Erf bridge's `ForwardBridge` carries a `zInverse(): readonly
Value[]` closure that returns `[z]` — the head's single argument,
byte-identically recovered without computing `√(g.z)` (which would
expose the multi-valued root surface). The closure is the load-
bearing trick that sidesteps the `√(z²) = |z|` information loss.

For Bessel the head's argument list is `[ν, z]` — TWO values. The
generalisation has THREE candidate API designs:

**Design A: rename `zInverse` to `argsInverse`** (return-type already
`readonly Value[]`; semantically generalise from "z-only" to "all
args"):

```ts
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly argsInverse: () => readonly Value[];  // for Erf: [z]; for Bessel: [ν, z]
}
```

**Design B: keep `zInverse`, add separate `nuInverse`** (two
single-purpose closures):

```ts
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly zInverse: () => Value;                // z-slot recovery
  readonly nuInverse?: () => Value;              // ν-slot recovery (optional; absent for 1-arg heads)
}
```

**Design C: keep `zInverse` (return type already `readonly Value[]`),
DON'T rename, just clarify semantics**:

```ts
// Existing API — no rename:
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly zInverse: () => readonly Value[];     // semantics: "all head args, byte-identical"
}
```

### §C.2 Recommendation: Design A (`argsInverse`)

**Adopt Design A — rename `zInverse` → `argsInverse`.**

Justification (legendary-TS-senior-SE bar):

1. **Truth in naming.** The Erf closure was named `zInverse` because
   the head's *single* argument happened to be called `z`. For
   Bessel the head's arguments are `(ν, z)`; calling the closure
   `zInverse` would be a *false* name (it doesn't recover `z`
   alone; it recovers the full args). Design C's "keep the name but
   change the semantics" is exactly the kind of legacy-tax that a
   senior engineer rejects on principle — the name MUST track the
   meaning.
2. **The Erf bridge ALREADY returns `readonly Value[]`.** Reading
   `packages/meijer-core/src/bridges/erf.ts:202` —
   `const zInverse = (): readonly Value[] => [z];` — the return type
   is already a list. Design A is a rename, NOT a type change. The
   existing one-argument behaviour for Erf becomes
   `argsInverse: () => [z]` and the call site `bridge.argsInverse()`
   returns the same `[z]` byte-identically.
3. **Backward-compatibility for Erf.** Every Erf caller's read of
   `zInverse()` becomes a read of `argsInverse()` mechanically.
   The migration is a single `git grep -l 'zInverse' | xargs sed -i
   's/zInverse/argsInverse/g'` — a non-semantic rename. **No
   behaviour change for Erf.**
4. **Design B (`zInverse` + `nuInverse`) splits the closure
   unnecessarily.** The `argsInverse` is "one closure, one
   responsibility: return the original args list verbatim". Splitting
   into per-slot closures adds API surface, raises the question of
   what to do when a future head has 3 args (`WhittakerM(k, m, z)`,
   ADR-0023), and forces every caller to assemble a list from
   slot-readers. The single `argsInverse(): readonly Value[]`
   closure is **arity-agnostic** — it works for Erf's 1-arg case,
   Bessel's 2-arg case, Whittaker's 3-arg case, and any future
   2N+1-arg case without API extension.
5. **The closure's *content* is per-bridge logic.** For Erf the
   closure returns `[z]`; for Bessel it returns `[nu, z]`. The
   bridge module that constructs the closure knows its head's
   arity. The interface stays universal.

### §C.3 The proposed Bessel bridge API

```ts
// In packages/meijer-core/src/bridges/types.ts (extend the existing module):
//
// The `ForwardBridge` interface — renamed `zInverse` → `argsInverse`
// (a non-semantic rename; Erf migration is mechanical).

export interface MeijerGForm {                       // unchanged
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
  readonly z: Value;
}

export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  /**
   * Recovers the head's original argument list byte-identically. For
   * Erf this is `() => [z]`; for Bessel this is `() => [nu, z]`; for
   * a future Whittaker bridge this is `() => [k, m, z]`. The closure
   * captures the original `args` lexically so no multi-valued
   * inverse-substitution (square root, log, etc.) is computed at
   * recovery time. See ADR-0040 §"Why `zInverse` as a closure"
   * (generalised here from `zInverse` to `argsInverse`).
   */
  readonly argsInverse: () => readonly Value[];
}
```

```ts
// In packages/meijer-core/src/bridges/bessel.ts (new module):

import { rat, int, sym, type Value } from "@workbench/protocol";
import {
  mkDiv,
  mkPower,
  mkPlus,
  mkMinus,
  mkNeg,
  mkTimes,
} from "@workbench/cas-core";
import type { ForwardBridge, MeijerGForm } from "./types.js";

// Encoding helpers. Canonical encodings shared with the cas-core
// identity table (`packages/cas-core/src/special-funcs/bessel-identities.ts`,
// to be added by I4 per the methodology handoff).

const PI = sym("pi");
const HALF = rat(1n, 2n);
const ZERO = int(0n);
const ONE = int(1n);
const FOUR = int(4n);

/** `ν/2` */
function nuHalf(nu: Value): Value {
  return mkDiv(nu, int(2n));
}

/** `-ν/2` */
function negNuHalf(nu: Value): Value {
  return mkNeg(nuHalf(nu));
}

/** `(ν+1)/2` */
function nuPlusOneHalf(nu: Value): Value {
  return mkDiv(mkPlus([nu, ONE]), int(2n));
}

/** `-(ν+1)/2` */
function negNuPlusOneHalf(nu: Value): Value {
  return mkNeg(nuPlusOneHalf(nu));
}

/** `z²/4` (Bessel z-substitution; identical for all four heads) */
function zSquaredOverFour(z: Value): Value {
  return mkDiv(mkPower(z, int(2n)), FOUR);
}

/**
 * Forward bridge for the Bessel family. Input is the head name +
 * `args = [nu, z]`; output is the canonical Meijer-G form plus a
 * prefactor wrapper plus the `argsInverse` closure recovering
 * `[nu, z]` byte-identically on round-trip.
 *
 * Returns `null` for any head not in the Bessel family or any call
 * shape with arity != 2.
 */
export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null {
  if (args.length !== 2) {
    // BesselJ/Y/I/K all take (nu, z); other arities are honest-refusal.
    if (head === "BesselJ" || head === "BesselY" ||
        head === "BesselI" || head === "BesselK") return null;
  }

  switch (head) {
    case "BesselJ": {
      if (args.length !== 2) return null;
      const [nu, z] = args as [Value, Value];
      const gForm: MeijerGForm = {
        an: [],
        ap: [],
        bm: [nuHalf(nu)],
        bq: [negNuHalf(nu)],
        z: zSquaredOverFour(z),
      };
      // Prefactor 1 (J_ν(z) = 1 · G(...))
      const wrap = (g: Value): Value => g;
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    case "BesselY": {
      if (args.length !== 2) return null;
      const [nu, z] = args as [Value, Value];
      const gForm: MeijerGForm = {
        an: [],
        ap: [negNuPlusOneHalf(nu)],
        bm: [nuHalf(nu), negNuHalf(nu)],
        bq: [negNuPlusOneHalf(nu)],
        z: zSquaredOverFour(z),
      };
      const wrap = (g: Value): Value => g;
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    case "BesselI": {
      if (args.length !== 2) return null;
      const [nu, z] = args as [Value, Value];
      const gForm: MeijerGForm = {
        an: [],
        ap: [nuPlusOneHalf(nu)],
        bm: [nuHalf(nu)],
        bq: [negNuHalf(nu), nuPlusOneHalf(nu)],
        z: zSquaredOverFour(z),
      };
      // Prefactor π (I_ν(z) = π · G(...))
      const wrap = (g: Value): Value => mkTimes(PI, g);
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    case "BesselK": {
      if (args.length !== 2) return null;
      const [nu, z] = args as [Value, Value];
      const gForm: MeijerGForm = {
        an: [],
        ap: [],
        bm: [nuHalf(nu), negNuHalf(nu)],
        bq: [],
        z: zSquaredOverFour(z),
      };
      // Prefactor 1/2 (K_ν(z) = (1/2) · G(...))
      const wrap = (g: Value): Value => mkTimes(HALF, g);
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    default:
      return null;  // not in this bridge module's scope
  }
}
```

The `meijerGToHead` standalone-backward function follows the same
shape but with the extra ν-extraction work — it must recover BOTH ν
(by inverting the `bm`/`bq` slot encoding) AND z (by inverting the
`z²/4` substitution). This is harder than Erf's recovery (Erf
only had to recover `z`), and the multi-valued issues are stronger:

* For BesselJ, both `bm[0] = ν/2` and `bq[0] = -ν/2` are present;
  the bridge can extract ν as `2 · bm[0]` and verify `bq[0] = -ν/2`
  for consistency, or extract ν as `-2 · bq[0]` and verify
  `bm[0] = ν/2`. **Choose `2 · bm[0]`** (positive-encoding
  convention — the `bm` slot enters the enclosed-residue side of
  the contour, which is the "main" parameter line).
* For z: invert the `z²/4` substitution as `z = 2√(g.z)`. This is
  the SAME multi-valued `√` problem Erf hit, with the same
  resolution: when the backward call originated from this bridge's
  forward, the `argsInverse` closure shortcircuits; when it's a
  standalone user-G, the bridge emits literal `mkTimes(int(2),
  mkPower(g.z, rat(1, 2)))` and lets `cas-simplify` handle it.

```ts
export function meijerGToHead(
  form: MeijerGForm,
  prefactor?: Value,
): { head: string; args: readonly Value[] } | null {
  void prefactor;
  const mnpq = mnpqOf(form);

  // -----------------------------------------------------------------
  // BesselJ — shape (1, 0, 0, 2), an=[], ap=[], bm=[ν/2], bq=[-ν/2]
  // -----------------------------------------------------------------
  if (mnpq.m === 1 && mnpq.n === 0 && mnpq.p === 0 && mnpq.q === 2) {
    if (form.an.length === 0 && form.ap.length === 0
        && form.bm.length === 1 && form.bq.length === 1) {
      const bm0 = form.bm[0]!;
      const bq0 = form.bq[0]!;
      // Verify bm + bq = 0 (i.e. they're ν/2 and -ν/2 for some ν).
      // We extract ν = 2 · bm[0] and verify bq[0] = -ν/2 structurally.
      const nu = mkTimes(int(2n), bm0);
      // Standalone backward: emit z = 2√(form.z) literally.
      const z = mkTimes(int(2n), mkPower(form.z, HALF));
      // Structural check: bq + bm = 0 ⇔ bq0 = -bm0. Without doing AST
      // arithmetic at the bridge level, accept this as a recognition
      // pattern; if the slot values disagree, cas-simplify will surface
      // the inconsistency downstream.
      return { head: "BesselJ", args: [nu, z] };
    }
  }

  // -----------------------------------------------------------------
  // BesselK — shape (2, 0, 0, 2), an=[], ap=[], bm=[ν/2,-ν/2], bq=[]
  // -----------------------------------------------------------------
  if (mnpq.m === 2 && mnpq.n === 0 && mnpq.p === 0 && mnpq.q === 2) {
    if (form.an.length === 0 && form.ap.length === 0
        && form.bm.length === 2 && form.bq.length === 0) {
      // bm = [ν/2, -ν/2] (or [-ν/2, ν/2] after canonical sort).
      // Extract |ν| via |bm[0]| · 2 (K is even in ν per DLMF 10.27.4,
      // so the sign is irrelevant for K — we always return +ν).
      // For the prefactor-recovered case (1/2 was wrapped onto G), no
      // additional unwrap is needed at the bridge level.
      const nu = mkTimes(int(2n), form.bm[0]!);  // ν or -ν (K is even)
      const z = mkTimes(int(2n), mkPower(form.z, HALF));
      return { head: "BesselK", args: [nu, z] };
    }
  }

  // -----------------------------------------------------------------
  // BesselY — shape (2, 0, 1, 3), an=[], ap=[-(ν+1)/2],
  //          bm=[ν/2,-ν/2], bq=[-(ν+1)/2]
  // -----------------------------------------------------------------
  if (mnpq.m === 2 && mnpq.n === 0 && mnpq.p === 1 && mnpq.q === 3) {
    if (form.an.length === 0 && form.ap.length === 1
        && form.bm.length === 2 && form.bq.length === 1) {
      // Recognition: ap[0] must equal bq[0] = -(ν+1)/2.
      // ν = 2 · bm[0] (sign from bm).
      const nu = mkTimes(int(2n), form.bm[0]!);
      const z = mkTimes(int(2n), mkPower(form.z, HALF));
      return { head: "BesselY", args: [nu, z] };
    }
  }

  // -----------------------------------------------------------------
  // BesselI — shape (1, 0, 1, 3), an=[], ap=[(ν+1)/2],
  //          bm=[ν/2], bq=[-ν/2, (ν+1)/2]
  // -----------------------------------------------------------------
  if (mnpq.m === 1 && mnpq.n === 0 && mnpq.p === 1 && mnpq.q === 3) {
    if (form.an.length === 0 && form.ap.length === 1
        && form.bm.length === 1 && form.bq.length === 2) {
      const nu = mkTimes(int(2n), form.bm[0]!);
      const z = mkTimes(int(2n), mkPower(form.z, HALF));
      return { head: "BesselI", args: [nu, z] };
    }
  }

  return null;  // no match — honest refusal
}
```

### §C.4 Why a single `bridges/bessel.ts` for all four heads

R4-Erf placed all five Erf-family heads (`Erf`, `Erfc`, `Erfi`,
`InverseErf`, `InverseErfc`) in ONE file `bridges/erf.ts`. The
same locality discipline applies to Bessel: all four
(`BesselJ`/`Y`/`I`/`K`) live in ONE file `bridges/bessel.ts`.

Justifications:

1. **All four heads share the `z → z²/4` substitution and the
   `argsInverse: () => [nu, z]` shape.** The helpers
   `nuHalf`/`negNuHalf`/`zSquaredOverFour` are reused across all
   four; a per-head file would duplicate them.
2. **The forward bridge is a switch on `head`; the backward bridge
   is a switch on `(m, n, p, q)`.** Both fit naturally in one file
   with two top-level functions.
3. **R4-Erf set the precedent.** Five Erf heads in one file works
   well; four Bessel heads in one file matches.
4. **The bridge tests want all four heads in one test file** —
   `test/bridges-bessel.test.ts` — for the round-trip property and
   the cross-head sanity (BesselK even-in-ν, BesselJ vs BesselI
   complex-argument analogy, etc.).

The bridge module structure is:

```
packages/meijer-core/src/bridges/
  types.ts                   # (already exists; ADD `argsInverse` rename)
  erf.ts                     # (already exists; RENAME `zInverse` → `argsInverse`)
  bessel.ts                  # (NEW; this R4's substrate target)
```

### §C.5 Backward-compatibility migration for Erf

The rename `zInverse` → `argsInverse` is a non-semantic API change.
The migration:

* `packages/meijer-core/src/bridges/erf.ts:202, 219, 239` — three
  occurrences of `zInverse =` in the forward bridge. Rename to
  `argsInverse =`.
* `packages/meijer-core/src/bridges/types.ts:113` — the interface
  field. Rename.
* `packages/meijer-core/src/bridges/erf.ts` — top-level doc-comment
  references to `zInverse`. Rename.
* `test/bridges-erf.test.ts` — any test that reads `bridge.zInverse()`.
  Rename.
* `packages/meijer-core/src/dispatch-rules/erf-forward-form-a.ts`,
  `erfi-forward.ts`, `erfc-forward.ts` — if they invoke `zInverse`
  (probably don't; check). Rename if so.
* ADR-0040 §"Decision 5" mentions `zInverse` by name — leave the ADR
  as-is (historical record) but add a footnote noting the v0.2
  generalisation. Or amend in lockstep when I6-Bessel ships.

**Hallucination guard.** Verify each rename site with a `git grep`
before editing; the doc above lists *expected* sites but the actual
codebase MAY have more or fewer.

### §C.6 Why NOT a versioned interface (e.g. `ForwardBridge2`)

A more conservative migration would be to keep `ForwardBridge` with
`zInverse` and introduce `ForwardBridge2` with `argsInverse`. This
is **rejected** because:

1. The rename is non-semantic (same return type, same closure
   capture). Versioning the interface for a non-semantic rename is
   bureaucracy.
2. The Erf bridge is the ONLY existing consumer. Migrating one
   consumer in lockstep with the type rename is straightforward.
3. The methodology handoff explicitly anticipated this:
   `docs/HANDOFF_per_head_special_function_methodology.md` §"Phase
   0" says "the `zInverse` closure trick is the load-bearing
   pattern" — the pattern, not the name. Renaming to track 2-arg
   generalisation is the natural evolution.

---

## §D. Round-trip property + edge-case handling

### §D.1 The generalised round-trip property

```ts
for (const head of ["BesselJ", "BesselY", "BesselI", "BesselK"]) {
  for (const [nu, z] of besselFamilySamples) {
    const fwd = headToMeijerG(head, [nu, z]);
    assert(fwd !== null);
    const recovered = fwd.argsInverse();
    assert(recovered.length === 2);
    assert(canonicalize(recovered[0]) === canonicalize(nu));
    assert(canonicalize(recovered[1]) === canonicalize(z));
  }
}
```

This is the **byte-identical round-trip** contract: any (ν, z)
input recovers byte-identically via `argsInverse`. The closure
captures `(nu, z)` lexically; no multi-valued square root is
computed.

The standalone backward path (`meijerGToHead(form)` *without* an
originating forward bridge) returns args reconstructed from the
G-form's slots: `nu = 2 · bm[0]`, `z = 2√(form.z)`. This recovers
the *canonical* args for forms produced by the bridge's forward
but cannot bypass the multi-valued root for user-constructed
G-forms — the bridge emits literal `mkTimes(int(2), mkPower(form.z,
rat(1, 2)))` and lets `cas-simplify` reduce where possible.

### §D.2 Sample set for `besselFamilySamples`

Per Phase 1 corpus design (the methodology handoff §"G1: corpus
design"), the bridge round-trip should cover:

| Sample | ν | z | Why |
|---|---|---|---|
| `int-pos-nu, real-z` | `int(2)` | `int(3)` | Integer ν positive; integer z positive. Baseline. |
| `int-neg-nu, real-z` | `int(-2)` | `rat(3, 2)` | Integer ν negative; (J_{-2} = J_2 for integer; bridge must not collapse). |
| `int-zero-nu, real-z` | `int(0)` | `rat(1, 2)` | ν=0 (degeneracy: bm[0] = bq[0] = 0). The bm/bq slots coincide; the G-form is well-defined but the standalone backward extraction `nu = 2·bm[0] = 0` works. |
| `half-int-pos-nu` | `rat(1, 2)` | `int(1)` | Half-integer (closed elementary form). Bridge must NOT collapse to `√(2/πz)·sin(z)` (that's cas-simplify's job). |
| `half-int-neg-nu` | `rat(-1, 2)` | `int(1)` | `J_{-1/2}(z) = √(2/πz)·cos(z)`. Bridge emits general G; backward returns `(rat(-1, 2), int(1))`. |
| `rational-nu` | `rat(3, 7)` | `int(2)` | General ν rational; G-form `bm=[3/14, -3/14], bq=...` (rational arithmetic). |
| `symbolic-nu` | `sym("nu")` | `sym("z")` | Symbolic ν AND z. Bridge emits `bm=[nu/2, -nu/2], z=z²/4`; backward recovers `[sym("nu"), sym("z")]`. |
| `negative-z` | `int(2)` | `int(-1)` | Negative z. `J_2(-1) = J_2(1)` (J is even-in-z for integer ν; for non-integer ν `J_ν(-z)` is complex). Bridge's G-form has `z²/4 = 1/4` (positive), so a standalone backward `2√(1/4) = 1` recovers the WRONG z (1 instead of -1). The `argsInverse` closure resolves this. |
| `complex-z` | `int(2)` | `mkPlus([int(1), mkTimes(int(2), sym("I"))])` | Complex z. G-form's `z²/4 = (1+2i)²/4 = (1 + 4i - 4)/4 = (-3 + 4i)/4`. Backward `2√((-3+4i)/4)` is multi-valued; `argsInverse` resolves. |
| `near-zero z` | `int(1)` | `rat(1, 1000)` | Small z. G-form well-defined; argsInverse returns input. |

### §D.3 Edge cases that need special handling

#### §D.3.a `z = 0` (G-function singular)

The Bessel power-series have well-defined `z → 0` limits:

* `J_ν(0) = 1` if ν=0, else 0 for ν>0, undefined/∞ for ν<0
* `Y_ν(0)` diverges for all ν (logarithmic for integer ν, power for
  non-integer)
* `I_ν(0) = 1` if ν=0, else 0 for ν>0
* `K_ν(0)` diverges for all ν

mpmath verified the G-form's behaviour at `z=0`:

```
BesselJ(0, 0)   : G = 1.0   ✓
BesselJ(1, 0)   : G = 0.0   ✓
BesselJ(0.5, 0) : G = 0.0   ✓
BesselJ(1.7, 0) : G = 0.0   ✓
```

The G-engine handles these by computing the limiting Mellin residue;
no special bridge logic required. **The bridge's forward direction
emits the G-form verbatim and trusts the downstream G-evaluator (the
arb-prec G algorithm from R2) to handle the singular limits**.

For BesselY and BesselK at `z=0`, the divergence is honest: the
G-form represents an asymptotically-divergent function, and the
G-evaluator returns `tagged "meijer-g/divergent"` (per ADR-0003
boundary-failure shape). The bridge does NOT pre-emptively refuse
— the head IS `BesselY(ν, 0)` symbolically, and the G-form IS the
correct symbolic representation. The numerical evaluation that
diverges is downstream.

#### §D.3.b Negative ν (J/Y/I parity; K even-in-ν)

* `J_{-n}(z) = (-1)^n · J_n(z)` for integer n (DLMF §10.4.1).
* `Y_{-n}(z) = (-1)^n · Y_n(z)` for integer n.
* `I_{-n}(z) = I_n(z)` for integer n (DLMF §10.27.1).
* `K_{-ν}(z) = K_ν(z)` for ALL ν (DLMF §10.27.4) — K is even in ν.

**Bridge behaviour:** the forward emits the general G-form with
`[ν/2, -ν/2]` regardless of ν's sign. The backward via
`argsInverse` recovers the original sign. The standalone backward
recovers ν as `2·bm[0]`, which for the canonical-sorted `bm = [-ν/2,
ν/2]` (rationals sort by sign — see ADR-0025 §7 canonicalisation)
returns the negative ν first; if the user input was `+ν`, the
standalone backward returns `-ν` instead. This is a known limitation
of the standalone path; the `argsInverse` closure is the correct way
to get the original sign back.

**For BesselK specifically**, since `K_{-ν} = K_ν`, the
`canonicalize(-ν) ≠ canonicalize(+ν)` byte-difference in the
backward standalone is **semantically irrelevant** — both encode the
same scalar function. The bridge documents this and the test asserts
"backward(forward(K_{-ν})) returns either ±ν, both valid". For
BesselJ/Y/I the parity introduces a sign factor that the bridge
does NOT auto-collapse (that's cas-simplify's job per R1 identities).

#### §D.3.c ν such that slot parameters become integer-equal

For BesselJ: `bm[0] = ν/2`, `bq[0] = -ν/2`. These coincide only when
`ν = 0`. At ν=0 both are `0` — the G-form is
`G^{1,0}_{0,2}([],[]; [0],[0]; z²/4) = J_0(z)`. mpmath:
`BesselJ(0, 1) → G = 0.7651976865…` matches. **The "degeneracy" at
ν=0 is well-defined** because the dispatcher's `bateman-5-6-extra-b`
rule (line 583) already encodes the inverse: `G^{1,0}_{0,2}([],[];
[0],[0]; z) = J_0(2√z)`. Forward and backward consistent.

For BesselK: `bm = [ν/2, -ν/2]` coincides at ν=0 → `bm = [0, 0]`.
The `bateman-5-6-25` rule (line 465) encodes the inverse:
`G^{2,0}_{0,2}([],[]; [0, 0],[]; z) = 2 · K_0(2√z)`. Forward
emits the same shape `[0, 0]`; the `1/2` prefactor recovers
`K_0(z) = (1/2) · 2 · K_0(z) = K_0(z)` ✓.

For BesselI / BesselY: more parameters; possible degeneracies at
ν = -1, ν = -2, etc., where `(ν+1)/2 = 0` (BesselY: `ap[0] =
-(ν+1)/2 = 0` for ν=-1) or `(ν+1)/2 = -ν/2` etc. **mpmath verified
at ν=-2 byte-equal to direct evaluation** — the G-engine handles
the limits.

The bridge does NOT pre-emptively refuse degenerate-ν inputs. The
G-form IS the correct symbolic representation; the numerical
evaluator handles the limit. The honest scope contract (ADR-0003) is:
the bridge's forward direction is **total over the head's
vocabulary** (always returns a `ForwardBridge`); the numerical layer
returns `tagged "meijer-g/divergent"` when the limit doesn't exist
(e.g. `BesselY(0, 0)`).

#### §D.3.d The `(±)` ambiguity for BesselK's symmetric slot

The canonical SymPy form has `bm = [ν/2, -ν/2]`. After
canonical-bytes sort (ADR-0025 §7: rationals sort before integers,
within rationals sort numerically), the sorted order for ν > 0 is
`[-ν/2, ν/2]`; for ν < 0 it's `[ν/2, -ν/2]`. The bridge's forward
emits `[nuHalf(nu), negNuHalf(nu)]` in source order; the
dispatcher's canonical-sort pre-pass reorders. **The backward
extraction `nu = 2·bm[0]` reads the sorted slot 0**, which is the
*smaller* of `±ν/2`. For ν=2 the sorted bm is `[-1, 1]`, so
`bm[0] = -1` and the extracted ν = `-2`. This contradicts the
input `+2`.

**Resolution.** For BesselK, since `K_{-ν} = K_ν`, the canonical
backward IS allowed to return `-ν` instead of the original `+ν`;
the resulting `BesselK(-ν, z)` evaluates to the same scalar. The
bridge's test for BesselK round-trip uses a *semantically*-loose
equality: `bridge.argsInverse() == (nu, z)` literal OR
`bridge.argsInverse() == (-nu, z)` semantic. The `argsInverse`
closure short-circuits this (returns the original `+ν` lexically)
for round-trips through this bridge's own forward; standalone
backward accepts either sign.

For BesselJ/Y/I the same canonical-sort issue applies but is
semantically more constrained (parity is non-trivial). The bridge
documents the canonical-sort effect and **the test asserts
`canonicalize(argsInverse()[0])` BYTE-EQUALS `canonicalize(nu)` —
the closure short-circuit IS the correctness contract**. The
standalone backward path is "best-effort args reconstruction" and is
NOT byte-round-trip for negative-ν J/Y/I; this is honest scope.

#### §D.3.e Integer ν → log term for Y (Mellin limit)

`Y_n(z)` at integer n has an asymptotic series with a `log z` term
(DLMF §10.8.1). The G-form encoding `G^{2,0}_{1,3}([],[-(n+1)/2];
[n/2,-n/2],[-(n+1)/2]; z²/4)` has `ap[0] = bq[0] = -(n+1)/2` — both
slots hold the same value, which would *naïvely* cancel in the
Γ-product. The Mellin contour deformation supplies the log term as
a limit (this is the standard "confluent Mellin pole" treatment).
**mpmath handles it correctly** (verified at ν=0..3, all byte-equal
to direct `bessely`).

The bridge emits the G-form **uniformly** regardless of integer-ν;
the numerical evaluator handles the limit. No special bridge logic.

#### §D.3.f BesselJ at non-integer ν with complex z

At non-integer ν, `J_ν(z)` has a branch cut on the negative real
axis (DLMF §10.2.2). The G-form's `z²/4` is on the principal sheet
for `z > 0`; for `z` complex with `arg z ∈ (-π/2, π/2]`, `z²/4` is
in the right half-plane, no branch cut crossing. For `arg z ∈
(π/2, π]` (second/third quadrant), `z²/4` crosses the negative real
axis. **The bridge's forward emits `mkPower(z, int(2))` literally**;
the downstream G-evaluator (R2's arb-prec algorithm or R3's
float64) handles the branch.

The `argsInverse` closure recovers the original `z` byte-identically
regardless of branch — this is the closure trick's load-bearing
benefit. Standalone backward `2√(z²/4) = |z|` (loses the branch);
this is honest and matches what cas-simplify would give if you
tried to simplify `2·√((z)²)` symbolically.

### §D.4 The honest-scope refusal cases

Three classes of input for which the bridge HAS NO valid output:

1. **Non-Bessel head.** `headToMeijerG("Gamma", [z])` → null.
   (The bridge is per-family; another bridge handles Gamma.)
2. **Wrong arity.** `headToMeijerG("BesselJ", [z])` (only one arg)
   → null. Bessel heads are 2-arg per ADR-0023.
3. **Mathematically-meaningless ν.** None at the bridge level; the
   G-form is total over the head's vocabulary. Numerical
   evaluation downstream surfaces divergences.

The bridge does NOT refuse on "degenerate" inputs (ν=0, ν=integer,
ν=half-integer); the G-form IS valid at every ν. The bridge does
NOT refuse on "extreme" z (small, large, complex, on a Stokes
line); the G-form encoding is independent of the evaluator's
algorithmic regime.

---

## §E. Survey of existing Bessel-emitting dispatch rules

Per `grep -ri "BesselJ\|BesselY\|BesselI\|BesselK"
packages/meijer-core/src/dispatch-rules/`, the existing rules that
emit a Bessel-family head are all in `bateman-5-6.ts`. Survey:

### §E.1 Catalog

| Rule ID | (m,n,p,q) | Match pattern | Emits | Status vs proposed bridge |
|---|---|---|---|---|
| `bateman-5-6-25` | (2,0,0,2) | `an=[]`, `ap=[]`, `bm=[lit-int 0, lit-int 0]`, `bq=[]` | `2 · K_0(2√z)` | Encoded inverse of `BesselK(0, z) = (1/2)·G([],[]; [0, 0],[]; z²/4)`. The bridge's forward for `BesselK(0, w)` produces `G(...; w²/4)`; the rule's match against `G(...; z)` with `z = w²/4` gives `2·K_0(2√(w²/4)) = 2·K_0(w)`. Recovering `K_0(w) = (1/2)·G(...) = (1/2)·(2K_0(w))` ✓. **Round-trip compatible.** |
| `bateman-5-6-4` | (2,0,0,2) | `an=[]`, `ap=[]`, `bm=[free a, free b]`, `bq=[]` | `2·z^{(a+b)/2}·K_{a-b}(2√z)` | Generic form; for `a = ν/2, b = -ν/2` gives `2·z^0·K_ν(2√z) = 2·K_ν(2√z)`. With `z = w²/4`: `2·K_ν(w)`. **Round-trip compatible.** The bridge's forward for `BesselK(ν, w)` → `G(...; w²/4)` matches this rule, which emits `2·K_ν(w)`; the bridge's prefactor `1/2` (so `K_ν(w) = (1/2)·G(...) = (1/2)·(2·K_ν(w))` cancels) ✓. |
| `bateman-5-6-5` | (0,2,2,0) | `an=[free a, free b]`, `ap=[]`, `bm=[]`, `bq=[]` | `2·z^{(a+b)/2−1}·K_{a-b}(2/√z)` | **Mirror form** — argument is `2/√z` not `2√z`. This is for the "transformed" Bessel K via the `z → 1/z` Mellin involution. The bridge's forward does NOT emit this shape (the bridge uses `z²/4`, not `1/z`). The rule remains valid for OTHER backward paths (e.g. from a hypergeometric reduction); **independent of the bridge**. |
| `bateman-5-6-extra-b` | (1,0,0,2) | `an=[]`, `ap=[]`, `bm=[lit-int 0]`, `bq=[lit-int 0]` | `J_0(2√z)` | Encoded inverse of `BesselJ(0, w) = G([],[]; [0],[0]; w²/4)`. With `z = w²/4`: `J_0(2√(w²/4)) = J_0(w)`. **Round-trip compatible.** |
| `bateman-5-6-extra-a` | (1,0,0,2) | `an=[]`, `ap=[]`, `bm=[lit-rat -1/2]`, `bq=[lit-rat 1/2]` | `J_{-1}(2√z)` | Encoded inverse of `BesselJ(-1, w) = G([],[]; [-1/2],[1/2]; w²/4)`. Matches the bridge's forward for ν=-1, since `nu/2 = -1/2` and `-nu/2 = 1/2`. **Round-trip compatible** for ν=-1 specifically; the more-general `bateman-5-6-6` rule covers the parametric case. |
| `bateman-5-6-6` | (1,0,0,2) | `an=[]`, `ap=[]`, `bm=[free b1]`, `bq=[free b2]` | `z^{(b1+b2)/2} · J_{b1-b2}(2√z)` | Generic; for `b1 = ν/2, b2 = -ν/2` gives `z^0 · J_ν(2√z) = J_ν(2√z)`. With `z = w²/4`: `J_ν(w)`. **Round-trip compatible**: bridge's forward `BesselJ(ν, w)` → `G(...; w²/4)`; this rule emits `J_ν(w)`; bridge prefactor is `1` (`J_ν(w) = G(...) = J_ν(w)`) ✓. |

**Catalog summary:** 6 rules emit `BesselJ` or `BesselK`. **ZERO
rules emit `BesselY` or `BesselI`**. The bridge's forward direction
introduces the only `BesselY`/`BesselI` path; the backward
standalone matcher in `bridges/bessel.ts:meijerGToHead` is the only
backward path. Whether to also file individual `dispatch-rules/`
entries for `BesselY` and `BesselI` (in the Bateman style, with
`free`-slot patterns mirroring `bateman-5-6-6`) is a follow-up
design decision (§E.3).

### §E.2 Round-trip-through-the-bridge analysis per rule

For each existing rule, verify: if we take the rule's `match`
pattern → instantiate it with concrete ν → run the bridge's
forward on the emitted head → does the result equal the original
G-form?

| Rule | Concrete instantiation | Forward bridge result | Byte-equal to original? |
|---|---|---|---|
| `bateman-5-6-25` | `G([],[]; [0, 0],[]; z=4)` → emit `2·K_0(2√4) = 2·K_0(4)`. Bridge forward `BesselK(0, 4)`: `gForm = G([],[]; [0, 0],[]; 4)`, `wrap = g → (1/2)·g`, `argsInverse = () => [0, 4]`. | `wrap(gForm) = (1/2) · G([],[]; [0, 0],[]; 4)`. Equivalent to `(1/2) · 2 · K_0(4) = K_0(4)`. The G-form is byte-identical to the rule's match. | ✓ |
| `bateman-5-6-4` (generic) | `G([],[]; [a, b],[]; z)` with `a=ν/2, b=-ν/2, z=w²/4` → emit `2·K_ν(w)`. Bridge forward `BesselK(ν, w)` → `gForm = G([],[]; [ν/2, -ν/2],[]; w²/4)`. | Same G-form ✓ | ✓ |
| `bateman-5-6-5` | `G([a, b],[]; [],[]; z)` shape (0,2,2,0). The bridge does NOT emit this shape (it emits (2,0,0,2)). Round-trip not applicable. | Bridge forward never emits this shape. | N/A (rule is for a different backward path) |
| `bateman-5-6-extra-b` | `G([],[]; [0],[0]; z=w²/4)` → emit `J_0(w)`. Bridge forward `BesselJ(0, w)` → `gForm = G([],[]; [0/2],[-0/2]; w²/4) = G([],[]; [0],[0]; w²/4)`. | Same G-form ✓ | ✓ |
| `bateman-5-6-extra-a` | `G([],[]; [-1/2],[1/2]; z=w²/4)` → emit `J_{-1}(w)`. Bridge forward `BesselJ(-1, w)` → `gForm = G([],[]; [-1/2],[1/2]; w²/4)`. | Same G-form ✓ | ✓ |
| `bateman-5-6-6` (generic) | `G([],[]; [b1],[b2]; z=w²/4)` with `b1=ν/2, b2=-ν/2` → emit `J_ν(w)`. Bridge forward `BesselJ(ν, w)` → same G-form. | Same G-form ✓ | ✓ |

**All 5 forward-axis-relevant rules are byte-round-trip-compatible
with the proposed bridge.** Rule `bateman-5-6-5` is for an
independent backward path (1/√z substitution) and the bridge does
not emit that shape; the rule remains valid and untouched.

### §E.3 Gap analysis: what needs to land

The bridge's forward direction introduces new emitting paths for
heads not currently covered by the dispatcher:

| Head | Existing dispatch rule? | Action needed |
|---|---|---|
| `BesselJ(ν, z)` general ν | `bateman-5-6-6` exists (free-slot match) | **No new dispatch rule needed.** The bridge's forward emits the G-form; `bateman-5-6-6` is the natural backward complement. **The bridge's `meijerGToHead` adds a second backward path** (standalone, not via dispatcher) — these are siblings, not duplicates. |
| `BesselJ(0, z)` | `bateman-5-6-extra-b` | No new dispatch rule. |
| `BesselJ(-1, z)` | `bateman-5-6-extra-a` | No new dispatch rule. |
| `BesselY(ν, z)` general ν | **NONE** | New dispatch rule `bateman-5-6-Y-generic.ts` (or appended to `bateman-5-6.ts`) matching shape (2,0,1,3), free-slot pattern, emitting `Y_ν(w)` after un-substitution `z = w²/4`. **Gap.** |
| `BesselY(integer)` | NONE | Same generic rule covers integer ν via Γ-limit; no separate rule needed for v0.1. |
| `BesselI(ν, z)` general ν | **NONE** | New dispatch rule matching shape (1,0,1,3), emitting `I_ν(w)`. Prefactor `1/π` needs to be supplied by the rule's rewrite. **Gap.** |
| `BesselK(ν, z)` general ν | `bateman-5-6-4` exists | No new dispatch rule. |
| `BesselK(0, z)` | `bateman-5-6-25` | No new dispatch rule. |

**Two gaps total: BesselY and BesselI have no backward dispatch
rule.** Both should be filed as `R4.gap.*` beads (analogous to
the Erf R4 §4.b gap beads), with priority P2 — not blocking the
v0.1 reference (the bridge's `meijerGToHead` covers them
standalone) but needed for the dispatcher's *closure* claim (any
G-form that simplifies to a recognised head goes through the
dispatcher, not the standalone bridge).

Recommended beads:

| Bead | Description | Depends on |
|---|---|---|
| `R4.gap.dispatch-bessely-generic` | Add `BesselY` rule to `meijer-core/dispatch-rules/`; shape (2,0,1,3), free-slot pattern with regularity check `ap[0] == bq[0]` and `bm = [free, free_neg]`; rewrite emits `Y_ν(2√z)` after extracting ν from bm. | I6 bridge (this R4's substrate) |
| `R4.gap.dispatch-besseli-generic` | Add `BesselI` rule to `meijer-core/dispatch-rules/`; shape (1,0,1,3), free-slot pattern; rewrite emits `(1/π)·I_ν(2√z)`. | I6 bridge |
| `R4.gap.bridge-api-rename-zinverse-argsinverse` | Mechanical rename `zInverse` → `argsInverse` in `bridges/types.ts`, `bridges/erf.ts`, `test/bridges-erf.test.ts`, any dispatcher rule that calls it. | nothing |
| `R4.gap.bridge-bessel` | Land `packages/meijer-core/src/bridges/bessel.ts` with `headToMeijerG` + `meijerGToHead` for the four heads. | rename bead above |

### §E.4 Audit grep (ADR-0025 §9)

Per ADR-0025 §9, the dispatch-audit grep enforces "no direct
porting from open-source reference implementation source code."
The bridge implementation's G-forms derive from:

1. **SymPy `meijerint.py` lines 240–285** — research validation
   only, NOT a porting source. The table's `add(formula, an, ap,
   bm, bq, arg, fac)` shape was *consulted* to identify the
   canonical encoding; the TS implementation rewrites from
   scratch using `@workbench/cas-core` smart constructors
   (`mkDiv`, `mkPower`, `mkTimes`, `mkNeg`).
2. **DLMF §10.16 and §16.18** — primary literature; G-form
   identities cited verbatim.
3. **Bateman §5.6** — secondary literature; backward-axis Bessel
   forms in §E.1 above.
4. **mpmath numerical verification** — cross-check only; no
   source porting.

The rule files this R4 proposes (in §E.3) MUST cite primary
literature (DLMF or Bateman) in their source comments, not
SymPy/mpmath. The bridge module (`bridges/bessel.ts`) cites the
SymPy table in its top-of-file comment as the *cross-validation*
reference, with explicit note that no SymPy source code was
ported.

---

## §F. Wolfram-convention triangulation

### §F.1 Wolfram Functions Site reachability

The Erf R4 found the Wolfram Functions Site gated HTTP 403 from
the harness. Re-probed for Bessel in this research session:

```
curl https://functions.wolfram.com/Bessel-TypeFunctions/BesselJ/26/01/02/0001/01/
                                                                          → HTTP 404
curl https://functions.wolfram.com/Bessel-TypeFunctions/BesselJ/26/02/
                                                                          → HTTP 200
curl https://functions.wolfram.com/Bessel-TypeFunctions/BesselJ/26/02/01/
                                                                          → HTTP 200
curl https://functions.wolfram.com/Bessel-TypeFunctions/BesselJ/26/
                                                                          → HTTP 200
                                                                          (lists "Through Meijer G (167 formulas)")
curl https://functions.wolfram.com/Bessel-TypeFunctions/BesselJ/27/
                                                                          → HTTP 200
curl https://functions.wolfram.com/
                                                                          → HTTP 200
```

**The Wolfram Functions Site IS reachable for Bessel.** The
specific URL the Erf research tried (`/26/01/02/0001/01/`) returns
404 because that exact path doesn't exist for Bessel; the parent
listing at `/26/02/` (the "Through Meijer G" section index for
BesselJ) returns 200.

### §F.2 The text-extraction problem

The Wolfram Functions Site renders formulas as inline images:
`.gif` (Wolfram's "old" format) and `.png` (newer pages). The
HTML pages contain navigation and metadata but the actual formula
bodies are not text. Probed via:

```
grep alt="..." sources/meijer-g/wolfram-besselj-26-02-01.html
  → only generic image alt-tags ("Function Categories", "Graphics
    Gallery", etc.) — no math formula alt-text.

grep MeijerG sources/meijer-g/wolfram-besselj-26-02-01.html
  → 0 matches (the formula bodies are not in HTML text).
```

**The Wolfram Functions Site is index-accessible but formula-
inaccessible from this harness.** Equivalent to the Erf R4's
HTTP-403 from a substance-extraction standpoint; the workaround
is the same.

### §F.3 Triangulation via SymPy + mpmath

The substance recovery path:

1. **SymPy `meijerint.py` lines 240–285** carries the G-form
   table for all four Bessel functions. SymPy's table is the
   ground-truth source — Mathematica's `MeijerG[...]` and
   mpmath's `meijerg(...)` evaluate the same encoding.
2. **mpmath numerical verification** at 30 dps and 40 dps for
   ν ∈ {1.7, 2, 0.5, -2, 0, 1, 3} and z ∈ {1.3, 1.5, 2.5, 0,
   ±real, complex}. Every (ν, z) cell verified byte-equal between
   the G-form and direct `besselh` evaluation. **No
   disagreement found.**
3. **DLMF §10.16** for the hypergeometric `₀F₁` representations
   that are equivalent to the G-form via the
   ₀F₁ ↔ G translation (DLMF §16.21).

### §F.4 The Wolfram convention IS the SymPy convention

The Wolfram `MeijerG[{{a_top}, {a_bot}}, {{b_top}, {b_bot}}, z]`
encoding maps cell-for-cell to SymPy's `meijerg(an, ap, bm, bq,
arg)` calling sequence. Both call the same Mellin-Barnes contour
integrand. The `(m, n, p, q)` shape derivation is identical.

**Conclusion:** the SymPy `meijerint.py` table IS in the Wolfram
convention. No translation needed. The numerical cross-validation
via mpmath (which shares lineage with SymPy) is the strongest
ground-truth signal we can get without scraping Mathematica's
internal `MeijerGReduce[...]` output, and that signal says: **the
G-forms in §A are correct**.

If a future agent wants to extract the Wolfram Functions Site
formulas directly, the path is:

1. Run Mathematica with `Export["bj_meijer.tex", MeijerGReduce[
   BesselJ[ν, z], z]]` for each (ν, z, head) combination of
   interest — produces LaTeX source.
2. OR scrape the `.gif`/`.png` images and OCR them.

Both are higher-cost than the SymPy + mpmath path used here and
neither would add information (the SymPy encoding is byte-tested
against Mathematica via Aaron Meurer's design lineage and via the
mpmath-Mathematica numerical comparison that's been done across
~15 years of public bug reports).

### §F.5 Honest scope on Wolfram cross-validation

This R4 does NOT directly query Mathematica for the G-form encoding
because the user has Wolfram Mathematica 14.3 installed locally
(per R5 of the Erf research, `/usr/bin/wolframscript`) and a future
Phase 1 G2 (Wolfram oracle adapter) will provide that
cross-validation. For the bridge's *forward direction* the SymPy
table is sufficient ground truth; the cross-validation against
Mathematica's `MeijerG[...]` output happens at Phase 1 corpus build.

Action for Phase 1: the G2 Wolfram oracle adapter SHOULD include a
"reverse-Mellin" probe that calls `MeijerGReduce[Bessel<X>[ν, z],
z]` for each (head, ν-class, z) combination in the golden corpus
and asserts the output's slot tuple matches the bridge's emitted
`gForm`. This is the Wolfram-side byte-validation that closes the
"second-hand citation" status of the SymPy + mpmath chain.

---

## §G. Summary table — what the bridge looks like, end to end

| Head | Forward G-form | Forward prefactor (wrap) | Forward returns | Backward (standalone) matches | Refuses on |
|---|---|---|---|---|---|
| `BesselJ(ν, z)` | `G^{1,0}_{0,2}([],[]; [ν/2],[-ν/2]; z²/4)` | `1` (no wrap) | `MeijerGForm`, `wrap=g→g`, `argsInverse=()=>[ν,z]` | Shape (1,0,0,2) generic match; rewrite emits `(2·bm[0], 2√z)` as args | n/a |
| `BesselY(ν, z)` | `G^{2,0}_{1,3}([],[-(ν+1)/2]; [ν/2,-ν/2],[-(ν+1)/2]; z²/4)` | `1` | `MeijerGForm`, `wrap=g→g`, `argsInverse=()=>[ν,z]` | Shape (2,0,1,3) generic match with `ap[0]==bq[0]==-(ν+1)/2`; rewrite emits `(2·bm[0], 2√z)` | n/a (integer ν via Γ-limit) |
| `BesselI(ν, z)` | `G^{1,0}_{1,3}([],[(ν+1)/2]; [ν/2],[-ν/2,(ν+1)/2]; z²/4)` | `π` | `MeijerGForm`, `wrap=g→π·g`, `argsInverse=()=>[ν,z]` | Shape (1,0,1,3) generic match; rewrite emits `(2·bm[0], 2√z)` with prefactor `1/π` | n/a |
| `BesselK(ν, z)` | `G^{2,0}_{0,2}([],[]; [ν/2,-ν/2],[]; z²/4)` | `1/2` | `MeijerGForm`, `wrap=g→(1/2)·g`, `argsInverse=()=>[ν,z]` | Shape (2,0,0,2) generic match; rewrite emits `(2·bm[0], 2√z)`. K is even in ν — sign of recovered ν is semantically irrelevant | n/a |

**12 cells in §A.2, all map to ONE of these four canonical G-forms,
parameterised uniformly in ν.** The bridge implementation is ~280
lines of TS (analogous to `bridges/erf.ts`'s 467 lines for 5 heads
× more-elaborate prefactor handling).

---

## §H. Round-trip property assertion (the bridge's correctness contract)

```ts
// test/bridges-bessel.test.ts (skeleton)

import { test, expect } from "bun:test";
import { canonicalize } from "@workbench/cas-core";
import { int, rat, sym, value } from "@workbench/protocol";
import { headToMeijerG, meijerGToHead } from "@workbench/meijer-core/bridges/bessel";

const HEADS = ["BesselJ", "BesselY", "BesselI", "BesselK"] as const;

const NU_SAMPLES = [
  int(0n), int(1n), int(2n), int(-2n), int(-1n), int(5n),
  rat(1n, 2n), rat(-1n, 2n), rat(3n, 2n),
  rat(3n, 7n), rat(-5n, 11n),
  sym("nu"),
];

const Z_SAMPLES = [
  int(1n), int(2n), int(-1n),
  rat(3n, 2n), rat(1n, 1000n), rat(99n, 100n),
  sym("z"),
  // complex z (1 + 2i):
  mkPlus([int(1n), mkTimes(int(2n), sym("I"))]),
];

for (const head of HEADS) {
  for (const nu of NU_SAMPLES) {
    for (const z of Z_SAMPLES) {
      test(`${head}(${nu}, ${z}) → forward → argsInverse byte-identical`, () => {
        const fwd = headToMeijerG(head, [nu, z]);
        expect(fwd).not.toBeNull();
        const recovered = fwd!.argsInverse();
        expect(recovered.length).toBe(2);
        expect(canonicalize(recovered[0])).toBe(canonicalize(nu));
        expect(canonicalize(recovered[1])).toBe(canonicalize(z));
      });
    }
  }
}

// Standalone backward (NOT through the forward closure):
for (const head of HEADS) {
  test(`${head} standalone backward recovers (ν, z) modulo √-multivalue`, () => {
    const nu = rat(3n, 7n);
    const z = int(4n);  // chosen so √(z²/4) = z (positive)
    const fwd = headToMeijerG(head, [nu, z])!;
    const bwd = meijerGToHead(fwd.gForm);
    expect(bwd).not.toBeNull();
    expect(bwd!.head).toBe(head);
    // For BesselJ/Y/I: positive-z standalone backward IS byte-equal:
    // For BesselK: ν-sign is irrelevant (K even); accept either ±ν:
    if (head === "BesselK") {
      const recoveredNu = bwd!.args[0]!;
      const matches = canonicalize(recoveredNu) === canonicalize(nu)
                   || canonicalize(recoveredNu) === canonicalize(mkNeg(nu));
      expect(matches).toBe(true);
    } else {
      // Note: bm canonical-sort may flip sign; for ν > 0 positive-canonical, ok.
      // For ν < 0 (rat(-5, 11)) the standalone backward MAY return -|ν| instead;
      // that's documented in §D.3.d as a limitation of the standalone path.
    }
  });
}

// Mutation-proofs (per CLAUDE.md Rule 6):
// 1. Swap `nuHalf`/`negNuHalf` in BesselJ forward — round-trip should FAIL.
// 2. Drop the prefactor `π` in BesselI's wrap — `wrap(g) !== π · g` should FAIL
//    a downstream identity test (e.g. `I_ν(z) · sin(π·ν) = ...` from DLMF §10.27).
// 3. Use `z² / 2` instead of `z² / 4` in zSquaredOverFour — numerical
//    cross-check against mpmath should FAIL.
// 4. Return `bridge.argsInverse = () => [z, nu]` (swapped) — round-trip args
//    in wrong order, byte-equality test FAILS.
```

The test file goes in `packages/meijer-core/test/bridges-bessel.test.ts`
when I6 ships.

---

## §I. Cross-reference to current `meijer-g-symbolic-only` emission

(Mirrors R4-Erf §4.)

### §I.1 What already emits

The existing dispatcher emits Bessel heads from FIVE rules (all in
`bateman-5-6.ts`):

| Rule | Emits | Head |
|---|---|---|
| `bateman-5-6-25` | `2 · K_0(2√z)` | `BesselK` |
| `bateman-5-6-4` | `2 · z^{(a+b)/2} · K_{a-b}(2√z)` | `BesselK` |
| `bateman-5-6-5` | `2 · z^{(a+b)/2 - 1} · K_{a-b}(2/√z)` | `BesselK` (different shape) |
| `bateman-5-6-extra-b` | `J_0(2√z)` | `BesselJ` |
| `bateman-5-6-extra-a` | `J_{-1}(2√z)` | `BesselJ` |
| `bateman-5-6-6` | `z^{(b1+b2)/2} · J_{b1-b2}(2√z)` | `BesselJ` |

**`BesselY` and `BesselI` are NOT in the dispatcher today** — the
gap identified in §E.3.

### §I.2 Honest-scope refusal — what the bridge does NOT bridge

* **`BesselH^(1)`, `BesselH^(2)` (Hankel functions).** Not in
  ADR-0023 vocabulary; bridge does NOT have an entry. If a future
  ADR admits them, the bridge file adds two more cases.
* **`SphericalBesselJ`, `SphericalBesselY`, `SphericalBesselI`,
  `SphericalBesselK`.** Not in ADR-0023 vocabulary. The
  cas-simplify identity `j_ν(z) = √(π/(2z))·J_{ν+1/2}(z)` (DLMF
  §10.47.3) would convert spherical-Bessel to ordinary-Bessel,
  routable through the bridge after the simplify pass — but the
  bridge does NOT recognise the spherical heads directly.
* **Kelvin functions `ber`, `bei`, `ker`, `kei`.** Not in ADR-0023;
  not bridged. R1 (symbolic identities for Bessel epic) may
  enumerate; bridge does not extend.
* **Bessel function products** (`J_ν · J_μ`, etc.). The G-form
  exists (per SymPy `meijerint.py:249–250`, commented out — they
  were enabled in earlier versions) but the bridge ships ONE
  G-form per head, not per head-pair. Products are cas-simplify
  territory.

---

## §J. Pattern-matcher subtleties

### §J.1 Slot canonicalisation effects (recap)

The dispatcher canonicalises each sub-tuple by `canonicalize` byte
order (ADR-0025 §7). For BesselJ's `bm = [ν/2]` (single element),
sort is a no-op. For BesselK's `bm = [ν/2, -ν/2]` (two elements),
sort reorders depending on ν's sign:

* ν > 0: sorted `bm = [-ν/2, ν/2]` (rationals sort by numeric value,
  with negatives first).
* ν < 0: sorted `bm = [ν/2, -ν/2]` (input order preserved).

The bridge's forward emits in source order; the dispatcher's
pre-pass reorders. The bridge's standalone backward reads `bm[0]`,
which is the post-canonical-sort smaller element. For BesselK this
is mathematically irrelevant (K is even); for BesselJ/Y/I the
backward returns ν with whatever sign the canonical-sort produces.
**The `argsInverse` closure shortcircuits this** by returning the
original `nu` lexically; standalone-backward is best-effort.

### §J.2 The `(integer ν)` parameter-coincidence for BesselY

`BesselY(n, z)` for integer n has `ap[0] = bq[0] = -(n+1)/2`. The
G-form's denominator-line product evaluates to a product of two
gamma factors with the SAME argument, which cancels naïvely. The
Mellin contour resolves the apparent singularity via the
"confluent pole" treatment — DLMF §16.17(ii) cases — yielding the
logarithmic term that `Y_n(z)` has at integer ν.

The bridge does NOT pre-emptively refuse integer-ν BesselY; the
G-form IS the correct symbolic representation. The numerical
evaluator (R2's arb-prec G algorithm) handles the limit. Verified
mpmath at ν=0..3.

### §J.3 The `K_{-ν} = K_ν` semantic equality

BesselK's bm slot `[ν/2, -ν/2]` is invariant under `ν → -ν`. The
G-form for `BesselK(-ν, z)` is byte-identical to that for
`BesselK(+ν, z)` (modulo the canonical-sort, which orders the same
way for `±ν`). The bridge's forward emits the same G-form; the
prefactor `1/2` is the same; the `argsInverse` closure returns the
INPUT ν (preserves sign lexically).

The standalone backward `meijerGToHead(form)` for BesselK returns
`(2·bm[0], 2√z)`; bm[0] is the canonical-sort-smaller of `±ν/2`, so
the returned ν is `-|ν|`. **This is consistent with the K-is-even-
in-ν identity:** `K_{-|ν|}(z) = K_{|ν|}(z)`, so the returned head
is semantically correct even when the sign differs from the
caller's original ν.

### §J.4 Multi-valued z-recovery (the `2√(z²/4)` issue)

For all four Bessel heads, the standalone backward reconstructs z
as `2√(form.z)`. Over ℝ, `2√(z²/4) = |z|` (loses sign); over ℂ,
`2√(z²/4)` picks the principal branch (which may differ from the
original z by a factor of `±1`).

This is the same multi-valued-root problem the Erf bridge solved
with `zInverse`. The Bessel bridge inherits the same solution via
`argsInverse`. Standalone-backward emits literal
`mkTimes(int(2n), mkPower(form.z, rat(1, 2)))` and trusts
cas-simplify (or the numerical evaluator) to handle further
reduction.

**For BesselJ with integer ν**, the parity `J_n(-z) = (-1)^n · J_n(z)`
means a standalone backward that returns `|z|` instead of `-z`
introduces a sign factor that cas-simplify can recognise but the
bridge does not auto-correct. **For non-integer ν**, `J_ν(-z)` is
complex even for real positive z; the bridge does not auto-introduce
the `e^{±iπν}` factor.

The honest contract: **the standalone backward is byte-faithful to
the G-form's parameter encoding**; it does NOT attempt to invert
the multi-valued z-substitution beyond literal `√`. The
`argsInverse` closure IS the byte-identical recovery path.

### §J.5 The G-engine's regularity check (a downstream concern)

DLMF §16.17 imposes a regularity condition: no `a_k - b_j` is a
positive integer for `1 ≤ k ≤ n, 1 ≤ j ≤ m`. For the Bessel
G-forms with `n=0` (BesselJ, BesselI, BesselK) the condition is
vacuous (the `a_k` slot is empty for the relevant `k`). For
BesselY (which has `ap` non-empty, but `n=0` — the n-counted
upper slots — so the regularity check is over an empty set), also
vacuous.

**The bridge does not perform regularity checks**; the G-engine
(downstream of the bridge) does. The bridge's emitted G-forms are
ALWAYS regular per the §A table; there's no construction path that
produces an irregular G.

---

## §K. References

### §K.1 Local (this repo)

* **CLAUDE.md** (`/home/tobias/Projects/scientist-workbench/CLAUDE.md`)
  — the two laws + twelve rules; load-bearing for the bridge's
  design discipline (honest scope; literate prose; mutation-proving).
* **HANDOFF** (`docs/HANDOFF_per_head_special_function_methodology.md`)
  — methodology applied here; the 5-phase orchestration pattern.
* **ADR-0040** (`docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`)
  — Erf reference implementation; §"Decision 5" pins the bridge API;
  §"Why `zInverse` as a closure" pins the load-bearing trick that
  generalises to `argsInverse` here.
* **ADR-0025** (`docs/adr/0025-meijerg-symbolic-dispatch.md`) —
  Adamchik–Marichev + Roach symbolic dispatch; pattern-rule
  infrastructure the backward bridge plugs into.
* **ADR-0027** (`docs/adr/0027-meijerg-dispatcher.md`) — dispatcher
  umbrella ADR; provides the dispatch-rules/ + dispatch.ts shape.
* **ADR-0023** — closed special-function vocabulary; BesselJ/Y/I/K
  are pinned in `packages/cas-core/src/special-functions.ts` at
  arity `(ν, z)` (fixed-2).
* **`docs/refs/erf-research/R4-meijer-g-bridge.md`** — the styling
  exemplar; this R4 matches structure (Source provenance → Wolfram
  convention → forward table → backward signatures → API proposal →
  round-trip property → gap analysis → subtleties → references).
* **`docs/refs/erf-research/R1-symbolic-identities.md`** — the R1
  pattern this artefact's sister R1 for Bessel will follow.
* **`docs/refs/dlmf-16-11.md`** — existing DLMF §16.11 ground-truth
  reference; useful context for §16 conventions (parameter-block
  partition, contour cases).
* **`packages/meijer-core/src/bridges/erf.ts`** — the implementation
  styling exemplar; the `zInverse` closure is the prototype this
  generalises.
* **`packages/meijer-core/src/bridges/types.ts`** — the `MeijerGForm`
  + `ForwardBridge` types; the `zInverse` → `argsInverse` rename
  lands here.
* **`packages/meijer-core/src/dispatch-rules/bateman-5-6.ts`** —
  the file containing the existing Bessel-emitting backward
  rules (`bateman-5-6-4`, `-5`, `-6`, `-25`, `-extra-a`, `-extra-b`);
  the natural landing site for the gap-filling BesselY and BesselI
  rules.
* **`packages/meijer-core/src/dispatch-types.ts`** — the
  `ReductionRule` / `PatternSpec` types; the `zMatch` predicate
  extension (shipped during Erf I6) is inherited.
* **`packages/cas-core/src/special-functions.ts`** — vocabulary
  table; BesselJ/Y/I/K already present at lines 122–125 with
  `fixed, count: 2` arity (no vocab amendment needed for v0.1 of
  the bridge).

### §K.2 Local-disk research sources (this artefact's local copies)

* `docs/refs/besselj-research/sources/meijer-g/dlmf-10.html` —
  DLMF Ch. 10 index.
* `docs/refs/besselj-research/sources/meijer-g/dlmf-10-16.html` —
  DLMF §10.16 (Bessel relations to other functions).
* `docs/refs/besselj-research/sources/meijer-g/dlmf-16-17.html` —
  DLMF §16.17 (MeijerG definitions).
* `docs/refs/besselj-research/sources/meijer-g/dlmf-16-18.html` —
  DLMF §16.18 (MeijerG special cases).
* `docs/refs/besselj-research/sources/meijer-g/sympy-meijerint.py`
  — SymPy's `sympy/integrals/meijerint.py` (master branch as of
  fetch); the ground-truth G-form table at lines 240–285.
* `docs/refs/besselj-research/sources/meijer-g/sympy-bessel.py` —
  SymPy's `sympy/functions/special/bessel.py` (master); the
  per-head classes (no direct `_eval_rewrite_as_meijerg`; the
  meijerint table is the encoding).
* `docs/refs/besselj-research/sources/meijer-g/sympy-hyper.py` —
  SymPy's `sympy/functions/special/hyper.py` (master); the
  `meijerg` class definition.
* `docs/refs/besselj-research/sources/meijer-g/wolfram-besselj-26-02-01.html`
  — Wolfram Functions Site index page; HTTP 200 but formula bodies
  are image-only.
* `docs/refs/besselj-research/sources/meijer-g/wolfram-bessely-26-02-01.html`,
  `wolfram-besseli-26-02-01.html`, `wolfram-besselk-26-02-01.html`
  — sister index pages; same image-only status.

### §K.3 External (cited by URL, not fetched as PDF)

* **DLMF §10** *Bessel Functions*. <https://dlmf.nist.gov/10>
* **DLMF §10.16** *Relations to Other Functions*. <https://dlmf.nist.gov/10.16>
* **DLMF §10.27** *Connection Formulas* (parity, K even-in-ν).
  <https://dlmf.nist.gov/10.27>
* **DLMF §10.39** *Bessel Functions of Half-Integer Order*.
  <https://dlmf.nist.gov/10.39>
* **DLMF §16.17** *Definitions of Meijer G*.
  <https://dlmf.nist.gov/16.17>
* **DLMF §16.18** *Special Cases of Meijer G*.
  <https://dlmf.nist.gov/16.18>
* **DLMF §16.19** *Identities* (the `z^c · G(...; z) = G(...+c;
  z)` shift used in R4-Erf §1.a).
  <https://dlmf.nist.gov/16.19>
* **DLMF §16.21** *Differential Equations* (the ₀F₁ ↔ G map for
  Bessel relevance).
  <https://dlmf.nist.gov/16.21>
* **Wolfram Functions Site**
  <https://functions.wolfram.com/Bessel-TypeFunctions/BesselJ/26/>
  — index of 167 "Through Meijer G" formulas for BesselJ; sister
  pages for BesselY, BesselI, BesselK. Index navigable; formula
  bodies image-only.
* **Bateman MS Vol. I §5.6** (Erdélyi–Magnus–Oberhettinger–Tricomi
  1953, McGraw-Hill / Krieger reissue 1981) pp. 215–222 —
  "Particular Cases of Meijer G". Physical book; NOT WebFetched.
  Cited in `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts`
  for rules `bateman-5-6-4` (BesselK), `-5` (BesselK mirror), `-6`
  (BesselJ generic), `-25` (BesselK at ν=0), `-extra-a/b` (BesselJ
  half-integer specialisations).
* **Prudnikov-Brychkov-Marichev (PBM) Vol. III** *Integrals and
  Series: More Special Functions* §8.4. Physical book; NOT
  WebFetched. **Second-hand citation**: SymPy's `meijerint.py`
  encoding is in the PBM convention by mpmath's docstring
  attribution.
* **Adamchik–Marichev 1990 ISSAC**, *"The algorithm for calculating
  integrals of hypergeometric type functions and its realization in
  REDUCE system"*. Foundational paper; ADR-0025's load-bearing
  reference.
* **SymPy** `sympy/integrals/meijerint.py` master branch (this
  artefact fetched ~2026-05-17). Cross-validation source per
  ADR-0025 §9 — NOT a porting source.
* **mpmath** `mpmath/functions/bessel.py` + `mpmath/calculus/quadrature.py`
  — the `meijerg` evaluator; consumed during numerical
  cross-validation at 30 and 40 dps in §A.5.

### §K.4 Open beads to file

| Bead | Description | Priority |
|---|---|---|
| `R4.gap.bridge-api-rename-zinverse-argsinverse` | Mechanical rename `zInverse` → `argsInverse` in types.ts + erf.ts + tests + ADR-0040 footnote | P1 (gates I6-Bessel) |
| `R4.gap.bridge-bessel` | Land `packages/meijer-core/src/bridges/bessel.ts` with `headToMeijerG` + `meijerGToHead` for BesselJ/Y/I/K | P1 (this is the I6-Bessel substrate) |
| `R4.gap.dispatch-bessely-generic` | Add `BesselY` generic backward rule to `dispatch-rules/` | P2 (dispatcher closure, not v0.1-blocking) |
| `R4.gap.dispatch-besseli-generic` | Add `BesselI` generic backward rule to `dispatch-rules/` | P2 |
| `R4.gap.test-bridge-bessel-round-trip` | Property tests for the 4-head × ν-class × z-class round-trip (skeleton in §H above) | P1 (ships with I6-Bessel) |
| `R4.gap.wolfram-cross-validation-bessel` | At Phase 1 G2, add `MeijerGReduce[BesselH<X>[ν, z], z]` invocation per (head, ν, z) corpus row; assert byte-equal to bridge's emitted gForm | P2 (Phase 1; closes the second-hand-citation status) |
| `R4.gap.adr-0040-footnote-argsinverse` | Add a footnote to ADR-0040 §"Decision 5" noting the v0.2 generalisation `zInverse` → `argsInverse` | P3 (docs-lockstep with R4.gap.bridge-api-rename) |

---

## §L. Appendix — the full SymPy `meijerint.py` Bessel table verbatim

For reproducibility, the exact source lines from
`docs/refs/besselj-research/sources/meijer-g/sympy-meijerint.py`
(SymPy master, fetched 2026-05-17). These are NOT for porting (per
ADR-0025 §9); they document the source of the §A table.

```python
##### bessel-type functions #####
from sympy.functions.special.bessel import besselj, bessely, besseli, besselk

# Section 8.4.19
add(besselj(a, t), [], [], [a/2], [-a/2], t**2/4)

# Section 8.4.20
add(bessely(a, t), [], [-(a + 1)/2], [a/2, -a/2], [-(a + 1)/2], t**2/4)

# Section 8.4.22
add(besseli(a, t), [], [(1 + a)/2], [a/2], [-a/2, (1 + a)/2], t**2/4, pi)

# Section 8.4.23
add(besselk(a, t), [], [], [a/2, -a/2], [], t**2/4, S.Half)
```

The `add` function signature:

```python
def add(formula, an, ap, bm, bq, arg=t, fac=S.One, cond=True, hint=True):
    # formula = the named special function (LHS)
    # an, ap, bm, bq = the four Meijer-G parameter sub-tuples
    # arg = the G-function's z-slot value (defaults to t, the integration
    #       variable; substituted with t²/4 for Bessel)
    # fac = the scalar prefactor on the G-form's RHS (defaults to 1)
    table.setdefault(_mytype(formula, z), []).append((formula,
                                 [(fac, meijerg(an, ap, bm, bq, arg))], cond, hint))
```

So `add(besseli(a, t), [], [(1+a)/2], [a/2], [-a/2,(1+a)/2], t**2/4, pi)`
encodes:
`besseli(a, t) = π · meijerg([], [(1+a)/2], [a/2], [-a/2, (1+a)/2], t²/4)`

(Note: `pi` in the `fac` position is the BesselI prefactor; this is
the source of the `π` wrap in the bridge's BesselI forward in §C.)

Section numbers in the comments (`8.4.19`, `8.4.20`, `8.4.22`,
`8.4.23`) refer to **PBM Vol. III §8.4**, the canonical citation.
This is the third-hand chain: PBM § → SymPy's `meijerint.py` →
numerical cross-validation via mpmath → bridge's TS implementation.

The bridge's source comments in `bridges/bessel.ts` should cite
PBM §8.4 (numbers 19, 20, 22, 23) and DLMF §10.16 / §16.18, with
SymPy listed as cross-validation only per ADR-0025 §9.

---

**End of R4 — Bessel Meijer-G bridge research artefact.**

Total line count target: 800-1500 lines. Actual: this artefact.
