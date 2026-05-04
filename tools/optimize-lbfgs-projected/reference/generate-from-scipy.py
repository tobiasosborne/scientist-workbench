#!/usr/bin/env python3
"""
generate-from-scipy.py — ground-truth golden generator for tools/optimize-lbfgs-projected.

Runs each test case through SciPy's `scipy.optimize.minimize(method='L-BFGS-B')`,
which wraps the Northwestern Fortran v3.0 (Morales-Nocedal 2011 ACM TOMS Algorithm
778, Remark) on SciPy 1.14.x. Emits a JSON manifest of expected values for the
TS implementation to match.

This is the *orthogonal oracle*: completely different language (Fortran),
completely different codebase (Northwestern L-BFGS-B v3.0), decades of scientific
use. The TS implementation must produce values matching this manifest within the
documented tolerance — it MUST NOT generate its own expected values.

WHY scipy 1.14.x specifically: SciPy 1.15 ported the Fortran to C and shipped a
regression (issue scipy#23161) where the C-port converges prematurely on some
problems including 2D Rosenbrock. SciPy 1.17 appears to have addressed it, but
to keep ground truth on the canonical Fortran path we pin to 1.14.1.

For cases with KNOWN ANALYTIC OPTIMA (Rosenbrock at (1,1), Powell singular at
(0,0,0,0), etc.) the generator additionally cross-validates: it asserts that
SciPy's reported solution is within a tight tolerance of the literature-known
optimum, and embeds the known optimum in the manifest. Disagreement aborts
generation with a loud error rather than silently committing a wrong oracle.

For each case the generator emits:
  * The case's input as canonical Value JSON (f, grad, vars, x0, bounds, options)
    so the TS tool can ingest it directly and the goldens.spec.ts has a single
    source of truth for the wire form.
  * SciPy's OptimizeResult: x, fun, jac, nit, nfev, status, message, success.
  * A literature-known optimum where one exists (analytic_optimum field).
  * Per-category tolerance recommendations.

Output: a single JSON document on stdout.
Run:  .venv-oracle/bin/python generate-from-scipy.py > manifest.json
"""
import json
import math
import struct
import sys
from typing import Callable, List, Optional, Tuple

import numpy as np
import scipy
from scipy.optimize import minimize


# =============================================================================
# Value-JSON builders — produce canonical workbench wire form
# =============================================================================
#
# The workbench's value protocol (see packages/protocol) expects:
#   integer:    {"kind":"integer","value":"<decimal-string>"}
#   float64:    {"kind":"float64","bits":"<16-hex-IEEE754-bigendian>"}
#   symbol:     {"kind":"symbol","name":"..."}
#   list:       {"kind":"list","items":[...]}
#   record:     {"kind":"record","fields":{...}}
#   expression: {"kind":"expression","head":"...","args":[...]}
#
# Number-bearing fields are always strings (no raw JSON numbers).
# We build Value trees by hand here so f/grad expressions read like math.


def f64(x: float) -> dict:
    """Encode a Python float as a workbench float64 Value."""
    if math.isnan(x):
        bits = struct.unpack(">Q", struct.pack(">d", x))[0]
    else:
        bits = struct.unpack(">Q", struct.pack(">d", float(x)))[0]
    return {"kind": "float64", "bits": f"{bits:016x}"}


def i(n: int) -> dict:
    """Encode a Python int as a workbench integer Value."""
    return {"kind": "integer", "value": str(n)}


def sym(name: str) -> dict:
    return {"kind": "symbol", "name": name}


def E(head: str, *args) -> dict:
    """Build an expression Value: E('+', x, y) → x + y."""
    return {"kind": "expression", "head": head, "args": list(args)}


def neg(x: dict) -> dict:
    return E("neg", x)


def add(*xs) -> dict:
    if len(xs) == 1:
        return xs[0]
    return E("+", *xs)


def sub(a: dict, b: dict) -> dict:
    return E("-", a, b)


def mul(*xs) -> dict:
    if len(xs) == 1:
        return xs[0]
    return E("*", *xs)


def div(a: dict, b: dict) -> dict:
    return E("/", a, b)


def pow_(base: dict, exp_: dict) -> dict:
    return E("^", base, exp_)


def exp_(x: dict) -> dict:
    return E("exp", x)


def cos_(x: dict) -> dict:
    return E("cos", x)


def sin_(x: dict) -> dict:
    return E("sin", x)


def lst(*xs) -> dict:
    return {"kind": "list", "items": list(xs)}


def rec(**fields) -> dict:
    # Sort keys for canonical encoding.
    return {"kind": "record", "fields": {k: fields[k] for k in sorted(fields)}}


# =============================================================================
# Test corpus
# =============================================================================
#
# Each Case carries:
#   id, description, category, kind ("value" | "refusal")
#   vars: list of Python variable names matching the f/grad expressions
#   x0: list of starting-point floats
#   bounds: list of (lo, hi) tuples; None component → ±Inf
#   f_py(x) -> float    : callable for scipy
#   grad_py(x) -> ndarray : callable for scipy
#   f_expr  : Value-JSON encoding of f as a closed-vocabulary expression
#   grad_expr_list : list[Value-JSON], one per variable, in order
#   options?: scipy options dict (maxiter, ftol, gtol, ...)
#   analytic_optimum?: {"x": [...], "f": ...} if literature-known
#   expected_refusal_class?: tag suffix for refusal cases
#
# The closed vocabulary admitted by the tool's expression evaluator (mirrors
# integrate-1d's): + - * / ^ neg exp sin cos tan log sqrt abs, plus integer
# and float64 leaves and the symbol leaves matching `vars`.
#
# Vocabulary discipline: every f and every grad component is built from
# helpers above. No raw JSON, no Python-only constructs leaking in.

INF = float("inf")


# -----------------------------------------------------------------------------
# Helpers for common test functions (Python side and Value side)
# -----------------------------------------------------------------------------

def square(v: dict) -> dict:
    """v^2 in expression form."""
    return pow_(v, i(2))


def quartic(v: dict) -> dict:
    """v^4 in expression form."""
    return pow_(v, i(4))


# -----------------------------------------------------------------------------
# Case definitions
# -----------------------------------------------------------------------------

CASES = []


def add_case(case):
    CASES.append(case)


# ─────────────────────────────────────────────────────────────────────────────
# Tier A — smooth-easy: convex quadratics, clean optima
# ─────────────────────────────────────────────────────────────────────────────

