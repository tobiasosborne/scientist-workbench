// =============================================================================
// special-eval goldens
// =============================================================================
//
// Eleven golden entries exercising every code-path branch in the v0.1
// dispatch table (ADR-0040 §"Decision 7"):
//
//   1. Real Erf, float64 lane (default precision, no flag)
//   2. Real Erf, arb-prec lane (precision 50; matches mpmath corpus value)
//   3. Real Erfc at large x — load-bearing regression on the direct-asymptotic
//      path (`1 - bigErf` cancellation would be catastrophic at x=20; the
//      golden's BigFloat bytes pin the direct-asymptotic result)
//   4. Real Erfcx at moderate x (small-x lane composes via erfc; large-x
//      lane is direct asymptotic — both pinned)
//   5. Real Erfi via the bigCErfi identity path (arb-prec)
//   6. Real InverseErf — float64 lane only (arb-prec refuses with
//      no-known-representation; the float64 path is the v0.1 contract)
//   7. Real InverseErfc — float64 lane
//   8. Complex Erf at z=1+i (arb-prec lane via Karbach-Weideman)
//   9. Complex Erfi at z=2+3i (arb-prec)
//  10. Refusal: complex InverseErf → no-known-representation
//  11. Refusal: arb-prec InverseErfc → no-known-representation (real,
//      Phase 2 substrate gap)
//  12. Refusal: unknown head (BesselJ — outside the Erf-family vocabulary)
//  13. Refusal: NaN in real args
//  14. Refusal: degenerate complex shape (mismatched re/im list lengths)
//
// Each input was hand-constructed so the resulting golden file pins the
// substrate's exact output bytes; future drift fails the oracle phase
// of `bun run check`. Per the brief's "≥10 goldens v0.1 (soft floor per
// Rule 9)", we ship 14 — comfortably above the floor, with one entry per
// real branch.

