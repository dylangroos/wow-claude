# Sessions Panel (WoW IDE slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The in-game Claude window shows the player's recent Claude Code sessions (title, project, age, open/busy) in a column on the right.

**Architecture:** A new bridge module reads `~/.claude/projects` and `~/.claude/sessions` (titles, cwd, mtimes, open status only). Every reply slot the bridge writes starts with a `ClaudeBridge_OnSessions({...})` call before the usual `ClaudeBridge_OnReply`. The addon stores the list in SavedVariables, renders it, and asks for a fresh one with a silent `!sessions` command when the window opens and the list is over 2 minutes old.

**Tech Stack:** Node 18+ (no npm packages) for the bridge; WoW Lua for the addon; offline Lua tests run the real addon in fengari.

**Spec:** `docs/specs/2026-11-08-wow-ide-design.md` (slice 1 scenarios only; slices 2-4 get their own plans after their spikes)

**Runner:** none. Plain `assert` tests named after scenarios: `node bridge/test.js` (bridge) and `node test/lua/run.js` (addon; needs `npm install --prefix test/lua/.tools fengari luaparse` once).

## Global Constraints

- The bridge stays free of npm packages.
- The bridge never reads message text for the list: only `customTitle`, `cwd` and file times.
- Session titles and project names never go to Claude.
- No in-game character names anywhere in the repo, tests included (use `Testmage`).
- Refresh rule: only when the list is over 120 s old (`SESSIONS_STALE = 120`); a silent refresh is dropped after 15 s (`SILENT_TIMEOUT = 15`).
- The list shows at most 10 sessions.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

- Create `bridge/sessions.js`: `listSessions()` and `projectDirName()`. Only reads the disk.
- Create `bridge/sessions.test.js`: bridge-side scenario tests, run from `bridge/test.js`.
- Modify `bridge/protocol.js`: `sessionsLua(list)`.
- Modify `bridge/bridge.js`: list goes in every reply slot; `!sessions` command.
- Modify `bridge/test.js`: fake Claude dir env var; run the sessions tests; slot regexes allow the leading list.
- Modify `addon/ClaudeBridge/ClaudeBridge.lua`: sessions column, render, refresh rule, queued question, silent pending.
- Modify `test/lua/make-linktest.js`, `test/lua/linkstubs.lua`, `test/lua/linkcases.js`: stubs and addon-side scenario tests.
- Modify `README.md`: sessions panel.

---

### Task 1: Bridge lists sessions

**Satisfies:** "Bridge's own sessions are hidden", "Sessions open in the desktop app are marked", "Session message text never leaves the transcript file"

**Files:**
- Create: `bridge/sessions.js`
- Create: `bridge/sessions.test.js`
- Modify: `bridge/test.js` (env var near the top; call at the start of the main async function)

**Interfaces:**
- Produces: `listSessions({ projectsDir, liveDir, hideDirs = [], limit = 10, now = Date.now() })` → `Array<{ id: string, title: string, project: string, cwd: string|null, ageSec: number, live: 'busy'|'open'|null }>`, newest first.
- Produces: `projectDirName(cwd: string) → string` (how Claude Code names a project folder: every non-alphanumeric character becomes `-`).
- Produces: `bridge/sessions.test.js` exports `async function testSessions()`; uses `process.env.CB_CLAUDE_DIR` as its fake `~/.claude`.

- [ ] **Step 1: Write the failing test**

Create `bridge/sessions.test.js`:

```js
// Sessions panel: bridge side. Run from test.js (it sets CB_CLAUDE_DIR and CB_STATE).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { listSessions, projectDirName } = require('./sessions');

module.exports = async function testSessions() {
  const root = process.env.CB_CLAUDE_DIR;
  const projects = path.join(root, 'projects');
  const live = path.join(root, 'sessions');
  const NOW = Date.now();
  function session(dir, id, lines, ageSec) {
    fs.mkdirSync(path.join(projects, dir), { recursive: true });
    const f = path.join(projects, dir, `${id}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = (NOW - ageSec * 1000) / 1000;
    fs.utimesSync(f, t, t);
  }
  session('C--work-webapp', 'aaa', [
    { type: 'user', cwd: 'C:\\work\\webapp', message: { content: 'SECRETWORD please' } },
    { type: 'custom-title', customTitle: 'Fix login bug' },
  ], 60);
  session('C--work-webapp', 'bbb', [{ type: 'user', cwd: 'C:\\work\\webapp', message: { content: 'hi' } }], 3600);
  session('C--work-synth', 'ccc', [
    { type: 'user', cwd: 'C:\\work\\synth' }, { customTitle: 'Old title' }, { customTitle: 'Patch editor' },
  ], 600);
  const agentDir = projectDirName('C:\\Users\\me\\wow-claude\\agent-home');
  session(agentDir, 'ddd', [{ customTitle: 'game chat' }], 1);
  session('C--Users-me-AppData-Local-Temp-x', 'eee', [{ customTitle: 'temp' }], 1);
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, '1.json'), JSON.stringify({ pid: process.pid, sessionId: 'aaa', status: 'busy' }));
  fs.writeFileSync(path.join(live, '2.json'), JSON.stringify({ pid: 999999, sessionId: 'ccc', status: 'idle' }));

  const list = listSessions({ projectsDir: projects, liveDir: live, hideDirs: [agentDir], now: NOW });

  // Scenario: Bridge's own sessions are hidden
  assert.strictEqual(agentDir, 'C--Users-me-wow-claude-agent-home');
  assert.deepStrictEqual(list.map((s) => s.id), ['aaa', 'ccc', 'bbb'], 'newest first, agent-home and temp hidden');
  assert.deepStrictEqual(list[0], { id: 'aaa', title: 'Fix login bug', project: 'webapp', cwd: 'C:\\work\\webapp', ageSec: 60, live: 'busy' });
  assert.strictEqual(list[1].title, 'Patch editor', 'the latest title wins');
  assert.strictEqual(list[2].title, '(untitled)');

  // Scenario: Sessions open in the desktop app are marked
  assert.strictEqual(list[0].live, 'busy');
  assert.strictEqual(list[1].live, null, 'registry file of an exited process is ignored');

  // Scenario: Session message text never leaves the transcript file
  assert.ok(!JSON.stringify(list).includes('SECRETWORD'));

  console.log('Session list tests passed.');
  return list;
};
```

In `bridge/test.js`, after the line `process.env.CB_STATE = path.join(tmp, 'state.json');` add:

```js
process.env.CB_CLAUDE_DIR = path.join(tmp, 'claude'); // fake ~/.claude: never list the real sessions in tests
```

and make the first line inside `(async () => {` be:

```js
  await require('./sessions.test')();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node bridge/test.js`
Expected: FAIL with `Cannot find module './sessions'`

- [ ] **Step 3: Write minimal implementation**

Create `bridge/sessions.js`:

```js
// Lists the player's Claude Code sessions for the in-game sessions panel.
// Reads only titles, folders and file times, never message text.
const fs = require('fs');
const path = require('path');

const TITLE_RE = /"customTitle":"((?:[^"\\]|\\.)*)"/g;
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;
const ALWAYS_HIDDEN = [/-AppData-Local-Temp-/i]; // throwaway sessions from tools and tests
const CHUNK = 512 * 1024;

// How Claude Code names a project's folder under ~/.claude/projects.
function projectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Transcripts can be many MB: read only the first or last CHUNK bytes.
function readChunk(file, fromEnd) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(CHUNK, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function unescapeJson(s) {
  try { return JSON.parse(`"${s}"`); } catch { return s; }
}

function lastTitle(text) {
  let title = null;
  for (const m of text.matchAll(TITLE_RE)) title = m[1];
  return title;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// sessionId -> 'busy' | 'open', for sessions whose process is still running.
function openSessions(liveDir) {
  const open = new Map();
  let names = [];
  try { names = fs.readdirSync(liveDir); } catch { return open; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(liveDir, name), 'utf8')); } catch { continue; }
    if (!j.sessionId || !Number.isInteger(j.pid) || !pidAlive(j.pid)) continue;
    open.set(j.sessionId, j.status === 'busy' ? 'busy' : 'open');
  }
  return open;
}

