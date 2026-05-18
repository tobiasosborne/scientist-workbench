// Number-Theoretic Transform over F_p with the supported prime
// p = 998244353 (and primitive root g = 3). Arbitrary length n | (p − 1).
//
// Power-of-two n: iterative Cooley-Tukey on Uint32Array, in-place,
// Montgomery-form arithmetic, single bit-reversal up front.
// Non-power-of-two n: Bluestein chirp-z reduction to a length-L (≥ 2n − 1,
// next power of two) circular convolution evaluated by power-of-two NTT.
//
// Adapted from the tstournament 02-ntt port: the inner Montgomery REDC,
// twiddle layout, and Bluestein plan structure are unchanged. Only the
// public surface and the stdin/stdout glue are removed (those live in the
// tool wrapper, not in the algorithmic core).

import { modPow, modInv } from "./modular.js";

export const NTT_SUPPORTED_MODULUS: bigint = 998244353n;
export const NTT_SUPPORTED_PRIMITIVE_ROOT: bigint = 3n;

const P = 998244353;
const P_BIG = NTT_SUPPORTED_MODULUS;
const G_BIG = NTT_SUPPORTED_PRIMITIVE_ROOT;

// Montgomery domain with R = 2^32, frozen for this prime.
//   p · p_inv ≡ -1 (mod 2^32)
const P_INV = 998244351 | 0;
const R_MOD_P = 301989884;
const R2_MOD_P = 932051910;

// Montgomery multiplication kernel.
//
// Preconditions:  a, b ∈ [0, 2^32) — both already in Montgomery form
//                 (i.e. representing residues `a' = a·R⁻¹`,
//                 `b' = b·R⁻¹` mod p).
// Postcondition:  return value ∈ [0, p) equals `a · b · R⁻¹ mod p`,
//                 i.e. the Montgomery-form product of a and b.
//
// Here R = 2^32, p = 998244353, and `P_INV` = -p⁻¹ mod R is the
// REDC reduction constant. The whole point of this routine is to
// compute t = a·b as a full 64-bit product, then reduce by R using
// only Number arithmetic (no BigInt allocation per multiply, no
// Math.imul-induced sign trouble) — the hot inner loop of every NTT
// butterfly runs through here.
//
// Why 16-bit limbs: JavaScript Numbers are IEEE-754 binary64 with
// 53-bit safe integer range. A 32×32-bit product overflows that;
// splitting each 32-bit input into two 16-bit halves keeps every
// partial product ≤ (2^16 − 1)² < 2^32, well within safe range, and
// composes back into a 64-bit value as `(tHi, tLo)`.
//
// REDC outline:
//   1. t = a · b                       (full 64-bit product)
//   2. m = (t mod R) · P_INV mod R     (low-32 multiplication only)
//   3. u = (t + m · p) / R             (the divisibility step: by
//                                       construction t + m·p ≡ 0
//                                       (mod R), so the division is
//                                       exact)
//   4. if u ≥ p return u − p else u    (final conditional subtract)
//
// Invariant: the low 32 bits of `t + m·p` are zero — that's exactly
// what choosing m via P_INV buys us — so the output is `(t + m·p) / R`,
// which equals the high 32 bits plus any carry from `lowAdd`.
function mmul(a: number, b: number): number {
  // Step 1: t = a · b, computed as a 64-bit value split into (tHi, tLo).
  // Each limb product is at most (2^16 − 1)² < 2^32, so all of `ll`,
  // `lh`, `hl`, `hh` fit in safe-integer range.
  const aLo = a & 0xffff, aHi = a >>> 16;
  const bLo = b & 0xffff, bHi = b >>> 16;

  const ll = aLo * bLo;       // low × low,   contributes to bits  0..32
  const lh = aLo * bHi;       // low × high,  contributes to bits 16..48
  const hl = aHi * bLo;       // high × low,  contributes to bits 16..48
  const hh = aHi * bHi;       // high × high, contributes to bits 32..64

  // Combine the two cross terms; their low half feeds tLo and their
  // high half rolls into tHi (along with any carry from `lowSum`).
  const cross = lh + hl;
  const lowSum = ll + (cross & 0xffff) * 0x10000;
  const tLo = lowSum >>> 0;                                  // = t mod 2^32
  const tHi = hh + (cross >>> 16) + (lowSum >= 0x100000000 ? 1 : 0); // = ⌊t / 2^32⌋

  // Step 2: m = tLo · P_INV mod R. Math.imul gives us the *low* 32 bits
  // of a 32×32 product as a signed int; `>>> 0` re-normalises to
  // unsigned. The high bits don't matter — they will be scaled away by
  // the division by R in step 3.
  const m = Math.imul(tLo | 0, P_INV) >>> 0;

  // Step 3a: m · p, again a full 64-bit product split into (mpHi, mpLo)
  // by the same 16-bit-limb decomposition used for a · b above.
  const mLo = m & 0xffff, mHi = m >>> 16;
  const pLo = P & 0xffff, pHi = P >>> 16;
  const mpll = mLo * pLo;
  const mplh = mLo * pHi;
  const mphl = mHi * pLo;
  const mphh = mHi * pHi;

  const mpCross = mplh + mphl;
  // mpCross can exceed 2^32 (its operands are < 2^32 each, so sum < 2^33),
  // so we split it manually rather than via `>>> 16` which would mask
  // bit 32 away. Math.floor(mpCross / 0x10000) is the safe form.
  const mpCrossLo = mpCross & 0xffff;
  const mpCrossHi = Math.floor(mpCross / 0x10000);
  const mpLowSum = mpll + mpCrossLo * 0x10000;
  const mpLo = mpLowSum >>> 0;
  const mpHi = mphh + mpCrossHi + (mpLowSum >= 0x100000000 ? 1 : 0);

  // Step 3b: u = (t + m · p) / R. By construction the low 32 bits of
  // `t + m·p` are zero, so we only need the high half plus any carry
  // bit out of `lowAdd`. We compute `lowAdd` not because we use its
  // value but because we use its carry.
  const lowAdd = tLo + mpLo;
  const u = tHi + mpHi + (lowAdd >= 0x100000000 ? 1 : 0);

  // Step 4: final reduction. `u` is in [0, 2p), so a single subtract
  // suffices; no loop, no comparison ladder.
  return u >= P ? u - P : u;
}

