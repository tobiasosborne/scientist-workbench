# 063 — `tools/poly-roots` deg-≥5 lift: `Root[]` for irreducible quintics+ (`yoc`)

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** consumes ADR-0018 (`Root[poly, k]` value-protocol primitive).
**Issues closed:** scientist-workbench-yoc.

## Context

The alg-num substrate landed across shards 060–062: canonical
`Root[poly, k]` construction (`xyt`), refinement and indexed
construction (`xkz` + `6cd`), and field arithmetic via Sylvester-
Bareiss resultants (`rti`). With the substrate done, the headline
user-visible payoff is *lifting the deg-≥5 cap on `tools/poly-roots`*.
Before this shard, `poly-roots` capped at deg ≤ 4 and refused
irreducible deg-≥5 factors with `tagged "poly-roots/degree-too-high"`
— a clean refusal aligned with Galois-Abel-Ruffini, but the wrong
answer in the v0.2 world where the workbench *can* name the roots.

The TS-expert reflex (the two principles): `solve(x⁵ − x − 1 = 0)`
should *return roots* as named first-class values that compose with
arithmetic, not "no answer." Mathematica's `Root[#^5 - # - 1 &, 1]` is
the model. ADR-0018 chose `Root[poly, k]` as the encoding;
`@workbench/alg-num` v0.1 is the substrate; `yoc` is the
plumbing-it-into-the-tool shard.

## What changed

### `tools/poly-roots/tool.ts` — deg-≥5 dispatch path (~50 LOC)

Version bump 0.1.0 → 0.2.0. The `rootsOfFactor` switch grew a
default case for `deg ≥ 5`:

```ts
default: {
  const minpoly = canonicalIntegerForm(p, v);
  const intervals = isolateRealRoots(polyToHighToLowRat(minpoly, ROOT_VAR));
  if (intervals.length < deg) {
    return { refusal: { tag: TAG_COMPLEX_NOT_YET, ... } };
  }
  const roots = intervals.map((iv, k) =>
    rootToValue({ minpoly, k, interval: { lo: iv.lo, hi: iv.hi } }),
  );
  return { roots, usedRoot: true };
}
```

The factor `p` arrives monic over ℚ (factorRatQ contract).
`canonicalIntegerForm` clears denominators, strips content, sign-fixes
the leading coefficient — producing the canonical ℤ[x] minpoly per
ADR-0018 §"Canonical form." VAS-LMQ (`isolateRealRoots`) enumerates
real roots in ascending order, which is exactly the order
ADR-0018 §"Index k" demands for the real prefix. Each real root
becomes `Root[poly, k]` via `rootToValue` (the alg-num encoding
bridge). The `interval` field is runtime side-table state per
ADR-0018 §"Lazy isolating-interval semantics" — `rootToValue` drops
it on serialisation; the wire form carries only `(minpoly, k)`.

Two refusal cases:

  - **Mixed real-complex** (the only new refusal class). When
    `intervals.length < deg`, the irreducible factor has at least one
    complex-conjugate pair we cannot name in alg-num v0.1.
    `tagged "poly-roots/complex-roots-not-yet-named"`. The detail
    string cites the v0.1 limit and points to the future complex-
    isolation shard.
  - **All-real** is a happy path (the headline new capability) —
    `deg` `Root[]` values in `k = 0..deg-1` order.

The `TAG_DEGREE_TOO_HIGH` constant is gone — that tag string is no
longer emitted anywhere. The `method` field reads
`factor-then-radicals-or-root` whenever at least one factor used the
`Root[]`-naming path; otherwise `factor-then-radicals` (existing
goldens unchanged).

The `--test` hook gained two probes: a complex-refusal probe
(`x⁵ − x − 1`) and an all-real Root[] probe (Lehmer's
`x⁵ + x⁴ − 4x³ − 3x² + 3x + 1`, the minimal polynomial of
`2 cos(2π/11)` — totally real, irreducible by 11th cyclotomic
construction). The all-real probe verifies five `Root[]` entries
share the canonical minpoly and `k = 0..4`.

### `tools/poly-roots/goldens.spec.ts`

Five goldens added / shifted:

  - **18** (renamed) — was the misleadingly-named "deg-5 irreducible"
    case using `x⁵ − 2x − 1 = (x + 1)(x⁴ − x³ + x² − x − 1)` —
    actually reducible, the quartic factor goes through Ferrari, the
    linear through `linearRoot`. Before yoc the description was a lie
    (the golden's *output* was always Ferrari + linear, not a
    refusal); now the description matches the output.
  - **19** (new) — Lehmer's `L(x)` (totally real irreducible quintic)
    ⟹ 5 `Root[]` values with `method = "factor-then-radicals-or-root"`.
  - **20** (new) — `x⁵ − x − 1` (1 real + 2 complex pairs) ⟹
    `tagged "poly-roots/complex-roots-not-yet-named"`.
  - **21** (new) — `(x − 2) · L(x)` ⟹ 6 roots: integer `2` from the
    linear factor + 5 `Root[]` values from Lehmer, `method =
    "factor-then-radicals-or-root"`. The composition golden — verifies
    that mixed degree-classes thread cleanly through the dispatcher.
  - **22–25** — existing refusal/scaling goldens, byte-unchanged
    after renumbering.

