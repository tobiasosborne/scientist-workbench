# PRD: Agent-First Scientific Computing Ecosystem

**Version:** 0.2 (post-MVP)
**Status:** Working document
**Author:** Tobias, with implementation deltas folded in by Claude
**Audience:** The next agent picking up the design and continuing implementation
**Date:** 2026-04-28

---

## 0. How to read this document

This is a working PRD, not a marketing artefact. Sections marked **[SETTLED]** are design decisions that should not be re-litigated without strong reason. Sections marked **[OPEN]** are genuine design questions where the next agent should think carefully and propose. Sections marked **[OUT]** are explicitly out of scope and should stay that way until the in-scope work is done. Sections marked **[BUILT]** describe code that exists in the workspace; the implementation is the spec.

The reading order is non-negotiable: §2 (Value Protocol) is the design centrepiece. Every other section is downstream of it. Read §2 twice before reading §3 onwards.

### 0.1 Delta from v0.1

What v0.1 marked OPEN that v0.2 marks SETTLED or BUILT, and what the implementation chose:

- **§2.2 primitive set.** v0.1 listed 12 candidates and asked which were primitives. v0.2 ships **ten** in the MVP (`symbol`, `string`, `integer`, `rational`, `float64`, `boolean`, `list`, `record`, `expression`, `tagged`). `string` joined the primitive set when `expr-parse` outgrew its initial `{kind:"symbol", namespace:"source"}` shim. The four deferred (`algebraic`, `indexed`, `operator-string`, `polynomial`) are accretive: they can be added without breaking deployed tools because of the foreign-pass-through invariant (§2.3).
- **§2.2 `expression` shape.** Chosen as a primitive, but with the Lean-style discipline: small fixed shape `{head: string, args: Value[]}`, not the Mathematica universal head. The Mathematica answer is rejected.
- **§2.4 canonical serialisation.** Pinned: strict JSON subset, sorted keys, no whitespace, no raw JSON numbers (all numerics live inside tagged kinds whose fields are strings). Specified in `packages/protocol/src/canonical.ts`.
- **§3.2 provenance shape.** Pinned: record carrying `{tool: {name, version}, inputs: [{name, hash}], flags: record-of-symbols, output_hash: hash}`. No timestamps. Indexed on disk by output hash, under `$CAS_STORE/provenance/<hh>/<hash>.json`.
- **§4 tool contract.** Implemented as `runTool(definition)` in `packages/contract/src/runner.ts`. Standard flags `--schema --examples --invariants --version --provenance-of --help` are all wired. As of ADR-0004, `schema` is a real `Schema` (not a sample value): the runner validates input and output against it, examples must conform, and `--schema` emits canonical bytes a registry consumer decodes via `decodeSchema`.
- **Sturm-TS port — Phase 0 ADRs (2026-04-29).** Three ADRs land the design substrate for an upcoming quantum-programming-language port. ADR-0005 (externalised entropy) admits randomness as a typed `entropy` input plus one privileged `entropy-source` tool, preserving the determinism contract for every other tool. ADR-0006 (IR-as-Value) fixes the canonical encoding of Sturm channels as `expression "channel"` Values with a closed seven-head op vocabulary, content-addressed end-to-end. ADR-0007 (distribution-vs-sampling) splits quantum execution into a deterministic `sturm-execute` and an entropy-consuming `sturm-sample`, making Born's rule structurally explicit. The Sturm-TS principles live under `docs/sturm-ts/principles.md` (v3.1, with P2 reframed as type-level rather than channel-level).

What v0.1 did not anticipate:

- ~~**No polynomial GCD in v1.**~~ **Updated by ADR-0013 (2026-05-03):** `cas-simplify` v0.4.0+ reduces rational functions by polynomial GCD (Brown–Collins subresultant PRS, multivariate via recursion). `(x²−1)/(x−1)` simplifies to `x+1`. `cas-verify` continues to use cross-multiplication for equality decisions (still GCD-free; sound and complete over Q(x₁,…,xₙ)) and now emits reduced witnesses on inequality.
- ~~**Provenance has read but no write.**~~ **Closed by the typed-flags shard (worklog 029) and surfaced in worklog 032 (2026-05-03):** `runTool`'s work case writes a provenance record (`packages/contract/src/runner.ts`, factored into `executeToolDef` per ADR-0012). Every successful tool run produces `$CAS_STORE/provenance/<hh>/<output_hash>.json` with the record shape from §3.2. The doc lag (this bullet, §3.5, §10.1 item 2) was caught while landing the composition layer.

The substrate question (TS/Bun) was relitigated and resolved in conversation; it remains SETTLED. See §1.3 for the four pillars.

---

## 1. Context and motivation [SETTLED]

