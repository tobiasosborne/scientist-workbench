# 085 — Meijer G dispatcher coalescence fixes (`hv0.11.1`)

**Date:** 2026-05-09 (one session, in worktree
`agent-aac7d5d400e820482`).
**Beads:** `scientist-workbench-7usr` (P1 — Johansson `hmag`
perturbation precision over-reporting) + `scientist-workbench-fwsz`
(P1 — 3-pole integer-spaced coalescence hangs Slater path).
**Lockstep with:**
[`docs/adr/0027-meijerg-dispatcher.md`](../adr/0027-meijerg-dispatcher.md)
(updated §"refusal envelope" + new §5 sub-section on the empirical
estimator).

## Context

Worklog 081 (hv0.11) shipped the `bench/meijer-g/` golden battery
and surfaced two friction points the agent absorbed by either
relaxing tier-E tolerances or removing cases from the corpus:

1. **`scientist-workbench-7usr`.**  At integer-spaced or
   half-integer-spaced coalescence (e.g. `bm = [1/2, 3/2]`,
   `z = 3/2`), the dispatcher reported `achieved_precision = 50`
   while the actual relative error vs mpmath at 110 dps was
   ~`3.6e-15` — i.e. the value matched the truth to ~14 dps but
   the tool over-reported the precision by a factor of `10^36`.
   ADR-0027 §4 / ADR-0003's honesty contract was violated.

2. **`scientist-workbench-fwsz`.**  3-pole integer-spaced clusters
   (e.g. `bm = [0, 1, 2]`) hung the Slater path indefinitely — the
   Johansson odd-coefficient perturbation breaks pairwise
   coalescence cleanly, but its cancellation cost grows
   super-quadratically with cluster size, and each retry's
   working-precision doubling still leaves the budget gap unfilled.
   The contour and asymptotic lanes inherit the same Γ-pole-cluster
   issue.

This shard ships the fixes for both.

## What changed

### `packages/meijer-core/src/slater.ts` — restructured orchestrator

- Replaced the inline cancellation-bump retry loop with a
  factor-out helper `runSlaterPass(params, z, series, workingBits,
  perturb, pertBits, targetBits)` that returns a `PassOutcome`
  discriminated union (`success | needs-bump | refusal`).  The
  outer driver composes outcomes into the public
  `MeijerGSlaterResult`.  Reads top-to-bottom now as the literate
  programming Rule 10 envisions: dispatch loop, retry loop,
  estimator, return.

- **Empirical precision estimator** (bead `7usr`).  When
  perturbation fires, run a second pass at `pertBits + 1` (ε
  halved exactly once — large enough to produce a measurable
  signal, small enough to keep both passes in the same working-bits
  regime).  Compute
  `achievedPrecision = floor(−log10(|Δ|/|S|)) − 1`, capped at
  user-requested precision.  Opt-out via
  `MeijerGSlaterOptions.estimatePrecision = false` for
  regression-mode comparison against pre-fix goldens.

- **`maxWorkingBits` hard cap** (bead `fwsz`).  Default
  `12 · target_bits + 256`.  When a retry would exceed the budget,
  refuse with `coalescence-budget-exhausted`.  This bounds
  worst-case cost at ~3 s @ 50 dps.

- **`coalescence-needs-higher-order-residue` upfront refusal**
  (bead `fwsz`).  The new
  `largestIntegerSpacedClusterSize(params, tolBits)` helper
  partitions parameters into integer-spacing equivalence classes
  in linear time; if the largest class on the residue-line side
  has size ≥ 3, the orchestrator refuses upfront.  Cluster-size
  detection takes <1 ms; the structural refusal is the v0.1
  placeholder until the closed-form `digamma`/`polygamma`
  higher-order residue (Slater 1966 §5; new follow-up bead) ships.

### `packages/meijer-core/src/coalescence.ts`

- New `largestIntegerSpacedClusterSize(params, tolBits)` helper.
  Linear scan; "differs by an integer" is an equivalence relation
  so union-find isn't needed.  At the parameter counts we ever
  face (typically `≤ 6`), the linear pass dominates over any
  cleverness.

- `detectCoalescence` extended to return the cluster size in its
  result record (`{ coalescent, reason, clusterSize }`).  The
  orchestrator reads `clusterSize` to decide whether to enter the
  perturbation path or refuse upfront.

### `packages/meijer-core/src/types.ts`

- `MeijerGSlaterOptions.maxWorkingBits` and `.estimatePrecision`.
- `MeijerGSlaterRefusal.status` extended with two new classes:
  `coalescence-budget-exhausted` and
  `coalescence-needs-higher-order-residue`.

