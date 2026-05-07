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
// `Root` is canonical by construction). `valueToRoot` accepts a value
// that *claims* to be canonical and verifies the cheap canary
// invariants (degree ≥ 1, integer coefficients, positive leading,
// primitive); if any fail, it throws. We do **not** verify
// irreducibility on parse — that requires factoring, which is expensive
// and is the producer's responsibility. A non-canonical `Root[]`
// reaching `valueToRoot` is a contract violation upstream; our role is
// to surface the violation, not to silently rebuild via `makeRoot`
// (which would require re-isolating real roots and recomputing `k`,
// effectively doing the constructor's work on every parse).
//
// The interval is **runtime state**, not part of the wire. On parse,
// we reconstruct it by isolating the canonical minpoly's real roots
// and taking the `k`-th. This re-derivation is deterministic and
// keeps the byte-form a function of the algebraic number alone.

import {
  type Value,
  type ExpressionValue,
  expr,
  int,
} from "@workbench/protocol";
import {
  type Poly,
  INT_RING,
  polyConstValue,
  polyCoeffsInVar,
  polyDegInVar,
  polyFromCoeffsInVar,
  polyIsZero,
} from "@workbench/cas-core";
import { isolateRealRoots } from "@workbench/real-roots";

import {
  type Root,
  ROOT_VAR,
  polyToHighToLowRat,
} from "./root.js";

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

  // Verify canonical-form invariants (cheap canaries; full
  // irreducibility is the producer's responsibility, see header).
  verifyCanonicalForm(intCoeffs);

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
  // The realistic upper bound is the polynomial degree; we sanity-check
  // against degree+1 to catch obvious nonsense, then refine by checking
  // against the actual real-root count below.
  const degree = intCoeffs.length - 1;
  if (kBig > BigInt(degree)) {
    throw new Error(
      `valueToRoot: Root index k=${kArg.value} exceeds polynomial degree ${degree}`,
    );
  }
  const k = Number(kBig);

  // Build the Poly<bigint> in `ROOT_VAR`.
  const minpoly = polyFromIntCoeffs(intCoeffs);

  // Recover the interval by isolating real roots.
  const intervals = isolateRealRoots(polyToHighToLowRat(minpoly, ROOT_VAR));
  if (k >= intervals.length) {
    throw new Error(
      `valueToRoot: Root index k=${k} ≥ #real-roots (${intervals.length}) of minpoly; complex `
        + `Root[] values are not supported in this v0.1 — use a real-root index`,
    );
  }
  const interval = intervals[k]!;
  return { minpoly, k, interval };
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

function polyFromIntCoeffs(coeffs: readonly bigint[]): Poly<bigint> {
  const coefPolys: Poly<bigint>[] = coeffs.map((c) =>
    c === 0n ? { terms: [] } : { terms: [{ exp: [], coef: c }] },
  );
  return polyFromCoeffsInVar(coefPolys, ROOT_VAR, INT_RING);
}

/** Verify the canonical-form invariants on the *integer-coefficient*
 * encoding: positive leading coefficient, gcd of coefficients = 1.
 * Irreducibility is *not* verified (see header). */
function verifyCanonicalForm(coeffs: readonly bigint[]): void {
  const lc = coeffs[coeffs.length - 1]!;
  if (lc <= 0n) {
    throw new Error(
      `valueToRoot: minpoly leading coefficient must be positive; got ${lc}`,
    );
  }
  let g: bigint = 0n;
  for (const c of coeffs) g = gcdBig(g, c < 0n ? -c : c);
  if (g === 0n) {
    throw new Error("valueToRoot: minpoly is the zero polynomial");
  }
  if (g !== 1n) {
    throw new Error(
      `valueToRoot: minpoly is not primitive (coefficient gcd = ${g}, expected 1)`,
    );
  }
}

function describeKind(v: Value): string {
  if (v.kind === "expression") return `expression head="${v.head}"`;
  return v.kind;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let aa = a < 0n ? -a : a;
  let bb = b < 0n ? -b : b;
  while (bb !== 0n) {
    const t = aa % bb;
    aa = bb;
    bb = t;
  }
  return aa;
}
