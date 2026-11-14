#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
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
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/release-recovery.sh"
port=$(runtime_port)
local_health=http://127.0.0.1:$port/api/health
public_health=https://open.armsteel.dev/api/health
public_manifest=https://open.armsteel.dev/release.json
manifest_file=$previous_release/apps/web/dist/release.json
[[ -f $manifest_file ]] || fail 'rollback release has no manifest'
expected_manifest=$(<"$manifest_file")
current_manifest_file=$current_release/apps/web/dist/release.json
[[ -f $current_manifest_file ]] || fail 'current release has no manifest for automatic recovery'
current_manifest=$(<"$current_manifest_file")

switched=0
temporary_link=
state_temp=
finish() {
  local result=$?
  trap - EXIT
  if (( result != 0 && switched == 1 )); then
    target=$(readlink -f "$current" 2>/dev/null || true)
    if [[ $target == "$previous_release" ]]; then
      printf 'Rollback failed; restoring %s and checking recovery\n' "$current_release" >&2
      if recover_release "$root" "$current" "$previous_release" "$current_release" \
        "$local_health" "$public_health" "$public_manifest" "$current_manifest"; then
        printf 'Original release process and manifest are verified.\n' >&2
      else
        printf 'Original release is selected but recovery was not verified. Inspect the service immediately.\n' >&2
      fi
    elif [[ $target != "$current_release" ]]; then
      printf 'Current target changed unexpectedly; automatic recovery refused. Inspect it immediately.\n' >&2
    fi
  fi
  if [[ -n $temporary_link && -L $temporary_link ]]; then rm -f -- "$temporary_link"; fi
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
wait_for_runtime_release "$previous_release" || fail 'rollback service process is not running from the selected release directory'
wait_for_health "$local_health" || fail 'rollback target did not pass local health checks'
wait_for_health "$public_health" || fail 'rollback target did not pass public health checks'
wait_for_manifest "$public_manifest" "$expected_manifest" || fail 'public release manifest did not match the rollback target'

state_temp=$(mktemp "$root/.previous-release.XXXXXX")
printf '%s\n' "$current_release" > "$state_temp"
chmod 0644 "$state_temp"
chown root:root "$state_temp"
mv -Tf "$state_temp" "$previous_file"
state_temp=
switched=0
printf 'ROLLED BACK TO %s\nPREVIOUS RELEASE %s\n' "$(basename "$previous_release")" "$(basename "$current_release")"
