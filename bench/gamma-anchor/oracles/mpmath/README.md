# mpmath gold-tier oracle — Gamma-anchor adapter (G3)

**Bead:** `scientist-workbench-5x31` (Phase 1 G3 of epic `xqc7`).
**ADR:** [`0042`](../../../../docs/adr/0042-gamma-family-per-head-substrate.md) §"Decision 8" (mpmath = gold tier).
**Research:** [`R5-oracle-landscape.md`](../../../../docs/refs/gamma-research/R5-oracle-landscape.md) §3.2 (mpmath probe) + §6 (landmines L1, L2, L12, L_pole, L_polynew_3).

## What this adapter produces

`results.json` — a parallel-shape manifest of arb-prec golden-master
values for every row of [`../../corpus.json`](../../corpus.json) (377
inputs across 8 tiers × 19 ADMITTED_HEADS), computed with **mpmath
1.3.0** at `mp.dps = 60` and emitted at 60 decimal places via
`mpmath.nstr(_, 60, strip_zeros=False)`.

mpmath sits at the **gold tier** of the R5 oracle hierarchy alongside
Wolfram Mathematica 14.3 and (when installed) Arb / python-flint. mpmath
is the load-bearing open-source voice on the complex-Gamma branch —
without it there is no independent open-source complex arb-prec oracle
to set against Wolfram for the gamma family (no Boost complex; SciPy
1.11.4 raises `TypeError` on complex polygamma; libm covers only real
`tgamma` / `lgamma`).

## Re-running

From the workbench root:

```sh
bun bench/gamma-anchor/oracles/mpmath/adapter.ts
```

Expected wall-time: **~0.3–1 s** on a typical Linux x86_64 desktop.
mpmath warm-batch throughput is ~600–1400 evaluations/second at
`mp.dps = 60` for the gamma family on this corpus (no extreme-magnitude
cells like besselj's `K_{500}(1000)`; the gamma corpus's `T6` tier tops
out at `z = 1000` for LogGamma where Stirling converges in O(1) terms).

A confirmed reference run on the workbench's reference machine:
**0.29 s wall-time**, 377 inputs, 100.00 % honest fraction
(300 success + 57 complex-success + 8 refused (poles) + 12 unsupported).

## Files

- **`adapter.ts`** — Bun-side orchestrator. Reads `corpus.json`, spawns
  `python3 oracle.py`, parses the JSON result blob, merges with corpus
  metadata, writes `results.json`. Uses `Bun.spawn` (NOT
  `node:child_process`).
- **`oracle.py`** — pure-Python mpmath driver. Reads the corpus on
  stdin, emits a JSON list on stdout (element 0 is a `__meta__`
  sentinel; subsequent elements are per-row results). Per-input
  timeout enforced via `SIGALRM` at 30 s.  **Independently
  smoke-testable**:

  ```sh
  python3 -c 'import json; print(json.dumps({"inputs":[{"id":"x","tier":"T1","head":"Gamma","z":"0.5"}]}))' \
    | python3 bench/gamma-anchor/oracles/mpmath/oracle.py
  ```

- **`results.json`** — the output manifest. Schema documented in
  `adapter.ts` top-of-file narrative.

## L12 — the #1 gamma landmine (every adapter must encode)

The incomplete-gamma regularisation convention is the single largest
trap in the family. mpmath's `gammainc(a, z, b, regularized)` is the
flexible swiss-army knife; the four ADMITTED_HEADS map to it as
follows, with every call site in `oracle.py` tagged `# L12`:

| Corpus head            | mpmath call                                             | Math object                          |
| ---------------------- | ------------------------------------------------------- | ------------------------------------ |
| `IncompleteGammaUpper` | `gammainc(a, z, mp.inf, regularized=False)`             | `Γ(a, z)` upper unregularised        |
| `IncompleteGammaLower` | `gammainc(a, 0, z,    regularized=False)`               | `γ(a, z)` lower unregularised        |
| `IncompleteGammaP`     | `gammainc(a, 0, z,    regularized=True)`                | `P(a, z) = γ(a,z)/Γ(a)`              |
| `IncompleteGammaQ`     | `gammainc(a, z, mp.inf, regularized=True)`              | `Q(a, z) = Γ(a,z)/Γ(a)`              |

