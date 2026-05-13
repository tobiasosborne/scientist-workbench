# ADR-0035 — Complex-Hermitian linalg tier: wire shape, tool surface, substrate

**Status:** Accepted, no code yet.
**Date:** 2026-05-13.
**Beads:** epic `ov4j` (named blocker for qinfo v0.2 trace-norm / fidelity /
trace-distance); this ADR is `q4f9`; downstream sub-beads
`linalg-eigh-complex` / `linalg-svd-complex` / `linalg-solve-complex` to be
filed when this ADR lands. Closes the "Decision in an ADR before
implementation" open point in `ov4j`.
**Authors:** tobiasosborne + Claude Opus 4.7 (1M context).
**Related:** ADR-0014 (first numerical tier — establishes the dual-surface
`@workbench/linalg-core` discipline this ADR extends); ADR-0015 (numerical
determinism tier — the `numerical: true` annotation that complex-linalg
inherits); ADR-0034 (qinfo substrate — establishes the
`{rows, cols, re, im?}` matrix shape this ADR canonicalises in linalg-
core); ADR-0027 (the meijer-g dispatcher's `meijer-g-*` fan-out naming
pattern the tool surface here mirrors).

## Context

The qinfo v0.1 substrate shipped 2026-05-12 (ADR-0034) with a deliberate
hole: `traceNorm`, `traceDistance`, `fidelity`, `purity` are filed and
queued under beads `korg` / `k2xo` / `2hxf` / `2czd`, all blocked by the
`ov4j` epic. The friction is concrete and observable: the
`temp/qwasserstein.ts` DMTL21 Wasserstein-1 dogfood (2026-05-10) restricted
**every** `n=1` example to the real Bloch X–Z plane *specifically to dodge
the absence of complex-Hermitian eigendecomposition*. Any quantum-
information workflow that touches an imaginary-phase coherence collides
with the same boundary on contact — and "real Bloch slice only" is not an
honest scope for a substrate the workbench is going to claim ships
quantum information.

`@workbench/linalg-core` is the right home for the spectral algorithms:
ADR-0014 established it as the pure-TS dense linalg substrate, and the
existing real-`Matrix` / `eigh` / `svd` / `solve` quartet is the shape any
TS expert reaches for. `@workbench/qinfo` already carries a complex
`Matrix` shape (`{rows, cols, re: Float64Array, im?: Float64Array}`, per
ADR-0034 D2) for its index-only operations (`kron`, `partialTrace`,
`partialTranspose`, `vec` / `unvec` / `choi`). What's missing is **the
spectral piece** — the algorithm that diagonalises a complex Hermitian
matrix — which qinfo deliberately did not ship because it's a linalg
question, not an index question.

The `ov4j` bead listed three options for the tool surface and recommended
(b), but explicitly held that the decision lived in an ADR. This ADR is
that decision, plus a second decision the bead implicitly conflated with
it — *where the substrate type lives* — disentangled and made explicit.

## The axiom (re-applied)

ADR-0034 D4 named the relevant slice: **complex from day 1 on operations
that admit it**. ADR-0014's axiom was sharpened as: **what would a senior
TS expert who has also written numerical code want here?** Both apply
here, and they agree:

1. **`linalg-eigh-complex(H)` is what the TS expert types.** Not
   `linalg-eigh(realSymplecticEmbed(H))`; not `wb.complex.eigh(H)`; not
   `linalg-eigh(H, { complex: true })`. The parallel-tool surface
   mirrors the existing `meijer-g-*` fan-out the workbench already
   trains agents on — `meijer-g-symbolic-only`, `meijer-g-asymptotic-
   only`. The TS expert who has used those reaches for the `-complex`
   suffix without thinking.

2. **A complex matrix carries `re` and `im` as a single value.** Not
   two separate input fields the caller must keep aligned. Not a
   conjugate-pair trick. The qinfo substrate established
   `record{re, im}` (ADR-0034 D2); the wire form here mirrors it
   one-for-one. A TS expert who has read `tools/partial-trace/` or
   `tools/choi-iso/` finds the same shape.

