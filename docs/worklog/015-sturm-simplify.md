# 015 — `tools/sturm-simplify`: IR canonicaliser

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-z8w (closed)
**ADR:** [docs/adr/0006-sturm-ir-as-value.md](../adr/0006-sturm-ir-as-value.md)
**Depends on:** shard 014 (`packages/sturm-ir`)

## Context

ADR-0006 fixed the IR shape; shard 014 landed `packages/sturm-ir` (the
typed Channel/Op forms, schemas, well-formedness, traversal). The next
step is the IR-level analogue of `cas-simplify`: a deterministic,
idempotent rewrite that produces the canonical form of a channel that
every downstream tool can rely on.

Without it, every `sturm-execute`, `sturm-equivalent`, and
`sturm-sample` would have to re-implement the same per-op
canonicalisations: drop zero-rotations, fuse adjacent same-axis
rotations, sort controls, recursively simplify cases arms. That's the
classic drift surface.

## What changed

A new tool, `tools/sturm-simplify/`, with the full seven-artefact
contract:

- `tool.ts` — `defineTool` over `channelSchema` for both input and
  output; `fn` decodes via `decodeChannel`, runs `simplifyChannel`,
  re-encodes. The simplifier is implemented inline in `tool.ts`
  (~150 LOC) — small enough that a separate package isn't yet
  motivated; if a future tool needs to call the rewrite engine
  programmatically, extract to `packages/sturm-simplify-core` then.
- `goldens.spec.ts` — 32 inputs covering every rewrite branch + the
  representative pass-through cases (Bell, GHZ, phase kickback,
  oracle round-trip, classical wire input).
- `goldens/` — 32 generated `*.golden.json`.
- `README.md` — agent-facing summary with the rewrite table and the
  out-of-scope list.
- `--test` hook with idempotence + determinism property checks over
  a small probe set.

Rewrites the simplifier performs (per ADR-0006 + shard 009):

| # | Rule | Notes |
|---|------|-------|
| 1 | `ry(0)` / `rz(0)` eliminated | uses `cas-simplify` to detect the literal-zero post-canonicalisation |
| 2 | adjacent same-axis same-target same-controls fuse | angles combined via `cas-simplify(α+β)`; both vanish if the sum is zero |
| 3 | controls list sorted ascending and de-duplicated | conceptually a set; canonical order is ascending |
| 4 | `cases` with both arms empty is dropped | the no-op branch |
| 5 | `cases` arms are recursively simplified | descent uses the same body-walk |

Cross-references:

- `README.md` (root) — catalog row added.
- `docs/worklog/README.md` — index updated with shard 015.

`bun run check`: 16/16 phases pass (was 14 in shard 008; the new
phases are sturm-simplify's `--test` hook and oracle on its 32
goldens).

`tools/sturm-simplify/tool.ts --test`: idempotence + determinism on
five probes including ry-zero, ry-fuse, ry-cancel, and Bell-pair.
Passes.

Mutation-proven (per CLAUDE.md Rule 6):

- Stubbed out the zero-detection in `mergeAdjacent` (`if (false &&
  isZeroValue(merged))`) → 1 of 32 goldens mismatches (the
  ry-then-ry-both-vanish case correctly fails to drop both ops),
  restored.

The full-check phase tally now reads:

```
▸ tool --test: sturm-simplify ... ok (53ms)
▸ oracle: sturm-simplify (32 goldens) ... ok (1980ms)
summary: 16 passed, 4 skipped, 0 failed
```

## Why these choices

**Inline simplifier in `tool.ts`.** ~150 LOC of rewrite logic is short
enough to keep with the tool. Extracting to a `packages/sturm-
simplify-core` would force a workspace dep on every consumer; right
now only `sturm-equivalent` (issue 564) is a likely caller, and it
can spawn `sturm-simplify` as a subprocess just like `oracle` does.
If a third caller surfaces, extract.

**`cas-simplify` for the angle algebra.** The simplifier doesn't
re-implement rational arithmetic; it pipes the angle Values through
`cas-simplify` and pattern-matches on the canonical-zero output. This
inherits cas-core's Q[x]/Q(x) capability for free: `ry(α) ry(-α)` →
`ry(0)` → eliminated, even when `α` is a deeply-nested expression,
because cas-simplify normalises the sum to zero. Symbolic π-rationals
(`expr("/", [sym("π"), int(2n)])`) work identically: `ry(π/2) +
ry(π/2) = ry(π)`, which is the canonical literal `sym("π")`. Goldens
12 and 28 cover this.

