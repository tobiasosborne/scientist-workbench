# ADR-0038 — Coherent-control restrictions on the Sturm IR

**Status:** Accepted — 2026-05-15.
**Beads:** `scientist-workbench-r40` (closes — this ADR *is* the
deliverable named in r40's acceptance criteria 1). `scientist-workbench-q0b`
(blocked-by r40; this ADR is the spec q0b's tracer cites for its
refusal envelope).
**Authors:** tobiasosborne + Claude Opus 4.7 (1M context).
**Related:** ADR-0006 (IR-as-Value — the closed seven-head vocabulary,
the principle "coherent control on non-unitary ops is not well-defined"
this ADR makes structural); ADR-0003 (three output categories — names
the `tagged "<tool>/<class>"` envelope shape the tracer uses); ADR-0009
(TS-native frontend DSL — the source surface this ADR's tracer-side
obligation will be expressed in); `packages/sturm-ir/src/{nodes.ts,
schema.ts, wellformed.ts}` (the three enforcement layers); worklog 022
(the spec-v3 absorption shard that left `when`-body well-formedness
under-specified, surfacing the question this ADR answers).

## Context

Spec v3 §6 admits a `when(q) do … end` block in the source surface: the
inner ops emitted inside the body carry `q` on their `whenStack`, and at
IR build time that stack lowers to the `controls` field on each inner
op. ADR-0006 then makes the closure decision: only `ry` and `rz` carry
a `controls` field at the IR level, because they are the unitary
primitives and "coherent control on non-unitary ops is not
well-defined."

What ADR-0006 does *not* say is what the **tracer** (`tools/sturm-trace`,
bead `q0b`) should do if the user writes a source program like

```ts
when(q, () => {
  const r = observe(target);   // ← non-unitary inside when
  // ...
});
```

The IR has no way to represent the user's intent: there is no
`controls` field on `observe`. The tracer must refuse — but the bead
`r40` filing left three open questions:

1. **Which non-unitary op heads are forbidden inside a `when` body?**
   Definitely `observe`, `cases`, `discard` (clearly non-unitary, clearly
   ill-defined under coherent control). The open question was
   `prepare`: it allocates a fresh wire whose `|0⟩` amplitude does not
   depend on the control, so an unconditional `prepare` inside a
   `when` body would lower to an *uncontrolled* `prepare`, harmlessly.
2. **What error envelope does the tracer use?** ADR-0003 admits three
   shapes; the question is which one applies here.
3. **What is the IR-level defense-in-depth analogue** for an agent that
   constructs IR Values directly, bypassing the tracer?

This ADR resolves all three.

## Decision

### 1. Forbidden ops inside a `when` body

The full non-unitary five — **`observe`, `cases`, `discard`, `prepare`,
`oracle`** — are forbidden inside a `when` body in v0.1.

The first three are obvious. `oracle` is forbidden by the same
principle: an oracle is a separable subcircuit; controlling it
coherently means controlling each of its inner ops, which would only
be sound if the oracle were itself a list of unitary primitives — but
the IR carries `oracle` as a single opaque op-node with no internal
visibility from the outside. The principled lowering is "lift the
`when` into the oracle's source and re-trace," which the tracer cannot
do automatically. Refuse instead; let the user restructure.

`prepare` is the genuinely-debatable case. The argument for admitting
it is correct as stated: a fresh wire prepared inside `when(q)` does
not entangle with `q`, so the lowering "drop the control" is sound.
The argument *against* admitting it is the one we take:

- **Agent confusion.** The TS-source `when(q) { prepare(|+⟩) }` reads
  as if the preparation depends on `q`. Silently lowering to an
  uncontrolled `prepare` outside the `when` would violate the
  no-surprise principle that the rest of the workbench follows.
- **Cheap to revisit.** If a real use case appears, we admit `prepare`
  in v0.2 with no compatibility cost — narrowing is forward-compatible,
  widening is not. Forbidding now keeps the option open.
- **Symmetric with the other four.** Five-ops-forbid is a simpler rule
  than four-ops-forbid-with-exception. The tracer's check is "is this
  op `ry` or `rz`?"; everything else refuses.

The forbidden list is therefore the **complement of `{ry, rz}`** within
the closed seven-head vocabulary. This phrasing is the load-bearing
spec for q0b's tracer: a one-line predicate, not a five-line allow-list
that drifts if the vocabulary ever changes.

### 2. Error envelope

The tracer refusal is **`tagged "sturm-trace/invalid-when-body"`** with
a payload record naming the offending op kind and the source location:

```ts
tagged("sturm-trace/invalid-when-body", record({
  op_head: str("observe"),       // the forbidden op the tracer saw
  control_wires: list([…]),      // the wire IDs in the active whenStack
  source_location: str("…"),     // file:line:col in the user's TS source
}))
```

`ToolError` is reserved for *malformed input* (ADR-0003); the user's
source is well-formed, it just makes a structural request the IR can't
honour. That places it in the boundary-failure category — `tagged
"<tool>/<class>"`. The class name `invalid-when-body` reads correctly
in stderr: a sentence-of-failure that names *what* went wrong before
needing the payload.

### 3. IR-level defense-in-depth

The IR enforces the principle through **four layers**, each of which is
already in place at the time of this ADR. The contribution of this ADR
to the IR layer is documentation that links the layers, plus closing
one test-coverage gap.

**Layer 1 — Schema closure (`packages/sturm-ir/src/schema.ts`).** The
`opSchema` is a `S.union` over the seven heads with explicit positional
arg tuples. Only `ry` and `rz` admit a third `controls` arg; the
non-unitary heads have shorter arg tuples and the runner's
`validate` rejects anything longer. A Value with head `"observe"` and
three args fails schema validation before the tool's `fn` ever runs.

**Layer 2 — Builder API (`packages/sturm-ir/src/nodes.ts`).** The
typed-form builders `prepareOp`, `observeOp`, `oracleOp`, `casesOp`,
`discardOp` do not accept a `controls` parameter. TS rejects a call
like `observeOp(0n, "r", [1n])` at compile time. Only `ryOp` / `rzOp`
take a third `controls` arg (defaulted to `[]`).

**Layer 3 — Decoder (`packages/sturm-ir/src/nodes.ts`).** `decodeOp`
validates arity via `expectArgsLength`. A Value with extra args on a
non-rotation head throws `ProtocolError` with a dotted path naming
the offending position. This is the load-bearing check for IR coming
from outside our process — pipe input, deserialised provenance, an
adversarial Value.

**Layer 4 — Well-formedness (`packages/sturm-ir/src/wellformed.ts`).**
The recursive case. `cases` (the classical-branch op) carries two
`list<op>` arms which are the IR's structural fingerprint of a
"controlled body." Each arm runs under `insideArm = true`; the step
function refuses `prepare`, `observe`, `discard`, nested `cases`, and
scope-changing `oracle` inside an arm. The cases-arm rule is the
direct IR-level analogue of the `when`-body rule: both forbid
non-unitary ops in a structurally-restricted body context.

The four-layer enforcement means: an attempt to construct an IR with
a non-unitary op carrying coherent control fails at *whichever* of the
four layers the construction first reaches. There is no construction
path that bypasses all four.

## What this ADR changes

- **Documentation in lockstep.** Doc-comment strengthening in
  `nodes.ts`, `schema.ts`, `wellformed.ts`, and a new section in
  `packages/sturm-ir/README.md` cite this ADR and the principle.
- **One missing well-formedness test.** `wellformed.test.ts` covers
  `prepare` / `discard` / nested-`cases` inside cases arms but not
  `observe`; this ADR's implementation closes that gap.
- **One missing schema test.** `schema.test.ts` does not currently
  pin "smuggled `controls` on a non-rotation op fails schema
  validation"; this ADR's implementation adds it.
- **No code changes to the existing enforcement logic.** Layers 1–4
  are already in place. The contribution is the unification of the
  spec, not new checks.
- **A note on bead `q0b`.** When q0b's tracer is implemented, its
  refusal logic cites this ADR and uses the
  `sturm-trace/invalid-when-body` envelope. The tracer-side rule is
  `op.head !== "ry" && op.head !== "rz" ⇒ refuse-if-active-when-stack`.

## Consequences

**Positive.**

- The principle "coherent control on non-unitary ops is not
  well-defined" now has a single named home (this ADR) instead of
  living as a one-line aside in ADR-0006. Future Sturm tools cite it
  directly.
- q0b unblocks with a fully-specified refusal contract: which ops,
  which envelope, what payload.
- The IR-level four-layer enforcement is documented in one place;
  agents adding new op heads or new tools have a checklist for what
  "no coherent control on this op" must look like.

**Negative.**

- `prepare` inside `when` is a small ergonomic loss for the (very
  narrow) case where the user wants to allocate a fresh ancilla mid-
  controlled-block. Revisitable in v0.2 if a real use case appears.
  Mitigation: the user can hoist the `prepare` outside the `when`
  with no semantic change.

## Alternatives considered

**Admit `prepare` inside `when`, silently drop the control.** Rejected.
The lowering is sound but the user-intent reading is misleading. v0.1
prefers a loud refusal that can be relaxed later.

**Forbid only `observe` / `cases` / `discard`; admit `prepare` and
`oracle`.** Rejected. The `oracle` case is unsound (per the
"separable subcircuit" argument above) and the rule "all non-rotation
ops refuse" reads more cleanly than a four-out-of-five enumeration.

**Encode `when` as its own IR op-node with an inner body.** Rejected
in shard 009 and re-affirmed here. Adding `when` to the IR would
require every traversal to descend into another tree shape, and the
lowering at IR build time is exactly the simplification that makes
optimisation passes tractable. The IR carries the *outcome* of the
`when` (controls on inner ops); the *source frame* lives only in the
TS source.

**ToolError for the tracer refusal.** Rejected. ADR-0003 reserves
`ToolError` for malformed input shapes; the user's source is
well-formed TS, just structurally unrepresentable in the IR. Boundary-
failure via `tagged "<tool>/<class>"` is the right shape.

## Pointers

- ADR-0006 — the IR-as-Value encoding; this ADR makes one of its
  asides structural.
- ADR-0003 — the error-category taxonomy this ADR's envelope sits in.
- ADR-0009 — the TS-native frontend DSL; q0b implements its tracer.
- `packages/sturm-ir/src/nodes.ts` — Layer 2 (builder API) and Layer 3
  (decoder).
- `packages/sturm-ir/src/schema.ts` — Layer 1 (schema closure).
- `packages/sturm-ir/src/wellformed.ts` — Layer 4 (cases-arm
  recursive analogue).
- `packages/sturm-ir/README.md` § "Coherent control: where it's
  allowed, where it's structurally rejected" — the user-facing table.
- bead `q0b` notes — names this ADR as the spec for the tracer
  refusal envelope.
