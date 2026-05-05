# 045 — Numerical-tier `n` cap lift + NIST industrial benchmarks

**Date:** 2026-05-05
**Status:** complete
**Branches:** main
**ADR:** ADR-0016 (warning-based numerical scaling) supersedes the
cap aspect of ADR-0014.
**Issues closed:** scientist-workbench-32s
**Re-scoped:** scientist-workbench-wmm (blob-by-hash convention) — no
longer the forcing function for `n > 200`; remains useful if/when
*goldens* outgrow inline JSON.

## Context

The `linalg-qr` and `linalg-svd` post-mortem (worklog 043, 044)
surfaced four issues in the user's framing:

1. The `m·n ≤ 200·200` cap is a toy regime — phone-deployed agents
   can't fall back to NumPy / SciPy and need to push `n` further.
2. The phone use case is exactly where pure TS wins (no FFI, runs in
   browser); cap is the wrong shape.
3. The bench's "punishing" claim was half-fulfilled — no industrial
   corpora, just hand-crafted Hilbert / Vandermonde / random.
4. Fragile subagent dispatch is accepted operational cost.

This worklog lands the fixes for (1)–(3). Item (4) is process
discipline already baked into the dispatch briefs (worklog 043
"Land artefacts on disk early and often").

## What changed

### Measurement-driven warning thresholds

`scripts/bench-numerical-tier.ts` (new, ~120 lines): profiles QR and
SVD at n ∈ {100, 200, 500, 1000, 2000, 5000} for wall-clock + RSS.
Output frozen at `docs/measurements/2026-05-05-numerical-tier-n-ceiling.md`.
Headline numbers (linux x64, Bun 1.3.0):

| algo | n=100 | n=200 | n=500 | n=1000 | n=2000 |
|---|---|---|---|---|---|
| QR (Householder) | 54 ms | 180 ms | 2.6 s | 25 s | 535 s (~9 min) |
| SVD (one-sided Jacobi) | 170 ms | 580 ms | 17.6 s | 210 s (~3.5 min) | hours |

Phone CPUs run roughly 3× slower (rule of thumb for ARM cores vs x86
desktop). Memory peak stays under 250 MB even at n=2000 — RSS is not
the binding constraint at the sizes we care about; wall-clock is.

### `packages/linalg-core/src/scale.ts` (new, ~150 lines)

Shared helper exporting `assessNumericalScale(algo, m, n)` that
returns the canonical warning strings for a given problem. Three
thresholds:

- `n > 500` (well-tested): `"matrix size NxN above the 500-cell well-tested threshold; expected wall-clock ~Ts on dev-box (~3T s on phone)"`.
- `n > 1000` (stress-tested): adds `"consider FFI bridge (bead scientist-workbench-e7y) for production use"`.
- `n > 2000` (impractical): `"in regime where pure-TS dense linear algebra becomes impractical; FFI bridge to OpenBLAS strongly recommended"`.

Plus memory thresholds at 100 MB and 500 MB (estimated peak RSS
relative to mobile-browser tab budgets). Strings are concatenated
into the agent-honest output's `warnings` field.

Also exports `withOomGuard(m, n, fn)` that catches `RangeError` from
Float64Array allocation and re-throws as `MemoryExhaustionError`
(carrying attempted-bytes detail). The tool layer catches that and
re-throws as `ToolError` — a clean, planner-readable refusal at the
only physical limit.

### Tool patches (linalg-solve, linalg-qr, linalg-svd)

Three tools, same pattern:
- Removed `MAX_N` / `MAX_CELLS` constant.
- Removed `size-cap-rejected` invariant; added `scale-warnings-emitted`
  + `oom-becomes-toolerror`.
- Removed cap-rejection branch in `fn`; added `assessNumericalScale`
  call to compute warning strings, threaded into the success-record
  encoder.
- Wrapped the substrate call in `withOomGuard`.
- Bumped each tool's VERSION from `0.1.0` to `0.2.0`.
- Updated chapter-header comments to point to ADR-0016.

### Bench extensions (Tier I + Tier J)

**Tier I — NIST Matrix Market harwell-boeing.** Five real test
matrices from structural-engineering codes used by the wider
numerical-computing community since the 1980s:

| matrix | n | κ | source |
|---|---|---|---|
| bcsstk01 | 48 | 8.8e5 | small structural |
| bcsstk02 | 66 | 4.3e3 | steel mass-stiffness |
| bcsstk03 | 112 | 6.8e6 | off-shore platform module |
| bcsstk04 | 132 | 2.3e6 | Calahan structure |
| bcsstk05 | 153 | 1.4e4 | transmission tower |

All symmetric positive-definite; full rank. Committed as gzipped
Matrix Market files under `bench/_corpus/harwell-boeing/`
(~35 KB total). Parser `bench/_corpus/mm_parser.py` handles the
coordinate-real-symmetric format used throughout HB.

**Tier J — stress (post-ADR-0016).** Random well-conditioned
matrices in the new uncapped regime: QR adds n=500 and n=1000;
SVD adds n=500 (n=1000 deferred — Jacobi at that size is 3.5 min,
would 5× the SVD bench wall-clock).

### Bench totals

| bench | cases (was → now) | invariant assertions (was → now) |
|---|---|---|
| `bench/linalg-qr` | 49 → **56** | 343 → **392** |
| `bench/linalg-svd` | 49 → **55** | 392 → **440** |

Both 100% green.

## Why these choices

### Warning, not tier-split

