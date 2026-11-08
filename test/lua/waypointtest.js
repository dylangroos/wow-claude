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
    elseif k == "SetFrameLevel" then return function(self, l) self._level = l end
    elseif k == "GetFrameLevel" then return function(self) return rawget(self, "_level") or 1 end
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
assert.strictEqual(num('ClaudeBridgeDB.waypoints.stops[1].mapID'), 1429, 'the zone, not the same-named micro map');
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
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints'), 'nil');
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
assert.strictEqual(num('ClaudeBridgeDB.waypoints.stops[1].mapID'), 1436);
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints.stops[1].zone'), 'Westfall', "the game's own spelling, not Claude's");
near(num('ClaudeBridgeArrow.arrow._rot'), Math.PI / 2, 'due west: arrow points left');
assert.strictEqual(evalStr('ClaudeBridgeArrow.text._text'), 'Sentinel Hill\n1000 yd');

// Scenario: Clearing the waypoint by command
run('ClaudeBridge_WaypointCommand("clear")', 'clear');
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints'), 'nil');
assert.strictEqual(evalStr('ClaudeBridgeArrow:IsShown()'), 'false');
assert.strictEqual(evalStr('SAID[#SAID]'), 'Waypoint cleared.');
run('ClaudeBridge_WaypointCommand("")', 'show');
assert.ok(evalStr('SAID[#SAID]').startsWith('No waypoint.'));

// Scenario: Unknown zone is reported
run('ClaudeBridge_SetWaypoint({ zone = "Narnia", x = 1, y = 1, label = "Lamp post" })', 'narnia');
assert.ok(evalStr('SAID[#SAID]').includes("Couldn't find the zone Narnia"), evalStr('SAID[#SAID]'));
assert.strictEqual(evalStr('ClaudeBridgeDB.waypoints'), 'nil');

// Scenario: a failing arrow update tells the player and recovers on the next waypoint
run(`ClaudeBridge_SetWaypoint(${hogger})`, "again");
run('local real = C_Map.GetWorldPosFromMapPos; C_Map.GetWorldPosFromMapPos = function() error("no world pos") end; ClaudeBridgeArrow._OnUpdate(ClaudeBridgeArrow, 1); C_Map.GetWorldPosFromMapPos = real', "boom");
assert.strictEqual(evalStr("ClaudeBridgeArrow:IsShown()"), "false");
assert.ok(evalStr("SAID[#SAID]").startsWith("Waypoint arrow stopped:"), evalStr("SAID[#SAID]"));
assert.notStrictEqual(evalStr("ClaudeBridgeDB.waypointError"), "nil");
run(`ClaudeBridge_SetWaypoint(${hogger})`, "retry");
assert.strictEqual(evalStr("ClaudeBridgeDB.waypointError"), "nil");
assert.strictEqual(evalStr("ClaudeBridgeArrow:IsShown()"), "true");
run("ClaudeBridge_ClearWaypoint()", "tidy");

// A persistent arrow error at login is caught, not thrown.
run(src, "Waypoint.lua"); // as after a /reload, but keep the login handlers to fire by hand
run(`ClaudeBridge_SetWaypoint(${hogger})`, "lset");
run('local real = C_Map.GetWorldPosFromMapPos; C_Map.GetWorldPosFromMapPos = function() error("no world pos") end; LOGIN_OK, LOGIN_ERR = pcall(function() for _, h in ipairs(EVENTS) do h(nil, "PLAYER_LOGIN") end end); C_Map.GetWorldPosFromMapPos = real', "lboom");
assert.strictEqual(evalStr("LOGIN_OK"), "true", evalStr("LOGIN_ERR"));
assert.ok(evalStr("SAID[#SAID]").startsWith("Waypoint arrow stopped:"), evalStr("SAID[#SAID]"));
assert.strictEqual(evalStr("ClaudeBridgeArrow:IsShown()"), "false");
assert.notStrictEqual(evalStr("ClaudeBridgeDB.waypointError"), "nil");
run("ClaudeBridge_ClearWaypoint()", "ltidy");

// Scenario: The world map shows a pin and a line
run(`WorldMapFrame = OBJECT("WorldMapFrame")
  WorldMapFrame.ScrollContainer = { Child = OBJECT("Canvas") }
  WorldMapFrame.ScrollContainer.Child._w, WorldMapFrame.ScrollContainer.Child._h = 1000, 667
  WorldMapFrame.GetMapID = function() return MAP_SHOWN end
  MAP_SHOWN = 1429`, 'map');
login(); // hooks the map at PLAYER_LOGIN
run('PLAYER = { map = 1429, x = 0.5, y = 0.5 }; ClaudeBridge_SetWaypoint({ zone = "Elwynn Forest", x = 25.6, y = 78.4, label = "Hogger" })', 'mset');
run('WorldMapFrame:Show(); WorldMapFrame._hook_OnUpdate(WorldMapFrame, 0.2)', 'mtick');
run('PIN, LINE = ClaudeBridgeMapOverlay._children[1], ClaudeBridgeMapOverlay._children[2]', 'mget');
// They live on an overlay frame well above the canvas, so the map tiles don't cover them.
assert.strictEqual(num('ClaudeBridgeMapOverlay._level'), num('WorldMapFrame.ScrollContainer.Child:GetFrameLevel()') + 500);
assert.strictEqual(num('#WorldMapFrame.ScrollContainer.Child._children'), 0, 'nothing drawn straight on the canvas');
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

// Scenario: A long route shows only the next three stops
run(`local stops = {}
  for i = 1, 10 do stops[i] = { mapID = 1429, zone = "Elwynn Forest", x = i, y = 10 + i, label = "S" .. i } end
  ClaudeBridgeDB.waypoints = { current = 2, stops = stops }`, 'c10b');
assert.strictEqual(evalStr('ClaudeBridge_WaypointContext()'),
  'stop 2 of 10. Now: S2, Elwynn Forest 2.0, 12.0. Then: S3, Elwynn Forest 3.0, 13.0; ' +
  'S4, Elwynn Forest 4.0, 14.0; S5, Elwynn Forest 5.0, 15.0; and 5 more');
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

console.log('Waypoint tests passed.');
