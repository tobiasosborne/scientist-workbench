# 060 — `packages/alg-num` v0.1: `Root[poly, k]` type + canonicalisation

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** implements ADR-0018 (`Root[poly, k]` value-protocol primitive).
**Issues closed:** scientist-workbench-xyt.

## Context

Third sub-shard of the alg-num branch (after 058's `q8q` bench and 059's
real-root-isolate ship). With VAS-LMQ in hand, the alg-num substrate
gains its naming primitive: a TypeScript implementation of
`Root[poly, k]` per ADR-0018. This is the *type* of an algebraic number
in the workbench — a canonical encoding of "the *k*-th real root of
`poly`" that downstream alg-num work (xkz lazy refinement, 6cd full
equality, rti resultant arithmetic, 5i2 primitive elements, yoc
poly-roots upgrade) builds on.

The decision to *name* rather than *refuse* irreducible-degree-≥-5
polynomial roots is ADR-0018; this shard implements the substrate of
that ADR. Mathematica `Root[]` and SageMath `qqbar` are the references.

## What changed

### `packages/alg-num/` — new package (~530 LOC across src + tests)

Files:

- **`src/root.ts`** (~410 LOC) — the `Root` type, the canonical
  constructor `makeRoot`, the cheap-equality `rootCanonicalEq`, and the
  `canonicalIntegerForm` helper. The headline routine is
  `makeRoot(poly: Poly<Rat>, intervalHint, v): Root` which accepts any
  polynomial in ℚ[v] (reducible, rational coefficients, non-monic) plus
  a real-root isolating-interval hint, and produces a canonical `Root`
  value with:
  - **irreducible** minpoly (factored via
    `@workbench/poly-factor::factorRatQ`, then disambiguated by hint),
  - **primitive** (content-stripped over ℤ),
  - **integer-coefficient** (denominators cleared by LCM),
  - **positive leading coefficient** (sign-flipped if needed),
  - **sort-order index** `k` (ascending real-root list of the canonical
    minpoly),
  - **isolating interval** as runtime state (the canonical minpoly's
    *k*-th VAS interval; not part of the canonical bytes per ADR-0018
    §"Lazy isolating-interval semantics").
- **`src/encoding.ts`** (~155 LOC) — value-protocol bridge:
  `rootToValue(r)` produces `expression { head: "Root", args:
  [Polynomial[c_0, …, c_n], k] }` with all coefficients integer-typed;
  `valueToRoot(v)` parses the wire form, validates canonical-form
  invariants (positive leading, primitive — but not irreducibility,
  see below), and recovers the runtime interval by re-running
  `isolateRealRoots` and selecting the *k*-th interval.
- **`src/index.ts`** — public surface re-export.
- **`test/root.test.ts`** (~270 LOC) — 26 tests covering
  canonicalisation, irreducible/reducible inputs, sort-order,
  refusals (multivariate, constant, ambiguous hint, no-root-in-hint),
  equality, and full wire round-trips for `+√2`, the smallest real
  root of `x^5 − x − 1`, and the `√2 + √3` example from ADR-0018
  (`Root[x^4 − 10 x^2 + 1, 3]`).
- **`README.md`** — package overview, surface, scope (and what's
  deferred to xkz / 6cd / rti / 5i2), canonical-form invariants,
  refusal contract, references.
- **`package.json`** — workspace manifest. Depends on `cas-core`,
  `poly-factor`, `protocol`, `real-roots`.

### Catalog updates

- `README.md` — new `alg-num/` row in the package list (Law-2
  lockstep). The `real-roots/` row already references the chain
  `xyt → xkz → 6cd → rti → 5i2 → yoc`; with this shard `xyt` is now
  the *first complete substrate* of that chain.

## Why these choices

**Why real-only in v0.1.** The ADR's canonical sort order is "real
roots ascending, then complex by `(Im, Re)`." For a real `Root`, `k`
is determined entirely by the named root's position in the
ascending real-root list — independent of the (unenumerated) complex
half. The complex half requires complex-root isolation (planar VAS /
Pinkert / Pan-Sevriuk), which the workbench does not yet ship. So
the substrate-honest move is: support real `Root` values fully now,
defer complex naming until complex-root isolation lands. Complex
algebraics meanwhile live in `AlgebraicElement<R>` chains
(cas-core, ADR-0008) — `Q[√2][i]` via `Q_SQRT2_I`. The two encodings
will compose via primitive-element promotion (5i2) once both
substrates exist.

**Why a sign-criterion-based "root in hint" predicate, not
"VAS-interval contained in hint."** First-pass implementation
checked whether the VAS isolating interval `(lo_i, hi_i)`
returned by `isolateRealRoots` was contained in the supplied hint
`[hint.lo, hint.hi]`. That's wrong: VAS intervals are wide by
default — for `+√2 ≈ 1.414`, the VAS interval is `(1, 2)`, which
is *not* contained in a tight hint like `[1, 1.5]`. Yet the *root*
+√2 *is* in `[1, 1.5]`. The right test is "the root is in the
hint", not "the VAS bracket is in the hint."

