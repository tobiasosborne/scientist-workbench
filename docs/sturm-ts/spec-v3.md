> **Provenance.** Pasted verbatim from the v3 PRD as supplied by the user
> on 2026-04-29. Do not edit the body to apply later amendments — that
> creates drift between the spec-as-written and the spec-as-supplemented.
> Adapter notes live in this preamble; design amendments live in adjacent
> documents (`principles.md`, the ADRs) and beads issues.
>
> **Status.** This is **v3, not v3.1.** The v3.1 amendment to §1's P2 row
> (and the prose around §3.2) is in [`principles.md`](principles.md), which
> supersedes this file's framing of P2. ADR-0006 (IR-as-Value) cross-references
> the v3.1 framing; the IR realises P2 type-level rather than as a "boundary"
> category of channels.
>
> **Open adaptation items at paste time** (filed 2026-04-29 against this paste):
>
> 1. **§8.1 library — H, not, Y derivations are buggy under sturm-execute's
>    convention** (verified 2026-04-29 via `scripts/probe-h-equivalence.ts`,
>    closing scientist-workbench-4xk). Spec's `H := ry(π/2); ry(π)`
>    composes to `Ry(3π/2)`, not Hadamard. Probe 1 (H·H) returns
>    `P(r=1)=1` (real H predicts `P(r=0)=1`); Probe 2 (H·Z·H) returns
>    `P(r=0)=1` (real H predicts `P(r=1)=1`). Both confirm. By extension:
>    `not := ry(π) = -iY ≠ X` (off by `Z`, indistinguishable in
>    standard-basis statistics but not coherently equivalent), and
>    `Y := rz(π); ry(π)` composes to `≈ X`, not `Y`. `Z`, `S`, `T` are
>    fine. Fix tracked in **scientist-workbench-1td** — that issue
>    carries the design call (ZYZ replacement vs documented
>    standard-basis-only caveat).
> 2. **Tracer constraints inside `when`-bodies.** §6 lowers `when(c, body)`
>    by stamping `controls = [...whenStack]` onto every op in `body`, but
>    `observe` / `cases` / `discard` have no `controls` field in
>    ADR-0006's IR (and ADR-0006 explicitly notes coherent control on
>    non-unitary ops is ill-defined). The tracer must reject these inside
>    `when`-bodies. Decision and structural well-formedness check tracked
>    in **scientist-workbench-r40** (q0b prerequisite).
> 3. **`run()` ↔ workbench-pipeline bridge.** §5.2's `RunResult<O>` shape
>    predates ADR-0007 (distribution-vs-sampling). The workbench's
>    `sturm-trace` (q0b) emits only IR; reconstructing `RunResult<O>`
>    requires composing `sturm-execute` + `sturm-sample` and mapping
>    `classical_ref` strings back to `Classical<T>` brand handles. Tracked
>    in **scientist-workbench-4iw**.
> 4. **Bennett-TS not yet ported.** §10's oracle bridge depends on
>    `@bennett/core`, which does not yet exist in this ecosystem. q0b
>    v0.1 will boundary-fail on user code that calls `oracle()` until
>    Bennett-TS lands; §13.4 (phase kickback) and §13.5 (Shor) are
>    correspondingly unrunnable. Captured in q0b's notes.
> 5. **§12 Backend interface is out-of-scope for the workbench port.**
>    The workbench substrate is stateless tools; §12's stateful
>    `StateHandle`-lifecycle interface is not a workbench concept. Only
>    the `tracing` backend slice (§14) is relevant here; `native()` /
>    `density()` are not on the workbench roadmap. Sturm-execute fills
>    the role of "an analytic backend" without inheriting §12's API.

---

# Sturm-TS — Specification (v3)

> Supersedes v1 and v2. The headline change from v2: the primitive surface
> collapses to three operations (`prepare`, `ry`, `rz`) plus three structural
> operators (`observe`, `when`, `cases`). All gate-named functions, including
> `not`, live in `@sturm/library` as derived definitions.

---

## 1. Design axioms

