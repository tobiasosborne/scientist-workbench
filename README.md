# scientist-workbench

Agent-first ecosystem of small, contract-conforming tools for exact symbolic computation. Every tool consumes a JSON value on stdin, writes a JSON value on stdout, runs in milliseconds, and is independently versioned.

> **If you are an agent landing in this repo for the first time:** read this file top to bottom *before* invoking a tool. The contract assumes you already know §"The value protocol", §"Standard flags", and §"Hard requirements". The design rationale lives in `PRD-v0.2.md`; this README is operational, the PRD is canonical for design questions.

License: **AGPL-3.0-or-later**. See `LICENSE`.

---

## Substrate

TypeScript on Bun. No build step — every tool runs as `bun tools/<name>/tool.ts`.

```sh
bun --version       # 1.3+
bun install         # one-time, resolves workspace deps
bun run check       # full health check, ~25s
```

Install corner: on **snap-Bun** installs the wrapper at `/snap/bin/bun` is
not directly spawnable from inside another snap-confined Bun process. The
workbench's subprocess machinery handles this transparently via
`process.execPath` and `realpathSync`, so no `BUN_BIN` export is required.
If you ever see `resolveBunBinary: …` errors, set `BUN_BIN` to the
underlying binary (typically `/snap/bun-js/current/_bun/bin/bun`). See
`docs/adr/0001-subprocess-plumbing.md`.

---

## The value protocol

Ten primitive kinds, exhaustive over the `kind` discriminator. A tool that pattern-matches `value.kind` covers every case.

| kind | shape |
|---|---|
| `symbol` | `{kind, name, namespace?}` |
| `string` | `{kind, value}` |
| `integer` | `{kind, value: <decimal-string>}` |
| `rational` | `{kind, num: <decimal-string>, den: <decimal-string>}` (lowest terms, den > 0) |
| `float64` | `{kind, bits: <16 lowercase hex chars, big-endian IEEE-754>}` |
| `boolean` | `{kind, value: bool}` |
| `list` | `{kind, items: Value[]}` |
| `record` | `{kind, fields: {string → Value}}` |
| `expression` | `{kind, head, args: Value[]}` |
| `tagged` | `{kind, tag, payload: Value}` |

**Canonical encoding.** Strict JSON subset:

- Object keys sorted by UTF-16 code units.
- No whitespace anywhere.
- **No raw JSON numbers.** All numerics live inside `integer` / `rational` / `float64` whose number-bearing fields are *strings*. `{"value":1}` is invalid; write `{"value":"1"}`.
- Forward slash is never escaped (`/`, never `\/`).
- `null` is reserved and unused.

Spec & implementation: `packages/protocol/src/canonical.ts`. Round-trip property tested over 1000 random values.

**Content addressing.** `hash(value) = sha256(canonicalize(value))`, hex-encoded (64 chars). Equal canonical bytes ⟹ equal hash ⟹ equal value (modulo collision).

**Foreign-pass-through invariant.** Tools touch only the kinds they declare. Subterms outside a tool's scope must round-trip verbatim, either passed through or wrapped in a `tagged` value with the tool's name in the tag (e.g. `tagged "cas-simplify/out-of-scope"`). PRD §2.3.

---

## Tool invocation

Every tool follows the same shape:

```sh
echo '<canonical-json-input>' | bun tools/<name>/tool.ts [--flag=value ...]
```

Pipe linearly to compose:

```sh
echo '{"kind":"string","value":"(x+1)*(x-1)"}' \
  | bun tools/expr-parse/tool.ts \
  | bun tools/cas-simplify/tool.ts
# → x^2 + (-1)
```

Errors go to stderr with non-zero exit. The `ToolError` shape carries a `suggestion` line where applicable.

---

## Standard flags (every tool)

