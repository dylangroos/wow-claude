// Builds linktest.js from ctxtest-modern.js (shared stubs + helpers) plus link tests.
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const lines = fs.readFileSync(path.join(dir, 'ctxtest-modern.js'), 'utf8').split('\n');
let s = lines.slice(0, 140).join('\n') + '\n';

s = s.replace('elseif k == "IsShown" then return function() return false end',
  `elseif k == "IsShown" then return function() return SHOWN or false end
    elseif k == "HasFocus" then return function() return FOCUS end
    elseif k == "AddMessage" then return function(_, text) LINES[#LINES + 1] = text end
    elseif k == "Insert" then return function(_, v) INSERTED[#INSERTED + 1] = v end
    elseif k == "SetScript" then return function(_, n, fn) if n == "OnEvent" then EVENTS[#EVENTS + 1] = fn end end
    elseif k == "NumLines" and t._name == "ClaudeBridgeScanTip" then return function() return 2 end`);

const extra = fs.readFileSync(path.join(dir, 'linkstubs.lua'), 'utf8');
s = s.replace(/\n`;\n/, '\n' + extra.replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`;\n');
s += fs.readFileSync(path.join(dir, 'linkcases.js'), 'utf8');
fs.writeFileSync(path.join(dir, 'linktest.js'), s);
console.log('wrote linktest.js');
