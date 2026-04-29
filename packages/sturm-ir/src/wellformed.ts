// =============================================================================
// wellformed — invariants beyond what the schema catches
// =============================================================================
//
// Why this file exists
// --------------------
// The schema (`schema.ts`) checks the *shape* of an IR Value: an op
// has the right head, the right arity, the right kinds-of-args. But
// many IR-level invariants are graph-shaped, not shape-shaped:
//
//   • A wire ID referenced by `ry` must be in scope at that point —
//     either declared in the input signature or introduced earlier
//     in the body by `prepare` or `oracle`.
//   • A control wire must be a *quantum* wire, not classical.
//   • A `cases` op's `classical_ref` must be bound by a prior
//     `observe`.
//   • Wire IDs are scoped to the enclosing channel; reuse of an ID
//     by a second `prepare` is a collision, not a refresh.
//
// Schemas don't reach these. `checkWellFormed` is the second pass: a
// linear walk over the body, maintaining a `State` of the live wire
// scope and the live classical-ref bindings, accumulating the first
// failure encountered with a dotted path through the body.
//
// Convention note: `cases` arms in v0.1 are restricted — they may
// modify quantum *state* (apply `ry`/`rz`/`oracle`-on-existing-wires)
// but they may NOT introduce or remove wires (no `prepare`,
// `discard`, `observe`, or `cases` inside an arm; no `oracle` whose
// `outWires` are not already in scope). The two arms must leave the
// scope unchanged. This restriction is the simplest rule that makes
// post-cases scope unambiguous; relaxing it (allowing scope-changing
// arms with a "both arms agree" check) is filed as future work and
// not required for the v0.1 tools.
//
// Returns the same `{ ok, failure? }` discriminated-union shape as
// `validate` from the protocol package, so callers (notably
// `sturm-simplify` and friends) can treat the two checks uniformly.

import { type Channel, type Op, type Wire, type WireDim } from "./nodes.js";

export interface WellFormedFailure {
  readonly path: readonly string[];
  readonly message: string;
}

export type WellFormedResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: WellFormedFailure };

const OK: WellFormedResult = { ok: true };

function failAt(path: readonly string[], message: string): WellFormedResult {
  return { ok: false, failure: { path, message } };
}

// State snapshot for cases-arm comparison. Two snapshots are equal
// iff they cover the same wire IDs (with the same kind+dim) and the
// same classical-refs.

interface State {
  readonly wireScope: Map<bigint, WireRecord>;
  readonly classicalRefs: Set<string>;
}

interface WireRecord {
  readonly kind: "classical" | "quantum";
  readonly dim: WireDim;
}

function defaultDim(w: Wire): WireDim {
  // v0.1: undeclared dim defaults to "qubit". The schema admits other
  // dims for forward compatibility (P7) but no v0.1 tool emits them.
  return w.dim ?? "qubit";
}

function snapshotState(s: State): State {
  return {
    wireScope: new Map(s.wireScope),
    classicalRefs: new Set(s.classicalRefs),
  };
}

function statesEqual(a: State, b: State): boolean {
  if (a.wireScope.size !== b.wireScope.size) return false;
  for (const [id, recA] of a.wireScope) {
    const recB = b.wireScope.get(id);
    if (recB === undefined) return false;
    if (recB.kind !== recA.kind || recB.dim !== recA.dim) return false;
  }
  if (a.classicalRefs.size !== b.classicalRefs.size) return false;
  for (const r of a.classicalRefs) if (!b.classicalRefs.has(r)) return false;
  return true;
}

// Walks one op against the in/out State. Returns a result; on success
// the State has been mutated in place to reflect post-op scope. On
// failure, the State may be partially updated, but the caller will
// short-circuit and propagate the failure anyway.

