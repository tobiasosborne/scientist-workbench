// =============================================================================
// tryTranscendentalInvert — invert-layer pattern matcher tests
// =============================================================================

import { describe, expect, test } from "bun:test";
import { expr, int, sym, type Value, rat as protocolRat } from "@workbench/protocol";
import { tryTranscendentalInvert } from "../src/index.js";

describe("tryTranscendentalInvert — bare head(x) form", () => {
  test("sin(x) ≡ sin(x) = 0 ⟹ two branches with arcsin(0)", () => {
    const eq = expr("sin", [sym("x")]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).not.toBeNull();
    if (!result || result.kind !== "success") return;
    expect(result.completeness).toBe("finite-rep-of-infinite");
    expect(result.solutions.length).toBe(2);
    expect(result.solutions[0]!.branches.length).toBe(1);
    expect(result.solutions[1]!.branches.length).toBe(1);
  });

  test("cos(x) ⟹ two branches with arccos(0)", () => {
    const result = tryTranscendentalInvert(expr("cos", [sym("x")]), "x");
    expect(result).not.toBeNull();
    if (!result || result.kind !== "success") return;
    expect(result.completeness).toBe("finite-rep-of-infinite");
    expect(result.solutions.length).toBe(2);
  });

  test("tan(x) ⟹ one branch (× π)", () => {
    const result = tryTranscendentalInvert(expr("tan", [sym("x")]), "x");
    expect(result).not.toBeNull();
    if (!result || result.kind !== "success") return;
    expect(result.solutions.length).toBe(1);
    expect(result.solutions[0]!.branches.length).toBe(1);
  });
});

describe("tryTranscendentalInvert — head(x) − c pattern", () => {
  test("sin(x) − 1/2 ⟹ two branches with arcsin(1/2)", () => {
    const eq = expr("-", [expr("sin", [sym("x")]), protocolRat(1n, 2n)]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).not.toBeNull();
    if (!result || result.kind !== "success") return;
    expect(result.solutions.length).toBe(2);
    // Verify the constant 1/2 made it into the asin call.
    const firstValue = result.solutions[0]!.bindings[0]!.value;
    if (firstValue.kind === "expression" && firstValue.head === "+") {
      const asinTerm = firstValue.args[0]!;
      if (asinTerm.kind === "expression" && asinTerm.head === "asin") {
        const c = asinTerm.args[0]!;
        expect(c.kind).toBe("rational");
        if (c.kind === "rational") {
          expect(c.num).toBe("1");
          expect(c.den).toBe("2");
        }
      }
    }
  });

  test("exp(x) − 5 ⟹ x = log(5)", () => {
    const eq = expr("-", [expr("exp", [sym("x")]), int(5n)]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).not.toBeNull();
    if (!result || result.kind !== "success") return;
    expect(result.solutions.length).toBe(1);
    expect(result.solutions[0]!.branches.length).toBe(0);
    const v = result.solutions[0]!.bindings[0]!.value;
    expect(v.kind).toBe("expression");
    if (v.kind === "expression") {
      expect(v.head).toBe("log");
    }
  });

  test("log(x) − 2 ⟹ x = exp(2) (single branch)", () => {
    const eq = expr("-", [expr("log", [sym("x")]), int(2n)]);
    const result = tryTranscendentalInvert(eq, "x");
    if (!result || result.kind !== "success") return;
    expect(result.solutions.length).toBe(1);
    const v = result.solutions[0]!.bindings[0]!.value;
    if (v.kind === "expression") expect(v.head).toBe("exp");
  });

  test("abs(x) − 3 ⟹ {3, -3} (two branches, no infinite)", () => {
    const eq = expr("-", [expr("abs", [sym("x")]), int(3n)]);
    const result = tryTranscendentalInvert(eq, "x");
    if (!result || result.kind !== "success") return;
    expect(result.completeness).toBe("complete");
    expect(result.solutions.length).toBe(2);
    const v1 = result.solutions[0]!.bindings[0]!.value;
    const v2 = result.solutions[1]!.bindings[0]!.value;
    if (v1.kind === "integer") expect(v1.value).toBe("3");
    // v2 is 'expr * -1 3' (negation expression).
    expect(v2.kind === "integer" || v2.kind === "expression").toBe(true);
  });

  test("cosh(x) − 5 ⟹ ±arccosh(5)", () => {
    const eq = expr("-", [expr("cosh", [sym("x")]), int(5n)]);
    const result = tryTranscendentalInvert(eq, "x");
    if (!result || result.kind !== "success") return;
    expect(result.completeness).toBe("complete");
    expect(result.solutions.length).toBe(2);
  });
});

describe("tryTranscendentalInvert — c − head(x) pattern", () => {
  test("3 − exp(x) ⟹ exp(x) = 3 ⟹ x = log(3)", () => {
    const eq = expr("-", [int(3n), expr("exp", [sym("x")])]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).not.toBeNull();
    if (!result || result.kind !== "success") return;
    expect(result.solutions.length).toBe(1);
    const v = result.solutions[0]!.bindings[0]!.value;
    if (v.kind === "expression") {
      expect(v.head).toBe("log");
      const arg = v.args[0]!;
      if (arg.kind === "integer") expect(arg.value).toBe("3");
    }
  });
});

describe("tryTranscendentalInvert — head(x) + c pattern", () => {
  test("sin(x) + (-1/2) ⟹ sin(x) = 1/2", () => {
    const eq = expr("+", [
      expr("sin", [sym("x")]),
      protocolRat(-1n, 2n),
    ]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).not.toBeNull();
    if (!result || result.kind !== "success") return;
    expect(result.solutions.length).toBe(2);
    const firstValue = result.solutions[0]!.bindings[0]!.value as Value;
    if (firstValue.kind === "expression" && firstValue.head === "+") {
      const asinTerm = firstValue.args[0]!;
      if (asinTerm.kind === "expression" && asinTerm.head === "asin") {
        const c = asinTerm.args[0]!;
        // After negation: -(-1/2) = 1/2.
        if (c.kind === "rational") {
          expect(c.num).toBe("1");
          expect(c.den).toBe("2");
        }
      }
    }
  });
});

describe("tryTranscendentalInvert — non-matching patterns return null", () => {
  test("polynomial: x^2 - 1 ⟹ null (caller falls through to poly path)", () => {
    const eq = expr("-", [expr("^", [sym("x"), int(2n)]), int(1n)]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).toBeNull();
  });

  test("compound head(g(x)): sin(2x) ⟹ null (37r will handle this)", () => {
    const eq = expr("sin", [expr("*", [int(2n), sym("x")])]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).toBeNull();
  });

  test("two heads: sin(x) + cos(x) ⟹ null", () => {
    const eq = expr("+", [
      expr("sin", [sym("x")]),
      expr("cos", [sym("x")]),
    ]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).toBeNull();
  });

  test("scaled head: 2 · sin(x) ⟹ null (linear-coef on head; 37r territory)", () => {
    const eq = expr("*", [int(2n), expr("sin", [sym("x")])]);
    const result = tryTranscendentalInvert(eq, "x");
    expect(result).toBeNull();
  });
});
