# ADR-0015 — Determinism tier: numerical contract relaxation

**Status:** Accepted — 2026-05-04
**Beads:** scientist-workbench-0ck (this ADR is the resolution); follow-
ups -auz (cross-arch measurement), -2t4 (`linalg-equiv` companion tool).
**Related:** ADR-0005 (externalised entropy — the precedent contract
relaxation; this ADR follows its annotation pattern), ADR-0007 (per-
output `precision` field; the precedent for *per-execution* tier
conditioning), ADR-0012 (composition layer — `runMemoized` extends with
one more selective-skip condition), ADR-0014 (first numerical tier;
explicitly deferred this design until the measurement ran).

## Context

ADR-0014 named the cliff and stopped short of climbing it. The PRD's
§6.1 rule —

> **Bit-deterministic.** Same input, same version → bit-identical
> output. **Always.**

— holds for the symbolic majority of the workbench but is honestly false
for the numerical tier. ADR-0014 §"What we will *not* decide here"
explicitly punted:

> ADR-0015 (the determinism-tier ADR, bead `0ck`) is the natural
> companion to this work but **must not be drafted speculatively**. It
> needs the data this experiment produces.

Two pieces of data now exist that didn't on 2026-05-03:

**1. Single-platform stability across Bun minor versions, measured.**
Script `scripts/measure-cross-bun-stability.ts` builds a 100-case
corpus (Hilbert(2..7) — the canonical "tickle the rounding mode"
family; Wilkinson(2..8) — pivot growth up to 2⁷; 87 random
diagonally-dominant matrices, sizes 2..30) and emits per-case output
hashes. Run under Bun 1.2.21 and Bun 1.3.13 on linux-x86_64-WSL2:
**100/100 hashes byte-identical**. Data lives at
`docs/data/cross-bun-stability/`.

**2. Cross-architecture stability is *not* yet measured.** The cliff
the research note named (`numerics-and-vis-2026-04-29.md` §4.1) — that
LAPACK on x86_64-Linux vs ARM-macOS produces different last bits — is
the question still open. For pure-TS-on-JSC the analogue is "JSC's
`Math.sqrt`/division ordering on darwin-aarch64 vs linux-x86_64"; we
have no JSC-on-ARM data. Filed as bead `auz`.

The data sharpens the question. The earlier framing — *what shape
should a multi-axis fingerprint take?* — turns out to over-engineer
against evidence: `runtime_version` is *not* a stability axis on
linux-x86_64, so a fingerprint that includes it would generate
spurious cache misses across Bun upgrades for zero correctness
benefit.

## The axiom (re-applied)

ADR-0009: **agents are TS experts; what a TS expert wants is the spec**.
ADR-0014 added the planner's lens: **what makes this irresistible to an
agent's planner?** Both apply throughout; both point at the same
design.

Two specific reads of the axiom shape every decision below:

1. **The TS expert reads `nondeterministic?: boolean` on
   `ToolDefinition` (ADR-0005) and expects a parallel flag for the
   numerical tier to be *exactly* `numerical?: boolean`.** Same shape,
   same default, same additive-flag pattern. Not a discriminated union
   subsuming both. The codebase has *one* relaxation pattern; this ADR
   adds *one* relaxation, parallel to the first.

2. **The agent's planner reads `--provenance-of <hash>` and expects
   *more* information when the cached value is platform-conditional,
   not less.** A `platform: <PlatformRecord>` field on the provenance
   record is itself a *positive* discoverability win — the planner can
   tell where each derivation came from and reason about cross-platform
   agreement *as evidence*.

## Decision

Six additive changes. None of them break existing canonical bytes;
none of them change behaviour for any tool that doesn't opt in.

### 1. `numerical?: boolean` annotation on `ToolDefinition`

Parallel to `nondeterministic?: boolean` (ADR-0005). One optional
boolean, default false:

```ts
export interface ToolDefinition<I, O, Fl> {
  // ...existing fields...
  nondeterministic?: boolean;   // ADR-0005
  numerical?: boolean;          // this ADR
}
```

