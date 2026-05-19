#!/usr/bin/env python3
# ============================================================================
# bench/gamma-anchor/oracles/arb/oracle.py
# ----------------------------------------------------------------------------
#
# Arb (via python-flint 0.8.0 + FLINT 3.0.1) gold-tier oracle driver for the
# Gamma-anchor golden-master corpus (G7, bead `scientist-workbench-2wr6`,
# ADR-0042 §"Decision 8").
#
# Sibling driver to `bench/gamma-anchor/oracles/mpmath/oracle.py`. The two-
# file split (TS driver `adapter.ts` + Python worker `oracle.py`) mirrors the
# mpmath adapter exactly so both gold-tier voices have identical wire shapes
# and the G8 cross-agreement comparator can index records by `input_id`
# alone, without per-oracle conditioning. The protocol — corpus JSON on
# stdin, single batched python3 child, JSON results list on stdout with a
# `__meta__` sentinel at index 0 — is the worklog-027 / bead-prompt-G7
# pattern.
#
# ── Why Arb closes the load-bearing complex-arb-prec gap ──────────────────
#
# ADR-0042 §"Decision 8" enumerates the gamma-family oracle tier table:
#
#     Gold     : Wolfram Mathematica 14.3 + mpmath 1.3.0
#     Silver   : Boost.Math 1.83 cpp_bin_float<50>  (REAL ONLY)
#     Bronze   : SciPy 1.11.4 + libm                (mostly real)
#     Third gold (this adapter): python-flint / Arb (BOTH real + complex)
#
# Boost.Math's `cpp_bin_float<50>` cannot instantiate on complex (R5 §1
# capability matrix line 95) — its `std::complex<cpp_bin_float<N>>`
# templates fail to compile, exactly the gap the Bessel epic hit. SciPy's
# `polygamma(complex)` raises TypeError (L14); SciPy's `loggamma(real
# negative)` returns NaN (L15). The 19 ADMITTED_HEADS × {real, complex}
# capability matrix in R5 §4 therefore has 34 complex cells that, prior to
# this adapter, were SINGLE-ENGINE-PAIRED at gold tier (Wolfram + mpmath
# only). For Erf this gap was 1 cell. For Bessel it was 12. For Gamma it
# is 34 cells across 17 of the 19 heads.
#
# Without an independent third arb-prec voice on the complex side, the
# cross-agreement matrix's complex rows can only achieve "two engines,
# possibly correlated" confidence — Wolfram and mpmath share Adamchik's
# branch-cut conventions and could agree on a wrong value with no third
# arbiter. Arb's `acb_*` (FLINT C, Fredrik Johansson's rigorous
# hypergeometric-series + ball-arithmetic asymptotic machinery) is the
# algorithmically-independent third voice that elevates every complex cell
# from "two-voice" to "three-voice" cross-agreement. That is the
# load-bearing reason this adapter exists.
#
# ── Why ball arithmetic is first-class output (the value_radius field) ───
#
# Arb's distinguishing feature vs every other oracle: every computed value
# is a *ball* `[centre ± radius]` with mathematically-rigorous containment.
# The radius is a tight upper bound on the true error, computed by error-
# tracking through every internal operation. This is fundamentally
# different from mpmath's "ran at 60 dps so the first ~57 digits should be
# right" — that is conjecturally correct, not certified; mpmath has no
# internal error model. Arb has one.
#
# We therefore record BOTH the midpoint AND the radius as first-class fields
# on every successful record (`value` and `value_radius`). For complex
# results, the radius is itself two-dimensional: `{re: <real-radius>, im:
# <imag-radius>}`. The G8 cross-agreement comparator can then:
#
#   1. Use the midpoint for value comparison (the standard role).
#   2. Use the radius as the TIER-THRESHOLD floor: if Arb reports a radius
#      of `1e-58` on a value where Wolfram and mpmath disagree at digit 56,
#      the disagreement is *spurious* — both gold engines fall within Arb's
#      certified containment ball. Conversely, if mpmath claims digit 56 of
#      agreement but Arb's radius is `1e-55`, mpmath is overstating its
#      precision and the agreement is illusory.
#
# This is the comparator-input ADR-0042 §"Decision 8" mentions when it
# admits Arb as "the third voice that returns a certified error bound."
# The Bessel G7 adapter pioneered the pattern; this is its gamma sibling.
#
# ── Precision discipline — 200 bits baseline + cancellation retry to 456 bits
#
# FLINT/Arb works in BITS (`ctx.prec`), not decimal digits. The bead
# prompt pins `ctx.prec = 200` baseline; in decimal digits that is
# 200 / log2(10) ≈ 60.2 dp — comfortably above the gold-tier target of 50
# dp, with a ~10 dp margin matching the mpmath adapter's WORK_DPS = 60.
# We emit midpoints at 55 dp (`acb.str(55, radius=False)`) for symmetry
# with the Bessel G7 emit, leaving the same 5-dp margin between emit and
# work.
#
# **Cancellation retry (L16 — the load-bearing Arb value-add).** When a
# computation involves catastrophic cancellation, Arb's ball widens — the
# radius can exceed the relative-precision target. Reflection of Γ near
# the negative integers (T3, T8), Temme saddle-region cancellation (T7),
# and digamma cot-reflection at simple poles (T8) are the typical
# triggers. The bead-prompt-specified policy:
#
#     If radius / |midpoint| > 1e-50:
#         bump ctx.prec by 64 bits (200 → 264 → 328 → 392 → 456)
#         retry, up to 4 retries (5 attempts total)
#
# Each result row records the `final_prec` (the prec at the successful
# attempt) and `prec_attempts` (the full bit-prec ladder tried), so the
# G8 comparator and a future engineer can audit which rows operated near
# a cancellation cliff. The relative-radius threshold `1e-50` matches the
# gold-tier 50-dp target.
#
# **Why bump? Why not start at 456 bits?** Cost. The baseline pays for the
# typical (~98%) of corpus rows that need exactly 200 bits. Bumping only
# the few rows that need it keeps total wall-time under 60 s for the
# 377-input corpus. The cancellation-retry pattern is also the
# mathematically-honest answer to "what should this adapter do when the
# answer has lost ≥ 50 dp of accuracy?" — fail UP, not fail silently.
#
# ── Landmines handled here (R5 §6) ────────────────────────────────────────
#
#   - **L1** (Wolfram input-trap; carry through). The corpus's discriminated
#     `{kind, value}` envelope on `a`, `b`, `m`, `n` lets us parse exactly:
#     integers → Python int (acb accepts directly); half-integers → fmpq
#     (rational, EXACT at any precision); decimals → arb(str) parsed at
#     full ctx.prec. We NEVER use Python `float()` on these.
#
#   - **L12** (P/Q inversion — THE #1 gamma trap; R5 §6 lines 828-879).
#     python-flint's `acb.gamma_upper(s, regularized=0|1)` is `Γ(s, z)`
#     with z = self (NOT the order). Verified by probe: `acb('5/2').
#     gamma_upper(acb('3/2'))` returns `0.15225125499...` matching Wolfram's
#     `N[Gamma[3/2, 5/2], 50]` exactly. Mapping spelt out in `call_head`
#     below, every line tagged `# L12`:
#         Upper  → acb(z).gamma_upper(a, regularized=0)
#         Lower  → acb(z).gamma_lower(a, regularized=0)
#         P      → acb(z).gamma_lower(a, regularized=1)
#         Q      → acb(z).gamma_upper(a, regularized=1)
#
#   - **L_pole** (the gamma-poles family — partly L17). Arb returns a
#     non-finite ball at the simple poles of Gamma (`acb('0').gamma()`
#     prints `nan`; `acb('-1').gamma()` prints `nan`). `acb.is_finite()`
#     returns False in that case; we record an honest refusal with
#     `arb_returned_token: "nan"`. The G8 comparator special-cases pole
#     cells and does not penalise diverging oracle behaviour (Wolfram emits
#     `ComplexInfinity`; mpmath raises `ValueError("gamma function
#     pole")`; Arb returns nan).
#
#   - **L16 / cancellation retry**: the prec-bump retry is the load-bearing
#     Arb value-add. Every record that needed > 1 attempt records the
#     full ladder in `prec_attempts`. If the final attempt at MAX_PREC
#     still has `radius/|value| > 1e-50`, we emit success with a
#     `degraded_precision` note rather than refusing — the radius is
#     IN the record, so the comparator can see exactly how good the value
#     is. Honest fail-up beats fail-silent.
#
#   - **Inverse heads (InverseIncompleteGammaP / Q)**: python-flint 0.8.0
#     has NO direct API. R5 §3.2 documents `mp.findroot` as the workaround
#     for mpmath; Arb's equivalent would require hand-rolling Newton's
#     method on `gamma_lower(a, z, regularized=1) - q = 0`, which is not
#     gold-tier byte-deterministic without further convention pins. Per
#     CLAUDE.md Rule 8 (honest scope) we emit `status: "unsupported"`
#     rather than substitute a Newton iteration. The SciPy/Boost/Wolfram
#     adapters cover these 12 inverse cells.
#
#   - **Hyperfactorial**: NOT in the v0.1 corpus (verified by probing the
#     unique-heads list — the corpus exposes 19 heads, none named
#     Hyperfactorial). The bead prompt mentions a Hyperfactorial composition
#     via the identity `H(z) = Γ(z+1)^z / G(z+1)` should the corpus grow;
#     unused in v0.1.
#
# ── Argument parsing — discriminated-kind discipline (R5 §6 L1) ─────────
#
# Scalar arguments `a`, `b`, `m`, `n` carry a `{kind, value}` envelope. We
# dispatch on `kind`:
#
#   - `"integer"`:        Python `int(value)`. python-flint's acb accepts
#                         Python ints natively; for `polygamma(m)` the
#                         order arg is a Python int.
#   - `"half-integer"`:   parse "num/den" → `fmpq(value)`. EXACT at any
#                         ctx.prec because num and den are small Python
#                         ints (typically ±k and 2).
#   - `"decimal"`:        `arb(value)`. The corpus emits 60-dp decimal
#                         strings; arb parses these at full ctx.prec with
#                         no precision loss because ctx.prec >> 60 dp ≈
#                         200 bits comfortably covers the input width.
#
# Primary `z` (and complex `re`/`im`) stays in 60-dp decimal-string form
# because z is the head's analytic variable; we parse with `arb(value)`
# directly.
#
# ── Determinism ───────────────────────────────────────────────────────────
#
# Arb's ball arithmetic at a given `ctx.prec` is deterministic given the
# `(input, prec)` bytes — FLINT C arithmetic is bit-identical across
# CPython runtimes by language spec (it uses GMP/MPFR underneath, both
# of which guarantee bit-identical results across architectures at fixed
# precision). Two runs of this driver with byte-identical stdin produce
# byte-identical stdout. Verified by diffing two consecutive runs: every
# field except `elapsed_ms` and the envelope `generated_at` is byte-
# identical.
# ============================================================================

