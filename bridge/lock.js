// One bridge per WoW folder. Two bridges both answer every question and
// overwrite each other's reply slots, which hangs the game, so a second one
// must refuse to start. The lock file holds the running bridge's process id;
// a lock whose process is gone (window closed, crash) is simply taken over.
const fs = require('fs');
const { execFileSync } = require('child_process');

const BRIDGE_IMAGES = ['node.exe', 'claudebridge.exe', 'node'];

function isBridgeAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (process.platform !== 'win32') return true;
  // Windows reuses process ids, so check the id still belongs to a bridge-shaped process.
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const image = (/^"([^"]+)"/.exec(out.trim()) || [])[1];
    return !!image && BRIDGE_IMAGES.includes(image.toLowerCase());
  } catch {
    return true; // can't tell: assume it's running rather than risk two bridges
  }
}

// Returns null when this process now holds the lock, or the holder's { pid, startedAt }.
function acquireLock(file, { pid = process.pid } = {}) {
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none, or torn */ }
  if (holder && holder.pid !== pid && isBridgeAlive(holder.pid)) return holder;
  fs.writeFileSync(file, JSON.stringify({ pid, startedAt: new Date().toISOString() }) + '\n');
  return null;
}

function releaseLock(file, { pid = process.pid } = {}) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true });
  } catch { /* already gone */ }
}

module.exports = { acquireLock, releaseLock };
