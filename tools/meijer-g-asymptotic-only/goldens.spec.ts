// =============================================================================
// Goldens — meijer-g-asymptotic-only
// =============================================================================
//
// Each entry exercises one v0.1 code-path branch:
//   * principal-sector success at modest precision (entire-function regime
//     where Slater Series 2 also converges; agreement is the load-bearing
//     witness);
//   * principal-sector success in the genuinely-asymptotic (p > q) regime;
//   * each refusal class (`stokes-line`, `secondary-sector`, `small-z`,
//     `no-pole-residues`, `input-error`).
//
// Goldens are regenerated via
// `bun scripts/generate-goldens.ts --tool meijer-g-asymptotic-only`. The
// generated files in `goldens/` are byte-deterministic given
// `arbprec: true`.

import { bigcomplexToValue, cfromInts, cfromStrings } from "@workbench/bigfloat";
import { list, record, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

const PREC = 256;

const cZero = bigcomplexToValue(cfromInts(0n, 0n, PREC));
const cHalf = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
const cOne = bigcomplexToValue(cfromInts(1n, 0n, PREC));
const c100 = bigcomplexToValue(cfromInts(100n, 0n, PREC));
const c1000 = bigcomplexToValue(cfromInts(1000n, 0n, PREC));
const cNeg100 = bigcomplexToValue(cfromInts(-100n, 0n, PREC));
const c0_5 = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
const c100i = bigcomplexToValue(cfromStrings("0", "100", PREC));

function gParams(
  an: Value[],
  ap: Value[],
  bm: Value[],
  bq: Value[],
  z: Value,
): Value {
  return record({
    an: list(an),
    ap: list(ap),
    bm: list(bm),
    bq: list(bq),
    z,
  });
}

export const goldens: GoldenSpec[] = [
  // All cases below run at the default precision = 50 dps. Goldens omit
  // the per-case `flags` field because the asymptotic lane's tier
  // behaviour (entire-function, optimal-truncation, divergent inner pFq,
  // sector boundary) is exercised meaningfully at default precision;
  // precision-dial sweeps live in `tool.test.ts`. After the lc1 / rn2
  // fixes (worklog 083) the runner threads `--precision=N` correctly
  // through to `flags.precision` — adding `flags: { precision: "..." }`
  // here would now produce different bytes (correctly so), but the
  // existing default-50 corpus stays byte-identical.

  // Principal-sector success: G^{0,1}_{1,0}(1; |100) = e^{-1/100}.
  // Inner pFq is 0F0 (entire); converges everywhere. Asymptotic
  // hits the per-pole cap (no turnaround) but the partial sum is the
  // correct value to ~50 dps.
  {
    description: "G^{0,1}_{1,0}(1; _ | 100) — entire-function asymptotic",
    input: gParams([cOne], [], [], [], c100),
  },

  // G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 100) — generic principal-sector
  // case with non-trivial parameter spread. Inner pFq has p_inner=1,
  // q_inner=1 ⇒ converges, but the series exhibits a turnaround at
  // a finite index, demonstrating the optimal-truncation logic.
  {
    description:
      "G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 100) — optimal truncation",
    input: gParams([cHalf], [], [cZero], [cOne], c100),
  },

  // G^{0,1}_{2,0}([1, 1/2]; |100) — genuinely divergent inner pFq
  // (p_inner=2, q_inner=0). Covered by Braaksma but Slater diverges.
  {
    description: "G^{0,1}_{2,0}([1, 1/2]; _ | 100) — divergent-asymptotic",
    input: gParams([cOne, cHalf], [], [], [], c100),
  },

  // Higher |z| at default precision. Demonstrates that the
  // truncation-error contribution shrinks as |z| grows.
  {
    description:
      "G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 1000)",
    input: gParams([cHalf], [], [cZero], [cOne], c1000),
  },

  // Refusal: secondary-sector. arg z = π (z = -100).
  {
    description: "z = -100 (arg z = π) ⇒ secondary-sector",
    input: gParams([cHalf], [], [cZero], [cOne], cNeg100),
  },

  // Refusal: stokes-line / secondary-sector. arg z = π/2 (z = 100i).
  {
    description: "z = 100i (arg z = π/2) ⇒ secondary-sector",
    input: gParams([cHalf], [], [cZero], [cOne], c100i),
  },

  // Refusal: small-z. |z| = 0.5 < 1.
  {
    description: "|z| = 0.5 ⇒ small-z",
    input: gParams([cHalf], [], [cZero], [cOne], c0_5),
  },

  // Refusal: no-pole-residues. n = 0 (an empty).
  {
    description: "n = 0 ⇒ no-pole-residues",
    input: gParams([], [], [cZero], [], c100),
  },
];
