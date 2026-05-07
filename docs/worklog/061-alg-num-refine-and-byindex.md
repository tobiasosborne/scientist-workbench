# 061 — alg-num lazy refinement (`xkz`) + index-by-value constructor (`6cd`)

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** implements ADR-0018 §"Lazy isolating-interval semantics"
(xkz) and §"Equality semantics" (6cd).
**Issues closed:** scientist-workbench-xkz, scientist-workbench-6cd.

## Context

Continuation of the alg-num substrate work (worklog 060). With the
`Root` type, canonical-form helpers, and the by-hint constructor
shipped, the next two beads complete the substrate's parse + compare
contract:

- `xkz` — lazy interval refinement so a `Root`'s isolating interval
  can be tightened to arbitrary precision on demand. Required by full
  equality, numerical evaluation, and the cross-factor sort of bead
  6cd.
- `6cd` — full equality with non-canonical inputs. The construction
  pipeline already canonicalises by interval-disambiguation when a
  hint is available; `valueToRoot` and resultant-style operations
  need to canonicalise from `(poly, k)` *without* a hint, by
  computing the global ordering of real roots across all factors of
  the polynomial.

Together they make `Root` round-trips lossless under arbitrary wire
input and lay the substrate for `rti`'s resultant arithmetic (next
shard).

## What changed

### `packages/alg-num/src/refine.ts` — new (~190 LOC)

Public surface:

- `intervalWidth(iv: RatInterval): Rat` — `hi − lo` as an exact
  rational.
- `refineRoot(r: Root, target: RefineTarget): Root` — refines
  `r.interval` until `hi − lo ≤ target` (specifying `target` as
  either `maxWidth: Rat` or `bits: number`, the latter giving
  `2^{-bits}` width). Returns a new `Root` with the same canonical
  `(minpoly, k)` and a possibly-narrower interval; if the input
  already meets the target, returns the input unchanged (referential
  identity, not just structural equality).

Algorithm: rational bisection. At each step `m = (lo + hi) / 2`,
compute `sign(g(m))` (where `g` is the canonical minpoly) via
`signAtRat`. If `sign(g(m)) = 0`, the root is exactly `m` and we
collapse to a singleton interval. Otherwise the bracket invariant
`sign(g(lo)) ≠ sign(g(hi))` selects which endpoint to replace with
`m`. Each iteration halves the width; reaching `2^{-bits}` from a
unit-width starting interval takes `bits` iterations. A defensive
8192-iteration cap protects against bug-adjacent inputs (an
unreachable target).

The bead spec mentioned interval Newton (Moore 1966 / Hansen 1992)
for quadratic contraction. We ship bisection only — quadratic
convergence is a future optimisation. Bisection is sound, simple,
and meets the operational requirement "refine to arbitrary precision
on demand"; the regimes where Newton's `O(log_2(bits))` would beat
bisection's `O(bits)` are precision targets ≥ 1024 bits, which the
workbench does not currently exercise. Newton is straightforward to
add later (rational midpoint Newton step + bisection fallback for
out-of-bracket excursions); deferred until a benchmark shows the
need.

### `packages/alg-num/src/by-index.ts` — new (~155 LOC)

Public surface:

- `makeRootByIndex(poly: Poly<Rat>, k: number, v: string): Root` —
  constructs the canonical `Root` whose root is "the *k*-th real root
  of `poly` in ascending order over ℝ." Strategy:
  1. Factor `poly` over ℚ via `factorRatQ`.
  2. For each factor, isolate its real roots via `isolateRealRoots`,
     producing a `(factorIntCanonical, internalK, interval)` triple
     per real root.
  3. Sort the flat list by ascending real-value of the named root.
     For two roots from the same factor, VAS guarantees disjoint
     intervals; ascending-by-`lo` is correct. For two roots from
     *different* factors, intervals may overlap; bisect both
     intervals until disjoint, then compare. Termination: distinct
     algebraic numbers are bounded apart by a positive separation
     (a consequence of resultant non-vanishing between two
     irreducible minpolys), so each bisection halves the gap and
     overlap clears.
  4. Pick the *k*-th entry; return `{ minpoly, k: internalK,
     interval }`.

