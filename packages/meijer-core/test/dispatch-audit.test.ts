// =============================================================================
// dispatch-audit.test.ts — no-direct-porting audit grep
// =============================================================================
//
// Per `tstournament/ts-bench-infra/problems/13-meijer-g/PROMPT.md`
// § "Audit grep dimensions" and ADR-0025 §9: every rule in the
// dispatcher must derive from primary-literature sources, not from
// any open-source reference implementation. This test enforces the
// audit at commit time by greping the dispatcher source for the
// known short-form tokens enumerated in PROMPT.md.
//
// **What this test catches.** Identifier leakage from mpmath /
// SymPy / FriCAS / Maxima / REDUCE source. Name choices that look
// idiomatic to one of those codebases.
//
// **What this test does NOT catch.** Rules whose *content* is
// transliterated but whose variable names are renamed to look local.
// That category is caught by the human-review at commit (CLAUDE.md
// Rule 3 / Skepticism).
//
// **Tokens.** From PROMPT.md § "Audit grep dimensions" — extended
// to include identifier-prefix matches (so `_hyp_borel` is caught
// even if used as `_hyp_borel_local`).

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);
const SRC_ROOT = join(PKG_ROOT, "src");

/**
 * The forbidden short-form tokens. We use word-boundary matches via
 * regex so a substring inside a longer identifier (e.g. `hypergraph`)
 * is not flagged spuriously. Each token is named for the source it
 * comes from so a future agent reading a CI failure understands the
 * audit dimension.
 */
const FORBIDDEN_TOKENS: ReadonlyArray<{ token: string; source: string }> = [
  // mpmath/functions/hypergeometric.py short-forms
  { token: "hypercomb", source: "mpmath" },
  { token: "_hyp_borel", source: "mpmath" },
  { token: "nint_distance", source: "mpmath" },
  { token: "hmag", source: "mpmath" },
  { token: "_hypercomb_msg", source: "mpmath" },
  // SymPy hyperexpand / meijerint short-forms
  { token: "inhomogeneous_series", source: "sympy" },
  { token: "_my_unpolarify", source: "sympy" },
  { token: "build_hypergeometric_formula", source: "sympy" },
  { token: "_meijergexpand", source: "sympy" },
  // SymPy mpmath bridge tokens
  { token: "make_derivative_operator", source: "sympy" },
];

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

describe("dispatch — audit grep (no-direct-porting)", () => {
  test("no forbidden short-form tokens in dispatch.ts / dispatch-types.ts / dispatch-rules/*", async () => {
    const files = (await listFiles(SRC_ROOT)).filter((f) => {
      const rel = f.slice(SRC_ROOT.length + 1);
      return (
        rel === "dispatch.ts" ||
        rel === "dispatch-types.ts" ||
        rel.startsWith("dispatch-rules/")
      );
    });

    expect(files.length).toBeGreaterThan(0); // smoke

    const violations: string[] = [];
    for (const f of files) {
      const content = await readFile(f, "utf8");
      for (const { token, source } of FORBIDDEN_TOKENS) {
        // Word-boundary match — `\b` doesn't quite catch `_` correctly,
        // so we use a custom boundary: preceded/followed by something
        // that is not [A-Za-z0-9_].
        const pattern = new RegExp(
          `(^|[^A-Za-z0-9_])${escapeRe(token)}(?=$|[^A-Za-z0-9_])`,
          "g",
        );
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i]!)) {
            violations.push(
              `${f}:${i + 1}  ${lines[i]!.trim()}  (forbidden token "${token}" from ${source})`,
            );
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `dispatch-audit: ${violations.length} forbidden-token violations:\n` +
          violations.join("\n"),
      );
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
