// =============================================================================
// bench/besselj-anchor/oracles/scipy/adapter.ts — SciPy bronze-tier oracle adapter
// =============================================================================
//
// Bead: scientist-workbench-qvnm (G4 — SciPy oracle adapter, bronze tier float64
// for the Bessel J / Y / I / K family + scaled I and K variants).
// Phase 1 bead under epic scientist-workbench-zcam (per ADR-0041, the per-head
// substrate applied to the canonical Bessel family). Consumes the canonical
// `bench/besselj-anchor/corpus.json` (G1 / bead `qccc`; 1766 inputs across 10
// tiers, 6 heads, 3 ν-classes) and produces `bench/besselj-anchor/oracles/
// scipy/results.json` — the float64-tier reference values the in-substrate
// `besselJFloat64` / `besselYFloat64` / `besselIFloat64` / `besselKFloat64` /
// `besselIScaledFloat64` / `besselKScaledFloat64` evaluators (Phase 2 beads
// I5a / I3a / I3b in the parlance of ADR-0041 §Decision 10) will be graded
// against.
//
// ---------------------------------------------------------------------------
// Tier role: BRONZE (float64). SciPy is NOT an arb-prec voice.
// ---------------------------------------------------------------------------
// Per ADR-0041 §"Decision 8" the bronze-tier acceptance target is
// ULP-distance ≤ 2 vs gold (Wolfram + mpmath + Arb truncated to float64).
// SciPy 1.17 ships the canonical wrapper over Donald Amos's TOMS 644 Fortran
// suite (`zbesj.f` / `zbesy.f` / `zbesi.f` / `zbesk.f` plus ~30 callees) for
// general-ν via `scipy.special.{jv, yv, iv, kv}`; integer-ν specialisations
// (`j0`/`j1`/`jn`/`y0`/`y1`/`yn`) wrap Stephen Moshier's Cephes
// (`scipy/special/cephes/j0.c` etc.). Both lineages carry libm-grade DNA but
// are independent code from the in-substrate ports the workbench will ship
// (musl SunPro for integer-ν J/Y per R3; Boost `i0`/`i1`/Holoborodko for I;
// Cephes `k0`/`k1` for K; Boost `bessel_jy.hpp` for general-ν J/Y via Steed
// CF1+CF2 + Temme; SciPy's `ikv_temme` for general-ν I/K). Independence is
// what makes a joint AMOS↔in-substrate 2-ULP agreement on the corpus strong
// evidence of correctness rather than mere shared-bug agreement.
//
// SciPy is the only bronze voice with **complex-z** support on this machine
// (libm covers j0/j1/jn/y0/y1/yn real-only; Boost `<double>` template-fails
// on `std::complex<double>` identically to the cpp_bin_float<N> case — Erf R5
// §1, Bessel R5 §3.4). Therefore SciPy carries the entire bronze-tier 12-cell
// complex axis of the (4 heads × 3 ν-classes × {real, complex}) matrix.
//
// ---------------------------------------------------------------------------
// L5 / L9 / L10 — boundary-value flagging discipline
// ---------------------------------------------------------------------------
// Three SciPy-specific landmines from R5 §6 are pinned in this adapter as
// distinct `status: "limit"` records (vs the normal `status: "success"`):
//
//   • **L5** — `scipy.special.jv(ν, z)` silently underflows to `0.0` or
//     overflows to `inf` (and `jv(ν, ±inf)` returns `nan`) at large `ν + z`
//     without raising. The corpus deliberately probes this in tiers T6
//     (`z = ±∞`, `NaN`), T7 (large-ν Debye), and T10 (large-ν integer with
//     small z; documented as "J/I underflow when z << ν; Y/K overflow"). The
//     adapter does NOT treat these as errors — they are the genuine float64
//     limit of representation, and AMOS's silent boundary is its documented
//     contract. We flag them so the G8 cross-agreement comparator can grade
//     them against gold under an absolute-error band rather than a relative-
//     error band (relative error of `0.0` vs gold's `1e-380` is `1`; absolute
//     error is `1e-380` ≪ float64 precision floor).
//
//   • **L9** — `scipy.special.kv(ν, z)` underflows at `z > 700` (because
//     `K_ν(z) ~ √(π/2z)·e^{-z}` shrinks past `2^-1074 ≈ 5e-324`). The
//     **scaled** variant `kve(ν, z) = e^z · K_ν(z)` is the load-bearing
//     mitigation — it stays in normal float64 range — and the corpus has 20
//     `BesselKScaled` inputs in T3 specifically to validate that path. We
//     still emit the unscaled `kv` value (with `status: "limit"`) at large z
//     for completeness of the cross-oracle comparison.
//
//   • **L10** — `scipy.special.iv(ν, z)` overflows at `z > 700` (because
//     `I_ν(z) ~ e^z / √(2πz)` blows past `1.8e308`). Mirror situation: the
//     **scaled** variant `ive(ν, z) = e^{-|z|} · I_ν(z)` stays in range, and
//     the corpus has 20 `BesselIScaled` inputs in T3 to exercise it.
//
// The L9/L10 *flag* fires when the bronze answer is at the float64 underflow
// (`|result| ≤ 2 · DBL_MIN ≈ 4.5e-308`) or overflow (`|result| ≥ DBL_MAX/2 ≈
// 9.0e+307`) boundary AND the corpus tier is one of {T6, T7, T10} where this
// is expected per the corpus generator's annotations. Outside those tiers a
// boundary hit would be unexpected and lands as `status: "success"` (with the
// boundary value still emitted faithfully); G8 can then surface it as a
// finding. Note that **scaled variants can ALSO hit the boundary** at
// extreme ν+z combinations — e.g. `ive(500, 1) = 0.0` because `exp(-1) · I_500(1)`
// is sub-subnormal, and `kve(500, 1) = inf` because the scaling factor only
// cancels the dominant exponential, not the polynomial-in-ν growth. The
// flagging applies uniformly across scaled and unscaled.
//
// The flag carries the actual SciPy-returned value (`scipy_returned` field)
// alongside a `notes` string explaining the regime. The G8 comparator
// consumes `status: "limit"` records under L7 (zero-band) and L5/L9/L10
// (boundary-band) tolerance branches; this is G8's concern, not G4's.
//
// ---------------------------------------------------------------------------
// Real-input-with-zero-imaginary-part discipline (R5 §3.5 — observed quirk)
// ---------------------------------------------------------------------------
// R5 §3.5 documents a measurable accuracy delta: `sp.iv(0.5, 3+0j)` returns
// `4.614822903407577` (3 ULP off gold) while `sp.iv(0.5, 3)` returns
// `4.614822903407602` (gold-exact at float64). The complex-input AMOS
// recurrence is less accurate than the real-input Cephes/AMOS path on the
// pure-real axis. The adapter ALWAYS calls the real-input branch when the
// corpus input is a plain decimal string `z`; the complex branch is only
// invoked when the input is a `{re, im}` dict. (The corpus's `T5` tier is
// the only one emitting complex inputs; T1–T4, T6–T10 are all real.)
//
// ---------------------------------------------------------------------------
// ν parsing — three corpus formats per `nu_kind`
// ---------------------------------------------------------------------------
//
//   • `nu_kind: "integer"` ⇒ `nu` is a base-10 integer string (e.g. `"0"`,
//     `"3"`, `"-2"`, `"500"`). Parsed as Python `int`, then passed to scipy
//     as `float(int_value)` for uniform dispatch. (SciPy's `jv` etc. accept
//     any numeric type; using `float` rather than `int` keeps the call
//     uniform with the half-int and decimal cases — algorithmically scipy
//     dispatches identically since float ν of integer value triggers the
//     same integer-ν code path as int ν.)
//
//   • `nu_kind: "half-integer"` ⇒ `nu` is a rational `"a/b"` string with
//     `b ∈ {2}` and `a` odd (e.g. `"1/2"`, `"3/2"`, `"-5/2"`, `"7/2"`).
//     Parsed by splitting on `/` and computing `float(num) / float(den)`.
//     SciPy then dispatches to its general-ν AMOS path; the half-integer
//     closed-form `J_{n+1/2}(z) = √(2/πz) · (something elementary)` is not
//     used by scipy in our parameter range, but the AMOS path is accurate
//     to ≤ 2 ULP for the corpus's half-int sample (R5 §3.5 capability).
//
//   • `nu_kind: "decimal"` ⇒ `nu` is a 60-digit decimal string (e.g.
//     `"1.699999999999999955591..."`). Parsed by Python `float()` — the
//     trailing digits past float64 mantissa precision are silently
//     truncated by round-to-nearest, which is the honest bronze-tier
//     behaviour. The corpus emits 60 digits to make the underlying double
//     unambiguous when reading back; the adapter's parse-then-evaluate
//     reproduces what an in-substrate float64 evaluator would compute on
//     the same input.
//
// ---------------------------------------------------------------------------
// Float64 lossless encoding: Python `repr()`
// ---------------------------------------------------------------------------
// Output values render via Python's `repr(float)` — the shortest decimal
// string that round-trips bit-exactly to the same float64 (PEP 3101 / Python
// 3 `repr` since 3.1; identical to NumPy's `np.float64.__repr__`). A
// downstream consumer that does `Number(s)` (JS) or `float(s)` (Python)
// recovers the exact 64-bit pattern SciPy returned. Non-finite values render
// as `"NaN"` / `"Infinity"` / `"-Infinity"` (canonicalised to the corpus
// generator's tokens — see `bench/besselj-anchor/generate-corpus.ts`).
//
// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------
//
//   {
//     id: string,                  // copied from corpus input
//     head: string,                // copied
//     tier: string,                // copied
//     nu_kind: string,             // copied (for downstream method-tag tally)
//     status: "success" | "limit" | "error",
//     value:                       // bit-exact float64 round-trip; absent on error
//       | "NaN" | "Infinity" | "-Infinity"
//       | string                   // real result: Python repr(float)
//       | { re: string, im: string },  // complex result
//     scipy_returned?: ...,        // present iff status="limit"; same shape as `value`
//     method: string,              // "scipy.special.jv" etc., or "...-limit-boundary"
//     elapsed_ms: number,          // per-record evaluation time
//     notes: string | null,        // explanation when status≠"success"
//   }
//
// Top-level metadata carries oracle provenance (Python / SciPy / NumPy
// versions, platform fingerprint per ADR-0015 numerical: true).
//
// ---------------------------------------------------------------------------
// Process model
// ---------------------------------------------------------------------------
// Single `python3` subprocess (per the Mission's "One subprocess call total"
// requirement). The TS wrapper writes a self-contained Python program to
// stdin (heredoc-style — no external `.py` file pollutes the directory; the
// algorithm narrative for both sides lives in this single file). The Python
// program reads the corpus JSON from a file path passed via argv, batch-
// evaluates all 1766 inputs, and writes the result JSON to stdout. The TS
// side captures stdout, validates JSON-parseable, and writes
// `results.json`.
//
// This is NOT a Bun tool (no `defineTool`, no schema-validated wire). It is
// a bench script that emits a frozen golden-master artefact. Bun.spawn (the
// modern child_process replacement) is used; spawnBun is not relevant here
// since we are spawning Python, not Bun.
//
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";

