# ADR-0030 — Convex cone solver tier (LP / QP / SOCP / SDP / EXP / POW)

**Status:** Proposed — 2026-05-10
**Beads:** scientist-workbench-eg9j (epic; the D_W1 dogfood forcing this
ADR — the workbench has no SDP/LP/QP and the entire convex-optimisation
side of quantum-info, statistics, and control theory is blocked behind
it).
**Related:** ADR-0014 (first numerical tier — float64 dense linalg, the
substrate this tier extends); ADR-0015 (determinism tier; this tier is
`numerical: true` like the linalg ADR-0014 family, but with explicit
iteration count and precision tolerance as part of the algorithm spec);
ADR-0020 (arbitrary-precision tier; *parallel* to this tier — the
`--precision` knob pattern is shared but the substrate differs); ADR-
0011 (typed flag declarations — `--precision` and `--max-iter` enter as
standard flags for this tier); ADR-0028 (bench migration to corpus —
the LP / QP / SDP benchmark suites live corpus-side).
**Supersedes:** the trip-report observation in the D_W1 dogfood that the
workbench has no convex-cone solver. Filed as the universal blocker for
quantum-information, optimal-control, statistical-estimation, and
hypothesis-testing workflows.

## Context

The D_W1 (De Palma-Marvian-Trevisan-Lloyd 2021) dogfood exercise on
2026-05-10 surfaced the absence of any convex-optimisation tier in the
workbench. The exercise computed the quantum Wasserstein distance of
order 1 for n = 1 qubit successfully via `wb.linalgEigh`, but n ≥ 2
reduces to an SDP — minimise a non-smooth trace-norm objective over an
affine subspace, naturally written as

```
minimise    Σ_i tr(X_i^+) + tr(X_i^-)
subject to  X_i^+ - X_i^- = X_i,    X_i^± ⪰ 0
            Σ_i X_i = X,            tr_i(X_i) = 0 ∀i
```

and the workbench cannot solve it. The available optimisation tool —
`optimize-lbfgs-projected` — handles smooth box-constrained problems
only. The non-smoothness of the trace-norm and the equality constraints
together place the problem strictly outside its scope.

The gap is structural and broad. Convex optimisation is the substrate
under: optimal-state-discrimination POVMs, separability / entanglement
witnesses, channel-fidelity bounds, MAXCUT relaxations, robust control,
LP-based combinatorial relaxations, portfolio optimisation, maximum-
likelihood estimation with convex priors, geometric programming, and
the entire DSL surface of CVXPY / YALMIP / Convex.jl.

