# 010 — ADR 0005: externalised entropy

**Date:** 2026-04-29
**Status:** complete (ADR landed; implementation lands with Phase 2
 issue scientist-workbench-kw1)
**Branches:** main
**Issues:** scientist-workbench-i8m (closed)
**ADR:** [docs/adr/0005-externalised-entropy.md](../adr/0005-externalised-entropy.md)

## Context

The Sturm-TS port (shard 009) introduces a class of computations that
*need* genuine randomness: drawing a measurement outcome from a Born-
rule distribution, simulating a hardware QPU's shot-by-shot result,
running a Monte Carlo integration. The workbench's existing
determinism contract (`README.md` §"Hard requirements", PRD §3.3)
forbids `Date.now`, `Math.random` without seed, and any environmental
nondeterminism — which is the right default and is the load-bearing
property that makes content addressing meaningful.

Two failure modes loomed:

- **Quietly weakening the contract** (admit `Math.random` selectively)
  would silently break the property "same input → same output" for
  every existing tool that doesn't opt in.
- **Refusing to admit randomness** would put Sturm-TS, hardware
  execution, and Monte-Carlo work outside the registry forever.

The honest move is to make randomness a *typed input*. ADR-0005
codifies the convention.

## What changed

**`docs/adr/0005-externalised-entropy.md`** lands the design. Three
coordinated decisions, none of which weaken the contract for any
existing tool:

1. **`nondeterministic: true` annotation on `ToolDefinition`.** A new
   optional boolean on the manifest. Default false — the existing
   contract holds and is unchanged for the nine current tools. When
   true, the tool may emit different outputs across runs given the
   same stdin bytes; the annotation propagates into the provenance
   record so a consumer reading `--provenance-of <hash>` knows
   re-derivation from inputs alone is not promised.

2. **Entropy as a typed input field.** Any tool other than
   `entropy-source` that needs randomness declares an `entropy` field
   in its input record schema (hex-encoded `S.kind("string")`). The
   tool is required to be deterministic given the entropy bytes; this
   is a checkable property, unlike "the tool is statistically
   correct." Such tools do *not* set `nondeterministic: true`.

3. **One privileged `entropy-source` tool.** A single tool, filed
   under issue scientist-workbench-kw1 (Phase 2), bridges OS entropy
   (`crypto.getRandomValues`) into the value protocol. Schema:
   `record { n_bytes }` → `record { bytes (hex), source_kind }`. It
   is the only tool in v0.2 with `nondeterministic: true`. Its
   goldens are shape-only (n_bytes consistency, hex format with the
   right length), and the goldens spec must document this explicitly.

The composition pattern that emerges:

```
entropy-source
  → record{bytes, source_kind}    (the only nondeterministic step)

(combined with sturm-execute's analytic distribution + shots)
sturm-sample
  → record{samples, classical_resolutions, ...}   (deterministic given entropy)
```

Provenance is honest: the `entropy-source` step's output hash is
captured; re-execution of `sturm-sample` against the same entropy +
same distribution is bit-identical. The pipe-level reproducibility is
preserved up to the one identifiable nondeterministic step.

This is *pipe-is-bind* in practice — the existing tools-and-pipes
shape is already monadic. Entropy is a value flowing through the pipe,
content-addressed like everything else. No new value kind, no monadic
wrapper, no `M[a]` ceremony.

Cross-references landed in:

- `README.md` §"Hard requirements" — Determinism statement amended to
  cross-reference ADR-0005.
- `PRD-v0.2.md` §3.3 — same.
- `PRD-v0.2.md` §0.1 — delta list acknowledges ADR-0005.

## Why these choices

**Pipe-is-bind, not a value kind for entropy.** Considered adding a
new kind for "computations needing entropy" — a monadic wrapper. The
substrate's whole pitch is *ten kinds, exhaustive*, and the existing
pipe shape is already monadic. The wrapper would be ceremony for no
gain.

**Annotation rather than per-tool ad-hoc nondeterminism.** Without a
single canonical entropy source, every nondeterministic tool would
re-implement the OS-entropy bridge, and there would be no central
auditable place for "where does randomness enter this pipeline?" The
privileged tool concentrates the contract relaxation in one place.

**Entropy as a typed input value, not a CLI flag or env var.** The
value protocol's hash-stability and provenance both require that
inputs be values. An env var would be invisible to provenance — a
re-execution from the provenance record would silently disagree with
the original run. The entropy must be a typed value.

**Default determinism preserved.** Tools without `nondeterministic:
true` remain strictly deterministic. The existing nine tools must not
change behaviour, and they don't.

## Frictions surfaced

- **Convention drift risk.** A future tool author might be tempted to
  declare `nondeterministic: true` to skip the entropy-input ceremony.
  The annotation is for genuine OS-randomness consumers
  (`entropy-source`, future hardware-execution tools); the registry-
  level lint should flag a tool that has both `nondeterministic:
  true` and an `entropy` input as a likely misconfiguration. Parking
  this as a future check rather than blocking the ADR on it.

- **Provenance asymmetry.** Re-derivation from inputs works for
  deterministic tools and fails for `nondeterministic: true` ones.
  We accept this — alternatives (refusing to admit randomness,
  weakening the contract globally) are worse — but it means
  `--provenance-of` must report the asymmetry honestly rather than
  pretending all provenance records are equivalent.

- **Byte-count budget per tool.** The convention "8 bytes per CDF
  draw" for `sturm-sample` is documented in the tool's schema and
  README, but a caller who undershoots will hit a `ToolError` at
  the consumer end. The error message must be loud and suggest a
  remediation byte count. Implementation lands with issue
  scientist-workbench-bir.

## Acceptance

- ADR filed at `docs/adr/0005-externalised-entropy.md` per the
  project's ADR template.
- `README.md` §"Hard requirements" cross-references ADR-0005 in the
  Determinism bullet.
- `PRD-v0.2.md` §3.3 cross-references ADR-0005 in the Determinism
  section.
- `PRD-v0.2.md` §0.1 delta list acknowledges ADR-0005.
- `docs/worklog/README.md` index table updated with this shard.
- Implementation deferred to Phase 1/2: the `nondeterministic` field
  lands when `runTool` is amended (parked under future issue);
  `entropy-source` lands with issue kw1; `sturm-sample` with issue
  bir.

## Pointers

- ADR-0005 — the decision and the why-not-uniform rejections.
- Issue scientist-workbench-i8m — the beads-tracked work item.
- Shard 009 — the planning shard that motivated this ADR.
- ADR-0006, ADR-0007 — the consumers of this contract amendment.
