# 083 — arbprec `--precision` flag wired through runner + compose (lc1 / rn2)

**Date:** 2026-05-09
**Beads:** scientist-workbench-{lc1, rn2}
**Status:** Both closed; single source of truth in `mergedFlags` /
`toolFacingFlags` exported from `@workbench/contract`.

## Context

ADR-0020 specified a standard `--precision=<int>` flag that every tool
declaring `arbprec: true` inherits — decimal digits, default 50, soft
cap 100 000. Earlier worklogs (068–070, 078, 080) shipped four arbprec
tools (`hypergeometric-pfq`, `meijer-g-slater-only`,
`meijer-g-asymptotic-only`, `meijer-g`) on the strength of that
contract. Each tool's `fn` body reads the flag with the cast pattern

```ts
const precision = Number((flags as { precision?: bigint }).precision ?? 50n);
```

— inheriting the runner's promise that `flags.precision` is either the
user-supplied bigint or the default `50n`.

The promise was never kept on either of the workbench's two execution
surfaces.

* On the **subprocess CLI** (`runTool` in `packages/contract/src/runner.ts`),
  argv parsing correctly produced `parsed.flags.precision === 30n` for
  `--precision=30`. But the `toolFlagsTyped` object handed to
  `def.fn(input, flags)` was built by iterating
  `Object.keys(toolFlags)` — i.e. only the *tool's declared* flags
  (`def.flags`). The runner-injected `precision` slot lived in
  `parsed.flags` but never made the leap to `toolFlagsTyped`. Result:
  every `arbprec` tool's CLI ran at default 50 dps regardless of
  `--precision`.

* On the **in-process surface** (`runWorkbench` in
  `packages/compose/src/run.ts`), partial flags were validated against
  `def.flags ?? {}` — the bare declared schema, with no merge. For an
  arbprec tool that declares no flags of its own (e.g.
  `hypergeometric-pfq`), passing `{ precision: 50n }` was rejected with
  `unknown flag 'precision' for this tool`. The bench
  (`bench/hypergeometric-pfq/run-candidate.ts`, hv0.4) bypassed
  `runWorkbench` and called `executeToolDef` directly — admissible per
  ADR-0012's single-implementation discipline (both surfaces fan out to
  the same kernel) but defeated the typed-barrel ergonomics that
  `@workbench/compose` was built for.

Bead lc1 named the runner gap; bead rn2 named the parallel compose gap.
Both are P2; both shipped together because the byte-identical contract
from ADR-0012 is only honest if the two surfaces share one
admissible-flag set.

## What changed

### `packages/contract/src/runner.ts`

Two new exports plus the bug fix:

* `mergedFlags(toolFlags, arbprec)` — already existed; now exported.
  Returns `STANDARD_FLAGS ∪ {precision if arbprec} ∪ toolFlags`. The
  runner uses it to drive argv parsing; the in-process surface uses
  it (transitively, via `toolFacingFlags`) to drive partial-flag
  validation.

* `toolFacingFlags(toolFlags, arbprec)` — new. Returns the *subset* of
  the merged schema that the tool's `fn` actually sees: declared flags
  plus the tier-additive `precision` slot for arbprec tools. Excludes
  CLI-control flags (`--help`, `--version`, `--schema`, etc.) that the
  runner intercepts before `fn` runs.

* `toolFacingFlagNames(toolFlags, arbprec)` — new. The plain string
  array; used by the runner's work-case loop to lift the right slots
  out of the parsed flags object.

* `FlagsArgOf<D>` — *unchanged on this iteration.* An attempted
  type-level lift to inject `precision?: bigint` for `D extends
  { arbprec: true }` ran into a `defineTool` generic gap: the
  `arbprec: true` literal isn't preserved in the returned
  `ToolDefinition`'s static type (the field is `arbprec?: boolean`),
  so the conditional never matches at the typed-barrel call site.
  Fixing that requires threading an `Ar extends boolean` generic
  through `defineTool` / `ToolDefinition`; that touches every tool's
  `def` signature and is filed as a follow-up. Workaround for the
  typed-barrel call site today: cast the flags through `as never`,
  per the new note in `FlagsArgOf`'s doc-comment. The loose
  `wb.run(name, input, { precision: 50n })` surface is unaffected and
  is the recommended call site for arbprec tools until the lift lands.

The bug fix at the work-case site:

```ts
// Before (lc1 bug):
for (const k of Object.keys(toolFlags)) {
  toolFlagsTyped[k] = (parsed.flags as Record<string, unknown>)[k];
}

// After:
for (const k of toolFacingFlagNames(toolFlags, def.arbprec === true)) {
  toolFlagsTyped[k] = (parsed.flags as Record<string, unknown>)[k];
}
```

