// mod-core property tests:
//   - modPow: agreement with iterated multiplication, identities, edge cases.
//   - modInv: a · modInv(a) ≡ 1 (mod m) when invertible; honest failure otherwise.
//   - ntt:    forward/inverse round-trip, agreement with the schoolbook DFT,
//             linearity, and exact known vectors.
//
// The schoolbook DFT is intentionally O(n^2). It is the reference oracle —
// the fast path must match it residue-for-residue.

import { describe, expect, test } from "bun:test";
import { modInv, modPow, ntt, NTT_SUPPORTED_MODULUS, NTT_SUPPORTED_PRIMITIVE_ROOT } from "../src/index.js";

const P = NTT_SUPPORTED_MODULUS;
const G = NTT_SUPPORTED_PRIMITIVE_ROOT;

class RNG {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  intRange(lo: bigint, hi: bigint): bigint {
    const span = Number(hi - lo + 1n);
    return lo + BigInt(Math.floor(this.next() * span));
  }
  resModP(): bigint {
    return BigInt(Math.floor(this.next() * Number(P)));
  }
}

// ── modPow ────────────────────────────────────────────────────────────────

describe("modPow", () => {
  test("identities: a^0 = 1, a^1 = a, 0^k = 0 (k>0), 1^k = 1", () => {
    expect(modPow(7n, 0n, 13n)).toBe(1n);
    expect(modPow(7n, 1n, 13n)).toBe(7n);
    expect(modPow(0n, 5n, 13n)).toBe(0n);
    expect(modPow(1n, 99n, 13n)).toBe(1n);
  });

  test("modulus = 1 collapses to 0", () => {
    expect(modPow(7n, 5n, 1n)).toBe(0n);
    expect(modPow(0n, 0n, 1n)).toBe(0n);
  });

  test("Fermat for prime p: a^(p-1) = 1 (mod p) when gcd(a,p)=1", () => {
    const primes = [2n, 3n, 5n, 7n, 13n, 31n, 998244353n];
    for (const p of primes) {
      for (let a = 1n; a < 5n && a < p; a++) {
        expect(modPow(a, p - 1n, p)).toBe(1n);
      }
    }
  });

  test("agrees with iterated multiplication for small exponents", () => {
    const rng = new RNG(0x42);
    for (let i = 0; i < 50; i++) {
      const m = rng.intRange(2n, 1000n);
      const a = rng.intRange(0n, m - 1n);
      const e = rng.intRange(0n, 12n);
      let acc = 1n;
      for (let k = 0n; k < e; k++) acc = (acc * a) % m;
      expect(modPow(a, e, m)).toBe(acc);
    }
  });

  test("negative base reduces to canonical residue first", () => {
    expect(modPow(-1n, 3n, 5n)).toBe(4n);
    expect(modPow(-7n, 2n, 13n)).toBe((49n) % 13n);
  });

  test("rejects illegal arguments", () => {
    expect(() => modPow(2n, -1n, 7n)).toThrow();
    expect(() => modPow(2n, 3n, 0n)).toThrow();
    expect(() => modPow(2n, 3n, -5n)).toThrow();
  });

  test("output is always in [0, modulus)", () => {
    const rng = new RNG(0x1337);
    for (let i = 0; i < 100; i++) {
      const m = rng.intRange(2n, 1_000_000n);
      const a = rng.intRange(-1000n, 1000n);
      const e = rng.intRange(0n, 50n);
      const r = modPow(a, e, m);
      expect(r >= 0n && r < m).toBe(true);
    }
  });
});

// ── modInv ────────────────────────────────────────────────────────────────

describe("modInv", () => {
  test("a · modInv(a) ≡ 1 (mod m) for invertible inputs", () => {
    const cases: Array<[bigint, bigint]> = [
      [3n, 7n], [5n, 12n], [11n, 26n], [G, P], [2n, P], [123456n, 998244353n],
    ];
    for (const [a, m] of cases) {
      const r = modInv(a, m);
      expect(r.invertible).toBe(true);
      expect(r.inverse !== null).toBe(true);
      expect((a * r.inverse!) % m).toBe(1n);
    }
  });

  test("not invertible when gcd(a,m) ≠ 1", () => {
    const r = modInv(6n, 9n);
    expect(r.invertible).toBe(false);
    expect(r.inverse).toBeNull();
    expect(r.gcd).toBe(3n);
  });

  test("modInv(1, m) = 1", () => {
    for (const m of [2n, 3n, 7n, 998244353n]) {
      const r = modInv(1n, m);
      expect(r.inverse).toBe(1n);
    }
  });

  test("modulus = 1 returns invertible=false (degenerate)", () => {
    const r = modInv(7n, 1n);
    expect(r.invertible).toBe(false);
  });

  test("rejects illegal modulus", () => {
    expect(() => modInv(3n, 0n)).toThrow();
    expect(() => modInv(3n, -5n)).toThrow();
  });

  test("agrees with Fermat for prime modulus over many random inputs", () => {
    const rng = new RNG(0xfeed);
    const m = 998244353n;
    for (let i = 0; i < 100; i++) {
      const a = rng.intRange(1n, m - 1n);
      const r = modInv(a, m);
      expect(r.invertible).toBe(true);
      const fermat = modPow(a, m - 2n, m);
      expect(r.inverse).toBe(fermat);
    }
  });

  test("output is always in [0, modulus) when invertible", () => {
    const rng = new RNG(0xbaba);
    for (let i = 0; i < 100; i++) {
      const m = rng.intRange(2n, 1000n);
      const a = rng.intRange(-1000n, 1000n);
      const r = modInv(a, m);
      if (r.invertible && r.inverse !== null) {
        expect(r.inverse >= 0n && r.inverse < m).toBe(true);
      }
    }
  });
});

