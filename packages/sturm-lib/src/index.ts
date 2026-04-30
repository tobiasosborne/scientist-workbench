// =============================================================================
// @workbench/sturm-lib — patterns library for the Sturm DSL
// =============================================================================
//
// This package is a TS port of `Sturm.jl/src/library/patterns.jl` (and
// the verified bits of `gates.jl`). It is *not* an extension of the
// language — every entry here is implemented in terms of the
// `@workbench/sturm` primitives (`rz`, `ry`, `not`, `when`, `qbool`,
// `qreg`, `observe`). The job of this package is to give an agent the
// idiomatic vocabulary to write Grover and friends without re-deriving
// the gate decompositions every time.
//
// Physics-correctness reference: `Sturm.jl/src/library/patterns.jl`
// for `_cz!`, `_multi_controlled_z!`, `_diffusion!`, `phase_flip!`,
// `amplify`, `find`. The recipes here are line-for-line ports.
//
// Up-to-global-phase
// ------------------
// All gates are correct as channels (CPTP maps), not unitaries. The
// 4 primitives generate SU(2); H has det = -1 so no SU(2) product is
// H *as a unitary*, but `iH ∈ SU(2)` and the channel ρ → iH·ρ·(iH)†
// equals ρ → H·ρ·H†. See `Sturm.jl/CLAUDE.md:64-72`. Where the global
// phase bites is inside `when()` — it becomes a relative phase. The
// `cz` recipe below is the well-known fix (`patterns.jl:258` and the
// "Session 8 bug"); naïve `controlled-Rz(π)` is *not* CZ.
//
// What's covered (Grover-complete)
// --------------------------------
// gates: H, X (= not), Z, S, T, Y, Sdg, Tdg
// CNOT-equivalent: cx (built directly via when + not)
// Multi-control: cz (5-op recipe), mcz (Toffoli-cascade for n≥3)
// Algorithm: phaseFlip, hadamardAll, diffuse, optimalIters, amplify, find
// Oracle helpers: equalTo, oracleFn (predicate-as-oracle, P9)
//
// What's *not* covered yet
// ------------------------
// QFT (`superpose`/`interfere`), `phaseEstimate`, `classicalise`,
// arithmetic on registers. All deferred until a use case demands.

import {
  type Channel,
  type QBool,
  type QReg,
  not,
  observe,
  qbool,
  qreg,
  ry,
  rz,
  trace,
  when,
} from "@workbench/sturm";

// =============================================================================
// Single-qubit gates (P5 said "no named gates in user code" — these are
// library helpers, NOT new primitives. Each one expands to primitives at
// emission time.)
// =============================================================================

/**
 * Hadamard channel on `q`. Recipe: `Rz(π); Ry(π/2)` (up to global
 * phase). The order matters — `Ry(π/2); Rz(π)` is also H up to a
 * different global phase, but `Rz(π); Ry(π/2)` is the production form
 * in `Sturm.jl/src/gates.jl:38` and the form `_diffusion!` and
 * `superpose!` (QFT) compose against.
 */
export function H(q: QBool): void {
  rz(q, Math.PI);
  ry(q, Math.PI / 2);
}

/** Pauli-X channel — alias for `not(q)`. */
export const X = not;

/** Pauli-Z channel — `Rz(π)`. */
export function Z(q: QBool): void {
  rz(q, Math.PI);
}

/** S = √Z — `Rz(π/2)`. */
export function S(q: QBool): void {
  rz(q, Math.PI / 2);
}

/** T = √S — `Rz(π/4)`. */
export function T(q: QBool): void {
  rz(q, Math.PI / 4);
}

/** S† — `Rz(-π/2)`. */
export function Sdg(q: QBool): void {
  rz(q, -Math.PI / 2);
}

/** T† — `Rz(-π/4)`. */
export function Tdg(q: QBool): void {
  rz(q, -Math.PI / 4);
}

/**
 * Pauli-Y channel — `Ry(π)`. Note: Ry(π) = -iY, so this is the Y
 * channel ρ → YρY (the global phase doesn't survive into the channel).
 * Inside `when()` the global phase becomes a relative phase, which is
 * why X is built as two primitives but Y is one — see the
 * `Sturm.jl-3yz` rationale and `Sturm.jl/src/gates.jl:45`.
 */
export function Y(q: QBool): void {
  ry(q, Math.PI);
}

// =============================================================================
// Two-qubit gates
// =============================================================================

