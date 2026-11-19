# ClaudeBridge.exe: a downloadable bridge built by CI

## Purpose

Running the bridge meant cloning the repo, installing Node, running `setup.js` and
keeping a terminal open. A release zip with a double-clickable `ClaudeBridge.exe`
lets a player skip all of that. It also ends the "two bridges at once" failure:
both answered every question, overwrote each other's reply slots and hung the game.

## Design

- **The exe is Node plus the bridge.** `scripts/build-exe.js` bundles `bridge/*.js`
  into one script (a small CommonJS wrapper, so no bundler dependency), turns it into
  a Node single-executable blob and injects it into a copy of `node.exe` with
  `postject`. The release zip holds `ClaudeBridge.exe`, `addon/ClaudeBridge/` and a
  `README.txt`.
- **Files live next to the exe.** `bridge/paths.js` picks the root: the folder of the
  exe when packaged (`node:sea` says so), otherwise the repo root. `config.json`,
  `state.json`, `agent-home/` and the addon source all hang off it, as they do in the
  repo. `CB_CONFIG`, `CB_STATE` and `CB_AGENT_HOME` still override.
- **The waypoint helper is the exe itself.** The bridge used to start
  `node waypoint-mcp.js` as Claude's MCP server. A packaged exe has no separate script,
  so it starts `ClaudeBridge.exe --waypoint-mcp`.
- **First run installs the addon.** `bridge/cli.js` (the exe's entry) looks for
  `_forever_` in the usual install folders, asks for the path if it finds none, runs
  setup, then starts the bridge. `setup` and `--version` are subcommands. Errors wait
  for Enter, so a double-clicked window doesn't vanish with the message.
- **One bridge per WoW folder.** `bridge/lock.js` keeps `bridge.lock` (the process id)
  in the installed addon folder. A second bridge for the same folder says which one is
  running and exits. A lock whose process is gone, or whose id now belongs to another
  program, is taken over.
- **CI.** `.github/workflows/ci.yml` runs on Windows for every push and PR: all tests,
  then the exe build and `scripts/exe-smoke.js` against the real exe, and uploads the
  zip as an artifact. A `v*` tag also publishes it as a GitHub Release.

## Not included

Claude Code itself. Every PC still needs it installed and logged in. The exe isn't
code-signed, so Windows SmartScreen may warn on first run.

## Acceptance Criteria

```gherkin
Feature: Downloadable bridge

  Scenario: Pushing a version tag publishes a release
    Given the tests pass on Windows in CI
    When a tag v1.0.0 is pushed
    Then a GitHub Release v1.0.0 has ClaudeBridge-v1.0.0.zip with ClaudeBridge.exe and the addon folder

  Scenario: The exe answers with waypoints on a PC without Node
    Given ClaudeBridge.exe set up for a WoW folder and a Claude that sets a waypoint
    When the player asks where something is
    Then the reply slot holds the answer and the waypoint

  Scenario: A second bridge refuses to start
    Given a bridge is already running for a WoW folder
    When another bridge starts for the same folder
    Then it says a bridge is already running and exits with an error
```

`scripts/exe-smoke.js` checks the last two against the built exe in CI. Its
stand-in Claude calls the waypoint tool through the exe's own helper mode.