// ── ntt ────────────────────────────────────────────────────────────────────

function schoolbookNTT(x: readonly bigint[], invert: boolean): bigint[] {
  const n = x.length;
  if (n === 0) return [];
  const omega = modPow(G, (P - 1n) / BigInt(n), P);
  const w = invert ? modInv(omega, P).inverse! : omega;
  const out: bigint[] = new Array(n).fill(0n);
  for (let k = 0; k < n; k++) {
    const wk = modPow(w, BigInt(k), P);
    let s = 0n;
    let wjk = 1n;
    for (let j = 0; j < n; j++) {
      s = (s + x[j]! * wjk) % P;
      wjk = (wjk * wk) % P;
    }
    out[k] = s;
  }
  if (invert) {
    const nInv = modInv(BigInt(n), P).inverse!;
    for (let k = 0; k < n; k++) out[k] = (out[k]! * nInv) % P;
  }
  return out;
}

describe("ntt: edge cases", () => {
  test("n=0 returns []", () => {
    expect(ntt([], { direction: "forward" })).toEqual([]);
    expect(ntt([], { direction: "inverse" })).toEqual([]);
  });

  test("n=1 is the identity", () => {
    expect(ntt([0n], { direction: "forward" })).toEqual([0n]);
    expect(ntt([3n], { direction: "forward" })).toEqual([3n]);
    expect(ntt([3n], { direction: "inverse" })).toEqual([3n]);
  });

  test("n=2 forward [1,1] = [2,0]", () => {
    expect(ntt([1n, 1n], { direction: "forward" })).toEqual([2n, 0n]);
  });

  test("n=2 forward [1, p-1] = [0, 2]", () => {
    expect(ntt([1n, P - 1n], { direction: "forward" })).toEqual([0n, 2n]);
  });

  test("rejects n that does not divide p-1", () => {
    // 3 does not divide 2^23 · 7 · 17.
    expect(() => ntt([1n, 2n, 3n], { direction: "forward" })).toThrow();
  });

  test("rejects out-of-range residues", () => {
    expect(() => ntt([P], { direction: "forward" })).toThrow();
    expect(() => ntt([-1n, 0n], { direction: "forward" })).toThrow();
  });
});

describe("ntt: agreement with schoolbook (O(n^2)) reference", () => {
  test("power-of-two sizes 1..64", () => {
    const rng = new RNG(0xabcd);
    for (const n of [1, 2, 4, 8, 16, 32, 64]) {
      const x: bigint[] = [];
      for (let i = 0; i < n; i++) x.push(rng.resModP());
      expect(ntt(x, { direction: "forward" })).toEqual(schoolbookNTT(x, false));
      expect(ntt(x, { direction: "inverse" })).toEqual(schoolbookNTT(x, true));
    }
  });

  test("non-power-of-two sizes (Bluestein path): 7, 14, 17, 28, 34, 119", () => {
    const rng = new RNG(0xc0de);
    for (const n of [7, 14, 17, 28, 34, 119]) {
      const x: bigint[] = [];
      for (let i = 0; i < n; i++) x.push(rng.resModP());
      expect(ntt(x, { direction: "forward" })).toEqual(schoolbookNTT(x, false));
      expect(ntt(x, { direction: "inverse" })).toEqual(schoolbookNTT(x, true));
    }
  });
});

describe("ntt: round-trip identity", () => {
  test("inverse(forward(x)) = x for power-of-two and non-power-of-two", () => {
    const rng = new RNG(0xd00d);
    for (const n of [1, 2, 4, 7, 8, 14, 16, 17, 28, 32, 56, 64, 128, 119]) {
      const x: bigint[] = [];
      for (let i = 0; i < n; i++) x.push(rng.resModP());
      const fwd = ntt(x, { direction: "forward" });
      const back = ntt(fwd, { direction: "inverse" });
      expect(back).toEqual(x);
    }
  });
});

describe("ntt: linearity", () => {
  test("ntt(αx + βy) = α·ntt(x) + β·ntt(y) (mod p)", () => {
    const rng = new RNG(0x5a5a);
    for (const n of [4, 7, 8, 16]) {
      const x: bigint[] = [];
      const y: bigint[] = [];
      for (let i = 0; i < n; i++) { x.push(rng.resModP()); y.push(rng.resModP()); }
      const a = rng.resModP();
      const b = rng.resModP();
      const combined: bigint[] = [];
      for (let i = 0; i < n; i++) combined.push(((a * x[i]!) + (b * y[i]!)) % P);
      const lhs = ntt(combined, { direction: "forward" });
      const Fx = ntt(x, { direction: "forward" });
      const Fy = ntt(y, { direction: "forward" });
      const rhs: bigint[] = [];
      for (let i = 0; i < n; i++) rhs.push(((a * Fx[i]!) + (b * Fy[i]!)) % P);
      expect(lhs).toEqual(rhs);
    }
  });
});

describe("ntt: determinism", () => {
  test("same input twice → same output array (no caches leak state)", () => {
    const rng = new RNG(0xfafa);
    for (const n of [8, 17, 32, 119]) {
      const x: bigint[] = [];
      for (let i = 0; i < n; i++) x.push(rng.resModP());
      const a = ntt(x, { direction: "forward" });
      const b = ntt(x, { direction: "forward" });
      expect(a).toEqual(b);
    }
  });
});
