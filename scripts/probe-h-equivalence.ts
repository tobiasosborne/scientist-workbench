/**
 * Probe driver for beads issue scientist-workbench-4xk.
 *
 * Question: under sturm-execute's textbook RY convention
 *   RY(θ) = [[cos(θ/2), -sin(θ/2)], [sin(θ/2), cos(θ/2)]]
 * does the Sturm-TS spec v3 §8.1 library — which defines
 *   H(q) ::= ry(π/2); ry(π)
 * actually realise the Hadamard gate, or does it realise Ry(3π/2) (which is
 * not equal to H by any global phase)?
 *
 * Reading the math: Ry(π) = [[0,-1],[1,0]] = -iY. The library's two-step H
 * composes (state-application order = source order) to Ry(π)·Ry(π/2) = Ry(3π/2).
 * H has det -1, Ry(3π/2) has det +1; no phase factor relates them. Hadamard's
 * Bloch axis is (X+Z)/√2, which has no Y-component, so H cannot be expressed
 * in the Ry-only family.
 *
 * Two probes that distinguish real-H from Ry(3π/2) on standard-basis input:
 *
 *   P1 — H·H = I. Apply H twice. Real H gives P(r=0)=1; Ry(3π/2)² = Ry(3π) = iY
 *        gives |0⟩ → -|1⟩, so P(r=1)=1.
 *
 *   P2 — H·Z·H = X. Real H gives P(r=1)=1 on input |0⟩; under Ry(3π/2) the
 *        composition is -iZ, so P(r=0)=1 on |0⟩.
 *
 * The probes are run by piping canonical IR through tools/sturm-execute.
 */

import { spawnBun } from "@workbench/contract";
import { canonicalize } from "@workbench/protocol";
import { expr, int, list, rat, str, sym } from "@workbench/protocol";
import { resolve } from "node:path";

const piOver2 = expr("/", [sym("π"), int(2n)]);
const pi = sym("π");

// Build "ry(wire, δ, controls=[])" op
const ry = (wire: bigint, delta: ReturnType<typeof expr> | ReturnType<typeof sym>) =>
  expr("ry", [int(wire), delta, list([])]);

// Build "rz(wire, δ, controls=[])" op
const rz = (wire: bigint, delta: ReturnType<typeof expr> | ReturnType<typeof sym>) =>
  expr("rz", [int(wire), delta, list([])]);

const prepare0 = (wire: bigint) =>
  expr("prepare", [rat(0n, 1n), int(wire)]);

const observe = (wire: bigint, ref: string) =>
  expr("observe", [int(wire), str(ref)]);

const channel = (body: ReturnType<typeof expr>[]) =>
  expr("channel", [list([]), list([]), list(body)]);

// One application of the spec library's H(q): ry(π/2); ry(π)
const specH = (wire: bigint) => [ry(wire, piOver2), ry(wire, pi)];

// Probe 1: prepare(0); H; H; observe
const probe1 = channel([
  prepare0(0n),
  ...specH(0n),
  ...specH(0n),
  observe(0n, "r"),
]);

// Probe 2: prepare(0); H; rz(π); H; observe
const probe2 = channel([
  prepare0(0n),
  ...specH(0n),
  rz(0n, pi),
  ...specH(0n),
  observe(0n, "r"),
]);

const toolPath = resolve(import.meta.dir, "..", "tools", "sturm-execute", "tool.ts");

async function runProbe(name: string, body: ReturnType<typeof expr>) {
  const input = canonicalize(body);
  const result = await spawnBun([toolPath], input);
  console.log(`\n=== ${name} ===`);
  if (result.code !== 0) {
    console.log("EXIT", result.code);
    console.log("STDERR:", result.stderr);
    return;
  }
  const parsed = JSON.parse(result.stdout);
  const outcomes = parsed.fields.outcomes.items;
  for (const outcome of outcomes) {
    const probHex = outcome.fields.prob.bits;
    const buf = Buffer.from(probHex, "hex");
    const prob = buf.readDoubleBE(0);
    const resolutions = outcome.fields.classical_resolutions.items.map((r: any) =>
      `${r.fields.ref.value}=${r.fields.value.value}`
    ).join(", ");
    console.log(`  ${resolutions || "(no resolutions)"}: prob = ${prob}`);
  }
}

console.log("Probing spec v3 §8.1 H(q) := ry(π/2); ry(π) against sturm-execute.");
console.log("");
console.log("Real-H prediction:        Probe 1 → r=0 with prob 1; Probe 2 → r=1 with prob 1.");
console.log("Ry(3π/2) prediction:      Probe 1 → r=1 with prob 1; Probe 2 → r=0 with prob 1.");

await runProbe("Probe 1: prepare(0); H; H; observe", probe1);
await runProbe("Probe 2: prepare(0); H; rz(π); H; observe", probe2);
