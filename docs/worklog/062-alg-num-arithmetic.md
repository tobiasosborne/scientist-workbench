# 062 — alg-num arithmetic via Sylvester resultants (`rti`)

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** implements ADR-0018 §"Arithmetic semantics" (the cross-
reference paragraph promising closure of `+, −, ·, /` over `Root`
values).
**Issues closed:** scientist-workbench-rti.

## Context

Third (and final core-substrate) shard of the alg-num build-out:
`Root` values gain the four field operations. With xyt + xkz + 6cd,
`Root` could be constructed, refined, parsed, and compared — but no
arithmetic. `rti` closes that loop, making `Root` an algebraically-
closed value type for ℚ-extensions over the real algebraics. From
the user's vantage:

```ts
const sqrt2 = makeRoot(x²−2, [1,2], "x");
const sqrt3 = makeRoot(x²−3, [1,2], "x");
const sumOfRoots = algNumAdd(sqrt2, sqrt3);
//  → Root[x⁴ − 10x² + 1, 3]   (the canonical minpoly of √2+√3)
```

The arithmetic substrate also unblocks bead `iay` (alg-num arithmetic
bench against an oracle), bead `5i2` (primitive-element compression),
and bead `yoc` (`tools/poly-roots` upgrade for irreducible deg ≥ 5,
which uses `algNumNeg` / `algNumAdd` to compose with downstream
solver expressions).

## What changed

### `packages/alg-num/src/resultant.ts` — new (~190 LOC)

`sylvesterResultantInY(f, g, y): Poly<Rat>` — `Res_y(f, g)` for
polynomials in ℚ[x][y] via the Sylvester matrix evaluated by Bareiss
elimination over ℚ[x]:

  - Build the Sylvester matrix: `(deg_y(f) + deg_y(g))`-square.
    Coefficient extraction in `y` produces `Poly<Rat>` entries (the
    coefficients in `y` are themselves polynomials in the remaining
    variables).
  - Bareiss elimination (Bareiss 1968) reduces the matrix to upper
    triangular while keeping every intermediate as a polynomial in
    ℚ[x] — at each step
    `M[i][j] ← (M[i][j] · M[k][k] − M[i][k] · M[k][j]) / prevPivot`,
    with the division being exact by Bareiss's theorem.
    `polyDivExact` over `RAT_RING` is the workhorse and validates
    the exactness as a sanity canary.
  - Pivot row-swaps for zero pivots are sign-tracked.

`O(n³)` polynomial operations where `n = deg_y(f) + deg_y(g)`. For
the typical alg-num use (Roots of degree ≤ 10), `n ≤ 20` —
comfortably fast.

The bead description suggested factoring through cas-core's
`polySubresultantPRS` (used internally by `polyGcd`), but that
function is private in cas-core and exposing it requires
restructuring. The Sylvester-via-Bareiss path is self-contained in
alg-num and produces identical resultants; the cost is comparable
for small `n`.

### `packages/alg-num/src/arithmetic.ts` — new (~330 LOC)

Six exports — the field closure on `Root`:

- **`algNumNeg(α)`**. `f_α(−x)` (alternating-sign coefficient
  substitution) → canonicalise via `makeRoot` with the negated
  interval `(−hi, −lo)`. The within-factor `k` reverses naturally.
- **`algNumInv(α)`** for `α ≠ 0`. `x^{deg f} f_α(1/x)` (coefficient
  reversal) → canonicalise with hint `(1/hi, 1/lo)`. If `α`'s current
  interval contains zero (VAS often emits intervals with zero as an
  endpoint, e.g. `(0, 1)` for `+1/√3` of `3x²−1`), refine until zero
  is excluded, then proceed.
- **`algNumAdd(α, β)`**. Minpoly divides
  `squarefree(Res_y(f_α(y), f_β(x − y)))`. Hint interval
  `(α.lo + β.lo, α.hi + β.hi)`. If multiple factors have a root in
  the hint, halve `α`'s and `β`'s interval widths and retry.
  Termination: distinct algebraic numbers separate by a positive
  amount, so bisection eventually disambiguates.
- **`algNumSub(α, β)` = `algNumAdd(α, algNumNeg(β))`**.
- **`algNumMul(α, β)`**. Minpoly divides
  `squarefree(Res_y(y^{deg f_α} · f_α(x/y), f_β(y)))`. Hint via
  sign-aware interval product: convex hull of the four corner
  products (`α.lo · β.lo`, `α.lo · β.hi`, `α.hi · β.lo`,
  `α.hi · β.hi`).
