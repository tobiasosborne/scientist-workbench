# Handoff — solver-ipm SDP convergence: final 1/6 (hinf2) via Ruiz equilibration (bead `qmrv`)

> **SUPERSEDED — 2026-05-16.** The "Ruiz equilibration as the hinf2 fix"
> diagnosis below was **wrong** — it didn't address the actual cause
> (boundary-clamp `αP → 0` in the non-HSDE primal-dual iterate space).
> The correct path was HSDE (Andersen-Roos-Terlaky 2003), documented
> in `docs/HANDOFF_solver_ipm_hsde.md` (also superseded) and shipped
> across Phases 0-2 + Phase 5 Tiers 0-4 (worklogs 106 / 110 / 128 / 129).
> Final outcome: 5/6 cases, 64/66 invariants — `hinf2 optimality_gap`
> flips to pass via Tier 1 IR; the remaining 2 hinf2 invariants
> (`primal_feasibility`, `complementary_slackness`) are a Phase 6
> (bigfloat) gate per worklog 128's τ-shrinkage diagnosis. The Ruiz
> handoff is preserved below as a CLAUDE.md Rule 2 ("all bugs are deep")
> cautionary tale: a fix that addresses a symptom (large `|y|`) without
> investigating the cause produces 200 LOC that doesn't help.
>
> ---
>
> **Original state (at commit `9172b16`):** `sdp-sdplib` corpus bench is **5/6**.
> control1, control2, control3, theta1, mcp100 all pass; hinf2 is the
> remaining holdout. Bench was 3/6 before the work in worklog
> 095 (verbose iter-trace + COPT-aligned termination + best-iterate
> tracking in the NT SDP solver). This document is the playbook for
> closing that last 1/6 and any follow-on SDP work.
>
> **Read order:**
> 1. This document end-to-end (15 min).
> 2. Worklog shard 095 (`docs/worklog/095-solver-ipm-verbose-trace-and-termination.md`) — what shipped, why, and the frictions encountered (30 min).
> 3. The verbose trace tooling — try `bun scripts/sdp-probe.ts ~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s` and read the streamed output. That's the diagnostic loop you'll be living inside (5 min).
> 4. `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/CLEANROOM_SPEC.md §9` (Ruiz scaling) and `analysis/decomps/006ec3f0_FUN_006ec3f0.c` (the COPT decomp of Ruiz, 1636 lines of vectorised C) (60 min).
> 5. `bd show scientist-workbench-qmrv` for the live bead state.
>
> The COPT-decomp directory at `/home/tobias/Dropbox/Projects/Computers/LLM/COPT-decomp` is **ground-truth-ish**. The user has explicitly authorised direct use of COPT IP for this private-research port (`HANDOFF.md §0` in that tree). Prefer fidelity to the decomps when spec and decomps disagree on *numerical tuning*; prefer the spec when they disagree on *architecture*.

---

## 0. What you're inheriting (state at commit `9172b16`)

- **68/68 `packages/solver-ipm` tests pass.**
- `tools/lp-solve --test` and `tools/sdp-solve --test` smokes pass.
- `bun run check` is green.
- **`sdp-sdplib` corpus grade: 5/6.** Only `hinf2` fails — and it fails on three invariants (`primal_feasibility`, `complementary_slackness`, `optimality_gap`), all rooted in one structural issue (next section).
- **Diagnostic loop is in place:**
  - `scripts/sdp-probe.ts` — single-case `.dat-s` driver with verbose stderr stream.
  - `scripts/trace-diff.ts` — JSONL trace diff with verifier-relevant defaults.
  - `scripts/copt-log-to-jsonl.ts` — converts COPT iter logs into the same schema.
  - `scripts/solver-ipm-bench.ts` — microbench for hot ops.
  - COPT oracle captures under `docs/oracles/copt-sdpmethod0/` for `control2/3/hinf2`.
