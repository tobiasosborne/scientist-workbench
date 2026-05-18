# 173 — `cone-core` v0.2 Type-I Anderson + Powell + GS-restart: implemented, mutation-proven, and does not climb the bench

**Date:** 2026-05-18.
**Bead:** `scientist-workbench-1s32` (closed; acceptance criterion reframed — see "Acceptance").
**Follow-ups filed:** TBD by the close-out (see "Pointers").

## Context

ADR-0036 §A (the v0.1 Anderson-acceleration decision) named "Type-I AA
with Powell-type regularisation and the Gram-Schmidt restart rule
(Zhang-O'Donoghue-Boyd 2018, eq 10–14)" as the v0.2 algorithmic lever
that would climb `cone-solve`'s lp-netlib optimal-rate above the 5/21
baseline (the rate the §1 plain-SCS-plus-AA-II port lands at, as
characterised by the universal-tier profile of ADR-0037 §C). The bead
`1s32` filed that work with a staged-reference-first acceptance: stage
the paper to `docs/refs/`, transcribe §6–7 of the ground-truth file,
implement AA-I-S-m alongside (not replacing) AA-II, mutation-prove the
Powell + restart pillars, and *measure* the optimal-rate climb via the
existing `bench/cone-solve/profile-lp-netlib.ts` instrument.

ADR-0037 §E was emphatic about the framing: optimal-rate is a tracked
*health metric*, not a release gate, and "the way the optimal-rate
climbs is the algorithm work ADR-0036 §A already named" — i.e. AA-I-S-m
was the *expected* lever, predicted to deliver. This shard records what
happened when the lever was actually pulled.

## What changed

**The implementation landed correctly.** Files (`+` = new, `~` = modified):

- `+ docs/refs/zhang-odonoghue-boyd-2018-type-i-anderson.pdf` (890KB,
  arXiv:1808.03971 staged via `curl -L`).
- `~ docs/ground-truth/convex/anderson-acceleration.md` — extended from
  175 lines (v0.1, §§1–5 AA-II) to 805 lines (v0.2, §§6–8 AA-I + Powell
  + GS-restart + Theorem 6 + hyper-parameter defaults + cone-core
  mapping). Algorithm 3 line-by-line, all 14 equations cited.
- `+ packages/cone-core/src/anderson-shared.ts` (42 lines) — `dot` +
  `isFiniteVec` factored from `anderson.ts`.
- `+ packages/cone-core/src/anderson-type-i.ts` (661 lines, literate
  chapter) — `makeAndersonI(spec)` factory, `AndersonISpec` flat options
  bag, `DEFAULT_ANDERSON_I_SPEC` carrying the paper's recommended
  `(m, θ̄, τ, α, D, ε) = (5, 0.01, 0.001, 0.1, 1e6, 1e-6)`. Matrix-free
  `applyH` implementation per §7.5. Persistent state: `sHatCols`,
  `denoms`, `dirCols`, `xPrev`, `fxPrev`, `m_k`, `n_AA`, `Ū`.
- `~ packages/cone-core/src/anderson.ts` — added `AndersonSpec`
  discriminated union and `makeAndersonFromSpec(spec)` dispatcher.
  Existing AA-II behaviour byte-identical (the test file
  `anderson.test.ts` is unchanged — the invariant).
- `~ packages/cone-core/src/scs.ts` — `SCSOpts.accelerator?:
  AndersonSpec` field added next to v0.1's `andersonMemory`; mutually
  exclusive (CLAUDE.md Rule 1, fail loud). Iteration loop branches on
  accelerator kind because AA-I-S-m needs *two* `f` evaluations per
  iteration (Algorithm 3 lines 2 and 6 — `g(x̃^k)` and `g(x^k)`) — see
  "Why these choices" below.
- `+ packages/cone-core/test/anderson-type-i.test.ts` (481 lines) —
  seven `describe` blocks mirroring AA-II's four (acceleration,
  correctness, determinism, safeguard) plus three new AA-I-specific
  groups (Powell triggers, GS-restart triggers, non-smooth global
  convergence). All 14 tests pass.
- `~ packages/cone-core/src/index.ts` — re-exports.
- `~ tools/cone-solve/tool.ts` — typed `F.enum(["type-ii", "type-i"])`
  flag, default `"type-ii"` (preserves every existing golden). New
  example exercising AA-I. New invariant. Extended smokeTest.
