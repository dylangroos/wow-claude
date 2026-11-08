
// ---- link tests ----
const L1 = (n) => Number(evalStr(n));
run('for _, h in ipairs(EVENTS) do h(nil, "PLAYER_LOGIN") end', 'login');
const hooks = evalStr('table.concat(ClaudeBridgeDB.linkHooks, ",")');
console.log('Hooks installed:', hooks);
assert.ok(hooks.includes('ChatEdit_InsertLink') && hooks.includes('ChatEdit_TryInsertQuestLinkForQuestID') && hooks.includes('SetSelectedQuest'), hooks);

// Shift-click goes into our box only while it is shown and focused.
const wand = '|cff1eff00|Hitem:5071:0|h[Lesser Magic Wand]|h|r';
run('SlashCmdList.CLAUDEBRIDGE(""); SHOWN = true; FOCUS = false', 'open');
run('ChatEdit_InsertLink(' + JSON.stringify(wand) + ')', 'ins0');
assert.strictEqual(L1('#INSERTED'), 0, 'unfocused: nothing inserted');
run('FOCUS = true; ChatEdit_InsertLink(' + JSON.stringify(wand) + ')', 'ins1');
assert.strictEqual(evalStr('INSERTED[1]'), wand);
// A quest shift-click fires two hooks in one click: inserted once.
run('MOD = true; ChatEdit_TryInsertQuestLinkForQuestID(46); C_QuestLog.SetSelectedQuest(46); MOD = false; SELECTED = 88', 'q');
assert.strictEqual(L1('#INSERTED'), 2);
assert.strictEqual(evalStr('INSERTED[2]'), '|cffffff00|Hquest:46:12|h[Quest 46]|h|r');

// Item question: the item's tooltip and the equipped wand's go along.
run('ClaudeBridge_Send(' + JSON.stringify(wand + ' is this an upgrade?') + ')', 'sendItem');
const mi = P.parsePayload(sentPayload());
console.log('\nItem prompt as Claude sees it:\n' + P.buildPrompt(mi.text, mi.ctx) + '\n');
assert.strictEqual(mi.text, '[Lesser Magic Wand] is this an upgrade?');
assert.deepStrictEqual(mi.ctx.filter(([k]) => k.startsWith('att_')), [
  ['att_item', 'Lesser Magic Wand / Binds when equipped / Ranged Wand / 11 - 21 Arcane Damage Speed 1.50 / Requires Level 10'],
  ['att_equipped', 'Greater Magic Wand / Ranged Wand / 13 - 25 Arcane Damage Speed 1.40'],
]);
replyTo(mi, 'Yes, take it.');

// Attachments are one-offs: the next plain question carries none.
run('ClaudeBridge_Send("ok thanks")', 'plain');
assert.ok(!sentPayload().includes(P.CTX_SEP), 'no context block after attachments');
replyTo(P.parsePayload(sentPayload()), 'np');

// Quest question: text, goal, objectives; selection restored; no stray insert.
const quest = '|cffffff00|Hquest:46:8|h[Bounty on Murlocs]|h|r';
run('MOD = true; ClaudeBridge_Send(' + JSON.stringify('where do I find these ' + quest) + '); MOD = false', 'sendQuest');
const mq = P.parsePayload(sentPayload());
console.log('Quest prompt:\n' + P.buildPrompt(mq.text, mq.ctx) + '\n');
assert.deepStrictEqual(mq.ctx, [['att_quest', '[Bounty on Murlocs] | Goal: Bring 8 Murloc Fins to Marshal Dughan. | Text: The murlocs have been raiding the coast. | Objectives: Murloc Fin: 3/8']]);
assert.strictEqual(L1('SELECTED'), 88, 'quest selection restored');
assert.strictEqual(L1('#INSERTED'), 2, 'our own selection change inserted nothing');
replyTo(mq, 'west coast');

// Old-style tooltip fallback when C_TooltipInfo is missing.
run('C_TooltipInfo = nil; ClaudeBridge_Send(' + JSON.stringify(wand + ' ?') + ')', 'scan');
const ms = P.parsePayload(sentPayload());
assert.strictEqual(ms.ctx[0][1], 'Lesser Magic Wand / Ranged Wand');
replyTo(ms, 'k');

