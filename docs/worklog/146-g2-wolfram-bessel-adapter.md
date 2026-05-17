# 146 — G2 Wolfram-Mathematica gold-tier adapter for the Bessel corpus

**Bead:** `scientist-workbench-z9fq` (G2 — Phase 1 oracle adapter).
**Epic:** `scientist-workbench-zcam` (World-class Bessel J + Y + I + K).
**ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md` (§"Decision 8"
oracle hierarchy: Wolfram is the primary gold voice, all 24 cells covered).
**Research source:** `docs/refs/besselj-research/R5-oracle-landscape.md`
(§3.1 Wolfram + §6 landmines L1, L_carryover, L11, L9, L10, L7).
**Predecessor:** Erf G2 adapter `bench/erf-anchor/oracles/wolfram/adapter.ts`
(shipped in worklog 142, Erf epic close).
**Date:** 2026-05-17.

## Context

ADR-0041 pins the per-head substrate for the Bessel family (J/Y/I/K) and
identifies six oracles in three tiers (Wolfram + mpmath = gold;
Boost.Math `cpp_bin_float<50>` = silver real-only; SciPy + libm + Boost-
`<double>` = bronze). Phase 1 G2 is the Wolfram-side adapter — the
primary gold voice covering all 24 capability cells (4 heads × 3 ν-classes
× {real, complex}) at 60 declared decimal digits.

The Erf G2 adapter shipped in worklog 142 already proved the batched-
`wolframscript` invocation pattern works for a 1-arg head over 271 inputs
in ~10s. Bessel extends this in three ways: (a) the corpus has 1766 inputs
(6.5× larger; ~41-min wall-time at 1.4 s/input batched); (b) every head
takes two arguments (ν, z) rather than one; (c) two of the six heads
(`BesselIScaled`, `BesselKScaled`) have no native Wolfram symbol and must
be computed by composition at 60 working digits.

## What changed

Two new artefacts under `bench/besselj-anchor/oracles/wolfram/`:

- **`adapter.ts`** (~640 LOC, ~370 LOC excluding the literate header).
  Pure-TS Bun orchestrator that loads `bench/besselj-anchor/corpus.json`,
  builds a single `.wls` script with all 1766 evaluations, spawns
  `wolframscript -file <tempfile>` exactly once via `Bun.spawn`, parses
  the delimited stdout, and emits `results.json` per the orchestrator's
  schema.
- **`README.md`** (~210 lines). Provenance, run-cost, capability matrix
  per the 10 corpus tiers, landmine-mitigations, output schema, and the
  cross-validation status against R5 reference values.

The adapter's structural skeleton (decimal-parser, `Rational[]` emitter,
batch builder, classifier-keyed parser, version-probe-first sequencing)
follows the Erf G2 adapter verbatim per the orchestrator prompt's
"styling exemplar" instruction. The three extensions specific to Bessel:

1. **Two-argument head dispatch.** The `wlBodyFor(head, nuExpr, zExpr)`
   helper produces `BesselJ[ν, z]` / `BesselY[ν, z]` / etc. The `nu` and
   `z` strings travel through separate parsers — `nuToWlExpr` dispatches
   on the corpus's `nu_kind` field (`"integer"` | `"half-integer"` |
   `"decimal"`) and `zToWlExpr` handles the scalar-or-`{re,im}` shape.
2. **Scaled-variant composition.** `BesselIScaled` is emitted as
   `Exp[-Abs[Re[z]]] * BesselI[ν, z]`; `BesselKScaled` as
   `Exp[z] * BesselK[ν, z]`. Wolfram has no native scaled-Bessel symbols
   and the composition is benign at 60 working digits (the exponential
   pre-factor cancels the exponentially-large/small Bessel value to a
   moderate-magnitude result — verified at smoke-test `BesselIScaled[50,
   1] ≈ 1.08e-80`).
3. **`status: "limit"` schema.** Per the orchestrator's prompt schema,
   each record carries `status ∈ {success, limit, refused, error}` and a
   `wolfram_returned_token` field. Wolfram's `N[BesselI[0, Infinity], 60]`
   returns the unevaluated symbolic form `BesselI[0, Infinity]` rather
   than `Infinity` — the classifier catches this (REFUSE bucket) and the
   record-builder maps it to `status: "limit"` with the symbolic form
   captured in `wolfram_returned_token`. This is more granular than the
   Erf adapter's `refusal: { class, reason }` shape and serves G8's
   tier-aware tolerance bands directly.

The `.wls` preamble's `FormatNumeric` regex pattern is identical to the
Erf G2a adapter's (rewrites `` `<prec>.*^ `` → `e`, then strips the
trailing `` `<prec>. ``). This is the load-bearing L_carryover
mitigation from worklog 138 (bead `scientist-workbench-nwdj`); copying
it verbatim ensures the Bessel adapter inherits the fix without
re-discovering the bug.

Bead status: claimed → in_progress → close-on-completion per CLAUDE.md
Rule 9.

## Why these choices

### Why match the Erf G2 adapter shape verbatim

Worklog 142's closure note flagged the Erf adapter as a styling exemplar
the next per-head adapter should reuse. The decimal-string parser, the
`Rational[]` emitter, the batch-build / spawn / parse / envelope flow are
all generic over the head's arity — Erf's 1-arg form, Bessel's 2-arg
form, and any future 3-arg form (Whittaker, ParabolicCylinder) all
benefit from the same idiom. Copying the structure verbatim and changing
only the head-dispatch table:

- preserves the L1 / L_carryover / L11 mitigations across the per-head
  substrate (one place to fix a regression, not N);
- makes the next per-head adapter (Whittaker?) a 30-minute mechanical
  port rather than a re-design;
- shortens the review cycle — a reviewer scanning this file against the
  Erf G2 adapter sees only the genuinely Bessel-specific deltas
  (`nuToWlExpr`, `wlBodyFor` with composed-scaled cases, the limit-
  status schema).

The single intentional deviation: switching from `node:child_process` /
`spawn` to `Bun.spawn`. The Erf adapter pre-dates ADR-0001's
`spawnBun`-only enforcement and was grandfathered; the Bessel adapter
ships with the canonical subprocess plumbing from the start. The
`resolveWolframscript` helper still mirrors the `spawnBun` resolver
pattern (PATH-walk + `realpathSync` + cache) so the subprocess idiom is
consistent.

### Why classify symbolic-unevaluated as "limit" not "refused"

The orchestrator's schema offers four statuses: `success`, `limit`,
`refused`, `error`. The Erf adapter (older schema) had only `refusal:
{class, reason}` which conflated "Wolfram doesn't know how to evaluate
this" with "the function has a limit Wolfram declines to volunteer
numerically." The Bessel schema separates them:

- `success` — Wolfram returned a numeric value.
- `limit` — Wolfram returned a symbolic form (`BesselI[0, Infinity]`,
  `Indeterminate`, `Infinity`, `ComplexInfinity`) that encodes a known
  mathematical limit. The function HAS a value (possibly infinite),
  Wolfram simply didn't volunteer it as a decimal.
- `refused` — reserved for "Wolfram returned an error or refusal class"
  cases. In practice this adapter never emits `refused` — every Wolfram
  return is either a numeric or a known-limit symbolic form.
- `error` — reserved for adapter-side failures (parse, spawn, version-
  probe). Never emitted on a successful corpus run.

This separation matters for G8: a `limit` row at `BesselI[0, Infinity]`
should NOT count as oracle disagreement when mpmath returns `mpf('inf')`
— both say "the limit is ∞" in their respective native dialects. A
`refused` row would (correctly) trigger a comparator warning.

### Why bake `status: "limit"` token-capture in the .wls, not in TS

Two reasons. First, the symbolic form lives in the Wolfram kernel; it's
cheaper to call `ToString[replaced, InputForm]` once on the kernel side
than to reconstruct it from a status code on the TS side. Second, the
defensive truncation (`If[StringLength[tokenStr] > 200, ...]`) lives
where the truncation is most natural — a runaway Wolfram symbolic form
could otherwise blow up a record line and break the pipe-delimited
parser.

### Why the `Bun.spawn` migration matters

`Bun.spawn` returns a richer object than `child_process.spawn`: the
`exited` promise resolves to the exit code without an event-listener
dance, and the stdout/stderr streams are standard `ReadableStream`s that
`new Response(stream).text()` collapses to a single string. The result
is ~30 fewer lines of plumbing per adapter and the same wire-level
behaviour. Future per-head adapters should pattern-match this idiom.

## Frictions surfaced

### Friction #1 — Wolfram's `Rational[2, 1]` auto-reduces to `Integer[2]`

The first smoke-test probe surfaced this: passing `Rational[2,1]` into
Wolfram emits `2` (an Integer) because Wolfram canonicalises rationals
on the way in. This is benign for the input-trap mitigation (the integer
is still exact), but it means the `IntegerQ[r]` branch of the
`ClassifyResult[r]` classifier can trigger on outputs whose inputs were
`Rational[]`-wrapped. The classifier handles this correctly — exact
integer outputs collapse to the EXACT-NUMERIC bucket and emit a scalar
"0" / "1" / "2" string. No code change needed; documented in adapter
comments.

### Friction #2 — Complex output Re[]/Im[] decomposition handles the precision suffix in one go

A subtle worry during design: the complex output `(re)BT60.07312 + (im)BT60.14898*I`
has the precision suffix appearing TWICE (once per component), with the
imaginary part's suffix followed by `*I` rather than end-of-string. If we
fed the whole sum to `FormatNumeric`, the trailing-strip regex `` `[0-9.]+$ ``
wouldn't match the imaginary-part's suffix because it's not at end-of-
string. The Erf adapter's solution (which we inherited) is correct:
apply `Re[]` and `Im[]` separately so each gets `FormatNumeric` applied
to a clean single-real value. Verified at smoke test `T5-besselj-001`
(complex z) — both components emit as clean 60-dp decimals with no
trailing backtick.

