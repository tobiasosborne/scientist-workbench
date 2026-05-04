# optimize-lbfgs-projected

Smooth bound-constrained minimisation:

    argmin_{lower ≤ x ≤ upper}  f(x)

The third numerical-tier tool in scientist-workbench (ADR-0014 /
ADR-0015), after `linalg-solve` (LU + iterative refinement) and
`integrate-1d` (adaptive Gauss-Kronrod). Returns *not just* `x` but
a record carrying the gradient at the solution, the projected-
gradient infinity norm (the honest stopping criterion at active
bounds), iteration / evaluation counts, an honest `success`
boolean, a status code mirroring scipy's L-BFGS-B taxonomy,
BFGS-skip / line-search-fail / active-bound counters, and human-
readable warnings — everything an agent's planner needs to decide
whether to trust the answer or retry with a higher budget.

Library surface (TS-side, no JSON):

```ts
import { lbfgsProjected } from "@workbench/lbfgs-projected";

const r = lbfgsProjected(
  (x) => 100 * (x[1] - x[0] ** 2) ** 2 + (1 - x[0]) ** 2,
  (x) => new Float64Array([
    -400 * x[0] * (x[1] - x[0] ** 2) - 2 * (1 - x[0]),
     200 * (x[1] - x[0] ** 2),
  ]),
  new Float64Array([-1.2, 1.0]),                                    // x0
  new Float64Array([-Infinity, -Infinity]),                          // lower
  new Float64Array([+Infinity, +Infinity]),                          // upper
);
//  r.x       ≈ [1, 1]
//  r.fun     ≈ 0
//  r.success === true
```

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "f":      <expression>,                            // closed vocabulary
    "grad":   {"kind":"list", "items":[<expression>]}, // one component per variable
    "vars":   {"kind":"list", "items":[<symbol>]},     // declaration order
    "x0":     {"kind":"list", "items":[<float64>]},    // starting point
    "bounds": {"kind":"list", "items":[                // each [lo, hi] pair
                {"kind":"list", "items":[<float64>, <float64>]}
              ]},
    "options": <record>?                               // optional, see below
  }
}
```

`f` and each `grad[i]` is an expression over the closed vocabulary
admitted by `@workbench/quadrature`'s `evalNumericExpr`:

- **Heads:** `+`, `-`, `*`, `/`, `^`, `neg`, `exp`, `sin`, `cos`,
  `tan`, `log`, `sqrt`, `abs`.
- **Constants:** `pi`, `e`.
- **Numeric leaves:** `integer`, `rational`, `float64`.
- **Variables:** any symbol in the `vars` list; other free symbols
  → `ToolError`.

`x0` must be **finite** (NaN / ±Inf at input → `ToolError`) and
**inside the declared bounds** (strictly outside → tagged
`x0-outside-bounds` boundary). Unbounded directions are encoded as
`-Infinity` / `+Infinity` in the bounds pair (this is the wire-form
analogue of scipy's `None`). A pair with `lower > upper` produces
the `infeasible-bounds` boundary tag.

The optional `options` record admits exactly six keys:

| key | type | default | meaning |
|---|---|---|---|
| `maxcor` | integer | 10 | L-BFGS history depth |
| `ftol` | float64 | `1e7 · ε_machine` | relative-f-reduction tolerance |
| `gtol` | float64 | `1e-5` | projected-gradient infinity-norm tolerance |
| `maxiter` | integer | 15000 | maximum L-BFGS iterations |
| `maxfun` | integer | 15000 | maximum f + grad evaluations |
| `maxls` | integer | 20 | maximum line-search trial steps |

Unknown option keys → `ToolError`. Out-of-range values (e.g.
`maxiter ≤ 0`) → `ToolError`.

## Output

Three shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind":"record",
  "fields":{
    "x":                       {"kind":"list","items":[<float64>...]},
    "fun":                     {"kind":"float64",...},
    "jac":                     {"kind":"list","items":[<float64>...]},
    "grad_inf_norm":           {"kind":"float64",...},
    "iterations":              {"kind":"integer","value":"..."},
    "nfev":                    {"kind":"integer","value":"..."},
    "status":                  {"kind":"integer","value":"0|1|2|3|4"},
    "status_message":          {"kind":"string","value":"..."},
    "success":                 {"kind":"boolean","value":true|false},
    "bfgs_skip_count":         {"kind":"integer","value":"..."},
    "line_search_fail_count":  {"kind":"integer","value":"..."},
    "active_bounds_count":     {"kind":"integer","value":"..."},
    "method":                  {"kind":"string","value":"l-bfgs-projected"},
    "warnings":                {"kind":"list","items":[<string>...]}
  }
}
```

