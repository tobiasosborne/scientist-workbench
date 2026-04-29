# 011 — ADR 0006: IR-as-Value encoding for Sturm channels

**Date:** 2026-04-29
**Status:** complete (ADR landed; package implementation lands with
 Phase 1 issue scientist-workbench-dwg)
**Branches:** main
**Issues:** scientist-workbench-x9x (closed)
**ADR:** [docs/adr/0006-sturm-ir-as-value.md](../adr/0006-sturm-ir-as-value.md)

## Context

`Sturm.jl` represents a quantum program as a Julia function that the
runtime traces into a DAG IR. The TS port (Sturm-TS) preserves this
surface: a user writes channels as TS functions over quantum types,
and a tracer materialises a DAG IR.

For scientist-workbench integration, the question was: *what is the
protocol object?* Two options:

- **Tracer-as-tool, IR-as-internal.** `sturm-trace` is a tool; its
  input is TS source; the IR is an implementation detail. Every other
  Sturm tool consumes TS source and re-traces.
- **IR-as-Value.** The IR is itself a canonical Value flowing through
  the pipeline; the tracer is *one* of several frontends that
  materialise an IR Value.

The first analysis (in shard 009's design conversation) initially
took the tracer-as-tool path. The pivot was driven by the user's
correction: P1 (functions-are-channels) preserves under representation
change, so "IR-as-Value with tools-as-channel-transformations"
preserves P1 just as well as "TS-functions-as-channels." The
IR-first move makes every Sturm tool stateless and content-addressed
— every channel has a hash, every transformation has a provenance
record, every equivalence claim is reproducible.

ADR-0006 fixes the IR-as-Value encoding so all downstream Sturm tools
agree on shape.

## What changed

**`docs/adr/0006-sturm-ir-as-value.md`** lands the design.

A Sturm channel is `expression "channel"` with three positional args:

```
expr("channel", [
  inputSignature,   // list<wire>
  outputSignature,  // list<wire>
  body,             // list<op>
])
```

A wire is `record { id, kind: "classical" | "quantum", dim?:
"qubit" | "qudit" | "anyon" | "boson" }`. v0.1 emits only `"qubit"`;
the schema admits the others additively per P7 (dimension-agnostic).

The op-node vocabulary is **closed** — exactly seven heads:

| Head | Args | Semantics |
|---|---|---|
| `prepare` | `[p, wire_id, controls?]` | cq channel: produces wire in `√(1−p)|0⟩ + √p|1⟩`. |
| `ry` | `[wire_id, delta, controls?]` | Y-rotation. |
| `rz` | `[wire_id, delta, controls?]` | Z-rotation. |
| `observe` | `[wire_id, classical_ref]` | qc channel: projects, binds to classical_ref. |
| `oracle` | `[circuit, in_wires, out_wires]` | reversible classical oracle. |
| `cases` | `[classical_ref, true_arm, false_arm]` | classical branch on a bound ref. |
| `discard` | `[wire_id]` | qq → terminal (partial trace). |

`controls` defaults to empty `list`. It is the lowered form of the v3
PRD's `whenStack`: a `when(q) do … end` nesting in the source surface
compiles to ops whose `controls` field contains `q`'s wire ID. `when`
is *not* itself an op-node head — keeping it out of the IR means
optimisation passes don't have to descend into another tree shape.

Worked examples (Bell pair, GHZ, phase kickback) are embedded in the
ADR with the helper-style construction (`expr`, `record`, `list`,
`int`, `rat`, `sym`) so an agent reading the ADR can copy a starting
point.

Cross-references landed in:

- `PRD-v0.2.md` §0.1 — delta list acknowledges ADR-0006.
- `docs/sturm-ts/principles.md` — P3 (op-is-op) section explicitly
  references ADR-0006 as the structural realisation; P5 (no gates,
  no qubits) section notes the closure of the `S.union` is the
  enforcement.
- `docs/sturm-ts/README.md` — index lists ADR-0006.

## Why these choices

**IR-as-Value over tracer-as-tool.** P1 preserves under representation
change. Both encodings (TS functions, IR Values) are arrows in CPTP.
Choosing IR-as-Value gains content-addressing for channels and pure-
function statelessness for every Sturm tool — both load-bearing for
the agent-substrate thesis. The tracer becomes one frontend among
several.

**Closed op vocabulary as a `S.union`.** P5 (no gates, no qubits) is
enforced *more* strongly at the workbench layer than at the TS layer:
an op with head `"cnot"` is a schema validation failure, not a lint
warning. The language is what the schema admits; the library is the
(separable) vocabulary on top.

**`when` lowered to `controls` field, not its own op-node head.**
Considered both. Keeping `when` out of the IR is simpler:
optimisation passes see a flat list of ops, each carrying its own
control-set. A nested `when` op would need its own descent during
every traversal. The lowering happens once at IR construction.

**Wire IDs scoped to the enclosing channel.** Considered global
namespace. Local scoping plus rename-on-compose is local to the
combinator tools that need it (`sturm-tensor`, `sturm-then`); a
global namespace would force every channel-producing tool to
coordinate.

**Helpers for IR construction.** The textual surface for writing IR
by hand is verbose. `packages/sturm-ir` will ship typed builder
helpers (`prepareOp(p, w)`, `ryOp(w, δ, controls = [])`, …) so
agent-written IR stays concise. Helpers are TS, not protocol — they
produce canonical Values.

## Frictions surfaced

- **Wire-ID renaming under tensor composition.** When `sturm-tensor`
  combines two channels, wire-ID collisions are guaranteed without
  renaming. The renaming scheme (probably: shift right-side IDs by
  left-side max+1) needs to be documented in `sturm-tensor`'s README
  *and* mirrored consistently in any other tool that composes
  channels. This is implementation-load that didn't exist in
  trace-only Sturm.jl.

- **Symbolic angles vs. numeric angles.** `delta` is a Value — it
  could be a `rational` (e.g., `π/2` represented as an expression
  `expr("/", [sym("π"), int(2n)])`) or a `float64`. The IR treats it
  opaquely; downstream tools (`sturm-execute`, `sturm-simplify`)
  decide what to do. This is the right factoring, but it means a
  Clifford+T tool and a numeric-RY tool see the same op-node head and
  must distinguish at the `delta`-shape level.

- **Adding a new op head is a breaking schema change.** This is the
  intended discipline (closure is the property we want), but it means
  any Sturm vocabulary extension needs its own ADR and a coordinated
  release. Parking a follow-up convention "schema-versioned channel
  Values" if and when the need arises; v0.2 keeps it simple.

## Acceptance

- ADR filed at `docs/adr/0006-sturm-ir-as-value.md`.
- Worked examples (Bell, GHZ, phase kickback) embedded in the ADR.
- Cross-references in `docs/sturm-ts/principles.md` (P3 and P5
  sections) and `docs/sturm-ts/README.md`.
- `PRD-v0.2.md` §0.1 delta list acknowledges ADR-0006.
- `docs/worklog/README.md` index table updated.
- Package implementation deferred to Phase 1 issue scientist-workbench-
  dwg (`packages/sturm-ir`).

## Pointers

- ADR-0006 — the decision, with worked Bell/GHZ/kickback IRs.
- Issue scientist-workbench-x9x — the beads-tracked work item.
- Issue scientist-workbench-dwg — Phase 1 implementation of
  `packages/sturm-ir`.
- `docs/sturm-ts/principles.md` — the principles this IR realises.
- ADR-0004 — `Schema`, the language `channelSchema` is written in.
- ADR-0003 — output error patterns; `sturm-simplify` and friends use
  foreign-pass-through to wrap unknown sub-IR.
