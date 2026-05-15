# sturm-trace

The TS-native frontend tool: take a string of TypeScript source that
builds a Sturm channel via [`@workbench/sturm`](../../packages/sturm/)'s
`trace(...)` DSL, execute it in a sandboxed Bun subprocess, and emit
the resulting channel as a canonical IR Value (the `expression "channel"`
shape from ADR-0006).

This closes the "source → IR" boundary in the layered Sturm stack:

```
TS source ─[sturm-trace]→ IR Value ─[sturm-execute]→ distribution
                                  ─[sturm-equivalent]→ verdict
                                  ─[sturm-simplify]→ smaller IR
```

The substrate piece is [`@workbench/sturm`](../../packages/sturm/) (ADR-
0009 — "agents are TS experts; what a TS expert wants is the spec").
This tool is the bridge that lets agents compose by-pipe rather than
by-direct-IR-construction.

## Input

`record { source, entry? }`:

```jsonc
{
  "kind": "record",
  "fields": {
    "source": { "kind": "string", "value": "import { trace } from \"@workbench/sturm\";\nexport default () => trace(() => []);\n" },
    "entry":  { "kind": "string", "value": "default" }  // optional; defaults to "default"
  }
}
```

`source` is the TS source code as one string. It must export a function
(named or `default`) that calls `trace(...)` from `@workbench/sturm`
and returns the resulting `Channel<I, O>`. The function is called with
no arguments — channel inputs (the `I` tuple) are out of scope for v0.1
(see "Honest scope" below).

