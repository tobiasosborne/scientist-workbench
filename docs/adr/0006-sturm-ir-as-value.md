# ADR-0006 — IR-as-Value encoding for Sturm channels

**Status:** Accepted (2026-04-29)
**Context:** beads issue scientist-workbench-x9x
**Related:** ADR-0005 (entropy admission, the substrate this IR's
sampling tools rely on), ADR-0007 (distribution-vs-sampling, the
operational split for the IR's executor),
`docs/sturm-ts/principles.md` (the principles the IR realises).

## Context

Sturm-TS is a TypeScript port of `Sturm.jl` — a quantum-programming
language where functions are channels and the quantum-classical
boundary is a type-level distinction. In `Sturm.jl`, a program is a
Julia function that the runtime traces into a DAG IR. The TS port
preserves this surface: a user writes channels as TS functions over
quantum types, and a tracer materialises a DAG IR.

For scientist-workbench integration, the question is: *what is the
protocol object?* Two options:

- **Tracer-as-tool, IR-as-internal.** The tracer is a tool
  (`sturm-trace`); its input is TS source; the IR is an implementation
  detail. Every other Sturm tool consumes TS source and re-traces.
- **IR-as-Value.** The IR is itself a canonical Value flowing through
  the pipeline. The tracer is *one* of several ways to materialise
  an IR Value (others: an agent constructs the IR directly; a
  transpiler from QASM; a synthesiser from a higher-level spec).

The first option is what a port-the-existing-stack reflex would
suggest. The second is what the substrate's contract makes possible
and natural:

- The IR is content-addressed once it is a Value. Every channel has a
  hash. Every transformation has provenance.
- Every Sturm tool becomes stateless and pure — input IR Value, output
  IR Value (or a derived shape).
- Equivalence claims are reproducible: `sturm-equivalent(a, b)` is a
  function of two hashes.
- Closure of the IR vocabulary is enforced by the schema — at the
  workbench layer, a `cnot` op-node is a *schema validation failure*,
  not a lint warning, which makes P5 ("no gates, no qubits") a
  hard structural property rather than a stylistic guideline.

The principles preserved (`docs/sturm-ts/principles.md`):

- **P1 (functions are channels)** survives unchanged — it is preserved
  under representation change. A channel is the protocol object whether
  encoded as `function bellPair() {…}` or as `expr("channel", […])`.
  The TS frontend and the IR are two ways to write the same arrow in
  CPTP.
- **P2 (type-level classical/quantum distinction)** holds at the IR
  level: classical and quantum wires are distinct (`wire.kind`); cq
  channels (`prepare`, `oracle`) and qc channels (`observe`) are the
  morphisms that cross the distinction. They are uniformly node-shaped
  — there is no "boundary primitive" category that elevates them above
  `ry` or `rz`.
- **P3 (op-is-op)** is realised exactly because of the previous point:
  every op node is a peer.
- **P5 (no gates, no qubits)** is enforced by the closed schema union.

This ADR fixes the IR-as-Value encoding so that all downstream Sturm
tools (`sturm-simplify`, `sturm-execute`, `sturm-equivalent`,
`sturm-sample`, `sturm-trace`, `sturm-bennett-oracle`,
`sturm-qecc-wrap`, the combinator tools) agree on shape.

## Decision

A Sturm channel is an `expression` Value with head `"channel"` and
three positional arguments:

```ts
expr("channel", [
  inputSignature,   // list<wire>
  outputSignature,  // list<wire>
  body,             // list<op>
])
```

A wire is a record:

```ts
record({
  id:    int(<unique-within-channel>),
  kind:  str("classical" | "quantum"),
  dim:   str("qubit" | "qudit" | "anyon" | "boson"),  // optional; v0.1 uses "qubit"
})
```

Wire IDs are scoped to the enclosing channel (a wire ID `0` in one
channel and `0` in another are unrelated). When channels compose, the
combinator tools rename to avoid clashes.

The op-node vocabulary is closed — exactly seven heads:

| Head        | Args (positional)                                                    | Semantics                                                               |
|-------------|----------------------------------------------------------------------|-------------------------------------------------------------------------|
| `prepare`   | `[ p, wire_id ]`                                                     | cq channel: produces wire in `√(1−p)\|0⟩ + √p\|1⟩`. `p` is rational or expression. |
| `ry`        | `[ wire_id, delta, controls ]`                                       | Y-rotation by `delta`. `controls` is a `list<wire_id>` (empty for unconditional). |
| `rz`        | `[ wire_id, delta, controls ]`                                       | Z-rotation by `delta`. `controls` is a `list<wire_id>` (empty for unconditional). |
| `observe`   | `[ wire_id, classical_ref ]`                                         | qc channel: projects `wire_id` and binds the result to `classical_ref` (a string ID, scoped to the channel). |
| `oracle`    | `[ circuit, in_wires, out_wires ]`                                   | reversible classical oracle (e.g., from `sturm-bennett-oracle`).       |
| `cases`     | `[ classical_ref, true_arm, false_arm ]`                             | classical branch on a previously-bound `classical_ref`. Each arm is `list<op>`. |
| `discard`   | `[ wire_id ]`                                                        | qq → terminal channel (partial trace).                                  |

`controls` (on `ry` and `rz` only) is a `list<wire_id>`, always
present in the IR Value form, empty for unconditional rotations. It
is the lowered form of the v3 PRD's `whenStack`: a `when(q) do … end`
nesting in the source surface compiles to inner `ry`/`rz` ops whose
`controls` field contains `q`'s wire ID. Carrying controls only on
the single-qubit rotations is the principled choice — they are the
unitary primitives of the language; preparation is a cq channel
(use a `ry` if you need a controlled rotation onto a prepared wire),
oracles are separable subcircuits (lift the `when` to control the
oracle's *inner* ops), and `observe`/`cases`/`discard` are
non-unitary so coherent control on them is not well-defined.

`when` is *not* itself an op-node head. The `whenStack` is visible
*only* as the `controls` field on inner ops. This is a deliberate
simplification per shard 009: `when` is a syntactic frame around a
body, and the frame's effect is captured op-by-op at compile time;
keeping it out of the IR means optimisation passes don't have to
descend into another tree shape.

## Worked examples

### Bell pair

A standard Bell-pair preparation, written with the closed vocabulary.
Two quantum wires, one cnot-equivalent (an `ry(π)` on wire 1 controlled
by wire 0 — note that the IR uses the four-primitive vocabulary, so
"CNOT" is not a thing; it's a controlled Y-rotation by π up to global
phase). For readability, this example uses an `ry`-by-π/2 on wire 0
to put it into superposition and then a controlled `ry`-by-π on wire 1.

```ts
// Wires
const w0 = record({ id: int(0n), kind: str("quantum"), dim: str("qubit") });
const w1 = record({ id: int(1n), kind: str("quantum"), dim: str("qubit") });

// The channel
expr("channel", [
  list([]),                              // no input wires (channel allocates)
  list([w0, w1]),                        // outputs w0, w1
  list([
    // prepare both in |0⟩
    expr("prepare", [rat(0n, 1n), int(0n)]),
    expr("prepare", [rat(0n, 1n), int(1n)]),
    // Hadamard-equivalent on w0: ry(π/2)
    expr("ry", [int(0n), expr("/", [sym("π"), int(2n)]), list([])]),
    // controlled-ry(π) on w1, controlled by w0 — Bell entanglement
    expr("ry", [int(1n), sym("π"), list([int(0n)])]),
  ]),
])
```

The Bell channel hash is then a content-addressed identifier for the
above structure; any tool consuming it can re-execute or analyse it.

### GHZ state on three wires

```ts
expr("channel", [
  list([]),
  list([w0, w1, w2]),
  list([
    expr("prepare", [rat(0n, 1n), int(0n)]),
    expr("prepare", [rat(0n, 1n), int(1n)]),
    expr("prepare", [rat(0n, 1n), int(2n)]),
    expr("ry", [int(0n), expr("/", [sym("π"), int(2n)]), list([])]),
    expr("ry", [int(1n), sym("π"), list([int(0n)])]),
    expr("ry", [int(2n), sym("π"), list([int(0n)])]),
  ]),
])
```

The same pattern as Bell, with the controlled rotation broadcast to
both `w1` and `w2` from `w0`. The `controls` field carries the same
wire ID on both ops; the closure of the IR vocabulary forces the
optimisation pass (`sturm-simplify`) to see these as two independent
controlled ops, not as a single n-target gate.

### Phase kickback

A canonical primitive in phase-estimation circuits: an oracle on a
target register induces a phase on the control register. Pseudo-code,
elided for brevity (the full IR with oracle and post-rotations is
several dozen ops; the worked example lives in `tools/sturm-execute/
goldens.spec.ts` once the tool ships in Phase 1):

```ts
expr("channel", [
  list([control_wire, target_wires...]),
  list([control_wire, target_wires...]),
  list([
    // prepare control in |+⟩
    expr("ry", [control_id, expr("/", [sym("π"), int(2n)]), list([])]),
    // apply oracle controlled by control_wire
    expr("oracle", [oracle_circuit, list([control_id, ...target_ids]), list([...output_ids])]),
    // post-rotate control to read off phase
    expr("ry", [control_id, expr("-", [expr("/", [sym("π"), int(2n)])]), list([])]),
    // observe control
    expr("observe", [control_id, str("phase_bit")]),
  ]),
])
```

The key observation: the oracle is itself an IR Value (the output of
`sturm-bennett-oracle`), so it round-trips through the substrate
unmodified. Composition is by-pipe and by-Value; the agent never
touches a "circuit object" with internal mutable state.

## The schema in one place

Once `packages/sturm-ir` lands (issue scientist-workbench-dwg, Phase 1),
the canonical schema declaration is:

```ts
import { S } from "@workbench/protocol";

export const wireSchema = S.record({
  id:   S.kind("integer"),
  kind: S.union([S.literal(str("classical")), S.literal(str("quantum"))]),
  dim:  S.union([
    S.literal(str("qubit")),
    S.literal(str("qudit")),
    S.literal(str("anyon")),
    S.literal(str("boson")),
  ]),
}, { optional: ["dim"] });

export const opSchema = S.union([
  S.expression("prepare",  [/* p, wire_id */]),
  S.expression("ry",       [/* wire_id, delta, controls */]),
  S.expression("rz",       [/* wire_id, delta, controls */]),
  S.expression("observe",  [/* wire_id, classical_ref */]),
  S.expression("oracle",   [/* circuit, in_wires, out_wires */]),
  S.expression("cases",    [/* classical_ref, true_arm, false_arm */]),
  S.expression("discard",  [/* wire_id */]),
]);

export const channelSchema = S.expression("channel", [
  S.list(wireSchema),
  S.list(wireSchema),
  S.list(opSchema),
]);
```

The closure is the load-bearing fact: `S.union` over exactly the seven
op heads means an op with head `"cnot"` or `"hadamard"` fails schema
validation in the runner. P5 enforced as a structural type property.

## Consequences

**Positive.**

- The IR has a hash. Every channel is content-addressed.
- Sturm tools are pure functions on Values. Stateless. Provenance-clean.
- P5 (no gates, no qubits) is structurally enforced by the closed
  union, not just by code review.
- prepare and observe are uniformly node-shaped; P3 (op-is-op) is
  realised exactly. The v3.1 amendment to P2 (cf. `docs/sturm-ts/
  principles.md`) is reflected in the IR by *not* having a separate
  "boundary" category.
- Foreign-pass-through composes naturally: a tool encountering an
  unknown op head wraps it in `tagged "<tool>/out-of-scope"` per
  ADR-0003, and the rest of the body still round-trips.

**Negative.**

- A textual surface for writing IR by hand is verbose. Mitigation:
  helper builders in `packages/sturm-ir` (e.g., `prepareOp(p, w)`,
  `ryOp(w, δ, controls = [])`) keep agent-written IR concise without
  inventing a second IR shape. Helpers are TS, not protocol — they
  produce canonical Values.
- Wire-ID scoping rules require care during composition. `sturm-tensor`
  must rename to avoid collisions; the renaming scheme is documented
  in the combinator tools' READMEs.
- Adding a new op head is a breaking schema change. This is correct
  but means new vocabulary needs an ADR + a coordinated release.
  Alternatives like a `gate` op-head as an extension point are
  rejected: the closure is the property we want.

## Alternatives considered

**Tracer-as-tool, IR-as-internal.** Rejected. The IR being internal
forces every Sturm tool to consume TS source, which couples every tool
to the trace runtime, undoes content-addressing for channels, and
elevates the tracer to a privileged role that P1 explicitly does not
require. P1 is preserved under representation change; the tracer is
demoted to one of several frontends.

**Open op vocabulary.** Rejected. Open vocabulary means a `cnot` op-node
is admitted; the workbench's whole pitch over a TS+lint setup is that
the schema enforces P5 structurally. Open vocabulary recovers the
TS+lint situation.

**`when` as its own op-node head with a body.** Considered and rejected
in shard 009. `when(q) do … end` lowered to ops-with-controls is
simpler: optimisation passes see a flat list of ops, each carrying its
own control-set. A nested `when` op would need its own descent during
every traversal. The `whenStack` lowering happens once at IR
construction.

**Gate names as op heads.** Rejected; this is the v3 PRD's "no gates,
no qubits" principle (P5) made structural. Library-level gates are
*derived* in the frontend from the four primitives; they do not appear
in the IR.

**Wire IDs global across channels.** Rejected. Global IDs would force
every channel-producing tool to coordinate a global namespace. Local
scoping plus rename-on-compose is local to the combinators that need
it.

## Pointers

- `docs/sturm-ts/principles.md` — P1–P9, with the v3.1 amendment to
  P2 (cq/qc channels framing) that this IR realises.
- `packages/sturm-ir/` — to be filed under Phase 1 issue
  scientist-workbench-dwg.
- ADR-0005 — the entropy convention for the sampling tools that
  consume this IR.
- ADR-0007 — the distribution-vs-sampling split that names which
  tools are deterministic over the IR and which need entropy.
- ADR-0003 — output error patterns; `sturm-simplify` and friends
  follow the foreign-pass-through pattern by tagging unknown sub-IR.
- ADR-0004 — `Schema` is the language in which `channelSchema` and
  `opSchema` are written.
- shard 009 (`docs/worklog/009-sturm-ts-port-planning.md`) — the
  planning shard that motivated this ADR.
