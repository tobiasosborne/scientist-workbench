# ADR-0032 — `@workbench/copt-ipm`: reverse-engineered TS port of COPT 8.0.4's primal-dual IPM

**Status:** Proposed — 2026-05-11
**Beads:** scientist-workbench-2zed (this ADR). Closed under it:
prfp (Mehrotra IPM lane in `tools/lp-solve`), wx3m (parent "best-
in-class LP specialist"), 6or7 (substrate hardening), 2dhc (golden
05 unbounded-ray convention).
**Related:** ADR-0030 (cone-solver tier — the wire schema this port
must conform to); ADR-0031 (the *exact* lane sharing the same
`tools/lp-solve` symbol); ADR-0015 (determinism tier — this port's
public annotation); CLAUDE.md Rules 1, 2, 7, 8 (honest scope,
quality gates, the discipline this ADR's tests must respect).

## Context

`tools/lp-solve` v0.1 shipped 2026-05-11 (commit `09c520d`, worklog
090) as an exact-rational simplex over ℚ — the world-first claim
for arbitrary-precision LP in TypeScript. Its natural scale ceiling
is `m + n ≈ 50`: per-pivot O(m²) cost over BigInt coefficients
growing as Cramer's-rule bounds. Above that ceiling the lane
correctly grinds to a halt and was supposed to be paired with two
follow-up lanes:

- `hnyu` — float-engine revised simplex (NETLIB-scale, vertex out).
- `prfp` — Mehrotra primal-dual IPM (NETLIB-scale, central-path).

Concurrently and independently, a second agent worked an
experimental branch (`origin/experiment/copt-ipm-port`) that
reverse-engineered Cardinal Optimizer's COPT 8.0.4 binary via
Ghidra and ported the core primal-dual interior-point method to
TypeScript. The handoff lives at `/home/tobias/Dropbox/Projects/
Computers/LLM/COPT-decomp/` (private research, not in the workbench
repo).

When the two agents' branches came together, the choice was:

1. Keep them as separate parallel tools competing for the LP slot.
2. Reject one in favour of the other.
3. **Merge them as two internal lanes of the same public
   `tools/lp-solve` tool, with size-based auto-dispatch.**

Option 3 is what the original `prfp` bead always envisioned: the
Mehrotra IPM is the second lane, not a separate tool. The reverse-
engineered COPT port satisfies that lane's algorithm.

## Decision

### Decision 1 — Substrate is `@workbench/copt-ipm`, separate from `tools/lp-solve`

The reverse-engineered port lives as `packages/copt-ipm/` (17 src +
8 test files), exported as `@workbench/copt-ipm`. The package is
*substrate only* — it carries no workbench-tool wire shape; that
lives in `tools/lp-solve/tool.ts` (LP) and a future
`tools/sdp-solve/tool.ts` (SDP, bead `v4jd`).

This mirrors the workbench's existing substrate/tool split (e.g.
`@workbench/simplex-q` is substrate; `tools/lp-solve` is wire) and
keeps the SDP path of copt-ipm available without forcing it
through the LP tool's schema.

### Decision 2 — `tools/lp-solve` dispatches between exact and IPM lanes via `--method=auto|exact|ipm`

- `--method=exact` (or `auto` when `m + splitN ≤ 50`): the
  arbprec lane, ADR-0031 verbatim.
- `--method=ipm` (or `auto` when `m + splitN > 50`): the COPT
  Mehrotra port via `@workbench/copt-ipm`.
- The `method` field of the output record reports which lane ran
  (`"simplex-q"` or `"copt-ipm"`). The wire schema (ADR-0030 §C/§D)
  is unchanged.

Free-variable splitting happens before dispatch so both lanes see
standard-form `min cᵀx s.t. Ax = b, x ≥ 0` input. The float-space
split is what the IPM consumes; the exact lane lifts it to ℚ
exactly via `float64ToExactRat`.

### Decision 3 — Determinism tier: `numerical: true` (ADR-0015)

The IPM is float64 throughout. Bit-identical given platform
fingerprint `{arch, os, runtime}` (ADR-0015). The composite tool
(which mixes the bit-identical exact lane and the platform-
fingerprinted IPM lane) carries `numerical: true` on its public
surface, matching ADR-0031 already; the runner auto-emits the
platform field in the provenance record when the output contains
float64 leaves.