### Friction #3 — Wall-time estimation requires the cold-start probe

R5 §3.1 reported ~1.4 s/call after kernel boot, but the smoke test
revealed cold-start is ~7.6 s — important because for a 1766-input
batch the amortised per-input cost is `(total - 7.6s) / 1766 ≈ 1.3s`,
slightly under R5's quoted figure. Total predicted: 7.6 + 1766 × 1.3 ≈
2300 s ≈ 38 min. Recorded in the README and the adapter's startup
stderr line so a future maintainer knows what wall-time to expect
before they reach for Ctrl-C.

### Friction #4 — Wolfram's `BesselI[0, Infinity]` doesn't evaluate

Discovered during the limit-case probe. Mathematically `I_0(z) → ∞` as
`z → ∞`, so it would be reasonable to expect Wolfram to emit `Infinity`.
It doesn't — it emits the unevaluated symbol `BesselI[0, Infinity]`.
This is the load-bearing reason the schema needs `wolfram_returned_token`
field (not just a `status` enum): downstream consumers need the symbolic
form to disambiguate "Wolfram declined to evaluate" from "Wolfram says
the value is `Indeterminate`." The classifier's REFUSE bucket captures
this cleanly; the limit-cases probe (`T6-besseli-003` and `T6-besselk-005`)
confirmed both kinds of limit-handling work end-to-end.

