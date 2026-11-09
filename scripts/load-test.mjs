import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(base, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('isolated backend exited');
    try { if ((await fetch(`${base}/api/health`)).ok) return; }
    catch { /* backend is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('isolated backend did not become healthy');
}

async function opened(socket) {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(2));
}

function memoryKiB(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    return Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
  } catch { return null; }
}

function databaseMiB(path) {
  const bytes = [path, `${path}-wal`, `${path}-shm`].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);
  return Number((bytes / 1024 / 1024).toFixed(3));
}

const temp = mkdtempSync(join(tmpdir(), 'open-web-load-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dbPath = join(temp, 'load.sqlite');
let server, logs = '';
try {
  server = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), ORIGIN: base, COOKIE_SECURE: 'false', WRITES_ENABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { logs += chunk.toString(); });
  server.stderr.on('data', chunk => { logs += chunk.toString(); });
  await waitForServer(base, server);

  let addressNumber = 0;
  for (const [scenario, count] of [1, 10, 25, 50, 100, 250, 500].entries()) {
    const clients = await Promise.all(Array.from({ length: count }, async (_, i) => {
      const n = addressNumber++;
      const address = `198.51.${100 + Math.floor(n / 254)}.${1 + n % 254}`;
      const session = await fetch(`${base}/api/session`, { headers: { 'x-forwarded-for': address } });
      if (!session.ok) throw Error(`session failed for visitor ${i}: ${session.status}`);
      const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
      if (!cookie) throw Error('session cookie missing');
      return { address, cookie };
    }));

    const pending = new Map();
    const sockets = await Promise.all(clients.map(async ({ address }) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events?space=wall`, {
        origin: base,
        headers: { 'x-forwarded-for': address },
      });
      socket.on('message', data => {
        try {
          const event = JSON.parse(data.toString());
          const item = pending.get(`${event.x}:${event.y}`);
          if (item) { item.received++; item.last = performance.now(); }
        } catch { /* malformed test event is counted as missing and fails below */ }
      });
      await opened(socket);
      return socket;
    }));

    const row = 1500 + scenario;
    for (let i = 0; i < count; i++) pending.set(`${i}:${row}`, { started: 0, received: 0, last: 0 });
    const placements = await Promise.all(clients.map(async ({ address, cookie }, i) => {
      const item = pending.get(`${i}:${row}`);
      item.started = performance.now();
      const response = await fetch(`${base}/api/wall/pixel`, {
        method: 'POST',
        headers: { cookie, origin: base, 'content-type': 'application/json', 'x-forwarded-for': address },
        body: JSON.stringify({ x: i, y: row, color: 4 }),
      });
      const elapsed = performance.now() - item.started;
      return { status: response.status, elapsed };
    }));

    const deadline = Date.now() + 10000;
    while ([...pending.values()].some(item => item.received < count) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const delivery = [...pending.values()];
    if (placements.some(item => item.status !== 200) || delivery.some(item => item.received !== count)) {
      throw Error(`load scenario failed at ${count} visitors: statuses=${placements.map(p => p.status)} delivery=${delivery.map(d => d.received).join(',')}`);
    }

    const result = {
      visitors: count,
      websocketConnections: sockets.length,
      placements: placements.length,
      placementMs: { p50: percentile(placements.map(p => p.elapsed), 0.5), p95: percentile(placements.map(p => p.elapsed), 0.95), max: Number(Math.max(...placements.map(p => p.elapsed)).toFixed(2)) },
      broadcastToLastSubscriberMs: { p50: percentile(delivery.map(d => d.last - d.started), 0.5), p95: percentile(delivery.map(d => d.last - d.started), 0.95), max: Number(Math.max(...delivery.map(d => d.last - d.started)).toFixed(2)) },
      websocketMessages: delivery.reduce((sum, item) => sum + item.received, 0),
      backendRssMiB: Number((memoryKiB(server.pid) / 1024).toFixed(1)),
      databaseMiB: databaseMiB(dbPath),
    };
    console.log(JSON.stringify(result));
    if (count === 500) {
      const n = addressNumber++;
      const overflow = new WebSocket(`ws://127.0.0.1:${port}/api/events?space=wall`, { origin: base, headers: { 'x-forwarded-for': `198.51.${100 + Math.floor(n / 254)}.${1 + n % 254}` } });
      const closeCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('connection limit probe timed out')), 5000);
        overflow.once('close', code => { clearTimeout(timeout); resolve(code); });
        overflow.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      if (closeCode !== 1008) throw Error(`expected connection cap close 1008, received ${closeCode}`);
      console.log(JSON.stringify({ visitors: 501, rejectedAtConnectionCap: true, closeCode }));
    }
    await Promise.all(sockets.map(socket => new Promise(resolve => {
      socket.once('close', resolve);
      socket.close();
    })));
  }
} catch (error) {
  if (server && logs) process.stderr.write(logs.slice(-3000));
  throw error;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const ended = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await ended;
  }
  rmSync(temp, { recursive: true, force: true });
}