The legacy scientific computing stack (Mathematica, MATLAB, Python/SymPy, even much of Julia's symbolic ecosystem) was designed for a human at a notebook. Its primary failure mode is that composability is unprincipled: every function can in principle interact with every other through a globally-mutable evaluator state, with no place in the system where one can stand and assert "this part is correct." Reproducibility is a notebook convention rather than a property of values.

The design target here is different. Agents — not humans — are now the primary consumers of scientific computing tools. An agent-first ecosystem optimises for predictable, introspectable, composable tools whose outputs carry their own derivation. The thesis is that this is not just incrementally better than the legacy stack but qualitatively different, in ways that compound: an agent that can plan a computation statically, validate it against a typed contract, and re-execute its provenance years later, is doing something the legacy stack cannot.

The empirical premise is that current frontier models can produce faithful, golden-master-passing ports of non-trivial scientific code (Shewchuk's geometric predicates, NJOY, xAct/TensorGR, Reich-Moore resonance reconstruction) in hours, not months. The bottleneck has shifted from implementation throughput to specification quality. This PRD is, in part, an attempt to specify well.

### 1.1 Design principles [SETTLED]

1. **Unix philosophy.** One tool, one job. Tools are independently versioned, independently tested, independently invokable.
2. **Agents are the customer; whatever they want is the spec.** Tools are designed for agents to discover, plan over, and compose. Human ergonomics follow from agent ergonomics, not the reverse.
3. **Correctness is alpha and omega.** Performance matters only insofar as it does not block use. Correctness is verified by typed contracts, property-based tests, golden masters, and where tractable, proof objects.
4. **Composability is effortless.** Tools speak a common typed value language. Composition is by-pipe or by-manifest, never by shared state.
5. **The legacy stack should be obsolete after this exists.** Not by replication, but by being better at what working scientists actually do.

### 1.2 Out of scope [OUT]

- PDE-class sparse solvers, multigrid, FEM at research scale.
- GPU-bound numerical kernels (CUDA, ROCm, Metal).
- Real-time or streaming computation.
- Distributed computation across machines (initial version is single-host).
- Anything where vendor BLAS/LAPACK is doing the load-bearing work at scales >~1000 dimensions.

The 10% of scientist workflow these cover is the part where the legacy stack retains a real moat. Cede it cleanly. The other 90% is the target.

### 1.3 Substrate [SETTLED]

TypeScript, executed on Bun (preferred) or Node. Single-binary distribution via `bun build --compile`. Sandboxed execution via process-level isolation; no shared filesystem outside explicit scratch directories; no network access from tools by default.

This decision was challenged and re-defended on 2026-04-28; the four pillars on which it rests:

1. **Bottleneck has shifted from implementation to specification.** The relevant question is not "in which language is the mathematics most natural" but "in which language does an agent most reliably produce a contract-conforming tool on the first attempt." Different objective function from the one the legacy stack optimised.
2. **TS agent fluency is empirically dominant by a margin that is not subtle.** Training-data corpus for TS/JS exceeds Julia by roughly two orders of magnitude. The structural type system gives `tsc --noEmit` and the LSP as fast machine-checkable feedback. The npm ecosystem is large enough that tools rarely need to invent APIs.
3. **Cold-start budget disqualifies Julia.** §6.1 requires sub-100ms cold start so that agents can invoke speculatively. Julia interpreter startup alone is 100–500ms before user code. Bun cold-starts in ~10ms; the running implementation measures around 50ms including stdin + canonicalisation. C clears the latency bar but loses on pillar 2. Lean has its own REPL latency. The intersection of (sub-100ms cold start) ∩ (top-tier agent fluency) ∩ (mature sandboxing) ∩ (deterministic single-binary distribution) is essentially `{TS-on-Bun}` today.
4. **The value protocol erases the substrate at the boundary.** Tools speak content-addressed JSON; what a tool is written in is invisible to everything outside it. Implementation language becomes a purely internal optimisation. If pillar 2 ever changes, the substrate can be re-evaluated tool-by-tool without ecosystem-wide migration.

The 10% out of scope (§1.2) is precisely where Julia's numerical strengths matter and where TS would be wrong. The partition is correct. Existing Julia infrastructure (Sturm.jl, BennettIR.jl, Feynfeld.jl, NJOY.jl, TensorGR.jl) is not in scope here; if interop is ever wanted, it goes through the value protocol.

### 1.4 Iteration culture [SETTLED]

The reference model for this ecosystem is the npm registry and the corpus of scientific journals — *not* the Linux kernel and *not* the standard library of any single language. Specifically:

- Iteration to v144 of any tool is expected and not a problem. The discipline is the contract (§4), not the elegance of any individual tool.
- Duplication is not waste; it is exploration. Ten tools that do polynomial factoring with different algorithms, different tradeoffs, different domains of validity, and different bugs are ten data points about what works. They all coexist in the registry. Agents pick which to call based on the task.
- No tool is canonical. No tool is privileged. The only filter on admission is the contract.
- Bad tools are admissible if they declare themselves bad. A tool whose `--invariants` says "works only for univariate polynomials of degree ≤ 5" is useful and admissible. A tool that lies about its invariants is not.
- Abandoned tools are fine. The provenance system means abandoned tools are still re-executable years later.
- This document will be wrong in many places. The next agent should expect to discover this through use and propose revisions.

The single discipline that does not bend is the contract. Everything else is exploration.

---

## 2. The Value Protocol [SETTLED in shape, BUILT for the MVP subset, OPEN for extension]

**This is the centrepiece. Every other design decision is downstream.**

The value protocol is the typed value language in which all tools communicate. It is the boundary at which composition happens. Get this right and tools compose for free. Get it wrong and the ecosystem reproduces Mathematica's failure mode at the boundary.

### 2.1 Required properties [SETTLED]

- **Typed.** Every value has a `kind` discriminator. Tools declare which kinds they consume and produce.
- **Closed.** The set of primitive node kinds is small, fixed, and exhaustively known. New domains do not add new primitives; they add `tagged` variants over existing primitives.
- **Self-describing.** A value, in isolation, contains enough metadata to be parsed, validated, and rendered without external context.
- **Content-addressable.** Every value has a canonical serialisation and a content hash derived from it. Two values with the same hash are the same value.
- **Provenance-bearing.** Every value optionally carries a derivation tree (see §3). The derivation is itself a value in the protocol.

### 2.2 Primitive node kinds [BUILT, with named extensions deferred]

The MVP ships ten kinds. They are exhaustive over the discriminator; a tool that pattern-matches `value.kind` covers all cases.

| Kind | MVP shape | Status |
|---|---|---|
| `symbol` | `{kind, name: string, namespace?: string}` | BUILT |
| `string` | `{kind, value: string}` | BUILT |
| `integer` | `{kind, value: string}` (canonical decimal, big) | BUILT |
| `rational` | `{kind, num, den}` (lowest terms, den > 0) | BUILT |
| `float64` | `{kind, bits: string}` (16 hex chars, big-endian IEEE 754) | BUILT |
| `boolean` | `{kind, value: bool}` | BUILT |
| `list` | `{kind, items: Value[]}` | BUILT |
| `record` | `{kind, fields: {string → Value}}` | BUILT |
| `expression` | `{kind, head: string, args: Value[]}` | BUILT |
| `tagged` | `{kind, tag: string, payload: Value}` | BUILT |

Deferred (will be added accretively, no breaking change because of §2.3):

- ~~`algebraic`~~ — superseded. **Algebraic numbers are encoded as
  `expression { head: 'Root', args: [Polynomial, k] }` per ADR-0018.**
  Choosing an `expression` head over a new top-level kind preserves
  the "ten kinds, exhaustive" guarantee and lets pattern-matchers
  that don't know `Root` pass it through verbatim under the foreign-
  pass-through invariant (§2.3). Substrate `@workbench/alg-num`
  ships canonical construction (`makeRoot`, `makeRootByIndex`),
  refinement (`refineRoot`), encoding (`rootToValue` /
  `valueToRoot`), and field arithmetic (`algNumAdd`, `algNumMul`,
  `algNumInv`, etc.) via Sylvester resultants. Real-only in v0.1;
  complex algebraic naming is a future shard. Consumer wired in
  `tools/poly-roots` (deg-≥5 path; bead `yoc`).
- `indexed` — expression with bound and free indices; dummy indices alpha-equivalent.
- `operator-string` — non-commutative product of generators, with optional algebra tag (Clifford, Pauli, Heisenberg, custom).
- `polynomial` — multivariate polynomial in named indeterminates over a specified coefficient ring.

**Resolved from v0.1:** `expression` is a primitive. Its shape is small and fixed (`head` + `args`); the Lean discipline (small inductive type) is right; the Mathematica universal head is wrong.

**Resolved from v0.1:** `string` is a primitive (#10). The MVP no longer rides source text on `{kind:"symbol", namespace:"source"}`; `expr-parse` consumes a `string` value directly. The change was non-breaking under the foreign-pass-through invariant.

**Open question (carried forward):** Binders (∀, ∃, λ, ∫, ∑) representation. De Bruijn, locally-nameless, named with explicit α-equivalence? Recommendation unchanged: locally-nameless, since it's the standard in modern proof assistants and handles capture-avoidance cleanly. Decide before any tool that handles binders is written.

**Open question (carried forward):** Context carriers for `indexed` and `polynomial`. Where does the metric, manifold dimension, coefficient ring live? Two options: (a) every value carries a `context` field referencing a separate context value; (b) tools take a context as a separate input alongside the value. Recommendation unchanged: (a), with context values being content-addressed like everything else, so two computations sharing a context share its hash.

### 2.3 Composability invariant [SETTLED]

Tools touch only the kinds they declare. Foreign nodes pass through verbatim. This is what makes mixed-kind expressions composable.

Concretely: `clifford-normalize` walks an expression tree, finds nodes tagged `clifford-product`, normalises them in place, and returns the tree with all other nodes byte-identical to input. `polynomial-factor` does the same for polynomial nodes. The composition `clifford-normalize | polynomial-factor` is meaningful and deterministic.

In the MVP, `cas-simplify` enforces this by wrapping out-of-scope subterms in `tagged 'cas-simplify/out-of-scope'` rather than crashing or silently producing wrong output. The wrapper makes the pass-through visible and downstream-inspectable.

This must be enforced by property test in every tool: random expressions with foreign nodes mixed in must round-trip with foreign nodes preserved exactly. No exceptions.

### 2.4 Canonical serialisation [SETTLED, BUILT]

JSON. A strict subset:

- Object keys sorted lexicographically by UTF-16 code units.
- No whitespace anywhere.
- Strings: JSON-escaped per RFC 8259, control chars below 0x20 as `\u00xx`, with one extension: forward slash is never escaped (`/`, never `\/`).
- **No raw JSON numbers anywhere.** All numerics live inside `integer`, `rational`, `float64` whose number-bearing fields are strings. This is what makes canonicalisation total and deterministic.
- Booleans: literals `true`/`false`. (`null` is reserved but unused.)
- Arrays: JSON arrays.

Implementation: `packages/protocol/src/canonical.ts`. Validated by 1000-trial random round-trip property test (`packages/protocol/test/protocol.test.ts`). Round-trip property: `parse(canonicalize(v)) ≡ v` and `canonicalize(parse(canonicalize(v))) = canonicalize(v)`.

CBOR is no longer being considered for v1. JSON is fast enough in the measured workflows; revisit if a real performance need surfaces.

### 2.5 Prior art to read before designing [SETTLED]

- **Lean 4 `Expr`.** Typed AST discipline. Read `Lean.Expr` definitions and the elaborator's treatment of metavariables.
- **MathJSON (Cortex Compute Engine).** Starting point but too loose; treat as cautionary. The MVP rejects MathJSON's universal-head approach.
- **OpenMath standard.** Older, more rigorous attempt at a canonical mathematical value language.
- **egg / egglog.** E-graph representation for equality saturation. Relevant for any tool that performs term rewriting at scale.
- **Nix derivations.** Content-addressed value model with provenance. The provenance store layout in `packages/contract/src/provenance.ts` is Nix-flavoured.
- **IPLD.** Content-addressed linked data.

The value protocol design document should be one page when finished. The `kinds.ts` source file is currently the closest thing to that one page; treat it as the reference.

---

## 3. Provenance [SETTLED in shape, BUILT for read, OPEN for write integration]

Every value optionally carries a derivation tree describing how it was produced. This is the substrate of correctness and reproducibility.

### 3.1 Required properties [SETTLED]

- **Closure.** A derivation tree references only content-addressed inputs (other values, tools by version+hash, lockfiles by hash, goldens by hash).
- **Re-executability.** Given a derivation tree and access to the content-addressed store, any agent can re-execute it and verify the result matches.
- **Composability.** When `tool-b` consumes a value produced by `tool-a`, the resulting value's derivation tree includes `tool-a`'s as a subtree.

### 3.2 Provenance node shape [SETTLED, BUILT]

```typescript
interface ProvenanceRecord {
  tool: { name: string; version: string };
  inputs: { name: string; hash: Hash }[];
  flags: Record<string, string>;
  output_hash: Hash;
}
```

Note the deliberate omission of `timestamp`, `lockfile_hash`, `goldens_validated`. Provenance describes *what* the computation was, not *when* it ran or what the surrounding ceremony was. Timestamps break content addressing; lockfile hashes belong to the tool record (§3.4 below); golden validation belongs in CI logs, not in per-value provenance.

On-disk layout: `$CAS_STORE/provenance/<hh>/<hash>.json` where `<hh>` is the first two hex chars of the output value's hash and `<hash>` is the full output hash. Indexed by output so `--provenance-of <output-hash>` is an O(1) lookup.

### 3.3 Determinism requirement [SETTLED]

Every tool must be deterministic given its inputs and version. No `Date.now`, no `Math.random` without explicit seed input, no parallel reductions whose order is not part of the spec, no iteration over unsorted hash sets, no dependence on locale or environment variables. Property test: same input + same version → bit-identical output. Tools failing this property are inadmissible.

Validated for the MVP via the 200-trial random-expression hash-stability test in `packages/cas-core/test/cas-core.test.ts`.

**Externalised entropy (ADR-0005).** Tools that genuinely require randomness (quantum sampling, Monte Carlo, hardware execution) admit it as a typed `entropy` field in the input record (hex-encoded `S.kind("string")`) and remain deterministic given those bytes. The one privileged exception is `entropy-source`, which reads OS entropy and carries the manifest annotation `nondeterministic: true`. This is the only contract relaxation; every other tool stays strictly deterministic by default. See `docs/adr/0005-externalised-entropy.md` for the full rationale and composition pattern.

### 3.4 Tool records [OPEN]

Tool binaries are themselves content-addressed. A "tool record" is a value containing `{name, version, source_hash, lockfile_hash, transcript_hash?}`. Its hash is what `provenance.tool` should ultimately reference. Not yet built; provisional implementation in §3.2 just stores `{name, version}` strings.

**Open question (carried forward):** Do we record agent transcripts as provenance? When a tool was generated by an agent, the transcript is arguably part of its derivation. Recommendation unchanged: yes, but as a separate `tool-provenance` record content-addressed alongside the tool binary, not inline in every value's derivation.

### 3.5 Provenance + content-addressed value store [SETTLED, BUILT]

`runTool` (subprocess) and `Workbench.run` (in-process) both write
*three* artefacts on every successful run:

1. The output Value at `$CAS_STORE/values/<hh>/<output_hash>.json`.
2. The provenance record at
   `$CAS_STORE/provenance/<hh>/<output_hash>.json` (shape per §3.2).
3. A reverse-index file at
   `$CAS_STORE/by-input/<hh>/<input_hash>--<tool>--<version>.json`
   whose content is the output hash. This makes
   `Workbench.lookup(name, input)` an O(1) stat + read.

The implementation lives in `executeToolDef`
(`packages/contract/src/execute.ts`), shared between both surfaces
(ADR-0012, "single-implementation discipline") so they produce
byte-identical state for the same `(tool, version, input,
explicit-flags)`. Recorded `flags` carry only the explicitly-set
keys (ADR-0011); defaults are not recorded so two invocations
differing only in default-overlap produce byte-identical store bytes.
Persistence failures are best-effort: a write error surfaces as a
stderr warning (subprocess) or a `console.warn` (in-process), and
never destroys the user's output.

For tools whose `def.nondeterministic === true` (`entropy-source`),
the reverse-index write is *skipped*. The forward provenance is
still written, and the record carries `nondeterministic: true` so
consumers reading it know the output is not re-derivable from inputs
alone. `Workbench.lookup` and `runMemoized` both refuse on
nondeterministic tools — caching them would silently invent a
determinism the contract does not promise (ADR-0005 §"Composition
pattern").

Round-trip checks: `packages/compose/test/compose.test.ts` covers
("provenance record matches subprocess for the same input",
"Workbench.lookup misses on a fresh store, hits after run",
"Workbench.lookup hits are byte-identical to a fresh run",
"Workbench.runMemoized: first call runs, second call hits cache").

---

## 4. Tool Contract [SETTLED, BUILT]

Every tool in the ecosystem satisfies the following contract. No exceptions; tools failing the contract are not admitted to the registry.

### 4.1 Interface [BUILT]

Implementation: `packages/contract/src/runner.ts`. A tool author calls `defineTool({...})` (a typed identity that lets TS infer the input/output value types from the schema) and dispatches via `runTool(def)` against `argv`.

- Single executable. Reads JSON from stdin, writes canonical JSON to stdout. Errors to stderr, non-zero exit code on failure.
- Standard flags:
  - `--schema` — emits a record `{input, output}` of *encoded `Schema`* values (ADR-0004). Decode via `decodeSchema` to obtain a real `Schema` for filtering / planning.
  - `--examples` — emits a list of `{description, input, output | error, flags?}` records. Every example's `input` and `output` is required to conform to the tool's declared schema; the runner enforces this at load time.
  - `--invariants` — emits a list of `{name, statement, machine_checkable?}` records.
  - `--version` — emits `{name, version}`.
  - `--provenance-of <hash>` — given a value hash, emits the derivation tree if known, else a tagged null.
  - `--test` — runs the tool's optional in-process property tests; exits 0 on pass, 1 on fail, 2 if no hook is registered.
  - `--help` / `-h` — emits human-readable usage.
- Tool-specific flags follow `--key value` form and are passed verbatim into the tool's `fn(input, flags)`.
- The runner validates input against `schema.input` *before* `fn` runs, narrowing the parsed Value to the declared TS type. It validates output against `schema.output` after `fn` returns; non-conformance is an internal contract violation and fails loudly. Tool authors no longer hand-roll input parsers (ADR-0004).

### 4.2 Required artefacts [SETTLED, partially BUILT]

A tool ships with:

1. The compiled binary, content-addressed. *MVP: source + Bun runtime; `bun build --compile` step deferred.*
2. A schema declaration as a `Schema` (ADR-0004). *BUILT: required field of `ToolDefinition<I, O>`, which infers `I`/`O` from the schema for use in `fn`.*
3. A set of examples. *BUILT: required field. Each example's input and output is checked to conform to the schema at tool-load time. The current floor is "every code-path branch + edge cases"; ≥30 to call a tool v1-complete.*
4. A set of invariants. *BUILT: required field.*
5. A property-based test suite, OR a `--test` hook (§4.3). *BUILT: workspace-level property tests in `packages/*/test/`; per-tool `--test` hooks for the tools whose properties are best checked in-process.*
6. A golden-master test set, content-addressed. *BUILT: every tool with non-trivial behaviour has 30+ goldens.*
7. A README. *BUILT.*

A tool without all seven is not a tool; it is a prototype.

### 4.3 Property-based testing [SETTLED, partially BUILT]

Property tests are first-class. Every tool ships with generators specific to its domain. Properties tested include at minimum:

- The composability invariant (§2.3): foreign nodes round-trip.
- Determinism (§3.3): same input → same output.
- Domain-specific invariants (e.g., for `cas-simplify`: idempotence; for `cas-verify`: symmetry, soundness on identical-canonical-form, no false equality on out-of-scope).

MVP status: the workspace test suite exercises the cas-core algebra (47 tests including 200-trial random properties) and the protocol (28 tests including 1000-trial random hash determinism). What is NOT yet built: a `--test` flag on each tool that runs that tool's own property suite in-process. CI runs `bun test`, which suffices for now.

### 4.4 Golden masters [SETTLED, BUILT for `oracle`]

Goldens live alongside tool source as `*.golden.json` files in `tools/<tool>/goldens/`. They are records of `{input, output, flags?}`. Diff modes available via the `oracle` tool (§4.5):

- **exact** — bit-identical canonical bytes. *BUILT.*
- **structural** — protocol hash equality. *BUILT (currently coincides with exact for our protocol; the distinction is a hook for the modes below).*
- **sign** — for predicates: output sign agrees. *Not built.*
- **tolerance** — for floating-point: output within specified tolerance. *Not built.*

Goldens are regenerated only deliberately, with a record of what changed and why.

### 4.5 The `oracle` tool [BUILT]

`tools/oracle/tool.ts`. Runs any tool against any goldens directory. Exit 0 iff every golden passes. Reads goldens from a path symbol; spawns the tool under test via `bun <path>`; compares canonical output to canonical expected. Single source of truth for what "passing" means.

---

## 5. Composition [SETTLED, partially BUILT]

### 5.1 By pipe [BUILT]

Linear pipelines compose by stdin/stdout. Tools are stream-compatible: they consume a single JSON value, emit a single JSON value. No multiplexing, no streaming partial values, no cleverness. Validated end-to-end:

```
echo '{"kind":"symbol","name":"x + 1","namespace":"source"}' \
  | bun tools/expr-parse/tool.ts \
  | bun tools/cas-simplify/tool.ts
```

### 5.2 By manifest [SETTLED in intent, NOT YET BUILT]

Non-linear workflows (fan-out, fan-in, conditional branches) are expressed in a small declarative manifest format. The manifest interpreter is itself a tool (`run-manifest`). The manifest is content-addressed; its execution produces a provenance tree that can be re-run.

Manifest format: restricted JSON, sharing the value protocol's serialisation. (YAML rejected due to whitespace ambiguity.) Concrete schema deferred until at least one workflow demands it. v1 (photo-to-verify) is purely linear; defer.

### 5.3 No shared state [SETTLED]

Tools never share state out-of-band. No global variables, no `$Assumptions`, no implicit context. Every input is explicit; every output is explicit. This is the discipline that distinguishes this ecosystem from Mathematica.

The MVP runner enforces this by being process-per-invocation; nothing persists between calls except the content-addressed store, which is read-only from the tool's perspective (provenance writes are append-only).

---

## 6. Agent catnip [SETTLED]

This section is the most important after §2. The whole ecosystem rests on agents reaching for these tools by preference.

The properties below are not soft preferences. They are hard requirements: a tool that fails any of them is broken, even if it computes the right answer.

### 6.1 Properties of a tool an agent will reach for

- **Bit-deterministic.** Same input, same version → bit-identical output. Tiered as of ADR-0015 (2026-05-04): the symbolic majority is bit-identical *cross-platform, forever* (the unconditional rule); numerical tools annotated `numerical: true` are bit-identical *given the platform fingerprint* (`{arch, os, runtime}`), with cross-platform divergence honestly recorded in the provenance record's `platform` field. Stochastic tools annotated `nondeterministic: true` (ADR-0005, today only `entropy-source`) opt out of the determinism contract entirely. The three annotations are mutually exclusive in practice. See `docs/adr/0015-determinism-tier.md` for the per-output tier conditioning, the `runMemoized` semantics, and the cross-Bun-version measurement that fixes the fingerprint shape.
- **Schema-discoverable.** `--schema` returns a value the agent can read once and immediately know exactly what is required, optional, types, output shape. Schemas are precise (no `any`, no `object`); ambiguity is a bug.
- **Example-rich.** `--examples` returns many varied (input, output) pairs covering common cases, edge cases, and at least one error case. Five examples is too few; thirty is reasonable; a hundred is fine. *MVP currently sits at 5–10 per tool; this is below threshold and should be raised before declaring Phase 1 done.*
- **Forgiving on input, strict on output.** Accept multiple representations; normalise internally; emit one canonical form.
- **Errors that teach.** When a tool errors, the message tells the agent precisely what was wrong, where, what would have been valid, and ideally a corrected example. The MVP's `ProtocolError` class carries a path; tool-specific errors include suggested fixes (`expr-parse`: "Wrap your text as `{kind: 'symbol', namespace: 'source', ...}`").
- **Loud on failure, quiet on success.** A tool that silently produces wrong output is worse than no tool.
- **Idempotent where the operation allows.** `cas-simplify(cas-simplify(v)) = cas-simplify(v)` is a property test. Validated 200 trials random.
- **Cheap to invoke.** Cold start under 100ms. The MVP measures ~50ms on Bun including stdin and canonicalisation.
- **No memory.** Tools do not remember previous invocations. Pure functions of input plus version.
- **Few flags, all orthogonal.** One to five flags, each with clear independent meaning. Flags that change the *type* of the output should be different tools.
- **Honest about its scope.** A tool that fails on inputs outside its declared scope is correct. The MVP's `cas-simplify` returns `tagged 'cas-simplify/out-of-scope'`; `cas-verify` returns `{equal: false, reason: 'out-of-scope', detail: ...}`.
- **Composable by default.** Output shapes match what other tools accept. Validated end-to-end for the `expr-parse | cas-simplify` pipe and the `cas-verify` shape.
- **Versioned and pinnable.** Pinning `cas-verify@0.4.7` should give bit-identical behaviour forever.

### 6.2 Discoverability [NOT YET BUILT]

A registry tool (`registry-list`, `registry-search`) returns the list of installed tools, with their schemas, examples, and invariants. Search by *kind*, not just by name: "find me every tool that consumes a `polynomial` and produces an `expression`" must be answerable. This is what enables agents to discover compositions they would not have thought of by name.

The registry is a content-addressed directory plus a small index. No network required, no central authority. New tools are admitted by being placed in the registry directory and validated against the contract (§4).

**Phase 0 hole.** Build `registry-list` and `registry-search` before Phase 1 is declared done.

### 6.3 Planning

An agent given a research task:

1. Queries the registry by output kind.
2. Reads schemas of candidate tools.
3. Plans a composition (pipe or manifest) that takes input kinds to output kinds.
4. Validates the plan against the registry's type information *before executing*.
5. Executes.
6. Inspects provenance of result.
7. If the result is unexpected, follows the provenance back to the leaf computation and identifies the step.

Step 4 — static validation of compositions — is the property no legacy stack provides. It is the main agent-velocity multiplier. Prerequisite: §6.2 registry tools exist.

### 6.4 Development process implication

The agent is the QA. During development of a tool, the loop is:

1. Agent writes a tool draft.
2. Another agent (or the same agent, fresh context) is given a task and the tool, with no other coaching.
3. Observe what the agent reaches for, what it gets wrong, where it gives up, what error messages confused it, what schema fields it misread.
4. The frustrations are the bug list. Fix and iterate.

Tools that have not been through this loop with at least one independent agent are not finished. **Operational note:** this is a hiring requirement masquerading as a principle. It needs to be in the cost model, not just the principles list.

---

## 7. Proof-carrying outputs [OPEN, long-term]

For the subset of tools where it is tractable — exact rational arithmetic, polynomial identity checking, finite group computations, certain symbolic simplifications — tools may emit a Lean proof object alongside the result. The proof typechecks against Mathlib (or a vendored subset).

This is the moat. A tool whose output is accompanied by a Lean term is qualitatively different from one whose output you must trust. The legacy stack cannot do this because its evaluator semantics are not formal.

This is not required for v1. It is the direction the ecosystem grows. Existing Alethfeld work on adversarial proof verification is directly relevant; the integration path is: tool emits Lean term → Alethfeld verifies → verified term is the provenance leaf. **Note for emphasis:** the v1 ecosystem is not interesting on its own; it is interesting because it is the substrate that makes §7 possible.

---

## 8. Notebook surface [OPEN]

Scientists do not adopt tools that are only callable from agent loops. An interactive notebook surface is required for adoption, but it must not undermine the discipline above.

Design constraints:

- Every cell is a tool invocation. No cell executes arbitrary user code.
- Every value displayed is provenance-tagged. The "where did this number come from" question is one click away.
- "Reproduce figure 3 from this paper" is a single command that walks the provenance tree and re-executes from the leaves.
- Notebooks are themselves content-addressed values. Sharing a notebook shares a hash.

Quarto and Pluto are the closest existing references. Neither has the discipline. Building on top of one of them, adding the discipline, may be cheaper than building from scratch.

This is v2 work. v1 is CLI-only.

---

## 9. First example: photo-to-verified algebra [SETTLED, BUILT in core]

The first end-to-end demonstration is a workflow scientists actually use daily: pencil-and-paper algebra; want to know if the manipulations are correct.

### 9.1 The workflow

1. User photographs a derivation (a single equation, or a chain of equalities).
2. The agent reads the photo into LaTeX or plain text via vision. (The agent's vision capability is not a tool in this ecosystem; it is the agent's native ability.)
3. The agent calls `expr-parse` to convert the text to expression values.
4. For each claimed equality `A = B` in the chain, the agent calls `cas-verify({lhs: A, rhs: B})`.
5. The agent reports which steps verified, which did not, and where in the derivation the first error occurred.

### 9.2 Tools required

- `expr-parse` — converts plain-text math to expression values. *BUILT.* LaTeX deferred to a sister tool per §1.4.
- `cas-simplify` — applies basic simplifications. Idempotent. Out-of-scope subterms wrapped, not silently mishandled. *BUILT.*
- `cas-verify` — given two expression values, returns whether they are equal as elements of Q(x₁, …, xₙ). On inequality, emits a witness `(lhs - rhs)` in canonical form. *BUILT.*

### 9.3 Mathematical scope for v1 CAS [BUILT]

Implemented in `packages/cas-core`:

- Multivariate polynomial arithmetic over Q, sparse representation, bigint coefficients.
- Rational function arithmetic, with sign-normalised denominator.
- Equality of rational functions by **cross-multiplication**: `a/b = c/d ⟺ a·d = c·b` as polynomials. Sound and complete because Q[x₁,…,xₙ] is an integral domain. **No polynomial GCD required.**
- Expansion of products via `polyMul`.
- Powers via repeated multiplication; non-negative integer exponents only.
- Normalise → emit pipeline producing canonical expression trees, deterministic, idempotent.

Explicitly out of scope for v1:

- ~~Polynomial GCD and reduction.~~ **Landed in ADR-0013** (2026-05-03). `cas-simplify` v0.4.0+ reduces rational functions to lowest terms via Brown–Collins subresultant PRS in `packages/cas-core/src/poly-gcd.ts`; `cas-verify` witnesses on inequality are now reduced. Modular GCD (Brown/Wang for sparse multivariate) is filed as a follow-up; the MVP stays subresultant-only.
- Substitution of values for variables. Trivial follow-up.
- Differentiation. Trivial follow-up; another tool.
- Integration, equation solving beyond linear, special functions, series expansion, limits, anything transcendental.

### 9.4 Why this first

It exercises the value protocol on the simplest interesting case: multivariate rational functions over Q. The hard cases (non-commutative algebra, indexed tensors, operator strings) are deferred until the protocol has proven itself on the easy case. This minimises rework if §2 turns out to need revision.

It demonstrates the agent-first model in a workflow that is *not* a tech demo: it is something the user actually does. The feedback loop on what makes the tools agent-friendly starts running on day one with real input.

It has unambiguous oracles. SymPy, Mathematica, and Singular all do canonical-form rational function equality. Golden masters generated from any of them validate the implementation.

### 9.5 Acceptance criteria

The CAS workflow is complete when:

1. `expr-parse`, `cas-simplify`, and `cas-verify` each satisfy the tool contract (§4.2) in full. *Currently 4/7 artefacts each: schema, examples, invariants, fn. Missing: README, expanded examples (≥30), per-tool `--test`, full goldens directory.*
2. An agent given a photograph of a real hand-written derivation can verify or falsify each algebraic step, with provenance. *Pending the §3.5 provenance write path.*
3. The provenance of each verification result is re-executable on a different machine to bit-identical result. *Pending §3.5.*
4. Tobias has used the workflow on at least one real derivation he was uncertain about, and the result was useful. *Pending.*

The bar is real use, not impressive demos.

---

## 10. Roadmap [SETTLED in priority, OPEN in dates]

**Phase 0 — Foundation.**
- Value protocol (§2). *BUILT for the 9-kind subset; one-page document = `kinds.ts`.*
- Provenance model (§3). *BUILT for read; write path is the open hole.*
- Tool contract scaffold (§4.2). *BUILT as `runTool`; not yet copy-templated for new tools.*
- The `oracle` tool (§4.5). *BUILT.*
- The `registry-list` / `registry-search` tools (§6.2). *NOT BUILT. Phase 0 exit-blocker.*

**Phase 1 — First workflow.**
- `expr-parse`, `cas-simplify`, `cas-verify`. *Core BUILT; artefacts incomplete (no README, sparse examples, sparse goldens).*
- Provenance write path wired into `runTool`.
- The first photo-to-verification workflow demonstrated on real input.
- A `cas-reduce` tool (polynomial GCD reduction of rational functions) is the first natural Phase 2 tool but is also the first thing an agent will reach for repeatedly; consider promoting to Phase 1.

**Phase 2 — CAS accretion.**
- Differentiation. Substitution. Series expansion. Polynomial GCD / reduction (`cas-reduce`). Driven by what is actually wanted next.
- Per §1.4, multiple overlapping tools are fine.

**Phase 3 — Branching out.**
- Tensor canonicalisation (Portugal's algorithm), Clifford and Pauli normalisation, Gröbner bases over Q, exact linear algebra, Feynman primitives. Each tool follows the contract.

**Phase 4 — Notebook surface.** Per §8.

**Phase 5 — Proof-carrying outputs.** Per §7. Integrates with Alethfeld.

Phases are priority-ordered, not date-ordered. Phase 1 should not start until Phase 0 is genuinely done. After Phase 1, phases overlap freely.

### 10.1 Concrete next-action list

1. ~~Add `string` as primitive #10 (§2.2). Rewrite `expr-parse` input shape; remove the `namespace='source'` smell.~~ **Done.**
2. ~~Wire provenance writes into `runTool` (§3.5).~~ **Done; landed silently in worklog 029, surfaced in worklog 032. Factored into `executeToolDef` per ADR-0012 so the in-process and subprocess surfaces share one implementation.**
3. ~~Build `registry-list` and `registry-search` (§6.2).~~ **Done; both are schema-aware as of ADR-0004.**
4. Fill goldens directories for `cas-simplify` and `cas-verify`. Aim for 30+ each.
5. Write READMEs for the four MVP tools.
6. Add `--test` flag to the runner; wire each tool's property suite under it (§4.3).
7. `bun build --compile` step for single-binary distribution (§4.2 artefact #1).
8. First real-derivation use by Tobias (§9.5 criterion 4).

---

## 11. Success criteria [SETTLED]

Winning when:

1. Three independent tools compose through the value protocol on real research input, and the composition's provenance is re-executable by a separate agent on a different machine to bit-identical result.
2. An agent given a research task and read access to the registry plans and executes a multi-tool workflow without human intervention beyond the task statement.
3. A golden master generated for a tool by one agent, regenerated independently from spec by a second agent, matches bit-identically. (Test of whether the spec is sufficient.)
4. Tobias replaces one Mathematica- or pen-and-paper-based workflow in his actual research with a workflow in this ecosystem and finds it strictly preferable.
5. **An independent agent reaches for tools in the registry by preference when given a task it could solve other ways.** Agents *want* these tools.

Criterion 5 is the load-bearing one. The other four can be satisfied by an ecosystem that nobody wants to use; criterion 5 cannot.

Failing when:

- Tools accumulate ad-hoc JSON shapes outside the value protocol because "this case was special." (The protocol is the moat.)
- The contract (§4.2) is relaxed for any tool because of time pressure. (The contract is the moat.)
- Provenance is treated as audit-trail nice-to-have rather than substrate. (Provenance is the moat.)
- Anyone proposes "let's just call out to Mathematica for this one" as a permanent solution rather than a golden-generation expedient.
- The codebase grows reluctance to add new tools because "we already have one for that." Per §1.4, that is exactly wrong; the only filter is the contract.

The contract, the value protocol, and provenance are non-negotiable. Everything else iterates freely. Number of tools, choice of algorithms, number of versions of any tool, abandonment of tools, refactoring of tools, multiple tools doing the same thing — all explicitly fine.

---

## 12. Notes for the next agent

- The previous discussion that produced v0.1 of this PRD is in chat history; you do not need to read it. The implementation is in the workspace; treat the source as the spec where the prose disagrees with the code.
- The substrate question is settled. If you are tempted to re-litigate TS/Bun, re-read §1.3 first. Four pillars; all four must change before the question reopens.
- The single thing most likely to go wrong is the value protocol (§2). Spend disproportionate effort there. The MVP commits to nine kinds; the deferred four are the next most likely place a wrong design decision will hurt.
- The single thing most likely to be skipped under time pressure is property-based testing. It cannot be skipped.
- The single thing most likely to be skipped because it feels indulgent is the agent-as-QA loop (§6.4). Run every new tool past at least one independent agent before declaring it done.
- The MVP currently has four tools that do not satisfy the seven-artefact contract (§4.2). Closing that gap is more important than building new tools.
- If you find yourself writing a "convenience function" that operates outside the tool contract, stop. Either make it a tool or do without.
- If you find yourself reluctant to write a new tool because "we already have one for that" — write the new tool. Per §1.4, duplication is exploration, not waste.
- The ambition (§1) is to make the legacy stack obsolete. This is achievable but only because of the contract. The contract is the moat. Everything else accretes freely.
