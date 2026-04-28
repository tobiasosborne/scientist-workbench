// ntt — Number-Theoretic Transform over F_p (p = 998244353, g = 3),
// arbitrary length n with n | (p − 1) = 2^23 · 7 · 17.
// Input:  record { n: integer, modulus: integer, primitive_root: integer,
//                  direction: string ("forward" | "inverse"),
//                  x: list<integer> }
// Output: list<integer>  — length n, each in [0, p).
//
// Power-of-two n: iterative Cooley-Tukey, Montgomery REDC inner loop.
// Other n: Bluestein chirp-z reducing to a length-(next pow2 ≥ 2n−1)
//          circular convolution evaluated by the same power-of-two NTT.
//
// v0.1 supports modulus = 998244353 only (Montgomery constants are
// frozen for this prime). Other moduli are rejected — honest scope.

import {
  int,
  kindOf,
  list,
  record,
  str,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";
import {
  ntt as nttCore,
  NTT_SUPPORTED_MODULUS,
  NTT_SUPPORTED_PRIMITIVE_ROOT,
} from "@workbench/mod-core";

const NAME = "ntt";
const VERSION = "0.1.0";

const P = NTT_SUPPORTED_MODULUS;

interface ParsedInput {
  n: number;
  direction: "forward" | "inverse";
  x: bigint[];
}

function parseNttInput(input: Value): ParsedInput {
  if (input.kind !== "record") {
    throw new ToolError(`${NAME}: input must be a record (got kind ${input.kind})`, {
      suggestion: "shape: {n: integer, modulus: integer, primitive_root: integer, direction: \"forward\"|\"inverse\", x: list<integer>}",
    });
  }
  const fields = input.fields;
  const nV = fields["n"];
  const modV = fields["modulus"];
  const grV = fields["primitive_root"];
  const dirV = fields["direction"];
  const xV = fields["x"];

  if (!nV || nV.kind !== "integer") throw new ToolError(`${NAME}: field 'n' must be an integer`, {});
  if (!modV || modV.kind !== "integer") throw new ToolError(`${NAME}: field 'modulus' must be an integer`, {});
  if (!grV || grV.kind !== "integer") throw new ToolError(`${NAME}: field 'primitive_root' must be an integer`, {});
  if (!dirV || dirV.kind !== "string") throw new ToolError(`${NAME}: field 'direction' must be a string`, {});
  if (!xV || xV.kind !== "list") throw new ToolError(`${NAME}: field 'x' must be a list`, {});

  const modulus = BigInt(modV.value);
  const primitiveRoot = BigInt(grV.value);
  if (modulus !== P) {
    throw new ToolError(`${NAME}: v0.1 supports modulus = ${P} only (got ${modulus})`, {
      suggestion: "for other NTT-friendly primes, build a generalising tool that computes Montgomery constants per modulus",
    });
  }
  if (primitiveRoot !== NTT_SUPPORTED_PRIMITIVE_ROOT) {
    throw new ToolError(`${NAME}: v0.1 supports primitive_root = ${NTT_SUPPORTED_PRIMITIVE_ROOT} only (got ${primitiveRoot})`, {});
  }
  const direction = dirV.value;
  if (direction !== "forward" && direction !== "inverse") {
    throw new ToolError(`${NAME}: direction must be "forward" or "inverse" (got ${JSON.stringify(direction)})`, {});
  }
  const n = Number(BigInt(nV.value));
  if (!Number.isInteger(n) || n < 0) {
    throw new ToolError(`${NAME}: n must be ≥ 0 (got ${nV.value})`, {});
  }
  if (n !== xV.items.length) {
    throw new ToolError(`${NAME}: declared n=${n} disagrees with |x|=${xV.items.length}`, {});
  }
  const x: bigint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const item = xV.items[i]!;
    if (item.kind !== "integer") {
      throw new ToolError(`${NAME}: x[${i}] must be an integer (got kind ${item.kind})`, {});
    }
    const v = BigInt(item.value);
    if (v < 0n || v >= P) {
      throw new ToolError(`${NAME}: x[${i}] = ${v} is not a canonical residue in [0, ${P})`, {});
    }
    x[i] = v;
  }
  return { n, direction, x };
}

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    // Each numeric field is annotated with kindOf("integer") rather than a
    // sample value — `n: int(0n)` would suggest the schema cares about the
    // specific `0`, which it does not. The `x` field is a list of integers,
    // not an opaque list-of-anything; kindOf("integer") inside list([...])
    // makes that visible to registry-search and downstream schema
    // consumers. See ADR-0002.
    input: record({
      direction: kindOf("string"),
      modulus: kindOf("integer"),
      n: kindOf("integer"),
      primitive_root: kindOf("integer"),
      x: list([kindOf("integer")]),
    }),
    output: list([kindOf("integer")]),
  },
  examples: [
    {
      description: "n = 0 returns []",
      input: record({ direction: str("forward"), modulus: int(P), n: int(0n), primitive_root: int(3n), x: list([]) }),
      output: list([]),
    },
    {
      description: "n = 1 forward identity",
      input: record({ direction: str("forward"), modulus: int(P), n: int(1n), primitive_root: int(3n), x: list([int(3n)]) }),
      output: list([int(3n)]),
    },
    {
      description: "n = 1 inverse identity",
      input: record({ direction: str("inverse"), modulus: int(P), n: int(1n), primitive_root: int(3n), x: list([int(3n)]) }),
      output: list([int(3n)]),
    },
    {
      description: "n = 2 forward [1,1] = [2,0]",
      input: record({ direction: str("forward"), modulus: int(P), n: int(2n), primitive_root: int(3n), x: list([int(1n), int(1n)]) }),
      output: list([int(2n), int(0n)]),
    },
    {
      description: "n = 2 forward [1, p-1] = [0, 2]",
      input: record({ direction: str("forward"), modulus: int(P), n: int(2n), primitive_root: int(3n), x: list([int(1n), int(P - 1n)]) }),
      output: list([int(0n), int(2n)]),
    },
    {
      description: "n = 4 forward delta [1,0,0,0] = [1,1,1,1]",
      input: record({ direction: str("forward"), modulus: int(P), n: int(4n), primitive_root: int(3n), x: list([int(1n), int(0n), int(0n), int(0n)]) }),
      output: list([int(1n), int(1n), int(1n), int(1n)]),
    },
    {
      description: "n = 4 inverse [1,1,1,1] = [1,0,0,0]",
      input: record({ direction: str("inverse"), modulus: int(P), n: int(4n), primitive_root: int(3n), x: list([int(1n), int(1n), int(1n), int(1n)]) }),
      output: list([int(1n), int(0n), int(0n), int(0n)]),
    },
    {
      description: "n = 8 constant input [5,5,5,5,5,5,5,5] forward = [40, 0,…]",
      input: record({ direction: str("forward"), modulus: int(P), n: int(8n), primitive_root: int(3n), x: list([int(5n), int(5n), int(5n), int(5n), int(5n), int(5n), int(5n), int(5n)]) }),
      output: list([int(40n), int(0n), int(0n), int(0n), int(0n), int(0n), int(0n), int(0n)]),
    },
    {
      description: "Bluestein path: n = 7 forward [1,1,1,1,1,1,1] = [7, 0,…]",
      input: record({ direction: str("forward"), modulus: int(P), n: int(7n), primitive_root: int(3n), x: list([int(1n), int(1n), int(1n), int(1n), int(1n), int(1n), int(1n)]) }),
      output: list([int(7n), int(0n), int(0n), int(0n), int(0n), int(0n), int(0n)]),
    },
    {
      description: "Bluestein path: n = 17 delta forward [1,0,…] = [1,1,1,…]",
      input: record({ direction: str("forward"), modulus: int(P), n: int(17n), primitive_root: int(3n), x: list(Array.from({ length: 17 }, (_, i) => int(i === 0 ? 1n : 0n))) }),
      output: list(Array.from({ length: 17 }, () => int(1n))),
    },
    {
      description: "round-trip on n = 8 random input",
      input: record({
        direction: str("forward"),
        modulus: int(P),
        n: int(8n),
        primitive_root: int(3n),
        x: list([int(7n), int(11n), int(13n), int(17n), int(19n), int(23n), int(29n), int(31n)]),
      }),
    },
  ],
  invariants: [
    { name: "deterministic", statement: "same input bytes → same output bytes", machine_checkable: true },
    { name: "canonical-range", statement: "every output residue is in [0, p)", machine_checkable: true },
    { name: "round-trip", statement: "ntt(ntt(x, forward), inverse) = x exactly (mod p)", machine_checkable: true },
    { name: "agrees-with-schoolbook", statement: "for n that divides p−1, output equals the O(n²) DFT sum mod p", machine_checkable: true },
    { name: "linearity", statement: "ntt(α·x + β·y) ≡ α·ntt(x) + β·ntt(y) (mod p)", machine_checkable: true },
    { name: "honest-scope", statement: "modulus ≠ 998244353 or primitive_root ≠ 3 raises ToolError, never produces a wrong residue", machine_checkable: true },
  ],
  fn: (input: Value, _flags: Record<string, string>): Value => {
    const { direction, x } = parseNttInput(input);
    const out = nttCore(x, { direction });
    return list(out.map((r) => int(r)));
  },
  test: () => {
    // Independent oracle: O(n²) schoolbook DFT, used as a checked baseline.
    const G = NTT_SUPPORTED_PRIMITIVE_ROOT;
    function schoolbook(x: readonly bigint[], invert: boolean): bigint[] {
      const n = x.length;
      if (n === 0) return [];
      const omegaPrim = pow(G, (P - 1n) / BigInt(n), P);
      const w = invert ? modInvSimple(omegaPrim) : omegaPrim;
      const out: bigint[] = new Array(n).fill(0n);
      for (let k = 0; k < n; k++) {
        const wk = pow(w, BigInt(k), P);
        let s = 0n;
        let wjk = 1n;
        for (let j = 0; j < n; j++) {
          s = (s + x[j]! * wjk) % P;
          wjk = (wjk * wk) % P;
        }
        out[k] = s;
      }
      if (invert) {
        const nInv = modInvSimple(BigInt(n));
        for (let k = 0; k < n; k++) out[k] = (out[k]! * nInv) % P;
      }
      return out;
    }
    function pow(b: bigint, e: bigint, m: bigint): bigint {
      let r = 1n; let bb = b % m; let ee = e;
      while (ee > 0n) { if ((ee & 1n) === 1n) r = (r * bb) % m; bb = (bb * bb) % m; ee >>= 1n; }
      return r;
    }
    function modInvSimple(a: bigint): bigint {
      // Fermat's: works for prime modulus P.
      return pow(a, P - 2n, P);
    }
    function rngBigint(seed: { v: number }, max: bigint): bigint {
      seed.v = Math.imul(seed.v, 0x6d2b79f5) + 1 | 0;
      const u = (seed.v >>> 0) / 4294967296;
      return BigInt(Math.floor(u * Number(max)));
    }
    const seed = { v: 0xdeadbeef | 0 };
    for (const n of [1, 2, 4, 7, 8, 14, 16, 17, 32, 119]) {
      const x: bigint[] = [];
      for (let i = 0; i < n; i++) x.push(rngBigint(seed, P));
      const fwd = nttCore(x, { direction: "forward" });
      const expected = schoolbook(x, false);
      if (fwd.length !== expected.length) throw new Error(`ntt: length mismatch for n=${n}`);
      for (let i = 0; i < n; i++) {
        if (fwd[i] !== expected[i]) throw new Error(`ntt: forward mismatch at n=${n}, k=${i}: got ${fwd[i]}, expected ${expected[i]}`);
      }
      const back = nttCore(fwd, { direction: "inverse" });
      for (let i = 0; i < n; i++) {
        if (back[i] !== x[i]) throw new Error(`ntt: round-trip mismatch at n=${n}, j=${i}`);
      }
    }
  },
});