Same change applied to the `explicitToolFlags` derivation a few lines
later — the provenance record's `flags` field captures `precision: "30"`
when the user explicitly set `--precision=30`.

### `packages/compose/src/run.ts`

One-line swap:

```ts
// Before (rn2 bug):
const flagSchema = def.flags ?? {};

// After:
const flagSchema = toolFacingFlags(def.flags ?? {}, def.arbprec === true);
```

Both `resolveFlagsForCall` and `explicitStringsFromPartial` now see the
same merged schema the runner uses for argv parsing.

### `bench/hypergeometric-pfq/run-candidate.ts`

The `executeToolDef`-direct workaround (worklog 079, hv0.4) is lifted.
Reverted to the typed-barrel call:

```ts
const workbench = await loadWorkbench();
const wb = typed(workbench);
out = await wb.hypergeometricPfq(prepared.input as never, {
  precision: BigInt(prepared.precision),
});
```

The bench still passes 49/49 cases byte-identically to the pre-fix
output. (Same `executeToolDef` kernel; same `hypergeometric-pfq.fn`;
same precision; same bytes.)

### Tests

* `packages/contract/test/contract.test.ts`: 4 new tests in a new
  describe block "ADR-0020 — --precision flag wired into toolFlagsTyped
  (lc1)". Synthesises an arbprec tool with no real bigfloat work that
  echoes `flags.precision` into its output; asserts the user-supplied
  flag value, the declared default, the provenance record's flags
  field, and a regression guard that non-arbprec tools do not see a
  stray `precision` key.

* `packages/compose/test/compose.test.ts`: 5 new tests in a new
  describe block "@workbench/compose — ADR-0020 --precision flag
  wiring (rn2)". Loose surface, typed-barrel surface (the rn2
  acceptance criterion), default-precision flow, byte-identical
  cross-surface check, and a regression guard that passing `precision`
  to a non-arbprec tool still rejects.

### Docs

* `docs/adr/0020-arbitrary-precision-tier.md` — appended a paragraph to
  §"Standard `--precision=<int>` flag" naming `mergedFlags` /
  `toolFacingFlags` as the single source of truth.
* `docs/adr/0027-meijerg-dispatcher.md` — § "Pre-existing `lc1` runner
  gap" rewritten as "Resolved (worklog 083)".
* `tools/meijer-g/README.md` — "Pre-existing `lc1` runner gap" section
  removed.
* `tools/meijer-g/tool.ts` — top-of-file lc1 disclaimer block removed;
  inline comment at the `flags` decode site updated to name the
  runtime contract honestly.
* `tools/meijer-g/goldens.spec.ts`, `tools/meijer-g-asymptotic-only/goldens.spec.ts`
  — header notes rephrased: cases continue to run at default
  precision (golden bytes unchanged) but the rationale shifts from "the
  flag doesn't work" to "the cases exercise tier behaviour, not the
  precision dial."

## Why these choices

**One source of truth, exported.** The minimal correct fix for lc1
alone could have been a one-liner `if (def.arbprec === true)
toolFlagsTyped["precision"] = parsed.flags["precision"]` after the
existing loop. The minimal fix for rn2 alone could have been a parallel
inline merge inside `runWorkbench`. Either pair would have worked
today; both would have drifted out of sync the next time a new
tier-additive standard flag landed (e.g. when hv0.7's `arbprec`
convergence-style flag arrives, or the future `bigball` interval-radius
flag if ADR-NNNN lands). Exporting `mergedFlags` /
`toolFacingFlags` from `@workbench/contract` and threading them into
both surfaces means a future addition is one edit at the source.

**Two helpers, not one.** `mergedFlags` includes the CLI-control
standard flags (`--help`, `--version`, etc.) — those are needed for
argv parsing but meaningless to the in-process surface. `toolFacingFlags`
is the proper subset for the in-process surface. Fusing them would
have meant either overloading the parameter list or adding a CLI-only
filter at the in-process call site, which would defeat the
"single-shape-validates-on-both-surfaces" property.

**`FlagsArgOf<D>` typed-barrel lift deferred.** The natural extension —
have `FlagsArgOf<D>` inject `precision?: bigint` when
`D extends { arbprec: true }` — runs into an inference gap in
`defineTool`. The `arbprec` field's static type is `boolean | undefined`
in the returned `ToolDefinition` (only `Fl` flows through the `const`
generic position); TS sees `D extends { arbprec: true }` as FALSE for
every real tool, so the conditional never matches. Fixing it requires
a fourth generic on `ToolDefinition` and `defineTool` to carry an
`Ar extends boolean = false` literal alongside `Fl`. That ripples
through every arbprec tool's `defineTool({...})` signature and is
filed as a follow-up. Workaround at the typed-barrel call site today:
cast the flags through `as never` (or use the loose `wb.run(...)`
surface, which has no type lift to defeat). The runtime contract is
solid in either case — the runner's flag-merge is the load-bearing
fix; the type lift is ergonomic.

