# sdp-solve

Semidefinite-programming specialist of the cone-solver tier (ADR-0030 §B). Wraps the Mehrotra primal-dual interior-point method from `@workbench/solver-ipm` with three search-direction lanes: Nesterov-Todd (default, primary), Alizadeh-Haeberly-Overton (A/B reference), and Helmberg-Kojima-Monteiro (debug-only).

## Worked example — 2×2 SDP

`min -tr(X)  s.t.  tr(X) = 4,  X ⪰ 0` — optimum value −4.

```sh
echo '{
  "fields": {
    "minimize":  {"fields": {"c":{"items":[{"bits":"bff0000000000000","kind":"float64"},{"bits":"0000000000000000","kind":"float64"},{"bits":"bff0000000000000","kind":"float64"}],"kind":"list"}},"kind":"record"},
    "subjectTo": {"fields": {
      "Ax_eq_b": {"fields": {
        "A": {"items":[{"items":[{"bits":"3ff0000000000000","kind":"float64"},{"bits":"0000000000000000","kind":"float64"},{"bits":"3ff0000000000000","kind":"float64"}],"kind":"list"}],"kind":"list"},
        "b": {"items":[{"bits":"4010000000000000","kind":"float64"}],"kind":"list"}
      },"kind":"record"},
      "cones":   {"items":[{"args":[{"kind":"integer","value":"2"},{"items":[{"kind":"integer","value":"0"},{"kind":"integer","value":"1"},{"kind":"integer","value":"2"}],"kind":"list"}],"head":"PSDCone","kind":"expression"}],"kind":"list"}
    },"kind":"record"}
  },
  "kind": "record"
}' | bun tools/sdp-solve/tool.ts
```

The output reports `status: "optimal"`, `objective ≈ -4`, `x ≈ (2, 0, 2)` — the svec of `X = diag(2, 2)`.

The TS-expert call site is in-process via `@workbench/compose`:

```ts
import { loadWorkbench } from "@workbench/compose";
const wb = await loadWorkbench();
const result = await wb.run("sdp-solve", problem);
```

## Input

Per ADR-0030 §C — the unified cone-solver wire shared with `tools/lp-solve` and (eventually) `tools/cone-solve`:

```jsonc
record {
  minimize:  record { c: list<float64> },
  subjectTo: record {
    Ax_eq_b?: record { A: list<list<float64>>, b: list<float64> },
    cones:    list<expression>            // PSDCone[size, indices] entries
  },
  precision?: float64,                    // default 1e-8
  max_iter?:  integer                     // default 500
}
```

`x` is a single n-vector. Each `PSDCone[size, indices]` declares that the slice `x[indices]` is the **svec** (symmetric vectorisation) of an `size × size` PSD matrix.

### svec convention (Mosek format with √2 off-diagonal scaling)

For a symmetric `n × n` matrix `M`:

```
svec(M)[k(0,0)] = M[0,0]
svec(M)[k(0,1)] = √2 · M[0,1]
svec(M)[k(0,2)] = √2 · M[0,2]
...
svec(M)[k(1,1)] = M[1,1]
svec(M)[k(1,2)] = √2 · M[1,2]
...
```

Position ordering is **row-major upper-triangular**: `(0,0), (0,1), …, (0,n-1), (1,1), (1,2), …, (n-1,n-1)`. Length is `n*(n+1)/2`.

The √2 scaling makes the Frobenius inner product trivial: `<C, X>_F = svec(C)ᵀ svec(X)`. Without the scaling, off-diagonals would double-count (because `M[i,j] = M[j,i]` for symmetric `M`). This is the trap every amateur SDP implementer falls into; the wire avoids it by encoding the scaling at the boundary.

A `2×2` matrix `M = [[a, b], [b, c]]` thus svec'es to `(a, √2·b, c)`.

### Cone vocabulary (v0.1)

