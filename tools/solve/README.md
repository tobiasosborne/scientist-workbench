# solve

Top-level Mathematica `Solve[]`-class dispatcher (v0.1: linear /
univariate-poly lanes). Given a list of equations and a list of
unknowns, returns the solution set as a value-protocol-shaped record
per ADR-0017.

This is the user-facing entry point of solve-suite-v1: a single tool
covering the common univariate-polynomial case (radicals up to deg 4,
honest refusal at deg ≥ 5) and the linear-system-over-ℚ case (exact
Bareiss elimination, with sound under-determined and inconsistent
verdicts). Multivariate-non-zero-dim, transcendental, and parametric
inputs surface as boundary tags pending the relevant substrate
(Gröbner, transcendental invert-and-substitute, parametric branching).

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "eqs":  { "kind": "list", "items": [<expression>, ...] },
    "vars": { "kind": "list", "items": [<symbol>, ...] }
  }
}
```

Each `eq_i` is interpreted as `eq_i = 0` — the caller pre-reduces
`lhs == rhs` to `lhs - rhs`. Equations may be over the closed Q[x]
vocabulary `+ − * / ^` with integer / rational leaves and the
unknowns from `vars`. Heads outside this vocabulary (sin, exp, sqrt,
…) are out of scope.

## Output (ADR-0017)

* **Happy path** —
  ```
  record {
    vars:         list<symbol>,
    solutions:    list<Solution>,
    completeness: 'complete' | 'finite-rep-of-infinite',
    warnings:     list<string>,
  }
  ```
  where each `Solution` is `record { bindings, branches }`. Bindings
  are length-`vars` and aligned: `bindings[i] = { var: vars[i], value }`.
  Branches lists branch parameter symbols introduced for under-
  determined linear systems.

* **Boundary** — `tagged "solve/<class>"` with payload `record { detail: string }`.
  v0.1 class roster:
  - `solve/complex-roots-not-yet-named` — irreducible univariate factor
    of degree ≥ 5 has one or more complex roots that alg-num v0.1
    cannot yet name. (Real roots of an irreducible deg-≥5 factor are
    emitted as `Root[poly, k]` solutions on the happy path per
    ADR-0018; this refusal fires only for the mixed-real-complex
    case until complex algebraic naming ships.)
  - `solve/multivariate-non-zero-dim` — nonlinear multivariate
    polynomial system (Gröbner-basis dispatch is bead pending).
  - `solve/parametric-non-trivial` — equation mentions a symbol
    outside `vars`.
  - `solve/foreign-vocabulary` — head outside `+ − * / ^`, or
    rational-function input.
  - `solve/constant-equation` — single-variable case where the
    equation has no unknown (constant ≠ 0 ⟹ no solution; constant 0
    ⟹ every value, parametric in disguise).
  - `solve/empty-input`, `solve/empty-vars` — defensive checks for
    degenerate inputs.

`ToolError` for malformed input only: `eqs` not a list, `vars` not a
list of symbols.

## How

1. Parse each equation `eq_i` from expression Value to `Poly<Rat>` via
   `valueToRatFn` (in `@workbench/cas-core`); refuse with
   `solve/foreign-vocabulary` on out-of-scope subterms.
2. Refuse rational-function denominators.
3. Classify via `@workbench/solve::classifyInput`:
   - **linear** if every equation has total degree ≤ 1 in the
     unknowns AND no cross-variable products (`x · y`);
   - **univariate-poly** for single equation in single variable;
   - **unsupported** otherwise.
4. Dispatch via `@workbench/solve::dispatchClassified`:
   - linear → `bareissSolve` (exact ℚ via fraction-free Bareiss).
     Result mapped to ADR-0017 `Solution { bindings, branches }`
     with `branches` non-empty when under-determined.
   - univariate-poly → `factorRatQ` over ℚ, then per factor:
     - deg 1 → rational root.
     - deg 2 → `quadraticRoots` (formula).
     - deg 3 → `cubicRoots` (Cardano; faithful complex form per
       bead 1yu).
     - deg 4 → `quarticRoots` (Ferrari + biquadratic fast path).
     - deg ≥ 5 (all real roots) → one `Root[poly, k]` solution per
       real root in canonical sort order (ADR-0018; substrate
       `@workbench/alg-num` via `canonicalIntegerForm`,
       `polyToHighToLowRat`, `rootToValue`; real-root enumeration via
       `@workbench/real-roots::isolateRealRoots`).
     - deg ≥ 5 (one or more complex roots) → refusal
       `solve/complex-roots-not-yet-named`.

   Multiplicities preserved per factor: a triple root appears 3
   times in the `solutions` list (each as a separate one-binding
   `Solution`). For deg-≥5 Root[] solutions, a multiplicity-`m`
   factor produces `m` repeated copies of each root (mirroring the
   deg-≤4 multiplicity-as-repetition convention).

## Invariants

- **deterministic** — same input bytes → same output bytes (symbolic
  tier per ADR-0015; bit-identical cross-platform forever).
- **happy-path-shape** — happy-path output is a record `{ vars,
  solutions, completeness, warnings }` per ADR-0017.
- **branch-honest** — no silent principal-branch lossy answers; the
  tool either describes every solution (potentially via an integer-
  parameter family) or refuses with an honest boundary tag.
- **refusal-class-tag** — boundary refusals carry tag `solve/<class>`
  with payload `record { detail: string }`.

## Run

```sh
# Linear: x + y = 3, x − y = 1 ⟹ x=2, y=1
echo '{"kind":"record","fields":{"eqs":{"kind":"list","items":[{"kind":"expression","head":"+","args":[{"kind":"symbol","name":"x"},{"kind":"symbol","name":"y"},{"kind":"integer","value":"-3"}]},{"kind":"expression","head":"-","args":[{"kind":"expression","head":"-","args":[{"kind":"symbol","name":"x"},{"kind":"symbol","name":"y"}]},{"kind":"integer","value":"1"}]}]},"vars":{"kind":"list","items":[{"kind":"symbol","name":"x"},{"kind":"symbol","name":"y"}]}}}' \
  | bun tools/solve/tool.ts