/**
 * CNOT — flip `t` iff `c` is `|1⟩`. CX as a *channel* (textbook CNOT up
 * to a global phase).
 *
 * Why the trailing `rz(c, π/2)`: `not(q)` lowers to `rz(q, π); ry(q, π)`,
 * whose composite single-qubit unitary is `Ry(π)·Rz(π) = (-iY)(-iZ) =
 * -i·X` — the X channel up to global phase, fine for uncontrolled use.
 * But under `when(c, …)`, the `-i` factor only multiplies the `c=|1⟩`
 * block of the joint unitary: `diag(I, -iX)`. That's a *relative* phase
 * between the c=|0⟩ and c=|1⟩ branches — observable, and *not* the
 * channel CX. (`Sturm.jl/CLAUDE.md:64-72` calls this out as the
 * controlled-rotation phase trap; it's the same family of bug as
 * "controlled-Rz(π) ≠ CZ".)
 *
 * The fix: append `rz(c, π/2)` on the control. Rz(π/2) =
 * `diag(e^{-iπ/4}, e^{iπ/4})`, so this multiplies the c=|1⟩ block by
 * `e^{iπ/4}` and the c=|0⟩ block by `e^{-iπ/4}`. Combined with the
 * `-i` from the controlled `not`, the full unitary is
 * `e^{-iπ/4} · diag(I, X)` — textbook CNOT up to a global phase.
 *
 * The recipes in Sturm.jl/src/library/patterns.jl assume `cx(a,b)` is
 * channel-CX. Keep that contract by paying the one extra op here, once,
 * rather than re-deriving the compensation in every caller.
 */
export function cx(c: QBool, t: QBool): void {
  when(c, () => not(t));
  rz(c, Math.PI / 2);
}

/**
 * Controlled-Z — CZ = `diag(1, 1, 1, -1)`. NOT the same as
 * controlled-Rz(π), which is `diag(1, 1, -i, i)`. The 5-op recipe
 * here (`Sturm.jl/src/library/patterns.jl:258`) gets CZ exactly:
 *
 *     target.φ += π/2
 *     CX(c, t)
 *     target.φ -= π/2
 *     CX(c, t)
 *     control.φ += π/2
 *
 * This is the workaround for the "Session 8 bug" — naïve
 * controlled-Rz(π) is wrong because Rz(π)'s global phase becomes a
 * relative phase under control. Reference: Nielsen & Chuang §4.3,
 * Eq. (4.9).
 */
export function cz(a: QBool, b: QBool): void {
  rz(b, Math.PI / 2);
  cx(a, b);
  rz(b, -Math.PI / 2);
  cx(a, b);
  rz(a, Math.PI / 2);
}

// =============================================================================
// CCZ via the 6-CX Toffoli decomposition
// =============================================================================
//
// CCZ flips the phase of `|111⟩` for three qubits. The textbook
// decomposition is `H(t) · CCNOT(c1, c2, t) · H(t)`; CCNOT itself
// uses 6 CXs and various T/H gates (Nielsen-Chuang §4.3, Fig 4.9).
//
// Why we don't use the `when(c1, () => when(c2, () => not(t)))`
// nested-control form: under our cx convention (textbook CX as a
// channel), the nested `when` form lowers to ctrl-ctrl-(-iX) on the
// (c1=1, c2=1) block — the same `-iX` relative-phase trap we
// compensated in `cx`, but here the compensation needs a doubly-
// controlled phase, which is not a primitive. The proper fix is to
// build CCNOT from `cx`'s already-correct channel CX and never
// emit doubly-controlled rotations.
//
// Given that we now have a true CCZ helper, `mcz` for n=3 calls
// it directly (no ancilla, no cascade). This gives Grover up to
// W=3 (search space 8) end-to-end. For n≥4 we'd need either an
// ancilla cascade with proper CCNOTs or a recursive decomposition;
// both are deferred to v0.2.

function ccz(c1: QBool, c2: QBool, t: QBool): void {
  // Decomposition: CCZ = (I⊗I⊗H) · CCNOT · (I⊗I⊗H), and CCNOT is
  // expanded via N&C Fig 4.9. The H · H sandwich at the start/end
  // of the CCNOT cancels the leading/trailing H here, so we drop
  // them — the resulting net is exactly CCZ.
  //
  // Layout (target = t, controls = c1, c2):
  cx(c2, t);
  Tdg(t);
  cx(c1, t);
  T(t);
  cx(c2, t);
  Tdg(t);
  cx(c1, t);
  T(c2); T(t);
  cx(c1, c2);
  T(c1); Tdg(c2);
  cx(c1, c2);
}