function listSessions({ projectsDir, liveDir, hideDirs = [], limit = 10, now = Date.now() }) {
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return []; }
  for (const dir of dirs) {
    if (hideDirs.includes(dir) || ALWAYS_HIDDEN.some((re) => re.test(dir))) continue;
    let names;
    try { names = fs.readdirSync(path.join(projectsDir, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projectsDir, dir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.isFile()) files.push({ file, dir, id: name.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const open = openSessions(liveDir);
  return files.slice(0, limit).map((f) => {
    const tail = readChunk(f.file, true);
    let head = null;
    const getHead = () => (head ??= readChunk(f.file, false));
    const title = lastTitle(tail) ?? lastTitle(getHead());
    const cwdMatch = CWD_RE.exec(tail) || CWD_RE.exec(getHead());
    const cwd = cwdMatch ? unescapeJson(cwdMatch[1]) : null;
    return {
      id: f.id,
      title: title ? unescapeJson(title) : '(untitled)',
      project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : f.dir,
      cwd,
      ageSec: Math.max(0, Math.round((now - f.mtimeMs) / 1000)),
      live: open.get(f.id) || null,
    };
  });
}

module.exports = { listSessions, projectDirName };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node bridge/test.js`
Expected: `Session list tests passed.` then `All bridge tests passed.`

- [ ] **Step 5: Commit**

```bash
git add bridge/sessions.js bridge/sessions.test.js bridge/test.js
git commit -m "Bridge: list Claude Code sessions for the sessions panel"
```

---

### Task 2: Every reply slot carries the list

**Satisfies:** "Every answer refreshes the list for free"

**Files:**
- Modify: `bridge/protocol.js` (new `sessionsLua`, export it)
- Modify: `bridge/bridge.js` (`CLAUDE_DIR`, `sessionsLua()` method, `writeReply`, `!sessions` in `drain`)
- Modify: `bridge/sessions.test.js` (append)
- Modify: `bridge/test.js` (the two `^ClaudeBridge_OnReply` regexes)

**Interfaces:**
- Consumes: `listSessions`, `projectDirName` from Task 1.
- Produces: `P.sessionsLua(list) → string`, exactly `ClaudeBridge_OnSessions({{t=<long string>,p=<long string>,age=<int>[,live="busy"|"open"]},...})\n`.
- Produces: the Lua global the addon must define in Task 3: `ClaudeBridge_OnSessions(list)`, where each entry is `{ t = title, p = project, age = seconds, live = "busy"|"open"|nil }`.
- Produces: the bridge answers `!sessions` with an empty `ClaudeBridge_OnReply(id, "")` after the list.

- [ ] **Step 1: Write the failing test**

In `bridge/sessions.test.js`, replace the last two lines of the function (`console.log('Session list tests passed.');` and `return list;`) with:

```js
  console.log('Session list tests passed.');

  // Scenario: Every answer refreshes the list for free
  const P = require('./protocol');
  const { Bridge } = require('./bridge');
  const lua = P.sessionsLua(list);
  assert.ok(lua.startsWith('ClaudeBridge_OnSessions({{t=[=[\nFix login bug]=],p=[=[\nwebapp]=],age=60,live="busy"},{t=[=[\nPatch editor]=],p=[=[\nsynth]=],age=600},'), lua);
  assert.ok(!lua.includes('C:\\work'), 'full folder paths stay on the PC');
  const wow = path.join(root, 'wow');
  const addons = path.join(wow, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, 'ClaudeBridge', 'sig'), { recursive: true });
  for (const i of [1, 2]) fs.mkdirSync(path.join(addons, P.slotName(i)), { recursive: true });
  const bridge = new Bridge({ wowDir: wow, slots: 2, savedVarDirs: [] });
  bridge.writeReply('abc123', 'hello');
  const r1 = fs.readFileSync(path.join(addons, P.slotName(1), 'r.lua'), 'utf8');
  assert.ok(r1.startsWith('ClaudeBridge_OnSessions({{t='), r1);
  assert.ok(r1.indexOf('ClaudeBridge_OnReply("abc123", ') > r1.indexOf('Patch editor'), 'list runs before the answer');
  bridge.queue.push({ id: 's1', text: '!sessions', ctx: [] });
  await bridge.drain();
  const r2 = fs.readFileSync(path.join(addons, P.slotName(2), 'r.lua'), 'utf8');
  assert.ok(r2.startsWith('ClaudeBridge_OnSessions(') && r2.endsWith('ClaudeBridge_OnReply("s1", [=[\n]=])\n'), r2);
  console.log('Sessions reply tests passed.');
  return list;
```

In `bridge/test.js`, change

```js
  assert.match(slot(1), /^ClaudeBridge_OnReply\("0e0e0e", /, 'recent pre-start prompt answered');
```

to

```js
  assert.match(slot(1), /^ClaudeBridge_OnSessions\(\{[\s\S]*\}\)\nClaudeBridge_OnReply\("0e0e0e", /, 'recent pre-start prompt answered');
```

and

```js
  assert.match(slot(1), /^ClaudeBridge_OnReply\("abc123", \[=+\[\n/);
```

to

```js
  assert.match(slot(1), /\nClaudeBridge_OnReply\("abc123", \[=+\[\n/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node bridge/test.js`
Expected: FAIL with `P.sessionsLua is not a function`

- [ ] **Step 3: Write minimal implementation**

In `bridge/protocol.js`, after `function slotLua(id, text) {...}` add:

```js
// The sessions list as a Lua call. It goes in a reply slot before the answer,
// so the list is fresh by the time the answer opens the window.
function sessionsLua(list) {
  const str = (s) => luaLongString(cleanForWow(s));
  const rows = list.map((s) =>
    `{t=${str(s.title)},p=${str(s.project)},age=${Math.max(0, Math.round(s.ageSec))}${s.live ? `,live="${s.live}"` : ''}}`);
  return `ClaudeBridge_OnSessions({${rows.join(',')}})\n`;
}
```

and add `sessionsLua,` to `module.exports` next to `slotLua,`.

In `bridge/bridge.js`:

after `const P = require('./protocol');` add

```js
const { listSessions, projectDirName } = require('./sessions');
```

after `const AGENT_HOME = path.join(ROOT, 'agent-home');` add

```js
const CLAUDE_DIR = process.env.CB_CLAUDE_DIR || path.join(os.homedir(), '.claude');
```

add this method to `class Bridge`, right before `writeReply(id, text) {`:

```js
  // The player's Claude Code sessions as a Lua call, or '' if they can't be read.
  sessionsLua() {
    try {
      return P.sessionsLua(listSessions({
        projectsDir: path.join(CLAUDE_DIR, 'projects'),
        liveDir: path.join(CLAUDE_DIR, 'sessions'),
        hideDirs: [projectDirName(AGENT_HOME)],
      }));
    } catch (e) {
      log(`Couldn't list sessions: ${e.message}`);
      return '';
    }
  }

```

in `writeReply`, change

```js
    fs.writeFileSync(path.join(this.addonsDir, P.slotName(i), 'r.lua'), P.slotLua(id, text));
```

to

```js
    fs.writeFileSync(path.join(this.addonsDir, P.slotName(i), 'r.lua'), this.sessionsLua() + P.slotLua(id, text));
```

in `drain`, right before `if (text === '!selftest') {` add

```js
      if (text === '!sessions') {
        this.writeReply(id, ''); // the list rides along with every reply; nothing else to say
        continue;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node bridge/test.js`
Expected: `Session list tests passed.`, `Sessions reply tests passed.`, `All bridge tests passed.`

- [ ] **Step 5: Commit**

```bash
git add bridge/protocol.js bridge/bridge.js bridge/sessions.test.js bridge/test.js
git commit -m "Bridge: send the sessions list with every reply, answer !sessions"
```

---

### Task 3: Addon shows the list and keeps it fresh

**Satisfies:** "Panel lists recent sessions newest first", "A fresh list is not requested again", "A question typed during a refresh is not lost", "A silent refresh with no answer is dropped quietly", "List survives a reload"

**Files:**
- Modify: `addon/ClaudeBridge/ClaudeBridge.lua`
- Modify: `test/lua/make-linktest.js`, `test/lua/linkstubs.lua`, `test/lua/linkcases.js`

**Interfaces:**
- Consumes: the reply-slot Lua from Task 2: `ClaudeBridge_OnSessions(list)` then `ClaudeBridge_OnReply(id, text)`.
- Produces: globals `ClaudeBridge_OnSessions(list)`, `ClaudeBridge_RenderSessions()`, `ClaudeBridge_MaybeRefreshSessions()`; `ClaudeBridge_Send(text, silent)` gains an optional `silent` flag.
- Produces: `ClaudeBridgeDB.sessions = { at = time(), list = {...} }` and `ClaudeBridgeDB.sessionsAsked = time()`.
- Produces: `ClaudeBridgeFrame.sessions.rows[i].title` / `.sub` (FontStrings) and `.dot` (texture), `i = 1..10`.

- [ ] **Step 1: Write the failing test**

In `test/lua/make-linktest.js`, extend the replaced stub block so frames remember text and the log records lines. The replacement string becomes:

```js
s = s.replace('elseif k == "IsShown" then return function() return false end',
  `elseif k == "IsShown" then return function() return SHOWN or false end
    elseif k == "HasFocus" then return function() return FOCUS end
    elseif k == "Insert" then return function(_, v) INSERTED[#INSERTED + 1] = v end
    elseif k == "SetScript" then return function(_, n, fn) if n == "OnEvent" then EVENTS[#EVENTS + 1] = fn end end
    elseif k == "SetText" then return function(self, v) rawset(self, "_text", v) end
    elseif k == "GetText" then return function(self) return rawget(self, "_text") end
    elseif k == "AddMessage" then return function(_, m) LINES[#LINES + 1] = m end
    elseif k == "NumLines" and t._name == "ClaudeBridgeScanTip" then return function() return 2 end`);
```

In `test/lua/linkstubs.lua`, change the first line to:

```lua
INSERTED, EVENTS, MOD, LINES = {}, {}, false, {}
```

Append to `test/lua/linkcases.js`:

```js

// ---- sessions panel ----
// The shared stubs pin time() to 1, so earlier tests never trigger a refresh.
run('SlashCmdList.CLAUDEBRIDGE("cancel"); SHOWN = false; NOW = 1000; time = function() return NOW end', 'sess0');
const shotCount = () => L1('SHOTS');
const row = (i, part) => evalStr(`ClaudeBridgeFrame.sessions.rows[${i}].${part}:GetText()`);

// Scenario: List survives a reload
// Scenario: A fresh list is not requested again
run('ClaudeBridgeDB.sessions = { at = 970, list = { { t = "Fix login bug", p = "webapp", age = 50, live = "busy" } } }', 'saved');
let before = shotCount();
run('SlashCmdList.CLAUDEBRIDGE("")', 'openFresh');
assert.strictEqual(row(1, 'title'), 'Fix login bug');
assert.strictEqual(row(1, 'sub'), 'webapp  1m');
assert.strictEqual(shotCount(), before, 'list 30s old: no refresh');

// Scenario: Panel lists recent sessions newest first
run('ClaudeBridge_OnSessions({ { t = "A", p = "one", age = 5 }, { t = "B", p = "two", age = 4000, live = "open" }, { t = "C", p = "three", age = 200000 } })', 'three');
assert.deepStrictEqual([1, 2, 3].map((i) => row(i, 'title')), ['A', 'B', 'C']);
assert.deepStrictEqual([1, 2, 3].map((i) => row(i, 'sub')), ['one  now', 'two  1h', 'three  2d']);

// Scenario: A question typed during a refresh is not lost
run('SHOWN = false; NOW = 1200', 'stale');
before = shotCount();
run('SlashCmdList.CLAUDEBRIDGE("")', 'openStale');
assert.strictEqual(shotCount(), before + 1, 'stale list: one silent refresh');
const refresh = P.parsePayload(sentPayload());
assert.strictEqual(refresh.text, '!sessions');
run('ClaudeBridge_Send("what does this repo do")', 'typedDuring');
assert.strictEqual(shotCount(), before + 1, 'question waits for the refresh');
replyTo(refresh, '');
assert.strictEqual(shotCount(), before + 2, 'question went out after the refresh reply');
const queuedQ = P.parsePayload(sentPayload());
assert.strictEqual(queuedQ.text, 'what does this repo do');
replyTo(queuedQ, 'ok');

// Scenario: A silent refresh with no answer is dropped quietly
run('SHOWN = false; NOW = 1500; LINES = {}', 'stale2');
before = shotCount();
run('SlashCmdList.CLAUDEBRIDGE("")', 'openStale2');
assert.strictEqual(shotCount(), before + 1);
run('GetTime = function() return 116 end; ClaudeBridge_Poll(); GetTime = function() return 100 end', 'silentTimeout');
run('ClaudeBridge_Send("still there?")', 'afterTimeout');
assert.strictEqual(shotCount(), before + 2, 'window accepts questions again');
const shown = evalStr('table.concat(LINES, "\\n")');
assert.ok(!/No answer|Still waiting|didn't/.test(shown), shown);
replyTo(P.parsePayload(sentPayload()), 'yes');
console.log('Sessions panel tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/lua/run.js`
Expected: FAIL in `linktest.js` with an error mentioning `sessions` (`attempt to index a nil value (field 'sessions')`)

- [ ] **Step 3: Write minimal implementation**

All edits are in `addon/ClaudeBridge/ClaudeBridge.lua`.

(a) After `local ui                  -- built lazily` add:

```lua
local SESSIONS_STALE = 120  -- seconds before opening the window asks for a fresh sessions list
local SILENT_TIMEOUT = 15   -- a silent refresh with no answer by then is dropped
local SESSION_ROWS = 10
local queued              -- a question typed while a silent refresh was in flight
```

(b) In `buildUI`, change `f:SetSize(440, 300)` to `f:SetSize(620, 320)`, change the log's `log:SetPoint("BOTTOMRIGHT", -10, 38)` to `log:SetPoint("BOTTOMRIGHT", -190, 38)`, and the input's `input:SetPoint("BOTTOMRIGHT", -10, 10)` to `input:SetPoint("BOTTOMRIGHT", -190, 10)`. Then, right before `ui = f`, add:

```lua
  -- Sessions column (right side): your Claude Code sessions, newest first.
  local col = CreateFrame("Frame", nil, f)
  col:SetPoint("TOPRIGHT", -10, -28)
  col:SetPoint("BOTTOMLEFT", f, "BOTTOMRIGHT", -180, 10)
  local head = col:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  head:SetPoint("TOPLEFT", 0, 0)
  head:SetText("Sessions")
  col.rows = {}
  for i = 1, SESSION_ROWS do
    local y = -16 - (i - 1) * 26
    local row = {}
    row.dot = col:CreateTexture(nil, "OVERLAY")
    row.dot:SetSize(6, 6)
    row.dot:SetPoint("TOPLEFT", 0, y - 4)
    row.title = col:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    row.title:SetPoint("TOPLEFT", 10, y)
    row.title:SetWidth(160)
    row.title:SetJustifyH("LEFT")
    row.title:SetWordWrap(false)
    row.sub = col:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
    row.sub:SetPoint("TOPLEFT", 10, y - 11)
    row.sub:SetWidth(160)
    row.sub:SetJustifyH("LEFT")
    row.sub:SetWordWrap(false)
    col.rows[i] = row
  end
  f.sessions = col
```

(c) Replace `showUI` with:

```lua
local function showUI(focus)
  if not ui then buildUI() end
  ui:Show()
  if focus then ui.input:SetFocus() end
  ClaudeBridge_RenderSessions()
  ClaudeBridge_MaybeRefreshSessions()
end
```

(d) Right before `function ClaudeBridge_Send(text)` add:

```lua
-- Send the question that waited for a silent refresh, if any.
local function flushQueued()
  local q = queued
  queued = nil
  if q then ClaudeBridge_Send(q) end
end
```

(e) In `ClaudeBridge_Send`: change the signature to `function ClaudeBridge_Send(text, silent)`; replace

```lua
  if pending then
    addLine("Still waiting on the last answer... (/claude cancel to stop waiting)", 1, 0.8, 0.3)
    return
  end
```

with

```lua
  if pending then
    if pending.silent and not silent then
      queued = text -- goes out as soon as the sessions refresh is back
      setStatus("sending...")
      return
    end
    addLine("Still waiting on the last answer... (/claude cancel to stop waiting)", 1, 0.8, 0.3)
    return
  end
```

replace

```lua
  pending = { id = id, sentAt = GetTime(), ctx = ctx }
  setStatus("sending...")
```

with

```lua
  pending = { id = id, sentAt = GetTime(), ctx = ctx, silent = silent }
  if not silent then setStatus("sending...") end
```

and inside the `C_Timer.After(SHOT_WAIT, ...)` callback, right after `if pending and pending.id == id and not pending.shot then`, add:

```lua
      if pending.silent then pending = nil; flushQueued(); return end
```

(f) In `ClaudeBridge_Poll`, replace

```lua
  if GetTime() - pending.sentAt > TIMEOUT then
```

with

```lua
  if pending.silent and GetTime() - pending.sentAt > SILENT_TIMEOUT then
    pending = nil -- the list just stays as it was; no need to bother the player
    flushQueued()
    return
  end
  if GetTime() - pending.sentAt > TIMEOUT then
```

(g) In `ClaudeBridge_OnReply`, replace

```lua
  pending = nil
  setStatus("")
  showUI(false)
```

with

```lua
  local silent = pending.silent
  pending = nil
  setStatus("")
  if silent then flushQueued(); return end
  showUI(false)
```

(h) In the slash command's `cancel` branch, right after `elseif msg == "cancel" then`, add `queued = nil`.

(i) Right before the `-- Slash command and events` section header, add:

```lua
----------------------------------------------------------------------------
-- Sessions panel
----------------------------------------------------------------------------

local function formatAge(sec)
  if sec < 60 then return "now" end
  if sec < 3600 then return math.floor(sec / 60) .. "m" end
  if sec < 86400 then return math.floor(sec / 3600) .. "h" end
  return math.floor(sec / 86400) .. "d"
end

-- Called from reply slots, before ClaudeBridge_OnReply.
function ClaudeBridge_OnSessions(list)
  ClaudeBridgeDB.sessions = { at = time(), list = list }
  ClaudeBridge_RenderSessions()
end

function ClaudeBridge_RenderSessions()
  if not ui then return end
  local s = ClaudeBridgeDB.sessions
  local list = s and s.list or {}
  local since = s and (time() - s.at) or 0
  for i, row in ipairs(ui.sessions.rows) do
    local e = list[i]
    if e then
      row.title:SetText(e.t)
      row.sub:SetText(e.p .. "  " .. formatAge(e.age + since))
      if e.live == "busy" then row.dot:SetColorTexture(1, 0.8, 0.2)
      elseif e.live == "open" then row.dot:SetColorTexture(0.3, 0.9, 0.3)
      else row.dot:SetColorTexture(0, 0, 0, 0) end
      row.title:Show(); row.sub:Show(); row.dot:Show()
    else
      row.title:Hide(); row.sub:Hide(); row.dot:Hide()
    end
  end
end

-- Ask the bridge for a fresh list when ours (or our last ask) is over 2 minutes old.
function ClaudeBridge_MaybeRefreshSessions()
  local s = ClaudeBridgeDB.sessions
  local last = math.max(s and s.at or 0, ClaudeBridgeDB.sessionsAsked or 0)
  if pending or time() - last < SESSIONS_STALE then return end
  ClaudeBridgeDB.sessionsAsked = time()
  ClaudeBridge_Send("!sessions", true)
end
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/lua/run.js`
Expected: every suite passes, ending with `Sessions panel tests passed.` and `All Lua tests passed.`

- [ ] **Step 5: Commit**

```bash
git add addon/ClaudeBridge/ClaudeBridge.lua test/lua/make-linktest.js test/lua/linkstubs.lua test/lua/linkcases.js
git commit -m "Addon: sessions column, refreshed when the window opens"
```

---

### Task 4: Install, document, check in game

**Satisfies:** none (manual check of the slice end to end)

**Files:**
- Modify: `README.md` (Things to know: one bullet)

- [ ] **Step 1: Run every test**

Run: `node bridge/test.js` and `node test/lua/run.js`
Expected: both end with their "All ... tests passed." line.

- [ ] **Step 2: Document**

In `README.md` under "Things to know", after the shift-click bullet, add:

```markdown
- **Sessions column.** The window lists your 10 most recent Claude Code sessions
  (title, project, last active; a yellow dot means busy in the desktop app, green
  means open). The bridge reads only titles, folders and file times, and the list
  never goes to Claude. Opening the window refreshes it when it's over 2 minutes
  old, which uses one reply slot.
```

- [ ] **Step 3: Install and restart the bridge**

Copy `addon/ClaudeBridge/ClaudeBridge.lua` into `<WoW>\_forever_\Interface\AddOns\ClaudeBridge\`, stop the bridge (Ctrl+C) and start it again with `node bridge\bridge.js`.

- [ ] **Step 4: Check in game**

`/reload`, open the window. Expected within a few seconds: the sessions column fills, the bridge log shows `Reply <id> -> slot N.` with no `Prompt` line (Claude was not asked), and a session open in the desktop app has a dot. Ask a question: the answer arrives and the list ages update without another refresh.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "README: sessions column"
```
