// =============================================================================
// mod-pow — modular exponentiation: base^exponent mod modulus
// =============================================================================
//
// Intent
// ------
// Compute the canonical residue `base^exponent (mod modulus)` over the
// integers, with the standard square-and-multiply implementation living
// in `@workbench/mod-core`. The tool is a thin envelope: parse the
// canonical input, run the exponentiation, emit the residue.
//
// Input shape
// -----------
//   record { base: integer, exponent: integer, modulus: integer }
//
// The schema is declared with the new `S.*` constructors (ADR-0004).
// What used to be a hand-rolled `expectIntegerField` helper is now the
// runner's job: by the time `fn` runs, the input is already narrowed
// to a record-of-three-integers, and any failure (missing field,
// wrong kind) has surfaced as a `ToolError` with a dotted path before
// reaching this file.
//
// Output shape
// ------------
//   integer in [0, modulus)
//
// Algorithm
// ---------
// `modPow` from `@workbench/mod-core` — square-and-multiply over
// bigint, no Montgomery context (the prime is not fixed). Negative
// bases reduce to canonical residue first; modulus = 1 collapses every
// result to 0; negative exponents are rejected with a suggestion to
// run mod-inv first.

import { int, record, S, ToolError } from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import { modPow } from "@workbench/mod-core";

const NAME = "mod-pow";
const VERSION = "0.2.0";

// Helper to keep the example list readable. Inferred type is narrow
// enough for the schema-typed example slot.
const inp = (base: bigint, exponent: bigint, modulus: bigint) =>
  record({ base: int(base), exponent: int(exponent), modulus: int(modulus) });

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: S.record({
      base: S.kind("integer"),
      exponent: S.kind("integer"),
      modulus: S.kind("integer"),
    }),
    output: S.kind("integer"),
  },
  examples: [
    { description: "0^0 = 1 (bigint convention)", input: inp(0n, 0n, 7n), output: int(1n) },
    { description: "a^0 = 1", input: inp(5n, 0n, 13n), output: int(1n) },
    { description: "a^1 = a", input: inp(5n, 1n, 13n), output: int(5n) },
    { description: "0^k = 0 for k > 0", input: inp(0n, 7n, 13n), output: int(0n) },
    { description: "1^k = 1", input: inp(1n, 99n, 13n), output: int(1n) },
    { description: "2^10 mod 1000 = 24", input: inp(2n, 10n, 1000n), output: int(24n) },
    { description: "Fermat: 2^(p-1) = 1 mod p", input: inp(2n, 998244352n, 998244353n), output: int(1n) },
    { description: "Fermat: 3^(p-1) = 1 mod p", input: inp(3n, 998244352n, 998244353n), output: int(1n) },
    { description: "negative base: (-1)^3 mod 5 = 4", input: inp(-1n, 3n, 5n), output: int(4n) },
    { description: "modulus = 1 collapses to 0", input: inp(7n, 5n, 1n), output: int(0n) },
    { description: "RSA-shaped: 7^65537 mod 1000003", input: inp(7n, 65537n, 1000003n), output: int(modPow(7n, 65537n, 1000003n)) },
    { description: "primitive root g=3 yields 8th root of unity in F_p", input: inp(3n, 124780544n, 998244353n), output: int(modPow(3n, 124780544n, 998244353n)) },
  ],
  invariants: [
    { name: "deterministic", statement: "same input bytes → same output bytes", machine_checkable: true },
    { name: "canonical-range", statement: "output ∈ [0, modulus)", machine_checkable: true },
    { name: "agrees-with-iterated-mul", statement: "for small k, modPow(a, k, m) = a^k mod m by repeated multiplication", machine_checkable: true },
    { name: "fermat-for-prime-modulus", statement: "if m is prime and gcd(a,m)=1, modPow(a, m−1, m) = 1", machine_checkable: false },
    { name: "rejects-negative-exponent", statement: "exp < 0 raises ToolError suggesting mod-inv", machine_checkable: true },
  ],
  fn: (input, _flags) => {
    const base = BigInt(input.fields.base.value);
    const exp = BigInt(input.fields.exponent.value);
    const mod = BigInt(input.fields.modulus.value);
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

void runTool(def);
