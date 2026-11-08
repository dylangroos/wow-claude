-- Claude Bridge: ask Claude Code from inside WoW: Forever.
--
-- Out (game -> PC): the prompt is drawn as a strip of colored 16x16 pixel
--   blocks in the top-left corner, and the addon takes a screenshot. The
--   bridge on your PC watches the Screenshots folder, decodes the strip and
--   deletes that screenshot. (WoW's chat log is buffered for hours in
--   Forever, so it can't carry prompts.)
-- In (PC -> game): addons can't read files live, but a load-on-demand addon
--   reads its files from disk when it is loaded. The bridge writes each reply
--   into the next "reply slot" addon (ClaudeBridge_R01..Rnn), then fills in a
--   matching signal .wav. We play the .wav and check 50 ms later whether it is
--   really playing: an empty file never plays, a real one does. Then we load
--   the slot. Slots reset on every /reload.

local CFG = ClaudeBridge_Config or {}
local SLOTS = CFG.slots or 50

local LoadAddOnFn = (C_AddOns and C_AddOns.LoadAddOn) or LoadAddOn

local BLOCK = 16          -- physical pixels per block (matches JPEG's 16px chroma grid)
local MAX_BYTES = 1200    -- prompt size limit
local TIMEOUT = 240       -- seconds to wait for a reply before giving up
local CAL = { 0, 21, 42, 63 }        -- gray calibration blocks: level L = (L,L,L)
local MAGIC = { 51, 12, 60, 3 }      -- (3,0,3) (0,3,0) (3,3,0) (0,0,3)

local cursor = 1          -- next reply slot to probe
local pending             -- { id = "a1b2c3", sentAt = GetTime(), shot = nil|"ok" }
local SHOT_WAIT = 4       -- seconds for WoW to confirm the screenshot
local gaveUp              -- the last pending we dropped for lack of a screenshot
local late                -- a pending that timed out: its answer still shows if it arrives
local probing = false     -- a sound check is in flight
local ui                  -- built lazily

ClaudeBridgeDB = ClaudeBridgeDB or {}

----------------------------------------------------------------------------
-- UI
----------------------------------------------------------------------------

local function addLine(text, r, g, b)
  if ui then ui.log:AddMessage(text, r or 1, g or 1, b or 1) end
end

local WAYPOINTS_MISSING = "Waypoints aren't loaded yet. Restart the game (a /reload doesn't load new addon files)."

local function setStatus(text)
  if ui then ui.status:SetText(text or "") end
end

-- Answers arrive through a sound that WoW only plays in the background with this on.
local BG_SOUND_CMD = "/console Sound_EnableSoundWhenGameIsInBG 1"
local function bgSoundOff()
  return GetCVar("Sound_EnableSoundWhenGameIsInBG") == "0"
end

local function savePosition()
  local point, _, relPoint, x, y = ui:GetPoint()
  ClaudeBridgeDB.pos = { point, relPoint, x, y }
end

local function buildUI()
  local f = CreateFrame("Frame", "ClaudeBridgeFrame", UIParent)
  f:SetSize(440, 300)
  local p = ClaudeBridgeDB.pos
  if p then f:SetPoint(p[1], UIParent, p[2], p[3], p[4]) else f:SetPoint("CENTER") end
  f:SetFrameStrata("HIGH")
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self) self:StopMovingOrSizing(); savePosition() end)
  table.insert(UISpecialFrames, "ClaudeBridgeFrame") -- Esc closes it

  local bg = f:CreateTexture(nil, "BACKGROUND")
  bg:SetAllPoints()
  bg:SetColorTexture(0.05, 0.05, 0.08, 0.88)

  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("TOPLEFT", 10, -8)
  title:SetText("Claude")

  local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  status:SetPoint("LEFT", title, "RIGHT", 10, 0)
  status:SetTextColor(0.6, 0.6, 0.6)
  f.status = status

  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", 2, 2)

  local log = CreateFrame("ScrollingMessageFrame", nil, f)
  log:SetPoint("TOPLEFT", 10, -28)
  log:SetPoint("BOTTOMRIGHT", -10, 38)
  log:SetFontObject(ChatFontNormal)
  log:SetJustifyH("LEFT")
  log:SetFading(false)
  log:SetMaxLines(500)
  if log.SetIndentedWordWrap then log:SetIndentedWordWrap(true) end
  -- Item/quest links in the log are clickable, like in chat.
  if log.SetHyperlinksEnabled then log:SetHyperlinksEnabled(true) end
  log:SetScript("OnHyperlinkClick", function(self, link, text, button)
    if SetItemRef then SetItemRef(link, text, button, self) end
  end)
  log:EnableMouseWheel(true)
  log:SetScript("OnMouseWheel", function(self, delta)
    if delta > 0 then self:ScrollUp() else self:ScrollDown() end
  end)
  f.log = log

  local input = CreateFrame("EditBox", nil, f, "InputBoxTemplate")
  input:SetPoint("BOTTOMLEFT", 16, 10)
  input:SetPoint("BOTTOMRIGHT", -10, 10)
  input:SetHeight(22)
  input:SetAutoFocus(false)
  input:SetMaxLetters(MAX_BYTES)
  input:SetScript("OnEscapePressed", input.ClearFocus)
  input:SetScript("OnEnterPressed", function(self)
    local text = self:GetText()
    self:SetText("")
    ClaudeBridge_Send(text)
  end)
  f.input = input

  ui = f
  addLine("Type a question below and press Enter. /claude new starts a fresh conversation.", 0.6, 0.6, 0.6)
