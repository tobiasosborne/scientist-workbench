// =============================================================================
// bench/besselj-anchor/oracles/boost/adapter.ts — Boost.Math Bessel orchestrator
// =============================================================================
//
// Bead: scientist-workbench-5zxc  (G5 — Boost.Math BesselJ-anchor oracle).
// ADR : 0041 §"Decision 8" (oracle hierarchy: gold + silver + bronze).
// Ref : docs/refs/besselj-research/R5-oracle-landscape.md §2, §4, §6
//       (capability matrix, Boost probe, landmines L_boost_yspell + L4).
//
// Pure-TS Bun orchestrator for the silver-tier (cpp_bin_float<50>) and
// bronze-tier (double) Boost.Math Bessel oracle. The numerical work
// itself lives in the sibling `bessel-oracle.cpp` translation unit;
// this file's job is the surrounding plumbing:
//
//   1. probe build environment (g++, Boost headers)            — health
//   2. compile bessel-oracle.cpp to ./build/bessel-oracle      — build (idempotent)
//   3. stream bench/besselj-anchor/corpus.json through binary  — run
//   4. validate emitted results.json shape + bucket counts     — verify
//   5. print a one-line summary                                — report
//
// ─── Boost is corpus-build-time tooling, not a runtime dependency ─────────
//
// The runtime substrate is pure TS on Bun (CLAUDE.md "Practical guidance";
// ADR-0041 §"Decision 8"). Boost.Math sits exclusively outside that
// substrate: it builds the silver / bronze evidence baked into
// `results.json`, which the runtime substrate is graded against.
//
//   - The binary lives under ./build/ (gitignored), rebuilt on demand.
//   - `results.json` IS committed — it's the silver-tier cross-validation
//     evidence the G8 agreement-matrix bead consumes.
//   - No code outside this directory imports the binary or links Boost.
//
// ─── L_boost_yspell — load-bearing API correction ─────────────────────────
//
// Boost spells Y_ν as `boost::math::cyl_neumann`, NOT `cyl_bessel_y`.
// This adapter never touches that API directly (only the C++ side does),
// but the README and the build error you'd see if the C++ accidentally
// called `cyl_bessel_y` is a "did you mean cyl_bessel_k?" — load-bearing
// debugging hint pre-pinned in R5 §6.
//
// ─── No complex Bessel at any precision ───────────────────────────────────
//
// Boost.Math's cyl_bessel_* templates instantiate only on ordered scalar
// types and reject std::complex (R5 §2 "arb-prec complex: NO"). All 128
// T5 complex inputs in `corpus.json` emit a clean refusal record with
// status="refused" and reason="boost-no-complex-bessel".
//
// Expected output on the v0.1 corpus (1766 inputs):
//
//   success                        ~1500 — real-real-finite-valued cells
//   refused (boost-no-complex)      128 — all T5 complex inputs
//   refused (non-finite-real-input)  ~50-100 — T6 ±∞/NaN, possibly T9
//                                              zero-near-floor underflows
//   error (Boost throws)             handful — extreme T10/T7 over/underflow
//   total                           1766
//
// ─── Build-cache convention ───────────────────────────────────────────────
//
// All build artefacts live under ./build/ and are gitignored. The build
// is idempotent: we skip recompilation if the binary's mtime is newer
// than the source's. First run on a fresh clone takes ~6-10 s (Boost.Math
// + cpp_bin_float are heavily templated); subsequent runs go straight to
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
const SRC_CPP      = resolve(__dirname, "bessel-oracle.cpp");
const BUILD_DIR    = resolve(__dirname, "build");
const BINARY       = resolve(BUILD_DIR, "bessel-oracle");
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
  gcc: ProbeFinding;
  boostVersionHpp: ProbeFinding;
  boostBesselHpp: ProbeFinding;
  boostCppBinFloatHpp: ProbeFinding;
  boostVersion: string | undefined;
}

function probeEnvironment(): Env {
  return {
    gcc:                 probeGcc(),
    boostVersionHpp:     probeFile("/usr/include/boost/version.hpp"),
    boostBesselHpp:      probeFile("/usr/include/boost/math/special_functions/bessel.hpp"),
    boostCppBinFloatHpp: probeFile("/usr/include/boost/multiprecision/cpp_bin_float.hpp"),
    boostVersion:        probeBoostVersion(),
  };
}

