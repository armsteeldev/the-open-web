#!/usr/bin/env bash

wait_for_health() {
  local endpoint=$1 attempts=${2:-60} attempt response
  for ((attempt=1; attempt<=attempts; attempt++)); do
    if response=$(curl --fail --silent --max-time 2 "$endpoint" 2>/dev/null) &&
       printf '%s' "$response" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_manifest() {
  local endpoint=$1 expected=$2 attempts=${3:-60} attempt response
  for ((attempt=1; attempt<=attempts; attempt++)); do
    if response=$(curl --fail --silent --max-time 3 "$endpoint" 2>/dev/null) && [[ $response == "$expected" ]]; then return 0; fi
    sleep 1
  done
  return 1
}

wait_for_runtime_release() {
  local expected=$1 attempts=${2:-60} attempt pid runtime_dir
  for ((attempt=1; attempt<=attempts; attempt++)); do
    pid=$(systemctl show -p MainPID --value the-open-web 2>/dev/null || true)
    if [[ $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/cwd ]]; then
      runtime_dir=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
      if [[ $runtime_dir == "$expected" ]]; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

# Restore only the expected just-activated release, and report success only after
# systemd, the process working directory, local/public health, and public manifest agree.
require_rollback_compatibility() {
  local candidate_release=$1 previous_release=$2
  local bottle_schema_fingerprint=990f41588a6c25778e5d2f1d5ba475da8797298021b429e354929c6b509be47e
  local migration_file=$candidate_release/dist/database/migrations/004_bottle_messages.sql
  local previous_database_code=$previous_release/dist/apps/server/src/db.js

  [[ ! -f $migration_file ]] && return 0
  if [[ ! -f $previous_database_code ]] || ! grep -Fq "$bottle_schema_fingerprint" "$previous_database_code"; then
    printf 'Release requires Bottle migration 004, but the current release cannot validate that schema on rollback. Deploy the compatibility bridge first.\n' >&2
    return 1
  fi
}

recover_release() {
  local root=$1 current=$2 failed_release=$3 target_release=$4 local_health=$5
  local public_health=$6 public_manifest=$7 expected_manifest=$8 attempts=${9:-60}
  local link=$root/.current.recovery.$$
  local current_target

  current_target=$(readlink -f "$current" 2>/dev/null || true)
  if [[ $current_target != "$failed_release" ]]; then
    printf 'Recovery refused: current target is %s, expected %s.\n' "${current_target:-missing}" "$failed_release" >&2
    return 1
  fi
  if [[ -e $link || -L $link ]]; then
    printf 'Recovery refused a stale temporary link: %s.\n' "$link" >&2
    return 1
  fi
  if ! ln -s "$target_release" "$link"; then
    printf 'Recovery could not prepare a link to %s.\n' "$target_release" >&2
    return 1
  fi
  if ! mv -Tf "$link" "$current"; then
    rm -f -- "$link"
    printf 'Recovery could not switch to %s.\n' "$target_release" >&2
    return 1
  fi

  systemctl restart the-open-web || { printf 'Recovery restart failed for %s.\n' "$target_release" >&2; return 1; }
  systemctl is-active --quiet the-open-web || { printf 'Recovered service is not active for %s.\n' "$target_release" >&2; return 1; }
  wait_for_runtime_release "$target_release" "$attempts" || { printf 'Recovered process is not running from %s.\n' "$target_release" >&2; return 1; }
  wait_for_health "$local_health" "$attempts" || { printf 'Recovered local health failed for %s.\n' "$target_release" >&2; return 1; }
  wait_for_health "$public_health" "$attempts" || { printf 'Recovered public health failed for %s.\n' "$target_release" >&2; return 1; }
  wait_for_manifest "$public_manifest" "$expected_manifest" "$attempts" || { printf 'Recovered public manifest does not match %s.\n' "$target_release" >&2; return 1; }

  printf 'RECOVERY VERIFIED %s\n' "$target_release"
}
