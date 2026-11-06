#!/usr/bin/env node
// Claude Bridge: watches WoW's Screenshots folder for prompts from the in-game
// window, asks Claude Code, and writes the answer into the next reply slot addon.
//
//   node bridge.js
//
// Leave it running while you play. Ctrl+C to stop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const P = require('./protocol');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.CB_CONFIG || path.join(ROOT, 'config.json');
const STATE_PATH = process.env.CB_STATE || path.join(ROOT, 'state.json');
const AGENT_HOME = path.join(ROOT, 'agent-home');

const POLL_MS = 250;
const CLAUDE_TIMEOUT_MS = 200_000;
const STARTUP_GRACE_MS = 240_000; // matches the addon's reply TIMEOUT
const IMAGE_EXT = /\.(tga|png|jpe?g)$/i;

const SYSTEM_PROMPT = [
  'You are answering questions typed into a small chat window inside World of Warcraft: Forever,',
  "Blizzard's Classic Plus version of WoW (levels 1-60, vanilla-style classes with Forever's own changes).",
  'The player reads your answer in-game, often mid-session, so:',
  '- Keep it short: a few sentences or a short list, under about 120 words unless they ask for more.',
  '- Plain text only. No markdown tables, headings, or code blocks; simple "- " bullets are fine.',
  "- Forever's classes and balance change often. If a detail may be outdated, say so briefly, and use",
  '  web search when the question depends on current Forever specifics.',
  '- Messages may start with a [Game state] block the addon adds automatically: the player\'s own',
  '  character (class, level, zone, talents, gear, quests...). Use it to tailor answers without',
  '  repeating it back. Later messages only include fields that changed, so earlier values still hold.',
].join('\n');

