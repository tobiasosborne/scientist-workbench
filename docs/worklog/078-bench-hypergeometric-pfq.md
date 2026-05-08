# 078 — `bench/hypergeometric-pfq` shipped (hv0.4)

**Status:** Done
**Bead:** `scientist-workbench-hv0.4`
**Date:** 2026-05-09

## Context

Shipped a tier-graded test battery for `tools/hypergeometric-pfq` per
ADR-0019 bench discipline. The validation surface for the inner pFq
path that Slater (`packages/meijer-core::Slater`), Braaksma asymptotic
(in flight by parallel agent under hv0.9), and the Roach symbolic
dispatcher (hv0.6 ✓) all consume.

The tool itself shipped in hv0.3 (worklog 069), then was refactored
in worklog 070 to extract `@workbench/hypergeometric` so the Slater
substrate could share the evaluator. The 15-case unit test suite at
`tools/hypergeometric-pfq/tool.test.ts` exercises closed-form fast
paths, a handful of Kummer identities, and the refusal envelopes —
sufficient for the inner-loop iteration the tool itself was developed
under, but not for the *graded discrimination* the bench is for.

## What changed

New directory `bench/hypergeometric-pfq/`:

  - `DESCRIPTION.md` (~210 LOC) — per-tier rationale, derivation of
    every tolerance, the four Pearson-Olver-Porter failure modes, why
    the wire format uses string-decimals, why we route via
    `executeToolDef` not `wb.run` (compose gap, filed as follow-up
    bead).

  - `PROMPT.md` (~210 LOC) — the bench-as-brief: how-you-will-be-
    graded, problem statement, I/O contract, invariant table, tier
    table, hard sci-wb constraints, "things that will tempt you and
    which are wrong".

  - `REFERENCES.md` — Pearson-Olver-Porter 2017 as the foundational
    organising paper; Slater 1966 §4.1 / DLMF §16.2 / mpmath docs
    as the algorithmic / oracle references; Bühring 1987 +
    Becken-Schmelcher 2000 for the deferred analytic-continuation
    path; Kummer's transformations for v0.2 reductions.

  - `golden/inputs.json` — 53 cases organised by tier. Wire format:
    raw JSON with string-decimals (PRD §0.1) and `"p/q"` rational
    convenience (the adapter expands to decimal at sufficient working
    precision before calling `bigfloat::cfromStrings`).

  - `golden/expected.json` — pinned truth values + per-case
    `tolerance_rel` + per-case oracle-consensus record. 49 of 49
    numerical cases agree mpmath ↔ Wolfram at the comparison
    threshold; 4 are structural-refusal cases.

  - `golden/verify.py` — invariant verifier. Common: `no_tool_error`.
    Success-path: `shape`, `finite_value`, `method_admissible`,
    `self_reported_precision`, `value_accuracy`. Refusal-path:
    `boundary_envelope`. 53 cases × ~5 checks ≈ 282 invariant
    assertions.

  - `golden/verifier_protocol.md` — what each check pins, with
    derivations.

  - `golden/test_mutations.py` — five mutation-prove cases per
    ADR-0019 §4 / CLAUDE.md Rule 6: doubled-truth → value_accuracy
    RED; tagged-swapped-for-value → boundary_envelope RED;
    1e-30 perturbation → value_accuracy RED at `1e-42` tolerance;
    over-reported precision → self_reported_precision RED;
    unknown method → method_admissible RED. All 5 RED on the
    mutated candidates; the verifier admits all 5 on the
    canonical-truth candidates (sanity check).

  - `reference/generate-mpmath-truth.py` (~580 LOC) — the seeded
    truth generator. mpmath at `dps = max(80, precision + 30)` is
    primary; wolframscript at the same precision is the cross-check
    (block-scoped `$MaxExtraPrecision = 5000` is required to avoid
    Wolfram's symbolic Stirling-tower fallback for moderate-or-
    large parameters). Disagreement above the case's comparison
    threshold aborts the build.

  - `run-candidate.ts` (~190 LOC) — wire-format adapter, raw JSON ↔
    canonical Value, dispatches via `executeToolDef` directly.

The candidate passes 53 of 53 cases:

