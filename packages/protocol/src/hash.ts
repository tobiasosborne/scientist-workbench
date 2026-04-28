// Content hash = sha256 of canonical bytes, hex-encoded.
// Two values with the same hash are the same value (modulo collision).

import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { Hash, Value } from "./kinds.js";

export function hash(v: Value): Hash {
  return createHash("sha256").update(canonicalize(v), "utf8").digest("hex");
}

export function hashCanonicalBytes(s: string): Hash {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
