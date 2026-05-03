# oracle

Run any tool against any goldens directory. Exit 0 iff every golden passes.

## Input

```json
{"kind":"record","fields":{
  "tool_path":   {"kind":"string","value":"tools/cas-simplify/tool.ts"},
  "goldens_dir": {"kind":"string","value":"tools/cas-simplify/goldens"},
  "mode":        {"kind":"string","value":"exact"}
}}
```

`mode` is optional; defaults to `"exact"`. `"structural"` compares hashes (currently coincides with `exact` for canonical bytes — kept as a hook for sign/tolerance modes).

## Goldens

A golden is a `*.golden.json` file in `goldens_dir` with shape:

```json
{"kind":"record","fields":{
  "input":  <value>,
  "output": <expected canonical value>,
  "flags":  {"kind":"record","fields":{"k":{"kind":"string","value":"v"}}}  // optional
}}
```

The harness pipes `canonicalize(input)` to the tool's stdin (with `flags` joined as `--k=v` argv), parses stdout, and compares to `output`.

## Output

```json
{"failed": <int>, "mode": <str>, "passed": <int>, "total": <int>, "results": [<per-golden record>]}
```

Process exits 1 if any golden fails.

## Tool flags

- `--verbose` — emit one line per golden to stderr as it runs (`✓ name.golden.json` or `✗ name.golden.json: <reason>`). Off by default; the canonical results record on stdout is unchanged either way. Useful for noisy goldens directories where you want progress before the final summary.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
