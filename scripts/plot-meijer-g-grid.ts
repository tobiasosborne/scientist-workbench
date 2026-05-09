// =============================================================================
// plot-meijer-g-grid.ts — evaluate the meijer-g dispatcher on a 20×20 grid
// =============================================================================
//
// Demo script. Picks one canonical Meijer G case, evaluates it on a 20×20
// grid over the complex z-plane, emits TSV on stdout. The sidecar
// `plot-meijer-g-grid.py` renders heatmap diagnostics; the sidecar
// `plot-meijer-g-surface.py` renders the classic "3D surface coloured
// by phase" view (the Wikipedia / DLMF idiom for complex special
// functions).
//
// Cases (selected via `--case=<name>`):
//
//   e-neg-z   (default) — G^{1,0}_{0,1}(_; 0 | z) = e^{-z}
//                         smooth, no singularities; the closed form
//                         lets the script self-check every cell.
//                         (Bateman §5.6 (8) / DLMF §16.18.)
//
//   wiki                 — G^{1,1}_{1,1}(1/2; 1/3 | z)
//                         the Wikipedia "Meijer G-function" lead figure
//                         (input ((1/2),()), ((1/3),()), z ∈ [-2-2i, 2+2i]).
//                         Closed form: Γ(5/6)·z^{1/3}/(1+z)^{5/6} —
//                         branch points at z=0 and z=-1, classic
//                         phase-vortex visualisation.
//
// Why request_mode = "numerical-required": with `auto`, the e^{-z} case
// matches the Bateman §5.6 (8) symbolic rule on every cell and returns
// kind="symbolic" — useful for an oracle, but doesn't plot. Forcing
// numerical takes us down the Slater / contour / asymptotic lanes
// uniformly so every cell yields a (re, im).
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

// ─── case selection ────────────────────────────────────────────────────────

type CaseName = "e-neg-z" | "wiki";

interface CaseSpec {
  name: CaseName;
  /** Decimal strings (or "p/q" rationals) for parameters of the four lists. */
  an: string[];
  ap: string[];
  bm: string[];
  bq: string[];
  reMin: number;
  reMax: number;
  imMin: number;
  imMax: number;
  /** Closed-form |G(z)| for self-checking, or null if no easy oracle. */
  expectedAbs: ((zRe: number, zIm: number) => number) | null;
  /** Display label for the closed-form column. */
  expectedLabel: string;
}

const CASES: Record<CaseName, CaseSpec> = {
  "e-neg-z": {
    name: "e-neg-z",
    an: [],
    ap: [],
    bm: ["0"],
    bq: [],
    reMin: -3.0,
    reMax: 3.0,
    imMin: -3.0,
    imMax: 3.0,
    // |e^{-z}| = e^{-Re z}.
    expectedAbs: (zRe, _zIm) => Math.exp(-zRe),
    expectedLabel: "exp(-Re z)",
  },
  wiki: {
    name: "wiki",
    an: ["1/2"],
    ap: [],
    bm: ["1/3"],
    bq: [],
    // The Wikipedia caption: "in the complex plane from -2-2i to 2+2i".
    reMin: -2.0,
    reMax: 2.0,
    imMin: -2.0,
    imMax: 2.0,
    // Closed form (DLMF §16.18 / standard ramp identity for G^{1,1}_{1,1}):
    //   G^{1,1}_{1,1}(a; b | z) = Γ(1+b-a) · z^b / (1+z)^{1+b-a}
    // For a=1/2, b=1/3: prefactor = Γ(5/6) ≈ 1.128787029908125...,
    // exponents 1/3 on z and 5/6 on (1+z).
    //
    //   |G(z)| = Γ(5/6) · |z|^{1/3} / |1+z|^{5/6}                 ◇
    //
    // ◇ holds on the principal branch (DLMF §16.17.1); near the branch
    //   cuts Mathematica/Wolfram and our dispatcher may differ in the
    //   *sign* of arg G but |G| is independent of branch choice and
    //   serves as a faithful magnitude oracle.
    expectedAbs: (zRe, zIm) => {
      const GAMMA_5_6 = 1.128787029908125; // Γ(5/6)
      const absZ = Math.hypot(zRe, zIm);
      const absZp1 = Math.hypot(1 + zRe, zIm);
      if (absZ === 0 || absZp1 === 0) return Number.NaN;
      return (GAMMA_5_6 * Math.pow(absZ, 1 / 3)) / Math.pow(absZp1, 5 / 6);
    },
    expectedLabel: "Gamma(5/6) * |z|^(1/3) / |1+z|^(5/6)",
  },
};

