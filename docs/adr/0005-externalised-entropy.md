# ADR-0005 — Externalised entropy and nondeterministic tools

**Status:** Accepted (2026-04-29)
**Context:** beads issue scientist-workbench-i8m
**Related:** ADR-0006 (IR-as-Value, the consumer of entropy bytes for
quantum sampling), ADR-0007 (distribution-vs-sampling factoring)

## Context

The workbench's tool contract requires bit-identical output bytes for
the same input + same tool version. Cf. `README.md` §"Hard requirements"
and `PRD-v0.2.md` §3.3:

> **Determinism.** Same input bytes + same tool version ⟹ bit-identical
> output bytes. No `Date.now`, no `Math.random` without seed input, no
> iteration over unsorted hash sets, no locale or environment dependence.

This is not negotiable for the existing nine tools, and it is the load-
bearing property that makes content addressing meaningful: equal canonical
bytes ⟹ equal hash ⟹ equal value.

The Sturm-TS port (shard 009 / scientist-workbench-{i8m,…,can}) and any
future hardware-execution work introduce a class of computations where
*genuine randomness* is the operational reality: drawing measurement
outcomes from a Born-rule distribution; a hardware QPU returning
shot-by-shot results; a random-RNG primitive. There is no way to make
these strictly deterministic without becoming a different tool — a
deterministic state-vector simulator that reports the analytic
distribution rather than a sample is a different operation from a
sampler.

Two failure modes to avoid:

1. **Quietly weakening the contract.** If we let any tool emit a
   different output for the same input, the property test "same input →
   same output" stops being a property of the system and becomes a
   property of "the deterministic subset of the system." That is the
   Mathematica failure mode this project was built to avoid.

2. **Refusing to admit randomness.** Quantum sampling is not a
   pathology to be quarantined — it is part of the operational reality
   the substrate must express. Refusing to admit it leaves Sturm-TS,
   hardware execution, and Monte-Carlo work outside the registry.

The honest move is to make randomness a *typed input*. A tool that needs
entropy declares it in its input schema; the entropy bytes are produced
by one privileged tool whose nondeterminism is a contract concession
made explicit by an annotation. Every other tool stays strictly
deterministic.

## Decision

Three coordinated changes, none of which weaken the contract for any
existing tool:

### 1. `nondeterministic: true` annotation on `ToolDefinition`

A new optional boolean field on the `ToolDefinition` interface in
`packages/contract/src/runner.ts`:

```ts
interface ToolDefinition<I, O> {
  // existing fields …
  nondeterministic?: boolean;   // default false
}
```

When `false` (or absent), the existing contract holds: the tool is
strictly deterministic, hash-stable across runs, and its provenance
record is re-derivable from inputs.

When `true`, the tool may emit different outputs across runs given the
same stdin bytes. The contract relaxation is exactly:

- `same input bytes + same version ⟹ same output bytes` no longer
  holds.
- `same input bytes + same version + same entropy bytes ⟹ same output
  bytes` *does* hold for tools that consume entropy as a typed input.
  This is the property that replaces the strict-determinism property
  for the affected tools.

The annotation is propagated into the provenance record (a new
`nondeterministic: true` field in the JSON) so a consumer reading
`--provenance-of <hash>` knows whether the value can be re-derived
from inputs alone.

The annotation is checked at tool-load time. A tool without the
annotation that nonetheless produces non-deterministic output is a
broken tool — the property test for determinism still applies and
fails loudly.

### 2. Entropy as a typed input field

Any tool other than `entropy-source` that needs randomness declares an
`entropy` field in its input record schema:

```ts
const inputSchema = S.record({
  // …other fields…
  entropy: S.kind("string"),    // hex-encoded bytes
});
```

The convention for the encoding is hex (lowercase, no `0x` prefix). The
tool is required to be deterministic given that field — it consumes the
bytes left-to-right, draws as many as needed, and errors loudly if it
runs out. `nondeterministic: true` is *not* required for these tools:
given the entropy bytes, they are strictly deterministic, and the
contract holds.

The byte-length convention is per-tool. `sturm-sample` documents (in its
schema and README) that it consumes 8 bytes per CDF draw and one CDF
draw per shot times the number of independent measurement points; the
caller is responsible for sourcing enough.

### 3. One privileged `entropy-source` tool

A single tool, `entropy-source` (filed as scientist-workbench-kw1, lands
in Phase 2), is the canonical bridge between OS entropy and the value
protocol. Schema:

```ts
input  = S.record({ n_bytes: S.kind("integer") });
output = S.record({
  bytes: S.kind("string"),    // hex
  source_kind: S.literal(str("os-urandom")),
});
```

