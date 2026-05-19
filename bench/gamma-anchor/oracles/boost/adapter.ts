// =============================================================================
// bench/gamma-anchor/oracles/boost/adapter.ts — Boost.Math Gamma orchestrator
// =============================================================================
//
// Bead: scientist-workbench-3v35  (G5 — Boost.Math Gamma-anchor oracle).
// ADR : 0042 §"Decision 8" (oracle hierarchy: silver tier = Boost
//       cpp_bin_float<50>, real-only).
// Ref : docs/refs/gamma-research/R5-oracle-landscape.md §3.4, §6
//       (Boost function-name mapping; landmines L1-L17 with L12 as the
//       gamma-specific #1 trap, pinned `// L12` throughout oracle.cpp).
//
// Pure-TS Bun orchestrator for the silver-tier Boost.Math gamma oracle.
// The numerical work itself lives in the sibling `oracle.cpp` translation
// unit; this file's job is the surrounding plumbing:
//
//   1. probe build environment (g++, Boost headers)            — health
//   2. compile oracle.cpp to ./build/oracle                    — build (idempotent)
//   3. stream bench/gamma-anchor/corpus.json through binary    — run
//   4. validate emitted results.json shape + bucket counts     — verify
//   5. print a one-line summary                                — report
//
// ─── Boost is corpus-build-time tooling, not a runtime dependency ─────────
//
// The runtime substrate is pure TS on Bun (CLAUDE.md "Practical guidance").
// Boost.Math sits exclusively outside that substrate: it builds the
// silver evidence baked into `results.json`, which the runtime substrate
// is graded against.
//
//   - The binary lives under ./build/ (gitignored), rebuilt on demand.
//   - `results.json` IS committed — it is the silver-tier independent
//     voice the G8 cross-agreement comparator consumes.
//   - No code outside this directory imports the binary or links Boost.
//
// ─── No complex support; three heads Boost cannot serve at all ───────────
//
// R5 §3.4 final paragraph: Boost.Math has no `std::complex<cpp_bin_float<N>>`
// support for any gamma-family head (template instantiates only on
// ordered scalar types). Additionally, three heads in the corpus have no
// Boost primitive at all:
//
//   - BarnesG    → 11 corpus rows; unsupported "boost-no-barnesg"
//   - Pochhammer → 20 corpus rows; unsupported "boost-no-pochhammer"
//   - Hyperfactorial → 0 in v0.1 corpus, kept for forward compat
//
// Expected output on the v0.1 corpus (377 inputs, sha256 1328dd0c...):
//
//   success                          ~308 — real-real-finite supported-head rows
//   unsupported_complex                 44 — all complex z (T4 + complex T1)
//   unsupported_head (BarnesG)          11 — every BarnesG row
//   unsupported_head (Pochhammer)       20 — every Pochhammer row
//   refused                            ~minimal — gamma at integer poles
//                                                (Γ(0), Γ(-n)) + any other
//                                                Boost domain throws
//   total                              377
//
// The exact `success` vs `refused` split depends on how many corpus
// rows hit poles or extreme regimes that Boost refuses — those numbers
// are signal for the comparator, not contract.
//
// ─── L12 — incomplete-gamma regularisation convention ─────────────────────
//
// Boost spells P/Q UNAMBIGUOUSLY (gamma_p = P, gamma_q = Q — same as
// Wolfram/mpmath). The convention inversion landmine fires only against
// SciPy (R5 §6 L12). Nevertheless every dispatcher call in oracle.cpp
// carries `// L12` so a `grep "L12" oracle.cpp` audit returns one line
// per supported head, matching the pin discipline across the whole
// oracle-adapter suite.
//
// ─── Build-cache convention ───────────────────────────────────────────────
//
// All build artefacts live under ./build/ and are gitignored. The build
// is idempotent: we skip recompilation if the binary's mtime is newer
// than the source's. First run on a fresh clone takes a few seconds
// (cpp_bin_float instantiations); subsequent runs go straight to
// execution.
//
// ─── Failure surface ──────────────────────────────────────────────────────
//
// All failures throw with a descriptive message and detail pointing to
// the upstream evidence (which probe, which path, which command). The
// exit code on uncaught throw is 1; no silent partial output. This
// mirrors CLAUDE.md Rule 1 ("fail fast, fail loud") at the adapter layer.
// =============================================================================

import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// -----------------------------------------------------------------------------
// Path constants. All paths resolved from this file's location so the
// orchestrator works no matter what cwd Bun is invoked from.
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_CPP      = resolve(__dirname, "oracle.cpp");
const BUILD_DIR    = resolve(__dirname, "build");
const BINARY       = resolve(BUILD_DIR, "oracle");
const CORPUS_JSON  = resolve(__dirname, "..", "..", "corpus.json");
const RESULTS_JSON = resolve(__dirname, "results.json");

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
  // Extract BOOST_LIB_VERSION from version.hpp without running the
  // preprocessor — keeps probing zero-cost and doesn't require a
  // compile. The header layout is stable across the Boost 1.x line.
  const versionHpp = "/usr/include/boost/version.hpp";
  if (!existsSync(versionHpp)) return undefined;
  const src = readFileSync(versionHpp, "utf8");
  const m = src.match(/#define\s+BOOST_LIB_VERSION\s+"([^"]+)"/);
  return m?.[1];
}