- **`algNumDiv(α, β)` = `algNumMul(α, algNumInv(β))`** for `β ≠ 0`.

All return canonical `Root` values. The shared driver
`arithmeticBinop` runs the refine-and-retry disambiguation loop;
both `Add` and `Mul` parameterise it with the polynomial-construction
function and the interval-arithmetic function.

### `packages/poly-factor/src/factor.ts` — non-monic factorisation path

`factorPrimitiveSquareFreeZ` previously required *monic* primitive
inputs. Algebraic-number inversion produces canonical minpolys like
`2x²−1` (= `Root[2x²−1, 1] = 1/√2`) — primitive, positive-leading,
but **non-monic**. ADR-0018 §"Canonical form" does not require
monicity. The bug surfaced when `algNumInv(SQRT2)` reached
`berlekampFactor` via `factorPrimitiveSquareFreeZ`, which threw
`"input must be monic in 'x'"`.

The fix uses the **monic-transform trick** (Cohen 1993 GTM 138 §3.5.6):
given primitive `f(x) = sum_k c_k x^k` of degree `n` with leading
coefficient `a`, build `g(x) = sum_k c_k a^{n-1-k} x^k`. Then `g` is
monic in ℤ[x]. Factor `g` into monic irreducibles `g_1, …, g_r`;
each `f_i = primPart(g_i(a · x))` is the corresponding factor of `f`.

Implementation:

  - `factorPrimitiveSquareFreeZ` now dispatches: monic input runs the
    existing Berlekamp + Hensel + recombine path (extracted into
    `factorMonicPrimitiveSquareFreeZ`); non-monic input runs the
    monic-transform-then-recurse path.
  - `monicTransform(f, v, a, n)` builds `g(x) = sum_k c_k a^{n-1-k} x^k`.
  - `primitivePartScaledX(g, v, a)` substitutes `x ↦ a · x` and
    primitive-strips.
  - `canonicalisePolyTerms` re-sorts term lists after substitution
    (cas-core's poly invariants require sorted terms; transforms
    can produce out-of-canonical-order outputs).

### Test additions — `test/arithmetic.test.ts` (~270 LOC)

20 tests covering:

  - **Sylvester sanity**: `Res_y(y²−2, y²−3) = 1` (ADR's separation
    case).
  - **Negation**: `−(+√2) = −√2`; involution; rationals (`−1`).
  - **Addition**: `√2 + √3 = Root[x⁴ − 10x² + 1, 3]` (ADR-0018
    headline); `1 + √2 = Root[x² − 2x − 1, 1]`; `√2 + (−√2) = 0`;
    commutativity.
  - **Subtraction**: `√3 − √2 = Root[x⁴ − 10x² + 1, 2]`; `α − α = 0`.
  - **Multiplication**: `√2 · √3 = Root[x² − 6, 1]`;
    `√2 · √2 = 2 = Root[x − 2, 0]` (rational degenerate case);
    `√2 · (−√2) = −2`; commutativity.
  - **Inversion**: `1/√2 = Root[2x² − 1, 1]` (the non-monic minpoly
    that exposed the poly-factor bug); involution;
    `inv(0)` throws.
  - **Division**: `√6 / √2 = Root[x² − 3, 1]`; `α / α = 1`.

Total: 75 tests across 4 files in `packages/alg-num/`.

### Catalog

`README.md` — `alg-num/` row updated to mention the arithmetic
surface.

## Why these choices

**Why Sylvester-via-Bareiss instead of cas-core's
polySubresultantPRS.** The PRS is private in cas-core and exposing
it requires restructuring (the function does not return the
resultant — it returns the GCD; the resultant is recoverable from
the chain's last constant subresultant via a sign / scaling factor,
and that exposure is non-trivial). The Sylvester path is
self-contained in alg-num and produces the same answer.
`O(n³)` polynomial ops vs PRS's `O(n²)` worst case is real but
small for our `n ≤ 20` regime; correctness over micro-optimisation
again.

**Why always squarefree the resultant.** The product of an
algebraic and its conjugate often produces a square in the
resultant (e.g. `Res(y² − 2, y² − 3·y² is constant in x)` produces
`(x² − 6)²` for `√2 · √3` because the resultant counts pairs and
each pair appears twice in symmetric input). Pre-squarefreeing
keeps `makeRoot`'s factor pass minimal and avoids spurious
multiplicity in the canonical Root. `squareFree` from
`@workbench/poly-factor` is the existing tool.