function assertEnvironment(env: Env): void {
  const missing: string[] = [];
  if (!env.gcc.exists)                 missing.push("g++ (apt install g++)");
  if (!env.boostVersionHpp.exists)     missing.push("boost/version.hpp (apt install libboost-all-dev)");
  if (!env.boostBesselHpp.exists)      missing.push("boost/math/special_functions/bessel.hpp (apt install libboost-all-dev)");
  if (!env.boostCppBinFloatHpp.exists) missing.push("boost/multiprecision/cpp_bin_float.hpp (apt install libboost-all-dev)");
  if (missing.length > 0) {
    const detail = [
      "Boost.Math Bessel oracle adapter environment probe failed.",
      "Missing prerequisites:",
      ...missing.map((m) => "  - " + m),
      "",
      "Reference: docs/refs/besselj-research/R5-oracle-landscape.md §2",
      "(Installation paths table — Ubuntu/Debian package = libboost-all-dev).",
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
  // -I/usr/include is technically redundant on Ubuntu (g++ searches there
  // by default), but listing it makes the prompt's recommended command
  // line work verbatim and surfaces the include path in the failure
  // message if a header is missing.
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
      "g++ compilation of bessel-oracle.cpp failed (exit " + res.status + ").",
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
  console.log(`[adapter] compiled bessel-oracle.cpp in ${elapsedMs} ms → ${BINARY}`);
}

// -----------------------------------------------------------------------------
// Step 3 — pipe corpus through binary.
//
// spawnSync with explicit input redirection: the corpus is ~700 KB, the
// binary's runtime is bounded by ~1500 silver Bessel evaluations × a few
// ms each = O(10 s) total. Streaming via spawn() + stdin.write() would
// buy nothing.
// -----------------------------------------------------------------------------

interface RunSummary {
  elapsedMs: number;
  inputCount: number;
  success: number;
  refusedComplex: number;
  refusedOther: number;
  errors: number;
}

function runOracle(): RunSummary {
  const corpusBytes = readFileSync(CORPUS_JSON);
  const t0 = Date.now();
  const res = spawnSync(BINARY, [], {
    input: corpusBytes,
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,   // 512 MB cap — actual output is < 10 MB
  });
  const elapsedMs = Date.now() - t0;
  if (res.status !== 0) {
    const stderr      = res.stderr ? res.stderr.toString("utf8") : "(empty)";
    const stdoutHead  = res.stdout ? res.stdout.toString("utf8").slice(0, 500) : "(empty)";
    throw new Error([
      "bessel-oracle binary exited non-zero (status " + res.status + ").",
      "stderr: " + stderr,
      "stdout (first 500 bytes): " + stdoutHead,
    ].join("\n"));
  }
  // Write results.json directly from the captured buffer. We use
  // node:fs writeFileSync rather than Bun.write so the file mtime is set
  // consistently with the rest of the orchestrator's filesystem calls.
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
  const success        = Number(totals.success         ?? -1);
  const refusedComplex = Number(totals.refused_complex ?? -1);
  const refusedOther   = Number(totals.refused_other   ?? -1);
  const errors         = Number(totals.error           ?? -1);
  const sum = success + refusedComplex + refusedOther + errors;
  if (sum !== inputCount) {
    throw new Error(
      `results.json bucket totals (success+refused_complex+refused_other+error=${sum}) ` +
      `do not match input_count=${inputCount}`,
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
    refusedComplex,
    refusedOther,
    errors,
  };
}

// -----------------------------------------------------------------------------
// Step 5 — main.
// -----------------------------------------------------------------------------

function main(): void {
  console.log("[adapter] Boost.Math Bessel oracle (G5, bead scientist-workbench-5zxc)");
  const env = probeEnvironment();
  console.log("[adapter] probe: g++              " + (env.gcc.version ?? "(missing)"));
  console.log("[adapter] probe: boost            " + (env.boostVersion ?? "(missing)"));
  console.log("[adapter] probe: bessel.hpp       " + (env.boostBesselHpp.exists ? "present" : "MISSING"));
  console.log("[adapter] probe: cpp_bin_float.hpp" + (env.boostCppBinFloatHpp.exists ? " present" : " MISSING"));
  assertEnvironment(env);

  if (!existsSync(CORPUS_JSON)) {
    throw new Error(
      `corpus.json not found at ${CORPUS_JSON} — ` +
      `run bun bench/besselj-anchor/generate-corpus.ts first.`,
    );
  }

  if (shouldRebuild()) {
    compile();
  } else {
    console.log(`[adapter] bessel-oracle binary up-to-date at ${BINARY} (skipping rebuild)`);
  }

  const summary = runOracle();
  console.log("[adapter] " +
    `inputs=${summary.inputCount} ` +
    `success=${summary.success} ` +
    `refused_complex=${summary.refusedComplex} ` +
    `refused_other=${summary.refusedOther} ` +
    `errors=${summary.errors} ` +
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
