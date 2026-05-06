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
  - `solve/high-degree-irreducible` — irreducible univariate factor of
    degree ≥ 5 (Galois 1832; Root[] is bead `yoc`).
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
     - deg ≥ 5 → refusal `solve/high-degree-irreducible`.

   Multiplicities preserved per factor: a triple root appears 3
   times in the `solutions` list (each as a separate one-binding
   `Solution`).

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

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Out of scope (v0.1)

- Multivariate non-zero-dim systems (Gröbner pending).
- Inequalities (`solve/inequality` reserved).
- Transcendental invert-and-substitute (`solve/transcendental-multibranch`
  reserved; bead `ii0` ships the substrate).
- Algebraic-extension coefficient rings.

## References

- ADR-0017 — solution-set value-protocol shape.
- Cox-Little-O'Shea, *Ideals, Varieties, and Algorithms* — Buchberger
  background for the multivariate path.
- Galois 1832 — quintic irreducibility precludes general radicals.
