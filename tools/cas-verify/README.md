# cas-verify

Decide `A = B` as elements of `Q(x_1,…,x_n)`.

## Input

```json
{"kind":"record","fields":{"lhs": <expression>, "rhs": <expression>}}
```

## Output

| Case | Output |
|---|---|
| equal | `{equal: true}` |
| in-scope and unequal | `{equal: false, reason: "not-equal", witness: <lhs - rhs canonical form>}` |
| either side out-of-scope | `{equal: false, reason: "out-of-scope", side: "lhs"|"rhs", detail: "..."}` |

## How

Cross-multiplication: `a/b = c/d ⟺ a·d = c·b` as polynomials. Sound and complete because `Q[x_1,…,x_n]` is an integral domain. **No polynomial GCD required for the equality decision itself** — this tool's correctness has never depended on reduction. As of ADR-0013, `cas-simplify` also reduces rational functions, so the witness on inequality (`lhs − rhs`) is now in lowest terms.

## Invariants

- **soundness**: if `equal=true`, `lhs` and `rhs` denote the same element of `Q(x)`
- **completeness-in-scope**: if both sides are in scope and equal in `Q(x)`, returns `equal=true`
- **symmetry**: `verify(a,b) = verify(b,a)` (when both in-scope)
- **honest scope**: out-of-scope inputs return `{equal:false, reason:"out-of-scope"}`, never a wrong answer

## Run

```sh
LHS=$(echo '{"kind":"string","value":"(x^2-1)/(x-1)"}' | bun tools/expr-parse/tool.ts)
RHS=$(echo '{"kind":"string","value":"x + 1"}'        | bun tools/expr-parse/tool.ts)
echo "{\"kind\":\"record\",\"fields\":{\"lhs\":$LHS,\"rhs\":$RHS}}" \
  | bun tools/cas-verify/tool.ts
# → {"equal": true}
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
