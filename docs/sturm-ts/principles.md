# Sturm-TS — Design Principles (v3.1)

These are the axioms of the language. Every design decision —
in the TS frontend, in the IR encoding, in any workbench tool that
consumes a Sturm channel — must be consistent with them. If an
implementation choice violates any principle, the implementation is
wrong.

This document captures the principles as they apply to *both* the TS
surface and the IR-as-Value layer. Where the two layers express the
same principle differently, both forms are noted.

## §1. Axioms

| # | Principle | One-line |
|---|-----------|----------|
| P1 | Functions are channels | A function with quantum arguments IS a CP map; composition of functions is composition of channels. |
| P2 | Type-level classical/quantum distinction | `Q<T>` is structurally unrelated to `T`; cq/qc/qq channels are the morphisms that cross the type-level divide. |
| P3 | Operations are operations | No language-level distinction between unitaries, measurements, preparations, noise channels, partial traces. |
| P4 | Quantum control is lexical scope | `when(q) { … }` is quantum control; `if c { … }` is classical branch. Type-enforced. |
| P5 | No gates, no qubits | The programmer never names a gate and never indexes individual qubits; registers and the four primitives only. |
| P6 | QECC is a higher-order function | Error correction is a function `Channel → Channel`. Not a language feature. |
| P7 | Dimension-agnostic across the entire Hilbert spectrum | Finite qudits, anyons, infinite-dimensional systems must all be expressible by *extending* the type hierarchy. |
| P8 | Numeric promotion at the boundary | Mixed classical+quantum operations promote classical → quantum, like `Int + Float64 → Float64`. |
| P9 | Quantum registers are a numeric type for dispatch | Generic functions ride them; typed-classical functions explicitly lift via `oracle` / `@quantum_lift` / `quantum`. |

## §1.1 — The principles in detail

### P1 — Functions are channels

A TS function with quantum arguments IS a CP map (completely positive,
possibly trace non-increasing). Its type signature determines the
channel type. Composition of functions is composition of channels.
There is no separate "channel" wrapper the programmer must use.

CPTP (trace-preserving) maps are the common case, but trace
non-increasing maps are first-class: post-selection, conditional
operations, and probabilistic channels (a single branch of an RUS
synthesiser) are all expressible. The type system does not enforce
trace preservation — that is a property the programmer or verifier
may check, not a constraint the language imposes.

**At the IR layer (ADR-0006):** P1 is preserved under representation
change. A channel is the protocol object whether encoded as a TS
function over quantum types or as `expr("channel", […])`. The TS
frontend (`sturm-trace`) is one of several ways to materialise an
IR Value; an agent constructing the IR directly (no trace) preserves
P1 just as well.

### P2 — Type-level classical/quantum distinction (v3.1 amendment)

The type system separates classical types (`bool`, `number`, etc.)
from quantum types (`Q<T>`, `QBool`, `QInt<W>`, `QMod<N>`). The two
are structurally unrelated: `Q<bool>` is not a subtype, supertype, or
implicit-coercible form of `bool`.

**cq channels** (`prepare`, `oracle`) are channels that take classical
input and produce quantum output. They are the morphisms `T → Q<T>`
that cross from classical types into quantum types.

**qc channels** (`observe`) take quantum input and produce classical
output. They are the morphisms `Q<T> → T` (with information loss)
that cross from quantum types into classical types.

**qq channels** include `ry`, `rz`, `oracle` when applied internally,
and also `discard` (the morphism `Q<T> → ⊤`, the qq → terminal channel
realising partial trace).

All of the above — including `prepare`, `observe`, and `discard` —
are *channels in the same category as `ry`, `rz`*. They are uniformly
node-shaped in the IR. There is no separate "boundary primitive"
category that elevates them above other ops. The boundary is a
**type-level fact** (which arrows the type system admits), not a
channel-level distinction (some channels being more privileged than
others).

**Why this matters.** The earlier (v3) framing called `prepare` and
`observe` "boundary operations" and described P2 as "the boundary is
a cast." That framing inadvertently clashed with P3 (op-is-op):
elevating two specific channels above the rest is exactly the kind of
syntactic-special-casing that P3 forbids. The v3.1 reframe restores
the symmetry: the type system separates the worlds; channels are the
arrows; some arrows happen to cross the type divide and others don't.

