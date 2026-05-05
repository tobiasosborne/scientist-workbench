#!/usr/bin/env bash
# Generic golden-master runner. Drives a candidate solution executable
# through every case in golden/inputs.json and pipes (input, candidate)
# into golden/verify.py.
#
# The candidate executable must:
#   - read one JSON object on stdin (the `input` field of one test case)
#   - write one JSON value on stdout (the candidate output)
#   - exit 0 on success; non-zero is treated as a failed case
#
# Usage:
#   infra/verifiers/run_tests.sh <problem-dir> <candidate-cmd...>
#
# Examples:
#   # TS solution compiled to JS:
#   infra/verifiers/run_tests.sh problems/01-fft node solution.js
#
#   # tsx, no compile step:
#   infra/verifiers/run_tests.sh problems/01-fft npx tsx solution.ts
#
#   # The reference implementation, for sanity:
#   infra/verifiers/run_tests.sh problems/01-fft python3 problems/01-fft/reference/fft_reference.py
#
# The script prints one line per case plus a per-check summary. Exits 1 if
# any case fails. Payloads of any size are supported (uses temp files so
# nothing goes through ARG_MAX-limited command lines).
#
# Requires: jq, python3, plus whatever runs the candidate.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <problem-dir> <candidate-cmd...>" >&2
  exit 2
fi

PROBLEM_DIR="$1"; shift
CANDIDATE_CMD=("$@")

INPUTS="${PROBLEM_DIR}/golden/inputs.json"
VERIFY="${PROBLEM_DIR}/golden/verify.py"

if [[ ! -f "$INPUTS" ]]; then
  echo "missing $INPUTS" >&2; exit 2
fi
if [[ ! -f "$VERIFY" ]]; then
  echo "missing $VERIFY" >&2; exit 2
fi

INPUT_FILE=$(mktemp)
CANDIDATE_FILE=$(mktemp)
PAYLOAD_FILE=$(mktemp)
RESULT_FILE=$(mktemp)
trap 'rm -f "$INPUT_FILE" "$CANDIDATE_FILE" "$PAYLOAD_FILE" "$RESULT_FILE"' EXIT

n_cases=$(jq '.cases | length' "$INPUTS")
echo "running $n_cases cases through ${CANDIDATE_CMD[*]}"

failures=0
declare -A check_total
declare -A check_pass

for ((i = 0; i < n_cases; i++)); do
  case_id=$(jq -r ".cases[$i].id" "$INPUTS")

  # Write input to temp file (avoids ARG_MAX on stress cases ~ MB-scale).
  jq -c ".cases[$i].input" "$INPUTS" > "$INPUT_FILE"

  # Run candidate command, stdin from input file, stdout to candidate file.
  if ! "${CANDIDATE_CMD[@]}" < "$INPUT_FILE" > "$CANDIDATE_FILE" 2>/dev/null; then
    echo "  FAIL  $case_id: candidate command exited non-zero"
    failures=$((failures+1))
    continue
  fi

  # Build {input, candidate, id} payload via slurpfile (no command-line size limit).
  jq -n -c \
    --slurpfile input "$INPUT_FILE" \
    --slurpfile candidate "$CANDIDATE_FILE" \
    --arg id "$case_id" \
    '{input: $input[0], candidate: $candidate[0], id: $id}' > "$PAYLOAD_FILE"

  python3 "$VERIFY" < "$PAYLOAD_FILE" > "$RESULT_FILE"

  pass=$(jq -r '.pass' "$RESULT_FILE")
  reason=$(jq -r '.reason' "$RESULT_FILE")

  while IFS=$'\t' read -r cname cpass; do
    check_total[$cname]=$((${check_total[$cname]:-0}+1))
    if [[ "$cpass" == "true" ]]; then
      check_pass[$cname]=$((${check_pass[$cname]:-0}+1))
    fi
  done < <(jq -r '.checks | to_entries[] | "\(.key)\t\(.value.pass)"' "$RESULT_FILE")

  if [[ "$pass" == "true" ]]; then
    echo "  pass  $case_id"
  else
    echo "  FAIL  $case_id: $reason"
    failures=$((failures+1))
  fi
done

echo
echo "Per-check summary:"
for cname in "${!check_total[@]}"; do
  printf "  %-12s  %d/%d\n" "$cname" "${check_pass[$cname]:-0}" "${check_total[$cname]}"
done

echo
if [[ $failures -gt 0 ]]; then
  echo "$failures / $n_cases cases FAILED"
  exit 1
fi
echo "all $n_cases cases green"
