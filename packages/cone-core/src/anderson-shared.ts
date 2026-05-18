// =============================================================================
// anderson-shared.ts — vector helpers shared by AA-II and AA-I
// =============================================================================
//
// Two tiny `Float64Array` utilities that both `anderson.ts` (AA-II) and
// `anderson-type-i.ts` (AA-I, the v0.2 port) need. Factored out so the
// two accelerator modules stay independent of each other: editing the
// AA-II ridge logic should never reach into the AA-I file, and vice
// versa. These helpers are intentionally not re-exported from `index.ts`
// — they are an internal implementation detail of the two accelerators,
// not part of the public `@workbench/cone-core` API.
//
// `dot` is the unrolled-in-mind inner product: bounds-checks elided via
// the non-null assertion (every call site walks the array in lockstep so
// the indices are inherently in range). `isFiniteVec` is the safeguard
// gate — a single non-finite leaf flips the accelerator to the plain
// step and clears history (AA-II) or to the KM-averaged fall-back
// (AA-I). Both return promptly on first hit; neither allocates.

/**
 * The standard ℓ₂ inner product `Σᵢ aᵢ bᵢ`. The caller is responsible
 * for matching lengths — both AA accelerators construct their vectors
 * to the working dimension `n` and never cross-call.
 */
export function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * True iff every entry of `v` is a finite IEEE-754 value (not `±Infinity`
 * and not `NaN`). Both accelerators use this to gate an extrapolated
 * iterate before returning it — a NaN slipping through would poison
 * every subsequent iteration with no honest recovery path.
 */
export function isFiniteVec(v: Float64Array): boolean {
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) return false;
  }
  return true;
}
