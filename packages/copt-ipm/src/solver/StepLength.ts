// Maximum step that keeps a non-negative vector strictly positive.
// COPT applies the Mehrotra safeguard clip(max(0.95α, 2α-1), 0.999999)
// at L1022-1041 of FUN_00732a50.

export function maxStepToBoundary(z: Float64Array, dz: Float64Array): number {
  let alpha = Infinity;
  for (let i = 0; i < z.length; i++) {
    const d = dz[i]!;
    if (d < 0) {
      const a = -z[i]! / d;
      if (a < alpha) alpha = a;
    }
  }
  return alpha === Infinity ? 1.0 : alpha;
}

export function safeguardStep(alpha: number, stepFactor: number): number {
  const aggressive = 2 * alpha - 1;
  const conservative = stepFactor * alpha;
  const choice = aggressive > conservative ? aggressive : conservative;
  if (choice < 0) return 0;
  if (choice > 0.999999) return 0.999999;
  return choice;
}