- **NT termination is COPT-aligned:** 6-flag decision tree, best-iterate snapshot, `dual-feasible` soft-success wire-mapped to `optimal`. AHO and HKM still use the legacy stall-as-failure logic (intentional — they're A/B reference solvers; not on the critical path).
- **SDP solvers still use the legacy single-tier (`gap`-only) Cholesky retry.** The shared `factorWith3Way` helper exists for LP but the SDP path hasn't been wired through it. This was Phase 1 of the previous handoff; it's been **deprioritised** because the 5/6 fix didn't need it. It's still worth doing for code unification, but it does NOT close hinf2.

---

## 1. The hinf2 failure mode (precise diagnosis)

The new verbose trace localised this in 15 minutes. The pattern is
reproducible — drive `bun scripts/sdp-probe.ts
~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s`
and read the last 30 iters.

**The data is well-balanced:**

- `|b|_∞ = 1` (only entry: `b[0] = -1`)
- `|A_i|_F ∈ [1.03, 2.24]` for all 13 constraints (all O(1))
- `|C|_F = 2.63`

**But the dual variable explodes:**

- `|y|_∞ ≈ 567` at convergence (vs. control2 where |y| is O(1))

**Trajectory:** the IPM makes good progress through iter ~15:
`μ → 3e-5`, `r_p → 2e-6`, `r_d → 1e-8`. Around iter 16 the
Newton direction wants a primal step that would push some X
block's λ_min through zero — the boundary-clamp safeguard
(`minBlockStep`) returns `αP=0.001`, effectively zero. From iter
17 onward, `αP=0` is locked. Dual side keeps tightening
(`r_d → 1e-14`, `μ → 5e-9`). But primal stays frozen at
`r_p ≈ 2.91e-7` indefinitely.

**Why this becomes a verifier failure.** Strong duality with
primal feasibility says `cᵀx - bᵀy = ⟨S, X⟩ - yᵀ·r_p`. With our
final iterate:

```
⟨S, X⟩ ≈ n·μ  =  16 × 5e-9   = 8e-8       (well-converged)
yᵀ·r_p ≈ |y|_∞ · r_p ≈ 567 × 2.9e-7 ≈ 1.6e-4   (huge)
gap    ≈ 1.6e-4
```

The verifier wants `gap ≤ 1.1e-6` (= `1e-7 × |cᵀx|` for `|cᵀx|≈10.97`)
and `r_p ≤ 1e-7`. To satisfy both **simultaneously** we'd need:

```
r_p ≤ 1.1e-6 / |y|_∞  ≈ 1.1e-6 / 567 ≈ 2e-9
```

— three decades tighter than the boundary-clamp limit allows.

**Confirmed-with-experiment:** even at `iterLimit=200, feasTol=1e-12`,
the best `r_p` ever achieved across the whole trajectory is `2.88e-7`
at iter 34. The boundary geometry is the hard wall, not the
iteration count.

**Naive row-equilibration won't help.** `|A_i|_F ≈ 1` for all
constraints; dividing by row norms is essentially identity. The
`|y|` blow-up is structural to the problem geometry (hinf2 is
H-infinity control, which has dual variables proportional to
controller gains — naturally large), not the input scaling.

## 2. The fix: SDP-aware Ruiz equilibration

### 2.1 What standard (LP-style) Ruiz does

From `CLEANROOM_SPEC.md §9`:

```
for sweep in 0..5:
  for each row i of A: A[i] *= 1 / sqrt(||A[i]||_∞)
  for each column j of A: A[:,j] *= 1 / sqrt(||A[:,j]||_∞)
  # Apply the row/column scaling to b, C, X, S correspondingly.
```

For SDP rows the spec says use `||A_i||_F` instead of `||A_i||_∞`.

### 2.2 Why standard Ruiz alone doesn't fix hinf2

Row scaling A_i by `s_i = 1/sqrt(||A_i||_F)` changes (A_i, b_i) →
(A_i · s_i, b_i · s_i). Dual: y_i_scaled = y_i_orig / s_i. For
hinf2 where `||A_i||_F ≈ 1`, s_i ≈ 1, so y is unchanged. **The
binding constraint must be reduced via column-side scaling, i.e.,
a similarity transform of the cone variable itself.**

### 2.3 Cone-side (column) scaling for SDP

For LP, "column j of A" scales by `1/sqrt(||A[:,j]||_∞)` and
correspondingly scales `x_j ← x_j · scale_j`, `s_j ← s_j /
scale_j`, `c_j ← c_j · scale_j`. The dual variable y is unaffected
by column scaling (it only multiplies rows).

For SDP, the analog is a **block-wise similarity transform**:
choose a diagonal positive `D_b` per PSD block, then:

```
X_b      ← D_b · X_b · D_b           (the new variable)
S_b      ← D_b^{-1} · S_b · D_b^{-1} (preserves <X_b, S_b>)
A_i^b    ← D_b^{-1} · A_i^b · D_b^{-1}   (since <A, X> is invariant)
C_b      ← D_b^{-1} · C_b · D_b^{-1}
```

In the new variables the problem is `<A_i^b_new, X_b_new> = b_i`
(same b; rows unchanged), `min <C_b_new, X_b_new>`. Dual y stays
the same shape; dual slack S follows the similarity transform.

**Why this helps hinf2.** A judicious choice of D_b can reduce
the "effective scale mismatch" between block elements that
generates large y. Concretely, if some entries of A_i^b are tiny
and others are O(1) (which often happens for control-LMI
constraints), normalising the block elements to comparable scale
via D_b reduces the dynamic range of the constraint matrix and,
empirically for hinf2-class problems, the magnitude of y at the
optimum.

### 2.4 The specific choice of D_b

Empirical choice (used by SDPT3 and others): for each block b,

```
D_b_jj = 1 / sqrt(maximum |X_b_jj| across all A_i^b and C_b)
```

i.e., row-j and column-j of the symmetric block, take the max
absolute value across all A_i^b and C_b entries with at least one
index = j. Then D_b is diagonal positive. Repeat the full
row-then-column sweep 5 times. The fixed point is a stationary
scaling.

For hinf2 with 3 blocks of size 5, 5, 6: this is just 16
diagonal scaling factors per block, computed in one O(m·n²) pass.

### 2.5 Unscaling

After the IPM solves the scaled problem:

```
X_b_orig = D_b^{-1} · X_b_scaled · D_b^{-1}
S_b_orig = D_b · S_b_scaled · D_b
y_orig   = y_scaled                          (unchanged)
```

The objective: `<C_b_orig, X_b_orig> = <D_b·C_b_scaled·D_b, D_b^{-1}·X_b_scaled·D_b^{-1}> = <C_b_scaled, X_b_scaled>`.
So objective is invariant. Returned `x` (the wire-encoded svec'd
X) must use `X_b_orig`.

The verifier's invariants (`primal_feasibility`, `complementary_slackness`,
`optimality_gap`) run on the **unscaled** wire vectors. Pass-or-fail
is determined by whether the unscaled iterate satisfies the
1e-7 KKT bounds — which it will, because in the scaled problem y
is smaller, so `yᵀ·r_p` in the unscaled formula is smaller too.