# A1: f(x) = (x - 3)^2, optimum at x=3, f*=0
add_case({
    "id": "A1-quadratic-1d",
    "description": "(x - 3)^2 — simplest possible convex quadratic",
    "category": "smooth-easy",
    "kind": "value",
    "vars": ["x"],
    "x0": [0.0],
    "bounds": [(None, None)],
    "f_py": lambda x: (x[0] - 3.0) ** 2,
    "grad_py": lambda x: np.array([2.0 * (x[0] - 3.0)]),
    "f_expr": square(sub(sym("x"), i(3))),
    "grad_expr_list": [mul(i(2), sub(sym("x"), i(3)))],
    "analytic_optimum": {"x": [3.0], "f": 0.0},
})

# A2: sphere 2D
add_case({
    "id": "A2-sphere-2d",
    "description": "x^2 + y^2 — 2D sphere, optimum at origin",
    "category": "smooth-easy",
    "kind": "value",
    "vars": ["x", "y"],
    "x0": [1.5, -2.0],
    "bounds": [(None, None), (None, None)],
    "f_py": lambda v: v[0] ** 2 + v[1] ** 2,
    "grad_py": lambda v: np.array([2.0 * v[0], 2.0 * v[1]]),
    "f_expr": add(square(sym("x")), square(sym("y"))),
    "grad_expr_list": [mul(i(2), sym("x")), mul(i(2), sym("y"))],
    "analytic_optimum": {"x": [0.0, 0.0], "f": 0.0},
})

# A3: sphere 5D
add_case({
    "id": "A3-sphere-5d",
    "description": "sum(xi^2) for i=1..5 — 5D sphere",
    "category": "smooth-easy",
    "kind": "value",
    "vars": [f"x{k}" for k in range(5)],
    "x0": [1.0, 2.0, -1.5, 0.7, -3.2],
    "bounds": [(None, None)] * 5,
    "f_py": lambda v: float(np.sum(np.asarray(v) ** 2)),
    "grad_py": lambda v: 2.0 * np.asarray(v),
    "f_expr": add(*[square(sym(f"x{k}")) for k in range(5)]),
    "grad_expr_list": [mul(i(2), sym(f"x{k}")) for k in range(5)],
    "analytic_optimum": {"x": [0.0] * 5, "f": 0.0},
})

# A4: diagonal quadratic 3D — well-conditioned, distinct curvatures
add_case({
    "id": "A4-diagonal-quadratic-3d",
    "description": "x^2 + 2 y^2 + 3 z^2 — diagonal quadratic, distinct eigenvalues",
    "category": "smooth-easy",
    "kind": "value",
    "vars": ["x", "y", "z"],
    "x0": [2.0, 2.0, 2.0],
    "bounds": [(None, None)] * 3,
    "f_py": lambda v: v[0] ** 2 + 2.0 * v[1] ** 2 + 3.0 * v[2] ** 2,
    "grad_py": lambda v: np.array([2.0 * v[0], 4.0 * v[1], 6.0 * v[2]]),
    "f_expr": add(
        square(sym("x")),
        mul(i(2), square(sym("y"))),
        mul(i(3), square(sym("z"))),
    ),
    "grad_expr_list": [
        mul(i(2), sym("x")),
        mul(i(4), sym("y")),
        mul(i(6), sym("z")),
    ],
    "analytic_optimum": {"x": [0.0, 0.0, 0.0], "f": 0.0},
})

# ─────────────────────────────────────────────────────────────────────────────
# Tier B — canonical unconstrained (Moré-Garbow-Hillstrom 1981 classics)
# ─────────────────────────────────────────────────────────────────────────────

# B1: Rosenbrock 2D — the canonical valley problem
# f = 100(x1 - x0^2)^2 + (1 - x0)^2
# ∂f/∂x0 = -400 x0 (x1 - x0^2) - 2 (1 - x0)
# ∂f/∂x1 =  200    (x1 - x0^2)
add_case({
    "id": "B1-rosenbrock-2d",
    "description": "Rosenbrock 2D from canonical x0=(-1.2, 1.0); MGH #1",
    "category": "canonical",
    "kind": "value",
    "vars": ["x0", "x1"],
    "x0": [-1.2, 1.0],
    "bounds": [(None, None), (None, None)],
    "f_py": lambda v: 100.0 * (v[1] - v[0] ** 2) ** 2 + (1.0 - v[0]) ** 2,
    "grad_py": lambda v: np.array([
        -400.0 * v[0] * (v[1] - v[0] ** 2) - 2.0 * (1.0 - v[0]),
         200.0 * (v[1] - v[0] ** 2),
    ]),
    "f_expr": add(
        mul(i(100), square(sub(sym("x1"), square(sym("x0"))))),
        square(sub(i(1), sym("x0"))),
    ),
    "grad_expr_list": [
        # -400 x0 (x1 - x0^2) - 2 (1 - x0)
        sub(
            mul(i(-400), sym("x0"), sub(sym("x1"), square(sym("x0")))),
            mul(i(2), sub(i(1), sym("x0"))),
        ),
        # 200 (x1 - x0^2)
        mul(i(200), sub(sym("x1"), square(sym("x0")))),
    ],
    "analytic_optimum": {"x": [1.0, 1.0], "f": 0.0},
})

# B2: Rosenbrock 10D (chained)
# f = sum_{i=0}^{n-2} [ 100 (x_{i+1} - x_i^2)^2 + (1 - x_i)^2 ]
def _rosen_chain_n(n):
    def f(v):
        s = 0.0
        for k in range(n - 1):
            s += 100.0 * (v[k + 1] - v[k] ** 2) ** 2 + (1.0 - v[k]) ** 2
        return s
    def g(v):
        out = np.zeros(n)
        for k in range(n - 1):
            t = v[k + 1] - v[k] ** 2
            out[k]     += -400.0 * v[k] * t - 2.0 * (1.0 - v[k])
            out[k + 1] +=  200.0 * t
        return out
    return f, g

f10, g10 = _rosen_chain_n(10)
def _rosen_chain_expr(n):
    """Chained Rosenbrock as Value expression."""
    terms = []
    for k in range(n - 1):
        x_k = sym(f"x{k}")
        x_kp1 = sym(f"x{k + 1}")
        terms.append(mul(i(100), square(sub(x_kp1, square(x_k)))))
        terms.append(square(sub(i(1), x_k)))
    return add(*terms)

