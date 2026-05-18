// fidelity goldens — full coverage of the v0.1 Uhlmann fidelity:
// pure-pure overlap (|⟨ψ|φ⟩|² at varying angles), pure-vs-max-mixed
// (F = 1/d at d = 2, 3, 4), identical states (F = 1), orthogonal
// pure states (F = 0), Bell-state projector pairs (orthogonal
// Bell ⇒ F = 0; identical ⇒ F = 1), classical bit-flip pairs,
// complex-Hermitian Bloch states (the dogfood case), symmetry probe
// (F(A, B) = F(B, A)), and every boundary category.

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
  // ── identical states (F = 1) ────────────────────────────────────────────
  { description: "F(|0><0|, |0><0|) = 1 identical pure",
    input: realInp([[1, 0], [0, 0]], [[1, 0], [0, 0]]) },
  { description: "F(diag(0.7,0.3), diag(0.7,0.3)) = 1 identical mixed",
    input: realInp([[0.7, 0], [0, 0.3]], [[0.7, 0], [0, 0.3]]) },
  { description: "F(I/2, I/2) = 1 identical maximally mixed",
    input: realInp([[0.5, 0], [0, 0.5]], [[0.5, 0], [0, 0.5]]) },
  { description: "F(|Phi+><Phi+|, |Phi+><Phi+|) = 1 identical Bell",
    input: realInp(
      [[0.5, 0, 0, 0.5], [0, 0, 0, 0], [0, 0, 0, 0], [0.5, 0, 0, 0.5]],
      [[0.5, 0, 0, 0.5], [0, 0, 0, 0], [0, 0, 0, 0], [0.5, 0, 0, 0.5]],
    ) },

  // ── orthogonal pure states (F = 0) ──────────────────────────────────────
  { description: "F(|0><0|, |1><1|) = 0 orthogonal computational basis",
    input: realInp([[1, 0], [0, 0]], [[0, 0], [0, 1]]) },
  { description: "F(|+><+|, |-><-|) = 0 orthogonal X eigenbasis",
    input: realInp([[0.5, 0.5], [0.5, 0.5]], [[0.5, -0.5], [-0.5, 0.5]]) },
  { description: "F(|+i><+i|, |-i><-i|) = 0 orthogonal Y eigenbasis complex-Hermitian",
    input: inp(
      [[0.5, 0], [0, 0.5]], [[0, -0.5], [0.5, 0]],
      [[0.5, 0], [0, 0.5]], [[0, 0.5], [-0.5, 0]],
    ) },
  { description: "F(|0><0|, |2><2|) = 0 orthogonal qutrit",
    input: realInp(
      [[1, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[0, 0, 0], [0, 0, 0], [0, 0, 1]],
    ) },

  // ── pure-pure overlap |<psi|phi>|^2 at various angles ───────────────────
  // F(|0><0|, |+><+|) = |<0|+>|² = 1/2
  { description: "F(|0><0|, |+><+|) = 1/2 X eigenstate vs computational",
    input: realInp([[1, 0], [0, 0]], [[0.5, 0.5], [0.5, 0.5]]) },
  // F(|0><0|, |+i><+i|) = 1/2 (complex Hermitian)
  { description: "F(|0><0|, |+i><+i|) = 1/2 Y eigenstate vs computational complex-Hermitian",
    input: inp(
      [[1, 0], [0, 0]], [[0, 0], [0, 0]],
      [[0.5, 0], [0, 0.5]], [[0, -0.5], [0.5, 0]],
    ) },
  // F(|+><+|, |+i><+i|) = 1/2 (between X and Y eigenstates)
  { description: "F(|+><+|, |+i><+i|) = 1/2 X vs Y eigenstate complex-Hermitian",
    input: inp(
      [[0.5, 0.5], [0.5, 0.5]], [[0, 0], [0, 0]],
      [[0.5, 0], [0, 0.5]], [[0, -0.5], [0.5, 0]],
    ) },

  // ── pure vs maximally mixed: F = 1/d ────────────────────────────────────
  { description: "F(|0><0|, I/2) = 1/2 pure vs qubit max-mixed",
    input: realInp([[1, 0], [0, 0]], [[0.5, 0], [0, 0.5]]) },
  { description: "F(|0><0|, I/3) = 1/3 pure vs qutrit max-mixed",
    input: realInp(
      [[1, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]],
    ) },
  { description: "F(|0><0| tensor |0><0|, I/4) = 1/4 pure vs two-qubit max-mixed",
    input: realInp(
      [[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      [[0.25, 0, 0, 0], [0, 0.25, 0, 0], [0, 0, 0.25, 0], [0, 0, 0, 0.25]],
    ) },

  // ── flipped classical bits: F = (sqrt p sqrt q + sqrt (1−p) sqrt (1−q))² ─
  // For diag(p, 1−p) vs diag(q, 1−q) the closed form is (√(pq) + √((1−p)(1−q)))².
  { description: "F(diag(0.7,0.3), diag(0.3,0.7)) closed form (√.21 + √.21)² = 0.84",
    input: realInp([[0.7, 0], [0, 0.3]], [[0.3, 0], [0, 0.7]]) },
  { description: "F(diag(0.9,0.1), diag(0.1,0.9)) closed form 0.36",
    input: realInp([[0.9, 0], [0, 0.1]], [[0.1, 0], [0, 0.9]]) },

  // ── Bloch X-Z plane pure states at small angles (high overlap) ──────────
  // ρ = (I + 0.99 X)/2, σ = (I + 0.99 Z)/2 — pure states near surface.
  // Wait actually these aren't pure — pure requires |r|=1. Use almost-pure mixtures.
  // Trace-vs-trace overlap on these is straightforward to compute via eigh.
  { description: "F for Bloch X vs Bloch Z (nearly opposite Bloch vectors)",
    input: realInp([[0.5, 0.3], [0.3, 0.5]], [[0.8, 0], [0, 0.2]]) },

  // ── complex Hermitian Bloch with Y component (dogfood) ──────────────────
  // Two Bloch states differing only in Y sign: r_ρ = (0.4, 0.5, 0.2),
  // r_σ = (0.4, -0.5, 0.2). The fidelity has a closed form via Bloch
  // formula F = (1 + r_ρ · r_σ + √((1 − |r_ρ|²)(1 − |r_σ|²)))/2.
  { description: "F for two Bloch states differing only in Y sign — complex-Hermitian dogfood",
    input: inp(
      [[0.6, 0.2], [0.2, 0.4]], [[0, -0.25], [0.25, 0]],
      [[0.6, 0.2], [0.2, 0.4]], [[0, 0.25], [-0.25, 0]],
    ) },

  // ── orthogonal Bell-state projectors (F = 0) ────────────────────────────
  { description: "F(|Phi+><Phi+|, |Phi-><Phi-|) = 0 orthogonal Bell pair",
    input: realInp(
      [[0.5, 0, 0, 0.5], [0, 0, 0, 0], [0, 0, 0, 0], [0.5, 0, 0, 0.5]],
      [[0.5, 0, 0, -0.5], [0, 0, 0, 0], [0, 0, 0, 0], [-0.5, 0, 0, 0.5]],
    ) },

  // ── symmetry probe ──────────────────────────────────────────────────────
  { description: "symmetry probe AB: F(diag(0.7,0.3), [[0.4,0.1],[0.1,0.6]])",
    input: realInp([[0.7, 0], [0, 0.3]], [[0.4, 0.1], [0.1, 0.6]]) },
  { description: "symmetry probe BA: F([[0.4,0.1],[0.1,0.6]], diag(0.7,0.3)) — same value as previous",
    input: realInp([[0.4, 0.1], [0.1, 0.6]], [[0.7, 0], [0, 0.3]]) },

  // ── classical-vs-pure (closed form: F = p where ρ = diag(p, 1−p), σ = |0><0|) ─
  { description: "F(diag(0.8, 0.2), |0><0|) = 0.8 mixed vs pure",
    input: realInp([[0.8, 0], [0, 0.2]], [[1, 0], [0, 0]]) },

  // ── boundary categories ─────────────────────────────────────────────────
  { description: "non-Hermitian rho tagged non-hermitian-input which=rho",
    input: realInp([[1, 2], [3, 0]], [[0.5, 0], [0, 0.5]]) },
  { description: "non-Hermitian sigma tagged non-hermitian-input which=sigma",
    input: inp(
      [[0.5, 0], [0, 0.5]], [[0, 0], [0, 0]],
      [[0, 1], [1, 0]], [[0, 1], [1, 0]],
    ) },
  { description: "shape-mismatch 2x2 vs 3x3 tagged shape-mismatch",
    input: realInp(
      [[0.5, 0], [0, 0.5]],
      [[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]],
    ) },
  { description: "non-finite rho NaN tagged non-finite-input which=rho",
    input: realInp([[1, 0], [0, NaN]], [[0.5, 0], [0, 0.5]]) },
  { description: "non-finite sigma Infinity tagged non-finite-input which=sigma",
    input: realInp([[0.5, 0], [0, 0.5]], [[1, 0], [0, Infinity]]) },
  { description: "degenerate n=0 tagged degenerate-shape",
    input: record({
      rho: record({ re: list([]), im: list([]) }),
      sigma: record({ re: list([]), im: list([]) }),
    }) },
];