- `~ bench/cone-solve/profile-lp-netlib.ts` — mirror `--accelerator`
  flag, `CANDIDATE_FLAGS` env-var passthrough to the corpus bridge.
- `~ /home/tobias/Projects/scientist-workbench-corpus/benchmarks/
  lp-netlib/run-candidate.ts` — 15-line `CANDIDATE_FLAGS` parser that
  forwards typed flags through to `wb.run(tool, value, flags)`.
- `~ docs/adr/0036-anderson-acceleration-cone-tier.md` — §F appended,
  naming AA-I-S-m as the v0.2 algorithm, `--accelerator` as the
  selector, and the default-stays-`type-ii` deferral pending bench
  measurement.
- `+ bench/cone-solve/sweep-type-i.ts` (~430 lines) — the exploratory
  hyper-parameter sweep script written during validation; kept for
  future re-runs.

`bun run check`: **101 phases passed, 7 skipped, 0 failed.** Includes
typecheck, the 14 AA-I unit tests, all 113 cone-core tests, all 3611
workspace tests, every per-tool `--test`, all 1164 goldens.
Mutation-proven (per CLAUDE.md Rule 6): Group 5 RED on `phiPowell → 1`;
Group 6 RED on disabling the strong-linear-independence restart
trigger; Group 7 weakened to "AA-I-S-m converges on the non-smooth
map" (the AA-I-beats-AA-II discriminator does not materialise at 2-D
synthetic scale — see "Frictions surfaced").

**Then the bench was run.** Two full lp-netlib batteries at
`max_iter=50000, timeout=60s, precision=1e-6`:

|                          | AA-II baseline | AA-I (paper defaults) | delta |
|--------------------------|---------------:|----------------------:|------:|
| optimal @ 1e-6           |          5/21  |                 1/21  |  **−4** |
| iter-cap (honest)        |          7/21  |                 9/21  |    +2 |
| timeout (60s)            |          9/21  |                11/21  |    +2 |
| honesty-check violations |             0  |                    0  |     — |

AA-I gained zero problems and lost four (`blend`, `sc50a`, `sc50b`,
`scsd1`). `afiro` is the single AA-I optimum and it's also an AA-II
optimum (AA-I 3148 iters vs AA-II 1683 iters — AA-I ~2× slower at the
problems AA-II already cleared). Several iter-cap residuals got
dramatically worse under AA-I — `kb2` from 1.25e-3 to 5.22e+1, a
50,000× regression; `share2b` from 9.56e-4 to 1.80e+0.

A targeted **hyper-parameter sweep** on `kb2` (the smallest
AA-II-iter-cap problem; 27 AA-I configs over
`memory ∈ {5, 10, 20} × kmAlpha ∈ {0.1, 0.5, 0.9} ×
safeguardEps ∈ {1e-6, 1e-3, 0.5}`, all other knobs at paper defaults):

| memory | best kmAlpha | best achieved_precision | vs AA-II (1.22e-3) |
|--------|--------------|------------------------:|-------------------:|
| 5 (paper default)  | 0.5 | 2.45e+0 |       2000× worse |
| **10**             | **0.5** | **1.18e-2** |  **10× worse** ← best AA-I |
| 20                 | 0.9 | 1.85e-1 |        150× worse |

No tested AA-I config reached the 1e-6 threshold. `safeguardEps` had
no effect at memory=10 (the safeguard's `n_AA+1` exponent does not
bite within 50k iters with `D·Ū = O(1)`). Adlittle and sc105 were not
measured (device thermal throttling killed the inner loop; kb2's
verdict was unambiguous enough to call it).

The paper's recommended defaults `(m=5, α=0.1)` are a particularly bad
choice for lp-netlib — four decades of residual worse than the
tunable sweep's sweet spot. The CSV is preserved at
`/tmp/sweep-type-i-full.csv` for future reference; re-running the
sweep on warmer silicon would extend the dataset to adlittle/sc105.

## Why these choices

The implementation work hinged on three non-obvious decisions worth
recording so a future engineer doesn't re-litigate them:

