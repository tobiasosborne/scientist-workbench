# Handoff — solver-ipm convergence hardening (bead `qmrv`)

> **Read order:**
> 1. This document (10 min).
> 2. `~/Dropbox/Projects/Computers/LLM/COPT-decomp/HANDOFF.md` + `HANDOFF_NEXT.md` + `HANDOFF_SDP_FIDELITY.md` + `HANDOFF_SPEC_ALIGN.md` (45 min).
>    The IPM in `@workbench/solver-ipm` is a reverse-engineered port of COPT's `FUN_00732a50`. Those handoffs are the original mission brief and IP context.
> 3. `~/Dropbox/Projects/Computers/LLM/COPT-decomp/analysis/CLEANROOM_SPEC.md` (the spec the port is converging on) and `analysis/PD_IPM_DEEP.md` + `analysis/IPM_LOOP_CHEATSHEET.md` (the decomp's deep analysis).
> 4. Worklog shard 094 (`docs/worklog/094-sdp-solve-and-corpus-bench.md`) — where the convergence gap was first surfaced.
> 5. `bd show scientist-workbench-qmrv` and `bd show scientist-workbench-j1gd` — the live bead state.
>
> The COPT-decomp directory is **ground-truth-ish**. The user has explicitly authorized direct use of COPT IP for this private-research port (HANDOFF.md §0). Prefer fidelity to the decomps when spec and decomps disagree on *numerical tuning*; prefer the spec when they disagree on *architecture* (HANDOFF_SPEC_ALIGN.md §3).

---

## 0. What you're inheriting (state at commit `441b66d`)

- **68/68 `packages/solver-ipm` tests pass.**
- `tools/lp-solve --test` and `tools/sdp-solve --test` smokes pass.
- Wave-1 spec-alignment fixes are in. Shared 3-way Tikhonov regularization helper exists at `packages/solver-ipm/src/solver/Regularization.ts` and the LP path is wired through it.
- **SDP solvers (NT/AHO/HKM) still use the legacy single-jitter Cholesky retry** — they have not been wired through the new helper yet. That's the headline next step.
- **3 SDPLIB cases still fail on the corpus bench:** `control2`, `control3`, `hinf2`. Bench grade is **3/6** on `sdp-sdplib` (corpus side), unchanged from before this work.
- **1 LP case carved out:** `F_infeasible_3var_sum` in `lp-small`. Carve-out is in `packages/solver-ipm/test/lp-small.test.ts` with prose explaining the regression.
- **Tasks `#1-7` completed; `#4`, `#8`, `#9` partially done; `#10-13` pending.** Use `TaskList` to see the live state.

---

## 1. What got done

| Task | What | File:line |
|---|---|---|
| #1 | Regularization caps: `cap_d`, `cap_g` to spec §6.4 `1e+2` | `solver-ipm/src/solver/Defaults.ts:22-37` |
| #2 | σ-clip `[1e-8, 0.9]` in AHO/HKM. **LP kept at [0, 1]** (Farkas-direction issue, see §3) | `AhoSdpSolver.ts:141`, `SdpSolver.ts:150` |
| #3 | Stall threshold `0.99` in AHO/HKM/LP (NT was already correct) | three files |
| #5 | NT predictor: `-X` directly, not `gtDiagG` reconstruction. **Single biggest standalone numerical win**. Decomp confirms COPT's Branch-B SDP variable update reads X directly | `NtSdpSolver.ts:280-300` |
| #6 | Separate ξ_p / ξ_d per spec §3.1 in all three SDP solvers | three files |
| #7 | Removed `stallIterCap: 30` tool-level band-aid (substrate default 10 now correct) | `tools/sdp-solve/tool.ts:894` |
| #8 partial | New `Regularization.ts` shared helper with `factorWith3Way`, `makeLpDiagnose`, `makeSdpDiagnose`, `gapOnlyDiagnose`. LP path wired through it. **SDP path NOT yet wired.** | `solver-ipm/src/solver/Regularization.ts` (new) |
| #9 partial | `makeLpDiagnose` / `makeSdpDiagnose` implement spec §6.5's v1 simple rule. LP-side uses `threshold=1e-6` and `defaultKind="primal"` (see §3 below) | `Regularization.ts:80-130` |

---

## 2. The plan, with severity-ordered next actions

The umbrella beads issue is `scientist-workbench-qmrv` (claimed by `tobiasosborne`).

**Phase 1 — wire SDP through the shared helper (#8 finish).** ~80 LOC, no design risk.

Three SDP solvers each have a near-identical Cholesky retry loop:

- `NtSdpSolver.ts:166-179` — Schur factor
- `AhoSdpSolver.ts:117-131` — Schur factor
- `SdpSolver.ts:124-138` — Schur factor

Each looks like:
```ts
const Lchol = new Float64Array(m * m);
let jitter = 1e-12;
let factored = false;
for (let attempt = 0; attempt < 10; attempt++) {
  Lchol.set(M);
  const info = choleskyInPlace(Lchol, m, jitter);
  if (info < 0) { factored = true; break; }
  jitter *= 100;
  if (jitter > params.jitterMaxGap) break;
}
if (!factored) return finalize("numerical-error");
```

Replace with the LP-pattern from `Solver.ts:75-91`:
```ts
// Hoist this out of the iteration loop (one alloc per solve):
const sdpDiagnose = makeSdpDiagnose(prob.blocks, prob.m);
const regState: RegState = { jitterPrimal: 1e-12, jitterDual: 0, jitterGap: 0,
  bumpsPrimal: 0, bumpsDual: 0, bumpsGap: 0, refactors: 0 };
const regParams = {
  initialJitter: params.initialJitter,
  jitterMaxPrimal: params.jitterMaxPrimal,
  jitterMaxDual: params.jitterMaxDual,
  jitterMaxGap: params.jitterMaxGap,
  bumpPrimal: params.bumpPrimal,
  bumpDual: params.bumpDual,
  bumpGap: params.bumpGap,
  maxRefactor: 10, // spec §6.4
};

// Inside the iteration loop:
const Lchol = new Float64Array(m * m);
if (!factorWith3Way(M, m, Lchol, regState, regParams, sdpDiagnose)) {
  return finalize("numerical-error");
}
```

**Important difference from the LP wiring:** for SDP the **spec caps** (`cap_d=1e+2`, `cap_g=1e+2` from `DEFAULT_PARAMS`) are correct as-is — do **not** override them like the LP path does. The wider caps are exactly the SDP path's headroom for control3-class problems. The LP-specific cap override at `Solver.ts:75-91` is a workaround documented inline; the SDP path doesn't need it.

After wiring all three SDP solvers:
- Run `~/.bun/bin/bun test packages/solver-ipm/`.
- Run `~/.bun/bin/bun tools/sdp-solve/tool.ts --test`.
- Spot-check the bench: see Phase 2.

**Phase 2 — Capture COPT iter logs for the 3 failing cases (#11).** ~30 min.

The reverse-engineered IPM port has access to COPT 8.0.4 as an oracle. From `~/Dropbox/Projects/Computers/LLM/COPT-decomp/HANDOFF.md` §7 (literal copy):

```bash
cd /home/tobias/Dropbox/Projects/Computers/LLM/COPT-decomp/probes
cat > control2.cmd <<'EOF'
#COPT Script File
read /home/tobias/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/control2.dat-s
set Logging 2
set LogToConsole 1
set SDPMethod 0      ← force Primal-Dual default (the path we're porting)
set IterLimit 200
optimize
quit
EOF
LD_LIBRARY_PATH=$HOME/Dropbox/Projects/Computers/LLM/COPT-decomp/copt/copt80/lib \
    $HOME/Dropbox/Projects/Computers/LLM/COPT-decomp/copt/copt80/bin/copt_cmd \
    -i control2.cmd 2>&1 | tee control2.log
```

If COPT's license complains about USER mismatch, move `~/copt/license.{dat,key}` aside (demo mode works for SDPLIB-small per `HANDOFF_NEXT.md` §3.5). Repeat for `control3` and `hinf2`.

The relevant SDPLIB inputs live under `~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/`. Confirm with `ls`.

**Phase 3 — Capture TS NT iter logs after Phase 1 wiring (#12).** ~30 min.

The pattern (use `formatIterLine` / `formatIterHeader` which match COPT's printf exactly per `HANDOFF.md` §7):

```ts
import { readFileSync } from "node:fs";
import {
  parseSdpaSparse, convertSdpaToSdp, solveSdp,
  formatIterHeader, formatIterLine,
} from "@workbench/solver-ipm";

const t = readFileSync("/.../control2.dat-s", "utf-8");
const p = convertSdpaToSdp(parseSdpaSparse(t), /*maximize=*/ true);
const log: string[] = [formatIterHeader()];
const r = solveSdp(p, { log: (l) => log.push(formatIterLine(l)) });
console.log(log.join("\n"));
console.log("status:", r.status, "iter:", r.iter, "obj:", r.primalObj);
```

`diff` the COPT and TS logs side by side. Per the COPT handoff (`HANDOFF.md` §7-§8): if μ trajectories agree to within 2-3× per iteration, the algorithm port is correct. Iter where they first diverge tells you which step is buggy.

**Phase 4 — Verify bench grade lifts to 6/6 (#13).** ~5 min.

```bash
cd ~/Projects/scientist-workbench-corpus
~/.bun/bin/bun src/cli.ts grade scientist-workbench sdp-sdplib
```

Acceptance: 6/6 cases pass on `sdp-sdplib`. Today: 3/6 (control1, theta1, mcp100). If <6/6 after Phase 1, the differential iter logs (Phase 3) tell you which case still fails and where the trajectory diverges from COPT.

**Phase 5 — If still failing.** Diagnose-kind v2 (#9), `buildNtFactor` jitter retry (#10), and `MAX_REFACTOR=10` (#4 — blocked by #9). See §4 below for the unblock chain.

---

## 3. Gotchas surfaced in Wave 1 (read these or you'll repeat them)

**Sum vs only-primal in Cholesky lift.** Spec §6.1 sums δ_p + δ_d + δ_g into the diagonal lift. Pre-alignment LP code applied only δ_p (dual/gap were cosmetic counters). Applying the sum changes the noise floor from `1e-12` to `3·1e-12` and propagates into `O(100×)` primalInf at the optimum on near-degenerate LPs (NETLIB `lotfi` regressed by this). **Mitigation:** in `Solver.ts`, initialize `jitterDual = 0, jitterGap = 0` (only primal carries the `1e-12` floor) — see file:line in `Solver.ts:46-58`. Adopt the same pattern for SDP wiring.

**LP-specific cap override `cap_d=cap_g=1e-2`.** Set in `Solver.ts:75-91`. Reason: spec caps (`1e+2`) keep the LP IPM alive past the well-converged iterate and drift to worse answers on `brandy`. Best-iterate tracking (COPT does it per `IPM_LOOP_CHEATSHEET.md` §2 step 9) is the proper v2 fix; the cap override is the v1 patch. **Do not apply this override on the SDP path** — SDP needs the spec cap headroom.

**LP diagnose default `"primal"`, threshold `1e-6` (not spec's `1e-10`).** Set in `Regularization.ts:117-130`. Reason: NETLIB LP problems are primal-regularization-dominated; routing routine failures to GAP per the strict spec §6.5 reading overshoots. SDP diagnose uses the spec-strict rule (`makeSdpDiagnose`, threshold `1e-10`, default GAP) because PSD Schur matrices genuinely need the wider GAP headroom.

**NT predictor X reconstruction.** The pre-alignment code at `NtSdpSolver.ts:280-298` reconstructed `-X` via `gtDiagG(f, sign_neg, ·)` (algebraically equivalent via the NT identity `G^T·diag(sv)·G = X`) instead of using `X` directly. The author's own comment said "doesn't matter" — it does, on 30×30 ill-conditioned blocks. Fixed in this commit. Don't re-introduce.

**Stall counter reset semantics.** Worklog 094 §5 named this. Reset-on-progress is *correct* per spec §3.3 — the bug was the *threshold* (0.9 = 10% progress required, too eager). Now 0.99 (1%) everywhere. Don't replace with EWMA / non-resetting variants; the spec is explicit.

**LP σ-clip kept at `[0, 1]`.** Spec §2 step 5 says `[1e-8, 0.9]`. The lower bound damps the pure-affine direction enough to suppress Farkas `y → ∞` growth needed for LP infeasibility certificates in `Convergence.ts` (`it.dualObj > 1e8 && yInfNorm > 1e8` heuristic). Revisit when Convergence.ts uses a magnitude-aware certificate test instead of raw threshold. SDP path has no Farkas detection so the spec floor applies cleanly there.

**MAX_REFACTOR=20 (vs spec §6.4's 10) in LP.** The wider attempt budget compensates for blind escalation; safe to narrow to 10 once diagnose-kind routes failures smarter than primal-first. Task `#4` is blocked on `#9` for that reason.

**`F_infeasible_3var_sum` carve-out.** The legacy `factorWithRegularization` had a bug-as-feature: the `attempt < 6 OR primal < cap` shortcut let primal jitter bump O(1e+6) past its 1e-2 cap, effectively lifting the rank-1 Schur of the proportional-rows infeasibility case. The spec-correct caps in the new helper bound that growth, losing this specific infeasibility-certificate detection. Fix is best-iterate tracking + the pre-iter-5 infeasibility check (currently gated `it.iter > 5` in `Convergence.ts:60`).

---

## 4. Task graph (run `TaskList` to see live state)

```
done  #1 caps spec values
done  #2 σ-clip on AHO/HKM (LP held)
done  #3 stall threshold 0.99
done  #5 NT predictor -X direct
done  #6 ξ_p / ξ_d split
done  #7 drop stallIterCap=30 band-aid
done  #8 [partial] shared helper exists, LP wired
done  #9 [partial] LP/SDP diagnose builders exist

NEXT  #8 [finish]  wire NT/AHO/HKM through factorWith3Way      ← do this first
      #11         capture COPT iter logs for control2/3/hinf2  ← parallel
      #12         capture TS iter logs, diff against COPT      ← after #8 & #11
      #13         verify 6/6 corpus sdp-sdplib bench grade     ← after #12

LATER #10         buildNtFactor jitter retry escalation
      #9  [v2]    upgrade diagnose-kind with h_r (DUAL detection)
      #4          MAX_REFACTOR=10 (blocked by #9 v2)
```

Beads:
- `scientist-workbench-qmrv` — umbrella (claim before working).
- `scientist-workbench-j1gd` — companion (LP algorithm-hygiene). Some items already done in this commit; sync the description.

---

## 5. How to verify and debug

**Substrate tests (fast):**
```bash
PATH=$HOME/.bun/bin:$PATH bun test packages/solver-ipm/
```

**Per-tool smoke (fastest):**
```bash
~/.bun/bin/bun tools/sdp-solve/tool.ts --test
~/.bun/bin/bun tools/lp-solve/tool.ts --test
```

**Full check (slowest, before any commit):**
```bash
PATH=$HOME/.bun/bin:$PATH bun scripts/check.ts
```

**Per-iteration trace pattern (the diagnostic that paid off in this session — use it):**
```bash
~/.bun/bin/bun -e '
import { readFileSync } from "node:fs";
import {
  parseSdpaSparse, convertSdpaToSdp, solveSdp,
  formatIterHeader, formatIterLine,
} from "@workbench/solver-ipm";

const t = readFileSync(process.argv[1]!, "utf-8");
const p = convertSdpaToSdp(parseSdpaSparse(t), true);
const log: string[] = [formatIterHeader()];
const r = solveSdp(p, { log: (l) => log.push(formatIterLine(l)) });
console.log(log.join("\n"));
console.log("status:", r.status, "iter:", r.iter, "obj:", r.primalObj);
' /home/tobias/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/control2.dat-s
```

`formatIterLine` matches COPT's printf byte-for-byte (`PD_IPM_DEEP.md` §"Anatomy of the main loop" L635-639), so you can `diff` against COPT's log.

For LP differential debug, use the `IterLogLine` callback on `solveLp`:
```bash
~/.bun/bin/bun -e '
import { readFileSync } from "node:fs";
import { solveLp, lpFromCanonical, formatIterHeader, formatIterLine } from "@workbench/solver-ipm";

const data = JSON.parse(readFileSync(process.argv[1]!, "utf-8"));
const c = data.cases.find((x) => x.id === process.argv[2]);
const log = [formatIterHeader()];
const r = solveLp(lpFromCanonical(c.input), { log: (l) => log.push(formatIterLine(l)) });
console.log(log.join("\n"));
console.log("status:", r.status, "iter:", r.iterate.iter);
' /home/tobias/Projects/scientist-workbench-corpus/benchmarks/lp-netlib/golden/inputs.json brandy
```

---

## 6. Pointers to load-bearing context

- **CLAUDE.md** at repo root — the project laws and rules (the two laws, rule 9 on beads, rule 5 on feedback speed).
- **`docs/adr/0030-convex-cone-solver-tier.md`** — the architectural ADR.
- **`docs/adr/0032-solver-ipm-port.md`** — substrate ADR.
- **`docs/worklog/094-sdp-solve-and-corpus-bench.md`** — where bead `qmrv` originated.
- **`~/.claude/projects/-home-tobias-Projects-scientist-workbench/memory/MEMORY.md`** — auto-memory index.
- **The two principles** memory: `bd memories two-principles` — the universal decision rule. Read before touching design.
- **Coding subagents use Opus** memory: `bd memories coding-subagents-in-scientist-workbench-use-opus-not` — applies when spawning implementation subagents.

---

## 7. The user's working style (worth knowing)

- **Verbose tests with eager flush** are the preferred diagnostic loop. The per-iter trace pattern in §5 is what proved out brandy/lotfi/F_infeasible. Use it before changing algebra.
- **TaskCreate is preferred over beads-only tracking** for in-session work (user override, this session). Use both: TaskCreate for granular execution, beads for cross-session continuity.
- **Pause-and-commit on demand.** When the user says "commit", commit what's solid even if the work isn't done; carve-outs and TODOs are acceptable.
- **The user is the TS expert this code targets.** The two principles memory is the authoritative framing. Code that requires explanation in a comment to feel right is probably wrong.
- **The COPT decomp is private research the user has authorized.** Use it. Don't re-derive from scratch what the decomps already settle.

Good hunting.
