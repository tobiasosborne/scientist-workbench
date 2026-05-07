# @workbench/real-roots

Real-root isolation over ℚ[x] via Vincent-Akritas-Strzebonski continued
fractions with the Local-Max Quadratic (LMQ) bound.

## Surface

```ts
import { isolateRealRoots, type RealInterval } from "@workbench/real-roots";
import { makeRat } from "@workbench/cas-core";

// f(x) = x^3 - 3x + 1  (high-to-low coefficient array)
const coeffs = [makeRat(1n), makeRat(0n), makeRat(-3n), makeRat(1n)];
const intervals: RealInterval[] = isolateRealRoots(coeffs);
// → [
//     { lo: -2, hi: -1 },
//     { lo:  0, hi:  1 },
//     { lo:  1, hi:  2 }
//   ]
```

## Output convention

Two interval shapes per entry, matching SymPy's `Poly.intervals()` and
the standard Akritas-Strzebonski-Vigklas output:

- **Open `(lo, hi)`** when `lo < hi` — bracketing one *irrational* real
  root. Neither endpoint coincides with a root of `f`. Sign-change at
  endpoints; exactly one root strictly inside.
- **Singleton `{r}`** when `lo == hi == r` — naming one *rational* root
  exactly. `f(r) = 0`.

The two-shape split matters because rational roots have an exact
representation (the singleton) while irrational roots only admit
rational-endpoint approximations. Forcing every interval to be strictly
open would require widening `(r, r)` to `(r − ε, r + ε)` with `ε`
chosen so no other root lies inside — strictly more work than emitting
`(r, r)` and tagging it as a singleton.

## Squarefree precondition

`isolateRealRoots` expects a **squarefree** polynomial. VAS depends on
the sign-change ↔ root bijection (Vincent's theorem), which fails for
repeated factors:

- a double root contributes *no* sign change;
- a triple root contributes *one* sign change but represents three
  roots counted with multiplicity.

Compose with `packages/poly-factor::squareFree` (Yun 1976) before
isolation. The wire-level tool (`tools/real-root-isolate`) refuses
non-squarefree input with `tagged "real-root-isolate/not-squarefree"`;
the package itself trusts the precondition (callers either compose
correctly or get arbitrary nonsense — the package's invariants are
conditional on squarefree input). The non-squarefree-input check at the
tool boundary uses `gcd(f, f') ∈ ℚ` (squarefree iff the gcd is a
constant).

## Algorithm

VAS-LMQ. Vincent's theorem (1836) gives a sufficient condition for "at
most one positive root" via Möbius transformations + Descartes' rule
of signs. The recursion subdivides the positive real axis by
`x → x + 1` (translate by one) and `x → 1/(x + 1)` (invert+shift), each
mapping a region of the positive axis to `(0, ∞)` in the transformed
polynomial. At leaves where the transformed polynomial has 0 or 1 sign
variations, the recursion terminates; the accumulated Möbius transform
`M(x) = (a·x + b) / (c·x + d)` converts back to the original
polynomial's interval `(b/d, a/c)`.

The LMQ bound (Akritas-Strzebonski-Vigklas 2008) controls the
recursion depth: at each step, the polynomial is shifted by the floor
of the LMQ lower bound on positive roots, compressing the recursion's
constant factor. Worst-case complexity is `O(n · log B)` amortised
rational ops, where `B` is the bit-length of the largest coefficient
(Tsigaridas-Emiris 2008).

Negative roots are handled symmetrically via `f(−x)`. The root at
`x = 0` is detected by `f(0) = 0 ↔ trailing coefficient = 0` and
emitted as the singleton `(0, 0)` outside the VAS recursion.

## Implementation

- **`src/dense.ts`** — dense integer-coefficient polynomial primitives
  (`shift`, `scale`, `mirror`, `reverse`, `rshift`, `signVariations`,
  `evalAt`). High-to-low convention matching SymPy's `dup_*` family.
- **`src/lmq.ts`** — LMQ upper bound as a power-of-2 exponent (the
  natural output form of the algorithm; reciprocation for the lower
  bound is exact in this representation). Returns `null` when the
  bound is undefined.
- **`src/vas.ts`** — the VAS recursion. Stack-based DFS to avoid
  blowing the JS call stack on high-degree inputs. The `inner_isolate_positive`
  function is the line-by-line port of SymPy's
  `dup_inner_isolate_real_roots`; comments cross-reference.
- **`src/isolate.ts`** — the top-level. Clears denominators
  (ℚ → ℤ), strips a trailing-zero factor (root at 0), runs VAS on
  `f(−x)` (negative roots) and `f` (positive roots), sorts ascending.

The internal arithmetic is pure BigInt — no float, no FFI. Output
endpoints are `Rat` (lowest-terms ℚ from `@workbench/cas-core`).

## References

- **Vincent 1836**, *Sur la résolution des équations numériques*. The
  original sufficient-condition theorem.
- **Akritas, Strzebonski, Vigklas 2008**, *Improving the performance
  of the continued fractions method using new bounds of positive
  roots*. The LMQ bound.
- **Tsigaridas & Emiris 2008**, *Univariate polynomial real root
  isolation: continued fractions revisited*. The complexity analysis.
- **SymPy `dup_isolate_real_roots_sqf`** (BSD,
  `sympy/polys/rootisolation.py`) — port reference.

## Bench

Validated against the 37-case `bench/real-root-isolate/` battery
(triple-witness via SymPy + Wolfram count agreement; 4-check verifier;
9 mutation perturbations RED). See `docs/worklog/058`,
`docs/worklog/059`.

## Bead

`scientist-workbench-rra`. Companion to bead `q8q` (the bench).
Downstream alg-num beads: `xyt` (Root[poly,k] type) → `xkz` (lazy
interval refinement) → `6cd` (equality) → `rti` (subresultant
sum/product) → `5i2` (primitive-element compression) → `iay` (alg-num
arith bench) → `yoc` (poly-roots upgrade for deg ≥ 5).
