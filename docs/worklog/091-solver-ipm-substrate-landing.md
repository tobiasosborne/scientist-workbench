# 091 — `@workbench/solver-ipm` substrate landing (2026-05-11)

> **Scope.** Phase 1 of a multi-shard merge that brings a second LP
> engine into the workbench alongside the exact-rational simplex
> shipped earlier the same day. This shard lands the substrate only;
> tool-wire integration is worklog 092, contract hardening is
> worklog 093, the design ADR is 0032.

## Context

`tools/lp-solve` v0.1 shipped 2026-05-11 (commit `09c520d`, worklog
090): exact-rational two-phase simplex over ℚ, the world-first
arbitrary-precision LP solver in TypeScript. Bench grade 24/29 on
`lp-small`; natural scale ceiling around `m + n ≈ 50` due to BigInt
coefficient growth in the basis inverse. Worklog 090 explicitly
named two follow-up lanes for NETLIB-scale problems: `hnyu` (float
revised simplex) and `prfp` (Mehrotra primal-dual IPM).

Concurrently, an independent implementation produced a pure-
TypeScript Mehrotra 1992 predictor-corrector primal-dual IPM
covering both LP and SDP cones. The algorithms are textbook:

- LP: Mehrotra predictor-corrector with three-tier Tikhonov
  regularisation on the Schur-complement Cholesky factor.
- SDP: three search directions — NT (Todd-Toh-Tütüncü 1998, the
  primary export), AHO (Alizadeh-Haeberly-Overton 1997, A/B
  reference), HKM (Helmberg-Kojima-Monteiro 1996, debug-only).

The substrate landed as a complete package with own tests, and the
strategic question was whether to:

1. Keep it as a separate parallel tool competing for the LP slot.
2. Reject it in favour of the existing exact lane.
3. **Merge as a second internal lane of the same public
   `tools/lp-solve` tool, with size-based auto-dispatch.**

Option 3 is what worklog 090's `prfp` bead always envisioned. This
shard executes the first phase of that merge: drop the substrate
into `packages/solver-ipm/`, no tool-wire changes yet.

## What changed

### Substrate

`packages/solver-ipm/` landed as a new workspace member:

```
packages/solver-ipm/
  src/
    format/   CanonicalLp.ts, SdpaSparse.ts
    problem/  LpProblem.ts, SdpProblem.ts
    linalg/   Cholesky.ts, SchurAssembler.ts
    cone/     PsdCone.ts          (eighJacobi, frobInner, NT scaling, psdMaxStep)
    solver/   Solver.ts           (LP main loop)
              SdpSolver.ts        (HKM direction — debug-only, kept for A/B)
              AhoSdpSolver.ts     (AHO direction — A/B reference)
              NtSdpSolver.ts      (NT direction — primary SDP export)
              Direction.ts, Residuals.ts, Convergence.ts, StepLength.ts,
              Iterate.ts, Defaults.ts, LogFormat.ts
  test/       afiro, lp-small, netlib (LP); sdp-smoke, sdp-aho, sdp-ab,
              sdp-synthetic, tiny.
```

17 source files + 8 test files. The package is *substrate only* —
no tool wire shape yet. The barrel exports cover both `solveLp` and
`solveSdp` (= `solveSdpNt`); the LP path is what feeds Phase 2's
tool-dispatcher work.

### Adjustments required to land cleanly

Three classes of fix were needed on top of the initial drop:

1. **Hard-coded test paths.** Three SDP test files referenced an
   absolute path outside the workbench tree. Fixed by copying the
   15-line `sdp.dat-s` (a public SDPA-sparse example) into
   `packages/solver-ipm/test/fixtures/` (co-located, portable) and
   resolving via `fileURLToPath(new URL("./fixtures/sdp.dat-s",
   import.meta.url))`. The TS-native pattern.

2. **Import extension convention.** The substrate used `.ts`
   extensions in relative imports (`from "./Solver.ts"`); the
   workbench's `tsconfig.json` does not enable
   `allowImportingTsExtensions` and the convention across
   `packages/` is `.js` extensions on `.ts` sources. 35 import sites
   across 9 files renamed via sed.

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