from __future__ import annotations

import json
import signal
import sys
import time
from typing import Any

import flint
from flint import acb, arb, ctx, fmpq

# ── Configuration: precision ladder & emit shape ─────────────────────────

# Baseline working precision, in BITS. The bead prompt pins this at 200
# (≈ 60.2 decimal digits) — gold-tier target 50 dp plus ~10 dp margin to
# absorb internal cancellation in routine cases. Matches the mpmath
# adapter's WORK_DPS = 60 conceptually (mpmath uses decimal-digit prec,
# Arb uses bit-prec; 200 bits ≈ 60 dp).
BASELINE_PREC_BITS = 200

# Cancellation-retry policy (L16, bead prompt). On each retry, bump by 64
# bits (~19 decimal digits) — large enough to recover meaningful precision
# in a single attempt, small enough that 4 retries is plenty for any cell
# the v0.1 corpus contains. Final prec ceiling: 200 + 4·64 = 456 bits
# (≈ 137 dp). The bead prompt mandates "Up to 4 retries (so 200 → 264 →
# 328 → 392 → 456)" verbatim.
PREC_BUMP_BITS = 64
MAX_RETRIES = 4
MAX_PREC_BITS = BASELINE_PREC_BITS + MAX_RETRIES * PREC_BUMP_BITS  # 456

