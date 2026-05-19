#!/usr/bin/env python3
# =============================================================================
# bench/gamma-anchor/oracles/scipy/oracle.py — bronze-tier SciPy gamma oracle
# =============================================================================
#
# Bead: scientist-workbench-tqwc  (G4 of the gamma-anchor Phase 1 epic;
# ADR-0042 §"Decision 8"). Companion to the TS driver `adapter.ts` in the
# same directory. The driver feeds the corpus envelope on stdin; this
# script writes a single JSON document to stdout.
#
# Tier role: BRONZE (float64). Not arb-prec. The gold-tier values come
# from Wolfram (G2) and mpmath (G3); the silver tier (Boost.Math, G5)
# carries the independent arb-prec real third voice once headers are
# installed; SciPy is the workhorse bronze voice with the widest float64
# head coverage of any local oracle.
#
# ---------------------------------------------------------------------------
# What this oracle covers (per R5 §3.3 + §4 capability matrix)
# ---------------------------------------------------------------------------
#
# 17 of 19 corpus heads emit a numeric value when SciPy supports them:
#
#   Gamma                    — sp.gamma          (real + complex)
#   LogGamma                 — sp.loggamma       (real, with L15 +0j route for x<0)
#                                                 (complex)
#   Digamma                  — sp.digamma        (real + complex)
#   Trigamma                 — sp.polygamma(1,·) (real; complex refused, L14)
#   Polygamma                — sp.polygamma(m,·) (real; complex refused, L14)
#   Pochhammer               — sp.poch           (real)
#   IncompleteGammaUpper     — sp.gammaincc · Γ  (real; L12) — see below
#   IncompleteGammaLower     — sp.gammainc  · Γ  (real; L12)
#   IncompleteGammaP         — sp.gammainc       (real; L12)
#   IncompleteGammaQ         — sp.gammaincc      (real; L12)
#   InverseIncompleteGammaP  — sp.gammaincinv    (real; L13)
#   InverseIncompleteGammaQ  — sp.gammainccinv   (real; L13)
#   Beta                     — sp.beta           (real)
#   LogBeta                  — sp.betaln         (real; |B| magnitude only)
#   GammaRatio   Γ(a)/Γ(b)   — sp.poch(b, a-b) when (a-b) integer; else gamma()/gamma()
#   GammaDeltaRatio Γ(a)/Γ(a+b) — 1/sp.poch(a, b)
#   GammaPDerivative ∂P/∂z   — closed form  exp(-z)·z^(a-1)/Γ(a)   (DLMF §8.8.2)
#   IncompleteBeta I_z(a,b)  — sp.betainc       (real)  [REGULARISED — corpus
#                              labels it "IncompleteBeta" but the underlying
#                              SciPy primitive is the regularised I_z; the
#                              comparator grades against the corpus convention
#                              chosen for this head, which per R5 §3.3 is the
#                              regularised form because no oracle ships the
#                              unregularised closed-form independently]
#
# 2 of 19 heads are SciPy-unsupported (`status: "unsupported"`):
#
#   BarnesG                  — SciPy has no `barnesg` / `barnes_g`
#   (… and 16 cells of complex Polygamma / Trigamma / IncompleteGamma{U,L}
#    on the T4 complex tier are `status: "refused"` per L14.)
#
# ---------------------------------------------------------------------------
# L12 — incomplete-gamma regularisation convention (THE #1 trap)
# ---------------------------------------------------------------------------
#
# SciPy's spelling of P and Q is OPPOSITE to Wolfram and mpmath:
#
#   SciPy:   gammainc(a, z)   = P(a, z) = γ(a, z) / Γ(a)   ← LOWER regularised
#            gammaincc(a, z)  = Q(a, z) = Γ(a, z) / Γ(a)   ← UPPER regularised
#            gammaincinv(a,p) inverts P  (returns z so P(a,z) = p)
#            gammainccinv(a,q) inverts Q (returns z so Q(a,z) = q)
#
#   WOLFRAM: Gamma[a, z]               = Γ(a, z)   upper UNregularised
#            Gamma[a, 0, z]            = γ(a, z)   lower UNregularised
#            GammaRegularized[a, z]    = Q(a, z)
#            GammaRegularized[a, 0, z] = P(a, z)
#
#   MPMATH:  gammainc(a, z)            = Γ(a, z)   upper UNregularised
#            gammainc(a, 0, z)         = γ(a, z)   lower UNregularised
#            gammainc(a, z, regularized=True)    = Q(a, z)
#            gammainc(a, 0, z, regularized=True) = P(a, z)
#
# SciPy has NO raw unregularised primitive. We recover Upper and Lower by
# multiplying back by Γ(a):
#
#   IncompleteGammaUpper(a, z) = sp.gammaincc(a, z) · sp.gamma(a)   # = Q · Γ(a)
#   IncompleteGammaLower(a, z) = sp.gammainc(a, z)  · sp.gamma(a)   # = P · Γ(a)
#
# This is accuracy-bounded by the float64 precision of Γ(a) (≤ 2 ULP per R3
# §3.1 Cephes); for the corpus's a ∈ (0, 20] range the round-trip is honest
# to ≤ 3 ULP. EVERY line that touches gammainc / gammaincc carries an
# explicit `# L12` comment so a future reader cannot mistake the convention.
#
# ---------------------------------------------------------------------------
# L13 — inverse-incomplete-gamma convention (Wolfram inverts Q; SciPy splits)
# ---------------------------------------------------------------------------
#
# Wolfram `InverseGammaRegularized[a, q]` inverts Q. SciPy splits the inverse
# into two distinct functions — `gammaincinv` (inverts P, lower) and
# `gammainccinv` (inverts Q, upper). The corpus has TWO distinct heads
# `InverseIncompleteGammaP` and `InverseIncompleteGammaQ` so the comparator
# never has to disambiguate, but the call sites are still pinned with
# `# L13` so the convention is unmissable in code review.
#
# ---------------------------------------------------------------------------
# L14 — SciPy complex polygamma raises TypeError (refuse cleanly)
# ---------------------------------------------------------------------------
#
# `scipy.special.polygamma(m, complex)` raises:
#   TypeError: ufunc '_zeta' not supported for the input types, and the
#   inputs could not be safely coerced to any supported types according
#   to the casting rule 'safe'
# in 1.11.4 and 1.17.0 alike. This also affects `Trigamma` because the
# corpus's Trigamma rows route through `polygamma(1, z)`. There is no
# clean fallback in SciPy (no `_zeta` ufunc for complex). The honest
# bronze-tier answer is `status: "refused"` with token
# `"TypeError-complex-polygamma"`; the comparator graduates these cells
# to gold-only (Wolfram + mpmath) per ADR-0042 §Decision 8.
#
# ---------------------------------------------------------------------------
# L15 — SciPy `loggamma(real_negative)` returns nan (use +0j route)
# ---------------------------------------------------------------------------
#
#   sp.loggamma(-0.5)      → nan          ← REAL float → no analytic continuation
#   sp.loggamma(-0.5+0j)   → (1.265 - πi) ← complex input → branch-cut handled
#
# `sp.gammaln(x)` returns `log|Γ(x)|` (real magnitude only) without the
# imaginary `iπk` term. The corpus's T2 "negative-real LogGamma" cells expect
# the full analytic continuation, so the adapter routes `x < 0` (and `x` not
# a non-positive integer) through `sp.loggamma(complex(x, 0.0))`. The result
# carries a non-zero imaginary part; we emit it as a complex value. Every
# such call carries an explicit `# L15` comment.
#
# ---------------------------------------------------------------------------
# L17 — Gamma at non-positive integer poles (four oracle behaviors)
# ---------------------------------------------------------------------------
#
#   Wolfram: ComplexInfinity
#   mpmath:  ValueError("gamma function pole")
#   SciPy:   gamma(0.0) = +inf;  gamma(-1.0) = nan
#   libm:    same as SciPy
#
# This adapter emits SciPy's raw return (`+inf` or `nan` as JSON tokens
# "Infinity"/"NaN") at `status: "success"`. The comparator special-cases
# pole inputs and grades them against a "pole" tag rather than a numeric
# value. We do not raise on poles — they are the honest float64 answer.
#
# ---------------------------------------------------------------------------
# IncompleteGammaUpper / Lower with a ≤ 0 — SciPy refuses
# ---------------------------------------------------------------------------
#
# `sp.gammainc(a, z)` returns nan for real `a ≤ 0` (the regularised
# definition has a Γ(a) in the denominator). The corpus's T1 cells stay
# in `a > 0`, but T3 (near-pole) and T4 (complex Q1-Q4) probe `a` near 0;
# we emit whatever SciPy returns (nan included) at `status: "success"`
# with a `notes` field if nan was emitted. Loud-fail-on-nan would lose
# information; the comparator can grade nan against gold separately.
#
# ---------------------------------------------------------------------------
# Float64 number formatting
# ---------------------------------------------------------------------------
#
# We emit values as `f"{x:.17g}"` — 17 significant decimal digits, which
# is the IEEE-754 double-precision round-trip guarantee (DBL_DECIMAL_DIG).
# Python's `repr(float)` is the shortest-round-trip string (since 3.1 /
# PEP 3101); we use the explicit 17-digit form to make every value emit
# a uniform digit count and avoid `repr`'s "shortest" heuristic that
# would otherwise produce `'1.5'` for some values and `'1.4999999...'`
# for others.  Non-finite values emit as `"NaN"`, `"Infinity"`,
# `"-Infinity"` to match the corpus's tier-T6 token convention. Complex
# values render as `{"re": "...", "im": "..."}`.
#
# ---------------------------------------------------------------------------
# Wire shape (one record per corpus input, same order as input list)
# ---------------------------------------------------------------------------
#
# Index 0 is a `__meta__` sentinel:
#
#   { "__meta__": true,
#     "scipy_version":  "1.17.0",
#     "numpy_version":  "1.26.4",
#     "python_version": "3.12.3",
#     "compute_precision_bits": 53,
#     "emit_format":   "f\"{x:.17g}\" (17 sig digits round-trip)" }
#
# Each subsequent record:
#
#   { "input_id": "T1-gamma-001",     # echoes input id (renamed from "id" for G8 cross-oracle schema uniformity)
#     "status": "success" | "refused" | "unsupported" | "error",
#     "value":  "<float64 string>" | {"re": "...", "im": "..."} | null,
#     "method": "scipy.special.gamma" | "...-derived-from-Q-times-Γ" | "L14-refused",
#     "landmines": ["L12", ...],      # adapter-side pins relevant to this call
#     "elapsed_ms": <number>,
#     "notes":  <string|null> }       # explanation when non-success or noisy
#
# A status of `"refused"` carries a `refuse_token` field naming the
# documented landmine (e.g. `"TypeError-complex-polygamma"`). The TS
# driver tallies these and writes the final `results.json`.
# =============================================================================

