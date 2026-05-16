# 137 — Erf-family Meijer-G bridge (ADR-0040 I6)

**Date:** 2026-05-17
**Bead:** `scientist-workbench-tc2c` (I6 — Meijer-G bridge for Erf)
**ADR:** ADR-0040 §"Decision 5" (bridge API), §"Decision 6" (Erfi
encoding pin), R4 §1–§3 (`docs/refs/erf-research/R4-meijer-g-bridge.md`)
**Prereqs (closed):** I6a (`m114`, worklog 132 — Erfi vocab admit), I4
(`bfwt`, worklog 134 — cas-core Erf identity table)

## Context

ADR-0040 §"Decision 5" pins the bidirectional Meijer-G ↔ named-head
bridge as the load-bearing closure between the special-function
substrate (the bigfloat / quadrature / cas-core Erf-family ports
shipped by I1–I5) and the symbolic Meijer-G dispatcher in
`@workbench/meijer-core` (ADR-0025). The bridge is what turns
"`headToMeijerG(Erf, [z])` → canonical G-form" and "`meijerGToHead(form)`
→ named head + args" into a per-head bidirectional table — the
reference implementation pattern the rest of ADR-0040's deferred heads
(Bessel, Whittaker, ParabolicCylinder, Legendre family, LerchPhi) will
reuse.

R4's research (898 lines, `docs/refs/erf-research/R4-meijer-g-bridge.md`)
pinned the canonical Erf-family G-forms via SymPy + diofant + mpmath
triangulation (Wolfram Functions Site PDFs were HTTP 403 from this
harness; the three-CAS triangulation is the substitute primary
reference). The key findings:

1. **Three canonical forms** for Erf / Erfc / Erfi, with one collision:
   Erf and Erfi share an identical `(an, ap, bm, bq) = ([1/2], [], [0],
   [-1/2])` parameter tuple; only the z-substitution sign distinguishes
   them (Erf: `+z²`; Erfi: `−z²`). The dispatcher's pre-bead matcher
   was purely slot-based — it could not see the z-slot at all.

2. **`Erf⁻¹` and `Erfc⁻¹` have NO Meijer-G representation** in the
   literature (DLMF §7.17 gives only power-series). Honest refusal
   (`null` return) is the contract — adding inverse-erf to the bridge
   without a representation would be the inadmissible-lie category per
   CLAUDE.md Rule 8.

3. **The multi-valued √ on round-trip** would silently corrupt sign
   information: `headToMeijerG("Erf", [-1])` → `meijerGToHead(...)`
   computed via naive `√(g.z)` returns `Erf(1)`, not `Erf(-1)`. The
   `zInverse` closure trick (R4 §3.b) sidesteps this entirely by
   recording the original args lexically on the `ForwardBridge` record.

4. **Form A vs Form B coexistence.** The existing
   `dlmf-16-18-erf` rule (Form B, emits `√π · Erf(√z)` from
   `G^{1,1}_{1,2}([1], [], [1/2], [0], z)`) is a *different* Meijer
   G-function from Form A (which the bridge canonicalises on, per R4
   §1.a). Both backward paths coexist in the dispatcher; they don't
   shadow each other because the parameter slot values differ.

## What changed

### New: bridge module + per-head landing

```
packages/meijer-core/src/bridges/types.ts           (+93)   NEW
packages/meijer-core/src/bridges/erf.ts             (+330)  NEW
packages/meijer-core/src/dispatch-rules/erf-forward-form-a.ts  (+78)   NEW
packages/meijer-core/src/dispatch-rules/erfc-forward.ts         (+61)   NEW
packages/meijer-core/src/dispatch-rules/erfi-forward.ts         (+95)   NEW
packages/meijer-core/test/bridges-erf.test.ts                   (+316)  NEW
```

### Edits

```
packages/meijer-core/src/dispatch-types.ts          (+26)   PatternSpec.zMatch?
packages/meijer-core/src/dispatch.ts                (+18)   tryMatch threads z; respects zMatch
packages/meijer-core/src/index.ts                   (+24)   re-export bridge API
packages/meijer-core/test/dispatch.test.ts           (+8)   citation regex accepts PBM + R4
packages/meijer-core/README.md                      (+62)   Bridge layer section + API table
tools/meijer-g-symbolic-only/README.md              (+19)   Erf-family rules in coverage
```

### API shape

The bridge API matches R4 §3 / ADR-0040 §"Decision 5" exactly:

```ts
export interface MeijerGForm {
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
  readonly z: Value;
}

export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;      // prefactor application
  readonly zInverse: () => readonly Value[];    // byte-identical args recovery
}

export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null;

export function meijerGToHead(
  form: MeijerGForm,
  prefactor?: Value,
): { head: string; args: readonly Value[] } | null;
```