Semantics: when `numerical: true`, the tool *may* produce IEEE-754
float ops in a way that depends on the platform's float runtime. The
flag is a tool-author declaration, not a runtime measurement; the
runtime measurement (whether the *output* contains float64 leaves)
decides whether the platform fingerprint is *recorded* (item 4
below).

Mutually exclusive in practice: a `nondeterministic: true` tool has
no determinism contract, so the `numerical` distinction does not
apply. The runner rejects a tool whose definition asserts both as a
load-time contract violation.

### 2. `platform?: PlatformRecord` field on `ProvenanceRecord`

The provenance record (ADR-0005's locus for the `nondeterministic`
field) gains one more optional field:

```ts
export interface PlatformRecord {
  arch: string;     // e.g., "x86_64", "aarch64"
  os: string;       // e.g., "linux", "darwin", "win32"
  runtime: string;  // e.g., "bun"
}

export interface ProvenanceRecord {
  // ...existing fields...
  nondeterministic?: boolean;   // ADR-0005
  platform?: PlatformRecord;    // this ADR
}
```

The on-disk encoding is exactly:

```ts
record({
  arch: str(p.arch),
  os: str(p.os),
  runtime: str(p.runtime),
})
```

Three fields, justified by the measurement: `runtime_version` is *not*
included because `linalg-solve`'s 100-case corpus produced byte-
identical hashes across Bun 1.2.21 ↔ 1.3.13, demonstrating that on
linux-x86_64 the version axis is *not* a stability axis. Including it
would generate spurious cache misses on every Bun upgrade. The
narrowest fingerprint the data supports is the one we ship.

When the cross-arch measurement (bead `auz`) lands and shows divergence,
the schema can grow additively — adding fields is non-breaking under
the omitted-when-absent convention.

### 3. `currentPlatform()` and `currentPlatformHash()` helpers

A new module `packages/contract/src/platform.ts` exports:

```ts
export function currentPlatform(): PlatformRecord;     // reads process.platform, process.arch, runtime
export function currentPlatformHash(): Hash;           // sha256(canonicalize(platformToValue(currentPlatform())))
export function platformToValue(p: PlatformRecord): Value;
export function valueToPlatform(v: Value): PlatformRecord;
```

Pure helpers. The hash is the content address — same pattern as every
other Value in the system.

### 4. `executeToolDef` writes `platform` per-execution, conditioned on output

The contract dispatcher's work case (ADR-0012's `executeToolDef`) gains
this branch, after output canonicalisation, before provenance write:

```ts
if (def.numerical === true && containsFloat64(output)) {
  record.platform = currentPlatform();
}
```

`containsFloat64(v: Value): boolean` walks the canonical Value tree
returning true on the first float64 leaf. This is the precedent set by
ADR-0007: the same tool can produce different-tier outputs on different
inputs (Clifford+T `sturm-execute` produces exact-symbolic
amplitudes; parametrised-rotation `sturm-execute` falls back to
float64). The provenance reflects what was *actually* computed, not
what the tool *might* compute.

For `linalg-solve`: every output contains float64, so every record gets
the field. For a future `sturm-execute` with the exact-symbolic path
landed (bead `jfj`): the field is present iff the output went down
the float64 fallback path. Same tool, same `numerical: true`
declaration; honest per-execution tier reporting.

### 5. `runMemoized` / `lookup` extend the existing selective-skip

ADR-0012's `runMemoized` already refuses cache hits for
`nondeterministic: true` tools. The numerical-tier extension is one
more condition on the same skip path:

```ts
// In runMemoized:
if (def.nondeterministic === true) throw new CompositionError(...);

// In lookup, after retrieving the candidate ProvenanceRecord:
if (candidate.platform !== undefined) {
  if (hash(platformToValue(candidate.platform)) !== currentPlatformHash()) {
    // Cached on a different platform; from this platform's perspective
    // it's a miss. The record stays in the store — it's still a valid
    // computation on its own platform.
    return null;
  }
}
return candidate;  // platform matches OR record has no platform field (symbolic)
```

Symbolic records (no `platform` field) hit the cache as today.
Numerical records hit the cache iff the platform matches. Different-
platform records coexist in the store without conflict.

