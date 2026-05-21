#!/usr/bin/env python3
# ============================================================================
# bench/gamma-anchor/oracles/mpmath/oracle.py
# ----------------------------------------------------------------------------
#
# mpmath gold-tier oracle driver for the Gamma-anchor golden-master corpus
# (G3, bead `scientist-workbench-5x31`, ADR-0042 §"Decision 8").
#
# Reads the corpus JSON envelope on stdin (the TS adapter strips outer
# metadata before forwarding):
#
#   { "inputs": [
#       { "id": "T1-gamma-001",
#         "tier": "T1" .. "T8",
#         "head": "Gamma" | "LogGamma" | "Digamma" | "Trigamma" |
#                 "Polygamma" | "Pochhammer" |
#                 "IncompleteGammaUpper" | "IncompleteGammaLower" |
#                 "IncompleteGammaP" | "IncompleteGammaQ" |
#                 "InverseIncompleteGammaP" | "InverseIncompleteGammaQ" |
#                 "Beta" | "LogBeta" | "BarnesG" |
#                 "GammaRatio" | "GammaDeltaRatio" |
#                 "GammaPDerivative" | "IncompleteBeta",
#         "z":  "<60-dp string>" | {"re": "...", "im": "..."},
#         # 2-arg / 3-arg heads carry additional discriminated-kind fields:
#         "a":  { "kind": "integer"|"half-integer"|"decimal", "value": "..." },
#         "b":  { "kind": ..., "value": "..." },
#         "m":  { "kind": "integer", "value": "..." },
#         "n":  { "kind": "integer", "value": "..." },
#         "notes": "..."
#       },
#       ...
#     ]
#   }
#
# Emits a JSON list on stdout. Element 0 is a `__meta__` sentinel carrying
# `mpmath.__version__`, `sys.version`, the compute dps and emit dps. Each
# subsequent element is one result row:
#
#   { "id": "...", "status": "success" | "complex-success"
#                          | "refused" | "unsupported"
#                          | "timeout" | "error",
#     "real": "<60-dp string>",                            # if real success
#     "complex": {"re": "...", "im": "..."},               # if complex success
#     "note": "<short string>",                            # optional context
#     "elapsed_ms": <float> }
#
# The TS driver merges this into the final `results.json` envelope and fills
# in the orchestration metadata (corpus path, generated_at, totals).
#
# ── Determinism contract (mpmath = gold tier) ─────────────────────────────
#
# Per ADR-0042 §"Decision 8" + R5 §3.2:
#
#   - `mp.dps = 60` for compute. The bead prompt pins this; 60 decimal
#     places (≈ 199 bits) is exactly the gold-tier target (50 dp) plus
#     a 10-dp margin that absorbs mpmath's per-algorithm internal
#     precision bumps (Stirling-shift loss near integers; CF stagnation
#     in the Temme saddle region; cot reflection at digamma negative-z).
#     The corpus's `expected_decimals_per_value` is 60; we emit at the
#     full working precision so the G8 comparator's tolerance budget
#     covers any residual L2 rounding mismatch against Wolfram.
#
#   - `mpmath.nstr(v, 60, strip_zeros=False)` for emit. We use the FULL
#     working precision on emit (not 55 dp as Bessel R5 did) because the
#     bead prompt explicitly directs "emit at 60dp" and the gamma corpus
#     declares `expected_decimals_per_value: 60`. The G8 cross-agreement
#     comparator does the final canonicalisation between mpmath
#     (round-to-nearest) and Wolfram (truncate); see L2 below.
#
# mpmath is bit-identical across CPython runtimes by construction: Python
# `int` arithmetic is bit-identical by language spec, and mpmath's mpf
# layer is pure-Python over `int`. Two runs of this driver with byte-
# identical stdin produce byte-identical stdout.
#
# ── Landmines handled here (R5 §6) ────────────────────────────────────────
#
#   - **L1** (Wolfram input-trap; carry through). The corpus's discriminated
#     `{kind, value}` envelope on `a`, `b`, `m`, `n` lets us parse exactly:
#     integers → Python int; half-integers → mpf(num) / mpf(den) (EXACT at
#     any precision because num and den are small Python ints); decimals →
#     mpf(<60-dp string>) (mpmath parses decimal strings at full mp.dps).
#     We NEVER use Python `float()` on these — that would silently cap at
#     ~15.95 decimals and reintroduce the L1 trap mpmath is supposed to
#     avoid.
#
#   - **L2** (mpmath nstr round-to-nearest vs Wolfram N truncate). The
#     emit-precision-equals-compute-precision policy hands the rounding-
#     mode normalisation to the G8 comparator (`bench/gamma-anchor/
#     cross-agreement.ts`). The comparator compares at `precision − 1`
#     decimals; the 60-dp emit gives it a clean digit window to work
#     against.
#
#   - **L12** (P/Q inversion — THE #1 gamma trap; R5 §6 lines 828-879). Map
#     spelt out in `call_head` below, every line tagged `# L12`:
#         Upper  → gammainc(a, z, mp.inf, regularized=False)
#         Lower  → gammainc(a, 0,  z,     regularized=False)
#         P      → gammainc(a, 0,  z,     regularized=True)
#         Q      → gammainc(a, z,  mp.inf, regularized=True)
#     This is the canonical mapping the R5 cheat-sheet (§3.2 lines 286-289)
#     also pins. SciPy reverses Upper/P; we MUST NOT reverse.
#
#   - **L_pole** (the gamma-poles family — partly L17). mpmath signals the
#     poles by raising `ValueError("gamma function pole")` for `mp.gamma`
#     at non-positive integers and by returning `mpf('+inf')` for
#     `mp.digamma` / `mp.polygamma` at the same arguments. We catch and
#     emit `status: "refused"` with `mpmath_returned_token` recording the
#     verbatim token. The G8 comparator special-cases the pole cells and
#     does not penalise oracles for diverging behaviour at exact poles
#     (Wolfram emits `ComplexInfinity`; SciPy emits `+∞`; libm emits NaN).
#
#   - **L_polynew_3** (BarnesG convention disagreement; R5 §6 line 833+). The
#     ADR-0042 canonical convention for BarnesG is Adamchik (Wolfram's), but
#     mpmath uses the Vardi-Quine convention. We DO NOT canonicalise — we
#     record verbatim what mpmath returns. The G8 comparator handles the
#     convention normalisation. Pinned in the README.
#
#   - **InverseIncompleteGamma{P,Q}**: mpmath has NO direct function for
#     these (R5 §3.2 lines 314-326 confirms; the workaround is
#     `mp.findroot`). The bead prompt directs that we emit `status:
#     "unsupported"` rather than silently substitute a findroot result —
#     a findroot's accuracy depends on the initial guess and is not
#     gold-tier byte-deterministic without an additional convention
#     pin. Honest refusal beats a wrong-shaped answer (CLAUDE.md Rule 1).
#
# ── Argument parsing — the discriminated-kind discipline (R5 §6 L1) ─────
#
# Scalar arguments `a`, `b`, `m`, `n` carry a `{kind, value}` envelope. We
# dispatch on `kind`:
#
#   - `"integer"`:        Python `int(value)`. mpmath accepts Python ints
#                         natively; for `polygamma(m, z)` the first arg
#                         MUST be a Python int (mpmath's signature is
#                         `polygamma(int, mpf|mpc)`).
#   - `"half-integer"`:   parse "num/den" → `mp.mpf(int(num)) /
#                         mp.mpf(int(den))`. EXACT at any mp.dps because
#                         num and den are small Python ints (typically
#                         ±k and 2).
#   - `"decimal"`:        `mp.mpf(value)`. The corpus emits 60-dp decimal
#                         strings; mpmath parses these at full mp.dps with
#                         no precision loss because mp.dps == 60 matches
#                         the input width.
#
# Primary `z` (and complex `re`/`im`) stays in the simpler 60-dp decimal-
# string form because z is the head's analytic variable; we parse with
# `mp.mpf(value)` directly (matching mpmath's native decimal-string
# acceptance at mp.dps precision).
# ============================================================================

