// =============================================================================
// bench/erf-anchor/oracles/boost/adapter.ts — Boost.Math oracle orchestrator
// =============================================================================
//
// Bead: scientist-workbench-x1lt  (G6 — Boost.Math oracle adapter).
// ADR : 0040 §"Decision 8" (oracle hierarchy: gold + silver + bronze).
// Ref : docs/refs/erf-research/R5-oracle-landscape.md §1, §2.4.
//
// This adapter is the TypeScript-on-Bun orchestrator for the silver-tier
// Boost.Math arb-prec oracle (real branch) plus the bronze-tier
// Boost.Math float64 oracle. The numerical work itself happens in the
// sibling erf-oracle.cpp translation unit; this file's job is to
//
//   1. probe the build environment (g++, Boost headers)            — health
//   2. compile erf-oracle.cpp to ./build/erf-oracle (idempotent)    — build
//   3. stream bench/erf-anchor/corpus.json through the binary       — run
//   4. validate the emitted results.json shape + per-input-count    — verify
//   5. print a one-line summary                                     — report
//
// ─── C++/TS boundary discipline ────────────────────────────────────────────
//
// Boost.Math is *corpus-build-time tooling*, NOT a runtime dependency of
// the scientist-workbench substrate. The runtime substrate is pure TS on
// Bun (CLAUDE.md "Practical guidance"; ADR-0040 §"Decision 8" oracle role).
// Hence:
//
//   - The binary is built under ./build/ (gitignored) on each adapter run,
//     not committed.
//   - The emitted results.json IS committed — it is the gold/silver
//     cross-validation evidence the substrate is graded against in the
//     G8 agreement matrix bead.
//   - No code outside this directory imports the binary or links against
//     Boost. The runtime substrate's exposure to Boost is exactly the
//     committed JSON.
//
// ─── No-complex-arb-prec constraint ────────────────────────────────────────
//
// Boost.Math's erf template instantiates only on ordered scalar types and
// rejects std::complex at any precision (R5 §1 row "arb-prec complex: NO";
// confirmed by compile-test 2026-05-16:
//     g++ … boost::math::erf<std::complex<double>> → error: no match for
//     'operator<' (operand types are 'std::complex<double>' and 'int').
// All 105 complex inputs and all 8 real Erfi T6 edge cases (Boost has no
// erfi primitive at any tier) emit a clean refusal record with
// method="boost-refused" and a note citing the mechanical reason. This is
// "honest scope" per CLAUDE.md Rule 8: a tool that refuses out-of-domain
// inputs is correct; a tool that silently substitutes a non-Boost value
// would compromise the entire silver-tier independence claim.
//
// The expected outcome on the v0.1 corpus (271 inputs):
//
//   silver  (boost-cpp_bin_float-50)   149   real-non-Erfi-non-edge inputs
//   refused (boost-refused)            122   complex (105) + real Erfi (8)
//                                              + real-non-finite edges (9)
//   total                              271
//
// ─── Build directory convention ────────────────────────────────────────────
//
// All build artefacts live under ./build/ and are gitignored (.gitignore
// in this directory). The build is idempotent: we skip recompilation if
// the binary's mtime is newer than the source's. The first run on a fresh
// clone takes ~4-6 s (Boost.Math is heavily templated); subsequent runs
// skip straight to execution.
//
// ─── Failure surface ───────────────────────────────────────────────────────
//
// All failures throw with a descriptive message and a `detail` field
// pointing to the upstream evidence (which probe, which path, which
// command). The exit code on uncaught throw is 1; the orchestrator does
// not produce silent partial output. This mirrors CLAUDE.md Rule 1 ("fail
// fast, fail loud") at the adapter layer.
// =============================================================================

