#!/usr/bin/env python3
"""Mutation-prove harness for the alg-num-arith verifier.

Per ADR-0019 §4: ≥ 5 perturbations of the reference must produce
RED in the verifier. This file is the operational record.

Run:
    python3 test_mutations.py            # all mutations; prints PASS/FAIL
    python3 test_mutations.py -v         # verbose
"""
from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))                            # for verify
sys.path.insert(0, str(HERE.parent / "reference"))       # for reference

from verify import verify                                # noqa: E402
from alg_num_arith_reference import oracle_compute       # noqa: E402


# ---------------------------------------------------------------------
# Wire-encoding helpers
# ---------------------------------------------------------------------


def root_val(coefs: List[int], k: int) -> Dict[str, Any]:
    return {
        "kind": "expression",
        "head": "Root",
        "args": [
            {
                "kind": "expression",
                "head": "Polynomial",
                "args": [{"kind": "integer", "value": str(c)} for c in coefs],
            },
            {"kind": "integer", "value": str(k)},
        ],
    }


def _oracle_to_candidate(oracle_out: Dict[str, Any]) -> Dict[str, Any]:
    """Convert oracle output to the candidate wire shape that verify
    expects."""
    if oracle_out["kind"] == "boolean":
        return {"kind": "boolean", "value": oracle_out["value"]}
    if oracle_out["kind"] == "tagged":
        return {
            "kind": "tagged",
            "tag": oracle_out["tag"],
            "payload": {
                "kind": "record",
                "fields": {"detail": {"kind": "string", "value": oracle_out["detail"]}},
            },
        }
    # ok arithmetic — convert minpoly + k to wire shape.
    # oracle returns coefs HIGH-to-low (sympy convention); wire is LOW-to-high.
    coefs_high_to_low = oracle_out["result_minpoly_high_to_low"]
    coefs_low_to_high = list(reversed(coefs_high_to_low))
    return root_val(coefs_low_to_high, oracle_out["result_k"])


# ---------------------------------------------------------------------
# Probes — each is a (a, b?, op) input + an expected kind
# ---------------------------------------------------------------------


SQRT2  = root_val([-2, 0, 1], 1)
NEG_SQRT2 = root_val([-2, 0, 1], 0)
SQRT3  = root_val([-3, 0, 1], 1)
ZERO   = root_val([0, 1], 0)
ONE    = root_val([-1, 1], 0)


PROBES: Dict[str, Dict[str, Any]] = {
    "add-sqrt2-sqrt3":  {"a": SQRT2, "b": SQRT3, "op": "add"},
    "mul-sqrt2-sqrt3":  {"a": SQRT2, "b": SQRT3, "op": "mul"},
    "neg-sqrt2":        {"a": SQRT2,             "op": "neg"},
    "inv-sqrt2":        {"a": SQRT2,             "op": "inv"},
    "eq-sqrt2-sqrt2":   {"a": SQRT2, "b": SQRT2, "op": "eq"},
    "inv-of-zero":      {"a": ZERO,              "op": "inv"},
}


def _baseline(probe_id: str) -> Dict[str, Any]:
    inp = PROBES[probe_id]
    a = inp["a"]
    b = inp.get("b")
    op = inp["op"]
    oracle_out = oracle_compute(a, b, op)
    cand = _oracle_to_candidate(oracle_out)
    if oracle_out["kind"] == "ok":
        expected: Dict[str, Any] = {"kind": "ok"}
    elif oracle_out["kind"] == "boolean":
        expected = {"kind": "boolean", "value": oracle_out["value"]}
    else:
        expected = {"kind": "tagged", "tag": oracle_out["tag"]}
    return {"id": probe_id, "input": inp, "candidate": cand, "expected": expected}


def _expect_red(case: Dict[str, Any], name: str, *,
                expected_failed: Optional[str] = None,
                verbose: bool) -> bool:
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


def mutation_wrong_minpoly_coef(*, verbose: bool) -> bool:
    """Replace a coefficient of the result's minpoly — vanishes_at_op_value
    must catch (since the perturbed polynomial no longer vanishes at √2+√3)."""
    case = _baseline("add-sqrt2-sqrt3")
    # The canonical result is x⁴ − 10x² + 1 (k=3). Change the constant term.
    case["candidate"]["args"][0]["args"][0]["value"] = "2"
    return _expect_red(case, "wrong_minpoly_coef",
                       expected_failed="vanishes_at_op_value", verbose=verbose)


