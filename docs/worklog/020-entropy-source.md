# 020 — tools/entropy-source (Phase 2 kick-off)

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-kw1 (closed)

## Context

Phase 1 of the Sturm-TS port closed at shard 019 with `sturm-equivalent`
ringing the bell on the killer demo. Phase 2's natural first piece is
`entropy-source` — the privileged nondeterministic primitive specified
by ADR-0005 (shard 010). It is the prerequisite for `sturm-sample`
(scientist-workbench-bir) and for every future hardware-execution tool,
and it is the *only* tool in v0.2 that legitimately fails the strict-
determinism contract.

Shard 010 explicitly deferred two pieces of implementation work to land
with kw1: the `nondeterministic: true` manifest annotation on
`ToolDefinition`, and its propagation into the provenance record. So
this shard is doing both — runner amendment plus the consumer that
exercises it — in a single coordinated edit.

## What changed

**`packages/contract/src/runner.ts`.** New optional field
`nondeterministic?: boolean` on `ToolDefinition`. Default absent /
false; existing nine deterministic tools are untouched. When `true`,
the runner threads the flag into the provenance record before writing.
A literate doc-comment on the field cross-references ADR-0005 so a fresh
reader of the runner sees the convention, the default, and the privileged
consumer in one place.

**`packages/contract/src/provenance.ts`.** Optional
`nondeterministic?: boolean` field on `ProvenanceRecord`. The encoder
emits `"nondeterministic": true` only when the flag is `true`; absence
emits no field. This is the load-bearing detail: every existing
deterministic provenance record stays byte-equal to its pre-amendment
form. (Canonical encoding sorts keys, so an always-present
`nondeterministic: false` would shift bytes for every tool's
historical records.) The decoder accepts the field optionally and
rejects non-boolean payloads loudly.

Two new tests in `packages/contract/test/contract.test.ts`: round-trip
through the value form when `nondeterministic: true`, and a "no
encoding drift" test confirming the field is omitted (not
serialised as `false`) when absent.

**`tools/entropy-source/{tool.ts, package.json, README.md,
goldens.spec.ts, goldens/}`.** The full 7-artefact contract, except
that `goldens/` is intentionally empty — see "Why these choices" below.
`tool.ts` carries the literate header (chapter-style intent + algorithm
+ goldens-rationale prose) and a `--test` hook that spawns the tool
twice and asserts every shape invariant (byte-count, hex format,
source-kind label, the two outputs differing).

`bun run check`: 21/21 phases green (one new `tool --test:
entropy-source` phase; the oracle phase is skipped silently because
`goldens/` has no `*.golden.json` files).

Main `README.md` catalog gains a row noting this is the only tool with
`nondeterministic: true`.

## Why these choices

### `nondeterministic` is omitted, not serialised as `false`

The amendment to `ProvenanceRecord` had to be additive without shifting
bytes for any existing record. Canonical JSON encoding sorts keys
lexicographically, so a record `{flags, inputs, output_hash, tool}`
becomes `{flags, inputs, nondeterministic, output_hash, tool}` if the
field is always present — every deterministic tool's historical
provenance bytes would change, invalidating the content-addressing of
the existing on-disk store.

The fix: `provenanceToValue` only adds the field when
`r.nondeterministic === true`. A test (`nondeterministic absent ⇒
field omitted`) asserts this directly. The trade-off is an
asymmetric encoding (`true` is encoded; `false` and `undefined` both
round-trip to `undefined`), but since `false` is semantically the
default for every deterministic tool, the asymmetry is fine: callers
that read provenance and want a definite tri-state `nondeterministic ∈
{true, false, undefined}` can default to `false` on absence.

### Goldens are intentionally empty

ADR-0005 specifies that entropy-source's goldens are "shape-only
(n_bytes consistency, hex format with the right length)." But the
existing goldens machinery — `scripts/generate-goldens.ts` and
`tools/oracle/tool.ts` — operates strictly on byte equality. For a
tool whose every invocation produces fresh OS-entropy, byte equality
is by definition broken: regeneration would write different bytes
(defeating the "regen is a no-op on a clean tree" property),
and the oracle would fail every run.

