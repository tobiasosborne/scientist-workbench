# Handoff — HSDE port for `solver-ipm` (next phase of bead `qmrv`)

> **SUPERSEDED — 2026-05-16.** The HSDE port shipped across Phases 0-2
> (this handoff's playbook) + Phase 5 Tiers 0-4 (the precision-floor
> close-out under bead `qmrv`). See `docs/HANDOFF_solver_ipm_hsde_part2.md`
> for the part-2 handoff (also superseded; its header points at the
> per-tier worklogs 106 / 110 / 128 / 129). The TL;DR below is preserved
> as the historical diagnosis that motivated the port; the Phase 5
> precision verdict (worklog 128) refines it: the αP-collapse on hinf2
> *is* structurally resolved by HSDE, but the remaining 1-case gap (6/6)
> is the float64 representation of `r_p / τ` purification, not the
> boundary-clamp the original handoff diagnosed — `Phase 6 (bigfloat
> HSDE)` is the path past it.
>
> ---
>
> **Original TL;DR.** The 5/6 → 6/6 path on `sdp-sdplib` is now well-scoped. Mosek
> reaches `pres = 5.4e-13` on hinf2 in 84 iters; we stall at `pres = 3.8e-7`
> with `αP → 0` because our IPM does **not** use the Homogeneous Self-Dual
> Embedding (HSDE). Mosek does — `~/Dropbox/.../MOSEK-decomp/analysis/VERDICT.md`
> is the unambiguous identification (Andersen-Roos-Terlaky 2003, with
> Nesterov-Todd scaling and Mehrotra correctors on top). The algorithm
> we need to port is well-documented and the local references are in
> place. **This handoff is the playbook.**
>
> **Read order:**
> 1. This document end-to-end (20 min).
> 2. `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/analysis/VERDICT.md`
>    — the algorithm identification (15 min).
> 3. `~/mosek/11.1/doc/capi.pdf` §13.3 — Mosek's own description of the
>    homogeneous model. Includes eq. 13.8 (the textbook HSDE block)
>    and the termination dichotomy (30 min).
> 4. **ART03** (Andersen-Roos-Terlaky 2003) and **And09** (Andersen 2009
>    Mosek tech report) — see §0 below for download. (4 hrs.)
> 5. **ECOS source code** as a working open-source HSDE reference.
>    See §0 (3 hrs).
> 6. Worklog 095 (`docs/worklog/095-solver-ipm-verbose-trace-and-termination.md`)
>    — what's in place today, what the trace tooling looks like (30 min).
>
> Total ground-truth reading time: ~8-10 hrs.
> **Do not write a line of code before this is done.**
> Law 1: Ground truth before code. The handoff before this one (`HANDOFF_solver_ipm_qmrv.md`)
> proposed SDP-Ruiz as the fix; ~200 LOC of work that would have *not*
> fixed hinf2, because the diagnosis it built on had the |y|-reduction
> claim mathematically wrong. The corpus calibration survey
> (`/tmp/sdp-survey/calibration-table.md`) is what surfaced this. Read the
> papers; verify the math; *then* write.

---

## 0. Ground-truth assembly — required reading BEFORE any code

### 0.1 Local-only resources (already on disk; just read)

| File | Purpose | Time |
|---|---|---|
| `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/analysis/VERDICT.md` | The algorithm-identification verdict | 15m |
| `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/analysis/hsde_symbols.txt` | 91 `hom_*`/`intpnt_*` symbols — Mosek's HSDE API surface | 10m |
| `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/probes/probe_sdo1.log` | Full Mosek iter log on `sdo1.cbf` — note `GFEAS`/`PRSTATUS` cols | 15m |
| `~/Dropbox/Projects/Computers/LLM/MOSEK-decomp/probes/probe_lo1.log` | Same for LP — confirms shared HSDE core | 5m |
| `~/mosek/11.1/doc/capi.pdf` §13.3 | Official MOSEK docs, **eq. 13.8** | 30m |
| `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/CLEANROOM_SPEC.md` §6-9 | COPT's spec (also uses HSDE) — compare conventions | 30m |
| `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/IPM_LOOP_CHEATSHEET.md` | COPT's IPM loop, step-by-step | 30m |
| `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/PD_IPM_DEEP.md` | Deep COPT IPM architecture | 30m |
| `packages/solver-ipm/src/solver/{Solver,NtSdpSolver}.ts` | What we have today (read top-to-bottom) | 60m |
| `docs/worklog/095-solver-ipm-verbose-trace-and-termination.md` | The trace pipeline that diagnosed the stall | 30m |
| `/tmp/sdp-survey/calibration-table.md` | 50-problem survey: Mosek vs COPT vs SCS | 20m |