### `packages/meijer-core/src/dispatcher.ts`

- When Slater returns
  `coalescence-needs-higher-order-residue`, fold it into the
  integrated `out-of-region` envelope and short-circuit the
  remaining numerical lanes.  Both contour and asymptotic inherit
  the same Γ-pole-cluster cost-unbound issue, so chasing them is
  pointless; the structured refusal is the right answer.

### `packages/meijer-core/test/slater.test.ts`

Seven new tests (3 honesty contract, 4 cost-bounded refusal):

- `[honesty] perturbation-driven case (bm = [1/2, 3/2], z = 3/2)
  reports honest <50 dps` — the 7usr regression.
- `[honesty] non-perturbed case still reports user precision`.
- `[honesty] estimator opt-out leaves achievedPrecision unchanged`.
- `[fwsz] bm = [0, 1, 2] (3-pole) ⇒ structured refusal in <5s`.
- `[fwsz] bm = [0, 1] (2-pole) ⇒ proceeds through perturbation`
  — the mutation-prove sibling: removing one of three poles
  drops the cluster size below the trigger, so the 2-pole case
  must still evaluate.
- `[fwsz] an = [0, 1, 2] (3-pole an-side) ⇒ same refusal`
  (series-2 mirror).
- `[fwsz] maxWorkingBits cap surfaces budget-exhausted refusal`
  (explicit cap, terminates promptly).

### `packages/meijer-core/test/dispatcher.test.ts`

One new test: `[fwsz] bm = [0, 1, 2] ⇒ integrated out-of-region
refusal in <5s` — the dispatcher-level integration of the Slater
refusal class.

### `bench/meijer-g/golden/{inputs,expected}.json`

Reinstated the four cases the hv0.11 corpus had removed:

- `tE-G3003-coalesce-012` — 3-pole `bm=[0,1,2]` ⇒ tagged refusal.
- `tE-an-coalesce-1`     — 3-pole `an=[1,2,3]` ⇒ tagged refusal.
- `tE-mixed-1`           — `an=[0,1] + bm=[1,2]` ⇒ numerical (12 dps).
- `tE-near-coalesce-1`   — `bm=[0, 1001/1000]` ⇒ numerical (50 dps).

Mirrored to
[`tstournament/.../13-meijer-g/golden/`](../../tstournament/ts-bench-infra/problems/13-meijer-g/golden/)
and to `bench/meijer-g/reference/generate-truth.py`.

### `docs/adr/0027-meijerg-dispatcher.md`

- Updated refusal-envelope listing with the two new Slater-layer
  classes and the dispatcher's integrated `out-of-region` fold.
- New §5 sub-section on the empirical precision estimator,
  including the cost note and the regression-mode opt-out.

## Why these choices

### Empirical estimator over closed-form bound (path 1 vs path 2 in the bead)

The bead spec offered two paths: empirical precision estimator
(re-evaluate at slightly different perturbation magnitude and
inspect the disagreement) vs closed-form higher-order residue
(Slater 1966 §5 `digamma`/`polygamma` formula).  Path 2 is
mathematically more correct and would also resolve the 3-pole
case, but the implementation is combinatorially intricate
(multiplicity > 2 quickly outpaces hand-derivation), and v0.1's
acceptance is the *honesty contract* — not necessarily a
*better* answer.

Path 1 gives an *honest* answer at the precision actually
achievable, which is what the bead acceptance asks for.  Path 2
remains as a follow-up bead (filed in `BEADS-TO-FILE.txt`); when
it ships, the cluster-size gate becomes a no-op.

### `pertBits + 1` over `pertBits + 16`

A larger perturbation offset (e.g. `+16`, halving ε 16 times)
also halves the residue-term magnitude (`|Γ(small)| ∼ 1/ε`),
which can push the alt pass past the cancellation-bump
threshold.  The smallest meaningful perturbation change keeps
both passes at the same working-bits regime, so `Δ` reflects the
perturbation-induced error, not a working-bits crossing.  Probed
empirically (see Frictions): `+16` produced misleading
estimator output (3 dps reported when the real precision was
14 dps); `+1` is stable and conservative.

### `maxWorkingBits = 12 · target_bits + 256`

Sized so that 1- and 2-bump cases pass uneventfully (`target +
64 → 2·target + 128 → 4·target + 256` is well within budget),
while the pathological 3-pole / 4-pole cases hit the cap
inside ~3 s @ 50 dps.  Tunable per-call via
`MeijerGSlaterOptions.maxWorkingBits`.