**Implicit-cast warnings still apply.** Because qc channels lose
information irreversibly, an implicit assignment `let x: bool = q;`
where `q: QBool` triggers a compiler warning, by direct analogy with
the implicit float-to-int truncation warnings that sensible languages
emit. The fix is always to wrap in an explicit `observe(q)` (or a
typed `bool(q)` cast that lowers to `observe`). Information loss must
be intentional. (This is the surface-level safety; at the IR layer,
the explicit `observe` op is always present, so the discipline is
captured structurally.)

**Open question Q5 — `Classical<T>` truthiness.** Whether a classical
register `Classical<bool>` participates in `if`-truthiness rules
without an explicit `bool()` cast is a v3-era open question; it is
unaffected by this amendment.

### P3 — Operations are operations

There is no language-level distinction between unitaries, measurements,
preparations, noise channels, partial traces, or oracles. They are all
channels. Whether the backend uses state vectors, density matrices,
tensor networks, or a real QPU is a runtime detail invisible to the
programmer.

**At the IR layer (ADR-0006):** the seven op heads `prepare`, `ry`,
`rz`, `observe`, `oracle`, `cases`, `discard` are peer entries in a
closed `S.union`. None has a structurally privileged shape.

### P4 — Quantum control is lexical scope

`when(q) { … }` means "control on q." `if c { … }` means "classical
branch on c." The distinction is enforced by types: `when` takes
`QBool`, `if` takes `bool`. The boundary is syntactically explicit.

**P4 corollary — `if q` does NOT auto-lift to `when(q)`.** An `if`
statement on a `QBool` is the implicit-cast warning from P2:
measurement, then a classical branch on the resulting `bool`. Silent
promotion of `if q` to `when(q) { … }` would collapse two distinct
channels (post-measurement classical branch vs. coherent controlled
unitary) into one syntactic form whose meaning depends on type. That
is a type lie. Coherent quantum control is spelled `when(q) { … }` —
and only that.

**At the IR layer (ADR-0006):** `when` is *not* its own op-node head.
Lexical `when(q) { body }` lowers to ops in `body` whose `controls`
field includes `q`'s wire ID. An IR consumer reads the lowered form;
a TS-source author reads the lexical form; the two surfaces describe
the same channel.

### P5 — No gates, no qubits

The programmer never names a gate and never manipulates individual
qubits. The programmer works with quantum registers (`QBool`, `QInt<W>`,
`QMod<N>`) and the four primitives (`prepare`, `ry`, `rz`, controlled-
oracle / `cnot`-equivalent).

Named gates (H, T, CNOT, etc.) exist only as convenience library
functions in the frontend. Individual qubit indexing exists for oracle
construction but is not the normal mode of programming. The correct
test for this principle: if a program reads like a circuit diagram
transcribed into code, it is wrong.

**At the IR layer (ADR-0006):** P5 is *structurally enforced* — the
op-node `S.union` is closed, so an op with head `"cnot"` or
`"hadamard"` is a schema validation failure, not a lint warning.
Gate-named ops cannot enter the IR even by accident.

### P6 — QECC is a higher-order function

Error correction wraps a channel in encoding / syndrome / correction /
decoding channels. It is a function `Channel → Channel`. It is not a
language feature, an annotation, or a pragma. It is a library function.

**At the workbench layer:** `sturm-qecc-wrap` (issue scientist-
workbench-8e8) is the tool. Its schema is `record { channel, code }
→ channel`. Its P6 invariant is that `output.input_signature`
deep-equals `input.input_signature` and same for outputs — encoding
preserves the channel's logical signature.

### P7 — Dimension-agnostic across the entire Hilbert spectrum

The core type system and channel algebra must not assume qubits
(d=2). All of the following must be expressible by *extending* the
type hierarchy — never by modifying the core:

- **Finite qudits.** Qutrits (d=3), arbitrary qudits (`QDit<D>`).
  The four primitives generalise to `Ry_D` / `Rz_D` on `su(D)`
  generators.
