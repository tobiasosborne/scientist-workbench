# @workbench/alg-num

Algebraic-number substrate for the workbench. v0.1 ships the
`Root[poly, k]` type (ADR-0018) — a canonical, value-protocol-conformant
encoding of "name a particular root of a particular polynomial."

## Surface

```ts
import { makeRoot, rootToValue, valueToRoot, ROOT_VAR } from "@workbench/alg-num";
import { polyVar, polyAdd, polyMul, polyConst, makeRat, RAT_RING } from "@workbench/cas-core";

// Build f(x) = x^2 − 2 over ℚ.
const x = polyVar(ROOT_VAR, RAT_RING);
const f = polyAdd(
  polyMul(x, x, RAT_RING),                              // x^2
  polyConst(makeRat(-2n, 1n), RAT_RING),                // − 2
  RAT_RING,
);

// Name +√2 by giving the constructor an isolating-interval hint
// containing +√2 ≈ 1.41421.
const sqrt2 = makeRoot(f, { lo: makeRat(1n, 1n), hi: makeRat(2n, 1n) }, ROOT_VAR);
//   sqrt2.minpoly  =  x^2 − 2 (canonical ℤ[x] form)
//   sqrt2.k        =  1            (sorted ascending, −√2 is k=0)
//   sqrt2.interval =  (1, 2)       (the VAS-isolating interval)

// Wire form: expression { head: "Root", args: [Polynomial[c_0…c_n], k] }.
const v = rootToValue(sqrt2);
const sqrt2_back = valueToRoot(v);   // round-trip identity (modulo runtime interval)
```

## What's in scope (v0.1)

- **Real roots only.** `makeRoot` accepts a real isolating-interval
  hint and selects one real root of the input polynomial. The `k` it
  produces is the position of that root in the canonical minpoly's
  *ascending real-root list* — a 0-indexed integer.
- **Canonical-form construction.** Any input polynomial in `ℚ[v]` is
  accepted (reducible, rational coefficients, non-monic). The
  constructor:
  1. factors over ℚ via `@workbench/poly-factor::factorRatQ`;
  2. selects the irreducible factor whose real root lies in the hint
     (using VAS-LMQ from `@workbench/real-roots` to verify);
  3. canonicalises that factor to ℤ[x]: clear denominators by LCM,
     strip integer content by GCD, sign-flip if the leading coefficient
     is negative;
  4. computes `k` as the index of the named root in the canonical
     minpoly's ascending real-root list.
- **Wire encoding** matching ADR-0018's `expression { head: "Root",
  args: [Polynomial[c_0, …, c_n], k] }` shape, with all coefficients
  integer-typed.
- **Equality fast-path** (`rootCanonicalEq`): two `Root` values both
  in canonical form are equal iff their minpolys are byte-equal and
  their indices match.

## What's *out* of scope (deferred to sibling beads)

- **Complex algebraic naming.** `Root[poly, k]` for `k` in the complex
  half of the ADR's sort order requires complex-root isolation, which
  the workbench does not yet ship. Until then, complex algebraics
  live in `AlgebraicElement<R>` chains (cas-core, ADR-0008) — e.g.
  `Q[√2][i]` via `Q_SQRT2_I`. Bead `yoc` (`tools/poly-roots` upgrade
  for deg ≥ 5) will revisit complex-`Root[]` once that substrate
  exists.
- **Lazy interval refinement.** Bead `xkz` adds interval-Newton
  refinement (Moore 1966 / Hansen 1992) so `Root` values can be
  numerically evaluated to arbitrary precision on demand. This v0.1
  stores the interval VAS produces and never refines.
- **Full equality with non-canonical input.** Bead `6cd` extends
  equality to handle `Root` values reconstructed from non-canonical
  polynomials by interval intersection + factor selection. The
  cheap-path `rootCanonicalEq` here is the post-canonicalisation
  comparison only (steps 3–4 of ADR-0018 §"Equality semantics").
- **Resultant-based arithmetic.** Bead `rti` adds `α + β`, `α · β`
  via `Res_y`-based minpoly construction (Cohen GTM 138 §3.6). This
  package's v0.1 does not implement `+`/`·` on `Root` values.
- **Primitive-element compression** for ≥ 3 algebraics: bead `5i2`.

## Canonical form invariants

A `Root.minpoly` always satisfies (ADR-0018 §"Canonical form"):

1. **Irreducible over ℚ.** Reducible inputs are factored; the
   constructor selects the unique factor with a real root in the
   supplied hint.
2. **Primitive (content-stripped over ℤ).** `gcd(coefficients) = 1`.
3. **Integer-coefficient.** Denominators are cleared by LCM.
4. **Positive leading coefficient.** Sign-flipped if necessary.

Together these guarantee that the same algebraic number canonicalises
to the same bytes regardless of how the input polynomial was
constructed (e.g. `2x²−4`, `−x²+2`, and `(1/2)x²−1` all canonicalise
to `x²−2`).

The isolating interval is **runtime state**, *not* part of the
canonical bytes. Determinism (PRD §0.1) requires that two `Root`
values representing the same algebraic number serialise to the same
bytes regardless of refinement history. The interval is reconstructed
on `valueToRoot` by re-running VAS on the minpoly and taking the
`k`-th interval.

## Refusals

`makeRoot` throws on:

- input polynomial is zero or constant (degree < 1);
- input is multivariate (mentions a variable other than the supplied
  `v`);
- the interval hint contains *no* real root of the input (caller
  error);
- the interval hint contains real roots of *multiple* irreducible
  factors (hint too wide; refine to isolate a single root of the
  input).

`valueToRoot` throws on:

- the value is not `expression { head: "Root", … }` with the expected
  shape (Polynomial-headed coefficient vector + integer index);
- the polynomial is not in canonical form (not primitive, or has
  non-positive leading coefficient);
- the index `k` is out of range for the polynomial's real-root count
  (which includes the v0.1 refusal of complex-root indices).

## References

- **ADR-0018** — `Root[poly, k]` value-protocol primitive.
- **ADR-0008** — `AlgebraicElement<R>` (cas-core); the *element-of*
  type that composes with `Root` via primitive-element promotion
  (bead `5i2`).
- **Cohen 1993, *A Course in Computational Algebraic Number Theory*
  (GTM 138)** — §3.6 (resultants for sum/product), §4.5 (primitive
  elements), §3 (algebraic-number arithmetic).
- **SageMath `sage/rings/qqbar.py`** (GPL-3) — closest open-source
  reference for lazy `(minpoly, isolating-interval)` algebraic-number
  arithmetic. Port reference for the alg-num beads downstream.
- **PRD-v0.2 §0.1, §1.1, §2.3** — value protocol determinism, kind
  exhaustiveness, foreign pass-through.
