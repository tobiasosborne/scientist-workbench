// =============================================================================
// pattern.test.ts — predicate-shape tests for `src/pattern.ts`
// =============================================================================
//
// Three predicates under test: `isPositiveInteger`,
// `isNonNegativeInteger`, `isHalfInteger`. Each test block walks the
// boundary cases R1 §14 + ADR-0041 §Decision 6 call out, plus the
// non-numeric Value kinds (must return `false`, never throw).
//
// Mutation-prove panel
// --------------------
// Three load-bearing perturbations documented in the worklog shard
// (`docs/worklog/145-i6b-pattern-primitives.md`) ARE expected to
// flip specific tests below to RED:
//
//   M1 — Flip `>=` to `>` in `isNonNegativeInteger`.
//        → "zero classifies as non-negative" goes RED.
//        Caught by `isNonNegativeInteger(int(0n))` test below.
//   M2 — Accept all rationals as half-integer (drop the `den !== 2n`
//        guard in `isHalfInteger`).
//        → "5/3 is not half-integer" goes RED.
//        Caught by `isHalfInteger(rat(5n, 3n))` and similar tests below.
//   M3 — Treat negative-integer-valued Values as positive (replace
//        `> 0n` with `!== 0n` in `isPositiveInteger`).
//        → "negative is not positive" goes RED.
//        Caught by `isPositiveInteger(int(-1n))` test below.
//
// Each mutation has at least ONE distinct test pinning it. The
// mutation-prove drill: temporarily apply the mutation, run `bun test
// pattern.test.ts`, verify the indicated test fails, restore.
//
// References
// ----------
// * `packages/cas-core/src/pattern.ts` — module under test.
// * `docs/refs/besselj-research/R1-symbolic-identities.md` §14.5 —
//   the table of predicates + the rule classes each gates.
// * `docs/adr/0041-bessel-family-per-head-substrate.md` §Decision 6.

import { describe, expect, test } from "bun:test";
import {
  bool,
  expr,
  float64FromNumber,
  int,
  list,
  rat,
  record,
  str,
  sym,
  tagged,
  type Value,
} from "@workbench/protocol";
import {
  isHalfInteger,
  isNonNegativeInteger,
  isPositiveInteger,
} from "../src/pattern.js";

// A representative set of non-numeric Value kinds. Every predicate
// must return `false` (never throw, never `undefined`) on each.
const NON_NUMERIC_KINDS: ReadonlyArray<{ readonly label: string; readonly v: Value }> = [
  { label: "symbol", v: sym("nu") },
  { label: "string", v: str("not a number") },
  { label: "boolean(true)", v: bool(true) },
  { label: "boolean(false)", v: bool(false) },
  { label: "float64(0.5)", v: float64FromNumber(0.5) },
  { label: "float64(1.0)", v: float64FromNumber(1.0) },
  { label: "float64(-3.0)", v: float64FromNumber(-3.0) },
  { label: "list", v: list([int(1n), int(2n)]) },
  { label: "record", v: record({ a: int(1n) }) },
  { label: "expression", v: expr("BesselJ", [int(1n), sym("z")]) },
  { label: "tagged", v: tagged("schema/kind", sym("integer")) },
];

// =============================================================================
// isPositiveInteger
// =============================================================================

