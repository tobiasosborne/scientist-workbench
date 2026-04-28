# CLAUDE.md — guidance for AI agents working on scientist-workbench

If you are an agent (Claude Code, an SDK harness, or a downstream tool) and
you are about to make a change in this repo, read this first.

## Three principles, non-negotiable

### 1. Docs in lockstep with code

Every code change ships with paired doc updates **in the same edit session**.
Specifically:

- new tool: `tools/<name>/README.md` + an entry in the catalog table in
  the main `README.md` + (if it exposes a new value-protocol convention)
  a paragraph in `PRD-v0.2.md`.
- new package: `packages/<name>/README.md` documenting its public surface
  (the `index.ts` exports, with intent and invariants).
- new behaviour-changing flag, error class, or convention: an ADR under
  `docs/adr/NNNN-title.md`.
- new agent-facing principle or workflow: this file.

Code shipped with stale docs is incomplete work, full stop.

### 2. Literate programming

Source files in this repo are organised as *exposition*. Prose is dominant;
code is illustration.

- doc-comments expand into multi-paragraph explanations of *why* the code
  is shaped the way it is — what ground truth it embodies, what pitfalls
  motivated each defensive check, which references it derives from.
- a fresh reader should be able to open a `tool.ts` or a `<package>/src/<file>.ts`
  and read it top-to-bottom like a chapter, not piece together intent from
  scattered comments.
- the implementation file *is* its own primary documentation. Per-tool
  `README.md` is the agent-facing summary; the `tool.ts` is the
  implementation-author-facing exposition. They reinforce, they do not
  duplicate.

If you find yourself writing terse one-line comments like `// add 1` you
are not doing literate programming. Rewrite as prose, or delete entirely.

### 3. Ground truth first, before coding

Before you write any code:

1. Establish the source of truth. If it does not exist yet, write it:
   the ADR, the test fixtures, the I/O contract, the canonical example.
2. Verify the current state of the affected files by reading them. Never
   assume the codebase shape from memory or from a prior conversation.
3. Then implement. Then verify. Then update docs.

When you open a beads issue, the issue description **is** the ground-truth
artefact for that work — finish writing it (background, fix, acceptance
criteria) before starting the implementation.

## Conventions worth knowing up front

- **Three output categories** for tools (ADR-0003): happy-path emits the
  natural Value; routine non-success emits `record { <flag>: bool, ... }`;
  boundary failure emits `tagged "<tool>/<class>"`. `cas-verify` and
  `mod-inv` are the canonical examples of routine non-success
  (record-with-flag). `cas-simplify` is the canonical example of boundary
  failure (tagged out-of-scope). `ToolError` (exit 1) is reserved for
  malformed inputs, not legitimate-but-unsupported ones.
- **Schema annotations** (ADR-0002): prefer `kindOf("integer")` over
  `int(0n)` in tool schemas when the *kind* is the load-bearing fact.
  Keep sample-values when the *specific shape* is load-bearing (heads,
  field names).
- **Subprocess plumbing** (ADR-0001): use `spawnBun` from
  `@workbench/contract`, not `node:child_process`.

## Worklog

`docs/worklog/` is a sharded log of substantive iterations (one shard
per work item, ~200 lines each). Read it when "git blame says I
changed this line, but why?" — that's what these shards are for. Add a
shard when you complete a discrete piece of work; the structure is
**Context → What changed → Why these choices → Frictions surfaced →
Acceptance → Pointers**. See [`docs/worklog/README.md`](docs/worklog/README.md)
for the index and shard-authoring rules.

## Practical guidance

- Substrate is **TypeScript on Bun**. Run tools via `bun tools/<name>/tool.ts`.
  No build step. Bun-native test runner (`bun test`).
- Subprocess spawn machinery: import `spawnBun` from `@workbench/contract`,
  not from `node:child_process`. The wrapper handles snap-symlink and
  similar resolution corners. See `docs/adr/0001-subprocess-plumbing.md`.
- Value construction in tool/test/script code: prefer the helpers (`int`,
  `str`, `record`, `list`, `tagged`, `expr`, `sym`, `bool`, `rat`,
  `float64FromNumber`) from `@workbench/protocol`. Reserve raw
  `{ kind: "...", ... }` literals for protocol internals.
- Tools must conform to the seven-artefact contract. The scaffolder
  (`bun scripts/new-tool.ts <name> [--uses pkg1,pkg2]`) emits the skeleton.
- Issue tracking: `bd` (beads). Run `bd list --status open` to see current
  work; `bd show <id>` for detail; `bd note <id> "..."` to log progress.
- Memory: persistent notes live under
  `~/.claude/projects/-home-tobiasosborne-Projects-scientist-workbench/memory/`.
  Update those when something is worth carrying across sessions.

## Two TDD shapes — both valid

The README says "fail-the-test-first" but in practice we have two flows
that both honour the discipline:

### Spec-from-scratch

You're designing a tool from a fresh requirement. The cycle is the
classic one: write the failing test that captures the requirement;
implement until it passes; refactor; repeat.

### Port-and-verify

You're porting a known-good algorithm (a tournament solution, a paper's
reference implementation, a translation from another language). Writing
a literal "RED" test against a stub that you intend to throw away is
theatre. The honest cycle:

1. Write the implementation as a faithful port.
2. Write tests that capture the algorithm's invariants and a comprehensive
   battery of known input/output pairs.
3. **Mutation-prove** the tests catch regressions: deliberately perturb
   the implementation (flip a bit, off-by-one, drop a recursive call),
   confirm the test suite goes RED, restore. This is the discipline that
   replaces the literal "RED first" step.
4. Cross-validate against an independent oracle when one exists (e.g. the
   tournament's golden master, a different implementation in another
   language, a textbook table). Cross-validation is the strongest signal
   the port is faithful.

Pick the flow honestly. If you're tempted to write the spec-from-scratch
test "just to look like TDD" while the port is already in your head, do
the port-and-verify flow instead. The principle is "tests have caught a
real regression," not "the test was committed before the impl."

## Tool-of-last-resort

If the principles above conflict with a fast path: choose the principles.
"Just ship and fix docs later" has been retired as a working mode here.
