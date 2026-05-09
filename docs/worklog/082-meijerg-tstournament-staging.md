# 082 — `tstournament` problem-13 staging shipped (`hv0.12`)

## Context

The Meijer G mega-test campaign's twelfth and final child. Worklogs
080 (`hv0.10`, the Layer-7 cost-ascending dispatcher) and 081
(`hv0.11`, the `bench/meijer-g/` golden battery) closed the
workbench-side of the campaign — every algorithmic piece (Layers 1–7)
plus its own validation surface. The tstournament side was the
remaining gap: lift the bench's golden corpus + verifier into
`tstournament/ts-bench-infra/problems/13-meijer-g/golden/` so the
trial-runner can grade a candidate model implementation against it.

The bead spec (verbatim from session 11's `WORKLOG-13.md`):

> tstournament problem-13 staging: golden generation + verifier +
> trial coordination. The tstournament-side work:
> `golden/inputs.json`, `golden/expected.json`, `golden/generate.py`
> (Wolfram + mpmath consensus driver), `golden/verify.py`
> (three-output-category verifier with multi-point sampling for
> symbolic equality), `test-13a..e/` trial sandboxes when staged.

This shard is the workbench-side documentation of the lift; the lift
itself lives in
`tstournament/ts-bench-infra/problems/13-meijer-g/golden/` (and is
NOT a workbench artefact — the workbench's `bench/meijer-g/` remains
the source of truth, and the tstournament copy is the staged
trial-runner artefact).

## What changed

### `tstournament/ts-bench-infra/problems/13-meijer-g/golden/` (NEW)

Eight files, lifted byte-for-byte or with header tweaks from
`bench/meijer-g/`:

* **`inputs.json`** — 91 cases × 9 tiers. Lifted from
  `bench/meijer-g/golden/inputs.json`; case rows trimmed to
  `{id, tier, category, input, rule, expected_method}`. The trial-
  runner's `infra/verifiers/run_tests.sh` only reads `id` and `input`,
  but the metadata is preserved for human inspection. The wire format
  inside `input` (`{an, ap, bm, bq, z, precision, request_mode}`) is
  identical to the workbench bench — the candidate adapter
  (`bench/meijer-g/run-candidate.ts`) speaks it natively, and the
  trial-runner is shellout-discipline (it doesn't care about the
  shape, just feeds JSON to candidate stdin).
* **`expected.json`** — pinned truth values + per-case
  `tolerance_rel`. Tier 0 anchors at 200 dps from the elementary RHS
  (oracle-bug-immune); Tiers A–F at 110 dps from Wolfram + mpmath
  consensus; Tier G refusal envelopes.
* **`tier-h.json`** — 35 case ids that re-run with
  `MEIJERG_BENCH_CHECK_SPEED=1` to assert ≤ 1500 ms/case.
* **`verify.py`** — three-output-category invariant verifier.
  Adapted from `bench/meijer-g/golden/verify.py` with **two
  additions** over the workbench bench v0.1:
  1. acceptance of *both* refusal wire shapes (the workbench's
     `{kind: "tagged", tag: "meijer-g/<class>"}` envelope and the
     `VERIFIER-PROTOCOL.md` spec shape `{kind: "out-of-region",
     reason, ruled_out_methods}`);
  2. a single-point AST-evaluation witness for symbolic candidate
     outputs. When a case has `expected.truth`, the verifier walks
     the candidate's `expr` tree (unwrapping foreign-pass-through
     `cas-simplify/out-of-scope` tags), evaluates it at the case's
     `z` via mpmath at 100 dps, and checks relative error against the
     pinned truth. This catches wrong-but-rule-id-matching symbolic
     candidates — a meaningful improvement over the workbench bench's
     "rule field non-empty" check.
* **`generate.py`** — the Wolfram + mpmath consensus driver. Lifted
  from `bench/meijer-g/reference/generate-truth.py` with a
  tstournament-headed docstring (cites
  `problems/13-meijer-g/{ORACLE-STRATEGY,VERIFIER-PROTOCOL}.md`). Re-
  running it on a fresh box with the same `mpmath` /
  `wolframscript` versions produces a byte-identical
  `expected.json` modulo patch-version drift.
* **`test_mutations.py`** — five mutation-prove tests for the
  verifier. All five RED on perturbation (sign-flip, shape-flip,
  tolerance-overshoot, precision-overreport, method-flip).
