import { expr, int, rat, record, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import {
  casesOp,
  channel,
  discardOp,
  encodeChannel,
  observeOp,
  oracleOp,
  prepareOp,
  ryOp,
  rzOp,
  wire,
} from "@workbench/sturm-ir";

const Q = (id: bigint) => wire(id, "quantum");
const PI = sym("π");
const piOver = (n: bigint) => expr("/", [PI, int(n)]);

const inp = (controlId: bigint, ch: ReturnType<typeof channel>) =>
  record({ control_wire: int(controlId), channel: encodeChannel(ch) });

export const goldens: GoldenSpec[] = [
  {
    description: "empty channel — output has only the control wire",
    input: inp(0n, channel([], [], [])),
  },
  {
    description: "single ry — control appended",
    input: inp(9n, channel([Q(1n)], [Q(1n)], [ryOp(1n, PI, [])])),
  },
  {
    description: "single rz — control appended",
    input: inp(9n, channel([Q(1n)], [Q(1n)], [rzOp(1n, piOver(2n), [])])),
  },
  {
    description: "ry then rz on same wire",
    input: inp(
      9n,
      channel(
        [Q(1n)],
        [Q(1n)],
        [ryOp(1n, piOver(2n), []), rzOp(1n, PI, [])]
      )
    ),
  },
  {
    description: "ry already has a control — new control appended",
    input: inp(
      9n,
      channel(
        [Q(1n), Q(2n)],
        [Q(1n), Q(2n)],
        [ryOp(2n, PI, [1n])]
      )
    ),
  },
  {
    description: "multi-target body — every rotation picks up the control",
    input: inp(
      9n,
      channel(
        [Q(1n), Q(2n)],
        [Q(1n), Q(2n)],
        [ryOp(1n, piOver(2n), []), ryOp(2n, piOver(4n), [])]
      )
    ),
  },
  {
    description: "cases arms recursively controlled",
    input: inp(
      9n,
      channel(
        [Q(1n), Q(2n)],
        [Q(1n), Q(2n)],
        [
          casesOp(
            "r",
            [ryOp(2n, PI, [])],
            [rzOp(2n, piOver(2n), [])]
          ),
        ]
      )
    ),
  },
  {
    description: "nested cases — inner ry's get the control",
    input: inp(
      9n,
      channel(
        [Q(1n), Q(2n), Q(3n)],
        [Q(1n), Q(2n), Q(3n)],
        [
          casesOp(
            "r",
            [
              casesOp(
                "s",
                [ryOp(3n, PI, [])],
                [ryOp(3n, piOver(2n), [])]
              ),
            ],
            []
          ),
        ]
      )
    ),
  },
  {
    description: "ry with two existing controls — new control appended",
    input: inp(
      9n,
      channel(
        [Q(1n), Q(2n), Q(3n)],
        [Q(1n), Q(2n), Q(3n)],
        [ryOp(3n, PI, [1n, 2n])]
      )
    ),
  },
  {
    description: "control wire 0 controlling a wire-1 ry",
    input: inp(
      0n,
      channel([Q(1n)], [Q(1n)], [ryOp(1n, piOver(2n), [])])
    ),
  },
  {
    description: "out-of-scope: control wire collides with input wire",
    input: inp(1n, channel([Q(1n)], [Q(1n)], [ryOp(1n, PI, [])])),
  },
  {
    description: "out-of-scope: control wire collides with target of body op",
    input: inp(
      2n,
      channel([Q(1n), Q(2n)], [Q(1n), Q(2n)], [ryOp(2n, PI, [1n])])
    ),
  },
  {
    description: "out-of-scope: control wire collides with existing control",
    input: inp(
      1n,
      channel([Q(1n), Q(2n)], [Q(1n), Q(2n)], [ryOp(2n, PI, [1n])])
    ),
  },
  {
    description: "out-of-scope: prepare in body",
    input: inp(9n, channel([], [Q(1n)], [prepareOp(rat(0n, 1n), 1n)])),
  },
  {
    description: "out-of-scope: observe in body",
    input: inp(9n, channel([Q(1n)], [], [observeOp(1n, "r")])),
  },
  {
    description: "out-of-scope: discard in body",
    input: inp(9n, channel([Q(1n)], [], [discardOp(1n)])),
  },
  {
    description: "out-of-scope: oracle in body",
    input: inp(
      9n,
      channel(
        [Q(1n)],
        [Q(1n)],
        [oracleOp(encodeChannel(channel([], [], [])), [1n], [1n])]
      )
    ),
  },
  {
    description: "out-of-scope: observe inside cases-arm",
    input: inp(
      9n,
      channel(
        [Q(1n), Q(2n)],
        [Q(1n), Q(2n)],
        [
          casesOp(
            "r",
            [observeOp(2n, "s")],
            []
          ),
        ]
      )
    ),
  },
  {
    description: "out-of-scope: discard inside cases-arm",
    input: inp(
      9n,
      channel(
        [Q(1n), Q(2n)],
        [Q(1n), Q(2n)],
        [
          casesOp(
            "r",
            [],
            [discardOp(2n)]
          ),
        ]
      )
    ),
  },
];
