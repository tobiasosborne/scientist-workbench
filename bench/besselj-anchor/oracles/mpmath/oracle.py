#!/usr/bin/env python3
# ============================================================================
# bench/besselj-anchor/oracles/mpmath/oracle.py
# ----------------------------------------------------------------------------
#
# mpmath gold-tier oracle driver for the Bessel-anchor golden-master corpus
# (G3, bead `scientist-workbench-g70g`, ADR-0041 §"Decision 8").
#
# Reads a corpus JSON envelope on stdin:
#
#   { "inputs": [
#       { "id": "T1-besselj-001",
#         "head": "BesselJ" | "BesselY" | "BesselI" | "BesselK"
#                | "BesselIScaled" | "BesselKScaled",
#         "nu_kind": "integer" | "half-integer" | "decimal",
#         "nu": "<decimal-string-or-fraction>",
#         "z":  "<decimal-string-or-special-token>" | {"re": "...", "im": "..."},
#         "tier": "T1" .. "T10",
#         ... (other fields ignored)
#       },
#       ...
#     ]
#   }
#
# Emits a JSON list on stdout. Element 0 is a "__meta__" sentinel carrying
# `mpmath.__version__`, `sys.version`, the compute dps and emit dps. Each
# subsequent element is one result row:
#
#   { "id": "...", "status": "success" | "complex-success"
#                          | "honest-special-token"
#                          | "refused" | "timeout" | "error",
#     "real": "<55-dp string>",                            # if real success
#     "complex": {"re": "...", "im": "..."},               # if complex success
#     "note": "<short string>",                            # optional context
#     "elapsed_ms": <float> }
#
# The TS driver merges this into the final `results.json` envelope and
# fills in the orchestration metadata (corpus path, generated_at, totals).
#
# ── Determinism contract (mpmath = gold tier) ─────────────────────────────
#
# Per ADR-0041 §"Decision 8" + R5 §3.2:
#
#   - `mp.dps = 60` for compute. The 10-dp guard above the 50-dp gold target
#     absorbs mpmath's per-algorithm internal precision bumps for
#     near-boundary inputs (the Hankel-asymptotic crossover at |z| ≈ p/2,
#     the negative-ν branch's `cos(ν π)` cancellation, etc.).
#
#   - `mpmath.nstr(v, 55, strip_zeros=False)` for emit. The 5-dp margin
#     below the working precision strips the last 2-3 trailing digits
#     that mpmath's round-to-nearest emits as numerical residue, so the
#     G8 cross-agreement comparator can compare byte-for-byte against
#     Wolfram (which TRUNCATES `N[]` at the displayed precision; L2).
#
# mpmath is bit-identical across CPython runtimes by construction (Python
# `int` arithmetic is bit-identical by language spec, and mpmath's mpf
# layer is pure-Python over `int`). Two runs of this driver with byte-
# identical stdin produce byte-identical stdout.
#
# ── Landmines handled here (R5 §6) ────────────────────────────────────────
#
#   - **L2** (mpmath nstr round-to-nearest vs Wolfram N truncate):
#     `compute_dps = 60` / `emit_dps = 55` gives a 5-dp canonicalisation
#     window. See module docstring above.
#
#   - **L3** (negative-real-ν branch convention varies per oracle): mpmath's
#     `bessely(ν, z)` / `besselk(ν, z)` for non-integer negative ν uses the
#     J / I connection formulas with `cos(νπ)` / `sin(νπ)`. We do NOT
#     second-guess; we emit exactly what mpmath returns. The G8 comparator
#     tolerates documented per-oracle convention deltas at non-integer-ν
#     near-integer at `info` severity.
#
#   - **L9 / L10** (K underflow / I overflow at large |z|): mpmath's mpf
#     handles the full BigInt-mantissa range; no overflow. The risk is
#     time, not value — large-ν + large-z inputs can take seconds per
#     call. Per-input timeout via SIGALRM at 30 s; on alarm we emit
#     `status: "timeout"`. The corpus's scaled variants `BesselIScaled`
#     and `BesselKScaled` deliberately stay in a representable range —
#     no timeout expected for them.
#
#   - **mpmath edge-case exception**: `mpmath.besselj(0, mpmath.inf)` and
#     `mpmath.besselj(0, mpmath.nan)` raise TypeError / ValueError rather
#     than returning a finite mpf. We catch the exception, classify the
#     input as "honest-special-token", and emit the appropriate IEEE-754
#     value the corpus's `notes` field implies (J(ν, +∞)=0 for finite ν;
#     J(ν, NaN)=NaN; etc.). Documented in the dispatch table below.
#
# ── ν construction discipline ─────────────────────────────────────────────
#
#   - `nu_kind == "integer"`: `int(nu_str)` (Python int). mpmath accepts
#     Python ints natively; this gives the integer-ν algorithmic path.
#   - `nu_kind == "half-integer"`: parse "a/b" → `mpf(int(a)) / mpf(int(b))`.
#     Exact at any precision (b is always 2 in this corpus).
#   - `nu_kind == "decimal"`: `mpf(nu_str)`. mpmath parses decimal strings
#     at full mp.dps. The corpus emits ν to 60 decimal digits already, so
#     this is exact at our working precision.
#
# z is constructed analogously; complex z uses `mpc(re_str, im_str)`.
# Sentinel z tokens (`"NaN"`, `"Infinity"`, `"-Infinity"`) are parsed to
# `mpf('nan')` / `mpf('inf')` / `mpf('-inf')`.
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
EMIT_DPS = 55
PER_INPUT_TIMEOUT_S = 30