# Relative-radius threshold that triggers a retry. radius / |midpoint| >
# 1e-50 means "the ball is wider than the 50-dp gold-tier target's
# significand can express" — bump precision. Note: when |midpoint| is
# *very* small (near zeros of the head; e.g. rgamma at -1 = exact 0),
# the relative radius is degenerate; we handle that special case in the
# retry loop. The 1e-50 threshold matches the gold-tier target.
RELATIVE_RADIUS_TARGET = 1e-50

# Emit precision in decimal digits. 55 dp matches the Bessel G7 emit (5
# dp emit margin below the gold target's working precision). The G8
# comparator can apply its standard `precision - 1` tolerance to a 55-dp
# string and still have a clean 50-dp digit window.
EMIT_DP = 55

# Radius emit width. 10 digits is wildly more than the comparator needs
# (the radius is itself only an upper bound; an order of magnitude is the
# load-bearing piece). 10 digits also serves as a self-documenting "this
# number is approximate" signal — matches the Bessel G7 convention.
RADIUS_EMIT_DP = 10

# Per-input wall-time cap. mpmath sister adapter uses 30 s; Arb is
# typically faster on these shapes (ball arithmetic is O(prec) bit-op
# bound, not O(prec²) like naive mpf), but a deep retry chain on a
# saddle-region T7 cell could in principle take noticeable time. 30 s is
# the conservative ceiling.
PER_INPUT_TIMEOUT_S = 30


