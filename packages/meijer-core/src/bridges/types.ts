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
// plus the `zInverse` closure that recovers the head's original argument
// list byte-identically on round-trip).
//
// Scope
// -----
// Bridge modules live under `packages/meijer-core/src/bridges/<head>.ts`,
// one per ADR-0023 vocabulary head (or per family — Erf / Erfc / Erfi share
// `bridges/erf.ts`). Each bridge exports `headToMeijerG(head, args)` and
// `meijerGToHead(form, prefactor?)` over the same record contract; ADR-0040
// §"Decision 5" + R4 §3 nail the API down.
//
// Why a separate `MeijerGForm` type and not just `MeijerGSymbolicParams`
// -----------------------------------------------------------------------
// `MeijerGSymbolicParams` (in `dispatch-types.ts`) carries `(an, ap, bm,
// bq)` only — `z` is threaded as a separate argument to `meijergSymbolic`
// because the dispatcher treats `z` as opaque. The bridge, by contrast,
// pairs the parameter quintuple with its `z`-substitution explicitly (Erf
// substitutes `z²`, Erfi substitutes `−z²`, Erfc substitutes `z²`); the
// `z`-slot is part of the bridge's identity, not external metadata.
// Keeping the shapes distinct stays honest about which layer owns the
// `z`-slot and avoids a load-bearing conflation that would force every
// dispatch caller through the bridge's narrower contract.
//
// The `zInverse` closure trick — load-bearing
// -------------------------------------------
// R4 §3 + ADR-0040 §"Why `zInverse` as a closure on the forward bridge":
// the naïve backward bridge would compute `√(g.z)` to recover the head's
// original argument. This exposes the multi-valued root branch: `√(z²)` is
// `|z|` over ℝ and multi-valued over ℂ. Round-tripping `headToMeijerG("Erf",
// [-1])` → `meijerGToHead(...)` would yield `Erf(1)`, not `Erf(-1)`. The
// fix is to *record* the original `args` on the `ForwardBridge` record and
// return them verbatim — the bridge sidesteps the multi-valued root surface
// entirely.
//
// This contract is the literal implementation of "byte-identical round-
// trip" as the bridge's correctness guarantee. The property test in
// `test/bridges-erf.test.ts` mutation-proves it.

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
 *     Erf or `−z²` for Erfi).
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
 *     `g → (z / √π) · g`; for `Erfc(z)` it is `g → g / √π`. The choice
 *     of a closure (rather than a stored `Value`) is intentional — the
 *     wrap can reference the original `args` lexically without round-
 *     tripping them through canonical bytes, and the function shape
 *     keeps composition simple (`wrap(otherWrap(g))` is composable).
 *
 *   * `zInverse` — the inverse-z-substitution closure. Returns the
 *     head's original `args` byte-identically. The backward bridge calls
 *     `zInverse()` to recover the original argument list without
 *     computing `√(g.z)`. This is the literal implementation of
 *     "byte-identical round-trip" (see file-top "The `zInverse` closure
 *     trick"). For Erf, Erfc, Erfi the closure is simply `() => args`;
 *     for any future bridge that substitutes more elaborately the
 *     closure encapsulates whatever unsubstitution is correct.
 */
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly zInverse: () => readonly Value[];
}
