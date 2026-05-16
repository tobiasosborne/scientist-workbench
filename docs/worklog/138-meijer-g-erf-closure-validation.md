# 138 — Erf-family dispatcher ↔ bridge closure validation (ADR-0040 T3)

**Date:** 2026-05-17
**Bead:** `scientist-workbench-el7c` (T3 — meijer-g-symbolic-only Erf-emission closure validation)
**ADR:** ADR-0040 §"Decision 5" (bridge API), R4 §1 + §1.a (Form A / Form B coexistence)
**Prereqs (closed):** I6 (`tc2c`, worklog 137 — Meijer-G bridge for Erf)

## Context

ADR-0040 §"Decision 10" defines Phase 3 as "Tool integration": once the
substrate beads (Phase 2) ship, the bridge-vs-dispatcher round-trip must
*close* — the dispatcher's Erf-emitting rules must produce expressions
whose extracted head + args feed cleanly back through I6's
`headToMeijerG` forward bridge to a canonical R4 §1 G-form. Anything that
doesn't close is either:

- a bug in the dispatch rule (its G-form doesn't match R4 §1's canonical
  Form A/B per Erf-family), OR
- an incomplete I6 backward matcher (the rule's G-form needs additional
  `meijerGToHead` coverage), OR
- a documented Form A / Form B coexistence (R4 §1.a — by design).

This bead is the closure-validation harness: walk every Erf-emitting
rule, run it, peel off `cas-simplify/out-of-scope` wrappers, extract
the load-bearing head + args, feed back through the bridge, compare
against R4 §1's pinned canonical tuples.

The contract being verified is what ADR-0040's "world's best Erf" claim
rests on for the symbolic layer: a Meijer-G that *names* a head must
round-trip to that head's canonical G-form. If it doesn't, the symbolic
pipeline has an internally-inconsistent representation — the user could
get different goldens depending on which path (dispatcher or bridge) the
planner happens to take.

## What changed

```
packages/meijer-core/test/erf-closure.test.ts   (+431)  NEW
tools/meijer-g-symbolic-only/README.md          (+32)   Closure validation section
docs/worklog/138-meijer-g-erf-closure-validation.md (+this file)  NEW
docs/worklog/README.md                          (+1)    Index row for 138
```

No source modifications to `packages/meijer-core/src/` — per the bead's
explicit constraint and CLAUDE.md Rule 8 ("honest scope"). Closure
validation is a verifier, not a fixer; the four rules round-trip cleanly
today so no follow-up beads filed.

### Rule survey

Discovered by grepping `packages/meijer-core/src/dispatch-rules/` for
emissions of `Erf` / `Erfc` / `Erfi` heads. The frozen inventory:

| # | Rule id | File | Emitted head | Closes? |
|---|---|---|---|---|
| 1 | `dlmf-16-18-erf` | `dispatch-rules/dlmf-16-18.ts:119` | `Erf` (Form B) | ✓ via Form A coexistence |
| 2 | `erf-bridge-form-a` | `dispatch-rules/erf-forward-form-a.ts:69` | `Erf` (Form A) | ✓ byte-identical params |
| 3 | `erfc-bridge` | `dispatch-rules/erfc-forward.ts:47` | `Erfc` | ✓ byte-identical params |
| 4 | `erfi-bridge` | `dispatch-rules/erfi-forward.ts:66` | `Erf` (post-A3) | ✓ via canonicalisation |

**Rules surveyed:** 4 of 4.
**Round-trip closes cleanly:** 4 / 4.
**Findings filed:** 0.

The `erfi-bridge` row is subtle: the dispatcher's `casSimplify`
post-processing applies the I4 `erfi-canonicalise` identity (`Erfi(z) →
−i · Erf(iz)`, worklog 134), so the emitted AST contains `Erf` with an
`I`-bearing argument, NOT `Erfi`. The bridge happily handles arbitrary
single-arg heads — `headToMeijerG("Erf", [I · √u])` produces Form A's
G-form with z-slot `mkPower(I · √u, 2)`. Closure intact, the way the
math is intact: A3 is correct, the bridge sees an Erf and emits Form A,
and the slot-shift identity threads the consistency together.

