// =============================================================================
// Subprocess plumbing — the single owner of "where is `bun`?"
// =============================================================================
//
// The workbench is a polyglot of bun processes spawning bun processes:
// `scripts/check.ts` runs each tool's `--test` hook, then asks `oracle` to
// diff goldens, which itself spawns the tool under test. `registry-list` and
// `registry-search` invoke each tool's `--schema` / `--examples` /
// `--invariants` / `--version` flags to build their results. Every one of
// those call sites needs to know how to invoke the bun executable.
//
// In a vanilla install, `which bun` returns a path, `spawn(...)` works, and
// nobody thinks about it. The trouble starts when bun is installed via snap
// (the Ubuntu/Debian default for many users): `/snap/bin/bun` is a symlink
// chain that ends in a wrapper script, and trying to spawn it from inside
// another snap-confined bun process fails with a deeply opaque
//
//     Error: cannot join mount namespace of pid 1: Operation not permitted
//
// (or `ENOENT` when even the wrapper isn't reachable). The actual binary
// lives at `/snap/bun-js/current/_bun/bin/bun`. Spawn that directly and
// everything works.
//
// This module is the one place that knows that fact. It exists for two
// reasons.
//
// First, every other call site in the workbench previously had its own
// `BUN_CMD = process.env["BUN_BIN"] ?? "bun"` fallback, and the `"bun"`
// branch silently degraded on snap installs unless the user had set
// `BUN_BIN`. We want that knowledge in exactly one place so the next time a
// new install corner shows up (Homebrew sandboxing, Windows Store, dev
// containers) the fix is one PR, not seven.
//
// Second, several callers used to silently swallow spawn failures:
//
//     try { meta = await describeTool(...); } catch { continue; }
//
// On a snap install where every spawn fails, that loop produces an empty
// list — indistinguishable from "no tool matched the filter." This was the
// most damaging instance of the bug. The resolver here is paired with a
// migration of those silent catches to *visible* failures (logged to
// stderr, counted, surfaced in the result). See ADR-0001.
//
// -----------------------------------------------------------------------------
// Resolution order
// -----------------------------------------------------------------------------
//
// `resolveBunBinary()` walks the following ladder:
//
//   1. honour `process.env.BUN_BIN` if set — the user is in charge.
//   2. if we're already running under bun (the typical case in this
//      workbench), use `process.execPath`. This is the most authoritative
//      source: the path to the binary actually executing this code. It
//      sidesteps a snap-specific corner where `existsSync` on `/snap/bin/*`
//      returns false from inside a snap-confined process — even though
//      that same path clearly worked to launch the parent.
//   3. otherwise, walk `PATH` for an executable named `bun`.
//   4. `realpathSync` the result. This is the snap-symlink collapse:
//      `/snap/bin/bun` ⇒ `/snap/bun-js/current/_bun/bin/bun`
//      (one or two symlink hops, depending on the snap revision).
//   5. smoke-test by spawning `<resolved> --version` synchronously; if that
//      fails, throw a diagnostic naming the resolved path and the errno.
//   6. cache the resolved path for the rest of the process lifetime.
//
// The smoke-test costs ~10 ms once. The alternative is a mysterious
// downstream spawn failure ten seconds into a test run.

import { spawn, spawnSync, type SpawnOptions, type ChildProcess } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Cached resolved path. `null` means "not yet resolved this process."
// Populated lazily on the first `resolveBunBinary()` call.
let cached: string | null = null;

// -----------------------------------------------------------------------------
// PATH walk
// -----------------------------------------------------------------------------
//
// Node has no public "which" API, so we do the obvious thing: split `PATH` on
// the platform delimiter and check each candidate for existence. On Windows
// we also extend with `PATHEXT` so `bun.exe` resolves; elsewhere there is no
// extension to add.

