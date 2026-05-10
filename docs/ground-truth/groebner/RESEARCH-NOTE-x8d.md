# RESEARCH NOTE — bead x8d: Gröbner-basis substrate for `tools/solve`

**Phase**: 1 (research only — no code written)  
**Author**: Claude Code subagent (Sonnet 4.6), 2026-05-10  
**Status**: Draft for user review before Phase 2 begins  
**Canonical bead**: `scientist-workbench-x8d`

---

## §1 Scope

This note records the algorithmic decisions needed to build the Gröbner-basis
substrate for `packages/solve`'s multivariate-polynomial dispatch lane. The
immediate goal is narrow: given a zero-dimensional polynomial system over ℚ,
compute a reduced DRL Gröbner basis, convert to lex order via FGLM, check the
shape lemma, and emit exact rational or algebraic-number solutions conforming
to ADR-0017's `Solution { bindings, branches }` shape.

What this is not:

- A specification for positive-dimensional systems (infinitely many solutions;
  those are not targeted in v0.1 and belong to a future bead).
- A design for the F4 or F5 algorithm (deferred; §2-G).
- A design for Rational Univariate Representation (explicitly excluded; §2-G).
- A design for transcendental or parametric solving (those refusals already
  exist in `packages/solve/src/classify.ts`).

The note addresses two top-level deliverables:

1. **`packages/groebner/`** — a new package implementing Buchberger + FGLM as
   a pure `Poly<Rat>[]` → `Poly<Rat>[]` substrate.
2. **`packages/solve` integration** — a new `multivariate-poly` classifier
   lane and dispatcher branch that calls `packages/groebner/`, applies the
   shape-lemma extraction, and emits solutions.

Primary sources (all in `docs/ground-truth/groebner/`):

- **Buchberger 1979** — `buchberger-1979-two-criteria.pdf` — the two
  pair-pruning criteria (Criterion 1: coprime LMs; Criterion 2: chain
  criterion via t-representation).
- **Giovini et al. 1991** — `giovini-mora-niesi-robbiano-traverso-1991-sugar-cube.pdf`
  — sugar strategy and sloppy-sugar selection; the reference that established
  that virtual degree controls coefficient swell.
- **Faugère-Gianni-Lazard-Mora 1993** — `faugere-gianni-lazard-mora-1993-fglm.pdf`
  — the FGLM order-conversion algorithm; natural basis B(G), bordering M(G),
  linear algebra procedure NewBasis.
- **Becker-Mora-Marinari-Traverso 1994** — `becker-mora-marinari-traverso-1994-shape-lemma.pdf`
  — shape lemma and 1-thick characterisation; separating variable existence.
- **Rouillier 1999** — `rouillier-1999-rur.pdf` — Rational Univariate
  Representation (read to understand what we are NOT implementing in v0.1).
- **Faugère 1999** — `faugere-1999-f4.pdf` — F4 algorithm (read to understand
  the deferred trajectory).
- **Cox-Little-O'Shea (CLO) 4th ed.** — Ch.2 §2-§8 (monomial orderings, S-
  polynomials, Buchberger's algorithm, reduced GB), Ch.5 §3 (zero-dimensional
  ideals; Theorem 6: I is zero-dim iff every variable has a power in LT(I)).

Workbench artefacts that constrain design (all read for this note):

- `docs/adr/0017-solution-set-shape.md` — the `SolveSuccess`/`SolveRefusal`
  output protocol; establishes `solve/multivariate-non-zero-dim` refusal class.
- `docs/adr/0018-root-of-polynomial.md` — `Root[poly, k]` canonical form for
  algebraic numbers.
- `docs/adr/0019-solve-bench-discipline.md` — mathematical-invariant
  verification rules for `groebner-basis` and `groebner-zerodim-extract`
  benches.
- `docs/adr/0015-determinism-tier.md` — symbolic tier = bit-identical
  cross-platform forever.
