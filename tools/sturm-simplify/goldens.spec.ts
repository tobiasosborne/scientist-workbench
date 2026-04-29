import { expr, int, rat, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import {
  channel,
  encodeChannel,
  observeOp,
  oracleOp,
  prepareOp,
  ryOp,
  rzOp,
  wire,
} from "@workbench/sturm-ir";

const W0 = wire(0n, "quantum", "qubit");
const W1 = wire(1n, "quantum", "qubit");
const W2 = wire(2n, "quantum", "qubit");

void W2;

export const goldens: GoldenSpec[] = [
  {
    description: "empty channel",
    input: encodeChannel(channel([], [], [])),
  },
  {
    description: "single prepare",
    input: encodeChannel(channel([], [W0], [prepareOp(rat(0n, 1n), 0n)])),
  },
  {
    description: "ry(0) eliminated",
    input: encodeChannel(
      channel([], [W0], [prepareOp(rat(0n, 1n), 0n), ryOp(0n, int(0n), [])])
    ),
  },
  {
    description: "rz(0) eliminated",
    input: encodeChannel(
      channel([], [W0], [prepareOp(rat(0n, 1n), 0n), rzOp(0n, int(0n), [])])
    ),
  },
  {
    description: "ry(0/1) rational-zero eliminated",
    input: encodeChannel(
      channel([], [W0], [prepareOp(rat(0n, 1n), 0n), ryOp(0n, rat(0n, 1n), [])])
    ),
  },
  {
    description: "ry α + ry β fuses",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          ryOp(0n, sym("b"), []),
        ]
      )
    ),
  },
  {
    description: "ry α then ry -α both vanish",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          ryOp(0n, expr("-", [sym("a")]), []),
        ]
      )
    ),
  },
  {
    description: "rz α + rz β fuses",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          rzOp(0n, sym("a"), []),
          rzOp(0n, sym("b"), []),
        ]
      )
    ),
  },
  {
    description: "ry then rz on same wire is preserved (no cross-axis fusion)",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          rzOp(0n, sym("b"), []),
        ]
      )
    ),
  },
  {
    description: "different wires don't fuse",
    input: encodeChannel(
      channel(
        [],
        [W0, W1],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, sym("a"), []),
          ryOp(1n, sym("b"), []),
        ]
      )
    ),
  },
  {
    description: "ry π/2 then ry π/2 fuses",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
          ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
        ]
      )
    ),
  },
  {
    description: "ry 1 then ry 2 fuses to ry 3 (concrete numerics)",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, int(1n), []),
          ryOp(0n, int(2n), []),
        ]
      )
    ),
  },
  {
    description: "controls reordered ascending",
    input: encodeChannel(
      channel(
        [],
        [W0, W1, W2],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          prepareOp(rat(0n, 1n), 2n),
          ryOp(2n, sym("a"), [1n, 0n]),
        ]
      )
    ),
  },
  {
    description: "controls deduplicated",
    input: encodeChannel(
      channel(
        [],
        [W0, W1],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(1n, sym("a"), [0n, 0n, 0n]),
        ]
      )
    ),
  },
  {
    description: "differing controls don't fuse",
    input: encodeChannel(
      channel(
        [],
        [W0, W1, W2],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          prepareOp(rat(0n, 1n), 2n),
          ryOp(2n, sym("a"), [0n]),
          ryOp(2n, sym("b"), [1n]),
        ]
      )
    ),
  },
  {
    description: "Bell-pair channel passes through",
    input: encodeChannel(
      channel(
        [],
        [W0, W1],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
          ryOp(1n, sym("π"), [0n]),
        ]
      )
    ),
  },
  {
    description: "GHZ-three channel passes through",
    input: encodeChannel(
      channel(
        [],
        [W0, W1, W2],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          prepareOp(rat(0n, 1n), 2n),
          ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
          ryOp(1n, sym("π"), [0n]),
          ryOp(2n, sym("π"), [0n]),
        ]
      )
    ),
  },
  {
    description: "three-way fusion ry a + b + c",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          ryOp(0n, sym("b"), []),
          ryOp(0n, sym("c"), []),
        ]
      )
    ),
  },
  {
    description: "non-trivial ry then zero ry preserves first",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          ryOp(0n, int(0n), []),
        ]
      )
    ),
  },
  {
    description: "interleaved ry rz ry — ry's stay separated by rz",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, sym("a"), []),
          rzOp(0n, sym("b"), []),
          ryOp(0n, sym("c"), []),
        ]
      )
    ),
  },
  {
    description: "observe + discard pass through",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          observeOp(0n, "r"),
          { head: "discard", wireId: 1n } as const,
        ]
      )
    ),
  },
  {
    description: "cases with empty arms is dropped",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          observeOp(0n, "r"),
          { head: "cases", classicalRef: "r", trueArm: [], falseArm: [] },
        ]
      )
    ),
  },
  {
    description: "cases simplifies its arms recursively",
    input: encodeChannel(
      channel(
        [],
        [W1],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          observeOp(0n, "r"),
          {
            head: "cases",
            classicalRef: "r",
            trueArm: [
              ryOp(1n, sym("a"), []),
              ryOp(1n, sym("b"), []),
            ],
            falseArm: [ryOp(1n, int(0n), [])],
          },
        ]
      )
    ),
  },
  {
    description: "cases whose arms simplify to empty is dropped",
    input: encodeChannel(
      channel(
        [],
        [W1],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          observeOp(0n, "r"),
          {
            head: "cases",
            classicalRef: "r",
            trueArm: [ryOp(1n, int(0n), [])],
            falseArm: [ryOp(1n, int(0n), [])],
          },
        ]
      )
    ),
  },
  {
    description: "oracle op — circuit untouched",
    input: encodeChannel(
      channel(
        [],
        [W0, W1],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          oracleOp(sym("oracle-placeholder"), [0n, 1n], [1n]),
        ]
      )
    ),
  },
  {
    description: "input signature with quantum wires preserved",
    input: encodeChannel(
      channel(
        [W0, W1],
        [W0, W1],
        [ryOp(0n, sym("a"), [1n])]
      )
    ),
  },
  {
    description: "controlled ry fusion preserved",
    input: encodeChannel(
      channel(
        [],
        [W0, W1],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(1n, sym("a"), [0n]),
          ryOp(1n, sym("b"), [0n]),
        ]
      )
    ),
  },
  {
    description: "rational + rational angle fuses",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, rat(1n, 2n), []),
          ryOp(0n, rat(1n, 3n), []),
        ]
      )
    ),
  },
  {
    description: "ry + ry fuses across deeper expression",
    input: encodeChannel(
      channel(
        [],
        [W0],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, expr("*", [int(2n), sym("a")]), []),
          ryOp(0n, expr("*", [int(3n), sym("a")]), []),
        ]
      )
    ),
  },
  {
    description: "phase-kickback-style snippet",
    input: encodeChannel(
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
          oracleOp(sym("placeholder"), [0n, 1n], [1n]),
          ryOp(0n, expr("-", [expr("/", [sym("π"), int(2n)])]), []),
          observeOp(0n, "phase_bit"),
          observeOp(1n, "target_bit"),
          { head: "discard", wireId: 1n } as const,
        ]
      )
    ),
  },
  {
    description: "single classical wire input passes through",
    input: encodeChannel(
      channel(
        [wire(5n, "classical")],
        [],
        []
      )
    ),
  },
  {
    description: "multi-control ry preserves semantics",
    input: encodeChannel(
      channel(
        [],
        [W0, W1, W2],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          prepareOp(rat(0n, 1n), 2n),
          ryOp(2n, sym("a"), [0n, 1n]),
        ]
      )
    ),
  },
];