describe("isPositiveInteger", () => {
  test("int(1) → true (smallest positive integer)", () => {
    expect(isPositiveInteger(int(1n))).toBe(true);
  });

  test("int(2) → true", () => {
    expect(isPositiveInteger(int(2n))).toBe(true);
  });

  test("int(42) → true", () => {
    expect(isPositiveInteger(int(42n))).toBe(true);
  });

  test("int(very-large) → true (BigInt path, no Number-precision loss)", () => {
    // 10^40 + 1 — far outside Number.MAX_SAFE_INTEGER (≈ 9e15). Using
    // JS Number arithmetic here would lose precision; the predicate
    // uses BigInt throughout.
    const big = BigInt("10000000000000000000000000000000000000001");
    expect(isPositiveInteger(int(big))).toBe(true);
  });

  test("int(0) → false (zero is not POSITIVE)", () => {
    expect(isPositiveInteger(int(0n))).toBe(false);
  });

  // Mutation-prove M3 pinning.
  test("int(-1) → false (negative is not positive — pins M3)", () => {
    expect(isPositiveInteger(int(-1n))).toBe(false);
  });

  test("int(-42) → false", () => {
    expect(isPositiveInteger(int(-42n))).toBe(false);
  });

  test("rat(6/3) → true (reduces to integer 2 > 0)", () => {
    expect(isPositiveInteger(rat(6n, 3n))).toBe(true);
  });

  test("rat(-6/3) → false (reduces to integer -2 < 0)", () => {
    expect(isPositiveInteger(rat(-6n, 3n))).toBe(false);
  });

  test("rat(0/5) → false (reduces to integer 0)", () => {
    expect(isPositiveInteger(rat(0n, 5n))).toBe(false);
  });

  test("rat(3/2) → false (non-integer rational)", () => {
    expect(isPositiveInteger(rat(3n, 2n))).toBe(false);
  });

  test("rat(7/2) → false (non-integer rational)", () => {
    expect(isPositiveInteger(rat(7n, 2n))).toBe(false);
  });

  test("raw non-canonical rational 4/2 → true (reduces to 2)", () => {
    // Skipping `rat()` factory — tests the predicate's tolerance for
    // unreduced raw literals (JSON-bridge / golden-file inputs may
    // arrive non-canonical before validation).
    const raw: Value = { kind: "rational", num: "4", den: "2" };
    expect(isPositiveInteger(raw)).toBe(true);
  });

  test("raw rational with negative denominator (-6 / -3 = 2) → true", () => {
    // The validator would reject `den < 0` on the wire, but the
    // predicate must still classify the mathematical value correctly
    // when fed raw data.
    const raw: Value = { kind: "rational", num: "-6", den: "-3" };
    expect(isPositiveInteger(raw)).toBe(true);
  });

  test("degenerate rational with zero denominator → false (not throw)", () => {
    // Total-function contract: no exception, just `false`.
    const raw: Value = { kind: "rational", num: "5", den: "0" };
    expect(isPositiveInteger(raw)).toBe(false);
  });

  for (const { label, v } of NON_NUMERIC_KINDS) {
    test(`${label} → false (non-numeric kind)`, () => {
      expect(isPositiveInteger(v)).toBe(false);
    });
  }
});

// =============================================================================
// isNonNegativeInteger
// =============================================================================

describe("isNonNegativeInteger", () => {
  // Mutation-prove M1 pinning.
  test("int(0) → true (zero IS non-negative — pins M1)", () => {
    expect(isNonNegativeInteger(int(0n))).toBe(true);
  });

  test("int(1) → true", () => {
    expect(isNonNegativeInteger(int(1n))).toBe(true);
  });

  test("int(42) → true", () => {
    expect(isNonNegativeInteger(int(42n))).toBe(true);
  });

  test("int(very-large) → true (BigInt path)", () => {
    const big = BigInt("99999999999999999999999999999999999999");
    expect(isNonNegativeInteger(int(big))).toBe(true);
  });

  test("int(-1) → false", () => {
    expect(isNonNegativeInteger(int(-1n))).toBe(false);
  });

  test("int(-42) → false", () => {
    expect(isNonNegativeInteger(int(-42n))).toBe(false);
  });

  test("int(-very-large) → false (BigInt path)", () => {
    const big = -BigInt("12345678901234567890");
    expect(isNonNegativeInteger(int(big))).toBe(false);
  });

  test("rat(0/5) → true (reduces to integer 0)", () => {
    expect(isNonNegativeInteger(rat(0n, 5n))).toBe(true);
  });

  test("rat(6/3) → true (reduces to integer 2)", () => {
    expect(isNonNegativeInteger(rat(6n, 3n))).toBe(true);
  });

  test("rat(-6/3) → false (reduces to integer -2)", () => {
    expect(isNonNegativeInteger(rat(-6n, 3n))).toBe(false);
  });

  test("rat(3/2) → false (non-integer rational)", () => {
    expect(isNonNegativeInteger(rat(3n, 2n))).toBe(false);
  });

  test("rat(-3/2) → false (non-integer rational + negative)", () => {
    expect(isNonNegativeInteger(rat(-3n, 2n))).toBe(false);
  });

  test("raw non-canonical rational 4/2 → true (reduces to 2)", () => {
    const raw: Value = { kind: "rational", num: "4", den: "2" };
    expect(isNonNegativeInteger(raw)).toBe(true);
  });

  test("raw non-canonical rational 0/7 → true (reduces to 0)", () => {
    const raw: Value = { kind: "rational", num: "0", den: "7" };
    expect(isNonNegativeInteger(raw)).toBe(true);
  });

  test("degenerate rational with zero denominator → false (not throw)", () => {
    const raw: Value = { kind: "rational", num: "0", den: "0" };
    expect(isNonNegativeInteger(raw)).toBe(false);
  });

  for (const { label, v } of NON_NUMERIC_KINDS) {
    test(`${label} → false (non-numeric kind)`, () => {
      expect(isNonNegativeInteger(v)).toBe(false);
    });
  }
});

