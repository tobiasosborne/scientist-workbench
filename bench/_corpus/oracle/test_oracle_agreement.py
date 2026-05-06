"""Brutal self-tests for the oracle-agreement layer.

These tests exist to mutation-prove the agreement layer itself
(ADR-0019 §4 + §6). The layer's failure mode is silent: a layer that
calls everything `True` would let bench cases through with hidden
oracle disagreement, which would then propagate into golden masters,
which would then mask candidate-implementation bugs. The whole solve
epic's correctness rests on this layer NOT false-positiving.

Test categories:
  1. Sanity — trivial agreement on identical forms.
  2. Representation-drift — same answer, different forms (Wolfram
     prefers Sqrt, SymPy might rationalize, both correct).
  3. Refusal-mode — both oracles refused; class-of-refusal need not
     match.
  4. Mathematical disagreement — different answers MUST trigger False.
  5. One-oracle-only — when one oracle has an answer the other
     doesn't, agreement is False.
  6. Adversarial cases — wrong-but-look-right outputs that ONLY a
     correct agreement-layer detects.
  7. Edge cases — empty solution sets, dropped factor, swapped-sign
     leading coefficient, etc.

Live-Wolfram tests are marked `@pytest.mark.live_oracle` and skipped
when the kernel is not activated (`WB_LIVE_ORACLE=0`).

Run:  cd bench/_corpus/oracle && python3 -m pytest -v
Skip live: WB_LIVE_ORACLE=0 python3 -m pytest -v -m "not live_oracle"
"""
from __future__ import annotations

import pytest

from agreement import agree
from sympy_bridge import sympy_query
from wolfram import parse_solution_set, wolfram_query


needs_wolfram = pytest.mark.live_oracle
# Category marker: collected via `-m live_oracle`. The skip-when-
# WB_LIVE_ORACLE=0 hook lives in conftest.py per pytest hook-discovery
# rules.


# =====================================================================
# Category 1 — sanity: trivial agreement
# =====================================================================


def test_sanity_solve_unique_linear_agrees():
    wolf = {"status": "ok", "result": "{{x -> 2}}"}
    sympy_sol = sympy_query("solve", "x + 1 == 3", ["x"])
    assert agree(wolf, sympy_sol, "solve",
                 equation="x + 1 == 3", variables=["x"])


def test_sanity_factor_x4_minus_1_agrees():
    wolf = {"status": "ok", "result": "(-1 + x)*(1 + x)*(1 + x^2)"}
    sympy_fac = sympy_query("factor", "x**4 - 1", "x")
    assert agree(wolf, sympy_fac, "factor-list", var="x")


def test_sanity_irreducible_agrees():
    wolf = {"status": "ok", "result": "True"}
    sympy_ir = sympy_query("is_irreducible", "x**2 + 1", "x")
    assert agree(wolf, sympy_ir, "is-irreducible")


def test_sanity_groebner_lex_agrees():
    """{x^2 + y, x*y + 1} — the canonical Buchberger toy case;
    lex Groebner basis is {1 + y^3, x - y^2}."""
    wolf = {"status": "ok", "result": "{1 + y^3, x - y^2}"}
    sympy_gb = sympy_query("groebner",
                            ["x**2 + y", "x*y + 1"], ["x", "y"], "lex")
    assert agree(wolf, sympy_gb, "groebner-basis",
                 variables=["x", "y"], order="lex")


def test_sanity_real_roots_agrees():
    """x^2 - 2 has two real roots; intervals around ±√2."""
    wolf = {"status": "ok", "result": "{{-2, -1}, {1, 2}}"}
    sympy_rr = sympy_query("real_roots", "x**2 - 2", "x")
    assert agree(wolf, sympy_rr, "real-roots", var="x")


# =====================================================================
# Category 2 — representation drift: same answer, different form
# =====================================================================


def test_drift_quadratic_solve_radicals():
    """x^2 - 2 == 0; both should agree x = ±√2 even though the surface
    forms might differ (`Sqrt[2]` vs `sqrt(2)`)."""
    wolf = {"status": "ok", "result": "{{x -> -Sqrt[2]}, {x -> Sqrt[2]}}"}
    sympy_sol = sympy_query("solve", "x**2 - 2 == 0", ["x"])
    assert agree(wolf, sympy_sol, "solve",
                 equation="x**2 - 2 == 0", variables=["x"])


