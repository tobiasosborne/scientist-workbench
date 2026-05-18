# HANDOFF — Gamma epic Phase 0 complete; Phase 1 ready to claim

> **Audience:** the next agent picking up the Gamma family epic
> (`scientist-workbench-xqc7`). Phase 0 (research + architecture) is done; this
> file pins where we are, what's committed, and the bead-registration step that
> remains before Phase 1 work can begin.
>
> **Date of handoff:** 2026-05-18.
> **Session that produced this:** the orchestration session that dispatched 6
> parallel Sonnet research subagents (R1, R2, R3, R4, R5, A1) and synthesised
> their findings into ADR-0042.
> **Re-read first:** [`CLAUDE.md`](../../../CLAUDE.md) two laws + twelve rules;
> [`docs/HANDOFF_per_head_special_function_methodology.md`](../../HANDOFF_per_head_special_function_methodology.md)
> for the proven 5-phase pattern.

---

## TL;DR — what to do first

1. **Read** `docs/adr/0042-gamma-family-per-head-substrate.md` (the architectural spine).
2. **Read** `docs/refs/gamma-research/PHASE2-impl-plans.md` (the per-bead Phase 2 detail).
3. **Register the Phase 1-4 beads** listed in §"Bead registration spec" below
   (~28 beads). Use `bd create` SEQUENTIALLY — the dolt embedded backend is
   single-writer; parallel `bd create &` calls will fail with
   `another process holds the exclusive lock`.
4. **Close the A0 bead** (`scientist-workbench-5wy3`) — the ADR is on disk;
   that bead is logically done. `bd close 5wy3 --reason="ADR-0042 landed at
   docs/adr/0042-... (status Proposed). Phase 1 unblocked."`
5. **Set dependency edges** via `bd update <child> --addBlockedBy=<parent>`
   (also sequential).
6. **Then dispatch Phase 1 G1 (corpus design)** to a subagent or do it yourself.
   See the corpus design notes in `PHASE2-impl-plans.md` §"Corpus design notes
   for Phase 1 subagents (G1-G8)".

---

## What's complete (Phase 0)

| Artefact | Path | Lines | Bead | Status |
|---|---|---|---|---|
| Epic | (n/a) | (n/a) | `scientist-workbench-xqc7` | open (epic-level; closes at end of Phase 4 D1) |
| R1 symbolic identities | `docs/refs/gamma-research/R1-symbolic-identities.md` | 1551 | `scientist-workbench-1gir` | ✓ closed |
| R2 arb-prec algorithms | `docs/refs/gamma-research/R2-arbprec-algorithms.md` | 1391 | `scientist-workbench-vf19` | ✓ closed |
| R3 float64 algorithms | `docs/refs/gamma-research/R3-float64-algorithms.md` | 1919 | `scientist-workbench-ldsf` | ✓ closed |
| R4 Meijer-G bridge | `docs/refs/gamma-research/R4-meijer-g-bridge.md` | 1001 | `scientist-workbench-o8yk` | ✓ closed |
| R5 oracle landscape | `docs/refs/gamma-research/R5-oracle-landscape.md` | 1293 | `scientist-workbench-hgt3` | ✓ closed |
| A1 codebase audit | `docs/refs/gamma-research/A1-codebase-audit.md` | 951 | `scientist-workbench-t4bc` | ✓ closed |
| ADR-0042 | `docs/adr/0042-gamma-family-per-head-substrate.md` | 784 | (A0 bead `5wy3`) | **open — close on pickup** |
| Phase 2 impl plans | `docs/refs/gamma-research/PHASE2-impl-plans.md` | 1171 | (part of A0) | committed |
| Two discovered beads | (filed by R1 subagent) | — | `h37z` (isNonPositiveInteger predicate), `0pvl` (bateman-5-6 unblock) | open; both P2; gate parts of Phase 2 |

All eight files above are **committed and pushed** to `origin/main` (commit
`189ca2c`). Working tree clean as of 2026-05-18 22:47.

## Load-bearing findings (read the ADR, but here are the headlines)

1. **`Gamma(z)` itself has NO Meijer-G form** — structural impossibility because
   `z` appears in the exponent `t^{z-1}` of the defining integral, requiring `z`
   in a parameter slot rather than the G-argument slot. R4 §A and ADR-0042
   §Decision 5. Only `IncompleteGammaUpper` and `IncompleteGammaLower` have
   G-forms. This is a feature of the math, not a substrate gap. The Gamma
   bridge file ships those two heads only; everything else returns `null` from
   `headToMeijerG`.