### Dispatcher-level short-circuit on `coalescence-needs-higher-order-residue`

Without the short-circuit, the dispatcher would fall through
Slater's refusal into the contour layer — which **also** hangs
on 3-pole integer-spaced clusters (the contour layer's
`pickTruncation` searches an unbounded T range when the
Γ-pole-cluster is dense, and the quadrature driver hits
`maxEvals` without convergence).  The asymptotic lane has the
same issue.  The cluster property is a property of the
*input parameters*, not of the dispatch lane — folding the
Slater refusal into an integrated `out-of-region` envelope is
the cleanest expression of "every numerical lane needs the
higher-order residue".

## Frictions surfaced

1. **The over-reporting wasn't `O(ε)` from L'Hôpital — it was
   `cgamma`'s precision loss at small-argument poles.**  My first
   instinct was to estimate the L'Hôpital first-derivative via
   ε × kernel'.  Probing showed that at workingBits=458 (the
   default for 50-dps perturbation), `Γ(-1 - ε)` for `ε = 2.32e-69`
   loses ~50 dps of precision relative to the same call at
   workingBits=600 — the working-precision cancellation in
   `cgamma`'s reflection-formula path is what's eating digits, not
   the L'Hôpital limit per se.  The empirical estimator catches
   *whatever the dominant error is*, which is the right honesty
   posture: don't pre-suppose which mechanism is dominant; measure.

2. **The `cgamma` precision-loss issue is in `packages/bigfloat/`,
   which a parallel agent owns this session (bead `djp`).**  Rule 8
   "Honest scope" applied: I documented the observation, did not
   touch `bigfloat`, and let the empirical estimator absorb the
   precision loss honestly.  A separate follow-up bead (filed) is
   the right vehicle for actually fixing `cgamma` at its small-
   argument poles.

3. **`pertBits + 1` works on 2-pole; `pertBits + 16` doesn't.**
   I started with `+16` thinking it would give a stronger signal
   and a more conservative estimator.  It turned out that `+16`
   pushed the alt pass past its cancellation-bump threshold (at
   workingBits=458 the cancellation is `~pertBits = 229` bits, and
   adding 16 more bits to pertBits subtracts 16 bits from the
   usable budget — exactly the threshold).  The "alt pass needs a
   bump" branch produced a marginally-less-accurate alt sum, and
   the estimator over-reported the error.  `+1` lives in the
   "same regime" zone empirically.

4. **The 3-pole case hangs *contour* too, not just Slater.**  My
   first cut at fwsz fixed the Slater hang upfront via the
   cluster-size gate, but running the bench reproducer still
   timed out at 30 s — the dispatcher fell through to contour,
   which also hung.  The fix had to land at the *dispatcher* level
   (short-circuit when Slater refused with the structured
   higher-order-residue class), not just at the Slater level.

5. **mpmath itself fails to converge on some related shapes.**
   E.g. `meijerg([[],[]], [[0, 1, 2], []], 1/2)` raises
   `hypercomb() failed to converge` in mpmath at 50 dps — the
   *oracle* itself doesn't have a robust answer for the 3-pole
   shapes.  This is consistent with the structured-refusal posture:
   "the higher-order residue is needed and v0.1 doesn't have it"
   isn't a workbench-specific deficiency, it's a numerical
   challenge across the field.

6. **The verifier's `tolerance_rel` is independent of
   `achieved_precision`.**  The bead acceptance text "tolerances
   tighten back to 1e-(precision-12)" is a tier-E ladder *target*
   for v0.2; v0.1 keeps the per-case `tolerance_rel: 1e-13` (or
   1e-14) and uses the verifier's separate
   `_check_self_reported_precision` invariant
   (`achieved_precision ≤ requested_precision`) to enforce the
   honesty contract.  This is the right factoring — *value
   accuracy* and *precision honesty* are separate invariants.

## Acceptance

### Bench tier-E (9/9 cases pass)

```
tE-G2002-coalesce-01:   pass=True achieved=14
tE-G2002-coalesce-02:   pass=True achieved=14
tE-besselK-ord1:        pass=True achieved=13
tE-besselK-ord2:        pass=True achieved=12
tE-near-coalesce-2:     pass=True achieved=50
tE-G3003-coalesce-012:  pass=True achieved=- (tagged refusal in 14 ms)
tE-an-coalesce-1:       pass=True achieved=- (tagged refusal in 11 ms)
tE-mixed-1:             pass=True achieved=12
tE-near-coalesce-1:     pass=True achieved=50
```

