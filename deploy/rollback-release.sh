#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
wait_for_health() {
  local endpoint=$1 attempt response
  for ((attempt=1; attempt<=60; attempt++)); do
    if response=$(curl --fail --silent --max-time 2 "$endpoint" 2>/dev/null) &&
       printf '%s' "$response" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
wait_for_manifest() {
  local endpoint=$1 expected=$2 attempt response
  for ((attempt=1; attempt<=60; attempt++)); do
    if response=$(curl --fail --silent --max-time 3 "$endpoint" 2>/dev/null) && [[ $response == "$expected" ]]; then return 0; fi
    sleep 1
  done
  return 1
}
runtime_port() {
  local pid entry port=
  pid=$(systemctl show -p MainPID --value the-open-web 2>/dev/null || true)
  if [[ $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/environ ]]; then
    while IFS= read -r entry; do
      if [[ $entry == PORT=* ]]; then port=${entry#PORT=}; fi
    done < <(tr '\0' '\n' < "/proc/$pid/environ")
  fi
  if [[ -z $port ]]; then
    port=$(awk -F= '$1=="PORT" {value=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); gsub(/^\047|\047$/, "", value); print value; exit}' /etc/the-open-web.env 2>/dev/null || true)
  fi
  [[ -n $port ]] || port=4322
  [[ $port =~ ^[0-9]{1,5}$ ]] && (( port >= 1 && port <= 65535 )) || fail 'could not determine a valid service port'
  printf '%s' "$port"
}

if [[ $EUID -ne 0 ]]; then exec sudo bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/rollback-release.sh" --root; fi
[[ $# -eq 1 && $1 == --root ]] || fail 'invoke with npm run rollback'

root=/opt/the-open-web
release_root=$root/releases
current=$root/current
previous_file=$root/previous-release
[[ -L $current && -f $previous_file && ! -L $previous_file ]] || fail 'current release or rollback target is missing'
[[ $(stat -c '%u' "$previous_file") == 0 ]] || fail 'rollback state file is not root-owned'
exec 9>/run/lock/the-open-web-deploy.lock
flock -n 9 || fail 'another deployment or rollback is already running'

current_release=$(readlink -f "$current")
previous_release=$(<"$previous_file")
[[ -d $current_release && -d $previous_release ]] || fail 'current or previous release directory is missing'
case "$current_release" in "$release_root"/*) ;; *) fail 'current symlink points outside managed releases' ;; esac
case "$previous_release" in "$release_root"/*) ;; *) fail 'rollback target points outside managed releases' ;; esac
[[ $(readlink -f "$previous_release") == "$previous_release" ]] || fail 'rollback target is not a canonical release path'
[[ $current_release != "$previous_release" ]] || fail 'previous-release already matches the current release'
port=$(runtime_port)
local_health=http://127.0.0.1:$port/api/health
public_health=https://open.armsteel.dev/api/health
manifest_file=$previous_release/apps/web/dist/release.json
expected_manifest=
if [[ -f $manifest_file ]]; then expected_manifest=$(<"$manifest_file"); fi

switched=0
temporary_link=
recovery_link=
state_temp=
finish() {
  local result=$?
  trap - EXIT
  if (( result != 0 && switched == 1 )); then
    target=$(readlink -f "$current" 2>/dev/null || true)
    if [[ $target == "$previous_release" ]]; then
      printf 'Rollback failed; restoring %s and checking recovery\n' "$current_release" >&2
      recovery_link=$root/.current.recovery.$$
      if ln -s "$current_release" "$recovery_link" && mv -Tf "$recovery_link" "$current" && systemctl restart the-open-web && systemctl is-active --quiet the-open-web && wait_for_health "$local_health" && wait_for_health "$public_health"; then
        printf 'Original release restored and healthy.\n' >&2
      else
        printf 'Rollback and recovery checks failed. Inspect the service immediately.\n' >&2
      fi
    elif [[ $target != "$current_release" ]]; then
      printf 'Current target changed unexpectedly; automatic recovery refused. Inspect it immediately.\n' >&2
    fi
  fi
  if [[ -n $temporary_link && -L $temporary_link ]]; then rm -f -- "$temporary_link"; fi
  if [[ -n $recovery_link && -L $recovery_link ]]; then rm -f -- "$recovery_link"; fi
  if [[ -n $state_temp && -f $state_temp ]]; then rm -f -- "$state_temp"; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

temporary_link=$root/.current.rollback.$$
[[ ! -e $temporary_link && ! -L $temporary_link ]] || fail 'stale rollback symlink exists; inspect it before continuing'
ln -s "$previous_release" "$temporary_link"
switched=1
mv -Tf "$temporary_link" "$current"
temporary_link=
systemctl restart the-open-web || fail 'service restart failed during rollback'
systemctl is-active --quiet the-open-web || fail 'service did not remain active after rollback'
wait_for_health "$local_health" || fail 'rollback target did not pass local health checks'
wait_for_health "$public_health" || fail 'rollback target did not pass public health checks'
if [[ -n $expected_manifest ]]; then
  wait_for_manifest https://open.armsteel.dev/release.json "$expected_manifest" || fail 'public release manifest did not match the rollback target'
fi

state_temp=$(mktemp "$root/.previous-release.XXXXXX")
printf '%s\n' "$current_release" > "$state_temp"
chmod 0644 "$state_temp"
chown root:root "$state_temp"
mv -Tf "$state_temp" "$previous_file"
state_temp=
switched=0
printf 'ROLLED BACK TO %s\nPREVIOUS RELEASE %s\n' "$(basename "$previous_release")" "$(basename "$current_release")"