P1–P9 are inherited verbatim from Sturm.jl (see `principles.md`). Sturm-TS
honours them in the following TS-specific ways:

| Principle | TS realisation |
|-----------|----------------|
| P1 — Functions are channels | A function whose signature involves quantum types *is* a CPTP map. No wrapper, no `Channel<I,O>` type. |
| P2 — Boundary is a cast | `prepare(p): QBool` and `observe(q): Classical<boolean>` are the only two boundary operations. |
| P3 — Operations are operations | One IR node kind per IR-level operation; no language-level distinction between unitaries, noise, prep, measurement. |
| P4 — Quantum control is lexical scope | `when(q, () => …)` is coherent control; `cases(c, {…})` is classical branch. Distinct functions, distinct types. |
| P5 — No gates, no qubits | The three primitives are register-level (`prepare`, `ry`, `rz`). All gate-named functions live in `@sturm/library`. |
| P6 — QECC is `Channel → Channel` | A higher-order function that takes a function over Q types and returns one with the same shape. |
| P7 — Dimension-agnostic | `Q<T, D extends Dim>` carries a phantom dimension parameter. v0.1 ships `D = "qubit"`; the type infrastructure extends to qudits, anyons, bosons without breaking changes. |
| P8 — Numeric tower promotion | At the `run()` boundary, classical args auto-promote to declared quantum parameter types. |
| P9 — Quantum registers are a numeric type for dispatch | TS function overloading provides `not(boolean)` / `not(QBool)`, `+(boolean,boolean)` / `+(QBool,QBool)`, etc. The Bennett `oracle()` lift handles the type-restricted classical case. |

---

## 2. Type surface (`@sturm/core`)

### 2.1 Brand symbols

```ts
declare const QBrand: unique symbol
declare const WidthBrand: unique symbol
declare const ClassicalBrand: unique symbol
```

Unexported. Users cannot construct or name these.

### 2.2 Quantum types

```ts
export type Dim = "qubit" | "qudit" | "anyon" | "boson"

export interface Q<T, D extends Dim = "qubit"> {
  readonly [QBrand]: { readonly value: T; readonly dim: D }
}

export type QBool = Q<boolean>

export interface QInt<W extends number = 32> extends Q<number> {
  readonly [WidthBrand]: W
}
```

`Q<T>` is structurally unrelated to `T`. `let x: boolean = q` is a TS error,
not a lint warning. This is P2 enforced for assignment without ceremony.

`QInt<W>` extends `Q<number>` for generic-algorithm convenience but adds a
phantom width brand so `QInt<8>` and `QInt<16>` are distinct types.

### 2.3 Classical reference type

```ts
export interface Classical<T> {
  readonly [ClassicalBrand]: T
}
```

A symbolic reference to a measurement outcome. Resolved to `T` at the end of
`run()`. Branching on a `Classical<boolean>` goes through `cases`, not `if`.

### 2.4 The output-resolution mapped type

```ts
type ResolveClassical<T> =
  T extends Classical<infer U> ? U :
  T extends readonly [infer A, ...infer Rest]
    ? readonly [ResolveClassical<A>, ...ResolveClassical<Rest>] :
  T extends Array<infer E> ? Array<ResolveClassical<E>> :
  T extends object ? { [K in keyof T]: ResolveClassical<T[K]> } :
  T
```

`run(f, …)` returns `ResolveClassical<ReturnType<F>>`. `Classical<bool>`
becomes `boolean` in the resolved output; `Q<T>` values cannot leak (see
`no-circuit-leak` lint rule).

---

## 3. Primitives

### 3.1 The three operations

```ts
export function prepare(p: number): QBool
export function ry(q: QBool, delta: number): void
export function rz(q: QBool, delta: number): void
```

`prepare(p)` produces `√(1−p) |0⟩ + √p |1⟩`. (The Bernoulli-as-amplitude
reading is mandatory for `prepare(0.5)` to give the textbook Bell pair when
followed by `when(a, () => not(b))`.)

