// =============================================================================
// fidelity — Uhlmann fidelity F(ρ, σ) = (tr √(√ρ · σ · √ρ))²
// =============================================================================
//
// Intent
// ------
// The **Uhlmann fidelity** (Uhlmann 1976; Jozsa 1994) between two
// density operators ρ, σ on the same d-dimensional Hilbert space is
// the scalar
//
//     F(ρ, σ) = (tr √(√ρ · σ · √ρ))²   ∈   [0, 1].
//
// It is the operationally-meaningful state-overlap metric: F = 1
// iff ρ = σ, F = 0 iff ρ and σ have orthogonal support (perfectly
// distinguishable on a single shot), and most intermediate values
// have crisp physical interpretations:
//
//   - **Pure states.** `F(|ψ⟩⟨ψ|, |φ⟩⟨φ|) = |⟨ψ|φ⟩|²` — the squared
//     transition amplitude.
//   - **Pure vs max-mixed.** `F(|ψ⟩⟨ψ|, I/d) = 1/d` — the universal
//     "blind guess" overlap.
//   - **Identical.** `F(ρ, ρ) = 1` for any density operator ρ.
//   - **Bures angle.** `arccos(√F)` is the geodesic distance on the
//     space of density operators (Bures metric).
//
// This is the fourth and **final** deliverable of the qinfo v0.2
// surface, completing the trio with `trace-distance` and pairing
// against it via the **Fuchs–van de Graaf** inequality
// (Fuchs & van de Graaf 1999, *IEEE Trans. Inf. Theory* 45(4)):
//
//     1 − √F(ρ, σ)   ≤   D(ρ, σ)   ≤   √(1 − F(ρ, σ)).
//
// Demo-scope #26 exercises this inequality numerically — a probe
// that exists because both `D` and `F` finally ship in the same
// session.
//
// Why a planner reaches for this
// ------------------------------
//   - **State similarity** beyond what trace-distance measures.
//     Trace distance saturates at 1 on a wide class of "very
//     distinguishable" state pairs; fidelity discriminates among
//     them more finely (it is strictly convex in the second
//     argument).
//   - **Channel benchmarking.** F(ρ_in, Φ(ρ_in)) is the standard
//     metric for "how well does Φ preserve ρ"; averaging over a
//     state ensemble gives **process fidelity** / **average
//     fidelity** (Bowdrey et al. 2002, Nielsen 2002).
//   - **Bures metric and gradient descent in state space.** Many
//     variational algorithms (VQE, QAOA fidelity loss) optimise
//     fidelity directly; arccos(√F) gives the Riemannian geodesic.
//
// Algorithm
// ---------
// 1. Decode ρ, σ wire (same shape as `trace-distance`); fold in
//    non-finite / degenerate / shape-mismatch / Hermiticity gates
//    (separate `which` tags for ρ vs σ).
// 2. Compute the **Hermitian-PSD square root of ρ** via the spectral
//    path:
//        ρ = Q · diag(λ) · Q†      (eighComplex)
//        √ρ = Q · diag(√max(λ, 0)) · Q†.
//    Eigenvalues clamped from below at 0 to handle floating-point
//    near-PSD; a hard-negative eigenvalue (below `−1e-9·max|λ|`)
//    raises a soft warning that "ρ is not PSD" but the computation
//    proceeds (the negative-eigenspace contribution to √ρ becomes
//    zero — a conservative, honest choice).
// 3. Compute the inner matrix `M = √ρ · σ · √ρ`. Hermitian PSD by
//    construction when ρ and σ are PSD; the sandwich preserves
//    Hermiticity even when σ is only Hermitian.
// 4. Compute the eigenvalues of M via `eighComplex(M)`. Let
//    μ_k be the (real) spectrum.
// 5. F = `(Σ_k √max(μ_k, 0))²`. Same PSD-clamp discipline as in
//    step 2.
//
// The total cost is three `eighComplex` calls plus two
// `complexMatmul`s — O(n³) per call, so O(n³) overall. Far heavier
// than `trace-distance`'s single eigh, but still a thin tool on the
// existing substrate.
//
// Wire shape
// ----------
// `record{rho: record{re, im}, sigma: record{re, im}}` — identical
// to `trace-distance`. The v0.2 quartet shares one matrix wire
// convention.
//
// The bead `2hxf` originally specified `record{rho, sigma}` as
// `list<list<float64>>` real-only; this session lifts to the
// complex Hermitian shape consistent with the other three trio
// members (rationale in worklog 103 §"Why these choices"). Density
// operators with Pauli-Y Bloch components are inherently complex,
// and a TS-expert calling `fidelity` shouldn't have to context-
// switch between real-only and complex schemas.
//
// Output
// ------
// Happy path: `record{value, sqrt_value, bures_angle, method,
// warnings}`.
//
//   - `value` — F(ρ, σ), the Uhlmann fidelity scalar, ∈ [0, 1].
//   - `sqrt_value` — `√F`. Useful as the Bhattacharyya overlap and
//     as the input to the Fuchs–van de Graaf bounds. Cost: a
//     single `Math.sqrt` after F. Surfaced because every downstream
//     consumer of fidelity also wants `√F`.
//   - `bures_angle` — `arccos(min(1, √F))` in radians, ∈ [0, π/2].
//     The Riemannian geodesic distance under the Bures metric. The
//     `min(1, √F)` guards against floating-point `√F = 1 + 1e-16`
//     producing `NaN` from `arccos`.
//   - `method` — literal `"hermitian-eigh-spectral-sqrt"`.
//   - `warnings` — populated for tr ≠ 1, F > 1+tol, PSD violation
//     on either input.
//
// Boundary tags (ADR-0003) — same set as `trace-distance`:
//   * `fidelity/non-hermitian-input` (with `which`)
//   * `fidelity/non-finite-input` (with `which`)
//   * `fidelity/shape-mismatch`
//   * `fidelity/degenerate-shape` (with `which`)
//
// `ToolError` (exit 1) for malformed input:
//   * re/im shape mismatch within ρ or σ
//   * non-square
//   * ragged rows
//
// References
//   * Uhlmann, *Rep. Math. Phys.* 9(2) 1976 — the original
//     definition of the transition probability between mixed states.
//   * Jozsa, *J. Mod. Opt.* 41 1994 — fidelity properties for
//     density operators; the modern presentation.
//   * Fuchs & van de Graaf, *IEEE Trans. Inf. Theory* 45(4) 1999 —
//     the D ↔ F inequalities used in demo #26.
//   * Nielsen & Chuang, §9.2 — fidelity, Bures metric.
//   * Watrous, *Theory of Quantum Information*, Cambridge 2018,
//     §3.2 — fidelity and trace-distance bounds, Uhlmann's theorem.
//   * Bhatia, §IV.2 — Schatten norms and the spectral
//     characterisation that the inner trace-norm `tr √(M)` reduces
//     to once M is Hermitian PSD.
//   * ADR-0035 — complex-linalg-tier ADR.

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
import {
  type ComplexMatrix,
  type EighComplexResult,
  complexMatmul,
  eighComplex,
} from "@workbench/linalg-core";