### 0.2 External papers — download these to `docs/refs/` and read

Create a refs directory and stash the papers as you grab them. *Do not skip this step.*

```sh
mkdir -p docs/refs/
cd docs/refs/

# Andersen 2009 — Mosek's own HSDE-for-LP tech report.
# Free on Mosek's whitepapers page. THIS IS THE PRIMARY IMPLEMENTATION REFERENCE.
curl -fLO https://docs.mosek.com/whitepapers/homo.pdf
mv homo.pdf andersen-2009-homogeneous-self-dual.pdf

# ECOS paper (Domahidi-Chu-Boyd 2013) — open-source HSDE for conic.
# THE clearest written treatment of HSDE for conic problems.
curl -fLO https://web.stanford.edu/~boyd/papers/pdf/ecos_ecc.pdf
mv ecos_ecc.pdf domahidi-2013-ecos.pdf

# SCS paper (O'Donoghue-Chu-Parikh-Boyd 2016) — first-order on HSDE.
# Useful for understanding the homogenized iterate dynamics.
curl -fLO https://web.stanford.edu/~boyd/papers/pdf/scs.pdf
mv scs.pdf odonoghue-2016-scs.pdf

# ART03 — original Andersen-Roos-Terlaky 2003 paper. The canonical reference.
# IF you cannot download (paywalled at Springer), try:
#   - Google Scholar: search "Andersen Roos Terlaky 2003 conic quadratic"
#   - The author's homepage: erling@andersen.dk / mosek.com authors
#   - Library access (preferred): DOI 10.1007/s10107-002-0349-3
# If absolutely no PDF available, the And09 + ECOS papers together cover
# the algorithm well enough; ART03 is the *citation*, not the only source.
echo "ART03: try https://link.springer.com/article/10.1007/s10107-002-0349-3"
echo "        or Google Scholar -- not guaranteed open access"

# (Optional but recommended) Clarabel paper — modern Rust HSDE solver,
# excellent self-contained explanation.
curl -fLO https://oxfordcontrol.github.io/clarabel-docs/_static/clarabel.pdf || \
    echo "Clarabel paper: search clarabel.org/docs/ for current location"
```

After download, **verify** each file is real (not an HTML error page):

```sh
file docs/refs/*.pdf   # should all say "PDF document, version 1.x"
```

If a URL is dead, search for the canonical title and grab the current
location. Do **not** proceed without at least Andersen 2009 + ECOS in
hand — those two together cover the algorithm.

### 0.3 Reference implementation (READ-ONLY)

Clone ECOS for reading. **Do not copy code** — license is GPL and we are
TS not C. Read it as a structural reference.

```sh
cd /tmp/
git clone --depth 1 https://github.com/embotech/ecos.git ecos-reference
```

Key files to read:

| File | Role |
|---|---|
| `ecos-reference/src/ecos.c` | Main solve loop — **the HSDE iteration is here** |
| `ecos-reference/src/preproc.c` | Initial point construction + scaling |
| `ecos-reference/src/kkt.c` | The augmented KKT system solve |
| `ecos-reference/src/spla.c` | Sparse linear algebra helpers |
| `ecos-reference/include/ecos.h` | Iterate struct (`pwork`) — see how `(x, y, z, s, tau, kappa)` is stored |

The ECOS code is ~5000 LOC of C. The HSDE core in `ecos.c` is ~700 LOC.
That's the structural target for the size of our port.

### 0.4 Reading checkpoints — verify your understanding

Before writing code, you should be able to answer (no peeking):

1. **What are the iterate variables in HSDE?**
   *(Expected: `(x, y, s, τ, κ)` where `(x, s) ∈ K × K^*` are the
   primal/dual cone variables, `y ∈ ℝ^m` is the dual multiplier, and
   `τ, κ ∈ ℝ₊` are the homogenization scalars.)*

