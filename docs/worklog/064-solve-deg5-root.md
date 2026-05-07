# 064 — `tools/solve` deg-≥5 Root[] wiring (yoc follow-on)

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** consumes ADR-0018 (`Root[poly, k]`); amends ADR-0017
(`solve` refusal taxonomy table — `high-degree-irreducible` →
`complex-roots-not-yet-named`).
**Issues closed:** *(unbeaded; logical follow-on of `yoc` from
shard 063).*

## Context

Shard 063 shipped `tools/poly-roots` v0.2.0 — irreducible deg-≥5
factors with all-real roots emit `Root[poly, k]` (ADR-0018);
mixed-real-complex factors refuse with the new tag
`poly-roots/complex-roots-not-yet-named`. The `tools/solve`
dispatcher (`packages/solve/src/dispatch.ts`) carried its own copy
of the deg-≤4 radicals dispatch with a deg-≥5 refusal. Pre-yoc that
refusal made sense: there was nowhere for the solve lane to *go*
above deg 4. Post-yoc the substrate exists, and the solve lane
should route through it. This shard does that wiring — the natural
close-out of the yoc work, ensuring the deg-≥5 capability lights up
end-to-end in the user-facing `tools/solve` surface, not just in
the per-tool poly-roots wire.

The TS-expert reflex: `solve(x⁵ + x⁴ - 4x³ - 3x² + 3x + 1 = 0)`
should now return five `Root[poly, k]` solutions, not refuse.
Verified empirically: shipped golden 14
(`14-deg-5-irreducible-totally-real-lehmer-l-x-5-root-solutions`)
emits exactly five solutions, each `x = Root[Polynomial[1, 3, −3,
−4, 1, 1], k=0..4]`.

## What changed

### `packages/solve/src/dispatch.ts` — deg-≥5 default-case extension

Imports added: `ROOT_VAR`, `canonicalIntegerForm`,
`polyToHighToLowRat`, `rootToValue` from `@workbench/alg-num`;
`isolateRealRoots` from `@workbench/real-roots`. Mirror of the
imports `tools/poly-roots/tool.ts` gained in shard 063.

The `rootsOfFactor` switch grew a default case (~30 LOC) parallel
to poly-roots's:

```ts
default: {
  const minpoly = canonicalIntegerForm(p, v);
  const intervals = isolateRealRoots(polyToHighToLowRat(minpoly, ROOT_VAR));
  if (intervals.length < deg) {
    return { refusal: { tag: "complex-roots-not-yet-named", detail: "..." } };
  }
  return intervals.map((iv, k) => rootToValue({
    minpoly, k, interval: { lo: iv.lo, hi: iv.hi },
  }));
}
```

The tag is `complex-roots-not-yet-named` (without the `solve/`
prefix here — `tools/solve/tool.ts` prepends the lane prefix on
emission). Mirror of poly-roots's tag.

### Tag rename: `solve/high-degree-irreducible` → `solve/complex-roots-not-yet-named`