### 6. New standard flag `--platform-fingerprint`

Every tool inherits one new standard flag (alongside `--schema`,
`--examples`, etc., per ADR-0011). Emits canonical bytes of:

```ts
record({
  fingerprint: platformToValue(currentPlatform()),
  hash: str(currentPlatformHash()),
})
```

No work performed; no input read; no provenance written. A diagnostic
surface — and an *agent-discoverability* surface. A planner that has a
stored provenance record can compare the record's `platform` field to
the running `--platform-fingerprint` *without* invoking the tool, and
decide whether the cached output is admissible.

## Why these choices

### Pattern consistency over clean-slate elegance

A discriminated tagged union (`determinism: {kind: "symbolic" |
"numerical" | "stochastic"}`) is more elegant *in isolation*. It
unifies what is conceptually one concern: the determinism contract.
The TS expert reading the codebase, however, finds
`nondeterministic?: boolean` — a single optional flag — and reaches for
the parallel pattern, not a refactor that requires updating every
existing tool's annotation. The data shape that matches the codebase
beats the data shape that matches the textbook.

A future ADR may consolidate both flags into a unified
`determinism: DeterminismContract` field. That refactor would be
breaking; this ADR is additive. The cost of the additive shape is the
mutual-exclusion check (item 1); the cost of the unified shape would
be touching every tool. Today, additive wins.

### Per-output tier conditioning over per-tool tagging

ADR-0007 set the precedent: `sturm-execute` produces a `precision:
"exact" | "float64"` *output field* because the same tool can produce
either. Tagging the *tool* `numerical: true` means "may produce
platform-conditional output"; the runner inspects the output to decide
whether to record the platform field. This is the only design that
honours both ADR-0007's polymorphism and ADR-0014's tier-relaxation
intent.

Tagging the tool *or* the output, but not both, would force one of two
losses: either every `sturm-execute` invocation pays the platform-
fingerprint cost (even for exact-symbolic Clifford+T, where the
fingerprint is misleading), or no `sturm-execute` invocation does
(even for float64 fallback, where the fingerprint is necessary).

### Three-field PlatformRecord, no `runtime_version`

The measurement supports three fields and only three. Adding fields
the data doesn't yet justify is the speculative-drafting trap ADR-0014
specifically named. When cross-arch data exists (bead `auz`), the
schema grows; the omitted-when-absent convention keeps existing
records' bytes byte-identical.

A TS expert who reads the schema and asks "where's `runtime_version`?"
finds the answer in the linked measurement: `runtime_version` was
empirically not a stability axis. Honest scope.

### Cache miss returns `null`, not `{ hit, samePlatform }`

A more elaborate return type — `{ hit: O, samePlatform: boolean } |
null` — would let the caller see "I have a cached record from a
different platform" and decide what to do with it. Discarded:

- The TS expert wants `runMemoized` to mean "*give me a cached
  answer that would match what running this would give me right
  now*." A different-platform record does not satisfy that precondition;
  returning it would be lying.
- The agent's planner that *does* want to inspect cross-platform
  records uses `--provenance-of <hash>` directly. The discoverability
  is in the standard flag, not in `runMemoized`'s return shape.
- Optional verbose logging is the right way to surface "skipped due
  to platform mismatch." Silent cache miss + opt-in log line beats
  surface-area complexity in the return type.

### Cross-platform agreement as *positive* evidence

The framing flip from "the determinism contract weakens" to "the
provenance store records *which* platform computed each numerical
result" is what makes this irresistible to an agent's planner.
Concretely:

- Two machines computing the same `linalg-solve` input produce two
  provenance records with two different `platform` fields. They
  coexist in `$CAS_STORE/provenance/`.
- An agent reads `--provenance-of <output_hash>` and sees N derivations
  from N platforms — all proving the same `output_hash`, building
  cross-platform-agreement evidence as a side effect of normal use.
- Pulling a colleague's `.cas-store` to your machine carries their
  numerical results without conflict; the platform field marks each
  one's provenance.
- A future `linalg-equiv` (bead `2t4`) handles the harder case:
  outputs that *don't* hash-match but *do* agree within tolerance —
  the numerical analogue of `cas-verify`.

