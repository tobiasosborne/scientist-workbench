// =============================================================================
// compute-quantum-w1.ts — DMTL21 quantum Wasserstein-1 distance on n=1 and n=2
// =============================================================================
//
// Computes the quantum Wasserstein-1 distance of order 1
// (De Palma–Marvian–Trevisan–Lloyd 2021, "The quantum Wasserstein
// distance of order 1") for two concrete density-matrix pairs, using
// the scientist-workbench tools.
//
// Definition (DMTL21):
//
//     D_{W_1}(ρ, σ) = ||ρ − σ||_{W_1}
//                   = min_{(X_i)} Σ_{i=1}^n (1/2) ||X_i||_1
//
// where (X_1, ..., X_n) is a "transport plan" of X := ρ − σ if:
//     • X_1 + ... + X_n = X                                 (mass conservation)
//     • tr_i(X_i) = 0 for all i                             (no residual mass)
//
// Each X_i is Hermitian (since X is). The convex programme is
//
//     min  Σ_i (1/2) ||X_i||_1
//     s.t. Σ_i X_i = ρ − σ
//          tr_i(X_i) = 0 for all i
//
// Two cases:
//
//   n=1, ρ = |0⟩⟨0|, σ = |1⟩⟨1|.
//     The single-qubit problem is trivial: the only transport plan is
//     X_1 = ρ − σ (the partial-trace constraint reduces to tr(X_1) = 0,
//     which is automatic for density-matrix differences). So
//
//         D_{W_1} = (1/2) ||ρ − σ||_1 = (1/2) Σ |λ_i(ρ − σ)|
//
//     which is the *trace distance*. Computed via `linalg-eigh`.
//     Expected: D_{W_1} = 1 (= Hamming distance between |0⟩ and |1⟩).
//
//   n=2, ρ = |00⟩⟨00|, σ = |11⟩⟨11|.
//     Now we have a genuine optimisation. By the DMTL Hamming-distance
//     theorem (DMTL21 Thm 2 / Cor 1: tensor-product computational
//     basis states realise the Hamming bound), the expected answer is
//     D_{W_1} = 2 (both qubits flipped).
//
//     SDP relaxation. Write each X_i = M_i⁺ − M_i⁻ with M_i⁺, M_i⁻ ⪰ 0.
//     Then ||X_i||_1 ≤ tr(M_i⁺) + tr(M_i⁻), with equality achieved at
//     the optimum (M_i⁺ and M_i⁻ supported on the positive and negative
//     eigenspaces of X_i; standard nuclear-norm decomposition). So
//
//         min   (1/2) Σ_i (tr(M_i⁺) + tr(M_i⁻))
//         s.t.  Σ_i (M_i⁺ − M_i⁻) = ρ − σ
//               tr_i(M_i⁺ − M_i⁻) = 0  for each i
//               M_i⁺, M_i⁻ ⪰ 0
//
//     This is a real-symmetric SDP because ρ − σ = diag(1, 0, 0, −1)
//     is real and the optimum can be realised with real-symmetric X_i
//     (computational-basis states have no off-diagonal coherence to
//     transport). Four PSD blocks of size 4×4 ⇒ 4·10 = 40 svec
//     variables; 10 + 6 = 16 equality constraints.
//
// Wire: `@workbench/compose` typed barrel for both calls. The SDP
// solver `tools/sdp-solve` (ADR-0030 §B; merged on main 2026-05-11)
// uses Mehrotra IPM with Nesterov–Todd direction; the Mosek-style
// svec convention (√2 off-diagonal scaling) is handled at the wire.
//
// Historical note: a previous agent dogfooded this problem on 2026-05-10
// (commit 91e7111) and got the n=1 case working but blocked at n≥2
// pending the SDP lane. With `sdp-solve` v0.1 landed, n=2 is now
// tractable in-tree without needing the deferred `tools/partial-trace`,
// `tools/trace-norm`, or `packages/qinfo` substrate (beads 4jux, korg,
// eq4a) — we hand-roll the small amount of partial-trace and svec
// arithmetic inline.

import { loadWorkbench, typed } from "@workbench/compose";
import { float64FromNumber, type Value } from "@workbench/protocol";

// ─── svec helpers (4×4 real-symmetric) ────────────────────────────────────────
//
// Row-major upper-triangular: (0,0),(0,1),(0,2),(0,3),(1,1),(1,2),(1,3),
// (2,2),(2,3),(3,3) → svec indices 0..9. Off-diagonals carry a √2
// scaling so <C,X>_F = svec(C)ᵀ svec(X).

