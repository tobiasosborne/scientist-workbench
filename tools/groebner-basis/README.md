# `groebner-basis`

Multivariate Gröbner-basis computation over ℚ.

## What it does

Given a finite set of polynomials `F = {f_1, …, f_m} ⊂ ℚ[x_1, …, x_n]`
(carried as expression Values), a variable order, and a monomial order,
returns a **reduced** Gröbner basis of the ideal `⟨F⟩` under that order.

The substrate is `@workbench/groebner` — Buchberger 1965 with sloppy
sugar pair selection (Giovini-Mora-Niesi-Robbiano-Traverso 1991),
Buchberger Criterion 1 (coprime leading monomials) + Criterion 2
(Gebauer-Möller chain criterion in the strict Becker-Weispfenning §5.5
formulation), full inter-reduction to the unique reduced GB.

Algorithmic background: see ADR-0029 and
[`docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md`](../../docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md).

## Input schema

```ts
record {
  polys: list<expression>,
  vars:  list<symbol>,
  order: string,        // "lex" | "degrevlex"
}
```

The polynomial expressions use the closed `+ − * / ^` (and `**`)
vocabulary over integer / rational leaves and the symbols in `vars`.

## Output schema

### Happy path

```ts
record {
  basis:    list<expression>,   // reduced GB, monic, sorted by LM descending
  order:    string,             // echoed input order
  vars:     list<symbol>,       // echoed input vars
  n_pairs:  integer,            // S-pairs considered (a metric, not invariant)
  warnings: list<string>,
}
```

### Boundary refusal

```ts
tagged "groebner-basis/<class>" with payload record { detail: string }
```

| class            | trigger                                             |
|------------------|-----------------------------------------------------|
| `empty-input`    | `polys` list is empty                               |
| `empty-vars`     | `vars` list is empty                                |
| `parametric`     | input mentions a symbol outside `vars`              |
| `non-polynomial` | input has heads outside `+ − * / ^` (e.g., sin)     |

`ToolError` (process exit 1) is reserved for *malformed* input —
schema-level violations like `vars` not a list of symbols. These
should not reach the body; the runner's pre-fn validation step
(ADR-0008) catches them.

## Determinism

Symbolic tier per ADR-0015 default. All arithmetic is BigInt rational;
no float, no FFI, no platform-dependent ordering. Output is bit-identical
cross-platform forever, given the same input polynomials and the same
declared variable list. See ADR-0029 §6 for the explicit list of
non-determinism sources neutralised by the implementation.

## Examples

### Classic CLO Ch.2 §6 Example 1

Input: `(x²+y, xy+1)` under lex with `x > y`.

Output basis: `{x − y², y³ + 1}`. Two elements — the elimination
property of lex puts the univariate-in-`y` polynomial last.

### Cyclic-3

Input: `(x + y + z, xy + yz + zx, xyz − 1)` under degrevlex with vars
`[x, y, z]`. Output is a 4-element reduced GB.

### Refusal: `solve/foreign-vocabulary` analogue

Input contains `sin(x)`. Refused with
`tagged "groebner-basis/non-polynomial"`.

## Algorithm — what it does, in order

1. **Parse** each input expression to `Poly<Rat>` via `valueToRatFn`.
   Reject foreign vocabulary (head outside `+ − * / ^`) with
   `non-polynomial`. Reject any symbol outside `vars` with
   `parametric`. Reject rational functions with non-constant
   denominator with `non-polynomial`.

2. **Construct** the requested monomial-order comparator
   (`drlOrder(vars)` for `degrevlex`, `lexOrder(vars)` for `lex`).
   Both are `MonomialOrder` interfaces with a `compare: (Exp, Exp) =>
   number` method.

3. **Buchberger main loop** (`buchbergerReduced`):
   - Insert each input polynomial into the working basis `B`,
     generating fresh S-pairs against existing basis elements and
     pruning each via Criterion 1 (coprime LM).
   - Pre-existing pairs whose lcm is divisible by the new element's
     LM are purged backwards (Criterion 2 backwards-purge).
   - Pop pairs by ascending sugar; ties broken by lex on `(i, j)`
     index pair.
   - For each popped pair, compute the S-polynomial, reduce it
     modulo the current basis, monicise the (non-zero) result, and
     insert it as a new basis element.

4. **Interreduce** the resulting basis (`interreduce` inside
   `buchberger.ts`):
   - Discard polynomials whose LM is divisible by another's
     (deterministic tiebreak: keep the lower-indexed copy on
     identical LM).
   - For each survivor, fully reduce its non-leading terms against
     the rest of the basis. Loop until fixpoint.
   - Monicise (multiply each element by the inverse of its leading
     coefficient).
   - Sort by leading monomial in descending order under the working
     order.

5. **Render** each `Poly<Rat>` back to an expression Value via
   `polyToValue`, build the output record.

The output is canonical — the unique reduced Gröbner basis for the
requested order (CLO Ch.2 §7 Theorem 5 — uniqueness of reduced GBs).

## Out of scope

- **Coefficient fields beyond ℚ.** No `𝔽_p[x]`, no `ℚ(α)[x]`. (Future
  bead would extend the substrate; the existing ring-generic `Poly<T>`
  in cas-core makes this a parameterisation, not a rewrite.)
- **Monomial orders beyond `lex` / `degrevlex`.** No block ordering,
  no weighted ordering, no general elimination ordering.
- **F4 / F5.** Deferred per RESEARCH-NOTE-x8d §2-G; the v0.1
  Buchberger substrate is bench-confirmed against an 80-case corpus
  (4 invariants per case = 400 invariant checks). Coefficient swell
  is observed to be the bottleneck only on systems beyond the v0.1
  target scale (n ≤ 5, m ≤ 10).
- **Solution extraction.** That happens inside `tools/solve`'s
  multivariate-poly lane, not here. This tool's job is the basis;
  `solveGroebner()` (in `@workbench/groebner`) composes basis +
  zero-dim test + FGLM + shape-lemma extraction.

## Provenance

Every invocation writes a provenance record per ADR-0010 / ADR-0012.
No `numerical: true` field, no `arbprec: true`, no `nondeterministic:
true` annotations — symbolic tier default, no `platform` field. The
input hash + output hash uniquely identify the invocation; no
`precision` flag, no platform fingerprint.

## Bench

Graded against the 80-case corpus at
`scientist-workbench-corpus/benchmarks/groebner-basis/`. Run via
`bash scripts/bench-grade.sh groebner-basis`.

The bench's verifier is `python3 verify.py` and consumes the four-
invariant correctness certificate (CLO Ch.2 §6 Theorem 6 — Buchberger's
theorem):

1. **Shape** — kind / basis / order / vars structural check.
2. **Input ⊆ candidate** — every input polynomial reduces to 0
   modulo the candidate basis.
3. **Candidate ⊆ input** — every candidate polynomial reduces to 0
   modulo a SymPy-computed reference GB of the input.
4. **S-pairs** — every S-polynomial of distinct candidate basis
   elements reduces to 0 modulo the candidate (the GB property).

Plus `tag_matches` for the refusal-envelope tier.

## See also

- ADR-0029 — Multivariate `solve` via Gröbner basis.
- RESEARCH-NOTE-x8d.md — Phase 1 audit of primary sources.
- `tools/solve/README.md` — top-level dispatcher that consumes this
  substrate via `@workbench/groebner`'s `solveGroebner()`.
- `packages/groebner/` — the substrate package.
