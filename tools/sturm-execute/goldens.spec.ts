// Goldens for sturm-execute. Each entry pipes its `input` through the tool
// and snapshots the output as a *.golden.json file via
// `bun scripts/generate-goldens.ts --tool sturm-execute`. The oracle harness
// then byte-compares the snapshot against subsequent runs to catch
// regressions.
//
// We target a representative coverage spread:
//   - empty / single-prepare / deterministic outcomes (the trivial cases),
//   - uniform-superposition / parametrised-rotation (numerics),
//   - Bell pair / GHZ-3 (entanglement + classical correlation),
//   - cases-driven feedback (mid-circuit branching),
//   - rz-only (phase has no effect on standard-basis prob),
//   - oracle / discard / free-symbol (every out-of-scope reason),
//   - multi-control (controls beyond a single wire),
//   - input-signature seeding (channel that takes a quantum input).
//
// IEEE-754 determinism makes byte-identical goldens stable across runs; the
// 1e-12 precision floor in tool.ts strips phantom branches, so no flaky
// near-zero rows appear.

import { expr, int, rat, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import {
  channel,
  encodeChannel,
  observeOp,
  prepareOp,
  ryOp,
  rzOp,
  wire,
} from "@workbench/sturm-ir";

const piOver = (n: bigint) => expr("/", [sym("π"), int(n)]);

const W0 = wire(0n, "quantum", "qubit");
const W1 = wire(1n, "quantum", "qubit");

export const goldens: GoldenSpec[] = [
  {
    description: "empty channel",
    input: encodeChannel(channel([], [], [])),
  },
  {
    description: "prepare(0) then observe — deterministic",
    input: encodeChannel(
      channel(
        [],
        [],
        [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
      )
    ),
  },
  {
    description: "prepare(1) then observe — deterministic 1",
    input: encodeChannel(
      channel(
        [],
        [],
        [prepareOp(int(1n), 0n), observeOp(0n, "r")]
      )
    ),
  },
  {
    description: "prepare(1/2) — uniform",
    input: encodeChannel(
      channel(
        [],
        [],
        [prepareOp(rat(1n, 2n), 0n), observeOp(0n, "r")]
      )
    ),
  },
  {
    description: "ry(π) acts as NOT",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("π"), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "ry(π/2) acts as superposition-creator",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, piOver(2n), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "Bell pair — perfect correlation",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, piOver(2n), []),
          ryOp(1n, sym("π"), [0n]),
          observeOp(0n, "r0"),
          observeOp(1n, "r1"),
        ]
      )
    ),
  },
  {
    description: "GHZ-3 — three-way correlation",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          prepareOp(rat(0n, 1n), 2n),
          ryOp(0n, piOver(2n), []),
          ryOp(1n, sym("π"), [0n]),
          ryOp(2n, sym("π"), [0n]),
          observeOp(0n, "r0"),
          observeOp(1n, "r1"),
          observeOp(2n, "r2"),
        ]
      )
    ),
  },
  {
    description: "parametrised rotation: ry(0.5)",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, rat(1n, 2n), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "ry(0.317 ≈) via float64 angle",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, rat(317n, 1000n), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "rz alone — phase has no effect on standard-basis probs",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(1n, 2n), 0n),
          rzOp(0n, piOver(2n), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "ry then rz then ry — phase-sensitive sequence",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, piOver(2n), []),
          rzOp(0n, sym("π"), []),
          ryOp(0n, piOver(2n), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "cases dispatch: feedback NOT",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(1n, 2n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          observeOp(0n, "r0"),
          {
            head: "cases",
            classicalRef: "r0",
            trueArm: [ryOp(1n, sym("π"), [])],
            falseArm: [],
          },
          observeOp(1n, "r1"),
        ]
      )
    ),
  },
  {
    description: "cases dispatch: both arms non-trivial",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(1n, 2n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          observeOp(0n, "r0"),
          {
            head: "cases",
            classicalRef: "r0",
            trueArm: [ryOp(1n, piOver(2n), [])],
            falseArm: [ryOp(1n, sym("π"), [])],
          },
          observeOp(1n, "r1"),
        ]
      )
    ),
  },
  {
    description: "two independent qubits — no entanglement",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(1n, 2n), 0n),
          prepareOp(rat(1n, 2n), 1n),
          observeOp(0n, "r0"),
          observeOp(1n, "r1"),
        ]
      )
    ),
  },
  {
    description: "multi-control: ry on wire 2 controlled by both 0 and 1",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(1n, 2n), 0n),
          prepareOp(rat(1n, 2n), 1n),
          prepareOp(rat(0n, 1n), 2n),
          ryOp(2n, sym("π"), [0n, 1n]),
          observeOp(0n, "r0"),
          observeOp(1n, "r1"),
          observeOp(2n, "r2"),
        ]
      )
    ),
  },
  {
    description: "input signature with quantum wire seeded as |0⟩",
    input: encodeChannel(
      channel(
        [W0],
        [W0],
        [ryOp(0n, sym("π"), []), observeOp(0n, "r")]
      )
    ),
  },
  {
    description: "input signature with two quantum wires",
    input: encodeChannel(
      channel(
        [W0, W1],
        [],
        [
          ryOp(0n, piOver(2n), []),
          ryOp(1n, sym("π"), [0n]),
          observeOp(0n, "r0"),
          observeOp(1n, "r1"),
        ]
      )
    ),
  },
  {
    description: "out-of-scope: oracle op",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          {
            head: "oracle",
            circuit: sym("placeholder"),
            inWires: [0n],
            outWires: [0n],
          },
        ]
      )
    ),
  },
  {
    description: "out-of-scope: discard op",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          { head: "discard", wireId: 0n },
        ]
      )
    ),
  },
  {
    description: "out-of-scope: free symbolic angle",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "out-of-scope: free symbolic probability",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(sym("p"), 0n),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "negation of π in angle: ry(-π) acts as NOT (with phase)",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, expr("-", [sym("π")]), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
  {
    description: "additive angle: ry(π/2 + π/2) = ry(π)",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, expr("+", [piOver(2n), piOver(2n)]), []),
          observeOp(0n, "r"),
        ]
      )
    ),
  },
];
