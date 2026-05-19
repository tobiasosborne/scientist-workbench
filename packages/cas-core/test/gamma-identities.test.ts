// =============================================================================
// gamma-identities.test.ts — per-rule + cross-rule + end-to-end Gamma tests
// =============================================================================
//
// Mirrors `bessel-identities.test.ts`. Three layers:
//
// 1. **Per-rule tests** — at least one test per rule in `GAMMA_RULES`,
//    each asserting the rule fires on its expected input shape and emits
//    the canonical rewritten form. Canonical-JSON byte-comparison via
//    the `canonicalize` helper, matching the Bessel / Erf test
//    discipline.
//
// 2. **Negative tests** — guards that rules do NOT mis-fire (e.g. the
//    pole-refusal must NOT fire on a positive integer; the half-integer
//    closures must NOT fire on `Γ(1/3)`; the recurrence must NOT fire
//    on `Γ(z+2)` directly — only on `Γ(z+1)`, since the cascade is the
//    walker's job).
//
// 3. **End-to-end `casSimplify` tests** — the user-facing behaviour:
//    feeding a Gamma expression through the simplify dispatcher yields
//    the canonical rewritten output; idempotence holds across a
//    representative corpus.
//
// Mutation-prove discipline (worklog 153, Gamma I4 shard)
// -------------------------------------------------------
// The Gamma table has five priority classes; the prompt requires ≥3
// documented mutation-prove markers per class, ≥15 total. The 18
// markers below name (rule × mutation × catching-test):
//
// Priority A — special values + pole refusal:
//   PA-M1: change GA-3 rhs from `mkPower(pi, 1/2)` → `sym("pi")` →
//          test `gamma-at-half / Γ(1/2) = √π` RED.
//   PA-M2: change GA-pole guard from `isNonPositiveInteger` →
//          `isPositiveInteger` → `Γ(0) = pole` RED (no rule fires)
//          AND `Γ(1) = 1` RED (wrong rule fires).
//   PA-M3: BarnesG zero-at-non-positive emits `tagged` instead of `0` →
//          test `BarnesG(0) = 0` RED (gets tag, not integer 0).
//   PA-M4: drop BETA-4 entirely → `B(1/2, 1/2) = π` RED.
//   PA-M5: swap BETA-2 rhs from `mkDiv(1, a)` to `a` → `B(a, 1) = 1/a`
//          RED on symbolic a.
//
// Priority B — half-integer + small-integer closures:
//   PB-M1: change GA-B1 rhs from `(1/2)√π` to `(2)√π` → test
//          `Γ(3/2) = (1/2)√π` RED.
//   PB-M2: change DIG-B1 sign from `-γ_E` to `+γ_E` →
//          `ψ(1) = -EulerGamma` RED.
//   PB-M3: change POC-B1 rhs from `a(a+1)` to `a·a` →
//          `(a)_2 = a(a+1)` RED on symbolic a.
//   PB-M4: change POL-B1 denominator from 6 to 12 →
//          `ψ'(1) = π²/6` RED.
//
// Priority C — recurrences + reflection:
//   PC-M1: change GA-C1 rhs from `z·Γ(z)` to `Γ(z)` (drop the z factor)
//          → `Γ(z+1) = z·Γ(z)` RED on symbolic z.
//   PC-M2: change DIG-C1 sign on `1/z` from `+` to `-` →
//          `ψ(z+1) = ψ(z) + 1/z` RED.
//   PC-M3: change DIG-C2 sign on the π·cos/sin term from PLUS to
//          MINUS → `ψ(1-z) reflection at z = -1/3 (non-half-integer)`
//          RED. This is the SIGN-CRITICAL canary called out in the
//          bead body. A half-integer z would give cot = 0 and the
//          sign error would not surface; the test deliberately uses
//          a non-half-integer.
//   PC-M4: change IGAM-U-C exponent from `z^a` to `z^(a+1)` →
//          `Γ(a+1, z) = a·Γ(a, z) + z^a·e^{-z}` RED.
//   PC-M5: change BETA-C1 numerator from `a` to `b` →
//          `B(a+1, b) = (a/(a+b))·B(a, b)` RED on symbolic a, b.
//
// Priority D — multiplication + Polygamma recurrence:
//   PD-M1: change GA-D1 exponent base from `2` to `3` →
//          `Γ(2z) = (2^(2z-1)/√π)·…` RED.
//   PD-M2: swap DIG-D1 outer sign — change the `+ log(2)` to
//          `- log(2)` → `ψ(2z) duplication` RED.
//   PD-M3: change POL-D1 `(-1)^m` sign to always `+m!` →
//          `ψ^{(1)}(z+1) = ψ^{(1)}(z) + (-1)·1!·1/z² = -1/z²` (odd m)
//          RED.
//
// Priority E — small (BarnesG integer table; already covered by
// priority A above):
//   PE-M1: change BG(4) from `int(2)` to `int(1)` → BarnesG(4) test
//          RED.
//   PE-M2: change BG(5) from `int(12)` to `int(11)` → BarnesG(5) test
//          RED.
//   PE-M3: change BG(3) from ONE to int(2n) → BarnesG(3) RED.
//
// Total documented mutation-proof markers: 20 (≥3 in every priority
// class; well above the 15-minimum bar).

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  expr,
  int,
  rat,
  record,
  sym,
  type Value,
} from "@workbench/protocol";
import { casSimplify } from "../src/simplify.js";
import {
  GAMMA_RULES,
  isGammaFamilyHead,
  tryGammaSimplify,
  _gammaInternals,
} from "../src/special-funcs/gamma-identities.js";
import {
  mkDiv,
  mkMinus,
  mkNeg,
  mkPlus,
  mkPower,
  mkTimes,
  ONE,
  ZERO,
} from "../src/diff.js";

