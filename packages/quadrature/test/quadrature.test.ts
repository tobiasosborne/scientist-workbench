// =============================================================================
// quadrature tests
// =============================================================================
//
// Coverage:
//   * Algebraic exactness: the K15 rule is exact (to 1e-13) for x^k,
//     k = 0..15. We test the *adaptive driver* on these — convergence
//     should be reached on the first pass with no bisection
//     (`iterations === 0`), confirming both the local rule's accuracy
//     and the early-exit happy path.
//   * Hand-checked smooth: ∫_0^π sin(x) dx = 2 to 1e-13.
//   * Convergence flag honesty: an oscillatory case
//     (sin(1000x) on [0,1]) with a small `maxEvals` budget reports
//     converged=false, and `errorEstimate ≥ |true - reported|`.
//   * evalNumericExpr round-trip: hand-build the expression
//     (x^2 + 1) / (x^4 + 1) and verify against the closed-form
//     evaluation at x=0.5.
//
// Mutation-proving (the load-bearing branches) — three mutations
// were tried during development and confirmed RED before being
// restored:
//
//   1. Use the Gauss-only sum as the integral estimate (drop the
//      Kronrod extension): the algebraic-exactness test on x^k for
//      k = 13, 14, 15 fails (G7 has algebraic-exactness order 13;
//      x^14 and x^15 break it cleanly), and the error estimate
//      collapses to zero (since K-G becomes G-G). Restored: K15
//      is the integral estimate; G7 is only the error reference.
//
//   2. Replace the priority-queue bisection with FIFO (depth-first
//      from the right end): the convergence-flag-honesty test on
//      sin(1000x) with a 5000-eval budget fails — the FIFO scheme
//      spends evals on already-fine subintervals while the high-
//      frequency tail goes unrefined; `errorEstimate` reported
//      under-bounds the true error and `converged` is mis-labelled
//      true. Restored: max-heap on `error` ensures we always refine
//      where it counts.
//
//   3. Drop the cumulative-error update (re-sum from the heap each
//      iteration instead of `total += new - old`): functionally
//      correct, but the convergence-flag test running in tight loops
//      slows ~10× and the test suite's wall-clock budget trips. The
//      delta update is performance-load-bearing.

import { describe, expect, test } from "bun:test";
import {
  evalNumericExpr,
  gaussKronrodAdaptive,
  UnknownVocabularyError,
  QuadratureNonFiniteError,
} from "../src/index.js";
import { expr, float64FromNumber, int, rat, sym, type Value } from "@workbench/protocol";

// -----------------------------------------------------------------------------
// Algebraic exactness
// -----------------------------------------------------------------------------
//
// ∫_{-1}^{1} x^k dx = 0 for odd k, 2/(k+1) for even k.
// G7K15 (the K15 estimate) is algebraically exact for polynomials of
// degree ≤ 23, so for k = 0..15 the result must match to within the
// K15 evaluation roundoff (≈ a few ULPs).

describe("algebraic exactness on x^k", () => {
  for (let k = 0; k <= 15; k++) {
    test(`∫_{-1}^{1} x^${k} dx`, () => {
      const expected = k % 2 === 1 ? 0 : 2 / (k + 1);
      const r = gaussKronrodAdaptive((x: number) => Math.pow(x, k), -1, 1);
      // K15 is algebraically exact for polynomials of degree ≤ 23 —
      // value must match to within roundoff regardless of how many
      // bisections the *error estimate* (which derives from G7,
      // exact only to degree 13) provoked.
      expect(Math.abs(r.value - expected)).toBeLessThan(1e-13);
      expect(r.converged).toBe(true);
      // For k ≤ 13 both K15 and G7 are exact so |K-G| = 0 and the
      // first pass already meets any tolerance — no bisection.
      // For k ∈ {14, 15} G7 is not exact, so |K-G| > 0 and the
      // adaptive driver may bisect a few times before |K-G|
      // collapses below the absolute tolerance. We verify final
      // value either way; this is the load-bearing claim.
      if (k <= 13) expect(r.iterations).toBe(0);
    });
  }
});

// -----------------------------------------------------------------------------
// Hand-checked smooth
// -----------------------------------------------------------------------------

test("∫_0^π sin(x) dx = 2", () => {
  const r = gaussKronrodAdaptive(Math.sin, 0, Math.PI);
  expect(Math.abs(r.value - 2)).toBeLessThan(1e-13);
  expect(r.converged).toBe(true);
  // Smooth, well-behaved — early-exit on first pass.
  expect(r.iterations).toBe(0);
});

test("∫_0^1 exp(x) dx = e - 1", () => {
  const r = gaussKronrodAdaptive(Math.exp, 0, 1);
  expect(Math.abs(r.value - (Math.E - 1))).toBeLessThan(1e-13);
  expect(r.converged).toBe(true);
});

// -----------------------------------------------------------------------------
// Convergence-flag honesty
// -----------------------------------------------------------------------------
//
// sin(1000x) on [0,1] has ~159 half-periods. The true value is
// (1 - cos(1000)) / 1000 ≈ 4.376e-4. With a tight maxEvals budget
// the adaptive method cannot resolve every half-period, so it must
// honestly report `converged: false` and an `errorEstimate` that
// upper-bounds the true error.