- **Anyons.** Fusion-category wires, with braiding and F-/R-moves as
  primitive-level operations. Topological charge is a type parameter.
- **Infinite-dimensional systems.** At minimum, Gaussian CV for
  quantum optics: bosonic modes, displacement, squeezing,
  beamsplitters, phase rotation, and homodyne/heterodyne measurement
  — all expressible as channels on a covariance-matrix context.
  Ideally: arbitrary infinite-dimensional systems, full Fock-space
  arithmetic, bosonic codes (cat, binomial, GKP).

The test is mechanical: if adding qutrits, anyons, or a Gaussian
optical mode requires *any* change to channel composition operators,
the tracing infrastructure, `when()`, the cast rules of P2, or the
promotion rules of P8, the abstraction is wrong. v0.1 implements d=2
only, but no design decision may foreclose higher finite d, topological
d, or infinite d.

**At the IR layer (ADR-0006):** wires carry an optional `dim` field
that is `S.union` over `"qubit" | "qudit" | "anyon" | "boson"`. v0.1
emits only `"qubit"`; the schema admits the others additively, and
the op-node vocabulary (which is dimension-agnostic in shape — `ry`
is just an angle on a wire) does not need to change to admit them.

### P8 — Numeric promotion at the boundary

When a classical value participates in an operation with a quantum
value (`QInt<8>(42) + 17`), the classical value auto-promotes to the
corresponding quantum type — just as `Int + Float64 → Float64`.

Initial quantum construction is explicit: `QInt<8>(42)` is preparation
(a physical operation), analogous to `complex(1)`. Mixed-type methods
extract context and width from the quantum operand.

Promotion is always classical → quantum; quantum → classical requires
a qc channel (`observe`) per P2. Gates and `when` do NOT participate
in promotion — they require exact quantum types.

### P9 — Quantum registers are a numeric type for dispatch

A plain TS function works on a quantum argument exactly the way it
works on `number` or `bigint` — via operator overloading, not via a
hidden catch-all. This is the same mechanism `ForwardDiff.Dual` uses
to ride existing Julia code: respect the language's type contract,
extend the operator table.

```ts
function f(x: number | Q<number>): number | Q<number> {
  return x * x + 3 * x + 1;
}
f(5);                     // number — works (number's *, + are defined)
f(QInt<8>(5));            // QInt<8> — works (QInt's *, + are defined; P8)
```

Type-restricted classical functions wall out other types — quantum
included, just like `number`-typed methods wall out `string`. This is
not a bug; it is the type contract working correctly:

```ts
function g(x: number): number { return x * x + 3 * x + 1; }
g(QInt<8>(5));            // type error — by design
```

The bridge for typed classical functions is explicit:

1. **`oracle(g, q)`** — extracts the LLVM IR for `g`, lowers to a
   reversible circuit (Bennett.jl analogue, ported as `sturm-bennett-
   oracle` in Phase 2), produces an IR oracle node.
2. **`@quantum_lift`** — a TS decorator that adds a typed quantum
   overload using `oracle` under the covers.
3. **`quantum(g)`** — explicit precompile handle.

A language-level catch-all that secretly re-routes `g(q)` to a
reversible-circuit compile would be a type lie: it would pretend
`number`-typed code can take a different argument. P9 does not add
one. The user declares the lift; the compiler does not guess.

## §2. References

- ADR-0006 — IR-as-Value encoding; the structural realisation of P1,
  P3, P5 at the workbench layer.
- ADR-0005 — externalised entropy; the contract amendment that lets
  measurement (qc channels per P2) and sampling participate in the
  workbench's deterministic-by-default model.
- ADR-0007 — distribution-vs-sampling; the operational realisation
  of Born's rule given P2's framing of `observe` as a qc channel.
- `Sturm.jl/Sturm-PRD.md` §1 — the original Julia-side principles
  text; the v3.1 amendment in this file aligns with that source on
  P1, P3–P9 and amends P2 only.
- shard 009 (`docs/worklog/009-sturm-ts-port-planning.md`) — the
  planning shard that motivated the v3.1 amendment.
