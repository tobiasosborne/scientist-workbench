// Content-addressed store layout.
//   $CAS_STORE/values/<hh>/<hash>.json
//     — the canonical Value bytes (one file per content-hash). Written
//       on every successful tool run by `executeToolDef`.
//   $CAS_STORE/provenance/<hh>/<output-hash>.json
//     — the provenance record indexed by output hash (PRD §3.2).
//   $CAS_STORE/by-input/<hh>/<input-hash>--<tool>--<version>.json
//     — the reverse-index from input hash to output hash, used by
//       `Workbench.lookup` (ADR-0012, issue scientist-workbench-mtw).
//       The filename encodes (tool, version) so concurrent versions
//       coexist without collision; <hh> is the first two hex chars
//       of the input hash for the same shard discipline.
// where <hh> = first two hex chars of the indexing hash.
//
// Default location: $CAS_STORE env var, else $HOME/.scientist-workbench/cas-store.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalize, hash, parse, type Hash, type Value } from "@workbench/protocol";

export function defaultStore(): string {
  return process.env["CAS_STORE"] ?? join(homedir(), ".scientist-workbench", "cas-store");
}

export function valuePath(store: string, h: Hash): string {
  return join(store, "values", h.substring(0, 2), `${h}.json`);
}

export function provenancePath(store: string, h: Hash): string {
  return join(store, "provenance", h.substring(0, 2), `${h}.json`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(p: string, contents: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { encoding: "utf8" });
  // Best-effort rename. If the target already exists, that's fine — content-addressed.
  try {
    const { rename } = await import("node:fs/promises");
    await rename(tmp, p);
  } catch (e) {
    if (await exists(p)) {
      const { unlink } = await import("node:fs/promises");
      await unlink(tmp).catch(() => {});
    } else {
      throw e;
    }
  }
}

export async function writeValue(store: string, v: Value): Promise<Hash> {
  const bytes = canonicalize(v);
  const h = hash(v);
  await writeAtomic(valuePath(store, h), bytes);
  return h;
}

export async function readValue(store: string, h: Hash): Promise<Value | null> {
  const p = valuePath(store, h);
  try {
    const bytes = await readFile(p, "utf8");
    return parse(bytes);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeRawProvenance(store: string, outputHash: Hash, contents: string): Promise<void> {
  await writeAtomic(provenancePath(store, outputHash), contents);
}

export async function readRawProvenance(store: string, outputHash: Hash): Promise<string | null> {
  const p = provenancePath(store, outputHash);
  try {
    return await readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// -----------------------------------------------------------------------------
// Reverse index: (input hash, tool, version) → output hash
// -----------------------------------------------------------------------------
//
// The forward provenance file is keyed by output hash. For
// `Workbench.lookup`, we need the reverse: given an input hash and a
// `(tool, version)`, find the output hash without scanning every
// provenance record. The reverse index file encodes that lookup as a
// single stat + read (sub-millisecond on a warm fs cache), keeping
// `lookup` O(1) regardless of store size.
//
// The index file's *content* is the output hash as a hex string —
// nothing more. The file's existence is the cache-presence signal,
// and its content is the pointer into `values/<hh>/<output>.json`.

/** Index-file path. Tool name + version go into the filename, not the directory. */
export function byInputPath(
  store: string,
  inputHash: Hash,
  toolName: string,
  version: string,
): string {
  const safeTool = toolName.replace(/[^a-z0-9-]/g, "_");
  const safeVersion = version.replace(/[^a-z0-9.\-]/gi, "_");
  return join(
    store,
    "by-input",
    inputHash.substring(0, 2),
    `${inputHash}--${safeTool}--${safeVersion}.json`,
  );
}

export async function writeByInputIndex(
  store: string,
  inputHash: Hash,
  toolName: string,
  version: string,
  outputHash: Hash,
): Promise<void> {
  await writeAtomic(byInputPath(store, inputHash, toolName, version), outputHash);
}

export async function readByInputIndex(
  store: string,
  inputHash: Hash,
  toolName: string,
  version: string,
): Promise<Hash | null> {
  try {
    const raw = await readFile(
      byInputPath(store, inputHash, toolName, version),
      "utf8",
    );
    const trimmed = raw.trim();
    if (!/^[0-9a-f]{64}$/i.test(trimmed)) return null;  // corrupt index entry
    return trimmed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
