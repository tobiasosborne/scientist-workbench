# cas-diff

Compute `∂f/∂var` for an expression `f` over the closed numerical
vocabulary `{+ − * / ^ neg exp sin cos tan log sqrt abs asin acos atan
sinh cosh tanh asinh acosh atanh log2 log10}` plus constants `pi`, `e`. The output is itself an expression in the same
vocabulary, so it composes directly with `integrate-1d` (Leibniz-rule
parametric integrals) and with `optimize-lbfgs-projected` (which takes
`grad` as a list of expressions). Sister to `cas-simplify` —
differentiation, not simplification.

The motivating scenario, from
[`scripts/demo-min-integral.ts`](../../scripts/demo-min-integral.ts):
to optimise an integral `I(a) = ∫ p(x, a) dx` over `a`, you need
`∂p/∂a` as an expression. Without `cas-diff` the agent had to
hand-derive that gradient. With `cas-diff` it's one call.

Library surface (TS-side, no JSON):

```ts
import { differentiate, sym, expr, int } from "@workbench/cas-core";
const f = expr("^", [sym("x"), int(2n)]);              // x²
const dfdx = differentiate(f, sym("x"));               // 2·x
```

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "f":   <expression>,                       // closed-vocabulary expression
    "var": {"kind": "symbol", "name": "x"}     // differentiation variable
  }
}
```

The field name `f` mirrors `integrate-1d` and `optimize-lbfgs-projected`;
`var` is the same nomenclature as `integrate-1d`'s integration variable.

## Output

Two ADR-0003 categories — symbolic differentiation is total over its
declared scope, so there is no "non-finite" or "degenerate" boundary:

**Happy path — an expression Value:**

```jsonc
// d(x²)/dx = 2·x
{"kind":"expression","head":"*","args":[
  {"kind":"integer","value":"2"},
  {"kind":"symbol","name":"x"}]}
```

The output may be a literal (e.g., `d(7)/dx = 0`), a symbol
(`d(x)/dx = 1`), or any expression in the closed vocabulary.

**Boundary — `tagged "cas-diff/out-of-scope"`:**

```jsonc
{"kind":"tagged","tag":"cas-diff/out-of-scope",
 "payload":{"kind":"record","fields":{
    "f":  <original f>,
    "var":<original var>}}}
