# 019 — tools/sturm-equivalent (Phase 1 killer demo)

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-564 (closed)

## Context

Shard 018 closed `sturm-execute` (the analytic distribution computer).
Shard 015 closed `sturm-simplify` (the IR canonicaliser). Both are the
direct prerequisites for `sturm-equivalent`, the third Phase-1 tool —
the one whose pitch is "exact-symbolic quantum equivalence checking
without bottoming out in float comparison." This shard ships the
honest v0.1 of that tool: composes simplify + execute under the
record-with-flag pattern from ADR-0003, mirroring `cas-verify`'s shape.

## What changed

`tools/sturm-equivalent/{tool.ts, package.json, README.md,
goldens.spec.ts, goldens/}` — full 7-artefact contract. 14 goldens
covering reflexive equality, simplify-induced equality (ry(0)
elimination, same-axis fusion, control reordering), distribution-
mismatch with witness (deterministic-0 vs deterministic-1, Bell vs
not-Bell), distribution-match-but-not-syntactic (rz on |+⟩ — phase
unobservable; different classical_refs), and `sturm-execute` boundary
cases (oracle, discard).

Symmetry + determinism property tests in the `--test` hook. README
with ADR cross-references. Main `README.md` catalog row added.
`scripts/demo-scope.sh` gains demo 12: Bell vs Bell-with-redundant-
ry(0) → `{equal: true}`, the killer demo.

`bun run check`: 20/20 phases green (the new tool adds two phases,
matching the sturm-execute pattern from shard 018).

## Why these choices

### Compose simplify + execute, don't reimplement

Three options were on the table:

1. Re-implement the simplify rewrites and the distribution computation
   inside `sturm-equivalent`'s body.
2. Extract `simplifyChannel` and `executeChannel` into shared library
   modules (in `packages/sturm-ir` or a new `packages/sturm-rewrites`).
3. Spawn `sturm-simplify` and `sturm-execute` as subprocesses.

Option 3 won. The reasoning:

- (1) introduces silent drift hazards: a bug-fix to `sturm-simplify`
  doesn't propagate to `sturm-equivalent` unless someone remembers.
  Two implementations of the same canonicalisation that *should* agree
  is the kind of duplication CLAUDE.md Rule 8 is allergic to.
- (2) is the architecturally cleanest move long-term. It's also the
  most expensive in this session — modifying `packages/sturm-ir`'s
  scope from "pure data + structural checks" to "data + rewrites +
  simulation" is a real conceptual change that warrants its own
  worklog shard. Filed implicitly for future work; not done here.
- (3) keeps the dependents in lockstep with their sources by
  construction. The cost is ~200 ms latency per invocation (4
  subprocess spawns in the worst case: simplify×2 + execute×2). For an
  equivalence-checker that runs occasionally rather than in a tight
  loop, this is acceptable.

The README explicitly flags the unusual pattern (tool-on-tool
composition, not tool-on-package) so future readers know it was a
deliberate v0.1 tradeoff.

### Honest scope: distribution-match → out-of-scope, not equal=true

The hardest design call. After byte-equality fails post-simplify, the
tool runs `sturm-execute` on each side and compares distributions. If
the distributions match (within 1e-9 tolerance), the obvious
temptation is to return `equal=true`. We resist:

> Distribution equality is *necessary* but not *sufficient* for
> unitary equivalence.

Concrete counterexample baked into the goldens: `prepare(1/2); rz(π);
observe` vs `prepare(1/2); observe`. Both produce the 50/50 standard-
basis distribution. They are NOT equivalent unitaries — `rz(π)`
applies a meaningful phase to the |1⟩ component that would show up in
a different measurement basis. The `equal=false reason="out-of-scope"
detail="distribution-match-but-not-syntactic"` answer is the honest
one. CLAUDE.md Rule 8 (honest scope) demands this; soundness on
`equal=true` is the load-bearing invariant.

The matrix-equivalence-over-Q[√2,i] check that would resolve this
branch is deferred to scientist-workbench-jfj (the same issue that
holds the deferred exact-symbolic path for `sturm-execute`). When jfj
lands, this branch upgrades to a sound matrix-equivalence verdict for
the in-scope fragment.

### Witness shape mirrors cas-verify but with quantum-specific fields

cas-verify's witness is `lhs - rhs` (the difference value).
sturm-equivalent's witness is the differing measurement outcome:

```
{ classical_resolutions: [...], lhs_prob: <float>, rhs_prob: <float> }
```

This carries enough information to refute equivalence: the named
resolution-key has provably different probabilities under the two
circuits. The first differing outcome (in canonical sort order) is
emitted; complete enumeration of every disagreement was considered
and rejected as unnecessary detail (one disagreement is enough).

### Symmetry as a property test, not just an invariant

`equivalent(a, b).equal === equivalent(b, a).equal` is in the
invariants list as machine-checkable. The `--test` hook actually runs
it on three probe pairs (empty/empty, bell/bell+ry(0), bell/not-bell),
each in both directions, comparing the `equal` field. A symmetry
violation would surface as a thrown error.

This is the kind of property test CLAUDE.md Rule 7 explicitly calls
for: "every property test asserts an invariant." It's not "ran without
errors"; it's "ran twice in two orders and got the same answer."

### Deterministic despite subprocess composition