`ry(q, δ)` rotates `q` by angle `δ` about the y-axis on the Bloch sphere.
`rz` likewise about z. These are the universal continuous-rotation generators
(combined with `cnot`-via-`when`).

These are the only operations in the language. Every named gate is derived.

### 3.2 The three structural operators

```ts
// P2 — explicit measurement cast
export function observe(q: QBool): Classical<boolean>

// P4 — coherent quantum control
export function when(control: QBool, body: () => void): void

// P4 — classical branch on measurement result
export function cases<T>(
  c: Classical<boolean>,
  arms: { false: () => T; true: () => T }
): T
```

`observe` is the boundary out (P2). `when` and `cases` are control flow.
None of these is an "operation" in the P3 sense — they don't act on wires
the way `ry` does; they shape control flow.

### 3.3 Auxiliary

```ts
export function discard(q: QBool): void
```

Partial trace. Explicit because it loses information (P2-adjacent).

### 3.4 Calling outside `run()` throws

```ts
prepare(0.5)
// Error: prepare() called outside run(). Wrap in run(f, opts) to execute.
```

Documented; clear message; agents handle the fix-up trivially.

---

## 4. Channels are functions

There is no `Channel<I, O>` type. A function whose signature involves
quantum types *is* a CPTP map. Composition is calling.

```ts
function bellPair(): [QBool, QBool] {
  const a = prepare(0.5)
  const b = prepare(0)
  when(a, () => not(b))
  return [a, b]
}

function measureBell(): [Classical<boolean>, Classical<boolean>] {
  const [a, b] = bellPair()
  return [observe(a), observe(b)]
}
```

`bellPair` is a channel because `QBool` appears in its return type.
`measureBell` is a channel because it calls `bellPair`. Composition is
function calling.

### 4.1 Optional combinators

For point-free style when ergonomic:

```ts
export function then<F, G>(f: F, g: G): /* composed */
export function tensor<F, G>(f: F, g: G): /* product */
```

Convenience helpers, not load-bearing. v0.1 may ship `then` and `tensor`;
defer `trace` to v0.2 where the type-level partial-trace machinery is
worked out.

### 4.2 Channel-as-type-predicate (deferred)

A type-level `IsChannel<F>` predicate is *not* part of v0.1. The principle
"functions are channels" holds at the semantic level; the type system
enforces it via the unforgeability of `Q<T>` (you cannot construct a
`Q<T>` outside `prepare`, so any function that returns one must have called
into the tracer). Reconsider in v0.2 if higher-order combinators in
`@sturm/qecc` benefit.

---

## 5. The implicit tracer

### 5.1 Module-internal state

```ts
// Not exported
let _tracer: Tracer | null = null

class Tracer {
  ir: IRNode[] = []
  whenStack: WhenContext[] = []

  prepare(p: number): QBool {
    const wire = this.allocWire()
    this.emit({ kind: "prepare", p, out: wire })
    return brandQ(wire) as QBool
  }
  ry(q: QBool, delta: number): void { … }
  rz(q: QBool, delta: number): void { … }
  observe(q: QBool): Classical<boolean> { … }
  beginWhen(q: QBool): WhenContext { … }
  endWhen(ctx: WhenContext): void { … }
  // …
}
```

### 5.2 `run()`

```ts
export interface RunOptions<Args> {
  backend: Backend
  args?: Args
  shots?: number
}

export interface RunResult<O> {
  output: ResolveClassical<O>
  measurements: Map<ClassicalRef, boolean>
  shots: number
}

export async function run<F extends (...args: any[]) => any>(
  f: F,
  opts: RunOptions<Parameters<F>>
): Promise<RunResult<ReturnType<F>>> {
  if (_tracer) throw new Error("nested run() not supported in v0.1")
  const tracer = new Tracer()
  _tracer = tracer
  let traced: ReturnType<F>
  try {
    const args = promote(opts.args ?? [], parameterTypes(f))   // P8
    traced = f(...args)
  } finally {
    _tracer = null
  }
  return execute(tracer.ir, traced, opts.backend, opts.shots ?? 1)
}
```

