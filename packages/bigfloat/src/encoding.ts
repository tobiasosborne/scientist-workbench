// =============================================================================
// @workbench/bigfloat — value-protocol encoding for BigFloat / BigComplex
// =============================================================================
//
// Per ADR-0020, BigFloat is encoded as
//
//     tagged("bigfloat", record({
//       mantissa: integer(<decimal-string>),
//       exponent: integer(<decimal-string>),
//       precision: integer(<decimal-string>),
//     }))
//
// and BigComplex as
//
//     tagged("bigcomplex", record({
//       re: <bigfloat-encoded value>,
//       im: <bigfloat-encoded value>,
//     }))
//
// `tagged` is the protocol's mechanism for "complex types built from
// primitives" (see ADR-0006: Sturm IR is also tagged); we do *not* add a
// new primitive to the value protocol (PRD §2.2 stays at 10 kinds).
//
// Tools that operate on bigfloat declare schemas using
// `bigfloatSchema` / `bigcomplexSchema`; the runner validates incoming
// values via the protocol's structural validator.

import {
  type Value,
  type TaggedValue,
  type Schema,
  type Kind,
  type SchemaNode,
  ProtocolError,
  S,
  tagged,
  record,
  int,
  taggedSchema,
  recordSchema,
} from "@workbench/protocol";
import type { BigFloat } from "./types.js";
import type { BigComplex } from "./complex.js";

/** The tag string identifying a bigfloat-encoded tagged value. */
export const BIGFLOAT_TAG = "bigfloat";

/** The tag string identifying a bigcomplex-encoded tagged value. */
export const BIGCOMPLEX_TAG = "bigcomplex";

/**
 * Encode a `BigFloat` into a value-protocol `Value`.
 *
 *   bigfloatToValue({mantissa: 12n, exponent: -3, precision: 4})
 *     ⟹ tagged("bigfloat", record({
 *          mantissa: integer("12"),
 *          exponent: integer("-3"),
 *          precision: integer("4"),
 *        }))
 */
export function bigfloatToValue(a: BigFloat): TaggedValue {
  return tagged(
    BIGFLOAT_TAG,
    record({
      mantissa: int(a.mantissa),
      exponent: int(BigInt(a.exponent)),
      precision: int(BigInt(a.precision)),
    }),
  );
}

/**
 * Decode a value-protocol `Value` into a `BigFloat`. Throws
 * `ProtocolError` if the value is not a well-formed bigfloat encoding.
 *
 * Validation is structural: the tag must be `"bigfloat"`, the payload
 * must be a record with exactly the three integer fields, and the
 * `precision` field must be a positive integer (per the BigFloat
 * invariants).
 *
 * Does NOT verify the BigFloat invariants on the resulting value
 * (that `|mantissa|` has exactly `precision` bits, etc.); use
 * `validate(...)` from `./types.ts` to do that. The split is
 * deliberate: the encoding round-trip is well-defined for any
 * `(mantissa, exponent, precision)` triple, and `validate` is the
 * load-time check at API boundaries.
 */
export function valueToBigFloat(v: Value): BigFloat {
  if (v.kind !== "tagged" || v.tag !== BIGFLOAT_TAG) {
    throw new ProtocolError(
      `valueToBigFloat: expected tagged "${BIGFLOAT_TAG}", got ${v.kind === "tagged" ? `tagged "${v.tag}"` : v.kind}`,
    );
  }
  const payload = v.payload;
  if (payload.kind !== "record") {
    throw new ProtocolError(
      `valueToBigFloat: payload must be a record, got ${payload.kind}`,
    );
  }
  const { mantissa, exponent, precision } = payload.fields;
  if (mantissa === undefined || mantissa.kind !== "integer") {
    throw new ProtocolError(
      `valueToBigFloat: payload.mantissa must be an integer; got ${mantissa?.kind ?? "absent"}`,
    );
  }
  if (exponent === undefined || exponent.kind !== "integer") {
    throw new ProtocolError(
      `valueToBigFloat: payload.exponent must be an integer; got ${exponent?.kind ?? "absent"}`,
    );
  }
  if (precision === undefined || precision.kind !== "integer") {
    throw new ProtocolError(
      `valueToBigFloat: payload.precision must be an integer; got ${precision?.kind ?? "absent"}`,
    );
  }
  const mantissaBig = BigInt(mantissa.value);
  const exponentNum = Number(exponent.value);
  const precisionNum = Number(precision.value);
  if (
    !Number.isInteger(exponentNum) ||
    !Number.isFinite(exponentNum) ||
    !Number.isInteger(precisionNum) ||
    !Number.isFinite(precisionNum)
  ) {
    throw new ProtocolError(
      `valueToBigFloat: exponent / precision must fit a JS number (Number.isSafeInteger range)`,
    );
  }
  if (precisionNum < 1) {
    throw new ProtocolError(
      `valueToBigFloat: precision must be ≥ 1; got ${precisionNum}`,
    );
  }
  return {
    mantissa: mantissaBig,
    exponent: exponentNum,
    precision: precisionNum,
  };
}

/**
 * Encode a `BigComplex` into a value-protocol `Value`.
 */
export function bigcomplexToValue(a: BigComplex): TaggedValue {
  return tagged(
    BIGCOMPLEX_TAG,
    record({
      re: bigfloatToValue(a.re),
      im: bigfloatToValue(a.im),
    }),
  );
}

/**
 * Decode a value-protocol `Value` into a `BigComplex`. Validates that the
 * tag is `"bigcomplex"`, the payload has `re` and `im` bigfloat-encoded
 * fields, and recursively decodes them.
 */
export function valueToBigComplex(v: Value): BigComplex {
  if (v.kind !== "tagged" || v.tag !== BIGCOMPLEX_TAG) {
    throw new ProtocolError(
      `valueToBigComplex: expected tagged "${BIGCOMPLEX_TAG}", got ${v.kind === "tagged" ? `tagged "${v.tag}"` : v.kind}`,
    );
  }
  const payload = v.payload;
  if (payload.kind !== "record") {
    throw new ProtocolError(
      `valueToBigComplex: payload must be a record, got ${payload.kind}`,
    );
  }
  const { re, im } = payload.fields;
  if (re === undefined) {
    throw new ProtocolError(`valueToBigComplex: payload.re is missing`);
  }
  if (im === undefined) {
    throw new ProtocolError(`valueToBigComplex: payload.im is missing`);
  }
  return { re: valueToBigFloat(re), im: valueToBigFloat(im) };
}

/**
 * Schema declaring a `tagged "bigfloat"` value. Tools that take a BigFloat
 * input or produce one as output use this in their `S.record({...})`.
 *
 * Example:
 *   const inputSchema = S.record({
 *     z: bigfloatSchema,
 *     precision: S.kind("integer"),
 *   });
 */
export const bigfloatSchema: Schema = taggedSchema(
  BIGFLOAT_TAG,
  recordSchema({
    mantissa: S.kind("integer"),
    exponent: S.kind("integer"),
    precision: S.kind("integer"),
  }),
);

/**
 * Schema declaring a `tagged "bigcomplex"` value.
 */
export const bigcomplexSchema: Schema = taggedSchema(
  BIGCOMPLEX_TAG,
  recordSchema({
    re: bigfloatSchema,
    im: bigfloatSchema,
  }),
);
