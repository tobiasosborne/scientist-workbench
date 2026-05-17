# 155 — I6: Bessel-family Meijer-G bidirectional bridge

**Bead:** `scientist-workbench-kgky` (I6).
**Epic:** `scientist-workbench-zcam` (world-class Bessel J/Y/I/K).
**ADR:** [`docs/adr/0041-bessel-family-per-head-substrate.md`](../adr/0041-bessel-family-per-head-substrate.md), §"Decision 5".
**Predecessor:** I6-prep (closure-rename `zInverse → argsInverse`, arity-agnostic).
**Date:** 2026-05-17.

## Context

The Bessel epic's Meijer-G bridge axis: per ADR-0041 §"Decision 5" (and
Bessel R4 §A.4 / §C / §D in `docs/refs/besselj-research/R4-meijer-g-
bridge.md`), the workbench ships a per-head bidirectional bridge between
the four canonical Bessel heads (`BesselJ`, `BesselY`, `BesselI`,
`BesselK`) and the Meijer G-function on the wire. This is the **second**
per-head bridge module in the workbench (Erf was the first) and the
**first** to validate the 2-arg `(ν, z)` shape. I6 is also the load-
bearing validation of I6-prep's `argsInverse` rename — without an
arity-agnostic closure, every additional head arity would force a bridge-
API refactor.

## What changed

1. **`packages/meijer-core/src/bridges/bessel.ts` (NEW, ~360 LOC).**
   Forward `headToMeijerG(head, [nu, z]) → ForwardBridge | null` and
   standalone backward `meijerGToHead(form) → { head, args } | null` for
   the four Bessel heads. Literate file-top narrative cites ADR-0041
   §"Decision 5" + R4 §A.4 and explains the load-bearing **ν-uniformity**
   finding: the naïve 12-cell G-form table (4 heads × 3 ν-classes
   integer/half-integer/general) collapses to 4 forms because the slot
   tuples `[ν/2]`, `[-ν/2]`, `[(ν+1)/2]` carry un-evaluated ν straight
   through. ν-class-specific reductions (`J_{1/2}(z) = √(2/(πz))·sin(z)`,
   integer-ν parity, recurrences) live in `cas-simplify`'s
   `bessel-identities.ts` (I4 / worklog 152), NOT in this bridge. The
   bridge is **purely a syntactic transformer** between named-head AST
   and G-function AST.

2. **`packages/meijer-core/src/index.ts` (edited).** Re-exports
   `headToMeijerG as headToMeijerGBessel` + `meijerGToHead as
   meijerGToHeadBessel`. Disambiguated names because the Erf bridge
   already owns the `headToMeijerG` symbol; a top-level dispatcher (when
   it lands) will iterate over both bridges and return the first non-null
   hit.

3. **`packages/meijer-core/test/bridges-bessel.test.ts` (NEW, ~320
   LOC).** 53 tests across 4 layers:
   - **Layer 1 — forward structural anchors** (8 tests). One slot-tuple
     anchor per head (BesselJ / BesselY / BesselI / BesselK) verifying
     the exact slot encoding from R4 §A.4. Plus uniform-z²/4 check,
     unique-`(m,n,p,q)` check, unknown-head check, wrong-arity check.
   - **Layer 2 — byte-identical 2-arg round-trip** (33 tests). 4 heads
     × 8 representative `(ν, z)` sample pairs = 32 round-trips through
     `argsInverse()` + 1 order-sentinel test verifying `[nu, z]` order
     (not `[z, nu]`). The first 2-arg verification of the arity-agnostic
     closure trick in the workbench.
   - **Layer 3 — standalone backward bridge** (7 tests). One per-head
     round-trip via `meijerGToHead`, plus non-literal-slot fallback
     (`2·slot` / `√(4·slot)` emission), no-match → null, Erf-shape →
     null (cross-bridge isolation).
   - **Layer 4 — prefactor checks** (5 tests). J/Y identity, I → π·g,
     K → (1/2)·g, plus a J/I/K cross-distinction mutation sentinel.

## The 4 canonical G-forms (R4 §A.4, Wolfram convention)

```
BesselJ(ν,z) = G^{1,0}_{0,2}([], [];        [ν/2],       [-ν/2];         z²/4)   prefactor 1
BesselY(ν,z) = G^{2,0}_{1,3}([], [-(ν+1)/2]; [ν/2, -ν/2], [-(ν+1)/2];    z²/4)   prefactor 1
BesselI(ν,z) = G^{1,0}_{1,3}([], [(ν+1)/2];  [ν/2],       [-ν/2, (ν+1)/2]; z²/4) prefactor π
BesselK(ν,z) = G^{2,0}_{0,2}([], [];        [ν/2, -ν/2], [];             z²/4)   prefactor 1/2
```

## Why these choices

