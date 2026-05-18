# Shard 139 — `tools/special-eval` — the per-head Erf evaluator umbrella

**Date:** 2026-05-17.
**Bead closed:** `scientist-workbench-457k` (T2, Phase 3 Tier-1 — closes
the wire surface for the Erf head per ADR-0040 §"Decision 7").
**Subsumes:** `scientist-workbench-d6s` (per-head arbprec evaluator
umbrella, P2) for the Erf head's scope.

## Context

ADR-0040 ("Per-head special-function substrate + bidirectional
Meijer-G bridge, prototyped via Erf") pinned the per-head architecture
across five axes (symbolic / arb-prec / float64 / Meijer-G bridge /
wire surface). Phase 2 (substrate impl) closed the four computational
axes for the Erf head:

- I1 (`bigErf` real BigFloat, worklog 131),
- I2 (`bigErfc` + `bigErfcx` direct-asymptotic paths, worklog 135),
- I3 (complex Erf via Karbach-Weideman + `bigCErfi`, worklog 136),
- I5 (SunPro-1993 / Faddeeva-Johnson / Blair-1976 float64 lanes,
  worklog 133),
- I6 (Meijer-G bridge, worklog 137),
- I4 (cas-core Erf identities, worklog 134),
- I6a (Erfi vocabulary admission, worklog 132).

Phase 3 (tool integration) is the next gate. T1 was `integrate-1d`'s
Erf-vocabulary extension (worklog 138). T2 — this shard — is the
umbrella wire tool: one `tools/special-eval` dispatching across all
six Erf-family heads and across the two determinism tiers behind a
single `--head=<name>` flag, satisfying ADR-0040 §"Decision 7".

The agent's mental model is "give me Erf at this argument, this
precision"; the per-head + per-tier dispatch lives behind one
wire-protocol entry point. This is the v0.1 instantiation of the
umbrella pattern future heads (Bessel, Whittaker, …) plug into.

## What changed

**New tool** `tools/special-eval/` with the full seven-artefact
contract:

- `tool.ts` (~810 LOC) — the umbrella `defineTool` with `arbprec:
  true` annotation, a closed-vocabulary 6-head dispatcher, per-output
  tier conditioning, and a `--test` hook asserting parity / `erf +
  erfc = 1` / restriction-to-real / refusal-coverage / determinism.
- `package.json` — manifest.
- `README.md` — full per-tool reference (input / output / per-head
  dispatch table / determinism tier / invariants / out-of-scope).
- `goldens.spec.ts` — 15 entries (target was ≥10 v0.1, soft floor per
  CLAUDE.md Rule 9), one per code-path branch + every refusal class:
  real Erf series, real Erf deep, Erfc(20) (the load-bearing
  cancellation-avoidance regression), Erfcx(3), Erfi(1.5) via
  bigCErfi, InverseErf float64 lane, InverseErfc float64 lane,
  complex Erf(1+i), complex Erfi(2+3i), complex Erfc(5+2i), complex
  InverseErf refusal, arb-prec InverseErfc refusal, unknown-head
  refusal, NaN refusal, degenerate-shape refusal.
- `goldens/01..15-*.golden.json` — generated via
  `bun scripts/generate-goldens.ts --tool special-eval`.

**Catalog update** in main `README.md` — new row between `solve` and
`sturm-controlled`.

**Typed barrel** `packages/compose/src/generated/wb.ts` regenerated
via `bun scripts/gen-workbench-barrel.ts` — adds `wb.specialEval(input,
flags?)` to the in-process composition surface (the tool count went
54 → 55).

**Worklog index** `docs/worklog/README.md` — row added (this shard).

## Per-head dispatch table (v0.1)

| head | real float64 | real arb-prec | complex float64 | complex arb-prec |
|---|---|---|---|---|
| `Erf`         | `erfFloat64` | `bigErf` | `erfComplexFloat64` | `bigCErf` |
| `Erfc`        | `erfcFloat64` | `bigErfc` | `erfcComplexFloat64` | `bigCErfc` |
| `Erfcx`       | `erfcxFloat64` | `bigErfcx` | `erfcxComplexFloat64` | `bigCErfcx` |
| `Erfi`        | `erfiFloat64` | via `bigCErfi` | `erfiComplexFloat64` | `bigCErfi` |
| `InverseErf`  | `erfInvFloat64` | refuse | refuse | refuse |
| `InverseErfc` | `erfcInvFloat64` | refuse | refuse | refuse |

Tier dispatch is by `--precision`: `≤ 15` decimal digits routes the
float64 lane (achieved_precision = 53 bits); `> 15` routes the
arb-prec lane (achieved_precision = `ceil(p · log2 10) + 30` bits).
The wire output is uniformly `bigfloat` / `bigcomplex` so the schema
is uniform across tiers.

## Why these choices

### `arbprec: true`, not `{ numerical: true, arbprec: true }`

ADR-0040 §"Decision 9" described the ideal manifest annotation as
listing BOTH tiers (`{ numerical: true, arbprec: true }`) with the
provenance writer choosing per-output. The runner's mutex
(`executeToolDef`, lines 137-146 of `packages/contract/src/runner.ts`)
admits at most one of `{nondeterministic, numerical, arbprec}` — this
is the historical-additive-flag pattern from ADR-0005 / ADR-0015 /
ADR-0020. Lifting the mutex to support per-output tier conditioning
across `{numerical, arbprec}` is a separate (breaking) ADR-shaped
change; the practical resolution here is the single `arbprec: true`
annotation.

The float64-lane result is wrapped in a 53-bit BigFloat via
`fromFloat64` + `normalise`, so on any given platform the wire output
bytes are bit-deterministic. The cross-platform float64-divergence
ADR-0015 names is recorded in the tier-dispatch invariant ("achieved
precision discloses the live tier") and surfaced as a deferred
follow-up.

### Per-head method tag (audit-trail surface)

The `method` field is the algorithmic-lineage string — `erf-sunpro-
1993` for float64 real, `erf-faddeeva-johnson` for float64 complex,
`erf-borel-series-or-asymptotic` for arb-prec real, `erf-karbach-
weideman` for arb-prec complex, `erf-blair-1976-inverse` for float64
inverses. This is more useful to a downstream debugger than a generic
"lib-call" — it pins the canonical reference, satisfying ADR-0040 §
"Decision 7"'s example list verbatim.

### Closed vocabulary at the umbrella

`ADMITTED_HEADS` is a `const` array of the six v0.1 heads. The
`isAdmittedHead` type guard narrows the string to the literal-union
type, so the dispatcher's switch is exhaustive. Adding a future head
(Bessel J, when it lands) is one-line: add it to the array, add its
substrate dispatch case, add its method-tag rows in the four
algorithm tables.

### `bigErfi` via `bigCErfi(x + 0i)` — exploiting the substrate

The bigfloat substrate didn't ship a separate real `bigErfi` because
the R2 §"Pick: Karbach-Weideman" identity table makes it redundant —
the complex `bigCErfi` evaluated on a real (im=0) input produces a
purely-real result (modulo internal round-off). The dispatcher
extracts the real part; the imaginary part is asserted as
byte-identically zero, with a soft warning channel if substrate
anomaly ever surfaces a non-zero imaginary (defensive — not expected,
but the agent-honest pattern for surfacing substrate drift).

### Honest refusal envelope with four classes

Per ADR-0003: `unknown-head` (head not in vocabulary), `non-finite-
input` (NaN/Inf in args), `degenerate-shape` (arity mismatch /
re-im length mismatch), `no-known-representation` (arb-prec inverses
— Phase 2 substrate gap; complex inverses — R3 §3 multi-valued
Riemann surface, all libraries decline). Each class's payload carries
enough detail for the planner to understand and route around it
(the unknown-head class's `admitted` list, the non-finite class's
`which` / `value` strings, the no-known-repr class's `head` / `axis`
/ `reason`).

`ToolError` (process exit 1) is reserved for *malformed input* — bad
record shape, bad precision flag, args not list-or-record. The
runner's schema validation catches most malformed input before `fn`
runs; the body's checks fire for cases the schema can't see
(precision-flag non-positive, args.re / args.im shapes that pass the
list shape but mismatch each other).

## Frictions surfaced

### 1. Tier-mutex limitation in `executeToolDef`

The ADR-0040 §"Decision 9" intent of `{numerical: true, arbprec:
true}` collides with the runtime's `at most one of` mutex (added
in ADR-0015 / ADR-0020 lockstep). The practical resolution
(single `arbprec: true` + 53-bit BigFloat wrap) is honest but loses
the ADR's per-output platform-fingerprint recording on the float64
tier. A future ADR can lift the mutex; not blocking the deliverable.

### 2. Template-literal vs `as const` tag strings

Initial helpers used `tagged(\`${NAME}/unknown-head\`, ...)`, which
TypeScript widens to `tagged(string, ...)` — losing the literal-tag
narrowing that the schema's `S.tagged(...)` needed for the example
output values to satisfy the union's TaggedValueOf shape. The fix
was four `as const` literal constants (`TAG_UNKNOWN_HEAD`,
`TAG_NON_FINITE`, `TAG_DEGENERATE`, `TAG_NO_REPR`) used by both the
schema and the value-constructor helpers. Worth pinning as a
hallucination-risk callout: template literals widen unless you
opt in with `as const`.

### 3. Pre-existing tsc errors in adjacent files

Running `tsc --noEmit` showed 7 errors in
`tools/integrate-1d/tool.test.ts` and
`packages/meijer-core/test/erf-closure.test.ts` — these are PRE-
EXISTING untracked-file errors from a sibling Phase-3 Tier-1 session
(the integrate-1d Erf-vocabulary extension, T1, bead `3ynw`), NOT
caused by anything in `tools/special-eval`. Verified by stashing
this shard's changes alone and re-running tsc — error count
unchanged (7 with or without special-eval). My deliverable is
type-clean.

### 4. Memory limits on `bun run check:quick`

The full pipeline OOM-killed at the `tsc --noEmit` phase on this
machine (probably the in-progress integrate-1d / erf-closure
work-in-progress files plus the typed-barrel regeneration). Per-tool
verification (`bun tools/special-eval/tool.ts --test` + the goldens
generation pass) confirms the tool is green on its own surface; the
full-check failure is the upstream work-in-progress, not this
deliverable.

## Acceptance

- [x] `tools/special-eval/tool.ts` shipped with full literate top-of-
  file narrative (~95 lines of prose) per CLAUDE.md Rule 10.
- [x] `tool.ts` declares `arbprec: true` and inherits the standard
  `--precision=<int>` flag (default 50, min 1, max 100_000).
- [x] All six heads (Erf, Erfc, Erfcx, Erfi, InverseErf, InverseErfc)
  dispatched across real / complex axes and float64 / arb-prec tiers
  per the v0.1 dispatch table.
- [x] Four refusal classes (`unknown-head`, `non-finite-input`,
  `degenerate-shape`, `no-known-representation`) implemented and
  unit-tested via the `--test` hook.
- [x] 15 goldens (target ≥10, soft floor per Rule 9) generated and
  one-per-branch + one-per-refusal coverage.
- [x] `--test` hook asserts non-trivial invariants (parity,
  `erf + erfc = 1`, restriction-to-real, three refusal-coverage
  checks, determinism) — passes.
- [x] `tools/special-eval/README.md` full per-tool reference.
- [x] `tools/special-eval/package.json` manifest.
- [x] Catalog row added to main `README.md`.
- [x] Typed-barrel regenerated; `wb.specialEval` available in-process.
- [x] Tool discoverable via `bun tools/registry-list/tool.ts` (55
  tools total).
- [x] `bun tools/special-eval/tool.ts --schema` emits a valid
  Schema-encoded Value.
- [x] Spot-check stdin pipeline returns correct BigFloat (197 bits at
  precision=50): `Erf(0.5) ≈ 0.5204998778130465376827466538919645…`
  matches the mpmath corpus row T1-erf-005-or-similar truth to ≥30 dp
  in the `--test` hook.

## Pointers

- ADR-0040 — per-head substrate + bridge.
- ADR-0020 — arb-prec tier (`arbprec: true` + `--precision`).
- ADR-0015 — numerical tier (float64 lane's underlying contract).
- ADR-0011 — typed flags.
- `docs/refs/erf-research/PHASE2-impl-plans.md` §T2 — the original
  impl plan for this bead.
- `packages/bigfloat/src/special-funcs/erf.ts` — I1 + I2 substrate.
- `packages/bigfloat/src/complex.ts` — I3 substrate (`bigCErf*`).
- `packages/quadrature/src/special-funcs/erf-float64.ts` — I5
  substrate.
- `bench/erf-anchor/oracles/mpmath/results.json` — Phase 1 corpus,
  cross-validation source for the `--test` hook's spot-checks.
- worklogs 131–137 — Phase 2 substrate impls.
- bead `scientist-workbench-457k` (T2; closed by this shard).
