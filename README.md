# Claude Bridge for WoW: Forever

Ask Claude Code questions from a small window inside World of Warcraft: Forever,
and get answers back in the game, usually in 5 to 20 seconds. Claude knows your
character (class, level, zone, talents, gear, professions, quests) and can search
the web for current Forever info.

WoW addons can't touch the network or read files, so the bridge talks to the game
through the only two doors it has:

```
OUT  /claude <question>
       │  addon draws the question as a strip of colored 16x16 blocks
       │  in the top-left corner and calls Screenshot()  (TGA, lossless)
       ▼
     Screenshots\WoWScrnShot_*.tga  ──►  bridge.js decodes the strip,
                                          deletes that screenshot,
                                          runs `claude -p`
IN     │
       ▼
     bridge writes the answer into the next "reply slot" addon
     (ClaudeBridge_R01..R50, load-on-demand), then fills in a matching
     silent .wav. The addon plays the .wav every 250 ms; once it really
     plays, it calls LoadAddOn on the slot, which reads the answer from disk.
```

No input injection, no memory reading, no gameplay automation. The addon uses
normal addon APIs and only reads your own character's info. The PC side only
reads screenshots and writes addon files.

## Setup (once)

Requires Node.js 18+ and [Claude Code](https://claude.com/claude-code). No npm
packages.

1. Log Claude Code in for the terminal (the desktop app's login doesn't carry over):
   ```
   claude auth login
   ```
2. Install the addon with WoW closed (or fully restart WoW afterwards):
   ```
   node bridge\setup.js
   ```
   The default game folder is `D:\World of Warcraft\_forever_`. Use
   `--wow "<path to _forever_>"` for another location. After pulling an update, run
   `node bridge\setup.js` again so the game gets the new addon files, then restart the game.
3. Start WoW: Forever. In the **AddOns** list on the character screen, make sure
   **Claude Bridge** and its reply entries are enabled.

## Every session

```
node bridge\bridge.js
```

Leave it running while you play. In game:

| Command | What it does |
|---|---|
| `/claude` | Open or close the window. Type a question and press Enter. Messages typed while Claude is answering queue up (up to 5) and go out one at a time. |
| `/claude <question>` | Ask directly from chat. |
| `/claude new` | Start a fresh conversation. |
| `/claude compact` | Shrink a long conversation: Claude summarizes it and keeps going from the summary (takes a few minutes on a long one). Typing `/compact` in the window works too. |
| `/claude context` | Show how full the conversation is (e.g. 412k of 1M tokens) and the character info Claude gets. `context off` / `context on` toggles the character info. |
| `/claude way` | Show the waypoint or route Claude set, stop by stop. `way clear` removes it (or right-click the arrow). |
| `/claude cancel` | Stop waiting for an answer and drop any queued messages. |
| `/claude selftest` | Round-trip check without asking Claude. |

**Hotkey:** set one under Game Menu > Options > Keybindings > AddOns > Claude Bridge
("Open/close the Claude window"). It opens the window with the cursor already in
the input box; Esc closes it.

## Things to know

- **Game sound must be on.** The ready signal is a silent .wav on the Master channel.
  WoW mutes everything while tabbed out unless Sound in Background is on
  (`/console Sound_EnableSoundWhenGameIsInBG 1`); without it, answers wait until you
  come back. After 4 minutes the addon says so but keeps listening, so a late answer
  still shows up.
- **50 replies per UI session.** WoW loads each addon only once per session, so each
  reply needs a fresh slot. `/reload` resets them all.
- **Shift-click items and quests into the box** (while it has focus) to ask about them.
  The item's tooltip and whatever you wear in that slot go along, or the quest's text
  and objectives with your progress.
- **Waypoints.** Ask where something is ("where's the Westfall flight master?") and
  Claude can set a waypoint: an arrow at the top of the screen turns toward it and
  shows the yards, and the world map shows a pin with a line from you. Drag the arrow
  to move it. It clears itself within 10 yards. For a route or several places
  ("take me to the Deadmines", "where are the six things for this quest?") Claude can
  set a chain of stops: the arrow moves on to the next stop when you arrive. Claude
  sees which stops are left, so you can ask it to skip or change one.
- **Character info is sent as diffs.** The first question sends everything; later
  ones only send what changed (zone, gold, a new quest...).
- **Answer-only.** Claude can search and read the web and set waypoints, but can't edit
  files or run commands. See the `--tools` / `--allowedTools` lines in `bridge/bridge.js`.
- A brief flash of colored blocks in the top-left corner is the question going out.
- Uninstall: `node bridge\setup.js --uninstall`.

## Tests

```
node bridge\test.js
```

Runs the whole loop offline against a fake WoW folder and a fake Claude: the strip
codec on TGA, PNG and JPEG screenshots, the reply slots, sessions, character info
parsing, and slot resets on `/reload`.

The addon's own tests run the real `ClaudeBridge.lua` in [fengari](https://github.com/fengari-lua/fengari)
(Lua in JS) with stubbed WoW APIs: character info, shift-click links, the hotkey.
They need two npm packages, installed once outside the bridge:

```
npm install --prefix test/lua/.tools fengari luaparse
node test/lua/run.js
```

Designs and plans for upcoming features live in `docs/specs/`.

## Files

- `addon/ClaudeBridge/`: the in-game addon (window, strip encoder, character info, reply polling)
- `bridge/protocol.js`: strip codec, TGA/PNG readers, payload format, reply-slot files
- `bridge/bridge.js`: watches Screenshots, calls Claude, writes replies
- `bridge/setup.js`: installs the addon and its reply slots
- `bridge/waypoint-mcp.js`: the waypoint tools (a tiny MCP server Claude Code starts)
