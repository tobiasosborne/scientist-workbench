# 091 — `@workbench/copt-ipm` substrate landing (2026-05-11)

> **Scope.** Phase 1 of a multi-shard merge of two parallel agent
> deliveries on the same day:
>
> - **Main branch** (shipped earlier 2026-05-11, worklog 090): the
>   arbprec rational simplex (`packages/simplex-q` + `tools/lp-solve`
>   v0.1). World-first exact-rational LP solver in TypeScript.
> - **Experiment branch** `origin/experiment/copt-ipm-port`: a TS port
>   of COPT's unified primal-dual interior-point method, reverse-
>   engineered from the COPT 8.0.4 binary via Ghidra. LP path passes
>   21/21 NETLIB; SDP via NT direction (= COPT's actual default
>   barrier path) passes the bundled smoke test in 5 iters vs COPT's
>   7. Handoff documents at `/home/tobias/Dropbox/Projects/Computers/
>   LLM/COPT-decomp/`.
>
> This shard records the **substrate landing only** — `packages/copt-
> ipm/` dropped next to `simplex-q/` with no tool integration yet. The
> lane-dispatch tool rewiring, the new `tools/sdp-solve` tool, the
> ADR-0032 on the COPT port, and the bench close-out are the work of
> subsequent shards. Beads file the rest of the punch list.

## Context

The two agents' deliveries are complementary, not competing — they
fall into the slots the `wx3m`/`hnyu`/`prfp` follow-up beads
contemplated when worklog 090 closed:

| lane | substrate | regime | determinism tier |
|---|---|---|---|
| `--method=exact` | `packages/simplex-q` (shipped today) | n ≤ ~30 dense, exact-rational | `numerical: true` wire on `arbprec`-strength interior |
| `--method=ipm` | `packages/copt-ipm` (this shard) | n ≥ ~100, NETLIB-scale | `numerical: true` |
| `--method=float-simplex` | not yet shipped (`hnyu` bead) | NETLIB-scale, vertex output | `numerical: true` |

The experiment branch had also rewritten `tools/lp-solve/tool.ts`
from 981 lines to ~100 lines as a bare `async main()` shim around
`copt-ipm`. That rewrite is **not** part of this shard — it
violated the workbench tool contract (no `defineTool`, no schema,
no `--test` hook, no provenance) and would have replaced today's
arbprec ship rather than dispatched to it. The tool wire merge is
deferred to `prfp` (claimed in this session).

## What changed

### Substrate

Cherry-picked `packages/copt-ipm/` from `origin/experiment/copt-ipm-
port` onto `merge/copt-ipm-substrate`. 17 source files + 7 tests:

```
packages/copt-ipm/
  src/
    format/   CanonicalLp.ts, SdpaSparse.ts
    problem/  LpProblem.ts, SdpProblem.ts
    linalg/   Cholesky.ts, SchurAssembler.ts
    cone/     PsdCone.ts          (eighJacobi, frobInner, NT scaling, psdMaxStep)
    solver/   Solver.ts           (LP main loop)
              SdpSolver.ts        (HKM direction — stalls; A/B debug)
              AhoSdpSolver.ts     (AHO direction — works; A/B reference)
              NtSdpSolver.ts      (NT direction — primary, = COPT's default)
              Direction.ts, Residuals.ts, Convergence.ts, StepLength.ts,
              Iterate.ts, Defaults.ts, LogFormat.ts
  test/       afiro, lp-small, netlib (LP); sdp-smoke, sdp-aho, sdp-ab,
              sdp-synthetic, tiny.
```

The package builds as a substrate-only workspace member — no tools
wire it up yet.

### Adjustments required to land cleanly

Three classes of fix were needed on top of the cherry-pick:

1. **Hard-coded test paths.** Three SDP test files referenced
   `/home/tobias/Projects/COPT-decomp/copt/copt80/examples/data/sdp.
   dat-s` — a path that doesn't exist on this machine (the actual
   file lives in `/home/tobias/Dropbox/.../COPT-decomp/probes/`).
   Fixed by copying the 15-line `sdp.dat-s` into `packages/copt-ipm/
   test/fixtures/` (co-located, portable) and resolving via
   `fileURLToPath(new URL("./fixtures/sdp.dat-s", import.meta.url))`.
   The TS-native pattern.

2. **Import extension convention.** The agent used `.ts` extensions
   in relative imports (`from "./Solver.ts"`); the workbench's
   `tsconfig.json` does not enable `allowImportingTsExtensions` and
   the convention across `packages/` is `.js` extensions on `.ts`
   sources. 35 import sites across 9 files renamed via sed.

3. **Strict-null violations.** `noUncheckedIndexedAccess: true` on
   the workbench tsconfig means `Float64Array[i]` returns `number |
   undefined`. The SDP code does extensive in-place compound
   assignment (`array[i] += x`) on typed arrays, which trips the
   check. 27 sites across 6 files (`PsdCone`, `SchurAssembler`,
   `SdpProblem`, `AhoSdpSolver`, `NtSdpSolver`, `SdpSolver`) fixed
   by rewriting compound assignment as `array[i] = array[i]! + x`
   with non-null assertion. The bounds are algorithmically
   guaranteed (typed arrays are dense by construction); the `!` is
   the TS-idiomatic way to communicate "I've already proved this".

### Test status