2. **What is the third HSDE row?**
   *(Expected: `−cᵀx + bᵀy − κ = 0`. This is the gap-feasibility row.
   Mosek's `GFEAS` column tracks its residual.)*

3. **What's the termination dichotomy?**
   *(Expected: at the optimum, either `τ → 1, κ → 0` ⟹ `(x/τ, y/τ, s/τ)`
   is optimal; or `τ → 0, κ → 1` ⟹ `(x, y, s)` is an infeasibility
   certificate. The `PRSTATUS` indicator → +1 on optimal, → -1 on
   infeasible.)*

4. **Why does HSDE avoid our boundary-clamp stall?**
   *(Expected: the cone is `(x, τ) ∈ K × ℝ₊`, not `x ∈ K`. As `x`
   approaches the boundary of `K`, `τ` can shrink to keep the
   homogenized iterate strictly interior. There is no analogue of our
   `αP → 0` collapse because the Newton direction can always make
   progress in `τ`.)*

5. **What's the difference between ART03 and Ye-Todd-Mizuno 1994?**
   *(Expected: YTM 1994 embeds the problem into a larger artificial
   self-dual program; ART03 homogenizes via `τ, κ` without artificial
   variables. ART03 is cheaper and produces certificates directly.)*

6. **Why is the Schur complement still PSD in HSDE?**
   *(Expected: the augmented KKT system is symmetric indefinite, but
   after the standard reduction it gives a Schur complement of the same
   PSD form as the non-HSDE case, plus a rank-1 update from the
   τ-κ block. Cholesky still works.)*

If any of these are unclear after reading, **re-read**, do not write
code yet.

---

## 1. The HSDE specification (compact)

This section is a compact restatement of what's in ART03 §3 / Andersen
2009 §2 / ECOS paper §2. It is **not** a substitute for reading those
papers; it is a checklist for the agent who has read them.

### 1.1 Standard primal-dual form (today's solver)

Primal:
```
min  cᵀx
s.t. Ax = b
     x ∈ K
```

Dual:
```
max  bᵀy
s.t. Aᵀy + s = c
     s ∈ K^*  (= K for symmetric cones)
```

KKT conditions:
```
Ax = b
Aᵀy + s = c
xᵀs = 0  (complementary slackness)
x ∈ K, s ∈ K^*
```

Today's `NtSdpSolver.ts` iterates on `(X, y, S)`.

### 1.2 Homogenized form (HSDE)

Introduce `τ ∈ ℝ₊` (homogenization for primal) and `κ ∈ ℝ₊` (slack for
the homogenization). The HSDE iterate is `(x, y, s, τ, κ)`. The
homogenized KKT block (eq. 13.8 in `~/mosek/11.1/doc/capi.pdf`,
eq. (3) in ART03):

```
Ax − bτ          = 0         (primal feas with homogenization)
Aᵀy + s − cτ     = 0         (dual feas with homogenization)
−cᵀx + bᵀy − κ   = 0         (gap-feasibility — this is the new row)
xᵀs + τκ         = 0         (homogenized complementary slackness)
(x, s) ∈ K × K^*, τ, κ ≥ 0
```

The three residual vectors:
```
r_p = Ax − bτ
r_d = Aᵀy + s − cτ
r_g = −cᵀx + bᵀy − κ
```

Mosek's iter-log columns map directly:
- `PFEAS` = `‖r_p‖ / (1 + ‖b‖)` (scaled primal infeas)
- `DFEAS` = `‖r_d‖ / (1 + ‖c‖)` (scaled dual infeas)
- `GFEAS` = `|r_g| / (1 + |cᵀx − bᵀy|)` (scaled gap-feas)
- `MU` = `(xᵀs + τκ) / (n + 1)` (homogenized complementarity measure)
- `PRSTATUS` = `(bᵀy − cᵀx) / (max(‖b‖, ‖c‖, 1))` (an indicator that
  trends to +1 when heading to optimal, −1 when heading to infeasible)

### 1.3 Newton step (predictor-corrector)

The standard primal-dual IPM Newton step extends to HSDE by adding two
more equations and two more unknowns. The augmented system has the
block structure:

```
⎡  0    Aᵀ    I      −c    0  ⎤  ⎡ Δx ⎤   ⎡ r_d ⎤
⎢ −A    0     0       b    0  ⎥  ⎢ Δy ⎥   ⎢ r_p ⎥
⎢  cᵀ  −bᵀ    0       0    1  ⎥  ⎢ Δs ⎥ = ⎢ r_g ⎥
⎢  S    0     X       0    0  ⎥  ⎢ Δτ ⎥   ⎢ rc1 ⎥
⎣  0    0     0       κ    τ  ⎦  ⎣ Δκ ⎦   ⎣ rc2 ⎦
```

This block factors into the **augmented KKT system** (rows 1–4) and a
**scalar tau-kappa update** (row 5) via Mosek's `intpnt_solve_skewsymm`
+ `intpnt_solve_augm` pairing. ECOS does this split cleanly; see
`ecos-reference/src/ecos.c:RHS_affine()` and `ecos.c:updateKappaTau()`.

For SDP the cone-specific NT scaling (already in
`NtSdpSolver.ts:buildNtFactor`) replaces the diagonal scaling `(S, X)`
in the `[ S 0 X ]` row with `(W^{-1}, W)`. Our existing NT machinery
applies unchanged.

### 1.4 Termination

At each iter compute `PRSTATUS = (bᵀy − cᵀx) / max(‖b‖, ‖c‖, 1)`.
The decision tree (mirroring ART03 + Mosek's `hom_terminatelo`):

| Condition | Status |
|---|---|
| `PFEAS, DFEAS, GFEAS, MU < tol` AND `PRSTATUS > 0.5` | **OPTIMAL** (return `(x/τ, y/τ, s/τ)`) |
| `PFEAS, DFEAS, GFEAS, MU < tol` AND `PRSTATUS < −0.5` | **INFEASIBLE** (return `(x, y, s)` as certificate) |
| Step length too short on `τ` (`Δτ` near 0, `τ` already tiny) | **ILL-POSED** |
| Iter limit | **ITER_LIMIT** (return best iterate) |
| `τ`+`κ` stalled, residuals not below tol | **NUMERICAL_DIFFICULTY** |

### 1.5 Solution purification

The HSDE iterate at termination is `(x*, y*, s*, τ*, κ*)`. The user
wants the un-homogenized solution:
```
x = x* / τ*
y = y* / τ*
s = s* / τ*
```
provided `τ*` is reasonably large (`> ε_τ`, typically `1e-10`). This
is Mosek's `intpntpurify.c`. After division, we may need one or two
Newton-projection steps to absorb the round-off — see ECOS
`ecos.c:linsysverbose` / `ecos.c:cleanup` for the standard pattern.
Without purification, the corpus verifier may see drift on the order
of `1/τ * machine_eps`, which on hinf2 with `τ ≈ 0.5` is about
`2e-16` — negligible. On problems where `τ` is small (boundary cases),
purification matters more.

### 1.6 Initial point recipes

Mosek has 4 named variants: `hom_inititer`, `hom_inititerprimal`,
`hom_inititerdual`, `hom_inititermu`. ART03 §4 documents:

```
x₀ = ξ_p · e_K   (where e_K is the cone-center vector)
s₀ = ξ_d · e_K
y₀ = 0
τ₀ = 1
κ₀ = 1
```

with scales `ξ_p = max(1, ‖b‖)` and `ξ_d = max(1, ‖c‖)`. Our existing
`initialScale()` in `NtSdpSolver.ts` already does the `ξ_p, ξ_d` part;
we add `τ₀ = κ₀ = 1`.

ECOS uses a slightly more aggressive heuristic: solve the
predictor-corrector once with degraded scaling to compute a better
starting point. Optional.

---

## 2. Implementation phases

Five phases, each gated by a beads issue and an acceptance criterion.
Do NOT skip the LP-first phase. The LP HSDE is simpler (no NT
scaling) and reveals interface issues before they get tangled up
with cone algebra.

### Phase 0: ADR + module scaffold

**Bead:** create `bd create --title="HSDE solver: ADR + LP scaffold"
--type=task --priority=1`.

**Deliverables:**

- `docs/adr/NNNN-hsde-for-solver-ipm.md` — Architecture Decision Record
  documenting the move to HSDE. Sections: Why HSDE (cite VERDICT.md,
  the survey data), What stays (NT scaling, Mehrotra, verbose trace),
  What changes (iterate, KKT, termination, purification), Migration
  plan (LP first, SDP next, existing solvers as A/B references).
- `packages/solver-ipm/src/solver/HsdeIterate.ts` — type definitions:
  `HsdeIterate { x, y, s, tau, kappa }`, `HsdeResiduals`,
  `HsdeStatus`. Pure types, no algorithm.
- `packages/solver-ipm/src/solver/HsdeStepLength.ts` — step-to-cone-
  boundary including `τ ≥ 0, κ ≥ 0`. Re-uses our existing `minBlockStep`
  for the cone part.

**Acceptance:**
- `bun run check` green (additive only; no behaviour change).
- ADR explains the *why* in terms a fresh reader can pick up cold.

### Phase 1: HSDE for LP

**Bead:** `bd create --title="HSDE LP solver: HsdeLpSolver"
--type=feature --priority=1 --acceptance="netlib AFIRO/ADLITTLE pass,
brandy stall resolved or honest tagged refusal"`.

**Files:**
- `packages/solver-ipm/src/solver/HsdeLpSolver.ts` — the new LP solver.
  Iterates on `(x, y, s, τ, κ)`. Cone is `ℝ^n_+`. No NT scaling
  (LP is special).
- `packages/solver-ipm/test/hsdeLp.test.ts` — golden tests on a few
  hand-coded LPs (the same fixtures `solver.test.ts` uses, but for
  the new solver).

**Key implementation steps (do them in this order):**

1. **Initial point.** `(x, s, τ, κ) = (ξ_p·e, ξ_d·e, 1, 1)`, `y = 0`.
2. **Residual computation.** Compute `r_p = Ax − bτ`, `r_d = Aᵀy + s − cτ`,
   `r_g = −cᵀx + bᵀy − κ`. Compute `mu = (xᵀs + τκ) / (n + 1)`.
3. **Convergence test.** Apply termination decision tree (§1.4 above).
   Use the verifier-aligned achieved metric for best-iterate snapshot,
   matching the pattern in `NtSdpSolver.ts:bestAchieved`.
4. **Augmented KKT system.** Block-structure the 5×5 system from §1.3
   into a 4×4 augmented system plus scalar `(Δτ, Δκ)` update. Solve
   the 4×4 via the same Cholesky-on-Schur path as the existing LP
   solver. The `(Δτ, Δκ)` solve is two scalar back-substitutions.
   ECOS reference: `ecos.c:updateStatistics()` followed by the RHS
   computation.
5. **Predictor-corrector.** Affine step (σ=0) gives `(Δx_a, Δy_a, Δs_a, Δτ_a, Δκ_a)`.
   Compute `α_aff = min(α_max_p, α_max_d, α_tau, α_kappa)`, predict
   `μ_aff`, set `σ = (μ_aff / μ)^3` clipped to `[1e-8, 0.9]`.
   Corrector step with `σ μ` centering. Final step length includes the
   τ-κ direction.
6. **Step.** Update `(x, y, s, τ, κ) += α · (Δx, Δy, Δs, Δτ, Δκ)`.
7. **Purification.** On terminate, divide by `τ*`.

**Verbose trace.** Extend `VerboseIterLine` with three fields:
`tau`, `kappa`, `gfeas`, `prstatus`. The discriminator `kind` is now
`"lp-hsde" | "sdp-hsde-nt" | "lp" | "sdp-nt" | ...`. JSONL stable
across solver kinds.

**Acceptance:**
- All existing `solver.test.ts` tests for the non-HSDE LP solver still
  pass (zero regression).
- New tests for `HsdeLpSolver` pass on 3-4 hand-coded LP fixtures.
- AFIRO from `lp-netlib` corpus converges and passes verifier.
- brandy from `lp-netlib` either converges (better than today's
  numerical-difficulty stall) or returns a clean tagged refusal.

### Phase 2: HSDE for SDP (NT direction)

**Bead:** `bd create --title="HSDE SDP solver with NT scaling: HsdeNtSdpSolver"
--type=feature --priority=1 --acceptance="sdp-sdplib 6/6 at corpus
default tol; hinf2 pres < 1e-9"`.

**Files:**
- `packages/solver-ipm/src/solver/HsdeNtSdpSolver.ts` — the new SDP
  solver. Iterates on `(X, y, S, τ, κ)` where `X, S` are per-block PSD
  matrices.
- `packages/solver-ipm/test/hsdeNtSdp.test.ts` — golden + property tests.

**Key differences from Phase 1:**
- Cone scaling: use existing `NtFactor` (buildNtFactor in
  `NtSdpSolver.ts`). The `(Δx, Δs)` part of the Newton system gets the
  NT scaling treatment; `(Δτ, Δκ)` stays scalar.
- Schur assembly: per-block, identical to today's
  `NtSdpSolver.ts:solveSdpNt` Schur loop. The HSDE extension adds
  rank-1 updates from the τ-κ row.
- Step length: per-block min eigenvalue check (existing
  `minBlockStep`) + scalar τ, κ check.
- Best-iterate snapshot: same logic as `finalizeBestOr` but on the
  homogenized iterate; purify before returning to the verifier.

**Acceptance:**
- All existing `solver-ipm` tests (68/68) pass (zero regression on
  AHO/HKM/NT — we keep them as A/B references).
- `bun tools/sdp-solve/tool.ts --test` smoke passes.
- `IPM_TRACE_JSONL=/tmp/hinf2-hsde.jsonl bun scripts/sdp-probe.ts
  ~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s
  --method=hsde-nt` reaches `pres < 1e-9`.
- `cd ~/Projects/scientist-workbench-corpus && bun src/cli.ts grade
  scientist-workbench sdp-sdplib` → **6/6**.
- `bun run check` green.

### Phase 3: Tool wiring + default switch

**Bead:** `bd create --title="sdp-solve: HSDE-NT as default method"
--type=task --priority=2`.

**Deliverables:**
- `tools/sdp-solve/tool.ts` — add `--method=hsde-nt|nt|aho|hkm` flag,
  default to `hsde-nt`. Update tool README and catalog row.
- `scripts/sdp-probe.ts` — add `hsde-nt` to the method enum.
- `scripts/demo-scope.sh` — add representative HSDE invocation.

**Acceptance:**
- Tool runs HSDE-NT by default.
- Backward compat: `--method=nt` still selects the legacy NT solver.
- Wider survey (`/tmp/sdp-survey/driver.py` with `CANDIDATE_TOOL=sdp-solve`)
  shows our solver's residuals approaching Mosek's pres column on
  most problems.

### Phase 4: Tighten the bench tol back

**Bead:** `bd create --title="Corpus sdp-sdplib: tighten TOL_KKT toward 1e-7
once HSDE is in" --type=task --priority=3`.

This is the **stretch goal** flagged by the user. Once HSDE lands and
our solver reaches Mosek-class precision, tighten the corpus's
`TOL_KKT` from the loosened values back toward the original 1e-7 (or
the asymmetric `r_p, gap, |x·s| ≤ 1e-7, r_d ≤ 1e-6` split). Verify
the bench still passes 6/6 with the tighter gate.

**Acceptance:**
- 6/6 on `sdp-sdplib` at the tightened tol.
- Survey across the wider SDPLIB set (`gpp`, `equalG`, `mcp250-*`,
  etc.) shows our solver competitive with Mosek (pres in 1e-9 to 1e-13
  range).

### Phase 5 (optional): HSDE for AHO/HKM

If the bench passes 6/6 with HSDE-NT, the AHO and HKM directions can
also get HSDE treatment for completeness. **Low priority** — they
remain A/B reference solvers, not on the corpus path.

---

## 3. Hidden hazards / common mistakes

Mistakes that look right but aren't. When you catch yourself about to
do one, stop and re-read the relevant section above.

### 3.1 Don't conflate the affine and corrector step lengths

In the existing non-HSDE solver, `α_max` is just the cone-boundary
step length. In HSDE, the step also has to keep `τ ≥ 0, κ ≥ 0`.
The full step length is `min(α_cone_p, α_cone_d, α_tau, α_kappa)`.
Forgetting `α_tau` or `α_kappa` is a common subtle bug — symptom is
`τ` or `κ` going negative, NaN propagation, IPM stalls.

### 3.2 PFEAS / DFEAS denominators include `τ`

In the non-HSDE solver, `pres = ‖Ax − b‖`. In HSDE, `r_p = Ax − bτ`,
and `PFEAS = ‖r_p‖ / (1 + ‖b‖)` is scaled by the *original* `‖b‖`,
not `‖bτ‖`. This is in eq (13.10) of `capi.pdf` and Andersen 2009 §3.
Getting this wrong makes the convergence test fire too early or too
late.

### 3.3 Best-iterate snapshot is on the *unpurified* iterate

Snapshot `(x*, y*, s*, τ*, κ*)` directly; purify (divide by `τ`) only
when *returning*. Saving the purified iterate to the snapshot, then
re-purifying, double-divides — symptom is the returned objective being
off by exactly `1/τ²`.

### 3.4 The Schur complement is positive semidefinite, *not* the augmented
matrix

The 5-block augmented KKT matrix is **symmetric indefinite** (signs
mix). After the Schur-complement reduction it becomes PSD and our
existing Cholesky works. Don't try to factor the full augmented
matrix with Cholesky — it'll fail. ECOS `kkt.c` has a clean version
of this reduction.

### 3.5 ART03 vs Andersen 2009 vs ECOS conventions

These three references use slightly different sign conventions for
`r_g`, slightly different normalization of `PRSTATUS`, and slightly
different initial-point recipes. **Pick one and stick with it.**
Recommendation: follow Andersen 2009 throughout (it matches Mosek's
log output and our existing iteration-log format). Cite Andersen 2009
equation numbers in code comments where the algebra is non-obvious.

### 3.6 The cone constraint changes from `x ∈ K` to `(x, τ) ∈ K × ℝ₊`

Restating because this is the load-bearing thing. Today's
`minBlockStep` checks `X + α·ΔX ⪰ 0`. The HSDE version checks
`X + α·ΔX ⪰ 0 AND τ + α·Δτ ≥ 0 AND κ + α·Δκ ≥ 0`. The fact that `τ`
can shrink as `X` approaches the boundary is **precisely** what
avoids the boundary clamp. If you only check the cone part, you've
reinvented the non-HSDE solver and won't fix the hinf2 stall.

### 3.7 Don't drop the existing solvers

Keep `Solver.ts` (LP), `NtSdpSolver.ts` (SDP-NT), `AhoSdpSolver.ts`,
`SdpSolver.ts` (HKM) as-is. They remain valuable as A/B references
for the new HSDE solvers. The new solvers are **additive**, not
replacements. The corpus benches default to the HSDE versions; the
legacy versions stay reachable via `--method=`.

### 3.8 Verify with the diagnostic loop *every step*

Worklog 095's "instrument before fixing" principle is even more
load-bearing here. The HSDE iter trace has more moving parts (`τ`,
`κ`, `gfeas`, `prstatus`) than the non-HSDE one. **Add these to the
`VerboseIterLine` schema BEFORE writing the algorithm**, so when the
implementation stalls or diverges you can see why immediately.

Specifically, when porting the iter loop:

```sh
# Capture Mosek's trace on a small fixture (one of the corpus problems).
LD_LIBRARY_PATH=~/mosek/11.1/tools/platform/linux64x86/bin \
    ~/mosek/11.1/tools/platform/linux64x86/bin/mosek \
    -in ~/mosek/11.1/tools/examples/data/sdo1.cbf \
    > /tmp/mosek-sdo1.log

# Capture our trace.
IPM_TRACE_JSONL=/tmp/ours-sdo1.jsonl bun scripts/sdp-probe.ts \
    /tmp/sdo1-converted.dat-s --method=hsde-nt

# Diff iter-by-iter.
bun scripts/trace-diff.ts /tmp/mosek-sdo1.jsonl /tmp/ours-sdo1.jsonl
```

The trace diff should show the same `PFEAS`, `DFEAS`, `GFEAS`, `MU`
sequence within a few decades. If our trajectory diverges, the
algorithm has a bug — and the iter where it first diverges tells you
which one.

---

## 4. Local references and tooling

### 4.1 Code locations

- `packages/solver-ipm/src/solver/NtSdpSolver.ts` — current NT SDP
  solver. The boundary-clamp call site is `minBlockStep` (lines
  ~750). Best-iterate logic is `finalizeBestOr` (~470). Convergence
  test is the 6-flag block at ~150.
- `packages/solver-ipm/src/solver/Solver.ts` — current LP solver.
  `VerboseIterLine` schema is here (~50).
- `packages/solver-ipm/src/solver/LogFormat.ts` — `formatVerboseLine`.
  Extend with `tau`, `kappa`, `gfeas`, `prstatus` columns when
  Phase 0 lands.
- `packages/solver-ipm/src/solver/Status.ts` — wire-protocol status
  mapping. HSDE adds `infeasibility-certificate` mapping.
- `packages/solver-ipm/src/problem/{LpProblem,SdpProblem}.ts` — types.
- `scripts/sdp-probe.ts` — single-case driver. Add `hsde-nt` method.
- `scripts/trace-diff.ts` — JSONL diff harness. Already handles
  arbitrary fields; should work unmodified for HSDE.

### 4.2 Tooling

```sh
# Sanity check
bun test packages/solver-ipm/                # currently 68/68
bun tools/sdp-solve/tool.ts --test
bun run check:quick                          # ~5s
bun run check                                # ~25s (pre-commit gate)

# Diagnostic single-case
bun scripts/sdp-probe.ts <path.dat-s> [--method=hsde-nt|nt|aho|hkm]

# JSONL diff
IPM_TRACE_JSONL=/tmp/a.jsonl bun scripts/sdp-probe.ts case.dat-s
# ... edit ...
IPM_TRACE_JSONL=/tmp/b.jsonl bun scripts/sdp-probe.ts case.dat-s
bun scripts/trace-diff.ts /tmp/a.jsonl /tmp/b.jsonl

# Mosek comparison
LD_LIBRARY_PATH=~/mosek/11.1/tools/platform/linux64x86/bin \
    ~/mosek/11.1/tools/platform/linux64x86/bin/mosek \
    -in case.cbf > /tmp/mosek-case.log

# The corpus bench
cd ~/Projects/scientist-workbench-corpus
bun src/cli.ts grade scientist-workbench sdp-sdplib

# The wider 50-problem survey
/tmp/sdp-survey-venv/bin/python /tmp/sdp-survey/driver.py
/tmp/sdp-survey-venv/bin/python /tmp/sdp-survey/aggregate.py
cat /tmp/sdp-survey/calibration-table.md
```

### 4.3 The calibration survey (existing)

The 50-problem Mosek/COPT/SCS survey at `/tmp/sdp-survey/` is the
**ground-truth baseline** for what each solver achieves. When testing
your HSDE port, run it against this survey to see how it compares.
Target: pres column matching Mosek's within 1-2 decades on most
problems.

The driver `/tmp/sdp-survey/driver.py` can be adapted to run our TS
solver as a fourth column by wiring through `tools/sdp-solve` and
parsing the verbose JSONL. Recommended as a Phase 4 task.

---

## 5. What does "done" look like

A complete HSDE port lands these outcomes:

1. **`sdp-sdplib` bench: 6/6** at corpus's tightened gate (after Phase 4).
2. **hinf2 specifically: pres < 1e-9**, matching Mosek-class precision.
3. **No regression**: 68/68 existing solver-ipm tests pass; AHO/HKM/NT
   reference solvers untouched.
4. **Verbose trace** has `tau`, `kappa`, `gfeas`, `prstatus` columns
   and is JSONL-diffable against Mosek's iter log to within 1-2
   decades.
5. **ADR**: documented at `docs/adr/NNNN-hsde-for-solver-ipm.md`,
   citing ART03/And09/ECOS, explaining what stays and what changes.
6. **Worklog shard**: `docs/worklog/NNN-solver-ipm-hsde.md` with
   the Context → What changed → Why these choices → Frictions →
   Acceptance → Pointers structure.
7. **Handoff updated**: this document marked as superseded; new
   handoff (if needed) points at remaining work.

---

## 6. Estimated effort

- **Phase 0** (ADR + scaffold): 1 day
- **Phase 1** (HSDE LP): 3-5 days
- **Phase 2** (HSDE SDP NT): 3-5 days
- **Phase 3** (tool wiring): 1 day
- **Phase 4** (tighten bench tol): 1 day
- **Ground-truth reading**: 8-10 hrs (do this first)

**Total**: ~2 weeks for a clean port.

The CRITICAL prerequisite is the ground-truth reading. Skipping it
will result in an HSDE port that "looks right" but reproduces the
boundary-clamp issue because of a subtle sign/scaling error in the
τ-κ block. The previous handoff that proposed Ruiz was an exact
demonstration of what happens when you skip ground truth: 200-300 LOC
of work that wouldn't have fixed the problem.

---

## 7. Beads / commits

The work proposed here naturally decomposes into beads dependencies:

```
qmrv-hsde-0  (Phase 0: ADR + scaffold)
qmrv-hsde-1  (Phase 1: HSDE LP)              depends on -0
qmrv-hsde-2  (Phase 2: HSDE SDP NT)          depends on -1
qmrv-hsde-3  (Phase 3: tool wiring)          depends on -2
qmrv-hsde-4  (Phase 4: tighten bench tol)    depends on -3, stretch
```

Use `bd dep add` to wire these up. Update `qmrv` itself to reflect
the HSDE direction (it currently mentions Ruiz, which is **wrong** —
update the description).

The user's stated working preferences (per `bd memories two-principles`):
- **Decomposition discipline**: phase-gated, test-after-each.
- **Direct edits for mechanical work**, subagents only for
  parallelizable independent work.
- **Pause-and-commit on demand**: if the user says "commit", commit
  what's solid even if the work isn't done.
- **Honest scope**: HSDE is the work; do not bundle in Ruiz, Schur
  refactor, AHO/HKM modernization, or other peripheral changes.

Good hunting.
