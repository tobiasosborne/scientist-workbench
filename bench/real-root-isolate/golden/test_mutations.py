#!/usr/bin/env python3
"""Mutation-prove harness for the real-root-isolate verifier.

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

from verify import verify                                       # noqa: E402
from real_root_isolate_reference import real_root_isolate_reference  # noqa: E402


PROBES = {
    "casus":          {"f": "x**3 - 3*x + 1", "var": "x"},                   # 3 irrational reals
    "rational-roots": {"f": "(x - 1) * (x - 2) * (x - 3)", "var": "x"},      # 3 rational roots → singletons
    "wilkinson-5":    {"f": "(x - 1)*(x - 2)*(x - 3)*(x - 4)*(x - 5)", "var": "x"},
    "no-real":        {"f": "x**4 + 1", "var": "x"},                         # 0 real roots
    "not-squarefree": {"f": "(x - 1)**2 * (x + 1)", "var": "x"},             # → tagged
    "multivariate":   {"f": "x*y - 1", "var": "x"},                          # → tagged
    "with-zero":      {"f": "x**3 - x", "var": "x"},                         # roots -1, 0, 1
}


def _baseline(probe_id: str) -> Dict[str, Any]:
    p = PROBES[probe_id]
    cand = real_root_isolate_reference(p["f"], p["var"])
    expected = {"kind": cand["kind"]}
    if cand["kind"] == "tagged":
        expected["tag"] = cand["tag"]
    return {"id": probe_id, "input": p, "candidate": cand, "expected": expected}


def _expect_red(case: Dict[str, Any], name: str, *, expected_failed: str = None, verbose: bool) -> bool:
    result = verify(case)
    failed = [k for k, v in result["checks"].items() if not v["pass"]]
    if verbose:
        print(f"  {name:42s} pass={result['pass']!s:5s} failed={failed}")
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


def mutation_dropped_interval(*, verbose: bool) -> bool:
    """Drop one interval — count_matches_total_real_roots fails."""
    case = _baseline("casus")
    case["candidate"]["intervals"].pop()
    return _expect_red(case, "dropped_interval",
                       expected_failed="count_matches_total_real_roots", verbose=verbose)


def mutation_added_spurious_interval(*, verbose: bool) -> bool:
    """Add an extra interval not containing any root — count fails AND
    each_interval may fail (depending on placement)."""
    case = _baseline("casus")
    # Add an interval (10, 20) — no roots there.
    case["candidate"]["intervals"].append({"lo": "10", "hi": "20"})
    return _expect_red(case, "added_spurious_interval", verbose=verbose)


def mutation_widened_to_two_roots(*, verbose: bool) -> bool:
    """Widen one interval to span two roots — each_interval fails."""
    case = _baseline("rational-roots")
    # Original singletons (1,1), (2,2), (3,3); replace first with (0, 3) which spans all 3.
    case["candidate"]["intervals"] = [
        {"lo": "0", "hi": "3"},
        {"lo": "2", "hi": "2"},
        {"lo": "3", "hi": "3"},
    ]
    return _expect_red(case, "widened_to_two_roots",
                       expected_failed="each_interval_contains_one_root", verbose=verbose)


def mutation_overlapping_intervals(*, verbose: bool) -> bool:
    """Two intervals overlap — intervals_disjoint_and_ordered fails."""
    case = _baseline("wilkinson-5")
    # Replace with overlapping intervals (1,1), (1,2), (2,2), (3,3), (4,4) — (1,2) overlaps singletons.
    # The overlap forces hi_2 (=2) > lo_3 (=2)? Actually 2 > 2 is false.
    # Use a stronger overlap: (1,1), (1,3), (2,2), (3,3), (4,4).
    case["candidate"]["intervals"] = [
        {"lo": "1", "hi": "1"},
        {"lo": "1", "hi": "3"},  # overlaps with prev (shared 1) AND next singletons
        {"lo": "2", "hi": "2"},
        {"lo": "3", "hi": "3"},
        {"lo": "4", "hi": "4"},
    ]
    return _expect_red(case, "overlapping_intervals",
                       expected_failed="intervals_disjoint_and_ordered", verbose=verbose)


def mutation_singleton_not_root(*, verbose: bool) -> bool:
    """A singleton interval at a non-root point — each_interval fails."""
    case = _baseline("rational-roots")
    # Original (1,1), (2,2), (3,3). Move first to (5, 5) — 5 is not a root.
    case["candidate"]["intervals"][0] = {"lo": "5", "hi": "5"}
    return _expect_red(case, "singleton_not_root",
                       expected_failed="each_interval_contains_one_root", verbose=verbose)


def mutation_lied_about_scope(*, verbose: bool) -> bool:
    """For a non-squarefree input, fabricate an `ok` envelope instead of refusing."""
    case = _baseline("not-squarefree")
    case["candidate"] = {
        "kind": "ok",
        "intervals": [{"lo": "-2", "hi": "0"}, {"lo": "0", "hi": "2"}],
        "method": "fabricated",
        "warnings": [],
    }
    return _expect_red(case, "lied_about_scope", expected_failed="shape", verbose=verbose)


def mutation_wrong_refusal_tag(*, verbose: bool) -> bool:
    """For a multivariate input, refuse with the wrong tag class."""
    case = _baseline("multivariate")
    case["candidate"]["tag"] = "real-root-isolate/not-squarefree"
    return _expect_red(case, "wrong_refusal_tag",
                       expected_failed="refusal_class_matches", verbose=verbose)


def mutation_reversed_order(*, verbose: bool) -> bool:
    """Intervals in descending order — disjoint_and_ordered fails."""
    case = _baseline("wilkinson-5")
    case["candidate"]["intervals"].reverse()
    return _expect_red(case, "reversed_order",
                       expected_failed="intervals_disjoint_and_ordered", verbose=verbose)


def mutation_endpoint_at_root(*, verbose: bool) -> bool:
    """A non-degenerate interval whose endpoint coincides with a root —
    open-count is 0 even though closed-count is 1. each_interval fails."""
    case = _baseline("with-zero")
    # Original intervals from SymPy include singleton (0, 0). Replace with
    # an interval (-2, 0) that has hi at the root 0; the open part (-2, 0)
    # contains only -1, but with f(0)=0 the open count is 1-1=0... actually
    # wait, count_roots(-2, 0) = 2 (both -1 and 0), minus f(0)=0 → open
    # count = 1. So this case actually PASSES the per-interval check.
    # Use a different perturbation: replace singleton (0, 0) with (0, 0.5)
    # interpreted as (0, 1/2) — open count_roots(0, 1/2) = 0, minus f(0)=0
    # → -1 ≠ 1. Fails.
    intervals = case["candidate"]["intervals"]
    # Find the singleton at 0 and replace with (0, 1/2).
    for entry in intervals:
        if entry["lo"] == "0" and entry["hi"] == "0":
            entry["hi"] = "1/2"
            break
    return _expect_red(case, "endpoint_at_root",
                       expected_failed="each_interval_contains_one_root", verbose=verbose)


MUTATIONS = [
    ("dropped_interval",         mutation_dropped_interval),
    ("added_spurious_interval",  mutation_added_spurious_interval),
    ("widened_to_two_roots",     mutation_widened_to_two_roots),
    ("overlapping_intervals",    mutation_overlapping_intervals),
    ("singleton_not_root",       mutation_singleton_not_root),
    ("lied_about_scope",         mutation_lied_about_scope),
    ("wrong_refusal_tag",        mutation_wrong_refusal_tag),
    ("reversed_order",           mutation_reversed_order),
    ("endpoint_at_root",         mutation_endpoint_at_root),
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
