// expr-parse — converts plain-text math expressions to expression values.
// Input: { kind: "string", value: <source text> }
// Output: an expression Value, or an integer/rational/symbol leaf if the source
// is just a literal/identifier.
//
// Grammar (precedence, lowest → highest):
//   expr     := add
//   add      := mul (('+' | '-') mul)*           — left-assoc, binary
//   mul      := unary (('*' | '/') unary)*        — left-assoc, binary
//   unary    := '-' unary | '+' unary | pow
//   pow      := atom ('^' unary)?                 — right-assoc
//   atom     := number | call | identifier | '(' expr ')'
//   call     := identifier '(' expr (',' expr)* ')'
//   number   := digits ('.' digits)? ([eE] ('+'|'-')? digits)?    (scientific notation produces a float64)
//             | digits '/' digits                                    (rational literal)
//   ident    := [A-Za-z_][A-Za-z_0-9]*
//
// Function-call shape (`sin(x)`, `cos(2*t)`, `exp(neg(t))`) was added in
// v0.4.0 to support the closed vocabulary shared with `cas-diff`,
// `integrate-1d`, `optimize-lbfgs-projected`, and `integrate-ode-ivp`.
// The set of admitted heads is open at the parse layer (any identifier
// followed by `(` becomes an `expression` with that head); semantic
// vocabulary checking is the consumer's job (`evalNumericExpr` in
// `@workbench/quadrature` rejects unknown heads with a suggestion).
//
// LaTeX is out of scope for v1 — that's a sister tool (PRD §9.2).