const SVEC4_LEN = 10;
const SQRT2 = Math.SQRT2;

function svec4Index(i: number, j: number): number {
  // Symmetric: normalise to i ≤ j.
  if (i > j) [i, j] = [j, i];
  // Row offset for "row i, starting at column i" in upper-tri storage.
  // row 0: 0..3, row 1: 4..6, row 2: 7..8, row 3: 9.
  const rowStart = [0, 4, 7, 9];
  return rowStart[i]! + (j - i);
}

/** Pack a 4×4 symmetric matrix (given as a 16-element row-major array) into svec. */
function svec4(M: readonly number[]): number[] {
  const out = new Array<number>(SVEC4_LEN).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = i; j < 4; j++) {
      const k = svec4Index(i, j);
      out[k] = i === j ? M[i * 4 + j]! : SQRT2 * M[i * 4 + j]!;
    }
  }
  return out;
}

/** Inverse: a length-10 svec → a 4×4 dense (row-major) symmetric matrix. */
function unsvec4(s: readonly number[]): number[] {
  const M = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = i; j < 4; j++) {
      const k = svec4Index(i, j);
      const v = i === j ? s[k]! : s[k]! / SQRT2;
      M[i * 4 + j] = v;
      M[j * 4 + i] = v;
    }
  }
  return M;
}

// ─── Value-construction helpers ───────────────────────────────────────────────

function f64List(xs: readonly number[]): Value {
  return { kind: "list", items: xs.map((x) => float64FromNumber(x)) };
}

function f64Matrix(rows: readonly (readonly number[])[]): Value {
  return { kind: "list", items: rows.map((r) => f64List(r)) };
}

function intVal(n: number): Value {
  return { kind: "integer", value: BigInt(n).toString() };
}

function psdCone(size: number, indices: readonly number[]): Value {
  return {
    kind: "expression",
    head: "PSDCone",
    args: [intVal(size), { kind: "list", items: indices.map((i) => intVal(i)) }],
  };
}

// ─── n=1 case via linalg-eigh ─────────────────────────────────────────────────

async function caseN1(wb: ReturnType<typeof typed>): Promise<number> {
  // ρ − σ = |0⟩⟨0| − |1⟩⟨1| = diag(1, −1).
  const A = f64Matrix([
    [1, 0],
    [0, -1],
  ]);
  const result = await wb.linalgEigh({ kind: "record", fields: { A } });
  if (result.kind !== "record") {
    throw new Error(`linalg-eigh refused: ${JSON.stringify(result)}`);
  }
  const ev = result.fields.eigenvalues;
  if (ev.kind !== "list") throw new Error("expected eigenvalues list");
  const vals = ev.items.map((v) => {
    if (v.kind !== "float64") throw new Error("non-float64 eigenvalue");
    // float64ToNumber is the inverse of float64FromNumber.
    return Number.parseFloat(
      Buffer.from(v.bits, "hex").readDoubleBE(0).toString(),
    );
  });
  // D_W1 = (1/2) Σ |λ_i|.
  const dw1 = vals.reduce((s, x) => s + Math.abs(x), 0) / 2;
  console.log(
    `[n=1] eigenvalues(ρ−σ) = [${vals.map((x) => x.toFixed(6)).join(", ")}]`,
  );
  console.log(`[n=1] D_W1 = (1/2)·Σ|λ_i| = ${dw1.toFixed(12)}   (expected 1)`);
  return dw1;
}

// ─── n=2 case via sdp-solve ───────────────────────────────────────────────────

/** Constants for the n=2 SDP variable layout.
 *  x = [ svec(M_1⁺) | svec(M_1⁻) | svec(M_2⁺) | svec(M_2⁻) ]
 *  length = 4 × 10 = 40, with cones at offsets 0, 10, 20, 30. */
const OFF = [0, 10, 20, 30] as const;
const N_VARS = 40;

/** For a 4×4 svec, build a length-10 coefficient mask for tr(M) = Σ M_ii.
 *  In svec, diagonals are entries at (i,i), so the mask is 1 on each
 *  diagonal svec slot and 0 elsewhere. No √2 scaling for diagonals. */
function trace4Mask(): number[] {
  const m = new Array<number>(SVEC4_LEN).fill(0);
  for (let i = 0; i < 4; i++) m[svec4Index(i, i)] = 1;
  return m;
}

