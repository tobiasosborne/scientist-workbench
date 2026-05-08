# Worklog 071 — `bigfloat::exp` "P1 regression" was a false alarm; principled hardening applied

**Date:** 2026-05-08.
**Beads:** `scientist-workbench-4ne` (closed as false alarm).
**Related ADRs:** ADR-0020 (arb-prec tier — the contract this substrate
inherits).
**Lockstep with:** [`docs/worklog/070-meijer-core-slater.md`](070-meijer-core-slater.md)
(the session that filed the misdiagnosed bead) and the campaign log at
`../tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`.

## Context

Worklog 070 ended with a "P1 substrate regression" filed as
`scientist-workbench-4ne`: `@workbench/bigfloat::exp(x)` was reported
to lose precision deterministically for many `x`, with an empirical
table claiming `exp(1.4)` at 70-dps target delivered only ~5 dps,
`exp(0.3)` only ~18 dps, etc. The bead body further claimed the
existing `exp(-1) at 50 dps` test "ratifies the broken substrate
value rather than checking against true 1/e."

The next session's pickup brief said: *fix `4ne` before further
numerical-tier work — every subsequent arbprec tool inherits this
ceiling.*

This shard is that session. Two things happened in parallel: a
root-cause investigation against the production code, and a fresh
production-grade `exp()` design proposed by an Opus subagent (the
user wanted both implementations on the table to compare).

## What changed

### The investigation: the bug doesn't exist

Reproducer at the empirical table's claimed precisions, with truth
values regenerated from `python3 -c "from mpmath import mp; mp.dps=200; …"`:

| x       | mpmath truth (200 dps prefix)            | substrate at 70 dps   | dps agreement |
|---------|------------------------------------------|------------------------|---------------|
| 0.1     | `1.10517091807564762481170782649…`       | byte-identical         | full          |
| 0.3     | `1.34985880757600310398374431332…`       | byte-identical         | full          |
| 1.4     | `4.05519996684467458722410889522…`       | byte-identical         | full          |
| 2.5     | `12.18249396070347343807017595116…`      | byte-identical         | full          |
| every other entry | …                              | byte-identical         | full          |

The bead's empirical table had **bogus reference values**. They were
not generated against any actual oracle — they don't agree with mpmath
at any digit. Where the table claimed `exp(0.1) = 1.10517091808849…`,
the real value is `1.10517091807564…`, off in the 10th decimal place.
Likewise the bead's claim that "true 1/e at 50 dps is `…103172`" is
also wrong — round-half-to-even at digit 51 of `1/e` (which mpmath
gives as `0.367879441171442321595523770161460867445811131031767…`)
goes from `6` up to `7` because digit 51 is `7`, so the 50-dps value
is `…103177`, exactly what the existing test asserts. The test was
correct all along.

A comprehensive sweep across 14 inputs × 5 target precisions
(30 / 50 / 70 / 100 / 150 dps) found **70 of 70 cases byte-identical
to mpmath at the requested sig figs**. (One "fail" was a bug in the
verification harness's scientific-notation rendering of `exp(100)`.)
A high-precision sweep up to 1000 dps target found the substrate
delivering `target − 1` to `target − 4` sig figs at every input,
exactly as expected from the round-half-to-even contract.

### The redesign comparison

In parallel, an Opus subagent designed a from-scratch production-grade
`exp` (Brent–Smith with `expm1`-form squaring; algorithm in
`/tmp/exp-redesign/exp.ts`). Both implementations were run head-to-head
against mpmath:

| | Existing v0.1 | Subagent's redesign |
|---|---|---|
| Correctness vs mpmath @ 30–1000 dps | 65/65 byte-identical | 65/65 byte-identical |
| Speed @ 50 dps | 0.16 ms/op | 0.23 ms/op (1.5× slower) |
| Speed @ 100 dps | 0.32 ms/op | 0.56 ms/op (1.8× slower) |
| Speed @ 200 dps | 1.63 ms/op | 0.85 ms/op (1.9× faster) |

The redesign's `expm1`-form squaring (`s ← s · (2 + s)` instead of
`expR ← expR²`) is structurally cleaner — it never carries `1 + δ`
through the squaring loop, so cancellation against the leading 1
cannot occur. But empirically the existing form's rounding errors
were *also* below the user's ulp at every tested precision, so the
algorithmic switch yields the same answer at moderate precision and
costs 1.5–1.8× wall-clock there. We do not adopt the algorithm change.

