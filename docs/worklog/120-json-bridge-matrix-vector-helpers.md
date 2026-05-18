# 120 — `@workbench/json-bridge`: matrix/vector ergonomic helpers (bead `qiv8`)

**Date:** 2026-05-15
**Bead:** scientist-workbench-qiv8 (closes)
**Touches:** `packages/json-bridge/src/index.ts`,
`packages/json-bridge/test/json-bridge.test.ts`,
`packages/json-bridge/README.md`,
`scripts/demo-scope.ts` (dogfood site)

## Context

The bead was filed during the D_W1 dogfood (2026-05-10): every
numerical-tier typed-barrel call site was re-deriving the same boilerplate
to lift a JS `number[][]` into a canonical `list<list<float64>>` value
and to unpack a returned `list<float64>` back to `number[]`. Two
visible-cost forms:

```ts
// build — 3 nested map() levels just to encode IEEE-754 bits
const peiInput = list(
  M.map((row) => list(row.map((x) => float64FromNumber(x)))),
);
```

```ts
// extract — a filter+narrow+map+as-never chain to pull float64s back
const eigs = lams.items
  .filter((it): it is { kind: "float64" } & typeof it => it.kind === "float64")
  .map((it) => float64ToNumber(it as never));
```

Both have a single inevitable shape; both turn what should be a
one-liner into a six-line block with an `as never` cast at the bottom.
The bead's witness was `scripts/demo-scope.ts` (the 350-line
end-to-end demo) and a temp `qwasserstein.ts` from the same dogfood —
"this should be `matrixToValue(M)`" wasn't a design speculation, it was
a TS-expert reading the code and reaching for what they expected to find.

Paired with bead `0y27` (worklog 118): that one deleted `as never` at
the *flags* boundary of the typed barrel; this one deletes `as never`
at the *matrix/vector* boundary. Together they're the cast-free
numerical-tier call site.

## What changed

**Four helpers in `@workbench/json-bridge`,** ~80 LOC + 17 new tests:

```ts
vectorToValue(v: readonly number[]):                   ListValueOf<Float64Value>
matrixToValue(M: readonly (readonly number[])[]):      ListValueOf<ListValueOf<Float64Value>>
valueToVector(v: Value):                               number[]
valueToMatrix(v: Value):                               number[][]
```

The `*ToValue` direction's return type is the *narrow*
`ListValueOf<...>` — not the loose `Value` or `ListValue`. That's
load-bearing: a wider return would re-introduce the `as never` cast at
the typed-barrel slot, defeating the whole point. Two type-level
assertions pin this:

```ts
type _ok = ReturnType<typeof matrixToValue> extends ListValueOf<ListValueOf<Float64Value>>
  ? true
  : "WIDENED RETURN TYPE";
```

The `valueTo*` direction takes a loose `Value` — the caller doesn't have
to prove the shape before unpacking, because *proving the shape is
exactly the filter/narrow boilerplate this helper exists to delete.*
Shape mismatches throw `JsonBridgeError` with the `$[i]` / `$[i][j]`
path naming the offending position.

**Rectangularity is enforced** on both `matrixToValue` (input ragged
rows) and `valueToMatrix` (value ragged rows). Workbench linalg tools
all assume rectangular matrices; a silent ragged encoding would crash
deeper with a much less useful error. Empty matrices `[]` are valid (a
0×N degenerate is a legal input).

**The dogfood witness rewritten.** `scripts/demo-scope.ts:339-358`
(the linalg-eigh on the Pei matrix block) goes from

```ts
const peiInput = list(peiRows.map((row) => list(row.map((x) => float64FromNumber(x)))));
const eighResult = await wb.linalgEigh({ kind: "record", fields: { A: peiInput } });
if (eighResult.kind === "record") {
  const lams = eighResult.fields["eigenvalues"];
  // ... 4 lines of narrow ...
    const eigs = lams.items
      .filter((it): it is { kind: "float64" } & typeof it => it.kind === "float64")
      .map((it) => float64ToNumber(it as never).toFixed(4));
```

to

```ts
const eighResult = await wb.linalgEigh({ kind: "record", fields: { A: matrixToValue(peiRows) } });
if (eighResult.kind === "record") {
  const lams = eighResult.fields["eigenvalues"];
  // ... same narrows for the scalar fields ...
    const eigs = valueToVector(lams).map((x) => x.toFixed(4));
```

Three fewer lines, no `as never`, demo output unchanged — verified
running.

## Why these choices

- **`valueTo*` / `*ToValue` naming, both directions.** The bead's
  proposed names were `matrixToValue` / `vectorToValue` (active going
  *to*) but `valueToMatrix` / `vectorFromValue` (mixing "X-to-Y" with
  "Y-from-X" for the reverse direction). Inconsistent — and exactly
  the kind of naming-tax the bead was filed to delete. The TS-expert
  test "would you type this without thinking" prefers `valueTo*` for
  both reverse directions (active voice, parallel structure). Decided
  to normalise.