def test_drift_solve_order_independent():
    """Solution-set agreement is bipartite-matching, not positional.
    Wolfram returns +Sqrt[2] then -Sqrt[2]; we must not require order."""
    wolf = {"status": "ok", "result": "{{x -> Sqrt[2]}, {x -> -Sqrt[2]}}"}
    sympy_sol = sympy_query("solve", "x**2 - 2 == 0", ["x"])
    assert agree(wolf, sympy_sol, "solve",
                 equation="x**2 - 2 == 0", variables=["x"])


def test_drift_factor_constant_coefficient():
    """SymPy lifts the leading-coefficient constant out; Wolfram
    embeds it. Both are correct factorisations of `2*(x-1)*(x+1)`."""
    wolf = {"status": "ok", "result": "2*(-1 + x)*(1 + x)"}
    sympy_fac = sympy_query("factor", "2*x**2 - 2", "x")
    assert agree(wolf, sympy_fac, "factor-list", var="x")


def test_drift_groebner_signs_normalized():
    """SymPy and Wolfram may normalize basis polynomials with opposite
    signs. The agreement-layer must normalize before comparison.
    Tests via the sympy-roundtrip of both representations."""
    wolf = {"status": "ok", "result": "{1 + y^3, x - y^2}"}
    sympy_gb = sympy_query("groebner",
                           ["y + x**2", "1 + x*y"], ["x", "y"], "lex")
    assert agree(wolf, sympy_gb, "groebner-basis",
                 variables=["x", "y"], order="lex")


# =====================================================================
# Category 3 — refusal-mode agreement
# =====================================================================


def test_refusal_both_failed():
    a = {"status": "failed", "reason": "$Failed"}
    b = {"status": "failed", "reason": "NotImplementedError"}
    assert agree(a, b, "refusal")


def test_refusal_class_mismatch_still_agrees():
    """Wolfram timed out, SymPy raised — both refused; agreement holds."""
    a = {"status": "timeout", "reason": "30s exceeded"}
    b = {"status": "failed", "reason": "NotImplementedError"}
    assert agree(a, b, "refusal")


def test_refusal_only_one_refused_disagrees():
    a = {"status": "ok", "result": "{{x -> 0}}"}
    b = {"status": "failed", "reason": "NotImplementedError"}
    assert not agree(a, b, "refusal")
    # And the same input passed as a 'solve' kind also disagrees:
    assert not agree(a, b, "solve",
                     equation="x == 0", variables=["x"])


# =====================================================================
# Category 4 — mathematical disagreement (MUST trigger False)
# =====================================================================


def test_disagree_solve_wrong_answer_caught():
    """Wolfram says x=2; a buggy SymPy says x=3 (different numbers).
    Agreement layer MUST detect this. (Constructed: feed a wrong hand-
    rolled list to agree())."""
    wolf = {"status": "ok", "result": "{{x -> 2}}"}
    fake_sympy = {"status": "ok", "result": [{"x": 3}]}
    assert not agree(wolf, fake_sympy, "solve",
                     equation="x + 1 == 3", variables=["x"])


def test_disagree_solve_missed_root_caught():
    """Wolfram says x = ±√2; a buggy SymPy says only x = √2."""
    wolf = {"status": "ok", "result": "{{x -> -Sqrt[2]}, {x -> Sqrt[2]}}"}
    import sympy as sp
    fake_sympy = {"status": "ok", "result": [{"x": sp.sqrt(2)}]}
    assert not agree(wolf, fake_sympy, "solve",
                     equation="x**2 - 2 == 0", variables=["x"])


def test_disagree_solve_extra_root_caught():
    """Wolfram says x = 1; a buggy SymPy adds a spurious x = 7."""
    wolf = {"status": "ok", "result": "{{x -> 1}}"}
    fake_sympy = {"status": "ok", "result": [{"x": 1}, {"x": 7}]}
    assert not agree(wolf, fake_sympy, "solve",
                     equation="x - 1 == 0", variables=["x"])


