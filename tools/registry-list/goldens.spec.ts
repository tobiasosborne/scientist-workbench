import type { GoldenSpec } from "@workbench/contract";

// registry-list output depends on which tools are installed in the workspace,
// which changes as the registry accretes. Exercised indirectly through the
// other tools' --schema/--examples/--invariants endpoints; goldens here would
// rot every time a new tool lands.
export const goldens: GoldenSpec[] = [];
