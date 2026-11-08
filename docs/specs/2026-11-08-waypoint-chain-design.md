# Waypoint chains: Claude sets a list of stops in order

Status: design approved in chat (2026-11-08). Builds on
`2026-11-08-waypoint-design.md`. Plan: `2026-11-08-waypoint-chain-plan.md`.

## Purpose

Today Claude can set one waypoint. Many questions need several: "how do I get
to the Deadmines from here?" (a route of legs) or "where are the six things for
this quest?" (a tour of places). A waypoint chain is an ordered list of stops.
The arrow points at the first stop, and arriving there moves it on to the next.
The same mechanic covers a route and a tour.

## Decisions (made in chat)

- **One mechanic for routes and tours.** Claude puts the stops in travel order.
  For a tour it starts with the stop nearest the player. The addon never
  reorders stops.
- **Tool shape:** a new tool, `set_waypoints`, takes the whole list in one
  call. The server checks the whole list at once, so a bad stop can't leave
  half a chain. `set_waypoint` stays and sets a chain of one. As today, the
  last action of an answer is the only one that counts.
- **Claude sees progress.** The character info includes the current and
  remaining stops, so "what's next?" and "skip the cave" work. Skipping or
  changing stops goes through Claude: it calls `set_waypoints` again with the
  new list.
- **Not included** (offered, not chosen): `/claude way next` and
  `/claude way back`, numbered pins for the whole route on the world map, and
  right-click to skip. Right-click still clears everything, and the map still
  shows the current stop only.

## How it works

### Waypoint server (`bridge/waypoint-mcp.js`)

- New tool `set_waypoints` with input `{ stops: [{ zone, x, y, label }, ...] }`,
  1 to 10 stops. Each stop is checked like `set_waypoint` today (zone: text,
  1-60 characters; x and y: numbers 0-100; label: text, 1-40 characters).
- A bad call returns an error that names the stop, for example
  `stop 2: x must be a number from 0 to 100`, and writes nothing. A wrong number
  of stops returns `stops must be a list of 1-10 stops`.
- A good call appends one line, `{"stops":[...]}`, and returns
  `Route set: 3 stops, first Murloc camp in Westfall.`
- `set_waypoint` now appends `{"stops":[{...}]}`, a chain of one. Its reply
  text is unchanged.
- `clear_waypoint` is unchanged (`{"clear":true}`) and clears the whole chain.

### System prompt (`bridge/bridge.js`)

The waypoint lines gain:

- For a route or several places to visit, call `set_waypoints` once with every
  stop in travel order. For a tour, start with the stop nearest the player's
  map position.
- The `[Game state]` block shows the current chain. To skip, add or reorder
  stops, call `set_waypoints` again with the new list of stops still to visit.

### Bridge and reply (`bridge/bridge.js`, `bridge/protocol.js`)

- `readWaypointAction` returns `{ waypoints: [stop, ...] }` for the last good
  `stops` line (every stop is checked again), or `{ clear_waypoint: true }`.
  The single `waypoint` extra goes away.
- The bridge log says `Waypoints: 3 stops, first Murloc camp, Westfall 45.2, 33.1`.
- The reply slot carries
  `ClaudeBridge_OnReply(id, text, { waypoints = { { zone = ..., x = ..., y = ..., label = ... }, ... } })`.
  The text fields are cleaned and wrapped the same way as today.
- The context label for the new field is `Waypoints (the arrow's route)`.

### Addon (`Waypoint.lua`, `ClaudeBridge.lua`)

- **Saved data:** `ClaudeBridgeDB.waypoints = { stops = { {mapID, zone, x, y, label}, ... }, current = n }`
  replaces `ClaudeBridgeDB.waypoint`. At login, a single waypoint saved by the
  previous version becomes a chain of one.
- **Setting:** `ClaudeBridge_SetWaypoints(list)` looks up every zone first. If
  any zone can't be found, the whole chain is rejected with
  `Couldn't find the zone Narnia on the map, so no arrow.`, and the waypoint
  that was already set stays. The window then prints the chain the same way
  `/claude way` does.
- **Arrow text:** `Cave (2/3)` and the yards on the next line. A chain of one
  shows no counter (`Hogger` and the yards). The "in another zone" text becomes
  `Cave (2/3): in Durotar`.
