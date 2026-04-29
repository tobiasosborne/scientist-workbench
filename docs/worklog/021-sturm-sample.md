# 021 — tools/sturm-sample (Born's rule, applied)

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-bir (closed)

## Context

Shard 020 closed `entropy-source` (kw1) — the privileged nondeterministic
primitive that bridges OS randomness into the value protocol. The natural
next escalation is the consumer side of ADR-0007's distribution-vs-sampling
factoring: `sturm-sample`. It takes an analytic distribution from
`sturm-execute` plus a hex-encoded entropy stream and emits per-shot
classical-ref resolution rows. Strictly deterministic *given* the typed
`entropy` field — exactly the ADR-0005 convention `entropy-source` was built
to feed.

This shard finishes the three-step composition:

```
sturm-execute    →  distribution     (deterministic)
entropy-source   →  bytes            (the only nondeterministic step)
sturm-sample     →  samples          (deterministic given entropy)
```

Re-execution against the same captured entropy bytes is bit-identical:
provenance and reproducibility hold up to the one identifiable
nondeterministic step. Born's rule is no longer hidden inside a monolithic
`run()`; it is a tool with a name, a schema, and a content-addressed
position in the pipeline.

## What changed

`tools/sturm-sample/{tool.ts, package.json, README.md, goldens.spec.ts,
goldens/}` — the full 7-artefact contract. 13 declared examples, 15
goldens (the example list and the goldens spec overlap but are not
identical: the goldens omit the malformed-input cases since `error:`
examples don't generate a captured output, and add three additional
shape-coverage entries).

