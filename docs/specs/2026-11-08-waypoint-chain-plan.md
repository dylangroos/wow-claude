# Waypoint Chains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude can set an ordered list of stops with a new `set_waypoints` tool. The arrow walks you through them one by one, and Claude sees which stops are left.

**Architecture:** The MCP server records every set as a `{"stops":[...]}` line (`set_waypoint` writes a chain of one). The bridge sends the last chain with the answer as `extra.waypoints`. `Waypoint.lua` keeps `ClaudeBridgeDB.waypoints = { stops, current }`, moves on to the next stop on arrival, and gives `ClaudeBridge.lua` a `way` character-info field through `ClaudeBridge_WaypointContext()`.

**Tech Stack:** Node 18+ with no npm packages (bridge), WoW Lua 5.1 (addon), fengari + luaparse for the offline addon tests (installed in `test/lua/.tools`, gitignored).

**Spec:** `docs/specs/2026-11-08-waypoint-chain-design.md`

**Runner:** none. Plain `assert` tests with a `// Scenario: <name>` comment above each scenario's checks, as in the existing tests: `node bridge/test.js` (server and bridge) and `node test/lua/run.js` (addon).

## Global Constraints

- Bridge: Node 18+, **no npm packages**.
- No in-game character names anywhere in the repo, tests included. Tests use `Testmage`.
- Nothing automates gameplay. The addon only shows things.
- Stop input limits (unchanged from waypoints): zone is text, 1-60 characters; x and y are numbers from 0 to 100; label is text, 1-40 characters.
- A chain holds 1 to 10 stops.
- Tool names as Claude sees them: `mcp__wow__set_waypoint`, `mcp__wow__set_waypoints`, `mcp__wow__clear_waypoint`.
- Arrival distance: 10 yards (unchanged).
- Character-info field key `way`, bridge label `Waypoints (the arrow's route)`, value `none` when no chain is set.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Before you start

The Lua test tools are not in git. Install them once, then check that both suites pass before changing anything:

```bash
npm install --prefix test/lua/.tools fengari luaparse
```

```bash
node bridge/test.js
```

```bash
node test/lua/run.js
```

Expected: `All bridge tests passed.` and `All Lua tests passed.`

## File Structure

- Modify `bridge/waypoint-mcp.js`: the `set_waypoints` tool, `checkStops`, and `set_waypoint` writing a chain of one.
- Modify `bridge/waypoint-mcp.test.js`: server tests for chains.
- Modify `addon/ClaudeBridge/Waypoint.lua`: chain state, `ClaudeBridge_SetWaypoints`, moving on at arrival, `/claude way` list, map on the current stop, migration of the old single waypoint, `ClaudeBridge_WaypointContext`.
- Modify `test/lua/waypointtest.js`: the addon's chain tests.
- Modify `bridge/protocol.js`: `slotLua` writes `waypoints`, and the `way` label.
- Modify `bridge/bridge.js`: allowed tools, system prompt, `readWaypointAction`, the log line.
- Modify `bridge/test.js`: fake Claude plays `set_waypoints`, and the bridge chain tests.
- Modify `addon/ClaudeBridge/ClaudeBridge.lua`: `OnReply` hands `extra.waypoints` to `ClaudeBridge_SetWaypoints`, plus the `way` reader.
- Modify `test/lua/linkcases.js`: hook tests for `waypoints` and the `way` field.
- Modify `README.md`.
- Modify `docs/specs/2026-11-08-waypoint-chain-design.md`: point "Plan to follow" at this file.

---

### Task 1: Waypoint server accepts chains

**Satisfies:** "A chain of stops is recorded in order", "A bad stop rejects the whole chain", "The number of stops is limited", "set_waypoint records a chain of one"

**Files:**
- Modify: `bridge/waypoint-mcp.js`
- Test: `bridge/waypoint-mcp.test.js`