3. **A `ComplexMatrix` type belongs in linalg-core**, structurally
   equivalent to qinfo's `Matrix`-with-im, but distinguished at the type
   level so "this value is definitely complex" reads from the signature.
   The TS expert who imports `eighComplex` from `@workbench/linalg-core`
   expects to hand it a `ComplexMatrix`, not a `Matrix | (Matrix & {
   im: Float64Array })` union with an `if (M.im)` branch one level down.
   This is the lesson ADR-0014 already encoded for the real case:
   `Matrix` is a single shape with no optionality, and every algorithm
   trusts it.

## Decision

Eight decisions. Each is additive (no existing tool, package, or wire
record is touched).

### D1 — Tool surface: parallel `*-complex` tools (option b)

Three tools, one per existing real-linalg tool:

```
tools/linalg-eigh-complex      pairs with tools/linalg-eigh
tools/linalg-svd-complex       pairs with tools/linalg-svd
tools/linalg-solve-complex     pairs with tools/linalg-solve
```

Naming mirrors `meijer-g-symbolic-only` / `meijer-g-asymptotic-only` —
the `-<qualifier>` suffix that's already in the registry catalog. Each
new tool is independent of the real one (no shared schema, no shared
output kind, no shared boundary tags); they're siblings, not children.

**Rejected (option a — extend existing tools with optional `{re, im}`
input):** doubles every existing tool's refusal surface; output shape
becomes input-conditional; existing callers' goldens shift to accommodate
the new schema even when they're emitting real-only output. Schema-
additive in principle, but not value-additive — the wire output bytes for
the real path change. A bright-line separation of real and complex tools
keeps the existing 350+ goldens byte-identical and the existing
`linalg-eigh` schema closed-record-closed.

**Rejected (option c — bridge `@workbench/complex-linalg` package, no new
tools):** invisible to `registry-search`. An agent's planner that filters
`output_kind=record` looking for a Hermitian eigensolver finds
`linalg-eigh` (real-only) and nothing else; the complex sibling exists
but is reachable only through a hand-written orchestration. This
violates PRD §6.3's "plan a composition by type, not by name." The
parallel-tools shape is what gives the planner the equivalent of an
explicit type signature.

The downstream consequence: three new rows in the README's tool catalog,
three new typed-barrel methods (`wb.linalgEighComplex`,
`wb.linalgSvdComplex`, `wb.linalgSolveComplex`), three new beads filed
under `ov4j`. The growth is linear in the underlying real surface.

### D2 — Wire shape: `record{re, im}`, both required, shape-matched

The canonical wire shape for a complex matrix is:

```ts
S.record({
  re: S.list(S.list(S.kind("float64"))),   // real part, m × n
  im: S.list(S.list(S.kind("float64"))),   // imaginary part, m × n
})
```

Both fields **required**. Both rectangular. Same row count, same column
count. Decode-time validation throws `ToolError` on shape mismatch
between `re` and `im`; this is *malformed* input, not a boundary
condition.

**Why `im` is required, not optional.** The qinfo substrate (ADR-0034
D2) makes `im` optional because qinfo's `Matrix` is the union of "real"
and "complex" — a real matrix has `im === undefined`, and the runtime
branch on `if (M.im)` is the discriminant. The wire shape is the
opposite design: the `-complex` tools are *the* complex tools; their
input type is "complex matrix"; a complex matrix has both parts, and an
all-zero imaginary part is explicit, not implicit. A user who hands in
a Hermitian matrix they know to be real *must still pass `im: [[0]]`* —
which is the right discipline. The tool now cannot be tricked into
silently running the real eigh path on caller input that *looks*
complex; the surface is type-honest.

For the qinfo Matrix interchange, the bridge helper
`complexFromQinfo(M: qinfo.Matrix): ComplexMatrix` zeros-out the
imaginary part when `M.im === undefined` — explicit conversion at the
boundary.

**Why `record{re, im}` and not `list<list<record{re, im}>>` per-cell.**
Per-cell complex would multiply the wire byte count by ~3-4×
(per-cell record overhead dominates the float64 payload), and would
violate the principle that *bulk numeric data should travel as `list<…>`
of single-kind leaves, not as nested records*. The parallel-array shape
matches every BLAS / LAPACK / NumPy / SciPy wire convention; an agent
who has shipped complex matrices through any of those reaches for
`{re, im}` reflexively. PRD §0.1's "no raw JSON numbers" is satisfied
by the `float64` kind at the leaves.