// -----------------------------------------------------------------------------
// Branded types — clarity at zero runtime cost.
// -----------------------------------------------------------------------------

/** Decimal string verbatim from the corpus (60 digits past the point, or "NaN"/"Infinity"/"-Infinity"). */
type CorpusReal = string;
/** Bit-exact float64 round-trip string from Python repr, or the canonical non-finite tokens. */
type Float64String = string;

type BesselHead =
  | "BesselJ"
  | "BesselY"
  | "BesselI"
  | "BesselK"
  | "BesselIScaled"
  | "BesselKScaled";

interface CorpusInput {
  readonly id: string;
  readonly tier: string;
  readonly head: BesselHead;
  readonly nu_kind: "integer" | "half-integer" | "decimal";
  readonly nu: string;
  readonly z: CorpusReal | { readonly re: CorpusReal; readonly im: CorpusReal };
  readonly notes?: string;
}

interface CorpusFile {
  readonly manifest_version: number;
  readonly generated_at: string;
  readonly bead: string;
  readonly adr: string;
  readonly seed: number;
  readonly inputs: readonly CorpusInput[];
}

type OracleValue = Float64String | { re: Float64String; im: Float64String };

interface OracleRecord {
  readonly id: string;
  readonly head: string;
  readonly tier: string;
  readonly nu_kind: string;
  readonly status: "success" | "limit" | "error";
  readonly value?: OracleValue;
  readonly scipy_returned?: OracleValue;
  readonly method: string;
  readonly elapsed_ms: number;
  readonly notes: string | null;
}

