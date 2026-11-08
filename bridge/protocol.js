// Pure helpers shared by the bridge, setup and tests. No file I/O here.

const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Pixel strip codec (must match encode() in ClaudeBridge.lua)
// ---------------------------------------------------------------------------

const BLOCK = 16;
const CAL = [0, 21, 42, 63];      // gray calibration blocks, level L = (L,L,L)
const MAGIC = [51, 12, 60, 3];    // (3,0,3) (0,3,0) (3,3,0) (0,0,3)
const LEVEL_RGB = [0, 85, 170, 255];

function bytesToSymbols(bytes) {
  const out = [];
  let acc = 0;
  let nbits = 0;
  for (const b of bytes) {
    acc = acc * 256 + b;
    nbits += 8;
    while (nbits >= 6) {
      nbits -= 6;
      const d = 2 ** nbits;
      out.push(Math.floor(acc / d));
      acc %= d;
    }
  }
  if (nbits > 0) out.push(acc * 2 ** (6 - nbits));
  return out;
}

function symbolsToBytes(syms, count) {
  const out = [];
  let acc = 0;
  let nbits = 0;
  for (const s of syms) {
    acc = acc * 64 + s;
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      const d = 2 ** nbits;
      out.push(Math.floor(acc / d));
      acc %= d;
      if (out.length === count) break;
    }
  }
  return out;
}

// JS twin of the Lua encoder; used by tests to render fake screenshots.
function encodeStrip(payload, width) {
  const data = Buffer.from(payload, 'utf8');
  let sum = 0;
  for (const b of data) sum = (sum + b) % 65536;
  const bytes = [data.length >> 8, data.length & 255, ...data, sum >> 8, sum & 255];
  return [...CAL, ...MAGIC, Math.floor(width / 64), width % 64, ...bytesToSymbols(bytes)];
}

// img: { width, height, channels, data } with rows top-to-bottom.
function sampleBlock(img, bx, by) {
  const x0 = bx * BLOCK + 4;
  const y0 = by * BLOCK + 4;
  const rgb = [0, 0, 0];
  for (let y = y0; y < y0 + 8; y++) {
    for (let x = x0; x < x0 + 8; x++) {
      const i = (y * img.width + x) * img.channels;
      rgb[0] += img.data[i];
      rgb[1] += img.data[i + 1];
      rgb[2] += img.data[i + 2];
    }
  }
  return rgb.map((v) => v / 64);
}

// Returns the payload string, or null if this image doesn't carry a strip.
function decodeStrip(img) {
  const maxBlocksX = Math.floor(img.width / BLOCK);
  if (maxBlocksX < 10 || img.height < BLOCK) return null;
  const cal = [0, 1, 2, 3].map((i) => sampleBlock(img, i, 0));
  // Calibration must be ordered dark -> light with clear gaps, or it's not ours.
  for (let c = 0; c < 3; c++) {
    for (let l = 1; l < 4; l++) if (cal[l][c] - cal[l - 1][c] < 30) return null;
  }
  const classify = (rgb) => {
    let s = 0;
    for (let c = 0; c < 3; c++) {
      let best = 0;
      for (let l = 1; l < 4; l++) {
        if (Math.abs(rgb[c] - cal[l][c]) < Math.abs(rgb[c] - cal[best][c])) best = l;
      }
      s = s * 4 + best;
    }
    return s;
  };
  const symAtIndex = (i, width) => classify(sampleBlock(img, i % width, Math.floor(i / width)));

  for (let i = 0; i < 4; i++) if (symAtIndex(4 + i, maxBlocksX) !== MAGIC[i]) return null;
  const width = symAtIndex(8, maxBlocksX) * 64 + symAtIndex(9, maxBlocksX);
  if (width < 10 || width > maxBlocksX) return null;

  const read = (from, n) => {
    const syms = [];
    for (let i = from; i < from + n; i++) {
      if (Math.floor(i / width) * BLOCK + BLOCK > img.height) return null;
      syms.push(symAtIndex(i, width));
    }
    return syms;
  };
  const head = read(10, 3); // 16 bits of length fit in 3 symbols
  if (!head) return null;
  const [hi, lo] = symbolsToBytes(head, 2);
  const len = hi * 256 + lo;
  if (len < 1 || len > 4000) return null;
  const total = len + 4;
  const syms = read(10, Math.ceil((total * 8) / 6));
  if (!syms) return null;
  const bytes = symbolsToBytes(syms, total);
  const data = bytes.slice(2, 2 + len);
  let sum = 0;
  for (const b of data) sum = (sum + b) % 65536;
  if (sum !== bytes[2 + len] * 256 + bytes[3 + len]) return null;
  return Buffer.from(data).toString('utf8');
}

