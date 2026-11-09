#!/usr/bin/env node
// Offline end-to-end test: fake WoW folder + fake Claude + rendered strip
// screenshots, no game needed.
//   node test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
process.env.CB_CONFIG = path.join(tmp, 'config.json');
process.env.CB_STATE = path.join(tmp, 'state.json');
process.env.CB_AGENT_HOME = path.join(tmp, 'agent-home');

const P = require('./protocol');
const { setup } = require('./setup');
const { Bridge, readImage } = require('./bridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(50); }
  throw new Error('timed out waiting');
}

// Render a strip onto a gray "game" background, like the addon does.
// levels: what each 2-bit level becomes on screen (simulates gamma/brightness).
function renderScreen(payload, { w = 1920, h = 1080, levels = P.LEVEL_RGB } = {}) {
  const data = Buffer.alloc(w * h * 3, 60);
  const width = Math.floor(w / P.BLOCK);
  P.encodeStrip(payload, width).forEach((s, i) => {
    const rgb = [Math.floor(s / 16), Math.floor(s / 4) % 4, s % 4].map((l) => levels[l]);
    const bx = (i % width) * P.BLOCK;
    const by = Math.floor(i / width) * P.BLOCK;
    for (let y = by; y < by + P.BLOCK; y++) {
      for (let x = bx; x < bx + P.BLOCK; x++) data.set(rgb, (y * w + x) * 3);
    }
  });
  return { width: w, height: h, channels: 3, data };
}

function writeTga(img, file) {
  const head = Buffer.alloc(18);
  head[2] = 2;
  head.writeUInt16LE(img.width, 12);
  head.writeUInt16LE(img.height, 14);
  head[16] = 24;                    // bottom-left origin, like most TGA writers
  const body = Buffer.alloc(img.width * img.height * 3);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 3;
      const d = ((img.height - 1 - y) * img.width + x) * 3;
      body[d] = img.data[s + 2]; body[d + 1] = img.data[s + 1]; body[d + 2] = img.data[s];
    }
  }
  fs.writeFileSync(file, Buffer.concat([head, body]));
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePng(img, file) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const stride = img.width * 3;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function pngToJpeg(png, jpg) {
  const script = 'Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Image]::FromFile($env:CB_IN); $i.Save($env:CB_OUT, [System.Drawing.Imaging.ImageFormat]::Jpeg); $i.Dispose()';
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, CB_IN: png, CB_OUT: jpg },
  });
}

// --- codec unit checks ---
const bytes = [0, 1, 2, 250, 255, 128, 7];
assert.deepStrictEqual(P.symbolsToBytes(P.bytesToSymbols(bytes), bytes.length), bytes);
assert.strictEqual(P.decodeStrip(renderScreen('abc123|hello')), 'abc123|hello');
const long = 'abc123|' + 'how do i frost nova pull a whole camp of murlocs? '.repeat(24) + 'ünïcødé ✓';
assert.strictEqual(P.decodeStrip(renderScreen(long)), long);
assert.strictEqual(P.decodeStrip(renderScreen('abc123|gamma', { levels: [18, 70, 150, 228] })), 'abc123|gamma');
assert.strictEqual(P.decodeStrip({ width: 1920, height: 1080, channels: 3, data: Buffer.alloc(1920 * 1080 * 3, 90) }), null);
// Flip one block's color: the checksum must reject it.
const bad = renderScreen('abc123|hello');
for (let y = 0; y < P.BLOCK; y++) for (let x = 12 * 16; x < 13 * 16; x++) bad.data[(y * 1920 + x) * 3] ^= 255;
assert.strictEqual(P.decodeStrip(bad), null);
assert.strictEqual(P.luaLongString('a]=]b'), '[==[\na]=]b]==]');
assert.strictEqual(P.luaLongString('ends in ]='), '[==[\nends in ]=]==]');
assert.strictEqual(P.cleanForWow('**bold** |cff'), 'bold ||cff');
assert.strictEqual(P.cleanForWow('see [Blizzard](https://x.com/a_(b)) now'), 'see Blizzard now');