interface OracleFile {
  readonly oracle_id: "scipy";
  readonly oracle_version: string;            // composite "SciPy X / Python Y / NumPy Z"
  readonly scipy_version: string;
  readonly numpy_version: string;
  readonly python_version: string;
  readonly generated_at: string;
  readonly bead: "scientist-workbench-qvnm";
  readonly corpus_bead: string;
  readonly corpus_manifest_version: number;
  readonly corpus_generated_at: string;
  readonly corpus_seed: number;
  readonly tier: "bronze";
  readonly precision_emit: "float64 (Python repr; shortest round-trip)";
  readonly platform: { arch: string; os: string; runtime: string };
  readonly totals: {
    records: number;
    success: number;
    limit: number;
    error: number;
    real_inputs: number;
    complex_inputs: number;
  };
  readonly results: readonly OracleRecord[];
}

// -----------------------------------------------------------------------------
// Python program — embedded as a string template; parameterised by argv-passed
// corpus path. Single-process batch evaluation per R5 §3.5 (Python cold-start
// ~220 ms; per-call overhead would dominate at 1766 records without batching).
// Expected wall-time: ~30 s (≈ 80 µs/record warm × 1766 + 0.22 s boot).
// -----------------------------------------------------------------------------

const PYTHON_PROGRAM = String.raw`
import sys, json, math, time
import scipy
import scipy.special as sp
import numpy as np

# ---------------------------------------------------------------------------
# Float64 limit-of-representation thresholds (IEEE 754 binary64).
# ---------------------------------------------------------------------------
DBL_MIN     = sys.float_info.min        # 2.225e-308 — smallest normal positive
DBL_MAX     = sys.float_info.max        # 1.798e+308 — largest finite positive
UNDERFLOW_THRESHOLD = 2.0 * DBL_MIN     # ~4.45e-308; below this is "limit-band"
OVERFLOW_THRESHOLD  = 0.5 * DBL_MAX     # ~8.99e+307; above this is "limit-band"

# Tiers where boundary-hitting (jv/iv/kv saturating at the float64 envelope)
# is documented as expected behaviour per the corpus generator's tier
# descriptions (mirrored from the corpus's tier_descriptions block):
#
#   T6  — edges ±0, ±∞, NaN, subnormal, 700-boundary
#   T7  — high-ν Debye ν ∈ [50, 500] × |z| ∈ ν·[0.5, 2]
#   T10 — large-ν integer overflow/underflow boundary
LIMIT_EXPECTED_TIERS = {"T6", "T7", "T10"}

# ---------------------------------------------------------------------------
# Parse a corpus real-decimal string into a Python float. Accepts the
# non-finite canonical tokens emitted by bench/besselj-anchor/generate-
# corpus.ts: "NaN", "Infinity", "-Infinity"; otherwise a plain decimal
# (60-digit toFixed-style) which float() parses with round-to-nearest. The
# extra ~44 digits past float64 precision are silently truncated — that is
# the honest bronze-tier behaviour (an in-substrate float64 evaluator would
# do the same), and the corpus's 60-digit emission is for downstream
# disambiguation, not for representable precision.
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
# Parse ν per the corpus's three nu_kind classes:
#   integer        — "0", "3", "-2", "500"
#   half-integer   — "1/2", "3/2", "-5/2", "7/2"  (rational a/b with b=2)
#   decimal        — "1.69999...", 60-digit string
# All return Python float. SciPy's jv/yv/iv/kv accept any numeric type and
# dispatch the same integer-ν code path on float-of-integer-value as on int
# ν, so the float-uniform call shape introduces no accuracy penalty.
# ---------------------------------------------------------------------------
def parse_nu(nu_str, nu_kind):
    if nu_kind == "integer":
        return float(int(nu_str))
    if nu_kind == "half-integer":
        num_s, den_s = nu_str.split("/")
        return float(num_s) / float(den_s)
    if nu_kind == "decimal":
        return float(nu_str)
    raise ValueError(f"unknown nu_kind: {nu_kind!r}")

# ---------------------------------------------------------------------------
# repr_real / repr_complex — emit the float64 lossless round-trip strings
# the TS wrapper expects. Python's repr(float) is the shortest decimal that
# parses back to the same double (since Python 3.1 / PEP 3101). We
# canonicalise the non-finite tokens to match the corpus convention
# ("NaN"/"Infinity"/"-Infinity") so the G8 cross-oracle agreement matrix can
# compare strings.
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
# Per-head SciPy dispatch. Real branch uses the float-ν, float-z entry
# points (AMOS for general-ν, Cephes specialisations for integer-ν 0/1 of
# J/Y). Complex branch passes a Python complex; SciPy routes through the
# AMOS Fortran complex paths (zbesj/zbesy/zbesi/zbesk).
#
# R5 §3.5 documents that for inputs that happen to be real-with-zero-im,
# the COMPLEX-input AMOS path is up to 3 ULP less accurate than the
# REAL-input AMOS/Cephes path (the example: iv(0.5, 3+0j) returns
# 4.614822903407577 while iv(0.5, 3) returns 4.614822903407602 — gold-exact).
# The adapter dispatches on the WIRE shape of z: a string z (real) goes to
# eval_real; a {re, im} z goes to eval_complex. The corpus's T5 tier is the
# only one with complex z; T1-T4, T6-T10 are all real strings.
# ---------------------------------------------------------------------------
def eval_real(head, nu, x):
    if head == "BesselJ":         return sp.jv(nu, x), "scipy.special.jv"
    if head == "BesselY":         return sp.yv(nu, x), "scipy.special.yv"
    if head == "BesselI":         return sp.iv(nu, x), "scipy.special.iv"
    if head == "BesselK":         return sp.kv(nu, x), "scipy.special.kv"
    if head == "BesselIScaled":   return sp.ive(nu, x), "scipy.special.ive"
    if head == "BesselKScaled":   return sp.kve(nu, x), "scipy.special.kve"
    raise ValueError(f"unknown head: {head}")

def eval_complex(head, nu, z):
    if head == "BesselJ":         return sp.jv(nu, z), "scipy.special.jv"
    if head == "BesselY":         return sp.yv(nu, z), "scipy.special.yv"
    if head == "BesselI":         return sp.iv(nu, z), "scipy.special.iv"
    if head == "BesselK":         return sp.kv(nu, z), "scipy.special.kv"
    if head == "BesselIScaled":   return sp.ive(nu, z), "scipy.special.ive"
    if head == "BesselKScaled":   return sp.kve(nu, z), "scipy.special.kve"
    raise ValueError(f"unknown head: {head}")

# ---------------------------------------------------------------------------
# Limit-boundary detection per L5 / L9 / L10. A "limit" status fires when:
#   • result is non-finite (nan / ±inf) AND the corpus tier expects it, OR
#   • |result| is within the underflow / overflow band AND the corpus tier
#     expects it.
# Returns (is_limit, reason_str) where reason_str describes the regime.
# ---------------------------------------------------------------------------
def detect_limit_real(x, tier):
    if tier not in LIMIT_EXPECTED_TIERS:
        return (False, None)
    if math.isnan(x):
        return (True, "L5 NaN at expected tier")
    if math.isinf(x):
        return (True, "L9/L10 overflow at expected tier" if x > 0 else "L9/L10 negative-overflow at expected tier")
    ax = abs(x)
    if ax == 0.0:
        return (True, "L5/L9 underflow to zero at expected tier")
    if ax < UNDERFLOW_THRESHOLD:
        return (True, f"L5/L9 subnormal underflow band ({ax:.3e}) at expected tier")
    if ax > OVERFLOW_THRESHOLD:
        return (True, f"L10 overflow band ({ax:.3e}) at expected tier")
    return (False, None)

def detect_limit_complex(z, tier):
    if tier not in LIMIT_EXPECTED_TIERS:
        return (False, None)
    # Treat the complex case as the max-modulus boundary check on either
    # component (a complex result with one component saturated is a limit
    # case regardless of the other component's magnitude).
    re_lim, re_why = detect_limit_real(z.real, tier)
    im_lim, im_why = detect_limit_real(z.imag, tier)
    if re_lim or im_lim:
        return (True, re_why or im_why)
    return (False, None)

# ---------------------------------------------------------------------------
# Batch driver — single Python invocation across all 1766 corpus inputs.
# Each record emits in order; a per-record exception is caught and surfaced
# as a status="error" record (loud-fail discipline; the TS wrapper logs and
# does NOT abort on a non-zero error count — the bronze-tier acceptance
# criterion is ≥ 95% success per the Mission, not 100%).
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
        nu_kind = inp["nu_kind"]
        nu_str  = inp["nu"]
        z       = inp["z"]

        t0 = time.perf_counter_ns()
        record = {
            "id": iid,
            "head": head,
            "tier": tier,
            "nu_kind": nu_kind,
        }
        try:
            nu = parse_nu(nu_str, nu_kind)

            if isinstance(z, str):
                # Real input — call the real-arg dispatch per R5 §3.5
                # ULP-divergence discipline.
                x = parse_real(z)
                y, method = eval_real(head, nu, x)
                # SciPy may return numpy scalar; force pure float for repr.
                y = float(y)
                is_limit, why = detect_limit_real(y, tier)
                value_str = repr_real(y)
                if is_limit:
                    record["status"] = "limit"
                    record["value"] = value_str
                    record["scipy_returned"] = value_str
                    record["method"] = method + "-limit-boundary"
                    record["notes"] = why
                else:
                    record["status"] = "success"
                    record["value"] = value_str
                    record["method"] = method
                    record["notes"] = None
            else:
                # Complex input ({re, im} dict).
                re = parse_real(z["re"])
                im = parse_real(z["im"])
                zc = complex(re, im)
                yc, method = eval_complex(head, nu, zc)
                yc = complex(yc)
                is_limit, why = detect_limit_complex(yc, tier)
                value_obj = repr_complex(yc)
                if is_limit:
                    record["status"] = "limit"
                    record["value"] = value_obj
                    record["scipy_returned"] = value_obj
                    record["method"] = method + "-limit-boundary"
                    record["notes"] = why
                else:
                    record["status"] = "success"
                    record["value"] = value_obj
                    record["method"] = method
                    record["notes"] = None
        except Exception as e:
            # Loud-fail at the record level: emit a structured error record
            # rather than dropping silently. The TS wrapper tallies these
            # and prints a summary; non-zero error count is a *warning*, not
            # an abort, since the bronze-tier acceptance is ≥ 95% success.
            record["status"] = "error"
            record["method"] = "error"
            record["notes"] = f"{type(e).__name__}: {e}"

        t1 = time.perf_counter_ns()
        record["elapsed_ms"] = (t1 - t0) / 1e6
        results.append(record)

    json.dump({
        "scipy_version": scipy.__version__,
        "numpy_version": np.__version__,
        "python_version": sys.version.split()[0],
        "records": results,
    }, sys.stdout)

if __name__ == "__main__":
    main()
`;