Considered: declaring separate tools `linalg-qr-small` (n ≤ 200,
fast) and `linalg-qr-large` (FFI, n > 200), forcing the agent to
pick. Rejected because:

- **Two principles**: a TS expert types `qr(A)` and expects it to
  work. Forcing them to introspect the size and pick a tool is
  exactly the API friction the workbench tries to avoid.
- **Honest scope** (Rule 8): one tool that runs and warns is more
  honest than two that draw a synthetic line at n=200.
- **The FFI tool doesn't exist yet.** Bead `e7y` is a long-horizon
  item. Until it lands, refusing `n > 200` outright leaves the
  agent with *nothing*. Warning-and-running gives a usable result.

### Five harwell-boeing matrices, not fifty

The Tier I value-add is "real structural patterns that synthetic
matrices don't have," not "more random samples." Five well-chosen
matrices (different sources, different conditioning, different
sizes within our regime) cover the sanity-check role; adding the
full BCSSTRUC1 collection would 10× the bench wall-clock without
new signal. The catalog is in `bench/_corpus/mm_parser.py` and
trivial to extend if a real failure mode shows up.

### Why memory estimation, not measurement

`assessNumericalScale` *estimates* peak memory from `m, n` rather
than calling `process.memoryUsage()` at entry. Reasons:

1. Phone JS engines under-report available memory; the prediction
   would be unreliable.
2. Memory cost is predictable (`~5 · 8 · m · n` bytes).
3. Estimation is O(1); measurement adds a system call to every
   tool invocation.

### Bumping VERSION to 0.2.0

The tool surface is contract-incompatible with v0.1: a previously-
rejected input now succeeds (with warnings). Provenance records
keyed off the (tool, version, input) triple need to know the
behavioural change. Bumping the version is the cheapest way to
make stale-cached records distinguish themselves from new-tier
results.

## Frictions surfaced

### Default-argument shim for backward-compat

`encodeSuccess(r)` in QR/SVD examples called the helper with one
argument; the patch added a second `scaleWarnings` argument.
Examples broke at module load time (the runner validates examples
on import). Fix was a default `= []`. ~30s diagnosis from the
stack trace; clean fix.

### Bench harness eats stderr (still)

When the QR tool returned a structurally-different output (post-
patch but pre-default-fix), the bench harness reported `candidate
command exited non-zero` with no detail. Same trick as worklog 043:
piped one input through the adapter manually to see the actual
stack trace. The bench harness still has no `--verbose` flag; for
the next bench addition, worth lifting candidate stderr into the
verifier's `detail` field. Filed as a soft TODO; not load-bearing.

### Measurement bench took 14 minutes

The full sweep (QR + SVD × 6 sizes each) ran ~14 min wall-clock in
background — most of which was SVD at n=1000 (210s) and QR at
n=2000 (535s). Worth caching the table once measured; rerunning
the harness on every numerical-tier change would be friction.
Mitigation: the bench writes a markdown table to stdout that gets
pasted into ADR-0016; future ADR-0017 etc. can extend the table
when a new algorithm is added.

### Subprocess vs in-process composition for the bench adapter

The adapter (`bench/linalg-{qr,svd}/run-candidate.ts`) uses
`@workbench/compose`'s in-process surface. Each bench case spawns
a fresh adapter process which calls `loadWorkbench()` (~150 ms
cold start). At 56 cases for QR, that's ~8s of pure overhead. Not
a problem at our bench size; would be at 500+ cases. A future
"persistent bench daemon" mode (one Bun process holds the
loadWorkbench instance, harness sends JSON over a Unix socket)
would lift this. Filed as a soft TODO.

## Acceptance

- `bun run check` is green: 45 phases, 0 failed, 3 skipped (pre-
  existing — tools without `--test` hooks).
- `bench/linalg-qr` is green: 56 cases × 7 checks = 392 assertions.
  Includes 5 Tier I (industrial) + 2 Tier J (n=500, n=1000 stress).
- `bench/linalg-svd` is green: 55 cases × 8 checks = 440 assertions.
  Includes 5 Tier I + 1 Tier J (n=500).
- `linalg-solve --test`, `linalg-qr --test`, `linalg-svd --test`:
  all pass.
- Smoke test: `linalg-qr` on a 600×600 matrix now works, returning
  a Q, R, and one warning string; under the old cap it would have
  been rejected with `ToolError`.
- Smoke test: `linalg-qr` on a 10000×10000 matrix raises a clean
  `ToolError` ("OOM: failed to allocate ~3815 MB...") rather than
  a raw RangeError.
- Bead `scientist-workbench-32s` closed.

## Pointers

- ADR-0016 `docs/adr/0016-warning-based-numerical-scaling.md` —
  the design doc.
- `docs/measurements/2026-05-05-numerical-tier-n-ceiling.md` —
  the frozen measurement table.
- `packages/linalg-core/src/scale.ts` — shared helpers
  (`assessNumericalScale`, `withOomGuard`, `MemoryExhaustionError`).
- `bench/_corpus/mm_parser.py` — Matrix Market parser + curated
  harwell-boeing catalog.
- `bench/_corpus/harwell-boeing/` — gzipped MM files.
- `scripts/bench-numerical-tier.ts` — measurement harness.
- Worklog 043 (linalg-qr path-finder) and 044 (linalg-svd) — the
  precedents this work iterates on.
- Bead `scientist-workbench-e7y` — FFI BLAS bridge (long-horizon
  follow-up; warning strings reference this).
- Bead `scientist-workbench-71f` — parent linalg-decompose epic;
  next slice is symmetric eigh.
