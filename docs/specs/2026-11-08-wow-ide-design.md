# WoW IDE: drive Claude Code sessions from inside WoW

Status: design approved in chat (2026-11-08). Slice 1 has a plan
(`2026-11-08-sessions-panel-plan.md`); slices 2-4 get their own plans after
their spikes pass.

## Purpose

Today the in-game window talks to one answer-only Claude (web search, no files).
This feature turns it into a small IDE for real work: see your Claude Code
sessions, continue any of them from inside the game, watch what Claude does,
and approve each edit or command from WoW. Claude writes the code; the player
steers and approves. Typing code by hand in WoW is out of scope (WoW's text
boxes are basic, and only 1200 bytes go out per message).

## What the pipes allow (measured)

- **PC → WoW:** no practical size limit per reply (the reply is a Lua file the
  game loads). One reply uses one of the slot addons; slots reset on `/reload`.
- **WoW → PC:** up to 1200 bytes per message, one message at a time, about
  1-2 s per hop on top of Claude's own time. Enough for instructions, picks and
  approvals.
- **Session data on disk:** `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`
  holds each transcript, with `customTitle` and `cwd` fields.
  `~/.claude/sessions/<pid>.json` lists sessions that are open right now, with
  `sessionId`, `cwd`, `name`, `kind`, `entrypoint` and `status` (`busy` / idle).
- **Permission prompts:** `claude -p` can hand permission prompts to another
  program (`--permission-prompts host` / `--permission-prompt-tool`), so the
  bridge can forward them to WoW.

## Slices

Each slice ships on its own and is useful without the next.

1. **Sessions panel.** The Claude window lists your Claude Code sessions (title,
   project, age) and marks the ones open in the desktop app. Read-only.
2. **Continue a session, read-only.** Pick a session, ask about its project.
   Claude runs in that session's folder with only reading and searching tools
   (Read, Grep, Glob). Sessions open in the desktop app are copy-only
   (`--fork-session`), never written to.
3. **Edits with approvals.** Edits and commands pop up in WoW with the diff or
   command and [Approve] [Deny] [Approve edits for this turn]. Unanswered
   prompts are denied after 5 minutes. Reads still pass automatically. Each
   project's own Claude Code permission settings still apply.
4. **Polish.** Activity line ("Reading src/app.ts") batched every few seconds,
   monospace font bundled in the addon for diffs, reply slots raised to 150.

## Architecture

- **Bridge (Node, no npm packages).** New module `bridge/sessions.js` reads the
  session folders (titles, cwd, mtime, open status only, never message text).
  Slice 2 adds a per-session runner: `claude -p --resume <id>` with `cwd` set to
  the session's folder. Slice 3 adds the permission handoff.
- **Addon (Lua).** The window gains a sessions column on the right. The list is
  stored in `ClaudeBridgeDB.sessions`, so it survives `/reload`.
- **Protocol.** Replies stay `r.lua` files. A reply slot may now hold several
  calls: `ClaudeBridge_OnSessions({...})` first, then the usual
  `ClaudeBridge_OnReply(id, text)`. Every reply carries a fresh list at no
  extra slot cost.
- **Refresh rule.** Opening the window refreshes the list only when it is more
  than 2 minutes old, using a silent `!sessions` command the bridge answers
  without Claude. A question typed during that refresh waits and goes out right
  after it. A silent refresh that gets no answer within 15 s is dropped quietly.

## Spikes to run before each slice

These are the "make sure it's OK" checks. Each is a throwaway probe whose
result is recorded here before that slice's plan is written.

- **Before slice 2:** run `claude -p --resume <id>` from the session's cwd on a
  copy of a closed desktop session. Check that it continues the same
  transcript, and that the desktop app shows the new turns when reopened.
- **Before slice 2:** confirm `--fork-session` leaves the original transcript
  untouched.
- **Before slice 3:** get one permission prompt from `claude -p` into the bridge
  and answer it, using `--permission-prompts host` with stream-json or a
  `--permission-prompt-tool` MCP server written without npm packages.
- **Before slice 4:** check that Forever loads a `.ttf` shipped inside the addon
  folder (`FontString:SetFont("Interface\\AddOns\\ClaudeBridge\\mono.ttf", 12)`).
- **Game rules:** nothing here automates gameplay or reads game memory. The
  addon only shows text and takes typed input, like any chat addon. Re-check
  Forever's addon policy before slice 3, since that slice lets the game window
  approve actions on the PC.

