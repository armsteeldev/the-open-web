import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const recoveryScript = resolve('deploy/release-recovery.sh');
const fingerprint = '990f41588a6c25778e5d2f1d5ba475da8797298021b429e354929c6b509be47e';

function writeRelease(root: string, name: string): string {
  const directory = join(root, 'releases', name);
  mkdirSync(join(directory, 'apps/web/dist'), { recursive: true });
  writeFileSync(join(directory, 'apps/web/dist/release.json'), `${JSON.stringify({ commit: name })}\n`);
  return directory;
}

function writeSystemctl(bin: string): void {
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'systemctl');
  writeFileSync(path, `#!/usr/bin/env bash
set -eu
case "$1" in
 restart)
  if [[ \${FAIL_START:-0} == 1 ]]; then rm -f -- "$PID_FILE"; exit 0; fi
  old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ $old_pid =~ ^[0-9]+$ ]]; then kill "$old_pid" 2>/dev/null || true; fi
  target=$(readlink -f "$CURRENT")
  (cd "$target" && exec sleep 120) >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
  ;;
 is-active)
  if [[ \${FAKE_ACTIVE_LIE:-0} == 1 ]]; then exit 0; fi
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
  ;;
 show)
  cat "$PID_FILE" 2>/dev/null || true
  ;;
 *) exit 2 ;;
esac
`);
  chmodSync(path, 0o755);
}

function callRecovery(options: {
  readonly root: string;
  readonly current: string;
  readonly failed: string;
  readonly target: string;
  readonly endpoint: string;
  readonly manifest: string;
  readonly bin: string;
  readonly pidFile: string;
  readonly failStart?: boolean;
  readonly activeLie?: boolean;
  readonly attempts?: number;
}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = spawn('bash', ['-Eeuo', 'pipefail', '-c', `
    source "$RECOVERY_SCRIPT"
    recover_release "$ROOT" "$CURRENT" "$FAILED" "$TARGET" \
      "$ENDPOINT/api/health" "$ENDPOINT/api/health" "$ENDPOINT/release.json" "$MANIFEST" "$ATTEMPTS"
  `], {
    env: {
      ...process.env,
      PATH: `${options.bin}:${process.env.PATH ?? ''}`,
      RECOVERY_SCRIPT: recoveryScript,
      ROOT: options.root,
      CURRENT: options.current,
      FAILED: options.failed,
      TARGET: options.target,
      ENDPOINT: options.endpoint,
      MANIFEST: options.manifest,
      ATTEMPTS: String(options.attempts ?? 2),
      PID_FILE: options.pidFile,
      FAIL_START: options.failStart ? '1' : '0',
      FAKE_ACTIVE_LIE: options.activeLie ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

test('activation failure recovers to the compatible release and rollback failure recovers to the original release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-recovery-'));
  const candidate = writeRelease(root, 'candidate');
  const bridge = writeRelease(root, 'bridge');
  const current = join(root, 'current');
  const pidFile = join(root, 'service.pid');
  const bin = join(root, 'bin');
  writeSystemctl(bin);
  symlinkSync(candidate, current);

  const server = createServer((request, response) => {
    if (request.url === '/release.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(readFileSync(join(current, 'apps/web/dist/release.json')));
      return;
    }
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    let healthy = Number.isSafeInteger(pid) && pid > 0;
    if (healthy) {
      try { process.kill(pid, 0); healthy = realpathSync(`/proc/${pid}/cwd`) === realpathSync(current); }
      catch { healthy = false; }
    }
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: healthy }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const systemctlEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CURRENT: current, PID_FILE: pidFile };

  try {
    let started = spawnSync(join(bin, 'systemctl'), ['restart', 'the-open-web'], { env: systemctlEnv, encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    let recovery = await callRecovery({ root, current, failed: candidate, target: bridge, endpoint, manifest: readFileSync(join(bridge, 'apps/web/dist/release.json'), 'utf8').trim(), bin, pidFile });
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.ok(recovery.stdout.includes(`RECOVERY VERIFIED ${bridge}`));
    assert.equal(realpathSync(current), bridge);

    started = spawnSync(join(bin, 'systemctl'), ['restart', 'the-open-web'], { env: systemctlEnv, encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    recovery = await callRecovery({ root, current, failed: bridge, target: candidate, endpoint, manifest: readFileSync(join(candidate, 'apps/web/dist/release.json'), 'utf8').trim(), bin, pidFile });
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.match(recovery.stdout, /RECOVERY VERIFIED .*candidate/);
    assert.equal(realpathSync(current), candidate);
  } finally {
    server.close();
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('down or stale service cannot be reported as recovered, even if systemd claims active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-recovery-down-'));
  const candidate = writeRelease(root, 'candidate');
  const bridge = writeRelease(root, 'bridge');
  const current = join(root, 'current');
  const pidFile = join(root, 'service.pid');
  const bin = join(root, 'bin');
  writeSystemctl(bin);
  symlinkSync(candidate, current);
  const server = createServer((request, response) => {
    if (request.url === '/release.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(readFileSync(join(current, 'apps/web/dist/release.json')));
    } else {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"ok":false}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const recovery = await callRecovery({
      root, current, failed: candidate, target: bridge, endpoint: `http://127.0.0.1:${address.port}`,
      manifest: readFileSync(join(bridge, 'apps/web/dist/release.json'), 'utf8').trim(), bin, pidFile,
      failStart: true, activeLie: true, attempts: 1,
    });
    assert.notEqual(recovery.code, 0);
    assert.doesNotMatch(`${recovery.stdout}${recovery.stderr}`, /RECOVERY VERIFIED/);
    assert.equal(realpathSync(current), bridge, 'target remains selected for operator inspection');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration 004 release is blocked unless its rollback target has the exact compatibility marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-rollback-gate-'));
  try {
    const candidate = join(root, 'candidate');
    const legacy = join(root, 'legacy');
    const bridge = join(root, 'bridge');
    mkdirSync(join(candidate, 'dist/database/migrations'), { recursive: true });
    mkdirSync(join(legacy, 'dist/apps/server/src'), { recursive: true });
    mkdirSync(join(bridge, 'dist/apps/server/src'), { recursive: true });
    writeFileSync(join(candidate, 'dist/database/migrations/004_bottle_messages.sql'), 'schema');
    writeFileSync(join(legacy, 'dist/apps/server/src/db.js'), 'migration runner 001-003');
    writeFileSync(join(bridge, 'dist/apps/server/src/db.js'), `known schema ${fingerprint}`);

    const check = `source "$RECOVERY_SCRIPT"; require_rollback_compatibility "$CANDIDATE" "$PREVIOUS"`;
    const rejected = spawnSync('bash', ['-Eeuo', 'pipefail', '-c', check], {
      env: { ...process.env, RECOVERY_SCRIPT: recoveryScript, CANDIDATE: candidate, PREVIOUS: legacy },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Deploy the compatibility bridge first/);
    const accepted = spawnSync('bash', ['-Eeuo', 'pipefail', '-c', check], {
      env: { ...process.env, RECOVERY_SCRIPT: recoveryScript, CANDIDATE: candidate, PREVIOUS: bridge },
      encoding: 'utf8',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