// More than 3 links: only 3 looked at; long tooltips cut to the 1500-byte budget.
run('C_TooltipInfo = { GetHyperlink = function(link) local n = link:match("%[(.-)%]"); return { lines = { { leftText = n }, { leftText = string.rep("Long stat line ", 60) } } } end }', 'long');
const many = [1, 2, 3, 4, 5].map((i) => '|cff1eff00|Hitem:' + i + ':0|h[Item ' + i + ']|h|r').join(' ');
run('ClaudeBridge_Send(' + JSON.stringify(many + ' compare') + ')', 'many');
const mm = P.parsePayload(sentPayload());
const names = mm.ctx.filter(([k]) => k === 'att_item').map(([, v]) => v.split(' / ')[0]);
const attBytes = mm.ctx.filter(([k]) => k.startsWith('att_')).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 2, 0);
console.log('Many links: items attached', JSON.stringify(names), '| att bytes', attBytes, '| payload bytes', Buffer.byteLength(sentPayload()));
assert.deepStrictEqual(names, ['Item 1', 'Item 2']); assert.ok(!names.includes('Item 4'), 'max 3 links');
assert.ok(attBytes <= 1500);
assert.ok(!mm.text.includes('|H'), 'question text has no link codes');
replyTo(mm, 'k');

// A link whose tooltip can't be read at all: recorded, question still goes out.
run('C_TooltipInfo = { GetHyperlink = function() error("tooltip broke") end }; CreateFrame = function() error("no tooltip either") end', 'brk');
run('scanTip = nil', 'brk2');
run('ClaudeBridge_Send(' + JSON.stringify(wand + ' hmm') + ')', 'sendBroken');
const mb = P.parsePayload(sentPayload());
assert.strictEqual(mb.text, '[Lesser Magic Wand] hmm');
assert.deepStrictEqual(mb.ctx[0], ['att_item', 'Lesser Magic Wand / Ranged Wand'], 'modern tooltip threw: fell back to the scan tooltip'); assert.strictEqual(evalStr('ClaudeBridgeDB.debug.linkErrors[1]'), 'nil');
console.log('Link tests passed.');

// Hotkey: opens without focusing in the same frame, focuses on the next; second press closes.
run('SHOWN = false; ui_focus_calls = 0', 'hk0');
run('local n0 = #TIMERS; ClaudeBridge_Toggle(); HK_TIMER = TIMERS[#TIMERS]; HK_NEW = #TIMERS - n0', 'hk1');
assert.strictEqual(L1('HK_NEW'), 1, 'focus deferred to a timer');
assert.strictEqual(evalStr('BINDING_NAME_CLAUDEBRIDGE_TOGGLE'), 'Open/close the Claude window');
console.log('Hotkey tests passed.');

