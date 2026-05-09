# Worklog 080 — `tools/meijer-g` top-level dispatcher (Layer 7) shipped (`hv0.10`)

**Date:** 2026-05-09 (one session, in worktree
`agent-a60c5f3a583360cec`).
**Beads:** `scientist-workbench-hv0.10` (claimed at session start;
will be closed by the orchestrator from main after worktree merge —
the beads DB is not bootstrapped in this worktree by design). New
ADR-0027.
**Related ADRs:** ADR-0003 (three output categories — happy /
record-with-flag / tagged-boundary). ADR-0010 (`defineTool` /
`runTool` shape). ADR-0012 (in-process composition). ADR-0017
(solution-set shape — `tools/solve`'s discriminated union of
"happy / refused" precedent). ADR-0020 (arbprec tier).
ADR-0021 / ADR-0022 (BigComplex G7K15 driver). ADR-0023 (cas-core
special-function vocabulary). ADR-0025 (Layer 4 symbolic dispatch).
ADR-0026 (Layer 6 Braaksma asymptotic).
**Lockstep with:**
`/home/tobias/Projects/tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`
+ `/home/tobias/Projects/tstournament/WORKLOG.md`.

## Context

**Climax of the seven-layer Meijer G stack.** Layers 3–6 shipped
in worklogs 070, 076, 073, 078; the dispatcher (Layer 7) composes
them into a single integrated tool with cost-ascending dispatch and
honest refusal.

The mathematical surface is too large for any single layer:
- Slater (Layer 3) covers the convergent residue-sum regime;
  refuses in the `|z|≈1` quarantine band.
- Symbolic (Layer 4) covers ~30 closed-form rules; returns
  `no-known-reduction` otherwise.
- Contour (Layer 5) covers the `2(m+n) > p+q` regime with
  separated Γ-pole clusters.
- Asymptotic (Layer 6) covers `|z| ≥ 1, |arg z| < π/2 − π/64,
  n ≥ 1`.

The dispatcher's job is **routing**: each layer's pre-filter is a
fast yes/no, the dispatcher tries layers in cost-ascending order,
the first success wins, and if every layer refuses, the dispatcher
emits a single integrated refusal envelope. ADR-0027 is the
design pin.

The "two principles" applied: a TS expert reading the dispatch
loop sees a flat switch over four lanes; the consumer pattern-
matches once on `kind ∈ {"symbolic", "numerical", tagged}` and gets
the rest of the fields typed. No bespoke per-layer envelope
handling at the call site.

## What changed

### `docs/adr/0027-meijerg-dispatcher.md` — design ADR

11 numbered decisions. Pin points:

1. Cost-ascending order: symbolic → Slater → contour → asymptotic → refuse.
2. Pre-filters per layer (`canUse…`); the dispatcher reads them
   *before* invoking the layer.
3. Principal-branch convention pinned (DLMF §16.17.1):
   `arg z ∈ (−π, π]`. All numerical layers consume `z` and call
   `clog(z, …)`.
4. Two output shapes (plus refusal): `kind: "symbolic"` for AST
   matches, `kind: "numerical"` for arbprec values, tagged for
   refusals.
5. Per-output tier conditioning: symbolic outputs carry no
   `achieved_precision` (exact); numerical outputs do.
6. Schwarz reflection self-test: `G(z̄) = conj(G(z))` for non-cut z
   with real parameters; opt-in via `opts.schwarzCheck` /
   `--schwarz-check`.
7. `--force-method=<lane>` for the method-agreement self-test.
8. `request_mode` field (auto / symbolic-required / numerical-required).
9. Integrated refusal envelope with `ruled_out_methods` list.
10. `arbprec: true` determinism contract.
11. Pre-existing `lc1` runner gap documented.

### `packages/meijer-core/src/dispatcher.ts` — kernel (~880 LOC)

Public surface:

- `meijergDispatch(symbolicParams, numericalParams, zValue, z, precision, opts) → MeijerGDispatchResult`
- `canUseSymbolic`, `canUseSlater`, `canUseContour`, `canUseAsymptotic`
  — per-lane pre-filter predicates, exported.
