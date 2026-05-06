# poly-roots

Symbolic radical roots of univariate polynomials over ℚ for degree ≤ 4.
Composes `tools/poly-factor` with closed-form formulas (linear,
quadratic, Cardano 1545 cubic, Ferrari 1540 quartic) to return the
exact roots of `f` as expression Values in the closed numerical
vocabulary (`+ − * / ^ neg sqrt`). Output is `(-1 + √5)/2`, never
`0.6180339887...` — composable with `cas-diff`, `integrate-1d`, and
the rest of the symbolic stack.

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
  method, warnings }`. Each `root` is an expression Value in the
  closed vocabulary. Multiplicity is inherited from the irreducible
  factor.
* **Boundary tags** —
  - `tagged "poly-roots/degree-too-high"` — irreducible factor of
    degree ≥ 5 (Galois 1832: no general radical formula). Lifting
    this cap is bead `scientist-workbench-yoc` (Root[]).
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
   - deg ≥ 5 — refuse with `poly-roots/degree-too-high`.
5. **Inherit multiplicity** from each factor.

## Casus irreducibilis

Cubic with three real roots and `(q/2)² + (p/3)³ < 0`: Cardano's
formula needs cube roots of complex numbers even though the answer
ends real. Per the bead's contract this tool emits the formula
faithfully (`sqrt(negative)` and `^(1/3)` of complex values) rather
than switching to the trigonometric formula. Numerical evaluation
yields NaN; a downstream `ToReal` simplifier can recover real values.
The trade-off keeps the symbolic-radical contract honest and the
output composable.

## Invariants

- **deterministic** — same input bytes → same output bytes (symbolic
  tier per ADR-0015; bit-identical cross-platform forever).
- **factor-then-radicals** — every reducible polynomial is factored
  via `tools/poly-factor` first; each radical solver receives an
  irreducible factor.
- **multiplicity-preserves-count** — for `f = ∏ p_i^{e_i}`, the output
  has `Σ_i (deg p_i · e_i)` root entries.
- **deg-leq-4-supported** — every irreducible factor of degree 1..4
  produces concrete root expressions; degree ≥ 5 produces
  `tagged "poly-roots/degree-too-high"`.

## Run

```sh
# x² − 5x + 6 ⟹ roots 2, 3
echo '{"kind":"record","fields":{"f":{"kind":"expression","head":"+","args":[{"kind":"expression","head":"^","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"2"}]},{"kind":"expression","head":"*","args":[{"kind":"integer","value":"-5"},{"kind":"symbol","name":"x"}]},{"kind":"integer","value":"6"}]},"var":{"kind":"symbol","name":"x"}}}' \
  | bun tools/poly-roots/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## References

- Cardano, *Ars Magna* (1545) — the cubic formula.
- Ferrari (in *Ars Magna*) — quartic via resolvent cubic.
- Galois 1832 — no general radical formula for degree ≥ 5.
- Cox, *Galois Theory*, ch. 1-2.