// ---- waypoint hooks in ClaudeBridge.lua ----
run('SlashCmdList.CLAUDEBRIDGE("cancel")', 'wp0'); // the broken-tooltip question above is still pending
// Scenario: Claude knows where the player is standing
run('C_Map = { GetBestMapForUnit = function() return 1429 end, GetPlayerMapPosition = function() return { x = 0.421, y = 0.659 } end }', 'wp1');
run('ClaudeBridge_Send("where is the inn?")', 'wp2');
const mp = P.parsePayload(sentPayload());
assert.deepStrictEqual(mp.ctx.find(([k]) => k === 'pos'), ['pos', '42.1, 65.9']);
assert.ok(P.buildPrompt(mp.text, mp.ctx).includes('Map position (x, y on the zone map, 0-100): 42.1, 65.9'));
// The reply's waypoint goes to Waypoint.lua, after the answer is shown. The slot text is the bridge's own.
run('WP_GOT = nil; ClaudeBridge_SetWaypoints = function(w) WP_GOT = w end', 'wp3');
run(P.slotLua(mp.id, 'Hogger is at 25.6, 78.4.', { waypoints: [{ zone: 'Elwynn Forest', x: 25.6, y: 78.4, label: 'Hogger' }] }), 'wpslot');
assert.strictEqual(L1('#WP_GOT'), 1);
assert.strictEqual(evalStr('WP_GOT[1].zone'), 'Elwynn Forest');
assert.strictEqual(L1('WP_GOT[1].x'), 25.6);
assert.strictEqual(L1('WP_GOT[1].y'), 78.4);
assert.strictEqual(evalStr('WP_GOT[1].label'), 'Hogger');
// A broken Waypoint.lua can't break replies.
run('ClaudeBridge_SetWaypoints = function() error("boom") end; ClaudeBridge_Send("again")', 'wp4');
run(P.slotLua(P.parsePayload(sentPayload()).id, 'ok', { waypoints: [{ zone: 'Elwynn Forest', x: 1, y: 1, label: 'x' }] }), 'wpslot2');
assert.ok(evalStr('LINES[#LINES]').includes("Couldn't set the waypoint"), evalStr('LINES[#LINES]'));
// /claude way ... reaches Waypoint.lua.
run('ClaudeBridge_WaypointCommand = function(a) WAYCMD = a end; SlashCmdList.CLAUDEBRIDGE("way clear")', 'wp5');
assert.strictEqual(evalStr('WAYCMD'), 'clear');
run('SlashCmdList.CLAUDEBRIDGE("way")', 'wp6');
assert.strictEqual(evalStr('WAYCMD'), '');
// A question that merely starts with "way" is still a question.
run('WAYCMD = "untouched"; SlashCmdList.CLAUDEBRIDGE("way to Booty Bay?")', 'wp7');
assert.strictEqual(evalStr('WAYCMD'), 'untouched', 'not taken for the waypoint command');
assert.strictEqual(P.parsePayload(sentPayload()).text, 'way to Booty Bay?');
run('SlashCmdList.CLAUDEBRIDGE("cancel")', 'wp8');
// Without Waypoint.lua loaded (a new .toc file needs a full restart), say so instead of staying silent.
const restart = "Waypoints aren't loaded yet. Restart the game";
run('SAVED_WC, SAVED_SW = ClaudeBridge_WaypointCommand, ClaudeBridge_SetWaypoints; ClaudeBridge_WaypointCommand = nil; ClaudeBridge_SetWaypoints = nil; SlashCmdList.CLAUDEBRIDGE("way")', 'wp9');
assert.ok(evalStr('LINES[#LINES]').includes(restart), evalStr('LINES[#LINES]'));
run('SlashCmdList.CLAUDEBRIDGE("way clear")', 'wp10');
assert.ok(evalStr('LINES[#LINES]').includes(restart), evalStr('LINES[#LINES]'));
run('ClaudeBridge_Send("where?")', 'wp11');
run(P.slotLua(P.parsePayload(sentPayload()).id, 'Over there.', { waypoints: [{ zone: 'Elwynn Forest', x: 1, y: 1, label: 'x' }] }), 'wpslot3');
assert.ok(evalStr('LINES[#LINES]').includes(restart), evalStr('LINES[#LINES]'));
// A clear reply without Waypoint.lua loaded says so too.
run('SAVED_CW = ClaudeBridge_ClearWaypoint; ClaudeBridge_ClearWaypoint = nil; ClaudeBridge_Send("made it")', 'wp13');
run(P.slotLua(P.parsePayload(sentPayload()).id, 'Nice.', { clear_waypoint: true }), 'wpslot4');
assert.ok(evalStr('LINES[#LINES]').includes(restart), evalStr('LINES[#LINES]'));
run('ClaudeBridge_WaypointCommand, ClaudeBridge_SetWaypoints, ClaudeBridge_ClearWaypoint = SAVED_WC, SAVED_SW, SAVED_CW', 'wp12');
// Scenario: Claude clears the waypoint, so the arrow goes away and the chat says so.
run('SAVED_CW = ClaudeBridge_ClearWaypoint; CLEARED = nil; ClaudeBridge_ClearWaypoint = function() CLEARED = true end; ClaudeBridge_Send("made it, clear the arrow")', 'wp14');
run(P.slotLua(P.parsePayload(sentPayload()).id, 'Done.', { clear_waypoint: true }), 'wpslot5');
assert.strictEqual(evalStr('tostring(CLEARED)'), 'true');
assert.strictEqual(evalStr('LINES[#LINES]'), 'Waypoint cleared.');
run('ClaudeBridge_ClearWaypoint = SAVED_CW', 'wp15');
// The "way" field goes along with questions, and "none" reaches Claude once the chain is gone.
run('WAY = "stop 1 of 2. Now: Cave, Elwynn Forest 40.0, 20.1. Then: Hogger, Elwynn Forest 25.6, 78.4"; ClaudeBridge_WaypointContext = function() return WAY end; ClaudeBridge_Send("what is next?")', 'way1');
const mw = P.parsePayload(sentPayload());
assert.deepStrictEqual(mw.ctx.find(([k]) => k === 'way'), ['way', 'stop 1 of 2. Now: Cave, Elwynn Forest 40.0, 20.1. Then: Hogger, Elwynn Forest 25.6, 78.4']);
assert.ok(P.buildPrompt(mw.text, mw.ctx).includes("Waypoints (the arrow's route): stop 1 of 2. Now: Cave"), P.buildPrompt(mw.text, mw.ctx));
replyTo(mw, 'Head to the cave.');
// Scenario: Character info reports when no chain is set
run('WAY = "none"; ClaudeBridge_Send("cleared it, now what?")', 'way2');
const mn = P.parsePayload(sentPayload());
assert.deepStrictEqual(mn.ctx.find(([k]) => k === 'way'), ['way', 'none']);
replyTo(mn, 'Up to you.');
run('ClaudeBridge_WaypointContext = nil', 'way3');
console.log('Waypoint hook tests passed.');

