// =============================================================================
// encoding.test — value-protocol round-trip for BigFloat / BigComplex
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  bigfloatToValue,
  valueToBigFloat,
  bigcomplexToValue,
  valueToBigComplex,
  bigfloatSchema,
  bigcomplexSchema,
  BIGFLOAT_TAG,
  BIGCOMPLEX_TAG,
  fromInt,
  fromString,
  fromFloat64,
  cfromStrings,
  type BigFloat,
  type BigComplex,
} from "../src/index.js";
import {
  canonicalize,
  conforms,
  ProtocolError,
  tagged,
  record,
  int,
} from "@workbench/protocol";

describe("BigFloat encoding", () => {
  test("zero round-trip", () => {
    const a: BigFloat = { mantissa: 0n, exponent: 0, precision: 53 };
    const v = bigfloatToValue(a);
    expect(v.kind).toBe("tagged");
    expect(v.tag).toBe(BIGFLOAT_TAG);
    const b = valueToBigFloat(v);
    expect(b).toEqual(a);
  });

  test("non-trivial round-trip", () => {
    const cases: BigFloat[] = [
      fromInt(7n, 53),
      fromInt(-12345n, 100),
      fromString("3.14159265358979323846", 200),
      fromFloat64(0.1),
      fromFloat64(-1e-300),
    ];
    for (const a of cases) {
      const v = bigfloatToValue(a);
      const b = valueToBigFloat(v);
      expect(b.mantissa).toBe(a.mantissa);
      expect(b.exponent).toBe(a.exponent);
      expect(b.precision).toBe(a.precision);
    }
  });

  test("encoded value canonicalises to a stable byte stream", () => {
    const a = fromString("1.5", 53);
    const bytes1 = canonicalize(bigfloatToValue(a));
    const bytes2 = canonicalize(bigfloatToValue(a));
    expect(bytes1).toBe(bytes2);
  });

  test("encoded value conforms to bigfloatSchema", () => {
    const a = fromInt(42n, 100);
    const v = bigfloatToValue(a);
    expect(conforms(v, bigfloatSchema)).toBe(true);
  });

  test("non-conforming value rejected by schema", () => {
    // A record without the right fields shouldn't conform.
    const bogus = tagged(BIGFLOAT_TAG, record({ wrong: int(0n) }));
    expect(conforms(bogus, bigfloatSchema)).toBe(false);
  });
});

describe("valueToBigFloat — error paths", () => {
  test("non-tagged value", () => {
    expect(() => valueToBigFloat(int(0n))).toThrow(ProtocolError);
  });

  test("wrong tag", () => {
    expect(() =>
      valueToBigFloat(tagged("not-bigfloat", record({}))),
    ).toThrow(ProtocolError);
  });

  test("missing field", () => {
    expect(() =>
      valueToBigFloat(
        tagged(
          BIGFLOAT_TAG,
          record({ mantissa: int(0n), exponent: int(0n) }),
        ),
      ),
    ).toThrow(ProtocolError);
  });

  test("non-integer field", () => {
    expect(() =>
      valueToBigFloat(
        tagged(
          BIGFLOAT_TAG,
          record({
            mantissa: int(0n),
            exponent: int(0n),
            precision: tagged("foo", int(0n)),
          }),
        ),
      ),
    ).toThrow(ProtocolError);
  });

  test("zero precision rejected", () => {
    expect(() =>
      valueToBigFloat(
        tagged(
          BIGFLOAT_TAG,
          record({
            mantissa: int(0n),
            exponent: int(0n),
            precision: int(0n),
          }),
        ),
      ),
    ).toThrow(ProtocolError);
  });
});

describe("BigComplex encoding", () => {
  test("zero round-trip", () => {
    const a: BigComplex = {
      re: { mantissa: 0n, exponent: 0, precision: 53 },
      im: { mantissa: 0n, exponent: 0, precision: 53 },
    };
    const v = bigcomplexToValue(a);
    expect(v.tag).toBe(BIGCOMPLEX_TAG);
    const b = valueToBigComplex(v);
    expect(b).toEqual(a);
  });

  test("non-trivial round-trip", () => {
    const a = cfromStrings("1.5", "-2.7", 100);
    const v = bigcomplexToValue(a);
    const b = valueToBigComplex(v);
    expect(b.re.mantissa).toBe(a.re.mantissa);
    expect(b.re.exponent).toBe(a.re.exponent);
    expect(b.re.precision).toBe(a.re.precision);
    expect(b.im.mantissa).toBe(a.im.mantissa);
    expect(b.im.exponent).toBe(a.im.exponent);
    expect(b.im.precision).toBe(a.im.precision);
  });

  test("conforms to bigcomplexSchema", () => {
    const a = cfromStrings("0.5", "0.5", 53);
    const v = bigcomplexToValue(a);
    expect(conforms(v, bigcomplexSchema)).toBe(true);
  });
});
