// =============================================================================
// platform.ts — runtime fingerprint for the determinism tier (ADR-0015)
// =============================================================================
//
// Substrate: ADR-0015. The numerical tier weakens the cross-platform bit-
// identity contract: tools annotated `numerical: true` are bit-identical
// *given the platform fingerprint*, with cross-platform divergence
// honestly recorded in the provenance record's optional `platform` field.
//
// This module owns "what is the running platform?" and "what is its
// content-address hash?" — and the value-protocol round-trip
// (`platformToValue` / `valueToPlatform`) so the fingerprint can be
// embedded in canonical bytes like every other Value in the system.
//
// Three-field fingerprint, justified by measurement
// -------------------------------------------------
// `{arch, os, runtime}`. The cross-Bun-version measurement on linux-
// x86_64-WSL2 (docs/data/cross-bun-stability/) showed `runtime_version`
// is *not* a stability axis on this platform window: 100/100 hashes
// byte-identical Bun 1.2.21 ↔ 1.3.13 on Hilbert(7), Wilkinson(8), and
// 87 random matrices. Including `runtime_version` would generate
// spurious cache misses on every Bun upgrade for zero correctness
// benefit. The narrowest fingerprint the data supports is the one we
// ship; cross-arch data (when it exists, bead `auz`) grows the schema
// additively under the omitted-when-absent convention.
//
// Why not `libc`, `microarch`, etc.
// ----------------------------------
// Pure-TS-on-JSC float ops go through V8/JSC's runtime, not directly
// through libm. A future FFI tier (bead `e7y`) that links into LAPACK
// or BLAS would care about libc — but those tools would carry their
// own tier annotation, and the fingerprint they need can grow then.
// Today's pure-TS numerical tier is fingerprinted by the running
// `(arch, os, runtime)` triple, full stop.

import { canonicalize, hash, ProtocolError, record, str, type Hash, type Value } from "@workbench/protocol";

/**
 * The three fields the cross-Bun-version measurement justifies. Plain
 * record. Round-trips through the value protocol via
 * `platformToValue` / `valueToPlatform`.
 */
export interface PlatformRecord {
  /** e.g., "x86_64", "aarch64". From `process.arch`, normalised to the canonical name. */
  arch: string;
  /** e.g., "linux", "darwin", "win32". From `process.platform`. */
  os: string;
  /** e.g., "bun", "node". Detected at runtime; today only "bun" is supported. */
  runtime: string;
}

/**
 * `process.arch` returns Node-flavoured names ("x64", "arm64"); we
 * normalise to the names the rest of the systems-programming world uses
 * ("x86_64", "aarch64"). Stable across Node and Bun. Anything we don't
 * recognise is passed through verbatim — better to honestly report
 * "unknown-arch" than to invent a normalisation we can't verify.
 */
function normalisedArch(): string {
  const a = process.arch as string;
  switch (a) {
    case "x64": return "x86_64";
    case "arm64": return "aarch64";
    case "ia32": return "i386";
    default: return a;
  }
}

/**
 * Returns "bun" when running under Bun (detected via the `Bun` global);
 * "node" otherwise. Future runtimes (Deno, Cloudflare Workers, …) would
 * be added to this switch with their own detection.
 */
function detectRuntime(): string {
  const g = globalThis as unknown as { Bun?: unknown };
  if (typeof g.Bun !== "undefined") return "bun";
  return "node";
}

/**
 * Snapshot the running platform. Pure read of `process.{arch,platform}`
 * + runtime detection — no IO, no allocation beyond the returned record.
 *
 * Stable across calls within one process; callers that want it once and
 * cached should hold the result themselves (no module-level memoisation
 * here — keeps the function side-effect-free at import time per ADR-0010).
 */
export function currentPlatform(): PlatformRecord {
  return {
    arch: normalisedArch(),
    os: process.platform,
    runtime: detectRuntime(),
  };
}

/**
 * Encode a `PlatformRecord` as a canonical Value. The encoding is fixed
 * so that two platforms with the same triple hash to the same content
 * address — which is the property `runMemoized`'s cache-skip path
 * relies on for cross-platform comparison.
 *
 * Field order in the source object is irrelevant; canonicalisation
 * sorts keys lexicographically.
 */
export function platformToValue(p: PlatformRecord): Value {
  return record({
    arch: str(p.arch),
    os: str(p.os),
    runtime: str(p.runtime),
  });
}

/**
 * Inverse of `platformToValue`. Throws `ProtocolError` (with a path)
 * when the Value is shape-wrong — matches the validation discipline
 * the rest of the protocol uses.
 */
export function valueToPlatform(v: Value): PlatformRecord {
  if (v.kind !== "record") {
    throw new ProtocolError(`platform: expected record, got ${v.kind}`);
  }
  const f = v.fields;
  const arch = f["arch"];
  const os = f["os"];
  const runtime = f["runtime"];
  if (arch === undefined || arch.kind !== "string") {
    throw new ProtocolError("platform.arch: expected string");
  }
  if (os === undefined || os.kind !== "string") {
    throw new ProtocolError("platform.os: expected string");
  }
  if (runtime === undefined || runtime.kind !== "string") {
    throw new ProtocolError("platform.runtime: expected string");
  }
  return { arch: arch.value, os: os.value, runtime: runtime.value };
}

/**
 * Content-addressed fingerprint hash. Same triple → same hash → same
 * cache slot. Different triple → different hash → different cache
 * slot, and `runMemoized`'s lookup walks past it as a miss.
 */
export function platformHash(p: PlatformRecord): Hash {
  return hash(platformToValue(p));
}

/**
 * Convenience: the running platform's fingerprint hash. Equivalent to
 * `platformHash(currentPlatform())` but written once for clarity at
 * the call sites that just want "am I matching this stored record?"
 */
export function currentPlatformHash(): Hash {
  return platformHash(currentPlatform());
}

/**
 * Canonical bytes of the running platform, for the `--platform-fingerprint`
 * standard flag. Returns a record carrying both the human-readable
 * fingerprint *and* its content-address hash, so an agent's planner can
 * compare a stored provenance record's `platform` field by hash without
 * reconstructing it from triples.
 */
export function platformFingerprintValue(): Value {
  const p = currentPlatform();
  return record({
    fingerprint: platformToValue(p),
    hash: str(platformHash(p)),
  });
}

/**
 * Canonical-bytes form of the running platform for stdout. Convenience
 * for the runner — `runTool`'s `--platform-fingerprint` dispatch line
 * stays a one-liner.
 */
export function platformFingerprintBytes(): string {
  return canonicalize(platformFingerprintValue());
}