## What we will *not* decide here

Documented up front so no future agent thinks this ADR was meant to
cover them.

- **Cross-architecture fingerprint shape.** Bead `auz`. Without
  cross-arch data the right schema cannot be picked. The current
  three-field `PlatformRecord` grows additively when the data exists.
- **`linalg-equiv` and the equivalence-checking tier.** Bead `2t4`.
  Tolerance-based equality is its own tool; it does not belong in the
  determinism-tier ADR.
- **Cross-tier composition tracking.** "A symbolic tool consumed a
  numerical tool's output — what's the resulting tier?" Open question;
  not forced by current workloads. Premature.
- **Float-stability *measurement* across multiple installed Bun
  versions as ongoing CI.** The corpus exists; the measurement is
  reproducible by hand. Re-running on every Bun upgrade can be filed
  if it ever becomes an actual workflow concern.
- **PRD §6.1 numerical-tier amendment language.** The amendment lands
  in this session per Law 2; the PRD diff is not in this ADR text but
  in the same commit.

## Migration

- **Eighteen tools today** declare neither `nondeterministic` nor
  `numerical`. Their behaviour does not change; their provenance
  records remain byte-identical to today's.
- **`entropy-source`** keeps `nondeterministic: true`. No `numerical`
  flag added.
- **`linalg-solve`** gains `numerical: true` in the same session this
  ADR lands (one-line edit). Its provenance records gain the
  `platform` field on subsequent runs. Existing committed records are
  not retroactively rewritten — they remain valid as records of
  pre-ADR runs.
- **`sturm-execute`** *should* eventually gain `numerical: true` once
  the v0.1 float64-only path is honestly named as platform-
  conditional. Filed as a follow-up consideration; not blocking this
  ADR.
- **The compose layer's `runMemoized`** picks up the platform-skip
  path automatically via the helper change. No call-site updates
  needed.
- **The standard flag `--platform-fingerprint`** is added once in the
  runner; every tool inherits it.
- **Goldens** of `linalg-solve` are *not* regenerated by this ADR.
  The output bytes are identical — the platform field lives in the
  provenance record, not in the tool's output. Goldens compare tool
  outputs, not provenance.

## Acceptance

- This document exists with Status=Accepted.
- `PRD-v0.2.md` §6.1 amended: the unconditional "Always" softens to
  the symbolic-tier rule, with one sentence naming the numerical tier
  and pointing here.
- `README.md` §"Hard requirements" mirrors the PRD amendment.
- `CLAUDE.md` gains a hallucination-risk callout: `numerical: true` is
  parallel to `nondeterministic: true`; do not consolidate them as a
  tier enum without a separate (breaking) ADR.
- The implementation issue (a separate bead, to be filed when the
  ADR lands) carries acceptance criteria: `numerical?` field on
  `ToolDefinition`, `platform?` on `ProvenanceRecord`,
  `currentPlatform`/`currentPlatformHash` helpers, `executeToolDef`
  branch, `runMemoized`/`lookup` skip extension, `--platform-
  fingerprint` standard flag, `linalg-solve` migration to
  `numerical: true`, end-to-end test of cross-platform cache miss.
- A worklog shard (036) documents the iteration, the measurement, and
  the design choices.

## Pointers

- ADR-0005 — externalised entropy; the precedent annotation pattern
  this ADR mirrors (`numerical: true` parallel to
  `nondeterministic: true`).
- ADR-0007 — distribution-vs-sampling; the precedent for per-output
  tier conditioning (`precision: "exact" | "float64"` field).
- ADR-0012 — composition layer; the locus of the `runMemoized` /
  `lookup` extension.
- ADR-0014 — first numerical tier; explicitly deferred this ADR
  pending the measurement.
- `scripts/measure-cross-bun-stability.ts` — the measurement script.
- `docs/data/cross-bun-stability/` — the measurement results +
  README.
- `docs/worklog/036-determinism-tier.md` — the iteration log.
- Beads scientist-workbench-{0ck (this ADR), auz (cross-arch follow-
  up), 2t4 (`linalg-equiv` follow-up)}.
