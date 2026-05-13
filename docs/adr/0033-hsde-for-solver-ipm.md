# ADR-0033 — HSDE (Homogeneous Self-Dual Embedding) for `@workbench/solver-ipm`

**Status:** Proposed — 2026-05-12
**Beads:** scientist-workbench-nq9w (Phase 0, this ADR + scaffold).
Sibling phases under bead `qmrv`: drfx (HSDE LP), fcgx (HSDE NT SDP —
the hinf2 fix), y3qd (tool wiring), ki4c (tighten corpus TOL_KKT,
stretch). `qmrv` itself depends on `fcgx`.
**Related:** ADR-0032 (the existing Mehrotra substrate this builds on);
ADR-0015 (determinism tier — `numerical: true` retained); ADR-0030
(cone-solver wire schema, unchanged); CLAUDE.md Rules 1, 2, 8 (fail
loud, all bugs are deep, honest scope — the binding rules for why
we're doing this rather than papering over the symptom).

## Context

`@workbench/solver-ipm`'s SDP IPM reaches 5/6 on the `sdp-sdplib`
corpus bench. Worklog 095 (commit `9172b16`) lifted the grade from
3/6 by adding COPT-aligned termination (6-flag decision tree) and a
verifier-aligned best-iterate snapshot. control2 and control3 now
pass; hinf2 does not.

The hinf2 failure mode is **structural**, not a tuning problem. The
trace from `scripts/sdp-probe.ts` shows:

- `α_P → 0` at iter ~47 (primal step length collapses)
- `μ` frozen at `4.3e-12`
- `primalInf` locked at `3.98e-7` from iter 47 onward
- `|y|_∞ = 567` — small primal infeasibility amplifies into the
  duality gap by weak duality: `cᵀx − bᵀy = ⟨S,X⟩ − yᵀ r_p`, so
  `567 × 2.88e-7 ≈ 1.6e-4` gap is inescapable while r_p clamps to
  ~3e-7.

The verifier requires gap ≤ 1.1e-6, implying r_p ≤ 2e-9 — three
decades past what the boundary-clamped Newton step can deliver. Our
solver cannot reach Mosek-class precision on this geometry no matter
how we tune the existing pieces.

### Why the previous candidate fixes don't work

The prior handoff (`docs/HANDOFF_solver_ipm_qmrv.md`) proposed
**SDP-Ruiz equilibration** as the fix: rebalance the constraint
matrix to reduce `|y|_∞`, thereby shrinking the gap-amplification
factor. A corpus calibration survey at `/tmp/sdp-survey/` showed
this diagnosis was incomplete — `|A_i|_F ≈ 1` for all hinf2
constraints and `|b|_∞ = 1`, so naive row-equilibration is a no-op.
The full SDP-Ruiz with cone-aware similarity transform `X ← D·X·D`
is a more elaborate substitution but addresses the *symptom*
(large `|y|`) without addressing the *cause* (the primal step can't
reach the optimal face without leaving the PSD cone).

The cause is that the iterate `(X, y, S)` must stay strictly inside
`S^n_+ × R^m × S^n_+`. Near the optimum, when the optimal face is at
the cone boundary, `α_P` is the binding constraint — and it
collapses to zero as iterates approach `∂(S^n_+)`. There is no
local fix; the boundary-clamp is invariant under any reformulation
that keeps the iterate space.

### What Mosek does

`~/Dropbox/.../MOSEK-decomp/analysis/VERDICT.md` identifies Mosek's
LP and conic IPM (including the SDP variant we'd need to match for
hinf2) as a direct implementation of **HSDE** — the Homogeneous
Self-Dual Embedding of Andersen-Roos-Terlaky 2003, with Nesterov-
Todd scaling for conic cones and Mehrotra predictor-corrector on
top. The Mosek C API user guide §13.3.1 says verbatim "The
interior-point optimizer is an implementation of the so-called
homogeneous and self-dual algorithm" and cites [ART03]. Probe logs
on `sdo1.cbf` and `lo1.lp` confirm the same iter-log columns
(`PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU`) and the same algorithm
core for LP and SDP. Mosek reaches `pres = 4.4e-13` on hinf2 in 84
iters — no `α_P → 0` stall, no Ruiz equilibration.

### What COPT does (and doesn't)

`~/Dropbox/.../COPT-decomp/analysis/PD_IPM_DEEP.md` is explicit
that COPT's default path is **standard infeasible-start Mehrotra
predictor-corrector** — **not** HSDE. There is no `τ` or `κ` in
COPT's iterate; the third regularizer `δ_g` is a Tikhonov term, not
a homogenization variable. COPT detects infeasibility via a
directional unboundedness test on the affine direction, not via the
HSDE `τ → 0, κ > 0` certificate dichotomy. COPT's HDSDP SDP backend
is a dual-scaling method (Benson-Ye 1999), unrelated to ART03 HSDE.

The handoff's framing that "both Mosek and COPT use HSDE" was
incorrect. COPT remains a valuable Mehrotra / regularization /
step-policy reference (see "What stays" below), but not an HSDE
reference. **Mosek is the only HSDE oracle we have for this port.**

### Why HSDE breaks the stall

The HSDE iterate lives in `K × K* × R^m × R_+ × R_+`, with new
scalar variables `τ` and `κ` carrying the homogenization. The step
constraint becomes `min(α_K, α_{K*}, α_τ, α_κ)`. When the cone
faces tighten near `∂K`, `τ` can *shrink* to absorb the boundary
approach — there is always room in the `(τ, κ)` directions because
the homogeneous problem is constructed to always have a strictly
interior solution (And09 §3: `(x⁰, τ⁰, y⁰, s⁰, κ⁰) = (e, 1, 0, e, 1)`
is interior by construction). No analogue of the `α_P → 0` collapse
exists. Infeasibility is detected via the termination dichotomy:
`τ* > 0, κ* = 0` ⇒ optimal; `τ* = 0, κ* > 0` ⇒ certificate.

### References assembled

All in `docs/refs/`:
- `andersen-2009-homogeneous-self-dual.pdf` — Mosek TR-1-2009; the
  primary implementation reference. 5 pages, dense.
- `andersen-roos-terlaky-2003.pdf` — the canonical ART03 preprint
  (full 46-page version, recovered from optimization-online).
- `domahidi-2013-ecos.pdf` — ECOS conference paper; clearest written
  treatment of HSDE for conic problems.
- `odonoghue-2016-scs.pdf` — SCS; useful for homogenized iterate
  dynamics.
- `goulart-2024-clarabel.pdf` — modern Rust HSDE; self-contained.
- `ye-warmstart-hsde.pdf` — bonus, on HSDE warmstart.

ECOS source cloned at `/tmp/ecos-reference/` for read-only
structural reference (GPL — not copied; only function names,
struct field names, and call sequences inform the port).

## Decision

### Decision 1 — Port HSDE additively, not as a replacement

Three new solver modules land in `packages/solver-ipm/src/solver/`:

- `HsdeLpSolver.ts` (Phase 1, bead `drfx`) — LP iterate
  `(x, y, s, τ, κ)` over `R^n_+`.
- `HsdeNtSdpSolver.ts` (Phase 2, bead `fcgx`) — SDP iterate
  `(X_b, y, S_b, τ, κ)` per block with NT scaling. This is the
  hinf2 fix.
- (optional, Phase 5) HSDE variants for AHO and HKM directions.

The legacy non-HSDE solvers (`Solver.ts`, `NtSdpSolver.ts`,
`AhoSdpSolver.ts`, `SdpSolver.ts`) **stay**. They remain valuable
as A/B references for the trace-diff harness and as fallback paths
behind a `--method=` selector. The new solvers are additive, not
replacements.

This decision is binding under CLAUDE.md Rule 8 (honest scope): the
A/B path is the only honest way to verify the HSDE port produces
correct trajectories — a single-implementation cutover would deny
us the iter-by-iter comparison that turned worklog 095 from a
multi-day investigation into a 5-minute diagnosis.

### Decision 2 — Follow Andersen 2009 / Mosek sign conventions

The HSDE block, with our chosen signs, is **eq. 13.8 of capi.pdf
verbatim**:

```
        Ax  − bτ     =  0                (primal feasibility)
    Aᵀy + s − cτ     =  0                (dual feasibility)
    −cᵀx + bᵀy − κ  =  0                (gap feasibility)
             xᵀs    +  τκ  =  0          (homogenized complementarity)
                 x   ∈  K
                 s   ∈  K*
             τ, κ    ≥  0
```

Three residuals (Mosek log columns):

```
r_p = Ax − bτ                            (PFEAS = ‖r_p‖_∞)
r_d = Aᵀy + s − cτ                       (DFEAS = ‖r_d‖_∞)
r_g = −cᵀx + bᵀy − κ                     (GFEAS = |r_g|)
```

Complementarity measure: `μ = (xᵀs + τκ) / (n+1)`.
Note the `n+1` denominator — `n` cone slots plus 1 τκ slot. This
differs from our existing non-HSDE solvers which divide by `n`.

**ECOS uses an opposite sign convention** on `bᵀy` (their dual is
`max −bᵀy − hᵀz` whereas And09/Mosek is `max bᵀy`). We follow
And09/Mosek throughout — ECOS code is read for structure, not
algebra. Code comments cite And09 equation numbers at the call
sites where signs are non-obvious.

### Decision 3 — KKT structure follows ECOS: two-RHS pattern, scalar τ-κ update

The 5×5 HSDE augmented Newton matrix is **not** assembled
explicitly. Following ECOS, we factor the standard primal-dual KKT
once per iter:

- For LP: `M = A · diag(x/s) · A^T` (the same Schur our existing
  LP solver uses).
- For SDP: `M_ik = Σ_b <A_i^b, W^b A_k^b W^b>` (the same NT Schur
  our existing `NtSdpSolver` uses, via `buildNtFactor`).

Then we solve TWO right-hand sides against the same Cholesky
factor:

- `RHS1 = [−c; b; h]` — the **data direction**, depends only on
  problem data. Set once at solver entry, never recomputed.
  Produces `(dx1, dy1, dz1) = Δξ₁`.
- `RHS2` — the **iterate direction**, overwritten each iter
  (twice: once for affine RHS, once for combined RHS). Produces
  `(dx2, dy2, dz2) = Δξ₂`.

`τ, κ` updates are computed as scalars OUTSIDE the linear system,
via ECOS's formulas:

```
dtau_denom = κ/τ − (cᵀ·dx1 + bᵀ·dy1 + hᵀ·dz1)        (computed once per iter)
dtauaff    = (rt − κ + cᵀ·dx2 + bᵀ·dy2 + hᵀ·dz2) / dtau_denom
dkapaff    = −κ − (κ/τ)·dtauaff
bkap       = κτ + dkapaff·dtauaff − σμ
dtau       = ((1−σ)rt − bkap/τ + cᵀ·dx2 + bᵀ·dy2 + hᵀ·dz2) / dtau_denom
dkap       = −(bkap + κ·dtau) / τ
```

Full combined direction: `dx = dx2 + dtau·dx1`, similarly `dy`,
`dz`. This is the central architectural insight of HSDE-via-ECOS:
the τ-κ block adds two scalar back-substitutions per iter, and
reuses our existing Schur infrastructure entirely.

### Decision 4 — Mehrotra σ formula stays `(μ_aff/μ)³`, clipped to `[1e-8, 0.9]`

ECOS uses `σ = (1 − step_aff)³` (a simpler heuristic that avoids
computing μ_aff). Mosek and COPT use `(μ_aff/μ)³`. Our existing LP
and NT SDP solvers use `(μ_aff/μ)³`. We keep the existing formula
for consistency with the legacy A/B path and because Mosek is our
oracle. The clip range `[1e-8, 0.9]` follows COPT (CLEANROOM_SPEC
§2 step 5; verified verbatim in our `Solver.ts`).

### Decision 5 — Initial point: keep our existing heuristic, add τ⁰ = κ⁰ = 1

Our current `initialScale` (`NtSdpSolver.ts`) computes:

```
ξ_p = max(1, 10·‖b‖_∞)
ξ_d = max(1, 10·‖C‖_F + ‖b‖_∞)
X⁰ = ξ_p · I_K,  S⁰ = ξ_d · I_K,  y⁰ = 0
```

This matches CLEANROOM_SPEC.md §3.1 and is reasonable for cold-
start. For HSDE we add `τ⁰ = 1, κ⁰ = 1` (And09 §3 Step 1 only
requires positivity; this is the symmetric centered choice). ECOS's
alternative "two-solve refinement" of x⁰ via least-squares
projection is not adopted in Phase 1 — kept as a v2 option if
iteration counts climb on individual cases.

### Decision 6 — Termination: ART03 ρ-dichotomy with PRSTATUS, replacing COPT 6-flag tree

The current `NtSdpSolver` uses the COPT 6-flag decision tree (per
worklog 095). The HSDE solver replaces this with the ART03 / Mosek
termination predicates (capi.pdf §13.3.2):

```
ρ_p^k = ‖Ax^k/τ^k − b‖_∞ / (ε_p · (1 + ‖b‖_∞))
ρ_d^k = ‖Aᵀy^k/τ^k + s^k/τ^k − c‖_∞ / (ε_d · (1 + ‖c‖_∞))
ρ_g^k = min((x^k)ᵀs^k/(τ^k)², |cᵀx^k/τ^k − bᵀy^k/τ^k|)
          / (ε_g · max(1, min(|cᵀx^k|, |bᵀy^k|)/τ^k))
PRSTATUS^k = (bᵀy^k − cᵀx^k) / max(‖b‖_∞, ‖c‖_∞, 1)
```

Decision tree:

| Condition | Status |
|---|---|
| `τ + κ ≥ TAU_KAPPA_FLOOR` AND `max(ρ_p, ρ_d, ρ_g) ≤ 1` AND `PRSTATUS > 0.5` | OPTIMAL — return `(x*, y*, s*)/τ*` |
| `τ + κ ≥ TAU_KAPPA_FLOOR` AND `PRSTATUS < −0.5` AND `bᵀy > WITNESS_FLOOR` AND `‖r_d‖ ≤ ε_inf · (1 + bᵀy)` | PRIMAL-INFEASIBLE — Farkas y certificate |
| `τ + κ ≥ TAU_KAPPA_FLOOR` AND `PRSTATUS < −0.5` AND `cᵀx < −WITNESS_FLOOR` AND `‖r_p‖ ≤ ε_inf · (1 + |cᵀx|)` | DUAL-INFEASIBLE — primal recession ray |
| `τ + κ < TAU_KAPPA_FLOOR` | RUNNING (homogenization collapsed; let outer loop fall through) |
| `iter ≥ iterLimit` | ITER-LIMIT — return best snapshot with fallback status |
| `μ stalled` | NUMERICAL-DIFFICULTY — return best snapshot with fallback status |

Constants (default: `TAU_KAPPA_FLOOR = 1e-8`, `WITNESS_FLOOR = 1e-6`,
`ε_inf = max(ε_p, 1e-8)`).

**Important departure from an earlier draft of this ADR.** A prior
version gated *both* the OPTIMAL and the INFEASIBLE classifications on
`max(ρ_p, ρ_d, ρ_g) ≤ 1`. That gate looked symmetric — but the ρ
metrics are *purified* (each divides by τ), so on an iterate heading
to the τ→0 limit (which is exactly the infeasibility-certificate
regime), the ρ metrics inflate and the gate never trips. The
implementation followed the ADR faithfully, and the consequence was
bead `io2v`: the four explicitly-infeasible SDPLIB cases (infp1/infp2/
infd1/infd2) returned wire `status=optimal` with `achieved_precision`
in the 1e+1 to 1e+5 range, because the cert tests never fired and
soft-success best-iterate took over.

The fix is to split the two classifications:
  - OPTIMAL uses *purified* ρ-metrics (correct shape — we hand back the
    purified iterate, so feasibility/optimality tolerances are
    naturally `residual / τ`).
  - INFEASIBILITY certificates use *unpurified* residual+witness tests
    (correct shape — the Farkas certificate IS the unpurified iterate
    at τ→0, and dividing by τ is a category error there). The witness
    floor on |bᵀy| / |cᵀx| guards against the degenerate "everything
    collapses to zero" iterate that satisfies the inequalities
    vacuously; `PRSTATUS < −0.5` guards against an almost-converged
    optimal problem with `|bᵀy| ≫ ‖c‖_F` spuriously firing the
    primal-infeas cert.

This mirrors Mosek `hom_terminatelo` (decomp `003f8460`) — gate to
classification on `pfeasinff < tolP OR dfeasinff ≤ tolD` (NOT a
conjunction with ρ), then independent witness-ratio tests. SCS
`solver.c::solve` has the same structural shape. The original ADR
draft inadvertently copied the "ρ-test as universal gate" shorthand
from the ART03 *optimal-case* analysis and applied it to
infeasibility — which the ART03 paper itself does not.

The 6-flag tree machinery in the legacy NT solver is **not
ported** to HSDE — different termination semantics; the HSDE
exit codes map directly to our wire taxonomy without going
through the soft-success bucket. (See Decision 7 for the related
fix to NT-path best-iterate gating.)

### Decision 7 — Best-iterate snapshot on UNPURIFIED iterate (hazard §3.3)

The current NT solver snapshots when the verifier-aligned achieved
metric improves. For HSDE we snapshot the iterate `(x*, y*, s*, τ*,
κ*)` directly — UNPURIFIED. Division by `τ*` happens only at the
moment we return to the caller. Saving a purified iterate and then
re-purifying double-divides; symptom is the returned objective off
by `1/τ²`.

**Bead `io2v` follow-up — `bestStatus` stamping.** The HSDE solver
does *not* stamp the snapshot with `bestStatus = "dual-feasible"`.
That stamp is reserved for the legacy NT path's 6-flag soft-success
bucket (worklog 095, control2/control3/hinf2). HSDE has a comprehensive
classification: optimal + primal-infeasible + dual-infeasible via the
τ-κ tests in Decision 6. Any iter that the test doesn't positively
classify falls through to the fallback status (iter-limit / numerical-
difficulty / numerical-error) — `finalizeBestOr` still returns the
best snapshot (always at least as good as the current iterate, which
may have just blown up), but with the honest fallback status, never
`dual-feasible`. Pre-fix the stamp was unconditional and the wire map
`dual-feasible → optimal` turned every snapshot — including iter-0
snapshots on infeasible inputs — into wire `optimal`.

The same fix applies to the legacy `NtSdpSolver.ts`: stamp
`bestStatus = "dual-feasible"` only when `couldDualFeas` is honestly
true (the iterate meets at least `abs_gap` OR `rel_dual_feas` OR
`abs_dual_feas`). The control2/control3/hinf2 motivation for the soft
bucket is preserved (those cases DO hit `couldDualFeas` along their
trajectory); infeasible inputs (infp/infd) never hit it, so the snapshot
is returned with the fallback status (typically `numerical-error` —
NT can't tell infeasibility from "S leaves the cone after 2 iters").

### Decision 8 — Verbose trace schema extension

`VerboseIterLine` in `Solver.ts` gains the HSDE scalar fields:

```typescript
tau: number;       // homogenization scalar (NaN for non-HSDE kinds)
kappa: number;     // homogenization slack (NaN for non-HSDE kinds)
gfeas: number;     // |r_g| (NaN for non-HSDE kinds)
prstatus: number;  // (bᵀy − cᵀx) / max(‖b‖, ‖c‖, 1) (NaN for non-HSDE)
```

Phase 5 Tier 0 adds ECOS/SDPT3-style iterative-refinement counters:

```typescript
nitref1: number;   // data-direction Schur back-substitution
nitref2: number;   // affine-direction Schur back-substitution
nitref3: number;   // combined-direction Schur back-substitution
```

The counters are `0` for HSDE traces until Tier 1 wires the IR helper,
and `NaN` for non-HSDE traces. They exist before the algorithm change
so the diagnostic pipeline can prove where refinement fires.

The `kind` discriminator extends:

```typescript
kind:
  | "lp" | "sdp-nt" | "sdp-aho" | "sdp-hkm"
  | "lp-hsde" | "sdp-hsde-nt"
  | "mosek";
```

JSONL stability: NaN-for-inapplicable is preserved (JSON
serialises as `null`). The diff harness `scripts/trace-diff.ts`
treats `null` as "missing" and already handles arbitrary fields —
no harness changes needed. `scripts/copt-log-to-jsonl.ts` (LP
COPT logs) leaves these fields `null` since COPT is not HSDE.
`scripts/mosek-log-to-jsonl.ts` parses Mosek's
`ITE PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU TIME` table into the
same schema, populating `kind: "mosek"`, `gfeas`, and `prstatus`
directly while leaving TS-internal fields `null`.

### Decision 9 — Determinism tier unchanged: `numerical: true` (ADR-0015)

HSDE remains float64 throughout. Bit-identical given the platform
fingerprint, like the existing solver. No bigfloat substrate is
added; bigfloat HSDE would be a separate ADR.

## Consequences

### What stays (from the existing solver)

These reuse byte-identically:

1. **Mehrotra predictor-corrector structure** — predictor (σ=0)
   followed by corrector with `σ = (μ_aff/μ)³`. The two-solve-per-
   iter pattern is the same as today's LP/SDP solvers; HSDE
   merely adds the τ-κ scalar update afterward.
2. **NT scaling for SDP** — `buildNtFactor` is unchanged. The
   `(L, invL, V, sv, G, W)` factor reused exactly. The SDPT3
   identity `hdX_aff = diag(−sv) − hdZ_aff` still applies for the
   corrector's `Rq` term.
3. **Schur assembly** — `M = A·diag(x/s)·A^T` (LP) and
   `M_ik = Σ_b <A_i, W·A_k·W>` (SDP NT) unchanged.
4. **3-way Tikhonov regularization** — `factorWith3Way` and
   `RegState` plumbing preserved. δ_p (cap 1e-2, bump ×10), δ_d
   and δ_g (cap 1e+2, bump ×100), initial 1e-12. The LP path
   already uses this; the SDP path moves through it in Phase 2
   (legacy single-tier gap escalation drops).
5. **Verbose trace pipeline** — `VerboseIterLine`,
   `formatVerboseLine`, `IPM_TRACE_JSONL` env var, and the four
   diagnostic scripts (`sdp-probe`, `trace-diff`,
   `copt-log-to-jsonl`, `solver-ipm-bench`) all preserved. Only
   the schema extends additively (Decision 8).
6. **Best-iterate snapshot + `finalizeBestOr` pattern** — the
   structure is the same; the iterate stored is now unpurified
   (Decision 7).
7. **Step length safeguard** `α = max(0.95·α_max, 2α_max − 1)`,
   cap 0.999999 — verbatim from CLEANROOM_SPEC §8 ("Do not change
   these constants"). HSDE extends the per-cone step to include
   `α_τ, α_κ`; the safeguard formula applies to the full minimum.
8. **Initial scaling** `ξ_p, ξ_d` formulas in `initialScale`
   (Decision 5).
9. **Stall detection** — `μᵏ > 0.99·μᵏ⁻¹` increments stallCount;
   `stallIterCap = 10` triggers `numerical-difficulty`. The HSDE
   variant uses `μᵏ + τᵏκᵏ` (the homogenized measure).
10. **Status mapping** in `Status.ts` — `dual-feasible → optimal`
    (worklog 095) preserved. HSDE adds `infeasibility-certificate
    → optimal` mapping with the achieved-precision honest channel
    carrying the certificate norms.

### What changes

These are HSDE-specific:

1. **Iterate carries τ, κ scalars.** New types: `HsdeIterate`,
   `HsdeResiduals`, `HsdeStatus` in `HsdeIterate.ts` (Phase 0).
2. **Residuals include r_g = −cᵀx + bᵀy − κ.** PFEAS/DFEAS now
   computed against `bτ, cτ`, not raw `b, c`.
3. **μ denominator is n+1.** All non-HSDE solvers stay at `n`.
4. **Termination is ART03 ρ-dichotomy with PRSTATUS** (Decision 6),
   not COPT 6-flag tree.
5. **KKT solve uses two RHS** (Decision 3): `RHS1` data direction
   plus `RHS2` iterate direction, combined via scalar `dtau_denom`
   formula. The Schur factor is shared between the three solves
   (data, affine, combined).
6. **Step length includes α_τ, α_κ.** `HsdeStepLength.ts` (Phase 0)
   wraps the existing `minBlockStep` (for the cone part) plus the
   τ-κ ratio test.
7. **Purification on return.** Caller-facing solution is
   `(x*/τ*, y*/τ*, s*/τ*)`. The internal iterate stays
   unpurified throughout the loop.
8. **`maxStepToBoundary` is extended for τ, κ.** The new
   `hsdeMaxStep(it, dx)` in `HsdeStepLength.ts` returns
   `min(minBlockStep(X, dX, blocks), τ-step, κ-step)`.

### Migration plan (the order matters)

**Phase 0 (this bead, `nq9w`).** ADR + types-only scaffold. No
algorithm. Acceptance: `bun run check` green; additive only.

**Phase 1 (`drfx`).** HSDE LP first. LP has no NT scaling — fewer
moving parts to debug, and the same Mosek iter-log columns
(`probe_lo1.log` confirmed the LP/SDP share a single HSDE core).
We get the residual computation, termination test, τ-κ update,
verbose trace columns, and unpurified-iterate snapshot working
on the simpler cone first. Acceptance: AFIRO from `lp-netlib`
converges; brandy resolved or returns clean tagged refusal; 68/68
existing LP tests pass.

**Phase 2 (`fcgx`).** HSDE SDP NT — the hinf2 fix. Drops the new
algorithm into the existing NT factor / Schur machinery. The
trace-diff against Mosek on sdo1.cbf becomes the per-iter
acceptance check. Acceptance: `sdp-sdplib` 6/6; hinf2 pres < 1e-9;
68/68 existing solver-ipm tests pass.

**Phase 3 (`y3qd`).** Tool wiring. `tools/sdp-solve` and
`tools/lp-solve` get `--method=` flags; default to HSDE. Backward
compat preserved via `--method=nt` / `--method=ipm`.

**Phase 4 (`ki4c`, stretch).** Tighten corpus `TOL_KKT` from the
loosened 095-era values back toward 1e-7. Verify 6/6 holds at the
tightened gate. Survey wider SDPLIB set.

### Hazards explicitly called out

Mistakes that look right but aren't (mirrored from HANDOFF §3):

1. **Step length must include α_τ, α_κ.** Forgetting either
   produces NaN propagation. The `HsdeStepLength.ts` types
   enforce this — the function takes both the cone-direction
   pair and the (τ, dτ, κ, dκ) scalars; it cannot be called with
   only the cone half.
2. **PFEAS/DFEAS denominators in the convergence check use the
   *original* ‖b‖, ‖c‖ — not ‖bτ‖, ‖cτ‖.** The log column shows
   raw `‖Ax − bτ‖_∞`; the termination check divides by τ then
   normalizes by `(1 + ‖b‖)`.
3. **Snapshot the unpurified iterate** (Decision 7).
4. **Cholesky on the augmented matrix fails.** Only the Schur
   complement is PSD; the 5×5 augmented matrix is symmetric
   indefinite. We factor the Schur, not the augmented.
5. **Pick And09/Mosek conventions; ECOS read for structure only**
   (Decision 2). Sign of `bᵀy` in `r_g` is the most likely place
   to slip.
6. **Cone constraint is `(x, τ) ∈ K × R_+`, not `x ∈ K`.** The
   reason HSDE works. Code comments cite this explicitly at the
   step-length call sites.

## Acceptance for Phase 0

- ADR-0033 lands at `docs/adr/0033-hsde-for-solver-ipm.md`. ✓ this file.
- `packages/solver-ipm/src/solver/HsdeIterate.ts` exports
  `HsdeIterate`, `HsdeResiduals`, `HsdeStatus` — pure types.
- `packages/solver-ipm/src/solver/HsdeStepLength.ts` exports
  `hsdeMaxStep(X, dX, S, dS, blocks, tau, dtau, kappa, dkappa) → number`
  for SDP and `hsdeLpMaxStep(x, dx, s, ds, tau, dtau, kappa, dkappa) → number`
  for LP, reusing `minBlockStep` from `NtSdpSolver.ts` for the
  SDP cone part.
- `bun run check` green.
- No behaviour change in existing solvers (purely additive).

## Pointers

- Worklog 095 (`docs/worklog/095-solver-ipm-verbose-trace-and-termination.md`)
  — the 3/6 → 5/6 work that surfaced the structural HSDE need.
- Handoff (`docs/HANDOFF_solver_ipm_hsde.md`) — the 8-10 hour
  ground-truth reading playbook this ADR distils.
- Mosek verdict (`~/Dropbox/.../MOSEK-decomp/analysis/VERDICT.md`)
  — algorithm identification with binary-string evidence.
- COPT deep architecture
  (`~/Dropbox/.../COPT-decomp/analysis/PD_IPM_DEEP.md`) — confirms
  COPT does NOT use HSDE; clarifies what COPT does contribute
  (Mehrotra + 3-way reg + step policy).
- ECOS source (`/tmp/ecos-reference/src/ecos.c`) — structural
  reference for the two-RHS / scalar τ-κ pattern. GPL; read-only.
- Calibration table (`/tmp/sdp-survey/calibration-table.md`) —
  50-problem Mosek/COPT/SCS baseline showing the precision floor
  Mosek achieves and we'd reach via HSDE.
- Existing solvers (`packages/solver-ipm/src/solver/{Solver,
  NtSdpSolver,AhoSdpSolver,SdpSolver}.ts`) — stay as A/B
  references behind `--method=`.
- Papers (`docs/refs/`) — six PDFs, ~180 pages, downloaded.

## Open questions

- **Mosek log → JSONL parser** (Phase 2 prereq). The `mosek` binary
  emits the iter log to stdout; a small parser transforming that
  into `VerboseIterLine` with HSDE fields populated lets
  `trace-diff.ts` work iter-by-iter against Mosek. Out of scope for
  Phase 0.
- **Bigfloat HSDE.** The `bigfloat` package would let us push pres
  below `1e-13` on degenerate problems. Separate ADR if/when the
  float64 HSDE port lands and shows precision-floor cases.
- **HSDE for AHO/HKM** (Phase 5, optional). Low priority — these
  directions stay as A/B references. Lift only if the bench needs
  them.
