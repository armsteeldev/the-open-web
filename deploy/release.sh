#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: npm run release [-- --check-only] [--backup-dir ABSOLUTE_PATH]

Checks and packages the exact clean commit in an isolated temporary checkout.
With no flags, asks sudo to back up the production database and activate it.
--check-only runs every build and release check without changing production.
USAGE
}

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
check_only=0
backup_dir=${OPEN_WEB_BACKUP_DIR:-/mnt/continental-cloud/backups/the-open-web}
while (($#)); do
  case "$1" in
    --check-only) check_only=1; shift ;;
    --backup-dir)
      (($# >= 2)) || fail '--backup-dir requires a path'
      backup_dir=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ $EUID -ne 0 ]] || fail 'run as your normal user; sudo is requested only for activation'
[[ $backup_dir == /* ]] || fail 'backup directory must be an absolute path'
git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail 'not inside a Git checkout'
[[ -z $(git -C "$repo_dir" status --porcelain=v1) ]] || fail 'commit all changes and ensure the working tree is clean before release'
commit=$(git -C "$repo_dir" rev-parse --verify HEAD)
[[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'HEAD is not a full commit ID'

node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number);process.exit(major===22&&(minor>23||(minor===23&&patch>=4))?0:1)' || fail 'Node.js 22.23.4 or later in the 22.x line is required'

chromium_bin=${CHROMIUM_PATH:-}
if [[ -z $chromium_bin ]]; then
  for candidate in chromium chromium-browser google-chrome; do
    chromium_bin=$(command -v "$candidate" || true)
    [[ -z $chromium_bin ]] || break
  done
fi
[[ -n $chromium_bin && -x $chromium_bin ]] || fail 'Chromium was not found; set CHROMIUM_PATH to its executable path'
export CHROMIUM_PATH=$chromium_bin

[[ -r /proc/meminfo && -r /proc/pressure/memory ]] || fail 'cannot measure memory headroom for the isolated load check'
available_kib=$(awk '$1=="MemAvailable:" {print $2}' /proc/meminfo)
[[ $available_kib =~ ^[0-9]+$ ]] && (( available_kib >= 2097152 )) || fail 'need at least 2 GiB MemAvailable for the isolated load check'
psi_full_10=$(awk '$1=="full" {for(i=1;i<=NF;i++) if($i~/^avg10=/){sub(/^avg10=/,"",$i);print $i;exit}}' /proc/pressure/memory)
awk -v value="${psi_full_10:-1}" 'BEGIN {exit !(value < 1.0)}' || fail 'memory full-pressure PSI is too high for the isolated load check'

work_dir=$(mktemp -d /tmp/the-open-web-release.XXXXXX)
archive=$work_dir/release.tar.gz
cleanup() { rm -rf -- "$work_dir"; }
trap cleanup EXIT
source_dir=$work_dir/source
mkdir -p "$source_dir"
git -C "$repo_dir" archive --format=tar "$commit" | tar -xf - -C "$source_dir"
cd "$source_dir"

npm ci
npm audit
npm run lint
npm run typecheck
npm test
npm run build
for script in deploy/release.sh deploy/activate-release.sh deploy/rollback-release.sh; do bash -n "$script"; done
npm run test:browser
npm run test:production
npm run test:built
npm run test:load

printf '{"commit":"%s"}\n' "$commit" > apps/web/dist/release.json
tar -czf "$archive" dist apps/web/dist scripts/backup.mjs scripts/test-production.mjs package.json package-lock.json
archive_sha=$(sha256sum "$archive" | awk '{print $1}')
printf '\nVerified commit: %s\nRelease archive: %s\nArchive SHA-256: %s\n' "$commit" "$archive" "$archive_sha"

if (( check_only )); then
  printf 'CHECK ONLY: production was not changed.\n'
  exit 0
fi

sudo bash "$repo_dir/deploy/activate-release.sh" "$archive" "$commit" "$archive_sha" "$backup_dir"
printf 'Release %s is live and publicly verified.\n' "$commit"
