// =============================================================================
// bench/besselj-anchor/oracles/mpmath/adapter.ts
// =============================================================================
//
// mpmath gold-tier oracle adapter for the Bessel-anchor golden-master corpus
// (Phase 1 G3, bead `scientist-workbench-g70g`, ADR-0041 §"Decision 8").
//
// This module reads `bench/besselj-anchor/corpus.json` (1766 inputs across
// 10 tiers × 6 heads × 3 ν-classes) and emits
// `bench/besselj-anchor/oracles/mpmath/results.json`, a parallel-shape
// manifest of arb-prec golden-master values produced by mpmath 1.3.0 at
// `mp.dps = 60` compute and `nstr(_, 55, strip_zeros=False)` emit.
//
// mpmath sits at the **gold tier** of the R5 oracle hierarchy alongside
// Wolfram Mathematica 14.3 and (when installed) Arb / python-flint. The
// three-way agreement of (Wolfram + mpmath + Arb) is the cross-validation
// baseline the V1 verification gate rests on. mpmath is the load-bearing
// open-source voice on the complex-Bessel branch — R5 §1 records that
// without mpmath there is no independent open-source complex arb-prec
// oracle to set against Wolfram.
//
// -----------------------------------------------------------------------------
// Why mpmath
// -----------------------------------------------------------------------------
//
// mpmath is the canonical pure-Python arb-prec multiprecision library. It
// implements `mp.mpf` (real) and `mp.mpc` (complex) on top of Python `int`
// arithmetic — bit-identical across CPython runtimes by construction
// (Python `int` is bit-identical by language spec). For the Bessel family
// it ships native `besselj` / `bessely` / `besseli` / `besselk` with the
// classical algorithm dispatch (₀F₁ Maclaurin near origin, Hankel
// asymptotic at large |z|, cancellation-retry in between — see R2 §3 for
// the FLINT-tradition references mpmath shares). The scaled variants
// `BesselIScaled` (= `exp(-|Re z|) · I_ν(z)`) and `BesselKScaled` (=
// `exp(z) · K_ν(z)`) are not native to mpmath; we compose them as
// `mpmath.exp(...) · mpmath.bessel{i,k}(...)` (matches ADR-0041
// §"Decision 3" substrate contract and the Amos `kode=2` convention).
//
// -----------------------------------------------------------------------------
// The 60-dps-compute / 55-dp-emit margin (ADR-0041 §"Decision 8", L2 mitigation)
// -----------------------------------------------------------------------------
//
// The gold-tier target is 50 decimal digits of correctly-rounded answer per
// input. We set `mp.dps = 60` (10 dp above the gold target) for the compute
// and format via `mpmath.nstr(value, 55, strip_zeros=False)` for emission.
// Both margins are load-bearing:
//
//   - The **10-dp compute margin** absorbs mpmath's per-algorithm internal
//     precision bumps for near-boundary inputs: the Hankel-asymptotic
//     crossover at |z| ≈ p/2 (R2 §3.1), the negative-ν branch's
//     `cos(ν π)` cancellation (Decision 13 L3), and the integer-vs-near-
//     integer-ν jump (R5 L8).
//
//   - The **5-dp emit margin** below the working precision strips the
//     2-3 trailing digits that mpmath's `nstr` round-to-nearest emits as
//     numerical residue. mpmath rounds-to-nearest while Wolfram `N[]`
//     truncates (R5 §3.2; landmine **L2**). Trimming to 55 digits
//     canonicalises this mismatch — by the time the G8 cross-agreement
//     comparator compares Wolfram-55 to mpmath-55, both adapters have
//     shed their last-digit rounding-mode noise.
//
// -----------------------------------------------------------------------------
// Subprocess discipline — Bun.spawn, single python3 child, sibling .py
// -----------------------------------------------------------------------------
//
// We spawn `python3` exactly ONCE via `Bun.spawn` (NOT `node:child_process`
// — sanity rail from the bead prompt; matches the ADR-0001 spirit even
// though that ADR is specifically about bun-resolver corner-cases). The
// Python payload lives in a sibling file `oracle.py` rather than as an
// inline string literal. The decision:
//
//   - The Python is ~280 LOC (corpus parsing + 6-head dispatch + special-
//     token classifier + SIGALRM-based per-input timeout + literate
//     comments documenting the L2/L3/L9/L10 mitigations). Inlining it in
//     the TS source as a template-literal would (a) break syntax-
//     highlighting and lint discipline for the Python; (b) make the
//     per-input-timeout code unreadable; (c) cost ~30% TS file length
//     for content no TS reader cares about. Erf G3 inlined because Erf's
//     Python payload was 130 LOC and had no SIGALRM logic.
//
//   - The sibling .py is independently smoke-testable:
//     `python3 oracle.py < ../../corpus.json | head -2`. This matters
//     when debugging — the TS layer is a thin orchestrator and any
//     real failure is in the Python.
//
//   - The sibling .py is invokable from any other harness (Make, CI
//     scripts the user might add later, ad-hoc python REPL) without
//     parsing the TS first.
//
// The TS layer's job is exactly four things: feed the corpus to Python on
// stdin; collect the JSON result blob from stdout; merge with corpus
// metadata + Bun-side wall-time; write the final `results.json`. The
// Python is the *oracle*; the TS is the *driver*.
//
// -----------------------------------------------------------------------------
// Output schema — matches ADR-0041 §"Decision 8" and the G8 comparator's
//                 expected adapter shape
// -----------------------------------------------------------------------------
//
//   {
//     "oracle_id": "mpmath",
//     "oracle_version": "mpmath <ver> / Python <ver>",
//     "generated_at": "ISO-8601 UTC",
//     "corpus_seed": <number, copied from corpus.json>,
//     "corpus_bead": "scientist-workbench-qccc",
//     "corpus_adr": "0041",
//     "tier": "gold",
//     "precision_decimals_compute": 60,
//     "precision_decimals_emit": 55,
//     "per_input_timeout_s": 30,
//     "total_elapsed_ms": <number>,
//     "results": [
//       { "input_id": "T1-besselj-001",
//         "status": "success" | "complex-success"
//                 | "honest-special-token" | "refused" | "timeout" | "error",
//         "value": "<55-dp string>" | {"re":"...","im":"..."},
//         "elapsed_ms": <number>,
//         "notes": "<optional context>" | null },
//       ...
//     ],
//     "totals": { "success": N,
//                 "complex_success": N,
//                 "honest_special_token": N,
//                 "refused": N,
//                 "timeout": N,
//                 "error": N }
//   }
//
// The "complex-success" status is separated from "success" so the G8
// comparator can audit the negative-real-z → complex-output cases (e.g.
// `Y(0, -1)` and `K(0, -1)` cross the branch cut). The "honest-special-
// token" status flags the IEEE-754-shaped inputs (NaN / ±Infinity) the
// corpus's T6 tier exercises — these are answered without invoking
// mpmath (mpmath itself raises TypeError on `besselj(0, mpf('inf'))`;
// see `oracle.py:classify_special_token`).
//
// -----------------------------------------------------------------------------
// Re-run
// -----------------------------------------------------------------------------
//
//   bun bench/besselj-anchor/oracles/mpmath/adapter.ts
//
// Determinism: byte-identical re-runs given identical `corpus.json` +
// identical mpmath / python3 versions. The `oracle_version` and
// `python_version` strings are written into every results.json so two
// snapshots from different environments are mechanically diffable.
//
// Expected wall-time: 10–30 s end-to-end for the 1766-input corpus on
// a typical Linux x86_64 desktop. mpmath warm-batch throughput is
// ~200-600 evaluations/second at 60 dps for typical inputs (R5 §3.2);
// the long-tail large-|z|/large-ν inputs in T3/T7/T10 add a few seconds.
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// -----------------------------------------------------------------------------
// Types — match the corpus and oracle-result shapes
// -----------------------------------------------------------------------------