- `bun test packages/copt-ipm/` — **68 pass, 0 fail.**
- `bun run check` (full 14-phase workbench gate):
  - convention warning about raw kind-literals (pre-existing,
    1907 sites — all in `.claude/worktrees/`, not workbench code);
  - `▸ typecheck (tsc --noEmit) ... ok`
  - all `▸ tool --test:` phases ok
  - all `▸ oracle:` phases ok **except** `lp-solve (12 goldens)`,
    which fails on golden 05 (unbounded-min-x). Discovered to be
    **pre-existing on main** (introduced 2026-05-11 commit 09c520d
    when worklog 090 shipped): the golden file has `dual: [1.0,
    0.0]` but the tool emits `dual: []` for unbounded cases.
    Filed as bead `2dhc`.

## Why these choices

### Substrate-only landing, not tool integration

The two-principles test (`bd memories two-principles`) reframes the
HANDOFF.md / HANDOFF_SPEC_ALIGN.md punch list. The cleanroom-spec's
"Cone interface unification" item, the numeric `SolveStatus 0–11`
item, the packed-lower-triangular-storage item — these are decomps-
faithfulness items that a TS expert would explicitly reject (concrete
functions over runtime polymorphism; discriminated string unions over
magic integers; defer memory optimisation until forced). Conversely:
hard test assertions, σ-clip / stall-threshold standardisation,
DIMACS error vector, and Ruiz equilibration are merit-based and
real. The substrate landing decouples the algorithm's value (which
*is* the world-first contribution) from those policy choices, which
get applied surgically by follow-up beads on a green base.

### Reject the experiment-branch `tools/lp-solve/tool.ts` rewrite

The branch shrank `tool.ts` from 981 → ~100 lines and dropped:
`defineTool`, the wire schema, six refusal envelopes, the KKT
residual reporter, the `--test` hook, the provenance write. The
right move is **dispatch, not replace.** Both lanes coexist behind
`--method=auto|exact|ipm` with auto-dispatch by problem size; the
public schema stays ADR-0030 §C/§D verbatim; refusal envelopes
extend additively. Tracked under `prfp` (claimed).

### The COPT NT-direction discovery is a contribution

`HANDOFF_SDP_FIDELITY.md` records that COPT's barrier SDP path is
unified LP+SDP through `FUN_00732a50` using the NT (Nesterov-Todd
1997 / Todd-Toh-Tütüncü 1998) direction, **not** HDSDP as initial
string-analysis suggested. This is a genuine reverse-engineering
finding and motivates filing `tools/sdp-solve` as a separate tool
(filling the ADR-0030 §B SDP slot, which was marked deferred white
whale). Tracked under `v4jd`.

## Frictions surfaced

1. **Hard-coded absolute test paths** to a directory that doesn't
   exist on the merge machine. A TS expert would have made the test
   data a co-located fixture from day one. This is the kind of thing
   the workbench's bench-via-corpus migration (ADR-0028) was supposed
   to make universal, but the copt-ipm tests bypass the corpus
   convention because they cross-validate against a probe artefact
   from the reverse-engineering session.

2. **Strict-null violations on typed-array compound assignment.**
   `noUncheckedIndexedAccess: true` is load-bearing for workbench
   type discipline, but the COPT agent wrote in a style that
   pre-dates that flag. 27 mechanical fixes. The pattern `array[i] +=
   x` doesn't typecheck under strict-null; rewrite as `array[i] =
   array[i]! + x`. Tedious; should be lifted into a project lint
   ("typed-array compound assignment outside `// @workbench-trusted
   loop`") in a future code-health pass.

3. **Pre-existing oracle failure on main** (bead `2dhc`). The
   workbench's worklog-090 commit shipped today without a clean
   `bun run check`. Discovered while validating that the substrate
   landing doesn't regress anything — checked main directly and saw
   the same `oracle: lp-solve` failure. This is a process gap: the
   tier-1 quality gate is supposed to be pre-commit (Rule 5: "the
   full `bun run check` is the pre-shard gate, not the inner loop"),
   and worklog-090's substrate ship slipped through it.

## Acceptance

- Branch `merge/copt-ipm-substrate` builds clean (`bun run check`
  passes except the pre-existing lp-solve golden 05).
- `bun test packages/copt-ipm/` reports 68/68 green.
- `packages/simplex-q/`, ADR-0031, worklog-090, and `tools/lp-solve/
  tool.ts` are unchanged.
- Beads filed: `prfp` (claimed), `2zed` (ADR-0032), `v4jd` (sdp-
  solve), `6or7` (copt-ipm contract hardening), `j1gd` (algorithm
  hygiene), `2dhc` (pre-existing golden bug).

## Pointers

- `packages/copt-ipm/` — the landed substrate.
- `/home/tobias/Dropbox/Projects/Computers/LLM/COPT-decomp/` — the
  reverse-engineering handoff. **Not in the workbench repo** (private
  research artefact).
- `docs/worklog/090-lp-solve-arbprec.md` — the arbprec lane this
  substrate complements.
- `docs/adr/0030-convex-cone-solver-tier.md` — the cone-solver tier
  ADR; the `tools/lp-solve` specialist slot (LP) and the deferred
  `tools/sdp-solve` slot (SDP) are both addressed by the landing
  copt-ipm work.
- `bd show scientist-workbench-prfp` — Mehrotra IPM lane (claimed).
- `bd show scientist-workbench-v4jd` — `tools/sdp-solve` (open).
- `bd show scientist-workbench-6or7` — workbench-contract hardening
  on the copt-ipm package (gates prfp and v4jd).
