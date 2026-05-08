// =============================================================================
// @workbench/hypergeometric — generalised hypergeometric pFq, pure surface
// =============================================================================
//
// The algorithmic core extracted from `tools/hypergeometric-pfq/tool.ts`.
// The tool is now a thin wire-protocol wrapper around `evaluatePFq`. This
// package is the in-process surface that any other library can compose.
//
// The motivating composer is `@workbench/meijer-core`: the Slater
// residue-summation path needs to evaluate `pFq` once per b-line residue
// (often dozens of times per Meijer-G call), and round-tripping through
// the value protocol on every call would be needless overhead. Every
// internal call lands here directly.
//
// What this exposes
// -----------------
//
//   * `evaluatePFq(a, b, z, precision, opts?)`
//       The full evaluator. Returns either a successful `PFqResult` or a
//       structured `PFqRefusal` (non-convergent / parameter-pole). Closed-
//       form fast paths for `0F0(z) = exp(z)` and `1F0(a; ; z) = (1-z)^{-a}`
//       run before the generic series; in their absence the direct power
//       series with cancellation detection takes over.
//
//   * `pFqDirectSeries(a, b, z, workPrec, targetPrec, ...)`
//       The inner loop, exposed for callers that already know the working
//       precision they want and need to sweep it themselves (the Slater
//       path's outer cancellation control is one such caller).
//
//   * `PFqResult` / `PFqRefusal` / `ParameterPoleError`
//       Result and error shapes, ready to be re-wrapped by either the wire
//       protocol (the tool) or a higher-level numerical kernel.
//
// Numerical contract
// ------------------
// All computation runs on `BigComplex` from `@workbench/bigfloat`. The
// substrate is bit-identical across runtimes (ECMAScript guarantees BigInt
// arithmetic is bit-deterministic), which is what makes any tool that calls
// this package eligible for the `arbprec: true` tier (ADR-0020). The package
// itself takes no opinion on the wire encoding — it accepts and returns
// `BigComplex` directly.
//
// Cancellation detection. The direct series sums terms whose magnitudes can
// alternate; if the running sum's magnitude falls many bits below the
// largest term seen, those bits have been lost to inter-term cancellation
// rather than to the desired summand. The evaluator tracks
// `max_k log2 |term_k|` against `log2 |sum|` and re-runs at higher working
// precision when the gap exceeds the safety margin.
//
// Convergence regions (v0.1)
// --------------------------
// * `p ≤ q`     — series converges for all finite `z`.
// * `p == q+1`  — radius of convergence 1; we accept `|z| < 0.95` and
//                 refuse closer to the boundary (analytic continuation
//                 via Pfaff/Euler transforms is a future addition).
// * `p > q+1`   — series is asymptotic only; refused with a structured
//                 reason (Borel resummation is a future addition).
//
// Coalescence. The series itself does not handle parameter coalescence
// (any `b_j` exactly a non-positive integer; or perturbative near-poles
// where two `b_j` differ by an integer). The Slater layer handles that
// at its own scope via Johansson `hmag` perturbation; this package only
// surfaces the structured `parameter-pole` refusal when it hits an exact
// non-positive integer in the inner loop.

export {
  type BigComplex,
} from "@workbench/bigfloat";

export {
  type PFqOptions,
  type PFqSuccess,
  type PFqRefusal,
  type PFqResult,
  ParameterPoleError,
  evaluatePFq,
  pFqDirectSeries,
  cmagBits,
} from "./pfq.js";