**Interfaces:**
- Consumes: `checkWaypoint(w)` (exists).
- Produces: `checkStops(stops) -> string | null` (exported; Task 3's bridge uses it). Action lines are now `{"stops":[{zone,x,y,label}, ...]}` or `{"clear":true}`. Tool order in `tools/list`: `set_waypoint`, `set_waypoints`, `clear_waypoint`.

- [ ] **Step 1: Write the failing tests**

In `bridge/waypoint-mcp.test.js`, change the tool list check:

```js
    assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['set_waypoint', 'set_waypoints', 'clear_waypoint']);
```

Replace the check after the good `set_waypoint` call:

```js
    // Scenario: set_waypoint records a chain of one
    const good = await call('tools/call', { name: 'set_waypoint', arguments: { zone: ' Elwynn Forest ', x: 25.6, y: 78.4, label: 'Hogger' } });
    assert.ok(!good.result.isError, JSON.stringify(good));
    assert.strictEqual(good.result.content[0].text, 'Waypoint set: Hogger in Elwynn Forest at 25.6, 78.4.');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { stops: [{ zone: 'Elwynn Forest', x: 25.6, y: 78.4, label: 'Hogger' }] });
```

Right after the `clear_waypoint` checks (before `resources/list`), add:

```js
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
      } else {
        assert.strictEqual(res.result.isError, true, `${count} stops`);
        assert.match(res.result.content[0].text, /stops must be a list of 1-10 stops/);
        assert.strictEqual(lineCount(), n, `${count} stops: nothing written`);
      }
    }
    const noStops = await call('tools/call', { name: 'set_waypoints', arguments: {} });
    assert.match(noStops.result.content[0].text, /stops must be a list of 1-10 stops/);
```

At the bottom, next to the `checkWaypoint` unit checks, change the `require` line and add:

```js
  const { checkWaypoint, checkStops, handle } = require('./waypoint-mcp');
```

```js
  assert.strictEqual(checkStops([{ zone: 'Westfall', x: 1, y: 1, label: 'a' }]), null);
  assert.match(checkStops('nope'), /1-10 stops/);
  assert.match(checkStops([{ zone: 'Westfall', x: 1, y: 1, label: 'a' }, { zone: '', x: 1, y: 1, label: 'b' }]), /^stop 2: zone/);
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `node bridge/test.js`
Expected: FAIL in the tool list check (`set_waypoints` missing).

- [ ] **Step 3: Write the implementation**

In `bridge/waypoint-mcp.js`, update the header comment so it says each good call is appended as `{stops:[...]}` or `{clear:true}`. Add after `TOOL`:

```js
const MAX_STOPS = 10;

const ROUTE_TOOL = {
  name: 'set_waypoints',
  description: 'Point the player through several spots in order: the arrow points at the first stop and '
    + 'moves on to the next when they arrive. Use it for a route (legs to one place) or several places to '
    + 'visit (start with the one nearest the player). Calling it again replaces the whole route, so use it '
    + 'to skip, add or reorder stops. Same zone names and coordinates as set_waypoint. Never guess coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      stops: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_STOPS,
        description: 'The stops in travel order',
        items: TOOL.inputSchema,
      },
    },
    required: ['stops'],
  },
};
```

After `checkWaypoint`, add:

```js
// Returns an error message naming the bad stop, or null when the list is good.
function checkStops(stops) {
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAX_STOPS) {
    return `stops must be a list of 1-${MAX_STOPS} stops`;
  }
  for (let i = 0; i < stops.length; i++) {
    const err = checkWaypoint(stops[i]);
    if (err) return `stop ${i + 1}: ${err}`;
  }
  return null;
}

