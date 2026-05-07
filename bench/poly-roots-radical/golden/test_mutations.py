#!/usr/bin/env python3
"""Mutation-prove harness for the poly-roots-radical verifier.

Per ADR-0019 §4: ≥ 5 perturbations of the reference must produce RED
in the verifier. This file is the operational record.

Run:
    python3 test_mutations.py            # all mutations; prints PASS/FAIL
    python3 test_mutations.py -v         # verbose
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))                            # for verify
sys.path.insert(0, str(HERE.parent / "reference"))       # for reference

from verify import verify                              # noqa: E402
from poly_roots_reference import poly_roots_reference  # noqa: E402


PROBES = {
    "biquadratic":         {"f": "x**4 - 5*x**2 + 4", "var": "x"},  # (x-1)(x+1)(x-2)(x+2)
    "double-root":         {"f": "x**2 - 2*x + 1", "var": "x"},     # (x-1)^2
    "casus-irreducibilis": {"f": "x**3 - 3*x + 1", "var": "x"},     # 3 real, Cardano complex form
    "deg5-refusal":        {"f": "x**5 + 2*x + 2", "var": "x"},     # → tagged
    "linear":              {"f": "2*x + 4", "var": "x"},
}


def _baseline(probe_id: str) -> Dict[str, Any]:
    p = PROBES[probe_id]
    cand = poly_roots_reference(p["f"], p["var"])
    expected = {"kind": cand["kind"]}
    if cand["kind"] == "tagged":
        expected["tag"] = cand["tag"]
    return {"id": probe_id, "input": p, "candidate": cand, "expected": expected}


def _expect_red(case: Dict[str, Any], name: str, *, expected_failed: str = None, verbose: bool) -> bool:
    result = verify(case)
    failed = [k for k, v in result["checks"].items() if not v["pass"]]
    if verbose:
        print(f"  {name:38s} pass={result['pass']!s:5s} failed={failed}")
    if result["pass"]:
        print(f"  ✗ {name}: verifier INCORRECTLY passed mutated output")
        return False
    if expected_failed and expected_failed not in failed:
        print(f"  ⚠ {name}: caught (good) but failing check {failed} != expected {expected_failed!r}")
    return True


def green_baseline(*, verbose: bool) -> bool:
    all_ok = True
    for pid in PROBES:
        case = _baseline(pid)
        result = verify(case)
        if verbose:
            print(f"  green {pid:25s} pass={result['pass']!s:5s} reason={result['reason'][:60]!r}")
        if not result["pass"]:
            failed = [k for k, v in result["checks"].items() if not v["pass"]]
            print(f"  ✗ baseline {pid} FAILED — verifier broken (failed={failed})")
            all_ok = False
    return all_ok


# ---------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------


def mutation_dropped_root(*, verbose: bool) -> bool:
    """Drop one root entry — count_with_multiplicity should fail."""
    case = _baseline("biquadratic")
    case["candidate"]["roots"].pop()
    return _expect_red(case, "dropped_root", expected_failed="count_with_multiplicity", verbose=verbose)


def mutation_wrong_multiplicity(*, verbose: bool) -> bool:
    """For (x-1)^2, report multiplicity=1 instead of 2 — should fail count."""
    case = _baseline("double-root")
    for r in case["candidate"]["roots"]:
        r["multiplicity"] = 1
    return _expect_red(case, "wrong_multiplicity", expected_failed="count_with_multiplicity", verbose=verbose)


def mutation_wrong_root_value(*, verbose: bool) -> bool:
    """Replace one root with the wrong value — each_root_satisfies should fail."""
    case = _baseline("biquadratic")
    case["candidate"]["roots"][0]["root"] = "5"  # not a root of (x²-1)(x²-4)
    return _expect_red(case, "wrong_root_value", expected_failed="each_root_satisfies", verbose=verbose)


def mutation_added_spurious_root(*, verbose: bool) -> bool:
    """Add an extra root not actually in p — should fail count + distinct_match."""
    case = _baseline("biquadratic")
    case["candidate"]["roots"].append({"root": "5", "multiplicity": 1})
    return _expect_red(case, "added_spurious_root", verbose=verbose)


def mutation_lied_about_scope(*, verbose: bool) -> bool:
    """For deg-5 irreducible, return ok with garbage roots instead of refusing."""
    case = _baseline("deg5-refusal")
    # Replace tagged refusal with a fake ok envelope.
    case["candidate"] = {
        "kind": "ok",
        "content": "1",
        "roots": [{"root": "1", "multiplicity": 5}],
        "method": "fabricated",
        "warnings": [],
    }
    return _expect_red(case, "lied_about_scope", expected_failed="shape", verbose=verbose)


def mutation_wrong_refusal_tag(*, verbose: bool) -> bool:
    """For deg-5 input, refuse with the wrong tag class."""
    case = _baseline("deg5-refusal")
    case["candidate"]["tag"] = "poly-roots/non-polynomial"
    return _expect_red(case, "wrong_refusal_tag", expected_failed="refusal_class_matches", verbose=verbose)


def mutation_casus_irreducibilis_wrong(*, verbose: bool) -> bool:
    """For casus-irreducibilis cubic, replace one root with a near-but-wrong
    value. Each-root-satisfies must catch numerically."""
    case = _baseline("casus-irreducibilis")
    # Pick the first root and perturb it slightly (replace with "1").
    case["candidate"]["roots"][0]["root"] = "1"  # 1 is NOT a root of x^3 - 3x + 1
    return _expect_red(case, "casus_irreducibilis_wrong", expected_failed="each_root_satisfies", verbose=verbose)


def mutation_zero_multiplicity(*, verbose: bool) -> bool:
    """A root with multiplicity 0 — shape should reject (positive int required)."""
    case = _baseline("linear")
    case["candidate"]["roots"][0]["multiplicity"] = 0
    return _expect_red(case, "zero_multiplicity", expected_failed="shape", verbose=verbose)


MUTATIONS = [
    ("dropped_root",                 mutation_dropped_root),
    ("wrong_multiplicity",           mutation_wrong_multiplicity),
    ("wrong_root_value",             mutation_wrong_root_value),
    ("added_spurious_root",          mutation_added_spurious_root),
    ("lied_about_scope",             mutation_lied_about_scope),
    ("wrong_refusal_tag",            mutation_wrong_refusal_tag),
    ("casus_irreducibilis_wrong",    mutation_casus_irreducibilis_wrong),
    ("zero_multiplicity",            mutation_zero_multiplicity),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    print("GREEN baseline (reference output → verifier → PASS):")
    if not green_baseline(verbose=args.verbose):
        return 1
    print("  ok\n")

    print(f"RED mutations ({len(MUTATIONS)} characteristic perturbations):")
    failures: List[str] = []
    for name, fn in MUTATIONS:
        if not fn(verbose=args.verbose):
            failures.append(name)
        elif not args.verbose:
            print(f"  ✓ {name}")

    print()
    if failures:
        print(f"FAIL: {len(failures)} mutation(s) NOT caught: {failures}")
        return 1
    print(f"PASS: all {len(MUTATIONS)} mutations RED. Verifier is sensitive.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
