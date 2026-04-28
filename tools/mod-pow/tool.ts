// mod-pow — modular exponentiation: base^exponent mod modulus.
// Input:  record { base: integer, exponent: integer, modulus: integer }
// Output: integer in [0, modulus)
//
// Negative bases are reduced to the canonical residue before exponentiation:
// modPow(-1, 3, 5) = 4. Negative exponents are rejected (use mod-inv first).
// Modulus = 1 collapses every result to 0 (consistent with the zero ring).

import {
  int,
  kindOf,
  record,
  ToolError,
  type IntegerValue,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";
import { modPow } from "@workbench/mod-core";

const NAME = "mod-pow";
const VERSION = "0.1.0";

function expectIntegerField(input: Value, field: string): IntegerValue {
  if (input.kind !== "record") {
    throw new ToolError(`${NAME}: input must be a record (got kind ${input.kind})`, {
      suggestion: `wrap as {"kind":"record","fields":{"base":<int>,"exponent":<int>,"modulus":<int>}}`,
    });
  }
  const v = input.fields[field];
  if (v === undefined) throw new ToolError(`${NAME}: missing field '${field}'`, {});
  if (v.kind !== "integer") {
    throw new ToolError(`${NAME}: field '${field}' must be an integer (got kind ${v.kind})`, {});
  }
  return v;
}

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    // ADR-0002: the schema declares the *kinds* of the fields, not specific
    // values. The previous form `int(0n)` was misleading — there is nothing
    // load-bearing about 0.
    input: record({
      base: kindOf("integer"),
      exponent: kindOf("integer"),
      modulus: kindOf("integer"),
    }),
    output: kindOf("integer"),
  },
  examples: [
    { description: "0^0 = 1 (bigint convention)", input: record({ base: int(0n), exponent: int(0n), modulus: int(7n) }), output: int(1n) },
    { description: "a^0 = 1", input: record({ base: int(5n), exponent: int(0n), modulus: int(13n) }), output: int(1n) },
    { description: "a^1 = a", input: record({ base: int(5n), exponent: int(1n), modulus: int(13n) }), output: int(5n) },
    { description: "0^k = 0 for k > 0", input: record({ base: int(0n), exponent: int(7n), modulus: int(13n) }), output: int(0n) },
    { description: "1^k = 1", input: record({ base: int(1n), exponent: int(99n), modulus: int(13n) }), output: int(1n) },
    { description: "2^10 mod 1000 = 24", input: record({ base: int(2n), exponent: int(10n), modulus: int(1000n) }), output: int(24n) },
    { description: "Fermat: 2^(p-1) = 1 mod p", input: record({ base: int(2n), exponent: int(998244352n), modulus: int(998244353n) }), output: int(1n) },
    { description: "Fermat: 3^(p-1) = 1 mod p", input: record({ base: int(3n), exponent: int(998244352n), modulus: int(998244353n) }), output: int(1n) },
    { description: "negative base: (-1)^3 mod 5 = 4", input: record({ base: int(-1n), exponent: int(3n), modulus: int(5n) }), output: int(4n) },
    { description: "modulus = 1 collapses to 0", input: record({ base: int(7n), exponent: int(5n), modulus: int(1n) }), output: int(0n) },
    { description: "RSA-shaped: 7^65537 mod 1000003", input: record({ base: int(7n), exponent: int(65537n), modulus: int(1000003n) }), output: int(modPow(7n, 65537n, 1000003n)) },
    { description: "primitive root g=3 yields 8th root of unity in F_p", input: record({ base: int(3n), exponent: int(124780544n), modulus: int(998244353n) }), output: int(modPow(3n, 124780544n, 998244353n)) },
  ],
  invariants: [
    { name: "deterministic", statement: "same input bytes → same output bytes", machine_checkable: true },
    { name: "canonical-range", statement: "output ∈ [0, modulus)", machine_checkable: true },
    { name: "agrees-with-iterated-mul", statement: "for small k, modPow(a, k, m) = a^k mod m by repeated multiplication", machine_checkable: true },
    { name: "fermat-for-prime-modulus", statement: "if m is prime and gcd(a,m)=1, modPow(a, m−1, m) = 1", machine_checkable: false },
    { name: "rejects-negative-exponent", statement: "exp < 0 raises ToolError suggesting mod-inv", machine_checkable: true },
  ],
  fn: (input: Value, _flags: Record<string, string>): Value => {
    const baseV = expectIntegerField(input, "base");
    const expV = expectIntegerField(input, "exponent");
    const modV = expectIntegerField(input, "modulus");
    const base = BigInt(baseV.value);
    const exp = BigInt(expV.value);
    const mod = BigInt(modV.value);
    if (exp < 0n) {
      throw new ToolError(`${NAME}: exponent must be ≥ 0 (got ${exp})`, {
        suggestion: "for negative exponents, run mod-inv on the base first, then mod-pow with |exp|",
      });
    }
    if (mod < 1n) {
      throw new ToolError(`${NAME}: modulus must be ≥ 1 (got ${mod})`, {});
    }
    return int(modPow(base, exp, mod));
  },
  test: () => {
    function naive(a: bigint, e: bigint, m: bigint): bigint {
      let acc = 1n % m;
      let b = ((a % m) + m) % m;
      for (let k = 0n; k < e; k++) acc = (acc * b) % m;
      return acc;
    }
    const cases: Array<[bigint, bigint, bigint]> = [
      [0n, 0n, 7n], [1n, 99n, 13n], [2n, 10n, 1000n], [-1n, 3n, 5n],
      [7n, 12n, 31n], [123n, 17n, 1000003n], [3n, 25n, 998244353n], [5n, 0n, 1n],
    ];
    for (const [a, e, m] of cases) {
      const r = modPow(a, e, m);
      const want = naive(a, e, m);
      if (r !== want) throw new Error(`mod-pow: ${a}^${e} mod ${m} got ${r}, expected ${want}`);
      if (r < 0n || r >= m) throw new Error(`mod-pow output out of range: ${r} ∉ [0, ${m})`);
    }
  },
});