All 25 goldens green via `bun run goldens:check` (0 mismatches).

### Docs in lockstep

  - `tools/poly-roots/README.md` rewritten — output shape, dispatch
    table, four refusal classes (was three), Lehmer Run example,
    extended References (ADR-0018, real-roots).
  - `README.md` (catalog row) — output union now lists the new tag
    class, prose covers the deg-≥5 split into all-real Root[] vs
    complex-refusal.
  - `PRD-v0.2.md` §2.2 — the deferred `algebraic` kind is annotated
    superseded; algebraic numbers are encoded as `expression {head:
    'Root'}` per ADR-0018. Preserves the "ten kinds, exhaustive"
    guarantee.

### Bench updates — `bench/poly-roots-radical/`

The bench's three deg-≥5 G-tier cases (`G-deg5-eisenstein`
`x⁵ + 2x + 2`, `G-deg6-irreducible` `x⁶ + x + 1`,
`G-deg7-cyclotomic` Φ_7) all have complex roots — they switch from
`degree-too-high` → `complex-roots-not-yet-named` (the new tag), not
to a happy Root[]-emitting path. Updated:

  - `golden/expected.json` — three tag entries renamed.
  - `golden/oracle_log.json` — three "sympy refused" entries renamed.
  - `reference/poly_roots_reference.py` — `CLS_DEGREE_TOO_HIGH` →
    `CLS_COMPLEX_NOT_YET`; the deg-≥5 branch checks
    `real_roots(multiple=True).count == d` and refuses with the new
    tag (the all-real path stub returns the same refusal but with a
    prose distinction — the reference oracle for the Root[]-emit path
    requires a Root[] canonical formatter the Python reference
    doesn't yet have, deferred).
  - `PROMPT.md`, `DESCRIPTION.md` — refusal-class list and tier-G
    rationale updated; G-tier explicitly noted as
    "intentionally mixed-real-complex to exercise the remaining
    refusal" so a future contributor doesn't read the bench's
    behaviour as the tool's only behaviour.
  - `golden/test_mutations.py` — `_baseline("deg5-refusal")` still
    uses `x^5 + 2x + 2`; the mutation harness is tag-agnostic
    (it expects whatever the reference emits and verifies the
    `wrong_refusal_tag` mutation flips it). No code change.

### `scripts/demo-scope.sh`

Added a Lehmer L(x) demo entry alongside the existing poly-roots
deg-≤4 demos, verifying end-to-end Root[] emission via the standard
demo harness.

## Why these choices

**Why all-or-nothing per factor (refuse if any complex root).** The
output shape `record { roots: list, method, warnings }` requires the
`roots` list to be the *complete* root multiset of the input.
Emitting only the real roots and dropping the complex ones would
break `multiplicity-preserves-count`; emitting a partial list with a
warning would silently mislead a downstream consumer; emitting a
hybrid `record-with-tagged-placeholders` would expand the value
surface beyond the ten kinds. Refusing the whole call when any
deg-≥5 factor has complex roots keeps the output shape clean and is
honest about the v0.1 alg-num scope. ADR-0003's three categories
(record-happy, record-with-flag-for-routine-non-success, tagged-for-
boundary) — `complex-roots-not-yet-named` is squarely in the third
category: a *boundary* of representational power, not a routine
non-result.

**Why a new tag, not a renamed one.** `degree-too-high` says "we cap
at deg 4." That's a lie now: we go higher when the roots are real.
The actual boundary is "we don't yet name complex algebraics."
Renaming makes the next reader of the code reason about the
*current* limit, not a frozen-in-amber early-version one. The cost is
three bench files updating in lockstep — Law 2 work, not noise.

**Why use `rootToValue` directly rather than going through
`makeRootByIndex`.** The factor `p` is already known irreducible
(factorRatQ contract). `makeRootByIndex` would re-factor it as a
sanity step (~one lucky-prime modular check on an irreducible —
fast, but redundant). The direct path
`canonicalIntegerForm + isolateRealRoots → Root literal → rootToValue`
matches the work `makeRootByIndex` does internally per-factor, with
the redundant factor-check elided. The `Root` interface is exported
and constructable directly; nothing about it is "private to the
package." The encoding (`rootToValue`) remains the single canonical
serialisation path.

**Why Lehmer's L(x) for the all-real test.** Three properties matter:
(1) the polynomial must be irreducible over ℚ — otherwise
`factorRatQ` reduces it to lower-degree factors and the deg-≥5 path
never fires; (2) the polynomial must have *all* real roots —
otherwise the test exercises the refusal path, not the new
capability; (3) the roots must be irrational — otherwise `linearRoot`
slices them off as rational factors. Lehmer's L(x) is the minimal
polynomial of `2 cos(2π/11)`, the canonical totally-real irreducible
quintic in classical references (its Galois group is cyclic of order
5, the smallest non-trivial Galois group acting on a totally real
quintic). It's a well-known textbook example, not a fragile random
synthesis.

**Why bump the version to 0.2.0 not 0.1.1.** The output schema gained
a new value class — `Root[]`-headed expressions — that did not appear
on the wire before. Pre-yoc consumers that pattern-matched
`record.fields.roots[i].fields.root.kind === "expression"` got back
expressions in the closed `+ − * / ^ neg sqrt` vocabulary; post-yoc
they may also receive `expression { head: "Root", ... }` values.
Foreign-pass-through (PRD §2.3) means consumers that don't know
`Root` won't crash, but they may want to dispatch on it. Semver minor
captures "additive new shape, foreign-pass-through-safe."

## Frictions surfaced

**The misleading `golden/18-deg-5-irreducible-quintic-tagged-degree-
too-high.golden.json` filename.** The polynomial it used,
`x⁵ − 2x − 1`, factors as `(x + 1)(x⁴ − x³ + x² − x − 1)` — reducible,
not irreducible. Pre-yoc the golden's *output* was always Ferrari +
linear (radicals), but the *description* claimed a refusal. The bug
was latent because nobody noticed: golden test passes regardless of
description. Now that the new yoc shard introduces real refusals,
the misnomer surfaced; the description and case-construction were
fixed alongside the rest of the work.

**The "method = factor-then-radicals" lie.** Pre-yoc the method
field was always `factor-then-radicals` because every successful
output was via a radical formula. After yoc, mixed inputs (radicals
+ Root[]) needed a distinct label so a downstream reader can tell at
a glance whether `Root[]`s appeared. Choosing
`factor-then-radicals-or-root` keeps the original literal for
backward-compatible cases and adds a strictly-additive label for the
new case. Existing goldens are byte-unchanged.

**Bench cases all have complex roots.** The bench's tier-G refusal
cases were chosen pre-yoc to exercise the deg-cap refusal; none of
them happen to be totally-real irreducible quintics. So the bench
exercises the *refusal* half of the yoc contract but not the
*emit-Root[]* half. The PROMPT.md and DESCRIPTION.md now state this
explicitly so a future contributor doesn't assume the bench's
behavior is the tool's only behavior. Adding all-real deg-≥5 bench
cases is a separate piece of work — it requires a Python-side
Root[] canonical formatter to emit the reference oracle output.
That formatter is downstream of the alg-num arithmetic bench (bead
`iay`) and tracked there.

**`makeRootByIndex` is the ergonomic surface but the wrong fit
here.** I considered routing through `makeRootByIndex(p, k, v)` for
each `k` in the deg-≥5 path. That would have done one full
factor + isolate + sort per `k`, where the loop wants one
factor + isolate sorted *once* and `deg` Root constructions on the
result. The direct path is cleaner. This isn't a bug in
`makeRootByIndex` — it's the right shape for its use case (a single
root at a known index in a possibly-reducible polynomial). For the
poly-roots loop the minimal-work path is what's coded.