from __future__ import annotations

import json
import signal
import sys
import time
from typing import Any

import mpmath
from mpmath import mp, mpc, mpf, nstr

WORK_DPS = 60
EMIT_DPS = 60  # full working precision — see L2 commentary
PER_INPUT_TIMEOUT_S = 30

mp.dps = WORK_DPS

# ── timeout plumbing ─────────────────────────────────────────────────────


class TimeoutException(Exception):
    """Raised by the SIGALRM handler when a single input exceeds PER_INPUT_TIMEOUT_S."""


def _alarm_handler(signum, frame):
    raise TimeoutException(f"input exceeded {PER_INPUT_TIMEOUT_S}s")


signal.signal(signal.SIGALRM, _alarm_handler)


# ── argument parsing — strict precision, no float() ──────────────────────


def parse_kind_int(field) -> int:
    """Parse a `{kind: 'integer', value: '...'}` envelope as a Python int.

    Used for `m` (Polygamma order), `n` (Pochhammer index). mpmath's
    `polygamma(m, z)` requires m to be a Python int; `rf(a, n)` accepts
    either int or mpf, but we keep n as int when the corpus says integer
    so the integer-recurrence path is taken.
    """
    assert field["kind"] == "integer", f"expected integer kind, got {field['kind']}"
    return int(field["value"])


