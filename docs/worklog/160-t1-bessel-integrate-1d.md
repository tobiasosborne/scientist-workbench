# 160 — `tools/integrate-1d` learns Bessel J/Y/I/K in the integrand (Bessel Phase 3 / T1, 2026-05-17)

> **Scope.** Close Bessel-epic Phase-3 Tier-1 bead `scientist-workbench-pp7j`
> (`T1 — tools/integrate-1d learns BesselJ/Y/I/K in integrand via I5a
> float64 dispatcher`). The substrate (`packages/quadrature/src/
> special-funcs/bessel-float64.ts` + `eval-numeric-expr.ts` `BesselJ/Y/I/K`
> entries, worklog 154, bead `rkoo`) shipped the dispatcher and the
> arity-2 hooks; T1 adds 4 new DLMF-cited golden tests to
> `tools/integrate-1d/tool.test.ts` and corrects the formerly-broken
> `BesselJ outside admitted vocabulary` assertion to use a still-unknown
> head.

## Context

ADR-0041 §"Decision 4" pinned the Bessel float64 dispatcher: the four
heads `BesselJ`, `BesselY`, `BesselI`, `BesselK` extend the existing
`SPECIAL_HEADS` set in `packages/quadrature/src/eval-numeric-expr.ts`
with arity-2 dispatch entries (lines 180-205 of the file) that route
into the verbatim R3 ports in `bessel-float64.ts` (musl `j0.c`/`j1.c`/
`jn.c` for J/Y integer ν; Cephes `i0.c`/`i1.c`/`k0.c`/`k1.c` for I/K
order 0/1; DLMF-shape ports for general ν). I5a (`rkoo`, worklog 154)
shipped the substrate and the dispatcher entries; T1's job is to
*prove* that `tools/integrate-1d` picks them up through the existing
`foldSpecialHeads` rewrite pass (added in worklog 140 / Erf T1) without
any tool-side change.

The pre-Erf-T1 version of `tools/integrate-1d/tool.test.ts` asserted
that `BesselJ` in the integrand throws `ToolError` (the "head outside
admitted vocabulary" invariant). Erf-T1 pre-emptively rotated this
assertion to `WhittakerM` (still unknown to the dispatcher even after
the Bessel admission, per ADR-0023 — Whittaker is in cas-core's
`SPECIAL_FUNCTION_HEADS` but has no float64 substrate). The current
test file (committed in `120ebf0`) already carries the rotation, so
this bead's "fix the broken assertion" task collapsed to *strengthening*
the rotated assertion with `BesselJ`/`BesselK` suggestion-text checks
(the dispatcher's vocabulary list must now surface those heads to
calling agents).

## What changed

### `tools/integrate-1d/tool.test.ts` — 4 new tests + strengthened refusal assertion + header

**File header** rewritten to document both Erf-T1 (worklog 140) and
Bessel-T1 (this shard) wirings, plus the load-bearing fact that
Bessel is the first multi-arg special head in the integrand
vocabulary (Erf was 1-arg throughout). The dispatcher's `requireArity`
runtime check is cited inline so a fresh reader sees the contract
without bouncing to the substrate file.

**Refusal assertion strengthened** (the `WhittakerM` test in §3):
suggestion text must now contain `Erf`, `Erfc`, `BesselJ`, `BesselK`
(was: `Erf`, `Erfc` only). This proves both T1 wirings are reflected
in the surfaced vocabulary list. The literate comment also documents
the *history* — assertion originally targeted `BesselJ`, was rotated
to `WhittakerM` when ADR-0041 admitted Bessel, will need rotation
again when Whittaker ships its substrate.

**New §4 — Bessel-family closed-form anchors** (4 tests):

1. **`∫_0^1 x · J_0(x) dx = J_1(1)`** — DLMF 10.22.1 with
   `d/dx [x · J_1(x)] = x · J_0(x)`. The cleanest closed-form
   identity: no truncation, no cancellation, smooth integrand on
   `[0, 1]`. J_1(1) ≈ 0.4400505857449335 (musl `j1.c`). Bound
   1e-14; empirical residual ≈ 5.5e-17 (≈ 0.5 ULP).
2. **`∫_0^10 J_1(x) dx = 1 - J_0(10)`** — DLMF 10.22.1 with
   `(J_0)' = -J_1`. The oscillatory integrand has 3 zeros in
   `[0, 10]`; G7K15 adaptive bisection handles them on the first
   pass. Target ≈ 1.2459358; bound 1e-13; empirical residual ≈
   2.2e-16. Also asserts `converged === true` (a budget-cap miss
   would surface as `converged === false`).
3. **`∫_0^100 e^(-x) · J_0(x) dx = 1/√2`** — DLMF 10.22.49 with
   `a = b = 1`, truncated from `[0, ∞)` to `[0, 100]`. The
   exponential decay bounds the tail residual `∫_100^∞ ≤ e^(-100) ·
   O(√100) ≈ 3.7e-43` — far below float64 resolution, so the
   truncation matches the analytic 1/√2 ≈ 0.7071068 at the float64
   ceiling. Bound 1e-12; empirical residual ≈ 1.1e-16.
4. **`∫_0^1 J_0(x) dx ≈ 0.9197304100897603`** — partial of DLMF
   10.22.43's `∫_0^∞ J_ν(x) dx = 1`. Cross-validated *two ways*:
   (a) byte-identical agreement with a direct-path oracle that calls
   `besselJFloat64` and `gaussKronrodAdaptive` without going through
   `foldSpecialHeads`, proving the dispatcher composition is
   byte-faithful; (b) literature anchor at 1e-15 against the mpmath-
    truncated-to-float64 value.

Test 4's `directJ0Integral` helper is the substantive load-bearing
piece: it bypasses the `foldSpecialHeads` rewrite by calling the
substrate directly, so the `expect(got).toBe(oracle)` comparison
exercises the dispatcher's byte-identity contract (CLAUDE.md Rule 7
— "didn't throw" never counts). A regression in either the
substrate or the rewrite walker breaks this exact-bit assertion.

