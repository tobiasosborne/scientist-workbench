# integrate-1d

Compute `∫_a^b f(x) dx` for a finite real interval and a closed-form
integrand expression. The second numerical-tier tool in
scientist-workbench (ADR-0014 / ADR-0015). Returns *not just* `value`
but a record carrying a calibrated error estimate, the number of `f`
evaluations spent, an honest `converged` boolean, and human-readable
warnings — everything an agent's planner needs to decide whether to
trust the answer or retry with a higher budget.

Library surface (TS-side, no JSON):

```ts
import { gaussKronrodAdaptive } from "@workbench/quadrature";
const r = gaussKronrodAdaptive(Math.sin, 0, Math.PI);
//  r.value ≈ 2, r.errorEstimate ≈ 0, r.converged === true
```

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "f":   <expression>,                        // integrand, closed vocabulary
    "var": {"kind": "symbol", "name": "x"},     // integration variable
    "a":   {"kind": "float64", "bits": "..."},  // lower bound
    "b":   {"kind": "float64", "bits": "..."}   // upper bound
  }
}
```

The integrand `f` is a `Value` tree over the closed vocabulary admitted
by `@workbench/quadrature`'s `evalNumericExpr`:

- **Heads:** `+`, `-`, `*`, `/`, `^`, `neg`, `exp`, `sin`, `cos`,
  `tan`, `log`, `sqrt`, `abs`, `asin`, `acos`, `atan`, `sinh`, `cosh`,
  `tanh`, `asinh`, `acosh`, `atanh`, `log2`, `log10`.
- **Constants:** `pi`, `e`.
- **Numeric leaves:** `integer`, `rational`, `float64`.
- **Variable:** any `symbol` matching the `var` field; other symbols
  → `ToolError`.

`log` is natural log; `log2` and `log10` are explicit-base sister
heads. Inverse trig (`asin`/`acos`/`atan`) and inverse hyperbolic
(`asinh`/`acosh`/`atanh`) integrands evaluate as `Math.*`; out-of-
domain inputs (e.g. `asin(2)`, `acosh(0.5)`) surface as `non-finite-
during-eval` boundary tags at the first quadrature node where they
trip.

Bounds must be finite IEEE-754 binary64; `a < b` strictly. `a >= b`
returns the `degenerate-interval` boundary tag (the tool refuses the
silent sign-flip convention so an agent never loses the chance to
spot a calling-bug).

## Output

Three shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "value":          {"kind": "float64", ...},      // best estimate of the integral
    "error_estimate": {"kind": "float64", ...},      // conservative upper bound
    "n_evals":        {"kind": "integer", "value": "..."},
    "converged":      {"kind": "boolean", "value": true|false},
    "iterations":     {"kind": "integer", "value": "..."},
    "method":         {"kind": "string", "value": "gauss-kronrod-g7k15"},
    "warnings":       {"kind": "list", "items": [<strings>]}
  }
}
```

`converged` is a *field*, not a separate boundary category — same
pattern as `linalg-solve`'s `condition_estimate` / `warnings`. A
planner that sees `converged: false` reads the warning, decides
whether to retry with a higher `maxEvals` budget, accept the value
with the reported error bound, or warn the user.

**Boundary failure — tagged:**

```jsonc
{"kind":"tagged","tag":"integrate-1d/non-finite-during-eval",
 "payload":{"kind":"record","fields":{"at_x":{"kind":"float64",...},
                                     "value":{"kind":"string","value":"Infinity"|"NaN"|"-Infinity"}}}}
```

Emitted when the integrand produces NaN / +Inf / −Inf at any
quadrature node (e.g. an interior pole, `log(negative)`,
`sqrt(negative)`). Payload carries the offending `x` and a string
description of what was produced.

```jsonc
{"kind":"tagged","tag":"integrate-1d/degenerate-interval",
 "payload":{"kind":"record","fields":{"a":{"kind":"float64",...},"b":{"kind":"float64",...}}}}
```

Emitted when `a >= b` (both `a > b` and `a == b` qualify).

**Malformed input — `ToolError` (exit 1):**

- Integrand contains a head outside the admitted vocabulary
  (suggestion lists the admitted heads).
