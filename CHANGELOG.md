# Changelog

All notable changes to Kanbini are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor versions may still carry user-visible changes).

Releases are cut by pushing a `v*` tag, which builds the Windows,
macOS and Linux downloads and publishes a GitHub Release (see
[`.github/workflows/release.yml`](.github/workflows/release.yml)).

## [Unreleased]

### Added

- **Move or copy a card to another board.** Right-click a card for
  "Duplicate" (a copy right below it), "Move..." and "Copy..." (pick any
  board, any list, top or bottom). Selected cards can be moved to another
  board too. The card keeps its labels: the other board's label with the
  same name, or a new one there in the same colour. A copy brings the
  description, due date, checklists and attachments along, but not the
  comments. One Ctrl+Z on the board you moved it from puts it back.

## [0.13.1] - 2026-10-30

### Added

- **Settings → About links to GitHub**: "Star on GitHub" and "Report a
  problem" open the project page in your browser.

### Fixed

- **Cards and lists an AI moves land where it asked.** When an AI (or a
  script using the local HTTP API) moved a card without saying exactly
  where, or named only the card it should go under, the card could end
  up in the wrong spot. Now a card moved with no position goes to the
  end of the list, and one moved "under card X" goes right under it.
  The same fix applies to moving lists, boards and checklist items.
  Dragging in the app was never affected.

## [0.13.0] - 2026-10-29

### Added

- **Kanbini for macOS and Linux.** Every release now has a `.dmg` for
  Macs (one app for both Apple Silicon and Intel) and, for Linux, a
  `.deb` for Debian and Ubuntu plus an AppImage for other distros. The
  Mac app isn't notarized by Apple, so the first time you open it, go
  to System Settings → Privacy & Security and click "Open Anyway". These
  builds are new, so please open an issue if anything's off.

## [0.12.0] - 2026-10-28

### Changed

- **Ctrl+F shows you where a card is instead of opening it.** Pick a
  card and Kanbini goes to its board, scrolls it into view and makes it
  glow for a moment, so you can see which list it's in. Press Enter to
  open it from there.
- **Shorter right-click menus.** Labels, due date, repeat, priority and
  cover on a card, and colour, sorting, card size, on-enter and card
  limit on a list, are now one row each that shows the current setting
  and opens a second menu beside it when you hover or click. The same
  goes for priority, labels and "Move to list" when several cards are
  selected.

### Added

- **Archive a card from its right-click menu.** It leaves the board
  but isn't deleted.
- **See and restore archived cards and lists.** Open the board's pencil
  menu and choose "Archived…" to see everything put away on that board,
  with a Restore and a Delete button for each. Restoring a card whose
  list was archived too brings the list back with it.
- **The card detail says where the card lives**, like "in To Do ·
  Website", right under the title. Click it to close the card and see
  it on the board.
- If a label filter or "Hide completed" is hiding the card you're
  looking for, Kanbini tells you and offers to show it, instead of
  quietly changing your filters.
- **Ctrl+Enter (⌘+Enter on Mac) or Ctrl+click in Ctrl+F opens the card
  straight away.** A line under the results lists the keys.

### Fixed

- **Ctrl+F's Enter now goes to the result you're looking at.** Typing
  and pressing Enter right away could land on a different board or card
  than the one you typed, a result that appeared under a resting mouse
  could quietly take over Enter, and on some searches the highlighted
  row wasn't the one Enter used. Every new search now starts on the
  first result, and the selected row is much easier to see.
- **Ctrl+F lists the board you're on first.** Its cards now come before
  every other board's, even when another board has the exact `#N` you
  typed.

## [0.11.1] - 2026-10-28

### Added

- **A one-file portable version is back.** Next to the installer and the
  portable folder, each release now has
  `Kanbini-X.Y.Z-win-x64-portable-single-file.exe`: one file you just
  run, nothing to extract. It unpacks itself into a temporary folder
  every time, so it takes a few seconds longer to open, and cleans that
  folder up when you close it. Connecting an AI to this version needs
  Node.js installed.

### Changed

- **Easier to find the right download.** Each release now starts with a
  short "Which file do I download?" table, and the portable folder is
  named `Kanbini-X.Y.Z-win-x64-portable.zip` so it doesn't get mixed up
  with GitHub's "Source code" zips.

## [0.11.0] - 2026-10-25

### Changed

