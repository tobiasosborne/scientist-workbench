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
| `alg-num-arith` | `record{a: <Root expression>, b?: <Root expression>}` + flag `--op` ∈ `{add, sub, mul, div, neg, inv, eq}` | `expression {head: "Root", ...}` (arithmetic) \| `boolean` (eq) \| `tagged "alg-num-arith/{inv-of-zero,div-by-zero}"` | Field arithmetic over named algebraic numbers (`Root[poly, k]`, ADR-0018). Wire envelope around `@workbench/alg-num`'s in-memory substrate (worklog 062): `algNumAdd / Sub / Mul / Div / Neg / Inv` via Sylvester-Bareiss resultants + canonicalisation; `rootCanonicalEq` for equality. Inputs are silently canonicalised on parse via `valueToRoot`. Default symbolic tier — bit-identical cross-platform forever. Substrate cross-validated against SymPy `qqbar` in the bench (bead `iay`). |
| `expr-parse` | `string` | `expression` (or leaf integer / rational / symbol) | text → AST. Operators `+ − * / ^`, identifiers, integer / rational / decimal literals. LaTeX is out of scope (sister tool). |
| `cas-simplify` | any `Value` | canonical `Value` | canonicalise over `Q[x_1,…,x_n]` / `Q(x_1,…,x_n)`. Foreign subtrees wrapped in `tagged "cas-simplify/out-of-scope"`. As of ADR-0013, rational functions are reduced by polynomial GCD: `(x²−1)/(x−1)` simplifies to `x+1`. Idempotent. |
| `cas-verify` | `record{lhs, rhs}` | `record{equal, reason?, witness?, side?, detail?}` | decide A = B over `Q(x)` by cross-multiplication (sound and complete; no GCD needed). On inequality: emits `lhs - rhs` as a witness. |
| `cas-diff` | `record{f: expression, var: symbol}` | expression \| `tagged "cas-diff/out-of-scope"` | Symbolic differentiation. Closed vocab `+ − * / ^ neg exp sin cos tan log sqrt abs asin acos atan sinh cosh tanh asinh acosh atanh log2 log10` plus `pi`, `e` — matched deliberately to `integrate-1d` / `optimize-lbfgs-projected` so the three compose without vocabulary mismatches. Smart constructors absorb chain-rule book-keeping (`0+x → x`, `1·x → x`, `x⁰→1`, etc.); pipe through `cas-simplify` for full reduction. Unknown head or non-arithmetic Value kind → top-level `tagged "cas-diff/out-of-scope"` (refuses the whole input rather than embedding tagged sub-nodes). FD-cross-check oracle. |
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
| `linalg-solve` | `record{A: list<list<float64>>, b: list<float64>}` | `record{x, residual_norm, b_norm, condition_estimate, growth_factor, method, iterations, warnings}` \| `tagged "linalg-solve/singular"` | First numerical-tier tool (ADR-0014). LU with partial pivoting + iterative refinement + Hager 1-norm condition estimate. Pure TS on `Float64Array`. Per ADR-0016 there is **no hard `n` cap**: large inputs run with measurement-driven scale warnings (estimated wall-clock and memory) appended to `warnings`; LU `n=500 ≈ 2.6 s`, `n=1000 ≈ 25 s` on dev-box (~3× slower on phone CPUs). True allocation OOM is the only refusal. Output is *agent-honest*: not just `x` but residual, condition, growth factor, warnings. Singular A → `tagged`; non-square / NaN → `ToolError`. |
| `linalg-qr` | `record{A: list<list<float64>>, mode?: string}` | `record{Q, R, mode, diagonal_R, reconstruction_error, orthogonality_error, method, warnings}` \| `tagged "linalg-qr/non-finite-input"` \| `tagged "linalg-qr/degenerate-shape"` | Numerical-tier (ADR-0014/0015/0016) `numerical: true`. Householder QR for real `m × n` with `mode ∈ {"reduced","complete"}` (default `"reduced"`, the LAPACK economy form). Pure TS on `Float64Array`; **no hard cap** (ADR-0016) — runs with scale warnings into the multi-second regime. Householder, not Gram-Schmidt: `‖QᵀQ − I‖_F = O(ε)` *independent of `κ(A)`* — passes Hilbert-50 (`κ > 10¹⁸`) where MGS would fail. Output is *agent-honest*: `diagonal_R` for rank diagnostics; `reconstruction_error` and `orthogonality_error` are the candidate's own self-report, cross-checked by the bench's verifier to `1e-6` relative. NaN/Inf in `A` → `tagged "linalg-qr/non-finite-input"` with offending coordinate; `m=0` or `n=0` → `tagged "linalg-qr/degenerate-shape"`; ragged → `ToolError`. Validated against the 56-case `bench/linalg-qr/` battery (392 invariant assertions; Higham 2002 §19.4 tolerances; includes 5 NIST harwell-boeing structural matrices and stress cases at n=500, n=1000). |
| `linalg-svd` | `record{A: list<list<float64>>, mode?: string}` | `record{U, S, Vt, mode, reconstruction_error, orthogonality_error_U, orthogonality_error_Vt, condition_number, rank_estimate, method, warnings}` \| `tagged "linalg-svd/non-finite-input"` \| `tagged "linalg-svd/degenerate-shape"` | Numerical-tier (ADR-0014/0015/0016) `numerical: true`. **Dual-algorithm SVD** for real `m × n` with `mode ∈ {"reduced","complete"}` (default `"reduced"`): one-sided Jacobi (Demmel-Veselić 1992) for `max(m,n) ≤ 500` and Golub-Reinsch (Householder bidiagonalisation + Demmel-Kahan implicit-shift QR sweeps; Demmel & Kahan 1990) above. Auto-dispatch is the default; the `--method` flag also accepts `"one-sided-jacobi"` and `"golub-reinsch"` to force a backend. The `method` output field reports which path actually ran. Pure TS on `Float64Array`; **no hard cap** (ADR-0016) — Jacobi runs interactively to ~n=500, Golub-Reinsch lifts the practical ceiling to ~n=2000 (~5 min on dev-box; ~25 s at n=1000 vs Jacobi's ~3.5 min). The general-purpose rank-revealing factorisation: `condition_number` and `rank_estimate` (LAPACK-standard `max(m,n)·ε·S[0]` threshold) are first-class output fields. Both algorithms achieve `O(ε)` orthogonality on both `U` and `Vᵀ` *independent of `κ(A)`* (Hilbert-50 with `κ > 10¹⁸` passes); Jacobi additionally gives high relative accuracy on small singular values where Golub-Reinsch loses half the digits — the dispatch threshold is set so users at small/mid n keep that guarantee. Output is *agent-honest*: all three error scalars cross-checked to `1e-6` relative. NaN/Inf in `A` → `tagged "linalg-svd/non-finite-input"`; `m=0` or `n=0` → `tagged "linalg-svd/degenerate-shape"`; ragged → `ToolError`. Validated against the 56-case `bench/linalg-svd/` battery (448 invariant assertions; Higham 2002 §20.3 tolerances; includes 5 NIST harwell-boeing structural matrices and stress cases at n=500 and n=1000). |
| `linalg-eigh` | `record{A: list<list<float64>>}` | `record{Q, eigenvalues, reconstruction_error, orthogonality_error, condition_number, method, warnings}` \| `tagged "linalg-eigh/non-symmetric-input"` \| `tagged "linalg-eigh/non-finite-input"` \| `tagged "linalg-eigh/degenerate-shape"` | Numerical-tier (ADR-0014/0015/0016) `numerical: true`. Cyclic Jacobi symmetric eigh (Jacobi 1846; Golub & Van Loan §8.4) for real symmetric `n × n` `A`. Pure TS on `Float64Array`; **no hard cap** (ADR-0016) — runs with scale warnings into the multi-second regime (`n=500 ≈ 7 s`). Returns `Q` (orthogonal eigenvectors) and `eigenvalues` (real, sorted ascending — numpy / LAPACK convention). Cyclic Jacobi achieves `O(ε)` orthogonality and high relative accuracy on small eigenvalues *independent of `κ(A)`* (Demmel-Veselić 1992) — passes Hilbert-50 (`κ > 10¹⁸`). Output is *agent-honest*: `reconstruction_error` and `orthogonality_error` cross-checked to `1e-6` relative. `max|A − Aᵀ| > 100·EPS·max|A|` → `tagged "linalg-eigh/non-symmetric-input"` with `(row, col, value, max_asymmetry)`; NaN/Inf → `tagged "linalg-eigh/non-finite-input"`; `n=0` → `tagged "linalg-eigh/degenerate-shape"`; non-square / ragged → `ToolError` (suggestion points at `linalg-svd`). Validated against the 46-case `bench/linalg-eigh/` battery (316 invariant assertions; Higham 2002 §20.6 tolerances; includes 5 NIST harwell-boeing SPD matrices and a stress case at n=500). |
| `integrate-1d` | `record{f: expression, var: symbol, a: float64, b: float64}` | `record{value, error_estimate, n_evals, converged, iterations, method, warnings}` \| `tagged "integrate-1d/non-finite-during-eval"` \| `tagged "integrate-1d/degenerate-interval"` | Numerical-tier (ADR-0014/0015) `numerical: true`. Adaptive Gauss-Kronrod G7K15 with global priority-queue bisection (QUADPACK-style; constants from GSL `qk15.c`). Closed integrand vocabulary: `+ - * / ^ neg exp sin cos tan log sqrt abs asin acos atan sinh cosh tanh asinh acosh atanh log2 log10` plus constants `pi`, `e`. Output is *agent-honest*: `converged` is a field, not a separate boundary — a planner reads it and decides whether to retry with a higher budget. Pole / NaN at any quadrature node → `tagged "integrate-1d/non-finite-during-eval"`; `a >= b` → `tagged "integrate-1d/degenerate-interval"`; unknown vocabulary or non-finite bounds → `ToolError`. |
| `integrate-ode-ivp` | `record{f: list<expression>, vars: list<symbol>, t_var: symbol, y0: list<float64>, t_span: record{t0, tf}, options?: record}` | `record{trajectory, t_values, error_estimate, n_evals, n_steps_accepted, n_steps_rejected, converged, status, method, warnings}` \| `tagged "integrate-ode-ivp/{degenerate-tspan,non-finite-during-eval}"` | Numerical-tier (ADR-0014/0015/0016) `numerical: true`. Adaptive non-stiff IVP solver `dy/dt = f(t, y)` via Dormand-Prince 5(4) (DOPRI5; Dormand-Prince 1980; HNW Vol I §II.5) with FSAL, Gustafsson 1991 PI step-size control, and 4th-order Hermite continuous extension (HNW §II.6) for sub-step `t_eval` points. The SciPy `solve_ivp(method='RK45')` algorithm; the workhorse of computational science for non-stiff problems. Reverse integration via `tf < t0`. Closed expression vocabulary identical to `integrate-1d` / `cas-diff`; substrate `@workbench/ode-core`. Output is *agent-honest*: `converged` is a field; `n_steps_accepted` / `n_steps_rejected` separate; `error_estimate` is the controller's 1-normalised local-error norm. **No hard cap** (ADR-0016) — large `n_components` or long horizons run with scale-advisory warnings; OOM is the only physical refusal. `t0 == tf` → `degenerate-tspan`; NaN/Inf in `f(t, y)` during integration → `non-finite-during-eval`; dim mismatch / unknown vocabulary / malformed options → `ToolError`. Validated against the 29-case `bench/integrate-ode-ivp/` battery (8 invariant checks per case ≈ 200 assertions; HNW §II.10 tolerances with 100× safety; SciPy DOP853 at `rtol=1e-13` is the trajectory oracle). |
| `integrate-ode-stiff` | `record{f: list<expression>, vars: list<symbol>, t_var: symbol, y0: list<float64>, t_span: record{t0, tf}, options?: record{rtol?, atol?, max_step?, t_eval?, method?, jacobian?}}` | `record{trajectory, t_values, error_estimate, n_evals, n_steps_accepted, n_steps_rejected, n_jacobian_evals, n_lu_decompositions, converged, status, method, warnings}` \| `tagged "integrate-ode-stiff/{degenerate-tspan,non-finite-during-eval,jacobian-singular,method-not-implemented}"` | Numerical-tier (ADR-0014/0015/0016) `numerical: true`. Adaptive **stiff** IVP solver `dy/dt = f(t, y)` via **Radau-IIA(5)** — 3-stage 5th-order implicit Runge-Kutta (Hairer-Wanner Vol II §IV.8); A-stable, L-stable, stiffly accurate. The `scipy.integrate.solve_ivp(method='Radau')` algorithm. Per-step Newton iteration on the (3n × 3n) implicit system uses the **simplified-Newton + complex-eigenvalue transformation** (Hairer-Wanner 1999): the eigenvalues of the Butcher matrix `A` factor the Newton system into one real `n × n` LU and one (2n × 2n) real LU (the complex pair, embedded) — 27× cheaper per Newton iteration than inlining a (3n × 3n) factorisation. The discriminator vs `integrate-ode-ivp`: explicit RK methods on a stiff system either take exponentially many tiny steps or blow up; Radau's L-stability damps the fast modes regardless of step size (Robertson over `t = [0, 1e10]` completes in `~150` accepted steps with bounded error throughout). Auto-derives the symbolic Jacobian via in-process `cas-diff` (per-cell `∂f_i/∂y_j`); falls back to centred finite-differences with a warning when any cell is out-of-vocabulary; `options.jacobian` shortcuts the symbolic phase for hand-tuned cases. Output is *agent-honest*: `n_jacobian_evals` and `n_lu_decompositions` are first-class bookkeeping fields — a candidate that secretly small-steps explicitly never touches `J` (the bench's `stiffness_handled` discriminator); structurally `n_lu_decompositions ≥ 2 · n_jacobian_evals` (real + complex pair per refactor). Closed expression vocabulary identical to `integrate-ode-ivp`; substrate `@workbench/ode-core`. **No hard cap** (ADR-0016) — large `n_components` or long horizons run with scale-advisory warnings (`ode-radau` accounts for the O(n³) LU dominating per-step cost above n ≈ 50). `t0 == tf` → `degenerate-tspan`; NaN/Inf in `f` or `J` during integration → `non-finite-during-eval`; LU of `(γ/h)I − J` exactly singular → `jacobian-singular` with `condition_number`; `options.method = "bdf"` → `method-not-implemented` (structural refusal — single-method path-finder); dim mismatch / unknown vocabulary / malformed options → `ToolError`. Validated against the 19-case `bench/integrate-ode-stiff/` battery (9 invariant checks per case; HW Vol II §IV.10 tolerances with 100× safety, no horizon scaling — Radau is stiffly bounded; SciPy Radau at `rtol=1e-13` is the trajectory oracle). |
| `integrate-ode-symplectic` | `record{H: expression, q_vars: list<symbol>, p_vars: list<symbol>, t_var: symbol, q0: list<float64>, p0: list<float64>, t_span: record{t0, tf}, n_steps: integer, options?: record{scheme?, atol?}}` | `record{q_trajectory, p_trajectory, t_values, energy, energy_drift_max, energy_drift_secular, n_evals, n_steps, converged, status, method, warnings}` \| `tagged "integrate-ode-symplectic/{degenerate-tspan,non-separable-hamiltonian,non-finite-during-eval}"` | Numerical-tier (ADR-0014/0015) `numerical: true`. Symplectic integrator for separable Hamiltonian systems `H(q, p) = T(p) + V(q)` via **Velocity Verlet** (2nd-order, default; Verlet 1967; HLW §I.3.1) or **Yoshida-4** (4th-order Suzuki-Yoshida composition of three Verlet sub-steps; Yoshida 1990; HLW §VI.3). The discriminator vs `integrate-ode-ivp`: a non-symplectic integrator's energy error grows linearly with `t` (`O(t · h^p)`); a symplectic integrator's energy drift is **bounded `O(h^p)` regardless of horizon** (HLW §VI.6 backward error analysis). Auto-derives `∂H/∂q_i` and `∂H/∂p_j` symbolically via in-process `cas-diff`; compiles to numeric callables via `evalNumericExpr` so the inner Verlet loop is allocation-free Float64Array arithmetic. Separability checked symbolically up-front by walking each cached gradient — non-separable inputs surface as `non-separable-hamiltonian` rather than producing wrong-quality output (Verlet's symplecticity guarantee depends on separability). Output is *agent-honest*: separate `q_trajectory` / `p_trajectory` (different physical meaning); `energy_drift_max` and `energy_drift_secular` are first-class fields the planner reads to verify symplecticity at a glance — `energy_drift_secular: false` on long-time tier-C cases (Kepler 100/10⁴ orbits, Hénon-Heiles) is the load-bearing check. Substrate `@workbench/ode-core` (`verlet.ts`, `yoshida.ts`, `hamiltonian-flow.ts`). Closed expression vocabulary identical to `cas-diff` / `integrate-1d` / `integrate-ode-ivp`. Fixed-step only (symplectic methods are inherently fixed-step; adaptive symplectic is a v0.2 extension). `t0 == tf` or `n_steps == 0` → `degenerate-tspan`; NaN/Inf during integration → `non-finite-during-eval`; dim mismatch / unknown vocabulary → `ToolError`. Validated against the 17-case `bench/integrate-ode-symplectic/` battery (8 invariant checks per case; HLW §VI.6 tolerances with 100× safety; the headline check `energy_drift_not_secular` is what a non-symplectic candidate fails on long-time Kepler). |
| `optimize-lbfgs-projected` | `record{f: expression, grad: list<expression>, vars: list<symbol>, x0: list<float64>, bounds: list<list<float64>>, options?: record}` | `record{x, fun, jac, grad_inf_norm, iterations, nfev, status, status_message, success, bfgs_skip_count, line_search_fail_count, active_bounds_count, method, warnings}` \| `tagged "optimize-lbfgs-projected/{infeasible-bounds,x0-outside-bounds,non-finite-during-eval}"` | Numerical-tier (ADR-0014/0015) `numerical: true`. L-BFGS with active-set projection, More-Thuente-style line search, Powell's curvature safeguard. Algorithm structure follows Byrd-Lu-Nocedal-Zhu 1995 / Morales-Nocedal 2011 v3.0; cross-validated against SciPy 1.14.1 (Northwestern Fortran v3.0 backend) on a 25-case manifest spanning A smooth-easy / B canonical MGH / C active-set / D ill-conditioned / E convergence-honesty / F refusals / G speed-stress (n ≤ 100). Output is *agent-honest*: `success` is a field; `status` mirrors scipy's L-BFGS-B taxonomy (0 grad-converged, 1 f-converged, 2 max-iter, 3 max-fun, 4 line-search-fail). Budget exhaustion is `success: false` on the happy path, NOT a boundary tag. `lower[i] > upper[i]` → `infeasible-bounds`; `x0` strictly outside bounds → `x0-outside-bounds` (no silent project-into-feasible); `f`/`grad` returning NaN/Inf → `non-finite-during-eval`. `n > 200` cap. Closed expression vocabulary identical to `integrate-1d`'s. |
| `poly-factor` | `record{f: expression, var: symbol}` | `record{content, factors: list<record{factor, multiplicity}>, method, warnings}` \| `tagged "poly-factor/non-polynomial"` | Exact univariate polynomial factorisation over ℚ. First Solve-tier symbolic tool (after `linsolve-q`), via the standard Berlekamp-Zassenhaus pipeline: Yun 1976 square-free split, Berlekamp 1967 factor over `𝔽_p` for a lucky prime, Zassenhaus 1969 quadratic Hensel lift to mod `p^l > 2·M(f)` (Mignotte 1974 bound), Berlekamp-Zassenhaus subset-sum recombination back to ℤ. Substrate `@workbench/poly-factor` (squareFree + henselLiftPair / henselLiftMany + berlekampFactor + recombineFactors). Output canonical: `content ∈ ℚ`, every factor in `ℤ[v]` is irreducible over ℚ, primitive (`gcd(coefs) = 1`), positive-leading, sorted by degree then lex. Out-of-scope (transcendentals, multivariate, rational functions) → `tagged "poly-factor/non-polynomial"`. Default symbolic tier — bit-identical cross-platform forever. Bench `bench/poly-factor-q/` (56-case battery, mutation-proven). |
| `poly-roots` | `record{f: expression, var: symbol}` | `record{roots: list<record{root, multiplicity}>, method, warnings}` \| `tagged "poly-roots/{complex-roots-not-yet-named,non-polynomial,multivariate}"` | Symbolic roots of univariate polynomials over ℚ. Composes `tools/poly-factor` with closed-form formulas for irreducible factors of degree ≤ 4: linear (rational root), quadratic (`(−b ± √(b² − 4ac)) / (2a)`), cubic (Cardano 1545; faithful complex form in casus irreducibilis per ADR-1yu — no trigonometric switch), quartic (Ferrari 1540 + biquadratic `q = 0` fast path). Each deg-≤4 root is an expression Value in the closed vocabulary `+ − * / ^ neg sqrt` — exact `(−1 + √5)/2`, not `0.6180...` — composable with `cas-diff`, `integrate-1d`, and the rest of the symbolic stack. For irreducible factors of degree ≥ 5 (Galois 1832: no general radical formula), each *real* root is named by `Root[poly, k]` (ADR-0018; substrate `@workbench/alg-num`) — one `Root[]` value per real root in canonical sort order. An irreducible deg-≥5 factor with one or more *complex* roots refuses with `tagged "poly-roots/complex-roots-not-yet-named"` (alg-num v0.1 names real algebraic numbers only; complex algebraic naming is a future shard). Multiplicities inherited from the factor list. Substrate `cas-core` (`linearRoot, quadraticRoots, cubicRoots, quarticRoots`) + `@workbench/alg-num` (`canonicalIntegerForm, rootToValue`) + `@workbench/real-roots` (`isolateRealRoots`). Default symbolic tier — bit-identical cross-platform forever. Validated against the 50-case `bench/poly-roots-radical/` battery (4-check verifier per ADR-0019 §1; 8 mutation perturbations; tiers A linear / B quadratic / C cubic incl. casus irreducibilis / D quartic Ferrari / E reducible / F numeric stress / G refusals; triple-witness via `bench/_corpus/oracle/` Wolfram + SymPy). |
| `real-root-isolate` | `record{f: expression, var: symbol}` | `record{intervals: list<record{lo, hi}>, method, warnings}` \| `tagged "real-root-isolate/{not-squarefree,non-polynomial,multivariate}"` | Rational isolating intervals for the real roots of a squarefree univariate polynomial in ℚ[x]. Algorithm: Vincent-Akritas-Strzebonski continued fractions with the Local-Max Quadratic (LMQ) bound (Akritas-Strzebonski-Vigklas 2008; `O(n · log B)` amortised rational ops). Two output shapes per interval: open `(lo, hi)` for irrational roots (sign-change at endpoints, exactly one root strictly inside), or singleton `(r, r)` for rational roots (`f(r) = 0` exactly). Squarefree precondition is the caller's responsibility — VAS depends on the sign-change ↔ root bijection, which fails for repeated factors; non-squarefree input refuses with `tagged "real-root-isolate/not-squarefree"`. Substrate `@workbench/real-roots` (TS port of SymPy's `dup_isolate_real_roots_sqf`, BSD). Default symbolic tier — bit-identical cross-platform forever. Validated against the 37-case `bench/real-root-isolate/` battery (4-check verifier per ADR-0019 §1 with sign-change-via-Sturm-count + open/singleton boundary correction; 9 mutation perturbations; triple-witness via SymPy `Poly.intervals()` + Wolfram `RootIntervals[][1]` count agreement). |
| `solve` | `record{eqs: list<expression>, vars: list<symbol>}` | `record{vars, solutions: list<record{bindings, branches}>, completeness, warnings}` \| `tagged "solve/{complex-roots-not-yet-named,multivariate-non-zero-dim,parametric-non-trivial,foreign-vocabulary,transcendental-multibranch,constant-equation,empty-input,empty-vars}"` | Top-level Mathematica `Solve[]`-class dispatcher (v0.2). Three lanes covered: linear systems → `bareissSolve` (exact Bareiss elimination over ℚ; unique / under-determined-with-branches / inconsistent verdicts); univariate polynomial → `factorRatQ` + radical solvers for deg ≤ 4 (closed-form Cardano/Ferrari) + `Root[poly, k]` for deg ≥ 5 with all-real roots (ADR-0018; substrate `@workbench/alg-num`); single-equation transcendental of the form `head(x) = c` for `head ∈ {exp, log, sin, cos, tan, sinh, cosh, tanh, abs}` → invert-layer with branched-solution emission (`x = arcsin(c) + 2π·t_0` ∨ `x = π − arcsin(c) + 2π·t_1` for sin, etc.); deg-≥5 factors with complex roots refuse with `solve/complex-roots-not-yet-named` (alg-num v0.1 limit); multivariate-non-zero-dim / parametric / compound-transcendental → honest boundary tags pending Gröbner / substitution-heuristic substrate. Output shape per ADR-0017 (solution-set: `bindings` per variable + `branches` for integer-parameter families). Branch-honest by design — no silent principal-branch slices. Substrate `@workbench/solve` (`classifyInput, dispatchClassified, tryTranscendentalInvert`) on top of cas-core / poly-factor / alg-num / real-roots. Default symbolic tier. Validated against the 100-case `bench/solve/` headline battery (20 hand-curated Mathematica-v1 bank + 80 stratified random across linear / univariate-poly / multivariate-zero-dim-refusal / transcendental; 4-lane dispatch verifier per ADR-0019 §1+§2; 8 mutation-prove perturbations; triple-witness via `bench/_corpus/oracle/` Wolfram + SymPy). |

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
  poly-factor/           Exact univariate polynomial factorisation over ℚ. Substrate for tools/poly-factor and prerequisite for the rest of solve-suite-v1's univariate path. Yun 1976 square-free decomposition (squareFree); Berlekamp 1967 over 𝔽_p (berlekampFactor); Zassenhaus 1969 quadratic Hensel lift (henselLiftPair, henselLiftMany); Mignotte 1974 coefficient bound + Berlekamp-Zassenhaus subset-sum recombination (mignotteBound, mignotteHenselExponent, recombineFactors). Top-level orchestration via factorPrimitiveSquareFreeZ / factorIntZ / factorRatQ. Pure ℤ/ℚ arithmetic over BigInt — no float, no FFI; bit-identical cross-platform forever. Substrate for cas-core's `Field<bigint>` instances (INT_RING, fpField) and the polyExtGcd / polyDivRemMonic primitives needed by the lift step.
  real-roots/            Real-root isolation over ℚ[x]. Substrate for tools/real-root-isolate and the algebraic-number / Root[] chain (xyt → xkz → 6cd → rti → 5i2 → yoc). Vincent-Akritas-Strzebonski continued-fraction method with the LMQ (Local-Max Quadratic) positive-root bound (Akritas-Strzebonski-Vigklas 2008); `O(n · log B)` amortised rational ops where B is the bit-length of the largest coefficient. TS port of SymPy's BSD `dup_isolate_real_roots_sqf` (`sympy/polys/rootisolation.py`); high-to-low coefficient arrays match the SymPy convention to keep the port line-by-line verifiable. Output is the open + singleton dual shape: open `(lo, hi)` for irrational roots, singleton `(r, r)` for rational roots. Pure ℤ/ℚ arithmetic over BigInt; no float; bit-identical cross-platform forever.
  alg-num/               Algebraic-number substrate. Ships the `Root[poly, k]` primitive (ADR-0018) and the four-field arithmetic closure on it. Two construction primitives produce canonical Roots (irreducible minpoly, primitive, positive-leading, ℤ[x] coefficients): (1) `makeRoot(poly, intervalHint, v)` names the unique root inside a supplied real isolating interval (sign-criterion-disambiguated across irreducible factors); (2) `makeRootByIndex(poly, k, v)` names "the global k-th real root of poly in ascending order" (factors over ℚ, sorts roots cross-factor by interval bisection, re-indexes within the chosen factor). The wire encoding is `expression { head: "Root", args: [Polynomial[c_0, …, c_n], k] }` with all coefficients integer-typed; `valueToRoot` always defers to `makeRootByIndex` so non-canonical wire input is silently canonicalised per ADR-0018. `refineRoot(r, { bits: N })` lazily contracts the runtime isolating interval below width 2^{−N} via rational bisection. `rootCanonicalEq` is sufficient for equality of Roots produced by any constructor. Arithmetic: `algNumNeg`, `algNumInv`, `algNumAdd`, `algNumSub`, `algNumMul`, `algNumDiv` — minpolys built via `Res_y(f(y), g(x − y))` / `Res_y(y^{deg f} f(x/y), g(y))` (Cohen GTM 138 §3.6.2) using a Sylvester-matrix-via-Bareiss resultant in ℚ[x], with refine-and-retry interval disambiguation. Real roots only in v0.1; complex naming and primitive-element compression for ≥ 3 algebraics (5i2) extend this surface.
  solve/                 Top-level `Solve[]`-class dispatcher substrate. Classifier (classifyInput) decides the dispatch lane (linear / univariate-poly / unsupported); dispatcher (dispatchClassified) executes via cas-core's bareissSolve or poly-factor + radicals; single-head transcendental matcher (tryTranscendentalInvert) handles `head(x) = c` patterns with branched-solution emission. Returns ADR-0017's solution-set shape (record { vars, solutions: list<{bindings, branches}>, completeness, warnings } | tagged "solve/<class>"). v0.1 covers linear, univariate-polynomial, and single-head-transcendental lanes; multivariate-non-zero-dim / parametric / compound-transcendental refuse honestly via boundary tags. Branch-honest by design — no silent principal-branch slices.
  ode-core/              ODE integration substrates on Float64Array. Substrate for tools/integrate-ode-ivp (adaptive non-stiff Dormand-Prince 5(4) with FSAL bookkeeping, Gustafsson 1991 PI step-size controller, 4th-order Hermite continuous extension; HNW Vol I §II.5/§II.6 — the SciPy `solve_ivp(method='RK45')` algorithm in pure TS), tools/integrate-ode-stiff (adaptive stiff Radau-IIA(5) with simplified-Newton + complex-eigenvalue split factorisation per HW Vol II §IV.8 / Hairer-Wanner 1999 — the SciPy `solve_ivp(method='Radau')` algorithm), and tools/integrate-ode-symplectic (Velocity Verlet + Suzuki-Yoshida 4th-order composition for separable Hamiltonian flows; HLW §I.3.1, §VI.3, §VI.6 — energy drift bounded `O(h^p)` regardless of horizon). Closed-vocabulary RHS evaluation reuses `@workbench/quadrature::evalNumericExpr`.
  compose/               In-process composition layer (ADR-0012): `loadWorkbench()` returns a live registry of every tool's `def`; `wb.run(name, input, flags)` invokes a tool in the orchestrator process under the same schema-validation + provenance contract as the subprocess surface. The TS-expert call site for the workbench.
  bigfloat/              Arbitrary-precision binary floating-point (`BigInt` mantissa + `i32` exponent). The first arb-prec substrate (ADR-0020). MPFR-style per-value precision, round-half-to-even normalisation, full transcendental + special-function vocabulary (Γ, lgamma, digamma, trigamma, polygamma) on real and complex `BigComplex`. Bit-identical cross-platform forever — every operation is `BigInt`-deterministic by language spec. Underpins every `arbprec: true` tool.
  hypergeometric/        Generalised hypergeometric `pFq` evaluator. Direct power series with cancellation-driven precision retry; closed-form fast paths for 0F0/1F0; `tagged "<tool>/non-convergent"` refusal in the asymptotic and `|z|≈1` regimes. The library face of `tools/hypergeometric-pfq`.
  meijer-core/           Meijer G-function algorithmic substrate (Layers 3 + 5 of `tstournament` problem-13). Slater residue-summation (Series 1 + Series 2) with `(p, q, m, n, |z|)` selection rule, deterministic odd-coefficient perturbation for parameter coalescence, cancellation-driven retry; Mellin-Barnes contour quadrature on a vertical contour `Re(s) = c` via the BigComplex G7K15 driver (ADR-0022) with auto-selected contour location and Stirling-rate-derived truncation. Composes `@workbench/bigfloat` + `@workbench/hypergeometric` + `@workbench/quadrature`. Future layers (Braaksma asymptotic, top-level dispatcher) land alongside.

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
