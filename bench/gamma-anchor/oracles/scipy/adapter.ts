// =============================================================================
// bench/gamma-anchor/oracles/scipy/adapter.ts — bronze-tier SciPy gamma oracle
// =============================================================================
//
// Bead: `scientist-workbench-tqwc` (G4 — Phase 1 SciPy bronze-tier oracle
// adapter for the Gamma family). Companion to the sibling `oracle.py` in
// the same directory. This module is the TypeScript driver: it loads the
// canonical `bench/gamma-anchor/corpus.json` (G1 / sha256
// `1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5`),
// spawns `python3 oracle.py` exactly once with the corpus on stdin,
// merges the per-record results with corpus metadata, and writes
// `bench/gamma-anchor/oracles/scipy/results.json`.
//
// ---------------------------------------------------------------------------
// Tier role: BRONZE (float64). Most landmines per call of any gamma oracle.
// ---------------------------------------------------------------------------
//
// Per ADR-0042 §"Decision 8" the bronze-tier acceptance target is
// ULP-distance ≤ 3 vs gold (Wolfram + mpmath at 50+ dp truncated to float64,
// per R5 §2 and §3.3). SciPy is the workhorse bronze voice with the widest
// head coverage of any local oracle — 17 of 19 corpus heads emit a numeric
// answer; only `BarnesG` is unsupported wholesale (`status: "unsupported"`),
// and complex `Polygamma`/`Trigamma`/`IncompleteGamma{Upper,Lower,P,Q}`
// refuse cleanly per L14 (`status: "refused"` with
// `refuse_token = "TypeError-complex-polygamma"` or
// `"TypeError-complex-gammainc"`).
//
// SciPy 1.17.0 sits on `scipy.special` which wraps Stephen Moshier's
// Cephes (`gamma.c`, `igam.c`, `incbet.c`), the SunPro-1993 lineage
// (`e_lgamma_r.c`), Boost's `digamma.hpp` / `polygamma.hpp`, and SciPy's
// own `_loggamma.pxd` for the complex-aware variants. This is independent
// code from the in-substrate ports we will ship in Phase 2 — independence
// is what makes a joint Cephes-vs-substrate ≤ 3-ULP agreement on the
// corpus strong evidence of correctness rather than shared-bug agreement.
//
// ---------------------------------------------------------------------------
// Landmines pinned in this adapter (R5 §6)
// ---------------------------------------------------------------------------
//
//   - **L12 — incomplete-gamma regularisation convention (THE #1 trap).**
//     SciPy's `gammainc(a, z)` returns P (lower regularised); Wolfram's
//     `Gamma[a, z]` returns the UPPER unregularised. Every line in
//     `oracle.py` that touches `gammainc` / `gammaincc` / `gammaincinv` /
//     `gammainccinv` carries an explicit `# L12` comment. The unregularised
//     `IncompleteGammaUpper`/`Lower` are derived as `Q · Γ(a)` and
//     `P · Γ(a)` respectively — the only way to expose the unregularised
//     forms through SciPy's regularised-only API.
//
//   - **L13 — inverse-incomplete-gamma convention.** SciPy splits the
//     inverse into two distinct functions: `gammaincinv` inverts P (lower)
//     and `gammainccinv` inverts Q (upper). Wolfram's
//     `InverseGammaRegularized[a, q]` inverts Q only. The corpus has TWO
//     distinct heads (`InverseIncompleteGammaP`, `InverseIncompleteGammaQ`)
//     so the comparator never has to disambiguate, but the call sites in
//     `oracle.py` are pinned with `# L13` for clarity.
//
//   - **L14 — SciPy complex polygamma raises TypeError.**
//     `scipy.special.polygamma(m, complex)` raises:
//        TypeError: ufunc '_zeta' not supported for the input types
//     in 1.11.4 AND 1.17.0 — confirmed by probe before this adapter shipped.
//     Trigamma (which routes through `polygamma(1, z)`) inherits the
//     refusal. The adapter emits `status: "refused"` with
//     `refuse_token: "TypeError-complex-polygamma"`. The comparator
//     graduates these cells to gold-only (Wolfram + mpmath).
//
//   - **L15 — SciPy `loggamma(real_negative)` returns NaN.**
//     `sp.loggamma(-0.5)` returns `nan`; the analytic continuation
//     `(1.265 - π·i)` requires `sp.loggamma(complex(-0.5, 0.0))`. The
//     adapter routes real negative LogGamma inputs through the `+0j`
//     trampoline; the result is a complex value and emits as `{re, im}`.
//
//   - **L17 — Gamma at non-positive integer poles (four oracle behaviors).**
//     Wolfram returns `ComplexInfinity`; mpmath raises; SciPy returns
//     `+inf` for `gamma(0.0)` and `nan` for `gamma(-1.0)`; libm matches
//     SciPy. The adapter emits SciPy's raw return faithfully (status
//     `"success"` with `value: "Infinity"` or `"NaN"`). The comparator
//     special-cases pole inputs. We do NOT raise on poles — they are the
//     honest float64 answer.
//
// ---------------------------------------------------------------------------
// L16 — SciPy lacks BarnesG (and Hyperfactorial)
// ---------------------------------------------------------------------------
//
// `scipy.special` has no `barnesg`, no `hyperfac`. The corpus has 11
// BarnesG cells; this adapter emits `status: "unsupported"` for every
// one, with a `notes` field pointing to gold tier (Wolfram + mpmath).
// The corpus does not exercise Hyperfactorial — the head was deferred
// at the vocab level per ADR-0042 §"What we will not decide here".
//
// ---------------------------------------------------------------------------
// Process model — Bun.spawn one python3 child; sibling oracle.py on argv
// ---------------------------------------------------------------------------
//
// We spawn `python3` exactly ONCE via `Bun.spawn` (NOT `node:child_process`
// — matches the besselj mpmath adapter precedent). The Python script
// lives in a sibling file `oracle.py` rather than as an inline template
// literal. Reasons:
//
//   - The Python is ~440 LOC carrying literate landmine commentary,
//     per-head dispatch, parsing helpers, and the value formatter.
//     Inlining as a template literal would (a) destroy syntax
//     highlighting and Python lint discipline; (b) hide the `# L12` /
//     `# L13` / `# L15` pins inside a TS string; (c) cost ~30% TS file
//     length for content no TS reader cares about. The Bessel mpmath
//     adapter pinned this layout in worklog precedent.
//
//   - The sibling .py is independently smoke-testable:
//     `python3 oracle.py < ../../corpus.json | head -2`. This matters
//     when debugging an L-mitigation regression.
//
//   - The sibling .py is invokable from any other harness (a Make rule
//     the user might add later, an ad-hoc python REPL, a future CI
//     suite even though CLAUDE.md Rule 11 forbids automated CI for
//     now) without parsing the TS first.
//
// The TS layer's job is exactly four things: smoke-test python3+SciPy
// before paying the corpus-load cost; feed the corpus envelope to
// Python on stdin; collect the JSON result blob from stdout; merge with
// corpus metadata + Bun-side wall-time and write the final
// `results.json`. The Python IS the oracle; the TS is the driver.
//
// ---------------------------------------------------------------------------
// Wire shape of the final results.json
// ---------------------------------------------------------------------------
//
//   {
//     "oracle_id": "scipy",
//     "oracle_version": "SciPy 1.17.0 / Python 3.12.3 / NumPy 1.26.4",
//     "scipy_version":  "1.17.0",
//     "numpy_version":  "1.26.4",
//     "python_version": "3.12.3",
//     "generated_at": "<ISO-8601 UTC>",
//     "bead": "scientist-workbench-tqwc",
//     "corpus_bead": "scientist-workbench-0kq3",
//     "corpus_manifest_version": <int>,
//     "corpus_generated_at": "...",
//     "corpus_seed": <int>,
//     "tier": "bronze",
//     "precision_emit": "float64 (f\"{x:.17g}\"; 17-sig-digit round-trip)",
//     "platform": { "arch": "x64", "os": "linux", "runtime": "bun-<ver>" },
//     "totals": { records, success, refused, unsupported, error,
//                 real_inputs, complex_inputs,
//                 by_landmine: { "L12": N, "L13": N, "L14": N, "L15": N, ... } },
//     "results": [
//       { "id":     "T1-gamma-001",
//         "head":   "Gamma",
//         "tier":   "T1",
//         "status": "success" | "refused" | "unsupported" | "error",
//         "value":  "<float64 str>" | {"re":"...","im":"..."} | null,
//         "method": "scipy.special.gamma" | ...,
//         "landmines": ["L12"|"L13"|"L14"|"L15"|"L17"],
//         "refuse_token": "TypeError-complex-polygamma" | undefined,
//         "elapsed_ms": <number>,
//         "notes": "<string|null>" },
//       ...
//     ]
//   }
//
// Per ADR-0015 the `platform` block records the float64-determinism
// fingerprint: SciPy's float64 output is bit-identical given `{arch, os,
// runtime}`; the comparator's `runMemoized` path consumes this block.
//
// ---------------------------------------------------------------------------
// Re-run
// ---------------------------------------------------------------------------
//
//   bun bench/gamma-anchor/oracles/scipy/adapter.ts
//
// Determinism: byte-identical re-runs given byte-identical `corpus.json` +
// identical SciPy / Python / NumPy versions. Expected wall-time: ≤ 5 s
// for the 377-input corpus on a typical Linux x86_64 desktop (SciPy warm-
// batch throughput at float64 is ~10⁴ evaluations/second; the cold-start
// Python+SciPy import is ~250 ms).
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";

