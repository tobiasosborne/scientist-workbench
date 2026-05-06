# ADR-0017 — Solution-set value-protocol shape

**Status:** Accepted (2026-05-06)
**Bead:** `scientist-workbench-9cs`
**Epic:** `scientist-workbench-98a` (solve-suite-v1)

## Context

The workbench is gaining a `Solve[]`-class capability: a top-level
`solve` tool plus the substrate tools that feed it (`linsolve-q`,
`poly-roots`, `groebner-basis`). None of these can ship until we pin
down what *shape* of value carries "the answer." Existing tools
return either a single `Value` (`expr-parse`, `cas-simplify`,
`cas-diff`), a `tagged` boundary (`cas-simplify` out-of-scope), or a
small flat record with a primary field plus optional flags
(`cas-verify`, `mod-inv`). None of these models a *set* of
substitutions, a *family* of solutions parameterized by integer
branches, or "finitely many or empty or infinitely many" as a single
discriminated answer space.

This is the design ADR that gates Phases 1–6 of the solve epic.

What an answer space must encode:

- **A finite list of substitutions** (`x^2 = 4` ⇒ two bindings).
- **The empty set** (an inconsistent linear system; "no solution").
- **A finite description of an infinite family** — `Sin[x] = 1/2`
  has infinitely many real solutions, *but* a finite expression with
  one integer-valued parameter per branch covers them all.
- **Refusal** on inputs outside the tool's declared scope, with a
  class tag a planner can branch on (per ADR-0003).
- **Foreign sub-terms** in solution values must round-trip verbatim
  per the workbench's foreign-pass-through invariant (PRD §2.3).

Two principles bear hardest on this design (from project memory):
*(1)* what would a TypeScript expert want; *(2)* it must be
irresistible to agents (who are TypeScript experts). Both reject the
v1/v2-Mathematica habit of returning silent principal-branch lossy
answers — `Solve[Sin[x] == 1/2, x]` returning `{{x → π/6}}` is
algebraically *wrong* (incomplete), and an agent that consumes that
output and reasons about "all `x` for which `Sin[x] = 1/2`" will be
mistaken every time. **Branch-honesty is non-negotiable** for this
codebase even where the historical capability surface is lossy.

## Decision

The output of `solve` (and every solver-substrate tool that can
return multiple bindings) is a `record` of fixed shape, or a `tagged`
of refusal class. No third channel.

### Happy-path shape

```ts
record {
  vars:         list<symbol>,
  solutions:    list<Solution>,
  completeness: 'complete' | 'finite-rep-of-infinite',
  warnings:     list<string>,
}
```

where

```ts
type Solution = record {
  bindings: list<record { var: symbol, value: Value }>,
  branches: list<symbol>,         // [] when no parameter introduced
}
```

`vars` is the *requested* variable list, in the order the caller
asked for. `bindings` is the per-solution per-variable substitution.
A solution's `bindings` length always equals `vars` length: every
requested variable is bound in every solution. `branches` lists the
fresh integer-valued symbols the solution introduces (empty when the
solution is a single concrete tuple).

`completeness` distinguishes:

- `'complete'` — `solutions` is *exactly* the solution set. The empty
  list with `'complete'` is the canonical "no solution" answer.
- `'finite-rep-of-infinite'` — one or more solutions carry non-empty
  `branches`; together they describe every solution as the integer
  parameters range over ℤ.

There is no `'principal-branch-only'` mode. A tool that can only
report one branch of a multi-branched solution must instead refuse
with `tagged 'solve/transcendental-multibranch'`; reporting one
branch silently is forbidden.

### Branch parameters

Branch symbols carry the namespace `'solve'` and a name like `'k_1'`,
`'k_2'`, … assigned in the order they are introduced across the
solution list. Their semantic — "ranges over ℤ" — is fixed by this
ADR; the protocol does not encode the domain in the value, because
the only branch domain v1 emits is ℤ. (If a future solver needs ℝ⁺
or ℕ branches, that is a breaking ADR amendment that adds a
`branch_domain` field; it is not a quiet field-addition.)

### Refusal: `tagged 'solve/<class>'`

A solver that cannot honestly produce the happy-path record returns
a `tagged` value whose tag is `solve/<class>` and whose payload is a
`record` carrying class-specific detail. The v1 class roster:

| class | when emitted | payload fields |
|---|---|---|
| `solve/high-degree-irreducible` | univariate ≥ 5 irreducible, before `Root[]` ships (P3-9) | `degree, polynomial` |
| `solve/transcendental-multibranch` | invert-and-substitute pattern dispatch fails (mixed-trig sums beyond half-angle) | `vocabulary, suggestion` |
| `solve/inequality` | input is an inequality, not an equation | `relation` |
| `solve/multivariate-non-zero-dim` | input ideal has positive Krull dimension | `groebner_basis, dimension_estimate` |
| `solve/parametric-non-trivial` | coefficient depends on a free symbol that branches the answer (e.g., `a·x = b` for unknown `a`) | `parameters, branch_condition` |
| `solve/foreign-vocabulary` | input contains an `expression` head outside the handled set | `unsupported_heads` |

