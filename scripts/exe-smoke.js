#!/usr/bin/env node
// End-to-end check of a built ClaudeBridge.exe in a fake WoW folder, with a
// stand-in Claude that calls the waypoint tool through the exe's own helper.
//
//   node scripts/exe-smoke.js dist/ClaudeBridge/ClaudeBridge.exe v1.0.0
//   node scripts/exe-smoke.js --repo           same checks against node bridge/cli.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const P = require('../bridge/protocol');
const { renderScreen, writeTga } = require('../test/strip-image');

const repoMode = process.argv[2] === '--repo';
const exe = repoMode ? process.execPath : path.resolve(process.argv[2] || 'dist/ClaudeBridge/ClaudeBridge.exe');
const baseArgs = repoMode ? [path.join(__dirname, '..', 'bridge', 'cli.js')] : [];
const version = repoMode ? 'dev' : process.argv[3];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-smoke-'));
const env = {
  ...process.env,
  CB_CONFIG: path.join(tmp, 'config.json'),
  CB_STATE: path.join(tmp, 'state.json'),
  CB_AGENT_HOME: path.join(tmp, 'agent-home'),
};
const runSync = (args, input) => spawnSync(exe, [...baseArgs, ...args], { env, input, encoding: 'utf8', timeout: 30_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

// Stand-in for Claude Code: reads the bridge's MCP config, starts the "wow"
// server exactly as Claude would, sets a waypoint through it, then answers.
const fake = path.join(tmp, 'fake-claude.js');
fs.writeFileSync(fake, `
  const fs = require('fs');
  const { spawn } = require('child_process');
  if (process.argv.includes('--version')) { console.log('fake 1.0'); process.exit(0); }
  let prompt = ''; process.stdin.on('data', (d) => prompt += d);
  process.stdin.on('end', () => {
    const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.wow;
    const srv = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env } });
    let out = '';
    srv.stdout.on('data', (d) => {
      out += d;
      if (!out.includes('"id":2')) return;
      srv.kill();
      const ok = out.includes('Waypoint set');
      process.stdout.write(JSON.stringify({ result: ok ? 'Hogger is at 25.6, 78.4.' : 'tool failed: ' + out, session_id: 's1', is_error: false }));
    });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_waypoint',
      arguments: { zone: 'Elwynn Forest', x: 25.6, y: 78.4, label: 'Hogger' } } }) + '\\n');
  });`);

let bridge;
(async () => {
  // Version and helper mode.
  if (version) assert.strictEqual(runSync(['--version']).stdout.trim(), version);
  const mcp = runSync(['--waypoint-mcp'], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  assert.ok(mcp.stdout.includes('set_waypoints'), `helper mode lists the tools: ${mcp.stdout}${mcp.stderr}`);

  // Install into a fake WoW folder.
  const wow = path.join(tmp, '_forever_');
  for (const d of ['Interface/AddOns', 'Screenshots', 'WTF/Account/1/SavedVariables']) fs.mkdirSync(path.join(wow, d), { recursive: true });
  const s = runSync(['setup', '--wow', wow, '--slots', '3']);
  assert.strictEqual(s.status, 0, s.stdout + s.stderr);
  const addons = path.join(wow, 'Interface', 'AddOns');
  assert.ok(fs.existsSync(path.join(addons, 'ClaudeBridge', 'ClaudeBridge.lua')), 'addon installed from the folder next to the exe');
  const cfg = JSON.parse(fs.readFileSync(env.CB_CONFIG, 'utf8'));
  cfg.claudeCommand = [process.execPath, fake];
  fs.writeFileSync(env.CB_CONFIG, JSON.stringify(cfg));

  // Run the bridge.
  let log = '';
  bridge = spawn(exe, baseArgs, { env });
  bridge.stdout.on('data', (d) => { log += d; });
  bridge.stderr.on('data', (d) => { log += d; });
  await waitFor('the bridge to start', () => log.includes('Watching'));
  const slot = (i) => fs.readFileSync(path.join(addons, P.slotName(i), 'r.lua'), 'utf8');

  // Scenario: The exe answers with waypoints (stand-in Claude, the exe's own helper)
  writeTga(renderScreen('abc123|where is Hogger?'), path.join(wow, 'Screenshots', 'WoWScrnShot_1.tga'));
  await waitFor('the answer', () => slot(1).includes('abc123'));
  assert.ok(slot(1).includes('Hogger is at 25.6, 78.4.'), slot(1));
  assert.ok(/waypoints = \{ \{ zone = \[=+\[\nElwynn Forest\]=+\], x = 25\.6, y = 78\.4/.test(slot(1)), slot(1));

  // Scenario: A second bridge refuses to start
  const second = runSync([]);
  assert.notStrictEqual(second.status, 0, 'the second bridge exits with an error');
  assert.ok(/already running/.test(second.stdout + second.stderr), second.stdout + second.stderr);

  console.log(`Smoke test passed for ${repoMode ? 'node bridge/cli.js' : exe}.`);
})().catch((e) => {
  console.error('SMOKE TEST FAILED:', e.message);
  process.exitCode = 1;
}).finally(() => {
  if (bridge) bridge.kill();
  setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(); }, 500);
});