from __future__ import annotations

import json
import math
import sys
import time
from typing import Any, Optional, Union

import numpy as np
import scipy
import scipy.special as sp

# ----------------------------------------------------------------------------
# Number-formatting helpers — emit float64 with 17-sig-digit round-trip.
# ----------------------------------------------------------------------------
#
# Python's IEEE-754 double has ~15.95 decimal digits of precision; 17 is the
# DBL_DECIMAL_DIG round-trip guarantee. We use `f"{x:.17g}"` (not repr(x))
# so every numeric value emits exactly 17 sig digits — uniform-width strings
# make the cross-oracle byte-comparator's job trivial.

# Sentinel for the corpus's pole-and-edge tokens. The corpus emits "NaN" /
# "Infinity" / "-Infinity"; we canonicalise outputs to the same tokens so
# downstream string-comparison need not normalise.


def fmt_real(x: float) -> str:
    """Emit a float as 17-sig-digit decimal, or a corpus-canonical non-finite token."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    return f"{x:.17g}"


def fmt_complex(z: complex) -> dict[str, str]:
    """Emit a complex value as `{re, im}` both formatted via fmt_real."""
    return {"re": fmt_real(z.real), "im": fmt_real(z.imag)}


# ----------------------------------------------------------------------------
# Argument-parsing helpers — corpus uses two discriminator forms.
# ----------------------------------------------------------------------------
#
# Primary `z` is a 60-digit decimal string OR a {"re": "...", "im": "..."}
# dict. The other scalars (`a`, `b`, `m`, `n`) carry a `{kind, value}`
# discriminator with kinds {"integer", "half-integer", "decimal"}.
#
# For the bronze tier all parses converge to Python float (or complex for
# the {re, im} form). The `nu_kind` discrimination from the Bessel corpus
# (integer ν vs half-integer ν vs decimal ν) is folded into this same
# arg_kind mechanism, so a single parser covers every numeric position.
#
# Float-of-integer-value triggers SciPy's same code path as an int input
# for the integer-ν algorithms (poch, polygamma, etc.) — we use float
# uniformly to keep the dispatch shape simple.


def parse_real_string(s: str) -> float:
    """Parse a corpus decimal string into float64. Handles non-finite tokens."""
    if s == "NaN":
        return float("nan")
    if s == "Infinity":
        return float("inf")
    if s == "-Infinity":
        return float("-inf")
    return float(s)


def parse_kinded_arg(field: dict[str, str]) -> float:
    """Parse a {kind, value} corpus argument into a Python float.

    Three kinds:
      "integer"      — value is a base-10 integer string ("3", "-2")
      "half-integer" — value is "a/b" with b ∈ {2}; parse as exact float-ratio
      "decimal"      — value is a 60-digit decimal string

    All three round to float64 the same way an in-substrate float64 evaluator
    would; trailing digits past ~16 mantissa-precision digits silently round
    via float()'s standard round-to-nearest.
    """
    kind = field["kind"]
    value = field["value"]
    if kind == "integer":
        return float(int(value))
    if kind == "half-integer":
        num_s, den_s = value.split("/", 1)
        return float(int(num_s)) / float(int(den_s))
    if kind == "decimal":
        return parse_real_string(value)
    raise ValueError(f"unknown arg kind: {kind!r}")


def parse_z(z_field: Union[str, dict[str, str]]) -> Union[float, complex]:
    """Parse the primary z argument: real string OR {re, im} dict."""
    if isinstance(z_field, str):
        return parse_real_string(z_field)
    if isinstance(z_field, dict):
        re = parse_real_string(z_field["re"])
        im = parse_real_string(z_field["im"])
        return complex(re, im)
    raise ValueError(f"unknown z shape: {z_field!r}")


# ----------------------------------------------------------------------------
# Per-head dispatch — each returns (value, method_tag, landmines, notes).
# ----------------------------------------------------------------------------
#
# A head dispatcher returns:
#   value     : float | complex | None
#                None means "refused" or "unsupported"; the dispatcher also
#                returns a non-None refuse_token in that case.
#   method    : str — provenance label for the comparator
#   landmines : list[str] — adapter-side landmine pins relevant to this call
#   notes     : str | None — context (regime, sign convention, etc.)
#   refuse_token : str | None — only set when value is None
#
# Returning a triple `(None, "...", [...])` would compress the API but losing
# the `refuse_token` field would force the caller to string-match `notes` to
# tell L14 from "unsupported"; the explicit token field keeps that crisp.


class DispatchResult:
    """Container for a per-head call's return — small NamedTuple replacement."""

    __slots__ = ("value", "method", "landmines", "notes", "refuse_token", "status")

    def __init__(
        self,
        value: Optional[Union[float, complex]],
        method: str,
        landmines: list[str],
        notes: Optional[str] = None,
        refuse_token: Optional[str] = None,
        status: str = "success",
    ):
        self.value = value
        self.method = method
        self.landmines = landmines
        self.notes = notes
        self.refuse_token = refuse_token
        self.status = status