/** For a 4×4 symmetric M on H_1 ⊗ H_2 (basis |00⟩,|01⟩,|10⟩,|11⟩),
 *  the partial trace tr_1(M) is a 2×2 symmetric matrix on H_2:
 *    tr_1(M)[0,0] = M[0,0] + M[2,2]
 *    tr_1(M)[0,1] = M[0,1] + M[2,3]
 *    tr_1(M)[1,1] = M[1,1] + M[3,3]
 *  Returns three coefficient vectors (length 10 each), one per
 *  independent entry of the symmetric 2×2 result, expressed in M's
 *  own svec. */
function partialTrace1Coeffs(): [number[], number[], number[]] {
  // Helper: coefficient row that picks M[i,j] from svec(M) (taking √2 into
  // account so the recovered linear form is in the *physical* M-entry).
  const pick = (i: number, j: number): number[] => {
    const r = new Array<number>(SVEC4_LEN).fill(0);
    const k = svec4Index(i, j);
    r[k] = i === j ? 1 : 1 / SQRT2;
    return r;
  };
  const add = (a: number[], b: number[]): number[] => a.map((x, i) => x + b[i]!);

  const row00 = add(pick(0, 0), pick(2, 2)); // tr_1(M)[0,0]
  const row01 = add(pick(0, 1), pick(2, 3)); // tr_1(M)[0,1]
  const row11 = add(pick(1, 1), pick(3, 3)); // tr_1(M)[1,1]
  return [row00, row01, row11];
}

/** Same idea for tr_2:
 *    tr_2(M)[0,0] = M[0,0] + M[1,1]
 *    tr_2(M)[0,1] = M[0,2] + M[1,3]
 *    tr_2(M)[1,1] = M[2,2] + M[3,3]. */
function partialTrace2Coeffs(): [number[], number[], number[]] {
  const pick = (i: number, j: number): number[] => {
    const r = new Array<number>(SVEC4_LEN).fill(0);
    const k = svec4Index(i, j);
    r[k] = i === j ? 1 : 1 / SQRT2;
    return r;
  };
  const add = (a: number[], b: number[]): number[] => a.map((x, i) => x + b[i]!);
  return [
    add(pick(0, 0), pick(1, 1)),
    add(pick(0, 2), pick(1, 3)),
    add(pick(2, 2), pick(3, 3)),
  ];
}

/** Embed a length-10 coefficient block into the full length-40 vector at
 *  offset `off` and with sign `sgn`. */
function blockRow(off: number, sgn: number, block: readonly number[]): number[] {
  const row = new Array<number>(N_VARS).fill(0);
  for (let k = 0; k < SVEC4_LEN; k++) row[off + k] = sgn * block[k]!;
  return row;
}

/** Add two length-N_VARS rows element-wise. */
function addRow(a: number[], b: number[]): number[] {
  return a.map((x, i) => x + b[i]!);
}