Same Law-2 sweep as in shard 063 for poly-roots:

  - `packages/solve/test/dispatch.test.ts` — the deg-5-quintic test
    expects the new tag string. Plus a new test for Lehmer's L(x)
    (totally real irreducible quintic) verifying 5 `Root[]`
    solutions are emitted, all with `head === "Root"`.
  - `packages/solve/src/classify.ts` — comment updated.
  - `tools/solve/tool.ts` — no change (the tool reads the dispatch
    result's `reasonClass` and prepends `solve/`).
  - `tools/solve/README.md` — refusal-class roster updated; dispatch
    "How" section covers the deg-≥5 split into all-real Root[] vs
    complex-refusal; multiplicity rule extends to Root[] solutions.
  - `tools/solve/goldens.spec.ts` — replaced the deg-5 quintic
    refusal case description tag; added a new "Lehmer L(x) ⟹
    5 Root[]" case (golden 14). Existing Eisenstein quintic case
    re-described as "complex roots ⟹ tagged
    solve/complex-roots-not-yet-named."

### Bench updates — `bench/solve/`

Same shape as the bench/poly-roots-radical updates from shard 063:

  - `golden/expected.json` — 4 entries renamed (`v1-refused-quintic-
    eisenstein`, `rand-univ-014`, `rand-univ-019`, `rand-univ-024`;
    all are mixed-real-complex per SymPy `real_roots` counting, so
    the refusal half of yoc applies).
  - `golden/oracle_log.json` — 4 entries renamed.
  - `reference/solve_reference.py` — `CLS_HIGH_DEG_IRRED` →
    `CLS_COMPLEX_NOT_YET`; deg-≥5 branch counts real roots and
    refuses with the new tag (the all-real Root[]-emit reference
    requires a Root[] canonical formatter that's separately
    tracked, same as poly-roots's reference).
  - `golden/generate.py` — comment update.
  - `PROMPT.md`, `DESCRIPTION.md`, `REFERENCES.md`,
    `golden/verifier_protocol.md` — refusal-class entries and
    deg-≥5 dispatch descriptions updated.

### Docs — ADR-0017 + catalog

  - **ADR-0017**: refusal-taxonomy table entry replaced
    (`high-degree-irreducible` → `complex-roots-not-yet-named`)
    with the post-yoc semantics; the Refusal-Example section
    rewritten to use `x⁵ - x - 1` (1 real + 4 complex) and to
    point at ADR-0018 for the all-real Root[]-emit happy path.
  - **`README.md`** (catalog): `solve` row tag-list and prose
    updated; substrate list now includes `alg-num` and
    `real-roots`; description bumped to "v0.2."

## Why these choices

**Why mirror poly-roots's tag rather than pick a new one for solve.**
The two refusals describe the same underlying alg-num v0.1 limit:
"complex algebraic numbers cannot yet be named." A different tag
would force agents to learn two phrasings of the same boundary.
`solve/complex-roots-not-yet-named` and
`poly-roots/complex-roots-not-yet-named` differ only in the lane
prefix — the boundary class name is shared, which is the right
ergonomic.

**Why duplicate the deg-≥5 dispatch logic in `dispatch.ts`** rather
than extract a shared helper. Two reasons. (1) The existing
`rootsOfFactor` helpers in `tools/poly-roots/tool.ts` and
`packages/solve/src/dispatch.ts` are *already* duplicates of each
other for deg ≤ 4 (they each call `linearRoot/quadraticRoots/
cubicRoots/quarticRoots` from cas-core). Extracting just the
deg-≥5 case while leaving the deg-≤4 duplication is a half-fix.
(2) Properly extracting all of `rootsOfFactor` into a shared module
crosses package boundaries (alg-num doesn't know about radicals;
cas-core can't depend on alg-num) and is a non-trivial refactor.
A bead-tracked cleanup is appropriate; this shard scopes itself to
*lighting up the capability*, deferring the dedupe.

**Why bump solve's catalog version to "v0.2"** but leave the
package's `package.json` `version: "0.1.0"`. The catalog row's
"v0.2" annotation is a colloquial signal ("the solve tool now
spans deg-≥5 via Root[]"); the semver in `package.json` is the
machine-readable contract version. Bumping the latter would
ripple through workspace dependents; that's a separate
ADR-supported bump if/when the contract additionally ships
breaking changes. For now the contract is *additive only* —
existing consumers of solve that pattern-match on
`solution.bindings[0].value.kind` continue to work; they just
also receive `Root[]`-headed expressions in some cases. The
foreign-pass-through invariant (PRD §2.3) makes this safe.

**Why a new test rather than only a renamed one.** The renamed
existing test (deg-5 with complex roots) verifies the *refusal*
path. The new Lehmer test verifies the *Root[]-emit* path — the
strictly new capability. Both are needed: a regression that
silently dropped one path while preserving the other should
still RED-fail in CI. Mirrors shard 063's three-probe `--test`
hook in poly-roots.

## Frictions surfaced

**The `tools/solve` and `tools/poly-roots` `rootsOfFactor`
duplication.** Both tools carry their own ~25 LOC switch over
`deg`. With the deg-≥5 path added in both places, the duplication
grows to ~55 LOC each. The right cleanup is to extract a
`@workbench/poly-roots` package (substrate analogous to
`packages/poly-factor`) and let both tools import it. That's a
stand-alone refactor — a bead I'll file separately rather than
expand this shard's scope.

**ADR-0017's refusal-taxonomy column count.** The original entry
listed `degree, polynomial` as payload fields. The new
`complex-roots-not-yet-named` semantically wants
`degree, polynomial, complex_count` so a downstream consumer can
distinguish "1 real + 4 complex" from "0 real + 5 complex" without
re-running real-root isolation. Updated the ADR's payload-field
column accordingly. The actual emission hasn't yet wired
`complex_count` into the payload — the dispatcher's refusal carries
just `detail: string`. Filing this as a small follow-on so the ADR
and emitter agree.

**One stale historical reference.** `docs/worklog/054-solve-
dispatcher.md` mentions `high-degree-irreducible` in two places.
Per CLAUDE.md "Worklog shards are frozen snapshots" — left
unchanged. The semantic drift is intentional and documented in
this shard.

## Acceptance

- `packages/solve`: dispatch.ts deg-≥5 path shipped; existing test
  updated for the new tag; new test for Lehmer all-real Root[]
  emission. All 35 solve-package tests green.
- `tools/solve`: --test probe (4-lane coverage) green;
  27 goldens regenerated (was 26: +1 Lehmer all-real case).
- `bun run check`: 63/63 phases green; 0 mismatches across all
  718 goldens project-wide.
- Bench `bench/solve/`: refusal-class rename propagated through
  expected.json (4 entries), oracle_log.json (4 entries), reference
  Python, generate.py, PROMPT/DESCRIPTION/REFERENCES/
  verifier_protocol.
- ADR-0017: refusal-taxonomy table + refusal-example section
  amended.
- `README.md` (catalog): solve row updated.
- `tools/solve/README.md`: refusal-class roster + dispatch How
  section updated.

## Pointers

- ADR-0018 — `Root[poly, k]` value-protocol primitive.
- ADR-0017 — `solve` solution-set shape (just amended).
- Worklog 063 — yoc shard for `tools/poly-roots`; this shard's
  direct counterpart on the solve side.
- Bead `b55` — formal solve close-out (transcendental). The
  Root[] wiring done here is yoc-driven and decoupled from b55's
  transcendental scope; both can land independently.

## Commits

This shard documents the work as it lands; commit message will
follow the same Law-2 lockstep pattern when staged.
