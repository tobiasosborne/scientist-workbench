# ADR-0003 — Tool output: when to use `tagged` vs `record { ok, ... }`

**Status:** Accepted (2026-04-28)
**Context:** beads issue scientist-workbench-rpb.4 (F5)
**Supersedes:** —

## Context

A tool's output can be one of three shapes, depending on the situation:

1. **Happy path** — the canonical success result.
2. **Routine non-success** — the tool ran to completion, the answer is
   "no, it's not what you expected." Examples:
   - `cas-verify` decides `lhs ≠ rhs`.
   - `mod-inv` finds that `gcd(value, modulus) > 1`, so no inverse exists.
   - A future `solve-poly` finds no rational root.
3. **Boundary failure** — the input is outside the tool's declared scope,
   or the tool refuses for structural reasons. Examples:
   - `cas-simplify` encounters an unknown head (`sin`, `cos`).
   - A hypothetical `ntt-modulus-X` receives a different modulus.

Until now we had no rule. `mod-inv` returned `tagged "mod-inv/no-inverse"`
for case (2). `cas-verify` returned `record { equal: bool, reason?, ... }`
for the same kind of case. Two tools, two patterns. Downstream consumers
have to know which is which.

## Decision

We codify the shape of the output by the *category*:

### Category 1 — happy path

The output is whatever the tool naturally produces. No flag, no tag.

```
ntt   → list<integer>
mod-pow → integer
expr-parse → expression
```

### Category 2 — routine non-success ⇒ **record with explicit flag**

When the tool ran to completion but the answer is "this routine produced a
falsy / non-result," emit a record carrying both the decision flag and any
diagnostic fields the consumer might want.

The convention:

```
record {
  <flag-field>: boolean,            // the load-bearing yes/no
  <result-field>?: <Value>,         // present iff flag=true (success)
  <diagnostic-fields>?: <Value>,    // present iff flag=false (or always),
                                    // structured per tool
}
```

The flag-field name is *domain-specific*: `equal` for `cas-verify`,
`invertible` for `mod-inv`, `solvable` for a hypothetical solver. Use the
word that reads as the tool's question. Prefer `boolean` over a string
status — strings invite typos and inconsistent casing.

The result-field is whatever the tool would have returned in the happy
path, present only when the flag is `true`. Diagnostic fields (`reason`,
`witness`, `gcd`, `detail`) are present according to the specific tool's
contract, documented in its README.

### Category 3 — boundary failure ⇒ `tagged "<tool>/<class>"`

When the input is outside the tool's declared scope, wrap the offending
substructure in `tagged "<tool>/<reason-class>"`. This is exactly the
existing foreign-pass-through invariant (PRD §2.3). `cas-simplify`
established the pattern: `tagged "cas-simplify/out-of-scope" <subterm>`.

The tag string carries the tool name (so a downstream consumer knows
*which* tool refused) and a reason class (so it knows *why*). The
payload is whatever sub-value triggered the refusal, recursively
simplified where the rest of the tool is still able to.

A boundary failure is *not* an error — the tool succeeded in declaring
"this part is outside my world." A `ToolError` (process exit 1) is
reserved for *malformed* inputs (missing fields, wrong kinds, parser
failures), not legitimate-but-unsupported ones.

### Distinguishing categories 2 and 3

The test: did the algorithm run to completion on a *valid* input?

- `mod-inv(6, 9)` — the algorithm runs (extended Euclid), arrives at
  gcd=3, decides no inverse exists. Category 2. Record with
  `invertible: false`.
- `mod-inv("not-an-integer", 9)` — the input is malformed. Not a
  category at all; `ToolError`.
- `cas-simplify(sin(x))` — `sin` is not in the tool's declared scope
  (Q[x] / Q(x)). Category 3. Tagged out-of-scope.
- `cas-verify(equal-by-cross-multiplication ratio)` — both sides in
  scope, decision reached. Category 2. Record with `equal: bool`.

## Migration

`mod-inv` previously used Category 3 shape (`tagged "mod-inv/no-inverse"`)
for what is genuinely a Category 2 outcome. We migrate it:

Before:
```
no inverse → tagged "mod-inv/no-inverse"
                    record { gcd, modulus, value }
```

After:
```
always     → record {
               invertible: boolean,
               inverse?:   integer,   // iff invertible
               gcd:        integer,   // always present (= 1 iff invertible)
             }
```

Goldens are regenerated. The README is updated. `tagged "mod-inv/no-inverse"`
is removed.

## Consequences

**Positive:**

- One question to ask when designing a tool's output: "did the algorithm
  run to completion on a valid input?" The answer picks the category.
- Downstream consumers dispatch the same way for every tool in each
  category. `if (out.fields.equal.value) ...` for verifications,
  `if (out.tag === "<tool>/<class>") ...` for boundary refusals.
- The protocol stays at ten kinds. We're picking *conventions over* the
  existing primitives, not adding new ones.

**Negative:**

- Migration cost for `mod-inv` (one tool, ~5 examples, 32 goldens).
  Acceptable: better to align before more tools accrete.

## Test plan

- `mod-inv` returns `record { invertible: true, inverse: <int>, gcd: 1 }`
  for invertible inputs.
- `mod-inv` returns `record { invertible: false, gcd: <int> }` for
  non-invertible inputs.
- `mod-inv` raises `ToolError` for malformed inputs (modulus < 1, missing
  fields, wrong kinds).
- All goldens still pass after regeneration.
- `bun run check` stays green.

## Note on Category-1 + Category-2 hybrids

A tool might want to emit Category-1 in the happy case and Category-2
otherwise — i.e. either an integer or a record. We don't allow that; it
defeats type-based composition. Pick Category 2 *always* for tools whose
output is conditional, even if the type union is awkward to type. The
record-with-flag is the price for honest type-uniformity.