// Payloads with and without the character-info block.
const G = P.CTX_SEP;
assert.deepStrictEqual(P.parsePayload('abc123|hi'), { id: 'abc123', text: 'hi', ctx: [] });
assert.deepStrictEqual(P.parsePayload(`abc123|${G}char\tBob, level 11 Human Mage\nzone\tElwynn Forest${G}where now?`),
  { id: 'abc123', text: 'where now?', ctx: [['char', 'Bob, level 11 Human Mage'], ['zone', 'Elwynn Forest']] });
assert.strictEqual(P.parsePayload('nope'), null);
assert.strictEqual(P.buildPrompt('hi', []), 'hi');
assert.match(P.buildPrompt('where now?', [['zone', 'Elwynn Forest']]), /^\[Game state[^\n]*\]\nLocation: Elwynn Forest\n\n\[Question\]\nwhere now\?$/);
assert.match(P.buildPrompt('[Wand] upgrade?', [['zone', 'Elwynn'], ['att_item', 'Wand / Ranged'], ['att_equipped', 'Old Wand']]),
  /^\[Game state[^\n]*\]\nLocation: Elwynn\n\n\[Shift-clicked[^\n]*\]\nLinked item: Wand \/ Ranged\nCurrently equipped in that slot: Old Wand\n\n\[Question\]\n\[Wand\] upgrade\?$/);
assert.match(P.buildPrompt('q', [['att_quest', 'Bounty']]), /^\[Shift-clicked[^\n]*\]\nLinked quest: Bounty\n\n\[Question\]\nq$/);

// File formats (JPEG goes through the same Windows conversion the bridge uses).
const formats = path.join(tmp, 'formats');
fs.mkdirSync(formats);
const img = renderScreen('fff000|format check');
writeTga(img, path.join(formats, 'a.tga'));
writePng(img, path.join(formats, 'a.png'));
pngToJpeg(path.join(formats, 'a.png'), path.join(formats, 'a.jpg'));
for (const f of ['a.tga', 'a.png', 'a.jpg']) {
  assert.strictEqual(P.decodeStrip(readImage(path.join(formats, f))), 'fff000|format check', f);
}
// A real Forever screenshot (no strip) must be ignored, if one is around.
const realShots = 'D:\\World of Warcraft\\_forever_\\Screenshots';
const real = fs.existsSync(realShots) && fs.readdirSync(realShots).find((n) => /\.jpe?g$/i.test(n));
if (real) assert.strictEqual(P.decodeStrip(readImage(path.join(realShots, real))), null, real);
console.log(`Codec checks passed (TGA, PNG, JPEG${real ? ', real screenshot ignored' : ''}).`);