- **Generic `Value` input for `valueTo*`, narrow output for `*ToValue`.**
  Asymmetric on purpose. The forward direction *promises* a narrow
  output to satisfy the typed-barrel slot; the reverse direction
  *accepts* a loose input so the caller doesn't need to prove the
  shape first. Reversing either polarity would either lose the
  cast-free composition (narrow input on the reverse path forces the
  caller to narrow before calling) or hide bugs (loose output on the
  forward path lets ragged matrices through silently).

- **Rectangularity enforced both directions.** Defensive on input
  (`matrixToValue`) and on output (`valueToMatrix`) — a value coming
  from a linalg tool's output is *always* rectangular by construction,
  but defensive checking turns a corrupted input into a clean
  `JsonBridgeError` with a `$[i]` path rather than a confusing
  downstream crash deep in someone else's code.

- **`JsonBridgeError` for shape-mismatch refusals**, not a tool's
  `ToolError` envelope. These helpers run in caller code, not as a
  tool — `ToolError`'s exit-1 + stderr semantics don't apply. Match
  the package's existing `JsonBridgeError` convention (same one that
  signals path-pointed hint mismatches in `jsonToCanonical`); the
  dotted-path mechanism is exactly the right shape for "row 1 has
  length 2, expected 3."

- **Returned `number[]` is JS-mutable.** Could have returned a
  `readonly number[]` to discourage in-place mutation, but the dogfood
  sites (`.map(toFixed)`, accumulators, scratch buffers) all mutate
  freely. The mutability is matching the JS idiom callers reach for.

## Frictions surfaced

- **`*ToValue` widening on naïve implementation.** The first attempt
  returned the `list(...)` helper output directly — but
  `list<E>` from `@workbench/protocol` returns `{kind: "list"; items:
  readonly E[]}`, and TS sometimes widens `E` to `Value` at the
  return-site if there's any ambiguity. The fix was to return the
  object literal explicitly typed `{ kind: "list", items: ... }` — TS
  preserves the element type at the literal site without any inference
  drama. The type-level `extends ListValueOf<Float64Value>` test
  catches a regression to the wider form (`WIDENED RETURN TYPE` const
  string).
- **The bead suggested `vectorFromValue`, which would have been a
  consistency drift.** Naming is part of the ergonomics. Caught in
  the design pass, before any code was written; updated in the worklog
  to be honest about the small normalisation.

## Acceptance

- `@workbench/json-bridge` tests: **49 pass** (was 32; +17 new across
  three describe blocks — `vectorToValue / valueToVector — round-trip
  and refusal`, `matrixToValue / valueToMatrix — round-trip and
  refusal`, `type-level: helper returns narrow to ListValueOf<...>`).
- Round-trip identity for typical / edge cases: 2×3 matrix, 5×5
  identity, empty matrix, vector with ±Infinity, subnormals, ±0.
- Refusal coverage: non-list inputs, ragged rows (both `matrixToValue`
  input side and `valueToMatrix` value side), non-`float64` cells at
  named `$[i][j]` positions.
- Type-level: `ReturnType<typeof matrixToValue> extends
  ListValueOf<ListValueOf<Float64Value>>` pinned via a const
  assignment; the third test in the block (`cast-free composition:
  matrixToValue feeds a list<list<float64>> slot`) builds a synthetic
  call site mirroring the typed-barrel boundary and confirms
  `matrixToValue(M)` typechecks against the slot without any cast.
- **Dogfood site rewritten** in `scripts/demo-scope.ts:339-358`
  (linalg-eigh on the Pei matrix), three lines shorter and cast-free,
  with the same output `[1.0000, 1.0000, 1.0000, 1.0000, 6.0000]`
  confirmed running.
- Full `bun run check` — green (see commit).

## Pointers

- `docs/worklog/118-flagsargof-arbprec-lift.md` — the `0y27` sibling.
  Together, `0y27` + `qiv8` deliver a cast-free numerical-tier
  typed-barrel call site: flags arg cast-free (`0y27`), matrix/vector
  args cast-free (`qiv8`).
- `docs/adr/0015-first-numerical-tier.md` — the numerical-tier
  vocabulary the matrix/vector helpers serve.
- `packages/json-bridge/src/index.ts` — the four helpers and their
  doc-comments.
- `packages/json-bridge/README.md` § "Numerical-tier ergonomic helpers
  (bead `qiv8`)" — the before/after example and the four-row API table.
- `scripts/demo-scope.ts:339-358` — the rewritten dogfood witness.
