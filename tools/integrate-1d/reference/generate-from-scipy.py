#!/usr/bin/env python3
"""
generate-from-scipy.py — ground-truth golden generator for tools/integrate-1d

Runs each test case through SciPy's `scipy.integrate.quad` (which wraps
QUADPACK's QAGS Fortran routine — the canonical adaptive Gauss-Kronrod
G7K15 implementation) and emits a JSON manifest of expected values for
the TS implementation to match.

This is the *orthogonal oracle*: completely different language
(Fortran), completely different codebase (QUADPACK from netlib),
decades of scientific use. The TS implementation must produce values
matching this manifest within the documented tolerance — it cannot
generate its own expected values.

For the hardest cases (oscillatory, near-singular), `mpmath.quad` at
50-digit precision is run as a *cross-validator*. If SciPy and mpmath
disagree by more than a tight tolerance, the case is flagged with a
`reference_disagreement` warning in the manifest.

Output: a single JSON document (manifest.json) emitted on stdout.
Run:  python3 generate-from-scipy.py > manifest.json
"""
import json
import math
import sys
import warnings

import scipy.integrate as si
import mpmath as mp


# -----------------------------------------------------------------------------
# Test corpus — 30 cases spanning easy-to-nasty
# Verified against SciPy/QUADPACK and (for hard cases) mpmath at 50 digits.
# -----------------------------------------------------------------------------

# Each case: (id, description, f, [a, b], category, kind, expected_refusal_reason?)
# kind is "value" or "refusal"; for "refusal" we don't run the integral.

