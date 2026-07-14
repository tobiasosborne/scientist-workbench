# ADR-0020 — Arbitrary-precision numerical tier (bigfloat substrate)

**Status:** Accepted — 2026-05-07
**Beads:** scientist-workbench-hv0 (epic; the tstournament problem-13
"Meijer G mega-test" forcing this ADR), -hv0.1 (this ADR + the
`packages/bigfloat` substrate it specifies).
**Related:** ADR-0014 (first numerical tier — float64 dense linalg);
ADR-0015 (determinism tier; this ADR is the parallel addition for the
*more* deterministic arb-prec tier); ADR-0005 (externalised entropy —
the original additive-flag pattern that ADR-0015 mirrored and that
this ADR mirrors again); ADR-0007 (per-output `precision`-style field
— the precedent for representing per-execution precision data); ADR-
0010 (`defineTool` / `runTool` split — the substrate that lets
`packages/bigfloat`'s in-process surface and any future arb-prec
tool's wire surface share one implementation); ADR-0011 (typed flag
declarations — `--precision` is added as a standard flag using the
existing `F.int` discipline).

## Context

ADR-0014 (`linalg-solve`, `numerical: true`, float64) ships pure-TS
numerics at machine precision. ADR-0015 names the determinism cost:
`numerical: true` outputs are bit-identical only **given the platform
fingerprint**, because IEEE-754 ordering and `Math.sqrt` rounding can
diverge across `(arch, os, runtime)`.

The tstournament problem-13 "Meijer G mega-test" (epic
scientist-workbench-hv0) forces a tier *above* float64. The
benchmark's golden master is generated from Wolfram + mpmath
agreement at 110 decimal digits; the candidate must reproduce values
agreeing to that precision in pure TypeScript. The empirical
research probe (saved at the orchestrator's research record;
summarised in `tstournament/ts-bench-infra/problems/13-meijer-g/
ORACLE-STRATEGY.md`) establishes that the two industrial oracles
agree bytewise to 200 digits on generic parameters — so a 50- or
100-dps target for the candidate is achievable, but only with a
genuine arbitrary-precision substrate.

Critically, the substrate is *more* deterministic than ADR-0014's
float64 tier, not less. `BigInt` arithmetic is **bit-identical
across every JavaScript runtime and every platform** by language
specification. An arb-prec floating-point library built on `BigInt`
mantissa + integer exponent has no platform-conditional behaviour:
add, multiply, divide, sqrt, exp, log, Γ all produce byte-identical
output bytes given fixed input bytes and fixed precision. The
determinism contract for arb-prec tools is **stronger than ADR-0014's
and parallel to the symbolic majority** — bit-identical, full stop.

This is what forces the parallel to ADR-0015 in the *opposite* direction:
not "add a platform fingerprint because the contract weakens" but
"recover the unconditional bit-determinism of the symbolic tier, with
an explicit precision dial."

## The axiom (re-applied)

ADR-0009: agents are TS experts; what a TS expert wants is the
spec. ADR-0014 added the planner's lens: what makes this irresistible
to an agent's planner?

Two specific reads of the axiom shape every decision below.

1. **The TS expert reads `nondeterministic?: boolean` and `numerical?:
   boolean` on `ToolDefinition` and expects a third additive flag for
   "this tool ships in arbitrary precision and takes a `--precision`
   knob" to be exactly that shape.** Same default-false, same opt-in,
   same mutual exclusion contract. Not a unified discriminated tier
   enum (the ADR-0015 §"Pattern consistency" argument applies again,
   verbatim).

2. **The agent's planner reads `--precision=50` and expects the
   semantics of the value to be "decimal digits the answer is honest
   about".** Decimal, not binary, because every reference (mpmath,
   Mathematica, Maple) speaks decimal in its user surface and only
   speaks binary internally. The planner that wants "50 sig figs" sets
   `--precision=50`; the planner that wants "200 sig figs" sets
   `--precision=200`. The precision flag is a *user-facing dial*, not
   an internals-knob. The implementation maps decimal-precision to
   binary-precision via the standard `bits = ceil(decimal_digits *
   log2(10)) + safety` formula, with `safety` an internal margin.

The two reads align on every decision below.

## Decision

Five additive changes. None breaks existing canonical bytes; none
changes behaviour for tools that don't opt in.

### 1. `arbprec?: boolean` annotation on `ToolDefinition`

Parallel to `nondeterministic?: boolean` (ADR-0005) and `numerical?:
boolean` (ADR-0015). One optional boolean, default false:

```ts
export interface ToolDefinition<I, O, Fl> {
  // ...existing fields...
  nondeterministic?: boolean;   // ADR-0005
  numerical?: boolean;          // ADR-0015
  arbprec?: boolean;            // this ADR
}
```

Semantics: when `arbprec: true`, the tool

- ships in **arbitrary precision**, with `--precision=<int>` available
  as a standard flag (item 4 below);
- guarantees **bit-determinism unconditional on platform** — same
  input bytes, same precision flag, same tool version → same output
  bytes on any runtime / arch / os;
- internally uses `packages/bigfloat` (item 2 below) or another
  bit-deterministic substrate; **no float64 in any code path** that
  contributes to the output (auxiliary float64 for, e.g., heuristic
  decisions is permitted iff it does not affect the canonical output
  bytes).

**Amendment — 2026-07-14 (ADR-0040 §Decision 9 amendment; bead
`scientist-workbench-81rl`).** Sanctioned exception to the no-float64
rule: a *cross-tier* tool that dispatches a float64 lane off
`--precision ≤ 15` (decimal digits ≈ the 53-bit binary64 mantissa;
today only `tools/special-eval`) computes that lane in float64 and
wraps the result in 53-bit BigFloat on the wire. The
bit-determinism-unconditional-on-platform guarantee above holds for
`--precision > 15` only; the ≤ 15 lane is platform-conditional and
unfingerprinted, disclosed per-tool via the
`tier-dispatch-by-precision-flag` invariant.

Mutually exclusive with `numerical: true` and with `nondeterministic:
true`. The runner rejects a tool whose definition asserts more than
one as a load-time contract violation (parallel to ADR-0015's
mutual-exclusion check).

*Amended 2026-07-14 (bead `scientist-workbench-81rl`): the rejection
happens per-execution in `executeToolDef` — every entry point routes
through it (ADR-0012) — not at load time.*

### 2. `packages/bigfloat`: arb-prec binary-radix substrate

A new workbench package, sibling of `packages/protocol`,
`packages/cas-core`, `packages/linalg-core`. Pure TypeScript on
`BigInt`. Single in-process surface; no FFI; no subprocess.

```ts
// Public type — per-value precision (MPFR semantics, not mpmath
// ambient-precision semantics).
export interface BigFloat {
  // Sign embedded in mantissa: positive mantissa = positive value,
  // negative mantissa = negative value. Zero is mantissa = 0n with
  // any exponent (canonical: exponent = 0).
  readonly mantissa: bigint;

  // Binary exponent. Value = mantissa * 2^exponent.
  readonly exponent: number;

  // The precision in bits at which this value's mantissa was
  // last rounded. Operations take an explicit `prec` parameter
  // and round their result to that precision.
  readonly precision: number;
}

export interface BigComplex {
  readonly re: BigFloat;
  readonly im: BigFloat;
}

// Constructors / conversions
export function fromInt(n: bigint | number): BigFloat;          // exact
export function fromRational(num: bigint, den: bigint, prec: number): BigFloat;
export function fromString(s: string, prec: number): BigFloat;  // decimal
export function fromFloat64(x: number): BigFloat;               // exact (no precision parameter)
export function toString(a: BigFloat, digits: number): string;  // decimal
export function toFloat64(a: BigFloat): number;                 // best-effort

// Core arithmetic — every operation takes an explicit precision
// parameter; the result is rounded to that precision (round-half-to-even).
export function add(a: BigFloat, b: BigFloat, prec: number): BigFloat;
export function sub(a: BigFloat, b: BigFloat, prec: number): BigFloat;
export function mul(a: BigFloat, b: BigFloat, prec: number): BigFloat;
export function div(a: BigFloat, b: BigFloat, prec: number): BigFloat;
export function sqrt(a: BigFloat, prec: number): BigFloat;
export function neg(a: BigFloat): BigFloat;            // exact
export function abs(a: BigFloat): BigFloat;            // exact

// Comparison — exact (no precision parameter)
export function eq(a: BigFloat, b: BigFloat): boolean;
export function lt(a: BigFloat, b: BigFloat): boolean;
export function le(a: BigFloat, b: BigFloat): boolean;
export function gt(a: BigFloat, b: BigFloat): boolean;
export function ge(a: BigFloat, b: BigFloat): boolean;
export function cmp(a: BigFloat, b: BigFloat): -1 | 0 | 1;
export function sgn(a: BigFloat): -1 | 0 | 1;

// Transcendentals — implementations follow MPFR semantics.
// Each takes a precision parameter; result rounded to that precision.
export function exp(a: BigFloat, prec: number): BigFloat;
export function expm1(a: BigFloat, prec: number): BigFloat;
export function log(a: BigFloat, prec: number): BigFloat;
export function log1p(a: BigFloat, prec: number): BigFloat;
export function sin(a: BigFloat, prec: number): BigFloat;
export function cos(a: BigFloat, prec: number): BigFloat;
export function tan(a: BigFloat, prec: number): BigFloat;
export function asin(a: BigFloat, prec: number): BigFloat;
export function acos(a: BigFloat, prec: number): BigFloat;
export function atan(a: BigFloat, prec: number): BigFloat;
export function atan2(y: BigFloat, x: BigFloat, prec: number): BigFloat;
export function sinh(a: BigFloat, prec: number): BigFloat;
export function cosh(a: BigFloat, prec: number): BigFloat;
export function tanh(a: BigFloat, prec: number): BigFloat;
export function pow(a: BigFloat, b: BigFloat, prec: number): BigFloat;

// Constants — cached per-precision.
export function pi(prec: number): BigFloat;
export function e(prec: number): BigFloat;
export function ln2(prec: number): BigFloat;

// Special functions — load-bearing for MeijerG and downstream.
// Real and complex variants; for complex, see BigComplex API.
export function gamma(a: BigFloat, prec: number): BigFloat;
export function lgamma(a: BigFloat, prec: number): BigFloat;
export function digamma(a: BigFloat, prec: number): BigFloat;
export function polygamma(n: number, a: BigFloat, prec: number): BigFloat;

// BigComplex API — analogue of every BigFloat op.
export function cmul(a: BigComplex, b: BigComplex, prec: number): BigComplex;
export function cadd(a: BigComplex, b: BigComplex, prec: number): BigComplex;
// ... (full surface mirrors BigFloat's)
export function cgamma(a: BigComplex, prec: number): BigComplex;
export function cdigamma(a: BigComplex, prec: number): BigComplex;
// ... etc.
```

