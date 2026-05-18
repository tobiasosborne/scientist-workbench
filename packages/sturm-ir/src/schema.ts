// =============================================================================
// schema — value-level Schema declarations for the Sturm IR
// =============================================================================
//
// Why this file exists
// --------------------
// The runner validates a tool's input against its declared `Schema`
// before calling `fn` (ADR-0004). Sturm tools that consume an IR
// channel — `sturm-simplify`, `sturm-execute`, `sturm-equivalent`,
// `sturm-sample`, `sturm-trace`, `sturm-bennett-oracle`,
// `sturm-qecc-wrap`, the combinators — all want to declare their
// input as `channelSchema`. Hand-rolling that schema in every tool
// would invite drift; this file is the single canonical declaration.
//
// What is and isn't here
// ----------------------
// The schema layer is *non-recursive* — ADR-0004 deliberately omits
// recursive schemas. The Sturm IR genuinely is recursive: a `cases`
// op has arms that are lists of ops; an `oracle` op embeds a
// `channel` Value. We accept this gap by making the schema a *shallow
// shape check* for those slots and delegating recursive validation to
// `decodeOp` / `decodeChannel` (in `nodes.ts`) and to `checkWellFormed`
// (in `wellformed.ts`). That layering — schema first, decode second,
// well-formedness third — is the same pattern the rest of the
// codebase uses for nested structures (cf. `cas-core`'s
// `valueToRatFn`, which is a recursive value walk over ratfn
// arithmetic that the schema doesn't try to encode).
//
// Concretely:
//   • `wireSchema` validates the wire record shape exactly.
//   • `opSchema` validates the seven op heads with positional args,
//     including the *types* of those args except for the recursive
//     slots: `cases` arms are `S.list(S.any())`, and `oracle.circuit`
//     is `S.any()`. Decoding catches a non-conforming arm/circuit.
//   • `channelSchema` validates the top-level `expression "channel"`
//     wrapper with the wire signatures and the body as a list of
//     ops conforming to `opSchema`.
//
// The closure of the op-head set in `S.union` is the load-bearing
// fact. A Value with head `"cnot"` or `"hadamard"` in the body
// triggers a schema validation failure (`union: no alternative
// matched`). P5 (no gates, no qubits) is enforced as a structural
// type property at the workbench layer — strictly more than at the
// TS source layer where lint can be bypassed.
//
// The closure simultaneously enforces the **coherent-control
// restriction** named in ADR-0038: only `ry` and `rz` declare a
// third `controls` arg in their `S.expression(…)` tuples. A Value
// like `expr("observe", [int(0n), str("r"), list([int(1n)])])` — an
// `observe` with three args, smuggling controls — fails because the
// `observe` alternative is declared with arity 2. This is Layer 1
// (schema closure) of ADR-0038's four-layer enforcement; the other
// three are in `nodes.ts` (builder API + decoder arity) and
// `wellformed.ts` (cases-arm recursive analogue).

import { S, str, type Schema, type Value } from "@workbench/protocol";

// -----------------------------------------------------------------------------
// wireSchema
// -----------------------------------------------------------------------------
//
// `kind` is a union of the two allowed string literals. `dim` is
// optional and a union of the four declared dimensions; v0.1 emits
// only "qubit", but the schema admits the others additively per P7
// (dimension-agnostic). A tool that produces wires with unknown
// `dim` strings fails schema validation, which is the right answer:
// extending the dimension space is a coordinated change with its
// own ADR, not a quiet new tag.

export const wireSchema: Schema<Value> = S.record(
  {
    id: S.kind("integer"),
    kind: S.union([S.literal(str("classical")), S.literal(str("quantum"))]),
    dim: S.union([
      S.literal(str("qubit")),
      S.literal(str("qudit")),
      S.literal(str("anyon")),
      S.literal(str("boson")),
    ]),
  },
  { optional: ["dim"] }
);

// -----------------------------------------------------------------------------
// opSchema — the closed seven-head union
// -----------------------------------------------------------------------------
//
// Each alternative is `S.expression(<head>, <args-tuple>)`. The args
// tuple is positional, so the schema simultaneously asserts both the
// op's arity and the type of each arg. `S.any()` shows up exactly
// where the IR is genuinely heterogeneous — `prepare`'s `p` and the
// rotation `delta` can be rationals, float64s, or symbolic
// expressions; `oracle.circuit` is itself a `channel` Value that
// would be recursive; `cases` arms are op-lists that would also be
// recursive. The decoder fills those gaps.
//
// `controls` on `ry`/`rz` is `S.list(S.kind("integer"))` — a list of
// wire IDs. The empty-list case (unconditional rotation) and the
// non-empty case (controlled rotation) are both covered by the same
// alternative; no additional schema-level distinction is required.

const wireIdListSchema = S.list(S.kind("integer"));
const opListAnySchema = S.list(S.any());

export const opSchema: Schema<Value> = S.union([
  // prepare(p, wire_id)
  S.expression("prepare", [S.any(), S.kind("integer")]),
  // ry(wire_id, delta, controls)
  S.expression("ry", [S.kind("integer"), S.any(), wireIdListSchema]),
  // rz(wire_id, delta, controls)
  S.expression("rz", [S.kind("integer"), S.any(), wireIdListSchema]),
  // observe(wire_id, classical_ref)
  S.expression("observe", [S.kind("integer"), S.kind("string")]),
  // oracle(circuit, in_wires, out_wires)
  S.expression("oracle", [S.any(), wireIdListSchema, wireIdListSchema]),
  // cases(classical_ref, true_arm, false_arm)
  S.expression("cases", [S.kind("string"), opListAnySchema, opListAnySchema]),
  // discard(wire_id)
  S.expression("discard", [S.kind("integer")]),
]);

// -----------------------------------------------------------------------------
// channelSchema
// -----------------------------------------------------------------------------
//
// `expression "channel"` with three positional args:
//   args[0] = list<wire>   (input signature)
//   args[1] = list<wire>   (output signature)
//   args[2] = list<op>     (body)
//
// The body's list-element schema is `opSchema`, which validates the
// shallow shape of every op including the closed head set. Recursion
// into `cases` arms and `oracle` circuits is the decoder's job.

export const channelSchema: Schema<Value> = S.expression("channel", [
  S.list(wireSchema),
  S.list(wireSchema),
  S.list(opSchema),
]);