def test_disagree_factor_dropped_factor():
    """Wolfram has 3 factors; fake SymPy drops one."""
    wolf = {"status": "ok", "result": "(-1 + x)*(1 + x)*(1 + x^2)"}
    fake_sympy = {"status": "ok",
                  "result": [("-1 + x", 1), ("1 + x", 1)]}
    assert not agree(wolf, fake_sympy, "factor-list", var="x")


def test_disagree_factor_wrong_multiplicity():
    """(x-1)^3 vs (x-1)^2: a missed multiplicity must fail."""
    wolf = {"status": "ok", "result": "(-1 + x)^3"}
    fake_sympy = {"status": "ok", "result": [("-1 + x", 2)]}
    assert not agree(wolf, fake_sympy, "factor-list", var="x")


def test_disagree_real_roots_count_mismatch():
    """Polynomial has 2 real roots; bug returns only 1."""
    wolf = {"status": "ok", "result": "{{-2, -1}, {1, 2}}"}
    fake_sympy = {"status": "ok", "result": [("1", "2")]}
    assert not agree(wolf, fake_sympy, "real-roots", var="x")


def test_disagree_real_roots_wrong_interval():
    """Same count but one interval is in the wrong region."""
    wolf = {"status": "ok", "result": "{{-2, -1}, {1, 2}}"}
    fake_sympy = {"status": "ok", "result": [("-2", "-1"), ("100", "200")]}
    assert not agree(wolf, fake_sympy, "real-roots", var="x")


def test_disagree_groebner_truncated_basis():
    """Wolfram returns the full basis; bug returns only one element."""
    wolf = {"status": "ok", "result": "{1 + y^3, x - y^2}"}
    fake_sympy = {"status": "ok", "result": ["x - y**2"]}
    assert not agree(wolf, fake_sympy, "groebner-basis",
                     variables=["x", "y"], order="lex")


def test_disagree_irreducible_wrong_bool():
    """Wolfram says reducible; bug says irreducible."""
    wolf = {"status": "ok", "result": "False"}
    assert not agree(wolf, {"status": "ok", "result": True}, "is-irreducible")


# =====================================================================
# Category 5 — one-oracle-only
# =====================================================================


def test_one_only_wolfram_succeeded():
    a = {"status": "ok", "result": "{{x -> 2}}"}
    b = {"status": "failed", "reason": "NotImplementedError"}
    assert not agree(a, b, "solve",
                     equation="x == 2", variables=["x"])


def test_one_only_sympy_succeeded():
    import sympy as sp
    a = {"status": "failed", "reason": "$Failed"}
    b = {"status": "ok", "result": [{"x": 2}]}
    assert not agree(a, b, "solve",
                     equation="x == 2", variables=["x"])


def test_one_only_timeout():
    a = {"status": "timeout", "reason": "30s exceeded"}
    b = {"status": "ok", "result": [{"x": 2}]}
    assert not agree(a, b, "solve",
                     equation="x == 2", variables=["x"])


# =====================================================================
# Category 6 — adversarial
# =====================================================================


def test_adversarial_swapped_sign_leading_coefficient():
    """`-x^2 + 1` factors as `-(x-1)(x+1)` or `(1-x)(1+x)`. Both must
    agree — the sign of the leading coefficient is a representation
    choice, not a mathematical difference."""
    wolf = {"status": "ok", "result": "(1 - x)*(1 + x)"}
    # SymPy's `factor()` of `1 - x**2` produces a particular form;
    # the agreement layer normalizes by re-factoring both.
    sympy_fac = sympy_query("factor", "1 - x**2", "x")
    assert agree(wolf, sympy_fac, "factor-list", var="x")


