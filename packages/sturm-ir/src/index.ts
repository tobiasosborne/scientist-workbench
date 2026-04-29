// =============================================================================
// @workbench/sturm-ir — Sturm IR types, schemas, well-formedness, traversal
// =============================================================================
//
// Public surface for the package. Tools that consume Sturm channels
// (sturm-simplify, sturm-execute, sturm-equivalent, sturm-sample,
// sturm-trace, sturm-bennett-oracle, sturm-qecc-wrap, the channel
// combinators) import from here.
//
// The four sub-modules in this package are layered:
//
//   nodes.ts       typed in-memory IR + builders + encoders + decoders
//   schema.ts      value-level Schema declarations for the runner
//   wellformed.ts  invariants beyond what the schema catches
//   traverse.ts    visitor with controls-stack maintenance
//
// Most tools want all four; we re-export the public names below.
// See ADR-0006 for the design and `docs/sturm-ts/principles.md` for
// the principles this package realises (P1, P3, P5 in particular).

export {
  type Wire,
  type WireKind,
  type WireDim,
  type Channel,
  type Op,
  type OpHead,
  type PrepareOp,
  type RyOp,
  type RzOp,
  type ObserveOp,
  type OracleOp,
  type CasesOp,
  type DiscardOp,
  wire,
  channel,
  prepareOp,
  ryOp,
  rzOp,
  observeOp,
  oracleOp,
  casesOp,
  discardOp,
  encodeWire,
  encodeOp,
  encodeChannel,
  decodeWire,
  decodeOp,
  decodeChannel,
} from "./nodes.js";

export { wireSchema, opSchema, channelSchema } from "./schema.js";

export {
  type WellFormedFailure,
  type WellFormedResult,
  checkWellFormed,
} from "./wellformed.js";

export { type OpVisitor, type VisitContext, traverseChannel } from "./traverse.js";
