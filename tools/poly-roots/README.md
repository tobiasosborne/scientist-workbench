# poly-roots

Symbolic roots of univariate polynomials over ℚ. Composes
`tools/poly-factor` with closed-form formulas (linear, quadratic,
Cardano 1545 cubic, Ferrari 1540 quartic) for irreducible factors of
degree ≤ 4, returning radical expressions in the closed numerical
vocabulary (`+ − * / ^ neg sqrt`). For irreducible factors of
degree ≥ 5, where Galois 1832 forbids a general radical formula,
each real root is named by the value-protocol primitive
`Root[poly, k]` (ADR-0018). The output is exact — `(-1 + √5)/2`,
not `0.6180339887...`; `Root[x⁵ + x⁴ − 4x³ − 3x² + 3x + 1, 0]`,
not a numerical approximation. Composes with `cas-diff`,
`integrate-1d`, and the rest of the symbolic stack.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "f":   <expression in v>,
    "var": <symbol v>
  }
}
```

`f` parses to a polynomial in `v` over ℚ. Multivariate, rational-
function, and transcendental input is refused via boundary tags.

## Output

* **Happy path** — `record { roots: list<record{root, multiplicity}>,
  method, warnings }`. Each `root` is either:
  * an expression Value in the closed radical vocabulary (when its
    irreducible factor has degree ≤ 4); or
  * a `Root[poly, k]` expression (when its irreducible factor has
    degree ≥ 5; one entry per real root of the factor, in canonical
    sort order — see ADR-0018 §"Index k").
  Multiplicity is inherited from the irreducible factor. The
  `method` field reads `factor-then-radicals` when every factor
  used a radical formula, or `factor-then-radicals-or-root` when at
  least one factor was named via `Root[]`.
* **Boundary tags** —
  - `tagged "poly-roots/complex-roots-not-yet-named"` — irreducible
    factor of degree ≥ 5 has one or more *complex* roots. The
    `@workbench/alg-num` substrate (v0.1) names *real* algebraic
    numbers only; complex algebraic naming requires planar
    complex-root isolation (Pinkert / Pan-Sevriuk), tracked as a
    future shard. Until then, mixed-real-complex deg-≥5 factors
    refuse honestly rather than producing a half-named answer.
  - `tagged "poly-roots/multivariate"` — input mentions a non-`var`
    symbol.
  - `tagged "poly-roots/non-polynomial"` — input is not a polynomial
    in `var` over ℚ (transcendental head, rational function, etc.).

`ToolError` for malformed input only (the zero polynomial; `var` not a
symbol; …).

## How

1. **Convert** `f` from expression Value → `Poly<Rat>` via
   `valueToRatFn` (in `@workbench/cas-core`); refuse on out-of-scope
   subterms.
2. **Multivariate refusal** if `polyVars(f)` mentions anything beyond
   `var`.
3. **Factor** via `tools/poly-factor` — every irreducible factor is
   monic, primitive, positive-leading, irreducible over ℚ.
4. **Dispatch on degree**:
   - deg 1 — `linearRoot(a, b)` ⟹ `−b/a` exact.
   - deg 2 — `quadraticRoots(a, b, c)` ⟹ `(−b ± √(b² − 4ac)) / (2a)`.
   - deg 3 — `cubicRoots(a, b, c, d)` via Cardano, *faithful complex
     form* per ADR-1yu (no trig switch in casus irreducibilis).
   - deg 4 — `quarticRoots(a, b, c, d, e)` via Ferrari + biquadratic
     fast path.
   - deg ≥ 5 — canonicalise the factor to ℤ[x] form
     (`@workbench/alg-num.canonicalIntegerForm`); enumerate real
     roots via VAS-LMQ (`@workbench/real-roots.isolateRealRoots`).
     If `realCount = deg` (all roots real), emit `deg` `Root[poly, k]`
     values with `k = 0..deg-1` (ascending real order). If
     `realCount < deg` (one or more complex roots), refuse with
     `poly-roots/complex-roots-not-yet-named`.
5. **Inherit multiplicity** from each factor.

## Casus irreducibilis

Cubic with three real roots and `(q/2)² + (p/3)³ < 0`: Cardano's
formula needs cube roots of complex numbers even though the answer
ends real. Per the bead's contract this tool emits the formula
faithfully (`sqrt(negative)` and `^(1/3)` of complex values) rather
than switching to the trigonometric formula. Numerical evaluation
yields NaN; a downstream `ToReal` simplifier can recover real values.
The trade-off keeps the symbolic-radical contract honest and the
output composable. The deg-≥5 `Root[]` path is the strictly better
long-term answer (interval refinement converges to a real value), but
for deg ≤ 4 the radical form is preferred because radicals compose
with `cas-simplify`.

## Invariants

- **deterministic** — same input bytes → same output bytes (symbolic
  tier per ADR-0015; bit-identical cross-platform forever).
- **factor-then-dispatch** — every reducible polynomial is factored
  via `tools/poly-factor` first; each radical solver receives an
  irreducible factor of degree 1..4, and each `Root[]`-naming path
  receives an irreducible factor of degree ≥ 5.
- **multiplicity-preserves-count** — for `f = ∏ p_i^{e_i}`, the output
  has `Σ_i (deg p_i · e_i)` root entries.
- **deg-leq-4-radicals** — every irreducible factor of degree 1..4
  produces concrete root expressions in the closed radical
  vocabulary.
- **deg-geq-5-named-when-real** — every irreducible factor of degree
  ≥ 5 with all-real roots produces (deg) `Root[poly, k]` values; a
  factor with one or more complex roots refuses with
  `poly-roots/complex-roots-not-yet-named`.

## Run

```sh
# x² − 5x + 6 ⟹ roots 2, 3
echo '{"kind":"record","fields":{"f":{"kind":"expression","head":"+","args":[{"kind":"expression","head":"^","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"2"}]},{"kind":"expression","head":"*","args":[{"kind":"integer","value":"-5"},{"kind":"symbol","name":"x"}]},{"kind":"integer","value":"6"}]},"var":{"kind":"symbol","name":"x"}}}' \
  | bun tools/poly-roots/tool.ts