A TS expert who wants the bit-identical answer forces
`--method=exact`. A TS expert who wants the IPM's polynomial-time
scaling forces `--method=ipm`. The auto-dispatch routes by size
and is honestly reported in the result.

### Decision 4 — Reverse-engineering provenance recorded, IP boundary respected

The Ghidra project, decompilations, cleanroom-spec, and
differential-validation logs are kept at `/home/tobias/Dropbox/
.../COPT-decomp/` — outside the workbench repo. The TS port
`@workbench/copt-ipm` is the cleanroom implementation; the workbench
repo carries:

- Source code derived from the cleanroom spec and differential
  validation (`packages/copt-ipm/src/*`).
- Algorithm references to the published literature (Mehrotra 1992,
  Todd-Toh-Tütüncü 1998, Alizadeh-Haeberly-Overton 1997) in
  `solver/*` doc-comments.
- Test fixtures from public examples shipping with COPT
  (`packages/copt-ipm/test/fixtures/sdp.dat-s` is the SDPA-sparse
  example from COPT's own `examples/data/`).
- *No* decompiled C or binary artefacts; *no* Ghidra-project files.

A future re-implementer can follow the algorithm references and
land at the same TS port without ever touching the decomps. This
respects the IP boundary: COPT's source is proprietary; the
algorithm (Mehrotra predictor-corrector + NT direction) is
textbook; the cleanroom port is the workbench's contribution.

### Decision 5 — SDP support is a *separate tool*, not part of `tools/lp-solve`

`@workbench/copt-ipm` already implements three SDP solvers (NT
primary, AHO A/B reference, HKM debug-only). These will be wrapped
as `tools/sdp-solve` (bead `v4jd`) — a new workbench tool filling
ADR-0030 §B's deferred "SDP specialist" slot.

The LP tool's schema (`Ax_eq_b` + `NonNegCone`) doesn't
naturally extend to SDP (which needs symmetric matrices in the
input + `PsdCone` block sizes). A separate tool is the honest
factoring; the engine substrate is shared.

### Decision 6 — Test discipline matches the rest of the workbench

Sub-decisions for `@workbench/copt-ipm`'s test surface (worklog
093, bead `6or7`):

- Hard `expect()` assertions per case, not sweep-and-log (Rule 7).
- Named carve-outs for known algorithm gaps (NETLIB `brandy`
  convergence-flag flip; substrate-validation gaps for
  `H_malformed_cone`, `H_non_finite_input`). The carve-outs are
  self-documenting punch-lists tracked in bead `j1gd`.
- Portable corpus-path resolution via `WORKBENCH_CORPUS` env or
  sibling `../scientist-workbench-corpus` (ADR-0028 sibling
  checkout). Tests skip with a clear message if neither resolves.
- Wire-status mapping shared between tool and tests via
  `@workbench/copt-ipm::toWireStatus`. Single source of truth.

### Decision 7 — Reject `HANDOFF_SPEC_ALIGN.md`'s Category-C "fidelity to C runtime" items

The handoff document `HANDOFF_SPEC_ALIGN.md` listed ~10 deltas
between the TS port and the cleanroom spec, framing them all as
"alignment debt". Read through the two-principles filter (`bd
memories two-principles`), they sort into three categories:

| category | examples | decision |
|---|---|---|
| **A — Workbench contract** | `defineTool` wrapper, schema, `--test`, provenance, hard test assertions, refusal envelopes, `numerical: true` annotation, platform fingerprint | **Apply** — workbench discipline, not optional (worklog 093, bead `6or7`) |
| **B — Algorithm hygiene** | σ-clip [1e-8, 0.9] (Mehrotra standard), stall threshold 0.99, DIMACS error vector, Ruiz equilibration | **Apply** — merit-based improvements, not deference (bead `j1gd`) |
| **C — Decomps-fidelity cosmetics** | Cone-interface unification, numeric `SolveStatus` enum 0-11, packed lower-triangular storage, COPT-matching iter-log format | **Reject** — anti-TS-expert: abstract base classes / runtime polymorphism over concrete functions sharing primitives; magic integers over discriminated string unions; memory optimisation without measured forcing |