// ---- late replies: WoW tabbed out with Sound in Background off, so the signal can't play ----
const lastLine = () => evalStr('LINES[#LINES]');
const allLines = () => evalStr('table.concat(LINES, "\\n")');
run(`SAVED_GT, SAVED_PSF, SAVED_CS, SAVED_CV = GetTime, PlaySoundFile, C_Sound, GetCVar
  NOW = 1000; GetTime = function() return NOW end
  PlaySoundFile = function() return true, 7 end
  StopSound = function() end
  C_Sound = { IsPlaying = function() return false end }
  BGSOUND = "0"
  GetCVar = function(k) if k == "Sound_EnableSoundWhenGameIsInBG" then return BGSOUND end return "jpeg" end
  ClaudeBridgeDB.bgTipShown = nil`, 'late0');
// Scenario: the first question with background sound off gets a one-time tip.
run('ClaudeBridge_Send("is arcane good?")', 'late1');
assert.ok(allLines().includes('/console Sound_EnableSoundWhenGameIsInBG 1'), allLines());
const late = P.parsePayload(sentPayload()).id;
run('for _, h in ipairs(EVENTS) do h(nil, "SCREENSHOT_SUCCEEDED") end', 'late2');
// Scenario: no answer within the timeout, the addon says it keeps listening.
run('NOW = NOW + 241; ClaudeBridge_Poll()', 'late3');
assert.ok(lastLine().includes('keep listening'), lastLine());
assert.ok(lastLine().includes('Sound in Background'), lastLine());
// Probing goes on after the timeout (the arrow and chat are free for a new question meanwhile).
run('PROBES = 0; PlaySoundFile = function() PROBES = PROBES + 1; return true, 7 end; ClaudeBridge_Poll(); TIMERS[#TIMERS]()', 'late4');
assert.strictEqual(L1('PROBES'), 1, 'still probing after the timeout');
// Scenario: the answer arrives after the timeout and still shows.
run(P.slotLua(late, 'Stay Frost.', undefined), 'late5');
assert.ok(allLines().includes('Stay Frost.'), allLines());
// The tip was one-time.
run('ClaudeBridge_Send("again?")', 'late6');
const tips = allLines().split('\n').filter((l) => l.startsWith('Tip: answers only arrive')).length;
assert.strictEqual(tips, 1, 'tip shown once');
// Scenario: a late answer to a timed-out question shows even after a new question was asked.
const q2 = P.parsePayload(sentPayload()).id;
run('for _, h in ipairs(EVENTS) do h(nil, "SCREENSHOT_SUCCEEDED") end; NOW = NOW + 241; ClaudeBridge_Poll()', 'late7');
run('ClaudeBridge_Send("third?")', 'late8');
run(P.slotLua(q2, 'Late but here.', undefined), 'late9');
assert.ok(allLines().includes('Late but here.'), allLines());
// /claude cancel stops listening for both.
run('SlashCmdList.CLAUDEBRIDGE("cancel")', 'late10');
const q3 = P.parsePayload(sentPayload()).id;
run(P.slotLua(q3, 'Should not show.', undefined), 'late11');
assert.ok(!allLines().includes('Should not show.'), 'cancelled answer ignored');
// With background sound on, there is no tip and no background hint in the timeout message.
run('BGSOUND = "1"; ClaudeBridgeDB.bgTipShown = nil; ClaudeBridge_Send("fourth?"); for _, h in ipairs(EVENTS) do h(nil, "SCREENSHOT_SUCCEEDED") end; NOW = NOW + 241; ClaudeBridge_Poll()', 'late12');
assert.ok(lastLine().includes('keep listening') && !lastLine().includes('Sound in Background'), lastLine());
run('SlashCmdList.CLAUDEBRIDGE("cancel"); GetTime, PlaySoundFile, C_Sound, GetCVar = SAVED_GT, SAVED_PSF, SAVED_CS, SAVED_CV', 'late13');
console.log('Late reply tests passed.');