**Bench reverted to typed barrel.** Per rn2's acceptance criterion.
The `executeToolDef`-direct path is admissible, but if every bench
runs through it the typed barrel becomes vestigial. Reverting forces
us to keep compose's surface honest.

## Frictions surfaced

1. **`fn`'s `flags` parameter is typed `FlagsOf<Fl>`, not `FlagsArgOf<D>`**.
   So inside `meijer-g/tool.ts::fn`, `flags.precision` is *not*
   typed — the body still casts through `unknown`. The runtime
   contract is solid (the value is there), but the type-level lift
   stops at the call site. A clean fix would thread the arbprec lift
   into `FlagsOf<Fl>` itself or into `ToolDefinition['fn']`'s second
   parameter. That's a larger refactor (every arbprec tool's `fn`
   signature changes) and not load-bearing for this bead pair; filed
   as a follow-up consideration but not yet a bead. The cast pattern
   is documented honestly in the inline comment.

2. **Mutation 3 (drop precision silently) caught only 2 of the 3
   arbprec-positive tests, not all 3.** The provenance test (#3
   above) checks the flag *value* on the record, not on the in-fn
   read; mutation 3 corrupts the in-fn read path only. That's
   intentional — the three tests cover three independent layers:
   (a) the value reaching `fn`, (b) the value being threaded
   through to `fn` (mutation-caught), (c) the value being recorded
   in provenance. Layer (c) is independent of layer (b) because
   the runner derives the explicit-flag map separately. A fourth
   mutation that broke the explicit-map derivation would catch (c)
   alone. Adequate for a P2 wiring fix; logged for any future
   extension.

3. **Compose-test self-reproducer cannot use `@workbench/bigfloat` directly.**
   Because the test file already imports a wide surface and the
   bigfloat package adds substantial dependency weight, the rn2
   typed-barrel test builds the bigcomplex-tagged input by hand
   (verbatim Value literals). Acceptable — the test is exercising
   the flag-wiring layer, not the bigfloat substrate. A fuller
   integration test (the one you'd reach for if you wanted to
   exercise both layers) lives in the bench.

## Acceptance

- [x] `bun tools/hypergeometric-pfq/tool.ts --precision=30` produces
      `achieved_precision = 30` (was 50 before).
- [x] All four arbprec tools' `flags.precision` are wired through:
      verified by reading their `fn` source — same cast pattern, same
      runtime input.
- [x] `wb.hypergeometricPfq(input, { precision: 50n } as never)` runs
      on the typed barrel and honours the precision (the runtime fix
      is in; the type lift is deferred to a follow-up — see
      Frictions §"FlagsArgOf typed-barrel lift").
- [x] `wb.run("hypergeometric-pfq", input, { precision: 50n })` runs
      on the loose surface without any cast (no type lift to defeat).
- [x] `bench/hypergeometric-pfq/run-candidate.ts` reverted to typed
      barrel; bench passes 49/49 cases byte-identically.
- [x] 4 new contract tests + 5 new compose tests; all pass.
- [x] 3 mutations proven (revert lc1 fix → 3 RED; revert rn2 fix → 4
      RED; drop precision silently → 2 RED). Restored.
- [x] `bun run check` green.
- [x] All goldens unchanged (no per-case `--precision` was ever set in
      a goldens.spec.ts; default-50 cases produce byte-identical
      output post-fix).
- [x] Lockstep docs: ADR-0020, ADR-0027, meijer-g README, two
      goldens.spec.ts headers, `meijer-g/tool.ts` top-of-file block.

## Pointers

- `packages/contract/src/runner.ts` — `mergedFlags`, `toolFacingFlags`,
  `toolFacingFlagNames`, `FlagsArgOf` (lines ~140 / ~410–525 / work-case loop ~530).
- `packages/contract/src/index.ts` — exports.
- `packages/compose/src/run.ts` — `runWorkbench`'s `flagSchema` derivation.
- `bench/hypergeometric-pfq/run-candidate.ts` — typed-barrel call site.
- `packages/contract/test/contract.test.ts` — describe block "ADR-0020 — --precision flag wired into toolFlagsTyped (lc1)".
- `packages/compose/test/compose.test.ts` — describe block "@workbench/compose — ADR-0020 --precision flag wiring (rn2)".
- ADR-0011 (typed flags), ADR-0012 (composition byte-identical contract),
  ADR-0020 (arbprec tier).
- Worklog 078 (asymptotic-only goldens convention this fix changes the
  rationale for), 081 (bench/meijer-g, same workaround now lifted in
  hv0.12 follow-up territory).