### 5.3 Tracing must be deterministic

Channel functions must be pure during the tracing pass: no closures over
mutating state, no `Math.random()`, no `Date.now()` in trace path. Document
prominently. The tracer ships a `STURM_CHECK_DETERMINISM=1` mode that traces
twice and compares IR; defaults off in production.

### 5.4 Why module-level state, not threaded `ctx`

The implicit-context pattern is idiomatic TS — used by React hooks, Vue's
`reactive()`, signals libraries, Node's `AsyncLocalStorage`, OpenTelemetry's
`startSpan`. Threading a `ctx` parameter through every channel function
would be unidiomatic *and* would make P1 false at the type level. The trade
is one piece of module-mutable state for the tracer; in return, every
channel signature reads as a pure function over quantum types.

The cost: nested `run()` is disallowed in v0.1. v0.2 may lift this via
`AsyncLocalStorage` if testing harnesses or parallel tracing demand it.

---

## 6. The IR

```ts
type WireId = number   // module-internal, not exported

export type IRNode =
  | { kind: "prepare"; p: number; out: WireId }
  | { kind: "ry"; wire: WireId; delta: number; controls: WireId[] }
  | { kind: "rz"; wire: WireId; delta: number; controls: WireId[] }
  | { kind: "observe"; wire: WireId; ref: ClassicalRef }
  | { kind: "discard"; wire: WireId }
  | { kind: "cases"; cond: ClassicalRef; trueArm: IRNode[]; falseArm: IRNode[] }
  | { kind: "oracle"; circuit: ReversibleCircuit; inWires: WireId[]; outWires: WireId[] }
```

Notes:

- `when(c, body)` does *not* produce a separate IR node. It pushes `c` onto
  the tracer's `whenStack` for the duration of `body`. Operations emitted
  inside `body` carry `controls = [...whenStack]` in their IR node.
  This is what makes `when` lower cleanly to controlled gates.

- The IR is closed under the three primitives plus structural operators.
  Library functions emit only these node kinds. Adding a new primitive is
  a versioned spec change; adding a library function is not.

---

## 7. Lowering

The `execute` step lowers IR to backend ops:

| IR node | Backend op | Notes |
|---------|------------|-------|
| `{kind:"prepare", p:0}` | `alloc(1)` | Already in $\|0⟩$ |
| `{kind:"prepare", p:1}` | `alloc(1); x()` | |
| `{kind:"prepare", p:0.5}` | `alloc(1); h()` | |
| `{kind:"prepare", p}` (general) | `alloc(1); ry(2·asin(√p))` | |
| `{kind:"ry", controls:[]}` | `ry(δ)` | |
| `{kind:"ry", δ:π, controls:[c]}` | `cx(c, t)` | the X-via-`Ry(π)` recognition |
| `{kind:"ry", controls:[c1,c2]}` with δ=π | `ccx(c1, c2, t)` | |
| `{kind:"ry", controls:[c]}` (general δ) | `cry(c, t, δ)` or decomposed | backend-dependent |
| `{kind:"rz", controls:[]}` | `rz(δ)` | |
| `{kind:"rz", controls:[c]}` | `crz(c, t, δ)` | |
| `{kind:"observe"}` | `measure(wire)` | resolves `ClassicalRef` |
| `{kind:"discard"}` | `reset(wire)` or no-op | backend-dependent |
| `{kind:"cases"}` | classical branch on resolved ref | runtime, not backend |
| `{kind:"oracle"}` | emit reversible circuit | from Bennett |

Backends declare which controlled forms they support natively. The lowering
pass picks the best available form; a decomposition library handles the rest.

---

## 8. The library (`@sturm/library`)

Shipped alongside `@sturm/core`, included by default. Conceptually separate:
the language is `core`; the library is one possible vocabulary.

### 8.1 Single-qubit gates

