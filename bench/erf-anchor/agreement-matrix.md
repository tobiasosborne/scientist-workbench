# bench/erf-anchor — cross-oracle agreement matrix

Generated: 2026-05-16T21:11:43.648Z
Bead: scientist-workbench-68ir (Phase 1 GATE per ADR-0040 §"Decision 10").

## Oracles

| oracle | tier | version | records | ok | refused |
|---|---|---|---|---|---|
| `boost` | silver | 1_83 | 271 | 149 | 122 |
| `mpmath` | gold | 1.3.0 | 271 | 269 | 2 |
| `scipy` | bronze | 1.17.0 | 271 | 271 | 0 |
| `wolfram` | gold | WolframScript 1.13.0 for Linux x86 (64-bit) | 271 | 271 | 0 |

## Summary

Total pairwise comparisons: **813**
- info (agreed within threshold): **467**
- warn (disagreement past threshold): **346**
- error (limit/shape mismatch): **0**

### Per tier-pair

| tier-pair | info | warn | error |
|---|---|---|---|
| gold-gold | 194 | 77 | 0 |
| silver-gold | 273 | 269 | 0 |

## Findings (346)

Each finding is a bead candidate: investigate which oracle is
correct (or whether both are wrong in different ways). Apply
ADR-0040 §"Decision 8" thresholds (gold-vs-gold > 2 digits;
bronze-vs-bronze > 4 ULP; asymmetric refusal always flagged).

| input_id | head | oracle_a | oracle_b | kind | detail |
|---|---|---|---|---|---|
| T2-erfc-017 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T2-erfc-017 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T2-erfc-018 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T2-erfc-018 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T2-erfc-019 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T2-erfc-019 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T2-erfc-020 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T2-erfc-020 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T2-erfc-023 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T2-erfc-023 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T2-erfc-024 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T2-erfc-024 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T2-erfc-025 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T2-erfc-025 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-001 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-001 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-002 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-002 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-003 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-003 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-004 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-004 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-005 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-005 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-006 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-006 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-007 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-007 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-008 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-008 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-009 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-009 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-010 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-010 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-011 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-011 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-012 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-012 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-013 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-013 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-014 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-014 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T3-erfc-015 | Erfc | boost | wolfram | decimal-agree | digits=0 (threshold 46) |
| T3-erfc-015 | Erfc | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-016 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-016 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-017 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-017 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-018 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-018 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-019 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-019 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-020 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-020 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-020 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-021 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-021 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-021 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-022 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-022 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-022 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-023 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-023 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-023 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-024 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-024 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-024 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-025 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-025 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-025 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-026 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-026 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-026 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-027 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-027 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-027 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-028 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-028 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-029 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-029 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erf-029 | Erf | mpmath | wolfram | decimal-agree | digits=0 (threshold 48) |
| T4-erf-030 | Erf | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erf-030 | Erf | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-001 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-001 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-002 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-002 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-003 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-003 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-004 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-004 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-005 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-005 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-006 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-006 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-007 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-007 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-008 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| T4-erfi-008 | Erfi | boost | wolfram | asymmetric-refusal | refused-by boost |
| T4-erfi-009 | Erfi | boost | mpmath | asymmetric-refusal | refused-by boost |
| … | … | … | … | … | (246 more — see agreement-data.json) |
