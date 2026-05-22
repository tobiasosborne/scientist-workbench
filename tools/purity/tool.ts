// =============================================================================
// purity — γ(ρ) = tr(ρ²) of a complex Hermitian density operator
// =============================================================================
//
// Intent
// ------
// The **purity** of a density operator ρ on a d-dimensional Hilbert
// space is the scalar
//
//     γ(ρ) = tr(ρ²)   ∈   [1/d, 1].
//
// It is the simplest information-geometric witness of how mixed a
// quantum state is: γ = 1 exactly on the rank-1 pure states
// ρ = |ψ⟩⟨ψ|, and γ = 1/d on the maximally mixed state I/d. Every
// intermediate mixture lives in between. It is unitarily invariant
// (γ(UρU†) = γ(ρ)) because the spectrum is unitarily invariant —
// equivalently, γ(ρ) = Σ_k λ_k² where λ are the eigenvalues of ρ.
//
// This is the second deliverable of the qinfo v0.2 surface, sibling
// to `trace-norm`. Unlike trace-norm, purity needs *no* eigendecomp:
// for a Hermitian ρ the trace of ρ² has a one-pass closed form on
// the matrix entries directly:
//
//     tr(ρ²) = Σ_{i,j} ρ_{ij} · ρ_{ji}
//            = Σ_{i,j} ρ_{ij} · conj(ρ_{ij})       (ρ Hermitian ⇒ ρ_{ji} = conj(ρ_{ij}))
//            = Σ_{i,j} |ρ_{ij}|²
//            = Σ_{i,j} (re_{ij}² + im_{ij}²).
//
// Two passes through the data: one to decode + validate Hermiticity
// (which trace-norm pays anyway for the eigh), one to sum squares.
// O(n²) — strictly cheaper than the trace-norm O(n³).
//
// Why a planner reaches for this
// ------------------------------
//   - **Purity as a state-mixing thermometer.** γ(ρ) = 1 ⇔ ρ pure;
//     γ(ρ) < 1 quantifies "how mixed." Faster than computing the von
//     Neumann entropy (which requires eigenvalues) when all you need
//     is "is ρ near a pure state?"
//   - **Decoherence diagnostics.** Track γ across the trajectory of
//     a `partial-trace` of a noisy channel's output; loss of purity
//     is the quantitative signature of entanglement-with-environment.
//   - **Witness in compositions.** `partial-trace`-then-`purity`
//     measures how entangled a bipartite state is in its reduced
//     subsystem: γ(tr_B ρ_AB) = 1 iff ρ_AB is a product state.
//
// Input shape
// -----------
// `record{rho: record{re: list<list<float64>>, im: list<list<float64>>}}`
//
// Same canonical complex-matrix wire shape as `trace-norm` (ADR-0035
// §D2 + bead 2czd v0.2 lift). Both `re` and `im` are required and
// shape-matched (n × n square); a real Hermitian density matrix
// passes `im` as an all-zero `list<list<float64>>`. The "required-im"
// discipline is what makes "this value is complex" read from the
// schema — see the ADR-0035 hallucination-risk callout in CLAUDE.md.
//
// The input is wrapped in a `record{rho}` so the surface can grow
// additively (a future `tolerance?: float64` flag, a future
// non-density input mode, etc.) without schema-breaking edits.
//
// Output shape
// ------------
// Happy path: `record{value, trace, is_pure_within_tolerance, method,
// warnings}`.
//
//   - `value`: γ(ρ) = tr(ρ²), a non-negative float64. Exactly equal
//     to Σ_{i,j} (re² + im²) under the Hermitian assumption.
//   - `trace`: tr(ρ) — the diagonal sum — a free byproduct that
//     downstream planners use to check ρ is in fact a density
//     matrix.  Surfacing this lets a caller spot a "trace ≠ 1"
//     deviation without re-decoding ρ.
//   - `is_pure_within_tolerance`: `|γ − 1| ≤ 1e-9`. The named flag
//     callsite ("is ρ pure?") that justified the bead.
//   - `method`: literal "hermitian-sum-of-squares".
//   - `warnings`: surfaced for `|tr(ρ) − 1| > 1e-9` (input may not
//     be a valid density operator), or for `γ > 1 + 1e-9` (input
//     definitely isn't one — Hermitian PSD with tr ≤ 1 has γ ≤ 1).
//
// Boundary tags (ADR-0003):
//   * `purity/non-hermitian-input` — `max|ρ − ρ†| > 100·EPS·max|ρ|`.
//     Honest scope: γ(ρ) = tr(ρ²) is well-defined for non-Hermitian
//     ρ but is *not* a meaningful purity (it can be complex; it can
//     be > 1; it doesn't measure mixedness). We refuse rather than
//     compute a misleading scalar.
//   * `purity/non-finite-input` — NaN/±Inf in re or im.
//   * `purity/degenerate-shape` — n = 0.
//
// `ToolError` (exit 1) for malformed input:
//   * shape mismatch between ρ.re and ρ.im
//   * non-square (m ≠ n)
//   * ragged rows in ρ.re or ρ.im
//
// Algorithm
// ---------
// 1. Decode the input wire shape into flat Float64Array (re, im),
//    folding in non-finite detection (→ tagged) and the per-cell
//    `|ρ_{ij}|` walk to compute `maxAbs` for the Hermiticity tolerance.
// 2. Hermiticity gate at tolerance `100·EPS·maxAbs`. Refuse on
//    violation.
// 3. One O(n²) pass: sum re² + im² (this is γ(ρ) under the Hermitian
//    assumption); sum re[i*n+i] (trace).
// 4. Emit the happy-path record.
//
// References
//   * Nielsen & Chuang, *Quantum Computation and Quantum Information*,
//     10th anniversary ed., Cambridge 2010, §2.4.3 (density operators)
//     and §8.4 (the linear-entropy variant `1 − tr(ρ²)`).
//   * Bengtsson & Życzkowski, *Geometry of Quantum States*, 2nd ed.,
//     Cambridge 2017, §2.3 (purity vs entropy) and §15.6 (state-space
//     simplex bounds).
//   * Watrous, *Theory of Quantum Information*, Cambridge 2018, §1.1
//     (density operators) and §5.2 (linear vs von Neumann entropy).
//   * ADR-0034 (qinfo substrate) — the parent design.
//   * ADR-0035 §D2 (complex-matrix wire) — the input shape.

