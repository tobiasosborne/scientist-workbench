// =============================================================================
// bridges/types.ts — bidirectional head ↔ Meijer-G bridge types
// =============================================================================
//
// Purpose
// -------
// This module pins the two record types every per-head bridge produces and
// consumes: `MeijerGForm` (the structural body of a Meijer G-function on
// the wire — the `(an, ap, bm, bq, z)` quintuple) and `ForwardBridge` (the
// return shape of `headToMeijerG(...)`: G-form plus a prefactor wrapper
// plus the `argsInverse` closure that recovers the head's original argument
// list byte-identically on round-trip).
//
// Scope
// -----
// Bridge modules live under `packages/meijer-core/src/bridges/<head>.ts`,
// one per ADR-0023 vocabulary head (or per family — Erf / Erfc / Erfi share
// `bridges/erf.ts`; BesselJ / BesselY / BesselI / BesselK will share
// `bridges/bessel.ts` when I6 lands). Each bridge exports
// `headToMeijerG(head, args)` and `meijerGToHead(form, prefactor?)` over
// the same record contract; ADR-0040 §"Decision 5" + the Erf R4
// (`docs/refs/erf-research/R4-meijer-g-bridge.md`) §3 pin the 1-arg API,
// and ADR-0041 §"Decision 5" + the Bessel R4
// (`docs/refs/besselj-research/R4-meijer-g-bridge.md`) §C generalise it to
// the multi-arg shape this module ships.
//
// Why a separate `MeijerGForm` type and not just `MeijerGSymbolicParams`
// -----------------------------------------------------------------------
// `MeijerGSymbolicParams` (in `dispatch-types.ts`) carries `(an, ap, bm,
// bq)` only — `z` is threaded as a separate argument to `meijergSymbolic`
// because the dispatcher treats `z` as opaque. The bridge, by contrast,
// pairs the parameter quintuple with its `z`-substitution explicitly (Erf
// substitutes `z²`, Erfi substitutes `−z²`, Erfc substitutes `z²`, Bessel
// substitutes `z²/4`); the `z`-slot is part of the bridge's identity, not
// external metadata. Keeping the shapes distinct stays honest about which
// layer owns the `z`-slot and avoids a load-bearing conflation that would
// force every dispatch caller through the bridge's narrower contract.
//
// The `argsInverse` closure trick — load-bearing
// ----------------------------------------------
// Erf R4 §3 + ADR-0040 §"Why `zInverse` as a closure on the forward
// bridge" (the original 1-arg statement of the trick): the naïve backward
// bridge would compute `√(g.z)` to recover the head's original argument.
// This exposes the multi-valued root branch: `√(z²)` is `|z|` over ℝ and
// multi-valued over ℂ. Round-tripping `headToMeijerG("Erf", [-1])` →
// `meijerGToHead(...)` would yield `Erf(1)`, not `Erf(-1)`. The fix is to
// *record* the original `args` on the `ForwardBridge` record and return
// them verbatim — the bridge sidesteps the multi-valued root surface
// entirely.
//
// Why `argsInverse` (the rename from `zInverse`) — arity-agnostic by design
// ------------------------------------------------------------------------
// The Erf v0.1 surface (ADR-0040) called the closure `zInverse` because
// Erf's head takes a single argument named `z`. Bessel (ADR-0041) is the
// first 2-argument head: `BesselJ(ν, z)`, `BesselY(ν, z)`, `BesselI(ν, z)`,
// `BesselK(ν, z)`. The closure must recover BOTH `ν` and `z` byte-
// identically; calling it `zInverse` would be a false name, recovering a
// list whose head is not the `z` the name advertises.
//
// The Bessel R4 (`docs/refs/besselj-research/R4-meijer-g-bridge.md`) §C
// surveyed three candidate designs (rename to `argsInverse`; add a
// parallel `nuInverse`; keep the name and only change semantics) and
// recommended Design A: rename to `argsInverse`, keep the closure shape
// `() => readonly Value[]` (which the Erf v0.1 closure already had).
// Justification (ADR-0041 §"Decision 5", "Why `argsInverse` rename"):
//
//   1. Truth in naming. The closure recovers the head's argument list; the
//      name must track that meaning. `zInverse` would be a legacy tax for
//      every head whose first argument is not called `z`.
//   2. The Erf v0.1 closure already returned `readonly Value[]` — the
//      rename is non-semantic. Every existing Erf call site changes from
//      `bridge.zInverse()` to `bridge.argsInverse()` and reads the same
//      `[origZ]` list byte-identically.
//   3. The single closure is arity-agnostic: Erf returns `[z]`, Bessel
//      returns `[nu, z]`, a future Whittaker bridge (`WhittakerM(κ, μ, z)`,
//      ADR-0023) returns `[k, m, z]`, all without further API change. The
//      alternative (per-slot closures like `zInverse` + `nuInverse` +
//      `muInverse`) would force every caller to assemble a list from
//      slot-readers and would re-shape every time a new arity lands.
//   4. The closure's *content* is per-bridge logic. The Erf bridge knows
//      its head is 1-arg; the Bessel bridge knows its head is 2-arg. The
//      interface stays universal; the bridge module specialises.
//
// This contract is the literal implementation of "byte-identical round-
// trip" as the bridge's correctness guarantee. The property test in
// `test/bridges-erf.test.ts` mutation-proves it for the Erf family
// (1-arg); the Bessel I6 bead `kgky` mutation-proves it for the Bessel
// family (2-arg) when that bridge ships.

