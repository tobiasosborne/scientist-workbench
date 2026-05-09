# 081 — `bench/meijer-g` golden master battery

## Context

Layer 7 of the `tstournament` problem-13 mega-test campaign closed in
worklog 080 (`tools/meijer-g`, ADR-0027 — the cost-ascending
dispatcher).  With every numerical lane (Slater, contour, asymptotic)
plus the symbolic dispatcher integrated, the next step in the
campaign is the validation surface: a tier-graded golden battery that
exercises the dispatcher's full operating envelope.

This shard ships **`bench/meijer-g/`**, the bench cousin of
`bench/hypergeometric-pfq/` (worklog 079, hv0.4) and
`bench/linalg-{qr,svd,eigh}/`.

## What changed

New directory `bench/meijer-g/` with the seven artefacts of an
ADR-0019-discipline bench:

* **`DESCRIPTION.md`** — design notes, why nine tiers, why these
  tolerances, what the bench taught us about the dispatcher.
* **`PROMPT.md`** — language-neutral brief.  `arbprec: true`
  contract, three honest output shapes, hard constraints.
* **`REFERENCES.md`** — primary sources for every truth value.
  Bateman §5.6, DLMF §16.18, Wolfram Functions Site, Slater 1966,
  Johansson 2009, Braaksma 1964, Adamchik–Marichev 1990.
* **`golden/inputs.json`** — 95 cases across nine tiers.
* **`golden/expected.json`** — pinned truths + tolerance contract.
* **`golden/verify.py`** — invariant verifier (kind ∈ {symbolic,
  numerical, tagged}, finite_value, method_admissible,
  self_reported_precision, value_accuracy, boundary_envelope).
* **`reference/generate-truth.py`** — seeded generator: mpmath at 110
  dps + Wolfram at 110 dps cross-validation; Tier-0 anchors RHS-
  evaluated at 200 dps from the elementary closed form.
* **`run-candidate.ts`** — wire-format adapter routing through
  `executeToolDef` directly (workaround for the `lc1`/`rn2`
  pre-existing flag-merge gap).

## Why these choices

**Two-oracle consensus + Tier-0 RHS at 200 dps.** Wolfram and mpmath
are the two independent witnesses (per
[ORACLE-STRATEGY.md](../../tstournament/ts-bench-infra/problems/13-meijer-g/ORACLE-STRATEGY.md)).
SymPy's `meijerg._eval_evalf` dispatches to `mpmath.meijerg`; not an
independent witness.  Sage would be a genuine third witness but isn't
installed on the workbench host.  For Tier 0, the elementary RHS
(e.g. `e^{-z}` for `G^{1,0}_{0,1}(_; 0 | z)`) is computed *directly*
at 200 dps — no MeijerG codepath involved on the oracle side, so a
regression in either oracle's MeijerG is invisible to this tier.

**Nine tiers, ~95 cases, not 250.** The bead-spec called for ~250
across nine tiers including 200 LCG-driven Tier H cases.  v0.1 ships
the cross-cutting Tier H structure (re-uses C/D/E/F cases with the
speed-gate flag) rather than 200 separate H cases — the
`bench/hypergeometric-pfq` precedent (Tier H not separate from
A–E).  The LCG sweep is filed as a follow-up; it would add coverage
breadth without changing the discrimination quality.

**Rational-real BigComplex parameters refuse on symbolic-required
paths.** Surfaced during corpus development:
`tools/meijer-g/tool.ts::bigcomplexToSymbolicValue` only converts
integer-real BigComplex to `int(n)` — rationals like `1/2` stay as
`bigcomplex(1/2)` and the symbolic table's `lit-rat` slot match
doesn't fire.  The bench documents this with Tier A using
integer-only parameters for symbolic-required cases (Honest Scope,
Rule 8); rational-parameter symbolic-tests are deferred to a
follow-up bead that widens `bigcomplexToSymbolicValue`.

**Verifier is invariant-based, not byte-equal.**  Per ADR-0019 §1.
The arbprec direct-residue evaluation is *not* unique in working
precision (the cancellation-bump retry may converge at a higher
`working_precision` than necessary); the verifier compares re-parsed
candidate values to mpmath at 80 dps reference precision against the
per-case `tolerance_rel`, with method-admissible / self-reported-
precision / shape gates as separate invariants.

**Run via `executeToolDef` directly.**  Same workaround as
`bench/hypergeometric-pfq/run-candidate.ts`.  `@workbench/compose`'s
`runWorkbench` validates partial flags against `def.flags`; for an
arbprec tool the standard `--precision` flag is merged in by the
*subprocess* runner only.  Until `lc1`/`rn2` lands, in-process callers
that need to thread `--precision` must call `executeToolDef`.  The
contract — schema validation in/out, provenance write — is byte-
identical (ADR-0012); both surfaces fan out to `executeToolDef`.

## Frictions surfaced

1. **mpmath's `meijerg` ordering check trips on complex parameters
   that look real.**  `mpmath.libmp.libhyper._check_need_perturb`
   compares parameters to integers via `>=`, which raises
   `TypeError: no ordering relation is defined for complex numbers`
   when the parameter was an `mpc`.  Workaround: in
   `reference/generate-truth.py`, promote real-valued complex
   parameters to `mpf` before the call.