```

Triggered iff any subterm in `f` has an expression head outside the
rule table OR a Value whose top-level kind cas-diff doesn't interpret
as a mathematical scalar (string / list / record / tagged / boolean).
The payload echoes the entire original input record so an agent can
diagnose without reconstructing.

We refuse the *whole* input on any out-of-scope subterm rather than
embedding tagged sub-nodes inside an otherwise-valid result. The agent
gets a binary yes/no at the top level, which is what `optimize-lbfgs-
projected` and `integrate-1d` consumers want — they need either a
clean expression or a clean refusal, not a Frankenstein partial
derivative whose unknown subterms they have to walk.

## How

Single-pass recursive descent (see
`packages/cas-core/src/diff.ts` for the literate algorithm prose).
Rule table:

| input head | derivative |
|---|---|
| `+` (n-ary) | `+(da₁, …, daₙ)` |
| `-` (binary `a − b`) | `-(da, db)` |
| `-` (unary `-a`), `neg(a)` | `neg(da)` |
| `*` (n-ary) | product rule: `Σᵢ a₁·…·daᵢ·…·aₙ` |
| `/(a, b)` | quotient rule: `(da·b − a·db) / b²` |
| `^(a, b)`, b ⊥ wrt | power rule: `b · a^(b−1) · da` |
| `^(a, b)`, a ⊥ wrt | exp rule: `aᵇ · log(a) · db` |
| `^(a, b)`, both ∋ wrt | log-chain: `aᵇ · (db·log(a) + b·da/a)` |
| `exp(a)` | `exp(a) · da` |
| `log(a)` | `da / a` |
| `sin(a)` | `cos(a) · da` |
| `cos(a)` | `neg(sin(a)) · da` |
| `tan(a)` | `da / cos(a)²` |
| `sqrt(a)` | `da / (2·sqrt(a))` |
| `abs(a)` | `(a / |a|) · da` (singular at 0; correct on R\\{0}) |
| `asin(a)` | `da / sqrt(1 − a²)` (defined for `|a| < 1`) |
| `acos(a)` | `neg(da) / sqrt(1 − a²)` (defined for `|a| < 1`) |
| `atan(a)` | `da / (1 + a²)` |
| `sinh(a)` | `cosh(a) · da` |
| `cosh(a)` | `sinh(a) · da` (positive — not the dual of `cos`) |
| `tanh(a)` | `(1 − tanh(a)²) · da` |
| `asinh(a)` | `da / sqrt(1 + a²)` |
| `acosh(a)` | `da / sqrt(a² − 1)` (defined for `a > 1`) |
| `atanh(a)` | `da / (1 − a²)` (defined for `|a| < 1`) |
| `log2(a)` | `da / (a · log(2))` (change-of-base; `log` here is natural) |
| `log10(a)` | `da / (a · log(10))` |

Smart constructors absorb the chain rule's pure book-keeping:
`0 + x → x`, `1·x → x`, `x·0 → 0`, `x⁰ → 1`, `x¹ → x`,
`neg(neg(x)) → x`, `0 / x → 0`, `x / 1 → x`. No further reduction —
pipe through `cas-simplify` if you want full canonicalisation.

Reference: any standard CAS textbook. Cohen, *Computer Algebra and
Symbolic Computation: Mathematical Methods* (2003) §6 covers the rule
table and smart-constructor design at the level cas-diff implements.

## Invariants

- **deterministic**: same input bytes → same output bytes
  (`numerical: false`; symbolic tier per ADR-0015 — bit-identical
  cross-platform forever).
- **fd-cross-check**: for every in-scope corpus expression in the
  `--test` hook, `evalNumericExpr` of the cas-diff output agrees with
  a centred-finite-difference of the input at random points (relative
  error ≤ 1e-6). The orthogonal-oracle independent verification.
- **out-of-scope-tagged**: unknown expression head or non-arithmetic
  Value kind → top-level `tagged "cas-diff/out-of-scope"` with the
  original input as payload — never silently wrong derivative.
- **constant-vars-vanish**: `d(c)/dx = 0` for any `c` independent of
  `x` (other free symbols, `pi`, `e`, all numeric leaves). The agent
  can read free symbols other than the differentiation variable as
  parameters automatically.

## Out of scope (v0.1, all deliberate)

- Higher-order derivatives. Compose: `cas-diff(cas-diff(f, x), x)`
  yields `d²f/dx²`. No special tool needed.
- Multivariate gradient as a single call. The natural shape is one
  `cas-diff` per variable, then `list([df_dx, df_dy, …])` to feed
  into `optimize-lbfgs-projected`.
- Implicit differentiation. The `var` is named explicitly.
- Vocabulary beyond `+ − * / ^ neg exp sin cos tan log sqrt abs asin
  acos atan sinh cosh tanh asinh acosh atanh log2 log10` plus constants
  `pi`, `e` — extension is additive when motivated. (Same vocabulary as
  `integrate-1d` and `optimize-lbfgs-projected` — matched deliberately
  so the three tools compose without vocabulary
  mismatches.)
- Symbolic simplification of the result. The output uses smart
  constructors only; pipe through `cas-simplify` for full reduction.

## Run

```sh
echo '{"kind":"record","fields":{
  "f":{"kind":"expression","head":"^","args":[
        {"kind":"symbol","name":"x"},
        {"kind":"integer","value":"2"}]},
  "var":{"kind":"symbol","name":"x"}}}' \
  | bun tools/cas-diff/tool.ts
# {"kind":"expression","head":"*","args":[{"kind":"integer","value":"2"},{"kind":"symbol","name":"x"}]}
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

(No `--platform-fingerprint` — `cas-diff` is `numerical: false`,
symbolic tier; cross-platform output is bit-identical by construction.)
