#!/usr/bin/env node
// Runs the addon's Lua tests: the real ClaudeBridge.lua inside fengari (a Lua VM
// in JS) with stubbed WoW APIs. The bridge itself needs no npm packages; these
// tests need two, installed once into test/lua/.tools (gitignored):
//
//   npm install --prefix test/lua/.tools fengari luaparse
//   node test/lua/run.js [tools dir]
const path = require('path');
const { execFileSync } = require('child_process');

const tools = path.resolve(process.argv[2] || path.join(__dirname, '.tools'));
execFileSync(process.execPath, [path.join(__dirname, 'make-linktest.js')], { stdio: 'inherit' });
for (const t of ['luaencode.js', 'ctxtest.js', 'ctxtest-modern.js', 'linktest.js', 'waypointtest.js']) {
  console.log(`--- ${t}`);
  execFileSync(process.execPath, [path.join(__dirname, t), tools], { stdio: 'inherit' });
}
console.log('All Lua tests passed.');