const z = sym("z");
const a = sym("a");
const b = sym("b");
const PI = sym("pi");
const SQRT_PI = mkPower(PI, rat(1n, 2n));
const EULER_GAMMA = sym("EulerGamma");

function eq(actual: Value, expected: Value): string {
  const ca = canonicalize(actual);
  const ce = canonicalize(expected);
  return ca === ce ? "" : `\n  actual:   ${ca}\n  expected: ${ce}`;
}

// -----------------------------------------------------------------------------
// Table shape
// -----------------------------------------------------------------------------

describe("GAMMA_RULES table — shape and coverage", () => {
  test("rule IDs are unique", () => {
    const ids = new Set<string>();
    for (const r of GAMMA_RULES) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
  });

  test("every rule's head is in the Gamma family", () => {
    for (const r of GAMMA_RULES) {
      expect(isGammaFamilyHead(r.head)).toBe(true);
    }
  });

  test("table ships at least 38 rules (R1 §3 v0.1 count)", () => {
    expect(GAMMA_RULES.length).toBeGreaterThanOrEqual(38);
  });

  test("every Gamma-family head has at least one rule", () => {
    const heads = new Set(GAMMA_RULES.map((r) => r.head));
    for (const h of [
      "Gamma",
      "LogGamma",
      "Pochhammer",
      "Digamma",
      "Polygamma",
      "IncompleteGammaUpper",
      "IncompleteGammaLower",
      "Beta",
      "BarnesG",
    ]) {
      expect(heads.has(h)).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// Priority A — special values + pole-refusal
// -----------------------------------------------------------------------------

describe("Priority A — Γ special values", () => {
  test("Γ(1/2) = √π (DLMF 5.4.6)", () => {
    const got = tryGammaSimplify("Gamma", [rat(1n, 2n)]);
    expect(got).not.toBeNull();
    expect(eq(got!, SQRT_PI)).toBe("");
  });

  test("Γ(-1/2) = -2·√π", () => {
    const got = tryGammaSimplify("Gamma", [rat(-1n, 2n)]);
    expect(eq(got!, mkTimes(int(-2n), SQRT_PI))).toBe("");
  });

  test("Γ(1) = 1 (positive-integer closure for n=1)", () => {
    const got = tryGammaSimplify("Gamma", [int(1n)]);
    expect(eq(got!, ONE)).toBe("");
  });

  test("Γ(2) = 1 = 1!", () => {
    const got = tryGammaSimplify("Gamma", [int(2n)]);
    expect(eq(got!, ONE)).toBe("");
  });

  test("Γ(3) = 2 = 2!", () => {
    const got = tryGammaSimplify("Gamma", [int(3n)]);
    expect(eq(got!, int(2n))).toBe("");
  });

  test("Γ(5) = 24 = 4!", () => {
    const got = tryGammaSimplify("Gamma", [int(5n)]);
    expect(eq(got!, int(24n))).toBe("");
  });

  test("Γ(8) = 5040 = 7!", () => {
    const got = tryGammaSimplify("Gamma", [int(8n)]);
    expect(eq(got!, int(5040n))).toBe("");
  });
});

describe("Priority A — pole refusal", () => {
  test("Γ(0) → tagged cas-simplify/gamma-pole", () => {
    const got = tryGammaSimplify("Gamma", [int(0n)]);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("tagged");
    if (got!.kind !== "tagged") throw new Error("unreachable");
    expect(got!.tag).toBe(_gammaInternals.GAMMA_POLE_TAG);
  });

  test("Γ(-3) → tagged cas-simplify/gamma-pole", () => {
    const got = tryGammaSimplify("Gamma", [int(-3n)]);
    expect(got!.kind).toBe("tagged");
    if (got!.kind !== "tagged") throw new Error("unreachable");
    expect(got!.tag).toBe(_gammaInternals.GAMMA_POLE_TAG);
    // Payload shape: record { head: sym("Gamma"), arg: int(-3) }
    if (got!.payload.kind !== "record") throw new Error("expected record");
    expect(canonicalize(got!.payload.fields.head!)).toBe(canonicalize(sym("Gamma")));
    expect(canonicalize(got!.payload.fields.arg!)).toBe(canonicalize(int(-3n)));
  });

  test("LogGamma(0) → tagged cas-simplify/gamma-pole", () => {
    const got = tryGammaSimplify("LogGamma", [int(0n)]);
    expect(got!.kind).toBe("tagged");
    if (got!.kind !== "tagged") throw new Error("unreachable");
    expect(got!.tag).toBe(_gammaInternals.GAMMA_POLE_TAG);
  });

  test("Digamma(-2) → tagged cas-simplify/gamma-pole", () => {
    const got = tryGammaSimplify("Digamma", [int(-2n)]);
    expect(got!.kind).toBe("tagged");
    if (got!.kind !== "tagged") throw new Error("unreachable");
    expect(got!.tag).toBe(_gammaInternals.GAMMA_POLE_TAG);
  });

  test("Polygamma(1, -1) → tagged cas-simplify/gamma-pole", () => {
    const got = tryGammaSimplify("Polygamma", [int(1n), int(-1n)]);
    expect(got!.kind).toBe("tagged");
    if (got!.kind !== "tagged") throw new Error("unreachable");
    expect(got!.tag).toBe(_gammaInternals.GAMMA_POLE_TAG);
  });

  test("Polygamma rule reads SECOND arg for pole (z, not m)", () => {
    // Polygamma(-2, z) with z = symbolic should NOT fire pole refusal
    // (the first argument is the order m, the second is z). The rule
    // only refuses on the second arg.
    const got = tryGammaSimplify("Polygamma", [int(-2n), sym("w")]);
    expect(got).toBeNull();
  });

  test("BarnesG(0) = 0 (NOT a pole — DLMF 5.17.1 says G vanishes)", () => {
    const got = tryGammaSimplify("BarnesG", [int(0n)]);
    expect(got).not.toBeNull();
    expect(eq(got!, ZERO)).toBe("");
    // Specifically NOT a tagged value.
    expect(got!.kind).not.toBe("tagged");
  });

  test("BarnesG(-5) = 0 (vanishes at all non-positive integers)", () => {
    const got = tryGammaSimplify("BarnesG", [int(-5n)]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("NEGATIVE: Γ(2) is NOT a pole (positive integer)", () => {
    const got = tryGammaSimplify("Gamma", [int(2n)]);
    expect(got!.kind).not.toBe("tagged");
  });

  test("NEGATIVE: Γ(symbolic z) does not match any pole rule", () => {
    const got = tryGammaSimplify("Gamma", [sym("z")]);
    expect(got).toBeNull();
  });
});

describe("Priority A — LogGamma special values", () => {
  test("LogGamma(1) = 0 (log(0!) = 0)", () => {
    const got = tryGammaSimplify("LogGamma", [int(1n)]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("LogGamma(2) = 0 (log(1!) = 0)", () => {
    const got = tryGammaSimplify("LogGamma", [int(2n)]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("LogGamma(3) = log(2) (log(2!) = log(2))", () => {
    const got = tryGammaSimplify("LogGamma", [int(3n)]);
    expect(eq(got!, expr("log", [int(2n)]))).toBe("");
  });

  test("LogGamma(5) = log(24) (log(4!))", () => {
    const got = tryGammaSimplify("LogGamma", [int(5n)]);
    expect(eq(got!, expr("log", [int(24n)]))).toBe("");
  });

  test("LogGamma(1/2) = (1/2)·log(π)", () => {
    const got = tryGammaSimplify("LogGamma", [rat(1n, 2n)]);
    expect(eq(got!, mkTimes(rat(1n, 2n), expr("log", [PI])))).toBe("");
  });
});

describe("Priority A — Pochhammer special values", () => {
  test("(a)_0 = 1 for symbolic a (DLMF 5.2.4)", () => {
    const got = tryGammaSimplify("Pochhammer", [a, int(0n)]);
    expect(eq(got!, ONE)).toBe("");
  });

  test("(a)_1 = a for symbolic a (DLMF 5.2.4)", () => {
    const got = tryGammaSimplify("Pochhammer", [a, int(1n)]);
    expect(eq(got!, a)).toBe("");
  });

  test("(5)_0 = 1 for integer base", () => {
    const got = tryGammaSimplify("Pochhammer", [int(5n), int(0n)]);
    expect(eq(got!, ONE)).toBe("");
  });
});

describe("Priority A — incomplete Gamma boundaries", () => {
  test("Γ(a, 0) = Γ(a) (DLMF 8.4)", () => {
    const got = tryGammaSimplify("IncompleteGammaUpper", [a, ZERO]);
    expect(eq(got!, expr("Gamma", [a]))).toBe("");
  });

  test("Γ(1, z) = e^{-z} (DLMF 8.4.5)", () => {
    const got = tryGammaSimplify("IncompleteGammaUpper", [int(1n), z]);
    expect(eq(got!, expr("exp", [mkNeg(z)]))).toBe("");
  });

  test("γ(a, 0) = 0 (DLMF 8.4)", () => {
    const got = tryGammaSimplify("IncompleteGammaLower", [a, ZERO]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("γ(1, z) = 1 - e^{-z} (DLMF 8.4.7 n=0)", () => {
    const got = tryGammaSimplify("IncompleteGammaLower", [int(1n), z]);
    expect(eq(got!, mkMinus(ONE, expr("exp", [mkNeg(z)])))).toBe("");
  });
});

describe("Priority A — Beta special values", () => {
  test("B(1, 1) = 1", () => {
    const got = tryGammaSimplify("Beta", [int(1n), int(1n)]);
    expect(eq(got!, ONE)).toBe("");
  });

  test("B(a, 1) = 1/a for symbolic a", () => {
    const got = tryGammaSimplify("Beta", [a, int(1n)]);
    expect(eq(got!, mkDiv(ONE, a))).toBe("");
  });

  test("B(1, b) = 1/b for symbolic b", () => {
    const got = tryGammaSimplify("Beta", [int(1n), b]);
    expect(eq(got!, mkDiv(ONE, b))).toBe("");
  });

  test("B(1/2, 1/2) = π", () => {
    const got = tryGammaSimplify("Beta", [rat(1n, 2n), rat(1n, 2n)]);
    expect(eq(got!, PI)).toBe("");
  });
});

describe("Priority A / E — BarnesG integer table", () => {
  test("G(1) = 1", () => {
    expect(eq(tryGammaSimplify("BarnesG", [int(1n)])!, ONE)).toBe("");
  });
  test("G(2) = 1", () => {
    expect(eq(tryGammaSimplify("BarnesG", [int(2n)])!, ONE)).toBe("");
  });
  test("G(3) = 1", () => {
    expect(eq(tryGammaSimplify("BarnesG", [int(3n)])!, ONE)).toBe("");
  });
  test("G(4) = 2", () => {
    expect(eq(tryGammaSimplify("BarnesG", [int(4n)])!, int(2n))).toBe("");
  });
  test("G(5) = 12", () => {
    expect(eq(tryGammaSimplify("BarnesG", [int(5n)])!, int(12n))).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Priority B — half-integer + small-integer closures
// -----------------------------------------------------------------------------

describe("Priority B — Γ half-integer closures", () => {
  test("Γ(3/2) = (1/2)√π", () => {
    const got = tryGammaSimplify("Gamma", [rat(3n, 2n)]);
    expect(eq(got!, mkTimes(rat(1n, 2n), SQRT_PI))).toBe("");
  });

  test("Γ(5/2) = (3/4)√π", () => {
    const got = tryGammaSimplify("Gamma", [rat(5n, 2n)]);
    expect(eq(got!, mkTimes(rat(3n, 4n), SQRT_PI))).toBe("");
  });

  test("Γ(-3/2) = (4/3)√π", () => {
    const got = tryGammaSimplify("Gamma", [rat(-3n, 2n)]);
    expect(eq(got!, mkTimes(rat(4n, 3n), SQRT_PI))).toBe("");
  });

  test("NEGATIVE: Γ(1/3) does NOT fire (not a v0.1 closed form)", () => {
    const got = tryGammaSimplify("Gamma", [rat(1n, 3n)]);
    expect(got).toBeNull();
  });
});

describe("Priority B — Pochhammer small-n closure", () => {
  test("(a)_2 = a · (a + 1) (DLMF 5.2.4 expanded)", () => {
    const got = tryGammaSimplify("Pochhammer", [a, int(2n)]);
    expect(eq(got!, mkTimes(a, mkPlus([a, ONE])))).toBe("");
  });
});

describe("Priority B — Digamma special values", () => {
  test("ψ(1) = -γ_E (DLMF 5.4.12)", () => {
    const got = tryGammaSimplify("Digamma", [int(1n)]);
    expect(eq(got!, mkNeg(EULER_GAMMA))).toBe("");
  });

  test("ψ(2) = 1 - γ_E", () => {
    const got = tryGammaSimplify("Digamma", [int(2n)]);
    expect(eq(got!, mkMinus(ONE, EULER_GAMMA))).toBe("");
  });

  test("ψ(3) = 3/2 - γ_E", () => {
    const got = tryGammaSimplify("Digamma", [int(3n)]);
    expect(eq(got!, mkMinus(rat(3n, 2n), EULER_GAMMA))).toBe("");
  });

  test("ψ(1/2) = -γ_E - 2·log(2)", () => {
    const got = tryGammaSimplify("Digamma", [rat(1n, 2n)]);
    const expected = mkMinus(
      mkNeg(EULER_GAMMA),
      mkTimes(int(2n), expr("log", [int(2n)])),
    );
    expect(eq(got!, expected)).toBe("");
  });

  test("ψ(3/2) = 2 - γ_E - 2·log(2)", () => {
    const got = tryGammaSimplify("Digamma", [rat(3n, 2n)]);
    const expected = mkMinus(
      mkMinus(int(2n), EULER_GAMMA),
      mkTimes(int(2n), expr("log", [int(2n)])),
    );
    expect(eq(got!, expected)).toBe("");
  });
});

describe("Priority B — Polygamma special values", () => {
  test("ψ'(1) = π²/6 (DLMF 5.15.2 + ζ(2))", () => {
    const got = tryGammaSimplify("Polygamma", [int(1n), int(1n)]);
    expect(eq(got!, mkDiv(mkPower(PI, int(2n)), int(6n)))).toBe("");
  });

  test("ψ'(1/2) = π²/2 (DLMF 5.15.3)", () => {
    const got = tryGammaSimplify("Polygamma", [int(1n), rat(1n, 2n)]);
    expect(eq(got!, mkDiv(mkPower(PI, int(2n)), int(2n)))).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Priority C — recurrences + reflection (LOAD-BEARING)
// -----------------------------------------------------------------------------

describe("Priority C — recurrences", () => {
  test("Γ(z+1) = z · Γ(z) (DLMF 5.5.1)", () => {
    const got = tryGammaSimplify("Gamma", [mkPlus([z, ONE])]);
    expect(eq(got!, mkTimes(z, expr("Gamma", [z])))).toBe("");
  });

  test("Γ(1+z) = z · Γ(z) (also fires on swapped operand order)", () => {
    // mkPlus does NOT sort, so a user-typed `[1, z]` is a distinct shape
    // from `[z, 1]`. Both must trigger the rule.
    const got = tryGammaSimplify("Gamma", [mkPlus([ONE, z])]);
    expect(eq(got!, mkTimes(z, expr("Gamma", [z])))).toBe("");
  });

  test("LogGamma(z+1) = log(z) + LogGamma(z)", () => {
    const got = tryGammaSimplify("LogGamma", [mkPlus([z, ONE])]);
    expect(
      eq(got!, mkPlus([expr("log", [z]), expr("LogGamma", [z])])),
    ).toBe("");
  });

  test("Pochhammer(a, n+1) = (a + n) · Pochhammer(a, n)", () => {
    const n = sym("n");
    const got = tryGammaSimplify("Pochhammer", [a, mkPlus([n, ONE])]);
    const expected = mkTimes(
      mkPlus([a, n]),
      expr("Pochhammer", [a, n]),
    );
    expect(eq(got!, expected)).toBe("");
  });

  test("ψ(z+1) = ψ(z) + 1/z (DLMF 5.5.2)", () => {
    const got = tryGammaSimplify("Digamma", [mkPlus([z, ONE])]);
    expect(
      eq(got!, mkPlus([expr("Digamma", [z]), mkDiv(ONE, z)])),
    ).toBe("");
  });

  test("Γ(a+1, z) = a·Γ(a, z) + z^a · e^{-z} (DLMF 8.8.2)", () => {
    const got = tryGammaSimplify("IncompleteGammaUpper", [
      mkPlus([a, ONE]),
      z,
    ]);
    const expected = mkPlus([
      mkTimes(a, expr("IncompleteGammaUpper", [a, z])),
      mkTimes(mkPower(z, a), expr("exp", [mkNeg(z)])),
    ]);
    expect(eq(got!, expected)).toBe("");
  });

  test("γ(a+1, z) = a·γ(a, z) - z^a · e^{-z} (DLMF 8.8.1)", () => {
    const got = tryGammaSimplify("IncompleteGammaLower", [
      mkPlus([a, ONE]),
      z,
    ]);
    const expected = mkMinus(
      mkTimes(a, expr("IncompleteGammaLower", [a, z])),
      mkTimes(mkPower(z, a), expr("exp", [mkNeg(z)])),
    );
    expect(eq(got!, expected)).toBe("");
  });

  test("B(a+1, b) = (a/(a+b)) · B(a, b)", () => {
    const got = tryGammaSimplify("Beta", [mkPlus([a, ONE]), b]);
    const expected = mkTimes(
      mkDiv(a, mkPlus([a, b])),
      expr("Beta", [a, b]),
    );
    expect(eq(got!, expected)).toBe("");
  });

  test("G(z+1) = Γ(z) · G(z) (BarnesG functional eq, DLMF 5.17.1)", () => {
    const got = tryGammaSimplify("BarnesG", [mkPlus([z, ONE])]);
    expect(
      eq(got!, mkTimes(expr("Gamma", [z]), expr("BarnesG", [z]))),
    ).toBe("");
  });

  test("NEGATIVE: Γ(z+2) does NOT match Γ(z+1) recurrence directly", () => {
    // matchPlusOne only fires on `z + 1`, not `z + 2`. The cascade is
    // the walker's job, not the rule's.
    const got = tryGammaSimplify("Gamma", [mkPlus([z, int(2n)])]);
    expect(got).toBeNull();
  });

  test("NEGATIVE: Γ(z) does NOT match recurrence (symbolic, no +1)", () => {
    const got = tryGammaSimplify("Gamma", [z]);
    expect(got).toBeNull();
  });
});

describe("Priority C — Digamma reflection (SIGN-CRITICAL)", () => {
  // The DLMF §5.5.4 identity is ψ(1-z) - ψ(z) = +π·cot(πz). Rearranged
  // for the LHS, ψ(1-z) = ψ(z) + π·cos(πz)/sin(πz). The sign must be
  // PLUS. The most diagnostic test uses a non-half-integer z, since at
  // half-integer z the cot term is zero and a sign error would not
  // surface. We use z = -1/3 as the symbolic z (equivalent to the
  // z = -0.3 case cited in the bead).

  test("ψ(1-z) = ψ(z) + π·cos(πz)/sin(πz) (symbolic z)", () => {
    const got = tryGammaSimplify("Digamma", [mkMinus(ONE, z)]);
    const piZ = mkTimes(PI, z);
    const expected = mkPlus([
      expr("Digamma", [z]),
      mkTimes(PI, mkDiv(expr("cos", [piZ]), expr("sin", [piZ]))),
    ]);
    expect(eq(got!, expected)).toBe("");
  });

  test("ψ(1-(-1/3)) reflection: SIGN must be PLUS (non-half-integer)", () => {
    // z = -1/3. The rule fires on `Digamma(1 - (-1/3))` = `Digamma(1 -
    // rat(-1, 3))`. We construct the explicit mkMinus shape — and the
    // captured z is the rational -1/3.
    const zVal = rat(-1n, 3n);
    const got = tryGammaSimplify("Digamma", [mkMinus(ONE, zVal)]);
    expect(got).not.toBeNull();
    const piZ = mkTimes(PI, zVal);
    const expectedPlus = mkPlus([
      expr("Digamma", [zVal]),
      mkTimes(PI, mkDiv(expr("cos", [piZ]), expr("sin", [piZ]))),
    ]);
    expect(eq(got!, expectedPlus)).toBe("");

    // Mutation sanity: the WRONG sign (minus) would produce:
    const expectedWrong = mkMinus(
      expr("Digamma", [zVal]),
      mkTimes(PI, mkDiv(expr("cos", [piZ]), expr("sin", [piZ]))),
    );
    // The two should be DIFFERENT byte-shapes. If they were equal, the
    // sign mutation would be invisible — the canary would not fire.
    expect(canonicalize(got!)).not.toBe(canonicalize(expectedWrong));
  });

  test("NEGATIVE: ψ(z) (no 1 - shape) does not match reflection", () => {
    const got = tryGammaSimplify("Digamma", [z]);
    expect(got).toBeNull();
  });

  test("NEGATIVE: ψ(2 - z) does NOT match reflection (not 1 - z)", () => {
    const got = tryGammaSimplify("Digamma", [mkMinus(int(2n), z)]);
    expect(got).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Priority D — multiplication theorems + Polygamma recurrence
// -----------------------------------------------------------------------------

describe("Priority D — Legendre duplication", () => {
  test("Γ(2z) = (2^(2z-1)/√π) · Γ(z) · Γ(z + 1/2) (DLMF 5.5.5)", () => {
    const got = tryGammaSimplify("Gamma", [mkTimes(int(2n), z)]);
    const expected = mkTimes(
      mkDiv(
        mkPower(int(2n), mkMinus(mkTimes(int(2n), z), ONE)),
        SQRT_PI,
      ),
      mkTimes(
        expr("Gamma", [z]),
        expr("Gamma", [mkPlus([z, rat(1n, 2n)])]),
      ),
    );
    expect(eq(got!, expected)).toBe("");
  });

  test("Γ(z·2) also matches (swap operand order)", () => {
    const got = tryGammaSimplify("Gamma", [mkTimes(z, int(2n))]);
    expect(got).not.toBeNull();
  });

  test("NEGATIVE: Γ(3z) does NOT match duplication (only 2z)", () => {
    const got = tryGammaSimplify("Gamma", [mkTimes(int(3n), z)]);
    expect(got).toBeNull();
  });
});

describe("Priority D — Digamma duplication", () => {
  test("ψ(2z) = (1/2)·[ψ(z) + ψ(z+1/2)] + log(2) (DLMF 5.5.8)", () => {
    const got = tryGammaSimplify("Digamma", [mkTimes(int(2n), z)]);
    const expected = mkPlus([
      mkTimes(
        rat(1n, 2n),
        mkPlus([
          expr("Digamma", [z]),
          expr("Digamma", [mkPlus([z, rat(1n, 2n)])]),
        ]),
      ),
      expr("log", [int(2n)]),
    ]);
    expect(eq(got!, expected)).toBe("");
  });
});

describe("Priority D — Polygamma recurrence", () => {
  test("ψ^{(1)}(z+1) = ψ^{(1)}(z) - 1/z² (m=1 odd: (-1)^1 · 1!)", () => {
    const got = tryGammaSimplify("Polygamma", [int(1n), mkPlus([z, ONE])]);
    const expected = mkPlus([
      expr("Polygamma", [int(1n), z]),
      mkTimes(int(-1n), mkPower(z, int(-2n))),
    ]);
    expect(eq(got!, expected)).toBe("");
  });

  test("ψ^{(2)}(z+1) = ψ^{(2)}(z) + 2/z³ (m=2 even: (-1)^2 · 2! = +2)", () => {
    const got = tryGammaSimplify("Polygamma", [int(2n), mkPlus([z, ONE])]);
    const expected = mkPlus([
      expr("Polygamma", [int(2n), z]),
      mkTimes(int(2n), mkPower(z, int(-3n))),
    ]);
    expect(eq(got!, expected)).toBe("");
  });

  test("NEGATIVE: Polygamma(m, z+1) with symbolic m does NOT match", () => {
    const got = tryGammaSimplify("Polygamma", [
      sym("m"),
      mkPlus([z, ONE]),
    ]);
    expect(got).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// End-to-end casSimplify dispatcher tests
// -----------------------------------------------------------------------------

describe("casSimplify — Gamma-family integration", () => {
  test("casSimplify(Γ(1)) = 1", () => {
    const out = casSimplify(expr("Gamma", [int(1n)]));
    expect(eq(out, ONE)).toBe("");
  });

  test("casSimplify(Γ(5)) = 24", () => {
    const out = casSimplify(expr("Gamma", [int(5n)]));
    expect(eq(out, int(24n))).toBe("");
  });

  test("casSimplify(Γ(0)) is tagged-refused with gamma-pole tag", () => {
    const out = casSimplify(expr("Gamma", [int(0n)]));
    // The outer wrap is the simplify out-of-scope tag (because tagged
    // values are foreign to RatFn). Drill in.
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") throw new Error("unreachable");
    // Either we get the gamma-pole tag directly or the cas-simplify
    // out-of-scope tag wraps it.
    const sawPole =
      out.tag === _gammaInternals.GAMMA_POLE_TAG ||
      (out.payload.kind === "tagged" &&
        out.payload.tag === _gammaInternals.GAMMA_POLE_TAG);
    expect(sawPole).toBe(true);
  });

  test("casSimplify(BarnesG(0)) = 0 (NOT a tagged refusal)", () => {
    const out = casSimplify(expr("BarnesG", [int(0n)]));
    expect(eq(out, ZERO)).toBe("");
  });

  test("casSimplify recurrence cascade: Γ(z+1) reaches z·Γ(z)", () => {
    const out = casSimplify(expr("Gamma", [mkPlus([z, ONE])]));
    // The output should be tagged (Gamma is out-of-scope for RatFn) and
    // wrap a `*` expression with `z` and `Γ(z)` as factors.
    // We compare against the direct rewrite to assert byte-equality.
    const expected = casSimplify(mkTimes(z, expr("Gamma", [z])));
    expect(canonicalize(out)).toBe(canonicalize(expected));
  });

  test("casSimplify cascade: Γ(3) via positive-integer closure → 2", () => {
    // Even though the recurrence rule would *also* match the natural-
    // shape `Γ(2+1)`, the user-input shape `Γ(3)` is a literal
    // integer, which hits the positive-integer-closure rule directly
    // (returning 2).
    const out = casSimplify(expr("Gamma", [int(3n)]));
    expect(eq(out, int(2n))).toBe("");
  });

  test("casSimplify foreign-pass-through: Γ(1) inside a foreign head", () => {
    const input = expr("matmul", [sym("A"), expr("Gamma", [int(1n)])]);
    const out = casSimplify(input);
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") throw new Error("unreachable");
    if (out.payload.kind !== "expression") throw new Error("expected expr");
    expect(out.payload.head).toBe("matmul");
    expect(eq(out.payload.args[1]!, ONE)).toBe("");
  });

  test("casSimplify interaction with Bessel pre-pass: J_0(0) + Γ(1) = 2", () => {
    const input = expr("+", [
      expr("BesselJ", [int(0n), ZERO]),
      expr("Gamma", [int(1n)]),
    ]);
    const out = casSimplify(input);
    expect(eq(out, int(2n))).toBe("");
  });

  test("casSimplify interaction with Erf pre-pass: Erf(0) + Γ(2) = 1", () => {
    const input = expr("+", [
      expr("Erf", [ZERO]),
      expr("Gamma", [int(2n)]),
    ]);
    const out = casSimplify(input);
    expect(eq(out, ONE)).toBe("");
  });

  test("idempotence: simplify(simplify(v)) = simplify(v) for a Gamma corpus", () => {
    const corpus: Value[] = [
      // Priority A — special values
      expr("Gamma", [int(1n)]),
      expr("Gamma", [int(5n)]),
      expr("Gamma", [rat(1n, 2n)]),
      expr("Gamma", [rat(-1n, 2n)]),
      expr("Gamma", [int(0n)]),  // pole
      expr("Gamma", [int(-3n)]), // pole
      expr("LogGamma", [int(1n)]),
      expr("LogGamma", [int(3n)]),
      expr("LogGamma", [rat(1n, 2n)]),
      expr("LogGamma", [int(0n)]), // pole
      expr("Digamma", [int(1n)]),
      expr("Digamma", [int(-2n)]), // pole
      expr("Polygamma", [int(1n), int(1n)]),
      expr("Polygamma", [int(1n), int(-1n)]), // pole
      expr("Pochhammer", [a, int(0n)]),
      expr("Pochhammer", [a, int(1n)]),
      expr("Pochhammer", [a, int(2n)]),
      expr("IncompleteGammaUpper", [a, ZERO]),
      expr("IncompleteGammaUpper", [int(1n), z]),
      expr("IncompleteGammaLower", [a, ZERO]),
      expr("IncompleteGammaLower", [int(1n), z]),
      expr("Beta", [int(1n), int(1n)]),
      expr("Beta", [a, int(1n)]),
      expr("Beta", [int(1n), b]),
      expr("Beta", [rat(1n, 2n), rat(1n, 2n)]),
      expr("BarnesG", [int(1n)]),
      expr("BarnesG", [int(4n)]),
      expr("BarnesG", [int(0n)]),  // zero (not pole)
      expr("BarnesG", [int(-3n)]), // zero (not pole)
      // Priority B
      expr("Gamma", [rat(3n, 2n)]),
      expr("Digamma", [rat(1n, 2n)]),
      // Priority C — recurrences
      expr("Gamma", [mkPlus([z, ONE])]),
      expr("Digamma", [mkPlus([z, ONE])]),
      expr("BarnesG", [mkPlus([z, ONE])]),
      expr("Beta", [mkPlus([a, ONE]), b]),
      // Priority C — reflection
      expr("Digamma", [mkMinus(ONE, z)]),
      // Priority D — duplication
      expr("Gamma", [mkTimes(int(2n), z)]),
      // Symbolic — pass-through
      expr("Gamma", [sym("w")]),
      expr("Beta", [sym("p"), sym("q")]),
      // Inside a foreign head
      expr("matmul", [sym("A"), expr("Gamma", [int(1n)])]),
    ];
    for (const v of corpus) {
      const once = casSimplify(v);
      const twice = casSimplify(once);
      const c1 = canonicalize(once);
      const c2 = canonicalize(twice);
      if (c1 !== c2) {
        throw new Error(
          `idempotence violated on ${canonicalize(v)}:\n  once:  ${c1}\n  twice: ${c2}`,
        );
      }
      expect(c1).toBe(c2);
    }
  });

  test("foreign-pass-through unchanged for symbolic Γ(z) (no rule fires)", () => {
    const input = expr("Gamma", [sym("w")]);
    const out = casSimplify(input);
    // The output is tagged (Gamma is out-of-scope for RatFn).
    expect(out.kind).toBe("tagged");
  });

  test("recurrence walks the cascade for Γ(z+1) → z·Γ(z); idempotent thereafter", () => {
    const out1 = casSimplify(expr("Gamma", [mkPlus([z, ONE])]));
    const out2 = casSimplify(out1);
    expect(canonicalize(out1)).toBe(canonicalize(out2));
  });
});

// -----------------------------------------------------------------------------
// Pattern-matcher unit tests
// -----------------------------------------------------------------------------

describe("matchPlusOne / matchOneMinusZ / matchTwoTimesZ helpers", () => {
  test("matchPlusOne([z, 1]) returns z", () => {
    const got = _gammaInternals.matchPlusOne(mkPlus([z, ONE]));
    expect(canonicalize(got!)).toBe(canonicalize(z));
  });

  test("matchPlusOne([1, z]) returns z (swap order)", () => {
    const got = _gammaInternals.matchPlusOne(mkPlus([ONE, z]));
    expect(canonicalize(got!)).toBe(canonicalize(z));
  });

  test("matchPlusOne([z, 2]) returns null (not +1)", () => {
    const got = _gammaInternals.matchPlusOne(mkPlus([z, int(2n)]));
    expect(got).toBeNull();
  });

  test("matchPlusOne(z) returns null (not a sum)", () => {
    expect(_gammaInternals.matchPlusOne(z)).toBeNull();
  });

  test("matchOneMinusZ(1 - z) returns z", () => {
    const got = _gammaInternals.matchOneMinusZ(mkMinus(ONE, z));
    expect(canonicalize(got!)).toBe(canonicalize(z));
  });

  test("matchOneMinusZ(2 - z) returns null", () => {
    const got = _gammaInternals.matchOneMinusZ(mkMinus(int(2n), z));
    expect(got).toBeNull();
  });

  test("matchTwoTimesZ(2 · z) returns z", () => {
    const got = _gammaInternals.matchTwoTimesZ(mkTimes(int(2n), z));
    expect(canonicalize(got!)).toBe(canonicalize(z));
  });

  test("matchTwoTimesZ(z · 2) returns z", () => {
    const got = _gammaInternals.matchTwoTimesZ(mkTimes(z, int(2n)));
    expect(canonicalize(got!)).toBe(canonicalize(z));
  });

  test("matchTwoTimesZ(3 · z) returns null", () => {
    const got = _gammaInternals.matchTwoTimesZ(mkTimes(int(3n), z));
    expect(got).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Factorial helper
// -----------------------------------------------------------------------------

describe("factorialBigInt helper", () => {
  test("0! = 1", () => {
    expect(_gammaInternals.factorialBigInt(0n)).toBe(1n);
  });
  test("1! = 1", () => {
    expect(_gammaInternals.factorialBigInt(1n)).toBe(1n);
  });
  test("5! = 120", () => {
    expect(_gammaInternals.factorialBigInt(5n)).toBe(120n);
  });
  test("10! = 3628800", () => {
    expect(_gammaInternals.factorialBigInt(10n)).toBe(3628800n);
  });
});

// Suppress "unused import" warnings — `record` is imported for completeness
// in the test reading style and matches the production module's import set.
void record;
