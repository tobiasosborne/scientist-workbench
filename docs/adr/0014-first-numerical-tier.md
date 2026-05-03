# ADR-0014 — First numerical tier (pure-TS dense linalg)

**Status:** Accepted — 2026-05-03
**Beads:** scientist-workbench-n2a (epic), -abj (this ADR), -0ky
(packages/linalg-core), -ynd (tools/linalg-solve), -gyb (lockstep
docs), -bf0 (worklog 031)
**Related:** `docs/numerics-and-vis-2026-04-29.md` (the research note
this ADR forces into a decision); ADR-0010 (`defineTool`/`runTool`
split — the substrate that makes library-and-tool dual surface real);
ADR-0003 (output / error categories — applied here in numerical
form); ADR-0005 (externalised entropy — the precedent for a
manifest-annotated tier); ADR-0011 (typed flag declarations — the
"what would a senior TS expert want" axiom this ADR re-applies).

## Context

The `numerics-and-vis-2026-04-29.md` research note named the cliff:
sci-wb covers ~5% of physics, ~10% of ML, ~0% of data analysis
without numerical methods. The note proposed four cheap experiments
(§5) and explicitly held back from drafting a determinism-tier ADR
("the forcing experiment hasn't run").

This ADR is the smallest such forcing experiment, sharpened from the
note's §5.3:

- **Note's §5.3:** "One numerical-tool prototype — `numeric-eigvals`
  (or simpler: `numeric-norm-2`) over a `record { matrix:
  blob-descriptor, options: ... }`. Bridge to Julia via subprocess."
- **What this ADR commits to:** `tools/linalg-solve` (LU + iterative
  refinement + Hager condition estimate) over a `record { A:
  list<list<float64>>, b: list<float64> }`. Pure TypeScript on
  `Float64Array`. **No** Julia bridge, **no** blob-by-hash, **no**
  FFI, **no** cross-platform determinism guarantee.

Three things changed the sharpening:

1. **ADR-0010 (`defineTool`/`runTool` split)** is now load-bearing.
   The library and tool can share one implementation, with the tool
   being a thin wire-encoding wrapper. This was only gestured at on
   2026-04-29; it is the central enabler now.
2. **Cap-at-200 is small enough that wire encoding works.** A
   200×200 dense matrix is ~470 KB on the wire (5.9× the 320 KB
   binary). The `list<list<float64>>` path is acceptable at this
   scale; the blob convention is not yet earned. This means we can
   probe the *agent-honest output shape* question without first
   fighting the *bulk-data wire encoding* question.
3. **`solve`, not `eigvals`, is the right first tool.** Eigenvalue
   problems force iterative-method discipline (QR iteration,
   convergence criteria, complex output) before we have agreement on
   what an honest numerical record output even looks like. Solve is
   the smallest non-trivial linalg operation that yields all five
   forcing-questions below.

## The axiom

The same axiom ADR-0011 and ADR-0013 applied, with the lens shifted:
**what would a senior TS expert who has also written numerical code
want here?** And the parallel: **what makes this irresistible to an
agent's planner?**

The two principles align on:

1. **Honest, structured output, not just an answer.** A `solve` that
   returns just `x` is useless to a planner: it can't decide whether
   to retry. A `solve` that returns `{x, residual_norm,
   condition_estimate, growth_factor, method, iterations,
   warnings}` lets the planner reason — "the residual is large; let
   me try a different method" or "the condition is 1e15; tell the
   user this is ill-posed."