const toMont = (x: number): number => mmul(x, R2_MOD_P);
const fromMont = (x: number): number => mmul(x, 1);
const addmod = (a: number, b: number): number => { const s = a + b; return s >= P ? s - P : s; };
const submod = (a: number, b: number): number => { const s = a - b; return s < 0 ? s + P : s; };

// Modular inverse over F_p; helper used at plan-build time only. Falls back
// on the generic extended-Euclid; for prime p, Fermat (a^{p-2}) is also fine
// but EEA is faster on small inputs.
function fpInv(a: bigint): bigint {
  const r = modInv(a, P_BIG);
  if (!r.invertible || r.inverse === null) {
    throw new Error(`internal: ${a} is not invertible mod p`);
  }
  return r.inverse;
}

// ── NTTContext: instance-scoped caches ──────────────────────────────────────
//
// Three plan tables — power-of-two twiddles, Bluestein chirp plans, and
// the power-of-two `n⁻¹` table — live as `Map<number, …>` keyed by `n`
// (with the sign of the key encoding the inverse-direction variant).
// They were originally module-level singletons, which had three
// problems:
//
//   1. Unbounded growth. A fuzz test that allocates arbitrary `n`
//      values leaks memory for the whole process lifetime; there was
//      no way to release the plans without restarting Bun.
//   2. Process-global. Currently the modulus is frozen at
//      `NTT_SUPPORTED_MODULUS = 998244353`, so cache keys are unique
//      by `n` alone — but a future generalisation to other NTT-friendly
//      primes (Solinas primes, etc.) would collide on the same `n` key
//      across moduli, returning the wrong plan.
//   3. Hidden ordering coupling. `ntt(...)` was a pure function on its
//      output, but its *timings* depended on which `n` values had been
//      seen before — the first invocation at a given `n` paid the
//      plan-build cost; subsequent ones reused. That's a footgun for
//      anyone benchmarking the tool: an iteration-1 number is the
//      build-and-run number; an iteration-2 number is the cache-hit
//      number. Removing the implicit module state makes timings a
//      function of the caller-supplied context lifetime.
//
// `NTTContext` is the explicit owner. Constructing a fresh context
// gives clean caches; calling `clear()` releases the memory without
// constructing a new instance. The two-argument `ntt(x, opts)` shape
// is preserved by defaulting `ctx` to a module-singleton (`defaultNTTContext()`)
// for backwards compatibility with the published surface — that
// singleton has the same behaviour as the old module-level Maps, so
// existing call sites and goldens are byte-stable.
//
// For v0.1 the context carries no modulus state — the kernel constants
// (`P`, `P_INV`, `R_MOD_P`, etc.) remain module-level because changing
// them is a deeper change than this bead asks for. A future
// `NTTContext(modulus, primitiveRoot)` constructor that bundles the
// Montgomery setup is the natural extension; this class is shaped so
// it can grow without breaking the v0.1 callers.

