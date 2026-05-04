# 038 — oracle: return record on every path; CI exits via output inspection

**Date:** 2026-05-04
**Status:** complete
**Branches:** main
**ADR:** none (small contract refinement; no new design surface)
**Issues closed:** scientist-workbench-qf1.

## Context

`tools/oracle/tool.ts` had a `process.exit(1)` in its `fn` body that
fired whenever any golden failed. The exit happened *after* writing
the canonical record to stdout, so consumers got the per-golden detail
— but the runner's normal flow was bypassed:

- **No provenance write.** `executeToolDef`'s persistence step never
  ran on a failed-golden invocation. A CI consumer could not
  `--provenance-of <output_hash>` to fetch the failure record after
  the fact.
- **In-process callers got killed.** `wb.run("oracle", ...)` from
  `@workbench/compose` (ADR-0012) cannot catch `process.exit` —
  it terminates the orchestrator. After the composition layer
  landed, oracle was the last tool in the workbench that violated
  the in-process composability contract.

Bead `qf1` filed 2026-04-28 named the fix; this shard ships it.

## What changed

**`tools/oracle/tool.ts`.** Removed the `process.exit(1)` block. `fn`
now always returns the results record — pass or fail — and the
runner's normal flow (canonicalise → output-validate → write
provenance → emit bytes) takes over. Two consequences:
- Provenance is written for every successful invocation of oracle,
  whether or not the underlying goldens passed.
- In-process callers (`wb.run("oracle", ...)`) get back a Value
  instead of being killed.

The header comment's "Process exit" section was rewritten to name the
new contract and the rationale (bead `qf1`, in-process composability).
The `exit-iff-fail` invariant was replaced with `fail-count-iff-mismatch`
and a new `always-returns-record` invariant — honest descriptions of
what the tool now promises.

A `--test` hook was added that exercises the load-bearing change: the
hook constructs a temp goldens dir with one passing and one
deliberately-failing golden against `mod-pow`, calls `def.fn(...)`
directly, and asserts `passed=1, failed=1, total=2`. Before the fix,
the failing branch would have killed the test process. After, the
fn returns and the assertions run. (This is the moral analogue of
mutation-proving: the test would be useless on the old code path,
because `process.exit` would terminate before the assertions reached.)

**`scripts/check.ts`.** The oracle phase used to rely on the
subprocess exit code to determine pass/fail. Now: parse oracle's
stdout, inspect the `failed` integer field, mark the phase failed
when it's > 0. The per-golden FAIL detail lines come from walking
the `results` array in the returned record — same information as the
old stderr summary, now extracted from the canonical output instead.

A non-zero subprocess exit code from oracle still maps to a phase
failure (it now means oracle itself failed — malformed input,
goldens-dir missing, etc. — not a per-golden mismatch). The two
failure modes are kept distinguishable in the detail string.

**`tools/oracle/README.md`.** The "Process exits 1 if any golden
fails" line was rewritten to describe the new contract: `fn` always
returns the record; CI inspects `failed > 0` to decide its own exit;
in-process callers reach for the Value.

## Why these choices

**Always-return over conditional-throw.** The bead's body suggested
two paths: (1) throw a `ToolError` carrying the result detail, or
(2) emit the record as the happy-path output and let the user decide.
Path (1) does not satisfy the bead's own acceptance criterion that
"provenance is written for both pass and fail records" — `fn`
throwing means `executeToolDef` short-circuits before persistence.
Path (2) does, and is also the cleaner TS-expert design: oracle
becomes a pure function from `(tool, goldens, mode)` to a results
record, no special exit behaviour, composable via `wb.run` like any
other tool. The exit decision lives at the caller, where it belongs.

**`scripts/check.ts` parses stdout instead of trusting exit code.**
The change is small (~25 LOC of post-stdout inspection) and the new
detail message is at least as informative as the old stderr-based one
— in fact more, because it walks the `results` array directly rather
than re-reading the oracle's own stderr line.

**`--test` hook covers the load-bearing branch.** Earlier worklogs
(037 most recently) emphasised mutation-proving as the test
discipline. Here the hook itself functions as the proof: on the old
code, `process.exit` would have killed the test process before the
assertions ran; on the new code, `fn` returns and the assertions
execute. The test passes the new contract by *existing*.

## Frictions surfaced

**1. Initial smoke-test mutation hit the wrong path.** A first-pass
attempt to corrupt a real mod-pow golden via `python3 -c "..." >
$GOLDEN` raced because the shell redirect truncated the file before
python could read it. The resulting empty file caused oracle's
`readGoldens` → `parse("")` to throw, which exited 1 the *old* way
(via the runner's catch), so check.ts still saw `r.code !== 0` and
the *new* `failed > 0` path was never exercised. Fixed with a
two-step `read-modify-then-rename` that races nothing. **Lesson:** a
"prove the new path" smoke test must hit the new path. Verify the
mutation lands the failure where you intended, not where you assumed.

**2. The `--test` hook needs cwd-independent path resolution.** The
hook constructs a path to `tools/mod-pow/tool.ts` to spawn it. Using
`fileURLToPath(import.meta.url)` + `dirname` + `resolve` gets the
repo root cleanly regardless of where the user runs the tool from.
Same pattern `scripts/check.ts` uses; worth surfacing as a convention
in any future tool whose `--test` hook needs to invoke another tool.

**3. Oracle's existing stderr verbose summary still fires under
`--test`.** When the test hook runs the deliberately-failing
sub-golden, oracle's `if (failed > 0)` block writes
`oracle: 1/2 goldens failed` to stderr. Visible in the test output
but harmless — the test asserts on the *return value*, not on
stderr. Could be silenced (e.g., gate the stderr summary on
`!flags.verbose`) but adding a stderr-suppression flag would be
scope creep for this bead. Filed mentally as a possible follow-up
if the noise ever bothers anyone.

**4. Multiple system-reminder nudges to use TaskCreate.** Same as
shards 028–037. Per CLAUDE.md Rule 9 ignored; using beads
exclusively.

## Acceptance

- `bun run check` green: 35 phases pass (+1 from previous: oracle
  now has a `--test` hook; previously skipped), 3 skipped, 0 failed.
- Mutation-prove (real this time): corrupt one mod-pow golden's
  `output` field, run `bun run check` → oracle phase fails with the
  per-golden FAIL detail extracted from the new `failed > 0` path,
  not the old `r.code !== 0` path. Restore → check green.
- Oracle's `tool.ts` contains *no* `process.exit` (verified by
  `grep`).
- Failed-goldens runs still surface as a phase failure in CI, via
  the new path: oracle exits 0, `check.ts` reads `failed > 0`, marks
  the phase failed, prints the per-golden FAIL lines.
- Provenance is written for both pass and fail records (consequence
  of `fn` always returning rather than calling `process.exit`).
- README updated; in-tool header rewritten; invariants list aligned
  with the new contract.

## Pointers

- `tools/oracle/tool.ts` — the now-no-exit `fn` and the new `--test`
  hook.
- `scripts/check.ts` — the `failed > 0` post-stdout inspection.
- `tools/oracle/README.md` — rewritten "Output" section.
- ADR-0012 — composition layer; the surface that makes
  `process.exit`-in-tools genuinely incompatible (in-process calls
  cannot catch it).
- ADR-0003 — output / error categories. Oracle was emitting Category
  1 (happy-path record) regardless of pass/fail; the bug was the
  `process.exit` after, which masquerades as Category-3-style
  failure signalling without using the protocol's own boundary tag.
- Beads scientist-workbench-qf1 — closed.