- Type exports: `DispatchMethod`, `ForceMethod`, `RequestMode`,
  `MeijerGDispatchOptions`, `MeijerGDispatchResult`,
  `MeijerGSymbolicSuccess`, `MeijerGNumericalSuccess`,
  `MeijerGRefusal`, `RuledOutMethod`.

The dispatcher takes both `symbolicParams` (AST view) and
`numericalParams` (BigComplex view). The wire tool builds both
side-by-side; pure-numerical callers can pass `zValue = undefined`
and constrain `requestMode = "numerical-required"` to skip
symbolic.

The dispatch loop is structurally:

```ts
if (trySymbolic && zValue !== undefined) {
  const verdict = canUseSymbolic(symbolicParams);
  if (verdict.ok) { /* run; if matched, return */ ruledOut.push(...); }
}
if (tryNumerical) {
  const verdict = canUseSlater(numericalParams, z, opts.slaterOpts);
  if (verdict.ok) { /* run; if success, finalise; return */ ruledOut.push(...); }
}
if (tryNumerical) { /* contour */ }
if (tryNumerical) { /* asymptotic */ }
return { kind: "refused", class: "out-of-region", ruledOutMethods: ruledOut };
```

Each lane has the same shape. The `finaliseNumerical` helper
attaches the Schwarz-check warning when applicable.

### `packages/meijer-core/src/index.ts` — barrel extension

Re-exports `meijergDispatch` plus the four `canUse*` predicates
and all dispatcher types.

### `tools/meijer-g/` — wire wrapper

Scaffolded via `bun scripts/new-tool.ts meijer-g --uses
meijer-core,bigfloat,protocol,cas-core`. The four files:

- `tool.ts` — defines the seven-artefact contract; literate
  prose comments explaining the dispatcher's intent, the
  branch-cut convention, the I/O shape, and the `lc1` runner
  gap. Two custom flags: `--force-method=<lane>` and
  `--schwarz-check`. The trailing `if (import.meta.main) void
  runTool(def);` keeps the module side-effect-free at import
  time (ADR-0010).
- `tool.test.ts` — 35 wire tests. Output-shape contract,
  method-agreement (8 cases over Slater + asymptotic),
  cross-validation against pinned mpmath truths (3 cases),
  Schwarz reflection (5 cases), branch-cut behaviour (3 cases),
  refusal envelopes (5 cases), bit-determinism (3 cases),
  schwarz-check flag (2 cases).
- `goldens.spec.ts` — 20 golden cases spanning every tier
  of the problem-13 verifier (Tier 0/A symbolic, Tier C/D
  numerical, Tier E borderline, Tier F branch-cut, Tier G
  refusal, Tier H variety).
- `README.md` — agent-facing summary; the "when to use this vs
  the layer-only siblings" call-out.

### `packages/meijer-core/test/dispatcher.test.ts` — package tests (22 tests)

Pre-filter verdicts, dispatch order (symbolic wins), method-
agreement, Schwarz, refusal classes, branch-cut detection,
bit-determinism. Runs in-process so the precision flag is honoured.

### Lockstep doc updates

- Workbench root `README.md` — new catalog row for `tools/meijer-g`.
- `packages/meijer-core/README.md` — new "Dispatcher (Layer 7,
  ADR-0027)" section with usage example; struck-through the old
  "deferred to hv0.10" note.

## Why these choices

**Why cost-ascending dispatch and not "try every method and vote".**
The cost-ascending discipline is fundamental: symbolic is `< 1 ms`
when it matches; asymptotic is `O(precision)` Γ-evaluations;
contour is `O(precision · log|z|)` Γ-evaluations; Slater is
between. Trying all is `5×` the cost of trying just the one that
fits. The pre-filters are fast yes/no checks (one `selectSeries`
call, one shape compare); they're the prediction. Method-agreement
is an *invariant* (the test forces each method via `--force-method`
and asserts agreement) — not a dispatcher primitive.

