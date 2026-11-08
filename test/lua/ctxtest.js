// Runs the real ClaudeBridge.lua in fengari with stubbed WoW APIs, sends
// questions through ClaudeBridge_Send, reads the strip colors the addon drew,
// and decodes them with the bridge's own protocol code.
//   node ctxtest.js <luatools dir>
const fs = require('fs');
const assert = require('assert');
const tools = process.argv[2];
const luaparse = require(tools + '/node_modules/luaparse');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require(tools + '/node_modules/fengari');
const P = require(require('path').join(__dirname, '../../bridge/protocol.js'));
const src = fs.readFileSync(require('path').join(__dirname, '../../addon/ClaudeBridge/ClaudeBridge.lua'), 'utf8');
luaparse.parse(src, { luaVersion: '5.1' });

const stubs = String.raw`
STRIP = {}           -- colors drawn on the strip, in tile order
SHOTS = 0
TIMERS = {}
local function frame(name)
  local f = { _name = name }
  return setmetatable(f, { __index = function(t, k)
    if k == "CreateTexture" then
      return function(self)
        local tex = setmetatable({}, { __index = function(_, m)
          if m == "SetColorTexture" then
            return function(tx, r, g, b) if self._name == "ClaudeBridgeStrip" then tx._c = { r, g, b } end end
          end
          return function() end
        end })
        if self._name == "ClaudeBridgeStrip" then STRIP[#STRIP + 1] = tex end
        return tex
      end
    elseif k == "GetPoint" then return function() return "CENTER", nil, "CENTER", 0, 0 end
    elseif k == "IsShown" then return function() return false end
    elseif k == "GetHeight" then return function() return 768 end
    elseif k == "GetEffectiveScale" then return function() return 1 end
    end
    return function() return frame() end
  end })
end
function CreateFrame(_, name) local f = frame(name); if name then _G[name] = f end; return f end
UIParent = frame("UIParent")
UISpecialFrames, SlashCmdList = {}, {}
ChatFontNormal = {}
C_Timer = { After = function(s, fn) TIMERS[#TIMERS + 1] = fn end, NewTicker = function() return { Cancel = function() end } end }
GetTime = function() return 100 end
time = function() return 1 end
GetCVar = function() return "jpeg" end
SetCVar = function() end
Screenshot = function() SHOTS = SHOTS + 1 end
GetPhysicalScreenSize = function() return 1920, 1080 end
ClaudeBridge_Config = { slots = 50 }

unpack = function(t) return table.unpack(t, 1, 7) end
-- The character: a level 11 mage in Goldshire.
GEAR = { [5] = "|cffffffff|Hitem:56:0:0:0|h[Apprentice's Robe]|h|r", [18] = "|cff1eff00|Hitem:11288:0|h[Greater Magic Wand]|h|r" }
UnitName = function() return "Testmage" end
UnitLevel = function() return 11 end
UnitRace = function() return "Human" end
UnitClass = function() return "Mage", "MAGE" end
UnitXP = function() return 420 end
UnitXPMax = function() return 1000 end
GetXPExhaustion = function() return 300 end
GetRealZoneText = function() return "Elwynn Forest" end
GetSubZoneText = function() return ZONE_SUB or "Goldshire" end
GetMoney = function() return 31205 end
GetNumTalentTabs = function() return 3 end
GetTalentTabInfo = function(t) return ({ "Arcane", "Fire", "Frost" })[t], "icon", 0, "x" end
GetNumTalents = function(t) return 2 end
GetTalentInfo = function(t, i)
  if t == 3 and i == 1 then return "Improved Frostbolt", "i", 1, 1, 2, 5 end
  return "Something", "i", 1, 1, 0, 5
end
GetNumSkillLines = function() return 5 end
local skills = { { "Professions", true }, { "Tailoring", false, nil, 45, 0, 0, 75 },
  { "Secondary Skills", true }, { "Cooking", false, nil, 10, 0, 0, 75 }, { "Weapon Skills", true } }
GetSkillLineInfo = function(i) return unpack(skills[i]) end
GetInventoryItemLink = function(_, slot) return GEAR[slot] end
GetItemInfo = function(link) if link:find("11288") then return "Greater Magic Wand", link, 2, 17 end return nil end
GetNumQuestLogEntries = function() return 3, 2 end
local quests = { { "Elwynn Forest", 0, nil, true }, { "Princess Must Die!", 12, nil, false, nil, 1 }, { "Bounty on Murlocs", 8, nil, false } }
GetQuestLogTitle = function(i) return unpack(quests[i]) end
`;

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
function run(code, name) {
  if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(name)) !== 0 || lua.lua_pcall(L, 0, 0, 0) !== 0) {
    throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  }
}
function evalStr(expr) {
  run(`RESULT = tostring(${expr})`, 'eval');
  lua.lua_getglobal(L, to_luastring('RESULT'));
  const s = lua.lua_tojsstring(L, -1);
  lua.lua_pop(L, 1);
  return s;
}
run(stubs, 'stubs');
run(src, 'ClaudeBridge.lua');

