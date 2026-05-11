# @workbench/solver-ipm

Pure-TypeScript primal-dual interior-point method (Mehrotra 1992
predictor-corrector) for LP (NonNeg cone) and SDP (PSD cone,
Nesterov-Todd scaling).

## Algorithms

- **LP:** Mehrotra predictor-corrector primal-dual IPM. Per-iteration
  Schur-complement Cholesky on `M = A · diag(x/s) · Aᵀ` with three-
  tier Tikhonov regularization (primal / dual / gap). Mehrotra
  safeguard step `min(max(0.95α, 2α−1), 0.999999)`. Six-flag
  convergence test (relative + absolute primal feasibility, dual
  feasibility, optimality gap).
- **SDP:** Same skeleton, three search directions implemented:
  - **NT** (`solveSdpNt`, primary export, Todd-Toh-Tütüncü 1998):
    Nesterov-Todd scaling, equivalent to the SDPT3 v4 NTrhsfun /
    NTdirfun / NTscaling kernels.
  - **AHO** (`solveSdpAho`, A/B reference, Alizadeh-Haeberly-Overton
    1997): Lyapunov-equation-based symmetrisation, used as a
    convergence cross-check.
  - **HKM** (`solveSdpHkm`, debug-only, Helmberg-Kojima-Monteiro
    1996): kept for direction-comparison studies; not the production
    path.

The package is **substrate only** — no workbench tool wire shape. The
LP path is consumed by `tools/lp-solve`'s `--method=ipm` lane (see
ADR-0032); the SDP path is reserved for a future `tools/sdp-solve`
tool (ADR-0030 §B).

## Dependencies

- `@workbench/linalg-core` — used implicitly via the shared
  `Float64Array` numerics conventions. Cholesky is hand-rolled
  here (the LP path needs a specific normal-equations factor with
  in-place jitter retry).
- No FFI. No Python. No external linear-algebra binding.

## References

- Mehrotra, S. (1992). *On the implementation of a primal-dual
  interior point method.* SIAM J. Optim. 2(4).
- Todd, M. J., Toh, K. C., & Tütüncü, R. H. (1998). *On the
  Nesterov-Todd direction in semidefinite programming.* SIAM J.
  Optim. 8(3).
- Alizadeh, F., Haeberly, J.-P. A., & Overton, M. L. (1997).
  *Complementarity and nondegeneracy in semidefinite programming.*
  Math. Program. 77.
- Helmberg, C., Rendl, F., Vanderbei, R. J., & Wolkowicz, H.
  (1996). *An interior-point method for semidefinite programming.*
  SIAM J. Optim. 6(2).
- Wright, S. J. (1997). *Primal-Dual Interior-Point Methods.* SIAM.

## Status

LP path: 21/21 NETLIB acceptance with the corpus's triple-witness
oracle (Gurobi-Mosek consensus). SDP path: NT direction passes
the bundled smoke test and 6 synthetic min-eigenvalue / max-cut
relaxation problems. Known algorithm-hygiene gaps tracked in bead
`j1gd` (σ-clip, stall threshold, DIMACS error vector, Ruiz
equilibration).
