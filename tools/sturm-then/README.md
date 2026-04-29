# sturm-then

Sequential composition of two Sturm channels. The IR-level realisation of
v3 spec §4.1's `then(f, g)` combinator: given two channels whose
signatures agree at the boundary, produces the composite channel
`f; g` with the appropriate wire-id alpha-renaming applied to second's
side.

## Schema

```
input:  record { first: channel, second: channel }
output: channel  |  tagged "sturm-then/signature-mismatch" string
```

Both `channel` slots are `channelSchema` from `@workbench/sturm-ir`
(ADR-0006).

## How

1. **Signature matching.** Compare `first.outputs` against
   `second.inputs` positionally — same length, same `kind` per
   position, and (when both sides specify) same `dim`. A length, kind
   or dim mismatch is a *boundary failure*: `tagged
   "sturm-then/signature-mismatch"` per ADR-0003.
2. **Wire-id renaming.** First keeps every wire id unchanged. Each of
   second's input wires is renamed positionally to match the
   corresponding first output id. Every other wire id in second is
   shifted by `max(first.ids) + 1`, guaranteeing no collision with
   first's wires.
3. **Body concatenation.** `composite.body = first.body ++ rename(second.body)`.
   Composite inputs = first.inputs; composite outputs = renamed
   second.outputs.

Classical refs are not renamed. If `first` ends with `observe(w, "r")`
and `second` opens with `cases("r", …)`, the ref flows across the
boundary as written — that's the intended use. Two channels that
independently bind the same ref produce a duplicate-binding flaw that
`checkWellFormed` catches on the composite; `sturm-then` itself stays
mechanical.

The embedded `circuit` Value of any `oracle` op is **not** renamed —
that channel has its own wire-id namespace sealed by its hash. Only
the outer `inWires` / `outWires` references that name wires in the
enclosing channel are rewritten.

## Examples

The 14 goldens cover the happy paths (empty composites, interface
renaming, internal-wire shifting past first's max, multi-wire
positional matching, controls renaming, classical-ref flow,
input-wire pass-through, Bell-pair-then-observe pipeline) plus the
four out-of-scope branches (length mismatch in both directions, kind
mismatch, dim mismatch).

```sh
echo '<record-IR-JSON>' | bun tools/sturm-then/tool.ts
```

## Invariants

- **deterministic** — same input bytes ⇒ same output bytes.
- **signature-match required** — length / kind / dim mismatch produces
  the boundary tag.
- **first prefix preserved** — the composite's body begins with
  first.body verbatim; first's wire ids are untouched.
- **second renamed into first** — second's input wires map positionally
  to first's outputs; second's other ids shift by `max(first.ids)+1`.
- **associativity** — `then(then(f, g), h)` byte-equals
  `then(f, then(g, h))` under the chosen rename discipline.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Pointers

- ADR-0006 — the IR encoding.
- `packages/sturm-ir/` — the typed forms this tool consumes.
- `tools/sturm-controlled/` — sibling combinator (control by external wire).
- `tools/sturm-tensor/` — sibling combinator (parallel composition with
  auto-rename).
- v3 spec §4.1 (`docs/sturm-ts/spec-v3.md`) — the TS-frontend `then`
  helper this tool is the IR-level peer of.