CASES = [
    # --- Category 1: Smooth easy ---
    ("01-smooth-poly-quad",        "degree-4 polynomial",          lambda x: x**4 - 2*x**2 + 1,                  0.0, 2.0,           "smooth-easy",           "value"),
    ("02-smooth-exp-linear",       "exp(x) on [0,1]",              lambda x: math.exp(x),                        0.0, 1.0,           "smooth-easy",           "value"),
    ("03-smooth-trig-sin",         "sin(x) on [0,pi]",             lambda x: math.sin(x),                        0.0, math.pi,       "smooth-easy",           "value"),
    ("04-smooth-poly-cubic",       "odd cubic on symmetric interval", lambda x: x**3 - x,                        -1.0, 1.0,          "smooth-easy",           "value"),
    ("05-smooth-exp-cos",          "exp(x)*cos(x) on [0,pi/2]",    lambda x: math.exp(x) * math.cos(x),          0.0, math.pi/2,     "smooth-easy",           "value"),
    # --- Category 2: Smooth hard ---
    ("06-smooth-narrow-gauss",     "narrow Gaussian peak",         lambda x: math.exp(-100*(x - 0.5)**2),        0.0, 1.0,           "smooth-hard",           "value"),
    ("07-smooth-product-peak",     "Genz product peak (1D)",       lambda x: 1.0 / (0.04 + (x - 0.5)**2),        0.0, 1.0,           "smooth-hard",           "value"),
    ("08-smooth-corner-peak",      "Genz corner peak (1D)",        lambda x: 1.0 / (1 + 6*x)**2,                 0.0, 1.0,           "smooth-hard",           "value"),
    ("09-smooth-c0-exponential",   "Genz C0 family (1D, kink at 0.4)", lambda x: math.exp(-15 * abs(x - 0.4)),   0.0, 1.0,           "smooth-hard",           "value"),
    ("10-smooth-high-freq-trig",   "sin(30x)*exp(-x) on [0,pi]",   lambda x: math.sin(30*x) * math.exp(-x),      0.0, math.pi,       "smooth-hard",           "value"),
    # --- Category 3: Standard test families ---
    ("11-genz-oscillatory",        "Genz oscillatory family (1D)", lambda x: math.cos(2*math.pi*0.5 + 3*x),      0.0, 1.0,           "standard-family",       "value"),
    ("12-genz-discontinuous",      "Genz discontinuous (truncated to support)", lambda x: math.exp(2*x),         0.0, 0.6,           "standard-family",       "value"),
    ("13-quadpack-qag-example",    "QUADPACK QAG ex.: 2/(2+sin(10*pi*x))", lambda x: 2.0 / (2 + math.sin(10*math.pi*x)), 0.0, 1.0,   "standard-family",       "value"),
    ("14-davis-rabinowitz-log",    "log(x+1) on [0,1] (D&R baseline)", lambda x: math.log(x + 1),                0.0, 1.0,           "standard-family",       "value"),
    ("15-patterson-algebraic",     "1/(1+x^2) on [0,1] = pi/4",    lambda x: 1.0 / (1 + x**2),                   0.0, 1.0,           "standard-family",       "value"),
    ("16-squire-trig-product",     "sin(x)^2*cos(x) on [0,pi/2]",  lambda x: math.sin(x)**2 * math.cos(x),       0.0, math.pi/2,     "standard-family",       "value"),
    # --- Category 4: Non-smooth interior ---
    ("17-kink-abs-centre",         "|x - 0.3| kink interior",      lambda x: abs(x - 0.3),                       0.0, 1.0,           "nonsmooth-interior",    "value"),
    ("18-kink-abs-double",         "|x-0.7| + |x-0.3| (two kinks)", lambda x: abs(x - 0.7) + abs(x - 0.3),       0.0, 1.0,           "nonsmooth-interior",    "value"),
    ("19-near-sing-interior",      "1/sqrt(|x-0.5|+0.01) (cusp)",  lambda x: 1.0 / math.sqrt(abs(x - 0.5) + 0.01), 0.0, 1.0,         "nonsmooth-interior",    "value"),
    # --- Category 5: Oscillatory but bounded ---
    ("20-osc-sin-k20-fullperiods", "sin(20x) on [0,2pi] = 0",      lambda x: math.sin(20*x),                     0.0, 2*math.pi,     "oscillatory",           "value"),
    ("21-osc-sin-k7-partial",      "sin(7x) on [0,1]",             lambda x: math.sin(7*x),                      0.0, 1.0,           "oscillatory",           "value"),
    ("22-osc-cos-exp-decay",       "cos(10x)*exp(-x) on [0,pi]",   lambda x: math.cos(10*x) * math.exp(-x),      0.0, math.pi,       "oscillatory",           "value"),
    # --- Category 6: Boundary-of-scope refusals ---
    # We do NOT run SciPy on these — the manifest just records the expected refusal reason.
    ("23-refuse-pole-interior",    "1/(x-0.5) — +Inf at x=0.5",    None,                                          0.0, 1.0,           "refusal",               "refusal", "non-finite-during-eval"),
    ("24-refuse-log-negative",     "log(x-0.5) — NaN for x<0.5",   None,                                          0.0, 1.0,           "refusal",               "refusal", "non-finite-during-eval"),
    ("25-refuse-degenerate-empty", "a == b empty interval",        None,                                          1.0, 1.0,           "refusal",               "refusal", "degenerate-interval"),
    ("26-refuse-reversed-interval","a > b reversed",               None,                                          2.0, 0.0,           "refusal",               "refusal", "degenerate-interval"),
    ("27-refuse-sqrt-negative",    "sqrt(x-0.5) — NaN for x<0.5",  None,                                          0.0, 1.0,           "refusal",               "refusal", "non-finite-during-eval"),
    # --- Category 7: Timing stress (still in scope; should converge or honestly say not-converged) ---
    ("28-stress-ultra-narrow-gauss", "exp(-1e6*(x-0.5)^2) — ultra-narrow peak", lambda x: math.exp(-1e6*(x - 0.5)**2), 0.0, 1.0,    "timing-stress",         "value"),
    ("29-stress-high-freq-osc",      "sin(1000x) on [0,1] — ~160 half-periods", lambda x: math.sin(1000*x),                0.0, 1.0,    "timing-stress",         "value"),
    ("30-stress-two-scale",          "exp(-x) + exp(-1000(x-0.8)^2) two scales", lambda x: math.exp(-x) + math.exp(-1000*(x-0.8)**2), 0.0, 1.0, "timing-stress",         "value"),
]

# Cross-validation list: for these cases, also compute via mpmath at 50 digits
# and flag disagreement. These are the cases where double-precision QUADPACK
# may already be at the edge of its accuracy.
CROSS_VALIDATE = {
    "06-smooth-narrow-gauss",
    "07-smooth-product-peak",
    "10-smooth-high-freq-trig",
    "11-genz-oscillatory",
    "13-quadpack-qag-example",
    "19-near-sing-interior",
    "20-osc-sin-k20-fullperiods",
    "21-osc-sin-k7-partial",
    "22-osc-cos-exp-decay",
    "28-stress-ultra-narrow-gauss",
    "29-stress-high-freq-osc",
    "30-stress-two-scale",
}