The `--test` hook also runs the same input twice and compares
canonical bytes. This catches any nondeterminism that might creep in
through the subprocess boundary (e.g., a stray timestamp, a
nondeterministic sort, an environment variable that changes between
invocations). On the IEEE-754 + provenance-write path, both spawned
tools are deterministic; their outputs are byte-equal across runs.

## Frictions surfaced

- **`Schema<Value>` annotation on inputSchema lost the record narrow.**
  TS quietly inferred the wrong type for `fn`'s `input` parameter
  until I dropped the explicit annotation. The lesson (re-learned —
  shard 008 had the same flavour): `defineTool` infers `I` from the
  schema, but only if the schema's TS type carries the narrow info.
  An explicit `: Schema<Value>` annotation throws away the narrow.
  Let inference work; only annotate when the inferred type is
  pathologically wide.

- **The 200 ms latency is real but not in the way I expected.** I
  budgeted ~50 ms per spawn, ~200 ms total in the worst case. The
  actual goldens phase (14 cases with up to 4 spawns each = up to 56
  spawns) ran in ~3.2 seconds — comfortably faster than I feared. Bun
  spawn is cheap.

- **Tool-on-tool subprocess composition is unusual but not
  forbidden.** The convention is "tools depend on packages"; I
  deviated to "tool spawns tool" with a documented rationale. No
  existing convention check (`scripts/check.ts`) flagged it. If we
  decide later that this pattern should be formalised — or
  prohibited — the right place is `CLAUDE.md` and an ADR. For now,
  v0.1 ships this way; the README documents the deviation.

- **`distribution-match-but-not-syntactic` is the honest right answer
  but feels weak.** The killer-demo pitch from the issue ("circuit
  equivalence over Clifford+T") wants a stronger answer. The honest
  v0.1 produces "I can't tell, but here are the analytic
  distributions." This is correct but not impressive in isolation.
  The matrix-equivalence-over-Q[√2,i] check (jfj) is what turns this
  from "honest scope" into "killer demo." Until jfj lands, the demo
  is "we can decide many cases by simplification + execute, with
  honest out-of-scope on the rest." That's the truthful pitch.

- **`packages/sturm-ir` doesn't have rewrites and probably never
  should.** I considered briefly extracting `simplifyChannel` into
  sturm-ir, but that's the package's stated non-scope. The right
  long-term home for shared simplification logic is a new package
  (`@workbench/sturm-rewrites`?) or — more pragmatically — keeping
  the tool-on-tool subprocess pattern for now. Filed as future work;
  no specific issue created since the latency hasn't actually become
  a problem.

## Acceptance

- 7-artefact contract — tool.ts (literate), package.json, README.md,
  goldens.spec.ts (14 entries), goldens/ (generated), --test hook,
  --schema conformance.
- `bun run check`: 20/20 phases green.
- 14 goldens regenerate cleanly.
- Bell vs Bell+redundant-ry(0) → `{equal: true}` end-to-end via
  `scripts/demo-scope.sh` demo 12.
- Main README catalog row added.
- ADR-0003 record-with-flag pattern implemented; ADR-0006 channel
  shape consumed via `sturm-simplify` subprocess; ADR-0007
  distribution shape consumed via `sturm-execute` subprocess.
- Symmetry + determinism property tests pass.
- Issue scientist-workbench-564 closed.

## Pointers

- `tools/sturm-equivalent/tool.ts` — the literate implementation.
- `tools/sturm-equivalent/README.md` — agent-facing reference.
- `tools/sturm-equivalent/goldens.spec.ts` — 14 representative inputs.
- `docs/adr/0003-tool-output-error-patterns.md` — record-with-flag
  pattern this tool follows.
- `docs/adr/0006-sturm-ir-as-value.md` — channel shape (input).
- `docs/adr/0007-distribution-vs-sampling.md` — distribution shape
  (consumed via `sturm-execute`).
- `scripts/demo-scope.sh` demo 12 — the killer-demo invocation.
- Shard 015 — `sturm-simplify`, the canonicaliser this composes.
- Shard 018 — `sturm-execute`, the simulator this composes.
- Issue scientist-workbench-jfj — the deferred matrix-equivalence
  path; resolves the "distribution-match-but-not-syntactic" branch.

## Phase 1 status

Phase 1 of the Sturm-TS port (shard 009) is the v0.1 substrate. With
this shard:

- `packages/sturm-ir` ✓ (shard 014, dwg).
- `tools/sturm-simplify` ✓ (shard 015, z8w).
- `tools/sturm-execute` ✓ (shard 018, tkx; jfj filed for the exact
  path).
- `tools/sturm-equivalent` ✓ (this shard, 564; jfj also resolves the
  distribution-match-not-byte-equal branch when matrix equivalence
  lands).

**Phase 1 is complete.** The end-to-end pipeline from issue (`echo IR
| sturm-simplify | sturm-execute`) ships a deterministic, content-
addressed analytic distribution for any in-scope channel; equivalence
is decidable within the simplify-induced canonical-form fragment, with
honest out-of-scope on the rest.

Phase 2 picks up from here: `entropy-source` (kw1) and `sturm-sample`
(bir) are the natural next pieces (the sampling half of the
distribution-vs-sampling factoring); `sturm-trace` (q0b) is the
TypeScript frontend; `sturm-bennett-oracle` (733) and
`sturm-qecc-wrap` (8e8) and the channel combinators (o1q) round out
the v0.2 vocabulary.
