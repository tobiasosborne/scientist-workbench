import { float64FromNumber, int, list, record, tagged } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Helper: 2D number array → list<list<float64>> Value.
function m(rows: number[][]) {
  return list(rows.map((r) => list(r.map(float64FromNumber))));
}

// Forward (channel → Choi) input record builder.
function fwd(channel: number[][], dim_in: number, dim_out: number) {
  return tagged(
    "channel-to-choi",
    record({
      channel: m(channel),
      dim_in: int(BigInt(dim_in)),
      dim_out: int(BigInt(dim_out)),
    }),
  );
}

// Inverse (Choi → channel) input record builder.
function inv(J: number[][], dim_in: number, dim_out: number) {
  return tagged(
    "choi-to-channel",
    record({
      J: m(J),
      dim_in: int(BigInt(dim_in)),
      dim_out: int(BigInt(dim_out)),
    }),
  );
}

// Common matrices.
const I4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const I9 = Array.from({ length: 9 }, (_, i) =>
  Array.from({ length: 9 }, (_, j) => (i === j ? 1 : 0)),
);
const Omega2 = [
  // |Ω⟩⟨Ω| with |Ω⟩ = |00⟩ + |11⟩ (unnormalised maxent on a qubit).
  [1, 0, 0, 1],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [1, 0, 0, 1],
];
const SWAP4 = [
  [1, 0, 0, 0],
  [0, 0, 1, 0],
  [0, 1, 0, 0],
  [0, 0, 0, 1],
];

// Depolarising channel at p = 1/2 (qubit). Superoperator computed
// analytically in tool.ts; verified against the canonical Choi formula
// (1−p)|Ω⟩⟨Ω| + (p/2)I_4 — see Sonnet research summary at session start.
const Depol_half_S = [
  [3 / 4, 0, 0, 1 / 4],
  [0, 1 / 4, 0, 0],
  [0, 0, 1 / 4, 0],
  [1 / 4, 0, 0, 3 / 4],
];

// Completely depolarising channel (p = 1): Φ(ρ) = (I/2) tr(ρ).
// S = (1/2) vec(I) vec(I)ᵀ = (1/2) [[1,0,0,1],[0,0,0,0],[0,0,0,0],[1,0,0,1]].
const Depol_full_S = [
  [1 / 2, 0, 0, 1 / 2],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [1 / 2, 0, 0, 1 / 2],
];

// Amplitude damping γ = 1/2 (qubit).
// Kraus: K_0 = [[1,0],[0,1/√2]], K_1 = [[0,1/√2],[0,0]].
// S = K_0 ⊗ K_0 + K_1 ⊗ K_1 (column-stacking, real Kraus ops).
const S2 = 1 / Math.sqrt(2);
const AD_half_S = [
  [1, 0, 0, 1 / 2],
  [0, S2, 0, 0],
  [0, 0, S2, 0],
  [0, 0, 0, 1 / 2],
];

// Amplitude damping γ = 1: K_0 = [[1,0],[0,0]], K_1 = [[0,1],[0,0]].
// K_0 ⊗ K_0 = diag(1,0,0,0); K_1 ⊗ K_1 has a single 1 at row 0, col 3.
const AD_full_S = [
  [1, 0, 0, 1],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];

// Transpose superoperator: vec(ρᵀ)[i + 2j] = ρ[j,i] = vec(ρ)[j + 2i].
// In matrix form this is precisely SWAP_4. Its Choi is also SWAP_4 (a
// fixed point under the iso for this specific map — the canonical positive-
// but-not-CP witness, eigenvalues {-1, 1, 1, 1}).
const Transpose_S = SWAP4;

// Replacement channel with d_in = 2, d_out = 3: Φ(ρ) = |0⟩⟨0|_3 · tr(ρ).
// vec(Φ(ρ)) has a single non-zero entry (at index 0, value tr(ρ)).
// tr(ρ) = vec(I_2)ᵀ vec(ρ) = [1,0,0,1] · vec(ρ). So S is 9×4 with only
// row 0 non-zero, equal to [1, 0, 0, 1].
const Replace23_S = (() => {
  const rows: number[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 4 }, () => 0),
  );
  rows[0]![0] = 1;
  rows[0]![3] = 1;
  return rows;
})();

// 12 goldens — both directions, multiple dims, canonical channels.
export const goldens: GoldenSpec[] = [
  {
    description:
      "Identity channel on a qubit, forward: S = I_4 → J = |Ω⟩⟨Ω| (rank-1 PSD, trace = d_in = 2)",
    input: fwd(I4, 2, 2),
  },
  {
    description:
      "Identity channel on a qubit, inverse: J = |Ω⟩⟨Ω| round-trips back to S = I_4",
    input: inv(Omega2, 2, 2),
  },
  {
    description:
      "Identity channel on a qutrit, forward: S = I_9 → J = |Ω_3⟩⟨Ω_3| (entries at (0,0),(0,4),(0,8),(4,0),...)",
    input: fwd(I9, 3, 3),
  },
  {
    description:
      "Transpose map T(ρ) = ρᵀ, forward: J = SWAP — the canonical positive-but-not-CP example, eigenvalues {-1,1,1,1}",
    input: fwd(Transpose_S, 2, 2),
  },
  {
    description:
      "Transpose map, inverse: J = SWAP round-trips back to S = SWAP (transpose-map is a fixed point of the iso)",
    input: inv(SWAP4, 2, 2),
  },
  {
    description:
      "Depolarising channel p = 1/2, forward: half-identity + half-replacement-by-maxmix",
    input: fwd(Depol_half_S, 2, 2),
  },
  {
    description:
      "Completely depolarising channel (p = 1), forward: ρ ↦ (I/2)·tr(ρ), J = (1/2) I_4",
    input: fwd(Depol_full_S, 2, 2),
  },
  {
    description: "Amplitude damping γ = 1/2, forward: canonical non-unitary CP channel",
    input: fwd(AD_half_S, 2, 2),
  },
  {
    description: "Amplitude damping γ = 1 (full relaxation to |0⟩), forward",
    input: fwd(AD_full_S, 2, 2),
  },
  {
    description:
      "Replacement channel d_in=2, d_out=3: ρ ↦ |0⟩⟨0|_3 · tr(ρ), forward — exercises non-square dim_in ≠ dim_out",
    input: fwd(Replace23_S, 2, 3),
  },
  {
    description:
      "Round-trip: depolarising p = 1/2 Choi → channel — should recover Depol_half_S byte-identically",
    input: inv(
      [
        [3 / 4, 0, 0, 1 / 4],
        [0, 1 / 4, 0, 0],
        [0, 0, 1 / 4, 0],
        [1 / 4, 0, 0, 3 / 4],
      ],
      2,
      2,
    ),
  },
  {
    description:
      "Zero channel (S = 0), forward: J = 0 — trivial but exercises the all-zeros code path",
    input: fwd(
      [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      2,
      2,
    ),
  },
];
