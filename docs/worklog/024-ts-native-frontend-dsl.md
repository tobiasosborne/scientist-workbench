# 024 — TS-native frontend DSL: agents-as-TS-experts is the spec

**Date:** 2026-04-30
**Status:** design direction recorded; implementation pending
**Branches:** main
**Issues:** none filed (local beads database not initialised this
session; the user warned against `bd init` because a previous agent had
broken it). The ADR body is the canonical spec; an issue should be
lifted from it when the tracker is rewired.

## Context

Conversation context: explored what it would take to code Grover's
algorithm on top of the existing IR + tools, then drifted into the
broader design question of *how should idiomatic TS express Grover at
all*. That second question turned out to dominate.

The first pass on Grover-feasibility hit two hallucination potholes
that had to be cleared before the design question made sense:

1. **Misreading worklog 022.** Read "§8.1 H-derivation verified buggy"
   as "no working H exists." Wrong. The buggy *spec line* is
   `H := ry(π/2); ry(π)` (composes to Ry(3π/2), not H). The
   *correct* derivation, shipped in production in
   `Sturm.jl/src/gates.jl:38`, is `H = Rz(π); Ry(π/2)` — channel-
   correct up to global phase. Bead 1td tracks landing the verified
   formula in the TS spec; the IR vocabulary already supports it.
2. **Forgetting up-to-global-phase.** Argued that `Ry(π/2) ≠ H`
   was a blocker. It isn't. `Sturm.jl/CLAUDE.md:64-72` makes this
   explicit: the four primitives generate **all single-qubit
   channels (CPTP maps), not all unitaries**. Ry/Rz live in SU(2)
   (det = 1); H has det = -1, so no SU(2) product equals H *as a
   unitary* — but `iH ∈ SU(2)`, and the channel ρ ↦ HρH† is the
   same channel for U = H or U = iH. **Up to global phase is a
   theorem, not an approximation.** The only place the global
   phase bites is inside `when()`, where it becomes a relative
   phase (the `controlled-Rz(π) ≠ controlled-Z` trap, fixed in
   `_cz!` at `Sturm.jl/src/library/patterns.jl:258`).

After both pots had been cleared, the actual design question came
into focus. The user's framing:

> what i would like is to explore how to plan the layer 2 to
> package/expose the primitives so that idiomatic ts can express
> grover in an elegant way. i.e, a new tool(?) to create IR from
> idiomatic TS

Three sketches of "idiomatic TS Grover" were produced and discussed
(Sturm.jl-mirror with mutation, functional with explicit context,
DSL-as-method-chain). The user pushed past all of them with a
sharper framing:

> suppose Sturm.jl doesn't exist. How would a TS expert WANT to
> express grover (and respect the principles)

That reframe is the load-bearing move of the whole iteration. The
answer that emerged — and the user accepted — is captured in
ADR-0009.

## What changed

- **`docs/adr/0009-ts-native-frontend-dsl.md`** — new ADR. Records
  the axiom (*agents are TS experts; what a TS expert wants is the
  spec*), the framing shift (Channel<I,O> as central type), the
  TS-native bets (const generics, `using` for partial trace, async
  on execution, plain TS predicates for oracles, property setters
  for the rotation primitive), the bets-not-taken (Effect-TS,
  decorators, method chaining, operator overloading), the three-
  layer Grover sketch, and the open questions deferred to
  implementation.
- **`docs/worklog/024-ts-native-frontend-dsl.md`** — this shard.
- **MEMORY.md** — pointer to the new feedback memory recording the
  axiom for future sessions.
- **`memory/feedback_ts_native_design.md`** — the load-bearing
  principle in feedback form so future sessions inherit it.

No code touched.

## Why these choices

**An ADR, not a worklog-only entry.** This is a design decision that
will be referenced by every subsequent file in `packages/sturm` and
`packages/sturm-lib`. Worklog shards are time-frozen; ADRs are the
canonical "this is what we decided." The decision goes in the ADR;
the iteration that produced it goes in the shard.

**Axiom-form, not preference-form.** The user phrased it as
"Agents are TS experts. that is the spec." That is a P0 statement,
not a stylistic note. The ADR records it as the axiom of the
frontend layer, and is explicit that quantum-DSL convention informs
but does not override it. Without the explicit axiom, the next
session would drift back toward Sturm.jl-mirror by reflex.

**`Sturm.jl` re-scoped to physics-correctness reference.** The four-
primitive vocabulary, the up-to-global-phase channel framing, the
`_cz!` decomposition, the two-primitive-not are physics facts the
TS frontend is bound by. The Julia source surface is not. The ADR
makes this distinction explicit so a future agent doesn't see
`Sturm.jl/src/gates.jl` and reflexively port `H!(q::QBool) =
(q.φ += π; q.θ += π/2; q)` into TS as a class with mutation methods
that fight TS culture on every line.

**Three usage layers documented in the ADR, not just the lowest.**
The most common case — `find(3, equalTo(5))` — uses no primitives
at all. The second case — `find(3, oracleFn(x => x === 5))` — uses
P9 (plain TS predicate as oracle, library tabulates over the
domain) and is uniquely TS-native because of the qubit-cap-bounded
domain. The lowest case — `trace<I, O>(([q]) => { … })` — surfaces
the rotation primitives (`q.φ += π`) and is the only place mutation
appears. Recording all three together prevents the frontend from
being "just the trace block," which would over-rotate on the wrong
case.