def _refused(token: str, method: str, landmines: list[str], notes: str) -> DispatchResult:
    return DispatchResult(
        value=None, method=method, landmines=landmines,
        refuse_token=token, notes=notes, status="refused",
    )


def _unsupported(method: str, notes: str) -> DispatchResult:
    return DispatchResult(
        value=None, method=method, landmines=[],
        refuse_token=None, notes=notes, status="unsupported",
    )


def _success(
    value: Union[float, complex], method: str, landmines: list[str],
    notes: Optional[str] = None,
) -> DispatchResult:
    return DispatchResult(
        value=value, method=method, landmines=landmines, notes=notes, status="success",
    )


# ── individual head dispatchers ──────────────────────────────────────────────


def head_gamma(inp: dict[str, Any]) -> DispatchResult:
    """Γ(z) — sp.gamma supports real and complex.

    At z = 0 and z = -1, -2, ... the result is a pole. SciPy returns +inf
    for gamma(0.0) and nan for gamma(-n) — both are emitted faithfully.
    The comparator tags these per L17.
    """
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _success(complex(sp.gamma(z)), "scipy.special.gamma-complex", ["L17"])
    val = float(sp.gamma(z))
    return _success(val, "scipy.special.gamma", ["L17"])


def head_log_gamma(inp: dict[str, Any]) -> DispatchResult:
    """LogGamma(z) — analytic continuation.

    L15 mitigation: for real x < 0 (non-integer), `sp.loggamma(x)` returns
    NaN; we MUST pass `complex(x, 0.0)` to get the principal-value analytic
    continuation `log|Γ(x)| + iπk` where k counts the poles crossed. The
    result is then a complex value; we emit it as `{re, im}`. For real
    x ≥ 0 (including non-positive integer poles where SciPy returns +inf
    coherently), the real-arg branch is taken directly.

    Non-positive integers (z = 0, -1, -2, ...) are simple-pole locations
    for Γ; the L15-complex route still returns NaN there (the imaginary
    part is undefined at the pole). SciPy's `loggamma(complex(-1.0, 0.0))`
    returns (inf + nan·i); we emit that faithfully and let the comparator
    grade it as a pole.
    """
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        # Complex input — direct call returns complex.
        val = complex(sp.loggamma(z))
        return _success(val, "scipy.special.loggamma-complex", [])
    # Real input. L15: x < 0 must go through the complex route.
    if z < 0.0 and not math.isnan(z) and not math.isinf(z):
        # L15: pass as complex+0j to enable the analytic continuation.
        val = complex(sp.loggamma(complex(z, 0.0)))  # L15
        return _success(val, "scipy.special.loggamma-via-complex+0j", ["L15"],
                        notes="L15: real negative z routed through complex(x, 0)")
    # Real x ≥ 0 (or non-finite). Direct real call is correct here.
    val_r = float(sp.loggamma(z))
    return _success(val_r, "scipy.special.loggamma", [])


