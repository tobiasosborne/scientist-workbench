# cas-core roadmap — substrate for a real CAS

**Status:** working document
**First captured:** 2026-04-29 (post-Phase-1-of-Sturm sidequest)
**Maintainers:** every agent landing CAS work in this repo

The current `packages/cas-core` is a v0.1 MVP covering `Q[x₁,…,xₙ] /
Q(x₁,…,xₙ)`. Its intended trajectory is to grow into a *real* computer
algebra system on feature parity with mature systems (Mathematica,
SymPy, Maple, FriCAS) — at scientist-workbench's chosen granularity:
small typed substrate library + many independent tools.

This document captures the trajectory: which CAS capabilities live in
the library, which live in tools, what the next rungs of the ladder
are, and how each rung's dependencies sit relative to the others.

It is a working document. Re-read it before scoping any cas-related
work. Update it (here, in lockstep) when a rung lands or when the
priority shuffles in response to demand.

## How existing CAS architectures split work

A skim of the major systems, with the lesson each contributes.

- **Mathematica.** Monolithic centralised kernel; everything is a
  `Head[args]` term (matches our `expression` Value); global pattern
  matching with held-evaluation rules. Failure mode: composition
  through global mutable state. *We deliberately reject this shape.*
- **SymPy.** Small core (~5k LOC: `Expr` hierarchy, canonical
  arithmetic over `Integer`/`Rational`/`Add`/`Mul`/`Pow`); peripherals
  (`simplify`, `polys`, `solve`, `integrate`, `series`, `matrices`)
  are 100× the core. Maps directly to "library + tools."
- **Maple.** Explicit kernel/library split. Kernel = data types +
  basic eval. Library = simplify, solve, int, etc. Same shape.
- **FriCAS / Axiom.** Strongly typed via category theory: `Ring`,
  `Field`, `GcdDomain`, `UniqueFactorizationDomain`. `Polynomial(R)`
  is *generic over the coefficient ring R*. Algebraic extensions are
  first-class; tower constructions are natural. Architecturally
  the cleanest of these systems.
- **Pari/GP.** Number-theoretic focus. Rich type-tag system: `t_INT`,
  `t_FRAC`, `t_QUAD` (quadratic algebraic), `t_POLMOD` (polynomial
  modulo, i.e. `Q[α]/(p)`), `t_PADIC`. Type-tagged dispatch — same
  shape as our `kind` discriminator.
- **Maxima.** Lisp-based; strong on integration (Risch). Composition
  via Lisp functions over a shared expression representation.
- **SageMath.** Meta-CAS: wraps Maxima/Pari/GAP/SymPy/etc. The
  closest existing analogue to "an agent-first ecosystem" — but still
  one Python process. We're decomposed one level further (each tool is
  its own process).

## Patterns shared across all of them

1. **Small typed core, large peripheral library.** The core does data
   representation, ring arithmetic, and one canonical form per ring.
   Peripherals do "high-level operations." Even Mathematica's kernel
   is conceptually this shape — they just chose not to enforce the
   boundary.
2. **Coefficient ring is parametric.** A polynomial over Q and one
   over Q[√2, i] run the *same* algorithms; only the coefficient
   operations differ. Generic-over-ring polynomial arithmetic is the
   architectural move every serious CAS makes.
3. **Algebraic numbers are universal.** Every serious CAS supports
   `Q[α]/(p(α))`, often as a tower `Q ⊂ Q[α₁] ⊂ Q[α₁, α₂] ⊂ …`.
   Cyclotomic extensions are first-class because roots of unity
   appear everywhere.
4. **Pattern matching is core substrate.** SymPy `Wild`, Mathematica
   `_`, Maple `match`, FriCAS `Pattern` — all CASes provide
   structural matching against the expression tree. Substitution is
   one consumer.
5. **Polynomial GCD is the central hard primitive.** Rational-function
   reduction, partial fractions, factorisation, Hermite reduction
   in integration — all bottom out on multivariate poly GCD
   (subresultant or sparse modular).
6. **Integration is the hardest peripheral.** Risch is undecidable in
   general; complete implementations are decade-scale work.

## The library / tool split — how we draw the boundary

Distinguishing principle:

- **Substrate (library):** "what a Value *is*, and how to compute
  with it at the data-structure level." Single workspace, internal
  API, no JSON boundary. Lives in `packages/cas-core` (and possible
  future siblings if scope demands).
- **Operation (tool):** "input is a Value, output is a Value, the
  operation is independently meaningful and worth content-addressing."
  JSON-on-stdin/stdout, seven-artefact contract.

Discriminating test: *can a meaningful `--examples` table describe
the input/output relationship?* If yes, it's a tool. If not (e.g.,
"the multiplication algorithm" has nothing to put in examples beyond
`(2,3) → 6`, which is uninteresting at the boundary), it's substrate.

## The capability map