// -----------------------------------------------------------------------------
// Corpus & oracle types
// -----------------------------------------------------------------------------

/** A decimal-class kinded argument (a, b, m, n): {kind, value}. */
interface KindedArg {
  readonly kind: "integer" | "half-integer" | "decimal";
  readonly value: string;
}

/** The primary `z` is either a real decimal string or a {re, im} dict. */
type ZField = string | { readonly re: string; readonly im: string };

/** A single corpus input record. Schema varies per head; we keep it open. */
interface CorpusInput {
  readonly id: string;
  readonly tier: string;
  readonly head: string;
  readonly z?: ZField;
  readonly a?: KindedArg;
  readonly b?: KindedArg;
  readonly m?: KindedArg;
  readonly n?: KindedArg;
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

type OracleValue =
  | string
  | { re: string; im: string }
  | null;

type RecordStatus = "success" | "refused" | "unsupported" | "error";

interface PyRow {
  readonly input_id: string;
  readonly head: string;
  readonly tier: string;
  readonly status: RecordStatus;
  readonly value: OracleValue;
  readonly method: string;
  readonly landmines: readonly string[];
  readonly refuse_token?: string;
  readonly elapsed_ms: number;
  readonly notes: string | null;
}

interface PyMeta {
  readonly __meta__: true;
  readonly scipy_version: string;
  readonly numpy_version: string;
  readonly python_version: string;
  readonly compute_precision_bits: number;
  readonly emit_format: string;
}

interface OracleFile {
  readonly oracle_id: "scipy";
  readonly oracle_version: string;            // composite string
  readonly scipy_version: string;
  readonly numpy_version: string;
  readonly python_version: string;
  readonly generated_at: string;
  readonly bead: "scientist-workbench-tqwc";
  readonly corpus_bead: string;
  readonly corpus_manifest_version: number;
  readonly corpus_generated_at: string;
  readonly corpus_seed: number;
  readonly tier: "bronze";
  readonly precision_emit: string;
  readonly platform: { arch: string; os: string; runtime: string };
  readonly totals: {
    records: number;
    success: number;
    refused: number;
    unsupported: number;
    error: number;
    real_inputs: number;
    complex_inputs: number;
    by_landmine: Record<string, number>;
    by_refuse_token: Record<string, number>;
  };
  readonly results: readonly PyRow[];
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function zIsComplex(z: ZField | undefined): boolean {
  return typeof z === "object" && z !== null && !Array.isArray(z);
}

// -----------------------------------------------------------------------------
// Main driver
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusPath = join(here, "..", "..", "corpus.json");
  const oraclePyPath = join(here, "oracle.py");
  const outPath = join(here, "results.json");

