// =============================================================================
// special-functions.test.ts — vocabulary table + diff-rule unit tests
// =============================================================================
//
// Two layers (mirroring diff.test.ts):
//
// 1. Vocabulary-table tests. The closed `SPECIAL_FUNCTION_HEADS` set is
//    the canonical enumeration; `specialFunctionArity` returns an arity
//    contract per head. These tests pin the table's shape so that any
//    future addition (or accidental deletion) surfaces as a deliberate
//    test edit, never as a silent drift.
//
// 2. Diff-rule unit tests. For each head with a closed-form rule shipped
//    in v0.1 (ADR-0023's "differentiable subset"), assert that
//    `differentiate(expr(head, args), z)` returns the expected canonical
//    form. The tests assert structural equality on canonicalised output,
//    so smart-constructor identities (1·x → x, 0+x → x, neg(neg) → x)
//    are baked in.
//
// Mutation-prove: each rule has a small canonical-form witness. A typo
// in the rule (e.g., dropping the chain-rule factor, swapping ν-1 / ν+1
// in the Bessel recurrence, missing the negative sign on Erfc) fails
// one or more cases. There is no FD cross-check here because the rules
// emit special-function heads that the elementary `evalNumericExpr` does
// not admit; structural unit tests against DLMF-cited closed forms are
// the load-bearing oracle.

import { describe, expect, test } from "bun:test";
import { canonicalize, expr, int, list, rat, sym, type Value } from "@workbench/protocol";
import { CasDiffOutOfScopeError, differentiate } from "../src/diff.js";
import {
  SPECIAL_FUNCTION_HEADS,
  SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS,
  specialFunctionArity,
  type SpecialFunctionArity,
} from "../src/special-functions.js";

const z = sym("z");
const w = sym("w");
const n = int(2n);

function eq(a: Value, b: Value): boolean {
  return canonicalize(a) === canonicalize(b);
}

function diff(e: Value, wrt = z): Value {
  return differentiate(e, wrt);
}

// -----------------------------------------------------------------------------
// Vocabulary table — exhaustiveness, no duplicates, sorted shape
// -----------------------------------------------------------------------------

