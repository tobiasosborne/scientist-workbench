// trace-distance goldens — full coverage of the v0.1 Hermitian path:
// orthogonal-pure-states-saturate (=1) at d=2, 3, complex Pauli-Y
// eigenstates; identity-of-indiscernibles (=0); pure-vs-max-mixed
// (=1−1/d) at d=2, 3, 4; Bloch-vector pairs (analytic |Δr|/2);
// orthogonal Bell-state projectors (=1); symmetry probes (input swap
// gives same value); triangle-inequality probes (encoded via three
// sequential pairs); and every boundary category (non-Hermitian-rho,
// non-Hermitian-sigma, shape-mismatch, non-finite-rho, non-finite-sigma,
// degenerate).

import {
  float64FromNumber,
  list,
  record,
  type Float64Value,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function f(x: number): Float64Value {
  return float64FromNumber(x);
}
function vec(xs: readonly number[]): {
  readonly kind: "list";
  readonly items: readonly Float64Value[];
} {
  return list(xs.map(f));
}
function mat(rows: readonly (readonly number[])[]): {
  readonly kind: "list";
  readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[];
} {
  return list(rows.map((r) => vec(r)));
}

function complexM(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({ re: mat(reRows), im: mat(imRows) });
}

function inp(
  rhoRe: readonly (readonly number[])[],
  rhoIm: readonly (readonly number[])[],
  sigmaRe: readonly (readonly number[])[],
  sigmaIm: readonly (readonly number[])[],
) {
  return record({
    rho: complexM(rhoRe, rhoIm),
    sigma: complexM(sigmaRe, sigmaIm),
  });
}

function zeros(rows: number, cols: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < rows; i++) out.push(new Array<number>(cols).fill(0));
  return out;
}

function realInp(
  rho: readonly (readonly number[])[],
  sigma: readonly (readonly number[])[],
) {
  return inp(rho, zeros(rho.length, rho[0]!.length), sigma, zeros(sigma.length, sigma[0]!.length));
}

