# 026 — Code-health pass: protocol DRY, dead code, literate ntt

**Date:** 2026-05-02
**Status:** complete
**Branches:** main
**Issues closed:** scientist-workbench-{9s4, cji, y8p, 10w, hgc, 61s}

## Context

Six small code-health issues had been sitting in the P2–P4 drawer
since the friction-elimination iteration on 2026-04-28. None blocks
new work, all degrade legibility / drift-resistance over time. This
shard collects them into one cohesive pass — none individually
warrants a shard, but together they shape up the protocol package
substrate and the `mod-core/ntt` literate documentation.

The pass also unblocks the auto-export hook story from the previous
session: the new `numerics.ts` module is the kind of place that
*would* have been the third silent-divergence point if a future
agent had needed `gcdBigInt` or `INT_RE` somewhere else.

## What changed

**`packages/protocol/src/numerics.ts`** (new, ~55 LOC). Exports
`INT_RE`, `F64_BITS_RE`, and `gcdBigInt`. These three values are
load-bearing for the canonical encoding — drift between two copies
would corrupt the wire format silently. The new module makes drift
structurally impossible. Top-of-file paragraph explains the
*why*; per-export doc-comments explain what each value pins down.

**`packages/protocol/src/kinds.ts`** — local `INT_RE`, `F64_BITS_RE`,
and `gcdBigInt` deleted; import from `./numerics.js`. Net: ~13 LOC
removed.

**`packages/protocol/src/validate.ts`** — same: import from
`./numerics.js`, local `gcdBigInt` deleted. Plus a four-line
comment near the rational lowest-terms check explaining the
deliberate O(log min(num, den)) cost (issue y8p). Net: ~10 LOC
removed, 5 added.

**`packages/protocol/src/index.ts`** — re-exports `INT_RE`,
`F64_BITS_RE`, `gcdBigInt` so downstream packages can consume them
without reaching into protocol-internal modules.

**`packages/cas-core/src/rat.ts`** — local `gcdBigInt` deleted;
import from `@workbench/protocol`. cas-core already depended on the
protocol package, so this is one less private utility, not a new
edge in the dependency graph.

**`scripts/check.ts`** — `spawnCmd` alias deleted (the dead `_cmd`
parameter passed `"bun"` at every call site and went nowhere). Four
call sites now invoke `spawnBun` directly. Less misleading; same
behaviour. (issue 10w)

**`tools/ntt/tool.ts`** — the `--test` hook's brief one-liner
("Independent oracle: ... see beads issue ...") expanded into a
proper paragraph stating *why* the schoolbook DFT must be inline
rather than imported from `@workbench/mod-core`: importing the same
helpers would reduce the test to "the NTT agrees with itself,"
catching no algorithmic bug. The duplication is the deliberate
cost of the oracle's independence; the comment now warns future
agents off "DRY-ing" it. (issue hgc)

**`packages/mod-core/src/ntt.ts`** — the `mmul` Montgomery REDC
kernel got a top-of-function paragraph (preconditions, postcondition,
why 16-bit limbs, four-step REDC outline) and inline algebra
annotations on every step (limb decomposition with bit-range
comments, the `Math.imul` rationale at step 2, the manual
`Math.floor / 0x10000` split for `mpCross`, why `lowAdd` matters
even though we use only its carry). A reader new to Montgomery
arithmetic should now be able to verify the kernel by reading top
to bottom. (issue 61s)

## Why these choices

**Hoist into the protocol package, not a workspace-private util.**
Issue cji left the choice open between "export from
@workbench/protocol" and "keep package-private and have cas-core
re-implement consciously." Picked the export path because cas-core
already depends on protocol — `expr-bridge.ts`, `verify.ts`,
`simplify.ts` all import Value-protocol helpers — so importing
`gcdBigInt` from there adds no new package edge. The argument for
"re-implement consciously" was: keep cas-core ring-free of the
protocol package. That ship has sailed.

