// =============================================================================
// trace-distance — D(ρ, σ) = ½‖ρ − σ‖₁ between two complex Hermitian
// density operators
// =============================================================================
//
// Intent
// ------
// The **trace distance** between two density operators ρ, σ on the
// same d-dimensional Hilbert space is the scalar
//
//     D(ρ, σ) = ½ · ‖ρ − σ‖₁   ∈   [0, 1].
//
// It is the operationally-meaningful state-distinguishability
// metric: by **Helstrom's theorem** (1969), the maximum probability
// of correctly guessing which of two equally-likely states (ρ vs σ)
// was prepared, by any quantum measurement followed by an optimal
// classical decision, is
//
//     P_distinguish = ½ · (1 + D(ρ, σ)).
//
// Two states with D = 1 are perfectly distinguishable; with D = 0
// they are identical (by the Schatten-1 norm's separation property).
// Most pairs of density operators sit somewhere in between.
//
// This is the third deliverable of the qinfo v0.2 surface: a thin
// composition of the Hermitian spectral characterisation. The
// substrate work is the same eigh-complex pipeline that powers
// `trace-norm` — the difference `ρ − σ` of two Hermitian matrices is
// Hermitian, so we can apply the spectral formula
// `‖M‖₁ = Σ |λ_k(M)|` (Bhatia §IV.2) verbatim, then halve.
//
// Why a planner reaches for this
// ------------------------------
//   - **Distinguishability bounds.** The Helstrom answer is the
//     tight bound for one-shot state-discrimination — any
//     downstream cost-of-information argument routes through it.
//   - **Fidelity ↔ trace-distance** (Fuchs–van de Graaf 1999):
//     `1 − F(ρ, σ) ≤ D(ρ, σ) ≤ √(1 − F(ρ, σ)²)`. Once `tools/fidelity`
//     ships (bead `2hxf`), the pair `D` and `F` characterises two
//     operationally-meaningful state distances; this tool is the
//     `D` side.
//   - **Channel distinguishability** via the diamond norm
//     (Watrous §3.3): `D_◇(Φ, Ψ) = sup_ρ D((Φ ⊗ I)(ρ), (Ψ ⊗ I)(ρ))`.
//     The supremum is an SDP; the inner state-distance is this
//     tool composed across choices of ρ.
//
// Algorithm
// ---------
// 1. Decode both ρ.re, ρ.im, σ.re, σ.im into flat `Float64Array(n²)`;
//    fold in non-finite detection (→ tagged) and degenerate-shape
//    check, plus the per-cell `|·|` walk for the Hermiticity
//    tolerance.
// 2. Validate ρ and σ have the same shape (n × n on both); refuse
//    via tagged shape-mismatch on disagreement.
// 3. Hermiticity gate on each (separate tags `non-hermitian-input-rho`
//    and `non-hermitian-input-sigma` — the payload's `which` field
//    names the offending matrix so a planner can repair without
//    re-decoding the wire).
// 4. Compute `M = ρ − σ` entry-wise; the result is Hermitian because
//    each input is.
// 5. Call `eighComplex(M)`; sum `|λ_k|`; halve. The total is `O(n)`
//    after the `O(n³)` eigh.
// 6. Emit happy-path record.
//
// Wire shape
// ----------
// `record{rho: record{re, im}, sigma: record{re, im}}` — both inputs
// take the same canonical complex-matrix shape (ADR-0035 §D2) as
// `trace-norm` and `purity`. The v0.2 quartet shares one matrix
// wire convention.
//
// The bead `k2xo` originally specified
// `record{rho: list<list<float64>>, sigma: list<list<float64>>}` —
// real-only. This session lifts to the complex-Hermitian wire,
// matching what trace-norm shipped (worklog 102 + 103). The
// rationale is in worklog 103 §"Why these choices" — TS-expert
// consistency wins.
//
// Output
// ------
// Happy path: `record{value, method, warnings}`. `value` is the
// scalar D(ρ, σ); the `method` field is the literal string
// `"hermitian-eigh-of-difference"`; warnings populated when ρ or σ
// looks suspicious as a density operator (tr ≠ 1, D > 1).
//
// Boundary tags (ADR-0003):
//   * `trace-distance/non-hermitian-input` (payload includes `which`
//     ∈ {"rho", "sigma"} naming the bad input)
//   * `trace-distance/non-finite-input` (payload includes `which`)
//   * `trace-distance/shape-mismatch` (ρ and σ disagree on n × n)
//   * `trace-distance/degenerate-shape` (n = 0 for either)
//
// `ToolError` (exit 1) for malformed input:
//   * re/im shape mismatch within ρ or σ
//   * non-square ρ.re or σ.re
//   * ragged rows
//
// References
//   * Helstrom, *Quantum Detection and Estimation Theory*,
//     Academic Press 1976 (the eponymous bound; original paper is
//     Helstrom 1969 in Inf. & Control).
//   * Nielsen & Chuang, §9.2 — trace distance and operational
//     significance.
//   * Fuchs & van de Graaf, *IEEE Trans. Inf. Theory* 45(4) 1999 —
//     trace-distance / fidelity inequalities.
//   * Watrous, §3.1 — trace norm + trace distance; §3.3 — diamond
//     norm.
//   * Bhatia, §IV.2 — Schatten norms; spectral characterisation.
//   * ADR-0035 — complex-linalg-tier ADR; §D2 wire shape.