// -----------------------------------------------------------------------------
// Step 1 — probe environment.
// -----------------------------------------------------------------------------

interface Env {
  gcc:                 ProbeFinding;
  boostVersionHpp:     ProbeFinding;
  boostGammaHpp:       ProbeFinding;
  boostBetaHpp:        ProbeFinding;
  boostPolygammaHpp:   ProbeFinding;
  boostCppBinFloatHpp: ProbeFinding;
  boostVersion:        string | undefined;
}

function probeEnvironment(): Env {
  return {
    gcc:                 probeGcc(),
    boostVersionHpp:     probeFile("/usr/include/boost/version.hpp"),
    boostGammaHpp:       probeFile("/usr/include/boost/math/special_functions/gamma.hpp"),
    boostBetaHpp:        probeFile("/usr/include/boost/math/special_functions/beta.hpp"),
    boostPolygammaHpp:   probeFile("/usr/include/boost/math/special_functions/polygamma.hpp"),
    boostCppBinFloatHpp: probeFile("/usr/include/boost/multiprecision/cpp_bin_float.hpp"),
    boostVersion:        probeBoostVersion(),
  };
}

function assertEnvironment(env: Env): void {
  const missing: string[] = [];
  if (!env.gcc.exists)                 missing.push("g++ (apt install g++)");
  if (!env.boostVersionHpp.exists)     missing.push("boost/version.hpp (apt install libboost-math-dev)");
  if (!env.boostGammaHpp.exists)       missing.push("boost/math/special_functions/gamma.hpp (apt install libboost-math-dev)");
  if (!env.boostBetaHpp.exists)        missing.push("boost/math/special_functions/beta.hpp (apt install libboost-math-dev)");
  if (!env.boostPolygammaHpp.exists)   missing.push("boost/math/special_functions/polygamma.hpp (apt install libboost-math-dev)");
  if (!env.boostCppBinFloatHpp.exists) missing.push("boost/multiprecision/cpp_bin_float.hpp (apt install libboost-math-dev)");
  if (missing.length > 0) {
    const detail = [
      "Boost.Math Gamma oracle adapter environment probe failed.",
      "Missing prerequisites:",
      ...missing.map((m) => "  - " + m),
      "",
      "Reference: docs/refs/gamma-research/R5-oracle-landscape.md §3.4 + §7.1",
      "(Installation paths table — Ubuntu/Debian package = libboost-math-dev).",
    ].join("\n");
    throw new Error(detail);
  }
}

// -----------------------------------------------------------------------------
// Step 2 — idempotent compile.
//
// Rebuild only when the binary doesn't exist, or when the source mtime
// is newer than the binary mtime. Keeps the inner-loop "tweak the .cpp,
// rerun adapter.ts" cycle fast (~150 ms when skipped); first-clone /
// post-header-upgrade triggers a rebuild.
//
// We spawn g++ via node:child_process directly (not spawnBun) because
// g++ is a system binary unrelated to the snap-Bun mount-namespace
// corner ADR-0001 addresses. g++ lives at /usr/bin/g++ and is invocable
// from any process on this host. The besselj G5 adapter establishes
// this precedent.
// -----------------------------------------------------------------------------

function shouldRebuild(): boolean {
  if (!existsSync(BINARY)) return true;
  const srcMtime = statSync(SRC_CPP).mtimeMs;
  const binMtime = statSync(BINARY).mtimeMs;
  return srcMtime > binMtime;
}

function compile(): void {
  mkdirSync(BUILD_DIR, { recursive: true });
  // -I/usr/include is technically redundant on Ubuntu (g++ searches
  // there by default), but listing it makes the prompt's recommended
  // command line work verbatim and surfaces the include path in the
  // failure message if a header is missing.
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
      "g++ compilation of oracle.cpp failed (exit " + res.status + ").",
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
  console.log(`[adapter] compiled oracle.cpp in ${elapsedMs} ms → ${BINARY}`);
}

// -----------------------------------------------------------------------------
// Step 3 — pipe corpus through binary.
//
// spawnSync with explicit input redirection: the corpus is ~200 KB, the
// binary's runtime is bounded by ~377 silver gamma evaluations × a few
// ms each = O(2 s) total. Streaming via spawn() + stdin.write() would
// buy nothing.
// -----------------------------------------------------------------------------

interface RunSummary {
  elapsedMs: number;
  inputCount: number;
  success: number;
  refused: number;
  unsupportedComplex: number;
  unsupportedHead: number;
  driverError: number;
}

