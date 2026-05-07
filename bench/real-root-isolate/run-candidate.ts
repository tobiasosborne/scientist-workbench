// Bench candidate adapter for `tools/real-root-isolate`.
//
// Reads `{f: <expr-string>, var: <symbol-name>}` JSON from stdin (the
// bench's wire format), invokes `tools/real-root-isolate` in-process
// (via @workbench/compose), and writes the bench-shape JSON to stdout
// (intervals as `{lo: "<rational-string>", hi: "<rational-string>"}`,
// or `{kind: "tagged", tag, payload}` on refusal).
//
// The bench's reference (Python/SymPy) emits rational strings like
// `"1"`, `"1/2"`. The TS tool emits expression values where rationals
// are encoded as `int` for whole or `expr("/", [int(n), int(d)])` for
// fractions; this adapter renders them back to the bench's string form
// so `verify.py`'s `sympy.Rational(s)` parse succeeds.

import { readableStreamToText } from "bun";
import { def as realRootIsolateDef } from "../../tools/real-root-isolate/tool.ts";
import { sym, expr, int, type Value } from "@workbench/protocol";
import { canonicalToJson } from "@workbench/json-bridge";

interface BenchInput { f: string; var: string }

async function main(): Promise<void> {
  const raw = await readableStreamToText(Bun.stdin.stream());
  const benchInput = JSON.parse(raw) as BenchInput;

  // Parse the f-string via cas-core's expression vocabulary. We can't
  // depend on tools/expr-parse from inside this script (that would
  // require subprocess), so build a minimal parser inline.
  const fExpr = parsePolyString(benchInput.f, benchInput.var);
  const inputVal: Value = {
    kind: "record",
    fields: { f: fExpr, var: sym(benchInput.var) },
  };

  const out = realRootIsolateDef.fn(inputVal as never, {} as never) as Value;
  process.stdout.write(JSON.stringify(toBenchShape(out)));
  process.stdout.write("\n");
}

// -----------------------------------------------------------------------------
// Tiny expression parser — handles the bench's input vocabulary:
// number literals (with optional "/"), the variable symbol, parens,
// `+ - * / **` and unary `-`. Built recursive-descent over a tokenised
// stream. Sufficient for `bench/real-root-isolate/golden/inputs.json`.
// -----------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: bigint; d: bigint }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" } | { t: "rp" }
  | { t: "eof" };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      const num = BigInt(s.slice(i, j));
      // Maybe a rational literal `1/2` — only count it as rational if
      // followed *immediately* by a digit (no spaces). Otherwise the
      // `/` is a division operator and we leave it for the caller.
      if (j + 1 < s.length && s[j] === "/" && /[0-9]/.test(s[j + 1]!)) {
        let k = j + 1;
        while (k < s.length && /[0-9]/.test(s[k]!)) k++;
        const den = BigInt(s.slice(j + 1, k));
        out.push({ t: "num", v: num, d: den });
        i = k;
      } else {
        out.push({ t: "num", v: num, d: 1n });
        i = j;
      }
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j]!)) j++;
      out.push({ t: "ident", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "*" && s[i + 1] === "*") { out.push({ t: "op", v: "**" }); i += 2; continue; }
    if (ch === "(") { out.push({ t: "lp" }); i++; continue; }
    if (ch === ")") { out.push({ t: "rp" }); i++; continue; }
    if ("+-*/^".includes(ch)) { out.push({ t: "op", v: ch }); i++; continue; }
    throw new Error(`tokenize: unexpected char ${JSON.stringify(ch)} at ${i}`);
  }
  out.push({ t: "eof" });
  return out;
}

interface PState { toks: Tok[]; i: number; varName: string }

function parsePolyString(src: string, varName: string): Value {
  const toks = tokenize(src);
  const st: PState = { toks, i: 0, varName };
  const v = parseAddSub(st);
  if (st.toks[st.i]!.t !== "eof") throw new Error("parser: trailing input");
  return v;
}

function peek(st: PState): Tok { return st.toks[st.i]!; }
function eat(st: PState): Tok { return st.toks[st.i++]!; }

