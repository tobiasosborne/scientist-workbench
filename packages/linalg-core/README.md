# @workbench/linalg-core

Pure-TypeScript dense linear algebra on `Float64Array`. The first
numerical-tier package in scientist-workbench (ADR-0014); the
substrate behind `tools/linalg-solve`.

This is a library, not a tool — it speaks `Float64Array`, not the
canonical JSON value protocol. The wire-encoding wrapper lives in the
tool layer (`tools/linalg-solve/tool.ts`); ADR-0010's
`defineTool`/`runTool` split lets one implementation serve both
surfaces.

## Surface

```ts
import {
  matrixFromRows, matrixToRows, matIdentity, matZeros,
  matVec, vecNorm2, vecNormInf, matNorm1,
  lu, luSolve, luSolveTransposed, luDet, type LUResult,
  hagerOneNormEstimate,
  solve, solveWithLU, type SolveResult,
} from "@workbench/linalg-core";

const A = matrixFromRows([[2, 1], [1, 3]]);
const b = new Float64Array([4, 5]);
const r = solve(A, b)!;
//  r.x                  : Float64Array [7/5, 6/5]
//  r.residualNorm       : ~0
//  r.conditionEstimate  : ~3.2
//  r.growthFactor       : ~0.83
//  r.method             : "lu-partial-pivot"
//  r.iterations         : 0
```

## Algorithm

- **`lu` / `luInPlace`**: LU factorisation with partial pivoting
  (Doolittle, in-place packed L+U storage, integer permutation
  vector). Tracks Wilkinson's growth factor for honest-scope
  reporting.
- **`luSolve` / `luSolveTransposed`**: forward + back substitution
  on the LU and its transpose. Used by both `solve` and the Hager
  estimator.
- **`hagerOneNormEstimate`**: classical Hager (1984) iterative
  estimator for `||A^{-1}||_1` from a precomputed LU. ~4 LU-solves;
  typically within 2–3× of the true value (Higham §15.3).
- **`solve`**: high-level entry point. LU → `luSolve` → optional
  one-step iterative refinement (when residual exceeds `4 n eps`) →
  Hager condition estimate. Returns the `SolveResult` record above
  or `null` if A is exactly singular.

References: Higham, *Accuracy and Stability of Numerical Algorithms*,
2nd ed., SIAM 2002 (Ch. 9, Algorithm 14.4); Trefethen & Bau,
*Numerical Linear Algebra*, SIAM 1997 (Lectures 20–22).

## Scope

- **In:** square dense systems, `Float64Array` storage, single-platform
  determinism (Bun on x86-64 Linux).
- **Out (v0.1, all deliberate):** QR / SVD / eigendecomposition (bead
  71f), iterative methods (CG, GMRES), sparse matrices, complex /
  algebraic-number element types, cross-platform bit-identity (will
  be tiered by ADR-0015 / bead 0ck), FFI BLAS bridge (bead e7y).

## Tests

```sh
bun test packages/linalg-core/test/linalg-core.test.ts
```

33 tests across constructors, basic ops, LU reconstruction (`P A = L
U` on 30 random 5×5 matrices), triangular solves, Hager (Hilbert-3
condition within 1× and Hilbert-4 > Hilbert-3), end-to-end solve on
identity / hand-checked / permutation / Hilbert / Wilkinson-growth
cases. Mutation-proven: skip-pivoting fails the pivot test; see
ADR-0014 §"Forcing-questions".
