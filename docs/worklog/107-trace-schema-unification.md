# 107 — Trace-schema unification: one `TraceLine`, typechecked parsers (2026-05-14)

> **Scope.** Close bead `ghvl`. Reconcile the three hand-maintained
> verbose-trace interfaces (`VerboseIterLine`, `CoptIterLine`,
> `MosekIterLine`) into one typechecked schema, and move the COPT/Mosek
> log-parsing logic out of untyped scripts into `@workbench/solver-ipm`.
> No solver trajectory changes; this is type-discipline and structure.

## Context

A review of commit `ef3a56c` (HSDE Phase 5 Tier 0, worklog 106) surfaced
three coupled issues in the verbose-trace plumbing, filed as bead `ghvl`:

1. Tier 0 added `"mosek"` to `VerboseIterLine.kind` — but `VerboseIterLine`
   is the *solver-emitted* type, and no solver emits a Mosek line. The
   sibling `scripts/copt-log-to-jsonl.ts` used `kind: "copt"` via its own
   standalone interface and `"copt"` was never added to the union. The two
   log-parsers got opposite treatment, and the widening went to the script
   that didn't need it.
2. The `VerboseIterLine` doc-comment enumerates every `kind` value's
   meaning but was not updated for `"mosek"` — type and its own literate
   doc out of sync.
3. `CoptIterLine` and `MosekIterLine` were ~35-field interfaces
   hand-duplicated inside the script files, claimed "aligned with the
   `VerboseIterLine` schema" but with no type-level link. `ef3a56c` added
   `nitref1/2/3` to all three by hand.

While reading ground truth, a sharper fact emerged: **`scripts/` is not in
the `tsconfig.json` `include`** (`packages/*/src`, `packages/*/test`,
`tools/*/*.ts` only). So `tsc --noEmit` never typechecked the parser
scripts at all — a `satisfies TraceLine` *inside a script* would have been
inert. The fix had to move the type-bearing logic somewhere `tsc` looks.

## What Changed

New file `packages/solver-ipm/src/solver/TraceLog.ts`:

- `TraceLine` — the single persisted-JSONL schema. Extends `IterLogLine`
  (the seven core IPM scalars, always real numbers — every producer has
  them), adds every solver-internal diagnostic as `number | null`, and a
  `kind` union covering the six solver kinds **plus** `"copt"` and
  `"mosek"`.
- A compile-time assertion — `const _verboseIsTraceLine: (v:
  VerboseIterLine) => TraceLine = (v) => v;` — proves every solver-emitted
  `VerboseIterLine` is a valid `TraceLine`. If either type drifts out of
  the subtype relation, `bun run check` fails to compile.
- `parseCoptLog(text) => TraceLine[]` and `parseMosekLog(text) =>
  TraceLine[]` — the parsing logic lifted verbatim from the two scripts,
  now returning `TraceLine[]` so their object literals are checked against
  the schema by `tsc` (this file is under `packages/*/src`).

`VerboseIterLine.kind` (`Solver.ts`) — `"mosek"` removed; the type is back
to the six solver kinds its doc-comment documents. The doc-comment now
points at `TraceLine` as the persisted superset and says "add new fields
to **both**."

`scripts/copt-log-to-jsonl.ts` and `scripts/mosek-log-to-jsonl.ts` — shrunk
from ~160 / ~180 lines to ~40-line CLI shells: argv handling, `readFileSync`,
call the parser, `JSON.stringify`, write. Nothing left in them can drift
from the schema.

`packages/solver-ipm/src/index.ts` exports `TraceLine`, `parseCoptLog`,
`parseMosekLog`.

New test `packages/solver-ipm/test/trace-log.test.ts` — 11 probes on the
parsers' *documented behaviour*: column mapping, `kind` tag,
solver-internal-fields-null, the contiguous-iteration guard, the
empty-input contract, and (Mosek) the `gfeas`/`prstatus` mapping plus
optional-trailing-`s` time token.

ADR-0033 Decision 8 — rewritten to describe the two-type split
(`VerboseIterLine` in-process, `TraceLine` persisted) instead of the
single widened union.

## Why These Choices

- **Two types, not one widened union.** `VerboseIterLine` is consumed by
  `formatVerboseLine` and the `verbose:` callback — strictly an in-process
  thing. `TraceLine` is the persistence/diff schema. They have genuinely
  different shapes (`number` vs `number | null`; six kinds vs eight). The
  subtype assertion gives the safety of one type without conflating two
  roles. Two principles: a TS expert keeps "what the solver emits" and
  "what the diff harness reads" as separate types with a proven relation,
  not one loose union.
- **Logic into the package, scripts as shells.** This is the same split
  the workbench already uses for tools (`tool.ts` thin, logic in
  `packages/`). It is also the *only* way to get the parsers typechecked
  given `scripts/` is outside the `tsc` include — and it makes the
  duplicate-interface drift (#3) structurally impossible rather than
  merely discouraged.
- **`parseMosekLog` honesty preserved.** The Mosek format is still
  unverified against a real log (bead `yyme`); `TraceLog.ts`'s doc-comment
  and ADR-0033 both say so explicitly. This shard does not pretend to fix
  `yyme` — it only makes the parser typechecked and unit-tested *against
  its own spec*, which is a separate axis from "is the spec right."

## Frictions Surfaced

- **`scripts/` is entirely outside the typecheck net.** Discovered mid-task.
  This is broader than `ghvl` — every script under `scripts/` is unchecked
  by `tsc`. Not addressed here (honest scope); worth a follow-up bead to
  decide whether to add `scripts/` to the `include` (blast radius unknown
  — other scripts may have latent type errors).
- **`@workbench/solver-ipm` is not in `tsconfig.json` `paths`.** It
  resolves anyway under `moduleResolution: bundler` via the `node_modules`
  workspace symlink (confirmed: `tools/lp-solve` already imports it and
  typechecks). The `paths` list is incomplete, not load-bearing — another
  latent inconsistency, left alone.
- Field order in the emitted JSONL changed slightly (the parser spreads
  the core scalars first). Harmless: `trace-diff.ts` is field-order-
  independent (`Object.keys` union) and these scripts have no goldens.

## Acceptance

- `bun run typecheck` — pass.
- `bun test packages/solver-ipm` — all pass, including the 11 new
  `trace-log.test.ts` probes.
- `bun run check` — green.
- Both scripts smoke-tested: `copt-log-to-jsonl.ts` and
  `mosek-log-to-jsonl.ts` produce correct unified-schema JSONL.
- Solver trajectories untouched — `sdp-solve` goldens unchanged.

## Pointers

- `packages/solver-ipm/src/solver/TraceLog.ts` — `TraceLine`, the
  subtype assertion, `parseCoptLog`, `parseMosekLog`.
- `packages/solver-ipm/src/solver/Solver.ts` — `VerboseIterLine` (the
  in-process type) and the cross-reference doc-comment.
- `docs/adr/0033-hsde-for-solver-ipm.md` §"Decision 8" — the two-type
  contract.
- Bead `ghvl` (closes). Related: `yyme` (Mosek format verification),
  `vvou` (corpus-test skip convention) — the other two findings from the
  `ef3a56c` review.
