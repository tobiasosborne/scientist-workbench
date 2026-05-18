# ADR-0037 — Universal-tier bench discipline: the honest-scope gate for first-order solvers

**Status:** Accepted — 2026-05-14.
**Beads:** `scientist-workbench-2ivi` (`tools/cone-solve` — this ADR
resolves the bench-reconciliation that left the bead in progress after
worklog 113). `scientist-workbench-1s32` (the v0.2 algorithm lever —
Type-I Anderson + Powell globalisation — filed by this ADR, decision E).
`scientist-workbench-rgl8` (the `achieved_precision` over-claim the
profiler caught and this work fixed — see "Ground truth" below).
`scientist-workbench-oxuk` (the deeper SCS-termination issue `rgl8`'s
fix surfaced).
**Authors:** tobiasosborne + Claude Opus 4.7 (1M context).
**Related:** ADR-0030 (the convex-cone solver tier — §B's universal /
specialist split is the architecture this ADR holds the bench
accountable to); ADR-0028 (bench migration to corpus — the suites this
ADR re-assigns live corpus-side); ADR-0036 (Anderson acceleration —
this ADR *extends* its reasoning with worklog 113's "AA-II is not enough
on the nonsmooth tail" finding; it does not override it); ADR-0003
(three output categories — `iter-cap` is a record-with-flag, the honest
shape for routine non-success); worklog 089 (the LP-bench onramp whose
`cone-solve` gate this ADR corrects); worklog 113 (the `cone-solve`
build whose grading surfaced the open question); worklog 114 (the
reconciliation work).

## Context

`tools/cone-solve` shipped in worklog 113: the universal-primary cone
solver over the `@workbench/cone-core` SCS substrate. It is a
*correct, contract-conforming* tool — seven artefacts, 14 goldens, a
passing `--test` hook, and a substrate with 72 mutation-proven tests.
But bead `2ivi` was left **in progress**, not closed, because grading
it against the corpus `lp-netlib` suite produced `0/21`, and worklog
113 surfaced that result as an open project-direction question with
three framed options ("re-profile the verifier to 1e-6, accept a
partial gate, or invest in Type-I + Powell globalisation").

That framing conflated three distinct things. This ADR untangles them.

### The three things, untangled

**1. A recording error.** Worklog 089 set `cone-solve`'s v0.1 bench
gate at "21/21 on `lp-netlib` + 29/29 on `lp-small`" — and set the
*identical* gate for the LP specialist `tools/lp-solve`. That is the
error. ADR-0030 §B is unambiguous: `cone-solve` is the **universal**
primary with a documented **1e-6** accuracy ceiling; `lp-solve` is the
**specialist** that reaches 1e-12. The `lp-netlib` verifier hard-codes
a **1e-8** relative tolerance on every KKT-residual check
(`verifier_protocol.md` checks 4/6/7/8/9) — that is structurally the
*specialist's* gate. Worklog 089 handed the universal tool the
specialist's bar. The corpus itself never made this mistake:
`benchmarks/lp-netlib/run-candidate.ts` **defaults `CANDIDATE_TOOL` to
`lp-solve`**; worklog 113's `0/21` came from explicitly overriding it
to `cone-solve` — running the universal tool against a gate it was
never specified to meet.

**2. An algorithm limitation, already known.** Even at its *own* 1e-6
ceiling, plain SCS — with Ruiz scaling (worklog 112 §5) and Type-II
Anderson acceleration (ADR-0036) — does not reach optimality on the
medium tier of NETLIB-LP within a practical iteration budget. This is
not a `cone-solve` bug; it is the SCS algorithm class. ADR-0036 §A
already named the cause (AA-II collapses *smooth* fixed-point tails,
but the SCS map is *nonsmooth* — the cone projection has kinks) and the
remedy (Type-I Anderson + Powell-type globalisation, the actual
contribution of Zhang-O'Donoghue-Boyd 2018 for the nonsmooth case).

**3. A genuine question:** given (1) and (2), what *is* `cone-solve`'s
v0.1 release gate, and how is its relationship to `lp-netlib` recorded
honestly? That is what this ADR decides.

### Ground truth — the universal-tier profile, and the bug it caught

`cone-solve` was profiled against the 21 `lp-netlib` problems at its
*own* contract (`precision = 1e-6`), scored by the honest-scope
contract rather than the specialist's tolerance bar. The profiler
(`bench/cone-solve/profile-lp-netlib.ts`) reuses the corpus bridge
verbatim — byte-identical wire path to the graded path — and
**independently recomputes** the three §C-wire-form KKT residuals
(`r_p`, `r_d`, `r_c`, exactly `verifier_protocol.md`'s definitions)
from the candidate's own returned `(x, dual, slack)`.

That independent recomputation did its job: it caught a real Rule-8
over-claim. On `scsd1`, `cone-solve` reported `achieved_precision =
9.35e-7` while the true §C-wire-form residual was `2.88e-6` — a ~3×
under-claim, past the verifier's 2× summation-drift slack. Root cause
(bead `rgl8`): the tool forwarded `cone-core`'s `achievedPrecision`,
which is the O'Donoghue §3.5 residual of the *internal embedded
translated* problem in 2-norm — not the §C-wire-form residual of the
*recovered* point the tool actually returns. `cone-core` was not wrong
(it honestly describes *its* form); the §C-form residual is a
tool-layer concern. The fix has `cone-solve` recompute
`achieved_precision` as the §C `max(r_p, r_d, r_c)` of the returned
point. Fixing it surfaced a deeper coherence issue — `cone-core`'s
embedded-form termination test can fire `optimal` while the recovered
§C point's residual still exceeds `precision` — handled by a coherence
guard (`optimal` re-labels to `iter-cap` when the honest §C residual
exceeds the request) and filed for a proper fix as bead `oxuk`.

(An even earlier cut of the profiler used a *naïve* check —
objective-distance-to-oracle — and false-flagged `blend`. That was a
*profiler* bug: it conflated the KKT residual with the objective's
distance to the true optimum; a ~1e-6 KKT residual consistently yields
a few×1e-6 objective error for a first-order method, which is expected,
not a lie. The profiler was corrected to the independent KKT
recomputation above — the actual Rule-8 lie detector — which is what
then caught the real `scsd1` over-claim.)

The honest profile, with the fixed tool:

```
profile @ precision=1e-6, max_iter=50000, per-case wall budget 180s
  optimal   3/21   afiro, sc50a, sc50b   (reached 1e-6 within budget)
  iter-cap  18/21  honest non-convergence — incl. blend, scsd1, whose
                   SCS-internal termination fired but whose §C residual
                   (1.55e-6, 2.88e-6) exceeds 1e-6: re-labelled by the
                   rgl8 coherence guard
  other     0/21

honesty checks (zero-tolerance):
  wrong-status            0  ✓   no status is ever wrong
  over-claimed-precision  0  ✓   achieved_precision never under-claims the
                                 independently recomputed §C KKT residual
```

Iteration counts to reach the 1e-6 ceiling, where genuinely reached:
`afiro` 1711, `sc50b` 21259, `sc50a` 37565. The finding is structural
and matches ADR-0036 / worklog 113: a first-order method solves the
small / well-conditioned cases and honestly caps on the rest. **What it
never does — now — is lie**: zero wrong statuses, zero over-claimed
precision, and `optimal` genuinely means `achieved_precision ≤
precision`. That is the property that matters, and the profiler is the
instrument that both proved it and forced it.

## Decision

### A. `lp-netlib` (and `lp-small`) is the LP **specialist's** bench

The 1e-8-tolerance `lp-netlib` / `lp-small` suites are
`tools/lp-solve`'s gates, and only `lp-solve`'s. The corpus already
encodes this (`run-candidate.ts` defaults `CANDIDATE_TOOL=lp-solve`).
The worklog-089 "`cone-solve` 21/21 `lp-netlib`" target is **withdrawn**
as a category error; it was never derivable from ADR-0030 §B and should
not have been written. No corpus change is required — the verifier
stays exactly as it is, gating the tool it was built for. The epic's
remaining specialist gate (`lp-solve` ≥ its threshold on `lp-netlib`)
is untouched and tracked under bead `wx3m`.

### B. `cone-solve` v0.1 is gated by its seven-artefact contract

`cone-solve`'s v0.1 release gate is the same gate every other tool in
the workbench answers to: schema + examples + invariants + a passing
`--test` hook + goldens + README + `def`, plus the 72 mutation-proven
tests of its `@workbench/cone-core` substrate. The `--test` hook's
`honest-precision` invariant — `achieved_precision` never under-claims
the true max relative KKT residual — *is* the honest-scope guarantee,
verified per-tool; bead `rgl8` made it a *real* numerical check in
`smokeTest` (it had been declared `machine_checkable` but never
exercised — Rule 7) after the profiler caught the over-claim it now
guards against. With `rgl8` and its coherence guard landed,
`cone-solve` meets this gate today. Bead `2ivi` closes on it.

A universal first-order solver is **not** release-gated on an
optimality *rate*. ADR-0003 is explicit: `iter-cap` carrying a
best-effort iterate and an honest `achieved_precision` is a
record-with-flag — the correct shape for routine non-success, not a
failure. A tool that returns `status: "iter-cap", achieved_precision:
3.1e-5` has given the agent an honest, actionable answer. The failure
mode Rule 8 forbids is the *lie* — `status: "optimal"` on a 3e-5
iterate, or an over-claimed `achieved_precision`. The profile confirms
`cone-solve` never does either.

### C. The `lp-netlib`-at-1e-6 profile is a tracked health metric

`bench/cone-solve/profile-lp-netlib.ts` is the durable artefact of this
reconciliation. It runs the universal tool at its own 1e-6 contract and
reports:

- the **optimal-rate** at 1e-6 within a stated `(max_iter, wall)`
  budget — a *health metric* that climbs as the algorithm improves, not
  a pass/fail bar;
- two **zero-tolerance honesty checks** — `wrong-status` and
  `over-claimed-precision` — which *are* pass/fail: a violation of
  either is a Rule-8 bug, full stop.

The script exits non-zero only on an honesty-check violation, never on
a low optimal-rate. It is the instrument by which the v0.2 algorithm
lever (decision E) is measured: the same script, the same problems, a
higher optimal-rate.

### D. `cone-solve`'s `max_iter` default reflects the convergence finding

ADR-0030 §A.1 set the SCS-ADMM `max_iter` default at `2500` — a guess
made before the convergence behaviour was characterised. The profile
shows it is wrong: of the three genuine 1e-6 optima, only `afiro`
(1711 iterations) is reachable at `2500`; `sc50b` (21259) and `sc50a`
(37565) would `iter-cap` on problems the method *can* in fact solve.
The default is raised to **`50000`** (in `DEFAULT_SCS_OPTS`, `cone-core`
`scs.ts`) — the budget at which the profile's optimal set is genuinely
reached and the rest honestly cap, so the no-flag default behaviour
matches the documented profile rather than capping solvable problems.
This supersedes ADR-0030 §A.1's `2500` figure for the SCS-ADMM path.
`max_iter` remains a standard flag (ADR-0011); an agent that wants a
tighter runtime bound or a longer budget passes it explicitly (ADR-0030
§A.1, "agents pass it explicitly when they care"). The blast radius is
small: `cone-core`'s convergence tests use explicit `maxIter` values
and its validation tests spread-and-override, so none churn; and every
`cone-solve` golden problem converges in under ten iterations, so the
default change moves no golden. (The 14 goldens *are* regenerated this
session — six of them — but for the `rgl8` `achieved_precision` fix,
not the `max_iter` change.)

### E. Type-I Anderson + Powell globalisation is the v0.2 lever — filed, not blocking

The way the optimal-rate climbs is the algorithm work ADR-0036 §A
already named: Type-I Anderson acceleration with Powell-type
regularisation and the Gram-Schmidt restart globalisation
(Zhang-O'Donoghue-Boyd 2018, eq 10–14) — the method built for the
*nonsmooth* fixed-point map that AA-II does not crack. This is filed as
bead `scientist-workbench-1s32` with the staged-reference-first
acceptance criterion (`docs/refs/` does not yet carry
Zhang-O'Donoghue-Boyd; Law 1 applies).
It is **v0.2 work**, not a `2ivi` blocker — `cone-solve` v0.1 is a
correct, shippable, honest tool without it (decision B), and the
profile (decision C) is exactly how its arrival will be measured.

## Why rejected alternatives

**Re-profile the `lp-netlib` verifier to 1e-6 for `cone-solve`.** This
is the option worklog 113 floated and ADR-0036 already rejected as a
*primary fix* — correctly: lowering the verifier's bar does not change
the convergence behaviour, and even at 1e-6 plain SCS caps on the
medium tier. This ADR does not re-profile the verifier. It does
something different: it observes that `cone-solve` was *never* in the
verifier's jurisdiction (decision A) — the verifier gates `lp-solve`,
unchanged. The 1e-6 number lives in the *profile* (decision C), which
is not a gate.

**Accept a "partial gate" — e.g. "`cone-solve` passes if ≥ N/21."**
Rejected: it reintroduces the category error in softer form. A
universal first-order solver's optimal-rate is a metric that *moves*;
freezing any N as a release bar either blocks shipping a correct tool
(N too high) or rubber-stamps regressions (N too low). The release gate
is the contract (decision B); the rate is a tracked metric (decision
C). Those are different kinds of thing and must not be merged.

**Block `2ivi` on Type-I + Powell.** Rejected: it conflates "correct
and shippable" with "as fast as we eventually want". `cone-solve` v0.1
is contract-conforming and honest *now*. Holding the bead open until a
multi-week v0.2 algorithm port lands would leave the universal-primary
tool of the epic unshipped for no contract reason — and would starve
the work that actually grows the tool into its purpose: the SOC + PSD
cone projections (`0wc7`), which make `cone-solve` a *universal* solver
rather than an LP-only one. The universal tool's worth is mixed-cone
problems no specialist covers, not NETLIB-LP — which is the
specialist's home turf, and grading the universal tool primarily there
is the worklog-089 category error one more time.

**Switch `cone-solve` off SCS.** Out of scope and against ADR-0030 §B
— SCS *is* the universal primary's algorithm; the interior-point
methods are the specialists (`lp-solve` IPM lane, `sdp-solve`). Already
rejected in ADR-0036.

## Bench-jurisdiction summary

| suite | tolerance | candidate (gate) | `cone-solve`'s relationship |
|---|---|---|---|
| `lp-netlib` | 1e-8 KKT | `lp-solve` (specialist) | tracked 1e-6 *profile*, not a gate |
| `lp-small` | 1e-8 KKT | `lp-solve` (specialist) | tracked 1e-6 *profile*, not a gate |
| `sdp-sdplib` | per suite | `sdp-solve` (specialist) | future profile when SOC/PSD land (`0wc7`) |
| (per-tool contract) | — | **`cone-solve` itself** | **the v0.1 release gate** |

## Pointers

- `bench/cone-solve/profile-lp-netlib.ts` — the universal-tier profiler
  (decision C); the durable artefact of this reconciliation.
- ADR-0030 §B — the universal / specialist architecture this ADR holds
  the bench accountable to; §A.3 — the `iter-cap` honest-status class.
- ADR-0036 — the AA decision; §A names Type-I + Powell as the v0.2
  move (decision E).
- ADR-0003 — `iter-cap` as a record-with-flag, the honest shape for
  routine non-success.
- Beads: `2ivi` (closed by this ADR), `1s32` (Type-I + Powell, v0.2
  lever, decision E), `rgl8` (the `achieved_precision` over-claim the
  profiler caught — fixed this session), `oxuk` (the deeper
  SCS-termination issue `rgl8` surfaced — filed for a proper fix).
- worklog 089 (the withdrawn gate), worklog 113 (the build + the open
  question), worklog 114 (this reconciliation).
- `docs/ground-truth/convex/scs-algorithm.md`,
  `docs/ground-truth/convex/anderson-acceleration.md`.