export const goldens: GoldenSpec[] = [
  // ── orthogonal pure states saturate the bound (D = 1) ───────────────────
  { description: "D(|0><0|, |1><1|) = 1 orthogonal computational pure",
    input: realInp([[1, 0], [0, 0]], [[0, 0], [0, 1]]) },
  { description: "D(|+><+|, |-><-|) = 1 orthogonal X eigenbasis",
    input: realInp([[0.5, 0.5], [0.5, 0.5]], [[0.5, -0.5], [-0.5, 0.5]]) },
  { description: "D(|+i><+i|, |-i><-i|) = 1 orthogonal Y eigenbasis complex-Hermitian",
    input: inp(
      [[0.5, 0], [0, 0.5]], [[0, -0.5], [0.5, 0]],
      [[0.5, 0], [0, 0.5]], [[0, 0.5], [-0.5, 0]],
    ) },
  { description: "D(|0><0|, |2><2|) = 1 orthogonal qutrit computational",
    input: realInp([[1, 0, 0], [0, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 0], [0, 0, 1]]) },

  // ── identical states (D = 0) ────────────────────────────────────────────
  { description: "D(|0><0|, |0><0|) = 0 identical pure state",
    input: realInp([[1, 0], [0, 0]], [[1, 0], [0, 0]]) },
  { description: "D(diag(0.7,0.3), diag(0.7,0.3)) = 0 identical classical mix",
    input: realInp([[0.7, 0], [0, 0.3]], [[0.7, 0], [0, 0.3]]) },
  { description: "D(I/2, I/2) = 0 identical maximally mixed",
    input: realInp([[0.5, 0], [0, 0.5]], [[0.5, 0], [0, 0.5]]) },

  // ── pure-vs-max-mixed: D = 1 − 1/d ──────────────────────────────────────
  { description: "D(|0><0|, I/2) = 1/2 pure vs qubit max-mixed",
    input: realInp([[1, 0], [0, 0]], [[0.5, 0], [0, 0.5]]) },
  { description: "D(|0><0|, I/3) = 2/3 pure vs qutrit max-mixed",
    input: realInp(
      [[1, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]],
    ) },
  { description: "D(|0><0| tensor |0><0|, I/4) = 3/4 pure vs two-qubit max-mixed",
    input: realInp(
      [[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      [[0.25, 0, 0, 0], [0, 0.25, 0, 0], [0, 0, 0.25, 0], [0, 0, 0, 0.25]],
    ) },

  // ── Bell-state projectors are pairwise orthogonal (D = 1) ───────────────
  { description: "D(|Phi+><Phi+|, |Phi-><Phi-|) = 1 orthogonal Bell pair",
    input: realInp(
      [[0.5, 0, 0, 0.5], [0, 0, 0, 0], [0, 0, 0, 0], [0.5, 0, 0, 0.5]],
      [[0.5, 0, 0, -0.5], [0, 0, 0, 0], [0, 0, 0, 0], [-0.5, 0, 0, 0.5]],
    ) },
  { description: "D(|Phi+><Phi+|, |Psi+><Psi+|) = 1 orthogonal Bell pair",
    input: realInp(
      [[0.5, 0, 0, 0.5], [0, 0, 0, 0], [0, 0, 0, 0], [0.5, 0, 0, 0.5]],
      [[0, 0, 0, 0], [0, 0.5, 0.5, 0], [0, 0.5, 0.5, 0], [0, 0, 0, 0]],
    ) },

  // ── flipped classical bits: D = |p − q| ─────────────────────────────────
  { description: "D(diag(0.7,0.3), diag(0.3,0.7)) = 0.4 flipped classical",
    input: realInp([[0.7, 0], [0, 0.3]], [[0.3, 0], [0, 0.7]]) },
  { description: "D(diag(0.9,0.1), diag(0.1,0.9)) = 0.8 near-pure classical flip",
    input: realInp([[0.9, 0], [0, 0.1]], [[0.1, 0], [0, 0.9]]) },

  // ── Bloch X-Z plane (D = (1/2)|Δr|) ─────────────────────────────────────
  // ρ = (I + 0.6 X)/2 = [[0.5, 0.3], [0.3, 0.5]]; r_ρ = (0.6, 0, 0).
  // σ = (I + 0.6 Z)/2 = [[0.8, 0], [0, 0.2]];     r_σ = (0, 0, 0.6).
  // |Δr| = √(0.36 + 0.36) = √0.72; D = √0.72 / 2 ≈ 0.424264069
  { description: "D for Bloch X vs Bloch Z = sqrt(0.72)/2 Bloch-vector geometric",
    input: realInp([[0.5, 0.3], [0.3, 0.5]], [[0.8, 0], [0, 0.2]]) },

  // ── pure vs near-pure mixture: small D ──────────────────────────────────
  { description: "D(|0><0|, diag(0.99, 0.01)) = 0.01 near-zero distance",
    input: realInp([[1, 0], [0, 0]], [[0.99, 0], [0, 0.01]]) },

  // ── complex Hermitian Bloch with Y component (the dogfood case) ─────────
  // ρ = (I + 0.4 X + 0.5 Y + 0.2 Z)/2; σ = (I + 0.4 X − 0.5 Y + 0.2 Z)/2
  // Δr = (0, 1.0, 0); |Δr|/2 = 0.5
  { description: "D for two Bloch states differing only in Y component = 0.5 complex-Hermitian",
    input: inp(
      [[0.6, 0.2], [0.2, 0.4]], [[0, -0.25], [0.25, 0]],
      [[0.6, 0.2], [0.2, 0.4]], [[0, 0.25], [-0.25, 0]],
    ) },

  // ── symmetry probe: D(A, B) and D(B, A) produce the same value ──────────
  { description: "symmetry probe AB: D(diag(0.7,0.3), [[0.4,0.1],[0.1,0.6]])",
    input: realInp([[0.7, 0], [0, 0.3]], [[0.4, 0.1], [0.1, 0.6]]) },
  { description: "symmetry probe BA: D([[0.4,0.1],[0.1,0.6]], diag(0.7,0.3)) — same value as previous",
    input: realInp([[0.4, 0.1], [0.1, 0.6]], [[0.7, 0], [0, 0.3]]) },

  // ── triangle probes: three pairs whose D values bound each other ────────
  // Diagonal mixtures: D(diag(p,1−p), diag(q,1−q)) = |p−q|.
  // rho=0.8, sig=0.5, tau=0.2 ⇒ D(ρ,σ)=0.3, D(σ,τ)=0.3, D(ρ,τ)=0.6 — saturating.
  { description: "triangle ρ-σ: D(diag(0.8, 0.2), diag(0.5, 0.5)) = 0.3",
    input: realInp([[0.8, 0], [0, 0.2]], [[0.5, 0], [0, 0.5]]) },
  { description: "triangle σ-τ: D(diag(0.5, 0.5), diag(0.2, 0.8)) = 0.3",
    input: realInp([[0.5, 0], [0, 0.5]], [[0.2, 0], [0, 0.8]]) },
  { description: "triangle ρ-τ: D(diag(0.8, 0.2), diag(0.2, 0.8)) = 0.6 saturates the bound",
    input: realInp([[0.8, 0], [0, 0.2]], [[0.2, 0], [0, 0.8]]) },

  // ── 3×3 generic Hermitian density operators ─────────────────────────────
  { description: "qutrit mix vs different qutrit mix",
    input: realInp(
      [[0.5, 0, 0], [0, 0.3, 0], [0, 0, 0.2]],
      [[0.2, 0, 0], [0, 0.3, 0], [0, 0, 0.5]],
    ) },

  // ── boundary categories ─────────────────────────────────────────────────
  // Non-Hermitian rho (re asymmetric).
  { description: "non-Hermitian rho re-asymmetric tagged non-hermitian-input which=rho",
    input: realInp([[1, 2], [3, 0]], [[0.5, 0], [0, 0.5]]) },
  // Non-Hermitian sigma (im symmetric, should be antisymmetric).
  { description: "non-Hermitian sigma symmetric-im tagged non-hermitian-input which=sigma",
    input: inp(
      [[0.5, 0], [0, 0.5]], [[0, 0], [0, 0]],
      [[0, 1], [1, 0]], [[0, 1], [1, 0]],
    ) },
  // Shape mismatch.
  { description: "shape mismatch 2x2 vs 3x3 tagged shape-mismatch",
    input: realInp(
      [[0.5, 0], [0, 0.5]],
      [[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]],
    ) },
  // Non-finite rho.
  { description: "non-finite rho NaN tagged non-finite-input which=rho",
    input: realInp([[1, 0], [0, NaN]], [[0.5, 0], [0, 0.5]]) },
  // Non-finite sigma.
  { description: "non-finite sigma Infinity tagged non-finite-input which=sigma",
    input: realInp([[0.5, 0], [0, 0.5]], [[1, 0], [0, Infinity]]) },
  // Degenerate.
  { description: "degenerate n=0 tagged degenerate-shape",
    input: record({
      rho: record({ re: list([]), im: list([]) }),
      sigma: record({ re: list([]), im: list([]) }),
    }) },
];