`status` mirrors scipy's L-BFGS-B taxonomy plus a line-search-failure code:

| status | meaning | success |
|---|---|---|
| 0 | converged on projected-gradient norm (`gtol`) | true |
| 1 | converged on relative-f-reduction (`ftol`) | true |
| 2 | max iterations reached | false |
| 3 | max function evaluations reached | false |
| 4 | line search failed | false |

`success` is a *field*, not a separate boundary category — same
shape pattern as `linalg-solve`'s `condition_estimate` and
`integrate-1d`'s `converged`. A planner that sees `success: false`
reads `status` and `warnings` and decides whether to retry with a
higher budget, accept the partial result, or warn the user.
**Budget exhaustion is the happy-path RECORD with `success: false`,
NOT a separate boundary tag** — scipy reports it through the same
`OptimizeResult` shape, and an agent's planner reads it identically.

**Boundary failure — tagged:**

```jsonc
{"kind":"tagged","tag":"optimize-lbfgs-projected/infeasible-bounds",
 "payload":{"kind":"record","fields":{
    "variable":{"kind":"integer","value":"<i>"},
    "lower":   {"kind":"float64",...},
    "upper":   {"kind":"float64",...}}}}

{"kind":"tagged","tag":"optimize-lbfgs-projected/x0-outside-bounds",
 "payload":{"kind":"record","fields":{
    "variable":{"kind":"integer","value":"<i>"},
    "x0":      {"kind":"float64",...},
    "lower":   {"kind":"float64",...},
    "upper":   {"kind":"float64",...}}}}

{"kind":"tagged","tag":"optimize-lbfgs-projected/non-finite-during-eval",
 "payload":{"kind":"record","fields":{
    "at":  {"kind":"list","items":[<float64>...]},   // the offending iterate
    "kind":{"kind":"string","value":"f-NaN|f-Infinity|grad-NaN|grad-Infinity|..."}}}}
```

The tool *refuses* to silently project x0 into feasibility on the
`x0-outside-bounds` case — that would mask a calling-convention bug.
Same discipline as `integrate-1d`'s refusal of the silent
sign-flip on reversed intervals.

**Malformed input — `ToolError` (exit 1):**

- `vars`, `x0`, `grad`, or `bounds` length disagree with `vars`.
- `vars` length zero.
- Any `x0[i]` is non-finite at input time (NaN / ±Inf).
- Any `bounds[i]` is not a 2-element list.
- Any bound is NaN.
- `f` or `grad` references an unknown head or unknown free symbol
  (suggestion lists the admitted vocabulary).
- `n > 200` (the v0.1 cap, matching `linalg-solve`'s ADR-0014
  discipline).
- Unknown `options` key.
- Out-of-range option value (e.g. `maxiter ≤ 0`).

## How

L-BFGS with active-set projection and More-Thuente-style line
search. See `packages/lbfgs-projected/src/lbfgs-projected.ts` for the literate
algorithmic prose, the citation chain (Byrd-Lu-Nocedal-Zhu 1995,
Morales-Nocedal 2011 v3.0, Nocedal 1980), and the v3.0 safeguards.

References:

- Byrd, Lu, Nocedal, Zhu, "A Limited Memory Algorithm for Bound
  Constrained Optimization", SIAM J. Sci. Comput. 16(5), 1995.
- Zhu, Byrd, Lu, Nocedal, "Algorithm 778: L-BFGS-B", ACM TOMS
  23(4), 1997.
- Morales, Nocedal, "Remark on Algorithm 778", ACM TOMS 38(1),
  Article 7, 2011.
- Nocedal, "Updating Quasi-Newton Matrices with Limited Storage",
  Math. Comp. 35, 1980.

## Out of scope (v0.1, all deliberate)

- Equality and general nonlinear constraints (sister tools
  `optimize-slsqp`, `optimize-trust-region` deferred).
