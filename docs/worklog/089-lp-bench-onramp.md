# 089 — LP bench onramp for Phase 1 (2026-05-11)

> **Superseded in part — see ADR-0037 and worklog 114 (2026-05-14).**
> The "`tools/cone-solve` v0.1 gate: 21/21 on `lp-netlib` + 29/29 on
> `lp-small`" target in the *Bench gate (v0.1)* section below is
> **withdrawn** as a category error: it handed the *universal* tool the
> *LP specialist's* 1e-8 gate. `lp-netlib` / `lp-small` are `lp-solve`'s
> gates; `cone-solve` v0.1 is gated by its seven-artefact contract, and
> its relationship to `lp-netlib` is a tracked 1e-6 *profile*, not a
> pass/fail bar (ADR-0037). The rest of this shard — what to read, the
> feedback loop, the dependency chain — stands.

## Context

Phase 0 of the convex-cone solver epic (eg9j, ADR-0030) closed
2026-05-11.  Two LP benchmark suites live in the sibling
`scientist-workbench-corpus` repo and are ready to grade a candidate
solver.  This shard exists so an implementer landing on bead `cp9k`
(packages/cone-core substrate), `2ivi` (tools/cone-solve), or `wx3m`
(tools/lp-solve) knows what to read and where to start.

## Read in this order

1. **`docs/adr/0030-convex-cone-solver-tier.md`** (workbench).  The
   canonical spec.  Wire format §C, output shape §D, status
   taxonomy §A.3, algorithm-choice + reference papers §B + §E.
   Re-read §"Open questions" before you commit to any wire-shape
   detail.

2. **`benchmarks/lp-netlib/DESCRIPTION.md`** (corpus).  The
   raw-JSON projection of the wire format, including the
   `cones: [{head, indices?, size?}, ...]` encoding that the
   canonical Value protocol's `expression`-encoded cones flatten
   into.  Read the §"NETLIB → canonical SCS reduction" prose if
   you want to understand where the bench problems came from.

3. **`benchmarks/lp-netlib/golden/verifier_protocol.md`** (corpus).
   The 12 checks per case, in prose.  Section §"Check definitions"
   tells you exactly what your tool must satisfy for each status
   branch (`optimal` / `infeasible` / `unbounded` / `iter-cap` /
   `numerical-breakdown` / tagged-refusal).

4. **`benchmarks/lp-netlib/run-candidate.ts`** (corpus).  The
   bridge from raw JSON ↔ canonical Value protocol.  This is the
   file that calls `wb.run("lp-solve", input)` once your tool is
   registered.  Read it to understand the exact field shapes your
   tool will see and what shape its output must have.

5. **`adapters/gurobi/oracles/gurobi-lp.py` + `adapters/mosek/oracles/mosek-lp.py`** (corpus).  The reference oracle adapters.
   These produce known-good candidate records on every case in the
   suite.  Pipe a case input through them to see what your output
   must match shape-for-shape (numerical answers will diverge per
   the multiple-optimum and numerical-tier rules, but shape and
   status taxonomy are pinned).

## The feedback loop

Once you start building `tools/<your-tool>/tool.ts`:

```sh
# in scientist-workbench/
bun run new-tool lp-solve --uses linalg-core
# … edit tools/lp-solve/tool.ts to defineTool({ schema, fn, examples, ... }) …
bun run check:quick

# in scientist-workbench-corpus/
~/.bun/bin/bun src/cli.ts grade scientist-workbench lp-netlib
# → see N/21 cases pass; the 'detail' field for each failed check
#   points to exactly what's wrong (wrong shape, wrong status, KKT
#   residual too large, oracle disagreement, etc.).
```

The bench will tell you, brutally, the same way Gurobi+Mosek tell
each other.  The verifier's `oracle_agreement` check pins your
objective against the Gurobi+Mosek consensus (pinned in
`expected.json`); it does NOT require you to find the same
*vertex* (Family E of `lp-small` has multi-optimum cases where
different solvers correctly return different x's).

The `tool-not-registered` envelope from the bridge means your
tool hasn't been registered with the workbench's compose layer.
Add it via `tools/<name>/tool.ts` calling `defineTool({...})` and
exporting `def`; the compose registry auto-discovers it on
`loadWorkbench()`.

## What "wonderful" looks like (the two principles)

1. **A TS expert types `wb.run("lp-solve", { minimize: { c }, subjectTo: { Ax_eq_b, cones }, precision: 1e-8 })` and gets back `{ status: "optimal", x, dual, slack, objective, achieved_precision, iterations, method, condition_estimate, warnings }`.**  Nothing else.  No surprise required fields, no per-vendor sign conventions
   to remember, no "first classify your cone, then dispatch" routing.

2. **Status is honest.** `optimal` carries the witness (x, dual, slack
   satisfying all four KKT residuals).  `infeasible` carries a
   Farkas certificate as `dual`.  `unbounded` carries an unbounded
   ray as `x`.  `iter-cap` / `numerical-breakdown` carry the
   warnings.  A `tagged "lp-solve/*"` refusal goes out for
   structurally-malformed inputs.

   The verifier's `self_reported_precision` check (with the 2×
   slack from shard 005 of the corpus repo) catches a candidate
   that over-claims its own residual.  CLAUDE.md Rule 8 — lying
   is inadmissible, even by a factor of 10.

## Bench gate (v0.1)

Per the epic close-out and corpus shard 005:

- **`tools/cone-solve` v0.1 gate:** 21/21 on `lp-netlib` + 29/29 on
  `lp-small`.  The original `≥98/114` threshold was reframed to
  match the small-NETLIB-subset suite that v0.1 ships (ADR-0030's
  sparse-wire deferral to v0.2 is the reason the full 114 isn't
  in the bench yet).

- **`tools/lp-solve` v0.1 gate:** same — 21/21 on `lp-netlib` +
  29/29 on `lp-small`.  When v0.2 sparse wire format lands, the
  full battery re-engages and the `≥110/114` threshold becomes
  the lp-solve specialist gate (cone-solve stays at `≥98/114`).

## Phase ordering (the dependency chain)

```
cp9k (packages/cone-core)     ← substrate
 └─ 2ivi (tools/cone-solve)   ← universal primary
 └─ wx3m (tools/lp-solve)     ← specialist
 └─ psuw (tools/qp-solve)     ← specialist (later)
```

`cone-core` is the SCS-style ADMM substrate (cone projections + HSDE
+ operator-splitting iteration) and is shared by all three tools.
The universal `cone-solve` is intended to ship before `lp-solve`
because per ADR-0030 §B the agent's first reach is for the
universal primary; the LP specialist is the optimisation when the
agent has already classified its problem as pure LP.

If you choose to ship `lp-solve` first (revised simplex via
Bartels-Golub LU + Mehrotra IPM via the lp-IPM lane), `cone-core`
is not strictly needed — the LP specialist uses `@workbench/linalg-core`'s
LU substrate directly.  Document the choice in your worklog so the
next agent knows where you started.

## Pointers

- Workbench beads: `cp9k`, `2ivi`, `wx3m`, `psuw` (all open after
  Phase 0 close-out).
- Corpus repo: `~/Projects/scientist-workbench-corpus/` (sibling
  to this directory).  Worklog shards 004 (tracer) and 005 (Phase 0
  close-out) document the build of the bench you'll be grading
  against.
- The bridges in the corpus (`benchmarks/lp-*/run-candidate.ts`)
  emit `scientist-workbench/tool-not-registered` if your tool
  isn't in the registry yet — that's the first signal you'll see
  before your tool exists.
