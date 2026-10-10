# Kanbini plugin for Claude Code

Work with your [Kanbini](https://github.com/Jigglyy/kanbini) boards from
Claude Code. Ask what's on your plate, add a card without leaving the
terminal, or log what you just built as a finished card. Changes show up
live in the Kanbini window, and you can undo any of them there with
Ctrl+Z.

Everything stays on your computer. The plugin talks to the Kanbini app
running on the same machine; there's no account, no token to paste, and
nothing is sent anywhere.

## What you need

- **Kanbini installed and opened at least once.** When it starts, Kanbini
  records how to run its built-in MCP server. The plugin uses that, so it
  always matches the version of Kanbini you have.
- **Node.js 18 or newer** on your PATH. The plugin's small launcher runs
  on it. (Kanbini's server itself runs inside the Kanbini app.)

## Install

In Claude Code:

```text
/plugin marketplace add Jigglyy/kanbini
/plugin install kanbini@kanbini
```

Then run `/mcp` or restart Claude Code, and the Kanbini tools are ready.

If you added Kanbini to Claude Code by hand before (a `kanbini` entry in
`.mcp.json` or `~/.claude.json`), remove it, or you'll see every tool
twice.

## What you get

| Command | What it does |
|---|---|
| `/kanbini:agenda [days]` | What's overdue, due today, coming up, and recently done, across all your boards |
| `/kanbini:new-card <text>` | Adds a card. Picks the board named in your text, your only board, or the one named after the current project folder, and asks if it can't tell |
| `/kanbini:log [board]` | Writes up the work done in this session as a completed card, with what changed, why, and any follow-ups |

You can also just ask, for example "what's overdue on my Kanbini boards?"
or "move the login card to Done". The plugin includes a skill that
teaches Claude how Kanbini works (find cards by id, move instead of
recreating, archive rather than delete, and so on), and the full set of
Kanbini tools: boards, lists, cards, labels, checklists, comments,
attachments, search, and the agenda.

## When Kanbini is closed

Reading still works: answers come from the snapshot Kanbini saves when it
closes, and Claude will say that it's a snapshot. Making changes needs
the app open.

## Troubleshooting

- **"Kanbini hasn't registered its MCP server"**: open Kanbini once, then
  run `/mcp` and reconnect.
- **"Couldn't start Kanbini's MCP server"**: Kanbini's folder was moved,
  replaced by a newer version, or deleted since it last ran. Open
  Kanbini once from its new place, then reconnect.
- **"node" not found**: install Node.js 18+ from nodejs.org, or skip the
  plugin and paste the snippet from Kanbini's Settings, AI integration
  instead. That one needs no Node.js.

## License

MIT, same as Kanbini.
