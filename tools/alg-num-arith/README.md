# alg-num-arith

Field arithmetic over named algebraic numbers (`Root[poly, k]`). Takes
one or two `Root[]` values and applies a chosen operation —
`add`, `sub`, `mul`, `div`, `neg`, `inv`, or `eq` — returning a
canonical `Root[]` value (arithmetic) or a `boolean` (equality).
The wire envelope around `@workbench/alg-num`'s in-memory arithmetic
substrate (worklog 062), so an agent composing tools can do
`wb.algNumArith({a, b}, {op: "add"})` exactly the way it does
`wb.modPow({base, exp, mod})`.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "a": <Root[poly, k] expression>,
    "b": <Root[poly, k] expression>   // omitted for unary ops (neg, inv)
  }
}
```

`a` is required for every op. `b` is required for binary ops
(`add`, `sub`, `mul`, `div`, `eq`) and rejected for unary ops
(`neg`, `inv`). The wire encoding follows ADR-0018:
`expression { head: "Root", args: [Polynomial[c_0, ..., c_n], k] }`
with integer coefficients in low-to-high order. Non-canonical inputs
(reducible minpoly, rational coefficients, negative leading
coefficient) are silently canonicalised on parse via
`@workbench/alg-num.valueToRoot`.

## Output

Three categories, mutually exclusive:

* **Arithmetic happy path** (`op ∈ {add, sub, mul, div, neg, inv}`) —
  the result `Root[poly, k]` value (canonical-form bytes).
* **Equality happy path** (`op == "eq"`) — `boolean { value: bool }`.
* **Boundary refusal** — `tagged "alg-num-arith/<class>"` with payload
  `record { detail: string }`. Two classes:
  - `alg-num-arith/inv-of-zero` — `op = inv` with `a` representing
    zero.
  - `alg-num-arith/div-by-zero` — `op = div` with `b` representing
    zero.

`ToolError` is reserved for malformed input: missing `a`; `a` or
`b` not a `Root[]` expression; `b` missing on a binary op; `b`
present on a unary op.

## How

1. Wire-decode `a` (and `b` when present) via
   `@workbench/alg-num.valueToRoot`. Non-canonical inputs are
   silently canonicalised.
2. Dispatch on `op` to the substrate function:
   - `add` → `algNumAdd(a, b)` — minpoly via
     `squarefree(Res_y(f_a(y), f_b(x − y)))` (ADR-0018 §"Arithmetic";
     Cohen GTM 138 §3.6.2).
   - `sub` → `algNumSub(a, b)` ≡ `add(a, neg(b))`.
   - `mul` → `algNumMul(a, b)` — minpoly via
     `squarefree(Res_y(y^{deg f_a} · f_a(x/y), f_b(y)))`.
   - `div` → `algNumDiv(a, b)` ≡ `mul(a, inv(b))` for `b ≠ 0`.
   - `neg` → `algNumNeg(a)` — coefficient sign-flip on odd powers,
     interval mirror.
   - `inv` → `algNumInv(a)` — coefficient reversal, interval inversion;
     refuses if `a == 0`.
   - `eq` → `rootCanonicalEq(a, b)` — minpoly byte-equality + index
     match, both inputs canonicalised on parse.
3. Wire-encode the result via `rootToValue`, or return a boolean
   for `eq`. Catch the substrate's "0 is not invertible" exception
   and translate to the boundary tag.

The substrate's full discipline (Sylvester-Bareiss for resultants,
canonicalisation via `factorRatQ` + interval-disambiguate, refine-
and-retry for ambiguous resultant intervals) lives in
`packages/alg-num/`. Worklog 062 is the design doc.

## Invariants

- **deterministic** — same input bytes + same op flag → same output
  bytes (symbolic tier per ADR-0015; bit-identical cross-platform
  forever).
- **field-closure** — for op ∈ {add, sub, mul, div, neg, inv},
  output is a canonical `Root[poly, k]` value (or a tagged refusal
  for div/inv by zero); never `tagged out-of-scope`. Algebraic
  numbers form a field over ℚ; the tool's outputs stay within it.
- **additive-inverse** — `add(a, neg(a))` is canonically equal to
  `Root[x, 0]` (i.e. the rational 0).
- **multiplicative-inverse** — `mul(a, inv(a))` is canonically equal
  to `Root[x − 1, 0]` (i.e. the rational 1) for `a ≠ 0`.
- **eq-reflexive** — `eq(a, a)` returns boolean `true` for every
  `Root[]` value `a`.

## Run

```sh
# √2 + √3 ⟹ Root[x⁴ − 10x² + 1, k=3]
echo '{"kind":"record","fields":{"a":{"kind":"expression","head":"Root","args":[{"kind":"expression","head":"Polynomial","args":[{"kind":"integer","value":"-2"},{"kind":"integer","value":"0"},{"kind":"integer","value":"1"}]},{"kind":"integer","value":"1"}]},"b":{"kind":"expression","head":"Root","args":[{"kind":"expression","head":"Polynomial","args":[{"kind":"integer","value":"-3"},{"kind":"integer","value":"0"},{"kind":"integer","value":"1"}]},{"kind":"integer","value":"1"}]}}}' \
  | bun tools/alg-num-arith/tool.ts --op=add
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Tool flags

`--op` (required) — operation to apply. One of `add`, `sub`, `mul`,
`div`, `neg`, `inv`, `eq`.

## References

- ADR-0018 — `Root[poly, k]` value-protocol primitive (canonical
  form, lazy isolating-interval semantics, equality semantics).
- `docs/worklog/062-alg-num-arithmetic.md` — alg-num resultant arithmetic substrate.
- Cohen, *A Course in Computational Algebraic Number Theory*
  (GTM 138), §3.6 (resultants).
- Bareiss 1968, *Sylvester's identity and multistep integer-
  preserving Gaussian elimination*, Math Comp 22.
- SageMath `qqbar` (`sage/rings/qqbar.py`) — closest open-source
  reference for lazy `(minpoly, interval)` algebraic-number
  arithmetic; the upstream design pattern for this tool's
  substrate.
- Bench `bench/alg-num-arith/` (bead `scientist-workbench-iay`) —
  triple-witness cross-validation against SymPy `qqbar`.