```

## Transcendental lane (v0.1, shipped)

A fourth dispatch lane handles single-variable equations of the form
`head(x) = c` where `head ∈ {exp, log, sin, cos, tan, sinh, cosh, tanh, abs}`
and `c` is a numeric constant. Pattern-matched by `tryTranscendentalInvert`
in `packages/solve/src/transcendental.ts`. Multi-branched inverses (sin,
cos, tan) emit branch-parameter symbols `t_0`, `t_1`, … and the output's
`completeness` is `"finite-rep-of-infinite"`. Compound patterns
`head(g(x)) = c` with non-trivial `g` are out of scope; those refuse with
`tagged "solve/foreign-vocabulary"` and route to the future bead `37r`
(inversion by substitution heuristic). The `Out of scope (v0.1)` note
below corrects the earlier draft that treated this lane as deferred.

## Validation

`bench/solve/` — 100-case golden battery (ADR-0019 §1+§2 bench discipline):

- **20 hand-curated cases:** cross-validated against Mathematica v1 by
  hand, spanning the full class roster (linear underdetermined, linear
  inconsistent, deg-2/3/4 radicals, casus irreducibilis cubic, deg-≥5
  `Root[]`, transcendental single-branch / multi-branch, and each
  refusal tag).
- **80 stratified random cases:** generated and validated against triple
  witnesses (Wolfram, SymPy). Strata cover the same class distribution
  but at randomised coefficients.

**ADR-0019 §1+§2 4-lane dispatch verifier**: confirms that the tool's
dispatch classification matches the expected lane (linear / poly / trans /
refusal) for every case, then checks the output shape.

**8 mutation perturbations** per the mutation-prove discipline (CLAUDE.md
Rule 6): flipped solution sign, wrong completeness field, transposed
variable binding, missing branch parameter, root-index off by 1, wrong
refusal tag, spurious extra root, wrong content scalar. All 8 cause RED
in the verifier.

**Triple-witness:** Wolfram `Solve[]`, SymPy `solve()`, and the
hand-curated Mathematica-v1 reference all agree on the canonical
solution set for every committed case.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Out of scope (v0.1)

- Multivariate non-zero-dim systems (Gröbner pending).
- Inequalities (`solve/inequality` reserved).
- Compound transcendental patterns `head(g(x)) = c` with non-trivial `g`
  (bead `37r`; the simple `head(x) = c` case is shipped — see above).
- Algebraic-extension coefficient rings.

## References

- ADR-0017 — solution-set value-protocol shape.
- ADR-0018 — `Root[poly, k]` for deg-≥5 real roots.
- ADR-0019 — bench discipline.
- Cox-Little-O'Shea, *Ideals, Varieties, and Algorithms* — Buchberger
  background for the multivariate path.
- Galois 1832 — quintic irreducibility precludes general radicals.
