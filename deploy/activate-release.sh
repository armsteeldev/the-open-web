#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/release-recovery.sh"

[[ $EUID -eq 0 ]] || fail 'activation requires root; invoke through sudo from deploy/release.sh'
[[ $# -eq 4 ]] || fail 'usage: activate-release.sh ARCHIVE COMMIT SHA256 BACKUP_DIR'
archive=$1
commit=$2
expected_sha=$3
backup_dir=$4
[[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'commit must be a full lowercase Git SHA'
[[ $expected_sha =~ ^[0-9a-f]{64}$ ]] || fail 'archive digest must be SHA-256'
[[ $archive == /* && -f $archive && ! -L $archive ]] || fail 'release archive must be an existing regular absolute file'
[[ $backup_dir == /* && -d $backup_dir && ! -L $backup_dir ]] || fail 'backup directory must be an existing real absolute directory'
printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum --check -

root=/opt/the-open-web
release_root=$root/releases
current=$root/current
lock_file=/run/lock/the-open-web-deploy.lock
[[ -d $release_root && -L $current ]] || fail 'production release layout is incomplete'
exec 9>"$lock_file"
flock -n 9 || fail 'another deployment or rollback is already running'

previous_release=$(readlink -f "$current")
[[ -d $previous_release ]] || fail "current release target is missing: $previous_release"
case "$previous_release" in "$release_root"/*) ;; *) fail 'current symlink points outside the managed release directory' ;; esac
systemctl is-active --quiet the-open-web || fail 'the-open-web is not active'
main_pid=$(systemctl show -p MainPID --value the-open-web)
[[ $main_pid =~ ^[1-9][0-9]*$ && -r /proc/$main_pid/environ ]] || fail 'could not read the active service environment'
db_path=
app_port=
while IFS= read -r entry; do
  case "$entry" in
    DB_PATH=*) db_path=${entry#DB_PATH=} ;;
    PORT=*) app_port=${entry#PORT=} ;;
  esac
done < <(tr '\0' '\n' < "/proc/$main_pid/environ")
[[ $db_path == /* && -f $db_path ]] || fail 'active service DB_PATH is missing or not absolute'
[[ $app_port =~ ^[0-9]{1,5}$ ]] && (( app_port >= 1 && app_port <= 65535 )) || fail 'active service PORT is missing or invalid'
local_health=http://127.0.0.1:$app_port/api/health
public_health=https://open.armsteel.dev/api/health
public_manifest=https://open.armsteel.dev/release.json
release_dir=$release_root/$commit
expected_manifest="{\"commit\":\"$commit\"}"
previous_manifest_file=$previous_release/apps/web/dist/release.json
[[ -f $previous_manifest_file ]] || fail 'previous release has no release manifest for recovery verification'
previous_manifest=$(<"$previous_manifest_file")
if [[ $previous_release == "$release_dir" ]]; then
  wait_for_runtime_release "$release_dir" || fail 'current service process is not running from its release directory'
  wait_for_health "$local_health" || fail 'current release is not healthy'
  wait_for_health "$public_health" || fail 'current public service is not healthy'
  wait_for_manifest "$public_manifest" "$expected_manifest" 5 || fail 'current public release manifest does not match its symlink'
  printf 'Already active and healthy: %s\n' "$commit"
  exit 0
fi
[[ ! -e $release_dir && ! -L $release_dir ]] || fail "stale release directory exists for $commit; inspect it and retry after removing it if it is not active"
[[ ! -e $root/.current.next && ! -L $root/.current.next ]] || fail 'stale .current.next exists; inspect it before continuing'

wait_for_health "$local_health" || fail "active service is not healthy at its configured port $app_port"
wait_for_health "$public_health" || fail 'public service health check failed before release'

db_device=$(findmnt -n -o MAJ:MIN -T "$db_path")
backup_device=$(findmnt -n -o MAJ:MIN -T "$backup_dir")
[[ -n $db_device && -n $backup_device && $db_device != "$backup_device" ]] || fail 'backup directory must be on a different mounted device from the production database'
backup_owner=$(stat -c '%u' "$backup_dir")
[[ $backup_owner == 0 ]] || fail 'backup directory must be owned by root'
backup_mode=$(stat -c '%a' "$backup_dir")
(( (8#$backup_mode & 077) == 0 )) || fail 'backup directory must not be accessible to group or other users'
db_size=$(stat -c '%s' "$db_path")
wal_size=0
[[ -f $db_path-wal ]] && wal_size=$(stat -c '%s' "$db_path-wal")
required_bytes=$(( (db_size + wal_size) * 2 + 67108864 ))
available_bytes=$(df -B1 --output=avail "$backup_dir" | awk 'NR==2 {print $1}')
[[ $available_bytes =~ ^[0-9]+$ ]] && (( available_bytes >= required_bytes )) || fail 'backup device lacks the estimated free space required for a verified SQLite snapshot'

staging_dir=$(mktemp -d "$release_root/.$commit.staging.XXXXXX")
switched=0
release_installed=0
safe_to_remove=1
temporary_link=
state_temp=
finish() {
  local result=$?
  trap - EXIT
  if (( result != 0 && switched == 1 )); then
    printf 'Activation failed; restoring %s and checking recovery\n' "$previous_release" >&2
    if recover_release "$root" "$current" "$release_dir" "$previous_release" \
      "$local_health" "$public_health" "$public_manifest" "$previous_manifest"; then
      safe_to_remove=1
      printf 'Automatic rollback complete; the prior release process and public manifest are verified. The verified backup was retained.\n' >&2
    elif [[ $(readlink -f "$current" 2>/dev/null || true) == "$previous_release" ]]; then
      safe_to_remove=0
      printf 'The prior release is selected but recovery was not verified. Inspect the service immediately.\n' >&2
    else
      safe_to_remove=0
      printf 'Automatic rollback failed or refused. Inspect the service immediately.\n' >&2
    fi
  fi
  if [[ -n $temporary_link && -L $temporary_link ]]; then rm -f -- "$temporary_link"; fi
  if [[ -n $state_temp && -f $state_temp ]]; then rm -f -- "$state_temp"; fi
  if [[ -n $staging_dir && -d $staging_dir ]]; then rm -rf -- "$staging_dir"; fi
  if (( result != 0 && release_installed == 1 && safe_to_remove == 1 )) && [[ $(readlink -f "$current" 2>/dev/null || true) != "$release_dir" ]]; then
    rm -rf -- "$release_dir"
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

tar --no-same-owner -xzf "$archive" -C "$staging_dir"
for expected_path in dist/apps/server/src/index.js dist/apps/server/src/spaces/chat/remove-message.js dist/database/migrations apps/web/dist/wall/index.html apps/web/dist/chat/index.html apps/web/dist/release.json scripts/backup.mjs scripts/test-production.mjs package.json package-lock.json; do
  [[ -e $staging_dir/$expected_path ]] || fail "release archive is missing $expected_path"
done
manifest=$(cat "$staging_dir/apps/web/dist/release.json")
[[ $manifest == "$expected_manifest" ]] || fail 'release manifest does not match the verified Git commit'
require_rollback_compatibility "$staging_dir" "$previous_release" || fail 'the active release is not a safe rollback target for migration 004'
chown -R root:root "$staging_dir"
npm --prefix "$staging_dir" ci --omit=dev --ignore-scripts --no-audit --no-fund
npm --prefix "$staging_dir" run test:production
# mktemp creates mode 0700 directories. Make the immutable release readable by
# open-web and Caddy before removing write permission.
chmod -R a+rX "$staging_dir"
chmod -R a-w "$staging_dir"
mv "$staging_dir" "$release_dir"
staging_dir=
release_installed=1

backup_path=$backup_dir/open-web-before-$commit-$(date -u +%Y%m%dT%H%M%SZ).sqlite
[[ ! -e $backup_path && ! -L $backup_path ]] || fail "backup destination already exists: $backup_path"
node "$release_dir/scripts/backup.mjs" "$db_path" "$backup_path"
[[ -s $backup_path ]] || fail 'verified database backup was not created'
[[ $(stat -c '%a' "$backup_path") == 600 ]] || fail 'backup permissions are not private'

[[ $(readlink -f "$current") == "$previous_release" ]] || fail 'current release changed while the candidate was being prepared'
temporary_link=$root/.current.next.$$
ln -s "$release_dir" "$temporary_link"
switched=1
mv -Tf "$temporary_link" "$current"
temporary_link=
systemctl restart the-open-web
systemctl is-active --quiet the-open-web || fail 'service did not remain active after restart'
wait_for_runtime_release "$release_dir" || fail 'service process is not running from the activated release directory'
wait_for_health "$local_health" || fail "local health check did not recover on port $app_port"
wait_for_health "$public_health" || fail 'public health check did not recover'
wait_for_manifest "$public_manifest" "$expected_manifest" || fail 'public release manifest did not match the activated commit'

public_session=$(curl --fail --silent --show-error --max-time 8 https://open.armsteel.dev/api/session)
printf '%s' "$public_session" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c).on("end",()=>{try{const value=JSON.parse(s);process.exit(Number.isFinite(value.retryAfterMs)?0:1)}catch{process.exit(1)}})' || fail 'public session API did not return a numeric cooldown duration'
page_html=$(curl --fail --silent --show-error --max-time 12 https://open.armsteel.dev/wall/)
[[ $page_html == *'class="palette-stack"'* ]] || fail 'public page did not contain the expected wall controls'
chat_history=$(curl --fail --silent --show-error --max-time 8 https://open.armsteel.dev/api/chat/history) || fail 'public chat history endpoint failed'
printf '%s' "$chat_history" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c).on("end",()=>{try{const v=JSON.parse(s);process.exit(Array.isArray(v.messages)&&Number.isSafeInteger(v.latestId)&&("oldestId" in v)?0:1)}catch{process.exit(1)}})' || fail 'public chat history response was invalid'
chat_html=$(curl --fail --silent --show-error --max-time 12 https://open.armsteel.dev/chat/)
[[ $chat_html == *'id="message-input"'* && $chat_html == *'Global Chat'* && $chat_html == *'The Wall'* ]] || fail 'public chat page or shared navigation was incomplete'

state_temp=$(mktemp "$root/.previous-release.XXXXXX")
printf '%s\n' "$previous_release" > "$state_temp"
chmod 0644 "$state_temp"
chown root:root "$state_temp"
mv -Tf "$state_temp" "$root/previous-release"
state_temp=
switched=0
printf 'DEPLOYED %s\nBACKUP %s\nPORT %s\n' "$commit" "$backup_path" "$app_port"
