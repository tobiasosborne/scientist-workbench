// Bridge between expression-protocol values and RatFn/Poly internal forms.
// In-scope heads: + - * / ^   (with ^ requiring an integer literal exponent)
// In-scope leaves: integer, rational, symbol (without namespace)
// Everything else throws CasOutOfScopeError, which callers turn into either
// a tagged-out-of-scope value (cas-simplify) or an out-of-scope verdict (cas-verify).

import {
  expr,
  int,
  rat as protocolRat,
  sym,
  type Value,
} from "@workbench/protocol";
import {
  type Monomial,
  type Poly,
  POLY_ZERO,
  polyConst,
  polyConstValue,
  polyIsOne,
  polyIsZero,
  polyVar,
} from "./poly.js";
import {
  type RatFn,
  RATFN_ONE,
  RATFN_ZERO,
  makeRatFn,
  ratFnAdd,
  ratFnDiv,
  ratFnMul,
  ratFnNeg,
  ratFnPow,
  ratFnSub,
  ratFnFromPoly,
} from "./ratfn.js";
import { makeRat, type Rat, ratIsOne, ratIsZero, ratIsNegOne } from "./rat.js";

export class CasOutOfScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasOutOfScopeError";
  }
}

const MAX_EXPONENT = 1_000_000;

export function valueToRatFn(v: Value): RatFn {
  switch (v.kind) {
    case "integer":
      return ratFnFromPoly(polyConst(makeRat(BigInt(v.value))));
    case "rational":
      return ratFnFromPoly(polyConst(makeRat(BigInt(v.num), BigInt(v.den))));
    case "symbol": {
      if (v.namespace !== undefined) {
        throw new CasOutOfScopeError(`symbol with namespace: ${v.namespace}/${v.name}`);
      }
      return ratFnFromPoly(polyVar(v.name));
    }
    case "expression": {
      const head = v.head;
      const args = v.args;
      switch (head) {
        case "+": {
          if (args.length === 0) return RATFN_ZERO;
          let acc = valueToRatFn(args[0]!);
          for (let i = 1; i < args.length; i++) acc = ratFnAdd(acc, valueToRatFn(args[i]!));
          return acc;
        }
        case "*": {
          if (args.length === 0) return RATFN_ONE;
          let acc = valueToRatFn(args[0]!);
          for (let i = 1; i < args.length; i++) acc = ratFnMul(acc, valueToRatFn(args[i]!));
          return acc;
        }
        case "-": {
          if (args.length === 0) throw new CasOutOfScopeError("- with zero args");
          if (args.length === 1) return ratFnNeg(valueToRatFn(args[0]!));
          let acc = valueToRatFn(args[0]!);
          for (let i = 1; i < args.length; i++) acc = ratFnSub(acc, valueToRatFn(args[i]!));
          return acc;
        }
        case "/": {
          if (args.length !== 2) {
            throw new CasOutOfScopeError(`/ expects 2 args, got ${args.length}`);
          }
          return ratFnDiv(valueToRatFn(args[0]!), valueToRatFn(args[1]!));
        }
        case "^": {
          if (args.length !== 2) {
            throw new CasOutOfScopeError(`^ expects 2 args, got ${args.length}`);
          }
          const expArg = args[1]!;
          if (expArg.kind !== "integer") {
            throw new CasOutOfScopeError(`^ exponent not an integer literal (got kind ${expArg.kind})`);
          }
          const big = BigInt(expArg.value);
          if (big > BigInt(MAX_EXPONENT) || big < BigInt(-MAX_EXPONENT)) {
            throw new CasOutOfScopeError(`^ exponent magnitude exceeds ${MAX_EXPONENT}`);
          }
          const n = Number(big);
          const base = valueToRatFn(args[0]!);
          return ratFnPow(base, n);
        }
        default:
          throw new CasOutOfScopeError(`unknown head ${JSON.stringify(head)}`);
      }
    }
    case "tagged":
      throw new CasOutOfScopeError(`tagged value ${JSON.stringify(v.tag)}`);
    case "string":
    case "boolean":
    case "list":
    case "record":
    case "float64":
      throw new CasOutOfScopeError(`out-of-scope kind ${JSON.stringify(v.kind)}`);
  }
}

function ratToValue(r: Rat): Value {
  if (r.d === 1n) return int(r.n);
  return protocolRat(r.n, r.d);
}

function monomialToValue(m: Monomial): Value {
  if (m.exp.length === 0) return ratToValue(m.coef);
  const factors: Value[] = [];
  if (!ratIsOne(m.coef)) factors.push(ratToValue(m.coef));
  for (const [name, e] of m.exp) {
    if (e === 1) factors.push(sym(name));
    else if (e > 1) factors.push(expr("^", [sym(name), int(BigInt(e))]));
    else if (e < 0) factors.push(expr("^", [sym(name), int(BigInt(e))]));
    // e === 0 is impossible: normalised exp drops zero entries
  }
  if (factors.length === 0) return ratToValue(m.coef);
  if (factors.length === 1) return factors[0]!;
  return expr("*", factors);
}

export function polyToValue(p: Poly): Value {
  if (polyIsZero(p)) return int(0n);
  if (p.terms.length === 1) return monomialToValue(p.terms[0]!);
  return expr("+", p.terms.map(monomialToValue));
}

export function ratFnToValue(r: RatFn): Value {
  const numV = polyToValue(r.num);
  if (polyIsOne(r.den)) return numV;
  const denV = polyToValue(r.den);
  return expr("/", [numV, denV]);
}

// Heuristic: did this value, viewed as an expression tree, denote a single rational scalar?
// Useful for cas-simplify so that "1+1" emits "2" rather than re-emitting an integer cleanly.
export function ratFnConstValue(r: RatFn): Rat | null {
  if (!polyIsOne(r.den)) return null;
  return polyConstValue(r.num);
}

export function _internals() {
  return { POLY_ZERO, RATFN_ZERO, makeRatFn, ratIsZero, ratIsNegOne };
}
