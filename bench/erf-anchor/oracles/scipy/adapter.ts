// =============================================================================
// bench/erf-anchor/oracles/scipy/adapter.ts — SciPy bronze-tier oracle adapter
// =============================================================================
//
// Bead: scientist-workbench-1f8r (G4 — SciPy oracle adapter, bronze tier float64).
// Phase 1 Phase-Bead: G4 of the Erf golden-master suite. Consumes the canonical
// `bench/erf-anchor/corpus.json` (G1 / bead scientist-workbench-9sqr) and
// produces `bench/erf-anchor/oracles/scipy/results.json` — the float64-tier
// reference values the SunPro-1993 port (Phase 2 I5) will be graded against.
//
// ---------------------------------------------------------------------------
// Tier role: BRONZE (float64). SciPy is *not* an arb-prec voice.
// ---------------------------------------------------------------------------
// SciPy 1.17 ships `scipy.special.erf`/`erfc`/`erfi`/`erfcx`/`erfinv`/`erfcinv`
// as wrappers over Stephen Moshier's **Cephes** library (`cprob/ndtr.c`). The
// upstream lineage is documented in R3 §1.1 ("Cephes (Moshier, 1984–2000)").
// Cephes is libm-grade — it shares ancestral DNA with the SunPro 1993 algorithm
// we will port (R3's Decision pick) but is *independent code* fitted with a
// different rational dispatch (degree-4/5 in z² for |x| < 1, then 1−erfc; for
// erfc, two rational pieces in x split at |x| = 8 — not the SunPro 1/x²
// asymptotic split). Independence is what makes it a useful cross-check: a
// joint Cephes-SunPro 2-ULP agreement on the corpus is much stronger evidence
// of correctness than a single voice.
//
// Per ADR-0040 §"Decision 8" the bronze-tier acceptance target is
// ULP-distance ≤ 2 vs mpmath truncated to float64 (G3 = gold; this G4 = one
// of three bronze voices alongside G6 Boost-double and G7 libm).
//
// ---------------------------------------------------------------------------
// Complex-path Karbach derivation discipline
// ---------------------------------------------------------------------------
// SciPy *does* provide `sp.erf(complex)`, `sp.erfc(complex)`, `sp.erfcx(complex)`,
// and `sp.erfi(complex)` as direct calls (these wrap Faddeeva-Johnson's
// `Faddeeva::w`). However, the bronze-tier complex contract for this adapter
// is to expose the **single load-bearing primitive** `sp.wofz(z)` and derive
// the family algebraically per the **Karbach §2 / DLMF §7.4 identity table**
// (R2 §"Pick: Karbach-Weideman"). The justification is twofold:
//
//   1. Symmetry with the substrate's design (ADR-0040 §"Decision 3"): the
//      arb-prec layer's complex path is `bigW` with `bigCErf*` derived from
//      it; the bronze oracle exposes the same primitive shape. Any divergence
//      between the two layers in the future will localise to the derivation
//      identities, not to dual Faddeeva implementations.
//
//   2. Robust against scipy's internal dispatch (which may change between
//      versions or fall back to slower paths on edge inputs). `sp.wofz` is the
//      one entry point with stable semantics across SciPy releases.
//
// The Karbach identity table used here (all valid for the principal branch;
// see R2 §"Pick" and DLMF §7.4 — adopted verbatim from the spec):
//
//     erfcx(z) = w(iz)
//     erf(z)   = 1 − exp(−z²)·w(iz)     if Re(z) ≥ 0
//              = exp(−z²)·w(−iz) − 1    if Re(z) < 0
//     erfc(z)  = exp(−z²)·w(iz)         if Re(z) ≥ 0
//              = 2 − exp(−z²)·w(−iz)    if Re(z) < 0
//     erfi(z)  = −i · erf(iz)           (recursed through the same dispatch)
//
// The Re(z) sign split is the standard "use the better-conditioned half-plane"
// pattern — Faddeeva's `w(z)` is well-defined for all z, but on the
// half-plane Re(z) < 0 it grows as `2·exp(−z²)`, which would dominate the
// derivation by ratio-of-large-numbers. The mirrored form uses w(−iz) so the
// active half-plane stays bounded. Direct empirical check: at z = −1+1j the
// Karbach-derived `erf` matches scipy's direct `sp.erf(z)` bit-exactly.
//
// Overflow fallback (T4 / T7 high-|Im(z)| cases): when |Im(z)| ≳ 26 the
// Karbach factor exp(-z²) = exp(Im² − Re²) exceeds the float64 ceiling
// (~10^308) and the multiplication `expmz2 * w(...)` cannot be evaluated.
// The HONEST float64-tier answer in those regimes is whatever SciPy's
// *direct* dispatch produces — same Faddeeva-Johnson family, but with
// overflow-aware scaling baked into the C kernel. We catch the
// `OverflowError` in the Python side and fall back to `sp.erf` /
// `sp.erfc` / `sp.erfcx` / `sp.erfi` directly, annotating the record with
// `scipy.special.<head>-overflow-fallback` so G8 can grade those records
// against gold-tier oracles separately. This is *not* a different oracle,
// just a different code path inside SciPy; the bronze-tier provenance
// chain remains intact.
//
// ---------------------------------------------------------------------------
// Float64 lossless encoding: Python `repr()`
// ---------------------------------------------------------------------------
// Output values are emitted as Python's `repr(float)` — the shortest decimal
// string that round-trips bit-exactly to the same float64 (PEP 3101 / Python
// 3 `repr` since 3.1). NumPy `np.float64.__repr__` produces the same form. A
// downstream consumer that does `float(s)` recovers the exact 64-bit pattern
// SciPy returned. Non-finite values render as `"nan"` / `"inf"` / `"-inf"` by
// Python `repr`; we canonicalise these to the corpus's `"NaN"` / `"Infinity"`
// / `"-Infinity"` (matching `bench/erf-anchor/generate-corpus.ts::formatDecimal`)
// for cross-oracle equality in G8.
//
// ---------------------------------------------------------------------------
// Subnormal / normal-minimum / max-finite edge handling (T6)
// ---------------------------------------------------------------------------
// The corpus's `formatDecimal` collapses subnormal and smallest-normal inputs
// to `"0.000…"` strings (line 86 of `generate-corpus.ts`: only zero and finite
// values get full-precision toFixed). The actual value is encoded in the
// `notes` field as `"edge: smallest-positive-subnormal-2^-1074"` etc. This
// adapter honours the corpus-as-source-of-truth discipline (`DO NOT modify
// corpus.json`) and evaluates exactly the `z` field as written — so the
// subnormal T6 records will reflect `sp.erf(0.0) = 0.0`, not the true
// subnormal evaluation. The cross-oracle agreement matrix (G8) consumes
// the `notes` field and either grades these as "documented zero-collapse" or
// runs a separate sub-corpus through a parallel pipeline; that is G8's
// concern, not G4's.
//
// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------
// Each output record is uniform with the (expected) Wolfram / mpmath sibling
// adapters:
//
//   {
//     id: string,                  // copied from corpus input
//     head: string,                // copied
//     tier: string,                // copied
//     output:                      // bit-exact float64 round-trip
//       | "NaN" | "Infinity" | "-Infinity"
//       | string                   // real: Python repr(float)
//       | { re: string, im: string },  // complex: Python repr(complex.real / .imag)
//     method: string,              // "scipy.special-cephes" or "scipy.special.wofz-Faddeeva-Johnson"
//     achieved_precision: 53,      // float64 mantissa bits
//     oracle_id: "scipy",
//     oracle_version: string,      // scipy.__version__
//     numpy_version: string,       // numpy.__version__
//     elapsed_ms: number,          // per-record evaluation time
//   }
//
// Top-level metadata mirrors the corpus's `manifest_version` / `generated_at`
// pattern plus oracle-specific provenance (Python / SciPy / NumPy versions,
// platform fingerprint per ADR-0015 numerical: true).
//
// ---------------------------------------------------------------------------
// Process model
// ---------------------------------------------------------------------------
// Single `python3` subprocess. The TS wrapper writes a self-contained Python
// program to stdin (heredoc-style — no external `.py` file pollutes the
// directory; the algorithm narrative for both sides lives in this file). The
// Python program reads the corpus JSON from a file path passed via argv,
// loops over the inputs, and writes the result JSON to stdout. We capture
// stdout, validate JSON-parseable, and write to `results.json`.
//
// This is *not* a Bun tool (no `defineTool`, no schema-validated wire). It is
// a bench script that emits a frozen golden-master artefact. Therefore no
// `spawnBun` is needed (that helper is for Bun-to-Bun composition through the
// snap-mount-namespace; we are spawning Python and Bun's normal child_process
// suffices). The script itself is invoked with `bun bench/.../adapter.ts`.
//
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";

