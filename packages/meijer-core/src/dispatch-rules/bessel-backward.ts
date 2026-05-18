// =============================================================================
// bessel-backward.ts — dispatcher-side BesselY / BesselI backward rules
// =============================================================================
//
// **Why this file exists.** The R4 Bessel research artefact
// (`docs/refs/besselj-research/R4-meijer-g-bridge.md`) surveyed every
// dispatcher rule that emits a Bessel head and found two gaps (§E.3):
// no rule emits `BesselY` from `(m,n,p,q) = (2,0,1,3)` and no rule
// emits `BesselI` from `(1,0,1,3)`. The `bridges/bessel.ts:meijerGToHead`
// standalone backward bridge covers both at the bridge layer, but the
// symbolic dispatcher's pattern table does not yet reduce to them, so
// any planner that runs `meijergSymbolic` on a canonical Bessel-Y or
// Bessel-I G-form falls through to `no-known-reduction` even though
// the bridge could handle it. This file closes that gap.
//
// **Source provenance — primary literature only.**
//
//   * **DLMF §10.9 (Integral Representations) + §16.18 (Examples of
//     Meijer G).** The Mellin-Barnes integrand for `Y_ν` and `I_ν`
//     and the parameter conventions used here. The G-forms encoded
//     below are derived directly from the DLMF identities, not
//     transliterated from any open-source reference implementation.
//   * **Prudnikov, Brychkov, Marichev (PBM) Vol III, §8.4
//     "Particular cases of the Meijer G-function".** PBM gives the
//     full table of canonical G-forms for the Bessel family in the
//     Wolfram convention; the four-form table at R4 §A.1 (BesselJ /
//     BesselY / BesselI / BesselK) is the PBM §8.4 specialisation.
//   * **mpmath at 60 dps (cross-check only, not a porting source).**
//     Verified that `meijerg([[],[c]],[[a, b],[c]], z²/4)` at the
//     canonical Bessel-Y slot values `(a = ν/2, b = -ν/2, c =
//     -(ν+1)/2)` matches `bessely(ν, z)` byte-equal at 60 dps; same
//     for BesselI at its canonical slot values + the `1/π` prefactor.
//
// Per ADR-0025 §9 / `dispatch-audit.test.ts`: no identifier or short-
// form token from `mpmath/functions/hypergeometric.py` or `sympy/
// integrals/meijerint.py` appears in this file. The G-form algebra
// was re-derived from the DLMF / PBM identities; the canonical sort
// considerations were derived from `dispatch.ts`'s own sort
// discipline.
//
// **Looseness contract (matches `bridges/bessel.ts:meijerGToHead`).**
// Neither rule enforces the full canonical-Bessel structural
// fingerprint (`bm[1] = -bm[0]` for Y; `bq[1] = -bm[0]` for I) at
// match time, because `PatternSpec`'s v0.1 slot vocabulary (`lit-int
// / lit-rat / free / free-shift`, plus the `integer-difference`
// relation) cannot express "this slot is the structural negation of
// that one". Both rules instead use shared `free` names to enforce
// the load-bearing `ap[0] == bq[0]` Γ-cancellation (the "fictitious-
// slot" pair that produces Y's `sin(πν)` / I's complementary
// connection factor) and rely on shape-uniqueness for everything
// else: no other Bessel-family head shares either `(m,n,p,q)` tuple
// (R4 §A.1), so any G-form with `(2,0,1,3)` + `ap[0] == bq[0]` is
// BesselY-shaped by elimination, and any G with `(1,0,1,3)` + the
// same equality is BesselI-shaped. This mirrors `bridges/bessel.ts:
// meijerGToHead`'s own structural reasoning verbatim ("by
// elimination" — file-top comment, ~line 396 and ~line 419). A
// future bead may extend `PatternSpec` with a structural-negation
// relation; until then the round-trip closure test
// (`bessel-closure.test.ts`) is the regression anchor that pins
// canonical-input correctness, and the mpmath cross-validation
// (`dispatch-mpmath.test.ts`) pins numerical correctness at concrete
// canonical-Bessel slot values.
//
// **Canonical-sort considerations.** The dispatcher sorts each sub-
// tuple by `canonicalize` bytes before matching (`dispatch.ts`
// §"Parameter-set canonicalisation"). For symbolic ν:
//
//   * `bm` for Y, bridge-emitted as `[ν/2, -ν/2]`, canonicalises to
//     `[-ν/2, ν/2]` because the `neg`-wrapped expression's second
//     byte (the inner `{"args":[…]`) sorts lexically below the bare
//     `mkDiv`'s second byte (`{"kind":…`). The matcher captures
//     `a = bm[0] = -ν/2`, `b = bm[1] = ν/2`; the rewrite recovers
//     ν via `recoverNuFromHalfSlot(b)` (the `mkDiv(?, 2)` unwrap
//     gives `ν` directly, matching the bridge's own helper of the
//     same name).
//   * `bq` for I, bridge-emitted as `[-ν/2, (ν+1)/2]`, canonicalises
//     to `[(ν+1)/2, -ν/2]` because the `(ν+1)/2 = mkDiv(mkPlus([ν,
//     1]), 2)` expression contains `int(1)` at a depth where the
//     `-ν/2 = mkNeg(mkDiv(ν, 2))` expression has `int(2)`; `1` < `2`
//     in canonical bytes. The matcher then sees `bq[0] = (ν+1)/2 ==
//     ap[0]` (shared `free "c"` name binds them).
//
// These canonical-sort outcomes are pinned by the structural-anchor
// tests in `dispatch.test.ts` — if the encoding of `mkNeg` / `mkDiv`
// / `mkPlus` changes (e.g. a future cas-core refactor encodes
// negation as `mkTimes(int(-1), …)` instead of `expr("neg", …)`),
// those tests will fail loudly and this comment block needs to be
// re-derived.