import { existsSync, statSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// -----------------------------------------------------------------------------
// Path constants. All paths resolved from this file's location so the
// orchestrator works no matter what cwd Bun is invoked from.
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_CPP        = resolve(__dirname, "erf-oracle.cpp");
const BUILD_DIR      = resolve(__dirname, "build");
const BINARY         = resolve(BUILD_DIR, "erf-oracle");
const CORPUS_JSON    = resolve(__dirname, "..", "..", "corpus.json");
const RESULTS_JSON   = resolve(__dirname, "results.json");

// -----------------------------------------------------------------------------
// Probe helpers. Each returns a tagged value or throws a typed Error.
// -----------------------------------------------------------------------------

interface ProbeFinding {
  path: string;
  exists: boolean;
  version?: string;
}

function probeFile(path: string): ProbeFinding {
  return { path, exists: existsSync(path) };
}

function probeGcc(): ProbeFinding {
  const res = spawnSync("g++", ["--version"], { encoding: "utf8" });
  if (res.status !== 0) {
    return { path: "g++", exists: false };
  }
  const firstLine = (res.stdout || "").split("\n")[0]?.trim() ?? "";
  return { path: "g++", exists: true, version: firstLine };
}

function probeBoostVersion(): string | undefined {
  // Extract BOOST_LIB_VERSION (or BOOST_VERSION) from version.hpp without
  // running the preprocessor — keeps probing zero-cost and doesn't
  // require a compile step. The header layout is stable across the
  // Boost 1.x line.
  const versionHpp = "/usr/include/boost/version.hpp";
  if (!existsSync(versionHpp)) return undefined;
  const src = readFileSync(versionHpp, "utf8");
  const m = src.match(/#define\s+BOOST_LIB_VERSION\s+"([^"]+)"/);
  return m?.[1];
}

// -----------------------------------------------------------------------------
// Step 1 — probe environment.
//
// The R5 §1 capability matrix was produced on the same host and listed
// Boost 1.83 + g++ 13.3.0 + headers all present. We reprobe at adapter
// invocation time because the user could be running on a different
// machine; if any probe fails we exit with a structured error message
// telling the user exactly which install command would fix it.
// -----------------------------------------------------------------------------

interface Env {
  gcc: ProbeFinding;
  boostVersionHpp: ProbeFinding;
  boostErfHpp: ProbeFinding;
  boostCppBinFloatHpp: ProbeFinding;
  boostVersion: string | undefined;
}

function probeEnvironment(): Env {
  return {
    gcc:                 probeGcc(),
    boostVersionHpp:     probeFile("/usr/include/boost/version.hpp"),
    boostErfHpp:         probeFile("/usr/include/boost/math/special_functions/erf.hpp"),
    boostCppBinFloatHpp: probeFile("/usr/include/boost/multiprecision/cpp_bin_float.hpp"),
    boostVersion:        probeBoostVersion(),
  };
}

function assertEnvironment(env: Env): void {
  const missing: string[] = [];
  if (!env.gcc.exists)                 missing.push("g++ (apt install g++)");
  if (!env.boostVersionHpp.exists)     missing.push("boost/version.hpp (apt install libboost-all-dev)");
  if (!env.boostErfHpp.exists)         missing.push("boost/math/special_functions/erf.hpp (apt install libboost-all-dev)");
  if (!env.boostCppBinFloatHpp.exists) missing.push("boost/multiprecision/cpp_bin_float.hpp (apt install libboost-all-dev)");
  if (missing.length > 0) {
    const detail = [
      "Boost.Math oracle adapter environment probe failed.",
      "Missing prerequisites:",
      ...missing.map((m) => "  - " + m),
      "",
      "Reference: docs/refs/erf-research/R5-oracle-landscape.md §1",
      "(the R5 'Installed?' column for the Boost.Math row).",
    ].join("\n");
    throw new Error(detail);
  }
}

// -----------------------------------------------------------------------------
// Step 2 — idempotent compile.
//
// Re-link only when the binary doesn't exist, or when the source mtime
// is newer than the binary mtime. This makes the inner-loop "tweak
// erf-oracle.cpp, rerun adapter.ts" cycle fast (~150 ms when skipped)
// while ensuring the first run on a fresh clone or after a header
// upgrade triggers a rebuild.
//
// We spawn g++ via node:child_process directly (NOT spawnBun) because
// g++ is a system binary that has no relationship to the snap-Bun
// mount-namespace corner ADR-0001 addresses. ADR-0001 is about
// resolving the path of a child *Bun* process whose snap confinement
// shadows the system PATH; g++ lives at /usr/bin/g++ and is invocable
// from any process on this host.
// -----------------------------------------------------------------------------

function shouldRebuild(): boolean {
  if (!existsSync(BINARY)) return true;
  const srcMtime = statSync(SRC_CPP).mtimeMs;
  const binMtime = statSync(BINARY).mtimeMs;
  return srcMtime > binMtime;
}

function compile(): void {
  mkdirSync(BUILD_DIR, { recursive: true });
  const args = [
    "-std=c++17",
    "-O2",
    "-I/usr/include",
    SRC_CPP,
    "-o",
    BINARY,
  ];
  const t0 = Date.now();
  const res = spawnSync("g++", args, { encoding: "utf8" });
  const elapsedMs = Date.now() - t0;
  if (res.status !== 0) {
    const detail = [
      "g++ compilation of erf-oracle.cpp failed (exit " + res.status + ").",
      "Command: g++ " + args.join(" "),
      "",
      "stdout:",
      res.stdout || "(empty)",
      "",
      "stderr:",
      res.stderr || "(empty)",
    ].join("\n");
    throw new Error(detail);
  }
  console.log(`[adapter] compiled erf-oracle.cpp in ${elapsedMs} ms → ${BINARY}`);
}

// -----------------------------------------------------------------------------
// Step 3 — pipe corpus through binary.
//
// We use spawnSync with explicit input redirection because the corpus
// is small (~140 KB) and the binary's runtime is bounded by the silver-
// lane work (~10-50 ms per input × 149 silver inputs ≈ 2-5 s total).
// Streaming via spawn() + .stdin.write() would buy nothing here.
// -----------------------------------------------------------------------------

interface RunSummary {
  elapsedMs: number;
  inputCount: number;
  silverSuccess: number;
  bronzeSuccess: number;
  refused: number;
  driverErrors: number;
}

function runOracle(): RunSummary {
  const corpusBytes = readFileSync(CORPUS_JSON);
  const t0 = Date.now();
  const res = spawnSync(BINARY, [], {
    input: corpusBytes,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,   // 64 MB — corpus×oracle is < 1 MB but be safe
  });
  const elapsedMs = Date.now() - t0;
  if (res.status !== 0) {
    const stderr = res.stderr ? res.stderr.toString("utf8") : "(empty)";
    const stdoutPrefix = res.stdout ? res.stdout.toString("utf8").slice(0, 500) : "(empty)";
    throw new Error([
      "erf-oracle binary exited non-zero (status " + res.status + ").",
      "stderr: " + stderr,
      "stdout (first 500 bytes): " + stdoutPrefix,
    ].join("\n"));
  }
  // Write results.json directly from the captured buffer.
  Bun.write(RESULTS_JSON, res.stdout as Buffer);
  return validateResults(elapsedMs);
}

// -----------------------------------------------------------------------------
// Step 4 — validate emitted results.json structure.
//
// We re-read the file we just wrote (rather than trust the buffer) so a
// subsequent failure surfaces a real disk-state issue rather than an
// in-memory race. The shape contract is shallow: top-level keys
// {oracle_id, results, counts}, with results.length === input_count.
// -----------------------------------------------------------------------------

function validateResults(elapsedMs: number): RunSummary {
  const raw = readFileSync(RESULTS_JSON, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("results.json is not valid JSON: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("results.json root must be an object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.oracle_id !== "boost") {
    throw new Error(`results.json oracle_id is ${JSON.stringify(root.oracle_id)}, expected "boost"`);
  }
  if (!Array.isArray(root.results)) {
    throw new Error("results.json has no 'results' array");
  }
  const inputCount     = Number(root.input_count           ?? -1);
  const silverSuccess  = Number(root.silver_success_count  ?? -1);
  const bronzeSuccess  = Number(root.bronze_success_count  ?? -1);
  const refused        = Number(root.refused_count         ?? -1);
  const driverErrors   = Number(root.driver_error_count    ?? -1);
  const results        = root.results as unknown[];

  if (results.length !== inputCount) {
    throw new Error(
      `results.json has ${results.length} records but input_count=${inputCount}; expected equal.`,
    );
  }
  const sum = silverSuccess + bronzeSuccess + refused + driverErrors;
  if (sum !== inputCount) {
    throw new Error(
      `results.json bucket counts (silver+bronze+refused+errors=${sum}) do not match input_count=${inputCount}`,
    );
  }

  // Per-record sanity: every record has input_id, head, method, achieved_precision.
  for (let i = 0; i < results.length; ++i) {
    const r = results[i] as Record<string, unknown>;
    if (typeof r.input_id !== "string") throw new Error(`result[${i}] missing input_id`);
    if (typeof r.head     !== "string") throw new Error(`result[${i}] missing head`);
    if (typeof r.method   !== "string") throw new Error(`result[${i}] missing method`);
    if (typeof r.achieved_precision !== "number") throw new Error(`result[${i}] missing achieved_precision`);
  }

  return { elapsedMs, inputCount, silverSuccess, bronzeSuccess, refused, driverErrors };
}

// -----------------------------------------------------------------------------
// Step 5 — main.
// -----------------------------------------------------------------------------

function main(): void {
  console.log("[adapter] Boost.Math erf oracle (G6, bead scientist-workbench-x1lt)");
  const env = probeEnvironment();
  console.log("[adapter] probe: g++          " + (env.gcc.version ?? "(missing)"));
  console.log("[adapter] probe: boost        " + (env.boostVersion ?? "(missing)"));
  console.log("[adapter] probe: erf.hpp      " + (env.boostErfHpp.exists ? "present" : "MISSING"));
  console.log("[adapter] probe: cpp_bin_float" + (env.boostCppBinFloatHpp.exists ? " present" : " MISSING"));
  assertEnvironment(env);

  if (!existsSync(CORPUS_JSON)) {
    throw new Error(`corpus.json not found at ${CORPUS_JSON} — run bun bench/erf-anchor/generate-corpus.ts first.`);
  }

  if (shouldRebuild()) {
    compile();
  } else {
    console.log(`[adapter] erf-oracle binary up-to-date at ${BINARY} (skipping rebuild)`);
  }

  const summary = runOracle();
  console.log("[adapter] " +
    `inputs=${summary.inputCount} ` +
    `silver=${summary.silverSuccess} ` +
    `bronze=${summary.bronzeSuccess} ` +
    `refused=${summary.refused} ` +
    `errors=${summary.driverErrors} ` +
    `(${summary.elapsedMs} ms)`);
  console.log(`[adapter] wrote ${RESULTS_JSON}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    console.error("[adapter] FAILED:");
    console.error((e as Error).message);
    process.exit(1);
  }
}
