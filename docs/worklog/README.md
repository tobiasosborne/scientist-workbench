# Worklog

A sharded log of substantive work on `scientist-workbench`. One shard per
discrete iteration; each is self-contained so a reader landing cold on a
shard understands what changed and why.

The point is **continuity**: future-you, future agents, and future
collaborators reach for the worklog when "git blame says I changed this
line, but why?" That's what these shards are for. Keep them honest —
write the frictions and the dead ends as well as the wins.

| #   | Title                                                                     | Date       | Issues                          |
|-----|---------------------------------------------------------------------------|------------|---------------------------------|
| 001 | [NTT port from tstournament 02-NTT](001-ntt-port-from-tstournament.md)    | 2026-04-28 | (port; surfaced 9 frictions)    |
| 002 | [F1+F2 — subprocess plumbing centralised](002-spawn-machinery.md)         | 2026-04-28 | scientist-workbench-rpb.1       |
| 003 | [F3 — scaffolder accepts `--uses`](003-scaffolder-uses.md)                | 2026-04-28 | scientist-workbench-rpb.2       |
| 004 | [F8 — schema `kindOf` annotations](004-schema-kind-annotations.md)        | 2026-04-28 | scientist-workbench-rpb.7       |
| 005 | [F7 — `@workbench/json-bridge` package](005-json-bridge.md)               | 2026-04-28 | scientist-workbench-rpb.6       |
| 006 | [F5 — output error patterns + mod-inv migration](006-error-patterns.md)   | 2026-04-28 | scientist-workbench-rpb.4       |
| 007 | [F6 + F4 + F9 — lint, example-count, TDD shapes](007-conventions-and-docs.md) | 2026-04-28 | scientist-workbench-rpb.{5,3,8} |
| 008 | [Schema as a first-class type](008-schema-as-first-class-type.md)         | 2026-04-28 | scientist-workbench-{ktd,73m,7q0,1d9} |
| 009 | [Sturm-TS port: planning shard](009-sturm-ts-port-planning.md)            | 2026-04-29 | scientist-workbench-{i8m,x9x,cdz,0lo,dwg,z8w,tkx,564,kw1,bir,q0b,733,8e8,o1q,can} (planned) |

## How to add a new shard

1. Pick the next number (`00N-<short-slug>.md`).
2. Use the structure: **Context → What changed → Why these choices →
   Frictions surfaced → Acceptance → Pointers**.
3. Aim for ~200 lines. Prose-dominant, code blocks for diff highlights only.
4. Add a row to the table above.
5. If the shard introduces an architectural decision, file a paired ADR
   under `docs/adr/` and reference it.

## Cross-references

- ADRs: `docs/adr/`
- Issue tracker: `bd list --status open` (beads, stealth-installed)
- Memory (cross-session): `~/.claude/projects/.../memory/`
- Agent guidance: `CLAUDE.md` at repo root
