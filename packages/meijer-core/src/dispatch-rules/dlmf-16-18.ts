// =============================================================================
// dlmf-16-18.ts — DLMF §16.17–§16.19 elementary-function identities
// =============================================================================
//
// **Source.** NIST Digital Library of Mathematical Functions, Chapter
// 16 "Generalized Hypergeometric Functions and Meijer G-Function"
// (R. A. Askey, A. B. Olde Daalhuis eds.), https://dlmf.nist.gov/16.
//
// **Verification discipline.** Every rule below was verified against
// `mpmath.meijerg` at 30 dps before being included. Cases where the
// closed form quoted in textbooks turned out NOT to match mpmath at
// the stated parameters (typically because of an unstated argument
// or parameter convention) were either dropped or replaced with the
// shape that mpmath agrees with. The test in
// `dispatch-mpmath.test.ts` re-validates each rule per `bun test`.
//
// **v0.1 coverage.** A small starter set of elementary-function
// reductions that mpmath agrees with at the stated parameter shape.
// The full DLMF §16.18 Examples table contains many more entries,
// most involving argument transformations or pFq emissions; those
// land in follow-up beads alongside the broader Wolfram-Functions
// expansion.

import { expr, int, rat, sym, type Value } from "@workbench/protocol";
import {
  mkDiv,
  mkPlus,
  mkPower,
  mkTimes,
} from "@workbench/cas-core";
import type { ReductionRule } from "../dispatch-types.js";

// -----------------------------------------------------------------------------
// Helper builders
// -----------------------------------------------------------------------------

const PI = sym("pi");

function I(n: number): Value {
  return int(BigInt(n));
}
function R(n: number, d: number): Value {
  return rat(BigInt(n), BigInt(d));
}

// =============================================================================
// Rules
// =============================================================================