// -----------------------------------------------------------------------------
// Branded types — clarity at zero runtime cost.
// -----------------------------------------------------------------------------

/** A decimal string verbatim from the corpus (60 digits past the point, or "NaN"/"Infinity"/"-Infinity"). */
type CorpusReal = string;
/** A bit-exact float64 round-trip string from Python repr, or the canonical non-finite tokens. */
type Float64String = string;

interface CorpusRealInput {
  readonly id: string;
  readonly tier: string;
  readonly head: "Erf" | "Erfc" | "Erfcx" | "Erfi" | "InverseErf" | "InverseErfc";
  readonly z: CorpusReal;
  readonly notes?: string;
}
interface CorpusComplexInput {
  readonly id: string;
  readonly tier: string;
  readonly head: "Erf" | "Erfc" | "Erfcx" | "Erfi";
  readonly z: { readonly re: CorpusReal; readonly im: CorpusReal };
  readonly notes?: string;
}
type CorpusInput = CorpusRealInput | CorpusComplexInput;

interface CorpusFile {
  readonly manifest_version: number;
  readonly generated_at: string;
  readonly bead: string;
  readonly inputs: readonly CorpusInput[];
}

interface OracleRecord {
  readonly id: string;
  readonly head: string;
  readonly tier: string;
  readonly output: Float64String | { re: Float64String; im: Float64String };
  readonly method: string;
  readonly achieved_precision: 53;
  readonly oracle_id: "scipy";
  readonly oracle_version: string;
  readonly numpy_version: string;
  readonly elapsed_ms: number;
}

