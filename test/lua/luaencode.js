const fs = require('fs');
const tools = process.argv[2];
const luaparse = require(tools + '/node_modules/luaparse');
const fengari = require(tools + '/node_modules/fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const P = require(require('path').join(__dirname, '../../bridge/protocol.js'));
const src = fs.readFileSync(require('path').join(__dirname, '../../addon/ClaudeBridge/ClaudeBridge.lua'), 'utf8');

luaparse.parse(src, { luaVersion: '5.1' });
console.log('addon parses as Lua 5.1');

// Pull the real encoder out of the addon and run it.
const consts = src.match(/local CAL = .*\n/)[0] + src.match(/local MAGIC = .*\n/)[0];
const enc = src.slice(src.indexOf('local function toSymbols'), src.indexOf('local strip, tiles'));
const harness = consts + enc + `
return function(payload, width)
  local s = encode(payload, width)
  local t = {}
  for i, v in ipairs(s) do t[i] = string.format("%d", v) end
  return table.concat(t, ",")
end`;

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
if (lauxlib.luaL_dostring(L, to_luastring(harness)) !== 0) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
const fnRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
function luaEncode(payload, width) {
  lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, fnRef);
  lua.lua_pushstring(L, to_luastring(payload));
  lua.lua_pushinteger(L, width);
  if (lua.lua_pcall(L, 2, 1, 0) !== 0) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  const out = to_jsstring(lua.lua_tostring(L, -1));
  lua.lua_pop(L, 1);
  return out;
}
const cases = ['abc123|hi', '5e1f00|!selftest', 'abc123|' + 'frost nova the murloc camp '.repeat(40), 'abc123|ünïcødé ✓ ]]==|'];
for (const c of cases) {
  const a = luaEncode(c, 120);
  const b = P.encodeStrip(c, 120).join(',');
  if (a !== b) { console.log('MISMATCH for', JSON.stringify(c.slice(0, 30)), '\nlua', a.slice(0, 120), '\njs ', b.slice(0, 120)); process.exitCode = 1; }
  else console.log('match:', c.length, 'chars ->', b.split(',').length, 'blocks');
}