function runOracle(): RunSummary {
  const corpusBytes = readFileSync(CORPUS_JSON);
  const t0 = Date.now();
  const res = spawnSync(BINARY, [], {
    input: corpusBytes,
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,   // 512 MB cap — actual output is < 5 MB
  });
  const elapsedMs = Date.now() - t0;
  if (res.status !== 0) {
    const stderr      = res.stderr ? res.stderr.toString("utf8") : "(empty)";
    const stdoutHead  = res.stdout ? res.stdout.toString("utf8").slice(0, 500) : "(empty)";
    throw new Error([
      "oracle binary exited non-zero (status " + res.status + ").",
      "stderr: " + stderr,
      "stdout (first 500 bytes): " + stdoutHead,
    ].join("\n"));
  }

  // Post-hoc number-formatting normalisation: Boost / std::ostream
  // emit "1.234e+05" (with the explicit '+' sign in the exponent).
  // Most JSON consumers accept this, but we keep the wire byte-stable
  // by passing it through unchanged. The format_silver() helper in
  // oracle.cpp already produces a canonical form; we do not rewrite
  // it here. (If a downstream consumer ever needs "1.234e5" we add
  // the rewrite at that layer rather than mutating the silver wire.)
  writeFileSync(RESULTS_JSON, res.stdout as Buffer);
  return validateResults(elapsedMs);
}

// -----------------------------------------------------------------------------
// Step 4 — validate emitted results.json structure.
//
// We re-read the file we just wrote (rather than trust the buffer) so a
// subsequent failure surfaces a real disk-state issue rather than an
// in-memory race. The shape contract is shallow: top-level keys
// {oracle_id, results, totals}, with results.length === input_count.
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
  const inputCount = Number(root.input_count ?? -1);
  const results    = root.results as unknown[];

  if (results.length !== inputCount) {
    throw new Error(
      `results.json has ${results.length} records but input_count=${inputCount}; expected equal.`,
    );
  }

  const totals = (root.totals ?? {}) as Record<string, unknown>;
  const success             = Number(totals.success             ?? -1);
  const refused             = Number(totals.refused             ?? -1);
  const unsupportedComplex  = Number(totals.unsupported_complex ?? -1);
  const unsupportedHead     = Number(totals.unsupported_head    ?? -1);
  const driverError         = Number(totals.driver_error        ?? -1);
  const sum = success + refused + unsupportedComplex + unsupportedHead + driverError;
  if (sum !== inputCount) {
    throw new Error(
      `results.json bucket totals (success+refused+unsupported_complex+` +
      `unsupported_head+driver_error=${sum}) do not match input_count=${inputCount}`,
    );
  }

  // Per-record sanity: every record carries the contract keys.
  for (let i = 0; i < results.length; ++i) {
    const r = results[i] as Record<string, unknown>;
    if (typeof r.input_id           !== "string") throw new Error(`result[${i}] missing input_id`);
    if (typeof r.head               !== "string") throw new Error(`result[${i}] missing head`);
    if (typeof r.method             !== "string") throw new Error(`result[${i}] missing method`);
    if (typeof r.status             !== "string") throw new Error(`result[${i}] missing status`);
    if (typeof r.achieved_precision !== "number") throw new Error(`result[${i}] missing achieved_precision`);
  }

  return {
    elapsedMs,
    inputCount,
    success,
    refused,
    unsupportedComplex,
    unsupportedHead,
    driverError,
  };
}

// -----------------------------------------------------------------------------
// Step 5 — main.
// -----------------------------------------------------------------------------

function main(): void {
  console.log("[adapter] Boost.Math Gamma oracle (G5, bead scientist-workbench-3v35)");
  const env = probeEnvironment();
  console.log("[adapter] probe: g++              " + (env.gcc.version ?? "(missing)"));
  console.log("[adapter] probe: boost            " + (env.boostVersion ?? "(missing)"));
  console.log("[adapter] probe: gamma.hpp        " + (env.boostGammaHpp.exists       ? "present" : "MISSING"));
  console.log("[adapter] probe: beta.hpp         " + (env.boostBetaHpp.exists        ? "present" : "MISSING"));
  console.log("[adapter] probe: polygamma.hpp    " + (env.boostPolygammaHpp.exists   ? "present" : "MISSING"));
  console.log("[adapter] probe: cpp_bin_float.hpp" + (env.boostCppBinFloatHpp.exists ? " present" : " MISSING"));
  assertEnvironment(env);

  if (!existsSync(CORPUS_JSON)) {
    throw new Error(
      `corpus.json not found at ${CORPUS_JSON} — ` +
      `run bun bench/gamma-anchor/generate-corpus.ts first.`,
    );
  }

  if (shouldRebuild()) {
    compile();
  } else {
    console.log(`[adapter] oracle binary up-to-date at ${BINARY} (skipping rebuild)`);
  }

  const summary = runOracle();
  console.log("[adapter] " +
    `inputs=${summary.inputCount} ` +
    `success=${summary.success} ` +
    `refused=${summary.refused} ` +
    `unsupported_complex=${summary.unsupportedComplex} ` +
    `unsupported_head=${summary.unsupportedHead} ` +
    `driver_error=${summary.driverError} ` +
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
