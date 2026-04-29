# 012 — ADR 0007: distribution-vs-sampling factoring

**Date:** 2026-04-29
**Status:** complete (ADR landed; tools land with Phase 1 issue
 scientist-workbench-tkx and Phase 2 issue scientist-workbench-bir)
**Branches:** main
**Issues:** scientist-workbench-cdz (closed)
**ADR:** [docs/adr/0007-distribution-vs-sampling.md](../adr/0007-distribution-vs-sampling.md)

## Context

Traditional quantum-programming runtimes bundle two distinct
operations into one `run()`:

1. **Compute the post-circuit state** — deterministic linear-algebra
   over the IR.
2. **Sample measurement outcomes** — apply Born's rule to draw
   bitstrings.

Step (1) is genuinely deterministic. Step (2) is where randomness
enters. The Sturm-TS v3 PRD frames this as a single `run()` that
returns a sample.

For the workbench, that bundling is the wrong shape. The substrate's
exact-symbolic ethos rewards keeping the analytic step pure: for
Clifford+T fragments, the distribution is an exact rational; bundling
into `run()` forces a numeric pass through code that is otherwise
content-addressable. The determinism contract (per ADR-0005) further
favours a clean split: a bundled `run()` either violates the contract
globally or carries an unnecessary `nondeterministic: true`
annotation, since step (1) is deterministic on its own.

ADR-0007 codifies the split: two tools, two roles, Born's rule made
structurally explicit.

## What changed

**`docs/adr/0007-distribution-vs-sampling.md`** lands the design.

**`sturm-execute`** — the analytic-distribution tool. Strictly
deterministic. Schema:

```
input  = channelSchema   (ADR-0006)
output = record {
  distribution: record {
    outcomes:  list<record { prob: rational | float64,
                              classical_resolutions }>,
    precision: "exact" | "float64",
  },
  classical_refs: list<string>,
}
```

Implementation outline (full design lands with issue scientist-
workbench-tkx, Phase 1):

- For Clifford+T fragments: state-vector simulation over `Q[√2, i]`
  via `cas-core` polynomial arithmetic. `precision: "exact"`.
- For general parametrised rotations: numeric float64 fallback.
  `precision: "float64"`.
- State-vector size cap (12 qubits = 4096 amplitudes). Beyond cap:
  `tagged "sturm-execute/out-of-scope"` per ADR-0003.

**`sturm-sample`** — the sampling tool. Strictly deterministic *given*
its entropy input (per ADR-0005). Schema:

```
input  = record {
  distribution,        // as above
  entropy: hex string, // ADR-0005
  shots:   integer,
}
output = record {
  samples,
  classical_resolutions,
  entropy_consumed: integer,
}
```

The tool walks the input distribution's CDF using bytes from
`entropy`. Per shot: 8 bytes → uniform-[0,1) → CDF lookup → outcome.
On insufficient entropy: `ToolError` with `suggestion: "provide ≥ N
more bytes"`.

**The composition pattern:**

```
sturm-execute     (deterministic)
  ↓ distribution
                  (entropy-source: only nondeterministic step)
sturm-sample      (deterministic given entropy)
  ↓ samples
```

Cross-references landed in:

- ADR-0005 — explicitly references ADR-0007 as the operational
  realisation of the entropy convention.
- ADR-0006 — explicitly references ADR-0007 as the executor's
  distribution-vs-sampling split.
- `PRD-v0.2.md` §0.1 — delta list acknowledges ADR-0007.

## Why these choices

**Two tools, not one.** The cohesion gain (each tool has one job
with a clean schema) and the contract-preservation gain are worth
two seven-artefact contracts. `sturm-execute` stays in the
determinism contract; only `entropy-source` carries
`nondeterministic: true`. This is the cleanest possible factoring.

**Born's rule is structurally explicit.** The factoring exposes the
physics: `sturm-execute` computes the distribution (what physics says
is true post-circuit); `sturm-sample` is the c-c channel that turns
probability mass into observed bitstrings given entropy. The rule is
no longer hidden inside `run()` — it is a tool, a name, a schema, a
content-addressed step.

**Exact rationals when possible, float64 when forced.** Clifford+T
distributions are exact via `cas-core`. General parametrised rotations
fall back to float64. Forcing one or the other globally throws away
either the substrate's strength (exact symbolics) or the surface area
(general circuits). Both with a `precision` field is honest.

**Entropy as input field, not CLI flag.** Same reasons as ADR-0005:
inputs to the value protocol must be values, so they participate in
content addressing and provenance.

## Frictions surfaced

- **The `classical_resolutions` shape uses `extras: "allow"`.** The
  schema knows there is a record with classical-ref keys, but doesn't
  know the keys themselves (they're channel-specific, generated at
  IR construction time). `extras: "allow"` delegates per-channel
  validation to the tool body. We accept this; alternatives (per-
  channel schemas, full-string-keyed records) are either un-
  supportable in the workbench's tool model or strictly less safe.

- **Distribution-shape is large for big circuits.** A 12-qubit
  channel with 4096 outcomes is a 4096-element list. `cas-core`
  can produce exact rationals for each, which can be very long
  decimal strings. The state-vector cap (and the canonical-bytes
  size) are the natural limits; `sturm-execute` boundary-tags
  out-of-scope before producing a multi-megabyte output.

- **Sampling tool can't optimise around "give me one sample fast".**
  A user who wants one shot pays the cost of materialising the
  full distribution. For 12-qubit circuits this is fine; beyond the
  cap, both tools refuse out-of-scope. Direct sampling (Metropolis-
  Hastings on amplitudes, etc.) for circuits beyond the cap is a
  separate tool with a separate contract — out of v0.2 scope.

- **`sturm-equivalent` (issue 564) gets a side-benefit.** It can
  compare distributions exactly (via `sturm-execute`) without ever
  sampling, for any circuits where both sides land in the
  exact-precision case. This sharpens the killer-demo claim.

## Acceptance

- ADR filed at `docs/adr/0007-distribution-vs-sampling.md`.
- Cross-references from ADR-0005 and ADR-0006 in place (in their
  Related-ADRs headers).
- Justification against the v3 PRD's monolithic `run()` captured in
  the ADR's "Alternatives considered" section.
- `PRD-v0.2.md` §0.1 delta list acknowledges ADR-0007.
- `docs/worklog/README.md` index updated.
- Tool implementations deferred:
  - `sturm-execute` lands with issue scientist-workbench-tkx
    (Phase 1).
  - `sturm-sample` lands with issue scientist-workbench-bir
    (Phase 2).

## Pointers

- ADR-0007 — the decision and the why-not-bundled-`run()` rejection.
- Issue scientist-workbench-cdz — the beads-tracked work item.
- ADR-0005 — externalised entropy; the substrate `sturm-sample`
  relies on.
- ADR-0006 — IR-as-Value; the input shape `sturm-execute` consumes.
- ADR-0003 — output error patterns; out-of-scope IRs (state-vector
  cap exceeded, unsupported op heads) emit boundary-tagged.
