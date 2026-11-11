// Runs the real ClaudeBridge.lua in fengari and checks message queuing:
// messages typed while an answer is pending wait, then go out one at a time.
//   node queuetest.js <luatools dir>
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const tools = process.argv[2];
const luaparse = require(tools + '/node_modules/luaparse');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require(tools + '/node_modules/fengari');
const P = require(path.join(__dirname, '../../bridge/protocol.js'));
const src = fs.readFileSync(path.join(__dirname, '../../addon/ClaudeBridge/ClaudeBridge.lua'), 'utf8');
luaparse.parse(src, { luaVersion: '5.1' });

const stubs = String.raw`
STRIP, SHOTS, EVENTS, LINES, STATUS = {}, 0, {}, {}, ""
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
    elseif k == "SetScript" then
      return function(self, n, fn) if n == "OnEvent" then EVENTS[#EVENTS + 1] = fn end end
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
C_Timer = { After = function() end, NewTicker = function() return { Cancel = function() end } end }
GetTime = function() return 100 end
time = function() return 1 end
GetCVar = function() return "jpeg" end
SetCVar = function() end
Screenshot = function() SHOTS = SHOTS + 1 end
GetPhysicalScreenSize = function() return 1920, 1080 end
ClaudeBridge_Config = { slots = 50 }
ClaudeBridgeDB = { context = false } -- only what the player types goes out
function FIRE(event) for _, h in ipairs(EVENTS) do h(nil, event) end end
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
// Open the window once, then record what it shows.
run('SlashCmdList.CLAUDEBRIDGE("context off")', 'ui');
run(`ClaudeBridgeFrame.log.AddMessage = function(_, text) LINES[#LINES + 1] = text end
     ClaudeBridgeFrame.status.SetText = function(_, text) STATUS = text end`, 'hook');

// The message the addon last drew on the strip, decoded with the bridge's codec.
function sent() {
  run('COLORS = {} for i, t in ipairs(STRIP) do if t._c then COLORS[i] = string.format("%d,%d,%d", math.floor(t._c[1]*3+0.5), math.floor(t._c[2]*3+0.5), math.floor(t._c[3]*3+0.5)) end end', 'c');
  const syms = [];
  for (let i = 1, n = Number(evalStr('#STRIP')); i <= n; i++) {
    const [r, g, b] = evalStr(`COLORS[${i}]`).split(',').map(Number);
    syms.push(r * 16 + g * 4 + b);
  }
  const head = P.symbolsToBytes(syms.slice(10, 13), 2);
  const len = head[0] * 256 + head[1];
  const bytes = P.symbolsToBytes(syms.slice(10), len + 4);
  return P.parsePayload(Buffer.from(bytes.slice(2, 2 + len)).toString('utf8'));
}
const send = (text) => run(`ClaudeBridge_Send(${JSON.stringify(text)})`, 'send');
const answer = (msg, text = 'ok') => run(`ClaudeBridge_OnReply(${JSON.stringify(msg.id)}, ${JSON.stringify(text)})`, 'reply');
const shots = () => Number(evalStr('SHOTS'));
const lastLine = () => evalStr('LINES[#LINES]');
const status = () => evalStr('STATUS');
const said = (text) => Number(evalStr(`(function() for _, l in ipairs(LINES) do if l == ${JSON.stringify(text)} then return 1 end end return 0 end)()`)) === 1;

// Scenario: A message typed while waiting is sent after the answer
send('where is Hogger?');
const q1 = sent();
assert.strictEqual(q1.text, 'where is Hogger?');
assert.strictEqual(shots(), 1);
send('and the next quest?');
assert.strictEqual(shots(), 1, 'no new screenshot while the first question is out');
assert.strictEqual(lastLine(), '> and the next quest?  (queued)');
assert.strictEqual(status(), 'sending... (+1 queued)');
run('FIRE("SCREENSHOT_SUCCEEDED")', 'shot');
assert.strictEqual(status(), 'thinking... (+1 queued)');
run('SlashCmdList.CLAUDEBRIDGE("new")', 'new'); // commands queue in order too
assert.strictEqual(shots(), 1);
assert.strictEqual(status(), 'thinking... (+2 queued)');
answer(q1, 'Hogger is at 25, 78.');
assert.strictEqual(shots(), 2, 'the answer sends the next message');
const q2 = sent();
assert.strictEqual(q2.text, 'and the next quest?');
// Scenario: A queued message shows again above its answer when it goes out
assert.strictEqual(lastLine(), '> and the next quest?', 'echoed again right after the previous answer');
assert.strictEqual(status(), 'sending... (+1 queued)');
answer(q2);
assert.strictEqual(sent().text, '!new');
assert.strictEqual(status(), 'sending...');
answer(sent(), 'Started a new conversation.');
assert.strictEqual(shots(), 3);
assert.strictEqual(status(), '');

// Scenario: Cancel drops the queue
send('a');
const a = sent();
send('b');
send('c');
run('SlashCmdList.CLAUDEBRIDGE("cancel")', 'cancel');
assert.ok(said('Dropped 2 queued messages.'), evalStr('LINES[#LINES]'));
answer(a);
assert.strictEqual(shots(), 4, 'nothing more goes out after cancel');

// Scenario: Queue is capped at 5
send('x');
const x = sent();
for (let i = 1; i <= 5; i++) send(`queued ${i}`);
assert.strictEqual(status(), 'sending... (+5 queued)');
send('one too many');
assert.strictEqual(status(), 'sending... (+5 queued)', 'the sixth is not queued');
assert.ok(/^Queue's full/.test(lastLine()), lastLine());
run('SlashCmdList.CLAUDEBRIDGE("cancel")', 'cancel2');
assert.ok(said('Dropped 5 queued messages.'));
answer(x);

// After a failed send the queue waits, then resumes oldest first when the player types again.
send('p');
assert.strictEqual(shots(), 6);
send('q');
run('FIRE("SCREENSHOT_FAILED")', 'fail');
assert.strictEqual(shots(), 6, 'a failure pauses the queue');
send('r');
assert.strictEqual(shots(), 7);
const q = sent();
assert.strictEqual(q.text, 'q', 'the older queued message goes first');
assert.strictEqual(evalStr('LINES[#LINES - 1]'), '> q');
assert.strictEqual(lastLine(), '> r  (queued)');
answer(q);
assert.strictEqual(sent().text, 'r');
assert.strictEqual(lastLine(), '> r');
answer(sent());
assert.strictEqual(status(), '');

// Scenario: Context command shows conversation size
const cmd = (m) => run(`SlashCmdList.CLAUDEBRIDGE(${JSON.stringify(m)})`, 'cmd');
cmd('context');
assert.ok(said("Conversation: size unknown until Claude's next answer."), lastLine());
send('a big chat');
run(`ClaudeBridge_OnReply(${JSON.stringify(sent().id)}, "ok", { context = "412k of 1M tokens (41%)" })`, 'reply');
cmd('context');
assert.ok(said('Conversation: 412k of 1M tokens (41%)'), lastLine());

// Scenario: Compact shows progress and completion
cmd('compact');
const c1 = sent();
assert.strictEqual(c1.text, '!compact');
assert.strictEqual(lastLine(), 'Compacting the conversation... (can take a few minutes)');
assert.strictEqual(status(), 'compacting...');
run('FIRE("SCREENSHOT_SUCCEEDED")', 'shot');
assert.strictEqual(status(), 'compacting...');
run(`ClaudeBridge_OnReply(${JSON.stringify(c1.id)}, "Compacted. It was 412k of 1M tokens (41%).", { context = "just compacted" })`, 'reply');
assert.strictEqual(evalStr('LINES[#LINES - 1]'), 'Compacted. It was 412k of 1M tokens (41%).');
assert.strictEqual(status(), '');
cmd('context');
assert.ok(said('Conversation: just compacted'));

// Scenario: Compact waits behind a pending question
send('one more');
const before = shots();
const m = sent();
cmd('compact');
assert.strictEqual(shots(), before, 'compact waits for the answer');
assert.strictEqual(lastLine(), 'Compact queued: it runs after the current answer.');
assert.strictEqual(status(), 'sending... (+1 queued)');
answer(m);
assert.strictEqual(sent().text, '!compact');
assert.strictEqual(lastLine(), 'Compacting the conversation... (can take a few minutes)');
answer(sent(), 'Compacted.');

// Scenario: Typing /compact in the window compacts
send('/compact');
const c3 = sent();
assert.strictEqual(c3.text, '!compact');
assert.strictEqual(lastLine(), 'Compacting the conversation... (can take a few minutes)');

// Scenario: The addon waits longer for a compact than for an answer
run('PlaySoundFile = function() return false end; GetTime = function() return 100 + 300 end; ClaudeBridge_Poll()', 'poll');
assert.ok(!/^No answer/.test(lastLine()), 'still waiting after 300s: ' + lastLine());
run('GetTime = function() return 100 + 1000 end; ClaudeBridge_Poll()', 'poll2');
assert.ok(/^No answer after 900s/.test(lastLine()), lastLine());
run('GetTime = function() return 100 end', 'time');

console.log('Lua queue tests passed.');