Per-value precision (MPFR semantics) over ambient precision (mpmath
`mp.prec`) chosen for compositional clarity; see §"Why these choices".

### 3. Value-protocol encoding for `BigFloat`

`BigFloat` and `BigComplex` are not new primitive kinds in the
value protocol (PRD §2.2 lists 10; we are not changing that
contract). They are encoded using existing primitives via the
`tagged` mechanism:

```
bigfloat:    tagged("bigfloat", record({
                mantissa: integer(<decimal-string>),
                exponent: integer(<decimal-string>),
                precision: integer(<decimal-string>),
             }))

bigcomplex:  tagged("bigcomplex", record({
                re: tagged("bigfloat", record({...})),
                im: tagged("bigfloat", record({...})),
             }))
```

Tools that operate on bigfloat declare schemas with
`S.tagged("bigfloat", S.record({mantissa: S.kind("integer"),
exponent: S.kind("integer"), precision: S.kind("integer")}))` and the
runner validates incoming values against that.

Helpers in `packages/protocol/src/bigfloat-encoding.ts`:

```ts
export function bigfloatToValue(a: BigFloat): Value;
export function valueToBigFloat(v: Value): BigFloat;
export function bigcomplexToValue(a: BigComplex): Value;
export function valueToBigComplex(v: Value): BigComplex;
export const bigfloatSchema: Schema;
export const bigcomplexSchema: Schema;
```

Foreign-pass-through invariant (PRD §2.3) holds verbatim: a tool that
doesn't operate on bigfloat sees a `tagged` value and round-trips it.

### 4. Standard `--precision=<int>` flag for `arbprec: true` tools

When a tool's `def.arbprec === true`, the runner inherits a standard
flag declaration in addition to ADR-0011's standard set:

```ts
{
  name: "precision",
  type: F.int({ min: 1, max: 100_000 }),
  default: 50,
  description: "decimal digits of precision for the output",
}
```

Semantics:

- Decimal digits, not binary bits. The implementation converts to
  bits as `bits = ceil(precision * Math.log2(10)) + safety_margin`
  (typically `safety_margin = 30`) before invoking the bigfloat
  substrate.
- The flag value is part of the tool's input identity (per ADR-0011);
  the provenance record's `flags` field captures `{precision: "50"}`
  or whatever value was used.
- Default `50` is a deliberately user-friendly choice — meaningfully
  more than float64's ~16 digits, comfortably within reach of even a
  naive implementation, matches the Tier-H speed-gate target in the
  problem-13 verifier.
- Maximum `100000` is a soft sanity bound — beyond that, working-
  precision arithmetic in pure TS becomes practically unusable; tools
  that push into that regime should declare a tighter cap in their
  flag override.

A tool may override the bound (`F.int({min: 1, max: 1000})`) but
cannot rename or retype the flag — every `arbprec: true` tool exposes
`--precision` with the same semantics.

