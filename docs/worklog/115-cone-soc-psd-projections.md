# 115 — cone-core: SOC + PSD cone projections (bead 0wc7)

**Date:** 2026-05-14
**Bead:** scientist-workbench-0wc7 (closes)
**Touches:** `packages/cone-core/src/cones.ts`, `packages/cone-core/src/scs.ts`,
`packages/cone-core/src/index.ts`, `packages/cone-core/test/cones.test.ts`,
`packages/cone-core/test/scs.test.ts`, `packages/cone-core/README.md`,
`docs/ground-truth/convex/cone-projections.md` (new),
`docs/ground-truth/convex/scs-algorithm.md`, `docs/adr/0030-convex-cone-solver-tier.md`,
`docs/refs/parikh-boyd-2014-proximal-algorithms.pdf` (staged)

## Context

`cone-core` v0.1 (shard 112, bead `cp9k`) shipped the LP-complete slice
of the SCS substrate: the three *definitional* cone projections
(zero / free / nonneg) that close the LP bench gate. The second-order
(SOC) and positive-semidefinite (PSD) projections were deferred for a
hard Law-1 reason — O'Donoghue 2016 gives only the cone *definitions*
(§6.1, p. 1059) and defers the projection *formulas* to Parikh-Boyd
*Proximal Algorithms* §6.3, which was not staged. The `SOCone` /
`PSDCone` variants sat in the `Cone` union as the documented type-level
map, but every operation on them threw a loud `ConeError` naming this
bead.

This shard lands those two projections — five of the seven cone
families are now live. It is the keystone unblock for the cone tier:
the PSD cone is the entire reason convex optimisation matters for the
quantum-information side of the workbench (every SDP relaxation, every
entanglement witness, every channel-capacity bound is a PSD-cone
program), and `cone-solve`'s pitch as the *universal* primary is hollow
while it answers `unsupported-cone` to any SDP.

## What changed