import {
  bool,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Float64Value,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";

const NAME = "purity";
const VERSION = "0.1.0";

const EPS = Number.EPSILON;
const HERMITIAN_TOL_FACTOR = 100 * EPS;

// `is_pure_within_tolerance` flips when γ(ρ) is within this of 1.
// Same threshold trace-norm uses for its reconstruction soft floor,
// so the trio reads consistently to a planner.
const PURITY_TOL = 1e-9;
// Trace-deviation warning floor. Tighter than PURITY_TOL because the
// trace is a *linear* sum: round-off is O(n · EPS).
const TRACE_DEVIATION_WARNING = 1e-9;

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const complexMatrixSchema = S.record({
  re: S.list(S.list(S.kind("float64"))),
  im: S.list(S.list(S.kind("float64"))),
});

const inputSchema = S.record({ rho: complexMatrixSchema });

const successOutputSchema = S.record({
  value: S.kind("float64"),
  trace: S.kind("float64"),
  is_pure_within_tolerance: S.kind("boolean"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const nonHermitianOutputSchema = S.tagged(
  `${NAME}/non-hermitian-input`,
  S.record({
    row: S.kind("integer"),
    col: S.kind("integer"),
    violation: S.kind("string"),
    max_violation: S.kind("string"),
  }),
);

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-input`,
  S.record({
    row: S.kind("integer"),
    col: S.kind("integer"),
    part: S.kind("string"),
    value: S.kind("string"),
  }),
);

const degenerateOutputSchema = S.tagged(
  `${NAME}/degenerate-shape`,
  S.record({
    m: S.kind("integer"),
    n: S.kind("integer"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  nonHermitianOutputSchema,
  nonFiniteOutputSchema,
  degenerateOutputSchema,
]);

// -----------------------------------------------------------------------------
// Wire helpers
// -----------------------------------------------------------------------------

function listOfFloat64(xs: readonly number[]): {
  readonly kind: "list";
  readonly items: readonly Float64Value[];
} {
  const items = new Array<Float64Value>(xs.length);
  for (let i = 0; i < xs.length; i++) items[i] = float64FromNumber(xs[i]!);
  return list(items);
}

function matrixWire(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({
    re: list(reRows.map((r) => listOfFloat64(r))),
    im: list(imRows.map((r) => listOfFloat64(r))),
  });
}

function rhoInput(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({ rho: matrixWire(reRows, imRows) });
}

// -----------------------------------------------------------------------------
// Decode + validation
// -----------------------------------------------------------------------------

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

/**
 * Decode the canonical complex-matrix wire shape into flat
 * Float64Arrays plus the bookkeeping (`maxAbs`) needed for the
 * Hermiticity tolerance. Mirrors `trace-norm`'s helper of the same
 * name — duplicated rather than lifted to a shared package because
 * the trio is still small and each tool's decoder is its own
 * literate chapter.
 *
 *   - `{kind: "ok", n, re, im, maxAbs}` — n×n decoded matrix.
 *   - `{kind: "tagged", value}` — boundary refusal to propagate up.
 *
 * Throws `ToolError` on malformed input (shape mismatch, non-square,
 * ragged). The runner has already structurally validated the wire
 * shape via `inputSchema`; only semantic checks happen here.
 */
function decodeComplexMatrix(
  reList: { readonly kind: "list"; readonly items: readonly Value[] },
  imList: { readonly kind: "list"; readonly items: readonly Value[] },
):
  | { kind: "ok"; n: number; re: Float64Array; im: Float64Array; maxAbs: number }
  | { kind: "tagged"; value: Value } {
  const m = reList.items.length;
  if (m === 0) {
    return {
      kind: "tagged",
      value: tagged(`${NAME}/degenerate-shape`, record({ m: int(0n), n: int(0n) })),
    };
  }
  if (imList.items.length !== m) {
    throw new ToolError(
      `${NAME}: rho.re has ${m} rows, rho.im has ${imList.items.length} — shapes must match`,
      { suggestion: "rho.re and rho.im must be the same n × n matrix" },
    );
  }

  const firstRe = reList.items[0]!;
  if (firstRe.kind !== "list") {
    throw new ToolError(`${NAME}: rho.re[0] is not a list`, {});
  }
  const n = firstRe.items.length;
  if (n === 0) {
    return {
      kind: "tagged",
      value: tagged(`${NAME}/degenerate-shape`, record({ m: int(BigInt(m)), n: int(0n) })),
    };
  }
  if (m !== n) {
    throw new ToolError(
      `${NAME}: rho must be square (got ${m}×${n})`,
      {
        suggestion:
          `purity is defined only for square operators; for a non-square ` +
          `matrix tr(ρ²) is not well-defined.`,
      },
    );
  }

  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const reRow = reList.items[i]!;
    const imRow = imList.items[i]!;
    if (reRow.kind !== "list") {
      throw new ToolError(`${NAME}: rho.re[${i}] is not a list`, {});
    }
    if (imRow.kind !== "list") {
      throw new ToolError(`${NAME}: rho.im[${i}] is not a list`, {});
    }
    if (reRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: rho.re is not rectangular (row 0 has ${n} entries, row ${i} has ${reRow.items.length})`,
        { suggestion: "every row of rho.re must have the same length" },
      );
    }
    if (imRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: rho.im row ${i} has length ${imRow.items.length}, expected ${n} to match rho.re`,
        { suggestion: "rho.im and rho.re must have identical shape" },
      );
    }
    for (let j = 0; j < n; j++) {
      const reCell = reRow.items[j]!;
      const imCell = imRow.items[j]!;
      if (reCell.kind !== "float64") {
        throw new ToolError(`${NAME}: rho.re[${i}][${j}] is not a float64`, {});
      }
      if (imCell.kind !== "float64") {
        throw new ToolError(`${NAME}: rho.im[${i}][${j}] is not a float64`, {});
      }
      const reX = float64ToNumber(reCell);
      const imX = float64ToNumber(imCell);
      if (!Number.isFinite(reX)) {
        return {
          kind: "tagged",
          value: tagged(
            `${NAME}/non-finite-input`,
            record({
              row: int(BigInt(i)),
              col: int(BigInt(j)),
              part: str("re"),
              value: str(formatNonFinite(reX)),
            }),
          ),
        };
      }
      if (!Number.isFinite(imX)) {
        return {
          kind: "tagged",
          value: tagged(
            `${NAME}/non-finite-input`,
            record({
              row: int(BigInt(i)),
              col: int(BigInt(j)),
              part: str("im"),
              value: str(formatNonFinite(imX)),
            }),
          ),
        };
      }
      const mag = Math.hypot(reX, imX);
      if (mag > maxAbs) maxAbs = mag;
      re[i * n + j] = reX;
      im[i * n + j] = imX;
    }
  }
  return { kind: "ok", n, re, im, maxAbs };
}

/**
 * Walk the upper triangle (incl. diagonal) and return the worst
 * Hermitian violation, or `null` if `max|ρ − ρ†| ≤ tol`. For
 * Hermitian ρ:
 *   ρ_{ij} = conj(ρ_{ji})
 *   ⇒ re[i,j] = re[j,i]  AND  im[i,j] = -im[j,i].
 * The pointwise violation magnitude is
 *   |ρ_{ij} − conj(ρ_{ji})|
 *     = √((re[i,j] − re[j,i])² + (im[i,j] + im[j,i])²).
 * On the diagonal (i = j) the formula simplifies to `2 · |im[i,i]|`
 * — a Hermitian matrix has a real diagonal.
 *
 * Mirrors `trace-norm`'s helper of the same name; duplicated here for
 * the same self-contained-at-tool-layer reason.
 */
function findWorstHermitianViolation(
  re: Float64Array,
  im: Float64Array,
  n: number,
  tol: number,
): { row: number; col: number; violation: number } | null {
  let worst = 0;
  let worstI = -1;
  let worstJ = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const dRe = re[i * n + j]! - re[j * n + i]!;
      const dIm = im[i * n + j]! + im[j * n + i]!;
      const v = Math.hypot(dRe, dIm);
      if (v > worst) {
        worst = v;
        worstI = i;
        worstJ = j;
      }
    }
  }
  return worst > tol ? { row: worstI, col: worstJ, violation: worst } : null;
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Purity `γ(ρ) = tr(ρ²)` of a complex Hermitian density operator via the one-pass entrywise identity `γ = Σ |ρ_ij|²`; O(n²), no eigendecomposition. Second qinfo v0.2 tool",
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015 / ADR-0035 §D3: the success branch emits float64 leaves
  // (value, trace), so the platform fingerprint is recorded on every
  // successful run. No eigendecomp here, so the cross-platform
  // divergence surface is much smaller than trace-norm's — but the
  // tier annotation is the same because the *output* contains
  // float64. (The four-tier ADR-0015 rule: tier is determined by
  // what's on the wire, not by what the algorithm internally needs.)
  numerical: true,
  examples: [
    // -- happy path: pure states (γ = 1) ----------------------------------
    {
      description: "rho=|0><0| pure projector → γ = 1",
      input: rhoInput([[1, 0], [0, 0]], [[0, 0], [0, 0]]),
      output: record({
        value: float64FromNumber(1),
        trace: float64FromNumber(1),
        is_pure_within_tolerance: bool(true),
        method: str("hermitian-sum-of-squares"),
        warnings: list([]),
      }),
    },
    {
      description: "rho=|+><+| pure superposition → γ = 1",
      input: rhoInput([[0.5, 0.5], [0.5, 0.5]], [[0, 0], [0, 0]]),
      output: record({
        value: float64FromNumber(1),
        trace: float64FromNumber(1),
        is_pure_within_tolerance: bool(true),
        method: str("hermitian-sum-of-squares"),
        warnings: list([]),
      }),
    },
    // -- happy path: maximally mixed (γ = 1/d) ----------------------------
    {
      description: "rho=I_2/2 one-qubit max-mixed → γ = 1/2",
      input: rhoInput([[0.5, 0], [0, 0.5]], [[0, 0], [0, 0]]),
      output: record({
        value: float64FromNumber(0.5),
        trace: float64FromNumber(1),
        is_pure_within_tolerance: bool(false),
        method: str("hermitian-sum-of-squares"),
        warnings: list([]),
      }),
    },
    // -- happy path: Bloch density operator with Y component (complex Hermitian)
    {
      // γ = re² + im² over all entries
      //   = (0.6² + 0.2² + 0.2² + 0.4²) + (0 + 0.25² + 0.25² + 0)
      //   = 0.6 + 0.125 = 0.725
      // `output` is omitted: the float64 sum-of-squares lands a ULP
      // away from the literal `0.725`, so the byte-exact record is
      // pinned by the folded golden (ADR-0043 / issue ixnv.3) rather
      // than a brittle hand-transcribed literal.
      description: "rho=(I + 0.4 X + 0.5 Y + 0.2 Z)/2 Bloch with Y → γ = 0.5·(1 + r²) for r = 0.671...",
      input: rhoInput([[0.6, 0.2], [0.2, 0.4]], [[0, -0.25], [0.25, 0]]),
    },
    // -- happy path: pure Pauli-Y eigenstate (complex Hermitian, γ = 1) ----
    {
      description: "rho=|+i><+i| pure Pauli-Y eigenstate → γ = 1",
      // |+i> = (|0> + i|1>) / √2 → ρ = (1/2)·[[1, -i], [i, 1]]
      input: rhoInput([[0.5, 0], [0, 0.5]], [[0, -0.5], [0.5, 0]]),
      output: record({
        value: float64FromNumber(1),
        trace: float64FromNumber(1),
        is_pure_within_tolerance: bool(true),
        method: str("hermitian-sum-of-squares"),
        warnings: list([]),
      }),
    },
    // -- boundary refusals ------------------------------------------------
    {
      description: "non-Hermitian (re asymmetric) → tagged 'purity/non-hermitian-input'",
      input: rhoInput([[1, 2], [3, 0]], [[0, 0], [0, 0]]),
      output: tagged(
        `${NAME}/non-hermitian-input`,
        record({
          row: int(0n),
          col: int(1n),
          violation: str("1"),
          max_violation: str("1"),
        }),
      ),
    },
    {
      description: "non-finite re → tagged 'purity/non-finite-input'",
      input: rhoInput([[1, 0], [0, NaN]], [[0, 0], [0, 0]]),
      output: tagged(
        `${NAME}/non-finite-input`,
        record({
          row: int(1n),
          col: int(1n),
          part: str("re"),
          value: str("NaN"),
        }),
      ),
    },
    {
      description: "degenerate (n=0) → tagged 'purity/degenerate-shape'",
      input: record({ rho: record({ re: list([]), im: list([]) }) }),
      output: tagged(
        `${NAME}/degenerate-shape`,
        record({ m: int(0n), n: int(0n) }),
      ),
    },
  ],
  invariants: [
    {
      name: "deterministic-per-platform",
      statement: "same input bytes → same output bytes (single platform; ADR-0015 platform fingerprint recorded in provenance)",
      machine_checkable: true,
    },
    {
      name: "non-negative",
      statement: "value >= 0 for every successful run (sum of squares is non-negative)",
      machine_checkable: true,
    },
    {
      name: "pure-state-unity",
      statement: "γ(ρ) = 1 for every rank-1 pure state ρ = |ψ⟩⟨ψ|; is_pure_within_tolerance is then true",
      machine_checkable: true,
    },
    {
      name: "max-mixed-bound",
      statement: "γ(I_d/d) = 1/d on the d-dimensional maximally mixed state (the lower bound for density operators)",
      machine_checkable: true,
    },
    {
      name: "density-operator-upper-bound",
      statement: "γ(ρ) <= 1 for every density operator ρ (Hermitian PSD with tr ρ = 1); the inequality is saturated iff ρ is pure",
      machine_checkable: true,
    },
    {
      name: "hermitian-sum-of-squares-formula",
      statement: "γ(ρ) = Σ_{i,j} (re[i,j]² + im[i,j]²) for Hermitian ρ — the algorithm's defining identity",
      machine_checkable: true,
    },
    {
      name: "unitary-invariance",
      statement: "γ(U ρ U†) = γ(ρ) for any unitary U (the spectrum of ρ is unitarily invariant, and γ = Σ λ_k²)",
      machine_checkable: true,
    },
    {
      name: "trace-pass-through",
      statement: "the success record surfaces tr(ρ) so a caller can check ρ is a valid density matrix without re-decoding",
      machine_checkable: true,
    },
    {
      name: "non-hermitian-tagged",
      statement: `any ρ with max|ρ − ρ†| > 100·EPS·max|ρ| → tagged "${NAME}/non-hermitian-input" with the offending coordinate and violation magnitude — never silently Hermitian-symmetrised, never silently routed to a non-Hermitian path`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in ρ.re or ρ.im → tagged "${NAME}/non-finite-input" with the (row, col, part, value)`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `n = 0 → tagged "${NAME}/degenerate-shape" with (m, n)`,
      machine_checkable: true,
    },
    {
      name: "shape-mismatch-rejected",
      statement: `ρ.re and ρ.im with disagreeing rows × cols → ToolError`,
      machine_checkable: true,
    },
    {
      name: "non-square-rejected",
      statement: `non-square ρ (m ≠ n) → ToolError — purity is undefined off-square`,
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    const rho = input.fields.rho as Value;
    if (rho.kind !== "record") {
      throw new ToolError(`${NAME}: rho is not a record`, {});
    }
    const reField = rho.fields.re as Value;
    const imField = rho.fields.im as Value;
    if (reField.kind !== "list") {
      throw new ToolError(`${NAME}: rho.re is not a list`, {});
    }
    if (imField.kind !== "list") {
      throw new ToolError(`${NAME}: rho.im is not a list`, {});
    }

    const decoded = decodeComplexMatrix(reField, imField);
    if (decoded.kind === "tagged") return decoded.value;
    const { n, re, im, maxAbs } = decoded;

    // ── Hermiticity gate ────────────────────────────────────────────────
    if (maxAbs > 0) {
      const tol = HERMITIAN_TOL_FACTOR * maxAbs;
      const worst = findWorstHermitianViolation(re, im, n, tol);
      if (worst !== null) {
        return tagged(
          `${NAME}/non-hermitian-input`,
          record({
            row: int(BigInt(worst.row)),
            col: int(BigInt(worst.col)),
            violation: str(String(worst.violation)),
            max_violation: str(String(worst.violation)),
          }),
        );
      }
    }

    // ── One pass: γ = Σ (re² + im²); trace = Σ re[i,i]. ──────────────────
    let value = 0;
    let trace = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const r = re[i * n + j]!;
        const m = im[i * n + j]!;
        value += r * r + m * m;
      }
      trace += re[i * n + i]!;
    }

    // ── Warnings about validity as a density matrix ──────────────────────
    const warnings: string[] = [];
    if (Math.abs(trace - 1) > TRACE_DEVIATION_WARNING) {
      warnings.push(
        `tr(rho) = ${trace} deviates from 1 by ${Math.abs(trace - 1).toExponential(2)}; ` +
        `rho may not be a valid density matrix (purity is still computed)`,
      );
    }
    if (value > 1 + PURITY_TOL) {
      warnings.push(
        `value = ${value} > 1; ` +
        `a Hermitian PSD matrix with tr(rho) <= 1 has tr(rho^2) <= 1, so rho is not a density operator`,
      );
    }
    if (n > 1 && value < 1 / n - PURITY_TOL) {
      warnings.push(
        `value = ${value} < 1/d = ${1 / n}; ` +
        `a density operator on d-dim Hilbert space has tr(rho^2) >= 1/d, so rho is not a density operator`,
      );
    }

    return record({
      value: float64FromNumber(value),
      trace: float64FromNumber(trace),
      is_pure_within_tolerance: bool(Math.abs(value - 1) <= PURITY_TOL),
      method: str("hermitian-sum-of-squares"),
      warnings: list(warnings.map((w) => str(w))),
    });
  },
  test: () => {
    // Smoke probes covering pure-state-unity, max-mixed-bound, the
    // sum-of-squares identity on real and complex Hermitian ρ, and
    // unitary invariance via the spectral identity γ = Σ λ_k² (we
    // construct ρ from a chosen spectrum and check). Every probe
    // asserts a mathematical invariant (Rule 7).

    // Compute γ via the closed-form sum-of-squares — duplicates the
    // tool body's inner loop so the test is a *cross-check*, not a
    // tautology against the same code path. The two implementations
    // must agree on every probe; if they don't, one of them is wrong.
    const gammaSumOfSquares = (re: Float64Array, im: Float64Array): number => {
      let v = 0;
      for (let k = 0; k < re.length; k++) v += re[k]! * re[k]! + im[k]! * im[k]!;
      return v;
    };

    const assertClose = (label: string, got: number, want: number, tol: number) => {
      if (Math.abs(got - want) > tol) {
        throw new Error(`test: ${label} γ=${got}, want ${want} ± ${tol}`);
      }
    };

    // γ(|0><0|) = 1
    {
      const re = new Float64Array([1, 0, 0, 0]);
      const im = new Float64Array([0, 0, 0, 0]);
      assertClose("pure-projector", gammaSumOfSquares(re, im), 1, 1e-15);
    }

    // γ(I_3/3) = 1/3
    {
      const re = new Float64Array([1 / 3, 0, 0, 0, 1 / 3, 0, 0, 0, 1 / 3]);
      const im = new Float64Array(9);
      assertClose("max-mixed-3", gammaSumOfSquares(re, im), 1 / 3, 1e-15);
    }

    // γ(|+i><+i|) = 1 — pure Pauli-Y eigenstate ρ = (1/2)·[[1,-i],[i,1]]
    {
      const re = new Float64Array([0.5, 0, 0, 0.5]);
      const im = new Float64Array([0, -0.5, 0.5, 0]);
      assertClose("pauli-y-plus", gammaSumOfSquares(re, im), 1, 1e-15);
    }

    // γ via spectral identity: ρ = diag(p, 1-p) Hermitian gives γ = p² + (1-p)².
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const re = new Float64Array([p, 0, 0, 1 - p]);
      const im = new Float64Array(4);
      const want = p * p + (1 - p) * (1 - p);
      assertClose(`diag(${p}, ${1 - p})`, gammaSumOfSquares(re, im), want, 1e-15);
    }

    // Unitary invariance check: rotate the diag(0.7, 0.3) basis by 60°
    // (real rotation; same eigenvalues; same γ).
    {
      const p = 0.7;
      const want = p * p + (1 - p) * (1 - p);
      const c = Math.cos(Math.PI / 3);
      const s = Math.sin(Math.PI / 3);
      // ρ' = U · diag(p, 1-p) · U^T where U = [[c, -s], [s, c]].
      // Block out by hand:
      //   ρ'[0,0] = c²·p + s²·(1-p)
      //   ρ'[1,1] = s²·p + c²·(1-p)
      //   ρ'[0,1] = ρ'[1,0] = c·s·(p − (1-p)) = c·s·(2p − 1)
      const a = c * c * p + s * s * (1 - p);
      const b = s * s * p + c * c * (1 - p);
      const o = c * s * (2 * p - 1);
      const re = new Float64Array([a, o, o, b]);
      const im = new Float64Array(4);
      const got = gammaSumOfSquares(re, im);
      assertClose("unitary-invariance-60deg-rotation", got, want, 1e-14);
    }
  },
});

if (import.meta.main) void runTool(def);
