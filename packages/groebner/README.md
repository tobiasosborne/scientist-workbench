# `@workbench/groebner`

Multivariate Gröbner-basis substrate over ℚ.

Buchberger's algorithm (with sloppy sugar pair selection + the two
classical pruning criteria in Gebauer-Möller form), FGLM order
conversion, and shape-lemma solution extraction. The substrate package
behind `tools/groebner-basis` and `tools/solve`'s multivariate-poly
dispatch lane.

Algorithmic spec: [`docs/adr/0029-multivariate-solve-via-groebner.md`](../../docs/adr/0029-multivariate-solve-via-groebner.md)
and [`docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md`](../../docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md).

## Public API

```ts
// monomial-order.ts
interface MonomialOrder {
  readonly kind: "lex" | "drl";
  readonly vars: readonly string[];
  readonly compare: (a: Exp, b: Exp) => number;   // > 0 ⟹ a is the larger monomial
}
function lexOrder(vars: readonly string[]): MonomialOrder;
function drlOrder(vars: readonly string[]): MonomialOrder;
function expAdd(a: Exp, b: Exp): Exp;
function expSub(a: Exp, b: Exp): Exp;             // throws on negative result
function expLcm(a: Exp, b: Exp): Exp;
function expDivides(a: Exp, b: Exp): boolean;
function expGet(e: Exp, v: string): number;
function expTotalDegree(e: Exp): number;

// multidiv.ts
function leadingTerm(p: Poly<Rat>, order: MonomialOrder): Monomial<Rat> | null;
function leadingCoef(p: Poly<Rat>, order: MonomialOrder): Rat;
function polyMultiDivRem(
  f: Poly<Rat>,
  divisors: readonly Poly<Rat>[],
  order: MonomialOrder,
): { quotients: readonly Poly<Rat>[]; remainder: Poly<Rat> };
function polyNormalForm(...): Poly<Rat>;          // skips quotients
function monomialAsPoly(coef: Rat, exp: Exp): Poly<Rat>;
function polyMulMonomial(p: Poly<Rat>, coef: Rat, exp: Exp): Poly<Rat>;

// buchberger.ts
function buchbergerReduced(
  polys: readonly Poly<Rat>[],
  order: MonomialOrder,
): { basis: readonly Poly<Rat>[]; nPairs: number; warnings: readonly string[] };
function isZeroDimensional(
  basis: readonly Poly<Rat>[],
  vars: readonly string[],
  order: MonomialOrder,
): boolean;
function sPolynomial(f, g, order): Poly<Rat>;

// fglm.ts
function fglm(gDrl: readonly Poly<Rat>[], vars: readonly string[]): readonly Poly<Rat>[];

// shape-extract.ts
function detectShapePosition(gLex, vars, lex): ShapeBasis | null;
function extractShapeSolutions(gLex, vars):
  | { kind: "success"; solutions }
  | { kind: "refusal"; reasonClass; detail };

// solve-groebner.ts
function solveGroebner(polys, vars):
  | { kind: "success"; vars; solutions; warnings; nPairs }
  | { kind: "refusal"; reasonClass; detail; basis? };
```

## Why a separate `MonomialOrder`

`cas-core`'s `Poly<T>` keeps its term list in a fixed canonical order:
descending lex over the *alphabetised* variable union. That order is
canonical for ring arithmetic (addition merges, multiplication
combines like terms, equality reduces to byte equality), but it is
not the order Buchberger needs. Buchberger asks "what is the leading
monomial under the *Gröbner* order I chose for this run?" If the
Gröbner order is degrevlex over `[x, y, z]` (with `z` last), the LM
of `xy + z²` is `z²`; under cas-core's lex-over-alphabetised-vars,
the first term is `xy`. Same polynomial, different leading monomial.

So the substrate introduces a `MonomialOrder` interface — a comparator
parameterised by (a) the variable list and (b) the order kind. Two
constructors ship: `lexOrder(vars)` and `drlOrder(vars)`. Both are
total orders on ℕ^n. Buchberger and FGLM consult the comparator on
every leading-term test; never `terms[0]`.

## Why a separate `polyMultiDivRem`

`cas-core`'s `polyDivRemMonic(a, b, v, R)` is *univariate by design* —
it takes a principal variable `v` and treats both arguments as
polynomials in `v` whose coefficients live in the polynomial ring of
the other variables. That's the right substrate for Hensel lift and
the Berlekamp factorisation pipeline (it gets the deterministic
`a = q·b + r` with `deg_v(r) < deg_v(b)` shape that Hensel and
Berlekamp need). It is the *wrong* substrate for Buchberger.

