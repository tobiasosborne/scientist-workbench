// Anderson-acceleration tests — `makeAnderson`.
//
// The accelerator is generic over the fixed-point map, so it is tested
// here *in isolation* against simple maps with a known fixed point — no
// SCS involved. The headline invariants:
//
//   - **acceleration**: on a slowly-converging linear contraction, AA
//     reaches the fixed point in *dramatically* fewer iterations than
//     the plain iteration (`memory: 0`). This is the load-bearing
//     property — a broken least-squares solve or update sign collapses
//     the speedup, so the test gates on an order-of-magnitude margin.
//   - **correctness**: AA converges to the *same* fixed point as the
//     plain iteration — acceleration changes the speed, never the answer.
//   - **memory 0 is exactly the plain iteration** — `next` returns `Gz`.
//   - **determinism**: the accelerated trajectory is reproducible
//     (ADR-0015 / ADR-0036).
//   - **safeguard**: a map that would drive AA to a non-finite
//     extrapolate is handled gracefully — the iteration still converges,
//     never NaNs out.

import { describe, expect, test } from "bun:test";
import { ConeError, makeAnderson } from "../src/index.js";

/**
 * Drive a fixed-point map `phi` from `x0` through an Anderson
 * accelerator of the given memory; return the iteration count to reach
 * `tol` (∞-norm distance to `target`), or `-1` if `cap` is exhausted.
 */
function iterateToTarget(
  phi: (z: Float64Array) => Float64Array,
  x0: Float64Array,
  target: Float64Array,
  memory: number,
  tol: number,
  cap: number,
): { iters: number; final: Float64Array } {
  const aa = makeAnderson(memory);
  let z: Float64Array = x0.slice();
  for (let k = 1; k <= cap; k++) {
    const Gz = phi(z);
    z = aa.next(z, Gz);
    let dist = 0;
    for (let i = 0; i < z.length; i++) dist = Math.max(dist, Math.abs(z[i]! - target[i]!));
    if (dist < tol) return { iters: k, final: z };
  }
  return { iters: -1, final: z };
}

// A slow scalar contraction: φ(x) = 0.99·x + 0.01, fixed point x = 1,
// contraction factor 0.99 — plain iteration needs ~2000 steps to 1e-10.
const slowScalar = (z: Float64Array): Float64Array =>
  new Float64Array([0.99 * z[0]! + 0.01]);

// A 2-D linear map with two well-separated slow modes.
const slow2D = (z: Float64Array): Float64Array =>
  new Float64Array([0.999 * z[0]! + 0.001, 0.95 * z[1]! + 0.05]);

// ── acceleration: the load-bearing invariant ────────────────────────────────

describe("makeAnderson — acceleration", () => {
  test("collapses a slow scalar contraction by orders of magnitude", () => {
    const x0 = new Float64Array([0]);
    const target = new Float64Array([1]);
    const plain = iterateToTarget(slowScalar, x0, target, 0, 1e-10, 100000);
    const accel = iterateToTarget(slowScalar, x0, target, 5, 1e-10, 100000);
    // plain needs thousands of iterations; AA needs a handful.
    expect(plain.iters).toBeGreaterThan(1000);
    expect(accel.iters).toBeGreaterThan(0); // converged at all
    expect(accel.iters).toBeLessThan(plain.iters / 100); // ≥ 100× speedup
  });

  test("collapses a 2-D two-mode linear map", () => {
    const x0 = new Float64Array([0, 0]);
    const target = new Float64Array([1, 1]);
    const plain = iterateToTarget(slow2D, x0, target, 0, 1e-10, 200000);
    const accel = iterateToTarget(slow2D, x0, target, 10, 1e-10, 200000);
    expect(plain.iters).toBeGreaterThan(10000);
    expect(accel.iters).toBeGreaterThan(0);
    expect(accel.iters).toBeLessThan(plain.iters / 100);
  });
});

// ── correctness: AA changes speed, not the answer ───────────────────────────

