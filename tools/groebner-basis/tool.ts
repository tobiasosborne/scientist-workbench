// =============================================================================
// groebner-basis — multivariate Gröbner-basis computation over ℚ
// =============================================================================
//
// Intent
// ------
// Given a finite set of polynomials `F = {f_1, …, f_m} ⊂ ℚ[x_1, …, x_n]`
// (carried as expression Values), the requested variable order, and a
// monomial order, return a *Gröbner basis* of the ideal `⟨F⟩` under
// that order.
//
// The substrate is `@workbench/groebner` — Buchberger 1965 with sugar
// pair selection (Giovini-Mora-Niesi-Robbiano-Traverso 1991), the two
// pruning criteria in Gebauer-Möller form, and full interreduction to
// the unique reduced GB. The whole computation is exact rational
// arithmetic over BigInt — symbolic determinism tier per ADR-0015.
//
// Out of scope
// ------------
// • Coefficient fields beyond ℚ (no `𝔽_p[x]`, no `ℚ(α)[x]`).
// • Monomial orders beyond `lex` and `degrevlex`. (Block / weighted /
//   elimination orderings would need a discriminated `MonomialOrder`
//   payload; deferred per RESEARCH-NOTE §2-G.)
// • F4 / F5 algorithms — deferred per RESEARCH-NOTE §2-G; the v0.1
//   Buchberger substrate is the ground-truth-confirmed reference.
//
// Input shape (matches benchmarks/groebner-basis/run-candidate.ts)
// ----------------------------------------------------------------
//   record {
//     polys: list<expression>,
//     vars:  list<symbol>,
//     order: string ("lex" | "degrevlex"),
//   }
//
// Output shape (happy path)
// -------------------------
//   record {
//     basis:    list<expression>,
//     order:    string,
//     vars:     list<symbol>,
//     n_pairs:  integer,
//     warnings: list<string>,
//   }
//
// Output shape (boundary refusal)
// -------------------------------
//   tagged "groebner-basis/<class>" with payload record { detail: string }
//
//   classes (per the bench's tag namespace):
//     • non-polynomial — input has heads outside `+ − * / ^`
//     • parametric    — input mentions a symbol outside `vars`
//     • empty-input   — `polys` list is empty
//     • empty-vars    — `vars` list is empty
//
// `ToolError` is reserved for malformed input (`polys` not a list,
// `order` not a string, an entry of `vars` not a symbol). These are
// schema-level violations and should fail the runner's pre-fn
// validation step (ADR-0008); the body never sees them.

import {
  expr,
  int,
  list,
  record,
  S,
  str,
  sym,
  tagged,
  ToolError,
  type ListValue,
  type RecordValue,
  type StringValue,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  type Poly,
  type Rat,
  CasOutOfScopeError,
  RAT_RING,
  makeRat,
  polyConst,
  polyToValue,
  valueToRatFn,
} from "@workbench/cas-core";
import {
  buchbergerReduced,
  drlOrder,
  lexOrder,
  type MonomialOrder,
} from "@workbench/groebner";

const NAME = "groebner-basis";
const VERSION = "0.1.0";
const TAG_NON_POLYNOMIAL = "groebner-basis/non-polynomial";
const TAG_PARAMETRIC = "groebner-basis/parametric";
const TAG_EMPTY_INPUT = "groebner-basis/empty-input";
const TAG_EMPTY_VARS = "groebner-basis/empty-vars";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  polys: S.list(S.any()),
  vars: S.list(S.kind("symbol")),
  order: S.kind("string"),
});

// Output union: happy-path record OR one of the four tagged refusals.
// Each refusal payload is `record { detail: string }`. The output
// schema is declared as `S.any()` for the same reason `tools/solve`
// does — the Value union narrows poorly under TS inference (a
// `polyToValue` result can be `SymbolValue | ExpressionValue |
// IntegerValue | RationalValue` depending on the polynomial's shape,
// and the schema's static row structure can't express that without
// fighting `RecordValueOf<…, never>` inference). Goldens enforce the
// shape; the body builds it deliberately with helper constructors.
const outputSchema = S.any();