## 3. Implementation playbook

Estimated effort: ~200-300 LOC including symmetric tests, given
the SDP cone-aware similarity transform is more involved than
the LP-side spec text suggests.

### Step 1 — New module `packages/solver-ipm/src/solver/Ruiz.ts`

Pure function `equilibrate(prob: SdpProblem, sweeps = 5):
{ scaled: SdpProblem; D: Float64Array[]; rowScale: Float64Array }`.
Compute the per-block diagonal D_b and the per-row factor.
Return the scaled SdpProblem + the scalings needed to unscale.

`prob.b` is row-scaled but `prob.A[i]` and `prob.C` are
block-similarity-transformed using the D_b. Track both in the
return value.

### Step 2 — Wire into `solveSdpNt`

In `NtSdpSolver.ts:solveSdpNt`:

```ts
const { scaled, D, rowScale } = equilibrate(prob);
// run IPM on `scaled` (which has the structure of the existing
// SdpProblem — drop-in replacement)
// At the end:
const X_orig = unscaleX(X_scaled, D);
const S_orig = unscaleS(S_scaled, D);
const y_orig = unscaleY(y_scaled, rowScale);
// Recompute pObj, dObj, pInf, dInf in the unscaled frame for
// the returned record.
```

### Step 3 — Best-iterate unscaling

The `bestX`/`bestS`/`bestY` snapshots live in the **scaled**
frame during the iter loop. The `finalizeBestOr` helper must
unscale them when assembling the returned `SdpSolveResult`.
Otherwise the verifier sees the scaled iterate, which has wrong
units.

### Step 4 — Tests

Add a `packages/solver-ipm/test/ruiz.test.ts` that:

- Verifies `equilibrate` is idempotent after 1 sweep (it should
  converge to a fixed point within 5 sweeps; sweep 6 should be a
  no-op).
- Verifies the round-trip identity: solving the scaled problem
  and unscaling yields the same `pObj`, `<C, X>`, `<X, S>` as
  solving the unscaled problem (modulo IPM convergence noise).
- Acceptance: the `--test` smoke continues to pass on the 2×2
  trace-equality problem; sdp.dat-s still converges to 30 in
  ~7-8 iters.

### Step 5 — Verify hinf2

After implementation:

```sh
IPM_TRACE_JSONL=/tmp/hinf2-ruiz.jsonl bun scripts/sdp-probe.ts \
    ~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s
bun scripts/trace-diff.ts docs/oracles/copt-sdpmethod0/hinf2.copt.jsonl /tmp/hinf2-ruiz.jsonl
```

The trace should show `|y|_∞` (read off the `bestDualInf` /
`alphaDual` patterns — or add `yInfNorm` to the verbose schema)
substantially smaller than 567, primalInf reaching 1e-9 or
better, and gap proportionally smaller. Then:

```sh
cd ~/Projects/scientist-workbench-corpus
bun src/cli.ts grade scientist-workbench sdp-sdplib
# expect 6/6
```

### Step 6 — Apply to AHO + HKM (optional)

For symmetry, port `equilibrate` into `AhoSdpSolver.ts` and
`SdpSolver.ts`. Not required for the bench (NT is the default),
but reasonable for completeness.

## 4. The diagnostic loop (use this!)

Worklog 095 §"Why instrument before fixing" explains in detail.
The short version:

**Don't enter the algorithm before you can see what it's doing.**
The previous handoff named candidate fixes (σ-clip, tighter
Cholesky reg, init-point heuristics) but didn't say which would
help — and none of them moved the grade when applied without
instrumentation. The verbose trace turned hinf2's failure into a
**read-the-stderr-stream** diagnosis in minutes.

For Ruiz work specifically, the workflow is:

```sh
# 1. Capture baseline (current 5/6 state).
IPM_TRACE_JSONL=/tmp/hinf2-pre.jsonl bun scripts/sdp-probe.ts \
    ~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s

# 2. Edit equilibration code. Run again with new trace path.
IPM_TRACE_JSONL=/tmp/hinf2-post.jsonl bun scripts/sdp-probe.ts \
    ~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/hinf2.dat-s

# 3. Diff against COPT oracle (the gold-standard trajectory).
bun scripts/trace-diff.ts docs/oracles/copt-sdpmethod0/hinf2.copt.jsonl /tmp/hinf2-post.jsonl

# 4. Spot-check no regression on other cases.
for c in control1 control2 control3 theta1 mcp100; do
  bun scripts/sdp-probe.ts \
    ~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/${c}.dat-s | head -1
done

# 5. Run the full grade.
cd ~/Projects/scientist-workbench-corpus && \
  bun src/cli.ts grade scientist-workbench sdp-sdplib
```

The verbose stderr stream shows σ, αP, αD, μ, primalInf, gap,
regularisation bumps, Schur-diag range, eig proxies, phase
timings — all per iter. The pattern of `αP=0` locked late tells
you the boundary-clamp is binding; the `Mdiag` range tells you
about conditioning; the reg bumps tell you about Schur factor
health.

For regression-checking edits: `trace-diff.ts` defaults to
excluding timing fields (wall-clock noise) and reports first
divergence with `Δ` magnitude — so "did my edit change the
trajectory?" is one command.

## 5. Out of scope (other open work on bead `qmrv`)

These were on the previous handoff's task list and remain
follow-ups; they are *not* required for hinf2 but are worth
attention for code health.

### Phase 1 (previous handoff) — wire SDP through `factorWith3Way`

The shared 3-way Tikhonov helper at `packages/solver-ipm/src/solver/Regularization.ts` is wired into LP but not SDP. The SDP solvers each maintain their own legacy Cholesky retry loops, instrumented to update the shared `RegState` shape (so the verbose trace is uniform) but not actually using the helper.

Why deprioritised: the 5/6 fix didn't need it. The legacy retry is fine on the passing cases. Wiring through `factorWith3Way` is code unification, not algorithmic improvement, and would introduce diff noise that obscures the Ruiz work.

