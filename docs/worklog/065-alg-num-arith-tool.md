# 065 — `tools/alg-num-arith` ships: wire envelope for `Root[poly, k]` field arithmetic

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** consumes ADR-0018 (`Root[poly, k]`), ADR-0003
(output-error-pattern triplet), ADR-0011 (`F.enum` flags).
**Issues touched:** prepares the substrate for `bench/alg-num-arith/`
(bead `iay`); the bench shard follows.

## Context

Worklog 062 shipped `@workbench/alg-num`'s in-memory field arithmetic
on `Root` values — `algNumNeg`, `algNumInv`, `algNumAdd`, `algNumSub`,
`algNumMul`, `algNumDiv` — via Sylvester-Bareiss resultants. Worklog
063 (`yoc`) routed `tools/poly-roots`'s deg-≥5 path through the
substrate; worklog 064 did the same for `tools/solve`. What was still
missing: a *direct* wire envelope for the arithmetic itself, so an
agent composing tools can do
`wb.algNumArith({a, b}, {op: "add"})` without reaching for the
package layer.

This shard is the standalone tool wrapper, agreed with the user as
the precursor to bead `iay` (alg-num arith bench). Splitting "ship
the tool" from "ship the bench" keeps each shard focused and lets the
bench's design land cleanly against a stable wire surface.

## What changed

### `tools/alg-num-arith/` — new tool (~280 LOC tool.ts + ~70 LOC goldens)

Single tool, seven operations selected via the `--op` flag
(`F.enum(["add", "sub", "mul", "div", "neg", "inv", "eq"] as const, …)`).

**Input shape.** `record { a: <Root expression>, b?: <Root expression> }`.
`b` is required for binary ops (`add`, `sub`, `mul`, `div`, `eq`)
and rejected for unary ops (`neg`, `inv`). Schema declares `b` as
optional via `S.record(..., { optional: ["b"] as const })`. Arity
mismatch (binary op without `b`, or unary op with `b`) ⇒ `ToolError`.

**Output shape (3 categories per ADR-0003).**
- *Arithmetic happy path* (op ∈ {add, sub, mul, div, neg, inv}) ⇒
  the result `Root[poly, k]` value (canonical-form bytes).
- *Equality happy path* (op == eq) ⇒ `boolean { value: bool }`.
- *Boundary refusal* ⇒ `tagged "alg-num-arith/<class>"` with payload
  `record { detail: string }`. Two classes:
    - `alg-num-arith/inv-of-zero` (op = inv on a Root representing 0).
    - `alg-num-arith/div-by-zero` (op = div with b representing 0).

`ToolError` is reserved for *malformed* input only — non-Root values
in `a`/`b`, missing required field, arity mismatch.

**Algorithm** is pure dispatch:
1. Wire-decode `a` (and `b` when binary) via
   `@workbench/alg-num.valueToRoot`. Non-canonical input is silently
   canonicalised per ADR-0018.
2. Switch on `op` to the matching substrate function; `algNumDiv` and
   `algNumInv` may throw "0 is not invertible"; that exception is
   pattern-matched (regex on the message) and translated to the
   boundary tag.
3. Encode the result via `rootToValue`, or return a boolean for `eq`.

**Five invariants declared** — deterministic, field-closure (output
stays in the algebraic-number field; never `tagged out-of-scope`),
additive-inverse (`add(a, neg(a)) == 0`), multiplicative-inverse
(`mul(a, inv(a)) == 1` for `a ≠ 0`), eq-reflexive
(`eq(a, a) == true`). All five are machine-checkable; the goldens
exercise representative cases of each.

**Seven examples + 27 goldens** across four tiers:
- *Tier A — elementary arithmetic* (14 cases): √2 + √3, 1 + √2, √3 − √2,
  √2 · √3 (= √6), √2 / √2, neg(√2), inv(√2), and rational-degenerate
  cases like `√2 · √2 = 2` (= `Root[x − 2, 0]`).
- *Tier B — eq* (6 cases): reflexivity (+√2 == +√2 ⇒ true), index
  distinguishability (+√2 == −√2 ⇒ false; same minpoly, different k),
  cross-minpoly distinguishability (+√2 == +√3 ⇒ false), rational
  degenerate (0 == 0, 1 == 1, 1 == −1).
- *Tier C — refusals* (2 cases): inv(0), div(√2, 0).
- *Tier D — composition / round-trip* (5 cases): √2 + √5 = Root[x⁴ −
  14x² + 9, k=3], √2 · √5 = √10, neg-neg involution, inv-inv
  involution, neg(−√3) = +√3.

**`--test` hook with four probes:** `add(√2, √3)` produces k=3 (the
ADR-0018 headline); `neg(+√2)` produces a Root[]-headed value (k flips
1 → 0 within the same minpoly); `eq(+√2, +√2) = true` and
`eq(+√2, −√2) = false`; `inv(0)` refuses with the documented tag.

### `scripts/demo-scope.ts` — new section 17.5

Runs `wb.algNumArith({a: √2-Root, b: √3-Root}, {op: "add"})` end-to-
end through the typed-barrel composition layer (worklog 033) and
verifies:
- `√2 + √3` returns `Root[Polynomial[1, 0, -10, 0, 1], k=3]` —
  the ADR-0018 headline matches.
- `eq(+√2, +√2)` returns `true`.

Confirms the tool composes cleanly against the workbench's typed
surface; no schema or output-shape friction.

### Catalog row in `README.md`

New `alg-num-arith` row (alphabetised first in the tools table) with
input/output shape, op enum, substrate citation (worklog 062),
determinism tier, and bench cross-reference.