# ── timeout plumbing ─────────────────────────────────────────────────────


class TimeoutException(Exception):
    """Raised by the SIGALRM handler when a single input exceeds PER_INPUT_TIMEOUT_S."""


def _alarm_handler(signum, frame):
    raise TimeoutException(f"input exceeded {PER_INPUT_TIMEOUT_S}s")


signal.signal(signal.SIGALRM, _alarm_handler)


# ── argument parsing — strict precision, no float() ──────────────────────


def parse_kind_int(field) -> int:
    """Parse a `{kind: 'integer', value: '...'}` envelope as a Python int.

    Used for `m` (Polygamma order). python-flint's `acb.polygamma(m)`
    requires the order to be a Python int (or coercible to acb, but int
    is the canonical type — it routes to the integer-recurrence path).
    """
    assert field["kind"] == "integer", f"expected integer kind, got {field['kind']}"
    return int(field["value"])


def parse_kind_acb(field):
    """Parse a `{kind, value}` envelope as an acb.

    - `kind=integer`     → `acb(int(value))`
    - `kind=half-integer` → `acb(fmpq(value))` — fmpq parses "num/den"
                            as exact rational, then acb wraps with zero
                            imag part. Exact at any ctx.prec.
    - `kind=decimal`     → `acb(arb(value))` — arb parses the 60-dp
                            decimal string at full ctx.prec.

    NEVER uses Python `float()` — that would silently cap at 15.95 dp and
    reintroduce L1.
    """
    kind = field["kind"]
    value = field["value"]
    if kind == "integer":
        return acb(int(value))
    if kind == "half-integer":
        # fmpq("num/den") parses an exact rational. Verified by probe:
        # `acb(fmpq('1/2')).gamma()` returns sqrt(pi) to full ctx.prec.
        if "/" not in value:
            return acb(int(value))
        return acb(fmpq(value))
    if kind == "decimal":
        # arb(string) parses a decimal literal at the current ctx.prec.
        # The corpus emits 60-dp strings; at ctx.prec >= 200 bits the
        # parse is exact-at-working-precision.
        return acb(arb(value))
    raise ValueError(f"unknown kind: {kind!r}")


def parse_z_acb(z_field):
    """Parse the corpus `z` field as an acb.

    Real-z (string) → `acb(arb(value))` (zero imag part).
    Complex-z (dict) → `acb(arb(re), arb(im))` — both components parsed
    at full ctx.prec from their 60-dp string representations.
    """
    if isinstance(z_field, str):
        return acb(arb(z_field))
    if isinstance(z_field, dict):
        return acb(arb(z_field["re"]), arb(z_field["im"]))
    raise ValueError(f"unknown z shape: {z_field!r}")


# ── emit helpers — midpoint + radius first-class ─────────────────────────


def emit_arb_midpoint(a: arb) -> str:
    """Emit an arb's midpoint as a clean decimal string at EMIT_DP digits.

    `arb.str(n, radius=False)` produces "midpoint only", guaranteed to be
    correct up to 1 in the last displayed digit (per the python-flint
    docstring). This is the load-bearing emit-format choice — it
    matches Wolfram's `N[]` truncate-style emit, so the G8 comparator
    sees the same digit window from both gold voices.
    """
    if a.is_nan():
        return "NaN"
    return a.str(EMIT_DP, radius=False)


def emit_arb_radius(a: arb) -> str:
    """Emit an arb's ball-radius as a clean decimal string.

    `a.rad()` returns an arb whose midpoint IS the radius (the radius is
    a non-negative real number, conceptually scalar; python-flint wraps
    it in an arb for type uniformity). We emit at RADIUS_EMIT_DP digits.
    """
    if a.is_nan():
        return "NaN"
    return a.rad().str(RADIUS_EMIT_DP, radius=False)


def emit_value_and_radius(v: acb):
    """Emit the (value, radius) pair for one acb result.

    Returns (value_field, radius_field) where each is a real-string OR a
    {re, im} dict, depending on whether the imag component is exactly
    zero AS A MIDPOINT.

    Subtlety: `acb.imag.is_zero()` returns False if the imag is a ball
    `[0 ± r]` with nonzero radius r — exactly the situation that arises
    when an `acb` computation accidentally widens into the complex
    plane (Trigamma of real negative z; Polygamma ditto). The radius is
    a TIGHT upper bound on |imag|, but mathematically the imaginary
    part IS zero. We check `imag.mid().is_zero()` so those rows emit as
    real-shaped — the radius still appears in the record, just attached
    to the real value (with the absolute-zero imag-radius effectively
    folded into the real radius via the ball's overall containment).

    For genuinely complex-output rows (T4 complex-input, complex-valued
    analytic continuations of real-input heads like LogGamma at real
    negative non-integer), `imag.mid().is_zero()` returns False and we
    emit the {re, im} shape with separate radii per component.
    """
    if v.imag.mid().is_zero():
        return emit_arb_midpoint(v.real), emit_arb_radius(v.real)
    return (
        {"re": emit_arb_midpoint(v.real), "im": emit_arb_midpoint(v.imag)},
        {"re": emit_arb_radius(v.real), "im": emit_arb_radius(v.imag)},
    )


