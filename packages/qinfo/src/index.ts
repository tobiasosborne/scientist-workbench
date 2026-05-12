// =============================================================================
// @workbench/qinfo — quantum-information substrate
// =============================================================================
//
// Index-only ops (kron, partialTrace, partialTranspose, vec/unvec, choi) are
// pure index manipulation on row-major Float64Array storage. They support
// real and complex matrices uniformly via a single `Matrix` type with an
// optional `im` field. They do NOT route through linalg-eigh — so they
// neither inherit the real-only restriction nor compose other workbench
// tools internally; they're pure JS-side numerics.
//
// Eigh-routed ops (traceNorm, traceDistance, fidelity, purity) are deferred
// to v0.2 when complex-Hermitian linalg lands (bead `ov4j`). The substrate
// is currently the four index-only operations plus their dim/matrix helpers.
//
// ADR-0034 is the design rationale. The first user is the dogfood prototype
// `temp/qwasserstein.ts`, which lifted v0.1 needs from a 50-LOC pile of
// boilerplate per session.

// Matrix substrate + helpers
export type { Matrix } from "./matrix.js";
export {
  MatrixError,
  zeros,
  zerosComplex,
  eye,
  fromNested,
  fromNestedComplex,
  fromRowMajor,
  isReal,
  toNested,
  toNestedComplex,
  clone,
  transpose,
  adjoint,
  trace,
  matmul,
  scale,
  add,
  sub,
  maxAbsDiff,
} from "./matrix.js";

// Dim arithmetic helpers
export type { Dims } from "./dims.js";
export {
  dimProduct,
  strides,
  decomposeIndex,
  composeIndex,
  normaliseSubsystems,
} from "./dims.js";

// Index-only operations
export { kron, kron2 } from "./kron.js";
export { partialTrace, partialTracePure } from "./partial-trace.js";
export { partialTranspose } from "./partial-transpose.js";
export { vec, unvec, choi, deChoi } from "./choi.js";