- **Arriving at a stop that isn't the last:** the window says
  `Arrived: Murloc camp. Next: Cave (2 of 3).` and the arrow turns to the next
  stop right away.
- **Arriving at the last stop:** as today, the arrow text says
  `Arrived: Hogger` for 3 seconds and the chain clears.
- **World map:** pin and line for the current stop only (unchanged).
- **Right-click, `/claude way clear`, `clear_waypoint`:** remove the whole
  chain.
- **`/claude way`:** lists every stop in order, with coordinates, and marks the
  current one. Stops already passed are shown as done.
- **`ClaudeBridge.lua`:** `OnReply` hands `extra.waypoints` to
  `ClaudeBridge_SetWaypoints`, with the same "Waypoints aren't loaded yet"
  fallback as today.

### What Claude sees (character info)

- New field `way`, read from `ClaudeBridge_WaypointContext()` in
  `Waypoint.lua`. It sits right after `pos` (the map position), not last: when
  the 1500-byte budget runs out, the later fields are the ones cut, and Claude
  needs `way` to act.
- With a chain: `stop 2 of 3. Now: Cave, Elwynn Forest 40.0, 20.1. Then: Hogger, Elwynn Forest 25.6, 78.4`.
  Stops already passed are left out. Coordinates have one decimal. The value
  lists the current stop and at most the 3 stops after it, then `and N more`
  (for example `...; and 5 more`).
- With no chain: `none`. Fields are sent only when they change, and a missing
  field isn't sent at all, so without `none` Claude would go on believing in a
  chain the player has finished or cleared.
- Size: about 85 bytes per stop, so about 350 bytes at most, and the field is
  sent only when it changes (when a chain is set, a stop is reached, or the
  chain is cleared). Claude can still find the later stops in its own earlier
  `set_waypoints` call, because the session is resumed.

## Error handling

- A bad call to the server: the error goes back to Claude, which can fix it.
- An unknown zone in game: the whole chain is rejected, and the old one stays.
- A failure in the arrow update: same as today (the arrow hides, and the error
  goes to `ClaudeBridgeDB.waypointError` and the window).

## Testing

Offline tests cover the server (`bridge/waypoint-mcp.test.js`), the bridge and
reply slot (`bridge/test.js`), the addon in fengari (`test/lua/waypointtest.js`)
and the `way` field: `test/lua/linkcases.js` covers it passing through
`ClaudeBridge.lua`, `test/lua/waypointtest.js` covers its text, and
`test/lua/ctxtest.js` covers it under a full budget. Claude
calling `set_waypoints` for a real route, and skipping a stop when asked, is
checked by hand with the bridge running, because the model's choices aren't
deterministic.

## Privacy

Unchanged: the action file lives in `agent-home/` and is deleted before each
question. Tests use `Testmage` and no real character names.

## Acceptance Criteria

```gherkin
Feature: Waypoint server accepts chains

  Scenario: A chain of stops is recorded in order
    Given the waypoint server is running
    When Claude calls set_waypoints with Murloc camp, Cave and Hogger
    Then the waypoint file's last line holds those three stops in that order
    And the tool replies "Route set: 3 stops, first Murloc camp in Westfall."

  Scenario: A bad stop rejects the whole chain
    Given the waypoint server is running
    When Claude calls set_waypoints with three stops where stop 2 has x = 140
    Then the tool returns an error naming stop 2 and x
    And nothing is written to the waypoint file

  Scenario Outline: The number of stops is limited
    Given the waypoint server is running
    When Claude calls set_waypoints with <count> good stops
    Then the call <outcome>

    Examples:
      | count | outcome                                            |
      | 0     | fails with "stops must be a list of 1-10 stops"   |
      | 1     | succeeds                                           |
      | 10    | succeeds                                           |
      | 11    | fails with "stops must be a list of 1-10 stops"   |

  Scenario: set_waypoint records a chain of one
    Given the waypoint server is running
    When Claude calls set_waypoint for Hogger in Elwynn Forest at 25.6, 78.4
    Then the waypoint file's last line holds one stop, Hogger
```

