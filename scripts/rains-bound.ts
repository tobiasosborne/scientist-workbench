// =============================================================================
// rains-bound.ts — compute the Rains bound on the distillable entanglement
// of a 2-qubit bipartite state, end-to-end on the workbench.
// =============================================================================
//
// What is the Rains bound?
// ------------------------
// For a bipartite state ρ_{AB}, the (logarithmic) Rains bound is a
// computable SDP upper bound on the distillable entanglement
// E_D(ρ_{AB}). The original Rains (1999) formulation:
//
//     R(ρ_{AB})  :=  log₂ W(ρ_{AB})
//     W(ρ_{AB})  :=  min_σ  ‖σ^{T_B}‖_1   subject to   σ ⪰ ρ_{AB}.
//
// `σ^{T_B}` is the partial transpose on subsystem B; the trace norm
// `‖·‖_1` is the sum of singular values (= sum of |eigenvalues| for a
// Hermitian argument). The bound is tighter than (or equal to) the
// log-negativity `E_N(ρ) = log₂ ‖ρ^{T_B}‖_1`, which is the same
// expression but with σ fixed to ρ rather than minimised.
//
// SDP wire form
// -------------
// Splitting `σ^{T_B} = R_+ − R_-` with `R_± ⪰ 0` linearises the trace
// norm: `‖σ^{T_B}‖_1 = Tr(R_+) + Tr(R_-)`. Substituting `X = σ − ρ ⪰ 0`
// (so `σ ⪰ ρ` ⟺ `X ⪰ 0`) eliminates σ and gives a clean three-PSD-block
// SDP with one matrix equality:
//
//     minimize     Tr(R_+) + Tr(R_-)
//     subject to   (X + ρ)^{T_B}  =  R_+ − R_-
//                  X, R_+, R_-    ⪰  0.
//
// In svec wire (`d = d_A · d_B = 4` for 2 qubits, svec_len = 10):
//   x[0..9]   = svec(X)
//   x[10..19] = svec(R_+)
//   x[20..29] = svec(R_-)
//
// The partial-transpose-on-B for `dims = [2, 2]` is a pure index
// permutation: only `M[0,3]` and `M[1,2]` are swapped (all other upper-
// triangle entries are fixed). In svec coordinates this collapses to a
// swap of positions 3 ↔ 5, with the √2 scaling preserved (both
// positions are off-diagonal). That's the entire complication.
//
// References
// ----------
//   Rains, IEEE Trans. Inf. Theory 47, 2921 (2001), "A semidefinite
//     program for distillable entanglement."
//   Wang, Duan, PRA 94, 050301(R) (2016), "Improved semidefinite
//     programming upper bound on distillable entanglement."
//   Horodecki⁴, Rev. Mod. Phys. 81, 865 (2009), §XII (Rains bound and
//     PPT-preserving operations).
//
// This script is the first end-to-end demonstration of `tools/sdp-solve`
// + `tools/partial-transpose` + `packages/qinfo` composing for a real
// quantum-information problem.

import {
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  type Value,
  type Float64Value,
  type ListValueOf,
} from "@workbench/protocol";
import { loadWorkbench, typed } from "@workbench/compose";

// -----------------------------------------------------------------------------
// svec helpers (Mosek strict format)
// -----------------------------------------------------------------------------
//
// Strict-Mosek svec: diagonal entries unscaled, off-diagonal entries
// scaled by √2 so that `⟨C, X⟩_F = svec(C)ᵀ · svec(X)` exactly. svec
// ordering is row-major upper-triangular: for n = 4 the diagonal
// entries land at k ∈ {0, 4, 7, 9}.

const SQRT2 = Math.SQRT2;

function svecLen(n: number): number {
  return (n * (n + 1)) / 2;
}

/** svec-index of (i, j) for i ≤ j in an n × n symmetric matrix. */
function svecIndex(n: number, i: number, j: number): number {
  // sum of row sizes before row i is (i*n - i*(i-1)/2); within row i,
  // the (i,j) entry is at offset (j - i).
  return i * n - (i * (i - 1)) / 2 + (j - i);
}

/** Indices in svec where the matrix entry is on the diagonal (i == j). */
function diagonalSvecIndices(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(svecIndex(n, i, i));
  return out;
}