import {
  float64FromNumber,
  list,
  record,
  str,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function realArgs(x: number) {
  return list([float64FromNumber(x)]);
}

function complexArgs(re: number, im: number) {
  return record({
    re: list([float64FromNumber(re)]),
    im: list([float64FromNumber(im)]),
  });
}

function realInput(head: string, x: number) {
  return record({ head: str(head), args: realArgs(x) });
}

function complexInput(head: string, re: number, im: number) {
  return record({ head: str(head), args: complexArgs(re, im) });
}

// Arity-2 helpers for the Bessel family — args = [ν, z] (real) or
// args.re = [ν, z.re], args.im = [0, z.im] (complex).
function realInput2(head: string, nu: number, z: number) {
  return record({
    head: str(head),
    args: list([float64FromNumber(nu), float64FromNumber(z)]),
  });
}

function complexInput2(head: string, nu: number, zRe: number, zIm: number) {
  return record({
    head: str(head),
    args: record({
      re: list([float64FromNumber(nu), float64FromNumber(zRe)]),
      im: list([float64FromNumber(0), float64FromNumber(zIm)]),
    }),
  });
}

export const goldens: GoldenSpec[] = [
  // Golden 1: real Erf, float64 lane (default precision = 50).
  // At p=50 (>15) this routes the arb-prec lane. To exercise the
  // float64 lane explicitly, see golden 6.
  {
    description: "Erf(0.5) at precision 50 — arb-prec Borel series",
    input: realInput("Erf", 0.5),
    flags: { precision: "50" },
  },

  // Golden 2: real Erf at x=2, precision 100. Borel series converges
  // (x < x_c(100·log2(10)) ≈ 15.1); pins the series-tier output.
  {
    description: "Erf(2.0) at precision 100 — arb-prec deep series",
    input: realInput("Erf", 2.0),
    flags: { precision: "100" },
  },

  // Golden 3: load-bearing — Erfc at large x = 20 at precision 50. This
  // is the regression test for the direct-asymptotic path. A bug that
  // computed `1 - bigErf(x)` would lose ~580 bits to cancellation; the
  // correct direct-asymptotic result is ~5.4e-176 and the golden bytes
  // pin it.
  {
    description: "Erfc(20.0) at precision 50 — direct-asymptotic ~5.4e-176",
    input: realInput("Erfc", 20.0),
    flags: { precision: "50" },
  },

  // Golden 4: Erfcx(3.0) at precision 50 — exercises the small-x lane
  // (compose via erfc) for x just inside the typical x_c crossover.
  {
    description: "Erfcx(3.0) at precision 50",
    input: realInput("Erfcx", 3.0),
    flags: { precision: "50" },
  },

  // Golden 5: Erfi(1.5) at precision 50 — real Erfi via bigCErfi
  // identity path. The mpmath truth at this point is non-trivial;
  // the golden bytes pin the bigfloat encoding.
  {
    description: "Erfi(1.5) at precision 50 — via bigCErfi identity",
    input: realInput("Erfi", 1.5),
    flags: { precision: "50" },
  },

  // Golden 6: float64 lane — InverseErf(0.5) at precision 10
  // (decimal ≤ 15 routes float64). Pins the Blair-Edwards-Johnson
  // 1976 inverse rational approximant's result.
  {
    description: "InverseErf(0.5) at precision 10 — float64 Blair-1976 lane",
    input: realInput("InverseErf", 0.5),
    flags: { precision: "10" },
  },

  // Golden 7: float64 lane — InverseErfc(0.5) at precision 10.
  {
    description: "InverseErfc(0.5) at precision 10 — float64 Blair-1976 lane",
    input: realInput("InverseErfc", 0.5),
    flags: { precision: "10" },
  },

  // Golden 8: complex Erf at z = 1 + i, precision 50 — arb-prec
  // Karbach-Weideman complex lane.
  {
    description: "Erf(1+i) at precision 50 — complex Karbach-Weideman",
    input: complexInput("Erf", 1.0, 1.0),
    flags: { precision: "50" },
  },

  // Golden 9: complex Erfi at z = 2 + 3i, precision 50 — exercises
  // the bigCErfi entry directly on the complex axis.
  {
    description: "Erfi(2+3i) at precision 50 — complex bigCErfi",
    input: complexInput("Erfi", 2.0, 3.0),
    flags: { precision: "50" },
  },

  // Golden 10: complex Erfc at z = 5 + 2i, precision 80 — deeper
  // precision, exercises arb-prec stability in the large-real-part
  // complex Erfc regime.
  {
    description: "Erfc(5+2i) at precision 80 — complex deep arb-prec",
    input: complexInput("Erfc", 5.0, 2.0),
    flags: { precision: "80" },
  },

  // Golden 11: refusal — complex InverseErf, any precision. Multi-
  // valued Riemann surface; the v0.1 contract refuses.
  {
    description: "InverseErf(0.5+0i) complex → no-known-representation",
    input: complexInput("InverseErf", 0.5, 0.0),
    flags: { precision: "10" },
  },

  // Golden 12: refusal — arb-prec InverseErfc (real). Phase 2 substrate
  // gap (Newton-on-bigErf wasn't shipped); arb-prec lane refuses.
  {
    description: "InverseErfc(0.5) at precision 50 → no-known-representation",
    input: realInput("InverseErfc", 0.5),
    flags: { precision: "50" },
  },

  // Golden 13: refusal — unknown head.
  //
  // Was `BesselJ` pre-ADR-0041; now that BesselJ is admitted (T2 worklog
  // 163 / bead unno), the unknown-head test rotates to `WhittakerM`
  // (admitted to the cas-core vocabulary per ADR-0023 but with no
  // special-eval substrate; still refused as unknown-head here).
  {
    description: "WhittakerM → unknown-head refusal",
    input: realInput("WhittakerM", 0.5),
    flags: { precision: "50" },
  },

  // Golden 14: refusal — NaN in args.
  {
    description: "Erf(NaN) → non-finite-input refusal",
    input: record({
      head: str("Erf"),
      args: list([{ kind: "float64", bits: "7ff8000000000000" }]),
    }),
    flags: { precision: "50" },
  },

  // Golden 15: refusal — degenerate complex shape (mismatched lengths).
  {
    description: "complex Erf with mismatched re/im lengths → degenerate-shape",
    input: record({
      head: str("Erf"),
      args: record({
        re: list([float64FromNumber(1.0), float64FromNumber(2.0)]),
        im: list([float64FromNumber(0.5)]),
      }),
    }),
    flags: { precision: "50" },
  },

  // ===========================================================================
  // Bessel family goldens (ADR-0041 §"Decision 7"; T2 worklog 163)
  // ===========================================================================
  //
  // 20 goldens spanning the 4 primary heads × 5 tiers each:
  //   T1 — small-z series regime (|z| ≲ 1)
  //   T2 — mid-z (transition / O(1))
  //   T3 — large-z asymptotic regime
  //   T5 — complex argument
  //   T7 — higher-ν stress
  //
  // Reference values for the arb-prec lane are byte-identical to FLINT/Arb
  // via python-flint (bench/besselj-anchor/oracles/arb/results.json); the
  // float64-lane goldens pin the verbatim R3 ports' output bytes.

  // ---- BesselJ ----
  {
    description: "BesselJ(0, 0.5) at precision 50 — T1 small-z series",
    input: realInput2("BesselJ", 0, 0.5),
    flags: { precision: "50" },
  },
  {
    description: "BesselJ(0, 8.0) at precision 50 — T2 mid-z (cancellation regime)",
    input: realInput2("BesselJ", 0, 8.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselJ(0, 200.0) at precision 50 — T3 large-z Hankel asymptotic",
    input: realInput2("BesselJ", 0, 200.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselJ(3, 1.5) at precision 50 — T7 higher-ν integer",
    input: realInput2("BesselJ", 3, 1.5),
    flags: { precision: "50" },
  },
  {
    description: "BesselJ(2, 1.0+0.5i) at precision 50 — T5 complex z (arb-prec AMOS rotation)",
    input: complexInput2("BesselJ", 2, 1.0, 0.5),
    flags: { precision: "50" },
  },

  // ---- BesselY ----
  {
    description: "BesselY(0, 0.5) at precision 50 — T1 small-z (log singularity nearby)",
    input: realInput2("BesselY", 0, 0.5),
    flags: { precision: "50" },
  },
  {
    description: "BesselY(0, 5.0) at precision 50 — T2 mid-z",
    input: realInput2("BesselY", 0, 5.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselY(0, 100.0) at precision 50 — T3 large-z Hankel asymptotic",
    input: realInput2("BesselY", 0, 100.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselY(2, 3.0) at precision 50 — T7 higher-ν integer",
    input: realInput2("BesselY", 2, 3.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselY(1, 3.0) at precision 10 — float64 lane (musl SunPro)",
    input: realInput2("BesselY", 1, 3.0),
    flags: { precision: "10" },
  },

  // ---- BesselI ----
  {
    description: "BesselI(0, 0.5) at precision 50 — T1 small-z ₀F₁ Maclaurin",
    input: realInput2("BesselI", 0, 0.5),
    flags: { precision: "50" },
  },
  {
    description: "BesselI(0, 5.0) at precision 50 — T2 mid-z (modified Hankel boundary)",
    input: realInput2("BesselI", 0, 5.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselI(0, 50.0) at precision 50 — T3 large-z modified asymptotic",
    input: realInput2("BesselI", 0, 50.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselI(2, 2.0) at precision 50 — T7 higher-ν integer",
    input: realInput2("BesselI", 2, 2.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselI(1, 1.0+0.5i) at precision 50 — T5 complex z arb-prec",
    input: complexInput2("BesselI", 1, 1.0, 0.5),
    flags: { precision: "50" },
  },

  // ---- BesselK ----
  {
    description: "BesselK(0, 0.5) at precision 50 — T1 small-z (logarithmic regime)",
    input: realInput2("BesselK", 0, 0.5),
    flags: { precision: "50" },
  },
  {
    description: "BesselK(0, 10.0) at precision 100 — T2/T3 deep arb-prec asymptotic",
    input: realInput2("BesselK", 0, 10.0),
    flags: { precision: "100" },
  },
  {
    description: "BesselK(0, 50.0) at precision 50 — T3 large-z (tiny: ~3.4e-23)",
    input: realInput2("BesselK", 0, 50.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselK(2, 1.0) at precision 50 — T7 higher-ν integer",
    input: realInput2("BesselK", 2, 1.0),
    flags: { precision: "50" },
  },
  {
    description: "BesselK(1, 2.0+1.0i) at precision 50 — T5 complex z arb-prec",
    input: complexInput2("BesselK", 1, 2.0, 1.0),
    flags: { precision: "50" },
  },

  // ---- BesselIScaled / BesselKScaled (the overflow / underflow lifters) ----
  {
    description: "BesselIScaled(0, 700) at precision 10 — float64 (unscaled would overflow)",
    input: realInput2("BesselIScaled", 0, 700),
    flags: { precision: "10" },
  },
  {
    description: "BesselKScaled(0, 1000) at precision 10 — float64 (unscaled would underflow to 0)",
    input: realInput2("BesselKScaled", 0, 1000),
    flags: { precision: "10" },
  },

  // ---- Bessel refusal: K_ν(0) singular ----
  {
    description: "BesselK(0, 0) → no-known-representation (logarithmic singularity)",
    input: realInput2("BesselK", 0, 0),
    flags: { precision: "50" },
  },

  // ---- Bessel float64 lane spot-check ----
  {
    description: "BesselJ(0, 2.0) at precision 10 — float64 lane (musl SunPro j0.c)",
    input: realInput2("BesselJ", 0, 2.0),
    flags: { precision: "10" },
  },
];