- `packages/cas-core/src/poly.ts` — the existing `Poly<Rat>` substrate.
- `packages/solve/src/classify.ts` and `dispatch.ts` — the integration points.
- `tstournament/ts-bench-infra/problems/08-buchberger/reference/buchberger_reference.py`
  and `golden/verify.py` — the reference implementation and verifier.

---

## §2 The Seven Algorithmic Decisions

### A. Monomial representation and ordering

**Decision**: Reuse `Poly<Rat>` from `packages/cas-core/src/poly.ts` as the
coefficient-bearing polynomial type. Add a `MonomialOrder` interface and a
`drlOrder(vars: string[])` constructor in `packages/groebner/` that produces
a DRL (degree-reverse-lexicographic) comparison function over the declared
variable list.

**Rationale**: `Poly<Rat>` already provides sparse term lists with exponent
maps as `ReadonlyArray<readonly [string, number]>`, alphabetically sorted by
variable name. The existing operations (`polyAdd`, `polySub`, `polyMul`,
`polyDivRemMonic`) are ring-generic. There is no reason to introduce a separate
monomial type; the comparison function is the only DRL-specific addition.

DRL over `vars = [x_1, ..., x_n]`: α >_DRL β iff |α| > |β|, or |α| = |β|
and the last variable where they differ has α giving the SMALLER exponent. This
agrees with CLO Ch.2 §2 Definition 6 p.58 (grevlex) — `vars` fixes which
variable is "last". The ordering must be stored with the basis; FGLM needs it
to form multiplication matrices.

`polyDivRemMonic` (cas-core/poly.ts:445) is *univariate* by design — it takes
a variable name `v` and treats both arguments as polynomials in `v` alone.
Multivariate Buchberger needs a different signature: `polyMultiDivRem(f,
divisors, order)`, returning the multivariate normal form under a supplied
monomial order. Two further consequences of cas-core's `Poly<T>` term layout
(see `poly.ts:34-43`): terms are stored in a fixed *lex-over-alphabetised
vars* descending order — so under a non-lex-alphabetical order (DRL, lex with
caller-supplied vars), the leading term is *not* `terms[0]`. The new function
must compute leading terms by linear scan under the supplied comparator. Both
additions live in `packages/groebner/`; `cas-core` is unchanged.

**What is NOT done**: no block ordering, no weighted ordering, no generic
elimination ordering in v0.1. DRL for Buchberger; lex for FGLM output. Two
orderings, both fixed at call time.

### B. Pair selection strategy

**Decision**: Sugar strategy (Giovini et al. 1991), specifically the "sloppy
sugar" variant. Sugar of polynomial `f` at input = `deg(f)` (total degree).
Sugar of an S-polynomial `S(f, g)` = `max(sug(f) - deg(LM(f)) + deg(lcm),
sug(g) - deg(LM(g)) + deg(lcm))`. Pairs are sorted ascending by sugar first,
then by an arbitrary tiebreak (e.g., index pair (i, j) with i < j
lexicographically).