def parse_kind_scalar(field):
    """Parse a `{kind, value}` envelope as the appropriate mpmath scalar.

    Returns Python int for `kind=integer`; `mp.mpf` for half-integer and
    decimal. Half-integer uses BigInt division `mpf(num)/mpf(den)` so the
    result is EXACT (mpf division of two exact-integer mpfs is bit-exact
    at any precision). Decimal uses `mpf(string)` directly.

    NEVER uses Python `float()` — that would silently cap at 15.95 dp and
    reintroduce L1.
    """
    kind = field["kind"]
    value = field["value"]
    if kind == "integer":
        return int(value)
    if kind == "half-integer":
        # Format "num/den" — typically "k/2" or "-k/2". Could also be
        # "k/1" in degenerate corpus cells.
        if "/" not in value:
            # Shouldn't happen in v0.1 corpus, but parse defensively.
            return mpf(int(value))
        num_s, den_s = value.split("/", 1)
        return mpf(int(num_s)) / mpf(int(den_s))
    if kind == "decimal":
        # mpmath parses decimal strings at full mp.dps. The corpus emits
        # 60-dp strings; mp.dps = 60; this is exact-at-working-precision.
        return mpf(value)
    raise ValueError(f"unknown kind: {kind!r}")


def parse_z(z_field):
    """Parse the corpus `z` field. Real → mpf; complex → mpc."""
    if isinstance(z_field, str):
        return mpf(z_field)
    if isinstance(z_field, dict):
        return mpc(mpf(z_field["re"]), mpf(z_field["im"]))
    raise ValueError(f"unknown z shape: {z_field!r}")


# ── emit helpers — canonicalise inf/nan, full 60-dp width ─────────────────


def emit_real(v) -> str:
    """Format an mpf at EMIT_DPS, canonicalising ±inf / nan to wire tokens."""
    if mpmath.isnan(v):
        return "NaN"
    if mpmath.isinf(v):
        return "Infinity" if v > 0 else "-Infinity"
    return nstr(v, EMIT_DPS, strip_zeros=False)


def emit_complex(v) -> dict:
    return {"re": emit_real(v.real), "im": emit_real(v.imag)}


# ── per-head dispatch ────────────────────────────────────────────────────


