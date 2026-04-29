import type { GoldenSpec } from "@workbench/contract";

// Goldens for entropy-source are intentionally empty.
//
// `bun scripts/generate-goldens.ts` writes a captured `{input, output}`
// snapshot per spec entry, and the oracle compares actual output bytes
// against the recorded expected bytes. For a genuinely nondeterministic
// tool — see `docs/adr/0005-externalised-entropy.md` — both halves of
// that machinery break: every regeneration would write different bytes
// (defeating the "regenerate is a no-op on a clean tree" property the
// rest of the workbench relies on), and the oracle would fail every
// run because the captured snapshot diverges from the freshly drawn
// sample.
//
// The honest move is to publish *no* goldens here. `bun run check`'s
// oracle phase skips tools whose `goldens/` directory contains no
// `*.golden.json` files (see `scripts/check.ts`), so an empty array is
// not a contract violation — it is the explicit, documented choice
// that flows from the tool being nondeterministic-by-design.
//
// Verification responsibility moves entirely to the `--test` hook in
// `tool.ts`, which spawns the tool twice with a fixed input and asserts
// every shape invariant (byte-count, hex format, source-kind label, the
// two outputs differing). That hook runs under `bun run check` like any
// other tool's, so coverage is preserved; only the golden-snapshot path
// is opted out of, and only because byte-equal golden snapshots are
// definitionally inapplicable here.
//
// A future "shape-only oracle mode" — where the oracle validates output
// against the tool's `--schema` rather than against captured bytes —
// would let nondeterministic tools have non-trivial goldens (covering
// e.g. specific `n_bytes` values to exercise the chunking path). That
// work has not been filed; if a second nondeterministic tool ships and
// motivates the abstraction, do it then.

export const goldens: GoldenSpec[] = [];
