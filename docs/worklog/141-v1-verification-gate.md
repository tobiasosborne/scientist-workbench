# 141 — V1 verification gate: Phase 4 cross-cutting test suite + mutation-proving rollup (2026-05-17)

> **Scope.** Close Phase 4 bead `scientist-workbench-52gu` (V1 — Phase
> 4 GATE) of the World-class Erf reference-implementation epic
> (`43hw`). Ship the cross-cutting integration test layer that exercises
> invariants ACROSS substrate axes (real arbprec × complex arbprec ×
> float64 × CAS simplify × Meijer-G bridge × integrate-1d), consolidate
> per-bead mutation-proving evidence into a single audit roll-up
> (`docs/refs/erf-research/V1-mutation-proving-rollup.md`), and run
> the unambiguous `bun run check` gate. With this shard closed, only
> D1 (epic close + docs lockstep finalisation) remains before the
> epic ships.

## Context

ADR-0040 pinned the per-head special-function substrate using Erf as
the v0.1 instantiation. By the time this bead was claimed, all
seven Phase 2 substrate beads (I1-I6 + I6a) and all three Phase 3
tool-integration beads (T1 integrate-1d, T2 tools/special-eval, T3
meijer-g-symbolic-only closure validation) were closed. Every
substrate axis had its own per-package test suite + mutation-proving
sweep documented in its own worklog shard (131-140). What was
missing was the *composition* layer: tests that PROVE the substrates
work TOGETHER through the wire surface (`tools/special-eval`) and the
adjacent tools (`integrate-1d`, `cas-simplify`-via-`@workbench/cas-
core`, `meijerGToHead`-via-`@workbench/meijer-core`), AND a single
audit artefact consolidating the 23+ mutation perturbations
distributed across the 10 shards.

CLAUDE.md Rule 7 ("'runs without errors' is not a passing test")
governed the test design: every assertion below pins a non-trivial
invariant. Rule 6 (port-and-verify + mutation-proving) governed the
audit: the rollup must reflect the literal RED-then-restored
evidence from each shard, not paraphrase or summarise.

## What changed

### `tools/special-eval/cross-cutting.test.ts` (NEW, 56 tests / 120 expects)

The Phase 4 cross-cutting test suite, organised into 8 invariant
groups matching the bead's a-h coverage matrix:

  | Group | Invariant tested                                                       | Pkg span                                    |
  |-------|------------------------------------------------------------------------|---------------------------------------------|
  | (a)   | Float64 lane wire bytes ≡ direct `erfFloat64` (I5)                     | quadrature → special-eval                   |
  | (b)   | Arbprec lane wire bytes ≡ direct `bigErf` @ 200 bits (I1) + `bigErfc(20)` regression | bigfloat → special-eval                     |
  | (c)   | Complex arbprec restriction-to-real: `bigCErf(x+0i).re ≈ bigErf(x)`; im = exact 0n | bigfloat (complex.ts ↔ special-funcs/erf.ts) |
  | (d)   | `casSimplify(Erfc(z) + Erf(z))` ≡ `int(1n)` byte-identically + idempotence | cas-core (I4)                               |
  | (e)   | `headToMeijerG(...).zInverse()` recovers args byte-identically for Erf / Erfc / Erfi across 5 sample shapes | meijer-core (I6)                            |
  | (f)   | `integrate-1d` Erf(x) on [0,1] matches DLMF §7.7.9 closed form within 1e-12 | quadrature → integrate-1d (T1)              |
  | (g)   | `casSimplify` preserves foreign `BesselJ` subterm byte-identically (PRD §2.3 foreign pass-through) | cas-core                                    |
  | (h)   | 5 repeat calls to special-eval at fixed (input, precision) return byte-identical output (ADR-0020 arbprec contract) | special-eval                                |

Plus a schema-consistency block (2 tests) that pins the wire shape
matches the substrate's `valueToBigFloat` / `valueToBigComplex`
decoder.