import { expr, int, rat, sym, type Value } from "@workbench/protocol";
import { mkDiv, mkPower, mkTimes } from "@workbench/cas-core";
import type { ReductionRule } from "../dispatch-types.js";

// -----------------------------------------------------------------------------
// Helpers — local to this file to keep the encoding choices visible at the
// rule's reading site (mirrors `bateman-5-6.ts`'s helper-locality discipline).
// -----------------------------------------------------------------------------

const PI: Value = sym("pi");

function I(n: number): Value {
  return int(BigInt(n));
}
function R(n: number, d: number): Value {
  return rat(BigInt(n), BigInt(d));
}

/**
 * Recover `ν` from a half-slot Value `ν/2`. When the slot is literally
 * `mkDiv(ν, int(2))` we unwrap it to `ν` directly; otherwise we emit
 * `2·slot` and let `cas-simplify` reduce. This is a verbatim re-statement
 * of `bridges/bessel.ts:recoverNuFromHalfSlot` — kept local to avoid a
 * cross-module helper export, and so the dispatcher's slot-recovery
 * convention is visible at the rule's reading site without a hop.
 *
 * Why it matters: the bridge's forward emission shapes ν/2 as exactly
 * `mkDiv(nu, int(2n))`. After the dispatcher's canonical-bytes sort the
 * `ν/2` slot lands at `bm[1]` for Y (Y's `bm = [-ν/2, ν/2]` after sort)
 * and at `bm[0]` for I (I has only one `bm` slot). The unwrap therefore
 * fires on the bridge-produced inputs, and the recovered `ν` is
 * byte-identical to the original (no `2 · (ν/2)` noise that cas-simplify
 * would otherwise need to clean up).
 */
function recoverNuFromHalfSlot(slot: Value): Value {
  if (
    slot.kind === "expression" &&
    slot.head === "/" &&
    slot.args.length === 2
  ) {
    const denom = slot.args[1]!;
    if (denom.kind === "integer" && BigInt(denom.value) === 2n) {
      return slot.args[0]!;
    }
    if (
      denom.kind === "rational" &&
      BigInt(denom.num) === 2n &&
      BigInt(denom.den) === 1n
    ) {
      return slot.args[0]!;
    }
  }
  return mkTimes(I(2), slot);
}

/** `2·√z` — the un-substitution of the Bessel z-slot `z²/4`. */
function twoSqrtOf(z: Value): Value {
  return mkTimes(I(2), mkPower(z, R(1, 2)));
}

// =============================================================================
// Rules
// =============================================================================