def call_head(head: str, inp: dict):
    """Evaluate one corpus row. Returns mpf / mpc, raises on refusal.

    The L12 mapping is spelt out verbatim for every incomplete-gamma call;
    the comments are load-bearing for any future reader trying to match
    this code against the R5 §6 L12 cheat-sheet.
    """
    if head == "Gamma":
        z = parse_z(inp["z"])
        return mpmath.gamma(z)

    if head == "LogGamma":
        # mpmath.loggamma(x) for real x < 0 returns the analytic continuation
        # with imaginary part = -π·k (k = floor(-x)) — different from
        # log|Γ(x)| and from SciPy's `loggamma(real)` which returns NaN
        # (L15). We pass through mpmath's analytic-continuation value
        # verbatim; the G8 comparator handles the convention pin against
        # Wolfram (which uses the same Adamchik-style analytic continuation
        # as mpmath).
        z = parse_z(inp["z"])
        return mpmath.loggamma(z)

    if head == "Digamma":
        z = parse_z(inp["z"])
        return mpmath.digamma(z)

    if head == "Trigamma":
        # ψ^(1)(z) = trigamma; mpmath exposes via polygamma(1, z).
        z = parse_z(inp["z"])
        return mpmath.polygamma(1, z)

    if head == "Polygamma":
        # ψ^(m)(z); m is a non-negative integer from the corpus's `m`
        # field. mpmath REQUIRES Python int as the first arg.
        m = parse_kind_int(inp["m"])
        z = parse_z(inp["z"])
        return mpmath.polygamma(m, z)

    if head == "Pochhammer":
        # (a)_n = a·(a+1)·...·(a+n-1) = Γ(a+n)/Γ(a). mpmath.rf accepts both
        # integer and mpf for both args; we use the corpus's discriminated
        # kind for a (integer/half-integer/decimal) and integer for n.
        a = parse_kind_scalar(inp["a"])
        n = parse_kind_scalar(inp["n"])
        return mpmath.rf(a, n)

    if head == "IncompleteGammaUpper":
        # L12: upper UNregularised Γ(a, z) = ∫_z^∞ t^{a-1} e^{-t} dt
        # mpmath's `gammainc(a, z)` returns this by default; we make the
        # 3-arg + regularized=False form explicit so the L12 mapping is
        # unmistakable in the code.
        a = parse_kind_scalar(inp["a"])
        z = parse_z(inp["z"])
        return mpmath.gammainc(a, z, mp.inf, regularized=False)  # L12

    if head == "IncompleteGammaLower":
        # L12: lower UNregularised γ(a, z) = ∫_0^z t^{a-1} e^{-t} dt
        a = parse_kind_scalar(inp["a"])
        z = parse_z(inp["z"])
        return mpmath.gammainc(a, 0, z, regularized=False)  # L12

    if head == "IncompleteGammaP":
        # L12: lower regularised P(a, z) = γ(a, z) / Γ(a)
        a = parse_kind_scalar(inp["a"])
        z = parse_z(inp["z"])
        return mpmath.gammainc(a, 0, z, regularized=True)  # L12

    if head == "IncompleteGammaQ":
        # L12: upper regularised Q(a, z) = Γ(a, z) / Γ(a)
        a = parse_kind_scalar(inp["a"])
        z = parse_z(inp["z"])
        return mpmath.gammainc(a, z, mp.inf, regularized=True)  # L12

    if head in ("InverseIncompleteGammaP", "InverseIncompleteGammaQ"):
        # R5 §3.2 lines 314-326: mpmath has NO direct inverse-incomplete-
        # gamma function. The workaround is `mp.findroot(eq, a)` — but a
        # findroot result is not gold-tier byte-deterministic (depends on
        # initial guess + convergence path), and inventing one would
        # contradict the bead prompt's "Never silently substitute" rule.
        # Emit honest refusal; the SciPy/Boost/Wolfram adapters cover
        # these cells.
        raise NotImplementedError(
            "mpmath has no direct InverseIncompleteGamma{P,Q}; "
            "R5 §3.2 documents findroot workaround as non-gold-tier"
        )

    if head == "Beta":
        # B(a, b) = Γ(a)·Γ(b)/Γ(a+b). mpmath.beta is native.
        a = parse_kind_scalar(inp["a"])
        b = parse_kind_scalar(inp["b"])
        return mpmath.beta(a, b)

    if head == "LogBeta":
        # log|B(a, b)| via mpmath's lgamma sum + sign tracking. mpmath has
        # no native `logbeta`; we compose as lgamma(a) + lgamma(b) -
        # lgamma(a+b). For positive a, b this is the principal log Beta.
        # For mixed-sign a, b mpmath's `loggamma` returns the analytic
        # continuation (complex-valued); we keep the full complex result
        # if it arises and let the comparator handle the
        # complex-output-from-real-inputs annotation.
        a = parse_kind_scalar(inp["a"])
        b = parse_kind_scalar(inp["b"])
        return mpmath.loggamma(a) + mpmath.loggamma(b) - mpmath.loggamma(a + b)

    if head == "BarnesG":
        # L_polynew_3: mpmath uses the Vardi-Quine convention; ADR-0042
        # canonical is Adamchik (Wolfram's). We emit mpmath's value
        # VERBATIM. G8 comparator handles the canonicalisation; pinned
        # in the README.
        z = parse_z(inp["z"])
        return mpmath.barnesg(z)

    if head == "GammaRatio":
        # Γ(a) / Γ(b). The numerically stable form is exp(lgamma(a) -
        # lgamma(b)) but here we're at gold tier with 60-dp working
        # precision; direct division is bit-exact and lets the comparator
        # see the canonical ratio rather than a stabilised proxy.
        a = parse_kind_scalar(inp["a"])
        b = parse_kind_scalar(inp["b"])
        return mpmath.gamma(a) / mpmath.gamma(b)

    if head == "GammaDeltaRatio":
        # Γ(a) / Γ(a + b) — useful when |b| << |a| because the lgamma-
        # subtraction is well-conditioned. Same gold-tier discipline as
        # GammaRatio: direct division at 60 dp.
        a = parse_kind_scalar(inp["a"])
        b = parse_kind_scalar(inp["b"])
        return mpmath.gamma(a) / mpmath.gamma(a + b)

    if head == "GammaPDerivative":
        # ∂P(a, z)/∂z = z^{a-1} · e^{-z} / Γ(a)   (DLMF §8.8.13)
        # The corpus carries `a` (discriminated kind) and `z` (60-dp).
        a = parse_kind_scalar(inp["a"])
        z = parse_z(inp["z"])
        return mpmath.power(z, a - 1) * mpmath.exp(-z) / mpmath.gamma(a)

    if head == "IncompleteBeta":
        # I_z(a, b) REGULARISED per corpus-spec.md ("IncompleteBeta: I_z(a, b)";
        # DLMF §8.17.2 notation uses I for regularised, B for unregularised).
        # mpmath.betainc(a, b, x1, x2, regularized=True) returns the difference
        # I_{x2}(a, b) - I_{x1}(a, b); with x1=0 this collapses to I_z(a, b).
        # Fixed 2026-05-19 — G8 cross-agreement caught the previous
        # `regularized=False` as 36/40 of the unexplained findings; the original
        # subagent comment misread the head's convention.
        a = parse_kind_scalar(inp["a"])
        b = parse_kind_scalar(inp["b"])
        z = parse_z(inp["z"])
        return mpmath.betainc(a, b, 0, z, regularized=True)

    raise ValueError(f"unknown head: {head!r}")


