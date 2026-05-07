#!/usr/bin/env python3
"""Drive the alg-num-arith bench end-to-end.

For each case in `inputs.json`:
  1. invoke `bun tools/alg-num-arith/tool.ts --op=<op>` with the case's
     input on stdin;
  2. parse the tool's stdout as the candidate;
  3. run `verify.py`'s 4/2/2-check protocol against `expected.json`;
  4. tally pass/fail per tier.

Exit 0 iff every case passes; exit 1 otherwise.

Run from the workspace root:
    python3 bench/alg-num-arith/golden/run.py [-v]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE_ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(HERE))

from verify import verify  # noqa: E402

TOOL_PATH = WORKSPACE_ROOT / "tools" / "alg-num-arith" / "tool.ts"


def run_one(case: dict, expected: dict) -> dict:
    inp = case["input"]
    op = inp["op"]
    a = inp["a"]
    b = inp.get("b")
    tool_input = {"kind": "record", "fields": {"a": a}}
    if b is not None:
        tool_input["fields"]["b"] = b
    r = subprocess.run(
        ["bun", str(TOOL_PATH), f"--op={op}"],
        input=json.dumps(tool_input),
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        return {
            "pass": False,
            "reason": f"tool exited {r.returncode}: {r.stderr.strip()[:120]}",
            "checks": {},
        }
    try:
        cand = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        return {
            "pass": False,
            "reason": f"non-JSON stdout: {e}",
            "checks": {},
        }
    return verify({
        "id": case["id"], "input": inp, "candidate": cand,
        "expected": expected,
    })


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    with open(HERE / "inputs.json") as f:
        inputs = json.load(f)
    with open(HERE / "expected.json") as f:
        expected_data = json.load(f)
    expected_by_id = {c["id"]: c["expected"] for c in expected_data["cases"]}

    by_tier: defaultdict = defaultdict(lambda: {"pass": 0, "fail": 0, "fails": []})
    n_total = n_pass = n_fail = 0

    for case in inputs["cases"]:
        cid = case["id"]
        tier = case["tier"]
        result = run_one(case, expected_by_id[cid])
        n_total += 1
        if result["pass"]:
            n_pass += 1
            by_tier[tier]["pass"] += 1
            if args.verbose:
                print(f"  ✓ {cid}")
        else:
            n_fail += 1
            by_tier[tier]["fail"] += 1
            by_tier[tier]["fails"].append((cid, result["reason"]))
            print(f"  ✗ {cid}: {result['reason']}")

    print()
    print("by tier:")
    for tier in sorted(by_tier):
        s = by_tier[tier]
        print(f"  {tier}: {s['pass']}/{s['pass']+s['fail']} pass")
    print()
    print(f"TOTAL: {n_pass}/{n_total} pass")
    return 0 if n_fail == 0 else 1


_ = os
if __name__ == "__main__":
    sys.exit(main())
