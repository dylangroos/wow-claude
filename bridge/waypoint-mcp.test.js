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
    assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['set_waypoint', 'set_waypoints', 'clear_waypoint']);

    // Scenario: Bad coordinates are rejected
    const bad = await call('tools/call', { name: 'set_waypoint', arguments: { zone: 'Elwynn Forest', x: 140, y: 78.4, label: 'Hogger' } });
    assert.strictEqual(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /\bx must be a number from 0 to 100/);
    assert.ok(!fs.existsSync(file), 'nothing written for a bad call');

    const good = await call('tools/call', { name: 'set_waypoint', arguments: { zone: ' Elwynn Forest ', x: 25.6, y: 78.4, label: 'Hogger' } });
    assert.ok(!good.result.isError, JSON.stringify(good));
    assert.strictEqual(good.result.content[0].text, 'Waypoint set: Hogger in Elwynn Forest at 25.6, 78.4.');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { stops: [{ zone: 'Elwynn Forest', x: 25.6, y: 78.4, label: 'Hogger' }] });

    // Scenario: Claude clears the waypoint (recorded after the set, so the last line wins)
    const clear = await call('tools/call', { name: 'clear_waypoint', arguments: {} });
    assert.ok(!clear.result.isError, JSON.stringify(clear));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines[lines.length - 1], { clear: true });

    const lineCount = () => fs.readFileSync(file, 'utf8').trim().split('\n').length;
    const last = () => { const ls = fs.readFileSync(file, 'utf8').trim().split('\n'); return JSON.parse(ls[ls.length - 1]); };
    const stop = (label, zone = 'Elwynn Forest', x = 10, y = 10) => ({ zone, x, y, label });
    const three = [stop('Murloc camp', 'Westfall', 45.2, 33.1), stop('Cave', 'Elwynn Forest', 40, 20.1), stop('Hogger', 'Elwynn Forest', 25.6, 78.4)];

    // Scenario: A chain of stops is recorded in order
    const route = await call('tools/call', { name: 'set_waypoints', arguments: { stops: three } });
    assert.ok(!route.result.isError, JSON.stringify(route));
    assert.strictEqual(route.result.content[0].text, 'Route set: 3 stops, first Murloc camp in Westfall.');
    assert.deepStrictEqual(last(), { stops: three });

    // Scenario: A bad stop rejects the whole chain
    const before = lineCount();
    const badStop = await call('tools/call', { name: 'set_waypoints', arguments: { stops: [three[0], { ...three[1], x: 140 }, three[2]] } });
    assert.strictEqual(badStop.result.isError, true);
    assert.match(badStop.result.content[0].text, /stop 2: x must be a number from 0 to 100/);
    assert.strictEqual(lineCount(), before, 'nothing written for a bad chain');

    // Scenario Outline: The number of stops is limited
    for (const [count, ok] of [[0, false], [1, true], [10, true], [11, false]]) {
      const n = lineCount();
      const stops = Array.from({ length: count }, (_, i) => stop(`Stop ${i + 1}`));
      const res = await call('tools/call', { name: 'set_waypoints', arguments: { stops } });
      if (ok) {
        assert.ok(!res.result.isError, `${count} stops: ${JSON.stringify(res)}`);
        assert.strictEqual(last().stops.length, count);
        if (count === 1) assert.strictEqual(res.result.content[0].text, 'Route set: 1 stop, first Stop 1 in Elwynn Forest.');
      } else {
        assert.strictEqual(res.result.isError, true, `${count} stops`);
        assert.match(res.result.content[0].text, /stops must be a list of 1-10 stops/);
        assert.strictEqual(lineCount(), n, `${count} stops: nothing written`);
      }
    }
    const noStops = await call('tools/call', { name: 'set_waypoints', arguments: {} });
    assert.match(noStops.result.content[0].text, /stops must be a list of 1-10 stops/);

    const unknown = await call('resources/list', {});
    assert.strictEqual(unknown.error.code, -32601);
  } finally {
    child.kill();
  }

  const { checkWaypoint, checkStops, handle } = require('./waypoint-mcp');
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
  assert.strictEqual(checkStops([{ zone: 'Westfall', x: 1, y: 1, label: 'a' }]), null);
  assert.match(checkStops('nope'), /1-10 stops/);
  assert.match(checkStops([{ zone: 'Westfall', x: 1, y: 1, label: 'a' }, { zone: '', x: 1, y: 1, label: 'b' }]), /^stop 2: zone/);
  console.log('Waypoint server tests passed.');
};
