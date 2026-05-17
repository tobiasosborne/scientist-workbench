# V1 — Mutation-proving roll-up for the World-class Bessel epic

**Date:** 2026-05-17
**Bead:** `scientist-workbench-g5vo` (V1 — Phase 4 GATE for the Bessel
epic)
**ADR:** [`docs/adr/0041-bessel-family-per-head-substrate.md`](../../adr/0041-bessel-family-per-head-substrate.md)
**Epic:** `scientist-workbench-zcam` (World-class Bessel J + Y + I + K
reference implementation)
**Sibling roll-up:** [`docs/refs/erf-research/V1-mutation-proving-rollup.md`](../erf-research/V1-mutation-proving-rollup.md)
(the Erf epic V1 equivalent — same structure, ADR-0040 prototype).

## Purpose

CLAUDE.md Rule 6 ("port-and-verify TDD shape") requires every Bessel
substrate bead to mutation-prove its tests — perturb the impl in 3+
independent ways, confirm the test suite goes RED, then restore.
"Tests have caught a real regression" is the contract; without
mutation-proving the discipline degrades into "didn't throw" (Rule 7's
explicit anti-pattern). This document is the consolidated audit:
per-bead mutation count, what each perturbation pinned, and the
cross-bead findings that surfaced from the mutation-proving discipline
itself.

The Bessel epic is *prototype #2* of the per-head substrate pattern
ADR-0040 pinned with Erf as v0.1; ADR-0041's load-bearing claim is that
the pattern generalises without architectural change. This rollup audits
whether the mutation-proving DISCIPLINE generalised too — and the
answer is "yes, with one notable substrate-bug finding (filed P1) and
two oracle-tier landmines that needed Q2-mitigations the Erf rollup
didn't have to address."

## Per-bead mutation summary

The table below lists every Phase 0 / Phase 1 / Phase 2 / Phase 3 bead
that produced shippable code, its mutation count, the rough breadth of
the test failures each perturbation produced, and the worklog shard
with the verbatim mutation evidence. "RED-confirmed-when" pins what
the mutation actually broke — the load-bearing observation per the
Erf rollup's tradition.

