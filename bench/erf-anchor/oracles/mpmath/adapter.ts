// =============================================================================
// bench/erf-anchor/oracles/mpmath/adapter.ts
// =============================================================================
//
// mpmath gold-tier oracle adapter for the Erf-anchor golden-master corpus.
//
// This module reads `bench/erf-anchor/corpus.json` (the Phase-1 G1 input
// manifest — 271 corpus rows across 8 tiers and 6 heads) and emits
// `bench/erf-anchor/oracles/mpmath/results.json`, a parallel-shape record of
// arb-prec golden-master values produced by mpmath 1.3.0. mpmath sits at the
// **gold tier** of the R5 oracle hierarchy alongside Wolfram Mathematica:
// together the two engines form the cross-validation baseline that R5's
// §"Headline finding" established three-way agreement on
// (`mpmath = sympy = Boost cpp_bin_float<50>` at 50 dp for `erf(123/100)`).
// Without an *independent* second voice on the arb-prec branch, we cannot
// claim "world-class Erf"; mpmath IS that voice for the open-source side.
//
// -----------------------------------------------------------------------------
// Why mpmath
// -----------------------------------------------------------------------------
//
// mpmath is the canonical pure-Python arb-prec multiprecision library. It
// implements `mp.mpf` (real) and `mp.mpc` (complex) on top of Python `int`
// arithmetic — bit-identical across CPython runtimes by construction (Python
// `int` is bit-identical by language spec). It computes `erf`, `erfc`, and
// `erfi` directly using internal Borel-summed series + Faddeeva for complex
// arguments; cited by sympy as its `.evalf` backend (see R5 §2.3). For the
// inverse and scaled functions we compose:
//
//   - mpmath ships `mp.erfinv(y)` directly.
//   - mpmath does NOT ship `mp.erfcinv` — we compute
//     `erfcinv(y) = erfinv(1 - y)`. Both legs are exact at `mp.dps`; the
//     subtraction `1 - y` for `y` in `(0, 2)` does not cancel any significant
//     digits because we work at 60 dps and the corpus's smallest `y` is
//     `1e-50` (R2 §1 says we have ~10 dps margin even there).
//   - mpmath does NOT ship `mp.erfcx` — we compute
//     `erfcx(z) = exp(z²) · erfc(z)`. Both operands carry mp.dps independently
//     and the product is correctly rounded to mp.dps as a whole. ADR-0040
//     §"Decision 3" warns NOT to derive `bigErfcx` this way in the substrate
//     (catastrophic cancellation in the substrate's float64 hand-off path),
//     but for the *oracle* the composition is fine — mpmath holds full
//     precision through `exp(z²)` until the multiply, and the only place this
//     fails is `z = MAX_DOUBLE` where `exp(z²)` exceeds the Python int → float
//     conversion limit; we catch that and emit an honest refusal record.
//
// -----------------------------------------------------------------------------
// The 60-dps-compute / 55-dp-emit margin (R5 §3 + ADR-0040 §"Decision 8")
// -----------------------------------------------------------------------------
//
// The gold-tier target is 50 decimal digits of correctly-rounded answer per
// input. We set `mp.dps = 60` (10 decimal digits above the gold target) for
// the compute. We then format via `mpmath.nstr(value, 55, strip_zeros=False)`
// for emission — 5 dps above the gold target, 5 dps below the working
// precision. Both margins are load-bearing:
//
//   - The **10-dps compute margin** absorbs the worst-case cancellation
//     mpmath might internally encounter at the boundaries of its dispatch
//     (e.g. `erfc(x)` for `x ≈ 6` straddles its mid-asymptotic crossover).
//   - The **5-dps emit margin** below the working precision strips the
//     2–3 trailing digits that mpmath's last-digit rounding emits as
//     numerical residue. mpmath's `nstr` rounds-to-nearest, while Wolfram's
//     `N[]` truncates (R5 §2.2 cross-check; ADR-0040 §"Decision 8 landmine
//     2"). Trimming to 55 digits canonicalises this mismatch — by the time
//     the G8 cross-agreement comparator compares to the Wolfram oracle's
//     emit, both adapters' 55-digit strings have shed their last-digit
//     rounding-mode noise.
//
// -----------------------------------------------------------------------------
// Subprocess discipline
// -----------------------------------------------------------------------------
//
// The TS driver spawns `python3` exactly ONCE via `node:child_process.spawnSync`
// — pattern established in `packages/meijer-core/test/dispatch-mpmath.test.ts`
// (the existing in-repo mpmath bridge). Python startup is ~200 ms; spawning
// per corpus row would be ~54 s of pure subprocess overhead before any erf
// math; batched it's < 5 s end-to-end. We feed the corpus to Python via stdin
// as a single JSON blob (the JSON.stringify'd corpus inputs); Python reads it,
// iterates, and writes a single JSON.dumps'd results blob to stdout. The TS
// driver parses the stdout JSON, fills in the version metadata, and writes
// the final results.json.
//
// We do NOT use the `spawnBun` resolver (ADR-0001) because the child is
// `python3`, not bun; the snap-bun mount-namespace landmine that motivated
// that resolver is specific to bun. Plain `child_process.spawnSync("python3",
// ...)` is correct here and matches the dispatch-mpmath.test.ts precedent.
//
// -----------------------------------------------------------------------------
// Re-run
// -----------------------------------------------------------------------------
//
//   bun bench/erf-anchor/oracles/mpmath/adapter.ts
//
// Determinism: byte-identical re-runs given identical `corpus.json` +
// identical mpmath/python3 versions (recorded in every results.json record).
// =============================================================================

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Types — match the corpus and oracle-result shapes
// -----------------------------------------------------------------------------

