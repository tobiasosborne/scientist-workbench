# 006 — F5: tool output error patterns + mod-inv migration

**Date:** 2026-04-28
**Status:** complete
**Issues:** scientist-workbench-rpb.4 (closed)
**ADR:** [docs/adr/0003-tool-output-error-patterns.md](../adr/0003-tool-output-error-patterns.md)

## Context

A tool's output can be one of three things, depending on the situation:

1. **Happy path** — the canonical success result.
2. **Routine non-success** — the tool ran to completion on a valid
   input; the answer is "no, it's not what you expected." Examples:
   `cas-verify` decides `lhs ≠ rhs`; `mod-inv` finds `gcd(value, modulus) > 1`
   and concludes no inverse exists; a hypothetical `solve-poly` finds
   no rational root.
3. **Boundary failure** — the input is outside the tool's declared
   scope, or the tool refuses for structural reasons. `cas-simplify`
   encountering an unknown head (`sin`, `cos`); a hypothetical
   `ntt-modulus-X` receiving a different modulus.

Until this iteration, the workbench had no rule. Two tools, two
patterns:

- `mod-inv` returned `tagged "mod-inv/no-inverse"` with a payload of
  `{ gcd, modulus, value }` for case 2.
- `cas-verify` returned `record { equal: bool, reason?, witness?, ... }`
  for case 2.

Downstream consumers had to dispatch differently for every tool. This
fanned out the cost of "compose a pipeline" — every consumer needed
per-tool knowledge of where the success/failure flag lived.

## What changed

ADR-0003 codifies the convention. Three categories, three shapes:

**Happy path.** Whatever the tool naturally produces. No flag, no tag.
`ntt → list<integer>`; `mod-pow → integer`; `expr-parse → expression`.

**Routine non-success ⇒ record-with-flag.** When the tool ran to
completion but the answer is "this routine produced a non-result":

```ts
record {
  <flag-field>: boolean,            // load-bearing yes/no
  <result-field>?: <Value>,         // present iff flag=true
  <diagnostic-fields>?: <Value>,    // structured per tool
}
```

The flag-field name is *domain-specific*: `equal` for `cas-verify`,
`invertible` for `mod-inv`, `solvable` for a hypothetical solver. Use
the word that reads as the tool's question. Prefer `boolean` over a
string status (strings invite typos).

**Boundary failure ⇒ tagged out-of-scope.** When the input is outside
the tool's declared scope, wrap the offending substructure in
`tagged "<tool>/<reason-class>"`. This is the existing
foreign-pass-through invariant (PRD §2.3) — `cas-simplify` established
the pattern with `tagged "cas-simplify/out-of-scope" <subterm>`. The
ADR codifies: tag string carries `<tool-name>/<reason-class>`; payload
carries the offending sub-value, recursively simplified where the rest
of the tool is still able to.

**`ToolError` (process exit 1) is reserved** for *malformed* inputs:
non-record where a record was needed, missing fields, wrong field
kinds, modulus < 1. Those aren't routine outcomes — they're
refusal-to-engage.

The distinguishing test: did the algorithm run to completion on a
*valid* input? If yes, category 2 (record-with-flag). If the input
itself was malformed or out-of-scope, category 3 (tagged) or
ToolError respectively.

### Migration: `mod-inv`

`mod-inv` was previously category 3 for what is genuinely category 2
content. The algorithm runs (extended Euclid) on perfectly valid
input (two integers); it arrives at gcd=3, decides no inverse exists.
That's not a boundary failure; that's a definite answer.

Before:

```
no inverse → tagged "mod-inv/no-inverse"
                    record { gcd, modulus, value }
```

After:

```
always     → record {
               invertible: boolean,
               inverse?:   integer,   // present iff invertible=true
               gcd:        integer,   // always present (= 1 iff invertible)
             }
```

Tool version bumped 0.1.0 → 0.2.0. Examples updated, README rewritten,
goldens regenerated (32 of them). The `NO_INVERSE_TAG` export was
removed. The `--test` hook now asserts the invariant
`if invertible=true, (value · inverse) mod modulus = 1`; if
`invertible=false`, `gcd > 1` and the `inverse` field is absent.

## Why these choices

**Three categories, not two.** We considered "always record-with-flag,
no tagged" — uniformity by force. Rejected because:

- foreign-pass-through is a pre-existing protocol invariant from PRD
  §2.3. Tagged values *are* the protocol's escape hatch for
  out-of-scope sub-terms, and that's the semantics they should carry.
- A boundary failure is genuinely different from a routine
  non-success: the tool didn't run on the offending input, it
  refused. Conflating the two muddles intent.

**Domain-specific flag names, not a uniform `ok`.** We considered
`record { ok: bool, ... }` everywhere. Rejected because:

- The domain word reads better at call-sites:
  `if (out.fields.equal.value)` is clearer than
  `if (out.fields.ok.value && out.tag === "verify-equal")`.
- The verb-question alignment is honest about what the tool decides.

**`inverse?` not present in the no-inverse branch.** We considered
emitting `inverse: int(0n)` always, with `invertible` as the gate.
Rejected: the optional-field shape is already in the protocol's
record kind, and "absent field" is a stronger statement than "0
field" — a consumer that reads `inverse` without checking
`invertible` first will get an exception, not a silently wrong
answer.

## Frictions surfaced

The migration revealed two minor things:

1. The schema `output: kindOf("integer")` set in shard 004 was wrong
   for the new shape — the output is now a record, not an integer.
   Updated to `record({ invertible: kindOf("boolean"), inverse:
   kindOf("integer"), gcd: kindOf("integer") })` (which slightly
   over-states: the `inverse` field is conditional, but the schema
   names the shape of the success branch).

2. `NO_INVERSE_TAG` had been exported from the tool module. Removing
   it was clean (no callers in the workspace), but is exactly the
   kind of breaking removal the ADR wants visible — bumped the tool
   version 0.1.0 → 0.2.0 to mark.

## Acceptance

- 32 mod-inv goldens regenerated and re-checked via `oracle` — all
  green.
- mod-inv `--test` hook passes against the new shape.
- `bun run check` (14 phases) green.
- Tournament 02-NTT: 64/64 still green (no regression cross-package).

## Pointers

- ADR-0003 — three-category decision and the why-not-uniform-record
  rejection.
- `tools/mod-inv/tool.ts` — literate exposition of the migration.
- `tools/mod-inv/README.md` — agent-facing v0.2.0 contract.
- `CLAUDE.md` §Conventions — the one-question rule for picking a
  category.
