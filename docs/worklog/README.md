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
| 010 | [ADR 0005: externalised entropy](010-externalised-entropy.md)             | 2026-04-29 | scientist-workbench-i8m         |
| 011 | [ADR 0006: IR-as-Value encoding](011-ir-as-value.md)                      | 2026-04-29 | scientist-workbench-x9x         |
| 012 | [ADR 0007: distribution-vs-sampling](012-distribution-vs-sampling.md)     | 2026-04-29 | scientist-workbench-cdz         |
| 013 | [Sturm-TS v3.1 spec amendment](013-sturm-ts-spec-v3-1.md)                 | 2026-04-29 | scientist-workbench-0lo         |
| 014 | [packages/sturm-ir](014-packages-sturm-ir.md)                             | 2026-04-29 | scientist-workbench-dwg         |
| 015 | [tools/sturm-simplify](015-sturm-simplify.md)                             | 2026-04-29 | scientist-workbench-z8w         |
| 016 | [cas-core ring-generic refactor](016-cas-core-ring-generic.md)            | 2026-04-29 | scientist-workbench-{but,t87}   |
| 017 | [cas-core algebraic numbers](017-cas-core-algebraic-numbers.md)           | 2026-04-29 | scientist-workbench-1s4         |
| 018 | [tools/sturm-execute (v0.1 float64)](018-sturm-execute.md)                | 2026-04-29 | scientist-workbench-tkx (jfj filed) |
| 019 | [tools/sturm-equivalent (Phase 1 killer demo)](019-sturm-equivalent.md)   | 2026-04-29 | scientist-workbench-564             |
| 020 | [tools/entropy-source (Phase 2 kick-off)](020-entropy-source.md)          | 2026-04-29 | scientist-workbench-kw1             |
| 021 | [tools/sturm-sample (Born's rule applied)](021-sturm-sample.md)           | 2026-04-29 | scientist-workbench-bir             |
| 022 | [Sturm-TS v3 spec absorbed; §8.1 H verified buggy](022-spec-v3-absorption-and-h-verification.md) | 2026-04-29 | scientist-workbench-{4xk closed; 1td, r40, 4iw filed} |
| 023 | [Channel combinators (sturm-controlled, sturm-then, sturm-tensor)](023-channel-combinators.md) | 2026-04-29 | scientist-workbench-o1q             |

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