**Law 1 first.** `docs/refs/parikh-boyd-2014-proximal-algorithms.pdf`
staged (the free monograph from Boyd's Stanford page). Read §6.3,
pp. 183–184, and transcribed it to a new ground-truth file
`docs/ground-truth/convex/cone-projections.md` — the §6.3 intro (the
Moreau decomposition and the `v ∈ K* ⟹ Π_K(v) = 0` corollary), §6.3.2
(the SOC three-case closed form), §6.3.3 eq (6.6) (the PSD eigenvalue
clamp), plus the §3 derivation of *why the √2 svec scaling is
load-bearing*.

**SOC** — `projectCone` / `inCone` `case "soc"`. Parikh-Boyd writes the
cone vector-first `{(x, t) : ‖x‖₂ ≤ t}`; cone-core (and ADR-0030 §C)
put the scalar apex first, so the formula was re-derived in `(t, x)`
ordering. Three branches — already-in (identity), polar-to-apex (→ 0),
genuine boundary projection `½(1 + t/ρ)·(ρ, x)`. The branch *order*
(`ρ ≤ t` tested before `ρ ≤ −t`) is load-bearing for the `ρ = 0`
corner, and case 3 is provably reached only when `ρ > |t| ≥ 0`, so the
`/(2ρ)` is always safe.

**PSD** — `projectCone` / `inCone` `case "psd"`. The block is the
upper-triangular row-major `svec` of a symmetric matrix with the
strict-Mosek √2 off-diagonal scaling. New internal `smat` helper
un-scales and rebuilds the symmetric `Matrix`; the projection is
`smat → eigh → clamp the negative spectrum to zero → re-assemble
straight into the √2-scaled svec output`. `eigh` is `linalg-core`'s
existing real-symmetric cyclic-Jacobi solver — `smat(z)` is symmetric
by construction, no complex path needed.

**Smart constructors** `soc(dim)` / `psd(side)` added and exported (the
"constructor lands with the projection" discipline from v0.1). Both
reject dimension 0 — a SOC needs its scalar apex coordinate, a PSD
needs a 1×1 block; `soc(1)` / `psd(1)` are the degenerate-but-valid
floor (the nonnegative half-line).

The `ExpCone` / `PowCone` `ConeError` stubs remain, re-pointed at the
remaining sub-bead `j282`; the four `0wc7` stubs are gone.

**`scsSolve` integration.** The SCS iteration is cone-agnostic by
construction — `projectProduct` walks `projectCone` block by block — so
once `cones.ts` projects soc / psd, `scsSolve` handles them with no
further wiring. The only `scs.ts` change needed was the setup gate:
`assertV01Projectable` (which rejected *everything* but nonneg / zero /
free) is now `assertProjectable`, gating only the genuinely
unimplemented `exp` / `pow`. Two end-to-end tests in `scs.test.ts` —
an SOC apex-optimum problem and a PSD `max tr(X) s.t. X ⪯ B` — confirm
the projections compose into the solver and that `status: "optimal"`
stays honest (the §3.5 termination test still judges the *actual*
residuals; an independent `kktResiduals` re-derivation plus an `inCone`
check on the recovered slack back it). They are not a convergence
*benchmark* — worklog 113 is explicit that plain SCS is not
bench-competitive — they prove the *integration*. The tool-layer PSD
*wire form* (`tools/cone-solve` translating an `expression "PSDCone"`
with `size` + `indices` onto this substrate block) is still its own
bead; this shard stops at the `cone-core` substrate.

## Why these choices

**The √2 is not decoration — it is the correctness argument.** The PSD
block could be carried as a plain stacking of the upper triangle; the
√2 off-diagonal scaling is what makes `svec` a linear *isometry*
between `(Sⁿ, ⟨·,·⟩_Frobenius)` and `(ℝ^{n(n+1)/2}, ⟨·,·⟩_Euclidean)`.
That isometry is precisely what licenses `projectCone` to compute the
Euclidean projection of the *block* as `svec` of the Frobenius
projection of the *matrix*. Drop the √2 and the cheap coordinate-wise
route projects onto the wrong set — the classic amateur-SDP bug
ADR-0030 OQ4 calls out. The ground-truth file carries the one-line
isometry proof; OQ4 is now marked resolved.

**`smat` exists, `svec` does not.** The PSD projection assembles its
result straight into the √2-scaled output vector in the same
upper-triangular walk that reads the eigenvectors — there is no
intermediate result matrix, so a standalone `svec` would be dead
surface. `smat` *is* needed (its inverse, the un-scaling rebuild) to
hand `eigh` a real symmetric `Matrix`. The test file carries its own
small `svec` mirror so the projection tests can state inputs and
expected outputs as honest matrices, not opaque vectors.

**Non-finite handling matches the existing cones, per operation.**
`projectCone` keeps its "finite iterate in, finite out" contract — the
caller (`scsSolve`'s `numerical-breakdown` guard) owns non-finiteness,
exactly as the `free`-case docstring already reasoned. `inCone` is a
membership *predicate*, so a non-finite vector is never a member: SOC
gets this for free (a `NaN` poisons the `≥` comparison), PSD pre-scans
the block (a non-finite block cannot be `smat`-rebuilt for `eigh`) —
both return `false`, never throw, matching the `free` / `nonneg` /
`zero` cones.

## Frictions surfaced

- **Idempotence is not bit-exact for the iterative path.** The shared
  `assertProjectionInvariants` helper first asserted `Π(Π(z)) = Π(z)`
  with `toEqual` (copied from the nonneg block, where the projection is
  exact integer-free arithmetic). It failed immediately on PSD —
  `eigh` is iterative, so `Π(Π(z))` is one cyclic-Jacobi sweep away
  from `Π(z)`, not bit-identical. SOC's case-3 boundary value has the
  same hazard (one rounding from re-triggering case 3). Fixed: the
  shared helper uses per-element closeness; the nonneg block keeps its
  own exact `toEqual` idempotence test (its projection genuinely is
  exact).
- **Reference staging is a real Law-1 gate, not a formality.** The
  bead's step (1) is "stage the PDF" — and `WebFetch` returns text,
  not a saved binary, so there is no agent-only path to a staged PDF.
  Surfaced the decision to the user; `curl` from the sandbox worked.
- **The first full `bun run check` caught a stale gate the bead body
  did not anticipate.** `scs.ts`'s `assertV01Projectable` and a
  matching `scs.test.ts` case both hard-coded "only nonneg / zero /
  free are projectable" — invisible from `cones.ts` alone. The check's
  `bun test` phase went RED on the stale test, which is exactly its
  job; the fix (rename + re-scope the gate to exp / pow, rewrite the
  test, add the two end-to-end solves) was a small but real scope
  expansion past the bead body's "implement `cones.ts`" framing.
  Lesson reinforced: Law 1's "open the affected files" has to include
  the files that *depend on* the one you are changing, not just the
  one named in the bead.

## Acceptance

- `soc` / `psd` cases of `projectCone` and `inCone` implemented; the
  four `0wc7` `ConeError` stubs removed; `soc` / `psd` constructors
  exported. `scs.ts`'s setup gate re-scoped (`assertProjectable`); no
  `0wc7` reference remains in `cone-core` source.
- `cones.test.ts`: 45 tests pass (was ~30) — new SOC + PSD describe
  blocks assert idempotence, range, the Moreau decomposition
  `z = Π_K(z) − Π_K(−z)` with orthogonal summands, and
  non-expansiveness over sample pairs, plus exact-value goldens
  (including the off-diagonal PSD case that distinguishes the correct
  √2-svec from plain stacking).
- `scs.test.ts`: the stale "rejects v0.1-unsupported cone" test
  rewritten to gate exp / pow (naming `j282`); two new end-to-end
  `scsSolve` solves on SOC + PSD problems with hand-derived unique
  optima, each cross-checked by an independent `kktResiduals`
  re-derivation and an `inCone` membership test on the recovered
  slack. `packages/cone-core` 90 tests pass (was 72).
- **Mutation-proven** — four targeted perturbations, each confirmed
  RED then restored: `SQRT2 → 1` (drops the isometry; 2 fail), SOC
  case-3 scale dropped (2 fail), SOC case-3 scalar sign-flip (2 fail),
  PSD clamp `λ > 0 → λ ≠ 0` keeps the negative spectrum (5 fail).
- Full `bun run check` — green (see commit).

## Pointers

- `docs/ground-truth/convex/cone-projections.md` — the Parikh-Boyd
  §6.3 transcription, the √2 isometry argument, the cone-core mapping.
- `docs/adr/0030-convex-cone-solver-tier.md` §C, OQ4 (now resolved) —
  the PSD wire/block convention.
- `docs/worklog/112-cone-core-lp-slice.md` — the v0.1 substrate this
  extends; `113`, `114` — `cone-solve` + scaling + bench reconciliation.
- Bead `scientist-workbench-j282` — the remaining `ExpCone` / `PowCone`
  projections (Parikh-Boyd §6.3.4 + Khanh Hien 2014).
- Bead `scientist-workbench-2ivi` / `tools/cone-solve` — the tool-layer
  bead that wires the PSDCone *wire form* (`expression "PSDCone"` with
  `size` + `indices`) onto this substrate block; not done here.