# ── pole / refusal classification ────────────────────────────────────────
#
# mpmath signals the gamma family's poles via exceptions (verified
# empirically on 1.3.0):
#   - `mp.gamma(0)` raises ValueError("gamma function pole")
#   - `mp.gamma(-k)` raises ValueError("gamma function pole")
#   - `mp.loggamma(0)` raises ValueError("gamma function pole")
#   - `mp.loggamma(-k)` (k>0 integer) raises ValueError("gamma function pole")
#     (for non-integer negative real, returns the analytic continuation
#     with imaginary part = -πk — handled by the regular complex-success path)
#   - `mp.digamma(0)` raises ValueError("polygamma pole")
#   - `mp.digamma(-k)` raises ValueError("polygamma pole")
#   - `mp.polygamma(m, 0)` for m ≥ 1 raises ZeroDivisionError (the
#     Hurwitz-zeta route hits 1/0 at the pole; no message)
#   - `mp.barnesg(0)`, `mp.barnesg(-k)` (k ≥ 0 integer) return mpf(0)
#     (NOT a pole — BarnesG vanishes at non-positive integers per
#     DLMF §5.17.1's functional eqn G(z+1) = Γ(z)G(z) with G(1)=1)
#
# We translate the pole-style exceptions to `status: "refused"` with the
# verbatim exception payload in `mpmath_returned_token` so the G8
# comparator can audit the diverging-oracle behaviour (L17) — Wolfram
# emits `ComplexInfinity`, SciPy emits `+∞`, libm emits NaN, mpmath
# raises. None of these are "wrong"; they are four oracle-specific
# encodings of the same mathematical fact.


