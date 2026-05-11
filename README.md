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

Two ways to find a tool: scan the catalog below by name, or query by type via [`registry-search`](#discoverability) for the planner-friendly path. Per-tool detail (input/output schemas, algorithm, refusal envelope, validation) lives in `tools/<name>/README.md` — the rows below link out.

| tool | input | output | summary |
|---|---|---|---|
| `alg-num-arith` | `record{a: Root expr, b?: Root expr}` + `--op` ∈ `{add,sub,mul,div,neg,inv,eq}` | `expression{Root}` \| `boolean` \| `tagged "alg-num-arith/{inv-of-zero,div-by-zero}"` | Symbolic field arithmetic over named algebraic numbers (`Root[poly, k]`, ADR-0018) via Sylvester-Bareiss resultants; bit-identical cross-platform forever. See [`tools/alg-num-arith/`](tools/alg-num-arith/README.md). |
| `cas-diff` | `record{f: expression, var: symbol}` | `expression` \| `tagged "cas-diff/out-of-scope"` | Symbolic differentiation over the closed elementary + special-function vocabulary (ADR-0023); DLMF-cited chain-rule rules for Gamma, Bessel, Erf, Polylog and more. See [`tools/cas-diff/`](tools/cas-diff/README.md). |
| `cas-simplify` | any `Value` | canonical `Value` | Symbolic canonicalisation over `Q[x₁,…,xₙ]` / `Q(x₁,…,xₙ)`; rational functions reduced by polynomial GCD; foreign subtrees wrapped in `tagged "cas-simplify/out-of-scope"`. See [`tools/cas-simplify/`](tools/cas-simplify/README.md). |
| `cas-verify` | `record{lhs, rhs}` | `record{equal, reason?, witness?, side?, detail?}` | Decide A = B over `Q(x)` by cross-multiplication; emits `lhs − rhs` as a witness on inequality. See [`tools/cas-verify/`](tools/cas-verify/README.md). |
| `entropy-source` | `record{n_bytes}` | `record{bytes, source_kind}` | The workbench's only nondeterministic tool (`nondeterministic: true`; ADR-0005); auditable OS-randomness bridge via Web Crypto. See [`tools/entropy-source/`](tools/entropy-source/README.md). |
| `expr-parse` | `string` | `expression` (or leaf integer / rational / symbol) | Text → AST; operators `+ − * / ^`, identifiers, integer / rational / decimal literals. See [`tools/expr-parse/`](tools/expr-parse/README.md). |
| `groebner-basis` | `record{polys: list<expression>, vars: list<symbol>, order: string}` | `record{basis, order, vars, n_pairs, warnings}` \| `tagged "groebner-basis/{empty-input,empty-vars,parametric,non-polynomial}"` | Multivariate Gröbner basis over ℚ for `lex` and `degrevlex` orders; Buchberger 1965 + sloppy sugar (Giovini-Mora-Niesi-Robbiano-Traverso 1991) + Gebauer-Möller pruning + full inter-reduction to the unique reduced GB. Substrate for `tools/solve`'s multivariate-poly lane (ADR-0029). Symbolic tier: bit-identical cross-platform forever. See [`tools/groebner-basis/`](tools/groebner-basis/README.md). |
| `hypergeometric-pfq` | `record{a, b: list<bigcomplex>, z: bigcomplex}` | `record{value, achieved_precision, method, n_terms, working_precision, warnings}` \| `tagged "hypergeometric-pfq/{non-convergent,parameter-pole}"` | Arbitrary-precision `pFq(a; b; z)` via direct power series with cancellation-driven precision retry; `arbprec: true` — bit-identical cross-platform forever given `--precision=N`. See [`tools/hypergeometric-pfq/`](tools/hypergeometric-pfq/README.md). |
| `integrate-1d` | `record{f: expression, var: symbol, a: float64, b: float64}` | `record{value, error_estimate, n_evals, converged, iterations, method, warnings}` \| `tagged "integrate-1d/{non-finite-during-eval,degenerate-interval}"` | Adaptive Gauss-Kronrod G7K15 quadrature (QUADPACK-style) for the closed elementary vocabulary; agent-honest `converged` field. See [`tools/integrate-1d/`](tools/integrate-1d/README.md). |
| `integrate-ode-ivp` | `record{f: list<expression>, vars, t_var, y0, t_span, options?}` | `record{trajectory, t_values, error_estimate, n_evals, n_steps_accepted, n_steps_rejected, converged, status, method, warnings}` \| `tagged "integrate-ode-ivp/{degenerate-tspan,non-finite-during-eval}"` | Dormand-Prince 5(4) adaptive non-stiff IVP solver (SciPy `RK45` algorithm); agent-honest residual + step counts. See [`tools/integrate-ode-ivp/`](tools/integrate-ode-ivp/README.md). |
| `integrate-ode-stiff` | `record{f: list<expression>, vars, t_var, y0, t_span, options?}` | `record{trajectory, t_values, error_estimate, n_evals, n_steps_accepted, n_steps_rejected, n_jacobian_evals, n_lu_decompositions, converged, status, method, warnings}` \| `tagged "integrate-ode-stiff/{degenerate-tspan,non-finite-during-eval,jacobian-singular,method-not-implemented}"` | Radau-IIA(5) adaptive stiff IVP solver with symbolic Jacobian auto-derivation (SciPy `Radau` algorithm); L-stable, agent-honest bookkeeping. See [`tools/integrate-ode-stiff/`](tools/integrate-ode-stiff/README.md). |
| `integrate-ode-symplectic` | `record{H: expression, q_vars, p_vars, t_var, q0, p0, t_span, n_steps, options?}` | `record{q_trajectory, p_trajectory, t_values, energy, energy_drift_max, energy_drift_secular, n_evals, n_steps, converged, status, method, warnings}` \| `tagged "integrate-ode-symplectic/{degenerate-tspan,non-separable-hamiltonian,non-finite-during-eval}"` | Velocity Verlet / Yoshida-4 symplectic integrator for separable Hamiltonians; energy drift bounded `O(hᵖ)` regardless of horizon. See [`tools/integrate-ode-symplectic/`](tools/integrate-ode-symplectic/README.md). |
| `linalg-eigh` | `record{A: list<list<float64>>}` | `record{Q, eigenvalues, reconstruction_error, orthogonality_error, condition_number, method, warnings}` \| `tagged "linalg-eigh/{non-symmetric-input,non-finite-input,degenerate-shape}"` | Cyclic Jacobi symmetric eigensolver for real symmetric `n × n` A; agent-honest reconstruction + orthogonality errors. See [`tools/linalg-eigh/`](tools/linalg-eigh/README.md). |
| `linalg-qr` | `record{A: list<list<float64>>, mode?}` | `record{Q, R, mode, diagonal_R, reconstruction_error, orthogonality_error, method, warnings}` \| `tagged "linalg-qr/{non-finite-input,degenerate-shape}"` | Householder QR for real `m × n`; `O(ε)` orthogonality independent of `κ(A)`; agent-honest error scalars. See [`tools/linalg-qr/`](tools/linalg-qr/README.md). |
| `linalg-solve` | `record{A: list<list<float64>>, b: list<float64>}` | `record{x, residual_norm, b_norm, condition_estimate, growth_factor, method, iterations, warnings}` \| `tagged "linalg-solve/singular"` | LU with partial pivoting + iterative refinement for `Ax = b`; agent-honest residual / condition / growth-factor / warnings. See [`tools/linalg-solve/`](tools/linalg-solve/README.md). |
| `linalg-svd` | `record{A: list<list<float64>>, mode?}` | `record{U, S, Vt, mode, reconstruction_error, orthogonality_error_U, orthogonality_error_Vt, condition_number, rank_estimate, method, warnings}` \| `tagged "linalg-svd/{non-finite-input,degenerate-shape}"` | Dual-algorithm SVD (one-sided Jacobi ≤ n=500; Golub-Reinsch above); `condition_number` and `rank_estimate` are first-class fields. See [`tools/linalg-svd/`](tools/linalg-svd/README.md). |
| `lp-solve` | `record{minimize:{c}, subjectTo:{Ax_eq_b?, cones}, precision?, max_iter?}` per ADR-0030 §C | `record{status, x, dual, slack, objective?, achieved_precision?, iterations, method, condition_estimate, warnings}` \| `tagged "lp-solve/{non-finite-input,degenerate-shape,non-lp-cone,malformed-cone,quadratic-objective,coefficient-explosion}"` | LP specialist of the cone-solver tier (ADR-0030 §B). v0.1: exact-rational revised two-phase simplex (Dantzig 1947 + Bland 1977) wrapped in float64 wire (ADR-0031). The only LP solver in any ecosystem that returns `achieved_precision ≈ ε_machine` on small-dense inputs — interior arithmetic is `Rat` over BigInt; the only rounding is the wire encode/decode. Scope: n ≤ ~30 small dense; portfolio fast lane (lp-solve-fast, bead hnyu) and IPM lane (lp-solve-ipm, bead prfp) deferred. See [`tools/lp-solve/`](tools/lp-solve/README.md). |
| `meijer-g` | `record{an, ap, bm, bq: list<bigcomplex>, z: bigcomplex, request_mode?}` | `record{kind: "symbolic", expr, …}` \| `record{kind: "numerical", value, achieved_precision, …}` \| `tagged "meijer-g/{out-of-region,non-finite-input,degenerate-shape,symbolic-required-no-match,forced-method-refused,input-error}"` | Top-level Meijer G dispatcher; cost-ascending dispatch (symbolic → Slater → contour → asymptotic) with honest refusal; `arbprec: true`. See [`tools/meijer-g/`](tools/meijer-g/README.md). |
| `meijer-g-asymptotic-only` | `record{an, ap, bm, bq: list<bigcomplex>, z: bigcomplex}` | `record{value, achieved_precision, method, n_terms, optimal_term_indices, error_estimate, sector, working_precision, warnings}` \| `tagged "meijer-g-asymptotic-only/{stokes-line,secondary-sector,small-z,non-asymptotic-regime,no-pole-residues,input-error}"` | Braaksma far-field asymptotic for Meijer G in the principal sector; superasymptotic truncation at optimal term; `arbprec: true`. See [`tools/meijer-g-asymptotic-only/`](tools/meijer-g-asymptotic-only/README.md). |
| `meijer-g-symbolic-only` | `record{an, ap, bm, bq: list<Value>, z: Value}` | `record{expr, rule, source, note}` \| `tagged "meijer-g-symbolic-only/no-known-reduction"` | Adamchik–Marichev + Roach pattern-table dispatcher for Meijer G closed-form reductions (Bateman + DLMF §16.17–18); ≥30 verified rules. See [`tools/meijer-g-symbolic-only/`](tools/meijer-g-symbolic-only/README.md). |
| `mod-inv` | `record{value, modulus}` | `record{invertible, inverse?, gcd}` | Modular inverse via extended Euclid; `inverse` present iff invertible, `gcd` always present. See [`tools/mod-inv/`](tools/mod-inv/README.md). |
| `mod-pow` | `record{base, exponent, modulus}` | `integer` | Modular exponentiation over `Z/mZ` via square-and-multiply; canonical residue in `[0, m)`. See [`tools/mod-pow/`](tools/mod-pow/README.md). |
| `ntt` | `record{n, modulus, primitive_root, direction, x}` | `list<integer>` | Number-Theoretic Transform over `F_p`; Cooley-Tukey (power-of-two) or Bluestein chirp-z (arbitrary `n | p−1`). See [`tools/ntt/`](tools/ntt/README.md). |
| `optimize-lbfgs-projected` | `record{f: expression, grad: list<expression>, vars, x0, bounds, options?}` | `record{x, fun, jac, grad_inf_norm, iterations, nfev, status, status_message, success, bfgs_skip_count, line_search_fail_count, active_bounds_count, method, warnings}` \| `tagged "optimize-lbfgs-projected/{infeasible-bounds,x0-outside-bounds,non-finite-during-eval}"` | L-BFGS with active-set projection and More-Thuente line search for box-constrained minimisation; agent-honest `success` + convergence taxonomy. See [`tools/optimize-lbfgs-projected/`](tools/optimize-lbfgs-projected/README.md). |
| `oracle` | `record{tool_path, goldens_dir, mode?}` | `record{passed, failed, total, mode, results}` | Golden-master harness; modes `exact` (default) and `structural`; exits 1 on any failure. See [`tools/oracle/`](tools/oracle/README.md). |
| `poly-factor` | `record{f: expression, var: symbol}` | `record{content, factors: list<record{factor, multiplicity}>, method, warnings}` \| `tagged "poly-factor/non-polynomial"` | Exact univariate factorisation over ℚ via Berlekamp-Zassenhaus; output canonical (irreducible, primitive, positive-leading, sorted). See [`tools/poly-factor/`](tools/poly-factor/README.md). |
| `poly-roots` | `record{f: expression, var: symbol}` | `record{roots: list<record{root, multiplicity}>, method, warnings}` \| `tagged "poly-roots/{complex-roots-not-yet-named,non-polynomial,multivariate}"` | Symbolic roots of univariate polynomials over ℚ; closed-form radicals for deg ≤ 4, `Root[poly, k]` for real roots of deg ≥ 5. See [`tools/poly-roots/`](tools/poly-roots/README.md). |
| `real-root-isolate` | `record{f: expression, var: symbol}` | `record{intervals: list<record{lo, hi}>, method, warnings}` \| `tagged "real-root-isolate/{not-squarefree,non-polynomial,multivariate}"` | Rational isolating intervals for real roots via VAS continued fractions + LMQ bound; open `(lo,hi)` or singleton `(r,r)` per root. See [`tools/real-root-isolate/`](tools/real-root-isolate/README.md). |
| `registry-list` | `record{tools_root?}` | `list` of metadata records | Discover all installed tools; schemas in output are wire-encoded. See [`tools/registry-list/`](tools/registry-list/README.md). |
| `registry-search` | `record{tools_root?, input_kind?, output_kind?, head?, name_substring?}` | `list` of metadata records | Filter the registry by schema-derived predicates (AND-conjoined); the planner-friendly discovery path. See [`tools/registry-search/`](tools/registry-search/README.md). |
| `sdp-solve` | `record{minimize:{c}, subjectTo:{Ax_eq_b?, cones}, precision?, max_iter?}` per ADR-0030 §C with `PSDCone[size, indices]` | `record{status, x, dual, slack, objective?, achieved_precision?, iterations, method, condition_estimate, warnings}` \| `tagged "sdp-solve/{non-finite-input,degenerate-shape,quadratic-objective,non-sdp-cone,malformed-cone,cone-coverage}"` | SDP specialist of the cone-solver tier (ADR-0030 §B). Wraps `@workbench/solver-ipm`'s primal-dual interior-point method with three search-direction lanes — Nesterov-Todd default (Todd-Toh-Tütüncü 1998), AHO for A/B (Alizadeh-Haeberly-Overton 1997), HKM debug-only. Wire uses **strict-Mosek-format with √2 off-diagonal scaling** so `<C, X>_F = svec(C)ᵀ svec(X)` exactly. v0.1 cone vocabulary: PSDCone (+ ZeroCone); NonNegCone-as-diagonal-PSD deferred to v0.2 (bead `67nj`). Bench grade: 3/6 sdp-sdplib (corpus); the 3 failing cases hit `@workbench/solver-ipm`'s SDP convergence gap (bead `qmrv`, the SDP analog of LP NETLIB-`brandy`). See [`tools/sdp-solve/`](tools/sdp-solve/README.md). |
| `solve` | `record{eqs: list<expression>, vars: list<symbol>}` | `record{vars, solutions: list<record{bindings, branches}>, completeness, warnings}` \| `tagged "solve/{complex-roots-not-yet-named,multivariate-non-zero-dim,shape-lemma-failure,parametric-non-trivial,foreign-vocabulary,transcendental-multibranch,constant-equation,empty-input,empty-vars}"` | Top-level `Solve[]`-class dispatcher; routes across linear (Bareiss), univariate-poly (radicals + Root[]), multivariate-zero-dim (Buchberger + FGLM + shape lemma per ADR-0029), and single-head transcendental lanes; branch-honest by design. See [`tools/solve/`](tools/solve/README.md). |
| `sturm-controlled` | `record{control_wire, channel}` | Sturm channel IR \| `tagged "sturm-controlled/out-of-scope"` | Sturm channel combinator: prepends a control wire to every `ry`/`rz` in the body; refuses on `prepare`/`observe`/`oracle`/`discard` or wire-id collision. See [`tools/sturm-controlled/`](tools/sturm-controlled/README.md). |
| `sturm-equivalent` | `record{lhs, rhs}` of two channels | `record{equal, reason?, witness?, detail?}` | Decide whether two Sturm channels denote the same arrow via canonical-form comparison + distribution comparison; sound on equal and on witness-backed inequality. See [`tools/sturm-equivalent/`](tools/sturm-equivalent/README.md). |
| `sturm-execute` | Sturm channel IR | `record{classical_refs, outcomes, precision}` | Pure-analytic state-vector simulation of a Sturm circuit; `tagged "sturm-execute/out-of-scope"` for oracle / discard / qubit-cap > 12 / free-symbolic angles. See [`tools/sturm-execute/`](tools/sturm-execute/README.md). |
| `sturm-find` | `record{n_bits, marked, shots?, entropy?}` | `record{distribution, samples?, iterations}` | Grover's algorithm via `sturm-execute` + optional `sturm-sample`; v0.1 caps at `n_bits ≤ 3`. See [`tools/sturm-find/`](tools/sturm-find/README.md). |
| `sturm-sample` | `record{distribution, entropy, shots}` | `record{samples, entropy_consumed}` | Born's rule sampling: walks the Born CDF using 8 bytes per shot; strictly deterministic given entropy. See [`tools/sturm-sample/`](tools/sturm-sample/README.md). |
| `sturm-simplify` | Sturm channel IR | Sturm channel IR | Idempotent Sturm channel IR canonicaliser; eliminates trivial rotations, fuses same-axis adjacencies, sorts/dedupes controls. See [`tools/sturm-simplify/`](tools/sturm-simplify/README.md). |
| `sturm-tensor` | `record{left, right}` of two channels | Sturm channel IR | Sturm channel combinator: parallel composition (monoidal product); wire-id–renamed right concatenated onto left verbatim. See [`tools/sturm-tensor/`](tools/sturm-tensor/README.md). |
| `sturm-then` | `record{first, second}` of two channels | Sturm channel IR \| `tagged "sturm-then/signature-mismatch"` | Sturm channel combinator: sequential composition `f; g`; positional wire renaming at the boundary; length/kind/dim mismatch → boundary tag. See [`tools/sturm-then/`](tools/sturm-then/README.md). |

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

- **Determinism.** Same input bytes + same tool version ⟹ bit-identical output bytes. No `Date.now`, no `Math.random` without seed input, no iteration over unsorted hash sets, no locale or environment dependence. Property tested in workspace tests. Tools that genuinely need randomness (sampling, hardware execution) admit it as a typed `entropy` field in the input record and remain deterministic *given* those bytes; the one privileged exception is `entropy-source`, which carries the manifest annotation `nondeterministic: true` (ADR-0005). Tools annotated `arbprec: true` (ADR-0020) are bit-identical *cross-platform, forever* given an explicit `--precision=<int>` flag — `BigInt` arithmetic is bit-identical across runtimes by language specification. Tools annotated `numerical: true` (ADR-0015) are bit-identical *given the platform fingerprint* `{arch, os, runtime}`; cross-platform divergence is recorded in the provenance record's optional `platform` field and surfaces as a `runMemoized` cache miss when the platforms differ. The four annotations (default = symbolic, `arbprec: true`, `numerical: true`, `nondeterministic: true`) are mutually exclusive in practice. See `docs/adr/0005-externalised-entropy.md`, `docs/adr/0015-determinism-tier.md`, and `docs/adr/0020-arbitrary-precision-tier.md`.
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

`bun run check` covers substrate tests and tool-side goldens only. Full bench
grading (the corpus of 182 MB golden inputs across 14 tools) lives in the
`scientist-workbench-corpus` sister repo; see ADR-0028 for the migration plan
and `scripts/bench-grade.sh <tool>` for the convenience shim.

---

## File layout

```
PRD-v0.2.md              design spec — canonical for design questions
README.md                this file — operational reference for agents
LICENSE                  AGPL-3.0-or-later

packages/
  protocol/              value protocol; canonical encoder, parser, hash, validator, Schema
  contract/              runTool dispatcher, provenance store, registry helpers, GoldenSpec
  cas-core/              multivariate Q[x_1,…,x_n] / Q(x_1,…,x_n) arithmetic; symbolic differentiator (closed elementary vocabulary + ADR-0023 special-function vocabulary: Gamma family, Bessel J/Y/I/K, HypergeometricPFQ, MeijerG, Whittaker, ParabolicCylinderD, Erf/Erfc, ExpIntegralEi/E, Fresnel, Legendre, classical orthogonal polynomials, Polylog, LerchPhi); ring-generic Poly<T> / RatFn<T> over Field<T> dictionaries; `Root[poly, k]` algebraic-number primitive (re-exported from @workbench/alg-num)
  mod-core/              modular arithmetic (modPow, modInv) and Number-Theoretic Transform
  json-bridge/           translate between raw JSON and canonical Value, schema-hint-driven
  sturm-ir/              Sturm channel IR (ADR-0006): typed Channel/Op forms, schema, well-formedness, traversal
  sturm/                 TS-native frontend DSL (ADR-0009): trace, qbool, qreg, when, not, ry/rz, observe, Channel<I,O>, execute
  sturm-lib/             Patterns library on top of @workbench/sturm: H, X, Z, S, T, cx, cz, mcz, phaseFlip, diffuse, find, equalTo, oracleFn
  linalg-core/           First numerical-tier package (ADR-0014): dense Float64Array Matrix, LU + partial pivoting, solve with iterative refinement, Hager 1-norm condition estimator. Pure TS, single platform, no FFI.
  quadrature/            Adaptive 1D Gauss-Kronrod quadrature (G7K15) + a closed-vocabulary numeric expression evaluator. Substrate for tools/integrate-1d. Constants verbatim from GSL's qk15.c; algorithm framework from QUADPACK (Piessens et al. 1983).
  lbfgs-projected/       Limited-memory BFGS with simple bound constraints (L-BFGS with active-set projection). Substrate for tools/optimize-lbfgs-projected. Two-loop recursion (Nocedal 1980) for the inverse-Hessian product, More-Thuente-style strong-Wolfe line search, Powell's curvature safeguard. Algorithm structure follows Byrd-Lu-Nocedal-Zhu 1995 / Morales-Nocedal 2011 v3.0; cross-validated against SciPy 1.14.1 (Northwestern Fortran v3.0 backend).
  poly-factor/           Exact univariate polynomial factorisation over ℚ. Substrate for tools/poly-factor and prerequisite for the rest of solve-suite-v1's univariate path. Yun 1976 square-free decomposition (squareFree); Berlekamp 1967 over 𝔽_p (berlekampFactor); Zassenhaus 1969 quadratic Hensel lift (henselLiftPair, henselLiftMany); Mignotte 1974 coefficient bound + Berlekamp-Zassenhaus subset-sum recombination (mignotteBound, mignotteHenselExponent, recombineFactors). Top-level orchestration via factorPrimitiveSquareFreeZ / factorIntZ / factorRatQ. Pure ℤ/ℚ arithmetic over BigInt — no float, no FFI; bit-identical cross-platform forever. Substrate for cas-core's `Field<bigint>` instances (INT_RING, fpField) and the polyExtGcd / polyDivRemMonic primitives needed by the lift step.
  real-roots/            Real-root isolation over ℚ[x]. Substrate for tools/real-root-isolate and the algebraic-number / Root[] chain (xyt → xkz → 6cd → rti → 5i2 → yoc). Vincent-Akritas-Strzebonski continued-fraction method with the LMQ (Local-Max Quadratic) positive-root bound (Akritas-Strzebonski-Vigklas 2008); `O(n · log B)` amortised rational ops where B is the bit-length of the largest coefficient. TS port of SymPy's BSD `dup_isolate_real_roots_sqf` (`sympy/polys/rootisolation.py`); high-to-low coefficient arrays match the SymPy convention to keep the port line-by-line verifiable. Output is the open + singleton dual shape: open `(lo, hi)` for irrational roots, singleton `(r, r)` for rational roots. Pure ℤ/ℚ arithmetic over BigInt; no float; bit-identical cross-platform forever.
  alg-num/               Algebraic-number substrate. Ships the `Root[poly, k]` primitive (ADR-0018) and the four-field arithmetic closure on it. Two construction primitives produce canonical Roots (irreducible minpoly, primitive, positive-leading, ℤ[x] coefficients): (1) `makeRoot(poly, intervalHint, v)` names the unique root inside a supplied real isolating interval (sign-criterion-disambiguated across irreducible factors); (2) `makeRootByIndex(poly, k, v)` names "the global k-th real root of poly in ascending order" (factors over ℚ, sorts roots cross-factor by interval bisection, re-indexes within the chosen factor). The wire encoding is `expression { head: "Root", args: [Polynomial[c_0, …, c_n], k] }` with all coefficients integer-typed; `valueToRoot` always defers to `makeRootByIndex` so non-canonical wire input is silently canonicalised per ADR-0018. `refineRoot(r, { bits: N })` lazily contracts the runtime isolating interval below width 2^{−N} via rational bisection. `rootCanonicalEq` is sufficient for equality of Roots produced by any constructor. Arithmetic: `algNumNeg`, `algNumInv`, `algNumAdd`, `algNumSub`, `algNumMul`, `algNumDiv` — minpolys built via `Res_y(f(y), g(x − y))` / `Res_y(y^{deg f} f(x/y), g(y))` (Cohen GTM 138 §3.6.2) using a Sylvester-matrix-via-Bareiss resultant in ℚ[x], with refine-and-retry interval disambiguation. Real roots only in v0.1; complex naming and primitive-element compression for ≥ 3 algebraics (5i2) extend this surface.
  solve/                 Top-level `Solve[]`-class dispatcher substrate. Classifier (classifyInput) decides the dispatch lane (linear / univariate-poly / multivariate-poly / unsupported); dispatcher (dispatchClassified) executes via cas-core's bareissSolve, poly-factor + radicals, or `@workbench/groebner`'s solveGroebner; single-head transcendental matcher (tryTranscendentalInvert) handles `head(x) = c` patterns with branched-solution emission. Returns ADR-0017's solution-set shape (record { vars, solutions: list<{bindings, branches}>, completeness, warnings } | tagged "solve/<class>"). v0.1 covers linear, univariate-polynomial, multivariate-zero-dim (ADR-0029), and single-head-transcendental lanes; positive-dim / shape-lemma-failure / complex-roots / parametric / compound-transcendental refuse honestly via boundary tags. Branch-honest by design — no silent principal-branch slices.
  groebner/              Gröbner basis substrate over ℚ. Substrate for tools/groebner-basis (corpus bench `groebner-basis`) and tools/solve's multivariate-poly dispatch lane (ADR-0029). Buchberger 1965 with sloppy sugar pair selection (Giovini-Mora-Niesi-Robbiano-Traverso 1991), Buchberger Criterion 1 (coprime LMs) + Criterion 2 (Gebauer-Möller chain criterion in strict Becker-Weispfenning §5.5 form), full inter-reduction to the unique reduced GB. FGLM order conversion (DRL → lex, Faugère-Gianni-Lazard-Mora 1993) + shape-lemma extraction (Becker-Mora-Marinari-Traverso 1994) for zero-dimensional ideals. Pure ℤ/ℚ arithmetic over BigInt — no float, no FFI; bit-identical cross-platform forever (symbolic tier per ADR-0015). Reuses `@workbench/cas-core`'s `Poly<Rat>` substrate; introduces `MonomialOrder` (lex / drl) comparators and `polyMultiDivRem` (multivariate division per CLO Ch.2 §3 Theorem 3) without modifying cas-core. solveGroebner() composes Buchberger + zero-dim test + FGLM + shape extraction; refuses with structured `multivariate-non-zero-dim` / `shape-lemma-failure` / `complex-roots-not-yet-named` classes when honest.
  ode-core/              ODE integration substrates on Float64Array. Substrate for tools/integrate-ode-ivp (adaptive non-stiff Dormand-Prince 5(4) with FSAL bookkeeping, Gustafsson 1991 PI step-size controller, 4th-order Hermite continuous extension; HNW Vol I §II.5/§II.6 — the SciPy `solve_ivp(method='RK45')` algorithm in pure TS), tools/integrate-ode-stiff (adaptive stiff Radau-IIA(5) with simplified-Newton + complex-eigenvalue split factorisation per HW Vol II §IV.8 / Hairer-Wanner 1999 — the SciPy `solve_ivp(method='Radau')` algorithm), and tools/integrate-ode-symplectic (Velocity Verlet + Suzuki-Yoshida 4th-order composition for separable Hamiltonian flows; HLW §I.3.1, §VI.3, §VI.6 — energy drift bounded `O(h^p)` regardless of horizon). Closed-vocabulary RHS evaluation reuses `@workbench/quadrature::evalNumericExpr`.
  compose/               In-process composition layer (ADR-0012): `loadWorkbench()` returns a live registry of every tool's `def`; `wb.run(name, input, flags)` invokes a tool in the orchestrator process under the same schema-validation + provenance contract as the subprocess surface. The TS-expert call site for the workbench.
  bigfloat/              Arbitrary-precision binary floating-point (`BigInt` mantissa + `i32` exponent). The first arb-prec substrate (ADR-0020). MPFR-style per-value precision, round-half-to-even normalisation, full transcendental + special-function vocabulary (Γ, lgamma, digamma, trigamma, polygamma) on real and complex `BigComplex`. Bit-identical cross-platform forever — every operation is `BigInt`-deterministic by language spec. Underpins every `arbprec: true` tool.
  hypergeometric/        Generalised hypergeometric `pFq` evaluator. Direct power series with cancellation-driven precision retry; closed-form fast paths for 0F0/1F0; `tagged "<tool>/non-convergent"` refusal in the asymptotic and `|z|≈1` regimes. The library face of `tools/hypergeometric-pfq`.
  simplex-q/             Exact-rational LP simplex substrate (ADR-0031). Revised two-phase simplex over ℚ via BigInt-backed `Rat` from `@workbench/cas-core`. Phase 1 + Phase 2 with Dantzig pricing and a Bland-rule guard on degeneracy. Explicit `B⁻¹` storage with O(m²) product-form rank-1 update per pivot (Dantzig 1963, Vanderbei §6.4). Bit-identical cross-platform forever; the substrate `tools/lp-solve` wraps in the ADR-0030 float64 wire.
  meijer-core/           Meijer G-function algorithmic substrate (Layers 3 + 4 + 5 of `tstournament` problem-13). Slater residue-summation (Series 1 + Series 2) with `(p, q, m, n, |z|)` selection rule, deterministic odd-coefficient perturbation for parameter coalescence, cancellation-driven retry; Adamchik–Marichev + Roach **symbolic dispatch** (ADR-0025; pattern-table reducer with one-file-per-source rule organisation under `dispatch-rules/`); Mellin-Barnes contour quadrature on a vertical contour `Re(s) = c` via the BigComplex G7K15 driver (ADR-0022) with auto-selected contour location and Stirling-rate-derived truncation. Composes `@workbench/bigfloat` + `@workbench/hypergeometric` + `@workbench/quadrature` + `@workbench/cas-core`. Future layers (Braaksma asymptotic, top-level dispatcher) land alongside.

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

- Not a BLAS-scale numerics library — see PRD §1.2 (no PDE-class solvers, no GPU, no distributed). The bounded numerical tier (ADR-0014/0016: `linalg-{solve,qr,svd,eigh}`, plus `integrate-1d`, `integrate-ode-ivp`, and `optimize-lbfgs-projected`) lives alongside the symbolic core. Per ADR-0016 the previous `n ≤ 200` cap is *withdrawn* — large inputs run with measurement-driven scale warnings and OOM as the only physical refusal. Phone deployment (Bun-in-browser-on-mobile, where Python/SciPy aren't available) is the design forcing function; FFI to OpenBLAS is a future option (bead `e7y`) for production-scale workloads.
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
- **CAS trajectory:** `docs/cas-core-roadmap.md` — the working document for `packages/cas-core`; re-read before scoping any CAS work. Covers capability map, ladder (rungs 1–11), library/tool split, and architectural decisions already made.
- **Numerics + vis research:** `docs/numerics-and-vis-2026-04-29.md` — the precursor note naming the cliff (symbolic-only coverage gap, candidate moves, stress points). Cited by ADR-0014/0015 and `packages/linalg-core`.
