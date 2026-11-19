// Tests for the one-bridge-per-WoW-folder lock.
//   node bridge/lock.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { acquireLock, releaseLock } = require('./lock');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-lock-'));
const file = path.join(dir, 'bridge.lock');
try {
  // Scenario: A second bridge refuses to start (the lock side)
  assert.strictEqual(acquireLock(file), null, 'first bridge gets the lock');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  const held = acquireLock(file, { pid: process.pid + 1 });
  assert.ok(held && held.pid === process.pid, 'a second bridge sees who holds it');

  // A lock left by a bridge that died (closed window) doesn't block a new one.
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: '2026-01-01T00:00:00Z' }));
  assert.strictEqual(acquireLock(file), null, 'a dead bridge\'s lock is taken over');

  // A torn or empty lock file doesn't block either.
  fs.writeFileSync(file, '');
  assert.strictEqual(acquireLock(file), null);

  // Release removes only our own lock.
  releaseLock(file);
  assert.ok(!fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1 }));
  releaseLock(file);
  assert.ok(fs.existsSync(file), 'another bridge\'s lock is left alone');
  console.log('Lock tests passed.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
