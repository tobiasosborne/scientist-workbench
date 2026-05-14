# 110 — HSDE Phase 5 Tier 1: iterative refinement on the Schur back-sub (2026-05-14)

> **Scope.** Close bead `vajd`. Add `solveWithIR` and wire it into the three
> Cholesky back-substitutions of each HSDE solver, so the regularised factor
> is sharpened back toward the *unperturbed* Schur system. The `nitref1/2/3`
> trace slots from Tier 0 stop being stubs. No change to PRSTATUS,
> termination thresholds, or the And09/Mosek sign convention (HANDOFF §5).

## Context

`docs/HANDOFF_solver_ipm_hsde_part2.md §4` specifies the fix for the
`hinf2` precision floor: every HSDE iter factors `Lchol = chol(M + reg·I)`
and back-substitutes three RHSs through it, returning `dy` accurate to the
*regularised* system `(M + reg·I)·dy ≈ rhs` — but the algorithm wants
`M·dy ≈ rhs`. On `hinf2` the Schur condition number reaches ~1e+13 and the
3-way Tikhonov lift (cap `1e-2`) is a large relative perturbation against
M's small corner; the back-sub error pins the solver's `pInf`.

Iterative refinement (Higham §12; SDPT3 §2.5; ECOS `kkt.c:113-232`) reuses
the regularised `Lchol` as a cheap approximate solver for the exact system.

## What Changed

**`packages/solver-ipm/src/linalg/IterativeRefinement.ts` (new)** —
`solveWithIR(M, m, Lchol, rhs, dy, workE, workCorr, maxIter=9,
tolRel=1e-14, stagnationFactor=6)` → accepted-step count. Initial back-sub,
then a loop: residual `e = rhs − M·dy` against the **unperturbed** M;
converge when `‖e‖∞ < tolRel·(1+‖rhs‖∞)`; stagnate when a step buys < 6×
improvement; **trial-and-rollback** — a step that would increase the
residual is undone, never committed.

The HANDOFF §4.2 pseudocode carries a deliberately-planted bug in its undo
path. The fix here is a **two-workspace dance**: `workE` holds the residual
of the accepted iterate; once `errNorm` is captured as a scalar, `workE`
is free to receive the *trial* residual, while `workCorr` retains the
correction — so the in-place rollback `dy -= workCorr` is exact. The
sketch's bug was overwriting the correction buffer with the trial
residual, leaving nothing to undo with.

**`HsdeLpSolver.ts`** — `State` gains `workE`, `workCorr` (allocated once
per solve) and `nitref1/2/3`. The three `dyN.set(rhs);
choleskySolveInPlace(...)` pairs in `computeDataDirection` /
`computeAffineDirection` / `computeCombinedDirection` become one
`solveWithIR(...)` call each, storing the step count into `st`. The
verbose-trace emission reads `st.nitref{1,2,3}` instead of the Tier-0
literal `0`.

**`HsdeNtSdpSolver.ts`** — the same, with `workE/workCorr` and
`nitref1/2/3` as function-scope locals (the SDP solver is not
State-struct-based). `factorWith3Way` was verified to copy `M` into
`Lchol` before factoring (`Lchol.set(M)`), so the unperturbed `M` is
intact for the IR residual — HANDOFF §4.3's "verify it doesn't mutate M".

`choleskySolveInPlace` is no longer imported by either HSDE solver
(`choleskyInPlace` is still used by the SDP solver elsewhere).

## Tests

**`hsde-precision.test.ts` (new, 8 probes)** — targets `solveWithIR`
directly on hand-built systems with a known true solution (`M = L0·L0ᵀ`
for chosen lower-triangular `L0`, so M is SPD by construction;
`rhs = M·dyTrue`):

- *ill-conditioned* (cond ≈ 1e14): IR fires (`nitref ≥ 1`), the residual
  against the unperturbed M is **strictly** smaller than the plain
  regularised back-sub's, and the iterate is **closer to `dyTrue`**.
- *already-accurate factor* (exact `chol(M)`): `nitref = 0`, and the
  result is bit-identical to the plain back-sub — IR recognises it has
  nothing to do.
- *poor preconditioner*: handed the factor of the identity instead of a
  factor of M, the correction recurrence diverges; the overshooting step
  is **rolled back**, `nitref = 0`, residual unchanged — IR with a useless
  factor does no harm.

**Mutation-proving** (Rule 6): two representative mutations, each
confirmed RED then restored:
- residual sign flip (`rhs − M·dy` → `M·dy − rhs`) → 2 ill-conditioned
  probes go RED;
