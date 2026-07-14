# The tool contract & writing a new tool

> **Tier 3 reference.** This is the author-facing reference: the
> seven-artefact contract, how to scaffold and write a new tool, the hard
> requirements, and how to verify. Reach it from the discovery CLI:
> `bun wb.ts contract`. The design rationale is canonical in `PRD-v0.2.md`;
> this file is the operational projection of it.

---

## The contract

A tool is admitted to the registry iff it ships **all seven** artefacts
(PRD §4.2):

1. The compiled tool. *MVP runs source via `bun tools/<name>/tool.ts`;
   `bun build --compile` deferred.*
2. `schema` declaration — a `Schema` describing input and output
   (ADR-0004). The legacy `kindOf("...")` annotation (ADR-0002) is the wire
   form for `S.kind`, preserved for transport.
3. `examples` — soft floor: **one example per code-path branch + edge
   cases**, ≥10 once the tool is "done." The literal count is a target, not
   a quota; if the tool's natural example surface is small, structure-driven
   coverage wins. ≥30 to call a tool "v1-complete." Every example's `input`
   and `output` must conform to the declared schema; the runner checks this
   at load time.
4. `invariants`.
5. Property tests in workspace `bun test`, OR a `--test` hook (PRD §4.3).
6. `goldens/` directory of `*.golden.json` files.
7. `README.md`.

Required fields of `ToolDefinition` (artefacts 2–4) are checked at the type
level — `defineTool({...})` infers `I` and `O` from the schema and threads
them into `fn`'s signature. Artefacts 5–7 are checked by `bun run check`. A
tool missing any of these is a prototype, not a tool.

A tool also carries an optional one-line `summary` (ADR-0043 Decision 2) —
the canonical catalog blurb. It is the source for the generated catalog row
and the per-tool README opening line. Authoring it explicitly is preferred.

**Goldens are folded from examples (ADR-0043 / issue `ixnv.3`).** Artefact 6
— the `goldens/` directory — is *generated*, not hand-maintained: `bun run
goldens` (`scripts/generate-goldens.ts`) walks the registry and folds every
tool's `def.examples` into `tools/<name>/goldens/*.golden.json`. An example
carrying an asserted `output` becomes a golden whose declared output is
*verified* against a live run (a disagreement fails the generator loudly — a
real correctness check, not a snapshot); an example with `output` omitted is
snapshotted; an example expecting an `error`, and every example of a
`nondeterministic: true` tool, are excluded (a golden is a successful,
byte-stable run). A hand-authored `tools/<name>/goldens.spec.ts` (`export
const goldens: GoldenSpec[]`) is now **optional and supplementary** — write
one only to exercise extra inputs *beyond* the examples; an empty or absent
`goldens.spec.ts` is valid. `scripts/check.ts` regenerates the goldens with
`--check` and byte-compares against the committed files, so stale goldens
fail `bun run check` exactly as a stale typed barrel does. In practice this
means the seven-artefact contract has one fewer hand-maintained file: write
the examples in `tool.ts`, and the goldens follow.

---

## Writing a new tool

```sh
bun run new-tool <name> [--uses pkg1,pkg2,...]
                                  # scaffolds tools/<name>/ and runs `bun install`.
                                  # --uses adds workspace packages (under packages/<pkg>) as deps.
# edit tool.ts          (literate template — expand the prose, fill schema/fn/examples/invariants)
#                       (the examples array IS the golden source — ADR-0043 / ixnv.3)
# (optional) edit goldens.spec.ts  (supplementary GoldenSpec entries beyond the examples)
bun run goldens                    # fold examples into canonical *.golden.json files
bun run check                      # typecheck + workspace tests + per-tool --test + oracle on goldens
```

Examples:

```sh
bun run new-tool cas-reduce  --uses cas-core
bun run new-tool ntt         --uses mod-core
bun run new-tool geom-orient --uses geom-predicates,float-utils   # multiple substrate packages
```

The `tool.ts` skeleton calls `defineTool({...})` from `@workbench/contract`
and then runs it via `runTool(def)`. The dispatcher call is gated on
`import.meta.main` (ADR-0010) so importing the module yields the live `def`
without spawning a subprocess or consuming stdin. The trailing line of every
tool reads:

```ts
export const def = defineTool({...});
if (import.meta.main) void runTool(def);
```