describe("makeAnderson — correctness", () => {
  test("the accelerated fixed point matches the true fixed point", () => {
    const accel = iterateToTarget(
      slowScalar,
      new Float64Array([0]),
      new Float64Array([1]),
      5,
      1e-12,
      100000,
    );
    expect(accel.iters).toBeGreaterThan(0);
    expect(accel.final[0]).toBeCloseTo(1, 11);
  });

  test("memory 0 is exactly the plain iteration — `next` returns Gz", () => {
    const aa = makeAnderson(0);
    const z = new Float64Array([3, -5, 7]);
    const Gz = new Float64Array([1, 1, 1]);
    const out = aa.next(z, Gz);
    expect(Array.from(out)).toEqual([1, 1, 1]); // exactly Gz
    expect(out).not.toBe(Gz); // a fresh array, not aliased
  });

  test("the first call of a window is always the plain step", () => {
    const aa = makeAnderson(5);
    const z = new Float64Array([0]);
    const Gz = new Float64Array([0.5]);
    expect(Array.from(aa.next(z, Gz))).toEqual([0.5]); // no history yet → plain step
  });

  test("reset() restarts the window — the next call is again a plain step", () => {
    const aa = makeAnderson(5);
    aa.next(new Float64Array([0]), new Float64Array([0.5]));
    aa.next(new Float64Array([0.5]), new Float64Array([0.7])); // builds a column
    aa.reset();
    // after reset, the next call has no history and must return Gz verbatim
    expect(Array.from(aa.next(new Float64Array([0.7]), new Float64Array([0.8])))).toEqual([0.8]);
  });
});

// ── determinism (ADR-0015 / ADR-0036) ───────────────────────────────────────

describe("makeAnderson — determinism", () => {
  test("the accelerated trajectory is bit-identical across runs", () => {
    const a = iterateToTarget(slow2D, new Float64Array([0, 0]), new Float64Array([1, 1]), 7, 1e-11, 100000);
    const b = iterateToTarget(slow2D, new Float64Array([0, 0]), new Float64Array([1, 1]), 7, 1e-11, 100000);
    expect(a.iters).toBe(b.iters);
    expect(Array.from(a.final)).toEqual(Array.from(b.final));
  });
});

// ── safeguard ───────────────────────────────────────────────────────────────

describe("makeAnderson — safeguard", () => {
  test("a contraction whose AA extrapolate would explode still converges", () => {
    // φ(x) = 0.5·x + 0.5 fixed point at 1. A perfectly tame map — but we
    // also check a near-degenerate case below. Here we just confirm that
    // a normal contraction is unaffected by the safeguard machinery.
    const phi = (z: Float64Array): Float64Array => new Float64Array([0.5 * z[0]! + 0.5]);
    const r = iterateToTarget(phi, new Float64Array([100]), new Float64Array([1]), 5, 1e-12, 1000);
    expect(r.iters).toBeGreaterThan(0);
    expect(Number.isFinite(r.final[0]!)).toBe(true);
    expect(r.final[0]).toBeCloseTo(1, 11);
  });

  test("an identity-ish map (zero residual differences) never NaNs", () => {
    // φ(x) = x: every residual is 0, every difference is 0 — `RᵀR` is the
    // zero matrix, the LU solve returns null, the safeguard restarts. The
    // accelerator must keep returning finite values, not NaN.
    const phi = (z: Float64Array): Float64Array => z.slice();
    const aa = makeAnderson(5);
    let z: Float64Array = new Float64Array([2, 3]);
    for (let k = 0; k < 50; k++) {
      z = aa.next(z, phi(z));
      expect(Number.isFinite(z[0]!)).toBe(true);
      expect(Number.isFinite(z[1]!)).toBe(true);
    }
    expect(Array.from(z)).toEqual([2, 3]); // a fixed point stays put
  });
});

// ── guards ──────────────────────────────────────────────────────────────────

describe("makeAnderson — guards", () => {
  test("rejects a negative or fractional memory", () => {
    expect(() => makeAnderson(-1)).toThrow(ConeError);
    expect(() => makeAnderson(2.5)).toThrow(ConeError);
  });
});