**Why two parameter views.** The symbolic dispatcher pattern-
matches against AST (`integer`, `rational`, `symbol`,
`expression`); the numerical layers consume `BigComplex`. Passing
both up-front lets the dispatcher route to either surface without
re-encoding. The wire tool's
`bigcomplexToSymbolicValue(bc): Value` recognises integer-real
BigComplex and emits `int(n)` so Bateman §5.6's `b = 0` /
`b = 1/2` rule patterns match; non-integer / complex BigComplexes
round-trip through the BigComplex codec, and the symbolic
dispatcher politely returns `no-known-reduction` for those.

**Why `kind: "symbolic" | "numerical"` instead of `record { expr?,
value?, … }`.** The discriminated-union shape is one switch deep;
the optional-field shape is two-conditional deep. A TS expert reads
the consumer code and gets the rest of the fields typed
straightforwardly.

**Why pre-filter strengthening for the contour layer.** During
test development, forcing `--force-method=contour` on `G^{0,1}_{2,0}
([1, 1/2]; |100)` (one-sided cluster, `|z| > 1`) hung: the contour
layer's `pickTruncation` doubled T 20 times without convergence,
then the quadrature driver iterated for thousands of evaluations.
The contour layer is *correct* but cost-unbounded in this regime.
The fix is in the pre-filter: refuse `m = 0 ∨ n = 0` with
`|z| ≥ 1`. Cost-ascending dispatch routes around the refused
contour to asymptotic / Slater cleanly. ADR-0027 §2 pins this; the
refusal reason names "one-sided contour-truncation is
cost-unbounded".

**Why include both `slater` and `asymptotic` in method-agreement
but not `contour`.** Same reason: the contour layer hangs (in the
quadrature driver) on inputs where its predicate is OK but the
truncation cost is unbounded. The dispatcher routes around it
correctly via cost-ascending, but a hand-coded force-method test
has to pick lanes that always converge. The 8-case
method-agreement battery covers Slater and asymptotic
exclusively.