```

```sh
# x⁵ + x⁴ − 4x³ − 3x² + 3x + 1 (Lehmer's L(x), totally real, irreducible)
# ⟹ 5 Root[] values sharing the canonical minpoly, k = 0..4.
echo '{"kind":"record","fields":{"f":{"kind":"expression","head":"+","args":[{"kind":"expression","head":"^","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"5"}]},{"kind":"expression","head":"^","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"4"}]},{"kind":"expression","head":"*","args":[{"kind":"integer","value":"-4"},{"kind":"expression","head":"^","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"3"}]}]},{"kind":"expression","head":"*","args":[{"kind":"integer","value":"-3"},{"kind":"expression","head":"^","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"2"}]}]},{"kind":"expression","head":"*","args":[{"kind":"integer","value":"3"},{"kind":"symbol","name":"x"}]},{"kind":"integer","value":"1"}]},"var":{"kind":"symbol","name":"x"}}}' \
  | bun tools/poly-roots/tool.ts
```

## Validation

`bench/poly-roots-radical/` — 50-case golden battery (ADR-0019 §1
bench discipline), seven tiers:

| Tier | Cases | Description |
|---|---|---|
| A — linear | ~5 | deg 1; exact rational root |
| B — quadratic | ~8 | deg 2; `(−b ± √D) / 2a` |
| C — cubic incl. casus irreducibilis | ~10 | Cardano; three-real case emits cube-roots-of-complex faithfully |
| D — quartic Ferrari | ~8 | Ferrari + biquadratic fast path |
| E — reducible | ~8 | product of lower-degree factors; multiplicities |
| F — numeric stress | ~6 | deg-≥5 all-real (Root[] path); Lehmer and similar totally-real polynomials |
| G — refusals | ~5 | multivariate, non-polynomial, complex-roots-not-yet-named |

**ADR-0019 §1 4-check verifier:** shape, root-count-matches-degree,
reconstruction (`f(root) ≈ 0` for all radical roots), and tag-envelope
for refusal cases.

**8 mutation perturbations**: sign flip on root value, wrong
multiplicity, transposed radical sub-expression, missing root, extra
root, wrong refusal tag, off-by-one Root-index `k`, wrong factor count
from `poly-factor`. All 8 cause RED.

**Triple-witness:** `bench/_corpus/oracle/` houses Wolfram + SymPy
cross-validation scripts; every case in the corpus agrees at the
comparison threshold.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## References

- Cardano, *Ars Magna* (1545) — the cubic formula.
- Ferrari (in *Ars Magna*) — quartic via resolvent cubic.
- Galois 1832 — no general radical formula for degree ≥ 5.
- Cox, *Galois Theory*, ch. 1-2.
- ADR-0018 — `Root[poly, k]` value-protocol primitive (the deg-≥5
  naming model: Mathematica `Root[]` / SageMath `qqbar`).
- ADR-1yu — casus irreducibilis: faithful complex form.
- Vincent-Akritas-Strzebonski (VAS-LMQ) — real-root isolation
  (`@workbench/real-roots`, port of SymPy `dup_isolate_real_roots_sqf`).
