# ADR-0018 — `Root[poly, k]`: a value-protocol primitive for arbitrary algebraic numbers

**Status:** Accepted (2026-05-06)
**Bead:** `scientist-workbench-bnl`
**Epic:** `scientist-workbench-98a` (solve-suite-v1)
**Depends on:** ADR-0017 (solution-set shape)

## Context

Phase 3 of the solve epic must honestly return the roots of an
irreducible polynomial of degree ≥ 5. The Galois-theoretic obstruction
is hard: there is no general radical formula. Two choices, only one of
which is admissible under the workbench's two principles:

1. *Refuse* the case (return `tagged 'solve/high-degree-irreducible'`).
   Matches Mathematica v1 (1988): no `Root[]` construct, irreducible
   quintics return unevaluated. Surrenders capability the moment a deg-5
   polynomial appears.
2. *Name* the roots by `(minimal polynomial, index)` and let arithmetic
   stay exact. Matches Mathematica v3 (1996) and SageMath `qqbar` /
   `AA`. Capability extends cleanly to all algebraic numbers.

The two principles select option 2: a TS expert wants `solve(x^5 - x - 1
= 0)` to *return roots* as named first-class values that compose with
arithmetic, not "no answer." Mathematica's `Root[#^5 - # - 1 &, 1]` is
the model.

A second motivation: the existing `AlgebraicElement<R>`
(`packages/cas-core/src/algebraic.ts`, ADR-0008) is *the wrong type*
for naming an arbitrary algebraic number. `AlgebraicElement<R>` is "an
element of `Q[α]` for a fixed `α`" — given α, you can do arithmetic.
But the *α itself* — a specific root of a polynomial that no symbolic
construction exposes — has no encoding. `Root[poly, k]` *is* that
encoding. The two types compose: a `Root[]` can be promoted to be the
generator of an `AlgebraicElement` field via primitive-element
construction (P3-8), but the bottom-level "name a particular algebraic"
form is what we lack.

## Decision

Introduce a value-protocol primitive — a specific `expression` head —
named `Root`, with the schema

```ts
expression {
  head: 'Root',
  args: [
    expression { head: 'Polynomial', args: [<coefficients in Z[x]>] },
    integer { value: <k>, kind: 'integer' }
  ]
}
```