```
running 53 cases through bun bench/hypergeometric-pfq/run-candidate.ts
  pass  t0-0F0-exp-z1
  pass  t0-0F0-exp-z5
  ...
  pass  tE-2F1-z-neg1-boundary

Per-check summary:
  shape                     49/49
  method_admissible         49/49
  no_tool_error             53/53
  self_reported_precision   49/49
  finite_value              49/49
  value_accuracy            49/49
  boundary_envelope          4/4

all 53 cases green
```

Tier breakdown:

  - Tier 0 (closed-form anchors)            — 11 cases ✓
  - Tier A (generic happy path)             — 15 cases ✓
  - Tier B (large parameters)               — 10 cases ✓
  - Tier C (near-unit-circle)               —  8 cases ✓
  - Tier D (parameter coalescence)          —  5 cases ✓
  - Tier E (refusal cases)                  —  4 cases ✓

## Why these choices

**Why mpmath as primary oracle, Wolfram as cross-check.** The bead
spec calls for mpmath; ADR-0019 §3 calls for triple-witness
agreement. mpmath is the workhorse of the field's open-source
high-precision evaluators; Wolfram is the closed-source orthogonal
witness. Both ship `Hypergeometric pFq` evaluators with cancellation-
control / convergence-acceleration internals that are *different*
codebases (mpmath: Johansson 2009 dps-bump; Wolfram: proprietary
algorithm with `$MaxExtraPrecision` budget). Two-of-two agreement is
genuine cross-validation. Sage would be the third witness per
ADR-0019; it's not currently installed on the workbench host so we
proceed with two-of-two and document.

**Why string-decimal wire format, not JSON numbers.** The whole
point of `arbprec: true` is precision past `Number`'s 16-dps cap.
Encoding values as JSON numbers would defeat this for the corpus.
Decimal-strings + rational-strings (`"1/3"`, `"99/100"`) match the
mathematician's input convention and Wolfram/mpmath's default. The
adapter expands rationals at runtime via long division at the working
precision.

**Why `executeToolDef` and not `wb.run`.** `@workbench/compose`'s
`runWorkbench` validates partial flags against `def.flags ?? {}`; for
an arbprec tool that declares no flags of its own, the runner-merged
`--precision` flag (ADR-0020) is invisible to compose, and
`{ precision: 50n }` is rejected as an unknown flag. Per ADR-0012 the
contract holds byte-identically across both surfaces because both
fan out to `executeToolDef`; bypassing the wrapper for the bench is
admissible. Filed as a P1 follow-up bead — once `runWorkbench`
auto-merges arbprec's standard flag, the adapter reverts to the
typed-barrel call.

**Why 53 cases, not 50.** Tier 0 (closed-form anchors) carries 11
cases — multiple `z` values per identity probe the bigfloat-arithmetic
regime across small/medium/large/negative arguments. The 11 vs ~50
deviation is documented in `DESCRIPTION.md`; the bead spec said
"~50 cases" not "exactly 50".