const cleanStop = (a) => ({ zone: a.zone.trim(), x: a.x, y: a.y, label: a.label.trim() });
```

In `handle`, make `tools/list` return `{ tools: [TOOL, ROUTE_TOOL, CLEAR_TOOL] }`, and change `tools/call` to:

```js
    case 'tools/call': {
      if (p.name === CLEAR_TOOL.name) return record(file, { clear: true }, 'Waypoint cleared.');
      if (p.name === ROUTE_TOOL.name) {
        const stops = p.arguments && p.arguments.stops;
        const err = checkStops(stops);
        if (err) return { isError: true, content: [{ type: 'text', text: `Route not set: ${err}.` }] };
        const clean = stops.map(cleanStop);
        return record(file, { stops: clean }, `Route set: ${clean.length} stops, first ${clean[0].label} in ${clean[0].zone}.`);
      }
      if (p.name !== TOOL.name) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${p.name}.` }] };
      const err = checkWaypoint(p.arguments);
      if (err) return { isError: true, content: [{ type: 'text', text: `Waypoint not set: ${err}.` }] };
      const w = cleanStop(p.arguments);
      return record(file, { stops: [w] }, `Waypoint set: ${w.label} in ${w.zone} at ${w.x}, ${w.y}.`);
    }
```

Export it: `module.exports = { TOOL, checkWaypoint, checkStops, handle };`

- [ ] **Step 4: Run the tests to check they pass**

Run: `node bridge/test.js`
Expected: `Waypoint server tests passed.`, then `All bridge tests passed.` (the bridge and its fake Claude keep the old line format until Task 3).

- [ ] **Step 5: Commit**

```bash
git add bridge/waypoint-mcp.js bridge/waypoint-mcp.test.js
git commit -m "Waypoint server: set_waypoints takes a list of stops" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The arrow follows a chain

**Satisfies:** "A new chain starts at the first stop", "Arriving at a middle stop moves on to the next", "Arriving at the last stop clears the chain", "A chain of one shows no counter", "A stop in another continent shows its zone and place in the chain", "An unknown zone rejects the whole chain", "Clearing removes the whole chain", "The way command lists the chain", "The world map shows only the current stop", "A chain survives a reload", "A waypoint saved by the previous version carries over", "Character info lists the stops still to visit"

**Files:**
- Modify: `addon/ClaudeBridge/Waypoint.lua`
- Test: `test/lua/waypointtest.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (globals): `ClaudeBridge_SetWaypoints(list)` where `list` is `{ {zone, x, y, label}, ... }`; `ClaudeBridge_SetWaypoint(w)` stays, as a chain of one; `ClaudeBridge_WaypointContext() -> string` (`"none"` or `"stop 2 of 3. Now: ... Then: ..."`); `ClaudeBridge_ClearWaypoint()`, `ClaudeBridge_WaypointCommand(arg)`, `ClaudeBridge_WaypointUpdate()` and `ClaudeBridge_WaypointMapUpdate()` keep their names. Saved data: `ClaudeBridgeDB.waypoints = { stops = { {mapID, zone, x, y, label}, ... }, current = n }`; `ClaudeBridgeDB.waypoint` is gone.

- [ ] **Step 1: Update the existing tests to the new saved data**

In `test/lua/waypointtest.js`, replace every `ClaudeBridgeDB.waypoint.` with `ClaudeBridgeDB.waypoints.stops[1].` (the `mapID` and `zone` checks), and every `evalStr('ClaudeBridgeDB.waypoint')` with `evalStr('ClaudeBridgeDB.waypoints')`. The rest of the existing tests stay as they are: they use `ClaudeBridge_SetWaypoint`, which now sets a chain of one.

- [ ] **Step 2: Write the failing chain tests**

In `test/lua/waypointtest.js`, insert before the final `console.log('Waypoint tests passed.');`:

```js
// ---- chains ----
// Murloc camp is 100 yards north of the player, Cave 200, Hogger 300, all in Elwynn.
run('ClaudeBridge_ClearWaypoint(); WorldMapFrame:Hide(); PLAYER = { map = 1429, x = 0.5, y = 0.5 }; FACING = 0; NOW = 200', 'c0');
const route = `{ { zone = "Elwynn Forest", x = 50, y = 40, label = "Murloc camp" },
  { zone = "Elwynn Forest", x = 50, y = 30, label = "Cave" },
  { zone = "Elwynn Forest", x = 50, y = 20, label = "Hogger" } }`;
const said = () => { const n = num('#SAID'); return Array.from({ length: n }, (_, i) => evalStr(`SAID[${i + 1}]`)); };

// Scenario: A new chain starts at the first stop
run(`SAID = {}; ClaudeBridge_SetWaypoints(${route})`, 'c1');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Murloc camp (1/3)\n100 yd');
assert.deepStrictEqual(said(), [
  'Route, stop 1 of 3. /claude way clear removes it.',
  '1. Murloc camp, Elwynn Forest 50.0, 40.0 <- now',
  '2. Cave, Elwynn Forest 50.0, 30.0',
  '3. Hogger, Elwynn Forest 50.0, 20.0',
]);

// Scenario: Arriving at a middle stop moves on to the next
run('SAID = {}; PLAYER.y = 0.405; ClaudeBridge_WaypointUpdate()', 'c2'); // 5 yards short of Murloc camp
assert.deepStrictEqual(said(), ['Arrived: Murloc camp. Next: Cave (2 of 3).']);
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Cave (2/3)\n105 yd');
assert.strictEqual(num('ClaudeBridgeDB.waypoints.current'), 2);

// Scenario: The way command lists the chain
run('SAID = {}; ClaudeBridge_WaypointCommand("")', 'c3');
assert.deepStrictEqual(said(), [
  'Route, stop 2 of 3. /claude way clear removes it.',
  '1. Murloc camp, Elwynn Forest 50.0, 40.0 (done)',
  '2. Cave, Elwynn Forest 50.0, 30.0 <- now',
  '3. Hogger, Elwynn Forest 50.0, 20.0',
]);

// Scenario: The world map shows only the current stop
run('PLAYER.y = 0.5; MAP_SHOWN = 1429; WorldMapFrame:Show(); WorldMapFrame._hook_OnUpdate(WorldMapFrame, 0.2)', 'c4');
assert.strictEqual(num('#ClaudeBridgeMapOverlay._children'), 2, 'one pin and one line, nothing per stop');
assert.strictEqual(evalStr('PIN:IsShown()'), 'true');
near(num('PIN._points[1][4]'), 500, 'pin on Cave (x)');
near(num('PIN._points[1][5]'), -0.3 * 667, 'pin on Cave (y)');
near(num('LINE._end[2]'), -0.3 * 667, 'line ends at Cave');
run('WorldMapFrame:Hide()', 'c4b');

// Scenario: A chain survives a reload
login();
assert.ok(evalStr('ClaudeBridgeArrow.text._text').startsWith('Cave (2/3)'), evalStr('ClaudeBridgeArrow.text._text'));

// Scenario: Clearing removes the whole chain
run('ClaudeBridge_WaypointCommand("clear")', 'c5');
assert.strictEqual(evalStr('ClaudeBridgeArrow:IsShown()'), 'false');
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints'), 'nil');

// Scenario: Arriving at the last stop clears the chain
run(`ClaudeBridge_SetWaypoints(${route}); ClaudeBridgeDB.waypoints.current = 3; PLAYER.y = 0.205; ClaudeBridge_WaypointUpdate()`, 'c6');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Arrived: Hogger');
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints'), 'nil');
run('PLAYER.y = 0.5; NOW = 300; ClaudeBridge_WaypointUpdate()', 'c6b');

// Scenario: A chain of one shows no counter
run('ClaudeBridge_SetWaypoints({ { zone = "Elwynn Forest", x = 50, y = 40, label = "Hogger" } })', 'c7');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Hogger\n100 yd');

// Scenario: An unknown zone rejects the whole chain
run(`SAID = {}; ClaudeBridge_SetWaypoints({ { zone = "Elwynn Forest", x = 1, y = 1, label = "A" }, { zone = "Narnia", x = 1, y = 1, label = "Lamp post" } })`, 'c8');
assert.ok(said().some((l) => l.includes("Couldn't find the zone Narnia")), said().join(' | '));
assert.strictEqual(num('#ClaudeBridgeDB.waypoints.stops'), 1);
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints.stops[1].label'), 'Hogger');

// Scenario: A stop in another continent shows its zone and place in the chain
run(`ClaudeBridge_SetWaypoints({ { zone = "Elwynn Forest", x = 50, y = 40, label = "Murloc camp" },
  { zone = "Durotar", x = 50, y = 50, label = "Cave" }, { zone = "Elwynn Forest", x = 50, y = 20, label = "Hogger" } })
  ClaudeBridgeDB.waypoints.current = 2; ClaudeBridge_WaypointUpdate()`, 'c9');
assert.strictEqual(evalStr('ClaudeBridgeArrow.arrow:IsShown()'), 'false');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Cave (2/3): in Durotar');

// Scenario: Character info lists the stops still to visit
run(`ClaudeBridgeDB.waypoints = { current = 2, stops = {
  { mapID = 1436, zone = "Westfall", x = 45.2, y = 33.1, label = "Murloc camp" },
  { mapID = 1429, zone = "Elwynn Forest", x = 40, y = 20.1, label = "Cave" },
  { mapID = 1429, zone = "Elwynn Forest", x = 25.6, y = 78.4, label = "Hogger" } } }`, 'c10');
assert.strictEqual(evalStr('ClaudeBridge_WaypointContext()'),
  'stop 2 of 3. Now: Cave, Elwynn Forest 40.0, 20.1. Then: Hogger, Elwynn Forest 25.6, 78.4');
run('ClaudeBridge_ClearWaypoint()', 'c11');
assert.strictEqual(evalStr('ClaudeBridge_WaypointContext()'), 'none');

// Scenario: A waypoint saved by the previous version carries over
run('ClaudeBridgeDB.waypoint = { mapID = 1429, zone = "Elwynn Forest", x = 50, y = 40, label = "Hogger" }', 'c12');
login();
assert.ok(evalStr('ClaudeBridgeArrow.text._text').startsWith('Hogger'), evalStr('ClaudeBridgeArrow.text._text'));
assert.strictEqual(num('#ClaudeBridgeDB.waypoints.stops'), 1);
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints.stops[1].label'), 'Hogger');
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoint'), 'nil');
run('ClaudeBridge_ClearWaypoint()', 'c13');
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `node test/lua/run.js`
Expected: FAIL in `waypointtest.js` (Step 1's renames fail first: `ClaudeBridgeDB.waypoints` is nil).

- [ ] **Step 4: Write the implementation**

In `addon/ClaudeBridge/Waypoint.lua`:

Update the header comment so it says a reply can carry a chain (`ClaudeBridge_OnReply -> ClaudeBridge_SetWaypoints`), saved in `ClaudeBridgeDB.waypoints = { stops, current }`.

After `say`, add:

```lua
-- The waypoint saved by the previous version (one spot) becomes a chain of one.
local function migrate()
  local old = ClaudeBridgeDB.waypoint
  if not old then return end
  ClaudeBridgeDB.waypoint = nil
  if old.mapID then ClaudeBridgeDB.waypoints = { stops = { old }, current = 1 } end
end

-- The current stop's name for the arrow: "Cave (2/3)", or just "Hogger" for a chain of one.
local function stopName(c)
  local s = c.stops[c.current]
  if #c.stops == 1 then return s.label end
  return string.format("%s (%d/%d)", s.label, c.current, #c.stops)
end

local function at(s)
  return string.format("%s, %s %.1f, %.1f", s.label, s.zone, s.x, s.y)
end
```

Replace `ClaudeBridge_WaypointUpdate` with:

```lua
function ClaudeBridge_WaypointUpdate()
  local c = ClaudeBridgeDB.waypoints
  if not c then
    if arrow and GetTime() >= arrivedUntil then arrow:Hide() end
    return
  end
  if not arrow then buildArrow() end
  arrow:Show()
  local wp = c.stops[c.current]
  local name = stopName(c)
  local state, yards, angle = relative(wp)
  if state == "ok" and yards <= ARRIVE_YARDS then
    if c.current < #c.stops then
      c.current = c.current + 1
      say(string.format("Arrived: %s. Next: %s (%d of %d).", wp.label, c.stops[c.current].label, c.current, #c.stops))
      return ClaudeBridge_WaypointUpdate() -- point at the next stop right away
    end
    ClaudeBridgeDB.waypoints = nil
    arrivedUntil = GetTime() + 3
    arrow.arrow:Hide()
    arrow.text:SetText("Arrived: " .. wp.label)
  elseif state == "ok" then
    arrow.arrow:SetRotation(angle)
    arrow.arrow:Show()
    arrow.text:SetText(string.format("%s\n%d yd", name, math.floor(yards + 0.5)))
  elseif state == "elsewhere" then
    arrow.arrow:Hide()
    arrow.text:SetText(name .. ": in " .. wp.zone)
  else
    arrow.arrow:Hide()
    arrow.text:SetText(name)
  end
end
```

In `ClaudeBridge_ClearWaypoint`, change `ClaudeBridgeDB.waypoint = nil` to `ClaudeBridgeDB.waypoints = nil`.

Replace `describe` and `ClaudeBridge_SetWaypoint` with:

```lua
-- Prints the chain: one line for a single waypoint, else a header and one line per stop.
local function describe(c)
  if #c.stops == 1 then
    say("Waypoint: " .. at(c.stops[1]) .. ". /claude way clear removes it.")
    return
  end
  say(string.format("Route, stop %d of %d. /claude way clear removes it.", c.current, #c.stops))
  for i, s in ipairs(c.stops) do
    local mark = (i < c.current and " (done)") or (i == c.current and " <- now") or ""
    say(string.format("%d. %s%s", i, at(s), mark))
  end
end

-- Called with the chain that came with Claude's answer: { {zone, x, y, label}, ... }.
-- Every zone is looked up first; one unknown zone rejects the whole chain.
function ClaudeBridge_SetWaypoints(list)
  local stops = {}
  for i, w in ipairs(list) do
    local mapID = findMap(w.zone)
    if not mapID then
      say("Couldn't find the zone " .. w.zone .. " on the map, so no arrow.", 1, 0.3, 0.3)
      return
    end
    local info = C_Map.GetMapInfo(mapID)
    local zone = (info and info.name) or w.zone:gsub("%s*>.*$", "") -- the game's own spelling
    stops[i] = { mapID = mapID, zone = zone, x = w.x, y = w.y, label = w.label }
  end
  if #stops == 0 then return end
  ClaudeBridgeDB.waypoints = { stops = stops, current = 1 }
  ClaudeBridgeDB.waypointError = nil
  arrivedUntil = 0
  describe(ClaudeBridgeDB.waypoints)
  ClaudeBridge_WaypointUpdate()
end

-- A single waypoint: a chain of one.
function ClaudeBridge_SetWaypoint(w)
  ClaudeBridge_SetWaypoints({ w })
end

-- The "way" character-info field: where the chain stands, so Claude can skip or change stops.
function ClaudeBridge_WaypointContext()
  local c = ClaudeBridgeDB.waypoints
  if not c then return "none" end
  local s = string.format("stop %d of %d. Now: %s", c.current, #c.stops, at(c.stops[c.current]))
  local rest = {}
  for i = c.current + 1, #c.stops do rest[#rest + 1] = at(c.stops[i]) end
  if #rest > 0 then s = s .. ". Then: " .. table.concat(rest, "; ") end
  return s
end
```

In `ClaudeBridge_WaypointCommand`, change `ClaudeBridgeDB.waypoint` (both places) to `ClaudeBridgeDB.waypoints`.

In the `PLAYER_LOGIN` handler, change the first line to:

```lua
  migrate()
  if not ClaudeBridgeDB.waypoints then return end
```

In `ClaudeBridge_WaypointMapUpdate`, change `local wp = ClaudeBridgeDB.waypoint` to:

```lua
  local c = ClaudeBridgeDB.waypoints
  local wp = c and c.stops[c.current]
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `node test/lua/run.js`
Expected: `Waypoint tests passed.`, then `All Lua tests passed.`

- [ ] **Step 6: Commit**

```bash
git add addon/ClaudeBridge/Waypoint.lua test/lua/waypointtest.js
git commit -m "Waypoint arrow: follow a chain of stops" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Carry the chain from Claude to the game, and back to Claude

**Satisfies:** "The reply carries the whole chain", "Only the last chain of an answer is kept", "Clearing after setting a chain clears", "Character info reports when no chain is set"

**Files:**
- Modify: `bridge/protocol.js`, `bridge/bridge.js`, `addon/ClaudeBridge/ClaudeBridge.lua`, `README.md`, `docs/specs/2026-11-08-waypoint-chain-design.md`
- Test: `bridge/test.js`, `test/lua/linkcases.js`

**Interfaces:**
- Consumes: `checkStops` (Task 1); `ClaudeBridge_SetWaypoints(list)` and `ClaudeBridge_WaypointContext()` (Task 2).
- Produces: reply extra `{ waypoints: [stop, ...] }` or `{ clear_waypoint: true }`; `slotLua(id, text, { waypoints })` writes `{ waypoints = { { zone = ..., x = ..., y = ..., label = ... }, ... } }`.

- [ ] **Step 1: Write the failing bridge tests**

In `bridge/test.js`, in the fake Claude script, replace the `wp` helper and add a `route` helper (the fake writes what the real server writes):

```js
      const wp = (zone, x, y, label) => use('set_waypoint', { stops: [{ zone, x, y, label }] });
      const route = (...stops) => use('set_waypoints', { stops: stops.map(([zone, x, y, label]) => ({ zone, x, y, label })) });
```

and add these lines under the existing `if (s.includes(...))` lines:

```js
      if (s.includes('route to the cave')) route(['Westfall', 45.2, 33.1, 'Murloc camp'], ['Elwynn Forest', 40, 20.1, 'Cave'], ['Elwynn Forest', 25.6, 78.4, 'Hogger']);
      if (s.includes('two routes')) { route(['Elwynn Forest', 1, 1, 'Old A'], ['Elwynn Forest', 2, 2, 'Old B']); route(['Westfall', 56.5, 52.6, 'Sentinel Hill'], ['Westfall', 56.2, 47.6, 'Gryan Stoutmantle']); }
      if (s.includes('route then done')) { route(['Elwynn Forest', 1, 1, 'A'], ['Elwynn Forest', 2, 2, 'B']); clear(); }
```

Update the existing single-waypoint check (`a0a0a0`) to the new reply shape:

```js
  assert.match(slot(3), /^ClaudeBridge_OnReply\("a0a0a0", \[(=+)\[\n[\s\S]*\]\1\], \{ waypoints = \{ \{ zone = \[=+\[\nElwynn Forest\]=+\], x = 25\.6, y = 78\.4, label = \[=+\[\nHogger\]=+\] \} \} \}\)\n$/, slot(3));
```

In the `d1d1d1` check, change `!slot(3).includes('waypoint = {')` to `!slot(3).includes('waypoints =')`.

After the `e1e1e1` block, add:

```js
  // Scenario: The reply carries the whole chain
  bridge.cursor = 3;
  writeTga(renderScreen('f1f1f1|route to the cave please'), path.join(shots, 'WoWScrnShot_wp6.tga'));
  await waitFor(() => slot(3).includes('f1f1f1'));
  assert.match(slot(3), /, \{ waypoints = \{ \{ zone = \[=+\[\nWestfall\]=+\], x = 45\.2, y = 33\.1, label = \[=+\[\nMurloc camp\]=+\] \}, \{ zone = \[=+\[\nElwynn Forest\]=+\], x = 40, y = 20\.1, label = \[=+\[\nCave\]=+\] \}, \{ zone = \[=+\[\nElwynn Forest\]=+\], x = 25\.6, y = 78\.4, label = \[=+\[\nHogger\]=+\] \} \} \}\)\n$/, slot(3));

  // Scenario: Only the last chain of an answer is kept
  bridge.cursor = 3;
  writeTga(renderScreen('f2f2f2|two routes'), path.join(shots, 'WoWScrnShot_wp7.tga'));
  await waitFor(() => slot(3).includes('f2f2f2'));
  assert.ok(slot(3).includes('Sentinel Hill') && slot(3).includes('Gryan Stoutmantle') && !slot(3).includes('Old A'), slot(3));

  // Scenario: Clearing after setting a chain clears
  bridge.cursor = 3;
  writeTga(renderScreen('f3f3f3|route then done'), path.join(shots, 'WoWScrnShot_wp8.tga'));
  await waitFor(() => slot(3).includes('f3f3f3'));
  assert.match(slot(3), /, \{ clear_waypoint = true \}\)\n$/, slot(3));
  assert.ok(!slot(3).includes('waypoints ='), slot(3));
```

- [ ] **Step 2: Write the failing addon hook tests**

In `test/lua/linkcases.js`, in the waypoint hooks section:

- Change the `wp3` stub to `run('WP_GOT = nil; ClaudeBridge_SetWaypoints = function(w) WP_GOT = w end', 'wp3');`
- Change every `{ waypoint: { zone: ..., x: ..., y: ..., label: ... } }` passed to `P.slotLua` into `{ waypoints: [{ zone: ..., x: ..., y: ..., label: ... }] }` (three places: `wpslot`, `wpslot2`, `wpslot3`).
- Change the `WP_GOT.zone`, `WP_GOT.x`, `WP_GOT.y`, `WP_GOT.label` checks to `WP_GOT[1].zone`, `WP_GOT[1].x`, `WP_GOT[1].y`, `WP_GOT[1].label`, and add `assert.strictEqual(L1('#WP_GOT'), 1);`.
- Change `ClaudeBridge_SetWaypoint = function() error("boom") end` to `ClaudeBridge_SetWaypoints = function() error("boom") end`.
- In `wp9` and `wp12`, change `SAVED_SW` / `ClaudeBridge_SetWaypoint` to `SAVED_SW` / `ClaudeBridge_SetWaypoints`.

Before `console.log('Waypoint hook tests passed.');`, add:

```js
// The "way" field goes along with questions, and "none" reaches Claude once the chain is gone.
run('WAY = "stop 1 of 2. Now: Cave, Elwynn Forest 40.0, 20.1. Then: Hogger, Elwynn Forest 25.6, 78.4"; ClaudeBridge_WaypointContext = function() return WAY end; ClaudeBridge_Send("what is next?")', 'way1');
const mw = P.parsePayload(sentPayload());
assert.deepStrictEqual(mw.ctx.find(([k]) => k === 'way'), ['way', 'stop 1 of 2. Now: Cave, Elwynn Forest 40.0, 20.1. Then: Hogger, Elwynn Forest 25.6, 78.4']);
assert.ok(P.buildPrompt(mw.text, mw.ctx).includes("Waypoints (the arrow's route): stop 1 of 2. Now: Cave"), P.buildPrompt(mw.text, mw.ctx));
replyTo(mw, 'Head to the cave.');
// Scenario: Character info reports when no chain is set
run('WAY = "none"; ClaudeBridge_Send("cleared it, now what?")', 'way2');
const mn = P.parsePayload(sentPayload());
assert.deepStrictEqual(mn.ctx.find(([k]) => k === 'way'), ['way', 'none']);
replyTo(mn, 'Up to you.');
run('ClaudeBridge_WaypointContext = nil', 'way3');
```

(`replyTo` comes from the shared header that `make-linktest.js` copies from `ctxtest-modern.js`.)

- [ ] **Step 3: Run the tests to check they fail**

Run: `node bridge/test.js`
Expected: FAIL at the `a0a0a0` check (the slot still says `waypoint = {` or carries nothing).

Run: `node test/lua/run.js`
Expected: FAIL in `linktest.js` (`WP_GOT` is nil: `OnReply` doesn't know `waypoints` yet).

- [ ] **Step 4: Write the bridge implementation**

In `bridge/protocol.js`, add to `CTX_LABELS`: `way: "Waypoints (the arrow's route)",` and replace `slotLua` and its comment with:

```js
// extra.waypoints = [{ zone, x, y, label }, ...] or extra.clear_waypoint = true rides
// along as OnReply's third argument, so a reply left over from before a /reload
// (ignored by OnReply) changes nothing.
function slotLua(id, text, extra) {
  let tail = '';
  if (extra && extra.waypoints) {
    const s = (t) => luaLongString(cleanForWow(t));
    const stops = extra.waypoints.map((w) => `{ zone = ${s(w.zone)}, x = ${Number(w.x)}, y = ${Number(w.y)}, label = ${s(w.label)} }`);
    tail = `, { waypoints = { ${stops.join(', ')} } }`;
  } else if (extra && extra.clear_waypoint) {
    tail = ', { clear_waypoint = true }';
  }
  return `ClaudeBridge_OnReply("${id}", ${luaLongString(cleanForWow(text))}${tail})\n`;
}
```

In `bridge/bridge.js`:

```js
const { checkStops } = require('./waypoint-mcp');
```

```js
const WAYPOINT_TOOLS = 'mcp__wow__set_waypoint,mcp__wow__set_waypoints,mcp__wow__clear_waypoint';
```

In `SYSTEM_PROMPT`, replace the two `clear_waypoint` lines at the end with:

```js
  '- For a route (several legs to one place) or several places to visit, call set_waypoints once with',
  '  every stop in travel order instead. For several places, start with the one nearest the player.',
  '- The [Game state] "Waypoints" line shows the arrow\'s route and the stops still to visit. To skip, add',
  '  or reorder stops, call set_waypoints again with the stops still to visit.',
  '- When the player has arrived, is done with the waypoints, or asks to remove the arrow, call',
  '  clear_waypoint. It removes the whole route.',
```

Replace `readWaypointAction` and its comment with:

```js
// The last good waypoint action of this answer, as the reply's extra:
// { waypoints: [{zone,x,y,label}, ...] } or { clear_waypoint: true }; null when there is none.
function readWaypointAction() {
  let lines;
  try { lines = fs.readFileSync(WAYPOINT_FILE, 'utf8').split('\n').filter(Boolean); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const a = JSON.parse(lines[i]);
      if (a && a.clear === true) return { clear_waypoint: true };
      if (a && !checkStops(a.stops)) return { waypoints: a.stops };
    } catch { /* a torn line: try the one before */ }
  }
  return null;
}
```

Replace the two waypoint log lines after Claude answers with:

```js
      const ws = res.extra && res.extra.waypoints;
      if (ws) log(`Waypoints: ${ws.length} stop${ws.length === 1 ? '' : 's'}, first ${ws[0].label}, ${ws[0].zone} ${ws[0].x}, ${ws[0].y}`);
      if (res.extra && res.extra.clear_waypoint) log('Waypoint cleared.');
```

- [ ] **Step 5: Write the addon hook implementation**

In `addon/ClaudeBridge/ClaudeBridge.lua`, in `ClaudeBridge_OnReply`, replace the `extra.waypoint` branch with:

```lua
  if extra and extra.waypoints then
    if ClaudeBridge_SetWaypoints then
      local ok, err = pcall(ClaudeBridge_SetWaypoints, extra.waypoints)
      if not ok then addLine("Couldn't set the waypoint: " .. tostring(err), 1, 0.3, 0.3) end
    else
      addLine(WAYPOINTS_MISSING, 1, 0.3, 0.3)
    end
  elseif extra and extra.clear_waypoint then
```

(the `clear_waypoint` branch below it stays as it is).

In `CTX_READERS`, after the `quests` entry (last, so it is the first field cut when the budget runs out), add:

```lua
  { "way", function() -- the arrow's route, from Waypoint.lua; nothing when that file isn't loaded
      return ClaudeBridge_WaypointContext and ClaudeBridge_WaypointContext()
    end },
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `node bridge/test.js`
Expected: `All bridge tests passed.`

Run: `node test/lua/run.js`
Expected: `All Lua tests passed.` (`ctxtest.js` still counts 8 fields after `!new`: `Waypoint.lua` isn't loaded there, so `way` is skipped.)

- [ ] **Step 7: Update the docs**

In `README.md`, change the `/claude way` row to:

```markdown
| `/claude way` | Show the waypoint or route Claude set, stop by stop. `way clear` removes it (or right-click the arrow). |
```

Change the end of the **Waypoints** bullet from "It clears itself within 10 yards." to:

```markdown
  to move it. It clears itself within 10 yards. For a route or several places
  ("take me to the Deadmines", "where are the six things for this quest?") Claude can
  set a chain of stops: the arrow moves on to the next stop when you arrive. Claude
  sees which stops are left, so you can ask it to skip or change one.
```

Change the `bridge/waypoint-mcp.js` line to:

```markdown
- `bridge/waypoint-mcp.js`: the waypoint tools (a tiny MCP server Claude Code starts)
```

In `docs/specs/2026-11-08-waypoint-chain-design.md`, change "Plan to follow." to "Plan: `2026-11-08-waypoint-chain-plan.md`."

- [ ] **Step 8: Commit**

```bash
git add bridge/protocol.js bridge/bridge.js bridge/test.js addon/ClaudeBridge/ClaudeBridge.lua test/lua/linkcases.js README.md docs/specs/2026-11-08-waypoint-chain-design.md
git commit -m "Bridge and addon: send waypoint chains with the answer, and the route back to Claude" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Check by hand (after all tasks)

These can't be tested offline, because the model's choices aren't deterministic. With the bridge running and the game restarted (a `/reload` doesn't load changed addon files):

1. Ask "take me from Goldshire to Hogger by the road". Expect an arrow with `(1/N)`, the route listed in the window, and the bridge log saying `Waypoints: N stops, ...`.
2. Walk to stop 1. Expect `Arrived: ... Next: ...` and the arrow turning to stop 2.
3. Ask "skip the next stop". Expect a new route without it, shown as stop 1 of the new list.
4. Ask "I'm done, clear it". Expect the arrow gone. The next question's character info says `way: none` (`/claude context` shows it).
