// Public surface of @workbench/alg-num.
//
// `Root[poly, k]` — the workbench's encoding of "name a particular
// algebraic number by minimal polynomial and sort-order index." See
// ADR-0018 for the design rationale; `src/root.ts` for the type, the
// canonical constructor, and equality; `src/encoding.ts` for the
// value-protocol bridge.
//
// Scope of v0.1: real-root construction (the constructor accepts a
// real-isolating-interval hint). Complex-root naming is a future
// shard once complex-root isolation lands. Lazy interval refinement
// (xkz), full equality with non-canonical inputs (6cd), and
// resultant-based arithmetic (rti) are tracked separately and will
// extend this surface.

export {
  type Root,
  type RatInterval,
  ROOT_VAR,
  makeRoot,
  rootCanonicalEq,
  canonicalIntegerForm,
  polyToHighToLowRat,
  signAtRat,
} from "./root.js";

export { rootToValue, valueToRoot } from "./encoding.js";

export { makeRootByIndex } from "./by-index.js";

export {
  type RefineTarget,
  refineRoot,
  intervalWidth,
} from "./refine.js";