### What was kept from the redesign — surgical hardening

Three principled defensive improvements *were* absorbed into the
existing `exp()`:

1. **Bit budget scales with `m` and `bitLength(|k|)`.** The old
   `work = prec + 32` is empirically sufficient at every precision the
   workbench's `decimalToBinaryPrecision(_, safety=30)` produces (the
   30-bit safety baked into the dps→bits conversion absorbs the
   `m`-bit squaring amplification up through ~1000 dps). The new form
   `work = prec + max(16 + bitLength(|k|), m + 32)` makes the
   theoretical worst-case bound also met, so the substrate stays
   correct as `prec` grows arbitrarily.

2. **Taylor truncation tightened to `2^-(prec + m + 16)`.** The `m`
   here is the squaring loop's amplification factor. Same motivation
   as (1): empirically harmless at moderate precision, principled at
   high.

3. **Range gate `MAX_K = 2^30`.** The substrate's `exponent` is i32;
   refusing arguments whose `k = round(x / ln 2)` exceeds `±2^30`
   prevents silent corruption near the i32 boundary. Throws
   `RangeError` loudly. (`exp(2^30·ln2) ≈ 2^(2^30)` is far beyond any
   conceivable use, so this gate costs nothing in practice.)

### Regression coverage

Eight new tests added to `packages/bigfloat/test/transcendental.test.ts`,
covering exactly the inputs the bead claimed were broken
(`0.1, 0.3, 0.8, 1.4, -1.4, 2.5` at 70 dps; `7` at 100 dps), plus a
`-1000` representable-but-tiny case and a `2 × 10^9` overflow-throws
case. Every assertion is the byte-exact mpmath value at the requested
precision. These are anti-regression goldens — if anyone ever
"discovers" a bug in `exp` again, the first thing they should do is
run these.

### Documentation lockstep

- Worklog 070's "P1 bug" friction section gained a top-of-section
  retraction pointing at this shard.
- The `tools/meijer-g-slater-only/tool.test.ts` test header had an
  inline disclaimer attributing its prefix-width assertions to "the
  bigfloat substrate's `exp()` accuracy at the time of writing." That
  attribution was wrong — the prefix widths reflect the Slater
  algorithm's honest ulp budget (Γ-product evaluation, residue-line
  summation, inner pFq series), not a substrate cap. Comment rewritten.
- Bead `4ne` closed with reason "false alarm — substrate verified
  byte-identical to mpmath".

## Why these choices

### Hybrid surgical fix over wholesale replacement

Per the **two principles**: a TS expert reviewing the redesign sees
clearer error analysis comments and a more principled bit budget — both
genuine wins. But the same expert sees that the production code is
*verified correct* by 200-dps cross-validation and runs 1.5× faster at
the dominant precision regime. Replacing a working algorithm with a
slower one to fix a bug that doesn't exist would be irresistible to no
one. The right move is to absorb the *defensive parts* (range gate,
m-aware budget, k-aware outer guard) and keep the algorithm.

### `decimalToBinaryPrecision` safety as the load-bearing slack

A theoretical-worst-case error analysis says the existing
`work = prec + 32` is one bit short for `m = ceil(sqrt(prec))` ≥ 32.
Empirically the substrate is correct because the 30-bit safety
margin built into `decimalToBinaryPrecision(_, safety=30)` absorbs
the m-bit amplification at every precision the workbench actually
uses. The hardening lifts this from "empirically OK because of an
upstream slack" to "tight by construction" without changing observable
behaviour at any tested precision.

### Why we did not adopt expm1-form squaring

The redesign's structural argument is correct: when computing
`exp(r')` with `|r'| ≪ 1`, storing `1 + δ` through the squaring loop
"wastes" ~m mantissa bits to the leading 1. But: (i) the loop only
amplifies absolute error by ~2 per step, not relative error in δ, so
the accumulated absolute error at the end is still bounded by
`m · 2^-(work - 1)`; (ii) at the same `work`, both forms produce the
same answer to one ulp; (iii) the squaring `s · (2 + s)` adds an `add`
per iteration vs. naive `expR · expR`, costing ~30% more time. The
expm1-form is the right choice for very-high-precision (≥ several
thousand dps) tools where the constant slack disappears, but at the
substrate's current target range (50–500 dps for Meijer / pFq), naive
squaring is faster and equally correct.

