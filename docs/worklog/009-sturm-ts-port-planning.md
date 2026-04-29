# 009 — Sturm-TS port: planning shard

**Date:** 2026-04-29
**Status:** planned (forward-looking — subsequent shards 010+ will document each
  issue as it lands)
**Branches:** main
**Issues:** scientist-workbench-{i8m, x9x, cdz, 0lo, dwg, z8w, tkx, 564, kw1,
  bir, q0b, 733, 8e8, o1q, can} (15 new)

## Context

This shard is unusual: it documents work *to be done*, not work *that has
landed*. It exists because the Sturm-TS port spans 15 interdependent issues
across three phases, and any agent picking up one of them needs more
implementation guidance than a beads issue body can carry without bloating.

The work is the integration of *Sturm-TS* — a TypeScript port of the
user's Julia quantum-programming language *Sturm.jl* — into
scientist-workbench. The starting artefact is the v3 PRD for Sturm-TS,
which posits three primitives (`prepare`, `ry`, `rz`) plus three
structural operators (`observe`, `when`, `cases`) and nine principles
P1–P9 (functions-are-channels, boundary-as-cast, op-is-op, control-as-
lexical-scope, no-gates-no-qubits, QECC-as-Channel→Channel, dimension-
agnostic, numeric promotion at boundary, registers-as-numeric-type).

The design iteration that produced these 15 issues went through one
significant correction. The first analysis claimed P1 was "lost" at the
workbench layer because Sturm-TS expresses channels as TS functions over
quantum types, while the workbench passes JSON values. The user pushed
back — both systems are evolvable, and prep/observe ARE channels (cq and
qc respectively), not specially-tagged "boundary primitives". The
correction sharpened the picture:

- **P1 is preserved**: a channel is the protocol object regardless of
  whether it's encoded as `function bellPair() {…}` or as
  `{kind:"expression", head:"channel", body:[…]}`. The TS frontend and
  the workbench layer are two ways to write down the same arrows in
  **CPTP**. There is no tracer at the workbench layer because the agent
  is constructing the IR directly; the tracer earns its keep only when
  the source is TS.
- **P2 is type-level**: the type system separates classical and quantum
  types; cq channels (prepare, oracle) and qc channels (observe) are the
  morphisms that cross the type distinction. `prepare` and `observe` are
  not categorically privileged — they are channels with specific input/
  output type-shapes. P3 (op-is-op) covers them.
- **Nondeterminism is externalised, not admitted**: the workbench's
  determinism contract bends by introducing one `nondeterministic: true`
  manifest annotation and one privileged `entropy-source` tool. Every
  other "stochastic-feeling" tool takes an `entropy` field as input and
  remains deterministic given it. Born's rule becomes structurally
  explicit: `sturm-execute` returns an analytic distribution; `sturm-
  sample` applies the rule given entropy bytes.

The 15 issues realise this revised plan. Phase 0 lands the
ground-truth artefacts (3 ADRs + 1 spec amendment). Phase 1 lands the
v0.1 substrate (the IR package + 3 tools, including the killer demo
`sturm-equivalent`). Phase 2 lands the v0.2 expansion (6 tools).
Phase 3 is a tracking epic for hardware backends.

## Common ground (read before working any issue)

The non-negotiables in `CLAUDE.md` apply to everything below:

1. **Docs in lockstep with code.** A new tool ships with `tools/<name>/
   README.md`, an entry in the main `README.md` catalog, a paragraph in
   `PRD-v0.2.md` if it introduces a value-protocol convention, and a
   worklog shard documenting *how* it landed. New packages get their
   own `README.md` and a row in the main README's "File layout"
   section.
2. **Literate programming.** Source files in `packages/sturm-ir/src/`
   and `tools/<name>/tool.ts` are exposition. Doc-comments at the top
   of each file are multi-paragraph explanations of *why* the code is
   shaped the way it is. Read shard 008 (`docs/worklog/008-schema-as-
   first-class-type.md`) and `tools/cas-verify/tool.ts` for examples
   of the prose density expected.