When to do it: after Ruiz lands. The verbose trace + COPT JSONL diff harness makes Phase 1 a low-risk refactor — if the trace stays byte-identical, the swap is clean.

### LP NETLIB `brandy` (bead `j1gd`)

Separate from `qmrv`. The verbose trace surfaced `Mdiag=[0.00e+0, 1e+18]` — Schur diagonal min is zero throughout, meaning constraint rows have zero column-d ratio for active columns. The classic LP-on-degenerate-vertex pathology. Documented in `KNOWN_CONVERGENCE_GAPS` test carve-out. Worth a focused session with the same diagnostic loop.

### Test carve-outs

- `KNOWN_CONVERGENCE_GAPS = {brandy}` in `packages/solver-ipm/test/netlib.test.ts`
- `KNOWN_SUBSTRATE_GAPS = {H_malformed_cone, H_non_finite_input}` in `lp-small.test.ts`
- `F_infeasible_3var_sum` carve-out in `lp-small.test.ts`

All three are LP-side. They survive the current 5/6 SDP fix because the SDP changes are isolated to `NtSdpSolver.ts` + `Status.ts`. None of them block hinf2.

## 6. Gotchas (from worklog 095's Frictions section)

### `KNOWN_CONVERGENCE_GAPS` masks issues

`brandy` is flagged with looser tolerance in the package tests (rel err ≤ 1e-4), so the test suite stays green despite genuine numerical-error returns. The trace surfaced this. Don't trust test pass alone; sample-run via `sdp-probe.ts` on a few cases when making changes.

### Wire-protocol vs dat-s-loader trajectories differ

`scripts/sdp-probe.ts` uses `parseSdpaSparse + convertSdpaToSdp` (the dat-s loader). The corpus's `run-candidate.ts` uses the value-protocol wire (svec'd vectors + cone indices) which is reconstructed into `SdpProblem` by the tool's `buildSdpProblem`. **The √2 off-diagonal svec scaling propagates into A_i and C, giving a subtly different problem.** Same algorithm, same convergence pattern, different iter counts and best-iter selection.

For hinf2: 58 iters via the tool path vs 40 via the dat-s path; different best iter; same eventual failure. **Match the path to the harness.** If you're targeting the corpus grade, use `run-candidate.ts` to validate; if you're iterating fast, `sdp-probe.ts` is the lower-overhead loop.

### First-pass best-iterate forgot the Cholesky-failure exit

If you add a new termination path or modify Cholesky retry, **route through `finalizeBestOr`, not `finalize` directly.** The pattern is "any non-optimal exit returns the best snapshot if we have one." Three call sites in NT: `buildNtFactor` returns null; Cholesky retry exhausted; the post-loop `iter-limit` return. All three call `finalizeBestOr`.

### `dual-feasible` → wire `optimal` is the right call, not a hack

The wire taxonomy is the corpus gate. Returning `numerical-breakdown` when we have a verifier-passing iterate is dishonest scope (Rule 8 in CLAUDE.md). The honest channel is `achieved_precision`. If the iterate is loose, the invariant fails and the case fails. If it's tight, all four invariants pass. The wire status is the cheap flag; achieved precision is the truth.

### COPT decomp uses `param_1[+0xc2]` to count "α < 0.05" stalls

Worth reading: `IPM_LOOP_CHEATSHEET.md §4`. COPT's stall counter is incremented when the **combined step length** drops below 0.05 — that's a different criterion than our "μ progress < 1%" stall. For hinf2 both fire at roughly the same iter (since `αP=0` ⇒ μ stops progressing). For other problems they could diverge. Worth aligning to COPT's criterion as part of broader convergence work; not required for Ruiz.

## 7. Useful commands