The runner handles every standard flag, parses stdin, validates against the
schema, runs your `fn`, validates the output, emits canonical bytes, and
writes provenance. `runTool(def, io?)` accepts an optional `RunIO` that
overrides any subset of `argv`/`stdin`/`stdout`/`stderr`/`exit`/`env`, so
the dispatcher is exercisable from `bun test` without a child process. Treat
the file as **literate** (per `CLAUDE.md`): the comments at the top are a
chapter introducing the tool's intent, with prose explaining the algorithm,
references, invariants, and out-of-scope decisions. The implementation file
*is* its own primary documentation.

---

## Hard requirements for any new tool

- **Determinism.** Same input bytes + same tool version ⟹ bit-identical
  output bytes. No `Date.now`, no `Math.random` without seed input, no
  iteration over unsorted hash sets, no locale or environment dependence.
  Property tested in workspace tests. Tools that genuinely need randomness
  (sampling, hardware execution) admit it as a typed `entropy` field in the
  input record and remain deterministic *given* those bytes; the one
  privileged exception is `entropy-source`, which carries the manifest
  annotation `nondeterministic: true` (ADR-0005). Tools annotated `arbprec:
  true` (ADR-0020) are bit-identical *cross-platform, forever* given an
  explicit `--precision=<int>` flag — `BigInt` arithmetic is bit-identical
  across runtimes by language specification. Tools annotated `numerical:
  true` (ADR-0015) are bit-identical *given the platform fingerprint*
  `{arch, os, runtime}`; cross-platform divergence is recorded in the
  provenance record's optional `platform` field and surfaces as a
  `runMemoized` cache miss when the platforms differ. The four annotations
  (default = symbolic, `arbprec: true`, `numerical: true`,
  `nondeterministic: true`) are mutually exclusive — `executeToolDef`
  rejects a definition that declares more than one. Cross-tier tools
  (float64 + arb-prec lanes dispatched by `--precision`) declare
  `arbprec: true` only and wrap float64-lane results in 53-bit BigFloat,
  forgoing the `platform` fingerprint on that lane (ADR-0040 §Decision 9
  amendment). See
  `docs/adr/0005-externalised-entropy.md`,
  `docs/adr/0015-determinism-tier.md`, and
  `docs/adr/0020-arbitrary-precision-tier.md`.
- **Idempotence (where the operation allows).** `f(f(v)) = f(v)`. Tested
  per tool.
- **Foreign-pass-through.** Subtrees outside your declared scope must
  round-trip verbatim (or be wrapped in a `tagged` value with your tool's
  name in the tag). Property tested.
- **Honest scope.** A tool that fails on inputs outside its declared scope
  is correct. A tool that lies (silently produces a wrong-shaped or
  wrong-valued answer) is not — and is inadmissible.
- **Errors that teach.** Use `ToolError` from `@workbench/protocol` with
  `suggestion` and `detail` fields. Errors carry a path through the value
  tree where possible.
- **Cold start < 100 ms.** The MVP measures ~50 ms on Bun including stdin
  and canonicalisation. If your tool is slower, justify why.
- **Few flags, all orthogonal.** One to five flags. Flags that change the
  *type* of the output should be different tools.

PRD §6.1 ("Properties of a tool an agent will reach for") is not a soft
preferences list — it is a hard requirement list. A tool that fails any of
these is broken even if it computes the right answer.

---

## Verification

```sh
bun run check         # full: typecheck + bun test + every tool --test + oracle on every goldens/
bun run check:quick   # fast: typecheck + bun test only (~3s; for the inner edit loop)
bun run goldens       # regenerate goldens (replaces existing files)
bun run goldens:check # fail if any current tool output disagrees with a stored golden
```

Failing the check is failing the contract.

`bun run check` covers substrate tests and tool-side goldens only. Full
bench grading (the corpus of 182 MB golden inputs across 14 tools) lives in
the `scientist-workbench-corpus` sister repo; see ADR-0028 for the migration
plan and `scripts/bench-grade.sh <tool>` for the convenience shim.

---

## The catalog

The top-level tool catalog is a **generated** artefact (ADR-0043). It lives
at `docs/CATALOG.md`, between `AUTOGENERATED:catalog` markers, regenerated
by `bun scripts/gen-catalog.ts` from each tool's `def.name` / `def.summary`.
`scripts/check.ts` regenerates it and byte-compares — a stale catalog fails
`bun run check`. Do not hand-edit it.

The discovery CLI `bun wb.ts` (no args) lists the same tools directly from
the live registry, so the catalog file and the CLI never diverge.