type RealInput = { id: string; tier: string; head: string; z: string; notes?: string };
type ComplexInput = {
  id: string;
  tier: string;
  head: string;
  z: { re: string; im: string };
  notes?: string;
};
type CorpusInput = RealInput | ComplexInput;

interface Corpus {
  manifest_version: number;
  generated_at: string;
  bead: string;
  adr: string;
  inputs: CorpusInput[];
  totals: { total: number };
}

interface ResultRecord {
  input_id: string;
  head: string;
  z: string | { re: string; im: string };
  /**
   * Successful arb-prec output. Either a single decimal string (for real
   * inputs whose output is real) or `{re, im}` (for complex outputs and any
   * input the corpus declared as complex). Absent when `failure_reason` is
   * set.
   */
  output?: string | { re: string; im: string };
  /**
   * Set on honest refusal — a corpus row mpmath cannot produce a finite
   * answer for (e.g. `erfcx(MAX_VALUE)` overflows the `exp(z²)` operand).
   * Mutually exclusive with `output`. The G8 cross-agreement comparator
   * compares refusal-vs-refusal as agreement.
   */
  failure_reason?: string;
  method: string;
  achieved_precision: number;
  oracle_id: "mpmath";
  oracle_version: string;
  python_version: string;
  elapsed_ms: number;
}

// -----------------------------------------------------------------------------
// Python script — the batched mpmath driver
// -----------------------------------------------------------------------------
//
// Reads the corpus inputs as JSON on stdin; emits a JSON list of results on
// stdout. Each result is one of:
//
//   { "id": "...", "ok": true,  "real": "0.…" }                    (real → real)
//   { "id": "...", "ok": true,  "complex": {"re": "…", "im": "…"} }(any → complex)
//   { "id": "...", "ok": false, "reason": "<short string>" }       (refusal)
//
// Plus a final preamble line giving mpmath.__version__ and sys.version. The
// preamble is emitted as the first element of the list under the sentinel
// key `__meta__` so the parser is uniform.
//
// 60 dps compute; 55 dp emit (margin discipline documented above).