| head | args | meaning |
|---|---|---|
| `PSDCone` | `[size: integer, indices: list<integer>]` | the slice `x[indices]` is `svec(X_b)` for an `size × size` PSD matrix `X_b ⪰ 0` |
| `ZeroCone` | `[indices: list<integer>]` | each `x_j` for `j ∈ indices` forced to zero (rare; usually absorbed into `Ax_eq_b`) |

`NonNegCone`, `SOCone`, `ExpCone`, `PowCone` are explicitly **refused** (with redirects to `tools/lp-solve` or future `tools/cone-solve`). Mixed-cone problems land at `tools/cone-solve` (bead `2ivi`); v0.2 of `sdp-solve` will reformulate `NonNegCone` as a diagonal SDP block (bead `67nj`).

Every variable in `x` must be in exactly one cone; gaps and collisions refuse with a `cone-coverage` envelope.

## Output

Per ADR-0030 §D:

```jsonc
record {
  status:             "optimal" | "infeasible" | "unbounded" | "iter-cap" | "numerical-breakdown",
  x:                  list<float64>,        // primal: svec(X_b) packed into the same indices the input declared
  dual:               list<float64>,        // dual y, length m
  slack:              list<float64>,        // svec(S_b) packed identically to x
  objective?:         float64,              // present iff status == "optimal"
  achieved_precision?: float64,             // present iff status == "optimal"; max(primalInf, dualInf, mu)
  iterations:         integer,
  method:             "solver-ipm-nt" | "solver-ipm-aho" | "solver-ipm-hkm",
  condition_estimate: float64,              // 0 (not yet computed for SDP)
  warnings:           list<string>
}
```

To **recover the matrix** from the wire vector:

```ts
function unsvec(x: number[], indices: number[], size: number): number[][] {
  const M = Array.from({ length: size }, () => new Array(size).fill(0));
  let k = 0;
  for (let i = 0; i < size; i++) {
    for (let j = i; j < size; j++) {
      const v = x[indices[k++]];
      if (i === j) M[i][i] = v;
      else { M[i][j] = M[j][i] = v / Math.SQRT2; }
    }
  }
  return M;
}
```

Or, on tagged refusal:

```jsonc
tagged "sdp-solve/<class>" record { detail: string, ... }
```

with `<class>` ∈ `{non-finite-input, degenerate-shape, quadratic-objective, non-sdp-cone, malformed-cone, cone-coverage}`.

## Algorithm

Per-block Mehrotra predictor-corrector primal-dual IPM with four direction choices:

| `--method` | direction | reference | notes |
|---|---|---|---|
| `auto` (default), `hsde-nt` | HSDE + NT scaling + iterative refinement | ART03 / Andersen 2009 (Mosek); Higham 2002 §12 | the homogeneous self-dual embedding per [ADR-0033](../../docs/adr/0033-hsde-for-solver-ipm.md); τ-κ scalars detect infeasibility via the ART03 ρ-dichotomy + Mosek/And09 sign convention; iterative refinement on the regularised Schur back-sub per Phase 5 Tier 1 (worklog 110, `solveWithIR`); HSDE soft-success branch (`μ ≤ feasTol AND prstatus > 0.5 AND τ ≥ 1e-6`, mirroring legacy NT's `couldDualFeas`) returns wire `optimal` for τ-shrunk iterates at the float64 floor — agent reads `achieved_precision` for the actual purified ρ-max |
| `nt` | Nesterov-Todd (legacy, non-HSDE) | Todd-Toh-Tütüncü 1998 | kept as the legacy primal-dual NT path for A/B comparison and `scripts/trace-diff.ts` workflows; was the `auto` default pre-Tier-3 (worklog 129) |
| `aho` | Alizadeh-Haeberly-Overton | Alizadeh-Haeberly-Overton 1997 | algebraically clean (Lyapunov solve); A/B reference |
| `hkm-debug` | Helmberg-Kojima-Monteiro | Helmberg-Kojima-Monteiro 1996 | asymmetric; gated for diagnostic comparison only |

The substrate is `@workbench/solver-ipm` (ADR-0032). Convergence is gated by `feasTol = optTol = precision`; the `precision` flag default is `1e-8`. Termination at `iter >= max_iter` returns `status: "iter-cap"` with the best-effort iterate; `numerical-breakdown` covers Cholesky failure on the Schur complement, eigen-decomposition stall, or step-length collapse.

**Bench grade** (`scientist-workbench-corpus benchmarks/sdp-sdplib`, default tol): 5/6 cases, 64/66 invariants. The 4 well-conditioned cases (`control1`, `control2`, `theta1`, `mcp100`) reach strict `optimal`; `control3` lands as soft-`optimal` via the HSDE soft-success branch; `hinf2` passes 8/10 invariants — the remaining 2 (`primal_feasibility`, `complementary_slackness`) are the float64 representation limit of `r_p / τ` purification (worklog 128's τ-shrinkage diagnosis). The 6/6 case-count is a Phase 6 (bigfloat HSDE) gate, separate ADR per ADR-0033 Decision 9.

The 1×1 PSD case is well-defined and reduces to a scalar primal-dual barrier — used internally to encode `ZeroCone` constraints.

## Invariants (machine-checkable)

- **primal-feasibility**: `<A_i, X> = b_i` for every `i` within `achieved_precision` (X reconstructed from `x[indices]` via inverse svec).
- **dual-feasibility**: `S = C - Σ_i y_i A_i` with `S ⪰ 0` within `achieved_precision`.
- **primal-psd**: every block `X_b ⪰ 0` within `achieved_precision`.
- **dual-psd**: every block `S_b ⪰ 0` within `achieved_precision`.
- **complementary-slackness**: `<X, S>_F = 0` (sum over blocks) within `achieved_precision`.
- **strong-duality**: `<C, X>_F = bᵀy` within `achieved_precision`.
- **svec-frobenius-identity**: `<C, X>_F = svec(C) · svec(X)` (the wire's design invariant).

## Determinism

`numerical: true` (ADR-0015) — bit-identical given the platform fingerprint `{arch, os, runtime}`. Cross-platform divergence is recorded in the provenance `platform` field; `runMemoized` cache hits drop on platform change.

```sh
bun tools/sdp-solve/tool.ts --platform-fingerprint
```

## Run

```sh
echo '<canonical input>' | bun tools/sdp-solve/tool.ts
echo '<input>' | bun tools/sdp-solve/tool.ts --method=aho      # A/B with AHO direction
echo '<input>' | bun tools/sdp-solve/tool.ts --precision=1e-10 # tighter tolerance
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`

## Bench

The brutal-and-punishing graded bench (Mosek + COPT dual-witness) lives in the sister corpus repo: `scientist-workbench-corpus/benchmarks/sdp-sdplib/` (Phase 0 of bead `tj6p`). To grade:

```sh
cd ../scientist-workbench-corpus
~/.bun/bin/bun src/cli.ts grade scientist-workbench sdp-sdplib
```

## References

- Tütüncü, R. H., Toh, K. C., & Todd, M. J. (2003). "Solving SDP/QP/LP via SDPT3." *Math Prog Ser B*. — the canonical reference for the v4-onwards SDPT3 architecture, including the NT direction default.
- Todd, M. J., Toh, K. C., & Tütüncü, R. H. (1998). "On the Nesterov-Todd direction in SDP." *SIAM J Opt* 8(3).
- Alizadeh, F., Haeberly, J.-P. A., & Overton, M. L. (1997). "Complementarity and nondegeneracy in SDP." *Math Prog* 77.
- Helmberg, C., Kojima, M., & Monteiro, R. D. C. (1996). "An interior-point method for SDP." *SIAM J Opt* 6(2).
- Mehrotra, S. (1992). "On the implementation of a primal-dual interior-point method." *SIAM J Opt* 2(4).
- Wright, S. J. (1997). *Primal-Dual Interior-Point Methods*. SIAM.
- Boyd, S., & Vandenberghe, L. (2004). *Convex Optimisation*, Ch. 11.