// -----------------------------------------------------------------------------
// Body helpers
// -----------------------------------------------------------------------------

function refuse(tag: string, detail: string): Value {
  return tagged(tag, record({ detail: str(detail) }));
}

function decodeInput(input: RecordValue): {
  polysList: ListValue;
  varSyms: SymbolValue[];
  orderStr: string;
} {
  const polysField = input.fields.polys as Value;
  const varsField = input.fields.vars as Value;
  const orderField = input.fields.order as Value;

  if (polysField.kind !== "list") {
    throw new ToolError("`polys` must be a list", { detail: `got kind=${polysField.kind}` });
  }
  if (varsField.kind !== "list") {
    throw new ToolError("`vars` must be a list", { detail: `got kind=${varsField.kind}` });
  }
  if (orderField.kind !== "string") {
    throw new ToolError("`order` must be a string", { detail: `got kind=${orderField.kind}` });
  }
  const varSyms: SymbolValue[] = [];
  for (const v of (varsField as ListValue).items) {
    if (v.kind !== "symbol") {
      throw new ToolError("each entry of `vars` must be a symbol", {
        detail: `got kind=${v.kind}`,
      });
    }
    varSyms.push(v);
  }
  return {
    polysList: polysField as ListValue,
    varSyms,
    orderStr: (orderField as StringValue).value,
  };
}

/**
 * Convert a single input expression to `Poly<Rat>`. Wraps the
 * cas-core `valueToRatFn` and applies the standard "non-trivial
 * denominator means non-polynomial" check. Throws structured errors
 * the body translates into refusal tags.
 */
class InputClassError extends Error {
  constructor(public tag: string, message: string) { super(message); }
}