Three options on the table:

1. Extend `generate-goldens.ts` and `oracle` to read a tool's
   manifest and switch to a "shape-only" mode (validate output against
   `--schema` rather than against captured bytes).
2. Use a fixed seed under a debug flag.
3. Publish no goldens; document the choice; move all verification
   responsibility into the `--test` hook.

(2) is explicitly forbidden by ADR-0005: "Do not seed from a
deterministic source... testability comes from the `nondeterministic:
true` annotation that opts goldens out of byte-equality." (1) is the
architecturally clean future, but it touches three scripts and warrants
its own ADR amendment + worklog shard. (3) is the most surgical move
that doesn't lie: it ships kw1 honestly today, and the eventual
shape-only-oracle work can be filed if a second nondeterministic tool
shows up and motivates the abstraction.

`bun run check` already supports option (3) silently — the oracle
phase loop in `scripts/check.ts` skips tools whose `goldens/` directory
contains no `*.golden.json` files. So the empty goldens dir is not a
contract violation; it is the explicit, documented choice that flows
from the tool being nondeterministic-by-design.

The `goldens.spec.ts` file carries a full prose explanation so a future
reader landing in the directory understands the choice and doesn't
"helpfully" populate goldens that would immediately break under
oracle.

### `n_bytes` cap at 1 MiB

