# 094 — `tools/sdp-solve` v0.1 + corpus `sdp-sdplib` bench (2026-05-11)

> **Scope.** Closes bead `v4jd` (`tools/sdp-solve`) and the corpus-side
> sub-bead `jkz6` (Mosek + COPT SDPLIB adapters). Substrate is
> `@workbench/solver-ipm`'s SDP IPM (NT primary, AHO A/B, HKM
> debug-only) — landed in worklog 091; unwrapped here. Bench grade
> 3/6 cases on `sdp-sdplib` v0.1; the 3 failing cases expose a
> substrate convergence gap (filed as bead `qmrv`, the SDP analog of
> LP's NETLIB-`brandy`).

## Context

The convex-cone solver epic (bead `eg9j`, ADR-0030) names four tools:
`cone-solve` (universal SCS-style ADMM), `lp-solve` (specialist;
shipped 2026-05-11 in worklogs 090–093), `qp-solve` (specialist),
and `sdp-solve` (specialist). The substrate package
`@workbench/solver-ipm` (worklog 091) shipped both LP and SDP IPM
engines together; only the LP path got wrapped into `tools/lp-solve`
in worklog 092. The SDP path sat unused.

Shard 093 closed the substrate-hardening bead `6or7` and named bead
`v4jd` as the next entry point. The user's framing was direct: "After
[the SDP solver] is working it is time to build the corpus punishing
brutal benchmark suite and golden masters" — turn-key for the next
agent. That's the goal driving everything below.

## What changed

### Workbench: `tools/sdp-solve` v0.1 (bead `v4jd`)

Seven-artefact tool wrapping `@workbench/solver-ipm`'s `solveSdpNt`,
`solveSdpAho`, `solveSdpHkm` exports. Wire schema is ADR-0030 §C
verbatim — same shape `tools/lp-solve` accepts; only the cone
vocabulary differs (PSDCone instead of NonNegCone).

- **Cone vocabulary (v0.1):** PSDCone + ZeroCone. NonNegCone refuses
  with a redirect to `tools/lp-solve` or future `tools/cone-solve`.
  SOCone / ExpCone / PowCone refuse. The NonNegCone-as-diagonal-PSD
  reformulation that would lift mixed-cone SDPLIB problems (truss-*,
  hinf1, several control-* variants) is bead `67nj` (v0.2).
- **svec convention:** strict-Mosek-format with √2 off-diagonal
  scaling (ADR-0030 §C Open Question #4). Position ordering is
  row-major upper-tri. The `<C, X>_F = svec(C)ᵀ svec(X)` invariant
  holds by design — the trap every amateur SDP implementer falls
  into is named explicitly in tool.ts's prose.
- **--method flag:** `auto`/`nt` (default), `aho` (A/B), `hkm-debug`
  (gated). Three lanes share the substrate; agent picks the
  direction it wants to compare.
- **Refusal envelopes:** non-finite-input, degenerate-shape,
  quadratic-objective, non-sdp-cone, malformed-cone, cone-coverage
  (variables in no cone or in two cones).
- **--test smoke hook:** runs both NT and AHO on a 2×2 trace-equality
  problem with known optimum -4; passes.
- **14 goldens:** 6 happy-path PSD cases (1×1, 2×2, 3×3, multi-block,
  ZeroCone) + 8 refusal envelopes. All bytes pinned via the standard
  oracle phase.
- **Determinism tier:** `numerical: true` (ADR-0015), inheriting the
  platform fingerprint from the substrate.

The fn body decodes the canonical Value, validates shape and
finiteness, parses cones to a `ConeLayout` (every variable must be
in exactly one cone), builds an `SdpProblem` (block matrices from
svec via `unsvecIntoFull` with the inverse-√2 off-diagonal scaling),
runs the chosen IPM, and re-encodes per-block X / S as svec into
the wire's x / slack vectors.

### `achieved_precision` is computed in the wire frame

The IPM substrate exposes `primalInf`/`dualInf`/`mu` in its internal
*matrix* representation. The corpus verifier recomputes residuals
from the wire `(x, y, s)` directly — and the wire form's KKT
residuals are O(svec_len) larger than the engine's because of the
√2 scaling and longer summation chains. Reporting the engine
residual as `achieved_precision` is therefore *under-claiming* the
true wire residual, which the verifier catches as a
`self_reported_precision` failure (CLAUDE.md Rule 8).

The fix: compute `r_p = ‖A·x - b‖_∞`, `r_d = ‖Aᵀ·y + s - c‖_∞`,
`r_c = |xᵀs|` directly from the wire vectors and report
`max(r_p, r_d, r_c)`. This matches what the verifier sees and keeps
the self-reported precision honest.

### Corpus: `benchmarks/sdp-sdplib` (bead `jkz6` → `tj6p`)

Mirrors the lp-netlib pattern (Mosek + Gurobi dual-witness) with
two adjustments:

1. **Oracle pair is Mosek + COPT, not Mosek + Gurobi.** Gurobi
   doesn't support SDP. COPT (Cardinal Optimizer) v8.x supports
   SDP, ships with both commercial and free-tier licenses, and the
   free tier (n ≤ 2000 PSD dimension) covers all v0.1 SDPLIB
   classics with 20× headroom (max block size 100 in mcp100).
2. **Agreement tolerance is 1e-5, not 1e-8.** SDP solvers don't
   reach machine precision on objective; Tütüncü-Toh-Todd 2003 and
   the SDPLIB reference table both document the "1e-6 SDP precision
   floor". 1e-5 catches order-of-magnitude lies; 1e-8 would falsely
   flag every case as oracle_disagreement.

**v0.1 problem set (6 pure-PSD SDPLIB classics):** control1 (m=21,
PSD 10+5), control2 (66, PSD 20+10), control3 (136, PSD 30+15),
hinf2 (13, PSD 5+5+6), theta1 (104, PSD 50), mcp100 (100, PSD 100).
Both oracles agree to 1e-5 on 5/6 (hinf2 single-witness because
COPT free-license drift exceeds the agreement gate).

Tool grade: **3/6 cases, 63/66 invariants** as of 2026-05-11. The
3 failing cases (control2, control3, hinf2) hit substrate
convergence gaps documented under bead `qmrv`.

## Why these choices

### Why PSDCone-only in v0.1

The "one symbol, one schema" principle applies (the two principles
memory). A TS expert types `wb.run("sdp-solve", problem)` expecting
PSD constraints. Mixing in NonNeg-as-diagonal-PSD is a v0.2 ergonomic
extension that doesn't change the wire — it just lifts the cone
vocabulary the tool accepts. Shipping v0.1 strict means every
v0.1-grade problem unambiguously falls under "is this an SDP?".

The cost: SDPLIB problems with LP blocks (truss-* etc.) skip in the
bench. Documented in DESCRIPTION.md.

### Why a separate sdp-solve, not a single cone-solve

ADR-0030 §B's architecture: universal primary (`cone-solve`) plus
structural specialists (`lp-solve`, `qp-solve`, `sdp-solve`). `cone-
solve` is bead `2ivi`, separate work. `sdp-solve` exists today
because the substrate exists today; spinning the universal SCS
implementation up to par is a multi-week effort that shouldn't gate
SDP availability.

### Why bench gate at 3/6 and not "wait until 6/6"

CLAUDE.md Rule 8 — honest scope. The bench gates on what's true
*now*, not what we wish were true. 3/6 is the honest grade. The 3
failing cases get the same status_consistency hard-fail any
regression would, so future improvements light up immediately.
The corpus's DuckDB `grade_results` table tracks per-case per-check
verdicts, so the 3/6 → 6/6 trajectory is queryable.

### Why agreement_tol = 1e-5 for SDP (not 1e-8 like LP)

Empirical: Mosek and COPT agree to 1e-5 on these problems but not
to 1e-8. Mosek hits ~1e-9 internal precision; COPT-free hits ~1e-5
to 1e-7 depending on the problem. If we set agreement_tol=1e-8,
all 6 cases would be flagged oracle_disagreement and the
oracle_agreement check would never gate — which defeats the
dual-witness purpose. 1e-5 catches order-of-magnitude lies (which is
what oracle_agreement is *for*) without false-positiving on normal
SDP precision drift.

This matches the literature (Tütüncü-Toh-Todd 2003 "1e-6 SDP
precision floor") and SDPLIB reference Table 2.

### Why the COPT y is reconstructed via least-squares, not read from API

COPT v8's `getInfo(Dual, PsdConstraint)` returns a value that does
NOT match the standard SDP equality-constraint dual y_i — it appears
to report a normalised internal value. Symptom: my probe on a
2-constraint test returned identical y values for both constraints
(both -0.9999) when Mosek correctly returned (-1.0, ~0). The fix:
compute y from the KKT stationarity relation `S = C - Σ y_i A_i`
via least-squares on the canonical wire. Internally consistent,
matches Mosek bit-for-bit on solvable cases.

### Why os.dup2 fd 1 → fd 2 in copt-sdp.py

COPT v8's license-check banner writes to **fd 1 (stdout) at the C
library level**, NOT via Python's sys.stdout. The standard
`sys.stdout = sys.stderr` redirect doesn't catch C-level writes.
The proper fix is OS-level fd duplication: save fd 1 (the real
stdout), redirect fd 1 → fd 2 (stderr) for the noisy phase, write
JSON to the saved fd via `os.write`. This keeps the JSON response
clean for the bench runner's strict-JSON parser.

## Frictions surfaced

1. **Schema-narrowing through `list([helper(...)])`.** TS infers
   `Value[]` for the items array when the helper returns
   `ExpressionValue` indirectly, which fails the schema's
   `S.list(S.expression())` constraint. Fixed by explicitly
   annotating `psdCone()` return type as `ExpressionValue` and
   importing the type. This is a recurring TS friction with
   schema-derived types in examples (see lp-solve for the prior
   instance).

2. **Example output types must match schema-derived types.**
   `fn(input, {})` returns `Value`, but `examples[].output` wants
   the more specific `RecordValue | TaggedValue` union. Hand-coded
   the example outputs (matching what fn produces conceptually but
   not byte-exactly — goldens pin the bytes). The lp-solve tool
   uses the same pattern.

3. **`loadWorkbench()` cwd-walk fails when the corpus runner spawns
   the candidate from a non-workbench cwd.** The runner cwd is the
   corpus repo root; `loadWorkbench()` walks up looking for
   `tools/`, finds none. Fixed by passing `toolsRoot` explicitly
   in `run-candidate.ts`. This caught me by surprise — the
   isolated test (with the right cwd) passed; only the corpus
   runner failed. Worth knowing for any future bench wiring.

4. **NT direction stalls on control2/control3/hinf2.** The IPM hits
   either Cholesky breakdown on the Schur complement (control3 at
   53 iter) or stalls in mu-decrease (control2 at 324 iter; hinf2
   at 108 iter). AHO direction also fails on these cases. Both
   converge correctly on control1, theta1, mcp100. This is the
   SDP analog of LP NETLIB-`brandy`'s convergence gap (bead `j1gd`).
   Filed as bead `qmrv`. Fix candidates: σ-clip [1e-8, 0.9],
   tighter Cholesky regularisation schedule, NT/AHO crossover
   fallback, more aggressive initial-point scaling.

5. **`numerical-difficulty` triggers on stallIterCap=10.** Bumping
   to stallIterCap=30 in tools/sdp-solve didn't help — control2
   still stalls at iter 324 because the substrate's stall counter
   resets on any mu-drop, so consecutive stall-30 trips happen
   late in the iteration. The right fix is in the substrate's
   convergence detection logic, not in the tool's params override.
   Documented in bead `qmrv`.

## Acceptance

### Workbench (closes `v4jd`)

- `bun tools/sdp-solve/tool.ts --version` → `{name: "sdp-solve",
  version: "0.1.0"}`. ✓
- `bun tools/sdp-solve/tool.ts --schema` emits the ADR-0030 §C/§D
  schemas. ✓
- `bun tools/sdp-solve/tool.ts --test` → tests passed (NT + AHO on
  the 2×2 trace-equality problem). ✓
- `bun run check`: 75 passed, 7 skipped, 0 failed. ✓
- 14 goldens written and oracle-verified. ✓
- README.md, tool.ts (literate), goldens.spec.ts. ✓
- `wb.run("sdp-solve", problem)` and the typed-barrel
  `wb.sdpSolve(problem)` both work in-process. ✓

### Corpus (closes `jkz6` for the bench-side)

- `~/.bun/bin/bun src/cli.ts validate` → 582 caps, 18 suites, 24
  adapters; OK. ✓
- `~/.bun/bin/bun src/cli.ts grade scientist-workbench sdp-sdplib`
  → 3/6 cases, 63/66 invariants. ✓
- Mosek + COPT oracles both reach optimal on all 6 problems;
  consensus agreement on 5/6 (hinf2 single-witness). ✓
- 10 SDPLIB problems downloaded; 6 ship in v0.1 inputs.json
  (4 deferred to v0.2: arch0 has LP block; maxG11/qpG11/theta2
  exceed dense gate). ✓

### Open punch-list (filed as beads)

- `qmrv` — solver-ipm SDP convergence hardening. The 3 failing
  bench cases.
- `67nj` — sdp-solve v0.2 NonNegCone-as-diagonal-PSD support. Lifts
  truss-* / hinf1 / control-* with LP blocks into the bench.
- `tj6p` — corpus side parent (this shard's `jkz6` is one
  sub-bead).
- `c2wc` — explicit white whale (SDPT3-equivalent IPM at 1e-10
  ceiling), still deferred per ADR-0030 §G.

## Pointers

- `tools/sdp-solve/tool.ts` — the literate tool implementation.
- `tools/sdp-solve/README.md` — agent-facing summary with worked
  example.
- `tools/sdp-solve/goldens/` — 14 byte-pinned cases.
- `~/Projects/scientist-workbench-corpus/benchmarks/sdp-sdplib/` —
  the corpus bench. Read DESCRIPTION.md for the bench gate
  story.
- `~/Projects/scientist-workbench-corpus/adapters/{mosek,copt}/oracles/`
  — the SDP oracles.
- ADR-0030 §B (`docs/adr/0030-convex-cone-solver-tier.md`) — the
  cone-solver tier architecture.
- ADR-0032 (`docs/adr/0032-solver-ipm-port.md`) — the substrate
  shipped in worklog 091, hardened in 093, wrapped here.
- `bd show scientist-workbench-qmrv` — the SDP convergence
  follow-up bead.
- `bd show scientist-workbench-67nj` — the v0.2 mixed-cone
  follow-up bead.