Buchberger needs *multivariate* polynomial division: given `f` and a
list `G = [g_1, …, g_s]`, compute the canonical normal form `r = f
mod G` such that no monomial of `r` is divisible by any LM(g_i)
*under the supplied monomial order*. This is CLO Ch.2 §3 Theorem 3
(p.64). The remainder is *unique* under the given order when `G` is
a Gröbner basis (which is the GB property in disguise; CLO Ch.2 §6
Theorem 6).

The new `polyMultiDivRem(f, divisors, order)` lives here, not in
cas-core. cas-core is unchanged.

## The seven algorithmic decisions

Verbatim from RESEARCH-NOTE-x8d §2 (and ADR-0029 §2):

1. **Representation**: `Poly<Rat>` reused; new `MonomialOrder`
   comparators; leading-term computation by linear scan under the
   supplied comparator.
2. **Pair selection**: sloppy sugar (Giovini et al. 1991), with
   deterministic `(i, j)` lex tiebreak.
3. **Pair pruning**: Buchberger Criterion 1 (coprime LM) +
   Criterion 2 (Gebauer-Möller chain criterion in strict Becker-
   Weispfenning §5.5 form).
4. **Interreduction**: always; output is the unique reduced GB.
5. **Zero-dim test**: pure-power LM check (CLO Ch.5 §3 Theorem 6 +
   Macaulay's basis theorem); ordering-independent.
6. **Solution extraction**: FGLM (DRL → lex) + shape-lemma check +
   factor `g_n` + dispatch by degree (≤ 4 radicals; ≥ 5 real
   `Root[poly, k]`; complex refuses).
7. **Deferred**: F4 / F5, RUR, complex algebraic naming, parametric
   solving.

## Determinism contract

Symbolic tier per ADR-0015 default. Every operation is BigInt
rational; no float, no FFI, no platform-dependent ordering. Output is
bit-identical cross-platform forever. ADR-0029 §6 lists the explicit
non-determinism sources neutralised:

- pair queue: deterministic sort (sugar + `(i, j)` tiebreak);
- basis arrival order: function of the deterministic pair queue;
- interreduction sort: by leading monomial under the working order;
- FGLM lex traversal: minimal-variable child rule (each monomial
  reached exactly once);
- root ordering in `g_n`: rational < algebraic, with `Root[poly, k]`
  k-index ascending per ADR-0018.

## Tests

```sh
bun test packages/groebner/test/
```

- `monomial-order.test.ts` — DRL and lex axioms (totality,
  antisymmetry, transitivity, well-ordering on ℕ^n).
- `multidiv.test.ts` — `polyMultiDivRem` correctness on CLO Ch.2 §3
  examples; mutation-prove that swapping divisor order changes the
  quotient (CLO Example 4 p.65-66).
- `buchberger.test.ts` — Buchberger on `(x²+y, xy+1)` classic + the
  cyclic-3 family + small known-hard cases. Property: every S-pair
  reduces to 0 mod output. Mutation-prove that skipping Criterion 2
  produces spurious unpruned pairs.
- `fglm.test.ts` — DRL → lex correctness on small zero-dim ideals;
  cross-validated against hand-computed lex bases.
- `shape-extract.test.ts` — shape-lemma check on `(x²−1, y−x)`
  (passes) and `(x²−y², y²−1)` (fails — refuses with
  `solve/shape-lemma-failure`).
- `solve-groebner.test.ts` — end-to-end zero-dim ideal → solution
  set; verify count = `dim_ℚ(ℚ[x]/I)`.

## Dependencies

- `@workbench/cas-core` — `Poly<Rat>`, `Rat`, `RAT_RING`,
  `polyAdd/Sub/Mul/Neg`, ring arithmetic.
- `@workbench/poly-factor` — `factorRatQ` for shape-extract.
- `@workbench/alg-num` — `Root[poly, k]` naming for deg ≥ 5 real
  roots (`makeRootByIndex`, `rootToValue`).
- `@workbench/real-roots` — `isolateRealRoots` for the `Root[]`
  naming path.
- `@workbench/protocol` — `expr`, `int`, `rat`, `sym`, `tagged`,
  `record` value constructors for the solution output.

`cas-core` is **not modified** — the substrate adds new comparators
and new division but never touches the cas-core source files.

## See also

- `tools/groebner-basis/` — standalone tool wrapper conforming to
  the corpus bench at `scientist-workbench-corpus/benchmarks/
  groebner-basis/`.
- `tools/solve/` — top-level dispatcher; `dispatchMultivariatePoly`
  calls `solveGroebner` from this package.
- ADR-0029 — the design ADR.
- RESEARCH-NOTE-x8d.md — Phase 1 primary-source audit.