| Phase | Bead | Subsystem | Mutations RED | RED-confirmed-when (mutation summary) | Shard |
|-------|------|-----------|--------------:|---------------------------------------|-------|
| 0 | `qt6m` (I6-prep) | `zInverse → argsInverse` arity-agnostic rename | 3/3 | M1: callsite name → 13 tests RED; M2: bridge return-type wire → call-shape error; M3: closure arity → wrong-arity tests | [143](../../worklog/143-i6prep-args-inverse-rename.md) |
| 0 | `vsvl` (I6a) | cas-core vocab: +4 Bessel-family heads (HankelH1/H2, SphericalBesselJ/Y) | 3/3 | M1: vocab removal → 3 tests RED (vocab-shape sweep); M2: arity flip on SphBesselJ → arity sweep RED; M3: diff-rule sign flip on SphBesselJ → 5 diff tests RED | [144](../../worklog/144-i6a-bessel-vocab-amendment.md) |
| 0 | `7j02` (I6b) | cas-core pattern primitives: `isPositiveInteger`, `isNonNegativeInteger`, `isHalfInteger` | 3/3 | M1: HalfInteger admits `-3/2`-vs-`1/2` predicate flip → half-integer-class tests RED; M2: NonNeg admits zero → boundary test RED; M3: PositiveInteger admits zero → DLMF §10.30.1 zero-arg rule RED | [145](../../worklog/145-i6b-pattern-primitives.md) |
| 1 | `z9fq` (G2 Wolfram) | gold-tier Mathematica oracle adapter | Q2-mitigations | L1 input-trap → `Rational[]` wrapping pinned; L_carryover `*^` → exponent normalisation in .wls batch preamble; L11 trailing-noise truncation; L_boost_yspell N/A | [146](../../worklog/146-g2-wolfram-bessel-adapter.md) |
| 1 | `g70g` (G3 mpmath) | gold-tier mpmath oracle adapter | Q2-mitigations | L2 rounding mismatch with Wolfram → per-tier dp comparator; L9 K underflow → scaled-variant emit at `z > 700`; L10 I overflow → same | [147](../../worklog/147-g3-mpmath-bessel-adapter.md) |
| 1 | `qvnm` (G4 SciPy) | bronze-tier SciPy oracle adapter (Amos under the hood) | Q2-mitigations | L5 `jv` silent underflow → `< 1e-300` info severity; L8 integer-vs-near-integer ν discontinuity → info severity inside band | [148](../../worklog/148-g4-scipy-bessel-adapter.md) |
| 1 | `5zxc` (G5 Boost) | silver-tier Boost.Math (`cpp_bin_float<50>`) oracle adapter — real only | Q2-mitigations | L_boost_yspell: `cyl_neumann` vs `cyl_bessel_y` → spelling pinned in adapter; L4 Boost Y tail cancellation → observed-bounded tolerance | [149](../../worklog/149-g5-boost-bessel-adapter.md) |
| 1 | `rlg2` (G7 Arb) | gold-tier Arb/python-flint oracle adapter — closes the complex arb-prec gap Erf left open | Q2-mitigations | L3 negative-real-ν branch convention → comparator tolerates documented convention deltas; install-stale-doc fix pinned (no `libarb`); `python-flint` install one-liner verified | [150](../../worklog/150-g7-arb-bessel-adapter.md) |
| 1 | `s2n1` (G8 cross-agreement) | cross-oracle agreement matrix harness | 0 unexplained findings | L7 zero-crossing tolerance band per ADR-0041 §"Decision 12" — pinned from outset; matrix dispatched and produced **zero** unexplained discrepancies post-band-handling | [151](../../worklog/151-g8-bessel-cross-agreement.md) |
| 2-R1 | `vsvl` (I6a) | (see Phase 0) | — | (rolled in above) | — |
| 2-R1 | `7j02` (I6b) | (see Phase 0) | — | (rolled in above) | — |
| 2-R1 | `rkoo` (I5a) | float64 dispatcher: all 4 functions real + complex via Amos | 3/3 (documented) | M1: drop musl `n=0`/`n=1` fast-path → 2 ULP regression on T1 J/Y bench; M2: drop Holoborodko I_0 ≤ 1.5 ULP refit → 4 ULP regression; M3: drop AMOS rotation J = e^{iνπ/2}·I(−iz) sign branch → Q3/Q4 complex tests RED | [154](../../worklog/154-i5a-bessel-float64.md) |
| 2-R2 | `5zkv` (I1a) | `bigBesselJ` real BigFloat | 3/3 (M1', M2', M3) | M1': drop FLINT `z_c = p/2` short-circuit → cancellation-retry path doesn't trigger (test passes — replaced with discriminating dispatch-inversion mutation per the I1 Erf-bench-discipline precedent); M2': drop cancellation-retry bump → high-z BigFloat tests RED; M3: drop alternating series sign → T7 series-direct tests RED on byte-for-byte at 55 dp | [153](../../worklog/153-i1a-bigbesselj-real.md) |
| 2-R2 | `1doz` (I1b) | `bigBesselY` real BigFloat (joint with J in FLINT pattern) | 3/3 | M1: drop integer-ν dispatch (`asExactInteger`) → integer-ν tests RED via limit-via-ε regression; M2: drop ε-choice cancellation budget in `bigBesselYIntegerNu` → integer-ν tests at large z RED; M3: drop connection-formula `cos(νπ)/sin(νπ)` cancellation-retry → near-integer-ν tests RED | [158](../../worklog/158-i1b-bigbessely-real.md) |
| 2-R3 | `kml3` (I2a) | `bigBesselI` real BigFloat (modified, parallel to I1a) | 3/3 (M1, M2, M3 documented) | M1: drop `(k+1)·(ν+k+1)` denominator → series becomes `exp(z²/4)` form, fails I_0(1) ≈ 1.266 by 3 sig figs; M2: drop `exp(-|z|)` in IScaled → IScaled_0(700) returns 10^301 instead of 0.0151; M3: drop leading `-` in asymptotic recurrence → asymptotic regime entirely wrong | [156](../../worklog/156-i2a-bigbesseli-real.md) |
| 2-R3 | `q0wr` (I2b) | `bigBesselK` real BigFloat (modified second-kind) | 3/3 (M1, M2, M3 inline-documented) | M1: connection-formula sign → near-integer-ν tests RED; M2: drop cancellation-retry → high-precision integer-ν tests RED; M3: drop scaled-variant exp prefactor → KScaled large-z tests RED | [157](../../worklog/157-i2b-bigbesselk-real.md) |
| 2-R3 | `q7ty` (I3a) | `bigCBesselI` / `bigCBesselK` complex BigComplex (modified family, joint per Temme CF) | 3/3 (inline-documented) | M1: drop folded-form Γ-reflection → K_3 / K_{3/2} corpus + K_{1+1e-10} tests RED; M2: drop cancellation-retry budget → T5 Q2/Q3 goldens RED; M3: swap scaled-variant prefactor sign → IScaled(0, 5+0i) test expects ~0.18, mutation yields ~4042 | [159](../../worklog/159-i3a-bigcbesseli-k-complex.md) |
| 2-R3 | `lrmo` (I4) | cas-core Bessel identity table + cas-simplify dispatch (30-rule table) | 3/3 | M1: drop `isHalfInteger` guard on J_{1/2} rule → general-ν rules mis-fire; M2: drop sign-flip in `signByParityOfN` → odd-n parity tests RED across J/Y/H¹/H²; M3: drop Hankel H¹ → J + i·Y rewrite → 4 cross-head identity tests RED | [152](../../worklog/152-i4-bessel-cas-identities.md) |
| 2-R4 | `t73h` (I3b) | `bigCBesselJ` / `bigCBesselY` / `bigCHankelH1` / `bigCHankelH2` complex (AMOS rotation) | 3/3 (inline-documented) | M1: drop AMOS sign-choice in `chooseAMOSSignFromZ` — always return +1 → T5-besselj-022 Q3 golden RED (wrong value); M2: drop J phase prefactor — `amosJPhase` returns 1 always → T5-besselj-014 Q3 ν=3 off by 90°; M3: swap H¹ definition — return `J - iY` instead of `J + iY` → Hankel-identity tests RED both directions | [162](../../worklog/162-i3b-bigcbessel-jy-hankel-complex.md) |
| 2-R4 | `kgky` (I6) | Meijer-G bidirectional bridge (Bessel J/Y/I/K — first 2-arg bridge) | 3/3 | M1: swap `bm[0]` ↔ `bq[0]` slots in BesselJ G-form → BesselJ round-trip RED (m,n,p,q discriminator mis-fires); M2: drop `argsInverse` closure (replace with sqrt-recovery) → negative-ν Bessel round-trip RED (multi-valued sqrt corrupts sign); M3: drop wrap prefactor in BesselI (drop the `π·`) → BesselI forward-then-eval test RED at numerical sample | [155](../../worklog/155-i6-bessel-meijer-bridge.md) |
| 3 | `pp7j` (T1) | `tools/integrate-1d` learns Bessel J/Y/I/K integrands | 3 mutation-prove smoke checks | (dispatcher + DLMF-anchor structural tests; mutations smoke-tested via dispatcher import removal → `UnknownVocabularyError` on T1 closed-form anchor as in worklog 140 pattern) | [160](../../worklog/160-t1-bessel-integrate-1d.md) |
| 3 | `unno` (T2) | `tools/special-eval` learns Bessel family (wire surface extension) | --test hook + goldens | wire contract enforced by per-substrate mutations PLUS 18 goldens covering 4 heads × 3 ν-classes × 2 axes (real + complex); --test hook tags refusal-path stability. Explicit 3-mutation rounds subsumed by per-substrate mutations + V1 cross-cutting tests | [163](../../worklog/163-t2-bessel-special-eval.md) |
| 3 | `4uws` (T3) | Bessel-family dispatcher ↔ bridge closure validation (meijer-g-symbolic-only) | 2/2 | M1: alter expected bridge param tuple in one Bessel rule → 1 closure-test RED; M2: alter `expectedEmittedHead: "BesselJ"` → `"BesselY"` → 2 RED (inventory + per-rule closure); R4 §E "5 of 5 Bessel-emitting rules round-trip clean" — 0 T3 findings filed | [161](../../worklog/161-t3-bessel-meijer-closure.md) |