/**
 * Owns the three plan caches that `ntt(...)` consults. Construct one
 * per long-running fuzz/benchmark loop to bound cache growth, or use
 * `defaultNTTContext()` to share a process-global instance.
 *
 * The caches' values (twiddle tables, Bluestein plans, `n⁻¹` scalars)
 * depend only on `(n, direction)` and the modulus; for v0.1 the
 * modulus is fixed at `NTT_SUPPORTED_MODULUS`, so two instances are
 * effectively equivalent in cold-cache behaviour and differ only in
 * which plans they retain.
 */
export class NTTContext {
  readonly modulus: bigint = NTT_SUPPORTED_MODULUS;
  readonly primitiveRoot: bigint = NTT_SUPPORTED_PRIMITIVE_ROOT;

  // Maps are private — exposing them would let callers corrupt cached
  // plans (the typed plan structures hold Uint32Arrays the kernel
  // reads as-is). The `clear()` method is the only sanctioned mutator.
  readonly #twiddles: Map<number, Uint32Array> = new Map();
  readonly #bluesteinPlans: Map<number, BluesteinPlan> = new Map();
  readonly #pow2InvNMont: Map<number, number> = new Map();

  /** Drop all cached plans. Next `ntt(...)` call repays the build cost. */
  clear(): void {
    this.#twiddles.clear();
    this.#bluesteinPlans.clear();
    this.#pow2InvNMont.clear();
  }

  /**
   * Approximate cache occupancy, summed across the three plan maps.
   * Useful in tests asserting that `clear()` actually releases entries,
   * or in fuzz loops that want to cap context size.
   */
  size(): number {
    return this.#twiddles.size + this.#bluesteinPlans.size + this.#pow2InvNMont.size;
  }

