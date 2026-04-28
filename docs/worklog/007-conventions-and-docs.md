# 007 — F6 + F4 + F9: lint, example-count, TDD shapes

**Date:** 2026-04-28
**Status:** complete
**Issues:** scientist-workbench-rpb.{5, 3, 8} (all closed)

## Context

Three smaller frictions, all conventions / documentation, batched into a
single iteration so the doc surfaces stay coherent.

**F6** — the codebase mixed `record({...}) / int(...) / list(...)`
helpers (in `cas-simplify`, `cas-verify`, the new tools) with raw
`{kind:"...", ...}` object literals (in `oracle`, `scripts/check.ts`,
`cas-simplify/goldens.spec.ts`, some tests). Both work; both being
in use means a fresh reader can't tell which is convention.

**F4** — the contract says "≥10 examples per tool, ≥30 once done."
Mid-port, building `ntt`, the natural set of examples turned out to be
11 — one per code-path branch (pow-2 path, Bluestein path, edge
cases, round-trips). The 10-as-a-quota framing pushed against the
structure-driven goal: would a 9-example tool with full branch
coverage be inadmissible while a 10-example tool that exercises one
path 10 times would pass?

**F9** — the README's "writing a new tool" walkthrough assumes
spec-from-scratch RED→GREEN. The 02-NTT port (shard 001) was
port-and-verify: write the impl as a faithful translation of a
known-good algorithm, *then* the tests. Both are valid TDD-shaped
flows; neither is the literal "test before code." The codebase needed
to acknowledge both.

## What changed

### F6 — convention check + cleanup

Two existing drift sites cleaned up:

- `tools/cas-simplify/goldens.spec.ts:40,42` had
  `{ kind: "string", value: "hello" }` and `{ kind: "list", items:
  [...] }`. Rewrote to `str("hello")` and `list([int(1n), int(2n)])`.
- `scripts/check.ts:96-99` built an oracle payload as a raw record
  literal. Rewrote to `canonicalize(record({ tool_path: str(toolPath),
  goldens_dir: str(goldensDir) }))`.

A new phase added to `scripts/check.ts`:

```
▸ convention: raw kind-literals outside allowlist ... ok (21ms)
```

Greps every `.ts`/`.js` file under the workspace for `kind: "..."`
matching one of the ten kinds. An allowlist permits the legitimate
construction sites:

- `packages/protocol/` — defines the helpers
- `packages/contract/src/runner.ts` — runner is protocol-adjacent
- `packages/json-bridge/src/` — its job is canonical construction
- `*.test.ts` — tests are pragmatic about literal assertions
- `scripts/check.ts` — this script greps itself

Outside the allowlist, every match is a soft drift — currently
warning-only (the phase always reports `ok` and prints a tally).
Failing CI on convention drift was rejected as too aggressive while
the codebase is still settling; once we're confident the migration
is complete the warning flips to a hard fail. Currently: 0 drift sites.

### F4 — example-count reframe

`README.md` §"The contract" item 3 was previously:

> 3. `examples` (≥10 for real tools; ≥30 once "done").

Rewritten:

> 3. `examples` — soft floor: **one example per code-path branch +
>    edge cases**, ≥10 once the tool is "done." The literal count is
>    a target, not a quota; if the tool's natural example surface is
>    small, structure-driven coverage wins. ≥30 to call a tool
>    "v1-complete."

The dial shifts from "count" to "coverage." A tool with 8 examples that
exhaustively covers every code path is now admissible; a tool with 12
examples that all hit the same path is now suspect.

### F9 — two TDD shapes

`CLAUDE.md` gained a new section:

```
## Two TDD shapes — both valid

### Spec-from-scratch
(classic RED → GREEN → refactor)

### Port-and-verify
1. Write the implementation as a faithful port.
2. Write tests capturing invariants + known input/output pairs.
3. Mutation-prove the tests catch regressions: deliberately perturb
   the implementation, confirm the test suite goes RED, restore.
4. Cross-validate against an independent oracle when one exists.
```

The "mutation-prove" technique is the discipline that *replaces* the
literal "RED first" step in the port-and-verify flow. The honesty
rule: "tests have caught a real regression" is the principle, not
"the test was committed before the impl."

Shard 001 itself demonstrated this — flipping `=== 1n` to `=== 0n`
in `modPow`'s bit-mask check failed 8 mod-core tests, restored, back
to green. Shard 005's json-bridge tests likewise: flipping the
integer parser to add `+ 1n` failed 6 tests, restored.

## Why these choices

**Warning-only on convention drift, not hard fail.** A migration
phase shouldn't be hostile to incremental progress. The convention
phase is informational; once we're confident the convention is
broadly understood, flip the warning to a fail and codify the
allowlist as canonical.

**Reframe count to coverage.** The original "≥10" framing was
defensible — it nudges toward thoroughness. But it interacts badly
with tools whose natural example pool is small or with structure
that begs for fewer-but-thorough cases. "Coverage of every code-path
branch" is a stronger property and a more honest goal.

**TDD-as-discipline, not TDD-as-ritual.** The literal "write the
test first" rule is a mnemonic for "don't ship code without tests
that catch regressions." Port-and-verify achieves the same end via
mutation-prove. Both flows leave the codebase with tests that fail
when the impl breaks; both are honest.

## Frictions surfaced

The convention check raised one minor question: should the
`packages/json-bridge/test/json-bridge.test.ts` file be in the
allowlist? It's a test file (`*.test.ts`), so the existing rule
covers it — but a few of its assertions construct expected values
as raw literals (matching the output of the bridge). That's
pragmatic, not a drift, and the allowlist correctly accepts.

## Acceptance

- `bun run check` reports `convention: raw kind-literals outside
  allowlist ... ok` with 0 drift sites.
- All 14 phases green; goldens unchanged; tournament 64/64 still
  green.
- `tools/cas-simplify/goldens` regenerated cleanly after the
  literal-to-helper migration.
- `CLAUDE.md` and `README.md` updated.

## Pointers

- `scripts/check.ts` — the convention phase implementation.
- main `README.md` §The contract — example-count reframed.
- `CLAUDE.md` §Two TDD shapes — port-and-verify discipline doc.
- `CLAUDE.md` §Conventions worth knowing up front — pointer to
  ADR-0003 (output categories), ADR-0002 (schema annotations),
  ADR-0001 (subprocess plumbing).
