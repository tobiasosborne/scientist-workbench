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
// facing alternative — Fermat's little theorem (`v^{m-2} mod m`) — only
// holds for prime `m`; we don't depend on it here. Internally `mod-inv`'s
// extended-Euclid path is also faster on small inputs than Fermat would
// be via mod-pow.
//
// Output shape (ADR-0003: routine non-success ⇒ record-with-flag)
// ----------------------------------------------------------------
// `mod-inv` always returns a record:
//
//     { invertible: boolean,
//       inverse?:  integer in [0, modulus),  // present iff invertible
//       gcd:       integer,                  // always present (= 1 iff invertible)
//     }
//
// "Not invertible" is a *routine* outcome, not a boundary failure: we ran
// the algorithm to completion on a perfectly valid input and arrived at a
// definite answer ("no inverse exists, here's the gcd witness"). The
// record-with-flag pattern from ADR-0003 carries both the flag and the
// witness in one canonical shape that downstream consumers dispatch on
// uniformly with `cas-verify` etc.
//
// `ToolError` (process exit 1) is reserved for *malformed* inputs:
// non-record input, missing fields, wrong field kinds, modulus < 1.
// Those aren't routine outcomes — they're refusal-to-engage.
//
// Negative `value` is reduced to its canonical residue before inversion;
// `modInv(-3, 7)` returns the inverse of `4 = -3 + 7` in [0, 7), which is
// `2`. `modInv(1, m)` is `1` for every `m ≥ 2`.

import {
  bool,
  int,
  kindOf,
  record,
  ToolError,
  type IntegerValue,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";
import { modInv } from "@workbench/mod-core";

const NAME = "mod-inv";
const VERSION = "0.2.0";

function expectIntegerField(input: Value, field: string): IntegerValue {
  if (input.kind !== "record") {
    throw new ToolError(`${NAME}: input must be a record (got kind ${input.kind})`, {
      suggestion: `wrap as {"kind":"record","fields":{"value":<int>,"modulus":<int>}}`,
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
    input: record({ value: kindOf("integer"), modulus: kindOf("integer") }),
    // ADR-0003 record-with-flag. We declare the always-present fields
    // (`invertible`, `gcd`) and document `inverse` as conditionally
    // present in the README and invariants below.
    output: record({
      invertible: kindOf("boolean"),
      inverse: kindOf("integer"),
      gcd: kindOf("integer"),
    }),
  },
  examples: [
    {
      description: "3⁻¹ mod 7 = 5 (since 3·5 = 15 ≡ 1)",
      input: record({ value: int(3n), modulus: int(7n) }),
      output: record({ gcd: int(1n), inverse: int(5n), invertible: bool(true) }),
    },
    {
      description: "5⁻¹ mod 12 = 5",
      input: record({ value: int(5n), modulus: int(12n) }),
      output: record({ gcd: int(1n), inverse: int(5n), invertible: bool(true) }),
    },
    {
      description: "1⁻¹ mod p (p = 998244353) is 1",
      input: record({ value: int(1n), modulus: int(998244353n) }),
      output: record({ gcd: int(1n), inverse: int(1n), invertible: bool(true) }),
    },
    {
      description: "2⁻¹ mod p = (p+1)/2",
      input: record({ value: int(2n), modulus: int(998244353n) }),
      output: record({ gcd: int(1n), inverse: int(499122177n), invertible: bool(true) }),
    },
    {
      description: "(p-1)⁻¹ mod p = p-1 (since (p-1) ≡ -1)",
      input: record({ value: int(998244352n), modulus: int(998244353n) }),
      output: record({ gcd: int(1n), inverse: int(998244352n), invertible: bool(true) }),
    },
    {
      description: "negative input reduces first: (-3)⁻¹ mod 7 = 2",
      input: record({ value: int(-3n), modulus: int(7n) }),
      output: record({ gcd: int(1n), inverse: int(2n), invertible: bool(true) }),
    },
    {
      description: "no-inverse: gcd(6, 9) = 3, no inverse",
      input: record({ value: int(6n), modulus: int(9n) }),
      output: record({ gcd: int(3n), invertible: bool(false) }),
    },
    {
      description: "no-inverse: 0 mod 7 (gcd = 7)",
      input: record({ value: int(0n), modulus: int(7n) }),
      output: record({ gcd: int(7n), invertible: bool(false) }),
    },
    {
      description: "no-inverse: gcd(4, 8) = 4",
      input: record({ value: int(4n), modulus: int(8n) }),
      output: record({ gcd: int(4n), invertible: bool(false) }),
    },
    {
      description: "11⁻¹ mod 26 = 19",
      input: record({ value: int(11n), modulus: int(26n) }),
      output: record({ gcd: int(1n), inverse: int(19n), invertible: bool(true) }),
    },
    {
      description: "12345⁻¹ mod p (large prime)",
      input: record({ value: int(12345n), modulus: int(998244353n) }),
      // output omitted — verifier checks shape rather than the specific value
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
  fn: (input: Value, _flags: Record<string, string>): Value => {
    const valV = expectIntegerField(input, "value");
    const modV = expectIntegerField(input, "modulus");
    const value = BigInt(valV.value);
    const modulus = BigInt(modV.value);
    if (modulus < 1n) {
      throw new ToolError(`${NAME}: modulus must be ≥ 1 (got ${modulus})`, {});
    }
    const r = modInv(value, modulus);
    if (!r.invertible || r.inverse === null) {
      // Routine non-success: emit record with invertible=false plus the
      // gcd witness. No `inverse` field in this branch (ADR-0003 says
      // "result-field present iff flag=true").
      return record({ gcd: int(r.gcd), invertible: bool(false) });
    }
    return record({ gcd: int(1n), inverse: int(r.inverse), invertible: bool(true) });
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
