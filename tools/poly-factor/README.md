# poly-factor

Exact univariate polynomial factorisation over ℚ. Given `f ∈ ℚ[v]`,
returns the unique (up to ordering) irreducible factorisation
`f = content · ∏ p_i^{e_i}` where `content ∈ ℚ` is the rational scalar
(sign + content) and each `p_i ∈ ℤ[v]` is irreducible over ℚ,
**primitive** (`gcd(coefs) = 1`), and **positive-leading-coefficient**.

The first `Solve[]`-class symbolic tool in the workbench's univariate
chain: prerequisite for `tools/poly-roots` (radicals up to deg 4 plus
`Root[]` for deg ≥ 5), for the algebraic-number arithmetic stack, and
for `tools/solve`'s univariate path. Berlekamp 1967 over a lucky prime,
Zassenhaus 1969 quadratic Hensel lift to mod `p^k > 2·M(f)` (Mignotte
bound), Berlekamp-Zassenhaus subset-sum recombination back to ℤ.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "f":   <expression in v>,
    "var": <symbol v>
  }
}
```

`f` is any expression Value in the closed vocabulary `+ − * / ^` with
integer / rational leaves and a single symbol `v` matching `var`. The
expression must reduce to a polynomial in `v` over ℚ; rational
functions, multivariate polynomials, and transcendental heads (sin /
cos / exp / log / sqrt / abs / …) are out of scope.

## Output

Two ADR-0003 categories:

* **Happy path** — `record { content, factors, method, warnings }`
  where:
  - `content` — `integer` or `rational`, in canonical form. Carries the
    sign and rational content of `f`. For monic primitive `f`,
    `content = 1`.
  - `factors` — `list<record{factor, multiplicity}>`. Each `factor` is
    an `expression` in `v` representing a polynomial in `ℤ[v]` that is
    irreducible over ℚ, primitive, and has positive leading
    coefficient. `multiplicity` is a positive `integer`. Sorted by
    degree ascending, then lex on coefficient sequence (canonical).
  - `method` — `string`, currently always `"berlekamp-zassenhaus"`.
  - `warnings` — `list<string>`, currently always empty (reserved for
    future scale advisories).

* **Boundary** — `tagged "poly-factor/non-polynomial"` with payload
  `record { detail: string }`. Triggered when the input expression is
  not a polynomial in `var` over ℚ: out-of-scope head, foreign symbol,
  rational function with non-constant denominator, etc. The agent
  reads `detail` to understand what was wrong.

`ToolError` (process exit 1) for malformed input: `var` not a symbol,
the input record missing required fields, the input polynomial being
the zero polynomial.

## How

The pipeline (`packages/poly-factor` substrate):

1. **Convert** the input expression Value to `Poly<Rat>` via
   `valueToRatFn` (in `@workbench/cas-core`). Out-of-scope subterms or
   non-constant denominators surface as `tagged
   "poly-factor/non-polynomial"`.
2. **Multivariate refusal**: if `polyVars(f)` mentions anything other
   than `var`, return the boundary tag.
3. **Square-free decomposition** (Yun 1976): split `f` into pairwise-
   coprime square-free pieces with multiplicities. Cas-core's
   `squareFree` (worklog 051).
4. **Lucky prime selection**: the smallest prime `p ∈ {3, 5, 7, …, 179}`
   not dividing `lc(f)` and preserving square-freeness mod `p`.
5. **Berlekamp factorisation** of each square-free piece over `𝔽_p`
   via the Frobenius-matrix kernel approach
   (`packages/poly-factor::berlekampFactor`).
6. **Hensel lift** the mod-`p` factorisation to mod-`p^l` for
   `p^l ≥ 2·M(f) + 1` (Mignotte 1974 bound). Quadratic Hensel doubles
   precision per step (`henselLiftPair` + `henselLiftMany`).
7. **Recombination** via Berlekamp-Zassenhaus subset-sum
   (`recombineFactors`): walk subsets of lifted factors in increasing
   cardinality, trial-divide into the residual `f`, harvest true
   integer factors. Worst-case `O(2^r)`; acceptable for the bench's
   Tier-D deg-16 cases. (LLL-based van Hoeij is a v0.2 escalation.)
8. **Canonicalisation**: convert each ℚ-monic factor to integer-
   primitive form (LCM of denominators); sign-fix to positive leading
   coefficient; sort by degree then lex.

## Invariants

- **deterministic**: same input bytes → same output bytes (symbolic
  tier per ADR-0015; bit-identical cross-platform forever).
- **reconstruction**: `content · ∏ factor_i^multiplicity_i ≡ f` exactly
  as polynomials in `ℚ[var]`.
- **factors-irreducible**: every factor is irreducible over ℚ.
- **factors-primitive**: every factor is in `ℤ[var]` with `gcd(coefs) = 1`.
- **factors-positive-leading**: every factor has positive leading
  coefficient.
- **non-poly-tagged**: non-polynomial / multivariate / out-of-scope
  input ⇒ `tagged "poly-factor/non-polynomial"` with descriptive
  `detail`. Never silently wrong factorisation.

## Run

```sh
echo '{"kind":"record","fields":{"f":{"kind":"expression","head":"+","args":[{"kind":"expression","head":"^","args":[{"kind":"symbol","name":"x"},{"kind":"integer","value":"2"}]},{"kind":"integer","value":"-1"}]},"var":{"kind":"symbol","name":"x"}}}' \
  | bun tools/poly-factor/tool.ts
