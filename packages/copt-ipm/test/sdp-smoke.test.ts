import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseSdpaSparse,
  convertSdpaToSdp,
  solveSdpAho as solveSdp,
  formatIterHeader,
  formatIterLine,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/sdp.dat-s", import.meta.url));

describe("SDP smoke (COPT bundled sdp.dat-s)", () => {
  test("parser shape", () => {
    const text = readFileSync(FIXTURE, "utf-8");
    const p = parseSdpaSparse(text);
    expect(p.m).toBe(2);
    expect(p.nblocks).toBe(2);
    expect(p.blockSizes).toEqual([2, 2]);
    expect(p.b).toEqual([10, 20]);
    expect(p.entries.length).toBeGreaterThan(0);
  });

  test("solves to objective near 30 (COPT-confirmed optimum)", () => {
    const text = readFileSync(FIXTURE, "utf-8");
    const sdpa = parseSdpaSparse(text);
    const prob = convertSdpaToSdp(sdpa, /*maximize*/ true);
    const log: string[] = [formatIterHeader()];
    const res = solveSdp(prob, { log: (line) => log.push(formatIterLine(line)) });
    console.log("\n" + log.join("\n"));
    console.log(`\nstatus=${res.status} primal=${res.primalObj} dual=${res.dualObj} iter=${res.iter}`);
    expect(res.status).toBe("optimal");
    // SDPA convention max <C, X>, optimum value 29.999... per COPT log.
    // We report in user convention, so positive for the maximize problem.
    expect(Math.abs(res.primalObj - 30)).toBeLessThan(1e-4);
  });
});
