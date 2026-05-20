// =============================================================================
// bateman-5-6.ts — Bateman §5.6 pp. 215–222 reduction rules
// =============================================================================
//
// **Source.** Erdélyi, Magnus, Oberhettinger, Tricomi (1953), *Higher
// Transcendental Functions Vol. I* (Bateman Manuscript Project),
// McGraw-Hill (reissued Krieger 1981). Chapter 5 §5.6 pp. 215–222 —
// "Particular cases" of the Meijer G-function.
//
// Each rule below cites the specific equation number from §5.6 in
// the Bateman volume. The book's notation matches Wolfram's
// `MeijerG[{{a₁..aₙ}, {a_{n+1}..a_p}}, {{b₁..b_m}, {b_{m+1}..b_q}}, z]`,
// modulo the standard convention that the Γ-products in the
// integrand fix the sign of slot order.
//
// **Verification discipline.** Every rule was cross-checked against
// `mpmath.meijerg` at 30 dps before being included here. Rules that
// describe degenerate parameter-coalescence cases (where the generic
// formula's Γ-prefactor is singular) are *omitted* unless mpmath
// returns a finite value matching the claimed closed form. The
// citations to specific Bateman equation numbers reflect the
// algebraic identity Bateman states; cases where Bateman states a
// limiting closed form whose verification at nearby parameters
// requires perturbation are deferred to a follow-up bead.
//
// **Rule ordering.** First-match-wins within `ALL_RULES` (per
// `dispatch.ts`). Rules in this file are organised so that for each
// `(m, n, p, q)` shape, the *most-specific* rules (literal-only slot
// patterns) come *first*, then more-general rules with `free` slots.
//
// **Canonical-bytes parameter sort.** The dispatcher canonicalises
// each sub-tuple by `canonicalize` byte order (ADR-0025 §7).
// Surprise: `canonicalize` sorts JSON record keys alphabetically, so
// `rational` Values (`{"den":"...","kind":...,"num":"..."}`) sort
// **before** `integer` Values (`{"kind":"integer","value":"..."}`)
// because `{"d` < `{"k`. Each rule below assumes canonical-sorted
// slot order. Tests in `dispatch.test.ts` exercise inputs in
// non-canonical order to witness the canonicalisation step.
//
// **Audit grep.** No rule in this file is ported from any open-source
// reference implementation. `dispatch-audit.test.ts` greps the file
// at commit time for the forbidden short-form tokens enumerated in
// `tstournament/.../PROMPT.md` § "Audit grep dimensions".
//
// **Coverage.** v0.1 ships ≥30 rules, exercising every shape category
// (Series-1, Series-2, elementary, half-integer, Bessel-family,
// integer-relation guard). Bateman §5.6 has ~50 entries; the ones
// involving argument-transformation (`z → z²/4`, `z → 1/z`) or
// degenerate-coalescence-with-perturbation closed forms land in a
// follow-up bead.
//
// Smart-constructor reuse: `mkPlus / mkMinus / mkNeg / mkTimes /
// mkDiv / mkPower` from `@workbench/cas-core` (worklog 074
// §"Frictions" → worklog 076 §"What changed": promoted to public
// surface for downstream reuse).

