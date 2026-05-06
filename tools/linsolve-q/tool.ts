// linsolve-q — exact linear solving over Q via Bareiss fraction-free
// Gaussian elimination.
//
// Given a rational matrix `A` and vector `b`, produce `x` such that
// `A · x = b` exactly. Distinguishes three output kinds:
//   - unique (full column rank, single x)
//   - under-determined (rank < n, parametric family with t_0, t_1, …)
//   - inconsistent (rank(A) < rank([A | b]) — no solution)
//
// Output shape: ADR-0017's solution-set shape, with linear-tier
// adaptations:
//   record {
//     vars: list<symbol>,            // synthesised x_0, x_1, ..., x_{n-1}
//     solutions: list<record {
//       bindings: list<record { var: symbol, value: <integer | rational | expression> }>,
//       branches: list<symbol>       // [] for unique; t_0..t_{free-1} for under-det
//     }>,
//     completeness: 'complete' | 'finite-rep-of-infinite',
//     warnings: list<string>
//   }
// or tagged "linsolve-q/inconsistent" with payload
//   record { rank: integer, augmented_rank: integer, warnings: list<string> }
//
// The free-variable parametrisation encodes affine values as workbench
// arithmetic expressions: `5 - 2·t_0` becomes
//   expr("+", [int(5), expr("*", [int(-2), sym("t_0")])])
// — composes with `cas-simplify` and the rest of the symbolic pipeline.
//
// Algorithm reference: Bareiss 1968, Math. Comp. 22(103) §II.A.2 Eq. 8.
// Local copy at docs/ground-truth/linear/bareiss-1968-mathcomp.pdf.
//
// This tool is the first solve-tier tool; ADRs 0017, 0018, 0019 are its
// canonical design references. Per ADR-0019, the bench at bench/linsolve-q
// is the brutal goldmaster harness — 46 cases × 8 invariant checks each.

import {
  expr,
  hash,
  int,
  list,
  rat as protocolRat,
  record,
  S,
  sym,
  tagged,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  affineToString,
  type Affine,
  bareissSolve,
  type LinSolveResult,
  makeRat,
  type Rat,
} from "@workbench/cas-core";

const NAME = "linsolve-q";
const VERSION = "0.1.0";
const INCONSISTENT_TAG = "linsolve-q/inconsistent";

const numericSchema = S.union([
  S.kind("integer"),
  S.kind("rational"),
]);

const inputSchema = S.record({
  A: S.list(S.list(numericSchema)),
  b: S.list(numericSchema),
});

// Output schema: open (S.any). The structured shape is documented in
// the file header and enforced by invariants + the bench. Expressing
// the full ADR-0017 union inline would require recursive schemas
// (S.record with a `value: any` field; the recursion would land on
// nested expressions inside under-determined affine encodings) which
// the schema language deliberately rejects (ADR-0004).
const outputSchema = S.any();

// -----------------------------------------------------------------------------
// Conversion: Value (integer | rational) ⟶ Rat
// -----------------------------------------------------------------------------

function valueToRat(v: Value): Rat {
  if (v.kind === "integer") return makeRat(BigInt(v.value), 1n);
  if (v.kind === "rational") {
    return makeRat(BigInt(v.num), BigInt(v.den));
  }
  throw new Error(`linsolve-q: expected integer or rational, got ${v.kind}`);
}

function ratToValue(r: Rat): Value {
  if (r.d === 1n) return int(r.n);
  return protocolRat(r.n, r.d);
}

// -----------------------------------------------------------------------------
// Affine ⟶ workbench expression
// -----------------------------------------------------------------------------
//
// `Affine = { c: Rat, coeffs: Map<string, Rat> }` is encoded as a
// `+`-headed expression whose args are: the constant (if non-zero)
// followed by one `*`-multiplied term per non-zero coefficient. A
// degenerate empty affine (no constant, no terms) becomes integer 0.
// Single-term forms collapse: a single integer constant returns just
// that integer; a single 1·t_0 term returns just sym("t_0").
//
// The encoding is human-readable and round-trips through cas-simplify;
// it is the de-facto "linear value" in the workbench's expression
// vocabulary.