2. **Method is data.** The TS expert wants `--method=lu|qr` to be a
   typed flag (ADR-0011's `F.enum`). The agent wants the same — it's
   how planners reason about tool variation. v0.1 ships with one
   method (LU), and the flag exists so v0.2 can add QR without
   breaking the schema.
3. **Library-and-tool dual surface.** The TS expert wants `import
   { solve } from "@workbench/linalg-core"` to operate on
   `Float64Array` — no JSON traffic. The agent wants the wire
   encoding — that's how composition happens. ADR-0010 lets us serve
   both with one implementation.

They diverge on:

- **The TS expert wants typed arrays in the protocol.** The agent
  doesn't care; the agent wants type-routable composition by
  registry. **Resolution:** the wire encoding stays
  `list<list<float64>>` for v0.1; the in-process API operates on
  `Float64Array`. The blob-by-hash convention exists as a future
  extension when wire size demands it (bead `wmm`).

## Decision

### Package: `@workbench/linalg-core`

Pure TypeScript on `Float64Array`. Single platform target: Bun on
x86-64 Linux (the development platform). No FFI. No subprocess. No
blobs.

Public surface:

```ts
// Matrix is row-major; data.length === rows * cols
export type Matrix = { rows: number; cols: number; data: Float64Array };

// Constructors / accessors
export function matrixFromRows(rows: number[][]): Matrix;
export function matrixToRows(m: Matrix): number[][];
export function matZeros(rows: number, cols: number): Matrix;
export function matIdentity(n: number): Matrix;
export function get(m: Matrix, i: number, j: number): number;
export function set(m: Matrix, i: number, j: number, v: number): void;

// Vector / matrix ops
export function matVec(A: Matrix, x: Float64Array): Float64Array;
export function vecNorm2(v: Float64Array): number;
export function vecNormInf(v: Float64Array): number;
export function matNorm1(A: Matrix): number;

// LU with partial pivoting
export type LUResult = {
  // L is unit lower triangular, stored implicitly (1 on diagonal,
  // strict-lower in LU below diagonal); U is upper-triangular,
  // stored on/above diagonal in LU. Both packed into one matrix
  // for memory efficiency, the standard LAPACK-style packing.
  LU: Matrix;
  // P[i] is the row of original A that ended up at position i.
  P: Int32Array;
  // sign of the permutation: +1 (even number of swaps) or -1 (odd).
  signDet: 1 | -1;
  // max|U[i,j]| / max|A[i,j]| — Wilkinson's growth factor. Values
  // > 1e6 indicate a backward-instability risk and are surfaced as
  // warnings in the tool layer.
  growthFactor: number;
};
export function lu(A: Matrix): LUResult | null;  // null iff exactly singular

export function luSolve(lu: LUResult, b: Float64Array): Float64Array;

// High-level: A x = b with one step of iterative refinement.
export type SolveResult = {
  x: Float64Array;
  residualNorm: number;       // ||A x - b||_2 after refinement
  bNorm: number;              // ||b||_2
  conditionEstimate: number;  // 1-norm condition via Hager
  growthFactor: number;
  method: "lu-partial-pivot";
  iterations: number;         // refinement steps performed (0 or 1 in v0.1)
};
export function solve(A: Matrix, b: Float64Array): SolveResult | null;

// Hager 1-norm estimator for ||A^{-1}||_1, given precomputed LU.
// Returns an estimate of the 1-norm of A^{-1}; multiply by ||A||_1
// to get a 1-norm condition number estimate. Typically within 2× of
// the true value; uses ~4 LU-solves.
export function hagerOneNormEstimate(lu: LUResult): number;
```

Algorithms:

- **LU:** Doolittle (in-place packing) with partial pivoting. ~25
  LOC of inner loop. Tracks the growth factor for honest scope
  reporting.
- **Triangular solve:** straight back- and forward-substitution.
- **Iterative refinement:** one step. Compute residual `r = b - A
  x` in straight float64 (no extended precision in the substrate),
  solve `A d = r`, set `x ← x + d`. If `||r||/||b||` is already at
  machine epsilon, skip. Honest limitation: without higher-precision
  residuals, refinement helps modestly; for ill-conditioned problems
  the condition estimate is the load-bearing diagnostic, not the
  refined `x`.
- **Hager:** classical iterative 1-norm estimator. Algorithm 14.4 in
  Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.

### Tool: `tools/linalg-solve`

Schema:

```ts
input: S.record({
  A: S.list(S.list(S.kind("float64"))),
  b: S.list(S.kind("float64")),
})
output: S.record({
  x: S.list(S.kind("float64")),
  residual_norm: S.kind("float64"),
  b_norm: S.kind("float64"),
  condition_estimate: S.kind("float64"),
  growth_factor: S.kind("float64"),
  method: S.kind("string"),
  iterations: S.kind("integer"),
  warnings: S.list(S.kind("string")),
})
```

Boundary categories (ADR-0003):

- **Happy path:** A non-singular, b dimensions match → record above.
- **Routine non-success:** none in v0.1 (a successful LU always
  yields a record; condition / growth warnings are *fields* of the
  record, not a separate tag — the planner reads them).
- **Boundary failure (`tagged "linalg-solve/<class>"`):**
  - `linalg-solve/singular` if any pivot is exactly zero. Payload
    carries the row index where the pivot zeroed.
- **Malformed input (`ToolError`):**
  - A is not square (with dimension report)
  - dim(A) ≠ dim(b)
  - any entry is non-finite (NaN / ±Inf), with a path to the offender
  - n > 200 (the v0.1 cap, with a suggestion to file a follow-up
    bead and pointer to `wmm` for the blob-convention path)
  - n = 0 (empty matrix)

Method flag: `--method=lu` (currently the only choice; declared as
`F.enum(["lu"])` so v0.2's QR addition is non-breaking).

### Out of scope (v0.1, all deliberate)

- **Other decompositions** (QR, SVD, eigendecomposition) — bead 71f
- **Iterative methods** (CG, GMRES, BiCGStab) — separate beads when
  forced
- **Sparse matrices** — separate package + tier
- **Complex / `Complex64` arithmetic** — separate package
- **n > 200** — bead `wmm` (blob-by-hash) is the path
- **FFI to BLAS/LAPACK** — bead `e7y`
- **Cross-platform determinism guarantee** — ADR-0015 (bead `0ck`)
  drafted *after* this experiment runs

## Why these choices

### Pure TS over FFI / Julia

The forcing experiment must stand alone: no library version pin, no
subprocess startup cost, no licence-matrix question on the hot path.
A TS expert reading the source should see the algorithm; an agent
reading the tool's `--schema` should not need to know what's
underneath. Pure TS gets us all the way to the questions that
actually need answers. FFI is then earned by a future workload.

### Cap at n = 200

200×200 is large enough to be useful for: small ML problems, finite
elements on toy meshes, control-theoretic state-space models, OLS
regression with up to 200 features, calibration fits with up to 200
parameters. It is small enough that:

- Pure-TS LU runs in well under a second (~8M flops).
- Wire encoding is ~470 KB — fits in stdin without complaint.
- The cap surfaces as a `ToolError` with explicit pointer to the
  follow-up bead, so an agent that hits it knows where to look.

The cap is a *forcing function*: the next workload that wants 500×500
forces the blob-convention experiment to be earned, with concrete
evidence that the wire encoding hurts.

### LU + iterative refinement + Hager

The minimal surface that gives the planner enough state to decide
what to do. Cheaper than QR (no orthogonalisation cost, no R
extraction); honest about its instability mode (growth factor + Hager
condition); refinable to good accuracy on well-conditioned problems.
QR gets its own tool when the requirement is "I have a least-squares
problem" — different signature, different decomposition.

### One method, one flag

`--method=lu` is the only choice today. The flag exists because
ADR-0011's typed-flag discipline says it should: the v0.2 addition of
QR must be schema-additive, not schema-breaking. The flag's
`F.enum(["lu"])` reads correctly today (one choice, no ambiguity)
and extends naturally.

### Cap test, not "best effort" on n > 200

A tool that silently slows to minutes on n = 1000 is the kind of
honest-scope violation Rule 8 names. Refusing with a `ToolError`
that points to the follow-up bead is the right behaviour. The
`suggestion` field carries the operational path forward.

## What we will *not* decide here

ADR-0015 (the determinism-tier ADR, bead `0ck`) is the natural
companion to this work but **must not be drafted speculatively**. It
needs the data this experiment produces:

- Does Bun-on-Linux-x86-64 produce bit-identical LU factorisations
  across patch versions? (Almost certainly yes for the inner loop;
  the question is `Math.sqrt` for `vecNorm2` and similar.)
- What's the natural fingerprint format for the per-platform
  determinism tier? (Probably `{platform: 'linux-x86_64',
  bun_version: '1.3.x', tool_version: '0.1.0'}` in the provenance
  record, but committing now is premature.)
- Does the property test for "same input, same output, this run vs
  the next" pass on a corpus of 100 random matrices? If not, *which
  ones diverge* is the input to the ADR.

These data points come from running this ADR's deliverable, not from
guessing.

## Forcing-questions this experiment surfaces

Documented up front so a future reader can check whether each was
actually answered:

1. **Single-platform float bit-stability across Bun/V8 versions.**
   Test: run the property suite on two Bun minor versions; record
   whether outputs match byte-for-byte. The answer goes in worklog
   031.
2. **The shape of agent-honest numerical output.** Does the
   `record{x, residual_norm, condition_estimate, growth_factor,
   method, iterations, warnings}` shape survive use? Does anyone
   compose it with another tool and find it lacking? (We'll find
   out by writing the goldens and seeing which fields are
   unexpectedly absent.)
3. **Library-and-tool duality in numerical context.** Can the same
   `solve` body serve `import { solve } from "@workbench/linalg-core"`
   *and* `bun tools/linalg-solve/tool.ts` without divergence? ADR-0010
   says yes; this is the first non-symbolic test of it.
4. **Mutation-proving for numerics.** Skip-pivoting on `[[0,1],[1,0]]
   x = [1,1]` gives a divide-by-zero; skip-refinement on a
   well-conditioned problem leaves residual at ~1e-12 instead of
   ~1e-15; perturbing the back-sub bounds gives wrong `x`. All three
   are mutations the property test should catch.
5. **The 5.9× JSON inflation at n = 200.** Wire-time vs LU-time
   ratio. If JSON parse time dominates, the blob convention is
   already earned; if not, it's still deferred.

## References

- Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.,
  SIAM 2002 — Chapter 9 (LU factorisation), Algorithm 14.4 (Hager).
- Trefethen & Bau, *Numerical Linear Algebra*, SIAM 1997 — Lectures
  20–22 (Gaussian elimination, partial pivoting, stability).
- `docs/numerics-and-vis-2026-04-29.md` — the precursor research note.
- ADR-0010 — `defineTool`/`runTool` split (the dual-surface enabler).
- ADR-0003 — output / error categories (applied here in numerical form).
- ADR-0011 — typed flag declarations (`F.enum(["lu"])` discipline).