The roster is open-ended in spirit but additive: every new refusal
class is a `solve/<class>` tag that doesn't conflict with the
existing taxonomy. Class names are append-only.

This is the standard ADR-0003 boundary pattern. `ToolError` is still
reserved for *malformed input* (bad schema, bad numeric encoding); a
well-formed input that the tool refuses on capability grounds is a
`tagged` boundary, not a `ToolError`.

### Foreign pass-through

Solution values that contain sub-terms outside the tool's vocabulary
round-trip verbatim. Concretely: if `solve` is asked to handle an
equation containing `tagged 'someone-else/payload'` inside an
otherwise-polynomial structure, that tag survives in the binding
unchanged. This is property-tested per tool, as for every other
workbench tool (PRD §2.3).

## Examples

### Linear, unique solution

Input: `Solve[{x + y == 3, x - y == 1}, {x, y}]`

```jsonc
{
  "kind": "record",
  "fields": {
    "vars": {"kind": "list", "items": [
      {"kind": "symbol", "name": "x"},
      {"kind": "symbol", "name": "y"}
    ]},
    "solutions": {"kind": "list", "items": [
      {"kind": "record", "fields": {
        "bindings": {"kind": "list", "items": [
          {"kind": "record", "fields": {
            "var":   {"kind": "symbol", "name": "x"},
            "value": {"kind": "integer", "value": "2"}
          }},
          {"kind": "record", "fields": {
            "var":   {"kind": "symbol", "name": "y"},
            "value": {"kind": "integer", "value": "1"}
          }}
        ]},
        "branches": {"kind": "list", "items": []}
      }}
    ]},
    "completeness": {"kind": "string", "value": "complete"},
    "warnings":     {"kind": "list", "items": []}
  }
}
```

### Quadratic, two solutions

Input: `Solve[x^2 == 4, x]` ⇒ two complete bindings, no branches.

### Sine, branched-honest

Input: `Solve[Sin[x] == 1/2, x]`. Two branches, each carrying its own
integer parameter. Schematically (eliding the canonical-JSON noise):

```jsonc
{
  "vars": ["x"],
  "solutions": [
    {
      "bindings": [{"var": "x", "value": "Pi/6 + 2*Pi*solve/k_1"}],
      "branches": ["solve/k_1"]
    },
    {
      "bindings": [{"var": "x", "value": "5*Pi/6 + 2*Pi*solve/k_2"}],
      "branches": ["solve/k_2"]
    }
  ],
  "completeness": "finite-rep-of-infinite",
  "warnings": []
}
```

Compare v1/v2 Mathematica: `{{x → π/6}}` (silent loss). Compare
SymPy `solveset`: `ImageSet(Lambda(n, π/6 + 2πn), ℤ) ∪ ImageSet(Lambda(n, 5π/6 + 2πn), ℤ)`
(structurally similar; we differ in flattening to bindings + branch
list).

### No solution

Input: `Solve[{x + y == 1, x + y == 2}, {x, y}]` ⇒ `solutions: []`,
`completeness: 'complete'`.

### Refusal — irreducible quintic before Phase 3

Input: `Solve[x^5 - x - 1 == 0, x]` while `Root[]` is not yet
implemented (during Phases 1–2):

```jsonc
{
  "kind": "tagged",
  "tag":  "solve/high-degree-irreducible",
  "payload": {
    "kind": "record",
    "fields": {
      "degree":     {"kind": "integer", "value": "5"},
      "polynomial": <the polynomial as an expression>
    }
  }
}
```

After P3-9 ships (`Root[]`-by-index for irreducible deg ≥ 5), the
same input becomes a happy-path response with five `Root[poly, k]`
bindings.

## Why these specific shape choices

**Why list-of-`{var, value}` and not a record keyed by var-name?**
Our schema language (ADR-0004) closes records by default; declaring
`record { x: ..., y: ... }` requires the schema to know the variable
names at declaration time, which `solve` cannot. A list of explicit
`{var, value}` pairs avoids the dynamic-keys problem without giving
up structural type-checking. A consumer that prefers Mathematica's
keyed `{x → 1, y → 2}` shape can write a one-line helper:

```ts
const subst = Object.fromEntries(
  sol.bindings.map(b => [b.var.name, b.value])
);
```

That helper is irresistible (TS-expert-natural) and not worth
hard-wiring into the protocol.

**Why a single `branches: list<symbol>` instead of per-binding
branches?** Branches scope to the *solution*, not the variable. A
single branched solution `{x = π/6 + 2πk}` introduces one branch
parameter that all bindings of that solution share. The flat list is
the simplest encoding consistent with that scope.

**Why `'finite-rep-of-infinite'` instead of `'parametric'`?** The word
`'parametric'` collides with parametric coefficients (the
`solve/parametric-non-trivial` refusal class). `'finite-rep-of-infinite'`
is unambiguous: a finite list of solutions whose union (over branch
assignments) is the infinite solution set.