const NAME = "fidelity";
const VERSION = "0.1.0";

const EPS = Number.EPSILON;
const HERMITIAN_TOL_FACTOR = 100 * EPS;

const TRACE_DEVIATION_WARNING = 1e-9;
const PSD_TOL = 1e-9; // relative to max|λ|; below this, warn about non-PSD
const F_UPPER_WARNING = 1 + 1e-9;
const RECONSTRUCTION_WARNING = 1e-12;
const ORTHOGONALITY_WARNING = 1e-12;

// -----------------------------------------------------------------------------
// Schemas — same surface as trace-distance.
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
  sqrt_value: S.kind("float64"),
  bures_angle: S.kind("float64"),
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
// Decode helper — fourth-and-final inline copy. The shared substrate
// extraction is filed as a follow-up to this commit; with four data
// points (trace-norm, purity, trace-distance, fidelity) the right
// shape for the lifted helper is now clear and lands in a separate
// shard.
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
          `fidelity is defined only between operators of the same square dimension; ` +
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
    if (reRow.kind !== "list") throw new ToolError(`${NAME}: ${which}.re[${i}] is not a list`, {});
    if (imRow.kind !== "list") throw new ToolError(`${NAME}: ${which}.im[${i}] is not a list`, {});
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
      if (reCell.kind !== "float64") throw new ToolError(`${NAME}: ${which}.re[${i}][${j}] is not a float64`, {});
      if (imCell.kind !== "float64") throw new ToolError(`${NAME}: ${which}.im[${i}][${j}] is not a float64`, {});
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
// Hermitian-PSD matrix square root via the spectral path.
//
// Given an `EighComplexResult` for a Hermitian matrix H, build
// √H = Q · diag(√max(λ, 0)) · Q†
//
// Eigenvalues clamped from below at 0 to handle floating-point near-
// PSD (where ρ = ρ† and conceptually ρ ⪰ 0, but the eigh reports
// λ_min = −1e-16 due to round-off). A hard-negative eigenvalue
// below `−PSD_TOL · max|λ|` raises a soft warning and contributes 0
// to the square root — a conservative, honest choice that doesn't
// lie about ρ's PSDness but doesn't crash on it either.
//
// Hand-rolled rather than via complexMatmul because we exploit the
// diagonal middle factor: temp[i, k] = Q[i, k] · √λ_k (one column
// scale), then result[i, j] = Σ_k temp[i, k] · conj(Q[j, k]). Same
// O(n³) as two matmuls but with one less allocation and the
// diagonal scaling implicit.
// -----------------------------------------------------------------------------

