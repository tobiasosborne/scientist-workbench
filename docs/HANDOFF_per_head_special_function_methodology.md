# HANDOFF — per-head special-function reference-implementation methodology

> **Audience:** the next agent (you) who's been asked to ship a
> world-class reference implementation of a *new* special function
> for `scientist-workbench`. The natural next head is Bessel J. The
> methodology below shipped the Erf reference implementation
> end-to-end in ~24 hours of orchestrated work (47 beads, ~4100 LOC
> substrate, 761 new tests, 0 failures, 0 regressions). Repeat it.
>
> **This document is not theory.** Every paragraph is grounded in
> what worked (or what surfaced) during the Erf epic. Links to
> per-bead worklog shards 131-142 + `docs/refs/erf-research/` give
> you the receipts.
>
> **What this is NOT:** a wholesale rewrite. The methodology
> assumes you already understand CLAUDE.md's two laws and twelve
> rules. Re-read them first.

## TL;DR for the impatient

1. **Pick a head** (Bessel J is the obvious next).
2. **File the epic bead** + 5 deep-research beads (R1 symbolic, R2
   arb-prec, R3 float64, R4 Meijer-G bridge, R5 oracle landscape).
3. **Dispatch 5 parallel Opus deep-research subagents** in
   background; each writes a 600-2000-line markdown to
   `docs/refs/<head>-research/R{n}-...md` and returns a short
   executive summary inline.
4. **Synthesize → draft an ADR** modelled on `docs/adr/0040`.
5. **Generate a 200-300-input golden-master corpus** with a
   deterministic LCG (mirror `bench/erf-anchor/generate-corpus.ts`).
6. **Dispatch 4 parallel oracle adapter subagents** (Wolfram +
   mpmath + SciPy + Boost). Each is a pure-TS orchestrator around
   an external subprocess.
7. **Run the cross-agreement matrix** (mirror
   `bench/erf-anchor/cross-agreement.ts`). Target: 95%+ pair-wise
   info; explained 5%.
8. **Dispatch 7 substrate beads in 3 rounds** (Round 1: vocab + I1
   real-arbprec + I5 float64; Round 2: I2 erfc/erfcx + I3 complex +
   I4 cas-core identities; Round 3: I6 Meijer-G bridge).
9. **Dispatch 3 tool integration beads in parallel** (T1
   integrate-1d, T2 special-eval extension, T3 meijer-g closure).
10. **Run V1 verification** + write the epic-close worklog shard.

The full process took **~24 wall-hours** of orchestrated subagent
work for Erf. Bessel J is comparable in scope.

## What was achieved (the Erf v0.1 reference impl)

For context — this is what "world's best" looks like at the end of
the methodology:

- **6-axis substrate** pure TS on Bun, no FFI, no subprocess at
  runtime:
  - Symbolic identities (cas-core, 19 rules)
  - Diff rules (cas-core, in `special-functions.ts`)
  - Arb-prec real (bigfloat: `bigErf`, `bigErfc`, `bigErfcx`, `bigErfi`,
    plus internal `bigErfSeries` / `bigErfcAsymptotic` /
    `bigErfcContinuedFraction`)
  - Arb-prec complex (bigfloat: `bigW` Karbach-Weideman Faddeeva
    primitive + algebraic derivations `bigCErf` / `bigCErfc` /
    `bigCErfcx` / `bigCErfi`)
  - Float64 real + complex (quadrature: SunPro 1993 verbatim port +
    Faddeeva-Johnson MIT + Blair-Edwards-Johnson 1976 inverses;
    `eval-numeric-expr.ts` dispatcher hook)
  - Bidirectional Meijer-G bridge (meijer-core: `headToMeijerG` +
    `meijerGToHead` with `zInverse` closure trick)
- **Wire surface**: `tools/special-eval` umbrella tool with
  `--head=<name>` + `--precision=<int>` dispatching across {real,
  complex} × {float64, arb-prec}.
