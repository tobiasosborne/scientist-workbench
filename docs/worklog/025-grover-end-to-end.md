# 025 — Grover end-to-end via @workbench/sturm + sturm-lib + sturm-find

**Date:** 2026-04-30
**Status:** complete
**Branches:** main
**Issues:** none filed (local beads database not initialised; the user
warned against `bd init` because a previous agent had broken it).
ADR-0009 + worklog 024 are the canonical specs; an issue body should
be lifted from them when the tracker is rewired.

## Context

ADR-0009 settled the design direction for the TS-native frontend
DSL (axiom: agents are TS experts; what a TS expert wants is the
spec). Worklog 024 recorded the design exploration. The skeleton at
`packages/sturm/src/index.ts` was reviewed and refined against the
TS-expert axiom — six "open questions" all flipped from the first
draft (free functions, `π = Math.PI`, `execute()` free function,
`Measurement<T>.if()`, `QReg<W>`, no Greek setters).

The user's instruction was "go implement Grover" — execute the design
end-to-end, not just spec it. This shard documents what shipped and,
critically, the two surface bugs the implementation surfaced (both
of which would have re-derailed the next session if not captured).

## What changed

**`packages/sturm`** (~590 LOC across `runtime.ts` + `index.ts`,
plus 8 tests at `test/bell.test.ts`):
- `TraceState` carrier (module-level mutable, swapped in `trace()`).
- `qbool(p)`, `qreg(W, value)` — allocators with `Symbol.dispose`
  for `using` blocks.
- `trace<I, O>(body)` with `t.input.qbool()` / `t.input.qreg()`
  declarators for input wires.
- `ry(q, δ)`, `rz(q, δ)`, `not(q)` — free functions per ADR-0009 §6.
- `when(c, fn)` — coherent control binder.
- `observe(q): Measurement<boolean>` returning a typed handle with
  `m.if(then, else?)`.
- `Channel<I, O>` — pure data class wrapping IR; `toValue`, `hash`,
  `toIR`, `fromValue`.
- `execute(channel, opts)` — free function that spawns `sturm-execute`
  / `sturm-sample` via `spawnBun`.
- `then`/`tensor`/`controlled` stubbed with deferred error messages
  (Grover doesn't need them; they'll land when a use case forces it).

**`packages/sturm-lib`** (~270 LOC + 10 tests):
- Single-qubit gates: `H`, `X` (= `not`), `Z`, `S`, `T`, `Sdg`, `Tdg`,
  `Y`. Each is a recipe in primitives.
- Two-qubit gates: `cx` (channel-CX, see frictions below), `cz`
  (the Sturm.jl 5-op recipe + cx phase compensation).