def test_adversarial_solve_value_with_radical_coefficient():
    """Cubic depressed `x^3 - 3*x - 2 == 0` has roots {-1, -1, 2}.
    Wolfram emits the doubled root once; SymPy `solve(dict=True)` does
    too. Set-equality (not multiplicity) is correct here per ADR-0017
    'multiplicities live in factor lists, not solve outputs'."""
    wolf = {"status": "ok", "result": "{{x -> -1}, {x -> 2}}"}
    sympy_sol = sympy_query("solve", "x**3 - 3*x - 2 == 0", ["x"])
    assert agree(wolf, sympy_sol, "solve",
                 equation="x**3 - 3*x - 2 == 0", variables=["x"])


def test_adversarial_solve_with_pi():
    """`Sin[x] == 0` over the principal branch ⇒ `x = 0`. (Branched
    output is a different test path; this just verifies the trivial
    case where v1/v2 Mathematica's principal-branch behavior is the
    correct answer.)"""
    wolf = {"status": "ok", "result": "{{x -> 0}}"}
    sympy_sol = sympy_query("solve", "sin(x) == 0", ["x"])
    # SymPy returns infinitely many solutions; we only consider the
    # principal here for this fixed test. The agreement layer may
    # therefore disagree, which is *correct* — they're returning
    # different objects. Test that the layer does NOT silently say
    # they agree.
    if len(sympy_sol.get("result", [])) != 1:
        # SymPy returned multi-solution; layer must say disagree.
        assert not agree(wolf, sympy_sol, "solve",
                         equation="sin(x) == 0", variables=["x"])


def test_adversarial_factor_with_rational_coefficient():
    """`(x/2 - 1)*(x + 3)` — rational coefficients in factors. After
    primitive-content normalization both oracles should agree."""
    wolf = {"status": "ok", "result": "(-1 + x/2)*(3 + x)"}
    sympy_fac = sympy_query(
        "factor", "(x/2 - 1)*(x + 3)", "x"
    )
    assert agree(wolf, sympy_fac, "factor-list", var="x")


def test_adversarial_groebner_basis_redundant_input():
    """Three equations describing the same ideal as two; Groebner
    basis should be canonical regardless of input redundancy."""
    wolf = {"status": "ok", "result": "{1 + y^3, x - y^2}"}
    sympy_gb = sympy_query(
        "groebner",
        ["x**2 + y", "x*y + 1", "x**3 + x*y"],
        ["x", "y"], "lex",
    )
    assert agree(wolf, sympy_gb, "groebner-basis",
                 variables=["x", "y"], order="lex")


# =====================================================================
# Category 7 — edge cases
# =====================================================================


def test_edge_no_solution():
    """Wolfram emits `{}` for inconsistent linear; SymPy `solve` also
    returns `[]`. Both refuse-as-empty must agree."""
    wolf = {"status": "ok", "result": "{}"}
    sympy_sol = sympy_query("solve", "x + 1 == x + 2", ["x"])
    assert agree(wolf, sympy_sol, "solve",
                 equation="x + 1 == x + 2", variables=["x"])


def test_edge_factor_irreducible_input():
    """`x^2 + 1` is irreducible over Q; both should return it as-is."""
    wolf = {"status": "ok", "result": "1 + x^2"}
    sympy_fac = sympy_query("factor", "x**2 + 1", "x")
    assert agree(wolf, sympy_fac, "factor-list", var="x")


def test_edge_real_roots_no_real_roots():
    """`x^2 + 1` has no real roots; both return empty list."""
    wolf = {"status": "ok", "result": "{}"}
    sympy_rr = sympy_query("real_roots", "x**2 + 1", "x")
    assert agree(wolf, sympy_rr, "real-roots", var="x")


def test_edge_groebner_principal_ideal():
    """Single-generator ideal: GB is just the input (up to scaling)."""
    wolf = {"status": "ok", "result": "{x^2 - 2}"}
    sympy_gb = sympy_query("groebner",
                           ["x**2 - 2"], ["x"], "lex")
    assert agree(wolf, sympy_gb, "groebner-basis",
                 variables=["x"], order="lex")


def test_edge_real_roots_repeated_root_at_zero():
    """`x^3` has a triple root at 0. Real-root isolation reports a
    single isolating interval (multiplicity is a factor-list concern)."""
    wolf = {"status": "ok", "result": "{{-1, 1}}"}
    sympy_rr = sympy_query("real_roots", "x**3", "x")
    assert agree(wolf, sympy_rr, "real-roots", var="x")