// =============================================================================
// Multi-controlled Z
// =============================================================================

/**
 * Flip the phase of `|1…1⟩` over `qs`.
 *
 * v0.1 supports `n ∈ {1, 2, 3}` directly (no ancillae). `n=4..` is
 * deferred — would need either an ancilla cascade with full CCNOTs
 * or a recursive 4+ decomposition. Throws on `n ≥ 4`.
 */
export function mcz(qs: readonly QBool[]): void {
  const n = qs.length;
  if (n < 1) {
    throw new Error("@workbench/sturm-lib: mcz requires at least one qubit");
  }
  if (n === 1) {
    Z(qs[0]!);
    return;
  }
  if (n === 2) {
    cz(qs[0]!, qs[1]!);
    return;
  }
  if (n === 3) {
    ccz(qs[0]!, qs[1]!, qs[2]!);
    return;
  }
  throw new Error(
    `@workbench/sturm-lib: mcz on n=${n} qubits is deferred to v0.2 ` +
    "(would need a multi-control decomposition with ancillae). v0.1 supports n ∈ {1,2,3}.",
  );
}

// =============================================================================
// Phase oracle — mark a basis state by phase flip
// =============================================================================

/**
 * Mark `target` by flipping its phase: `|target⟩ → -|target⟩`, all
 * other basis states unchanged.
 *
 * Recipe (`patterns.jl:339`):
 *   - X-mask: apply `not` to qubits where `target`'s bit is 0,
 *     mapping `|target⟩` to `|1…1⟩`.
 *   - mcz on all qubits: flip the phase of `|1…1⟩`.
 *   - Undo X-mask.
 *
 * Bit ordering: `reg[0]` is LSB, so `(target >> i) & 1` is the bit
 * for `reg[i]`.
 */
export function phaseFlip(reg: QReg<number>, target: number | bigint): void {
  const t = typeof target === "bigint" ? target : BigInt(target);
  const W = reg.width;
  const max = (1n << BigInt(W)) - 1n;
  if (t < 0n || t > max) {
    throw new Error(
      `@workbench/sturm-lib: phaseFlip target ${target} out of range for QReg<${W}>`,
    );
  }
  const bits: QBool[] = [];
  for (let i = 0; i < W; i++) bits.push(reg[i]!);

  // X-mask.
  for (let i = 0; i < W; i++) {
    if (((t >> BigInt(i)) & 1n) === 0n) not(bits[i]!);
  }
  mcz(bits);
  // Undo X-mask (X is self-inverse).
  for (let i = 0; i < W; i++) {
    if (((t >> BigInt(i)) & 1n) === 0n) not(bits[i]!);
  }
}

/**
 * Mark every value in `targets` by phase flip. Composes
 * `phaseFlip` for each.
 */
export function phaseFlipMany(reg: QReg<number>, targets: readonly (number | bigint)[]): void {
  for (const t of targets) phaseFlip(reg, t);
}

// =============================================================================
// Hadamard-all and diffusion
// =============================================================================

/** Apply H to every bit of `reg` independently. */
export function hadamardAll(reg: QReg<number>): void {
  for (let i = 0; i < reg.width; i++) H(reg[i]!);
}

/**
 * Grover diffusion operator: `H⊗n · (2|0⟩⟨0| − I) · H⊗n`.
 * The reflection-about-|0⟩ is `X⊗n · MCZ · X⊗n`.
 */
export function diffuse(reg: QReg<number>): void {
  hadamardAll(reg);
  for (let i = 0; i < reg.width; i++) not(reg[i]!);
  const bits: QBool[] = [];
  for (let i = 0; i < reg.width; i++) bits.push(reg[i]!);
  mcz(bits);
  for (let i = 0; i < reg.width; i++) not(reg[i]!);
  hadamardAll(reg);
}

// =============================================================================
// Grover / amplitude amplification
// =============================================================================

/**
 * Optimal number of Grover iterations for `M` marked states out of
 * `N`: `⌊π/4 · √(N/M)⌋`. Source: Brassard et al. (2002), Theorem 3.
 *
 * Floors to 1 for any non-trivial M (you always want at least one
 * iteration to amplify).
 */