// -----------------------------------------------------------------------------
// Python subprocess invocation via Bun.spawn. The program is piped on stdin
// (no temp file); the corpus path goes via argv. stdout is captured for the
// JSON payload; stderr is captured for diagnostic lines (Python warnings,
// traceback fragments) and surfaced on the host stderr if non-empty.
// -----------------------------------------------------------------------------

async function runPython(scriptSrc: string, corpusPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["python3", "-", corpusPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(scriptSrc);
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
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

  console.error(`[scipy-besselj-adapter] corpus: ${corpusPath} (${corpus.inputs.length} inputs)`);
  console.error(`[scipy-besselj-adapter] spawning python3 with embedded SciPy program ...`);

  const t0 = performance.now();
  const { stdout, stderr, exitCode } = await runPython(PYTHON_PROGRAM, corpusPath);
  const elapsedMs = performance.now() - t0;

  if (stderr.trim().length > 0) {
    console.error(`[scipy-besselj-adapter] python stderr:\n${stderr}`);
  }
  if (exitCode !== 0) {
    throw new Error(`python3 exited with code ${exitCode}; stdout length=${stdout.length}`);
  }

  const py: {
    scipy_version: string;
    numpy_version: string;
    python_version: string;
    records: OracleRecord[];
  } = JSON.parse(stdout);

  // Tally per-status; print a summary; surface any errors as a non-aborting
  // warning. Bronze-tier acceptance is ≥ 95% success per the Mission.
  const totals = {
    records: py.records.length,
    success: py.records.filter((r) => r.status === "success").length,
    limit:   py.records.filter((r) => r.status === "limit").length,
    error:   py.records.filter((r) => r.status === "error").length,
    real_inputs:    corpus.inputs.filter((i) => typeof i.z === "string").length,
    complex_inputs: corpus.inputs.filter((i) => typeof i.z !== "string").length,
  };

  if (totals.error > 0) {
    console.error(`[scipy-besselj-adapter] WARNING: ${totals.error} per-record errors (sample):`);
    for (const r of py.records.filter((x) => x.status === "error").slice(0, 5)) {
      console.error(`  ${r.id} (${r.head}, tier=${r.tier}): ${r.notes}`);
    }
  }

  const oracleFile: OracleFile = {
    oracle_id: "scipy",
    oracle_version: `SciPy ${py.scipy_version} / Python ${py.python_version} / NumPy ${py.numpy_version}`,
    scipy_version: py.scipy_version,
    numpy_version: py.numpy_version,
    python_version: py.python_version,
    generated_at: new Date().toISOString(),
    bead: "scientist-workbench-qvnm",
    corpus_bead: corpus.bead,
    corpus_manifest_version: corpus.manifest_version,
    corpus_generated_at: corpus.generated_at,
    corpus_seed: corpus.seed,
    tier: "bronze",
    precision_emit: "float64 (Python repr; shortest round-trip)",
    platform: { arch: arch(), os: platform(), runtime: `bun-${Bun.version}` },
    totals,
    results: py.records,
  };

  writeFileSync(outPath, JSON.stringify(oracleFile, null, 2) + "\n");

  const successPct = (100.0 * totals.success / totals.records).toFixed(2);
  console.error(
    `[scipy-besselj-adapter] wrote ${outPath}: ${totals.records} records ` +
    `(${totals.success} success [${successPct}%], ${totals.limit} limit, ${totals.error} error); ` +
    `${totals.real_inputs} real + ${totals.complex_inputs} complex inputs; ` +
    `${elapsedMs.toFixed(0)} ms wall.`,
  );
}

if (import.meta.main) {
  void main();
}
