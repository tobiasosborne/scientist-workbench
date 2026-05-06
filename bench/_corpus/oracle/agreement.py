"""Per-kind agreement layer: do two oracle outputs describe the same
mathematical object?

`agree(a, b, kind)` returns `True` iff the two oracle results encode
the same answer modulo the verifier-invariant equivalence relation
appropriate for `kind`. A `True` answer means the case can be admitted
to the golden suite (or, in the triple-witness protocol, contributes
one consensus vote).

Every kind handler implements the same shape: a comparator that
substitutes both representations into a common mathematical form and
checks equivalence symbolically (preferred) or numerically (fallback,
within strict tolerance).

Per ADR-0019 §3 + §6.

Supported kinds:
    'refusal'        — both oracles refused (status != 'ok')
    'solve'          — solution sets, branch-aware
    'factor-list'    — univariate factorization over Q
    'real-roots'     — list of isolating intervals
    'groebner-basis' — bidirectional ideal containment
    'is-irreducible' — boolean equality
"""
from __future__ import annotations
from typing import Any, Dict, List

import sympy as sp

try:
    from .wolfram import parse_solution_set
except ImportError:
    from wolfram import parse_solution_set


def agree(a: Dict[str, Any], b: Dict[str, Any], kind: str, **ctx) -> bool:
    """Top-level dispatcher. `a` and `b` are oracle envelopes (from
    `wolfram_query` / `sympy_query`). `kind` selects the comparator.
    `ctx` provides additional context: e.g., for 'solve' the equation
    string + var list are needed to verify substitutions.

    Refusal handling: if EITHER oracle is in a non-ok state, the only
    way to agree is via `kind='refusal'` semantics — both refused.
    Otherwise, agreement is False (one oracle has an answer the other
    doesn't or couldn't produce).
    """
    if kind == "refusal":
        return _agree_refusal(a, b)

    a_ok = a.get("status") == "ok"
    b_ok = b.get("status") == "ok"
    if not (a_ok and b_ok):
        return False

    a_res = a["result"]
    b_res = b["result"]

    handler = _DISPATCH.get(kind)
    if handler is None:
        raise ValueError(f"unknown agreement kind: {kind!r}")
    return handler(a_res, b_res, **ctx)


# ---------------------------------------------------------------------
# Refusal
# ---------------------------------------------------------------------


