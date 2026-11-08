// Tests for the waypoint MCP server: spawns it like Claude Code does and talks
// newline-delimited JSON-RPC over stdio.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

module.exports = async function waypointServerTests(tmp) {
  const file = path.join(tmp, 'waypoint-test.jsonl');
  const child = spawn(process.execPath, [path.join(__dirname, 'waypoint-mcp.js')], {
    env: { ...process.env, CB_WAYPOINT_FILE: file },
  });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
    }
  });
  let next = 1;
  const call = async (method, params) => {
    const id = next++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const end = Date.now() + 5000;
    while (!replies.has(id)) {
      if (Date.now() > end) throw new Error(`no reply to ${method}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return replies.get(id);
  };

  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    assert.deepStrictEqual(init.result.capabilities, { tools: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await call('tools/list', {});
    assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['set_waypoint']);

    // Scenario: Bad coordinates are rejected
    const bad = await call('tools/call', { name: 'set_waypoint', arguments: { zone: 'Elwynn Forest', x: 140, y: 78.4, label: 'Hogger' } });
    assert.strictEqual(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /\bx must be a number from 0 to 100/);
    assert.ok(!fs.existsSync(file), 'nothing written for a bad call');

    const good = await call('tools/call', { name: 'set_waypoint', arguments: { zone: ' Elwynn Forest ', x: 25.6, y: 78.4, label: 'Hogger' } });
    assert.ok(!good.result.isError, JSON.stringify(good));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { zone: 'Elwynn Forest', x: 25.6, y: 78.4, label: 'Hogger' });

    const unknown = await call('resources/list', {});
    assert.strictEqual(unknown.error.code, -32601);
  } finally {
    child.kill();
  }

  const { checkWaypoint, handle } = require('./waypoint-mcp');
  // A failed write must come back as a tool error, not crash the server.
  const unwritable = handle({ method: 'tools/call', params: { name: 'set_waypoint', arguments: { zone: 'Westfall', x: 1, y: 1, label: 'Edge' } } },
    path.join(tmp, 'no-such-dir', 'w.jsonl'));
  assert.strictEqual(unwritable.isError, true);
  assert.match(unwritable.content[0].text, /^Waypoint not saved:/);
  assert.strictEqual(checkWaypoint({ zone: 'Westfall', x: 0, y: 100, label: 'Edge' }), null);
  assert.match(checkWaypoint({ zone: '', x: 1, y: 1, label: 'a' }), /zone/);
  assert.match(checkWaypoint({ zone: 'Westfall', x: 1, y: NaN, label: 'a' }), /\by\b/);
  assert.match(checkWaypoint({ zone: 'Westfall', x: 1, y: 1, label: 'x'.repeat(41) }), /label/);
  assert.match(checkWaypoint(null), /object/);
  console.log('Waypoint server tests passed.');
};