function resolveOnPath(name: string): string | null {
  const path = process.env["PATH"] ?? "";
  const exts = process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Public API: resolveBunBinary
// -----------------------------------------------------------------------------
//
// Returns the absolute, canonical path to the bun executable. Throws a
// descriptive error if no bun is reachable. The returned path is suitable to
// pass directly to `spawn()` without further PATH lookup.
//
// Callers that catch this error should re-throw or surface the message to
// stderr — silent catches around spawn machinery are the antipattern this
// module exists to retire.

export function resolveBunBinary(): string {
  if (cached !== null) return cached;

  // Step 1: explicit BUN_BIN wins.
  const fromEnv = process.env["BUN_BIN"];
  let initial: string | null = fromEnv && fromEnv.length > 0 ? fromEnv : null;

  // Step 2: if we're already running under bun, the binary that started us
  // is the most authoritative answer. `process.execPath` returns it.
  // Detect bun specifically by checking globalThis.Bun (set by the bun
  // runtime; absent in plain Node).
  if (initial === null && typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    initial = process.execPath;
  }

  // Step 3: PATH fallback (mainly for callers running under plain Node, or
  // for tests).
  if (initial === null) initial = resolveOnPath("bun");

  if (initial === null) {
    throw new Error(
      "resolveBunBinary: cannot find bun on PATH and BUN_BIN is unset. " +
      "Install Bun (curl -fsSL https://bun.sh/install | bash) or export BUN_BIN to its absolute path."
    );
  }

  // Step 3: collapse symlinks. The snap chain is the motivating case but the
  // logic is general; any install path that goes through a symlink wrapper
  // is handled the same way.
  let real: string;
  try {
    real = realpathSync(initial);
  } catch (e) {
    throw new Error(`resolveBunBinary: bun candidate '${initial}' does not resolve via realpath: ${(e as Error).message}`);
  }

  // Defensive second hop. realpath should have fully resolved to an absolute
  // path; if for some platform-specific reason it returned a relative path
  // (this has been observed on snap when `realpath` reports `bun-js.bun`
  // instead of the full chain), retry once. If that fails, keep what we
  // have — better to attempt the spawn and surface a real error than to
  // refuse to try.
  if (!real.startsWith("/") && real.length > 0) {
    try {
      real = realpathSync(real);
    } catch {
      // fall through
    }
  }

  // Step 4: smoke-test. If this errors, we want the failure visible *here*,
  // at startup, not buried inside a test-run report ten seconds later.
  const probe = spawnSync(real, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (probe.error || probe.status !== 0) {
    const detail = probe.error
      ? probe.error.message
      : `exit ${probe.status}: ${probe.stderr?.toString().trim() ?? ""}`;
    throw new Error(
      `resolveBunBinary: resolved bun at '${real}' but cannot invoke it (${detail}). ` +
      `If this is a snap install, set BUN_BIN to the underlying binary (e.g. /snap/bun-js/current/_bun/bin/bun).`
    );
  }

  cached = real;
  return real;
}

// Test-only escape hatch. Production code never needs this; tests that
// stub `BUN_BIN` to verify the resolver does the right thing call it
// between cases.
export function _resetBunBinaryCache(): void {
  cached = null;
}

// -----------------------------------------------------------------------------
// Public API: spawnBun
// -----------------------------------------------------------------------------
//
// The promise-shaped wrapper most workbench code actually wants: spawn bun
// with `args`, optionally pipe `stdin` in, return `{ code, stdout, stderr }`.
// Two flavours of stdio depending on whether we have stdin to pipe — Node's
// default of inheriting a parent's stdin is wrong for our use case (we want
// the child to read the buffer we control, or nothing).

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawnBun(args: string[], stdin?: string, options?: SpawnOptions): Promise<SpawnResult> {
  const bin = resolveBunBinary();
  return new Promise((resolve, reject) => {
    const stdio: SpawnOptions["stdio"] =
      stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const p: ChildProcess = spawn(bin, args, { ...options, stdio });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (b) => (stdout += (b as Buffer).toString("utf8")));
    p.stderr?.on("data", (b) => (stderr += (b as Buffer).toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined && p.stdin) {
      p.stdin.write(stdin, "utf8");
      p.stdin.end();
    }
  });
}