3. **Ground truth first.** Before any code: read the relevant ADR (or
   if it doesn't exist yet, write it first); read the affected files
   to verify their current shape; *then* implement; *then* update docs.
   Never trust memory or a prior conversation summary about the shape
   of a file — read it.

Mechanical conventions:

- **Tools:** scaffold with `bun run new-tool <name> --uses <pkg1>,<pkg2>`.
  This emits a literate `tool.ts` skeleton calling `defineTool({...})`
  and `runTool(def)` from `@workbench/contract`.
- **Schemas:** declare via the `S.*` constructors from `@workbench/
  protocol` (see ADR-0004). `defineTool` infers `I` and `O` from the
  schema; the runner validates input *before* `fn` runs and output
  *after*. Do not hand-roll input validation in `fn`.
- **Output categories** (ADR-0003): happy path emits the natural Value;
  routine non-success emits `record{<flag>, …}` (e.g. `mod-inv`,
  `cas-verify`); boundary failure emits `tagged "<tool>/<class>"` (e.g.
  `cas-simplify` on out-of-scope). `ToolError` is reserved for
  malformed inputs.
- **Subprocess machinery:** import `spawnBun` from `@workbench/
  contract`. Never `node:child_process`.
- **Value construction:** prefer the helpers (`int`, `str`, `record`,
  `list`, `tagged`, `expr`, `sym`, `bool`, `rat`, `float64FromNumber`)
  from `@workbench/protocol`. Reserve raw `{ kind: "...", ... }`
  literals for protocol internals.
- **Tests:** for ports of known-good algorithms, follow the **port-and-
  verify** TDD shape (see `CLAUDE.md` §"Two TDD shapes"): port,
  capture invariants, mutation-prove the tests catch regressions,
  cross-validate. For from-scratch design, the spec-from-scratch
  RED→GREEN cycle.

## What's planned

### Phase 0 — Ground-truth (P1, no upstream blockers)

#### scientist-workbench-i8m — ADR 0005: externalised entropy

**Job:** decide and document how the workbench admits randomness
without breaking content-addressing.

**Files:**
- `docs/adr/0005-externalised-entropy.md` (new) — standard ADR
  template (status, context, decision, consequences). Look at
  `docs/adr/0004-schema-as-first-class-type.md` for shape.
- `README.md` (edit) — "Hard requirements for any new tool" section
  cross-references the ADR; add a brief note that the determinism
  contract is conditional on input bytes including any provided
  entropy.
- `PRD-v0.2.md` (edit) — wherever determinism is discussed, add a
  cross-reference.
- `docs/worklog/010-externalised-entropy.md` (new) — landing shard.

**Approach:**
- Decision: introduce a `nondeterministic` boolean flag on the
  `ToolDefinition` interface in `packages/contract/src/runner.ts`.
  Default false. When true, the tool's provenance record is still
  written (via `provenance.ts`) but the contract does not promise
  hash-stability of outputs across runs.
- Convention: any tool needing entropy declares an `entropy` field
  in its input record schema, hex-encoded `S.kind("string")`. The
  tool is deterministic given those bytes.
- Provenance: nondeterministic tools may need a different provenance
  shape (the `output_hash` is still recorded but cannot be re-derived
  from inputs). Decide and document.

**Pitfalls:**
- Do not introduce a new value `kind` for "computations needing
  entropy" — pipe-is-bind, the existing tools-and-pipes shape is
  already monadic. Adding `M[a]` would be ceremony.
- Do not weaken the default: tools without the flag remain strictly
  deterministic. The existing 9 tools must not change behaviour.

**Verifies:**
- ADR filed and reviewed; CLAUDE.md / PRD / README cross-references
  in place; worklog shard added.

#### scientist-workbench-x9x — ADR 0006: IR-as-Value encoding for Sturm channels

**Job:** pin the wire-level representation of a Sturm channel as a
canonical Value so that all downstream tools agree on shape.

**Files:**
- `docs/adr/0006-sturm-ir-as-value.md` (new).
- `PRD-v0.2.md` (edit) — cross-reference if a PRD-level mention is
  warranted (probably yes — it introduces a new value-protocol
  convention).
- `docs/worklog/011-ir-as-value.md` (new) — landing shard.

**Approach:** decide and document the IR shape. Concrete proposal
(open to refinement during the ADR write-up):

- A channel is `expression` with head `"channel"` and three args:
  - input wire signature: `list<wire>`,
  - output wire signature: `list<wire>`,
  - body: `list<op>`.
- A wire is `record {id: integer, kind: "classical"|"quantum",
  dim?: "qubit"|"qudit"|"anyon"|"boson"}`. v0.1 only emits `qubit`
  but the schema admits the union additively.
- Op nodes are `expression` with closed heads:
  - `prepare(p, wire_id)` — `p` is a rational or expression
    (symbolic π-rationals welcomed); produces wire `wire_id` in
    `√(1−p)|0⟩ + √p|1⟩`.
  - `ry(wire_id, delta, controls?)`, `rz(wire_id, delta, controls?)`
    — `controls` is a `list<wire_id>` defaulting to empty (the
    lowered form of the v3 PRD's `whenStack`).
  - `observe(wire_id, classical_ref)` — `classical_ref` is a string
    ID generated at IR-build time.
  - `oracle(circuit, in_wires, out_wires)`.
  - `cases(classical_ref, true_arm, false_arm)` — `true_arm` and
    `false_arm` are `list<op>`.
  - `discard(wire_id)`.
- Decide whether `when` is itself an op-node head or whether the
  `whenStack` is *only* visible as the `controls` field on inner ops
  (the latter is simpler and is what the v3 PRD §6 "Notes" suggests
  — `when` does not produce a separate IR node).
- Examples to embed in the ADR: Bell pair, GHZ, phase kickback —
  translate from the v3 PRD §13.

**Pitfalls:**
- Do not introduce gate-named op nodes (`cnot`, `H`, `X`). The IR
  vocabulary is closed under the v3 PRD primitive set; library-level
  gates are derived in the frontend, not in the IR. The closure is
  what makes the workbench enforce P5 *more* strongly than TS+lint.
- Do not use raw `{ kind: ..., ... }` literals for IR construction in
  examples — use the `expr`, `record`, `list` helpers.
- Wire IDs must be scoped to the enclosing channel; do not assume
  global wire IDs.

**Verifies:**
- ADR filed; example IRs (Bell, GHZ, kickback) embedded; cross-
  references from PRD and README; worklog shard added.

#### scientist-workbench-cdz — ADR 0007: distribution-vs-sampling factoring

**Job:** justify and document the split between analytic distribution
computation (`sturm-execute`) and sampling (`sturm-sample`).

**Files:**
- `docs/adr/0007-distribution-vs-sampling.md` (new).
- `docs/worklog/012-distribution-vs-sampling.md` (new) — landing
  shard.

**Approach:**
- Decision: split the v3 PRD's monolithic `run()` into two tools.
  `sturm-execute` is fully deterministic and returns a distribution
  + classical_refs; `sturm-sample` is deterministic given entropy.
- Define the distribution shape. Proposal: `record {outcomes:
  list<record{prob: rational|float64, classical_resolutions:
  record<classical_ref, value>}>}`. Probabilities sum to 1 (assertable
  invariant). For Clifford+T circuits the probabilities are exact
  rationals via cas-core; for general circuits they're float64.
- Justify: workbench's exact-symbolic ethos rewards keeping the
  analytic step pure; the sampling step is a c-c channel that
  applies Born's rule given entropy bytes — this is *what Born's rule
  is*, structurally exposed.
- Cross-reference ADR 0005 (entropy convention) and ADR 0006 (IR
  shape).

**Pitfalls:**
- Do not bundle sampling into `sturm-execute` "for ergonomics" —
  the whole point is that `sturm-execute` stays deterministic.
- Do not assume float64 probabilities everywhere — the exact-symbolic
  case is the more powerful one and should be the default for
  Clifford+T fragments.

**Verifies:**
- ADR filed; cross-references in place; distribution-shape spec
  unambiguous enough that `sturm-execute` and `sturm-sample` can be
  written against it without further design.

#### scientist-workbench-0lo — Sturm-TS v3.1: reframe P2

**Job:** place the Sturm-TS spec under repo control and amend P2 per
the design correction.

**Files:**
- `docs/sturm-ts/spec-v3.md` (new) — paste the v3 PRD content
  (preserved at the top of session 2026-04-29's transcript) and
  apply the v3.1 amendments below.
- `docs/sturm-ts/principles.md` (new, if not already present) —
  Sturm-TS principles with the P2 row updated.

**Approach:**
- §1 axiom table P2 row: replace "Boundary is a cast. `prepare(p):
  QBool` and `observe(q): Classical<boolean>` are the only two
  boundary operations." with "Type system separates classical and
  quantum types. cq channels (`prepare`, `oracle`) and qc channels
  (`observe`) are the morphisms that cross the type distinction.
  `discard` is the qq → terminal channel (partial trace). All are
  channels in the same category as `ry`, `rz`."
- §3.2 prose: clarify `observe` is a qc channel, `prepare` is a cq
  channel; remove any "boundary in/out" framing that elevates them
  above other ops.
- Cross-reference ADR 0006 for the IR-level confirmation that
  prepare and observe are uniformly node-shaped.

**Pitfalls:**
- Do not weaken P2's type-level separation — Q<T> remains structurally
  unrelated to T. The change is to the framing of the channels that
  cross the divide, not to the type discipline.
- Open Question Q5 (Classical<T> truthiness) is unaffected; do not
  touch it.

**Verifies:**
- Spec lives under `docs/sturm-ts/`; §1 P2 row updated; §3.2 prose
  updated; ADR 0006 cross-references the spec.

### Phase 1 — v0.1 substrate (P1, gated on Phase 0)

#### scientist-workbench-dwg — `packages/sturm-ir`

**Job:** build the foundational package consumed by every Sturm tool.
Defines the IR vocabulary, schemas, well-formedness checks, and
traversal helpers.

**Pre-conditions:** ADR 0006 landed.

**Files:**
- `packages/sturm-ir/package.json` — workspace manifest, deps on
  `@workbench/protocol`.
- `packages/sturm-ir/src/index.ts` — re-exports.
- `packages/sturm-ir/src/nodes.ts` — TS discriminated-union types
  (`Prepare`, `Ry`, `Rz`, `Observe`, `Oracle`, `Cases`, `Discard`,
  plus `Channel` and `Wire`).
- `packages/sturm-ir/src/schema.ts` — `channelSchema`, `opNodeSchema`
  (closed union via `S.union([S.expression(...), …])`), `wireSchema`.
- `packages/sturm-ir/src/wellformed.ts` — `checkWellFormed(channel):
  ConformanceResult` mirroring `validate`'s shape from
  `@workbench/protocol`.
- `packages/sturm-ir/src/traverse.ts` — visitor with controls-stack
  maintenance during descent into `cases` arms.
- `packages/sturm-ir/test/{nodes,schema,wellformed,traverse}.test.ts`.
- `packages/sturm-ir/README.md` — describes the public surface.
- `README.md` (edit, root) — add a row in "File layout" for the
  package.

**Approach:**
- The op-node TS types are discriminated-union members keyed on the
  expression head string. Use the existing pattern in
  `packages/protocol/src/kinds.ts` and `packages/cas-core/src/expr-
  bridge.ts` for reference.
- Each op-node type's constructor helper returns a typed `Value` via
  `expr(head, [args…])`. Encoders are pure functions; decoders walk
  a `Value` and return a typed-union node or throw with a path.
- `checkWellFormed` invariants:
  - all wire IDs referenced by ops are in scope (declared in input
    signature or produced by a `prepare` earlier in the body),
  - controls reference quantum wires only,
  - cases arms have consistent classical-ref scoping,
  - dimension consistency (a wire's dim matches the prepare that
    introduced it).
- Traversal: a visitor pattern that descends into `cases` arms with
  a copied controls-stack, accumulating ops in document order.

**Pitfalls:**
- Do not implement IR rewrites here; that's `sturm-simplify`'s job.
  This package is pure data + structural checks.
- Do not couple to `cas-core` — angle types come in as Value (could
  be rational, float64, or expression); the package treats them
  opaquely.
- Literate doc-comments at the top of each src file are mandatory
  per CLAUDE.md.

**Verifies:**
- `bun test packages/sturm-ir` passes; round-trip on the Bell, GHZ,
  kickback examples from ADR 0006; well-formedness rejects every
  declared invariant violation; main README "File layout" updated.

#### scientist-workbench-z8w — `tools/sturm-simplify`

**Job:** IR canonicaliser. Idempotent. Plays for Sturm IR the role
`cas-simplify` plays for algebraic Values.

**Pre-conditions:** `packages/sturm-ir` landed.

**Files:** standard 7-artefact tool layout under `tools/sturm-
simplify/`. Scaffold: `bun run new-tool sturm-simplify --uses
sturm-ir,cas-core,protocol,contract`. Edit emitted `tool.ts`,
`goldens.spec.ts`, `README.md`; populate `goldens/` via `bun run
goldens`.

**Approach:**
- Schema: input = output = `channelSchema` from `sturm-ir`.
- `fn` walks the body bottom-up applying rewrites:
  - `ry(0)` → eliminated, `rz(0)` → eliminated;
  - `ry(α) ry(β)` on the same wire with same `controls` → `ry(α+β)`,
    using `cas-simplify` for symbolic α+β;
  - same for `rz`;
  - `cases` with constant classical-ref (i.e., the ref resolves
    statically) → collapse to the chosen arm; (*if* the IR carries
    enough information to detect this; otherwise leave as-is);
  - `discard` of a wire that's already been discarded → eliminated.
- Foreign-pass-through: unknown op heads (e.g., a future extension
  the tool doesn't recognise) wrap as `tagged "sturm-simplify/out-
  of-scope"` per ADR-0003. Their position in the body is preserved.
- Idempotence is a property test: `simplify(simplify(c))` byte-equal
  to `simplify(c)` after canonicalisation.

**Pitfalls:**
- Do not assume commuting rewrites where the gates don't commute.
  `ry` and `rz` on the same wire do *not* commute. Only same-axis
  consecutive rotations can be folded.
- Do not introduce gate-aware optimisation (e.g., "merge two
  same-controls ry into a cnot when α = π"). That's lowering's job.
  Simplify operates *within* the IR vocabulary.
- Read `tools/cas-simplify/tool.ts` for the analogous rewrite-system
  pattern.

**Verifies:**
- 7-artefact contract; ≥10 examples covering each rewrite branch;
  idempotence + foreign-pass-through + determinism property tests
  pass; goldens generated; main README catalog row added; `bun run
  check` passes.

#### scientist-workbench-tkx — `tools/sturm-execute`

**Job:** analytic distribution computation. IR → distribution +
classical_refs. No randomness.

**Pre-conditions:** `packages/sturm-ir` landed; ADR 0007 landed.

**Files:** standard 7-artefact tool layout. Scaffold with `--uses
sturm-ir,cas-core,protocol,contract`.

**Approach:**
- Schema: input = `channelSchema`; output = the distribution shape
  defined in ADR 0007.
- For Clifford+T fragments: state-vector simulation over Q[√2, i]
  via `cas-core` polynomial arithmetic. Probabilities come out exact.
- For general parametrised rotations: numeric float64 state-vector
  fallback. Output flagged as approximate (e.g., a record field
  `precision: "exact" | "float64"`).
- State-vector size cap (suggested: 12 qubits = 4096 amplitudes).
  Beyond cap, emit `tagged "sturm-execute/out-of-scope"` per
  ADR-0003.
- Cross-validation: pick a representative subset (Bell, GHZ, kick-
  back, parametrised RY chains) and compare against an independent
  oracle. Qiskit's statevector simulator is the obvious choice if
  Python is reachable in the dev environment; otherwise hand-checked
  goldens against the textbook value (e.g., Bell distribution = 50/50
  on |00⟩, |11⟩).

**Pitfalls:**
- Do not bake sampling into this tool. Born's rule is applied at
  observe nodes to compute *probabilities*; samples are
  `sturm-sample`'s job.
- Do not over-numericise: if the input IR has rational angles, keep
  the distribution exact via cas-core. The whole point.
- Do not assume the input is canonical — apply `sturm-simplify`'s
  output as a "nice" form but the tool must accept any well-formed
  IR.

**Verifies:**
- 7-artefact contract; ≥10 examples; cross-validation on at least
  one independent oracle (or hand-checked goldens, with the source
  of truth recorded in the goldens spec); `bun run check` passes.

#### scientist-workbench-564 — `tools/sturm-equivalent`

**Job:** circuit equivalence over Clifford+T (and beyond, where
exact-symbolic algebra permits). The killer demo for the workbench's
exact-symbolic substrate.

**Pre-conditions:** `packages/sturm-ir` landed; `sturm-simplify`
landed.

**Files:** standard 7-artefact tool layout.

**Approach:**
- Schema: input = `record {lhs: channel, rhs: channel}`; output =
  ADR-0003 record-with-flag — `record {equal: boolean, witness?,
  side?, detail?}`. Mirror `tools/cas-verify/tool.ts`'s shape.
- Pre-canonicalise both sides via `sturm-simplify` (or its library
  function — pull the rewrite engine into the package layer if
  cleaner).
- Equality strategy:
  1. Syntactic: if canonical IRs are byte-equal, return equal=true.
  2. Algebraic: for Clifford+T fragments, build matrix
     representations over Q[√2, i] via cas-core and check matrix
     equivalence up to global phase.
  3. For general circuits where (1) and (2) don't decide: out-of-
     scope, `tagged "sturm-equivalent/out-of-scope"`. Honest scope
     beats lying.
- On inequality: emit a witness — either a difference IR (lhs ∘
  rhs⁻¹ ≠ identity, with the residual op listed) or a separating
  measurement basis where the distributions disagree. Mirror
  cas-verify's witness shape.

**Pitfalls:**
- Global phase is unobservable; check equivalence up to global
  phase, not literal matrix equality.
- Symmetry: `equivalent(a, b)` must equal `equivalent(b, a)`. This is
  a property test.
- Do not rely on numeric float64 comparison for the "exact" case —
  the whole point is that this tool is exact for Clifford+T.

**Verifies:**
- 7-artefact contract; ≥10 examples covering equality (H·H = I, X =
  Ry(π) up to phase, equivalent Bell-pair circuits in different
  forms), inequality with witness, and out-of-scope; `bun run check`
  passes.

### Phase 2 — v0.2 expansion (P2, gated on Phase 1)

#### scientist-workbench-kw1 — `tools/entropy-source`

**Job:** the workbench's privileged nondeterministic primitive.

**Pre-conditions:** ADR 0005 landed (so the `nondeterministic: true`
manifest hook exists).

**Files:** standard 7-artefact tool layout.

**Approach:**
- Schema: input = `record {n_bytes: integer}`; output = `record
  {bytes: string (hex), source_kind: literal "os-urandom"}`.
- Implementation: `crypto.getRandomValues(new Uint8Array(n_bytes))`
  → hex-encode → wrap as a string Value.
- Manifest: `nondeterministic: true` per ADR 0005.
- Goldens record schema-shape only (n_bytes consistency, hex format
  with right length), not byte equality. The goldens spec must
  document this explicitly.

**Pitfalls:**
- Do not seed from a deterministic source (e.g., `Date.now()`-derived
  pseudo-random) "for testability". The whole point is genuine
  entropy; testability comes from the `nondeterministic: true`
  annotation that opts goldens out of byte-equality.
- Do not allow `n_bytes = 0` to succeed silently — emit `ToolError`
  for malformed input.

**Verifies:**
- 7-artefact contract; goldens regenerate cleanly each run (with
  shape-only assertions); subsequent calls produce different bytes
  (overwhelming probability); manifest annotation propagates to
  provenance; `bun run check` passes.

#### scientist-workbench-bir — `tools/sturm-sample`

**Job:** distribution + entropy + shots → samples. Deterministic
given entropy.

**Pre-conditions:** ADR 0005, `sturm-execute`, `entropy-source`
landed.

**Files:** standard 7-artefact tool layout.

**Approach:**
- Schema: input = `record {distribution, entropy: string (hex),
  shots: integer}`; output = `record {samples: list<record>,
  classical_resolutions: list<record>, entropy_consumed: integer}`.
- Treat entropy as a stream of uniform-[0,1) draws (8 bytes per draw
  = `uint64 / 2^64`). Per shot: walk the distribution's CDF to pick
  an outcome; record the chosen `classical_resolutions`.
- Determinism: same `(distribution, entropy)` ⟹ byte-equal output.
  Property test.
- Statistical convergence: with large `shots`, sample frequencies
  converge to the input distribution. Property test with a
  documented tolerance and a fixed entropy seed (so the test is
  itself deterministic).

**Pitfalls:**
- Do not consume entropy in a non-deterministic order (e.g., based
  on hash-iteration order). Use the order the ops appear in the IR /
  the order outcomes appear in the distribution.
- Do not run out of entropy silently — if `entropy_consumed >
  len(entropy)`, emit `ToolError` with a `suggestion` to provide
  more bytes (typical: `8 * shots * len(classical_refs)`).

**Verifies:**
- 7-artefact contract; ≥10 examples; determinism + statistical-
  convergence property tests; `bun run check` passes.

#### scientist-workbench-q0b — `tools/sturm-trace`

**Job:** TS source → IR. The TypeScript frontend per the v3 PRD.

**Pre-conditions:** `packages/sturm-ir` landed.

**Files:** standard 7-artefact tool layout, plus a separate package
`packages/sturm-trace-runtime/` housing the actual tracer (consumed
only by this tool).

**Approach:**
- Schema: input = `record {source: string, entry?: string}`; output
  = `channelSchema` (or boundary-tagged on parse / non-pure-trace
  errors).
- The tracer is the v3 PRD §5 `Tracer` class. It lives in
  `packages/sturm-trace-runtime/src/` along with the `prepare`,
  `ry`, `rz`, `observe`, `when`, `cases`, `discard` exports that user
  source imports.
- This tool spawns a Bun subprocess (via `spawnBun` from
  `@workbench/contract`) that loads the user source plus the runtime,
  runs the entry function inside `run()`, and emits the IR as JSON
  on stdout. The subprocess is sandboxed to the extent Bun supports.
- `STURM_CHECK_DETERMINISM=1` is on by default in this tool: trace
  twice, diff IR, fail boundary if non-deterministic.
- Boundary failures: TS compile errors → `tagged "sturm-trace/parse-
  error"`; runtime errors during trace → `tagged "sturm-trace/
  trace-error"`; non-deterministic trace → `tagged "sturm-trace/
  non-deterministic"`.

**Pitfalls:**
- Do not let the tracer's module-level state leak across invocations.
  Each subprocess invocation is a fresh process — the spec's
  "nested run() not supported" constraint is automatically honoured.
- The spec's open question Q2 (when-body return type) affects IR
  shape — coordinate with ADR 0006 if the answer changes during
  v0.2.
- Read `docs/adr/0001-subprocess-plumbing.md` before touching the
  spawn machinery; the snap-Bun corner is non-obvious.

**Verifies:**
- 7-artefact contract; ≥10 examples (Bell pair, GHZ, kickback,
  parametrised circuit, classical-branch via cases); determinism
  property test; round-trip with `sturm-execute` on at least three
  examples; `bun run check` passes.

#### scientist-workbench-733 — `tools/sturm-bennett-oracle`

**Job:** classical reversible function → IR oracle node. The bridge
that lifts existing workbench tools (mod-pow, mod-inv, polynomial
evaluation via cas-core) into quantum oracles.

**Pre-conditions:** `packages/sturm-ir` landed.

**Files:** standard 7-artefact tool layout.

**Approach:**
- Schema: input = `record {fn_description, arg_types: list<record
  {bits, dim?}>}`; output = an IR `oracle` op-node.
- `fn_description` is an expression tree describing the classical
  computation. Decide: a small bit-arithmetic vocabulary (AND, OR,
  XOR, ADD, MUL, MOD, POW), or reuse cas-core's expression
  vocabulary, or both.
- Compilation: synthesise a reversible circuit (Toffoli-based
  primitive set is standard) computing `(x, ancillae) ↦ (x, f(x))`.
  The output IR oracle node carries the compiled circuit as a Value.
- Reversibility property test: every emitted circuit is a
  permutation on the joint state.

**Pitfalls:**
- Reversibility is mandatory — irreversible classical ops (like
  `AND` without an ancilla holding the input) must materialise the
  ancillae explicitly.
- Do not implement classical primitives ad-hoc; reach for `mod-core`
  for modular arithmetic and `cas-core` for polynomial evaluation
  where possible. Composition over reimplementation.

**Verifies:**
- 7-artefact contract; ≥10 examples (bit-AND, integer add, modular
  add, modular multiply, modular pow, polynomial evaluation);
  reversibility property test; `bun run check` passes.

#### scientist-workbench-8e8 — `tools/sturm-qecc-wrap`

**Job:** channel → encoded channel with same I/O wire signature.
The workbench realisation of P6.

**Pre-conditions:** `packages/sturm-ir` landed; `sturm-simplify`
landed.

**Files:** standard 7-artefact tool layout.

**Approach:**
- Schema: input = `record {channel, code: record {name, parameters?}}`;
  output = `channelSchema`.
- v0.2 scope: 3-qubit repetition code (bit-flip and phase-flip
  variants) at minimum. Steane and surface deferred — file
  follow-up issues if scope expands.
- Strategy: walk the input channel; for each logical wire substitute
  an encoded triple (or whatever the code dictates); for each op,
  substitute its transversal implementation; insert syndrome-
  extraction + correction ops at appropriate points.
- P6 invariant: `output.input_signature` deep-equals
  `input.input_signature`; same for output signatures. Property
  test.

**Pitfalls:**
- Do not change the channel's *logical* signature — wire IDs may
  differ but the structure (count, types, dimensions) must match.
- Do not assume transversal availability for arbitrary gates;
  document which gates are supported by each code (the repetition
  code, for instance, only protects against the matching error
  type).

**Verifies:**
- 7-artefact contract; ≥10 examples; P6 invariant property test;
  round-trip (encode + decode = identity logically); `bun run check`
  passes.

#### scientist-workbench-o1q — `tools/sturm-controlled` (combinators)

**Job:** point-free channel composition at the Value level. Three
combinators: `controlled`, `then`, `tensor`.

**Pre-conditions:** `packages/sturm-ir` landed.

**Files:** three separate tool directories — `tools/sturm-controlled/`,
`tools/sturm-then/`, `tools/sturm-tensor/` — each with the standard
7-artefact layout. Per CLAUDE.md "flags that change the type of the
output should be different tools," combinators with different input
shapes (channel + wire vs. channel + channel) get separate tools.

**Approach:**
- `sturm-controlled`: input = `record {control_wire, channel}`;
  output = channel. Walks the input channel's body, prepending the
  `control_wire` to every op's `controls` list.
- `sturm-then`: input = `record {first, second}`; output = channel.
  Output wires of `first` map to input wires of `second`; signatures
  must match (boundary-tagged failure if they don't).
- `sturm-tensor`: input = `record {left, right}`; output = channel
  whose wires are the disjoint union.
- Property tests for the categorical laws: `then` is associative;
  `tensor` is monoidal with identity = empty channel.

**Pitfalls:**
- Wire-ID collisions during `tensor`: must rename wires from one
  side to avoid clashes. Decide and document the renaming scheme
  (probably: shift right-side IDs by left-side max+1).
- `then` signature mismatches are *boundary failures*, not
  `ToolError`s — the tool computes the right answer (no composition
  exists); the user's IR was unsupported. Use `tagged "sturm-then/
  signature-mismatch"`.

**Verifies:**
- 7-artefact contract on each of the three; ≥10 examples each;
  associativity / identity / monoidal-functor property tests; main
  README catalog rows; `bun run check` passes.

### Phase 3 — Tracking (P3)

#### scientist-workbench-can — Hardware backend bridges

**Job:** tracking issue. Sub-issues to be filed when scoped.

**Approach:** when this issue becomes ready to act on, decompose
into per-backend issues — one ADR + one tool per target backend
(IBM Quantum, AWS Braket, IonQ, etc.). All such tools carry the
`nondeterministic: true` annotation per ADR 0005. A companion
`sturm-lower` tool may be needed to lower IR into backend-native op
sets.

**Pre-conditions:** ADR 0005, `sturm-sample`, `entropy-source`,
`sturm-trace` all landed.

## Why these choices

**IR-as-Value rather than tracer-frontend-as-tool.** The first
analysis put the tracer in a single tool (`sturm-trace`) and treated
the IR as an internal representation. The pivot was to make the IR
*the protocol object* and demote the tracer to one of several
possible frontends. This was forced by the user's correction: P1
(channels-are-functions) preserves under representation change, so
"IR-as-Value with tools-as-channel-transformations" preserves P1
just as well as "TS-functions-as-channels". The IR-first move makes
every Sturm tool stateless and content-addressed — every channel
has a hash, every transformation has a provenance record, every
equivalence claim is reproducible.

**Determinism preserved by externalising entropy.** Quantum
measurement and stochastic simulation introduce randomness in
principle — but in the workbench, that randomness is fully captured
as a typed input. The result is that every tool except
`entropy-source` and (eventually) the hardware-execution tools
remains under the existing strict determinism contract. The contract
*evolves* (a `nondeterministic: true` annotation is added), but it
does not weaken for any tool that doesn't opt in.

**Distribution-vs-sampling split as Born's rule made structural.**
The split is not just a workbench-port concession — it is a better
factoring than the v3 PRD's monolithic `run()`. The analytic step
computes what physics says is true (the post-circuit state and its
distribution); the sampling step is the c-c channel that turns
probability mass into observed bitstrings given entropy. ADR 0007
documents this as a deliberate departure with a justification.

**Three separate tools for the channel combinators.** The CLAUDE.md
guidance "flags that change output type are different tools"
applies: `controlled`, `then`, `tensor` consume different input
shapes. The alternative (one `sturm-compose` with a mode flag) would
need a top-level union schema and dispatch logic; cleaner as three.

**Closed IR vocabulary as schema.** P5 (no gates, no qubits) is
enforced *more* strongly at the workbench layer than at the TS
layer: the IR schema's `S.union` is finite, so an op-node with head
`"cnot"` is a schema validation failure, not a lint warning. The
language is what the schema admits; the library is the (separable)
vocabulary on top.

## Frictions anticipated

- **Cross-validation against Qiskit.** `sturm-execute` should be
  cross-validated against an independent oracle. The natural choice
  is Qiskit's statevector simulator, but spawning a Python runtime
  from a workbench tool is a non-trivial environmental dependency.
  Mitigation: hand-checked goldens against textbook values where
  feasible; Python cross-validation as a separate dev-time check
  (script in `scripts/`, not a tool's `--test` hook).
- **Sandbox for `sturm-trace`.** The tool spawns a Bun subprocess
  that runs user TS source. In an adversarial setting this is a
  remote-code-execution surface. Mitigation: document the
  trust boundary clearly; consider a deny-list of node imports
  (`fs`, `child_process`, `net`); revisit if the threat model
  evolves.
- **State-vector cap in `sturm-execute`.** Past ~12 qubits the
  state vector is impractical for analytic simulation. The tool
  must boundary-tag out-of-scope cleanly. Future tools (tensor-
  network simulators, density-matrix simulators) are separate
  follow-ons.
- **Sturm-TS spec home.** The v3 PRD currently lives in the user's
  conversation transcript only. Issue 0lo places it under
  `docs/sturm-ts/`; if the spec evolves further outside this repo,
  a sync convention will be needed.
- **Port-and-verify for the simulator.** The state-vector simulator
  is a port of standard textbook material (Nielsen & Chuang, etc.)
  rather than a from-scratch design. Apply the port-and-verify TDD
  shape (CLAUDE.md §"Two TDD shapes"): write the implementation,
  capture invariants in tests, mutation-prove, cross-validate.

## Acceptance

- **Phase 0 done** when ADRs 0005, 0006, 0007 are filed under
  `docs/adr/`, the Sturm-TS spec is under `docs/sturm-ts/` with the
  P2 amendment applied, and shards 010–013 land in `docs/worklog/`.
- **Phase 1 done** when `packages/sturm-ir` is in the workspace,
  `sturm-simplify`, `sturm-execute`, `sturm-equivalent` ship the
  full 7-artefact contract, `bun run check` passes, the README
  catalog lists them, and `scripts/demo-scope.sh` includes a Bell-
  pair end-to-end pipeline (`echo IR | sturm-simplify | sturm-
  execute`).
- **Phase 2 done** when the six v0.2 tools ship the contract, an
  end-to-end demo runs `entropy-source | sturm-trace | sturm-
  simplify | sturm-execute | sturm-sample` for a non-trivial
  circuit, and `sturm-equivalent` decides equivalence on at least
  one QECC-wrapped example.
- **Phase 3** — beyond v0.2; tracking only.

## Pointers

- **The 15 beads issues.** Run `bd show <id>` for each — `i8m`,
  `x9x`, `cdz`, `0lo` (Phase 0), `dwg`, `z8w`, `tkx`, `564`
  (Phase 1), `kw1`, `bir`, `q0b`, `733`, `8e8`, `o1q` (Phase 2),
  `can` (Phase 3).
- **The v3 PRD.** Source-of-truth for Sturm-TS principles and
  primitive surface; place under `docs/sturm-ts/spec-v3.md` as
  part of issue 0lo.
- **`docs/worklog/008-schema-as-first-class-type.md`** — the most
  recent landing shard, illustrating the prose density and
  structure expected.
- **`docs/adr/0003-tool-output-error-patterns.md`** — output
  category conventions every Sturm tool must follow.
- **`docs/adr/0004-schema-as-first-class-type.md`** — schema
  declaration vocabulary every Sturm tool consumes.
- **`tools/cas-verify/tool.ts`** — template for the verification-
  shaped tool (closest analogue for `sturm-equivalent`).
- **`tools/mod-pow/tool.ts`** — template for the
  computation-shaped tool (closest analogue for `sturm-execute`'s
  basic-block style).
- **`packages/protocol/src/schema.ts`** — `S.*` constructors
  reference.
- **`packages/contract/src/runner.ts`** — `defineTool` /
  `runTool`; the tracer-annotation hook (issue i8m) lands here.