function expressionToPoly(v: Value, varSet: ReadonlySet<string>): Poly<Rat> {
  let rf;
  try {
    rf = valueToRatFn(v);
  } catch (e) {
    if (e instanceof CasOutOfScopeError) {
      throw new InputClassError(
        TAG_NON_POLYNOMIAL,
        `polynomial is not in the closed +/-/*/^ vocabulary over ℚ: ${e.message}`,
      );
    }
    throw e;
  }
  // Reject non-polynomial: rational function with non-constant
  // denominator. Constant rational denominators are absorbed.
  if (rf.den.terms.length !== 1 || rf.den.terms[0]!.exp.length !== 0) {
    throw new InputClassError(
      TAG_NON_POLYNOMIAL,
      "polynomial is a rational function with non-constant denominator",
    );
  }
  let p: Poly<Rat> = rf.num;
  if (rf.den.terms[0]!.coef.n !== 1n || rf.den.terms[0]!.coef.d !== 1n) {
    const inv = makeRat(rf.den.terms[0]!.coef.d, rf.den.terms[0]!.coef.n);
    p = {
      terms: p.terms.map((t) => ({
        exp: t.exp,
        coef: makeRat(t.coef.n * inv.n, t.coef.d * inv.d),
      })),
    };
  }
  // Parametric check: every variable in p must be in `varSet`.
  for (const t of p.terms) {
    for (const [name] of t.exp) {
      if (!varSet.has(name)) {
        throw new InputClassError(
          TAG_PARAMETRIC,
          `polynomial mentions symbol '${name}' which is not in the declared vars list`,
        );
      }
    }
  }
  return p;
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Multivariate Gröbner basis over Q for `lex` and `degrevlex` orders; Buchberger 1965 + sloppy sugar + Gebauer-Möller pruning + full inter-reduction to the unique reduced GB. Symbolic tier",
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "Classic CLO Ch.2 §6 Example 1 — (x²+y, xy+1) under lex with x>y",
      input: record({
        polys: list([
          // x² + y
          expr("+", [expr("^", [sym("x"), int(2n)]), sym("y")]),
          // x*y + 1
          expr("+", [expr("*", [sym("x"), sym("y")]), int(1n)]),
        ]),
        vars: list([sym("x"), sym("y")]),
        order: str("lex"),
      }),
      // Under lex with x > y, the GB is { x − y², y³ + 1 } (descending
      // by leading monomial). `output` is omitted: the `n_pairs`
      // diagnostic (S-pairs processed by Buchberger) is an algorithmic
      // detail not worth pinning by hand — the byte-exact record lives
      // in the folded golden (ADR-0043 / issue ixnv.3).
    },
    {
      description: "Empty input — boundary refusal",
      input: record({
        polys: list([]),
        vars: list([sym("x")]),
        order: str("lex"),
      }),
      output: refuse(TAG_EMPTY_INPUT, "polys list is empty"),
    },
    {
      description: "Empty vars — boundary refusal",
      input: record({
        polys: list([sym("x")]),
        vars: list([]),
        order: str("lex"),
      }),
      output: refuse(TAG_EMPTY_VARS, "vars list is empty"),
    },
    {
      description: "Foreign vocabulary (sin) — non-polynomial refusal",
      input: record({
        polys: list([expr("sin", [sym("x")])]),
        vars: list([sym("x")]),
        order: str("lex"),
      }),
      output: refuse(
        TAG_NON_POLYNOMIAL,
        "polynomial #1: polynomial is not in the closed +/-/*/^ vocabulary over ℚ: unknown head \"sin\"",
      ),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes (symbolic tier; bit-identical cross-platform)",
      machine_checkable: true,
    },
    {
      name: "ideal-equality",
      statement: "the ideal generated by the output basis equals the ideal generated by the input polynomials",
      machine_checkable: true,
    },
    {
      name: "buchberger-property",
      statement: "every S-polynomial of pairs in the output basis reduces to 0 modulo the basis (CLO Ch.2 §6 Theorem 6)",
      machine_checkable: true,
    },
    {
      name: "reduced-form",
      statement: "every basis element is monic; no leading monomial divides another's leading monomial; tails are fully reduced",
      machine_checkable: true,
    },
    {
      name: "boundary-refusals-tagged",
      statement: "non-polynomial / parametric / empty-input / empty-vars inputs return tagged \"groebner-basis/<class>\" with detail; never silently wrong basis",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    const inputRec = input as RecordValue;
    const { polysList, varSyms, orderStr } = decodeInput(inputRec);

    // Boundary refusals.
    if (polysList.items.length === 0) {
      return refuse(TAG_EMPTY_INPUT, "polys list is empty");
    }
    if (varSyms.length === 0) {
      return refuse(TAG_EMPTY_VARS, "vars list is empty");
    }
    if (orderStr !== "lex" && orderStr !== "degrevlex") {
      throw new ToolError(`unknown monomial order ${JSON.stringify(orderStr)}`, {
        detail: "expected 'lex' or 'degrevlex'",
      });
    }

    const varNames = varSyms.map((s) => s.name);
    const varSet = new Set(varNames);

    // Convert each polynomial expression to Poly<Rat>; surface refusals.
    const polys: Poly<Rat>[] = [];
    for (let i = 0; i < polysList.items.length; i++) {
      const v = polysList.items[i]!;
      try {
        polys.push(expressionToPoly(v, varSet));
      } catch (e) {
        if (e instanceof InputClassError) {
          return refuse(e.tag, `polynomial #${i + 1}: ${e.message}`);
        }
        throw e;
      }
    }

    // Compute the basis under the requested order.
    const order: MonomialOrder = orderStr === "lex" ? lexOrder(varNames) : drlOrder(varNames);
    const result = buchbergerReduced(polys, order);

    return record({
      basis: list(result.basis.map((p) => polyToValue(p))),
      order: str(orderStr),
      vars: list(varNames.map((n) => sym(n))),
      n_pairs: int(BigInt(result.nPairs)),
      warnings: list(result.warnings.map((w) => str(w))),
    });
  },
  test: () => {
    // Probe 1: empty input → tagged empty-input.
    const emptyIn = def.fn(
      record({ polys: list([]), vars: list([sym("x")]), order: str("lex") }) as never,
      {} as never,
    ) as Value;
    if (emptyIn.kind !== "tagged" || emptyIn.tag !== TAG_EMPTY_INPUT) {
      throw new Error(`groebner-basis --test: expected ${TAG_EMPTY_INPUT}, got ${JSON.stringify(emptyIn)}`);
    }

    // Probe 2: empty vars → tagged empty-vars.
    const emptyVars = def.fn(
      record({ polys: list([sym("x")]), vars: list([]), order: str("lex") }) as never,
      {} as never,
    ) as Value;
    if (emptyVars.kind !== "tagged" || emptyVars.tag !== TAG_EMPTY_VARS) {
      throw new Error(`groebner-basis --test: expected ${TAG_EMPTY_VARS}, got ${JSON.stringify(emptyVars)}`);
    }

    // Probe 3: parametric (foreign symbol).
    const parametric = def.fn(
      record({
        polys: list([expr("+", [sym("x"), sym("a")])]),
        vars: list([sym("x")]),
        order: str("lex"),
      }) as never,
      {} as never,
    ) as Value;
    if (parametric.kind !== "tagged" || parametric.tag !== TAG_PARAMETRIC) {
      throw new Error(`groebner-basis --test: expected ${TAG_PARAMETRIC}, got ${JSON.stringify(parametric)}`);
    }

    // Probe 4: non-polynomial (sin head).
    const nonPoly = def.fn(
      record({
        polys: list([expr("sin", [sym("x")])]),
        vars: list([sym("x")]),
        order: str("lex"),
      }) as never,
      {} as never,
    ) as Value;
    if (nonPoly.kind !== "tagged" || nonPoly.tag !== TAG_NON_POLYNOMIAL) {
      throw new Error(`groebner-basis --test: expected ${TAG_NON_POLYNOMIAL}, got ${JSON.stringify(nonPoly)}`);
    }

    // Probe 5: monomial-only ideal — already a GB. {x²} → {x²}.
    const monoIn = record({
      polys: list([expr("^", [sym("x"), int(2n)])]),
      vars: list([sym("x")]),
      order: str("lex"),
    });
    const monoOut = def.fn(monoIn as never, {} as never) as Value;
    if (monoOut.kind !== "record") {
      throw new Error(`groebner-basis --test: expected record output for {x²}, got ${monoOut.kind}`);
    }
    const basisField = monoOut.fields["basis"];
    if (!basisField || basisField.kind !== "list" || basisField.items.length !== 1) {
      throw new Error(`groebner-basis --test: expected 1 basis element for {x²}`);
    }

    // Probe 6: classic (x²+y, xy+1) under lex with x>y. Expect 2 elements.
    const classicIn = record({
      polys: list([
        expr("+", [expr("^", [sym("x"), int(2n)]), sym("y")]),
        expr("+", [expr("*", [sym("x"), sym("y")]), int(1n)]),
      ]),
      vars: list([sym("x"), sym("y")]),
      order: str("lex"),
    });
    const classicOut = def.fn(classicIn as never, {} as never) as Value;
    if (classicOut.kind !== "record") {
      throw new Error(`groebner-basis --test: expected record output for (x²+y, xy+1)`);
    }
    const cbField = classicOut.fields["basis"];
    if (!cbField || cbField.kind !== "list" || cbField.items.length !== 2) {
      throw new Error(
        `groebner-basis --test: expected 2 basis elements for (x²+y, xy+1) under lex, got ${
          cbField?.kind === "list" ? cbField.items.length : "?"
        }`,
      );
    }

    console.log(
      `groebner-basis --test: 6 probes pass (4 refusal classes + 2 happy paths); full coverage in ../scientist-workbench-corpus/benchmarks/groebner-basis/.`,
    );
    void RAT_RING;
    void polyConst;
  },
});

if (import.meta.main) void runTool(def);
