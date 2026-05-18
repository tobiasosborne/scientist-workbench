# Erf Reference-Implementation Research

This directory is the Phase 0 research anchor for the "world-class Erf"
orchestration tracked under the `erf-anchor` bead label. Goal: ship the
reference implementation of `Erf` across symbolic identities,
arbitrary-precision evaluation, float64 numerical evaluation, and
bidirectional Meijer-G bridge, then generalise the pattern across every
head in the `cas-core` special-function vocabulary (ADR-0023).

## Orchestration overview

Five phases, gated. See epic `scientist-workbench-43hw` for the full
plan; the 26 sub-beads are filed under label `erf-anchor`.

```
Phase 0 — Research & architecture (parallel)
  R1 kvfu — SOTA symbolic identities (DLMF, Wolfram Functions, SymPy)
  R2 9jpm — SOTA arb-prec algorithms (Arb, mpmath, Boost, Karbach)
  R3 1i5z — SOTA float64 algorithms (Cephes, Boost, Julia, libm, Faddeeva)
  R4 lnux — Meijer-G bridge forms (Bateman §5.6, Adamchik-Marichev)
  R5 u4pe — Oracle landscape survey (local Wolfram/mpmath/SciPy/Julia/Boost/Arb)
  ─── GATE: synthesize ───
  A0 ss5o — ADR-0040 (per-head substrate + Meijer-G bridge, Erf prototype)

Phase 1 — Oracle harness & golden corpus
  G1 9sqr — Corpus tier design (real-small, real-large, imag, complex, edge, Stokes)
  G2 ufgd — Wolfram oracle adapter (gold)
  G3 m7q0 — mpmath oracle adapter (gold)
  G4 1f8r — SciPy oracle adapter (bronze)
  G5 6u3m — Julia oracle adapter (silver + bronze)
  G6 x1lt — Boost.Math oracle adapter (silver + bronze)
  G7 rmst — Arb/FLINT oracle adapter (gold, if available)
  G8 68ir — Cross-oracle agreement matrix + disagreement triage
  ─── GATE: corpus quality ───

Phase 2 — Substrate implementation
  I1 q30j — bigErf real (BigFloat)
  I2 g82u — bigErfc + bigErfcx (scaled)
  I3 wzzq — complex bigErf via Faddeeva w(z) (BigComplex)
  I4 bfwt — cas-core Erf identity table (cas-simplify integration)
  I5 xiry — float64 Erf dispatcher in @workbench/quadrature::evalNumericExpr
  I6 tc2c — Meijer-G bridge for Erf (headToMeijerG + meijerGToHead)

Phase 3 — Tool integration
  T1 3ynw — tools/integrate-1d learns Erf in integrand
  T2 457k — tools/special-eval (or tools/erf) per-head arbprec wire tool
  T3 el7c — meijer-g-symbolic-only Erf-emission closure validation

Phase 4 — Verification + docs lockstep
  V1 52gu — Property tests + mutation-proving + golden-master suite green
  D1 zk2d — Docs lockstep + worklog 131 + close epic 43hw
```

## Research artefacts

Each `R{n}` bead produces a deep-research Markdown in this directory.
Inline executive summaries are attached to the bead as `notes`; the
full artefact stays here for the ADR synthesis pass and as a
reproducibility record.

| Artefact | Bead | Status |
|---|---|---|
| `R1-symbolic-identities.md` | `kvfu` | ✓ shipped (38 rules; 22 v0.1-shippable) |
| `R2-arbprec-algorithms.md` | `9jpm` | research subagent in flight |
| `R3-float64-algorithms.md` | `1i5z` | research subagent in flight |
| `R4-meijer-g-bridge.md` | `lnux` | research subagent in flight |
| `R5-oracle-landscape.md` | `u4pe` | research subagent in flight |

## Decision principle

Every architectural and implementation choice is answered by the
question *"what would a legendary TS senior SE demand"*: branded types
(`Precision`, `RealBigFloat`, `ComplexBigFloat`), discriminated unions
over string dispatch, total functions, deterministic forever per
ADR-0020, literate prose comments (CLAUDE.md Rule 10), property tests
+ mutation-proving (Rule 6), no half-finished implementations
(CLAUDE.md "Doing tasks").

## Why Erf as the anchor

Erf is the smallest head that exercises *every* axis of the per-head
substrate (symbolic + arb-prec + float64 + bidirectional Meijer-G
bridge) without the complications of multi-parameter dispatch
(Bessel), branch cuts (logarithm family), or multi-valued list
parameters (HypergeometricPFQ, MeijerG). It has a real downstream
consumer (`bigErfc` for Berry smoothing in the Stokes band, bead
`ybrw`). Once the pattern is established, Bessel, Gamma upgrades,
ParabolicCylinderD, Whittaker, and the orthogonal-polynomial family
all reuse the same substrate shape.
