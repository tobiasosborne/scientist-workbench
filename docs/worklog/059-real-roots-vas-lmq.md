# 059 — `packages/real-roots` + `tools/real-root-isolate` (rra): VAS-LMQ ship

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** applies ADR-0019 (bench discipline), ADR-0017 (root-naming
shape — `tools/solve` composes this tool's output upstream), ADR-0009
(TS-native frontend DSL — port matches SymPy's structure idiomatically
not idiom-for-idiom). No new ADRs.
**Issues closed:** scientist-workbench-rra.

## Context

Second sub-shard of the alg-num branch (after worklog 058's `q8q`
bench): the TypeScript implementation of Vincent-Akritas-Strzebonski
(VAS) continued-fraction real-root isolation with the Local-Max
Quadratic (LMQ) bound (Akritas-Strzebonski-Vigklas 2008). Ports
SymPy's BSD `dup_isolate_real_roots_sqf` (`sympy/polys/rootisolation.py`)
to TS over the workbench's BigInt-rational substrate.

This is the *substrate ship* for the alg-num chain: bead `xyt`
(Root[poly,k] type) needs isolating intervals to disambiguate the
`(minpoly, k)` index in canonical sort order; `xkz` (lazy interval
refinement) consumes them as starting intervals; `6cd` (equality)
disambiguates same-minpoly roots by interval intersection. Without
real-root-isolate, the `Root[]` substrate has no canonical k.

Sequenced behind worklog 058 (q8q bench): the bench was already there
to gate the implementation, so the TS port could be written
test-driven against the 37-case battery.

## What changed

### `packages/real-roots/` — new package (~370 LOC)

Files:

- **`src/dense.ts`** (~190 LOC) — dense ℤ[x] primitives over BigInt:
  `strip`, `degree`, `leading`, `trailing`, `negate`, `mirror` (`f(-x)`),
  `scale` (`f(a·x)`), `shift` (Taylor `f(x+a)` via finite differences),
  `reverse` (`x^n · f(1/x)`), `rshift` (`f / x^k`), `evalAt` (Horner),
  `signVariations` (Descartes' sign-change count), `clearDenominators`
  (ℚ → ℤ via LCM), `ilog2Floor`/`ilog2Ceil` (BigInt log2 helpers).
  High-to-low coefficient convention matching SymPy's `dup_*` family;
  see "Why these choices" below.
- **`src/lmq.ts`** (~80 LOC) — LMQ upper bound as a power-of-2
  exponent (`number`, the bound is `2^k`). The exponent
  representation matters: the bound can be `2^k` for negative `k`
  (e.g., `LMQ_upper(reverse(x − 100)) = 2^{-4} = 1/16`), so the
  natural output is the integer exponent rather than a BigInt
  numerator. `lmqLowerBoundFloor` returns `floor(2^{-k})` as a
  BigInt — `0n` if `k > 0`, `1n` if `k = 0`, `2^{-k}` otherwise —
  the integer shift amount the VAS recursion uses.
- **`src/vas.ts`** (~190 LOC) — the VAS recursion. `Mobius` type for
  the linear-fractional accumulator, `MOBIUS_ID` constant, `Leaf`
  type for terminal nodes, `stepRefine` (single-step refinement
  matching SymPy's `dup_step_refine_real_root`), `refineUntilFinite`
  (the `while M.c == 0` loop; cap 1024 iterations as defence
  against algorithm-correctness regressions), `inner_isolate_positive`
  (the headline DFS-stack-based recursion mirroring SymPy's
  `dup_inner_isolate_real_roots`).
- **`src/isolate.ts`** (~110 LOC) — top-level. Clears denominators,
  strips trailing-zero factor (root at zero → singleton `(0, 0)`),
  runs VAS on `f(-x)` (negative roots) and `f` (positive roots),
  sorts ascending by `lo`. The `mobiusToInterval` helper converts
  Möbius `(a, b, c, d) → (b/d, a/c)` sorted ascending; the
  `c == 0` post-condition is enforced by `refineUntilFinite` so
  the conversion never divides by zero.
- **`src/index.ts`** — public surface re-exports.
- **`README.md`** — package overview, two-shape output convention,
  squarefree precondition rationale, algorithm summary, references.
- **`package.json`** — workspace manifest (`@workbench/real-roots`).

### `tools/real-root-isolate/` — new tool (~280 LOC)

- **`tool.ts`** — value-protocol-conformant wrapper around
  `isolateRealRoots`. `valueToRatFn` parses the input expression,
  rejects rational-function-with-non-constant-denominator (tag
  `non-polynomial`); `polyVars` rejects multivariate input
  (tag `multivariate`); `polyGcd(f, f')` rejects non-squarefree input
  (tag `not-squarefree`); the squarefree polynomial's coefficient
  list goes to `isolateRealRoots`. Output `record { intervals: [...],
  method: "vas-lmq", warnings: [] }` with `intervals[i].{lo, hi}`
  rendered as `int(n)` for integer endpoints or `expr("/", [int(n),
  int(d)])` for fractions.
- **`goldens.spec.ts`** — 15 golden cases covering: linear (rational
  + integer roots), quadratic (`x² − 2`, `x² + 1`, integer-root
  `x² − 5x + 6`), cubic casus irreducibilis (`x³ − 3x + 1`),
  cubic-with-zero (`x³ − x`), quartic (cyclotomic `x⁴ − 1`,
  Chebyshev `T_4`), refusal classes (not-squarefree variants,
  non-polynomial `sin`, multivariate `xy`, rational function `1/x`).
- **`README.md`** — surface, examples, output conventions, hard
  constraints.
- **`package.json`** — workspace manifest.

### `bench/real-root-isolate/run-candidate.ts` — new (~180 LOC)

The bench candidate adapter: reads the bench wire format `{f:
<string>, var: <string>}` from stdin, parses `f` via an inline
recursive-descent polynomial-string parser (handles
`+ − * / ** ^ () unary-minus` plus integer and `n/d` rational
literals — sufficient for every `bench/real-root-isolate/golden/
inputs.json` entry), dispatches in-process to
`real-root-isolate/tool.ts`'s `def.fn`, and renders the bench output
shape (`{kind: "ok", intervals: [{lo: "p/q", hi: "p/q"}, ...]}` or
`{kind: "tagged", tag, payload}`). The inline parser is necessary
because `tools/expr-parse`'s subprocess invocation would multiply
the bench wall-clock 100× for 37 cases — the in-process composition
floor (ADR-0012) is essential.

### Catalog updates

- `README.md` — new `real-root-isolate` row in the tools table; new
  `real-roots/` row in the packages list (Law-2 lockstep).
- `packages/compose/src/generated/wb.ts` — regenerated with the new
  tool registered (33 → 34 tools; `bun scripts/gen-workbench-barrel.ts`).

## Why these choices

**Why high-to-low coefficient arrays.** SymPy's `dup_*` family
represents polynomials as `[c_n, c_{n-1}, …, c_0]` (highest-degree
first); my port follows the same convention. A TS-native low-to-high
representation (where `arr[i]` is the coefficient of `x^i`) is more
intuitive in array-indexed languages, but every line of the port would
flip indices — multiplying bug surface for a cosmetic gain. The "two
principles" applied here: a TS expert wants *correctness first*; a
careful port whose lines map 1:1 to SymPy is more verifiable than a
TS-idiomatic rewrite that risks subtle index errors. SymPy is the
reference; matching its convention is the conservative choice. Once
the implementation is goldened-and-frozen, an interface-preserving
flip to low-to-high would be a separable refactor (probably worth
doing in a future shard if the alg-num chain motivates it; for now
the convention lives at the package boundary, not the tool surface).

**Why LMQ as a power-of-2 exponent.** The LMQ bound is *intrinsically*
a power of 2 — the formula is `2^{1 + max_k q_k}` where `q_k` is an
integer floor-division. Materialising the bound as a BigInt number
loses information (negative exponents become rationals, requiring a
ℚ representation) and wastes work (the caller usually needs only
`floor(1 / bound)` for the recursion's shift step, which is a sign-
and-magnitude check on the exponent). Returning `number` (the
exponent) keeps the natural representation and lets
`lmqLowerBoundFloor` translate to BigInt only when the recursion
actually needs the integer shift amount.

**Why DFS-stack instead of recursion.** Mirrors SymPy's
implementation. JS engines have shallow-ish call stacks (~10K frames
on V8/JSC, sometimes less under Bun); a degree-100 polynomial's
worst-case recursion depth in VAS is approximately the bit-length of
the largest coefficient times the degree, which can exceed 10K for
tier-D inputs. The stack-based DFS is cheap (one heap allocation per
push) and bounds the call depth at 1.

**Why the squarefree check is in the tool, not the package.** The
package's invariants are conditional on squarefree input; checking
the precondition there would couple the package's purpose
(isolation) to the precondition's check (gcd-based). Keep the
package narrow: VAS-LMQ on a squarefree integer-coefficient
polynomial. The tool layer adds the value-protocol shape, the
multivariate / non-polynomial / non-squarefree refusals, and the
expression-parsing front-end. This split mirrors the rest of the
workbench: substrate packages do the math; tools wrap the substrate
in the value protocol's contract.

**Why `polyGcd(f, f')` not `polyGcd(f, polyDeriv(f))`-and-monic.**
The cas-core `polyGcd` already returns a canonical (monic) result;
`polyIsConst(g)` is the correct squarefree predicate (gcd is a unit
modulo associates ⇔ constant in monic form). No extra polishing
needed.

## Frictions surfaced

**`Poly.is_squarefree` is misnamed in SymPy.** First-pass reference
(worklog 058) used `not p.is_squarefree`; SymPy raised
`AttributeError`. The attribute is `is_sqf`. A `dir(p)` filter for
`/sqf|square/i` revealed both `is_sqf` (the method) and `sqf_list`
(the factorisation), but no `is_squarefree`. SymPy has a free
function `sympy.is_squarefree(...)` that wraps the attribute, so the
naming is half-consistent; on `Poly` it's `is_sqf`. Caught and fixed
in worklog 058 (the bench reference); this shard's port reused
the fixed pattern.

**LMQ exponent can be negative.** First-pass `lmqUpperBound` returned
`bigint` and used `1n << BigInt(k+1)` directly. For polynomials with
small positive roots (e.g., `x − 100`'s LMQ_upper(reverse(f)) =
`2^{-4}`), `k = -5` and `BigInt(-5+1)` = `BigInt(-4)`, but
`1n << -4n` is undefined behaviour in JS BigInt. Caught at smoke-test
when `f = x − 100` produced no intervals (LMQ rejected the recursion).
Fixed by returning `number` (the exponent) and reciprocating in
`lmqLowerBoundFloor` exactly: `2^{-k}` for `k < 0` is a positive
BigInt; `2^{-k}` for `k > 0` is a fraction whose floor is 0. The
`number`-returning convention is also the natural form per
Akritas-Strzebonski-Vigklas 2008 §3 (the paper's pseudocode tracks
exponents).

**SymPy's `dup_inner_isolate_real_roots` "fast path" exists; we don't
ship it.** The `fast=True` branch (lines 391-395 of SymPy's source)
*scales* by the LMQ bound `A` instead of *shifting* — `dup_scale(f, A)`
multiplies coefficients by `A^k`, compressing the recursion when `A
> 16`. The trade-off: scale by 16 means `A · a, A · c, A` become
larger by a factor of 16 each step, so subsequent shifts cost more
BigInt multiplication; on the other hand, the recursion terminates
faster. SymPy makes it an opt-in flag because the trade-off is
input-dependent. We omit it for v0.1 — the current implementation is
fast enough for tier-D-50 (Wilkinson 50) at ~10ms — and a future
optimisation shard can add it under a `fast` flag if benchmarks show
the need.

**The bench's run-candidate.ts inlines a tiny expression parser
because `tools/expr-parse` would be too slow.** Subprocess invocation
of `expr-parse` per case at ~50ms each × 37 cases = 1.8s overhead;
the in-process candidate completes the full bench in 200ms. The
inline parser handles the bench's input vocabulary (numeric literals,
rational `n/d`, variable, parens, `+ − * / ** ^`); about 100 LOC of
recursive-descent. Honest scope: the parser is *just enough* for the
bench inputs and would refuse anything more complex with a parse
error; the *real* tool surface (`tools/real-root-isolate`) parses
arbitrary value-protocol expressions via `valueToRatFn`. No
abstraction shared.

**`canonicalToJson` not `toJsonValue` in `@workbench/json-bridge`.**
First-pass run-candidate.ts imported `toJsonValue`; the bridge's
canonical name is `canonicalToJson`. Caught at the candidate's first
invocation; trivial fix.

## Acceptance

- 1 bead closed: `scientist-workbench-rra`.
- `packages/real-roots/` shipped: dense ops, LMQ, VAS recursion,
  top-level isolation, README.
- `tools/real-root-isolate/` shipped: tool.ts, goldens.spec.ts (15
  cases, all green), README, package.json.
- `bench/real-root-isolate/run-candidate.ts` shipped; bench
  37/37 green via `bench/infra/run-bench.sh`.
- `bun run check`: 63 phases passed, 0 failed (added one phase: the
  oracle pass on tools/real-root-isolate's 15 goldens).
- Catalog updates: README tools table + packages list (Law-2 lockstep).

## Pointers

- Bead `scientist-workbench-rra`: closed.
- Worklog 058: the bench (`q8q`).
- Open follow-ups (alg-num chain): `xyt` (Root[poly,k] type +
  canonicalisation), `xkz` (lazy interval refinement via interval
  Newton), `6cd` (equality via interval-disambiguation), `rti`
  (subresultant sum/product), `5i2` (primitive-element compression),
  `iay` (alg-num arithmetic bench), `yoc` (poly-roots upgrade for
  deg ≥ 5).
- Future optimisation: SymPy's `fast=True` scale-by-A path (deferred;
  tier-D performance is acceptable without it).

## Commits

(this shard documents the work landed; commit message will follow
the same Law-2 lockstep pattern when staged.)
