// =============================================================================
// bench/gamma-anchor/oracles/arb/adapter.ts
// =============================================================================
//
// Arb (via python-flint 0.8.0 + FLINT 3.0.1) GOLD-tier oracle adapter for the
// Gamma-anchor golden-master corpus (Phase 1 G7, bead
// `scientist-workbench-2wr6`, ADR-0042 §"Decision 8").
//
// Sibling driver to `bench/gamma-anchor/oracles/mpmath/adapter.ts`. The
// two-file split — TS driver here, Python worker in `oracle.py` — mirrors
// the mpmath adapter exactly. Identical wire shapes for both gold-tier
// voices means the G8 cross-agreement comparator can index records by
// `input_id` alone, without per-oracle conditioning.
//
// -----------------------------------------------------------------------------
// Why Arb closes the load-bearing complex-arb-prec gap
// -----------------------------------------------------------------------------
//
// The R5 oracle-landscape survey (`docs/refs/gamma-research/R5-oracle-
// landscape.md` §1, §3, §4) found that of the 19 ADMITTED_HEADS × {real,
// complex} capability cells in the gamma family, the 34 COMPLEX cells were
// SINGLE-ENGINE-PAIRED at gold tier prior to this adapter:
//
//   - Boost.Math `cpp_bin_float<50>` fails to instantiate on
//     `std::complex<cpp_bin_float<N>>` (R5 §3.4 + §4) — no silver complex.
//   - SciPy 1.11.4's `polygamma(complex)` raises TypeError (L14); SciPy's
//     `loggamma(real_negative)` returns NaN (L15) — partial bronze complex.
//   - libm covers only `tgamma` + `lgamma` real (R5 §3.5) — no complex.
//
// So the 34 complex cells had only Wolfram + mpmath at gold tier. For Erf
// this gap was 1 cell; for Bessel, 12; for Gamma, 34. The 34× multiplier
// is what justifies the install — without an independent third arb-prec
// voice on the complex side, the cross-agreement matrix has 34 rows that
// cannot be elevated above "two engines, possibly correlated" confidence.
// Arb closes all 34 in one adapter.
//
// **Algorithmic independence.** The three gold-tier engines have three
// distinct algorithmic lineages:
//
//   - **Wolfram**: proprietary; documented as a dispatch family covering
//     Stirling, series, and connection formulas.
//   - **mpmath**: pure-Python over Python `int`; `mpmath.libmp.gammazeta`
//     and friends — hand-coded series + Adamchik continuations.
//   - **Arb**: FLINT C; `acb_hypgeom_gamma_upper.c`, `acb_hypgeom_beta_
//     lower.c`, `acb_hypgeom_barnes_g.c`, etc. — Fredrik Johansson's
//     rigorous hypergeometric-series + ball-arithmetic asymptotic
//     machinery, citing DLMF and Olver.
//
// Three implementations, three lineages — the algorithmic-independence
// property that makes a triangulation finding load-bearing.
//
// -----------------------------------------------------------------------------
// Ball-arithmetic radius is real error information — first-class output
// -----------------------------------------------------------------------------
//
// Arb's distinguishing feature vs every other oracle on the list: every
// computed value is a *ball* `[centre ± radius]` with mathematically-
// rigorous containment. The radius is a tight upper bound on the true
// error, computed by error-tracking through every internal operation.
// This is fundamentally different from mpmath's "ran at 60 dps so the
// first ~57 digits should be right" — that is conjecturally correct, not
// certified; mpmath has no internal error model. Arb has one.
//
// We therefore record BOTH the midpoint AND the radius as first-class
// fields on every successful record (`value` and `value_radius`). For
// complex results, `value_radius` is itself `{re, im}` — the ball is
// two-dimensional in C. The G8 cross-agreement comparator can then:
//
//   1. Use the midpoint for value comparison (the standard role).
//   2. Use the radius as the TIER-THRESHOLD floor: if Arb reports a radius
//      of `1e-58` on a value where Wolfram and mpmath disagree at digit
//      56, the disagreement is *spurious* — both gold engines fall within
//      Arb's certified containment ball. Conversely, if mpmath claims
//      digit 56 of agreement but Arb's radius is `1e-55`, mpmath is
//      overstating its precision and the agreement is illusory.
//
// This is the comparator-input ADR-0042 §"Decision 8" mentions when it
// admits Arb as "the third voice that returns a certified error bound."
//
// -----------------------------------------------------------------------------
// Precision discipline — 200 bits baseline + cancellation retry to 456 bits
// -----------------------------------------------------------------------------
//
// FLINT/Arb works in BITS (`ctx.prec`), not decimal digits. The bead
// prompt pins `ctx.prec = 200` baseline; in decimal digits that is
// 200 / log2(10) ≈ 60.2 dp — comfortably above the gold-tier target of
// 50 dp, with ~10 dp margin matching the mpmath adapter's WORK_DPS = 60.
// We emit midpoints at 55 dp for symmetry with the Bessel G7 emit (5-dp
// emit-vs-work margin).
//
// **Cancellation retry (L16 — the load-bearing Arb value-add).** When
// catastrophic cancellation widens Arb's ball — typical triggers:
// reflection near integer poles (T3, T8), Temme saddle (T7), digamma
// cot-reflection — we bump `ctx.prec` by 64 bits and retry, up to 4 times
// (final prec = 200 + 4·64 = 456 bits ≈ 137 dp). Threshold: if
// `relative-radius > 1e-50` after the attempt, bump. Each result row
// records the full `prec_attempts` ladder and `final_prec` so the G8
// comparator can audit which rows operated near a precision cliff.
//
// **Why bump? Why not just start at 456 bits?** Cost. The baseline pays
// for the typical (~98%) of corpus rows that need exactly 200 bits.
// Bumping only the few rows that need it keeps total wall-time under
// ~60 s for the 377-input corpus. The retry pattern is also the
// mathematically-honest answer to "what should this adapter do when the
// answer has lost ≥ 50 dp of accuracy?" — fail UP, not fail silently.
//
// -----------------------------------------------------------------------------
// Subprocess discipline — Bun.spawn, single python3 child, sibling .py
// -----------------------------------------------------------------------------
//
// We spawn `python3` exactly ONCE via `Bun.spawn` (NOT `node:child_
// process`). The Python payload lives in a sibling file `oracle.py`. Same
// rationale as the mpmath gamma adapter (worklog 027): independent
// smoke-testability of the .py file, syntax-highlighting fidelity, ~30 %
// TS file length saved.
//
// The TS layer's job is exactly four things: feed the corpus to Python on
// stdin; collect the JSON result blob from stdout; merge with corpus
// metadata + Bun-side wall-time; write the final `results.json`. The
// Python is the *oracle*; the TS is the *driver*.
//
// -----------------------------------------------------------------------------
// Output schema — matches the mpmath sibling for G8 comparator uniformity
// -----------------------------------------------------------------------------
//
// The envelope shape mirrors `bench/gamma-anchor/oracles/mpmath/
// results.json` with Arb-specific extensions:
//
//   - `value_radius` field on every success record (mpmath has no
//     equivalent; mpmath's `nstr` carries no error model).
//   - `prec_attempts` + `final_prec` on every record (mpmath uses
//     compile-time mp.dps; no per-row prec ladder).
//   - `oracle_id: "arb"`, `tier: "gold"`.
//
// Per-status semantics:
//
//   - `success` — finite real result; `value` is a 55-dp decimal string,
//     `value_radius` is a 10-dp decimal string (the ball half-width).
//   - `complex-success` — finite complex result; `value` is `{re, im}`,
//     `value_radius` is `{re, im}` (parallel arrays of midpoint /
//     radius). Includes T4 complex-input cells AND real-input cells whose
//     analytic continuation is complex (LogGamma at real negative non-
//     integer; BarnesG ditto).
//   - `refused` — Arb returned a non-finite ball (pole hit). Records the
//     verbatim token in `arb_returned_token` ("nan" or "inf"). G8
//     special-cases pole cells.
//   - `unsupported` — `InverseIncompleteGamma{P,Q}` cells. python-flint
//     0.8.0 has no direct API; honest refusal beats a non-byte-
//     deterministic Newton substitution.
//   - `timeout` — per-input wall-time exceeded 30 s. Not expected on the
//     v0.1 corpus.
//   - `error` — Arb raised an unhandled exception. `notes` carries
//     `type(e).__name__: str(e)`.
//
// -----------------------------------------------------------------------------
// Determinism
// -----------------------------------------------------------------------------
//
// Arb's ball arithmetic at a given `ctx.prec` is deterministic given the
// `(input, prec)` bytes. FLINT C uses GMP/MPFR underneath; both guarantee
// bit-identical results across architectures at fixed precision. The
// midpoint AND radius are bit-identical across re-runs on the same FLINT
// version. The fields that DO change between runs are `generated_at`,
// `total_elapsed_ms`, and per-row `elapsed_ms` — timing metadata, not
// oracle outputs.
//
// -----------------------------------------------------------------------------
// Re-run
// -----------------------------------------------------------------------------
//
//   bun bench/gamma-anchor/oracles/arb/adapter.ts
//
// Expected wall-time: 10-60 s end-to-end for the 377-input corpus on a
// typical Linux x86_64 desktop. Arb is faster than mpmath on these shapes
// (ball arithmetic is O(prec) bit-op-bound, not O(prec²)); the dominant
// cost is the per-row retry chain on cancellation cells (T3, T7, T8).
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

