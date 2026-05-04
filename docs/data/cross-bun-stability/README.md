# Cross-Bun-version stability corpus

Forcing-experiment data underpinning **ADR-0015** (the determinism-tier
ADR). Bead [scientist-workbench-0ck](../../adr/0015-determinism-tier.md)
asked: before drafting, run the linalg-solve corpus under multiple Bun
versions on the same machine and record what diverges.

## Method

The script `scripts/measure-cross-bun-stability.ts` builds a 100-case
corpus (Hilbert(2..7), Wilkinson(2..8), 87 random diagonally-dominant
matrices of size 2..30) and emits one
`<case_id>\t<input_hash>\t<output_hash>` line per case. Same script,
two Bun binaries:

```sh
~/.bun-1.2.21/bin/bun scripts/measure-cross-bun-stability.ts \
  > docs/data/cross-bun-stability/linalg-solve-corpus-bun-1.2.21.tsv
~/.bun/bin/bun        scripts/measure-cross-bun-stability.ts \
  > docs/data/cross-bun-stability/linalg-solve-corpus-bun-1.3.13.tsv
diff <(grep -v '^#' linalg-solve-corpus-bun-1.2.21.tsv) \
     <(grep -v '^#' linalg-solve-corpus-bun-1.3.13.tsv)
```

The diff is empty.

## Result

**100 of 100 cases produce byte-identical output hashes** between Bun
1.2.21 (released ~2026-Q1) and Bun 1.3.13 (current at measurement time,
2026-05-04). Both runs on the same hardware:
`linux-x86_64-WSL2-glibc`.

The corpus deliberately exercises adversarial inputs:

- **Hilbert(7)** — condition number ~3·10⁸; the canonical "tickle the
  rounding mode" stress family. If `Math.sqrt`, division ordering, or
  any IEEE-754 op differed in JSC across Bun versions, this would have
  been the first case to break.
- **Wilkinson(8)** — pivot growth factor 2⁷ = 128; exercises maximal
  partial-pivoting stress.
- **87 random matrices**, sizes 2..30, deterministic seeds — wide
  routine coverage.

## What this rules in

- The single-platform-stability hypothesis from ADR-0014's forcing-
  question (1) holds at the byte level, even on adversarial inputs.
- A platform fingerprint that *includes* `runtime_version` would generate
  spurious cache misses on Bun upgrades for zero correctness benefit.

## What this does *not* yet rule on

- **Cross-architecture** (linux-x86_64 vs darwin-aarch64): not measured.
  This is where libm and JSC build differences plausibly bite.
  Filed as a follow-up bead.
- **Cross-OS at same arch** (linux-x86_64 vs win32-x86_64): not
  measured. Lower priority — same hardware ISA.
- **Cross-engine** (Bun-on-JSC vs Node-on-V8): a different question,
  out of scope for ADR-0015.

## Pointers

- `scripts/measure-cross-bun-stability.ts` — the measurement script.
- `docs/adr/0015-determinism-tier.md` — the ADR this data informs.
- `docs/adr/0014-first-numerical-tier.md` §"Forcing-questions" — the
  precursor that named this experiment.
- `docs/worklog/036-determinism-tier.md` — iteration log.
