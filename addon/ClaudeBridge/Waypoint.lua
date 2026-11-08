-- Claude Bridge waypoints. Claude's set_waypoints tool arrives with a reply
-- (ClaudeBridge_OnReply -> ClaudeBridge_SetWaypoints): a chain of stops, saved in
-- ClaudeBridgeDB.waypoints = { stops, current }. An arrow on screen turns
-- toward the current stop and counts down the yards; arriving moves on to the next.

local ARRIVE_YARDS = 10
local TICK = 0.05                       -- seconds between arrow updates
local atan2 = math.atan2 or math.atan   -- Lua 5.1 in WoW, 5.3 in the offline tests

local arrow                             -- built on first use
local arrivedUntil = 0                  -- keep "Arrived" on screen until this GetTime()

local function say(text, r, g, b)
  if ClaudeBridge_Print then ClaudeBridge_Print(text, r, g, b) end
end

-- The waypoint saved by the previous version (one spot) becomes a chain of one.
local function migrate()
  local old = ClaudeBridgeDB.waypoint
  if not old then return end
  ClaudeBridgeDB.waypoint = nil
  if old.mapID then ClaudeBridgeDB.waypoints = { stops = { old }, current = 1 } end
end

-- The current stop's name for the arrow: "Cave (2/3)", or just "Hogger" for a chain of one.
local function stopName(c)
  local s = c.stops[c.current]
  if #c.stops == 1 then return s.label end
  return string.format("%s (%d/%d)", s.label, c.current, #c.stops)
end

local function at(s)
  return string.format("%s, %s %.1f, %.1f", s.label, s.zone, s.x, s.y)
end

-- The zone's uiMapID, found by name among all maps under the top world map.
-- Same-named maps (a zone and its micro map): the bigger one, i.e. lower mapType.
local function findMap(zone)
  local want = zone:gsub("%s*>.*$", ""):lower() -- "Westfall > Sentinel Hill" -> "westfall"
  local top = C_Map.GetBestMapForUnit("player")
    or (C_Map.GetFallbackWorldMapID and C_Map.GetFallbackWorldMapID())
  local info = top and C_Map.GetMapInfo(top)
  while info and info.parentMapID and info.parentMapID ~= 0 do
    top = info.parentMapID
    info = C_Map.GetMapInfo(top)
  end
  if not top then return nil end
  local best
  for _, m in ipairs(C_Map.GetMapChildrenInfo(top, nil, true) or {}) do
    if m.name and m.name:lower() == want and (not best or m.mapType < best.mapType) then best = m end
  end
  return best and best.mapID
end

-- Where the waypoint is from the player:
--   "ok", yards, angle (radians, counterclockwise, 0 = straight ahead)
--   "elsewhere" (another continent) or "hidden" (no position, e.g. dungeons).
local function relative(wp)
  local map = C_Map.GetBestMapForUnit("player")
  local pp = map and C_Map.GetPlayerMapPosition(map, "player")
  local facing = GetPlayerFacing()
  if not (pp and facing) then return "hidden" end
  local pc, pw = C_Map.GetWorldPosFromMapPos(map, pp)
  local tc, tw = C_Map.GetWorldPosFromMapPos(wp.mapID, CreateVector2D(wp.x / 100, wp.y / 100))
  if not (pw and tw) then return "hidden" end
  if pc ~= tc then return "elsewhere" end
  -- World positions: x grows to the north, y to the west, in yards.
  local north, west = tw.x - pw.x, tw.y - pw.y
  return "ok", math.sqrt(north * north + west * west), atan2(west, north) - facing
end

local function buildArrow()
  local f = CreateFrame("Frame", "ClaudeBridgeArrow", UIParent)
  f:SetSize(140, 80)
  local p = ClaudeBridgeDB.arrowPos
  if p then f:SetPoint(p[1], UIParent, p[2], p[3], p[4]) else f:SetPoint("TOP", UIParent, "TOP", 0, -120) end
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self) self:StartMoving() end)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, relPoint, x, y = self:GetPoint()
    ClaudeBridgeDB.arrowPos = { point, relPoint, x, y }
  end)
  f:SetScript("OnMouseUp", function(_, button)
    if button == "RightButton" then ClaudeBridge_ClearWaypoint() end
  end)
  f.arrow = f:CreateTexture(nil, "ARTWORK")
  f.arrow:SetSize(48, 48)
  f.arrow:SetPoint("TOP")
  f.arrow:SetTexture("Interface\\Minimap\\MinimapArrow")
  f.text = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  f.text:SetPoint("TOP", f.arrow, "BOTTOM", 0, -2)
  local acc = 0
  f:SetScript("OnUpdate", function(self, elapsed)
    acc = acc + elapsed
    if acc < TICK then return end
    acc = 0
    local ok, err = pcall(ClaudeBridge_WaypointUpdate)
    if not ok then -- don't throw every frame; hide and leave a note for debugging
      self:Hide()
      ClaudeBridgeDB.waypointError = tostring(err)
      say("Waypoint arrow stopped: " .. tostring(err) .. ". Ask again or /reload to retry.", 1, 0.3, 0.3)
    end
  end)
  arrow = f
