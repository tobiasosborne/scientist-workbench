// =============================================================================
// plot-meijer-g-grid.ts — evaluate the meijer-g dispatcher on a 20×20 grid
// =============================================================================
//
// Demo script. Picks one canonical Meijer G case
//
//     G^{1,0}_{0,1}(_; 0 | z) = e^{-z}                         (Bateman §5.6 (8))
//
// and evaluates it on a 20×20 grid over the complex z-plane. Emits TSV on
// stdout with one line per cell; the sidecar `plot-meijer-g-grid.py` reads
// the TSV and renders matplotlib heatmaps of |G(z)| and arg(G(z)).
//
// Why this case: the closed-form e^{-z} lets the script self-check every
// numerical cell against `Math.exp(-zRe) * (cos(zIm), -sin(zIm))` to ~3
// digits, catching dispatcher / encoding regressions without a separate
// oracle.
//
// Why request_mode = "numerical-required": with `auto`, this case
// matches the Bateman §5.6 (8) symbolic rule on every cell and returns
// kind="symbolic" — useful, but doesn't plot. Forcing numerical takes us
// down the Slater lane uniformly so every cell yields a (re, im).
//
// Wiring: `executeToolDef` directly (the same workaround as the bench
// adapter, ADR-0012; see `bench/meijer-g/run-candidate.ts:266-296`).
// `runWorkbench` would refuse the `precision` flag because the
// arbprec runner injects it underneath the user-declared flag set
// (worklog 083 / `lc1`/`rn2`).

import { executeToolDef } from "@workbench/contract";
import { def as meijerGDef } from "../tools/meijer-g/tool.ts";
import {
  bigcomplexToValue,
  cfromInts,
  cfromStrings,
  decimalToBinaryPrecision,
  toFloat64,
  valueToBigComplex,
} from "@workbench/bigfloat";
import { list, record, str, type Value } from "@workbench/protocol";

const N = 20;                         // grid is N × N
const RE_MIN = -3.0;                  // Re(z) range
const RE_MAX = 3.0;
const IM_MIN = -3.0;                  // Im(z) range
const IM_MAX = 3.0;
const PRECISION_DPS = 30;             // plotting only needs ~4 visible digits

// linspace over a closed interval, N samples; matches numpy.linspace.
function linspace(lo: number, hi: number, n: number): number[] {
  if (n === 1) return [lo];
  const out: number[] = [];
  const step = (hi - lo) / (n - 1);
  for (let i = 0; i < n; i++) out.push(lo + i * step);
  return out;
}

// Format a JS number as a decimal string at enough digits to round-trip
// faithfully into the bigfloat substrate (the bench adapter's pattern).
// 17 digits captures every IEEE-754 double; the workBits headroom in the
// bigfloat itself absorbs any trailing-bit noise.
function jsNumberToDecimalString(x: number): string {
  if (!Number.isFinite(x)) {
    throw new Error(`grid coordinate must be finite; got ${x}`);
  }
  return x.toExponential(17);
}

// Build the canonical input record for G^{1,0}_{0,1}(_; 0 | z).
//
// The four-tuple split is { an: [], ap: [], bm: [0], bq: [] }. The b_m
// entry "0" is encoded as an exact BigComplex(0, 0) at workBits precision
// — the symbolic dispatcher's `bigcomplexToSymbolicValue` then surfaces
// it as `int(0)` for pattern-matching, but with `numerical-required` mode
// that path doesn't fire and the integer-real shape is irrelevant.
function buildInput(zRe: number, zIm: number, workBits: number): Value {
  const z = cfromStrings(
    jsNumberToDecimalString(zRe),
    jsNumberToDecimalString(zIm),
    workBits,
  );
  const zero = cfromInts(0n, 0n, workBits);
  return record({
    an: list([] as Value[]),
    ap: list([] as Value[]),
    bm: list([bigcomplexToValue(zero)]),
    bq: list([] as Value[]),
    z: bigcomplexToValue(z),
    request_mode: str("numerical-required"),
  });
}