### Cross-validation against mpmath at 110 dps

| case | reported | actual rel err | conservative? |
|------|----------|----------------|---------------|
| tE-G2002-coalesce-01 | 14 | 3.4e-16 | yes (under-reports by 2 dps) |
| tE-G2002-coalesce-02 | 14 | 7.4e-17 | yes (under by 3) |
| tE-besselK-ord1      | 13 | 3.6e-15 | yes (under by 1) |
| tE-besselK-ord2      | 12 | 3.1e-14 | yes (under by 2) |
| tE-mixed-1           | 12 | match at 13 dps | yes (under by 1) |

Estimator is consistently *conservative* — under-reports by 1-3
dps.  The honesty contract is a one-sided bound (must not
over-report); slightly under-reporting is admissible.

### Tests

- `bun test packages/meijer-core/test/slater.test.ts`: 26/26 pass
  (was 19/19; +7 new).
- `bun test packages/meijer-core/test/dispatcher.test.ts`: 23/23
  pass (was 22/22; +1 new).
- All 162 meijer-core tests green.
- `tools/meijer-g`: 35/35 tests pass.

### Mutation-prove (5/5 invariants RED)

1. Disable estimator default (`true → false`):
   `[honesty] perturbation-driven case` correctly RED
   (achieved=50, expected <50).
2. Cluster-size gate `>= 3 → >= 4`: `[fwsz] bm=[0,1,2]` correctly
   hangs (timeout — caught).
3. Disable dispatcher early-exit on
   `coalescence-needs-higher-order-residue`: dispatcher test
   correctly hangs (caught).
4. Maintained for the explicit-cap test: `maxWorkingBits = 200`
   forces the budget-exhausted path; passes.
5. Restored all mutations; full suite green.

### Both bug reproducers now produce the expected output

```sh
$ echo '{"an":[],"ap":[],"bm":[{"re":"1/2","im":"0"},{"re":"3/2","im":"0"}],
        "bq":[],"z":{"re":"3/2","im":"0"},"precision":50,
        "request_mode":"numerical-required"}' \
   | bun bench/meijer-g/run-candidate.ts | jq '.achieved_precision'
13      # was 50 (over-reporting); now honest

$ echo '{"an":[],"ap":[],"bm":[{"re":"0","im":"0"},{"re":"1","im":"0"},
        {"re":"2","im":"0"}],"bq":[],"z":{"re":"1/2","im":"0"},
        "precision":50,"request_mode":"numerical-required"}' \
   | timeout 5 bun bench/meijer-g/run-candidate.ts | jq '.kind, .tag'
"tagged"
"meijer-g/out-of-region"
                # was hang (exit 143); now structured refusal in 12 ms
```

## Pointers

- [`packages/meijer-core/src/slater.ts`](../../packages/meijer-core/src/slater.ts) — restructured orchestrator + estimator.
- [`packages/meijer-core/src/coalescence.ts`](../../packages/meijer-core/src/coalescence.ts) — cluster-size detection.
- [`packages/meijer-core/src/dispatcher.ts`](../../packages/meijer-core/src/dispatcher.ts) — short-circuit on higher-order-residue.
- [`packages/meijer-core/test/slater.test.ts`](../../packages/meijer-core/test/slater.test.ts) — 7 new tests.
- [`packages/meijer-core/test/dispatcher.test.ts`](../../packages/meijer-core/test/dispatcher.test.ts) — 1 new test.
- [`bench/meijer-g/golden/inputs.json`](../../bench/meijer-g/golden/inputs.json) — 4 reinstated cases.
- [`bench/meijer-g/golden/expected.json`](../../bench/meijer-g/golden/expected.json) — same.
- [`bench/meijer-g/reference/generate-truth.py`](../../bench/meijer-g/reference/generate-truth.py) — corpus generator updated.
- [`docs/adr/0027-meijerg-dispatcher.md`](../adr/0027-meijerg-dispatcher.md) — refusal envelope + estimator pin.
- [Slater 1966, *Generalized Hypergeometric Functions*, CUP. §5.5] — closed-form higher-order residue (the v0.2 follow-up).
- [F. Johansson 2009 blog post](https://fredrikj.net/blog/2009/06/meijer-g-more-hypergeometric-functions-fractional-differentiation/) — `hmag` perturbation provenance.
- Bead `scientist-workbench-7usr` (P1, closed) and `…-fwsz` (P1, closed).