## Privacy

- The panel shows session titles and project folder names, which can be
  personal. They stay on the player's PC (game UI and SavedVariables) and are
  never sent to Claude.
- The bridge never reads message text for the list, only `customTitle`, `cwd`
  and file times.
- No in-game character names in this repo, tests included (tests use
  `Testmage`).

## Acceptance Criteria

### Slice 1: Sessions panel

```gherkin
Feature: Sessions panel

  Scenario: Panel lists recent sessions newest first
    Given the bridge is running and three Claude Code sessions exist on the PC
    When the player opens the Claude window and the saved list is over 2 minutes old
    Then the sessions column shows the three sessions newest first
    And each row shows the session title, its project folder and how long ago it was active

  Scenario: Bridge's own sessions are hidden
    Given the bridge's agent-home sessions and temp-folder sessions exist on the PC
    When the bridge builds the sessions list
    Then neither appears in the list

  Scenario: Sessions open in the desktop app are marked
    Given one session is open in the desktop app with status busy
    And another session has a leftover registry file whose process has exited
    When the bridge builds the sessions list
    Then the first session is marked busy
    And the second session is not marked

  Scenario: Session message text never leaves the transcript file
    Given a session transcript whose messages contain the word SECRETWORD
    When the bridge builds the sessions list
    Then nothing in the list contains SECRETWORD

  Scenario: Every answer refreshes the list for free
    Given the bridge is running
    When Claude's answer is written to a reply slot
    Then that same slot also carries a fresh sessions list
    And the sessions list runs before the answer

  Scenario: A fresh list is not requested again
    Given the saved list is 30 seconds old
    When the player opens the Claude window
    Then no screenshot is taken

  Scenario: A question typed during a refresh is not lost
    Given a silent sessions refresh is waiting for its reply
    When the player sends a question
    Then the question goes out right after the refresh reply arrives

  Scenario: A silent refresh with no answer is dropped quietly
    Given a silent sessions refresh has waited 15 seconds without a reply
    When the addon checks for replies
    Then no error is shown and the window accepts questions again

  Scenario: List survives a reload
    Given the sessions list was received before a /reload
    When the player opens the Claude window after the /reload
    Then the saved list is shown right away
```

### Slice 2: Continue a session, read-only

```gherkin
Feature: Continue a session from WoW

  Scenario: Asking a closed session about its project
    Given a session that is not open in the desktop app is selected
    When the player sends a question
    Then Claude answers from inside that session's folder with the session's history
    And Claude can read and search files but not edit them or run commands

  Scenario: Sessions open in the desktop app are copy-only
    Given a session that is open in the desktop app is selected
    When the player sends a question
    Then the bridge continues a copy of the session
    And the original transcript is unchanged

  Scenario: The WoW tab keeps the game chat
    Given another session was selected before
    When the player selects the WoW entry and sends a question
    Then the answer comes from the answer-only game chat session
```

### Slice 3: Edits with approvals

```gherkin
Feature: Approve edits from WoW

  Scenario: An edit waits for approval
    Given Claude wants to edit a file in the selected session's folder
    When the edit is requested
    Then the WoW window shows the file name and the diff with Approve and Deny buttons
    And the file is unchanged until the player answers

  Scenario: A denied edit is not applied
    Given an edit is waiting for approval
    When the player clicks Deny
    Then the file is unchanged and Claude is told the edit was denied

  Scenario: An unanswered approval is denied
    Given an edit has waited 5 minutes without an answer
    When the bridge checks pending approvals
    Then the edit is denied

  Scenario: Approving edits for one turn
    Given the player clicked Approve edits for this turn
    When Claude requests another edit in the same turn
    Then it is applied without asking
    And the next turn asks again
```

### Slice 4: Polish

```gherkin
Feature: IDE polish

  Scenario: Activity line follows Claude's work
    Given Claude is working on a question in a selected session
    When Claude reads or edits a file
    Then the window's activity line names that file within 5 seconds

  Scenario: Diffs use a monospace font
    Given an approval with a diff is shown
    When the player looks at the diff
    Then removed lines are red, added lines are green, in the bundled monospace font

  Scenario: More reply slots
    Given setup has been run
    When the player opens the AddOns list
    Then there are 150 reply slots
```