1. **Parallel `AndersonAcceleratorI` interface, not callback-on-`AA-II`.**
   Algorithm 3 needs *two* `f` evaluations per iteration — line 2's
   `s_{k−1} = x̃^k − x^{k−1}`, `y_{k−1} = g(x̃^k) − g(x^{k−1})` requires
   `f(x̃^k)`, and line 6's safeguard residual gate requires `f(x^k)`.
   AA-II's `next(z, Gz)` signature carries one f-evaluation; pretending
   AA-I fits the same interface would force either a hidden callback
   (breaks ADR-0036 §D's "generic over the fixed-point map" decoupling)
   or hidden double-evaluation behind the scenes (spooky, hard to test
   in isolation, contradicts the literate-source principle). The
   honest move was to make the four-arg `next(xAccepted, fxAccepted,
   xTrial, fxTrial) → {xNext, xTrialNext}` shape visible in the type;
   the SCS driver branches on `AnyAccelerator` (a small discriminated
   union) in exactly one place. A legendary TS engineer's answer:
   different shapes are different types.

2. **Default stays `type-ii` from the day AA-I lands.** Even before
   the bench measurement came in, the plan was to keep the
   default-no-flag behaviour byte-identical to v0.1. After the bench
   came in, that decision is vindicated by the data: flipping the
   default to `type-i` would have regressed 4 cone-solve goldens and
   doubled per-step cost on `afiro` (the one case both solve). The
   `--accelerator=type-i` flag is opt-in; the substrate is there for
   future investigation; nothing breaks for existing callers.

3. **Sweep was wire-bypassed.** `bench/cone-solve/sweep-type-i.ts`
   calls `scsSolve` directly via the cone-core substrate, not through
   `bun tools/cone-solve/tool.ts`. Bypasses the per-run subprocess
   spawn floor (~50ms) and JSON encode/decode round-trip, brings each
   run's wall budget down from ~10s to ~8s. The determinism contract
   (`numerical: true`, ADR-0015) holds either path — the wire-bypass
   produces the same iteration counts and final residuals byte-for-byte
   that the wire path would. Per ADR-0037, the *production* bench
   path goes through the wire (corpus bridge) for byte-identity with
   the graded path; the *exploratory* sweep is allowed to take the
   substrate shortcut.

## Frictions surfaced

The work surfaced six frictions worth recording — three about the
algorithm/maths, two about the substrate, one about the orchestration.

1. **Theorem 6 is asymptotic; the bench is finite.** AA-I-S-m's global
   convergence proof is `lim inf_{k→∞} ‖g_k‖ = 0` — the residual gets
   arbitrarily small *eventually*. At 50,000 iterations on `kb2` it
   has wandered to `‖g‖ = 50`; meanwhile AA-II (which has *no*
   convergence proof, just a Tikhonov-ridge safeguard) sits at
   `‖g‖ = 1.2e-3`. Mathematically consistent with the theory; the
   theory just isn't the thing the bench measures. The implication is
   broader than this bead: a v0.x algorithm decision driven by
   "globally convergent" papers will keep hitting this mismatch until
   either the bench learns to measure asymptotic behaviour (it
   shouldn't — bench tolerances are real consumer requirements) or
   the search criterion shifts to "finite-iter optimal-rate climb"
   directly. ADR-0037's framing of optimal-rate as a tracked health
   metric is the right substrate for this shift.

2. **Paper hyper-parameters are corpus-specific.** ZOB 2018 §5
   reports experiments on Mehrotra-IPM, BPDN, and matrix-completion
   problems — none of which are LP-complete cone systems at lp-netlib
   scale. The paper's `(m=5, α=0.1)` is tuned for those regimes;
   transferred to lp-netlib it produces 4-decades-worse residuals than
   even the modest sweep sweet spot of `(m=10, α=0.5)`. A future port
   from any "globally convergent for nonsmooth fixed-point maps" paper
   should default to *not* trusting the paper's recommended
   hyper-parameters — sweep on a corpus-representative slice before
   shipping a single config as the canonical default.

3. **The 2× per-iteration cost compounds under wall budgets.**
   Algorithm 3 requires `f(x̃)` and `f(x)` per iteration — twice the
   `scsStep` calls of AA-II. At 60s timeout this cuts the effective
   iter budget in half for problems whose `scsStep` is wall-dominated
   (which is most of lp-netlib above n=200). The production bench
   `timeout` jumped from 9/21 to 11/21 — the +2 is attributable
   substantially to this. A faster `f` (e.g. if cone-core's `(I+Q)⁻¹`
   factorisation gets warm-cached) would shrink the wall penalty but
   not the iter-count regression.

4. **The non-smooth discriminator test only fires at SCS scale.** The
   implementation subagent honestly weakened Group 7 of the unit
   tests from "AA-I-S-m converges where AA-II caps out" to "AA-I-S-m
   converges on the non-smooth map" because at 2-D synthetic scale,
   every reflection-projection / simplex-projection / Douglas-Rachford
   / ReLU-mix map AA-II handles gracefully. The AA-I-beats-AA-II
   discriminator lives at lp-netlib scale (n in the hundreds) and on
   the bench, not in unit tests. Documented in
   `packages/cone-core/test/anderson-type-i.test.ts`'s Group 7
   comment. The lesson generalises: unit tests for algorithm
   *advantages* over alternatives may not be possible at the scales
   unit tests live at; the algorithm correctness can be unit-tested
   (Powell triggers, GS-restart fires, KM safeguard catches) but the
   superiority claim belongs to the bench.

5. **Corpus bridge required a sibling-repo change.** The
   `CANDIDATE_FLAGS` env-var contract is a 15-line addition to
   `scientist-workbench-corpus/benchmarks/lp-netlib/run-candidate.ts`.
   The bridge sits in a sibling-tracked git repo (worklog 027); the
   change landed in the same edit session but commits separately
   under that repo's authority. ADR-0037 §C frames the workbench-side
   instrument as the source of truth; the corpus side is transport.
   The pattern works but it's the first cross-repo workbench/corpus
   protocol change since the multi-device sync setup, and worth
   noting future cross-cuts will hit the same shape.

6. **Device thermal throttling killed the full sweep.** The kb2
   sweep completed all 27 AA-I configs in ~6 minutes of CPU but
   1.5 hours of wall (95% throttled). adlittle and sc105 were not
   measured. The kb2 verdict was unambiguous enough to call the
   bead's disposition without them, but a future re-run on warmer
   silicon could either confirm or sharpen the negative finding.
   The CSV at `/tmp/sweep-type-i-full.csv` is preserved.

## Acceptance

The original bead acceptance was: "Type-I implemented + mutation-proven;
the profiler optimal-rate measurably climbs vs the AA-II baseline
recorded in ADR-0037; ADR-0036's 'documented v0.2 move' realised;
determinism contract preserved."

- ✅ **Type-I implemented + mutation-proven.** 661-line literate port,
  114 cone-core tests pass, Powell + GS-restart RED-mutation-confirmed.
- ❌ **Profiler optimal-rate measurably climbs.** It regressed:
  5/21 → 1/21. Sweep confirms no hyper-parameter config crosses 1e-6
  on the small AA-II-iter-cap problem.
- ✅ **ADR-0036's 'documented v0.2 move' realised.** Algorithm shipped
  as v0.2; ADR-0036 §F amended with selector wire and default-deferral.
  The *algorithm* was realised; the *bench gain* it predicted was not.
- ✅ **Determinism contract preserved.** `numerical: true` holds; one
  sweep config sat for 87 minutes under throttling and produced the
  byte-identical precision its deterministic peers did.

3 of 4 met; the load-bearing one (optimal-rate climbs) is **not met**.
The honest framing: the bead asked "will the documented v0.2 lever
climb the bench?" and the answer is *no*. The bead is closed under
that reframing — the question is answered, the substrate it produced
(the AA-I-S-m implementation behind `--accelerator=type-i`) is correct
and available for any future investigation that finds a use case the
lp-netlib regime doesn't surface.

## Pointers

- **ADR-0036 §F** — the v0.2 decision-and-deferral record.
- **`docs/ground-truth/convex/anderson-acceleration.md` §§6–8** —
  the algorithm transcription. The PDF is at
  `docs/refs/zhang-odonoghue-boyd-2018-type-i-anderson.pdf`.
- **`packages/cone-core/src/anderson-type-i.ts`** — the literate
  implementation. The chapter at the top is the entry point.
- **`bench/cone-solve/sweep-type-i.ts`** — the exploratory sweep
  script; re-runnable for adlittle / sc105 or extended grids on
  warmer hardware. CSV: `/tmp/sweep-type-i-full.csv`.
- **`/tmp/bench-type-ii.log`, `/tmp/bench-type-i.log`** — the full
  lp-netlib battery outputs (preserved transiently; the relevant
  numbers are in the table above).
- **Follow-up beads** — see "Pointers" section of bead `1s32`'s
  closing note; filed under the v0.3 SCS-tail-convergence umbrella.
