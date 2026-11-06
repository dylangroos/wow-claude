#!/usr/bin/env node
// Installs the Claude Bridge addon and its reply slots into WoW: Forever.
//
//   node setup.js                       install (or refresh) with defaults
//   node setup.js --wow "D:\\...\\_forever_" --slots 50 --interface 16001
//   node setup.js --uninstall           remove the addon and reply slots
//
// Run it with WoW closed (or restart WoW afterwards). WoW only discovers
// addon folders and files at launch.

const fs = require('fs');
const path = require('path');
const P = require('./protocol');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.CB_CONFIG || path.join(ROOT, 'config.json');
const ADDON_SRC = path.join(ROOT, 'addon', 'ClaudeBridge');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uninstall') out.uninstall = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

// SavedVariables folders for every account under WTF\Account.
function findSavedVarDirs(wowDir) {
  const acct = path.join(wowDir, 'WTF', 'Account');
  if (!fs.existsSync(acct)) return [];
  return fs.readdirSync(acct, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'SavedVariables')
    .map((d) => path.join(acct, d.name, 'SavedVariables'));
}

function loadConfig() {
  return fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
}

function setup(opts = {}) {
  const prev = loadConfig();
  const wowDir = path.resolve(opts.wow || prev.wowDir || 'D:\\World of Warcraft\\_forever_');
  const addonsDir = path.join(wowDir, 'Interface', 'AddOns');
  const slots = Number(opts.slots || prev.slots || 50);
  const iface = String(opts.interface || prev.interface || '16001');

  if (!fs.existsSync(wowDir)) throw new Error(`WoW folder not found: ${wowDir}`);
  if (slots < 1 || slots > 99) throw new Error('--slots must be between 1 and 99');

  if (opts.uninstall) {
    for (const name of fs.existsSync(addonsDir) ? fs.readdirSync(addonsDir) : []) {
      if (name === 'ClaudeBridge' || /^ClaudeBridge_R\d+$/.test(name)) {
        fs.rmSync(path.join(addonsDir, name), { recursive: true, force: true });
      }
    }
    console.log(`Removed Claude Bridge from ${addonsDir}`);
    return null;
  }

  const cfg = {
    wowDir,
    slots,
    interface: iface,
    savedVarDirs: findSavedVarDirs(wowDir),
    claudeCommand: prev.claudeCommand || ['claude'],
  };

  // Main addon
  const dest = path.join(addonsDir, 'ClaudeBridge');
  fs.mkdirSync(path.join(dest, 'sig'), { recursive: true });
  for (const f of fs.readdirSync(ADDON_SRC)) {
    fs.copyFileSync(path.join(ADDON_SRC, f), path.join(dest, f));
  }
  fs.writeFileSync(
    path.join(dest, 'ClaudeBridge.toc'),
    fs.readFileSync(path.join(ADDON_SRC, 'ClaudeBridge.toc'), 'utf8')
      .replace(/^## Interface:.*$/m, `## Interface: ${iface}`),
  );
  fs.writeFileSync(path.join(dest, 'config.lua'), P.configLua(cfg));

  // Remove slots beyond the new count, then (re)create 1..slots empty.
  for (const name of fs.readdirSync(addonsDir)) {
    const m = /^ClaudeBridge_R(\d+)$/.exec(name);
    if (m && Number(m[1]) > slots) fs.rmSync(path.join(addonsDir, name), { recursive: true, force: true });
  }
  for (let i = 1; i <= slots; i++) {
    const dir = path.join(addonsDir, P.slotName(i));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${P.slotName(i)}.toc`), P.slotToc(i, iface));
    fs.writeFileSync(path.join(dir, 'r.lua'), P.EMPTY_SLOT_LUA);
    fs.writeFileSync(path.join(dest, 'sig', P.sigName(i)), Buffer.alloc(0));
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Installed Claude Bridge with ${slots} reply slots into ${addonsDir}`);
  console.log(`Config written to ${CONFIG_PATH}`);
  if (cfg.savedVarDirs.length === 0) {
    console.log('Note: no WTF\\Account folder yet. Log into WoW once, then run setup again.');
  }
  return cfg;
}

module.exports = { setup, findSavedVarDirs };

if (require.main === module) {
  try {
    setup(parseArgs(process.argv.slice(2)));
    console.log('Restart WoW (fully quit, not /reload) so it picks up the new addon files.');
  } catch (err) {
    console.error(`Setup failed: ${err.message}`);
    process.exit(1);
  }
}
