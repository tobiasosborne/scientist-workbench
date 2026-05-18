// =============================================================================
// erfi-forward.ts — Erfi backward dispatch rule
// =============================================================================
//
// **Source.** R4 §1.b + §2.5.1 (`docs/refs/erf-research/R4-meijer-g-bridge.md`).
// Cross-validated against SymPy's `erfi._eval_rewrite_as_meijerg`
// (which returns `z/sqrt(pi)*meijerg([S.Half], [], [0], [Rational(-1,
// 2)], -z**2)`), diofant g-functions table, Wolfram MathWorld *Erfi*.
//
// **Form Erfi:** `erfi(z) = z/√π · G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}],
// −z²)`
//
//   * shape `(m, n, p, q) = (1, 1, 1, 2)`
//   * `an = [1/2]`, `ap = []`, `bm = [0]`, `bq = [-1/2]`
//   * z-substitution: `−z²` (the only discriminator vs Erf — see
//     `erf-forward-form-a.ts`)
//   * prefactor: `z/√π`
//
// **The Erf vs Erfi collision (R4 §2.5.1, ADR-0040 §"Decision 5").**
// Erf and Erfi share an *identical* parameter tuple. A pure slot-by-
// slot matcher cannot distinguish them; the disambiguator is the
// z-substitution sign. Forward bridges (in `bridges/erf.ts`) emit:
//   * Erf:  z-slot = `mkPower(z, 2)` — positive square, no leading neg.
//   * Erfi: z-slot = `mkNeg(mkPower(z, 2))` — wrapped in unary neg.
//
// The Erfi rule sets `zMatch: zIsExplicitlyNegated` so the dispatcher
// accepts Erfi-shaped inputs and declines Erf-shaped inputs. The Erf
// rule (`erf-forward-form-a.ts`) carries the complementary predicate
// (`zIsNotExplicitlyNegated`). The two predicates partition the
// z-argument space cleanly:
//
//   * `expr("neg", [..])` or unary `expr("-", [..])` → Erfi
//   * everything else (literals, raw `mkPower`, symbolic) → Erf
//
// This is the ADR-0040 Option 1 resolution (additive `PatternSpec.zMatch`
// extension), preferred over Option 3 (`always emit Erf, normalise to
// Erfi downstream`) because it preserves the Erfi head as a distinct
// vocabulary entry — which is the whole point of ADR-0040 §"Decision 6"'s
// amendment to admit Erfi (worklog 132, bead `m114`).

import { expr, rat, sym, type Value } from "@workbench/protocol";
import { mkDiv, mkPower, mkTimes } from "@workbench/cas-core";
import type { ReductionRule } from "../dispatch-types.js";

const PI = sym("pi");
const HALF = rat(1n, 2n);

/**
 * z-argument predicate: matches Erfi (NOT Erf). Erfi's forward bridge
 * emits a z-slot wrapped in an explicit unary `neg`; this predicate
 * accepts that shape and declines anything else. Mirrors
 * `zIsNotExplicitlyNegated` in `erf-forward-form-a.ts` — together they
 * form a clean two-way partition of the z-argument space for the
 * `(1, 1, 1, 2)` Erf/Erfi parameter tuple.
 */
function zIsExplicitlyNegated(z: Value): "yes" | "no" | "unknown" {
  if (z.kind !== "expression") return "no";
  if ((z.head === "neg" || z.head === "-") && z.args.length === 1) {
    return "yes";
  }
  return "no";
}

export const RULES: ReductionRule[] = [
  {
    id: "erfi-bridge",
    source:
      "R4 §1.b + §2.5.1 (SymPy erfi._eval_rewrite_as_meijerg, diofant)",
    note:
      "G^{1,1}_{1,2}([1/2]; [0], [-1/2] | −u) = √π/√u · Erfi(√u). " +
      "z-slot must be an explicit unary neg (distinguishes from Erf).",
    match: {
      mnpq: { m: 1, n: 1, p: 1, q: 2 },
      an: [{ kind: "lit-rat", num: 1, den: 2 }],
      ap: [],
      bm: [{ kind: "lit-int", value: 0 }],
      bq: [{ kind: "lit-rat", num: -1, den: 2 }],
      zMatch: zIsExplicitlyNegated,
    },
    rewrite: (_, z) => {
      // The G-function's input z-slot holds `−u` where `u = z²`. We
      // strip the leading `neg` to recover `u`, then emit `Erfi(√u)`
      // with prefactor `√π / √u` (the G-side prefactor).
      //
      // If the z-arg doesn't pattern-match `neg(inner)` (it shouldn't
      // reach here because zMatch declined; defensive guard included
      // so the rule doesn't silently produce a wrong-shaped AST if a
      // future caller bypasses zMatch).
      let inner: Value = z;
      if (z.kind === "expression" && (z.head === "neg" || z.head === "-") && z.args.length === 1) {
        inner = z.args[0]!;
      }
      const sqrtU = mkPower(inner, HALF);
      const sqrtPi = mkPower(PI, HALF);
      return mkDiv(mkTimes(sqrtPi, expr("Erfi", [sqrtU])), sqrtU);
    },
  },
];