def mutation_wrong_k_index(*, verbose: bool) -> bool:
    """Use the wrong k for the same minpoly — index_matches_real_position must
    catch (the candidate's claimed real root is one of the conjugates, not √2+√3)."""
    case = _baseline("add-sqrt2-sqrt3")
    # Canonical k=3 (largest, ≈ 3.146); claim k=0 (smallest, ≈ −3.146).
    case["candidate"]["args"][1]["value"] = "0"
    return _expect_red(case, "wrong_k_index",
                       expected_failed="index_matches_real_position", verbose=verbose)


def mutation_reducible_minpoly(*, verbose: bool) -> bool:
    """Return a reducible polynomial as the minpoly — canonical_form must catch."""
    case = _baseline("mul-sqrt2-sqrt3")
    # Canonical √2·√3 = Root[x²−6, k=1]. Mutate to (x²−6)(x²+1) = x⁴ − 5x² − 6
    # — reducible, but the FIRST factor still vanishes at √6 numerically.
    # Only canonical_form catches this.
    case["candidate"]["args"][0]["args"] = [
        {"kind": "integer", "value": "-6"},
        {"kind": "integer", "value": "0"},
        {"kind": "integer", "value": "-5"},
        {"kind": "integer", "value": "0"},
        {"kind": "integer", "value": "1"},
    ]
    case["candidate"]["args"][1]["value"] = "1"  # adjust k since deg changed
    return _expect_red(case, "reducible_minpoly",
                       expected_failed="canonical_form", verbose=verbose)


def mutation_wrong_eq_value(*, verbose: bool) -> bool:
    """Flip the boolean for an eq case — matches_oracle must catch."""
    case = _baseline("eq-sqrt2-sqrt2")
    case["candidate"]["value"] = False
    return _expect_red(case, "wrong_eq_value",
                       expected_failed="matches_oracle", verbose=verbose)


def mutation_lied_about_scope(*, verbose: bool) -> bool:
    """For inv(0), fabricate a Root[] arithmetic answer instead of refusing."""
    case = _baseline("inv-of-zero")
    case["expected"] = {"kind": "tagged", "tag": "alg-num-arith/inv-of-zero"}
    case["candidate"] = root_val([0, 1], 0)  # claim inv(0) = 0 (lying)
    return _expect_red(case, "lied_about_scope",
                       expected_failed="shape", verbose=verbose)


def mutation_wrong_refusal_tag(*, verbose: bool) -> bool:
    """For inv(0), refuse with the wrong tag class."""
    case = _baseline("inv-of-zero")
    case["candidate"]["tag"] = "alg-num-arith/div-by-zero"
    return _expect_red(case, "wrong_refusal_tag",
                       expected_failed="refusal_class_matches", verbose=verbose)


def mutation_negative_leading_coef(*, verbose: bool) -> bool:
    """Negate every coefficient — canonical_form's positive-leading check
    catches even though the negated polynomial has the same roots."""
    case = _baseline("neg-sqrt2")
    args = case["candidate"]["args"][0]["args"]
    for c in args:
        c["value"] = str(-int(c["value"]))
    return _expect_red(case, "negative_leading_coef",
                       expected_failed="canonical_form", verbose=verbose)


def mutation_non_primitive(*, verbose: bool) -> bool:
    """Multiply every coefficient by 2 — canonical_form's primitive check
    catches (gcd of coefficients = 2, not 1)."""
    case = _baseline("inv-sqrt2")
    args = case["candidate"]["args"][0]["args"]
    for c in args:
        c["value"] = str(int(c["value"]) * 2)
    return _expect_red(case, "non_primitive",
                       expected_failed="canonical_form", verbose=verbose)


MUTATIONS = [
    ("wrong_minpoly_coef",      mutation_wrong_minpoly_coef),
    ("wrong_k_index",           mutation_wrong_k_index),
    ("reducible_minpoly",       mutation_reducible_minpoly),
    ("wrong_eq_value",          mutation_wrong_eq_value),
    ("lied_about_scope",        mutation_lied_about_scope),
    ("wrong_refusal_tag",       mutation_wrong_refusal_tag),
    ("negative_leading_coef",   mutation_negative_leading_coef),
    ("non_primitive",           mutation_non_primitive),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    print("GREEN baseline (oracle-derived candidate → verifier → PASS):")
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


_ = copy  # quiet linter
if __name__ == "__main__":
    sys.exit(main())
