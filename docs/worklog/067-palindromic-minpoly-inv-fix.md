# 067 — algNumInv `reverseCoefficients` term-order fix (`5zh`)

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** none amended; bug-fix deepens shard 062's substrate.
**Issues closed:** scientist-workbench-5zh (poly-factor:
henselLiftPair fails on palindromic input from alg-num inversion).

## Context

Worklog 066 (`bench/alg-num-arith` ship) caught a real bug while
running the bench's B-nested tier: `inv(√(2+√3))` (i.e.
`inv(Root[x⁴ − 4x² + 1, k=3])`) reproducibly threw

```
henselLiftPair: precondition f ≡ g₀·h₀ (mod p) violated
```

inside `factorRatQ` → `henselLiftMany`. The case was deferred from
the bench (substituted with `add-nested-self`) and filed as a beads
bug for separate investigation. This shard is the investigation +
fix, landing in the same session as the discovery.

The bug is precisely the kind of root-cause issue Rule 2 ("All bugs
are deep") was written to defeat: the surface symptom was inside
`poly-factor`'s Hensel lift, but the actual cause was a term-order
invariant violation in `alg-num`'s `reverseCoefficients` helper —
two packages away from the failure site, two function calls
upstream.

## What changed

### `packages/alg-num/src/arithmetic.ts` (~3 LOC fix + extensive comment)

`reverseCoefficients(p)` builds the reciprocal polynomial
`x^{deg p} · p(1/x)` by mapping each input term `c · x^i` to
`c · x^{n−i}`. The mapping is correct in a coefficient-by-
coefficient sense: every coefficient lands at the right new degree.

The bug: the map preserves the input array's order. For canonical
input `[{x⁴}, {-4x²}, {1}]` (cas-core's canonical = high-to-low
exponent ordering), the output array becomes `[{1}, {-4x²}, {x⁴}]`
— low-to-high, **not canonical**.

```ts
// Before (buggy):
return {
  terms: p.terms.map((t) => { ... return { exp: newExp, coef }; }),
};

// After (fixed):
const mapped = p.terms.map((t) => { ... return { exp: newExp, coef }; });
return { terms: mapped.reverse() };
```

A flipped-direction map of a canonical-order array is exactly
inverted; reversing restores canonicality. The fix is one extra
function call.

### `packages/alg-num/test/arithmetic.test.ts` — regression test

New `algNumInv` test:

```ts
test("inv on palindromic minpoly: 1/√(2+√3) = √(2−√3) = Root[x⁴−4x²+1, k=2]", () => {
  const sqrt2plussqrt3 = makeRootByIndex(
    fromCoeffsLowToHigh([1n, 0n, -4n, 0n, 1n].map((c) => makeRat(c, 1n))),
    3, "x",
  );
  const inv = algNumInv(sqrt2plussqrt3);
  expect(polyEq(inv.minpoly, intPolyLowToHigh([1n, 0n, -4n, 0n, 1n]), INT_RING)).toBe(true);
  expect(inv.k).toBe(2);
});
```

The palindromic minpoly is the canary because it's the case where
the bug is **only** detectable by term-order — `x⁴ − 4x² + 1`
reversed is itself coefficient-by-coefficient; the values are
unchanged, only the order differs. Non-palindromic inputs (like
`x² − 2`) coincidentally pass because the wrong-order single-term-
per-degree polynomial still factors via a simpler path (the lucky-
prime modular factorisation works on whatever order the terms are
in for low-degree-many cases). Palindromic deg-4 is the smallest
case that exposes the term-order requirement.

### `bench/alg-num-arith/golden/generate.py` — case reinstated

`B-nested-05-inv-nested` (the `inv(√(2+√3))` case) is reinstated as
a happy-path arithmetic case. Its expected canonical output is
`Root[x⁴−4x²+1, k=2]` (= `√(2−√3) = 1/√(2+√3)`, since
`√(2+√3)·√(2−√3) = √((2+√3)(2−√3)) = √(4−3) = 1`).

The bench `run.py` driver passes 32/32 cases with the reinstatement
(was 32/32 with the substituted case; same number, different case).

## Why these choices

**Why `.reverse()` rather than an explicit sort.** The input is
already canonical (cas-core's invariant). After the degree-mapping
map, the *exact* inverse of that canonical order results — the
smallest-input-exp term has the largest-output-exp, and vice versa.
A sort would do the same work but with `O(n log n)` cost; reverse
is `O(n)` and exploits the input invariant. The substrate's code
that calls `reverseCoefficients` always passes a canonical poly
(the `Root.minpoly` field, which is canonicalised at construction
time), so the invariant assumption is sound. If a future caller
ever passes non-canonical input, an explicit sort would be more
robust — but the current contract is "input is canonical."

**Why patch `algNumInv` rather than make `factorRatQ` order-agnostic.**
`factorRatQ` consuming non-canonical input would be a substrate
contract change rippling through every caller — that's a much
larger refactor with broader risk. The bug here is in the *caller's*
maintenance of the invariant; fixing the caller is the targeted
change. (And worklog 062's earlier `canonicalisePolyTerms` patch
inside `poly-factor` was a similar fix for a different caller —
the non-monic transform path.)

**Why the regression test uses `makeRootByIndex` rather than
`makeRoot`.** `makeRoot(poly, hint, v)` requires an interval hint
that uniquely identifies the root; constructing one for
`+√(2+√3) ≈ 1.93` requires a well-chosen interval (e.g.
`[3/2, 2]`). `makeRootByIndex(poly, k, v)` takes a global
ascending-real-root index — `k=3` for the largest of the four real
roots. The latter is the right surface for tests where the index
is what matters. Mirrors how `valueToRoot` (the wire-decode path)
uses `makeRootByIndex` exclusively.

**Why this fix-in-the-same-session rather than a follow-up shard.**
Two reasons. (1) The fix is small (~3 LOC) and self-contained;
deferring would not improve quality, and would leave a known-
broken case in the bench's deferred queue. (2) Reinstating the
B-nested-05 case is a strictly better bench — it exercises a
codepath (palindromic-minpoly inv) that no other case touches.
Closing the loop while the diagnosis is fresh is cheaper than
re-context-loading later.

## Frictions surfaced

**The bug latency.** All ~75 alg-num arithmetic unit tests in
`packages/alg-num/test/arithmetic.test.ts` passed pre-fix; the
existing inv test (`1/√2 = Root[2x² − 1, 1]`) used a
non-palindromic minpoly. Palindromic input is a *small* slice of
the algebraic-number space, so the bug was latent until a
specific construction triggered it. The bench's diversity-by-tier
discipline (B-nested deliberately exercises nested-radical
algebraic numbers, which produce deg-4 palindromic minpolys) is
*exactly* what surfaced this. Validates ADR-0019's tier-stratified
case-generation philosophy.

**The error message indirection.** The crash fires inside
`henselLiftPair` with an opaque message ("`f ≡ g₀·h₀ (mod p)`
precondition violated"). To trace back to `algNumInv`'s wrong term
order required reading both packages' source and reasoning about
the failure mode. A future iteration could improve the error
message — e.g., dump the offending `f` and `g₀·h₀` polynomials —
but that's a usability issue, not a correctness one. Filed
mentally; not formally beaded.

**Term-order canonicality is implicit.** Neither cas-core nor
poly-factor explicitly documents "canonical = high-to-low" in their
public surface. The invariant is upheld by the `polyAdd`/`polyMul`
combinators by construction; consumers that build polys via direct
term-array manipulation (like `reverseCoefficients`) need to know
this. Worth a one-line note in cas-core's prose somewhere. Not
amending this shard further.

## Acceptance

- 1 bug bead closed: `scientist-workbench-5zh`.
- 76 alg-num tests pass (was 75; +1 palindromic regression).
- bench `bench/alg-num-arith/`: 32/32 cases pass with B-nested-05
  reinstated as a happy-path case.
- `bun run check`: 65/65 phases green.

## Pointers

- ADR-0018 — `Root[poly, k]` value-protocol primitive.
- Worklog 062 — alg-num resultant arithmetic substrate (the
  `reverseCoefficients` helper that this shard fixes).
- Worklog 066 — bench shard that surfaced this bug.
- Worklog 026 — protocol-DRY shard that landed similar
  canonicality-invariant cleanups in cas-core (precedent for
  fixing-the-caller-not-the-substrate).

## Commits

This shard documents the work as it lands; commit message will
follow the same Law-2 lockstep pattern when staged.