/** A successful Arb result emits midpoint + ball-radius. Real → real strings; complex → {re, im} pairs. */
type ValueField = string | { re: string; im: string };

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
  /** Set on success / complex-success: midpoint of Arb's ball at emit precision. */
  readonly value?: ValueField;
  /** Set on success / complex-success: radius of Arb's ball — the certified error bound. */
  readonly value_radius?: ValueField;
  /** Set on refused: verbatim Arb non-finite token ("nan" | "inf"). */
  readonly arb_returned_token?: string;
  /** Set on degraded-precision success and on refused/error/unsupported/timeout. */
  readonly note?: string;
  /** Full bit-prec ladder tried (e.g. [200] for typical, [200, 264, 328] on bumps). Absent on timeout. */
  readonly prec_attempts?: number[];
  /** Final bit-prec at the successful (or last) attempt. Absent on timeout. */
  readonly final_prec?: number;
  readonly elapsed_ms: number;
}

interface PyMeta {
  readonly __meta__: true;
  readonly flint_version: string;
  readonly python_version: string;
  readonly baseline_prec_bits: number;
  readonly max_prec_bits: number;
  readonly prec_bump_bits: number;
  readonly max_retries: number;
  readonly emit_dp: number;
  readonly radius_emit_dp: number;
  readonly relative_radius_target: number;
  readonly per_input_timeout_s: number;
}