function log(...args) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}]`, ...args);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// JPEG has no built-in decoder in Node, so let Windows convert it to PNG.
function jpegToPng(file) {
  const out = path.join(os.tmpdir(), `cb-${process.pid}-${Date.now()}.png`);
  // Paths go in through the environment: "D:\World of Warcraft" has spaces,
  // and -Command splits its arguments on them.
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$i = [System.Drawing.Image]::FromFile($env:CB_IN)',
    '$i.Save($env:CB_OUT, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$i.Dispose()',
  ].join('; ');
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CB_IN: file, CB_OUT: out },
    });
  } catch {
    throw new Error('not a readable JPEG');
  }
  try { return fs.readFileSync(out); } finally { fs.rmSync(out, { force: true }); }
}

function readImage(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tga') return P.readTga(fs.readFileSync(file));
  if (ext === '.png') return P.readPng(fs.readFileSync(file));
  return P.readPng(jpegToPng(file));
}

class Bridge {
  constructor(cfg) {
    this.cfg = cfg;
    this.addonsDir = path.join(cfg.wowDir, 'Interface', 'AddOns');
    this.shotsDir = path.join(cfg.wowDir, 'Screenshots');
    this.svFiles = (cfg.savedVarDirs || []).map((d) => path.join(d, 'ClaudeBridge.lua'));
    this.state = loadJson(STATE_PATH, {});
    this.queue = [];
    this.busy = false;
    this.cursor = 1;
    this.seen = new Map();   // screenshot file -> size last seen (to wait until it's fully written)
    this.svMtimes = new Map();
    this.timer = null;
  }

  saveState() {
    fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2) + '\n');
  }

  // Empty every slot and signal so a fresh UI session starts from slot 1.
  resetSlots(reason) {
    for (let i = 1; i <= this.cfg.slots; i++) {
      fs.writeFileSync(path.join(this.addonsDir, 'ClaudeBridge', 'sig', P.sigName(i)), Buffer.alloc(0));
      fs.writeFileSync(path.join(this.addonsDir, P.slotName(i), 'r.lua'), P.EMPTY_SLOT_LUA);
    }
    this.cursor = 1;
    log(`Reply slots reset (${reason}).`);
  }

  writeReply(id, text) {
    if (this.cursor > this.cfg.slots) {
      log('Out of reply slots. /reload in game to reset them.');
      return;
    }
    const i = this.cursor++;
    // Reply first, signal second: the game only loads the slot once the signal plays.
    fs.writeFileSync(path.join(this.addonsDir, P.slotName(i), 'r.lua'), P.slotLua(id, text));
    fs.writeFileSync(path.join(this.addonsDir, 'ClaudeBridge', 'sig', P.sigName(i)), P.silentWav());
    this.saveCursor();
    log(`Reply ${id} -> slot ${i}.`);
  }

  askClaude(prompt) {
    const [cmd, ...baseArgs] = this.cfg.claudeCommand || ['claude'];
    const args = [
      ...baseArgs,
      '-p',
      '--output-format', 'json',
      '--tools', 'WebSearch,WebFetch',          // answer-only: no file edits, no shell
      '--allowedTools', 'WebSearch,WebFetch',   // pre-approved: nobody is there to click "allow"
      '--append-system-prompt', SYSTEM_PROMPT,
    ];
    if (this.state.sessionId) args.push('--resume', this.state.sessionId);

    return new Promise((resolve) => {
      fs.mkdirSync(AGENT_HOME, { recursive: true });
      const child = spawn(cmd, args, { cwd: AGENT_HOME, windowsHide: true });
      let out = '';
      let err = '';
      const kill = setTimeout(() => child.kill(), CLAUDE_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        clearTimeout(kill);
        resolve({ ok: false, text: `error: couldn't start Claude (${e.message})` });
      });
      child.on('close', () => {
        clearTimeout(kill);
        let j;
        try { j = JSON.parse(out); } catch {
          resolve({ ok: false, text: `error: Claude gave no answer. ${err.trim().slice(0, 200)}` });
          return;
        }
        if (j.session_id && !j.is_error) {
          this.state.sessionId = j.session_id;
          this.saveState();
        }
        let text = j.result || '(empty answer)';
        if (j.is_error && /log ?in/i.test(text)) {
          text = 'error: Claude Code is not logged in on your PC. Run "claude" in a terminal and log in.';
        } else if (j.is_error) {
          text = `error: ${text}`;
        }
        resolve({ ok: !j.is_error, text });
      });
      child.stdin.end(prompt);
    });
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const { id, text, ctx } = this.queue.shift();
      if (text === '!new') {
        delete this.state.sessionId;
        this.saveState();
        this.writeReply(id, 'Started a new conversation.');
        continue;
      }
      if (text === '!selftest') {
        this.writeReply(id, 'Self-test OK: your screenshot was decoded on the PC and this reply came back in. Claude was not asked.');
        continue;
      }
      log(`Prompt ${id}: ${text}${ctx.length ? ` (+ ${ctx.map(([k]) => k).join(', ')})` : ''}`);
      const started = Date.now();
      const res = await this.askClaude(P.buildPrompt(text, ctx));
      log(`Claude ${res.ok ? 'answered' : 'failed'} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
      this.writeReply(id, res.text);
    }
    this.busy = false;
  }

  handleScreenshot(file) {
    let img;
    try { img = readImage(file); } catch (e) {
      log(`Couldn't read ${path.basename(file)}: ${e.message}`);
      return;
    }
    const payload = P.decodeStrip(img);
    if (payload === null) return; // an ordinary screenshot: leave it alone
    fs.rmSync(file, { force: true }); // ours: the strip has done its job
    const msg = P.parsePayload(payload);
    if (!msg) { log('Decoded a strip with no prompt id, ignoring.'); return; }
    this.queue.push(msg);
    this.drain();
  }

  // New screenshot files are handled once their size stops changing.
  scanScreenshots(initial = false) {
    let names;
    try { names = fs.readdirSync(this.shotsDir); } catch { return; }
    for (const name of names) {
      if (!IMAGE_EXT.test(name)) continue;
      const file = path.join(this.shotsDir, name);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      const prev = this.seen.get(file);
      if (initial) {
        // Files from before the bridge started are skipped, except recent ones:
        // the game waits up to 4 minutes for a reply, so a prompt sent just
        // before the bridge started still deserves an answer.
        let recent = false;
        try { recent = Date.now() - fs.statSync(file).mtimeMs < STARTUP_GRACE_MS; } catch { /* gone */ }
        this.seen.set(file, recent ? size : -1);
        continue;
      }
      if (prev === -1 || prev === -2) continue;
      if (prev === size && size > 0) {
        this.seen.set(file, -2);
        this.handleScreenshot(file);
      } else {
        this.seen.set(file, size);
      }
    }
  }

  // Returns true if any SavedVariables file changed since we last looked.
  checkSavedVars() {
    let changed = false;
    for (const f of this.svFiles) {
      let m = 0; // a file appearing for the first time counts as a change
      try { m = fs.statSync(f).mtimeMs; } catch { /* not written yet */ }
      const prev = this.svMtimes.get(f);
      this.svMtimes.set(f, m);
      if (prev !== undefined && m !== prev) changed = true;
    }
    if (changed) {
      this.resetSlots('game reloaded');
      this.saveCursor();
    }
    return changed;
  }

  // Remember the slot cursor with the SavedVariables times it belongs to, so
  // restarting the bridge mid-session doesn't desync it from the game.
  saveCursor() {
    this.state.cursor = this.cursor;
    this.state.svMtimes = Object.fromEntries(this.svMtimes);
    this.saveState();
  }

  tick() {
    try {
      this.scanScreenshots();
      this.checkSavedVars();
    } catch (e) {
      log(`Error: ${e.message}`);
    }
  }

  start() {
    this.checkSavedVars(); // records current times; nothing to compare yet
    const saved = this.state.svMtimes || {};
    const sameSession = this.svFiles.length > 0 &&
      this.svFiles.every((f) => saved[f] === this.svMtimes.get(f));
    if (sameSession && this.state.cursor) {
      this.cursor = this.state.cursor;
      log(`Same game session as last run, continuing at reply slot ${this.cursor}.`);
    } else {
      this.resetSlots('bridge started');
      this.saveCursor();
    }
    fs.mkdirSync(this.shotsDir, { recursive: true });
    this.scanScreenshots(true);
    this.timer = setInterval(() => this.tick(), POLL_MS);
    log(`Watching ${this.shotsDir}. Type /claude in game. Ctrl+C to stop.`);
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { Bridge, SYSTEM_PROMPT, readImage };

if (require.main === module) {
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg) {
    console.error(`No ${CONFIG_PATH}. Run "node setup.js" first.`);
    process.exit(1);
  }
  new Bridge(cfg).start();
}
