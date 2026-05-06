"""SymPy bridge: standardised invocations + uniform return shape.

`sympy_query(operation, *args)` runs a single SymPy operation against
the same input space the Wolfram bridge accepts (text-form polynomial
input + variable list) and returns the same `{'status', 'result'|'reason'}`
discriminated dict that wolfram.py returns. This lets the agreement
layer (agreement.py) treat the two oracles uniformly.

Per ADR-0019 §3 + §6.

Operations supported:
    'solve'          — return list of dicts (var-name -> SymPy expr)
    'factor'         — return list of (factor, multiplicity) tuples
    'real_roots'     — return list of (Rational interval) tuples
    'groebner'       — return list of SymPy Poly basis elements (lex)
    'is_irreducible' — return bool
"""
from __future__ import annotations
import signal
from contextlib import contextmanager
from typing import Any, Dict, List

import sympy as sp


@contextmanager
def _timeout(seconds: float):
    """Best-effort POSIX-signal timeout. Lacks coverage on Windows but
    bench infra is *nix-only by CLAUDE.md Rule 5 (Bun on Linux).
    """
    def _handler(signum, frame):
        raise TimeoutError(f"sympy operation exceeded {seconds}s")

    old = signal.signal(signal.SIGALRM, _handler)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def sympy_query(operation: str, *args, timeout: float = 30.0) -> Dict[str, Any]:
    """Dispatch a SymPy operation under a timeout, returning the
    standardized {'status': ..., 'result'|'reason': ...} envelope.

    Catches: TimeoutError -> 'timeout'; NotImplementedError -> 'failed'
    with reason 'NotImplementedError'; PolynomialError / DomainError ->
    'failed' with the exception name; everything else -> 'error' with
    full message.
    """
    try:
        with _timeout(timeout):
            handler = _DISPATCH.get(operation)
            if handler is None:
                return {
                    "status": "error",
                    "reason": f"unknown operation '{operation}'",
                }
            return {"status": "ok", "result": handler(*args)}
    except TimeoutError as e:
        return {"status": "timeout", "reason": str(e)}
    except NotImplementedError as e:
        return {"status": "failed", "reason": f"NotImplementedError: {e}"}
    except (sp.PolynomialError, sp.GeneratorsError) as e:
        return {"status": "failed", "reason": f"{type(e).__name__}: {e}"}
    except Exception as e:
        return {
            "status": "error",
            "reason": f"{type(e).__name__}: {e}",
        }


# ---------------------------------------------------------------------
# Operation handlers — each returns a Python data structure that
# agreement.py knows how to compare to a Wolfram parse-result.
# ---------------------------------------------------------------------


def _solve(eq_str: str, var_names: List[str]) -> List[Dict[str, Any]]:
    """Solve eq_str (in Wolfram-ish syntax accepting `==`) for the
    listed variables. Returns a list of dicts {var_name -> SymPy expr}.

    Empty list = no solution; one dict = unique; multiple = multiple.
    """
    if isinstance(var_names, str):
        var_names = [var_names]
    syms = sp.symbols(var_names)
    if not isinstance(syms, (list, tuple)):
        syms = [syms]
    locals_map = {str(s): s for s in syms}
    eq = _parse_eq(eq_str, locals_map)
    sol = sp.solve(eq, list(syms), dict=True)
    return [
        {str(k): v for k, v in binding.items()}
        for binding in sol
    ]


def _factor(poly_str: str, var: str) -> List[tuple]:
    """Factor a univariate polynomial over Q. Returns
    [(factor_str, multiplicity), ...] sorted by factor_str.
    """
    x = sp.symbols(var)
    p = sp.sympify(poly_str, locals={var: x})
    p_poly = sp.Poly(p, x, domain="QQ")
    coeff, factors = p_poly.factor_list()
    out = []
    if coeff != 1:
        out.append((str(sp.Poly(coeff, x, domain="QQ").as_expr()), 1))
    for f, m in factors:
        out.append((str(f.as_expr()), m))
    return sorted(out)


def _real_roots(poly_str: str, var: str) -> List[tuple]:
    """Return SymPy's isolating-interval list for f's real roots.
    Each entry: (interval_low, interval_high) as Rational-string pairs.

    SymPy's `Poly.intervals()` returns `[((lo, hi), multiplicity), ...]`
    for univariate polynomials over Q — we drop the multiplicity since
    multiplicity is a factor-list concern (per ADR-0017), and stringify
    the rational endpoints for downstream parsing.
    """
    x = sp.symbols(var)
    p = sp.sympify(poly_str, locals={var: x})
    p_poly = sp.Poly(p, x, domain="QQ")
    return [
        (str(lo), str(hi))
        for ((lo, hi), _mult) in p_poly.intervals()
    ]


def _groebner(poly_strs: List[str], var_names: List[str], order: str = "lex") -> List[str]:
    """Compute Groebner basis. `order` ∈ {'lex', 'grevlex'}.
    Returns a list of basis-polynomial InputForm-style strings.
    """
    if isinstance(var_names, str):
        var_names = [var_names]
    syms = sp.symbols(var_names)
    if not isinstance(syms, (list, tuple)):
        syms = [syms]
    locals_map = {str(s): s for s in syms}
    polys = [sp.sympify(s, locals=locals_map) for s in poly_strs]
    g = sp.groebner(polys, *syms, order=order)
    return sorted(str(p) for p in g.polys)


def _is_irreducible(poly_str: str, var: str) -> bool:
    """Check irreducibility of a univariate polynomial over Q."""
    x = sp.symbols(var)
    p = sp.sympify(poly_str, locals={var: x})
    p_poly = sp.Poly(p, x, domain="QQ")
    coeff, factors = p_poly.factor_list()
    return len(factors) == 1 and factors[0][1] == 1


_DISPATCH = {
    "solve": _solve,
    "factor": _factor,
    "real_roots": _real_roots,
    "groebner": _groebner,
    "is_irreducible": _is_irreducible,
}


# ---------------------------------------------------------------------
# Helper: parse Mathematica-style `lhs == rhs` into a SymPy Eq, falling
# back to "expr == 0" (i.e. `expr`) when no `==` present.
# ---------------------------------------------------------------------


def _parse_eq(eq_str: str, locals_map: Dict[str, sp.Symbol] | None = None):
    """Parse 'lhs == rhs' (or 'expr' alone, ⇒ `expr == 0`)."""
    locals_map = locals_map or {}
    if "==" in eq_str:
        lhs_s, rhs_s = eq_str.split("==", 1)
        return sp.Eq(sp.sympify(lhs_s, locals=locals_map),
                     sp.sympify(rhs_s, locals=locals_map))
    return sp.sympify(eq_str, locals=locals_map)