import {
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
import { eighComplex, type ComplexMatrix } from "@workbench/linalg-core";

const NAME = "trace-distance";
const VERSION = "0.1.0";

const EPS = Number.EPSILON;
const HERMITIAN_TOL_FACTOR = 100 * EPS;

// Soft-warning thresholds — inherited from trace-norm shard 102 so
// the trio reads consistently.
const TRACE_DEVIATION_WARNING = 1e-9;
const D_UPPER_WARNING = 1 + 1e-9;
const RECONSTRUCTION_WARNING = 1e-12;
const ORTHOGONALITY_WARNING = 1e-12;
const CONDITION_WARNING = 1e12;

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const complexMatrixSchema = S.record({
  re: S.list(S.list(S.kind("float64"))),
  im: S.list(S.list(S.kind("float64"))),
});

const inputSchema = S.record({
  rho: complexMatrixSchema,
  sigma: complexMatrixSchema,
});

const successOutputSchema = S.record({
  value: S.kind("float64"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const nonHermitianOutputSchema = S.tagged(
  `${NAME}/non-hermitian-input`,
  S.record({
    which: S.kind("string"),
    row: S.kind("integer"),
    col: S.kind("integer"),
    violation: S.kind("string"),
    max_violation: S.kind("string"),
  }),
);

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-input`,
  S.record({
    which: S.kind("string"),
    row: S.kind("integer"),
    col: S.kind("integer"),
    part: S.kind("string"),
    value: S.kind("string"),
  }),
);

const shapeMismatchOutputSchema = S.tagged(
  `${NAME}/shape-mismatch`,
  S.record({
    rho_n: S.kind("integer"),
    sigma_n: S.kind("integer"),
  }),
);

const degenerateOutputSchema = S.tagged(
  `${NAME}/degenerate-shape`,
  S.record({
    which: S.kind("string"),
    m: S.kind("integer"),
    n: S.kind("integer"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  nonHermitianOutputSchema,
  nonFiniteOutputSchema,
  shapeMismatchOutputSchema,
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

function pairInput(
  rhoRe: readonly (readonly number[])[],
  rhoIm: readonly (readonly number[])[],
  sigmaRe: readonly (readonly number[])[],
  sigmaIm: readonly (readonly number[])[],
) {
  return record({
    rho: matrixWire(rhoRe, rhoIm),
    sigma: matrixWire(sigmaRe, sigmaIm),
  });
}

function realRho(rho: readonly (readonly number[])[]) {
  const n = rho.length;
  const zeros: number[][] = [];
  for (let i = 0; i < n; i++) zeros.push(new Array<number>(rho[0]!.length).fill(0));
  return { re: rho, im: zeros };
}

function pairRealInput(
  rho: readonly (readonly number[])[],
  sigma: readonly (readonly number[])[],
) {
  const r = realRho(rho);
  const s = realRho(sigma);
  return pairInput(r.re, r.im, s.re, s.im);
}

// -----------------------------------------------------------------------------
// Decode helper — same pattern as trace-norm / purity, but parameterised on
// the input role ("rho" vs "sigma") so boundary tags name the offending side.
// Duplication acknowledged in worklog 104; the lift to a shared substrate is
// queued for after fidelity ships — by then we'll have seen enough decode
// shapes to design the lift correctly.
// -----------------------------------------------------------------------------

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

function decodeComplexMatrix(
  which: "rho" | "sigma",
  reList: { readonly kind: "list"; readonly items: readonly Value[] },
  imList: { readonly kind: "list"; readonly items: readonly Value[] },
):
  | { kind: "ok"; n: number; re: Float64Array; im: Float64Array; maxAbs: number }
  | { kind: "tagged"; value: Value } {
  const m = reList.items.length;
  if (m === 0) {
    return {
      kind: "tagged",
      value: tagged(
        `${NAME}/degenerate-shape`,
        record({ which: str(which), m: int(0n), n: int(0n) }),
      ),
    };
  }
  if (imList.items.length !== m) {
    throw new ToolError(
      `${NAME}: ${which}.re has ${m} rows, ${which}.im has ${imList.items.length} — shapes must match`,
      { suggestion: `${which}.re and ${which}.im must be the same n × n matrix` },
    );
  }

  const firstRe = reList.items[0]!;
  if (firstRe.kind !== "list") {
    throw new ToolError(`${NAME}: ${which}.re[0] is not a list`, {});
  }
  const n = firstRe.items.length;
  if (n === 0) {
    return {
      kind: "tagged",
      value: tagged(
        `${NAME}/degenerate-shape`,
        record({ which: str(which), m: int(BigInt(m)), n: int(0n) }),
      ),
    };
  }
  if (m !== n) {
    throw new ToolError(
      `${NAME}: ${which} must be square (got ${m}×${n})`,
      {
        suggestion:
          `trace distance is defined only between operators of the same square dimension; ` +
          `${which} is rectangular.`,
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
      throw new ToolError(`${NAME}: ${which}.re[${i}] is not a list`, {});
    }
    if (imRow.kind !== "list") {
      throw new ToolError(`${NAME}: ${which}.im[${i}] is not a list`, {});
    }
    if (reRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: ${which}.re is not rectangular (row 0 has ${n} entries, row ${i} has ${reRow.items.length})`,
        { suggestion: `every row of ${which}.re must have the same length` },
      );
    }
    if (imRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: ${which}.im row ${i} has length ${imRow.items.length}, expected ${n} to match ${which}.re`,
        { suggestion: `${which}.im and ${which}.re must have identical shape` },
      );
    }
    for (let j = 0; j < n; j++) {
      const reCell = reRow.items[j]!;
      const imCell = imRow.items[j]!;
      if (reCell.kind !== "float64") {
        throw new ToolError(`${NAME}: ${which}.re[${i}][${j}] is not a float64`, {});
      }
      if (imCell.kind !== "float64") {
        throw new ToolError(`${NAME}: ${which}.im[${i}][${j}] is not a float64`, {});
      }
      const reX = float64ToNumber(reCell);
      const imX = float64ToNumber(imCell);
      if (!Number.isFinite(reX)) {
        return {
          kind: "tagged",
          value: tagged(
            `${NAME}/non-finite-input`,
            record({
              which: str(which),
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
              which: str(which),
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
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015: numerical tier (the success branch carries a float64
  // value); the eighComplex pass is the underlying numerical work.
  numerical: true,
  examples: [
    // -- happy path: orthogonal pure states → D = 1 ----------------------
    {
      description: "D(|0><0|, |1><1|) = 1 — perfectly distinguishable",
      input: pairRealInput([[1, 0], [0, 0]], [[0, 0], [0, 1]]),
      output: record({
        value: float64FromNumber(1),
        method: str("hermitian-eigh-of-difference"),
        warnings: list([]),
      }),
    },
    // -- happy path: identical states → D = 0 ----------------------------
    {
      description: "D(|0><0|, |0><0|) = 0 — identical states",
      input: pairRealInput([[1, 0], [0, 0]], [[1, 0], [0, 0]]),
      output: record({
        value: float64FromNumber(0),
        method: str("hermitian-eigh-of-difference"),
        warnings: list([]),
      }),
    },
    // -- happy path: pure vs maximally mixed → D = 1/2 -------------------
    {
      description: "D(|0><0|, I/2) = 1/2 — Bloch-vector half-distance",
      input: pairRealInput([[1, 0], [0, 0]], [[0.5, 0], [0, 0.5]]),
      output: record({
        value: float64FromNumber(0.5),
        method: str("hermitian-eigh-of-difference"),
        warnings: list([]),
      }),
    },
    // -- happy path: complex Hermitian Pauli-Y eigenstates → D = 1 -------
    {
      description: "D(|+i><+i|, |-i><-i|) = 1 — orthogonal complex pure states",
      // |+i> = (|0> + i|1>)/√2 → ρ = (1/2)·[[1,-i],[i,1]]
      // |-i> = (|0> - i|1>)/√2 → σ = (1/2)·[[1,i],[-i,1]]
      input: pairInput(
        [[0.5, 0], [0, 0.5]], [[0, -0.5], [0.5, 0]],
        [[0.5, 0], [0, 0.5]], [[0, 0.5], [-0.5, 0]],
      ),
      output: record({
        value: float64FromNumber(1),
        method: str("hermitian-eigh-of-difference"),
        warnings: list([]),
      }),
    },
    // -- happy path: two diagonal Bloch states → D = |p − q| -------------
    {
      description: "D(diag(0.7, 0.3), diag(0.3, 0.7)) = 0.4 — flipped classical bits",
      input: pairRealInput([[0.7, 0], [0, 0.3]], [[0.3, 0], [0, 0.7]]),
      output: record({
        // ρ − σ = diag(0.4, -0.4); ‖·‖₁ = 0.8; D = 0.4
        value: float64FromNumber(0.4),
        method: str("hermitian-eigh-of-difference"),
        warnings: list([]),
      }),
    },
    // -- boundary refusals -----------------------------------------------
    {
      description: "non-Hermitian rho → tagged 'trace-distance/non-hermitian-input' with which=rho",
      input: pairRealInput([[1, 2], [3, 0]], [[0.5, 0], [0, 0.5]]),
      output: tagged(
        `${NAME}/non-hermitian-input`,
        record({
          which: str("rho"),
          row: int(0n),
          col: int(1n),
          violation: str("1"),
          max_violation: str("1"),
        }),
      ),
    },
    {
      description: "non-Hermitian sigma → tagged 'trace-distance/non-hermitian-input' with which=sigma",
      input: pairRealInput([[0.5, 0], [0, 0.5]], [[1, 2], [3, 0]]),
      output: tagged(
        `${NAME}/non-hermitian-input`,
        record({
          which: str("sigma"),
          row: int(0n),
          col: int(1n),
          violation: str("1"),
          max_violation: str("1"),
        }),
      ),
    },
    {
      description: "shape-mismatch (2x2 vs 3x3) → tagged 'trace-distance/shape-mismatch'",
      input: pairRealInput(
        [[0.5, 0], [0, 0.5]],
        [[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]],
      ),
      output: tagged(
        `${NAME}/shape-mismatch`,
        record({ rho_n: int(2n), sigma_n: int(3n) }),
      ),
    },
    {
      description: "non-finite rho → tagged 'trace-distance/non-finite-input'",
      input: pairRealInput([[1, 0], [0, NaN]], [[0.5, 0], [0, 0.5]]),
      output: tagged(
        `${NAME}/non-finite-input`,
        record({
          which: str("rho"),
          row: int(1n),
          col: int(1n),
          part: str("re"),
          value: str("NaN"),
        }),
      ),
    },
    {
      description: "degenerate (n=0) → tagged 'trace-distance/degenerate-shape'",
      input: record({
        rho: record({ re: list([]), im: list([]) }),
        sigma: record({ re: list([]), im: list([]) }),
      }),
      output: tagged(
        `${NAME}/degenerate-shape`,
        record({ which: str("rho"), m: int(0n), n: int(0n) }),
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
      statement: "value >= 0 for every successful run (Schatten norm is non-negative)",
      machine_checkable: true,
    },
    {
      name: "symmetry",
      statement: "D(rho, sigma) = D(sigma, rho) — the trace norm is invariant under ρ−σ ↔ σ−ρ negation",
      machine_checkable: true,
    },
    {
      name: "identity-of-indiscernibles",
      statement: "D(rho, rho) = 0 — and conversely, D = 0 ⇒ rho = sigma (Schatten-1 separates points)",
      machine_checkable: true,
    },
    {
      name: "triangle-inequality",
      statement: "D(rho, tau) <= D(rho, sigma) + D(sigma, tau) for any three density operators",
      machine_checkable: true,
    },
    {
      name: "density-operator-upper-bound",
      statement: "D(rho, sigma) <= 1 for any two density operators (both PSD with trace 1)",
      machine_checkable: true,
    },
    {
      name: "orthogonal-pure-states-saturate",
      statement: "D(|psi><psi|, |phi><phi|) = 1 iff <psi|phi> = 0 — orthogonal pure states are perfectly distinguishable",
      machine_checkable: true,
    },
    {
      name: "pure-vs-max-mixed",
      statement: "D(|psi><psi|, I/d) = 1 − 1/d for any pure state |psi> on a d-dimensional Hilbert space",
      machine_checkable: true,
    },
    {
      name: "helstrom-distinguishing-probability",
      statement: "the maximum probability of distinguishing two equally-likely states ρ vs σ is (1 + D(ρ, σ))/2 (Helstrom 1969)",
      machine_checkable: false,
    },
    {
      name: "spectral-formula",
      statement: "D(rho, sigma) = (1/2) * Σ_k |λ_k(rho − sigma)| — the algorithm's defining identity (Bhatia §IV.2 plus halving factor)",
      machine_checkable: true,
    },
    {
      name: "non-hermitian-tagged",
      statement: `any input ρ or σ with max|M − M†| > 100·EPS·max|M| → tagged "${NAME}/non-hermitian-input" with the offending coordinate and which ∈ {"rho", "sigma"}`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in ρ.re, ρ.im, σ.re, or σ.im → tagged "${NAME}/non-finite-input" with (which, row, col, part, value)`,
      machine_checkable: true,
    },
    {
      name: "shape-mismatch-tagged",
      statement: `disagreeing n_ρ ≠ n_σ → tagged "${NAME}/shape-mismatch" with (rho_n, sigma_n) — trace distance is only defined between operators on the same Hilbert space`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `n = 0 for either ρ or σ → tagged "${NAME}/degenerate-shape" with (which, m, n)`,
      machine_checkable: true,
    },
    {
      name: "shape-mismatch-within-rejected",
      statement: `ρ.re ≠ ρ.im or σ.re ≠ σ.im shapes → ToolError`,
      machine_checkable: true,
    },
    {
      name: "non-square-rejected",
      statement: `non-square ρ or σ → ToolError`,
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    const rho = input.fields.rho as Value;
    const sigma = input.fields.sigma as Value;
    if (rho.kind !== "record") throw new ToolError(`${NAME}: rho is not a record`, {});
    if (sigma.kind !== "record") throw new ToolError(`${NAME}: sigma is not a record`, {});

    const decode = (which: "rho" | "sigma", M: typeof rho) => {
      const reField = M.fields.re as Value;
      const imField = M.fields.im as Value;
      if (reField.kind !== "list") throw new ToolError(`${NAME}: ${which}.re is not a list`, {});
      if (imField.kind !== "list") throw new ToolError(`${NAME}: ${which}.im is not a list`, {});
      return decodeComplexMatrix(which, reField, imField);
    };

    const rhoDecoded = decode("rho", rho);
    if (rhoDecoded.kind === "tagged") return rhoDecoded.value;
    const sigmaDecoded = decode("sigma", sigma);
    if (sigmaDecoded.kind === "tagged") return sigmaDecoded.value;

    if (rhoDecoded.n !== sigmaDecoded.n) {
      return tagged(
        `${NAME}/shape-mismatch`,
        record({
          rho_n: int(BigInt(rhoDecoded.n)),
          sigma_n: int(BigInt(sigmaDecoded.n)),
        }),
      );
    }
    const n = rhoDecoded.n;

    // ── Hermiticity gates — separate tags so the payload names the
    //    offending input. ────────────────────────────────────────────────
    const checkHermitian = (
      which: "rho" | "sigma",
      d: { re: Float64Array; im: Float64Array; maxAbs: number },
    ): Value | null => {
      if (d.maxAbs === 0) return null;
      const tol = HERMITIAN_TOL_FACTOR * d.maxAbs;
      const worst = findWorstHermitianViolation(d.re, d.im, n, tol);
      if (worst === null) return null;
      return tagged(
        `${NAME}/non-hermitian-input`,
        record({
          which: str(which),
          row: int(BigInt(worst.row)),
          col: int(BigInt(worst.col)),
          violation: str(String(worst.violation)),
          max_violation: str(String(worst.violation)),
        }),
      );
    };
    const rhoBad = checkHermitian("rho", rhoDecoded);
    if (rhoBad !== null) return rhoBad;
    const sigmaBad = checkHermitian("sigma", sigmaDecoded);
    if (sigmaBad !== null) return sigmaBad;

    // ── Compute M = ρ − σ entry-wise. Hermitian by construction. ─────────
    const diffRe = new Float64Array(n * n);
    const diffIm = new Float64Array(n * n);
    for (let k = 0; k < n * n; k++) {
      diffRe[k] = rhoDecoded.re[k]! - sigmaDecoded.re[k]!;
      diffIm[k] = rhoDecoded.im[k]! - sigmaDecoded.im[k]!;
    }
    const M: ComplexMatrix = { rows: n, cols: n, re: diffRe, im: diffIm };

    // ── eighComplex → (1/2) Σ |λ_k|. ────────────────────────────────────
    const result = eighComplex(M);
    let traceNorm = 0;
    for (let k = 0; k < n; k++) traceNorm += Math.abs(result.eigenvalues[k]!);
    const value = 0.5 * traceNorm;

    // ── Warnings about validity. ────────────────────────────────────────
    const warnings: string[] = [];
    const computeTrace = (re: Float64Array): number => {
      let t = 0;
      for (let i = 0; i < n; i++) t += re[i * n + i]!;
      return t;
    };
    const rhoTrace = computeTrace(rhoDecoded.re);
    const sigmaTrace = computeTrace(sigmaDecoded.re);
    if (Math.abs(rhoTrace - 1) > TRACE_DEVIATION_WARNING) {
      warnings.push(
        `tr(rho) = ${rhoTrace} deviates from 1 by ${Math.abs(rhoTrace - 1).toExponential(2)}; ` +
        `rho may not be a valid density matrix`,
      );
    }
    if (Math.abs(sigmaTrace - 1) > TRACE_DEVIATION_WARNING) {
      warnings.push(
        `tr(sigma) = ${sigmaTrace} deviates from 1 by ${Math.abs(sigmaTrace - 1).toExponential(2)}; ` +
        `sigma may not be a valid density matrix`,
      );
    }
    if (value > D_UPPER_WARNING) {
      warnings.push(
        `value = ${value} > 1; for density operators D ∈ [0, 1], so at least one of rho/sigma is not a density operator`,
      );
    }
    if (result.reconstructionError > RECONSTRUCTION_WARNING) {
      warnings.push(
        `eigh reconstruction error ${result.reconstructionError.toExponential(2)} exceeds soft floor ${RECONSTRUCTION_WARNING.toExponential(0)}`,
      );
    }
    if (result.orthogonalityError > ORTHOGONALITY_WARNING) {
      warnings.push(
        `eigh orthogonality error ${result.orthogonalityError.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
      );
    }
    if (result.conditionNumber > CONDITION_WARNING) {
      warnings.push(
        `condition number ${result.conditionNumber.toExponential(2)} near machine precision; trace distance may have lost relative accuracy on small eigenvalues`,
      );
    }

    return record({
      value: float64FromNumber(value),
      method: str("hermitian-eigh-of-difference"),
      warnings: list(warnings.map((w) => str(w))),
    });
  },
  test: () => {
    // The `--test` hook independently re-computes D via the
    // eigh-of-difference path on a small set of probes whose answers
    // are known analytically — this is a cross-check of the closed-form
    // invariants (orthogonal pure-states saturate, pure-vs-max-mixed,
    // symmetry, triangle).

    const dViaEigh = (
      reRho: number[], imRho: number[],
      reSigma: number[], imSigma: number[],
      n: number,
    ): number => {
      const re = new Float64Array(n * n);
      const im = new Float64Array(n * n);
      for (let k = 0; k < n * n; k++) {
        re[k] = reRho[k]! - reSigma[k]!;
        im[k] = imRho[k]! - imSigma[k]!;
      }
      const r = eighComplex({ rows: n, cols: n, re, im });
      let s = 0;
      for (let k = 0; k < n; k++) s += Math.abs(r.eigenvalues[k]!);
      return 0.5 * s;
    };

    const assertClose = (label: string, got: number, want: number, tol: number) => {
      if (Math.abs(got - want) > tol) {
        throw new Error(`test: ${label} D=${got}, want ${want} ± ${tol}`);
      }
    };

    // D(|0><0|, |1><1|) = 1 — orthogonal pure states saturate the bound.
    assertClose("orthogonal-pure",
      dViaEigh([1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0], 2),
      1, 1e-12);
    // D(rho, rho) = 0 for any rho — identity of indiscernibles.
    assertClose("identity-of-indiscernibles",
      dViaEigh([0.7, 0, 0, 0.3], [0, 0, 0, 0], [0.7, 0, 0, 0.3], [0, 0, 0, 0], 2),
      0, 1e-12);
    // D(|0><0|, I/2) = 1/2 — pure vs maximally mixed on a qubit.
    assertClose("pure-vs-max-mixed",
      dViaEigh([1, 0, 0, 0], [0, 0, 0, 0], [0.5, 0, 0, 0.5], [0, 0, 0, 0], 2),
      0.5, 1e-12);
    // D(|0><0|, I/3) = 1 − 1/3 = 2/3 — pure vs maximally mixed on a qutrit.
    assertClose("pure-vs-max-mixed-3",
      dViaEigh([1, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [1 / 3, 0, 0, 0, 1 / 3, 0, 0, 0, 1 / 3], [0, 0, 0, 0, 0, 0, 0, 0, 0], 3),
      2 / 3, 1e-12);
    // D(|+i><+i|, |-i><-i|) = 1 — orthogonal Pauli-Y eigenstates (complex Hermitian).
    assertClose("orthogonal-pauli-y-eigenstates",
      dViaEigh([0.5, 0, 0, 0.5], [0, -0.5, 0.5, 0], [0.5, 0, 0, 0.5], [0, 0.5, -0.5, 0], 2),
      1, 1e-12);
    // D(diag(0.7, 0.3), diag(0.3, 0.7)) = 0.4.
    assertClose("flipped-classical-bits",
      dViaEigh([0.7, 0, 0, 0.3], [0, 0, 0, 0], [0.3, 0, 0, 0.7], [0, 0, 0, 0], 2),
      0.4, 1e-12);

    // Symmetry: D(ρ, σ) = D(σ, ρ).
    const ab = dViaEigh([0.7, 0, 0, 0.3], [0, 0, 0, 0], [0.4, 0.1, 0.1, 0.6], [0, 0, 0, 0], 2);
    const ba = dViaEigh([0.4, 0.1, 0.1, 0.6], [0, 0, 0, 0], [0.7, 0, 0, 0.3], [0, 0, 0, 0], 2);
    if (Math.abs(ab - ba) > 1e-14) {
      throw new Error(`test: symmetry violated D(A,B)=${ab} != D(B,A)=${ba}`);
    }

    // Triangle inequality: D(ρ, τ) ≤ D(ρ, σ) + D(σ, τ) on diagonal probes.
    const rho = [0.8, 0, 0, 0.2];
    const sig = [0.5, 0, 0, 0.5];
    const tau = [0.2, 0, 0, 0.8];
    const zer = [0, 0, 0, 0];
    const d_rs = dViaEigh(rho, zer, sig, zer, 2);
    const d_st = dViaEigh(sig, zer, tau, zer, 2);
    const d_rt = dViaEigh(rho, zer, tau, zer, 2);
    if (d_rt > d_rs + d_st + 1e-12) {
      throw new Error(`test: triangle violated D(ρ,τ)=${d_rt} > D(ρ,σ)+D(σ,τ)=${d_rs + d_st}`);
    }
  },
});

if (import.meta.main) void runTool(def);
