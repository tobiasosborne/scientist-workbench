import { expr, int, rat, record, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import {
  casesOp,
  channel,
  encodeChannel,
  observeOp,
  prepareOp,
  rzOp,
  ryOp,
  wire,
} from "@workbench/sturm-ir";

const Q = (id: bigint) => wire(id, "quantum");
const C = (id: bigint) => wire(id, "classical");
const PI = sym("π");
const piOver = (n: bigint) => expr("/", [PI, int(n)]);

const inp = (
  first: ReturnType<typeof channel>,
  second: ReturnType<typeof channel>
) => record({ first: encodeChannel(first), second: encodeChannel(second) });

export const goldens: GoldenSpec[] = [
  {
    description: "compose two empty channels",
    input: inp(channel([], [], []), channel([], [], [])),
  },
  {
    description: "first prepares + outputs wire 0; second observes wire 0",
    input: inp(
      channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
      channel([Q(0n)], [], [observeOp(0n, "r")])
    ),
  },
  {
    description: "rename: second's input id 5 maps to first's output id 0",
    input: inp(
      channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
      channel([Q(5n)], [], [observeOp(5n, "r")])
    ),
  },
  {
    description: "second's internal wire id shifted past first's max",
    input: inp(
      channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
      channel(
        [Q(5n)],
        [Q(5n), Q(6n)],
        [prepareOp(rat(0n, 1n), 6n), ryOp(6n, PI, [5n])]
      )
    ),
  },
  {
    description: "two-wire signature passes through positionally",
    input: inp(
      channel(
        [],
        [Q(0n), Q(1n)],
        [prepareOp(rat(0n, 1n), 0n), prepareOp(rat(0n, 1n), 1n)]
      ),
      channel(
        [Q(7n), Q(8n)],
        [],
        [observeOp(7n, "a"), observeOp(8n, "b")]
      )
    ),
  },
  {
    description: "controls list gets renamed positionally",
    input: inp(
      channel(
        [],
        [Q(0n), Q(1n)],
        [prepareOp(rat(0n, 1n), 0n), prepareOp(rat(0n, 1n), 1n)]
      ),
      channel(
        [Q(3n), Q(4n)],
        [Q(3n), Q(4n)],
        [ryOp(4n, PI, [3n])]
      )
    ),
  },
  {
    description: "channel with input wires composes through second",
    input: inp(
      channel([Q(0n)], [Q(0n)], [ryOp(0n, piOver(2n), [])]),
      channel([Q(0n)], [Q(0n)], [rzOp(0n, PI, [])])
    ),
  },
  {
    description: "first's classical-ref binding flows into second's cases",
    input: inp(
      channel(
        [],
        [],
        [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")]
      ),
      channel(
        [],
        [Q(0n)],
        [
          prepareOp(rat(0n, 1n), 0n),
          casesOp("r", [ryOp(0n, PI, [])], []),
        ]
      )
    ),
  },
  {
    description: "internal wire of second collides with first's input id (rename works)",
    input: inp(
      // first.maxId = 1; second's internal id 0 must shift to 2.
      channel(
        [Q(0n), Q(1n)],
        [Q(0n), Q(1n)],
        [ryOp(0n, piOver(2n), [])]
      ),
      channel(
        [Q(2n), Q(3n)],
        [Q(2n), Q(3n)],
        [
          prepareOp(rat(1n, 2n), 0n),
          ryOp(0n, PI, []),
        ]
      )
    ),
  },
  {
    description: "Bell-pair-then-discard pattern",
    input: inp(
      // first: prepare two wires, build Bell pair (ry(π/2) on 0, ry(π) on 1 controlled by 0)
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
      // second: observe both
      channel(
        [Q(0n), Q(1n)],
        [],
        [observeOp(0n, "a"), observeOp(1n, "b")]
      )
    ),
  },
  {
    description: "out-of-scope: signature length mismatch",
    input: inp(
      channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
      channel([], [], [])
    ),
  },
  {
    description: "out-of-scope: signature length mismatch (other direction)",
    input: inp(
      channel([], [], []),
      channel([Q(0n)], [], [observeOp(0n, "r")])
    ),
  },
  {
    description: "out-of-scope: signature kind mismatch",
    input: inp(
      channel([], [Q(0n)], [prepareOp(rat(0n, 1n), 0n)]),
      channel([C(0n)], [], [])
    ),
  },
  {
    description: "out-of-scope: signature dim mismatch",
    input: inp(
      channel(
        [],
        [wire(0n, "quantum", "qubit")],
        [prepareOp(rat(0n, 1n), 0n)]
      ),
      channel([wire(0n, "quantum", "qudit")], [], [])
    ),
  },
];
