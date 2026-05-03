// =============================================================================
// sturm-execute — analytic distribution computation for Sturm channels
// =============================================================================
//
// Intent
// ------
// `sturm-execute` is the workbench's pure-analytic quantum executor: it takes
// a Sturm channel IR (ADR-0006) and returns a distribution over the channel's
// classical-ref resolutions. No randomness is admitted here — that is
// `sturm-sample`'s job (Phase 2; ADR-0007 frames the split as Born's rule
// made structural). Given a channel, `sturm-execute` always returns the
// *same* distribution; reproducibility is bit-equal across runs.
//
// The high-level pipeline is the textbook one:
//
//   1. Walk the channel's body in document order, evolving a state-vector
//      simulator. Quantum wires are allocated as `prepare` ops fire and
//      removed (collapsed) when `observe` ops fire.
//   2. On every `observe`, the current branch is split into two child
//      branches — one for each measurement outcome — with their amplitudes
//      projected onto the corresponding subspace. We do NOT renormalise: a
//      branch's probability is just the sum of |amp|² over its remaining
//      basis states. This is mathematically equivalent to the "renormalise
//      and track a separate weight" formulation but avoids the irrational-
//      square-root that renormalisation would introduce.
//   3. On `cases`, branches are partitioned by the classical-ref's resolved
//      value, the matching arm is run on each partition, and the partitions
//      merge back into one branch list.
//   4. After the body finishes, branches are aggregated by their classical-
//      resolution dict and emitted as outcomes. The emission ordering is
//      canonical: classical_refs in document order; outcomes sorted
//      lexicographically by their (ref-value) tuple in that order.
//
// What's in scope for v0.1
// ------------------------
// Only `prepare`, `ry`, `rz`, `observe`, and `cases` ops are simulated.
// `oracle` and `discard` ops produce a boundary-failure
// `tagged "sturm-execute/out-of-scope"` per ADR-0003 — honest scope beats
// silently-wrong answers. Adding them is a follow-up: oracle support needs
// the embedded-circuit's permutation lifted into the simulator, and discard
// requires density-matrix simulation (since partial trace on an entangled
// state produces a mixed state that pure-state simulation can't represent).
//
// All numerics are float64. The acceptance criterion mentions "exact
// distributions over Q[√2] or Q(ζ_8)" — that's the natural next rung but
// it's deferred to scientist-workbench-jfj. Briefly: while amplitudes for
// the Clifford-like fragment {prepare(0|1|1/2), ry(kπ/2), rz(kπ/2)} stay
// in Q[√2, i], the *individual* basis-state probabilities |amp|² generally
// land in Q[√2] (with a √2-component that doesn't cancel until you sum
// over all basis states), and the distribution schema's
// `prob: rational | float64` cannot represent those without further design.
// So v0.1 stays float64-only and labels its output `precision: "float64"`.
//
// Cap: 12 quantum wires (4096-amplitude state vector). Past the cap, return
// a boundary-tag with a `qubit-cap-exceeded` reason code. This matches the
// state-vector size cap discussed in ADR-0007 and is wired in
// `QUBIT_CAP` below.
//
// Input shape
// -----------
// The input is `channelSchema` from `@workbench/sturm-ir`: an
// `expression "channel"` with input-signature, output-signature, and body.
// The runner validates this shape against the schema before `fn` runs.
// The body is then decoded to typed Op nodes via `decodeChannel` for
// pattern-matching convenience.
//
// Output shape
// ------------
// On success: `record { classical_refs, outcomes, precision }` where
//   - `classical_refs` is the list of classical_ref names in the order
//     their `observe` ops appear in the body.
//   - `outcomes` is a list of `record { classical_resolutions, prob }`,
//     - `classical_resolutions` is a list of `record { ref: string,
//       value: integer }` (0 or 1). We use a list-of-pairs rather than
//       a record-keyed-by-ref because the schema language doesn't admit
//       open records (ADR-0004 §"Three deliberate omissions"); see the
//       worklog shard accompanying this tool for why this departs from
//       ADR-0007's `extras: "allow"` sketch.
//     - `prob` is `float64` in v0.1 (rational reserved for the future
//       exact path).
//   - `precision` is the literal string `"float64"` in v0.1; the literal
//     `"exact"` is reserved for the deferred exact path.
//
// On out-of-scope inputs: `tagged "sturm-execute/out-of-scope"` whose
// payload is a string explaining why (per ADR-0003 boundary-failure
// pattern). Concrete reasons in v0.1:
//   - "oracle op not supported in v0.1"
//   - "discard op not supported in v0.1"
//   - "qubit count exceeds cap of 12"
//   - "non-numeric angle in <op>"
//
// Algorithm details
// -----------------
// State-vector layout
//   For a channel with `n` live quantum wires, each branch carries a flat
//   complex array `amps: FloatComplex[]` of length 2^n. The wire ordering
//   is tracked separately as `qubitOrder: bigint[]`, where
//   `qubitOrder[k]` is the wire ID at qubit-index `k`. Qubit-index `k`
//   corresponds to bit `k` (0-indexed, LSB) in basis-state indices.
//
//   Concretely for `qubitOrder = [w_a, w_b]`:
//     index 0 = |w_a=0, w_b=0⟩
//     index 1 = |w_a=1, w_b=0⟩
//     index 2 = |w_a=0, w_b=1⟩
//     index 3 = |w_a=1, w_b=1⟩
//
// Single-qubit gate application
//   For a 2x2 unitary `G = [[g00,g01],[g10,g11]]` on qubit-index q, the
//   simulator walks every pair `(i, j)` where `j = i | (1 << q)` and
//   `i & (1 << q) === 0`. For each such pair the new amplitudes are
//     amps[i] := g00 · old[i] + g01 · old[j]
//     amps[j] := g10 · old[i] + g11 · old[j]
//
//   Controlled gates: only act on the pair when *every* control bit in `i`
//   is 1. (i and j share all bits except bit q, so checking i suffices.)
//
// Observe
//   For wire w mapped to qubit-index q, partition basis-state indices by
//   bit-q value. Two child branches result:
//     - r=0: amplitudes from indices with bit q = 0, with that bit
//       removed from each index (folding the array down to length 2^(n-1)).
//     - r=1: similar for bit q = 1.
//   Branches whose probability (Σ|amp|² over the new shorter array) is
//   exactly zero are dropped.
//
// References
// ----------
// - ADR-0006: Sturm IR-as-Value (the input shape).
// - ADR-0007: distribution-vs-sampling factoring (the output shape).
// - ADR-0003: tool output / error patterns (the out-of-scope shape).
// - Nielsen & Chuang, "Quantum Computation and Quantum Information",
//   Chapter 2 (state-vector formalism, Born's rule, projective
//   measurement).
// - Follow-up issue scientist-workbench-jfj — exact-symbolic path
//   over Q[√2, i] amplitudes (with Q[√2]-rational probabilities).