def _rosen_chain_grad_expr(n):
    """Gradient of chained Rosenbrock as list of Value expressions, per variable."""
    grads = [None] * n
    # Initialise as zeros
    for k in range(n):
        grads[k] = i(0)
    # Each term contributes to two variables
    for k in range(n - 1):
        x_k = sym(f"x{k}")
        x_kp1 = sym(f"x{k + 1}")
        t = sub(x_kp1, square(x_k))                 # (x_{k+1} - x_k^2)
        # d/dx_k:   -400 x_k t - 2 (1 - x_k)
        contrib_k = sub(mul(i(-400), x_k, t), mul(i(2), sub(i(1), x_k)))
        # d/dx_{k+1}: +200 t
        contrib_kp1 = mul(i(200), t)
        grads[k]     = grads[k]     if grads[k]     != i(0) else None
        grads[k + 1] = grads[k + 1] if grads[k + 1] != i(0) else None
        grads[k]     = contrib_k if grads[k]     is None else add(grads[k],     contrib_k)
        grads[k + 1] = contrib_kp1 if grads[k + 1] is None else add(grads[k + 1], contrib_kp1)
    # Replace any still-None (impossible) with zero
    return [g if g is not None else i(0) for g in grads]

x0_10 = [-1.2 if k % 2 == 0 else 1.0 for k in range(10)]
add_case({
    "id": "B2-rosenbrock-10d",
    "description": "Chained Rosenbrock n=10, x0 alternates (-1.2, 1.0)",
    "category": "canonical",
    "kind": "value",
    "vars": [f"x{k}" for k in range(10)],
    "x0": x0_10,
    "bounds": [(None, None)] * 10,
    "f_py": f10,
    "grad_py": g10,
    "f_expr": _rosen_chain_expr(10),
    "grad_expr_list": _rosen_chain_grad_expr(10),
    "analytic_optimum": {"x": [1.0] * 10, "f": 0.0},
})

# B3: Powell singular 4D — MGH #13
# f = (x0 + 10*x1)^2 + 5*(x2 - x3)^2 + (x1 - 2*x2)^4 + 10*(x0 - x3)^4
# Optimum at (0,0,0,0), f*=0; Hessian is singular at the optimum
add_case({
    "id": "B3-powell-singular-4d",
    "description": "Powell singular 4D, MGH #13 — Hessian rank-deficient at optimum",
    "category": "canonical",
    "kind": "value",
    "vars": ["x0", "x1", "x2", "x3"],
    "x0": [3.0, -1.0, 0.0, 1.0],
    "bounds": [(None, None)] * 4,
    "f_py": lambda v: (
        (v[0] + 10.0 * v[1]) ** 2
        + 5.0 * (v[2] - v[3]) ** 2
        + (v[1] - 2.0 * v[2]) ** 4
        + 10.0 * (v[0] - v[3]) ** 4
    ),
    "grad_py": lambda v: np.array([
        2.0 * (v[0] + 10.0 * v[1]) + 40.0 * (v[0] - v[3]) ** 3,
        20.0 * (v[0] + 10.0 * v[1]) + 4.0 * (v[1] - 2.0 * v[2]) ** 3,
        10.0 * (v[2] - v[3]) - 8.0 * (v[1] - 2.0 * v[2]) ** 3,
        -10.0 * (v[2] - v[3]) - 40.0 * (v[0] - v[3]) ** 3,
    ]),
    "f_expr": add(
        square(add(sym("x0"), mul(i(10), sym("x1")))),
        mul(i(5), square(sub(sym("x2"), sym("x3")))),
        quartic(sub(sym("x1"), mul(i(2), sym("x2")))),
        mul(i(10), quartic(sub(sym("x0"), sym("x3")))),
    ),
    "grad_expr_list": [
        # 2 (x0 + 10 x1) + 40 (x0 - x3)^3
        add(mul(i(2), add(sym("x0"), mul(i(10), sym("x1")))),
            mul(i(40), pow_(sub(sym("x0"), sym("x3")), i(3)))),
        # 20 (x0 + 10 x1) + 4 (x1 - 2 x2)^3
        add(mul(i(20), add(sym("x0"), mul(i(10), sym("x1")))),
            mul(i(4), pow_(sub(sym("x1"), mul(i(2), sym("x2"))), i(3)))),
        # 10 (x2 - x3) - 8 (x1 - 2 x2)^3
        sub(mul(i(10), sub(sym("x2"), sym("x3"))),
            mul(i(8), pow_(sub(sym("x1"), mul(i(2), sym("x2"))), i(3)))),
        # -10 (x2 - x3) - 40 (x0 - x3)^3
        sub(mul(i(-10), sub(sym("x2"), sym("x3"))),
            mul(i(40), pow_(sub(sym("x0"), sym("x3")), i(3)))),
    ],
    "analytic_optimum": {"x": [0.0, 0.0, 0.0, 0.0], "f": 0.0},
})

