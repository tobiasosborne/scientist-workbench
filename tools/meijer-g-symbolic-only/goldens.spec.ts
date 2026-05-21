// =============================================================================
// goldens.spec.ts — golden inputs for the symbolic dispatcher
// =============================================================================
//
// v0.1 ships a small starter set (~10 cases). The full battery
// (~50 cases for tier A + tier B coverage) lands in bead `hv0.11`
// (the bench tier-graded battery).
//
// Each input exercises one rule shape: an exp-class Series-1 case,
// a Series-2 mirror, the binomial Bateman (3) closed form, the
// Bessel-K reduction, the Bessel-J reduction, the elementary DLMF
// reductions (E_1, log, arctan, erf), and the no-known-reduction
// envelope for an unrecognised input. The set is balanced across
// rule files so a regression in either Bateman or DLMF surfaces
// in a golden diff.

import { int, list, rat, record, sym, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function rec(an: Value[], ap: Value[], bm: Value[], bq: Value[], z: Value): Value {
  return record({
    an: list(an),
    ap: list(ap),
    bm: list(bm),
    bq: list(bq),
    z,
  });
}

const Z = sym("z");

export const goldens: GoldenSpec[] = [
  {
    description: "Bateman (8): G^{1,0}_{0,1}(_; 0 | z) = e^{-z}",
    input: rec([], [], [int(0n)], [], Z),
  },
  {
    description: "Bateman (1) at b=symbolic: G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}",
    input: rec([], [], [sym("b")], [], Z),
  },
  {
    description: "Bateman (3): G^{1,1}_{1,1}(a; b | z) = Γ(1+b−a) · z^b · (1+z)^{a−b−1}",
    input: rec([sym("a")], [], [sym("b")], [], Z),
  },
  {
    description: "Bateman (10): G^{1,1}_{1,1}(a; 0 | z) = Γ(1−a) · (1+z)^{a−1}",
    input: rec([sym("a")], [], [int(0n)], [], Z),
  },
  {
    description: "Bateman (4): G^{2,0}_{0,2}(_; a, b | z) = 2 z^{(a+b)/2} K_{a−b}(2√z)",
    input: rec([], [], [sym("a"), sym("b")], [], Z),
  },
  {
    description: "Bateman (25): G^{2,0}_{0,2}(_; 0, 0 | z) = 2 K_0(2√z)",
    input: rec([], [], [int(0n), int(0n)], [], Z),
  },
  {
    description: "Bateman (6): G^{1,0}_{0,2}(_; b₁ | b₂ | z) = z^{(b₁+b₂)/2} J_{b₁−b₂}(2√z)",
    input: rec([], [], [sym("a")], [sym("b")], Z),
  },
  {
    description: "DLMF empty: G^{0,0}_{0,0}(_; _ | z) = 1",
    input: rec([], [], [], [], Z),
  },
  {
    description: "DLMF E_1: G^{2,0}_{1,2}(1; 0, 0 | z) = E_1(z)",
    input: rec([], [int(1n)], [int(0n), int(0n)], [], Z),
  },
  {
    description: "DLMF log: G^{1,2}_{2,2}(1, 1; 1, 0 | z) = log(1+z)",
    input: rec([int(1n), int(1n)], [], [int(1n)], [int(0n)], Z),
  },
  {
    description: "DLMF erf: G^{1,1}_{1,2}(1; 1/2, 0 | z) = √π · erf(√z)",
    input: rec([int(1n)], [], [rat(1n, 2n)], [int(0n)], Z),
  },
  {
    description: "DLMF arctan: G^{1,2}_{2,2}(1/2, 1; 1/2, 0 | z) = 2 atan(√z)",
    input: rec([rat(1n, 2n), int(1n)], [], [rat(1n, 2n)], [int(0n)], Z),
  },
  {
    description: "no-known-reduction: G^{1,1}_{2,2} with all-symbolic params",
    input: rec([sym("a")], [sym("b")], [sym("c")], [sym("d")], Z),
  },

  // ---------------------------------------------------------------------------
  // Gamma family closure goldens (bead `scientist-workbench-boyu`, Phase 3 T3)
  // ---------------------------------------------------------------------------
  // The bateman-5-6 (38)/(40) rules — added in bead `0pvl` — close the
  // IncompleteGamma{Upper,Lower} side of the gamma R4 §A.3-A.4 bridge.
  // Six goldens exercise the new rules AND pin the discrimination
  // against the colliding Erfc / ExpIntegralE / Erf siblings.
  //
  //   * 14 / 15: IncompleteGammaUpper positive coverage (38a + 38b
  //     mirror-pair, exercising both canonical-sort positions of the
  //     free `a` slot).
  //   * 16: IncompleteGammaLower positive coverage (40).
  //   * 17: Erfc discrimination at (2,0,1,2)+bm={0,1/2} (NOT
  //     IncompleteGammaUpper) — pins the cross-file ALL_RULES order.
  //   * 18: ExpIntegralE(1, z) discrimination at (2,0,1,2)+bm={0,0}
  //     (NOT IncompleteGammaUpper(0, z)) — pins the priority lattice's
  //     "the conventional head wins" rule.
  //   * 19: Erf (Form B) discrimination at (1,1,1,2)+bm=[1/2]
  //     (NOT IncompleteGammaLower(1/2, z)) — pins DLMF_16_18 ordering
  //     before BATEMAN_5_6 in dispatch.ts::ALL_RULES.
  {
    description: "Bateman (38b): G^{2,0}_{1,2}(_; 1; 0, a | z) = IncompleteGammaUpper(a, z) [a symbolic]",
    input: rec([], [int(1n)], [sym("a"), int(0n)], [], Z),
  },
  {
    description: "Bateman (38a): G^{2,0}_{1,2}(_; 1; 2/3, 0 | z) = IncompleteGammaUpper(2/3, z) [a rational]",
    input: rec([], [int(1n)], [rat(2n, 3n), int(0n)], [], Z),
  },
  {
    description: "Bateman (40): G^{1,1}_{1,2}(1; a, 0 | z) = IncompleteGammaLower(a, z) [a symbolic]",
    input: rec([int(1n)], [], [sym("a")], [int(0n)], Z),
  },
  {
    description: "Erfc-discrimination at (2,0,1,2)+bm={0,1/2}: routes to Erfc, NOT IncompleteGammaUpper",
    input: rec([], [int(1n)], [int(0n), rat(1n, 2n)], [], Z),
  },
  {
    description: "E_1-discrimination at (2,0,1,2)+bm={0,0}: routes to ExpIntegralE(1,z), NOT IncompleteGammaUpper(0,z)",
    input: rec([], [int(1n)], [int(0n), int(0n)], [], Z),
  },
  {
    description: "Erf-discrimination at (1,1,1,2)+bm=[1/2]: routes to Erf (Form B), NOT IncompleteGammaLower(1/2,z)",
    input: rec([int(1n)], [], [rat(1n, 2n)], [int(0n)], Z),
  },
];
