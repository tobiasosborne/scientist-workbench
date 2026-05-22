// =============================================================================
// meijer-g-asymptotic-only — Braaksma far-field asymptotic for Meijer G
// =============================================================================
//
// Intent
// ------
// Thin wire-protocol wrapper around `@workbench/meijer-core`'s
// `meijergAsymptotic` orchestrator (ADR-0026). Exposes the
// principal-sector algebraic dominant asymptotic for `|z| → ∞` as
// an isolated tool. Independently exercising the asymptotic path
// lets the benchmark probe it separately from the eventual
// `tools/meijer-g` top-level dispatcher (which will compose
// symbolic-first → Slater → contour → asymptotic → refuse).
//
// I/O contract
// ------------
//   input:  record { an: list<bigcomplex>,
//                    ap: list<bigcomplex>,
//                    bm: list<bigcomplex>,
//                    bq: list<bigcomplex>,
//                    z:  bigcomplex }
//
//   output (success):
//     record { value: bigcomplex,
//              achieved_precision: integer,
//              method: string,                     // "braaksma-algebraic"
//              n_terms: integer,                    // total summands
//              optimal_term_indices: list<integer>, // per-pole k*
//              error_estimate: bigfloat,            // Σ_h |B_h z^{a_h-1} t_{k*+1}|
//              sector: string,                      // "principal"
//              working_precision: integer,
//              warnings: list<string> }
//
//   refusals (tagged):
//     meijer-g-asymptotic-only/stokes-line                  record { reason }
//     meijer-g-asymptotic-only/secondary-sector             record { reason }
//     meijer-g-asymptotic-only/small-z                      record { reason }
//     meijer-g-asymptotic-only/non-asymptotic-regime        record { reason }
//     meijer-g-asymptotic-only/no-pole-residues             record { reason }
//     meijer-g-asymptotic-only/coverage-gap                 record { reason }
//     meijer-g-asymptotic-only/input-error                  record { reason }
//     meijer-g-asymptotic-only/degenerate-principal-sector  record { reason }
//
// The egf-era `stokes-band-refused` tag was retracted with worklog 125
// — the band machinery and the connection-formula assembly it gated
// were both removed when empirical verification confirmed
// `H_workbench(z) = G(z)` on the principal Riemann sheet for δ ≥ 1.
//
// The `degenerate-principal-sector` tag (ADR-0039 §D6, bead `atip`,
// 2026-05-16) fires when the shape's Paris–Kaminski defect
// `δ = m + n − (p+q)/2 ≤ 0`, i.e. the algebraic envelope `|arg z| < δπ`
// is empty (δ=0) or negative (δ<0). For such shapes the right-closing
// Slater residue series does not converge to G; routing through this
// path was the bug that motivated bead `atip` (deleted golden 17,
// G^{1,1}_{1,3}: kernel +4.4×10⁻³ vs mpmath truth −0.5549…). The
// dominant-E Braaksma formula that would handle this regime is
// deferred; callers should route to `meijergContour` for a numerical
// answer in the interim.
//
// `--precision=N` (decimal digits, default 50) is the standard
// ADR-0020 flag inherited from the runner. Determinism contract:
// `arbprec: true` — bit-identical output across runtimes given the
// `(input, precision)` pair.
//
// When to reach for this tool
// ---------------------------
// * `|z|` is large enough that Slater is exponentially expensive or
//   diverges (`p > q` regime).
// * `|arg z| < π/2 - π/64` (the principal sector).
// * The caller is happy with a structured refusal for inputs
//   outside the principal sector or with `|z| < 1`.
//
// For inputs *outside* this regime the right call is
// `meijer-g-slater-only` (when applicable) or
// `meijer-g-contour-only` (forthcoming wrapper of `meijergContour`
// — until then, call the `@workbench/meijer-core` API directly via
// composition).