## Acceptance

- 1 bead closed: `scientist-workbench-yoc`.
- `tools/poly-roots`: version 0.2.0, deg-≥5 dispatch path shipped,
  3 test probes pass (deg-2 split, x⁵−x−1 refusal, Lehmer Root[]).
- 25 goldens regenerated; full check `bun run goldens:check`
  green (0 mismatches across all 717 goldens).
- `bun run check` 63 phases passed, 0 failed.
- Bench `bench/poly-roots-radical/` updated for the renamed refusal
  tag (3 expected entries, 3 oracle-log entries, reference Python,
  PROMPT/DESCRIPTION/G-tier rationale).
- Docs in lockstep: tool README, catalog row, PRD §2.2 algebraic-
  kind annotation, this worklog shard.
- Demo-scope: Lehmer L(x) entry added.

## Pointers

- ADR-0018 — `Root[poly, k]` value-protocol primitive; canonical-form
  rules; lazy isolating-interval semantics.
- Worklog 060 — `Root[poly, k]` type + canonical constructor (`xyt`).
- Worklog 061 — `refineRoot` (`xkz`) + `makeRootByIndex` (`6cd`).
- Worklog 062 — resultant arithmetic on Roots (`rti`).
- Worklog 053 — original `tools/poly-roots` ship (deg ≤ 4 only).
- Bead `iay` — alg-num arithmetic bench. Now needs a Python
  Root[] canonical formatter for the reference oracle, which once
  built unblocks adding all-real deg-≥5 cases to
  `bench/poly-roots-radical/`.
- Bead `b55` — final `tools/solve` close-out + transcendental
  goldens. Has the alg-num backend it was waiting for; can now
  emit Root[] for the previously-refused deg-≥5 univariate path.

## Commits

This shard documents the work as it lands; commit message will
follow the same Law-2 lockstep pattern when staged.
