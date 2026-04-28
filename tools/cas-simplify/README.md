# cas-simplify

Canonicalise an expression value over Q[x_1,…,x_n] / Q(x_1,…,x_n).

## What it does

- Folds in-scope subtrees (heads `+ - * / ^` over symbols / integers / rationals) to a canonical sum-of-monomials form, or `num/den` for rational functions.
- Wraps out-of-scope subtrees (unknown heads, tagged values, strings, lists, etc.) in `tagged "cas-simplify/out-of-scope"`, with their children recursively simplified where possible.
- **Does not** reduce by polynomial GCD: `(x²−1)/(x−1)` stays as `(x²−1)/(x−1)`. Use `cas-verify` to decide that equality, or wait for `cas-reduce`.

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