end

local function showUI(focus)
  if not ui then buildUI() end
  ui:Show()
  if focus then ui.input:SetFocus() end
end

-- Key binding (Bindings.xml; set it under Key Bindings > AddOns).
BINDING_HEADER_CLAUDEBRIDGE = "Claude Bridge"
BINDING_NAME_CLAUDEBRIDGE_TOGGLE = "Open/close the Claude window"
function ClaudeBridge_Toggle()
  if ui and ui:IsShown() then ui:Hide(); return end
  showUI(false)
  -- Focus on the next frame, so the key that opened the window isn't typed into it.
  C_Timer.After(0, function() if ui:IsShown() then ui.input:SetFocus() end end)
end

-- Lets Waypoint.lua print into the Claude window.
function ClaudeBridge_Print(text, r, g, b)
  showUI(false)
  addLine(text, r or 0.6, g or 0.6, b or 0.6)
end

----------------------------------------------------------------------------
-- Outgoing: prompt -> pixel strip -> Screenshot() -> Screenshots folder
----------------------------------------------------------------------------

-- Bytes -> 6-bit symbols (each symbol is one block: 2 bits per color channel).
local function toSymbols(bytes, out)
  local acc, nbits = 0, 0
  for i = 1, #bytes do
    acc = acc * 256 + bytes[i]
    nbits = nbits + 8
    while nbits >= 6 do
      nbits = nbits - 6
      local d = 2 ^ nbits
      out[#out + 1] = math.floor(acc / d)
      acc = acc % d
    end
  end
  if nbits > 0 then out[#out + 1] = acc * 2 ^ (6 - nbits) end
end

-- Frame layout: 4 calibration, 4 magic, 2 width symbols, then the bytes
-- [len_hi, len_lo, data..., sum_hi, sum_lo] packed 6 bits per block.
local function encode(payload, width)
  local syms = {}
  for _, s in ipairs(CAL) do syms[#syms + 1] = s end
  for _, s in ipairs(MAGIC) do syms[#syms + 1] = s end
  syms[#syms + 1] = math.floor(width / 64)
  syms[#syms + 1] = width % 64
  local bytes, sum = {}, 0
  bytes[1] = math.floor(#payload / 256)
  bytes[2] = #payload % 256
  for i = 1, #payload do
    local b = payload:byte(i)
    bytes[#bytes + 1] = b
    sum = (sum + b) % 65536
  end
  bytes[#bytes + 1] = math.floor(sum / 256)
  bytes[#bytes + 1] = sum % 256
  toSymbols(bytes, syms)
  return syms
end

-- BEGIN context ------------------------------------------------------------
-- Character info sent along with each question, as ordered { key, value }
-- pairs. Each reader runs in pcall: if Forever lacks an API, that line is
-- just skipped. Only fields that changed since Claude last saw them are sent.

local CTX_MAX = 1500      -- bytes of context per question, at most
local CTX_SEP = "\29"     -- wraps the context block; can't be typed in an edit box

local SLOT_NAMES = {
  [1] = "Head", [2] = "Neck", [3] = "Shoulders", [5] = "Chest", [6] = "Waist",
  [7] = "Legs", [8] = "Feet", [9] = "Wrists", [10] = "Hands", [11] = "Ring",
  [12] = "Ring", [13] = "Trinket", [14] = "Trinket", [15] = "Back",
  [16] = "Main hand", [17] = "Off hand", [18] = "Ranged",
}

local CTX_READERS = {
  { "char", function()
      return string.format("%s, level %d %s %s", UnitName("player"), UnitLevel("player"),
        UnitRace("player"), UnitClass("player"))
    end },
  { "xp", function()
      local maxLevel = GetMaxPlayerLevel and GetMaxPlayerLevel() or 60
      local max = UnitXPMax("player")
      if UnitLevel("player") >= maxLevel or not max or max == 0 then return nil end
      local s = string.format("%d%% of the way to level %d", math.floor(UnitXP("player") / max * 100),
        UnitLevel("player") + 1)
      local rested = GetXPExhaustion and GetXPExhaustion()
      if rested and rested > 0 then s = s .. ", rested" end
      return s
    end },
  { "zone", function()
      local zone, sub = GetRealZoneText(), GetSubZoneText()
      if sub and sub ~= "" and sub ~= zone then return zone .. " > " .. sub end
      return zone
    end },
  { "pos", function()
      if not (C_Map and C_Map.GetBestMapForUnit) then return nil end
      local map = C_Map.GetBestMapForUnit("player")
      local p = map and C_Map.GetPlayerMapPosition(map, "player")
      if not p then return nil end -- dungeons hide the position
      return string.format("%.1f, %.1f", p.x * 100, p.y * 100)
    end },
  { "money", function()
      local c = GetMoney()
      return string.format("%dg %ds %dc", math.floor(c / 10000), math.floor(c / 100) % 100, c % 100)
    end },
  { "talents",
    function() -- modern talent trees (C_Traits), which Forever uses
      local function spellName(id)
        if C_Spell and C_Spell.GetSpellName then return C_Spell.GetSpellName(id) end
        return GetSpellInfo and (GetSpellInfo(id))
      end
      local spec
      local S = C_SpecializationInfo
      if S and S.GetSpecialization and S.GetSpecializationInfo then
        local idx = S.GetSpecialization()
        if idx and idx > 0 then spec = select(2, S.GetSpecializationInfo(idx)) end
      end
      local configID = C_ClassTalents.GetActiveConfigID()
      local picks = {}
      local config = configID and C_Traits.GetConfigInfo(configID)
      for _, treeID in ipairs(config and config.treeIDs or {}) do
        for _, nodeID in ipairs(C_Traits.GetTreeNodes(treeID) or {}) do
          local node = C_Traits.GetNodeInfo(configID, nodeID)
          local entryID = node and node.activeEntry and node.activeEntry.entryID
          if entryID and (node.ranksPurchased or 0) > 0 then
            local entry = C_Traits.GetEntryInfo(configID, entryID)
            local def = entry and entry.definitionID and C_Traits.GetDefinitionInfo(entry.definitionID)
            local name = def and ((def.overrideName ~= "" and def.overrideName)
              or (def.spellID and spellName(def.spellID)))
            if name then
              picks[#picks + 1] = string.format("%s %d/%d", name, node.ranksPurchased, node.maxRanks or node.ranksPurchased)
            end
          end
        end
      end
      local s = #picks > 0 and table.concat(picks, ", ") or "no points spent"
      return spec and (spec .. ": " .. s) or s
    end,
    function() -- classic three trees
      local trees, picks, total = {}, {}, 0
      for t = 1, GetNumTalentTabs() do
        -- Classic returns the tree name first; later clients put an id first.
        local a, b = GetTalentTabInfo(t)
        local tree = type(a) == "string" and a or b
        local spent = 0
        for i = 1, GetNumTalents(t) do
          local name, _, _, _, rank, maxRank = GetTalentInfo(t, i)
          if rank and rank > 0 then
            spent = spent + rank
            picks[#picks + 1] = string.format("%s %d/%d", name, rank, maxRank)
          end
        end
        trees[#trees + 1] = string.format("%s %d", tree, spent)
        total = total + spent
      end
      if total == 0 then return "no points spent" end
      return table.concat(trees, ", ") .. " (" .. table.concat(picks, ", ") .. ")"
    end },
  { "prof",
    function() -- newer clients
      local out = {}
      local list = { GetProfessions() }
      for i = 1, select("#", GetProfessions()) do
        if list[i] then
          local name, _, rank, maxRank = GetProfessionInfo(list[i])
          out[#out + 1] = string.format("%s %d/%d", name, rank, maxRank)
        end
      end
      return #out > 0 and table.concat(out, ", ") or "none"
    end,
    function() -- classic
      local out, section = {}, ""
      for i = 1, GetNumSkillLines() do
        local name, isHeader, _, rank, _, _, maxRank = GetSkillLineInfo(i)
        if isHeader then
          section = name or ""
        elseif section:find("Profession") or section:find("Secondary") then
          out[#out + 1] = string.format("%s %d/%d", name, rank, maxRank)
        end
      end
      return #out > 0 and table.concat(out, ", ") or "none"
    end },
  { "gear", function()
      local itemInfo = GetItemInfo or (C_Item and C_Item.GetItemInfo)
      local out = {}
      for slot = 1, 18 do
        local link = SLOT_NAMES[slot] and GetInventoryItemLink("player", slot)
        if link then
          local name = link:match("%[(.-)%]") or "?"
          local ilvl
          if itemInfo then ilvl = select(4, itemInfo(link)) end
          out[#out + 1] = SLOT_NAMES[slot] .. ": " .. name .. ((ilvl and ilvl > 0) and (" (" .. ilvl .. ")") or "")
        end
      end
      return #out > 0 and table.concat(out, "; ") or "nothing equipped"
    end },
  { "quests",
    function() -- newer clients
      local out = {}
      for i = 1, C_QuestLog.GetNumQuestLogEntries() do
        local q = C_QuestLog.GetInfo(i)
        if q and q.title and not q.isHeader and not q.isHidden then
          local done = C_QuestLog.IsComplete and C_QuestLog.IsComplete(q.questID)
          out[#out + 1] = string.format("%s (%d%s)", q.title, q.level or 0, done and ", ready to turn in" or "")
        end
      end
      return #out > 0 and table.concat(out, "; ") or "empty"
    end,
    function() -- classic
      local out = {}
      for i = 1, GetNumQuestLogEntries() do
        local title, level, _, isHeader, _, isComplete = GetQuestLogTitle(i)
        if title and not isHeader then
          local tag = (isComplete == 1 or isComplete == true) and ", ready to turn in"
            or (isComplete == -1 and ", failed" or "")
          out[#out + 1] = string.format("%s (%d%s)", title, level or 0, tag)
        end
      end
      return #out > 0 and table.concat(out, "; ") or "empty"
    end },
  { "way", function() -- the arrow's route, from Waypoint.lua; nothing when that file isn't loaded
      return ClaudeBridge_WaypointContext and ClaudeBridge_WaypointContext()
    end },
}

-- Which info functions this client has, saved for debugging (/reload writes it).
local PROBE = {
  "GetNumTalentTabs", "GetTalentTabInfo", "GetNumTalents", "GetTalentInfo", "GetSpecialization",
  "GetActiveTalentGroup", "GetNumSkillLines", "GetSkillLineInfo", "GetProfessions",
  "GetProfessionInfo", "GetNumQuestLogEntries", "GetQuestLogTitle", "GetItemInfo",
  "C_QuestLog", "C_Item", "C_ClassTalents", "C_Traits", "C_SpecializationInfo", "C_TradeSkillUI",
}

local ctxErrors = {}      -- key -> error text from the last gather, for /claude context

local function gatherContext()
  local ctx, used = {}, 0
  ctxErrors = {}
  for _, r in ipairs(CTX_READERS) do
    -- Try each implementation in order; the first one that runs wins.
    local v, errs = nil, {}
    for i = 2, #r do
      local ok, res = pcall(r[i])
      if ok then v = res; errs = nil; break end
      errs[#errs + 1] = tostring(res)
    end
    if errs then ctxErrors[r[1]] = table.concat(errs, " / ") end
    if v and v ~= "" then
      v = tostring(v):gsub("[\n\t\29]", " ")
      local room = CTX_MAX - used - #r[1] - 2
      if #v > room and room >= 40 then
        -- Cut to fit, without leaving half a UTF-8 character at the end.
        v = v:sub(1, room - 3):gsub("[\192-\255][\128-\191]*$", "") .. "..."
      end
      if #v <= room then
        ctx[#ctx + 1] = { r[1], v }
        used = used + #r[1] + #v + 2
      end
    end
  end
  local probe = {}
  for _, name in ipairs(PROBE) do probe[name] = type(_G[name]) end
  ClaudeBridgeDB.debug = { probe = probe, errors = ctxErrors }
  return ctx
end

-- "key<TAB>value" lines for the fields that differ from what Claude last saw.
local function contextDiff(ctx, last)
  local lines = {}
  for _, kv in ipairs(ctx) do
    if last[kv[1]] ~= kv[2] then lines[#lines + 1] = kv[1] .. "\t" .. kv[2] end
  end
  return table.concat(lines, "\n")
end
-- END context --------------------------------------------------------------

-- BEGIN links --------------------------------------------------------------
-- Shift-clicked item and quest links in a question get their details attached
-- (one-off, not diffed): the item's tooltip plus what you wear in that slot,
-- or the quest's text and objectives with your progress.

local ATT_MAX = 1500      -- bytes of attachments per question, at most
local MAX_LINKS = 3
local attErrors = {}
local selfSelecting = false -- questAttachment changes the quest selection itself

-- Equip location -> inventory slots to compare against.
local EQUIP_SLOTS = {
  INVTYPE_HEAD = { 1 }, INVTYPE_NECK = { 2 }, INVTYPE_SHOULDER = { 3 }, INVTYPE_CHEST = { 5 },
  INVTYPE_ROBE = { 5 }, INVTYPE_WAIST = { 6 }, INVTYPE_LEGS = { 7 }, INVTYPE_FEET = { 8 },
  INVTYPE_WRIST = { 9 }, INVTYPE_HAND = { 10 }, INVTYPE_FINGER = { 11, 12 },
  INVTYPE_TRINKET = { 13, 14 }, INVTYPE_CLOAK = { 15 }, INVTYPE_WEAPON = { 16, 17 },
  INVTYPE_2HWEAPON = { 16 }, INVTYPE_WEAPONMAINHAND = { 16 }, INVTYPE_WEAPONOFFHAND = { 17 },
  INVTYPE_SHIELD = { 17 }, INVTYPE_HOLDABLE = { 17 }, INVTYPE_RANGED = { 18 },
  INVTYPE_RANGEDRIGHT = { 18 }, INVTYPE_THROWN = { 18 }, INVTYPE_RELIC = { 18 },
}

-- Visible text of a link-bearing string: "[Name]" instead of escape codes.
local function plainText(s)
  return (s:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""):gsub("|H.-|h(.-)|h", "%1"))
end

local scanTip
local function tooltipLines(link)
  local out = {}
  if C_TooltipInfo and C_TooltipInfo.GetHyperlink then
    local ok, data = pcall(C_TooltipInfo.GetHyperlink, link)
    if not ok then data = nil end
    if data and TooltipUtil and TooltipUtil.SurfaceArgs then pcall(TooltipUtil.SurfaceArgs, data) end
    for _, line in ipairs(data and data.lines or {}) do
      if TooltipUtil and TooltipUtil.SurfaceArgs and line.leftText == nil then pcall(TooltipUtil.SurfaceArgs, line) end
      local l, r = line.leftText, line.rightText
      if l and l ~= "" then out[#out + 1] = (r and r ~= "") and (l .. " " .. r) or l end
    end
  end
  if #out == 0 then -- older way: render into a hidden tooltip and read its lines
    if not scanTip then
      scanTip = CreateFrame("GameTooltip", "ClaudeBridgeScanTip", nil, "GameTooltipTemplate")
    end
    scanTip:SetOwner(WorldFrame, "ANCHOR_NONE")
    scanTip:ClearLines()
    scanTip:SetHyperlink(link)
    for i = 1, scanTip:NumLines() do
      local l = _G["ClaudeBridgeScanTipTextLeft" .. i]
      local r = _G["ClaudeBridgeScanTipTextRight" .. i]
      local lt, rt = l and l:GetText(), r and r:IsShown() and r:GetText()
      if lt and lt ~= "" then out[#out + 1] = (rt and rt ~= "") and (lt .. " " .. rt) or lt end
    end
    scanTip:Hide()
  end
  return table.concat(out, " / ")
end

local function itemAttachments(link, out)
  out[#out + 1] = { "att_item", tooltipLines(link) }
  local instant = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
  local equipLoc = instant and select(4, instant(link))
  for _, slot in ipairs(EQUIP_SLOTS[equipLoc] or {}) do
    local worn = GetInventoryItemLink("player", slot)
    if worn and worn ~= link then out[#out + 1] = { "att_equipped", tooltipLines(worn) } end
  end
end

local function questAttachment(link, out)
  local questID = tonumber(link:match("quest:(%d+)"))
  local parts = { plainText(link) }
  local Q = C_QuestLog
  local index = Q and Q.GetLogIndexForQuestID and Q.GetLogIndexForQuestID(questID)
  if index then
    if GetQuestLogQuestText then
      local prev = Q.GetSelectedQuest and Q.GetSelectedQuest()
      selfSelecting = true
      if Q.SetSelectedQuest then Q.SetSelectedQuest(questID) end
      local ok, desc, objText = pcall(GetQuestLogQuestText, index)
      if prev and Q.SetSelectedQuest then Q.SetSelectedQuest(prev) end
      selfSelecting = false
      if not ok then desc, objText = nil, nil end
      if objText and objText ~= "" then parts[#parts + 1] = "Goal: " .. objText end
      if desc and desc ~= "" then parts[#parts + 1] = "Text: " .. desc end
    end
    local objs = {}
    for _, o in ipairs(Q.GetQuestObjectives and Q.GetQuestObjectives(questID) or {}) do
      if o.text and o.text ~= "" then objs[#objs + 1] = o.text .. (o.finished and " (done)" or "") end
    end
    if #objs > 0 then parts[#parts + 1] = "Objectives: " .. table.concat(objs, "; ") end
    if Q.IsComplete and Q.IsComplete(questID) then parts[#parts + 1] = "Ready to turn in." end
  end
  if #parts == 1 then parts[#parts + 1] = tooltipLines(link) end -- not in the log: use its tooltip
  out[#out + 1] = { "att_quest", table.concat(parts, " | ") }
end

-- { key, value } attachments for the links in a question, cut to ATT_MAX.
local function linkAttachments(text)
  local found, out = 0, {}
  attErrors = {}
  for link in text:gmatch("|H[^|]+|h.-|h") do
    if found >= MAX_LINKS then break end
    found = found + 1
    local kind = link:match("^|H(%a+):")
    local fn = (kind == "item" and itemAttachments) or (kind == "quest" and questAttachment)
    if fn then
      local ok, err = pcall(fn, link, out)
      if not ok then attErrors[#attErrors + 1] = kind .. ": " .. tostring(err) end
    end
  end
  -- Linked things first, then what's worn (once each), so comparisons never
  -- crowd out the items actually asked about.
  local ordered, seen = {}, {}
  for pass = 1, 2 do
    for _, kv in ipairs(out) do
      if (kv[1] == "att_equipped") == (pass == 2) and not seen[kv[1] .. kv[2]] then
        seen[kv[1] .. kv[2]] = true
        ordered[#ordered + 1] = kv
      end
    end
  end
  local used, kept = 0, {}
  for _, kv in ipairs(ordered) do
    local v = kv[2]:gsub("[\n\t\29]", " "):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
    local room = ATT_MAX - used - #kv[1] - 2
    if #v > room and room >= 60 then v = v:sub(1, room - 3):gsub("[\192-\255][\128-\191]*$", "") .. "..." end
    if v ~= "" and #v <= room then
      kept[#kept + 1] = { kv[1], v }
      used = used + #kv[1] + #v + 2
    end
  end
  if ClaudeBridgeDB.debug then ClaudeBridgeDB.debug.linkErrors = attErrors end
  return kept
end

-- Shift-click inserts links into our box while it has focus, like chat does.
local lastInsert, lastInsertAt
local function insertLink(link)
  if not (ui and ui:IsShown() and ui.input:HasFocus() and link) then return end
  if link == lastInsert and GetTime() == lastInsertAt then return end -- two hooks, one click
  lastInsert, lastInsertAt = link, GetTime()
  ui.input:Insert(link)
end

local function questLinkFor(questID)
  if not questID then return nil end
  if GetQuestLink then return GetQuestLink(questID) end
  local info = C_QuestLog and C_QuestLog.GetLogIndexForQuestID and C_QuestLog.GetInfo(C_QuestLog.GetLogIndexForQuestID(questID))
  if info then return string.format("|cffffff00|Hquest:%d:%d|h[%s]|h|r", questID, info.level or 0, info.title) end
end

local function installLinkHooks()
  local hooked = {}
  local function hook(tbl, name, fn)
    local owner = tbl or _G
    if type(owner[name]) ~= "function" then return end
    -- Never let our code throw into Blizzard's UI.
    local safe = function(...) pcall(fn, ...) end
    if tbl then hooksecurefunc(tbl, name, safe) else hooksecurefunc(name, safe) end
    hooked[#hooked + 1] = name
  end
  hook(nil, "ChatEdit_InsertLink", insertLink)
  hook(ChatFrameUtil, "InsertLink", insertLink)
  -- Quest logs only insert links while a chat box is open. These are called by
  -- name on a shift-click, so hooking them catches quests for our box too.
  local function questClicked(questID)
    if selfSelecting or not (IsModifiedClick and IsModifiedClick("CHATLINK")) then return end
    insertLink(questLinkFor(questID))
  end
  hook(nil, "ChatEdit_TryInsertQuestLinkForQuestID", questClicked)
  hook(C_QuestLog, "SetSelectedQuest", questClicked)
  hook(nil, "SelectQuestLogEntry", function(idx)
    local info = C_QuestLog and C_QuestLog.GetInfo and C_QuestLog.GetInfo(idx)
    questClicked(info and info.questID or (GetQuestLogTitle and select(8, GetQuestLogTitle(idx))))
  end)
  ClaudeBridgeDB.linkHooks = hooked
end
-- END links ----------------------------------------------------------------

local lastCtx = {}        -- what this conversation's Claude has already been told

local strip, tiles, savedFormat

local function hideStrip()
  if strip then strip:Hide() end
  if savedFormat then SetCVar("screenshotFormat", savedFormat); savedFormat = nil end
end

local function drawStrip(syms)
  local pw, ph = GetPhysicalScreenSize()
  if not strip then
    strip = CreateFrame("Frame", "ClaudeBridgeStrip") -- no parent: still shows with the UI hidden (Alt+Z)
    strip:SetFrameStrata("TOOLTIP")
    strip:SetFrameLevel(10000)
    tiles = {}
  end
  -- Scale so 1 unit = 1 physical pixel: the screen is (UIParent height x its scale) units at scale 1.
  strip:SetScale((UIParent:GetHeight() * UIParent:GetEffectiveScale()) / ph)
  strip:ClearAllPoints()
  strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
  local width = math.floor(pw / BLOCK)
  local rows = math.ceil(#syms / width)
  strip:SetSize(width * BLOCK, rows * BLOCK)

  for i, s in ipairs(syms) do
    local t = tiles[i]
    if not t then
      t = strip:CreateTexture(nil, "OVERLAY")
      t:SetSize(BLOCK, BLOCK)
      if t.SetSnapToPixelGrid then t:SetSnapToPixelGrid(false) end
      if t.SetTexelSnappingBias then t:SetTexelSnappingBias(0) end
      tiles[i] = t
    end
    local x, y = (i - 1) % width, math.floor((i - 1) / width)
    t:ClearAllPoints()
    t:SetPoint("TOPLEFT", strip, "TOPLEFT", x * BLOCK, -y * BLOCK)
    t:SetColorTexture(math.floor(s / 16) / 3, (math.floor(s / 4) % 4) / 3, (s % 4) / 3, 1)
    t:Show()
  end
  for i = #syms + 1, #tiles do tiles[i]:Hide() end
  strip:Show()
  return width
end

local function startPolling()
  if ui and not ui.ticker then
    ui.ticker = C_Timer.NewTicker(0.25, ClaudeBridge_Poll)
  end
end

local function stopPolling()
  if ui and ui.ticker then ui.ticker:Cancel(); ui.ticker = nil end
end

function ClaudeBridge_Send(text)
  text = (text or ""):gsub("^%s+", ""):gsub("%s+$", "")
  if text == "" then return end
  if pending then
    addLine("Still waiting on the last answer... (/claude cancel to stop waiting)", 1, 0.8, 0.3)
    return
  end
  if #text > MAX_BYTES then
    addLine("That's too long, keep it under about " .. MAX_BYTES .. " characters.", 1, 0.3, 0.3)
    return
  end

  local id = string.format("%06x", math.random(0, 0xFFFFFF))
  local ctx, body = nil, plainText(text)
  if text == "!new" then
    lastCtx = {} -- the new conversation hasn't seen anything yet
  elseif text:sub(1, 1) ~= "!" then
    local lines = {}
    if ClaudeBridgeDB.context ~= false then
      ctx = gatherContext()
      local diff = contextDiff(ctx, lastCtx)
      if diff ~= "" then lines[#lines + 1] = diff end
    end
    for _, kv in ipairs(linkAttachments(text)) do lines[#lines + 1] = kv[1] .. "\t" .. kv[2] end
    if #lines > 0 then body = CTX_SEP .. table.concat(lines, "\n") .. CTX_SEP .. body end
  end
  local pw = GetPhysicalScreenSize()
  local syms = encode(id .. "|" .. body, math.floor(pw / BLOCK))
  drawStrip(syms)
  savedFormat = GetCVar("screenshotFormat")
  SetCVar("screenshotFormat", "tga") -- lossless; the bridge also copes with jpeg/png
  Screenshot()                        -- captured at the end of this frame, strip included

  if text:sub(1, 1) ~= "!" then addLine("> " .. text, 0.55, 0.8, 1) end
  if bgSoundOff() and not ClaudeBridgeDB.bgTipShown then
    ClaudeBridgeDB.bgTipShown = true
    addLine("Tip: answers only arrive while WoW is in front. To get them while you're tabbed out, type "
      .. BG_SOUND_CMD .. " (Sound in Background).", 0.6, 0.6, 0.6)
  end
  pending = { id = id, sentAt = GetTime(), ctx = ctx }
  setStatus("sending...")
  startPolling()

  -- If WoW never confirms the screenshot, the question didn't leave the game:
  -- say so now instead of waiting minutes for an answer that can't come.
  C_Timer.After(SHOT_WAIT, function()
    hideStrip()
    if pending and pending.id == id and not pending.shot then
      gaveUp = pending -- a late screenshot confirmation revives it
      pending = nil
      setStatus("")
      addLine("WoW didn't take the screenshot, so that question didn't go out. Press Enter to try again.", 1, 0.3, 0.3)
      ClaudeBridgeDB.lastFail = { at = time(), id = id, why = "no screenshot event" }
    end
  end)
end

----------------------------------------------------------------------------
-- Incoming: signal .wav really plays -> load the reply slot addon
----------------------------------------------------------------------------

function ClaudeBridge_Poll()
  if not pending and not late then stopPolling(); setStatus(""); return end
  if probing then return end
  if pending and GetTime() - pending.sentAt > TIMEOUT then
    local msg = "No answer after " .. TIMEOUT .. "s. I'll keep listening and show it here if it comes."
      .. " Is bridge.js running on your PC, and is game sound on?"
    if bgSoundOff() then
      msg = msg .. " Answers can't arrive while WoW is tabbed out unless Sound in Background is on: " .. BG_SOUND_CMD
    end
    addLine(msg, 1, 0.3, 0.3)
    ClaudeBridgeDB.lastFail = { at = time(), id = pending.id, why = "timeout", shot = pending.shot }
    late, pending = pending, nil
    setStatus("")
    return
  end
  if cursor > SLOTS then
    addLine("Out of reply slots for this session. Type /reload to reset them.", 1, 0.8, 0.3)
    pending, late = nil, nil
    return
  end
  local sig = string.format("Interface\\AddOns\\ClaudeBridge\\sig\\%02d.wav", cursor)
  local _, handle = PlaySoundFile(sig, "Master")
  if not handle then return end
  -- An empty file still reports willPlay=true, but it never actually plays.
  probing = true
  C_Timer.After(0.05, function()
    probing = false
    local playing = C_Sound.IsPlaying(handle)
    StopSound(handle)
    if not playing then return end
    local slot = string.format("ClaudeBridge_R%02d", cursor)
    cursor = cursor + 1
    local ok, reason = LoadAddOnFn(slot)
    if not ok then addLine("Couldn't load " .. slot .. ": " .. tostring(reason), 1, 0.3, 0.3) end
  end)
end

-- Called by the reply slot file the bridge wrote.
function ClaudeBridge_OnReply(id, text, extra)
  local req
  if pending and id == pending.id then
    req, pending = pending, nil
    setStatus("")
  elseif late and id == late.id then
    req, late = late, nil -- a new question may be waiting, so leave its status alone
  else
    return -- left over from before a /reload, or cancelled
  end
  -- Claude has now seen this context, unless the bridge reported a failure.
  if req.ctx and not text:find("^error:") then
    for _, kv in ipairs(req.ctx) do lastCtx[kv[1]] = kv[2] end
  end
  showUI(false)
  for line in (text .. "\n"):gmatch("(.-)\n") do addLine(line) end
  addLine(" ")
  if extra and extra.waypoints then
    if ClaudeBridge_SetWaypoints then
      local ok, err = pcall(ClaudeBridge_SetWaypoints, extra.waypoints)
      if not ok then addLine("Couldn't set the waypoint: " .. tostring(err), 1, 0.3, 0.3) end
    else
      addLine(WAYPOINTS_MISSING, 1, 0.3, 0.3)
    end
  elseif extra and extra.clear_waypoint then
    if ClaudeBridge_ClearWaypoint then
      local ok, err = pcall(ClaudeBridge_ClearWaypoint)
      if ok then addLine("Waypoint cleared.", 0.6, 0.6, 0.6)
      else addLine("Couldn't clear the waypoint: " .. tostring(err), 1, 0.3, 0.3) end
    else
      addLine(WAYPOINTS_MISSING, 1, 0.3, 0.3)
    end
  end
end

----------------------------------------------------------------------------
-- Slash command and events
----------------------------------------------------------------------------

SLASH_CLAUDEBRIDGE1 = "/claude"
SlashCmdList.CLAUDEBRIDGE = function(msg)
  msg = (msg or ""):gsub("^%s+", "")
  if msg == "" then
    if ui and ui:IsShown() then ui:Hide() else showUI(true) end
  elseif msg == "context off" then
    showUI(false)
    ClaudeBridgeDB.context = false
    addLine("Character info is off: Claude only gets what you type.", 0.6, 0.6, 0.6)
  elseif msg == "context on" then
    showUI(false)
    ClaudeBridgeDB.context = nil
    addLine("Character info is on.", 0.6, 0.6, 0.6)
  elseif msg == "context" then
    showUI(false)
    if ClaudeBridgeDB.context == false then
      addLine("Character info is off. /claude context on to turn it on.", 0.6, 0.6, 0.6)
    else
      addLine("Claude gets this with your questions (/claude context off to stop):", 0.6, 0.6, 0.6)
      for _, kv in ipairs(gatherContext()) do addLine(kv[1] .. ": " .. kv[2], 0.75, 0.75, 0.75) end
      for key, err in pairs(ctxErrors) do addLine(key .. ": couldn't read (" .. err .. ")", 1, 0.3, 0.3) end
    end
  elseif msg == "cancel" then
    showUI(false)
    if pending or late then
      pending, late = nil, nil
      setStatus("")
      addLine("Stopped waiting. A late answer to that question will be ignored.", 0.6, 0.6, 0.6)
    else
      addLine("Nothing to cancel.", 0.6, 0.6, 0.6)
    end
  elseif msg == "new" then
    showUI(false)
    ClaudeBridge_Send("!new")
  elseif msg == "way" or msg == "way clear" then
    if ClaudeBridge_WaypointCommand then
      ClaudeBridge_WaypointCommand(msg == "way" and "" or "clear")
    else
      addLine(WAYPOINTS_MISSING, 1, 0.3, 0.3)
    end
  elseif msg == "selftest" then
    showUI(false)
    addLine("Self-test: sending a screenshot to the bridge (Claude isn't asked)...", 0.6, 0.6, 0.6)
    ClaudeBridge_Send("!selftest")
  else
    showUI(false)
    ClaudeBridge_Send(msg)
  end
end

local ev = CreateFrame("Frame")
ev:RegisterEvent("SCREENSHOT_SUCCEEDED")
ev:RegisterEvent("SCREENSHOT_FAILED")
ev:RegisterEvent("PLAYER_LOGOUT")
ev:RegisterEvent("PLAYER_LOGIN")
ev:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGIN" then
    local ok, err = pcall(installLinkHooks)
    if not ok then ClaudeBridgeDB.linkHooks = { "failed: " .. tostring(err) } end
  elseif event == "SCREENSHOT_SUCCEEDED" then
    hideStrip()
    if not pending and gaveUp and GetTime() - gaveUp.sentAt < 60 then
      pending, gaveUp = gaveUp, nil
      addLine("The screenshot went through after all, waiting for the answer.", 0.6, 0.6, 0.6)
      startPolling()
    end
    if pending and not pending.shot then
      pending.shot = "ok"
      setStatus("thinking...")
    end
  elseif event == "SCREENSHOT_FAILED" then
    hideStrip()
    if pending then
      addLine("Screenshot failed, so the question didn't go out. Try again.", 1, 0.3, 0.3)
      pending = nil
    end
  elseif event == "PLAYER_LOGOUT" then
    -- Writing SavedVariables on logout/reload is how the bridge knows to
    -- reset the reply slots.
    ClaudeBridgeDB.lastSave = time()
  end
end)
