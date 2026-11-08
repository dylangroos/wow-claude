#!/usr/bin/env node
// MCP server (stdio, no npm packages) that gives the bridge's Claude three tools,
// set_waypoint, set_waypoints and clear_waypoint. Each good call is appended as a
// JSON line to $CB_WAYPOINT_FILE ({stops:[{zone,x,y,label}, ...]} or {clear:true});
// the bridge acts on the last one after Claude answers. Claude Code starts this
// through --mcp-config (see askClaude in bridge.js).
const fs = require('fs');

const TOOL = {
  name: 'set_waypoint',
  description: 'Point the player to a spot in World of Warcraft: an arrow on screen turns toward it and '
    + 'the world map shows a line to it. Use the zone name as the game shows it and the zone map '
    + 'coordinates (0-100) from a source page such as Wowhead. Never guess coordinates. It replaces any route set earlier.',
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

const MAX_STOPS = 10;

const ROUTE_TOOL = {
  name: 'set_waypoints',
  description: 'Point the player through several spots in order: the arrow points at the first stop and '
    + 'moves on to the next when they arrive. Use it for a route (legs to one place) or several places to '
    + 'visit (start with the one nearest the player). Calling it again replaces the whole route, so use it '
    + 'to skip, add or reorder stops. Same zone names and coordinates as set_waypoint. Never guess coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      stops: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_STOPS,
        description: 'The stops in travel order',
        items: TOOL.inputSchema,
      },
    },
    required: ['stops'],
  },
};

const CLEAR_TOOL = {
  name: 'clear_waypoint',
  description: 'Remove the waypoint arrow and map line from the player\'s screen, for example when they '
    + 'have arrived, are done with it, or ask to get rid of it.',
  inputSchema: { type: 'object', properties: {} },
};

// Append one action line; a failed write comes back as a tool error, not a crash.
function record(file, action, okText) {
  try {
    fs.appendFileSync(file, JSON.stringify(action) + '\n');
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Waypoint not saved: ${e.message}` }] };
  }
  return { content: [{ type: 'text', text: okText }] };
}

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

// Returns an error message naming the bad stop, or null when the list is good.
function checkStops(stops) {
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAX_STOPS) {
    return `stops must be a list of 1-${MAX_STOPS} stops`;
  }
  for (let i = 0; i < stops.length; i++) {
    const err = checkWaypoint(stops[i]);
    if (err) return `stop ${i + 1}: ${err}`;
  }
  return null;
}

const cleanStop = (a) => ({ zone: a.zone.trim(), x: a.x, y: a.y, label: a.label.trim() });

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
      return { tools: [TOOL, ROUTE_TOOL, CLEAR_TOOL] };
    case 'tools/call': {
      if (p.name === CLEAR_TOOL.name) return record(file, { clear: true }, 'Waypoint cleared.');
      if (p.name === ROUTE_TOOL.name) {
        const stops = p.arguments && p.arguments.stops;
        const err = checkStops(stops);
        if (err) return { isError: true, content: [{ type: 'text', text: `Route not set: ${err}.` }] };
        const clean = stops.map(cleanStop);
        return record(file, { stops: clean }, `Route set: ${clean.length} ${clean.length === 1 ? 'stop' : 'stops'}, first ${clean[0].label} in ${clean[0].zone}.`);
      }
      if (p.name !== TOOL.name) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${p.name}.` }] };
      const err = checkWaypoint(p.arguments);
      if (err) return { isError: true, content: [{ type: 'text', text: `Waypoint not set: ${err}.` }] };
      const w = cleanStop(p.arguments);
      return record(file, { stops: [w] }, `Waypoint set: ${w.label} in ${w.zone} at ${w.x}, ${w.y}.`);
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

module.exports = { TOOL, checkWaypoint, checkStops, handle };