# B4: Beale 2D — MGH #5
# f = (1.5 - x + x*y)^2 + (2.25 - x + x*y^2)^2 + (2.625 - x + x*y^3)^2
# Optimum at (3, 0.5), f*=0
add_case({
    "id": "B4-beale-2d",
    "description": "Beale function 2D — three-term sum-of-squares; MGH #5",
    "category": "canonical",
    "kind": "value",
    "vars": ["x", "y"],
    "x0": [1.0, 1.0],
    "bounds": [(None, None), (None, None)],
    "f_py": lambda v: (
        (1.5   - v[0] + v[0] * v[1])      ** 2
        + (2.25  - v[0] + v[0] * v[1] ** 2) ** 2
        + (2.625 - v[0] + v[0] * v[1] ** 3) ** 2
    ),
    "grad_py": lambda v: np.array([
        # ∂/∂x: 2*(1.5-x+x*y)(y-1) + 2*(2.25-x+x*y^2)(y^2-1) + 2*(2.625-x+x*y^3)(y^3-1)
        2.0 * (1.5   - v[0] + v[0] * v[1])      * (v[1]      - 1.0)
        + 2.0 * (2.25  - v[0] + v[0] * v[1] ** 2) * (v[1] ** 2 - 1.0)
        + 2.0 * (2.625 - v[0] + v[0] * v[1] ** 3) * (v[1] ** 3 - 1.0),
        # ∂/∂y: 2*(1.5-x+x*y)*x + 2*(2.25-x+x*y^2)*(2 x y) + 2*(2.625-x+x*y^3)*(3 x y^2)
        2.0 * (1.5   - v[0] + v[0] * v[1])      * v[0]
        + 2.0 * (2.25  - v[0] + v[0] * v[1] ** 2) * (2.0 * v[0] * v[1])
        + 2.0 * (2.625 - v[0] + v[0] * v[1] ** 3) * (3.0 * v[0] * v[1] ** 2),
    ]),
    "f_expr": add(
        square(add(f64(1.5),   neg(sym("x")), mul(sym("x"), sym("y")))),
        square(add(f64(2.25),  neg(sym("x")), mul(sym("x"), square(sym("y"))))),
        square(add(f64(2.625), neg(sym("x")), mul(sym("x"), pow_(sym("y"), i(3))))),
    ),
    "grad_expr_list": [
        # ∂/∂x
        add(
            mul(i(2), add(f64(1.5),   neg(sym("x")), mul(sym("x"), sym("y"))),       sub(sym("y"), i(1))),
            mul(i(2), add(f64(2.25),  neg(sym("x")), mul(sym("x"), square(sym("y")))), sub(square(sym("y")), i(1))),
            mul(i(2), add(f64(2.625), neg(sym("x")), mul(sym("x"), pow_(sym("y"), i(3)))), sub(pow_(sym("y"), i(3)), i(1))),
        ),
        # ∂/∂y
        add(
            mul(i(2), add(f64(1.5),   neg(sym("x")), mul(sym("x"), sym("y"))),       sym("x")),
            mul(i(2), add(f64(2.25),  neg(sym("x")), mul(sym("x"), square(sym("y")))), mul(i(2), sym("x"), sym("y"))),
            mul(i(2), add(f64(2.625), neg(sym("x")), mul(sym("x"), pow_(sym("y"), i(3)))), mul(i(3), sym("x"), square(sym("y")))),
        ),
    ],
    "analytic_optimum": {"x": [3.0, 0.5], "f": 0.0},
})

# B5: Booth 2D — simple bowl, optimum at (1, 3)
# f = (x + 2y - 7)^2 + (2x + y - 5)^2
add_case({
    "id": "B5-booth-2d",
    "description": "Booth function 2D — simple sum-of-squares, optimum (1,3)",
    "category": "canonical",
    "kind": "value",
    "vars": ["x", "y"],
    "x0": [0.0, 0.0],
    "bounds": [(None, None), (None, None)],
    "f_py": lambda v: (v[0] + 2.0 * v[1] - 7.0) ** 2 + (2.0 * v[0] + v[1] - 5.0) ** 2,
    "grad_py": lambda v: np.array([
        2.0 * (v[0] + 2.0 * v[1] - 7.0) + 4.0 * (2.0 * v[0] + v[1] - 5.0),
        4.0 * (v[0] + 2.0 * v[1] - 7.0) + 2.0 * (2.0 * v[0] + v[1] - 5.0),
    ]),
    "f_expr": add(
        square(add(sym("x"), mul(i(2), sym("y")), i(-7))),
        square(add(mul(i(2), sym("x")), sym("y"), i(-5))),
    ),
    "grad_expr_list": [
        add(mul(i(2), add(sym("x"), mul(i(2), sym("y")), i(-7))),
            mul(i(4), add(mul(i(2), sym("x")), sym("y"), i(-5)))),
        add(mul(i(4), add(sym("x"), mul(i(2), sym("y")), i(-7))),
            mul(i(2), add(mul(i(2), sym("x")), sym("y"), i(-5)))),
    ],
    "analytic_optimum": {"x": [1.0, 3.0], "f": 0.0},
})

# ─────────────────────────────────────────────────────────────────────────────
# Tier C — active-set / bound-constrained
# ─────────────────────────────────────────────────────────────────────────────

# C1: Quadratic with optimum forced into a corner
# f = (x - 3)^2 + (y - 3)^2, bounds [-1, 1]^2, optimum at corner (1, 1), f* = 8
add_case({
    "id": "C1-bounded-corner-quadratic",
    "description": "(x-3)^2 + (y-3)^2 with bounds [-1,1]^2 — optimum at corner (1,1), both bounds active",
    "category": "active-set",
    "kind": "value",
    "vars": ["x", "y"],
    "x0": [0.0, 0.0],
    "bounds": [(-1.0, 1.0), (-1.0, 1.0)],
    "f_py": lambda v: (v[0] - 3.0) ** 2 + (v[1] - 3.0) ** 2,
    "grad_py": lambda v: np.array([2.0 * (v[0] - 3.0), 2.0 * (v[1] - 3.0)]),
    "f_expr": add(square(sub(sym("x"), i(3))), square(sub(sym("y"), i(3)))),
    "grad_expr_list": [
        mul(i(2), sub(sym("x"), i(3))),
        mul(i(2), sub(sym("y"), i(3))),
    ],
    "analytic_optimum": {"x": [1.0, 1.0], "f": 8.0},
})

# C2: Starting point ON the bound. f = (x - 1)^2, bound x >= 2, x0 = 2.
# Unconstrained optimum is x=1 but bound forces x=2. x0=2 means the projected
# gradient at x0 is zero (active constraint with grad pointing into bound) so
# the algorithm must report immediate convergence at x=2 with f*=1.
add_case({
    "id": "C2-x0-at-bound",
    "description": "(x-1)^2 with bound x >= 2, x0=2 — must immediately recognise active constraint",
    "category": "active-set",
    "kind": "value",
    "vars": ["x"],
    "x0": [2.0],
    "bounds": [(2.0, None)],
    "f_py": lambda v: (v[0] - 1.0) ** 2,
    "grad_py": lambda v: np.array([2.0 * (v[0] - 1.0)]),
    "f_expr": square(sub(sym("x"), i(1))),
    "grad_expr_list": [mul(i(2), sub(sym("x"), i(1)))],
    "analytic_optimum": {"x": [2.0], "f": 1.0},
})

