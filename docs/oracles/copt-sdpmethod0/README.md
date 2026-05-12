# COPT 8.0.4 oracle captures — `SDPMethod 0` on the failing SDPLIB-3

Reference iteration logs from COPT 8.0.4 (build date 20260424) running the
**default primal-dual SDP method** (`SDPMethod 0`) on `control2`, `control3`,
and `hinf2` from SDPLIB. Captured 2026-05-12 in service of the
`@workbench/solver-ipm` convergence work (bead `qmrv`).

## What's here

| File | Contents |
|---|---|
| `<case>.cmd` | COPT script. Reads the `.dat-s` from `scientist-workbench-corpus`, sets `Logging 2`, runs the default primal-dual SDP method. |
| `<case>.log` | Raw COPT stdout/stderr (gitignored — regenerate via the `.cmd`). |
| `<case>.copt.jsonl` | Parsed iter log in the `VerboseIterLine` schema. Fields COPT doesn't expose are `null`. |

## How to regenerate

```sh
LD_LIBRARY_PATH=$HOME/Dropbox/Projects/Computers/LLM/COPT-decomp/copt/copt80/lib \
    $HOME/Dropbox/Projects/Computers/LLM/COPT-decomp/copt/copt80/bin/copt_cmd \
    -i docs/oracles/copt-sdpmethod0/control2.cmd \
    > docs/oracles/copt-sdpmethod0/control2.log 2>&1

bun scripts/copt-log-to-jsonl.ts \
    docs/oracles/copt-sdpmethod0/control2.log \
    docs/oracles/copt-sdpmethod0/control2.copt.jsonl
```

## Convergence summary at capture time

| Case | COPT iters | COPT obj | TS NT iters | TS status | TS obj |
|---|---|---|---|---|---|
| control2 | 19 | 8.30001 | 68 | numerical-difficulty | 8.30000 |
| control3 | 21 | 13.6333 | 68 | numerical-difficulty | 13.6333 |
| hinf2 | 18 | 10.9673 | 500 | iter-limit | 10.9676 |

Both COPT and TS land on essentially the same objective. The gap is in
**termination**: COPT terminates at `Primal infeasibility ≈ 1e-7-1e-8`
rel (DIMACS errors ~1e-6); TS demands strict `feasTol = 1e-8` on both
primal and dual and stalls at the optimal face where one block's λ_min
hits the boundary and primal step length clamps to 0.

See the TS verbose trace via `scripts/sdp-probe.ts` for the per-iter
trajectory; diff against `<case>.copt.jsonl` via `scripts/trace-diff.ts`.

## Algorithmic implications

The TS trace surfaces a clean failure mode: at the optimal face,
`alphaPrimal → 0` because the Newton direction would push X out of the
PSD cone, but `feasTol = 1e-8` strict can't be satisfied with the
current iterate. Candidate fixes (per the handoff):

1. **Best-iterate tracking** — return the tightest-feasible historical
   iterate rather than the current stalled one (`IPM_LOOP_CHEATSHEET.md
   §2 step 9`).
2. **DIMACS-style termination** — accept primalInf and dualInf rel
   tolerances of ~1e-6, matching COPT's effective stopping criterion.

Neither is in Phase 1 of the handoff (which wires SDP through
`factorWith3Way`). Phase 1 is orthogonal — it won't fix this endgame
issue but also won't make it worse, because the failure is
**post-Cholesky** (step-length clamp), not Cholesky itself.