import {
  bool,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  type BigComplex,
  bigcomplexSchema,
  bigcomplexToValue,
  bigfloatSchema,
  bigfloatToValue,
  cfromInts,
  valueToBigComplex,
} from "@workbench/bigfloat";
import { meijergAsymptotic } from "@workbench/meijer-core";

const NAME = "meijer-g-asymptotic-only";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  an: S.list(bigcomplexSchema),
  ap: S.list(bigcomplexSchema),
  bm: S.list(bigcomplexSchema),
  bq: S.list(bigcomplexSchema),
  z: bigcomplexSchema,
});

const successOutputSchema = S.record({
  value: bigcomplexSchema,
  achieved_precision: S.kind("integer"),
  method: S.kind("string"),
  n_terms: S.kind("integer"),
  optimal_term_indices: S.list(S.kind("integer")),
  error_estimate: bigfloatSchema,
  sector: S.kind("string"),
  working_precision: S.kind("integer"),
  warnings: S.list(S.kind("string")),
});

const refusalOutputSchema = (tag: string) =>
  S.tagged(tag, S.record({ reason: S.kind("string") }));

const outputSchema = S.union([
  successOutputSchema,
  // Refusal classes (ADR-0026 envelope + ADR-0039 §D3 `coverage-gap` +
  // ADR-0039 §D6 `degenerate-principal-sector`).
  // `stokes-line` is retained as defence-in-depth for κ ≤ 0 fallback
  // edges; the κ-aware classifier never emits it for κ ≥ 1 inputs.
  // `stokes-band-refused` and the Stokes-multiplier-driven `egf` v0.1
  // assembly were retracted with worklog 125; the band geometry was
  // gating a connection formula that empirical verification proved
  // unnecessary (H_workbench = G on the principal Riemann sheet for
  // δ ≥ 1). The retracted tag is no longer reachable from the kernel.
  // `degenerate-principal-sector` was added by bead `atip` (2026-05-16)
  // — fires for shapes with δ ≤ 0 where the algebraic envelope is empty
  // and the right-closing series silently diverges from G.
  refusalOutputSchema(`${NAME}/stokes-line`),
  refusalOutputSchema(`${NAME}/secondary-sector`),
  refusalOutputSchema(`${NAME}/small-z`),
  refusalOutputSchema(`${NAME}/non-asymptotic-regime`),
  refusalOutputSchema(`${NAME}/no-pole-residues`),
  refusalOutputSchema(`${NAME}/input-error`),
  refusalOutputSchema(`${NAME}/coverage-gap`),
  refusalOutputSchema(`${NAME}/degenerate-principal-sector`),
]);

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Braaksma far-field asymptotic for Meijer G in the principal sector; superasymptotic truncation at the optimal term; `arbprec: true`",
  schema: { input: inputSchema, output: outputSchema },
  arbprec: true,
  examples: [
    {
      description: "G^{0,1}_{1,0}(1; _ | 100) = e^{-1/100}, asymptotic regime",
      input: record({
        an: list([bigcomplexToValue(cfromInts(1n, 0n, 50))]),
        ap: list([] as Value[]),
        bm: list([] as Value[]),
        bq: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(100n, 0n, 50)),
      }),
      flags: { precision: "30" },
    },
    {
      description:
        "G^{1,1}_{1,2}([1/2];_ ;[0],[1] | 100) — generic principal-sector asymptotic",
      input: record({
        an: list([bigcomplexToValue(cfromInts(1n, 0n, 50))]), // placeholder - overridden in goldens
        ap: list([] as Value[]),
        bm: list([bigcomplexToValue(cfromInts(0n, 0n, 50))]),
        bq: list([bigcomplexToValue(cfromInts(1n, 0n, 50))]),
        z: bigcomplexToValue(cfromInts(100n, 0n, 50)),
      }),
      flags: { precision: "30" },
    },
    {
      description:
        "G^{1,0}_{0,1}(_; 0 | 100) — refuses with no-pole-residues (n=0)",
      input: record({
        an: list([] as Value[]),
        ap: list([] as Value[]),
        bm: list([bigcomplexToValue(cfromInts(0n, 0n, 50))]),
        bq: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(100n, 0n, 50)),
      }),
      flags: { precision: "30" },
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes + same precision → same output bytes",
      machine_checkable: true,
    },
    {
      name: "principal-sector only",
      statement:
        "Inputs with |arg z| ≥ π/2 - π/64 emit `tagged " +
        "meijer-g-asymptotic-only/secondary-sector` rather than a numerical " +
        "answer; v0.1 does not handle the secondary-sector connection " +
        "coefficients (deferred to hv0.9.5).",
      machine_checkable: true,
    },
    {
      name: "small-z refusal",
      statement:
        "Inputs with |z| < 1 emit `tagged " +
        "meijer-g-asymptotic-only/small-z`. The `|z| → ∞` asymptotic does " +
        "not apply at small |z|; route to Slater instead.",
      machine_checkable: true,
    },
    {
      name: "n=0 refusal",
      statement:
        "Inputs with n = 0 (empty `an`) emit `tagged " +
        "meijer-g-asymptotic-only/no-pole-residues`. The right-closing " +
        "asymptotic requires at least one upper pole; the symmetric " +
        "left-closing asymptotic for n=0 cases is hv0.9.4.",
      machine_checkable: true,
    },
    {
      name: "method-agreement with Slater on overlap region",
      statement:
        "On inputs where Slater and asymptotic both apply, the two " +
        "values agree to the user-stated precision (less the asymptotic " +
        "error estimate). Tested in `packages/meijer-core/test/" +
        "asymptotic.test.ts` against multiple closed-form anchors.",
      machine_checkable: true,
    },
  ],
  fn: (input, flags) => {
    const inputRecord = input as Extract<Value, { kind: "record" }>;
    const decode = (key: string): BigComplex[] => {
      const v = inputRecord.fields[key] as Extract<Value, { kind: "list" }>;
      return v.items.map((it) => valueToBigComplex(it));
    };
    const an = decode("an");
    const ap = decode("ap");
    const bm = decode("bm");
    const bq = decode("bq");
    const z = valueToBigComplex(inputRecord.fields.z!);

    const precision = Number((flags as { precision?: bigint }).precision ?? 50n);
    if (!Number.isInteger(precision) || precision < 1) {
      throw new ToolError(
        `${NAME}: precision must be a positive integer; got ${precision}`,
      );
    }

    const result = meijergAsymptotic({ an, ap, bm, bq }, z, precision);

    if (result.status === "success") {
      const warningStrs = result.warnings.map((w) => str(w));
      const optimalIdxs = result.optimalTermIndices.map((k) =>
        int(BigInt(k)),
      );
      return record({
        value: bigcomplexToValue(result.value),
        achieved_precision: int(BigInt(result.achievedPrecision)),
        method: str(result.method),
        n_terms: int(BigInt(result.nTerms)),
        optimal_term_indices: list(optimalIdxs),
        error_estimate: bigfloatToValue(result.errorEstimate),
        sector: str(result.sector),
        working_precision: int(BigInt(result.workingPrecision)),
        warnings: list(warningStrs),
      });
    }

    const tag = `${NAME}/${result.status}`;
    // All refusal records are plain `{ reason }` shapes. The egf-era
    // `stokes-band-refused` tag (which carried an extra
    // `band_half_width` BigFloat) was retracted with worklog 125; the
    // band machinery it surfaced is gone with it.
    return tagged(tag, record({ reason: str(result.reason) }));
  },
});

// `bool` is reserved for future invariant-result-flavoured outputs
// (e.g., a "did the optimal-truncation hit cap?" boolean field). Not
// yet emitted; the import is kept for the v0.2 surface expansion.
void bool;

if (import.meta.main) void runTool(def);
