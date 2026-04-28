import type { GoldenSpec } from "@workbench/contract";

// Same caveat as registry-list — the result set rotates with the installed
// registry, so on-disk goldens would be a churn liability rather than a
// regression net.
export const goldens: GoldenSpec[] = [];