(async () => {
  await require('./waypoint-mcp.test')(tmp);
  // --- fake WoW install ---
  const wow = path.join(tmp, '_forever_');
  const svDir = path.join(wow, 'WTF', 'Account', '12345#1', 'SavedVariables');
  const shots = path.join(wow, 'Screenshots');
  fs.mkdirSync(svDir, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(path.join(wow, 'Interface', 'AddOns'), { recursive: true });
  writeTga(renderScreen('000000|old prompt'), path.join(shots, 'WoWScrnShot_old.tga'));
  const hourAgo = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(shots, 'WoWScrnShot_old.tga'), hourAgo, hourAgo);
  fs.writeFileSync(path.join(shots, 'WoWScrnShot_mine.jpg'), 'not really a jpeg');
  // Sent seconds before the bridge started: must still be answered.
  writeTga(renderScreen('0e0e0e|!selftest'), path.join(shots, 'WoWScrnShot_early.tga'));

  // Fake Claude: echoes the prompt back in the same JSON shape as `claude -p --output-format json`,
  // and plays the waypoint tools by appending to the file named in the bridge's MCP config.
  // Like real Claude Code with nobody to click "allow", it only uses tools on --allowedTools.
  const fake = path.join(tmp, 'fake-claude.js');
  fs.writeFileSync(fake, `
    const fs = require('fs');
    let s = ''; process.stdin.on('data', d => s += d);
    process.stdin.on('end', () => {
      const resumed = process.argv.includes('--resume');
      const at = process.argv.indexOf('--mcp-config');
      const file = at > 0 ? JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8')).mcpServers.wow.env.CB_WAYPOINT_FILE : null;
      const allowed = (process.argv[process.argv.indexOf('--allowedTools') + 1] || '').split(',');
      const use = (tool, action) => { if (allowed.includes('mcp__wow__' + tool)) fs.appendFileSync(file, JSON.stringify(action) + '\\n'); };
      const wp = (zone, x, y, label) => use('set_waypoint', { stops: [{ zone, x, y, label }] });
      const route = (...stops) => use('set_waypoints', { stops: stops.map(([zone, x, y, label]) => ({ zone, x, y, label })) });
      const clear = () => use('clear_waypoint', { clear: true });
      if (s.includes('where is Hogger')) wp('Elwynn Forest', 25.6, 78.4, 'Hogger');
      if (s.includes('two spots')) { wp('Elwynn Forest', 10, 10, 'First'); wp('Westfall', 56.5, 52.6, 'Sentinel Hill'); }
      if (s.includes('made it')) { wp('Elwynn Forest', 1, 1, 'Old'); clear(); }
      if (s.includes('next stop')) { clear(); wp('Westfall', 56.2, 47.6, 'Gryan Stoutmantle'); }
      if (s.includes('route to the cave')) route(['Westfall', 45.2, 33.1, 'Murloc camp'], ['Elwynn Forest', 40, 20.1, 'Cave'], ['Elwynn Forest', 25.6, 78.4, 'Hogger']);
      if (s.includes('two routes')) { route(['Elwynn Forest', 1, 1, 'Old A'], ['Elwynn Forest', 2, 2, 'Old B']); route(['Westfall', 56.5, 52.6, 'Sentinel Hill'], ['Westfall', 56.2, 47.6, 'Gryan Stoutmantle']); }
      if (s.includes('route then done')) { route(['Elwynn Forest', 1, 1, 'A'], ['Elwynn Forest', 2, 2, 'B']); clear(); }
      if (s.trim() === '/compact' && process.env.FAKE_SLOW) { setTimeout(() => {}, 5000); return; }
      if (s.trim() === '/compact') { process.stdout.write(JSON.stringify({ result: '', session_id: 'sess-1', is_error: false, usage: { iterations: [] } })); return; }
      // Real answers report each API call's tokens; the last one is the conversation's size.
      const usage = s.includes('big chat') ? { iterations: [
        { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 },
        { input_tokens: 2, cache_read_input_tokens: 400000, cache_creation_input_tokens: 11998, output_tokens: 0 },
      ] } : undefined;
      const modelUsage = usage ? { 'claude-test': { contextWindow: 1000000 } } : undefined;
      process.stdout.write(JSON.stringify({ result: 'Echo: ' + s + (resumed ? ' (resumed)' : '') + ' ]]', session_id: 'sess-1', is_error: false, usage, modelUsage }));
    });`);

  setup({ wow, slots: 3 });
  const cfg = JSON.parse(fs.readFileSync(process.env.CB_CONFIG, 'utf8'));
  cfg.claudeCommand = [process.execPath, fake];
  assert.deepStrictEqual(cfg.savedVarDirs, [svDir]);

  const addons = path.join(wow, 'Interface', 'AddOns');
  const slot = (i) => fs.readFileSync(path.join(addons, P.slotName(i), 'r.lua'), 'utf8');
  const sig = (i) => fs.statSync(path.join(addons, 'ClaudeBridge', 'sig', P.sigName(i))).size;

  const bridge = new Bridge(cfg);
  bridge.start();

  await waitFor(() => sig(1) > 0);
  assert.match(slot(1), /^ClaudeBridge_OnReply\("0e0e0e", /, 'recent pre-start prompt answered');
  assert.ok(!fs.existsSync(path.join(shots, 'WoWScrnShot_early.tga')));

  // From here on slot numbers are shifted by one.
  bridge.cursor = 1;
  writeTga(renderScreen('abc123|how do I frost nova pull?'), path.join(shots, 'WoWScrnShot_1.tga'));
  await waitFor(() => slot(1).includes('abc123'));
  await waitFor(() => sig(1) > 0);
  assert.match(slot(1), /^ClaudeBridge_OnReply\("abc123", \[=+\[\n/);
  assert.ok(slot(1).includes('Echo: how do I frost nova pull?'), slot(1));
  assert.ok(!fs.existsSync(path.join(shots, 'WoWScrnShot_1.tga')), 'decoded strip screenshot is deleted');
  assert.ok(fs.existsSync(path.join(shots, 'WoWScrnShot_old.tga')), 'files from before the bridge started are untouched');
  assert.ok(fs.existsSync(path.join(shots, 'WoWScrnShot_mine.jpg')), 'unreadable/ordinary screenshots are untouched');

  // An ordinary screenshot taken while the bridge runs is left alone.
  const plain = path.join(shots, 'WoWScrnShot_plain.png');
  writePng({ width: 640, height: 480, channels: 3, data: Buffer.alloc(640 * 480 * 3, 120) }, plain);

  // Second prompt resumes the same Claude session and goes to slot 2.
  writePng(renderScreen('def456|thanks'), path.join(shots, 'WoWScrnShot_2.png'));
  await waitFor(() => sig(2) > 0);
  assert.ok(slot(2).includes('Echo: thanks (resumed)'), slot(2));
  assert.ok(fs.existsSync(plain), 'ordinary screenshot kept');

  // Character info reaches Claude as readable lines before the question.
  writeTga(renderScreen(`c0ffee|${G}char\tTestmage, level 11 Human Mage\ngear\tRanged: Greater Magic Wand (17)${G}upgrade?`),
    path.join(shots, 'WoWScrnShot_ctx.tga'));
  await waitFor(() => slot(3).includes('c0ffee'));
  assert.ok(slot(3).includes('Character: Testmage, level 11 Human Mage\nEquipped: Ranged: Greater Magic Wand (17)\n\n[Question]\nupgrade?'), slot(3));
  bridge.cursor = 3; // reuse slot 3 below

  // Scenario: Asking where something is sets a waypoint
  bridge.cursor = 3;
  writeTga(renderScreen('a0a0a0|where is Hogger?'), path.join(shots, 'WoWScrnShot_wp1.tga'));
  await waitFor(() => slot(3).includes('a0a0a0'));
  assert.match(slot(3), /^ClaudeBridge_OnReply\("a0a0a0", \[(=+)\[\n[\s\S]*\]\1\], \{ waypoints = \{ \{ zone = \[=+\[\nElwynn Forest\]=+\], x = 25\.6, y = 78\.4, label = \[=+\[\nHogger\]=+\] \} \} \}\)\n$/, slot(3));

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

  // Scenario: Claude clears the waypoint (set then clear in one answer: the clear wins)
  bridge.cursor = 3;
  writeTga(renderScreen('d1d1d1|made it, clear the arrow'), path.join(shots, 'WoWScrnShot_wp4.tga'));
  await waitFor(() => slot(3).includes('d1d1d1'));
  assert.match(slot(3), /, \{ clear_waypoint = true \}\)\n$/, slot(3));
  assert.ok(!slot(3).includes('waypoints ='), slot(3));

  // Scenario: The last action in an answer wins (clear then set: the new waypoint)
  bridge.cursor = 3;
  writeTga(renderScreen('e1e1e1|next stop gryan'), path.join(shots, 'WoWScrnShot_wp5.tga'));
  await waitFor(() => slot(3).includes('e1e1e1'));
  assert.ok(slot(3).includes('Gryan Stoutmantle') && !slot(3).includes('clear_waypoint'), slot(3));

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

  // Scenario: Each answer reports the conversation's size
  bridge.cursor = 3;
  writeTga(renderScreen('c7c7c7|a big chat'), path.join(shots, 'WoWScrnShot_cx1.tga'));
  await waitFor(() => slot(3).includes('c7c7c7'));
  assert.match(slot(3), /, \{ context = \[=+\[\n412k of 1M tokens \(41%\)\]=+\] \}\)\n$/, slot(3));

  // Scenario: Compact shows progress and completion (the bridge side)
  bridge.cursor = 3;
  writeTga(renderScreen('c8c8c8|!compact'), path.join(shots, 'WoWScrnShot_cx2.tga'));
  await waitFor(() => slot(3).includes('c8c8c8'));
  assert.ok(slot(3).includes('Compacted. It was 412k of 1M tokens (41%).'), slot(3));
  assert.ok(slot(3).includes('context = [') && slot(3).includes('just compacted'), slot(3));
  assert.strictEqual(JSON.parse(fs.readFileSync(process.env.CB_STATE, 'utf8')).sessionId, 'sess-1', 'compacting keeps the conversation');

  // Scenario: Typing /compact as a message compacts too (an older addon sends it as plain text)
  bridge.cursor = 3;
  writeTga(renderScreen('cacaca|/compact'), path.join(shots, 'WoWScrnShot_cx4.tga'));
  await waitFor(() => slot(3).includes('cacaca'));
  assert.ok(slot(3).includes('Compacted.'), slot(3));

  // Scenario: A compact that runs too long is stopped with a clear message
  bridge.cursor = 3;
  bridge.compactTimeoutMs = 400;
  process.env.FAKE_SLOW = '1';
  writeTga(renderScreen('cbcbcb|!compact'), path.join(shots, 'WoWScrnShot_cx5.tga'));
  await waitFor(() => slot(3).includes('cbcbcb'));
  delete process.env.FAKE_SLOW;
  assert.ok(slot(3).includes('error: Compacting took too long, so the bridge stopped it. Your conversation is unchanged.'), slot(3));

  bridge.cursor = 3; // reuse slot 3 again

  // Self-test never calls Claude.
  writeTga(renderScreen('5e1f00|!selftest'), path.join(shots, 'WoWScrnShot_3.tga'));
  await waitFor(() => slot(3).includes('Self-test OK'));

  // Restarting the bridge mid-session keeps the cursor.
  bridge.stop();
  const bridge2 = new Bridge(cfg);
  bridge2.start();
  assert.strictEqual(bridge2.cursor, 4);

  // A /reload rewrites SavedVariables -> all slots reset.
  fs.writeFileSync(path.join(svDir, 'ClaudeBridge.lua'), 'ClaudeBridgeDB = {}\n');
  await waitFor(() => sig(1) === 0);
  assert.strictEqual(slot(1), P.EMPTY_SLOT_LUA);
  assert.strictEqual(bridge2.cursor, 1);

  // "/claude new" clears the session.
  writeTga(renderScreen('aaa111|!new'), path.join(shots, 'WoWScrnShot_4.tga'));
  await waitFor(() => sig(1) > 0);
  assert.ok(slot(1).includes('Started a new conversation.'));
  assert.strictEqual(JSON.parse(fs.readFileSync(process.env.CB_STATE, 'utf8')).sessionId, undefined);
  assert.ok(slot(1).includes('context = [') && slot(1).includes('new conversation'), slot(1));

  // Scenario: Compact with no conversation says so
  writeTga(renderScreen('c9c9c9|!compact'), path.join(shots, 'WoWScrnShot_cx3.tga'));
  await waitFor(() => sig(2) > 0);
  assert.ok(slot(2).includes("There's no conversation to compact yet."), slot(2));

  bridge2.stop();
  console.log('All bridge tests passed.');
})().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(); // a failed test can leave a bridge timer running
});