- `bun test packages/solver-ipm/` — **68 pass, 0 fail.**
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

Two-principles test (`bd memories two-principles`) on the work
breakdown: the IPM substrate's algorithmic value (a NETLIB-capable
primal-dual IPM in pure TS, free of external linear-algebra
binding) is independent of how it gets exposed in the tool wire.
Landing the substrate first lets the tool integration (Phase 2),
contract hardening (Phase 3), and the architectural ADR (0032)
each be reasoned about independently. The arbprec lane shipped
this morning stays untouched.

### Two engines, one public tool — the lane-dispatcher pattern

A TS expert wants ONE `lp-solve` tool that picks the right method
automatically. The agent should not have to know which engine is
appropriate for their problem size. Worklog 092 wires this; this
shard lays the substrate it dispatches into.

### Keep all three SDP search directions in tree

NT (primary), AHO (A/B reference), and HKM (debug-only) all live
in `packages/solver-ipm/src/solver/`. NT is the primary export
because it matches the standard "barrier path" direction taught
in modern texts (Wright 1997, SDPT3 reference implementation).
AHO is retained as a Lyapunov-equation-based cross-check on the
convergence behaviour; HKM is retained because it is the
Helmberg-Rendl-Vanderbei-Wolkowicz 1996 direction with which the
NT-style methods are usually compared in the literature.

## Frictions surfaced

1. **Hard-coded absolute test paths** to a directory outside the
   workbench. A TS expert would have made the test data a
   co-located fixture from day one. The workbench's bench-via-
   corpus migration (ADR-0028) made this universal for corpus
   data; the SDP smoke test used a different fixture pattern that
   sidestepped the corpus.

2. **Strict-null violations on typed-array compound assignment.**
   `noUncheckedIndexedAccess: true` is load-bearing for workbench
   type discipline, but the original substrate was written in a
   style that pre-dates that flag. 27 mechanical fixes. The
   pattern `array[i] += x` doesn't typecheck under strict-null;
   rewrite as `array[i] = array[i]! + x`. Tedious; should be
   lifted into a project lint ("typed-array compound assignment
   outside `// @workbench-trusted loop`") in a future code-health
   pass.

3. **Pre-existing oracle failure on main** (bead `2dhc`). The
   workbench's worklog-090 commit shipped today without a clean
   `bun run check`. Discovered while validating that the substrate
   landing doesn't regress anything — checked main directly and saw
   the same `oracle: lp-solve` failure. This is a process gap: the
   tier-1 quality gate is supposed to be pre-commit (Rule 5: "the
   full `bun run check` is the pre-shard gate, not the inner loop"),
   and worklog-090's substrate ship slipped through it.

## Acceptance

- Branch `merge/solver-ipm-substrate` builds clean (`bun run check`
  passes except the pre-existing lp-solve golden 05).
- `bun test packages/solver-ipm/` reports 68/68 green.
- `packages/simplex-q/`, ADR-0031, worklog-090, and `tools/lp-solve/
  tool.ts` are unchanged.
- Beads filed: `prfp` (claimed), `2zed` (ADR-0032), `v4jd` (sdp-
  solve), `6or7` (substrate contract hardening), `j1gd` (algorithm
  hygiene), `2dhc` (pre-existing golden bug).

## Pointers

- `packages/solver-ipm/` — the landed substrate.
- `docs/worklog/090-lp-solve-arbprec.md` — the arbprec lane this
  substrate complements.
- `docs/adr/0030-convex-cone-solver-tier.md` — the cone-solver tier
  ADR; the `tools/lp-solve` specialist slot (LP) and the deferred
  `tools/sdp-solve` slot (SDP) are both addressed by the landing
  `solver-ipm` work.
- `bd show scientist-workbench-prfp` — Mehrotra IPM lane (claimed).
- `bd show scientist-workbench-v4jd` — `tools/sdp-solve` (open).
- `bd show scientist-workbench-6or7` — workbench-contract hardening
  on the `solver-ipm` package (gates `prfp` and `v4jd`).