def head_digamma(inp: dict[str, Any]) -> DispatchResult:
    """ψ(z) — sp.digamma supports real and complex."""
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _success(complex(sp.digamma(z)), "scipy.special.digamma-complex", [])
    return _success(float(sp.digamma(z)), "scipy.special.digamma", [])


def head_trigamma(inp: dict[str, Any]) -> DispatchResult:
    """ψ'(z) = polygamma(1, z) — real OK; complex refused per L14."""
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _refused(
            "TypeError-complex-polygamma",
            "scipy.special.polygamma-complex-refused",
            ["L14"],
            "L14: scipy.special.polygamma(m, complex) raises TypeError; "
            "Trigamma = polygamma(1, z) inherits the refusal",
        )
    val = float(sp.polygamma(1, z))
    return _success(val, "scipy.special.polygamma(1,·)", [])


def head_polygamma(inp: dict[str, Any]) -> DispatchResult:
    """ψ^(m)(z) — real OK; complex refused per L14."""
    m = int(parse_kinded_arg(inp["m"]))
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _refused(
            "TypeError-complex-polygamma",
            "scipy.special.polygamma-complex-refused",
            ["L14"],
            f"L14: scipy.special.polygamma({m}, complex) raises TypeError",
        )
    val = float(sp.polygamma(m, z))
    return _success(val, f"scipy.special.polygamma({m},·)", [])