**Why no `'principal-branch-only'`?** The two principles forbid it.
A solver that returns one branch and pretends the answer is complete
is lying to the agent. Refusing with
`tagged 'solve/transcendental-multibranch'` is both honest and gives
the planner a class tag to dispatch on (try numeric, try a different
solver, defer to user, ...).

**Why is `warnings` mandatory and not optional?** Following ADR-0014
/ ADR-0016: the numerical tier's "warnings as agent-honest output"
pattern is the right precedent. A solver that emits a warning at
`O(D^4)` shape-position factoring or a slow Buchberger run is doing
the agent a service. Mandatory means easy to read; optional fields
breed conditional code in consumers.

## Foreign-pass-through restated

For every solver tool implementing this shape:

> If the input contains a sub-term outside the tool's declared
> scope, and the tool can produce a binding *without descending into
> that sub-term*, the binding contains the sub-term verbatim
> (recursively). If the tool cannot avoid descending, the answer is
> `tagged 'solve/foreign-vocabulary'`.

Property-tested per tool against random `tagged 'unknown/...'`
sub-injection.

## Relationship to existing ADRs

- **ADR-0003 (output-error patterns).** This ADR uses the
  record-with-flag pattern (`completeness` is the flag) for happy-
  path completeness reporting and the `tagged "<tool>/<class>"`
  pattern for refusal — both verbatim from -0003. `ToolError` is
  reserved for malformed input as in -0003.
- **ADR-0004 (schema as first-class type).** The shape is declarable
  with `S.record({...})` constructors; `vars`, `solutions`,
  `completeness`, `warnings` are all closed-record fields with
  fixed-shape children.
- **ADR-0008 (cas-core ring-generic + algebraic numbers).** Solution
  values can include `AlgebraicElement<R>` payloads (transported as
  expressions) where the variable is bound to an element of an
  algebraic extension. The `Root[]` primitive (ADR-0018, P0-3) is
  the orthogonal "name an arbitrary algebraic" form.
- **ADR-0012 (composition layer).** `solve` calls `linsolve-q`,
  `poly-roots`, `groebner-basis` in-process via `@workbench/compose`;
  each substrate tool emits this same shape; the dispatcher
  re-aggregates.
- **ADR-0014/0015/0016 (numerical tier, determinism, scaling).**
  None of solve's outputs are `numerical: true` in v1 (everything is
  exact); `numerical: true` annotations only appear when a future
  numeric-fallback path is added.

## What this ADR does not do

- **Inequalities.** Not in v1 scope; `tagged 'solve/inequality'`
  refusal. A `Reduce[]`-class capability (CAD, quantifier
  elimination) is a separate epic.
- **Conditional solutions on parameter sign / domain.** v1 v2
  Mathematica was lossy here ("`Solve[Sqrt[x] == y, x]` ⇒
  `{x → y^2}`" with no `y ≥ 0`). A workbench-honest treatment
  requires conditional-expression output (the v3+ Mathematica
  `ConditionalExpression`) and is a separate ADR; v1 refuses such
  inputs with `tagged 'solve/parametric-non-trivial'`.
- **Order of solutions.** The list order is determined by the
  underlying algorithm and is not contractually specified. A
  consumer that needs order should sort by a canonical key (e.g.,
  bindings' canonical-bytes).
- **Multiplicities.** The list contains each solution once; a
  multi-root in a polynomial appears with multiplicity *one* in the
  solutions list. Multiplicity, where meaningful, lives elsewhere
  (in the polynomial's factor list from `poly-factor`, not in
  `solve`'s output).

## Acceptance for this ADR

- This document committed under `docs/adr/0017-solution-set-shape.md`.
- The shape declared with `S.record(...)` constructors, exported as
  `SolutionSetSchema` from a new `packages/solve-protocol/` package,
  before any code under `packages/solve/` is written.
- Every Phase 1+ solver tool emits this shape (or a `tagged`
  refusal); cross-tool consistency property-tested.

## Sources

- **Two principles** (project memory) — directs the branch-honesty
  decision and the "no `'principal-branch-only'` mode" decision.
- **ADR-0003 Tool output / error patterns** — the happy-path
  record-with-flag and `tagged "<tool>/<class>"` shapes inherit
  verbatim from -0003.
- **ADR-0004 Schema as first-class type** — `S.record`,
  `S.list`, `S.kind('symbol')`, `S.literal` constructors suffice.
- **PRD-v0.2 §2.3 (foreign pass-through)** — the round-trip
  invariant that every solver inherits.
- **Fateman 1991** (`Solve` transcripts) — primary evidence that
  v1/v2 Mathematica was branch-lossy; informs the
  no-`'principal-branch-only'` decision.
- **SymPy `solveset`** (BSD; `sympy/solvers/solveset.py`) — the
  modern reference for branched output. Our shape is a flatter
  re-encoding (bindings list + branches list) of `solveset`'s
  `ImageSet(Lambda(n, ...), ℤ)` form.
