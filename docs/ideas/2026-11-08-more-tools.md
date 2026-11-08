# More tools for the bridge's Claude

Status: ideas only, nothing approved or built. Each one gets its own design
(and spec, if it needs one) before any code.

## How every tool works

Each idea below follows the same path as `set_waypoint`
(`2026-11-08-waypoint-design.md`):

1. Claude calls the tool on the `wow` MCP server (`bridge/waypoint-mcp.js`).
2. The server checks the inputs and appends the action as a JSON line to the
   action file. A bad call gets an error back, so Claude can fix it.
3. After Claude answers, the bridge reads the action and sends it along with
   the answer as `ClaudeBridge_OnReply(id, text, extra)`.
4. The addon acts on `extra`. A reply left over from before a `/reload` does
   nothing, because `OnReply` already ignores those.

This means each new tool needs a server entry, a field in `extra`, and an
addon handler. If several tools land, the server should be renamed away from
"waypoint" and the action file should hold more than one kind of action per
answer.

## What an addon can't do

All of these limit every idea:

- Move the character, cast, target, use items or click a button for the
  player. Those are protected functions and need the player's key press.
- Act during combat in ways that need a key press (for example, making a
  macro).
- Place anything in the 3D world. Addons draw only on the screen and on maps.

Each idea lists the game functions it needs. As with waypoints, check that
they exist in Forever before building (one `/run` line).

## In progress

### Waypoint chain: `set_waypoints(stops[])`

An ordered list of up to 10 stops. The arrow points at stop 1, and arriving
moves it on to stop 2. One mechanic covers a route to one place (flight
master, then road, then cave mouth) and a tour of several places (quest
objectives, herb nodes, rares). `set_waypoint` stays and becomes a chain of
one. Decided in chat so far: the purpose and the tool shape. Still open: skip
and back commands, whether Claude sees the chain's progress, the whole route
on the world map, and whether right-clicking the arrow skips to the next stop.

## Strongest

### `copy_text(title, text)`

Opens a box in game with the text already selected, so Ctrl+C copies it.
You can't copy text out of Claude's replies today, so a talent loadout
string, a WeakAura import or a long macro can't be used. This one is small and
used every day, and the other tools can reuse the box.

- Needs: `CreateFrame("EditBox")`, `HighlightText`, a scroll frame for long
  text.
- Open question: is there a length limit on text that goes into a reply slot?

### `create_macro(name, icon, body)`

Claude writes a macro, and the addon saves it to the player's macro list,
ready to drag onto a bar.

- Needs: `CreateMacro`, `GetNumMacros`. Works out of combat only.
- The game limits how many macros you can have. When the list is full, say so
  and fall back to `copy_text`.
- The server checks the body length (255 characters) and the name length.

### `show_item(itemID)`

Puts a real item link in the Claude window. Hovering it shows the game's own
tooltip, and shift-click links it into chat. Useful for "what drops from X"
and "what should I wear at my level".

- Needs: `GetItemInfo` (the item may need to load first:
  `GET_ITEM_INFO_RECEIVED`), item links in a font string, a tooltip on hover.
- Claude gets item IDs from Wowhead pages, the same way it gets coordinates
  now. Never guess an ID.

## Good

### `set_timer(label, seconds)`

A countdown bar for a rare respawning in 7 minutes, a buff running out, or a
cooldown. It plays a sound when it ends.

- Needs: `GetTime`, a status bar, `PlaySound`. Saved in `ClaudeBridgeDB` so it
  survives a `/reload`.

### `set_checklist(title, items[])`

A small list window, such as the materials for a craft. Items that name an
item ID tick themselves off by counting the player's bags, so
"6 / 10 Linen Cloth" goes up as you farm. This pairs well with a waypoint
chain: the tour of places plus what to collect at each one.

- Needs: `GetItemCount`, `BAG_UPDATE`.

### `track_quest(questID)`

Adds a quest to the player's objective tracker.

- Needs: `C_QuestLog.AddQuestWatch` on modern clients, or `AddQuestWatch` with
  a quest log index on older ones. Check which one Forever has.

## Worth care

### `draft_chat(channel, text)`

Claude writes a message, and the addon puts it in the chat box without
sending it. The player reads it and presses Enter. It must not send on its
own: that would be speaking for the player, and "say" and "yell" need a key
press on modern clients anyway.

- Needs: `ChatFrame_OpenChat`.

## Bigger

### Approve from WoW

Slice 3 of the WoW IDE (`2026-11-08-wow-ide-design.md`): Claude Code's
permission prompts show up in game with [Approve] and [Deny]. This is the main
reason waypoints were built as an MCP server rather than as a tag in the
answer text. It is a bigger job than the tools above, because the answer has to
travel from game to PC while Claude waits.

## Suggested order

1. Finish the waypoint chain.
2. `copy_text`: smallest change, biggest daily gain, and the fallback for
   `create_macro`.
3. `show_item` and `create_macro`.
4. `set_timer`, `set_checklist`, `track_quest` as they come up in play.