def head_pochhammer(inp: dict[str, Any]) -> DispatchResult:
    """(a)_n = Γ(a+n)/Γ(a) — sp.poch(a, n)."""
    a = parse_kinded_arg(inp["a"])
    n = parse_kinded_arg(inp["n"])
    val = float(sp.poch(a, n))
    return _success(val, "scipy.special.poch", [])


def head_incomplete_gamma_upper(inp: dict[str, Any]) -> DispatchResult:
    """Γ(a, z) = upper unregularised = Q(a, z) · Γ(a).

    L12: SciPy spells UPPER REGULARISED as `gammaincc` (not the obvious
    `gammainc` which is LOWER regularised). The unregularised upper is
    recovered by multiplying back by Γ(a).
    """
    a = parse_kinded_arg(inp["a"])
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _refused(
            "TypeError-complex-gammainc",
            "scipy.special.gammaincc-complex-refused",
            ["L12", "L14-cousin"],
            "scipy.special.gammainc/gammaincc raise TypeError on complex inputs",
        )
    # L12: gammaincc = Q (upper regularised). Q · Γ(a) = Γ(a, z) unregularised.
    q = float(sp.gammaincc(a, z))  # L12
    gamma_a = float(sp.gamma(a))
    val = q * gamma_a
    notes = None
    if math.isnan(val):
        notes = "L12 derivation produced NaN; likely a ≤ 0 (regularised denom Γ(a) singular)"
    return _success(val, "scipy.special.gammaincc(a,z)·gamma(a)", ["L12"], notes=notes)


def head_incomplete_gamma_lower(inp: dict[str, Any]) -> DispatchResult:
    """γ(a, z) = lower unregularised = P(a, z) · Γ(a).

    L12: SciPy's `gammainc` returns P (lower REGULARISED). Multiply by Γ(a)
    to recover the unregularised lower integral.
    """
    a = parse_kinded_arg(inp["a"])
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _refused(
            "TypeError-complex-gammainc",
            "scipy.special.gammainc-complex-refused",
            ["L12", "L14-cousin"],
            "scipy.special.gammainc raises TypeError on complex inputs",
        )
    p = float(sp.gammainc(a, z))  # L12: P (lower regularised)
    gamma_a = float(sp.gamma(a))
    val = p * gamma_a
    notes = None
    if math.isnan(val):
        notes = "L12 derivation produced NaN; likely a ≤ 0 (Γ(a) pole)"
    return _success(val, "scipy.special.gammainc(a,z)·gamma(a)", ["L12"], notes=notes)


