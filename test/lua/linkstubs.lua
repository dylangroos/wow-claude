INSERTED, EVENTS, MOD, LINES = {}, {}, false, {}
function hooksecurefunc(a, b, c)
  local tbl, name, fn = a, b, c
  if type(a) == "string" then tbl, name, fn = _G, a, b end
  local orig = tbl[name]
  tbl[name] = function(...) local r = table.pack(orig(...)); fn(...); return table.unpack(r, 1, r.n) end
end
IsModifiedClick = function(k) return MOD end
ChatEdit_InsertLink = function(link) return false end
ChatEdit_TryInsertQuestLinkForQuestID = function(id) return false end
WorldFrame = {}
local tips = {
  ["Lesser Magic Wand"] = { "Lesser Magic Wand", "Binds when equipped", "Ranged|Wand", "11 - 21 Arcane Damage|Speed 1.50", "Requires Level 10" },
  ["Greater Magic Wand"] = { "Greater Magic Wand", "Ranged|Wand", "13 - 25 Arcane Damage|Speed 1.40" },
}
C_TooltipInfo = { GetHyperlink = function(link)
  local name = link:match("%[(.-)%]")
  local t = tips[name] or { name }
  local lines = {}
  for i, l in ipairs(t) do local a, b = l:match("^(.-)|(.*)$"); lines[i] = { leftText = a or l, rightText = b } end
  return { lines = lines }
end }
C_Item.GetItemInfoInstant = function(link) return 1, "Weapon", "Wand", "INVTYPE_RANGEDRIGHT" end
SELECTED = 88
C_QuestLog.GetLogIndexForQuestID = function(id) return ({ [88] = 2, [46] = 3 })[id] end
C_QuestLog.GetSelectedQuest = function() return SELECTED end
C_QuestLog.SetSelectedQuest = function(id) SELECTED = id end
C_QuestLog.GetQuestObjectives = function(id)
  if id == 46 then return { { text = "Murloc Fin: 3/8", finished = false } } end
  return {}
end
GetQuestLogQuestText = function(index)
  if SELECTED == 46 then return "The murlocs have been raiding the coast.", "Bring 8 Murloc Fins to Marshal Dughan." end
  return "wrong quest selected", "wrong"
end
GetQuestLink = function(id) return "|cffffff00|Hquest:" .. id .. ":12|h[Quest " .. id .. "]|h|r" end
ClaudeBridgeScanTipTextLeft1 = { GetText = function() return "Lesser Magic Wand" end }
ClaudeBridgeScanTipTextLeft2 = { GetText = function() return "Ranged" end }
ClaudeBridgeScanTipTextRight2 = { IsShown = function() return true end, GetText = function() return "Wand" end }