import {
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  rat,
  record,
  S,
  str,
  sym,
  tagged,
  type Float64Value,
  type Schema,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  channel,
  channelSchema,
  decodeChannel,
  encodeChannel,
  observeOp,
  prepareOp,
  ryOp,
  rzOp,
  type Channel,
  type Op,
} from "@workbench/sturm-ir";

const NAME = "sturm-execute";
const VERSION = "0.1.0";

// State-vector cap. Past this point we boundary-tag rather than allocate a
// 2^n array that would dominate memory. 12 qubits → 4096 amplitudes →
// ~64 KiB at 16 bytes per FloatComplex. Big enough to cover every example
// in the v0.1 acceptance set (Bell, GHZ-3, conditioned-rotation toy
// circuits) with room to spare; small enough to refuse 13-qubit-class
// circuits early.
const QUBIT_CAP = 12;

// Numerical-precision floor for branch probabilities. After every
// `observe`, a branch whose Σ|amp|² lies below this threshold is dropped
// as IEEE-754 noise. Without this, identities like cos(π/2) — which
// computes to ~6e-17 rather than 0 — produce phantom outcomes with
// probability ~1e-32 cluttering the distribution. The threshold is
// orders of magnitude above the noise floor (~1e-15) and orders of
// magnitude below any physically-meaningful probability the simulator
// would ever encounter (~1e-12). Documented in the tool's invariants and
// README so callers know what to expect; an exact-symbolic future
// (scientist-workbench-jfj) will not need this dead-zone.
const PROBABILITY_EPSILON = 1e-12;

// -----------------------------------------------------------------------------
// Float-complex arithmetic
// -----------------------------------------------------------------------------
//
// We use a flat `{re, im}` record rather than a Float64Array-of-pairs. The
// per-amplitude allocation overhead is real but the simulator runs on
// state vectors of size ≤ 2^12 = 4096; the modest constant-factor cost is
// dwarfed by the gate-application work. Keeping amplitudes as JS numbers
// also lets us use IEEE-754 deterministically for goldens.

interface FloatComplex {
  readonly re: number;
  readonly im: number;
}

const C_ZERO: FloatComplex = { re: 0, im: 0 };
const C_ONE: FloatComplex = { re: 1, im: 0 };

function cAdd(a: FloatComplex, b: FloatComplex): FloatComplex {
  return { re: a.re + b.re, im: a.im + b.im };
}

function cScale(a: FloatComplex, k: number): FloatComplex {
  return { re: a.re * k, im: a.im * k };
}

function cMul(a: FloatComplex, b: FloatComplex): FloatComplex {
  return {
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
  };
}

function cMag2(a: FloatComplex): number {
  return a.re * a.re + a.im * a.im;
}

// -----------------------------------------------------------------------------
// Numeric evaluator for symbolic angles and probabilities
// -----------------------------------------------------------------------------
//
// IR `prepare` probabilities and `ry`/`rz` angles flow through as Values —
// rationals, integers, float64s, or symbolic expressions. For numeric
// simulation we need a `number`. `evalFloat64` walks a value tree and
// returns the result if every leaf is recognisable, `null` otherwise (free
// symbol that isn't `π`, unknown head, etc.). The `null` case triggers a
// boundary-tag: the channel has an unresolved parameter the executor
// cannot pin down without an externally-supplied value.
//
// `π` is the only symbol with a numeric meaning; every other symbol is
// treated as free and produces `null`.

function evalFloat64(v: Value): number | null {
  switch (v.kind) {
    case "integer":
      return Number(BigInt(v.value));
    case "rational": {
      // BigInt-then-Number to honour Rat invariants (lowest terms,
      // positive denominator). The double conversion is acceptable
      // because v0.1 angles are tiny rationals; precision loss only
      // bites near 2^53.
      const n = Number(BigInt(v.num));
      const d = Number(BigInt(v.den));
      return n / d;
    }
    case "float64":
      return float64ToNumber(v);
    case "boolean":
    case "string":
      return null;
    case "symbol":
      // π is the one privileged symbol with numeric meaning.
      return v.name === "π" ? Math.PI : null;
    case "list":
    case "record":
    case "tagged":
      return null;
    case "expression":
      return evalExpressionFloat64(v.head, v.args);
  }
}

