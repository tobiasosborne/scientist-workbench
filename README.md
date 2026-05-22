# scientist-workbench

Agent-first ecosystem of small, contract-conforming tools for exact symbolic
computation. License: **AGPL-3.0-or-later** (see `LICENSE`).

> **You are an agent landing in this repo. This file is Tier 0 — read it
> once, then discover everything else with `bun wb.ts`.**

## What a tool is

A tool reads **one JSON value on stdin** and writes **one JSON value on
stdout**. It runs in milliseconds, is independently versioned, and is
deterministic — same input bytes ⟹ same output bytes. Invoke and compose by
piping:

```sh
echo '{"kind":"string","value":"(x+1)*(x-1)"}' \
  | bun tools/expr-parse/tool.ts \
  | bun tools/cas-simplify/tool.ts
```

Errors go to stderr with a non-zero exit and a `suggestion` line.

## The one hard fact before your first call

The wire format is a strict JSON subset (the *value protocol*):

- **No raw JSON numbers.** Every numeric lives inside an `integer` /
  `rational` / `float64` value whose number-bearing fields are *strings*.
  `{"value":1}` is invalid — write `{"value":"1"}`.
- **`null` is reserved and never emitted.** Use absent optional fields or a
  `tagged` value for "no result".
- Object keys are sorted; there is no whitespace.

## Discover everything else

```sh
bun wb.ts                  # Tier 1 — list every tool (name + one-line summary)
bun wb.ts <tool>           # Tier 2 — that tool's schema, examples, invariants
bun wb.ts search …         # Tier 2 — find tools by type (--consumes / --produces / …)
bun wb.ts protocol         # Tier 3 — the value protocol, schema language, invocation
bun wb.ts contract         # Tier 3 — the seven-artefact contract; writing a tool
```

`bun wb.ts` reads the live tool registry, so it never drifts. That, plus the
two facts above, is enough to go from zero knowledge to a correct first
invocation.

## Substrate & verification

TypeScript on Bun (1.3+), no build step. `bun install` once, then `bun run
check` for the full health check (~25s) or `bun run check:quick` for the
fast inner loop. On a fresh clone run `sh scripts/setup-device.sh` once
(tracked git hooks + non-destructive beads bootstrap).

## Pointers

- **Design spec (canonical):** `PRD-v0.2.md`.
- **Generated tool catalog:** `docs/CATALOG.md` (or `bun wb.ts`).
- **Value protocol & schema language:** `docs/protocol.md` (or `bun wb.ts
  protocol`).
- **The contract & writing a tool:** `docs/contract.md` (or `bun wb.ts
  contract`).
- **File layout, install corners, scope boundary:** `docs/repo-map.md`.
- **Per-tool detail:** `tools/<name>/README.md`.
- **Architecture decisions:** `docs/adr/`. **Worklog:** `docs/worklog/`.
- **Agent guidance:** `CLAUDE.md`.
