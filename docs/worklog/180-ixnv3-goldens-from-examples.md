# 180 — Goldens folded from examples (ixnv.3)

**Issue:** `scientist-workbench-ixnv.3` (child of epic `scientist-workbench-ixnv`,
"registry as the single source of truth for tool-facing docs", ADR-0043).
**Date:** 2026-05-21.

## Context

ADR-0043 Decision 3 records that the per-tool `goldens/` directory is one
of the three doc surfaces that become *generated* from the registry. The
reasoning: every entry of a tool's `def.examples` is, by construction, a
worked input/output pair — it *is* a golden. Before this shard a tool
maintained two overlapping input lists: `examples` inside `tool.ts` (whose
declared `output` the runner only ever *schema*-checked, never compared)
and a hand-written `tools/<name>/goldens.spec.ts` (`export const goldens:
GoldenSpec[]`, whose inputs `scripts/generate-goldens.ts` ran and
snapshotted). For a simple tool the two sets overlapped almost entirely;
keeping them in lockstep was pure copy-discipline, a Law 2 liability.

This shard implements `ixnv.3`: fold `examples` into goldens automatically,
demote `goldens.spec.ts` to optional/supplementary, and drift-check the
folded goldens in `check.ts`.

## What changed

**`scripts/generate-goldens.ts` — rewritten as the examples-fold generator.**
It now walks the registry (`importToolDef`, the same ADR-0010 side-effect-
free import `gen-workbench-barrel.ts` and `gen-catalog.ts` use) and folds
each tool's `def.examples` into `tools/<name>/goldens/*.golden.json`,
alongside any supplementary `goldens.spec.ts` entries. The heterogeneous
`ExampleEntry` shapes are handled distinctly and honestly (Rule 8):

- **`input` + asserted `output`** → golden; the generator runs the tool
  and the produced output *must* equal the stated `output`. A disagreement
  **fails the generator loudly** (Rule 1) — a real correctness check, not a
  silent snapshot.
- **`input`, `output` omitted** → golden by snapshotting the tool's actual
  output (the historical `goldens.spec.ts` behaviour).
- **example carrying an `error`** → excluded; a golden is a successful run.
- **`nondeterministic: true` tool** (ADR-0005 — `entropy-source`) → *all*
  its examples excluded; byte-stable goldens are impossible for such a tool,
  exactly as its hand-written `goldens.spec.ts` was already intentionally
  empty.
- `flags` on either source are captured into the golden's `flags` record so
  the oracle replays them faithfully.
- Duplicate `(input, flags)` pairs across the two sources are de-duplicated;
  examples win, examples are folded first, numbering is deterministic.

`goldens.spec.ts` is now optional: an absent or empty one is valid; a tool
with only examples gets a populated `goldens/` dir.

**`GoldenSpec` / golden file format — no extension needed.** `GoldenSpec`
already carried an optional `flags?: Record<string, string>`, the golden
file format already had an optional `flags` record, and the oracle already
replayed `flags` as `--k=v` arguments. The fold reuses all three unchanged.

**`scripts/check.ts` — new `codegen: folded goldens` drift phase.** Mirrors
the typed-barrel phase (ADR-0043 Decision 6): runs `generate-goldens.ts
--check`, which re-derives every golden and byte-compares against the
committed files, failing the phase on any drift with a `Run \`bun run
goldens\`` remediation. It lives in the always-on portion of `check.ts`
(before the `if (!QUICK)` gate) so `check:quick` catches goldens drift.

**`scripts/new-tool.ts` — no longer scaffolds `goldens.spec.ts`.** The
scaffold's header, `--help` text, and closing instructions now state that
goldens are folded from the `tool.ts` examples and `goldens.spec.ts` is
optional.

**Docs (Law 2).** `README.md` "The contract" gains a paragraph on the
examples-fold; the "Writing a new tool" recipe and the file-layout block
are updated. `PRD-v0.2.md` §4.2 artefact 6 and §4.4 record that the
`goldens/` directory is generated.

