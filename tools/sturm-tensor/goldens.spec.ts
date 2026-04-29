import { expr, int, rat, record, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import {
  casesOp,
  channel,
  discardOp,
  encodeChannel,
  observeOp,
  prepareOp,
  ryOp,
  rzOp,
  wire,
} from "@workbench/sturm-ir";

const Q = (id: bigint) => wire(id, "quantum");
const PI = sym("π");
const piOver = (n: bigint) => expr("/", [PI, int(n)]);

const inp = (
  left: ReturnType<typeof channel>,
  right: ReturnType<typeof channel>
) => record({ left: encodeChannel(left), right: encodeChannel(right) });

export const goldens: GoldenSpec[] = [
  {
    description: "tensor of two empty channels",
    input: inp(channel([], [], []), channel([], [], [])),
  },
  {
    description: "identity-left: tensor(empty, c) = c",
    input: inp(
      channel([], [], []),
      channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])])
    ),
  },
  {
    description: "identity-right: tensor(c, empty) = c",
    input: inp(
      channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]),
      channel([], [], [])
    ),
  },
  {
    description: "two single-wire channels merge with disjoint ids",
    input: inp(
      channel([Q(0n)], [Q(0n)], [ryOp(0n, piOver(2n), [])]),
      channel([Q(0n)], [Q(0n)], [rzOp(0n, PI, [])])
    ),
  },
  {
    description: "right channel with multiple wires shifts uniformly",
    input: inp(
      channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]),
      channel(
        [Q(0n), Q(1n)],
        [Q(0n), Q(1n)],
        [ryOp(1n, piOver(2n), [0n])]
      )
    ),
  },
  {
    description: "left's max id determines offset",
    input: inp(
      channel([Q(7n)], [Q(7n)], [ryOp(7n, PI, [])]),
      channel([Q(0n)], [Q(0n)], [rzOp(0n, PI, [])])
    ),
  },
  {
    description: "tensor preserves prepares on both sides",
    input: inp(
      channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
      channel([], [Q(0n)], [prepareOp(rat(1n, 2n), 0n)])
    ),
  },
  {
    description: "cases inside right's body gets renamed recursively",
    input: inp(
      channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]),
      channel(
        [Q(0n)],
        [Q(0n)],
        [casesOp("r", [ryOp(0n, PI, [])], [rzOp(0n, piOver(2n), [])])]
      )
    ),
  },
  {
    description: "controls list shifts alongside target wireId",
    input: inp(
      channel([Q(0n), Q(1n)], [Q(0n), Q(1n)], [ryOp(1n, PI, [0n])]),
      channel([Q(2n), Q(3n)], [Q(2n), Q(3n)], [ryOp(3n, PI, [2n])])
    ),
  },
  {
    description: "Bell-pair × independent rotation",
    input: inp(
      channel(
        [],
        [Q(0n), Q(1n)],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, piOver(2n), []),
          ryOp(1n, PI, [0n]),
        ]
      ),
      channel(
        [],
        [Q(0n)],
        [prepareOp(rat(0n, 1n), 0n), ryOp(0n, piOver(4n), [])]
      )
    ),
  },
  {
    description: "right's discard shifts",
    input: inp(
      channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
      channel([Q(0n)], [], [discardOp(0n)])
    ),
  },
  {
    description: "right's observe shifts",
    input: inp(
      channel([Q(0n)], [Q(0n)], [ryOp(0n, PI, [])]),
      channel([Q(0n)], [], [observeOp(0n, "r")])
    ),
  },
  {
    description: "tensor of two pure-ry channels — disjoint Bloch rotations on side-by-side wires",
    input: inp(
      channel([Q(0n)], [Q(0n)], [ryOp(0n, piOver(4n), [])]),
      channel([Q(0n)], [Q(0n)], [ryOp(0n, piOver(8n), [])])
    ),
  },
];
