# 014 — `packages/sturm-ir`: typed Channel/Op forms, schema, well-formedness, traversal

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-dwg (closed)
**ADR:** [docs/adr/0006-sturm-ir-as-value.md](../adr/0006-sturm-ir-as-value.md)

## Context

ADR-0006 fixed the Sturm channel encoding as a canonical Value:
`expression "channel"` with input/output wire signatures and a closed
seven-head op vocabulary. Every Sturm tool consumes that shape — but
no tool wants to hand-roll the schema, the encoder, the decoder, the
well-formedness invariants, or the body walker. This package is the
common substrate. Eight Phase 1+2 tools depend on it (`sturm-simplify`,
`sturm-execute`, `sturm-equivalent`, `sturm-sample`, `sturm-trace`,
`sturm-bennett-oracle`, `sturm-qecc-wrap`, the channel combinators).

## What changed

A new workspace package, `packages/sturm-ir/`. Public surface (re-
exported from `src/index.ts`):

- **Typed in-memory IR.** `Wire`, `Channel`, and the `Op` discriminated
  union with one interface per head (`PrepareOp`, `RyOp`, `RzOp`,
  `ObserveOp`, `OracleOp`, `CasesOp`, `DiscardOp`). Each op interface
  tags itself with a literal `head` so TS narrows on `op.head`.
- **Builders.** `wire(id, kind, dim?)`, `channel(inputs, outputs, body)`,
  and one builder per op head (`prepareOp`, `ryOp`, `rzOp`,
  `observeOp`, `oracleOp`, `casesOp`, `discardOp`). Defaults:
  `controls: []` on rotations, no `dim` on wires unless passed.
- **Encoders.** `encodeWire`, `encodeOp`, `encodeChannel` — typed
  forms → canonical Values via the protocol helpers (`expr`, `int`,
  `list`, `record`, `str`).
- **Decoders.** `decodeWire`, `decodeOp`, `decodeChannel` — Values →
  typed forms; throw `ProtocolError` with a dotted path on shape
  mismatches.
- **Schemas.** `wireSchema`, `opSchema`, `channelSchema` — the
  canonical schema declarations every Sturm tool's `defineTool` will
  reference.
- **Well-formedness.** `checkWellFormed(c): WellFormedResult` — graph-
  shaped invariants that the schema can't catch (wire-ID scoping,
  control-must-be-quantum, classical-ref scoping, output-signature
  liveness, the v0.1 cases-arm restriction).
- **Traversal.** `traverseChannel(c, visitor)` walks the body in
  document order, descending into `cases` arms (true-arm first, then
  false-arm). The visitor receives a `VisitContext` carrying a
  `branchPath` of `[arm, index]` pairs.

Tests (67 passing, 4 files, 96 expect calls):

- `nodes.test.ts` (28 tests) — wire/op round-trips, builder defaults,
  Bell/GHZ/kickback channel round-trips with canonicalisation
  determinism, decoder error paths reporting dotted locations.
- `schema.test.ts` (16 tests) — wire and op schemas accept good
  shapes, reject malformed kinds/dims/heads, structural P5
  enforcement (a `cnot` op fails the union), top-level channel
  validation.
- `wellformed.test.ts` (19 tests) — happy paths (Bell + kickback);
  scope failures (ry on unprepared wire, prepare collision,
  duplicate inputs, op-on-discarded-wire); control failures
  (classical control, self-control, duplicate); classical-ref
  failures (cases on unbound, observe rebinding); cases-arm
  restrictions (rotation-only OK, prepare/discard/nested-cases
  fail); oracle handling (in-place + fresh outWires both fine);
  output-signature mismatches.
- `traverse.test.ts` (4 tests) — top-level document order,
  cases-arm descent in true-then-false order, branchPath indices,
  empty-body case.

`bun run check`: 14 phases passed, 4 skipped, 0 failed. Tournament
(02-NTT) cross-validation regression suite remains green.

Mutation-proven (per CLAUDE.md Rule 6 / shard 007):

- `wellformed.ts`: stubbed out the `cw.kind !== "quantum"` check on
  controls → 1 test in `wellformed.test.ts` fails (the
  classical-control test), restored.