/** Mosek svec of a symmetric n × n matrix (row-major upper-tri, √2 off-diag). */
function svec(M: number[][]): number[] {
  const n = M.length;
  const out: number[] = new Array(svecLen(n)).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = M[i]![j]!;
      out[svecIndex(n, i, j)] = i === j ? v : SQRT2 * v;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Partial-transpose svec-permutation for dims = [2, 2]
// -----------------------------------------------------------------------------
//
// For two qubits, PT_B swaps only matrix entries M[0,3] ↔ M[1,2] and
// leaves all other upper-triangle entries fixed. In svec coordinates
// (n = 4): positions 3 (= M[0,3]) and 5 (= M[1,2]) swap; all others
// are identity. No sign flips, no √2 rescaling — both involved
// positions are off-diagonal so the √2 factor is consistent on both
// sides of the swap.
//
// Returns a function svec_vec → svec(PT_B(matrix represented by input)).

function pt22Svec(svec_in: readonly number[]): number[] {
  const out = svec_in.slice();
  // Swap positions 3 and 5.
  const tmp = out[3]!;
  out[3] = out[5]!;
  out[5] = tmp;
  return out;
}

// -----------------------------------------------------------------------------
// Build the Rains-bound SDP wire for a 2-qubit ρ.
// -----------------------------------------------------------------------------

function buildRainsSdpWire(rho: number[][]): Value {
  const n = 4; // d_A · d_B for two qubits
  const L = svecLen(n); // 10
  const nVars = 3 * L; // 30

  // Index slices:
  //   x[0   .. L-1]    = svec(X)        — variable σ - ρ ⪰ 0
  //   x[L   .. 2L-1]   = svec(R_+)      — positive part of σ^{T_B}
  //   x[2L  .. 3L-1]   = svec(R_-)      — negative part of σ^{T_B}
  const offX = 0;
  const offRp = L;
  const offRm = 2 * L;

  // Equality `(X + ρ)^{T_B} = R_+ − R_-` in svec coordinates. The
  // partial-transpose permutation is a single swap of positions 3 ↔ 5.
  // For each k ∈ [0, L), the equation is:
  //
  //     svec((X+ρ)^{T_B})[k] − svec(R_+)[k] + svec(R_-)[k] = 0
  //
  // Splitting svec(X+ρ) = svec(X) + svec(ρ) and isolating the
  // constant on the RHS:
  //
  //     π(svec(X))[k] − svec(R_+)[k] + svec(R_-)[k] = −π(svec(ρ))[k]
  //
  // where π is the partial-transpose svec permutation.

  const svecRho = svec(rho);
  const svecRhoPt = pt22Svec(svecRho);

  // π(svec(X))[k] picks svec(X)[π(k)]; for the dims=[2,2] swap,
  // π(k) = k for k ∉ {3,5}, π(3)=5, π(5)=3.
  const piInv = (k: number) => (k === 3 ? 5 : k === 5 ? 3 : k);

  const A: number[][] = [];
  const bVec: number[] = [];
  for (let k = 0; k < L; k++) {
    const row = new Array(nVars).fill(0) as number[];
    row[offX + piInv(k)] = 1; // π(svec(X))[k] = svec(X)[π(k)] (π is its own inverse here)
    row[offRp + k] = -1;
    row[offRm + k] = +1;
    A.push(row);
    bVec.push(-svecRhoPt[k]!);
  }

  // Objective: minimize Tr(R_+) + Tr(R_-). In svec the trace is just
  // the sum of diagonal-svec entries (those entries are unscaled).
  const cVec = new Array(nVars).fill(0) as number[];
  const diagIdx = diagonalSvecIndices(n);
  for (const di of diagIdx) {
    cVec[offRp + di] = 1;
    cVec[offRm + di] = 1;
  }

  // Three PSDCone[4, indices] cones, one per block.
  const idxX = Array.from({ length: L }, (_, i) => offX + i);
  const idxRp = Array.from({ length: L }, (_, i) => offRp + i);
  const idxRm = Array.from({ length: L }, (_, i) => offRm + i);

  return record({
    minimize: record({
      c: list(cVec.map(float64FromNumber)),
    }),
    subjectTo: record({
      Ax_eq_b: record({
        A: list(A.map((row) => list(row.map(float64FromNumber)))),
        b: list(bVec.map(float64FromNumber)),
      }),
      cones: list([
        expr("PSDCone", [int(BigInt(n)), list(idxX.map((i) => int(BigInt(i))))]),
        expr("PSDCone", [int(BigInt(n)), list(idxRp.map((i) => int(BigInt(i))))]),
        expr("PSDCone", [int(BigInt(n)), list(idxRm.map((i) => int(BigInt(i))))]),
      ]),
    }),
  });
}

// -----------------------------------------------------------------------------
// Workbench composition
// -----------------------------------------------------------------------------

const workbench = await loadWorkbench();
const wb = typed(workbench);

async function rainsBound(rho: number[][]): Promise<{
  R: number;
  W: number;
  status: string;
  iter: string;
  achieved_precision: number;
}> {
  const out = await wb.sdpSolve(buildRainsSdpWire(rho) as never);
  if (out.kind !== "record") {
    throw new Error(`rainsBound: sdp-solve did not return a record (got ${out.kind})`);
  }
  const status = (out.fields["status"] as { kind: "string"; value: string }).value;
  const objField = out.fields["objective"];
  const apField = out.fields["achieved_precision"];
  const iterField = out.fields["iterations"];
  const W =
    objField?.kind === "float64" ? float64ToNumber(objField as never) : NaN;
  const ap =
    apField?.kind === "float64" ? float64ToNumber(apField as never) : NaN;
  const iter =
    iterField?.kind === "integer"
      ? (iterField as { kind: "integer"; value: string }).value
      : "?";
  return {
    R: Math.log2(W),
    W,
    status,
    iter,
    achieved_precision: ap,
  };
}

async function logNegativity(rho: number[][]): Promise<number> {
  const pt = await wb.partialTranspose({
    kind: "record",
    fields: {
      M: list(rho.map((r) => list(r.map(float64FromNumber)))),
      dims: list([int(2n), int(2n)]),
      transposeOn: list([int(1n)]),
    },
  });
  if (pt.kind !== "record") throw new Error("partial-transpose returned non-record");
  const eig = await wb.linalgEigh({
    kind: "record",
    // partial-transpose's contract guarantees `M_pt` is a
    // `list<list<float64>>` matrix — assert the element type the typed
    // barrel requires.
    fields: { A: pt.fields["M_pt"]! as ListValueOf<ListValueOf<Float64Value>> },
  });
  if (eig.kind !== "record") throw new Error("linalg-eigh returned non-record");
  const eigs = (eig.fields["eigenvalues"] as { kind: "list"; items: Value[] })
    .items;
  let s = 0;
  for (const e of eigs) {
    if (e.kind === "float64") s += Math.abs(float64ToNumber(e as never));
  }
  return Math.log2(s);
}

// -----------------------------------------------------------------------------
// Canonical test states (2-qubit bipartite)
// -----------------------------------------------------------------------------

// Bell state |Φ+⟩⟨Φ+| with |Φ+⟩ = (|00⟩ + |11⟩)/√2.
const Bell = [
  [0.5, 0, 0, 0.5],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0.5, 0, 0, 0.5],
];