### `packages/compose/src/generated/wb.ts` (regen)

The typed barrel auto-regenerates from `tools/*` via
`scripts/gen-workbench-barrel.ts`. The new `algNumArith(input, flags)`
method appears alongside the existing 33 tools; ergonomic consumers
(`wb.algNumArith(...)`) get full TS inference on input record shape +
flag enum + output union.

## Why these choices

**Why a single tool with `--op` flag rather than seven tools.** Two
principles: a TS expert reaches for `wb.algNumArith({a, b}, {op:
"add"})` once they understand the algebraic-number arithmetic
contract — the operation IS a parameter, not a different tool. Seven
single-purpose tools would multiply the surface for an agent learning
the workbench while adding zero distinguishability (each would share
~80% of its plumbing with the others). Cardano-Vieta's `mod-inv`
and `mod-pow` *are* split (different mathematical operations on
different domains); add/sub/mul/div on Roots are conjugate slices of
the *same* field. Mirrors the pattern in `linalg-svd` (single tool,
multiple methods via `--method` flag).

**Why output is a value-protocol *union* (Root | boolean | tagged).**
ADR-0003 demands the three output categories be mutually exclusive;
this tool's three outputs span all three categories already. Equality
returning `boolean` rather than `Root[bool, 0]` is a deliberate
honesty: equality is a predicate, not an algebraic-number operation.
A downstream consumer pattern-matching on `output.kind` can dispatch
the three cases without ambiguity. The `S.any()` output schema is the
loosest declaration; the goldens battery is the shape-drift canary
(ADR-0004's "schema as type, not validation" principle).

**Why exception-shape detection for the inv-of-zero refusal.** The
substrate (`packages/alg-num/src/arithmetic.ts`) throws plain
`Error("algNumInv: ...zero...")` — no typed exception class. Adding
a typed class would expand the substrate's public surface for one
consumer's benefit; pattern-matching the message via a tight regex
(`/algNum(Inv|Div):.*zero/i`) keeps the substrate API narrow without
losing the boundary-tag emission.

**Why goldens cover the *non-monic* canonical minpoly.** Inversion
of a Root with monic minpoly produces a *non-monic* canonical minpoly
(e.g., `inv(√2) ⇒ Root[2x² − 1, k=1]`). This was the bug-trigger
that forced the Cohen-1993 monic-transform extension to
`packages/poly-factor` in worklog 062. Including a golden for it
in this tool's battery makes the regression surface visible at the
wire layer, not just the package layer.

## Frictions surfaced

**Schema optional-field syntax.** Initial `S.record({ a: ..., b: ...
})` made `b` mandatory; the tool then rejected unary-op examples
(`neg(√2)` with no `b`) at schema-validation time. Fixed by passing
`{ optional: ["b"] as const }` as the second argument to `S.record`.
The optional-key API exists in `packages/protocol/src/schema.ts` but
isn't prominent in existing tool examples — none of the tools shipped
to date have an optional input field. (Most tools have fixed-arity
inputs; the handful that vary by op tend to keep all fields and
ignore unused ones.) Added an example to this tool's prose pointing
to the optional-key declaration.

**Test-hook arity.** First-pass `--test` hook called
`def.fn(input, {})` (an empty flags object). The runtime then
complains `op` flag is missing. Fixed by passing the explicit op:
`def.fn(input, { op: "add" })`. Subtle but obvious in retrospect —
the runner injects flag defaults; in-process direct calls don't.
Worth a one-line note for future tool authors that
`--test` probes have to pass any required flags explicitly.

**The 0-as-Root encoding.** `Root[x, 0]` represents the rational 0
— minpoly `x`, k=0 (only real root of `x`). Three of the goldens use
this directly (`add(√2, neg(√2)) = 0`, `sub(√2, √2) = 0`, the
inv(0) refusal). Worth flagging that the Root[]-encoded zero is
*not* the integer 0 on the wire; encoders that treat algebraic
zero as `int(0)` will see a structural mismatch. Documented in the
goldens spec via the `ZERO = rootVal([0n, 1n], 0n)` constant.

## Acceptance

- New tool `tools/alg-num-arith/` (tool.ts, README.md,
  goldens.spec.ts, package.json, 27 goldens).
- 4 `--test` probes pass (add √2+√3, neg √2, eq true+false, inv(0)
  refusal).
- 27 goldens generated, 0 mismatches.
- `bun run check`: 65/65 phases green (was 63; +1 for the tool's
  `--test` hook, +1 for its `oracle` golden phase).
- Catalog row in `README.md` updated.
- Demo `scripts/demo-scope.ts` section 17.5 verifies end-to-end
  through the typed barrel: `√2 + √3 = Root[x⁴ − 10x² + 1, k=3]`
  (ADR-0018 headline) + `eq(+√2, +√2) = true`.
- Typed barrel `packages/compose/src/generated/wb.ts` regenerated
  (34 tools, was 33).

## Pointers

- ADR-0018 — `Root[poly, k]` value-protocol primitive.
- Worklog 062 — alg-num resultant arithmetic substrate (the
  in-memory functions this tool wires).
- Worklog 063 — `tools/poly-roots` deg-≥5 lift (`yoc`).
- Worklog 064 — `tools/solve` deg-≥5 wiring.
- Bead `iay` — bench/alg-num-arith follow-on; this tool is the
  bench's substrate-under-test. Next shard.

## Commits

This shard documents the work as it lands; commit message will
follow the same Law-2 lockstep pattern when staged.
