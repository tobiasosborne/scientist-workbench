// Goldens for sturm-equivalent. Each entry pipes its `input` (a record
// {lhs, rhs}) through the tool and snapshots the output as a
// *.golden.json file.
//
// We target a representative coverage spread:
//   - reflexive identity (every channel equal to itself),
//   - simplification-induced equality (ry(0), same-axis fusion,
//     control-list reordering),
//   - distribution-mismatch with witness (different deterministic
//     outcomes; Bell vs not-Bell),
//   - distribution-match-but-not-syntactic (the necessary-but-not-
//     sufficient honest out-of-scope branch),
//   - sturm-execute boundary (oracle, discard),
//   - different classical_refs (out-of-scope conservative phrasing).

import { expr, int, rat, sym, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import {
  channel,
  encodeChannel,
  observeOp,
  prepareOp,
  ryOp,
  rzOp,
  wire,
  type Channel,
} from "@workbench/sturm-ir";

const piOver = (n: bigint) => expr("/", [sym("π"), int(n)]);

const W0 = wire(0n, "quantum", "qubit");

const bell: Channel = channel(
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
);

const bellWithRy0: Channel = channel(
  [],
  [],
  [
    prepareOp(rat(0n, 1n), 0n),
    prepareOp(rat(0n, 1n), 1n),
    ryOp(0n, piOver(2n), []),
    ryOp(0n, int(0n), []),
    ryOp(1n, sym("π"), [0n]),
    observeOp(0n, "r0"),
    observeOp(1n, "r1"),
  ]
);

const bellWithSwapped: Channel = channel(
  [],
  [],
  [
    prepareOp(rat(0n, 1n), 0n),
    prepareOp(rat(0n, 1n), 1n),
    ryOp(0n, piOver(2n), []),
    ryOp(0n, piOver(2n), []),
    ryOp(1n, sym("π"), [0n]),
    observeOp(0n, "r0"),
    observeOp(1n, "r1"),
  ]
);

const empty: Channel = channel([], [], []);

const detZero: Channel = channel(
  [],
  [],
  [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
);

const detOne: Channel = channel(
  [],
  [],
  [prepareOp(int(1n), 0n), observeOp(0n, "r")]
);

const uniform: Channel = channel(
  [],
  [],
  [prepareOp(rat(1n, 2n), 0n), observeOp(0n, "r")]
);

const uniformWithRz: Channel = channel(
  [],
  [],
  [
    prepareOp(rat(1n, 2n), 0n),
    rzOp(0n, sym("π"), []),
    observeOp(0n, "r"),
  ]
);

const oracleCh: Channel = channel(
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
);

const discardCh: Channel = channel(
  [],
  [],
  [prepareOp(rat(0n, 1n), 0n), { head: "discard", wireId: 0n }]
);

const inputSig: Channel = channel(
  [W0],
  [],
  [ryOp(0n, sym("π"), []), observeOp(0n, "r")]
);

const ryAlphaBeta: Channel = channel(
  [],
  [],
  [
    prepareOp(rat(0n, 1n), 0n),
    ryOp(0n, sym("α"), []),
    ryOp(0n, sym("β"), []),
    observeOp(0n, "r"),
  ]
);

const ryAlphaPlusBeta: Channel = channel(
  [],
  [],
  [
    prepareOp(rat(0n, 1n), 0n),
    ryOp(0n, expr("+", [sym("α"), sym("β")]), []),
    observeOp(0n, "r"),
  ]
);

const controlsReordered: Channel = channel(
  [],
  [],
  [
    prepareOp(rat(0n, 1n), 0n),
    prepareOp(rat(0n, 1n), 1n),
    prepareOp(rat(0n, 1n), 2n),
    ryOp(2n, sym("π"), [1n, 0n]),
    observeOp(2n, "r"),
  ]
);

const controlsAscending: Channel = channel(
  [],
  [],
  [
    prepareOp(rat(0n, 1n), 0n),
    prepareOp(rat(0n, 1n), 1n),
    prepareOp(rat(0n, 1n), 2n),
    ryOp(2n, sym("π"), [0n, 1n]),
    observeOp(2n, "r"),
  ]
);

const refR0: Channel = channel(
  [],
  [],
  [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r0")]
);

const refDifferent: Channel = channel(
  [],
  [],
  [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "different_name")]
);

export const goldens: GoldenSpec[] = [
  {
    description: "reflexive: empty == empty",
    input: record({ lhs: encodeChannel(empty), rhs: encodeChannel(empty) }),
  },
  {
    description: "reflexive: bell == bell",
    input: record({ lhs: encodeChannel(bell), rhs: encodeChannel(bell) }),
  },
  {
    description: "reflexive: deterministic-0 == itself",
    input: record({ lhs: encodeChannel(detZero), rhs: encodeChannel(detZero) }),
  },
  {
    description: "ry(0) elimination: bell == bell+redundant-ry(0)",
    input: record({
      lhs: encodeChannel(bell),
      rhs: encodeChannel(bellWithRy0),
    }),
  },
  {
    description: "same-axis fusion: ry(α)ry(β) == ry(α+β)",
    input: record({
      lhs: encodeChannel(ryAlphaBeta),
      rhs: encodeChannel(ryAlphaPlusBeta),
    }),
  },
  {
    description:
      "control reordering: ry ctrls=[1,0] == ry ctrls=[0,1] post-simplify",
    input: record({
      lhs: encodeChannel(controlsReordered),
      rhs: encodeChannel(controlsAscending),
    }),
  },
  {
    description: "deterministic-0 vs deterministic-1: not-equivalent",
    input: record({ lhs: encodeChannel(detZero), rhs: encodeChannel(detOne) }),
  },
  {
    description: "uniform vs deterministic-0: not-equivalent",
    input: record({ lhs: encodeChannel(uniform), rhs: encodeChannel(detZero) }),
  },
  {
    description: "bell vs bell-with-extra-ry(π/2): not-equivalent",
    input: record({
      lhs: encodeChannel(bell),
      rhs: encodeChannel(bellWithSwapped),
    }),
  },
  {
    description: "rz on |+⟩: distribution-match (out-of-scope)",
    input: record({
      lhs: encodeChannel(uniformWithRz),
      rhs: encodeChannel(uniform),
    }),
  },
  {
    description: "different classical_refs: out-of-scope",
    input: record({
      lhs: encodeChannel(refR0),
      rhs: encodeChannel(refDifferent),
    }),
  },
  {
    description: "lhs has oracle: out-of-scope",
    input: record({ lhs: encodeChannel(oracleCh), rhs: encodeChannel(empty) }),
  },
  {
    description: "lhs has discard: out-of-scope",
    input: record({
      lhs: encodeChannel(discardCh),
      rhs: encodeChannel(empty),
    }),
  },
  {
    description: "input-signature seeded: ry(π) on quantum-input wire",
    input: record({
      lhs: encodeChannel(inputSig),
      rhs: encodeChannel(inputSig),
    }),
  },
];