def head_incomplete_gamma_p(inp: dict[str, Any]) -> DispatchResult:
    """P(a, z) = γ(a, z)/Γ(a) — sp.gammainc (L12 spelling).

    SciPy's `gammainc` IS P (lower regularised), despite the misleading
    name. The bare-name confusion is exactly the L12 trap.
    """
    a = parse_kinded_arg(inp["a"])
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _refused(
            "TypeError-complex-gammainc",
            "scipy.special.gammainc-complex-refused",
            ["L12"],
            "scipy.special.gammainc complex unsupported",
        )
    val = float(sp.gammainc(a, z))  # L12: P
    return _success(val, "scipy.special.gammainc(=P)", ["L12"])


def head_incomplete_gamma_q(inp: dict[str, Any]) -> DispatchResult:
    """Q(a, z) = Γ(a, z)/Γ(a) — sp.gammaincc (L12 spelling)."""
    a = parse_kinded_arg(inp["a"])
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _refused(
            "TypeError-complex-gammainc",
            "scipy.special.gammaincc-complex-refused",
            ["L12"],
            "scipy.special.gammaincc complex unsupported",
        )
    val = float(sp.gammaincc(a, z))  # L12: Q
    return _success(val, "scipy.special.gammaincc(=Q)", ["L12"])


def head_inverse_incomplete_gamma_p(inp: dict[str, Any]) -> DispatchResult:
    """Inverse of P: given p ∈ (0, 1), return z s.t. P(a, z) = p.

    L13: SciPy's `gammaincinv` inverts P (not Q). Wolfram's
    `InverseGammaRegularized[a, q]` inverts Q — different function. The
    corpus splits InverseIncompleteGamma{P, Q} into two distinct heads so
    the comparator never has to disambiguate.

    The corpus stores the probability argument as `z` (semantically `p`
    here); we re-parse it under that label for clarity.
    """
    a = parse_kinded_arg(inp["a"])
    p = parse_z(inp["z"])  # semantically `p`; field name is `z` per corpus schema
    if isinstance(p, complex):
        return _refused(
            "TypeError-complex-gammaincinv",
            "scipy.special.gammaincinv-complex-refused",
            ["L13"],
            "scipy.special.gammaincinv complex unsupported",
        )
    val = float(sp.gammaincinv(a, p))  # L13: inverts P
    return _success(val, "scipy.special.gammaincinv(inverts P)", ["L13"])


def head_inverse_incomplete_gamma_q(inp: dict[str, Any]) -> DispatchResult:
    """Inverse of Q: given q ∈ (0, 1), return z s.t. Q(a, z) = q.

    L13: SciPy's `gammainccinv` inverts Q (the function that matches
    Wolfram's `InverseGammaRegularized`).
    """
    a = parse_kinded_arg(inp["a"])
    q = parse_z(inp["z"])  # semantically `q`
    if isinstance(q, complex):
        return _refused(
            "TypeError-complex-gammainccinv",
            "scipy.special.gammainccinv-complex-refused",
            ["L13"],
            "scipy.special.gammainccinv complex unsupported",
        )
    val = float(sp.gammainccinv(a, q))  # L13: inverts Q
    return _success(val, "scipy.special.gammainccinv(inverts Q)", ["L13"])


def head_beta(inp: dict[str, Any]) -> DispatchResult:
    """B(a, b) = Γ(a)·Γ(b)/Γ(a+b) — sp.beta (real)."""
    a = parse_kinded_arg(inp["a"])
    b = parse_kinded_arg(inp["b"])
    val = float(sp.beta(a, b))
    return _success(val, "scipy.special.beta", [])


def head_log_beta(inp: dict[str, Any]) -> DispatchResult:
    """log|B(a, b)| — sp.betaln (note: magnitude only).

    For real a, b > 0 the sign of B is +1 and betaln gives the full
    LogBeta. For mixed signs the absolute-value form drops the imaginary
    π·k contribution; the corpus's T1 cells stay in a, b > 0 so this is
    not exercised here, but the call is noted as magnitude-only for
    transparency.
    """
    a = parse_kinded_arg(inp["a"])
    b = parse_kinded_arg(inp["b"])
    val = float(sp.betaln(a, b))
    notes = None
    if a <= 0 or b <= 0:
        notes = "betaln returns log|B|; imaginary π·k missed if Γ-signs differ"
    return _success(val, "scipy.special.betaln(log|B|)", [], notes=notes)