function affineToExpr(a: Affine): Value {
  const parts: Value[] = [];
  if (a.c.n !== 0n) parts.push(ratToValue(a.c));
  // Sort free variables by their numeric index for deterministic output.
  const names = [...a.coeffs.keys()].sort((x, y) => {
    const ix = parseInt(x.replace(/^t_/, ""), 10);
    const iy = parseInt(y.replace(/^t_/, ""), 10);
    return ix - iy;
  });
  for (const name of names) {
    const coeff = a.coeffs.get(name)!;
    if (coeff.n === 0n) continue;
    const symV = sym(name);
    if (coeff.n === 1n && coeff.d === 1n) {
      parts.push(symV);
    } else if (coeff.n === -1n && coeff.d === 1n) {
      parts.push(expr("*", [int(-1n), symV]));
    } else {
      parts.push(expr("*", [ratToValue(coeff), symV]));
    }
  }
  if (parts.length === 0) return int(0n);
  if (parts.length === 1) return parts[0]!;
  return expr("+", parts);
}

// -----------------------------------------------------------------------------
// Build the ADR-0017 solution-set value
// -----------------------------------------------------------------------------

function buildOutput(result: LinSolveResult, n: number): Value {
  const warnings = list([
    {
      kind: "string" as const,
      value: `max intermediate bit length: ${result.maxIntermediateBitLength}`,
    },
  ]);

  if (result.kind === "inconsistent") {
    return tagged(
      INCONSISTENT_TAG,
      record({
        rank: int(BigInt(result.rank)),
        augmented_rank: int(BigInt(result.augmentedRank)),
        warnings,
      }),
    );
  }

  // vars: x_0, x_1, ..., x_{n-1}
  const vars = list(Array.from({ length: n }, (_, i) => sym(`x_${i}`)));

  if (result.kind === "unique") {
    const bindings = list(
      result.x.map((xi, i) =>
        record({
          var: sym(`x_${i}`),
          value: ratToValue(xi),
        }),
      ),
    );
    const solution = record({
      bindings,
      branches: list([]),
    });
    return record({
      vars,
      solutions: list([solution]),
      completeness: { kind: "string", value: "complete" },
      warnings,
    });
  }

  // under-determined
  const bindings = list(
    result.x.map((aff, i) =>
      record({
        var: sym(`x_${i}`),
        value: affineToExpr(aff),
      }),
    ),
  );
  const branches = list(result.freeVars.map((name) => sym(name)));
  const solution = record({ bindings, branches });
  return record({
    vars,
    solutions: list([solution]),
    completeness: { kind: "string", value: "finite-rep-of-infinite" },
    warnings,
  });
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: inputSchema,
    output: outputSchema,
  },
  examples: [
    {
      description: "1×1 unique: 3·x = 6 ⇒ x=2",
      input: record({
        A: list([list([int(3n)])]),
        b: list([int(6n)]),
      }),
    },
    {
      description: "2×2 unique: x+2y=5, 3x+4y=11 ⇒ x=1, y=2",
      input: record({
        A: list([
          list([int(1n), int(2n)]),
          list([int(3n), int(4n)]),
        ]),
        b: list([int(5n), int(11n)]),
      }),
    },
    {
      description: "rational coefficients: (3/2)x − y = 5/2",
      input: record({
        A: list([list([protocolRat(3n, 2n), int(-1n)])]),
        b: list([protocolRat(5n, 2n)]),
      }),
    },
    {
      description: "1×2 under-determined: x + 2y = 5",
      input: record({
        A: list([list([int(1n), int(2n)])]),
        b: list([int(5n)]),
      }),
    },
    {
      description: "rank-deficient with consistent rhs",
      input: record({
        A: list([
          list([int(1n), int(2n), int(3n)]),
          list([int(2n), int(4n), int(6n)]),
          list([int(0n), int(1n), int(0n)]),
        ]),
        b: list([int(6n), int(12n), int(2n)]),
      }),
    },
    {
      description: "inconsistent: 1·x = 3, 2·x = 7",
      input: record({
        A: list([list([int(1n)]), list([int(2n)])]),
        b: list([int(3n), int(7n)]),
      }),
    },
    {
      description: "0×0 trivially unique with empty x",
      input: record({ A: list([]), b: list([]) }),
    },
    {
      description: "Hilbert H_3 — ill-conditioned in ℝ, exact in ℚ",
      input: record({
        A: list([
          list([int(1n), protocolRat(1n, 2n), protocolRat(1n, 3n)]),
          list([protocolRat(1n, 2n), protocolRat(1n, 3n), protocolRat(1n, 4n)]),
          list([protocolRat(1n, 3n), protocolRat(1n, 4n), protocolRat(1n, 5n)]),
        ]),
        // b = H · (1, -2, 1) computed exactly:
        //   row 0: 1 - 1 + 1/3 = 1/3
        //   row 1: 1/2 - 2/3 + 1/4 = 1/12
        //   row 2: 1/3 - 1/2 + 1/5 = 1/30
        b: list([protocolRat(1n, 3n), protocolRat(1n, 12n), protocolRat(1n, 30n)]),
      }),
    },
  ],
  invariants: [
    {
      name: "exact-residual-unique",
      statement: "kind=unique ⇒ A·x ≡ b exactly in Q (no rounding)",
      machine_checkable: true,
    },
    {
      name: "kind-rank-relation",
      statement:
        "kind=unique ⇔ rank=n; kind=under-determined ⇔ rank<n; " +
        "kind=inconsistent ⇔ augmented_rank>rank",
      machine_checkable: true,
    },
    {
      name: "free-var-count",
      statement: "kind=under-determined ⇒ |branches| = n − rank",
      machine_checkable: true,
    },
    {
      name: "deterministic",
      statement: "same input bytes ⇒ same output bytes",
      machine_checkable: true,
    },
    {
      name: "integer-preserving",
      statement:
        "max intermediate bit length bounded by Hadamard's bound on " +
        "submatrix determinants (per Bareiss 1968 §I)",
      machine_checkable: false,
    },
  ],
  fn: (input, _flags) => {
    const A = input.fields.A.items.map((row) =>
      row.items.map(valueToRat),
    );
    const b = input.fields.b.items.map(valueToRat);
    const n = A.length > 0 ? A[0]!.length : 0;
    const result = bareissSolve(A, b);
    return buildOutput(result, n);
  },
  test: () => {
    // Determinism + idempotent invocation across the example bank.
    for (const ex of (def.examples ?? [])) {
      const out1 = def.fn(ex.input as never, {} as never);
      const out2 = def.fn(ex.input as never, {} as never);
      const v1 = out1 instanceof Promise ? null : out1;
      const v2 = out2 instanceof Promise ? null : out2;
      if (v1 === null || v2 === null) {
        throw new Error("linsolve-q: fn returned a Promise (unexpected)");
      }
      if (hash(v1) !== hash(v2)) {
        throw new Error(`linsolve-q non-deterministic on ${ex.description}`);
      }
    }
    // Basic correctness probes — the bench is the comprehensive check.
    const cases: Array<{ A: Rat[][]; b: Rat[]; expectKind: string }> = [
      {
        A: [[makeRat(1n), makeRat(0n)], [makeRat(0n), makeRat(1n)]],
        b: [makeRat(7n), makeRat(-3n)],
        expectKind: "unique",
      },
      {
        A: [[makeRat(1n)], [makeRat(2n)]],
        b: [makeRat(3n), makeRat(7n)],
        expectKind: "inconsistent",
      },
      {
        A: [[makeRat(1n), makeRat(2n)]],
        b: [makeRat(5n)],
        expectKind: "under-determined",
      },
    ];
    for (const c of cases) {
      const r = bareissSolve(c.A, c.b);
      if (r.kind !== c.expectKind) {
        throw new Error(`linsolve-q wrong kind: got ${r.kind}, expected ${c.expectKind}`);
      }
    }
  },
});

if (import.meta.main) void runTool(def);
