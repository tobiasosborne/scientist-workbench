# CLAUDE.md — guidance for AI agents working on scientist-workbench

If you are an agent (Claude Code, an SDK harness, or a downstream tool)
landing in this repo, **read this top to bottom every session**. After a
context compression, re-read. The rules drift out of working memory faster
than you think; that's why they're numbered.

## The Laws

Two laws. Read first, applied always.

**Law 1 — Ground truth before code.** Before writing any code: open the
ADR (or write it first), open the affected files (verify their current
shape — never trust memory or a prior conversation summary), open the
canonical reference. Cite the local source by path in worklog shards
and ADRs (`docs/adr/0003-tool-output-error-patterns.md`, not "the
output-categories ADR I remember"). If the source you need doesn't
exist locally, write it before the code. The beads issue body *is* the
ground-truth artefact for the work it tracks — finish writing it
(Background / Fix / Acceptance) before starting the implementation.

**Law 2 — Docs in lockstep with code.** Every code change ships paired
doc updates *in the same edit session*:
- new tool: `tools/<name>/README.md` + catalog row in `README.md` +
  (if it introduces a value-protocol convention) a paragraph in
  `PRD-v0.2.md`;
- new package: `packages/<name>/README.md` + a row in the main
  README's "File layout";
- new convention, flag, or error class: an ADR under
  `docs/adr/NNNN-title.md`;
- new substantive iteration: a worklog shard under
  `docs/worklog/NNN-*.md`.

Code shipped with stale docs is incomplete work, full stop.

## The Rules

Numbered, non-negotiable. Re-read after compaction.

0. **Laws 1 & 2 apply.** Ground truth before code. Docs in lockstep.

1. **Fail fast, fail loud.** Loud `ToolError` with `suggestion`/`detail`,
   not silent fallbacks. Schema-validation failures throw. Subprocess
   describe-failures log to stderr and tally; they do not return empty
   lists (shard 002). Crashes with context beat truthful-looking lies.

2. **All bugs are deep.** No bandaids, no "temporary fixes." Investigate
   root causes. The snap-Bun bug looked like a `which bun` problem; it
   was actually `process.execPath` vs PATH-walk under snap mount-namespace
   confinement (shard 002). A fix that "looks like it works" often
   passes one test and breaks an invariant elsewhere — verify the *full*
   `bun run check` passes, not just the target test.

3. **Skepticism.** Verify subagent output, previous-session claims, and
   your own memory against the current state of the repo. Worklog
   shards are frozen snapshots; files may have changed since. `git log`
   and `Read` are authoritative; conversation context is not.

4. **Tiered workflow.** Scale agent effort to change size:
   - **Trivial** (<5 LOC, typo / comment / single-line fix): direct
     edit, no subagents.
   - **Small** (one function, <30 LOC): direct edit; 1 research
     subagent if the surface area is unfamiliar; `bun run check:quick`.
   - **Core** (new tool, new package, new ADR, cross-package refactor):
     beads issue first; for genuinely contested design decisions, spawn
     2–3 research subagents independently before implementing
     (the 3+1 pattern from `Sturm.jl`/`Bennett.jl`).

5. **Get feedback fast.** Run `bun run check:quick` every ~50 LOC, not
   every 500. The full `bun run check` (14 phases, ~25s) is the
   pre-shard gate, not the inner loop. Per-tool: `bun tools/<name>/tool.ts
   --test` is the second-fastest signal.

6. **Two TDD shapes — both valid.**
   - **Spec-from-scratch:** classic RED → GREEN → refactor.
   - **Port-and-verify:** port the algorithm faithfully, capture
     invariants in tests, **mutation-prove** the tests catch
     regressions (perturb the impl, confirm RED, restore),
     cross-validate against an independent oracle when one exists.
     Mutation-proving replaces the literal "RED first" step.
   The discipline is "tests have caught a real regression," not "the
   test was committed before the impl."

7. **"Runs without errors" is not a passing test.** Every property
   test asserts an invariant; every golden has a known-correct answer;
   every `--test` hook proves a structural fact. A test that asserts
   only "didn't throw" is broken.

8. **Honest scope.** A tool that refuses out-of-scope inputs with a
   clean `tagged "<tool>/<class>"` is correct. A tool that lies —
   silently produces a wrong-shaped or wrong-valued answer — is
   inadmissible regardless of cleverness. Three categories (ADR-0003):
   happy path, record-with-flag for routine non-success, tagged for
   boundary failure. `ToolError` is reserved for *malformed* input.

9. **Beads is the only tracker.** `bd create / update / claim / close`.
   No TodoWrite, no TaskCreate, no markdown TODO lists. Run `bd ready`
   at session start; `bd close <id1> <id2> ...` at the end. Never use
   `bd edit` (it opens $EDITOR and blocks).

   **Multi-device sync.** The Dolt DB is local; the cross-device
   sync vehicle is `.beads/issues.jsonl` (tracked in git). Tracked
   git hooks under `.githooks/` make this automatic:
   - **pre-commit** auto-runs `bd export -o .beads/issues.jsonl`
     and stages it, so every commit carries a current snapshot of
     issues + memories.
   - **post-merge** auto-runs `bd import` after `git pull`, so
     incoming issue state is folded into the local DB (upsert
     semantics; never destructive).

   On a fresh clone of any device, run **once**:
   ```sh
   sh scripts/setup-device.sh
   ```
   That sets `core.hooksPath` to `.githooks/` and runs `bd bootstrap
   --yes` (the *non-destructive* sibling of `bd init` — never
   deletes data). After that the hooks do everything; you only
   `bd create / close` and `git commit / pull / push` as normal.

   **Do not run `bd init` or `bd init --force`** — those rebuild
   the DB and discard issues. `bd bootstrap` is the right command
   for setup, recovery, and fresh-machine onboarding.

10. **Literate programming.** Source files are exposition. Doc-comments
    expand into multi-paragraph explanations of *why* the code is
    shaped the way it is — what ground truth it embodies, what pitfalls
    motivated each defensive check, which references it derives from.
    A fresh reader should read `tool.ts` top-to-bottom like a chapter,
    not piece intent together from scattered comments. If you find
    yourself writing terse `// add 1` comments, rewrite as prose or
    delete entirely.

11. **No GitHub CI, no automated remote runs.** Quality gates run
    locally: `bun run check`, per-tool `--test`, oracle on goldens.
    Do not propose `.github/workflows/`; do not file "add CI" beads.
    The user has rejected automated CI globally — failure-email noise
    is worse than zero signal.

12. **Repeat rules.** Re-read this file at session start, after `/clear`,
    and after any context compression. The agent that re-reads catches
    drift the agent that doesn't ship.

## Hallucination-risk callouts

Sharp pre-emptive warnings about specific mistake categories that look
right but aren't. When you catch yourself about to do one, stop and
re-check the relevant ADR.

- **Schema is a type, not an example value.** Use `S.kind("integer")`,
  `S.record({...})`, `S.list(S.kind("integer"))` from `@workbench/
  protocol`. The legacy `int(0n)` / `list([])` form is the wire
  encoding only (preserved transport-side). ADR-0004.
- **No raw JSON numbers.** All numerics live inside `integer` /
  `rational` / `float64`, with number-bearing fields as *strings*.
  `{"value":1}` is invalid; write `{"value":"1"}`. PRD §0.1.
- **`null` is reserved and unused.** Never emit it. Use absent-
  optional-field semantics or `tagged` for "no-result."
- **Three output categories, three shapes — don't conflate.** Routine
  non-success ⇒ `record { <flag>, ... }` (`mod-inv`, `cas-verify`).
  Boundary failure ⇒ `tagged "<tool>/<class>"` (`cas-simplify`).
  Malformed input ⇒ `ToolError` (process exit 1). ADR-0003.
- **Subprocess plumbing: `spawnBun`, never `node:child_process`.**
  The resolver handles snap-Bun's mount-namespace corner. Direct
  `child_process` calls re-introduce the bug. ADR-0001.
- **Value construction: helpers, not literals.** Use `int`, `str`,
  `record`, `list`, `tagged`, `expr`, `sym`, `bool`, `rat`,
  `float64FromNumber` from `@workbench/protocol`. Raw `{kind:"...",
  ...}` literals are allowed only inside `packages/protocol/`,
  `packages/contract/src/runner.ts`, `packages/json-bridge/src/`, and
  `*.test.ts`. The convention phase in `scripts/check.ts` enforces.
- **Foreign-pass-through is a hard invariant.** Subterms outside a
  tool's declared scope round-trip *verbatim* or wrapped in
  `tagged "<tool>/<class>"`. PRD §2.3. Property tested per tool.
- **Runner validates input before `fn` runs.** Do not re-validate
  inside the body. The TS type of `input` already reflects the schema.
  Hand-rolled `expectIntegerField` shims were deleted in shard 008;
  do not reintroduce.
- **Tool entry points must stay side-effect-free at import time.**
  The trailing line of every `tools/*/tool.ts` is `if (import.meta.main)
  void runTool(def);` — gated, never bare. The registry, tests, and
  any other harness import the module to read `def` (ADR-0010); a
  module that runs work, prints to stdout, or reads stdin at top
  level breaks all three. If you need module-level setup, inline it
  inside `def.fn` or behind the `import.meta.main` gate.

## Worklog

`docs/worklog/` is a sharded log of substantive iterations (one shard
per work item, ~200 lines each). Read it when "git blame says I
changed this line, but why?" — that's what these shards are for. Add
a shard when you complete a discrete piece of work; the structure is
**Context → What changed → Why these choices → Frictions surfaced →
Acceptance → Pointers**. See [`docs/worklog/README.md`](docs/worklog/README.md)
for the index. Be honest about frictions and dead ends — those are
the load-bearing parts.

## Practical guidance

- Substrate is **TypeScript on Bun**. Run tools via
  `bun tools/<name>/tool.ts`. No build step. Bun-native test runner
  (`bun test`).
- Tools must conform to the seven-artefact contract. Scaffold with
  `bun scripts/new-tool.ts <name> [--uses pkg1,pkg2]`.
- Schemas declared via `S.*` constructors from `@workbench/protocol`
  (ADR-0004). Use `defineTool({...})` so TS infers `I`/`O` from the
  schema and threads them into `fn`.
- Issue tracking: `bd` (beads). `bd ready` to find work; `bd show <id>`
  for detail; `bd close <id1> <id2> ...` to close.
- Memory: persistent notes live under
  `~/.claude/projects/-home-tobiasosborne-Projects-scientist-workbench/memory/`.
  Update when something is worth carrying across sessions.
- After a tool ships, add a representative invocation to
  `scripts/demo-scope.sh`. End-to-end demos catch API friction that
  unit tests miss (lesson from `Lyr.jl` Rule 13).

## Session close

When the session is winding down:

1. `bd close <id1> <id2> ...` — close completed issues.
2. If a meaningful chunk closed, add or extend a worklog shard.
3. If a non-obvious lesson surfaced, save it to memory and update
   `MEMORY.md` index.
4. `git add` + `git commit` the work, then `git push` to `origin/main`.
   The remote is `git@github.com:tobiasosborne/scientist-workbench.git`
   and is the canonical sync vehicle for both code and `.beads/issues.jsonl`
   (worklog 027). Push at the end of every session by default.

## Tool-of-last-resort

If the laws conflict with a fast path: choose the laws. "Just ship and
fix docs later" has been retired as a working mode here.
