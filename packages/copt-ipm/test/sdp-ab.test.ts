// A/B test: NT and AHO directions converge on the smoke SDP.
// NT (Nesterov-Todd) is the primary export and matches COPT's default barrier
// path. AHO is kept as an alternative direction for sanity checks.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseSdpaSparse,
  convertSdpaToSdp,
  solveSdp,
  solveSdpAho,
  solveSdpNt,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/sdp.dat-s", import.meta.url));
const text = readFileSync(FIXTURE, "utf-8");
const prob = convertSdpaToSdp(parseSdpaSparse(text), /*maximize*/ true);

describe("SDP A/B: NT (= COPT default) and AHO both converge", () => {
  test("NT converges to 30 in ≤ 12 iters (COPT does 7)", () => {
    const res = solveSdpNt(prob);
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 30)).toBeLessThan(1e-4);
    expect(res.iter).toBeLessThanOrEqual(12);
  });

  test("AHO converges to 30 in ≤ 20 iters", () => {
    const res = solveSdpAho(prob);
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 30)).toBeLessThan(1e-4);
    expect(res.iter).toBeLessThanOrEqual(20);
  });

  test("Primary export solveSdp is the NT solver", () => {
    const a = solveSdp(prob);
    const b = solveSdpNt(prob);
    expect(a.status).toBe(b.status);
    expect(Math.abs(a.primalObj - b.primalObj)).toBeLessThan(1e-10);
  });

  test("NT and AHO agree on objective to 1e-5", () => {
    const a = solveSdpNt(prob);
    const b = solveSdpAho(prob);
    expect(a.status).toBe("optimal");
    expect(b.status).toBe("optimal");
    expect(Math.abs(a.primalObj - b.primalObj)).toBeLessThan(1e-5);
  });
});