The test file lives alongside the existing `tool.ts` and
`goldens.spec.ts` in `tools/special-eval/` because that is the
LEAST-blast-radius landing site (per the bead's explicit
constraint): the umbrella tool already imports `@workbench/bigfloat`
and `@workbench/quadrature` as production dependencies; the
`cas-core` and `meijer-core` arms are added as *devDependencies*
in `package.json`. No new package created; no new directory created;
no other package's import graph changed.

### `tools/special-eval/package.json` (extend)

Added `@workbench/cas-core` and `@workbench/meijer-core` to
`devDependencies` so the test file can import them without polluting
the tool's production dep graph. The tool itself still depends only
on protocol / contract / bigfloat / quadrature.

### `docs/refs/erf-research/V1-mutation-proving-rollup.md` (NEW)

The consolidated audit document. Structure:

- **Per-bead mutation summary table** — 10 rows (7 substrate beads +
  3 tool-integration beads), mutation count, worst-case tests-RED
  count, test count, shard pointer.
- **Per-bead notes** — what each mutation perturbation pinned (e.g.
  "I3 mutation 1: swap `iz ↔ −iz` → 80+ tests RED across Q3/Q4
  corpus + parity tests").
- **Cross-bead findings** — 7 distinct surprises that surfaced
  through the mutation-proving discipline itself (R2 §5.2 algebra
  bugs, R3 §3.3 "Newton not needed" claim being wrong, `bigErfcx`
  threshold misspec, Faddeeva-Johnson sign error, I1 hallucinated
  reference, `PatternSpec.zMatch` asymmetry, `bigErfi` substrate
  routing).
- **Total mutation-proving footprint:** **23 distinct
  perturbations** confirmed RED + restored across the epic.

### `docs/worklog/README.md` (extend)

Added the row for shard 141.

## Why these choices

### Landing site: `tools/special-eval/cross-cutting.test.ts`

The bead's prompt explicitly directed the LEAST-blast-radius site,
naming `tools/special-eval/test/erf-cross-cutting.test.ts` as a
candidate. I deviated by placing the file at
`tools/special-eval/cross-cutting.test.ts` (no `test/` subdir)
because the `tsconfig.json` `include` glob is `tools/*/*.ts` — a
subdirectory file would not be typechecked. The existing
`tool.test.ts` files for `integrate-1d`, `hypergeometric-pfq`,
`meijer-g`, etc. all live at `tools/<name>/*.test.ts` (no subdir).
Following the established pattern.

### Devdep injection rather than a new package

A separate `packages/special-funcs-verify/` package would have
required new infra: a `package.json`, a `tsconfig` slot, a new
workspace entry, no goldens, an empty `src/index.ts` (the package
exports nothing — it's tests-only). The dev-dependency injection is
six lines of JSON and zero new files; the existing `bun test`
workspace glob picks up the cross-cutting test file automatically.

### No new `bd` issues filed

The mutation-proving rollup surfaced no new findings. Every "friction"
surfaced through the mutation-proving discipline was already
documented in the originating shard's frictions section AND already
acted on (e.g. R3 §3.3's incorrect "Newton not needed" claim was
caught in worklog 133 and the impl already adds one Newton step).
The rollup document cites the friction *as historical evidence*, not
as a new finding requiring action.

### Schema sanity tests checked decoder round-trip, not schema introspection

The first draft asserted `bigfloatSchema.kind === "tagged"`, which
failed because `Schema` is not a `Value` — it has `.node.tag`, not
`.kind`. The corrected test checks what actually matters: the
substrate's `valueToBigFloat` / `valueToBigComplex` decoders MUST
accept the wire tool's output, and the decoded BigFloats must satisfy
the substrate's own invariants (`precision >= 53`, `exponent` is a
finite integer). A schema-introspection test would have asserted
machinery; the decoder-round-trip test asserts the load-bearing
property.

## Frictions surfaced

### F1 — IntegerValue value field is string, not bigint

The first version of the achieved-precision tests asserted
`expect(precField.value).toBe(53n)` (BigInt literal). RED:
`Expected: 53n, Received: "53"`. The wire encoding of IntegerValue
stores `value: string` on the wire (per ADR-0004 + `packages/
protocol/src/kinds.ts:35-38`); BigInt is the *parsed* form, the
canonical wire form is decimal string. Fixed by comparing against
the string `"53"` and `String(decimalToBinaryPrecision(60))`.

This is worth pinning as a hallucination-risk callout if it recurs:
the protocol's number-bearing fields are strings on the wire; only
inside compiled TS code do they sometimes round-trip through BigInt.

### F2 — `fromFloat64` returns minimal-bit BigFloat, not 53-bit

The first version of test (a) asserted
`bigfloatBytesEq(wireBf, fromFloat64(direct))`. RED on `T1: erf(0.1)`,
`T1: erf(0.5)`, etc. Diagnosis: `fromFloat64(0.5)` returns a BigFloat
with `precision=1` (the float64 0.5 = 1 × 2^-1 has 1 bit of mantissa
after the implicit leading 1), but the wire applies
`normalise(bf.mantissa, bf.exponent, 53)` to pad to exactly 53. So
the byte-comparison must include the same normalise step.

Fixed by replicating the wire's two-step `fromFloat64 → normalise(.,
., 53)` in the test expectation. A clean separation of concerns: the
wire's wrap is exposed via the literal step sequence; the test
asserts byte-identity against THAT exact wrap. A future refactor that
splits or rearranges the wrap step would surface here.

### F3 — Lazy require() pattern triggered lint warning

The first version of `subBfManual` used `require()` inside the
function body (to avoid pulling the arithmetic barrel for an arrow-
function-test-only helper). That's a CommonJS pattern not idiomatic
to ESM-only Bun + TS code; replaced with a top-level
`import { sub as bfSub } from "@workbench/bigfloat"`. No real cost
(the substrate is already imported for other reasons in this test).

## Acceptance

- [x] `tools/special-eval/cross-cutting.test.ts` shipped covering all
  8 a-h invariant groups + schema-consistency.
- [x] **56 tests / 120 expect() calls** (target: ≥8 tests, ≥30
  expects — ship at 7x / 4x the floor).
- [x] **`bun test tools/special-eval/cross-cutting.test.ts`: 56 pass /
  0 fail.**
- [x] `docs/refs/erf-research/V1-mutation-proving-rollup.md` shipped
  with per-bead notes (10 beads), per-bead mutation counts, 7 cross-
  bead findings, total footprint **23 mutation perturbations
  confirmed RED across the epic**.
- [x] Rollup cites every Phase 2/3 worklog shard (131-140) by
  number + path.
- [x] `tools/special-eval/package.json` extended with `@workbench/cas-
  core` + `@workbench/meijer-core` devDependencies (minimal blast
  radius).
- [x] **`bun run check` green** (final gate): `summary: 101 passed, 7
  skipped, 0 failed` — 14 phases (typecheck, conventions, gen-
  workbench-barrel, workspace `bun test`, per-tool `--test` hooks ×
  55 tools, oracle phase × 55 tools, provenance, determinism,
  examples-vs-fn equality). Captured 2026-05-17. The `summary:` line
  is the unambiguous Phase 4 V1 GATE signal.
- [x] Worklog shard added (this shard); README index extended.
- [x] No new beads filed (no findings surfaced — every friction in
  the rollup was already documented + acted on in its originating
  shard).

## Pointers

- ADR-0040: `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`
- Bead: `scientist-workbench-52gu` (V1 — Phase 4 GATE).
- Epic: `scientist-workbench-43hw` (World-class Erf).
- Cross-cutting tests: `tools/special-eval/cross-cutting.test.ts`
- Mutation rollup: `docs/refs/erf-research/V1-mutation-proving-rollup.md`
- Phase 2 shards: 131, 132, 133, 134, 135, 136, 137
- Phase 3 shards: 138, 139, 140
- Next: D1 (epic close + docs lockstep finalisation) — the only Phase
  4 bead remaining open.
