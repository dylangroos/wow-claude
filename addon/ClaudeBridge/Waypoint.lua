-- Claude Bridge waypoints. Claude's set_waypoint tool arrives with a reply
-- (ClaudeBridge_OnReply -> ClaudeBridge_SetWaypoint). An arrow on screen turns
-- toward the spot and counts down the yards.

local ARRIVE_YARDS = 10
local TICK = 0.05                       -- seconds between arrow updates
local atan2 = math.atan2 or math.atan   -- Lua 5.1 in WoW, 5.3 in the offline tests

local arrow                             -- built on first use
local arrivedUntil = 0                  -- keep "Arrived" on screen until this GetTime()

local function say(text, r, g, b)
  if ClaudeBridge_Print then ClaudeBridge_Print(text, r, g, b) end
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
  local wp = ClaudeBridgeDB.waypoint
  if not wp then
    if arrow and GetTime() >= arrivedUntil then arrow:Hide() end
    return
  end
  if not arrow then buildArrow() end
  arrow:Show()
  local state, yards, angle = relative(wp)
  if state == "ok" and yards <= ARRIVE_YARDS then
    ClaudeBridgeDB.waypoint = nil
    arrivedUntil = GetTime() + 3
    arrow.arrow:Hide()
    arrow.text:SetText("Arrived: " .. wp.label)
  elseif state == "ok" then
    arrow.arrow:SetRotation(angle)
    arrow.arrow:Show()
    arrow.text:SetText(string.format("%s\n%d yd", wp.label, math.floor(yards + 0.5)))
  elseif state == "elsewhere" then
    arrow.arrow:Hide()
    arrow.text:SetText(wp.label .. ": in " .. wp.zone)
  else
    arrow.arrow:Hide()
    arrow.text:SetText(wp.label)
  end
end

function ClaudeBridge_ClearWaypoint()
  ClaudeBridgeDB.waypoint = nil
  arrivedUntil = 0
  if arrow then arrow:Hide() end
end

local function describe(wp)
  return string.format("Waypoint: %s, %s %.1f, %.1f. /claude way clear removes it.", wp.label, wp.zone, wp.x, wp.y)
end

-- Called with the waypoint that came with Claude's answer.
function ClaudeBridge_SetWaypoint(w)
  local mapID = findMap(w.zone)
  if not mapID then
    say("Couldn't find the zone " .. w.zone .. " on the map, so no arrow.", 1, 0.3, 0.3)
    return
  end
  local zone = w.zone:gsub("%s*>.*$", "")
  ClaudeBridgeDB.waypoint = { mapID = mapID, zone = zone, x = w.x, y = w.y, label = w.label }
  ClaudeBridgeDB.waypointError = nil
  arrivedUntil = 0
  say(describe(ClaudeBridgeDB.waypoint))
  ClaudeBridge_WaypointUpdate()
end

-- /claude way [clear]
function ClaudeBridge_WaypointCommand(arg)
  if arg == "clear" then
    ClaudeBridge_ClearWaypoint()
    say("Waypoint cleared.")
  elseif ClaudeBridgeDB.waypoint then
    say(describe(ClaudeBridgeDB.waypoint))
  else
    say("No waypoint. Ask Claude where something is to get one.")
  end
end

local ev = CreateFrame("Frame")
ev:RegisterEvent("PLAYER_LOGIN")
ev:SetScript("OnEvent", function()
  if ClaudeBridgeDB.waypoint then ClaudeBridge_WaypointUpdate() end
end)
