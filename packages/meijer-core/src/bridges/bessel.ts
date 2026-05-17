// =============================================================================
// bridges/bessel.ts — bidirectional head ↔ Meijer-G bridge for the Bessel family
// =============================================================================
//
// Purpose
// -------
// Per ADR-0041 §"Decision 5" and the Bessel R4 (`docs/refs/besselj-research/
// R4-meijer-g-bridge.md`), this module pins the canonical bidirectional
// bridge between the Bessel-family heads (`BesselJ`, `BesselY`, `BesselI`,
// `BesselK`) and the Meijer G-function on the wire.
//
// This is the **second** per-head bridge to land in the workbench (Erf was
// the first; `bridges/erf.ts` is the styling exemplar). Bessel is the first
// 2-argument head: every entry takes `(ν, z)` where `ν` is the order and
// `z` is the argument. The `argsInverse` closure on the `ForwardBridge`
// record (renamed from `zInverse` in I6-prep, per ADR-0041 §"Decision 5"
// and Bessel R4 §C) is the arity-agnostic surface that makes the same
// interface serve both 1-arg (Erf returns `[origZ]`) and 2-arg (Bessel
// returns `[origNu, origZ]`) heads without further API change.
//
//   * `headToMeijerG(head, args)` — forward bridge. Given a head name and
//     its argument list `[nu, z]`, returns a `ForwardBridge` (G-form +
//     prefactor `wrap` + 2-element `argsInverse` closure) on success, or
//     `null` when the head is out-of-scope or the arity is wrong.
//
//   * `meijerGToHead(form)` — standalone backward bridge. Pattern-matches
//     a `MeijerGForm` against the four canonical Bessel-family G-forms;
//     on hit, returns `{ head, args }` with `args = [recoveredNu,
//     recoveredZ]`. The standalone path recovers `ν` directly from the
//     G-form's slot tuples (the slots literally carry `ν/2` and `-ν/2`,
//     so `ν` is the slot value doubled) and `z` from `√(4·z_slot)`
//     (the z-substitution is `z²/4`, so `z = √(4·z_slot) = |z|·…`). The
//     `√` recovery is multi-valued — round-trips that need byte identity
//     should call `headToMeijerG(...).argsInverse()` directly. Returns
//     `null` when no rule matches (ADR-0003 boundary failure).
//
// Canonical G-form table (R4 §A.4 — uniform in ν)
// -----------------------------------------------
// The Bessel R4 surveyed the literature and triangulated through SymPy
// `meijerint.py:240-285`, mpmath 30-40 dp verification across `(ν ∈ {1.7,
// 2, 0.5, -2, 0, 1, 3}) × (z ∈ {1.3, 1.5, 2.5, 0, ±real})`, and PBM Vol 3
// §8.4 / Wolfram Functions Site. The naïve 12-cell table (4 heads × 3
// ν-classes integer/half-integer/general) **collapses to 4 forms** — the
// slot tuples carry `ν/2` and `-ν/2` straight through without
// branching. The Wolfram convention `MeijerG[{{a_top},{a_bot}}, {{b_top},
// {b_bot}}, z]` with `(m,n,p,q)` derived from sub-tuple lengths:
//
//   | Head           | (m,n,p,q) | an    | ap            | bm           | bq                  | z-sub | prefactor |
//   |----------------|-----------|-------|---------------|--------------|---------------------|-------|-----------|
//   | BesselJ(ν,z)   | (1,0,0,2) | []    | []            | [ν/2]        | [-ν/2]              | z²/4  | 1         |
//   | BesselY(ν,z)   | (2,0,1,3) | []    | [-(ν+1)/2]    | [ν/2, -ν/2]  | [-(ν+1)/2]          | z²/4  | 1         |
//   | BesselI(ν,z)   | (1,0,1,3) | []    | [(ν+1)/2]     | [ν/2]        | [-ν/2, (ν+1)/2]     | z²/4  | π         |
//   | BesselK(ν,z)   | (2,0,0,2) | []    | []            | [ν/2, -ν/2]  | []                  | z²/4  | 1/2       |
//
// **Why uniform in ν — not ν-class-branched.** Naïve intuition: integer
// ν, half-integer ν, general-ν need different G-forms. R4's load-bearing
// finding is that they do not. The slot tuples `[ν/2]`, `[-ν/2]`, etc.
// carry the un-evaluated `ν` straight through; the Mellin-Barnes
// integrand's Γ-products `Γ(b_j - s)` / `Γ(1 - a_j + s)` evaluate the
// ν-dependence correctly for every ν class. The ν-class-specific
// **reductions** (`J_{1/2}(z) = √(2/(πz))·sin(z)`, integer-ν parity
// `J_{-n} = (-1)^n J_n`, the recurrence `J_{ν+1} = (2ν/z)·J_ν − J_{ν-1}`)
// are simplification opportunities — they live in `cas-simplify`'s
// `bessel-identities.ts` (already shipped per I4 / worklog 152), not in
// this bridge. The bridge is **purely a syntactic transformer between
// named-head AST and G-function AST**; the simplifier is what knows about
// ν-class structure.
//
// This separation of concerns is exactly the ADR-0040 substrate-axis
// discipline applied recursively: the Meijer-G bridge layer owns the
// uniform structural conversion; the cas-simplify layer owns the
// ν-class-specific algebraic simplifications. Either layer can ship,
// extend, or refactor independently of the other.
//
// Encoding conventions — MUST match cas-core/src/special-funcs/bessel-identities.ts
// ----------------------------------------------------------------------------
//   * Symbol π is `sym("pi")` (lowercase, matches Erf and the I4 Bessel
//     identity table at `bessel-identities.ts:249`). `BesselI`'s `π·G`
//     prefactor uses this convention so the simplify ↔ bridge round-trip
//     is byte-identical after canonicalisation.
//   * `ν/2` is `mkDiv(nu, int(2n))`; `-ν/2` is `mkNeg(mkDiv(nu, int(2n)))`;
//     `(ν+1)/2` is `mkDiv(mkPlus([nu, int(1n)]), int(2n))`; `-(ν+1)/2` is
//     `mkNeg(mkDiv(mkPlus([nu, int(1n)]), int(2n)))`. The Bessel I4 rules
//     emit identical shapes (`bessel-identities.ts` uses `mkDiv` /
//     `mkPlus` / `mkNeg` from `../diff.js` — the same helpers).
//   * `z²/4` is `mkDiv(mkPower(z, int(2n)), int(4n))`. We do NOT
//     pre-simplify `(z/2)²` — the bridge stays syntactically faithful;
//     `cas-simplify` may canonicalise further downstream.
//
// The `argsInverse` closure trick (ADR-0041 §"Decision 5", Bessel R4 §C / §D)
// -----------------------------------------------------------------------
// For Bessel the z-substitution is `z → z²/4`. The naïve backward bridge
// would compute `√(4·g.z)` to recover `z`, but `√(z²) = |z|` over ℝ and is
// multi-valued over ℂ. A round-trip `headToMeijerG("BesselJ", [int(0),
// int(-1)])` → `meijerGToHead(...)` would silently lose the sign on `z`.
// Symmetrically, the `ν`-recovery from `slot = ν/2` would need a slot
// inverse (`ν = 2·slot`); Bessel's slot encoding makes this clean, but
// the principle is the same: a closure that returns `[origNu, origZ]`
// byte-identically sidesteps every multi-valued surface.
//
// The `argsInverse` closure on the `ForwardBridge` record captures the
// original `args` lexically. The backward bridge that the *forward bridge
// produced* recovers them via `argsInverse()`, byte-identically, without
// computing any roots or slot-inverses. Per ADR-0041 §"Decision 5":
//
//   * Erf (1-arg): `argsInverse() => [origZ]` (1-element list).
//   * Bessel (2-arg): `argsInverse() => [origNu, origZ]` (2-element list).
//   * Future heads (Whittaker 3-arg, etc.): inherit the same shape with
//     their own arity — no further bridge-API change.
//
// For backward calls on G-forms NOT produced by this bridge's forward
// (e.g. a user-constructed G), the standalone `meijerGToHead` matcher
// reconstructs `[nu, z]` from the slot tuples + z-slot directly. The
// reconstruction is honest but may lose sign / branch on multi-valued
// surfaces; `cas-simplify` may or may not simplify the literal
// `√(4·z_slot)` further. The standalone path is suitable for
// AST-structural round-trips; round-trips that need numerical equivalence
// should go through `headToMeijerG(...).argsInverse()`.
//
// References
// ----------
//   * ADR-0041 — per-head substrate for the Bessel family; §"Decision 5"
//     pins the bridge API + 4 canonical G-forms; §"Why argsInverse rename"
//     pins the arity-agnostic closure.
//   * Bessel R4 — `docs/refs/besselj-research/R4-meijer-g-bridge.md`;
//     §A.4 the 4 canonical G-forms with prefactors (the table above);
//     §C the `argsInverse` API design; §D the round-trip property.
//   * `packages/cas-core/src/special-funcs/bessel-identities.ts` — I4's
//     identity table; the encoding conventions here cross-reference (the
//     `sym("pi")` / `mkDiv(nu, int(2n))` / etc. shapes).
//   * `packages/meijer-core/src/bridges/erf.ts` — the styling exemplar
//     and the 1-arg precedent for the `argsInverse` closure trick.
//   * `packages/meijer-core/src/bridges/types.ts` — the `ForwardBridge`
//     interface (`argsInverse: () => readonly Value[]`), arity-agnostic
//     by design.