def head_gamma_ratio(inp: dict[str, Any]) -> DispatchResult:
    """Γ(a)/Γ(b).

    For (a - b) integer this composes exactly as `poch(b, a - b)`
    (rising-factorial form, no catastrophic Γ cancellation).  Otherwise we
    fall back to the direct ratio `sp.gamma(a) / sp.gamma(b)` — this is
    accuracy-bounded by the worse of the two Γ evaluations and may overflow
    for `a, b > 170` (R3 §5 ratio-stable variants). The corpus's T1 cells
    are well within range; outside T1 the user should reach for a gold
    oracle.
    """
    a = parse_kinded_arg(inp["a"])
    b = parse_kinded_arg(inp["b"])
    diff = a - b
    if abs(diff - round(diff)) < 1e-15 and diff == int(round(diff)) and int(round(diff)) >= 0:
        # Integer (a - b) ≥ 0: use poch(b, a - b) = Γ(a)/Γ(b)
        val = float(sp.poch(b, int(round(diff))))
        return _success(val, "scipy.special.poch(b,a-b)=Γ(a)/Γ(b)", [], notes="composed via Pochhammer")
    # Direct ratio fallback.
    val = float(sp.gamma(a) / sp.gamma(b))
    return _success(val, "scipy.special.gamma(a)/gamma(b)", [], notes="direct ratio (may overflow at a,b>170)")


def head_gamma_delta_ratio(inp: dict[str, Any]) -> DispatchResult:
    """Γ(a)/Γ(a + b) = 1/poch(a, b).

    The reciprocal-Pochhammer composition is exact and overflow-safe across
    the entire corpus range. Direct ratio (gamma(a)/gamma(a+b)) is the
    fallback for non-finite Pochhammer.
    """
    a = parse_kinded_arg(inp["a"])
    b = parse_kinded_arg(inp["b"])
    p = float(sp.poch(a, b))
    if math.isfinite(p) and p != 0.0:
        return _success(
            1.0 / p, "1/scipy.special.poch(a,b)=Γ(a)/Γ(a+b)", [],
            notes="composed via reciprocal Pochhammer",
        )
    # Fallback: direct ratio.
    val = float(sp.gamma(a) / sp.gamma(a + b))
    return _success(val, "scipy.special.gamma(a)/gamma(a+b)", [], notes="direct ratio (poch overflow / zero)")


def head_gamma_p_derivative(inp: dict[str, Any]) -> DispatchResult:
    """∂P/∂z(a, z) = exp(-z) · z^(a-1) / Γ(a)  (DLMF §8.8.2).

    Closed form. The integrand of the regularised lower incomplete-gamma
    integral. SciPy has no dedicated `gamma_p_derivative` ufunc, so we
    compose. The expression is overflow-safe for the corpus's `(a, z)`
    range (a, z ∈ (0, 20]); at the extremes it underflows to 0 cleanly.
    """
    a = parse_kinded_arg(inp["a"])
    z = parse_z(inp["z"])
    if isinstance(z, complex):
        return _refused(
            "complex-not-implemented",
            "GammaPDerivative-complex-not-implemented",
            [],
            "complex GammaPDerivative not implemented in SciPy adapter",
        )
    # exp(-z) · z^(a-1) / Γ(a)
    if z == 0.0 and a > 1.0:
        val = 0.0
    elif z == 0.0:
        # z^(a-1) at z=0 is 0 for a > 1, inf for a < 1, 1 for a = 1.
        if a == 1.0:
            val = 1.0 / float(sp.gamma(a))
        else:
            val = float("inf")
    else:
        val = math.exp(-z) * (z ** (a - 1.0)) / float(sp.gamma(a))
    return _success(val, "DLMF §8.8.2 closed form (exp(-z)·z^(a-1)/Γ(a))", [])


def head_incomplete_beta(inp: dict[str, Any]) -> DispatchResult:
    """I_z(a, b) — regularised incomplete beta = sp.betainc(a, b, z).

    Note: corpus head name is "IncompleteBeta"; per R5 §3.3 and §4 the
    underlying SciPy primitive is the REGULARISED form I_z (not the raw
    B(z; a, b) = ∫₀^z t^(a-1)(1-t)^(b-1) dt). The comparator decides which
    convention to grade against; this adapter emits whatever SciPy emits
    and labels the method tag accordingly.
    """
    z = parse_z(inp["z"])
    a = parse_kinded_arg(inp["a"])
    b = parse_kinded_arg(inp["b"])
    if isinstance(z, complex):
        return _refused(
            "TypeError-complex-betainc",
            "scipy.special.betainc-complex-refused",
            [],
            "scipy.special.betainc complex unsupported",
        )
    val = float(sp.betainc(a, b, z))
    return _success(val, "scipy.special.betainc(=I_z regularised)", [])


