# ADR-0007 — Distribution-vs-sampling factoring for quantum execution

**Status:** Accepted (2026-04-29)
**Context:** beads issue scientist-workbench-cdz
**Related:** ADR-0005 (externalised entropy — the substrate the
sampler consumes), ADR-0006 (IR-as-Value — the input shape both
tools read).

## Context

Traditional quantum-programming runtimes bundle two distinct
operations into one `run()`:

1. **Compute the post-circuit state** — a deterministic linear-algebra
   pass over the circuit's IR.
2. **Sample measurement outcomes** — apply Born's rule to the state to
   draw bitstrings.

Step (1) is genuinely deterministic: given an IR, the post-circuit
state (or its distribution over measurement outcomes) is a function of
the IR alone. Step (2) introduces randomness — its output is a draw
from that distribution.

The Sturm-TS v3 PRD frames this as a single `run()` operation that
returns a sample. For scientist-workbench, this bundling is the wrong
shape:

- The substrate's exact-symbolic ethos rewards keeping the analytic
  step pure: for Clifford+T fragments, the distribution is an exact
  rational; bundling into `run()` would force a numeric sampling pass
  through code that is otherwise content-addressable and reproducible.
- The determinism contract (`README.md` §"Hard requirements", PRD
  §3.3, ADR-0005) says every tool is strictly deterministic by default.
  A `run()` that bundles sampling either violates the contract globally
  or carries an unnecessary `nondeterministic: true` annotation —
  unnecessary because step (1) of the bundled operation is genuinely
  deterministic and the only nondeterminism enters at step (2).
- An agent reasoning about "what is the post-circuit distribution?" is
  asking a different question from "give me a 1024-shot sample." The
  factoring matches the questions.

The principle this ADR codifies: **Born's rule is structurally
explicit in the tool factoring.** The analytic distribution and the
sampling step are two different operations and live in two different
tools.

## Decision

Two tools, two roles. Both consume IR Values per ADR-0006; the second
consumes entropy bytes per ADR-0005.

### `sturm-execute` — analytic distribution computation

```ts
schema.input  = channelSchema;                   // ADR-0006
schema.output = S.record({
  distribution:    distributionSchema,
  classical_refs:  S.list(S.kind("string")),
});

// strictly deterministic
nondeterministic = false;   // (default)
```

Where `distributionSchema` is:

```ts
S.record({
  outcomes: S.list(S.record({
    prob: S.union([S.kind("rational"), S.kind("float64")]),
    classical_resolutions: S.record({}, { extras: "allow" /* per-classical_ref */ }),
  })),
  precision: S.union([S.literal(str("exact")), S.literal(str("float64"))]),
})
```

Implementation outline (full design lives in the tool's `tool.ts` once
issue scientist-workbench-tkx lands):

- For Clifford+T fragments: state-vector simulation over `Q[√2, i]`
  via `cas-core` polynomial arithmetic. Probabilities come out exact
  rationals; `precision: "exact"`.
- For general parametrised rotations (arbitrary `ry`/`rz` angles
  whose values are not π-rationals): numeric float64 fallback.
  `precision: "float64"`.
- State-vector size cap (12 qubits suggested; ~4096 amplitudes).
  Beyond cap: `tagged "sturm-execute/out-of-scope"` per ADR-0003.

The output is a Value. Its hash is the content address of "the
post-circuit distribution of this channel." Any consumer that has the
hash can replay or audit.

### `sturm-sample` — distribution + entropy → samples

```ts
schema.input = S.record({
  distribution:  distributionSchema,            // from sturm-execute
  entropy:       S.kind("string"),              // hex-encoded; ADR-0005
  shots:         S.kind("integer"),
});
schema.output = S.record({
  samples:                S.list(S.record({}, { extras: "allow" })),
  classical_resolutions:  S.list(S.record({}, { extras: "allow" })),
  entropy_consumed:       S.kind("integer"),
});

// strictly deterministic given the entropy field
nondeterministic = false;
```

The tool walks the input distribution's CDF using bytes from
`entropy`. Per shot: 8 bytes → uniform-[0,1) → CDF lookup → outcome.
Determinism property: `same (distribution, entropy, shots) ⟹ bit-equal
output`. Statistical-convergence property: with large `shots` and
fresh entropy, sample frequencies converge to the input distribution
within a documented tolerance.

If `entropy_consumed > len(entropy)`, the tool emits `ToolError` with
`suggestion: "provide ≥ N more bytes"`. The byte-count formula is
documented in the tool's `--invariants`.

### The composition pattern

```sh
# 1. Compute the analytic distribution (deterministic, content-addressed).
echo '<channel-IR-JSON>' \
  | bun tools/sturm-execute/tool.ts \
  > /tmp/dist.json

# 2. Source entropy (the only nondeterministic step).
echo '{"kind":"record","fields":{"n_bytes":{"kind":"integer","value":"8192"}}}' \
  | bun tools/entropy-source/tool.ts \
  > /tmp/entropy.json

# 3. Sample the distribution given the entropy (deterministic).
echo "<combined record of dist + entropy + shots>" \
  | bun tools/sturm-sample/tool.ts
```