async function caseN2(wb: ReturnType<typeof typed>): Promise<number> {
  // ρ − σ = diag(1, 0, 0, −1)  (in basis |00⟩,|01⟩,|10⟩,|11⟩).
  const rhoMinusSigma = new Array<number>(16).fill(0);
  rhoMinusSigma[0] = 1; // M[0,0]
  rhoMinusSigma[15] = -1; // M[3,3]
  const rhsSvec = svec4(rhoMinusSigma);

  // Objective: (1/2)·[ tr(M_1⁺) + tr(M_1⁻) + tr(M_2⁺) + tr(M_2⁻) ].
  const trMask = trace4Mask();
  const c = new Array<number>(N_VARS).fill(0);
  for (let b = 0; b < 4; b++) {
    for (let k = 0; k < SVEC4_LEN; k++) c[OFF[b]! + k] = 0.5 * trMask[k]!;
  }

  // Constraint set.
  const A: number[][] = [];
  const bVec: number[] = [];

  // (a) Σ_i (M_i⁺ − M_i⁻) = ρ − σ, one row per svec slot k = 0..9.
  //     [+1 on M_1⁺] [−1 on M_1⁻] [+1 on M_2⁺] [−1 on M_2⁻]
  for (let k = 0; k < SVEC4_LEN; k++) {
    const row = new Array<number>(N_VARS).fill(0);
    row[OFF[0]! + k] = 1; // M_1⁺
    row[OFF[1]! + k] = -1; // M_1⁻
    row[OFF[2]! + k] = 1; // M_2⁺
    row[OFF[3]! + k] = -1; // M_2⁻
    A.push(row);
    bVec.push(rhsSvec[k]!);
  }

  // (b) tr_1(M_1⁺ − M_1⁻) = 0  — three scalar equations.
  const pt1 = partialTrace1Coeffs();
  for (const block of pt1) {
    A.push(
      addRow(
        blockRow(OFF[0]!, +1, block),
        blockRow(OFF[1]!, -1, block),
      ),
    );
    bVec.push(0);
  }

  // (c) tr_2(M_2⁺ − M_2⁻) = 0  — three scalar equations.
  const pt2 = partialTrace2Coeffs();
  for (const block of pt2) {
    A.push(
      addRow(
        blockRow(OFF[2]!, +1, block),
        blockRow(OFF[3]!, -1, block),
      ),
    );
    bVec.push(0);
  }

  console.log(`[n=2] SDP: ${A.length} eq constraints, ${N_VARS} vars, 4 PSDCones(4)`);

  const input: Value = {
    kind: "record",
    fields: {
      minimize: { kind: "record", fields: { c: f64List(c) } },
      subjectTo: {
        kind: "record",
        fields: {
          Ax_eq_b: {
            kind: "record",
            fields: { A: f64Matrix(A), b: f64List(bVec) },
          },
          cones: {
            kind: "list",
            items: [
              psdCone(4, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
              psdCone(4, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
              psdCone(4, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]),
              psdCone(4, [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]),
            ],
          },
        },
      },
    },
  };

  const result = await wb.sdpSolve(input as never);
  if (result.kind !== "record") {
    throw new Error(`sdp-solve refused: ${JSON.stringify(result, null, 2)}`);
  }
  const statusF = result.fields.status;
  const objF = result.fields.objective;
  const iterF = result.fields.iterations;
  const methodF = result.fields.method;
  if (
    statusF?.kind !== "string" ||
    iterF?.kind !== "integer" ||
    methodF?.kind !== "string"
  ) {
    throw new Error(
      `sdp-solve output missing expected fields: ${JSON.stringify(result, null, 2)}`,
    );
  }
  console.log(
    `[n=2] sdp-solve status='${statusF.value}', iter=${iterF.value}, method='${methodF.value}'`,
  );
  if (statusF.value !== "optimal") {
    throw new Error(`sdp-solve non-optimal status: ${statusF.value}`);
  }
  if (objF?.kind !== "float64") {
    throw new Error("expected float64 objective");
  }
  const dw1 = Buffer.from(objF.bits, "hex").readDoubleBE(0);

  // Recover X_1 = M_1⁺ − M_1⁻ and X_2 = M_2⁺ − M_2⁻ for inspection.
  const xField = result.fields.x;
  if (xField?.kind !== "list") throw new Error("expected x list");
  const x: number[] = xField.items.map((v) => {
    if (v.kind !== "float64") throw new Error("non-float64 x entry");
    return Buffer.from(v.bits, "hex").readDoubleBE(0);
  });
  const X1 = unsvec4(
    x.slice(OFF[0]!, OFF[0]! + SVEC4_LEN).map((v, k) =>
      v - x[OFF[1]! + k]!,
    ),
  );
  const X2 = unsvec4(
    x.slice(OFF[2]!, OFF[2]! + SVEC4_LEN).map((v, k) =>
      v - x[OFF[3]! + k]!,
    ),
  );
  const fmt = (m: number[]): string =>
    [0, 1, 2, 3]
      .map((i) =>
        [0, 1, 2, 3].map((j) => m[i * 4 + j]!.toFixed(3).padStart(7)).join(" "),
      )
      .join("\n      ");
  console.log(`[n=2] recovered X_1 =\n      ${fmt(X1)}`);
  console.log(`[n=2] recovered X_2 =\n      ${fmt(X2)}`);
  console.log(`[n=2] D_W1 = ${dw1.toFixed(12)}   (expected 2)`);

  return dw1;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wb = typed(await loadWorkbench());
  console.log("=== n=1: ρ=|0⟩⟨0|, σ=|1⟩⟨1| — via linalg-eigh ===\n");
  const d1 = await caseN1(wb);
  console.log("\n=== n=2: ρ=|00⟩⟨00|, σ=|11⟩⟨11| — via sdp-solve ===\n");
  const d2 = await caseN2(wb);
  console.log("\n=== summary ===");
  console.log(`  D_W1(|0⟩⟨0|, |1⟩⟨1|)   = ${d1.toFixed(12)}   (Hamming = 1)`);
  console.log(`  D_W1(|00⟩⟨00|, |11⟩⟨11|) = ${d2.toFixed(12)}   (Hamming = 2)`);
}

await main();