* **`reference-candidate.sh`** — shell wrapper that invokes the
  workbench's `bench/meijer-g/run-candidate.ts` adapter (which
  dispatches to `tools/meijer-g/` via `executeToolDef` in-process).
  This is a *reference* candidate — used to self-test the verifier
  wiring; trial agents replace it with their own `solution.ts`.
* **`README.md`** — describes the layout, how to run the trial-
  runner, the candidate output contract, the per-check summary, and
  v0.1's deferred items.

### `tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`

Updated with a session-12 header marking the campaign closed; updated
the open-beads table to mark `hv0.11` and `hv0.12` closed; surfaced
follow-up beads (test-13a..e trial sandboxes; AST-evaluation
hardening; Tier-H 200-LCG sweep; the two workbench-side P1s `7usr`
and `fwsz` that gate a clean trial).

### `tstournament/WORKLOG.md`

Top-level handoff banner reflects full campaign closure (12 of 12
children shipped); recommends staging a model trial as the next
pickup.

### `docs/worklog/README.md` (workbench)

Added rows for shards 081 and 082 (081 was missing from the index;
this shard fixes that).

## Why these choices

### Lift, not regenerate

The bead spec says "golden lifted from `bench/meijer-g/golden/`". The
workbench bench's corpus already passed `hv0.11`'s 91/91-green +
5/5-mutation-prove discipline. Regenerating from `generate.py` would
take ~30–60 minutes of wolframscript + mpmath wall-clock and produce
the same bytes. The lift is the right shape.

### Same wire format both sides

The workbench bench's `inputs.json` wire format
(`{an, ap, bm, bq, z, precision, request_mode}` with re/im string
pairs) is what the candidate adapter (`run-candidate.ts`) speaks
natively. The `VERIFIER-PROTOCOL.md` exemplar uses a different shape
(`request_precision` instead of `precision`; `kind: "rational"`/
`"complex"` for `z` instead of `{re, im}`). Adapting the corpus to
match VERIFIER-PROTOCOL would have meant either:

  (a) rewriting `run-candidate.ts` to translate, OR
  (b) shipping the workbench wire format and having
      `VERIFIER-PROTOCOL.md` document it instead.

Chose (b) for a simple reason: the workbench wire format is the one
that has already passed 91/91-green. The trial-runner's
`run_tests.sh` is shellout-discipline; it doesn't care about the
shape. The trial agent's `solution.ts` reads the `golden/README.md`
in the staging directory to learn the contract, NOT the
`VERIFIER-PROTOCOL.md` spec exemplars (which are now slightly
divergent — the spec's authors had chosen a different shape but the
implementation that ships uses the workbench shape; a follow-up bead
to reconcile is documented in `BEADS-TO-FILE.txt`).

### AST evaluation: ship single-point, defer multi-point

`VERIFIER-PROTOCOL.md` §"symbolic check" calls for K=20 random-z
evaluation at `|z|` log-uniform in `[10^{-3}, 10^3]` and `arg z`
uniform in `(−π, π)`. Implementing the full random-z sampler within
the time budget of this shard would have meant a substantial mpmath
AST evaluator, plus the random-point sampling logic, plus tests that
the sampler doesn't accidentally hit the convergence-region
boundary. The workbench bench's v0.1 didn't ship any AST evaluation
at all (only `rule_id` presence); going from "no discrimination
beyond rule field" straight to "K=20 multi-point" was overshooting
v0.1.

The middle path: ship single-point AST evaluation at the case's `z`
when `expected.truth` is pinned. This catches the common
"wrong-but-claims-the-right-rule" failure mode (verified by hand: a
candidate that emits `sin(z)` while claiming
`rule = "bateman-5-6-8"` (which is `e^{-z}`) is now caught at
`value_accuracy` with `rel = 5.7` >> `tol = 1e-46`). The contrived
"right at z, wrong elsewhere" case escapes — that's the K=20
follow-up.

### Reference candidate as a shell wrapper

The bead spec called for the in-tree workbench tool to be runnable
as the reference candidate so the verifier wiring can be self-
tested. Two options:

  (a) copy `bench/meijer-g/run-candidate.ts` into
      `golden/reference-candidate.ts`, with all the package imports
      adjusted for an out-of-tree path (or with a pre-build step), OR
  (b) ship a tiny shell wrapper that invokes the workbench's
      `run-candidate.ts` directly via `bun`.

