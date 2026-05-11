# ADR-0031 — Exact-rational engine inside the float64 wire for `tools/lp-solve`

**Status:** Proposed — 2026-05-11
**Beads:** scientist-workbench-wx3m (`tools/lp-solve` arbprec lane);
scientist-workbench-taui (`packages/simplex-q` substrate). Follow-ups
hnyu (float lane), prfp (IPM lane).
**Related:** ADR-0030 (the cone-solver tier — fixes the wire schema
this ADR conforms to and the status taxonomy this ADR must implement);
ADR-0020 (the arbitrary-precision tier — the discipline this ADR
borrows for the *interior* of the tool, without claiming the public
annotation); ADR-0015 (the determinism tier — this ADR's public
annotation); CLAUDE.md Rule 8 (honest scope — the coefficient-explosion
refusal envelope is mandatory and not optional).
**Supersedes:** the v0.1 plan implicit in bead `wx3m` ("revised simplex
+ Mehrotra IPM in one tool") — superseded by *split into three lanes,
the bulletproof one first* (wx3m today; hnyu and prfp later).

## Context

ADR-0030 commissioned `tools/lp-solve` as the LP specialist of the
cone-solver tier, with an accuracy ceiling of 1e-12 and a wire schema
in float64. The original sketch combined revised simplex (Bartels-Golub
LU update) and Mehrotra IPM into a single tool with internal dispatch.

When the implementer landed on the bead during the 2026-05-11 LP-bench
onramp session, the question "which algorithm goes first?" was traced
back through the workbench's foundational axioms:

- ADR-0009 ("agents are TS experts; what a TS expert wants is the spec").
- PRD §1.1 revised ("agents have no say in any other scientific
  ecosystem; here the agent's experience IS the design").
- The persistent memory `two-principles` ("operational test: a TS expert
  would type this without thinking; if it needs a paragraph of
  justification the design is probably wrong").

For an LP solver specifically, the question becomes: what is the *one*
property of an LP solver a TS expert would lust for that no commercial
or open-source LP solver in any ecosystem currently provides?

**Bit-exact answers.** Every LP solver in production today — Gurobi,
Mosek, CPLEX, SoPlex, HiGHS, GLPK, CLP — runs float64 internally and
chases higher accuracy via iterative refinement. None of them returns
*the* optimal vertex; they return a float64-rounded approximation of
it. QSopt-Ex (Applegate et al. 2007) is the one academic exception,
written in C with GMP rationals, and it is the gold standard for exact
LP precisely because it is unique.

The workbench's `@workbench/cas-core` package already ships `Rat` +
`Field<Rat>` + `bareissSolve` over ℚ — production-quality, used by
`solve`, `groebner-basis`, `poly-factor`, and the algebraic-number
substrate. A TS-native exact-rational LP solver is *one substrate
package away*, and ADR-0030's wire schema accommodates it transparently.

This ADR codifies the design choice and the engineering discipline
that makes it work.

## The axiom (re-applied)

A TS expert types

```ts
const { x, dual, slack, objective, achieved_precision, status }
  = (await wb.run("lp-solve", problem)).output;
```

and **lusts for** `achieved_precision ≈ 2.2e-16` — one wire-encoding
round-off, not the IPM's 1e-12. They have never seen this from an LP
solver. They cannot get it anywhere else. The only price they pay is
wall time, and for n ≤ 100 dense it is sub-second; for the workbench's
target regime it is invisible.

The TS-expert filter forecloses three alternative reads:

- *"But float is faster"* — true and immaterial for small dense. The
  float lane (`hnyu`) is the natural second portfolio entry; the
  ordering is dictated by which lane is *unique* and which lane is
  *commodity*.
- *"But the wire is float64"* — true and exactly the reason this design
  works. The interior is exact; the wire is float64; the encoder
  rounding is the *only* loss of precision and it is one ULP, which is
  better than every existing LP solver provides.
- *"But coefficient explosion"* — true and bounded. Edmonds 1967 +
  modern QSopt-Ex experience confirm that for well-conditioned LP the
  bit-length growth is polynomial; for pathological inputs we refuse
  honestly via `tagged "lp-solve/coefficient-explosion"` rather than
  silently truncating. Honesty is the contract; lying is what is
  forbidden.

## Decision

### A. The engine is exact rational; the wire is float64

`tools/lp-solve` takes ADR-0030 §C input verbatim (`c`, `A`, `b` all
float64). Inside the tool, every input float64 is lifted to its
*exact* rational representation: `decodeFloat64ToRat(x)` exposes the
finite-bit dyadic that `x` literally is. There is no rounding on the
input side.

The simplex engine runs entirely over ℚ via `Rat` + the new
`packages/simplex-q` substrate. Pricing comparisons, ratio tests, and
termination predicates are exact. Bland's rule has a real termination
proof. Degeneracy is exact (a basic variable is *exactly* zero or it
isn't). The basis matrix `B` carries a rational LU factorisation
maintained across pivots.

Output is encoded back to float64 (`x`, `dual`, `slack`, `objective`)
via `float64FromRational(r)`. This is the *one* rounding step in the
entire pipeline. `achieved_precision` is computed by lifting the
encoded output back to ℚ, evaluating the four KKT residuals in ℚ,
encoding the residuals back to float64, and taking the maximum. For a
problem with `‖A‖_∞ ≤ 10^p`, `achieved_precision ≤ p · 2.2e-16`.

The pseudocode of the public entry point:

```
fn(input) =
  | validate wire shape & cone vocabulary
  | check finiteness; refuse on NaN/Inf
  | lift c, A, b: float64 → Rat (exact)
  | convert to internal standard form (free-variable splitting)
  | simplex over ℚ:
  |   Phase 1: minimise sum of artificials (Dantzig, Bland on degen)
  |     → infeasible certificate if Phase 1 obj > 0
  |     → drive artificials out of basis via degenerate pivots
  |   Phase 2: minimise cᵀx
  |     → optimal if all reduced costs ≥ 0
  |     → unbounded ray if entering column has no positive ratio
  | encode x, dual, slack, obj back to float64
  | compute achieved_precision in ℚ then encode to float64
  | emit per ADR-0030 §D
```

### B. Substrate split: `packages/simplex-q`, no cone-core dependency

A new package `packages/simplex-q/` houses the algorithm. It depends
*only* on `@workbench/protocol` and `@workbench/cas-core`. It does NOT
depend on `@workbench/linalg-core` (float-only) or
`packages/cone-core/` (does not exist yet; planned for `cone-solve`).

The public surface (per bead `taui`):

```ts
// rat-cmp.ts — total order on Rat (currently absent from cas-core)
export function ratCompare(a: Rat, b: Rat): -1 | 0 | 1;
export function ratLt(a: Rat, b: Rat): boolean;
// ... ratLe, ratGt, ratGe

// lu-q.ts — rational LU with factor-once / solve-many split
export interface RatLUFactor {
  readonly L: ReadonlyArray<ReadonlyArray<Rat>>;
  readonly U: ReadonlyArray<ReadonlyArray<Rat>>;
  readonly perm: ReadonlyArray<number>;          // row permutation
  readonly etaFile: ReadonlyArray<EtaUpdate>;    // post-factor column updates
  readonly maxBitLength: number;
}
export function factorRationalLU(B: Mat<Rat>): RatLUFactor;
export function solveRationalLU  (F: RatLUFactor, b: Vec<Rat>): Vec<Rat>;
export function solveRationalLU_T(F: RatLUFactor, b: Vec<Rat>): Vec<Rat>;
export function updateBasisColumn(
  F: RatLUFactor, colIdx: number, newCol: Vec<Rat>,
): RatLUFactor;

// simplex.ts — two-phase orchestrator
export interface StandardLP {
  readonly c: ReadonlyArray<Rat>;
  readonly A: ReadonlyArray<ReadonlyArray<Rat>>;
  readonly b: ReadonlyArray<Rat>;
  // every variable x_j >= 0
}
export interface SimplexResult {
  readonly status: "optimal" | "infeasible" | "unbounded"
                 | "iter-cap" | "coefficient-explosion";
  readonly x?:        ReadonlyArray<Rat>;
  readonly dual?:     ReadonlyArray<Rat>;
  readonly slack?:    ReadonlyArray<Rat>;
  readonly objective?: Rat;
  readonly basis?:    ReadonlyArray<number>;
  readonly iterations: number;
  readonly maxBitLength: number;
  readonly farkas?:   ReadonlyArray<Rat>;   // infeasibility certificate
  readonly ray?:      ReadonlyArray<Rat>;   // unbounded direction
}
export function simplexSolve(lp: StandardLP, opts: SimplexOpts): SimplexResult;
```

The substrate is *pure functions* over BigInt-backed rationals. No I/O,
no canonical-Value encoding, no float64. That all lives in
`tools/lp-solve/tool.ts`, which is the *wire wrapper* layer.

### C. Status taxonomy: ADR-0030's, with bookkeeping

ADR-0030 §A.3 fixes the public taxonomy. This ADR maps the engine's
internal taxonomy onto it as follows:

| engine `status` | wire `status` | objective + achieved_precision present? |
|---|---|---|
| `optimal` | `"optimal"` | yes (both required) |
| `infeasible` | `"infeasible"` | absent (Inf is invalid JSON; corpus shard 004) |
| `unbounded` | `"unbounded"` | absent (Inf is invalid JSON) |
| `iter-cap` | `"iter-cap"` | absent |
| `coefficient-explosion` | refuse with `tagged "lp-solve/coefficient-explosion"` | n/a (boundary refusal) |

`numerical-breakdown` (ADR-0030's fifth class) is *not emitted* by the
arbprec engine — exact arithmetic does not break down numerically. If
the wire decode produces NaN/Inf the tool refuses upstream with
`tagged "lp-solve/non-finite-input"`. The status string remains in the
taxonomy for forward-compatibility with the float lane (`hnyu`).

`tagged "lp-solve/precision-unreachable"` (ADR-0030 §A.3's refusal
envelope) is unreachable from the arbprec lane and never emitted.

### D. Refusal envelopes (boundary failures, ADR-0003)

Five `tagged "lp-solve/<class>"` boundary refusals:

- `non-finite-input` — any `c[i]`, `A[i][j]`, or `b[i]` is NaN, +Inf,
  or −Inf. Payload: `{ which: "c" | "A" | "b", index?, row?, col?,
  value: "NaN" | "Infinity" | "-Infinity" }`.
- `degenerate-shape` — `A.length !== b.length`, `A[i].length !== c.length`
  for some `i`, or `c.length === 0`. Payload: `{ detail: string }`.
- `malformed-cone` — a cone in `cones` is not `NonNegCone`, or its
  indices reference an out-of-range variable, or the union of cone
  indices does not cover every variable. Payload: `{ detail: string }`.
- `coefficient-explosion` — `simplexSolve`'s `maxBitLength` exceeds the
  cap (default 2^20 = ~1M bits per coefficient; configurable via
  `--max-bit-length=<int>` standard-ish flag). Payload: `{ achieved,
  cap, iteration, suggestion: "try tools/lp-solve --method=float when
  available, or rescale the problem" }`.
- `non-lp-cone` — `cones` contains `SOCone`, `PSDCone`, `ExpCone`, or
  `PowCone`. This tool handles LP only; non-LP cones are out of scope.
  Payload: `{ detail: string, suggestion: "use tools/cone-solve" }`.

CLAUDE.md Rule 8: lying is inadmissible regardless of cleverness. The
coefficient-explosion path is the agent-honest answer to "this problem
is exact-pathological"; the alternative (truncate the rationals and
return a float-shaped approximation) is forbidden.

### E. Algorithm port discipline

Per ADR-0030 §E, every algorithm derives from primary references.
No port of `glpk`, `clp`, `qsopt-ex`, or any other source. Specific
references for v0.1:

| component | references |
|---|---|
| Revised simplex | Dantzig 1947 *Maximization of a Linear Function of Variables Subject to Linear Inequalities*; Vanderbei *Linear Programming* 4th ed. Ch.7–8 (the textbook) |
| Two-phase initialisation | Vanderbei §7.2; Bertsimas-Tsitsiklis *Introduction to Linear Optimisation* §3.5 |
| Anti-cycling | Bland 1977 *New Finite Pivoting Rules for the Simplex Method* (Math. Oper. Res. 2, 103–107) |
| Rational LU | Standard pivoted LU over a field; Vanderbei §6.1; substrate generalised from `cas-core/src/linsolve.ts`'s Bareiss elimination |
| Coefficient-growth bound (informational) | Edmonds 1967 *Systems of Distinct Representatives and Linear Algebra* (J. Res. NBS); Applegate-Cook-Dash-Espinoza 2007 *Exact Solutions to Linear Programming Problems* (Op. Res. Lett.) |

Deferred to follow-up beads:

- Bartels-Golub LU update (bead `hnyu` — float lane needs it for
  numerical hygiene; arbprec lane does not).
- Mehrotra predictor-corrector IPM (bead `prfp`).

### F. Determinism contract

| property | this tool |
|---|---|
| annotation | `numerical: true` (ADR-0015) |
| bit-identical | given platform fingerprint `{arch, os, runtime}` |
| interior arithmetic | arbprec-strength (BigInt rational, bit-identical *across* platforms) |
| wire encode/decode | float64 (one ULP per coefficient) |
| `precision` flag | accepted; ignored by the engine (engine is exact). Reported back via `achieved_precision`. |
| `max_iter` flag | accepted; default `10 · (m + n)` per ADR-0030 §A.1 |
| `max_bit_length` flag (new) | accepted; default `2^20`. Controls the coefficient-explosion refusal. |

The interior of the tool is `arbprec: true`-strength but the public
annotation stays at `numerical: true` because the wire encode/decode is
float64. An `arbprec: true` LP tool with a *rational* wire is a
plausible v2 (`tools/lp-solve-arbprec` or similar) and is recorded as
open question §3 below.

## Why rejected alternatives

**Pure-float-engine v0.1 first.** Rejected. The float lane is what
every commercial solver provides; an LP-tool that gives the agent
float64 answers is commodity work and not what a TS expert lusts for.
The unique entry — exact rational — comes first; the float entry
(`hnyu`) is the natural second portfolio member.

**Pure-arbprec wire (rational `c`, `A`, `b` in, rational `x` out).**
Rejected for v0.1. ADR-0030 settled the cone-tier wire as float64 and
the LP-bench harness on the corpus side consumes that wire. A separate
tool with a rational wire is plausible (open question §3) but not the
job today; it would also fork the bench harness, which is exactly the
proliferation ADR-0030 sought to prevent.

**Internal dispatch (single tool, multiple internal lanes, today).**
Rejected for v0.1. Building one bulletproof lane and shipping it
behind a single-symbol public API is strictly simpler than building
two-or-three lanes plus a dispatcher in the same session. The future
beads (`hnyu`, `prfp`) add lanes to the *same* tool with a
`--method=...` flag; the public symbol stays `lp-solve`.

**Cone-core dependency.** Rejected. `packages/cone-core/` (bead `cp9k`)
is the substrate for the universal `cone-solve`'s ADMM iteration on
HSDE. Nothing in `tools/lp-solve`'s algorithm needs it. Forcing the
dependency would couple two genuinely independent work-streams.

**Use `bareissSolve` directly as the basis-solve.** Rejected.
`bareissSolve` is a full-elimination operation: O(m³) per call. The
revised simplex re-uses the same basis matrix B across consecutive
pivots, modifying it one column at a time. The right substrate is a
factor-once / solve-many LU with an eta-file update — O(m³) once, then
O(m²) per pivot + O(m²) per column-update. This is the substrate
`packages/simplex-q/lu-q.ts` provides (bead `taui`).

**Klee-Minty / cycling instances as test-only.** Rejected as
insufficient. Tests include the Beale 1955 cycling instance (the
canonical cycling exemplar) with a *mutation-prove* step (Rule 6):
disable the Bland switch → cycling test goes RED → re-enable → GREEN.
A test that asserts "Beale terminates" without proving the guard is
load-bearing is broken per CLAUDE.md Rule 7.

## Open questions

1. **Coefficient-explosion cap default.** `2^20 = ~10^6 bit` per
   coefficient is a hand-picked guess. The honest value should come
   from empirical bit-length distributions over the lp-netlib corpus;
   the bench will tell us the right cap after v0.1 ships. Re-evaluate
   in the v0.2 worklog.

2. **Refactorisation cadence.** The eta-file grows linearly with
   pivots, and each `solveRationalLU` walks the file. For arbprec
   there is no numerical-hygiene motivation to refactor (exact
   arithmetic doesn't drift); the only motivation is performance.
   Reasonable defaults: refactor when the eta-file exceeds `m` updates
   OR when `maxBitLength` doubles since the last factor. Pick one
   empirically.

3. **Future `tools/lp-solve-arbprec` with a rational wire.** An LP
   tool whose public input is `list<rational>` rather than
   `list<float64>` would be the literal arbprec-LP tool with the
   full ADR-0020 annotation. It is a plausible v2 with a different
   bench harness (rational golden inputs). Defer until a real use
   case appears.

4. **Free-variable handling.** ADR-0030's open question §2 asks
   whether `FreeCone[indices]` should be a first-class wire cone. For
   `tools/lp-solve` today: variables not covered by any `NonNegCone`
   are treated as free and split internally as `x_j = x_j⁺ − x_j⁻`.
   `FreeCone` as a wire cone awaits the cone-solve implementer's
   decision.

5. **Vertex-basis output.** ADR-0030 mentions "LP returns a vertex
   basis" as a specialist output. The arbprec engine *does* produce
   one (the basis indices at termination). Future flag `--emit-basis`
   could surface it; deferred to v0.2 to avoid bloating the v0.1
   schema.

## Acceptance (for v0.1)

- `packages/simplex-q/` shipped with `rat-cmp`, `lu-q`, `simplex`,
  workspace tests, and a literate README.
- `tools/lp-solve/` shipped with the seven artefacts (schema, examples,
  invariants, `--test`, goldens, README, def per ADR-0010).
- Beale 1955 cycling instance test green and mutation-proved.
- Klee-Minty exponential-pivot-count instance terminates.
- Workbench's full `bun run check` green.
- Corpus bench: 21/21 on `lp-netlib` + 29/29 on `lp-small` (per worklog
  089 and corpus shard 005).
- Worklog shard documenting the build (frictions, dead ends, the
  arbprec realisation).

## Pointers

- **ADR-0030** for the wire schema and status taxonomy this ADR
  conforms to verbatim.
- **ADR-0020** for the arbprec-tier discipline borrowed for the
  interior of the tool.
- **CLAUDE.md Rules 1, 7, 8, 10** — fail loud; tests assert
  invariants; honest scope; literate programming.
- **Corpus repo** `benchmarks/lp-netlib/` and `benchmarks/lp-small/`
  for the bench gate.
- **worklog 089** for the LP-bench onramp narrative.
- **`packages/cas-core/src/rat.ts`** and **`packages/cas-core/src/linsolve.ts`**
  for the substrate this ADR builds on.
- **Vanderbei *Linear Programming* 4th ed.** — the textbook reference
  for revised simplex and two-phase initialisation. Read Ch.6–8 before
  reading `packages/simplex-q/src/simplex.ts`.
- **Bland 1977** for the anti-cycling proof. The Math. Oper. Res.
  paper is short (5 pages) and self-contained.
