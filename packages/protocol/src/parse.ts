// parse: canonical-bytes → typed Value.
// Accepts any JSON that decodes into a valid Value; rejects raw numbers and unknown kinds
// at validation time (see validate.ts). The parsed object is not required to have
// canonically-sorted keys — that is `canonicalize`'s job.

import { ProtocolError } from "./errors.js";
import { validateValue } from "./validate.js";
import type { Value } from "./kinds.js";

export function parse(s: string): Value {
  let raw: unknown;
  try {
    raw = JSON.parse(s, (_key, value) => {
      // Reject raw JSON numbers anywhere in the tree. JSON.parse delivers them
      // as JS numbers; we throw before they propagate.
      if (typeof value === "number") {
        throw new ProtocolError("raw JSON numbers are forbidden in the value protocol");
      }
      return value;
    });
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError(`JSON parse failed: ${(e as Error).message}`);
  }
  return validateValue(raw);
}
