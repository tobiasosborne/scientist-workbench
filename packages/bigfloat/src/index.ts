// =============================================================================
// @workbench/bigfloat — arbitrary-precision binary floating point
// =============================================================================
//
// The first arb-prec substrate in scientist-workbench. ADR-0020 is the
// design rationale; tstournament problem-13 (the Meijer G mega-test) is
// the workload forcing it.
//
// Substrate target
// ----------------
// Pure TypeScript on `BigInt`. No FFI; no subprocess; no platform-conditional
// behaviour anywhere in the substrate. `BigInt` arithmetic is bit-identical
// across every JavaScript runtime by language specification, so every
// operation in this package is bit-deterministic — `arbprec: true` (ADR-0020)
// for any tool built on top.
//
// Public surface (the agent-irresistible answer to "compute this to N
// decimal digits"):
//
//   import { fromString, exp, log, gamma, toString } from "@workbench/bigfloat";
//
//   // 50 bits of binary precision is ~15 decimal digits; for 50 decimal
//   // digits use `decimalToBinaryPrecision(50)` ≈ 196.
//   const prec = decimalToBinaryPrecision(50);
//   const a = fromString("0.5", prec);
//   const r = gamma(a, prec);              // Γ(1/2) = √π
//   console.log(toString(r, 50));
//   // → "1.7724538509055160272981674833411451827975494561223873"
//
// Per-value precision (MPFR semantics): every operation takes `prec` as an
// explicit argument and rounds the result to that precision. mpmath-style
// ambient precision (`mp.prec`) was deliberately rejected; see ADR-0020 §"Why
// these choices".

export {
  type BigFloat,
  BigFloatInvariantError,
  bitLength,
  normalise,
  validate,
  decimalToBinaryPrecision,
} from "./types.js";

export {
  sgn,
  abs,
  neg,
  cmp,
  eq,
  lt,
  le,
  gt,
  ge,
  isZero,
} from "./comparison.js";

export {
  fromInt,
  fromFloat64,
  fromString,
  toFloat64,
  toString,
} from "./conversion.js";

export {
  add,
  sub,
  mul,
  div,
  sqrt,
  powInt,
} from "./arithmetic.js";

export { bernoulliRational } from "./bernoulli.js";

export {
  BIGFLOAT_TAG,
  BIGCOMPLEX_TAG,
  bigfloatToValue,
  valueToBigFloat,
  bigcomplexToValue,
  valueToBigComplex,
  bigfloatSchema,
  bigcomplexSchema,
} from "./encoding.js";

export {
  type BigComplex,
  cfromReal,
  cfromInts,
  cfromStrings,
  cre,
  cim,
  cconj,
  cisZero,
  cadd,
  csub,
  cmul,
  cdiv,
  cneg,
  cabs,
  carg,
  csqrt,
  cexp,
  clog,
  cpow,
  clgamma,
  cgamma,
  cdigamma,
  bigW,
  bigCErf,
  bigCErfc,
  bigCErfcx,
  bigCErfi,
} from "./complex.js";

export {
  gamma,
  lgamma,
  digamma,
  trigamma,
  polygamma,
} from "./special.js";

export {
  bigErf,
  bigErfc,
  bigErfcx,
} from "./special-funcs/erf.js";

export {
  bigBesselJ,
  bigBesselJSeriesMaclaurin,
  bigBesselJHankelAsymptotic,
  bigBesselJSeriesCancellationRetry,
} from "./special-funcs/besselj.js";

export {
  ln2,
  pi,
  e,
  exp,
  log,
  expm1,
  log1p,
  atanSmall,
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  atan2,
  sinh,
  cosh,
  tanh,
  asinh,
  acosh,
  atanh,
  pow,
} from "./transcendental.js";
