# Waypoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude gets a `set_waypoint` tool. The waypoint rides into the game with the answer and shows as an arrow on screen plus a pin and a line on the world map.

**Architecture:** A no-npm stdio MCP server (`bridge/waypoint-mcp.js`) records each good tool call as a JSON line in a file. The bridge runs `claude -p` with that server, reads the last waypoint after the answer, and writes it as a third argument of `ClaudeBridge_OnReply`. A new addon file, `Waypoint.lua`, finds the zone's map, saves the waypoint, and draws the arrow and the map line.

**Tech Stack:** Node 18+ with no npm packages (bridge), WoW Lua 5.1 (addon), fengari + luaparse for the offline addon tests (already used in `test/lua/`).

**Spec:** `docs/specs/2026-11-08-waypoint-design.md`

**Runner:** none. Plain `assert` tests named after the scenarios: `node bridge/test.js` (bridge) and `node test/lua/run.js` (addon, tools in `test/lua/.tools`).

## Global Constraints

- Bridge: Node 18+, **no npm packages**.
- No in-game character names anywhere in the repo, tests included. Tests use `Testmage`.
- Nothing automates gameplay. The addon only shows things.
- Waypoint input limits: zone is text, 1-60 characters; x and y are numbers from 0 to 100; label is text, 1-40 characters.
- Tool name as Claude sees it: `mcp__wow__set_waypoint` (server name `wow`, tool `set_waypoint`).
- Arrival distance: 10 yards.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

- Create `bridge/waypoint-mcp.js`: the MCP server, plus `checkWaypoint` (shared with the bridge).
- Create `bridge/waypoint-mcp.test.js`: server tests, called from `bridge/test.js`.
- Modify `bridge/bridge.js`: `CB_AGENT_HOME`, MCP config, system prompt, reading the waypoint, `writeReply(id, text, extra)`.
- Modify `bridge/protocol.js`: `slotLua(id, text, extra)`, the `pos` label.
- Modify `bridge/test.js`: fake Claude plays the tool, plus the waypoint cases.
- Modify `addon/ClaudeBridge/ClaudeBridge.lua`: `pos` context, `ClaudeBridge_Print`, waypoint handoff in `OnReply`, `/claude way`.
- Create `addon/ClaudeBridge/Waypoint.lua`: zone lookup, arrow, commands, and the map pin and line.
- Modify `addon/ClaudeBridge/ClaudeBridge.toc`: list `Waypoint.lua`.
- Create `test/lua/waypointtest.js`: Waypoint.lua tests in a small fake world.
- Modify `test/lua/linkcases.js`: tests for the ClaudeBridge.lua hooks.
- Modify `test/lua/run.js`: run `waypointtest.js`.
- Modify `README.md`.

---

### Task 0: In-game check (the player does this, 1 minute)

**Satisfies:** none (the spec's "Checks before building the addon side").

- [ ] **Step 1: Ask the player to paste this into WoW chat and report what it prints**

```
/run local M,c=C_Map,WorldMapFrame.ScrollContainer.Child print(GetPlayerFacing(),M.GetWorldPosFromMapPos,M.GetMapPosFromWorldPos,M.GetMapChildrenInfo,CreateVector2D,c.CreateLine,M.GetBestMapForUnit("player"))
```

Expected: a number (facing in radians), six `function: ...` values, and a map id (for example `1429` in Elwynn Forest).

- An error about `WorldMapFrame` means the map loads later. Task 5's `ADDON_LOADED` hook covers that. Carry on.
- A `nil` for any of the C_Map functions or `CreateVector2D` stops Tasks 4-5. Report back before building them.

Tasks 1-3 don't depend on this check and can start right away.

---

### Task 1: Waypoint MCP server

**Satisfies:** "Bad coordinates are rejected"

**Files:**
- Create: `bridge/waypoint-mcp.js`
- Create: `bridge/waypoint-mcp.test.js`
- Modify: `bridge/test.js` (call the server tests first)

**Interfaces:**
- Produces: `require('./waypoint-mcp')` returns `{ TOOL, checkWaypoint, handle }`.
  - `checkWaypoint(w)` returns `null` when `w` is a good `{zone, x, y, label}`, or an error message string otherwise.
- Produces: run as a program, the server reads newline-delimited JSON-RPC on stdin. Each good `set_waypoint` call appends `{"zone","x","y","label"}` (trimmed) plus `\n` to `$CB_WAYPOINT_FILE`.

- [ ] **Step 1: Write the failing test** in `bridge/waypoint-mcp.test.js`:

```js
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

  const { checkWaypoint } = require('./waypoint-mcp');
  assert.strictEqual(checkWaypoint({ zone: 'Westfall', x: 0, y: 100, label: 'Edge' }), null);
  assert.match(checkWaypoint({ zone: '', x: 1, y: 1, label: 'a' }), /zone/);
  assert.match(checkWaypoint({ zone: 'Westfall', x: 1, y: NaN, label: 'a' }), /\by\b/);
  assert.match(checkWaypoint({ zone: 'Westfall', x: 1, y: 1, label: 'x'.repeat(41) }), /label/);
  assert.match(checkWaypoint(null), /object/);
  console.log('Waypoint server tests passed.');
};
```

In `bridge/test.js`, make the first line inside `(async () => {` (line 143) this:

```js
  await require('./waypoint-mcp.test')(tmp);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node bridge/test.js`
Expected: `TEST FAILED: Error: no reply to initialize` (the server file doesn't exist yet).

- [ ] **Step 3: Write `bridge/waypoint-mcp.js`**

```js
#!/usr/bin/env node
// MCP server (stdio, no npm packages) that gives the bridge's Claude one tool,
// set_waypoint. Each good call is appended as a JSON line to $CB_WAYPOINT_FILE;
// the bridge reads the last one after Claude answers. Claude Code starts this
// through --mcp-config (see askClaude in bridge.js).
const fs = require('fs');

const TOOL = {
  name: 'set_waypoint',
  description: 'Point the player to a spot in World of Warcraft: an arrow on screen turns toward it and '
    + 'the world map shows a line to it. Use the zone name as the game shows it and the zone map '
    + 'coordinates (0-100) from a source page such as Wowhead. Never guess coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      zone: { type: 'string', description: 'Zone name as the game shows it, for example "Elwynn Forest"' },
      x: { type: 'number', minimum: 0, maximum: 100, description: 'Map x coordinate, 0-100' },
      y: { type: 'number', minimum: 0, maximum: 100, description: 'Map y coordinate, 0-100' },
      label: { type: 'string', description: 'Short name for the spot, for example "Hogger" (40 characters max)' },
    },
    required: ['zone', 'x', 'y', 'label'],
  },
};

// Returns an error message, or null when the waypoint is good.
function checkWaypoint(w) {
  if (!w || typeof w !== 'object') return 'arguments must be an object';
  const text = (k, max) => {
    const v = typeof w[k] === 'string' ? w[k].trim() : '';
    return v.length >= 1 && v.length <= max ? null : `${k} must be text, 1-${max} characters`;
  };
  const num = (k) => (typeof w[k] === 'number' && Number.isFinite(w[k]) && w[k] >= 0 && w[k] <= 100
    ? null : `${k} must be a number from 0 to 100`);
  return text('zone', 60) || num('x') || num('y') || text('label', 40);
}

// One JSON-RPC request -> its result, or undefined for an unknown method.
function handle(msg, file) {
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: p.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'wow', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      if (p.name !== TOOL.name) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${p.name}.` }] };
      const err = checkWaypoint(p.arguments);
      if (err) return { isError: true, content: [{ type: 'text', text: `Waypoint not set: ${err}.` }] };
      const a = p.arguments;
      const w = { zone: a.zone.trim(), x: a.x, y: a.y, label: a.label.trim() };
      fs.appendFileSync(file, JSON.stringify(w) + '\n');
      return { content: [{ type: 'text', text: `Waypoint set: ${w.label} in ${w.zone} at ${w.x}, ${w.y}.` }] };
    }
    default:
      return undefined;
  }
}

