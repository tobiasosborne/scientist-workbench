// =============================================================================
// mod-inv — modular inverse via the extended Euclidean algorithm
// =============================================================================
//
// Intent
// ------
// Given a value `v` and a modulus `m`, decide whether `v` has a
// multiplicative inverse modulo `m`, and if so produce the unique
// representative in `[0, m)`. The extended Euclidean algorithm is the
// natural fit: it computes `gcd(v, m)` and Bézout coefficients in one
// pass, and `v` is invertible iff that gcd is 1.
//
// No primality assumption on `m`. Works for any modulus ≥ 2. The user-
// facing alternative — Fermat's little theorem (`v^{m-2} mod m`) —
// only holds for prime `m`; we don't depend on it. Internally
// `mod-inv`'s extended-Euclid path is also faster on small inputs
// than Fermat would be via mod-pow.
//
// Output shape (ADR-0003: routine non-success ⇒ record-with-flag)
// ----------------------------------------------------------------
//   record { invertible: boolean,
//            inverse?:  integer in [0, modulus),  // present iff invertible
//            gcd:       integer }                 // always present
//
// "Not invertible" is a *routine* outcome, not a boundary failure: we
// ran the algorithm to completion on a perfectly valid input and
// arrived at a definite answer. The record-with-flag pattern carries
// both the flag and the witness in one canonical shape consumers
// dispatch on uniformly with cas-verify etc.
//
// `ToolError` (process exit 1) is reserved for *malformed* inputs
// (non-record, missing fields, wrong field kinds, modulus < 1). With
// ADR-0004 the schema runner now performs the structural check before
// `fn` runs; the body keeps only the value-domain check (modulus ≥ 1).
//
// Negative `value` is reduced to its canonical residue before
// inversion; `modInv(-3, 7)` returns the inverse of `4 = -3 + 7` in
// [0, 7), which is `2`. `modInv(1, m)` is `1` for every `m ≥ 2`.

import { bool, int, record, S, ToolError } from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import { modInv } from "@workbench/mod-core";

const NAME = "mod-inv";
const VERSION = "0.3.0";

const inp = (value: bigint, modulus: bigint) =>
  record({ value: int(value), modulus: int(modulus) });

const inverseFound = (gcd: bigint, inverse: bigint) =>
  record({ gcd: int(gcd), inverse: int(inverse), invertible: bool(true) });

const noInverse = (gcd: bigint) =>
  record({ gcd: int(gcd), invertible: bool(false) });

// ADR-0003 record-with-flag, declared as a closed schema with `inverse`
// optional. The runner validates against this on every output, so an
// implementation that forgot the witness fields would fail loudly
// rather than ship a degraded record.
const outputSchema = S.record(
  {
    invertible: S.kind("boolean"),
    inverse: S.kind("integer"),
    gcd: S.kind("integer"),
  },
  { optional: ["inverse"] }
);

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: S.record({ value: S.kind("integer"), modulus: S.kind("integer") }),
    output: outputSchema,
  },
  examples: [
    {
      description: "3⁻¹ mod 7 = 5 (since 3·5 = 15 ≡ 1)",
      input: inp(3n, 7n),
      output: inverseFound(1n, 5n),
    },
    {
      description: "5⁻¹ mod 12 = 5",
      input: inp(5n, 12n),
      output: inverseFound(1n, 5n),
    },
    {
      description: "1⁻¹ mod p (p = 998244353) is 1",
      input: inp(1n, 998244353n),
      output: inverseFound(1n, 1n),
    },
    {
      description: "2⁻¹ mod p = (p+1)/2",
      input: inp(2n, 998244353n),
      output: inverseFound(1n, 499122177n),
    },
    {
      description: "(p-1)⁻¹ mod p = p-1 (since (p-1) ≡ -1)",
      input: inp(998244352n, 998244353n),
      output: inverseFound(1n, 998244352n),
    },
    {
      description: "negative input reduces first: (-3)⁻¹ mod 7 = 2",
      input: inp(-3n, 7n),
      output: inverseFound(1n, 2n),
    },
    {
      description: "no-inverse: gcd(6, 9) = 3, no inverse",
      input: inp(6n, 9n),
      output: noInverse(3n),
    },
    {
      description: "no-inverse: 0 mod 7 (gcd = 7)",
      input: inp(0n, 7n),
      output: noInverse(7n),
    },
    {
      description: "no-inverse: gcd(4, 8) = 4",
      input: inp(4n, 8n),
      output: noInverse(4n),
    },
    {
      description: "11⁻¹ mod 26 = 19",
      input: inp(11n, 26n),
      output: inverseFound(1n, 19n),
    },
    {
      description: "12345⁻¹ mod p (large prime) — output omitted; verifier checks shape",
      input: inp(12345n, 998244353n),
    },
  ],
  invariants: [
    { name: "deterministic", statement: "same input bytes → same output bytes", machine_checkable: true },
    { name: "left-inverse", statement: "if invertible=true, then (value · inverse) mod modulus = 1", machine_checkable: true },
    { name: "canonical-range", statement: "if invertible=true, inverse ∈ [0, modulus)", machine_checkable: true },
    { name: "no-inverse-witness", statement: "if invertible=false, gcd > 1 and the record omits 'inverse'", machine_checkable: true },
    { name: "category-2-shape", statement: "output is always record { invertible: boolean, inverse?: integer, gcd: integer } per ADR-0003", machine_checkable: true },
    { name: "rejects-malformed-input", statement: "missing field, non-integer field, or modulus<1 raises ToolError, not a wrong record", machine_checkable: true },
  ],
  fn: (input, _flags) => {
    const value = BigInt(input.fields.value.value);
    const modulus = BigInt(input.fields.modulus.value);
    if (modulus < 1n) {
      throw new ToolError(`${NAME}: modulus must be ≥ 1 (got ${modulus})`, {});
    }
    const r = modInv(value, modulus);
    if (!r.invertible || r.inverse === null) {
      // Routine non-success: record { invertible: false, gcd } with the
      // gcd as witness (ADR-0003 says the result-field is present iff
      // flag=true, so 'inverse' is omitted here).
      return noInverse(r.gcd);
    }
    return inverseFound(1n, r.inverse);
  },
  test: () => {
    const invertibleCases: Array<[bigint, bigint]> = [
      [3n, 7n], [5n, 12n], [11n, 26n], [3n, 998244353n], [2n, 998244353n], [-3n, 7n], [1n, 7n],
    ];
    for (const [v, m] of invertibleCases) {
      const r = modInv(v, m);
      if (!r.invertible || r.inverse === null) throw new Error(`mod-inv: expected invertibility for (${v}, ${m})`);
      const reduced = ((v % m) + m) % m;
      if (((reduced * r.inverse) % m) !== 1n) {
        throw new Error(`mod-inv: ${v} · ${r.inverse} = ${(reduced * r.inverse) % m}, expected 1 mod ${m}`);
      }
      if (r.inverse < 0n || r.inverse >= m) throw new Error(`mod-inv: out of range`);
    }
    const noinv = modInv(6n, 9n);
    if (noinv.invertible) throw new Error(`mod-inv: 6 should not be invertible mod 9`);
    if (noinv.gcd !== 3n) throw new Error(`mod-inv: gcd should be 3, got ${noinv.gcd}`);
  },
});

if (import.meta.main) void runTool(def);