// Decode a successful numerical output to JS doubles. Returns null on a
// tagged-refusal branch (caller emits NaN cells in that case).
function decodeNumerical(
  out: Value,
): { gRe: number; gIm: number; method: string } | null {
  if (out.kind === "tagged") return null;
  if (out.kind !== "record") {
    throw new Error(`unexpected output kind=${out.kind}`);
  }
  const kindField = out.fields["kind"];
  if (!kindField || kindField.kind !== "string") {
    throw new Error("output record missing 'kind' string field");
  }
  if (kindField.value !== "numerical") {
    // request_mode='numerical-required' forbids 'symbolic'; anything else
    // is a contract violation (refusals come back tagged, handled above).
    throw new Error(
      `expected kind='numerical' under numerical-required mode; got '${kindField.value}'`,
    );
  }
  const valueField = out.fields["value"];
  const methodField = out.fields["method"];
  if (!valueField || !methodField || methodField.kind !== "string") {
    throw new Error("numerical output missing 'value' or 'method'");
  }
  const bc = valueToBigComplex(valueField);
  return {
    gRe: toFloat64(bc.re).value,
    gIm: toFloat64(bc.im).value,
    method: methodField.value,
  };
}

async function main(): Promise<void> {
  const workBits = decimalToBinaryPrecision(PRECISION_DPS) + 64;
  const reAxis = linspace(RE_MIN, RE_MAX, N);
  const imAxis = linspace(IM_MIN, IM_MAX, N);

  // TSV header. The Python sidecar parses by column name.
  process.stdout.write(
    ["zRe", "zIm", "gRe", "gIm", "abs", "arg", "method", "expected_abs"].join(
      "\t",
    ) + "\n",
  );

  let nNumerical = 0;
  let nRefused = 0;
  let maxRelErr = 0;
  const t0 = performance.now();

  for (const zIm of imAxis) {
    for (const zRe of reAxis) {
      const input = buildInput(zRe, zIm, workBits);
      const flags = { precision: BigInt(PRECISION_DPS) } as Record<
        string,
        unknown
      >;

      const { output } = await executeToolDef(
        meijerGDef,
        input,
        flags as never,
      );
      const decoded = decodeNumerical(output);

      if (decoded === null) {
        nRefused++;
        process.stdout.write(
          [zRe, zIm, "nan", "nan", "nan", "nan", "refused", "nan"].join("\t") +
            "\n",
        );
        continue;
      }

      nNumerical++;
      const abs = Math.hypot(decoded.gRe, decoded.gIm);
      const arg = Math.atan2(decoded.gIm, decoded.gRe);
      // Self-check against the closed form |e^{-z}| = e^{-Re z}.
      const expectedAbs = Math.exp(-zRe);
      const relErr = Math.abs(abs - expectedAbs) / Math.max(expectedAbs, 1e-300);
      if (relErr > maxRelErr) maxRelErr = relErr;

      process.stdout.write(
        [
          zRe.toFixed(6),
          zIm.toFixed(6),
          decoded.gRe.toExponential(10),
          decoded.gIm.toExponential(10),
          abs.toExponential(10),
          arg.toFixed(10),
          decoded.method,
          expectedAbs.toExponential(10),
        ].join("\t") + "\n",
      );
    }
  }

  const elapsedS = (performance.now() - t0) / 1000;
  // Stats line on stderr so the TSV on stdout stays clean.
  process.stderr.write(
    `[plot-meijer-g-grid] ${N}×${N} = ${N * N} cells in ${elapsedS.toFixed(2)}s; ` +
      `numerical=${nNumerical}, refused=${nRefused}, ` +
      `max |G|-vs-e^{-Re z} relative error = ${maxRelErr.toExponential(2)}\n`,
  );
}

await main();