`entry` is the export name to call. Defaults to `"default"` (the
module's default export). Use this when your source declares multiple
channels and you want to trace a named one:

```ts
export function bellPair() { return trace(...); }
export function ghz3()     { return trace(...); }
```

then pass `entry: "bellPair"` or `entry: "ghz3"`.

## Output

On success: the channel IR Value — an `expression "channel"` per
ADR-0006. Validate further with `channelSchema` / `decodeChannel` /
`checkWellFormed` from `@workbench/sturm-ir`, or pipe straight into the
next tool:

```sh
cat circuit.json | bun tools/sturm-trace/tool.ts | bun tools/sturm-execute/tool.ts
```

On refusal: `tagged "sturm-trace/<class>"` with a payload describing
the failure (ADR-0003 boundary-failure shape). Four classes:

| Class                  | When                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `parse-error`          | Source failed to import — syntax error, missing module, module-level throw. The `bennett-missing` case folds in here for v0.1 because `@bennett/core` is not yet a package; once Bennett-TS lands it lifts to its own class. |
| `invalid-when-body`    | A non-rotation op (observe, prepare, oracle, cases, discard) fired inside a `when(...)` body. ADR-0038 makes this load-bearing for the principle "coherent control on non-unitary ops is not well-defined" (ADR-0006). Payload carries `{op_head, control_wires, message}`. |
| `non-pure-trace`       | The determinism check ran the trace twice and got different canonical IR bytes. The source is reading nondeterministic input — `Math.random`, `Date.now`, module-level mutable state, file system, etc. Pass `--skip-determinism` if the nondeterminism is intentional. |
| `non-channel-return`   | The entry function exists but didn't return a `Channel`, or doesn't exist under the requested entry name.              |

`runtime-error` is reserved for paths that should be unreachable in
practice (an exception in the runner outside of a recognised refusal
path) — agents should treat it as a tool bug to file.

## How

```
┌─────────────────┐    1. write source to .scratch/run-XYZ/user.ts
│   tool.ts       ├─────────────────────────────────────────────────────┐
│   (outer)       │    2. spawnBun runner.ts user.ts <entry>            │
│                 │◄────────────────────── canonical IR bytes ──────────┤
│                 │            (or typed JSON error + exit 1)           │
│                 │    3. if check-determinism: spawn second pass       │
│                 │    4. compare bytes; route to envelope or output    │
└─────────────────┘                                                      │
                                                                         │
                                                  ┌──────────────────────▼──┐
                                                  │   runner.ts              │
                                                  │   (subprocess)           │
                                                  │   await import(user.ts)  │
                                                  │   call entry()           │
                                                  │   assert Channel return  │
                                                  │   write canonical(toValue) │
                                                  └──────────────────────────┘
```

1. **Outer (`tool.ts`).** Writes the user source to a workspace-resident
   scratch file (`tools/sturm-trace/.scratch/run-<random>/user.ts`) so
   Bun's module resolution can find `@workbench/sturm` by walking up to
   the workspace's `node_modules`. Spawns the runner subprocess via
   `spawnBun` (ADR-0001 subprocess plumbing).
2. **Runner (`runner.ts`).** Dynamic-imports the user source — Bun
   handles TS natively; syntax errors and missing modules surface as
   exceptions. Calls the entry function. Expects a `Channel` from
   `@workbench/sturm`. Emits canonical bytes to stdout or a typed JSON
   error to stderr.
3. **Determinism check.** On by default. The outer tool spawns the
   runner twice and bit-compares the stdout bytes; mismatch → refuse.
   This is the v3 PRD's `STURM_CHECK_DETERMINISM=1` mode, on
   unconditionally in this tool (turn off only with `--skip-determinism`).
4. **Refusal routing.** Subprocess exit-1 + stderr-JSON parses to a
   `RunnerError`; the outer tool routes to one of the four
   `tagged "sturm-trace/<class>"` envelopes.

## Coherent control restrictions (ADR-0038)

The most load-bearing refusal class. ADR-0006/0038's principle "coherent
control on non-unitary ops is not well-defined" applies at the source
level here: a user who writes

```ts
when(q, () => {
  observe(r);   // ← non-rotation op inside a when body
});
```

is asking for something the IR can't represent — there's no `controls`
field on `observe`. The tracer refuses at trace time with
`tagged "sturm-trace/invalid-when-body"`. The forbidden list is
the **complement of `{ry, rz}`** within the seven-head IR vocabulary:
`prepare`, `observe`, `oracle`, `cases`, `discard`. `prepare` could
technically lower harmlessly (a fresh wire doesn't entangle with the
control) but is refused for now because the user-intent reading is
confusing — v0.1 narrows; v0.2 may relax if a real use case appears.

The IR layer enforces the same principle through four other layers
(schema closure, builder API, decoder arity, cases-arm well-
formedness); together with this tool's source-level refusal, that's the
five-layer enforcement table ADR-0038 documents.

## Honest scope (v0.1)

- **No channel inputs.** The user's entry function is called with `()`;
  channels whose `I` tuple is non-empty will still trace correctly
  (their IR `inputs` list will be populated by `t.input.qbool()`/
  `t.input.qreg()` calls in the trace body), but this tool has no way
  to *bind* concrete input wires through its surface. Use
  `sturm-trace | sturm-then`-style composition to plumb inputs at the
  IR layer.
- **No nested `run()`.** Per the v3 PRD; AsyncLocalStorage work
  deferred.
- **No proper `bennett-missing` class.** Until `@bennett/core` ships,
  a user's `import { oracle } from "@bennett/core"` surfaces as
  module-not-found → `parse-error`.

## Invariants

- **deterministic-on-pure-source**: For a pure trace (no `Math.random` /
  `Date.now` / module state), `traceTwice(source) === traceOnce(source)`.
- **round-trips-through-sturm-execute**: For a well-formed source,
  `sturm-execute(sturm-trace(source))` is the textbook distribution.
  The `--test` hook pins Bell, GHZ-3, and a deterministic
  prepare-observe.
- **rejects-invalid-when-body**: A source that calls `observe` /
  `prepare` / `oracle` / `cases` / `discard` inside a `when(...)` body
  refuses with `tagged "sturm-trace/invalid-when-body"` (ADR-0038).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`

## Tool flags

- `--skip-determinism` — skip the trace-twice determinism check. Off
  by default (so the check runs by default; negative-framing matches
  `F.bool`'s "switches default to false" convention while preserving
  the bead's STURM_CHECK_DETERMINISM=1-default intent).

## Run

```sh
echo '{"kind":"record","fields":{"source":{"kind":"string","value":"import { trace } from \"@workbench/sturm\";\nexport default () => trace(() => []);\n"}}}' \
  | bun tools/sturm-trace/tool.ts
```

For multi-line sources, write the input record to a file first:

```sh
cat > circuit.json <<'EOF'
{"kind":"record","fields":{"source":{"kind":"string","value":"..."}}}
EOF
cat circuit.json | bun tools/sturm-trace/tool.ts
```

## References

- ADR-0006 — IR-as-Value encoding for Sturm channels (the output shape).
- ADR-0009 — TS-native frontend DSL (the design axiom and surface that
  this tool consumes).
- ADR-0038 — coherent-control restrictions (the `invalid-when-body`
  envelope spec and the four-layer IR-side enforcement table; this
  tool is the source-surface fifth layer).
- ADR-0001 — subprocess plumbing (`spawnBun` resolves snap-Bun's
  mount-namespace corner; this tool inherits that).
- ADR-0003 — three output categories (this tool's four refusal classes
  all sit in the boundary-failure shape).
- `packages/sturm/` — the DSL implementation; reads top-to-bottom like
  a chapter (CLAUDE.md Rule 10).
- `packages/sturm-ir/` — the IR substrate (channel schema, well-formedness).
- bead `q0b` — the implementation issue this tool closes.
- bead `r40` — the prerequisite that produced ADR-0038.