```

Output (pretty-printed):

```jsonc
{
  "kind": "record",
  "fields": {
    "content": {"kind": "integer", "value": "1"},
    "factors": {
      "kind": "list",
      "items": [
        {"kind": "record", "fields": {"factor": "(x − 1)", "multiplicity": 1}},
        {"kind": "record", "fields": {"factor": "(x + 1)", "multiplicity": 1}}
      ]
    },
    "method": "berlekamp-zassenhaus",
    "warnings": []
  }
}
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## References

- Berlekamp, *Factoring polynomials over finite fields*, BSTJ 46 (1967).
  Local PDF `docs/ground-truth/factor/berlekamp-1967.pdf`.
- Mignotte, *An Inequality about Factors of Polynomials*, Math. Comp.
  28 (1974). PDF unavailable (AMS Cloudflare-walled); bound reproduced
  in CLO §4.5 and Geddes Ch. 8.
- Cox-Little-O'Shea, *Ideals, Varieties, and Algorithms* §4.5–4.6.
  Local PDF `docs/ground-truth/factor/cox-little-oshea-…`.
- Geddes-Czapor-Labahn, *Algorithms for Computer Algebra* §6.2, §8.4.

## Validation

Corpus bench `benchmarks/poly-factor-q/` (ADR-0028) — 56-case golden
battery, eight tiers:

| Tier | Cases | Description |
|---|---|---|
| A — shape edges | 6 | deg-1 (irreducible, with content); deg-2 (irreducible, splits, perfect square) |
| B — random low-degree | 12 | deg 2..10 small-coefficient primitive ℤ[x]; mixed reducible/irreducible |
| C — cyclotomic Φ_n | 8 | Φ_3, Φ_5, Φ_7, Φ_8, Φ_12, Φ_15, Φ_24, Φ_30 — all irreducible over ℚ |
| D — Swinnerton-Dyer | 6 | minimal poly of √p_1+…+√p_n; irreducible but 2^n modular factors |
| E — multiplicities | 8 | (x−1)^k for k=2,3,5,7; mixed-multiplicity products |
| F — large coefficients | 6 | deg-8,12,15 products of distinct linears; Mignotte-bound-touching cases |
| G — content/scaling | 6 | integer, rational, negative, large content; combined cases |
| H — refusals | 4 | sin(x), 1/x, sqrt(x), x*y → tagged "poly-factor-q/non-polynomial" |

**5-check verifier (verify.ts):** shape, product_equals_input (exact
BigInt rational reconstruction), each_factor_irreducible (rational-root
proxy), factors_primitive (BigInt GCD), factors_positive_leading.

**ported_from** `scientist-workbench/bench/poly-factor-q@89b4bcd`.

**Corpus grader**: `cd scientist-workbench-corpus && bun src/cli.ts grade scientist-workbench poly-factor-q`
