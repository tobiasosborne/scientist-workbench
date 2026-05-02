// =============================================================================
// ntt — Number-Theoretic Transform over F_p (p = 998244353, g = 3)
// =============================================================================
//
// Length-n transform with n | (p − 1) = 2^23 · 7 · 17. Power-of-two n
// uses iterative Cooley-Tukey on Uint32Array with a Montgomery REDC
// inner loop; non-power-of-two n uses Bluestein chirp-z reducing to a
// length-(next pow2 ≥ 2n − 1) circular convolution evaluated by the
// same power-of-two NTT.
//
// v0.1 supports modulus = 998244353 only (Montgomery constants are
// frozen for this prime). Other moduli are rejected — honest scope.
//
// Schema (ADR-0004)
// -----------------
// Input is a record of four integers and a `direction` literal-union.
// The schema runner validates field names, kinds, and the
// "forward"|"inverse" enum before `fn` runs. The body still has to
// check value-domain invariants the schema can't express:
//   - modulus and primitive_root must equal the supported constants;
//   - n must agree with |x|;
//   - every x[i] must be a canonical residue in [0, p).
// Those are the kind of refinement constraints ADR-0004 deliberately
// keeps out of the schema language for now (the predicate omission).

import { int, list, record, str, S, ToolError } from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  ntt as nttCore,
  NTT_SUPPORTED_MODULUS,
  NTT_SUPPORTED_PRIMITIVE_ROOT,
} from "@workbench/mod-core";

const NAME = "ntt";
const VERSION = "0.2.0";

const P = NTT_SUPPORTED_MODULUS;

// Direction is a discriminated string literal — exactly the union-of-
// literals shape the schema language was designed for.
const directionSchema = S.union([S.literal(str("forward")), S.literal(str("inverse"))]);

const inputSchema = S.record({
  direction: directionSchema,
  modulus: S.kind("integer"),
  n: S.kind("integer"),
  primitive_root: S.kind("integer"),
  x: S.list(S.kind("integer")),
});

const outputSchema = S.list(S.kind("integer"));

// Compact constructor for example inputs. Keeps the readable layout
// while still preserving the narrow inferred type the schema requires.
const inp = (direction: "forward" | "inverse", n: bigint, x: readonly bigint[]) =>
  record({
    direction: str(direction),
    modulus: int(P),
    n: int(n),
    primitive_root: int(NTT_SUPPORTED_PRIMITIVE_ROOT),
    x: list(x.map(int)),
  });

