// =============================================================================
// validate-tournament-ntt — bridge from the tstournament 02-NTT corpus
// to the sci-wb canonical encoding, and back.
// =============================================================================
//
// For each of the tournament's 64 cases:
//
//   1. read the raw-JSON input
//   2. translate to canonical via @workbench/json-bridge, guided by an
//      NTT-input hint
//   3. pipe canonical bytes into tools/ntt/tool.ts via spawnBun
//   4. parse the canonical list<integer> output
//   5. emit it back as raw JSON (with integerEncoding="string" to match
//      the tournament's convention)
//   6. compare against tournament's expected.json
//
// Exits 0 iff every case matches residue-for-residue. The translation is
// the only adapter — algorithmic agreement is verified bit-exactly,
// stronger than the tournament's own verifier (no tolerance involved).
//
// Usage:
//   bun scripts/validate-tournament-ntt.ts [--tournament-dir <path>]
//   default tournament-dir: ../tstournament/test-2/02-ntt

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  kindOf,
  list,
  parse,
  record,
  type Value,
} from "@workbench/protocol";
import { spawnBun } from "@workbench/contract";
import { canonicalToJson, jsonToCanonical } from "@workbench/json-bridge";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

interface TournamentCase   { id: string; input: unknown }
interface TournamentExpect { id: string; expected: unknown }

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf("--tournament-dir");
const TOURNAMENT_DIR = resolve(ROOT, dirIdx >= 0 ? argv[dirIdx + 1]! : "../tstournament/test-2/02-ntt");

const inputsPath = join(TOURNAMENT_DIR, "golden", "inputs.json");
const expectedPath = join(TOURNAMENT_DIR, "golden", "expected.json");
const TOOL = join(ROOT, "tools", "ntt", "tool.ts");

// The hint declares exactly what each tournament-JSON field maps to in the
// canonical world. ADR-0002's kindOf annotations carry the structural
// information; the bridge does the per-leaf parsing.
const NTT_INPUT_HINT = record({
  direction:      kindOf("string"),
  modulus:        kindOf("integer"),
  n:              kindOf("integer"),
  primitive_root: kindOf("integer"),
  x:              list([kindOf("integer")]),
});

// Output: a list of integer residues. Symmetric hint isn't needed — the
// canonical output already declares its kinds; we use canonicalToJson with
// integerEncoding="string" to match the tournament's residue convention.

const inputsRaw = JSON.parse(await readFile(inputsPath, "utf8")) as { cases: TournamentCase[] };
const expectedRaw = JSON.parse(await readFile(expectedPath, "utf8")) as { cases: TournamentExpect[] };

if (inputsRaw.cases.length !== expectedRaw.cases.length) {
  console.error(`✗ inputs (${inputsRaw.cases.length}) vs expected (${expectedRaw.cases.length}) length mismatch`);
  process.exit(2);
}

const expectedById = new Map<string, unknown>();
for (const e of expectedRaw.cases) expectedById.set(e.id, e.expected);

let pass = 0;
let fail = 0;
const failures: Array<{ id: string; reason: string }> = [];

const t0 = Date.now();
for (const c of inputsRaw.cases) {
  const expected = expectedById.get(c.id);
  if (expected === undefined) {
    failures.push({ id: c.id, reason: "no expected entry in expected.json" });
    fail++;
    continue;
  }

  // 1+2: hint-driven translation to canonical.
  let canonInput: Value;
  try {
    canonInput = jsonToCanonical(c.input, NTT_INPUT_HINT);
  } catch (e) {
    failures.push({ id: c.id, reason: `bridge (input): ${(e as Error).message}` });
    fail++;
    continue;
  }

  // 3: run the tool.
  const r = await spawnBun([TOOL], canonicalize(canonInput));
  if (r.code !== 0) {
    failures.push({ id: c.id, reason: `tool exit ${r.code}: ${r.stderr.trim().slice(0, 200)}` });
    fail++;
    continue;
  }

  // 4: parse canonical output.
  let outVal: Value;
  try {
    outVal = parse(r.stdout);
  } catch (e) {
    failures.push({ id: c.id, reason: `unparseable stdout: ${(e as Error).message}` });
    fail++;
    continue;
  }

  // 5: emit back as tournament-shaped JSON (residues as strings).
  const got = canonicalToJson(outVal, { integerEncoding: "string" });

  // 6: compare to expected residue list.
  if (!Array.isArray(got) || !Array.isArray(expected)) {
    failures.push({ id: c.id, reason: "non-array residue list" });
    fail++;
    continue;
  }
  if (got.length !== expected.length) {
    failures.push({ id: c.id, reason: `length: got ${got.length}, expected ${expected.length}` });
    fail++;
    continue;
  }
  let mismatchIdx = -1;
  for (let i = 0; i < expected.length; i++) {
    if (got[i] !== expected[i]) { mismatchIdx = i; break; }
  }
  if (mismatchIdx >= 0) {
    failures.push({ id: c.id, reason: `residue mismatch at k=${mismatchIdx}: got ${String(got[mismatchIdx])}, expected ${String(expected[mismatchIdx])}` });
    fail++;
    continue;
  }
  pass++;
}

const dt = Date.now() - t0;
console.log(`tournament 02-ntt: ${pass}/${inputsRaw.cases.length} cases pass (${dt} ms)`);
if (fail > 0) {
  console.log(`failures:`);
  for (const f of failures) console.log(`  ✗ ${f.id}: ${f.reason}`);
  process.exit(1);
}