```ts
// X = Ry(π) up to global phase
export function not(b: boolean): boolean
export function not(b: QBool): void
export function not(b: boolean | QBool): boolean | void {
  if (isQ(b)) { ry(b, Math.PI); return }
  return !b
}

// H = Ry(π/2)·X up to global phase
export function H(q: QBool): void {
  ry(q, Math.PI / 2)
  ry(q, Math.PI)   // = X
}

// Z = Rz(π) up to global phase
export function Z(q: QBool): void { rz(q, Math.PI) }

// S = Rz(π/2)
export function S(q: QBool): void { rz(q, Math.PI / 2) }

// T = Rz(π/4)
export function T(q: QBool): void { rz(q, Math.PI / 4) }

// Y = Ry(π) sandwiched (up to global phase)
export function Y(q: QBool): void { rz(q, Math.PI); ry(q, Math.PI) }
```

### 8.2 Two-qubit (via `when`)

```ts
// Library doesn't expose `cnot`; users write when(c, () => not(t)).
// For point-free style:
export function controlled<F extends (...a: any[]) => void>(c: QBool, f: F): F {
  return ((...a) => when(c, () => f(...a))) as F
}
```

### 8.3 Boolean-overload family (P9)

```ts
export function and(a: boolean, b: boolean): boolean
export function and(a: QBool, b: QBool): QBool        // fresh ancilla via oracle
export function or(a: boolean, b: boolean): boolean
export function or(a: QBool, b: QBool): QBool         // fresh ancilla via oracle
export function xor(a: boolean, b: boolean): boolean
export function xor(t: QBool, s: QBool): void         // in-place: t ^= s, i.e. cx(s, t)
```

`and`/`or` on `QBool` lift via `oracle((a, b) => a && b)` from
`@bennett/core`. `xor` on `QBool` is in-place (CNOT with target/source) and
emits a `ry(t, π, controls=[s])` node directly.

### 8.4 Multi-qubit conveniences

```ts
export function ghz(n: number): QBool[] {
  const qs = Array.from({ length: n }, () => prepare(0))
  H(qs[0])
  for (let i = 1; i < n; i++) when(qs[0], () => not(qs[i]))
  return qs
}

export function swap(a: QBool, b: QBool): void {
  xor(a, b)
  xor(b, a)
  xor(a, b)
}
```

### 8.5 The library is replaceable

A user who wants Qiskit-shaped names imports from a different library. A
user who wants only the three primitives imports nothing from
`@sturm/library` and writes their own derived functions. The language is
the three primitives + three structural operators; everything else is
vocabulary.

---

## 9. Lint plugin (`@sturm/eslint-plugin`)

First-class part of the spec. Ships alongside core. Documented, versioned,
considered load-bearing.

| Rule | Forbids | Severity |
|------|---------|----------|
| `no-quantum-truthy` | `if (q)`, `q ? a : b`, `!q`, `q && x`, `q ?? x` for `q : Q<…>` or `Classical<…>` | error |
| `no-classical-on-quantum` | `q == true`, `Number(q)`, etc. | error |
| `no-circuit-leak` | `Q<T>` value escaping its `run()` invocation | error |
| `prefer-when-over-cases` | `cases(observe(q), …)` where `when(q, …)` would preserve coherence | warn |
| `prepare-probability-range` | `prepare(p)` with literal `p ∉ [0, 1]` | error |
| `no-cnot-in-user-code` | calls to `cnot`, `cx`, `ccx`, `toffoli`, etc. outside `@sturm/library` and backend implementations | warn |

`no-quantum-truthy` and `no-cnot-in-user-code` together close the residual
gap that the type system can't express:

- TS will accept `if (q)` because object references coerce to truthy. Lint
  catches it.
- TS will accept user-defined `function cnot(t: QBool, c: QBool) { when(c,
  () => not(t)) }`. The lint warning nudges P5 — the user can override per-line.

---

## 10. Bennett bridge

```ts
import { oracle } from "@bennett/core"

const poly = oracle(
  (x: number): number => x*x + 3*x + 1,
  { argTypes: ["i32"] }
)
// poly : (x: QInt<32>) => QInt<32>

function useIt(x: QInt<32>): QInt<32> {
  return poly(x)   // composition is calling
}
```