| flag | emits |
|---|---|
| `--schema` | `{input, output}` representative shapes |
| `--examples` | list of `{description, input, output? \| error?, flags?}` records |
| `--invariants` | list of `{name, statement, machine_checkable?}` records |
| `--version` | `{name, version}` record |
| `--provenance-of <hash>` | derivation tree for that output hash, or `tagged "provenance/not-found"` |
| `--test` | run in-process property tests; exits 0 pass, 1 fail, 2 no hook |
| `--help`, `-h` | human-readable usage |

Tool-specific flags follow `--key=value` or `--key value`. Tools declare their flags via the `F.*` constructors (`F.bool`, `F.str`, `F.int`, `F.enum`) on the `flags` field of `defineTool`; the runner parses argv against the merged standard + tool flag schema with **strict declared arity** (ADR-0011). A boolean switch followed by a positional leaves the positional unconsumed; a value-flag without an inline `=` consumes exactly the next argv token regardless of shape (so `--shots -2` works as expected). Unknown flags, unexpected positionals, or out-of-range int values reject loudly with a suggestion. `F.int` accepts underscore-grouped literals (`--shots=10_000`). Run any tool with `--help` to see the auto-rendered flag table.

---

## Tool catalog

| tool | input | output | summary |
|---|---|---|---|
| `expr-parse` | `string` | `expression` (or leaf integer / rational / symbol) | text → AST. Operators `+ − * / ^`, identifiers, integer / rational / decimal literals. LaTeX is out of scope (sister tool). |
| `cas-simplify` | any `Value` | canonical `Value` | canonicalise over `Q[x_1,…,x_n]` / `Q(x_1,…,x_n)`. Foreign subtrees wrapped in `tagged "cas-simplify/out-of-scope"`. As of ADR-0013, rational functions are reduced by polynomial GCD: `(x²−1)/(x−1)` simplifies to `x+1`. Idempotent. |
| `cas-verify` | `record{lhs, rhs}` | `record{equal, reason?, witness?, side?, detail?}` | decide A = B over `Q(x)` by cross-multiplication (sound and complete; no GCD needed). On inequality: emits `lhs - rhs` as a witness. |
| `mod-pow` | `record{base, exponent, modulus}` | `integer` | modular exponentiation over `Z/mZ`. Square-and-multiply; canonical-residue output in `[0, m)`. |
| `mod-inv` | `record{value, modulus}` | `record{invertible, inverse?, gcd}` | modular inverse via extended Euclid. Record-with-flag (ADR-0003): `inverse` present iff invertible; `gcd` always present. |
| `ntt` | `record{n, modulus, primitive_root, direction, x}` | `list<integer>` | Number-Theoretic Transform over `F_p` for `p = 998244353, g = 3`. Power-of-two via Cooley-Tukey on Montgomery REDC; arbitrary `n \| p−1` via Bluestein chirp-z. |
| `oracle` | `record{tool_path, goldens_dir, mode?}` | `record{passed, failed, total, mode, results}` | golden-master harness. Modes: `exact` (default), `structural`. Exits 1 if any golden fails. |
| `registry-list` | `record{tools_root?}` | `list` of metadata records | discover installed tools. Schemas in the output are wire-encoded (decode via `decodeSchema`). |
| `registry-search` | `record{tools_root?, input_kind?, output_kind?, head?, name_substring?}` | `list` of metadata records | filter the registry by schema-derived predicates. All filters AND-conjoined. |
| `sturm-simplify` | Sturm channel IR (ADR-0006) | Sturm channel IR | IR canonicaliser. Idempotent. Eliminates `ry(0)`/`rz(0)`, fuses same-axis adjacent rotations, sorts/dedupes controls, recursively simplifies `cases` arms. No cross-axis fusion. Oracle circuits untouched. |
| `sturm-execute` | Sturm channel IR | `record{classical_refs, outcomes, precision}` | Pure-analytic state-vector simulation. Returns the post-circuit distribution over classical-ref resolutions. v0.1 is float64; supports `prepare`/`ry`/`rz`/`observe`/`cases`. Oracle, discard, qubit-cap > 12, free-symbolic angles → `tagged "sturm-execute/out-of-scope"`. Phase 2 `sturm-sample` consumes this. |
| `sturm-equivalent` | `record{lhs, rhs}` of two channels | `record{equal, reason?, witness?, detail?}` | Decide whether two Sturm channels denote the same arrow. Composes `sturm-simplify` (canonical-form byte-equal) with `sturm-execute` (distribution comparison). Sound on equal=true and on not-equivalent (with witness); honest out-of-scope when distributions match but bytes differ (matrix equivalence is the deferred exact path). |
| `entropy-source` | `record{n_bytes}` | `record{bytes (hex), source_kind: "os-urandom"}` | The workbench's *only* nondeterministic tool (manifest carries `nondeterministic: true`; ADR-0005). Reads OS randomness via Web Crypto `getRandomValues`. Every other randomness consumer takes an `entropy: string` field on its input and stays deterministic given those bytes; this tool is the single auditable bridge from the world's randomness to a value in the protocol. |
| `sturm-sample` | `record{distribution, entropy, shots}` | `record{samples, entropy_consumed}` | Born's rule applied. Walks the input distribution's CDF using 8 bytes of entropy per shot (ADR-0007 byte budget) and emits one `classical_resolutions` row per shot. Strictly deterministic given entropy. Out-of-bytes / negative-shots / malformed entropy → `ToolError` with remediation suggestion. Composes `sturm-execute` (analytic distribution) + `entropy-source` (bytes) into the canonical three-step pipeline. |
| `sturm-controlled` | `record{control_wire, channel}` | Sturm channel IR \| `tagged "sturm-controlled/out-of-scope"` | Channel combinator: prepends the control wire to every `ry`/`rz` (recursively through `cases` arms) and augments the channel's input/output signatures. ADR-0006's IR admits `controls` only on `ry`/`rz`, so `prepare`/`observe`/`oracle`/`discard` in the body — and any wire-id collision with the control — produce a boundary tag. |
| `sturm-then` | `record{first, second}` of two channels | Sturm channel IR \| `tagged "sturm-then/signature-mismatch"` | Channel combinator: sequential composition `f; g`. First's wire ids are kept; second's input wires are renamed positionally to match first's outputs and second's other ids are shifted by `max(first.ids)+1`. Length, kind, or dim mismatch at the boundary → boundary tag. Classical refs flow across the boundary unchanged. |
| `sturm-tensor` | `record{left, right}` of two channels | Sturm channel IR | Channel combinator: parallel composition (the monoidal product). Total — every pair has a tensor product. Right's wire ids are shifted by `max(left.ids)+1`; left is preserved verbatim. Identity laws and associativity hold byte-equal under the chosen rename discipline. Classical refs are NOT renamed (limitation: tensoring two channels that bind the same ref yields a duplicate-binding well-formedness flaw). |
| `sturm-find` | `record{n_bits, marked, shots?, entropy?}` | `record{distribution, samples?, iterations}` | Grover's algorithm. Wraps `@workbench/sturm-lib`'s `find`/`equalTo`/`phaseFlipMany`, runs through `sturm-execute` for the analytic Born distribution and (when `shots > 0`) `sturm-sample` for shots. v0.1 caps at `n_bits ≤ 3` (mcz currently supports n ∈ {1,2,3}). Predicted P(marked) for n=2 single-marked is 1.0; for n=3 single-marked, ≈0.945. |
| `linalg-solve` | `record{A: list<list<float64>>, b: list<float64>}` | `record{x, residual_norm, b_norm, condition_estimate, growth_factor, method, iterations, warnings}` \| `tagged "linalg-solve/singular"` | First numerical-tier tool (ADR-0014). LU with partial pivoting + iterative refinement + Hager 1-norm condition estimate. Pure TS on `Float64Array`, capped at `n ≤ 200` for v0.1. Output is *agent-honest*: not just `x` but the residual, condition, growth factor, and warnings — everything a planner needs to decide whether to trust the answer. Singular A → `tagged`; non-square / NaN / oversized → `ToolError`. |
| `integrate-1d` | `record{f: expression, var: symbol, a: float64, b: float64}` | `record{value, error_estimate, n_evals, converged, iterations, method, warnings}` \| `tagged "integrate-1d/non-finite-during-eval"` \| `tagged "integrate-1d/degenerate-interval"` | Numerical-tier (ADR-0014/0015) `numerical: true`. Adaptive Gauss-Kronrod G7K15 with global priority-queue bisection (QUADPACK-style; constants from GSL `qk15.c`). Closed integrand vocabulary: `+ - * / ^ neg exp sin cos tan log sqrt abs` plus constants `pi`, `e`. Output is *agent-honest*: `converged` is a field, not a separate boundary — a planner reads it and decides whether to retry with a higher budget. Pole / NaN at any quadrature node → `tagged "integrate-1d/non-finite-during-eval"`; `a >= b` → `tagged "integrate-1d/degenerate-interval"`; unknown vocabulary or non-finite bounds → `ToolError`. |
| `optimize-lbfgs-projected` | `record{f: expression, grad: list<expression>, vars: list<symbol>, x0: list<float64>, bounds: list<list<float64>>, options?: record}` | `record{x, fun, jac, grad_inf_norm, iterations, nfev, status, status_message, success, bfgs_skip_count, line_search_fail_count, active_bounds_count, method, warnings}` \| `tagged "optimize-lbfgs-projected/{infeasible-bounds,x0-outside-bounds,non-finite-during-eval}"` | Numerical-tier (ADR-0014/0015) `numerical: true`. L-BFGS with active-set projection, More-Thuente-style line search, Powell's curvature safeguard. Algorithm structure follows Byrd-Lu-Nocedal-Zhu 1995 / Morales-Nocedal 2011 v3.0; cross-validated against SciPy 1.14.1 (Northwestern Fortran v3.0 backend) on a 25-case manifest spanning A smooth-easy / B canonical MGH / C active-set / D ill-conditioned / E convergence-honesty / F refusals / G speed-stress (n ≤ 100). Output is *agent-honest*: `success` is a field; `status` mirrors scipy's L-BFGS-B taxonomy (0 grad-converged, 1 f-converged, 2 max-iter, 3 max-fun, 4 line-search-fail). Budget exhaustion is `success: false` on the happy path, NOT a boundary tag. `lower[i] > upper[i]` → `infeasible-bounds`; `x0` strictly outside bounds → `x0-outside-bounds` (no silent project-into-feasible); `f`/`grad` returning NaN/Inf → `non-finite-during-eval`. `n > 200` cap. Closed expression vocabulary identical to `integrate-1d`'s. |