The merge that adds the `--precision` slot lives in `mergedFlags(...)`
inside `packages/contract/src/runner.ts` and is exported from
`@workbench/contract` as the single source of truth. The in-process
surface (`@workbench/compose`'s `runWorkbench`) validates partial flags
against `toolFacingFlags(def.flags ?? {}, def.arbprec === true)`, the
same merge applied without the CLI-only standard flags
(`help`/`version`/etc.). This is what closes the lc1 / rn2 wiring gap
(worklog 083) — both surfaces share one admissible-flag set, keeping
the ADR-0012 byte-identical contract honest at every call site.

### 5. Provenance: `precision` recorded as a flag, not a tier annotation

The provenance record (ADR-0005) gains nothing new for the arb-prec
tier. The `precision` flag value is already captured in the
`flags: {key: <Value>}` map per ADR-0014 / ADR-0011. The lookup /
memoize cache (ADR-0012) hits iff (input hash, flags including
precision, tool version) match — same semantics as today.

Concretely: `runMemoized(tool, input, {precision: "50"})` and
`runMemoized(tool, input, {precision: "100"})` produce *different*
cache keys, so different cached records, so no cross-precision
caching. This is correct: the 100-digit value and the 50-digit value
are different output bytes.

The platform fingerprint of ADR-0015 is not added — `arbprec: true`
tools have no platform-conditional output; recording the platform
would be misleading.

## Why these choices

### `arbprec` as a third additive flag, not a tier enum

Same argument as ADR-0015 §"Pattern consistency over clean-slate
elegance": the codebase has additive boolean flags for tier
relaxation; the parallel tier *strengthening* gets the same shape.
Three flags (`nondeterministic`, `numerical`, `arbprec`) with
mutual-exclusion check is exactly as expressive as a four-state
enum (`symbolic | numerical | arbprec | nondeterministic`) but
additive at every step.

### Decimal precision in the user surface, binary internally

mpmath, Mathematica, Maple, and every paper in the field speak decimal
digits in their user surface. A planner reading `tools/meijer-g
--help` and seeing `--precision=50` immediately understands "50
significant decimal digits" — no mental conversion. Internally,
`packages/bigfloat` represents mantissas as binary-radix BigInts
because that's correctness-preserving for arithmetic; the conversion
is one line at the API boundary.

### Per-value precision (MPFR), not ambient (mpmath)

Compositional clarity. When `add(a: BigFloat, b: BigFloat, prec:
number)` takes its precision parameter explicitly, the result's
precision is unambiguous from the call site. Reading composed code:

```ts
const c = add(mul(a, b, 50), div(a, b, 50), 50);
```

is more legible than mpmath-style:

```ts
mp.prec = 50;
const c = add(mul(a, b), div(a, b));   // ambient mp.prec invisibly applies
```

The TS expert reading the code wants to see the precision at every
operation. The agent planner generating the code wants to set the
precision explicitly. Both align on per-value MPFR semantics.

### `BigInt` mantissa over `Uint32Array` mantissa

JS `BigInt` is **bit-identical across all JavaScript runtimes** by
language specification — Bun, Node, V8, JSC, SpiderMonkey, all produce
the same bytes. A `Uint32Array` with custom add / multiply / divide
implementations would *also* be bit-identical (BigInt is
`Uint32Array`-backed under the hood), but with custom arithmetic
costing ~1500 LOC of substrate that we would have to debug and prove
correct. `BigInt` gives us all of that for free.

Performance: `BigInt` mul/div is O(n²) naive (for n-digit inputs)
or O(n log n) with FFT for very large; V8's implementation does
schoolbook for n ≤ 64 limbs and Karatsuba above. For typical
MeijerG-grade precision (50–200 dps ≈ 200–800 bits ≈ 4–14 BigInt
limbs), schoolbook is what runs and is fast.

### `tagged "bigfloat"` encoding, not new primitive kind

Adding an 11th primitive to the value protocol is a breaking change
to PRD §2.2. The `tagged` primitive *is* the protocol's mechanism
for "complex types built from primitives" (see ADR-0006: Sturm IR
encoded as `tagged "channel"`); bigfloat fits the same pattern.
Tools that operate on bigfloat declare schemas with
`S.tagged("bigfloat", ...)` and validate; tools that don't, see a
tagged value and round-trip per the foreign-pass-through invariant.

### Standard `--precision` flag rather than per-tool

A planner that knows it wants 100 dps from MeijerG, hypergeometric-
pfq, and bigfloat-quad in one chain shouldn't have to remember each
tool's precision-flag spelling. Standardising on `--precision`
removes that surface.

The cost: tools that have a *natural* second precision concept
(e.g. a tool with both an absolute and relative precision target)
must use a different flag name for the second; `--precision` is
reserved.

## What we will *not* decide here

- **Interval / ball arithmetic (Arb-style rigorous bounds).** The
  bigfloat substrate this ADR specifies is mid-rad-free; it produces
  one rounded value per operation. A future ADR-NNNN can add
  `bigball` (mid-radius interval) as a sibling; the precedent is
  ADR-0006 (Sturm IR) sitting alongside the protocol primitives.
  Filed as a follow-up consideration; not blocking MeijerG.
- **Cross-tier composition** (a numerical tool consuming an arbprec
  tool's output, or vice versa). The mutual-exclusion check at tool
  load time prevents *one* tool from being both; cross-tool
  composition through `wb.run` / `wb.pipe` is unaffected.
  *(Amended 2026-07-14: the check runs per-execution in
  `executeToolDef`, not at load time.)*
- **Auto-precision-bumping** (a tool that decides "I need 80 dps to
  satisfy a 50-dps request" and silently bumps). The candidate's
  `tools/meijer-g` will internally do this for cancellation
  detection; the *external* contract is "you asked for 50 dps; here
  is a value with achieved_precision ≥ 50". Internal bumping is the
  tool's responsibility.
- **Performance benchmarks for `packages/bigfloat`.** Filed as a
  workbench-side bench shard once the substrate ships; the bigfloat
  package is not a `numerical: true` tool, has no provenance, and
  doesn't need ADR-0019-style invariant verification beyond unit
  tests.

## Migration

- Existing tools (none of which declare `arbprec`) are unaffected.
  All eighteen-and-counting tools retain their bytes-identical output.
- `packages/bigfloat` is a new package; no existing package is
  refactored.
- `tools/hypergeometric-pfq` (epic child hv0.3) will be the **first**
  tool to declare `arbprec: true`. `tools/meijer-g` (hv0.10) the
  second. `tools/integrate-1d-arbprec` (hv0.7) the third.
- The runner's mutual-exclusion check (item 1 above) is added once;
  every tool inherits.
- The `--precision` standard flag is added once in the runner's
  flag-merge layer (ADR-0011); every `arbprec: true` tool inherits.
- `CLAUDE.md`'s hallucination-risk section gains one bullet:
  `arbprec: true` is parallel to `numerical: true` and
  `nondeterministic: true`; do not consolidate into a tier enum
  without a separate (breaking) ADR.

## Acceptance

- This document exists with Status=Accepted.
- `PRD-v0.2.md` §6.1 amended: the symbolic-tier "Always bit-deterministic"
  rule names the arb-prec tier as a *second* unconditionally-bit-
  deterministic tier, alongside the symbolic majority. The numerical
  tier (ADR-0015) remains the platform-conditional one.
- `README.md` § "Hard requirements" mirrors the PRD amendment.
- `CLAUDE.md` gains the hallucination-risk bullet.
- The implementation issue (hv0.1) has the substrate
  (`packages/bigfloat` with the public API above), the encoding helpers
  (`packages/protocol/src/bigfloat-encoding.ts`), the runner mutex
  check, the standard `--precision` flag, all unit-tested against
  mpmath at random precisions in the range [10, 1000] dps.
- Worklog shard 068 documents the iteration.

## References

- ADR-0005 — externalised entropy; the original additive-flag
  pattern.
- ADR-0007 — distribution-vs-sampling; per-output tier conditioning.
- ADR-0010 — `defineTool` / `runTool` split; library-and-tool dual
  surface.
- ADR-0011 — typed flag declarations; standard-flag inheritance.
- ADR-0014 — first numerical tier (float64).
- ADR-0015 — determinism tier; the parallel additive flag this ADR
  mirrors.
- MPFR — *Multiple Precision Floating-point Reliable Library*,
  www.mpfr.org. Reference for correct-rounding semantics and the
  per-value-precision API shape.
- mpmath — github.com/mpmath/mpmath. Reference for the
  ambient-precision API shape (which we deliberately *do not* adopt
  in favour of MPFR-style per-value).
- F. Johansson 2017 "Arb: efficient arbitrary-precision midpoint-
  radius interval arithmetic," *IEEE Trans. Computers* 66(8). The
  rigorous-arithmetic substrate this ADR's tier sits structurally
  below; future bead may add a `bigball` sibling.
- tstournament repo `ts-bench-infra/problems/13-meijer-g/PLAN.md`
  — the seven-layer plan that motivates this ADR.