**Why refine-and-retry rather than direct interval-Newton on the
resultant's roots.** The hint interval — `α.iv + β.iv` for sum,
sign-aware product for product — may catch multiple roots of the
resultant when the input intervals are wide. Halving each input
interval halves the hint width (linearly for sum; for product the
product-interval width is bounded by `α.width · max|β| + β.width
· max|α|`, which contracts as both inputs refine). Termination
follows from the algebraic-number separation bound: any two
distinct roots of the squarefree resultant differ by at least
some positive `ε` determined by the resultant's discriminant; once
both inputs are refined below ε / 2 wide, the hint isolates a
single root and `makeRoot` succeeds.

**Why patch poly-factor rather than work around in alg-num.** The
non-monic case is a *real bug* in `factorPrimitiveSquareFreeZ`'s
existing contract — Yun's monic-over-ℚ output, when cleared to
primitive ℤ[x], can be non-monic (e.g. `x² − 1/2` clears to
`2x² − 1`). The bug was latent because no prior caller (until
alg-num's inversion) hit the non-monic case. Fixing at the source
(monic-transform trick) is one targeted change and benefits any
future caller; an alg-num-side workaround would mask the bug
elsewhere in the workbench.

## Frictions surfaced

**The non-monic poly-factor crash.** Prior poly-factor tests all
used inputs whose Yun decomposition stayed monic over ℤ (the
existing factor.test.ts, squarefree.test.ts, hensel.test.ts,
berlekamp.test.ts). Algebraic-number inversion is the first caller
to land a non-monic primitive ℤ[x] polynomial at
`factorPrimitiveSquareFreeZ`'s door. Caught by the
`algNumInv` test on `1/√2`; fixed in poly-factor; existing
poly-factor tests remain green (sanity-checked via
`bun test packages/poly-factor` after the patch).

**The "interval contains zero as endpoint" gotcha for `algNumInv`.**
First-pass straddle-zero detection used signed-comparison
(`aLoNeg && !aHiNeg`), which missed the case where `aInt.lo.n === 0n`
exactly (interval `(0, 1)` for `+1/√3` of `3x²−1`'s VAS isolation).
`ratInv(0)` then threw "division by zero." Fix: detect "interval
contains zero" via `lo.n <= 0n && hi.n >= 0n`. Caught at the
`algNumInv(algNumInv(SQRT3))` involution test.

**`countRealRoots` was a dead helper.** First draft of `algNumNeg`
computed `m - 1 - a.k` to predict the result's `k`; that was
informational only — `makeRoot` recomputes `k` authoritatively from
the canonical minpoly. The helper was removed; the body comment
explains the index-reversal argument as commentary.

**Sylvester-coefficient orientation.** First-attempt row construction
mixed up high-to-low vs low-to-high coefficient indexing in the
Sylvester matrix (off-by-`n` indexing into `fCoeffs`). Caught by
the sanity test `Res(y²−2, y²−3) = 1`. Fixed; trace by hand on
a 4×4 Sylvester confirmed correct shape.

## Acceptance

- 1 bead closed: `scientist-workbench-rti`.
- `packages/alg-num/`: `sylvesterResultantInY`, `algNumNeg`,
  `algNumInv`, `algNumAdd`, `algNumSub`, `algNumMul`, `algNumDiv`
  shipped.
- `packages/poly-factor/`: non-monic factorisation path added via
  monic-transform.
- 75 unit tests green across 4 files in `packages/alg-num/`; all
  poly-factor tests still green; `bun run check` 63 phases
  passed, 0 failed.
- Catalog: `README.md` updated.

## Pointers

- Bead `rti`: closed.
- ADR-0018: §"Arithmetic semantics" implemented end-to-end across
  worklog 060 + 061 + 062.
- Cohen 1993 GTM 138 §3.5.6 (monic transform), §3.6.2 (sum/product
  resultants).
- Bareiss 1968, *Sylvester's identity and multistep integer-
  preserving Gaussian elimination*, Math Comp 22.
- Sibling beads now ready / closer:
  - `iay` — alg-num arithmetic bench. Now has the substrate to
    exercise; bench discipline (ADR-0019) gates against SymPy
    `qqbar` or PARI `nfroots` as the oracle.
  - `5i2` — primitive-element compression for ≥ 3 algebraics. The
    pairwise-resultant blowup it solves is now actually exposed.
  - `yoc` — `tools/poly-roots` upgrade. Uses `makeRoot` to emit
    `Root[]` for irreducible deg ≥ 5; builds on the substrate.
  - `b55` — final `tools/solve` close-out + transcendental
    goldens. Now has the alg-num backend it was waiting for.

## Commits

This shard documents the work as it lands; commit message will follow
the same Law-2 lockstep pattern when staged.