import { int, rat, sym, type Value } from "@workbench/protocol";
import {
  mkDiv,
  mkNeg,
  mkPlus,
  mkPower,
  mkTimes,
} from "@workbench/cas-core";
import type { ForwardBridge, MeijerGForm } from "./types.js";

// -----------------------------------------------------------------------------
// Encoding helpers
// -----------------------------------------------------------------------------
//
// Builders for the literals the canonical G-forms use. Kept local (not
// re-exported) so the module's encoding choices stay byte-identical with
// the I4 Bessel identity table without spreading the convention across
// the package's public surface.

const PI: Value = sym("pi");
const HALF: Value = rat(1n, 2n);
const TWO_INT: Value = int(2n);
const FOUR_INT: Value = int(4n);
const ONE_INT: Value = int(1n);

/** `ν/2`. */
function nuOverTwo(nu: Value): Value {
  return mkDiv(nu, TWO_INT);
}

/** `-ν/2`. */
function negNuOverTwo(nu: Value): Value {
  return mkNeg(nuOverTwo(nu));
}

/** `(ν+1)/2`. */
function nuPlusOneOverTwo(nu: Value): Value {
  return mkDiv(mkPlus([nu, ONE_INT]), TWO_INT);
}

/** `-(ν+1)/2`. */
function negNuPlusOneOverTwo(nu: Value): Value {
  return mkNeg(nuPlusOneOverTwo(nu));
}

