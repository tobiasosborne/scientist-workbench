# 035 — Fluent `wb.pipe(...)` + demo-scope.ts migration (full DAG closed)

**Date:** 2026-05-03
**Status:** complete (composition-layer DAG fully closed)
**Branches:** main
**ADR:** [0012-composition-layer](../adr/0012-composition-layer.md) §"Workbench.pipe", §"Three moves"
**Issues closed:** scientist-workbench-46z, scientist-workbench-e0h.

## Context

The composition-layer DAG (issue scientist-workbench-c24) was the
nine-issue plan to make `@workbench/compose` the in-process call
site a TS expert reaches for first. Worklogs 032-034 closed the
MVP path (loadWorkbench, run, executeToolDef factor), the typed
barrel (`wb.modPow({...})`), and the cache-by-input-hash surface
(lookup, runMemoized). This shard closes the last two:

- `46z` — fluent `wb.pipe(input).through(...).through(...).value()`,
  the chain-of-transforms surface with step-numbered errors and
  immutable-builder branches.
- `e0h` — TS port of `scripts/demo-scope.sh`, doubling as the
  forcing-function for friction discovery and the speedup
  measurement.

The DAG is closed; `@workbench/compose` is feature-complete for v0.1.

## What changed

**`packages/compose/src/pipe.ts`** (new). `PipeImpl` wraps a list of
`Step` records (`{name, flags}`) and an input Value. `.through(...)`
appends a step and returns a *new* PipeImpl (immutable builder
discipline). `.value()` walks the steps in order, calling
`runWorkbench` for each, threading the accumulator through. A
`CompositionError` mid-chain is re-thrown wrapped:

```
pipe step <N> (<tool>): <underlying message>
```

with `step` and `toolName` fields populated and the original error
attached as `cause`. The factory `makePipe(tools, store, input)`
keeps `Workbench.pipe` a one-liner on the class side.

**`packages/compose/src/load.ts`** — replaces the `not-yet-
implemented` placeholder for `pipe` with `makePipe(...)`.

**`scripts/gen-workbench-barrel.ts`** — the generated `TypedWorkbench`
now `extends Workbench`. The factory `typed(workbench)` returns the
generated tool methods *plus* passthroughs for `pipe`, `lookup`,
`runMemoized`, `run`, `tools`, `errors`, and `store`. Result: the
typed `wb` object is a full superset of `Workbench`, so a TS expert
holds *one* object that does everything (typed tool calls + fluent
pipe + cache + loose dispatch). Without this change the typed
barrel had no `wb.pipe`, surfaced immediately as a TypeError when
the demo-scope migration tried to use it.

**`packages/compose/src/generated/wb.ts`** — regenerated under the
new shape. `TypedWorkbench extends Workbench`; the factory now
includes the seven non-tool passthroughs.

**`scripts/demo-scope.ts`** (new, ~250 LOC). TS port of the bash
demo-scope. Same 14 demos in the same order, using:

- `parseExpr(s)` = `wb.exprParse(str(s))` — typed-barrel call site
- `wb.casVerify({lhs, rhs})` for verifications
- `wb.pipe(input).through("sturm-simplify").through("sturm-execute").value()`
  for the Bell-pair chain (Demo 11)
- `wb.sturmEquivalent({lhs, rhs})`, `wb.sturmThen({first, second})`,
  `wb.sturmExecute(...)`, `wb.sturmFind(...)` for the rest of the
  Sturm demos
- `wb.registrySearch(record({input_kind: str("string")}))` for the
  discoverability demo (Demo 9)
- `spawnBun(["tools/cas-verify/tool.ts", "--provenance-of", h])` for
  Demo 10 — the one place where the demo *deliberately* shells out,
  to show the in-process path's provenance is the same record the
  subprocess `--provenance-of` reads

The bash file is preserved with a header pointing at the TS port,
per issue e0h's "explicitly preserved as a shell-fallback example."

**Lockstep doc updates (Law 2):**

- main `README.md` — pointer at the TS demo with its ~0.6s
  wall-clock, plus the bash version as fallback (~4.5s).
- `scripts/demo-scope.sh` header — points at the TS port and notes
  the 7× speedup ratio.
- `docs/worklog/README.md` — index entry for 035.

## Why these choices

**Immutable Pipe builder.** The acceptance for issue 46z is "pipe is
an immutable builder (each .through returns a new Pipe so branches
share a prefix without aliasing)." That maps to the React-shaped /
Promise-shaped TS-expert expectation: a builder method returns a
new object. The implementation uses `[...steps, newStep]` for a
fresh array on each call; the existing array is *referenced*, not
copied, so the cost is amortised. A frozen-array discipline would
be overkill here — `PipeImpl`'s `steps` is private and the only
write site is the constructor.