// ---------------------------------------------------------------------------
// Image readers (no dependencies). JPEG is converted to PNG by the bridge.
// ---------------------------------------------------------------------------

function readTga(buf) {
  const idLen = buf[0];
  const type = buf[2];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const topOrigin = (buf[17] & 0x20) !== 0;
  if (![2, 10].includes(type) || ![24, 32].includes(bpp)) throw new Error(`unsupported TGA type ${type}/${bpp}`);
  const px = bpp / 8;
  const raw = Buffer.alloc(width * height * px);
  let p = 18 + idLen + (buf[1] ? buf.readUInt16LE(5) * Math.ceil(buf[7] / 8) : 0);
  if (type === 2) {
    buf.copy(raw, 0, p, p + raw.length);
  } else {
    let o = 0;
    while (o < raw.length) {
      const h = buf[p++];
      const n = (h & 0x7f) + 1;
      if (h & 0x80) {
        for (let k = 0; k < n; k++) { buf.copy(raw, o, p, p + px); o += px; }
        p += px;
      } else {
        buf.copy(raw, o, p, p + n * px);
        p += n * px;
        o += n * px;
      }
    }
  }
  // BGR(A) -> RGB, flip to top-to-bottom rows.
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sy = topOrigin ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (sy * width + x) * px;
      const d = (y * width + x) * 3;
      data[d] = raw[s + 2];
      data[d + 1] = raw[s + 1];
      data[d + 2] = raw[s];
    }
  }
  return { width, height, channels: 3, data };
}

