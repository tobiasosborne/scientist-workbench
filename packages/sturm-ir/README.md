# @workbench/sturm-ir

The IR layer for Sturm channels in scientist-workbench. Encodes ADR-0006:
the Sturm IR is a canonical Value (`expression "channel"` with input/output
wire signatures and a closed seven-head op vocabulary), and Sturm tools
operate on Values directly.

This package is the substrate every Sturm tool depends on:
`sturm-simplify`, `sturm-execute`, `sturm-equivalent`, `sturm-sample`,
`sturm-trace`, `sturm-bennett-oracle`, `sturm-qecc-wrap`, and the channel
combinators (`sturm-controlled`, `sturm-then`, `sturm-tensor`).

## Public surface

```ts
import {
  // Typed in-memory IR
  type Wire, type Channel, type Op,
  type PrepareOp, type RyOp, type RzOp, type ObserveOp,
  type OracleOp, type CasesOp, type DiscardOp,

  // Builders (typed forms with sensible defaults)
  wire, channel,
  prepareOp, ryOp, rzOp, observeOp, oracleOp, casesOp, discardOp,

  // Encoders (typed → canonical Value)
  encodeWire, encodeOp, encodeChannel,

  // Decoders (canonical Value → typed; throws ProtocolError with a path)
  decodeWire, decodeOp, decodeChannel,

  // Schemas (for tool authors declaring input/output)
  wireSchema, opSchema, channelSchema,

  // Well-formedness check (graph-shaped invariants)
  type WellFormedResult,
  checkWellFormed,

  // Visitor for body traversal
  type OpVisitor, type VisitContext,
  traverseChannel,
} from "@workbench/sturm-ir";
```

## The IR shape — at a glance

A channel is `expression "channel"` with three positional args:

| Arg | Shape | Meaning |
|-----|-------|---------|
| `args[0]` | `list<wire>` | input wire signature |
| `args[1]` | `list<wire>` | output wire signature |
| `args[2]` | `list<op>`   | body, in document order |

A wire is `record { id: integer, kind: "classical" \| "quantum",
dim?: "qubit" \| "qudit" \| "anyon" \| "boson" }`. v0.1 emits only
`"qubit"`; the schema admits the others additively per P7.

The op-node vocabulary is closed — exactly seven heads:

| Head | Args | Notes |
|------|------|-------|
| `prepare` | `[p, wireId]` | cq channel; introduces `wireId` in `√(1−p)\|0⟩ + √p\|1⟩`. |
| `ry` | `[wireId, delta, controls]` | Y-rotation; `controls` is a list of wire IDs (empty for unconditional). |
| `rz` | `[wireId, delta, controls]` | Z-rotation; same controls convention. |
| `observe` | `[wireId, classicalRef]` | qc channel; consumes `wireId`, binds `classicalRef`. |
| `oracle` | `[circuit, inWires, outWires]` | reversible classical oracle. |
| `cases` | `[classicalRef, trueArm, falseArm]` | classical branch; arms are `list<op>`. |
| `discard` | `[wireId]` | qq → terminal (partial trace). |

`when` is **not** an op-node — it lowers to the `controls` field on
inner `ry`/`rz` ops at IR construction time. See ADR-0006 §"Why these
choices."

## Worked example: Bell pair

```ts
import {
  channel, encodeChannel, prepareOp, ryOp, wire,
} from "@workbench/sturm-ir";
import { canonicalize, expr, int, rat, sym } from "@workbench/protocol";

const bell = channel(
  [],
  [wire(0n, "quantum", "qubit"), wire(1n, "quantum", "qubit")],
  [
    prepareOp(rat(0n, 1n), 0n),
    prepareOp(rat(0n, 1n), 1n),
    // ry(π/2) on wire 0 — Hadamard-equivalent up to global phase
    ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
    // controlled ry(π) on wire 1, controlled by wire 0 — entangle
    ryOp(1n, sym("π"), [0n]),
  ]
);

const value = encodeChannel(bell);   // an ExpressionValue
const bytes = canonicalize(value);   // canonical JSON for hashing
```

The Bell channel hashes to a stable content address. Any pipe step that
preserves the channel preserves the hash; any rewrite that changes the
channel changes the hash. That's the property that makes the Sturm tool
chain provenance-clean.

## Validation pipeline

Three layers, in increasing strictness. Tools typically run the runner-
level schema check first (free, since `runTool` does it for `--schema`-
declared inputs), then `decodeChannel` for the typed in-memory form,
then `checkWellFormed` if they need graph-shaped invariants.

1. **Schema** (`channelSchema`): the value's *shape* is correct — it's
   an `expression "channel"` with three args, each matching their
   declared schema. The schema is non-recursive (per ADR-0004's
   omissions), so `cases` arms and `oracle.circuit` are admitted as
   `S.list(S.any())` / `S.any()` and tightened in step 2.

2. **Decoder** (`decodeChannel`): the value can be projected to the
   typed `Channel` form. Throws `ProtocolError` with a dotted path
   on shape mismatches the schema couldn't catch (the recursive
   slots: `cases` arms must be op-lists; an op's head must be one of
   the seven; arities must match).