**`sturm-trace` re-scoped, not deferred.** Earlier in the planning
(worklog 009) `sturm-trace` was a planned tool. Under this ADR it
isn't a tool at all — it's the `trace<I, O>(fn)` function in
`packages/sturm`. The bead `q0b` re-scopes; same artefact deliverable
(channel construction from TS), different shape (package, not tool).
Documented in the ADR's *consequences* so the re-scoping is visible
when `q0b` next surfaces.

## Frictions surfaced

- **Beads not initialised this session.** The local `.beads/`
  directory does not exist; `bd ready` errors with "no beads
  database found." The user warned against `bd init` because a
  previous agent had broken the database. Consequence: the ADR's
  consequences section says explicitly "no beads issue filed at
  the time of writing" so future-me knows to lift the issue body
  out of the ADR when the tracker is rewired. Mechanical, not a
  design issue, but worth noting so the work doesn't fall off.

- **The system kept nudging toward TaskCreate.** Several system-
  reminders in the conversation suggested using TaskCreate for
  progress tracking. Per CLAUDE.md Rule 9 ("Beads is the only
  tracker. No TodoWrite, no TaskCreate, no markdown TODO lists"),
  ignored.

- **Two hallucination potholes were *load-bearing for the design
  exploration*.** Both pots (the H-derivation, the up-to-global-phase
  framing) had to be cleared before the user's design question even
  parsed. If a future agent re-makes either mistake, the same
  exploration will re-derail. The frictions are recorded here and
  in the ADR's context so the next read can cross-check against
  the channel framing before forming opinions on "what's missing."

- **The framing shift came from one user sentence.**
  > suppose Sturm.jl doesn't exist. How would a TS expert WANT
  > to express grover

  Without that prompt, the conversation would have settled on a
  Sturm.jl-mirror design. The shift from "port the Julia surface"
  to "design from TS-native first principles" is the entire
  contribution of this iteration. Captured in the ADR axiom so
  future sessions don't have to re-discover it.

## Acceptance

- ADR-0009 written and references checked against existing files
  (ADR-0006 substrate, `principles.md`, `Sturm.jl` reference paths).
- Worklog README updated with row 024.
- MEMORY.md updated with feedback memory pointer.
- No code changed; no `bun run check` invocation needed.

## Addendum — skeleton drafted and reviewed (2026-04-30)

A typed-only skeleton was written at `packages/sturm/src/index.ts`
(types real, function bodies throw with `"not implemented (ADR-0009
skeleton)"`). The draft committed to a position on each of six open
questions the ADR had left for implementation. The user then asked
the load-bearing question:

> the answer to any unclear point is ALWAYS: what would a TS expert
> WISH for. please evaluate the 6 points with this perspective

Re-evaluating each strictly through the axiom flipped *most* of the
draft's positions. The full justifications live in ADR-0009's
"Resolved during skeleton review" section; the headline is that the
"reasonable defaults" the first draft picked turned out to either
fight TS culture (setters, symbolic-angle sentinel, `Channel.run()`
method) or be straight-up impossible in pure TS (plain `if (rq)` —
`Boolean(obj)` is unconditionally true, ECMAScript provides no hook).

The seven resolutions, in short:

1. `QInt<W>` → `QReg<W>` (honest naming; `QInt` reserved for arithmetic).
2. Property setters → free functions for rotation primitives
   (`rz(q, π)`, not `q.φ += π`).
3. Type-level wire arithmetic deferred to algorithm boundaries.
4. `oracleFn` domain limit = the qubit cap (12).
5. `π = Math.PI`; `piOver(n)` for symbolic escape hatch (the
   "symbolic via arithmetic" idea is impossible without operator
   overloading).
6. `execute(channel, opts)` free function, not `channel.run()`
   (Channel is pure data; execution is an adapter).
7. `Measurement<T>` with `m.if(then, else?)` method, not `cases()` or
   plain `if (rq)` (the closest TS-native approximation).

The user's response — "you ARE the expert here. I follow YOUR advice.
go for it" — is itself a load-bearing operating instruction: when an
unclear-but-binary design question comes up in this layer, take a
position rather than escalate. The axiom does the heavy lifting; the
agent's job is to apply it concretely, not to keep redirecting the
question upward.

The updated skeleton, ADR (with the open-questions section replaced
by the resolutions), this addendum, and the memory update were
landed in the same edit session.

## Pointers

- `docs/adr/0009-ts-native-frontend-dsl.md` — the canonical spec for
  the frontend layer.
- `packages/sturm/src/index.ts` — the typed surface skeleton, ~440
  lines, reflecting all seven resolutions.
- `Sturm.jl/CLAUDE.md:64-72` — the up-to-global-phase framing in its
  load-bearing form.
- `Sturm.jl/src/library/patterns.jl:248-308` — the `_cz!` and
  `_multi_controlled_z!` recipes the patterns library will port.
- `Sturm.jl/src/gates.jl:1-58` — the verified gate definitions
  (`not = Rz(π); Ry(π)`, `H = Rz(π); Ry(π/2)`, etc.) the patterns
  library will port.
- ADR-0006 — IR-as-Value substrate.
- `packages/sturm-ir/src/nodes.ts` — Layer 1 typed builders this
  DSL will produce.
- Worklog 022 — the H-derivation bug-hunt (1td) referenced here.
