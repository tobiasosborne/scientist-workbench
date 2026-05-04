# 036 — ADR-0015: determinism tier (numerical contract relaxation)

**Date:** 2026-05-04
**Status:** ADR-0015 Accepted (design pass + measurement); implementation
filed as a follow-up bead
**Branches:** main
**ADR:** [0015-determinism-tier](../adr/0015-determinism-tier.md)
**Issues closed:** scientist-workbench-0ck.
**Issues filed:** -auz (cross-arch measurement), -2t4 (`linalg-equiv`).

## Context

ADR-0014 (worklog 031) shipped the first numerical tier (`linalg-core`
+ `linalg-solve`) and explicitly deferred the determinism-tier ADR
under §"What we will *not* decide here":

> ADR-0015 (the determinism-tier ADR, bead `0ck`) is the natural
> companion to this work but **must not be drafted speculatively**.

The data the deferral asked for — single-platform stability across
multiple Bun versions on the linalg-solve goldens corpus — did not
exist on 2026-05-03. This shard ran that measurement, used it to
sharpen the design, and landed ADR-0015.

## What changed

**Measurement.** New script `scripts/measure-cross-bun-stability.ts`
builds a 100-case corpus (Hilbert(2..7), Wilkinson(2..8), 87 random
diagonally-dominant matrices, sizes 2..30) and emits per-case
`<case_id>\t<input_hash>\t<output_hash>` lines. Run under two Bun
versions:

- Bun 1.2.21 (last 1.2 release, ~6 months pre-current)
- Bun 1.3.13 (current at measurement time)

both on the same hardware (`linux-x86_64-WSL2-glibc`).

**Result: 100/100 hashes byte-identical across the two Bun minor
versions.** Even on adversarial inputs (Hilbert(7), κ ≈ 3·10⁸; Wilkinson
growth 2⁷). Data and script live at `docs/data/cross-bun-stability/`,
with a README pointing back at this shard and ADR-0015.

**ADR-0015** lands the design pass. Six additive changes, none
breaking existing canonical bytes:

1. `numerical?: boolean` annotation on `ToolDefinition` (parallel to
   ADR-0005's `nondeterministic?: boolean`).
2. `platform?: PlatformRecord` field on `ProvenanceRecord` (additive,
   optional; symbolic records' bytes unchanged).
3. `currentPlatform()` / `currentPlatformHash()` / `platformToValue()`
   helpers in `packages/contract/src/platform.ts`.
4. `executeToolDef` writes `platform` *per-execution*, conditioned on
   output containing float64 leaves (ADR-0007 precedent: same tool can
   produce different-tier outputs on different inputs).
5. `runMemoized` / `lookup` extend the existing selective-skip:
   different-platform records are a cache miss; same-platform records
   hit; symbolic records (no `platform` field) hit unconditionally.
6. New standard flag `--platform-fingerprint` emits the running
   fingerprint without performing work — a discoverability surface
   for the agent's planner.

**Lockstep doc updates (Law 2):**

- `PRD-v0.2.md` §6.1 amended: the unconditional "Always" softens to a
  three-tier rule (symbolic / numerical / nondeterministic), with the
  symbolic tier remaining the default unconditional contract.
- `README.md` §"Hard requirements" mirrors the PRD amendment.
- `CLAUDE.md` gains a hallucination-risk callout: do not unify
  `nondeterministic` and `numerical` as a tier enum without a
  (breaking) ADR; the parallel-flag pattern is load-bearing for
  byte-compat provenance.
- `docs/data/cross-bun-stability/README.md` documents the measurement
  method, the result, and what the data does *not* yet rule on
  (cross-arch).

## Why these choices

**The earlier "TS-expert design" was clean-slate, not pattern-
consistent.** First sketch proposed a discriminated tagged-union
`determinism: {kind: "symbolic" | "numerical" | "stochastic"}`. More
elegant in isolation; *less* in keeping with the codebase. The user's
"would a TS expert agree?" challenge was sharp: the TS expert reading
the codebase finds `nondeterministic?: boolean` (ADR-0005) and reaches
for the *parallel* pattern. The data shape that matches the codebase
beats the data shape that matches the textbook.

**Reading all 14 ADRs before drafting was load-bearing.** The arc
across them showed the project's relaxation-of-contract pattern is
consistent — single-purpose additive flags, never multi-axis enums —
across ADR-0005, ADR-0010, ADR-0011, ADR-0014. Drafting from a
zoomed-in view of the deferred question alone would have produced an
elegant-but-foreign artefact. Project memory beats local optimisation.

**The measurement, not speculation, picks the fingerprint shape.**
Earlier sketch had `{arch, os, libc, runtime, runtime_version,
microarch}`. The data refutes `runtime_version` as a stability axis on
linux-x86_64. Only the three fields the data justifies ship: `{arch,
os, runtime}`. Cross-arch data (when it exists, bead `auz`) grows the
schema additively.

**Per-output tier conditioning over per-tool tagging.** ADR-0007's
`precision: "exact" | "float64"` field was the precedent; the same
tool can produce different-tier outputs on different inputs.
`numerical: true` declares "*may* produce platform-conditional output";
the runner inspects the actual output to decide whether to record the
platform field. This honours ADR-0007's polymorphism cleanly: an
exact-symbolic Clifford+T `sturm-execute` (when the exact path lands
in bead `jfj`) writes no platform field; a float64 fallback run does.

**`runMemoized` skip extends the existing pattern, not parallels it.**
The pattern was already there for `nondeterministic: true` (refuse
cache). The numerical extension is one more condition on the same
selective-skip path, not a parallel-machinery thing. Symmetric with
the codebase's preference for one mechanism, multiple selectors.

## Frictions surfaced

**1. The first sketch was substantially wrong before reading the full
ADR set.** I drafted a 7-point design (tagged-union tier, multi-field
fingerprint, lookup-key extension framed as "richer determinism") that
sounded coherent in isolation. Reading all 14 ADRs end-to-end revealed
the codebase's actual patterns and forced a smaller, more pattern-
consistent design. **Lesson:** for any ADR that touches an existing
contract, read every ADR that touched the same contract first. Skipping
this is the speculative-drafting trap ADR-0014 explicitly named.

**2. The "would a TS expert agree?" prompt did the work.** Without the
challenge, the discriminated-union design would have shipped. With it,
the question forced me to inventory the codebase's actual relaxation
pattern (`nondeterministic?: boolean` — single optional flag) and
recognise the inconsistency. The two-axiom rule (ADR-0009 + ADR-0014)
is a real check on design drift, not just a tagline.

**3. Bun was not installed in the WSL environment.** Stopping to ask
"can I install it?" was correct — installing software unprompted is
the kind of action CLAUDE.md says to confirm. The user authorised; the
install was userland (`~/.bun/bin/bun`) and reversible. Two versions
were installed (1.2.21 and 1.3.13) by saving the first install before
re-installing latest; the bun installer ignores `BUN_INSTALL` env var
and overwrites `~/.bun/bin` in place. Not a bug, just an install-script
constraint to know.

**4. Beads bootstrap silently produced wrong DB state.** `bd bootstrap
--yes` produced a DB with 82 issues, 13 phantom "blocked", out of sync
with the canonical `.beads/issues.jsonl` (83 issues + 3 memories, 0
blocked). `bd import .beads/issues.jsonl` fixed it. **Lesson:** when
bootstrapping beads, follow with an explicit `bd import` to be safe.
Or: trust the jsonl, not whatever `bd ready` reports after bootstrap.

**5. Five system-reminder nudges to use TaskCreate.** Same as shards
028, 029, 030, 031. Per CLAUDE.md Rule 9 ignored; using beads
exclusively. Worth recording for the fifth time so the policy is
maximally clear.

## Acceptance

- ADR-0015 exists with Status=Accepted.
- PRD §6.1 amended.
- README §"Hard requirements" mirrors the amendment.
- CLAUDE.md hallucination-risk callout added.
- `scripts/measure-cross-bun-stability.ts` committed; both result
  TSVs and a README under `docs/data/cross-bun-stability/`.
- Two follow-up beads filed: `auz` (cross-arch), `2t4`
  (`linalg-equiv`).
- Bead `0ck` closeable.
- The implementation is not in this shard. The acceptance for the
  implementation lives in the bead-yet-to-be-filed and will land in
  a separate worklog when it does.

## Pointers

- `docs/adr/0015-determinism-tier.md` — the design pass.
- `docs/data/cross-bun-stability/{README.md, *.tsv}` — the data.
- `scripts/measure-cross-bun-stability.ts` — the measurement script.
- `PRD-v0.2.md` §6.1 — the amended determinism rule.
- `README.md` §"Hard requirements" — the parallel amendment.
- `CLAUDE.md` "Hallucination-risk callouts" — the new entry.
- ADR-0005, ADR-0007, ADR-0009, ADR-0010, ADR-0012, ADR-0014 — the
  precedents this ADR explicitly mirrors.
- Beads scientist-workbench-{0ck (closes), auz, 2t4}.

## Open questions (for the next iteration)

- **The implementation issue.** Six items in ADR-0015 §"Decision";
  ~150 LOC of new code (helpers, runner branch, cache-skip path,
  standard flag) plus one-line `numerical: true` migrations on
  `linalg-solve` (and possibly `sturm-execute`). Should be a clean
  one-shard implementation; goldens of `linalg-solve` are unaffected
  (the platform field lives in provenance, not output).
- **Cross-arch measurement.** Bead `auz`. Whoever next has access to
  Apple Silicon (or linux-aarch64) re-runs the script there, diffs
  against the committed corpus, and writes a 1-paragraph addendum.
  If divergence appears, the addendum names which fields of
  `PlatformRecord` move the bits, which informs whether a fourth
  field is forced. If no divergence appears, that's also a
  data-point to record.
- **`linalg-equiv` (bead `2t4`).** The numerical analogue of
  `cas-verify` — equality up to relative/absolute tolerance. Becomes
  more compelling once a second numerical tool ships (qr/svd/eig
  from bead `71f`) and cross-platform record collation becomes a
  real workflow, not a thought experiment.