function serve(input, output, file) {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined || msg.id === null) continue; // a notification: no reply
      const result = handle(msg, file);
      output.write(JSON.stringify(result === undefined
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
        : { jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  });
}

if (require.main === module) serve(process.stdin, process.stdout, process.env.CB_WAYPOINT_FILE);

module.exports = { TOOL, checkWaypoint, handle };
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node bridge/test.js`
Expected: `Waypoint server tests passed.` then `All bridge tests passed.`

- [ ] **Step 5: Commit**

```bash
git add bridge/waypoint-mcp.js bridge/waypoint-mcp.test.js bridge/test.js
git commit -m "Waypoint MCP server: set_waypoint tool with checked inputs"
```

---

### Task 2: Bridge runs Claude with the tool and passes the waypoint on

**Satisfies:** "Asking where something is sets a waypoint", "An answer without a waypoint carries none", "Only the last waypoint of an answer is kept"

**Files:**
- Modify: `bridge/bridge.js` (constants near line 18, `SYSTEM_PROMPT`, `writeReply`, `askClaude`, `drain`)
- Modify: `bridge/protocol.js:302-304` (`slotLua`)
- Modify: `bridge/test.js` (env, fake Claude, cases)

**Interfaces:**
- Consumes: `checkWaypoint` from Task 1.
- Produces: `P.slotLua(id, text, extra)`. With `extra.waypoint = {zone, x, y, label}` it returns `ClaudeBridge_OnReply("id", [=[\n...]=], { waypoint = { zone = [=[\n...]=], x = N, y = N, label = [=[\n...]=] } })\n`; without it, the output is the same as before.
- Produces: `bridge.writeReply(id, text, extra)`, and `askClaude` resolves `{ ok, text, waypoint }` (`waypoint` is `null` or `{zone, x, y, label}`).
- Produces: env `CB_AGENT_HOME` overrides `ROOT/agent-home`.

- [ ] **Step 1: Write the failing tests** in `bridge/test.js`

After line 15 (`process.env.CB_STATE = ...`) add:

```js
process.env.CB_AGENT_HOME = path.join(tmp, 'agent-home');
```

Replace the fake Claude (the `fs.writeFileSync(fake, ...)` block) with one that plays the tool the way the real server would. It reads the waypoint file's path from the `--mcp-config` file the bridge passes:

```js
  // Fake Claude: echoes the prompt back in the same JSON shape as `claude -p --output-format json`,
  // and plays the set_waypoint tool by appending to the file named in the bridge's MCP config.
  const fake = path.join(tmp, 'fake-claude.js');
  fs.writeFileSync(fake, `
    const fs = require('fs');
    let s = ''; process.stdin.on('data', d => s += d);
    process.stdin.on('end', () => {
      const resumed = process.argv.includes('--resume');
      const at = process.argv.indexOf('--mcp-config');
      const file = at > 0 ? JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8')).mcpServers.wow.env.CB_WAYPOINT_FILE : null;
      const wp = (zone, x, y, label) => fs.appendFileSync(file, JSON.stringify({ zone, x, y, label }) + '\\n');
      if (s.includes('where is Hogger')) wp('Elwynn Forest', 25.6, 78.4, 'Hogger');
      if (s.includes('two spots')) { wp('Elwynn Forest', 10, 10, 'First'); wp('Westfall', 56.5, 52.6, 'Sentinel Hill'); }
      process.stdout.write(JSON.stringify({ result: 'Echo: ' + s + (resumed ? ' (resumed)' : '') + ' ]]', session_id: 'sess-1', is_error: false }));
    });`);
```

Right before the `// Self-test never calls Claude.` block, add:

```js
  // Scenario: Asking where something is sets a waypoint
  bridge.cursor = 3;
  writeTga(renderScreen('a0a0a0|where is Hogger?'), path.join(shots, 'WoWScrnShot_wp1.tga'));
  await waitFor(() => slot(3).includes('a0a0a0'));
  assert.match(slot(3), /^ClaudeBridge_OnReply\("a0a0a0", \[(=+)\[\n[\s\S]*\]\1\], \{ waypoint = \{ zone = \[=+\[\nElwynn Forest\]=+\], x = 25\.6, y = 78\.4, label = \[=+\[\nHogger\]=+\] \} \}\)\n$/, slot(3));

  // Scenario: Only the last waypoint of an answer is kept
  bridge.cursor = 3;
  writeTga(renderScreen('b0b0b0|two spots please'), path.join(shots, 'WoWScrnShot_wp2.tga'));
  await waitFor(() => slot(3).includes('b0b0b0'));
  assert.ok(slot(3).includes('Sentinel Hill') && !slot(3).includes('First'), slot(3));

  // Scenario: An answer without a waypoint carries none (the last answer's file is not reused)
  bridge.cursor = 3;
  writeTga(renderScreen('c1c1c1|ok thanks'), path.join(shots, 'WoWScrnShot_wp3.tga'));
  await waitFor(() => slot(3).includes('c1c1c1'));
  assert.ok(!slot(3).includes('waypoint'), slot(3));
  assert.ok(fs.existsSync(path.join(process.env.CB_AGENT_HOME, 'mcp.json')), 'MCP config written under CB_AGENT_HOME, not the real agent-home');
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node bridge/test.js`
Expected: `TEST FAILED: Error: timed out waiting` on the `a0a0a0` slot match. Without `--mcp-config` the fake gets no file and throws, so the reply is an error (`Claude gave no answer`) and the regex doesn't match. Either a timeout or an `AssertionError` on the regex counts as the expected failure.