export const RULES: ReductionRule[] = [

  // ---------------------------------------------------------------------------
  // DLMF 16.17 / Marichev convention — empty MeijerG
  //
  //   G^{0,0}_{0,0}(_; _ | z) = 1
  //
  // The degenerate Mellin-Barnes integrand `1`. Verified mpmath:
  //   meijerg([[],[]], [[],[]], 2) = 1.0
  // ---------------------------------------------------------------------------
  {
    id: "dlmf-empty",
    source: "DLMF §16.17 (degenerate Mellin–Barnes; Marichev convention)",
    note: "G^{0,0}_{0,0}(_; _ | z) = 1",
    match: {
      mnpq: { m: 0, n: 0, p: 0, q: 0 },
      an: [],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: () => I(1),
  },

  // ---------------------------------------------------------------------------
  // DLMF 16.17.E2 — exponential-integral E_1 reduction
  //
  //   G^{2,0}_{1,2}(1; 0, 0 | z) = E_1(z) = -Ei(-z)
  //
  // Verified mpmath:
  //   meijerg([[],[1]], [[0,0],[]], 2) = 0.04890... = E_1(2) ✓
  //
  // Slot layout: m=2, n=0, p=1, q=2.
  //   an = ()                    (n = 0)
  //   ap = (1)                   (p − n = 1; the upper-denominator slot)
  //   bm = (0, 0)                (m = 2)
  //   bq = ()                    (q − m = 0)
  // ---------------------------------------------------------------------------
  {
    id: "dlmf-16-17-e1",
    source: "DLMF 16.17.E2 (E_1 reduction)",
    note: "G^{2,0}_{1,2}(1; 0, 0 | z) = E_1(z) = -Ei(-z)",
    match: {
      mnpq: { m: 2, n: 0, p: 1, q: 2 },
      an: [],
      ap: [{ kind: "lit-int", value: 1 }],
      bm: [
        { kind: "lit-int", value: 0 },
        { kind: "lit-int", value: 0 },
      ],
      bq: [],
    },
    rewrite: (_, z) => expr("ExpIntegralE", [I(1), z]),
  },

  // ---------------------------------------------------------------------------
  // DLMF §16.18 / Wolfram Functions Site — sqrt(π)·erf(√z)
  //
  //   G^{1,1}_{1,2}(1; 1/2, 0 | z) = √π · erf(√z)
  //
  // Verified mpmath:
  //   meijerg([[1],[]], [[1/2],[0]], 2) = 1.6918... = √π · erf(√2) ✓
  //
  // Slot layout: m=1, n=1, p=1, q=2.
  //   an = (1), ap = (), bm = (1/2), bq = (0).
  // After canonical sort: bm has 1 elt, bq has 1 elt; no within-list
  // permutation required.
  // ---------------------------------------------------------------------------
  {
    id: "dlmf-16-18-erf",
    source: "DLMF §16.18 Examples / Wolfram Functions (erf reduction)",
    note: "G^{1,1}_{1,2}(1; 1/2, 0 | z) = √π · erf(√z)",
    match: {
      mnpq: { m: 1, n: 1, p: 1, q: 2 },
      an: [{ kind: "lit-int", value: 1 }],
      ap: [],
      bm: [{ kind: "lit-rat", num: 1, den: 2 }],
      bq: [{ kind: "lit-int", value: 0 }],
    },
    rewrite: (_, z) => {
      const sqrtPi = mkPower(PI, R(1, 2));
      const sqrtZ = mkPower(z, R(1, 2));
      return mkTimes(sqrtPi, expr("Erf", [sqrtZ]));
    },
  },

  // ---------------------------------------------------------------------------
  // DLMF §16.18 / Wolfram Functions Site — log(1+z)
  //
  //   G^{1,2}_{2,2}(1, 1; 1, 0 | z) = log(1+z)
  //
  // Verified mpmath:
  //   meijerg([[1,1],[]], [[1],[0]], 2) = 1.0986... = log(3) ✓
  //
  // Slot layout: m=1, n=2, p=2, q=2.
  //   an = (1, 1), ap = (), bm = (1), bq = (0).
  // ---------------------------------------------------------------------------
  {
    id: "dlmf-16-18-log",
    source: "DLMF §16.18 Examples / Wolfram Functions (log(1+z) reduction)",
    note: "G^{1,2}_{2,2}(1, 1; 1, 0 | z) = log(1+z)",
    match: {
      mnpq: { m: 1, n: 2, p: 2, q: 2 },
      an: [
        { kind: "lit-int", value: 1 },
        { kind: "lit-int", value: 1 },
      ],
      ap: [],
      bm: [{ kind: "lit-int", value: 1 }],
      bq: [{ kind: "lit-int", value: 0 }],
    },
    rewrite: (_, z) => expr("log", [mkPlus([I(1), z])]),
  },

  // ---------------------------------------------------------------------------
  // DLMF §16.18 / Wolfram Functions Site — 2·arctan(√z)
  //
  //   G^{1,2}_{2,2}(1/2, 1; 1/2, 0 | z) = 2 · arctan(√z)
  //
  // Verified mpmath:
  //   meijerg([[1/2, 1],[]], [[1/2],[0]], 2) = 1.9106... = 2 atan(√2) ✓
  //
  // Slot layout: m=1, n=2, p=2, q=2.
  //   an = (1/2, 1), ap = (), bm = (1/2), bq = (0).
  // After canonical-bytes sort, an = (rat(1,2), int(1)) — rationals
  // sort before integers (`{"d` < `{"k`).
  // ---------------------------------------------------------------------------
  {
    id: "dlmf-16-18-arctan",
    source: "DLMF §16.18 Examples / Wolfram Functions (arctan reduction)",
    note: "G^{1,2}_{2,2}(1/2, 1; 1/2, 0 | z) = 2 · arctan(√z)",
    match: {
      mnpq: { m: 1, n: 2, p: 2, q: 2 },
      an: [
        { kind: "lit-rat", num: 1, den: 2 },
        { kind: "lit-int", value: 1 },
      ],
      ap: [],
      bm: [{ kind: "lit-rat", num: 1, den: 2 }],
      bq: [{ kind: "lit-int", value: 0 }],
    },
    rewrite: (_, z) => mkTimes(I(2), expr("atan", [mkPower(z, R(1, 2))])),
  },
];

void rat; void sym;
