# sturm-simplify

IR canonicaliser for Sturm channels (ADR-0006). Idempotent. The Sturm-IR
analogue of `cas-simplify`: takes an IR Value, returns the canonical
form of the same channel that every downstream tool can rely on.

## Schema

```
input:  channel-IR Value (ADR-0006)
output: channel-IR Value
```

Both sides are `channelSchema` from `@workbench/sturm-ir`. The runner
validates input shape before `fn` runs and output shape after.

## Rewrites

| Rewrite | Effect |
|---------|--------|
| `ry(0)` / `rz(0)` | eliminated |
| consecutive `ry(α)` then `ry(β)` on the same wire with the same controls | fused to `ry(α+β)` (via `cas-simplify`); both vanish if the sum is zero |
| same for consecutive `rz` | as above |
| controls list | sorted ascending and deduplicated |
| `cases` with both arms empty | dropped |
| `cases` arms | recursively simplified |

Out of scope, deliberately:

- Cross-axis fusion. `ry` and `rz` on the same wire do **not** commute;
  fusing them across axes would change the channel.
- Bennett-style decomposition of multi-controls. The IR vocabulary is
  closed (P5); controls remain as a field.
- Static collapse of `cases`. `classical_ref` bindings are dynamic;
  the tool cannot statically resolve which arm fires.
- Touching the embedded `circuit` payload of an `oracle` op. That
  channel has its own identity (its hash); preserving it verbatim is
  the contract.

## Examples

The 32 goldens in `goldens/` cover every rewrite branch plus
representative pass-through cases (Bell, GHZ, phase kickback,
oracle round-trip, classical wire input). See `goldens.spec.ts` for
the canonical inputs.

```sh
echo '<channel-IR-JSON>' | bun tools/sturm-simplify/tool.ts
```

For an end-to-end demo, run `bash scripts/demo-scope.sh`.

## Invariants

- **Idempotent.** `simplify(simplify(c)) = simplify(c)`. Property
  tested in `--test`.
- **Deterministic.** Same input bytes ⇒ same output bytes. Property
  tested.
- **Wire and classical-ref preservation.** No wire is renamed; no
  `observe` is invented or dropped. The tool's rewrites operate
  entirely on `ry`/`rz`/`cases` shapes.
- **No cross-axis fusion.** Consecutive `ry` then `rz` on the same
  wire are not fused.
- **Oracle circuits untouched.** The `circuit` Value of an `oracle`
  op is preserved verbatim.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Pointers

- ADR-0006 — the IR encoding.
- `packages/sturm-ir/` — the typed Channel/Op forms, schemas, and
  well-formedness check this tool consumes.
- `packages/cas-core/` — `casSimplify`, used for the angle algebra.
- `tools/cas-simplify/` — the algebraic-Value sibling tool; same
  shape, different domain.
- shard 015 (`docs/worklog/015-sturm-simplify.md`) — the landing
  shard for this tool.