**Rationale**: Sugar controls coefficient growth at the strategy level — it
keeps high-degree reductions from accumulating large-numerator rationals
before the pair's S-polynomial can be eliminated. Giovini et al. (1991,
p.49-54) demonstrate that sloppy sugar outperforms all other sugar variants
on their benchmark suite; it is strictly better than normal strategy on systems
with high degree. Normal selection (sort by LCM degree) is the pedagogical
default (CLO Buchberger's algorithm) but produces egregiously large
intermediates on non-trivial systems. Sloppy vs. non-sloppy sugar: "sloppy"
allows the sugar to be updated when a polynomial is reduced, which further
controls swell without any invariant violation.

**What is NOT done**: Faugère's F4 (matrix reduction strategy) is deferred.
It is faster in practice but adds ≈1500 LOC of sparse matrix infrastructure
that is not yet needed for the v0.1 target systems (systems that `tools/solve`
will plausibly receive: 2-5 equations, 2-5 variables, moderate degrees).

### C. Pair pruning

**Decision**: Apply both Buchberger criteria in the Gebauer-Möller formulation:

- **Criterion 1** (Coprime, Buchberger 1979 p.3-4): If `lcm(LM(f), LM(g)) =
  LM(f) · LM(g)`, discard the pair. The S-polynomial reduces to zero by the
  product criterion (CLO Ch.2 §6 Proposition 4 p.83).

- **Criterion 2** (Chain, Buchberger 1979 p.5-9): If there exists `h` in the
  current basis such that `LM(h)` divides `lcm(LM(f), LM(g))` and both
  `(f, h)` and `(g, h)` are already processed or discarded by Criterion 1,
  then `(f, g)` can be dropped. Follow Gebauer-Möller (1988) for the
  bookkeeping.

**Rationale**: Without both criteria, Buchberger visits O(d^(2^n)) pairs in the
worst case. Criterion 1 is O(1) and eliminates coprime pairs immediately;
Criterion 2 requires O(|current basis|) membership check per new polynomial —
negligible against the reductions it prevents. Apply Criterion 1 first (short-
circuit), then Criterion 2. The bookkeeping for Criterion 2 must be exact — an
omission means the output is not a Gröbner basis (Buchberger 1979 §3 Remark 3.1).

### D. Interreduction and uniqueness

**Decision**: After the main loop terminates, compute the REDUCED Gröbner
basis unconditionally. The reduction procedure: (1) remove any polynomial
whose leading monomial is divisible by another polynomial's leading monomial;
(2) for each surviving polynomial, fully reduce its non-leading terms against
the rest. The result is the unique reduced Gröbner basis (CLO Ch.2 §7 Theorem
5 p.93 — uniqueness theorem for reduced GBs).

**Rationale**: Without interreduction the output is *a* Gröbner basis but not
*the* unique one. Uniqueness matters for two reasons:

1. **FGLM correctness.** FGLM needs a reduced GB to correctly enumerate the
   natural basis B(G) — the staircase of monomials not divisible by any
   `LT(g)` for `g ∈ G`. A non-reduced basis has redundant leading terms that
   distort the staircase, breaking the multiplication-table construction.
2. **Bench verification (ADR-0019).** The `groebner-basis` bench's invariant
   set (ideal containment + S-pair reduction) accepts *any* correct GB, so
   uniqueness is not strictly required for grading. But it eliminates one
   degree of freedom for cross-implementation comparison and matches what
   SymPy / Singular emit, which simplifies oracle agreement.

Note: cross-platform bit-identicality is *not* a reason — that is established
by the algorithm's determinism (§4) regardless of whether the output is the
reduced GB or some other GB. Reduced-form is for *abstract canonicality*, not
*implementation determinism*.

Interreduction is O(|G|²) in the number of reduction steps and is negligible
compared to the main loop on all target systems.

### E. Zero-dimensionality test

**Decision**: Before running FGLM or shape-lemma extraction, check zero-
dimensionality of the computed DRL GB. The test: for each variable `x_i` in
the declared variable list, check that some `x_i^k` (a pure power of `x_i`)
appears as the leading monomial of some element of the reduced GB. If any
variable fails this check, the ideal is not zero-dimensional.

This is CLO Ch.5 §3 Theorem 6 (the Finiteness Theorem): for an ideal `I ⊆
k[x_1, ..., x_n]` with `k` algebraically closed, the variety `V(I)` is finite
iff for each `i`, there exists `f_i ∈ I` with `LT(f_i) = x_i^{k_i}` (a pure
power), iff `dim_k k[x]/I < ∞`. Crucially, the test depends on `LT(I)` as a
monomial ideal — *not* on which monomial ordering produces it. CLO Ch.2 §4
Proposition 4 (Macaulay's basis theorem) confirms: for any monomial ordering
`>`, the set of monomials `not in LT_>(I)` is a vector-space basis of `k[x]/I`,
and that quotient's dimension is ordering-independent. So scanning the reduced
DRL GB's leading monomials for "every variable appears as a pure power in
some LT" is a valid 0-dim test, and it is the cheapest one because we already
have the DRL GB in hand from §2-C.

**Refusal path**: If the system is not zero-dimensional, emit
`{ kind: "refusal", reasonClass: "solve/multivariate-non-zero-dim" }` with the
field `groebner_basis` set to the DRL GB (as the refusal payload's groebner_
basis field per ADR-0017) and `dimension_estimate: "positive"`. This is the
honest refusal — we computed something useful (the basis), we just can't
extract a finite solution set. The user or a downstream tool can inspect the
basis.

**What is NOT done**: computing the actual Krull dimension, or Hilbert series,
or primary decomposition. Those are positive-dimensional tools; the v0.1
refusal is honest that we don't know the dimension beyond "not zero".

### F. Solution extraction via FGLM + shape lemma

**Decision**: For zero-dimensional ideals, use FGLM (Faugère-Gianni-Lazard-
Mora 1993) to convert the DRL basis to a lex basis, then apply the shape lemma
to extract solutions.

**FGLM procedure** (NewBasis from FGLM §3):

1. Start from the DRL GB `G` and variable ordering `x_1 > ... > x_n` (DRL).
2. Compute the natural basis `B(G)` = monomials not in `<LT_{DRL}(G)>`.
   `|B(G)| = D(I)` = the degree of the ideal = number of solutions counted
   with multiplicity.
3. Compute the bordering `M(G)` = `{ x_i · b | b ∈ B(G), x_i · b ∉ B(G) }`.
4. For each `m ∈ M(G)`, reduce `m` mod `G` to get its normal form `NF(m)` as a
   ℚ-linear combination of `B(G)`. This builds the multiplication maps.
5. Run the NewBasis algorithm: iteratively find ℚ-linear dependencies among
   monomials in lex order (starting from `1, x_n, x_n^2, ...`) until
   `|B_lex(G)| = D(I)`.

The lex GB produced by FGLM is reduced and in lex order, with `x_1 > x_2 >
... > x_n`. This is the standard "elimination" ordering for the variables —
the last variable `x_n` appears in the first basis element as a univariate
polynomial.

**Shape lemma check** (Becker-Mora-Marinari-Traverso 1994, §2): The lex GB
has the shape basis form iff it looks like:
```
  g_n(x_n) = 0
  x_{n-1} - h_{n-1}(x_n) = 0
  ...
  x_1 - h_1(x_n) = 0
```
where `g_n` is a univariate polynomial in `x_n` alone of degree `D(I)`, and
`h_i` are polynomials in `x_n` alone of degree `< D(I)`.

If the shape lemma holds, the solutions are: for each root `r` of `g_n`,
the solution is `x_n = r, x_{n-1} = h_{n-1}(r), ..., x_1 = h_1(r)`. Each
`h_i(r)` is evaluated by polynomial evaluation (exact arithmetic if `r` is
rational, or a `Root[]` expression if `r` is algebraic).

The roots of `g_n` are found by:
1. Factoring `g_n` over ℚ via `factorRatQ` (from `packages/poly-factor`).
2. For each irreducible factor, applying the same dispatch as the univariate-
   poly lane: radicals for deg ≤ 4, `Root[poly, k]` for deg ≥ 5 real roots
   (via `packages/alg-num`), or refusal for complex-root algebraic numbers not
   yet nameable.

**Shape lemma failure**: If the lex GB is not in shape form (i.e., some basis
element involves more than one variable), the ideal has repeated roots or the
"generic" position assumption fails. The Becker-Mora paper (§3.1) shows that
a generic linear change of variables `x_n ↦ x_n + c_1 x_{n-1} + ... + c_{n-1}
x_1` (with rational constants) makes the ideal 1-thick and hence puts it in
shape position. In v0.1, try at most one such shift with a small fixed constant
(e.g., `c_i = i+1` for each variable). If the shape lemma still fails after
one shift, refuse with `solve/shape-lemma-failure`.

**What is NOT done**: RUR (Rouillier 1999). RUR is a linear-algebra approach
that is equivalent to the shape lemma in the 0-dimensional case but handles
multiplicities more uniformly. It requires finding a "separating element" —
a linear form `t = u_1 x_1 + ... + u_n x_n` such that the map `x_i ↦ g_i(t)`
is injective. The separating element search is the tricky part (it requires
gcd checks over the solutions). For v0.1 the shape-lemma path is simpler and
sufficient — we already have a univariate root-finder pipeline from the
univariate-poly lane.

### G. Deferred algorithms

The following algorithms are explicitly deferred to future beads and are NOT
part of the v0.1 substrate:

- **F4 (Faugère 1999)**: Replaces polynomial reduction with sparse Gaussian
  elimination on matrices of coefficients; much faster in practice, same worst-
  case complexity. Implementing F4 requires a sparse matrix type over ℚ (column
  and row indexing by monomials, fraction-free Gaussian elimination). Defer
  until the v0.1 Buchberger-based implementation is bench-confirmed and
  coefficient swell is observed to be the bottleneck.

- **Positive-dimensional systems**: No Hilbert series, no primary
  decomposition, no parametric solution families. The refusal
  `solve/multivariate-non-zero-dim` is the honest boundary.

- **Complex algebraic numbers in the multivariate setting**: The univariate
  lane's `complex-roots-not-yet-named` refusal propagates here: if `g_n` has
  complex roots, the shape-lemma solutions that depend on those roots cannot
  be named in v0.1.

- **RUR and multiple algebraic representations**: Rouillier 1999 is a
  cleaner extraction mechanism for systems with repeated roots. Deferred
  because the shape lemma plus one-shift retry covers the generic case.

---

## §3 The Non-Extraction Refusal Envelope

The groebner substrate must emit structured refusals for inputs it cannot fully
solve. The following refusal classes are anticipated; the first two already
appear in ADR-0017.

**`solve/multivariate-non-zero-dim`** (ADR-0017, already in codebase):  
Emitted when the zero-dimensionality test fails. The refusal payload must
include `groebner_basis` (the computed DRL basis as a value-protocol list of
polynomial expressions) and `dimension_estimate: "positive"`. The caller
already returns this class for the nonlinear multivariate catch-all; after the
groebner substrate ships, this refusal will carry actual computed basis
information rather than the current "Gröbner-basis dispatch is bead 'xxx'"
placeholder.

**`solve/complex-roots-not-yet-named`** (from univariate lane, propagated):  
If `g_n` (the univariate polynomial from the shape basis's first element) has
complex roots and the system has solutions at those roots, the solutions cannot
be named in v0.1. The algebraic-number substrate (`packages/alg-num`) names
real algebraic numbers via `Root[poly, k]`; complex algebraic numbers require
a separate planar isolation algorithm (future bead).

**`solve/shape-lemma-failure`** (new class, proposed here):  
If FGLM produces a lex basis that is not in shape form, and the one-shift retry
also fails to produce a shape basis, emit this refusal. The payload should
include the computed lex basis (as `groebner_basis`) so the caller can inspect
the structure. This situation arises when the ideal has a component of
multiplicity > 1 and the single fixed shift does not achieve generic position.

**`solve/coefficient-swell`** (new class, proposed here, for future use):  
If during Buchberger the rational numerators or denominators exceed some
threshold (e.g., bit-length > 100000 in any intermediate coefficient), abort
and emit this refusal rather than running for hours. The threshold should be
a configurable constant in `packages/groebner/`, defaulting conservatively.
This is a defensive measure — in v0.1 we expect only small systems, but a
misclassified transcendental or a large-degree polynomial would otherwise
produce an unbounded computation.

All four classes conform to ADR-0003's taxonomy: they are boundary failures,
not malformed input, and are emitted as `tagged "solve/<class>"` in the
`tools/solve` output layer.

---

## §4 Determinism Contract

The Gröbner-basis substrate is **symbolic tier** (ADR-0015 default). All
arithmetic is BigInt rational arithmetic (exact, no floats). The output is
bit-identical cross-platform forever, given the same input polynomials and
the same declared variable ordering.

Sources of potential non-determinism to neutralise:

1. **Pair queue ordering**: The Buchberger loop processes pairs from a priority
   queue sorted by sugar. If two pairs have equal sugar, the tiebreak must be
   deterministic. Use lexicographic order on the index pair `(i, j)` with
   `i < j` as the secondary key. This is a total order on pairs and is
   platform-independent.

2. **Basis polynomial ordering**: When a new polynomial is added to the basis
   during Buchberger (after full reduction), it is appended in arrival order.
   Arrival order is deterministic given the deterministic pair queue. After
   interreduction, the reduced GB is sorted by leading monomial in DRL order
   (descending) before being returned. This sort is deterministic by definition.

3. **FGLM natural basis enumeration**: `B(G)` is enumerated by iterating
   monomials in DRL order (ascending degree, then within degree by DRL
   ordering). The traversal order must be fixed. Iterate monomials in
   ascending DRL order using the declared variable list. This is a pure
   function of the basis and the variable order.

4. **Random linear changes of variables** for shape-lemma position: The one-
   shift retry uses fixed small integers `c_i = i + 1` for each variable
   position (e.g., `x_n ↦ x_n + 2 x_{n-1} + 3 x_{n-2} + ...`). These
   constants are hardcoded, not randomly drawn. If the fixed shift also fails,
   refuse — do not loop with random constants (that would be non-deterministic).

5. **Root ordering in the shape basis**: After finding the roots of `g_n`, they
   must be emitted in a canonical order. Use the same ordering as the univariate-
   poly lane: for real algebraic numbers via `Root[poly, k]`, the index `k` is
   ascending by real value (as guaranteed by `packages/alg-num`'s canonical
   form per ADR-0018). For rational roots, sort ascending numerically before
   algebraic roots. For complex roots: refuse in v0.1.

All of these measures ensure bit-identical output cross-platform. No `platform`
field is needed; no `--platform-fingerprint` flag is consulted. Both the
`groebner-basis` and `groebner-zerodim-extract` benches (ADR-0019) can use
golden byte-comparison.

---

## §5 Substrate Dependencies

The new `packages/groebner/` package depends on:

**`@workbench/cas-core`** (`packages/cas-core/`):
- `Poly<Rat>`, `Rat`, `Ring<Rat>`, `polyAdd`, `polySub`, `polyMul` — existing
  ring arithmetic.
- `polyDegInVar`, `polyVars`, `polyCoeffsInVar` — introspection.
- `makeRat`, `ratAdd`, `ratMul`, `ratSub`, `ratNeg`, `ratDiv`, `ratIsZero` —
  rational coefficient arithmetic. Note: `classify.ts` locally re-implements
  `ratAdd`, suggesting some are not yet exported from `cas-core`; verify before
  Phase 2.
- `polyDivRemMonic` — polynomial division. **Gap**: this function uses
  alphabetical term order, not a caller-supplied ordering. A new
  `polyMultiDivRem(f, divisors, order)` is needed in `packages/groebner/`.

**`@workbench/poly-factor`** (`packages/poly-factor/`):
- `factorRatQ` — univariate polynomial factorisation over ℚ. Used in the
  solution-extraction phase to factor `g_n(x_n)` into irreducible components.

**`@workbench/alg-num`** (`packages/alg-num/`):
- `rootToValue`, `canonicalIntegerForm`, `polyToHighToLowRat`, `ROOT_VAR` —
  used to construct `Root[poly, k]` values for real algebraic root naming (deg
  ≥ 5 irreducible factors of `g_n`).

**`@workbench/real-roots`** (`packages/real-roots/`):
- `isolateRealRoots` — VAS-LMQ real root isolation for the `Root[]` naming
  path.

**`@workbench/protocol`** (`packages/protocol/`):
- `expr`, `int`, `rat`, `sym`, `tagged`, `record` — value construction for
  the solution output.

**New additions needed in `packages/groebner/` (do NOT modify cas-core)**:

- `MonomialOrder` interface: `(a: Monomial, b: Monomial) => number` where
  `Monomial` is `Poly<Rat>` terms' `exp` map. The comparison function takes
  two exponent vectors and returns negative/zero/positive.
- `drlOrder(vars: string[]): MonomialOrder` — constructs a DRL comparison
  function for the given variable order.
- `lexOrder(vars: string[]): MonomialOrder` — constructs a lex comparison
  function. Needed for FGLM output inspection.
- `leadingTerm(p: Poly<Rat>, order: MonomialOrder): Term<Rat>` — the leading
  term of a polynomial under an ordering.
- `polyMultiDivRem(f, G, order)` — reduces `f` by a list `G` of polynomials
  under `order`; returns `{ quotients, remainder }`.
- `buchbergerDRL(polys, vars)` — main entry point; returns reduced DRL GB.
- `fglm(gDRL, vars)` — converts DRL basis to lex basis.
- `extractShape(gLex, vars)` — checks shape lemma, returns structured result.
- `solveGroebner(polys, vars)` — top-level: DRL → FGLM → shape → solutions.

**`packages/solve` integration**: add `ClassifiedMultivariatePoly` with
`kind: "multivariate-poly"` to `ClassifyResult` in `classify.ts`. The current
`multivariate-non-zero-dim` catch-all becomes the fallback only when all
equations are zero-degree (unreachable after the univariate check; the catch-all
is a dead code path once the groebner lane exists). In `dispatch.ts`, add
`case "multivariate-poly":` calling `dispatchMultivariatePoly(verdict.polys,
verdict.vars)` which invokes `solveGroebner` from `@workbench/groebner`.

---

## §6 Reference Implementation Audit

**Source**: `tstournament/ts-bench-infra/problems/08-buchberger/reference/buchberger_reference.py`
(66 LOC; calls SymPy `groebner()` directly). Input format: sparse
`[[expvec, coeff_str], ...]` with variables declared separately; the
workbench's `Poly<Rat>` format is richer. The reference does NOT implement
sugar, Gebauer-Möller, FGLM, or shape extraction — it is a GB oracle only.

**Verifier**: `tstournament/ts-bench-infra/problems/08-buchberger/golden/verify.py`
(235 LOC). Implements four invariants:

1. **Shape**: each basis element has the correct data structure (valid exponent
   vectors, rational coefficients).
2. **Input⊆candidate**: every input polynomial reduces to zero mod the
   candidate basis (i.e., the candidate generates at least the same ideal).
3. **Candidate⊆input**: every candidate basis element reduces to zero mod the
   input polynomials (i.e., the candidate is contained in the input ideal).
   Together with (2) this proves ideal equality.
4. **S-pairs**: a random sample of S-pairs of the candidate basis reduce to
   zero mod the candidate (a probabilistic GB certificate).

This four-invariant check matches ADR-0019's groebner-basis bench specification
exactly. The workbench's bench should implement the same invariants (all four,
not a subset). The probabilistic S-pair check (invariant 4) is weaker than
checking all pairs; for bench purposes we test all S-pairs on small systems
(≤ 20 basis elements) and sample on larger ones, with the threshold
configurable.

**Mismatch risks**:

- The reference normalises to SymPy's canonical form (monic leading
  coefficients). Our reduced GB must also be monic — `polyDivRemMonic` handles
  this; verify the post-interreduction pass multiplies through by the leading
  coefficient's inverse.
- The reference does not record variable ordering with the basis. The workbench
  must always record the ordering (DRL and lex) as part of the basis structure;
  it is needed for FGLM and for the bench verifier.
- The `groebner-zerodim-extract` bench (ADR-0019) is separate from the basis
  bench; its goldens require SymPy's `solve()` as the oracle, not the
  reference's `groebner()` output.

---

## §7 Open Questions for the User

Two questions are genuinely contested by the papers + the existing workbench
codebase. The remaining items are pre-decided here per CLAUDE.md's
"take a position" discipline.

### Q1 — Ship `tools/groebner-basis` as a standalone tool in this bead, or only the internal substrate?

ADR-0019 names `groebner-basis` and `groebner-zerodim-extract` as separate
benches; the tstournament problem-08 ships a `groebner-basis` problem brief +
verifier already. The standalone tool would consume the input shape from
problem-08 (`{vars, order, polynomials: [[expvec, "rat"], ...]}`) and emit the
basis under the same wire format. **Recommendation: ship.** The bench
verifier exists, the substrate is needed anyway for `tools/solve`, and the
seven-artefact overhead is small (schema + examples + `--test` hook). Cost:
~1 extra implementation day in Phase 3.

The contestable counterpoint is that `tools/solve` is the actual user surface,
and `tools/groebner-basis` exposes a non-Mathematica-style wire format that
splits the value-protocol surface. Ship-or-skip is a judgment call.

### Q2 — Shape-lemma fallback: one fixed deterministic shift, or refuse immediately?

The Becker-Mora theorem is about *generic* shifts; a single fixed shift `c_i =
i+1` is *not* generic and may fail on adversarial inputs. Three options:

1. **Refuse immediately** on shape-lemma failure with `solve/shape-lemma-
   failure`, payload contains the lex GB. Simplest, most honest, smallest
   surface. Caller can re-parameterise.
2. **One fixed shift** (`c_i = i+1`), refuse if still not shape. The original
   note's recommendation. Catches the most common multiplicity-failure cases
   but fails on systems with structure aligned to the fixed shift.
3. **Multi-shift with deterministic seed** (e.g., shifts derived from
   `hash(canonicalise(input))`). Deterministic per-input but effectively
   generic; up to N retries before refusing. More code, more cost, more
   coverage.

**Recommendation: option 1 for v0.1, with option 3 as a future bead.** A
v0.1 that *honestly refuses* on shape-lemma failure is more aligned with
CLAUDE.md Rule 8 (honest scope) than one that silently muddles through with a
non-generic fixed shift. The "shape-lemma failure" tier is rare on hand-curated
v1-bank cases; the bench will surface its frequency on stratified random
inputs and inform whether option 3 is justified.

### Pre-decided (no question — recording for Phase 2 brief)

- **Variable ordering**: caller-supplied via the existing `vars: list<symbol>`
  in the tool schema. The DRL/lex order on variables is the order they appear
  in `vars`. No reverse-alphabetical default — the caller always passes vars.
- **Over-determined systems**: accept. Inconsistent ideals produce GB `{1}`;
  emit empty solution set with `completeness: "complete"`. Mirrors the
  linear lane.
- **Coefficient-swell threshold**: defer. Phase 2 measures intermediate
  coefficient length on the bench corpus; the threshold is set from those
  measurements, not from a guess. v0.1 ships with no swell guard; if Phase 2
  finds a runaway case, we add the refusal class then with a measurement-
  backed default.
- **`order` flag on standalone tool** (only relevant if Q1=ship): expose
  `order: "drl" | "lex"`, default `lex` to match SymPy/tstournament. The
  internal `solveGroebner()` substrate always runs FGLM; the flag is a
  tool-layer concern only.
- **Corpus entry hygiene**: update `scientist-workbench-corpus`'s solve
  manifest to reference groebner as a substrate dep at end of Phase 3, not as
  a Phase 2 task. Standard hygiene.

---

*Phase 1 complete. The seven decisions in §2 are opinionated and derived from
primary sources. No code has been written or modified. Answers to Q1 and Q2
determine the Phase 2 brief shape; the pre-decided items above are the Phase 2
default unless the user overrides.*