2. **Vocab admissions: 6 new heads** for ADR-0023 (LogGamma, Pochhammer,
   IncompleteGammaUpper, IncompleteGammaLower, Beta, BarnesG). Table grows
   32 → 38. I6a bead is the load-bearing Phase 2 Round 1 task.

3. **ADMITTED_HEADS (float64 dispatcher) is broader than the vocab list.**
   R3 wants 19 float64 entries including `IncompleteGammaP`, `IncompleteGammaQ`
   (regularised), `Trigamma`, `InverseIncompleteGammaP/Q`, `LogBeta`,
   `IncompleteBeta`, `Hyperfactorial`, `GammaRatio`, `GammaPDerivative`. R1
   defers these from the symbolic vocab as "derivable from admitted heads via
   trivial arithmetic", but the float64 dispatcher computes them directly for
   numerical stability. Precedent: Erf has `Erfcx` in float64 but as a derived
   simplification target, not a separate vocab head. ADR-0042 §Decision 6
   pins this distinction.

4. **L12 — the P/Q convention inversion is the single most dangerous trap.**
   SciPy `gammainc(a, z)` = P (lower regularised); Wolfram `GammaRegularized[a, z]`
   = Q (upper regularised). Pin in every oracle adapter; the comparator
   canonicalises; every test that touches P or Q must have an `// L12` comment.

5. **File-location compatibility exemption.** Existing `lgamma`, `gamma`,
   `digamma`, `trigamma`, `polygamma` live at `packages/bigfloat/src/special.ts`
   rather than the ADR-0040-mandated `packages/bigfloat/src/special-funcs/<head>.ts`.
   Moving them is high blast-radius — A1 found ~12 call sites of `cgamma` in
   `meijer-core/src/series.ts`. ADR-0042 amends ADR-0040 to allow EITHER
   location; existing substrate STAYS in `special.ts`; new heads (incomplete
   gamma, beta, barnes-g, pochhammer) ship in `special-funcs/<head>.ts`.

6. **Two install beads are P1 prerequisites for Phase 1 oracle work:**
   - `sudo apt install libboost-math-dev` — gates G5 (Boost silver-tier real oracle)
   - `sudo apt install libflint-dev && pip install --user --break-system-packages python-flint` — gates G7 (Arb gold-tier complex arb-prec oracle)

7. **Existing substrate is largely sound.** R2 audit: Stirling-shift in `special.ts`
   is correct; the threshold could be lifted from `work/8 ≈ 0.125·prec` to FLINT's
   `0.17·prec` (a one-line lift, not a rewrite). `clgammaReflect` and
   `cdigammaReflect` are the canonical cancellation-retry exemplar
   (`oj5j` / worklog 117).

8. **Concrete gaps to lift:**
   - `digamma(z, prec)` for `z < 0` non-integer currently throws — dead code,
     the complex version (`cdigammaReflect`) already implements it; ~30 LOC port.
   - `polygamma(m, z, prec)` for `m ≥ 2` currently throws (stub).
   - `ctrigamma`, `cpolygamma` absent entirely.

## Tensions resolved in ADR-0042

These came from contradictions between research subagents; the ADR pins the
resolution.

a) **R1 defers P/Q; R3 wants them in ADMITTED_HEADS.** Resolved: cas-core vocab
   admits 6 heads; float64 dispatcher admits ~19. Different lists.

b) **R4 says Γ has no G-form; previous mental model said it was foundational.**
   Resolved: Γ is foundational to G *as a coefficient* (Mellin-Barnes residues),
   not as a head expressible AS a G-function. Two roles, kept orthogonal.

c) **A1 found ADR-0040 file-location violation in special.ts.** Resolved:
   compatibility exemption; new heads follow ADR-0040 layout; existing stays.

## Critical landmines (cited from R5; reproduce in every oracle adapter prompt)