// Maximally mixed I/4.
const MaxMixed = (() => {
  const M = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => 0));
  for (let i = 0; i < 4; i++) M[i]![i] = 0.25;
  return M;
})();

// Werner-isotropic state p · |Φ+⟩⟨Φ+| + (1 − p) · I/4.
function werner(p: number): number[][] {
  const M = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => 0));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      M[i]![j] = p * Bell[i]![j]! + (1 - p) * MaxMixed[i]![j]!;
    }
  }
  return M;
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

function report(
  label: string,
  rains: Awaited<ReturnType<typeof rainsBound>>,
  logNeg: number,
  predicted: string,
) {
  console.log(`\n  ${label}`);
  console.log(
    `    Rains bound R(ρ)     = log₂(${rains.W.toFixed(6)}) = ${rains.R.toFixed(6)}  (predicted: ${predicted})`,
  );
  console.log(`    log-negativity E_N(ρ) = ${logNeg.toFixed(6)}`);
  console.log(
    `    SDP status            = ${rains.status} (iter ${rains.iter}, ap = ${rains.achieved_precision.toExponential(2)})`,
  );
}

console.log("=".repeat(72));
console.log("  Rains bound for 2-qubit bipartite states");
console.log("  Wire: 3 PSD blocks (size 4) in svec; PT_B is svec-swap of (3, 5).");
console.log("=".repeat(72));

const bellR = await rainsBound(Bell);
const bellN = await logNegativity(Bell);
report("Bell state  |Φ+⟩⟨Φ+|", bellR, bellN, "log₂(2) = 1");

const mixedR = await rainsBound(MaxMixed);
const mixedN = await logNegativity(MaxMixed);
report("Maximally mixed I/4", mixedR, mixedN, "0 (separable)");

for (const p of [0.4, 0.6, 0.8, 1.0]) {
  const wR = await rainsBound(werner(p));
  const wN = await logNegativity(werner(p));
  // Predicted log-neg for p > 1/3:  log₂((1 + 3p) / 2)
  const predN = p > 1 / 3 ? Math.log2((1 + 3 * p) / 2).toFixed(6) : "0";
  report(`Werner state at p = ${p}`, wR, wN, `log-neg ≈ ${predN} (Rains = log-neg here)`);
}

console.log("\n" + "=".repeat(72));
console.log(
  "  Rains ≤ log-negativity for every state (Rains is the tighter bound).",
);
console.log(
  "  Equality holds for Werner-isotropic states; the gap opens on generic",
);
console.log("  non-symmetric mixed states.");
console.log("=".repeat(72));