| Capability | Library or tool? | Status |
|---|---|---|
| Number kinds (int, rat, algebraic, finite-field) | library | int/rat ✓; algebraic next |
| Polynomial repr + arith (generic over coefficient ring) | library | univariate-Q hardcoded; ring-parameter refactor pending |
| Rational-function repr + arith | library | ✓ (will follow ring-parameter) |
| Canonical form per ring | library | ✓ for Q[x]/Q(x) |
| Polynomial GCD (subresultant / modular) | library + tool | **missing** — gates `cas-reduce`, `cas-factor`, partial fractions |
| Factorisation (square-free, full) | library + tool | missing |
| Substitution (var → expr) | library | missing — small primitive, used everywhere |
| Differentiation | library + tool | missing — small, well-defined |
| Pattern matching (structural, on Value tree) | library | missing — substrate for many tools, needs design ADR |
| Simplification | tool | `cas-simplify` ✓ |
| Equality decision (sound, no GCD needed) | tool | `cas-verify` ✓ |
| Reduction (GCD-aware normal form) | tool | `cas-reduce` deferred (PRD §0.1) |
| Series / Taylor / Laurent | tool | `cas-series` (future) |
| Limits | tool | `cas-limit` (future) |
| Solving (poly roots, linear systems) | tool | `cas-solve` (future) |
| Numerical evaluation (→ float64) | tool | `cas-eval` (future) |
| LaTeX / human rendering | tool | `cas-tex` (future) |
| Integration (Risch) | tool | `cas-integrate` (long-term) |

## The ladder — priority order

The rungs are roughly priority-ordered. None blocks the others except
where dependencies are explicit; demand reorders.

1. **Ring-generic refactor.** `Poly<R>` and `RatFn<R>` parametric
   over a Ring interface. Q stays the v0.1 instance. **Load-bearing
   for everything below.**
2. **Algebraic numbers.** `Q[α]/(p(α))` for univariate α; tower
   extensions via composition. First concrete consumer is
   `sturm-execute` (Clifford+T fragments need `Q[√2, i]`).
3. **Polynomial GCD.** Subresultant or sparse-modular. ~300 LOC.
   Gates `cas-reduce` (closes PRD §0.1's known gap) and `cas-factor`.
4. **Substitution as a library primitive.** Small. Used by
   simplification, differentiation, evaluation. Probably not its
   own tool — exposed as a flag on `cas-simplify` if a use case
   demands.
5. **Differentiation.** Library primitive + thin `cas-diff` tool.
   Small, well-defined. Useful in its own right and gates Risch.
6. **Reduction tool (`cas-reduce`).** Once GCD lands. Gives
   `(x²−1)/(x−1) → x+1`, the canonical demo.
7. **Factorisation.** Square-free first, then full. Tool: `cas-factor`.
8. **Pattern matching primitive.** Needs a design ADR before
   implementation — Mathematica-style holds are out (they're the
   failure mode); SymPy-style `Wild` with predicate constraints is
   the natural target.
9. **Numerical evaluation.** `cas-eval` tool. Bridges symbolic →
   float64. Useful for "ground truth: what's the actual value?"
10. **Series / limits / solve / tex.** Independent tools, each its
    own ADR + landing.
11. **Integration.** Risch + Hermite reduction + structure theorem.
    Multi-year work; out of scope until many earlier rungs land.

## Architectural decisions that have already cost something

- **Hardcoding `Rat` as the coefficient in `Poly`.** The ring-generic
  refactor (rung 1) is exactly the cost of having shipped this in
  v0.1. We accept the churn — it's load-bearing.
- **No coefficient-ring abstraction in `expr-bridge.ts`.** The
  Value→RatFn translation assumes Q. Future rings need their own
  bridges.
- **No GCD in v1 of `cas-simplify`.** Documented in PRD §0.1.
  `cas-verify` works around it via cross-multiplication. Once GCD
  lands, `cas-simplify` v2 + `cas-reduce` close the gap together.
- **`cas-core` exposes mutable iteration order in places.** Hash-map
  iteration is sorted by canonicalisation, but care is needed in
  any new ring code. See `packages/cas-core/src/poly.ts` for the
  patterns to follow.

## Tradeoffs in the algebraic-numbers design (rung 2)

Two natural representations:

- **Flat:** `Q[α₁,...,αₖ]/(p₁,...,pₖ)` with simultaneous reductions
  (Gröbner basis on the ideal). General; expensive in implementation.
- **Chain:** `Q ⊂ Q[α₁] ⊂ Q[α₁, α₂] ⊂ ...`, each link a single
  univariate extension. Easier to implement, easier to grow, matches
  FriCAS's design. The cost: extension order matters at the type
  level, but elements canonicalise the same.

**Recommendation:** chain. We pay the order-sensitivity at type level
in exchange for simpler arithmetic. The ordering chosen for `Q[√2, i]`
is `Q ⊂ Q[√2] ⊂ Q[√2][i]` (irrational extension first, then
imaginary) — this matches the natural Q-basis `{1, √2, i, √2·i}`.

## What this commits us to

cas-core is on a multi-year arc to a real CAS. The agent-first
architecture (each tool is independent, each ring is its own type)
makes that sustainable — each rung is its own ADR + worklog landing,
none blocks the others except where dependencies are real. But it
does mean the project's surface is bigger than "the workbench" in
isolation: cas-core's evolution is its own thread that consumers
(Sturm tools, future numerical/analysis tools) ride on.

## Pointers

- `PRD-v0.2.md` §0.1 — known v1 gaps (no polynomial GCD, no
  reduction).
- `packages/cas-core/src/` — current implementation; read before
  any new ring work.
- `tools/cas-simplify/`, `tools/cas-verify/` — the v0.1 tools
  consuming cas-core.
- ADR 0008 (filed alongside this document) — the formal landing of
  the ring-generic refactor and the algebraic-numbers rung.
- shards 014/015 — the most recent cas-adjacent work
  (`packages/sturm-ir`, `tools/sturm-simplify`); sturm tools are the
  immediate consumer of rung 2.
