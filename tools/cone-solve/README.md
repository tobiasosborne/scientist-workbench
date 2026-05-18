# cone-solve

The universal convex-cone solver — the Phase-1 *primary* tool of the
convex-cone solver tier (ADR-0030 §B). The symbol an agent reaches for to
solve any convex cone program without first classifying it as LP / QP /
SOCP / SDP: one schema, one mental model, one honest status taxonomy. It
wraps the SCS operator-splitting substrate in `@workbench/cone-core`
(homogeneous self-dual embedding, O'Donoghue-Chu-Parikh-Boyd 2016), with
Ruiz data equilibration and Type-II Anderson acceleration (ADR-0036). The
LP and QP *specialists* (`tools/lp-solve`, `tools/qp-solve`) exist for
best-in-class accuracy on known structure; `cone-solve` is the universal
default.

## Input (ADR-0030 §C)

```jsonc
{
  "minimize":  { "c": <list<float64>>, "Q?": <list<list<float64>>> },
  "subjectTo": {
    "Ax_eq_b?": { "A": <list<list<float64>>>, "b": <list<float64>> },
    "cones":    [ <expression>, ... ]   // NonNegCone[idx], ZeroCone[idx], FreeCone[idx]
  },
  "precision?": <float64>,              // default 1e-8
  "max_iter?":  <integer>               // default 50000 (ADR-0037 §D)
}
```

The §C problem is `minimise cᵀx s.t. A x = b, x ∈ 𝒦` — the cone
constrains the *variable vector* directly. `cone-solve` translates this
into `cone-core`'s O'Donoghue form (cone on the slack, `x` free), solves,
and recovers the §C primal–dual point.

## Output (ADR-0030 §D)

A success record — `{ status, x, dual, slack, objective?,
achieved_precision?, iterations, method, condition_estimate, warnings }`
— where the `status` discriminant *is* the contract:

| status | meaning |
|---|---|
| `optimal` | KKT met within `precision`; `objective` / `achieved_precision` present. `achieved_precision` is the §C-wire-form `max(r_p, r_d, r_c)` of the *returned* `(x, dual, slack)` — the residual the consumer measures, not `cone-core`'s internal embedded-form figure (bead `rgl8`) |
| `infeasible` | primal infeasible; `dual` is a Farkas certificate (`bᵀy = −1`) |
| `unbounded` | primal unbounded; `x` is an unbounded ray (`cᵀx = −1`) |
| `iter-cap` | `max_iter` was hit before the §C-wire-form residual reached `precision`. Best-effort iterate + honest `achieved_precision`. (`optimal` always means `achieved_precision ≤ precision`: the tool hands `cone-core` a `convergenceTest` denominated in exactly the §C-wire-form residual — bead `oxuk` — so `scsSolve` is driven to the wire criterion directly, with no post-hoc `optimal → iter-cap` re-label.) |
| `numerical-breakdown` | non-finite iterate or failed factorisation |

Or a boundary-failure refusal envelope `tagged "cone-solve/<class>"` for
input the tool will not attempt:

- `non-finite-input` — NaN / ±∞ in `c`, `A`, or `b`.
- `degenerate-shape` — dimension mismatch, empty objective, a problem
  with no constraints, or a malformed `precision` / `max_iter`.
- `malformed-cone` — a cone that is not a well-formed expression, an
  out-of-range index, or an index covered by two cones.
- `unsupported-cone` — `SOCone` / `PSDCone` / `ExpCone` / `PowCone`:
  outside cone-solve v0.1's LP-complete scope (the message names the
  `cone-core` sub-bead — `0wc7` for SOC+PSD, `j282` for Exp+Pow).
- `quadratic-objective` — a `minimize.Q` is present; deferred per
  ADR-0030 open-question 3.

There is no mode where the solver returns garbage under a happy
`optimal` (CLAUDE.md Rule 8).

## How

SCS-style operator splitting on the homogeneous self-dual embedding
(`@workbench/cone-core`; ground truth
`docs/ground-truth/convex/scs-algorithm.md`, ported from
`docs/refs/odonoghue-2016-scs.pdf`). The substrate applies Ruiz data
equilibration (O'Donoghue §5) and Type-II Anderson acceleration
(ADR-0036) to the iteration.

`cone-core`'s paper-faithful §3.5 termination test is denominated in the
*embedded translated* problem's residual — looser/tighter than this
tool's `precision` contract (the §C-wire-form KKT residual of the
recovered point) by a per-problem 0.59–3.08× factor. So the tool hands
`scsSolve` an `SCSOpts.convergenceTest` that *is* the §C-wire-form test
(`kktResidualC ≤ precision`, ADR-0030 addendum, bead `oxuk`): the
iteration is driven to the wire criterion directly, and an `optimal`
from this tool means the wire contract holds with no asterisk.

**Accuracy.** SCS is a modest-accuracy first-order method (ADR-0030 §B:
`cone-solve` ceiling ≈ `1e-6`). It solves the small, well-conditioned
problems quickly and exactly; on larger or poorly-conditioned problems
it honestly reports `iter-cap` with its best-effort iterate rather than
overclaiming. For tight-tolerance LP / QP, reach for the specialists.

**v0.1 scope** is the LP-complete cone subset — `NonNegCone`,
`ZeroCone`, `FreeCone` — matching `cone-core` v0.1's projection scope.

## Invariants

- **deterministic** — same input bytes → same output bytes
  (`numerical: true`, ADR-0015; bit-identical given the platform
  fingerprint).
- **primal-feasibility** — `optimal` ⟹ `A·x = b`, `x ∈ 𝒦` within
  `achieved_precision`.
- **dual-feasibility** — `optimal` ⟹ `Aᵀy + slack = c`, `slack ∈ 𝒦*`.
- **complementary-slackness** — `optimal` ⟹ `|xᵀ·slack|` small.
- **strong-duality** — `optimal` ⟹ `cᵀx = bᵀy` within tolerance.
- **honest-precision** — `achieved_precision` never under-claims the
  true max relative KKT residual.
- **optimal-precision-coherence** — `optimal` ⟹ `achieved_precision ≤
  precision`, structurally: the `convergenceTest` handed to `scsSolve`
  *is* the §C-wire-form test, so the solver never declares `optimal`
  short of the wire contract (bead `oxuk`).
- **scope-honest-refusal** — an out-of-scope cone family returns a
  tagged envelope, never a wrong-shaped answer.

## Run

```sh
echo '{"minimize":{"c":[...]},"subjectTo":{"Ax_eq_b":{"A":[[...]],"b":[...]},"cones":[...]}}' \
  | bun tools/cone-solve/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