`oracle(f, opts)` returns a function with the same shape as `f` but with
quantum types in the signature. By the v3 definition that function *is* a
channel. Inside `run()`, calling it emits an `oracle` IR node carrying the
compiled reversible circuit. Outside `run()`, it throws.

Optional Stage-3 decorator (when stable):

```ts
@quantum({ argTypes: ["i32"] })
function poly(x: number): number { return x*x + 3*x + 1 }
// adds a poly(x: QInt<32>): QInt<32> overload to the original function
// the original poly(5): number still works
```

This is the cleanest expression of P9: the function is the same function;
the call site picks the overload. The decorator is additive — it never
removes the classical signature.

---

## 11. QECC

```ts
import { steaneCode } from "@sturm/qecc"

const protectedBell = steaneCode(bellPair)
// protectedBell : () => [QBool, QBool]   — same signature

await run(() => {
  const [a, b] = protectedBell()
  return [observe(a), observe(b)]
}, { backend: native() })
```

`steaneCode : <F>(f: F) => F` is a function-on-functions (P6). Implementation:
trace `f` to obtain its IR, wrap each logical wire with encode/decode IR
substitutions, return a closure that when called inside `run()` replays
the wrapped IR.

The wrapper preserves the function's shape — including its return type —
so callers don't change.

---

## 12. Backend interface

```ts
export interface Backend {
  alloc(n: number): Promise<StateHandle>
  free(s: StateHandle): void

  // Single-qubit
  ry(s: StateHandle, q: number, delta: number): Promise<void>
  rz(s: StateHandle, q: number, delta: number): Promise<void>
  x(s: StateHandle, q: number): Promise<void>
  h(s: StateHandle, q: number): Promise<void>

  // Two-qubit (the gate-named ones live HERE, not in user code)
  cx(s: StateHandle, control: number, target: number): Promise<void>
  cry?(s: StateHandle, c: number, t: number, delta: number): Promise<void>
  crz?(s: StateHandle, c: number, t: number, delta: number): Promise<void>

  // Multi-qubit
  ccx?(s: StateHandle, c1: number, c2: number, t: number): Promise<void>

  // Boundary
  prepare(s: StateHandle, q: number, p: number): Promise<void>
  measure(s: StateHandle, q: number): Promise<boolean>
  reset(s: StateHandle, q: number): Promise<void>
}
```

Optional methods are decomposed by the lowering pass when not provided.

The `Backend` interface is where gate names are appropriate. P5 forbids
gates from *user code*, not from runtime infrastructure. A backend
implementer working with `cx` is at the right level of abstraction.

---

## 13. Worked examples

### 13.1 Bell pair

```ts
function bellPair(): [QBool, QBool] {
  const a = prepare(0.5)
  const b = prepare(0)
  when(a, () => not(b))
  return [a, b]
}

function measureBell(): [Classical<boolean>, Classical<boolean>] {
  const [a, b] = bellPair()
  return [observe(a), observe(b)]
}

const r = await run(measureBell, { backend: native(), shots: 1000 })
// r.output : [boolean, boolean] — 50% [false,false], 50% [true,true]
```

### 13.2 GHZ

```ts
function ghz3(): [Classical<boolean>, Classical<boolean>, Classical<boolean>] {
  const [a, b, c] = ghz(3)
  return [observe(a), observe(b), observe(c)]
}
```

### 13.3 Coherent vs classical control

```ts
function coherent(): Classical<boolean> {
  const ctrl = prepare(0.5)
  const target = prepare(0)
  when(ctrl, () => ry(target, Math.PI / 4))
  return observe(target)
}

function classicalBranch(): Classical<boolean> {
  const a = prepare(0.5)
  const m = observe(a)
  const b = prepare(0)
  return cases(m, {
    true:  () => { not(b); return observe(b) },
    false: ()  => observe(b),
  })
}
```

### 13.4 Phase kickback (Bennett oracle in superposition)