  // Internal accessors — package-private semantics via the `_*` prefix.
  // The free functions below call these; user code never touches them.
  _getTwiddles(key: number): Uint32Array | undefined { return this.#twiddles.get(key); }
  _setTwiddles(key: number, v: Uint32Array): void { this.#twiddles.set(key, v); }
  _getBluestein(key: number): BluesteinPlan | undefined { return this.#bluesteinPlans.get(key); }
  _setBluestein(key: number, v: BluesteinPlan): void { this.#bluesteinPlans.set(key, v); }
  _getPow2InvN(key: number): number | undefined { return this.#pow2InvNMont.get(key); }
  _setPow2InvN(key: number, v: number): void { this.#pow2InvNMont.set(key, v); }
}

/**
 * The process-global `NTTContext` consulted by `ntt(...)` when no
 * context is supplied. Constructed lazily on first use; lives for the
 * process lifetime. The singleton is the historical (pre-`nip`)
 * behaviour — clearing it from one call site clears it everywhere.
 */
let DEFAULT_CONTEXT: NTTContext | null = null;
export function defaultNTTContext(): NTTContext {
  if (DEFAULT_CONTEXT === null) DEFAULT_CONTEXT = new NTTContext();
  return DEFAULT_CONTEXT;
}

// ── Power-of-two NTT ────────────────────────────────────────────────────────

function powerOfTwoTwiddles(ctx: NTTContext, n: number, invert: boolean): Uint32Array {
  const key = invert ? -n : n;
  const cached = ctx._getTwiddles(key);
  if (cached) return cached;

  const table = new Uint32Array(Math.max(1, n - 1));
  for (let L = 2; L <= n; L <<= 1) {
    const H = L >>> 1;
    const wReg = modPow(G_BIG, (P_BIG - 1n) / BigInt(L), P_BIG);
    const wUsed = invert ? fpInv(wReg) : wReg;
    const wMont = toMont(Number(wUsed));
    let cur = R_MOD_P;
    for (let k = 0; k < H; k++) {
      table[H - 1 + k] = cur;
      cur = mmul(cur, wMont);
    }
  }
  ctx._setTwiddles(key, table);
  return table;
}

function bitReverse(a: Uint32Array): void {
  const n = a.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >>> 1;
    for (; j & bit; bit >>>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = a[i]!; a[i] = a[j]!; a[j] = t; }
  }
}

function nttPow2InPlace(ctx: NTTContext, a: Uint32Array, invert: boolean): void {
  const n = a.length;
  if (n <= 1) return;
  bitReverse(a);
  const tw = powerOfTwoTwiddles(ctx, n, invert);
  for (let L = 2; L <= n; L <<= 1) {
    const H = L >>> 1;
    const base = H - 1;
    for (let i = 0; i < n; i += L) {
      for (let k = 0; k < H; k++) {
        const u = a[i + k]!;
        const v = mmul(a[i + k + H]!, tw[base + k]!);
        a[i + k]     = addmod(u, v);
        a[i + k + H] = submod(u, v);
      }
    }
  }
}

// ── Bluestein chirp-z ───────────────────────────────────────────────────────

interface BluesteinPlan {
  readonly n: number;
  readonly L: number;
  readonly chirp: Uint32Array;
  readonly bHat: Uint32Array;
  readonly invScaleMont: number;
}

function nextPow2(x: number): number {
  let p = 1;
  while (p < x) p <<= 1;
  return p;
}

function bluesteinPlan(ctx: NTTContext, n: number, invert: boolean): BluesteinPlan {
  const key = invert ? -n : n;
  const cached = ctx._getBluestein(key);
  if (cached) return cached;

  if ((P_BIG - 1n) % (2n * BigInt(n)) !== 0n) {
    throw new Error(`ntt: 2n=${2 * n} does not divide p−1; cannot form ζ_{2n}`);
  }

  const zetaBase = modPow(G_BIG, (P_BIG - 1n) / (2n * BigInt(n)), P_BIG);
  const zeta = invert ? fpInv(zetaBase) : zetaBase;
  const zetaMont = toMont(Number(zeta));
  const zetaInvMont = toMont(Number(fpInv(zeta)));
  const zetaSqMont = mmul(zetaMont, zetaMont);
  const zetaSqInvMont = mmul(zetaInvMont, zetaInvMont);

  const chirp = new Uint32Array(n);
  const chirpInv = new Uint32Array(n);
  chirp[0] = R_MOD_P;
  chirpInv[0] = R_MOD_P;
  let cur = R_MOD_P, curInv = R_MOD_P;
  let step = zetaMont, stepInv = zetaInvMont;
  for (let j = 1; j < n; j++) {
    cur = mmul(cur, step);
    curInv = mmul(curInv, stepInv);
    chirp[j] = cur;
    chirpInv[j] = curInv;
    step = mmul(step, zetaSqMont);
    stepInv = mmul(stepInv, zetaSqInvMont);
  }

  const L = nextPow2(2 * n - 1);
  const bHat = new Uint32Array(L);
  bHat[0] = chirpInv[0]!;
  for (let m = 1; m < n; m++) {
    bHat[m]     = chirpInv[m]!;
    bHat[L - m] = chirpInv[m]!;
  }
  nttPow2InPlace(ctx, bHat, false);

  const invScaleBig = invert
    ? fpInv(BigInt(L) * BigInt(n))
    : fpInv(BigInt(L));
  const invScaleMont = toMont(Number(invScaleBig));

  const plan: BluesteinPlan = { n, L, chirp, bHat, invScaleMont };
  ctx._setBluestein(key, plan);
  return plan;
}

// ── Top-level dispatch ──────────────────────────────────────────────────────

function pow2InvNMont(ctx: NTTContext, n: number): number {
  const cached = ctx._getPow2InvN(n);
  if (cached !== undefined) return cached;
  const v = toMont(Number(fpInv(BigInt(n))));
  ctx._setPow2InvN(n, v);
  return v;
}

export interface NTTOptions {
  readonly direction: "forward" | "inverse";
}

/**
 * Length-n NTT over F_p (p = NTT_SUPPORTED_MODULUS = 998244353).
 *
 * Inputs are canonical residues in [0, p) as bigints. n must divide p − 1.
 * Output is the corresponding length-n residue list. n = 0 returns [].
 *
 * Implementation: power-of-two n via radix-2 Cooley-Tukey; otherwise
 * Bluestein chirp-z reducing to a length-(next pow2 ≥ 2n−1) convolution.
 *
 * The optional third parameter `ctx` is an `NTTContext` that owns the
 * plan caches (twiddles, Bluestein plans, `n⁻¹` Montgomery scalars).
 * Omitting it uses a process-global default — historical behaviour,
 * suitable for one-shot calls. Long-running fuzz/benchmark loops
 * should construct a fresh `NTTContext` per loop and discard it after,
 * or call `ctx.clear()` periodically to bound memory.
 */
export function ntt(x: readonly bigint[], opts: NTTOptions, ctx?: NTTContext): bigint[] {
  const n = x.length;
  if (n === 0) return [];
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    if (v < 0n || v >= P_BIG) {
      throw new RangeError(`ntt: x[${i}] = ${v} is not a canonical residue in [0, p)`);
    }
  }
  if ((P_BIG - 1n) % BigInt(n) !== 0n) {
    throw new RangeError(`ntt: n=${n} does not divide p−1; no nth root of unity exists in F_p`);
  }
  if (n === 1) return [x[0]!];

  const c = ctx ?? defaultNTTContext();
  const invert = opts.direction === "inverse";
  const xReg = new Array<number>(n);
  for (let i = 0; i < n; i++) xReg[i] = Number(x[i]!);

  if ((n & (n - 1)) === 0) {
    const a = new Uint32Array(n);
    for (let i = 0; i < n; i++) a[i] = toMont(xReg[i]!);
    nttPow2InPlace(c, a, invert);
    if (invert) {
      const nInvMont = pow2InvNMont(c, n);
      for (let i = 0; i < n; i++) a[i] = mmul(a[i]!, nInvMont);
    }
    const out = new Array<bigint>(n);
    for (let i = 0; i < n; i++) out[i] = BigInt(fromMont(a[i]!));
    return out;
  }

  const plan = bluesteinPlan(c, n, invert);
  const { L, chirp, bHat, invScaleMont } = plan;

  const A = new Uint32Array(L);
  for (let j = 0; j < n; j++) A[j] = mmul(toMont(xReg[j]!), chirp[j]!);

  nttPow2InPlace(c, A, false);
  for (let i = 0; i < L; i++) A[i] = mmul(A[i]!, bHat[i]!);
  nttPow2InPlace(c, A, true);

  const out = new Array<bigint>(n);
  for (let k = 0; k < n; k++) {
    out[k] = BigInt(fromMont(mmul(mmul(A[k]!, chirp[k]!), invScaleMont)));
  }
  return out;
}