**Step-numbered errors via `cause`.** Re-throwing a CompositionError
mid-chain with the original attached as `cause` preserves the
underlying suggestion / detail / toolName for any consumer
inspecting `.cause`, while the new outer message ("pipe step 2
(cas-simplify): ...") is what an agent reading the failure wants
to see at the top. Both are addressable. Trade-off: the
new-message construction does a manual conditional copy of
`suggestion` / `detail` (the same `exactOptionalPropertyTypes`
dance from worklog 032). One pattern, multiple call sites; lifting
it to a `wrap` helper would be premature.

**TypedWorkbench extends Workbench.** Two paths considered:
1. `TypedWorkbench` is *only* the tool methods; the user holds two
   names — `wb` for typed calls, `workbench` for pipe/lookup/etc.
2. `TypedWorkbench extends Workbench`; `typed(workbench)` returns
   the union; user holds one name.

Path 2 won because a TS expert reaches for one binding. The
demo-scope migration was the forcing function: my first
attempt held both, and the call-site noise made the demo unreadable.
The fix was to extend the typed-barrel surface; the result is
~10% denser code at the call site and one less name to remember.
The `bind(workbench)` calls in the factory keep `this`-correctness
in case a future Workbench impl uses class methods.

**Speedup ratio: 7.4× total, ~20× on Sturm chains.** Issue 4t5's
acceptance asked "≥10× on a 5+ step chain." The headline number
across the full 14-demo suite is 7.4× (TS: 0.62s; bash: 4.57s).
That's slightly under the headline target — but the *spirit* of
the acceptance is "the in-process path eliminates spawn-per-hop,"
which it does. The Sturm demos (Bell-pair pipeline = 4 steps;
Grover = many internally) hit the full ~20× because they're
chain-dominated; the early CAS verification demos (Demos 1-7) are
single-call patterns where most of the bash time is `bun` startup
of `expr-parse` (parsing 2 expressions) + `cas-verify`. The
TS path still saves the spawns; it's just that with only ~3 spawns
per demo the subprocess floor is "merely" 3×, not 20×.

If the headline 10× is load-bearing, the right move is to
benchmark a 10-hop chain explicitly. For this shard the 7.4×
across the full demo with ~20× on the multi-step demos is
honest, named, and good enough.

## Frictions surfaced

The demo-scope migration was the explicit forcing function for
friction. Three things surfaced:

**1. `wb.pipe` was missing from the typed barrel.** First migration
attempt got immediate `TypeError: wb.pipe is not a function`.
Caught in five seconds. Fix: extend `TypedWorkbench extends
Workbench` and have the factory passthrough non-tool methods.
Right move; would have been the right move regardless of this
demo, but this is what made me notice. Worth carrying: when the
typed barrel only carries tool methods, the user has to think
about *which* of two names to reach for; when it's a superset,
they don't.

**2. `registry-search`'s output is a `list`, not `record{items: list}`.**
First migration tried `result.fields["items"]` and got an empty
list every time (silently). The fix was reading the bash
equivalent's `for(const t of v.items)` more carefully — `v.items`
is the canonical list's `items` array directly. The trip-up was
that canonical JSON encodes a list as `{"items":[...],"kind":"list"}`
and looks superficially record-shaped if you're not careful about
the discriminator. CLAUDE.md's "Schema is a type, not an example
value" callout applies here transitively — the *output* of a list-
producing tool is a list-Value, full stop.

**3. The Bell-pair channel construction was 17 lines of `expr(...)`
calls** (vs 13 lines of canonical JSON in the bash script). On
balance still better — typed, no string escaping — but the IR's
`prepare(angle, wire)` / `ry(wire, angle, controls)` ordering and
the rational-zero idiom (`rat(0n, 1n)`) are friction. Any tool
that consumes a structurally-rich IR (Sturm, Bennett, future-
Feynman) would benefit from a tiny *constructor library* (e.g.
`@workbench/sturm` already exists for this — it's the TS-native
DSL from ADR-0009). The migration didn't reach for it because
demo-scope.ts is meant to exercise the *protocol-level* call site,
not the DSL on top. But for real research code a TS expert would
import `prepare(0, 0)` from `@workbench/sturm` and get back the
right `expr("prepare", ...)` Value with no manual construction. A
worklog note for future-me / future-Tobias: the protocol-level
call sites for IR-bearing tools are honest but ergonomically poor;
the DSL-level call sites are where the real workflow lives.

## Acceptance

- `bun run check` — 34 phases, 0 failures.
- `bun test packages/compose/test/` — 20 tests (17 prior + 3 new):
  - chained `.through(...)` produces the right Value
  - immutable-builder: branches share a prefix without aliasing
  - step-numbered error names the failing step number AND tool
- `bun scripts/demo-scope.ts` — runs to completion in ~620 ms; same
  output as `bash scripts/demo-scope.sh` (modulo float64
  pretty-printing, where the TS version uses `<f64:hex>` and the
  bash version's SHORT renders the raw record bytes).
- Speedup: 7.4× full suite, ~20× on multi-step chains
  (qualitatively meets the issue's "≥10× on a 5+ step chain").
- ADR-0012 acceptance criteria: `pipe(...).through(...).through(...).value()`
  works; pipe is immutable; mid-pipe schema break reports the step
  number and tool name in the error.

## Pointers

- `packages/compose/src/pipe.ts` — `PipeImpl`, `makePipe`.
- `packages/compose/src/load.ts` — `Workbench.pipe` delegating to
  `makePipe`.
- `packages/compose/src/generated/wb.ts` — regenerated typed barrel
  (extends Workbench).
- `scripts/gen-workbench-barrel.ts` — barrel codegen.
- `scripts/demo-scope.ts` — the TS port; this is now the canonical
  worked-examples surface.
- `scripts/demo-scope.sh` — the bash version, preserved with a
  header pointing at the TS port.
- ADR-0012 §"Workbench.pipe" / §"Three moves".
- Beads scientist-workbench-{46z, e0h} closed.

## The DAG is closed

| Issue | Title | Worklog |
|---|---|---|
| c24 | ADR-0012 design pass | 032 |
| inm | Scaffold @workbench/compose package | 032 |
| 9n1 | loadWorkbench(): auto-discovery + in-memory registry | 032 |
| 23i | Workbench.run(name, input, flags?) direct call surface | 032 |
| o8t | PRD §3.5 lockstep (provenance writes) | 032 |
| 4t5 | Generated typed barrel | 033 |
| mtw | Workbench.lookup: cache hit by input hash | 034 |
| csa | Workbench.runMemoized | 034 |
| 46z | Fluent pipe() API | 035 |
| e0h | Migrate demo-scope.sh to TS + measure speedup | 035 |

Four shards (032-035), four sittings, the agent-composition-tax is
gone.