**Inline `spawnBun` rather than expand `spawnCmd`.** Issue 10w
offered both: kill the alias, or genuinely route non-bun commands.
Today's check.ts only spawns Bun (typecheck, test, per-tool --test,
oracle). No call site has any reason to be otherwise. Expanding the
alias to handle hypothetical future non-bun commands would be
designing for an invariant nobody has expressed — exactly the kind
of premature abstraction CLAUDE.md warns against.

**Verbose mmul commentary, not terse `// REDC`.** Issue 61s was
explicit: a fresh reader should be able to read top to bottom and
verify the algebra, in line with the literate-programming rule.
The four-step outline + per-step annotation is closer to a textbook
derivation than to typical inline comments — and that is the point.
The hot inner loop of every NTT butterfly runs through this kernel;
losing trust in its correctness would invalidate every NTT golden.
Worth the screen real estate.

**Comment density: deliberately uneven.** Most of the workbench
follows CLAUDE.md's "default to no comments" rule. The mmul kernel
breaks that rule on purpose — the WHY is non-obvious for any reader
who hasn't already memorised Montgomery REDC. The numerics.ts
docstrings, similarly, exist because the WHY (drift ⇒ silent wire
corruption) is exactly the kind of invariant that doesn't survive
without prose.

## Frictions surfaced

**One: an unscoped `F64_BITS_RE` use at `kinds.ts:214`.** The
inventory in issue 9s4 listed `kinds.ts:103-104` and
`validate.ts:9-10` as the two regex sites. There turned out to be a
third — a `F64_BITS_RE.test(v.bits)` call in `kinds.ts:214` (the
`kindOf`/`int`/`rat` literate region). My first pass imported only
`INT_RE` and `gcdBigInt` from numerics.js because that's what the
issue inventory said; `F64_BITS_RE` then had no scope and the
quick-check failed loudly with "F64_BITS_RE is not defined." Fixed
in a one-line edit. *Lesson:* trust the issue body's pointer to
the *area* of the code, not the precise line ranges — verify
against `grep -rn` before assuming the inventory is exhaustive.
This is ground-truth-before-code Rule 0 in action.

The convention check (`bun run check:quick`'s phase 1) caught the
typecheck failure immediately, which is exactly its job. Good
inner-loop signal.

**Two: the comment in tools/ntt/tool.ts was a self-referential
loop.** The pre-existing one-liner said "see beads issue
scientist-workbench-hgc for the formal note" — but that issue's
acceptance criteria was *"add the rationale to the file."* The
issue and the file pointed at each other. Replaced with the actual
rationale in prose. Worth flagging because the same shape probably
exists elsewhere — comments that defer to issues that defer back to
the file. Future code-health passes should look for the pattern.

## Acceptance

- `bun run check:quick`: 3/3 phases pass.
- `bun run check`: 31/31 phases pass (3 base + 13 per-tool --test
  + 15 oracle, 4 skipped per the standard pattern). Same numbers
  as before this pass — no contract loss.
- One source of `INT_RE`, `F64_BITS_RE`, `gcdBigInt` in the
  codebase. Confirmed via `grep -rn` over `packages/`, `tools/`,
  `scripts/`.
- `scripts/check.ts` no longer mentions `spawnCmd`.
- Six beads issues closed: scientist-workbench-{9s4, cji, y8p,
  10w, hgc, 61s}.

## Pointers

- `packages/protocol/src/numerics.ts` — the new shared module.
- `packages/protocol/src/index.ts:37` — public re-exports.
- `packages/protocol/src/validate.ts:78-82` — the documented gcd
  cost block (issue y8p).
- `tools/ntt/tool.ts:165-185` — the expanded test-hook rationale
  (issue hgc).
- `packages/mod-core/src/ntt.ts:29-117` — the literate `mmul`
  kernel (issue 61s).
- CLAUDE.md Rule 10 (literate programming) — the principle
  motivating the mmul rewrite.