`crypto.getRandomValues` itself caps at 65 536 bytes per call (Web
Crypto spec; Node's webcrypto enforces this and Bun follows). I chunk
internally to handle requests up to a tool-level cap. The cap is 1
MiB, which is well past any plausible single consumer:
`sturm-sample` consumes 8 bytes per CDF draw, so 1 MiB ≈ 130 000
shots' worth of entropy. A caller wanting more should chunk via
repeated invocation rather than monopolising OS entropy in a single
call.

Above the cap the tool emits `ToolError` with a `suggestion` to chunk;
this is per CLAUDE.md "Errors that teach" and PRD §6.1's hard
requirements list. The example list documents both lower-bound (`n=0`,
`n<0`) and upper-bound (`n > MAX`) failures.

### Examples omit `output`

ADR-0003 + the runner's example-conform-to-schema check accept
examples without an `output` field. For a nondeterministic tool, a
"concrete output" example would either be a lie that happens to
typecheck (a captured sample, reproduced as if it were canonical) or a
distinct shape that the schema doesn't admit ("varies"). Existing
precedent: `tools/oracle/tool.ts` already publishes examples without
`output` for the same reason — the tool's output depends on the file
system state, which `--examples` cannot capture.

The example descriptions carry the shape commitment in prose
("bytes is 2 hex chars, source_kind 'os-urandom'") so an agent reading
`--examples` learns the shape without expecting a literal sample.

### `--test` hook spawns the tool, doesn't call `fn` directly

The "two consecutive calls produce different bytes" property is
load-bearing — and an in-process test that calls `fn` twice would
exercise only the function body. Spawning the tool exercises the full
runner path: schema validation, output canonicalisation, provenance
write. If a future regression broke (say) the runner's output
canonicalisation in a way that memoised on the output hash, an
in-process test would miss it. The subprocess hook catches it.

Cost: ~570 ms for the hook (six subprocess spawns: four `callOnce` for
the byte-count loop + two more for the nondeterminism check + three
for the failure cases). Comfortably within budget.

## Frictions surfaced

- **The doubled-prefix in stderr.** Running with `n_bytes=0` produces
  `entropy-source: entropy-source: n_bytes must be ≥ 1 (got 0)`. The
  runner unconditionally prefixes the thrown error message with
  `${def.name}:`, and my `ToolError` construction also includes
  `${NAME}:`. mod-pow does the same; the convention is established
  (and broken). Not in scope to fix here — would be a one-line runner
  change but risks shifting every tool's example `error:` strings.
  Filing as a follow-up if it becomes load-bearing.

- **The convention check almost flagged me.** First draft of the
  `--test` hook constructed the stdin canonical bytes via
  `JSON.stringify({kind: "record", fields: ...})`, which trips the
  `KIND_LITERAL_RE` lint in `scripts/check.ts`. Switched to
  `canonicalize(record({n_bytes: int(n)}))` — both cleaner and
  in-keeping with the other tool implementations (`oracle/tool.ts`
  uses the same pattern). The convention check earned its keep on
  this change.

- **`RecordValue<{n_bytes: IntegerValue}>` is wrong.** I tried to
  annotate the `inp` helper's return type with a generic `RecordValue`
  — but `RecordValue` is not generic in `kinds.ts`; it is the
  widened `{kind:"record", fields:{[k:string]:Value}}`. The narrow
  shape comes from letting TS infer `record(...)`'s return type via
  its `<F extends ...>` generic. Same lesson as shard 019's "explicit
  Schema annotation throws away the narrow" — the protocol's value
  helpers are designed to thread narrow types through inference; an
  annotation is almost always a step backwards.

- **Empty goldens directories are silently honoured.** Pleasantly
  surprised: `scripts/check.ts`'s oracle loop already does the right
  thing for tools with no `*.golden.json` files (skip silently).
  This was not an explicit design decision for this case — it was a
  side effect of "if there are no goldens, there's nothing to check"
  — but it gave kw1 a free, no-extra-machinery path to ship the
  contract honestly. ADR-0005 §3's "shape-only goldens" framing
  doesn't need a new mechanism *yet*; it can stay aspirational until
  a second nondeterministic tool surfaces.

## Acceptance

- 7-artefact contract — `tool.ts` (literate, ~250 lines including the
  test hook), `package.json`, `README.md` (with the goldens-rationale
  paragraph), `goldens.spec.ts` (empty array + prose), `goldens/`
  (empty), `--test` hook, `--schema` conformance.
- `bun run check`: 21/21 phases green. The new tool adds one phase
  (`tool --test: entropy-source`); the oracle phase is skipped
  silently.
- Manifest declares `nondeterministic: true`.
- `ProvenanceRecord` extended with optional `nondeterministic` field;
  encoder omits the field when absent so existing deterministic
  provenance bytes do not shift; decoder accepts the field optionally
  and rejects non-boolean payloads. Round-trip + omission tests added.
- Property tests via `--test` hook: byte count, hex format,
  source-kind label, nondeterminism (two 32-byte calls differ),
  rejects-zero, rejects-negative, rejects-over-cap.
- Main `README.md` catalog row added with the explicit
  "only tool with `nondeterministic: true`" note.
- Issue scientist-workbench-kw1 closed.

## Pointers

- `tools/entropy-source/tool.ts` — the literate implementation.
- `tools/entropy-source/README.md` — agent-facing reference.
- `tools/entropy-source/goldens.spec.ts` — the empty-goldens
  rationale prose.
- `docs/adr/0005-externalised-entropy.md` — the design decision this
  shard implements.
- `packages/contract/src/runner.ts` — `ToolDefinition.nondeterministic`
  amendment.
- `packages/contract/src/provenance.ts` — `ProvenanceRecord`
  amendment + omit-when-absent encoding.
- Shard 010 — the ADR landing shard that deferred this implementation
  to kw1.
- Issue scientist-workbench-bir (`sturm-sample`) — the next consumer;
  takes the bytes this tool produces and applies Born's rule.

## Next

The natural Phase 2 follow-up is `bir` (`sturm-sample`): consumes a
distribution from `sturm-execute` plus an `entropy: string` field
sourced from this tool, returns samples + classical resolutions.
That tool stays *deterministic* given the entropy bytes (no
`nondeterministic: true`); it is the consumer side of the
distribution-vs-sampling factoring (ADR-0007). Once `bir` lands, the
end-to-end pipeline `entropy-source ⊕ (sturm-execute distribution)
→ sturm-sample → samples` works for any in-scope channel and exercises
ADR-0005's full composition pattern.