- `nodes.ts`: stubbed out the `OP_HEADS.has(v.head)` check → 1 test
  fails (`schema.test.ts`'s "rejects an unknown op head"), restored.
- `traverse.ts`: stubbed out the false-arm descent loop → 1 test
  fails (the "visits cases op then trueArm then falseArm in order"
  test), restored.

## Why these choices

**Two layers — typed forms + Values — not one.** A Sturm tool's body
wants `if (op.head === "ry") { /* op.controls is bigint[] */ ... }`,
which only works if there's a typed in-memory layer over the raw
Values. We could have made tools work directly off Values
(`v.args[2].items.map(item => BigInt((item as IntegerValue).value))`),
but that's the kind of repeated boilerplate that drifts. The two
layers compose cleanly: encode/decode are pure functions; schemas and
well-formedness are predicates on Values; the typed layer is what tool
bodies pattern-match on.

**Schema is shallow + decoder fills the recursion gap.** ADR-0004
deliberately omits recursive schemas. The Sturm IR is genuinely
recursive (`cases` arms contain ops; `oracle.circuit` is a channel).
We adopted the layered approach: `opSchema` admits `cases` arms as
`S.list(S.any())` and `oracle.circuit` as `S.any()`; `decodeOp`
catches the recursive shape errors with a dotted path. This matches
the pattern `cas-core` already uses for `valueToRatFn` (recursive
walk that the schema doesn't try to encode).

**v0.1 cases-arm restriction.** The arms can only modify state of
existing wires (apply `ry`/`rz`/`oracle`-on-existing-wires); they may
not `prepare`, `discard`, `observe`, or nest a further `cases`. This
is the simplest rule that makes post-cases scope unambiguous. The
relaxation (allowing scope-changing arms with a "both arms agree"
post-state check) is filed as future work in the README and the
wellformed.ts source. None of the v0.1 Sturm tools need the relaxed
form — the canonical pattern (observe a wire, then conditionally
apply a rotation) lives entirely within the strict rule.

**Wires introduced by `prepare` default to `quantum, qubit`.** The
prepare op carries no `dim` arg in v0.1 (per shard 009 + the cleaned-
up ADR-0006). For higher dimensions, prepare would need a `dim` arg
or a dedicated `prepare-qudit` head. v0.1 is qubit-only; the default
is the obvious choice.

**Visitor doesn't track ambient controls.** Shard 009 mentioned the
visitor would maintain a "controls-stack" during descent. That was a
holdover from a representation where `when` was its own op-node. The
ADR-0006 IR has no `when` op — the controls are already lowered into
each op's `controls` field at IR build time. The visitor's job is
simpler than shard 009 suggested. The traverse.ts file documents this
explicitly so a future agent reading the source doesn't try to
re-introduce the stack.

## Frictions surfaced

- **ADR-0006 had `prepare(p, wire_id, controls?)` in its table.**
  Caught at the start of implementation by re-reading shard 009's
  spec, which has `prepare(p, wire_id)` with no controls. Amended
  ADR-0006 inline (table row, schema example, worked Bell/GHZ
  examples) before writing any code. The ADR now matches shard 009
  exactly: only `ry` and `rz` carry controls; `prepare` and `oracle`
  do not. Documented the rationale (controls apply to unitary
  primitives; preparation is a cq channel realised as a `ry` from
  `|0⟩` if you want a controlled prepare; oracle subcircuits should
  lift the `when` into their inner ops).

- **Recursive schemas would have been cleaner.** The shallow-schema
  + decode-time-recursion split works but means `cases` arms aren't
  validated at the runner-level schema check — they're validated when
  a tool's body decodes them. For tools that *only* validate schema
  and never decode (a hypothetical pass-through tool), the inner ops
  would be unchecked. None of the v0.1+v0.2 Sturm tools fall in that
  bucket — all of them decode. If a future tool needs schema-only
  validation of the full structure, that's a motivator for `S.lazy`
  in the protocol package.

- **`cases` arms need consistent post-state.** The strict v0.1 rule
  ("arms don't change scope") makes this trivial — every arm must
  leave scope at exactly the input state. The relaxed rule (arms can
  change scope, but both arms must agree) was sketched in stepOp's
  comments but not implemented; the snapshot-and-compare machinery
  exists in skeleton form (`snapshotState`, `statesEqual`) so a
  future relaxation can swap in cleanly.

- **`oracle.circuit` is opaque to checkWellFormed.** Recursively
  decoding and well-form-checking the embedded channel is doable but
  was deferred for v0.1: an `oracle` produced by `sturm-bennett-oracle`
  is well-formed by construction, and an externally-supplied oracle
  is the user's responsibility to validate at construction time.
  Documented in nodes.ts and the README.

## Acceptance

- `packages/sturm-ir/` exists in the workspace with the full public
  surface from ADR-0006.
- `bun run check`: 14/14 phases pass.
- `bun test packages/sturm-ir`: 67/67 pass.
- Mutation-proven: stubbing the controls-quantum check, the
  unknown-head check, and the false-arm descent each cause exactly
  the expected test failures.
- Bell / GHZ / kickback IRs round-trip through `encodeChannel` /
  `decodeChannel` and pass `checkWellFormed`.
- Cross-references: `tsconfig.json` paths, root `README.md` File
  layout row, `docs/worklog/README.md` index.
- Issue scientist-workbench-dwg closed.

## Pointers

- ADR-0006 — the IR design.
- `packages/sturm-ir/src/{nodes,schema,wellformed,traverse}.ts` — the
  literate-programmed implementation files.
- `packages/sturm-ir/test/*.test.ts` — the conformance battery.
- `packages/sturm-ir/README.md` — the agent-facing public surface.
- `docs/sturm-ts/principles.md` — P1, P3, P5 are realised here as
  structural type properties.
- shard 011 — the ADR-0006 landing shard.
- Phase 1 followup: issue scientist-workbench-z8w (`sturm-simplify`,
  the first consumer).
