// =============================================================================
// bench/gamma-anchor/oracles/mpmath/adapter.ts
// =============================================================================
//
// mpmath gold-tier oracle adapter for the Gamma-anchor golden-master corpus
// (Phase 1 G3, bead `scientist-workbench-5x31`, ADR-0042 §"Decision 8").
//
// This module reads `bench/gamma-anchor/corpus.json` (377 inputs across 8
// tiers × 19 ADMITTED_HEADS) and emits
// `bench/gamma-anchor/oracles/mpmath/results.json`, a parallel-shape
// manifest of arb-prec golden-master values produced by mpmath 1.3.0 at
// `mp.dps = 60` compute and `nstr(_, 60, strip_zeros=False)` emit.
//
// mpmath sits at the **gold tier** of the R5 oracle hierarchy alongside
// Wolfram Mathematica 14.3 and (when installed) Arb / python-flint. The
// three-way agreement of (Wolfram + mpmath + Arb) is the cross-validation
// baseline the V1 verification gate rests on. mpmath is the load-bearing
// open-source voice on the complex-Gamma branch — R5 §1 records that
// without mpmath there is no independent open-source complex arb-prec
// oracle to set against Wolfram for the gamma family (no Boost complex,
// no SciPy complex polygamma, no native libm beyond `tgamma`/`lgamma`).
//
// -----------------------------------------------------------------------------
// Why mpmath
// -----------------------------------------------------------------------------
//
// mpmath is the canonical pure-Python arb-prec multiprecision library. It
// implements `mp.mpf` (real) and `mp.mpc` (complex) on top of Python `int`
// arithmetic — bit-identical across CPython runtimes by construction
// (Python `int` is bit-identical by language spec). For the gamma family
// it ships native primitives for the bulk of our 19 ADMITTED_HEADS:
// `gamma`, `loggamma`, `digamma`, `polygamma(m, z)` (all m ≥ 0; covers
// Trigamma at m=1), `rf` (Pochhammer = rising factorial), `gammainc(a, z,
// b, regularized)` (covers Upper / Lower / P / Q via the L12 mapping),
// `beta`, `betainc`, `barnesg`. The two non-natives are:
//
//   - **LogBeta**: composed as `lgamma(a) + lgamma(b) - lgamma(a+b)`.
//   - **GammaPDerivative**: ∂P(a, z)/∂z = z^{a-1} e^{-z} / Γ(a) (DLMF §8.8.13).
//   - **GammaRatio / GammaDeltaRatio**: direct ratios at 60-dp gold precision
//     — no need for lgamma-stabilisation when working at gold tier.
//
// The two genuinely unsupported heads are:
//
//   - **InverseIncompleteGammaP / Q**: mpmath has no native function.
//     R5 §3.2 (lines 314-326) documents the `mp.findroot` workaround;
//     the bead prompt directs an honest `status: "unsupported"` refusal
//     rather than a non-byte-deterministic findroot substitution.
//
// -----------------------------------------------------------------------------
// The 60-dps-compute / 60-dp-emit policy (bead-prompt directive)
// -----------------------------------------------------------------------------
//
// The bead prompt pins `mp.dps = 60` (compute, working precision) and
// "emit at 60dp" (let mpmath print at `mp.dps`). The gold-tier target is
// 50 decimal digits of correctly-rounded answer per input. The 10-dp
// guard above the target absorbs mpmath's per-algorithm internal
// precision bumps (Stirling-shift near integers; CF stagnation in the
// Temme saddle region T7; cot reflection at digamma negative-z T8).
//
// We emit at the full working precision (60 dp) rather than the Bessel
// adapter's 55-dp truncation because:
//
//   - The bead prompt explicitly says "emit at 60dp".
//   - The corpus's `expected_decimals_per_value: 60` declares the wire
//     contract; matching it gives the comparator 60 decimal digits to
//     compare byte-for-byte after applying its `precision − 1`
//     tolerance.
//   - Wolfram's `N[x, 60]` truncates at 60 dp; emitting mpmath at 60 dp
//     puts both gold oracles on the same digit-width. The L2 rounding-
//     mode mismatch (mpmath round-to-nearest vs Wolfram truncate) is
//     handled by the G8 comparator (`bench/gamma-anchor/cross-
//     agreement.ts`) treating last-digit divergence as info-severity.
//
// -----------------------------------------------------------------------------
// Subprocess discipline — Bun.spawn, single python3 child, sibling .py
// -----------------------------------------------------------------------------
//
// We spawn `python3` exactly ONCE via `Bun.spawn` (NOT `node:child_process`).
// The Python payload lives in a sibling file `oracle.py`. Same rationale
// as the besselj adapter (worklog 027): independent smoke-testability of
// the .py file, syntax-highlighting fidelity, ~30% TS file length saved.
//
// The TS layer's job is exactly four things: feed the corpus to Python on
// stdin; collect the JSON result blob from stdout; merge with corpus
// metadata + Bun-side wall-time; write the final `results.json`. The
// Python is the *oracle*; the TS is the *driver*.
//
// -----------------------------------------------------------------------------
// Output schema — matches ADR-0042 §"Decision 8" and the G8 comparator
// -----------------------------------------------------------------------------
//
//   {
//     "oracle_id": "mpmath",
//     "oracle_version": "mpmath 1.3.0 / Python 3.12.3",
//     "python_version": "...",
//     "generated_at": "ISO-8601 UTC",
//     "corpus_seed": 20260519,
//     "corpus_bead": "scientist-workbench-0kq3",
//     "corpus_adr": "0042",
//     "tier": "gold",
//     "precision_decimals_compute": 60,
//     "precision_decimals_emit": 60,
//     "per_input_timeout_s": 30,
//     "total_elapsed_ms": <number>,
//     "results": [
//       { "input_id": "T1-gamma-001",
//         "status": "success" | "complex-success" | "refused"
//                 | "unsupported" | "timeout" | "error",
//         "value": "<60-dp string>" | {"re":"...","im":"..."} | null,
//         "mpmath_returned_token": "inf" | "nan" | "+inf" | "-inf"
//                                | "ValueError: gamma function pole",   // refusal only
//         "elapsed_ms": <number>,
//         "notes": "..." | null },
//       ...
//     ],
//     "totals": { "success": N, "complex_success": N, "refused": N,
//                 "unsupported": N, "timeout": N, "error": N }
//   }
//
// Per-status semantics:
//
//   - `success` — finite real mpf; `value` is a 60-dp decimal string.
//   - `complex-success` — finite mpc; `value` is `{re, im}`. Includes
//     T4 complex-input cells AND real-input cells whose analytic
//     continuation is complex (LogGamma at real negative non-integer;
//     BarnesG ditto).
//   - `refused` — pole hit (L_pole / L17). mpmath either raised
//     `ValueError("gamma function pole")` (Gamma, LogGamma) or returned
//     an inf/nan (Digamma, Polygamma at poles). Records the verbatim
//     token in `mpmath_returned_token`. G8 special-cases pole cells —
//     does not penalise diverging oracle behaviour at exact poles.
//   - `unsupported` — `InverseIncompleteGamma{P,Q}` cells. mpmath has no
//     native; honest refusal beats a non-byte-deterministic findroot
//     substitution.
//   - `timeout` — per-input wall-time exceeded 30 s. Not expected for
//     the v0.1 gamma corpus (no extreme-magnitude cells like besselj's
//     `K_{500}(1000)`).
//   - `error` — mpmath raised an unhandled exception. `notes` carries
//     `type(e).__name__: str(e)`.
//
// -----------------------------------------------------------------------------
// Re-run
// -----------------------------------------------------------------------------
//
//   bun bench/gamma-anchor/oracles/mpmath/adapter.ts
//
// Determinism: byte-identical re-runs given identical `corpus.json` +
// identical mpmath / python3 versions. The fields that DO change between
// runs are `generated_at`, `total_elapsed_ms`, and per-row `elapsed_ms` —
// timing metadata, not oracle outputs.
//
// Expected wall-time: 5-30 s end-to-end for the 377-input corpus on a
// typical Linux x86_64 desktop. mpmath warm-batch throughput is
// ~200-600 evaluations/second at 60 dps for typical inputs.
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// -----------------------------------------------------------------------------
// Types — match the corpus and oracle-result shapes
// -----------------------------------------------------------------------------

