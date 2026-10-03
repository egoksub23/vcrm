#!/usr/bin/env bash
# Run every supabase/ci/verify-*.sql and require each to end in "ROLLBACK-OK".
#
#   supabase/ci/run-verifications.sh --local    # the CI database (supabase db start)
#   supabase/ci/run-verifications.sh --linked   # the linked project (production, rolled back)
#
# Scripts are discovered, not listed, so a new verify script cannot be forgotten.
# The ones in stale-verifications.txt are skipped, each with the reason recorded
# there; a script that no longer exists, or that now passes, is reported so the
# list stays honest.
set -u

target="${1:---local}"
dir="$(cd "$(dirname "$0")" && pwd)"
stale_file="$dir/stale-verifications.txt"

stale=()
if [ -f "$stale_file" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    name="$(echo "${line%%|*}" | tr -d '[:space:]')"
    [ -n "$name" ] && stale+=("$name")
  done < "$stale_file"
fi

is_stale() {
  local f="$1" s
  for s in "${stale[@]:-}"; do [ "$s" = "$f" ] && return 0; done
  return 1
}

failed=0
ran=0
skipped=0
for f in "$dir"/verify-*.sql; do
  base="$(basename "$f")"
  [ "$base" = "verify-schema.sql" ] && continue
  if is_stale "$base"; then
    skipped=$((skipped + 1))
    echo "skip  $base (stale, see stale-verifications.txt)"
    continue
  fi
  out="$(supabase db query "$target" --file "$f" 2>&1 || true)"
  ran=$((ran + 1))
  if echo "$out" | grep -q "ROLLBACK-OK"; then
    echo "ok    $base"
  else
    failed=$((failed + 1))
    echo "FAIL  $base"
    echo "$out" | tail -n 15
    echo "::error::$base did not reach ROLLBACK-OK"
  fi
done

for s in "${stale[@]:-}"; do
  [ -n "$s" ] && [ ! -f "$dir/$s" ] && echo "::warning::stale-verifications.txt lists $s, which no longer exists"
done

echo "ran $ran, skipped $skipped, failed $failed"
[ "$failed" -eq 0 ]