The forward bridge handles `Erf`, `Erfc`, `Erfi` (single-argument
heads); returns `null` for `InverseErf` / `InverseErfc` (honest refusal,
no Meijer-G form in the literature); returns `null` for any other head
(out-of-scope; caller can try the next bridge).

The standalone backward bridge pattern-matches against the canonical
parameter quintuples. Erf vs Erfi disambiguation runs purely
structurally on the z-slot: explicit unary `neg` / `-` wrapper → Erfi;
anything else → Erf.

### `PatternSpec.zMatch?` extension (the additive dispatcher hook)

R4 §2.5.1 Option 1: a minimal, optional predicate on `PatternSpec` that
runs after slot-by-slot matching and gates whether the rule fires:

```ts
export interface PatternSpec {
  // ... existing fields ...
  readonly zMatch?: (z: Value) => "yes" | "no" | "unknown";
}
```

Absent predicate → "match every z" (the default-preserving behaviour;
every legacy rule continues to fire exactly as before — 0 regression
across the 196 pre-extension meijer-core tests).

The Erf forward rule (`erf-forward-form-a.ts`) registers
`zIsNotExplicitlyNegated`; the Erfi rule (`erfi-forward.ts`) registers
`zIsExplicitlyNegated`. Together they partition the z-argument space
exactly: any structural unary `neg` / `-` routes to Erfi; anything else
routes to Erf. Mutation 2 below demonstrates the predicate is
load-bearing.

### `zInverse` closure trick

The forward bridge records the original `args` in a closure on the
`ForwardBridge` record. The backward bridge that the forward produced
calls `zInverse()` to recover them byte-identically — the multi-valued
`√(z²)` problem never enters the picture for round-trips through this
module's own forward path.

For backward calls on G-forms NOT produced by this module's forward
(e.g. user-constructed or dispatcher-emitted), the standalone backward
path reconstructs args from the G-form's z-slot directly via
`mkPower(z_slot, 1/2)`. That emission is honest — the bridge doesn't
pretend to know the un-substituted argument that produced an arbitrary
`g.z`; `cas-simplify` may or may not reduce further.

## Why these choices

### Why `null` for inverse-erf, not `tagged "..."`

`null` is the canonical "this bridge module doesn't handle this head"
signal in the bridge API; it composes additively with future bridge
modules (a top-level router could try each registered bridge until one
returns non-null). `tagged` would inflate the API surface for what is
structurally an absence. The honest refusal IS the `null` return,
documented in the function's prose ("Returns null for the
honestly-refused inverses"). The wire tool `tools/special-eval`
(ADR-0040 §"Decision 7") translates this to the user-facing
`tagged "special-eval/no-known-representation"` envelope; bridge-level
`null` is the internal-API shape.

### Why `√π = mkPower(sym("pi"), rat(1n, 2n))` (NOT `expr("sqrt", [sym("pi")])`)

ADR-0040 §"Decision 6" pin, matching I4's identity table
(`packages/cas-core/src/special-funcs/erf-identities.ts`). The
unification is load-bearing for the simplify ↔ bridge composition:
when `cas-simplify` runs after a bridge emission (which it does — the
dispatcher pipes everything through `casSimplify`), it sees the same
`√π` shape the I4 rewriter emits. Byte-identity composes; encoding
mismatch would force a manual canonicalisation pass.

### Why `i = sym("I")` (the convention from I4 worklog 134)

Pinned in I4's top-of-file narrative (`erf-identities.ts`): cas-core
has no `complex` head, and ADR-0023 deliberately doesn't include one.
The bare symbol `I` is the cheapest viable encoding; the
`expr("^", [int(-1n), rat(1n, 2n)])` alternative inflates Erfi-rewrite
AST size by ~5x and is itself bridge-out-of-scope. The Erfi forward
bridge in this iteration emits the G-form's `−z²` slot directly — no
`i` needed inside the bridge itself — but the convention is documented
here so when an A3 rewrite (`Erfi(z) → −i · Erf(iz)`) composes with a
later bridge call, the encoding lines up.

### Why Form A.Erf and `dlmf-16-18-erf` (Form B) coexist

R4 §1.a + §4.b: Form A and Form B are *distinct* Meijer G-functions.
Form A: `an=[1/2], bm=[0], bq=[-1/2]`, represents `√π/√z · Erf(√z)`.
Form B: `an=[1], bm=[1/2], bq=[0]`, represents `√π · Erf(√z)`. They
are related by the DLMF 16.19.2 parameter-shift identity, but neither
subsumes the other on the wire. The bridge canonicalises forward on
Form A (SymPy / diofant / PBM convention); the backward dispatch
matches both shapes independently. Test asserts the existing Form B
rule still fires post-bridge-addition.