The replacement (`rootInHint`, `signAtRat`) uses the squarefree
property of irreducible factors plus the sign criterion: VAS
guarantees `sign(g(vas.lo)) ≠ sign(g(vas.hi))` (Bolzano + exactly
one root in `(vas.lo, vas.hi)` per Vincent's theorem). When VAS
overlaps but isn't contained in the hint, evaluate `g` at the
hint's overlapping endpoint and compare its sign to
`sign(g(vas.lo))`: if they match, the sign change hasn't happened
yet, so the root is to the right of that endpoint. The mirror logic
applies on the right. `signAtRat` evaluates `g(p/q)` exactly via
BigInt Horner — no float intermediate.

**Why `valueToRoot` does not verify irreducibility.** Full
irreducibility verification requires factoring the polynomial,
which is expensive (Berlekamp-Zassenhaus + Hensel). Wire-format
canonicalisation is the *producer's* responsibility: `rootToValue`
emits canonical bytes, and any tool emitting `Root[]` values must
go through `makeRoot` (which factors). For agent-handcrafted
values that bypass `makeRoot`, the cheap canaries — primitive +
positive leading coefficient — catch the most common drift, and a
non-canonical `Root[]` reaching downstream alg-num arithmetic is a
contract violation upstream. This split keeps `valueToRoot` fast
on the round-trip path while still surfacing the most common
drift cases.

**Why interval is runtime state, not part of canonical bytes.** ADR-0018
§"Lazy isolating-interval semantics" forces this: determinism (PRD §0.1)
requires the same algebraic number to canonicalise to the same bytes
regardless of refinement history. Two `Root` values with the same
minpoly and `k` must hash identically even if one has been refined and
the other has not. `rootToValue` drops the interval; `valueToRoot`
re-derives it via VAS on the canonical minpoly.

**Why a `Poly<bigint>` minpoly internally, with `ROOT_VAR = "x"`
fixed.** The wire shape is positional (`Polynomial[c_0, …, c_n]`); the
variable is implicit. Internally, the coefficient list could be a
`bigint[]` directly, but the workbench's polynomial primitives all
operate on `Poly<bigint>` (a sparse term list). Reusing `Poly<bigint>`
keeps the canonical-form helpers (`canonicalIntegerForm`,
`signAtRat`, `polyToHighToLowRat`) compatible with cas-core's
interfaces and makes the eventual bridge to `AlgebraicElement<R>`
(5i2 primitive-element promotion) trivial.

## Frictions surfaced

**The "VAS interval in hint" trap.** Caught by tests; documented
above. The fix shifted from a structural-containment predicate to
a sign-criterion-based predicate that respects the geometry of how
VAS isolates roots.

**Cross-factor vs per-factor ambiguity.** First implementation only
distinguished "≥ 1 candidate vs > 1 candidate" globally. Tests
revealed two distinct error shapes: (a) the hint is too wide for a
single irreducible factor (multiple roots of one factor lie inside
— "ambiguous within factor"); (b) the hint catches roots of two
different irreducible factors ("ambiguous across factors"). Both
fail with `/ambiguous/i` in the error message, but the diagnostic
text distinguishes them — useful for an agent debugging a hint.

**`makeRat` import dance.** Removed `makeRat` from the import list
when refactoring `intervalContainedIn` away, then needed it back
for `polyToHighToLowRat`'s `c ?? 0n` rational-lift. Test suite
caught it via `ReferenceError`. Trivial fix; noted because it
reflects the cost of mid-edit pruning unused imports — TypeScript
won't always catch a re-introduced reference at compile time when
the function isn't reached on every test path. Always re-run tests
after import-list edits.

**Worklog README index drift.** Shards 056 through 059 are not
indexed in `docs/worklog/README.md` (the table ends at 055). Not
addressed in this shard (out of scope); flagged for a future
catalogue-cleanup pass.

## Acceptance

- 1 bead closed: `scientist-workbench-xyt`.
- `packages/alg-num/` shipped: `Root` type, `makeRoot`,
  `canonicalIntegerForm`, `rootToValue`, `valueToRoot`,
  `rootCanonicalEq`, README, package.json.
- 26 unit tests green (`bun test packages/alg-num`).
- `bun run check`: 63 phases passed, 0 failed (no new oracle phase —
  this is a substrate-only ship; the catalog row for the package
  is the only README-side update).
- Catalog: README packages list updated (Law-2 lockstep).

## Pointers

- Bead `scientist-workbench-xyt`: closed.
- ADR-0018: the design that this shard implements.
- Worklog 058: the bench (`q8q`).
- Worklog 059: the substrate (real-root-isolate ship).
- Sibling beads now unblocked / closer:
  - `xkz` — lazy interval refinement via interval Newton (Moore /
    Hansen). Direct extension of the `Root.interval` runtime state.
  - `6cd` — full equality semantics with non-canonical inputs by
    interval intersection. Composes the construction-time
    disambiguation logic from this shard.
  - `rti` — subresultant-based sum and product of two `Root` values
    (Cohen GTM 138 §3.6). Builds on `Root` arithmetic.
  - `5i2` — primitive-element compression for ≥ 3 algebraics.
  - `iay` — alg-num arithmetic bench.
  - `yoc` — `tools/poly-roots` upgrade to emit `Root[]` for deg ≥ 5.
- Future-shard concern: complex `Root` naming, conditional on the
  workbench gaining complex-root isolation.

## Commits

This shard documents the work as it lands; commit message will follow
the same Law-2 lockstep pattern when staged.