- Bound-constrained least squares (`optimize-bvls` deferred).
- Finite-difference gradients (caller must supply analytic grad).
- Vector-valued or complex objectives.
- Vocabulary beyond `+ - * / ^ neg exp sin cos tan log sqrt abs`
  plus constants `pi`, `e` — extension would be additive.
- Cross-platform bit-identity guarantee. ADR-0015's `numerical:
  true` applies: the tool's output bytes are bit-identical *given
  the platform fingerprint* `{arch, os, runtime}`. The fingerprint
  is recorded on every successful run; `runMemoized` skips cache
  hits whose platform doesn't match.

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes (single platform; ADR-0015 platform fingerprint recorded
  in provenance).
- **scipy-l-bfgs-b-agreement**: for every value case in
  `tools/optimize-lbfgs-projected/reference/manifest.json`, `|reported f -
  manifest f| ≤ category tolerance` OR (reported f at-least-as-good
  AND projected gradient ≤ 10·gtol). The `--test` hook enforces.
- **honest-success-flag**: `success: true` ⇔ `status ∈ {0, 1}`;
  `status=0` ⇒ projected-gradient ≤ gtol; `status=1` ⇒ relative
  f-reduction ≤ ftol.
- **infeasible-bounds-tagged**: `lower[i] > upper[i]` ⇒ tagged
  `optimize-lbfgs-projected/infeasible-bounds` — never silent.
- **x0-outside-bounds-tagged**: `x0[i]` strictly outside its bound
  pair ⇒ tagged `optimize-lbfgs-projected/x0-outside-bounds` — never silent
  project-into-feasible.
- **non-finite-tagged**: `f` or `grad` returning NaN/±Inf ⇒ tagged
  `optimize-lbfgs-projected/non-finite-during-eval` — never silently wrong
  value.
- **unknown-vocabulary-rejected**: `f`/`grad` head or symbol outside
  the admitted vocabulary raises `ToolError` listing the admissible
  heads/constants.

## The orthogonal-oracle ground truth

The manifest at `tools/optimize-lbfgs-projected/reference/manifest.json` (25
cases generated by SciPy 1.14.1's `scipy.optimize.minimize(method=
"L-BFGS-B")`, which wraps the Northwestern Fortran v3.0 backend) is
the canonical correctness oracle. Tiers:

| tier | category | n | tolerance |
|---|---|---|---|
| A | smooth-easy | 1–5 | atol=1e-8, rtol=1e-8 |
| B | canonical (MGH classics) | 2–10 | atol=1e-6, rtol=1e-6 |
| C | active-set | 1–3 | atol=1e-6, rtol=1e-6 |
| D | ill-conditioned | 2–8 | atol=1e-3, rtol=1e-3 |
| E | convergence-honesty | 1–2 | exact success/status agreement |
| F | refusals | 1–2 | exact refusal-class agreement |
| G | speed-stress | 50–100 | atol=1e-4, rtol=1e-4 |

The orchestrator generated the manifest; the implementation is
forbidden to "regenerate the manifest to make the tool pass." The
`--test` hook runs every value case through the in-process algorithm
and asserts agreement; for the harder ill-conditioned cases (D3
Powell badly-scaled in particular) it accepts a candidate that
honestly converges to a *deeper* minimum than the reference, since
the manifest's documented tolerance note acknowledges that
"ill-conditioned problems may converge to a flatter region."

## Run

```sh
echo '{"kind":"record","fields":{
  "f":{"kind":"expression","head":"^","args":[
        {"kind":"expression","head":"-","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"3"}]},
        {"kind":"integer","value":"2"}]},
  "grad":{"kind":"list","items":[
        {"kind":"expression","head":"*","args":[{"kind":"integer","value":"2"},
         {"kind":"expression","head":"-","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"3"}]}]}]},
  "vars":{"kind":"list","items":[{"kind":"symbol","name":"x"}]},
  "x0":{"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"}]},
  "bounds":{"kind":"list","items":[
        {"kind":"list","items":[{"kind":"float64","bits":"fff0000000000000"},
                                {"kind":"float64","bits":"7ff0000000000000"}]}]}}}' \
  | bun tools/optimize-lbfgs-projected/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`

`--platform-fingerprint` (ADR-0015) emits the running `{arch, os,
runtime}` and its content hash without performing any work — used by
agent planners to decide cache admissibility before invoking.