# =====================================================================
# Category 8 — parser / wrapper sanity (unit-level)
# =====================================================================


def test_parse_solution_set_empty():
    assert parse_solution_set("{}") == []


def test_parse_solution_set_single():
    out = parse_solution_set("{{x -> 2}}")
    assert out == [{"x": "2"}]


def test_parse_solution_set_multiple_vars():
    out = parse_solution_set("{{x -> 2, y -> 3}}")
    assert out == [{"x": "2", "y": "3"}]


def test_parse_solution_set_radical_coefficient():
    """Brackets inside Sqrt[2] must not break the rule split."""
    out = parse_solution_set("{{x -> Sqrt[2]}, {x -> -Sqrt[2]}}")
    assert out == [{"x": "Sqrt[2]"}, {"x": "-Sqrt[2]"}]


def test_parse_solution_set_root_object():
    """Root objects contain `&` and brackets; parser must survive."""
    out = parse_solution_set("{{x -> Root[#1^5 - #1 - 1 &, 1]}}")
    assert out == [{"x": "Root[#1^5 - #1 - 1 &, 1]"}]


def test_parse_solution_set_bad_input_raises():
    with pytest.raises(ValueError):
        parse_solution_set("not-a-list")


def test_sympy_query_unknown_op():
    out = sympy_query("invalid-op")
    assert out["status"] == "error"


def test_sympy_query_propagates_polynomial_error():
    """Trying to factor something that isn't a polynomial in the named
    variable surfaces as a 'failed' status, not a crash."""
    out = sympy_query("factor", "sin(x)", "x")
    assert out["status"] in ("failed", "error")


# =====================================================================
# Category 9 — LIVE oracle smoke tests (require activated kernel)
# =====================================================================


@needs_wolfram
def test_live_wolfram_solve_quadratic():
    out = wolfram_query("Solve[x^2 - 4 == 0, x]")
    assert out["status"] == "ok"
    parsed = parse_solution_set(out["result"])
    values = sorted(b["x"] for b in parsed)
    assert values == ["-2", "2"]


@needs_wolfram
def test_live_wolfram_factor_x4_minus_1():
    out = wolfram_query("Factor[x^4 - 1]")
    assert out["status"] == "ok"
    # Wolfram outputs `(-1 + x)*(1 + x)*(1 + x^2)`; merely sanity-check
    # the shape — the agreement-layer test (Category 1) does the strict
    # mathematical check.
    assert "x" in out["result"]
    assert "*" in out["result"]


@needs_wolfram
def test_live_wolfram_groebner_lex_canonical():
    out = wolfram_query(
        "GroebnerBasis[{x^2 + y, x*y + 1}, {x, y}, "
        "MonomialOrder -> Lexicographic]"
    )
    assert out["status"] == "ok"
    assert "y^3" in out["result"] or "y**3" in out["result"]


@needs_wolfram
def test_live_full_pipeline_quadratic():
    """End-to-end: Wolfram + SymPy both solve, agreement layer agrees."""
    wolf = wolfram_query("Solve[x^2 - 5 == 0, x]")
    sympy_sol = sympy_query("solve", "x**2 - 5 == 0", ["x"])
    assert agree(wolf, sympy_sol, "solve",
                 equation="x**2 - 5 == 0", variables=["x"])


@needs_wolfram
def test_live_full_pipeline_factor():
    wolf = wolfram_query("Factor[x^4 - 5*x^2 + 4]")
    sympy_fac = sympy_query("factor", "x**4 - 5*x**2 + 4", "x")
    assert agree(wolf, sympy_fac, "factor-list", var="x")


@needs_wolfram
def test_live_wolfram_kernel_activation():
    """Smoke-test that the kernel is actually responsive. If this fails
    with 'kernel-not-activated', set WB_LIVE_ORACLE=0 and skip the
    other live tests until VPN is up."""
    out = wolfram_query("1 + 1")
    assert out["status"] == "ok"
    assert out["result"].strip() == "2"
