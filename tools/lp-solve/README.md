# lp-solve

Linear-programming specialist of the cone-solver tier
([ADR-0030](../../docs/adr/0030-convex-cone-solver-tier.md)). v0.1
implementation: exact-rational engine wrapped in the float64 wire schema
([ADR-0031](../../docs/adr/0031-lp-solve-arbprec-engine.md)).

The killer claim. A TS expert who types

```ts
const result = (await wb.run("lp-solve", problem)).output;
```

on a small dense LP gets back `result.achieved_precision ≈ 2.2 × 10⁻¹⁶`
— one IEEE-754 ULP, four orders of magnitude past ADR-0030's 1e-12
accuracy ceiling. The interior of the tool runs the simplex method
exactly over ℚ via `@workbench/simplex-q`; the only rounding is the
wire encode/decode. No other LP solver in any ecosystem ships this:
QSopt-Ex is C-with-GMP and not on the Bun substrate; Gurobi, Mosek,
HiGHS, GLPK, CLP all run float internally and chase precision via
iterative refinement.

## Wire schema

Input and output verbatim from [ADR-0030 §C, §D](../../docs/adr/0030-convex-cone-solver-tier.md).
Cones in v0.1 are `NonNegCone` only; non-LP cones get
`tagged "lp-solve/non-lp-cone"`.

```ts
// Input
record {
  minimize:  record { c: list<float64>, Q?: list<list<float64>> },
  subjectTo: record {
    Ax_eq_b?: record { A: list<list<float64>>, b: list<float64> },
    cones:    list<expression>
  },
  precision?: float64,
  max_iter?:  integer
}

// Output (success)
record {
  status: "optimal" | "infeasible" | "unbounded" | "iter-cap" | "numerical-breakdown",
  x:      list<float64>,    // primal (or unbounded ray when status="unbounded")
  dual:   list<float64>,    // dual (Farkas cert when status="infeasible")
  slack:  list<float64>,
  objective?:          float64,    // present only when status="optimal"
  achieved_precision?: float64,    // present only when status="optimal"
  iterations:         integer,
  method:             string,      // "simplex-q"
  condition_estimate: float64,
  warnings:           list<string>
}
```

## Refusal envelopes

`tagged "lp-solve/<class>"` per ADR-0003:

| class | meaning |
|---|---|
| `non-finite-input` | NaN/±Inf in `c`, `A`, or `b` |
| `degenerate-shape` | dimension mismatch between `c`, `A`'s rows, `b` |
| `non-lp-cone` | a cone other than `NonNegCone` (use `cone-solve`) |
| `malformed-cone` | `NonNegCone` indices out of range, or structurally bad |
| `quadratic-objective` | `minimize.Q` present (use `qp-solve` or `cone-solve`) |
| `coefficient-explosion` | rational basis-inverse bit length exceeded the cap |

## Status taxonomy mapping

The engine's native taxonomy maps onto ADR-0030's public one:

| engine | wire | `objective` + `achieved_precision` |
|---|---|---|
| `optimal` | `"optimal"` | present |
| `infeasible` | `"infeasible"` | absent (Inf invalid in JSON) |
| `unbounded` | `"unbounded"` | absent (Inf invalid in JSON) |
| `iter-cap` | `"iter-cap"` | absent |
| `coefficient-explosion` | `tagged "lp-solve/coefficient-explosion"` | n/a |

`"numerical-breakdown"` is in the public taxonomy but the arbprec
engine never emits it. The class is reserved for the float lane
(`tools/lp-solve-fast`, bead `hnyu`).

## Known scope and limits

v0.1 is **for small dense LPs** — the regime the workbench's PRD §1.2
named as the target. Concrete numbers from the 2026-05-11 bench grade
on the `lp-small` corpus suite (29 cases):

- **n ≤ 25**: passes all KKT checks bit-exact, sub-second wall time.
- **n = 30–50**: solvable but slow; coefficient growth starts to bite.
- **n ≥ 50**: typically times out at the 30-second bench cap. The
  rational coefficients in the basis inverse grow by Cramer's-rule
  bounds; the cubic-per-pivot O(m²) update over m-bit BigInts becomes
  the bottleneck.

For n ≥ 50 the future float lane (`tools/lp-solve-fast`, bead
`hnyu`) is the path. v0.1 of this tool is the
**bulletproof-small-case anchor of the LP portfolio**, not a
production-scale solver.

NETLIB cases (n ranging 51–1500) sit above the v0.1 scale ceiling.
v0.1 grades 24/29 on `lp-small` (the small-by-design corpus) and 0 on
`lp-netlib` (most cases time out). When `tools/lp-solve-fast` lands
the workbench's bandit dispatcher will route NETLIB-scale problems to
the float lane.

## Determinism

`numerical: true` (ADR-0015). Bit-identical given platform fingerprint.
The *interior* of the tool is arbprec-strength (`Rat` arithmetic over
BigInt is bit-identical across all runtimes), but the wire encode is
float64. Cross-platform divergence is recorded in the provenance
record's `platform` field.

## Pointers

- [ADR-0031](../../docs/adr/0031-lp-solve-arbprec-engine.md) — the
  design choice and the rationale.
- [ADR-0030](../../docs/adr/0030-convex-cone-solver-tier.md) — the
  cone-solver tier this slots into.
- [`packages/simplex-q/`](../../packages/simplex-q/) — the engine.
- worklog 090 — the build narrative, frictions, and bench grade.
