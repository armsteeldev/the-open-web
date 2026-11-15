import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function port() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const value = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return value;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await ended;
}

async function announced(child, expected) {
  await new Promise((resolveOutput, rejectOutput) => {
    let output = '';
    const finish = error => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (error) rejectOutput(error);
      else resolveOutput();
    };
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(expected)) finish();
    };
    const onExit = () => finish(new Error(`process exited before ${expected}: ${output.slice(-1_000)}`));
    const timeout = setTimeout(() => finish(new Error(`process did not announce ${expected}: ${output.slice(-1_000)}`)), 15_000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

async function probe(url) {
  if (!url.startsWith('https:')) return fetch(url);
  return new Promise((resolveResponse, rejectResponse) => {
    https.get(url, { rejectUnauthorized: false }, response => {
      response.resume();
      resolveResponse(response);
    }).on('error', rejectResponse);
  });
}

async function ready(url, child) {
  let last = 'no response';
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`isolated process exited: ${last}`);
    try {
      const response = await probe(url);
      const status = response.statusCode ?? response.status;
      if (response.ok ?? (status >= 200 && status < 400)) return;
      last = `HTTP ${status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`isolated process not ready (${url}): ${last}`);
}

const temporary = mkdtempSync(join(tmpdir(), 'open-web-cross-browser-'));
const apiPort = await port();
const webPort = await port();
const base = `https://localhost:${webPort}`;
const api = `http://127.0.0.1:${apiPort}`;
let server;
let caddy;

try {
  server = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    env: {
      ...process.env,
      DB_PATH: join(temporary, 'browser.sqlite'),
      PORT: String(apiPort),
      ORIGIN: base,
      COOKIE_SECURE: 'true',
      WRITES_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await announced(server, `Server listening at ${api}`);

  const certificate = join(temporary, 'localhost.crt');
  const key = join(temporary, 'localhost.key');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', certificate,
    '-sha256', '-days', '1', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost',
  ], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(`test TLS certificate generation failed: ${generated.stderr}`);

  const site = readFileSync('deploy/Caddyfile.site', 'utf8')
    .replace('open.armsteel.dev {', `${base} {`)
    .replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${apiPort}`)
    .replace('/opt/the-open-web/current/apps/web/dist', resolve('apps/web/dist'))
    .replace('\n    encode zstd gzip', `\n    tls ${certificate} ${key}\n    encode zstd gzip`);
  const config = join(temporary, 'Caddyfile');
  writeFileSync(config, `{\n admin off\n auto_https off\n}\n${site}`);
  const caddyEnv = { ...process.env, XDG_DATA_HOME: temporary, XDG_CONFIG_HOME: temporary };
  const validation = spawnSync('caddy', ['validate', '--config', config, '--adapter', 'caddyfile'], {
    env: caddyEnv,
    encoding: 'utf8',
  });
  if (validation.status !== 0) throw new Error(`isolated Caddy config invalid: ${validation.stderr}`);

  caddy = spawn('caddy', ['run', '--config', config, '--adapter', 'caddyfile'], {
    env: caddyEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await announced(caddy, 'serving initial configuration');
  await Promise.all([ready(api + '/api/health', server), ready(base + '/wall', caddy)]);

  const test = spawn(process.execPath, ['tests/cross-browser.browser.mjs'], {
    env: { ...process.env, OPEN_WEB_TEST_URL: base },
    stdio: 'inherit',
  });
  const code = await new Promise((resolveExit, rejectExit) => {
    test.once('error', rejectExit);
    test.once('exit', (exitCode, signal) => signal
      ? rejectExit(new Error(`cross-browser test terminated: ${signal}`))
      : resolveExit(exitCode));
  });
  if (code !== 0) throw new Error(`cross-browser test failed (${code})`);
} finally {
  await stop(caddy);
  await stop(server);
  rmSync(temporary, { recursive: true, force: true });
}
