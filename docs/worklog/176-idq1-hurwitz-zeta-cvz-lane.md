# 176 — Hurwitz zeta CVZ lane: Cohen-Villegas-Zagier acceleration

**Date:** 2026-05-20.
**Bead:** `scientist-workbench-idq1` ([gamma] v0.2 hardening — CVZ
acceleration for the small-`a` Hurwitz-zeta regime).
**File:** [`packages/bigfloat/src/special-funcs/zeta.ts`](../../packages/bigfloat/src/special-funcs/zeta.ts).

## Context

Bead `ha9f` landed the standalone Hurwitz-zeta substrate
(`bigHurwitzZeta`, `bigRiemannZeta`) on the Euler-Maclaurin (EM)
asymptotic series with a self-shift wrapper. The R2 critical review
flagged that EM is *asymptotic in `1/a`* — for small `a` it has no
convergent regime and must shift `a` up past a precision-dependent
threshold before its series is usable. R2 proposed adding a
Cohen-Villegas-Zagier (CVZ) acceleration lane (Cohen, Villegas &
Zagier 2000, "Convergence acceleration of alternating series",
Experiment. Math. 9:3) which converges *geometrically* for small `a`
with no divergence regime — the algorithm mpmath uses for the Lerch
transcendent.

## What changed

A second evaluation lane was added to `zeta.ts` (~270 LOC including
the literate prose) and a CVZ test block (~210 LOC) to
`test/special-funcs/zeta.test.ts`.

### CVZ route chosen — eta-transform recurrence

CVZ accelerates *alternating* series; Hurwitz zeta `Σ(a+k)^{-s}` is
all-positive. Three candidate bridges were investigated and two
empirically rejected:

- **Hasse globally-convergent series** — converges only *algebraically*
  (`~1/N`) for small `a`; 200 terms gave 1 digit at `a = 0.01`.
  Rejected.
- **van Wijngaarden condensation + CVZ** — the condensed series decays
  only polynomially, so CVZ cannot recover a geometric rate
  (`~1/depth²` measured). Rejected.
- **Eta-transform recurrence** — *chosen*. The exact even/odd split
  `ζ(s,a) = η(s,a) + 2^{1-s}ζ(s,(a+1)/2)`, unrolled to
  `ζ(s,a) = Σ_{j≥0} 2^{j(1-s)} η(s,a_j)` with `a_{j+1}=(a_j+1)/2`,
  where each alternating eta `η(s,a)=Σ(-1)^k(a+k)^{-s}` is evaluated
  by CVZ Algorithm 1. This is exact and geometrically convergent.

CVZ Algorithm 1: integer weights `d_k` (Pell-Chebyshev sequence
`d_0=1, d_1=3, d_k=6d_{k-1}-d_{k-2}`), the running `b`-factor carried
as an exact reduced BigInt ratio — *no transcendental ever appears*,
so the lane is `arbprec: true` (bit-identical at fixed `prec`). The
`b ← −1` initialiser (not `+1`) was the first transcription bug
caught — `+1` inverts the accelerator weights entirely.

### The decisive finding — CVZ is slower than EM for integer `s ≥ 2`

The lane is correct but **not worth dispatching to**. Cost accounting:

- EM-with-shift: shift count `N` is *capped* at
  `hurwitzShiftThreshold(prec,s) ≈ 0.17·prec` and does **not** grow as
  `a → 0`. Total `O(prec)` ops. Measured 1–5 ms for `a ∈ [10⁻⁶, 1]`,
  prec 200–400.
- CVZ via eta-transform: `J ≈ prec/(s−1)` recurrence steps, each a CVZ
  `η` of `n ≈ prec/2.54` terms. Total `O(prec²/(s−1))`.
- Measured CVZ/EM ratio: **70×–490× slower** across the integer-`s`
  regime (`s=2..12`, prec 200–400).

CVZ wins for the *Lerch transcendent* because the Lerch series
`Σ z^k(a+k)^{-s}` is already geometric (`|z|<1`) and already
alternating (`z=−1`) — one CVZ pass. Plain Hurwitz zeta is `z=1`:
neither, so the `O(prec)`-step eta-transform recurrence is
unavoidable.

Per CLAUDE.md "honest scope" and the bead's explicit instruction —
*"if the dispatch turns out not worth it, say so and gate
conservatively"* — `bigHurwitzZeta` therefore **always routes to the
EM lane**. The CVZ lane is exported as `_hurwitzZetaCVZ`, fully
cross-validated against EM, and documented as the building block for
the future complex-`s` / alternating-Lerch bead.

### Polygamma byte-identity — preserved by construction

`polygamma(m≥2,·)` routes through `bigHurwitzZeta`, and (verified —
`polygammaHurwitz` passes the user's `z` *unshifted*) its `z` can be
any small positive value. The bead's premise that polygamma's `a` is
"already large" is wrong. The resolution: because the CVZ lane is a
*separate exported function* (`_hurwitzZetaCVZ`) and `bigHurwitzZeta`
unconditionally takes the EM path, the EM code path is byte-for-byte
unchanged. `special.test.ts` (53 tests, incl. the byte-exact
`polygamma(2,1)` / `polygamma(2,1/2)` `toString` goldens) is green.

## Why these choices

A legendary senior engineer ships the *correct* lane even when the
honest finding is "it is not the fast path" — and gates it so it
cannot regress the hot path. Adding CVZ as a separate function rather
than an internal branch of `bigHurwitzZeta` is what makes the
polygamma byte-identity guarantee structural (zero-risk) rather than
a tolerance argument.

## Frictions surfaced

- R2-arbprec-algorithms.md has **no** Hurwitz/CVZ section — only the
  EM Appendix B. The CVZ algorithm had to be reasoned from the
  published paper directly.
- CVZ Algorithm 1 transcription is sign-sensitive: `b ← −1` (not `+1`)
  and `c ← −d_n`. The canonical `ln 2 = Σ(-1)^k/(k+1)` check was used
  to pin the correct variant.
- The CVZ lane is slow enough (~600 ms/call at prec 200) that the
  determinism tests needed explicit 20 s timeouts — a full-suite-load
  run tripped the default 5 s timeout once.

## Acceptance

- `bun test packages/bigfloat/test/special-funcs/zeta.test.ts`:
  47 pass / 0 fail (22 original + 25 new CVZ).
- `bun test packages/bigfloat/test/special.test.ts`: 53 pass / 0 fail
  — polygamma goldens byte-identical.
- `bun test packages/bigfloat/`: 1139 pass / 0 fail.
- `bun run check:quick`: green.
- 3 mutation markers (M5 `b`-initialiser, M6 prefactor sign, M7 `d_n`
  recurrence coefficient) live-perturbed → all 10 path-agreement tests
  RED; restored → GREEN.

## Pointers

- `packages/bigfloat/src/special-funcs/zeta.ts` §"CVZ lane",
  §"Lane selection" — the derivation and the perf finding.
- `_hurwitzZetaCVZ`, `hurwitzEtaCVZ`, `bigintGcd` — the new functions.
- `packages/bigfloat/test/special-funcs/zeta.test.ts` blocks 9–15.