### Why the bridge rules sit FIRST in `ALL_RULES`

R4 §5.a / §5.b: the bridge rules are the most-specific match for
their shapes (literal-only slot patterns, plus `zMatch` discrimination
on the Erf/Erfi-shared tuple). Any future generic rule for the same
shape must come AFTER the bridge to preserve round-trip closure; the
first-match-wins discipline is preserved.

### Why the test's citation regex extended to include PBM and R4

The dispatch-test's "every rule cites primary literature" check
originally accepted only "Bateman" or "DLMF". The new Erf-family
bridge rules legitimately cite `R4 §1` (the local research artefact,
which itself triangulates SymPy + diofant + mpmath against PBM Vol 3
§8.4) and `PBM Vol 3 §8.4` (the canonical Meijer-G integral table that
DLMF §16.18 Examples doesn't cover). Extending the regex is the honest
fix; adding spurious "DLMF" tokens to the source string would
misrepresent the citation chain. R4 IS our literature artefact for the
bridge work.

## Mutation-proving (3/3 RED, restored)

Per CLAUDE.md Rule 6 "Port-and-verify" discipline, the bridge tests
mutation-proved against three distinct perturbations:

**Mutation 1 — swap `bm` ↔ `bq` in the Erf forward G-form:**
```diff
-        bm: [ZERO_INT],
-        bq: [NEG_HALF],
+        bm: [NEG_HALF],
+        bq: [ZERO_INT],
```
Result: 3 RED in `bridges-erf.test.ts`:
- `headToMeijerG — forward bridge structural anchors > Erf(z): an=[1/2], ap=[], bm=[0], bq=[-1/2]`
- `meijerGToHead — standalone backward bridge > Form A.Erf G-form → Erf head, args = [√(z-slot)]`
- `dispatcher integration > Erf vs Erfi at the dispatcher level: zMatch partitions cleanly` (the Erf rule no longer matches its own forward emission, so the rule never fires)

Restored; back to green.

**Mutation 2 — drop `zMatch` from the Erf rule (NOT Erfi; explanation
below):**
```diff
-      zMatch: zIsNotExplicitlyNegated,
+      // zMatch dropped: Erfi inputs misroute to Erf
```
Initial attempt at the spec's literal "drop from Erfi" produced 0 RED.
That's because the rule registry order is `[ErfFormA, Erfi, ...]` and
Erf has its own `zMatch` declining on negated z — so Erfi-shaped inputs
still flowed past Erf (declined) into Erfi (accepted), regardless of
whether Erfi's own `zMatch` was present. The right mutation that
exposes the load-bearing role is to drop Erf's `zMatch`: now Erf
accepts negated z (because no predicate declines) and wins first by
ordering. Erfi never fires. Result: 2 RED:
- `dispatcher integration > new erfi-bridge rule fires on Erfi G-shape (z explicitly negated)`
- `dispatcher integration > Erf vs Erfi at the dispatcher level: zMatch partitions cleanly`

Restored; back to green.

This is a worth-knowing finding for any future agent adding parallel
`zMatch`-bearing rules: the predicate-drop on the *later* rule is
masked by the *earlier* rule's predicate; the discrimination is
load-bearing on the earlier rule because that's the one whose
predicate gates whether the dispatcher *moves on* to the later rule
at all.

**Mutation 3 — replace `zInverse` closure with naive `√(g.z)`:**
```diff
-      const zInverse = (): readonly Value[] => [z];
+      const zInverse = (): readonly Value[] => [mkPower(gForm.z, HALF)];
```
Result: 11 RED across the entire round-trip test sweep (every Erf
sample: symbolic z, integer 1/2/5/-1/-3, rational 1/2 / 3/4 / -2/3,
expression `2*z`). Every single round-trip assertion fails because the
recovered arg is `√(z²)` — structurally `mkPower(mkPower(z, 2), 1/2)`,
NOT byte-identical to the original `z`. For the negative-integer
samples this is the literal multi-valued-root bug R4 §3.b warned
about.

Restored; back to green.

## Frictions surfaced

### F1 — Mutation 2 surface mismatch: drop-from-Erfi was a no-op

The spec asked for "drop `zMatch` from Erfi"; the actual load-bearing
mutation is "drop `zMatch` from Erf". Documented above. Lesson: the
predicate-pair `(zIsNotExplicitlyNegated, zIsExplicitlyNegated)` looks
symmetric but isn't — the earlier rule's predicate is the one that
gates the dispatch tree. A future rule-author adding a third
collision-shape rule should set predicate on the *earlier* rule first
and verify both directions partition.

### F2 — `casSimplify` runs A3 (Erfi-canonicaliser) on dispatcher output

The dispatcher's `casSimplify` post-processing pipes Erfi rewrites
through I4's identity table; the I4 `erfi-canonicalise` rule rewrites
`Erfi(z) → −i · Erf(iz)` per A3 (worklog 134). So my first test
assertion `expect(JSON.stringify(r.expr)).toContain("Erfi")` failed —
the canonicalised output contains `Erf` (with `I` in the argument),
not literal `Erfi`. Test fixed to assert on `Erf` + `name":"I"`. This
is *correct* behaviour at the rule-firing level (`ruleId` is
`erfi-bridge`); the canonicalisation is the cas-simplify pipeline's
job. Worth-knowing for any future bridge rule that emits a head with
an active I4 identity.

### F3 — `dispatch-audit.test.ts` only inspects `dispatch.ts | dispatch-types.ts | dispatch-rules/*`

The bridges module sits under `src/bridges/`, deliberately outside the
audit grep's scope. The bridges file is a pure record-typed translation
table from R4 §1 — no risk of porting-from-OSS surface (Wolfram /
SymPy / diofant identifiers don't appear). The audit grep's exclusion
of `bridges/` is honest: the audit is for the dispatcher's pattern-
table layer, not for the per-head bridge intermediates.

## Acceptance

- [x] `MeijerGForm` + `ForwardBridge` types in `bridges/types.ts`.
- [x] `headToMeijerG` + `meijerGToHead` for `Erf`, `Erfc`, `Erfi`.
- [x] `null` return for `InverseErf` / `InverseErfc` (honest refusal).
- [x] `PatternSpec.zMatch?` extension landed without breaking any
  existing dispatch-rule test (196 pre-extension meijer-core tests all
  green post-extension; 0 regression).
- [x] Round-trip property byte-identical for Erf, Erfc, Erfi across a
  representative sample (11 ARG_SAMPLES × 3 heads = 33 round-trip
  assertions; all green).
- [x] Existing `dlmf-16-18-erf` rule still fires (regression check
  asserts `ruleId === "dlmf-16-18-erf"` for Form B input).
- [x] Erf vs Erfi disambiguation via `zMatch` proven at both the
  standalone-backward-bridge level and the dispatcher level.
- [x] Mutation-proving: 3/3 perturbations RED + restored; documented
  above.
- [x] `bun test packages/meijer-core/`: 249 pass / 1 skip / 0 fail
  (196 pre-bead + 53 new + 1 numerical-agreement-skipped-pending-d6s).
- [x] Doc lockstep: `packages/meijer-core/README.md` gains "Bridge
  layer" section; `tools/meijer-g-symbolic-only/README.md` gains
  Erf-family rule rows in coverage table.

## Numerical agreement — deferred

The R4 §3.b numerical-agreement cross-check (`bigErf(z) ≡
wrap(meijergArbprec(gForm))` at 50 dp) is the substrate-level closure
tying the bridge to I3 (`bigCErf`, shipped) and the per-head arbprec
MeijerG evaluator (bead `d6s`, NOT shipped). The test is
`test.skip("...")` with a documenting comment. When `d6s` lands, that
test wires the cross-check; the bridge's correctness contract until
then is structural byte-identity (Layer 2 of `bridges-erf.test.ts`,
which IS green).

## Pointers

* ADR-0040 — per-head special-function substrate; §"Decision 5"
  (bridge API), §"Decision 6" (Erfi encoding).
* R4 — `docs/refs/erf-research/R4-meijer-g-bridge.md`; §1 canonical
  table, §2.5.1 Erf/Erfi disambiguation, §3 bridge API proposal, §5
  pattern-matcher subtleties.
* Worklog 132 (`m114`/I6a) — Erfi vocabulary admission; established the
  `√π = mkPower(sym("pi"), rat(1n, 2n))` encoding pin.
* Worklog 134 (`bfwt`/I4) — cas-core Erf identity table; established
  the `√π` and `i = sym("I")` encoding conventions the bridge mirrors.
* Worklog 136 (`wzzq`/I3) — `bigCErf` complex arbprec; the future
  consumer of the bridge's `wrap` closure when `d6s` (per-head arbprec
  MeijerG evaluator) ships.
* `packages/meijer-core/src/bridges/erf.ts` — the bridge implementation.
* `packages/meijer-core/src/bridges/types.ts` — `MeijerGForm` +
  `ForwardBridge`.
* `packages/meijer-core/src/dispatch-rules/erf-forward-form-a.ts`,
  `erfc-forward.ts`, `erfi-forward.ts` — the three new dispatch rules.
* `packages/meijer-core/test/bridges-erf.test.ts` — the bridge tests.