- **Card numbers count per board.** Every board now has its own #1, #2,
  ..., like issue keys in a Jira project. Existing cards are renumbered
  once, per board, in the order they were made, so a card's number
  changes the first time you open this version. A `#N` you already wrote
  in a description or comment isn't updated, so it may now point at a
  different card or none. Undo history from before the update is cleared
  once; the activity log is kept. Thanks to @Nokama0 for building this
  ([#2](https://github.com/Jigglyy/kanbini/pull/2)).
- MCP / HTTP: looking a card up by number needs its board (`boardId`).
  Without one, the error lists the boards that have that number. Cards
  now include `boardId` next to `number`.

### Fixed

- **"None" in a board's right-click menu now clears all of its colour.**
  If the board's colour came from Background…, picking None did nothing.
  None now removes the colour and any colour or gradient background, so
  the board goes back to plain. A picture background stays (remove it
  from Background…). Ctrl+Z brings the colour back.

## [0.10.2] - 2026-10-25

### Fixed

- **The Delete button no longer hides off the screen.** On a smaller
  screen, the right-click menu for a board could put its Delete button
  below the bottom of the screen, with no way to scroll to it. Menus now always stay inside the window and
  scroll when the window is too short for them, and the delete
  confirmation scrolls itself into view. The same fix covers the list
  menu. Thanks to @devmdxb for reporting it
  ([#1](https://github.com/Jigglyy/kanbini/issues/1)).
- The board zoom slider now has 100% right in the middle, under its
  "100%" label, with 50% and 200% at the ends. Before, the middle of the
  slider was 125%. The arrow keys move it in steps of 5%.

## [0.10.1] - 2026-10-10

### Changed

- **The installer is back.** Each release has both versions again:
  `Kanbini Setup` installs Kanbini with a Start menu entry and an
  uninstaller, and the portable .zip runs from any folder without
  installing anything. 0.10.0 shipped only the portable one. Both use
  the same boards.
- **"Remove my data when uninstalling" is back** in Settings, Backup &
  restore, in the installed version (the portable version has nothing
  to uninstall, so it doesn't show it).

## [0.10.0] - 2026-10-10

### Added

- **Agenda on the home screen.** See what's overdue, what's due today,
  what's coming up in the next week, and what you finished recently,
  across all your boards at once. Tick a card off right from the agenda,
  or click it to open the card on its board. The agenda folds down to a
  one-line summary if you'd rather keep it small.
- **Your AI can read the agenda too,** so asking it "what should I work
  on today?" or "what did I get done this week?" works in one step.
- **Claude Code plugin.** Install it with `/plugin marketplace add
  Jigglyy/kanbini` and `/plugin install kanbini@kanbini`. You get
  `/kanbini:agenda`, `/kanbini:new-card`, and `/kanbini:log`, which writes
  up what you just did in a session as a finished card. There's no token
  or path to set up: it uses the Kanbini you installed, once you've
  opened it.
- **Due date shortcuts.** The card menu's due date now has one-click
  Today, Tomorrow, End of week, Next week, and End of month. Choose which
  day your week starts on under Settings, Cards (it follows your system
  by default). Cards due soon say "Today", "Tomorrow", or "Yesterday"
  instead of a date.
- **Start on a specific board.** Settings, Startup has a new "A specific
  board" choice: pick one and Kanbini opens straight into it every time,
  whichever board you used last.
- **Hide completed cards.** A new eye button in a board's header (beside
  the zoom) hides the cards you've finished on that board and shows how
  many there are. Each board remembers its own choice.
- **Repeating cards.** Right-click a card and pick how often it repeats:
  daily, weekly, every two weeks, monthly, yearly, or your own "every N
  days, weeks, months or years". When you complete it, the next one
  appears in the same list, due one repeat later, with the same labels,
  priority, and checklist (unticked). If you drop it into a list that
  completes cards automatically, the next one goes back to the list it
  came from. Undo takes back both at once. Your AI can set repeats too.
- **Cards can wait on other cards.** Open a card and, under "Waiting
  on", add the card that has to be done first. It can be on any board.
  The waiting card shows "Blocked" until that card is done, and the
  agenda marks it too. The other card lists what's waiting on it, and a
  click on either takes you there. Your AI can add and remove these
  links as well.
- **Ready-made prompts for your AI:** "Plan my day" and "Log work as a
  card" show up in AI apps that list prompts, such as Claude Desktop.
- **Card numbers.** Every card now has a short number, like #142, in its
  bottom-right corner, so you can refer to a card without its title.
  Type #142 in search (Ctrl+F) to jump straight to it, or ask your AI to
  "move #142 to Done". Open a card and click its number to copy it.
  Numbers are never reused, and a card keeps its number when you move
  it to another board. Prefer clean cards? Turn off Settings, Cards,
  "Show card numbers" (an open card still shows its number).

### Changed

- **Kanbini is now a portable app instead of an installer.** Download
  the .zip, extract it anywhere, and run Kanbini.exe. It opens in under
  a second; the old single-file portable .exe spent about five seconds
  unpacking itself every time you opened it. Nothing is installed and
  nothing goes in the registry, and your boards stay right where they
  were. If you installed an earlier version, you can uninstall it from
  Windows Settings, Apps: your boards are kept, and the portable app
  uses the same ones. With no uninstaller anymore, the "Remove my data
  when uninstalling" setting is gone.

### Fixed

- A card due today no longer turns red as soon as the day starts. It
  only counts as overdue once its due day is over.
- Switching between Settings pages no longer nudges the whole page
  sideways when one of them is long enough to scroll.

## [0.9.0] - 2026-09-25

### Added

- **Collapse a card.** Hover a card and click the new arrows next to the
  pencil, choose "Collapse card" from its right-click menu, or press `m`.
  A collapsed card hides its cover and checklist items and shows a short
  summary instead: checklist progress, comments, and attachments. Click
  again to expand it.
- **Compact lists.** In a list's menu, set Cards to Compact and every
  card in it collapses. You can still keep a single card open.
- **Show only the first few cards of a list.** A list's menu can show at
  most 10, 20, or 50 cards, with a "Show more" button at the bottom.
  Hidden cards are never lost: search still finds them, and moving to one
  with the keyboard or adding a card opens the list back up.
- **Your AI can do all of this too:** collapse cards, make a list
  compact, and set how many cards a list shows.

### Changed

- **Each list now scrolls on its own.** A long list gets its own scroll
  bar and stays within the window, so the rest of the board stays in
  view. To go back to lists that run the full length of the board, turn
  off "Scroll each list on its own" under Settings, Cards.

## [0.8.0] - 2026-09-25

### Added

- **Your AI can now manage much more of a board.** New AI integration
  tools cover:
  - **Labels:** create, rename, recolour, and delete them.
  - **List settings:** set or clear a work-in-progress limit, change the
    sort order, set the colour, and set a rule that completes or reopens
    cards moved in. Lists can also be reordered.
  - **Board settings:** rename, recolour, and favourite a board.
  - **Archiving:** archive or restore cards, lists, and boards, and see
    what a board has archived.
  - **Attachments:** attach a file from your computer or content the AI
    writes itself, and delete attachments.

  Colours can be given by name ("blue", "teal", ...) and land on the same
  swatches the app's colour pickers show.

### Changed

- **Archived cards are now hidden from the board.** Before, a card
  marked archived still showed on the board even though search and the
  home screen counts left it out. Nothing in the app could archive a card
  yet, so no existing card changes. The app has no screen for archived
  cards or lists yet; ask your AI to list or restore them.
- **Deleting an attachment through the AI integration now deletes the
  file too,** the same as deleting one in the app. It used to leave the
  file behind for the cleanup sweep.

### Fixed

- **A card can no longer be given a label from a different board.** The
  app never offered one, but the AI integration accepted it, and the
  label would then never show on the card.

## [0.7.2] - 2026-09-21

### Fixed

- **AI integration works in the installed app.** The MCP server shipped
  in 0.7.1 could not start: it was built expecting two libraries that
  were not installed alongside it, so it quit before your AI could
  connect, and clients reported only a bare "connection closed". The
  server is now fully self-contained.
- **Connecting your AI no longer requires installing Node.js.** The
  configuration snippet assumed you already had Node.js on your system.
  It now points at the runtime built into Kanbini itself, so it works on
  a clean machine.

After updating, open Settings, go to AI integration, and copy the
snippet again - both fixes change what it contains.

## [0.7.1] - 2026-06-22

### Fixed

- **Dragging no longer snaps back on drop.** Moving a card within a list
  (one with more than one card) or reordering a list column used to glide
  to the drop spot, jump back to where it started, then snap into place.
  Both now land smoothly where you drop them.
- **Clicking a card to open it no longer leaves it looking selected.** A
  plain click opens the card without the selection outline; only
  Ctrl/Cmd-click (or Shift-click for a range) selects cards, shown by the
  outline plus a corner checkmark. Keyboard navigation still shows its
  focus outline as before.

## [0.7.0] - 2026-06-21

### Added

- **Paste an image to attach it.** With a card open, Ctrl/Cmd+V pastes an
  image from your clipboard (a screenshot, a copied picture) straight onto
  the card as an attachment. A plain text paste still goes to the title or
  description as before.
- **Cards show a marker when they have a description.** A small icon leads
  a card's badges in the list once it has a description, so you can tell at
  a glance which cards have notes. Cards without one look unchanged.
- **Linux build.** Kanbini can now be packaged as a Linux **AppImage** (one
  self-contained binary, no install step), built from a Linux host. See
  [`docs/PACKAGING.md`](docs/PACKAGING.md).

### Fixed

- **Editing a description no longer spams the card's history.** The
  description still saves as you type (nothing is lost), but a continuous
  edit now records a single entry in the activity log instead of one per
  pause.
- **Renaming a card with Enter records the change once.** Pressing Enter to
  finalize a new title no longer updates the card twice.

## [0.6.0] - 2026-06-19

### Added

- **Drive your board from your own scripts.** The local 127.0.0.1 channel
  that powers the AI integration now also speaks a plain HTTP API: read
  routes for boards, cards, and search, write routes for any change, and
  a batch route that applies many edits at once as a single undo step.
  Same machine-only access and token as before. It's for non-AI tooling,
  automation, and a future mobile companion; the MCP server is unchanged
  and still the way an assistant talks to Kanbini.

### Changed

- **Picking up a card or list is smoother.** It now eases off the spot
  you grabbed instead of snapping to the cursor the instant you start
  moving.
- **Dropping a card into a list grows the list smoothly** instead of
  jumping a card-height in one frame.
- **Dragging a card across several lists no longer churns.** Lists you
  only sweep past stay put instead of flickering open and closed, so a
  long drag across the board stays smooth.

### Fixed

- **Putting the first card back no longer snaps.** Dragging the top card
  of a list and dropping it back where it started no longer makes the
  card below it jump into place.
- **Empty lists no longer flash solid while you drag over them.** An
  empty column now shows a subtle ring as the drop target and keeps your
  board background showing through, instead of filling in opaque.

## [0.5.1] - 2026-06-17

### Changed

- **Reordering a list is now a real drag.** Grab a list anywhere on its
  header and drag the whole column (cards and all) to its new spot, the
  same way you drag a card. The right-click "Move left / right" stays as
  a fallback.

### Fixed

- **Dropping a list now lands where you aim.** Dropping right after a
  list that has cards no longer overshoots past the list beyond it.
- **The dragged list looks like itself.** While dragging, the floating
  column no longer darkens its background, expands its cards to show the
  complete-checkbox, or trails a shadow over empty space below the cards.

## [0.5.0] - 2026-06-17

### Added

- **Reorder lists.** Drag a list by the grip in its header to move it
  left or right, or use "Move left / right" in the list menu. The new
  order is undoable with Ctrl+Z and syncs live to the MCP server and any
  other open window, like every other edit.

## [0.4.0] - 2026-06-11

### Added

- **The window remembers its size and position.** Kanbini reopens at the
  same place (and maximized if you left it maximized) instead of a fixed
  default every launch.
- **Bulk actions undo in one step.** Completing, labelling, moving, or
  deleting several selected cards at once - and dragging a multi-card
  selection - is now a single Ctrl+Z instead of one undo per card.
- **AI can build a board from scratch.** The Kanbini MCP server gained a
  "create list" tool and can set a card's priority when creating it, so
  an assistant can go from an empty board to populated columns on its own.

### Changed

- **Launching Kanbini again focuses the existing window** instead of
  opening a second copy that fights the first over the same data.
- **Obsidian push cleans up after itself.** Renaming or deleting a card
  no longer leaves a stale note behind in the vault, and archived boards
  are skipped. Files Kanbini doesn't own are still never touched.
- **Big boards open faster, and quitting backs up faster.** Board loading
  no longer slows down as a board grows, and the on-quit backup reuses
  unchanged attachment files instead of re-copying them every time.
- Orphaned attachment and background files left behind by deletes are
  swept up in the background after launch.

### Fixed

- **Dragging cards is smooth again.** Moving a card above or below others
  no longer stutters, and dragging vigorously no longer crashes the
  board.
- **Clicking a card focuses it** so the keyboard shortcuts (open, complete,
  move, delete) act on the card you just clicked without an extra key
  press first.
- **Search treats `%` and `_` literally** - searching "100%" finds "100%",
  not everything starting with "100".
- **Settings apply everywhere instantly.** Turning on link previews (or
  auto-cover) from the cover dialog now takes effect immediately instead
  of after a reopen.

### Security

- **Hardened the opt-in link-preview fetch against SSRF.** Closed an
  address-parsing gap that could reach loopback/LAN/cloud-metadata via an
  IPv6-mapped address, and pinned the checked DNS result so a rebinding
  domain can't slip a private address past the guard.
- **Restoring from a backup refuses unsafe file paths.** A tampered or
  corrupted export can no longer write files outside Kanbini's own data
  folder.

## [0.3.1] - 2026-06-08

### Fixed

- **Dragging a card into the middle of a sorted list** no longer snaps
  back instead of moving. Moving a card into a list with an active sort
  now appends a valid position rather than trying to order it between the
  two displayed neighbours, whose stored keys can be in reverse order (a
  sorted list shows cards in a different order than they are stored),
  which made the move fail server-side.

## [0.3.0] - 2026-06-06

### Added

- **More ways to sort a list.** The list menu's "Sort cards" now offers,
  besides Manual and the existing created-date order: **Added to list**
  (newest or oldest first, by when a card entered that list), **Due date**
  (soonest first), **Priority** (highest first), and **Alphabetical**
  (A to Z / Z to A). The list header shows a small chip for the active
  sort.

### Fixed

- **List menu layout.** The "Sort cards" and "On card enter" rows line up
  evenly, and the card-limit field is now full width with room only for
  the Set button.

## [0.2.0] - 2026-06-04

### Added

- **Multi-select cards with bulk actions.** Ctrl/Cmd-click cards (or
  Shift-click for a range within a list) to pick several at once, then
  complete, set priority, re-label, move, or delete them together from a
  floating action bar or a right-click menu. Dragging any card in the
  selection now moves the whole group between lists.

### Fixed

- **Label filter chips** reorder live as you drag them and no longer let
  wider neighbours overlap the "New label" button mid-drag; the chip
  styling was refreshed to read more clearly.
- **Scrollbars** are now visible against any board background (the thumb
  was hard to see on some wallpapers and colours).
- **Card hover growth** no longer jumps the board: a card that expands
  while scrolled off the top of the list keeps the visible area steady
  instead of nudging it.
- **MCP control channel** retries a request when its keep-alive socket
  has gone stale, fixing intermittent failures after the app sat idle.

## [0.1.0] - 2026-05-31

First public release of Kanbini, a free and open-source (MIT), offline,
single-user desktop kanban app with a local MCP server.

### Added

- **Kanban core:** boards, lists, and cards with drag-and-drop reorder
  and cross-list move, labels and label filtering, due dates, priorities,
  per-list colours and card limits, and per-list on-enter automations.
- **Card depth:** WYSIWYG description (stored as Markdown), checklists,
  comments, local attachments, cover images, and a per-card activity log.
- **Swimlanes** (group a board by priority).
- **Cross-board search** via a Ctrl/Cmd+F command palette.
- **Board and list templates.**
- **Undo / redo** with full snapshot restore on delete.
- **Customizable keyboard shortcuts.**
- **Board backgrounds** (colour / gradient / image) and continuous zoom.
- **Local MCP server** (token-gated 127.0.0.1 control channel + stdio
  bundle) with read and write tools; AI edits stream into the open UI
  live, with a headless read fallback when the app is closed.
- **Own your data:** lossless plain-text export/import (`kanbini.json` +
  `cards/*.md` + attachment files), with Backup and Restore in Settings.
- **Trello import** (bring an exported Trello board JSON in as a new
  board).
- **Opt-in integrations, off by default:** link previews and one-way
  push to an Obsidian vault.
- **Windows packaging:** NSIS installer and portable `.exe` (unsigned).

[0.3.1]: https://github.com/Jigglyy/kanbini/releases/tag/v0.3.1
[0.3.0]: https://github.com/Jigglyy/kanbini/releases/tag/v0.3.0
[0.2.0]: https://github.com/Jigglyy/kanbini/releases/tag/v0.2.0
[0.1.0]: https://github.com/Jigglyy/kanbini/releases/tag/v0.1.0
