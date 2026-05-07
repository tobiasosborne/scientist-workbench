# tools/real-root-isolate

Rational isolating intervals for the real roots of a squarefree
univariate polynomial in ℚ[x] via Vincent-Akritas-Strzebonski + LMQ.

## Surface

```sh
echo '{"f": "...", "var": "x"}' | bun tools/real-root-isolate/tool.ts
```

Input record:

```jsonc
{
  "f": <expression in `var` over ℚ>,
  "var": <symbol>
}
```

Output (happy path):

```jsonc
{
  "intervals": [
    {"lo": <expression: integer or `n/d`>, "hi": ...},
    ...
  ],
  "method": "vas-lmq",
  "warnings": []
}
```

Output (boundary):

```jsonc
{
  "kind": "tagged",
  "tag":  "real-root-isolate/{not-squarefree,non-polynomial,multivariate}",
  "payload": {"detail": "..."}
}
```

## Examples

```sh
# x³ - 3x + 1 (casus irreducibilis: 3 real, all irrational)
$ echo '{"f": {"kind": "expression", ...x^3 - 3x + 1...}, "var": {"kind": "symbol", "name": "x"}}' \
    | bun tools/real-root-isolate/tool.ts
# → 3 open intervals: (-2, -1), (0, 1), (1, 2)

# (x - 1)(x - 2)(x - 3): 3 rational roots
# → 3 singletons: (1, 1), (2, 2), (3, 3)

# (x - 1)²: not squarefree
# → tagged "real-root-isolate/not-squarefree"
```

## Two interval shapes

The candidate emits two interval forms per entry:

- **Open `(lo, hi)`** when `lo < hi`: brackets one *irrational* real
  root. Neither endpoint is a root.
- **Singleton `(r, r)`** when `lo == hi`: names one *rational* root
  exactly.

The composing `tools/solve` (univariate-poly lane) and the bench's
verifier handle both forms uniformly via the open + singleton boundary
correction (`count_roots(lo, hi) − [f(lo) = 0] − [f(hi) = 0]`).

## Squarefree precondition

VAS requires squarefree input. Caller composes:

```
factor → squareFree → real-root-isolate per factor → re-attach mult
```

Non-squarefree input refuses with
`tagged "real-root-isolate/not-squarefree"`. The squarefreeness check
is `gcd(f, f') == constant` (degree 0 in `var`). Composing with
`packages/poly-factor::squareFree` (Yun 1976) is the canonical
pipeline.

## Algorithm

See `packages/real-roots/README.md` for the algorithm details. This
tool is a thin wire-protocol wrapper around `isolateRealRoots(coeffs)`:
parse the input record, validate (squarefree, polynomial, single
variable), extract coefficients via `valueToRatFn`, call the package,
build the output record.

## Bench

Validated against `bench/real-root-isolate/` (37-case 7-tier battery;
9-mutation RED gate; triple-witness via SymPy + Wolfram count
agreement). See `bench/real-root-isolate/PROMPT.md` for the full
verifier contract.

## Bead

`scientist-workbench-rra` (this tool ships the package; a companion
shard for the tool itself follows). Worklog 059.

## Output shape rationale

The intervals shape `{lo, hi}` preserves rational endpoints exactly —
no float, no string-encoded approximation. `lo` and `hi` are
expression Values: `int(n)` for integer endpoints, `expr("/", [int(n),
int(d)])` for fractions. Downstream consumers (e.g., `tools/solve`'s
univariate-poly lane composing with `tools/poly-roots`) round-trip the
endpoints exactly.

## Hard constraints

- Pure TypeScript on Bun. No FFI.
- Default symbolic determinism tier (ADR-0015 default) — bit-identical
  cross-platform forever.
- No tolerances anywhere; all arithmetic is rational.
- Boundary categories per ADR-0003: tagged refusals listed above;
  `ToolError` for malformed input only (`var` not a symbol, the input
  record missing required fields, the input being the zero polynomial).