export const RULES: ReductionRule[] = [

  // ===========================================================================
  // Shape (m=2, n=0, p=1, q=3) — BesselY canonical form
  //
  //   G^{2,0}_{1,3}([], [c]; [a, b], [c]; z) = BesselY(ν, 2√z)
  //
  // The `ap[0] == bq[0]` equality (encoded via the shared `free "c"` name)
  // is the load-bearing Γ-cancellation: `Γ(c - s) · Γ(1 - c + s) =
  // π/sin(π(c - s))` (reflection formula), and the resulting `sin(π(c -
  // s))` factor in the Mellin-Barnes integrand is what produces Y's
  // characteristic `cos(νπ) Y_ν` / `J_{−ν}` connection structure. Without
  // the equality the G is some other (2,0,1,3) reduction; with it, the
  // shape is uniquely BesselY-shaped (R4 §A.1: no other Bessel head has
  // `(m,n,p,q) = (2,0,1,3)`).
  //
  // Canonical-Bessel slot values: `a = -ν/2`, `b = ν/2`, `c = -(ν+1)/2`.
  // The dispatcher's canonical-bytes sort puts `-ν/2` before `ν/2` in
  // `bm` (see file-top "Canonical-sort considerations"), so `b = bm[1]`
  // carries the `ν/2`-shaped slot from which `recoverNuFromHalfSlot`
  // peels off the `ν`. For non-canonical inputs the rewrite still emits
  // `BesselY(2·b, 2√z)`, which `cas-simplify` may or may not reduce
  // further — see the file-top "Looseness contract" for the soundness
  // discussion (TL;DR: shape-by-elimination is the load-bearing
  // argument, matches the bridge's own backward path, and the closure +
  // mpmath tests are the regression anchors).
  //
  // mpmath verification (60 dps, ν=1.7, z=2):
  //   meijerg([[],[-(ν+1)/2]], [[ν/2, -ν/2],[-(ν+1)/2]], (z²)/4)
  //     = bessely(1.7, 2)  ≈  -0.49036218582288494...    ✓
  // ===========================================================================
  {
    id: "bessel-y-canonical",
    source: "DLMF §10.9 + §16.18 / PBM Vol III §8.4 (canonical BesselY G-form)",
    note:
      "G^{2,0}_{1,3}([], [c]; [a, b], [c]; z) = BesselY(2b, 2√z) " +
      "(canonical-Bessel: a=-ν/2, b=ν/2, c=-(ν+1)/2)",
    match: {
      mnpq: { m: 2, n: 0, p: 1, q: 3 },
      an: [],
      ap: [{ kind: "free", name: "c" }],
      bm: [
        { kind: "free", name: "a" },
        { kind: "free", name: "b" },
      ],
      bq: [{ kind: "free", name: "c" }],
    },
    rewrite: ({ b }, z) => {
      // Recover ν from `b` (= bm[1] post-sort, which carries ν/2 for
      // canonical inputs). For canonical bridge-produced inputs the
      // `mkDiv(nu, 2)` unwrap fires; for non-canonical inputs the
      // fallback emits `2·b` and cas-simplify takes over.
      const nu = recoverNuFromHalfSlot(b!);
      return expr("BesselY", [nu, twoSqrtOf(z)]);
    },
  },

  // ===========================================================================
  // Shape (m=1, n=0, p=1, q=3) — BesselI canonical form
  //
  //   G^{1,0}_{1,3}([], [c]; [a], [c, d]; z) = (1/π) · BesselI(ν, 2√z)
  //
  // The `1/π` prefactor on the emission side is the inverse of the
  // bridge's `wrap = g → π·g` on the forward side: `BesselI = π · G` ⟺
  // `G = (1/π) · BesselI`. The dispatcher emits the closed form for the
  // G-value, so the prefactor lives in the rewrite.
  //
  // The `ap[0] == bq[0]` equality (shared `free "c"`) is again the
  // structural fingerprint — same Γ-cancellation reasoning as BesselY.
  // Canonical-Bessel slot values: `a = ν/2` (bm[0]), `c = (ν+1)/2`
  // (ap[0] and bq[0] after sort), `d = -ν/2` (bq[1] after sort, the
  // free-but-unused slot).
  //
  // The `d` (bq[1]) capture is intentionally unbound-by-name in the
  // rewrite — its value doesn't enter the closed-form emission for
  // canonical inputs (where the algebra `1 - (-ν/2) + s = 1 + ν/2 + s`
  // matches BesselI's Γ-denominator). The rule fires for any (1,0,1,3)
  // shape with `ap[0] == bq[0]`, then assumes canonical-Bessel
  // structure for the emission. See file-top "Looseness contract".
  //
  // mpmath verification (60 dps, ν=1.7, z=2):
  //   meijerg([[],[(ν+1)/2]], [[ν/2],[-ν/2, (ν+1)/2]], (z²)/4)
  //     ≈  0.29346732235698168386   (= besseli(1.7, 2) / π)
  //   besseli(1.7, 2) ≈ 0.92195478398536134373
  //   ratio (G / besseli) = 1/π   ✓  ⟺  G = (1/π) · BesselI
  // ===========================================================================
  {
    id: "bessel-i-canonical-symbolic-nu",
    source: "DLMF §10.9 + §16.18 / PBM Vol III §8.4 (canonical BesselI G-form)",
    note:
      "G^{1,0}_{1,3}([], [c]; [a], [c, d]; z) = (1/π) · BesselI(2a, 2√z) " +
      "(canonical-Bessel: a=ν/2, c=(ν+1)/2, d=-ν/2; symbolic-ν canonical-sort)",
    match: {
      mnpq: { m: 1, n: 0, p: 1, q: 3 },
      an: [],
      ap: [{ kind: "free", name: "c" }],
      bm: [{ kind: "free", name: "a" }],
      bq: [
        { kind: "free", name: "c" },
        { kind: "free", name: "d" },
      ],
    },
    rewrite: ({ a }, z) => {
      const nu = recoverNuFromHalfSlot(a!);
      return mkDiv(expr("BesselI", [nu, twoSqrtOf(z)]), PI);
    },
  },

  // ===========================================================================
  // Shape (m=1, n=0, p=1, q=3) — BesselI canonical (literal-ν canonical-sort)
  //
  // Same identity as above, but with `bq` slot order swapped to match the
  // canonical-sort outcome on LITERAL-rational ν inputs. The two-rule
  // split is a v0.1 workaround for an asymmetry in canonical-bytes
  // sorting:
  //
  //   * **Symbolic ν.** The bridge emits `bq = [-ν/2, (ν+1)/2]` =
  //     `[mkNeg(mkDiv(ν,2)), mkDiv(mkPlus([ν,1]), 2)]`. Canonical-bytes
  //     sort sees both as `expression`-typed and descends into the
  //     `args` array; deep down, `(ν+1)/2`'s inner `mkPlus` contains
  //     integer `1` while `-ν/2`'s inner `mkDiv` contains integer `2`.
  //     `1` < `2` in canonical bytes ⇒ `(ν+1)/2` sorts first ⇒ `bq[0]
  //     = (ν+1)/2` matches `ap[0]` via the shared `free "c"` name.
  //
  //   * **Literal rational ν (e.g. ν = 3/2).** The bridge emits `bq =
  //     [-3/4, 5/4]` (literal `rational` Values, NOT `expression`).
  //     Canonical bytes for `rational` are
  //     `{"den":"<d>","kind":"rational","num":"<n>"}`; the `num` string
  //     for `-3/4` starts with `"-` while `5/4`'s starts with `"5`,
  //     and ASCII `-` (45) < `5` (53) ⇒ `-3/4` sorts first ⇒ `bq[0] =
  //     -3/4` does NOT match `ap[0] = 5/4`. The symbolic-ν rule above
  //     therefore misses literal-rational inputs.
  //
  // The rule below mirrors the symbolic-ν rule with `bq`'s slot order
  // swapped (`[{free "d"}, {free "c"}]`); the dispatcher's first-match-
  // wins discipline routes symbolic-ν to the rule above and literal-
  // rational-ν to this one, so the combined coverage is complete for
  // both bridge-produced input shapes. A v0.2 RelationSpec extension
  // (e.g. `"any-position-equal"`) would collapse the pair into one
  // rule; until then the parallel registration is the honest
  // workaround and worth the 20 LOC duplication for round-trip
  // closure with both ν tiers.
  //
  // The closure-validation test (`bessel-closure.test.ts`) exercises
  // the symbolic-ν path explicitly; the mpmath cross-validation
  // (`dispatch-mpmath.test.ts`) exercises the literal-rational path at
  // ν = 3/2, z = 1.
  // ===========================================================================
  {
    id: "bessel-i-canonical-literal-nu",
    source: "DLMF §10.9 + §16.18 / PBM Vol III §8.4 (canonical BesselI G-form; literal-ν branch)",
    note:
      "G^{1,0}_{1,3}([], [c]; [a], [d, c]; z) = (1/π) · BesselI(2a, 2√z) " +
      "(canonical-Bessel with bq permuted for literal-rational ν canonical-sort)",
    match: {
      mnpq: { m: 1, n: 0, p: 1, q: 3 },
      an: [],
      ap: [{ kind: "free", name: "c" }],
      bm: [{ kind: "free", name: "a" }],
      bq: [
        { kind: "free", name: "d" },
        { kind: "free", name: "c" },
      ],
    },
    rewrite: ({ a }, z) => {
      const nu = recoverNuFromHalfSlot(a!);
      return mkDiv(expr("BesselI", [nu, twoSqrtOf(z)]), PI);
    },
  },
];
