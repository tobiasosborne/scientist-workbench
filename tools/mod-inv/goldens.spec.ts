import { int, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// 30+ goldens: small primes, the NTT prime p = 998244353, composite
// non-coprime moduli (no-inverse path), negative inputs, edge cases.
export const goldens: GoldenSpec[] = [
  // simple invertible cases
  { description: "3⁻¹ mod 7", input: record({ value: int(3n), modulus: int(7n) }) },
  { description: "5⁻¹ mod 12", input: record({ value: int(5n), modulus: int(12n) }) },
  { description: "11⁻¹ mod 26", input: record({ value: int(11n), modulus: int(26n) }) },
  { description: "7⁻¹ mod 13", input: record({ value: int(7n), modulus: int(13n) }) },
  { description: "9⁻¹ mod 16", input: record({ value: int(9n), modulus: int(16n) }) },
  { description: "1⁻¹ mod 7", input: record({ value: int(1n), modulus: int(7n) }) },
  { description: "1⁻¹ mod p (p = 998244353)", input: record({ value: int(1n), modulus: int(998244353n) }) },
  // NTT-prime-relevant
  { description: "2⁻¹ mod p", input: record({ value: int(2n), modulus: int(998244353n) }) },
  { description: "3⁻¹ mod p", input: record({ value: int(3n), modulus: int(998244353n) }) },
  { description: "(p-1)⁻¹ mod p = p-1", input: record({ value: int(998244352n), modulus: int(998244353n) }) },
  { description: "g = 3 inverse mod p", input: record({ value: int(3n), modulus: int(998244353n) }) },
  { description: "12345⁻¹ mod p", input: record({ value: int(12345n), modulus: int(998244353n) }) },
  { description: "n=8 inverse mod p (NTT scale factor)", input: record({ value: int(8n), modulus: int(998244353n) }) },
  { description: "n=128 inverse mod p", input: record({ value: int(128n), modulus: int(998244353n) }) },
  { description: "n=119 inverse mod p (Bluestein scale)", input: record({ value: int(119n), modulus: int(998244353n) }) },
  // negative inputs canonicalize
  { description: "(-3)⁻¹ mod 7 = 2", input: record({ value: int(-3n), modulus: int(7n) }) },
  { description: "(-1)⁻¹ mod 13 = 12", input: record({ value: int(-1n), modulus: int(13n) }) },
  { description: "(-100)⁻¹ mod 1009", input: record({ value: int(-100n), modulus: int(1009n) }) },
  // no-inverse cases (gcd > 1)
  { description: "no-inverse: gcd(6, 9) = 3", input: record({ value: int(6n), modulus: int(9n) }) },
  { description: "no-inverse: gcd(4, 8) = 4", input: record({ value: int(4n), modulus: int(8n) }) },
  { description: "no-inverse: 0 mod 7 (gcd = 7)", input: record({ value: int(0n), modulus: int(7n) }) },
  { description: "no-inverse: gcd(15, 25) = 5", input: record({ value: int(15n), modulus: int(25n) }) },
  { description: "no-inverse: gcd(12, 18) = 6", input: record({ value: int(12n), modulus: int(18n) }) },
  // larger primes
  { description: "7⁻¹ mod 65537 (Fermat prime)", input: record({ value: int(7n), modulus: int(65537n) }) },
  { description: "100⁻¹ mod 1000003", input: record({ value: int(100n), modulus: int(1000003n) }) },
  { description: "2⁻¹ mod 1000003", input: record({ value: int(2n), modulus: int(1000003n) }) },
  // edge cases
  { description: "modulus = 1: degenerate, no-inverse", input: record({ value: int(7n), modulus: int(1n) }) },
  { description: "value much larger than modulus", input: record({ value: int(123456789n), modulus: int(13n) }) },
  { description: "value coprime to large composite m = p·q", input: record({ value: int(7n), modulus: int(35n) }) },
  { description: "no-inverse: value coprime to neither factor", input: record({ value: int(15n), modulus: int(35n) }) },
  // the "fundamental theorem"-shaped cases that NTT relies on
  { description: "L⁻¹ mod p where L = 16 (Bluestein conv length)", input: record({ value: int(16n), modulus: int(998244353n) }) },
  { description: "(L · n)⁻¹ mod p with L=16, n=7 (Bluestein inverse scale)", input: record({ value: int(112n), modulus: int(998244353n) }) },
];