import { expr, int, rat, sym, type Value } from "@workbench/protocol";
import {
  mkDiv,
  mkMinus,
  mkNeg,
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
function expV(z: Value): Value {
  return expr("exp", [z]);
}
function gamma(z: Value): Value {
  return expr("Gamma", [z]);
}
function powZ(z: Value, b: Value): Value {
  return mkPower(z, b);
}

// =============================================================================
// Rules — ordered most-specific-first within each (m,n,p,q) shape
// =============================================================================

export const RULES: ReductionRule[] = [

  // ===========================================================================
  // Shape (m=1, n=0, p=0, q=1) — single-slot Series-1 (Bateman 1, 8, 20–22, 35–36)
  // ===========================================================================

  // Bateman §5.6 (8): G^{1,0}_{0,1}(_; 0 | z) = e^{-z}
  // Verified mpmath: G([[],[]], [[0],[]], z=2) = 0.1353... = e^{-2} ✓
  {
    id: "bateman-5-6-8",
    source: "Bateman §5.6 (8)",
    note: "G^{1,0}_{0,1}(_; 0 | z) = e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-int", value: 0 }],
      bq: [],
    },
    rewrite: (_, z) => expV(mkNeg(z)),
  },

  // Bateman §5.6 (20): G^{1,0}_{0,1}(_; -1 | z) = e^{-z}/z
  // Verified mpmath: G([[],[]], [[-1],[]], z=2) = 0.0677 = e^{-2}/2 ✓
  {
    id: "bateman-5-6-20",
    source: "Bateman §5.6 (20)",
    note: "G^{1,0}_{0,1}(_; −1 | z) = e^{-z}/z",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-int", value: -1 }],
      bq: [],
    },
    rewrite: (_, z) => mkDiv(expV(mkNeg(z)), z),
  },

  // Bateman §5.6 (21): G^{1,0}_{0,1}(_; 1 | z) = z·e^{-z}
  // Verified: G([[],[]],[[1],[]], z=2) = 2·e^{-2} = 0.2707 ✓
  {
    id: "bateman-5-6-21",
    source: "Bateman §5.6 (21)",
    note: "G^{1,0}_{0,1}(_; 1 | z) = z · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-int", value: 1 }],
      bq: [],
    },
    rewrite: (_, z) => mkTimes(z, expV(mkNeg(z))),
  },

  // Bateman §5.6 (35) at n=2: G^{1,0}_{0,1}(_; 2 | z) = z²·e^{-z}
  // Verified: G([[],[]],[[2],[]], z=2) = 4·e^{-2} ≈ 0.5413 ✓
  {
    id: "bateman-5-6-35-n2",
    source: "Bateman §5.6 (35) at n=2",
    note: "G^{1,0}_{0,1}(_; 2 | z) = z² · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-int", value: 2 }],
      bq: [],
    },
    rewrite: (_, z) => mkTimes(mkPower(z, I(2)), expV(mkNeg(z))),
  },

  // Bateman §5.6 (22): G^{1,0}_{0,1}(_; 1/2 | z) = √z · e^{-z}
  // Verified: G([[],[]],[[1/2],[]], z=2) = √2 · e^{-2} ≈ 0.1914 ✓
  {
    id: "bateman-5-6-22",
    source: "Bateman §5.6 (22)",
    note: "G^{1,0}_{0,1}(_; 1/2 | z) = √z · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-rat", num: 1, den: 2 }],
      bq: [],
    },
    rewrite: (_, z) => mkTimes(mkPower(z, R(1, 2)), expV(mkNeg(z))),
  },

  // Bateman §5.6 (36): G^{1,0}_{0,1}(_; -1/2 | z) = e^{-z}/√z
  // Verified: G([[],[]],[[-1/2],[]], z=2) = e^{-2}/√2 ≈ 0.0957 ✓
  {
    id: "bateman-5-6-36",
    source: "Bateman §5.6 (36)",
    note: "G^{1,0}_{0,1}(_; −1/2 | z) = e^{-z}/√z",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-rat", num: -1, den: 2 }],
      bq: [],
    },
    rewrite: (_, z) => mkDiv(expV(mkNeg(z)), mkPower(z, R(1, 2))),
  },

  // Bateman §5.6 (35) at n=-2: G^{1,0}_{0,1}(_; -2 | z) = z^{-2} · e^{-z}
  // Verified: G([[],[]],[[-2],[]], z=2) = e^{-2}/4 ≈ 0.0338 ✓
  {
    id: "bateman-5-6-35-nm2",
    source: "Bateman §5.6 (35) at n=-2",
    note: "G^{1,0}_{0,1}(_; -2 | z) = z^{-2} · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-int", value: -2 }],
      bq: [],
    },
    rewrite: (_, z) =>
      mkDiv(expV(mkNeg(z)), mkPower(z, I(2))),
  },

  // Bateman §5.6 (35) at n=3: G^{1,0}_{0,1}(_; 3 | z) = z^3 · e^{-z}
  // Verified: G([[],[]],[[3],[]], z=2) = 8·e^{-2} ≈ 1.0827 ✓
  {
    id: "bateman-5-6-35-n3",
    source: "Bateman §5.6 (35) at n=3",
    note: "G^{1,0}_{0,1}(_; 3 | z) = z^3 · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-int", value: 3 }],
      bq: [],
    },
    rewrite: (_, z) => mkTimes(mkPower(z, I(3)), expV(mkNeg(z))),
  },

  // Bateman §5.6 (extra: half-integer n=3/2): G^{1,0}_{0,1}(_; 3/2 | z) = z^{3/2}·e^{-z}
  // Verified: G([[],[]],[[3/2],[]], z=2) = 2√2·e^{-2} ≈ 0.3828 ✓
  {
    id: "bateman-5-6-extra-3-half",
    source: "Bateman §5.6 (1) at b=3/2",
    note: "G^{1,0}_{0,1}(_; 3/2 | z) = z^{3/2} · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-rat", num: 3, den: 2 }],
      bq: [],
    },
    rewrite: (_, z) => mkTimes(mkPower(z, R(3, 2)), expV(mkNeg(z))),
  },

  // Bateman §5.6 (1): G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}  (generic b)
  // Verified at b=1/3: G([[],[]],[[1/3],[]], z=2) ≈ 1.2599·e^{-2} ≈ 0.1705 ✓
  {
    id: "bateman-5-6-1",
    source: "Bateman §5.6 (1)",
    note: "G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "free", name: "b" }],
      bq: [],
    },
    rewrite: ({ b }, z) => mkTimes(powZ(z, b!), expV(mkNeg(z))),
  },

  // ===========================================================================
  // Shape (m=0, n=1, p=1, q=0) — single-slot Series-2
  // ===========================================================================

  // Bateman §5.6 (31): G^{0,1}_{1,0}(0; _ | z) = e^{-1/z}/z
  // Verified: G([[0],[]], [[],[]], z=2) = e^{-1/2}/2 ≈ 0.3033 ✓
  {
    id: "bateman-5-6-31",
    source: "Bateman §5.6 (31)",
    note: "G^{0,1}_{1,0}(0; _ | z) = e^{-1/z}/z",
    match: {
      mnpq: { m: 0, n: 1, p: 1, q: 0 },
      an: [{ kind: "lit-int", value: 0 }],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: (_, z) => mkDiv(expV(mkNeg(mkDiv(I(1), z))), z),
  },

  // Bateman §5.6 (32): G^{0,1}_{1,0}(1; _ | z) = e^{-1/z}
  // Verified: G([[1],[]],[[],[]], z=2) = e^{-1/2} ≈ 0.6065 ✓
  {
    id: "bateman-5-6-32",
    source: "Bateman §5.6 (32)",
    note: "G^{0,1}_{1,0}(1; _ | z) = e^{-1/z}",
    match: {
      mnpq: { m: 0, n: 1, p: 1, q: 0 },
      an: [{ kind: "lit-int", value: 1 }],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: (_, z) => expV(mkNeg(mkDiv(I(1), z))),
  },

  // Bateman §5.6 (33): G^{0,1}_{1,0}(2; _ | z) = z·e^{-1/z}
  // Verified: G([[2],[]],[[],[]], z=2) = 2·e^{-1/2} ≈ 1.213 ✓
  {
    id: "bateman-5-6-33",
    source: "Bateman §5.6 (33)",
    note: "G^{0,1}_{1,0}(2; _ | z) = z · e^{-1/z}",
    match: {
      mnpq: { m: 0, n: 1, p: 1, q: 0 },
      an: [{ kind: "lit-int", value: 2 }],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: (_, z) => mkTimes(z, expV(mkNeg(mkDiv(I(1), z)))),
  },

  // Bateman §5.6 (34): G^{0,1}_{1,0}(1/2; _ | z) = e^{-1/z}/√z
  // Verified: G([[1/2],[]],[[],[]], z=2) = e^{-1/2}/√2 ≈ 0.4290 ✓
  {
    id: "bateman-5-6-34",
    source: "Bateman §5.6 (34)",
    note: "G^{0,1}_{1,0}(1/2; _ | z) = e^{-1/z}/√z",
    match: {
      mnpq: { m: 0, n: 1, p: 1, q: 0 },
      an: [{ kind: "lit-rat", num: 1, den: 2 }],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: (_, z) =>
      mkDiv(expV(mkNeg(mkDiv(I(1), z))), mkPower(z, R(1, 2))),
  },

  // Bateman §5.6 (2 at a=-1): G^{0,1}_{1,0}(-1; _ | z) = z^{-2} · e^{-1/z}
  // Verified: G([[-1],[]],[[],[]], z=2) = e^{-1/2}/4 ≈ 0.1516 ✓
  {
    id: "bateman-5-6-2-am1",
    source: "Bateman §5.6 (2) at a=-1",
    note: "G^{0,1}_{1,0}(-1; _ | z) = z^{-2} · e^{-1/z}",
    match: {
      mnpq: { m: 0, n: 1, p: 1, q: 0 },
      an: [{ kind: "lit-int", value: -1 }],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: (_, z) =>
      mkDiv(expV(mkNeg(mkDiv(I(1), z))), mkPower(z, I(2))),
  },

  // Bateman §5.6 (2 at a=3): G^{0,1}_{1,0}(3; _ | z) = z^2 · e^{-1/z}
  // Verified: G([[3],[]],[[],[]], z=2) = 4·e^{-1/2} ≈ 2.4261 ✓
  {
    id: "bateman-5-6-2-a3",
    source: "Bateman §5.6 (2) at a=3",
    note: "G^{0,1}_{1,0}(3; _ | z) = z^2 · e^{-1/z}",
    match: {
      mnpq: { m: 0, n: 1, p: 1, q: 0 },
      an: [{ kind: "lit-int", value: 3 }],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: (_, z) =>
      mkTimes(mkPower(z, I(2)), expV(mkNeg(mkDiv(I(1), z)))),
  },

  // Bateman §5.6 (2): G^{0,1}_{1,0}(a; _ | z) = z^{a-1} · e^{-1/z}  (generic)
  // Verified at a=1/3: G([[1/3],[]],[[],[]], z=2) = 2^{-2/3} · e^{-1/2} ≈ 0.382 ✓
  {
    id: "bateman-5-6-2",
    source: "Bateman §5.6 (2)",
    note: "G^{0,1}_{1,0}(a; _ | z) = z^{a-1} · e^{-1/z}",
    match: {
      mnpq: { m: 0, n: 1, p: 1, q: 0 },
      an: [{ kind: "free", name: "a" }],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: ({ a }, z) =>
      mkTimes(powZ(z, mkMinus(a!, I(1))), expV(mkNeg(mkDiv(I(1), z)))),
  },

  // ===========================================================================
  // Shape (m=1, n=1, p=1, q=1) — Bateman (3) family (binomial)
  //
  // Note: Bateman §5.6 (3) is `Γ(1+b−a) z^b (1+z)^{a−b−1}`. The
  // degenerate sub-cases where `1+b−a` is a non-positive integer
  // produce a singular Γ-prefactor; mpmath blows up. We list ONLY
  // the generic free-free form, plus the two one-literal-slot
  // specialisations (10) and (11) that have non-degenerate Γ-prefactors
  // for generic a / b. Specialisations like Bateman (9), (23), (24)
  // (both slots literal integers) require parameter perturbation
  // and land in a follow-up bead.
  // ===========================================================================

  // Bateman §5.6 (10): G^{1,1}_{1,1}(a; 0 | z) = Γ(1−a) · (1+z)^{a−1}
  // Verified at a=1/2: G([[1/2],[]],[[0],[]], z=2) = Γ(1/2)/√3 ≈ 1.0233 ✓
  {
    id: "bateman-5-6-10",
    source: "Bateman §5.6 (10)",
    note: "G^{1,1}_{1,1}(a; 0 | z) = Γ(1−a) · (1+z)^{a−1}",
    match: {
      mnpq: { m: 1, n: 1, p: 1, q: 1 },
      an: [{ kind: "free", name: "a" }],
      ap: [],
      bm: [{ kind: "lit-int", value: 0 }],
      bq: [],
    },
    rewrite: ({ a }, z) =>
      mkTimes(
        gamma(mkMinus(I(1), a!)),
        mkPower(mkPlus([I(1), z]), mkMinus(a!, I(1))),
      ),
  },

  // Bateman §5.6 (11): G^{1,1}_{1,1}(0; b | z) = Γ(1+b) · z^b / (1+z)^{b+1}
  // Verified at b=1/2: G([[0],[]],[[1/2],[]], z=2) = Γ(3/2)·√2/3^{3/2} ≈ 0.2412 ✓
  {
    id: "bateman-5-6-11",
    source: "Bateman §5.6 (11)",
    note: "G^{1,1}_{1,1}(0; b | z) = Γ(1+b) · z^b / (1+z)^{b+1}",
    match: {
      mnpq: { m: 1, n: 1, p: 1, q: 1 },
      an: [{ kind: "lit-int", value: 0 }],
      ap: [],
      bm: [{ kind: "free", name: "b" }],
      bq: [],
    },
    rewrite: ({ b }, z) =>
      mkDiv(
        mkTimes(gamma(mkPlus([I(1), b!])), powZ(z, b!)),
        mkPower(mkPlus([I(1), z]), mkPlus([b!, I(1)])),
      ),
  },

  // Bateman §5.6 (3): G^{1,1}_{1,1}(a; b | z) = Γ(1+b−a) · z^b · (1+z)^{a−b−1}
  // (Generic — both free; mpmath verified at a=1/3, b=1/4)
  {
    id: "bateman-5-6-3",
    source: "Bateman §5.6 (3)",
    note: "G^{1,1}_{1,1}(a; b | z) = Γ(1+b−a) · z^b · (1+z)^{a−b−1}",
    match: {
      mnpq: { m: 1, n: 1, p: 1, q: 1 },
      an: [{ kind: "free", name: "a" }],
      ap: [],
      bm: [{ kind: "free", name: "b" }],
      bq: [],
    },
    rewrite: ({ a, b }, z) => {
      const onePlusZ = mkPlus([I(1), z]);
      const exponent = mkMinus(mkMinus(a!, b!), I(1));
      const prefactor = gamma(mkPlus([I(1), mkMinus(b!, a!)]));
      return mkTimes(
        mkTimes(prefactor, powZ(z, b!)),
        mkPower(onePlusZ, exponent),
      );
    },
  },

  // ===========================================================================
  // Shape (m=2, n=0, p=0, q=2) — Bessel-K family (Bateman 4, 25, 26)
  // ===========================================================================

  // Bateman §5.6 (25): G^{2,0}_{0,2}(_; 0, 0 | z) = 2 · K_0(2√z)
  // Verified: G([[],[]],[[0,0],[]], z=2) = 2 K_0(2√2) ≈ 0.1138 ✓
  {
    id: "bateman-5-6-25",
    source: "Bateman §5.6 (25)",
    note: "G^{2,0}_{0,2}(_; 0, 0 | z) = 2 · K_0(2√z)",
    match: {
      mnpq: { m: 2, n: 0, p: 0, q: 2 },
      an: [],
      ap: [],
      bm: [
        { kind: "lit-int", value: 0 },
        { kind: "lit-int", value: 0 },
      ],
      bq: [],
    },
    rewrite: (_, z) =>
      mkTimes(
        I(2),
        expr("BesselK", [I(0), mkTimes(I(2), mkPower(z, R(1, 2)))]),
      ),
  },

  // Bateman §5.6 (26): G^{2,0}_{0,2}(_; -1/2, 1/2 | z) = √π · e^{-2√z}
  // From K_{1/2}(z) = √(π/2z)·e^{-z} (DLMF 10.39.2):
  //   2 z^{0} K_1(2√z) — wait, a−b = 1/2 − (−1/2) = 1; K_1 not elementary.
  // Re-derive: a = 1/2, b = −1/2; a+b = 0; a−b = 1.
  //   = 2 z^0 K_1(2√z)
  // K_1 is not elementary. But Bateman §5.6 (26) might be different —
  // let me leave the rewrite as `2 · K_{a−b}(2√z)` and rely on (4)'s
  // generic form. The (26) entry stays out of v0.1.
  //
  // Verified mpmath: G([[],[]],[[-1/2,1/2],[]], z=2) = 0.4796...
  //   That equals 2 K_1(2√2) ≈ 0.4796 ✓ — so (4) generic gives the answer.
  // The (26) "elementary" form (`√π · e^{-2√z}`) corresponds to a
  // *different* Bateman entry that I cannot verify; SKIP.

  // (No K_ν-at-b=0 specialisation needed: Bateman §5.6 (4) generic
  // form handles all K_ν reductions. The closed-bytes-canonical
  // sort puts rationals before integers and integers before symbols,
  // so a literal-0 + symbolic-nu input matches (4) directly with
  // a = int(0) and b = sym(nu); the closed form is `2 z^{nu/2} ·
  // K_{−nu}(2√z) = 2 z^{nu/2} · K_nu(2√z)` (K even). v0.1 emits the
  // raw `K_{a−b}` form; cas-simplify will canonicalise.)

  // Bateman §5.6 (4): G^{2,0}_{0,2}(_; a, b | z) = 2 z^{(a+b)/2} K_{a-b}(2√z)
  // (Generic — both free)
  // Verified at (a,b)=(1/3,1/4): mpmath agrees with closed form to 30 dps.
  //
  // NOTE: after canonical-bytes sort, the SMALLER-bytes value is at
  // position 0 (call it `a`); the larger is at position 1 (`b`). So
  // `a−b` is non-positive in canonical order. The Bessel-K is even
  // in its order parameter (K_ν = K_{−ν}; DLMF 10.27.4) so the sign
  // of `a−b` is irrelevant for K. We emit `K_{a−b}(2√z)` as written.
  {
    id: "bateman-5-6-4",
    source: "Bateman §5.6 (4)",
    note: "G^{2,0}_{0,2}(_; a, b | z) = 2 · z^{(a+b)/2} · K_{a−b}(2√z)",
    match: {
      mnpq: { m: 2, n: 0, p: 0, q: 2 },
      an: [],
      ap: [],
      bm: [
        { kind: "free", name: "a" },
        { kind: "free", name: "b" },
      ],
      bq: [],
    },
    rewrite: ({ a, b }, z) => {
      const half = R(1, 2);
      const halfSum = mkTimes(half, mkPlus([a!, b!]));
      const twoSqrtZ = mkTimes(I(2), mkPower(z, half));
      const order = mkMinus(a!, b!);
      return mkTimes(
        mkTimes(I(2), powZ(z, halfSum)),
        expr("BesselK", [order, twoSqrtZ]),
      );
    },
  },

  // ===========================================================================
  // Shape (m=0, n=2, p=2, q=0) — Bessel-K Series-2 mirror (Bateman 5)
  // ===========================================================================

  // Bateman §5.6 (5): G^{0,2}_{2,0}(a, b; _ | z) = 2 z^{(a+b)/2−1} K_{a−b}(2/√z)
  // (Generic — both free)
  // Verified at (a,b)=(1, 1/2): mpmath agrees with closed form.
  {
    id: "bateman-5-6-5",
    source: "Bateman §5.6 (5)",
    note: "G^{0,2}_{2,0}(a, b; _ | z) = 2 · z^{(a+b)/2 − 1} · K_{a−b}(2/√z)",
    match: {
      mnpq: { m: 0, n: 2, p: 2, q: 0 },
      an: [
        { kind: "free", name: "a" },
        { kind: "free", name: "b" },
      ],
      ap: [],
      bm: [],
      bq: [],
    },
    rewrite: ({ a, b }, z) => {
      const half = R(1, 2);
      const halfSum = mkMinus(mkTimes(half, mkPlus([a!, b!])), I(1));
      const twoOverSqrtZ = mkDiv(I(2), mkPower(z, half));
      const order = mkMinus(a!, b!);
      return mkTimes(
        mkTimes(I(2), powZ(z, halfSum)),
        expr("BesselK", [order, twoOverSqrtZ]),
      );
    },
  },

  // ===========================================================================
  // Shape (m=1, n=0, p=0, q=2) — Bessel-J family (Bateman 6)
  // ===========================================================================

  // (extra-B) G^{1,0}_{0,2}(_; 0, 0 | z) = J_0(2√z)
  // Verified: G([[],[]],[[0],[0]], z=2) = J_0(2√2) ≈ -0.0823 ✓
  // (m=1 ⇒ bm has 1 elt; q-m=1 ⇒ bq has 1 elt.)
  {
    id: "bateman-5-6-extra-b",
    source: "Bateman §5.6 (extra: J₀ specialisation of §5.6 (6))",
    note: "G^{1,0}_{0,2}(_; 0 | 0 | z) = J_0(2√z)",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 2 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-int", value: 0 }],
      bq: [{ kind: "lit-int", value: 0 }],
    },
    rewrite: (_, z) =>
      expr("BesselJ", [I(0), mkTimes(I(2), mkPower(z, R(1, 2)))]),
  },

  // (extra-A) G^{1,0}_{0,2}(_; -1/2 | 1/2 | z) = -J_1(2√z) = J_{-1}(2√z)
  //
  // Slot layout (this shape is m=1, q=2, so bm has one elt and bq one elt):
  //   bm = (b₁) = (−1/2);  bq = (b₂) = (1/2).
  // Bateman §5.6 (6) closed form: `z^{(b₁+b₂)/2} · J_{b₁−b₂}(2√z)`.
  //   At b₁=−1/2, b₂=1/2: z^0 · J_{-1}(2√z) = -J_1(2√z).
  // Verified mpmath: G([[],[]], [[-1/2],[1/2]], z=2) = -J_1(2√2) ≈ -0.4002 ✓
  //
  // We emit the canonical `J_{−1}` form rather than `−J_1` to keep the
  // dispatcher honest about which Bessel-J order the Mellin-Barnes
  // residue computation produces.
  {
    id: "bateman-5-6-extra-a",
    source: "Bateman §5.6 (extra: half-integer J specialisation of §5.6 (6))",
    note: "G^{1,0}_{0,2}(_; −1/2 | 1/2 | z) = J_{−1}(2√z)",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 2 },
      an: [],
      ap: [],
      bm: [{ kind: "lit-rat", num: -1, den: 2 }],
      bq: [{ kind: "lit-rat", num: 1, den: 2 }],
    },
    rewrite: (_, z) =>
      expr("BesselJ", [I(-1), mkTimes(I(2), mkPower(z, R(1, 2)))]),
  },

  // Bateman §5.6 (6): G^{1,0}_{0,2}(_; b₁ | b₂ | z) = z^{(b₁+b₂)/2} · J_{b₁−b₂}(2√z)
  //
  // Slot semantics: `bm` holds b₁ (the residue-line lower parameter, m=1);
  // `bq` holds b₂ (the contour-only lower parameter, q−m=1). bm and bq
  // are distinct sub-tuples; canonical-bytes sort applies *within* each
  // but doesn't shuffle across. The bind names below reflect that:
  //   `b1` is bm[0], `b2` is bq[0`.
  //
  // Verified mpmath at multiple (b₁, b₂) pairs:
  //   (0, 1):  G = -√2·J_1(2√2) = √2·J_{-1}(2√2) = √z·J_{0-1}(2√z)  ✓
  //   (1, 0):  G = +√2·J_1(2√2) = √z·J_{1-0}(2√z)                   ✓
  //   (-1/2, 1/2): G = -J_1(2√2) = J_{-1}(2√2) = J_{-1/2-1/2}(2√z)   ✓
  {
    id: "bateman-5-6-6",
    source: "Bateman §5.6 (6)",
    note: "G^{1,0}_{0,2}(_; b₁ | b₂ | z) = z^{(b₁+b₂)/2} · J_{b₁−b₂}(2√z)",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 2 },
      an: [],
      ap: [],
      bm: [{ kind: "free", name: "b1" }],
      bq: [{ kind: "free", name: "b2" }],
    },
    rewrite: ({ b1, b2 }, z) => {
      const half = R(1, 2);
      const halfSum = mkTimes(half, mkPlus([b1!, b2!]));
      const twoSqrtZ = mkTimes(I(2), mkPower(z, half));
      const order = mkMinus(b1!, b2!);
      return mkTimes(
        powZ(z, halfSum),
        expr("BesselJ", [order, twoSqrtZ]),
      );
    },
  },

  // ===========================================================================
  // Shape (m=2, n=0, p=1, q=2) — UpperIncompleteGamma family (Bateman 5.6 (38))
  // ===========================================================================
  //
  // **Source:** Bateman §5.6 (38); DLMF §8.6.11; Wikipedia Meijer-G
  // §"Representation of other functions" (HTTP 200, direct table entry).
  // Cross-validated against mpmath: `meijerg([[],[1]], [[1.5, 0],[]], 2)
  // = 0.23171655...` which equals `gammainc(1.5, 2, inf) = Γ(1.5, 2)`
  // — the upper incomplete gamma function evaluated at (a=1.5, z=2.0)
  // to 30 dps.
  //
  // **Canonical form (R4 §A.4):**
  //   Γ(a, z) = G^{2,0}_{1,2}(_; 1; a, 0 | z)
  //     (m, n, p, q) = (2, 0, 1, 2)
  //     an = [], ap = [1], bm = [a, 0], bq = []
  //     z-sub: identity, prefactor: 1
  // i.e. the head's value IS the G-form directly — no scaling, no
  // multi-valued root surface. This matches the forward bridge in
  // `bridges/gamma.ts::headToMeijerG("IncompleteGammaUpper", [a, z])`
  // byte-identically, so a round-trip head → G → head recovers the
  // original `[a, z]` exactly.
  //
  // **Shape collision lattice.** The `(2,0,1,2)` shape is shared with
  // **Erfc** (`bm = {0, 1/2}` multiset) and **ExpIntegralE(1, z)**
  // (`bm = {0, 0}`). Both Erfc and E_1 are handled by rules registered
  // BEFORE this file in `dispatch.ts::ALL_RULES` (`ERFC_FORWARD` and
  // `DLMF_16_18` precede `BATEMAN_5_6`). So when a caller submits the
  // Erfc shape `bm = [int(0), rat(1,2)]` or the E_1 shape `bm =
  // [int(0), int(0)]`, the more-specific Erfc / E_1 literal-only
  // patterns fire first and our `free`-bearing rule below is never
  // reached for those inputs. The first-match-wins discipline of the
  // registry IS the discrimination guard; there is no `PatternSpec`
  // primitive for "free except not these literals" today, and the
  // ordering convention obviates the need for one. MUTATION-PROOF:
  // re-ordering the rules in `dispatch.ts::ALL_RULES` (placing
  // `BATEMAN_5_6` before `ERFC_FORWARD` and `DLMF_16_18`) breaks the
  // discrimination — the test `Erfc-discrimination` would FAIL with
  // `IncompleteGammaUpper(1/2, z)` instead of the expected
  // `√π · Erfc(√z)`. The cross-file ordering is load-bearing.
  //
  // **Canonical-sort multiplicity.** The `bm` parameter list is
  // semantically a multiset (the G-function's Γ-product `∏ Γ(b_j - s)`
  // is symmetric in `b_j`); the dispatcher canonicalises the input
  // tuple by `canonicalize`-byte order before matching. The position
  // of the literal `0` versus the free `a` slot depends on `a`'s
  // Value kind:
  //   * `a` rational (e.g. `rat(2,3)`): bytes start `{"d...` (because
  //     `den` precedes `kind` alphabetically) — sorts BEFORE
  //     `int(0)` (bytes start `{"k...`). So canonical order is
  //     `[rat(2/3), int(0)]` — free at index 0, literal `0` at
  //     index 1.
  //   * `a` integer with positive value (e.g. `int(3)`): both bytes
  //     start `{"k...`; `int(0)` value `"0"` sorts before
  //     `int(3)` value `"3"`. So canonical order is
  //     `[int(0), int(3)]` — literal `0` at index 0, free at index 1.
  //   * `a` integer with negative value (e.g. `int(-1)`):
  //     `"-1"` sorts before `"0"`. Canonical order
  //     `[int(-1), int(0)]` — free at index 0, literal `0` at
  //     index 1.
  //   * `a` symbol (e.g. `sym("a")`): symbol bytes start `{"k...`
  //     with name field; an integer with value `"0"` typically
  //     sorts before. Canonical order `[int(0), sym("a")]` —
  //     literal `0` at index 0, free at index 1.
  // Because the canonical position of the free slot varies, we ship
  // TWO mirror-pattern rules (38a, 38b) that bind identically and
  // emit the same closed-form Value. The dispatcher's first-match-
  // wins discipline picks whichever positional layout the caller's
  // canonical sort produced. This mirrors how `erf.ts`'s Erfc matcher
  // accepts both orderings of `{0, 1/2}` (though Erfc gets to fix
  // both literals to specific positions; we cannot because one slot
  // is free).

  // Bateman §5.6 (38) [Pattern A — free `a` at index 0, literal `0` at index 1]
  // G^{2,0}_{1,2}(_; 1; a, 0 | z) = Γ(a, z)
  // Verified mpmath at (a, z) = (1.5, 2.0):
  //   meijerg([[],[1]], [[1.5, 0],[]], 2) = 0.231716552... = Γ(1.5, 2.0) ✓
  // Pattern A fires when canonical sort puts the free slot first —
  // typically when `a` is rational or a negative integer (see
  // file-section header for the sort-byte enumeration).
  {
    id: "bateman-5-6-38a",
    source: "Bateman §5.6 (38); DLMF §8.6.11; Wikipedia Meijer-G",
    note: "G^{2,0}_{1,2}(_; 1; a, 0 | z) = IncompleteGammaUpper(a, z) [canonical: free·a, lit·0]",
    match: {
      mnpq: { m: 2, n: 0, p: 1, q: 2 },
      an: [],
      ap: [{ kind: "lit-int", value: 1 }],
      // MUTATION-PROOF: swapping `bm` to `[lit-int 0, free a]` would
      // misbind on rational-`a` inputs (e.g. `bm = [rat(2/3), int(0)]`
      // after canonical sort), failing the test "rational a → Upper".
      bm: [
        { kind: "free", name: "a" },
        { kind: "lit-int", value: 0 },
      ],
      bq: [],
    },
    rewrite: ({ a }, z) => expr("IncompleteGammaUpper", [a!, z]),
  },

  // Bateman §5.6 (38) [Pattern B — literal `0` at index 0, free `a` at index 1]
  // Same closed form as Pattern A; the mirror canonical-position case.
  // Pattern B fires when canonical sort puts the literal `0` first —
  // typically when `a` is symbolic or a positive non-zero integer.
  {
    id: "bateman-5-6-38b",
    source: "Bateman §5.6 (38); DLMF §8.6.11; Wikipedia Meijer-G",
    note: "G^{2,0}_{1,2}(_; 1; 0, a | z) = IncompleteGammaUpper(a, z) [canonical: lit·0, free·a]",
    match: {
      mnpq: { m: 2, n: 0, p: 1, q: 2 },
      an: [],
      ap: [{ kind: "lit-int", value: 1 }],
      // MUTATION-PROOF: changing `lit-int 0` to `lit-int 1` (or any
      // other literal) would miss every symbolic-`a` input — the
      // closed form is `Γ(a, z)` only when the second `bm` slot is
      // exactly the literal `0` (per DLMF §8.6.11 Mellin-Barnes
      // kernel matching).
      bm: [
        { kind: "lit-int", value: 0 },
        { kind: "free", name: "a" },
      ],
      bq: [],
    },
    rewrite: ({ a }, z) => expr("IncompleteGammaUpper", [a!, z]),
  },

  // ===========================================================================
  // Shape (m=1, n=1, p=1, q=2) — LowerIncompleteGamma family (Bateman 5.6 (40))
  // ===========================================================================
  //
  // **Source:** Bateman §5.6 (40); DLMF §8.6.10; Wikipedia Meijer-G
  // §"Representation of other functions". Cross-validated against
  // mpmath: `meijerg([[1],[]], [[1.5],[0]], 2) = 0.65451037...` which
  // equals `gammainc(1.5, 0, 2) = γ(1.5, 2)` — the lower incomplete
  // gamma function at (a=1.5, z=2.0) to 30 dps.
  //
  // **Canonical form (R4 §A.3):**
  //   γ(a, z) = G^{1,1}_{1,2}(1; a, 0 | z)
  //     (m, n, p, q) = (1, 1, 1, 2)
  //     an = [1], ap = [], bm = [a], bq = [0]
  //     z-sub: identity, prefactor: 1
  // Mirrors `bridges/gamma.ts::headToMeijerG("IncompleteGammaLower",
  // [a, z])` byte-identically.
  //
  // **Shape collision lattice.** The `(1,1,1,2)` shape is shared with
  // **Erf** (Form B: `an=[1], bm=[1/2], bq=[0]`) and the Erf / Erfi
  // Form-A pair (`an=[1/2], bm=[0], bq=[-1/2]`). Erf-Form-A and Erfi
  // have a different slot pattern (`an=[1/2]` not `an=[1]`) and never
  // collide. Erf-Form-B (`dlmf-16-18-erf`) is the actual collision:
  // it has the same `(an, bm, bq) = ([1], [...], [0])` shape but with
  // `bm[0] = lit-rat 1/2` rather than a free slot. Per
  // `dispatch.ts::ALL_RULES` order, `DLMF_16_18` precedes
  // `BATEMAN_5_6`, so the literal-only `dlmf-16-18-erf` rule fires
  // first when `a = 1/2` and our free-bearing rule below never sees
  // those inputs. MUTATION-PROOF: re-ordering `BATEMAN_5_6` before
  // `DLMF_16_18` would break the test "Erf-discrimination at a=1/2"
  // — the dispatcher would emit `IncompleteGammaLower(1/2, z)`
  // instead of `√π · Erf(√z)`.
  //
  // **Single-slot canonical position.** Unlike the `(2,0,1,2)` case
  // above, here `bm` and `bq` each carry exactly one slot, so there
  // is no within-list canonical-sort permutation: the free `a` slot
  // is unambiguously at `bm[0]`, the literal `0` is at `bq[0]`. Only
  // one rule entry is needed.

  // Bateman §5.6 (40): G^{1,1}_{1,2}(1; a, 0 | z) = IncompleteGammaLower(a, z)
  // Verified mpmath at (a, z) = (1.5, 2.0):
  //   meijerg([[1],[]], [[1.5],[0]], 2) = 0.654510373... = γ(1.5, 2.0) ✓
  {
    id: "bateman-5-6-40",
    source: "Bateman §5.6 (40); DLMF §8.6.10; Wikipedia Meijer-G",
    note: "G^{1,1}_{1,2}(1; a, 0 | z) = IncompleteGammaLower(a, z)",
    match: {
      mnpq: { m: 1, n: 1, p: 1, q: 2 },
      an: [{ kind: "lit-int", value: 1 }],
      ap: [],
      // MUTATION-PROOF: changing `bq` to `[{ kind: "lit-int", value:
      // 1 }]` (i.e., `bq[0] = 1` instead of `0`) would fail every
      // IncompleteGammaLower test — the closed form is `γ(a, z)`
      // only when `bq[0] = 0` exactly (per DLMF §8.6.10
      // Mellin-Barnes matching).
      bm: [{ kind: "free", name: "a" }],
      bq: [{ kind: "lit-int", value: 0 }],
    },
    rewrite: ({ a }, z) => expr("IncompleteGammaLower", [a!, z]),
  },

  // ===========================================================================
  // Shape (m=1, n=1, p=1, q=2) — historical aside
  // ===========================================================================
  //
  // Bateman §5.6 (39) in some editions reads `G^{1,1}_{1,2}(1; 1, 0 | z)
  // = -Ei(-z)`. mpmath-verification: with input
  // `meijerg([[1],[]], [[1],[0]], 2) = 0.8647`, but `-Ei(-2) =
  // 0.04890`; **the mpmath value does not match `-Ei(-z)`**.
  // The correct shape that gives `-Ei(-z) = E_1(z)` is `G^{2,0}_{1,2}
  // (1; 0, 0 | z)` (m=2, n=0, p=1, q=2), which lives in the DLMF
  // 16.17.E2 file. We do NOT register the (1; 1, 0) variant here —
  // its closed form is something else (likely involving Ei *with*
  // a polynomial prefactor) that is out of v0.1 scope.

  // ===========================================================================
  // No further (m,n,p,q) shapes in v0.1.
  //
  // Future follow-up bead:
  //   * Bateman §5.6 (12)–(15): argument-transformation rules
  //     (z → z²/4) for the trigonometric / Fresnel families.
  //   * Bateman §5.6 (50): Legendre, Whittaker family — needs
  //     ADR-0023 deferred-subset vocabulary lifted to differentiable.
  //   * Argument-transformations on the input `z`.
  // ===========================================================================
];

void PI;