interface ResultRecord {
  readonly input_id: string;
  readonly status: PyRow["status"];
  readonly value: ValueField | null;
  readonly value_radius: ValueField | null;
  readonly arb_returned_token: string | null;
  readonly prec_attempts: number[] | null;
  readonly final_prec: number | null;
  readonly elapsed_ms: number;
  readonly notes: string | null;
}

interface ResultsEnvelope {
  readonly oracle_id: "arb";
  readonly oracle_version: string;
  readonly python_version: string;
  readonly generated_at: string;
  readonly corpus_seed: number;
  readonly corpus_bead: string;
  readonly corpus_adr: string;
  readonly corpus_generated_at: string;
  readonly tier: "gold";
  readonly method: string;
  readonly baseline_prec_bits: number;
  readonly max_prec_bits: number;
  readonly prec_bump_bits: number;
  readonly max_retries: number;
  readonly emit_dp: number;
  readonly radius_emit_dp: number;
  readonly relative_radius_target: number;
  readonly per_input_timeout_s: number;
  readonly total_corpus_inputs: number;
  readonly total_elapsed_ms: number;
  readonly cancellation_retries: {
    readonly rows_with_bump: number;
    readonly max_attempts_seen: number;
    readonly final_prec_histogram: Record<number, number>;
  };
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
    process.stderr.write(`arb adapter: missing sibling oracle.py at ${oraclePyPath}\n`);
    process.exit(1);
  }
  if (!existsSync(corpusPath)) {
    process.stderr.write(`arb adapter: missing corpus.json at ${corpusPath}\n`);
    process.exit(1);
  }

  // -- Smoke-test python3 + python-flint before paying the corpus-load cost.
  //    A successful smoke-test proves: python3 is on PATH; flint module
  //    imports; FLINT C library is loadable; acb.gamma works at the
  //    baseline ctx.prec. If any of those fail, we surface the error
  //    verbatim (CLAUDE.md Rule 1 — fail fast, fail loud) rather than
  //    discover a per-row exception storm at row 1.
  const probe = Bun.spawn(
    [
      "python3",
      "-c",
      // Smoke-test: Γ(0.5) = √π. The first 40 decimal digits are
      //   1.7724538509055160272981674833411451827975
      // — the rounded-at-emit string from `acb.str(N, radius=False)`
      // exactly matches this prefix at N ≥ 41 (verified across python-
      // flint 0.8.0 / FLINT 3.0.1). 40 digits is far above the smoke-
      // test threshold of "is this library actually producing arb-prec
      // gamma values?" and well inside the truncation-safe window
      // (rounding only affects the displayed terminal digit at the
      // chosen N, never digits below N).
      "import flint, sys; from flint import acb, ctx; " +
        "ctx.prec = 200; " +
        "v = acb('0.5').gamma(); " +
        "expected = '1.7724538509055160272981674833411451827975'; " +
        "got = v.real.str(60, radius=False); " +
        "assert got.startswith(expected), f'smoke-test mismatch: got {got!r}, expected prefix {expected!r}'; " +
        "print(flint.__version__); print(sys.version.split()[0])",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const probeExit = await probe.exited;
  if (probeExit !== 0) {
    const errOut = await new Response(probe.stderr).text();
    process.stderr.write(
      `arb adapter: smoke-test failed (python3 -c 'import flint; ...' exited ${probeExit}).\n` +
        `stderr:\n${errOut}\n\n` +
        `Per ADR-0042 §"Decision 8" + R5 §7.2, python-flint 0.8.0 and libflint-dev 3.0.1\n` +
        `are documented as the reference install for this adapter. Install with:\n` +
        `  sudo apt install libflint-dev\n` +
        `  pip install --user --break-system-packages python-flint\n\n` +
        `DO NOT install the Ubuntu \`libarb\` / \`libarb-dev\` package — that is an\n` +
        `UNRELATED phylogenetic-analysis project (R5 §7.2 line 1012).\n`,
    );
    process.exit(1);
  }
  const probeOut = (await new Response(probe.stdout).text()).trim();
  const [flintVersion, pythonVersionShort] = probeOut.split("\n");
  process.stdout.write(
    `arb adapter: smoke-test OK — Gamma(0.5) midpoint matches reference (python-flint ${flintVersion} / python3 ${pythonVersionShort})\n`,
  );

  // -- Load the corpus and forward the bare {inputs:[...]} envelope. -------
  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: Corpus = JSON.parse(corpusRaw);
  const pythonStdin = JSON.stringify({ inputs: corpus.inputs });

  process.stdout.write(
    `arb adapter: loaded corpus (${corpus.inputs.length} inputs, seed=${corpus.seed}); ` +
      `spawning oracle.py at baseline ctx.prec=200 bits ≈ 60.2 dp ` +
      `(auto-bump to 456 bits on cancellation) ...\n`,
  );

  // -- Spawn the single python3 child. Stream stderr concurrently so the
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
  // is documented in worklog 027 (Bun pipe buffer ~64 KiB; the gamma
  // results blob is small but the discipline is the same).
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const totalElapsedMs = performance.now() - t0;

  if (exitCode !== 0) {
    process.stderr.write(`arb adapter: oracle.py exited ${exitCode}\n`);
    process.stderr.write(`stderr:\n${stderrText}\n`);
    process.stderr.write(`stdout head:\n${stdoutText.slice(0, 500)}\n`);
    process.exit(1);
  }
  if (stderrText.length > 0) {
    // Python may have emitted progress / DeprecationWarning; surface but
    // don't fail.
    process.stderr.write(`arb adapter: python stderr:\n${stderrText}\n`);
  }

  // -- Parse the python output. Index 0 is the meta sentinel; rows follow.
  let parsed: ReadonlyArray<PyMeta | PyRow>;
  try {
    parsed = JSON.parse(stdoutText) as ReadonlyArray<PyMeta | PyRow>;
  } catch (e) {
    process.stderr.write(
      `arb adapter: failed to parse python stdout as JSON: ${(e as Error).message}\n` +
        `stdout head: ${stdoutText.slice(0, 500)}\n`,
    );
    process.exit(1);
  }

  const meta = parsed[0] as PyMeta;
  if (!meta || meta.__meta__ !== true) {
    process.stderr.write(
      `arb adapter: missing __meta__ sentinel at index 0; got ${JSON.stringify(parsed[0])}\n`,
    );
    process.exit(1);
  }
  const pyRows = parsed.slice(1) as ReadonlyArray<PyRow>;

  if (pyRows.length !== corpus.inputs.length) {
    process.stderr.write(
      `arb adapter: result count mismatch: corpus=${corpus.inputs.length}, results=${pyRows.length}\n`,
    );
    process.exit(1);
  }

  // -- Merge per-row python output with the corpus row id, validating
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
  const cancellation = {
    rows_with_bump: 0,
    max_attempts_seen: 1,
    final_prec_histogram: {} as Record<number, number>,
  };
  for (let i = 0; i < pyRows.length; i++) {
    const inp = corpus.inputs[i];
    const r = pyRows[i];
    if (r.id !== inp.id) {
      process.stderr.write(
        `arb adapter: id-order mismatch at row ${i}: corpus=${inp.id} python=${r.id}\n`,
      );
      process.exit(1);
    }

    records[i] = {
      input_id: r.id,
      status: r.status,
      value: r.value ?? null,
      value_radius: r.value_radius ?? null,
      arb_returned_token: r.arb_returned_token ?? null,
      prec_attempts: r.prec_attempts ?? null,
      final_prec: r.final_prec ?? null,
      elapsed_ms: r.elapsed_ms,
      notes: r.note ?? null,
    };

    // Track cancellation-retry histogram for the envelope summary.
    if (r.prec_attempts) {
      if (r.prec_attempts.length > 1) {
        cancellation.rows_with_bump += 1;
      }
      if (r.prec_attempts.length > cancellation.max_attempts_seen) {
        cancellation.max_attempts_seen = r.prec_attempts.length;
      }
    }
    if (r.final_prec !== undefined) {
      const k = r.final_prec;
      cancellation.final_prec_histogram[k] =
        (cancellation.final_prec_histogram[k] ?? 0) + 1;
    }

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
        process.stderr.write(`arb adapter: unknown status ${r.status} at row ${i}\n`);
        process.exit(1);
      }
    }
  }

  const envelope: ResultsEnvelope = {
    oracle_id: "arb",
    oracle_version: `python-flint ${meta.flint_version} / FLINT C 3.0.1 (Ubuntu libflint-dev 3.0.1-3.1build1)`,
    python_version: meta.python_version,
    generated_at: new Date().toISOString(),
    corpus_seed: corpus.seed,
    corpus_bead: corpus.bead,
    corpus_adr: corpus.adr,
    corpus_generated_at: corpus.generated_at,
    tier: "gold",
    method:
      "python-flint acb.{gamma, lgamma, digamma, polygamma, rising, " +
      "gamma_upper, gamma_lower, beta_lower, barnes_g, rgamma}; " +
      "cancellation-driven precision retry per ADR-0042 §Decision 3 (200 → 264 → 328 → 392 → 456 bits)",
    baseline_prec_bits: meta.baseline_prec_bits,
    max_prec_bits: meta.max_prec_bits,
    prec_bump_bits: meta.prec_bump_bits,
    max_retries: meta.max_retries,
    emit_dp: meta.emit_dp,
    radius_emit_dp: meta.radius_emit_dp,
    relative_radius_target: meta.relative_radius_target,
    per_input_timeout_s: meta.per_input_timeout_s,
    total_corpus_inputs: corpus.inputs.length,
    total_elapsed_ms: totalElapsedMs,
    cancellation_retries: cancellation,
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

  // Pretty-print the final-prec histogram for the operator. The histogram
  // tells you at-a-glance how many rows operated near a cancellation cliff.
  const histEntries = Object.entries(cancellation.final_prec_histogram)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .sort(([a], [b]) => a - b);
  const histStr = histEntries.length === 0
    ? "(empty)"
    : histEntries.map(([p, n]) => `${p}b:${n}`).join("  ");

  process.stdout.write(
    `arb adapter: wrote ${resultsPath}\n` +
      `  oracle:                  python-flint ${meta.flint_version}\n` +
      `  total inputs:            ${corpus.inputs.length}\n` +
      `  success (real):          ${tally.success}\n` +
      `  success (complex):       ${tally.complex_success}\n` +
      `  refused (poles):         ${tally.refused}\n` +
      `  unsupported (head):      ${tally.unsupported}\n` +
      `  timeout:                 ${tally.timeout}\n` +
      `  error:                   ${tally.error}\n` +
      `  honest fraction:         ${(honestFraction * 100).toFixed(2)}%\n` +
      `  rows that bumped prec:   ${cancellation.rows_with_bump}\n` +
      `  max attempts seen:       ${cancellation.max_attempts_seen}\n` +
      `  final-prec histogram:    ${histStr}\n` +
      `  wall-time:               ${(totalElapsedMs / 1000).toFixed(2)} s\n` +
      `  baseline / max / emit:   ${meta.baseline_prec_bits}b / ${meta.max_prec_bits}b / ${meta.emit_dp}dp\n`,
  );

  // Honest-quality gate: ≥ 95 % "honest mathematical answer". The 5 %
  // remainder is the hard-error / timeout tail — same gate as the
  // mpmath sibling. We do NOT gate on cancellation-retry rate; the
  // retries are EXPECTED on T3/T7/T8 and represent the adapter doing
  // its job (the prec bump is the load-bearing Arb value-add).
  if (honestFraction < 0.95) {
    process.stderr.write(
      `\narb adapter: honest fraction ${(honestFraction * 100).toFixed(2)}% is below the\n` +
        `95% acceptance threshold from bead scientist-workbench-2wr6. Inspect\n` +
        `${resultsPath} for failing rows (filter status === 'timeout' || status === 'error').\n`,
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
