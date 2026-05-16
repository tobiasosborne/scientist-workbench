// =============================================================================
// Stokes-multiplier table — coverage, determinism, and refusal envelope
// =============================================================================
//
// Tests the `stokesMultiplier` and `principalSectorBound` exports from
// `stokes.ts` (bead `egf` Part 1). The Stokes table is a pure lookup —
// it does no numerical computation beyond constructing BigComplex
// constants from the set {0, ±1, ±i} at the requested precision. The
// tests therefore exercise:
//
//   1. **Table coverage for κ=1** — every (sectorIndex, signOfImZ) pair
//      returns `covered` with the multiplier matching Case 4.4.1 of
//      `docs/refs/dlmf-16-11.md` §4.4.
//   2. **Table coverage for κ=3** — representative pairs from the
//      table match Case 4.4.3.
//   3. **Coverage gap for κ=2** — returns `coverage-gap` with the
//      bead ID `fc83` in the reason.
//   4. **Out-of-table for κ ≤ 0** — defensive refusal.
//   5. **`principalSectorBound`** — angle values match κπ/2.
//   6. **Determinism** — same call args ⇒ byte-identical BigComplex.
//
// We do NOT attempt an end-to-end "G = H + S·E" cross-check in this
// file — that integration test lives in Part 2 of bead `egf` when the
// connection formula is wired into `meijergAsymptotic`. The Stokes
// table is a lookup, not a numerical computation; the wire-test is
// the Part-2 territory.

import { describe, expect, test } from "bun:test";
import {
  decimalToBinaryPrecision,
} from "@workbench/bigfloat";
import {
  principalSectorBound,
  stokesMultiplier,
} from "../src/stokes.js";

const WORK_BITS = decimalToBinaryPrecision(50);

// -----------------------------------------------------------------------------
// 1. κ = 1 — Case 4.4.1
// -----------------------------------------------------------------------------
//
// Expected table (from `docs/refs/dlmf-16-11.md` §4.4 Case 4.4.1 with
// the geometric rule for the two rotated representatives — see the
// implementation notes in `stokes.ts` for the rationale):
//
//   sectorIndex = 0:
//     all signOfImZ: multiplier = +1 (E_0 active in principal sector)
//
//   sectorIndex = -1:  (E_{-1} = E(z e^{-2π i}))
//     signOfImZ = -1:  multiplier = 0   (inactive: wrong half-plane)
//     signOfImZ =  0:  multiplier = +i
//     signOfImZ = +1:  multiplier = +i
//
//   sectorIndex = +1:  (E_{+1} = E(z e^{+2π i}))
//     signOfImZ = -1:  multiplier = -i
//     signOfImZ =  0:  multiplier = -i
//     signOfImZ = +1:  multiplier = 0   (inactive)