function evalExpressionFloat64(
  head: string,
  args: readonly Value[]
): number | null {
  if (head === "+") {
    let total = 0;
    for (const a of args) {
      const x = evalFloat64(a);
      if (x === null) return null;
      total += x;
    }
    return total;
  }
  if (head === "*") {
    let total = 1;
    for (const a of args) {
      const x = evalFloat64(a);
      if (x === null) return null;
      total *= x;
    }
    return total;
  }
  if (head === "-") {
    if (args.length === 1) {
      const a = evalFloat64(args[0]!);
      return a === null ? null : -a;
    }
    if (args.length === 2) {
      const a = evalFloat64(args[0]!);
      const b = evalFloat64(args[1]!);
      return a === null || b === null ? null : a - b;
    }
    return null;
  }
  if (head === "/" && args.length === 2) {
    const a = evalFloat64(args[0]!);
    const b = evalFloat64(args[1]!);
    if (a === null || b === null) return null;
    if (b === 0) return null;
    return a / b;
  }
  if (head === "^" && args.length === 2) {
    const a = evalFloat64(args[0]!);
    const b = evalFloat64(args[1]!);
    return a === null || b === null ? null : Math.pow(a, b);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Branch — one strand of the simulation
// -----------------------------------------------------------------------------
//
// A branch is a (sub-normalised) state vector together with a wire-to-qubit
// mapping and the classical-ref resolutions accumulated so far on this path.
// "Sub-normalised" because we do not renormalise after `observe` — the
// branch's probability is the sum of |amp|² over the remaining basis
// states. (See the header for why this is cleaner than carrying a separate
// renormalisation factor.)
//
// `qubitOrder[k]` is the wire ID at qubit-index k. Qubit-index k is bit k
// (LSB) of basis-state indices into `amps`.

interface Branch {
  amps: FloatComplex[];
  qubitOrder: bigint[];
  classicalResolutions: Map<string, 0 | 1>;
}

function initialBranch(): Branch {
  return {
    amps: [C_ONE],
    qubitOrder: [],
    classicalResolutions: new Map(),
  };
}

function branchProb(b: Branch): number {
  let total = 0;
  for (const amp of b.amps) total += cMag2(amp);
  return total;
}

// -----------------------------------------------------------------------------
// Gate application
// -----------------------------------------------------------------------------
//
// `applyGate` applies a 2x2 unitary `G = [[g00,g01],[g10,g11]]` to qubit-
// index `q` of the branch's state vector, optionally controlled by a list
// of qubit-indices (the gate fires only when every control bit is 1).
//
// The implementation walks every pair `(i, j)` with `j = i | (1<<q)` and
// `i & (1<<q) === 0`. For each pair, the controlled-condition is checked
// against `i` (since `i` and `j` share every bit except `q`, the controls
// are identical between them). The new amplitudes are written after both
// have been read; we use temporaries to avoid the read-after-write hazard.

function applyGate(
  branch: Branch,
  qubitIdx: number,
  controls: readonly number[],
  g00: FloatComplex,
  g01: FloatComplex,
  g10: FloatComplex,
  g11: FloatComplex
): void {
  const stride = 1 << qubitIdx;
  const n = branch.amps.length;
  // Pre-compute control-mask: a 1 bit at every control qubit-index. For
  // the gate to fire on a pair, `i & controlMask === controlMask`.
  let controlMask = 0;
  for (const c of controls) controlMask |= 1 << c;

  for (let i = 0; i < n; i++) {
    if ((i & stride) !== 0) continue; // only iterate pairs once
    if ((i & controlMask) !== controlMask) continue; // controls not satisfied
    const j = i | stride;
    const a0 = branch.amps[i]!;
    const a1 = branch.amps[j]!;
    branch.amps[i] = cAdd(cMul(g00, a0), cMul(g01, a1));
    branch.amps[j] = cAdd(cMul(g10, a0), cMul(g11, a1));
  }
}

// Build the RY(θ) matrix:
//   RY(θ) = [[cos(θ/2), -sin(θ/2)],
//            [sin(θ/2),  cos(θ/2)]]
// All entries are real, so we wrap them in FloatComplex with im = 0.

interface Gate2x2 {
  g00: FloatComplex;
  g01: FloatComplex;
  g10: FloatComplex;
  g11: FloatComplex;
}

function ryMatrix(theta: number): Gate2x2 {
  const half = theta / 2;
  const c = Math.cos(half);
  const s = Math.sin(half);
  return {
    g00: { re: c, im: 0 },
    g01: { re: -s, im: 0 },
    g10: { re: s, im: 0 },
    g11: { re: c, im: 0 },
  };
}

// Build the RZ(θ) matrix:
//   RZ(θ) = diag(e^{-iθ/2}, e^{iθ/2})
// Both diagonal entries are unit-modulus complex numbers; off-diagonals
// are zero.

function rzMatrix(theta: number): Gate2x2 {
  const half = theta / 2;
  const c = Math.cos(half);
  const s = Math.sin(half);
  return {
    g00: { re: c, im: -s },
    g01: C_ZERO,
    g10: C_ZERO,
    g11: { re: c, im: s },
  };
}

// -----------------------------------------------------------------------------
// Prepare — allocate and tensor in a new qubit
// -----------------------------------------------------------------------------
//
// `prepare(p, w)` introduces wire w as a fresh qubit at the highest qubit
// index (most significant bit of new state-vector indices). The new
// qubit's state is `√(1−p)|0⟩ + √p|1⟩`. We tensor into the existing state:
//   new_amps[i + 0·oldLen] = √(1−p) · amps[i]
//   new_amps[i + 1·oldLen] = √p     · amps[i]
//
// The qubit-cap check is the caller's job (`applyOpToBranch` checks
// before delegating) — keeping it out of `prepareWire` lets the seeding
// pass below reuse this routine without re-checking.

function prepareWire(branch: Branch, p: number, wireId: bigint): void {
  const oldLen = branch.amps.length;
  const sqrt0 = Math.sqrt(1 - p);
  const sqrt1 = Math.sqrt(p);
  const newAmps: FloatComplex[] = new Array(oldLen * 2);
  for (let i = 0; i < oldLen; i++) {
    newAmps[i] = cScale(branch.amps[i]!, sqrt0);
    newAmps[i + oldLen] = cScale(branch.amps[i]!, sqrt1);
  }
  branch.amps = newAmps;
  branch.qubitOrder.push(wireId);
}

// -----------------------------------------------------------------------------
// Observe — split a branch into two outcome-conditioned branches
// -----------------------------------------------------------------------------
//
// `observe(w, ref)` projects wire w onto each of {|0⟩, |1⟩}, producing two
// child branches (one per outcome). The qubit at qubit-index q is removed
// from the state vector — for outcome b, the new amps are read from old
// indices whose bit-q is b, with bit q dropped from each index. We do not
// renormalise; the child branch's probability is the sum of |new_amp|².
//
// Branches with all-zero new amplitudes (the outcome was unreachable) are
// returned as null and skipped by the caller. Both being zero is
// impossible if the parent branch had nonzero probability (the two
// outcomes partition the parent's amplitude mass).

function projectWire(
  parent: Branch,
  qubitIdx: number,
  bit: 0 | 1,
  ref: string
): Branch {
  const stride = 1 << qubitIdx;
  const oldLen = parent.amps.length;
  const newLen = oldLen / 2;
  const newAmps: FloatComplex[] = new Array(newLen);
  // For every old index `i` whose bit-q matches `bit`, write to the new
  // index obtained by *removing* bit q. The removal is: lower bits stay,
  // higher bits shift down by one.
  for (let i = 0; i < oldLen; i++) {
    const thisBit = (i & stride) >>> qubitIdx;
    if (thisBit !== bit) continue;
    const lower = i & (stride - 1);
    const upper = (i >>> (qubitIdx + 1)) << qubitIdx;
    const newIdx = lower | upper;
    newAmps[newIdx] = parent.amps[i]!;
  }
  const newQubitOrder = parent.qubitOrder.slice();
  newQubitOrder.splice(qubitIdx, 1);
  const newClassicalResolutions = new Map(parent.classicalResolutions);
  newClassicalResolutions.set(ref, bit);
  return {
    amps: newAmps,
    qubitOrder: newQubitOrder,
    classicalResolutions: newClassicalResolutions,
  };
}

// -----------------------------------------------------------------------------
// Op execution
// -----------------------------------------------------------------------------
//
// `runBody` is the simulator's main loop: it threads a list of branches
// through a sequence of ops. The scope is intentionally narrow — we
// emit `ExecutionError` (a local class) on out-of-scope ops and on any
// other condition the caller should turn into a boundary-tag.
//
// The error-as-flow approach (rather than returning a tagged Value
// directly) keeps the loop's happy path readable; the caller catches the
// `ExecutionError` once at the boundary.

class ExecutionError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

function qubitIndexOf(branch: Branch, wireId: bigint): number {
  const idx = branch.qubitOrder.indexOf(wireId);
  if (idx < 0) {
    throw new ExecutionError(
      `wire ${wireId} not in scope (well-formedness bug)`
    );
  }
  return idx;
}

function controlsAsQubitIndices(
  branch: Branch,
  controls: readonly bigint[]
): number[] {
  return controls.map((w) => qubitIndexOf(branch, w));
}

function applyOpToBranch(branch: Branch, op: Op): void {
  switch (op.head) {
    case "prepare": {
      const p = evalFloat64(op.p);
      if (p === null) {
        throw new ExecutionError(
          `non-numeric probability in prepare(wire ${op.wireId})`
        );
      }
      if (p < 0 || p > 1) {
        throw new ExecutionError(
          `prepare probability out of [0,1]: ${p} on wire ${op.wireId}`
        );
      }
      if (branch.qubitOrder.length >= QUBIT_CAP) {
        throw new ExecutionError(
          `qubit count exceeds cap of ${QUBIT_CAP}`
        );
      }
      prepareWire(branch, p, op.wireId);
      return;
    }
    case "ry":
    case "rz": {
      const theta = evalFloat64(op.delta);
      if (theta === null) {
        throw new ExecutionError(
          `non-numeric angle in ${op.head}(wire ${op.wireId})`
        );
      }
      const q = qubitIndexOf(branch, op.wireId);
      const ctrls = controlsAsQubitIndices(branch, op.controls);
      const m = op.head === "ry" ? ryMatrix(theta) : rzMatrix(theta);
      applyGate(branch, q, ctrls, m.g00, m.g01, m.g10, m.g11);
      return;
    }
    case "observe":
      // Observe is handled at the branch-list level (it produces two new
      // branches per input branch). Falling through here is a structural
      // bug — the caller should have peeled this op off.
      throw new ExecutionError(
        "internal: applyOpToBranch invoked on observe (caller bug)"
      );
    case "cases":
      throw new ExecutionError(
        "internal: applyOpToBranch invoked on cases (caller bug)"
      );
    case "oracle":
      throw new ExecutionError("oracle op not supported in v0.1");
    case "discard":
      throw new ExecutionError("discard op not supported in v0.1");
  }
}

function runBody(branches: Branch[], body: readonly Op[]): Branch[] {
  let live = branches;
  for (const op of body) {
    if (op.head === "observe") {
      const next: Branch[] = [];
      for (const b of live) {
        const q = qubitIndexOf(b, op.wireId);
        const b0 = projectWire(b, q, 0, op.classicalRef);
        const b1 = projectWire(b, q, 1, op.classicalRef);
        if (branchProb(b0) > PROBABILITY_EPSILON) next.push(b0);
        if (branchProb(b1) > PROBABILITY_EPSILON) next.push(b1);
      }
      live = next;
      continue;
    }
    if (op.head === "cases") {
      const ref = op.classicalRef;
      const trueBranches: Branch[] = [];
      const falseBranches: Branch[] = [];
      for (const b of live) {
        const v = b.classicalResolutions.get(ref);
        if (v === undefined) {
          throw new ExecutionError(
            `cases references unbound classical_ref "${ref}" (well-formedness bug)`
          );
        }
        (v === 1 ? trueBranches : falseBranches).push(b);
      }
      const newTrue = runBody(trueBranches, op.trueArm);
      const newFalse = runBody(falseBranches, op.falseArm);
      live = [...newTrue, ...newFalse];
      continue;
    }
    // Single-branch ops: prepare, ry, rz, oracle, discard.
    for (const b of live) {
      applyOpToBranch(b, op);
    }
  }
  return live;
}

// -----------------------------------------------------------------------------
// Distribution aggregation
// -----------------------------------------------------------------------------
//
// After `runBody` finishes, `branches` is a flat list of Branch objects.
// Two branches that share the same `classicalResolutions` represent the
// same observable outcome — the simulation may have split-and-rejoined
// them through `cases`, or two `observe` paths may have produced
// identical resolutions. Aggregate by summing each branch's probability
// (Σ|amp|²) per classical-resolution dict.
//
// For canonical output ordering: classical_refs are listed in the order
// their `observe` ops appear in the channel body (so the agent can read
// the column meanings off the body); outcomes are sorted lexicographically
// by their value tuple in that order, ascending.

interface OutcomeAccum {
  resolutions: Map<string, 0 | 1>;
  prob: number;
}

function collectClassicalRefsInOrder(body: readonly Op[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  function visit(ops: readonly Op[]): void {
    for (const op of ops) {
      if (op.head === "observe" && !seen.has(op.classicalRef)) {
        seen.add(op.classicalRef);
        out.push(op.classicalRef);
      } else if (op.head === "cases") {
        visit(op.trueArm);
        visit(op.falseArm);
      }
    }
  }
  visit(body);
  return out;
}

function resolutionsKey(
  refs: readonly string[],
  res: ReadonlyMap<string, 0 | 1>
): string {
  // Stable canonical key for grouping. The refs are already in the
  // canonical (declaration-order) sequence, so we just concatenate the
  // bit-string. A ref not present in this branch's resolutions is rare
  // (would happen only if a `cases` was unreachable on one branch — the
  // wellformed check rules this out for v0.1 since arms can't observe).
  let s = "";
  for (const r of refs) {
    const v = res.get(r);
    s += v === undefined ? "?" : String(v);
  }
  return s;
}

function aggregateBranches(
  branches: readonly Branch[],
  refs: readonly string[]
): OutcomeAccum[] {
  const groups = new Map<string, OutcomeAccum>();
  for (const b of branches) {
    const k = resolutionsKey(refs, b.classicalResolutions);
    const p = branchProb(b);
    if (p < PROBABILITY_EPSILON) continue;
    const existing = groups.get(k);
    if (existing === undefined) {
      groups.set(k, {
        resolutions: new Map(b.classicalResolutions),
        prob: p,
      });
    } else {
      existing.prob += p;
    }
  }
  // A second epsilon pass: two cancelling sub-threshold branches could in
  // principle accumulate above threshold; the inverse is also possible
  // (a small handful of small branches summing to negligible). Filter
  // post-aggregation so the final distribution is clean.
  for (const k of [...groups.keys()]) {
    if (groups.get(k)!.prob < PROBABILITY_EPSILON) groups.delete(k);
  }
  // Stable sort by resolutions tuple ascending. With 2^|refs| possible
  // bit-strings this is bounded, and sort-by-key on the canonical key
  // string is good enough for the canonical bytes the tool emits.
  const out = [...groups.values()];
  out.sort((a, b) =>
    resolutionsKey(refs, a.resolutions).localeCompare(
      resolutionsKey(refs, b.resolutions)
    )
  );
  return out;
}

// -----------------------------------------------------------------------------
// Output encoding
// -----------------------------------------------------------------------------
//
// The output schema requires a `prob` of `rational | float64`. v0.1 always
// emits float64 (the exact path is deferred to scientist-workbench-jfj).
// Probabilities go through `float64FromNumber` to get the canonical
// 16-hex-char `bits` form; that path round-trips bit-equally through the
// canonicaliser, so goldens are stable across runs.

function encodeProb(p: number): Float64Value {
  return float64FromNumber(p);
}

function encodeOutcome(outcome: OutcomeAccum): Value {
  const resolutions: Value[] = [];
  // Sort the resolutions list by ref name for canonical ordering inside
  // the per-outcome list. The classical_refs field at the top level
  // carries declaration order; the per-outcome list is a set-of-pairs
  // and gains nothing from preserving declaration order locally.
  const refsSorted = [...outcome.resolutions.keys()].sort();
  for (const r of refsSorted) {
    resolutions.push(
      record({
        ref: str(r),
        value: int(BigInt(outcome.resolutions.get(r)!)),
      })
    );
  }
  return record({
    classical_resolutions: list(resolutions),
    prob: encodeProb(outcome.prob),
  });
}

function encodeDistribution(
  outcomes: readonly OutcomeAccum[],
  refs: readonly string[]
): Value {
  return record({
    classical_refs: list(refs.map((r) => str(r))),
    outcomes: list(outcomes.map(encodeOutcome)),
    precision: str("float64"),
  });
}

// -----------------------------------------------------------------------------
// Top-level executor
// -----------------------------------------------------------------------------
//
// `executeChannel` is the all-in-one entry point: walk the body, aggregate
// branches, encode the distribution. All boundary failures are caught
// here and turned into a `tagged "sturm-execute/out-of-scope"` Value with
// the reason as a string payload (per ADR-0003).
//
// For the empty channel (no body, no observes) the result is a single
// outcome with empty classical_resolutions and prob 1.0. That's the
// canonical "trivial" case; an agent reading the output sees one row
// indicating "this channel deterministically lands in its single state."

function executeChannel(c: Channel): Value {
  try {
    // Pre-flight: validate the qubit cap by seeding with input wires.
    const inputQuantum = c.inputs.filter((w) => w.kind === "quantum");
    if (inputQuantum.length > QUBIT_CAP) {
      throw new ExecutionError(
        `qubit count exceeds cap of ${QUBIT_CAP}`
      );
    }
    // Seed branches with the input signature: any quantum input wires are
    // assumed to be in the |0…0⟩ state. (A more general convention would
    // accept an externally-supplied initial state; v0.1 starts in |0…0⟩
    // for simplicity. Channels that need a non-zero initial state should
    // emit explicit `prepare` ops.)
    const initial: Branch = initialBranch();
    for (const w of inputQuantum) {
      prepareWire(initial, 0, w.id); // prepare in |0⟩
    }
    const finalBranches = runBody([initial], c.body);
    const refs = collectClassicalRefsInOrder(c.body);
    const outcomes = aggregateBranches(finalBranches, refs);
    return encodeDistribution(outcomes, refs);
  } catch (e) {
    if (e instanceof ExecutionError) {
      return tagged("sturm-execute/out-of-scope", str(e.reason));
    }
    throw e;
  }
}

// -----------------------------------------------------------------------------
// Schema declarations
// -----------------------------------------------------------------------------
//
// Output schema is a union of the in-scope distribution shape and the
// out-of-scope tagged form. The runner validates both alternatives via
// first-match-wins; the in-scope shape is listed first because it's the
// happy path.
//
// `extras: "allow"` doesn't exist in the v0.1 schema language (ADR-0004
// §"Three deliberate omissions"), so `classical_resolutions` is encoded
// as a list of `{ref, value}` pairs rather than a record-keyed-by-ref.
// This is a deliberate departure from ADR-0007's sketch; documented in
// the worklog shard accompanying this tool.

const inputSchema: Schema<Value> = channelSchema;

const classicalResolutionPairSchema = S.record({
  ref: S.kind("string"),
  value: S.kind("integer"),
});

const distributionOutcomeSchema = S.record({
  classical_resolutions: S.list(classicalResolutionPairSchema),
  prob: S.union([S.kind("rational"), S.kind("float64")]),
});

const inScopeOutputSchema = S.record({
  classical_refs: S.list(S.kind("string")),
  outcomes: S.list(distributionOutcomeSchema),
  precision: S.union([S.literal(str("exact")), S.literal(str("float64"))]),
});

const outputSchema: Schema<Value> = S.union([
  inScopeOutputSchema,
  S.tagged("sturm-execute/out-of-scope", S.kind("string")),
]);

// -----------------------------------------------------------------------------
// Example helpers
// -----------------------------------------------------------------------------
//
// `piOver(n)` builds the value-tree expression `π / n` for use in examples.
// `pair`, `outcomeF64`, `dist` keep the example block readable; without
// them the records would dwarf their descriptions.

function piOver(n: bigint): Value {
  return expr("/", [sym("π"), int(n)]);
}

function pair(ref: string, value: 0 | 1): Value {
  return record({ ref: str(ref), value: int(BigInt(value)) });
}

function outcomeF64(resolutions: readonly Value[], prob: number): Value {
  return record({
    classical_resolutions: list(resolutions),
    prob: float64FromNumber(prob),
  });
}

function dist(refs: readonly string[], outcomes: readonly Value[]): Value {
  return record({
    classical_refs: list(refs.map((r) => str(r))),
    outcomes: list(outcomes),
    precision: str("float64"),
  });
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "empty channel — single trivial outcome",
      input: encodeChannel(channel([], [], [])),
      output: dist([], [outcomeF64([], 1.0)]),
    },
    {
      description: "prepare(0) then observe — deterministic 0",
      input: encodeChannel(
        channel([], [], [prepareOp(rat(0n, 1n), 0n), observeOp(0n, "r")])
      ),
      output: dist(["r"], [outcomeF64([pair("r", 0)], 1.0)]),
    },
    {
      description: "prepare(1) then observe — deterministic 1",
      input: encodeChannel(
        channel([], [], [prepareOp(int(1n), 0n), observeOp(0n, "r")])
      ),
      output: dist(["r"], [outcomeF64([pair("r", 1)], 1.0)]),
    },
    {
      description: "prepare(1/2) — uniform distribution",
      input: encodeChannel(
        channel([], [], [prepareOp(rat(1n, 2n), 0n), observeOp(0n, "r")])
      ),
      output: dist(
        ["r"],
        [
          outcomeF64([pair("r", 0)], 0.49999999999999983),
          outcomeF64([pair("r", 1)], 0.5000000000000001),
        ]
      ),
    },
    {
      description: "NOT-equivalent: prepare(0); ry(π); observe — deterministic 1",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, sym("π"), []),
            observeOp(0n, "r"),
          ]
        )
      ),
      output: dist(
        ["r"],
        [
          outcomeF64(
            [pair("r", 1)],
            Math.sin(Math.PI / 2) ** 2 + Math.cos(Math.PI / 2) ** 2 * 0
          ),
        ]
      ),
    },
    {
      description: "H-equivalent: prepare(0); ry(π/2); observe — uniform",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, piOver(2n), []),
            observeOp(0n, "r"),
          ]
        )
      ),
      output: dist(
        ["r"],
        [
          outcomeF64([pair("r", 0)], Math.cos(Math.PI / 4) ** 2),
          outcomeF64([pair("r", 1)], Math.sin(Math.PI / 4) ** 2),
        ]
      ),
    },
    {
      description:
        "Bell pair: ry(π/2) on 0, controlled-ry(π) on 1, observe both",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            ryOp(0n, piOver(2n), []),
            ryOp(1n, sym("π"), [0n]),
            observeOp(0n, "r0"),
            observeOp(1n, "r1"),
          ]
        )
      ),
      output: dist(
        ["r0", "r1"],
        [
          outcomeF64(
            [pair("r0", 0), pair("r1", 0)],
            Math.cos(Math.PI / 4) ** 2
          ),
          outcomeF64(
            [pair("r0", 1), pair("r1", 1)],
            Math.sin(Math.PI / 4) ** 2 *
              (Math.sin(Math.PI / 2) ** 2 + Math.cos(Math.PI / 2) ** 2)
          ),
        ]
      ),
    },
    {
      description: "GHZ-3 channel — three-way correlation",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            prepareOp(rat(0n, 1n), 1n),
            prepareOp(rat(0n, 1n), 2n),
            ryOp(0n, piOver(2n), []),
            ryOp(1n, sym("π"), [0n]),
            ryOp(2n, sym("π"), [0n]),
            observeOp(0n, "r0"),
            observeOp(1n, "r1"),
            observeOp(2n, "r2"),
          ]
        )
      ),
      output: dist(
        ["r0", "r1", "r2"],
        [
          outcomeF64(
            [pair("r0", 0), pair("r1", 0), pair("r2", 0)],
            Math.cos(Math.PI / 4) ** 2
          ),
          outcomeF64(
            [pair("r0", 1), pair("r1", 1), pair("r2", 1)],
            Math.sin(Math.PI / 4) ** 2
          ),
        ]
      ),
    },
    {
      description: "parametrised rotation: prepare(0); ry(0.5); observe",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, rat(1n, 2n), []),
            observeOp(0n, "r"),
          ]
        )
      ),
      // RY(0.5)|0⟩ = cos(0.25)|0⟩ + sin(0.25)|1⟩.
      output: dist(
        ["r"],
        [
          outcomeF64([pair("r", 0)], Math.cos(0.25) ** 2),
          outcomeF64([pair("r", 1)], Math.sin(0.25) ** 2),
        ]
      ),
    },
    {
      description: "rz alone has no effect on standard-basis probabilities",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(1n, 2n), 0n),
            rzOp(0n, piOver(2n), []),
            observeOp(0n, "r"),
          ]
        )
      ),
      // |+⟩ → diag(e^{-iπ/4}, e^{iπ/4})|+⟩; phase only, no basis change.
      // So measurement gives 50/50 like prepare(1/2) alone.
      output: dist(
        ["r"],
        [
          outcomeF64([pair("r", 0)], 0.49999999999999983),
          outcomeF64([pair("r", 1)], 0.5000000000000001),
        ]
      ),
    },
    {
      description: "cases dispatch: feedback-conditioned rotation",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(1n, 2n), 0n), // first wire 50/50
            prepareOp(rat(0n, 1n), 1n), // second wire |0⟩
            observeOp(0n, "r0"),
            {
              head: "cases",
              classicalRef: "r0",
              trueArm: [ryOp(1n, sym("π"), [])], // if r0=1: NOT on wire 1
              falseArm: [], // if r0=0: do nothing
            },
            observeOp(1n, "r1"),
          ]
        )
      ),
      // r0=0 → wire 1 stays |0⟩ → r1=0; joint prob ≈ 0.5
      // r0=1 → wire 1 flipped to |1⟩ → r1=1; joint prob ≈ 0.5
      output: dist(
        ["r0", "r1"],
        [
          outcomeF64(
            [pair("r0", 0), pair("r1", 0)],
            0.49999999999999983
          ),
          outcomeF64(
            [pair("r0", 1), pair("r1", 1)],
            0.5000000000000001 * (Math.sin(Math.PI / 2) ** 2)
          ),
        ]
      ),
    },
    {
      description: "out-of-scope: oracle op",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            {
              head: "oracle",
              circuit: sym("placeholder"),
              inWires: [0n],
              outWires: [0n],
            },
          ]
        )
      ),
      output: tagged(
        "sturm-execute/out-of-scope",
        str("oracle op not supported in v0.1")
      ),
    },
    {
      description: "out-of-scope: discard op",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            { head: "discard", wireId: 0n },
          ]
        )
      ),
      output: tagged(
        "sturm-execute/out-of-scope",
        str("discard op not supported in v0.1")
      ),
    },
    {
      description: "out-of-scope: free symbolic angle",
      input: encodeChannel(
        channel(
          [],
          [],
          [
            prepareOp(rat(0n, 1n), 0n),
            ryOp(0n, sym("a"), []),
            observeOp(0n, "r"),
          ]
        )
      ),
      output: tagged(
        "sturm-execute/out-of-scope",
        str("non-numeric angle in ry(wire 0)")
      ),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → bit-identical output bytes",
      machine_checkable: true,
    },
    {
      name: "probabilities-sum-to-one",
      statement:
        "for every in-scope channel, the probabilities of the emitted outcomes sum to 1 within float64 tolerance (≤ 1e-9)",
      machine_checkable: true,
    },
    {
      name: "honest-scope",
      statement:
        "out-of-scope inputs (oracle, discard, free symbols, qubit cap exceeded) emit `tagged sturm-execute/out-of-scope`, never a wrong-shaped distribution",
      machine_checkable: false,
    },
    {
      name: "no-randomness",
      statement:
        "sturm-execute is strictly deterministic (per ADR-0005, the entropy contract); the analytic distribution is a function of the input alone",
      machine_checkable: true,
    },
    {
      name: "born-rule-matches-textbook-cases",
      statement:
        "for the documented examples (Bell, GHZ, NOT, H, parametrised RY) the probabilities match the textbook closed-form expressions",
      machine_checkable: false,
    },
    {
      name: "numerical-precision-floor",
      statement:
        "outcomes with probability below 1e-12 are dropped as IEEE-754 noise (e.g. cos(π/2) ≈ 6e-17 producing phantom branches). Real probabilities stay well above this floor; the future exact-symbolic path will not need this dead-zone.",
      machine_checkable: false,
    },
  ],
  fn: (input, _flags): Value => {
    const c = decodeChannel(input);
    return executeChannel(c);
  },
  test: () => {
    // Determinism: a fixed probe set must produce identical outputs on
    // every invocation. We rely on IEEE-754 determinism for the float64
    // ops; if any allocation introduces nondeterminism the same circuit
    // will diverge.
    const probes: Channel[] = [
      channel([], [], []),
      channel(
        [],
        [],
        [prepareOp(rat(1n, 2n), 0n), observeOp(0n, "r")]
      ),
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, piOver(2n), []),
          ryOp(1n, sym("π"), [0n]),
          observeOp(0n, "r0"),
          observeOp(1n, "r1"),
        ]
      ),
    ];
    for (const c of probes) {
      const out1 = JSON.stringify(executeChannel(c));
      const out2 = JSON.stringify(executeChannel(c));
      if (out1 !== out2) {
        throw new Error(
          `sturm-execute non-deterministic on probe: ${out1} vs ${out2}`
        );
      }
    }
    // Probabilities-sum-to-one for in-scope probes.
    const inScopeProbes: Channel[] = [
      channel(
        [],
        [],
        [prepareOp(rat(1n, 2n), 0n), observeOp(0n, "r")]
      ),
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          ryOp(0n, rat(7n, 13n), []),
          observeOp(0n, "r"),
        ]
      ),
      channel(
        [],
        [],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, piOver(2n), []),
          ryOp(1n, sym("π"), [0n]),
          observeOp(0n, "r0"),
          observeOp(1n, "r1"),
        ]
      ),
    ];
    for (const c of inScopeProbes) {
      const out = executeChannel(c);
      if (out.kind === "tagged") {
        throw new Error(
          `sturm-execute test: in-scope probe unexpectedly out-of-scope: ${out.tag}`
        );
      }
      if (out.kind !== "record") {
        throw new Error("sturm-execute test: unexpected output kind");
      }
      const outcomes = out.fields["outcomes"];
      if (outcomes === undefined || outcomes.kind !== "list") {
        throw new Error(
          "sturm-execute test: outcomes field missing or wrong shape"
        );
      }
      let total = 0;
      for (const o of outcomes.items) {
        if (o.kind !== "record") continue;
        const p = o.fields["prob"];
        if (p === undefined || p.kind !== "float64") continue;
        total += float64ToNumber(p);
      }
      if (Math.abs(total - 1) > 1e-9) {
        throw new Error(
          `sturm-execute test: probabilities sum to ${total}, expected 1`
        );
      }
    }
  },
});

if (import.meta.main) void runTool(def);