// =============================================================================
// isHalfInteger
// =============================================================================

describe("isHalfInteger", () => {
  test("rat(1/2) → true (canonical half-integer)", () => {
    expect(isHalfInteger(rat(1n, 2n))).toBe(true);
  });

  test("rat(-1/2) → true (negative half-integer)", () => {
    expect(isHalfInteger(rat(-1n, 2n))).toBe(true);
  });

  test("rat(3/2) → true", () => {
    expect(isHalfInteger(rat(3n, 2n))).toBe(true);
  });

  test("rat(7/2) → true", () => {
    expect(isHalfInteger(rat(7n, 2n))).toBe(true);
  });

  test("rat(-7/2) → true", () => {
    expect(isHalfInteger(rat(-7n, 2n))).toBe(true);
  });

  test("rat(101/2) → true (large odd numerator)", () => {
    expect(isHalfInteger(rat(101n, 2n))).toBe(true);
  });

  test("rat(huge-odd/2) → true (BigInt path)", () => {
    // 2 * 10^40 + 1, an odd BigInt far beyond Number.MAX_SAFE_INTEGER.
    const odd = BigInt("20000000000000000000000000000000000000001");
    expect(isHalfInteger(rat(odd, 2n))).toBe(true);
  });

  // Mutation-prove M2 pinning. The first three pin the den ≠ 2 branch;
  // the next two pin the "integer-reduces-to-integer" branch.
  test("rat(5/3) → false (denominator 3, not 2 — pins M2)", () => {
    expect(isHalfInteger(rat(5n, 3n))).toBe(false);
  });

  test("rat(1/4) → false (denominator 4, not 2)", () => {
    expect(isHalfInteger(rat(1n, 4n))).toBe(false);
  });

  test("rat(2/5) → false (denominator 5)", () => {
    expect(isHalfInteger(rat(2n, 5n))).toBe(false);
  });

  test("rat(4/2) → false (reduces to 2 — an integer, not half-integer)", () => {
    // `rat(4n, 2n)` factory reduces eagerly to `{num:"2", den:"1"}`,
    // but the predicate's contract on RAW non-canonical literals must
    // ALSO classify this as not-half-integer. We cover both shapes.
    expect(isHalfInteger(rat(4n, 2n))).toBe(false);
  });

  test("raw rational 4/2 (non-canonical, reduces to 2) → false", () => {
    const raw: Value = { kind: "rational", num: "4", den: "2" };
    expect(isHalfInteger(raw)).toBe(false);
  });

  test("raw rational 6/4 (non-canonical, reduces to 3/2) → true", () => {
    // The reduction step inside the predicate matters: raw 6/4 IS a
    // half-integer once reduced, so must return `true`. Caught the
    // "skip the reducer" mutation in dry runs.
    const raw: Value = { kind: "rational", num: "6", den: "4" };
    expect(isHalfInteger(raw)).toBe(true);
  });

  test("rat(0/2) → false (reduces to 0 — integer)", () => {
    expect(isHalfInteger(rat(0n, 2n))).toBe(false);
  });

  test("int(3) → false (integer, not half-integer)", () => {
    expect(isHalfInteger(int(3n))).toBe(false);
  });

  test("int(0) → false (integer)", () => {
    expect(isHalfInteger(int(0n))).toBe(false);
  });

  test("int(-3) → false (integer)", () => {
    expect(isHalfInteger(int(-3n))).toBe(false);
  });

  test("raw rational with negative denominator (-1 / -2 = 1/2) → true", () => {
    // Sign normalisation. `(-1) / (-2) = 1/2`, a half-integer.
    const raw: Value = { kind: "rational", num: "-1", den: "-2" };
    expect(isHalfInteger(raw)).toBe(true);
  });

  test("raw rational 1/-2 (positive over negative) → true (= -1/2)", () => {
    const raw: Value = { kind: "rational", num: "1", den: "-2" };
    expect(isHalfInteger(raw)).toBe(true);
  });

  test("degenerate rational with zero denominator → false (not throw)", () => {
    const raw: Value = { kind: "rational", num: "3", den: "0" };
    expect(isHalfInteger(raw)).toBe(false);
  });

  for (const { label, v } of NON_NUMERIC_KINDS) {
    test(`${label} → false (non-numeric kind)`, () => {
      expect(isHalfInteger(v)).toBe(false);
    });
  }
});

