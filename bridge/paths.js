// Where the bridge keeps its files. From the repo, that's the repo root. As
// ClaudeBridge.exe (a Node single executable), it's the folder holding the exe,
// which also holds the addon folder the release zip ships with it.
const path = require('path');

let isPackaged = false;
try { isPackaged = require('node:sea').isSea(); } catch { /* older Node: never packaged */ }

const ROOT = process.env.CB_ROOT ? path.resolve(process.env.CB_ROOT)
  : isPackaged ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..');

module.exports = { ROOT, isPackaged };