Per-tool detail in `tools/<name>/README.md`.

---

## Provenance

Every successful tool run writes a record indexed by output hash:

```
$CAS_STORE/provenance/<hh>/<output_hash>.json
```

where `<hh>` = first two hex chars of the output hash. Default store: `$HOME/.scientist-workbench/cas-store`. Override with `CAS_STORE=<path>`.

The record shape (PRD §3.2):

```json
{
  "tool":        {"name": "...", "version": "..."},
  "inputs":      [{"name": "stdin", "hash": "..."}],
  "flags":       {"key": "value", ...},
  "output_hash": "..."
}
```

Look up a derivation through any tool's `--provenance-of`:

```sh
bun tools/cas-verify/tool.ts --provenance-of <output-hash>
```

Re-execute by piping the same input bytes back through the same tool version. Determinism is contractually required ⟹ same output bytes ⟹ same output hash ⟹ same provenance record.

---

## Discoverability

Plan a composition by *type*, not by name (PRD §6.3):

```sh
# what consumes a string?
echo '{"kind":"record","fields":{"input_kind":{"kind":"string","value":"string"}}}' \
  | bun tools/registry-search/tool.ts

# what produces a record?
echo '{"kind":"record","fields":{"output_kind":{"kind":"string","value":"record"}}}' \
  | bun tools/registry-search/tool.ts
```

