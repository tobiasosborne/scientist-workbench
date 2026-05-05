# Numerical-tier n-ceiling measurement

Run on: linux x64, Bun 1.3.0
Date: 2026-05-05T06:31:02.419Z

| algo | n | wall-clock (s) | RSS delta (MB) | peak RSS (MB) | status |
|---|---|---|---|---|---|
| qr | 100 | 0.0541 | 2.4 | 62 | ok |
| qr | 200 | 0.18 | 2.9 | 65 | ok |
| qr | 500 | 2.56 | 6.0 | 71 | ok |
| qr | 1000 | 25.0 | 31.3 | 102 | ok |
| qr | 2000 | 535.2 | 92.1 | 194 | ok: over budget (>120000ms) |
| qr | 5000 | — | — | — | skipped (prior over-budget) |
| svd | 100 | 0.17 | 7.9 | 202 | ok |
| svd | 200 | 0.58 | 0.5 | 202 | ok |
| svd | 500 | 17.6 | 4.1 | 206 | ok |
| svd | 1000 | 209.7 | 34.5 | 241 | ok: over budget (>120000ms) |
| svd | 2000 | — | — | — | skipped (prior over-budget) |
| svd | 5000 | — | — | — | skipped (prior over-budget) |

Notes:
- "RSS delta" is the RSS growth from baseline to post-call (after GC).
- "peak RSS" is the max RSS observed during the call.
- Phones run ~3× slower than dev box (rough rule of thumb for ARM cores
  vs x86 desktop).
- Memory matters more on phone: most browser tabs cap at 1-2 GB.
