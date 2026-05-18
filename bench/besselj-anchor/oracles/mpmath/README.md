# mpmath gold-tier oracle — Bessel-anchor adapter (G3)

**Bead:** `scientist-workbench-g70g` (Phase 1 G3 of epic `zcam`).
**ADR:** [`0041`](../../../../docs/adr/0041-bessel-family-per-head-substrate.md) §"Decision 8" (mpmath = gold tier).
**Research:** [`R5-oracle-landscape.md`](../../../../docs/refs/besselj-research/R5-oracle-landscape.md) §2 + §3.2 (mpmath probe + L2 rounding landmine).

## What this adapter produces

`results.json` — a parallel-shape manifest of arb-prec golden-master values
for every row of [`../../corpus.json`](../../corpus.json) (1766 inputs
across 10 tiers × 6 heads × 3 ν-classes), computed with **mpmath 1.3.0** at
`mp.dps = 60` and emitted at 55 decimal places via
`mpmath.nstr(_, 55, strip_zeros=False)`.

mpmath sits at the **gold tier** of the R5 oracle hierarchy alongside
Wolfram Mathematica 14.3 and (when installed) Arb / python-flint. The
three-way agreement of (Wolfram + mpmath + Arb) is the cross-validation
baseline the V1 verification gate rests on. mpmath is the load-bearing
open-source voice on the complex-Bessel branch — without it there is no
independent open-source complex arb-prec oracle to set against Wolfram.

## Re-running

From the workbench root:

```sh
bun bench/besselj-anchor/oracles/mpmath/adapter.ts
```

Expected wall-time: **~1–3 minutes** on a typical Linux x86_64 desktop.
mpmath warm-batch throughput is ~200–600 evaluations/second at 60 dps
for typical inputs (R5 §3.2). The long-tail large-|z|/large-ν inputs in
the T3/T7/T10 tiers add 5–60 s; one input (`T7-besselk-020`:
`K_{500}(1000)`) reliably exceeds the per-input 30 s timeout — see the
"What gets timed out" section below.

A confirmed reference run on the workbench's reference machine:
**108 s wall-time**, 1766 inputs, 99.94 % success
(1601 real + 128 complex + 36 honest-special-token; 1 timeout).

## Files

- **`adapter.ts`** — Bun-side orchestrator. Reads `corpus.json`, spawns
  `python3 oracle.py`, parses the JSON result blob, merges with corpus
  metadata, writes `results.json`. Uses `Bun.spawn` (NOT
  `node:child_process` — sanity rail from the bead prompt).
- **`oracle.py`** — pure-Python mpmath driver. Reads the corpus on stdin,
  emits a JSON list on stdout (element 0 is a `__meta__` sentinel
  carrying `mpmath.__version__` / `sys.version`; subsequent elements
  are per-row results). Per-input timeout enforced via `SIGALRM` at
  30 s. **Independently smoke-testable**:

  ```sh
  python3 -c 'import json; print(json.dumps({"inputs":[{"id":"x","tier":"T1","head":"BesselJ","nu_kind":"integer","nu":"3","z":"2.0"}]}))' \
    | python3 bench/besselj-anchor/oracles/mpmath/oracle.py
  ```

- **`results.json`** — the output manifest. Schema documented in
  `adapter.ts` top-of-file narrative.

## Why a sibling `.py` file and not an inline string?

`oracle.py` is ~280 LOC of literate Python: corpus parsing, 6-head
dispatch, special-token classifier for IEEE sentinels (NaN, ±∞), and
the per-input `SIGALRM` timeout. Inlining it as a template literal in
`adapter.ts` would (a) break syntax-highlighting and lint discipline
for the Python; (b) hide the SIGALRM logic behind escape-sequences; (c)
cost ~30 % of TS file length for content no TS reader cares about; (d)
break the independent-testability rule above. The Erf G3 adapter (the
styling exemplar) inlined because Erf's Python was 130 LOC and had no
SIGALRM logic.

## The 60-dps-compute / 55-dp-emit margin

Per ADR-0041 §"Decision 8" + R5 §3.2 (**landmine L2**):

- **`mp.dps = 60` for compute.** The 10-dp guard above the 50-dp gold
  target absorbs mpmath's per-algorithm internal precision bumps for
  near-boundary inputs: the Hankel-asymptotic crossover at `|z| ≈ p/2`
  (R2 §3.1), the negative-ν branch's `cos(ν π)` cancellation
  (ADR-0041 §"Decision 13" / R5 L3), and the integer-vs-near-integer-ν
  jump (R5 L8).
- **`mpmath.nstr(v, 55, strip_zeros=False)` for emit.** The 5-dp margin
  below the working precision strips the 2–3 trailing digits that
  mpmath's `nstr` round-to-nearest emits as numerical residue. mpmath
  rounds-to-nearest while Wolfram `N[]` **truncates** — the 5-dp
  canonicalisation window lets the G8 cross-agreement comparator
  compare Wolfram-55 to mpmath-55 byte-for-byte without false-positives
  from the rounding-mode mismatch.