function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8;
  let width, height, depth, colorType;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || ![2, 6].includes(colorType)) throw new Error(`unsupported PNG ${depth}/${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels: bpp, data: out };
}

// ---------------------------------------------------------------------------
// Prompt payload: "id|text", or "id|<GS>key\tvalue\n...<GS>text" when the
// addon attaches character info (GS = \x1d, untypeable in WoW's edit box).
// ---------------------------------------------------------------------------

const CTX_SEP = '\x1d';
const CTX_LABELS = {
  char: 'Character',
  xp: 'XP',
  zone: 'Location',
  money: 'Money',
  talents: 'Talents',
  prof: 'Professions',
  gear: 'Equipped',
  quests: 'Quest log',
};

function parsePayload(payload) {
  const m = /^([0-9a-f]{6})\|([\s\S]*)$/.exec(payload);
  if (!m) return null;
  let text = m[2];
  const ctx = [];
  const end = text.startsWith(CTX_SEP) ? text.indexOf(CTX_SEP, 1) : -1;
  if (end > 0) {
    for (const line of text.slice(1, end).split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) ctx.push([line.slice(0, tab), line.slice(tab + 1)]);
    }
    text = text.slice(end + 1);
  }
  return { id: m[1], text, ctx };
}

const ATT_LABELS = {
  att_item: 'Linked item',
  att_equipped: 'Currently equipped in that slot',
  att_quest: 'Linked quest',
};

function buildPrompt(text, ctx) {
  const state = (ctx || []).filter(([k]) => !k.startsWith('att_'));
  const atts = (ctx || []).filter(([k]) => k.startsWith('att_'));
  if (state.length === 0 && atts.length === 0) return text;
  const out = [];
  if (state.length) {
    out.push('[Game state, attached automatically by the addon. Only what changed since the last message is included.]');
    for (const [k, v] of state) out.push(`${CTX_LABELS[k] || k}: ${v}`);
    out.push('');
  }
  if (atts.length) {
    out.push('[Shift-clicked into the question by the player; tooltip lines are separated by " / "]');
    for (const [k, v] of atts) out.push(`${ATT_LABELS[k] || k}: ${v}`);
    out.push('');
  }
  out.push('[Question]', text);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Reply slots
// ---------------------------------------------------------------------------

// Make reply text safe to show in a WoW font string.
function cleanForWow(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1') // [title](url) -> title
    .replace(/\|/g, '||')            // "|" starts WoW color/link escape codes
    .replace(/\*\*(.+?)\*\*/g, '$1')  // markdown bold
    .replace(/^#{1,6}\s+/gm, '')      // markdown headings
    .replace(/`([^`]*)`/g, '$1')      // inline code
    .trim();
}

// Wrap text in a Lua long string whose closing bracket can't appear inside it.
function luaLongString(text) {
  // The first "]=..=]" in text + closer must be the closer itself. This also
  // catches text that ends in "]=" and would merge with the closing bracket.
  let eq = '=';
  while ((text + `]${eq}]`).indexOf(`]${eq}]`) !== text.length) eq += '=';
  // Lua drops a newline right after the opening bracket, so add one to keep
  // a leading newline in the text intact.
  return `[${eq}[\n${text}]${eq}]`;
}

// extra.waypoint = { zone, x, y, label } rides along as OnReply's third argument,
// so a reply left over from before a /reload (ignored by OnReply) sets nothing.
function slotLua(id, text, extra) {
  let tail = '';
  if (extra && extra.waypoint) {
    const w = extra.waypoint;
    const s = (t) => luaLongString(cleanForWow(t));
    tail = `, { waypoint = { zone = ${s(w.zone)}, x = ${Number(w.x)}, y = ${Number(w.y)}, label = ${s(w.label)} } }`;
  }
  return `ClaudeBridge_OnReply("${id}", ${luaLongString(cleanForWow(text))}${tail})\n`;
}

const EMPTY_SLOT_LUA = '-- empty reply slot\n';

function slotName(i) {
  return `ClaudeBridge_R${String(i).padStart(2, '0')}`;
}

function sigName(i) {
  return `${String(i).padStart(2, '0')}.wav`;
}

// A silent 16-bit mono PCM WAV, 1 second at 8 kHz, so it is still playing
// when the addon checks C_Sound.IsPlaying 50 ms later.
function silentWav() {
  const samples = 8000;
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);      // fmt chunk size
  b.writeUInt16LE(1, 20);       // PCM
  b.writeUInt16LE(1, 22);       // mono
  b.writeUInt32LE(8000, 24);    // sample rate
  b.writeUInt32LE(16000, 28);   // byte rate
  b.writeUInt16LE(2, 32);       // block align
  b.writeUInt16LE(16, 34);      // bits per sample
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

function slotToc(i, iface) {
  return [
    `## Interface: ${iface}`,
    `## Title: Claude Bridge reply ${String(i).padStart(2, '0')}`,
    '## Notes: Internal to Claude Bridge. Leave enabled.',
    '## LoadOnDemand: 1',
    '## Dependencies: ClaudeBridge',
    '## Group: ClaudeBridge',
    '',
    'r.lua',
    '',
  ].join('\n');
}

function configLua(cfg) {
  return [
    '-- Written by setup.js. Re-run setup to change.',
    'ClaudeBridge_Config = {',
    `  slots = ${cfg.slots},`,
    '}',
    '',
  ].join('\n');
}

module.exports = {
  BLOCK,
  LEVEL_RGB,
  bytesToSymbols,
  symbolsToBytes,
  encodeStrip,
  decodeStrip,
  CTX_SEP,
  parsePayload,
  buildPrompt,
  readTga,
  readPng,
  cleanForWow,
  luaLongString,
  slotLua,
  EMPTY_SLOT_LUA,
  slotName,
  sigName,
  silentWav,
  slotToc,
  configLua,
};
