# 108 — Mosek/COPT trace-parser verification against real logs (2026-05-14)

> **Scope.** Close bead `yyme`. The `parseMosekLog` row format was shipped
> (Tier 0, worklog 106) validated only against a hand-written file that
> matched its own assumptions — a tautology. This shard runs the real
> solvers, verifies both `parseMosekLog` and `parseCoptLog` against their
> output, commits the real logs as fixtures, and clears the "unverified"
> caveats. No parser code changed.

## Context

The `ef3a56c` review (worklog 107's sibling findings) flagged that
`scripts/mosek-log-to-jsonl.ts` was closed under bead `fuur` with its
acceptance criterion 4 — "converts `probe_sdo1.log`", a *real* Mosek log —
unmet: the agent had substituted a synthetic `temp/mosek-sample.log`
hand-written to match the parser's own doc-comment. That proves the parser
parses a file written to its assumptions; it proves nothing about real
Mosek output. ADR-0033 nonetheless asserted the format as settled fact.

The user confirmed Mosek, COPT and Gurobi are all installed on this
machine, which finally made Law-1 ground truth reachable.

## Ground Truth Read

Both solvers located and run on a real NETLIB instance (`adlittle`, the
MPS already cached in `scientist-workbench-corpus/data/lp-netlib/raw/`):

- **Mosek 11.1.6** — `mosek -d MSK_IPAR_OPTIMIZER MSK_OPTIMIZER_INTPNT
  -d MSK_IPAR_LOG 10 adlittle.mps`. Interior-point table, 11 rows
  (iters 0–10), header `ITE PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU TIME`.
- **COPT 8.0.4 (build Apr 24 2026)** — `copt_cmd -c "read adlittle.mps;
  set LpMethod 2; optimize"`. Barrier table, 13 rows (iters 0–12),
  header `Iter Primal.Obj Dual.Obj Compl Primal.Inf Dual.Inf Time`.

## What The Verification Found

**Both parsers' format assumptions were already correct.** Field-by-field:

- Mosek: nine whitespace-separated tokens per row; `toks[0]` integer iter,
  `toks[1..7]` finite scientific-notation numbers, `toks[8]` time. The
  column map `PFEAS→primalInf, DFEAS→dualInf, GFEAS→gfeas,
  PRSTATUS→prstatus, POBJ/DOBJ→primal/dualObj, MU→compl, TIME→timeSec`
  matches the real header exactly. `PRSTATUS` prints as `0.00e+00` /
  `-9.84e-01` — `NUM_RE` handles both. The header line and the trailing
  `Basis identification` / `Primal. Iterations:` lines all fail the
  nine-numeric-token shape and are skipped. `parseMosekLog` on the real
  log returns exactly the 11 expected rows with correct values.
- COPT: seven tokens per row, last is a `<time>s` token; format matches
  the script's pre-existing doc-comment (which *had* claimed verification
  against a `probe1.log` — COPT was genuinely verified before; only Mosek
  was the unverified one). `parseCoptLog` returns the 13 expected rows.

So the finding was "unverified", not "wrong" — and the fix is
verification + fixtures, not a code change.

## What Changed

- `packages/solver-ipm/test/fixtures/mosek-11.1-adlittle.log` and
  `copt-8.0.4-adlittle.log` — the real solver runs, committed. The COPT
  capture had its trailing interactive-shell ANSI escapes stripped; the
  solver output itself is verbatim. These are the reproducible fixtures
  `fuur`'s acceptance criterion 4 should have produced.
- `trace-log.test.ts` — a second describe layer, "format verification
  against real solver logs": six probes reading the committed fixtures
  and asserting iteration ranges and column-by-column values transcribed
  from the raw log rows. A parser that mis-aligns a column fails here.
  The synthetic-input layer (contiguity guard, empty-input contract)
  stays — those edge cases are constructed precisely with synthetic logs.
  11 → 17 tests.
- `TraceLog.ts` — the `!! FORMAT NOT YET VERIFIED` block on `parseMosekLog`
  removed, replaced with the verification citation (Mosek 11.1.6, the
  fixture path). The COPT comment's stale `probe1.log` reference (a file
  that was never committed) updated to the committed fixture.
- ADR-0033 Decision 8 — the "Mosek row format is not yet verified" caveat
  replaced with "verified against real solver logs … committed under
  `test/fixtures/`".

## Frictions Surfaced

- COPT (`copt_cmd`) was not on `PATH` and not where the first search
  looked; it was at `~/copt80/bin/`. The user's "copt is on this machine"
  was correct — the install just isn't on `PATH`. Worth noting for any
  future COPT-driven work: `~/copt80/bin/copt_cmd`, license in `~/copt/`.
- `copt_cmd`'s `-s` flag does not exist; the scripted entry points are
  `-c "cmd; cmd"` (inline) and `-i <file>`.
- The COPT interactive prompt emits ANSI colour escapes after the script
  ends. They land in a piped capture and have to be stripped from a
  committed fixture — the parser itself is immune (non-iter lines), but a
  clean fixture is nicer to read.

## Acceptance

- `bunx tsc --noEmit` — pass.
- `bun test packages/solver-ipm/test/trace-log.test.ts` — 17 pass.
- `bun run check` — green.
- `parseMosekLog` and `parseCoptLog` each verified against a committed
  real-solver-log fixture with column-by-column assertions — the
  discharge of `yyme` (and, retroactively, of `fuur`'s acceptance
  criterion 4).

## Pointers

- `packages/solver-ipm/test/fixtures/{mosek-11.1,copt-8.0.4}-adlittle.log`
  — the real logs.
- `packages/solver-ipm/test/trace-log.test.ts` — layer 2 is the
  verification.
- `packages/solver-ipm/src/solver/TraceLog.ts` — the parsers and their
  now-citation-backed doc-comments.
- `docs/adr/0033-hsde-for-solver-ipm.md` §"Decision 8".
- Bead `yyme` (closes). Sibling review findings: `ghvl` (closed,
  worklog 107), `vvou` (corpus-test skip convention — still open).
- Gurobi 13.0.1 is also installed (`~/gurobi1301/`); no Gurobi log
  parser exists. A `parseGurobiLog` would be net-new scope, not a review
  finding — left unfiled pending a decision on whether triple-witness
  trace-diffing wants it.
