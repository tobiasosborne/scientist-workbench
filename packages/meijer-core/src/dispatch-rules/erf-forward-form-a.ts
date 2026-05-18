// =============================================================================
// erf-forward-form-a.ts — Form A.Erf backward dispatch rule
// =============================================================================
//
// **Source.** R4 §1 + §2.5.1 (`docs/refs/erf-research/R4-meijer-g-bridge.md`),
// canonical SymPy / diofant / PBM Vol 3 §8.4 form. The Wolfram Functions
// Site formula ID would be `GammaBetaErf/Erf/26/01/` but those PDFs were
// HTTP-403 from this harness; the triangulation through SymPy +
// diofant + mpmath docs (all of which trace back to Adamchik-Marichev
// 1990 ISSAC / PBM Vol 3 §8.4) pins the form.
//
// **Form A.Erf:** `erf(z) = z/√π · G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], z²)`
//
//   * shape `(m, n, p, q) = (1, 1, 1, 2)`
//   * `an = [1/2]`, `ap = []`, `bm = [0]`, `bq = [-1/2]`
//   * z-substitution: `z²` (the wire `z` IS the substituted form, i.e.
//     `G([1/2], [], [0], [-1/2], u)` represents `Erf(√u) · √π / √u`)
//   * prefactor: `z/√π` on the head's side; equivalently `√π/√u` when
//     viewed from the G-side (per the un-substitution `u = z²`)
//
// **Why we ship Form A even though `dlmf-16-18-erf` (Form B) already
// exists.** The two forms are different G-functions: Form B has
// `an = [1]`, `bm = [1/2]`, `bq = [0]` and represents `√π · Erf(√u)`;
// Form A has `an = [1/2]`, `bm = [0]`, `bq = [-1/2]` and represents
// `√π/√u · Erf(√u)`. They are related by the parameter-shift identity
// DLMF 16.19.2 but NEITHER subsumes the other on the wire. The
// canonical "SymPy emits Form A" forward direction therefore needs the
// backward Form A rule for round-trip closure (see R4 §1.a, §4.b
// "Gap analysis"; the new bead `scientist-workbench-tc2c` lands this).
//
// **Erf vs Erfi disambiguation.** Erf and Erfi share an identical
// parameter tuple (`[1/2], [], [0], [-1/2]`); only the z-sub sign
// distinguishes. Form A.Erf sets `zMatch: zIsNotExplicitlyNegated` so
// the dispatcher routes z-slots like `+u²`, raw `mkPower(z, 2)`,
// symbolic `sym("z")`, or any literal-rational/integer to Erf — and
// declines (`"no"`) for explicitly-`neg`-wrapped z-slots, which fall
// through to the Erfi rule (`erfi-forward.ts`). This is the literal
// implementation of R4 §2.5.1 / ADR-0040 §"Decision 5" Option 1: a
// minimal predicate added to `PatternSpec`, additive, no existing
// rule disturbed.

import { expr, rat, sym, type Value } from "@workbench/protocol";
import { mkDiv, mkPower, mkTimes } from "@workbench/cas-core";
import type { ReductionRule } from "../dispatch-types.js";

const PI = sym("pi");
const HALF = rat(1n, 2n);

/**
 * z-argument predicate: matches Erf (NOT Erfi). Erf's forward bridge
 * emits a z-slot that is `mkPower(z, 2)` — never an explicit unary
 * `neg`. So we accept anything *except* an explicit top-level
 * `neg`/`-` expression. Note the conservative choice: a literal
 * `int(-4)` matches (it's not structurally negated; the bridge could
 * not have emitted it from any real argument). The Erfi forward path
 * always emits `expr("neg", [mkPower(z, 2)])`, so the structural
 * predicate is exact for round-tripped inputs.
 */
function zIsNotExplicitlyNegated(z: Value): "yes" | "no" | "unknown" {
  if (z.kind !== "expression") return "yes";
  if ((z.head === "neg" || z.head === "-") && z.args.length === 1) {
    return "no";
  }
  return "yes";
}

export const RULES: ReductionRule[] = [
  {
    id: "erf-bridge-form-a",
    source: "R4 §1 (SymPy / diofant / PBM Vol 3 §8.4 canonical)",
    note:
      "G^{1,1}_{1,2}([1/2]; [0], [-1/2] | z) = √π/√z · Erf(√z). " +
      "z-slot must not be an explicit unary neg (that's Erfi).",
    match: {
      mnpq: { m: 1, n: 1, p: 1, q: 2 },
      an: [{ kind: "lit-rat", num: 1, den: 2 }],
      ap: [],
      bm: [{ kind: "lit-int", value: 0 }],
      bq: [{ kind: "lit-rat", num: -1, den: 2 }],
      zMatch: zIsNotExplicitlyNegated,
    },
    rewrite: (_, z) => {
      // The G-function's input z-slot holds u = z² (per the forward
      // bridge's substitution). To emit the head's natural form, the
      // un-substituted argument is `√u`; the prefactor (on the G-side)
      // is `√π / √u`.
      const sqrtU = mkPower(z, HALF);
      const sqrtPi = mkPower(PI, HALF);
      return mkDiv(mkTimes(sqrtPi, expr("Erf", [sqrtU])), sqrtU);
    },
  },
];

