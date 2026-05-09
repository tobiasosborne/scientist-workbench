# sturm-controlled

Quantum-control a Sturm channel by an external wire. The IR-level
realisation of v3 spec §8.2's `controlled(c, f)` combinator: given a
control wire and a channel, returns a new channel whose `ry`/`rz`
ops (recursively through `cases` arms) all have the control wire
appended to their `controls` list, and whose input/output signatures
are augmented with the control wire.

## Schema

```
input:  record { control_wire: integer, channel: channel }
output: channel  |  tagged "sturm-controlled/out-of-scope" string
```

`channel` is the ADR-0006 IR shape (`channelSchema` from
`@workbench/sturm-ir`). The runner validates both alternatives of the
output union via first-match-wins; the channel form is the happy path.

## How

Walk the body. For every `ry`/`rz`, append the control wire to its
`controls` list. For `cases`, recurse into both arms. We do **not**
canonicalise the resulting controls list (sort or deduplicate) — that's
`sturm-simplify`'s job, and keeping the two concerns separate means
`controlled(c, controlled(c, f))` composes mechanically and a downstream
`sturm-simplify` pass collapses the redundancy.

Out of scope (`tagged "sturm-controlled/out-of-scope"`):

- **wire-id conflict.** `control_wire` is by definition external to
  the inner channel; if the control id collides with any wire id used
  in the channel's inputs, outputs, or body, we boundary-tag rather
  than silently shadow. Use `sturm-tensor` first if you need to
  rename-on-merge.
- **non-unitary op in body.** Coherent control on `prepare`, `observe`,
  `oracle`, or `discard` is not well-defined. ADR-0006 admits the
  `controls` field only on `ry` and `rz` for exactly this reason.
- **non-unitary op inside a `cases` arm.** Same rule applied
  recursively.

Note that controlled-`oracle` *is* meaningful in principle (lift the
control into the embedded reversible circuit), but doing so requires
recursing into the oracle's payload — out of scope for v0.1.

## Examples

The 19 goldens in `goldens/` cover the happy paths (single ry, single
rz, both axes on the same wire, multi-target body, pre-existing
controls, nested cases, control wire 0) plus every out-of-scope
branch (wire conflict against inputs / body targets / existing
controls; prepare / observe / discard / oracle in the body;
non-unitary ops nested inside cases arms).

```sh
echo '<record-IR-JSON>' | bun tools/sturm-controlled/tool.ts
```

## Invariants

- **deterministic** — same input bytes ⇒ same output bytes (symbolic
  tier, ADR-0015 — bit-identical cross-platform forever).
- **control-stamping** — every `ry`/`rz` in the output body
  (recursively through cases arms) has `control_wire` appended to its
  controls list; no rotation in the output is missing it.
- **non-unitary rejected** — any `prepare`/`observe`/`oracle`/`discard`
  in the body produces `tagged "sturm-controlled/out-of-scope"`.
- **wire-conflict rejected** — `control_wire` colliding with any wire
  id used by the inner channel produces the same tag.
- **signature augmented** — on success the output channel's inputs
  and outputs each begin with the control wire followed by the inner
  channel's signature, in order.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Pointers

- ADR-0006 — the IR encoding (where `controls` is admitted only on
  `ry`/`rz`).
- `packages/sturm-ir/` — the typed Channel/Op forms this tool consumes.
- `tools/sturm-then/` — sequential composition (sibling combinator).
- `tools/sturm-tensor/` — parallel composition with auto-rename
  (sibling combinator).
- v3 spec §8.2 (`docs/sturm-ts/spec-v3.md`) — the TS-frontend
  `controlled(c, f)` helper this tool is the IR-level peer of.
