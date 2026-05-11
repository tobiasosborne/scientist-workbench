# @workbench/copt-ipm

Pure-TypeScript port of COPT's default unified primal-dual interior-point
solver for LP (Phase A) and SDP (Phase B).

The reference is the decompiled C in `COPT-decomp/analysis/decomps/`,
analysed in `COPT-decomp/analysis/PD_IPM_DEEP.md`. The algorithm is
textbook Mehrotra predictor-corrector (1992) for LP; Nesterov–Todd
direction (Todd–Toh–Tütüncü 1998) for SDP. The Cardinal engineering this
port reproduces in TS:

- unified LP+SDP iteration loop with runtime cone-type dispatch
- 3-way adaptive Tikhonov regularization (δ_primal, δ_dual, δ_gap) with
  per-bump counters
- 6-flag / 11-status convergence test
- the exact iteration-log printf format

No FFI. No Python. No external linalg dep beyond `@workbench/linalg-core`
(LU/QR/SVD/eigh) and a hand-rolled Cholesky added here.

## Status

Phase A (LP) under construction.
