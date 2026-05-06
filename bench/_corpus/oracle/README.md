# bench/_corpus/oracle — solve-epic golden-master oracle infrastructure

Per **ADR-0019** (`docs/adr/0019-solve-bench-discipline.md`), every
solve-tier bench admits a golden case iff at least two of three
oracles (Wolfram, SymPy, SageMath) agree on the answer modulo the
verifier's mathematical-invariant equivalence relation. This package
implements the oracle stack and the per-kind agreement layer.

The agreement layer is **load-bearing**: a layer that false-positives
silently corrupts the entire epic's golden infrastructure. The
self-test suite (`test_oracle_agreement.py`) is brutally adversarial
on purpose — 30+ cases covering every documented failure mode of the
agreement comparators, including hand-constructed wrong-answer cases
that MUST trigger disagreement.

## Files

- `wolfram.py` — `wolfram_query(code, timeout)` subprocess wrapper +
  `parse_solution_set(input_form)` parser for `{{x -> 2, y -> 3}, ...}`
  output. Robust to nested brackets in algebraic-number values
  (`Sqrt[2]`, `Root[#1^5 - #1 - 1 &, 1]`, etc.).
- `sympy_bridge.py` — `sympy_query(operation, *args, timeout)`
  uniform invocation. Operations: `solve`, `factor`, `real_roots`,
  `groebner`, `is_irreducible`. Catches `NotImplementedError`,
  `PolynomialError`, timeouts; returns the same status envelope as
  `wolfram_query`.
- `agreement.py` — `agree(a, b, kind, **ctx)` per-kind comparator.
  Kinds: `solve`, `factor-list`, `real-roots`, `groebner-basis`,
  `is-irreducible`, `refusal`. Comparison is via verifier invariants
  (substitute, simplify, equate; bidirectional ideal containment;
  bipartite interval matching), never byte-equality.
- `test_oracle_agreement.py` — pytest self-tests, 9 categories.

## Status envelope (uniform)

```python
{'status': 'ok',      'result': <oracle-specific>}
{'status': 'failed',  'reason': <str>}      # oracle refused (e.g. $Failed)
{'status': 'timeout', 'reason': <str>}      # exceeded budget
{'status': 'error',   'reason': <str>}      # malformed query / wrapper bug
```

`agree(a, b, 'refusal')` returns True iff both have non-`ok` status
(class-of-refusal does not have to match). For all other kinds, both
must be `ok` AND the comparator must say agreement holds.

## Running

```sh
cd bench/_corpus/oracle
python3 -m pytest -v                       # full suite (~ 30 + 6 live)
WB_LIVE_ORACLE=0 python3 -m pytest -v      # skip live Wolfram tests
python3 -m pytest -v -k disagree           # mathematical-disagreement subset
python3 -m pytest -v -m live_oracle        # only live-Wolfram tests
```

## When to update this

- A new oracle kind (e.g., `algebraic-number-equivalence` for P3-3
  bench) is added: extend `_DISPATCH` in `agreement.py`, add ≥ 5
  self-tests for the kind including ≥ 1 mathematical-disagreement
  case.
- A representation drift between Wolfram and SymPy is observed in
  practice: add the drift case to Category 2 (passes) AND the
  hand-constructed wrong-but-similar case to Category 4 (fails).
- The `parse_solution_set` parser hits an InputForm shape it doesn't
  handle: add the shape to Category 8 with a unit test.

## Coverage at land time (2026-05-06)

| Category | Tests | Purpose |
|---|---|---|
| 1. sanity | 5 | trivial agreement on identical forms |
| 2. drift | 4 | same answer, different surface form |
| 3. refusal | 3 | both oracles refused; class need not match |
| 4. disagreement | 9 | wrong answers MUST be detected |
| 5. one-only | 3 | one ok / one failed → not agreement |
| 6. adversarial | 5 | hand-constructed near-misses |
| 7. edge | 5 | empty solutions, repeated roots, no real roots |
| 8. parser | 8 | wolfram InputForm parser unit tests |
| 9. live | 6 | end-to-end Wolfram-kernel smoke tests |
| **Total** | **48** | |

The Category-4 cases are the strict mutation-prove of the agreement
layer per ADR-0019 §4. Removing any of them and re-running the suite
must NOT make the suite green — every test in Category 4 catches a
specific class of agreement-layer false-positive.