describe("stokesMultiplier: κ=1 table coverage", () => {
  // The 9 combinations: (sectorIndex × signOfImZ) ∈ {-1,0,+1}².
  const cases: ReadonlyArray<{
    sectorIndex: number;
    signOfImZ: -1 | 0 | 1;
    wantRe: bigint;
    wantIm: bigint;
    label: string;
  }> = [
    // sectorIndex = 0: E_0 always active with +1.
    { sectorIndex: 0, signOfImZ: -1, wantRe: 1n, wantIm: 0n, label: "S_0 in lower half" },
    { sectorIndex: 0, signOfImZ:  0, wantRe: 1n, wantIm: 0n, label: "S_0 on real axis" },
    { sectorIndex: 0, signOfImZ:  1, wantRe: 1n, wantIm: 0n, label: "S_0 in upper half" },
    // sectorIndex = -1: E_{-1} active in upper half / real axis with +i.
    { sectorIndex: -1, signOfImZ: -1, wantRe: 0n, wantIm:  0n, label: "S_{-1} lower (inactive)" },
    { sectorIndex: -1, signOfImZ:  0, wantRe: 0n, wantIm:  1n, label: "S_{-1} real axis (+i)" },
    { sectorIndex: -1, signOfImZ:  1, wantRe: 0n, wantIm:  1n, label: "S_{-1} upper (+i)" },
    // sectorIndex = +1: E_{+1} active in lower half / real axis with -i.
    { sectorIndex:  1, signOfImZ: -1, wantRe: 0n, wantIm: -1n, label: "S_{+1} lower (-i)" },
    { sectorIndex:  1, signOfImZ:  0, wantRe: 0n, wantIm: -1n, label: "S_{+1} real axis (-i)" },
    { sectorIndex:  1, signOfImZ:  1, wantRe: 0n, wantIm:  0n, label: "S_{+1} upper (inactive)" },
  ];

  for (const c of cases) {
    test(`κ=1, sectorIndex=${c.sectorIndex}, signOfImZ=${c.signOfImZ}: ${c.label}`, () => {
      const r = stokesMultiplier(1, c.sectorIndex, c.signOfImZ, WORK_BITS);
      expect(r.status).toBe("covered");
      if (r.status !== "covered" || !r.multiplier) {
        throw new Error(`expected covered, got ${r.status}: ${r.reason ?? ""}`);
      }
      // The multipliers are exact integers (from {0, ±1}). Verify the
      // BigFloat mantissa/exponent encode the integer exactly — no
      // rounding. cfromInts(re, im, prec) produces zero mantissa for
      // zero values and unit-mantissa-at-some-exponent for ±1.
      const re = r.multiplier.re;
      const im = r.multiplier.im;
      // Convert to bigint by mantissa-shift (mantissa · 2^exponent).
      // For our finite set {0, ±1}, exponent ≤ 0 means we'd need
      // shifting right; but cfromInts on an integer produces a
      // mantissa-shift such that mantissa · 2^exponent = integer.
      // The easiest correctness check is via toFloat64 equality to
      // the expected integer.
      const expectedRe = Number(c.wantRe);
      const expectedIm = Number(c.wantIm);
      // Multiply re by 1n + 0i to coerce to a clean form, then check.
      // Use re.mantissa === 0n ⇔ value is zero exactly:
      if (expectedRe === 0) {
        expect(re.mantissa).toBe(0n);
      } else {
        // re should equal exactly the integer expectedRe.
        // Validate via the toFloat64 representation:
        // (cfromInts uses fromInt which produces a normalised BigFloat
        // whose toFloat64 rounds back to the integer exactly for
        // small values.)
        const reF = Number(re.mantissa) * Math.pow(2, re.exponent);
        expect(reF).toBe(expectedRe);
      }
      if (expectedIm === 0) {
        expect(im.mantissa).toBe(0n);
      } else {
        const imF = Number(im.mantissa) * Math.pow(2, im.exponent);
        expect(imF).toBe(expectedIm);
      }
    });
  }
});

// -----------------------------------------------------------------------------
// 2. κ = 3 — Case 4.4.3
// -----------------------------------------------------------------------------
//
// Expected table (from `docs/refs/dlmf-16-11.md` §4.4 Case 4.4.3 with
// the geometric rule on signOfImZ in the implementation):
//
//   signOfImZ = 0 (positive real axis, arg z = 0):
//     S_{-1} = +1,  S_0 = 0,  S_{+1} = +1
//
//   signOfImZ = ±1 (off the real axis, principal interior):
//     S_{-1} = +1,  S_0 = +1,  S_{+1} = +1