The HANDOFF_SPEC_ALIGN.md author conflated "faithful to COPT's
algorithm" (which we want) with "faithful to COPT's C-runtime data
layout and integer status codes" (which we don't, in a TS-native
codebase). The categorical split above is the load-bearing
interpretive correction.

## Consequences

**Positive.**

- The LP specialist of the cone-solver tier now covers both the
  small-bulletproof regime (exact, bit-identical, world-first) and
  the NETLIB regime (IPM, scales to n ≈ 2000). Same wire schema;
  one tool; honest method-tag echo.
- The SDP substrate is in tree, ready for `tools/sdp-solve`
  wrapping (bead `v4jd`). COPT's NT direction matches its actual
  default barrier path (reverse-engineering finding).
- The pattern "land substrate first, harden contract second,
  wrap tool third" generalises: this is also the path the future
  `cone-core` epic (`cp9k`) will follow for SOC / Exp / Pow.

**Negative.**

- The auto-dispatch threshold `m + splitN ≤ 50` is one calibrated
  empirical parameter. A future agent or a workload not represented
  in worklog 090's bench grade might want to override it;
  `--method=exact|ipm` is the escape hatch but a TS-expert
  observation log of "auto routed me to the wrong lane" might
  emerge. Defer to data.
- `@workbench/copt-ipm` carries a known convergence gap on
  NETLIB `brandy` (the IPM converges to the right objective but
  flips its convergence flag); tracked in `j1gd`. The σ-clip /
  stall-threshold fixes are the most likely lever.

**Neutral.**

- The substrate hardening punch-list closed (`6or7`) but the
  algorithm-hygiene punch-list is open (`j1gd`). This is honest
  scope per Rule 8 — the workbench gates on the contract, not on
  perfection.

## Open questions

1. **Should the auto-dispatch threshold be configurable, or stay
   calibrated?** Currently `AUTO_DISPATCH_NMAX = 50` is a constant
   in `tools/lp-solve/tool.ts`. A `--auto-threshold=N` flag could
   expose it but adds surface for marginal benefit; an agent who
   wants a specific lane uses `--method=` already. Defer.

2. **What happens when both lanes disagree?** The exact lane
   produces bit-identical answers; the IPM produces float-residual
   answers. On the same small problem (force `--method=ipm` on
   `m + n ≤ 50`) the IPM answer agrees with the exact one to
   ~1e-6, never bit-exact. A workbench agent comparing two runs
   needs to know "did the same lane run?" — the `method` field
   answers that. No further design needed today.

3. **Will the `cone-core` epic (`cp9k`) absorb copt-ipm's IPM
   loop?** `cone-core`'s scope is the SCS-style ADMM operator-
   splitting iteration for universal cone solving — a different
   algorithmic regime than the IPM. The two will coexist:
   `cone-core` for the universal `cone-solve`, `copt-ipm` for the
   specialist LP/SDP solvers. ADR-0030 §B is the slot diagram.

## References

- Mehrotra, S. (1992). "On the implementation of a primal-dual
  interior point method." *SIAM Journal on Optimization* 2(4).
- Todd, M. J., Toh, K. C., & Tütüncü, R. H. (1998). "On the
  Nesterov-Todd direction in semidefinite programming." *SIAM
  Journal on Optimization* 8(3).
- Alizadeh, F., Haeberly, J.-P. A., & Overton, M. L. (1997).
  "Complementarity and nondegeneracy in semidefinite programming."
  *Mathematical Programming* 77.
- Wright, S. J. (1997). *Primal-Dual Interior-Point Methods*. SIAM.
- Cardinal Optimizer COPT 8.0.4 user's manual + bundled examples
  (`copt80/examples/data/sdp.dat-s`).
- `/home/tobias/Dropbox/Projects/Computers/LLM/COPT-decomp/` —
  reverse-engineering artefacts (private research; cleanroom spec,
  differential validation, Ghidra project).
- `docs/worklog/091-copt-ipm-substrate-landing.md`
- `docs/worklog/092-lp-solve-lane-dispatcher.md`
- `docs/worklog/093-copt-ipm-contract-hardening.md`
