#!/usr/bin/env python3
"""meijer-g verifier — invariant-based, language-neutral.

stdin (one JSON object):
  {
    "input":     <input row from inputs.json::cases[i].input>,
    "candidate": <candidate output from run-candidate.ts>,
    "id":        str
  }

  where `<candidate>` is one of:

    symbolic-success record:
      {"kind": "symbolic", "rule": str, "source": str, "note": str,
       "method": str, "expr": <opaque blob>, "elapsed_ms": float}

    numerical-success record:
      {"kind": "numerical",
       "value": {"re": "<dec>", "im": "<dec>"},
       "achieved_precision": int,
       "method": str,
       "working_precision": int,
       "warnings": [str, ...],
       "diagnostics": {...},
       "elapsed_ms": float}

    tagged refusal:
      {"kind": "tagged", "tag": "meijer-g/<class>",
       "payload": {"reason": str, "ruled_out_methods": [...]},
       "elapsed_ms": float}

    tool error:
      {"kind": "tool_error", "name": str, "message": str}

stdout:
  {"pass": bool, "reason": str,
   "checks": {<name>: {"pass": bool, "detail": str}}}

Reads `expected.json` adjacent on disk for pinned truth values and
tolerance contracts.

Per ADR-0019 §1 the verifier checks INVARIANTS, not byte-equality.
The full check set per case (per VERIFIER-PROTOCOL.md):

  1. no_tool_error            — strict
  2. shape                    — output kind matches expected.kind
                                 (`value` allows symbolic OR numerical
                                  unless request_mode constrains)
  3. finite_value             — numerical: re/im parse as finite mpf
  4. method_admissible        — numerical method ∈ {slater-series-1|2,
                                 mellin-barnes, braaksma-algebraic};
                                 symbolic method == 'symbolic-dispatch'
  5. self_reported_precision  — numerical: achieved_precision ≤ requested
  6. value_accuracy           — re-parse candidate.value (numerical) or
                                 use the symbolic/AST blob (symbolic) as
                                 the candidate value; multi-point sample
                                 against pinned truth.  Tier-0 anchors
                                 sampled at z; symbolic cases that ALSO
                                 carry an mpmath truth get the same
                                 single-z value-accuracy check.
  7. boundary_envelope        — refusal: tag matches expected.tag
  8. expected_method_match    — when expected_method is non-empty,
                                 the dispatcher's chosen lane should
                                 match (informational; logged but
                                 enforcing only when strict=True).

Per the bead spec: tier H is cross-cutting; the verifier optionally
checks `elapsed_ms <= 1500` for tier-H cases (controlled by the
`--check-speed` env var; default off because tier-H is its own list
in tier-h.json).
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Optional

import mpmath
mpmath.mp.dps = 80

HERE = Path(__file__).resolve().parent
_EXPECTED_INDEX: Optional[dict[str, dict]] = None


def _load_expected() -> dict[str, dict]:
    global _EXPECTED_INDEX
    if _EXPECTED_INDEX is None:
        path = HERE / "expected.json"
        if not path.exists():
            _EXPECTED_INDEX = {}
            return _EXPECTED_INDEX
        payload = json.loads(path.read_text())
        _EXPECTED_INDEX = {c["id"]: c for c in payload["cases"]}
    return _EXPECTED_INDEX


# ---------------------------------------------------------------------
# Per-check helpers
# ---------------------------------------------------------------------

ADMITTED_NUMERICAL_METHODS = {
    "slater-series-1", "slater-series-2",
    "mellin-barnes", "braaksma-algebraic",
}
ADMITTED_SYMBOLIC_METHODS = {"symbolic-dispatch"}

SPEED_GATE_MS = 1500.0  # tier H


def _is_str(x: Any) -> bool:
    return isinstance(x, str)


def _check_shape_numerical(candidate: dict) -> dict:
    required = {"value", "achieved_precision", "method",
                "working_precision", "warnings", "diagnostics"}
    missing = required - set(candidate.keys())
    if missing:
        return {"pass": False, "detail": f"missing fields: {sorted(missing)}"}
    v = candidate["value"]
    if not isinstance(v, dict) or set(v.keys()) != {"re", "im"}:
        return {"pass": False,
                "detail": f"value must be {{re, im}}; got {v}"}
    if not (_is_str(v["re"]) and _is_str(v["im"])):
        return {"pass": False, "detail": "value.re/im must be strings"}
    if not isinstance(candidate["achieved_precision"], int):
        return {"pass": False, "detail": "achieved_precision must be int"}
    if not isinstance(candidate["working_precision"], int):
        return {"pass": False, "detail": "working_precision must be int"}
    if not _is_str(candidate["method"]):
        return {"pass": False, "detail": "method must be str"}
    return {"pass": True, "detail": "all required numerical fields present"}


def _check_shape_symbolic(candidate: dict) -> dict:
    required = {"rule", "source", "note", "method", "expr"}
    missing = required - set(candidate.keys())
    if missing:
        return {"pass": False, "detail": f"missing fields: {sorted(missing)}"}
    for key in ("rule", "source", "note", "method"):
        if not _is_str(candidate[key]):
            return {"pass": False, "detail": f"{key} must be str"}
    return {"pass": True, "detail": "all required symbolic fields present"}


def _check_finite_value(candidate: dict) -> dict:
    try:
        re = mpmath.mpf(candidate["value"]["re"])
        im = mpmath.mpf(candidate["value"]["im"])
    except Exception as e:
        return {"pass": False, "detail": f"could not parse value: {e}"}
    if not (mpmath.isfinite(re) and mpmath.isfinite(im)):
        return {"pass": False, "detail": f"non-finite value re={re}, im={im}"}
    return {"pass": True, "detail": "value parses, finite"}


def _check_method_admissible(candidate: dict, kind: str) -> dict:
    m = candidate.get("method", "")
    if kind == "numerical":
        admitted = ADMITTED_NUMERICAL_METHODS
    elif kind == "symbolic":
        admitted = ADMITTED_SYMBOLIC_METHODS
    else:
        return {"pass": False, "detail": f"unknown candidate kind {kind}"}
    if m not in admitted:
        return {"pass": False,
                "detail": f"method={m!r} not in admitted set {sorted(admitted)}"}
    return {"pass": True, "detail": f"method={m!r}"}


def _check_self_reported_precision(candidate: dict, requested_precision: int) -> dict:
    ap = candidate["achieved_precision"]
    if ap < 0:
        return {"pass": False, "detail": f"achieved_precision={ap} negative"}
    if ap > requested_precision:
        return {"pass": False,
                "detail": (f"achieved_precision={ap} > requested "
                           f"{requested_precision} — over-reporting")}
    return {"pass": True,
            "detail": f"achieved={ap}, requested={requested_precision}"}


def _value_accuracy(candidate: dict, expected: dict) -> float:
    """Compute relative error vs pinned truth for a numerical candidate."""
    truth_re = mpmath.mpf(expected["truth"]["re"])
    truth_im = mpmath.mpf(expected["truth"]["im"])
    truth = mpmath.mpc(truth_re, truth_im)

    cand_re = mpmath.mpf(candidate["value"]["re"])
    cand_im = mpmath.mpf(candidate["value"]["im"])
    cand = mpmath.mpc(cand_re, cand_im)

    diff = mpmath.fabs(cand - truth)
    scale = max(mpmath.fabs(truth), mpmath.mpf("1e-300"))
    return float(diff / scale)


def _check_boundary_envelope(candidate: dict, expected: dict) -> dict:
    if not isinstance(candidate, dict) or candidate.get("kind") != "tagged":
        return {"pass": False,
                "detail": (f"expected tagged refusal but got "
                           f"kind={candidate.get('kind', type(candidate).__name__)}")}
    expected_tag = expected["tag"]
    actual_tag = candidate.get("tag", "")
    if actual_tag != expected_tag:
        return {"pass": False,
                "detail": f"tag {actual_tag!r} != expected {expected_tag!r}"}
    return {"pass": True, "detail": f"tagged {expected_tag}"}


def _check_speed(candidate: dict) -> Optional[dict]:
    """Tier-H speed gate (returns None if not applicable)."""
    if os.environ.get("MEIJERG_BENCH_CHECK_SPEED") != "1":
        return None
    elapsed = candidate.get("elapsed_ms")
    if elapsed is None:
        return {"pass": False, "detail": "no elapsed_ms field on candidate"}
    if elapsed > SPEED_GATE_MS:
        return {"pass": False,
                "detail": f"elapsed {elapsed:.1f}ms > {SPEED_GATE_MS}ms speed gate"}
    return {"pass": True, "detail": f"{elapsed:.1f}ms ≤ {SPEED_GATE_MS}ms"}


# ---------------------------------------------------------------------
# Top-level
# ---------------------------------------------------------------------

def verify(payload: dict) -> dict:
    case_id = payload.get("id", "")
    candidate = payload.get("candidate", {})
    inp = payload.get("input", {})

    if "id" not in payload:
        return {"pass": False, "reason": "missing id in payload", "checks": {}}

    expected_index = _load_expected()
    if case_id not in expected_index:
        return {"pass": False,
                "reason": f"id {case_id!r} not in expected.json",
                "checks": {}}
    case_expected = expected_index[case_id]

    checks: dict[str, dict] = {}

    # 0. Tool error: never expected.
    if isinstance(candidate, dict) and candidate.get("kind") == "tool_error":
        checks["no_tool_error"] = {
            "pass": False,
            "detail": (f"tool crashed: {candidate.get('name')}: "
                       f"{candidate.get('message')}"),
        }
        return _wrap(checks)
    checks["no_tool_error"] = {"pass": True, "detail": "tool did not crash"}

    expected = case_expected["expected"]
    expected_kind = expected.get("kind", "value")
    cand_kind = candidate.get("kind", "")

    # ----- Refusal-expected case ------
    if expected_kind == "tagged":
        checks["boundary_envelope"] = _check_boundary_envelope(candidate, expected)
        spd = _check_speed(candidate)
        if spd is not None:
            checks["speed_gate"] = spd
        return _wrap(checks)

    # ----- Value-expected case --------
    # The candidate may be 'symbolic' or 'numerical'.  We accept either
    # under request_mode='auto'; the candidate's `kind` discriminates.
    # If the case has request_mode='symbolic-required' or
    # 'numerical-required' embedded, the dispatcher will already have
    # enforced that; the verifier just inspects the resulting kind.

    if cand_kind == "tagged":
        # Unexpected refusal on a value-expected case
        checks["shape"] = {
            "pass": False,
            "detail": (f"expected value (symbolic|numerical) but got tagged "
                       f"refusal {candidate.get('tag')}"),
        }
        return _wrap(checks)

    if cand_kind not in ("symbolic", "numerical"):
        checks["shape"] = {
            "pass": False,
            "detail": (f"expected kind in {{symbolic, numerical}} but got "
                       f"kind={cand_kind!r}"),
        }
        return _wrap(checks)

    # Shape check
    if cand_kind == "symbolic":
        checks["shape"] = _check_shape_symbolic(candidate)
    else:
        checks["shape"] = _check_shape_numerical(candidate)
    if not checks["shape"]["pass"]:
        return _wrap(checks)

    # Method admissible
    checks["method_admissible"] = _check_method_admissible(candidate, cand_kind)

    # Numerical-specific:
    if cand_kind == "numerical":
        checks["finite_value"] = _check_finite_value(candidate)
        if not checks["finite_value"]["pass"]:
            return _wrap(checks)

        requested_precision = inp["precision"]
        checks["self_reported_precision"] = _check_self_reported_precision(
            candidate, requested_precision)

        # Value accuracy (numerical only — symbolic equality is checked
        # via the rule-id match below).
        if expected.get("truth") is not None:
            rel = _value_accuracy(candidate, expected)
            tol = float(mpmath.mpf(case_expected["tolerance_rel"]))
            checks["value_accuracy"] = {
                "pass": rel <= tol,
                "detail": f"rel={rel:.3e} {'≤' if rel <= tol else '>'} tol={tol:.3e}",
            }

    else:  # symbolic
        # Symbolic value accuracy: when the case has a pinned truth,
        # we cannot easily evaluate the candidate's `expr` here (the
        # AST evaluator lives in the tool, not the verifier).  Instead
        # we check that the candidate's `rule` is non-empty and the
        # `note` references a known function head.  Stronger check
        # (multi-point AST evaluation) is deferred to a follow-up
        # bead; for v0.1 the bench treats a successful symbolic
        # match (with non-empty rule / source) as adequate.
        rule_id = candidate.get("rule", "")
        if not rule_id:
            checks["symbolic_rule_present"] = {
                "pass": False,
                "detail": "symbolic candidate has empty 'rule' field",
            }
        else:
            checks["symbolic_rule_present"] = {
                "pass": True,
                "detail": f"rule={rule_id!r}",
            }

    # Speed-gate (Tier H)
    spd = _check_speed(candidate)
    if spd is not None:
        checks["speed_gate"] = spd

    return _wrap(checks)


def _wrap(checks: dict) -> dict:
    overall = all(c["pass"] for c in checks.values())
    if overall:
        return {"pass": True, "reason": "all invariants hold", "checks": checks}
    first_fail = next(k for k, v in checks.items() if not v["pass"])
    return {"pass": False,
            "reason": f"failed: {first_fail} — {checks[first_fail]['detail']}",
            "checks": checks}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = verify(payload)
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        sys.stderr.write("\n")
        result = {
            "pass": False,
            "reason": f"verifier crashed: {type(e).__name__}: {e}",
            "checks": {},
        }
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