**Same-axis fusion only — never cross-axis.** `ry` and `rz` do not
commute. Fusing them across axes would change the channel. Test
"different axes do not merge" (golden 9) is the load-bearing
regression for this. The mutation-prove for it would be: remove the
`last.head === op.head` check; Bell-pair would then fuse into
nonsense.

**Sort controls but not in/out wires of `oracle`.** Controls are
conceptually a *set* (`controlled-ry by [1,2]` ≡ `controlled-ry by
[2,1]`) — canonical form is ascending. But `oracle.inWires` and
`oracle.outWires` are *positional*: they map circuit registers to
classical bit positions. Sorting them would change the semantics. The
README documents this asymmetry.

**Don't touch `oracle.circuit`.** The embedded channel has its own
identity (its hash). Recursing into it would conflate two layers of
canonicalisation: the simplifier's rules apply to the *outer* channel,
not the oracle's internal sub-channel. The oracle's producer (typically
`sturm-bennett-oracle`) is responsible for the sub-channel's canonical
form. Test "oracle op — circuit untouched" (golden 25).

**Schema-bounded input.** The tool declares `channelSchema` for input.
The runner validates before `fn` runs, so a body containing a `cnot`
op-node fails at the schema-validation layer with a precise path. P5
(no gates, no qubits) is enforced *before* the simplifier ever sees
the value — the simplifier doesn't need to handle "unknown op heads"
in practice. The README documents that this is by design; the
foreign-pass-through pattern from ADR-0003 still applies *within*
the closed vocabulary (e.g., the `circuit` Value of an oracle is
foreign sub-IR that's preserved verbatim).

## Frictions surfaced

- **`canonicalize → parse` round-trip in the `--test` hook.** Initial
  draft did `decodeChannel(canonicalize(...))` (treating the canonical
  string as a Value). TS caught it: `decodeChannel` takes a Value, not
  a string. The fix is `parse` from the protocol package — round-trip
  through bytes-and-back to verify a canonical string parses to the
  same Value the simplifier produced. Now the idempotence test
  exercises the full encode → canonicalize → parse → decode → simplify
  → encode → canonicalize cycle, which is closer to what
  pipe-composition will actually do.

- **TypeScript narrowing on the fused op.** The natural code is
  ```ts
  if (last.head === op.head && /* ... */) {
    out[out.length - 1] = { ...last, delta: merged };
  }
  ```
  but TS narrowing on `op.head === "ry"` gives `op: RyOp` and
  `last: RyOp`, so the spread `{...last, delta}` types correctly.
  However the `Op` return type lost its narrowing under that pattern,
  and the explicit per-axis branch (`op.head === "ry" ? {...} :
  {...}`) was clearer to read and to typecheck. The mutation-prove for
  the per-axis dispatch was implicit (TS errors during the alternative
  draft).

- **Goldens-spec uses `{ head: "discard", wireId: 1n } as const`
  literals where the builder would also work.** The spec is mostly
  builder calls (`prepareOp`, `ryOp`, `casesOp`); a few op literals
  remained as object literals. They're inside a `*.spec.ts` file
  which is in the convention allowlist (per the convention phase in
  `scripts/check.ts`), so this is fine — but it's also a small style
  drift. Future cleanup: define a `discardOp(wireId)` builder use
  consistently in the spec. Filed as a follow-up if it becomes
  load-bearing.

- **The "v0.1 cases-arm restriction" applies during *well-formedness
  checking*, but `sturm-simplify` doesn't run that check.** The tool
  trusts that its input was well-formed — if a caller passes a channel
  whose cases arms include `prepare`, sturm-simplify will happily
  recurse into the arms and produce a (still ill-formed) output. The
  contract per CLAUDE.md Rule 8 is "well-formed in ⇒ well-formed out";
  responsibility for the precondition is on the caller. The README
  documents this.

## Acceptance

- `tools/sturm-simplify/` exists with all seven artefacts.
- `bun run check`: 16/16 phases pass.
- 32 goldens generated and verified by `oracle`.
- `--test` hook passes (idempotence + determinism over 5 probes).
- Mutation-proven: removing the zero-fusion eliminates exactly 1
  golden case (the ry α + ry -α both-vanish case).
- Cross-references: catalog row in root `README.md`, worklog index
  updated.
- Issue scientist-workbench-z8w closed.

## Pointers

- ADR-0006 — the IR design.
- `packages/sturm-ir/` — the substrate this tool consumes
  (shard 014).
- `tools/cas-simplify/tool.ts` — the analogous tool for algebraic
  Values; same shape, different domain.
- shard 014 — landing of `packages/sturm-ir`.
- Issue scientist-workbench-564 — the next consumer
  (`sturm-equivalent`); will pre-canonicalise via this tool.