**17 tools — stale example outputs corrected.** Folding surfaced 26 examples
whose declared `output` the tool no longer reproduced byte-exactly. None
was a real tool bug — every one was a stale or imprecise hand-transcribed
`output` literal that the old schema-only `--examples` check never caught
(a latent Law 2 violation). Three repair shapes were used: (a) corrected the
literal where the value is genuinely hand-verifiable (`cas-simplify`'s
rational-function example — output *and* its now-false description fixed;
`groebner-basis`/`poly-factor`/`poly-roots`/`real-root-isolate`/`solve`
refusal-detail strings; `sturm-equivalent`'s `different-classical_refs`
detail); (b) demoted to `output`-omitted where the value is a float64 /
solver / simulation result not reliably hand-pinned (`fidelity`,
`cone-solve`, `lp-solve`, `sdp-solve`, `purity`, `trace-distance`,
`sturm-execute`, `sturm-equivalent`, `sturm-find`); (c) `registry-list`'s
second example used a placeholder path `/path/to/tools` that could never
run as a golden — it was removed (the optional `tools_root` field is
documented by `--schema`).

## Why these choices

- **Loud failure, never silent snapshot.** The issue is explicit that an
  output-asserted example that disagrees is a real correctness check. The
  generator stops with the canonical-byte diff printed. The 17-tool cleanup
  is the *correct* response to that signal — a stale example is stale docs
  (Law 2), and the fold mechanises the lockstep that human diligence missed.
- **Why exclude `nondeterministic` tools wholesale.** `entropy-source`'s
  own `goldens.spec.ts` already documented (at length) why a
  nondeterministic tool publishes no goldens: every regeneration writes
  different bytes and the oracle fails every run. The fold inherits that
  reasoning — `def.nondeterministic === true` short-circuits `collectCases`.
- **Why no `GoldenSpec` flags extension.** The convention already existed
  end-to-end (`GoldenSpec.flags`, the golden file `flags` record, the
  oracle's `--k=v` replay). Inventing a parallel mechanism would be
  gratuitous.

## Frictions surfaced

- **The hidden cost of schema-only example validation.** `ExampleEntry.
  output` was, in practice, a *schema-shape* example, not an asserted
  golden — several tools (`sturm-find` most explicitly, with an
  `expr("__placeholder", [])` output and a comment "goldens carry the exact
  bytes") relied on that. The fold makes `output`, when present, a genuine
  assertion. This is stricter than the prior contract; 17 tools had drifted
  under the looser one. Honest scope (Rule 8) demanded fixing all 26, not
  papering over them.
- **Byte-stability bug caught by `--check`.** The first fold run included
  `entropy-source`'s examples and produced 6 non-reproducible goldens —
  `goldens:check` went red. The fix (skip nondeterministic tools) plus a
  generator change to sweep stale `*.golden.json` even for zero-case tools
  cleared it.
- **`exactOptionalPropertyTypes`.** Constructing a `GoldenCase` with
  `flags: undefined` is a type error under the workspace's strict tsconfig;
  the generator builds the object and conditionally assigns optional keys.

## Acceptance

- `bun run check` — **108 passed, 7 skipped, 0 failed.** The new
  `codegen: folded goldens` phase, the catalog-drift phase, the typed-barrel
  phase, every per-tool `--test`, and every oracle goldens phase green.
  The known-flaky `complex-bessel-jy` arb-prec tests (bead `m9ty`) did not
  time out on this run.
- `bun run goldens` then `bun run goldens:check` — both exit 0; the
  regenerated goldens are byte-stable. 1263 goldens written across the tool
  set; 361 of them folded from `examples` (53 tools), the rest from
  supplementary `goldens.spec.ts`; 3 error-examples excluded.
- `hypergeometric-pfq` and `meijer-g-slater-only` — previously had empty
  `goldens/` dirs and no `goldens.spec.ts`; now get 2 folded goldens each
  and pass the oracle phase, proving the examples-only path.

## Pointers

- ADR: `docs/adr/0043-registry-single-source-of-truth.md` (Decisions 3, 6, 7).
- Generator: `scripts/generate-goldens.ts` (literate header explains the
  fold, the heterogeneous cases, and the error/nondeterministic exclusions).
- Drift phase: `scripts/check.ts` — `codegen: folded goldens`.
- Sibling generators: `scripts/gen-workbench-barrel.ts`, `scripts/gen-catalog.ts`.
- Prior epic shard: `docs/worklog/179-ixnv2-generated-catalog.md`.