function stepOp(
  op: Op,
  state: State,
  path: readonly string[],
  insideArm: boolean
): WellFormedResult {
  switch (op.head) {
    case "prepare": {
      if (insideArm) {
        return failAt(path, `prepare inside cases arm is not allowed in v0.1`);
      }
      if (state.wireScope.has(op.wireId)) {
        return failAt(path, `prepare collides with existing wire id ${op.wireId}`);
      }
      state.wireScope.set(op.wireId, { kind: "quantum", dim: "qubit" });
      return OK;
    }
    case "ry":
    case "rz": {
      const target = state.wireScope.get(op.wireId);
      if (target === undefined) {
        return failAt(path, `${op.head} references wire ${op.wireId} not in scope`);
      }
      if (target.kind !== "quantum") {
        return failAt(
          path,
          `${op.head} requires quantum wire, but ${op.wireId} is ${target.kind}`
        );
      }
      const seen = new Set<bigint>();
      for (let i = 0; i < op.controls.length; i++) {
        const c = op.controls[i]!;
        if (c === op.wireId) {
          return failAt(path, `${op.head} control ${c} coincides with target wire`);
        }
        if (seen.has(c)) {
          return failAt(path, `${op.head} duplicate control wire ${c}`);
        }
        seen.add(c);
        const cw = state.wireScope.get(c);
        if (cw === undefined) {
          return failAt(path, `${op.head} control ${c} not in scope`);
        }
        if (cw.kind !== "quantum") {
          return failAt(
            path,
            `${op.head} control ${c} must be quantum, got ${cw.kind}`
          );
        }
      }
      return OK;
    }
    case "observe": {
      if (insideArm) {
        return failAt(path, `observe inside cases arm is not allowed in v0.1`);
      }
      const target = state.wireScope.get(op.wireId);
      if (target === undefined) {
        return failAt(path, `observe references wire ${op.wireId} not in scope`);
      }
      if (target.kind !== "quantum") {
        return failAt(
          path,
          `observe requires quantum wire, but ${op.wireId} is ${target.kind}`
        );
      }
      if (state.classicalRefs.has(op.classicalRef)) {
        return failAt(
          path,
          `observe rebinds existing classical_ref "${op.classicalRef}"`
        );
      }
      state.wireScope.delete(op.wireId);
      state.classicalRefs.add(op.classicalRef);
      return OK;
    }
    case "oracle": {
      // All inWires must be in scope. outWires may be already in scope
      // (in-place write) or fresh (introduced as quantum/qubit). In
      // a cases arm, only the in-place mode is allowed (no scope
      // change).
      for (const wid of op.inWires) {
        const w = state.wireScope.get(wid);
        if (w === undefined) {
          return failAt(path, `oracle inWire ${wid} not in scope`);
        }
        if (w.kind !== "quantum") {
          return failAt(
            path,
            `oracle inWire ${wid} must be quantum, got ${w.kind}`
          );
        }
      }
      for (const wid of op.outWires) {
        const existing = state.wireScope.get(wid);
        if (existing === undefined) {
          if (insideArm) {
            return failAt(
              path,
              `oracle introduces wire ${wid} inside a cases arm; not allowed in v0.1`
            );
          }
          state.wireScope.set(wid, { kind: "quantum", dim: "qubit" });
        } else if (existing.kind !== "quantum") {
          return failAt(
            path,
            `oracle outWire ${wid} must be quantum, got ${existing.kind}`
          );
        }
      }
      return OK;
    }
    case "cases": {
      if (!state.classicalRefs.has(op.classicalRef)) {
        return failAt(
          path,
          `cases references classical_ref "${op.classicalRef}" not in scope`
        );
      }
      if (insideArm) {
        return failAt(path, `nested cases inside a cases arm is not allowed in v0.1`);
      }
      const before = snapshotState(state);
      // True arm runs against a copy.
      const trueState = snapshotState(before);
      for (let i = 0; i < op.trueArm.length; i++) {
        const innerPath = [...path, "trueArm", String(i)];
        const r = stepOp(op.trueArm[i]!, trueState, innerPath, true);
        if (!r.ok) return r;
      }
      // False arm runs against another copy.
      const falseState = snapshotState(before);
      for (let i = 0; i < op.falseArm.length; i++) {
        const innerPath = [...path, "falseArm", String(i)];
        const r = stepOp(op.falseArm[i]!, falseState, innerPath, true);
        if (!r.ok) return r;
      }
      // The arms must agree on post-state. (Given the no-scope-change
      // restriction, this should be automatic — both arms must equal
      // `before`. Checking explicitly catches any internal logic bugs
      // in stepOp's restrictions.)
      if (!statesEqual(trueState, before) || !statesEqual(falseState, before)) {
        return failAt(
          path,
          `cases arms must not change wire/classical scope in v0.1`
        );
      }
      // The parent state stays at `before` — the cases op as a whole
      // does not mutate scope (in v0.1).
      return OK;
    }
    case "discard": {
      if (insideArm) {
        return failAt(path, `discard inside cases arm is not allowed in v0.1`);
      }
      const target = state.wireScope.get(op.wireId);
      if (target === undefined) {
        return failAt(path, `discard references wire ${op.wireId} not in scope`);
      }
      if (target.kind !== "quantum") {
        return failAt(
          path,
          `discard requires quantum wire, but ${op.wireId} is ${target.kind}`
        );
      }
      state.wireScope.delete(op.wireId);
      return OK;
    }
  }
}

