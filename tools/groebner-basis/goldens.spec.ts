import {
  expr,
  int,
  list,
  record,
  str,
  sym,
  type Value,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// `record { polys: list<expr>, vars: list<sym>, order: "lex"|"degrevlex" }`.
function caseInput(
  polys: Value[],
  vars: Value[],
  order: "lex" | "degrevlex",
): Value {
  return record({
    polys: list(polys),
    vars: list(vars),
    order: str(order),
  });
}

const x = sym("x");
const y = sym("y");
const z = sym("z");

const pow = (base: Value, k: bigint): Value => expr("^", [base, int(k)]);
const mul = (...args: Value[]): Value => expr("*", args);
const add = (...args: Value[]): Value => expr("+", args);
const sub = (a: Value, b: Value): Value => expr("-", [a, b]);

export const goldens: GoldenSpec[] = [
  // ── happy path ──────────────────────────────────────────────────────────
  {
    description: "(x²+y, xy+1) lex — CLO Ch.2 §6 classical example",
    input: caseInput(
      [add(pow(x, 2n), y), add(mul(x, y), int(1n))],
      [x, y],
      "lex",
    ),
  },
  {
    description: "(x²+y, xy+1) degrevlex — same ideal, different basis shape",
    input: caseInput(
      [add(pow(x, 2n), y), add(mul(x, y), int(1n))],
      [x, y],
      "degrevlex",
    ),
  },
  {
    description: "single generator x²+y — already a GB",
    input: caseInput([add(pow(x, 2n), y)], [x, y], "lex"),
  },
  {
    description: "monomial ideal (x², y³) — LMs are themselves the basis",
    input: caseInput([pow(x, 2n), pow(y, 3n)], [x, y], "lex"),
  },
  {
    description: "trivial ideal {1} — inconsistent system",
    input: caseInput([int(1n)], [x, y], "lex"),
  },
  {
    description: "cyclic-3 in degrevlex — classical hard case",
    input: caseInput(
      [
        add(x, y, z),
        add(mul(x, y), mul(y, z), mul(z, x)),
        sub(mul(x, y, z), int(1n)),
      ],
      [x, y, z],
      "degrevlex",
    ),
  },
  {
    description: "linear chain (x+y, y+z) lex — already-reduced GB",
    input: caseInput([add(x, y), add(y, z)], [x, y, z], "lex"),
  },

  // ── boundary refusals (one per declared class) ─────────────────────────
  {
    description: "non-polynomial input — sin(x) head outside scope",
    input: caseInput([add(expr("sin", [x]), y)], [x, y], "lex"),
  },
  {
    description: "parametric — symbol `a` not in vars",
    input: caseInput([add(mul(sym("a"), x), y)], [x, y], "lex"),
  },
  {
    description: "empty-input — polys list is empty",
    input: caseInput([], [x, y], "lex"),
  },
  {
    description: "empty-vars — vars list is empty",
    input: caseInput([add(pow(x, 2n), int(1n))], [], "lex"),
  },
];
