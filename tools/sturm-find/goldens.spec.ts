// Goldens for sturm-find. Each entry pipes its `input` through the
// tool and snapshots the canonical output as a *.golden.json file via
// `bun scripts/generate-goldens.ts --tool sturm-find`. The oracle
// harness then byte-compares the snapshot against subsequent runs to
// catch regressions.
//
// Coverage strategy:
//   - Single-marked n=1..3 across the search space (boundary cases:
//     all-zeros, all-ones).
//   - Multi-marked n=3 (oracle that flips multiple basis states).
//   - Trivial n=1 (degenerate Grover — no diffusion needed).
//
// Each input is small; the deterministic IEEE-754 distribution makes
// the bytes stable across runs.

import { int, list, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function spec(description: string, n_bits: number, marked: readonly number[]): GoldenSpec {
  return {
    description,
    input: record({
      n_bits: int(BigInt(n_bits)),
      marked: list(marked.map(m => int(BigInt(m)))),
    }),
  };
}

export const goldens: GoldenSpec[] = [
  // n=1: degenerate Grover — search space {0, 1}, single iteration.
  spec("n=1 marked={0}", 1, [0]),
  spec("n=1 marked={1}", 1, [1]),

  // n=2: 4-state search. M=1 → optimalIters=1, predicted P(marked)=1.0.
  spec("n=2 marked={0}", 2, [0]),
  spec("n=2 marked={1}", 2, [1]),
  spec("n=2 marked={2}", 2, [2]),
  spec("n=2 marked={3}", 2, [3]),
  // M=2 → optimalIters=1.
  spec("n=2 marked={0,3}", 2, [0, 3]),
  spec("n=2 marked={1,2}", 2, [1, 2]),

  // n=3: 8-state search. M=1 → optimalIters=2, predicted ~0.945.
  spec("n=3 marked={0}", 3, [0]),
  spec("n=3 marked={1}", 3, [1]),
  spec("n=3 marked={2}", 3, [2]),
  spec("n=3 marked={3}", 3, [3]),
  spec("n=3 marked={5}", 3, [5]),
  spec("n=3 marked={7}", 3, [7]),

  // n=3 multi-marked.
  spec("n=3 marked={2,5}", 3, [2, 5]),
  spec("n=3 marked={0,3,5,6}", 3, [0, 3, 5, 6]),
  // M=4 even values: optimalIters=1, predicted P(even)=sin²(3·π/4)=0.5.
  spec("n=3 marked={0,2,4,6}", 3, [0, 2, 4, 6]),
  spec("n=3 marked={1,3,5,7}", 3, [1, 3, 5, 7]),
];
