# expr-parse

Plain-text math expression → expression value.

## Input

A `string` value.

```json
{"kind":"string","value":"(x + 1)*(x - 1)"}
```

## Output

An expression value (or a leaf integer/rational/symbol if the source has no operator).

## Grammar

```
expr   := add
add    := mul (('+'|'-') mul)*           — left-assoc, binary
mul    := unary (('*'|'/') unary)*        — left-assoc, binary
unary  := '-' unary | '+' unary | pow
pow    := atom ('^' unary)?               — right-assoc
atom   := number | identifier | '(' expr ')'
number := digits ('/' digits | '.' digits)?
ident  := [A-Za-z_][A-Za-z_0-9]*
```

LaTeX is out of scope (see PRD §9.2 — sister tool).

## Run

```sh
echo '{"kind":"string","value":"x + 1"}' | bun tools/expr-parse/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