Implementation: `crypto.getRandomValues(new Uint8Array(n_bytes))` →
hex-encode → wrap as a string Value. The annotation
`nondeterministic: true` is set; this is the *only* tool in v0.2 with
the annotation. Its goldens are shape-only (n_bytes consistency, hex
format with the right length) — the goldens spec will document this
explicitly so an agent reading the directory understands why byte-equal
goldens are not asserted.

## The composition pattern

The canonical composition for "I want a sample of a quantum
distribution" is:

```sh
echo '{"kind":"record","fields":{"n_bytes":{"kind":"integer","value":"256"}}}' \
  | bun tools/entropy-source/tool.ts
# → { bytes: "<512 hex chars>", source_kind: "os-urandom" }

# combine with the analytic distribution (sturm-execute) and shots,
# and run sturm-sample
```

The `entropy-source` step is the only nondeterministic tool in the
pipe. Everything downstream is deterministic given the captured entropy
bytes; the pipe-level provenance records the `entropy-source` step's
output hash, and a re-execution of `sturm-sample` against the same
entropy + same distribution reproduces bit-identically.

This is *pipe-is-bind* in practice: the existing tools-and-pipes shape
of the substrate is already monadic. Entropy is just another value
flowing through the pipe, content-addressed like everything else. We
add no new value kind, no monadic wrapper type, no `M[a]` ceremony.

## Consequences

**Positive.**

- The determinism contract is preserved as the default and as the
  type-level promise for every existing tool. None of the nine current
  tools change behaviour.
- New nondeterministic tools opt in explicitly. The annotation makes
  the relaxation visible in the manifest, the provenance record, and
  the registry.
- Sampling, hardware execution, and Monte-Carlo work all become
  expressible without any new value kind or protocol-level change.
- Property tests for entropy-consuming tools become "given fixed
  entropy bytes, output is bit-identical." This is a checkable property,
  unlike "the tool is statistically correct."
- `entropy-source`'s goldens-as-shape is honest: shapes that *should*
  be checked are; bytes that *cannot* be reproduced are not.

**Negative.**

- Provenance becomes asymmetric: re-derivation works for the
  deterministic majority and fails for the `nondeterministic: true`
  minority. We accept this — the alternative (refusing to admit
  randomness, or weakening the contract globally) is worse.
- A tool that takes an `entropy` field shifts responsibility to the
  caller to source enough bytes. The error-on-exhaustion behaviour
  must be loud (`ToolError` with a `suggestion: "provide more
  bytes — N more needed"`).
- Convention drift risk: future tool authors might be tempted to
  declare `nondeterministic: true` to avoid the entropy-input
  ceremony. The annotation is for genuine OS-randomness consumers
  (`entropy-source`, future hardware-execution tools); registry-level
  lint or `--test`-hook check should flag a tool that has both
  `nondeterministic: true` and an `entropy` input as a likely
  misconfiguration.

## Alternatives considered

**Add a value kind for "computations needing entropy."** Rejected. The
substrate's whole pitch is *ten kinds, exhaustive*. Adding a monadic
wrapper kind doubles the cognitive load on every tool author; pipe-is-
bind already gives us the composition we need without it.

**Weaken the determinism contract globally.** Rejected. That silently
breaks the contract for all nine existing tools and undoes the property
that makes content addressing meaningful.

**Allow each tool to opt-in to ad-hoc nondeterminism (no privileged
`entropy-source`).** Rejected. Without a single canonical entropy
source, every nondeterministic tool reimplements the OS-entropy bridge,
and there is no central place to audit "where does randomness enter
this pipeline?" The privileged tool concentrates the contract
relaxation in one auditable place.

**Pass entropy via an environment variable or CLI flag.** Rejected.
Inputs to the value protocol must be values (so they are
content-addressed and survive in provenance). An env var would be
invisible to provenance — a tool re-executed from its provenance
record would silently disagree with the original run. The entropy
input must be a typed value.

**Make `sturm-execute` itself nondeterministic and bundle sampling.**
Rejected; this is the question ADR-0007 settles. The analytic
distribution computation is genuinely deterministic and stays so;
sampling is the c-c channel that turns probability mass into observed
bitstrings. Born's rule made structurally explicit (ADR-0007).

## Pointers

- ADR-0006 — IR-as-Value (the consumer of these entropy bytes in
  Phase 2's `sturm-sample`).
- ADR-0007 — distribution-vs-sampling (the operational pattern for
  *which* tool is nondeterministic and *which* stays deterministic
  given entropy).
- `packages/contract/src/runner.ts` — the `ToolDefinition` interface
  the new optional field lands on.
- `README.md` §"Hard requirements" — the determinism statement is
  amended to cross-reference this ADR.
- `PRD-v0.2.md` §3.3 — same.
- `tools/entropy-source/` — to be filed under Phase 2 issue
  scientist-workbench-kw1.
- shard 009 (`docs/worklog/009-sturm-ts-port-planning.md`) — the
  planning shard that motivated this ADR.