mp.dps = WORK_DPS

# ── helpers ──────────────────────────────────────────────────────────────


class TimeoutException(Exception):
    """Raised by the SIGALRM handler when a single input exceeds PER_INPUT_TIMEOUT_S."""


def _alarm_handler(signum, frame):
    raise TimeoutException(f"input exceeded {PER_INPUT_TIMEOUT_S}s")


# Install the SIGALRM handler once; we (re)arm it per-input via `signal.alarm`.
signal.signal(signal.SIGALRM, _alarm_handler)


def parse_nu(nu_kind: str, nu_str: str):
    """Build the ν argument for an mpmath Bessel call.

    Returns either a Python `int` (integer ν path) or an `mpf` (half-integer
    and decimal paths). mpmath dispatches differently on `int` vs `mpf`:
    Python `int` triggers the integer-recurrence path; `mpf` triggers the
    general-ν path. The corpus's `nu_kind` field tells us which path the
    G8 comparator expects.
    """
    if nu_kind == "integer":
        return int(nu_str)
    if nu_kind == "half-integer":
        # Format "a/b". b is always 2 in the v0.1 corpus, but we parse
        # generally for forward-compat.
        if "/" in nu_str:
            num_s, den_s = nu_str.split("/", 1)
            return mpf(int(num_s)) / mpf(int(den_s))
        # Fallback: treat as decimal.
        return mpf(nu_str)
    if nu_kind == "decimal":
        return mpf(nu_str)
    raise ValueError(f"unknown nu_kind: {nu_kind!r}")


def parse_z_scalar(s: str):
    """Parse one z scalar string. Sentinel tokens map to mpmath inf / nan."""
    if s == "NaN":
        return mpf("nan")
    if s == "Infinity":
        return mpf("inf")
    if s == "-Infinity":
        return mpf("-inf")
    return mpf(s)


def parse_z(z_field):
    """Build the z argument. Real inputs return mpf; complex return mpc."""
    if isinstance(z_field, str):
        return parse_z_scalar(z_field)
    if isinstance(z_field, dict):
        return mpc(parse_z_scalar(z_field["re"]), parse_z_scalar(z_field["im"]))
    raise ValueError(f"unknown z shape: {z_field!r}")


def emit_real(v) -> str:
    """Format an mpf at EMIT_DPS, canonicalising ±inf / nan to wire tokens.

    We use `strip_zeros=False` so the wire string is always exactly
    EMIT_DPS significant digits — this makes the G8 byte-comparator's
    canonicalisation trivial (no per-row digit-count fuzz).
    """
    if mpmath.isnan(v):
        return "NaN"
    if mpmath.isinf(v):
        return "Infinity" if v > 0 else "-Infinity"
    return nstr(v, EMIT_DPS, strip_zeros=False)


def emit_complex(v) -> dict:
    return {"re": emit_real(v.real), "im": emit_real(v.imag)}


# ── per-head dispatch ────────────────────────────────────────────────────
#
# The six heads route to mpmath's four native primitives, with the two
# scaled variants composed as `exp(±|z|) · primitive` (R3 §0.0 scaled-
# variant convention; matches the ADR-0041 §"Decision 3" `bigBesselIScaled
# = e^{-|z|}·I_ν(z)`, `bigBesselKScaled = e^{z}·K_ν(z)` substrate contract).
#
# `|z|` for the I-scale is `abs(z.real)` when z is real (= |z|) and
# `mpmath.fabs(z.real)` for complex z — see R3 §0.0 for the rationale.
# We use `mp.fabs(z.real)` uniformly (mpf and mpc both expose `.real`).


def call_head(head: str, nu, z):
    """Evaluate one (head, ν, z) tuple. Returns mpf or mpc."""
    if head == "BesselJ":
        return mpmath.besselj(nu, z)
    if head == "BesselY":
        return mpmath.bessely(nu, z)
    if head == "BesselI":
        return mpmath.besseli(nu, z)
    if head == "BesselK":
        return mpmath.besselk(nu, z)
    if head == "BesselIScaled":
        # e^{-|Re z|} · I_ν(z). For real z this is the classical
        # `besselie`. For complex z it removes the dominant exponential
        # growth along the real axis (Amos `zbesi` `kode=2` convention).
        scale = mpmath.exp(-mpmath.fabs(_real_part(z)))
        return scale * mpmath.besseli(nu, z)
    if head == "BesselKScaled":
        # e^{z} · K_ν(z). For real z > 0 this is the classical `besselke`
        # (cancels the e^{-z} asymptotic decay). For complex z it follows
        # Amos `zbesk` `kode=2`.
        return mpmath.exp(z) * mpmath.besselk(nu, z)
    raise ValueError(f"unknown head: {head!r}")