// Decode what the addon drew on the strip, using the bridge's codec.
function sentPayload() {
  const n = Number(evalStr('#STRIP'));
  const syms = [];
  run('COLORS = {} for i, t in ipairs(STRIP) do if t._c then COLORS[i] = string.format("%d,%d,%d", math.floor(t._c[1]*3+0.5), math.floor(t._c[2]*3+0.5), math.floor(t._c[3]*3+0.5)) end end', 'c');
  for (let i = 1; i <= n; i++) {
    const c = evalStr(`COLORS[${i}]`);
    const [r, g, b] = c.split(',').map(Number);
    syms.push(r * 16 + g * 4 + b);
  }
  const head = P.symbolsToBytes(syms.slice(10, 13), 2);
  const len = head[0] * 256 + head[1];
  const bytes = P.symbolsToBytes(syms.slice(10), len + 4);
  return Buffer.from(bytes.slice(2, 2 + len)).toString('utf8');
}
const replyTo = (msg, text) => {
  run(`ClaudeBridge_OnReply(${JSON.stringify(msg.id)}, ${JSON.stringify(text)})`, 'reply');
};

// 1. First question carries the full context.
run('ClaudeBridge_Send("where should I level next?")', 'send1');
const m1 = P.parsePayload(sentPayload());
console.log('First prompt as Claude sees it:\n' + P.buildPrompt(m1.text, m1.ctx) + '\n');
assert.strictEqual(m1.text, 'where should I level next?');
const c1 = Object.fromEntries(m1.ctx);
assert.strictEqual(c1.char, 'Testmage, level 11 Human Mage');
assert.strictEqual(c1.xp, '42% of the way to level 12, rested');
assert.strictEqual(c1.zone, 'Elwynn Forest > Goldshire');
assert.strictEqual(c1.money, '3g 12s 5c');
assert.strictEqual(c1.talents, 'Arcane 0, Fire 0, Frost 2 (Improved Frostbolt 2/5)');
assert.strictEqual(c1.prof, 'Tailoring 45/75, Cooking 10/75');
assert.strictEqual(c1.gear, "Chest: Apprentice's Robe; Ranged: Greater Magic Wand (17)");
assert.strictEqual(c1.quests, 'Princess Must Die! (12, ready to turn in); Bounty on Murlocs (8)');
replyTo(m1, 'Go to Westfall.');

// 2. Next question: only the changed subzone goes along.
run('ZONE_SUB = "Northshire Valley"; ClaudeBridge_Send("thanks")', 'send2');
const m2 = P.parsePayload(sentPayload());
assert.deepStrictEqual(m2.ctx, [['zone', 'Elwynn Forest > Northshire Valley']]);
replyTo(m2, 'np');

// 3. Nothing changed: plain question, no context block at all.
run('ClaudeBridge_Send("and now?")', 'send3');
const p3 = sentPayload();
assert.ok(!p3.includes(P.CTX_SEP), p3);
assert.strictEqual(P.parsePayload(p3).text, 'and now?');
// An error reply means Claude never saw it: context stays "unsent".
replyTo(P.parsePayload(p3), 'ok');

// 4. A failed answer doesn't count as seen.
run('ZONE_SUB = "Goldshire"; ClaudeBridge_Send("q4")', 'send4');
const m4 = P.parsePayload(sentPayload());
assert.deepStrictEqual(m4.ctx.map((kv) => kv[0]), ['zone']);
replyTo(m4, 'error: Claude gave no answer.');
run('ClaudeBridge_Send("q5")', 'send5');
assert.deepStrictEqual(P.parsePayload(sentPayload()).ctx.map((kv) => kv[0]), ['zone'], 'resent after error');
replyTo(P.parsePayload(sentPayload()), 'fine');

// 5. /claude new -> full context again; /claude context off -> none.
run('SlashCmdList.CLAUDEBRIDGE("new")', 'new');
assert.strictEqual(P.parsePayload(sentPayload()).text, '!new');
replyTo(P.parsePayload(sentPayload()), 'Started a new conversation.');
run('ClaudeBridge_Send("hi again")', 'send6');
assert.strictEqual(P.parsePayload(sentPayload()).ctx.length, 8, 'full context after !new');
replyTo(P.parsePayload(sentPayload()), 'hey');
run('SlashCmdList.CLAUDEBRIDGE("context off"); ZONE_SUB = "Tower of Azora"; ClaudeBridge_Send("q7")', 'off');
assert.strictEqual(sentPayload().slice(7), 'q7');
replyTo(P.parsePayload(sentPayload()), 'x');

// 6. A broken API only drops its own line; a huge quest log is cut to fit.
run('SlashCmdList.CLAUDEBRIDGE("context on"); GetMoney = nil; quests = nil', 'on');
run(`local q = {} for i = 1, 200 do q[i] = { "A very long quest name number " .. i .. " ✓", 10 } end
     GetNumQuestLogEntries = function() return #q end
     GetQuestLogTitle = function(i) return unpack(q[i]) end
     ClaudeBridge_Send("q8")`, 'big');
const p8 = sentPayload();
const m8 = P.parsePayload(p8);
const c8 = Object.fromEntries(m8.ctx);
assert.ok(!('money' in c8), 'money line skipped when GetMoney is missing');
assert.ok(c8.quests.endsWith('...'), 'quests cut');
assert.ok(!c8.quests.includes('\ufffd'), 'no broken UTF-8');
const ctxBytes = m8.ctx.reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 2, 0);
assert.ok(ctxBytes <= 1500, `context ${ctxBytes} bytes`);
console.log(`Big quest log: context ${ctxBytes} bytes, whole payload ${Buffer.byteLength(p8)} bytes, ${evalStr('#STRIP')} strip blocks (${Math.ceil(Number(evalStr('#STRIP')) / 120)} rows).`);
console.log(`Screenshots taken: ${evalStr('SHOTS')}`);
console.log('Lua context tests passed.');
for (const [k, v] of m8.ctx) console.log(k, Buffer.byteLength(v), JSON.stringify(v.slice(-50)));
