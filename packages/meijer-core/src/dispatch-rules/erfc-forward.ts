// =============================================================================
// erfc-forward.ts — Erfc backward dispatch rule
// =============================================================================
//
// **Source.** R4 §1.c (`docs/refs/erf-research/R4-meijer-g-bridge.md`).
// Cross-validated against SymPy's erfc (1-erf form), diofant g-functions
// table (single-G form), mpmath docs `meijerg([[],[a]], [[a-1, a-1/2],
// []], z, 0.5)` at `a=1`, and the Adamchik–Marichev / PBM Vol 3 §8.4
// lineage. The Wolfram Functions Site PDF was HTTP-403; triangulation
// through three independent open-source CASes pins the form.
//
// **Form Erfc:** `erfc(z) = (1/√π) · G^{2,0}_{1,2}([{}, {1}], [{0, 1/2},
// {}], z²)`
//
//   * shape `(m, n, p, q) = (2, 0, 1, 2)` — note `m = 2`, dual to Erf's
//     `m = 1`: both lower-poles enclosed (right-closing contour, the
//     Bessel-K-family shape).
//   * `an = []`, `ap = [1]`, `bm = [0, 1/2]`, `bq = []`
//   * z-substitution: `z²`
//   * prefactor: `1/√π` on the head's side; equivalently `√π` when
//     viewed from the G-side
//
// **Canonical bm order.** Per `dispatch.ts` §"Surprise", `canonicalize`
// sorts JSON record keys alphabetically, so `rational` Values (starting
// with `{"d`) sort BEFORE `integer` Values (`{"k`). The pattern's `bm`
// slot order therefore matches the *canonical-sorted* tuple
// `[rat(1, 2), int(0)]` rather than the literal `[0, 1/2]` written in
// the R4 source. The dispatcher canonicalises inputs before matching
// (`dispatch.ts::canonicaliseParams`), so a user-built form
// `[int(0), rat(1, 2)]` round-trips to the canonical order and the
// pattern fires.
//
// **No `zMatch` needed.** Erfc's parameter shape `(2, 0, 1, 2)` is
// unique among v0.1 dispatch rules — no other rule shares the slot
// tuple. The forward bridge always emits a positive `mkPower(z, 2)`
// z-substitution; the backward rule fires unconditionally on the shape.

import { expr, rat, sym } from "@workbench/protocol";
import { mkPower, mkTimes } from "@workbench/cas-core";
import type { ReductionRule } from "../dispatch-types.js";

const PI = sym("pi");
const HALF = rat(1n, 2n);

export const RULES: ReductionRule[] = [
  {
    id: "erfc-bridge",
    source:
      "R4 §1.c (SymPy 1-erf form + diofant g-functions single-G form + PBM Vol 3 §8.4)",
    note:
      "G^{2,0}_{1,2}(_; 1; 0, 1/2 | z) = √π · Erfc(√z). " +
      "Canonical-sorted bm: [rat(1,2), int(0)].",
    match: {
      mnpq: { m: 2, n: 0, p: 1, q: 2 },
      an: [],
      ap: [{ kind: "lit-int", value: 1 }],
      // bm canonical-sorted: rationals sort before integers in
      // canonical-bytes order (see file-top "Canonical bm order").
      bm: [
        { kind: "lit-rat", num: 1, den: 2 },
        { kind: "lit-int", value: 0 },
      ],
      bq: [],
    },
    rewrite: (_, z) => {
      // The G-function's input z-slot holds u = z² (per the forward
      // bridge's substitution). Un-substituted head argument is `√u`;
      // prefactor on the G-side is `√π`.
      const sqrtU = mkPower(z, HALF);
      const sqrtPi = mkPower(PI, HALF);
      return mkTimes(sqrtPi, expr("Erfc", [sqrtU]));
    },
  },
];
