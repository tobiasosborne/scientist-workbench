import type { GoldenSpec } from "@workbench/contract";

// Oracle's outputs include absolute paths and content hashes that depend on
// the local checkout, so portable goldens are awkward. We exercise the
// oracle indirectly: by running it against every other tool's goldens via
// `bun run check` (see scripts/check.ts).
export const goldens: GoldenSpec[] = [];
