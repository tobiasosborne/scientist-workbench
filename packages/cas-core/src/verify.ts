// cas-verify behaviour: decide A = B over Q(x_1, ..., x_n) by cross-multiplication.
// On equality: { equal: true }.
// On inequality (in-scope): { equal: false, reason: "not-equal", witness: <lhs - rhs> }.
// On either side out-of-scope: { equal: false, reason: "out-of-scope", side, detail }.

import { bool, record, str, type Value } from "@workbench/protocol";
import { CasOutOfScopeError, ratFnToValue, valueToRatFn } from "./expr-bridge.js";
import { ratFnEq, ratFnSub } from "./ratfn.js";

export interface VerifyInput {
  readonly lhs: Value;
  readonly rhs: Value;
}

export function casVerify(input: VerifyInput): Value {
  let lhsRf;
  try {
    lhsRf = valueToRatFn(input.lhs);
  } catch (e) {
    if (e instanceof CasOutOfScopeError) {
      return record({
        detail: str(e.message),
        equal: bool(false),
        reason: str("out-of-scope"),
        side: str("lhs"),
      });
    }
    throw e;
  }
  let rhsRf;
  try {
    rhsRf = valueToRatFn(input.rhs);
  } catch (e) {
    if (e instanceof CasOutOfScopeError) {
      return record({
        detail: str(e.message),
        equal: bool(false),
        reason: str("out-of-scope"),
        side: str("rhs"),
      });
    }
    throw e;
  }
  if (ratFnEq(lhsRf, rhsRf)) {
    return record({ equal: bool(true) });
  }
  const witness = ratFnSub(lhsRf, rhsRf);
  return record({
    equal: bool(false),
    reason: str("not-equal"),
    witness: ratFnToValue(witness),
  });
}