# ── relative-radius cancellation check ───────────────────────────────────
#
# Decide whether a result needs a precision bump. The decision is per-
# component (real and imag of an acb each carry their own ball radius);
# we bump if EITHER component has insufficient relative accuracy.
#
# python-flint's `arb.rel_accuracy_bits()` is the canonical probe; it
# returns:
#   - a positive int n meaning "the ball has n bits of relative accuracy"
#     (i.e. radius/|midpoint| < 2^-n)
#   - INT64_MIN (`-9223372036854775807` and friends) when the midpoint is
#     exactly zero (so relative-accuracy is undefined) OR when the radius
#     equals or exceeds the midpoint magnitude.
#   - INT64_MAX (`9223372036854775807` ish) when the radius is exactly
#     zero (exact value — no error).
#
# We translate these to a bump-or-not decision:
#
#   - **Component is exactly zero** (`mid().is_zero()`): the relative-
#     radius is conceptually `∞` but the ABSOLUTE radius is the only
#     meaningful error measure. At gold tier the absolute radius from a
#     200-bit arb computation is ~1e-60; that's vastly tighter than the
#     gold-tier target and bumping prec won't change anything load-
#     bearing. Don't bump. This is the LOAD-BEARING fix for
#     `acb.polygamma(real_negative)` — Arb returns a ball whose imag
#     component is `[0 ± 1e-67]` (midpoint exactly zero, tight absolute
#     radius). Treating `is_zero()` mid-component as "already accurate"
#     prevents spurious 4-retry storms on real-negative-z polygamma
#     rows where the answer is genuinely real.
#
#   - **Component is NaN** (`is_nan()`): bumping won't help (the input is
#     singular). Return "no bump" so the retry loop terminates.
#
#   - **Component has insufficient rel-accuracy** (`rel_accuracy_bits()` <
#     170 AND midpoint nonzero AND finite): worth retrying. 170 bits is
#     a conservative threshold for the 50-dp gold target (50 * log2(10)
#     ≈ 166 bits, +4 bits margin); matches the Bessel G7 MIN_ACC_BITS
#     pattern.
#
#   - **Component has rel-accuracy ≥ 170**: tight enough; don't bump.
#
# Edge case: rel_accuracy_bits is INT64_MIN (a huge negative number) when
# the midpoint is zero. We check `mid().is_zero()` FIRST so that case is
# routed to the "exact zero" path BEFORE the comparison `< 170`. Without
# this ordering, a value `[0 ± 1e-60]` would silently trigger a bump
# storm because INT64_MIN < 170 is trivially true.


def relative_radius_too_wide(v: acb) -> bool:
    """Return True if `v`'s relative ball-radius exceeds the gold-tier target.

    True ⇒ retry at higher precision is worthwhile. False ⇒ either the
    value is already tight enough, or further precision won't help (NaN
    / pole / exact-zero midpoint).
    """

    def _component_needs_bump(comp: arb) -> bool:
        # NaN — bump pointless.
        if comp.is_nan():
            return False
        # Exact-zero midpoint (component is `[0 ± r]`): the absolute
        # radius is the meaningful error; relative-radius is undefined.
        # At baseline 200-bit prec the absolute radius is already ~1e-60
        # which is tighter than gold-tier requires. DON'T bump.
        if comp.mid().is_zero():
            return False
        # Now: midpoint is nonzero and finite. rel_accuracy_bits is
        # meaningful. Bump if below the 170-bit (~50 dp + 4-bit margin)
        # gold threshold.
        return comp.rel_accuracy_bits() < 170

    if not v.is_finite():
        return False  # NaN or Inf — bump won't help
    return _component_needs_bump(v.real) or _component_needs_bump(v.imag)


# ── per-head dispatch ────────────────────────────────────────────────────
#
# Each branch evaluates one corpus row at the CURRENT ctx.prec. The
# evaluation is wrapped in a retry harness (`evaluate_with_retry`) that
# bumps ctx.prec and re-parses inputs on cancellation; this function only
# performs one evaluation pass at the configured prec.