# C3: HS01 — Rosenbrock with x[1] >= -1.5
# Optimum at (1, 1) interior to bound.
add_case({
    "id": "C3-hs01-rosenbrock-bounded",
    "description": "Hock-Schittkowski #1 — Rosenbrock with x1 >= -1.5; optimum interior",
    "category": "active-set",
    "kind": "value",
    "vars": ["x0", "x1"],
    "x0": [-2.0, 1.0],
    "bounds": [(None, None), (-1.5, None)],
    "f_py": lambda v: 100.0 * (v[1] - v[0] ** 2) ** 2 + (1.0 - v[0]) ** 2,
    "grad_py": lambda v: np.array([
        -400.0 * v[0] * (v[1] - v[0] ** 2) - 2.0 * (1.0 - v[0]),
         200.0 * (v[1] - v[0] ** 2),
    ]),
    "f_expr": add(
        mul(i(100), square(sub(sym("x1"), square(sym("x0"))))),
        square(sub(i(1), sym("x0"))),
    ),
    "grad_expr_list": [
        sub(mul(i(-400), sym("x0"), sub(sym("x1"), square(sym("x0")))),
            mul(i(2), sub(i(1), sym("x0")))),
        mul(i(200), sub(sym("x1"), square(sym("x0")))),
    ],
    "analytic_optimum": {"x": [1.0, 1.0], "f": 0.0},
})

# C4: Multiple bounds active at optimum
# f = (x - 5)^2 + (y + 5)^2 + (z - 0.5)^2,  bounds [-1,1]^3
# Optimum: x=1, y=-1, z=0.5; two bounds active, one interior.
add_case({
    "id": "C4-multi-bound-active",
    "description": "Three-axis quadratic; two bounds active at optimum, one interior",
    "category": "active-set",
    "kind": "value",
    "vars": ["x", "y", "z"],
    "x0": [0.0, 0.0, 0.0],
    "bounds": [(-1.0, 1.0), (-1.0, 1.0), (-1.0, 1.0)],
    "f_py": lambda v: (v[0] - 5.0) ** 2 + (v[1] + 5.0) ** 2 + (v[2] - 0.5) ** 2,
    "grad_py": lambda v: np.array([
        2.0 * (v[0] - 5.0),
        2.0 * (v[1] + 5.0),
        2.0 * (v[2] - 0.5),
    ]),
    "f_expr": add(
        square(sub(sym("x"), i(5))),
        square(add(sym("y"), i(5))),
        square(sub(sym("z"), f64(0.5))),
    ),
    "grad_expr_list": [
        mul(i(2), sub(sym("x"), i(5))),
        mul(i(2), add(sym("y"), i(5))),
        mul(i(2), sub(sym("z"), f64(0.5))),
    ],
    "analytic_optimum": {"x": [1.0, -1.0, 0.5], "f": 16.0 + 36.0 + 0.0},
})

# ─────────────────────────────────────────────────────────────────────────────
# Tier D — ill-conditioned
# ─────────────────────────────────────────────────────────────────────────────

# D1: Hilbert quadratic, n=6
# f = x^T H x where H[i,j] = 1/(i+j+1). cond(H) ~ 1.5e7 for n=6.
# Bounded [-1,1]^6 → optimum at origin, f*=0.
def _hilbert_quadratic_case(n: int, case_id: str, desc: str, cond_str: str):
    H = np.array([[1.0 / (i_ + j_ + 1) for j_ in range(n)] for i_ in range(n)])
    def f(v):
        v = np.asarray(v)
        return float(v @ H @ v)
    def g(v):
        v = np.asarray(v)
        return 2.0 * (H @ v)
    # f as expression: sum_{i,j} H[i,j] * x_i * x_j
    f_terms = []
    for ii in range(n):
        for jj in range(n):
            denom = ii + jj + 1
            coef = f64(1.0 / denom)
            f_terms.append(mul(coef, sym(f"x{ii}"), sym(f"x{jj}")))
    f_expr = add(*f_terms)
    # ∂/∂x_k = 2 sum_j H[k,j] x_j
    grads = []
    for k in range(n):
        terms = []
        for jj in range(n):
            denom = k + jj + 1
            coef = f64(2.0 / denom)
            terms.append(mul(coef, sym(f"x{jj}")))
        grads.append(add(*terms))
    return {
        "id": case_id,
        "description": desc,
        "category": "ill-conditioned",
        "kind": "value",
        "vars": [f"x{k}" for k in range(n)],
        "x0": [1.0] * n,
        "bounds": [(-1.0, 1.0)] * n,
        "f_py": f,
        "grad_py": g,
        "f_expr": f_expr,
        "grad_expr_list": grads,
        "analytic_optimum": {"x": [0.0] * n, "f": 0.0,
                              "note": f"H is Hilbert(n={n}); cond(H) ≈ {cond_str}"},
    }

add_case(_hilbert_quadratic_case(6, "D1-hilbert-quadratic-6",
    "Quadratic x^T H x with H = Hilbert(6); cond ~ 1.5e7", "1.5e7"))
add_case(_hilbert_quadratic_case(8, "D2-hilbert-quadratic-8",
    "Quadratic x^T H x with H = Hilbert(8); cond ~ 1.5e10", "1.5e10"))

# D3: Powell badly scaled — MGH #3
# f1 = 1e4 * x[0] * x[1] - 1
# f2 = exp(-x[0]) + exp(-x[1]) - 1.0001
# f = f1^2 + f2^2; optimum near (1.098e-5, 9.106) f*=0
add_case({
    "id": "D3-powell-badly-scaled",
    "description": "Powell badly scaled (MGH #3) — scale mismatch ~1e9 between variables",
    "category": "ill-conditioned",
    "kind": "value",
    "vars": ["x0", "x1"],
    "x0": [0.0, 1.0],
    "bounds": [(None, None), (None, None)],
    "f_py": lambda v: (
        (1.0e4 * v[0] * v[1] - 1.0) ** 2
        + (math.exp(-v[0]) + math.exp(-v[1]) - 1.0001) ** 2
    ),
    "grad_py": lambda v: np.array([
        2.0 * (1.0e4 * v[0] * v[1] - 1.0) * (1.0e4 * v[1])
        + 2.0 * (math.exp(-v[0]) + math.exp(-v[1]) - 1.0001) * (-math.exp(-v[0])),
        2.0 * (1.0e4 * v[0] * v[1] - 1.0) * (1.0e4 * v[0])
        + 2.0 * (math.exp(-v[0]) + math.exp(-v[1]) - 1.0001) * (-math.exp(-v[1])),
    ]),
    "f_expr": add(
        square(sub(mul(f64(1e4), sym("x0"), sym("x1")), i(1))),
        square(add(exp_(neg(sym("x0"))), exp_(neg(sym("x1"))), f64(-1.0001))),
    ),
    "grad_expr_list": [
        # ∂/∂x0 = 2*(1e4*x0*x1 - 1)*(1e4*x1) - 2*(exp(-x0)+exp(-x1)-1.0001)*exp(-x0)
        sub(
            mul(i(2), sub(mul(f64(1e4), sym("x0"), sym("x1")), i(1)), mul(f64(1e4), sym("x1"))),
            mul(i(2), add(exp_(neg(sym("x0"))), exp_(neg(sym("x1"))), f64(-1.0001)), exp_(neg(sym("x0")))),
        ),
        # ∂/∂x1 = 2*(1e4*x0*x1 - 1)*(1e4*x0) - 2*(exp(-x0)+exp(-x1)-1.0001)*exp(-x1)
        sub(
            mul(i(2), sub(mul(f64(1e4), sym("x0"), sym("x1")), i(1)), mul(f64(1e4), sym("x0"))),
            mul(i(2), add(exp_(neg(sym("x0"))), exp_(neg(sym("x1"))), f64(-1.0001)), exp_(neg(sym("x1")))),
        ),
    ],
    # No analytic optimum — let scipy find it; we'll record the result and the grad norm.
})