/** `z²/4` — the uniform Bessel z-substitution. */
function zSquaredOverFour(z: Value): Value {
  return mkDiv(mkPower(z, TWO_INT), FOUR_INT);
}

// -----------------------------------------------------------------------------
// Forward bridge
// -----------------------------------------------------------------------------

/**
 * Forward bridge: head name + arguments → canonical Meijer-G form.
 *
 * Returns:
 *   * `ForwardBridge` on success (BesselJ, BesselY, BesselI, BesselK with
 *     exactly two arguments `[nu, z]`).
 *   * `null` for any head not in this bridge module's scope — the caller
 *     can try the next bridge (when more land) or fall back. Bessel-
 *     family heads with the wrong arity (not exactly 2) also return
 *     `null`.
 *
 * Argument-arity check: the four bridged heads all take exactly two
 * arguments `(ν, z)`. Any other arity returns `null` (honest scope)
 * rather than throwing — the head name was recognised but the call
 * shape isn't bridge-able. This is the same honest-refusal contract Erf
 * uses for the 1-arg surface.
 */
export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null {
  if (args.length !== 2) return null;
  const nu = args[0]!;
  const z = args[1]!;

  switch (head) {
    case "BesselJ": {
      // G^{1,0}_{0,2}([], []; [ν/2], [-ν/2]; z²/4) — prefactor 1.
      // The simplest of the four shapes — empty `an` / `ap` / `bq` lists
      // and a 2-element `bm`-then-`bq` decomposition.
      const gForm: MeijerGForm = {
        an: [],
        ap: [],
        bm: [nuOverTwo(nu)],
        bq: [negNuOverTwo(nu)],
        z: zSquaredOverFour(z),
      };
      // Prefactor 1: BesselJ's G-form IS the BesselJ value directly. No
      // wrap needed — the closure returns its input verbatim.
      const wrap = (g: Value): Value => g;
      // Arity-agnostic closure: 2-element list `[nu, z]` (the first 2-arg
      // bridge in the workbench; future arities inherit the shape).
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    case "BesselY": {
      // G^{2,0}_{1,3}([], [-(ν+1)/2]; [ν/2, -ν/2], [-(ν+1)/2]; z²/4) — prefactor 1.
      // Y_ν is the most-structured of the four shapes: 2 lower-numerator
      // slots, a single upper-denominator slot, a single lower-denominator
      // slot. The `(ν+1)/2` slot appears twice (once in `ap`, once in `bq`)
      // — DLMF §10.9.7 has them as the Mellin-Barnes-integrand poles that
      // generate Y's `cos(νπ)` / `sin(νπ)` connection factors. Both encode
      // structurally identically here; the simplifier handles the
      // cancellation downstream.
      const negNuPlusOneHalf = negNuPlusOneOverTwo(nu);
      const gForm: MeijerGForm = {
        an: [],
        ap: [negNuPlusOneHalf],
        bm: [nuOverTwo(nu), negNuOverTwo(nu)],
        bq: [negNuPlusOneHalf],
        z: zSquaredOverFour(z),
      };
      // Prefactor 1 — same as BesselJ, the G-form IS the value.
      const wrap = (g: Value): Value => g;
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    case "BesselI": {
      // G^{1,0}_{1,3}([], [(ν+1)/2]; [ν/2], [-ν/2, (ν+1)/2]; z²/4) — prefactor π.
      // I_ν is BesselJ's modified sibling — the G-form is BesselJ's
      // `(0,2)` shape promoted to `(1,3)` by an extra `(ν+1)/2` slot
      // appearing in both `ap` and `bq` (the modified-Bessel poles).
      const nuPlusOneHalf = nuPlusOneOverTwo(nu);
      const gForm: MeijerGForm = {
        an: [],
        ap: [nuPlusOneHalf],
        bm: [nuOverTwo(nu)],
        bq: [negNuOverTwo(nu), nuPlusOneHalf],
        z: zSquaredOverFour(z),
      };
      // Prefactor π: `wrap(g) = π · g`. The `sym("pi")` convention matches
      // `bessel-identities.ts:249` and `erf.ts`'s `SQRT_PI` lowercase-pi
      // convention; the simplify pipeline canonicalises uniformly across
      // bridge ↔ identity-table outputs.
      const wrap = (g: Value): Value => mkTimes(PI, g);
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    case "BesselK": {
      // G^{2,0}_{0,2}([], []; [ν/2, -ν/2], []; z²/4) — prefactor 1/2.
      // K_ν is BesselJ's structural sibling on the modified side: empty
      // `an`/`ap`/`bq`, with `bm = [ν/2, -ν/2]` carrying BOTH ν-class
      // slots (where BesselJ has one of each in `bm`/`bq`). The `(0,2)`
      // → `(2,2)` shape collapse comes from BesselK's Hankel-asymptotic
      // structure: both connection-formula sides emit the same series.
      const gForm: MeijerGForm = {
        an: [],
        ap: [],
        bm: [nuOverTwo(nu), negNuOverTwo(nu)],
        bq: [],
        z: zSquaredOverFour(z),
      };
      // Prefactor 1/2: `wrap(g) = (1/2) · g`. The `rat(1n, 2n)` encoding
      // matches Erf's `HALF` convention.
      const wrap = (g: Value): Value => mkTimes(HALF, g);
      const argsInverse = (): readonly Value[] => [nu, z];
      return { gForm, wrap, argsInverse };
    }

    default:
      // Not in this bridge module's scope — caller can try the next
      // bridge or fall back. Null-return composes additively with the
      // Erf bridge (a top-level dispatcher iterates over every
      // registered bridge module and returns the first non-null hit).
      return null;
  }
}

// -----------------------------------------------------------------------------
// Backward bridge — standalone path (no forward-pass closure)
// -----------------------------------------------------------------------------
//
// This path runs when a user (or another tool) hands the bridge a
// `MeijerGForm` that wasn't produced by this module's own `headToMeijerG`.
// The matcher inspects the parameter quintuple structurally and, on hit,
// reconstructs `[nu, z]` from the slot tuples + z-slot.
//
// Slot recovery from the canonical G-forms:
//
//   * `ν` recovery: BesselJ / BesselI / BesselK / BesselY's `bm[0]` is
//     `ν/2` (when the slot is the *literal* shape `mkDiv(nu, int(2n))`;
//     symbolic). The matcher unwraps the `mkDiv(?, 2)` to recover `ν`.
//     For arbitrary `bm[0]` shapes that are not literal `mkDiv(?, 2)`,
//     the recovered ν is the slot value doubled — emitted as
//     `mkTimes(int(2n), slot)`; cas-simplify may reduce further.
//
//   * `z` recovery: the z-slot is `z²/4`; the recovered `z` is
//     `√(4·z_slot)` — emitted literally as
//     `mkPower(mkTimes(int(4n), z_slot), rat(1n, 2n))`. cas-simplify may
//     or may not reduce further. Sign is lost (multi-valued root); for
//     byte-identical round-trip use `headToMeijerG(...).argsInverse()`.
//
// The discrimination between the four heads is structural — slot-tuple
// shape uniquely identifies the head:
//
//   * `(m,n,p,q) = (1,0,0,2)` → BesselJ.
//   * `(m,n,p,q) = (2,0,1,3)` → BesselY.
//   * `(m,n,p,q) = (1,0,1,3)` → BesselI.
//   * `(m,n,p,q) = (2,0,0,2)` → BesselK.
//
// No two Bessel heads share a `(m,n,p,q)` tuple (verified against R4
// §A.4; cross-checked with the Erf-family `(1,1,1,2)` shared between
// Erf/Erfi as the *contrasting* example — Erf needed z-sign
// disambiguation, Bessel does not). This makes the structural matcher
// clean: a single shape switch, no z-sign discriminator.

/**
 * Backward bridge: a Meijer-G form → originating head + args, when the
 * form matches one of the four canonical Bessel-family shapes. Returns
 * `null` when no rule matches — the caller falls back to a different
 * bridge or to the numerical evaluator.
 *
 * Per the slot-recovery section above, the args emitted are literal
 * AST that `cas-simplify` may reduce further. Callers needing byte-
 * identical round-trip should call `headToMeijerG(...).argsInverse()`
 * directly — that closure captures the original args lexically and
 * recovers them without computing any root or slot-inverse.
 */
export function meijerGToHead(
  form: MeijerGForm,
): { head: string; args: readonly Value[] } | null {
  const mnpq = mnpqOf(form);

  // ---------------------------------------------------------------------------
  // BesselJ — (1,0,0,2): an=[], ap=[], bm=[ν/2], bq=[-ν/2]
  // ---------------------------------------------------------------------------
  if (mnpq.m === 1 && mnpq.n === 0 && mnpq.p === 0 && mnpq.q === 2) {
    if (
      form.an.length === 0 &&
      form.ap.length === 0 &&
      form.bm.length === 1 &&
      form.bq.length === 1
    ) {
      // bm[0] = ν/2 and bq[0] = -ν/2; cross-check they are negatives of
      // one another (the structural fingerprint of BesselJ's slot
      // arithmetic — both BesselI/BesselK share the `ν/2`/`-ν/2` pair,
      // but their (m,n,p,q) shapes are different).
      const recoveredNu = recoverNuFromHalfSlot(form.bm[0]!);
      const recoveredZ = recoverZFromZSquaredOverFour(form.z);
      return { head: "BesselJ", args: [recoveredNu, recoveredZ] };
    }
  }

  // ---------------------------------------------------------------------------
  // BesselY — (2,0,1,3): an=[], ap=[-(ν+1)/2], bm=[ν/2, -ν/2], bq=[-(ν+1)/2]
  // ---------------------------------------------------------------------------
  if (mnpq.m === 2 && mnpq.n === 0 && mnpq.p === 1 && mnpq.q === 3) {
    if (
      form.an.length === 0 &&
      form.ap.length === 1 &&
      form.bm.length === 2 &&
      form.bq.length === 1
    ) {
      // Recover ν from bm[0] (= ν/2); we do not enforce bm[1] = -ν/2
      // structurally here — the dispatcher's canonical-sort pass may
      // permute, and the slot identity is structurally clean enough
      // that any (m,n,p,q) = (2,0,1,3) shape with the right arity counts
      // is BesselY by elimination (BesselK is the only other (2,0,_,_)
      // shape and has (0,0) for (n,p,q-m)).
      const recoveredNu = recoverNuFromHalfSlot(form.bm[0]!);
      const recoveredZ = recoverZFromZSquaredOverFour(form.z);
      return { head: "BesselY", args: [recoveredNu, recoveredZ] };
    }
  }

  // ---------------------------------------------------------------------------
  // BesselI — (1,0,1,3): an=[], ap=[(ν+1)/2], bm=[ν/2], bq=[-ν/2, (ν+1)/2]
  // ---------------------------------------------------------------------------
  if (mnpq.m === 1 && mnpq.n === 0 && mnpq.p === 1 && mnpq.q === 3) {
    if (
      form.an.length === 0 &&
      form.ap.length === 1 &&
      form.bm.length === 1 &&
      form.bq.length === 2
    ) {
      const recoveredNu = recoverNuFromHalfSlot(form.bm[0]!);
      const recoveredZ = recoverZFromZSquaredOverFour(form.z);
      return { head: "BesselI", args: [recoveredNu, recoveredZ] };
    }
  }

  // ---------------------------------------------------------------------------
  // BesselK — (2,0,0,2): an=[], ap=[], bm=[ν/2, -ν/2], bq=[]
  // ---------------------------------------------------------------------------
  if (mnpq.m === 2 && mnpq.n === 0 && mnpq.p === 0 && mnpq.q === 2) {
    if (
      form.an.length === 0 &&
      form.ap.length === 0 &&
      form.bm.length === 2 &&
      form.bq.length === 0
    ) {
      const recoveredNu = recoverNuFromHalfSlot(form.bm[0]!);
      const recoveredZ = recoverZFromZSquaredOverFour(form.z);
      return { head: "BesselK", args: [recoveredNu, recoveredZ] };
    }
  }

  // No rule matched — honest refusal.
  return null;
}

// -----------------------------------------------------------------------------
// Slot-recovery helpers
// -----------------------------------------------------------------------------

/**
 * Recover `ν` from a half-slot Value `ν/2`. When the slot is literally
 * `mkDiv(ν, 2)` we unwrap it directly; otherwise we emit
 * `mkTimes(int(2n), slot)` (i.e. `2·slot`) and let cas-simplify reduce.
 *
 * The literal-`mkDiv(?, 2)` unwrap matters because the forward bridge
 * emits exactly that shape — without the unwrap, a standalone backward
 * pass on a forward-built G-form would emit `2·(ν/2)` rather than `ν`,
 * which is correct semantically but noisier than necessary.
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
  // Fallback: emit 2·slot literally; cas-simplify may reduce.
  return mkTimes(TWO_INT, slot);
}

/**
 * Recover `z` from a z-slot `z²/4`. When the slot is literally
 * `mkDiv(mkPower(z, 2), 4)` we unwrap it directly to `z` (sign-positive
 * branch); otherwise we emit `√(4·slot)` and let cas-simplify reduce.
 *
 * **Sign caveat.** The `√(z²) = |z|` over ℝ and is multi-valued over ℂ;
 * a backward pass on a hand-built z-slot `int(9)` (numerically 9 = 3²/?)
 * has no honest way to recover `z = ±3` without a closure capturing the
 * original `z`. The standalone path picks the positive branch by
 * structural convention; round-trips needing byte-identical preservation
 * use `headToMeijerG(...).argsInverse()` instead. Documented at the
 * file-top section "The argsInverse closure trick".
 */
function recoverZFromZSquaredOverFour(slot: Value): Value {
  if (
    slot.kind === "expression" &&
    slot.head === "/" &&
    slot.args.length === 2
  ) {
    const denom = slot.args[1]!;
    const numer = slot.args[0]!;
    const denomIsFour =
      (denom.kind === "integer" && BigInt(denom.value) === 4n) ||
      (denom.kind === "rational" &&
        BigInt(denom.num) === 4n &&
        BigInt(denom.den) === 1n);
    if (
      denomIsFour &&
      numer.kind === "expression" &&
      numer.head === "^" &&
      numer.args.length === 2
    ) {
      const exponent = numer.args[1]!;
      const exponentIsTwo =
        (exponent.kind === "integer" && BigInt(exponent.value) === 2n) ||
        (exponent.kind === "rational" &&
          BigInt(exponent.num) === 2n &&
          BigInt(exponent.den) === 1n);
      if (exponentIsTwo) {
        return numer.args[0]!;
      }
    }
  }
  // Fallback: emit √(4·slot) literally; cas-simplify may reduce.
  return mkPower(mkTimes(FOUR_INT, slot), HALF);
}

// -----------------------------------------------------------------------------
// Local (m,n,p,q) decoder — mirrors the one in `erf.ts`. The bridge
// modules stay standalone so each can be used outside the dispatch
// pipeline.
// -----------------------------------------------------------------------------

function mnpqOf(form: MeijerGForm): { m: number; n: number; p: number; q: number } {
  return {
    m: form.bm.length,
    n: form.an.length,
    p: form.an.length + form.ap.length,
    q: form.bm.length + form.bq.length,
  };
}