## Why these choices

### Why these 4 integrals and not the K_0 / improper variants

The brief offered 6 candidates; I picked the 4 that (a) have
*genuinely closed* analytic targets at float64 precision, (b) cover
both 1-step (smooth) and adaptive (oscillatory) G7K15 paths, and
(c) cover both `J_0` and `J_1` heads (and J_n integer-ν via
`besselJFloat64(0, ...)` and `(1, ...)`). The K_0 candidate
(`∫_0^1 K_0(x) dx`) was dropped because (i) no closed-form analytic
target exists for the partial; (ii) computing a reference via
`bigBesselK` integrated at 50 dp through `gaussKronrodAdaptiveBF`
costs ~1 min wall-clock per test run (verified empirically — the
bg-task was killed before completion), which is a cost the inner-
loop `bun test` workflow can't bear. K-integrand coverage is
provided indirectly via `tools/special-eval`'s direct K_0/K_1
goldens (T2 / bead `unno`); the integrate-1d goldens here lock J
specifically, which is the most-frequently-integrated Bessel head
in the literature.

### Why test 4 uses byte-identity, not tolerance

The other 3 tests anchor to *analytic identities* (which only hold
to within float64 rounding); test 4 anchors to a *path-equivalence*
claim (the dispatcher must produce the same value as the direct
substrate call). Path equivalence is a byte-level property of the
dispatcher's rewrite walker; relaxing it to a tolerance bound
would silently admit a regression where `foldSpecialHeads` returns
a value 2 ULP off. `expect(got).toBe(oracle)` is the right
strength.

### Why I did not touch `tools/integrate-1d/tool.ts`

The Erf-T1 worklog 140 friction #1 already established: the
substrate dispatcher composes correctly with the tool because
`foldSpecialHeads` is arity-agnostic (it folds any `expression`
node whose head is in `SPECIAL_HEADS_SET`, regardless of how many
arguments). Bessel's 2-arg shape rides through without code
change. Empirically verified by writing the tests first (no
substrate-side touchups needed — `bun test` green on the first
run). This matches the bead's "primarily a test bead" framing and
the worklog 140 precedent (no source change unless a real
composition gap surfaces).

### Why `directJ0Integral` is a local helper not a shared utility

