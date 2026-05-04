// containsFloat64 — Value-tree predicate; load-bearing for ADR-0015's
// per-execution determinism-tier conditioning.

import { describe, expect, test } from "bun:test";
import {
  bool,
  containsFloat64,
  expr,
  float64FromNumber,
  int,
  list,
  rat,
  record,
  str,
  sym,
  tagged,
} from "../src/index.js";

describe("containsFloat64", () => {
  test("false on every non-float64 leaf kind", () => {
    expect(containsFloat64(int(0n))).toBe(false);
    expect(containsFloat64(int(-7n))).toBe(false);
    expect(containsFloat64(rat(1n, 2n))).toBe(false);
    expect(containsFloat64(str(""))).toBe(false);
    expect(containsFloat64(str("3.14"))).toBe(false);  // a string-valued numeric is not a float64 leaf
    expect(containsFloat64(sym("x"))).toBe(false);
    expect(containsFloat64(bool(true))).toBe(false);
  });

  test("true on a bare float64 leaf", () => {
    expect(containsFloat64(float64FromNumber(0))).toBe(true);
    expect(containsFloat64(float64FromNumber(Math.PI))).toBe(true);
  });

  test("walks lists", () => {
    expect(containsFloat64(list([]))).toBe(false);
    expect(containsFloat64(list([int(1n), int(2n)]))).toBe(false);
    expect(containsFloat64(list([int(1n), float64FromNumber(2.5)]))).toBe(true);
    expect(containsFloat64(list([list([int(1n)]), list([float64FromNumber(2.5)])]))).toBe(true);
  });

  test("walks records", () => {
    expect(containsFloat64(record({}))).toBe(false);
    expect(containsFloat64(record({ a: int(1n), b: int(2n) }))).toBe(false);
    expect(containsFloat64(record({ a: int(1n), b: float64FromNumber(2.5) }))).toBe(true);
    expect(containsFloat64(record({ nested: record({ x: float64FromNumber(0) }) }))).toBe(true);
  });

  test("walks expressions", () => {
    expect(containsFloat64(expr("+", []))).toBe(false);
    expect(containsFloat64(expr("+", [int(1n), int(2n)]))).toBe(false);
    expect(containsFloat64(expr("+", [int(1n), float64FromNumber(2.5)]))).toBe(true);
    expect(containsFloat64(expr("ry", [int(0n), expr("/", [sym("π"), int(2n)]), list([])]))).toBe(false);
  });

  test("walks tagged payloads", () => {
    expect(containsFloat64(tagged("foo", int(1n)))).toBe(false);
    expect(containsFloat64(tagged("foo", float64FromNumber(2.5)))).toBe(true);
    expect(containsFloat64(tagged("foo", record({ x: float64FromNumber(0) })))).toBe(true);
  });

  test("realistic linalg-solve output shape: contains float64", () => {
    // Mirror the encodeSolveResult shape from tools/linalg-solve/tool.ts.
    const v = record({
      x: list([float64FromNumber(1.4), float64FromNumber(1.2)]),
      residual_norm: float64FromNumber(0),
      b_norm: float64FromNumber(6.4),
      condition_estimate: float64FromNumber(7.5),
      growth_factor: float64FromNumber(1),
      method: str("lu-partial-pivot"),
      iterations: int(0n),
      warnings: list([]),
    });
    expect(containsFloat64(v)).toBe(true);
  });

  test("realistic exact-symbolic Sturm distribution shape: no float64", () => {
    // The kind of value sturm-execute *would* produce on a Clifford+T
    // input once the exact-symbolic path lands — pure rational/integer
    // probabilities, no float64 anywhere.
    const v = record({
      precision: str("exact"),
      outcomes: list([
        record({ prob: rat(1n, 2n), classical_resolutions: record({}) }),
        record({ prob: rat(1n, 2n), classical_resolutions: record({}) }),
      ]),
    });
    expect(containsFloat64(v)).toBe(false);
  });

  test("a single buried float64 in an otherwise-exact tree returns true", () => {
    // The point of the predicate: any float64 leaf, anywhere, makes the
    // output platform-conditional in ADR-0015's semantics.
    const v = record({
      precision: str("exact"),
      outcomes: list([
        record({
          prob: rat(1n, 2n),
          // ...someone slipped a float64 in here:
          fallback_prob: float64FromNumber(0.5),
          classical_resolutions: record({}),
        }),
      ]),
    });
    expect(containsFloat64(v)).toBe(true);
  });
});
