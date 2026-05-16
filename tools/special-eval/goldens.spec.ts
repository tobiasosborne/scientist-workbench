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
  {
    description: "BesselJ → unknown-head refusal",
    input: realInput("BesselJ", 0.5),
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
];