interface OracleFile {
  readonly manifest_version: 1;
  readonly generated_at: string;
  readonly bead: "scientist-workbench-1f8r";
  readonly oracle_id: "scipy";
  readonly oracle_version: string;
  readonly numpy_version: string;
  readonly python_version: string;
  readonly platform: { arch: string; os: string; runtime: string };
  readonly corpus_bead: string;
  readonly corpus_manifest_version: number;
  readonly corpus_generated_at: string;
  readonly totals: { records: number; real: number; complex: number };
  readonly results: readonly OracleRecord[];
}

// -----------------------------------------------------------------------------
// Python program — embedded as a string template; parameterised by argv-passed
// corpus path. Single-process batch evaluation per R5 §"Batching note" (Python
// cold-start ~200 ms; per-call overhead would dominate without batching).
// -----------------------------------------------------------------------------

const PYTHON_PROGRAM = String.raw`
import sys, json, time, math, cmath
import scipy
import scipy.special as sp
import numpy as np

# ---------------------------------------------------------------------------
# Parse a corpus real string into a Python float. Accepts the non-finite
# canonical tokens emitted by bench/erf-anchor/generate-corpus.ts:
# "NaN", "Infinity", "-Infinity"; otherwise plain decimal (toFixed-60 style)
# which float() parses losslessly (more digits than float64 carries; the
# upper ~16 digits determine the float64 round-to-nearest).
# ---------------------------------------------------------------------------
def parse_real(s):
    if s == "NaN":
        return float("nan")
    if s == "Infinity":
        return float("inf")
    if s == "-Infinity":
        return float("-inf")
    return float(s)

# ---------------------------------------------------------------------------
# repr_real / repr_complex — emit the float64 lossless round-trip strings
# the TS wrapper expects. Python's repr(float) is the shortest decimal that
# parses back to the same double (since Python 3.1 / PEP 3101). We canonicalise
# the non-finite tokens to match the corpus convention ("NaN"/"Infinity"/
# "-Infinity") so the G8 cross-oracle agreement matrix can compare strings.
# ---------------------------------------------------------------------------
def repr_real(x):
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    return repr(x)

def repr_complex(z):
    return {"re": repr_real(z.real), "im": repr_real(z.imag)}

# ---------------------------------------------------------------------------
# Karbach / DLMF §7.4 derivation from the single wofz primitive. The Re(z)
# sign split ensures the active half-plane stays bounded (Re(z) < 0 would
# blow up exp(-z²) · w(z); using w(-iz) reflects to the bounded side).
#
# The complex literal "-z.imag + z.real*1j" is i·z; "z.imag - z.real*1j"
# is -i·z. Using these forms (rather than 1j*z / -1j*z) avoids the spurious
# minus-zero artefacts that complex-by-imaginary multiplication can spawn
# in CPython (cmath: -0.0 ± 0j flips sign under some kernels). Both produce
# bit-identical real components for the corpus's input ranges; for the
# T4 pure-imag-axis the explicit form is the cleaner audit trail.
# ---------------------------------------------------------------------------
def karb_erfcx(z):
    # erfcx(z) = w(i z)
    return sp.wofz(complex(-z.imag, z.real))

def karb_erf(z):
    expmz2 = cmath.exp(-z * z)
    if z.real >= 0.0:
        # erf(z) = 1 - exp(-z²) · w(i z)
        return 1.0 - expmz2 * sp.wofz(complex(-z.imag, z.real))
    # erf(z) = exp(-z²) · w(-i z) - 1
    return expmz2 * sp.wofz(complex(z.imag, -z.real)) - 1.0

def karb_erfc(z):
    expmz2 = cmath.exp(-z * z)
    if z.real >= 0.0:
        return expmz2 * sp.wofz(complex(-z.imag, z.real))
    return 2.0 - expmz2 * sp.wofz(complex(z.imag, -z.real))

def karb_erfi(z):
    # erfi(z) = -i · erf(i z); recurse into karb_erf so the active-half-plane
    # split applies to i·z (which can land in either half-plane depending on
    # sign(z.imag)).
    iz = complex(-z.imag, z.real)
    e = karb_erf(iz)
    # multiply by -i: (-i)·(a+bi) = b - a·i
    return complex(e.imag, -e.real)

# ---------------------------------------------------------------------------
# Per-head evaluation, real branch (scipy.special wraps Cephes directly).
# ---------------------------------------------------------------------------
def eval_real(head, x):
    if head == "Erf":         return sp.erf(x)
    if head == "Erfc":        return sp.erfc(x)
    if head == "Erfcx":       return sp.erfcx(x)
    if head == "Erfi":        return sp.erfi(x)
    if head == "InverseErf":  return sp.erfinv(x)
    if head == "InverseErfc": return sp.erfcinv(x)
    raise ValueError(f"unknown head: {head}")

# ---------------------------------------------------------------------------
# Per-head evaluation, complex branch (Karbach derivations from sp.wofz). The
# inverse heads (InverseErf, InverseErfc) intentionally do NOT have a complex
# path; SciPy's erfinv/erfcinv are real-only and no canonical multi-valued
# Riemann-surface representation exists in the literature (ADR-0040 §"What we
# will not decide here" — the inverse-erf complex evaluator is honestly
# refused). The corpus does not emit complex inverse inputs; this is enforced
# by the corpus generator (generate-corpus.ts T8 only emits real inputs).
#
# Overflow-fallback discipline (T4 pure-imag y ~ 30, T7 Stokes-band |Im(z)| ~
# 30): the Karbach factor exp(-z²) = exp(Im² - Re²) overflows float64 (peak
# input lands at ~exp(900) ≈ 1.9e+390 vs the 1.8e+308 ceiling) and the product
# 'expmz2 * w(...)' becomes inf*finite = inf, losing the saturation pattern.
# The HONEST float64-tier answer in those cases is whatever scipy's *direct*
# dispatch produces — which uses Faddeeva-Johnson's overflow-aware scaling in
# the C kernel (same family, different code path). We catch OverflowError on
# the Karbach path and fall back to the direct call, annotating the record
# with a distinct method tag ('scipy.special.<head>-overflow-fallback') so the
# G8 cross-oracle agreement matrix can grade these separately. Both paths are
# scipy / Cephes / Faddeeva-Johnson lineage; the fallback is not a different
# oracle, just a different code path inside SciPy.
#
# Returns (value, method_tag).
# ---------------------------------------------------------------------------
def eval_complex(head, z):
    try:
        if head == "Erf":   return (karb_erf(z),   "scipy.special.wofz-Faddeeva-Johnson")
        if head == "Erfc":  return (karb_erfc(z),  "scipy.special.wofz-Faddeeva-Johnson")
        if head == "Erfcx": return (karb_erfcx(z), "scipy.special.wofz-Faddeeva-Johnson")
        if head == "Erfi":  return (karb_erfi(z),  "scipy.special.wofz-Faddeeva-Johnson")
        raise ValueError(f"complex path not defined for head: {head}")
    except OverflowError:
        if head == "Erf":   return (sp.erf(z),   "scipy.special.erf-overflow-fallback")
        if head == "Erfc":  return (sp.erfc(z),  "scipy.special.erfc-overflow-fallback")
        if head == "Erfcx": return (sp.erfcx(z), "scipy.special.erfcx-overflow-fallback")
        if head == "Erfi":  return (sp.erfi(z),  "scipy.special.erfi-overflow-fallback")
        raise

# ---------------------------------------------------------------------------
# Batch driver.
# ---------------------------------------------------------------------------
def main():
    corpus_path = sys.argv[1]
    with open(corpus_path, "r") as f:
        corpus = json.load(f)

    results = []
    for inp in corpus["inputs"]:
        head = inp["head"]
        tier = inp["tier"]
        iid  = inp["id"]
        z    = inp["z"]

        t0 = time.perf_counter_ns()
        try:
            if isinstance(z, str):
                # Real input.
                x = parse_real(z)
                y = eval_real(head, x)
                output = repr_real(float(y))
                method = "scipy.special-cephes"
            else:
                # Complex input: {re, im}. eval_complex returns (value, method)
                # so the overflow-fallback path can advertise its provenance.
                re = parse_real(z["re"])
                im = parse_real(z["im"])
                y, method = eval_complex(head, complex(re, im))
                output = repr_complex(y)
        except Exception as e:
            # Loud failure — emit a record with a sentinel error tag rather
            # than silently dropping. The TS wrapper logs and exits 1 if any
            # record carries an error.
            output = {"error": f"{type(e).__name__}: {e}"}
            method = "error"

        t1 = time.perf_counter_ns()
        elapsed_ms = (t1 - t0) / 1e6

        results.append({
            "id": iid,
            "head": head,
            "tier": tier,
            "output": output,
            "method": method,
            "achieved_precision": 53,
            "oracle_id": "scipy",
            "oracle_version": scipy.__version__,
            "numpy_version": np.__version__,
            "elapsed_ms": elapsed_ms,
        })

    json.dump({
        "scipy_version": scipy.__version__,
        "numpy_version": np.__version__,
        "python_version": sys.version,
        "records": results,
    }, sys.stdout)

if __name__ == "__main__":
    main()
`;