```ts
const isTarget = oracle(
  (x: number): boolean => x === 42,
  { argTypes: ["i8"] }
)

function phaseKickback(): Classical<number> {
  // Prepare register in uniform superposition
  const reg = QInt8.zero()
  for (const q of bits(reg)) ry(q, Math.PI / 2)   // = H, via library

  // Oracle call — flag bit picks up the phase
  const flag = isTarget(reg)
  rz(flag, Math.PI)    // phase flip on the answer

  // Measurement after diffusion (omitted)
  return measureInt(reg)
}
```

### 13.5 P8 promotion at the boundary

```ts
function shor(N: QInt<32>): Classical<number> { /* … */ }

await run(shor, { backend: native(), args: [15] })
//                                          ^^ classical 15 promoted to QInt<32>(15)
```

---

## 14. Module structure

```
@sturm/core
  ├── types          Q, QBool, QInt, Classical, Dim
  ├── primitives     prepare, ry, rz, observe, when, cases, discard
  ├── run            run, RunOptions, RunResult
  ├── ir             IRNode, lowering tables
  └── backend        Backend interface

@sturm/library       (depends on core)
  ├── single-qubit   not, H, X, Y, Z, S, T
  ├── two-qubit      controlled, swap
  ├── boolean        and, or, xor (overloaded)
  ├── multi-qubit    ghz, qft, …
  └── algorithms     grover, deutsch_jozsa, …

@sturm/eslint-plugin (depends on core types)
  └── rules          no-quantum-truthy, no-classical-on-quantum,
                     no-circuit-leak, prefer-when-over-cases,
                     prepare-probability-range, no-cnot-in-user-code

@sturm/qecc          (depends on core)
  └── codes          steaneCode, surfaceCode, repetitionCode

@sturm/backends      (each depends on core)
  ├── native         in-process simulator
  ├── tracing        IR-only, no execution
  └── density        density-matrix simulator

@bennett/core        (independent; consumed by @sturm via oracle)
  └── oracle         classical → reversible quantum circuit lift
```

`@sturm/core` exports the language — three primitives, three structural
operators, types. `@sturm/library` is the standard vocabulary. The two are
versioned independently; library v0.X.Y can ship new gates without
re-versioning the language.

---

## 15. Open questions for v0.1 freeze

1. **`prepare(p)` semantics — confirmed amplitude.** `prepare(p)` produces
   $\sqrt{1-p}\,|0⟩ + \sqrt{p}\,|1⟩$. Mark resolved.

2. **`when` body return type.** Currently `() => void`. Sturm.jl permits the
   body to return auto-controlled wires. Proposed TS form:

   ```ts
   export function when<R>(control: QBool, body: () => R): R
   ```

   Returned `Q<T>` values from the body carry the controlled-context
   semantics in the IR. Pin before v0.1 — affects IR shape.

3. **`AsyncLocalStorage` for nested `run()`.** Defer to v0.2. v0.1 throws on
   nesting.

4. **Decorator path for `@quantum`.** Stage-3 decorators are stable in TS
   5.0+; viable for v0.1 if we accept a TS 5.0 minimum. Otherwise the
   `oracle()` builder is the only path. Lean: ship both, prefer `oracle()`
   in docs, mention the decorator as ergonomic sugar.

5. **`Classical<T>` truthiness.** Lint covers `if (c)`. Acceptable, given
   that the alternative (a tagged-template-or-similar shape that fails at
   use) costs ergonomics. Mark resolved as "lint-enforced".

---

## 16. Migration from v2

- Replace `cnot(target, control)` calls with `when(control, () => not(target))`.
- Move all gate-name imports (`H`, `X`, `cnot`, `not`, etc.) from
  `@sturm/core` to `@sturm/library`.
- The four-primitive list is now three: drop `cnot` from any P3 mention.
- The `Backend` interface keeps `cx`, `ccx` — runtime layer unchanged.
- Lint rule `no-cnot-in-user-code` is new; fixes are mechanical.

---

*v3 is the v0.1 specification target. Sections 1–14 are normative. §15 is
the freeze checklist. §16 is informational.*