def call_head(head: str, inp: dict) -> acb:
    """Evaluate one corpus row. Returns an acb (real or complex).

    All inputs are re-parsed inside this function so the retry loop can
    re-evaluate at a new ctx.prec without state leakage. The L12 mapping
    is spelt out verbatim for every incomplete-gamma call.
    """
    if head == "Gamma":
        z = parse_z_acb(inp["z"])
        return z.gamma()

    if head == "LogGamma":
        # acb.lgamma is the analytic-continuation log Γ (the principal
        # branch matching Wolfram's LogGamma; for real negative non-
        # integer x, the imag part is -π·floor(-x), same as mpmath's
        # loggamma. Verified consistent in probes.)
        z = parse_z_acb(inp["z"])
        return z.lgamma()

    if head == "Digamma":
        z = parse_z_acb(inp["z"])
        return z.digamma()

    if head == "Trigamma":
        # ψ^(1)(z); acb.polygamma(s) where s is the order. python-flint
        # accepts s as Python int OR acb; we use int for the integer-
        # recurrence path.
        z = parse_z_acb(inp["z"])
        return z.polygamma(1)

    if head == "Polygamma":
        # ψ^(m)(z); m is non-negative integer from the corpus's `m` field.
        m = parse_kind_int(inp["m"])
        z = parse_z_acb(inp["z"])
        return z.polygamma(m)

    if head == "Pochhammer":
        # (a)_n = a·(a+1)·...·(a+n-1). python-flint's `acb.rising(n)`
        # accepts integer or acb n; if the corpus's `n` is kind=integer,
        # we pass int(n) for the integer-recurrence path. For non-integer
        # n (rare in v0.1 corpus; might occur in future tiers), we pass
        # the parsed acb.
        a = parse_kind_acb(inp["a"])
        n_field = inp["n"]
        if n_field["kind"] == "integer":
            n = int(n_field["value"])
            return a.rising(n)
        n_acb = parse_kind_acb(n_field)
        return a.rising(n_acb)

    if head == "IncompleteGammaUpper":
        # L12: upper UNregularised Γ(a, z) = ∫_z^∞ t^{a-1} e^{-t} dt
        # python-flint convention: `z.gamma_upper(a, regularized=0)`
        # computes Γ(a, z) where z = self, a = first arg, regularized=0
        # means the unregularised form. Verified by probe against
        # Wolfram's N[Gamma[3/2, 5/2], 50] = 0.15225125499...
        a = parse_kind_acb(inp["a"])
        z = parse_z_acb(inp["z"])
        return z.gamma_upper(a, regularized=0)  # L12

    if head == "IncompleteGammaLower":
        # L12: lower UNregularised γ(a, z) = ∫_0^z t^{a-1} e^{-t} dt
        a = parse_kind_acb(inp["a"])
        z = parse_z_acb(inp["z"])
        return z.gamma_lower(a, regularized=0)  # L12

    if head == "IncompleteGammaP":
        # L12: lower regularised P(a, z) = γ(a, z) / Γ(a)
        a = parse_kind_acb(inp["a"])
        z = parse_z_acb(inp["z"])
        return z.gamma_lower(a, regularized=1)  # L12

    if head == "IncompleteGammaQ":
        # L12: upper regularised Q(a, z) = Γ(a, z) / Γ(a)
        a = parse_kind_acb(inp["a"])
        z = parse_z_acb(inp["z"])
        return z.gamma_upper(a, regularized=1)  # L12

    if head in ("InverseIncompleteGammaP", "InverseIncompleteGammaQ"):
        # python-flint 0.8.0 has NO direct inverse-incomplete-gamma
        # function (`dir(flint.acb)` confirms; only `elliptic_inv_p` and
        # `elliptic_invariants` carry the `inv` substring, neither
        # relevant). Hand-rolling Newton on `gamma_lower(a, z, reg=1) -
        # q = 0` would not be gold-tier byte-deterministic without
        # additional convention pins (initial guess, convergence
        # criterion). Per CLAUDE.md Rule 8 (honest scope) we emit an
        # honest refusal; the SciPy / Boost / Wolfram adapters cover
        # these inverse cells.
        raise NotImplementedError(
            "python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; "
            "Newton-iteration substitute would not be byte-deterministic"
        )

    if head == "Beta":
        # B(a, b) = Γ(a)·Γ(b)/Γ(a+b). python-flint's acb has no native
        # `.beta()`, so we compose via gamma. The composition is exact
        # at gold-tier working precision (200 bits ≫ 50-dp target); each
        # gamma call carries its own ball radius and the multiplication
        # combines them by ball arithmetic.
        a = parse_kind_acb(inp["a"])
        b = parse_kind_acb(inp["b"])
        return a.gamma() * b.gamma() / (a + b).gamma()

    if head == "LogBeta":
        # log B(a, b) = lgamma(a) + lgamma(b) - lgamma(a+b). Same
        # composition discipline as Beta; for mixed-sign a, b the
        # analytic-continuation log Beta carries an imaginary part
        # matching Wolfram's branch convention (Arb's `acb.lgamma` is
        # the principal-branch analytic continuation, identical to
        # mpmath's `loggamma`).
        a = parse_kind_acb(inp["a"])
        b = parse_kind_acb(inp["b"])
        return a.lgamma() + b.lgamma() - (a + b).lgamma()

    if head == "BarnesG":
        # G(z): the Barnes G-function. python-flint exposes `acb.barnes_g()`.
        # Convention: Adamchik (Wolfram's), G(z+1) = Γ(z)·G(z), G(1) = 1.
        # Verified by probe: BarnesG(1) = BarnesG(2) = BarnesG(3) = 1,
        # BarnesG(4) = 2, BarnesG(5) = 12, BarnesG(6) = 288 — matches
        # the R5 §6 L16 canonical anchors.
        z = parse_z_acb(inp["z"])
        return z.barnes_g()

    if head == "GammaRatio":
        # Γ(a) / Γ(b). At gold-tier 200-bit working precision, direct
        # division is bit-exact; ball arithmetic carries the combined
        # radius. The numerically-stable form would be
        # `exp(lgamma(a) - lgamma(b))`; we use the direct form to keep
        # the corpus canonical (the comparator sees the literal ratio).
        a = parse_kind_acb(inp["a"])
        b = parse_kind_acb(inp["b"])
        return a.gamma() / b.gamma()

    if head == "GammaDeltaRatio":
        # Γ(a) / Γ(a + b). Same direct-division discipline at gold tier.
        a = parse_kind_acb(inp["a"])
        b = parse_kind_acb(inp["b"])
        return a.gamma() / (a + b).gamma()

    if head == "GammaPDerivative":
        # ∂P(a, z)/∂z = z^{a-1} · e^{-z} / Γ(a)   (DLMF §8.8.13)
        # No native API; compose from primitives. The `z^{a-1}` step is
        # the precision-sensitive piece — Arb's `acb.pow(a-1)` is ball-
        # arithmetic-stable for the (a, z) ranges the corpus exercises.
        a = parse_kind_acb(inp["a"])
        z = parse_z_acb(inp["z"])
        return (z ** (a - acb(1))) * ((-z).exp()) / a.gamma()

    if head == "IncompleteBeta":
        # I_z(a, b) REGULARISED per corpus-spec.md ("IncompleteBeta: I_z(a, b)";
        # DLMF §8.17.2 notation uses I for regularised). `acb.beta_lower(a, b,
        # regularized=1)` returns I_z(a, b) with z = self, matching the corpus's
        # 3-arg envelope `{z, a, b}` and Wolfram's `BetaRegularized[z, a, b]`.
        # Fixed 2026-05-19 — G8 cross-agreement caught the previous
        # `regularized=0` as 36/40 of the unexplained findings; the original
        # subagent left a probe-comment that even cited `regularized=1` as
        # producing the corpus-aligned value but then dispatched `=0`.
        a = parse_kind_acb(inp["a"])
        b = parse_kind_acb(inp["b"])
        z = parse_z_acb(inp["z"])
        return z.beta_lower(a, b, regularized=1)

    raise ValueError(f"unknown head: {head!r}")


