import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseSdpaSparse,
  convertSdpaToSdp,
  solveSdpAho,
  formatIterHeader,
  formatIterLine,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/sdp.dat-s", import.meta.url));

describe("SDP smoke — AHO direction (reference impl, A/B vs HKM)", () => {
  test("sdp.dat-s solves to objective near 30", () => {
    const text = readFileSync(FIXTURE, "utf-8");
    const sdpa = parseSdpaSparse(text);
    const prob = convertSdpaToSdp(sdpa, /*maximize*/ true);
    const log: string[] = [formatIterHeader()];
    const res = solveSdpAho(prob, { log: (line) => log.push(formatIterLine(line)) });
    console.log("\n[AHO] " + log.join("\n[AHO] "));
    console.log(`\nstatus=${res.status} primal=${res.primalObj} dual=${res.dualObj} iter=${res.iter}`);
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 30)).toBeLessThan(1e-4);
  });
});
