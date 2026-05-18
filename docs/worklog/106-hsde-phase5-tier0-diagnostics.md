# 106 — HSDE Phase 5 Tier 0: ground truth + diagnostic slots (2026-05-13)

> **Scope.** Close bead `fuur`, the prerequisite tier for HSDE Phase 5
> iterative refinement. No IR algorithm lands here. This shard assembles
> and verifies the references, rereads the ECOS/SDPT3/Higham ground truth,
> and extends the verbose trace schema so Tier 1 can prove exactly which
> Schur back-substitution refinements fire.

## Context

`docs/HANDOFF_solver_ipm_hsde_part2.md` decomposed the precision-floor fix
for `hinf2` into dependency-chained beads. The first tier exists because
two prior attempts got the algorithm wrong by writing refinement code before
reading the references. The discipline here was intentionally narrow:
build the diagnostic loop before entering the algorithm loop.

This session happened on a different computer from the original developer
machine. That surfaced two portability facts:

- the six predecessor PDFs were already present in `docs/refs/`;
- `scientist-workbench-corpus` exists as a sibling checkout under
  `/home/tobiasosborne/Projects`, but three solver-ipm tests still had
  `/home/tobias/...` hard-coded and needed to use the existing
  `packages/solver-ipm/test/corpus.ts` resolver.

## Ground Truth Read

Verified local PDFs:

- `docs/refs/andersen-2009-homogeneous-self-dual.pdf`
- `docs/refs/andersen-roos-terlaky-2003.pdf`
- `docs/refs/domahidi-2013-ecos.pdf`
- `docs/refs/goulart-2024-clarabel.pdf`
- `docs/refs/odonoghue-2016-scs.pdf`
- `docs/refs/ye-warmstart-hsde.pdf`

Added and verified:

- `docs/refs/higham-2002-asna-ch12-iterative-refinement.pdf`
  (SIAM Chapter 12, 14 pages)
- `docs/refs/tutuncu-2003-sdpt3.pdf`
  (SDPT3 manuscript, 30 pages)

Downloaded `/tmp/ecos-reference` from `embotech/ecos` and reread
`src/kkt.c:113-232`. The relevant pattern is exactly the one named by
the handoff: compute the residual after the initial KKT solve, solve
for a correction, add it, undo if the residual grows, and stop when
the residual is below `LINSYSACC`, when `nitref` is exhausted, or when
the improvement stagnates under `IRERRFACT`.

Higham Chapter 12 gives the standard `r = b - Ax`, `Ad = r`,
`x <- x + d` refinement loop, and explicitly notes that fixed-precision
refinement can still improve the solution when the contraction condition
is satisfied. SDPT3 §2.5 names the same practical lesson for Schur
complement solves: iterative refinement is beneficial even when residuals
are computed only in working precision, but can occasionally fail to help.

## What Changed

`VerboseIterLine` now has three additive fields:

```ts
nitref1: number;
nitref2: number;
nitref3: number;
```

The convention is:

- `nitref1` — data-direction Schur back-substitution
- `nitref2` — affine-direction Schur back-substitution
- `nitref3` — combined-direction Schur back-substitution

Legacy LP/SDP emissions in `Solver.ts`, `NtSdpSolver.ts`,
`AhoSdpSolver.ts`, and `SdpSolver.ts` NaN-fill the fields. HSDE LP and
HSDE NT SDP emissions populate all three with `0` for now. Tier 1 will
replace those zeroes with counts returned by the refinement helper.

`formatVerboseLine` prints `nitref=(a,b,c)` only for HSDE kinds, so
human traces stay readable and legacy trace text is not cluttered.

`scripts/copt-log-to-jsonl.ts` gained `nitref1/2/3: null` for schema
alignment. New `scripts/mosek-log-to-jsonl.ts` parses Mosek's
`ITE PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU TIME` rows into the same
JSONL shape, mapping:

- `PFEAS -> primalInf`
- `DFEAS -> dualInf`
- `GFEAS -> gfeas`
- `PRSTATUS -> prstatus`
- `POBJ/DOBJ -> primalObj/dualObj`
- `MU -> compl`
- `TIME -> timeSec`

ADR-0033 Decision 8 was updated so the trace-schema contract matches the
implementation.

## Portability Fix

`packages/solver-ipm/test/{afiro,hsde-lp-afiro,hsde-lp-brandy}.test.ts`
now use `loadSuite("lp-netlib")` from `corpus.ts` instead of hard-coded
`/home/tobias/...` paths. This was necessary for the full local gate on
the new machine and matches the resolver already used by `netlib.test.ts`
and `lp-small.test.ts`.

## Validation

Commands run:

- `bun run typecheck` — pass
- `bun test packages/solver-ipm` — 88 pass, 0 fail
- `bun scripts/mosek-log-to-jsonl.ts temp/mosek-sample.log temp/mosek-sample.jsonl`
  — sample parser smoke test, 2 rows converted
- `bun run check:quick` — 4 passed, 0 failed
- `bun run check` — 93 passed, 7 skipped, 0 failed

`sdp-solve` oracle goldens remained green. This tier is deliberately
trajectory-neutral: the algorithm still performs zero refinement steps,
and the new fields only make the future IR counters visible.