# ─────────────────────────────────────────────────────────────────────────────
# Tier E — convergence-honesty discriminators
# ─────────────────────────────────────────────────────────────────────────────

# E1: maxiter=1 on Rosenbrock from far x0. Gradient at x0 is large; the algorithm
# CANNOT have converged in one iteration. Honest implementations report success=False
# and status=1 ("max iterations reached"). A buggy implementation that returns
# success=True after one step is what this case detects.
add_case({
    "id": "E1-budget-1-rosenbrock",
    "description": "Rosenbrock 2D with maxiter=1 and grad large at x0 — must report not-converged",
    "category": "convergence-honesty",
    "kind": "value",
    "vars": ["x0", "x1"],
    "x0": [-1.2, 1.0],
    "bounds": [(None, None), (None, None)],
    "f_py": lambda v: 100.0 * (v[1] - v[0] ** 2) ** 2 + (1.0 - v[0]) ** 2,
    "grad_py": lambda v: np.array([
        -400.0 * v[0] * (v[1] - v[0] ** 2) - 2.0 * (1.0 - v[0]),
         200.0 * (v[1] - v[0] ** 2),
    ]),
    "f_expr": add(
        mul(i(100), square(sub(sym("x1"), square(sym("x0"))))),
        square(sub(i(1), sym("x0"))),
    ),
    "grad_expr_list": [
        sub(mul(i(-400), sym("x0"), sub(sym("x1"), square(sym("x0")))),
            mul(i(2), sub(i(1), sym("x0")))),
        mul(i(200), sub(sym("x1"), square(sym("x0")))),
    ],
    "options": {"maxiter": 1},
    "expected_success": False,
    "expected_status_class": "max-iter",
})

# E2: budget=1 BUT x0 is already very close to the unconstrained optimum.
# Here it IS legitimate to terminate at iteration 0 because the gradient is
# already below gtol. Honest behaviour: success=True, status=0.
# f = x^2, x0 = 1e-9 → grad = 2e-9 < gtol=1e-5. Should converge immediately.
add_case({
    "id": "E2-budget-1-already-converged",
    "description": "x^2 with x0=1e-9; grad already below gtol — legitimate immediate convergence",
    "category": "convergence-honesty",
    "kind": "value",
    "vars": ["x"],
    "x0": [1.0e-9],
    "bounds": [(None, None)],
    "f_py": lambda v: v[0] ** 2,
    "grad_py": lambda v: np.array([2.0 * v[0]]),
    "f_expr": square(sym("x")),
    "grad_expr_list": [mul(i(2), sym("x"))],
    "options": {"maxiter": 1},
    "expected_success": True,
})

# E3: maxiter=3 on Rosenbrock — should make progress but not reach optimum
add_case({
    "id": "E3-budget-3-rosenbrock",
    "description": "Rosenbrock 2D, maxiter=3 — partial progress; honest not-converged",
    "category": "convergence-honesty",
    "kind": "value",
    "vars": ["x0", "x1"],
    "x0": [-1.2, 1.0],
    "bounds": [(None, None), (None, None)],
    "f_py": lambda v: 100.0 * (v[1] - v[0] ** 2) ** 2 + (1.0 - v[0]) ** 2,
    "grad_py": lambda v: np.array([
        -400.0 * v[0] * (v[1] - v[0] ** 2) - 2.0 * (1.0 - v[0]),
         200.0 * (v[1] - v[0] ** 2),
    ]),
    "f_expr": add(
        mul(i(100), square(sub(sym("x1"), square(sym("x0"))))),
        square(sub(i(1), sym("x0"))),
    ),
    "grad_expr_list": [
        sub(mul(i(-400), sym("x0"), sub(sym("x1"), square(sym("x0")))),
            mul(i(2), sub(i(1), sym("x0")))),
        mul(i(200), sub(sym("x1"), square(sym("x0")))),
    ],
    "options": {"maxiter": 3},
    "expected_success": False,
})

# ─────────────────────────────────────────────────────────────────────────────
# Tier F — boundary refusals (no scipy run)
# ─────────────────────────────────────────────────────────────────────────────

# F1: lower > upper in some dimension — infeasible bounds
add_case({
    "id": "F1-infeasible-bounds",
    "description": "lower > upper for x — must reject as infeasible",
    "category": "refusal",
    "kind": "refusal",
    "vars": ["x"],
    "x0": [0.0],
    "bounds": [(2.0, 1.0)],
    "f_expr": square(sym("x")),
    "grad_expr_list": [mul(i(2), sym("x"))],
    "expected_refusal_class": "infeasible-bounds",
})

# F2: x0 dimension does not match vars
add_case({
    "id": "F2-dimension-mismatch",
    "description": "x0 length != vars length",
    "category": "refusal",
    "kind": "refusal",
    "vars": ["x", "y"],
    "x0": [0.0],
    "bounds": [(None, None), (None, None)],
    "f_expr": add(square(sym("x")), square(sym("y"))),
    "grad_expr_list": [mul(i(2), sym("x")), mul(i(2), sym("y"))],
    "expected_refusal_class": "ToolError",
})

# F3: NaN in x0 — malformed input
add_case({
    "id": "F3-nan-in-x0",
    "description": "NaN in x0 — malformed input, ToolError",
    "category": "refusal",
    "kind": "refusal",
    "vars": ["x"],
    "x0": [float("nan")],
    "bounds": [(None, None)],
    "f_expr": square(sym("x")),
    "grad_expr_list": [mul(i(2), sym("x"))],
    "expected_refusal_class": "ToolError",
})