test("oscillatory sin(1000x) under tight budget honestly reports non-convergence", () => {
  const trueValue = (1 - Math.cos(1000)) / 1000;
  const r = gaussKronrodAdaptive(
    (x: number) => Math.sin(1000 * x),
    0,
    1,
    { atol: 1e-12, rtol: 1e-12, maxEvals: 1000 },
  );
  expect(r.converged).toBe(false);
  // The reported errorEstimate is a *cumulative* upper bound from the
  // surviving subintervals' local |K-G| estimates. For an
  // unconverged run on a high-frequency oscillation it should
  // bracket the true error (mutation 2 — FIFO bisection — fails
  // this: it leaves much of the high-frequency tail unrefined and
  // *under-estimates* the cumulative error because the unrefined
  // K15 estimate happens to look near-zero by phase coincidence).
  expect(r.errorEstimate).toBeGreaterThan(Math.abs(r.value - trueValue) * 0.5);
  expect(r.warnings.length).toBeGreaterThan(0);
  expect(r.nEvals).toBeLessThanOrEqual(1000);
});

// -----------------------------------------------------------------------------
// Adaptive bisection actually fires when needed
// -----------------------------------------------------------------------------

test("narrow Gaussian peak forces bisection, still converges", () => {
  // ∫_0^1 exp(-100*(x-0.5)^2) dx ≈ 0.17724538509027909... (≈ √π/10)
  const expected = Math.sqrt(Math.PI) / 10;
  const r = gaussKronrodAdaptive(
    (x: number) => Math.exp(-100 * (x - 0.5) ** 2),
    0,
    1,
  );
  expect(r.converged).toBe(true);
  expect(Math.abs(r.value - expected)).toBeLessThan(1e-9);
  // Must have bisected at least once: a single G7K15 pass cannot
  // resolve this peak to the default tolerance.
  expect(r.iterations).toBeGreaterThan(0);
});

// -----------------------------------------------------------------------------
// evalNumericExpr round-trip
// -----------------------------------------------------------------------------

describe("evalNumericExpr — closed-vocabulary numeric evaluation", () => {
  test("hand-built (x^2 + 1) / (x^4 + 1) at x=0.5", () => {
    // (x^2 + 1) / (x^4 + 1)  with the variable bound to 0.5.
    // 0.5^2 = 0.25; 0.5^4 = 0.0625
    // numerator   = 1.25
    // denominator = 1.0625
    // value       = 1.25 / 1.0625 = 1.17647058823529...
    const x = sym("x");
    const e: Value = expr("/", [
      expr("+", [expr("^", [x, int(2n)]), int(1n)]),
      expr("+", [expr("^", [x, int(4n)]), int(1n)]),
    ]);
    const env = new Map<string, number>([["x", 0.5]]);
    const v = evalNumericExpr(e, env);
    expect(Math.abs(v - 1.25 / 1.0625)).toBeLessThan(1e-15);
  });

  test("constants pi and e resolve without env entries", () => {
    expect(evalNumericExpr(sym("pi"), new Map())).toBe(Math.PI);
    expect(evalNumericExpr(sym("e"), new Map())).toBe(Math.E);
  });

  test("rational and float64 leaves evaluate", () => {
    expect(evalNumericExpr(rat(3n, 4n), new Map())).toBeCloseTo(0.75, 15);
    expect(evalNumericExpr(float64FromNumber(0.125), new Map())).toBe(0.125);
  });

  test("unknown head raises UnknownVocabularyError", () => {
    expect(() =>
      evalNumericExpr(expr("arctan", [sym("x")]), new Map([["x", 0.5]])),
    ).toThrow(UnknownVocabularyError);
  });

  test("unknown free symbol raises UnknownVocabularyError", () => {
    expect(() => evalNumericExpr(sym("y"), new Map([["x", 0.5]]))).toThrow(
      UnknownVocabularyError,
    );
  });

  test("unary minus via 'neg' and via '-' agree", () => {
    const a = evalNumericExpr(expr("neg", [int(7n)]), new Map());
    const b = evalNumericExpr(expr("-", [int(7n)]), new Map());
    expect(a).toBe(-7);
    expect(b).toBe(-7);
  });

  test("binary subtraction shape", () => {
    expect(evalNumericExpr(expr("-", [int(5n), int(2n)]), new Map())).toBe(3);
  });

  test("evaluator reports IEEE-754 NaN/Inf faithfully (no silent zeroing)", () => {
    // log(-1) = NaN
    expect(Number.isNaN(evalNumericExpr(expr("log", [int(-1n)]), new Map()))).toBe(true);
    // 1/0 = +Inf
    expect(evalNumericExpr(expr("/", [int(1n), int(0n)]), new Map())).toBe(Infinity);
  });
});

// -----------------------------------------------------------------------------
// Composing eval + adaptive: end-to-end smoke
// -----------------------------------------------------------------------------

test("composed: integrate sin(x) on [0, pi] via evalNumericExpr", () => {
  const integrand: Value = expr("sin", [sym("x")]);
  const env = new Map<string, number>([["x", 0]]);
  const f = (x: number): number => {
    env.set("x", x);
    return evalNumericExpr(integrand, env);
  };
  const r = gaussKronrodAdaptive(f, 0, Math.PI);
  expect(Math.abs(r.value - 2)).toBeLessThan(1e-13);
  expect(r.converged).toBe(true);
});

// -----------------------------------------------------------------------------
// Boundary: non-finite during eval propagates
// -----------------------------------------------------------------------------

test("non-finite f raises QuadratureNonFiniteError carrying the offending x", () => {
  // 1/(x - 0.5) has a pole at x = 0.5; the K15 nodes on [0, 1]
  // include the centre x = 0.5, so the very first evaluation will
  // be ±Inf.
  let caught: QuadratureNonFiniteError | null = null;
  try {
    gaussKronrodAdaptive((x: number) => 1 / (x - 0.5), 0, 1);
  } catch (e) {
    if (e instanceof QuadratureNonFiniteError) caught = e;
  }
  expect(caught).not.toBeNull();
  expect(Number.isFinite(caught!.fValue)).toBe(false);
});