import type { Value } from "@workbench/protocol";

/**
 * The structural body of a Meijer G-function on the wire.
 *
 * The four parameter sub-tuples carry the conventional Wolfram-encoding
 * slot vocabulary (matching `MeijerGSymbolicParams` in `dispatch-types.ts`,
 * mirrored here to avoid a load-bearing import cycle):
 *
 *   * `an` — `a_top`, the first `n` upper parameters (numerator-line of
 *     the `n` left-closing residue series).
 *   * `ap` — `a_bot`, the remaining `p − n` upper parameters
 *     (denominator-line of the right-closing residue series).
 *   * `bm` — `b_top`, the first `m` lower parameters (numerator-line of
 *     the `m` right-closing series — the enclosed poles).
 *   * `bq` — `b_bot`, the remaining `q − m` lower parameters
 *     (denominator contribution).
 *   * `z`  — the G-function argument (already substituted, e.g. `z²` for
 *     Erf, `−z²` for Erfi, `z²/4` for Bessel).
 *
 * Per R4 §"Wolfram MeijerG argument convention", the shape tuple
 * `(m, n, p, q)` derives from the four arrays' lengths:
 * `m = bm.length`, `n = an.length`, `p = an.length + ap.length`,
 * `q = bm.length + bq.length`.
 *
 * No prefactor field — that is carried separately by `ForwardBridge.wrap`
 * (R4 §3.a Choice B for the *forward* surface; Choice A for the *backward*
 * intermediate, where the prefactor parameter on `meijerGToHead` is the
 * hybrid). Keeping the prefactor outside the structural body lets two
 * G-forms with the same parameter quintuple but different prefactors
 * compare equal at the matcher level.
 */
export interface MeijerGForm {
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
  readonly z: Value;
}

/**
 * The return record of `headToMeijerG(head, args)`. Three fields:
 *
 *   * `gForm` — the structural G-function body (see `MeijerGForm`).
 *
 *   * `wrap` — the prefactor wrapper. Caller invokes `wrap(meijerG(gForm))`
 *     to obtain the final scalar expression. For `Erf(z)` the wrap is
 *     `g → (z / √π) · g`; for `Erfc(z)` it is `g → g / √π`; for
 *     `BesselJ(ν, z)` and `BesselY(ν, z)` it is the identity `g → g`;
 *     for `BesselI(ν, z)` it is `g → π · g`; for `BesselK(ν, z)` it is
 *     `g → (1/2) · g`. The choice of a closure (rather than a stored
 *     `Value`) is intentional — the wrap can reference the original `args`
 *     lexically without round-tripping them through canonical bytes, and
 *     the function shape keeps composition simple (`wrap(otherWrap(g))`
 *     is composable).
 *
 *   * `argsInverse` — the inverse-z-substitution closure. Returns the
 *     head's original `args` list byte-identically, arity-agnostic. The
 *     backward bridge calls `argsInverse()` to recover the original
 *     argument list without computing `√(g.z)` (Erf) or `(√(4·g.z), …)`
 *     (Bessel). This is the literal implementation of "byte-identical
 *     round-trip" (see file-top "The `argsInverse` closure trick" and
 *     "Why `argsInverse` (the rename from `zInverse`)").
 *
 *     Per-bridge specialisations:
 *       * Erf / Erfc / Erfi: `() => [origZ]` — 1-element list.
 *       * BesselJ / BesselY / BesselI / BesselK: `() => [origNu, origZ]`
 *         — 2-element list (when `bridges/bessel.ts` lands per I6).
 *       * Future heads inherit the same shape with their own arity.
 *
 *     The return type is `readonly Value[]` (not a tuple) precisely so
 *     the interface stays arity-agnostic. Consumers that know which head
 *     they bridged extract `args[0]` (Erf's `z`), or `args[0]` and
 *     `args[1]` (Bessel's `ν` and `z`); the interface does not enforce
 *     the arity contract, because doing so would re-shape the type for
 *     every new head and defeat the rename's whole point (see ADR-0041
 *     §"Decision 5").
 */
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly argsInverse: () => readonly Value[];
}