const out = (xs: readonly bigint[]) => list(xs.map(int));

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "n = 0 returns []",
      input: inp("forward", 0n, []),
      output: out([]),
    },
    {
      description: "n = 1 forward identity",
      input: inp("forward", 1n, [3n]),
      output: out([3n]),
    },
    {
      description: "n = 1 inverse identity",
      input: inp("inverse", 1n, [3n]),
      output: out([3n]),
    },
    {
      description: "n = 2 forward [1,1] = [2,0]",
      input: inp("forward", 2n, [1n, 1n]),
      output: out([2n, 0n]),
    },
    {
      description: "n = 2 forward [1, p-1] = [0, 2]",
      input: inp("forward", 2n, [1n, P - 1n]),
      output: out([0n, 2n]),
    },
    {
      description: "n = 4 forward delta [1,0,0,0] = [1,1,1,1]",
      input: inp("forward", 4n, [1n, 0n, 0n, 0n]),
      output: out([1n, 1n, 1n, 1n]),
    },
    {
      description: "n = 4 inverse [1,1,1,1] = [1,0,0,0]",
      input: inp("inverse", 4n, [1n, 1n, 1n, 1n]),
      output: out([1n, 0n, 0n, 0n]),
    },
    {
      description: "n = 8 constant input [5,5,5,5,5,5,5,5] forward = [40, 0,…]",
      input: inp("forward", 8n, [5n, 5n, 5n, 5n, 5n, 5n, 5n, 5n]),
      output: out([40n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]),
    },
    {
      description: "Bluestein path: n = 7 forward [1,1,1,1,1,1,1] = [7, 0,…]",
      input: inp("forward", 7n, [1n, 1n, 1n, 1n, 1n, 1n, 1n]),
      output: out([7n, 0n, 0n, 0n, 0n, 0n, 0n]),
    },
    {
      description: "Bluestein path: n = 17 delta forward [1,0,…] = [1,1,1,…]",
      input: inp("forward", 17n, Array.from({ length: 17 }, (_, i) => (i === 0 ? 1n : 0n))),
      output: out(Array.from({ length: 17 }, () => 1n)),
    },
    {
      description: "round-trip on n = 8 random input — output omitted; verifier checks shape",
      input: inp("forward", 8n, [7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n]),
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
  fn: (input, _flags) => {
    const modulus = BigInt(input.fields.modulus.value);
    const primitiveRoot = BigInt(input.fields.primitive_root.value);
    if (modulus !== P) {
      throw new ToolError(`${NAME}: v0.1 supports modulus = ${P} only (got ${modulus})`, {
        suggestion: "for other NTT-friendly primes, build a generalising tool that computes Montgomery constants per modulus",
      });
    }
    if (primitiveRoot !== NTT_SUPPORTED_PRIMITIVE_ROOT) {
      throw new ToolError(`${NAME}: v0.1 supports primitive_root = ${NTT_SUPPORTED_PRIMITIVE_ROOT} only (got ${primitiveRoot})`, {});
    }
    const direction = input.fields.direction.value as "forward" | "inverse";
    const declaredN = Number(BigInt(input.fields.n.value));
    if (!Number.isInteger(declaredN) || declaredN < 0) {
      throw new ToolError(`${NAME}: n must be ≥ 0 (got ${input.fields.n.value})`, {});
    }
    const xItems = input.fields.x.items;
    if (declaredN !== xItems.length) {
      throw new ToolError(`${NAME}: declared n=${declaredN} disagrees with |x|=${xItems.length}`, {});
    }
    const x: bigint[] = new Array(declaredN);
    for (let i = 0; i < declaredN; i++) {
      const v = BigInt(xItems[i]!.value);
      if (v < 0n || v >= P) {
        throw new ToolError(`${NAME}: x[${i}] = ${v} is not a canonical residue in [0, ${P})`, {});
      }
      x[i] = v;
    }
    const result = nttCore(x, { direction });
    return list(result.map((r) => int(r)));
  },
  test: () => {
    // Independent oracle for the --test hook.
    //
    // The schoolbook DFT below is an O(n²) reference implementation,
    // *deliberately* written inline rather than pulled from
    // `@workbench/mod-core`. Importing the same `pow` / `modInv`
    // helpers that the production transform itself uses would reduce
    // this hook to "the NTT agrees with itself" — a reflexive check
    // that catches no algorithmic bug. The test's whole point is that
    // a bug in the Cooley-Tukey / Bluestein machinery shows up as a
    // mismatch against a different implementation of the *spec* (the
    // discrete Fourier transform over `F_p` with primitive root `g`),
    // not a mismatch against another callsite of the same code.
    //
    // The independence is the load-bearing property; the duplication
    // is the deliberate cost. If a future agent is tempted to "DRY"
    // these helpers by importing from mod-core, they will silently
    // weaken this hook into a tautology — re-derive the rationale
    // before doing so.
    const G = NTT_SUPPORTED_PRIMITIVE_ROOT;
    function pow(b: bigint, e: bigint, m: bigint): bigint {
      let r = 1n; let bb = b % m; let ee = e;
      while (ee > 0n) { if ((ee & 1n) === 1n) r = (r * bb) % m; bb = (bb * bb) % m; ee >>= 1n; }
      return r;
    }
    function modInvSimple(a: bigint): bigint {
      // Fermat's: works because P is prime.
      return pow(a, P - 2n, P);
    }
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
    function rngBigint(seed: { v: number }, max: bigint): bigint {
      seed.v = (Math.imul(seed.v, 0x6d2b79f5) + 1) | 0;
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

void runTool(def);