describe("SPECIAL_FUNCTION_HEADS — vocabulary table", () => {
  test("contains exactly the 32 heads ADR-0023 admits (Hankel + spherical Bessel added 2026-05-17 per ADR-0041)", () => {
    const expected = [
      "Gamma", "Digamma", "Polygamma",
      "BesselJ", "BesselY", "BesselI", "BesselK",
      "HankelH1", "HankelH2",
      "SphericalBesselJ", "SphericalBesselY",
      "HypergeometricPFQ",
      "WhittakerM", "WhittakerW",
      "ParabolicCylinderD",
      "Erf", "Erfc", "Erfi",
      "ExpIntegralEi", "ExpIntegralE",
      "FresnelC", "FresnelS",
      "LegendreP", "LegendreQ",
      "LaguerreL", "HermiteH",
      "ChebyshevT", "ChebyshevU",
      "GegenbauerC",
      "Polylog", "LerchPhi",
      "MeijerG",
    ];
    // 32 heads after ADR-0041 §"Decision 6" admitted the four Bessel-
    // family boundary heads (HankelH1, HankelH2, SphericalBesselJ,
    // SphericalBesselY). Re-count to guard against drift on future
    // vocabulary additions:
    expect(expected.length).toBe(32);
    // The set the module exports must match this array exactly.
    expect([...SPECIAL_FUNCTION_HEADS].sort()).toEqual([...expected].sort());
  });

  test("no duplicates", () => {
    const set = new Set(SPECIAL_FUNCTION_HEADS);
    expect(set.size).toBe(SPECIAL_FUNCTION_HEADS.length);
  });

  test("does not overlap with the elementary vocabulary", () => {
    // Special-function heads are PascalCase; elementary heads are
    // lowercase or punctuation. The two sets must be disjoint so that
    // dispatch is unambiguous.
    const elementary = new Set([
      "+", "-", "*", "/", "^", "neg",
      "exp", "sin", "cos", "tan", "log", "sqrt", "abs",
      "asin", "acos", "atan", "sinh", "cosh", "tanh",
      "asinh", "acosh", "atanh", "log2", "log10",
    ]);
    for (const h of SPECIAL_FUNCTION_HEADS) {
      expect(elementary.has(h)).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// Arity contracts
// -----------------------------------------------------------------------------

describe("specialFunctionArity — arity contracts", () => {
  test("unknown head returns null", () => {
    expect(specialFunctionArity("NotAHead")).toBeNull();
    expect(specialFunctionArity("sin")).toBeNull(); // elementary, not special
    expect(specialFunctionArity("")).toBeNull();
  });

  test("single-z heads have arity 1", () => {
    for (const h of ["Gamma", "Digamma", "Erf", "Erfc", "Erfi",
                     "ExpIntegralEi", "FresnelC", "FresnelS"]) {
      const a = specialFunctionArity(h);
      expect(a).not.toBeNull();
      expect(a!.shape).toBe("fixed");
      expect((a as Extract<SpecialFunctionArity, { shape: "fixed" }>).count).toBe(1);
    }
  });

  test("two-arg heads have arity 2", () => {
    for (const h of ["Polygamma", "BesselJ", "BesselY", "BesselI", "BesselK",
                     "HankelH1", "HankelH2",
                     "SphericalBesselJ", "SphericalBesselY",
                     "ExpIntegralE", "LegendreP", "LegendreQ",
                     "LaguerreL", "HermiteH", "ChebyshevT", "ChebyshevU",
                     "Polylog", "ParabolicCylinderD"]) {
      const a = specialFunctionArity(h);
      expect(a).not.toBeNull();
      expect(a!.shape).toBe("fixed");
      expect((a as Extract<SpecialFunctionArity, { shape: "fixed" }>).count).toBe(2);
    }
  });

  test("three-arg heads have arity 3", () => {
    for (const h of ["WhittakerM", "WhittakerW", "GegenbauerC", "LerchPhi"]) {
      const a = specialFunctionArity(h);
      expect(a).not.toBeNull();
      expect(a!.shape).toBe("fixed");
      expect((a as Extract<SpecialFunctionArity, { shape: "fixed" }>).count).toBe(3);
    }
  });

  test("HypergeometricPFQ has list-head arity (list, list, scalar)", () => {
    const a = specialFunctionArity("HypergeometricPFQ");
    expect(a).not.toBeNull();
    expect(a!.shape).toBe("list-head");
    const lh = a as Extract<SpecialFunctionArity, { shape: "list-head" }>;
    expect(lh.argShapes).toEqual(["list", "list", "scalar"]);
  });

  test("MeijerG has list-head arity (list-of-list, list-of-list, scalar)", () => {
    const a = specialFunctionArity("MeijerG");
    expect(a).not.toBeNull();
    expect(a!.shape).toBe("list-head");
    const lh = a as Extract<SpecialFunctionArity, { shape: "list-head" }>;
    expect(lh.argShapes).toEqual(["list-of-list", "list-of-list", "scalar"]);
  });
});

// -----------------------------------------------------------------------------
// Differentiable-subset table
// -----------------------------------------------------------------------------

describe("SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS — v0.1 subset", () => {
  test("matches ADR-0023's shipped subset exactly (incl. Erfi per ADR-0040 + Hankel/spherical Bessel per ADR-0041)", () => {
    const expected = [
      "Gamma", "Digamma", "Polygamma",
      "Erf", "Erfc", "Erfi",
      "ExpIntegralEi", "ExpIntegralE",
      "FresnelC", "FresnelS",
      "BesselJ", "BesselY", "BesselI", "BesselK",
      "HankelH1", "HankelH2",
      "SphericalBesselJ", "SphericalBesselY",
      "HermiteH",
      "Polylog",
    ];
    expect([...SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS].sort()).toEqual(
      [...expected].sort(),
    );
  });

  test("every differentiable head is in the master vocabulary", () => {
    const master = new Set(SPECIAL_FUNCTION_HEADS);
    for (const h of SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS) {
      expect(master.has(h)).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// Per-head diff rules — DLMF-cited closed forms
// -----------------------------------------------------------------------------

describe("differentiate — Gamma family", () => {
  test("d/dz Γ(z) = ψ(z) · Γ(z)  (DLMF §5.4.2)", () => {
    const got = diff(expr("Gamma", [z]));
    const want = expr("*", [
      expr("Digamma", [z]),
      expr("Gamma", [z]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz ψ(z) = ψ⁽¹⁾(z)  (DLMF §5.7.1; rule emits Polygamma(1, z))", () => {
    const got = diff(expr("Digamma", [z]));
    const want = expr("Polygamma", [int(1n), z]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz ψ⁽ⁿ⁾(z) = ψ⁽ⁿ⁺¹⁾(z) when var = z  (DLMF §5.15.3)", () => {
    const got = diff(expr("Polygamma", [n, z]));
    const want = expr("Polygamma", [int(3n), z]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dn ψ⁽ⁿ⁾(z) refuses (n is the discrete order; not differentiable)", () => {
    expect(() => diff(expr("Polygamma", [sym("n"), z]), sym("n"))).toThrow(
      CasDiffOutOfScopeError,
    );
  });

  test("chain rule: d/dz Γ(2z) = 2 · ψ(2z) · Γ(2z)", () => {
    const inner = expr("*", [int(2n), z]);
    const got = diff(expr("Gamma", [inner]));
    // Rule produces ψ(inner) · Γ(inner) · d(inner)/dz = ψ(2z) · Γ(2z) · 2.
    // Smart constructor folds 2 to the front; canonical form is whatever
    // mkTimes(ψ, Γ, 2) emits — assert by hand-constructed mirror.
    const want = expr("*", [
      expr("*", [
        expr("Digamma", [inner]),
        expr("Gamma", [inner]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });
});

describe("differentiate — Erf / Erfc", () => {
  test("d/dz erf(z) = 2/√π · exp(-z²)  (DLMF §7.7.1)", () => {
    const got = diff(expr("Erf", [z]));
    // 2 / sqrt(pi) · exp(-z^2). The rule is structured as
    // (2 / sqrt(pi)) * exp(neg(z^2)); smart constructors produce the
    // canonical chain.
    const want = expr("*", [
      expr("/", [int(2n), expr("sqrt", [sym("pi")])]),
      expr("exp", [expr("neg", [expr("^", [z, int(2n)])])]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz erfc(z) = -2/√π · exp(-z²)", () => {
    const got = diff(expr("Erfc", [z]));
    const want = expr("*", [
      expr("neg", [expr("/", [int(2n), expr("sqrt", [sym("pi")])])]),
      expr("exp", [expr("neg", [expr("^", [z, int(2n)])])]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("chain rule: d/dz erf(2z) = (2/√π · exp(-(2z)²)) · 2", () => {
    const inner = expr("*", [int(2n), z]);
    const got = diff(expr("Erf", [inner]));
    const want = expr("*", [
      expr("*", [
        expr("/", [int(2n), expr("sqrt", [sym("pi")])]),
        expr("exp", [expr("neg", [expr("^", [inner, int(2n)])])]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Erfi — imaginary error function (admitted 2026-05-16 per ADR-0040 §"Decision 6")
// -----------------------------------------------------------------------------
//
// `erfi(z) := -i · erf(i·z)` is the Dawson / Faddeeva sister of `erf`
// on the imaginary axis. The derivative `(2/√π)·exp(z²)` (note the
// `+z²` exponent — `erf`'s is `-z²`) is the single sign-flip that
// makes erfi grow super-exponentially on the real axis. ADR-0040
// §"Decision 6" pinned `mkPower(sym("pi"), rat(1n, 2n))` as the
// canonical √π encoding for the per-head Erf substrate, so the bridge
// to Meijer-G (R4 §1; bead `tc2c`) sees one uniform `z/√π` prefactor
// shape across Erf, Erfc, and Erfi G-forms.

describe("differentiate — Erfi (DLMF §7.10.2)", () => {
  test("specialFunctionArity Erfi → fixed count 1", () => {
    const a = specialFunctionArity("Erfi");
    expect(a).not.toBeNull();
    expect(a!.shape).toBe("fixed");
    expect((a as Extract<SpecialFunctionArity, { shape: "fixed" }>).count).toBe(1);
  });

  test("d/dz erfi(z) = (2/√π) · exp(z²)  (DLMF §7.10.2)", () => {
    const got = diff(expr("Erfi", [z]));
    // The chain-rule factor `dz/dz = 1` is absorbed by `mkTimes`'s
    // smart constructor (1 dropped); the result is the bare prefactor
    // times `exp(z²)` with no extraneous `1`.
    const want = expr("*", [
      expr("/", [int(2n), expr("^", [sym("pi"), rat(1n, 2n)])]),
      expr("exp", [expr("^", [z, int(2n)])]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dy erfi(x) = 0  (free-symbol-independence; x ≠ y)", () => {
    const x = sym("x");
    const y = sym("y");
    const got = diff(expr("Erfi", [x]), y);
    expect(eq(got, int(0n))).toBe(true);
  });

  test("chain rule: d/dz erfi(2z) = ((2/√π) · exp((2z)²)) · 2", () => {
    const inner = expr("*", [int(2n), z]);
    const got = diff(expr("Erfi", [inner]));
    const want = expr("*", [
      expr("*", [
        expr("/", [int(2n), expr("^", [sym("pi"), rat(1n, 2n)])]),
        expr("exp", [expr("^", [inner, int(2n)])]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("foreign pass-through: erfi inside an unknown head refuses cleanly", () => {
    // The ADR-0023 / ADR-0040 honest-scope discipline: heads not in
    // SPECIAL_FUNCTION_HEADS continue to refuse via the existing
    // boundary tag. Adding Erfi must NOT silently admit any other
    // erf-family variant (e.g. InverseErf, which ADR-0040 §"What we
    // will not decide here" explicitly defers).
    expect(() => diff(expr("InverseErf", [z]))).toThrow(CasDiffOutOfScopeError);
  });

  test("determinism: hash-equal across two calls on the Erfi rule", () => {
    const f = expr("Erfi", [z]);
    const a = canonicalize(diff(f));
    const b = canonicalize(diff(f));
    expect(a).toBe(b);
  });
});

describe("differentiate — ExpIntegral", () => {
  test("d/dz Ei(z) = exp(z) / z  (DLMF §6.2.6)", () => {
    const got = diff(expr("ExpIntegralEi", [z]));
    const want = expr("/", [expr("exp", [z]), z]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz E_n(z) = -E_{n-1}(z)  (DLMF §8.19.13; var = z)", () => {
    const got = diff(expr("ExpIntegralE", [n, z]));
    const want = expr("neg", [expr("ExpIntegralE", [int(1n), z])]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dn E_n(z) refuses (n is the discrete order)", () => {
    expect(() => diff(expr("ExpIntegralE", [sym("n"), z]), sym("n"))).toThrow(
      CasDiffOutOfScopeError,
    );
  });
});

describe("differentiate — Fresnel", () => {
  test("d/dz C(z) = cos(π·z²/2)  (DLMF §7.2.7)", () => {
    const got = diff(expr("FresnelC", [z]));
    const want = expr("cos", [
      expr("/", [
        expr("*", [sym("pi"), expr("^", [z, int(2n)])]),
        int(2n),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz S(z) = sin(π·z²/2)", () => {
    const got = diff(expr("FresnelS", [z]));
    const want = expr("sin", [
      expr("/", [
        expr("*", [sym("pi"), expr("^", [z, int(2n)])]),
        int(2n),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });
});

describe("differentiate — Bessel family", () => {
  test("d/dz J_ν(z) = (J_{ν-1}(z) − J_{ν+1}(z)) / 2  (DLMF §10.6.1)", () => {
    const nu = int(3n);
    const got = diff(expr("BesselJ", [nu, z]));
    const want = expr("/", [
      expr("-", [
        expr("BesselJ", [int(2n), z]),
        expr("BesselJ", [int(4n), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz Y_ν(z) — same recurrence shape as J", () => {
    const nu = int(3n);
    const got = diff(expr("BesselY", [nu, z]));
    const want = expr("/", [
      expr("-", [
        expr("BesselY", [int(2n), z]),
        expr("BesselY", [int(4n), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz I_ν(z) = (I_{ν-1}(z) + I_{ν+1}(z)) / 2  (DLMF §10.29.1; modified)", () => {
    const nu = int(3n);
    const got = diff(expr("BesselI", [nu, z]));
    const want = expr("/", [
      expr("+", [
        expr("BesselI", [int(2n), z]),
        expr("BesselI", [int(4n), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz K_ν(z) = -(K_{ν-1}(z) + K_{ν+1}(z)) / 2", () => {
    const nu = int(3n);
    const got = diff(expr("BesselK", [nu, z]));
    const want = expr("neg", [
      expr("/", [
        expr("+", [
          expr("BesselK", [int(2n), z]),
          expr("BesselK", [int(4n), z]),
        ]),
        int(2n),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("rational-order Bessel: d/dz J_{1/2}(z) shifts to ν±1 = -1/2, 3/2", () => {
    // A common physical case (spherical Bessel relation). Verifies the
    // rational-kind branch of the order-shift smart constructor — note
    // that `rat(1n, 2n)` is the canonical *rational* Value, distinct
    // from `expr("/", [int(1n), int(2n)])` which would be an expression
    // with the elementary `/` head and is shifted symbolically rather
    // than reduced to a rational.
    const nu = rat(1n, 2n);
    const got = diff(expr("BesselJ", [nu, z]));
    const numMinus = rat(-1n, 2n);
    const numPlus = rat(3n, 2n);
    const want = expr("/", [
      expr("-", [
        expr("BesselJ", [numMinus, z]),
        expr("BesselJ", [numPlus, z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("symbolic-order Bessel: d/dz J_ν(z) emits J_{ν-1}, J_{ν+1} symbolically", () => {
    const nu = sym("nu");
    const got = diff(expr("BesselJ", [nu, z]));
    const want = expr("/", [
      expr("-", [
        expr("BesselJ", [expr("-", [nu, int(1n)]), z]),
        expr("BesselJ", [expr("+", [nu, int(1n)]), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dν J_ν(z) refuses (order-derivative is not in v0.1)", () => {
    const nu = sym("nu");
    expect(() => diff(expr("BesselJ", [nu, z]), nu)).toThrow(
      CasDiffOutOfScopeError,
    );
  });
});

// -----------------------------------------------------------------------------
// Hankel H1 / H2 — cylinder-Bessel boundary (admitted 2026-05-17 per ADR-0041)
// -----------------------------------------------------------------------------
//
// H¹_ν = J_ν + i·Y_ν and H²_ν = J_ν − i·Y_ν are the complex-valued
// cylinder Bessel functions. The numerical evaluation path uses
// Hankel's expansion (DLMF §10.17.5) *directly* in the upper / lower
// half-plane to avoid catastrophic cancellation between J_ν and i·Y_ν
// at large |z|; the symbolic AST needs them as first-class heads for
// that substrate to dispatch on. Diff rule shape is identical to the
// cylinder-Bessel rule (DLMF §10.6.1's "any cylinder function" framing
// covers `C_ν ∈ {J, Y, H¹, H²}`).

describe("differentiate — Hankel functions (DLMF §10.6.1)", () => {
  test("d/dz H¹_ν(z) = (H¹_{ν-1}(z) − H¹_{ν+1}(z)) / 2  (same shape as J)", () => {
    const nu = int(3n);
    const got = diff(expr("HankelH1", [nu, z]));
    const want = expr("/", [
      expr("-", [
        expr("HankelH1", [int(2n), z]),
        expr("HankelH1", [int(4n), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz H²_ν(z) — same recurrence shape as H¹", () => {
    const nu = int(3n);
    const got = diff(expr("HankelH2", [nu, z]));
    const want = expr("/", [
      expr("-", [
        expr("HankelH2", [int(2n), z]),
        expr("HankelH2", [int(4n), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("rational-order Hankel: d/dz H¹_{1/2}(z) shifts to ν±1 = -1/2, 3/2", () => {
    const nu = rat(1n, 2n);
    const got = diff(expr("HankelH1", [nu, z]));
    const want = expr("/", [
      expr("-", [
        expr("HankelH1", [rat(-1n, 2n), z]),
        expr("HankelH1", [rat(3n, 2n), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("symbolic-order Hankel: d/dz H²_ν(z) emits H²_{ν-1}, H²_{ν+1} symbolically", () => {
    const nu = sym("nu");
    const got = diff(expr("HankelH2", [nu, z]));
    const want = expr("/", [
      expr("-", [
        expr("HankelH2", [expr("-", [nu, int(1n)]), z]),
        expr("HankelH2", [expr("+", [nu, int(1n)]), z]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("chain rule: d/dz H¹_3(2z) = ((H¹_2(2z) − H¹_4(2z)) / 2) · 2", () => {
    const inner = expr("*", [int(2n), z]);
    const got = diff(expr("HankelH1", [int(3n), inner]));
    const want = expr("*", [
      expr("/", [
        expr("-", [
          expr("HankelH1", [int(2n), inner]),
          expr("HankelH1", [int(4n), inner]),
        ]),
        int(2n),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dν H¹_ν(z) refuses (order-derivative is not in v0.1)", () => {
    const nu = sym("nu");
    expect(() => diff(expr("HankelH1", [nu, z]), nu)).toThrow(
      CasDiffOutOfScopeError,
    );
  });

  test("d/dw H²_3(z) = 0  (free-symbol-independence; w ≠ z)", () => {
    const got = diff(expr("HankelH2", [int(3n), z]), w);
    expect(eq(got, int(0n))).toBe(true);
  });

  test("determinism: H¹_3(z) diff hash-equal across two calls", () => {
    const f = expr("HankelH1", [int(3n), z]);
    const a = canonicalize(diff(f));
    const b = canonicalize(diff(f));
    expect(a).toBe(b);
  });
});

// -----------------------------------------------------------------------------
// SphericalBesselJ / Y — load-bearing physics encoding (ADR-0041 §"Decision 6")
// -----------------------------------------------------------------------------
//
// `j_n(z) = √(π/(2z))·J_{n+1/2}(z)` and the corresponding `y_n` are
// admitted because consumers (Mie scattering, quantum partial-wave
// decomposition, gravitational-wave spherical-harmonic expansions)
// express results as `j_n(kr)` directly, never as the half-integer
// Bessel composition. Diff rule uses the *asymmetric* DLMF §10.51.2
// ascent form: `d/dz j_n(z) = j_{n-1}(z) − ((n+1)/z) · j_n(z)`.
// The `1/z` factor is honest (consumers `integrate-1d` and
// `eval-numeric-expr` handle it exactly the way they handle the
// matching `1/z` in `d/dz Li_s(z) = Li_{s-1}(z)/z` per `rulePolylog`).

describe("differentiate — spherical Bessel functions (DLMF §10.51.2)", () => {
  test("d/dz j_n(z) = j_{n-1}(z) − ((n+1)/z) · j_n(z)  (DLMF §10.51.2)", () => {
    const nn = int(3n);
    const got = diff(expr("SphericalBesselJ", [nn, z]));
    const want = expr("-", [
      expr("SphericalBesselJ", [int(2n), z]),
      expr("*", [
        expr("/", [int(4n), z]),
        expr("SphericalBesselJ", [int(3n), z]),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz y_n(z) — same recurrence shape as j_n", () => {
    const nn = int(3n);
    const got = diff(expr("SphericalBesselY", [nn, z]));
    const want = expr("-", [
      expr("SphericalBesselY", [int(2n), z]),
      expr("*", [
        expr("/", [int(4n), z]),
        expr("SphericalBesselY", [int(3n), z]),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("symbolic-order spherical Bessel: d/dz j_n(z) emits j_{n-1}, ((n+1)/z)·j_n symbolically", () => {
    const nn = sym("n");
    const got = diff(expr("SphericalBesselJ", [nn, z]));
    const want = expr("-", [
      expr("SphericalBesselJ", [expr("-", [nn, int(1n)]), z]),
      expr("*", [
        expr("/", [expr("+", [nn, int(1n)]), z]),
        expr("SphericalBesselJ", [nn, z]),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("n = 0 case: d/dz j_0(z) = j_{-1}(z) − (1/z) · j_0(z)", () => {
    // The asymmetric ascent rule fires uniformly for all n; n=0 produces
    // j_{-1} (which is itself a valid spherical Bessel value via the
    // half-integer Bessel relation j_{-1}(z) = cos(z)/z; cas-simplify
    // can rewrite later) and (1/z)·j_0. No special-case branch.
    const got = diff(expr("SphericalBesselJ", [int(0n), z]));
    const want = expr("-", [
      expr("SphericalBesselJ", [int(-1n), z]),
      expr("*", [
        expr("/", [int(1n), z]),
        expr("SphericalBesselJ", [int(0n), z]),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("chain rule: d/dz j_3(2z) = (j_2(2z) − (4/(2z))·j_3(2z)) · 2", () => {
    const inner = expr("*", [int(2n), z]);
    const got = diff(expr("SphericalBesselJ", [int(3n), inner]));
    const want = expr("*", [
      expr("-", [
        expr("SphericalBesselJ", [int(2n), inner]),
        expr("*", [
          expr("/", [int(4n), inner]),
          expr("SphericalBesselJ", [int(3n), inner]),
        ]),
      ]),
      int(2n),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dn j_n(z) refuses (order-derivative is not in v0.1)", () => {
    const nn = sym("n");
    expect(() => diff(expr("SphericalBesselJ", [nn, z]), nn)).toThrow(
      CasDiffOutOfScopeError,
    );
  });

  test("d/dw y_3(z) = 0  (free-symbol-independence; w ≠ z)", () => {
    const got = diff(expr("SphericalBesselY", [int(3n), z]), w);
    expect(eq(got, int(0n))).toBe(true);
  });

  test("determinism: j_3(z) diff hash-equal across two calls", () => {
    const f = expr("SphericalBesselJ", [int(3n), z]);
    const a = canonicalize(diff(f));
    const b = canonicalize(diff(f));
    expect(a).toBe(b);
  });
});

describe("differentiate — orthogonal polynomials (HermiteH only in v0.1)", () => {
  test("d/dz H_n(z) = 2n · H_{n-1}(z)  (DLMF §18.9.27; var = z)", () => {
    const got = diff(expr("HermiteH", [n, z]));
    const want = expr("*", [
      expr("*", [int(2n), n]),
      expr("HermiteH", [int(1n), z]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("LegendreP / Q / LaguerreL / Chebyshev / Gegenbauer refuse in v0.1", () => {
    for (const head of ["LegendreP", "LegendreQ", "LaguerreL",
                        "ChebyshevT", "ChebyshevU", "GegenbauerC"]) {
      expect(() => diff(expr(head, [n, z]))).toThrow(CasDiffOutOfScopeError);
    }
  });
});

describe("differentiate — Polylog / LerchPhi", () => {
  test("d/dz Li_s(z) = Li_{s-1}(z) / z  (DLMF §25.12.4; var = z)", () => {
    const s = int(3n);
    const got = diff(expr("Polylog", [s, z]));
    const want = expr("/", [expr("Polylog", [int(2n), z]), z]);
    expect(eq(got, want)).toBe(true);
  });

  test("LerchPhi refuses (3-param recurrence deferred)", () => {
    expect(() =>
      diff(expr("LerchPhi", [z, int(2n), int(1n)])),
    ).toThrow(CasDiffOutOfScopeError);
  });
});

describe("differentiate — list-head deferred (HypergeometricPFQ, MeijerG)", () => {
  test("HypergeometricPFQ refuses (list-shift smart constructor not in v0.1)", () => {
    const f = expr("HypergeometricPFQ", [
      list([int(1n), int(1n)]),       // a-list: {1, 1}
      list([int(2n)]),                // b-list: {2}
      z,
    ]);
    expect(() => diff(f)).toThrow(CasDiffOutOfScopeError);
  });

  test("MeijerG refuses", () => {
    const f = expr("MeijerG", [
      list([list([]), list([])]),
      list([list([int(0n)]), list([])]),
      z,
    ]);
    expect(() => diff(f)).toThrow(CasDiffOutOfScopeError);
  });
});

describe("differentiate — Whittaker / ParabolicCylinder deferred", () => {
  test("WhittakerM refuses", () => {
    const f = expr("WhittakerM", [int(1n), int(1n), z]);
    expect(() => diff(f)).toThrow(CasDiffOutOfScopeError);
  });

  test("WhittakerW refuses", () => {
    const f = expr("WhittakerW", [int(1n), int(1n), z]);
    expect(() => diff(f)).toThrow(CasDiffOutOfScopeError);
  });

  test("ParabolicCylinderD refuses", () => {
    const f = expr("ParabolicCylinderD", [int(2n), z]);
    expect(() => diff(f)).toThrow(CasDiffOutOfScopeError);
  });
});

// -----------------------------------------------------------------------------
// Composition with elementary vocabulary
// -----------------------------------------------------------------------------

describe("differentiate — composition with elementary heads", () => {
  test("d/dz (Γ(z) · sin(z)) = ψ(z)·Γ(z)·sin(z) + Γ(z)·cos(z)  (product rule)", () => {
    const got = diff(expr("*", [expr("Gamma", [z]), expr("sin", [z])]));
    const want = expr("+", [
      expr("*", [
        expr("*", [expr("Digamma", [z]), expr("Gamma", [z])]),
        expr("sin", [z]),
      ]),
      expr("*", [expr("Gamma", [z]), expr("cos", [z])]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dz exp(erf(z)) = exp(erf(z)) · 2/√π · exp(-z²)", () => {
    const got = diff(expr("exp", [expr("Erf", [z])]));
    const want = expr("*", [
      expr("exp", [expr("Erf", [z])]),
      expr("*", [
        expr("/", [int(2n), expr("sqrt", [sym("pi")])]),
        expr("exp", [expr("neg", [expr("^", [z, int(2n)])])]),
      ]),
    ]);
    expect(eq(got, want)).toBe(true);
  });

  test("d/dw Γ(z) = 0  (free-symbol-independence — z is not w)", () => {
    const got = diff(expr("Gamma", [z]), w);
    expect(eq(got, int(0n))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Determinism (same input bytes → same output bytes)
// -----------------------------------------------------------------------------

describe("differentiate — determinism on special-function rules", () => {
  test("Gamma(z): hash-equal across two calls", () => {
    const f = expr("Gamma", [z]);
    const a = canonicalize(diff(f));
    const b = canonicalize(diff(f));
    expect(a).toBe(b);
  });

  test("BesselJ(3, z): hash-equal across two calls", () => {
    const f = expr("BesselJ", [int(3n), z]);
    const a = canonicalize(diff(f));
    const b = canonicalize(diff(f));
    expect(a).toBe(b);
  });
});
