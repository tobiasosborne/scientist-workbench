# cas-simplify

Canonicalise an expression value over Q[x_1,…,x_n] / Q(x_1,…,x_n).

## What it does

- Folds in-scope subtrees (heads `+ - * / ^` over symbols / integers / rationals) to a canonical sum-of-monomials form, or `num/den` for rational functions in lowest terms.
- Wraps out-of-scope subtrees (unknown heads, tagged values, strings, lists, etc.) in `tagged "cas-simplify/out-of-scope"`, with their children recursively simplified where possible.
- **Reduces rational functions by polynomial GCD** (ADR-0013, since v0.3.0). `(x²−1)/(x−1)` simplifies to `x+1`; common factors are cancelled across num and den.

## Invariants

- **idempotent**: `simplify(simplify(v)) = simplify(v)`
- **deterministic**: same input bytes → same output bytes
- **foreign-pass-through**: out-of-scope subterms preserved verbatim inside the tagged wrapper

## Run

```sh
echo '{"kind":"string","value":"(x+1)*(x-1)"}' \
  | bun tools/expr-parse/tool.ts \
  | bun tools/cas-simplify/tool.ts
# → x^2 + (-1)
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