- Integrand references a free symbol not equal to `var` and not in
  `pi` / `e` (suggestion lists the admitted constants and the
  declared variable).
- `a` or `b` is non-finite (NaN / ±Inf) at input time.
- `var` is not a `symbol` (caught by schema validation).

## How

QUADPACK-style adaptive Gauss-Kronrod G7K15 with global priority-
queue bisection. Local rule: 15-point Kronrod (algebraically exact for
polynomials of degree ≤ 23) with the embedded 7-point Gauss as the
error reference; difference `|K15 − G7| · halfLength` is the local
truncation-error estimate. Global driver: max-heap on local error,
bisect the worst subinterval, update running totals by delta. Constants
verbatim from GSL `qk15.c`. See `packages/quadrature/src/gauss-kronrod.ts`
for the literate algorithmic prose and the citation chain.

References: Piessens, de Doncker, Überhuber & Kahaner, *QUADPACK*
(1983); Galassi et al., *GNU Scientific Library Reference Manual*
§16.4; Kahaner, Moler & Nash, *Numerical Methods and Software* (1989,
Ch. 5).

## Out of scope (v0.1, all deliberate)

- Infinite intervals / improper integrals (Gauss-Hermite,
  Gauss-Laguerre would be sister tools).
- Vector-valued or complex integrands.
- Higher-dimensional integration (cubature).
- Symbolic anti-derivatives.
- Integrand vocabulary beyond the admitted heads / constants —
  extension is additive when motivated.
- Cross-platform bit-identity guarantee. ADR-0015's `numerical: true`
  applies: the tool's output bytes are bit-identical *given the
  platform fingerprint* `{arch, os, runtime}`. The fingerprint is
  recorded on every successful run; `runMemoized` skips cache hits
  whose platform doesn't match.

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes (single platform; ADR-0015 platform fingerprint recorded in
  provenance).
- **scipy-quadpack-agreement**: for every case in
  `tools/integrate-1d/reference/manifest.json`, the reported value
  agrees with the SciPy QUADPACK ground truth within the per-category
  tolerance (or `converged: false` is reported honestly). Enforced
  by the `--test` hook before goldens are written.
- **honest-converged-flag**: `converged: true` ⇒ `error_estimate ≤
  atol + rtol·|value|`; `converged: false` ⇒ warnings list contains
  the budget message.
- **non-finite-tagged**: integrand producing NaN / Inf at any node →
  tagged `integrate-1d/non-finite-during-eval` — never silently
  wrong value.
- **degenerate-interval-tagged**: `a >= b` → tagged
  `integrate-1d/degenerate-interval` — never the silent sign-flip
  convention.
- **unknown-vocabulary-rejected**: integrand head outside the
  admitted vocabulary raises `ToolError` listing the admitted heads.

## The orthogonal-oracle ground truth

The manifest at `tools/integrate-1d/reference/manifest.json` (30 cases
generated by SciPy's `scipy.integrate.quad`, cross-validated against
`mpmath.quad` at 50-digit precision on the harder cases) is the
canonical correctness oracle. The tool's `--test` hook reads the
manifest and verifies agreement within the per-category tolerance
recommendations. Two cases (`19-near-sing-interior`,
`28-stress-ultra-narrow-gauss`) are flagged with
`reference_disagreement`: SciPy and mpmath disagree beyond expected
tolerance there. The `--test` hook accepts the SciPy value, the mpmath
value, *or* an honest `converged: false` report on those two cases.

The orchestrator generated the manifest; the implementation is
forbidden to "regenerate the manifest to make the tool pass."

## Run

```sh
echo '{"kind":"record","fields":{
  "f":{"kind":"expression","head":"sin","args":[{"kind":"symbol","name":"x"}]},
  "var":{"kind":"symbol","name":"x"},
  "a":{"kind":"float64","bits":"0000000000000000"},
  "b":{"kind":"float64","bits":"400921fb54442d18"}}}' \
  | bun tools/integrate-1d/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`

`--platform-fingerprint` (ADR-0015) emits the running `{arch, os,
runtime}` and its content hash without performing any work — used by
agent planners to decide cache admissibility before invoking.
