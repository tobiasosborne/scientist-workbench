// =============================================================================
// encoding.ts — `Root` ↔ value-protocol expression
// =============================================================================
//
// Wire shape (ADR-0018):
//
//   expression {
//     head: "Root",
//     args: [
//       expression {
//         head: "Polynomial",
//         args: [c_0, c_1, …, c_n]      // ℤ-typed `integer` values, low-to-high
//       },
//       integer { value: "<k>" }          // 0-indexed root selector
//     ]
//   }
//
// The polynomial encoding is positional (the variable is implicit; a
// `Root` carries no per-instance variable name). The coefficients are
// always integer-typed because the canonical form lives in ℤ[x] —
// rational coefficients are forbidden (see `canonicalIntegerForm`).
//
// `rootToValue` produces a value already in canonical form (the source
// `Root` is canonical by construction). `valueToRoot` parses any
// `Root[poly, k]` wire value — canonical or not — and silently
// canonicalises via `makeRootByIndex` per ADR-0018:
//
//     "Direct construction with non-canonical input is not a
//      `ToolError` — it's silently canonicalised — because the
//      construction site … often does not know in advance that its
//      output is already canonical."
//
// We do *not* take a fast path on cheap canaries (positive-leading
// coefficient + primitive). A polynomial that passes those canaries
// can still be reducible (e.g. `x^4 − 5x^2 + 6 = (x^2 − 2)(x^2 − 3)`
// is primitive with positive leading coefficient but factors), so a
// fast path that trusts those checks would silently emit a `Root`
// whose minpoly is *not* the canonical irreducible minimal polynomial
// — a contract violation that propagates through equality, hashing,
// and arithmetic. The only sound check for canonicality is factoring;
// that is `makeRootByIndex`'s job. Round-trip cost on a canonical
// input is a `factorRatQ` of an already-irreducible polynomial,
// which factors trivially (the lucky-prime modular check confirms
// irreducibility in one pass) — measurable but bounded.
//
// The interval is **runtime state**, not part of the wire. On parse,
// `makeRootByIndex` reconstructs it by isolating real roots and
// taking the `k`-th. This re-derivation is deterministic and keeps
// the byte form a function of the algebraic number alone.

import {
  type Value,
  type ExpressionValue,
  expr,
  int,
} from "@workbench/protocol";
import {
  type Poly,
  type Rat,
  INT_RING,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyConstValue,
  polyCoeffsInVar,
  polyDegInVar,
  polyIsZero,
  polyMul,
  polyVar,
} from "@workbench/cas-core";

import { type Root, ROOT_VAR } from "./root.js";
import { makeRootByIndex } from "./by-index.js";

// -----------------------------------------------------------------------------
// rootToValue
// -----------------------------------------------------------------------------

export function rootToValue(r: Root): Value {
  const lowToHigh = lowToHighIntCoeffs(r.minpoly);
  const polyExpr: ExpressionValue = expr(
    "Polynomial",
    lowToHigh.map((c) => int(c)),
  );
  return expr("Root", [polyExpr, int(BigInt(r.k))]);
}

// -----------------------------------------------------------------------------
// valueToRoot
// -----------------------------------------------------------------------------

export function valueToRoot(v: Value): Root {
  if (v.kind !== "expression" || v.head !== "Root") {
    throw new Error(
      `valueToRoot: expected expression with head "Root", got kind=${v.kind}${v.kind === "expression" ? `, head="${v.head}"` : ""}`,
    );
  }
  if (v.args.length !== 2) {
    throw new Error(
      `valueToRoot: Root expression must have 2 arguments (Polynomial, k); got ${v.args.length}`,
    );
  }

  const polyArg = v.args[0]!;
  if (polyArg.kind !== "expression" || polyArg.head !== "Polynomial") {
    throw new Error(
      `valueToRoot: first argument of Root must be expression head "Polynomial"; got ${describeKind(polyArg)}`,
    );
  }
  const coeffArgs = polyArg.args;
  if (coeffArgs.length < 2) {
    throw new Error(
      `valueToRoot: Polynomial must have at least 2 coefficients (degree ≥ 1); got ${coeffArgs.length}`,
    );
  }

  const intCoeffs: bigint[] = coeffArgs.map((c, i) => {
    if (c.kind !== "integer") {
      throw new Error(
        `valueToRoot: Polynomial coefficient ${i} must be integer; got ${describeKind(c)}`,
      );
    }
    return BigInt(c.value);
  });

  const kArg = v.args[1]!;
  if (kArg.kind !== "integer") {
    throw new Error(
      `valueToRoot: Root index k must be integer; got ${describeKind(kArg)}`,
    );
  }
  const kBig = BigInt(kArg.value);
  if (kBig < 0n) {
    throw new Error(`valueToRoot: Root index k must be non-negative; got ${kArg.value}`);
  }
  // Sanity bound — `k` cannot exceed the polynomial's degree (the
  // count of real roots is at most the degree). Catches obvious
  // nonsense before we factor.
  const degree = intCoeffs.length - 1;
  if (kBig > BigInt(degree)) {
    throw new Error(
      `valueToRoot: Root index k=${kArg.value} exceeds polynomial degree ${degree}`,
    );
  }
  const k = Number(kBig);

  // Always defer to `makeRootByIndex`, which factors over ℚ, picks the
  // right irreducible factor by global real-value ordering, and returns
  // the canonical `Root`. See header for why no fast path on cheap
  // canonicality canaries.
  const polyRat = intCoeffsToRatPoly(intCoeffs);
  return makeRootByIndex(polyRat, k, ROOT_VAR);
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function lowToHighIntCoeffs(minpoly: Poly<bigint>): bigint[] {
  if (polyIsZero(minpoly)) {
    throw new Error("rootToValue: minpoly is zero — invalid Root");
  }
  const d = polyDegInVar(minpoly, ROOT_VAR);
  const coeffPolys = polyCoeffsInVar(minpoly, ROOT_VAR, INT_RING);
  const out: bigint[] = [];
  for (let i = 0; i <= d; i++) {
    const c = polyConstValue(coeffPolys[i]!, INT_RING);
    out.push(c ?? 0n);
  }
  return out;
}

/** Build a `Poly<Rat>` in `ROOT_VAR` from a low-to-high integer
 * coefficient list. Feeds `makeRootByIndex` from the wire-encoded
 * `Polynomial[c_0, …, c_n]` argument list. */
function intCoeffsToRatPoly(coeffs: readonly bigint[]): Poly<Rat> {
  const X = polyVar<Rat>(ROOT_VAR, RAT_RING);
  const ONE = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);
  let acc: Poly<Rat> = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  let pow: Poly<Rat> = ONE;
  for (let i = 0; i < coeffs.length; i++) {
    const term = polyMul(
      polyConst<Rat>(makeRat(coeffs[i]!, 1n), RAT_RING),
      pow,
      RAT_RING,
    );
    acc = polyAdd(acc, term, RAT_RING);
    if (i + 1 < coeffs.length) pow = polyMul(pow, X, RAT_RING);
  }
  return acc;
}

function describeKind(v: Value): string {
  if (v.kind === "expression") return `expression head="${v.head}"`;
  return v.kind;
}