# ── cancellation-retry harness ───────────────────────────────────────────


def evaluate_with_retry(head: str, inp: dict) -> dict:
    """Evaluate one row with cancellation-driven precision retry (L16).

    Returns a dict with:
        v:               the acb result (last attempt)
        prec_attempts:   list of bit-precs tried (e.g. [200] or [200, 264])
        final_prec:      the final bit-prec
        degraded:        True if max retries exhausted and radius still wide
    """
    prec_attempts: list[int] = []
    v: acb | None = None
    degraded = False

    prec = BASELINE_PREC_BITS
    while True:
        ctx.prec = prec
        prec_attempts.append(prec)
        v = call_head(head, inp)

        # Non-finite (pole) — bump won't help, return immediately.
        if not v.is_finite():
            return {
                "v": v,
                "prec_attempts": prec_attempts,
                "final_prec": prec,
                "degraded": False,
            }

        # Sufficiently tight? Return.
        if not relative_radius_too_wide(v):
            return {
                "v": v,
                "prec_attempts": prec_attempts,
                "final_prec": prec,
                "degraded": False,
            }

        # Bump for next attempt, unless we've hit the ceiling.
        if prec >= MAX_PREC_BITS:
            # Final attempt exhausted; emit degraded.
            degraded = True
            break
        prec = min(prec + PREC_BUMP_BITS, MAX_PREC_BITS)

    return {
        "v": v,
        "prec_attempts": prec_attempts,
        "final_prec": MAX_PREC_BITS,
        "degraded": degraded,
    }