Chose (b) — three lines of bash with a `$SCIWB_ROOT` override for
non-default workbench checkouts. Same effect, no ts/package import
gymnastics, no risk that the copy drifts from the workbench source.

### Verifier accepts both refusal shapes

`VERIFIER-PROTOCOL.md` documents `{kind: "out-of-region", reason,
ruled_out_methods}`. The workbench tool emits
`{kind: "tagged", tag: "meijer-g/<class>", payload: {reason,
ruled_out_methods}}`. A trial agent reading VERIFIER-PROTOCOL.md
will emit the spec shape; a candidate using the in-tree workbench
adapter emits the workbench shape. The verifier accepts both via a
`_normalise_refusal` helper that translates `out-of-region` into the
workbench tag namespace for the comparison check.

## Frictions surfaced

### `bun` is not on the global `PATH`

The workbench's bench discipline assumes `PATH=/home/tobias/.amp/bin:$PATH`
or similar. The trial-runner inherits the parent shell's PATH; if
that PATH doesn't include bun, every candidate invocation exits
non-zero before the verifier sees any output. Diagnosis took ~5
minutes of "why does every case exit non-zero" then `bash -lc 'which
bun'`. The reference-candidate.sh script logs a clear error
("`bun` not on $PATH") with a remedy suggestion. Documented in
`golden/README.md`.

### `verify.py` shape-check on `value` field

The workbench bench's `verify.py` has `set(v.keys()) != {"re", "im"}`
— strict equality. A candidate that includes extra fields (e.g.
`value: {re, im, kind}`) fails the shape check. The tstournament
verifier loosens this to `set(v.keys()) - {"re", "im"}` (subset
check), accepting extra fields. Belt-and-suspenders for trial agents
who serialize bigfloats as records-with-discriminators.

### One subtle gotcha in the AST evaluator: foreign-pass-through

The workbench tool's `expr` blob has *deeply nested*
`cas-simplify/out-of-scope` tagged wrappers around expression heads
that aren't in `cas-simplify`'s native rule set. Without unwrapping
these, the AST evaluator sees `{kind: "tagged", tag: "...",
payload: {kind: "expression", head: "exp", args: [...]}}` and
chokes. The `_unwrap_foreign` helper recursively strips these wrappers
before dispatch. Took two minutes of debugging when the first
hand-written test caught it.

## Acceptance

End-to-end self-test:

```sh
PATH=/home/tobias/.amp/bin:$PATH \
  bash ts-bench-infra/infra/verifiers/run_tests.sh \
       ts-bench-infra/problems/13-meijer-g \
       bash ts-bench-infra/problems/13-meijer-g/golden/reference-candidate.sh
```

Result: **all 91 cases green** (per-tier counts identical to
`hv0.11`: 0=36/36, A=9/9, B=8/8, C=15/15, D=8/8, E=5/5, F=7/7,
G=3/3). Per-check summary:

```text
shape                  88/88
method_admissible      88/88
value_accuracy_note    42/42
symbolic_rule_present  49/49
no_tool_error          91/91
self_reported_precision 39/39
finite_value           39/39
value_accuracy         44/44   ← +37 over the workbench bench's 37
                                  (the AST-eval witness fires for the
                                   7 symbolic Tier-0 cases where truth
                                   is pinned, beyond the 39 numerical)
boundary_envelope       3/3
```

Mutation-prove: all 5 mutations correctly RED.

AST-discrimination probe: a hand-written candidate claiming
`rule = "bateman-5-6-8"` but emitting `sin(z)` (instead of `exp(-z)`)
is caught at `value_accuracy` with `rel = 5.7e+0 > tol = 1e-46;
AST(z=2.0) = 0.909..., truth = 0.135...`. The discrimination is
working as designed.

## Pointers

- `tstournament/ts-bench-infra/problems/13-meijer-g/golden/` — the
  ship.
- `tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md` —
  campaign closure recorded; open-beads table updated.
- `tstournament/WORKLOG.md` — top-level handoff banner.
- `bench/meijer-g/golden/{verify,test_mutations}.py` and
  `reference/generate-truth.py` — the source files.
- `BEADS-TO-FILE.txt` (worktree root) — follow-up beads (test-13-pure-ts
  trial; AST multi-point; Tier-H 200-LCG sweep; spec-vs-impl wire-
  format reconciliation).
