# ADR-0009 — TS-native frontend DSL: agents-as-TS-experts is the spec

**Status:** Accepted (design direction; implementation pending) — 2026-04-30
**Context:** layer-2 design exploration on top of `packages/sturm-ir`
(ADR-0006). No beads issue filed at the time of writing — the local
beads database was not initialised; an issue body should be lifted from
this ADR when the tracker is rewired.
**Related:** ADR-0006 (IR-as-Value, the substrate this DSL produces),
`docs/sturm-ts/principles.md` (P1–P9, which this DSL realises), the
`Sturm.jl` README (the *Julia*-native realisation, deliberately not
mirrored here).

## Context

`packages/sturm-ir` ships the typed builders (`ryOp`, `rzOp`,
`prepareOp`, `channel(...)`) that produce a Channel IR Value. That is
Layer 1. The question this ADR settles is **what sits above it on the
TS source side** — the user-facing surface in which a programmer
writes Grover, teleportation, QFT, etc.

Two reflexes were considered and rejected:

1. **Port `Sturm.jl`'s source surface verbatim.** Its design exploits
   Julia features TS does not have or does not idiomatise: multiple
   dispatch (`Base.:+(::QInt, ::QInt)`), macros (`@context`,
   `@cases`), `Val{N}` value-level types, `do`-block resource
   management, operator overloading on every numeric op. A faithful
   port ends up writing Julia in TS — alien on every line.

2. **Effect-TS / fp-ts-style algebraic effects.** Heavyweight paradigm
   import. Drowns the algorithm in `yield* Eff.…` boilerplate and
   forces a monadic mental model the rest of the workbench does not
   share.

The settled framing comes from a different starting point.

## The axiom

**Agents are TS experts. What a TS expert wants is the spec.**

This is not a soft preference. It is the load-bearing axiom of the
whole frontend layer. Concretely:

- When a design question reduces to "what would a senior TS engineer
  who has never seen a quantum DSL want here?", the answer is the
  decision. There is no separate "but quantum DSLs traditionally do X"
  argument that overrides it. Quantum-DSL convention is allowed to
  inform but not to override.
- TS's signature feature is **the type system as primary API surface**.
  TS readers read types first, code second. The frontend foregrounds
  `Channel<I, O>` as a typed first-class value; the trace block is one
  of several ways to construct one, not the centre of gravity.
- When a Julia-native idiom (`@context begin … end`, `q.θ += δ`-as-
  macro, `Val{N}` dispatch) collides with TS culture, the TS culture
  wins. The frontend is the realisation of what a TS expert wants —
  not a translation of `Sturm.jl`.

`Sturm.jl` remains the canonical reference for *physics correctness*:
the up-to-global-phase channel framing, the `_cz!` decomposition vs.
controlled-Rz(π) trap, the `not = Rz(π); Ry(π)` two-primitive form,
the qubit-cap reasoning. None of those are TS-native questions; they
are correctness facts the TS frontend is bound by. The framing of
*how TS programmers express algorithms* is not bound by `Sturm.jl`.

## The framing shift

Sturm.jl centres the imperative trace block (`@context begin … end`,
mutation accumulating ops, `current_context()` resolved by macro
expansion). The TS-native centre is **the typed channel as a return
value**, with three usage modes layered on top:

1. **Library call** — by far the common case. The user calls
   `find(3, equalTo(5))` and gets back a `Channel<[], [QInt<3>]>`.
   They never write a primitive.
2. **Predicate-as-oracle** — a step lower. The user passes a plain TS
   predicate; the library compiles it to a phase oracle by
   tabulating over the (small) domain. P9 in TS-native form.
3. **Hand-traced** — only for genuinely-quantum operations. The user
   writes a `trace<I, O>(fn)` block, surfaces the rotation primitives
   directly (`q.φ += π`), uses `using` for partial trace, plain `if`
   on `observe(q)` for post-measurement classical branches.

All three layers visible from the same library, none of them
mandatory.

## The TS-native bets