end

function ClaudeBridge_WaypointUpdate()
  local c = ClaudeBridgeDB.waypoints
  if not c then
    if arrow and GetTime() >= arrivedUntil then arrow:Hide() end
    return
  end
  if not arrow then buildArrow() end
  arrow:Show()
  local wp = c.stops[c.current]
  local name = stopName(c)
  local state, yards, angle = relative(wp)
  if state == "ok" and yards <= ARRIVE_YARDS then
    if c.current < #c.stops then
      c.current = c.current + 1
      say(string.format("Arrived: %s. Next: %s (%d of %d).", wp.label, c.stops[c.current].label, c.current, #c.stops))
      return ClaudeBridge_WaypointUpdate() -- point at the next stop right away
    end
    ClaudeBridgeDB.waypoints = nil
    arrivedUntil = GetTime() + 3
    arrow.arrow:Hide()
    arrow.text:SetText("Arrived: " .. wp.label)
  elseif state == "ok" then
    arrow.arrow:SetRotation(angle)
    arrow.arrow:Show()
    arrow.text:SetText(string.format("%s\n%d yd", name, math.floor(yards + 0.5)))
  elseif state == "elsewhere" then
    arrow.arrow:Hide()
    arrow.text:SetText(name .. ": in " .. wp.zone)
  else
    arrow.arrow:Hide()
    arrow.text:SetText(name)
  end
end

function ClaudeBridge_ClearWaypoint()
  ClaudeBridgeDB.waypoints = nil
  arrivedUntil = 0
  if arrow then arrow:Hide() end
end

-- Prints the chain: one line for a single waypoint, else a header and one line per stop.
local function describe(c)
  if #c.stops == 1 then
    say("Waypoint: " .. at(c.stops[1]) .. ". /claude way clear removes it.")
    return
  end
  say(string.format("Route, stop %d of %d. /claude way clear removes it.", c.current, #c.stops))
  for i, s in ipairs(c.stops) do
    local mark = (i < c.current and " (done)") or (i == c.current and " <- now") or ""
    say(string.format("%d. %s%s", i, at(s), mark))
  end
end

-- Called with the chain that came with Claude's answer: { {zone, x, y, label}, ... }.
-- Every zone is looked up first; one unknown zone rejects the whole chain.
function ClaudeBridge_SetWaypoints(list)
  local stops = {}
  for i, w in ipairs(list) do
    local mapID = findMap(w.zone)
    if not mapID then
      say("Couldn't find the zone " .. w.zone .. " on the map, so no arrow.", 1, 0.3, 0.3)
      return
    end
    local info = C_Map.GetMapInfo(mapID)
    local zone = (info and info.name) or w.zone:gsub("%s*>.*$", "") -- the game's own spelling
    stops[i] = { mapID = mapID, zone = zone, x = w.x, y = w.y, label = w.label }
  end
  if #stops == 0 then return end
  ClaudeBridgeDB.waypoints = { stops = stops, current = 1 }
  ClaudeBridgeDB.waypointError = nil
  arrivedUntil = 0
  describe(ClaudeBridgeDB.waypoints)
  ClaudeBridge_WaypointUpdate()
end

-- A single waypoint: a chain of one.
function ClaudeBridge_SetWaypoint(w)
  ClaudeBridge_SetWaypoints({ w })
end

-- The "way" character-info field: where the chain stands, so Claude can skip or change stops.
function ClaudeBridge_WaypointContext()
  local c = ClaudeBridgeDB.waypoints
  if not c then return "none" end
  local s = string.format("stop %d of %d. Now: %s", c.current, #c.stops, at(c.stops[c.current]))
  local rest = {}
  local last = math.min(#c.stops, c.current + 3) -- at most 3 stops after this one
  for i = c.current + 1, last do rest[#rest + 1] = at(c.stops[i]) end
  if #c.stops > last then rest[#rest + 1] = string.format("and %d more", #c.stops - last) end
  if #rest > 0 then s = s .. ". Then: " .. table.concat(rest, "; ") end
  return s
end

-- /claude way [clear]
function ClaudeBridge_WaypointCommand(arg)
  if arg == "clear" then
    ClaudeBridge_ClearWaypoint()
    say("Waypoint cleared.")
  elseif ClaudeBridgeDB.waypoints then
    describe(ClaudeBridgeDB.waypoints)
  else
    say("No waypoint. Ask Claude where something is to get one.")
  end
end

local ev = CreateFrame("Frame")
ev:RegisterEvent("PLAYER_LOGIN")
ev:SetScript("OnEvent", function()
  migrate()
  if not ClaudeBridgeDB.waypoints then return end
  local ok, err = pcall(ClaudeBridge_WaypointUpdate)
  if not ok then -- same as the arrow's own OnUpdate: no raw error at every login
    if arrow then arrow:Hide() end
    ClaudeBridgeDB.waypointError = tostring(err)
    say("Waypoint arrow stopped: " .. tostring(err) .. ". Ask again or /reload to retry.", 1, 0.3, 0.3)
  end
end)

----------------------------------------------------------------------------
-- World map: a pin on the waypoint and a line from the player to it
----------------------------------------------------------------------------

local pin, line, mapHooked

function ClaudeBridge_WaypointMapUpdate()
  local canvas = WorldMapFrame and WorldMapFrame.ScrollContainer and WorldMapFrame.ScrollContainer.Child
  if not canvas then return end
  if not pin then
    -- The map tiles are child frames of the canvas and draw above its own regions, so draw on a frame above them.
    local ov = CreateFrame("Frame", "ClaudeBridgeMapOverlay", canvas)
    ov:SetAllPoints(canvas)
    ov:SetFrameLevel(canvas:GetFrameLevel() + 500)
    pin = ov:CreateTexture(nil, "OVERLAY")
    pin:SetSize(24, 24)
    pin:SetTexture("Interface\\TargetingFrame\\UI-RaidTargetingIcon_1")
    line = ov:CreateLine(nil, "OVERLAY")
    line:SetThickness(4)
    line:SetColorTexture(1, 0.82, 0, 0.8)
  end
  pin:Hide()
  line:Hide()
  local c = ClaudeBridgeDB.waypoints
  local wp = c and c.stops[c.current]
  if not (wp and WorldMapFrame:IsShown()) then return end
  local shown = WorldMapFrame:GetMapID()
  local tc, tw = C_Map.GetWorldPosFromMapPos(wp.mapID, CreateVector2D(wp.x / 100, wp.y / 100))
  if not tw then return end
  local _, t = C_Map.GetMapPosFromWorldPos(tc, tw, shown)
  if not t or t.x < 0 or t.x > 1 or t.y < 0 or t.y > 1 then return end -- not on this map
  local w, h = canvas:GetWidth(), canvas:GetHeight()
  pin:ClearAllPoints()
  pin:SetPoint("CENTER", canvas, "TOPLEFT", t.x * w, -t.y * h)
  pin:Show()
  local p = C_Map.GetPlayerMapPosition(shown, "player")
  if p then
    line:SetStartPoint("TOPLEFT", canvas, p.x * w, -p.y * h)
    line:SetEndPoint("TOPLEFT", canvas, t.x * w, -t.y * h)
    line:Show()
  end
end

local function hookMap()
  if mapHooked or not WorldMapFrame then return end
  mapHooked = true
  local acc = 0
  WorldMapFrame:HookScript("OnUpdate", function(_, elapsed)
    acc = acc + elapsed
    if acc < 0.1 then return end
    acc = 0
    local ok, err = pcall(ClaudeBridge_WaypointMapUpdate)
    if not ok then ClaudeBridgeDB.waypointError = tostring(err) end
  end)
end

local mapEv = CreateFrame("Frame")
mapEv:RegisterEvent("PLAYER_LOGIN")
mapEv:RegisterEvent("ADDON_LOADED") -- in case the world map addon loads later
mapEv:SetScript("OnEvent", hookMap)