def mpmath_quad(case_id, f_py, a, b):
    """Compute the integral via mpmath at 50-digit precision."""
    mp.mp.dps = 50  # 50 decimal digits

    # mpmath wants the function in mpmath types, but for these test
    # functions, calling f_py with an mpmath number works because Python's
    # math module operations broadcast (via __float__) — except the math.X
    # functions return floats. So we re-implement in mpmath terms per case:
    redefs = {
        "06-smooth-narrow-gauss":     lambda x: mp.exp(-100*(x - mp.mpf("0.5"))**2),
        "07-smooth-product-peak":     lambda x: 1 / (mp.mpf("0.04") + (x - mp.mpf("0.5"))**2),
        "10-smooth-high-freq-trig":   lambda x: mp.sin(30*x) * mp.exp(-x),
        "11-genz-oscillatory":        lambda x: mp.cos(2*mp.pi*mp.mpf("0.5") + 3*x),
        "13-quadpack-qag-example":    lambda x: 2 / (2 + mp.sin(10*mp.pi*x)),
        "19-near-sing-interior":      lambda x: 1 / mp.sqrt(abs(x - mp.mpf("0.5")) + mp.mpf("0.01")),
        "20-osc-sin-k20-fullperiods": lambda x: mp.sin(20*x),
        "21-osc-sin-k7-partial":      lambda x: mp.sin(7*x),
        "22-osc-cos-exp-decay":       lambda x: mp.cos(10*x) * mp.exp(-x),
        "28-stress-ultra-narrow-gauss": lambda x: mp.exp(-mp.mpf("1e6")*(x - mp.mpf("0.5"))**2),
        "29-stress-high-freq-osc":      lambda x: mp.sin(1000*x),
        "30-stress-two-scale":          lambda x: mp.exp(-x) + mp.exp(-1000*(x - mp.mpf("0.8"))**2),
    }
    if case_id not in redefs:
        return None
    f_mp = redefs[case_id]
    val = mp.quad(f_mp, [mp.mpf(a), mp.mpf(b)])
    return float(val)


def encode_float64_bits(x):
    """Match the workbench's float64 wire encoding: 16-char lowercase hex of IEEE-754 bits."""
    import struct
    bits = struct.unpack(">Q", struct.pack(">d", x))[0]
    return f"{bits:016x}"


def main():
    manifest = {
        "_meta": {
            "tool": "integrate-1d",
            "reference": "scipy.integrate.quad (QUADPACK QAGS, Fortran)",
            "scipy_version": __import__("scipy").__version__,
            "cross_validator": "mpmath.quad at 50-digit precision",
            "mpmath_version": mp.__version__,
            "n_cases": len(CASES),
            "n_cross_validated": sum(1 for c in CASES if c[0] in CROSS_VALIDATE),
            "purpose": (
                "Orthogonal oracle for the TypeScript pure-TS adaptive "
                "Gauss-Kronrod implementation in tools/integrate-1d. "
                "The TS impl must match these values within the documented "
                "tolerance; it MUST NOT generate its own expected values."
            ),
            "tolerance_recommendation": {
                "smooth-easy":          {"atol": "1e-12", "rtol": "1e-12"},
                "smooth-hard":          {"atol": "1e-9",  "rtol": "1e-9"},
                "standard-family":      {"atol": "1e-9",  "rtol": "1e-9"},
                "nonsmooth-interior":   {"atol": "1e-7",  "rtol": "1e-7"},
                "oscillatory":          {"atol": "1e-9",  "rtol": "1e-9"},
                "timing-stress":        {"atol": "1e-3",  "rtol": "1e-3", "note": "may report converged=false; in that case match within reported error_estimate"},
            },
        },
        "cases": [],
    }

    for case in CASES:
        case_id, desc, f_py, a, b, category, kind = case[:7]
        entry = {
            "id": case_id,
            "description": desc,
            "category": category,
            "interval": {"a": a, "b": b, "a_bits": encode_float64_bits(a), "b_bits": encode_float64_bits(b)},
            "kind": kind,
        }
        if kind == "refusal":
            entry["expected_refusal_reason"] = case[7]
        else:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=si.IntegrationWarning)
                value, abserr = si.quad(f_py, a, b, limit=500)
            entry["scipy"] = {
                "value": value,
                "value_bits": encode_float64_bits(value),
                "abserr": abserr,
                "abserr_bits": encode_float64_bits(abserr),
            }
            if case_id in CROSS_VALIDATE:
                try:
                    mp_val = mpmath_quad(case_id, f_py, a, b)
                    diff = abs(value - mp_val)
                    rel_diff = diff / max(abs(mp_val), 1e-300)
                    entry["mpmath"] = {
                        "value": mp_val,
                        "value_bits": encode_float64_bits(mp_val),
                        "diff_vs_scipy": diff,
                        "rel_diff_vs_scipy": rel_diff,
                    }
                    if diff > max(1e-10, 100*abserr):
                        entry["reference_disagreement"] = {
                            "scipy": value, "mpmath": mp_val, "abs_diff": diff,
                            "comment": "SciPy and mpmath disagree beyond expected tolerance — investigate before trusting this golden",
                        }
                except Exception as e:
                    entry["mpmath_error"] = str(e)
        manifest["cases"].append(entry)

    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
