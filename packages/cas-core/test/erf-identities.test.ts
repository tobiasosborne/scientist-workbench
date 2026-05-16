// =============================================================================
// erf-identities.test.ts — per-rule + cross-rule + end-to-end Erf-family tests
// =============================================================================
//
// Three layers (mirroring the file structure of `erf-identities.ts`):
//
// 1. **Per-rule tests** — one test per rule in `ERF_RULES`, each
//    asserting that the rule fires on its expected input shape and
//    emits the canonical rewritten form. The assertions use
//    canonicalized JSON byte-comparison (the same shape the test suite
//    already uses for the diff-rule tests).
//
// 2. **Cross-rule cascade tests** — verify that compound inputs
//    (`Erfi(-z)`, `Erf(neg(0))`, etc.) cascade correctly through the
//    rewriter to a fixed point.
//
// 3. **End-to-end cas-simplify tests** — the load-bearing behaviour
//    the CLAUDE.md spec requires: `simplify(Erfc(z) + Erf(z))` returns
//    `1`, `simplify(Erfi(z))` returns the canonicalised `-i·Erf(iz)`
//    rewrite, idempotence holds across a corpus of representative
//    inputs.
//
// Mutation-prove discipline
// -------------------------
// The worklog shard (134) documents three perturbations that cause
// these tests to fail RED — see the shard for the procedure. The
// tests below are the load-bearing canaries; if any of them goes
// green for the wrong reason, mutation-prove again.
//
// References
// ----------
// * R1 — `docs/refs/erf-research/R1-symbolic-identities.md`
// * DLMF Chapter 7 — `https://dlmf.nist.gov/7`
// * `packages/cas-core/src/special-funcs/erf-identities.ts` —
//   the table under test.
// * `packages/cas-core/src/simplify.ts` — the dispatcher hook.

import { describe, expect, test } from "bun:test";
import { canonicalize, expr, int, sym, type Value } from "@workbench/protocol";
import { casSimplify } from "../src/simplify.js";
import {
  collapseErfComplementPairs,
  ERF_RULES,
  isErfFamilyHead,
  tryErfSimplify,
} from "../src/special-funcs/erf-identities.js";
import { mkNeg, mkPlus, mkTimes, ONE, ZERO } from "../src/diff.js";

const z = sym("z");
const y = sym("y");
const I = sym("I");
const INFTY = sym("infinity");

function eq(a: Value, b: Value): string {
  // Helper that returns the canonical string for both sides so a
  // failure prints the actual VS expected canonical shape. Returns
  // empty string on equality.
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  return ca === cb ? "" : `\n  actual:   ${ca}\n  expected: ${cb}`;
}

// -----------------------------------------------------------------------------
// Table-shape smoke tests
// -----------------------------------------------------------------------------