- [ ] **Step 3: Implement**

`bridge/protocol.js`: replace `slotLua`:

```js
// extra.waypoint = { zone, x, y, label } rides along as OnReply's third argument,
// so a reply left over from before a /reload (ignored by OnReply) sets nothing.
function slotLua(id, text, extra) {
  let tail = '';
  if (extra && extra.waypoint) {
    const w = extra.waypoint;
    const s = (t) => luaLongString(cleanForWow(t));
    tail = `, { waypoint = { zone = ${s(w.zone)}, x = ${Number(w.x)}, y = ${Number(w.y)}, label = ${s(w.label)} } }`;
  }
  return `ClaudeBridge_OnReply("${id}", ${luaLongString(cleanForWow(text))}${tail})\n`;
}
```

`bridge/bridge.js`:

1. Imports and constants. Replace the `AGENT_HOME` line and add the rest under it:

```js
const { checkWaypoint } = require('./waypoint-mcp');
```
```js
const AGENT_HOME = process.env.CB_AGENT_HOME || path.join(ROOT, 'agent-home');
const WAYPOINT_FILE = path.join(AGENT_HOME, 'waypoint.jsonl');
const MCP_CONFIG = path.join(AGENT_HOME, 'mcp.json');
const WAYPOINT_TOOL = 'mcp__wow__set_waypoint';
```

2. Add to the end of `SYSTEM_PROMPT`'s array:

```js
  '- When the player asks where something is (an NPC, a quest objective, a flight master...), find its',
  '  zone map coordinates on a source page such as Wowhead and call set_waypoint with the zone name as the',
  '  game shows it, x and y (0-100) and a short label. An arrow in game then points the player there.',
  '  Prefer the spot nearest the player\'s "Map position". Mention the coordinates in your answer too.',
  '  Never guess coordinates: if you can\'t find them, say so and don\'t call the tool.',
```

3. Add this helper above `class Bridge`:

```js
// The last good set_waypoint call of this answer, or null.
function readWaypoint() {
  let lines;
  try { lines = fs.readFileSync(WAYPOINT_FILE, 'utf8').split('\n').filter(Boolean); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const w = JSON.parse(lines[i]);
      if (!checkWaypoint(w)) return w;
    } catch { /* a torn line: try the one before */ }
  }
  return null;
}
```

4. `writeReply(id, text)` becomes `writeReply(id, text, extra)`, and its slot line becomes:

```js
    fs.writeFileSync(path.join(this.addonsDir, P.slotName(i), 'r.lua'), P.slotLua(id, text, extra));
```

5. In `askClaude`, before `const args = [`:

```js
    fs.mkdirSync(AGENT_HOME, { recursive: true });
    fs.rmSync(WAYPOINT_FILE, { force: true }); // only this answer's waypoint counts
    fs.writeFileSync(MCP_CONFIG, JSON.stringify({ mcpServers: { wow: {
      type: 'stdio',
      command: process.execPath,
      args: [path.join(__dirname, 'waypoint-mcp.js')],
      env: { CB_WAYPOINT_FILE: WAYPOINT_FILE },
    } } }));
```

Change the two allow lines and add the MCP flags:

```js
      '--tools', 'WebSearch,WebFetch',          // answer-only: no file edits, no shell (MCP tools are separate)
      '--allowedTools', `WebSearch,WebFetch,${WAYPOINT_TOOL}`, // pre-approved: nobody is there to click "allow"
      '--mcp-config', MCP_CONFIG,
      '--strict-mcp-config',                    // only our server, not the PC's other MCP servers
```

Delete the old `fs.mkdirSync(AGENT_HOME, { recursive: true });` inside the Promise. In the `close` handler, change the final resolve to:

```js
        resolve({ ok: !j.is_error, text, waypoint: j.is_error ? null : readWaypoint() });
```

6. In `drain`, replace `this.writeReply(id, res.text);` with:

```js
      if (res.waypoint) log(`Waypoint: ${res.waypoint.label}, ${res.waypoint.zone} ${res.waypoint.x}, ${res.waypoint.y}`);
      this.writeReply(id, res.text, res.waypoint ? { waypoint: res.waypoint } : undefined);
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node bridge/test.js`
Expected: `Waypoint server tests passed.` and `All bridge tests passed.`

- [ ] **Step 5: Commit**

```bash
git add bridge/bridge.js bridge/protocol.js bridge/test.js
git commit -m "Bridge: run Claude with the waypoint tool, send the waypoint with the answer"
```

---

### Task 3: ClaudeBridge.lua hooks (position, handoff, /claude way)

**Satisfies:** "Claude knows where the player is standing"

**Files:**
- Modify: `addon/ClaudeBridge/ClaudeBridge.lua` (context table after the `zone` entry near line 211; after `ClaudeBridge_Toggle` near line 134; `ClaudeBridge_OnReply` near line 706; slash command near line 757)
- Modify: `bridge/protocol.js` (`CTX_LABELS`)
- Test: `test/lua/linkcases.js` (append)

**Interfaces:**
- Consumes: `P.slotLua(id, text, extra)` from Task 2.
- Produces: global `ClaudeBridge_Print(text, r, g, b)`, which shows the window and adds a line.
- Produces: `ClaudeBridge_OnReply(id, text, extra)` calls the global `ClaudeBridge_SetWaypoint(extra.waypoint)` (defined in Task 4) after the answer is printed, inside `pcall`.
- Produces: `/claude way <rest>` calls the global `ClaudeBridge_WaypointCommand(rest)` (defined in Task 4). `rest` is `""` or, for example, `"clear"`.

- [ ] **Step 1: Write the failing test.** Append to `test/lua/linkcases.js`:

```js
// ---- waypoint hooks in ClaudeBridge.lua ----
run('SlashCmdList.CLAUDEBRIDGE("cancel")', 'wp0'); // the broken-tooltip question above is still pending
// Scenario: Claude knows where the player is standing
run('C_Map = { GetBestMapForUnit = function() return 1429 end, GetPlayerMapPosition = function() return { x = 0.421, y = 0.659 } end }', 'wp1');
run('ClaudeBridge_Send("where is the inn?")', 'wp2');
const mp = P.parsePayload(sentPayload());
assert.deepStrictEqual(mp.ctx.find(([k]) => k === 'pos'), ['pos', '42.1, 65.9']);
assert.ok(P.buildPrompt(mp.text, mp.ctx).includes('Map position (x, y on the zone map, 0-100): 42.1, 65.9'));
// The reply's waypoint goes to Waypoint.lua, after the answer is shown. The slot text is the bridge's own.
run('WP_GOT = nil; ClaudeBridge_SetWaypoint = function(w) WP_GOT = w end', 'wp3');
run(P.slotLua(mp.id, 'Hogger is at 25.6, 78.4.', { waypoint: { zone: 'Elwynn Forest', x: 25.6, y: 78.4, label: 'Hogger' } }), 'wpslot');
assert.strictEqual(evalStr('WP_GOT.zone'), 'Elwynn Forest');
assert.strictEqual(L1('WP_GOT.x'), 25.6);
assert.strictEqual(L1('WP_GOT.y'), 78.4);
assert.strictEqual(evalStr('WP_GOT.label'), 'Hogger');
// A broken Waypoint.lua can't break replies.
run('ClaudeBridge_SetWaypoint = function() error("boom") end; ClaudeBridge_Send("again")', 'wp4');
run(P.slotLua(P.parsePayload(sentPayload()).id, 'ok', { waypoint: { zone: 'Elwynn Forest', x: 1, y: 1, label: 'x' } }), 'wpslot2');
assert.ok(evalStr('LINES[#LINES]').includes("Couldn't set the waypoint"), evalStr('LINES[#LINES]'));
// /claude way ... reaches Waypoint.lua.
run('ClaudeBridge_WaypointCommand = function(a) WAYCMD = a end; SlashCmdList.CLAUDEBRIDGE("way clear")', 'wp5');
assert.strictEqual(evalStr('WAYCMD'), 'clear');
run('SlashCmdList.CLAUDEBRIDGE("way")', 'wp6');
assert.strictEqual(evalStr('WAYCMD'), '');
console.log('Waypoint hook tests passed.');
```

`LINES` is not in the stubs yet. In `test/lua/make-linktest.js`, add one more replacement so the log frame records what it shows. Put it next to the other `s.replace` call, inside the same replacement string, after the `HasFocus` line:

```js
    elseif k == "AddMessage" then return function(_, text) LINES[#LINES + 1] = text end
```

Change the first line of `test/lua/linkstubs.lua` to:

```lua
INSERTED, EVENTS, MOD, LINES = {}, {}, false, {}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/lua/run.js`
Expected: `AssertionError` on `mp.ctx.find(... 'pos')` (actual `undefined`).

- [ ] **Step 3: Implement**

`bridge/protocol.js`, in `CTX_LABELS` after `zone`:

```js
  pos: 'Map position (x, y on the zone map, 0-100)',
```

`ClaudeBridge.lua`, in the context table right after the `zone` entry:

```lua
  { "pos", function()
      if not (C_Map and C_Map.GetBestMapForUnit) then return nil end
      local map = C_Map.GetBestMapForUnit("player")
      local p = map and C_Map.GetPlayerMapPosition(map, "player")
      if not p then return nil end -- dungeons hide the position
      return string.format("%.1f, %.1f", p.x * 100, p.y * 100)
    end },
```

After `ClaudeBridge_Toggle`:

```lua
-- Lets Waypoint.lua print into the Claude window.
function ClaudeBridge_Print(text, r, g, b)
  showUI(false)
  addLine(text, r or 0.6, g or 0.6, b or 0.6)
end
```

`ClaudeBridge_OnReply`: signature becomes `function ClaudeBridge_OnReply(id, text, extra)`. After the final `addLine(" ")` add:

```lua
  if extra and extra.waypoint and ClaudeBridge_SetWaypoint then
    local ok, err = pcall(ClaudeBridge_SetWaypoint, extra.waypoint)
    if not ok then addLine("Couldn't set the waypoint: " .. tostring(err), 1, 0.3, 0.3) end
  end
```

Slash command: add this branch before the final `else`:

```lua
  elseif msg == "way" or msg:find("^way%s") then
    if ClaudeBridge_WaypointCommand then ClaudeBridge_WaypointCommand((msg:gsub("^way%s*", ""))) end
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node test/lua/run.js` and `node bridge/test.js`
Expected: `Waypoint hook tests passed.`, `All Lua tests passed.`, `All bridge tests passed.` The ctxtest files still pass unchanged because their stubs have no `C_Map`, so `pos` is left out.

- [ ] **Step 5: Commit**

```bash
git add addon/ClaudeBridge/ClaudeBridge.lua bridge/protocol.js test/lua/linkcases.js test/lua/linkstubs.lua test/lua/make-linktest.js
git commit -m "Addon: send map position, hand reply waypoints to Waypoint.lua, /claude way"
```

---

### Task 4: Waypoint.lua: zone lookup, arrow, commands

**Satisfies:** "The arrow points at the waypoint", "Arriving clears the waypoint", "A waypoint on another continent shows its zone", "Unknown zone is reported", "Waypoint survives a reload", "Clearing the waypoint by command"

**Files:**
- Create: `addon/ClaudeBridge/Waypoint.lua`
- Modify: `addon/ClaudeBridge/ClaudeBridge.toc` (add `Waypoint.lua` after `ClaudeBridge.lua`)
- Create: `test/lua/waypointtest.js`
- Modify: `test/lua/run.js` (add `'waypointtest.js'` to the list)

**Interfaces:**
- Consumes: `ClaudeBridge_Print` from Task 3 (optional: `say` checks it exists).
- Produces these globals:
  - `ClaudeBridge_SetWaypoint({zone, x, y, label})`
  - `ClaudeBridge_ClearWaypoint()`
  - `ClaudeBridge_WaypointCommand(arg)`
  - `ClaudeBridge_WaypointUpdate()`
- Produces: the frame global `ClaudeBridgeArrow`, with fields `.arrow` (texture) and `.text` (font string).
- Produces: saved state `ClaudeBridgeDB.waypoint = {mapID, zone, x, y, label}` and `ClaudeBridgeDB.arrowPos`.

- [ ] **Step 1: Write the failing test.** Create `test/lua/waypointtest.js`:

```js
// Runs the real Waypoint.lua in fengari with a small fake world:
// Elwynn Forest (1429) and Westfall (1436) on Eastern Kingdoms (continent 0),
// Durotar (1411) on Kalimdor (continent 1). Zone maps are 1000 yards across.
//   node waypointtest.js <luatools dir>
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const tools = process.argv[2];
const luaparse = require(tools + '/node_modules/luaparse');
const { lua, lauxlib, lualib, to_luastring } = require(tools + '/node_modules/fengari');
const src = fs.readFileSync(path.join(__dirname, '../../addon/ClaudeBridge/Waypoint.lua'), 'utf8');
luaparse.parse(src, { luaVersion: '5.1' });

const stubs = String.raw`
EVENTS, SAID, NOW = {}, {}, 100
local function object(name)
  local o = { _name = name, _shown = false, _points = {}, _children = {} }
  return setmetatable(o, { __index = function(t, k)
    if k == "Show" then return function(self) self._shown = true end
    elseif k == "Hide" then return function(self) self._shown = false end
    elseif k == "IsShown" then return function(self) return self._shown end
    elseif k == "SetText" then return function(self, s) self._text = s end
    elseif k == "SetRotation" then return function(self, r) self._rot = r end
    elseif k == "GetWidth" then return function(self) return self._w end
    elseif k == "GetHeight" then return function(self) return self._h end
    elseif k == "SetScript" then return function(self, n, fn) self["_" .. n] = fn; if n == "OnEvent" then EVENTS[#EVENTS + 1] = fn end end
    elseif k == "HookScript" then return function(self, n, fn) self["_hook_" .. n] = fn end
    elseif k == "SetPoint" then return function(self, ...) self._points[#self._points + 1] = { ... } end
    elseif k == "ClearAllPoints" then return function(self) self._points = {} end
    elseif k == "SetStartPoint" then return function(self, _, _, x, y) self._start = { x, y } end
    elseif k == "SetEndPoint" then return function(self, _, _, x, y) self._end = { x, y } end
    elseif k == "CreateTexture" or k == "CreateFontString" or k == "CreateLine" then
      return function(self) local c = object(k); c._shown = true; self._children[#self._children + 1] = c; return c end
    end
    return function() end
  end })
end
OBJECT = object
function CreateFrame(_, name) local f = object(name); if name then _G[name] = f end; return f end
UIParent = object("UIParent")
C_Timer = { After = function() end }
GetTime = function() return NOW end
function CreateVector2D(x, y) return { x = x, y = y } end
ClaudeBridgeDB = {}
ClaudeBridge_Print = function(text) SAID[#SAID + 1] = text end

-- The fake world. World x grows north and y grows west, in yards; map x grows east, map y south.
local maps = {
  [947] = { name = "Azeroth", mapType = 1, parentMapID = 0 },
  [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947, continent = 0, ox = -5000, oy = -5000, size = 10000 },
  [1414] = { name = "Kalimdor", mapType = 2, parentMapID = 947, continent = 1, ox = -5000, oy = -5000, size = 10000 },
  [1429] = { name = "Elwynn Forest", mapType = 3, parentMapID = 1415, continent = 0, ox = 0, oy = 0, size = 1000 },
  [1436] = { name = "Westfall", mapType = 3, parentMapID = 1415, continent = 0, ox = 0, oy = 1000, size = 1000 },
  [1411] = { name = "Durotar", mapType = 3, parentMapID = 1414, continent = 1, ox = 0, oy = 0, size = 1000 },
  [9999] = { name = "Elwynn Forest", mapType = 5, parentMapID = 1429, continent = 0, ox = 0, oy = 0, size = 1000 }, -- same-named micro map
}
local function toWorld(map, mx, my)
  local m = maps[map]
  return m.continent, { x = m.ox + (1 - my) * m.size, y = m.oy + (1 - mx) * m.size }
end
local function toMap(map, w)
  local m = maps[map]
  return CreateVector2D(1 - (w.y - m.oy) / m.size, 1 - (w.x - m.ox) / m.size)
end
PLAYER, FACING, POS_OK = { map = 1429, x = 0.5, y = 0.5 }, 0, true
GetPlayerFacing = function() if POS_OK then return FACING end end
C_Map = {
  GetBestMapForUnit = function() return PLAYER.map end,
  GetMapInfo = function(id) local m = maps[id]; return m and { mapID = id, name = m.name, mapType = m.mapType, parentMapID = m.parentMapID } end,
  GetMapChildrenInfo = function(top)
    local out = {}
    for id, m in pairs(maps) do if id ~= top then out[#out + 1] = { mapID = id, name = m.name, mapType = m.mapType, parentMapID = m.parentMapID } end end
    return out
  end,
  GetPlayerMapPosition = function(map)
    if not POS_OK then return nil end
    local c, w = toWorld(PLAYER.map, PLAYER.x, PLAYER.y)
    if maps[map].continent ~= c then return nil end
    return toMap(map, w)
  end,
  GetWorldPosFromMapPos = function(map, v) return toWorld(map, v.x, v.y) end,
  GetMapPosFromWorldPos = function(c, w, map) if maps[map].continent ~= c then return nil end; return map, toMap(map, w) end,
}
`;

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
function run(code, name) {
  if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(name)) !== 0 || lua.lua_pcall(L, 0, 0, 0) !== 0) {
    throw new Error(lua.lua_tojsstring(L, -1));
  }
}
function evalStr(expr) {
  run(`RESULT = tostring(${expr})`, 'eval');
  lua.lua_getglobal(L, to_luastring('RESULT'));
  const s = lua.lua_tojsstring(L, -1);
  lua.lua_pop(L, 1);
  return s;
}
const num = (e) => Number(evalStr(e));
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);
// Load the file and fire PLAYER_LOGIN, as the game does after a /reload.
function login() {
  run(src, 'Waypoint.lua');
  run('for _, h in ipairs(EVENTS) do h(nil, "PLAYER_LOGIN") end; EVENTS = {}', 'login');
}
run(stubs, 'stubs');
login();

// The player stands at 50, 50 in Elwynn. Hogger at 50, 40 is 100 yards due north.
const hogger = '{ zone = "Elwynn Forest", x = 50, y = 40, label = "Hogger" }';

// Scenario: The arrow points at the waypoint
run(`ClaudeBridge_SetWaypoint(${hogger})`, 'set');
assert.strictEqual(num('ClaudeBridgeDB.waypoint.mapID'), 1429, 'the zone, not the same-named micro map');
assert.ok(evalStr('SAID[#SAID]').startsWith('Waypoint: Hogger, Elwynn Forest 50.0, 40.0'), evalStr('SAID[#SAID]'));
assert.strictEqual(evalStr('ClaudeBridgeArrow:IsShown()'), 'true');
near(num('ClaudeBridgeArrow.arrow._rot'), 0, 'facing north: arrow straight up');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Hogger\n100 yd');
run('FACING = math.pi / 2; ClaudeBridge_WaypointUpdate()', 'turn');
near(num('ClaudeBridgeArrow.arrow._rot'), -Math.PI / 2, 'turned left: arrow points right (clockwise)');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Hogger\n100 yd');
run('FACING = 0', 'face');

// No position (a dungeon): arrow hidden, label kept.
run('POS_OK = false; ClaudeBridge_WaypointUpdate()', 'nopos');
assert.strictEqual(evalStr('ClaudeBridgeArrow.arrow:IsShown()'), 'false');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Hogger');
run('POS_OK = true', 'pos');

// Scenario: Waypoint survives a reload
login();
run('ClaudeBridge_WaypointUpdate()', 'tick');
assert.strictEqual(evalStr('ClaudeBridgeArrow:IsShown()'), 'true');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Hogger\n100 yd');

// Scenario: Arriving clears the waypoint
run('PLAYER.y = 0.405; ClaudeBridge_WaypointUpdate()', 'arrive'); // 5 yards short
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Arrived: Hogger');
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoint'), 'nil');
assert.strictEqual(evalStr('ClaudeBridgeArrow:IsShown()'), 'true', '"Arrived" stays up for a moment');
run('NOW = 104; ClaudeBridge_WaypointUpdate()', 'later');
assert.strictEqual(evalStr('ClaudeBridgeArrow:IsShown()'), 'false');
run('PLAYER.y = 0.5', 'back');

// Scenario: A waypoint on another continent shows its zone
run('ClaudeBridge_SetWaypoint({ zone = "Durotar", x = 50, y = 50, label = "Hogger" })', 'far');
assert.strictEqual(evalStr('ClaudeBridgeArrow.arrow:IsShown()'), 'false');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Hogger: in Durotar');

// Westfall is on the same continent: distance across the zone border works.
run('ClaudeBridge_SetWaypoint({ zone = "westfall > Sentinel Hill", x = 50, y = 50, label = "Sentinel Hill" })', 'west');
assert.strictEqual(num('ClaudeBridgeDB.waypoint.mapID'), 1436);
near(num('ClaudeBridgeArrow.arrow._rot'), Math.PI / 2, 'due west: arrow points left');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Sentinel Hill\n1000 yd');

// Scenario: Clearing the waypoint by command
run('ClaudeBridge_WaypointCommand("clear")', 'clear');
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoint'), 'nil');
assert.strictEqual(evalStr('ClaudeBridgeArrow:IsShown()'), 'false');
assert.strictEqual(evalStr('SAID[#SAID]'), 'Waypoint cleared.');
run('ClaudeBridge_WaypointCommand("")', 'show');
assert.ok(evalStr('SAID[#SAID]').startsWith('No waypoint.'));

// Scenario: Unknown zone is reported
run('ClaudeBridge_SetWaypoint({ zone = "Narnia", x = 1, y = 1, label = "Lamp post" })', 'narnia');
assert.ok(evalStr('SAID[#SAID]').includes("Couldn't find the zone Narnia"), evalStr('SAID[#SAID]'));
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoint'), 'nil');

console.log('Waypoint tests passed.');
```

Add `'waypointtest.js'` to the list in `test/lua/run.js`:

```js
for (const t of ['luaencode.js', 'ctxtest.js', 'ctxtest-modern.js', 'linktest.js', 'waypointtest.js']) {
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/lua/run.js`
Expected: `ENOENT ... Waypoint.lua` from `waypointtest.js`.

- [ ] **Step 3: Write `addon/ClaudeBridge/Waypoint.lua`**

```lua
-- Claude Bridge waypoints. Claude's set_waypoint tool arrives with a reply
-- (ClaudeBridge_OnReply -> ClaudeBridge_SetWaypoint). An arrow on screen turns
-- toward the spot and counts down the yards.

local ARRIVE_YARDS = 10
local TICK = 0.05                       -- seconds between arrow updates
local atan2 = math.atan2 or math.atan   -- Lua 5.1 in WoW, 5.3 in the offline tests

local arrow                             -- built on first use
local arrivedUntil = 0                  -- keep "Arrived" on screen until this GetTime()

local function say(text, r, g, b)
  if ClaudeBridge_Print then ClaudeBridge_Print(text, r, g, b) end
end

-- The zone's uiMapID, found by name among all maps under the top world map.
-- Same-named maps (a zone and its micro map): the bigger one, i.e. lower mapType.
local function findMap(zone)
  local want = zone:gsub("%s*>.*$", ""):lower() -- "Westfall > Sentinel Hill" -> "westfall"
  local top = C_Map.GetBestMapForUnit("player")
    or (C_Map.GetFallbackWorldMapID and C_Map.GetFallbackWorldMapID())
  local info = top and C_Map.GetMapInfo(top)
  while info and info.parentMapID and info.parentMapID ~= 0 do
    top = info.parentMapID
    info = C_Map.GetMapInfo(top)
  end
  if not top then return nil end
  local best
  for _, m in ipairs(C_Map.GetMapChildrenInfo(top, nil, true) or {}) do
    if m.name and m.name:lower() == want and (not best or m.mapType < best.mapType) then best = m end
  end
  return best and best.mapID
end

-- Where the waypoint is from the player:
--   "ok", yards, angle (radians, counterclockwise, 0 = straight ahead)
--   "elsewhere" (another continent) or "hidden" (no position, e.g. dungeons).
local function relative(wp)
  local map = C_Map.GetBestMapForUnit("player")
  local pp = map and C_Map.GetPlayerMapPosition(map, "player")
  local facing = GetPlayerFacing()
  if not (pp and facing) then return "hidden" end
  local pc, pw = C_Map.GetWorldPosFromMapPos(map, pp)
  local tc, tw = C_Map.GetWorldPosFromMapPos(wp.mapID, CreateVector2D(wp.x / 100, wp.y / 100))
  if not (pw and tw) then return "hidden" end
  if pc ~= tc then return "elsewhere" end
  -- World positions: x grows to the north, y to the west, in yards.
  local north, west = tw.x - pw.x, tw.y - pw.y
  return "ok", math.sqrt(north * north + west * west), atan2(west, north) - facing
end

local function buildArrow()
  local f = CreateFrame("Frame", "ClaudeBridgeArrow", UIParent)
  f:SetSize(140, 80)
  local p = ClaudeBridgeDB.arrowPos
  if p then f:SetPoint(p[1], UIParent, p[2], p[3], p[4]) else f:SetPoint("TOP", UIParent, "TOP", 0, -120) end
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self) self:StartMoving() end)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, relPoint, x, y = self:GetPoint()
    ClaudeBridgeDB.arrowPos = { point, relPoint, x, y }
  end)
  f:SetScript("OnMouseUp", function(_, button)
    if button == "RightButton" then ClaudeBridge_ClearWaypoint() end
  end)
  f.arrow = f:CreateTexture(nil, "ARTWORK")
  f.arrow:SetSize(48, 48)
  f.arrow:SetPoint("TOP")
  f.arrow:SetTexture("Interface\\Minimap\\MinimapArrow")
  f.text = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  f.text:SetPoint("TOP", f.arrow, "BOTTOM", 0, -2)
  local acc = 0
  f:SetScript("OnUpdate", function(self, elapsed)
    acc = acc + elapsed
    if acc < TICK then return end
    acc = 0
    local ok, err = pcall(ClaudeBridge_WaypointUpdate)
    if not ok then -- don't throw every frame; hide and leave a note for debugging
      self:Hide()
      ClaudeBridgeDB.waypointError = tostring(err)
    end
  end)
  arrow = f
end

function ClaudeBridge_WaypointUpdate()
  local wp = ClaudeBridgeDB.waypoint
  if not wp then
    if arrow and GetTime() >= arrivedUntil then arrow:Hide() end
    return
  end
  if not arrow then buildArrow() end
  arrow:Show()
  local state, yards, angle = relative(wp)
  if state == "ok" and yards <= ARRIVE_YARDS then
    ClaudeBridgeDB.waypoint = nil
    arrivedUntil = GetTime() + 3
    arrow.arrow:Hide()
    arrow.text:SetText("Arrived: " .. wp.label)
  elseif state == "ok" then
    arrow.arrow:SetRotation(angle)
    arrow.arrow:Show()
    arrow.text:SetText(string.format("%s\n%d yd", wp.label, math.floor(yards + 0.5)))
  elseif state == "elsewhere" then
    arrow.arrow:Hide()
    arrow.text:SetText(wp.label .. ": in " .. wp.zone)
  else
    arrow.arrow:Hide()
    arrow.text:SetText(wp.label)
  end
end

function ClaudeBridge_ClearWaypoint()
  ClaudeBridgeDB.waypoint = nil
  arrivedUntil = 0
  if arrow then arrow:Hide() end
end

local function describe(wp)
  return string.format("Waypoint: %s, %s %.1f, %.1f. /claude way clear removes it.", wp.label, wp.zone, wp.x, wp.y)
end

-- Called with the waypoint that came with Claude's answer.
function ClaudeBridge_SetWaypoint(w)
  local mapID = findMap(w.zone)
  if not mapID then
    say("Couldn't find the zone " .. w.zone .. " on the map, so no arrow.", 1, 0.3, 0.3)
    return
  end
  local zone = w.zone:gsub("%s*>.*$", "")
  ClaudeBridgeDB.waypoint = { mapID = mapID, zone = zone, x = w.x, y = w.y, label = w.label }
  arrivedUntil = 0
  say(describe(ClaudeBridgeDB.waypoint))
  ClaudeBridge_WaypointUpdate()
end

-- /claude way [clear]
function ClaudeBridge_WaypointCommand(arg)
  if arg == "clear" then
    ClaudeBridge_ClearWaypoint()
    say("Waypoint cleared.")
  elseif ClaudeBridgeDB.waypoint then
    say(describe(ClaudeBridgeDB.waypoint))
  else
    say("No waypoint. Ask Claude where something is to get one.")
  end
end

local ev = CreateFrame("Frame")
ev:RegisterEvent("PLAYER_LOGIN")
ev:SetScript("OnEvent", function()
  if ClaudeBridgeDB.waypoint then ClaudeBridge_WaypointUpdate() end
end)
```

Note on the zone in `SetWaypoint`: `w.zone:gsub(...)` returns two values, and assigning them to a single `local zone` keeps only the string.

`addon/ClaudeBridge/ClaudeBridge.toc`: the file list becomes

```
config.lua
ClaudeBridge.lua
Waypoint.lua
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node test/lua/run.js`
Expected: `Waypoint tests passed.` and `All Lua tests passed.`

- [ ] **Step 5: Commit**

```bash
git add addon/ClaudeBridge/Waypoint.lua addon/ClaudeBridge/ClaudeBridge.toc test/lua/waypointtest.js test/lua/run.js
git commit -m "Waypoint arrow: zone lookup, distance and direction, arrive, clear, survives reload"
```

---

### Task 5: World map pin and line

**Satisfies:** "The world map shows a pin and a line"

**Files:**
- Modify: `addon/ClaudeBridge/Waypoint.lua` (append a section)
- Modify: `test/lua/waypointtest.js` (append before the final `console.log`)

**Interfaces:**
- Consumes: `ClaudeBridgeDB.waypoint` (Task 4), `WorldMapFrame.ScrollContainer.Child` (the map canvas), `WorldMapFrame:GetMapID()`.
- Produces: global `ClaudeBridge_WaypointMapUpdate()`. The pin is the canvas's first created texture and the line its first created line.

- [ ] **Step 1: Write the failing test.** Insert before `console.log('Waypoint tests passed.');`:

```js
// Scenario: The world map shows a pin and a line
run(`WorldMapFrame = OBJECT("WorldMapFrame")
  WorldMapFrame.ScrollContainer = { Child = OBJECT("Canvas") }
  WorldMapFrame.ScrollContainer.Child._w, WorldMapFrame.ScrollContainer.Child._h = 1000, 667
  WorldMapFrame.GetMapID = function() return MAP_SHOWN end
  MAP_SHOWN = 1429`, 'map');
login(); // hooks the map at PLAYER_LOGIN
run('PLAYER = { map = 1429, x = 0.5, y = 0.5 }; ClaudeBridge_SetWaypoint({ zone = "Elwynn Forest", x = 25.6, y = 78.4, label = "Hogger" })', 'mset');
run('WorldMapFrame:Show(); WorldMapFrame._hook_OnUpdate(WorldMapFrame, 0.2)', 'mtick');
run('PIN, LINE = WorldMapFrame.ScrollContainer.Child._children[1], WorldMapFrame.ScrollContainer.Child._children[2]', 'mget');
assert.strictEqual(evalStr('PIN:IsShown()'), 'true');
assert.strictEqual(evalStr('PIN._points[1][1]'), 'CENTER');
near(num('PIN._points[1][4]'), 256, 'pin x on canvas');
near(num('PIN._points[1][5]'), -0.784 * 667, 'pin y on canvas');
assert.strictEqual(evalStr('LINE:IsShown()'), 'true');
near(num('LINE._start[1]'), 500, 'line starts at the player (x)');
near(num('LINE._start[2]'), -0.5 * 667, 'line starts at the player (y)');
near(num('LINE._end[1]'), 256, 'line ends at the pin (x)');
near(num('LINE._end[2]'), -0.784 * 667, 'line ends at the pin (y)');
// A map that doesn't contain the spot shows neither.
run('MAP_SHOWN = 1411; WorldMapFrame._hook_OnUpdate(WorldMapFrame, 0.2)', 'mother');
assert.strictEqual(evalStr('PIN:IsShown()'), 'false');
assert.strictEqual(evalStr('LINE:IsShown()'), 'false');
run('MAP_SHOWN = 1429; ClaudeBridge_ClearWaypoint(); WorldMapFrame._hook_OnUpdate(WorldMapFrame, 0.2)', 'mclear');
assert.strictEqual(evalStr('PIN:IsShown()'), 'false');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/lua/run.js`
Expected: an error calling `_hook_OnUpdate`, because it is nil (nothing hooks the map yet).

- [ ] **Step 3: Append to `Waypoint.lua`**

```lua
----------------------------------------------------------------------------
-- World map: a pin on the waypoint and a line from the player to it
----------------------------------------------------------------------------

local pin, line, mapHooked

function ClaudeBridge_WaypointMapUpdate()
  local canvas = WorldMapFrame and WorldMapFrame.ScrollContainer and WorldMapFrame.ScrollContainer.Child
  if not canvas then return end
  if not pin then
    pin = canvas:CreateTexture(nil, "OVERLAY")
    pin:SetSize(24, 24)
    pin:SetTexture("Interface\\TargetingFrame\\UI-RaidTargetingIcon_1")
    line = canvas:CreateLine(nil, "OVERLAY")
    line:SetThickness(4)
    line:SetColorTexture(1, 0.82, 0, 0.8)
  end
  pin:Hide()
  line:Hide()
  local wp = ClaudeBridgeDB.waypoint
  if not (wp and WorldMapFrame:IsShown()) then return end
  local shown = WorldMapFrame:GetMapID()
  local tc, tw = C_Map.GetWorldPosFromMapPos(wp.mapID, CreateVector2D(wp.x / 100, wp.y / 100))
  if not tw then return end
  local _, t = C_Map.GetMapPosFromWorldPos(tc, tw, shown)
  if not t or t.x < 0 or t.x > 1 or t.y < 0 or t.y > 1 then return end -- not on this map
  local w, h = canvas:GetWidth(), canvas:GetHeight()
  pin:ClearAllPoints()
  pin:SetPoint("CENTER", canvas, "TOPLEFT", t.x * w, -t.y * h)
  pin:Show()
  local p = C_Map.GetPlayerMapPosition(shown, "player")
  if p then
    line:SetStartPoint("TOPLEFT", canvas, p.x * w, -p.y * h)
    line:SetEndPoint("TOPLEFT", canvas, t.x * w, -t.y * h)
    line:Show()
  end
end

local function hookMap()
  if mapHooked or not WorldMapFrame then return end
  mapHooked = true
  local acc = 0
  WorldMapFrame:HookScript("OnUpdate", function(_, elapsed)
    acc = acc + elapsed
    if acc < 0.1 then return end
    acc = 0
    local ok, err = pcall(ClaudeBridge_WaypointMapUpdate)
    if not ok then ClaudeBridgeDB.waypointError = tostring(err) end
  end)
end

local mapEv = CreateFrame("Frame")
mapEv:RegisterEvent("PLAYER_LOGIN")
mapEv:RegisterEvent("ADDON_LOADED") -- in case the world map addon loads later
mapEv:SetScript("OnEvent", hookMap)
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node test/lua/run.js`
Expected: `Waypoint tests passed.` and `All Lua tests passed.`

- [ ] **Step 5: Commit**

```bash
git add addon/ClaudeBridge/Waypoint.lua test/lua/waypointtest.js
git commit -m "Waypoint: pin and line on the world map"
```

---

### Task 6: README, install, in-game check

**Satisfies:** none (ships and verifies the scenarios above in the real game).

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README.** Add this row to the commands table, after `/claude context`:

```
| `/claude way` | Show the waypoint Claude set. `way clear` removes it (or right-click the arrow). |
```

Add this bullet under "Things to know", after the shift-click bullet:

```
- **Waypoints.** Ask where something is ("where's the Westfall flight master?") and
  Claude can set a waypoint: an arrow at the top of the screen turns toward it and
  shows the yards, and the world map shows a pin with a line from you. Drag the arrow
  to move it. It clears itself within 10 yards.
```

Change the "Answer-only" bullet's first sentence to:

```
- **Answer-only.** Claude can search and read the web and set waypoints, but can't edit files or run commands.
```

Add to the Files list:

```
- `bridge/waypoint-mcp.js`: the set_waypoint tool (a tiny MCP server Claude Code starts)
```

- [ ] **Step 2: Run all tests**

Run: `node bridge/test.js` and `node test/lua/run.js`
Expected: `All bridge tests passed.` and `All Lua tests passed.`

- [ ] **Step 3: Commit and install**

```bash
git add README.md
git commit -m "README: waypoints"
node bridge/setup.js
```

Then restart the bridge (Ctrl+C in its terminal, then `node bridge\bridge.js`) and `/reload` in game. A new file in the toc needs a full client restart if `/reload` doesn't pick it up.

- [ ] **Step 4: In-game check (the player)**

1. Ask "where is the nearest flight master?". The bridge log shows `Waypoint: ...`, the Claude window shows `Waypoint: ...`, and the arrow appears.
2. Walk toward it. The yards go down, and the arrow points ahead when you face the spot.
3. Open the world map. A star pin and a gold line from you to it.
4. `/reload`. The arrow comes back.
5. `/claude way clear`. The arrow goes away.

If the arrow is off: face north (the minimap's N at the top) with a waypoint due north. If the arrow points sideways, the world axes are swapped: in `relative`, swap `tw.x`/`tw.y` and `pw.x`/`pw.y`. If it points up but east and west come out reversed, negate the angle (`SetRotation(-angle)`). Adjust `waypointtest.js`'s fake world to match and re-run it. Also check the map pin and line draw above the map tiles; if nothing shows, `/dump ClaudeBridgeDB.waypointError`.