**Why honour the contour pre-filter even on `--force-method=contour`.**
Forcing a lane that cannot terminate is always a bad UX. The user
explicitly forced contour; the structured refusal (with the
predicate's reason) is the correct response. Same logic could
apply to the other lanes, but they don't have cost-unbound
regimes — only contour does.

**Why `S.any()` for output schema.** Same trade-off as
`tools/solve` (worklog 054): the output is a discriminated union
of two record shapes plus six tagged shapes; TS-inference on a
narrow union via the runner's narrowing fights the `fn` signature.
Goldens enforce the actual shape per case; the runtime `output`
validation against `S.any()` is a no-op. Filed as a limitation of
`@workbench/contract`'s schema-narrowing, not a choice to fix here.

## Frictions surfaced

**Worktree path confusion (the load-bearing one).** Initial
file edits went to `/home/tobias/Projects/scientist-workbench/`
(the main repo) rather than
`/home/tobias/Projects/scientist-workbench/.claude/worktrees/agent-…`
(the worktree). The harness's working-directory state and the
`Read`/`Write`/`Edit` tools' absolute paths fell out of sync; only
caught when `git status` in the worktree showed clean. Resolution:
copy all files from main to worktree, re-run tests, verify. Lesson:
when the harness shows
`pwd = .claude/worktrees/<name>` but the env says working
directory differs, *prefer absolute paths into the worktree* —
don't rely on the cd-state of bash invocations.

**Contour layer's cost-unbound regime (the second-most load-bearing).**
Forcing `--force-method=contour` on one-sided-cluster inputs at
`|z| ≥ 1` hangs (truncation T grows unboundedly; quadrature driver
iterates forever). The issue is genuinely in the contour layer —
the substrate is "settled" per the bead spec, so the fix lives in
the dispatcher's pre-filter. Two changes: (1) `canUseContour`
refuses these inputs upfront; (2) `runForced` (force-method)
honours the pre-filter even on explicit user request. Filed as a
follow-up bead (`BEADS-TO-FILE.txt` / `meijerg-contour-cost-bound`).

**Pole-cluster overlap on integer params.** First-draft
"clusters separated" test used `G^{1,1}_{1,1}(1; 0 | z)`:
`max{Re(a)-1} = 0`, `min{Re(b)} = 0` ⇒ overlap detected, contour
refuses. Updated test to `G^{1,1}_{1,1}(0; 2 | z)` (clusters
separated by 3 units). The contour layer's overlap detection is
*strict* (`>=`, not `>`); both inputs are mathematically valid
Meijer G (the symbolic dispatch handles them), but the contour
layer requires the pole clusters strictly separated.

**Absolute-vs-relative tolerance in branch-cut test.** First draft
compared `G(z=-100)` with `G(z=-100 + i·1e-50)` and asserted
`diff < 1e-20`. But `G^{1,0}_{0,1}(_; 0 | z) = e^{-z}` evaluated
at z=-100 has magnitude e^{100} ≈ 10^{43}; a 10^{-50} relative
perturbation in z leads to a 10^{-7} absolute difference in the
output. Fixed by using `z = -1` (where `e^{-z} = e ≈ 2.7`); the
absolute tolerance now matches the relative tolerance.

**Pre-existing `lc1` runner gap inherited.** The runner's standard
`--precision=N` flag is parsed but not threaded into arbprec
tools' `flags` parameter. CLI invocations always run at default
`precision = 50`; in-process callers via `@workbench/compose`
thread the flag correctly. Documented in ADR-0027 §11 and in the
tool's README. Tests run in-process where possible; goldens omit
per-case `flags` (matching `meijer-g-asymptotic-only`'s convention
from worklog 078).

## Acceptance

- 1 ADR landed (`docs/adr/0027-meijerg-dispatcher.md`, ~340 lines).
- 1 dispatcher kernel (`packages/meijer-core/src/dispatcher.ts`,
  ~880 LOC).
- 1 wire tool (`tools/meijer-g/`).
- 1 package-level test file (`packages/meijer-core/test/dispatcher.test.ts`,
  22 tests).
- 1 wire test file (`tools/meijer-g/tool.test.ts`, 35 tests).
- 20 golden cases (`tools/meijer-g/goldens.spec.ts`).
- Lockstep doc updates: workbench root README, meijer-core README,
  this worklog, the campaign log update.
- `bun test packages/meijer-core/`: 162 pass, 0 fail.
- `bun test tools/meijer-g/`: 35 pass, 0 fail.
- `bun tools/meijer-g/tool.ts --test`: passes.

The dispatcher exhibits all six invariants the ADR pins:

1. Bit-deterministic across runs (same input bytes ⇒ same output bytes).
2. Cost-ascending (symbolic match wins on every input where it applies).
3. Honest refusal (`out-of-region` envelope with `ruled_out_methods`).
4. Principal-branch pinned (Schwarz check passes for all 5 test cases).
5. Method-agreement (8 force-method cases over Slater + asymptotic).
6. Two-shape success discrimination (`kind: "symbolic"` vs
   `kind: "numerical"`).

## Pointers

- ADR-0027 (`docs/adr/0027-meijerg-dispatcher.md`) — design pin.
- Bead `scientist-workbench-hv0.10` — this work item.
- `packages/meijer-core/src/dispatcher.ts` — kernel + predicates.
- `packages/meijer-core/src/index.ts` — barrel export.
- `tools/meijer-g/tool.ts` — wire wrapper.
- `tools/meijer-g/tool.test.ts` — 35 wire tests.
- `tools/meijer-g/goldens.spec.ts` — 20 goldens.
- `tools/meijer-g/README.md` — agent-facing.
- `packages/meijer-core/README.md` — "Dispatcher (Layer 7,
  ADR-0027)" section.
- `BEADS-TO-FILE.txt` (worktree root) — follow-up beads.
- `tstournament/ts-bench-infra/problems/13-meijer-g/PLAN.md` —
  the seven-layer plan; this work closes Layer 7.
- Worklogs 070, 073, 076, 077, 078 — the four lower layers.

## Commits

(Single commit on the worktree branch
`worktree-agent-a60c5f3a583360cec`; orchestrator merges to main.
Companion `tstournament` worklog updates land via separate commit on
that repo's `main`.)
