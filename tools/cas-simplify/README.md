# cas-simplify

Canonicalise an expression value over Q[x_1,…,x_n] / Q(x_1,…,x_n).

## What it does

- Folds in-scope subtrees (heads `+ - * / ^` over symbols / integers / rationals) to a canonical sum-of-monomials form, or `num/den` for rational functions in lowest terms.
- Wraps out-of-scope subtrees (unknown heads, tagged values, strings, lists, etc.) in `tagged "cas-simplify/out-of-scope"`, with their children recursively simplified where possible.
- **Reduces rational functions by polynomial GCD** (ADR-0013, since v0.3.0). `(x²−1)/(x−1)` simplifies to `x+1`; common factors are cancelled across num and den.
- **Collapses Erf-family identities** (bead `bfwt`, since v0.5.0). The 19-rule identity table in
  `packages/cas-core/src/special-funcs/erf-identities.ts` fires on
  Erf / Erfc / Erfi / InverseErf / InverseErfc heads, plus a cross-head
  sum-walker that catches `Erfc(z) + Erf(z) → 1`. See "Erf-family
  rules" below.

## Erf-family rules (R1 / DLMF Chapter 7)

The 19 rules ship in three tiers (full table in
`packages/cas-core/src/special-funcs/erf-identities.ts`):

**Tier 1 — special values (R1 §1, 15 rules).**

| Input | Output | Source |
|---|---|---|
| `Erf(0)` | `0` | DLMF 7.2.1 |
| `Erf(+∞)` | `1` | DLMF 7.2.4 |
| `Erf(−∞)` | `−1` | DLMF 7.2.4 + 7.4.1 |
| `Erfc(0)` | `1` | DLMF 7.2.2 + 7.2.1 |
| `Erfc(+∞)` | `0` | DLMF 7.2.4 |
| `Erfc(−∞)` | `2` | DLMF 7.4.2 |
| `Erfi(0)` | `0` | A3 |
| `Erfi(+∞)` | `+∞` | SymPy:erfi |
| `Erfi(−∞)` | `−∞` | odd symmetry |
| `InverseErf(0)` | `0` | DLMF 7.17.2 |
| `InverseErf(±1)` | `±∞` | DLMF 7.17.1 |
| `InverseErfc(0)` | `+∞` | DLMF 7.17.1 |
| `InverseErfc(1)` | `0` | DLMF 7.17.1 |
| `InverseErfc(2)` | `−∞` | DLMF 7.17.1 |

`+∞` / `−∞` are encoded as `sym("infinity")` / `mkNeg(sym("infinity"))`
per R1 §11.1 (cas-core has no first-class infinity Value).

**Tier 2 — parity / odd symmetry (R1 §2, 4 rules).**

| Input | Output | Source |
|---|---|---|
| `Erf(−z)` | `−Erf(z)` | DLMF 7.4.1 |
| `Erfc(−z)` | `2 − Erfc(z)` | DLMF 7.4.2 |
| `Erfi(−z)` | `−Erfi(z)` | A3 + 7.4.1 |
| `InverseErf(−z)` | `−InverseErf(z)` | SymPy:erfinv |

The `−z` pattern matches `expr("neg", [z])` (smart-ctor) and
`expr("-", [z])` (user-typed unary). Binary `a − b` does NOT trigger
parity — it has no closed-form collapse (R1 §8 / Add1).

**Tier 3 — algebraic interrelations (R1 §3, 1 rule).**

| Input | Output | Source |
|---|---|---|
| `Erfi(z)` | `−i · Erf(i · z)` | A3 / SymPy:erfi `_eval_rewrite_as_erf` |

`i` is encoded as the distinguished symbol `sym("I")` (Mathematica
convention; the cas-core elementary vocabulary has no `complex` head).
The Tier-1 / Tier-2 rules take precedence so `Erfi(0) → 0` and
`Erfi(−z) → −Erfi(z)`, not the deeper `Erfi(0) → −i · Erf(0)` cascade.

**Cross-head sum-collapse (R1 §3 A1).**

`Erfc(z) + Erf(z) → 1`, on the same `z`, in any order, possibly
embedded in a larger sum (`x + Erfc(z) + Erf(z) → x + 1`). The
walker `collapseErfComplementPairs` runs inside `cas-simplify`'s
pre-pass and recognises pairs by structural-equal arguments.

## Determinism

Symbolic tier (ADR-0015) — bit-identical cross-platform forever.
Same input bytes → same output bytes on any platform, any Bun version.

## Invariants

- **idempotent**: `simplify(simplify(v)) = simplify(v)`
- **deterministic**: same input bytes → same output bytes (symbolic tier
  per ADR-0015; bit-identical cross-platform forever)
- **foreign-pass-through**: out-of-scope subterms preserved verbatim inside the tagged wrapper

## Composition note

`cas-simplify` is the canonical post-processor for `cas-diff` output: the
derivative expressions emitted by `cas-diff` are correct but not in
canonical sum-of-monomials form. Pipe through `cas-simplify` to reduce
them before further symbolic work or numerical evaluation.

## Run

```sh
echo '{"kind":"string","value":"(x+1)*(x-1)"}' \
  | bun tools/expr-parse/tool.ts \
  | bun tools/cas-simplify/tool.ts
# → x^2 + (-1)
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
