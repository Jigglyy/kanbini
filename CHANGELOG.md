# Changelog

All notable changes to Kanbini are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor versions may still carry user-visible changes).

Releases are cut by pushing a `v*` tag, which builds the Windows
installers and publishes a GitHub Release (see
[`.github/workflows/release.yml`](.github/workflows/release.yml)).

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

[0.2.0]: https://github.com/Jigglyy/kanbini/releases/tag/v0.2.0
[0.1.0]: https://github.com/Jigglyy/kanbini/releases/tag/v0.1.0