**SciPy reverses Upper/P** (`sp.gammainc(a, z)` returns P, not Γ). Our
SciPy adapter (G4) must also tag `# L12` everywhere. The corpus emits
all four heads as distinct input records so the comparator can
cross-check the identities `P + Q = 1` and `Lower + Upper = Γ(a)`
independently of the closed-form values.

## The 60-dps-compute / 60-dp-emit policy

Per the bead-prompt directive + R5 §3.2 + the corpus's
`expected_decimals_per_value: 60`:

- **`mp.dps = 60` for compute.** The 10-dp guard above the 50-dp gold
  target absorbs mpmath's per-algorithm internal precision bumps for
  near-boundary inputs: Stirling-shift near integers; CF stagnation in
  the Temme saddle region (`T7`); cot reflection at digamma negative-z
  near integers (`T8`).
- **`mpmath.nstr(v, 60, strip_zeros=False)` for emit.** Full working
  precision on emit (not 55 dp as the besselj adapter did) because the
  bead prompt explicitly directs "emit at 60dp" and the corpus's wire
  contract is 60 dp. The G8 cross-agreement comparator handles the
  **L2** mpmath-round-to-nearest vs Wolfram-truncate mismatch by
  comparing at `precision − 1` decimals.

## Status taxonomy

| Status                | Meaning                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `success`             | mpmath returned a finite real `mpf`. `value` is a 60-dp decimal string.                     |
| `complex-success`     | mpmath returned an `mpc`. Two sources: (a) T4 cells with complex inputs; (b) real-input cells whose analytic continuation is complex (`LogGamma` at real negative non-integer; `LogBeta` ditto). |
| `refused`             | Pole hit (**L_pole** / **L17**). mpmath raised an exception (`ValueError("gamma function pole")`, `ValueError("polygamma pole")`, or `ZeroDivisionError` for `polygamma(m, 0)` m≥1). `mpmath_returned_token` records the verbatim exception payload. The G8 comparator special-cases pole cells — does not penalise diverging oracle behaviour at exact poles (Wolfram emits `ComplexInfinity`; SciPy emits `+∞`; libm emits NaN; mpmath raises). |
| `unsupported`         | `InverseIncompleteGamma{P,Q}` cells. mpmath has no native function; R5 §3.2 documents a `findroot` workaround that is non-byte-deterministic. Honest refusal beats a wrong-shaped answer. |
| `timeout`             | Per-input wall-time exceeded `PER_INPUT_TIMEOUT_S = 30 s`. Not observed on the v0.1 gamma corpus. |
| `error`               | Unhandled exception. Not observed on the v0.1 gamma corpus.                                 |

The G8 cross-agreement comparator treats `success` and `complex-success`
as agreement-eligible; `refused` and `unsupported` are recorded for the
audit trail but excluded from the inter-oracle ULP-distance computation
on those rows.

## Landmines handled

- **L1** (Wolfram input-trap; carry from R5 §6). The corpus's
  discriminated `{kind, value}` envelope on `a`, `b`, `m`, `n` lets us
  parse exactly: integers → Python `int`; half-integers →
  `mpf(num)/mpf(den)` (EXACT at any precision); decimals →
  `mpf(<60-dp string>)`. We NEVER use Python `float()`.
- **L2** (mpmath nstr round-to-nearest vs Wolfram N truncate).
  Emit-precision matches compute-precision (60 dp); G8 comparator
  canonicalises at `precision − 1` decimals.
