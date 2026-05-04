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

`fn` always returns this record — pass or fail — and never calls
`process.exit`. Provenance is written for every successful invocation
of the oracle itself; a CI consumer that wants exit-1-on-failed-golden
inspects `output.failed > 0` and exits accordingly. `scripts/check.ts`
does this for the workbench's own oracle phase. Bead `qf1` /
worklog 038 records the rationale: in-process callers
(`@workbench/compose`'s `wb.run("oracle", ...)`) cannot catch
`process.exit`, so the exit decision belongs at the caller.

## Tool flags

- `--verbose` — emit one line per golden to stderr as it runs (`✓ name.golden.json` or `✗ name.golden.json: <reason>`). Off by default; the canonical results record on stdout is unchanged either way. Useful for noisy goldens directories where you want progress before the final summary.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
