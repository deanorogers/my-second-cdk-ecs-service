#!/usr/bin/env bash
# Usage: hit-accounts.sh <requests> <sleep_ms> <concurrency>
# Sends <requests> GETs to the accounts endpoint, with <concurrency> workers in parallel,
# each sleeping <sleep_ms> milliseconds between its own requests.
set -euo pipefail

URL="${URL:-http://internal-AlbSta-Alb16-9yLkoaMDqZk8-359659771.us-east-1.elb.amazonaws.com:80/accounts}"

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <requests> <sleep_ms> <concurrency>" >&2
  exit 1
fi

requests=$1
sleep_ms=$2
concurrency=$3

if ! [[ $requests =~ ^[1-9][0-9]*$ && $concurrency =~ ^[1-9][0-9]*$ ]]; then
  echo "requests and concurrency must be positive integers" >&2
  exit 1
fi
if ! [[ $sleep_ms =~ ^[0-9]+$ ]]; then
  echo "sleep_ms must be a non-negative integer" >&2
  exit 1
fi

sleep_s=$(printf '%d.%03d' $((sleep_ms / 1000)) $((sleep_ms % 1000)))

worker() {
  local id=$1 count=$2 i out status body failed
  for ((i = 1; i <= count; i++)); do
    # Status/timing goes to stderr so stdout is only the body (pipe-friendly, e.g. into jq).
    failed=""
    out=$(curl -s -w '\n%{http_code} %{time_total}s' "$URL") || failed=" (curl failed)"
    status=${out##*$'\n'}$failed
    body=${out%$'\n'*}
    printf 'worker=%s req=%s status=%s\n' "$id" "$i" "$status" >&2
    printf '%s\n' "$body"
    if ((i < count)); then sleep "$sleep_s"; fi
  done
}

# Spread requests across workers; the first (requests % concurrency) workers take one extra.
base=$((requests / concurrency))
extra=$((requests % concurrency))
pids=()
for ((w = 1; w <= concurrency; w++)); do
  count=$base
  if ((w <= extra)); then count=$((count + 1)); fi
  if ((count == 0)); then continue; fi
  worker "$w" "$count" &
  pids+=($!)
done

fail=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail=1
done
exit $fail
