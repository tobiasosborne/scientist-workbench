// cas-simplify behaviour: convert in-scope subtrees to canonical RatFn form;
// wrap out-of-scope subtrees (after recursing into children) in
// `tagged "cas-simplify/out-of-scope"`. Already-tagged values with our tag
// pass through verbatim (idempotence).

import { expr, list, record, tagged, type Value } from "@workbench/protocol";
import { CasOutOfScopeError, ratFnToValue, valueToRatFn } from "./expr-bridge.js";

export const SIMPLIFY_TAG = "cas-simplify/out-of-scope";

export function casSimplify(v: Value): Value {
  if (v.kind === "tagged" && v.tag === SIMPLIFY_TAG) return v;
  try {
    const rf = valueToRatFn(v);
    return ratFnToValue(rf);
  } catch (e) {
    if (!(e instanceof CasOutOfScopeError)) throw e;
    const inner = recurseChildren(v);
    return tagged(SIMPLIFY_TAG, inner);
  }
}

function recurseChildren(v: Value): Value {
  switch (v.kind) {
    case "expression":
      return expr(v.head, v.args.map(casSimplify));
    case "list":
      return list(v.items.map(casSimplify));
    case "record": {
      const f: Record<string, Value> = {};
      for (const [k, vv] of Object.entries(v.fields)) f[k] = casSimplify(vv);
      return record(f);
    }
    case "tagged":
      return v;
    case "symbol":
    case "string":
    case "integer":
    case "rational":
    case "float64":
    case "boolean":
      return v;
  }
}