- `mcz` for n ∈ {1, 2, 3}: `Z`, `cz`, and a textbook 6-CX `ccz`
  (N&C Fig 4.9 with the leading/trailing H's dropped). n ≥ 4 throws
  with a clear deferral message.
- `phaseFlip(reg, target)`, `phaseFlipMany(reg, targets)`,
  `hadamardAll(reg)`, `diffuse(reg)`.
- `optimalIters(N, M)` (Brassard 2002 Thm 3), `amplify(...)`, `find(W,
  oracle, nMarked?)`.
- `equalTo(target)`, `oracleFn(predicate)` — P9 oracle helpers.

**`tools/sturm-find`** — 7-artefact contract:
- 5 invariants (deterministic, probs-sum-to-1, marked-state-amplified,
  optimal-iterations, honest-scope-bounds).
- 3 examples covering n=2 single-marked, n=3 single-marked, n=3
  multi-marked.
- `--test` hook that re-derives analytic predictions for n=2 and
  n=3 and verifies output to 1e-9.
- 18 goldens spanning n ∈ {1, 2, 3} and various marked-set shapes.
- README documenting the closed-form predicted P(marked) per case.

**`tsconfig.json`** — added `@workbench/sturm` and `@workbench/sturm-lib`
to the paths map.

**`README.md`** (project root) — `sturm-find` row in the catalog;
`packages/sturm/` and `packages/sturm-lib/` rows in the file-layout
section.

**`scripts/demo-scope.sh`** — Demo 14 (Grover n=3 marked={5}).

`bun run check`: 31/31 phases green. End-to-end Grover takes ~4s
total for the 18-golden oracle pass.

## Why these choices

**Separate frontend (`sturm`) and patterns (`sturm-lib`) packages.**
Per ADR-0009. `sturm` exposes the *language* (trace, primitives,
when, observe, Measurement, Channel, execute). `sturm-lib` exposes
the *vocabulary* built on top (H, cx, cz, mcz, find, …). The split
prevents the frontend from creeping into a "knows about every gate
ever" surface, and keeps physics-correctness recipes localised to
the patterns layer where they can be verified per-recipe.

**Subprocess-based `execute`.** The existing tools' `tool.ts` files
end with `void runTool(def)` which fires on import — making
in-process `def.fn(input, {})` invocation unsafe (it would race
against the imported tool's own argv parsing). Subprocess via
`spawnBun` works today; the perf cost (~50ms cold start per
invocation) is acceptable for a v0.1 algorithm tool. Refactoring
every tool to split CLI from def is a separate, larger task.

**`mcz` capped at n=3 in v0.1.** ADR-0009 left "how big should
Grover's search space be" as an implementation detail. The honest
answer turned out to be `n ≤ 3` because (a) `sturm-execute`'s
12-qubit cap and (b) the `-iX` controlled-rotation phase trap (see
Frictions below) make the n ≥ 4 ancilla cascade more involved than
this iteration's budget allowed. We ship `mcz` for n ∈ {1, 2, 3}
with direct decompositions (Z, cz, ccz-via-Toffoli), and throw a
clear "deferred to v0.2" error for n ≥ 4. Honest scope per
ADR-0003 / CLAUDE.md Rule 8.

**`Measurement<T>.if(then, else?)` as a method, not free `cases()`.**
ADR-0009 §7. Plain `if (m) …` cannot be intercepted in pure TS
(`Boolean(obj)` is unconditionally true). `m.if(...)` reads as the
closest TS-native approximation; `cases` stays internal to the
runtime. The skeleton's `cases(ref, fn)` was renamed away.

**Output-tuple flattening in `trace.freeze`.** `trace<I, O>` lets
the body return a tuple of QBools and/or QRegs. The freeze step
flattens: `[QBool, QReg<3>]` becomes 4 output wires, in the order
the user wrote them. This matches Sturm.jl's "channels are typed
functions on registers" mental model without making the user
write per-bit observation manually.

**Goldens at 18, not the ≥30 PRD soft-floor.** v0.1 tool — n_bits
caps at 3, search space at 8, and we cover every distinct
(n_bits, marked-cardinality) shape plus boundary cases (all-zeros,
all-ones, evens, odds). Adding more goldens would mean
near-duplicates. Documented as v0.1 scope; ≥30 lands when n grows.

## Frictions surfaced

These are the load-bearing parts of this shard. Each one stalled
the implementation for a meaningful amount of time and would
re-stall a future agent who didn't read about it.

**1. The `-iX` controlled-rotation phase trap.** This is a sharp
edge that the user explicitly warned about (it's documented as the
"Session 8 bug" in `Sturm.jl/CLAUDE.md:64-72`), and it bit again
on first principles.

`not(q) = rz(q, π); ry(q, π)` lowers to `Ry(π) · Rz(π) =
(-iY)(-iZ) = -iX` as a single-qubit *unitary*. As a *channel*, the
`-i` is global and unobservable: `(-iX)ρ(iX) = XρX`, exactly the
X channel. So `not(q)` alone is correct.

But `cx(c, t) = when(c, () => not(t))` lowers to two ops with
`controls = [c]`: ctrl-Rz(π) then ctrl-Ry(π) on `t`. The composite
unitary on the c=1 block is `Ry(π) · Rz(π) = -iX`. The composite
unitary across both blocks is `diag(I, -iX)`. The `-i` factor
multiplies the c=1 block of the joint unitary — it is *not*
global. As a channel:

```
diag(I, -iX) ρ diag(I, +iX)
```

The off-diagonal blocks of ρ pick up `±i` factors that are *not*
present in the channel of textbook CX = `diag(I, X)`. So
`when(c, () => not(t))` is **not the channel CX**. It's a closely
related channel that disagrees on every state with control
superposition.

The Sturm.jl `_cz!` recipe assumes `b ⊻= a` is channel-CX. With
our `cx` not being channel-CX, the 5-op CZ recipe acts as identity
(up to global phase) on `|+⟩|1⟩`, but as CZ on `|1⟩|+⟩` — an
asymmetry that's a hard bug.

**Fix:** append `rz(c, π/2)` to `cx` after the `when(c, () => not(t))`.
`Rz(π/2)` on the control is `diag(e^{-iπ/4}, e^{iπ/4})`, which
multiplies the c=1 block by `e^{iπ/4}` and the c=0 block by
`e^{-iπ/4}`. Combined with the `-i` from the controlled `not`, the
resulting unitary is `e^{-iπ/4} · diag(I, X)` — textbook CX up to
a *global* phase. As a channel: textbook CX. The 5-op CZ recipe
then works correctly.

**Cost:** one extra `rz` per CX. Documented inline in
`packages/sturm-lib/src/index.ts`'s `cx` JSDoc with the full
algebra so the next reader doesn't have to re-derive it.

**2. The same trap in `when(q1, () => when(q2, () => not(t)))` for
Toffoli.** Same algebra: nested-when produces ctrl-ctrl-(-iX) on
the (q1=1, q2=1) block, not channel-CCNOT. The compensation needs
a doubly-controlled phase, which is not a primitive in the IR.

**Fix:** don't use nested-when for Toffoli at all. Build CCNOT (or
CCZ) from `cx` (the now-channel-correct CX) plus T/Tdg/H rotations,
following Nielsen-Chuang Fig 4.9. The trapped phase factor only
appears in `cx` — already compensated — so the higher-level
construction is clean. `mcz` for n=3 calls a hand-coded
`ccz(c1, c2, t)` that uses 6 cx calls + various T's; no nested-when.

**Lesson for future:** any time a "controlled X" appears inside a
controlled context, reach for `cx` (the channel-CX helper), never
for `when(c, () => not(t))` directly. The bare nested form is
syntactically tempting but channel-incorrect.

**3. The Sturm.jl recipe-as-text is ambiguous about CX semantics.**
`_cz!` in `Sturm.jl/src/library/patterns.jl:258` is documented as
"2 CNOTs + 3 Rz rotations" referencing N&C §4.3. But Sturm.jl's
`b ⊻= a` is implemented via the same `not!` we have, which gives
the same `-iX` issue — yet Sturm.jl's Grover tests reportedly pass.

I didn't track down whether Sturm.jl's `EagerContext` has extra
phase-tracking logic, or whether their tests use a loose enough
threshold to mask the issue, or something else. The pragmatic fix
in our port is to make `cx` channel-correct (described above).
Worth investigating in Sturm.jl directly at some point, but not
load-bearing for our v0.1.

**4. `using` for `qbool`/`qreg` works structurally but the resulting
channel can't simulate.** `Symbol.dispose` emits a `discardOp`,
which `sturm-execute` lists as out-of-scope. Result: any
`using q = qbool(...)` block produces a channel that fails at
execution with `tagged "sturm-execute/out-of-scope"`. For Grover
specifically, we simply don't use `using` — ancillae stay allocated
to the channel boundary, and the Toffoli structure leaves them
in |0⟩ deterministically. Documented in the `qbool` JSDoc as a
known limitation of v0.1.

**5. Subprocess execute has a 50ms cold-start cost.** Each
`execute()` spawns Bun afresh. For an algorithm tool that's run
once per pipe invocation, this is fine; for a library that calls
`execute` in a loop (e.g., a `--test` hook with many probes), it
adds up. Future work: refactor tool.ts files to split CLI from
exported `def`, then `execute` can dispatch in-process.

## Acceptance

- 7-artefact contract on `tools/sturm-find` (compiled tool, schema,
  examples, invariants, `--test` hook, 18 goldens, README).
- `bun run check`: 31/31 phases green (3 base + 13 per-tool --test
  + 15 oracle, with one oracle skipped per the standard pattern).
- `bun test`: 18 tests pass across `packages/sturm/test` and
  `packages/sturm-lib/test`.
- Bell-pair smoke test verifies the frontend end-to-end (channel
  construction, primitive emission, execute, distribution shape).
- Lib tests verify gate decompositions byte-structurally and Grover
  end-to-end against analytical predictions:
  - W=2 marked={3}: P(observed=3) = 1.0 (within 1e-9).
  - W=3 marked={5}: P(observed=5) ≈ 0.9453 (within 1e-9 of
    `sin²(5·arcsin(1/√8))`).
  - W=3 marked={evens}: P(observed even) = 0.5.
- `tools/sturm-find --test` re-runs the n=2 and n=3 probes against
  analytical predictions.
- Goldens for sturm-find generate cleanly and oracle-pass.
- `scripts/demo-scope.sh` Demo 14 demonstrates Grover n=3 marked={5}
  end-to-end through the workbench's standard pipe interface.

## Pointers

- `packages/sturm/src/index.ts` — the frontend DSL, ~580 LOC.
- `packages/sturm/src/runtime.ts` — internal trace-state machinery.
- `packages/sturm-lib/src/index.ts` — patterns library, ~270 LOC.
- `tools/sturm-find/tool.ts` — the algorithm tool.
- `tools/sturm-find/goldens/` — 18 golden outputs.
- ADR-0009 — design direction (the spec).
- Worklog 024 — design exploration that produced ADR-0009.
- `Sturm.jl/src/library/patterns.jl:258` — the CZ recipe (with the
  asterisk noted in friction #3).
- `Sturm.jl/CLAUDE.md:64-72` — the up-to-global-phase framing and
  the "Session 8 bug" warning.
- Nielsen-Chuang §4.3 Fig 4.9 — the Toffoli decomposition `ccz`
  ports.
- Brassard et al. (2002), "Quantum Amplitude Amplification and
  Estimation," Theorem 3 — `optimalIters`.