* **`argsInverse` closure captures `[nu, z]` lexically — no multi-valued
  root surface.** The z-substitution is `z²/4`; recovering `z = √(4·g.z)`
  loses sign over ℝ and is multi-valued over ℂ. The 2-element closure
  sidesteps both. Erf's 1-arg closure pinned the trick; Bessel
  generalises it. Same return type (`readonly Value[]`) — only the list
  length changes.
* **Unique `(m,n,p,q)` per head — no Erf-style z-sign disambiguation.**
  Erf and Erfi share `(1,1,1,2)` and need z-sign discrimination; Bessel's
  four heads each have a distinct shape (`(1,0,0,2)` / `(2,0,1,3)` /
  `(1,0,1,3)` / `(2,0,0,2)`). Backward standalone is a clean shape
  switch.
* **Standalone backward path emits literal `2·slot` / `√(4·slot)` for
  non-canonical inputs.** When a hand-built G-form's `bm[0]` isn't shaped
  as `mkDiv(?, 2)`, the recoverer cannot honestly assume the slot is
  literal `ν/2`; it emits `2·slot` and lets `cas-simplify` handle. For
  canonical (forward-built) forms, the literal `mkDiv(?, 2)` unwrap
  fires and recovers `ν` byte-identically.
* **Disambiguated re-exports (`headToMeijerGBessel`,
  `meijerGToHeadBessel`).** The Erf bridge already owns the
  `headToMeijerG` symbol at the package barrel. Adding a top-level
  dispatcher that tries every registered bridge in order is a follow-up;
  the disambiguated names today let callers route head → bridge
  explicitly without ambiguity.

## Mutation-proving (Rule 6 discipline)

Three mutations exercised against the test suite (manually verified
during development; the structural assertions catch each):

1. **M1 — swap `bm: [ν/2]` to `bm: [-ν/2]` in BesselJ.** Layer 1
   `BesselJ` structural anchor fires RED (the `canonicalize(gForm.bm[0])`
   check expects `ν/2`, not `-ν/2`).
2. **M2 — drop prefactor on BesselK (`(1/2) · g` → `g`).** Layer 4
   `BesselK.wrap(g) === (1/2)·g` fires RED; plus the J/I/K
   cross-distinction sentinel (`K.wrap(g)` must NOT equal `g`).
3. **M3 — `argsInverse: () => [z, nu]` (swapped order).** Layer 2's
   `Order is [nu, z], not [z, nu]` sentinel fires RED (`args[0]` is
   `I(7)` not `I(3)`), plus every per-sample round-trip with non-equal
   nu/z fires RED on the canonicalize check.

## Frictions surfaced

* **Symbol convention `sym("pi")` lowercase** — matches both `erf.ts`'s
  `SQRT_PI` and `bessel-identities.ts:249`. Re-verifying this each
  session is friction; could be a top-of-package convention constant
  someday.
* **No `mkPlus` import previously in `erf.ts`** — Bessel's `(ν+1)/2`
  needed `mkPlus([nu, ONE_INT])`; the test file also imports `mkPlus`
  for its canonical-form helpers. Routine, but a reminder that the
  cas-core `mk*` helpers are the right primitive set for every bridge
  module.
* **Pre-existing erf-bridge tests use the unscoped `headToMeijerG` /
  `meijerGToHead` exports** — adding the Bessel exports under the same
  names would break those. The disambiguated `*Bessel` re-export is the
  honest fix until a top-level dispatcher lands.

## Acceptance

* `bessel.ts` on disk; literate top-of-file narrative citing R4 §A.4 +
  ADR-0041 §Decision 5; explains ν-uniformity.
* `bridges-bessel.test.ts` with 53 tests, all green.
* `bun test packages/meijer-core/test/bridges-bessel.test.ts` →
  `53 pass, 0 fail` in ~110ms.
* Existing `bridges-erf.test.ts` byte-identical (no edits to `erf.ts` or
  `types.ts` — I6-prep already finalised them).
* Bead `kgky` closable.

## Pointers

* [`packages/meijer-core/src/bridges/bessel.ts`](../../packages/meijer-core/src/bridges/bessel.ts) — the bridge module.
* [`packages/meijer-core/test/bridges-bessel.test.ts`](../../packages/meijer-core/test/bridges-bessel.test.ts) — 53-test suite.
* [`packages/meijer-core/src/bridges/erf.ts`](../../packages/meijer-core/src/bridges/erf.ts) — styling exemplar (1-arg precedent).
* [`packages/meijer-core/src/bridges/types.ts`](../../packages/meijer-core/src/bridges/types.ts) — `ForwardBridge` with `argsInverse`.
* [`docs/refs/besselj-research/R4-meijer-g-bridge.md`](../refs/besselj-research/R4-meijer-g-bridge.md) — canonical-form table + API design.
* [`docs/adr/0041-bessel-family-per-head-substrate.md`](../adr/0041-bessel-family-per-head-substrate.md) — §"Decision 5".