**Why required-`im` does not break the foreign-pass-through invariant.**
The complex tools don't *consume* arbitrary qinfo-shaped values from
other tools; they consume their own declared schema. The qinfo tools
emit real `list<list<float64>>` for now (per ADR-0034's "wire stays
real at v0.1"). When the qinfo tools grow complex output (a separate
ADR), their wire shape will match this one — `record{re, im}` — so the
pipe `tool-A | linalg-eigh-complex` works without translation.

### D3 — Determinism tier: `numerical: true`, eigenvalues real

`numerical: true` (ADR-0015). The platform fingerprint is recorded in
the provenance record on every successful run, exactly as for real
`linalg-eigh`. The complex algorithm composes real Jacobi rotations
(D5) so the cross-Bun stability question that ADR-0015 already measured
for `linalg-solve` is the same question and gets the same answer.

A Hermitian matrix has **real eigenvalues** by spectral theorem. The
output schema reflects this honestly:

```ts
{
  Q,                       // complex n × n unitary, record{re, im}
  eigenvalues,             // real, sorted ascending — list<float64>
  reconstruction_error,    // ||H·Q − Q·diag(λ)||_F / max(||H||_F, 1)
  orthogonality_error,     // ||Q† Q − I_n||_F
  condition_number,        // |λ_max| / max(|λ_min|, EPS · |λ_max|)
  method,                  // "real-symplectic-embedding" in v0.1
  warnings,
}
```

Emitting `eigenvalues` as `list<{re, im}>` of always-zero-imaginary
values would lie about what Hermitian eigendecomposition produces. Real
eigenvalues are real, full stop. (The non-Hermitian generic complex
eigenproblem `linalg-eig`, bead `evh`, *is* the tool where complex
eigenvalues live; it is explicitly out of scope here.)

### D4 — Substrate location: `ComplexMatrix` in linalg-core

A new type colocated with the existing real `Matrix` in
`@workbench/linalg-core`:

```ts
// packages/linalg-core/src/complex-matrix.ts
export type ComplexMatrix = {
  readonly rows: number;
  readonly cols: number;
  readonly re: Float64Array;   // length rows*cols
  readonly im: Float64Array;   // length rows*cols, never undefined
};
```

Structurally identical to qinfo's `Matrix`-with-im, with one type-level
distinction: `im` is **required**, not optional. This is the same
discipline as D2's wire shape — a `ComplexMatrix` is *definitely
complex*, and downstream algorithms never branch on `if (M.im)`. A real
matrix in linalg-core is a `Matrix` (different type); a complex matrix
is a `ComplexMatrix`. The two type-disjoint paths converge at the bridge
helpers:

```ts
export function complexFromReal(M: Matrix): ComplexMatrix;
export function complexFromQinfo(M: QinfoMatrix): ComplexMatrix;  // zero im if absent
export function realPartOnly(M: ComplexMatrix): Matrix;           // im discarded
```

**Rejected (extend existing `Matrix` to `{data: Float64Array, im?:
Float64Array}`):** changes every existing field name (`.data` is the
established field; renaming to `.re` for symmetry with qinfo would
ripple through every linalg-core call site and every dependent tool).
The rename is a worthwhile cleanup but it's a separate ADR, not a
prerequisite for shipping complex linalg.

