# Waypoints: Claude points you to a spot with an arrow

Status: design approved in chat (2026-11-08). Plan: `2026-11-08-waypoint-plan.md`.
Idea from Jason.

## Purpose

When you ask "where's the Westfall flight master?" or "where do I find these
murlocs?", Claude already answers with coordinates in text. This feature lets
Claude set a waypoint instead: an arrow on screen turns toward the spot and
counts down the distance, and the world map shows a pin with a line from you to
it.

## Decisions (made in chat)

- **Look:** on-screen arrow plus a map pin and line. A line in the 3D world is
  not possible: addons can't place things in the 3D world, only on screen and on
  maps. Blizzard's own waypoint tracker was not chosen because Forever may not
  show it.
- **How Claude hands it over:** a real tool, `set_waypoint`, served by a small
  MCP server in Node with no npm packages. Not a tag in the answer text: the tool
  checks its inputs, and the same kind of server is what the IDE's
  approve-from-WoW slice needs later.

## Spike results (measured 2026-11-08, Claude Code 2.1.267)

- A minimal stdio MCP server (newline-delimited JSON-RPC: `initialize`,
  `tools/list`, `tools/call`) works with `claude -p --mcp-config <file>
  --strict-mcp-config`. Asked to point at Hogger in Elwynn Forest at 25.6, 78.4,
  Claude called the tool and the server recorded
  `{"zone":"Elwynn Forest","x":25.6,"y":78.4,"label":"Hogger"}`.
- Time cost: none measurable. Three runs each of "Reply with just: ok":
  without the server 4.8 / 5.2 / 4.7 s (API 1.9-2.2 s); with it
  4.3 / 4.1 / 4.5 s (API 1.6-1.8 s). `--strict-mcp-config` also stops the
  bridge's Claude from loading the PC's other MCP servers.
- `--tools WebSearch,WebFetch` does not hide MCP tools. With the server, Claude
  lists its tools as `WebFetch, WebSearch, mcp__wow__set_waypoint, Skill`.
  `--allowedTools` must include `mcp__wow__set_waypoint` so it runs without a
  permission prompt.

## How it works

1. The addon adds the player's map position to the character info
   (`pos`, "42.1, 65.9" in the current zone), so Claude can pick the nearest of
   several spots. Like the other fields, it is sent only when it changed.
2. The bridge runs `claude -p` with the waypoint server. The system prompt says:
   when the player asks where something is, find its coordinates on a source
   page, call `set_waypoint(zone, x, y, label)`, mention the coordinates in the
   answer, and never guess.
3. The server checks the call (zone: text, 1-60 characters; x and y: numbers
   from 0 to 100; label: text, 1-40 characters). A bad call gets an error back,
   so Claude can fix it. A good call is appended as one JSON line to the file
   named by `CB_WAYPOINT_FILE`.
4. After Claude answers, the bridge reads that file, checks the last line again
   and passes it with the answer:
   `ClaudeBridge_OnReply(id, text, { waypoint = { zone=..., x=..., y=..., label=... } })`.
   Riding inside `OnReply` means a reply left over from before a `/reload` sets
   no waypoint, because `OnReply` already ignores those.
5. The addon (new file `Waypoint.lua`) looks the zone name up among the game's
   maps, saves the waypoint in `ClaudeBridgeDB.waypoint` and shows the arrow.

## In game

- **Arrow:** a small window you can drag, at the top middle of the screen by
  default. The arrow is the game's own minimap player arrow
  (`Interface\Minimap\MinimapArrow`), turned toward the spot. Under it: the
  label and the distance in yards.
- **Distance and direction** come from `C_Map.GetWorldPosFromMapPos` (world
  yards) and `GetPlayerFacing`, so they work across zones on one continent.
- **Another continent:** the arrow hides and the text says
  "Hogger: in Durotar".
- **Arrived:** within 10 yards the text says "Arrived: Hogger" and the waypoint
  clears.
- **No position** (dungeons, or the game hides your facing): the arrow hides
  until it comes back.
- **World map:** a pin (the game's raid star icon) on the spot and a line from
  you to it, on whatever map is open, as long as the spot is on it.
- **Commands:** `/claude way` shows the current waypoint, `/claude way clear`
  removes it. Right-clicking the arrow also clears it.
- **Survives `/reload`** (saved in `ClaudeBridgeDB.waypoint`).
- **Game rules:** the same kind of thing TomTom-style arrow addons do. Nothing
  moves the character.

## Checks before building the addon side

Run in game before Tasks 4 and 5 of the plan (one `/run` line, in the plan):
`GetPlayerFacing`, `C_Map.GetWorldPosFromMapPos`, `C_Map.GetMapPosFromWorldPos`,
`C_Map.GetMapChildrenInfo`, `CreateVector2D`, `WorldMapFrame.ScrollContainer.Child`
and `CreateLine` exist in Forever.

## Privacy

- The waypoint file lives in `agent-home/` (gitignored with it) and is
  deleted before each question, so an old waypoint never rides along with a
  new answer.
- No in-game character names in this repo, tests included (tests use
  `Testmage`).

## Acceptance Criteria

```gherkin
Feature: Waypoints

  Scenario: Asking where something is sets a waypoint
    Given the bridge is running
    When Claude calls set_waypoint for Hogger in Elwynn Forest at 25.6, 78.4 while answering
    Then the reply slot carries that waypoint along with the answer

  Scenario: An answer without a waypoint carries none
    Given the bridge is running
    When Claude answers without calling set_waypoint
    Then the reply slot holds only the answer

  Scenario: Only the last waypoint of an answer is kept
    Given Claude called set_waypoint twice while answering one question
    When the bridge writes the reply
    Then the reply carries only the second waypoint

  Scenario: Bad coordinates are rejected
    Given the waypoint server is running
    When Claude calls set_waypoint with x = 140
    Then the tool returns an error naming x
    And nothing is written to the waypoint file

  Scenario: Claude knows where the player is standing
    Given the player stands at 42.1, 65.9 on their zone map
    When the player sends a question
    Then the character info includes the map position "42.1, 65.9"

  Scenario: The arrow points at the waypoint
    Given a waypoint 100 yards due north of the player
    When the player faces 90 degrees to the left of north
    Then the arrow points to the right of the screen
    And the arrow text shows "100 yd"

  Scenario: Arriving clears the waypoint
    Given a waypoint is set
    When the player is 5 yards from it
    Then the arrow text says "Arrived: Hogger"
    And the waypoint is cleared

  Scenario: A waypoint on another continent shows its zone
    Given a waypoint in Durotar while the player is in Elwynn Forest
    When the arrow updates
    Then the arrow is hidden
    And the text says "Hogger: in Durotar"

  Scenario: Unknown zone is reported
    Given a reply carries a waypoint in a zone named "Narnia"
    When the addon receives it
    Then the window says it couldn't find the zone Narnia
    And no waypoint is set

  Scenario: The world map shows a pin and a line
    Given a waypoint in Elwynn Forest and the player in Elwynn Forest
    When the player opens the world map on Elwynn Forest
    Then a pin sits on the waypoint
    And a line runs from the player to the pin

  Scenario: Waypoint survives a reload
    Given a waypoint was set before a /reload
    When the player logs back in
    Then the arrow shows the same waypoint

  Scenario: Clearing the waypoint by command
    Given a waypoint is set
    When the player types /claude way clear
    Then the arrow is hidden and the waypoint is gone
```