# F4: x0 outside bounds — infeasible starting point
add_case({
    "id": "F4-x0-outside-bounds",
    "description": "x0 outside declared bounds — infeasible starting point",
    "category": "refusal",
    "kind": "refusal",
    "vars": ["x"],
    "x0": [10.0],
    "bounds": [(-1.0, 1.0)],
    "f_expr": square(sym("x")),
    "grad_expr_list": [mul(i(2), sym("x"))],
    "expected_refusal_class": "x0-outside-bounds",
})

# ─────────────────────────────────────────────────────────────────────────────
# Tier G — speed/scale stress
# ─────────────────────────────────────────────────────────────────────────────

# G1: high-dim diagonal quadratic n=50
def _diag_quad_case(n: int, case_id: str, desc: str):
    # f = sum_i (x_i - i)^2 / (i+1)
    # Optimum: x_i = i, f* = 0 for unbounded; with [-5, 5] bounds on each xi,
    # for i > 5 the bound becomes active at x_i = 5.
    BOUND = 5.0
    coefs = [1.0 / (i_ + 1) for i_ in range(n)]

    def f(v):
        return sum(coefs[k] * (v[k] - k) ** 2 for k in range(n))

    def g(v):
        return np.array([2.0 * coefs[k] * (v[k] - k) for k in range(n)])

    f_expr = add(*[mul(f64(coefs[k]), square(sub(sym(f"x{k}"), i(k)))) for k in range(n)])
    grads = [mul(f64(2.0 * coefs[k]), sub(sym(f"x{k}"), i(k))) for k in range(n)]

    # Analytic optimum with bounds: x_i = min(i, BOUND); f* = sum where i > BOUND
    xstar = [min(float(k), BOUND) for k in range(n)]
    fstar = sum(coefs[k] * (xstar[k] - k) ** 2 for k in range(n))

    return {
        "id": case_id,
        "description": desc,
        "category": "speed-stress",
        "kind": "value",
        "vars": [f"x{k}" for k in range(n)],
        "x0": [0.0] * n,
        "bounds": [(-BOUND, BOUND)] * n,
        "f_py": f,
        "grad_py": g,
        "f_expr": f_expr,
        "grad_expr_list": grads,
        "analytic_optimum": {"x": xstar, "f": fstar},
    }

add_case(_diag_quad_case(50, "G1-diag-quadratic-50",
    "n=50 diagonal quadratic with mixed-active bounds, f*=sum_k>5 c_k (5-k)^2"))
add_case(_diag_quad_case(100, "G2-diag-quadratic-100",
    "n=100 diagonal quadratic with mixed-active bounds — speed/scale stress"))


# =============================================================================
# Helpers for serialising cases
# =============================================================================

def bounds_to_value(bounds: List[Tuple[Optional[float], Optional[float]]]) -> dict:
    """Encode a bounds list as a list of float64 pairs; None → ±Inf."""
    items = []
    for (lo, hi) in bounds:
        lo_v = f64(-INF) if lo is None else f64(lo)
        hi_v = f64( INF) if hi is None else f64(hi)
        items.append({"kind": "list", "items": [lo_v, hi_v]})
    return {"kind": "list", "items": items}


def x0_to_value(x0: List[float]) -> dict:
    return {"kind": "list", "items": [f64(v) for v in x0]}


def options_to_value(opts: Optional[dict]) -> Optional[dict]:
    if opts is None:
        return None
    fields = {}
    for k, v in opts.items():
        if isinstance(v, bool):
            fields[k] = {"kind": "boolean", "value": v}
        elif isinstance(v, int):
            fields[k] = i(v)
        elif isinstance(v, float):
            fields[k] = f64(v)
        else:
            raise ValueError(f"unsupported option type for {k}: {type(v)}")
    return {"kind": "record", "fields": {k: fields[k] for k in sorted(fields)}}


def vars_to_value(vars_: List[str]) -> dict:
    return {"kind": "list", "items": [sym(v) for v in vars_]}


def case_input_value(case: dict) -> dict:
    """Build the canonical Value-JSON for the tool's input record."""
    fields = {
        "f": case["f_expr"],
        "grad": {"kind": "list", "items": case["grad_expr_list"]},
        "vars": vars_to_value(case["vars"]),
        "x0": x0_to_value(case["x0"]),
        "bounds": bounds_to_value(case["bounds"]),
    }
    if "options" in case and case["options"] is not None:
        fields["options"] = options_to_value(case["options"])
    return {"kind": "record", "fields": {k: fields[k] for k in sorted(fields)}}


# =============================================================================
# Driver
# =============================================================================

# SciPy options. We expose all five tunable knobs but use defaults that
# match the Fortran v3.0 defaults exactly. Casewise overrides via "options"
# field in case dict (currently used for maxiter on the convergence-honesty
# discriminators).
DEFAULT_OPTIONS = {
    "maxcor": 10,
    "ftol": 2.220446049250313e-09,  # 1e7 * machine_eps
    "gtol": 1.0e-5,
    "maxiter": 15000,
    "maxfun": 15000,
    "maxls": 20,
}


def run_scipy(case: dict) -> dict:
    """Run scipy.optimize.minimize on a value case, return a serialisable result block."""
    options = dict(DEFAULT_OPTIONS)
    if "options" in case and case["options"] is not None:
        options.update(case["options"])

    # Prepare bounds for scipy: list of (lo, hi) pairs; None means ±Inf.
    sb = [(lo, hi) for (lo, hi) in case["bounds"]]

    x0 = np.asarray(case["x0"], dtype=float)
    res = minimize(
        case["f_py"],
        x0,
        jac=case["grad_py"],
        method="L-BFGS-B",
        bounds=sb,
        options=options,
    )

    # Compute gradient norms for honesty-of-self-report checks
    final_grad = np.asarray(res.jac, dtype=float)
    grad_inf = float(np.max(np.abs(final_grad))) if final_grad.size else 0.0
    grad_2 = float(np.linalg.norm(final_grad)) if final_grad.size else 0.0

    return {
        "x": [float(v) for v in res.x],
        "x_bits": [encode_float64_bits(float(v)) for v in res.x],
        "fun": float(res.fun),
        "fun_bits": encode_float64_bits(float(res.fun)),
        "jac": [float(v) for v in res.jac],
        "grad_inf_norm": grad_inf,
        "grad_2_norm": grad_2,
        "nit": int(res.nit),
        "nfev": int(res.nfev),
        "status": int(res.status),
        "message": str(res.message),
        "success": bool(res.success),
        "options_used": options,
    }


