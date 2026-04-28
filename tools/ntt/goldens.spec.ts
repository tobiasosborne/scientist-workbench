import { int, list, record, str } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

const P = 998244353n;
const PMOD = int(P);
const GROOT = int(3n);

function nttRecord(n: bigint, direction: "forward" | "inverse", xs: readonly bigint[]): GoldenSpec["input"] {
  return record({
    direction: str(direction),
    modulus: PMOD,
    n: int(n),
    primitive_root: GROOT,
    x: list(xs.map((v) => int(v))),
  });
}

function range(n: number, fn: (i: number) => bigint): bigint[] {
  return Array.from({ length: n }, (_, i) => fn(i));
}

// 30+ goldens: edge cases, power-of-two sizes (radix-2 path), non-power-of-two
// sizes (Bluestein path), forward/inverse pairs, deltas, constants, alternating
// patterns, and a stress case at n = 4096.
export const goldens: GoldenSpec[] = [
  // edge cases
  { description: "n=0 forward", input: nttRecord(0n, "forward", []) },
  { description: "n=0 inverse", input: nttRecord(0n, "inverse", []) },
  { description: "n=1 forward identity", input: nttRecord(1n, "forward", [3n]) },
  { description: "n=1 inverse identity", input: nttRecord(1n, "inverse", [42n]) },

  // n=2
  { description: "n=2 forward [1,1] = [2,0]", input: nttRecord(2n, "forward", [1n, 1n]) },
  { description: "n=2 forward [1, p-1] = [0,2]", input: nttRecord(2n, "forward", [1n, P - 1n]) },
  { description: "n=2 forward [1,0]", input: nttRecord(2n, "forward", [1n, 0n]) },
  { description: "n=2 inverse round-trip", input: nttRecord(2n, "inverse", [2n, 0n]) },

  // n=4 (delta, constants, alternating)
  { description: "n=4 forward delta [1,0,0,0]", input: nttRecord(4n, "forward", [1n, 0n, 0n, 0n]) },
  { description: "n=4 inverse [1,1,1,1] = delta", input: nttRecord(4n, "inverse", [1n, 1n, 1n, 1n]) },
  { description: "n=4 forward constant [3,3,3,3]", input: nttRecord(4n, "forward", [3n, 3n, 3n, 3n]) },
  { description: "n=4 forward alternating [1, p-1, 1, p-1]", input: nttRecord(4n, "forward", [1n, P - 1n, 1n, P - 1n]) },

  // n=8 (radix-2)
  { description: "n=8 forward delta", input: nttRecord(8n, "forward", range(8, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=8 forward constant 5", input: nttRecord(8n, "forward", range(8, () => 5n)) },
  { description: "n=8 forward primes [7,11,13,17,19,23,29,31]", input: nttRecord(8n, "forward", [7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n]) },
  { description: "n=8 inverse round-trips primes (apply forward then inverse → identity is checked separately)", input: nttRecord(8n, "inverse", [7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n]) },

  // n=16, 32, 64 (radix-2 stress)
  { description: "n=16 forward delta", input: nttRecord(16n, "forward", range(16, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=16 forward range x[i] = i", input: nttRecord(16n, "forward", range(16, (i) => BigInt(i))) },
  { description: "n=32 forward x[i] = i^2 mod p", input: nttRecord(32n, "forward", range(32, (i) => BigInt(i * i))) },
  { description: "n=64 forward delta", input: nttRecord(64n, "forward", range(64, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=128 forward range x[i] = (i*7+1) mod p", input: nttRecord(128n, "forward", range(128, (i) => BigInt(i * 7 + 1))) },
  { description: "n=4096 forward delta (radix-2 stress)", input: nttRecord(4096n, "forward", range(4096, (i) => i === 0 ? 1n : 0n)) },

  // Bluestein path (non-pow-2 divisors of p-1)
  { description: "n=7 forward delta", input: nttRecord(7n, "forward", range(7, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=7 forward constant", input: nttRecord(7n, "forward", range(7, () => 11n)) },
  { description: "n=7 forward range", input: nttRecord(7n, "forward", range(7, (i) => BigInt(i + 1))) },
  { description: "n=7 inverse round-trips a forward output (synthetic)", input: nttRecord(7n, "inverse", [7n, 7n, 7n, 7n, 7n, 7n, 7n]) },
  { description: "n=14 forward delta", input: nttRecord(14n, "forward", range(14, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=17 forward delta = all-ones", input: nttRecord(17n, "forward", range(17, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=17 forward range", input: nttRecord(17n, "forward", range(17, (i) => BigInt(i))) },
  { description: "n=28 forward delta", input: nttRecord(28n, "forward", range(28, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=34 forward range", input: nttRecord(34n, "forward", range(34, (i) => BigInt((i * 13 + 5) % 100))) },
  { description: "n=56 forward range", input: nttRecord(56n, "forward", range(56, (i) => BigInt(i * i + 1))) },
  { description: "n=119 forward delta (Bluestein stress)", input: nttRecord(119n, "forward", range(119, (i) => i === 0 ? 1n : 0n)) },
  { description: "n=119 forward range", input: nttRecord(119n, "forward", range(119, (i) => BigInt((i * 31 + 7) % Number(P)))) },

  // saturating-residue cases (boundary of [0, p))
  { description: "n=4 forward all p-1", input: nttRecord(4n, "forward", range(4, () => P - 1n)) },
  { description: "n=8 forward [0, 1, 2, …, p-1, p-2, p-3] mod-saturate", input: nttRecord(8n, "forward", [0n, 1n, 2n, P - 3n, P - 2n, P - 1n, 0n, 1n]) },
];