| ID | Description | Mitigation |
|---|---|---|
| L1 (carry from Erf) | Wolfram input-trap: `Gamma[1.5]` parses 1.5 as machine-precision double | ALWAYS construct as `Rational[num, den]` |
| L2 (carry from Erf) | mpmath/Wolfram rounding mismatch at last dp | Comparator canonicalises before equality |
| L_carryover (carry) | Wolfram `*^` exponent syntax | `StringReplace[..., "*^" → "e"]` in batch preamble |
| L12 | P/Q regularisation convention inversion (#1 trap) | Pin in every adapter; every test must `// L12` |
| L13 | `scipy.gammainccinv` inverts Q; `scipy.gammaincinv` inverts P | Pin in SciPy adapter |
| L14 | `scipy.polygamma(m, complex)` raises TypeError | SciPy refuses complex polygamma — `info` severity |
| L15 | `scipy.loggamma(real_negative)` = nan | Pass as `x + 0j` |
| L_pole | Γ at non-positive integer = ComplexInfinity in Wolfram, +∞ or NaN elsewhere | Comparator tolerates |
| L_polynew_3 | BarnesG sign convention differs (Vardi-Quine vs Adamchik) | Pin to Adamchik convention per ADR §Decision 8 |

Full set in `R5-oracle-landscape.md` §6.

---

## Bead registration spec (the remaining ~28 beads to file)

**Important sequencing notes:**
1. `bd create` calls MUST be sequential (dolt single-writer lock).
2. After creating, set dependency edges with `bd update <child> --addBlockedBy=<parent>`.
3. Use `--labels=gamma-anchor` on every bead; some get additional labels (see below).
4. All Phase-2 beads (round 1+) should be `blockedBy` `5wy3` (A0 ADR-0042) at filing time, then `5wy3` will be closed and the blockers self-resolve. Or: close `5wy3` FIRST (the ADR is already on disk), then file Phase 2 children unblocked.
   **Recommended order**: close A0 FIRST; file install beads → file Phase 1 beads → file Phase 2 beads → file Phase 3 beads → file Phase 4 beads. Each phase blocked on its predecessor's gate.

### Install beads (P1 — file first; gate G5 and G7)

```bash
bd create --title="[gamma] G-I-BOOST — Install libboost-math-dev for Phase 1 G5 oracle" \
  --description="Per R5 §1 + ADR-0042 §Decision 8. \`sudo apt install libboost-math-dev\` activates Boost.Math 1.83 cpp_bin_float<50> silver tier for 10 of 16 gamma-family real heads. Without this, G5 cannot run. Probe-confirmed via R5 environment audit (2026-05-18): boost headers NOT installed (regressed since Bessel R5 found them present). One command + one verification with \`echo '#include <boost/math/special_functions/gamma.hpp>' | g++ -E -\`. Estimate <5 min." \
  --type=task --priority=1 --labels=gamma-anchor,install
```

```bash
bd create --title="[gamma] G-I-FLINT — Install python-flint for Phase 1 G7 oracle" \
  --description="Per R5 §1 + ADR-0042 §Decision 8. \`sudo apt install libflint-dev && pip install --user --break-system-packages python-flint\` activates Arb (FLINT 3.0+) for gold-tier complex arb-prec oracle. R5-Bessel correction: do NOT install \`libflint-arb-dev\` (stale on Ubuntu 24.04); FLINT 3.0+ ships Arb merged. Without this, G7 cannot run. One install + one verification with \`python3 -c 'import flint; print(flint.__version__)'\`. Estimate <10 min." \
  --type=task --priority=1 --labels=gamma-anchor,install
```

### Phase 1 — Golden corpus + oracle adapters (9 beads)

```bash
# G1: orchestrator-authored corpus design (claim by orchestrator, not subagent)
bd create --title="[gamma] G1 — Corpus design (8 tiers × 16 heads × {real, complex})" \
  --description="Phase 1 corpus design for the gamma epic. Author \`bench/gamma-anchor/generate-corpus.ts\` — pure-TS Park-Miller LCG (seed = bead filing date YYYYMMDD per Erf/Bessel precedent). Tiers per PHASE2-impl-plans.md §'Corpus design notes': (T1) real positive z+a, (T2) real negative z, (T3) near-poles, (T4) complex Q1-Q4, (T5) half-integer a, (T6) large |z| (asymptotic), (T7) near a=z (Temme transition), (T8) digamma near negative integers. Target ~250-400 inputs total. Reproducible on re-run. Emit canonical-JSON wire form. ORCHESTRATOR work; not a subagent task. Output: bench/gamma-anchor/corpus.json + corpus-spec.md." \
  --type=task --priority=2 --labels=gamma-anchor

# G2: Wolfram (gold)
bd create --title="[gamma] G2 — Wolfram oracle adapter (gold tier, all 16 heads)" \
  --description="Wolfram Mathematica 14.3 adapter. Per Erf G2/Bessel G2 precedent. Batch mode mandatory (cold-start 3-8 s). Output: bench/gamma-anchor/oracles/wolfram/results.json. Pin landmines: L1 (Rational[num,den]), L_carryover (*^ → e), L_pole (ComplexInfinity ≡ NaN/Infinity). Coverage target: 16 heads × real + complex. Cite R5 §3 for invocation syntax per head; use \`GammaRegularized\` carefully per L12." \
  --type=task --priority=2 --labels=gamma-anchor

# G3: mpmath (gold)
bd create --title="[gamma] G3 — mpmath oracle adapter (gold tier)" \
  --description="mpmath 1.3.0 adapter. mp.dps=60 compute, emit at 55 dp. Per Erf G3/Bessel G3 precedent. Output: bench/gamma-anchor/oracles/mpmath/results.json. Pin landmines: L2 (rounding mismatch with Wolfram). Use mpmath.gammainc with regularized=True (Q) per L12; mpmath.betainc; mpmath.barnesg; mpmath.hyperfac; mpmath.rf (Pochhammer). Coverage target: all 16 heads × real + complex." \
  --type=task --priority=2 --labels=gamma-anchor

# G4: SciPy (bronze)
bd create --title="[gamma] G4 — SciPy oracle adapter (bronze tier, all 16 heads)" \
  --description="SciPy 1.11.4 adapter. Per Erf G4/Bessel G4 precedent. Output: bench/gamma-anchor/oracles/scipy/results.json. Pin landmines: L12 (scipy.gammainc = P, NOT Q); L13 (gammainccinv vs gammaincinv); L14 (polygamma raises TypeError on complex — refuse); L15 (loggamma real_negative = nan — pass +0j). Coverage: 14 of 16 heads (no BarnesG, no Hyperfactorial)." \
  --type=task --priority=2 --labels=gamma-anchor

# G5: Boost (silver, real)
bd create --title="[gamma] G5 — Boost cpp_bin_float<50> oracle adapter (silver tier, real-only)" \
  --description="Boost.Math 1.83 cpp_bin_float<50> adapter. g++ -std=c++17 batch. Per Erf G5/Bessel G5 precedent. Output: bench/gamma-anchor/oracles/boost/results.json. No complex (template fails per Erf R5 §1). Coverage: 10 of 16 heads (no BarnesG, no Hyperfactorial, no Pochhammer, no direct 1/Gamma). HONEST REFUSAL on unsupported heads. **BLOCKED on G-I-BOOST install bead.**" \
  --type=task --priority=2 --labels=gamma-anchor

# G6: Julia — deferred per orchestrator decision (carry from Erf/Bessel; algorithmically redundant with SciPy/Amos)
bd create --title="[gamma] G6 — Julia SpecialFunctions.jl oracle adapter (DEFERRED at filing time)" \
  --description="DEFERRED per orchestrator decision per Erf G6 / Bessel G6 precedent. Julia's gamma family ultimately wraps Cephes/Boost paths (same engines as SciPy); algorithmic diversity gain is minimal versus SciPy + Boost + Arb. Re-open if v0.2 wants additional bronze-tier voice. File as deferred; close immediately." \
  --type=task --priority=3 --labels=gamma-anchor,deferred

# G7: Arb (gold, complex arb-prec)
bd create --title="[gamma] G7 — Arb (FLINT 3.0+) oracle adapter (gold tier, complex arb-prec, ALL 16 heads)" \
  --description="Arb via python-flint. Per Bessel G7 precedent. Output: bench/gamma-anchor/oracles/arb/results.json. value_radius first-class. Auto-bump precision on cancellation retry. Closes the silver-tier complex arb-prec gap that Erf left open. **BLOCKED on G-I-FLINT install bead.** This is the LOAD-BEARING oracle for the complex paths — without Arb, complex gamma cells are single-engine-paired (Wolfram + mpmath only)." \
  --type=task --priority=2 --labels=gamma-anchor

# G8: Cross-agreement matrix
bd create --title="[gamma] G8 — Cross-agreement matrix + landmine downgrades + Phase 1 gate" \
  --description="Pure-TS comparator. Per Erf G8 / Bessel G8 precedent. Loads all oracles/*/results.json; classifies pair-wise comparisons by tier; produces agreement-matrix.md (human) + agreement-data.json (machine). Thresholds per ADR-0040 §Decision 8 + ADR-0042 §Decision 8 (extends with L_pole tolerance band, L12 P/Q convention discrimination, L_polynew_3 BarnesG-Adamchik canonical choice). Includes zero-crossing tolerance band (carry from Bessel) for digamma near negative integers. **Phase 1 GATE PASS criterion:** <50 unexplained findings (Erf had 8; Bessel had 0)." \
  --type=task --priority=2 --labels=gamma-anchor

# G9: Phase 1 QA gate
bd create --title="[gamma] G9 — Phase 1 QA gate (orchestrator)" \
  --description="Orchestrator-authored Phase 1 gate. Verify: corpus complete (G1); ≥4 oracle adapters green (G2-G5, G7); cross-agreement matrix green (G8); install beads closed. Mark Phase 1 closed and unblock all Phase 2 substrate beads. Update README catalog row." \
  --type=task --priority=2 --labels=gamma-anchor
```

### Phase 2 — Substrate implementation (12 beads in 4 rounds)

All beads documented in detail in `PHASE2-impl-plans.md`. Below are the
one-line files for `bd create`; the synthesizer wrote per-bead file layouts,
API signatures, algorithm narratives, test plans, mutation-proving spec, and
acceptance checklists in the impl plan doc.

**Round 1** (parallel; no Phase 2 prereqs beyond ADR landing):

```bash
bd create --title="[gamma] I6a — ADR-0023 amendment: admit 6 new vocab heads (LogGamma, Pochhammer, IncompleteGammaUpper/Lower, Beta, BarnesG)" \
  --description="Phase 2 Round 1. Per PHASE2-impl-plans.md §I6a + ADR-0042 §Decision 6. Append 6 heads to SPECIAL_FUNCTION_HEADS (32→38); add arity entries; add diff-rule cases per DLMF citations. ~90 LOC + ~60 LOC tests. Blocks I4, I6, T3." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I5 — float64 gamma-float64.ts (verbatim ports per R3, all 19 ADMITTED_HEADS)" \
  --description="Phase 2 Round 1. Per PHASE2-impl-plans.md §I5 + R3 §0.0 verbatim-port discipline + R3 §1 port table. NEW packages/quadrature/src/special-funcs/gamma-float64.ts + ADMITTED_HEADS extension. ~1200-1600 LOC total. Cephes (Moshier) primary + FreeBSD lgamma_r + Boost digamma/polygamma + SciPy _loggamma. Honest refusal for complex incomplete gamma + complex BarnesG. L12 guard tests required." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I4 — cas-core gamma-identities.ts (38 rules per R1 priority A-E)" \
  --description="Phase 2 Round 1. Per PHASE2-impl-plans.md §I4 + R1 §3 rule table. NEW packages/cas-core/src/special-funcs/gamma-identities.ts. ~700-900 LOC + ~450-600 LOC tests. 38 rules: 28 priority-A (special values + pole refusal) + 10 priority-B (integer/half-integer closures) + 17 priority-C (recurrences + reflection — load-bearing canonicalisation) + 5 priority-D (Legendre + Gauss multiplication + BarnesG functional eq) + 3 priority-E. Add applyGammaRewrites to simplify.ts pipeline. Depends on I6a (vocab) and on bead h37z (isNonPositiveInteger predicate)." \
  --type=task --priority=2 --labels=gamma-anchor
```

**Round 2** (after Round 1):

```bash
bd create --title="[gamma] I1a — digamma/trigamma negative-argument lift (~30 LOC unblock)" \
  --description="Phase 2 Round 2. Per PHASE2-impl-plans.md §I1a + A1 §1.1 gap + R2 §1.4 algorithm. Currently digamma(z, prec) for z<0 throws dead code. Mirror cdigammaReflect pattern (worklog 117 bead oj5j) on real axis: lossBits accounting + ψ(z) = ψ(1-z) + π·cot(πz) [DLMF 5.5.4]. Same for trigamma per DLMF 5.15.6. ~60-80 LOC in special.ts + ~30 LOC tests." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I1b — polygamma m≥2 via Hurwitz zeta (~200 LOC unstub)" \
  --description="Phase 2 Round 2. Per PHASE2-impl-plans.md §I1b + R2 §1.5/§2.2 derivation + A1 §1.1 gap. Currently polygamma(m, z) for m≥2 throws stub. Replace with ψ^(m)(z) = (-1)^(m+1)·m!·ζ(m+1, z) via Hurwitz Euler-Maclaurin + shift recurrence. ~120-160 LOC + 100 LOC Hurwitz helper + 60 LOC tests." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I2a — bigIncompleteGammaUpper + bigIncompleteGammaLower (arb-prec)" \
  --description="Phase 2 Round 2. Per PHASE2-impl-plans.md §I2a + R2 §1.7-1.8. NEW packages/bigfloat/src/special-funcs/incomplete-gamma.ts. 4-regime dispatch: series for γ (DLMF 8.7.3) + CF for Γ_upper (DLMF 8.9.2 Lentz) + Temme uniform (defer to v0.2; CF fallback in transition region) + Poincaré asymptotic. Complementarity γ+Γ=Γ(a) round-trip test load-bearing. ~350-450 LOC + 150 LOC tests. Blocks I2b and I6 bridge." \
  --type=task --priority=2 --labels=gamma-anchor
```

**Round 3** (after Round 2):

```bash
bd create --title="[gamma] I2b — bigGammaP + bigGammaQ (regularised, float64-stable arb-prec)" \
  --description="Phase 2 Round 3. Per PHASE2-impl-plans.md §I2b + R2 §1.9. ~80-120 LOC additions to incomplete-gamma.ts. Compute smaller of P/Q directly via γ or Γ_upper / Γ(a); avoid catastrophic cancellation. L12 guard test required (P and Q distinct, sum to 1)." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I3a — bigBeta + bigLogBeta (arb-prec)" \
  --description="Phase 2 Round 3. Per PHASE2-impl-plans.md §I3a + R2 §1.10. NEW packages/bigfloat/src/special-funcs/beta.ts. logBeta = lgamma(a)+lgamma(b)-lgamma(a+b); Beta = exp(logBeta) with sign(Γ(a))·sign(Γ(b)). ~60-80 LOC + 40 LOC tests. Beta(1/2,1/2) = π golden." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I3b — bigPochhammer (arb-prec)" \
  --description="Phase 2 Round 3. Per PHASE2-impl-plans.md §I3b + R2 §1.6. NEW packages/bigfloat/src/special-funcs/pochhammer.ts. Dispatch: direct product for small integer n, lgamma-ratio for large/non-integer. ~70-90 LOC + 40 LOC tests." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I3c — bigBarnesG (arb-prec, real)" \
  --description="Phase 2 Round 3. Per PHASE2-impl-plans.md §I3c + R2 §1.13/§2.8 Adamchik 2001 + DLMF §5.17.5. NEW packages/bigfloat/src/special-funcs/barnes-g.ts. Asymptotic + Glaisher-Kinkelin constant (cache at prec+64). Functional equation BarnesG(z+1)=Γ(z)·BarnesG(z) recursion for small z. ~100-140 LOC + 50 LOC tests. Integer values BarnesG(1)=1, BarnesG(4)=2, BarnesG(5)=12 are goldens." \
  --type=task --priority=2 --labels=gamma-anchor
```

**Round 4** (after Round 3):

```bash
bd create --title="[gamma] I3d — Complex extensions (ctrigamma, cpolygamma, cIncompleteGamma{Upper,Lower}, cBeta)" \
  --description="Phase 2 Round 4. Per PHASE2-impl-plans.md §I3d + A1 §2 AXIS 4 gap list. Additions to packages/bigfloat/src/complex.ts. ctrigamma via Stirling-shift (mirror cdigammaShifted); cpolygamma via complex Euler-Maclaurin + DLMF 5.15.6 reflection; cIncompleteGamma series+CF generalised to BigComplex; cBeta via clgamma sum/difference. ~200-280 LOC + 80 LOC tests. Real-axis agreement test load-bearing (ctrigamma(1)=π²/6)." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] I6 — Meijer-G bridge bridges/gamma.ts (2 heads + 7 honest nulls)" \
  --description="Phase 2 Round 4. Per PHASE2-impl-plans.md §I6 + R4 §A-C + ADR-0042 §Decision 5. NEW packages/meijer-core/src/bridges/gamma.ts. Only IncompleteGammaUpper (G^{2,0}_{1,2}) and IncompleteGammaLower (G^{1,1}_{1,2}) have G-forms (R4 §A). Forward bridge returns ForwardBridge for these 2; null for Gamma, LogGamma, Beta, Digamma, Polygamma, Pochhammer, BarnesG (structural impossibility — Γ has no G-form because z appears in exponent). Backward bridge (2,0,1,2)-shape discrimination: bm=[0,1/2]→Erfc, bm=[0,0]→ExpIntegralE(1,z), else→UpperIncompleteGamma. ~200-260 LOC + 100 LOC tests. Blocks T3." \
  --type=task --priority=2 --labels=gamma-anchor
```

### Phase 3 — Tool integration (3 beads)

```bash
bd create --title="[gamma] T1 — tools/integrate-1d learns Gamma family in integrand" \
  --description="Phase 3. Per Erf T1 / Bessel T1 precedent. Test that I5 dispatcher picks up Gamma/LogGamma/Digamma/Polygamma/IncompleteGamma/Beta/BarnesG/Pochhammer in integrand. Add ≥4 new goldens citing DLMF closed-form integrals (e.g. ∫₀^∞ x^(a-1)·e^(-x) dx = Γ(a); ∫₀^1 x^(a-1)(1-x)^(b-1) dx = B(a,b)). If composition gap surfaces (Erf T1 found one), fix in dispatcher hook (not substrate)." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] T2 — tools/special-eval extension (16 gamma family heads)" \
  --description="Phase 3. Per Erf T2 / Bessel T2 precedent. Extend tools/special-eval/tool.ts per-head dispatch table with all 16 gamma family heads × {real, complex} × {float64, arb-prec}. New flags: --a, --n (for 2-arg heads). Add ≥16 goldens (1 per head minimum). Per-output tier conditioning per ADR-0040 §Decision 9. Byte-identical to gold-tier (Wolfram + mpmath + Arb) at 50+ dp on representative inputs." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] T3 — meijer-g-symbolic-only closure validation for Gamma family" \
  --description="Phase 3. Per Erf T3 / Bessel T3 precedent. Survey every existing dispatch rule in packages/meijer-core/src/dispatch-rules/ that involves Gamma family. Round-trip through I6 bridge byte-identically. Specifically test the IncompleteGamma{Upper,Lower} canonical forms; verify ExpIntegralE(1,z) backward-discrimination (bm=[0,0] case) does NOT route to UpperIncompleteGamma(0,z). Verify bateman-5-6 unblocked rules (per discovered bead 0pvl) round-trip cleanly. File any findings as P2 follow-up beads." \
  --type=task --priority=2 --labels=gamma-anchor
```

### Phase 4 — Verification + docs (2 beads)

```bash
bd create --title="[gamma] V1 — Cross-cutting verification + mutation-proving rollup" \
  --description="Phase 4. Per Erf V1 / Bessel V1 precedent. ONE test file ~50 tests / 100+ expects covering 8 cross-cutting invariants spanning multiple substrate layers: (a) special-eval @ p≤53 ≡ direct float64; (b) special-eval @ p=N ≡ direct bigfloat; (c) complex(x+0i) ≡ real(x); (d) cas-simplify cross-head identity collapses; (e) Meijer-G round-trip byte-identical; (f) end-to-end integral via integrate-1d matches closed form; (g) foreign pass-through byte-identical; (h) determinism 5-repeat byte-identical. Plus 2 gamma-specific: (i) Γ(z+1)=z·Γ(z) recurrence holds at arb-prec for non-integer z; (j) γ(a,z)+Γ(a,z)=Γ(a) complementarity at arb-prec. Plus mutation-proving rollup audit document: docs/refs/gamma-research/V1-mutation-proving-rollup.md (target: ≥30 documented mutation points across the epic per Bessel V1 precedent of 47). bun run check green is the V1 gate." \
  --type=task --priority=2 --labels=gamma-anchor

bd create --title="[gamma] D1 — Docs lockstep + epic-close worklog + ADR-0042 status amendment" \
  --description="Phase 4 epic close. Per Erf D1 (worklog 142) / Bessel D1 (worklog 166) precedent. Verify all per-package READMEs in lockstep. ADR-0042 status amendment Proposed → Implemented (cite epic-close worklog by number). Epic-close worklog shard (~400-500 lines: Context → What changed → Why these choices → Frictions surfaced → Acceptance → Bead-count audit → Pointers). bd close <epic-id xqc7> with substantive closing note." \
  --type=task --priority=2 --labels=gamma-anchor
```

### Dependency edges to set after creation

Save bead IDs from each `bd create` (printed on the line `✓ Created issue: scientist-workbench-XXXX`). Then set edges:

```bash
# G5 depends on G-I-BOOST install
bd update <G5-id> --addBlockedBy=<G-I-BOOST-id>

# G7 depends on G-I-FLINT install
bd update <G7-id> --addBlockedBy=<G-I-FLINT-id>

# G8 depends on G2, G3, G4, G5, G7
bd update <G8-id> --addBlockedBy=<G2-id> --addBlockedBy=<G3-id> --addBlockedBy=<G4-id> --addBlockedBy=<G5-id> --addBlockedBy=<G7-id>

# G9 depends on G8 + G1
bd update <G9-id> --addBlockedBy=<G8-id> --addBlockedBy=<G1-id>

# Phase 2 Round 1 blocked on Phase 1 G9 (gate) + epic xqc7 ADR landing (already done)
bd update <I6a-id> --addBlockedBy=<G9-id>
bd update <I5-id>  --addBlockedBy=<G9-id>
bd update <I4-id>  --addBlockedBy=<G9-id> --addBlockedBy=<I6a-id> --addBlockedBy=scientist-workbench-h37z

# Phase 2 Round 2 blocked on Round 1
bd update <I1a-id> --addBlockedBy=<I6a-id>
bd update <I1b-id> --addBlockedBy=<I6a-id>
bd update <I2a-id> --addBlockedBy=<I6a-id>

# Phase 2 Round 3 blocked on Round 2
bd update <I2b-id> --addBlockedBy=<I2a-id>
bd update <I3a-id> --addBlockedBy=<I1a-id>
bd update <I3b-id> --addBlockedBy=<I1a-id>
bd update <I3c-id> --addBlockedBy=<I1a-id>

# Phase 2 Round 4 blocked on Round 3
bd update <I3d-id> --addBlockedBy=<I3a-id> --addBlockedBy=<I3b-id> --addBlockedBy=<I3c-id> --addBlockedBy=<I1b-id>
bd update <I6-id>  --addBlockedBy=<I2a-id> --addBlockedBy=<I6a-id> --addBlockedBy=scientist-workbench-0pvl

# Phase 3 blocked on Phase 2 (all rounds complete)
bd update <T1-id> --addBlockedBy=<I5-id>
bd update <T2-id> --addBlockedBy=<I5-id> --addBlockedBy=<I3d-id>
bd update <T3-id> --addBlockedBy=<I6-id>

# Phase 4 blocked on Phase 3
bd update <V1-id> --addBlockedBy=<T1-id> --addBlockedBy=<T2-id> --addBlockedBy=<T3-id>
bd update <D1-id> --addBlockedBy=<V1-id>
```

## Two pre-existing beads from R1 discovery (already filed, just confirm they're tracked)

- `scientist-workbench-h37z` (P2) — cas-core: add `isNonPositiveInteger` predicate to `pattern.ts`. Blocks `I4` gamma-identities (pole-refusal rules need it).
- `scientist-workbench-0pvl` (P2) — meijer-core: unblock `bateman-5-6.ts` incomplete-gamma dispatch rules (`bateman-5-6.ts:678-679` dormant TODO). Blocks `I6` (closure tests reference these rules).

Both should be confirmed in dependency edges above.

## What was NOT done in the previous session

1. **Bead registration** — the 28 beads enumerated above are NOT yet in beads. The full spec is in this file. Register sequentially per the dolt single-writer constraint.
2. **A0 bead close** — bead `5wy3` is still open; the ADR is on disk; just `bd close 5wy3 --reason="..."`.
3. **Phase 1 work** — not started. Earliest claimable after bead registration + install beads: `G1` (orchestrator) + `G2`/`G3`/`G4` (no install deps).

## Resume checklist

```
[ ] bd close scientist-workbench-5wy3 --reason="ADR-0042 landed at docs/adr/0042-gamma-family-per-head-substrate.md (status Proposed, 784 lines). PHASE2-impl-plans.md shipped (1171 lines). Phase 1 unblocked. See docs/refs/gamma-research/HANDOFF-phase0-to-phase1.md for next steps."
[ ] Register install beads (G-I-BOOST, G-I-FLINT) — sequential bd create calls
[ ] Register Phase 1 beads G1-G9 — sequential
[ ] Register Phase 2 beads I6a, I5, I4, I1a, I1b, I2a, I2b, I3a, I3b, I3c, I3d, I6 — sequential
[ ] Register Phase 3 beads T1, T2, T3 — sequential
[ ] Register Phase 4 beads V1, D1 — sequential
[ ] Set dependency edges via bd update --addBlockedBy — sequential
[ ] Verify bd ready shows G1, G2, G3, G4, G-I-BOOST, G-I-FLINT as the first claimable work
[ ] git pull --rebase if needed; commit any new state; push
[ ] Begin Phase 1: claim G1 (corpus design) — orchestrator authors; dispatch G2/G3/G4 in parallel to subagents (G5 + G7 wait for install beads)
```

## Files to read in priority order

1. `CLAUDE.md` (two laws + twelve rules — re-read every session)
2. `docs/HANDOFF_per_head_special_function_methodology.md` (the canonical methodology — already validated by Erf and Bessel)
3. `docs/adr/0042-gamma-family-per-head-substrate.md` (the architectural spine for this epic)
4. `docs/refs/gamma-research/PHASE2-impl-plans.md` (per-bead Phase 2 detail)
5. This file (handoff)
6. `docs/refs/gamma-research/R5-oracle-landscape.md` (read landmines section before any oracle-adapter work)
7. `docs/refs/gamma-research/A1-codebase-audit.md` (read before any uplift work on `special.ts`)
8. The other R-research artefacts as needed by the specific bead claimed

## Pointers

- **Epic**: `bd show scientist-workbench-xqc7`
- **A0 (close on pickup)**: `bd show scientist-workbench-5wy3`
- **All gamma beads**: `bd list --label=gamma-anchor`
- **Erf precedent**: `docs/worklog/142-erf-epic-close.md`
- **Bessel precedent**: `docs/worklog/166-bessel-epic-close.md`
- **Methodology**: `docs/HANDOFF_per_head_special_function_methodology.md`

The session that produced this handoff dispatched the 6 Phase 0 subagents,
synthesised ADR-0042 + PHASE2-impl-plans.md via a parallel synthesizer agent,
and ran out of session before the bead-registration step. All artefacts are
committed and pushed (commit `189ca2c`). Pick up at the resume checklist.