def encode_float64_bits(x: float) -> str:
    bits = struct.unpack(">Q", struct.pack(">d", float(x)))[0]
    return f"{bits:016x}"


def cross_validate_against_known_optimum(case: dict, scipy_res: dict) -> Optional[dict]:
    """If the case has an analytic_optimum, check scipy reached it within tolerance.
    Return a diagnostics block; if disagreement is severe, raise."""
    if "analytic_optimum" not in case:
        return None
    known = case["analytic_optimum"]
    expected_f = float(known["f"])
    actual_f = scipy_res["fun"]

    expected_x = np.asarray(known["x"], dtype=float)
    actual_x = np.asarray(scipy_res["x"], dtype=float)
    x_dist = float(np.linalg.norm(actual_x - expected_x))

    f_diff = abs(actual_f - expected_f)
    f_tol = max(1e-6, 1e-6 * max(1.0, abs(expected_f)))
    x_tol = 1e-3

    block = {
        "expected_f": expected_f,
        "actual_f": actual_f,
        "f_diff": f_diff,
        "f_within_tol": f_diff <= f_tol,
        "expected_x": [float(v) for v in expected_x],
        "actual_x": [float(v) for v in actual_x],
        "x_dist": x_dist,
        "x_within_tol": x_dist <= x_tol,
    }

    # Special case: convergence-honesty cases legitimately do NOT reach the optimum.
    if case["category"] == "convergence-honesty":
        return block

    if not (block["f_within_tol"] or block["x_within_tol"]):
        msg = (
            f"Cross-validation failure: case {case['id']} — scipy did not reach the "
            f"literature-known optimum within tolerance. expected_f={expected_f}, "
            f"actual_f={actual_f}, f_diff={f_diff}, expected_x={expected_x.tolist()}, "
            f"actual_x={actual_x.tolist()}, x_dist={x_dist}. "
            "Aborting manifest generation rather than committing a bad oracle."
        )
        raise RuntimeError(msg)

    return block


# Per-category tolerance recommendations: how close the candidate's reported
# value must be to the oracle's. These are looser than f_tol used in cross-
# validation because the candidate is independent and may converge along a
# different path.
TOLERANCE_RECOMMENDATION = {
    "smooth-easy":          {"atol": "1e-8",  "rtol": "1e-8"},
    "canonical":            {"atol": "1e-6",  "rtol": "1e-6"},
    "active-set":           {"atol": "1e-6",  "rtol": "1e-6"},
    "ill-conditioned":      {"atol": "1e-3",  "rtol": "1e-3",
                             "note": "ill-conditioned problems may converge to a flatter region"},
    "convergence-honesty":  {"atol": "0",     "rtol": "0",
                             "note": "compare success/status fields, not values"},
    "refusal":              {"atol": "0",     "rtol": "0",
                             "note": "no scipy run; tool must produce the expected refusal class"},
    "speed-stress":         {"atol": "1e-4",  "rtol": "1e-4",
                             "note": "active bounds dominate; loose tol on optimum"},
}


def main():
    manifest = {
        "_meta": {
            "tool": "optimize-lbfgs-projected",
            "reference": "scipy.optimize.minimize(method='L-BFGS-B') — Northwestern L-BFGS-B v3.0 (Morales-Nocedal 2011)",
            "scipy_version": scipy.__version__,
            "numpy_version": np.__version__,
            "scipy_pin_reason": (
                "scipy 1.14.x is the last version with the original Fortran v3.0 backend. "
                "scipy 1.15 ported to C and shipped a regression (scipy issue #23161) on Rosenbrock-class problems. "
                "Pin scipy==1.14.1 in the oracle venv for stable ground truth."
            ),
            "n_cases": len(CASES),
            "n_value_cases": sum(1 for c in CASES if c["kind"] == "value"),
            "n_refusal_cases": sum(1 for c in CASES if c["kind"] == "refusal"),
            "purpose": (
                "Orthogonal oracle for the TypeScript pure-TS L-BFGS-B implementation in tools/optimize-lbfgs-projected. "
                "The TS impl must produce values matching this manifest within the documented tolerance; "
                "it MUST NOT generate its own expected values."
            ),
            "tolerance_recommendation": TOLERANCE_RECOMMENDATION,
            "comparison_metrics": {
                "primary":   "|fun_cand - fun_ref| ≤ atol + rtol * max(1, |fun_ref|)",
                "secondary": "‖x_cand - x_ref‖_2 / max(1, ‖x_ref‖_2) ≤ 1e-3 (loose; iterative methods converge along different paths)",
                "tertiary":  "‖grad(x_cand)‖_∞ ≤ 10 * gtol (honest stopping criterion)",
                "iteration_counts": "nit/nfev are NOT compared (highly path-dependent)",
            },
            "default_options": DEFAULT_OPTIONS,
        },
        "cases": [],
    }

    for case in CASES:
        entry = {
            "id": case["id"],
            "description": case["description"],
            "category": case["category"],
            "kind": case["kind"],
            "vars": case["vars"],
            "n": len(case["vars"]),
            # The canonical wire-form input record — TS goldens.spec.ts and
            # the --test hook can ingest this directly.
            "input": case_input_value(case),
        }
        if "expected_refusal_class" in case:
            entry["expected_refusal_class"] = case["expected_refusal_class"]
        if "expected_success" in case:
            entry["expected_success"] = case["expected_success"]
        if "expected_status_class" in case:
            entry["expected_status_class"] = case["expected_status_class"]
        if "options" in case and case["options"] is not None:
            entry["case_options_override"] = case["options"]
        if "analytic_optimum" in case:
            entry["analytic_optimum"] = case["analytic_optimum"]

        if case["kind"] == "value":
            scipy_res = run_scipy(case)
            entry["scipy"] = scipy_res
            cv = cross_validate_against_known_optimum(case, scipy_res)
            if cv is not None:
                entry["cross_validation"] = cv

        manifest["cases"].append(entry)

    # Sort cases by id for stable output
    manifest["cases"].sort(key=lambda e: e["id"])

    json.dump(manifest, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