It's a single-use oracle for one test. Hoisting it into a shared
helper module would invite future tests to depend on its specific
shape (which is "bypass the dispatcher"). Keeping it local with a
literate comment about *why* the helper exists is the legible
choice.

## Frictions surfaced

### 1. The "broken BesselJ assertion" was already pre-emptively fixed

The bead body framed T1 as needing to *fix* a broken
`BesselJ outside admitted vocabulary` assertion. The current test
file (committed in `120ebf0`, two commits before T1 claim) already
carried the rotation to `WhittakerM`. So the "fix" task collapsed
to *strengthening* the assertion with `BesselJ`/`BesselK` text
checks (positive evidence that the dispatcher's surfaced vocab
includes the new admissions). Worth noting for the orchestrator:
the Erf-T1 author was already anticipating the Bessel admission
and prepared the test surface ahead of the substrate ship.

### 2. K_0 oracle via `gaussKronrodAdaptiveBF` is too slow for inner-loop tests

A first-pass attempt to compute `∫_0^1 K_0(x) dx` at 50 dp via
`bigBesselK` integrated through `gaussKronrodAdaptiveBF` did not
complete in the test budget (background task ran > 1 min before
being killed). For Erf-T1's analogous test (`∫_0^1 Erf(x)·exp(-x²)
dx` at 50 dp), the integrand evaluates 15 G7K15 nodes once per
adaptive bisection step and converges in ≤ 3 steps. K_0 at 50 dp
adds the per-node arb-prec K_0 computation cost (Cephes Chebyshev
expansion at 50 dp ≈ tens of milliseconds per call × hundreds of
nodes); the wall-clock cost makes this unsuitable for `bun test`.
Future work: stage the K_0 oracle as a pre-computed golden bit
pattern in the corpus rather than re-deriving on each test run.

### 3. The dispatcher's vocabulary list surfaces in user-visible error text

The strengthened refusal assertion (test §3) reads
`err.suggestion.toContain("BesselJ")`. This makes the dispatcher's
admitted-vocabulary list a *user-visible contract*: changing the
order of entries in `SPECIAL_HEADS` or removing a head would
surface as a test failure. This is the right shape — agents
planning recovery from an unknown-head error rely on the
suggestion text — but it does mean the suggestion text is now part
of the testable surface. Documented in the test comment so a
future refactor reads the rationale.

## Acceptance

- [x] 4 new Bessel-family golden tests added to `tools/integrate-1d/
  tool.test.ts` (each citing a DLMF identity in the docstring).
- [x] Refusal assertion (`WhittakerM`) strengthened to verify
  `BesselJ`/`BesselK` appear in the surfaced suggestion text — proves
  ADR-0041's dispatcher admission is user-visible.
- [x] File header rewritten to document both Erf-T1 (worklog 140) and
  Bessel-T1 (this shard) wirings, plus the multi-arg head distinction.
- [x] `bun test tools/integrate-1d/tool.test.ts` green: 10 pass / 0
  fail / 36 expects (up from 6/0/24 pre-shard).
- [x] No `tools/integrate-1d/tool.ts` change required (substrate
  dispatcher composes arity-agnostically through `foldSpecialHeads`).
- [x] No substrate change (`packages/quadrature/` untouched per bead
  sanity rails).

## Pointers

- ADR-0041: `docs/adr/0041-bessel-family-per-head-substrate.md`
  §"Decision 4".
- I5a substrate: `packages/quadrature/src/special-funcs/bessel-
  float64.ts` (worklog 154, bead `rkoo`).
- I5a dispatcher entries: `packages/quadrature/src/eval-numeric-
  expr.ts` lines 119-122 (`SPECIAL_HEADS` admission) + 180-205
  (`SPECIAL_DISPATCH` entries).
- Erf-T1 precedent worklog: `docs/worklog/140-integrate-1d-learns-
  erf.md` (the `foldSpecialHeads` rewrite shipped here; this shard
  rides it).
- T1 bead: `scientist-workbench-pp7j` (Bessel epic `scientist-
  workbench-zcam`).
- DLMF references: §10.22.1 (recurrence relations), §10.22.43
  (∫_0^∞ J_ν(x) dx = 1), §10.22.49 (∫_0^∞ e^(-ax) J_ν(bx) dx).
