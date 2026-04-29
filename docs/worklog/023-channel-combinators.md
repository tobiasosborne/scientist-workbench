# 023 — Channel combinators: sturm-controlled, sturm-then, sturm-tensor

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-o1q (closed)

## Context

Phase 2 issue `o1q` calls for the three channel-on-channel
combinators completing the IR-level peer of v3 spec §4.1 (`then`,
`tensor`) and §8.2 (`controlled`). With sturm-{simplify, execute,
equivalent} already shipped, the missing piece for agent-side
channel construction is point-free composition — taking small
channels and assembling them into bigger ones without going through
`sturm-trace` (q0b, still pending). Shard 021's "next-up"
recommendation flagged this as the natural escalation: three small
tools sharing the same algorithmic surface (walk a channel body,
emit a modified channel) that exercise the IR more thoroughly than
anything in Phase 1 did, and unlock useful demos.

## What changed

`tools/sturm-{controlled, then, tensor}/{tool.ts, package.json,
README.md, goldens.spec.ts, goldens/}` — full 7-artefact contract
on each. Main `README.md` catalog gains three rows.
`scripts/demo-scope.sh` gains demo 13: sturm-then composes a
prepare-only channel with an observe-only channel; pipes through
sturm-execute; confirms `P(r=0) = 1`.

Numbers: 19 + 14 + 13 = **46 new goldens**. Property tests in each
tool's `--test` hook cover the categorical laws (associativity for
both then and tensor; identity-left and identity-right for tensor).
`bun run check`: 29/29 phases green; 6 new phases (3 `--test` +
3 `oracle`) added to the matrix.

### sturm-controlled

Input: `record { control_wire: integer, channel: channel }`.
Output: `channel` on success, `tagged "sturm-controlled/out-of-scope"`
on either of the two boundary conditions:

- **wire-id collision.** The control wire by definition is external
  to the inner channel; if its id matches any wire id used in the
  inner channel's inputs/outputs/body, we tag and explain.
- **non-unitary op in body.** ADR-0006 admits `controls` only on
  `ry`/`rz`; coherent control on `prepare`/`observe`/`oracle`/
  `discard` is ill-defined. Each forbidden head produces its own
  reason string.

Successful path: walk the body, append the control wire to every
`ry`/`rz` op's controls list, recurse into `cases` arms. Augment
input and output signatures with the control wire prepended. We
deliberately do **not** dedup the resulting controls list — that's
sturm-simplify's job. `controlled(c, controlled(c, f))` produces a
body where each rotation lists `c` twice; downstream simplify
collapses.

### sturm-then

Input: `record { first: channel, second: channel }`. Output:
`channel` on success, `tagged "sturm-then/signature-mismatch"` on
length / kind / dim mismatch at the `first.outputs ↔ second.inputs`
boundary.

Wire-id discipline:
1. `first` keeps its ids verbatim.
2. Each of `second.inputs[i]` is renamed to `first.outputs[i].id`.
3. Every other wire id in `second` is shifted by `max(first.ids) + 1`.

Body: `first.body ++ rename(second.body)`. Outputs:
`rename(second.outputs)`. Classical refs flow across the boundary
unchanged — that's the intended behavior when `second` is written to
consume a measurement bound by `first`. Duplicate-binding flaws
(both sides observing the same ref) surface in `checkWellFormed`,
not in this tool.

The `oracle` op's embedded `circuit` Value is not renamed — it has
its own wire-id namespace sealed by its hash; only the outer
`inWires` / `outWires` references that name wires in the enclosing
channel get rewritten.

### sturm-tensor

Input: `record { left: channel, right: channel }`. Output:
`channel`. **Total** — every pair of channels has a tensor product;
no boundary-failure mode.

`offset = max(left.ids) + 1`. Right's wire ids shifted by `offset`
uniformly (no interface-map specialisation, since there's no
interface). Composite: inputs = `left.inputs ++ rename(right.inputs)`;
outputs = `left.outputs ++ rename(right.outputs)`; body = same.

Identity laws hold byte-equal:
- `tensor(empty, c) = c` — empty has `max = -1`, so offset = 0; right
  is shifted by 0, no rename, and prepending empty's signatures
  contributes nothing.
- `tensor(c, empty) = c` — empty has nothing to rename and contributes
  no body / signature entries.

Associativity also byte-equal: both nesting orders produce the
wire-id range `a.ids ∪ (b.ids + max_a + 1) ∪ (c.ids + max_a + max_b + 2)`
in the same body order (left-first throughout).

## Why these choices

**Three separate tools, not one with a mode flag.** Each combinator
consumes a different input shape (control_wire + channel vs first +
second vs left + right), and a unified `sturm-compose` would need
top-level dispatch with a union schema. CLAUDE.md's "flags that
change output type are different tools" maps cleanly. Three tools
also makes each one's invariants smaller and locally checkable.