## Status taxonomy

| Status                    | Meaning                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `success`                 | mpmath returned a finite real `mpf`. `value` is a 55-dp decimal string.                     |
| `complex-success`         | mpmath returned an `mpc` (typically negative-real-z crossing the branch cut: `Y(0, -1)`, `K(0, -1)`). `value` is `{re, im}`. |
| `honest-special-token`    | Input z is `NaN` / `±Infinity` (T6 tier). mpmath would raise on these; we emit the well-defined IEEE limit with a `notes` annotation. |
| `timeout`                 | Per-input wall-time exceeded `PER_INPUT_TIMEOUT_S = 30 s`.                                  |
| `error`                   | mpmath raised an unhandled exception. `notes` carries `type(e).__name__: str(e)`.           |
| `refused`                 | Reserved; not emitted by mpmath (mpmath has full coverage of the corpus heads).             |

The G8 cross-agreement comparator treats `success` and `complex-success`
as the canonical agreement-eligible status; `honest-special-token`
agreement is checked carry-through (every gold-tier oracle should return
the same IEEE-754 token for `J(0, NaN)` etc.); `timeout` and `error` are
recorded but excluded from the inter-oracle ULP-distance computation.

## Landmines handled

- **L2** (mpmath round-to-nearest vs Wolfram truncate) — 60-dp compute /
  55-dp emit canonicalisation window. See "margin" section above.
- **L3** (negative-real-ν branch convention varies per oracle) — we emit
  exactly what mpmath returns; the G8 comparator tolerates documented
  per-oracle convention deltas at `info` severity.
- **L9 / L10** (K underflow / I overflow at large `|z|`) — mpmath's
  BigInt mantissa handles the full range; the risk is time, not value.
  Per-input 30 s timeout catches the long-tail cases.
- **mpmath edge-case exception** — `mpmath.besselj(0, mpf('inf'))` and
  `mpmath.besselj(0, mpf('nan'))` raise `TypeError` / `ValueError` rather
  than returning a finite mpf. We short-circuit these inputs to the
  well-defined IEEE-754 limit via the `classify_special_token` helper
  in `oracle.py` before invoking mpmath.

## What gets timed out

The single per-input timeout in the v0.1 reference corpus run is:

| input_id          | head     | ν   | z     | notes                                                                              |
| ----------------- | -------- | --- | ----- | ---------------------------------------------------------------------------------- |
| `T7-besselk-020`  | BesselK  | 500 | 1000  | High-ν Debye regime. mpmath's classical-dispatch ₀F₁ + Hankel takes >30 s for the |
|                   |          |     |       | extreme cancellation here. Use the **`BesselKScaled` corpus rows** at large `|z|`  |
|                   |          |     |       | for the answer in this regime — they're cross-validated against Wolfram + Arb at  |
|                   |          |     |       | full precision and ship the dominant `e^{z}` factor as a flag (R3 §0.0).          |

This is **expected behaviour**, not a bug — it's exactly the case the
30 s budget was designed to catch (R5 §6 L9/L10 + the bead prompt
"mpmath may take seconds per call for very-large-z; emit `status:
'timeout'` if exceeded"). 1765 / 1766 = 99.94 % success.

## Determinism contract

mpmath is bit-identical across CPython runtimes by construction (Python
`int` arithmetic is bit-identical by language spec; mpmath's `mpf` layer
is pure-Python over `int`). Two runs of this adapter with byte-identical
`corpus.json` + the same mpmath / python3 versions produce **byte-identical
`results` arrays** (verified on the reference machine). The fields that
DO change between runs are `generated_at` (ISO-8601 wall-clock at run
start), `total_elapsed_ms`, and per-row `elapsed_ms` — these are timing
metadata, not oracle outputs.

If you need a strict diff:

```sh
jq '{results: [.results[] | {input_id, status, value, notes}]}' results.json \
  > /tmp/results-canonical.json
# then diff /tmp/results-canonical.json across runs
```

## Oracle metadata schema

Each `results.json` envelope carries the oracle's identity for the G8
comparator's audit trail:

```json
{
  "oracle_id": "mpmath",
  "oracle_version": "mpmath 1.3.0 / Python 3.12.3",
  "python_version": "3.12.3 (main, Mar 23 2026, 19:04:32) [GCC 13.3.0]",
  "tier": "gold",
  "precision_decimals_compute": 60,
  "precision_decimals_emit": 55,
  "per_input_timeout_s": 30,
  "corpus_seed": 20260517,
  "corpus_bead": "scientist-workbench-qccc",
  "corpus_adr": "0041",
  ...
}
```

This is the schema the G8 cross-agreement comparator
(`bench/besselj-anchor/cross-agreement.ts`, bead `scientist-workbench-s2n1`)
expects from every oracle adapter — see ADR-0041 §"Decision 8" for the
inter-adapter contract.