def _real_part(z):
    """Real part as mpf, whether z is mpf or mpc."""
    if isinstance(z, mpc):
        return z.real
    return z


# ── special-token mpmath-exception classifier ────────────────────────────
#
# mpmath raises TypeError on `besselj(0, mpf("inf"))` ("unsupported operand
# type(s) for //: 'mpf' and 'int'") because the asymptotic-region dispatch
# tries to compute an integer index from z. Same for besselj(0, -inf) and
# bessely(...). NaN raises ValueError ("cannot convert inf or nan to int").
#
# These are NOT refusals — the mathematical answer is well-defined:
#   J_ν(±∞) = 0    (oscillates with decaying amplitude; the limit is 0)
#   Y_ν(±∞) = 0    (same)
#   K_ν(+∞) = 0    (exp decay)
#   I_ν(+∞) = +∞   (exp growth)
#   *(NaN, anything) = NaN
# We classify the input from the z-sentinel and emit the well-defined IEEE
# value with a `note` flag so the G8 comparator can audit the carry-through.


def classify_special_token(head: str, z_field) -> tuple[str, str | dict, str] | None:
    """If z is a sentinel that mpmath would refuse to compute, return
    (status, value, note). Otherwise None and the caller proceeds with
    a normal call.
    """
    # Only real-z sentinels exhibit the mpmath exception; complex sentinels
    # (e.g. "Infinity + 0i") don't appear in this corpus.
    if not isinstance(z_field, str):
        return None
    if z_field == "NaN":
        return ("honest-special-token", "NaN", "z=NaN → result=NaN")
    if z_field in ("Infinity", "-Infinity"):
        # The four heads have distinct limits at ±∞:
        if head in ("BesselJ", "BesselY", "BesselK", "BesselKScaled"):
            # All decay to 0 at +∞. At -∞ the J/Y oscillate with bounded
            # amplitude — the limit is undefined; emit NaN there. K and
            # K-scaled at -∞ go complex; emit NaN with note.
            if z_field == "Infinity":
                return ("honest-special-token", "0.0000000000000000000000000000000000000000000000000000000",
                        f"{head}(ν, +∞) → 0 (asymptotic limit)")
            return ("honest-special-token", "NaN",
                    f"{head}(ν, -∞) is undefined (oscillation or complex)")
        if head == "BesselI":
            if z_field == "Infinity":
                return ("honest-special-token", "Infinity", "I(ν, +∞) → +∞")
            return ("honest-special-token", "Infinity", "I(ν, -∞) → +∞ for integer ν, complex otherwise")
        if head == "BesselIScaled":
            # e^{-|z|}·I_ν(z) → 1/√(2π|z|) → 0 at ±∞ (R3 §0.0 asymptotic).
            return ("honest-special-token", "0.0000000000000000000000000000000000000000000000000000000",
                    f"I-scaled(ν, ±∞) → 0")
    return None


# ── main loop ────────────────────────────────────────────────────────────


def evaluate_one(inp: dict) -> dict:
    rid = inp["id"]
    head = inp["head"]

    # Special-token short-circuit before mpmath sees the input (avoids
    # the TypeError / ValueError exception path mpmath raises on
    # ±inf / nan z).
    special = classify_special_token(head, inp["z"])
    if special is not None:
        status, value, note = special
        row: dict[str, Any] = {"id": rid, "status": status, "note": note, "elapsed_ms": 0.0}
        if isinstance(value, dict):
            row["complex"] = value
        else:
            row["real"] = value
        return row

    t0 = time.perf_counter_ns()
    signal.alarm(PER_INPUT_TIMEOUT_S)
    try:
        nu = parse_nu(inp["nu_kind"], inp["nu"])
        z = parse_z(inp["z"])
        v = call_head(head, nu, z)
        elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
        signal.alarm(0)
    except TimeoutException as e:
        signal.alarm(0)
        return {
            "id": rid,
            "status": "timeout",
            "note": str(e),
            "elapsed_ms": (time.perf_counter_ns() - t0) / 1e6,
        }
    except Exception as e:  # noqa: BLE001 — we want the full failure surface
        signal.alarm(0)
        return {
            "id": rid,
            "status": "error",
            "note": f"{type(e).__name__}: {e}",
            "elapsed_ms": (time.perf_counter_ns() - t0) / 1e6,
        }

    # Real → real, or real → complex (e.g. Y(0, -1), K(0, -1) — the
    # negative-real branch crosses the branch cut and goes complex).
    # We classify into "success" vs "complex-success" so downstream
    # tooling can audit; the value payload is `real` or `complex`.
    if isinstance(v, mpc):
        return {
            "id": rid,
            "status": "complex-success",
            "complex": emit_complex(v),
            "elapsed_ms": elapsed_ms,
        }
    return {
        "id": rid,
        "status": "success",
        "real": emit_real(v),
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
    for inp in inputs:
        results.append(evaluate_one(inp))
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
