# 109 — `parseGurobiLog`: the third external-solver trace witness (2026-05-14)

> **Scope.** Close bead `z799`. Add `parseGurobiLog` alongside
> `parseCoptLog` / `parseMosekLog` so `scripts/trace-diff.ts` can localise
> HSDE-solver divergence against a *third* independent reference. Also
> records bead `vvou` (corpus-test skip convention), closed in the same
> session.

## Context

Worklog 108 verified the Mosek and COPT trace parsers against real solver
logs. The user confirmed Gurobi 13.0.1 is also installed (`~/gurobi1301/`).
Two independent reference solvers can themselves disagree on a hard
instance; a third witness lets a TS trace be judged "matches two of
three" rather than "matches the one solver we happened to parse."

## Ground Truth Read

`gurobi_cl Method=2 Crossover=0 adlittle.mps` on the NETLIB `adlittle` MPS
already cached in `scientist-workbench-corpus/data/lp-netlib/raw/`. The
barrier log:

```
                  Objective                Residual
Iter       Primal          Dual         Primal    Dual     Compl     Time
   0  -1.53974860e+06  3.05335499e+05  9.95e+02 7.58e+02  3.70e+05     0s
  ...
  12   2.25494963e+05  2.25494963e+05  4.41e-11 4.55e-13  6.91e-10     0s
```

The key fact: **Gurobi's column order is not COPT's.** Both have seven
whitespace tokens per row, but Gurobi groups `Primal Dual` objectives,
then `Primal Dual` residuals, then `Compl` — COPT puts `Compl` in
position 3. A COPT alias would silently mis-map. Gurobi also has a
*two-line* header (a group header `Objective Residual`, then the column
header). All three solvers converge to objective ≈ 2.254950e+05 on
`adlittle` — a clean triple-witness.

## What Changed

- `TraceLog.ts` — `"gurobi"` added to `TraceLine.kind`; `externalTraceLine`
  widened to accept it; new `parseGurobiLog` with column map
  `Primal→primalObj, Dual→dualObj, Primal-resid→primalInf,
  Dual-resid→dualInf, Compl→compl, Time→timeSec`. Gurobi's default LP
  barrier is not homogeneous self-dual, so every HSDE and solver-internal
  field stays `null`. The two-line header and all banner/statistics lines
  fail the seven-token / integer-first shape and are skipped; the
  contiguous-iteration guard is shared with the other two parsers.
- `packages/solver-ipm/src/index.ts` — exports `parseGurobiLog`.
- `scripts/gurobi-log-to-jsonl.ts` — new thin CLI shell, sibling of the
  COPT/Mosek scripts.
- `packages/solver-ipm/test/fixtures/gurobi-13.0-adlittle.log` — the real
  Gurobi run, committed.
- `trace-log.test.ts` — five synthetic edge-case probes (two-line-header
  skip, column map, null-internal-fields, contiguity guard, empty input)
  plus a three-probe real-log verification block. 17 → 25 tests.
- ADR-0033 Decision 8 — `"gurobi"` added to the `TraceLine.kind` listing;
  the three-witness rationale recorded.

## `vvou` — corpus-test skip convention (same session)

A sibling finding from the `ef3a56c` review: `afiro.test.ts`,
`hsde-lp-afiro.test.ts`, `hsde-lp-brandy.test.ts` were converted to the
`loadSuite()` resolver but handled a missing corpus by `throw`ing inside
the test body — going *red* — where `corpus.ts`'s own doc-comment and the
sibling `netlib.test.ts` / `lp-small.test.ts` use `describe.skip`. All
three now follow the `if (suite === null) { describe.skip } else { … }`
pattern. Verified both ways: corpus present → 3 pass; `WORKBENCH_CORPUS=
/nonexistent` → 3 skip, 0 fail (was 3 fail).

## Frictions Surfaced

- Gurobi's barrier-log time column is `<n>s` with integer seconds in this
  run (`0s` throughout — `adlittle` is sub-second). `GUROBI_TIME_RE`
  accepts an optional `s` for robustness, but the format has only been
  observed with the suffix; a longer solve would confirm the
  multi-second shape.
- `gurobi_cl` writes the iteration log to stdout cleanly (no ANSI cruft,
  unlike `copt_cmd`) — the fixture is the verbatim capture.

## Acceptance

- `bunx tsc --noEmit` — pass.
- `bun test packages/solver-ipm/test/trace-log.test.ts` — 25 pass.
- `bun run check` — green.
- `parseGurobiLog` verified field-by-field against the committed real
  Gurobi 13.0.1 log; `scripts/gurobi-log-to-jsonl.ts` smoke-tested.

## Pointers

- `packages/solver-ipm/src/solver/TraceLog.ts` — the three parsers and the
  `TraceLine` schema.
- `packages/solver-ipm/test/fixtures/{mosek-11.1,copt-8.0.4,gurobi-13.0}-adlittle.log`
  — the three real-solver fixtures.
- `docs/adr/0033-hsde-for-solver-ipm.md` §"Decision 8".
- Beads `z799` (closes — Gurobi parser), `vvou` (closes — skip
  convention). The `ef3a56c` review (worklog 107) is now fully
  discharged: `ghvl`, `yyme`, `vvou`, plus the discovered `uj6c`.
