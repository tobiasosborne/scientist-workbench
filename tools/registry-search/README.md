# registry-search

Filter the tool registry by input kind, output kind, expression head, or name substring. Useful for an agent planning a composition by **type** rather than by name (PRD §6.3).

## Input

```json
{"kind":"record","fields":{
  "tools_root":     {"kind":"string","value":"/optional/path"},
  "input_kind":     {"kind":"string","value":"string"},
  "output_kind":    {"kind":"string","value":"record"},
  "head":           {"kind":"string","value":"+"},
  "name_substring": {"kind":"string","value":"cas"}
}}
```

All filters are optional and conjoin (AND).

- `input_kind` / `output_kind`: matches if the schema's top-level kind matches **or** if the schema mentions a sub-value of that kind anywhere.
- `head`: only matches if `schema.output` is an `expression` value with the given head.
- `name_substring`: case-insensitive.

## Output

Same record shape as `registry-list`, filtered.

## Examples

```sh
# Find all parsers (tools that consume a string):
echo '{"kind":"record","fields":{"input_kind":{"kind":"string","value":"string"}}}' \
  | bun tools/registry-search/tool.ts

# Find all CAS tools:
echo '{"kind":"record","fields":{"name_substring":{"kind":"string","value":"cas"}}}' \
  | bun tools/registry-search/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