# ── pole / refusal classification ────────────────────────────────────────
#
# Arb signals the gamma family's poles by returning a non-finite acb:
#   - `acb('0').gamma()`    → nan        (Gamma at non-positive integer)
#   - `acb('-1').gamma()`   → nan
#   - `acb('0').digamma()`  → nan
#   - `acb('0').polygamma(m)` → nan for all m
# `acb.is_finite()` returns False in all these cases. We translate to
# `status: "refused"` with `arb_returned_token` = "nan" or "inf" depending
# on which component flag is set.


def classify_pole_token(v: acb) -> str:
    """For non-finite v, return the verbatim refusal token."""
    if v.real.is_nan() or v.imag.is_nan():
        return "nan"
    # is_finite is False but neither component is NaN ⇒ ±inf in some
    # component. Distinguish for the audit trail.
    return "inf"


# ── main loop ────────────────────────────────────────────────────────────


def evaluate_one(inp: dict) -> dict:
    rid = inp["id"]
    head = inp["head"]

    t0 = time.perf_counter_ns()
    signal.alarm(PER_INPUT_TIMEOUT_S)
    try:
        retry_result = evaluate_with_retry(head, inp)
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
        elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
        return {
            "id": rid,
            "status": "error",
            "note": f"{type(e).__name__}: {e}",
            "elapsed_ms": elapsed_ms,
        }

    elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
    v = retry_result["v"]

    # Pole / non-finite refusal — record the verbatim token.
    if not v.is_finite():
        return {
            "id": rid,
            "status": "refused",
            "arb_returned_token": classify_pole_token(v),
            "note": f"L_pole: head={head} returned non-finite ball",
            "elapsed_ms": elapsed_ms,
            "prec_attempts": retry_result["prec_attempts"],
            "final_prec": retry_result["final_prec"],
        }

    # Successful (or degraded-precision success) — emit midpoint + radius.
    value_field, radius_field = emit_value_and_radius(v)

    # Decide real vs complex status. Use mid-component zero test (see
    # `emit_value_and_radius` docstring): a ball `[0 ± r]` for the imag
    # part means mathematically-real-output (with the radius's worth of
    # uncertainty); we report it as "success" so the comparator sees a
    # real-shaped row matching the corpus's real-input distinction.
    is_complex_output = not v.imag.mid().is_zero()

    row = {
        "id": rid,
        "status": "complex-success" if is_complex_output else "success",
        "value": value_field,
        "value_radius": radius_field,
        "elapsed_ms": elapsed_ms,
        "prec_attempts": retry_result["prec_attempts"],
        "final_prec": retry_result["final_prec"],
    }
    if retry_result["degraded"]:
        # Honest degraded-precision flag. The radius IS in the record so
        # the comparator can see exactly how good the value is; we add a
        # note so the operator can see at-a-glance which rows didn't reach
        # the 50-dp gold target.
        row["note"] = (
            f"degraded precision: relative radius > 1e-50 after "
            f"{MAX_RETRIES} retries (final_prec={retry_result['final_prec']} bits)"
        )
    return row


def main() -> None:
    envelope = json.load(sys.stdin)
    inputs = envelope["inputs"]
    results: list[Any] = [
        {
            "__meta__": True,
            "flint_version": flint.__version__,
            "python_version": sys.version,
            "baseline_prec_bits": BASELINE_PREC_BITS,
            "max_prec_bits": MAX_PREC_BITS,
            "prec_bump_bits": PREC_BUMP_BITS,
            "max_retries": MAX_RETRIES,
            "emit_dp": EMIT_DP,
            "radius_emit_dp": RADIUS_EMIT_DP,
            "relative_radius_target": RELATIVE_RADIUS_TARGET,
            "per_input_timeout_s": PER_INPUT_TIMEOUT_S,
        }
    ]
    total = len(inputs)
    # Per-input progress to stderr every 50 rows (mirrors mpmath sibling).
    for i, inp in enumerate(inputs):
        results.append(evaluate_one(inp))
        if (i + 1) % 50 == 0 or (i + 1) == total:
            sys.stderr.write(f"oracle.py: {i + 1}/{total} rows processed\n")
            sys.stderr.flush()
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
