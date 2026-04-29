// Goldens for sturm-sample. Sampling is deterministic given (distribution,
// entropy, shots), so the standard generate-and-byte-compare machinery
// applies cleanly here — unlike entropy-source (shard 020) where the output
// is genuinely nondeterministic and goldens were intentionally empty.
//
// Coverage targets:
//   - the three CDF corners on a 50/50 distribution (u = 0, u = 0.5, u ≈ 1.0),
//   - shots = 0 (the trivial pure-deterministic case),
//   - multi-shot deterministic patterns,
//   - Bell-pair correlation,
//   - GHZ-3 all-correlated,
//   - a deterministic-distribution case (P=1 on a single outcome),
//   - a multi-outcome non-uniform case (skewed CDF),
//   - the documented 8-byte-per-shot byte budget reflected in `entropy_consumed`.
//
// Bytes-per-shot convention is ADR-0007. The entropy seeds embedded here are
// chosen to land on specific CDF corners deterministically (by construction,
// `0x00…` ⇒ u = 0.0 picks the first outcome; `0xff…` ⇒ u ≈ 1.0 picks the
// last outcome; `0x80…` ⇒ u = 0.5 lands on the boundary, which under the
// `>=` lookup also picks the first outcome).

import { float64FromNumber, int, list, record, str } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import type { Value } from "@workbench/protocol";

function pair(ref: string, value: 0 | 1): Value {
  return record({ ref: str(ref), value: int(BigInt(value)) });
}

function outcome(resolutions: readonly Value[], prob: number): Value {
  return record({
    classical_resolutions: list(resolutions),
    prob: float64FromNumber(prob),
  });
}

function dist(refs: readonly string[], outcomes: readonly Value[]): Value {
  return record({
    classical_refs: list(refs.map((r) => str(r))),
    outcomes: list(outcomes),
    precision: str("float64"),
  });
}

const DET_ZERO = dist(["r"], [outcome([pair("r", 0)], 1.0)]);
const DET_ONE = dist(["r"], [outcome([pair("r", 1)], 1.0)]);
const FIFTY_FIFTY = dist(
  ["r"],
  [outcome([pair("r", 0)], 0.5), outcome([pair("r", 1)], 0.5)]
);
const SKEWED_25_75 = dist(
  ["r"],
  [outcome([pair("r", 0)], 0.25), outcome([pair("r", 1)], 0.75)]
);
const BELL = dist(
  ["r0", "r1"],
  [
    outcome([pair("r0", 0), pair("r1", 0)], 0.5),
    outcome([pair("r0", 1), pair("r1", 1)], 0.5),
  ]
);
const GHZ3 = dist(
  ["r0", "r1", "r2"],
  [
    outcome([pair("r0", 0), pair("r1", 0), pair("r2", 0)], 0.5),
    outcome([pair("r0", 1), pair("r1", 1), pair("r2", 1)], 0.5),
  ]
);

const ENTROPY_ZERO_8 = "0000000000000000";
const ENTROPY_FF_8 = "ffffffffffffffff";
const ENTROPY_HALF_8 = "8000000000000000";
// u = 0.25 to land in the first bucket of SKEWED_25_75 (CDF[0] = 0.25 ≥ 0.25).
const ENTROPY_QUARTER_8 = "4000000000000000";
// u = 0.5 + epsilon (one above 0x8000…) to land in the second bucket of
// SKEWED_25_75 (CDF[0] = 0.25; CDF[1] = 1.0; 0.5 < 1.0 so picks index 1).
// Picked: "8000000000000001" — minimal non-zero perturbation, still > 0.5.
const ENTROPY_HALF_PLUS_8 = "8000000000000001";

const inp = (distribution: Value, entropy: string, shots: bigint) =>
  record({ distribution, entropy: str(entropy), shots: int(shots) });

export const goldens: GoldenSpec[] = [
  {
    description: "deterministic P=1 on r=0; one shot",
    input: inp(DET_ZERO, ENTROPY_HALF_8, 1n),
  },
  {
    description: "deterministic P=1 on r=1; one shot — the dual case",
    input: inp(DET_ONE, ENTROPY_ZERO_8, 1n),
  },
  {
    description: "shots = 0 → empty samples, no entropy consumed",
    input: inp(FIFTY_FIFTY, "", 0n),
  },
  {
    description: "50/50, u = 0.0 (entropy '00…') → r=0",
    input: inp(FIFTY_FIFTY, ENTROPY_ZERO_8, 1n),
  },
  {
    description: "50/50, u ≈ 1.0 (entropy 'ff…') → r=1",
    input: inp(FIFTY_FIFTY, ENTROPY_FF_8, 1n),
  },
  {
    description: "50/50, u = 0.5 (entropy '80…') → r=0 (CDF >= u with i=0)",
    input: inp(FIFTY_FIFTY, ENTROPY_HALF_8, 1n),
  },
  {
    description: "50/50, two shots: '00…' || 'ff…' → r=0 then r=1",
    input: inp(FIFTY_FIFTY, ENTROPY_ZERO_8 + ENTROPY_FF_8, 2n),
  },
  {
    description: "50/50, three shots, mixed entropy → 0,0,1",
    input: inp(
      FIFTY_FIFTY,
      ENTROPY_HALF_8 + ENTROPY_ZERO_8 + ENTROPY_FF_8,
      3n
    ),
  },
  {
    description: "skewed 25/75, u = 0.25 → r=0 (boundary picks first)",
    input: inp(SKEWED_25_75, ENTROPY_QUARTER_8, 1n),
  },
  {
    description: "skewed 25/75, u just above 0.5 → r=1 (in 2nd bucket)",
    input: inp(SKEWED_25_75, ENTROPY_HALF_PLUS_8, 1n),
  },
  {
    description: "Bell pair, u = 0.0 → (r0=0, r1=0) — entanglement preserved",
    input: inp(BELL, ENTROPY_ZERO_8, 1n),
  },
  {
    description: "Bell pair, u ≈ 1.0 → (r0=1, r1=1) — both wires correlate",
    input: inp(BELL, ENTROPY_FF_8, 1n),
  },
  {
    description: "Bell pair, two shots '00…' || 'ff…' → (0,0) then (1,1)",
    input: inp(BELL, ENTROPY_ZERO_8 + ENTROPY_FF_8, 2n),
  },
  {
    description: "GHZ-3, u = 0.0 → all-zeros — three wires correlate from one byte budget",
    input: inp(GHZ3, ENTROPY_ZERO_8, 1n),
  },
  {
    description: "GHZ-3, u ≈ 1.0 → all-ones",
    input: inp(GHZ3, ENTROPY_FF_8, 1n),
  },
];
