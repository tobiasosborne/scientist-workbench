# 121 — coherent-control restrictions: ADR-0038 closes r40

**Date:** 2026-05-15
**Bead:** `scientist-workbench-r40` (closes); `scientist-workbench-q0b`
(updated with the tracer-side decision)
**Touches:** `docs/adr/0038-coherent-control-restrictions.md` (new),
`packages/sturm-ir/src/{nodes,schema,wellformed}.ts` (doc-comments),
`packages/sturm-ir/README.md` (new section), `packages/sturm-ir/test/
{schema,wellformed}.test.ts` (coverage gaps closed).

## Context

The bead `r40` was a tracer-side prerequisite for `q0b` (`tools/sturm-
trace`): decide what happens when a user writes `when(q) { observe(r) }`
in the TS source surface, where the IR has no `controls` field on
`observe`. The bead body left three open questions: which non-rotation
op heads to forbid in a `when` body, what error envelope to use, and
how to encode the rule structurally at the IR layer for agents that
construct IR Values directly without going through the tracer.

I picked r40 + q0b as the work I was most attracted to in the open
queue — it is the TS-native frontend frontier where ADR-0009's "agents
are TS experts" axiom meets the IR substrate. r40 is the small sharp
spec-decision that unblocks q0b; q0b is the tracer tool itself.

## What changed

**ADR-0038 — "Coherent-control restrictions on the Sturm IR"** is the
substantive new artefact. It does three things:

1. **Settles the forbidden-op list as `complement-of-{ry, rz}`** within
   the closed seven-head IR vocabulary. That includes `prepare` (the
   genuinely-debatable case the bead flagged) and `oracle` (which the
   bead didn't explicitly call out but follows from the same principle:
   coherent control on a separable subcircuit requires lifting `when`
   *into* the oracle's source, which the tracer cannot do
   automatically). The phrasing "everything except `ry`/`rz`" is the
   load-bearing predicate for q0b's tracer — a one-line check, not a
   five-line allow-list that drifts.

2. **Names the refusal envelope** as `tagged "sturm-trace/invalid-
   when-body"` per ADR-0003 boundary-failure shape, with payload
   `record{op_head, control_wires, source_location}`.

3. **Documents the four-layer IR-level enforcement** that was *already*
   in place but had never been unified in writing:
   - Schema closure (`opSchema` declares third `controls` arg only on
     `ry`/`rz`),
   - Builder API (typed-form builders for non-rotation ops don't take
     a `controls` parameter; TS catches misuse at compile time),
   - Decoder arity (`decodeOp`'s `expectArgsLength` rejects smuggled
     trailing args),
   - Well-formedness cases-arm recursion (`insideArm` rejects the same
     non-unitary five inside a `cases` arm — the IR's structural
     fingerprint of a controlled body).

**Lockstep doc-comments.** `nodes.ts`, `schema.ts`, and `wellformed.ts`
got their motivating comments rewritten to cite the principle and
ADR-0038. The cases-arm restriction in `wellformed.ts` was previously
motivated only as "post-cases scope unambiguous"; now both reasons are
named and the second (the IR-level analogue of the source-level
`when`-body rule) is marked as the load-bearing one.

**New `packages/sturm-ir/README.md` section** — "Coherent control:
where it's allowed, where it's structurally rejected." A four-row table
naming each enforcement layer and what it catches. This is the
agent-facing summary; the ADR is the spec.

**Test coverage closed two gaps.**
- `schema.test.ts` gained a new `describe` block with five tests, one
  per non-rotation head, pinning that a `Value` with a smuggled
  `controls` arg fails `validate(v, opSchema)`. This is Layer 1
  defense-in-depth as a regression guard.
- `wellformed.test.ts` gained two tests: `observe` inside a cases arm
  (the rejection was implemented at line 152-154 but never had a
  covering test — a real coverage gap), and a `falseArm`-position
  variant that pins the recursion descending into both arms
  symmetrically (lest a future refactor accidentally drop the false-arm
  traversal).

Bead `q0b` was updated with the decision in its notes so the future
implementer (likely me, next session) opens the bead and finds the
spec already nailed down.

## Why these choices

- **An ADR, not a worklog shard alone.** Per CLAUDE.md Law 2: a new
  error class (`sturm-trace/invalid-when-body`) and a cross-cutting
  enforcement rule that future Sturm tools will cite is exactly what
  ADRs are for. A worklog shard is a record of work *done*; the
  decision itself wants a stable named home that q0b can cite by path.