describe("stokesMultiplier: κ=3 table coverage", () => {
  const cases: ReadonlyArray<{
    sectorIndex: number;
    signOfImZ: -1 | 0 | 1;
    wantRe: bigint;
    label: string;
  }> = [
    // Positive real axis: S_0 = 0, S_{±1} = 1.
    { sectorIndex: -1, signOfImZ: 0, wantRe: 1n, label: "real axis: S_{-1} = 1" },
    { sectorIndex:  0, signOfImZ: 0, wantRe: 0n, label: "real axis: S_0 = 0 (subdominant)" },
    { sectorIndex: +1, signOfImZ: 0, wantRe: 1n, label: "real axis: S_{+1} = 1" },
    // Off the real axis (upper half): all three at 1.
    { sectorIndex: -1, signOfImZ: 1, wantRe: 1n, label: "upper half: S_{-1} = 1" },
    { sectorIndex:  0, signOfImZ: 1, wantRe: 1n, label: "upper half: S_0 = 1" },
    { sectorIndex: +1, signOfImZ: 1, wantRe: 1n, label: "upper half: S_{+1} = 1" },
    // Off the real axis (lower half): all three at 1.
    { sectorIndex: -1, signOfImZ: -1, wantRe: 1n, label: "lower half: S_{-1} = 1" },
    { sectorIndex:  0, signOfImZ: -1, wantRe: 1n, label: "lower half: S_0 = 1" },
    { sectorIndex: +1, signOfImZ: -1, wantRe: 1n, label: "lower half: S_{+1} = 1" },
  ];

  for (const c of cases) {
    test(`κ=3, sectorIndex=${c.sectorIndex}, signOfImZ=${c.signOfImZ}: ${c.label}`, () => {
      const r = stokesMultiplier(3, c.sectorIndex, c.signOfImZ, WORK_BITS);
      expect(r.status).toBe("covered");
      if (r.status !== "covered" || !r.multiplier) {
        throw new Error(`expected covered, got ${r.status}: ${r.reason ?? ""}`);
      }
      // Multipliers in {0, +1} for κ=3.
      const expectedRe = Number(c.wantRe);
      if (expectedRe === 0) {
        expect(r.multiplier.re.mantissa).toBe(0n);
      } else {
        const reF =
          Number(r.multiplier.re.mantissa) *
          Math.pow(2, r.multiplier.re.exponent);
        expect(reF).toBe(expectedRe);
      }
      // Imaginary part always zero for κ=3.
      expect(r.multiplier.im.mantissa).toBe(0n);
    });
  }
});

// -----------------------------------------------------------------------------
// 3. κ = 2 coverage-gap
// -----------------------------------------------------------------------------

describe("stokesMultiplier: κ=2 coverage gap", () => {
  test("κ=2 returns coverage-gap with fc83 bead ID in reason", () => {
    const r = stokesMultiplier(2, 0, 0, WORK_BITS);
    expect(r.status).toBe("coverage-gap");
    if (r.status !== "coverage-gap") return;
    expect(r.reason).toContain("fc83");
    expect(r.multiplier).toBeUndefined();
  });

  test("κ=2 with all sectorIndex / signOfImZ still returns coverage-gap", () => {
    for (const sectorIndex of [-1, 0, 1]) {
      for (const sgn of [-1, 0, 1] as const) {
        const r = stokesMultiplier(2, sectorIndex, sgn, WORK_BITS);
        expect(r.status).toBe("coverage-gap");
      }
    }
  });
});

// -----------------------------------------------------------------------------
// 4. κ ≤ 0 out-of-table
// -----------------------------------------------------------------------------

describe("stokesMultiplier: κ ≤ 0 out-of-table", () => {
  test("κ = 0 returns out-of-table", () => {
    const r = stokesMultiplier(0, 0, 0, WORK_BITS);
    expect(r.status).toBe("out-of-table");
  });
  test("κ = -1 returns out-of-table", () => {
    const r = stokesMultiplier(-1, 0, 0, WORK_BITS);
    expect(r.status).toBe("out-of-table");
  });
  test("κ = -5 returns out-of-table", () => {
    const r = stokesMultiplier(-5, 0, 0, WORK_BITS);
    expect(r.status).toBe("out-of-table");
  });
});

// -----------------------------------------------------------------------------
// 5. Out-of-range sectorIndex
// -----------------------------------------------------------------------------

describe("stokesMultiplier: out-of-range sectorIndex", () => {
  test("κ=1, |sectorIndex| ≥ 2 returns out-of-table", () => {
    expect(stokesMultiplier(1, 2, 0, WORK_BITS).status).toBe("out-of-table");
    expect(stokesMultiplier(1, -2, 0, WORK_BITS).status).toBe("out-of-table");
  });
  test("κ=3, |sectorIndex| ≥ 2 returns out-of-table", () => {
    expect(stokesMultiplier(3, 2, 0, WORK_BITS).status).toBe("out-of-table");
    expect(stokesMultiplier(3, -2, 0, WORK_BITS).status).toBe("out-of-table");
  });
});

// -----------------------------------------------------------------------------
// 6. Validation errors
// -----------------------------------------------------------------------------

