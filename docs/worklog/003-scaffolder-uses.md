# 003 — F3: scaffolder accepts `--uses`

**Date:** 2026-04-28
**Status:** complete
**Issues:** scientist-workbench-rpb.2 (closed)

## Context

`scripts/new-tool.ts` was the workbench's tool-scaffolder. Run as
`bun scripts/new-tool.ts <name>`, it created `tools/<name>/` with a
package.json, a tool.ts skeleton, a README.md, a goldens.spec.ts, and an
empty goldens directory. The package.json declared the workspace
dependencies the new tool would need:

```json
{
  "dependencies": {
    "@workbench/protocol": "workspace:*",
    "@workbench/contract": "workspace:*"
  }
}
```

This was correct for tools whose entire content was protocol
construction — but every tool with substantive algorithmic content sits
on top of at least one workspace package. `cas-simplify` needs
`@workbench/cas-core`. The new `mod-pow` / `mod-inv` / `ntt` from
shard 001 each needed `@workbench/mod-core`. Before this fix the dance
was:

1. `bun scripts/new-tool.ts <name>`
2. open `tools/<name>/package.json`, add `"@workbench/<pkg>": "workspace:*"`
3. `bun install`
4. now you can finally `bun tools/<name>/tool.ts --version`

Three rote steps between "I want a new tool" and "it runs." Each one a
chance to mis-spell the package name and produce a half-broken tool
directory.

The friction was small per-instance and large in aggregate: every port
in the catalogue (FFT, LLL, Stoer-Wagner, blossom, Schreier-Sims,
Buchberger, …) will hit it.

## What changed

`scripts/new-tool.ts` now accepts `--uses pkg1,pkg2,...`:

```sh
bun run new-tool cas-reduce  --uses cas-core
bun run new-tool ntt         --uses mod-core
bun run new-tool geom-orient --uses geom-predicates,float-utils
```

Each named package is validated against `packages/<pkg>/package.json` —
the script reads the manifest, picks up the canonical `@workbench/<pkg>`
name from its `name` field, and writes that as the workspace dependency.
A typo (`--uses cas-cor`) fails loudly with exit 2 before any directory
is created, instead of producing a tool whose `bun install` later
silently does the wrong thing.

After scaffolding, the script auto-runs `bun install` (via `spawnBun`,
so it benefits from shard 002's resolver). The success message points
the developer at `bun tools/<name>/tool.ts --version` as the next
command, not "now run bun install."

The tool.ts skeleton was rewritten as a literate template: the comments
at the top form a multi-section "chapter" introducing the tool's
intent, with sections for **Intent**, **Input shape**, **Output shape**,
**Algorithm** — each with placeholder prose inviting expansion rather
than terse `// TODO` markers. This is the F3-adjacent shift: scaffolds
should embody the literate-programming convention from the first edit,
not require a later cleanup pass.

## Why these choices

**Validate against `packages/<pkg>/package.json`, not just directory
existence.** Reading the manifest catches the case where someone
renames a package's `name` field (canonical `@workbench/foo`) without
renaming the directory, and gives us the right dependency string for
the generated package.json. It also future-proofs against
reorganising the packages tree.

**Auto-run `bun install`.** The 4-second cost is paid by the
scaffolder, not the developer. The next thing the developer types is
the thing they actually want — running the tool — not a dependency
resolution.

**Literate template, not minimal.** The previous skeleton was honest
about being a skeleton (`// TODO: implement`). The new template is
honest about being literate-programming-by-default: the comments
contain prose-shaped placeholders that the implementor expands. This
inverts the gravitational pull: the easy thing is now writing prose,
not deferring it.

## Frictions surfaced

Two minor:

1. The literate template imports more helpers from
   `@workbench/protocol` than most tools will use (`bool`, `expr`,
   `int`, `list`, `rat`, `record`, `str`, `sym`, `tagged`, `ToolError`).
   The unused ones get `void` references in the `fn` body to silence
   TS. A future cleanup might trim per-tool, but the IDE-completion
   ergonomics of "all the helpers visible up front" outweigh the
   `void` smell.

2. `--uses` accepts a comma-separated list rather than repeated
   `--uses pkg1 --uses pkg2` flags. The single-flag form is shorter
   to type and matches what most CLIs do; the cost is one less
   "every flag is independently parseable" alignment with the rest of
   the workbench's tool flags. Acceptable for a script (not a tool).

## Acceptance

- `bun scripts/new-tool.ts test-scaffold --uses mod-core` succeeded;
  the generated package.json declared `@workbench/mod-core`,
  `bun install` resolved the workspace, the tool ran with `--version`.
- `bun scripts/new-tool.ts test-bad --uses nonexistent-pkg` failed
  with exit 2 and a clear message, no half-built directory.
- `tools/test-scaffold/` cleaned up after smoke testing.
- `bun run check` stays green.

## Pointers

- `scripts/new-tool.ts` — literate scaffolder source.
- main `README.md` §"Writing a new tool" — updated to show the
  `--uses` flag and document the literate-template expectation.
- `CLAUDE.md` — referenced as the source of the literate-programming
  convention the template embodies.
