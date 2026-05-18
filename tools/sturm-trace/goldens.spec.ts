// Goldens for sturm-trace. Each entry pipes its `input` (a
// `record{source, entry?}`) through the tool and snapshots the output
// as a `*.golden.json` file via `bun scripts/generate-goldens.ts
// --tool sturm-trace`. The oracle then byte-compares the snapshot
// against subsequent runs to catch regressions.
//
// Coverage target — the ≥10-example acceptance criterion of bead q0b,
// spread across:
//
//   Happy paths (the source is a well-formed Sturm channel):
//     1. empty trace (zero ops)
//     2. single prepare + observe (smallest non-trivial)
//     3. Bell pair (canonical; pins the two-op `not` lowering)
//     4. GHZ on three wires (multi-control, parametrised by n=3)
//     5. parametrised rotation (`ry(q, 0.42)` — numeric angle)
//     6. symbolic π/n angle (`piOver(2)` — preserved as symbolic)
//     7. classical branch via `m.if` (the `cases` op materialisation)
//     8. named-entry export (`entry: "myCircuit"` instead of default)
//
//   Refusal paths (boundary failures via `tagged`-envelope per ADR-
//   0038 / ADR-0003):
//     9.  invalid-when-body — observe inside `when(...)` body
//    10.  parse-error — syntactically broken TS source
//    11.  non-channel-return — entry returns a number
//    12.  non-channel-return (entry not present) — bad entry name
//    13.  non-pure-trace — Math.random() inside the trace
//
// 13 entries total. Refusal envelopes are byte-stable: error messages
// have the scratch path scrubbed (runner.ts), and the non-pure-trace
// envelope deliberately carries no payload other than its message
// (the diverging IR bytes would themselves be non-deterministic).

import { record, str } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// ---------------------------------------------------------------------------
// Source-string builder — multi-line TS as a single JS string. Keeping the
// imports + body close to what a user would actually write makes the
// golden's `input.source` readable in the on-disk snapshot.
// ---------------------------------------------------------------------------
const src = (s: string): string => s;

const sourceEmpty = src(
  'import { trace } from "@workbench/sturm";\n' +
  "export default () => trace(() => []);\n",
);

const sourcePrepareObserve = src(
  'import { trace, qbool, observe } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  const q = qbool(0);\n" +
  "  observe(q);\n" +
  "  return [];\n" +
  "});\n",
);

const sourceBellPair = src(
  'import { trace, qbool, when, not, observe } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  const a = qbool(0.5);\n" +
  "  const b = qbool(0);\n" +
  "  when(a, () => not(b));\n" +
  "  observe(a);\n" +
  "  observe(b);\n" +
  "  return [];\n" +
  "});\n",
);

const sourceGHZ3 = src(
  'import { trace, qbool, when, not, observe } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  const a = qbool(0.5);\n" +
  "  const b = qbool(0);\n" +
  "  const c = qbool(0);\n" +
  "  when(a, () => { not(b); not(c); });\n" +
  "  observe(a);\n" +
  "  observe(b);\n" +
  "  observe(c);\n" +
  "  return [];\n" +
  "});\n",
);

const sourceParametrisedRy = src(
  'import { trace, qbool, ry, observe } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  const q = qbool(0);\n" +
  "  ry(q, 0.42);\n" +
  "  observe(q);\n" +
  "  return [];\n" +
  "});\n",
);

const sourcePiOverRy = src(
  'import { trace, qbool, ry, observe, piOver } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  const q = qbool(0);\n" +
  "  ry(q, piOver(2));\n" +
  "  observe(q);\n" +
  "  return [];\n" +
  "});\n",
);

const sourceClassicalBranch = src(
  'import { trace, qbool, when, not, observe } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  const a = qbool(0.5);\n" +
  "  const b = qbool(0);\n" +
  "  const m = observe(a);\n" +
  "  m.if(() => { not(b); });\n" +
  "  observe(b);\n" +
  "  return [];\n" +
  "});\n",
);

const sourceNamedEntry = src(
  'import { trace, qbool, observe } from "@workbench/sturm";\n' +
  "export function myCircuit() {\n" +
  "  return trace(() => {\n" +
  "    const q = qbool(0);\n" +
  "    observe(q);\n" +
  "    return [];\n" +
  "  });\n" +
  "}\n",
);

// ---------------------------------------------------------------------------
// Refusal sources
// ---------------------------------------------------------------------------

const sourceInvalidWhenBody = src(
  'import { trace, qbool, when, observe } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  const ctrl = qbool(0.5);\n" +
  "  const tgt = qbool(0);\n" +
  "  when(ctrl, () => { observe(tgt); });\n" +
  "  return [];\n" +
  "});\n",
);

// Syntax error: stray "%%" in the middle of a statement, no semicolon.
const sourceParseError = src(
  "export default () => %%notvalid%% ;\n",
);

const sourceNonChannelReturn = src(
  "export default () => 42;\n",
);

const sourceWrongEntryName = src(
  'import { trace } from "@workbench/sturm";\n' +
  "export const someOtherName = () => trace(() => []);\n",
);

const sourceNonPureTrace = src(
  'import { trace, qbool, observe } from "@workbench/sturm";\n' +
  "export default () => trace(() => {\n" +
  "  // Math.random() differs across the two trace passes — the\n" +
  "  // determinism check (on by default) catches this.\n" +
  "  const q = qbool(Math.random());\n" +
  "  observe(q);\n" +
  "  return [];\n" +
  "});\n",
);

export const goldens: GoldenSpec[] = [
  // -------- happy paths --------
  {
    description: "happy: empty trace (zero-op channel)",
    input: record({ source: str(sourceEmpty) }),
  },
  {
    description: "happy: prepare(0) then observe — minimal measurement",
    input: record({ source: str(sourcePrepareObserve) }),
  },
  {
    description: "happy: Bell pair via when(a, () => not(b)) + two observes",
    input: record({ source: str(sourceBellPair) }),
  },
  {
    description: "happy: GHZ-3 — when broadcasts to two targets",
    input: record({ source: str(sourceGHZ3) }),
  },
  {
    description: "happy: parametrised ry(q, 0.42) — numeric angle flows through as float64",
    input: record({ source: str(sourceParametrisedRy) }),
  },
  {
    description: "happy: ry(q, piOver(2)) — symbolic π/2 preserved in the IR",
    input: record({ source: str(sourcePiOverRy) }),
  },
  {
    description: "happy: m.if classical branch — pins the cases op materialisation",
    input: record({ source: str(sourceClassicalBranch) }),
  },
  {
    description: "happy: named entry export (entry='myCircuit')",
    input: record({ source: str(sourceNamedEntry), entry: str("myCircuit") }),
  },
  // -------- refusal paths --------
  {
    description: "refusal: invalid-when-body — observe inside when (ADR-0038)",
    input: record({ source: str(sourceInvalidWhenBody) }),
  },
  {
    description: "refusal: parse-error — syntactically broken TS",
    input: record({ source: str(sourceParseError) }),
  },
  {
    description: "refusal: non-channel-return — default export returns a number",
    input: record({ source: str(sourceNonChannelReturn) }),
  },
  {
    description: "refusal: non-channel-return — entry name not in module",
    input: record({ source: str(sourceWrongEntryName) }),
  },
  {
    description: "refusal: non-pure-trace — Math.random in body diverges across two traces",
    input: record({ source: str(sourceNonPureTrace) }),
  },
];