No high-quality pure-TypeScript convex-cone solver exists. WASM ports
of GLPK, HiGHS, SCS, and OSQP exist but break the substrate decision
(PRD §1.3) and the `numerical: true` cross-platform-fingerprint
contract (ADR-0015, since the WASM bytecode is one binary but the
numerics aren't bit-identical to a native rebuild of the same source).

This ADR codifies the tier the workbench will add.

## The axiom (re-applied)

ADR-0009: agents are TS experts; what a TS expert wants is the spec.
ADR-0014 added the planner's lens: what makes this irresistible to an
agent's planner? PRD §1.1 (revised 2026-05-10) sharpens this: agents
have no say in any other scientific ecosystem; here the agent's
experience IS the design.

Three specific reads shape every decision below.

1. **A TS expert types `wb.coneSolve({...})` and expects the universe
   of convex optimisation behind it.** Not three separate tools they
   must choose between. Not "first classify the cone, then pick the
   right solver". One symbol, one mental model, one schema. Like
   `Array.prototype.sort` — universal default; structural specialists
   are an optimisation, not a primary surface.

2. **The TS expert reads `precision?: float64` on the schema and types
   it only when they need to.** Default `1e-8`. The implementation
   chooses simplex vs IPM vs ADMM vs iterative refinement based on the
   target. The agent reads back `achieved_precision` as part of the
   output and decides what to do — never needs to know what algorithm
   ran.

3. **The TS expert lusts for honest output.** `status: "optimal" |
   "infeasible" | "unbounded" | "iter-cap" | "numerical-breakdown" |
   "precision-unreachable"` is one taxonomy. Each branch is honestly
   reported with the artefacts the agent needs to act on it
   (`certificate_of_infeasibility`, `unbounded_direction`,
   `condition_estimate`, etc.). The mode where the solver returns
   garbage with a happy `status: "optimal"` is precisely what the
   workbench's honest-scope rule (CLAUDE.md Rule 8) forbids and is the
   single most common failure mode of amateur convex solvers.

## Decision

### A. Tier annotation: `numerical: true` with mandatory iteration discipline

Tools in this tier carry `numerical: true` per ADR-0015 — bit-identical
output given the platform fingerprint `{arch, os, runtime}`. Cross-
platform variation surfaces honestly in the provenance record's
`platform` field. `runMemoized` cache hits drop when the platform
differs.

Three additional contracts beyond ADR-0014's:

1. **The iteration count is part of the algorithm spec, not a magic
   constant.** `--max-iter=<int>` is a standard flag in this tier with
   per-algorithm default (LP-simplex: 10×(m+n); LP-IPM: 100; SCS-ADMM:
   2500; SDP-IPM future: 200). The default is documented per tool.
   Agents pass it explicitly when they care.

2. **Tolerance schedule is fixed and reproducible.** Convergence
   thresholds `tol_feas` (primal/dual feasibility), `tol_gap`
   (duality gap), and `tol_rel` (relative residual) are flagged by the
   `--precision=<float64>` knob with the mapping `tol_feas = tol_gap
   = precision`; `tol_rel = max(precision, 10·eps_machine)`. The
   knob is a *user-facing dial* with one number; the internal
   tolerance triple is derived deterministically from it.

3. **Failure is enumerated, not approximated.** Five termination
   classes, exhaustive, mutually exclusive:
   - `optimal` — KKT conditions met within `precision`.
   - `infeasible` — primal infeasibility certificate found (Farkas /
     improving ray).
   - `unbounded` — dual infeasibility certificate found.
   - `iter-cap` — `max_iter` exhausted before any of the three above.
   - `numerical-breakdown` — Cholesky failure, line-search collapse,
     ill-conditioning beyond rescue.

   Additionally, refusal-envelope (boundary failure) class:
   - `tagged "cone-solve/precision-unreachable"` — convergence
     suggests an answer exists but achievable precision is worse
     than requested. Payload carries `{achieved, requested,
     condition_estimate}`.
   - `tagged "cone-solve/{non-finite-input,degenerate-shape,
     malformed-cone}"` for input-error refusals.

### B. Architecture: universal primary + structure-aware specialists

Four primary user-facing tools:

| tool | priority | algorithm class | accuracy ceiling | use case |
|---|---|---|---:|---|
| `cone-solve` | **PRIMARY** | SCS-style ADMM on homogeneous self-dual embedding | 1e-6 | universal — any combination of cones |
| `lp-solve` | specialist | revised simplex (Bartels-Golub LU update) + Mehrotra IPM (dispatch by precision) | 1e-12 | LP best-in-class |
| `qp-solve` | specialist | Mehrotra IPM with Q-block in KKT | 1e-10 | QP best-in-class |
| `sdp-solve` | specialist (deferred) | primal-dual IPM with HKM/NT direction | 1e-10 | SDP high-accuracy (future) |

`cone-solve` is the default agents reach for. It handles arbitrary
products of cones from `{zero, nonneg, SOC, PSD, EXP, POW}` uniformly
via operator splitting on the homogeneous self-dual embedding (HSDE).
At `precision <= 1e-6` it is sufficient for >95% of practical convex
optimisation tasks including all the quantum-info computations the
qinfo epic (hsxa) requires.

The specialists exist for the moments when the agent has already
classified the problem and wants the best-in-class path for that
structure. They run faster, converge to higher accuracy, and provide
extra outputs that only make sense per-cone (LP returns a vertex
basis; QP returns active-set; SDP returns the dual matrix).

This mirrors `Array.prototype.sort` (universal default, Timsort
internally) and `radix-sort` (specialist for known structure, faster
on its target). Both are useful; neither dominates.

**Why not a single universal solver only?** Best-in-class accuracy
on LP / QP demands algorithms (simplex, Mehrotra IPM) that exploit
structure SCS cannot. The agent that knows it has a pure LP and
wants 1e-12 deserves the right tool.

**Why not separate per-cone solvers only?** Most practical convex
problems mix cones (LP+SOC, LP+PSD, …). Forcing the agent to
re-discretise into the per-cone surface is friction the universal
primary erases.

### C. Wire schema for `cone-solve` input

```ts
S.record({
  minimize:   S.record({
    c: S.list(S.kind("float64")),
    Q: S.list(S.list(S.kind("float64")))         // optional, PSD
  }, { optional: ["Q"] }),
  subjectTo:  S.record({
    Ax_eq_b:  S.record({                          // optional equality
      A: S.list(S.list(S.kind("float64"))),
      b: S.list(S.kind("float64"))
    }),
    cones:    S.list(S.expression())              // see below
  }, { optional: ["Ax_eq_b"] }),
  precision:  S.kind("float64"),                  // optional, default 1e-8
  max_iter:   S.kind("integer")                   // optional, alg-default
}, { optional: ["precision", "max_iter"] })
```

Cones are encoded as `expression` values, one head per cone family,
in the same pattern as `Root[poly, k]` (ADR-0018) and the polynomial
encoding:

| head | args | meaning |
|---|---|---|
| `NonNegCone` | `[indices: list<integer>]` | `x_i ≥ 0 ∀ i ∈ indices` |
| `SOCone` | `[indices: list<integer>]` | `x_{indices[0]} ≥ ‖x_{indices[1..]}‖₂` |
| `PSDCone` | `[size: integer, indices: list<integer>]` | upper-tri vec of an `size × size` PSD matrix |
| `ExpCone` | `[i: integer, j: integer, k: integer]` | `y exp(x/y) ≤ z` with `y > 0` |
| `PowCone` | `[alpha: rational, i: integer, j: integer, k: integer]` | `x^α y^(1-α) ≥ |z|` |
| `ZeroCone` | `[indices: list<integer>]` | `x_i = 0` (rare; usually absorbed into `Ax_eq_b`) |

Index conventions match SCS: cones are over slices of the variable
vector `x`, identified by integer indices. The PSDCone encodes a
symmetric matrix via its upper-triangular vectorisation (`size *
(size+1) / 2` indices).

### D. Wire schema for output

```ts
S.record({
  status:           S.kind("string"),     // see termination taxonomy above
  x:                S.list(S.kind("float64")),
  objective:        S.kind("float64"),
  dual:             S.list(S.kind("float64")),         // dual variables
  slack:            S.list(S.kind("float64")),         // primal slacks
  achieved_precision: S.kind("float64"),               // honest primal-dual gap
  iterations:       S.kind("integer"),
  method:           S.kind("string"),                  // which internal path ran
  condition_estimate: S.kind("float64"),               // Hager 1-norm
  warnings:         S.list(S.kind("string"))
})
```

Or, on boundary failure, tagged envelope per (A.3) above.

### E. Algorithm port discipline: from paper, never from code

All algorithms in this tier derive from primary references (papers,
textbooks, the published technical report shipped with the canonical
implementation). No line-by-line port of `scs.c`, `OSQP.c`, `SDPT3.m`,
or any other source. CLAUDE.md Law 1 ("Ground truth before code,
open the canonical reference") applies pitilessly.

Per-tool reference table:

| tool | primary references |
|---|---|
| `cone-solve` (SCS-style) | O'Donoghue et al 2016 *Conic Optimisation via Operator Splitting and Homogeneous Self-Dual Embedding*; O'Donoghue 2021 *Operator Splitting for a Homogeneous Embedding* (technical report); Boyd-Parikh-Chu-Peleato-Eckstein 2011 *Distributed Optimisation and Statistical Learning via the Alternating Direction Method of Multipliers* (the ADMM foundation) |
| `lp-solve` (simplex path) | Dantzig 1947; Bartels-Golub 1969 *The Simplex Method of Linear Programming Using LU Decomposition*; Bland 1977 *New Finite Pivoting Rules*; Vanderbei *Linear Programming* 4th ed. (the textbook) |
| `lp-solve` (IPM path) | Mehrotra 1992 *On the Implementation of a Primal-Dual Interior-Point Method*; Wright *Primal-Dual Interior-Point Methods*; Ye-Todd-Mizuno 1994 (HSDE for LP) |
| `qp-solve` | Nocedal-Wright Ch.16; Vanderbei Ch.16-18; Mehrotra 1992 extension to the quadratic objective term |
| `sdp-solve` (white whale, deferred) | Tutuncu-Toh-Todd 2003 *Solving Semidefinite-Quadratic-Linear Programs Using SDPT3* (Math Prog); Helmberg-Rendl-Vanderbei-Wolkowicz 1996 (HKM direction); Nesterov-Todd 1997 *Self-Scaled Barriers and Interior-Point Methods for Convex Programming* (NT direction); Boyd-Vandenberghe *Convex Optimisation* Ch.11 (interior-point pedagogy) |

The corollary: license compatibility is automatic. Paper-derived code
is AGPL-3.0-or-later from birth; the upstream paper's IP only covers
the algorithm description and that is uncopyrightable. SCS's BSD-3,
OSQP's Apache-2.0, SDPT3's GPL-2.0 are *informational* about what the
respective canonical implementations carry, not constraints on a
clean-room TS implementation.

### F. Bench discipline: triple-witness from day one

Per ADR-0028, the benchmark suites live in `scientist-workbench-corpus/
benchmarks/`. Three suites:

- `benchmarks/lp-netlib/` — the NetLIB LP collection (114 problems,
  public domain since 1985, the canonical LP test set). Reference
  oracles: Gurobi, Mosek, COPT. Invariants per problem: primal-
  feasibility (`Ax = b`, `x ≥ 0`), dual-feasibility (`Aᵀy + s = c`,
  `s ≥ 0`), complementary slackness (`xᵀs = 0`), optimality gap
  (`|cᵀx - bᵀy| ≤ tol`), oracle-agreement (candidate matches the
  three commercial solvers' objective values within 1e-8).
- `benchmarks/qp-maros-meszaros/` — Maros-Mészáros QP collection
  (138 problems, the canonical QP test set since 1999). Same
  invariants plus KKT residual.
- `benchmarks/sdp-sdplib/` — SDPLIB (Borchers 1999, ~90 problems
  covering Lovász θ, MAXCUT, control LMIs, eigenvalue minimisation).
  Same invariants plus PSD primal/dual feasibility.

Triple-witness pattern: agreement among Gurobi, Mosek, COPT on a
problem is the ground truth. Disagreement among the three is itself
a finding — usually multiple-optimum or numerical-rank — and gets
flagged as `oracle-disagreement` in the corpus DuckDB. Such problems
either drop from the gating set or surface for review.

**Trajectory checkpoints reserved from day one.** The corpus schema
gets columns for `iter_5_residual`, `iter_25_residual`,
`iter_final_residual`, `iter_count`, `runtime_sec`. v0.1 only consumes
the final answer, but having the columns means later checks (residual
trajectory matching across oracles) unlock with zero schema migration.

### G. White-whale deferral: SDPT3-equivalent IPM is NOT v0.1

`tools/sdp-solve` (the primal-dual IPM with HKM/NT direction) is
**explicitly deferred**. The substrate this ADR specifies makes it
reachable but does not commit to it.

Trigger conditions for un-deferring:
- A real bench instance fails on `cone-solve` at the 1e-6 ceiling and
  the use case demands 1e-10.
- An adopted research workflow (typically: numerical entanglement
  witnesses near the boundary, or LMI-feasibility with tight margins)
  reports `achieved_precision` worse than the certificate's mathematical
  margin.
- The qinfo epic (hsxa) Phase 3 or 4 lands a tool whose accuracy
  contract requires it.

Until one of these fires, the v0.1 `cone-solve` at 1e-6 is the SDP
path. The PRD §1.4 iteration culture is explicit on this: "Iteration
to v144 of any tool is expected. Multiple overlapping tools are fine."
The whale comes when the whale's cost is justified.

### H. Substrate package: `packages/cone-core/`

A new package depending on `protocol`, `contract`, `linalg-core`. Public
API:

```ts
// cones.ts — primitives
export type Cone = NonNeg | SOC | PSD | Exp | Pow | Zero | Free
export function projectCone(z: Float64Array, K: Cone): Float64Array
export function dualCone(K: Cone): Cone
export function inCone(z: Float64Array, K: Cone, tol: number): boolean

// hsde.ts — homogeneous self-dual embedding
export function buildHSDE(problem: ConeProblem): HSDEMatrix
export function recoverPrimalDual(z, tau, kappa, problem): Solution

// scs.ts — operator-splitting iteration
export function scsSolve(problem: ConeProblem, opts: SCSOpts): Solution
```

Plus per-cone-specialist substrates as separate packages (`packages/
lp-solver/`, `packages/qp-solver/`) sitting alongside `cone-core`.

## Why rejected alternatives

**WASM-wrap (glpk.js, highs-js, scs-wasm).** Breaks PRD §1.3 substrate
decision; the four pillars (cold start, agent fluency, deterministic
single-binary distribution, value protocol as substrate boundary) all
require pure-TS. Specifically: WASM bytecode is one binary, but the
numerics aren't bit-identical to a native rebuild of the same source on
all platforms — the `numerical: true` cross-platform-fingerprint
contract from ADR-0015 cannot be guaranteed on WASM, because we can't
audit the WASM-runtime's float64-determinism guarantees the same way we
can audit our own TS.

**White whale first.** Tutuncu-Toh-Todd 2003-style primal-dual IPM with
HKM/NT direction is the gold-standard SDP solver. Building it before
the universal SCS-port is forecast to be ~3 months vs ~10 weeks for
the SCS-port. No current use case requires 1e-10 SDP. Spending the
budget on the whale before knowing it's needed is precisely the
"best-in-class trap" the PRD §1.4 iteration culture warns against.

**Per-cone solvers without a universal primary.** Forcing every agent
to first classify their problem into "is this LP? QP? SOC? SDP?
mixed?" before reaching for a tool violates the §1.1 lust principle
("agents have no say in any other ecosystem; here the agent's
experience IS the design"). The lust is for one symbol. The
universal primary delivers it.

**Universal primary without specialists.** Best-in-class accuracy on
LP and QP at large scale demands algorithms (simplex, Mehrotra IPM)
that SCS cannot match. Agents that have classified their problem
deserve the right tool. The specialists are the structural-radix-sort
to the universal's `Array.prototype.sort`.

**Unify LP-simplex and LP-IPM into one `tools/lp-solve` with a
`--method` flag.** Considered. Rejected because the two algorithms have
different output shapes (simplex returns a vertex basis; IPM does
not), different per-iteration cost profiles, and different
edge-case behaviour (simplex degeneracy cycling vs IPM ill-conditioned
Schur). The agent that knows it wants a vertex basis (for sensitivity
analysis, parametric LP, branch-and-bound) deserves to type the path
that produces one. The single `lp-solve` *internally* dispatches by
default; the `--method=simplex` and `--method=ipm` flags force one or
the other when the agent has a structural reason.

**Sparse from v0.1.** Considered. Rejected because sparse Cholesky
with AMD reordering is itself a multi-week project, the v0.1 problem
sizes (n=1000 LP / n=100 SDP) fit comfortably in dense storage
(8 MB / 80 KB per dense matrix), and adding sparse as a transparent
v0.2 optimisation does not break the API. The wire schema accepts
`list<list<float64>>` for matrices; future sparse-input schemas (CSR
or COO) land additively.

## Determinism contract (summary)

| property | this tier |
|---|---|
| annotation | `numerical: true` (ADR-0015) |
| bit-identical | given platform fingerprint |
| `precision` flag default | 1e-8 |
| `precision` interpretation | primal-dual gap and feasibility residual target |
| `max_iter` default | per algorithm (documented per tool) |
| algorithm choice | internal; reported in output `method` field |
| iteration trajectory | reproducible given fixed input + fixed flags + fixed platform |
| float64 ordering | TypeScript IEEE-754 left-to-right; never reorder for "optimisation" |
| comparison gates | every floating-point comparison uses an explicit `tol_*` parameter; no `if (x > 0)` style implicit-zero gates |

## Open questions (to resolve before v0.2)

1. **Wire-name dotted vs slashed for the eventual shallow namespace
   (PRD §10.2 future direction).** Tool names will be `cone-solve`,
   `lp-solve`, etc., in flat layout; `cone/solve` or `cone.solve` in
   the shallow-namespace migration. Decision deferred to the ADR that
   accompanies the namespace migration (bead scientist-workbench-3uxn).

2. **Whether `cone-solve` should accept a free-variable cone
   (`FreeCone[indices]`) or whether free variables must be split into
   `x = x⁺ - x⁻` with `x⁺, x⁻ ≥ 0` by the caller.** SCS's wire format
   does not have free; SDPT3 does. The TS-expert lust is for free
   variables to "just work" — argue for `FreeCone` as a first-class
   input cone, with internal splitting on the implementation side.
   Confirm in the v0.1 cone-solve implementation worklog.

3. **Quadratic objective in `cone-solve` vs dedicated `qp-solve`.** The
   SCS algorithm supports `(1/2)xᵀQx` natively. Allow `Q` in
   `cone-solve`'s `minimize` field? Yes, per the lust principle. The
   QP specialist still exists for accuracy reasons but the universal
   accepts Q.

4. **PSD-cone vectorisation: upper-triangular column-stack vs row-stack
   vs strict-Mosek-format with √2 off-diagonal scaling.** SCS uses
   strict-Mosek-format (off-diagonal entries scaled by √2 so that
   tr(A B) reduces to vec(A)ᵀvec(B) in the vectorised representation).
   Adopt the same. Document explicitly with examples — the off-
   diagonal-√2 trick has bitten every amateur SDP implementer.
   **Resolved 2026-05-14 (bead 0wc7):** `cone-core`'s `PSDCone` block is
   the **upper-triangular, row-major** `svec` with the √2 off-diagonal
   scaling. The convention, the isometry argument that makes it
   load-bearing, and worked examples are transcribed in
   `docs/ground-truth/convex/cone-projections.md` §3 and implemented in
   `packages/cone-core/src/cones.ts` (`smat` + the `psd` case of
   `projectCone` / `inCone`).

5. **Sparse matrix wire format for v0.2.** CSR (CSC) is the standard;
   COO is the lowest-friction. Decision deferred until v0.2 is filed.

## Acceptance (for v0.1 epic close-out)

- `packages/cone-core/` substrate package shipped with cone projections,
  HSDE construction, and the SCS iteration.
- `tools/cone-solve` shipped as a seven-artefact tool (schema,
  examples, invariants, --test, goldens, README, def). NetLIB-LP
  bench grades ≥98/114 cases against Gurobi-Mosek-COPT triple-witness.
- `tools/lp-solve` shipped with both simplex and IPM internal paths.
  NetLIB-LP grades ≥110/114 cases. Vertex-basis output validated.
- `tools/qp-solve` shipped. Maros-Mészáros grades ≥120/138 cases.
- `benchmarks/lp-netlib/`, `benchmarks/qp-maros-meszaros/`,
  `benchmarks/sdp-sdplib/` shipped to `scientist-workbench-corpus`
  with triple-witness adapters.
- `tools/sdp-solve` remains explicitly deferred to a future ADR.

## Addendum (2026-05-14) — the consumer-form convergence-test hook (bead `oxuk`)

`cone-core`'s `scsSolve` decides the `optimal` status from O'Donoghue
2016's §3.5 termination test: the primal/dual/gap relative residuals of
the *embedded translated* problem, in 2-norm, with the gap term
`cᵀx + bᵀy`. `tools/cone-solve`'s `precision` contract, however, is
denominated in the **§C-wire-form** KKT residual of the *recovered §C
point* — `max(r_p, r_d, r_c)` in ∞-norm with an `xᵀs` complementary-
slackness term, exactly as the corpus `lp-netlib` verifier recomputes
it. The two measurements differ by a per-problem factor (0.59–3.08
across the `lp-netlib` profile — *not* a fixed ratio). Bead `rgl8`'s
stopgap was a post-hoc coherence guard in the tool: re-label
`optimal → iter-cap` whenever the recovered §C residual exceeded the
request. That keeps the tool honest but is pessimistic — a case that
*could* reach the requested precision with a few more iterations is
reported `iter-cap` purely because `scsSolve` stopped early on a looser
proxy.

Three fixes were weighed:

1. **An optional caller-supplied convergence test on `cone-core`.**
2. **`cone-core` adopts the ∞-norm + `xᵀs` form so its `optimal` matches
   the wire contract.** *Rejected — structurally impossible.* `cone-core`
   only ever sees the *translated embedded* problem; it never holds the
   original §C `(A, b, c)`. No change to its residual *form* can make it
   measure a residual of a problem it does not have. The translation
   mixes the §C primal residual and the cone-membership residual into a
   single embedded vector — they are genuinely different measurements.
3. **`cone-solve` passes `cone-core` a tighter internal `precision`
   derived from a per-problem amplification estimate.** *Rejected —
   a bandaid (CLAUDE.md Rule 2).* The amplification ratio is exactly the
   thing that is unpredictable (0.59–3.08); correctness-by-estimate is
   the "looks like it works" anti-pattern.

**Decision: option 1.** `SCSOpts` and `recoverPrimalDual` gain an
optional `convergenceTest?: (candidate: Candidate) => boolean`. When
absent — the default, `DEFAULT_SCS_OPTS` does not set it — `scsSolve` is
the paper-faithful standalone substrate, §3.5 unchanged, the 90-test
suite's semantics fixed. When supplied, the predicate is the **sole
arbiter of the `optimal` status** (the infeasible / unbounded
certificate branches are untouched); `scsSolve` is driven to the
*caller's* criterion. `tools/cone-solve` supplies a closure that
recovers the §C point from each `Candidate` and returns
`kktResidualC(...) ≤ precision`, so the iteration converges to the wire
contract directly and `optimal` from the tool means `optimal` with no
asterisk — `rgl8`'s coherence-guard re-label is retired.

This is the `Array.prototype.sort(comparator)` move: the substrate owns
the machinery, the caller owns the decision criterion. `cone-core`'s
`SCSResult.achievedPrecision` keeps its meaning unchanged — the §3.5
embedded residual — and `cone-solve` recomputes its own §C-wire-form
`achieved_precision` for the §D output, as it already did. Worklog
shard 116; `docs/worklog/114-cone-solve-bench-reconciliation.md` for the
`rgl8` surfacing.

## Pointers

- D_W1 dogfood trip-report (chat-resident; not committed since `/temp`
  is gitignored): the originating signal for this tier.
- PRD §1.1 (revised 2026-05-10): the unapologetic agent-first framing
  that makes the universal-primary architecture mandatory.
- PRD §10.2 (added 2026-05-10): the shallow-namespace future-direction
  this ADR's tool names will eventually re-home into.
- ADR-0014: the first numerical tier (`linalg-*`). This ADR is its
  follow-on covering optimisation rather than direct solve.
- ADR-0015: the determinism-tier ADR. This ADR's `numerical: true`
  inherits its platform-fingerprint contract verbatim.
- ADR-0020: the arbitrary-precision-tier ADR. Parallel pattern; if
  precision-beyond-float64 SDP is ever needed, an ADR-0030-bigfloat
  successor would lift this tier onto `packages/bigfloat`.