describe("stokesMultiplier: input validation", () => {
  test("non-integer kappa returns out-of-table", () => {
    const r = stokesMultiplier(1.5, 0, 0, WORK_BITS);
    expect(r.status).toBe("out-of-table");
  });
  test("non-integer sectorIndex returns out-of-table", () => {
    const r = stokesMultiplier(1, 0.5, 0, WORK_BITS);
    expect(r.status).toBe("out-of-table");
  });
  test("invalid signOfImZ returns out-of-table", () => {
    // @ts-expect-error: testing runtime validation
    const r = stokesMultiplier(1, 0, 2, WORK_BITS);
    expect(r.status).toBe("out-of-table");
  });
  test("too-low workingBits returns out-of-table", () => {
    const r = stokesMultiplier(1, 0, 0, 16);
    expect(r.status).toBe("out-of-table");
  });
});

// -----------------------------------------------------------------------------
// 7. principalSectorBound
// -----------------------------------------------------------------------------

describe("principalSectorBound", () => {
  test("κ=1 → angle = π/2", () => {
    const b = principalSectorBound(1);
    expect(b.angle).toBeCloseTo(Math.PI / 2, 14);
    expect(b.description).toContain("kappa=1");
    expect(b.description).toContain("π/2");
  });
  test("κ=2 → angle = π", () => {
    const b = principalSectorBound(2);
    expect(b.angle).toBeCloseTo(Math.PI, 14);
    expect(b.description).toContain("kappa=2");
    // κ=2 is informational; the multiplier table refuses it.
    expect(b.description).toContain("coverage-gap");
  });
  test("κ=3 → angle = 3π/2", () => {
    const b = principalSectorBound(3);
    expect(b.angle).toBeCloseTo((3 * Math.PI) / 2, 14);
  });
  test("κ=4 → angle = 2π", () => {
    const b = principalSectorBound(4);
    expect(b.angle).toBeCloseTo(2 * Math.PI, 14);
  });
  test("κ=5 → angle = 5π/2", () => {
    const b = principalSectorBound(5);
    expect(b.angle).toBeCloseTo((5 * Math.PI) / 2, 14);
  });
  test("κ=0 returns NaN angle and an informative description", () => {
    const b = principalSectorBound(0);
    expect(Number.isNaN(b.angle)).toBe(true);
    expect(b.description).toContain("out of range");
  });
  test("non-integer κ returns NaN", () => {
    const b = principalSectorBound(1.5);
    expect(Number.isNaN(b.angle)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 8. Determinism — bit-identical repeated calls
// -----------------------------------------------------------------------------

describe("stokesMultiplier: determinism", () => {
  test("κ=1: same args ⇒ byte-identical BigComplex", () => {
    const r1 = stokesMultiplier(1, -1, 1, WORK_BITS);
    const r2 = stokesMultiplier(1, -1, 1, WORK_BITS);
    expect(r1.status).toBe("covered");
    expect(r2.status).toBe("covered");
    if (r1.status !== "covered" || r2.status !== "covered") return;
    if (!r1.multiplier || !r2.multiplier) throw new Error("missing multiplier");
    expect(r1.multiplier.re.mantissa).toBe(r2.multiplier.re.mantissa);
    expect(r1.multiplier.re.exponent).toBe(r2.multiplier.re.exponent);
    expect(r1.multiplier.im.mantissa).toBe(r2.multiplier.im.mantissa);
    expect(r1.multiplier.im.exponent).toBe(r2.multiplier.im.exponent);
  });
  test("κ=3: same args ⇒ byte-identical BigComplex (at different working precisions)", () => {
    for (const wb of [128, 256, 512]) {
      const r1 = stokesMultiplier(3, 0, 0, wb);
      const r2 = stokesMultiplier(3, 0, 0, wb);
      expect(r1.status).toBe("covered");
      if (r1.status !== "covered" || r2.status !== "covered") continue;
      if (!r1.multiplier || !r2.multiplier) continue;
      expect(r1.multiplier.re.mantissa).toBe(r2.multiplier.re.mantissa);
      expect(r1.multiplier.re.exponent).toBe(r2.multiplier.re.exponent);
      expect(r1.multiplier.im.mantissa).toBe(r2.multiplier.im.mantissa);
      expect(r1.multiplier.im.exponent).toBe(r2.multiplier.im.exponent);
    }
  });
});