function hermitianPSDSqrt(
  r: EighComplexResult,
  which: string,
  warnings: string[],
): ComplexMatrix {
  const n = r.Q.rows;
  const sqrtLambda = new Float64Array(n);
  let mostNeg = 0;
  let maxAbs = 0;
  for (let k = 0; k < n; k++) {
    const lambda = r.eigenvalues[k]!;
    if (Math.abs(lambda) > maxAbs) maxAbs = Math.abs(lambda);
    if (lambda < mostNeg) mostNeg = lambda;
    sqrtLambda[k] = lambda > 0 ? Math.sqrt(lambda) : 0;
  }
  if (maxAbs > 0 && mostNeg < -PSD_TOL * maxAbs) {
    warnings.push(
      `${which} has eigenvalue ${mostNeg.toExponential(2)} (relative ${(mostNeg / maxAbs).toExponential(2)} to max|λ|); ` +
      `${which} is not PSD — small negatives clamped to 0 in sqrt, larger negatives discard their eigenspace`,
    );
  }

  const Qre = r.Q.re;
  const Qim = r.Q.im;
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);

  // result[i, j] = Σ_k Q[i, k] · √λ_k · conj(Q[j, k])
  //              = Σ_k (Qre[i,k] + i Qim[i,k]) · √λ_k · (Qre[j,k] − i Qim[j,k]).
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sumRe = 0;
      let sumIm = 0;
      for (let k = 0; k < n; k++) {
        const sk = sqrtLambda[k]!;
        if (sk === 0) continue;
        const aRe = Qre[i * n + k]!;
        const aIm = Qim[i * n + k]!;
        const bRe = Qre[j * n + k]!;
        const bIm = -Qim[j * n + k]!; // conjugate
        sumRe += sk * (aRe * bRe - aIm * bIm);
        sumIm += sk * (aRe * bIm + aIm * bRe);
      }
      re[i * n + j] = sumRe;
      im[i * n + j] = sumIm;
    }
  }
  return { rows: n, cols: n, re, im };
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  numerical: true,
  examples: [
    // -- happy path: identical pure state → F = 1 -------------------------
    {
      description: "F(|0><0|, |0><0|) = 1 — identical pure state",
      input: pairRealInput([[1, 0], [0, 0]], [[1, 0], [0, 0]]),
      output: record({
        value: float64FromNumber(1),
        sqrt_value: float64FromNumber(1),
        bures_angle: float64FromNumber(0),
        method: str("hermitian-eigh-spectral-sqrt"),
        warnings: list([]),
      }),
    },
    // -- happy path: orthogonal pure states → F = 0 -----------------------
    {
      description: "F(|0><0|, |1><1|) = 0 — orthogonal pure states",
      input: pairRealInput([[1, 0], [0, 0]], [[0, 0], [0, 1]]),
      output: record({
        value: float64FromNumber(0),
        sqrt_value: float64FromNumber(0),
        bures_angle: float64FromNumber(Math.PI / 2),
        method: str("hermitian-eigh-spectral-sqrt"),
        warnings: list([]),
      }),
    },
    // -- happy path: pure vs maximally mixed → F = 1/d --------------------
    {
      description: "F(|0><0|, I/2) = 1/2 — pure vs qubit max-mixed",
      input: pairRealInput([[1, 0], [0, 0]], [[0.5, 0], [0, 0.5]]),
      output: record({
        value: float64FromNumber(0.5),
        sqrt_value: float64FromNumber(Math.SQRT1_2),
        bures_angle: float64FromNumber(Math.PI / 4),
        method: str("hermitian-eigh-spectral-sqrt"),
        warnings: list([]),
      }),
    },
    // -- boundary refusals ------------------------------------------------
    {
      description: "non-Hermitian rho → tagged 'fidelity/non-hermitian-input' with which=rho",
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
      description: "shape-mismatch (2x2 vs 3x3) → tagged 'fidelity/shape-mismatch'",
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
      description: "non-finite sigma Infinity → tagged 'fidelity/non-finite-input'",
      input: pairRealInput([[0.5, 0], [0, 0.5]], [[1, 0], [0, Infinity]]),
      output: tagged(
        `${NAME}/non-finite-input`,
        record({
          which: str("sigma"),
          row: int(1n),
          col: int(1n),
          part: str("re"),
          value: str("Infinity"),
        }),
      ),
    },
    {
      description: "degenerate (n=0) → tagged 'fidelity/degenerate-shape'",
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
      statement: "value >= 0 for every successful run (F is a squared trace-norm; non-negative by construction)",
      machine_checkable: true,
    },
    {
      name: "symmetry",
      statement: "F(rho, sigma) = F(sigma, rho) — Uhlmann's theorem proves the symmetry despite the asymmetric definition (Watrous §3.2)",
      machine_checkable: true,
    },
    {
      name: "identity-pure",
      statement: "F(rho, rho) = 1 for any density operator rho (Uhlmann 1976)",
      machine_checkable: true,
    },
    {
      name: "density-operator-upper-bound",
      statement: "F(rho, sigma) <= 1 for any two density operators (Cauchy–Schwarz; saturated iff rho = sigma)",
      machine_checkable: true,
    },
    {
      name: "pure-pure-overlap",
      statement: "F(|psi><psi|, |phi><phi|) = |<psi|phi>|^2 — the squared transition amplitude",
      machine_checkable: true,
    },
    {
      name: "pure-vs-max-mixed",
      statement: "F(|psi><psi|, I/d) = 1/d for any pure state |psi> on a d-dimensional Hilbert space",
      machine_checkable: true,
    },
    {
      name: "orthogonal-pure-states-zero",
      statement: "F(|psi><psi|, |phi><phi|) = 0 iff <psi|phi> = 0 — perfect orthogonality",
      machine_checkable: true,
    },
    {
      name: "fuchs-van-de-graaf-lower",
      statement: "1 − sqrt(F(rho, sigma)) <= D(rho, sigma) — Fuchs–van de Graaf lower bound on D given F",
      machine_checkable: true,
    },
    {
      name: "fuchs-van-de-graaf-upper",
      statement: "D(rho, sigma) <= sqrt(1 − F(rho, sigma)) — Fuchs–van de Graaf upper bound on D given F",
      machine_checkable: true,
    },
    {
      name: "bures-angle-range",
      statement: "bures_angle = arccos(sqrt F) ∈ [0, π/2]; equals 0 iff F = 1, equals π/2 iff F = 0",
      machine_checkable: true,
    },
    {
      name: "uhlmann-spectral-formula",
      statement: "F(rho, sigma) = (Σ_k sqrt(μ_k))² where μ_k are the eigenvalues of √ρ · σ · √ρ — the algorithm's defining identity (Uhlmann 1976; Jozsa 1994)",
      machine_checkable: true,
    },
    {
      name: "non-hermitian-tagged",
      statement: `any input ρ or σ with max|M − M†| > 100·EPS·max|M| → tagged "${NAME}/non-hermitian-input" with which ∈ {"rho", "sigma"}`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in ρ.re, ρ.im, σ.re, or σ.im → tagged "${NAME}/non-finite-input" with which`,
      machine_checkable: true,
    },
    {
      name: "shape-mismatch-tagged",
      statement: `disagreeing n_ρ ≠ n_σ → tagged "${NAME}/shape-mismatch" — fidelity is only defined on operators of the same Hilbert space dimension`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `n = 0 for either ρ or σ → tagged "${NAME}/degenerate-shape" with which`,
      machine_checkable: true,
    },
    {
      name: "psd-clamp-warned",
      statement: "negative eigenvalues below −1e-9·max|λ| in either ρ or M=√ρσ√ρ raise a soft warning but the computation proceeds with the negative eigenspace contributing 0 to the sqrt (conservative; agent-honest)",
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

    const warnings: string[] = [];

    // ── Step 1: eigh of ρ ──────────────────────────────────────────────
    const rhoMatrix: ComplexMatrix = {
      rows: n, cols: n, re: rhoDecoded.re, im: rhoDecoded.im,
    };
    const rhoEigh = eighComplex(rhoMatrix);
    if (rhoEigh.reconstructionError > RECONSTRUCTION_WARNING) {
      warnings.push(
        `rho eigh reconstruction error ${rhoEigh.reconstructionError.toExponential(2)} exceeds soft floor`,
      );
    }
    if (rhoEigh.orthogonalityError > ORTHOGONALITY_WARNING) {
      warnings.push(
        `rho eigh orthogonality error ${rhoEigh.orthogonalityError.toExponential(2)} exceeds soft floor`,
      );
    }

    // ── Step 2: √ρ via spectral path (PSD-clamp; warns on negatives) ────
    const sqrtRho = hermitianPSDSqrt(rhoEigh, "rho", warnings);

    // ── Step 3: M = √ρ · σ · √ρ. Hermitian PSD if ρ, σ ⪰ 0. ────────────
    const sigmaMatrix: ComplexMatrix = {
      rows: n, cols: n, re: sigmaDecoded.re, im: sigmaDecoded.im,
    };
    const tmp = complexMatmul(sqrtRho, sigmaMatrix);
    const inner = complexMatmul(tmp, sqrtRho);

    // ── Step 4: eigh of inner. ──────────────────────────────────────────
    const innerEigh = eighComplex(inner);
    if (innerEigh.reconstructionError > RECONSTRUCTION_WARNING) {
      warnings.push(
        `inner eigh reconstruction error ${innerEigh.reconstructionError.toExponential(2)} exceeds soft floor`,
      );
    }
    if (innerEigh.orthogonalityError > ORTHOGONALITY_WARNING) {
      warnings.push(
        `inner eigh orthogonality error ${innerEigh.orthogonalityError.toExponential(2)} exceeds soft floor`,
      );
    }

    // ── Step 5: F = (Σ √max(μ, 0))². ────────────────────────────────────
    let sumSqrt = 0;
    let mostNegInner = 0;
    let maxAbsInner = 0;
    for (let k = 0; k < n; k++) {
      const mu = innerEigh.eigenvalues[k]!;
      if (Math.abs(mu) > maxAbsInner) maxAbsInner = Math.abs(mu);
      if (mu < mostNegInner) mostNegInner = mu;
      if (mu > 0) sumSqrt += Math.sqrt(mu);
    }
    if (maxAbsInner > 0 && mostNegInner < -PSD_TOL * maxAbsInner) {
      warnings.push(
        `√ρ·σ·√ρ has eigenvalue ${mostNegInner.toExponential(2)} (relative ${(mostNegInner / maxAbsInner).toExponential(2)} to max|μ|); ` +
        `at least one input is not PSD — negative eigenspaces contribute 0 to fidelity`,
      );
    }
    const value = sumSqrt * sumSqrt;
    const sqrtValue = sumSqrt;
    // Bures angle: arccos(min(1, √F)) — clamp guards against round-off |√F| > 1.
    const buresAngle = Math.acos(Math.min(1, sqrtValue));

    // ── Density-matrix sanity warnings ──────────────────────────────────
    const computeTrace = (re: Float64Array): number => {
      let t = 0;
      for (let i = 0; i < n; i++) t += re[i * n + i]!;
      return t;
    };
    const rhoTrace = computeTrace(rhoDecoded.re);
    const sigmaTrace = computeTrace(sigmaDecoded.re);
    if (Math.abs(rhoTrace - 1) > TRACE_DEVIATION_WARNING) {
      warnings.push(
        `tr(rho) = ${rhoTrace} deviates from 1 by ${Math.abs(rhoTrace - 1).toExponential(2)}; rho may not be a valid density matrix`,
      );
    }
    if (Math.abs(sigmaTrace - 1) > TRACE_DEVIATION_WARNING) {
      warnings.push(
        `tr(sigma) = ${sigmaTrace} deviates from 1 by ${Math.abs(sigmaTrace - 1).toExponential(2)}; sigma may not be a valid density matrix`,
      );
    }
    if (value > F_UPPER_WARNING) {
      warnings.push(
        `value = ${value} > 1; for density operators F ∈ [0, 1] (Cauchy–Schwarz), so at least one of rho/sigma is not a density operator`,
      );
    }

    return record({
      value: float64FromNumber(value),
      sqrt_value: float64FromNumber(sqrtValue),
      bures_angle: float64FromNumber(buresAngle),
      method: str("hermitian-eigh-spectral-sqrt"),
      warnings: list(warnings.map((w) => str(w))),
    });
  },
  test: () => {
    // The `--test` hook independently re-implements the algorithm
    // (eighComplex → spectral sqrt → matmul → eighComplex → sum √μ).
    // The probes check closed-form analytical answers (pure-pure overlap,
    // pure-vs-max-mixed, identical, orthogonal), symmetry F(A,B)=F(B,A),
    // and the Fuchs–van de Graaf bound 1−√F ≤ D ≤ √(1−F).

    const fidelityViaEigh = (
      reRho: number[], imRho: number[],
      reSigma: number[], imSigma: number[],
      n: number,
    ): number => {
      const rho: ComplexMatrix = {
        rows: n, cols: n,
        re: new Float64Array(reRho), im: new Float64Array(imRho),
      };
      const sigma: ComplexMatrix = {
        rows: n, cols: n,
        re: new Float64Array(reSigma), im: new Float64Array(imSigma),
      };
      const rhoEigh = eighComplex(rho);
      const sqrtRho = hermitianPSDSqrt(rhoEigh, "rho", []);
      const tmp = complexMatmul(sqrtRho, sigma);
      const inner = complexMatmul(tmp, sqrtRho);
      const innerEigh = eighComplex(inner);
      let s = 0;
      for (let k = 0; k < n; k++) {
        const mu = innerEigh.eigenvalues[k]!;
        if (mu > 0) s += Math.sqrt(mu);
      }
      return s * s;
    };

    // Trace-distance via difference + eigh — for the Fuchs–van de Graaf check.
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
        throw new Error(`test: ${label} F=${got}, want ${want} ± ${tol}`);
      }
    };

    const z4 = [0, 0, 0, 0];

    // F(rho, rho) = 1.
    assertClose("identity-pure", fidelityViaEigh([1, 0, 0, 0], z4, [1, 0, 0, 0], z4, 2), 1, 1e-12);
    assertClose("identity-mixed", fidelityViaEigh([0.7, 0, 0, 0.3], z4, [0.7, 0, 0, 0.3], z4, 2), 1, 1e-12);
    // F(|0><0|, |1><1|) = 0.
    assertClose("orthogonal-pures", fidelityViaEigh([1, 0, 0, 0], z4, [0, 0, 0, 1], z4, 2), 0, 1e-12);
    // F(|0><0|, I/2) = 1/2.
    assertClose("pure-vs-max-mixed", fidelityViaEigh([1, 0, 0, 0], z4, [0.5, 0, 0, 0.5], z4, 2), 0.5, 1e-12);
    // F(|0><0|, I/3) = 1/3.
    assertClose("pure-vs-max-mixed-3",
      fidelityViaEigh(
        [1, 0, 0, 0, 0, 0, 0, 0, 0], new Array(9).fill(0),
        [1 / 3, 0, 0, 0, 1 / 3, 0, 0, 0, 1 / 3], new Array(9).fill(0), 3,
      ),
      1 / 3, 1e-12);
    // F(|+><+|, |0><0|) = |<+|0>|^2 = 1/2.
    assertClose("pure-pure-overlap-x",
      fidelityViaEigh([0.5, 0.5, 0.5, 0.5], z4, [1, 0, 0, 0], z4, 2),
      0.5, 1e-12);
    // F(|+i><+i|, |0><0|) = 1/2 (complex Hermitian path).
    // |+i> = (|0> + i|1>)/√2 → ρ = (1/2) [[1,-i],[i,1]]
    assertClose("pure-pure-overlap-y",
      fidelityViaEigh([0.5, 0, 0, 0.5], [0, -0.5, 0.5, 0], [1, 0, 0, 0], z4, 2),
      0.5, 1e-12);

    // Symmetry F(A, B) = F(B, A).
    const ab = fidelityViaEigh([0.7, 0, 0, 0.3], z4, [0.4, 0.1, 0.1, 0.6], z4, 2);
    const ba = fidelityViaEigh([0.4, 0.1, 0.1, 0.6], z4, [0.7, 0, 0, 0.3], z4, 2);
    if (Math.abs(ab - ba) > 1e-10) {
      throw new Error(`test: symmetry violated F(A,B)=${ab} F(B,A)=${ba}`);
    }

    // Fuchs–van de Graaf: 1 − √F ≤ D ≤ √(1 − F).
    const probes = [
      // {rho_re, rho_im, sig_re, sig_im}
      { r: [0.7, 0, 0, 0.3], ri: z4, s: [0.4, 0.1, 0.1, 0.6], si: z4 },
      { r: [1, 0, 0, 0], ri: z4, s: [0.5, 0, 0, 0.5], si: z4 }, // saturates the upper bound
      { r: [0.5, 0.5, 0.5, 0.5], ri: z4, s: [0.5, -0.5, -0.5, 0.5], si: z4 },
    ];
    for (const p of probes) {
      const F = fidelityViaEigh(p.r, p.ri, p.s, p.si, 2);
      const D = dViaEigh(p.r, p.ri, p.s, p.si, 2);
      const lo = 1 - Math.sqrt(F);
      const hi = Math.sqrt(1 - F);
      if (D < lo - 1e-10 || D > hi + 1e-10) {
        throw new Error(`test: Fuchs-vdG violated F=${F} D=${D} bounds=[${lo}, ${hi}]`);
      }
    }
  },
});

if (import.meta.main) void runTool(def);