function parseAddSub(st: PState): Value {
  let lhs = parseMulDiv(st);
  while (peek(st).t === "op" && (peek(st) as any).v === "+" || (peek(st).t === "op" && (peek(st) as any).v === "-")) {
    const op = (eat(st) as any).v as "+" | "-";
    const rhs = parseMulDiv(st);
    lhs = expr(op, [lhs, rhs]);
  }
  return lhs;
}

function parseMulDiv(st: PState): Value {
  let lhs = parseUnary(st);
  while (peek(st).t === "op" && ((peek(st) as any).v === "*" || (peek(st) as any).v === "/")) {
    const op = (eat(st) as any).v as "*" | "/";
    const rhs = parseUnary(st);
    lhs = expr(op, [lhs, rhs]);
  }
  return lhs;
}

function parseUnary(st: PState): Value {
  if (peek(st).t === "op" && (peek(st) as any).v === "-") {
    eat(st);
    const inner = parseUnary(st);
    return expr("*", [int(-1n), inner]);
  }
  if (peek(st).t === "op" && (peek(st) as any).v === "+") {
    eat(st);
    return parseUnary(st);
  }
  return parsePower(st);
}

function parsePower(st: PState): Value {
  const base = parseAtom(st);
  if (peek(st).t === "op" && ((peek(st) as any).v === "**" || (peek(st) as any).v === "^")) {
    eat(st);
    const exp_ = parseUnary(st);
    return expr("^", [base, exp_]);
  }
  return base;
}

function parseAtom(st: PState): Value {
  const t = peek(st);
  if (t.t === "num") {
    eat(st);
    return t.d === 1n ? int(t.v) : expr("/", [int(t.v), int(t.d)]);
  }
  if (t.t === "ident") {
    eat(st);
    if (t.v === st.varName) return sym(t.v);
    // Foreign symbol — bench's `xy - 1` (multivariate refusal) and
    // `sin(x)` (non-polynomial) need to round-trip. Symbols pass
    // through; "function calls" are recognised by `(` follow.
    if (peek(st).t === "lp") {
      eat(st);
      const args: Value[] = [parseAddSub(st)];
      while (peek(st).t === "op" && (peek(st) as any).v === ",") {
        eat(st);
        args.push(parseAddSub(st));
      }
      if (peek(st).t !== "rp") throw new Error("parser: expected )");
      eat(st);
      return expr(t.v, args);
    }
    return sym(t.v);
  }
  if (t.t === "lp") {
    eat(st);
    const v = parseAddSub(st);
    if (peek(st).t !== "rp") throw new Error("parser: expected )");
    eat(st);
    return v;
  }
  throw new Error(`parser: unexpected ${JSON.stringify(t)}`);
}

// -----------------------------------------------------------------------------
// Output rendering — flatten the tool's `expr("/", [int(n), int(d)])` or
// raw `int(n)` to the bench's rational-string form.
// -----------------------------------------------------------------------------

function ratValueToString(v: Value): string {
  if (v.kind === "integer") return v.value;
  if (v.kind === "expression" && v.head === "/" && v.args.length === 2) {
    const n = v.args[0]!;
    const d = v.args[1]!;
    if (n.kind === "integer" && d.kind === "integer") {
      return d.value === "1" ? n.value : `${n.value}/${d.value}`;
    }
  }
  throw new Error(`ratValueToString: unexpected shape ${JSON.stringify(v).slice(0, 80)}`);
}

function toBenchShape(out: Value): unknown {
  if (out.kind === "tagged") {
    const payload = out.payload;
    return {
      kind: "tagged",
      tag: out.tag,
      payload: canonicalToJson(payload),
    };
  }
  if (out.kind === "record") {
    const intervalsField = out.fields["intervals"];
    if (!intervalsField || intervalsField.kind !== "list") {
      throw new Error("toBenchShape: intervals field missing");
    }
    const intervals = intervalsField.items.map((iv) => {
      if (iv.kind !== "record") throw new Error("toBenchShape: interval entry not a record");
      return {
        lo: ratValueToString(iv.fields["lo"]!),
        hi: ratValueToString(iv.fields["hi"]!),
      };
    });
    return {
      kind: "ok",
      intervals,
      method: "vas-lmq",
      warnings: [],
    };
  }
  throw new Error(`toBenchShape: unexpected output kind ${out.kind}`);
}

await main();
