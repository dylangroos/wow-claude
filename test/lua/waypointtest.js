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

console.log('Waypoint tests passed.');
