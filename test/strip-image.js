// Fake WoW screenshots carrying a prompt strip, drawn the way the addon draws it.
// Shared by bridge/test.js and scripts/exe-smoke.js.
const fs = require('fs');
const zlib = require('zlib');
const P = require('../bridge/protocol');

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

module.exports = { renderScreen, writeTga, writePng };
