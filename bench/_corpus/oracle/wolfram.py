"""Wolframscript subprocess wrapper.

`wolfram_query(code, timeout)` runs a Wolfram Language code snippet via
`wolframscript -file` (file form, since stdin form has known quoting
hazards on multi-line snippets — see session log 2026-05-06) and parses
the InputForm output.

Activation: this requires an activated Wolfram kernel on the host. On
the workbench dev box, the kernel is activated under TIB-Hannover-VPN.
A non-activated kernel returns 'Your Wolfram product is not activated'
on stderr; we surface that as `{'status': 'failed', 'reason':
'kernel-not-activated'}` so the bench can tag the case correctly
rather than crash.

Per ADR-0019 §3 + §6.
"""
from __future__ import annotations
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict


def wolfram_query(code: str, timeout: float = 30.0) -> Dict[str, Any]:
    """Run a Wolfram Language snippet and return parsed result.

    `code` is a Mathematica expression (or sequence of statements).
    The wrapper appends `Print[..., InputForm]` boilerplate so the
    output is a single line of canonical InputForm. If `code` already
    contains a top-level `Print[...]`, we trust the caller and don't
    add more.

    Returns one of:
      {'status': 'ok',       'result': <str — InputForm of the result>}
      {'status': 'failed',   'reason': <str — wolfram message or 'kernel-not-activated'>}
      {'status': 'timeout',  'reason': <str — '<timeout>s exceeded'>}
      {'status': 'error',    'reason': <str — non-zero exit + stderr>}

    The `result` is always a string. The caller decides whether to parse
    it further (e.g., into a SymPy expression for cross-comparison).
    """
    has_explicit_print = re.search(r"\bPrint\s*\[", code) is not None
    if not has_explicit_print:
        # Use `ToString[..., InputForm]` (not `// InputForm`) so the
        # output is the literal InputForm string with no `InputForm[...]`
        # wrapper. The `// InputForm` form merely sets the head; Print
        # then displays the wrapper, which downstream parsers must strip.
        wrapped = f"Print[ToString[({code}), InputForm]];"
    else:
        wrapped = code if code.rstrip().endswith(";") else code + ";"

    # File form because stdin form drops trailing chars on some `code`
    # values when piped through bash heredoc (smoketest 2026-05-06).
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".wl", delete=False, encoding="utf-8"
    ) as f:
        f.write(wrapped)
        f.write("\n")
        snippet_path = Path(f.name)

    try:
        proc = subprocess.run(
            ["wolframscript", "-file", str(snippet_path)],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "reason": f"{timeout}s exceeded"}
    finally:
        snippet_path.unlink(missing_ok=True)

    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()

    if "is not activated" in stderr or "is not activated" in stdout:
        return {"status": "failed", "reason": "kernel-not-activated"}

    if proc.returncode != 0:
        return {
            "status": "error",
            "reason": f"exit {proc.returncode}; stderr: {stderr[:500]}",
        }

    if "$Failed" in stdout:
        # Wolfram's standard "I refuse" sentinel; not an error, a refusal.
        return {"status": "failed", "reason": "$Failed"}

    if not stdout:
        return {"status": "failed", "reason": "empty-output"}

    return {"status": "ok", "result": stdout}


def parse_solution_set(input_form: str) -> list[dict[str, str]]:
    """Parse `{{x -> 1, y -> 2}, {x -> 3, y -> 4}}` into structured form.

    Handles Mathematica's standard `Solve[]` output shape. Returns a
    list of dicts mapping variable name -> InputForm of the value.
    Robust to nested braces inside values (Sqrt[2], Root[..., k], etc.)
    via balanced-bracket scanning.

    Empty `{}` -> []. Anything not list-of-rules-shape raises ValueError;
    callers should pre-check via `wolfram_query`'s status field.
    """
    s = input_form.strip()
    if s == "{}":
        return []
    if not (s.startswith("{") and s.endswith("}")):
        raise ValueError(f"not a solution-set InputForm: {input_form[:80]}")
    inner = s[1:-1].strip()
    if not inner:
        return []

    # Split top-level solutions by tracking bracket depth.
    solutions = []
    depth = 0
    cur = []
    for ch in inner:
        if ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        if ch == "," and depth == 0:
            solutions.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur:
        solutions.append("".join(cur).strip())

    parsed: list[dict[str, str]] = []
    for sol in solutions:
        sol = sol.strip()
        if sol.startswith("{") and sol.endswith("}"):
            sol = sol[1:-1].strip()
        # Split rules by top-level comma; each rule is `name -> value`.
        rules = []
        depth = 0
        cur = []
        for ch in sol:
            if ch in "[{":
                depth += 1
            elif ch in "]}":
                depth -= 1
            if ch == "," and depth == 0:
                rules.append("".join(cur).strip())
                cur = []
            else:
                cur.append(ch)
        if cur:
            rules.append("".join(cur).strip())

        binding: dict[str, str] = {}
        for r in rules:
            if "->" not in r:
                raise ValueError(f"missing '->' in rule: {r[:80]}")
            name, value = r.split("->", 1)
            binding[name.strip()] = value.strip()
        parsed.append(binding)
    return parsed