The within-factor index `internalK` is generally *different* from
the global *k*: a reducible `poly = (x²−2)(x²−3)` at global *k*=2
(= +√2) becomes `Root[x²−2, 1]` (within-factor *k*=1 since +√2 is
the second of two real roots of `x²−2`).

### `packages/alg-num/src/encoding.ts` — `valueToRoot` rewrite

Old behaviour: validated wire-form canonical invariants (positive
leading, primitive) and threw on violation; trusted the producer's
claim of irreducibility on the fast path.

New behaviour: always defer to `makeRootByIndex(intCoeffsToRatPoly,
k)`. Per ADR-0018 §"Canonical form" — "Direct construction with
non-canonical input is not a `ToolError` — it's silently
canonicalised." A reducible polynomial that *passes* the cheap
canaries (e.g. `x⁴ − 5x² + 6 = (x²−2)(x²−3)` is primitive with
positive leading coefficient but factors) would slip past a
fast-path check and propagate as a non-canonical `Root` through
equality, hashing, and arithmetic — a contract violation. Always
factoring on parse is the sound choice; the cost is `factorRatQ` of
an already-irreducible polynomial on round-trip, which the
lucky-prime modular check confirms in one pass.

The k-out-of-degree sanity check is preserved as a cheap nonsense
filter before factoring.

### Test additions

- `test/refine.test.ts` (~17 tests) — bit-precision targets,
  bracket-invariant preservation, idempotence, monotone narrowing,
  canonical equality preservation, singleton no-op, refusal cases.
- `test/by-index.test.ts` (~12 tests) — irreducible inputs,
  reducible inputs at every global *k* (covers `(x²−2)(x²−3)`'s
  four real roots), cross-construction equality (`makeRoot` hint
  path agrees with `makeRootByIndex` on the same algebraic),
  refusal cases.
- `test/root.test.ts` — three "wire bytes throw" tests rewritten as
  "wire bytes silently canonicalise" tests, exercising the new
  `valueToRoot` semantics.

Total: 55 tests across three files (was 26).

### `signAtRat` exported from `root.ts`

The sign-of-`g`-at-rational-point helper is reused by `refine.ts`
and `by-index.ts`. Promoted from private to exported. The Horner
recurrence `h_{k+1} = h_k · p + c_{d-k-1} · q^{k+1}` lets us evaluate
`sign(g(p/q))` exactly via BigInt, no float intermediate, single
allocation per coefficient.

### Catalog

`README.md` — `alg-num/` row updated to describe the now-complete
parse + compare surface (two construction primitives, lazy
refinement, silent canonicalisation on `valueToRoot`).

## Why these choices

**Why bisection over interval Newton for v0.1.** Operational
requirement is "refine to arbitrary precision on demand," which
bisection satisfies. The bead's "quadratic" claim is aspirational;
linear convergence at 1 bit per iteration is fast enough for the
workbench's typical regimes (≤ 256 bits). Newton's quadratic
convergence wins for *very* high precision (≥ 1024 bits), which
nothing currently demands. Bisection is also denominator-bounded:
each midpoint roughly doubles the lcm of endpoint denominators, so
after `n` iterations the denominators are `O(2^n) · d_initial` —
manageable BigInt sizes. Newton over rationals doesn't have that
bound and can blow up. Two principles: a TS expert wants the
operation to *work reliably*; quadratic convergence is an
optimisation, not a correctness criterion.

**Why always factor in `valueToRoot`, no fast path.** The cheap
canaries (positive leading + primitive) don't catch reducibility,
and a reducible polynomial slipping through silently corrupts the
canonical-form contract. The cost is `factorRatQ` of an
already-irreducible polynomial on the canonical-bytes round-trip,
which the lucky-prime modular check completes in one pass — bounded
and deterministic. Soundness over micro-optimisation: a fast path
that emits non-canonical `Root` values on inputs the producer
claimed are canonical is worse than no fast path.