**Rejected (use qinfo's `Matrix` directly with optional `im`):** loses
the "this is definitely complex" type discipline; every complex
algorithm has to branch `if (M.im)` at the top, defeating the point of
a type-distinguished surface. qinfo's optionality is the right shape
for qinfo's index-only ops (which transparently handle both); it is
the wrong shape for an algorithm that *requires* a complex argument.

**Rejected (new package `@workbench/linalg-complex`):** inflates the
dependency graph for what is structurally the same package's concerns.
The real `Matrix` and the complex `ComplexMatrix` should live next to
each other; the eigh and eighComplex algorithms should be siblings in
the same `packages/linalg-core/src/` directory. A future ADR may
split linalg-core if it grows too large, but that's the consequence of
later weight, not a prerequisite for this work.

Public surface added to `@workbench/linalg-core/index.ts`:

```ts
export {
  type ComplexMatrix,
  complexFromReal,
  complexFromQinfo,
  realPartOnly,
  complexAdjoint,
  complexFrobeniusNorm,
} from "./complex-matrix.js";
export { type EighComplexResult, eighComplex } from "./eigh-complex.js";
```

The phase-2 / phase-3 exports (`svdComplex`, `solveComplex`) land
additively when those tools ship.

### D5 — Algorithm v0.1: real-symplectic embedding

For a Hermitian `H = A + iB` with `A` real-symmetric and `B` real-
antisymmetric, the **real-symplectic embedding** (Goedecker 1999;
Day & Heroux 2001):

```
H = A + iB     ⇒     H̃ = ⎡  A   -B ⎤   (size 2n × 2n)
                          ⎣  B    A ⎦
```

`H̃` is real-symmetric (`A = Aᵀ` and `-B = (-B)ᵀ` because `B = -Bᵀ`).
Its eigenvalues come in **identical pairs** `{λ_1, λ_1, λ_2, λ_2, …, λ_n,
λ_n}`, each pair being one eigenvalue of `H`. For every eigenvalue `λ_k`
with eigenvector `H̃ · v_k = λ_k · v_k`, the 2n-vector `v_k = (u_k, w_k)`
lifts to a complex eigenvector `q_k = u_k + i · w_k` of `H` of
length n. The lifted `q_k` is `H`-eigenvector iff `(u_k, w_k)` and
`(-w_k, u_k)` are an orthogonal pair in the doubled eigenspace, which
is automatic from the embedding structure.

We run the existing real cyclic-Jacobi `eigh` (worklog 047) on `H̃`,
dedupe the paired eigenvalues, and lift the eigenvectors. The complete
algorithm reuses every line of `packages/linalg-core/src/eigh.ts` —
zero new spectral code. The complex-linalg-core file is a ~120-LOC
wrapper:

  1. Build `H̃` from `(re, im)` (Hermiticity check on input;
     antisymmetry of `im` is the Hermitian condition's imaginary half).
  2. Call existing `eigh(H̃)`.
  3. Walk the sorted real eigenvalues, taking every other one (the
     pairs are adjacent after sort).
  4. Pair up the corresponding eigenvector columns of `H̃`; for each
     pair `(v_a, v_b)`, the eigenvectors of `H` are
     `(u_a + i · w_a)` and `(u_b + i · w_b)` where `(u, w)` is the
     top-half / bottom-half split. Normalise each as a complex vector
     (`Σ_i |q_k[i]|² = 1`).
  5. Compute reconstruction and orthogonality errors on the
     **complex** matrices `H` and `Q` directly — same formulas, with
     complex arithmetic.

**Cost.** 2n × 2n real eigh costs ~8× a native n × n complex Jacobi
in terms of flops (`(2n)³ = 8n³` vs `n³` complex = `4n³` real). Memory
is 4× the input. For the qinfo dogfood scale (`n ≤ 8` qubits, dense
`d × d` with `d ≤ 256`), the embedding cost is invisible — under 1 s
at n=128, well under our `assessNumericalScale` warning floor. Real
density operators (`im === 0` after the Hermiticity-check transform)
short-circuit through real `eigh` directly, with `im` zeros on `Q`'s
output — the cheap path.

**Native complex Householder + complex QR iteration: deferred.** When
a workload actually hurts (`n > 1000` dense, or hot-loop inner-kernel
use), the ~4× constant-factor win from a native complex implementation
is worth the ~600 LOC of complex-rotation code. v0.2 work, filed as a
follow-up bead. v0.1 ships the embedding.

**Cross-platform determinism inherits exactly.** The doubled real
matrix is built by deterministic field arithmetic; the embedded eigh
inherits ADR-0015's per-platform fingerprint; the lift step is index
arithmetic and one division per column. No new sources of float
nondeterminism are introduced.

### D6 — Hermiticity check + boundary categories

Hermitian: `H[i,j] = conj(H[j,i])`. In `(re, im)` form:

- `re[i,j] = re[j,i]` (real-symmetric)
- `im[i,j] = -im[j,i]` (imaginary-antisymmetric)
- Diagonal must satisfy `im[i,i] = 0` (a direct consequence of the
  antisymmetry: `im[i,i] = -im[i,i]` ⇒ `im[i,i] = 0`).

Tolerance: `max(|H − H†|) > 100 · EPS · max(|H|)`, exactly the
`SYMMETRY_TOL_FACTOR` from real `linalg-eigh`. The boundary tag is
`linalg-eigh-complex/non-hermitian-input` with payload identifying the
worst-violating coordinate.

Boundary categories (ADR-0003), parallel to `linalg-eigh`:

| tag | trigger |
|---|---|
| `linalg-eigh-complex/non-hermitian-input` | `max\|H − H†\| > 100·EPS·max\|H\|` |
| `linalg-eigh-complex/non-finite-input` | NaN / ±Inf in `re` or `im` |
| `linalg-eigh-complex/degenerate-shape` | `n = 0` |

`ToolError` (exit 1) for malformed:

- `re` and `im` have different `rows × cols`
- `re` (or `im`) non-square (`m ≠ n`) — Hermitian eigh is undefined on
  non-square; suggestion: route to `linalg-svd-complex` when shipped
- ragged rows in `re` or `im`
- OOM on the 2n × 2n embedded buffer (re-thrown with attempted bytes,
  same pattern as real `linalg-eigh`)

The shape-mismatch case (re and im rectangular but disagreeing in
dimensions) is *malformed*, not a boundary tag, because the caller's
input does not represent any well-formed matrix at all — there's
nothing for the tool to operate on.

### D7 — Output shape: parallel-but-distinct from real eigh

```ts
output: S.record({
  Q: S.record({                                  // complex n × n unitary
    re: S.list(S.list(S.kind("float64"))),
    im: S.list(S.list(S.kind("float64"))),
  }),
  eigenvalues: S.list(S.kind("float64")),        // real, ascending
  reconstruction_error: S.kind("float64"),
  orthogonality_error: S.kind("float64"),
  condition_number: S.kind("float64"),
  method: S.kind("string"),                      // "real-symplectic-embedding"
  warnings: S.list(S.kind("string")),
})
```

Schema parallel to `linalg-eigh`'s output (worklog 047), with three
deltas:

1. `Q` is now `record{re, im}` instead of `list<list<float64>>`.
2. `eigenvalues` stays `list<float64>` (Hermitian eigenvalues are real).
3. `method` is `"real-symplectic-embedding"` (v0.1); when the native
   complex path ships, this becomes `F.enum(["real-symplectic-embedding",
   "complex-jacobi"])` schema-additively.

Reconstruction and orthogonality errors are the agent-honest self-
report (ADR-0014 pattern):

- `reconstruction_error = ||H·Q − Q·diag(λ)||_F / max(||H||_F, 1)`
  where the matrix product `H·Q` is complex (uses the
  `(a+ib)(c+id) = (ac−bd) + i(ad+bc)` rule per inner-loop element).
- `orthogonality_error = ||Q† Q − I_n||_F` where `Q†` is the conjugate
  transpose (complex), and the Frobenius norm uses `|z|² = re² + im²`
  per element.

A bench-side verifier `verify.py` recomputes both against NumPy
`np.linalg.eigh(H)` and rejects on disagreement > 1e-6 relative —
mirroring the real-eigh bench. Implementation lands with the tool
(out of this ADR).

### D8 — Phase order

Three deliverables, each independently shippable:

1. **`linalg-eigh-complex`** (bead to be filed). Unblocks `korg`
   (trace-norm), `k2xo` (trace-distance), `2hxf` (fidelity), `2czd`
   (purity). The phase-1 deliverable; the dogfood-named target.
2. **`linalg-svd-complex`** (bead to be filed). For non-Hermitian or
   non-square complex matrices. Uses the same wire shape (D2),
   substrate type (D4), and tier (D3); algorithm is the complex
   one-sided Jacobi SVD (Forsythe-Henrici 1960 → Brent-Luk 1985 →
   Hari-Veselić 1987). Not via the symplectic embedding (which buys
   nothing for SVD). Out of scope for v0.1 of this tier; filed under
   `ov4j`.
3. **`linalg-solve-complex`** (bead to be filed). Complex LU with
   partial pivoting + iterative refinement; complex Hager 1-norm
   condition estimator (Higham 1988). Algorithmically straightforward
   port of real `linalg-solve`. Phase-3.

Each tool's full seven-artefact contract holds: schema, ≥30 examples
covering each branch, invariants, property tests, goldens, README.
Each tool's bench corpus mirrors its real-only sibling's (the
existing `bench/linalg-eigh/`, `bench/linalg-svd/`, `bench/linalg-
solve/` get `-complex` siblings in the corpus repo per ADR-0028;
that's out of scope for this ADR but the corpus epic should track it).

## Consequences

### What stays

- The seven-artefact contract for tools (PRD §4.2).
- The wire value protocol (ADR-0004) — `record{re, im}` is composed
  of `list<list<float64>>`, fully canonical.
- The existing real `linalg-eigh` / `linalg-svd` / `linalg-solve` schemas
  byte-for-byte. Existing goldens unchanged.
- The qinfo `Matrix` type — unchanged, optional `im`, used by the
  index-only ops.
- The `numerical: true` determinism tier (ADR-0015) and its platform-
  fingerprint mechanism, including `runMemoized`'s skip path.

### What changes

- `@workbench/linalg-core` gains `ComplexMatrix`, three bridge helpers,
  and three new algorithm exports (one per tool, phased).
- Three new tool directories under `tools/`. Three rows in the README
  catalog table. Three new typed-barrel methods in
  `@workbench/compose`.
- The qinfo v0.2 surface (`trace-norm`, `trace-distance`, `fidelity`,
  `purity`) becomes reachable as soon as phase 1 lands.
- One new pair of ground-truth references in the README's "Hard
  requirements": complex-matrix wire shape, Hermiticity boundary tag.

### Frictions surfaced (predicted; will revisit in worklog post-ship)

- **`ComplexMatrix` vs qinfo's `Matrix`-with-im — two structurally
  near-identical types.** The bridge helpers (`complexFromQinfo`,
  `complexFromReal`, `realPartOnly`) are the explicit conversion
  points. The TS reader who finds both types asks "why two?" — the
  answer is the optional-vs-required `im` discipline (D4), and the
  README + ADR cross-reference this explicitly. A future unification
  is possible if the duplication grates; not load-bearing for the
  ADR's scope.
- **Schema-validation walks `record{re, im}` instead of an opaque
  blob.** A 200 × 200 complex matrix is two 200 × 200 nested
  `list<list<float64>>` values on the wire, ~1.5 MB of JSON
  (~3× the real-only case). The blob-by-hash convention (bead `wmm`)
  is the right v0.2 path when n > ~500 actually hurts; the wire
  shape stays additive when blobs land.
- **The bench's NumPy oracle for complex eigh.** `np.linalg.eigh` accepts
  complex Hermitian input directly and returns real eigenvalues +
  complex eigenvectors. The verifier follows the real-eigh pattern
  literally with complex matrices substituted at each line. No new
  oracle infrastructure.
- **`condition_number` for complex Hermitian: still on `|λ|`.** The
  spectral condition is `|λ_max| / |λ_min|`. Same formula as the real
  case; complex eigenvectors don't change it. No surprises.
- **`-0` in `Q.im` for real-density-operator input.** When `im = 0`
  exactly, the algorithm short-circuits to real eigh and emits
  `Q.im = zeros(n, n)`. This is the right behaviour (the output is
  genuinely real-valued, embedded in the complex output type as
  zero-im). Test goldens use `maxAbsDiff` rather than literal `===`
  for the same reason ADR-0034 §Frictions documented.

### Future work

- **Native complex Householder tridiag + complex implicit-shift QR.**
  When a workload at n ≥ 1000 actually justifies the constant-factor
  win over the symplectic embedding. v0.2 follow-up under `ov4j`.
- **`linalg-eig` (non-Hermitian complex)**, bead `evh`. Different
  surface — eigenvalues are complex; eigenvectors may not span; Schur
  form is the natural intermediate. Out of scope here.
- **Generalised Hermitian-definite eigh `H·x = λ·B·x`**, bead `geh`.
  A complex generalisation lands later under that bead.
- **`linalg-cholesky-complex`** for PSD complex Hermitian. Not
  filed; defer until the qinfo PSD-projection workflow asks for it.
- **Complex-output qinfo tools.** When `tensor-product` / `partial-
  trace` / `partial-transpose` / `choi-iso` grow `record{re, im}`
  wire output (separate ADR), they will compose cleanly with the
  `-complex` tools here — no schema bridging.
- **Eventual `linalg-core` Matrix unification.** If the parallel
  real / complex types in `linalg-core` and the optional-im `Matrix`
  in qinfo accumulate enough friction, a unifying ADR can consolidate.
  Wait for the friction.

### Migration

- **No existing tool migrates.** The three `-complex` tools ship as
  net-new files alongside their real siblings. The qinfo v0.1 tools
  are unaffected — their wire shape stays real-only per ADR-0034.
- **The qinfo v0.2 follow-up tools (`trace-norm`, `trace-distance`,
  `fidelity`, `purity`) follow ADR-0034's filed shape** with the
  difference that their `linalg-eigh` dependency now points to the
  complex tool when the input is complex; the dispatch is one
  `if (M.im)` at the qinfo tool's top.
- **`@workbench/compose` typed-barrel** regenerates additively via
  `scripts/gen-workbench-barrel.ts` (the same step every new tool
  triggers).
- **The CLAUDE.md hallucination-risk callout list** picks up one new
  entry: *complex matrices on the wire are `record{re, im}` with `im`
  required, not optional and not per-cell; the optional-`im` shape is
  qinfo's substrate `Matrix`, used inside the package, not on the
  wire.*

## Acceptance

- This document exists with Status=Accepted.
- One paragraph in `README.md` between "The value protocol" and
  "Tool invocation" introduces the `record{re, im}` complex-matrix
  wire shape and references this ADR. (Law 2 lockstep.)
- `CLAUDE.md` "Hallucination-risk callouts" gains the complex-matrix
  wire-shape callout.
- `ov4j` epic description references this ADR as the resolution of
  its "Decision in an ADR before implementation" open point.
- Three downstream beads filed under `ov4j` (`linalg-eigh-complex`,
  `linalg-svd-complex`, `linalg-solve-complex`); `korg` (trace-norm)
  retains its dependency on the qinfo substrate and gains a
  dependency on `linalg-eigh-complex` via this ADR.
- A worklog shard (100, `complex-linalg-tier-adr`) documents the
  iteration, the design choices, and the deferred work.

## Pointers

- ADR-0014 — first numerical tier, the `linalg-core` substrate this
  ADR extends.
- ADR-0015 — numerical determinism tier; `numerical: true` is inherited.
- ADR-0034 — qinfo substrate; complex `Matrix` precedent, the `re`/`im`
  shape vocabulary, the `ov4j` open point this ADR closes.
- ADR-0027 — meijer-g dispatcher; `meijer-g-*` fan-out naming
  precedent for the `*-complex` siblings.
- Bead `ov4j` (epic, parent), `q4f9` (this ADR's write task), `korg` /
  `k2xo` / `2hxf` / `2czd` (qinfo v0.2 tools unblocked by phase 1),
  `evh` (non-Hermitian complex eig, out of scope), `geh` (generalised
  Hermitian eigh, out of scope), `wmm` (blob-by-hash wire convention,
  v0.2 wire-size escape hatch).
- Goedecker, *Linear scaling electronic structure methods*, Rev. Mod.
  Phys. 71:1085-1123, 1999 — the embedding identity in §III.A.
- Day & Heroux, "Solving complex-valued linear systems via equivalent
  real formulations", SIAM J. Sci. Comput. 23(2):480-498, 2001 —
  the embedding's stability properties.
- Demmel & Veselić, *Jacobi's method is more accurate than QR*, SIAM
  J. Matrix Anal. Appl. 13(4):1204-1245, 1992 — the relative-accuracy
  property the embedded eigh inherits.
- Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.,
  SIAM 2002 — §10 (complex matrices), §20.6 (symmetric-eigenproblem
  backward stability).
- Watrous, *Theory of Quantum Information*, Cambridge 2018 — §1.1 for
  the Hermitian-eigendecomposition role in quantum information; the
  upstream motivation for the qinfo v0.2 surface.
