# ADR-0028 — Migration of `bench/` golden corpora to `scientist-workbench-corpus`

**Status:** SETTLED on migration direction and first batch (linalg trio).
UNSETTLED on per-tool execution sequence beyond the linalg trio.
**Beads:** `scientist-workbench-abch` (this ADR); parent epic `scientist-workbench-spup`
(agent-ergonomics tidy, Pillar 2). Child migration beads named in
§Consequences below.
**Related:**
- ADR-0019 (solve bench discipline — the verifier protocol and golden-master
  format these benches rely on; invariants carry into the corpus).
- ADR-0012 (composition layer — `@workbench/compose` invokes tools in-process;
  the `run-candidate.ts` adapters in each bench use `loadWorkbench()` from
  this layer).
- ADR-0003 (three output categories — bench verifiers test for tagged-boundary
  shapes; the corpus verifier discipline preserves this).
- closed bead `scientist-workbench-rll` (endorsed the migration path; the
  closing commit's message reads: *"Future bench/<tool>/ work migrates into
  benchmarks/<tool>/ in the corpus repo."*).

**References:**
- `../scientist-workbench-corpus/README.md` — "Wholesale migration of
  `scientist-workbench/bench/<tool>/`" as an explicit roadmap item.
- `../scientist-workbench-corpus/HANDOFF.md` §1 — full list of pending bench
  migrations as of session 2026-05-06.
- `../scientist-workbench-corpus/benchmarks/linalg-eigh/` — the working
  tracer that is the pattern for every migration.
- `../scientist-workbench-corpus/adapters/scientist-workbench/linalg-eigh.toml`
  — the per-implementation bridge, referencing `${WORKBENCH_ROOT}` and a
  pinned git SHA.
- `docs/worklog/047-linalg-eigh-via-bench.md` — the shipping shard for
  `linalg-eigh`; the bench was the primary proof-of-quality vehicle.

## Context

`bench/` currently holds 14 subdirectories totalling 182 MB, which is
approximately 42% of the total bytes under version control in this repo
(182 MB / 432 MB). The dominant contributors are the linalg golden corpora:
`linalg-svd/golden` (87 MB), `linalg-qr/golden` (76 MB), and
`linalg-eigh/golden` (16 MB). Every other bench is under 2 MB.

The mass is not the only problem. A consumer-agent landing in
`scientist-workbench` to invoke tools — the primary design persona for this
repo — has no use for `bench/linalg-svd/golden/inputs.json`. The golden
corpora are grading infrastructure for the *implementer*, not the
*consumer*. They belong in a separate, dedicated repo.

The `scientist-workbench-corpus` sister repo was designed exactly for this
role. Its tracer-bullet session (worklog 001 in the corpus repo, session
2026-05-06) already established the full pipeline end-to-end for
`linalg-eigh`: 46 cases × 7 invariants, 46/46 pass on first run. The
corpus's `README.md` calls out "Wholesale migration of
`scientist-workbench/bench/<tool>/`" as the top roadmap item. Bead
`scientist-workbench-rll` is closed with the migration direction endorsed.
This ADR turns that endorsement into a concrete, actionable design.

Two concerns that could have kept benches in-repo are both resolved:

1. **Tool isolation** — the corpus adapter calls `run-candidate.ts` via
   `${WORKBENCH_ROOT}`. Tool source and tests remain in the workbench.
2. **`bun run check` continuity** — the oracle phases walk
   `tools/<name>/goldens/` (tool-side goldens from `generate-goldens.ts`),
   not `bench/<tool>/golden/`. The two directories are distinct artefacts;
   migration leaves `scripts/check.ts` unaffected.

## Decision

### 1. What migrates

The following artefacts move from `bench/<tool>/` (workbench) to
`benchmarks/<tool>/` (corpus):

- `golden/` — `inputs.json`, `expected.json`, `generate.py`, `verify.py`,
  `verifier_protocol.md`. The corpus adds `verify.ts` as the default verifier
  (§4); `verify.py` is preserved as an escape hatch.
- `reference/` — the per-tool reference script (e.g. `eigh_reference.py`).
- `DESCRIPTION.md`, `PROMPT.md`, `REFERENCES.md` — moved verbatim.
- `run-candidate.ts` — physically moves to `benchmarks/<tool>/run-candidate.ts`
  in the corpus. The adapter TOML's `args` field is updated from
  `${WORKBENCH_ROOT}/bench/<tool>/run-candidate.ts` to
  `${CORPUS_ROOT}/benchmarks/<tool>/run-candidate.ts`. This removes the only
  corpus artefact that required `${WORKBENCH_ROOT}` to reach into `bench/`.

The corpus also acquires a `manifest.toml` per bench (§4). The workbench's
`bench/` directories have no manifest today; the manifest is new, written
during migration.

`scripts/generate-goldens.ts` is **not** migrated. It walks
`tools/<name>/goldens.spec.ts` to write tool-side goldens into
`tools/<name>/goldens/` — it does not touch `bench/<tool>/golden/`. Bench
corpora are regenerated via `generate.py` (SciPy / LAPACK oracle) or the
corpus's `generate_cmd` entry. The two paths are distinct; `generate-goldens.ts`
stays in the workbench.

### 2. What stays

Substrate tests remain in the workbench unconditionally:

- `packages/*/test/*.test.ts` — package-level property tests; run by `bun test`
  (phase 4 of `scripts/check.ts`).
- `tools/*/tool.ts --test` hooks — per-tool self-tests via the `test:` key in
  `defineTool`; run by phase 5.
- `tools/*/goldens/` — tool-side golden files from `scripts/generate-goldens.ts`
  / `goldens.spec.ts`; run by the oracle at phase 6 (`goldens_dir = join(TOOLS,
  e.name, "goldens")` — the tool-side dir, not `bench/<tool>/golden`). These
  are small (tens of KB per tool) and test the value-protocol contract, not the
  bench's full input battery.
- `scripts/check.ts` phases 1-6, `tools/oracle/` source, and the
  `bench/_corpus/` / `bench/infra/` non-tool directories — all stay.

### 3. Migration unit and first batch

The linalg trio (`linalg-qr`, `linalg-svd`, `linalg-eigh`) ports as the
first batch. The corpus already has a working `linalg-eigh` tracer that
establishes the pattern — the manifest, adapter, and `verify.ts` are in place
and graded at 46/46. Porting `linalg-qr` and `linalg-svd` follows the same
template with different case counts (49 each). The three tools share a
numerical-tier profile and a verifier shape, so they can be reviewed as a
unit.

After the linalg trio lands in the corpus and is confirmed grading at 100%,
the work pauses for reassessment: does the migration checklist need
adjustment? Is the adapter pattern right for the ODE trio? Only then does the
next batch proceed. The ODE trio (`integrate-ode-ivp`, `integrate-ode-stiff`,
`integrate-ode-symplectic`) is the natural second batch; the three share a
trajectory-I/O verifier shape.

Per-tool migration checklist for each tool in a batch:

1. Create `benchmarks/<tool>/` in the corpus. Copy `bench/<tool>/golden/`
   verbatim (all files). Write `manifest.toml` (§4 below). Copy
   `DESCRIPTION.md`, `REFERENCES.md`, `PROMPT.md`. Copy `reference/`.
2. Port `golden/verify.py` to `golden/verify.ts`. The corpus's default
   verifier is TS-on-Bun; `verify.py` is preserved as an escape hatch but is
   not the primary verifier. For the linalg trio, `linalg-eigh/golden/verify.ts`
   in the corpus is the template.
3. Move `run-candidate.ts` from `bench/<tool>/run-candidate.ts` to
   `benchmarks/<tool>/run-candidate.ts` in the corpus. Update imports if
   needed (the `loadWorkbench()` path requires `${WORKBENCH_ROOT}` available
   as a resolved absolute path at run time; the adapter TOML sets `cwd =
   "${WORKBENCH_ROOT}"`).
4. Write `adapters/scientist-workbench/<tool>.toml` in the corpus. Pin the
   git SHA of the workbench at migration time (field `version = "git@<sha>"`).
   Set `platform_pinned = true` for numerical-tier tools.
5. Run `bun src/cli.ts validate` in the corpus — schema check on the new
   TOML files.
6. Run `bun src/cli.ts grade scientist-workbench <tool>` from the corpus.
   Expect 100% pass on first run. If any case fails, investigate before
   closing the migration bead; do not mark the migration done with failures.
7. Delete `bench/<tool>/` from the workbench. Commit the deletion after the
   corpus commit is clean.
8. Update the tool's `tools/<tool>/README.md` to add a pointer to
   `../scientist-workbench-corpus/benchmarks/<tool>/` for the bench corpus
   location.

### 4. Schema reconciliation: TOML manifest as the corpus convention

The workbench's `bench/<tool>/` directories have **no manifest file** today.
There is no `manifest.json` or `manifest.toml` in any workbench bench
directory (confirmed by `find bench -name "manifest*"` returning no output).
What the corpus calls `manifest.toml` is a new artefact, written during
migration by reading the structure from the existing corpus exemplar
(`benchmarks/linalg-eigh/manifest.toml`).

The corpus's `manifest.toml` structure is:

```toml
[meta]
name        = "<tool>"
domain      = "<domain>"
description = """..."""
ported_from = "scientist-workbench/bench/<tool>@<sha>"

[verifier]
kind = "bun"
cmd  = "bun"
args = ["run", "${SUITE_ROOT}/golden/verify.ts"]

[[verifier.checks]]
name        = "<check-name>"
description = "..."
tolerance_source = "..."

[golden]
inputs           = "golden/inputs.json"
inputs_sha256    = "<sha256>"
expected         = "golden/expected.json"
expected_sha256  = "<sha256>"
n_cases          = <N>
regenerated_at   = "<date>"
generate_cmd     = "python3 ${SUITE_ROOT}/golden/generate.py"
```

Three migration-time translation decisions:

- **Field naming.** The workbench's bench format has no canonical field names
  for manifest metadata (there is no manifest). The corpus's `[meta]`, `[verifier]`,
  and `[golden]` section names are adopted as-is.
- **Tolerance values.** Tolerance values embedded in `verify.py` (e.g.
  `100 * eps * n * sqrt(n)` for Q orthonormality) are preserved byte-identically
  when porting to `verify.ts`. Do not tighten or loosen during migration;
  file a separate bead if a tolerance is wrong.
- **SHA-256 pinning.** The corpus pins `inputs_sha256` and `expected_sha256`
  against the golden files as they exist at migration time. If the golden files
  are regenerated post-migration, the hashes in the manifest must be updated.
  The migration checklist step 1 records the SHA at copy time.

### 5. Oracle indirection post-migration

The workbench's `tools/oracle/tool.ts` takes `goldens_dir: str(path)` as an
input field. Post-migration, this field continues to point to the tool-side
goldens at `tools/<name>/goldens/` for `scripts/check.ts`'s oracle phase;
that path is unaffected.

For a developer who wants to run the oracle *against the bench corpus* (e.g.
to verify that the workbench's tool still agrees with the corpus's
`inputs.json` / `expected.json` on a given build), the invocation becomes:

```sh
# From the workbench root:
bun tools/oracle/tool.ts <<'EOF'
{"kind":"record","fields":{
  "tool_path":{"kind":"string","value":"tools/linalg-eigh/tool.ts"},
  "goldens_dir":{"kind":"string","value":"../scientist-workbench-corpus/benchmarks/linalg-eigh/golden"}
}}
EOF
```

This is legal — `goldens_dir` is a plain filesystem path and the oracle
follows it cross-repo. The oracle source needs no changes; only the caller's
`goldens_dir` argument changes.

**Recommended convenience shim:** add `scripts/bench-grade.sh <tool>` that
resolves `CORPUS_ROOT` relative to the workbench root and invokes the corpus
grader:

```sh
#!/usr/bin/env bash
set -euo pipefail
CORPUS_ROOT="$(cd "$(dirname "$0")/../scientist-workbench-corpus" && pwd)"
exec bun "$CORPUS_ROOT/src/cli.ts" grade scientist-workbench "$1"
```

Do **not** introduce an `env WORKBENCH_CORPUS_PATH` sentinel. The side-by-side
convention is already established by the corpus adapter TOML's `${WORKBENCH_ROOT}`
reference; the shim makes it executable without a global env var.

### 6. Reproducibility contract for developers

A workbench-only checkout passes `bun run check` in full — `scripts/check.ts`'s
oracle phase walks `tools/<name>/goldens/`, not `bench/<tool>/golden/`. After
migration those bench directories are gone and `scripts/check.ts` is unaffected.

Full bench grading requires both repos checked out side-by-side:

```sh
cd ~/Projects
git clone git@github.com:tobiasosborne/scientist-workbench.git
git clone git@github.com:tobiasosborne/scientist-workbench-corpus.git
cd scientist-workbench-corpus
bun install
bun src/cli.ts grade scientist-workbench linalg-eigh  # etc.
```

**This is a genuine friction point.** A developer wanting a full bench run on a
fresh machine must clone two repos. The friction is accepted: bench corpora are
implementer infrastructure, not consumer-agent infrastructure; the alternative
(keeping 182 MB of goldens in the workbench) costs every clone, every
`git status`, every diff. The `scripts/bench-grade.sh` shim (§5) makes
the two-repo invocation mechanical once both are checked out.

## Consequences

### Positive

- **Repo size drops ~42%.** The dominant golden blobs (`linalg-svd`: 87 MB,
  `linalg-qr`: 76 MB) leave the workbench repo. `git clone` time,
  `git status` scan time, and diff rendering costs drop proportionally.
- **Consumer-agent landings are cleaner.** An agent landing in the workbench
  to invoke tools sees tool sources, packages, tests, and scripts. It does not
  see `bench/linalg-svd/golden/inputs.json` (6,000 lines of JSON matrix
  inputs). The repo's cognitive footprint narrows to its actual job.
- **Corpus gains its design purpose.** The `scientist-workbench-corpus` was
  designed as both planning backlog and grading harness. Migrating the bench
  corpora makes it a living grader, not a one-benchmark demo. The corpus's
  DuckDB scoreboard becomes meaningful across 14 tools rather than 1.
- **Cross-implementation grading is unlocked.** The corpus's adapter model
  means any other implementation of `linalg-eigh` can be graded against the
  same corpus by writing a new adapter TOML. The workbench's bench model
  (verifier tightly coupled to `run-candidate.ts`) did not support this.

### Negative

- **End-to-end grading requires two repos.** A developer who wants to run the
  full bench suite must have both repos checked out. This is documented as a
  friction point (§6); the `scripts/bench-grade.sh` shim mitigates the
  mechanics.
- **Cross-repo tool README links.** After migration, `tools/<tool>/README.md`
  links to `../scientist-workbench-corpus/benchmarks/<tool>/` for the bench
  location. This is a relative path that breaks if either repo is moved. The
  side-by-side layout is a documented convention; deviation from it is
  developer error, not a system fault. A future ADR can introduce a stable URL
  (GitHub permalink) if the relative-path convention proves fragile in
  practice.
- **`run-candidate.ts` lives in the corpus, not the workbench.** Post-
  migration, the adapter script is in the corpus repo. A developer changing
  the tool's wire protocol must also update `run-candidate.ts` in the corpus.
  This is a two-repo change; worklog shards must document both. The
  alternative (keeping `run-candidate.ts` in the workbench and referencing it
  from the corpus adapter) was considered and rejected: it requires
  `${WORKBENCH_ROOT}` to be resolvable from every corpus grading invocation,
  and it means the corpus cannot be graded standalone. The corpus ownership
  of the adapter is cleaner.

### Migration scope tracking: child beads

File 14 child beads under epic `scientist-workbench-spup`, one per workbench
bench tool. Suggested bead names and the current bench sizes (golden
directory, for triage priority):

| Bead name (proposed) | Tool | Golden size | Batch |
|---|---|---|---|
| `spup-qr`  | `linalg-qr`           |  76 MB | 1 (linalg trio) |
| `spup-svd` | `linalg-svd`          |  87 MB | 1 (linalg trio) |
| `spup-eigh`| `linalg-eigh`         |  16 MB | 1 (already corpus-traced — confirm adapter update only) |
| `spup-ode1`| `integrate-ode-ivp`   |  92 KB | 2 (ODE trio) |
| `spup-ode2`| `integrate-ode-stiff` |  56 KB | 2 (ODE trio) |
| `spup-ode3`| `integrate-ode-symplectic` | 1.7 MB | 2 (ODE trio) |
| `spup-lsq` | `linsolve-q`          | 220 KB | 3 |
| `spup-pfq` | `hypergeometric-pfq`  | 104 KB | 3 |
| `spup-mg`  | `meijer-g`            | 172 KB | 3 |
| `spup-sol` | `solve`               | 152 KB | 3 |
| `spup-alg` | `alg-num-arith`       | 108 KB | 3 |
| `spup-pf`  | `poly-factor-q`       | 124 KB | 3 |
| `spup-pr`  | `poly-roots-radical`  |  72 KB | 3 |
| `spup-rri` | `real-root-isolate`   |  72 KB | 3 |

Note: `bench/linalg-eigh` is the tracer — the corpus-side artefacts already
exist. `spup-eigh` should confirm that the existing corpus adapter still grades
100% at the current workbench HEAD before the linalg-qr and linalg-svd ports
begin; it closes as soon as that is confirmed and the workbench-side `bench/linalg-eigh/`
is deleted.

`bench/_corpus/` and `bench/infra/` are excluded — they are not tool bench
corpora. Assess whether they can be deleted after the tool benches are gone;
no separate beads are filed for them here.

## Pointers

- `docs/adr/0019-solve-bench-discipline.md` — the verifier protocol that
  bench corpora implement. The invariants and tolerance conventions in that
  ADR carry into the corpus verifiers.
- `../scientist-workbench-corpus/README.md` — corpus layout, pipeline,
  roadmap (the "Wholesale migration" line).
- `../scientist-workbench-corpus/HANDOFF.md` §1 — concrete per-bench
  migration list as of 2026-05-06.
- `../scientist-workbench-corpus/benchmarks/linalg-eigh/` — the working
  tracer. `manifest.toml` is the template for every new bench manifest.
- `../scientist-workbench-corpus/adapters/scientist-workbench/linalg-eigh.toml`
  — the adapter template. `${WORKBENCH_ROOT}` and `platform_pinned = true`
  are the key fields to replicate for numerical-tier tools.
- Closed bead `scientist-workbench-rll` — the session that endorsed this
  migration and produced the corpus tracer; closing commit records the
  decision.
- `scripts/check.ts` lines 164-240 — the per-tool `--test` and oracle loops
  that define phases 5-6; confirms they walk `tools/<name>/goldens/`, not
  `bench/<tool>/golden/`.
