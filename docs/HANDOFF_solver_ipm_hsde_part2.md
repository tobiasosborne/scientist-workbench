# Handoff — HSDE port: phase 2 done, precision floor on hinf2

> **SUPERSEDED — 2026-05-16 (worklogs 106 + 110 + 128 + 129).** HSDE
> Phase 5 has fully landed across four tiers:
>
> - Tier 0 (`fuur`, worklog 106): diagnostic infrastructure + ground-
>   truth ref read. `nitref1/2/3` slots in `VerboseIterLine`;
>   `parseMosekLog` + `parseCoptLog`.
> - Tier 1 (`vajd`, worklog 110): `solveWithIR` core + wiring into
>   `HsdeLpSolver` + `HsdeNtSdpSolver` (3 back-sub sites each). 113 tests
>   green; IR demonstrably broke the unpurified `r_p` floor by 3 decades
>   on hinf2 (`1.26e-7 → 1.77e-10`).
> - Tier 2 (`fsr7`, worklog 128): Mosek 11.1 oracle for the six SDPLIB
>   cases under `docs/oracles/mosek-sdo/`; end-to-end precision tests in
>   `hsde-precision.test.ts`; **verdict — the 2-decade purified-pInf gap
>   from the 1e-9 target on hinf2 + control3 is entirely τ-shrinkage in
>   HSDE's near-optimal dynamics, not back-substitution residual.** No
>   tuning of `LINSYSACC`/`IRERRFACT`/`maxIter` in `solveWithIR` can
>   recover it; **Phase 6 (bigfloat HSDE, separate ADR per ADR-0033
>   Decision 9) is the only path past the float64 floor on those two
>   cases.**
> - Tier 3 (`lniy`, worklog 129): `tools/sdp-solve --method=auto` default
>   switch to `hsde-nt`; HSDE soft-success branch (`μ ≤ feasTol AND
>   prstatus > 0.5 AND τ ≥ 1e-6` → `dual-feasible` → wire `optimal` per
>   `Status.ts`), mirroring legacy NT's `couldDualFeas`. 6 PSD-success
>   goldens regenerated; oracle 14/14. Corpus bench: 5/6 cases, 64/66
>   invariants (up from baseline 5/6, 63/66; `hinf2 optimality_gap`
>   flips to pass).
>
> The 6/6 case-count remains a **Phase 6 gate**. Mosek reaches `PFEAS =
> 2.4e-12` on hinf2 algorithmically; the substrate (sparse-LDL with
> dynamic regularisation in extended precision) is the difference, not
> the algorithm choice. ADR-0033 §"Decision 9 — Tier-2 amendment" and
> §"Decision 9 — Tier-3 amendment" record the per-case verdict and the
> bigfloat path forward.
>
> The §0–§13 below is preserved as historical context (the Phase 5
> playbook that produced the four worklogs above). Read it for the
> "why the τ-κ tracking is load-bearing" reasoning; reach for worklogs
> 106 / 110 / 128 / 129 for the actual implementation history and
> per-tier acceptance evidence.
>
> ---
>
> **Original status (2026-05-12 evening, worklog 096).** Phase 3 tool
> wiring (§6 of this document) has **shipped** in commit `e164046`:
> `tools/sdp-solve --method=hsde-nt` and `tools/lp-solve
> --method=hsde-lp` are agent-callable today. Defaults unchanged
> (per §6's "DO NOT change the default to hsde-nt until Phase 5
> lands"). The remaining gates against `--method=hsde-nt` becoming
> the SDP default + `scripts/sdp-probe.ts --method=hsde-nt` support
> are folded into Phase 5 Tier 3 (bead `lniy`); bead `y3qd` is now
> superseded.
>
> Phase 5 (§§4–5 of this document — iterative refinement) has been
> **decomposed into 5 dependency-chained beads** under parent
> `qmrv`:
> - `fuur` (Tier 0) — ground-truth read + diagnostic infrastructure
>   (nitref1/2/3 fields in VerboseIterLine, mosek-log-to-jsonl
>   parser). **Ready to claim**; everything else blocks on it.
> - `vajd` (Tier 1) — `solveWithIR` helper + HsdeLp/HsdeNtSdp
>   wiring at the 3 back-sub sites.
> - `fsr7` (Tier 2) — `hsde-precision.test.ts` + Mosek-comparison
>   oracle.
> - `lniy` (Tier 3) — corpus 6/6 + `--method=auto` default →
>   `hsde-nt` + `sdp-probe.ts` support.
> - `rqbm` (Tier 4) — worklog 097 + supersession header + catalog
>   refresh; closes `qmrv`.
>
> Read worklog 096's "Part B" section for the decomposition
> rationale; read each bead body for per-tier acceptance.
>
> The rest of this document (§0–§13 below) is the **original
> Phase 5 playbook**, unchanged. It is still the canonical
> reference for *what* IR is and *why* it's needed — the
> decomposition slices it into shippable units but doesn't
> replace its prose.
>
> ---
>
> **Predecessor:** `docs/HANDOFF_solver_ipm_hsde.md` (the playbook
> that got us here). That handoff is *superseded* by this one for
> the *what's next* question, but its §0 (ground-truth reading
> protocol) and §3 (hidden hazards) still apply verbatim.
>
> **You are agent #N+1.** Agent #N (this writer) executed phases
> 0–2 of the HSDE port. The port is **structurally complete and
> correct** — all six `sdp-sdplib` cases return the right
> objectives via HSDE. But hinf2's `pres` floor sits at ~8e-7
> rather than Mosek's 4.4e-13. Closing that gap is the next phase.
> **It is NOT achievable by further tuning of the HSDE iteration
> alone.** A separate intervention (iterative refinement, bigfloat,
> or specialised preconditioning) is required.
>
> This document is the playbook for that intervention.

