// Content-addressed store layout.
//   $CAS_STORE/values/<hh>/<hash>.json
//   $CAS_STORE/provenance/<hh>/<hash>.json
// where <hh> = first two hex chars of <hash>.
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