def _agree_refusal(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    """Both oracles refused (timeout, $Failed, NotImplementedError, ...).
    The class of refusal does NOT have to match; what matters is that
    neither could produce an answer.
    """
    return a.get("status") != "ok" and b.get("status") != "ok"


# ---------------------------------------------------------------------
# Solve
# ---------------------------------------------------------------------


def _agree_solve(
    wolfram_str: str,
    sympy_solutions: List[Dict[str, Any]],
    *,
    equation: str,
    variables: List[str],
    tol: float = 1e-12,
) -> bool:
    """Solution-set agreement.

    `wolfram_str` is the Wolfram InputForm of `Solve[]` output, parsed
    into a list of {var -> InputForm-string} bindings.
    `sympy_solutions` is the list-of-dicts SymPy returned.

    Both must:
      (1) Have the same cardinality.
      (2) Each Wolfram solution corresponds to exactly one SymPy
          solution under "substitute back into `equation` and check
          equality" — bipartite matching, not positional.

    Conditional / branched output (Mathematica's `ConditionalExpression[
    ..., C[1] ∈ Integers]` or SymPy's `ImageSet`) is reported by the
    higher-level branched-cube verifier, not here. This handler is for
    the discrete-finite-solution-set case.
    """
    wolfram = parse_solution_set(wolfram_str)
    if len(wolfram) != len(sympy_solutions):
        return False

    syms = {v: sp.symbols(v) for v in variables}
    eq = _parse_equation(equation, syms)

    # Convert Wolfram bindings to SymPy expressions (best-effort).
    wolfram_sp = []
    for binding in wolfram:
        try:
            wolfram_sp.append(
                {v: sp.sympify(_wolfram_to_sympy(expr_str), locals=syms)
                 for v, expr_str in binding.items()}
            )
        except (sp.SympifyError, SyntaxError, ValueError):
            return False

    # Build the bipartite-match adjacency by checking whether each
    # Wolfram solution evaluates the same as some SymPy solution under
    # substitution into `eq`. Both should make `eq` evaluate to a true
    # equation (LHS - RHS simplifies to 0, or numerically << tol).
    matched_sympy: set[int] = set()
    for w_sol in wolfram_sp:
        for j, s_sol in enumerate(sympy_solutions):
            if j in matched_sympy:
                continue
            if _bindings_equivalent(w_sol, s_sol, syms, eq, tol):
                matched_sympy.add(j)
                break
        else:
            return False
    return len(matched_sympy) == len(sympy_solutions)


def _wolfram_to_sympy(expr_str: str) -> str:
    """Translate Mathematica InputForm to SymPy-parseable Python.

    Handles the common cases: Pi -> pi, E -> E, I -> I, Sqrt[..] ->
    sqrt(..), Sin[..]/Cos[..]/Tan[..]/etc., function-call brackets ->
    parens. Does NOT translate Root[#^5 - # - 1 &, 1] (handled
    separately in agree('algebraic-number', ...) when that ships).
    """
    # Whitespace-insensitive replacements; order-sensitive (longer
    # tokens first to avoid sub-token collisions like 'Pi' inside
    # 'PiecewiseExpand').
    s = expr_str
    s = s.replace("Sqrt[", "sqrt(")
    for name in (
        "Sin", "Cos", "Tan", "Cot", "Sec", "Csc",
        "Sinh", "Cosh", "Tanh",
        "ArcSin", "ArcCos", "ArcTan",
        "Exp", "Log", "Abs",
    ):
        py_name = name.lower()
        if name == "ArcSin":
            py_name = "asin"
        if name == "ArcCos":
            py_name = "acos"
        if name == "ArcTan":
            py_name = "atan"
        s = s.replace(f"{name}[", f"{py_name}(")
    # Replace remaining bracket-form function calls with parens. This is
    # heuristic; assumes brackets only appear in function calls. Adequate
    # for Solve[] output's standard expression shapes.
    s = s.replace("[", "(").replace("]", ")")
    # Constant translations.
    s = s.replace("Pi", "pi")
    return s


def _parse_equation(equation_str: str, syms: dict):
    """Parse 'lhs == rhs' (or 'expr' alone, == 0)."""
    if "==" in equation_str:
        lhs, rhs = equation_str.split("==", 1)
        return sp.sympify(lhs, locals=syms) - sp.sympify(rhs, locals=syms)
    return sp.sympify(equation_str, locals=syms)


def _bindings_equivalent(
    a: Dict[str, sp.Expr],
    b: Dict[str, sp.Expr],
    syms: dict,
    eq: sp.Expr,
    tol: float,
) -> bool:
    """Two bindings are equivalent if substituting either into the
    equation yields the same value (= 0 ideally, both within tol
    numerically as a fallback)."""
    if set(a.keys()) != set(b.keys()):
        return False
    sub_a = eq.subs({syms[k]: v for k, v in a.items()})
    sub_b = eq.subs({syms[k]: v for k, v in b.items()})
    # Symbolic-zero check first (preferred).
    if sp.simplify(sub_a - sub_b) == 0:
        # Either both are 0 (the desired case) or they're equal-and-non-
        # zero (which means BOTH are wrong solutions — falls through to
        # numerical check).
        if sp.simplify(sub_a) == 0 and sp.simplify(sub_b) == 0:
            return True
    # Numerical fallback for cases simplify can't close (transcendental
    # combinations etc.).
    try:
        a_num = complex(sp.N(sub_a, 50))
        b_num = complex(sp.N(sub_b, 50))
    except (TypeError, ValueError):
        return False
    return abs(a_num) < tol and abs(b_num) < tol


# ---------------------------------------------------------------------
# Factor-list
# ---------------------------------------------------------------------


def _agree_factor_list(
    wolfram_str: str,
    sympy_factors: List[tuple],
    *,
    var: str,
) -> bool:
    """Wolfram returns Factor[]'s product expression like
    '(-1 + x)*(1 + x)*(1 + x^2)'; SymPy returns
    [('-1 + x', 1), ('1 + x', 1), ('x^2 + 1', 1)].

    Agreement: parse Wolfram's expansion into factor list (multiplicity
    by repetition), normalize signs and constant-content, compare as
    multisets.
    """
    x = sp.symbols(var)
    try:
        wolf_expr = sp.sympify(wolfram_str.replace("^", "**"), locals={var: x})
    except (sp.SympifyError, SyntaxError):
        return False
    wolf_poly = sp.Poly(wolf_expr, x, domain="QQ")
    wolf_coeff, wolf_factors = wolf_poly.factor_list()
    wolf_canonical = sorted(
        [(str(f.as_expr()), m) for f, m in wolf_factors]
    )
    sympy_canonical = sorted(
        [(f, m) for (f, m) in sympy_factors if not _is_constant_str(f, x)]
    )
    return wolf_canonical == sympy_canonical


def _is_constant_str(s: str, x) -> bool:
    try:
        e = sp.sympify(s, locals={str(x): x})
        return e.free_symbols == set()
    except Exception:
        return False


# ---------------------------------------------------------------------
# Real-root intervals
# ---------------------------------------------------------------------


def _agree_real_roots(
    wolfram_str: str,
    sympy_intervals: List[tuple],
    *,
    var: str,
) -> bool:
    """Wolfram's `RootIntervals[poly]` returns nested rationals;
    SymPy's `Poly.intervals()` returns the same flat list. Agreement
    reduces to: same count, AND each Wolfram interval overlaps a
    unique SymPy interval (bipartite, not positional, since both can
    refine differently).
    """
    wolf = _parse_root_intervals(wolfram_str)
    if len(wolf) != len(sympy_intervals):
        return False
    used: set[int] = set()
    for (a1, b1) in wolf:
        for j, (a2_s, b2_s) in enumerate(sympy_intervals):
            if j in used:
                continue
            a2 = sp.Rational(a2_s)
            b2 = sp.Rational(b2_s)
            if max(a1, a2) <= min(b1, b2):
                used.add(j)
                break
        else:
            return False
    return len(used) == len(sympy_intervals)


def _parse_root_intervals(s: str) -> List[tuple]:
    """Parse Wolfram RootIntervals InputForm `{{a, b}, {c, d}, ...}`
    into a list of (Rational, Rational)."""
    s = s.strip()
    if not (s.startswith("{") and s.endswith("}")):
        raise ValueError(f"not a RootIntervals InputForm: {s[:80]}")
    s = s[1:-1].strip()
    if not s:
        return []
    pairs: List[tuple] = []
    depth = 0
    cur: list[str] = []
    chunks: list[str] = []
    for ch in s:
        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        if ch == "," and depth == 0:
            chunks.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur:
        chunks.append("".join(cur).strip())
    for chunk in chunks:
        c = chunk.strip()
        if c.startswith("{") and c.endswith("}"):
            c = c[1:-1].strip()
        a_s, b_s = c.split(",", 1)
        pairs.append((sp.Rational(a_s.strip()), sp.Rational(b_s.strip())))
    return pairs


# ---------------------------------------------------------------------
# Groebner basis
# ---------------------------------------------------------------------


def _agree_groebner_basis(
    wolfram_str: str,
    sympy_basis: List[str],
    *,
    variables: List[str],
    order: str = "lex",
) -> bool:
    """Two Groebner bases of the same ideal need NOT be byte-identical
    (different orderings of like polynomials, different sign normaliz-
    ations). Agreement = bidirectional ideal containment: every Wolfram
    polynomial reduces to 0 modulo SymPy's basis, and vice versa.
    """
    syms = sp.symbols(variables)
    if not isinstance(syms, tuple):
        syms = (syms,)

    # Parse Wolfram basis from InputForm `{p1, p2, ...}`.
    if not (wolfram_str.startswith("{") and wolfram_str.endswith("}")):
        return False
    inner = wolfram_str[1:-1].strip()
    wolf_strs: List[str] = []
    if inner:
        depth = 0
        cur: list[str] = []
        for ch in inner:
            if ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
            if ch == "," and depth == 0:
                wolf_strs.append("".join(cur).strip())
                cur = []
            else:
                cur.append(ch)
        if cur:
            wolf_strs.append("".join(cur).strip())

    locals_map = {str(v): v for v in syms}

    try:
        wolf_polys = [
            sp.Poly(sp.sympify(s.replace("^", "**"), locals=locals_map), *syms, domain="QQ")
            for s in wolf_strs
        ]
        sympy_polys = [
            sp.Poly(sp.sympify(s.replace("^", "**"), locals=locals_map), *syms, domain="QQ")
            for s in sympy_basis
        ]
    except (sp.SympifyError, SyntaxError, sp.PolynomialError):
        return False

    sympy_groebner = sp.groebner(
        [p.as_expr() for p in sympy_polys], *syms, order=order
    )
    wolf_groebner = sp.groebner(
        [p.as_expr() for p in wolf_polys], *syms, order=order
    )
    # If both ideals are the same, their reduced Groebner bases (in the
    # same order) are byte-identical up to signed-monic normalization.
    a = sorted(str(p) for p in sympy_groebner.polys)
    b = sorted(str(p) for p in wolf_groebner.polys)
    return a == b


# ---------------------------------------------------------------------
# Is-irreducible
# ---------------------------------------------------------------------


def _agree_is_irreducible(
    wolfram_str: str,
    sympy_bool: bool,
) -> bool:
    """Wolfram returns 'True' / 'False' as InputForm; compare booleans."""
    return wolfram_str.strip() == ("True" if sympy_bool else "False")


# ---------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------


_DISPATCH = {
    "solve": _agree_solve,
    "factor-list": _agree_factor_list,
    "real-roots": _agree_real_roots,
    "groebner-basis": _agree_groebner_basis,
    "is-irreducible": _agree_is_irreducible,
}