**Why ~`1e-(p−2)` Tier 0 / A and `1e-(p−10)` Tier C.** mpmath at 80
dps clears truth values at relative `~10⁻⁷⁸`. Tier 0 / A are well-
conditioned: 2-dps margin is plenty. Tier C runs thousands of
summands per case; cumulative summation roundoff is `O(N · ε)` where
N is the term count. At `|z| = 0.98`, `N ≈ 5700`; that's `log2(5700) ≈
13` bits of summation noise on top of the truth-value pinning, hence
the relaxation.

**Why a "punishing test" tier was hard to construct.** The bead spec
asked for "a tier-D coalescence case and one tier-C near-unit-circle
case where the tool ALMOST refuses but converges with a precision
bump". I tried `2F1(1, 3/2; 3/2; 0.9)` (coalescence + near-unit), but
it actually triggers the closed-form-1F0 path because the limit
`a₂ = b₁` collapses to 1F0. I tried `2F1(1, 1; 1.001; 0.95)` (near-
coalescence + slow), but it just converges normally with 6-7 dps of
cancellation.  The cases that *almost refuse* are exactly the ones
the tool's `iterationCap` is sized to admit — a "punishing" case that
distinguishes a faithful implementation from one that prematurely
trims is hard to construct without a known-bad reference for
comparison. The bench's discrimination is in the *aggregate* of Tier
C + D, not in a single case.

## Frictions surfaced

**Wolfram InputForm wraps in `wolframscript -code`.** Initial
generator runs produced `InputForm[1.5\`50.]` strings (literally, with
the `InputForm[...]` wrapper). The fix was `ToString[N[v, dps],
InputForm]` — but this wasn't the documented behaviour of `-code`
mode; took 30 minutes of trial-and-error to nail down.

**Wolfram's `$MaxExtraPrecision = 50` (default).** Mid-tier-B cases
like `1F1(50; 75; 2)` produced cleanup-Stirling-towers like
`-307928085546086248935236559899400140625 (... + ... E²)/4` plus a
`N::meprec` warning, instead of a numeric. The fix: wrap the
`HypergeometricPFQ` call in `Block[{$MaxExtraPrecision = 5000}, ...]`.
This is undocumented in the wolframscript man page but standard
practice in the Mathematica community.

**Compose's `runWorkbench` doesn't merge arbprec's `--precision`
flag.** Discovered when the bench's first run-candidate.ts attempt
emitted `unknown flag 'precision' for this tool`. Documented as a
known gap, filed P1 follow-up bead, worked around via direct
`executeToolDef` call. The byte-identical-surface contract (ADR-0012)
still holds.

**`bigfloat::fromString` doesn't parse `"p/q"`.** The corpus uses
rational-strings for cleanliness ("1/3", "99/100") since Wolfram and
mpmath both accept them as exact inputs. The bigfloat substrate
expects decimal-only. The adapter expands rationals via BigInt long
division at the working precision; documented inline.

**`2F1(1, 1; 2; -1) = log 2` is on the boundary.** First Tier 0
draft included this as a closed-form anchor. The tool refuses (|z|=1
≥ 0.99). Replaced with `2F1(1, 1; 2; -1/2) = 2 log(3/2)` (well inside
the convergent region) and added the `-1` case to Tier E as a
"famous boundary identity" with a documented v0.2 follow-up bead.

**Disagreement at high precision.** The `tA-pfq-precision100` case
(precision = 100 dps) initially produced a Wolfram/mpmath
disagreement at `1e-67`. Root cause: the comparison threshold
`1e-(precision-2) = 1e-98` is tighter than what either oracle
produces at modest cross-check precision; bumping the Wolfram dps
budget to `max(60, precision + 30)` fixed it (consensus at
`min(precision, wolf_dps - 10)`).

## Acceptance

- `bench/hypergeometric-pfq/golden/verify.py` runs 53 cases × ~5
  checks ≈ 282 invariant assertions, all green.
- `bench/hypergeometric-pfq/golden/test_mutations.py` runs 5
  mutation-prove tests, all RED on the mutated candidates and GREEN
  on the canonical-truth candidates (sanity check).
- `bun run check:quick` green after the bench addition.
- `bun run check` green.
- README catalog row added.
- This worklog shard.
- `BEADS-TO-FILE.txt` carries 5 follow-ups.

## Pointers

- `bench/hypergeometric-pfq/` — the bench (this is what shipped).
- `tools/hypergeometric-pfq/tool.ts` — the candidate the bench
  validates.
- `packages/hypergeometric/src/pfq.ts` — the algorithmic substrate
  (~410 LOC of literate exposition + direct-series + outer driver).
- `docs/adr/0019-solve-bench-discipline.md` — bench-shape ADR.
- `docs/adr/0020-arbprec-determinism-tier.md` — `arbprec: true`
  contract, the `--precision=<int>` standard flag.
- `docs/worklog/069-bigfloat-and-pfq-shipped.md` — hv0.3 (the tool's
  initial ship).
- `docs/worklog/070-meijer-core-slater.md` — the refactor that
  extracted `@workbench/hypergeometric` from the tool.
- Pearson-Olver-Porter (2017) §3 — the four-failure-mode taxonomy
  the tier structure is built on.
- `BEADS-TO-FILE.txt` — five follow-up beads for the orchestrator
  to file (the most important: P1 compose merge of arbprec
  `--precision`; P2 analytic-continuation for `|z| ≥ 0.99`).