import {
  canonicalize,
  expr,
  float64FromNumber,
  int,
  rat,
  S,
  str,
  sym,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";

const NAME = "expr-parse";
const VERSION = "0.4.0";

// Output is "an expression value of any head, or a leaf integer /
// rational / symbol." Function-call notation (`sin(x)`, `exp(neg t)`)
// produces an expression with that head; the head is *not* gated at
// the parse layer — a consumer's vocabulary check (e.g.
// `evalNumericExpr`) rejects unknown heads with a suggestion. The
// schema therefore admits any expression kind plus the three leaf
// kinds expr-parse can emit.
const outputSchema = S.union([
  S.kind("expression"),
  S.kind("integer"),
  S.kind("rational"),
  S.kind("symbol"),
]);

class Parser {
  src: string;
  pos: number;

  constructor(src: string) {
    this.src = src;
    this.pos = 0;
  }

  parseTopLevel(): Value {
    this.skipWs();
    if (this.eof()) {
      throw new ToolError("expr-parse: empty input", {
        suggestion: "supply a non-empty expression, e.g. {\"kind\":\"string\",\"value\":\"x + 1\"}",
      });
    }
    const v = this.parseAdd();
    this.skipWs();
    if (!this.eof()) {
      throw new ToolError(
        `expr-parse: unexpected ${JSON.stringify(this.peekChar())} at position ${this.pos}`,
        {
          suggestion: "if you meant a multi-letter identifier, ensure no whitespace splits it; for a product use '*'",
          detail: { position: this.pos, remainder: this.src.slice(this.pos, this.pos + 16) },
        }
      );
    }
    return v;
  }

  // add := mul (('+'|'-') mul)*
  parseAdd(): Value {
    let left = this.parseMul();
    while (true) {
      this.skipWs();
      const c = this.peekChar();
      if (c !== "+" && c !== "-") break;
      this.advance();
      const right = this.parseMul();
      left = expr(c, [left, right]);
    }
    return left;
  }

  // mul := unary (('*'|'/') unary)*
  parseMul(): Value {
    let left = this.parseUnary();
    while (true) {
      this.skipWs();
      const c = this.peekChar();
      if (c !== "*" && c !== "/") break;
      this.advance();
      const right = this.parseUnary();
      left = expr(c, [left, right]);
    }
    return left;
  }

  // unary := '-' unary | '+' unary | pow
  parseUnary(): Value {
    this.skipWs();
    const c = this.peekChar();
    if (c === "-") {
      this.advance();
      return expr("-", [this.parseUnary()]);
    }
    if (c === "+") {
      this.advance();
      return this.parseUnary();
    }
    return this.parsePow();
  }

  // pow := atom ('^' unary)?
  parsePow(): Value {
    const base = this.parseAtom();
    this.skipWs();
    if (this.peekChar() === "^") {
      this.advance();
      const e = this.parseUnary();
      return expr("^", [base, e]);
    }
    return base;
  }

  parseAtom(): Value {
    this.skipWs();
    const c = this.peekChar();
    if (c === "(") {
      this.advance();
      const v = this.parseAdd();
      this.skipWs();
      if (this.peekChar() !== ")") {
        throw new ToolError(`expr-parse: expected ')' at position ${this.pos}`, {
          suggestion: "balance your parentheses",
        });
      }
      this.advance();
      return v;
    }
    if (c !== undefined && /[0-9.]/.test(c)) return this.parseNumber();
    if (c !== undefined && /[A-Za-z_]/.test(c)) return this.parseIdentifier();
    throw new ToolError(
      `expr-parse: expected expression at position ${this.pos}, got ${JSON.stringify(c ?? "<end>")}`,
      {
        suggestion: "valid starts: digit, letter, '_', '(', or unary '+'/'-'",
      }
    );
  }

  parseNumber(): Value {
    const start = this.pos;
    let intPart = "";
    while (!this.eof() && /[0-9]/.test(this.peekChar()!)) {
      intPart += this.advance();
    }
    let fracPart = "";
    let sawDot = false;
    if (this.peekChar() === ".") {
      sawDot = true;
      this.advance();
      while (!this.eof() && /[0-9]/.test(this.peekChar()!)) {
        fracPart += this.advance();
      }
      if (intPart.length === 0 && fracPart.length === 0) {
        throw new ToolError(`expr-parse: lone '.' at position ${start}`, {
          suggestion: "decimals need digits, e.g. 0.5 not just .",
        });
      }
    }

    // Scientific-notation suffix `[eE]('+'|'-')?digits`. When present
    // the literal becomes a float64 (the exponent often pushes the
    // value outside the rational sweet spot — `1e-300` as a rational
    // would be 1/10^300, allocating a 300-digit BigInt for an obvious
    // float). Disambiguation: `e` immediately followed by a digit or
    // sign-then-digit is the exponent; otherwise we treat the `e` as
    // the start of an identifier (e.g. Euler's `e` constant after a
    // bare integer like `2 e` — though that grammar slot only arises
    // from explicit operators in practice).
    const hasExpStart = (this.peekChar() === "e" || this.peekChar() === "E");
    let expPart = "";
    let expSign = 1;
    if (hasExpStart) {
      const save = this.pos;
      this.advance();
      let signCh: string | undefined;
      if (this.peekChar() === "+" || this.peekChar() === "-") {
        signCh = this.advance();
      }
      while (!this.eof() && /[0-9]/.test(this.peekChar()!)) {
        expPart += this.advance();
      }
      if (expPart.length === 0) {
        // Not an exponent (no digits) — back off; the `e` belongs to
        // an identifier or surrounding tokenisation.
        this.pos = save;
      } else if (signCh === "-") {
        expSign = -1;
      }
    }

    if (expPart.length > 0) {
      // Scientific-notation literal — float64. The exponent often
      // pushes the value outside the rational sweet spot (`1e-300`
      // as a rational allocates a 300-digit BigInt for an obvious
      // float), so we stamp it as float64 directly. Build the
      // decimal string and let `Number(...)` do the IEEE-754
      // rounding — same digits, same bits across platforms
      // (ECMAScript ToNumber is fully specified).
      const intStr = intPart.length > 0 ? intPart : "0";
      const fracStr = fracPart.length > 0 ? `.${fracPart}` : "";
      const expStr = `e${expSign === -1 ? "-" : ""}${expPart}`;
      const v = Number(`${intStr}${fracStr}${expStr}`);
      if (!Number.isFinite(v)) {
        throw new ToolError(
          `expr-parse: float64 literal at position ${start} overflows IEEE-754 binary64`,
          { suggestion: "magnitude must be representable as float64; use a smaller exponent" },
        );
      }
      return float64FromNumber(v);
    }

    if (sawDot) {
      // Pure decimal (no exponent) — emit as a rational so symbolic
      // pipelines stay exact (preserves prior behaviour). `0.5` →
      // `rat(1, 2)`.
      const num = BigInt(intPart || "0") * 10n ** BigInt(fracPart.length) + BigInt(fracPart || "0");
      const den = 10n ** BigInt(fracPart.length);
      return rat(num, den);
    }
    if (this.peekChar() === "/") {
      const save = this.pos;
      this.advance();
      let denPart = "";
      while (!this.eof() && /[0-9]/.test(this.peekChar()!)) {
        denPart += this.advance();
      }
      if (denPart.length === 0) {
        // not a rational literal — back off.
        this.pos = save;
        return int(BigInt(intPart));
      }
      return rat(BigInt(intPart), BigInt(denPart));
    }
    if (intPart.length === 0) {
      throw new ToolError(`expr-parse: malformed number at position ${start}`, {});
    }
    return int(BigInt(intPart));
  }

  parseIdentifier(): Value {
    let id = "";
    while (!this.eof() && /[A-Za-z_0-9]/.test(this.peekChar()!)) id += this.advance();
    // Function call: an identifier immediately followed by '(' is a
    // call. We *don't* skip whitespace between identifier and '(' —
    // `sin (x)` would still be `sin * (x)` if we allowed that, which
    // is the expected reading; `sin(x)` is the canonical function
    // syntax. (sympy's parse_expr distinguishes these the same way.)
    if (this.peekChar() === "(") {
      this.advance();
      const args: Value[] = [];
      this.skipWs();
      if (this.peekChar() !== ")") {
        args.push(this.parseAdd());
        this.skipWs();
        while (this.peekChar() === ",") {
          this.advance();
          this.skipWs();
          args.push(this.parseAdd());
          this.skipWs();
        }
      }
      if (this.peekChar() !== ")") {
        throw new ToolError(
          `expr-parse: expected ')' to close call to ${JSON.stringify(id)} at position ${this.pos}`,
          { suggestion: "balance your parentheses" },
        );
      }
      this.advance();
      return expr(id, args);
    }
    return sym(id);
  }

  skipWs(): void {
    while (!this.eof()) {
      const c = this.peekChar()!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else break;
    }
  }

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  peekChar(): string | undefined {
    return this.pos < this.src.length ? this.src.charAt(this.pos) : undefined;
  }

  advance(): string {
    const c = this.src.charAt(this.pos);
    this.pos++;
    return c;
  }
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: S.kind("string"),
    output: outputSchema,
  },
  examples: [
    { description: "single integer literal", input: str("42"), output: int(42n) },
    { description: "single variable", input: str("x"), output: sym("x") },
    { description: "binary sum", input: str("x + 1"), output: expr("+", [sym("x"), int(1n)]) },
    {
      description: "left-assoc subtraction",
      input: str("a - b - c"),
      output: expr("-", [expr("-", [sym("a"), sym("b")]), sym("c")]),
    },
    {
      description: "precedence: * binds tighter than +",
      input: str("a + b*c"),
      output: expr("+", [sym("a"), expr("*", [sym("b"), sym("c")])]),
    },
    {
      description: "right-assoc exponent",
      input: str("x^2^3"),
      output: expr("^", [sym("x"), expr("^", [int(2n), int(3n)])]),
    },
    {
      description: "unary minus",
      input: str("-x"),
      output: expr("-", [sym("x")]),
    },
    {
      description: "rational literal",
      input: str("3/4"),
      output: rat(3n, 4n),
    },
    {
      description: "decimal literal",
      input: str("0.5"),
      output: rat(1n, 2n),
    },
    {
      description: "parenthesised group",
      input: str("(x + 1)*(x - 1)"),
      output: expr("*", [
        expr("+", [sym("x"), int(1n)]),
        expr("-", [sym("x"), int(1n)]),
      ]),
    },
    {
      description: "function call: sin(x)",
      input: str("sin(x)"),
      output: expr("sin", [sym("x")]),
    },
    {
      description: "nested call: exp(neg(t))",
      input: str("exp(neg(t))"),
      output: expr("exp", [expr("neg", [sym("t")])]),
    },
    {
      description: "lone '+' is rejected",
      input: str("+"),
      error: "expected expression",
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same source string → same output bytes",
      machine_checkable: true,
    },
    {
      name: "operator-precedence",
      statement: "* binds tighter than +; ^ tighter than unary -; ^ is right-associative",
      machine_checkable: true,
    },
    {
      name: "no-namespace-smell",
      statement: "input is a string Value (kind: 'string'), not a symbol with namespace='source'",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // Input is already-validated as kind="string"; the runner narrowed
    // it before this call. We can read .value directly.
    const p = new Parser(input.value);
    return p.parseTopLevel();
  },
  test: () => {
    // Compare via canonical bytes (the protocol's structural equality)
    // rather than JSON.stringify, which would be sensitive to key order.
    const cases: { in: string; out: Value }[] = [
      { in: "42", out: int(42n) },
      { in: "  -1 ", out: expr("-", [int(1n)]) },
      { in: "x", out: sym("x") },
      { in: "1+2", out: expr("+", [int(1n), int(2n)]) },
      { in: "1+2*3", out: expr("+", [int(1n), expr("*", [int(2n), int(3n)])]) },
      { in: "(1+2)*3", out: expr("*", [expr("+", [int(1n), int(2n)]), int(3n)]) },
      { in: "x^2", out: expr("^", [sym("x"), int(2n)]) },
      { in: "3/4", out: rat(3n, 4n) },
      { in: "1.5", out: rat(3n, 2n) },
      { in: "sin(x)", out: expr("sin", [sym("x")]) },
      { in: "cos(2*t)", out: expr("cos", [expr("*", [int(2n), sym("t")])]) },
      { in: "exp(-y0)", out: expr("exp", [expr("-", [sym("y0")])]) },
    ];
    for (const c of cases) {
      const got = new Parser(c.in).parseTopLevel();
      const a = canonicalize(got);
      const b = canonicalize(c.out);
      if (a !== b) throw new Error(`expr-parse self-test: input ${JSON.stringify(c.in)} got ${a}, expected ${b}`);
    }
  },
});

if (import.meta.main) void runTool(def);