const PY_SCRIPT = `
import json
import sys
import time
import mpmath
from mpmath import mp, mpf, mpc, nstr, inf, nan, exp, erf, erfc, erfi

WORK_DPS = 60
EMIT_DPS = 55
mp.dps = WORK_DPS

def parse_real(s):
    """Parse a corpus decimal string into mpf, honouring sentinel tokens."""
    if s == "NaN":
        return nan
    if s == "Infinity":
        return inf
    if s == "-Infinity":
        return -inf
    # mpf accepts the full 60-digit fixed-format string the corpus emits.
    return mpf(s)

def parse_complex(z):
    """Parse a corpus {re, im} record into mpc."""
    re = parse_real(z["re"])
    im = parse_real(z["im"])
    return mpc(re, im)

def emit_real_string(v):
    """Format an mpf (or scalar mpc.real / mpc.imag) at EMIT_DPS digits."""
    # mpmath nstr handles ±inf / nan via Python str fallback; canonicalise.
    if mpmath.isnan(v):
        return "NaN"
    if mpmath.isinf(v):
        return "Infinity" if v > 0 else "-Infinity"
    return nstr(v, EMIT_DPS, strip_zeros=False)

def emit_complex_record(v):
    return {"re": emit_real_string(v.real), "im": emit_real_string(v.imag)}

def evaluate(head, z):
    """Dispatch on head. Returns a *value* (mpf, mpc, or raises)."""
    if head == "Erf":
        return erf(z)
    if head == "Erfc":
        return erfc(z)
    if head == "Erfi":
        return erfi(z)
    if head == "Erfcx":
        # No native mpmath erfcx; compose. The product exp(z²)·erfc(z) carries
        # full mp.dps because both operands compute independently. At z=±inf
        # the product is exp(inf)·0 → indeterminate; we let mpmath emit nan
        # and report the value honestly. At z=MAX_DOUBLE the exp(z²) operand
        # overflows Python's int→float bridge — this raises OverflowError and
        # we record an honest refusal.
        return exp(z * z) * erfc(z)
    if head == "InverseErf":
        return mpmath.erfinv(z)
    if head == "InverseErfc":
        # No native mpmath erfcinv; compose. erfcinv(y) = erfinv(1 - y) for
        # y in (0, 2). For y=1e-50 we have 1-y ≈ 1, and erfinv near ±1 is
        # well-conditioned at 60 dps (R2 §"Inverses" — Newton converges
        # quadratically). For y=1.999 we have 1-y = -0.999, which mpmath
        # handles symmetrically (erfinv is odd).
        return mpmath.erfinv(mpf(1) - z)
    raise ValueError(f"unknown head: {head}")

def run():
    corpus = json.load(sys.stdin)
    inputs = corpus["inputs"]
    results = []
    # Sentinel meta record at index 0; G3 TS driver reads + strips it.
    results.append({
        "__meta__": True,
        "mpmath_version": mpmath.__version__,
        "python_version": sys.version,
        "work_dps": WORK_DPS,
        "emit_dps": EMIT_DPS,
    })
    for inp in inputs:
        rid = inp["id"]
        head = inp["head"]
        z_field = inp["z"]
        t0 = time.perf_counter_ns()
        try:
            # Build z. Corpus rows are either string (real) or {re,im} (complex).
            if isinstance(z_field, str):
                # Real-input rows. Inverse heads and pure-real Erf/Erfc/etc.
                # take mpf; the result is a real mpf (or mpc with zero imag
                # for Erf(0+iy) etc., but those are complex-input rows in T4).
                z = parse_real(z_field)
            else:
                # Complex-input rows (T4 imag-pure, T5 complex, T7 Stokes).
                z = parse_complex(z_field)
            v = evaluate(head, z)
            elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
            if isinstance(v, mpc):
                results.append({
                    "id": rid,
                    "ok": True,
                    "complex": emit_complex_record(v),
                    "elapsed_ms": elapsed_ms,
                })
            else:
                results.append({
                    "id": rid,
                    "ok": True,
                    "real": emit_real_string(v),
                    "elapsed_ms": elapsed_ms,
                })
        except OverflowError as e:
            elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
            results.append({
                "id": rid,
                "ok": False,
                "reason": f"OverflowError: {e}",
                "elapsed_ms": elapsed_ms,
            })
        except (ValueError, ZeroDivisionError, ArithmeticError) as e:
            elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
            results.append({
                "id": rid,
                "ok": False,
                "reason": f"{type(e).__name__}: {e}",
                "elapsed_ms": elapsed_ms,
            })
    json.dump(results, sys.stdout)

run()
`;

// -----------------------------------------------------------------------------
// TS driver
// -----------------------------------------------------------------------------

