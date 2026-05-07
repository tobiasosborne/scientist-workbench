# Worklog 068 — ADR-0020: Arbitrary-precision numerical tier

**Date:** 2026-05-07.
**Beads:** scientist-workbench-hv0 (epic), -hv0.1 (this shard's parent — `packages/bigfloat` substrate; in-progress).

## Context

The tstournament problem-13 ("Meijer G mega-test"; epic
scientist-workbench-hv0) is a multi-month, multi-session campaign to
implement Meijer G in pure TypeScript across symbolic dispatch +
arbitrary-precision numerical evaluation + honest out-of-region
tagging. Bar: better than Mathematica.

The problem-13 brief lives in the tstournament repo at
`ts-bench-infra/problems/13-meijer-g/` (see `PLAN.md` for the
seven-layer stack and `ORACLE-STRATEGY.md` for the Wolfram + mpmath
consensus protocol). The empirical research probe established that
Wolfram's `MeijerG` and mpmath's `meijerg` agree bytewise to 200
decimal digits on generic parameters — so the candidate's bar is
achievable with a genuine arbitrary-precision substrate, but not
without one.

Per CLAUDE.md Law 1 ("ground truth before code"), the substrate's
ADR is the first deliverable on hv0.1 — before any code lands.
ADR-0020 is that deliverable.

## What changed

Five files updated in this session:

- **`docs/adr/0020-arbitrary-precision-tier.md`** (new, ~370 lines).
  The arb-prec tier ADR. Adds `arbprec?: boolean` to
  `ToolDefinition` as a third additive flag (parallel to
  `nondeterministic?` and `numerical?`); specifies
  `packages/bigfloat` as the substrate (per-value precision, MPFR
  semantics, BigInt mantissa); pins the value-protocol encoding
  (`tagged "bigfloat" payload: record { mantissa, exponent,
  precision }`); standardises `--precision=<int>` as an inherited
  flag for `arbprec: true` tools (default 50 decimal digits); fixes
  the determinism contract as bit-identical cross-platform forever
  (BigInt is bit-identical by JS language spec).
- **`PRD-v0.2.md` §6.1** — bit-determinism bullet expanded to four
  tiers (symbolic, arbprec, numerical, nondeterministic) with the
  load-bearing claim that arbprec is the strongest determinism
  contract in the workbench, alongside symbolic.
- **`README.md` §"Hard requirements"** — mirrored the PRD amendment.
- **`CLAUDE.md` hallucination-risk callout** — extended the existing
  three-flag bullet to four flags; added the `--precision` standard-
  flag inheritance fact.
- **`docs/worklog/065-arbitrary-precision-tier.md`** (this file).

## Why these choices

### Three flags + mutual exclusion, not a tier enum

Same argument as ADR-0015 §"Pattern consistency over clean-slate
elegance". The codebase has two existing additive boolean flags
(`nondeterministic?`, `numerical?`); the parallel addition of
`arbprec?` matches the existing TS-expert reading of
`ToolDefinition`. A unified `determinism: DeterminismContract` enum
is more elegant in isolation but would touch every tool definition
in a non-additive refactor. Today, additive wins; if the four-flag
shape ever proves load-bearing-fragile, a future ADR can consolidate.

### `packages/bigfloat` as a new package, not extension of cas-core

The bigfloat substrate has no overlap with `cas-core` (which is
rational arithmetic, polynomials over ℚ, and the symbolic AST).
Putting bigfloat next to `cas-core` rather than inside it avoids
adding a third concept to `cas-core`'s already-complex package and
keeps the determinism-contract boundary clean. `cas-core` stays
symbolic-rational; `bigfloat` is the arb-prec substrate; they
compose at higher layers (e.g. `tools/hypergeometric-pfq` uses both
the AST nodes from cas-core and the BigFloat primitives from
bigfloat).

### MPFR-style per-value precision, not mpmath ambient

Compositional clarity. When `add(a, b, prec)` takes its precision
parameter explicitly, reading composed code reveals every precision
decision at the call site. The TS expert and the agent's planner
both prefer this over mpmath's `mp.prec = 50` global state.

### `tagged "bigfloat"` encoding, not new primitive kind

Adding an 11th primitive to the value protocol breaks PRD §2.2 and
the canonicalisation contract. The `tagged` primitive *is* the
mechanism for "complex types built from primitives" — the Sturm IR
(ADR-0006) is encoded as `tagged "channel"` and works fine. Bigfloat
fits the same pattern. Tools that operate on bigfloat declare
`S.tagged("bigfloat", ...)` schemas and validate; tools that don't,
foreign-pass-through.

### BigInt mantissa, not Uint32Array

`BigInt` is bit-identical across all JavaScript runtimes by language
specification. A custom Uint32Array mantissa with hand-written add /
multiply / divide would also be bit-identical but would cost ~1500
LOC of substrate to write and prove correct. BigInt gives us
bit-determinism for free, with V8's already-optimised schoolbook for
typical MeijerG-grade precision (50–200 dps ≈ 4–14 BigInt limbs).

### Decimal precision in the user surface

mpmath, Mathematica, Maple, and every paper in the field speak
decimal digits at the user surface and binary internally. A planner
reading `--precision=50` understands "50 sig figs" without mental
conversion. The implementation maps `bits = ceil(decimal *
log2(10)) + safety_margin` (typically 30 bits of safety) at the API
boundary.

## Frictions surfaced

- **The `Three annotations` → `Four annotations` rewrite** in
  CLAUDE.md required care to preserve the existing structure (the
  per-output tier conditioning paragraph, the platform-fingerprint
  flag paragraph) while threading the new `arbprec` content. Did not
  make it shorter; the section now spans 26 lines vs the previous
  21, but every sentence remains load-bearing.
- **PRD §6.1 bullet is getting long.** Original ~2 sentences;
  ADR-0015 made it ~5 sentences; ADR-0020 makes it ~7. At the next
  tier addition this should be refactored into a sub-section with a
  table.
- **Early temptation to bundle the arb-prec tier with bigfloat
  encoding into two separate ADRs** — discarded for unity of
  concern. The encoding decision *is* the substrate decision; the
  flag decision builds directly on both. One ADR with three subsections.

## Acceptance

- ADR-0020 file exists with Status=Accepted.
- PRD §6.1, README.md §"Hard requirements", and CLAUDE.md
  hallucination-risk callout all reflect the four-tier model and
  reference ADR-0020.
- Worklog shard 065 (this file) exists.
- Bead hv0.1 stays in_progress — the substrate package itself is
  the next deliverable; this ADR is the first task within hv0.1.
- No code shipped in this iteration; CLAUDE.md Rule 4 (tiered
  workflow, "core" tier ⇒ ADR first) is honoured.

## Pointers

- ADR-0020: `docs/adr/0020-arbitrary-precision-tier.md` — the ADR.
- ADR-0014, -0015 — the precedent numerical-tier ADRs that this one
  parallels.
- ADR-0005 — the original additive-flag pattern
  (`nondeterministic?: boolean`).
- ADR-0011 — the typed-flag-declarations ADR that the new
  `--precision` standard flag inherits from.
- tstournament `ts-bench-infra/problems/13-meijer-g/` — the
  benchmark forcing this work.
- Bead scientist-workbench-hv0.1 — the substrate package; this
  ADR was its first deliverable. Substrate code lands in
  subsequent commits.