**Why mutate intervals during the comparator's bisection.** The
`makeRootByIndex` sort runs a comparator that may bisect the two
intervals being compared. Mutating the `FactorRootMut.interval`
field in-place lets later comparisons benefit from already-refined
intervals — the cost amortises across the sort. Pure-functional
non-mutating refinement would force every comparator call to
recompute from scratch. The mutated `FactorRootMut` is local to
`makeRootByIndex`'s scope and never escapes; the returned `Root`'s
interval is built from the chosen entry's final state.

**Why `compareRoots` short-circuits on same-factor identity.** Two
roots of the *same* irreducible polynomial have disjoint VAS
intervals by construction (Vincent's theorem + the squarefree
property of irreducible factors). So same-factor comparison reduces
to `ratCompare(a.interval.lo, b.interval.lo)` — no bisection needed.
The cross-factor case is where bisection earns its keep.

## Frictions surfaced

**The "x⁴ − 5x² + 6" trap.** First-pass `valueToRoot` had a fast
path that trusted positive-leading + primitive as a canonicality
proxy. The `(x²−2)(x²−3) = x⁴ − 5x² + 6` test case (added explicitly
to exercise the reducible path) caught the bug — that polynomial is
primitive with positive leading coefficient but reducible, so the
fast path produced a `Root` with a non-canonical (reducible) minpoly.
Caught at first test run, fixed by removing the fast path entirely.
Documented in the encoding.ts header so a future contributor doesn't
re-introduce the same shortcut.

**`makeRat` import dance, again.** During the comparator's local
helper extraction in `by-index.ts`, first pass returned an unsafe
`as unknown as Rat` cast for the midpoint, on the (correct) reasoning
that the internal `Rat` shape is `{n, d}` and the comparator doesn't
require canonical form. The cast was a code smell — a reader
encountering the file shouldn't have to verify "this Rat doesn't
escape to canonical-requiring code." Replaced with `makeRat(...)` —
canonical reduction is one bigint-gcd per midpoint, negligible.

**The mutating comparator.** TypeScript-expert intuition would
prefer pure functions; the in-place interval refinement during sort
is *not* what a TS expert reaches for first. The trade-off here is
between "purity" and "amortised cost across O(n²) comparisons." The
mutation is encapsulated (the `FactorRootMut` type is internal to
`by-index.ts` and never escapes), and the comment block calls it out
explicitly. The two-principles answer: a TS expert wants the
operation to be fast *and* readable; the comment makes it readable,
the mutation makes it fast. Not a blanket precedent — use mutation
when it's measurably faster *and* encapsulated.

## Acceptance

- 2 beads closed: `scientist-workbench-xkz`, `scientist-workbench-6cd`.
- `packages/alg-num/`: `refineRoot`, `intervalWidth`,
  `makeRootByIndex` shipped; `valueToRoot` extended to silently
  canonicalise non-canonical wire input.
- 55 unit tests green (`bun test packages/alg-num`); was 26 in
  worklog 060.
- `bun run check`: 63 phases passed, 0 failed.
- Catalog: `README.md` packages list updated.

## Pointers

- Beads `xkz` and `6cd`: closed.
- ADR-0018: the design implemented across worklog 060 + 061.
- Worklog 060: the predecessor (xyt — type + by-hint constructor).
- Sibling beads now closer to ready:
  - `rti` — subresultant-based sum/product. Needs resultant from
    `polySubresultantPRS` (currently internal in cas-core); next
    shard exports it and adds `algNumAdd` / `algNumMul` over
    `Root` values.
  - `5i2` — primitive-element compression for ≥ 3 algebraics.
    Builds on `rti`'s resultant operation.
  - `iay` — alg-num arithmetic bench. Gates `rti`/`5i2` against an
    independent oracle (SymPy `qqbar` or PARI `nfroots`).
  - `yoc` — `tools/poly-roots` upgrade to emit `Root[]` for
    irreducible deg ≥ 5. Uses `makeRoot`/`makeRootByIndex` directly.
- Future-shard concerns: complex `Root` naming (gated on complex-root
  isolation); interval Newton acceleration in `refineRoot`.

## Commits

This shard documents the work as it lands; commit message will follow
the same Law-2 lockstep pattern when staged.