- **L12** (P/Q inversion). Spelt out per-head with `# L12` tags above.
- **L_pole** (gamma-poles family). All exception-style poles
  (`ValueError("gamma function pole")`, `ValueError("polygamma pole")`,
  `ZeroDivisionError` from `polygamma(m, 0)` m≥1) translate to
  `status: "refused"` with the verbatim exception payload in
  `mpmath_returned_token`. **BarnesG is NOT a pole** at non-positive
  integers — `mp.barnesg(0) = mp.barnesg(-k) = 0` is the correct
  value per DLMF §5.17.1 (G(z+1) = Γ(z)·G(z) with G(1)=1 forces
  G(0) = G(-1) = ... = 0).
- **L_polynew_3** (BarnesG convention disagreement). mpmath uses the
  Vardi-Quine convention; ADR-0042 canonical is Adamchik (Wolfram's).
  We emit mpmath's value VERBATIM and let the G8 comparator
  canonicalise. **This is a pinned disagreement, not a bug.** The
  comparator's BarnesG-specific rule applies the Adamchik–Vardi-Quine
  constant offset before computing the ULP-distance.
- **L15** (SciPy `loggamma(real_negative) → NaN`). Doesn't apply to
  mpmath — `mpmath.loggamma(real_negative)` returns the analytic
  continuation with imaginary part `-π·k` (k = floor of input);
  surfaces as `complex-success` in this adapter.
- **InverseIncompleteGamma{P,Q}**: honest `unsupported` refusal per
  R5 §3.2. The bead prompt directs this explicitly — never silently
  substitute a findroot result.

## Reference-machine spot-checks

```text
Gamma(1/2)   = 1.77245385090551602729816748334114518279754945612238712821381  (60 dp)
             ≈ √π                                                              (R5 §8.2, DLMF §5.4.1)
digamma(1)   = -0.577215664901532860606512090082402431042159335939923598805767 (60 dp)
             = -γ (Euler-Mascheroni constant)                                  (DLMF §5.4.12)
P(3/2, 5/2)  = 0.828202855703266864936393347816948500210901763194030637750441  (60 dp)
             = γ(3/2, 5/2) / Γ(3/2)                                            (R5 §3.2 line 353)
Γ(3/2, 5/2)  = 0.152251254991657627635403712624832257862424837713894019933188  (60 dp)
             = upper unregularised                                             (R5 §3.2 line 350)
Pochhammer(3/2, 3) = 13.125                                                    (R5 §3.2 line 347)
BarnesG(5)   = 12                                                              (R5 §6 L16: G(5)=12)
Beta(1/2, 1/2) = π                                                             (DLMF §5.12.1)
```

## Determinism contract

mpmath is bit-identical across CPython runtimes by construction
(Python `int` arithmetic is bit-identical by language spec; mpmath's
`mpf` layer is pure-Python over `int`). Two runs of this adapter with
byte-identical `corpus.json` + the same mpmath / python3 versions
produce **byte-identical `results` arrays**. The fields that DO change
between runs are `generated_at`, `total_elapsed_ms`, and per-row
`elapsed_ms` — timing metadata, not oracle outputs.

If you need a strict diff:

```sh
jq '{results: [.results[] | {input_id, status, value, mpmath_returned_token, notes}]}' results.json \
  > /tmp/results-canonical.json
# then diff /tmp/results-canonical.json across runs
```

## Oracle metadata schema

```json
{
  "oracle_id": "mpmath",
  "oracle_version": "mpmath 1.3.0 / Python 3.12.3",
  "python_version": "3.12.3 (main, ...)",
  "tier": "gold",
  "precision_decimals_compute": 60,
  "precision_decimals_emit": 60,
  "per_input_timeout_s": 30,
  "corpus_seed": 20260519,
  "corpus_bead": "scientist-workbench-0kq3",
  "corpus_adr": "0042",
  ...
}
```

This is the schema the G8 cross-agreement comparator
(`bench/gamma-anchor/cross-agreement.ts`) expects from every oracle
adapter — see ADR-0042 §"Decision 8" for the inter-adapter contract.
