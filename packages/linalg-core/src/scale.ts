// =============================================================================
// scale.ts — measurement-driven warning thresholds for the numerical tier
// =============================================================================
//
// ADR-0016. The numerical-tier tools (linalg-solve, linalg-qr, linalg-svd,
// and the eigh tool to come) all share the same physical limits in pure
// TS: wall-clock grows superlinearly in n; memory grows as O(m·n);
// the wire-encoding cost dominates on phone deployments where browser
// tabs cap at 1-2 GB.
//
// Rather than refusing inputs above an arbitrary cap (the ADR-0014
// design, withdrawn by ADR-0016), we *warn* — the agent reads the
// strings and decides what to do. The agent-honest output discipline
// already has a `warnings` field; this helper produces the strings
// that go in it.
//
// Thresholds are calibrated to the 2026-05-05 measurement table
// (`docs/adr/0016-warning-based-numerical-scaling.md` and
// `docs/measurements/2026-05-05-numerical-tier-n-ceiling.md`):
//   - QR Householder:  n=500 → ~3s, n=1000 → ~25s, n=2000 → ~9 min.
//   - SVD Jacobi:      n=500 → ~18s, n=1000 → ~3.5 min, n=2000 → hours.
//
// Phone CPUs run roughly 3× slower than the dev-box x86 measurements;
// the messages bake in that factor.
//
// Memory thresholds estimate ~5× the dense matrix footprint
// (input copy + working storage + factor outputs + scratch).
// Mobile-browser-tab memory budget is typically 1-2 GB.

const N_WELL_TESTED = 500;     // beyond this: "moderate" warning
const N_STRESS_TESTED = 1000;  // beyond this: "slow" warning
const N_IMPRACTICAL = 2000;    // beyond this: "very slow / FFI strongly recommended"

const PEAK_RSS_WARN_MB = 100;        // matches typical browser-tab share
const PEAK_RSS_HARD_WARN_MB = 500;   // mobile OOM risk

export type Algorithm = "qr" | "svd-jacobi" | "svd-golub-reinsch" | "lu" | "eigh";

/** Estimate peak working memory in MB for a dense `m × n` problem.
 *
 * Convention: ~5 dense copies of float64 — input, working, output factor 1,
 * output factor 2, scratch — plus baseline Bun heap (~50 MB). The figure is
 * intentionally conservative; a planner reading the warning should read the
 * estimate as "expected upper-bound", not "guaranteed peak".
 */
export function estimatePeakMemoryMB(m: number, n: number): number {
  const denseBytes = 8 * m * n;
  const working = 5 * denseBytes;
  const baseline = 50 * 1024 * 1024;
  return (working + baseline) / (1024 * 1024);
}

/** Wall-clock estimate (seconds) on the dev-box. Phone CPUs ≈ 3× slower. */
export function estimateWallClockSeconds(algo: Algorithm, m: number, n: number): number {
  const N = Math.max(m, n);
  // Constants from the 2026-05-05 measurement table; extrapolate by
  // the algorithm's complexity exponent.
  switch (algo) {
    case "qr":
    case "lu": {
      // O(N^3); calibrated on QR n=500 → 2.6 s.
      const ref_n = 500;
      const ref_t = 2.6;
      return ref_t * Math.pow(N / ref_n, 3);
    }
    case "svd-jacobi": {
      // O(N^3 log² N); calibrated on n=500 → 17.6 s.
      const ref_n = 500;
      const ref_t = 17.6;
      const log_ratio = Math.log(N) / Math.log(ref_n);
      return ref_t * Math.pow(N / ref_n, 3) * (log_ratio * log_ratio);
    }
    case "svd-golub-reinsch": {
      // O(N^3); a future port — extrapolated as ~4× faster than Jacobi
      // at n=500 (LAPACK DGESDD is ~3-5× faster than one-sided Jacobi
      // in our regime); kept here as a placeholder for the bead-71f
      // SVD rewrite.
      const ref_n = 500;
      const ref_t = 4.0;
      return ref_t * Math.pow(N / ref_n, 3);
    }
    case "eigh": {
      // O(N^3); calibrated to symmetric-eigh = ~1.5× LU cost (one extra
      // pass through the matrix per sweep). Until measured, tracks LU.
      const ref_n = 500;
      const ref_t = 4.0;
      return ref_t * Math.pow(N / ref_n, 3);
    }
  }
}

/** Produce the canonical warning strings for a given problem. */
export function assessNumericalScale(
  algo: Algorithm,
  m: number,
  n: number,
): string[] {
  const warnings: string[] = [];
  const N = Math.max(m, n);

  if (N > N_WELL_TESTED) {
    const tSec = estimateWallClockSeconds(algo, m, n);
    if (N > N_IMPRACTICAL) {
      warnings.push(
        `matrix size ${m}×${n} (max=${N}) in regime where pure-TS dense linear ` +
        `algebra becomes impractical (~${tSec.toFixed(0)}s on dev-box, ~${(tSec * 3).toFixed(0)}s ` +
        `on phone CPU); FFI bridge to OpenBLAS strongly recommended (bead scientist-workbench-e7y)`,
      );
    } else if (N > N_STRESS_TESTED) {
      warnings.push(
        `matrix size ${m}×${n} above the ${N_STRESS_TESTED}-cell stress-tested threshold; ` +
        `expected wall-clock ~${tSec.toFixed(1)}s on dev-box (~${(tSec * 3).toFixed(0)}s on phone); ` +
        `consider FFI bridge (bead scientist-workbench-e7y) for production use`,
      );
    } else {
      warnings.push(
        `matrix size ${m}×${n} above the ${N_WELL_TESTED}-cell well-tested threshold; ` +
        `expected wall-clock ~${tSec.toFixed(1)}s on dev-box (~${(tSec * 3).toFixed(1)}s on phone)`,
      );
    }
  }

  const peakMB = estimatePeakMemoryMB(m, n);
  if (peakMB > PEAK_RSS_HARD_WARN_MB) {
    warnings.push(
      `estimated peak memory ~${peakMB.toFixed(0)} MB; OOM risk on mobile platforms ` +
      `(typical browser-tab budget 1-2 GB)`,
    );
  } else if (peakMB > PEAK_RSS_WARN_MB) {
    warnings.push(
      `estimated peak memory ~${peakMB.toFixed(0)} MB; large fraction of typical ` +
      `mobile-browser tab budget`,
    );
  }

  return warnings;
}

/** Wrap a substrate call so a true allocation OOM surfaces as a clean
 * error caller can re-throw as a `ToolError`.
 *
 * The native JS `RangeError: Invalid array length` is caught and
 * re-thrown as a `MemoryExhaustionError` carrying the attempted byte
 * count and the (m, n) that triggered it.
 */
export class MemoryExhaustionError extends Error {
  readonly attemptedBytes: number;
  readonly dims: { m: number; n: number };
  constructor(attemptedBytes: number, dims: { m: number; n: number }, cause: Error) {
    super(
      `numerical-tier OOM: failed to allocate ~${(attemptedBytes / (1024 * 1024)).toFixed(0)} MB ` +
      `for an ${dims.m}×${dims.n} dense problem (${cause.message})`,
    );
    this.name = "MemoryExhaustionError";
    this.attemptedBytes = attemptedBytes;
    this.dims = dims;
  }
}

export function withOomGuard<T>(m: number, n: number, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError && /Invalid array length|Invalid typed array length/.test(e.message)) {
      const attempted = 8 * m * n * 5;
      throw new MemoryExhaustionError(attempted, { m, n }, e);
    }
    throw e;
  }
}