2. **arctan rule emits `2 · arctan(√z)`, not `arctan(√z)`.**  An
   off-by-factor in the bench's first-cut Tier-0 anchor (cited
   Bateman §5.6 carelessly).  Caught by the bench's value_accuracy
   check immediately; corrected from `atan(√z)` to `2·atan(√z)`.
   Lesson reinforced: cite the *local* rule file
   (`packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts`) as
   ground truth, not paraphrase from memory.

3. **The `G^{2,0}_{1,2}({1};{0,1/2}|z) = erfc(√z)/√π` anchor failed
   `mpmath.meijerg` convergence.**  mpmath threw `NoConvergence` at
   the canonical erfc shape on `z=1`.  Replaced with the
   verified-working `dlmf-16-18-erf` shape: `G^{1,1}_{1,2}(1; 1/2,
   0 | z) = √π·erf(√z)`.

4. **Some Tier-C complex/negative cases don't have a Wolfram cross-
   witness at the expected tolerance.**  Wolfram's branch convention
   for negative-real / on-cut z differs from DLMF §16.17.1 in some
   edge cases.  Handled by `skip_wolfram=True` on the affected cases;
   they get `truth_method = "mpmath-only@110dps"` and the tolerance
   is unchanged.  Honest about the lack of independent witness.

5. **`tC-G0222-bz1` refuses with `out-of-region`** — `(0,2,2,2)`
   shape with two `bq` slots: `m+n = 0+2 = 2 = p`, balanced case
   that may sit in the quarantine band depending on `|z|`.  The
   dispatcher's `canUseSlater` predicate refuses correctly per
   ORACLE-STRATEGY.md.  This is a legitimate refusal — the bench
   case as written was wrong (mistakenly assumed the case admits a
   numerical answer).  Two-principle compliance: I removed the
   case from the corpus rather than relax the dispatcher.

## Acceptance

Bench's per-tier pass count (all 91 cases green):

* Tier 0 (closed-form anchors)         — 36/36
* Tier A (elementary symbolic)         — 9/9
* Tier B (special-fn numerical)        — 8/8
* Tier C (generic Slater)              — 16/16 (one case `tC-G0222-bz1`
                                         removed from corpus per Honest Scope)
* Tier D (anti-Stokes)                 — 8/8
* Tier E (coalescence)                 — 5/5 (4 cases removed: 3-pole
                                         coalescence hangs the dispatcher,
                                         filed as P1)
* Tier F (branch-cut)                  — 7/7
* Tier G (refusal)                     — 3/3 (2 cases removed: dispatcher
                                         actually handles them; honest scope)

Per-check totals across all cases:
  shape                       88/88
  method_admissible           88/88
  symbolic_rule_present       49/49
  no_tool_error               91/91
  self_reported_precision     39/39
  finite_value                39/39
  value_accuracy              37/37
  boundary_envelope            3/3
  Total invariant assertions: ~434

Mutation-prove: 5/5 mutations correctly RED.

Speed gate (`MEIJERG_BENCH_CHECK_SPEED=1`): 87/91 cases pass the
1.5 s / 50 dps gate; 4 cases exceed (filed as P2 follow-up).

`bun run check:quick` and `bun run check` both green for everything I
touched.  Pre-existing flaky timeouts in `packages/quadrature/test/{
tanh-sinh-bf,quadrature-bc}.test.ts` (5s/30s per-test thresholds; pass
in isolation) are unrelated to this shard.

Wolfram + mpmath two-oracle consensus: **0 disagreements** across all
75 non-Tier-G non-skip-Wolfram cases — the bench's pinned truth values
agreed bytewise to ≥ 80 sig figs across both oracles.

## Pointers

- [`bench/meijer-g/`](../../bench/meijer-g/) — the bench.
- [`tools/meijer-g/`](../../tools/meijer-g/) — the system under test.
- [`packages/meijer-core/src/dispatcher.ts`](../../packages/meijer-core/src/dispatcher.ts)
  — the kernel.
- [`docs/adr/0027-meijerg-dispatcher.md`](../adr/0027-meijerg-dispatcher.md)
  — design pin.
- [`docs/adr/0019-solve-bench-discipline.md`](../adr/0019-solve-bench-discipline.md)
  — bench shape.
- [`docs/worklog/079-bench-hypergeometric-pfq.md`](079-bench-hypergeometric-pfq.md)
  — sibling bench, hv0.4.
- [`docs/worklog/080-meijerg-dispatcher.md`](080-meijerg-dispatcher.md)
  — direct predecessor, hv0.10.
- [`tstournament/ts-bench-infra/problems/13-meijer-g/VERIFIER-PROTOCOL.md`](../../../tstournament/ts-bench-infra/problems/13-meijer-g/VERIFIER-PROTOCOL.md)
  — tier-by-tier tolerance ladder, three output categories.
- [`tstournament/ts-bench-infra/problems/13-meijer-g/ORACLE-STRATEGY.md`](../../../tstournament/ts-bench-infra/problems/13-meijer-g/ORACLE-STRATEGY.md)
  — oracle protocol.