interface KindField {
  readonly kind: "integer" | "half-integer" | "decimal";
  readonly value: string;
}

interface CorpusInputBase {
  readonly id: string;
  readonly tier: string;
  readonly head: string;
  readonly notes?: string;
}

/** A corpus row can carry any subset of {z, a, b, m, n} depending on head arity. */
type CorpusInput = CorpusInputBase & {
  readonly z?: string | { readonly re: string; readonly im: string };
  readonly a?: KindField;
  readonly b?: KindField;
  readonly m?: KindField;
  readonly n?: KindField;
};

interface Corpus {
  readonly manifest_version: number;
  readonly generated_at: string;
  readonly bead: string;
  readonly adr: string;
  readonly seed: number;
  readonly inputs: readonly CorpusInput[];
}

/** One python-emitted row (minus the index-0 __meta__ sentinel). */
interface PyRow {
  readonly id: string;
  readonly status:
    | "success"
    | "complex-success"
    | "refused"
    | "unsupported"
    | "timeout"
    | "error";
  readonly real?: string;
  readonly complex?: { readonly re: string; readonly im: string };
  readonly mpmath_returned_token?: string;
  readonly note?: string;
  readonly elapsed_ms: number;
}

interface PyMeta {
  readonly __meta__: true;
  readonly mpmath_version: string;
  readonly python_version: string;
  readonly work_dps: number;
  readonly emit_dps: number;
  readonly per_input_timeout_s: number;
}