describe("ERF_RULES table — shape and coverage", () => {
  test("rule IDs are unique", () => {
    const ids = new Set<string>();
    for (const r of ERF_RULES) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
  });

  test("every rule's head is in the Erf family", () => {
    for (const r of ERF_RULES) {
      expect(isErfFamilyHead(r.head)).toBe(true);
    }
  });

  test("table ships at least 19 rules (v0.1 R1 §11 deduplicated count)", () => {
    // 14 special-values + 4 parity + 1 Erfi-canonicalise = 19 rules,
    // covering 22 R1 §11 rule slots (some R1 rules collapse to the
    // same TS rule via shared structure; see file header for the
    // accounting).
    expect(ERF_RULES.length).toBeGreaterThanOrEqual(19);
  });

  test("every Erf-family head has at least one rule", () => {
    const heads = new Set(ERF_RULES.map((r) => r.head));
    for (const h of ["Erf", "Erfc", "Erfi", "InverseErf", "InverseErfc"]) {
      expect(heads.has(h)).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// Per-rule: special values (R1 §1)
// -----------------------------------------------------------------------------

describe("tryErfSimplify — special values (R1 §1)", () => {
  test("Erf(0) = 0 (DLMF 7.2.1)", () => {
    const got = tryErfSimplify("Erf", [ZERO]);
    expect(got).not.toBeNull();
    expect(eq(got!, ZERO)).toBe("");
  });

  test("Erf(+∞) = 1 (DLMF 7.2.4)", () => {
    const got = tryErfSimplify("Erf", [INFTY]);
    expect(eq(got!, ONE)).toBe("");
  });

  test("Erf(-∞) = -1 (DLMF 7.2.4 + 7.4.1)", () => {
    const got = tryErfSimplify("Erf", [mkNeg(INFTY)]);
    expect(eq(got!, mkNeg(ONE))).toBe("");
  });

  test("Erfc(0) = 1 (DLMF 7.2.2 + 7.2.1)", () => {
    const got = tryErfSimplify("Erfc", [ZERO]);
    expect(eq(got!, ONE)).toBe("");
  });

  test("Erfc(+∞) = 0 (DLMF 7.2.4)", () => {
    const got = tryErfSimplify("Erfc", [INFTY]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("Erfc(-∞) = 2 (DLMF 7.4.2)", () => {
    const got = tryErfSimplify("Erfc", [mkNeg(INFTY)]);
    expect(eq(got!, int(2n))).toBe("");
  });

  test("Erfi(0) = 0 (defn + R1 §1.3)", () => {
    const got = tryErfSimplify("Erfi", [ZERO]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("Erfi(+∞) = +∞ (SymPy:erfi)", () => {
    const got = tryErfSimplify("Erfi", [INFTY]);
    expect(eq(got!, INFTY)).toBe("");
  });

  test("Erfi(-∞) = -∞ (odd symmetry of Erfi)", () => {
    const got = tryErfSimplify("Erfi", [mkNeg(INFTY)]);
    expect(eq(got!, mkNeg(INFTY))).toBe("");
  });

  test("InverseErf(0) = 0 (DLMF 7.17.2)", () => {
    const got = tryErfSimplify("InverseErf", [ZERO]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("InverseErf(1) = +∞ (DLMF 7.17.1)", () => {
    const got = tryErfSimplify("InverseErf", [int(1n)]);
    expect(eq(got!, INFTY)).toBe("");
  });

  test("InverseErf(-1) = -∞ (symmetry)", () => {
    const got = tryErfSimplify("InverseErf", [int(-1n)]);
    expect(eq(got!, mkNeg(INFTY))).toBe("");
  });

  test("InverseErfc(0) = +∞ (DLMF 7.17.1)", () => {
    const got = tryErfSimplify("InverseErfc", [ZERO]);
    expect(eq(got!, INFTY)).toBe("");
  });

  test("InverseErfc(1) = 0 (DLMF 7.17.1)", () => {
    const got = tryErfSimplify("InverseErfc", [int(1n)]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("InverseErfc(2) = -∞ (DLMF 7.17.1)", () => {
    const got = tryErfSimplify("InverseErfc", [int(2n)]);
    expect(eq(got!, mkNeg(INFTY))).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Per-rule: parity / symmetry (R1 §2)
// -----------------------------------------------------------------------------

describe("tryErfSimplify — parity / symmetry (R1 §2)", () => {
  test("Erf(-z) = -Erf(z) (DLMF 7.4.1; via mkNeg)", () => {
    const got = tryErfSimplify("Erf", [mkNeg(z)]);
    const want = mkNeg(expr("Erf", [z]));
    expect(eq(got!, want)).toBe("");
  });

  test("Erf(-z) — also fires when arg is the unary `-` form", () => {
    const got = tryErfSimplify("Erf", [expr("-", [z])]);
    const want = mkNeg(expr("Erf", [z]));
    expect(eq(got!, want)).toBe("");
  });

  test("Erfc(-z) = 2 - Erfc(z) (DLMF 7.4.2)", () => {
    const got = tryErfSimplify("Erfc", [mkNeg(z)]);
    const want = expr("-", [int(2n), expr("Erfc", [z])]);
    expect(eq(got!, want)).toBe("");
  });

  test("Erfi(-z) = -Erfi(z) (R1 §2 — Erfi is odd)", () => {
    const got = tryErfSimplify("Erfi", [mkNeg(z)]);
    const want = mkNeg(expr("Erfi", [z]));
    expect(eq(got!, want)).toBe("");
  });

  test("InverseErf(-z) = -InverseErf(z) (odd on principal branch)", () => {
    const got = tryErfSimplify("InverseErf", [mkNeg(z)]);
    const want = mkNeg(expr("InverseErf", [z]));
    expect(eq(got!, want)).toBe("");
  });

  test("parity does not misfire on binary `a - b` (R1 §2 caveat)", () => {
    // Erf(a - b) has no closed-form collapse (R1 §8, Add1). The unary-
    // only matchNegFree guard ensures the parity rule doesn't fire
    // here. The result should be `null` (no rewrite).
    const arg = expr("-", [sym("a"), sym("b")]);
    const got = tryErfSimplify("Erf", [arg]);
    expect(got).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Per-rule: algebraic interrelations (R1 §3)
// -----------------------------------------------------------------------------

describe("tryErfSimplify — algebraic interrelations (R1 §3)", () => {
  test("Erfi(z) = -i · Erf(i·z) (A3 / SymPy:erfi defn)", () => {
    const got = tryErfSimplify("Erfi", [z]);
    const want = mkNeg(mkTimes(I, expr("Erf", [mkTimes(I, z)])));
    expect(eq(got!, want)).toBe("");
  });

  test("Erfi-canonicalise does not fire on Erfi(0) (Tier-1 wins)", () => {
    // The special-value rule must take precedence over the
    // canonicaliser; otherwise idempotence would loop through
    // `Erfi(0) → -i · Erf(i·0)` instead of `Erfi(0) → 0`.
    const got = tryErfSimplify("Erfi", [ZERO]);
    expect(eq(got!, ZERO)).toBe("");
  });

  test("Erfi-canonicalise does not fire on Erfi(±∞)", () => {
    expect(eq(tryErfSimplify("Erfi", [INFTY])!, INFTY)).toBe("");
    expect(eq(tryErfSimplify("Erfi", [mkNeg(INFTY)])!, mkNeg(INFTY))).toBe("");
  });

  test("Erfi-canonicalise does not fire on Erfi(-z) (parity wins)", () => {
    // Erfi(-z) should produce -Erfi(z) (parity), NOT the deeper
    // `-i · Erf(i · -z)`. The Tier-2 parity rule comes before Tier-3
    // in declaration order; the dispatcher takes the first match.
    const got = tryErfSimplify("Erfi", [mkNeg(z)]);
    const want = mkNeg(expr("Erfi", [z]));
    expect(eq(got!, want)).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Cross-head sum-collapse helper (the Erfc + Erf = 1 invariant)
// -----------------------------------------------------------------------------

describe("collapseErfComplementPairs — direct unit tests", () => {
  test("[Erfc(z), Erf(z)] collapses to [1]", () => {
    const out = collapseErfComplementPairs([
      expr("Erfc", [z]),
      expr("Erf", [z]),
    ]);
    expect(out.length).toBe(1);
    expect(eq(out[0]!, ONE)).toBe("");
  });

  test("[Erf(z), Erfc(z)] collapses to [1] (order-independent)", () => {
    const out = collapseErfComplementPairs([
      expr("Erf", [z]),
      expr("Erfc", [z]),
    ]);
    expect(out.length).toBe(1);
    expect(eq(out[0]!, ONE)).toBe("");
  });

  test("[Erf(z), Erfc(y)] does NOT collapse (different arguments)", () => {
    const original: Value[] = [expr("Erf", [z]), expr("Erfc", [y])];
    const out = collapseErfComplementPairs(original);
    // Pointer-identical to original when no match — that's the
    // perf-saving contract.
    expect(out).toBe(original);
  });

  test("[Erf(x), Erfc(x), Erf(y), Erfc(y)] collapses both pairs to [1, 1]", () => {
    const x = sym("x");
    const out = collapseErfComplementPairs([
      expr("Erf", [x]),
      expr("Erfc", [x]),
      expr("Erf", [y]),
      expr("Erfc", [y]),
    ]);
    // Two pairs collapsed → two 1s; ordering of trailing summands is
    // arbitrary but each is `1`.
    expect(out.length).toBe(2);
    expect(eq(out[0]!, ONE)).toBe("");
    expect(eq(out[1]!, ONE)).toBe("");
  });

  test("[Erf(z), Erfc(z), x] collapses to [x, 1]", () => {
    const x = sym("x");
    const out = collapseErfComplementPairs([
      expr("Erf", [z]),
      expr("Erfc", [z]),
      x,
    ]);
    expect(out.length).toBe(2);
    // The non-collapsed summand stays; the new `1` is appended.
    // Order: original-survivors-then-new-1s.
    expect(eq(out[0]!, x)).toBe("");
    expect(eq(out[1]!, ONE)).toBe("");
  });

  test("empty list collapses to empty list (identity)", () => {
    const out = collapseErfComplementPairs([]);
    expect(out.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// End-to-end cas-simplify integration
// -----------------------------------------------------------------------------

describe("casSimplify — Erf-family end-to-end", () => {
  test("LOAD-BEARING: simplify(Erfc(z) + Erf(z)) = 1", () => {
    // The headline invariant — if this test goes RED, the cross-head
    // sum-collapse path is broken (whether in `applyErfRewrites`'s
    // `+`-branch dispatch, in `collapseErfComplementPairs`'s pair
    // detection, or in the smart-ctor `mkPlus([ONE])` collapse).
    const input = mkPlus([expr("Erfc", [z]), expr("Erf", [z])]);
    const out = casSimplify(input);
    expect(eq(out, ONE)).toBe("");
  });

  test("simplify(Erf(z) + Erfc(z)) = 1 (commutativity)", () => {
    const input = mkPlus([expr("Erf", [z]), expr("Erfc", [z])]);
    const out = casSimplify(input);
    expect(eq(out, ONE)).toBe("");
  });

  test("simplify(Erfc(z) + Erf(z) + x) = 1 + x = x + 1 (cleanly composes)", () => {
    const x = sym("x");
    const input = mkPlus([expr("Erfc", [z]), expr("Erf", [z]), x]);
    const out = casSimplify(input);
    // After Erf-collapse: [1, x]; RatFn folds to `x + 1` (canonical
    // form is sum-of-monomials with constant last). The exact
    // canonical form is whatever cas-simplify emits for `x + 1`.
    const expected = casSimplify(mkPlus([x, ONE]));
    expect(eq(out, expected)).toBe("");
  });

  test("simplify(Erf(0)) collapses to 0 via the special-value rule", () => {
    const out = casSimplify(expr("Erf", [ZERO]));
    expect(eq(out, ZERO)).toBe("");
  });

  test("simplify(Erf(z)) is preserved (out-of-scope tagged)", () => {
    // No rule fires; the foreign-pass-through wrapper kicks in.
    const out = casSimplify(expr("Erf", [z]));
    // Expected: tagged "cas-simplify/out-of-scope" wrapping Erf(z).
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") throw new Error("unreachable");
    expect(out.tag).toBe("cas-simplify/out-of-scope");
  });

  test("simplify(Erfi(z)) returns the canonical -i · Erf(i·z) form (wrapped tagged)", () => {
    // The Erfi-canonicalise rule fires; the result is
    // -i · Erf(i·z), which is itself out-of-scope (has Erf head),
    // so it ends up wrapped in tagged. The exact tag-nesting shape
    // is determined by `casSimplify`'s `recurseChildren` step (which
    // re-casSimplifies each child), so we assert against a hand-
    // built reference run through `casSimplify` rather than against
    // the raw rewritten Value. Same canonical-form output ⇒ same
    // semantic content.
    const out = casSimplify(expr("Erfi", [z]));
    const want = casSimplify(mkNeg(mkTimes(I, expr("Erf", [mkTimes(I, z)]))));
    expect(eq(out, want)).toBe("");
    // Pin: the outer node IS a tagged-out-of-scope wrap (the negation
    // is foreign to the RatFn bridge). The Erfi-canonicalise rule's
    // identifying signature shows up in the canonical form via the
    // Erf head deep inside; a no-op pre-pass would have left an Erfi
    // head at the top instead.
    expect(out.kind).toBe("tagged");
    expect(canonicalize(out).includes('"head":"Erf"')).toBe(true);
    expect(canonicalize(out).includes('"head":"Erfi"')).toBe(false);
  });

  test("simplify(Erfi(0)) collapses all the way to 0 (special-value beats canonicalise)", () => {
    const out = casSimplify(expr("Erfi", [ZERO]));
    expect(eq(out, ZERO)).toBe("");
  });

  test("simplify(Erfi(-z)) cascades: parity-then-canonicalise to i · Erf(i·z)", () => {
    // Erfi(-z) → -Erfi(z) (parity, Tier 2)
    //         → -[-i·Erf(i·z)] (Tier 3 canonicaliser on Erfi(z))
    //         → i·Erf(i·z) (mkNeg(mkNeg(x)) → x via diff.ts smart ctor)
    // Assert by canonical-form equality with `casSimplify(i · Erf(i·z))`.
    const out = casSimplify(expr("Erfi", [mkNeg(z)]));
    const want = casSimplify(mkTimes(I, expr("Erf", [mkTimes(I, z)])));
    expect(eq(out, want)).toBe("");
    // Pin: the Erfi head should have collapsed; the canonical-form
    // string contains an `Erf` head but no `Erfi` head, and no
    // top-level `neg` (parity wrapped the inner -i, which the
    // canonicaliser's outer -i cancelled with).
    expect(canonicalize(out).includes('"head":"Erf"')).toBe(true);
    expect(canonicalize(out).includes('"head":"Erfi"')).toBe(false);
  });

  test("simplify(Erf(neg(0))) = simplify(Erf(0)) = 0 (cascade through parity)", () => {
    // Erf(neg(0)) → parity → -Erf(0) → special-value → -0 = 0.
    // The smart-ctor `mkNeg(0) = 0` from diff.ts seals the cascade.
    const out = casSimplify(expr("Erf", [mkNeg(ZERO)]));
    expect(eq(out, ZERO)).toBe("");
  });

  test("simplify(Erfc(neg(0))) = 1 (parity-then-special-value cascade)", () => {
    // Erfc(neg(0)) → parity → 2 - Erfc(0) → 2 - 1 = 1.
    const out = casSimplify(expr("Erfc", [mkNeg(ZERO)]));
    expect(eq(out, ONE)).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Foreign-pass-through invariant preservation
// -----------------------------------------------------------------------------
//
// The pre-pass MUST NOT change the cas-simplify foreign-pass-through
// behaviour for any subtree that does not contain an Erf-family head.

describe("casSimplify — foreign-pass-through unchanged", () => {
  test("sin(x) still wraps as tagged out-of-scope (regression check)", () => {
    const out = casSimplify(expr("sin", [sym("x")]));
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") throw new Error("unreachable");
    expect(out.tag).toBe("cas-simplify/out-of-scope");
  });

  test("matmul(A, B+B) preserved with arithmetic simplified inside", () => {
    const out = casSimplify(
      expr("matmul", [sym("A"), expr("+", [sym("B"), sym("B")])]),
    );
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") throw new Error("unreachable");
    // Inner: matmul(A, 2*B) — the arithmetic child simplified.
    expect(out.payload.kind).toBe("expression");
  });

  test("Erf inside a foreign head: simplify(matmul(A, Erf(0))) wraps with Erf(0) → 0", () => {
    // The Erf-pass-through fires on the inner Erf(0), then the outer
    // matmul wraps the rewritten subtree.
    const input = expr("matmul", [sym("A"), expr("Erf", [ZERO])]);
    const out = casSimplify(input);
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") throw new Error("unreachable");
    if (out.payload.kind !== "expression") throw new Error("expected expr");
    expect(out.payload.head).toBe("matmul");
    expect(out.payload.args.length).toBe(2);
    // Second arg should be the simplified Erf(0) = 0.
    expect(eq(out.payload.args[1]!, ZERO)).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Idempotence
// -----------------------------------------------------------------------------

describe("casSimplify — idempotence on Erf-family corpus", () => {
  const corpus: Value[] = [
    expr("Erf", [ZERO]),
    expr("Erf", [INFTY]),
    expr("Erf", [mkNeg(INFTY)]),
    expr("Erfc", [ZERO]),
    expr("Erfc", [INFTY]),
    expr("Erfi", [ZERO]),
    expr("Erfi", [z]),
    expr("Erfi", [mkNeg(z)]),
    expr("Erf", [mkNeg(z)]),
    expr("Erfc", [mkNeg(z)]),
    expr("InverseErf", [ZERO]),
    expr("InverseErf", [int(1n)]),
    expr("InverseErf", [int(-1n)]),
    expr("InverseErf", [mkNeg(z)]),
    expr("InverseErfc", [ZERO]),
    expr("InverseErfc", [int(1n)]),
    expr("InverseErfc", [int(2n)]),
    mkPlus([expr("Erfc", [z]), expr("Erf", [z])]),
    mkPlus([expr("Erfc", [z]), expr("Erf", [z]), sym("x")]),
    expr("matmul", [sym("A"), expr("Erf", [ZERO])]),
    // Mixed: an Erf inside a `+` with non-Erf summands.
    mkPlus([expr("Erf", [z]), sym("x"), int(2n)]),
    // A nested cascade.
    expr("Erfi", [mkNeg(z)]),
  ];

  test("simplify(simplify(v)) = simplify(v) for each corpus entry", () => {
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

  test("simplify(v) is deterministic across two calls (hash-equal)", () => {
    for (const v of corpus) {
      const a = canonicalize(casSimplify(v));
      const b = canonicalize(casSimplify(v));
      expect(a).toBe(b);
    }
  });
});