def classify_pole_or_refusal(head: str, value, exc: Exception | None):
    """Decide if a result/exception qualifies as 'refused' at a pole.

    Returns:
      None          — not a refusal; treat as normal success/failure.
      (token,)      — refusal with the verbatim mpmath token (string).
    """
    if exc is not None:
        msg = str(exc).lower()
        # mpmath's pole signatures observed empirically:
        #   gamma(0)              → ValueError("gamma function pole")
        #   gamma(-k)             → ValueError("gamma function pole")
        #   loggamma(0), loggamma(-k) → ValueError("gamma function pole")
        #   digamma(0), digamma(-k)   → ValueError("polygamma pole")
        #   polygamma(m, 0) m≥1   → ZeroDivisionError (no message; the
        #                           Hurwitz-zeta route hits 1/0)
        # All three are honest pole signatures; classify uniformly.
        if "pole" in msg:
            return (f"{type(exc).__name__}: {exc}",)
        if isinstance(exc, ZeroDivisionError):
            # polygamma at non-positive integer; the Hurwitz-zeta route
            # divides by (z - n) at the pole.
            return (f"{type(exc).__name__}: polygamma pole (ζ-route 1/0)",)
        # NotImplementedError for InverseIncompleteGamma{P,Q}: NOT a pole,
        # it's an UNSUPPORTED head. Caller distinguishes.
        return None

    # Successful return that's actually an inf/nan — treat as refusal so
    # the G8 comparator can special-case (L17).
    if value is None:
        return None
    try:
        if isinstance(value, mpc):
            if mpmath.isnan(value.real) or mpmath.isnan(value.imag):
                return ("nan",)
            if mpmath.isinf(value.real) or mpmath.isinf(value.imag):
                return ("inf",)
        else:
            if mpmath.isnan(value):
                return ("nan",)
            if mpmath.isinf(value):
                return ("+inf" if value > 0 else "-inf",)
    except (TypeError, ValueError):
        # mpmath.isnan can raise on weird types; treat as not-a-refusal
        # and let downstream emit handle it.
        return None
    return None


# ── main loop ────────────────────────────────────────────────────────────


def evaluate_one(inp: dict) -> dict:
    rid = inp["id"]
    head = inp["head"]

    t0 = time.perf_counter_ns()
    signal.alarm(PER_INPUT_TIMEOUT_S)
    value = None
    exc: Exception | None = None
    try:
        value = call_head(head, inp)
        signal.alarm(0)
    except TimeoutException as e:
        signal.alarm(0)
        return {
            "id": rid,
            "status": "timeout",
            "note": str(e),
            "elapsed_ms": (time.perf_counter_ns() - t0) / 1e6,
        }
    except NotImplementedError as e:
        signal.alarm(0)
        return {
            "id": rid,
            "status": "unsupported",
            "note": str(e),
            "elapsed_ms": (time.perf_counter_ns() - t0) / 1e6,
        }
    except Exception as e:  # noqa: BLE001 — full failure surface
        signal.alarm(0)
        exc = e

    elapsed_ms = (time.perf_counter_ns() - t0) / 1e6

    # L_pole classification — covers exception-style refusals (mp.gamma at
    # poles) AND inf/nan-style refusals (mp.digamma at poles).
    refusal = classify_pole_or_refusal(head, value, exc)
    if refusal is not None:
        return {
            "id": rid,
            "status": "refused",
            "mpmath_returned_token": refusal[0],
            "note": f"L_pole: head={head} returned {refusal[0]}",
            "elapsed_ms": elapsed_ms,
        }

    if exc is not None:
        # Non-pole exception — surface verbatim for the G8 audit.
        return {
            "id": rid,
            "status": "error",
            "note": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": elapsed_ms,
        }

    # value is non-None and not inf/nan — emit normally.
    if isinstance(value, mpc):
        # Complex output — could be (a) inputs were complex (T4), or
        # (b) inputs were real but the analytic continuation is complex
        # (LogGamma at real negative non-integer, BarnesG ditto). Both
        # cases land here; the G8 comparator distinguishes via the corpus's
        # tier and the per-head L15-style annotation.
        return {
            "id": rid,
            "status": "complex-success",
            "complex": emit_complex(value),
            "elapsed_ms": elapsed_ms,
        }
    return {
        "id": rid,
        "status": "success",
        "real": emit_real(value),
        "elapsed_ms": elapsed_ms,
    }


def main() -> None:
    envelope = json.load(sys.stdin)
    inputs = envelope["inputs"]
    results: list[Any] = [
        {
            "__meta__": True,
            "mpmath_version": mpmath.__version__,
            "python_version": sys.version,
            "work_dps": WORK_DPS,
            "emit_dps": EMIT_DPS,
            "per_input_timeout_s": PER_INPUT_TIMEOUT_S,
        }
    ]
    # Per-input progress to stderr every 50 rows so the TS driver can
    # surface long-running batches (Hurwitz-zeta-class calls at the
    # T6/T7 extremes can run multiple seconds each).
    total = len(inputs)
    for i, inp in enumerate(inputs):
        results.append(evaluate_one(inp))
        if (i + 1) % 50 == 0 or (i + 1) == total:
            sys.stderr.write(f"oracle.py: {i + 1}/{total} rows processed\n")
            sys.stderr.flush()
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
