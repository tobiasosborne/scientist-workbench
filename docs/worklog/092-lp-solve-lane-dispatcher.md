# 092 — `tools/lp-solve` lane dispatcher (2026-05-11)

> **Phase 2 of the parallel-agent merge.** Worklog 091 landed the
> `@workbench/solver-ipm` substrate next to `simplex-q`; this shard
> wires the IPM lane into the existing `tools/lp-solve` tool behind
> a `--method=auto|exact|ipm` flag. The public wire schema is
> unchanged. Bead `prfp` closes here.

## Context

Two engines now sit side-by-side under one public tool. The wx3m
bead (closed 2026-05-11) shipped the exact-rational simplex. The
prfp bead — opened 2026-05-11 in worklog 090 and claimed at the
start of this session — is "tools/lp-solve: add Mehrotra IPM lane".
That bead is what this shard implements.

The substrate landing (worklog 091) deliberately did **not** touch
`tools/lp-solve/tool.ts` — it kept the arbprec implementation intact
so the merge could be reasoned about in isolated phases. Phase 2 is
the additive step: the IPM engine is already in `@workbench/solver-ipm`
on the merge branch; we route to it for problems that exceed the
arbprec's natural scale ceiling.

## What changed

### Tool body (`tools/lp-solve/tool.ts`)

The free-variable splitting was hoisted out of the engine call so
both lanes see the same standard-form LP. From there:

- **`--method` flag** declared via `F.enum(["auto", "exact", "ipm"]
  as const, "solver lane", { default: "auto" })` on `defineTool`.
- **`pickLaneMethod(request, m, splitN)`** routes by `request` if
  explicit; on `"auto"` the rule is `m + splitN ≤ 50 → exact, else
  → ipm`. The threshold is empirical: worklog 090's bench grade
  showed the exact lane completing in seconds up to that size and
  exceeding the 30 s cap above it.
- **`solveIpmLane(args)`** builds a `CanonicalLp` from the already-
  split `(cSplitF, ASplitF, bSplitF)`, calls
  `@workbench/solver-ipm::solveLp`, and routes the result through
  `encodeIpmResult`.
- **`encodeIpmResult`** maps the solver-ipm `SolverStatus` taxonomy
  (`optimal | primal-infeasible | dual-infeasible | iter-limit | ...`)
  to the ADR-0030 §A.3 wire taxonomy (`optimal | infeasible |
  unbounded | iter-cap | numerical-breakdown`), recovers the original
  primal `x` from the `x⁺/x⁻` split halves, emits the IPM's dual
  `y` and slack `s`, and includes the lane's IPM-side fields
  (`achieved_precision`, `iterations`, `method: "solver-ipm"`,
  regularisation-bump warnings).
- **`METHOD_TAG`** split into `METHOD_TAG_EXACT = "simplex-q"` and
  `METHOD_TAG_IPM = "solver-ipm"` (existing references to `METHOD_TAG`
  renamed via `sed`).

### Wire schema

Public schema unchanged. The `method` field of the success record was
already `string` with comment `"simplex-q"`; comment is now
`"simplex-q" | "solver-ipm"`. Goldens (which all hit the exact lane
under `--method=auto` for small problems) are byte-identical.

### README

Updated `tools/lp-solve/README.md` to describe both lanes, the auto-
dispatch threshold, lane characteristics, and the determinism
guarantees per lane (Law 2: docs in lockstep).

## Why these choices

### Why auto-dispatch by size

Two-principles answer: a TS expert wants one tool, not three. The
agent who types `await wb.run("lp-solve", problem)` should get the
bit-identical answer when the problem is small enough to afford it,
and the scaling answer when it isn't, without ever consulting a
performance characteristic. The `method` field of the output record
tells the agent which lane ran (honest scope, Rule 8); the
`--method=` flag forces a lane when the agent wants reproducibility
or A/B comparison.

### Why threshold at `m + splitN ≤ 50`