- **Cross-validation**: byte-identical against Wolfram + mpmath +
  Boost three-way agreement; `bun run check` 101/7/0.

Spot-check: `tools/special-eval --head=Erf --precision=200 --re=1.23`
returns a 695-bit BigFloat byte-decoding to
`0.918050104126761367892733003920752145557719224624067080950059…`
— matches the gold-tier reference.

## The 5-phase orchestration pattern

```
Phase 0 — Research & architecture (parallel; wall ~30-90 min)
  R1-R5 (5 deep research Opus subagents, background)
  ────────────────────────────── GATE: synthesize R1-R5
  A0: ADR draft

Phase 1 — Oracle harness & golden corpus (parallel; wall ~2-4h)
  G1: corpus tier design (orchestrator)
  G2-G7: per-oracle adapter (parallel subagents)
  G8: cross-oracle agreement matrix + disagreement triage (orchestrator)
  ────────────────────────────── GATE: corpus quality

Phase 2 — Substrate implementation (3 rounds parallel; wall ~4-8h)
  Round 1: I6a vocab amendment + I1 real-arbprec + I5 float64
  Round 2: I2 erfc/erfcx + I3 complex Faddeeva + I4 cas-core identities
  Round 3: I6 Meijer-G bridge (sole)
  ────────────────────────────── GATE: bun run check green; goldens green

Phase 3 — Tool integration (parallel; wall ~2-4h)
  T1: integrate-1d learns the head in integrand
  T2: tools/special-eval extension (or new tool)
  T3: meijer-g-symbolic-only closure validation

Phase 4 — Verification + docs lockstep (~1-2h)
  V1: cross-cutting integration tests + mutation-proving rollup
  D1: docs lockstep + epic-close worklog shard + close epic
```

**Total**: 5 phases, ~25 beads pre-staged + ~10 discovered along
the way = 35-50 beads typical.

## Phase 0: deep research

### The dispatch pattern

For each of R1-R5, dispatch an Opus subagent with `run_in_background:
true`. The prompt MUST:

1. **Reference CLAUDE.md** + the relevant ADRs (0023 vocabulary,
   0040 substrate, 0015 numerical-tier, 0020 arbprec-tier, 0025
   Meijer-G dispatch).
2. **Specify exact source URLs** for the literature (DLMF chapter
   numbers; SymPy file paths; Faddeeva.cc GitHub link; etc.). Don't
   leave the agent to find them.
3. **Demand "deep markdown to disk + short executive summary
   inline"**. The deep artefact stays in
   `docs/refs/<head>-research/`; the summary fits in your context.
4. **Set a length target** (e.g. 600-2000 lines). Looser bounds are
   OK if the discipline ("every claim cites primary source") is
   tight.

### What each R does

- **R1 (symbolic identities)**: DLMF chapter on the head + Wolfram
  Functions Site (if reachable — was HTTP 403 for Erf so substance
  recovered via SymPy + diofant + mpmath) + SymPy source. Output: a
  pattern-table proposal of 20-50 rules per head, each with
  `lhs_pattern / rhs / conditions / source` shape.
- **R2 (arb-prec algorithms)**: Arb (Fredrik Johansson) + mpmath +
  Boost.Multiprecision + classic papers. Output: algorithm
  taxonomy with closed-form prec-dependence for every truncation
  parameter; crossover thresholds; coefficient tables.
- **R3 (float64 algorithms)**: SunPro / musl / glibc / FreeBSD /
  Faddeeva-Johnson / Julia SpecialFunctions.jl / Cephes. Output:
  recommended verbatim port choice + coefficient tables emit-ready
  as TS arrays + edge-case table.
- **R4 (Meijer-G bridge)**: Bateman + DLMF §16 + PBM + Wolfram
  Functions Site (or SymPy/diofant triangulation). Output:
  canonical G-form table per head (Wolfram convention); bridge API
  proposal with `zInverse` closure trick; gap analysis vs existing
  `dispatch-rules/`.
