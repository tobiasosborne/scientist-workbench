# bench/erf-anchor — cross-oracle agreement matrix

Generated: 2026-05-16T21:24:39.379Z
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
- info (agreed within threshold): **805**
- warn (disagreement past threshold): **8**
- error (limit/shape mismatch): **0**

### Per tier-pair

| tier-pair | info | warn | error |
|---|---|---|---|
| gold-gold | 264 | 7 | 0 |
| silver-gold | 541 | 1 | 0 |

## Findings (8)

Each finding is a bead candidate: investigate which oracle is
correct (or whether both are wrong in different ways). Apply
ADR-0040 §"Decision 8" thresholds (gold-vs-gold > 2 digits;
bronze-vs-bronze > 4 ULP; asymmetric refusal always flagged).

| input_id | head | oracle_a | oracle_b | kind | detail |
|---|---|---|---|---|---|
| T5-erf-003 | Erf | mpmath | wolfram | decimal-agree | digits=35 (threshold 48) |
| T5-erf-009 | Erf | mpmath | wolfram | decimal-agree | digits=31 (threshold 48) |
| T5-erf-015 | Erf | mpmath | wolfram | decimal-agree | digits=7 (threshold 48) |
| T5-erfi-034 | Erfi | mpmath | wolfram | decimal-agree | digits=31 (threshold 48) |
| T5-erfi-040 | Erfi | mpmath | wolfram | decimal-agree | digits=21 (threshold 48) |
| T5-erfi-045 | Erfi | mpmath | wolfram | decimal-agree | digits=25 (threshold 48) |
| T8-inverseerfc-018 | InverseErfc | boost | mpmath | decimal-agree | digits=14 (threshold 46) |
| T8-inverseerfc-018 | InverseErfc | mpmath | wolfram | decimal-agree | digits=14 (threshold 48) |