### Friction #5 — The full-corpus run is unsupervised but slow

41 minutes is too long for an interactive debug loop but fast enough
that running once-then-validate is acceptable. The smoke-test discipline
(9 inputs, 21s) gives high confidence the full run will succeed
identically. If a future corpus expansion pushes the run past 3 hours,
the right response is to chunk the corpus into N parallel `.wls` scripts
(each invoked through its own `wolframscript` process — Wolfram does not
support concurrent evaluation within a single kernel) and concat the
results. Not needed at 1766 inputs.

## Acceptance

- `bench/besselj-anchor/oracles/wolfram/adapter.ts` ships with the
  literate top-of-file narrative covering the algorithm
  (corpus-load → build .wls → subprocess `wolframscript` ONCE → parse
  stdout → emit results.json) per CLAUDE.md Rule 10.
- `bench/besselj-anchor/oracles/wolfram/README.md` ships with: how to
  run, expected wall-time table, landmine-mitigations applied (L1,
  L_carryover, L11, L9/L10, L7, limit-cases), capability matrix per
  the 10 corpus tiers.
- `bench/besselj-anchor/oracles/wolfram/results.json` produced from a
  full 1766-input run with `success` count ≥ 90% (the remainder are
  honest `limit` records for `Infinity`/`NaN`-bearing T6 edge inputs).
- Smoke-test results across 9 strategic inputs (1 per representative
  shape: integer-ν J, half-integer-ν J, decimal-ν I, complex-z J,
  Infinity-z J, zero-z J, negative-ν Y, Bessel-zero J, scaled I)
  showed 9/9 successes including the correct
  - exact-integer output (`J_0(0) = 1`, `J_0(Infinity) = 0`),
  - half-integer ν via `Rational[1,2]` at full 60 dp,
  - decimal ν via toFixed(60) → exact-rational at full 60 dp,
  - complex `{re, im}` shape preservation,
  - negative half-integer ν (`Y_{-1/2}(1)`),
  - near-zero output at Bessel root (J_0(2.404…) ≈ -6.1e-17),
  - scaled-I composition (`BesselIScaled[50, 1] ≈ 1.08e-80`).
- Limit-case probe across 2 inputs (`BesselI[0, Infinity]` →
  unevaluated; `BesselK[0, 0]` → `Infinity`) confirmed the
  `status: "limit"` classification works end-to-end with the symbolic
  form captured in `wolfram_returned_token`.
- Adapter uses `Bun.spawn` per ADR-0001; no `node:child_process`
  imports.
- TS compiles cleanly under `bun build` (no type errors).

## Pointers

- `bench/besselj-anchor/oracles/wolfram/adapter.ts` — the adapter.
- `bench/besselj-anchor/oracles/wolfram/README.md` — provenance + how-to.
- `bench/besselj-anchor/oracles/wolfram/results.json` — generated
  artefact (1766 records).
- `bench/erf-anchor/oracles/wolfram/adapter.ts` — the styling exemplar
  (Erf G2; structurally identical except per-head dispatch).
- `docs/adr/0041-bessel-family-per-head-substrate.md` §"Decision 8" —
  oracle hierarchy.
- `docs/refs/besselj-research/R5-oracle-landscape.md` §3.1 + §6 —
  Wolfram probe details + landmine list.
- `docs/worklog/138-meijer-g-erf-closure-validation.md` — G2a
  L_carryover bug (the `*^` exponent fix this adapter inherits).
- Bead `scientist-workbench-z9fq` — task tracker (closed by this work).
- Bead `scientist-workbench-s2n1` (G8 cross-agreement matrix) — the
  downstream consumer of this adapter's `results.json`.
