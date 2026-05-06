// =============================================================================
// bench/linsolve-q/run-candidate.ts — bench wire-format adapter
// =============================================================================
//
// Bridges raw JSON wire format ({A, b} as lists-of-strings) to the
// linsolve-q tool's canonical Value protocol, then decodes the tool's
// solution-set output (or tagged refusal) back to the wire format the
// verifier (`bench/linsolve-q/golden/verify.py`) consumes.
//
// Wire input shape (per PROMPT.md):
//   { "A": [["3/2", "-1"], ...], "b": ["5", "-1"] }
//
// Wire output shape (per verifier_protocol.md):
//   { kind, x?, free_vars?, rank, augmented_rank?, method, warnings }
//
// The adapter handles three tool-output shapes:
//   1. record { vars, solutions, completeness, warnings } — happy path
//      (unique or under-determined per ADR-0017).
//   2. tagged "linsolve-q/inconsistent" with payload — refusal class.
//   3. ToolError on stderr (malformed input) — propagates non-zero exit.

import { readFileSync } from "node:fs";
import { loadWorkbench } from "@workbench/compose";
import {
  int as protocolInt,
  list,
  rat as protocolRat,
  record,
  type Value,
} from "@workbench/protocol";

// ─── parsing wire-format rationals → canonical Value ─────────────────────────

function parseRationalString(s: string): Value {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid rational on wire: ${JSON.stringify(s)}`);
  const num = BigInt(m[1]!);
  const den = m[2] !== undefined ? BigInt(m[2]) : 1n;
  if (den === 1n) return protocolInt(num);
  return protocolRat(num, den);
}

function encodeInput(raw: {
  A: readonly (readonly string[])[];
  b: readonly string[];
}): Value {
  return record({
    A: list(raw.A.map((row) => list(row.map(parseRationalString)))),
    b: list(raw.b.map(parseRationalString)),
  });
}

// ─── decoding tool output → wire-format JSON ─────────────────────────────────

function valueToRationalString(v: Value): string {
  if (v.kind === "integer") return v.value;
  if (v.kind === "rational") return `${v.num}/${v.den}`;
  throw new Error(`expected integer/rational value, got ${v.kind}`);
}

/**
 * Decode a binding's `value` field, which may be:
 *   - integer / rational  (unique solution case)
 *   - expression          (under-determined case: affine in t_i symbols)
 *
 * For expressions we serialize back to the bench's affine-string form
 * (e.g., "5 - 2*t_0 + 1/3*t_1"). The expression structure is exactly
 * what `affineToExpr` produced in the tool (a `+`-headed list of
 * constant + each `*`-multiplied term). Walking it inverts the
 * encoding.
 */
function valueToBenchAffineString(v: Value): string {
  if (v.kind === "integer" || v.kind === "rational") {
    return valueToRationalString(v);
  }
  if (v.kind === "symbol") return v.name;
  if (v.kind === "expression") {
    if (v.head === "+") {
      const parts = v.args.map((a, i) => {
        const s = valueToBenchAffineString(a);
        if (i === 0) return s;
        // Subsequent terms: if s starts with '-', emit "- ..."; else "+ ...".
        if (s.startsWith("-")) return `- ${s.slice(1)}`;
        return `+ ${s}`;
      });
      return parts.join(" ");
    }
    if (v.head === "*") {
      // Args: [coefficient, symbol]. Coefficient is integer or rational.
      if (v.args.length !== 2) {
        throw new Error(`unexpected '*' arity in affine: ${v.args.length}`);
      }
      const coeffStr = valueToRationalString(v.args[0]!);
      const symArg = v.args[1]!;
      if (symArg.kind !== "symbol") {
        throw new Error(`expected symbol in second arg of *`);
      }
      // Strip a leading '-1*' to '-' (canonical form)
      if (coeffStr === "-1") return `-${symArg.name}`;
      if (coeffStr === "1") return symArg.name;
      return `${coeffStr}*${symArg.name}`;
    }
    throw new Error(`unexpected expression head in affine: ${v.head}`);
  }
  throw new Error(`unexpected value kind in affine: ${v.kind}`);
}

interface BenchOutput {
  kind: "unique" | "under-determined" | "inconsistent";
  x?: string[];
  free_vars?: string[];
  rank: number;
  augmented_rank?: number;
  method: string;
  warnings: string[];
}

function decodeWarnings(v: Value): string[] {
  if (v.kind !== "list") throw new Error("warnings must be list");
  return v.items.map((it) => {
    if (it.kind !== "string") throw new Error("warnings must be list-of-string");
    return it.value;
  });
}

function decodeOutput(out: Value): BenchOutput {
  if (out.kind === "tagged") {
    if (out.tag !== "linsolve-q/inconsistent") {
      throw new Error(`unexpected tag: ${out.tag}`);
    }
    if (out.payload.kind !== "record") throw new Error("tagged payload must be record");
    const payload = out.payload.fields;
    return {
      kind: "inconsistent",
      rank: Number(BigInt((payload.rank as { value: string }).value)),
      augmented_rank: Number(
        BigInt((payload.augmented_rank as { value: string }).value),
      ),
      method: "bareiss-one-step",
      warnings: decodeWarnings(payload.warnings as Value),
    };
  }

  if (out.kind !== "record") throw new Error(`expected record, got ${out.kind}`);
  const fields = out.fields;
  const completeness = (fields.completeness as { value: string }).value;
  const warnings = decodeWarnings(fields.warnings as Value);

  const solutions = fields.solutions as Value;
  if (solutions.kind !== "list") throw new Error("solutions must be list");
  if (solutions.items.length !== 1) {
    throw new Error(
      `linsolve-q: expected exactly 1 solution, got ${solutions.items.length}`,
    );
  }
  const sol = solutions.items[0]!;
  if (sol.kind !== "record") throw new Error("solution must be record");
  const bindings = sol.fields.bindings as Value;
  const branches = sol.fields.branches as Value;
  if (bindings.kind !== "list") throw new Error("bindings must be list");
  if (branches.kind !== "list") throw new Error("branches must be list");

  const x = bindings.items.map((b) => {
    if (b.kind !== "record") throw new Error("binding must be record");
    return valueToBenchAffineString(b.fields.value as Value);
  });
  const free_vars = branches.items.map((b) => {
    if (b.kind !== "symbol") throw new Error("branch must be symbol");
    return b.name;
  });

  // Rank: derive from completeness + |free_vars|. For under-determined:
  // rank = n - |free_vars|. For unique: rank = n.
  // n is the bindings length.
  const n = x.length;
  const rank =
    completeness === "complete" ? n : n - free_vars.length;

  return {
    kind: completeness === "complete" ? "unique" : "under-determined",
    x,
    free_vars,
    rank,
    method: "bareiss-one-step",
    warnings,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

const stdinPath = process.argv[2];
const raw: { A: readonly (readonly string[])[]; b: readonly string[] } =
  stdinPath
    ? JSON.parse(readFileSync(stdinPath, "utf8"))
    : JSON.parse(readFileSync(0, "utf8"));

const wb = await loadWorkbench();
const inputValue = encodeInput(raw);
const outputValue = await wb.run("linsolve-q", inputValue);
const benchOut = decodeOutput(outputValue);
process.stdout.write(JSON.stringify(benchOut));
