# lp-solve

Linear-programming specialist of the cone-solver tier
([ADR-0030](../../docs/adr/0030-convex-cone-solver-tier.md)). Two
internal lanes share one public wire:

- **`--method=exact`** — arbitrary-precision rational engine via
  `@workbench/simplex-q` ([ADR-0031](../../docs/adr/0031-lp-solve-arbprec-engine.md)).
  Bit-identical cross-platform forever. Achieves
  `achieved_precision ≈ 2.2 × 10⁻¹⁶` (one IEEE-754 ULP) on small
  dense LPs — four orders past ADR-0030's 1e-12 ceiling. World-first
  in TypeScript.
- **`--method=ipm`** — Mehrotra 1992 predictor-corrector primal-dual
  interior-point method via `@workbench/solver-ipm`. Float64 internals;
  scales to NETLIB (m, n ≈ 100–2000) in seconds. `numerical: true`
  with platform fingerprint.
- **`--method=auto`** (default) — dispatch by problem size. Small
  problems (`m + n ≤ 50`) go to exact for the bit-identical answer;
  larger problems go to IPM for the scaling. The `method` field of
  the output record reports which lane actually ran.

The killer claim of the exact lane stands on its own: no other LP
solver in any ecosystem ships exact-rational primary computation over
the float64 wire. QSopt-Ex is C-with-GMP and not on the Bun substrate;
Gurobi, Mosek, HiGHS, GLPK, CLP all run float internally and chase
precision via iterative refinement.

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
  method:             string,      // "simplex-q" (exact lane) | "solver-ipm" (IPM lane)
  condition_estimate: float64,
  warnings:           list<string>
}
```

## Flags

| flag | values | meaning |
|---|---|---|
| `--method` | `auto` (default), `exact`, `ipm` | Force a specific lane, or let the size-based auto-dispatch choose. |

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

`"numerical-breakdown"` is emitted only by the IPM lane (Cholesky
factorisation failure after the 3-tier Tikhonov retry exhausts).
The exact lane never emits it — arbitrary-precision rational
arithmetic does not break down numerically.

## Lane characteristics

**Exact lane (`@workbench/simplex-q`):**
- Algorithm: two-phase revised simplex over ℚ, Bland-rule anti-cycling.
- Sweet spot: `m + n ≤ ~50`, sub-second.
- Coefficients grow by Cramer's-rule bounds; the O(m²) per-pivot update
  over m-bit BigInts becomes the bottleneck near `m = 50`.
- Grades 24/29 on `lp-small` (2026-05-11); 0 on `lp-netlib`
  (most cases time out at the 30s bench cap).
- Bit-identical cross-platform forever.

**IPM lane (`@workbench/solver-ipm`):**
- Algorithm: Mehrotra 1992 predictor-corrector with 3-tier Tikhonov
  regularisation, Schur-complement Cholesky, safeguard step
  `min(max(0.95α, 2α−1), 0.999999)`. See ADR-0032.
- Sweet spot: `m + n ≥ ~100`, NETLIB scale (n up to ~2000).
- Float64 internals; per-iteration cost is O(m³) Cholesky + O(mn)
  matrix-vector multiplies.
- Tracks 21/21 NETLIB passes in the substrate package's own tests;
  bench grade as the unified `lp-solve` tool TBD.
- `numerical: true` with platform fingerprint (ADR-0015).

**Auto-dispatch:** `m + n ≤ 50` → exact; else → IPM. The threshold is
empirical, calibrated against worklog 090's measurements. A TS expert
who wants the bit-identical answer on any size forces `--method=exact`;
who wants the IPM's central-path solution on a small problem (for A/B
testing) forces `--method=ipm`.

## Determinism

`numerical: true` (ADR-0015). Bit-identical given platform fingerprint.
- Exact lane: the *interior* is arbprec-strength (`Rat` arithmetic
  over BigInt is bit-identical across all runtimes); only the wire
  encode is float64. Cross-platform divergence in the encoded wire
  is recorded in the provenance record's `platform` field.
- IPM lane: float64 throughout. Cross-platform divergence is normal
  IEEE-754 drift (recorded in the `platform` field; `runMemoized`
  skips cross-platform cache hits).

## Pointers

- [ADR-0031](../../docs/adr/0031-lp-solve-arbprec-engine.md) — the
  exact lane's design choice and rationale.
- [ADR-0030](../../docs/adr/0030-convex-cone-solver-tier.md) — the
  cone-solver tier this slots into.
- [`packages/simplex-q/`](../../packages/simplex-q/) — the exact engine.
- [`packages/solver-ipm/`](../../packages/solver-ipm/) — the IPM engine
  (Mehrotra primal-dual barrier method).
- worklog 090 — the exact-lane build narrative.
- worklog 091 — the solver-ipm substrate landing.
- worklog 092 — the lane dispatcher (this addition).