- **R5 (oracle landscape)**: PROBE the local machine via shell.
  Capability matrix per oracle + worked example invocations + tier
  hierarchy (gold/silver/bronze) + LANDMINES (Wolfram input-trap,
  mpmath/Wolfram rounding mismatch, single-engine arb-prec risks).

### Discipline: write-to-disk + short-summary

Each subagent's deep markdown is 600-2000 lines. If 5 subagents
return inline that's 8-10K lines blowing your context. Mandate the
write-to-disk pattern in EVERY R-prompt.

The inline summary (200-300 lines) goes into the bead's
`bd update --notes` field via the orchestrator's close-out.

### Synthesize → draft ADR

You (the orchestrator) read each artefact, surface contradictions,
make the architectural decisions, and write the ADR. Model on
`docs/adr/0040-per-head-special-function-substrate-and-meijer-g-
bridge.md`:

- 10 numbered Decisions
- "What we will not decide here" boundary
- "Why these choices" justification per decision
- "Acceptance" checklist (substrate-implemented + pattern-
  generalises criteria)

For Bessel J: the ADR will be 0041 (or whatever's next available).

## Phase 1: oracle harness + golden corpus

### G1: corpus design

8 tiers covering the head's algorithm regimes. For Erf the tiers
were:

```
T1 — real-small  |x| ∈ [0, 0.84]        Maclaurin regime
T2 — real-mid    |x| ∈ (0.84, 6]        Cody / mid asymptotic
T3 — real-large  |x| ∈ (6, 30]          asymptotic; saturation
T4 — imag-pure   z = i·y, y ∈ [0, 30]   pure-imaginary Faddeeva
T5 — complex     Q1-Q4 |z| ∈ [0.1, 15]  full Faddeeva
T6 — edge        ±0, ±∞, NaN, subnormal, denormal-extreme
T7 — Stokes band |arg z| ∈ [π/2 ± 0.1]  Berry-smoothing regime
T8 — inverses    InverseErf / InverseErfc  Newton-validation
```

For Bessel J: tiers will mirror these but pivot on the parameter `ν`
in addition to `z` (so T1-T3 real-x at multiple ν; T4-T5 complex z
at multiple ν; T6 edges; T7 maybe NA or Bessel-specific saddle
regime; T8 zeros of Bessel rather than inverses).

The generator is `bench/<head>-anchor/generate-corpus.ts` — pure-TS
Park-Miller LCG seeded with the bead's filing date. **Reproducible
on re-run**.

Discipline: every value formatted as a 60-decimal-digit string (NOT
JS `Number.toString()`). The Wolfram input-trap (R5 §3.1) demands
this — `N[Erf[1.23], 50]` returns ~16 digits because `1.23` parses
as machine-precision double; the adapter MUST construct as
`Rational[num, den]` from the decimal-string parse.

### G2-G7: oracle adapters

Each oracle adapter is a pure-TS Bun script that subprocesses an
external runtime ONCE at corpus-build time, parses the output,
writes a frozen JSON results file. **The TS substrate never spawns a
subprocess at runtime.** Oracles are external ground truth.

Per-oracle prompts in the Erf epic:

- **Wolfram** (`tools/wolframscript`): single batch via `wolframscript
  -file`. Critical: `FormatNumeric` helper that normalises Wolfram's
  `*^` exponent syntax to standard `e` (this was the G2a bug that
  needed a fix mid-epic — file the bead and fix it).
- **mpmath** (`python3 -c "..."`): `mpmath.mp.dps = 60` compute /
  emit at 55 dp. The 5-dp margin canonicalises mpmath's
  round-to-nearest vs Wolfram's truncate (R5 §3.2 landmine).
- **SciPy** (`python3 -c "..."`): uses Cephes (Moshier) under the
  hood for real; `scipy.special.wofz` for Faddeeva complex. Derive
  per-head outputs algebraically (Karbach §2 identity table).
- **Boost** (g++ -std=c++17): `cpp_bin_float<50>` for real
  arb-prec silver tier. **No complex** (template fails on
  `std::complex<cpp_bin_float<N>>` per R5 §1) — refuse honestly.

### G8: cross-agreement matrix

Pure-TS comparator that loads every `oracles/<id>/results.json`,
classifies pair-wise comparisons by tier (gold-gold / gold-silver /
bronze-anything), and produces:

- `bench/<head>-anchor/agreement-matrix.md` (human heat map)
- `bench/<head>-anchor/agreement-data.json` (machine-readable)

Thresholds per ADR-0040 §"Decision 8":
- gold-gold: > 2 digits disagreement → flag (need ≥ 48 dp)
- gold-silver: > 4 digits → flag (Boost cpp_bin_float<50> last 2-3
  digits are rounding noise; threshold 46)
- bronze: > 4 ULP → flag

**Critical comparator features** (learn from the Erf G8 iteration):
- `canonicalScientific` normalisation so `"0" ≡ "0.0" ≡ "0.000…"`
- `PERFECT_AGREEMENT` short-circuit when significands strip to
  identical strings
- Absurd-exponent mapping (mpmath emitting `1.38e+14_035_097…` for
  `Erfi(MAX_DOUBLE)` should map to overflow-limit for comparison)
- Limit-equivalence: Wolfram `"Indeterminate"` ≡ `"NaN"`;
  `"ComplexInfinity"` ≡ `"Infinity"`
- Expected-refusal downgrade: oracles with documented capability
  limits (Boost has no complex; mpmath refuses MAX_DOUBLE Erfc) →
  refusal-by-that-oracle is `info` severity, not `warn`

The Phase 1 GATE: < 50 "real" findings (after the expected-refusal
downgrade). For Erf the final was 8 (all explained).

## Phase 2: substrate implementation

### Pre-stage the entire DAG

Before claiming any substrate bead, file the FULL Phase 2 + 3 + 4
bead set (≥15 beads) with proper dependency edges. This makes
parallelism clear and the work scope visible.

### Per-bead impl plans

Write `docs/refs/<head>-research/PHASE2-impl-plans.md` —
specialising the ADR's substrate decisions into per-bead
implementer-ready guidance. For each bead (I1-I6, I6a, T1-T3, V1,
D1) include:

- File layout (exact paths + LOC estimate)
- API signatures (with branded types where they buy clarity)
- Algorithm narrative (1-2 paragraphs citing R-research)
- Test plan against the Phase 1 golden corpus
- Mutation-proving expectations (≥3 perturbations cause RED)
- Acceptance checklist
- Cross-bead dependency edges

This doc IS what each subagent reads. Self-contained = subagent
can claim without round-trips.

### Dispatch in rounds, in parallel

Round 1 (no Phase 2 prereqs): I6a vocab + I1 real-arbprec + I5
float64 — all parallel.
Round 2: I2 erfc/erfcx + I3 complex + I4 cas-core — all parallel.
Round 3: I6 Meijer-G bridge — sole.

Each subagent prompt MUST:
1. Reference CLAUDE.md + the ADR + the impl plan section + the
   relevant R-research section.
2. Reference Round 1's friction notes (for Round 2 prompts). E.g.,
   I2's prompt cited I1's cancellation-retry slot finding so I2
   knew it was the first to exercise it.
3. Demand mutation-proving documentation in the worklog shard.
4. Demand literate top-of-file algorithm narrative (CLAUDE.md Rule
   10).
5. Pin the decision principle: *"what would a legendary TS senior
   SE demand"*.

### Mutation-proving discipline

Per CLAUDE.md Rule 6: for each bead, ≥3 distinct algorithm
perturbations cause RED test failures. Restore; confirm green.
Document in the worklog shard.

For Erf: 23 mutation-proofs documented across the epic. The
`V1-mutation-proving-rollup.md` artefact consolidates them.

Honest finding from Erf: sometimes a perturbation is
**non-discriminating** — both algorithm lanes give correct answers
at the crossover boundary. That's a robustness PROPERTY, not a test
gap. Document and supplement with a discriminating perturbation
(I1's mutation 2' was the supplement when mutation 2's LN2 → LN10
was non-discriminating).

### Honest findings → new beads

As substrate work uncovers gaps (e.g., I5's complex w(z) bulk
region; mpmath's InverseErfc tail bug; ADR's claim that a runtime
flag combination is valid when it isn't), FILE THEM AS NEW BEADS
with priority based on whether they gate the v0.1 reference claim.

Bead count grew 27 → 47 across the Erf epic. ALL growth was honest
scope, not scope creep — every new bead anchors a finding that
would otherwise be lost.

## Phase 3: tool integration

Three beads in parallel:

- **T1** (`integrate-1d` learns the head): primarily test-and-doc;
  validates the float64 dispatcher (I5) picks up the new head in
  the integrand. If T1 surfaces a substrate composition gap (Erf's
  T1 did — `sin(Erf(x))` failed), FIX IN THE DISPATCHER HOOK (not
  the substrate). Document the directory boundary in the bead.

- **T2** (`special-eval` per-head wire tool): umbrella tool with
  `--head=<name>` + `--precision=<int>`. Per-output tier dispatch
  (≤ 53 → float64; > 53 → arb-prec). Full 7-artefact tool
  contract; ≥ 10 goldens; per-tool README.

- **T3** (meijer-g closure validation): survey every existing
  dispatch-rule that emits the new head; round-trip through I6's
  bridge byte-identically. Any rule that doesn't round-trip is a
  finding worth filing.

## Phase 4: verification + docs

### V1 cross-cutting verification

ONE test file (~50 tests / 100+ expects) covering 8 cross-cutting
invariants that compose multiple substrate layers:

- (a) Float64 lane: special-eval @ p≤53 ≡ direct float64 call
- (b) Arbprec lane: special-eval @ p=N ≡ direct bigfloat call
- (c) Restriction-to-real: complex bigF(x+0i) ≡ real bigF(x)
- (d) cas-simplify pipeline: cross-head identity collapses
- (e) Meijer-G round-trip: zInverse byte-identical recovery
- (f) End-to-end integral via integrate-1d matches closed form
- (g) Foreign pass-through: unknown head round-trips byte-identical
- (h) Determinism: 5 repeat calls byte-identical

Plus a consolidated mutation-proving rollup
(`docs/refs/<head>-research/V1-mutation-proving-rollup.md`) audit
of every Phase 2/3 bead's mutation-proving + cross-bead findings.

Final: `bun run check` green is the V1 gate.

### D1 docs lockstep + epic close

- Verify all per-package READMEs in-lockstep (each substrate bead
  shipped its own; D1 verifies, doesn't re-do)
- ADR status amendment Proposed → Implemented (cite the epic-close
  worklog shard by number)
- Epic-close worklog shard (~400 lines synthesis: Context → What
  changed → Why these choices → Frictions surfaced → Acceptance →
  Bead-count audit → Pointers)
- `bd close <epic-id>` with a substantive closing note

## The beads-as-DAG discipline

Every step IS a bead. Discoveries surface as new beads with
dependency edges to their source bead. The pre-commit hook
auto-exports `.beads/issues.jsonl`; commit-and-push regularly so
the DAG is visible in git history.

For Erf the bead count grew:

- Initial plan: 26 beads
- Phase 0 discoveries: +1 (I6a from R4)
- Phase 1 discoveries: +4 (G2a, G3a, G8a, G8b)
- Phase 2 discoveries: +4 (I5a, R3-correction, pyld, gp75)
- Phase 3 discoveries: +2 (i4uv, c4cr)
- Phase 4: +0 (clean)
- **Final: 47 beads**

9 follow-ups remain open as P2/P3/P4. None gate the v0.1 claim.

## Local environment (current state)

### Available oracles (per `docs/refs/erf-research/R5-oracle-landscape.md`)

- **Wolfram Mathematica 14.3** + WolframScript 1.13.0 — gold tier
  (`/usr/bin/wolframscript`)
- **mpmath 1.3.0** — gold tier (`python3 -c "import mpmath"`)
- **sympy 1.14.0** — redundant gold (same engine as mpmath)
- **Boost.Math 1.83** `cpp_bin_float<N>` — silver tier real-only
  (`/usr/include/boost/math/special_functions/`)
- **SciPy 1.17.0** — bronze tier (`python3 -c "import scipy.special"`)
- **g++ 13.3.0** with libm — bronze tier
- **Julia 1.12.5** — binary present but SpecialFunctions.jl package
  NOT installed (G5 deferred)
- **Arb / FLINT** — NOT installed (G7 deferred). R5's HIGHEST-VALUE
  install recommendation: `apt install libflint-dev libflint-arb-dev
  && pip install python-flint`. Closes the single-engine
  complex-arb-prec gap (currently Wolfram + mpmath are the only
  pair for complex arb-prec).
- **libmpfr-dev** / **libgsl-dev** — runtime present but no -dev
  headers; C-linkage unavailable.

### Existing substrate

`packages/bigfloat/src/special.ts` — Γ family: `gamma`, `lgamma`,
`digamma`, `trigamma`, `polygamma`. Sister to your new
`special-funcs/<head>.ts`. The styling exemplar (algorithm narrative
+ Stirling shift threshold + cancellation accounting + optimal
asymptotic truncation when term magnitude increases) is the
canonical pattern.

`packages/bigfloat/src/complex.ts` — `cgamma`, `clgamma`,
`clgammaReflect`, `clgammaStirling`, `cdigamma`. Now also `bigW`,
`bigCErf`, `bigCErfc`, `bigCErfcx`, `bigCErfi`. Your new
`bigC<Head>` derivations belong here.

`packages/cas-core/src/special-functions.ts` — 28-head vocabulary
table + arity contracts + diff-rule dispatcher. Add your head's diff
rule here (and amend ADR-0023 if it's a new vocabulary entry).

`packages/quadrature/src/eval-numeric-expr.ts` — float64 dispatcher
hook (wraps `eval-expr.ts` with `applySpecial`). Extend
`ADMITTED_HEADS` with your new head; add to `SPECIAL_DISPATCH` Map.

`packages/meijer-core/src/bridges/` — bidirectional bridge layer.
Add `<head>.ts` mirroring `erf.ts`. The `zInverse` closure trick is
the load-bearing pattern.

`tools/special-eval/tool.ts` — umbrella wire tool. Extend the
per-head dispatch table to cover your new head.

## Critical lessons from the Erf epic (the 12 frictions distilled)

1. **Mutation-proving discovers algorithmic robustness, not just
   coverage**. If a perturbation is non-discriminating, document it
   as a property and supplement with a discriminating perturbation.

2. **Quoted research values can be wrong past their author's
   precision floor.** R5 §2.1 quoted erf(1.23) past digit 47 from
   mpmath's nstr@50 rounding artefact; the true value matched
   Wolfram + mpmath@100 + Boost three-way. Triangulate gold-tier
   computations before trusting a single oracle's emit.

3. **Wolfram input-trap (R5 §3.1)**: `N[Erf[1.23], 50]` returns
   ~16 digits because `1.23` parses as machine-precision double.
   ALWAYS construct as `Rational[num, den]` from the decimal-string
   parse.

4. **Oracle adapters MUST normalise scientific notation.** Wolfram
   emits `*^` exponent syntax (not `e`); mpmath/SciPy emit standard
   `e`. The cross-agreement comparator needs both. G2a in the Erf
   epic was a 90-spurious-finding bug from this.

5. **Wide-precision oracles have their own cancellation limits.**
   mpmath@60dps loses precision in `1 - 1e-50` (cancellation eats
   all 60 dps). For tail inputs (T8 InverseErfc), the composition
   `erfinv(1 - y)` is buggy; native `erfcinv` if it exists is
   correct; or use the asymptotic formula directly.

6. **DLMF 7.6.2 Borel form, not 7.6.1 textbook alternating
   Maclaurin.** For series-form arb-prec, alternation cancellates
   `~|z|²·log₂e` bits. Use the all-positive form. Generalise: prefer
   the all-positive form whenever the head admits one.

7. **bigErfc is NOT 1 - bigErf for |x| > x_c. bigErfcx is NOT
   exp(x²)·bigErfc(x).** Each function gets its own algorithm path
   on its own input range. Mirrors `expm1` / `log1p` pattern. The
   single non-obvious discipline; document in source.

8. **Karbach-Weideman is the only Faddeeva with closed-form
   prec-scaling.** Poppe-Wijers' `nu` is fitted to f64; Algorithm
   916 has no published prec-scaling. Karbach's `(τ_m, N)` derive
   from "highest Fourier coefficient < ε".

9. **τ_m must compute at BigFloat precision, not float64.**
   `Math.sqrt(...)` in a Karbach implementation caps accuracy at
   ~13 dp regardless of prec. Recompute at BigFloat working
   precision via `sqrt(_, work)`.

10. **SunPro 1993 verbatim port is the float64 gold standard.**
    33 years in service, byte-identical across 5 libms. The
    `SET_LOW_WORD(s, 0)` mantissa truncation becomes a 4-line
    `DataView` helper. Add a module-load endianness canary throwing
    `RangeError` on big-endian.

11. **Port C source verbatim. Don't re-derive from the paper.**
    I5's first Algorithm 916 draft had a sign error in the
    re-derivation; the Faddeeva.cc verbatim port worked first try.
    Documented as a discipline.

12. **Honest scope on inverses.** Multi-valued Riemann surface means
    complex `InverseErf` / `InverseErfc` have no canonical
    computational form; SciPy / Boost / Julia all decline.
    Hardcoded refusal in the umbrella tool. Don't try.

## How to start: Bessel J (the natural next head)

```sh
# 1. Read this handoff. Re-read CLAUDE.md.
cat docs/HANDOFF_per_head_special_function_methodology.md
cat CLAUDE.md

# 2. Inspect the Erf reference implementation
ls packages/bigfloat/src/special-funcs/erf.ts          # I1 + I2 substrate
ls packages/bigfloat/src/complex.ts                    # I3 extension
ls packages/quadrature/src/special-funcs/erf-float64.ts  # I5 SunPro port
ls packages/cas-core/src/special-funcs/erf-identities.ts # I4 symbolic
ls packages/meijer-core/src/bridges/erf.ts             # I6 bridge
ls tools/special-eval/tool.ts                          # T2 umbrella tool
ls bench/erf-anchor/                                   # Phase 1 corpus
cat docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md
cat docs/worklog/142-erf-epic-close.md                 # epic synthesis

# 3. Confirm bd ready / inspect existing follow-ups
bd ready
bd list --label=erf-anchor --status=open               # the 9 follow-ups

# 4. Create the Bessel J epic
bd create "[epic] World-class BesselJ: symbolic + arb-prec + numeric + Meijer-G bridge (reference implementation, per-head substrate prototype 2)" \
  --type=epic --priority=2 \
  --labels=besselj-anchor,cas-special-functions \
  --description="Apply the per-head substrate methodology shipped for Erf (epic 43hw, ADR-0040) to BesselJ. ..."

# 5. File the 5 deep-research beads (R1-R5) and dispatch parallel Opus subagents
# (use the prompts in this handoff as your starting template; adapt sources to
#  Bessel-specific literature — DLMF Ch.10, Watson 1944, NIST Handbook Ch.10,
#  SymPy bessel.py)

# ... etc., follow Phase 0 through Phase 4.
```

The substrate already exists; you're adding a new head, not
inventing a new pattern. The Erf prototype IS the spec.

## Key things specific to Bessel J vs Erf

(For your specific planning — not exhaustive)

- **Multi-parameter dispatch**: `BesselJ(ν, z)`. The arity is fixed-2,
  but the test corpus needs to vary `ν` (integer, half-integer,
  arbitrary real, complex). T1-T5 tiers cross-product with ν values.
- **Asymptotic regimes are more nuanced**: Bessel has 4 asymptotic
  expansions (DLMF §10.17). Stokes phenomena per regime. R2's
  algorithm taxonomy must enumerate.
- **Zeros of Bessel** instead of inverses for T8. DLMF §10.21
  references; mpmath has `besseljzero`.
- **Closed-form reductions** include `BesselJ(1/2, z) = √(2/πz)·sin(z)`
  (DLMF §10.16.1) — should canonicalize in cas-simplify.
- **Meijer-G bridge** has multiple canonical forms depending on `ν`
  integer-vs-half-integer-vs-general.
- **Existing substrate** already has Bessel diff rules
  (`packages/cas-core/src/special-functions.ts` cases for
  `BesselJ`/`Y`/`I`/`K`) per ADR-0023; the differentiable subset
  ships. Your arb-prec / float64 / Meijer-G bridge layers are new.

## Pointers

- **The Erf ADR** (your template): `docs/adr/0040-per-head-special-
  function-substrate-and-meijer-g-bridge.md`
- **The epic synthesis** (READ THIS): `docs/worklog/142-erf-epic-
  close.md`
- **The 5 research artefacts**: `docs/refs/erf-research/R{1-5}-...md`
- **The impl plans** (your subagent-prompt template):
  `docs/refs/erf-research/PHASE2-impl-plans.md`
- **The mutation-proving rollup** (V1 audit):
  `docs/refs/erf-research/V1-mutation-proving-rollup.md`
- **The Phase 1 corpus generator**: `bench/erf-anchor/generate-
  corpus.ts`
- **The cross-agreement comparator**: `bench/erf-anchor/cross-
  agreement.ts`
- **Per-bead worklogs**: `docs/worklog/{131-142}-*.md`
- **The umbrella wire tool**: `tools/special-eval/tool.ts`
- **The 9 open follow-ups**: `bd list --label=erf-anchor --status=open`

## Discipline that does NOT bend

From CLAUDE.md, in the order it bit during the Erf epic:

1. **Law 1 — Ground truth before code.** Open the ADR + the
   canonical reference + the current file shape BEFORE writing.
2. **Law 2 — Docs in lockstep with code.** Every code change
   ships paired doc updates IN THE SAME edit session.
3. **Rule 6 — Mutation-proving.** ≥ 3 perturbations cause RED, then
   restore. Document in the worklog.
4. **Rule 7 — Tests assert non-trivial invariants.** "Runs without
   errors" is not passing.
5. **Rule 9 — Beads are the only persistent tracker.** Every
   discovery is a bead. `bd update --notes` captures the "why" so
   future-you doesn't have to re-derive.
6. **Rule 10 — Literate prose comments.** Source files are
   exposition. The algorithm narrative at the top of `erf.ts` is
   the styling exemplar.
7. **PRD §6.1 — Honest scope.** Refuse cleanly with a tagged
   boundary error when you can't compute (multi-valued complex
   inverses, MAX_DOUBLE overflow). Never silently produce garbage.

The methodology worked because the discipline didn't bend. Repeat
the same way and Bessel J will be the same quality.

Good luck.