That is, `Root[poly, k]` is encoded as an `expression` value (per the
value protocol's `expression` kind) whose head is the symbol `Root`
and whose two arguments are the *minimal polynomial* (in canonical
form, see below) and the *index k* (a non-negative integer).

The minimal polynomial is itself encoded as an `expression { head:
'Polynomial', args: [c_0, c_1, ..., c_n] }` where `c_i` is the
`integer`-typed coefficient of `x^i` (low-to-high). Coefficients live
in ℤ — never ℚ — by virtue of the canonical form (see below).

`Root` is a *new constructor* in the workbench's expression
vocabulary. It joins existing arithmetic heads (`Plus`, `Times`,
`Power`, ...) and named constants (`Pi`, `E`). Tools that pattern-
match by head must add `Root` to their dispatch table or pass it
through verbatim.

### Canonical form of the minimal polynomial

Two algebraic numbers are equal iff they have the same canonical
minpoly *and* the same index. For canonicalisation to be reliable,
the minpoly form must be a function of the algebraic number, not the
construction history. The rules:

1. **Irreducible over ℚ.** Reducible polynomials are forbidden. The
   `Root` constructor factors any reducible input and selects the
   irreducible factor whose root is the named one (using the
   isolating interval to disambiguate).
2. **Primitive (content-stripped).** GCD of coefficients is 1.
3. **Integer coefficients.** Achieved by clearing the denominator on
   the rational form and stripping content.
4. **Positive leading coefficient.** Multiplied by `-1` if the
   leading coefficient is negative.
5. **Lowest degree representation.** This is implied by
   irreducibility.

The constructor `Root(poly, intervalHint)` accepts any polynomial
(even reducible, even rational-coefficient) plus an isolating-interval
hint identifying which root, and produces the canonical form. Direct
construction with non-canonical input is not a `ToolError` — it's
silently canonicalised — because the construction site (a polynomial
factorisation, an arithmetic operation, an FGLM extraction) often does
not know in advance that its output is already canonical.

### Index `k`

`k` is the position of the root in canonical sort order over ℂ:

1. Real roots first, in *ascending* real order.
2. Then complex roots, sorted lexicographically by `(Im, Re)` — same
   convention as Wolfram `Root[]` and SageMath `QQbar`.

`k` is 0-indexed (workbench convention; differs from Mathematica's
1-indexed `Root[#^5 - # - 1 &, 1]` — we adapt at the wire).

This sort order requires *some* numerical evaluation of the roots to
disambiguate ordering. The lazy-evaluation discipline (next section)
handles this: the `Root` carries an isolating interval, and the
constructor refines all isolating intervals just enough to produce a
total order.

### Lazy isolating-interval semantics

Every `Root` value carries an associated isolating interval:

- For a real root: a rational closed-open interval `(a, b]` with `a, b
  ∈ ℚ`, `a < b`, and `f(a) · f(b) ≤ 0`, and the interval contains
  exactly one real root of `f`.
- For a complex root: a rational rectangle in ℂ — `(a + b·i, c + d·i]`
  — chosen analogously so it contains exactly one root of `f`.

The interval is **runtime state**, *not* part of the canonical bytes
of the value. Two `Root` values with the same canonical minpoly and
the same `k` are equal even if their internal intervals differ in
width. The interval refines on demand — for arithmetic, for equality
testing, for numerical evaluation — by interval Newton (Moore 1966,
Hansen 1992, P3-5). Width contracts quadratically per Newton step.

The interval is stored *outside* the canonical value bytes for two
reasons. First: deterministic byte-equality (PRD §0.1) requires the
same algebraic number to canonicalize to the same bytes regardless of
how much refinement has happened to its isolating interval. Second:
provenance (ADR-0012, ADR-0015) records output bytes; we don't want a
solver run that happens to have refined an interval more than another
run to produce a different output hash.

The interval lives in a *side table* keyed by `(canonical minpoly
hash, k)`. The side table is a per-process cache (not persistent;
not under `$CAS_STORE`); refining an interval improves performance
within a process but does not change observable byte semantics.
Callers do not access the side table directly — `packages/alg-num`
exposes a `refineRoot(r: Root, precision: ℚ)` routine that returns
the same canonical `Root` value plus a refined interval as effect.

### Equality semantics

Two `Root` values `Root(f, j)` and `Root(g, k)`:

1. Canonicalise both minpolys.
2. If canonical minpolys differ (byte-inequality after canonicalisation
   — they cannot represent the same algebraic), return `false`.
3. If canonical minpolys are equal and `j == k`, return `true`.
4. If equal minpolys but `j ≠ k`, return `false`.

The subtle case is when one input was constructed from a non-canonical
polynomial. Step 1 handles this: canonicalisation factors and selects
the irreducible factor whose root is `j` (or `k`); the
selection-by-interval converges to a unique canonical pair.

### Arithmetic semantics (cross-reference, not normative)

Arithmetic on `Root` values is the subject of P3-6. In summary:

- Addition: `α + β` is a root of `Res_y(f(y), g(x − y))`. The result
  polynomial may be reducible; canonicalise (factor + interval-
  disambiguate) to recover the minimal polynomial of the sum.
- Multiplication: analogous, via `Res_y(y^{deg g} f(x/y), g(y))`.
- Division: by the multiplicative inverse, via the extended Euclidean
  algorithm in `Q[x]/(f)`.

For ≥ 3 algebraic numbers participating in a single expression, the
primitive-element theorem reduces the cost (P3-8); the result is still
a single `Root` value naming the combined element.

These details are owned by the alg-num package's ADR (forthcoming) and
its source. The point here is that arithmetic *closes*: `Root + Root
→ Root`, `Root * Root → Root`, etc., never `tagged out-of-scope`.

## Examples

### `Root[x^5 - x - 1 = 0, 0]` — the smallest real root

Wolfram: `Root[#^5 - # - 1 &, 1]`. Numerically ≈ 1.16730.

```jsonc
{
  "kind": "expression",
  "head": "Root",
  "args": [
    {
      "kind": "expression",
      "head": "Polynomial",
      "args": [
        {"kind": "integer", "value": "-1"},   // c_0 = -1
        {"kind": "integer", "value": "-1"},   // c_1 = -1
        {"kind": "integer", "value": "0"},    // c_2 =  0
        {"kind": "integer", "value": "0"},    // c_3 =  0
        {"kind": "integer", "value": "0"},    // c_4 =  0
        {"kind": "integer", "value": "1"}     // c_5 =  1
      ]
    },
    {"kind": "integer", "value": "0"}         // k = 0
  ]
}
```

### `Root[2 x^2 - 4 = 0, 1]` — i.e. `+√2`

Pre-canonicalisation: minpoly `2 x^2 - 4` (content 2, factors as
`2 (x^2 - 2)`). Canonical: `x^2 - 2`. The two real roots are `-√2` and
`+√2`; sort ascending; `+√2` is index `1`.

```jsonc
{
  "kind": "expression",
  "head": "Root",
  "args": [
    {
      "kind": "expression",
      "head": "Polynomial",
      "args": [
        {"kind": "integer", "value": "-2"},
        {"kind": "integer", "value": "0"},
        {"kind": "integer", "value": "1"}
      ]
    },
    {"kind": "integer", "value": "1"}
  ]
}
```

### Complex root example — `Root[x^2 + 1, 0]` — i.e. `−i`

`x^2 + 1` has two complex roots `−i, +i`. Sort lexicographically by
`(Im, Re)`: `−i` has `Im = -1`, `+i` has `Im = 1`. `−i` is index `0`.

The encoding is structurally identical; `k = 0`.

### Round-trip with arithmetic — `√2 + √3`

Pre-arithmetic: `α = Root[x^2 - 2, 1]`, `β = Root[x^2 - 3, 1]`.
Sum-resultant: `Res_y((y)^2 - 2, (x - y)^2 - 3)` = `x^4 - 10 x^2 +
1` (a known minpoly of `√2 + √3`). Canonical (already irreducible,
primitive, monic). Numerically `√2 + √3 ≈ 3.146`; the four real roots
of `x^4 - 10 x^2 + 1` sorted ascending are `−√2−√3, −√3+√2, √3−√2,
√2+√3`. So `α + β = Root[x^4 - 10 x^2 + 1, 3]`.

The arithmetic returns a single `Root` value — the result composes
with further arithmetic, with `solve`, with `cas-simplify`'s rational-
function reduction over the algebraic-number ring.

## Why this shape

**Why `expression { head: 'Root', ... }` and not a new value kind?**
Adding a new top-level `kind` would violate the value protocol's
"ten kinds, exhaustive over `kind`" guarantee (PRD §1.1) and force a
schema update propagated through every tool's pattern-matching. An
`expression` head is the right level: it's the protocol's existing
extension point for new symbolic constructors, used identically for
`Plus`, `Times`, `Pi`, etc. Pattern-matchers that don't know `Root`
treat it as a foreign expression and pass it through (the foreign-
pass-through invariant — PRD §2.3 — already protects this case).

**Why store the polynomial as `expression { head: 'Polynomial', args:
[...] }` and not as a flat `Plus(Times(c_i, Power(x, i)), ...)`?**
The flat form requires a free variable `x` whose name would have to
be conventional or carried separately. The `Polynomial`-head form
holds the coefficient vector positionally with the variable implicit;
canonical-form rules (primitive, positive leading, irreducible) are
*structural* rather than *expression-shape* properties; the coefficient
vector encoding makes them mechanical.

**Why integer `k` and not a "smallest real root" / "smallest complex
root" pair of variants?** The single `k` in canonical sort order
mirrors Wolfram and SageMath. Variant tags would multiply the type
surface; `k = 0` *is* "smallest" by definition.

**Why is the isolating interval not part of the canonical bytes?**
Determinism (PRD §0.1, ADR-0015): same input, same tool, same version
⇒ same output bytes. If the interval were part of the bytes, refining
on demand would change observable output. Instead, the interval is
side-table state; canonicalisation is a function of the algebraic
number itself.

**Why 0-indexed `k`?** Workbench convention; the wire adapter to
`wolframscript` / SymPy bumps to / from 1-indexed at the bench
boundary. Mathematica's 1-indexing is not a convention TS-experts
reach for.

## Relationship to existing types

- **`AlgebraicElement<R>` (ADR-0008).** *Element of* `Q[α]` for a
  fixed `α`. Carries a coefficient vector against the basis
  `{1, α, α^2, ..., α^{n-1}}`. Generic over the base ring `R`,
  composes via chain extensions (`Q[√2][i]`).
- **`Root[poly, k]` (this ADR).** *Names α* itself. Has only a
  minimal polynomial and an index — no coefficient vector, no parent
  field. Concrete instances: `Root[x^5 - x - 1, 0]`, `Root[x^2 - 2,
  1]` (= `+√2`).
- **The bridge.** A `Root[poly, k]` can be promoted to be the
  generator of an `AlgebraicElement<Q>` field whose minimal
  polynomial is `poly`; the resulting field has standard
  `AlgebraicElement` arithmetic. Conversely, an `AlgebraicElement<R>`
  representing a root of its own minimal polynomial demotes to a
  `Root[]`. The package `alg-num` (P3-*) exposes the conversion.

The two types do not subsume one another; both are needed:

- A solver returning roots: `Root[]` is the right answer.
- A computation in an algebraic-extension field where you want the
  generator fixed and arithmetic to stay in the field: `AlgebraicElement<R>`
  is the right answer.

## Cross-platform / cross-runtime concerns

`Root[]` is *symbolic* — pure ℤ-coefficient minimal polynomial plus
ℤ-valued index. No floating point. Therefore the default determinism
contract (ADR-0015 default tier: bit-identical cross-platform forever)
applies. Tools that handle `Root[]` values are not annotated
`numerical: true` purely on `Root[]`'s account.

The isolating interval is `ℚ × ℚ` (rational endpoints), also exact.
Newton-on-intervals computations refine endpoints by exact rational
arithmetic; no floating-point intermediate. Cross-platform-stable.

## Acceptance for this ADR

- This document committed under
  `docs/adr/0018-root-of-polynomial.md`.
- The encoding declared with `S.expression('Root', [...])`
  constructors, exported from a new `packages/alg-num/`.
- A canonical-form test fixture covering: reducible-input
  canonicalisation, content-stripping, leading-coefficient sign-fix,
  and equality across two distinct constructions of the same
  algebraic.
- Round-trip through `canonicalize(value) ⇒ parse ⇒ canonicalize`
  is the identity (property test).
- Foreign-pass-through: a `Root[]` inside an unrelated
  `expression { head: 'OtherTool/payload', ... }` round-trips
  verbatim (property test in another tool's suite).

## Sources

- **Mathematica `Root[]`** (1996, v3.0; Wolfram reference) — the
  authoritative model for the construct.
- **SageMath `qqbar` / `AA`** (`sage/rings/qqbar.py`, GPL-3) —
  the closest open-source reference for lazy `(minpoly, interval)`
  algebraic-number arithmetic. Port reference for P3-4 .. P3-8.
- **Cohen 1993, *A Course in Computational Algebraic Number Theory*
  (GTM 138)** §3.6 (resultants), §4.5 (primitive elements). The
  implementation manual.
- **Brown & Traub 1971, *On Euclid's algorithm and the theory of
  subresultants*, JACM 18(4)** — the subresultant PRS used for
  resultant computation in P3-6.
- **Moore 1966, *Interval Analysis*; Hansen 1992, *Global
  Optimization Using Interval Analysis*** — interval Newton method
  used for lazy refinement (P3-5).
- **Strzebonski 1997 "Computing in the field of complex algebraic
  numbers"** — Mathematica-internal account of the equivalent
  primitive.
- **Two principles** (project memory) — the agent-honesty rationale
  for naming-not-refusing on irreducible deg ≥ 5.
- **PRD-v0.2 §0.1, §1.1, §2.3** — value protocol determinism, kind
  exhaustiveness, foreign pass-through.