function main(): void {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const corpusPath = fileURLToPath(new URL("../../corpus.json", import.meta.url));
  const resultsPath = `${here}results.json`;
  const readmePath = `${here}README.md`;

  // -- smoke-test python3 + mpmath before paying the corpus-load cost --
  const probe = spawnSync("python3", ["-c", "import mpmath; print(mpmath.__version__)"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    const msg =
      `\n\n## Adapter failure ${new Date().toISOString()}\n\n` +
      `Smoke-test failed: \`python3 -c 'import mpmath'\` returned exit ${probe.status}.\n\n` +
      `stdout: \`${probe.stdout?.trim() ?? ""}\`\nstderr: \`${probe.stderr?.trim() ?? ""}\`\n\n` +
      `mpmath 1.3.0 + python3 3.12.3 are documented in R5 as available locally;\n` +
      `verify with \`python3 -c 'import mpmath; print(mpmath.__version__)'\`.\n`;
    try {
      appendFileSync(readmePath, msg);
    } catch {
      // README may not exist yet — surface to stderr regardless.
    }
    process.stderr.write(`mpmath adapter: smoke-test failed; see ${readmePath}\n`);
    process.exit(1);
  }

  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: Corpus = JSON.parse(corpusRaw);
  // Strip the meta block to keep the python payload size down — only inputs
  // are needed. Re-emit a minimal envelope.
  const pythonInput = JSON.stringify({ inputs: corpus.inputs });

  const t0 = Date.now();
  const child = spawnSync("python3", ["-c", PY_SCRIPT], {
    input: pythonInput,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64, // 64 MiB — corpus.json is 65 KiB; results ~10× larger; ample.
  });
  const totalElapsedMs = Date.now() - t0;

  if (child.status !== 0) {
    process.stderr.write(`mpmath adapter: python3 exited ${child.status}\n`);
    process.stderr.write(`stderr:\n${child.stderr}\n`);
    process.exit(1);
  }

  let parsed: Array<Record<string, unknown>>;
  try {
    parsed = JSON.parse(child.stdout);
  } catch (e) {
    process.stderr.write(`mpmath adapter: failed to parse python stdout as JSON: ${(e as Error).message}\n`);
    process.stderr.write(`stdout head: ${child.stdout.slice(0, 500)}\n`);
    process.exit(1);
  }

  // First element is the meta sentinel.
  const meta = parsed[0] as {
    __meta__: true;
    mpmath_version: string;
    python_version: string;
    work_dps: number;
    emit_dps: number;
  };
  if (!meta || meta.__meta__ !== true) {
    process.stderr.write(`mpmath adapter: missing meta sentinel; got ${JSON.stringify(parsed[0])}\n`);
    process.exit(1);
  }
  const pyResults = parsed.slice(1) as Array<{
    id: string;
    ok: boolean;
    real?: string;
    complex?: { re: string; im: string };
    reason?: string;
    elapsed_ms: number;
  }>;

  if (pyResults.length !== corpus.inputs.length) {
    process.stderr.write(
      `mpmath adapter: result count mismatch: corpus=${corpus.inputs.length}, results=${pyResults.length}\n`,
    );
    process.exit(1);
  }

  // -- build the results.json envelope --
  const records: ResultRecord[] = [];
  for (let i = 0; i < pyResults.length; i++) {
    const inp = corpus.inputs[i];
    const r = pyResults[i];
    if (r.id !== inp.id) {
      process.stderr.write(`mpmath adapter: id-order mismatch at row ${i}: corpus=${inp.id} result=${r.id}\n`);
      process.exit(1);
    }
    const base: ResultRecord = {
      input_id: inp.id,
      head: inp.head,
      z: inp.z,
      method: "mpmath-mpf-at-60-dps",
      achieved_precision: meta.emit_dps,
      oracle_id: "mpmath",
      oracle_version: meta.mpmath_version,
      python_version: meta.python_version,
      elapsed_ms: r.elapsed_ms,
    };
    if (r.ok) {
      if (r.real !== undefined) base.output = r.real;
      else if (r.complex !== undefined) base.output = r.complex;
      else {
        process.stderr.write(`mpmath adapter: ok record missing output payload at ${inp.id}\n`);
        process.exit(1);
      }
    } else {
      base.failure_reason = r.reason ?? "unknown";
    }
    records.push(base);
  }

  const envelope = {
    manifest_version: 1,
    oracle_id: "mpmath",
    oracle_version: meta.mpmath_version,
    python_version: meta.python_version,
    method: "mpmath-mpf-at-60-dps",
    work_dps: meta.work_dps,
    emit_dps: meta.emit_dps,
    corpus_bead: corpus.bead,
    corpus_adr: corpus.adr,
    corpus_generated_at: corpus.generated_at,
    generated_at: new Date().toISOString(),
    total_corpus_inputs: corpus.inputs.length,
    total_results: records.length,
    total_ok: records.filter((r) => r.output !== undefined).length,
    total_refused: records.filter((r) => r.failure_reason !== undefined).length,
    total_elapsed_ms: totalElapsedMs,
    results: records,
  };

  writeFileSync(resultsPath, JSON.stringify(envelope, null, 2) + "\n");
  process.stdout.write(
    `mpmath adapter: wrote ${resultsPath}\n` +
      `  total inputs: ${corpus.inputs.length}\n` +
      `  successful:   ${envelope.total_ok}\n` +
      `  refused:      ${envelope.total_refused}\n` +
      `  elapsed:      ${totalElapsedMs} ms\n` +
      `  mpmath:       ${meta.mpmath_version}\n`,
  );
}

if (import.meta.main) main();