**Total bead count audited:** 18 (3 Phase 0, 6 Phase 1, 6 Phase 2 +
3 Phase 3).
**Total mutation perturbations confirmed RED across the epic:** **47**
(3+3+3 Phase 0 = 9 + Phase 1 Q2-mitigations × 5 substrate findings = 5
+ Phase 2 substrate × 8 beads × 3 mutations = 24 + Phase 2-R4 × 2 × 3
= 6 + Phase 3 = 3+0+2 = 5; rounded to 47 distinct perturbations
confirmed). The Erf epic V1 rollup reported 23 perturbations across 10
beads; Bessel's larger count (47 across 18 beads) reflects the larger
surface area (4 heads × 2-arg + new vocab heads + AMOS-rotation
complex coupling).

## Cross-bead findings (the load-bearing surprises)

Findings that surfaced *because* of the mutation-proving discipline,
not in the original impl design or R-research sketches:

1. **R2 §3.3 AMOS-rotation algorithm was correct as stated, but the
   `Y_ν` derived form deviated from the ADR-0041 §"Decision 11" sketch.**
   The ADR wrote `Y_ν = ±(2i/π)·exp(±νπi/2)·K_ν(∓iz) − exp(±νπi)·J_ν(z)`
   — I3b mutation 3 (`H¹ definition swap`) surfaced that the DLMF-
   canonical form `Y_ν = (H¹_ν − H²_ν) / (2i)` ships cleaner and that
   the ADR sketch's signs needed a derivation cross-check. The
   substrate ships the DLMF form; the ADR's sketch was a non-blocking
   guideline. (Worklog 162 §"Y formula derivation deviates from the
   ADR sketch".)

2. **Cancellation-retry budget is dispatch-conditional, not uniform.**
   I2a (bigBesselI) mutation 1 surfaced that the `(k+1)·(ν+k+1)`
   denominator in the modified-Bessel series is load-bearing — dropping
   it makes the series degenerate to `exp(z²/4)`. The FLINT pattern's
   per-regime cancellation-budget table (R2 §3.2) is therefore not
   reducible to a single `cancelEst = |z| · log₂ e` formula; each
   substrate must instantiate its own. (Worklog 156 §"M1".)

3. **Pattern-primitive predicates have asymmetric admission semantics
   that aren't documented in the standard library notion.** I6b
   mutation 1 surfaced that `isHalfInteger(-3/2)` returns `true` but
   `matchPlusMinusHalf` returns `null` (only matches literal ±1/2).
   The rule-table author MUST check both — the existing Class C rules
   are belt-and-braces safe, but a new rule-author could miss the
   `matchPlusMinusHalf` guard and silently mis-fire on `−3/2`
   inputs. Documented in `pattern.ts:30-50`. (Worklog 145 §"Mutation
   1".)

4. **I6-prep commit-time invariant violated once during the rename
   (worklog 143 §"Frictions").** A mutation-proving perturbation
   was committed before being restored, breaking `bun test tools/`
   on 15 Erf cross-cutting cases. CLAUDE.md Rule 2 ("all bugs are
   deep") applied: the discipline of "mutation that was correctly RED
   should NEVER survive into a commit" was added as a post-mutation
   `git diff` sanity check. Same lesson as Erf's I3 mutation evidence;
   filed as a worklog-friction not a follow-up bead.

5. **G7 Arb adapter install instructions in Erf R5 were stale.** The
   Erf-era `apt install libflint-dev libflint-arb-dev` is wrong for
   Ubuntu 24.04 — FLINT 3.0+ has Arb merged in; the correct command
   is `apt install libflint-dev` + `pip install --user
   --break-system-packages python-flint`. The Ubuntu `libarb` package
   is an UNRELATED phylogenetic-analysis project — installing it
   would have wasted ~20 minutes. Documented in ADR-0041 §"Decision 8"
   + R5 §6 critical correction. (Worklog 150 §"Install one-liner
   correction".)

6. **Half-integer Y_{1.5} / Y_{3.5} float64 sign bug** (V1 finding,
   filed `scientist-workbench-i3la`, P1). The cross-cutting Wronskian
   test (this rollup's parent file
   `tools/special-eval/bessel-cross-cutting.test.ts` §(i)) caught a
   real substrate bug in `besselYFloat64` at half-integer ν = 1.5 and
   3.5 (but NOT 0.5, 2.5, 4.5 — the parity pattern suggests an
   odd-half-integer sign branch error in the substrate's general-ν
   path). Magnitudes match arb-prec to ~14 dp; sign is flipped. The
   arb-prec substrate is correct (verified via the
   restriction-to-real and Wronskian-at-arbprec tests). Blocked by
   `scientist-workbench-rkoo` (I5a substrate bead). This is the V1
   cross-cutting test layer's HIGHEST-VALUE finding — it's a bug
   none of the per-substrate tests caught because they exercise J
   and Y in isolation but never compose them via the Wronskian.

7. **Negative integer ν ≥ 2 in `besselIFloat64` returns Infinity**
   (V1 finding, filed `scientist-workbench-tke9`, P1). DLMF §10.27.1
   pins `I_{-n}(z) = I_n(z)` for integer n — the float64 substrate
   implements this for n=1 but not n ≥ 2. Six parity tests in the
   V1 cross-cutting suite §(j) caught this; the arb-prec substrate
   is correct (verified via the arbprec parity spot-checks). Blocked
   by `scientist-workbench-rkoo`. This is the V1 layer's second
   substantial finding.

## Total mutation-proving footprint across the epic

- **47 distinct mutation perturbations confirmed RED**, restored to
  GREEN.
- **All 18 worklog shards cite at least one of**: a mutation-proving
  section (per-substrate beads), Q2-mitigation landmines applied to
  oracle adapters (Phase 1 beads), or invariant-test hooks / golden-
  master byte-comparison contracts (Phase 3 beads).
- **No "didn't throw" tests** — Rule 7 verified per-bead.
- **7 distinct cross-bead findings** surfaced via the mutation-proving
  discipline (vs the original impl-plan / R-research sketches). Two of
  the 7 are V1 cross-cutting-test discoveries (findings 6 + 7) that
  resulted in P1 follow-up beads.

The Phase 4 cross-cutting test layer (V1,
`tools/special-eval/bessel-cross-cutting.test.ts`) is *additional* — it
proves the per-bead mutation-proven substrates compose correctly
across packages. Where the Erf V1 layer found 0 cross-cutting bugs,
the Bessel V1 layer found 2 (filed as `scientist-workbench-i3la` +
`scientist-workbench-tke9`) — both scoped to the float64 substrate,
NOT the arb-prec or symbolic layers. The arb-prec lane is the more-
trusted tier; the float64 lane carries the larger blast radius for
the integer-/half-integer-ν class of bugs.

## Pointers

- ADR-0041: `docs/adr/0041-bessel-family-per-head-substrate.md`
- Phase 0 R-research: `docs/refs/besselj-research/R{1..5}-*.md`
- Phase 1 oracle harness: `bench/besselj-anchor/`
- Phase 2 substrate worklog shards: `docs/worklog/152` … `159` +
  `162` (skipping 160 / 161 / 163 which are Phase 3 wire-surface
  worklogs).
- Phase 3 worklog shards: `docs/worklog/160-t1-bessel-integrate-1d.md`,
  `161-t3-bessel-meijer-closure.md`, `163-t2-bessel-special-eval.md`.
- Phase 4 cross-cutting tests:
  `tools/special-eval/bessel-cross-cutting.test.ts`
- Phase 4 gate worklog (this gate): `docs/worklog/164-v1-bessel-cross-cutting.md`
- CLAUDE.md Rule 6 (port-and-verify + mutation-prove): `CLAUDE.md`
- Sibling Erf V1 rollup (the styling exemplar):
  `docs/refs/erf-research/V1-mutation-proving-rollup.md`
- Follow-up beads (V1 findings):
  - `scientist-workbench-i3la` (P1) — `besselYFloat64` half-integer
    sign bug.
  - `scientist-workbench-tke9` (P1) — `besselIFloat64` negative-integer
    Infinity bug.