### Anatomy of the round-trip (file-top documentation)

The test's file-top narrative explains the *structural* nature of the
closure: byte-identity of the z-slot back to the rule's original input
is NOT the contract, because the bridge's `headToMeijerG` always emits
z-slot = `mkPower(args[0], 2)` (or `mkNeg(mkPower(args[0], 2))` for
Erfi), and the rule's emission has `args[0] = mkPower(rule_input_z,
1/2)`. The composition `mkPower(mkPower(rule_input_z, 1/2), 2)` is
mathematically `rule_input_z` but structurally a distinct nested-power
AST, and `casSimplify` deliberately refuses the reduction (multi-valued
root surface; the I6 file-top explains why).

So the load-bearing comparison is on `(an, ap, bm, bq)`, not on the
z-slot. The closure-validation test asserts the canonical R4 §1 slot
tuples are recovered exactly; z-slot byte-identity is documented as a
known-false structural fact, not enforced.

### Form A / Form B coexistence (R4 §1.a — NOT a finding)

`dlmf-16-18-erf` emits Form B's expression (`√π · Erf(√z)` from
`G^{1,1}_{1,2}([1], [], [1/2], [0], z)`); the bridge re-emits Form A's
G-form (`an=[1/2], bm=[0], bq=[-1/2]`) for the recovered `Erf(√z)`.
This is BY DESIGN per R4 §1.a — both encode the same scalar function
up to the slot-shift `z^{1/2}·G_FormA = G_FormB`. The test pins this
explicitly with two assertions:

1. The Form B rule and the Form A rule both emit `Erf` with byte-
   identical args (`[mkPower(z, 1/2)]`) — the head + args layer agrees.
2. The bridge's recovered slot tuple is Form A's, NOT Form B's — the
   *G-form* layer differs structurally (the slot-shift relation lives
   between them, not a structural identity).

This documented coexistence is the regression anchor: if either side's
encoding ever drifts (e.g. a future agent "simplifies" Form A's bridge
emission to match Form B's slot tuple), the test fails RED with a clear
finger pointing at the regression site.

### Frozen `RULE_PROBES` inventory

The test pins the four Erf-emitting rules as a hand-coded
`RULE_PROBES: readonly ErfEmittingRuleProbe[]` table at the top of
`erf-closure.test.ts`. Each row carries:

- `id` — the rule's stable diagnostic handle
- `file` — source-of-truth path
- `expectedEmittedHead` — what the dispatcher's emission contains *after*
  `casSimplify` post-processing (note: `erfi-bridge`'s row is `Erf`, not
  `Erfi`, because of A3 canonicalisation)
- `inputParams` + `inputZ` — the synthesised input that fires the rule
- `expectedBridgeParams` — R4 §1's canonical tuple for the recovered head
- `zSlotByteIdenticalToRuleInput` — `false` for all rows today; documented
  as the structural-not-mathematical nature of the closure

The `rule inventory invariant` test asserts that the probed ids exactly
cover the set of rules in `ALL_RULES` that emit Erf-family heads. A
future agent who adds a fifth rule (e.g. a PBM Vol 3 §8.4 Erf shard)
without adding a probe row gets a hard RED — the inventory test forces
the closure-validation pattern to extend additively with the rule table.

## Why these choices

### Why a structural check, not a numerical re-validation

The mpmath numerical re-validation (`dispatch-mpmath.test.ts`) already
validates that each rule's *value* at z=2 (or similar) agrees with
`mpmath.meijerg` to 30 dps — the rule emits the *right* expression
numerically. What the closure test adds is *structural* consistency: the
rule's emission and the bridge's canonical forward must agree on the
G-form's identity at the AST level, so the planner sees one coherent
representation regardless of which path (dispatcher or bridge) it takes.

A purely numerical check wouldn't catch a structural drift — two
different G-forms might evaluate to the same scalar but represent
distinct Meijer integrals, and the planner needs to know which integral
it has (the contour direction, residue closure side, etc).

### Why hand-roll the probe inventory, not auto-discover

Auto-discovery (walking `ALL_RULES` and probing each with a generic
synthesised input) would need a tiny rule-evaluator that builds matching
inputs from a `PatternSpec` — overkill for a 4-rule inventory, and
brittle the moment a rule with `free-shift` slots or cross-slot
relations lands. The hand-rolled list is 4 rows × ~20 LOC each =
~80 LOC, fully explicit, and forces a *deliberate edit* when a new rule
is added (matching the CLAUDE.md Rule 8 "honest scope" discipline:
explicit inventory tests an explicit coverage claim).

### Why no findings filed

All four rules close cleanly. The Form A / Form B coexistence is the
only structural variance and is BY DESIGN per R4 §1.a (a P4 doc-of-record
that already lives in the worklog 137 shard and the R4 reference). The
bead's P-tiering for findings (P2 = wrong rule, P3 = bridge gap, P4 =
documented coexistence) thus filters to *zero* new beads — closure is
clean.

If a future Erf-emitting rule (PBM Vol 3 §8.4 or Wolfram Functions Site
shard) lands and breaks closure, the test file is the obvious landing
site for the closure check and the finding bead.

### Why the test re-asserts the inventory in a sentinel test

The trailing `findings inventory` test contains an empty `FINDINGS`
list. If a future finding *is* filed, the bead reference goes there with
its severity, and the test body documents the open gap. This makes the
"closure is clean today" claim machine-checkable — silence is success
only if the sentinel is there to be silent.

## Mutation-proving (2/2 RED, restored)

Per CLAUDE.md Rule 6 "Port-and-verify" discipline, the closure-validation
tests mutation-proved against two distinct perturbations:

**Mutation 1 — alter the expected bridge param tuple for `erf-bridge-form-a`:**

```diff
-      an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)],
+      an: [R(1, 99)], ap: [], bm: [I(0)], bq: [R(-1, 2)],
```

Result: 1 RED — `erf-bridge-form-a → headToMeijerG closure (...)`. The
slot-tuple assertion catches the perturbation immediately.

Restored; back to green.

**Mutation 2 — alter the `expectedEmittedHead` for `erfc-bridge`:**

```diff
-    expectedEmittedHead: "Erfc",
+    expectedEmittedHead: "Erfi",
```

Result: 2 RED — the inventory test AND the per-rule closure test (the
inventory test asserts the dispatcher emits the expected head; the
closure test then runs the bridge on that head). Demonstrates the head-
detection layer is load-bearing.

Restored; back to green.

Two mutations are sufficient here (vs. the 3 the substrate beads
required) because the closure validation is a *verifier* — not the
algorithmic substrate — and the perturbation surface is the assertion
table itself. The two mutations cover the two load-bearing layers of
the verifier (slot-tuple match + head-detection); a third mutation on
the `headToMeijerG` call would test bridge behaviour, not closure, and
the bridge has its own mutation-proving in worklog 137.

## Frictions surfaced

### F1 — `casSimplify` wraps everything in `tagged "cas-simplify/out-of-scope"`

The dispatcher's `casSimplify` post-processing wraps every special-
function subterm in `tagged "cas-simplify/out-of-scope"` (the Q(x)
canonicaliser doesn't enter special-function heads). The test needs a
`stripSimplifyTags` recursive walker to find the raw `Erf` / `Erfc` /
`Erfi` heads under the tags. The walker recurses into both tagged
payloads AND expression args, so heads buried inside `Erf(...)` arguments
also get unwrapped — load-bearing for the Erfi probe (the `Erf` head is
wrapped *inside* a `neg(I · Erf(...))` structure after A3).

Lesson for future closure-validation extensions: any test reading the
dispatcher's output structurally needs `stripSimplifyTags` or
equivalent. The `SIMPLIFY_TAG` constant (exported from `@workbench/cas-
core`) is the right hook.

### F2 — z-slot byte-identity is structurally false even on bridge-forward round-trips

Initially expected: feed `erf-bridge-form-a` an input with z-slot
`mkPower(z, 2)` (the bridge's natural emission), get back the rule's
emission `Erf(√(z²))`, feed to bridge `headToMeijerG("Erf", [√(z²)])`,
get back z-slot `mkPower(√(z²), 2)` = byte-identical to the input.

Actually: `mkPower(mkPower(mkPower(z, 2), 1/2), 2)` is NOT byte-identical
to `mkPower(z, 2)`. The nested-power AST has more layers than the
original — `casSimplify` could reduce them if it were willing to commit
to `(z²)^{1/2} = z` (only true for z ≥ 0), but it deliberately doesn't
(the bridge's file-top explains the multi-valued root reasoning).

So the test's `zSlotByteIdenticalToRuleInput` flag is `false` for ALL
probes; the closure assertion is on the slot tuple `(an, ap, bm, bq)`,
not on z-slot bytes. Documented in the file-top "Anatomy of the round-
trip" section and as a per-probe comment.

### F3 — TypeScript narrowing on `r.kind !== "matched"` guards

Two early test-block guards used the pattern:

```ts
if (r.kind !== "matched") {
  expect(r.kind).toBe("matched");
  return;
}
```

which TypeScript flagged as `error TS2769` — inside the guard body,
`r.kind` is narrowed to `"no-known-reduction"`, and `toBe("matched")`
expects the `"matched"` literal. Fixed by hoisting the assertion out of
the guard:

```ts
expect(r.kind).toBe("matched");
if (r.kind !== "matched") return;
```

This passes both `tsc --noEmit` and the runtime assertion; the
narrowing-friendly shape is the one used throughout the existing
`bridges-erf.test.ts` for consistency.

## Acceptance

- [x] `packages/meijer-core/test/erf-closure.test.ts` lands with the
  full per-rule closure validation (4/4 rules surveyed, 4/4 close).
- [x] `tools/meijer-g-symbolic-only/README.md` extended with a "Closure
  validation" section.
- [x] Frozen `RULE_PROBES` inventory pins the four Erf-emitting rules
  and forces additive extension when new rules land.
- [x] Form A / Form B coexistence is asserted explicitly (regression
  anchor for R4 §1.a).
- [x] Mutation-proving documented (2/2 RED + restored).
- [x] `bun test packages/meijer-core/test/erf-closure.test.ts`:
  11 pass / 0 fail / 83 expect() calls.
- [x] `bun test packages/meijer-core/`: 260 pass / 1 skip / 0 fail
  (249 pre-bead + 11 new).
- [x] No source modifications to `dispatch-rules/` — per bead constraint.
- [x] No findings filed — all 4 rules close cleanly.

## Numerical agreement — out of scope for closure

The closure-validation layer is structural; numerical agreement
(`bigErf(z) ≡ wrap(meijergArbprec(gForm))` at 50 dp) is a separate
substrate-level cross-check pending bead `d6s` (per-head arbprec MeijerG
evaluator). The structural closure is the necessary condition; numerical
agreement is the sufficient one. When `d6s` lands, the
`bridges-erf.test.ts` Layer 5 (already `test.skip(...)` with a
documenting note) wires the numerical cross-check; this closure test
keeps its structural focus.

## Pointers

* ADR-0040 — per-head special-function substrate; §"Decision 5"
  (bridge API), §"Decision 10" (Phase 3 tool-integration scope).
* R4 — `docs/refs/erf-research/R4-meijer-g-bridge.md`; §1 canonical
  table, §1.a Form A / Form B coexistence (the doc-of-record this test
  enshrines as a regression anchor).
* Worklog 137 (`tc2c`/I6) — Meijer-G bridge for Erf; the substrate this
  bead validates.
* Worklog 134 (`bfwt`/I4) — cas-core Erf identity table; established the
  A3 `Erfi(z) → −i · Erf(iz)` canonicalisation that the Erfi closure
  probe exercises.
* `packages/meijer-core/test/erf-closure.test.ts` — the closure test.
* `packages/meijer-core/src/bridges/erf.ts` — the bridge being validated.
* `packages/meijer-core/src/dispatch-rules/{dlmf-16-18, erf-forward-form-a,
  erfc-forward, erfi-forward}.ts` — the four Erf-emitting rules.
* `tools/meijer-g-symbolic-only/README.md` — the public-facing wire tool
  doc that names the closure-validation layer alongside the mpmath
  numerical re-validation layer.