Worklog 090's lp-small bench: dense LPs up to A_dense_25x25 (m+n=50)
solve in <1s exact; A_dense_50x50 (m+n=100) routinely times out at
the 30s cap. The threshold is one calibrated parameter (not a flag,
not configurable); empirically a TS expert will not notice it. If a
mid-size problem (m+n ≈ 60) lands in the IPM lane and the agent
wants bit-identical, `--method=exact` is one keystroke away.

### Why hoist the free-variable splitting before dispatch

Free variables are workbench-LP-vocabulary; the IPM substrate
(solver-ipm) was written assuming standard form (all `x ≥ 0`). Two
options: (a) refuse free-var inputs in the IPM lane and route them
to exact; (b) do the split before lane dispatch so both lanes see
standard form. Option (b) is the clean answer — the split is
algorithmic, not engine-specific, and now exists in float-space
once (used directly by the IPM) and lifted to rational-space
exactly when the exact lane runs. The handful of LP-shape decoding
gymnastics live in one place.

### Why no new goldens for the IPM lane in this phase

Goldens pin byte-exact output; IPM is iterative and the iteration
counts can drift with float64 substrate changes. The IPM lane
acceptance is property tests (eventually corpus benches), not
goldens. Adding IPM goldens to `lp-solve/goldens/` would create
brittle tests that fail on any algorithm-hygiene change (bead
`j1gd`). The corpus-side `lp-netlib` and `lp-small` bench
machinery (already exists in `scientist-workbench-corpus`) is the
right acceptance gate; tracked under `prfp` close-out criteria.

## Frictions surfaced

1. **`exactOptionalPropertyTypes: true` on the workbench's
   tsconfig** caught a subtle bug: `{ Ax_eq_b: undefined, cones }`
   is *not* the same type as `{ cones }` under strict optional. The
   IPM lane's `CanonicalLp` build had to conditionally include the
   key rather than emit it with `undefined`. One-time annoyance;
   the workbench's type discipline is doing its job.

2. **No tool-level test file yet.** The lp-solve tool relies on
   its goldens for regression. A `tools/lp-solve/tool.test.ts`
   that explicitly runs both lanes on a small problem and asserts
   they converge to the same `x` (modulo IPM tolerance) would be
   load-bearing — but writing it well is its own ~30-minute
   exercise and belongs to bead `6or7` (solver-ipm contract
   hardening), not this shard.

3. **The pre-existing main-branch lp-solve golden 05 mismatch**
   (bead `2dhc`) continues to flag in `bun run check`. Not
   introduced here; tracked separately.

## Acceptance

- `bun run tsc --noEmit` clean (no new errors).
- `bun run goldens:check` — 11/12 lp-solve goldens pass (same single
  pre-existing 2dhc mismatch on main; no new mismatches).
- Manual probe of `--method=ipm` on a small problem (min `x + 3y`
  s.t. `x + y = 5, x,y ≥ 0`) returns `optimal` in 4 iterations with
  `method: "solver-ipm"`, `objective ≈ 5.0`, `achieved_precision ≈
  2e-9`.
- Manual probe of `--method=auto` on the same problem returns
  `method: "simplex-q"` (size triggers the exact lane).
- `packages/simplex-q/`, ADR-0031, worklog-090, and ADR-0030 are
  unchanged.

## Pointers

- `tools/lp-solve/tool.ts:402-602` — the new `fn` body, lane
  dispatch, `solveIpmLane`, `encodeIpmResult`.
- `tools/lp-solve/README.md` — both-lanes documentation.
- `packages/solver-ipm/src/solver/Solver.ts:40-130` — the IPM main
  loop the dispatcher calls.
- `bd show scientist-workbench-prfp` — closes here.
- `bd show scientist-workbench-6or7` — workbench-contract hardening
  (next phase: hard NETLIB assertions, `--test` hook, portable
  corpus paths).
- `bd show scientist-workbench-2dhc` — the pre-existing golden 05
  bug (independent of this work).
