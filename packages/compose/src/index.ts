// =============================================================================
// @workbench/compose — in-process composition layer
// =============================================================================
//
// Substrate: ADR-0012.
//
// This package is the TS-expert-facing surface of the workbench. The
// public exports are the type for a `Workbench`, the `loadWorkbench()`
// constructor, and the `CompositionError` class. Implementation of
// each surface lives in its own file so the API barrel here stays
// easy to scan.
//
// Subsequent issues fill in:
//   * scientist-workbench-9n1 — `loadWorkbench`
//   * scientist-workbench-23i — `Workbench.run`
//   * scientist-workbench-46z — `Workbench.pipe`
//   * scientist-workbench-4t5 — generated typed barrel
//   * scientist-workbench-mtw — `Workbench.lookup`
//   * scientist-workbench-csa — `Workbench.runMemoized`
//
// Until those land, importing `@workbench/compose` gives the type
// surface and the `CompositionError` class. Calling `loadWorkbench`
// throws a `not-yet-implemented` CompositionError so a caller cannot
// silently get a half-baked Workbench.

export { CompositionError } from "./errors.js";
export type { Workbench, LoadWorkbenchOptions, Pipe } from "./types.js";
export { loadWorkbench } from "./load.js";

// The typed-barrel surface (issue scientist-workbench-4t5).
//
// Generated from `tools/*/tool.ts` by `bun scripts/gen-workbench-barrel.ts`,
// which is a phase of `bun run check`. The generated file is checked
// in (deviation from ADR-0012 — see worklog 033 for the rationale)
// so imports of `@workbench/compose` work in fresh clones without
// running the codegen first.
export { typed, defs, type TypedWorkbench } from "./generated/wb.js";