**Append-don't-canonicalise controls in sturm-controlled.** Two
reasons: (a) keeping concerns separate (canonicalisation is
sturm-simplify's job, doing it in two places is asking for drift);
(b) byte-deterministic output regardless of input shape — if a
caller pipes through controlled twice, the doubled control is a
visible artifact downstream sturm-simplify can collapse. If
controlled also dedup'd, two-pass behaviour would be invisible.

**Wire-id collision = boundary tag in sturm-controlled.** Considered
auto-renaming (lift the inner channel's clashing wire id to a fresh
range). Rejected: this mixes two concerns (control-stamping vs
rename-on-merge) and `sturm-tensor` already does the rename-on-merge
thing for parallel composition. Use sturm-tensor first if rename-on-
merge is what you want; sturm-controlled stays mechanical.

**shift-by-`max(ids)+1` rename in sturm-then and sturm-tensor.**
Simplest scheme that works regardless of the two sides' id ranges.
A smarter compaction (contiguous renumbering) is a separate
`sturm-renumber` follow-up if anyone ever wants pretty ids. The
associativity property in sturm-tensor is byte-equal *because* the
offset arithmetic produces deterministic ranges in both nesting
orders; if a future renaming change breaks the property, the right
fix is a wire-id-canonicalisation pass, not relaxing the property.

**Classical-refs not renamed.** For sturm-then, refs flowing across
the boundary is the intended use (second consuming a measurement
bound by first — the v3 spec §13.3 `classicalBranch` example
relies on this). For sturm-tensor it's a known limitation: two
channels independently binding the same ref produce a duplicate-
binding flaw caught by `checkWellFormed` on the composite. Workaround
for v0.1 is to keep ref names unique across channels you intend to
tensor. A future iteration could add `sturm-rename-refs` either as a
shared helper or its own tool.

**No signature-mismatch in sturm-tensor.** Tensor is total in the
categorical sense — every pair has a tensor product. Output schema
is just `channelSchema`, no union. (sturm-then's union of channel +
signature-mismatch tag is the correct shape *for that combinator*;
generalising to all three tools would lie about tensor's totality.)

**Embedded oracle circuit not renamed during composition.** The
embedded channel has its own wire-id namespace sealed by its hash.
Renaming would change the hash and break content-addressing.
Outer wire-references (the surrounding op's `inWires` / `outWires`)
*are* renamed since they name wires in the enclosing channel.

## Frictions surfaced

- **`JSON.stringify` on bigint.** First test hook in sturm-then used
  `JSON.stringify(composite.body[i])` to byte-compare ops. `wireId`
  is `bigint`; JSON.stringify throws. Fixed by encoding to canonical
  Value form via `encodeOp` first, then stringifying the encoded
  Value (whose number-bearing fields are strings). Lesson: TS-side
  byte-compares always go through the encoded canonical form when
  bigint is involved.

- **`Schema<Value>` annotation idiom re-applied.** Same story as
  shards 018, 019, 020, 021 — schema-derived narrow types fight the
  protocol's generic value helpers when constructing nested record
  examples. Stuck with `const inputSchema: Schema<Value> = …` and
  runtime kind discrimination inside `fn`. Established idiom now;
  not a friction the next combinator-shaped tool needs to re-discover.

- **Two design alternatives for sturm-controlled's wire-conflict
  policy.** Considered (a) auto-rename inner channel wires that
  clash with control_wire vs (b) reject with boundary tag. Picked
  (b) for v0.1 because `sturm-tensor` already provides the
  rename-on-merge primitive — composing `sturm-tensor` then
  `sturm-controlled` gives the auto-rename behavior at the price
  of one extra step, which is the right granularity for a
  three-tool combinator suite. Documented in the tool README so
  the reader knows it was deliberate.

- **Empty-channel identity in sturm-then.** Tensor's identity is
  empty-channel cleanly (proven byte-equal in `--test`). For
  sturm-then, the analogous claim — `then(empty, c) = c` and
  `then(c, empty) = c` — only makes sense when the signatures align
  (an empty channel only matches another empty signature). The
  `--test` hook checks the empty-empty-empty case; goldens cover
  the common practical cases. A general identity-laws check would
  need synthetic channels with matching signatures, which I judged
  YAGNI for v0.1.

- **The §13.4 phaseKickback comment is wrong regardless of 1td's
  resolution.** While writing sturm-controlled's docs I noticed
  spec §13.4 has `ry(q, Math.PI / 2) // = H, via library`. Ry(π/2)
  is **not** H in general; what's true is `Ry(π/2)|0⟩ = |+⟩`, which
  is what the use-case wants. Captured in 1td's pitfalls so it
  doesn't get lost during the §8.1 fix design. Not addressed here —
  out of o1q's scope.

## Acceptance

- 7-artefact contract on all three tools.
- 19 + 14 + 13 = 46 goldens regenerate cleanly.
- `--test` hooks pass on all three; categorical-law property tests
  pass (associativity for then/tensor; identity-left/right for
  tensor).
- Main `README.md` catalog rows added.
- `scripts/demo-scope.sh` demo 13 verifies end-to-end composition
  via `sturm-then` chained into `sturm-execute` (P(r=0) = 1.0 on a
  prepare-then-observe pipeline).
- `bun run check`: 29/29 phases green.
- Issue `scientist-workbench-o1q` closed.

## Pointers

- `tools/sturm-controlled/tool.ts` — the literate implementation.
- `tools/sturm-then/tool.ts` — sequential composition with wire-id
  rename discipline.
- `tools/sturm-tensor/tool.ts` — parallel composition (monoidal
  product), total.
- ADR-0006 — IR encoding (the constraint that controls only appear
  on `ry`/`rz`, on which sturm-controlled's out-of-scope policy
  rests).
- ADR-0003 — output error patterns (the boundary-tag pattern for
  sturm-then's signature-mismatch and sturm-controlled's
  out-of-scope).
- `packages/sturm-ir/` — the typed Channel/Op forms all three tools
  consume.
- v3 spec §4.1 (`then`, `tensor`) and §8.2 (`controlled`) — the
  TS-frontend helpers these tools are the IR-level peers of.
- `scripts/demo-scope.sh` demo 13 — the end-to-end composition.
- Shard 022 — the spec absorption that motivated the IR-level peers.