- defeat the rollback (`if (trialErrNorm > errNorm)` → `if (false)`) → the
  poor-preconditioner probe goes RED. (The first attempt at the test
  suite did **not** catch this — the ill-conditioned Gram case never
  overshoots, because IR is monotone in exact arithmetic; the dedicated
  poor-preconditioner construction was added precisely to exercise the
  rollback.)

The existing 113-test solver-ipm suite still passes — that zero-regression
*is* the "trajectories converge to the same wire output as Tier 0"
evidence (HANDOFF §4.6). One Tier-0 test (`hsde-lp.test.ts`) asserted
`nitref === 0` as an invariant; updated to the Tier-1 reality (a
non-negative integer ≤ `maxIter`).

## `hinf2` diagnostic — where IR helped, and where it didn't

Ran `solveHsdeSdpNt` on `hinf2.dat-s` with IR off (`maxIter=0`, =Tier-0)
and on (`maxIter=9`):

| | returned `pInf` | trajectory low | status |
|---|---|---|---|
| IR off (Tier 0) | `8.14e-7` | floor ~`1.26e-7` (HANDOFF) | numerical-difficulty |
| IR on (Tier 1) | `5.64e-8` | touches `~4.1e-10` | numerical-difficulty |

**IR demonstrably breaks the back-substitution floor.** The Tier-0
trajectory was *locked* at `pInf ≈ 1.26e-7` from iter ~36; with IR the
trajectory moves freely through the `1e-8`–`1e-10` band and individual
iterates reach `pInf ≈ 4e-10`. `nitref` tuples in the trace vary exactly
as HANDOFF §4.6 predicts — `(0,0,0)` on well-conditioned iters, climbing
to `(1,1,2)` where the Schur is ill-conditioned — 303 accepted refinement
steps across the run, firing on late iters too. The returned `pInf`
improves ~14× (`8.14e-7` → `5.64e-8`).

**What IR did not do alone:** `hinf2` still returns `numerical-difficulty`,
not a clean `optimal`. The trajectory *reaches* `pInf < 1e-9`, but the
best-iterate selection and termination logic return a snapshot at
`5.64e-8` — the good iterates are not being recognised as terminal. That
is honest scope: converting the unlocked precision into a clean
`optimal` + corpus 6/6 is the **Tier 2** (`fsr7` — hsde-precision tests +
Mosek comparison oracle) and **Tier 3** (`lniy` — corpus 6/6 +
`sdp-solve` default → `hsde-nt`) work this tier unblocks. HANDOFF §4.6
explicitly anticipated this ("may need to loosen to 1e-8 if IR doesn't
fully crack it") — Tier 1's job was the IR *core*, and the core works:
the floor is no longer a floor.

## Frictions Surfaced

- The rollback path is exact-arithmetic-redundant. `e' = reg·(M+reg·I)⁻¹·e`
  always contracts in exact arithmetic, so IR is monotone unless rounding
  error in the correction solve exceeds the (possibly tiny) contraction.
  A clean deterministic trigger needs a *poor* preconditioner, not just an
  ill-conditioned M — hence the identity-factor test construction.
- The relative tolerance `tolRel·(1+‖rhs‖∞)` means that on extreme-`‖rhs‖`
  systems a seemingly-large absolute residual (`~1e-2`) is already at
  relative machine precision, so `nitref = 0` is correct there — observed
  while probing for rollback triggers.

## Acceptance

- `bunx tsc --noEmit` — pass.
- `bun test packages/solver-ipm` — 113 pass, 0 fail (zero regression;
  8 new `hsde-precision` probes).
- `bun run check` — green.
- `nitref` varies in the verbose trace; `solveWithIR` verified
  field-by-field on known systems; both mutation probes caught.
- `hinf2` precision floor unlocked (1.26e-7 → trajectory ~4e-10);
  clean-`optimal` termination deferred to Tier 2/3 with honest evidence.

## Pointers

- `packages/solver-ipm/src/linalg/IterativeRefinement.ts` — `solveWithIR`.
- `packages/solver-ipm/src/solver/HsdeLpSolver.ts`,
  `HsdeNtSdpSolver.ts` — the six wired back-sub sites.
- `packages/solver-ipm/test/hsde-precision.test.ts` — the precision probes.
- `docs/HANDOFF_solver_ipm_hsde_part2.md §4`–`§5` — the spec and hazards.
- Bead `vajd` (closes). Unblocks `fsr7` (Tier 2), `lniy` (Tier 3).
