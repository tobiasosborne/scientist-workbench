# registry-list

Discover installed tools and emit their metadata.

## Input

```json
{"kind":"record","fields":{
  "tools_root": {"kind":"string","value":"/optional/path"}
}}
```

If `tools_root` is omitted, the tool walks up from its own location looking for a `tools/` directory.

## Output

A list of records, one per tool:

```json
{"name":..., "version":..., "path":..., "schema_input":..., "schema_output":..., "examples_count":..., "invariants_count":...}
```

Sorted alphabetically by name. Tools that fail to respond to the standard metadata flags are still listed, with an `error` field.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