Algorithm: hex-decode entropy → CDF on probabilities (float64 acc) →
per-shot uniform draw `Number(uint64) / 2^64` from 8 big-endian bytes →
linear-scan CDF for the first index `i` where `CDF[i] ≥ u` → emit the
chosen outcome's `classical_resolutions` row. `entropy_consumed = 8 *
shots` is reported explicitly so callers chaining multiple sample stages
have ergonomic byte-budget bookkeeping.

`--test` hook covers determinism (subprocess-level: same input → same
output bytes), byte-budget invariant, samples-length, sample-shape-
matches-distribution (every emitted row is one of the distribution's
outcome rows; canonical-bytes match), statistical convergence (2000-shot
50/50 sample with a Mulberry32-seeded entropy stream; assert |zero-count
- 1000| ≤ 6σ ≈ 134), and the three malformed-input rejection paths
(out-of-bytes, malformed hex, negative shots).

`bun run check`: 23/23 phases green (one new `tool --test: sturm-sample`
phase + one new `oracle: sturm-sample (15 goldens)` phase). The
convention-check is clean (no warnings).

Main `README.md` catalog gains a row noting the canonical three-step
pipeline.

## Why these choices

### Distribution schema duplicated, not imported from sturm-execute

`distributionInScopeSchema` mirrors `sturm-execute`'s `inScopeOutputSchema`
byte-for-byte, including the `list-of-pairs` deviation from ADR-0007's
`extras: "allow"` sketch (per shard 018's friction). I considered three
ways to share the schema:

1. **Move the schema into `packages/sturm-ir`.** The ir package is currently
   "channel data + structural checks." Adding distribution shape would
   stretch its scope; sturm-ir doesn't otherwise know about probabilities.
2. **Create `packages/sturm-distribution`.** A new package whose only
   contents are two schema definitions. High ceremony for low payload.
3. **Duplicate the schema in `sturm-sample`.** Trades ~10 lines of
   schema declaration against any imported coupling. If `sturm-execute`
   ever changes the shape (e.g. lands the exact-symbolic path under
   scientist-workbench-jfj and adds a probability variant for Q[√2]
   rationals), the integration is a one-line schema edit here, surfaced
   as a clean schema-mismatch on the next pipeline run rather than a
   silent semantic drift.

(3) won. The duplication is small and the schema *is* the contract — having
two tools independently restate it is more likely to catch shape drift
than a single import would. If a third tool wants to consume distribution
shape (e.g. a future `sturm-distribution-equiv`), revisit by extracting
to a shared module.

### `inputSchema: Schema<Value>` annotation, narrow inside `fn`

The schema's natural narrow type (`Schema<RecordValueOf<...>>`) is a
deeply nested `RecordValueOf`/`ListValueOf` chain. When that narrow flows
through to `defineTool`'s `examples: ExampleEntry<I,O>[]` slot, the
example helpers (`dist`, `outcome`, `pair`) — which build structurally
identical records but are typed via the protocol's generic helpers —
fail to match because TS can't reconcile two distinct narrow paths to
the same value shape.

Two ways out:

- Make the example helpers polymorphic so element narrowness propagates.
  I tried this; it almost works but TS array-literal widening drops the
  narrow on `[outcome(...), outcome(...)]`. Workable but fragile.
- Annotate `inputSchema` as `Schema<Value>`. The example slot accepts any
  Value (so the helper-built records pass the TS check), and the runtime
  `checkExamplesAgainstSchema` in the runner (ADR-0004) does the actual
  validation. Inside `fn`, narrow with a runtime kind-discrimination
  (`if (input.kind !== "record") throw ToolError(...)`) rather than a
  type assertion.

Option 2 is the same pattern `sturm-execute/tool.ts` already uses
(line 841: `const inputSchema: Schema<Value> = channelSchema;`). Match
the established idiom; trade off the type-level narrow on `fn`'s input
parameter for ergonomic example construction and runtime-validated
correctness.

### `Number(uint64) / 2^64` and the u = 1.0 corner

The 8-byte uniform draw is `Number(BigInt) / 2^64`. The corner case:
`Number(2^64 - 1)` rounds *up* to `2^64` in float64 (the gap between
representable doubles at that magnitude is 2048), so when every byte is
`0xff`, u is exactly `1.0` rather than just under. The CDF lookup uses
`>=` (not `>`) and saturates at the last outcome via a final
`return cdf.length - 1` fallback, so u = 1.0 maps cleanly to the last
outcome.

Documented as a code comment inline. The alternative (use 7 bytes per
shot to avoid the rounding) trades the corner case against a
non-power-of-two byte budget, which messes up the ADR-0007 "8 bytes per
shot" convention and makes byte-counting in the README more
complicated. Eight bytes + the saturation fallback is the cleaner deal.

### Mulberry32 instead of crypto.subtle.digest for the convergence test

First draft of the `--test` hook generated a deterministic entropy stream
via SHA-256 chaining over a counter (`crypto.subtle.digest("SHA-256",
data)` in a loop). It silently failed: the test hook entered, the
SHA-256 promise's first await resolved, but on the *second* iteration
the await never fulfilled and the parent process exited cleanly with
code 0 (no error, no "tests passed" line — just a blank exit).

A standalone repro of the same code (a script that calls `spawnBun`
twice then `crypto.subtle.digest` twice) worked fine. The smell was
specifically `crypto.subtle.digest` *inside* a tool's `--test` hook
*after* `spawnBun` calls. Bun-specific async-loop interaction; didn't
chase it down further.

Switched to a synchronous Mulberry32 PRNG (12 lines, no async surface,
fully deterministic given a 32-bit seed). Reproducibility is what the
test wants — cryptographic strength is not relevant for a
sample-frequency convergence check. The hook now runs cleanly in
~474 ms.

Logged the friction in the "Frictions surfaced" section below; if the
crypto.subtle interaction reappears in another tool's hook, the right
move is the same workaround until someone has time to file a Bun bug.

### Statistical-convergence tolerance: 6σ

For N=2000 shots from a 50/50 distribution, the std dev on the zero-
count is `√(2000 · 0.5 · 0.5) ≈ 22.4`. Six sigma is ~134. So the test
asserts the zero count is in `[866, 1134]`, which is ~10⁻⁹ tail-
probability under correct sampling — robust against any reasonable
fixed-seed entropy stream while still tight enough to catch real
sampling bugs (e.g., a constant bias > 6.7%).

The test is itself deterministic (Mulberry32 seed is hard-coded), so it
will never flake — it either fires for a fixed reason or doesn't fire at
all. If a refactor changes the CDF lookup or the byte-to-uniform
conversion in a way that biases the output, this test catches it.

### Examples include `error:` cases for malformed input

Three examples have `error:` rather than `output:` set. ADR-0003 says
malformed input is `ToolError`, and the `--examples` flag carries the
expected stderr-message string for callers. The `error:` strings encode
my throw payloads (without the runner's `${def.name}:` prefix that the
runner adds at the catch boundary) — matching the established convention
in `mod-pow/tool.ts` and consistent with shard 020's "doubled-prefix"
note about the existing convention.

## Frictions surfaced

- **`crypto.subtle.digest` after `spawnBun` in a `--test` hook silently
  exits the parent.** A standalone script with the identical sequence
  (two spawnBun → two crypto.subtle.digest) works fine. Inside the
  runner's `--test` dispatch it doesn't. Worked around with a synchronous
  Mulberry32 PRNG. Documented here so the next tool that wants
  deterministic test entropy doesn't fall in the same pit.

- **TS narrow vs ergonomic example helpers.** The schema-derived narrow
  type for the input record fights with the protocol's generic value
  helpers when constructing nested record examples. Sturm-execute hit
  the same wall (line 841: `const inputSchema: Schema<Value> = ...`);
  matched the idiom rather than fighting it. The lesson — re-learned
  from shards 018, 019, 020 — is that `Schema<Value>` is the right
  annotation for tools whose examples are assembled from helpers, and
  narrow inside `fn` via runtime kind discrimination. The `defineTool`
  narrow-inference pattern is for tools whose examples are constructed
  inline as record literals (mod-pow style).

- **Convention-check warnings on inline type assertions.** First pass
  used `as { kind: "record"; fields: ... }` casts inside `fn` and the
  `--test` hook to narrow Values. The convention check's regex is
  liberal — it can't distinguish type literals from value literals —
  and produced 14 warnings (non-fatal). Refactored to use the protocol's
  exported `RecordValue` / `ListValue` / `StringValue` / `IntegerValue`
  type aliases instead. Cleaner code AND the convention check goes
  green. Use the protocol's exported types for narrowing; reserve
  inline type literals for the protocol package's internals.

- **outcomes shape doesn't constrain its sub-records at the schema-
  derived narrow level.** Even with `RecordValue` cast, accessing
  `outcome.fields["prob"]` returns `Value` (since `RecordValue.fields`
  is `{ [k: string]: Value }`). I've left this as-is — the runtime
  validate guarantees the structure, and the cast-to-narrow chain
  would balloon code with no real safety gain. The schema is the
  contract; the cast tells TS to trust it.

- **The three-step pipeline isn't yet a one-shell-line.** End-to-end
  composition `sturm-execute | entropy-source | sturm-sample` requires a
  small wrapping shell function (or jq invocation) to combine the
  distribution + entropy + shots into a single record before piping into
  `sturm-sample`. The README documents this honestly — there's a
  legitimate "adapter tool" pattern that would smooth this if the
  pipeline becomes load-bearing in `scripts/demo-scope.sh`. Not built
  yet; YAGNI until a demo wants it.

## Acceptance

- 7-artefact contract — `tool.ts` (literate, ~700 lines including the
  test hook), `package.json`, `README.md`, `goldens.spec.ts` (15
  entries), `goldens/` (15 generated files), `--test` hook,
  `--schema` conformance.
- `bun run check`: 23/23 phases green; convention-check is clean.
- Determinism property test: identical input → identical output bytes
  across two subprocess spawns.
- Byte-budget invariant: `entropy_consumed == 8 * shots` for every
  golden.
- Samples-length invariant: `samples.length == shots` for every golden.
- Sample-shape-matches-distribution: every emitted row is one of the
  distribution's outcome rows (canonical-bytes match).
- Statistical convergence: 2000-shot 50/50 with Mulberry32-seeded
  entropy gives zero-count within 6σ of the mean.
- Three malformed-input rejection paths exercised: out-of-bytes,
  malformed hex, negative shots.
- Main `README.md` catalog row added with the canonical-pipeline note.
- ADR-0007's distribution-vs-sampling factoring fully realised: both
  ends of the split now ship.
- ADR-0005's typed-entropy convention exercised end-to-end:
  `entropy-source` produces hex bytes; `sturm-sample` consumes them as
  its `entropy` input field; the strict-determinism contract holds for
  every step except the explicit `entropy-source` boundary.
- Issue scientist-workbench-bir closed.

## Pointers

- `tools/sturm-sample/tool.ts` — the literate implementation.
- `tools/sturm-sample/README.md` — agent-facing reference.
- `tools/sturm-sample/goldens.spec.ts` — 15 representative inputs.
- `docs/adr/0007-distribution-vs-sampling.md` — the design decision
  this shard's `sturm-sample` half implements (the
  `sturm-execute` half landed in shard 018).
- `docs/adr/0005-externalised-entropy.md` — the typed-entropy
  convention; this tool is the first non-`entropy-source` consumer.
- Shard 018 — `sturm-execute`, the analytic-distribution producer this
  tool consumes from.
- Shard 020 — `entropy-source`, the bytes producer this tool consumes
  from.
- Issue scientist-workbench-jfj — the deferred exact-symbolic path;
  when it lands, this tool will already accept rational probabilities
  (`probValueToFloat` handles them forward-compatibly).

## Next

Phase 2 still has four open issues:

- `q0b` (`sturm-trace`) — TS source → IR; the TypeScript frontend.
  Substantial; needs a sandboxed subprocess that loads user code.
- `733` (`sturm-bennett-oracle`) — classical reversible function → IR
  oracle node. Needs a small bit-arithmetic vocabulary or a cas-core
  bridge.
- `8e8` (`sturm-qecc-wrap`) — channel → encoded channel; the QECC
  realisation of P6.
- `o1q` (`sturm-controlled` + `sturm-then` + `sturm-tensor`) — three
  channel-combinator tools.

The natural escalation from here is `o1q`: three small tools sharing
the same algorithmic surface (walk a channel's body, emit a
modified channel) that exercise the IR much more thoroughly than what
shipped in Phase 1. They also unblock more interesting demos
(point-free channel composition lets agents write quantum programs at
the workbench layer without going through `sturm-trace`).