interface CorpusInputBase {
  readonly id: string;
  readonly tier: string;
  readonly head: string;
  readonly nu_kind: "integer" | "half-integer" | "decimal";
  readonly nu: string;
  readonly notes?: string;
}
type RealCorpusInput = CorpusInputBase & { readonly z: string };
type ComplexCorpusInput = CorpusInputBase & {
  readonly z: { readonly re: string; readonly im: string };
};
type CorpusInput = RealCorpusInput | ComplexCorpusInput;

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
    | "honest-special-token"
    | "refused"
    | "timeout"
    | "error";
  readonly real?: string;
  readonly complex?: { readonly re: string; readonly im: string };
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
    readonly honest_special_token: number;
    readonly refused: number;
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
  // A 5-second smoke-test failure is much better than a 30-second corpus-
  // load-then-immediate-crash. We probe explicitly for `import mpmath`
  // because the bare `python3 --version` doesn't tell us whether mpmath
  // is actually importable in the user's env.
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

  // -- Load the corpus and forward the bare {inputs:[...]} envelope to ----
  // Python on stdin. We strip the corpus's outer metadata before forwarding
  // because (a) the oracle.py doesn't need it; (b) it keeps the stdin
  // payload small and the JSON round-trip fast.
  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: Corpus = JSON.parse(corpusRaw);
  const pythonStdin = JSON.stringify({ inputs: corpus.inputs });

  process.stdout.write(
    `mpmath adapter: loaded corpus (${corpus.inputs.length} inputs, seed=${corpus.seed}); spawning oracle.py ...\n`,
  );

  // -- Spawn the single python3 child. We use Bun.spawn (NOT node:child_process)
  //    per the bead's sanity rail. The Python script is a sibling file so we
  //    invoke it as a positional argument; the stdin pipe carries the corpus.
  const t0 = performance.now();
  const proc = Bun.spawn(["python3", oraclePyPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(pythonStdin);
  await proc.stdin.end();

  // Drain stdout and stderr fully before checking exit, to avoid the
  // back-pressure deadlock pattern documented in worklog 027 (the Bun
  // pipe buffer is ~64 KiB; our payload is ~1.5 MiB so we MUST drain
  // concurrently with the child running).
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
    // Python may have emitted warnings (e.g. DeprecationWarning); surface
    // them but don't fail the run.
    process.stderr.write(`mpmath adapter: python stderr (non-fatal):\n${stderrText}\n`);
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
  //    order. The validation is load-bearing: if the python side ever
  //    reorders or skips a row, the comparator's by-index access would
  //    silently mis-pair inputs.
  const records: ResultRecord[] = new Array(pyRows.length);
  const tally = {
    success: 0,
    complex_success: 0,
    honest_special_token: 0,
    refused: 0,
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
      elapsed_ms: r.elapsed_ms,
      notes: r.note ?? null,
    };

    // Tally — switch on every status to surface a TS compile-time
    // exhaustiveness check if the python side ever invents a new one.
    switch (r.status) {
      case "success":
        tally.success += 1;
        break;
      case "complex-success":
        tally.complex_success += 1;
        break;
      case "honest-special-token":
        tally.honest_special_token += 1;
        break;
      case "refused":
        tally.refused += 1;
        break;
      case "timeout":
        tally.timeout += 1;
        break;
      case "error":
        tally.error += 1;
        break;
      default: {
        // Force an exhaustiveness check; if a new status appears here we
        // want the TS layer to refuse the run rather than silently miscount.
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

  const successFraction =
    (tally.success + tally.complex_success + tally.honest_special_token) / corpus.inputs.length;

  process.stdout.write(
    `mpmath adapter: wrote ${resultsPath}\n` +
      `  oracle:                 mpmath ${meta.mpmath_version} / python ${meta.python_version.split(" ")[0]}\n` +
      `  total inputs:           ${corpus.inputs.length}\n` +
      `  success (real):         ${tally.success}\n` +
      `  success (complex):      ${tally.complex_success}\n` +
      `  honest special token:   ${tally.honest_special_token}\n` +
      `  refused:                ${tally.refused}\n` +
      `  timeout:                ${tally.timeout}\n` +
      `  error:                  ${tally.error}\n` +
      `  success fraction:       ${(successFraction * 100).toFixed(2)}%\n` +
      `  wall-time:              ${(totalElapsedMs / 1000).toFixed(2)} s\n` +
      `  precision compute/emit: ${meta.work_dps} / ${meta.emit_dps} dp\n`,
  );

  // Honest-quality gate per the bead's acceptance criterion 3: ≥ 95 %
  // success (success + complex-success + honest-special-token; mpmath's
  // honest mathematical answers all count). The remaining 5 % is the
  // hard-error / timeout tail we expose to the G8 audit comparator.
  if (successFraction < 0.95) {
    process.stderr.write(
      `\nmpmath adapter: success fraction ${(successFraction * 100).toFixed(2)}% is below the\n` +
        `95% acceptance threshold from bead scientist-workbench-g70g. Inspect\n` +
        `${resultsPath} for the failing rows (filter status !== 'success' &&\n` +
        `status !== 'complex-success' && status !== 'honest-special-token').\n`,
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