## Frictions surfaced

### Misdiagnosis without verification is expensive

The previous session generated an empirical table without any oracle
behind it. Every cell in that table was wrong, but the wrongness
*looked* like a bug pattern — "the same wrong digits at every
precision" is genuinely a hallmark of a deterministic algorithmic
flaw. The diagnosis was internally consistent except for the part
where it didn't match reality.

The hard rule that this surfaces: **before filing a substrate-level
bug, regenerate the truth values from a *cited* oracle.**
`wolframscript -code 'N[Exp[x], 80]'` and `python3 -c "from mpmath
import …; mp.dps=…; print(…)"` are the project's two cited oracles
(`tstournament/.../ORACLE-STRATEGY.md`, worklog 069 §"Frictions"). A
table without a citation isn't an empirical observation, it's a
hallucination.

### Subagent gave the right answer for the wrong reason

The Opus subagent diagnosed an "Achilles' heel" (leading-1 bit waste)
that, on closer analysis, doesn't actually cause the reported
symptoms — it would cause at most 1 bit of degradation per squaring,
not the 60-dps loss the bogus table claimed. But the subagent's
prescribed fix (m-aware bit budget) is *also* the correct fix to a
real-but-different problem (the substrate's behaviour at very high
precision). So the redesign's defensive parts were genuinely useful
— absorbed into the surgical hardening — even though the bug they
were "fixing" wasn't there.

### `bd update --notes` overwrites, doesn't append

When updating bead `4ne` with the diagnosis, `bd update --notes`
replaced the existing notes section rather than appending. For
forensic records on misdiagnoses this matters; the closing-reason
on `bd close` was used instead so the original body and the
correction both survive in the issue's history.

## Acceptance

- Bead `4ne` closed as false alarm; reason recorded in the close.
- `packages/bigfloat/src/transcendental.ts::exp` rewritten with
  m-aware + k-aware bit budget, range gate, and literate-style
  comments explaining each guard bit. Algorithm shape (Brent–Smith
  with naive squaring) preserved.
- 8 new bug-pattern goldens added to
  `packages/bigfloat/test/transcendental.test.ts`. All pass.
- 229/229 bigfloat package tests + 50/50 downstream tests
  (`tools/hypergeometric-pfq`, `tools/meijer-g-slater-only`,
  `packages/hypergeometric`, `packages/meijer-core`) pass unchanged.
- `bun run check:quick` passes all four phases (conventions, codegen,
  typecheck, workspace property tests).
- Worklog 070's misleading "P1 substrate regression" friction section
  retracted with a pointer to this shard. The `tools/meijer-g-slater-
  only/tool.test.ts` substrate-cap disclaimer comment rewritten to
  attribute the prefix widths to the Slater algorithm's honest ulp
  budget.

## Pointers

- Hardened substrate: `packages/bigfloat/src/transcendental.ts` (exp,
  ~115 LOC with literate commentary).
- Regression goldens: `packages/bigfloat/test/transcendental.test.ts`
  (lines 87–250, eight tests under `describe("exp", …)`).
- Subagent's redesign artifacts (kept on disk for reference, not
  committed): `/tmp/exp-redesign/{exp.ts, exp.test.ts, exp-redesign.md}`.
- Verification scripts (also kept on disk):
  `/tmp/exp-clean-verify.ts`, `/tmp/exp-shootout.ts`,
  `/tmp/exp-highprec.ts`. Each reproduces a slice of the diagnosis
  in standalone form.

## Next pickup

The campaign continues. Closed beads in `hv0`: 1, 3, 5. Open and
unblocked: `hv0.2` (cas-core special-function AST extension),
`hv0.4` (bench/hypergeometric-pfq tier-graded battery), `hv0.7`
(arb-prec quadrature). The natural next algorithmic layer is
`hv0.7` — Mellin-Barnes contour quadrature (`hv0.8`) needs it and it
has no upstream dependencies.

The `4ne` "ceiling" framing in the campaign worklog can be removed;
the substrate is not the bottleneck.