---

## 0. TL;DR

1. **What is now in the repo (verify with `git log` and `Read`,
   don't trust this summary):** ADR-0033 + `HsdeLpSolver.ts` +
   `HsdeNtSdpSolver.ts` + tests. The HSDE algorithm is
   implemented end-to-end with the Mosek/And09 sign convention,
   the ECOS two-RHS pattern, scalar τ-κ recovery, ART03
   ρ-dichotomy termination, and unpurified-iterate best snapshot.
   Phases 0–2 of `docs/HANDOFF_solver_ipm_hsde.md` are closed.

2. **What still fails:** hinf2 returns
   `status=dual-feasible primalObj=10.967 pInf=8.14e-7 dualInf=5.7e-14
   τ=0.154 κ=6e-11 iter=52`. Objective correct, dual feas excellent,
   but primal feas stuck. The legacy NT solver stalls at `pInf=3.8e-7`
   on the same case for similar reasons — the predecessor handoff
   was *wrong* that "HSDE alone fixes hinf2": the τ-shrinking
   argument works for infeasibility detection, but the binding
   constraint on optimal-but-degenerate cases is float64 conditioning
   of the Schur complement M (cond ~1e+13 in hinf2's late iters).

3. **What's left:**
   - Phase 3: `tools/sdp-solve` `--method=hsde-nt` flag (~30 min).
   - **Phase 5 (renamed from 4 for emphasis): iterative refinement
     on Schur back-substitution.** This is the only intervention
     likely to close hinf2 to Mosek class without changing the
     substrate. ECOS does it; we don't. See §6 below.
   - Phase 6 (optional): bigfloat substrate — separate ADR.
   - Phase 7: tighten corpus `TOL_KKT` once 6/6 lands (stretch).

4. **Critical first action: download + read ground truth.** §1 of
   this document lists the canonical IR references. **Do not write
   a line of IR code before reading them.** Past handoffs have been
   *wrong* (this one and the previous Ruiz handoff). The discipline
   of verifying against primary sources is what prevents writing
   the wrong fix.

5. **Estimated effort:** ~3-5 days for IR if you read first. Closer
   to 1-2 weeks if you don't (you'll write the wrong thing and
   re-do it).

---

## 1. Ground-truth assembly — required reading BEFORE writing code

### 1.1 Local-only resources (already on disk; just read)

| File | What it tells you | Time |
|---|---|---|
| `docs/adr/0033-hsde-for-solver-ipm.md` | The HSDE port's design decisions. **Read end-to-end.** Calls out every sign convention, hazard, and what's intentionally deferred to v2. | 30 min |
| `docs/HANDOFF_solver_ipm_hsde.md` | The predecessor handoff (Phase 0–2 playbook). §3 hidden hazards still apply. | 20 min |
| `docs/worklog/095-solver-ipm-verbose-trace-and-termination.md` | Why we got 5/6 before HSDE. The `|y|_∞ = 567` analysis on hinf2 is load-bearing for understanding why pInf floors at 8e-7. | 20 min |
| `packages/solver-ipm/src/solver/HsdeLpSolver.ts` | The LP HSDE solver. The derivation comments at the top are gold — they cite And09 step numbers and explain the Mosek-vs-ECOS sign convention departure. | 60 min |
| `packages/solver-ipm/src/solver/HsdeNtSdpSolver.ts` | The SDP NT HSDE solver. SDP analog of the LP path, with NT scaling and per-block Schur. | 60 min |
| `packages/solver-ipm/src/solver/HsdeStepLength.ts` | The τ-κ step-to-boundary helpers. Small, but the call-site comments matter. | 10 min |
| `packages/solver-ipm/src/solver/HsdeIterate.ts` | The HSDE iterate types. Trivial but read for the contract surface. | 10 min |
| `packages/solver-ipm/test/hsde-*.test.ts` | The 12 HSDE tests. Especially `hsde-sdp.test.ts` for the SDP fixture shapes. | 20 min |
| `packages/solver-ipm/src/solver/NtSdpSolver.ts` | The legacy (non-HSDE) NT SDP solver. Kept as A/B reference. The `buildNtFactor` + `minBlockStep` here are **duplicated** in `HsdeNtSdpSolver.ts` (deliberately; a tidy-up bead can extract them later). | 30 min |
| `packages/solver-ipm/src/solver/Regularization.ts` | The 3-way Tikhonov regulariser. `factorWith3Way`, `makeLpDiagnose`, `makeSdpDiagnose`. The HSDE path uses this unchanged. | 20 min |

### 1.2 Local diagnostic captures (look at them, don't run yet)

```sh
# Run this to see hinf2's trajectory under HSDE NT — the precision
# floor evidence. `pInf` is locked at 1.26e-7 from ~iter 36 onward
# while α=0 most iters. The `Mdiag=[4.8e+7, 1.0e+13]` line shows the
# Schur condition number that's hitting float64 noise.
cat > /tmp/hsde-hinf2-trace.ts <<'EOF'
import { readFileSync } from "node:fs";
import { solveHsdeSdpNt, parseSdpaSparse, convertSdpaToSdp, formatVerboseLine }
  from "/home/tobias/Projects/scientist-workbench/packages/solver-ipm/src/index.js";
const sparse = parseSdpaSparse(readFileSync(
  "/home/tobias/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s", "utf-8"));
const prob = convertSdpaToSdp(sparse);
solveHsdeSdpNt(prob, {
  params: { iterLimit: 60, feasTol: 1e-9, optTol: 1e-9 },
  verbose: (l) => console.error(formatVerboseLine(l)),
});
EOF
bun /tmp/hsde-hinf2-trace.ts 2>&1
```

Look for the pattern: `pInf=1.26e-7 α=(0.000,0.000) Mdiag=[1e+8, 1e+13] reg=(0,0,1e-2)` from iter ~36 onward. That's the precision floor.

### 1.3 External papers — VERIFY they exist locally and READ them

The predecessor agent downloaded six papers into `docs/refs/`.
**Verify they're still there before proceeding:**

```sh
ls -la /home/tobias/Projects/scientist-workbench/docs/refs/
# Expected:
#   andersen-2009-homogeneous-self-dual.pdf          (5pp; Mosek TR-1-2009)
#   andersen-roos-terlaky-2003.pdf                   (46pp; the FULL ART03)
#   domahidi-2013-ecos.pdf                           (6pp; ECOS paper)
#   goulart-2024-clarabel.pdf                        (48pp; Clarabel)
#   odonoghue-2016-scs.pdf                           (27pp; SCS)
#   ye-warmstart-hsde.pdf                            (23pp; bonus)
```

If any are missing, re-download via the URLs in `docs/HANDOFF_solver_ipm_hsde.md` §0.2.

**Verify ECOS source is at `/tmp/ecos-reference/`:**

```sh
ls /tmp/ecos-reference/src/ | head
# Expected: ecos.c, kkt.c, preproc.c, cone.c, ...
```

If missing:
```sh
cd /tmp && git clone --depth 1 https://github.com/embotech/ecos.git ecos-reference
```

### 1.4 New external papers — download for this phase

The precision-floor fix needs references the predecessor didn't read.
**Download these to `docs/refs/`:**

```sh
mkdir -p /home/tobias/Projects/scientist-workbench/docs/refs/
cd /home/tobias/Projects/scientist-workbench/docs/refs/

# Higham 2002 — "Accuracy and Stability of Numerical Algorithms",
# Chapter 12 on Iterative Refinement. THE canonical reference for IR.
# Free PDF from author's page:
curl -fLO --max-time 60 -A "Mozilla/5.0" \
  https://nhigham.com/wp-content/uploads/2021/03/higham-asna-2e-2002.pdf \
  || echo "NOTE: book is not always freely available; if 404, search 'Higham ASNA Chapter 12 PDF'"

# SDPT3 v4 paper (Tütüncü, Toh, Todd 2003) — the canonical NT-SDP
# implementation that ALSO does IR on the Schur back-sub. THE most
# directly applicable reference for our case.
curl -fLO --max-time 60 -A "Mozilla/5.0" \
  https://www.math.cmu.edu/~reha/Pss/sdpt3.pdf \
  || curl -fLO --max-time 60 -A "Mozilla/5.0" \
       https://link.springer.com/content/pdf/10.1007/s10107-002-0347-5.pdf
mv sdpt3.pdf tutuncu-2003-sdpt3.pdf 2>/dev/null || true

# Mehrotra-Saigal 1996 — "Computational experience with a modified
# potential reduction algorithm for linear programming" — has the
# best-documented iterative refinement loop in the LP IPM literature.
# (Optional if Higham + SDPT3 are enough.)

# Lehoucq & Sorensen 1996 — "Deflation Techniques for an
# Implicitly Re-Started Arnoldi Iteration" — overkill but the
# perturbation analysis of M is good background.
```

After download, verify each file:
```sh
file docs/refs/*.pdf  # all should say "PDF document"
pdfinfo docs/refs/tutuncu-2003-sdpt3.pdf | head -5  # check Pages count > 0
```

If a URL is dead, **find the canonical title and grab the current
location via Google Scholar or Semantic Scholar.** Do NOT proceed
without the SDPT3 paper specifically — it's the most directly
applicable reference.

### 1.5 ECOS source — re-read these files specifically

You read structural patterns last phase. Now read **specifically
the iterative refinement loop**:

```
/tmp/ecos-reference/src/kkt.c:113-232    (kkt_solve with IR)
```

The relevant pattern (already digested in the predecessor's notes;
verify by re-reading the actual source):
- After initial LDL solve, compute residual `e = b - K·dx`.
- If `‖e‖ > LINSYSACC · ‖b‖`, solve `K·dx' = e`, set `dx ← dx + dx'`.
- Repeat up to `NITREF=9` times.
- Early-terminate if error doesn't shrink by factor `IRERRFACT=6`
  (stagnation detection).
- Undo the refinement step if it made things worse.

The stagnation cutoff and undo are non-obvious — they prevent IR
from diverging on hopeless cases.

---

## 2. Reading checkpoints — verify your understanding before code

Same self-test discipline as last phase. Before writing IR code,
answer no-peeking:

1. **What is the Schur-system residual in our HSDE NT SDP path?**
   *(Expected: after solving `M·dy = rhs` via `choleskySolveInPlace(Lchol, m, dy)`,
   the residual is `e = rhs - M·dy`. M is the assembled normal-
   equations matrix `M_ik = Σ_b <A_i^b, W^b A_k^b W^b>` plus the
   3-way Tikhonov lift. The IR step is `solve(M·dy' = e), dy ← dy + dy'`.)*

2. **Why does the 3-way Tikhonov regularisation not eliminate the
   need for IR?**
   *(Expected: regularisation perturbs M to make it factorable. IR
   compensates for the perturbation by computing the residual with
   the *unperturbed* M. The two are complementary — regularisation
   keeps the factor stable; IR keeps the solution accurate.)*

3. **What invariant must IR preserve in our setting?**
   *(Expected: after IR, the data direction `(dx1, dy1, ds1)` must
   still satisfy `M·dy1 = b + <A_i, W·C·W>` to high precision —
   not just the perturbed `(M + δI)·dy1 = ...`. Same for the
   iterate direction `(dx2, dy2, ds2)`. This is the **whole point**
   of IR.)*

4. **How many IR steps should we do per back-substitution?**
   *(Expected: ECOS does up to 9, with stagnation cutoff at factor 6.
   For our hinf2 case with cond ~1e+13, 5–9 steps is the right
   ballpark. The exact number is a tuning parameter.)*

5. **Does IR need to be applied to the τ-κ scalar update too?**
   *(Expected: no — the τ-κ formulas are exact scalar arithmetic on
   small quantities. The precision floor is purely in the Schur
   back-substitution. The dx1, dy1, ds1, dx2, dy2, ds2 vectors are
   what need IR.)*

6. **Will IR converge our hinf2 to Mosek's 4.4e-13?**
   *(Expected: probably to 1e-10 to 1e-12, possibly 1e-13. Mosek's
   numbers also use sparse-LDL + IR, plus likely some dynamic
   regularisation we don't have. We won't necessarily MATCH Mosek
   but should comfortably beat the 1e-7 floor.)*

If any of these are unclear, **re-read the SDPT3 paper §IR section
and ECOS `kkt.c` lines 113–232 before writing code.**

---

## 3. What's done — concrete artefacts in this repo

Verify each of these exists with `Read` or `ls` before relying on it.

### 3.1 New files (created this phase)

```
docs/adr/0033-hsde-for-solver-ipm.md                    (the ADR — 9 decisions, hazards, migration plan)
docs/HANDOFF_solver_ipm_hsde_part2.md                   (this file)
docs/refs/andersen-2009-homogeneous-self-dual.pdf       (Mosek TR-1-2009)
docs/refs/andersen-roos-terlaky-2003.pdf                (full ART03; 46 pages)
docs/refs/domahidi-2013-ecos.pdf                        (ECOS paper)
docs/refs/odonoghue-2016-scs.pdf                        (SCS)
docs/refs/goulart-2024-clarabel.pdf                     (Clarabel)
docs/refs/ye-warmstart-hsde.pdf                         (bonus)
packages/solver-ipm/src/solver/HsdeIterate.ts           (types: HsdeResiduals, HsdeStatus, HsdeLpIterate, HsdeSdpIterate)
packages/solver-ipm/src/solver/HsdeStepLength.ts        (tauKappaMaxStep, hsdeLpMaxStep, hsdeSdpMaxStep)
packages/solver-ipm/src/solver/HsdeLpSolver.ts          (~900 LOC; solveHsdeLp + HsdeLpSolveResult)
packages/solver-ipm/src/solver/HsdeNtSdpSolver.ts       (~1100 LOC; solveHsdeSdpNt + HsdeSdpSolveResult)
packages/solver-ipm/test/hsde-lp.test.ts                (6 tests)
packages/solver-ipm/test/hsde-lp-afiro.test.ts          (1 test)
packages/solver-ipm/test/hsde-lp-brandy.test.ts         (1 test)
packages/solver-ipm/test/hsde-sdp.test.ts               (4 tests)
```

### 3.2 Modified files

```
packages/solver-ipm/src/solver/Solver.ts                (extended VerboseIterLine with tau/kappa/gfeas/prstatus + lp-hsde/sdp-hsde-nt kinds)
packages/solver-ipm/src/solver/NtSdpSolver.ts           (NaN-filled the new HSDE fields in its verbose emission)
packages/solver-ipm/src/solver/AhoSdpSolver.ts          (same; trivial)
packages/solver-ipm/src/solver/SdpSolver.ts             (same; trivial)
packages/solver-ipm/src/solver/LogFormat.ts             (formatVerboseLine renders the new fields when kind is HSDE)
packages/solver-ipm/src/index.ts                        (exports the new HSDE surfaces)
scripts/copt-log-to-jsonl.ts                            (CoptIterLine extended with nullable HSDE fields for trace-diff alignment)
tools/sdp-solve/tool.ts                                 (fixed pre-existing typecheck error: pickSolver wrapper type widened to include verbose?: ...)
```

### 3.3 Untouched (still legacy)

```
packages/solver-ipm/src/solver/{Solver,NtSdpSolver,AhoSdpSolver,SdpSolver}.ts
                                                        (algorithm code untouched; only the verbose emission was extended additively)
tools/sdp-solve/tool.ts                                 (still dispatches to legacy solvers; --method=hsde-nt NOT wired yet)
tools/lp-solve/tool.ts                                  (same)
scripts/sdp-probe.ts                                    (does NOT support hsde-nt method yet)
```

### 3.4 Current test state (verify before starting work)

```sh
cd /home/tobias/Projects/scientist-workbench
export PATH=$HOME/.bun/bin:$PATH
bun test packages/solver-ipm/      # Expected: 80/80 pass
bunx tsc --noEmit                  # Expected: exit 0
```

If either fails, agent #N+1 should investigate before doing
ANYTHING else — something has regressed since this handoff was
written.

### 3.5 Beads state

```sh
bd show qmrv         # The parent bug (HSDE direction)
bd show nq9w drfx fcgx y3qd ki4c   # The 5 sub-beads
```

Expected:
- qmrv: still open (depends on fcgx — wait, fcgx is CLOSED but the
  acceptance criterion was "6/6 sdp-sdplib at corpus default tol"
  which we did NOT achieve. **`qmrv` itself should remain OPEN.**
  Re-evaluate after IR lands.)
- nq9w (Phase 0 ADR+scaffold): closed
- drfx (Phase 1 HSDE LP): closed
- fcgx (Phase 2 HSDE SDP NT): closed with honest-scope notes
- y3qd (Phase 3 tool wiring): open
- ki4c (Phase 4 tighten TOL_KKT — stretch): open

**You should file NEW beads for Phase 5+:**

```sh
bd create --title="HSDE Phase 5: iterative refinement on Schur back-sub" --type=feature --priority=1
bd create --title="HSDE Phase 6: bigfloat SDP solver (separate ADR)" --type=feature --priority=3
bd create --title="HSDE Phase 7: corpus 6/6 at tightened TOL_KKT" --type=task --priority=2
# Wire deps: phase-5 blocks phase-7; phase-6 is an alternative path to phase-5
```

---

## 4. Concrete algorithm specification — what to add

This section describes ONE specific intervention (Phase 5: iterative
refinement). It's the recommended next step. Phase 6 (bigfloat) is
an alternative that should be a separate ADR.

### 4.1 The change in plain words

Today's flow per iter of `HsdeLpSolver` and `HsdeNtSdpSolver`:

1. Assemble Schur M.
2. Factor `Lchol = chol(M + reg·I)` via `factorWith3Way`.
3. Solve `Lchol·dy1 = rhs1` via `choleskySolveInPlace`.
4. Solve `Lchol·dy2 = rhs2_aff` via `choleskySolveInPlace`.
5. Solve `Lchol·dy2 = rhs2_comb` via `choleskySolveInPlace`.

The bug: step 3, 4, 5 each return `dy` such that
`(M + reg·I)·dy ≈ rhs` to ~machine epsilon — but we want
`M·dy ≈ rhs` (without the regulariser). With `reg = 1e-2` and
`‖M‖ ~ 1e+13`, the relative perturbation is `1e-15` — within float64
noise. But for the back-substitution to be accurate to 1e-10 or
better, the iterate-direction's first IR step might catch a few
decades of residual.

After change:

1. Assemble Schur M (same).
2. Factor `Lchol = chol(M + reg·I)` (same).
3. For each of the 3 right-hand sides:
   - Initial back-sub: `dy = solve(Lchol, rhs)`.
   - **Loop until convergence or max_iter:**
     - Compute residual `e = rhs - M·dy` (use the *un-regularised* M).
     - If `‖e‖_∞ < tol · (1 + ‖rhs‖_∞)`, **break**.
     - If iter > 0 and `‖e‖_prev / ‖e‖ < IRERRFACT (=6)`, **break** (stagnation).
     - `dy_corr = solve(Lchol, e)`.
     - Trial update: `dy_trial = dy + dy_corr`.
     - If `‖e_trial‖ > ‖e‖`, **undo and break** (IR made things worse).
     - `dy ← dy_trial`.

Apply this pattern to all three back-substitutions per iter (the
data direction and both iterate directions). The Schur factor
`Lchol` is unchanged across IR steps.

### 4.2 Detailed pseudocode (do NOT copy verbatim; understand and translate)

```typescript
// Place this helper in a new file: `packages/solver-ipm/src/linalg/IterativeRefinement.ts`
// Or extend `packages/solver-ipm/src/linalg/Cholesky.ts` with a new function.

/**
 * Solve M·dy = rhs accurately via Cholesky + iterative refinement.
 *
 * - `Lchol` is the lower-triangular factor of M + reg·I (i.e., the
 *   regulariser-perturbed version of M). Use `choleskySolveInPlace`
 *   for back-substitution.
 * - `M` is the unperturbed symmetric matrix. For residual computation
 *   we use M, NOT M + reg·I.
 * - `rhs` is the right-hand side.
 *
 * Returns the number of refinement steps actually taken (for the
 * verbose trace's nitref{1,2,3} fields, ECOS-style).
 *
 * Caller owns `dy`; this function writes the solution into it.
 */
function solveWithIR(
  M: Float64Array,           // m × m, row-major, original (un-regularised)
  m: number,
  Lchol: Float64Array,       // m × m, lower-triangular factor of (M + reg·I)
  rhs: Float64Array,         // m-vector
  dy: Float64Array,          // m-vector, output
  // Workspaces (caller-allocated to avoid per-iter allocations):
  workE: Float64Array,
  workCorr: Float64Array,
  // Tuning:
  maxIter: number = 9,
  tolRel: number = 1e-14,    // ECOS LINSYSACC
  stagnationFactor: number = 6,
): number {
  // Initial back-sub
  dy.set(rhs);
  choleskySolveInPlace(Lchol, m, dy);

  let prevErrNorm = Infinity;
  let nitref = 0;
  const rhsNorm = vecInfNorm(rhs);

  for (let k = 0; k < maxIter; k++) {
    // e = rhs - M·dy
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += M[i * m + j]! * dy[j]!;
      workE[i] = rhs[i]! - s;
    }
    const errNorm = vecInfNorm(workE);

    // Convergence check
    if (errNorm < tolRel * (1 + rhsNorm)) break;

    // Stagnation check (after at least one refinement)
    if (k > 0 && prevErrNorm / Math.max(errNorm, 1e-300) < stagnationFactor) break;

    // Trial refinement step
    workCorr.set(workE);
    choleskySolveInPlace(Lchol, m, workCorr);

    // Try the update; back off if it makes things worse
    for (let i = 0; i < m; i++) dy[i] = dy[i]! + workCorr[i]!;

    // Re-compute residual to verify improvement (this can be done
    // cheaper than the full M·dy product — defer profiling for v2)
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += M[i * m + j]! * dy[j]!;
      workCorr[i] = rhs[i]! - s;
    }
    const newErrNorm = vecInfNorm(workCorr);
    if (newErrNorm > errNorm) {
      // IR made it worse; undo and break
      for (let i = 0; i < m; i++) dy[i] = dy[i]! - workCorr[i]!;
      // (Wait — that's wrong; we'd need to undo the +workCorr from before.
      //  Re-think: track the *trial* dy, only commit if it improves.)
      break;
    }

    prevErrNorm = errNorm;
    nitref++;
  }

  return nitref;
}
```

**Note the bug I introduced in the sketch** — the "undo" path
isn't quite right. You'll need to do this carefully: keep a copy
of `dy` before each trial step, only commit if `‖e_new‖ < ‖e_old‖`,
otherwise roll back. **Don't copy my pseudocode verbatim — write
fresh code that correctly implements the ECOS IR pattern.** Re-read
`/tmp/ecos-reference/src/kkt.c:113-232` carefully.

### 4.3 Where to wire the new helper

In `HsdeLpSolver.ts:computeDataDirection`:
```typescript
// Before:
st.dy1.set(st.rhs);
choleskySolveInPlace(st.Lchol, m, st.dy1);
// After:
const nitref1 = solveWithIR(st.M, m, st.Lchol, st.rhs, st.dy1, st.workE, st.workCorr);
```

Same pattern in `computeAffineDirection` (`nitref2`) and
`computeCombinedDirection` (`nitref3`).

Same pattern in `HsdeNtSdpSolver.ts` for the three back-substitutions.

**Important:** the residual computation `e = rhs - M·dy` uses the
*un-regularised* M. Make sure `st.M` is preserved across the
factor call (don't let `factorWith3Way` mutate it — it shouldn't,
but verify).

### 4.4 Adding fields to `VerboseIterLine`

Per ECOS pattern, expose IR step counts in the trace for the
diagnostic pipeline:

```typescript
// In Solver.ts VerboseIterLine:
nitref1: number;   // IR steps on data-direction back-sub (HSDE only)
nitref2: number;   // IR steps on affine back-sub
nitref3: number;   // IR steps on combined back-sub
```

NaN-fill these in the legacy emission sites (Solver.ts LP,
NtSdpSolver.ts, AhoSdpSolver.ts, SdpSolver.ts). Populate them
in HsdeLpSolver.ts and HsdeNtSdpSolver.ts.

Update `LogFormat.ts:formatVerboseLine` to render
`nitref=(1,2,3)` when HSDE kind.

### 4.5 New tests

Don't just add tests that test that IR runs. Test that **IR delivers
the precision we expect**:

```typescript
// New test file: packages/solver-ipm/test/hsde-precision.test.ts
describe("HSDE precision floor with iterative refinement", () => {
  test("hinf2 reaches pInf < 1e-9 via HSDE+IR", () => {
    // Load hinf2 from /home/tobias/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s
    const res = solveHsdeSdpNt(prob, { params: { feasTol: 1e-9, optTol: 1e-9, iterLimit: 200 } });
    expect(res.status).toBe("optimal");
    expect(res.primalInf).toBeLessThan(1e-9);
  });
});
```

If hinf2 doesn't reach 1e-9 with IR, **don't** loosen the test —
profile what's still blocking. Possibilities:
- IR's `LINSYSACC` is too loose; tighten to 1e-15 or 1e-16.
- `IRERRFACT` is too aggressive in cutting off; try 10 or 100.
- Maybe `maxIter` of 9 isn't enough; try 20.
- Maybe the residual computation needs higher-precision arithmetic
  (Kahan summation for the M·dy product).

Honest scope: if you've tried all of the above and still can't
reach 1e-9, that's evidence we need bigfloat (Phase 6). **Document
the experiment in a worklog shard** and stop. Don't keep tuning
heuristics blindly.

### 4.6 Acceptance for Phase 5

- All 80 existing solver-ipm tests still pass (zero regression).
- New `hsde-precision.test.ts` cases pass:
  - hinf2 reaches `pInf < 1e-9` (target; may need to loosen to 1e-8 if IR doesn't fully crack it).
  - control2, control3 reach strict `optimal` status (not just `dual-feasible`).
- Corpus bench:
  ```sh
  cd ~/Projects/scientist-workbench-corpus && bun src/cli.ts grade scientist-workbench sdp-sdplib
  ```
  Reports **6/6** (assumes Phase 3 wiring is done so `--method=hsde-nt` is default).
- `bun run check` green.
- Worklog shard `docs/worklog/096-solver-ipm-hsde-ir.md` documents
  the IR pattern, the diagnostic trace evidence, and where IR helped
  vs didn't.

---

## 5. Hidden hazards specific to this phase

Mistakes the next agent is likely to make. Stop and re-check the
relevant reference if any of these apply.

### 5.1 Don't use the regularised matrix in the IR residual

```typescript
// WRONG:
for (let i = 0; i < m; i++) {
  let s = 0;
  for (let j = 0; j < m; j++) s += (M[i * m + j]! + (i === j ? reg : 0)) * dy[j]!;
  workE[i] = rhs[i]! - s;
}
```

The whole point of IR is to compensate for the regularisation. The
residual must be computed against the **unperturbed** M.

### 5.2 The residual computation is O(m²) per step

With `m` up to ~100 on SDPLIB cases, that's 10000 ops per IR step,
9 IR steps, 3 back-substitutions per iter, 50+ iters → 13M ops per
solve just for residual computations. Not free but tolerable on
`m ≤ 100`. For `m > 500` the residual computation will dominate;
revisit then.

### 5.3 Don't apply IR to the data direction's Schur factor

The data direction `dy1` solves `M·dy1 = b + <A_i, W·C·W>`. This
RHS is *iterate-dependent through W*. So you can't cache `dy1`
across iters — re-solve each iter. IR within the iter is fine,
but no inter-iter caching.

### 5.4 Make sure the Mosek/And09 sign convention is preserved

The previous agent's HSDE LP derivation had a sign bug that took
20 minutes of trace-watching to find (Solver.ts:411 in current
commit, was `r_p` instead of `-r_p`). **When adding IR, double-check
all the sign-flipped places in `HsdeLpSolver.ts:computeAffineDirection`
and `:computeCombinedDirection`.** The IR step itself doesn't
change signs but does change the read of M and rhs.

### 5.5 Don't change PRSTATUS or termination thresholds

PRSTATUS = `(τ-κ)/(τ+κ)` is the formula that works for our trace
data — it matches Mosek's "→ +1 optimal, → -1 infeasible" behaviour.
Don't try to "improve" it with `(b^T y − c^T x)/...` — that was the
original handoff's mistake and it's wrong (the numerator goes to
zero at optimum). The current PRSTATUS works.

The ρ ≤ 1 termination thresholds (feasTol, optTol) are fine. Don't
tighten them globally — make IR work first, then re-evaluate.

### 5.6 Verify IR doesn't slow things below SDPT3's pace

SDPT3 v4 runs hinf2 in tens of milliseconds. Our current
HSDE NT solver runs it in 70ms. With IR adding 3 × m² × 9 ops/iter,
expect 100–200ms. If it goes above 1 second, profile — the bottleneck
is probably the residual computation (`M·dy`), which can be done with
a single GEMV.

---

## 6. Phase 3: tool wiring (low priority but needed)

Independent of Phase 5, the `tools/sdp-solve` doesn't yet expose
the HSDE solver. Add this to make HSDE benchmarkable through the
corpus bench:

```typescript
// tools/sdp-solve/tool.ts — extend pickSolver
type Method = "auto" | "nt" | "aho" | "hkm-debug" | "hsde-nt";

function pickSolver(method: Method): ... {
  switch (method) {
    case "auto":
    case "nt":     return { tag: METHOD_TAG_NT, solve: solveSdpNt };
    case "hsde-nt": return { tag: "hsde-nt", solve: solveHsdeSdpNt };  // NEW
    case "aho":    return { tag: METHOD_TAG_AHO, solve: solveSdpAho };
    case "hkm-debug": return { tag: METHOD_TAG_HKM, solve: solveSdpHkm };
  }
}
```

The `solveHsdeSdpNt` signature differs slightly from `solveSdpNt`
in the result shape (`HsdeSdpSolveResult` vs `SdpSolveResult`).
Adapt `encodeSdpResult` to handle both, or write a thin shim.

**DO NOT change the default to `hsde-nt`** until Phase 5 lands —
HSDE without IR is no better than legacy NT on the problematic
cases (control2, control3, hinf2).

Same for `tools/lp-solve` and `scripts/sdp-probe.ts` — add the
`--method=hsde-nt` and `--method=hsde-lp` flags but keep defaults
on the legacy paths.

**Acceptance for Phase 3:**
- `bun tools/sdp-solve/tool.ts --method=hsde-nt …` produces a
  correct wire result on `control1.dat-s` (validated against the
  corpus golden).
- `bun tools/sdp-solve/tool.ts --method=nt …` still works (back-compat).
- `bun run check` green.

---

## 7. Phase 6 (alternative path): bigfloat substrate

If Phase 5 (IR) doesn't crack hinf2 to 1e-9, the alternative is
to port the HSDE solver onto the `@workbench/bigfloat` substrate.
This is a **separate ADR** (don't bundle into Phase 5).

Key points:
- bigfloat carries the `arbprec: true` determinism contract (ADR-0020),
  stronger than the current `numerical: true`.
- Performance hit: ~10–100x slower per iter.
- Implementation: clone `HsdeNtSdpSolver.ts` to `BfHsdeNtSdpSolver.ts`,
  replace `Float64Array` with `BigFloat` arrays, swap `choleskyInPlace`
  for the bigfloat equivalent (which already exists in `@workbench/
  bigfloat`).

Don't pursue this unless Phase 5 demonstrably fails. Most likely
Phase 5 + Phase 6 are both desirable: 6 is the precision floor
when 5 isn't enough.

**Acceptance for Phase 6:** separate ADR; agent #N+2 territory.

---

## 8. Phase 7: tighten corpus TOL_KKT

Once Phase 5 lands and 6/6 is true at the loosened gate, tighten
the corpus `TOL_KKT` from the worklog-095 values back toward 1e-7
(or the asymmetric split). Verify 6/6 holds. This is the
final "victory lap" of the qmrv work.

Acceptance: corpus bench at tightened gate reports 6/6. Update
`scientist-workbench-corpus` repo accordingly.

---

## 9. Local references and tooling

### 9.1 The trace-diff harness

Worklog 095's verbose trace pipeline is your friend. **Use it
constantly** during IR development:

```sh
# Capture HSDE-NT-with-IR trace
IPM_TRACE_JSONL=/tmp/with-ir.jsonl bun scripts/sdp-probe.ts case.dat-s --method=hsde-nt

# Capture HSDE-NT-without-IR trace (a baseline; you may need to
# add a --no-ir flag to disable IR)
IPM_TRACE_JSONL=/tmp/no-ir.jsonl bun scripts/sdp-probe.ts case.dat-s --method=hsde-nt-no-ir

# Diff
bun scripts/trace-diff.ts /tmp/with-ir.jsonl /tmp/no-ir.jsonl
```

When IR helps, you'll see `nitref` columns climbing and `pInf`
shrinking compared to the no-IR baseline. When IR doesn't help
(stagnation), the trace shows IR-step counts going up without
residual improvement.

### 9.2 The Mosek comparison oracle

The corpus already has `docs/oracles/copt-sdpmethod0/{control2,control3,hinf2}.copt.jsonl`
from worklog 095. For HSDE comparison we want **Mosek's iter trace**.
That requires writing `scripts/mosek-log-to-jsonl.ts` (analog of
the existing `scripts/copt-log-to-jsonl.ts`).

The Mosek log format (from `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/probes/probe_sdo1.log`):
```
ITE PFEAS    DFEAS    GFEAS    PRSTATUS   POBJ              DOBJ              MU       TIME
0   3.0e+00 1.0e+00  8.0e+00  0.00e+00   7.000000000e+00   0.000000000e+00   1.0e+00  0.01
1   4.3e-01 1.4e-01  5.7e-01  1.67e-01   1.601234159e+00   3.103213078e-01   1.4e-01  0.02
...
```

Map to `VerboseIterLine`:
- `primalObj=POBJ, dualObj=DOBJ, compl=MU, primalInf=PFEAS, dualInf=DFEAS, timeSec=TIME`
- `gfeas=GFEAS, prstatus=PRSTATUS` (HSDE-specific columns)
- `kind="mosek"` (new discriminator value; extend the union in Solver.ts)
- Other fields `null` (filler — Mosek's log doesn't expose them).

This script is ~30 LOC and unlocks iter-by-iter trace-diff against
Mosek. Write it as part of Phase 5's diagnostic infrastructure —
when IR development stalls, the Mosek diff tells you *which iter*
the trajectories diverge.

### 9.3 The single-case probe

`scripts/sdp-probe.ts` is the fastest path to debug a single SDP.
Add `--method=hsde-nt` (Phase 3 dep) and use it.

### 9.4 Diagnostic loop

The discipline (worklog 095): **build the loop before entering it.**

1. Add the `nitref1/2/3` fields to `VerboseIterLine`.
2. Wire them through the LP and SDP HSDE solvers (initially populate
   with `0` since IR isn't there yet).
3. **Then** implement IR, incrementing the counters.
4. The first IR run on hinf2 — check the verbose trace immediately:
   - Are `nitref` counts climbing? Good (IR is firing).
   - Are they stuck at 0? Either tolerance is too loose or IR isn't reachable.
   - Are they at 9 every iter? IR isn't converging within budget — investigate.

This loop is non-negotiable. Implementing IR without instrumentation
is the same mistake as fixing convergence without instrumentation
(worklog 095).

---

## 10. What "done" looks like

A complete next phase lands these outcomes:

1. **Phase 5 (IR)** lands as new bead `<TBD>`. Acceptance:
   - hinf2 reaches `pInf < 1e-9` (or honest documented reason why not).
   - control2, control3 return `optimal` status (not `dual-feasible`).
   - 80 existing tests still pass + new IR-precision tests.
   - Worklog shard `096-solver-ipm-hsde-ir.md`.

2. **Phase 3 (tool wiring)** lands as bead `y3qd`. Acceptance:
   - `--method=hsde-nt` works in `tools/sdp-solve`.
   - `--method=hsde-lp` works in `tools/lp-solve`.
   - Default is still `nt` / `ipm` (legacy) until Phase 5 lands.

3. **Phase 7 (tighten TOL_KKT)** lands as bead `ki4c`. Acceptance:
   - Corpus bench reports 6/6 at tightened gate.
   - `scientist-workbench-corpus` repo updated.

4. **qmrv** itself closes once Phase 5 + 7 land and bench is 6/6.

5. **This handoff doc** marked superseded.

---

## 11. Estimated effort

- **Reading** (Higham §12, SDPT3 §IR, ECOS kkt.c): 3-4 hours
- **Phase 5 (IR)**: 2-3 days
  - 1 day: write IR helper, wire into both HSDE solvers
  - 0.5 day: trace pipeline (nitref columns + mosek-log-to-jsonl)
  - 1 day: tune (LINSYSACC, IRERRFACT, maxIter); profile
- **Phase 3 (tool wiring)**: 0.5 day
- **Phase 7 (tighten TOL_KKT)**: 0.5 day
- **Worklog shard + handoff supersession**: 0.5 day

Total: ~1 week for a clean landing.

If you skip the reading, expect 2-3 weeks because you'll write the
wrong thing. The predecessor (this agent) confirmed: the Ruiz
handoff was wrong AND the predecessor's "HSDE alone fixes hinf2"
claim was wrong. Both errors traced to not reading enough primary
source. **Don't be next.**

---

## 12. Beads / commits at session close

Before saying done:

```sh
bd close <phase-5-bead-id> --reason="IR landed; hinf2 pInf=<actual>"
bd close y3qd --reason="--method=hsde-nt wired"
bd close ki4c --reason="6/6 at tightened TOL_KKT"
bd close qmrv --reason="HSDE+IR delivered 6/6 at corpus default gate"

git add packages/solver-ipm/ tools/sdp-solve/ scripts/ docs/
git commit -m "solver-ipm: HSDE Phase 5 (IR) + Phase 3 (tool wiring) → 6/6 sdp-sdplib"
git push
```

If any of those don't apply (e.g., Phase 5 partially shipped), be
honest in the commit message. Don't claim 6/6 you didn't measure.

---

## 13. References

- Andersen 2009 (Mosek TR-1-2009): `docs/refs/andersen-2009-homogeneous-self-dual.pdf`
- ART03: `docs/refs/andersen-roos-terlaky-2003.pdf`
- ECOS (Domahidi 2013): `docs/refs/domahidi-2013-ecos.pdf`
- SCS (O'Donoghue 2016): `docs/refs/odonoghue-2016-scs.pdf`
- Clarabel (Goulart 2024): `docs/refs/goulart-2024-clarabel.pdf`
- SDPT3 paper: **download via §1.4 above**
- Higham §12 IR: **download via §1.4 above**
- VERDICT.md: `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/analysis/VERDICT.md`
- COPT PD_IPM_DEEP.md: `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/PD_IPM_DEEP.md`
- Mosek probe logs: `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/probes/probe_{sdo1,lo1}.log`
- ECOS source: `/tmp/ecos-reference/`
- Worklog 095 (predecessor work): `docs/worklog/095-solver-ipm-verbose-trace-and-termination.md`
- ADR-0033 (HSDE design): `docs/adr/0033-hsde-for-solver-ipm.md`
- Predecessor handoff: `docs/HANDOFF_solver_ipm_hsde.md`

Good luck. **Read first.** And — if you find that *this* handoff
is wrong about something (the precision-floor diagnosis is the most
likely candidate), update it with what you learn. The next agent
after you will thank you.
