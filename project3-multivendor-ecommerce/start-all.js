/**
 * Starts every microservice as its own process, waits until they are healthy,
 * loads demo data on first run, and restarts a service if it crashes.
 *
 *   npm start
 */
const { spawn } = require('child_process');
const path = require('path');

const GATEWAY_PORT = +process.env.PORT || 4000;
const SERVICES = [
  { name: 'user-service', file: 'services/user-service/index.js', port: 4001, color: 36 },
  { name: 'catalog-service', file: 'services/catalog-service/index.js', port: 4002, color: 35 },
  { name: 'order-service', file: 'services/order-service/index.js', port: 4003, color: 33 },
  { name: 'gateway', file: 'gateway/index.js', port: GATEWAY_PORT, color: 32 },
];
const procs = new Map();
let stopping = false;

function launch(s) {
  const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, s.file)], {
    env: { ...process.env, PORT: String(s.port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = stream => stream.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => console.log(`\x1b[${s.color}m${s.name.padEnd(16)}\x1b[0m ${l}`)));
  pipe(child.stdout); pipe(child.stderr);
  child.on('exit', code => {
    if (stopping) return;
    console.log(`\x1b[31m${s.name} stopped (code ${code}); restarting in 2s\x1b[0m`);
    setTimeout(() => launch(s), 2000);
  });
  procs.set(s.name, child);
}

async function waitHealthy(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if ((await r.json()).ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function shutdown() {
  stopping = true;
  for (const c of procs.values()) c.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

SERVICES.forEach(launch);
(async () => {
  if (!(await waitHealthy())) { console.log('Services did not become healthy in time. Check the logs above.'); return; }
  await new Promise(resolve => {
    const seed = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'seed.js')], { env: { ...process.env, BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}` }, stdio: 'inherit' });
    seed.on('exit', resolve);
  });
  console.log(`\n  Storefront ready:  http://localhost:${GATEWAY_PORT}\n  Demo logins are listed on the Sign in page.\n  Press Ctrl+C to stop all services.\n`);
})();