def head_barnes_g(inp: dict[str, Any]) -> DispatchResult:
    """BarnesG(z) — SciPy has no implementation. Emit 'unsupported'."""
    return _unsupported(
        "BarnesG-not-in-scipy",
        "L16: SciPy has no barnesg; bronze tier cannot cover this head. "
        "Use Wolfram (G2) or mpmath (G3) for gold values.",
    )


# Dispatch table: corpus head name → callable.
HEAD_DISPATCH: dict[str, Any] = {
    "Gamma":                    head_gamma,
    "LogGamma":                 head_log_gamma,
    "Digamma":                  head_digamma,
    "Trigamma":                 head_trigamma,
    "Polygamma":                head_polygamma,
    "Pochhammer":               head_pochhammer,
    "IncompleteGammaUpper":     head_incomplete_gamma_upper,
    "IncompleteGammaLower":     head_incomplete_gamma_lower,
    "IncompleteGammaP":         head_incomplete_gamma_p,
    "IncompleteGammaQ":         head_incomplete_gamma_q,
    "InverseIncompleteGammaP":  head_inverse_incomplete_gamma_p,
    "InverseIncompleteGammaQ":  head_inverse_incomplete_gamma_q,
    "Beta":                     head_beta,
    "LogBeta":                  head_log_beta,
    "GammaRatio":               head_gamma_ratio,
    "GammaDeltaRatio":          head_gamma_delta_ratio,
    "GammaPDerivative":         head_gamma_p_derivative,
    "IncompleteBeta":           head_incomplete_beta,
    "BarnesG":                  head_barnes_g,
}


# ----------------------------------------------------------------------------
# Main loop — read corpus envelope from stdin, write JSON list to stdout.
# ----------------------------------------------------------------------------
#
# Each record carries id, status, value, method, landmines, elapsed_ms,
# notes. Exceptions inside a head dispatcher are caught and emitted as
# `status: "error"` with `notes` carrying the exception class + message.
# The loud-fail discipline is enforced at the TS-driver layer (it tallies
# errors and writes them to stderr); we keep the Python side resilient so
# one bad input doesn't kill the whole batch.


def evaluate_one(inp: dict[str, Any]) -> dict[str, Any]:
    iid = inp["id"]
    head = inp["head"]
    record: dict[str, Any] = {"input_id": iid, "head": head, "tier": inp.get("tier")}

    dispatcher = HEAD_DISPATCH.get(head)
    if dispatcher is None:
        # Unknown head — should never happen with a valid corpus, but stay loud.
        record["status"] = "error"
        record["method"] = "error-unknown-head"
        record["landmines"] = []
        record["notes"] = f"unknown corpus head: {head!r}"
        record["elapsed_ms"] = 0.0
        return record

    t0 = time.perf_counter_ns()
    try:
        result: DispatchResult = dispatcher(inp)
        elapsed_ms = (time.perf_counter_ns() - t0) / 1e6

        record["status"] = result.status
        record["method"] = result.method
        record["landmines"] = result.landmines
        record["notes"] = result.notes
        record["elapsed_ms"] = elapsed_ms

        if result.status == "success" and result.value is not None:
            if isinstance(result.value, complex):
                record["value"] = fmt_complex(result.value)
            else:
                record["value"] = fmt_real(float(result.value))
        elif result.status == "refused":
            record["value"] = None
            record["refuse_token"] = result.refuse_token
        elif result.status == "unsupported":
            record["value"] = None
        else:
            record["value"] = None
    except Exception as e:  # noqa: BLE001 — we want the full failure surface
        elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
        record["status"] = "error"
        record["method"] = f"exception-{type(e).__name__}"
        record["landmines"] = []
        record["notes"] = f"{type(e).__name__}: {e}"
        record["value"] = None
        record["elapsed_ms"] = elapsed_ms

    return record


def main() -> None:
    envelope = json.load(sys.stdin)
    inputs = envelope["inputs"]
    out: list[dict[str, Any]] = [
        {
            "__meta__": True,
            "scipy_version":  scipy.__version__,
            "numpy_version":  np.__version__,
            "python_version": sys.version.split()[0],
            "compute_precision_bits": 53,
            "emit_format": 'f"{x:.17g}" (17 sig digits round-trip)',
        }
    ]
    for inp in inputs:
        out.append(evaluate_one(inp))
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
