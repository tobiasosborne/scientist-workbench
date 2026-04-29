# sturm-tensor

Parallel composition of two Sturm channels — the monoidal product on the
channel category. The IR-level realisation of v3 spec §4.1's
`tensor(f, g)` combinator: produces the channel that runs `left` and
`right` side-by-side, with right's wire ids alpha-renamed to keep the
two namespaces disjoint.

## Schema

```
input:  record { left: channel, right: channel }
output: channel
```

Both `channel` slots are `channelSchema` from `@workbench/sturm-ir`.
Tensor is **total** — there is no signature-mismatch failure mode;
every pair of channels has a tensor product.

## How

1. Compute `offset = max(left.ids) + 1` (or `0` if `left` has no
   wires).
2. Walk right.body, right.inputs, right.outputs through a
   constant-shift function `id ↦ id + offset`.
3. Build the composite:
   - `inputs = left.inputs ++ rename(right.inputs)`
   - `outputs = left.outputs ++ rename(right.outputs)`
   - `body = left.body ++ rename(right.body)`

The shift-by-max+1 scheme is the simplest renaming that keeps the two
sides disjoint without a more elaborate compaction pass. A future
`sturm-renumber` could compact the output ids if anyone wanted them
contiguous; tensor itself stays mechanical.

The embedded `circuit` Value of any `oracle` op is **not** renamed —
that channel has its own wire-id namespace sealed by its hash. Only
the outer `inWires` / `outWires` references that name wires in the
enclosing channel get rewritten.

**Classical refs are not renamed.** If both sides independently bind
the same ref name (e.g., both end with `observe(_, "r")`), the
composite contains a duplicate `observe` for `"r"` — a well-formedness
flaw that `checkWellFormed` catches on the composite. Workaround for
v0.1: use unique ref names across channels you intend to tensor.
A future iteration could add a classical-ref renaming pass either
here or as a separate `sturm-rename-refs` tool.

## Examples

The 13 goldens cover identity-left, identity-right, the offset
arithmetic on single-wire and multi-wire right sides, multi-wire
left where max-id-determines-offset, prepare-on-both-sides,
recursive renaming inside `cases` arms, controls-list shifting,
and the Bell-pair × independent-rotation parallel composition.

```sh
echo '<record-IR-JSON>' | bun tools/sturm-tensor/tool.ts
```

## Invariants

- **deterministic** — same input bytes ⇒ same output bytes.
- **left preserved verbatim** — left's wire ids and body are
  unchanged; the composite's first `len(left.body)` ops byte-equal
  `left.body`.
- **right shifted by offset** — every wire id in right is shifted by
  `max(left.ids)+1` (or `0` if `left` has no wires).
- **identity-left** — `tensor(empty, c)` byte-equals `c`.
- **identity-right** — `tensor(c, empty)` byte-equals `c`.
- **associativity** — `tensor(tensor(a, b), c)` byte-equals
  `tensor(a, tensor(b, c))` under the chosen rename discipline. (The
  identity arises because all three forms produce the wire-id range
  `a.ids ∪ (b.ids + max_a + 1) ∪ (c.ids + max_a + max_b + 2)` and the
  body order is left-first throughout.)
- **totality** — every pair of channels has a tensor product; no
  boundary-tag failure mode.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Pointers

- ADR-0006 — the IR encoding.
- `packages/sturm-ir/` — the typed forms this tool consumes.
- `tools/sturm-controlled/` — sibling combinator (control by external
  wire).
- `tools/sturm-then/` — sibling combinator (sequential composition with
  signature matching).
- v3 spec §4.1 (`docs/sturm-ts/spec-v3.md`) — the TS-frontend `tensor`
  helper this tool is the IR-level peer of.