- **Forbid `prepare` in v0.1, document, revisit.** The bead recommended
  this. The argument for admitting `prepare` is technically correct
  (the lowering "drop the control" is sound for a fresh-wire allocation
  that doesn't entangle with the control); the argument against is the
  agent-confusion reading — `when(q) { prepare(|+⟩) }` *reads* as if
  the preparation depends on `q`, even though the lowering wouldn't
  make it so. Narrowing is forward-compatible, widening isn't; v0.1
  refuses, v0.2 can relax if a real use case appears. Symmetric with
  the other four refusals, which simplifies the tracer's predicate to
  "is this op `ry` or `rz`?"

- **Forbid `oracle` too — not in the bead's original list.** The bead
  enumerated observe/cases/discard/prepare. I added `oracle` because
  the same principle applies: coherent control of a separable
  subcircuit isn't a thing the IR can express. The principled
  workaround (lift `when` into the oracle's source and re-trace) is
  outside the tracer's responsibility. The ADR documents this addition
  explicitly with the "everything except ry/rz" framing so the
  enumeration isn't load-bearing — if the IR ever grows another op
  head, the principle still applies and the predicate doesn't need
  updating.

- **No new code in the enforcement layers — only documentation.** The
  bead's acceptance criterion 2 said "wellformed.ts updated to catch
  the violations structurally." My read of the codebase was that the
  IR-level invariant is *already enforced* across four layers; what
  was missing was the principle-level documentation tying them
  together. Adding redundant checks would have been mid; documenting
  the layered enforcement and pinning the missing test cases is the
  right shape.

- **Updating the bead's stated message wording instead of citing the
  ADR inline.** The cases-arm rejection messages in `wellformed.ts`
  say things like `"prepare inside cases arm is not allowed in v0.1"`.
  I considered appending `"(ADR-0038)"` to each but decided against:
  stderr output prefers terse messages; the doc-comment block above
  the function is the authoritative explanation; tests don't pin
  wording today, so future wording refinements stay free.

## Frictions surfaced

- **The bead's "wellformed.ts updated to catch the violations
  structurally" subitem was subtler than it read.** A first pass might
  have added a new check that walks the typed Op tree and asserts "no
  non-unitary op carries a `controls` field" — but that's vacuous
  because the typed `Op` discriminated union literally has no
  `controls` field on the non-unitary variants. TS won't let you write
  the violation. The genuine question was "where else does the
  principle apply at the IR level?", and the honest answer is "the
  cases-arm restriction, already enforced." Took some reading of
  nodes.ts/schema.ts/wellformed.ts in cross-reference to see this
  clearly. The clean deliverable is the unified ADR, not a synthetic
  new check.

- **`oracle` is the asymmetric case for `prepare`.** When deciding
  the forbidden list, `oracle` and `prepare` looked superficially
  similar (both could plausibly be "harmless" inside `when`). But
  they're different: `prepare` could lower to an uncontrolled prepare
  outside the `when`, soundly; `oracle` cannot be uncontrolled-and-
  still-correct (the user's intent was for the oracle's inner ops to
  be controlled). The right move was to fold both into the "everything
  except ry/rz" rule rather than draw a fine-grained line; the
  one-line predicate is easier to teach and easier to maintain.

- **r40 was not really a coding task — it was a spec-decision task
  with code-shaped acceptance criteria.** I almost skipped the ADR
  in favour of an inline doc-comment, but the bead's acceptance
  criterion 1 ("Decision documented in q0b's notes") plus CLAUDE.md
  Law 2's "new error class → ADR" pushed me back toward the ADR.
  The right call: the decision deserves a stable home.

## Acceptance

- `packages/sturm-ir` test suite: **74 pass** (was 67; +7 across two
  files — 5 in schema.test.ts, 2 in wellformed.test.ts).
- Full `bun run check`: **95 passed, 7 skipped, 0 failed**. No
  regressions across the 50+ tool oracle suites or the existing 13
  package test suites.
- `q0b`'s notes carry the tracer-side decision verbatim from
  ADR-0038, so the next session opening `bd show q0b` finds the spec
  ready to implement against.

## Pointers

- `docs/adr/0038-coherent-control-restrictions.md` — the unified spec.
  Section 3 is the four-layer enforcement table; section "What this
  ADR changes" explicitly lists the new test coverage and the
  no-new-code-in-enforcement-layers decision.
- `docs/adr/0006-sturm-ir-as-value.md` — the IR closure decision that
  ADR-0038 promotes from an aside to a structural property.
- `docs/sturm-ts/principles.md` — P1, P3, P5 are realised by the
  four-layer enforcement.
- `packages/sturm-ir/README.md` § "Coherent control" — the agent-
  facing summary table.
- `packages/sturm-ir/test/{schema,wellformed}.test.ts` — the pinning
  tests; the new schema-side `describe` block names ADR-0038
  explicitly as the regression contract.
- bead `q0b` — the next step; r40 unblocks the tracer implementation.
