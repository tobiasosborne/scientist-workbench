import { int, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// 30+ goldens covering: identities, edge cases, Fermat for several primes,
// negative-base reduction, large exponents, primitive-root computations
// (the latter relevant to NTT root-of-unity setup).
export const goldens: GoldenSpec[] = [
  // identities
  { description: "0^0 = 1 mod 7", input: record({ base: int(0n), exponent: int(0n), modulus: int(7n) }) },
  { description: "5^0 = 1 mod 13", input: record({ base: int(5n), exponent: int(0n), modulus: int(13n) }) },
  { description: "5^1 = 5 mod 13", input: record({ base: int(5n), exponent: int(1n), modulus: int(13n) }) },
  { description: "0^7 = 0 mod 13", input: record({ base: int(0n), exponent: int(7n), modulus: int(13n) }) },
  { description: "1^99 = 1 mod 13", input: record({ base: int(1n), exponent: int(99n), modulus: int(13n) }) },
  // small exact cases
  { description: "2^10 mod 1000", input: record({ base: int(2n), exponent: int(10n), modulus: int(1000n) }) },
  { description: "3^4 mod 5", input: record({ base: int(3n), exponent: int(4n), modulus: int(5n) }) },
  { description: "7^12 mod 31", input: record({ base: int(7n), exponent: int(12n), modulus: int(31n) }) },
  { description: "13^7 mod 19", input: record({ base: int(13n), exponent: int(7n), modulus: int(19n) }) },
  { description: "2^16 mod 65537 (Fermat prime)", input: record({ base: int(2n), exponent: int(16n), modulus: int(65537n) }) },
  // Fermat: a^(p-1) = 1 for prime p
  { description: "Fermat: 2^(p-1) mod 998244353", input: record({ base: int(2n), exponent: int(998244352n), modulus: int(998244353n) }) },
  { description: "Fermat: 3^(p-1) mod 998244353", input: record({ base: int(3n), exponent: int(998244352n), modulus: int(998244353n) }) },
  { description: "Fermat: 17^(p-1) mod 998244353", input: record({ base: int(17n), exponent: int(998244352n), modulus: int(998244353n) }) },
  { description: "Fermat: 2^16 mod 17", input: record({ base: int(2n), exponent: int(16n), modulus: int(17n) }) },
  { description: "Fermat: 3^6 mod 7", input: record({ base: int(3n), exponent: int(6n), modulus: int(7n) }) },
  // negative-base canonicalization
  { description: "(-1)^3 mod 5 = 4", input: record({ base: int(-1n), exponent: int(3n), modulus: int(5n) }) },
  { description: "(-1)^4 mod 5 = 1", input: record({ base: int(-1n), exponent: int(4n), modulus: int(5n) }) },
  { description: "(-7)^2 mod 13", input: record({ base: int(-7n), exponent: int(2n), modulus: int(13n) }) },
  { description: "(-100)^5 mod 1009", input: record({ base: int(-100n), exponent: int(5n), modulus: int(1009n) }) },
  // modulus = 1 collapses
  { description: "modulus 1: 7^5 = 0", input: record({ base: int(7n), exponent: int(5n), modulus: int(1n) }) },
  // RSA-shaped
  { description: "RSA-shaped: 7^65537 mod 1000003", input: record({ base: int(7n), exponent: int(65537n), modulus: int(1000003n) }) },
  { description: "RSA-shaped: 65537^11 mod 1000003", input: record({ base: int(65537n), exponent: int(11n), modulus: int(1000003n) }) },
  // primitive-root / NTT-relevant
  { description: "NTT root: 3^((p-1)/2) mod p", input: record({ base: int(3n), exponent: int(499122176n), modulus: int(998244353n) }) },
  { description: "NTT root: 3^((p-1)/4) mod p", input: record({ base: int(3n), exponent: int(249561088n), modulus: int(998244353n) }) },
  { description: "NTT root: 3^((p-1)/8) mod p", input: record({ base: int(3n), exponent: int(124780544n), modulus: int(998244353n) }) },
  { description: "NTT root: 3^((p-1)/7) mod p", input: record({ base: int(3n), exponent: int(142606336n), modulus: int(998244353n) }) },
  // larger exponents
  { description: "5^1000000 mod 998244353", input: record({ base: int(5n), exponent: int(1000000n), modulus: int(998244353n) }) },
  { description: "12345^54321 mod 998244353", input: record({ base: int(12345n), exponent: int(54321n), modulus: int(998244353n) }) },
  { description: "2^1000 mod 999999000001", input: record({ base: int(2n), exponent: int(1000n), modulus: int(999999000001n) }) },
  // tiny moduli
  { description: "7^11 mod 2 = 1", input: record({ base: int(7n), exponent: int(11n), modulus: int(2n) }) },
  { description: "8^11 mod 2 = 0", input: record({ base: int(8n), exponent: int(11n), modulus: int(2n) }) },
  { description: "5^17 mod 3", input: record({ base: int(5n), exponent: int(17n), modulus: int(3n) }) },
];
