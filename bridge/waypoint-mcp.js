#!/usr/bin/env node
// MCP server (stdio, no npm packages) that gives the bridge's Claude one tool,
// set_waypoint. Each good call is appended as a JSON line to $CB_WAYPOINT_FILE;
// the bridge reads the last one after Claude answers. Claude Code starts this
// through --mcp-config (see askClaude in bridge.js).
const fs = require('fs');

const TOOL = {
  name: 'set_waypoint',
  description: 'Point the player to a spot in World of Warcraft: an arrow on screen turns toward it and '
    + 'the world map shows a line to it. Use the zone name as the game shows it and the zone map '
    + 'coordinates (0-100) from a source page such as Wowhead. Never guess coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      zone: { type: 'string', description: 'Zone name as the game shows it, for example "Elwynn Forest"' },
      x: { type: 'number', minimum: 0, maximum: 100, description: 'Map x coordinate, 0-100' },
      y: { type: 'number', minimum: 0, maximum: 100, description: 'Map y coordinate, 0-100' },
      label: { type: 'string', description: 'Short name for the spot, for example "Hogger" (40 characters max)' },
    },
    required: ['zone', 'x', 'y', 'label'],
  },
};

// Returns an error message, or null when the waypoint is good.
function checkWaypoint(w) {
  if (!w || typeof w !== 'object') return 'arguments must be an object';
  const text = (k, max) => {
    const v = typeof w[k] === 'string' ? w[k].trim() : '';
    return v.length >= 1 && v.length <= max ? null : `${k} must be text, 1-${max} characters`;
  };
  const num = (k) => (typeof w[k] === 'number' && Number.isFinite(w[k]) && w[k] >= 0 && w[k] <= 100
    ? null : `${k} must be a number from 0 to 100`);
  return text('zone', 60) || num('x') || num('y') || text('label', 40);
}

// One JSON-RPC request -> its result, or undefined for an unknown method.
function handle(msg, file) {
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: p.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'wow', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      if (p.name !== TOOL.name) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${p.name}.` }] };
      const err = checkWaypoint(p.arguments);
      if (err) return { isError: true, content: [{ type: 'text', text: `Waypoint not set: ${err}.` }] };
      const a = p.arguments;
      const w = { zone: a.zone.trim(), x: a.x, y: a.y, label: a.label.trim() };
      fs.appendFileSync(file, JSON.stringify(w) + '\n');
      return { content: [{ type: 'text', text: `Waypoint set: ${w.label} in ${w.zone} at ${w.x}, ${w.y}.` }] };
    }
    default:
      return undefined;
  }
}

function serve(input, output, file) {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined || msg.id === null) continue; // a notification: no reply
      const result = handle(msg, file);
      output.write(JSON.stringify(result === undefined
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
        : { jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  });
}

if (require.main === module) serve(process.stdin, process.stdout, process.env.CB_WAYPOINT_FILE);

module.exports = { TOOL, checkWaypoint, handle };
