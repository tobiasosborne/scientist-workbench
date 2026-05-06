// linsolve-q goldens — exact-rational linear solving.
//
// Each entry produces one *.golden.json file under goldens/ when
// `bun run goldens` runs. The file's name is derived from
// `description` (slugified). The contract checks bit-equality of the
// stored output against the live tool output.
//
// Coverage targets (per CLAUDE.md ≥30 for v1-complete; we ship ≥30):
// - boundary edges (1×1, 0×0, m×0)
// - 2×2, 3×3 small dense unique
// - rational coefficients
// - under-determined (1×2, 2×3, rank-deficient square)
// - inconsistent (over-determined, rank-deficient with bad rhs)
// - integer-coefficient stress (small Hilbert-like)

import { expr, int, list, rat as protocolRat, record, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

void expr;
void sym;

const i = (n: bigint | number): { kind: "integer"; value: string } =>
  int(typeof n === "bigint" ? n : BigInt(n));
const q = (n: bigint | number, d: bigint | number) =>
  protocolRat(typeof n === "bigint" ? n : BigInt(n),
              typeof d === "bigint" ? d : BigInt(d));

const mat = (rows: ReadonlyArray<ReadonlyArray<{ kind: "integer"; value: string } | { kind: "rational"; num: string; den: string }>>) =>
  list(rows.map((r) => list([...r])));
const vec = (xs: ReadonlyArray<{ kind: "integer"; value: string } | { kind: "rational"; num: string; den: string }>) =>
  list([...xs]);

const sys = (A: ReturnType<typeof mat>, b: ReturnType<typeof vec>) =>
  record({ A, b });

export const goldens: GoldenSpec[] = [
  // ----- boundary -----
  { description: "0x0 trivial", input: sys(list([]), list([])) },
  {
    description: "1x1 unique x=2",
    input: sys(mat([[i(3)]]), vec([i(6)])),
  },
  {
    description: "1x1 unique x=0",
    input: sys(mat([[i(5)]]), vec([i(0)])),
  },
  {
    description: "1x1 inconsistent (zero coefficient)",
    input: sys(mat([[i(0)]]), vec([i(7)])),
  },

  // ----- 2x2 unique -----
  {
    description: "2x2 identity preserves b",
    input: sys(mat([[i(1), i(0)], [i(0), i(1)]]), vec([i(7), i(-3)])),
  },
  {
    description: "2x2 generic x+2y=5, 3x+4y=11",
    input: sys(mat([[i(1), i(2)], [i(3), i(4)]]), vec([i(5), i(11)])),
  },
  {
    description: "2x2 with negative coeffs",
    input: sys(mat([[i(2), i(-3)], [i(-1), i(4)]]), vec([i(1), i(2)])),
  },
  {
    description: "2x2 rational coeffs (1/2)x + (3/4)y = 5/8",
    input: sys(
      mat([[q(1, 2), q(3, 4)], [i(1), i(-1)]]),
      vec([q(5, 8), i(0)]),
    ),
  },

  // ----- 3x3 unique -----
  {
    description: "3x3 identity",
    input: sys(
      mat([[i(1), i(0), i(0)], [i(0), i(1), i(0)], [i(0), i(0), i(1)]]),
      vec([i(1), i(2), i(3)]),
    ),
  },
  {
    description: "3x3 lower-triangular",
    input: sys(
      mat([[i(2), i(0), i(0)], [i(1), i(3), i(0)], [i(0), i(-1), i(4)]]),
      vec([i(4), i(7), i(2)]),
    ),
  },
  {
    description: "3x3 dense integer",
    input: sys(
      mat([[i(1), i(2), i(3)], [i(2), i(5), i(7)], [i(3), i(7), i(11)]]),
      vec([i(6), i(14), i(21)]),
    ),
  },
  {
    description: "Hilbert H_3 with x_true=(1,-2,1) corrected b",
    input: sys(
      mat([
        [i(1), q(1, 2), q(1, 3)],
        [q(1, 2), q(1, 3), q(1, 4)],
        [q(1, 3), q(1, 4), q(1, 5)],
      ]),
      // b = H_3 · (1, -2, 1) computed exactly: (1/3, 1/12, 1/30)
      vec([q(1, 3), q(1, 12), q(1, 30)]),
    ),
  },

  // ----- larger unique -----
  {
    description: "4x4 banded tridiagonal",
    input: sys(
      mat([
        [i(2), i(-1), i(0), i(0)],
        [i(-1), i(2), i(-1), i(0)],
        [i(0), i(-1), i(2), i(-1)],
        [i(0), i(0), i(-1), i(2)],
      ]),
      vec([i(1), i(0), i(0), i(1)]),
    ),
  },
  {
    description: "5x5 Pascal (consistent)",
    input: sys(
      mat([
        [i(1), i(1), i(1), i(1), i(1)],
        [i(1), i(2), i(3), i(4), i(5)],
        [i(1), i(3), i(6), i(10), i(15)],
        [i(1), i(4), i(10), i(20), i(35)],
        [i(1), i(5), i(15), i(35), i(70)],
      ]),
      vec([i(5), i(15), i(35), i(70), i(126)]),
    ),
  },

  // ----- over-determined consistent -----
  {
    description: "2x1 over-det consistent: 2x=6, 4x=12",
    input: sys(mat([[i(2)], [i(4)]]), vec([i(6), i(12)])),
  },
  {
    description: "3x1 over-det consistent: x=2 thrice",
    input: sys(mat([[i(1)], [i(2)], [i(3)]]), vec([i(2), i(4), i(6)])),
  },

  // ----- under-determined -----
  {
    description: "1x2 single eq: x + 2y = 5",
    input: sys(mat([[i(1), i(2)]]), vec([i(5)])),
  },
  {
    description: "1x3 single eq: x + 2y + 3z = 6",
    input: sys(mat([[i(1), i(2), i(3)]]), vec([i(6)])),
  },
  {
    description: "2x3 rank 2: x+y=4, y+3z=5",
    input: sys(
      mat([[i(1), i(1), i(0)], [i(0), i(1), i(3)]]),
      vec([i(4), i(5)]),
    ),
  },
  {
    description: "3x3 rank 2 consistent (row3 = row1+row2)",
    input: sys(
      mat([[i(1), i(0), i(0)], [i(0), i(1), i(0)], [i(1), i(1), i(0)]]),
      vec([i(2), i(3), i(5)]),
    ),
  },
  {
    description: "3x4 mid-position free var",
    input: sys(
      mat([
        [i(1), i(0), i(2), i(0)],
        [i(0), i(0), i(1), i(0)],
        [i(0), i(0), i(0), i(1)],
      ]),
      vec([i(3), i(1), i(5)]),
    ),
  },

  // ----- inconsistent -----
  {
    description: "2x1 incons: x=3 vs x=7/2",
    input: sys(mat([[i(1)], [i(2)]]), vec([i(3), i(7)])),
  },
  {
    description: "3x2 incons: x=2, y=3, x+y=6 (≠5)",
    input: sys(
      mat([[i(1), i(0)], [i(0), i(1)], [i(1), i(1)]]),
      vec([i(2), i(3), i(6)]),
    ),
  },
  {
    description: "4x3 incons: I_3 + sum-row contradiction",
    input: sys(
      mat([
        [i(1), i(0), i(0)],
        [i(0), i(1), i(0)],
        [i(0), i(0), i(1)],
        [i(1), i(1), i(1)],
      ]),
      vec([i(1), i(2), i(3), i(7)]),
    ),
  },
  {
    description: "3x3 rank-deficient incons",
    input: sys(
      mat([[i(1), i(2), i(3)], [i(2), i(4), i(6)], [i(3), i(6), i(9)]]),
      vec([i(1), i(2), i(4)]),
    ),
  },

  // ----- rationals stress -----
  {
    description: "2x2 rational rhs and matrix",
    input: sys(
      mat([[q(2, 3), q(1, 6)], [q(-1, 2), q(5, 4)]]),
      vec([q(7, 12), q(3, 8)]),
    ),
  },
  {
    description: "3x3 mixed integer/rational",
    input: sys(
      mat([
        [i(1), q(1, 3), i(2)],
        [q(2, 5), i(-1), q(1, 2)],
        [i(0), q(3, 7), i(1)],
      ]),
      vec([q(7, 6), q(-3, 10), q(10, 7)]),
    ),
  },

  // ----- integer-coefficient stress -----
  {
    description: "5x5 dense ints (random-shape) with integer x",
    input: sys(
      mat([
        [i(2), i(1), i(-3), i(0), i(1)],
        [i(1), i(-1), i(2), i(3), i(0)],
        [i(0), i(2), i(1), i(-1), i(2)],
        [i(3), i(0), i(-1), i(1), i(-2)],
        [i(-1), i(1), i(0), i(2), i(3)],
      ]),
      // b = A · (1,2,1,-1,2) computed by hand:
      // row0: 2 + 2 - 3 + 0 + 2 = 3
      // row1: 1 - 2 + 2 - 3 + 0 = -2
      // row2: 0 + 4 + 1 + 1 + 4 = 10
      // row3: 3 + 0 - 1 - 1 - 4 = -3
      // row4: -1 + 2 + 0 - 2 + 6 = 5
      vec([i(3), i(-2), i(10), i(-3), i(5)]),
    ),
  },

  // ----- m×0 boundary -----
  {
    description: "2x0 with zero b: trivially unique",
    input: sys(mat([[], []]), vec([i(0), i(0)])),
  },
  {
    description: "3x0 with non-zero b: inconsistent",
    input: sys(mat([[], [], []]), vec([i(0), i(1), i(0)])),
  },
];