/**
 * Validate the structural invariants of a Channel beyond what the
 * schema captures: wire-ID scoping, control-must-be-quantum,
 * classical-ref scoping, and the v0.1 restriction that `cases` arms
 * do not change scope.
 *
 * Returns `{ ok: true }` if every op respects every invariant. On the
 * first violation, returns `{ ok: false, failure }` with a dotted
 * path through `body[i]` / `args[j]` / `trueArm[k]` etc., and a
 * human-readable message naming the offending wire/ref.
 */
export function checkWellFormed(c: Channel): WellFormedResult {
  const state: State = {
    wireScope: new Map(),
    classicalRefs: new Set(),
  };

  // Seed the state from the input signature. Inputs declare their own
  // kind+dim; we trust that (the schema already validated they are
  // valid strings).
  const seenIds = new Set<bigint>();
  for (let i = 0; i < c.inputs.length; i++) {
    const w = c.inputs[i]!;
    if (seenIds.has(w.id)) {
      return failAt(
        ["inputs", String(i)],
        `duplicate wire id ${w.id} in input signature`
      );
    }
    seenIds.add(w.id);
    state.wireScope.set(w.id, { kind: w.kind, dim: defaultDim(w) });
  }

  // Walk the body in document order.
  for (let i = 0; i < c.body.length; i++) {
    const r = stepOp(c.body[i]!, state, ["body", String(i)], false);
    if (!r.ok) return r;
  }

  // Every output wire must be in scope at end of body.
  const outSeenIds = new Set<bigint>();
  for (let i = 0; i < c.outputs.length; i++) {
    const w = c.outputs[i]!;
    if (outSeenIds.has(w.id)) {
      return failAt(
        ["outputs", String(i)],
        `duplicate wire id ${w.id} in output signature`
      );
    }
    outSeenIds.add(w.id);
    const live = state.wireScope.get(w.id);
    if (live === undefined) {
      return failAt(
        ["outputs", String(i)],
        `output wire ${w.id} not in scope at end of body`
      );
    }
    if (live.kind !== w.kind) {
      return failAt(
        ["outputs", String(i)],
        `output wire ${w.id} declared as ${w.kind} but live as ${live.kind}`
      );
    }
    if (defaultDim(w) !== live.dim) {
      return failAt(
        ["outputs", String(i)],
        `output wire ${w.id} declared dim ${defaultDim(w)} but live as ${live.dim}`
      );
    }
  }

  return OK;
}
