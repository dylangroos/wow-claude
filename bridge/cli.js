#!/usr/bin/env node
// Entry point of ClaudeBridge.exe (also runs from the repo: node bridge/cli.js).
//
//   ClaudeBridge.exe                 first run: install the addon, then run the bridge
//   ClaudeBridge.exe setup [--wow "D:\...\_forever_"] [--slots 50] [--uninstall]
//   ClaudeBridge.exe --version
//   ClaudeBridge.exe --waypoint-mcp  internal: the waypoint tools Claude calls
const fs = require('fs');
const readline = require('readline');
const { execFileSync } = require('child_process');
const VERSION = require('./version');
const { isPackaged } = require('./paths');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// A double-clicked exe's window closes the moment it exits, taking the message with it.
async function fail(message) {
  console.error(message);
  if (isPackaged && process.stdin.isTTY) await ask('Press Enter to close.');
  process.exit(1);
}

function checkClaude(cfg) {
  const [cmd, ...args] = cfg.claudeCommand || ['claude'];
  try {
    execFileSync(cmd, [...args, '--version'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
  } catch (e) {
    console.log(e.code === 'ENOENT'
      ? 'Warning: Claude Code isn\'t installed (no "claude" command found). Install it from https://claude.com/claude-code and log in, or every answer will fail.'
      : `Warning: "claude --version" failed (${e.message.split('\n')[0]}). Answers may fail until Claude Code works in a terminal.`);
  }
}

async function firstRun(setup) {
  let wow = setup.findWowDir();
  if (wow) {
    console.log(`Found WoW: Forever at ${wow}`);
  } else {
    wow = (await ask('Where is WoW: Forever installed? Paste the _forever_ folder path: ')).replace(/^"|"$/g, '');
  }
  setup.setup({ wow });
  console.log('If WoW is open, quit it fully and start it again so it loads the addon (a /reload is not enough).');
  console.log('');
}

async function run(argv) {
  const cmd = argv[0];
  if (cmd === '--waypoint-mcp') {
    require('./waypoint-mcp').serve(process.stdin, process.stdout, process.env.CB_WAYPOINT_FILE);
    return;
  }
  if (cmd === '--version' || cmd === '-v') { console.log(VERSION); return; }

  const setup = require('./setup');
  if (cmd === 'setup') {
    setup.setup(setup.parseArgs(argv.slice(1)));
    console.log('Restart WoW (fully quit, not /reload) so it picks up the new addon files.');
    return;
  }
  if (cmd) throw new Error(`Unknown option "${cmd}". Run with no options to start the bridge, or "setup" to reinstall the addon.`);

  console.log(`Claude Bridge ${VERSION}`);
  if (!fs.existsSync(setup.CONFIG_PATH)) await firstRun(setup);
  const bridge = require('./bridge');
  checkClaude(JSON.parse(fs.readFileSync(setup.CONFIG_PATH, 'utf8')));
  if (!bridge.main()) await fail('');
}

run(process.argv.slice(2)).catch((e) => fail(`Error: ${e.message}`));