// =============================================================================
// Cross-predicate consistency
// =============================================================================
//
// Invariants that must hold across the three predicates simultaneously,
// for every Value in a representative corpus. These are an independent
// witness on top of the per-predicate cases above — a mutation that
// breaks a single predicate often falls out as an invariant violation
// here too.

describe("cross-predicate invariants", () => {
  const CORPUS: ReadonlyArray<Value> = [
    int(0n),
    int(1n),
    int(-1n),
    int(42n),
    int(-42n),
    rat(1n, 2n),
    rat(-1n, 2n),
    rat(7n, 2n),
    rat(0n, 5n),
    rat(6n, 3n),
    rat(3n, 2n),
    rat(5n, 3n),
    sym("x"),
    float64FromNumber(0.5),
    expr("f", [int(1n)]),
  ];

  test("isPositiveInteger ⟹ isNonNegativeInteger (every positive is non-negative)", () => {
    for (const v of CORPUS) {
      if (isPositiveInteger(v)) {
        expect(isNonNegativeInteger(v)).toBe(true);
      }
    }
  });

  test("isPositiveInteger ⟹ ¬isHalfInteger (positives are integers, not half)", () => {
    for (const v of CORPUS) {
      if (isPositiveInteger(v)) {
        expect(isHalfInteger(v)).toBe(false);
      }
    }
  });

  test("isNonNegativeInteger ⟹ ¬isHalfInteger (integers are not half-integers)", () => {
    for (const v of CORPUS) {
      if (isNonNegativeInteger(v)) {
        expect(isHalfInteger(v)).toBe(false);
      }
    }
  });

  test("isHalfInteger ⟹ ¬isPositiveInteger ∧ ¬isNonNegativeInteger", () => {
    for (const v of CORPUS) {
      if (isHalfInteger(v)) {
        expect(isPositiveInteger(v)).toBe(false);
        expect(isNonNegativeInteger(v)).toBe(false);
      }
    }
  });

  test("every predicate returns a strict boolean (no undefined / null leakage)", () => {
    for (const v of CORPUS) {
      expect(typeof isPositiveInteger(v)).toBe("boolean");
      expect(typeof isNonNegativeInteger(v)).toBe("boolean");
      expect(typeof isHalfInteger(v)).toBe("boolean");
    }
  });
});