Filters: `input_kind`, `output_kind`, `head` (matches the top-level head of `schema.output`), `name_substring`. All AND-conjoined. The current schema is a representative example value, so kind-filtering matches both the top level and any sub-value of the schema.

---

## The schema language

Tools declare their input/output **shapes**, not example values. The schema language (ADR-0004) is structural recursion over a small set of constructors:

```ts
import { S } from "@workbench/protocol";

const inputSchema = S.record({
  base: S.kind("integer"),
  exponent: S.kind("integer"),
  modulus: S.kind("integer"),
});

const outputSchema = S.kind("integer");
```

Available constructors: `S.any()`, `S.kind(k)`, `S.literal(v)`, `S.list(e)`, `S.tuple([...])`, `S.record({...}, {optional?})`, `S.expression(head?, args?)`, `S.tagged(tag?, payload)`, `S.union([...])`. Records are closed by default — extras throw. Optional fields are declared in the second argument.

Two consequences any tool author should expect:

- The runner validates input against `schema.input` *before* `fn` runs, and output against `schema.output` after. A tool author no longer hand-rolls `expectIntegerField` or `parseFooInput` shims; the runner narrows the input to the schema's TypeScript type and the body trusts it. Output non-conformance is an internal contract violation and fails loudly.
- Examples must conform to the declared schema. The runner checks this at tool-load time, so drift between the schema and the canonical examples surfaces immediately.

