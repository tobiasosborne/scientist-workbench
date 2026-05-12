# SDPLIB stress test — 2026-05-12 findings

Bead `jb1x`. First broad run of `tools/sdp-solve` across SDPLIB at
`m ≤ 500` filter; 65 cases × 2 methods (`nt` legacy default, `hsde-nt`
Phase 3 new lane) = 130 runs scheduled. 122 completed before suite
termination on case 123 (mcp500-2 nt); the missing 8 are all
`m=500, n=500` cases that would have timed out anyway. Per-case
verbose JSONL traces under `scripts/sdplib-stress-traces/`
(gitignored); summary in `scripts/sdplib-stress-results.csv`.

**Reproduce:**
```sh
# Tarball lives at http://euler.nmt.edu/~brian/sdplib/sdplib.tar.gz (~13MB).
# Extract to $SDPLIB_DIR; the script discovers .dat-s files automatically.
SDPLIB_DIR=/tmp/sdplib/sdplib M_CAP=500 TIMEOUT_MS=90000 \
  RESULTS_CSV=scripts/sdplib-stress-results.csv \
  TRACES_DIR=scripts/sdplib-stress-traces \
  bun scripts/sdplib-stress.ts
```

## Headline numbers

```
122 (case, method) runs across 61 distinct cases:
  optimal:      89   (46 nt + 43 hsde-nt)
  timeout:      33   (15 nt + 18 hsde-nt)
```

Among the 89 `optimal` rows:

```
ap ≤ 1e-6     35   (mostly nt path; the corpus-tight cases)
1e-6 < ap ≤ 1e-3   28
ap > 1e-3     26   (hinf-class precision floor + 4 infeasibility-misclassification cases)
```

## Three signals worth acting on

### 1. HSDE-NT systematically beats NT on the hinf-class precision floor

The headline part-2-handoff prediction holds at scale. On the hinf*
cases (the SDPLIB problems most prone to dual-feasible-equivalent
exits per worklog 095's `|y|_∞=567` analysis on hinf2), HSDE-NT
delivers 1–4 orders of magnitude better `achieved_precision` than
legacy NT, *without* iterative refinement yet. Examples (ratio =
hsde_ap / nt_ap, < 1 = HSDE wins):

| case   | nt ap   | hsde-nt ap | ratio  |
|--------|---------|------------|--------|
| hinf1  | 2.5e-4  | 7.7e-7     | 0.003  |
| hinf2  | 5.2e-4  | 9.7e-7     | 0.002  |
| hinf6  | 1.9e-1  | 8.3e-5     | 0.0004 |
| hinf12 | 5.1e+0  | 4.6e-4     | 0.0001 |
| qap6   | 6.1e-3  | 4.0e-7     | 0.0001 |
| control4 | 2.9e-6 | 3.7e-7    | 0.13   |
| control5 | 9.1e-6 | 5.3e-7    | 0.06   |

**Phase 5 IR should make these tight to 1e-9** per the handoff
target. Even without IR, HSDE-NT already pulls hinf6 from 0.19
down to 8e-5, hinf12 from 5.1 down to 5e-4.

### 2. Infeasibility detection is broken on both methods (filed bead `<TBD>`)

All four explicitly-infeasible SDPLIB cases (`infp1`, `infp2`,
`infd1`, `infd2`) return `status="optimal"` with `ap` in the
**1e+1–1e+5** range:

```
case   nt: status / iter / ap         hsde-nt: status / iter / ap
infp1  optimal / 2 / 1.5e+5           optimal / 8 / 3.6e+0
infp2  optimal / 2 / 1.1e+5           optimal / 8 / 9.6e+0
infd1  optimal / 2 / 2.2e+4           optimal / 1 / 4.7e+1
infd2  optimal / 2 / 1.1e+4           optimal / 2 / 9.2e+1
```

The substrate's solver-state machine is reporting "optimal" because
the inner KKT residuals satisfied the convergence test for the
*embedded* problem (after dual regularisation moved the constraint
set), but the wire-frame primal/dual residuals are huge — the tool
should be reporting `status="infeasible"` (NT) or surfacing τ → 0 /
κ > 0 (HSDE) and refusing to claim optimality. The honest-scope
rule (Rule 8) is being violated. A separate bead will track this.

### 3. The scale ceiling is at roughly m·n ≈ 30k

All `m≥250, n≥250` cases hit the 90s timeout: `arch*`, `mcp250-*`,
`gpp250-*`, `mcp500-*`, `theta3`, `control6`. The dense Schur
Cholesky `O(m³)` plus assembly `O(m²·n²)` dominate, and Bun's
single-threaded `Float64Array` ops top out near 1-2 Gflops in
practice. To handle these we need:

- Sparse Schur (the constraint matrix `A` is typically very
  sparse — `mcp*` constraints are pure 2-variable equalities;
  `theta*` is structure-rich), and/or
- Block-Cholesky exploiting per-block structure, and/or
- `@workbench/bigfloat` substrate for the precision-critical
  small problems (Phase 6 in the handoff numbering).

Out of scope for the stress test; worth a bead if not already
filed under the `eg9j` epic.

## Per-method runtime

Median wall-clock per (case, method) on cases that completed:

```
nt:       0.3s small, 10-30s medium (m ~ 100), 30-90s large (m ~ 200-500)
hsde-nt:  similar profile; the HSDE iteration is ~10-30% slower per iter
          due to the dual back-sub for the data direction
```

The HSDE-NT slowdown is the expected three-back-substitution cost
(data dir, affine dir, combined dir) per iter — versus NT's two
(affine, combined). Worth the ~25% wall-time premium for the
precision gain demonstrated above.

## Pointers

- Script: `scripts/sdplib-stress.ts`
- CSV: `scripts/sdplib-stress-results.csv`
- Per-case JSONL traces: `scripts/sdplib-stress-traces/<case>.<method>.jsonl` (gitignored)
- Tarball source: http://euler.nmt.edu/~brian/sdplib/sdplib.tar.gz (Borchers 1999)
- Bead: `jb1x` (close after committing this run)