The pipeline has exactly one nondeterministic step — `entropy-source`.
Everything else is content-addressed. Re-execution given the same
entropy bytes is bit-identical.

## Why this is Born's rule made structural

Born's rule, in operational quantum mechanics, is the c-c channel that
turns a quantum state into a classical probability mass function over
measurement outcomes. By factoring `run()` into:

- `sturm-execute`: the channel that takes an IR Value to an analytic
  distribution. This is exactly the act of computing what physics says
  the post-circuit state is, then projecting onto a measurement basis.
- `sturm-sample`: the channel that takes a distribution + entropy to a
  sample. This is exactly Born's rule applied — turning probability
  mass into observed bitstrings given entropy.

The rule is no longer hidden inside `run()`. It is a tool, a name,
a schema, and a content-addressed step in the pipeline. An agent
reading the factoring sees the physics directly.

## Consequences

**Positive.**

- The exact-symbolic case is the default for Clifford+T fragments,
  not a special mode. The analytic distribution stays exact through
  `cas-core`, and the substrate's strengths show up where they apply
  most.
- The determinism contract holds for `sturm-execute` (the analytic
  step). Only `sturm-sample` and `entropy-source` interact with
  entropy — and `sturm-sample` itself remains strictly deterministic
  *given* its entropy input (per ADR-0005's typed-entropy convention).
- The composition pattern is a clean three-step pipe with one
  identifiable nondeterministic step. Provenance and reproducibility
  remain meaningful.
- Sturm-equivalent (issue scientist-workbench-564) can use
  `sturm-execute` directly: equality of distributions is decidable
  for the exact case and approximate for the float64 case, both at
  the analytic-distribution level without ever sampling.

**Negative.**

- Two tools to write and maintain instead of one. We accept this:
  the cohesion gain (each tool has one job, with a clean schema) and
  the contract-preservation gain are worth two seven-artefact
  contracts.
- A user who genuinely wants "give me one sample" pays the cost of
  computing the full distribution first. For small circuits this is
  negligible; for the 12-qubit cap it is fine; beyond the cap, both
  tools refuse out-of-scope. Users who need shots-from-a-very-large-
  circuit-without-distribution-computation are outside v0.2's scope
  and would need a separate `sturm-sample-direct` tool that uses
  state-vector evolution without the distribution materialisation —
  filed if and when the need arises.
- The distribution shape is a Value, but its `extras: "allow"` on
  `classical_resolutions` means schema validation is partially
  delegated to the tool body. We accept this; the alternative
  (declaring every classical_ref name in the schema) would force
  per-channel schemas, which the workbench's tool model doesn't
  support.

## Alternatives considered

**One bundled `sturm-run` tool that does both.** Rejected. This is the
v3 PRD's `run()` shape and is the wrong factoring for the workbench:
it loses the analytic step's purity, forces `nondeterministic: true`
on a tool whose first half is genuinely deterministic, and hides Born's
rule.

**Make probabilities float64 always.** Rejected. The exact-symbolic
case is more powerful than the numeric case for the workbench's
target use cases (Clifford+T equivalence, phase-estimation analysis,
QECC verification). Defaulting to float64 throws away the substrate's
key advantage.

**Make probabilities rationals always.** Rejected. General
parametrised rotations (e.g., `ry(0.317)` for some `0.317` not a
π-rational) do not have rational probabilities. Forcing rational
output excludes legitimate IRs.

**Sample directly from the IR without materialising a distribution.**
Rejected for v0.2. Direct sampling (Metropolis-Hastings over circuit
amplitudes, etc.) is a known technique for circuits beyond the
analytic-simulation cap. It is a different tool with a different
contract; out of v0.2 scope. The 12-qubit cap on `sturm-execute` is
the honest scope limit.

**Entropy as a CLI flag rather than an input field.** Rejected for
the same reasons listed in ADR-0005: inputs to the value protocol
must be values, so they participate in content addressing and
provenance.

## Pointers

- ADR-0005 — externalised entropy; defines the typed-entropy
  convention `sturm-sample` consumes.
- ADR-0006 — IR-as-Value; defines the channel shape `sturm-execute`
  consumes.
- ADR-0003 — output error patterns; out-of-scope inputs (state-vector
  cap exceeded, unsupported op heads) emit boundary-tagged values.
- ADR-0004 — `Schema`; the language in which `distributionSchema` is
  written.
- `tools/sturm-execute/` — to be filed under Phase 1 issue
  scientist-workbench-tkx.
- `tools/sturm-sample/` — to be filed under Phase 2 issue
  scientist-workbench-bir.
- shard 009 (`docs/worklog/009-sturm-ts-port-planning.md`) — the
  planning shard that motivated this ADR.