```gherkin
Feature: Bridge sends chains with the answer

  Scenario: The reply carries the whole chain
    Given Claude called set_waypoints with Murloc camp, Cave and Hogger while answering
    When the bridge writes the reply
    Then the reply slot carries all three stops in that order

  Scenario: Only the last chain of an answer is kept
    Given Claude called set_waypoints twice while answering one question
    When the bridge writes the reply
    Then the reply carries only the second chain

  Scenario: Clearing after setting a chain clears
    Given Claude called set_waypoints and then clear_waypoint while answering
    When the bridge writes the reply
    Then the reply carries clear_waypoint and no stops
```

```gherkin
Feature: The arrow follows a chain

  Scenario: A new chain starts at the first stop
    Given no waypoint is set
    When a reply arrives with the chain Murloc camp, Cave, Hogger
    Then the arrow text starts with "Murloc camp (1/3)"
    And the window lists Murloc camp, Cave and Hogger in that order

  Scenario: Arriving at a middle stop moves on to the next
    Given a chain of Murloc camp, Cave, Hogger at stop 1
    When the player is 5 yards from Murloc camp
    Then the window says "Arrived: Murloc camp. Next: Cave (2 of 3)."
    And the arrow text starts with "Cave (2/3)"

  Scenario: Arriving at the last stop clears the chain
    Given a chain of Murloc camp, Cave, Hogger at stop 3
    When the player is 5 yards from Hogger
    Then the arrow text says "Arrived: Hogger"
    And no chain is set

  Scenario: A chain of one shows no counter
    Given a chain with only Hogger, 100 yards away
    When the arrow updates
    Then the arrow text is "Hogger" and "100 yd" on the next line

  Scenario: A stop in another continent shows its zone and place in the chain
    Given a chain of Murloc camp, Cave, Hogger at stop 2, with Cave in Durotar and the player in Elwynn Forest
    When the arrow updates
    Then the arrow is hidden
    And the text says "Cave (2/3): in Durotar"

  Scenario: An unknown zone rejects the whole chain
    Given a waypoint for Hogger is set
    When a reply arrives with a chain whose stop 2 is in a zone named "Narnia"
    Then the window says it couldn't find the zone Narnia
    And the waypoint for Hogger is still set

  Scenario: Clearing removes the whole chain
    Given a chain of Murloc camp, Cave, Hogger at stop 2
    When the player types /claude way clear
    Then the arrow is hidden
    And no chain is set

  Scenario: The way command lists the chain
    Given a chain of Murloc camp, Cave, Hogger at stop 2
    When the player types /claude way
    Then the window lists Murloc camp, Cave and Hogger in that order with their coordinates
    And Murloc camp is marked done and Cave is marked current

  Scenario: The world map shows only the current stop
    Given a chain of three stops in Elwynn Forest at stop 2 and the player in Elwynn Forest
    When the player opens the world map on Elwynn Forest
    Then exactly one pin is shown, on stop 2
    And a line runs from the player to that pin

  Scenario: A chain survives a reload
    Given a chain of Murloc camp, Cave, Hogger at stop 2 before a /reload
    When the player logs back in
    Then the arrow text starts with "Cave (2/3)"

  Scenario: A waypoint saved by the previous version carries over
    Given the saved data holds a single waypoint for Hogger in the previous version's format
    When the player logs in
    Then the arrow text starts with "Hogger"
    And the saved chain holds one stop, Hogger
```

```gherkin
Feature: Claude sees the chain

  Scenario: Character info lists the stops still to visit
    Given a chain of Murloc camp, Cave, Hogger at stop 2, with Cave in Elwynn Forest at 40.0, 20.1 and Hogger at 25.6, 78.4
    When the player sends a question
    Then the character info field "way" is "stop 2 of 3. Now: Cave, Elwynn Forest 40.0, 20.1. Then: Hogger, Elwynn Forest 25.6, 78.4"

  Scenario: A long route shows only the next three stops
    Given a chain of 10 stops at stop 2
    When the player sends a question
    Then the character info field "way" lists stop 2 and stops 3 to 5
    And it ends with "and 5 more"

  Scenario: The route still reaches Claude when the quest log is full
    Given a chain is set and the quest log fills the character-info budget
    When the player sends a question
    Then the character info field "way" arrives whole

  Scenario: Character info reports when no chain is set
    Given a chain was sent with the previous question and has since been cleared
    When the player sends a question
    Then the character info field "way" is "none"
```
