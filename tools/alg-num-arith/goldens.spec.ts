import { record, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Wire-encoded Root[poly, k] expression Values, per ADR-0018.
function rootVal(coefs: bigint[], k: bigint): Value {
  return {
    kind: "expression",
    head: "Root",
    args: [
      {
        kind: "expression",
        head: "Polynomial",
        args: coefs.map((c) => ({ kind: "integer", value: c.toString() }) as Value),
      },
      { kind: "integer", value: k.toString() },
    ],
  };
}

function inpAB(a: Value, b: Value): Value {
  return record({ a, b });
}
function inpA(a: Value): Value {
  return record({ a });
}

// Common Root values:
//   Root[x − 1, 0]      = +1                        ← rational degenerate
//   Root[x, 0]          = 0
//   Root[x² − 2, 0/1]   = ∓√2
//   Root[x² − 3, 0/1]   = ∓√3
//   Root[x² − 5, 0/1]   = ∓√5
//   Root[2x² − 1, 0/1]  = ∓1/√2 (canonical-non-monic minpoly)
const ZERO    = rootVal([0n, 1n], 0n);
const ONE     = rootVal([-1n, 1n], 0n);
const NEG_ONE = rootVal([1n, 1n], 0n);
const SQRT2   = rootVal([-2n, 0n, 1n], 1n);
const NEG_SQRT2 = rootVal([-2n, 0n, 1n], 0n);
const SQRT3   = rootVal([-3n, 0n, 1n], 1n);
const NEG_SQRT3 = rootVal([-3n, 0n, 1n], 0n);
const SQRT5   = rootVal([-5n, 0n, 1n], 1n);
const SQRT6   = rootVal([-6n, 0n, 1n], 1n);

export const goldens: GoldenSpec[] = [
  // ── Tier A — elementary arithmetic ─────────────────────────────────────────
  { description: "add: √2 + √3 ⟹ Root[x⁴ − 10x² + 1, k=3]", input: inpAB(SQRT2, SQRT3), flags: { op: "add" } },
  { description: "add: 1 + √2 ⟹ Root[x² − 2x − 1, k=1]",   input: inpAB(ONE, SQRT2),   flags: { op: "add" } },
  { description: "add: √2 + (−√2) ⟹ 0 (additive inverse)", input: inpAB(SQRT2, NEG_SQRT2), flags: { op: "add" } },
  { description: "sub: √3 − √2 ⟹ Root[x⁴ − 10x² + 1, k=2]", input: inpAB(SQRT3, SQRT2),  flags: { op: "sub" } },
  { description: "sub: √2 − √2 ⟹ 0",                        input: inpAB(SQRT2, SQRT2),  flags: { op: "sub" } },
  { description: "mul: √2 · √3 ⟹ Root[x² − 6, k=1] = +√6",  input: inpAB(SQRT2, SQRT3),  flags: { op: "mul" } },
  { description: "mul: √2 · √2 ⟹ Root[x − 2, k=0] (rational degenerate)", input: inpAB(SQRT2, SQRT2), flags: { op: "mul" } },
  { description: "mul: √2 · (−√2) ⟹ −2",                    input: inpAB(SQRT2, NEG_SQRT2), flags: { op: "mul" } },
  { description: "div: √6 / √2 ⟹ Root[x² − 3, k=1] = +√3", input: inpAB(SQRT6, SQRT2), flags: { op: "div" } },
  { description: "div: √2 / √2 ⟹ 1",                        input: inpAB(SQRT2, SQRT2), flags: { op: "div" } },
  { description: "neg: +√2 ⟹ −√2 (k flips 1→0)",            input: inpA(SQRT2),         flags: { op: "neg" } },
  { description: "neg: 1 ⟹ −1 (rational case)",             input: inpA(ONE),           flags: { op: "neg" } },
  { description: "inv: √2 ⟹ Root[2x² − 1, k=1] (1/√2; non-monic minpoly is canonical)", input: inpA(SQRT2), flags: { op: "inv" } },
  { description: "inv: 1 ⟹ 1 (self-inverse)",               input: inpA(ONE),           flags: { op: "inv" } },

  // ── Tier B — eq (canonical-form equality) ────────────────────────────────
  { description: "eq: +√2 == +√2 ⟹ true",   input: inpAB(SQRT2, SQRT2),     flags: { op: "eq" } },
  { description: "eq: +√2 == −√2 ⟹ false (same minpoly, different k)", input: inpAB(SQRT2, NEG_SQRT2), flags: { op: "eq" } },
  { description: "eq: +√2 == +√3 ⟹ false (different minpolys)", input: inpAB(SQRT2, SQRT3), flags: { op: "eq" } },
  { description: "eq: 0 == 0 ⟹ true (rational case)",           input: inpAB(ZERO, ZERO),    flags: { op: "eq" } },
  { description: "eq: 1 == 1 ⟹ true (rational case)",           input: inpAB(ONE, ONE),      flags: { op: "eq" } },
  { description: "eq: 1 == −1 ⟹ false",                          input: inpAB(ONE, NEG_ONE),  flags: { op: "eq" } },

  // ── Tier C — refusals ────────────────────────────────────────────────────
  { description: "inv(0) ⟹ tagged alg-num-arith/inv-of-zero",   input: inpA(ZERO),       flags: { op: "inv" } },
  { description: "div(√2, 0) ⟹ tagged alg-num-arith/div-by-zero", input: inpAB(SQRT2, ZERO), flags: { op: "div" } },

  // ── Tier D — composition / round-trip ────────────────────────────────────
  { description: "add(√2, √5) ⟹ Root[x⁴ − 14x² + 9, k=3] (+√2 + +√5)", input: inpAB(SQRT2, SQRT5), flags: { op: "add" } },
  { description: "mul(√2, √5) ⟹ Root[x² − 10, k=1] = +√10",      input: inpAB(SQRT2, SQRT5), flags: { op: "mul" } },
  { description: "neg(neg(+√2)) ⟹ +√2 (involution)",              input: inpA(NEG_SQRT2),     flags: { op: "neg" } },
  { description: "inv(inv(+√2)) ⟹ +√2 (involution)",              input: inpA(rootVal([-1n, 0n, 2n], 1n)), flags: { op: "inv" } },
  { description: "neg(−√3) ⟹ +√3",                                 input: inpA(NEG_SQRT3),     flags: { op: "neg" } },
];