3. **Well-formedness** (`checkWellFormed`): graph-shaped invariants:
   - All wire IDs referenced by ops are in scope (declared in
     inputs or introduced by an earlier `prepare` / `oracle`).
   - Controls in `ry`/`rz` reference quantum wires only and never
     duplicate or coincide with the target.
   - `cases` references a `classicalRef` already bound by an
     earlier `observe`.
   - **v0.1 restriction:** `cases` arms may not introduce, discard,
     or observe wires — they may only modify state of already-in-
     scope wires (`ry`, `rz`, `oracle` on existing wires). Arms must
     leave scope unchanged. Nested `cases` is also disallowed for
     v0.1. Relaxing this requires a follow-up ADR.
   - Output signature wires are live at end of body and match in
     `kind`/`dim`.

A failure surfaces as `{ ok: false, failure: { path, message } }`
where `path` is a dotted list (e.g., `["body", "3", "trueArm", "0"]`)
and `message` names the offending wire ID or classical ref.

## Coherent control: where it's allowed, where it's structurally rejected

Only `ry` and `rz` carry a `controls` field at the IR level. Coherent
control over `prepare` / `observe` / `oracle` / `cases` / `discard` is
not well-defined (ADR-0006, made explicit in ADR-0038). The IR
enforces this through **four layers**, each catching the violation at
a different point:

| # | Layer | Where | Catches |
|---|-------|-------|---------|
| 1 | Schema closure | `schema.ts` (`opSchema`) | A Value with extra args on a non-rotation head — e.g., `expr("observe", […, …, controls])` — fails `validate` because the `observe` alternative is declared with arity 2. |
| 2 | Builder API | `nodes.ts` (typed builders) | `observeOp(0n, "r", [1n])` is a TS compile error — `observeOp` takes only `(wireId, classicalRef)`. Same for `prepareOp`, `oracleOp`, `casesOp`, `discardOp`. |
| 3 | Decoder arity | `nodes.ts` (`decodeOp`) | A pipe-input Value bypasses schema (e.g., from an adversarial source); `decodeOp` calls `expectArgsLength` and throws `ProtocolError` with a dotted path. |
| 4 | Cases-arm recursion | `wellformed.ts` (`insideArm`) | A `cases` arm — the IR's structural fingerprint of a *controlled body* — refuses `prepare` / `observe` / `discard` / nested `cases` / scope-changing `oracle`. The same principle the tracer enforces at the source surface, applied recursively in the IR. |

There is no construction path that bypasses all four. The
`when(q) { … }` source-level frame (which lowers to controls on inner
ops at trace time) is rejected at the source surface by the tracer
(`tools/sturm-trace`, bead `q0b`) with envelope
`tagged "sturm-trace/invalid-when-body"` whenever the body contains a
non-rotation op. See ADR-0038 for the unified specification.

## Traversal

```ts
import { traverseChannel } from "@workbench/sturm-ir";

let opCount = 0;
traverseChannel(bell, (op, ctx) => {
  opCount++;
  // ctx.branchPath = [] at top level;
  //                  [["true", 0]] inside the first op of a true-arm; etc.
});
```

The visitor walks the body in document order, descending into
`cases` arms (true-arm first, then false-arm). The `cases` op itself
is visited *before* its arms — so a counter that increments per call
will count the `cases` op once plus each op inside its arms. Tools
that want a flat list of "leaf ops" can filter on `op.head !==
"cases"` inside the visitor.

## What this package is not

- **Not** an IR optimiser. That's `sturm-simplify`'s job (issue
  scientist-workbench-z8w). This package is pure data + structural
  checks; it knows how to describe channels but not how to rewrite
  them.
- **Not** a simulator. That's `sturm-execute` (issue tkx). This
  package never executes a channel; it only describes its shape.
- **Not** a tracer. That's `sturm-trace` (issue q0b). The TS source
  → IR translation lives in a separate package
  (`sturm-trace-runtime`) that this package never imports — it is
  consumed only by the tracer tool.

## Pointers

- ADR-0006 — the design and rationale, including worked Bell/GHZ/
  kickback IRs and the closure-of-vocabulary argument.
- ADR-0038 — coherent-control restrictions: the unified spec for the
  four-layer enforcement of "controls only on `ry`/`rz`," plus the
  tracer-side obligation (`tagged "sturm-trace/invalid-when-body"`)
  for q0b.
- `docs/sturm-ts/principles.md` — P1, P3, P5 in particular; this
  package is the structural realisation of all three at the
  workbench layer.
- ADR-0004 — `Schema`, the language `channelSchema` is written in,
  including the no-recursive-schemas omission this package works
  around.
- ADR-0003 — output error patterns; this package's
  `WellFormedResult` mirrors `ConformanceResult` from the protocol,
  so consumers can treat schema and well-formedness failures
  uniformly.
- shard 014 (`docs/worklog/014-packages-sturm-ir.md`) — the landing
  shard for this package.