function parseCase(): CaseSpec {
  const arg = Bun.argv.find((a) => a.startsWith("--case="));
  const name = (arg ? arg.slice("--case=".length) : "e-neg-z") as CaseName;
  if (!(name in CASES)) {
    throw new Error(
      `unknown --case='${name}'; expected one of: ${Object.keys(CASES).join(", ")}`,
    );
  }
  return CASES[name];
}

const SELECTED_CASE = parseCase();
const N = 20;                         // grid is N × N
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

// Long-divide a "p/q" rational into a decimal string at `dps` digits.
// Mirrors `bench/meijer-g/run-candidate.ts:88` (`_expandRational`); kept
// inline here so the script stays a single file. Plain decimals pass
// through.  `cfromStrings` then absorbs the result at `workBits`.
function expandRational(s: string, dps: number): string {
  const t = s.trim();
  if (!t.includes("/")) return t;
  const [pStr, qStr] = t.split("/");
  const p = BigInt(pStr!);
  const q = BigInt(qStr!);
  if (q === 0n) throw new Error(`rational ${s} has zero denominator`);
  const sign = (p < 0n) !== (q < 0n) ? "-" : "";
  let pa = p < 0n ? -p : p;
  const qa = q < 0n ? -q : q;
  const intPart = pa / qa;
  let rem = pa - intPart * qa;
  let frac = "";
  for (let i = 0; i < dps; i++) {
    rem *= 10n;
    const digit = rem / qa;
    rem = rem - digit * qa;
    frac += digit.toString();
    if (rem === 0n) break;
  }
  return sign + intPart.toString() + (frac ? "." + frac : "");
}

function encodeRealParam(s: string, workBits: number): Value {
  const dps = Math.ceil(workBits * 0.30103) + 16;
  const dec = expandRational(s, dps);
  return bigcomplexToValue(cfromStrings(dec, "0", workBits));
}

// Build the input record for the selected case. The parameter strings
// can be plain decimals ("0.5") or rationals ("1/2"); both round-trip
// faithfully into a `bigcomplex` at `workBits` precision via
// `cfromStrings` after the rational long-division.
function buildInput(zRe: number, zIm: number, workBits: number): Value {
  const c = SELECTED_CASE;
  const z = cfromStrings(
    jsNumberToDecimalString(zRe),
    jsNumberToDecimalString(zIm),
    workBits,
  );
  return record({
    an: list(c.an.map((s) => encodeRealParam(s, workBits))),
    ap: list(c.ap.map((s) => encodeRealParam(s, workBits))),
    bm: list(c.bm.map((s) => encodeRealParam(s, workBits))),
    bq: list(c.bq.map((s) => encodeRealParam(s, workBits))),
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
  const reAxis = linspace(SELECTED_CASE.reMin, SELECTED_CASE.reMax, N);
  const imAxis = linspace(SELECTED_CASE.imMin, SELECTED_CASE.imMax, N);
  process.stderr.write(
    `[plot-meijer-g-grid] case='${SELECTED_CASE.name}' ` +
      `Re∈[${SELECTED_CASE.reMin},${SELECTED_CASE.reMax}] ` +
      `Im∈[${SELECTED_CASE.imMin},${SELECTED_CASE.imMax}] ` +
      `oracle=${SELECTED_CASE.expectedLabel}\n`,
  );

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
      // Self-check against the case-specific closed form, if any.
      const expectedAbs = SELECTED_CASE.expectedAbs
        ? SELECTED_CASE.expectedAbs(zRe, zIm)
        : Number.NaN;
      if (Number.isFinite(expectedAbs) && expectedAbs > 0) {
        const relErr = Math.abs(abs - expectedAbs) / expectedAbs;
        if (relErr > maxRelErr) maxRelErr = relErr;
      }

      process.stdout.write(
        [
          zRe.toFixed(6),
          zIm.toFixed(6),
          decoded.gRe.toExponential(10),
          decoded.gIm.toExponential(10),
          abs.toExponential(10),
          arg.toFixed(10),
          decoded.method,
          Number.isFinite(expectedAbs)
            ? expectedAbs.toExponential(10)
            : "nan",
        ].join("\t") + "\n",
      );
    }
  }

  const elapsedS = (performance.now() - t0) / 1000;
  process.stderr.write(
    `[plot-meijer-g-grid] ${N}×${N} = ${N * N} cells in ${elapsedS.toFixed(2)}s; ` +
      `numerical=${nNumerical}, refused=${nRefused}, ` +
      `max |G|-vs-${SELECTED_CASE.expectedLabel} relative error = ` +
      `${maxRelErr.toExponential(2)}\n`,
  );
}

await main();