  // Existence preconditions — fail loud with explicit paths.
  if (!existsSync(corpusPath)) {
    process.stderr.write(`[scipy-gamma-adapter] missing corpus.json at ${corpusPath}\n`);
    process.exit(1);
  }
  if (!existsSync(oraclePyPath)) {
    process.stderr.write(`[scipy-gamma-adapter] missing sibling oracle.py at ${oraclePyPath}\n`);
    process.exit(1);
  }

  // Smoke-test python3 + scipy before paying the corpus-load cost. A 0.3 s
  // import failure is much better than a 5 s corpus-load-then-crash. We
  // probe `import scipy.special` explicitly because `python3 --version`
  // doesn't reveal whether SciPy is actually importable in this env.
  const probe = Bun.spawn(
    [
      "python3",
      "-c",
      "import scipy, scipy.special, numpy, sys; " +
        "print(scipy.__version__); print(numpy.__version__); print(sys.version.split()[0])",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const probeExit = await probe.exited;
  if (probeExit !== 0) {
    const errOut = await new Response(probe.stderr).text();
    process.stderr.write(
      `[scipy-gamma-adapter] smoke-test failed (python3 -c 'import scipy.special' exit ${probeExit})\n` +
        `stderr:\n${errOut}\n\n` +
        `Per R5 §3.3, SciPy 1.17.0 / Python 3.12 are documented as available on this machine.\n` +
        `On a fresh machine: \`pip install --user scipy numpy\` (or system package manager).\n`,
    );
    process.exit(1);
  }
  const probeOut = (await new Response(probe.stdout).text()).trim();
  process.stdout.write(
    `[scipy-gamma-adapter] smoke-test OK (scipy=${probeOut.split("\n")[0]} numpy=${probeOut.split("\n")[1]} python=${probeOut.split("\n")[2]})\n`,
  );

  // Load corpus & forward the bare {inputs:[...]} envelope to Python on
  // stdin. We strip the outer corpus metadata because the oracle doesn't
  // need it; the TS side will fold metadata back into the final results
  // envelope. Keeping the stdin payload small also speeds the JSON parse.
  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: CorpusFile = JSON.parse(corpusRaw);
  const pythonStdin = JSON.stringify({ inputs: corpus.inputs });

  process.stdout.write(
    `[scipy-gamma-adapter] loaded corpus (${corpus.inputs.length} inputs, seed=${corpus.seed}); spawning oracle.py ...\n`,
  );

  // Spawn the single python3 child. The Python script is a sibling file
  // invoked as a positional argument; the stdin pipe carries the corpus.
  const t0 = performance.now();
  const proc = Bun.spawn(["python3", oraclePyPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(pythonStdin);
  await proc.stdin.end();

  // Drain stdout and stderr concurrently with child execution — Bun pipe
  // buffers cap around 64 KiB and our stdout payload is ~250 KiB. Waiting
  // serially would deadlock the child.
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const totalElapsedMs = performance.now() - t0;

  if (exitCode !== 0) {
    process.stderr.write(`[scipy-gamma-adapter] oracle.py exited ${exitCode}\n`);
    process.stderr.write(`stderr:\n${stderrText}\n`);
    process.stderr.write(`stdout head:\n${stdoutText.slice(0, 500)}\n`);
    process.exit(1);
  }
  if (stderrText.trim().length > 0) {
    // Python may have emitted warnings (e.g. RuntimeWarning on poles);
    // surface but don't fail.
    process.stderr.write(`[scipy-gamma-adapter] python stderr (non-fatal):\n${stderrText}\n`);
  }

  // Parse python output: index 0 is the __meta__ sentinel, rest are records.
  let parsed: ReadonlyArray<PyMeta | PyRow>;
  try {
    parsed = JSON.parse(stdoutText) as ReadonlyArray<PyMeta | PyRow>;
  } catch (e) {
    process.stderr.write(
      `[scipy-gamma-adapter] failed to parse python stdout as JSON: ${(e as Error).message}\n` +
        `stdout head: ${stdoutText.slice(0, 500)}\n`,
    );
    process.exit(1);
  }

  const meta = parsed[0] as PyMeta;
  if (!meta || meta.__meta__ !== true) {
    process.stderr.write(
      `[scipy-gamma-adapter] missing __meta__ sentinel at index 0; got ${JSON.stringify(parsed[0])}\n`,
    );
    process.exit(1);
  }
  const rows = parsed.slice(1) as ReadonlyArray<PyRow>;

  if (rows.length !== corpus.inputs.length) {
    process.stderr.write(
      `[scipy-gamma-adapter] result count mismatch: corpus=${corpus.inputs.length}, results=${rows.length}\n`,
    );
    process.exit(1);
  }

  // Validate order: every row's id must match the corresponding corpus input.
  // This is load-bearing — the G8 comparator accesses results by index.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].input_id !== corpus.inputs[i].id) {
      process.stderr.write(
        `[scipy-gamma-adapter] id-order mismatch at row ${i}: corpus=${corpus.inputs[i].id} python=${rows[i].input_id}\n`,
      );
      process.exit(1);
    }
  }

  // Tally for the totals block.
  const totals = {
    records: rows.length,
    success: 0,
    refused: 0,
    unsupported: 0,
    error: 0,
    real_inputs: corpus.inputs.filter((i) => !zIsComplex(i.z)).length,
    complex_inputs: corpus.inputs.filter((i) => zIsComplex(i.z)).length,
    by_landmine: {} as Record<string, number>,
    by_refuse_token: {} as Record<string, number>,
  };
  for (const r of rows) {
    switch (r.status) {
      case "success":
        totals.success += 1;
        break;
      case "refused":
        totals.refused += 1;
        if (r.refuse_token) {
          totals.by_refuse_token[r.refuse_token] =
            (totals.by_refuse_token[r.refuse_token] ?? 0) + 1;
        }
        break;
      case "unsupported":
        totals.unsupported += 1;
        break;
      case "error":
        totals.error += 1;
        break;
      default: {
        // Exhaustiveness — refuse the run if the Python side invents a new status.
        const _exhaustive: never = r.status;
        void _exhaustive;
        process.stderr.write(
          `[scipy-gamma-adapter] unknown status ${(r as PyRow).status} at id=${(r as PyRow).input_id}\n`,
        );
        process.exit(1);
      }
    }
    for (const lm of r.landmines) {
      totals.by_landmine[lm] = (totals.by_landmine[lm] ?? 0) + 1;
    }
  }

  // Loud-fail on per-record error (status="error" is a true exception, not a
  // refusal). Surface up to 5 examples and continue — the bronze tier's
  // acceptance is ≥ 95% non-error per the precedent in besselj mpmath
  // adapter, and unsupported / refused are honest answers, not errors.
  if (totals.error > 0) {
    process.stderr.write(
      `[scipy-gamma-adapter] WARNING: ${totals.error} per-record errors (first 5):\n`,
    );
    for (const r of rows.filter((x) => x.status === "error").slice(0, 5)) {
      process.stderr.write(`  ${r.input_id} (${r.head}, tier=${r.tier}): ${r.notes}\n`);
    }
  }

  const oracleFile: OracleFile = {
    oracle_id: "scipy",
    oracle_version:
      `SciPy ${meta.scipy_version} / Python ${meta.python_version} / NumPy ${meta.numpy_version}`,
    scipy_version: meta.scipy_version,
    numpy_version: meta.numpy_version,
    python_version: meta.python_version,
    generated_at: new Date().toISOString(),
    bead: "scientist-workbench-tqwc",
    corpus_bead: corpus.bead,
    corpus_manifest_version: corpus.manifest_version,
    corpus_generated_at: corpus.generated_at,
    corpus_seed: corpus.seed,
    tier: "bronze",
    precision_emit: 'float64 (f"{x:.17g}"; 17-sig-digit round-trip)',
    platform: { arch: arch(), os: platform(), runtime: `bun-${Bun.version}` },
    totals,
    results: rows,
  };

  writeFileSync(outPath, JSON.stringify(oracleFile, null, 2) + "\n");

  // -- Summary report on stdout. The comparator G8 reads results.json,
  //    not this stdout; the human reader uses it for at-a-glance health.
  const succPct = (100 * totals.success / totals.records).toFixed(2);
  process.stdout.write(
    `[scipy-gamma-adapter] wrote ${outPath}\n` +
      `  oracle:                 SciPy ${meta.scipy_version} / Python ${meta.python_version} / NumPy ${meta.numpy_version}\n` +
      `  total records:          ${totals.records}\n` +
      `  success:                ${totals.success}  (${succPct}%)\n` +
      `  refused:                ${totals.refused}\n` +
      `  unsupported:            ${totals.unsupported}\n` +
      `  error:                  ${totals.error}\n` +
      `  real inputs:            ${totals.real_inputs}\n` +
      `  complex inputs:         ${totals.complex_inputs}\n` +
      `  by_landmine:            ${JSON.stringify(totals.by_landmine)}\n` +
      `  by_refuse_token:        ${JSON.stringify(totals.by_refuse_token)}\n` +
      `  wall-time:              ${(totalElapsedMs / 1000).toFixed(2)} s\n`,
  );
}

if (import.meta.main) {
  await main();
}