interface ResultRecord {
  readonly input_id: string;
  readonly status: PyRow["status"];
  readonly value: string | { re: string; im: string } | null;
  readonly mpmath_returned_token: string | null;
  readonly elapsed_ms: number;
  readonly notes: string | null;
}

interface ResultsEnvelope {
  readonly oracle_id: "mpmath";
  readonly oracle_version: string;
  readonly python_version: string;
  readonly generated_at: string;
  readonly corpus_seed: number;
  readonly corpus_bead: string;
  readonly corpus_adr: string;
  readonly corpus_generated_at: string;
  readonly tier: "gold";
  readonly precision_decimals_compute: number;
  readonly precision_decimals_emit: number;
  readonly per_input_timeout_s: number;
  readonly total_corpus_inputs: number;
  readonly total_elapsed_ms: number;
  readonly results: readonly ResultRecord[];
  readonly totals: {
    readonly success: number;
    readonly complex_success: number;
    readonly refused: number;
    readonly unsupported: number;
    readonly timeout: number;
    readonly error: number;
  };
}

// -----------------------------------------------------------------------------
// TS driver
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusPath = join(here, "..", "..", "corpus.json");
  const resultsPath = join(here, "results.json");
  const oraclePyPath = join(here, "oracle.py");

  if (!existsSync(oraclePyPath)) {
    process.stderr.write(`mpmath adapter: missing sibling oracle.py at ${oraclePyPath}\n`);
    process.exit(1);
  }
  if (!existsSync(corpusPath)) {
    process.stderr.write(`mpmath adapter: missing corpus.json at ${corpusPath}\n`);
    process.exit(1);
  }

  // -- Smoke-test python3 + mpmath before we pay the corpus-load cost. -----
  const probe = Bun.spawn(
    ["python3", "-c", "import mpmath, sys; print(mpmath.__version__); print(sys.version.split()[0])"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const probeExit = await probe.exited;
  if (probeExit !== 0) {
    const errOut = await new Response(probe.stderr).text();
    process.stderr.write(
      `mpmath adapter: smoke-test failed (python3 -c 'import mpmath' exited ${probeExit}).\n` +
        `stderr:\n${errOut}\n\n` +
        `Per R5 §3.2, mpmath 1.3.0 / Python 3.12.3 are documented as available on the\n` +
        `reference machine. On a fresh machine: \`pip install --user mpmath\` (or\n` +
        `\`apt install python3-mpmath\` on Debian / Ubuntu).\n`,
    );
    process.exit(1);
  }
  const probeOut = (await new Response(probe.stdout).text()).trim();
  process.stdout.write(`mpmath adapter: smoke-test OK (${probeOut.replace("\n", " / python3 ")})\n`);

  // -- Load the corpus and forward the bare {inputs:[...]} envelope. -------
  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: Corpus = JSON.parse(corpusRaw);
  const pythonStdin = JSON.stringify({ inputs: corpus.inputs });

  process.stdout.write(
    `mpmath adapter: loaded corpus (${corpus.inputs.length} inputs, seed=${corpus.seed}); spawning oracle.py ...\n`,
  );

  // -- Spawn the single python3 child. Stream stderr line-by-line so the
  //    progress messages oracle.py emits every 50 rows surface promptly.
  const t0 = performance.now();
  const proc = Bun.spawn(["python3", oraclePyPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(pythonStdin);
  await proc.stdin.end();

  // Drain stdout, stderr, and exit concurrently — back-pressure deadlock
  // documented in worklog 027 (Bun pipe buffer ~64 KiB; our gamma payload
  // is small but the discipline is the same).
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const totalElapsedMs = performance.now() - t0;

  if (exitCode !== 0) {
    process.stderr.write(`mpmath adapter: oracle.py exited ${exitCode}\n`);
    process.stderr.write(`stderr:\n${stderrText}\n`);
    process.stderr.write(`stdout head:\n${stdoutText.slice(0, 500)}\n`);
    process.exit(1);
  }
  if (stderrText.length > 0) {
    // Python may have emitted progress / DeprecationWarning; surface but
    // don't fail.
    process.stderr.write(`mpmath adapter: python stderr:\n${stderrText}\n`);
  }

  // -- Parse the python output. Index 0 is the meta sentinel; rows follow.
  let parsed: ReadonlyArray<PyMeta | PyRow>;
  try {
    parsed = JSON.parse(stdoutText) as ReadonlyArray<PyMeta | PyRow>;
  } catch (e) {
    process.stderr.write(
      `mpmath adapter: failed to parse python stdout as JSON: ${(e as Error).message}\n` +
        `stdout head: ${stdoutText.slice(0, 500)}\n`,
    );
    process.exit(1);
  }

  const meta = parsed[0] as PyMeta;
  if (!meta || meta.__meta__ !== true) {
    process.stderr.write(
      `mpmath adapter: missing __meta__ sentinel at index 0; got ${JSON.stringify(parsed[0])}\n`,
    );
    process.exit(1);
  }
  const pyRows = parsed.slice(1) as ReadonlyArray<PyRow>;

  if (pyRows.length !== corpus.inputs.length) {
    process.stderr.write(
      `mpmath adapter: result count mismatch: corpus=${corpus.inputs.length}, results=${pyRows.length}\n`,
    );
    process.exit(1);
  }

  // -- Merge the per-row python output with the corpus row id, validating
  //    order. Order-validation is load-bearing: if the python side ever
  //    reorders or skips a row, the comparator's by-index access would
  //    silently mis-pair inputs.
  const records: ResultRecord[] = new Array(pyRows.length);
  const tally = {
    success: 0,
    complex_success: 0,
    refused: 0,
    unsupported: 0,
    timeout: 0,
    error: 0,
  };
  for (let i = 0; i < pyRows.length; i++) {
    const inp = corpus.inputs[i];
    const r = pyRows[i];
    if (r.id !== inp.id) {
      process.stderr.write(
        `mpmath adapter: id-order mismatch at row ${i}: corpus=${inp.id} python=${r.id}\n`,
      );
      process.exit(1);
    }

    // Coerce the python payload into the unified `value` field.
    let value: ResultRecord["value"];
    if (r.real !== undefined) {
      value = r.real;
    } else if (r.complex !== undefined) {
      value = { re: r.complex.re, im: r.complex.im };
    } else {
      value = null;
    }

    records[i] = {
      input_id: r.id,
      status: r.status,
      value,
      mpmath_returned_token: r.mpmath_returned_token ?? null,
      elapsed_ms: r.elapsed_ms,
      notes: r.note ?? null,
    };

    // Tally — exhaustive switch surfaces a TS compile-time error if the
    // python side ever invents a new status.
    switch (r.status) {
      case "success":
        tally.success += 1;
        break;
      case "complex-success":
        tally.complex_success += 1;
        break;
      case "refused":
        tally.refused += 1;
        break;
      case "unsupported":
        tally.unsupported += 1;
        break;
      case "timeout":
        tally.timeout += 1;
        break;
      case "error":
        tally.error += 1;
        break;
      default: {
        const _exhaustive: never = r.status;
        void _exhaustive;
        process.stderr.write(`mpmath adapter: unknown status ${r.status} at row ${i}\n`);
        process.exit(1);
      }
    }
  }

  const envelope: ResultsEnvelope = {
    oracle_id: "mpmath",
    oracle_version: `mpmath ${meta.mpmath_version} / Python ${meta.python_version.split(" ")[0]}`,
    python_version: meta.python_version,
    generated_at: new Date().toISOString(),
    corpus_seed: corpus.seed,
    corpus_bead: corpus.bead,
    corpus_adr: corpus.adr,
    corpus_generated_at: corpus.generated_at,
    tier: "gold",
    precision_decimals_compute: meta.work_dps,
    precision_decimals_emit: meta.emit_dps,
    per_input_timeout_s: meta.per_input_timeout_s,
    total_corpus_inputs: corpus.inputs.length,
    total_elapsed_ms: totalElapsedMs,
    results: records,
    totals: tally,
  };

  writeFileSync(resultsPath, JSON.stringify(envelope, null, 2) + "\n");

  // Honest-mathematical-answer fraction: success + complex-success +
  // refused (pole-honest) + unsupported (head-honest). Only `timeout`
  // and `error` count as adapter-side failures.
  const honestCount =
    tally.success + tally.complex_success + tally.refused + tally.unsupported;
  const honestFraction = honestCount / corpus.inputs.length;

  process.stdout.write(
    `mpmath adapter: wrote ${resultsPath}\n` +
      `  oracle:                 mpmath ${meta.mpmath_version} / python ${meta.python_version.split(" ")[0]}\n` +
      `  total inputs:           ${corpus.inputs.length}\n` +
      `  success (real):         ${tally.success}\n` +
      `  success (complex):      ${tally.complex_success}\n` +
      `  refused (poles):        ${tally.refused}\n` +
      `  unsupported (head):     ${tally.unsupported}\n` +
      `  timeout:                ${tally.timeout}\n` +
      `  error:                  ${tally.error}\n` +
      `  honest fraction:        ${(honestFraction * 100).toFixed(2)}%\n` +
      `  wall-time:              ${(totalElapsedMs / 1000).toFixed(2)} s\n` +
      `  precision compute/emit: ${meta.work_dps} / ${meta.emit_dps} dp\n`,
  );

  // Honest-quality gate: ≥ 95 % "honest mathematical answer" (success +
  // complex-success + refused + unsupported). The remaining 5 % is the
  // hard-error / timeout tail.
  if (honestFraction < 0.95) {
    process.stderr.write(
      `\nmpmath adapter: honest fraction ${(honestFraction * 100).toFixed(2)}% is below the\n` +
        `95% acceptance threshold from bead scientist-workbench-5x31. Inspect\n` +
        `${resultsPath} for the failing rows (filter status === 'timeout' || status === 'error').\n`,
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
