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

// Inner kernel: a · b · R^{-1} mod p in pure Number arithmetic via 16-bit
// limb partial products. Each partial product < 2^32 (safe-integer-bounded).
function mmul(a: number, b: number): number {
  const aLo = a & 0xffff, aHi = a >>> 16;
  const bLo = b & 0xffff, bHi = b >>> 16;

  const ll = aLo * bLo;
  const lh = aLo * bHi;
  const hl = aHi * bLo;
  const hh = aHi * bHi;

  const cross = lh + hl;
  const lowSum = ll + (cross & 0xffff) * 0x10000;
  const tLo = lowSum >>> 0;
  const tHi = hh + (cross >>> 16) + (lowSum >= 0x100000000 ? 1 : 0);

  const m = Math.imul(tLo | 0, P_INV) >>> 0;

  const mLo = m & 0xffff, mHi = m >>> 16;
  const pLo = P & 0xffff, pHi = P >>> 16;
  const mpll = mLo * pLo;
  const mplh = mLo * pHi;
  const mphl = mHi * pLo;
  const mphh = mHi * pHi;

  const mpCross = mplh + mphl;
  const mpCrossLo = mpCross & 0xffff;
  const mpCrossHi = Math.floor(mpCross / 0x10000);
  const mpLowSum = mpll + mpCrossLo * 0x10000;
  const mpLo = mpLowSum >>> 0;
  const mpHi = mphh + mpCrossHi + (mpLowSum >= 0x100000000 ? 1 : 0);

  const lowAdd = tLo + mpLo;
  const u = tHi + mpHi + (lowAdd >= 0x100000000 ? 1 : 0);
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

// ── Power-of-two NTT ────────────────────────────────────────────────────────

const POW2_TWIDDLE_CACHE: Map<number, Uint32Array> = new Map();

function powerOfTwoTwiddles(n: number, invert: boolean): Uint32Array {
  const key = invert ? -n : n;
  const cached = POW2_TWIDDLE_CACHE.get(key);
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
  POW2_TWIDDLE_CACHE.set(key, table);
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

function nttPow2InPlace(a: Uint32Array, invert: boolean): void {
  const n = a.length;
  if (n <= 1) return;
  bitReverse(a);
  const tw = powerOfTwoTwiddles(n, invert);
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

const BLUESTEIN_CACHE: Map<number, BluesteinPlan> = new Map();

function bluesteinPlan(n: number, invert: boolean): BluesteinPlan {
  const key = invert ? -n : n;
  const cached = BLUESTEIN_CACHE.get(key);
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
  nttPow2InPlace(bHat, false);

  const invScaleBig = invert
    ? fpInv(BigInt(L) * BigInt(n))
    : fpInv(BigInt(L));
  const invScaleMont = toMont(Number(invScaleBig));

  const plan: BluesteinPlan = { n, L, chirp, bHat, invScaleMont };
  BLUESTEIN_CACHE.set(key, plan);
  return plan;
}

// ── Top-level dispatch ──────────────────────────────────────────────────────

const POW2_INV_N_MONT_CACHE: Map<number, number> = new Map();

function pow2InvNMont(n: number): number {
  const cached = POW2_INV_N_MONT_CACHE.get(n);
  if (cached !== undefined) return cached;
  const v = toMont(Number(fpInv(BigInt(n))));
  POW2_INV_N_MONT_CACHE.set(n, v);
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
 */
export function ntt(x: readonly bigint[], opts: NTTOptions): bigint[] {
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

  const invert = opts.direction === "inverse";
  const xReg = new Array<number>(n);
  for (let i = 0; i < n; i++) xReg[i] = Number(x[i]!);

  if ((n & (n - 1)) === 0) {
    const a = new Uint32Array(n);
    for (let i = 0; i < n; i++) a[i] = toMont(xReg[i]!);
    nttPow2InPlace(a, invert);
    if (invert) {
      const nInvMont = pow2InvNMont(n);
      for (let i = 0; i < n; i++) a[i] = mmul(a[i]!, nInvMont);
    }
    const out = new Array<bigint>(n);
    for (let i = 0; i < n; i++) out[i] = BigInt(fromMont(a[i]!));
    return out;
  }

  const plan = bluesteinPlan(n, invert);
  const { L, chirp, bHat, invScaleMont } = plan;

  const A = new Uint32Array(L);
  for (let j = 0; j < n; j++) A[j] = mmul(toMont(xReg[j]!), chirp[j]!);

  nttPow2InPlace(A, false);
  for (let i = 0; i < L; i++) A[i] = mmul(A[i]!, bHat[i]!);
  nttPow2InPlace(A, true);

  const out = new Array<bigint>(n);
  for (let k = 0; k < n; k++) {
    out[k] = BigInt(fromMont(mmul(mmul(A[k]!, chirp[k]!), invScaleMont)));
  }
  return out;
}