export function optimalIters(N: number, M: number): number {
  if (M < 1 || M > N) {
    throw new Error(
      `@workbench/sturm-lib: optimalIters requires 1 ≤ M ≤ N, got M=${M}, N=${N}`,
    );
  }
  return Math.max(1, Math.floor((Math.PI / 4) * Math.sqrt(N / M)));
}

/**
 * Amplitude amplification — the general form of Grover. Returns a
 * `Channel<[], []>` that prepares `|0⟩^W`, applies `prepare!`, runs
 * `iterations` of (oracle; `unprepare!`; reflect-about-|0⟩;
 * `prepare!`), then observes every bit.
 *
 * For canonical Grover, `prepare = unprepare = hadamardAll`; that's
 * what `find` does.
 */
export function amplify(
  W: number,
  oracle: (x: QReg<number>) => void,
  prepareFn: (x: QReg<number>) => void,
  unprepareFn: (x: QReg<number>) => void,
  iterations: number,
): Channel<readonly [], readonly []> {
  return trace<readonly [], readonly []>(() => {
    const x = qreg(W, 0);
    prepareFn(x);
    for (let i = 0; i < iterations; i++) {
      oracle(x);
      unprepareFn(x);
      // Reflect about |0⟩: X⊗n · MCZ · X⊗n.
      for (let j = 0; j < W; j++) not(x[j]!);
      const bits: QBool[] = [];
      for (let j = 0; j < W; j++) bits.push(x[j]!);
      mcz(bits);
      for (let j = 0; j < W; j++) not(x[j]!);
      prepareFn(x);
    }
    // Observe in document order: bit 0 → r0, bit 1 → r1, …
    for (let i = 0; i < W; i++) observe(x[i]!);
    return [];
  });
}

/**
 * Grover's algorithm — special case of `amplify` with
 * `prepare = unprepare = hadamardAll` and the optimal iteration count.
 *
 * @param W — number of search-space bits. Search space size is `2^W`.
 * @param oracle — phase oracle: a function that flips the phase of
 *   the marked state(s) in the input register. The oracle runs inside
 *   the trace; typically it calls `phaseFlip(x, target)` once per
 *   marked state.
 * @param nMarked — count of marked states (defaults to 1). Used to
 *   compute the optimal iteration count.
 *
 * @example
 *   const search = find(3, x => phaseFlip(x, 5));
 *   const { distribution } = await execute(search);
 *   // distribution is peaked at the resolution where every observed
 *   // bit matches the bits of 5 (binary 101): r0=1, r1=0, r2=1.
 *
 * @example  // multi-marked
 *   const search = find(3, x => phaseFlipMany(x, [0, 2, 4, 6]), 4);
 *   // amplifies the four even values.
 */
export function find(
  W: number,
  oracle: (x: QReg<number>) => void,
  nMarked: number = 1,
): Channel<readonly [], readonly []> {
  const N = 1 << W;
  const iters = optimalIters(N, nMarked);
  return amplify(W, oracle, hadamardAll, hadamardAll, iters);
}

// =============================================================================
// Oracle helpers (P9 in TS-native form)
// =============================================================================

/**
 * Oracle that marks a single basis state.
 *
 * @example
 *   const search = find(3, equalTo(5));
 */
export function equalTo(target: number | bigint): (x: QReg<number>) => void {
  return x => phaseFlip(x, target);
}

/**
 * Oracle compiled from a plain TS predicate. The library tabulates
 * over the full domain `[0, 2^W)`, evaluates the predicate on each,
 * and emits a `phaseFlipMany` over the marked subset. Suitable for
 * `W ≤ 12` (the qubit cap caps the simulator anyway).
 *
 * P9 in TS-native form: any pure TS predicate becomes a phase oracle
 * via classical pre-evaluation. No LLVM-IR extraction, no AST
 * rewriting; just enumeration over a small domain.
 *
 * @example
 *   const search = find(4, oracleFn(x => x * x === 9));   // marks {3}
 *   const search = find(3, oracleFn(x => x % 2 === 0), 4); // marks even
 */
export function oracleFn(
  predicate: (x: number) => boolean,
): (x: QReg<number>) => void {
  return x => {
    const W = x.width;
    const N = 1 << W;
    const marked: number[] = [];
    for (let v = 0; v < N; v++) {
      if (predicate(v)) marked.push(v);
    }
    if (marked.length === 0) {
      throw new Error(
        `@workbench/sturm-lib: oracleFn predicate matched no values in [0, ${N})`,
      );
    }
    phaseFlipMany(x, marked);
  };
}