Schemas are pure data and round-trip through the value protocol: `--schema` emits canonical bytes a registry consumer can decode (`decodeSchema`) without spawning the tool. Top-level kind queries, deep-mention queries, and expression-head queries are first-class via `schemaTopKind`, `schemaMentionsKind`, and `schemaExpressionHead`.

Three deliberate omissions: no recursive schemas, no predicate refinements, no open records. ADR-0004 is the canonical reference for the design and the rationale.

## The contract

A tool is admitted to the registry iff it ships **all seven** artefacts (PRD §4.2):

1. The compiled tool. *MVP runs source via `bun tools/<name>/tool.ts`; `bun build --compile` deferred.*
2. `schema` declaration — a `Schema` describing input and output (ADR-0004). The legacy `kindOf("...")` annotation (ADR-0002) is the wire form for `S.kind`, preserved for transport.
3. `examples` — soft floor: **one example per code-path branch + edge cases**, ≥10 once the tool is "done." The literal count is a target, not a quota; if the tool's natural example surface is small, structure-driven coverage wins. ≥30 to call a tool "v1-complete." Every example's `input` and `output` must conform to the declared schema; the runner checks this at load time.
4. `invariants`.
5. Property tests in workspace `bun test`, OR a `--test` hook (PRD §4.3).
6. `goldens/` directory of `*.golden.json` files.
7. `README.md`.

Required fields of `ToolDefinition` (artefacts 2–4) are checked at the type level — `defineTool({...})` infers `I` and `O` from the schema and threads them into `fn`'s signature. Artefacts 5–7 are checked by `bun run check`. A tool missing any of these is a prototype, not a tool.

---

## Writing a new tool

```sh
bun run new-tool <name> [--uses pkg1,pkg2,...]
                                  # scaffolds tools/<name>/ and runs `bun install`.
                                  # --uses adds workspace packages (under packages/<pkg>) as deps.
# edit tool.ts          (literate template — expand the prose, fill schema/fn/examples/invariants)
# edit goldens.spec.ts  (add GoldenSpec entries — target ≥30, soft floor 'every code-path branch')
bun run goldens                    # generate canonical *.golden.json files
bun run check                      # typecheck + workspace tests + per-tool --test + oracle on goldens
```

Examples:

```sh
bun run new-tool cas-reduce  --uses cas-core
bun run new-tool ntt         --uses mod-core
bun run new-tool geom-orient --uses geom-predicates,float-utils   # multiple substrate packages
```

The `tool.ts` skeleton calls `defineTool({...})` from `@workbench/contract` and then runs it via `runTool(def)`. The dispatcher call is gated on `import.meta.main` (ADR-0010) so importing the module yields the live `def` without spawning a subprocess or consuming stdin. The trailing line of every tool reads:

```ts
export const def = defineTool({...});
if (import.meta.main) void runTool(def);
```

The runner handles every standard flag, parses stdin, validates against the schema, runs your `fn`, validates the output, emits canonical bytes, and writes provenance. `runTool(def, io?)` accepts an optional `RunIO` that overrides any subset of `argv`/`stdin`/`stdout`/`stderr`/`exit`/`env`, so the dispatcher is exercisable from `bun test` without a child process. Treat the file as **literate** (per `CLAUDE.md`): the comments at the top are a chapter introducing the tool's intent, with prose explaining the algorithm, references, invariants, and out-of-scope decisions. The implementation file *is* its own primary documentation.

---

## Hard requirements for any new tool

- **Determinism.** Same input bytes + same tool version ⟹ bit-identical output bytes. No `Date.now`, no `Math.random` without seed input, no iteration over unsorted hash sets, no locale or environment dependence. Property tested in workspace tests. Tools that genuinely need randomness (sampling, hardware execution) admit it as a typed `entropy` field in the input record and remain deterministic *given* those bytes; the one privileged exception is `entropy-source`, which carries the manifest annotation `nondeterministic: true` (ADR-0005). Tools annotated `numerical: true` (ADR-0015) are bit-identical *given the platform fingerprint* `{arch, os, runtime}`; cross-platform divergence is recorded in the provenance record's optional `platform` field and surfaces as a `runMemoized` cache miss when the platforms differ. The three annotations (default = symbolic, `numerical: true`, `nondeterministic: true`) are mutually exclusive in practice. See `docs/adr/0005-externalised-entropy.md` and `docs/adr/0015-determinism-tier.md`.
- **Idempotence (where the operation allows).** `f(f(v)) = f(v)`. Tested per tool.
- **Foreign-pass-through.** Subtrees outside your declared scope must round-trip verbatim (or be wrapped in a `tagged` value with your tool's name in the tag). Property tested.
- **Honest scope.** A tool that fails on inputs outside its declared scope is correct. A tool that lies (silently produces a wrong-shaped or wrong-valued answer) is not — and is inadmissible.
- **Errors that teach.** Use `ToolError` from `@workbench/protocol` with `suggestion` and `detail` fields. Errors carry a path through the value tree where possible.
- **Cold start < 100 ms.** The MVP measures ~50 ms on Bun including stdin and canonicalisation. If your tool is slower, justify why.
- **Few flags, all orthogonal.** One to five flags. Flags that change the *type* of the output should be different tools.

PRD §6.1 ("Properties of a tool an agent will reach for") is not a soft preferences list — it is a hard requirement list. A tool that fails any of these is broken even if it computes the right answer.

---

## Verification

```sh
bun run check         # full: typecheck + bun test + every tool --test + oracle on every goldens/
bun run check:quick   # fast: typecheck + bun test only (~3s; for the inner edit loop)
bun run goldens       # regenerate goldens (replaces existing files)
bun run goldens:check # fail if any current tool output disagrees with a stored golden
```

Failing CI is failing contract.

---

## File layout

```
PRD-v0.2.md              design spec — canonical for design questions
README.md                this file — operational reference for agents
LICENSE                  AGPL-3.0-or-later

packages/
  protocol/              value protocol; canonical encoder, parser, hash, validator, Schema
  contract/              runTool dispatcher, provenance store, registry helpers, GoldenSpec
  cas-core/              multivariate Q[x_1,…,x_n] / Q(x_1,…,x_n) arithmetic
  mod-core/              modular arithmetic (modPow, modInv) and Number-Theoretic Transform
  json-bridge/           translate between raw JSON and canonical Value, schema-hint-driven
  sturm-ir/              Sturm channel IR (ADR-0006): typed Channel/Op forms, schema, well-formedness, traversal
  sturm/                 TS-native frontend DSL (ADR-0009): trace, qbool, qreg, when, not, ry/rz, observe, Channel<I,O>, execute
  sturm-lib/             Patterns library on top of @workbench/sturm: H, X, Z, S, T, cx, cz, mcz, phaseFlip, diffuse, find, equalTo, oracleFn
  linalg-core/           First numerical-tier package (ADR-0014): dense Float64Array Matrix, LU + partial pivoting, solve with iterative refinement, Hager 1-norm condition estimator. Pure TS, single platform, no FFI.
  quadrature/            Adaptive 1D Gauss-Kronrod quadrature (G7K15) + a closed-vocabulary numeric expression evaluator. Substrate for tools/integrate-1d. Constants verbatim from GSL's qk15.c; algorithm framework from QUADPACK (Piessens et al. 1983).
  lbfgs-projected/       Limited-memory BFGS with simple bound constraints (L-BFGS with active-set projection). Substrate for tools/optimize-lbfgs-projected. Two-loop recursion (Nocedal 1980) for the inverse-Hessian product, More-Thuente-style strong-Wolfe line search, Powell's curvature safeguard. Algorithm structure follows Byrd-Lu-Nocedal-Zhu 1995 / Morales-Nocedal 2011 v3.0; cross-validated against SciPy 1.14.1 (Northwestern Fortran v3.0 backend).
  compose/               In-process composition layer (ADR-0012): `loadWorkbench()` returns a live registry of every tool's `def`; `wb.run(name, input, flags)` invokes a tool in the orchestrator process under the same schema-validation + provenance contract as the subprocess surface. The TS-expert call site for the workbench.

tools/
  <name>/
    tool.ts              entry point — calls runTool({...})
    package.json         workspace manifest
    README.md            one-page tool reference
    goldens.spec.ts      `export const goldens: GoldenSpec[]`
    goldens/             generated *.golden.json (do not edit by hand)

scripts/
  new-tool.ts            scaffold a new tool directory
  generate-goldens.ts    regenerate goldens from goldens.spec.ts files
  check.ts               combined health check (run via `bun run check`)
  demo-scope.sh          ten worked examples covering the full v1 scope
  setup-device.sh        one-shot per-device setup: tracked git hooks +
                         non-destructive beads bootstrap from .beads/issues.jsonl

.githooks/               tracked git hooks (auto-export beads on commit,
                         auto-import on pull). Activated per-clone via
                         `git config core.hooksPath .githooks` — done
                         automatically by scripts/setup-device.sh.
```

**Fresh clone setup:** run `sh scripts/setup-device.sh` once after
`git clone`. Idempotent. See CLAUDE.md Rule 9 for the multi-device
beads discipline.

---

## What this is *not*

- Not a BLAS-scale numerics library — see PRD §1.2 (no PDE-class solvers, no GPU, no distributed). The bounded numerical tier (ADR-0014, currently `linalg-solve` at `n ≤ 200`) lives alongside the symbolic core; it is small, honest about its scope, and capped where the wire encoding starts hurting.
- Not Mathematica replication — the legacy stack's failure mode (composition through global mutable state) is exactly what is being moved away from.
- Not (yet) a notebook surface — Phase 4 of the roadmap.
- Not (yet) proof-carrying — Phase 5; the v1 ecosystem is the *substrate* that makes proof-carrying outputs possible.

The discipline that does not bend is the contract. Everything else iterates freely — duplication of tools is exploration, not waste.

---

## Pointers

- **Design questions:** `PRD-v0.2.md`. Sections marked `[SETTLED]` are not up for debate without strong reason.
- **Per-tool detail:** `tools/<name>/README.md`.
- **Worked examples covering the v1 scope:** `bun scripts/demo-scope.ts` (in-process, typed; ~0.6s for the full 14-demo suite). The shell version `bash scripts/demo-scope.sh` runs the same demos through subprocess pipes and is preserved as a sanity-check / fallback (~4.5s).
- **The substrate decision (TS/Bun) is settled.** Re-read PRD §1.3 before relitigating; four pillars all need to change before the question reopens.