| Bet | Justification |
|---|---|
| `Channel<I, O>` is the central type | TS readers read types first; channel-as-value matches ADR-0006's IR-as-Value framing |
| Tuple I/O `[QBool, QInt<3>]` for register signatures | Native TS, type-checked, generalises to `Channel<[A,B], [C]>` for combinators |
| Const generics `QInt<W extends number>` | Type-level wire counts without `Val{N}` machinery |
| `using` declarations for partial trace | TC39 explicit resource management (TS 5.2+) is *exactly* the shape of "this qubit has a scope"; mirrors `Sturm.jl`'s `do`-block allocator without macros |
| Async on execution via `execute(channel, opts)` free function | Channel is pure data; `execute` is an adapter; future backends (density-matrix, hardware) plug in via `opts.backend` without re-shaping the type |
| Plain TS predicates as oracles | P9 in TS-native form; library tabulates over `[0, 2^W)` for W within the qubit cap |
| `Measurement<T>` with `m.if(then, else?)` for post-measurement, `when` for coherent | P4 maps cleanly; pure `if (rq)` is impossible in TS (`Boolean(obj)` is unconditionally true), so `m.if(...)` is the closest TS-native approximation |
| Free functions for rotation primitives — `rz(q, δ)`, `ry(q, δ)`, `not(q)` | TS-functional culture (Effect-TS, fp-ts, Iterator Helpers) leans hard toward "data is data, operations are functions"; setters on identity-only handles lie at the type level |
| `not(q)` as the only named gate | P5 exception inherited from `Sturm.jl`'s reasoning — no-cloning forbids `b = !b`, so a Julia-bang-suffix companion exists |
| `then(f, g)`, `tensor(f, g)` named-function combinators | TS has no operator overloading; named functions match existing IR-level tools (`sturm-then`, `sturm-tensor`) |

## The bets *not* taken

- **No operator-overloaded `>>` / `⊗` between channels.** TS doesn't
  support it; faking it via `Symbol.iterator` tricks would be
  unidiomatic. Named functions read fine.
- **No `function*` generators with `yield* ...`.** Boilerplate
  without semantic gain.
- **No method-chaining DSL** (`channel.hadamardAll().diffuse()`).
  Obscures the `Channel<I, O>` shape, fights P5.
- **No decorators.** Wrong tool.
- **No `@context EagerContext()`-style block syntax.** TS has no
  macro layer to make this clean. Implicit context goes through
  `AsyncLocalStorage` (or a module-level carrier scoped to a `trace`
  call), invisible to the user.

## What this means structurally

Three layers above the IR:

```
Layer 0  Channel as canonical Value         (canonical JSON, expr "channel")  [exists]
Layer 1  packages/sturm-ir typed builders   (ryOp, channel, encodeChannel)    [exists]
Layer 2a packages/sturm  FRONTEND DSL       (trace, qbool, when, primitives)  [TO BUILD]
Layer 2b packages/sturm-lib PATTERNS LIBRARY (H, CNOT, CZ, MCZ, find, qft)    [TO BUILD]
Layer 3  tools/sturm-find, sturm-shor, …    Algorithm tools                    [TO BUILD]
```

`sturm-trace` is **not** a workbench tool under this design. The
trace mechanism is the `trace<I, O>(fn)` function in
`packages/sturm`. Channels constructed in TS expose `.toValue()` for
piping into any existing sturm-* tool. If a non-TS caller ever needs
"compile this TS file to a Channel Value," that is a thin wrapper
they write themselves; it does not justify a contracted tool. The
beads slot for `q0b` re-scopes from "the tracer tool" to
"`packages/sturm` + `packages/sturm-lib`."

## Grover at three layers

```ts
// === Highest level: pure library call ===
import { find, equalTo } from "@workbench/sturm/lib";
import { execute } from "@workbench/sturm";

const search = find(3, equalTo(5));
//    ^? Channel<[], [QReg<3>]>
const { samples } = await execute(search, { shots: 100, entropy });

// === Middle: predicate-as-oracle (P9 in TS-native form) ===
import { find, oracleFn } from "@workbench/sturm/lib";

const search = find(3, oracleFn(x => x * x === 9));
// library tabulates: enumerate x ∈ [0, 8), mark { x : x*x === 9 } = { 3 }

// === Lowest: hand-traced, primitives surface only when genuinely-quantum ===
import { trace, qbool, when, not, observe, ry, rz, π } from "@workbench/sturm";

const teleport = trace<[QBool], [QBool]>(t => {
  const q = t.input.qbool();                 // declare the input wire
  using a = qbool(1/2);                      // |+⟩, ptrace at scope exit
  using b = qbool(0);                        // |0⟩, ptrace at scope exit
  when(a, () => not(b));                     // Bell pair on (a, b)
  when(q, () => not(a));                     // entangle input
  rz(q, π);                                  // basis change — primitives
  ry(q, π / 2);                              // surface only for genuinely-q
  const ra = observe(a);                     // Measurement<boolean> (P2 cast)
  const rq = observe(q);
  ra.if(() => not(b));                       // post-measurement classical branch
  rq.if(() => rz(b, π));
  return [b];
});
```

The library entries (`find`, `equalTo`, `oracleFn`, `H`, `phaseFlip`,
`diffuse`, `amplify`) live in `@workbench/sturm/lib` and are themselves
built using the low-level primitives — the layers stack but do not
leak.

## Resolved during skeleton review (2026-04-30)

The first draft listed six open questions. All six (plus a seventh
that surfaced during review — the post-measurement classical-control
shape) were resolved in one pass against the design axiom: what would
a senior TS engineer who'd never seen a quantum DSL actually wish
for? Several of the "reasonable defaults" the first draft floated
turned out to fight TS culture or be impossible in pure TS.
Resolutions, with the TS-expert justification each rests on:

1. **`QInt<W>` → `QReg<W>`.** The skeleton type has no arithmetic;
   `QInt<W>` overpromises. A TS expert wants types to say what they
   *are*, not what they aspire to. `QInt<W> extends QReg<W>` lands
   when arithmetic methods do. Naming churn paid up-front beats
   carrying a misleading name.

2. **Free functions, not property setters, for the rotation
   primitives.** `rz(q, π)` and `ry(q, π/2)`, not `q.φ += π`. The
   setter form lies at the type level: `q.φ` doesn't store anything
   (wires are identity-only), so a setter pretending to track a value
   is dishonest. Modern TS culture (Effect-TS, fp-ts, Iterator
   Helpers, RxJS pipeable operators) leans hard toward "data is data,
   operations are free functions." Free functions are also pipeable
   and HOF-composable, which setters and methods aren't.

3. **Type-level wire arithmetic deferred.** `Channel<[QReg<W>],
   [QReg<W+1>]>` via template-literal types is doable but only earns
   its keep at algorithm boundaries (e.g., adders). Not for general
   circuit construction. Revisit when a use case forces it.

4. **`oracleFn` domain limit = the qubit cap.** Sturm-execute caps at
   12 qubits = 4096 evaluations for full-domain tabulation, which is
   trivially fast. Past the cap, sturm-execute can't run the circuit
   anyway — the natural ceiling is the simulator's, not the
   oracle-compiler's.

5. **`π = Math.PI`. Symbolic via `piOver(n)` escape hatch.** The first
   draft proposed `π` as a sentinel that "stays symbolic via
   arithmetic." That cannot work in TS — there is no operator
   overloading; `π / 2` either evaluates to a float or is a TypeError.
   A TS expert writes `Math.PI / 2` reflexively and expects numbers
   to behave like numbers. `piOver(n)` is the explicit escape hatch
   when the IR's exact path needs symbolic preservation.

6. **`execute(channel, opts)` free function, not `channel.run()`.**
   Channel is pure data; execution is an adapter that varies by
   backend (sturm-execute now; density-matrix later; hardware later).
   Coupling Channel to a single backend via `.run()` is exactly the
   premature coupling a TS senior flags in code review. The
   ergonomic loss of `c.run()` vs `execute(c)` is real but small;
   the architectural gain is large.

7. **`Measurement<T>` with `m.if(then, else?)`, not `cases(ref, fn)`
   or plain `if (rq)`.** This is the resolution where the first draft
   was *impossible*, not just suboptimal. Plain `if (rq)` cannot be
   intercepted in pure TS — `if (x)` calls `ToBoolean(x)`, which
   returns `true` for any non-null object, with no `Symbol.toBoolean`
   hook. AST rewriting via a TS plugin would work but is heavy and
   brittle for v0.1. The closest TS-native approximation is a method
   on the result-typed value — `m.if(...)`, which mirrors how TS
   programmers reach for `response.json()`, `prom.then()`,
   `iterator.next()`. Renamed `ClassicalRef<T>` → `Measurement<T>` so
   the type name describes the value, not the internal mechanism. A
   future TS plugin that rewrites `if (m) X` → `m.if(() => X)` would
   be purely additive and uncontroversial; until it lands, `m.if` is
   the canonical form.

The skeleton at `packages/sturm/src/index.ts` reflects all seven
resolutions. Each new design call deferred to implementation should
be answered the same way: re-apply the TS-expert axiom; if a
reasonable-sounding default fights TS culture or is impossible in
pure TS, it is wrong regardless of how it reads on paper.

## Consequences

- The `q0b` work item re-scopes from "tracer tool" to "`packages/sturm`
  frontend package + `packages/sturm-lib` patterns package + first
  algorithm tool (`tools/sturm-find` as the canonical demo)."
- `Sturm.jl/src/library/{patterns.jl,gates.jl}` is the physics
  reference for the patterns library (verified-correct H, X, CZ, MCZ,
  diffuse, phase_flip, amplify, find recipes), not a source-surface
  blueprint.
- The frontend package is a *language*, not a thin wrapper. Future
  ADRs will need to settle the questions above as they are forced by
  implementation.
- Future design questions in this layer reduce to a single test:
  *would a senior TS engineer want this?* If the answer is no, the
  design is wrong, regardless of what `Sturm.jl` does.

## Pointers

- `packages/sturm-ir/src/nodes.ts` — Layer 1 typed builders this DSL
  produces.
- ADR-0006 — IR-as-Value, the substrate.
- `docs/sturm-ts/principles.md` — P1–P9, which this DSL realises.
- `Sturm.jl` README + `src/library/patterns.jl` — physics-correctness
  reference, *not* source-surface blueprint.
- Worklog 024 — the design exploration that produced this ADR.