// -----------------------------------------------------------------------------
// Python subprocess invocation. We pass the program on stdin (no temp file)
// and the corpus path as argv. We capture stdout for the JSON payload and
// stderr for diagnostic lines (any Python warnings, traceback fragments).
// -----------------------------------------------------------------------------

function runPython(scriptSrc: string, corpusPath: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-", corpusPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`python3 exited with code ${code}\nstderr:\n${stderr}`));
    });
    child.stdin.write(scriptSrc);
    child.stdin.end();
  });
}

// -----------------------------------------------------------------------------
// Main driver.
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusPath = join(here, "..", "..", "corpus.json");
  const outPath = join(here, "results.json");

  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: CorpusFile = JSON.parse(corpusRaw);

  console.error(`[scipy-adapter] corpus: ${corpusPath} (${corpus.inputs.length} inputs)`);
  console.error(`[scipy-adapter] spawning python3 with embedded SciPy program ...`);

  const t0 = performance.now();
  const { stdout, stderr } = await runPython(PYTHON_PROGRAM, corpusPath);
  const elapsedMs = performance.now() - t0;

  if (stderr.trim().length > 0) {
    console.error(`[scipy-adapter] python stderr:\n${stderr}`);
  }

  const py: {
    scipy_version: string;
    numpy_version: string;
    python_version: string;
    records: OracleRecord[];
  } = JSON.parse(stdout);

  // Loud-fail discipline: if any per-record evaluation errored, surface it.
  const errors = py.records.filter((r) => r.method === "error");
  if (errors.length > 0) {
    console.error(`[scipy-adapter] ${errors.length} per-record errors:`);
    for (const e of errors.slice(0, 5)) {
      console.error(`  ${e.id}: ${JSON.stringify(e.output)}`);
    }
    throw new Error(`${errors.length} records failed; adapter aborting.`);
  }

  const totals = {
    records: py.records.length,
    real: py.records.filter((r) => typeof r.output === "string").length,
    complex: py.records.filter((r) => typeof r.output === "object").length,
  };

  const oracleFile: OracleFile = {
    manifest_version: 1,
    generated_at: new Date().toISOString(),
    bead: "scientist-workbench-1f8r",
    oracle_id: "scipy",
    oracle_version: py.scipy_version,
    numpy_version: py.numpy_version,
    python_version: py.python_version,
    platform: { arch: arch(), os: platform(), runtime: `bun-${Bun.version}` },
    corpus_bead: corpus.bead,
    corpus_manifest_version: corpus.manifest_version,
    corpus_generated_at: corpus.generated_at,
    totals,
    results: py.records,
  };

  writeFileSync(outPath, JSON.stringify(oracleFile, null, 2) + "\n");

  console.error(
    `[scipy-adapter] wrote ${outPath}: ${totals.records} records ` +
    `(${totals.real} real, ${totals.complex} complex), ` +
    `${elapsedMs.toFixed(1)} ms total.`
  );
}

if (import.meta.main) {
  void main();
}