```sh
# Sanity-check current state
bun test packages/solver-ipm/                # 68/68 should pass
bun tools/sdp-solve/tool.ts --test           # smoke pass
bun run check:quick                          # ~5s; pre-edit gate

# Diagnostic single-case loop
bun scripts/sdp-probe.ts <path.dat-s> [--method=nt|aho|hkm]

# Mechanical regression check
IPM_TRACE_JSONL=/tmp/a.jsonl bun scripts/sdp-probe.ts case.dat-s
# ... edit ...
IPM_TRACE_JSONL=/tmp/b.jsonl bun scripts/sdp-probe.ts case.dat-s
bun scripts/trace-diff.ts /tmp/a.jsonl /tmp/b.jsonl

# Compare against COPT oracle
bun scripts/trace-diff.ts \
    docs/oracles/copt-sdpmethod0/hinf2.copt.jsonl \
    /tmp/ts-hinf2.jsonl --rtol=1e-2

# Microbench (hot-op perf baseline)
bun scripts/solver-ipm-bench.ts

# The grade
cd ~/Projects/scientist-workbench-corpus && \
    bun src/cli.ts grade scientist-workbench sdp-sdplib
```

## 8. Pointers

### Code locations

- `packages/solver-ipm/src/solver/NtSdpSolver.ts` — NT IPM with COPT-aligned termination, best-iterate, verbose emission. Where Ruiz wiring lands (in `solveSdpNt` before the iter loop; unscale in `finalizeBestOr`).
- `packages/solver-ipm/src/solver/Solver.ts` — `VerboseIterLine` schema; LP path. Keep schema stable for cross-impl diff.
- `packages/solver-ipm/src/solver/LogFormat.ts` — `formatVerboseLine`. Add fields here if you extend the schema.
- `packages/solver-ipm/src/solver/Status.ts` — wire mapping. `dual-feasible` → `optimal` here.
- `packages/solver-ipm/src/solver/Regularization.ts` — `factorWith3Way` (LP-only). For Phase 1 work.
- `packages/solver-ipm/src/problem/SdpProblem.ts` — `SdpProblem` type. Ruiz module reads this.
- `tools/sdp-solve/tool.ts` — value-protocol wrapping. `makeVerboseHook` at the bottom.
- `scripts/sdp-probe.ts` — the iteration loop for this work.

### Documentation

- `docs/worklog/095-solver-ipm-verbose-trace-and-termination.md` — what shipped, how, why.
- `docs/worklog/094-sdp-solve-and-corpus-bench.md` — where the 3/6 → 6/6 journey started.
- `docs/HANDOFF_solver_ipm_qmrv.md` — this document.
- `docs/oracles/copt-sdpmethod0/README.md` — how the oracle captures were made.

### COPT decomp references

- `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/CLEANROOM_SPEC.md §9` — Ruiz pseudocode.
- `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/decomps/006ec3f0_FUN_006ec3f0.c` — 1636 lines of COPT's Ruiz, vectorised. Most of the length is AVX bookkeeping; the algorithm fits in ~100 lines.
- `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/IPM_LOOP_CHEATSHEET.md §1` — solver state struct offsets. The scaling factors live at offset `+0xc0` (per the field "lp_ws sub-struct"), useful if you want to match COPT's bookkeeping exactly.
- `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/PD_IPM_DEEP.md` — overall IPM architecture.

### Commits

- `a3241a6` — verbose iter-trace pipeline + COPT oracle infra.
- `9172b16` — COPT-aligned termination + best-iterate (3/6 → 5/6).

### Beads

- `qmrv` — open. Scope: hinf2 + SDP Ruiz. control2/3 closed inside.
- `j1gd` — open. LP brandy. Separate but related (same diagnostic loop applies).

## 9. The user's working style (worth knowing)

- **Verbose tests with eager flush** are the preferred diagnostic loop. The verbose-trace pipeline is the canonical instance of this principle. Use it before changing algebra.
- **TaskCreate is preferred over beads-only tracking** for in-session work (user override). Use both: TaskCreate for granular execution, beads for cross-session continuity.
- **Pause-and-commit on demand.** When the user says "commit", commit what's solid even if the work isn't done. Carve-outs and TODOs are acceptable.
- **The user is the TS expert this code targets.** The two-principles memory is the authoritative framing (`bd memories two-principles`). Code that requires explanation in a comment to feel right is probably wrong.
- **The COPT decomp is private research the user has authorised.** Use it. Don't re-derive from scratch what the decomps already settle.
- **Don't over-decompose with subagents.** When a fix is mechanical and the principles are clear, just do the work. Subagents are for genuinely parallel independent work and contested-design research (CLAUDE.md Rule 4).

Good hunting.
