# Web edition design decisions

Why the web edition of Kanbini is built the way it is. Each record says what
problem it solves, what was chosen, why that's the best option here, what
was turned down, and what it costs.

The ground rules behind every choice:

1. **Don't change the desktop sources.** Kanbini is under active development
   upstream. Every edit to its files is a merge conflict on every release, so
   the web edition adds files and changes the desktop UI only through guarded build
   steps.
2. **The smallest change that fully works.** Use what the app, Node or the
   browser already have, and add a dependency only when the job isn't a few
   lines.
3. **Never cut security or data safety**, even when that's the bigger change.

---

## 1. Run the desktop backend under Node with an Electron stand-in

**Problem.** Kanbini is an Electron app. Its backend (the "main process")
owns the SQLite database and answers the UI over Electron IPC. A website
needs that backend without Electron.

**Decision.** `server.ts` runs the unchanged main process under plain Node.
The build points its `import 'electron'` at `electron-shim.ts`, which
provides only what main uses:
- IPC handlers become HTTP routes;
- native file dialogs return the file the browser uploaded with the request;
- window messages go to every open tab as server-sent events;
- the tray, menus and window are inert.

**Why this is best.** All of Kanbini's backend runs as shipped: migrations,
undo, backups, exports, link previews and the MCP control channel. An
upstream release merges without conflicts.

**Turned down.**
- **Rewriting the backend as a web server:** thousands of lines duplicated,
  and they would drift from upstream.
- **Refactoring upstream's main into a shared module:** a conflict on every
  release.
- **Running real Electron in a remote desktop (noVNC):** a heavy image and a
  poor experience in the browser.

**Cost.** The shim must track the Electron calls main makes. A call it
doesn't provide fails at the first request that uses it, which is easy to
spot.

## 2. The browser bridge

**Problem.** The UI talks to `window.kanbini`, a bridge Electron injects.

**Decision.** `bridge.ts` provides the same API in the browser:
- calls go over `fetch`, and live updates over `EventSource`;
- native dialogs become file pickers;
- clipboard images come from the paste event (no clipboard permission
  prompt);
- exports become downloads.

**Why this is best.** The UI needs no changes at all, and the API surface
is the same typed list as upstream's preload script.

## 3. Change the desktop UI only through guarded build-time swaps

**Problem.** A few parts of the UI make no sense in a browser:
- the tray and window settings;
- server folder paths;
- the "No accounts" claims;
- the Settings → MCP instructions;
- the place for the account menu.

**Decision.** `WEB_SWAPS` in `vite.config.ts` lists exact text replacements
per file, applied only in the web build. Each must find its target, or the
build stops with a message naming the file.

**Why this is best.** Upstream files stay untouched, and an upstream
rewording can't silently leave desktop-only text in place: the build fails
loudly instead.

**Turned down.**
- **Editing the renderer files:** merge conflicts.
- **Patching the page at runtime (DOM edits):** fragile, invisible when it
  breaks, and it fights React.

**Cost.** When upstream rewords one of these spots, someone updates the swap.
The build says exactly which one.

## 4. Node 22 at runtime, pnpm for the build

**Problem.** The server needs a runtime that loads the app's native SQLite driver.

**Decision.** The container runs Node 22. The build uses the repo's pnpm
lockfile, installed hoisted (`--config.node-linker=hoisted`) so the runtime
stage can copy the SQLite binding from the root `node_modules`. The repo
itself stays on pnpm's isolated layout (`pnpm-workspace.yaml`), which is what
the desktop packaging is tested with.

**Why.** better-sqlite3, the database driver, is a native add-on that Bun
refuses to load ("not yet supported in Bun"; tested). The pnpm lockfile is
the project's source of truth. Tests use vitest, like the rest of the repo.

## 5. One gateway, one app process per set of boards

**Problem.** Many accounts, each with private boards, on one server. Kanbini
has a single database with no idea of an owner.

**Decision.** `gateway.ts` is the front door. It handles accounts, sign-in,
workspaces, admin and MCP, and starts one copy of the app per set of boards
(an account's own, or a workspace) on its own data folder. Each copy listens
only on a socket inside that folder, and the gateway forwards each signed-in
request to the right one.

**Why this is best.** It splits data per owner without touching Kanbini's
database code. Backups, undo and exports work per set of boards, and members
of a workspace share one process, so their live updates come for free.

**Turned down.**
- **One shared database with an owner on every row:** a rewrite of
  upstream's data layer.
- **A Docker container per account:** the app would need the Docker socket,
  which is root on the host.

**Cost.** About 100 MB of memory per active set of boards. App processes run
until a restart (marked `shortcut:` in the code); stopping idle ones is the
next step if accounts grow.

## 6. Share by workspace, not by board

**Problem.** People want to work on the same board together.

**Decision.** Workspaces: shared sets of boards that members open together.
Your own boards stay private. To bring an existing board in, export it and
import it.

**Why this is best.** It follows from decision 5: one database per set of
boards. Per-board sharing would need upstream's database rewritten.

**Cost.**
- No per-board permissions.
- Edits don't record which person made them.
- Undo works per board, not per person.

## 6a. Roles: Viewer, Editor, Manager

**Problem.** Members could all do everything, and inviting meant opening each
workspace in turn.

**Decision.**
- **Three roles per workspace** besides the owner: Viewer (read), Editor
  (change boards) and Manager (also invite and remove people).
- **One share form** sets a person's role (or "No access") in every
  workspace you own or manage. It creates invitations for new people and
  changes roles for existing members.

**Viewers are read-only on the server:**
- **App calls:** the gateway refuses every API call that isn't on a short
  read list.
- **MCP:** the bridge answers every MCP tool call that isn't one of the
  seven read tools with an error, before it reaches the MCP server.
- **Allowlists:** both lists name only what's allowed, so a new upstream
  feature stays blocked for viewers until it's reviewed.
- **Role changes:** checked on each request, so they apply at once.

**Why this is best.** The role travels with membership (already checked on
every request), so it adds one check in two places and no new upstream
code. Existing members default to Editor, which is exactly what they could
do, so no migration is needed.

**Turned down.** Hiding edit controls in the UI: that needs upstream
changes, and alone it isn't security.

**Cost.** A viewer still sees the app's edit buttons, and trying one shows
"You can only view this workspace". Hiding them would mean changing
upstream files.

## 6b. Renaming, handing over and deleting workspaces

**Decision.**
- **Rename:** owner and managers.
- **Hand over:** owner only, to an existing member. The old owner becomes a
  manager.
- **Delete:** owner only, behind a "Sure" tick box.
  - It comes off the list at once, and everyone's open streams and MCP
    sessions for it close.
  - Its app then stops, so the last export and backup are written.
  - Its folder moves to `/data/deleted/` instead of being erased.
- **Owners can't leave:** they hand over or delete instead.
- **An owner's account removed by the admin:** the member with the highest
  role (manager, then editor, then viewer) takes over, so a viewer never
  outranks an editor or manager.

**Why this is best.** Moving the folder makes a mistaken delete recoverable
at no cost. Stopping the app first means the kept copy is complete. Handing
over explicitly replaces the old rule (whoever was first in line inherited
the workspace), which could have given a workspace to the wrong person.

**Cost.** Bringing a deleted workspace back is a manual job for the admin
(move the folder back, re-add the entry), and deleted folders stay on disk
until someone removes them.

## 7. Accounts and sign-in

**Decision.**
- **Storage:** accounts live in `/data/accounts.json`, readable only by the
  app. Passwords are hashed with scrypt from Node's standard library.
- **2FA is optional TOTP**, written against RFC 6238 (`totp.ts`, tested
  with the RFC's own test codes).
- **Sign-in is two steps:** a plain user-name-and-password form, then a
  separate code page only for accounts with 2FA.
- **Sessions:** a random 256-bit cookie, saved to `/data/sessions.json`
  under a hash of the cookie. "Remember me" sets 30 days. Without it, the
  cookie lasts until the browser closes, and the server ends it after 12
  hours in any case, because browsers that restore tabs also restore such
  cookies.
- **Passwords are never remembered by the app.** The sign-in form is built
  for password managers (plain fields, autocomplete hints), and they do
  that job better and more safely than a server could.
- **Lockouts:** ten wrong tries in 15 minutes lock that account's sign-in.
  Ten wrong invite codes lock registration. A try counts as it starts, so
  tries sent all at once can't get past the limit.
- **Each 2FA code works once,** even across a restart: the last code's time
  step is saved with the account.
- **First run:** the first account becomes the admin, and set-up only
  answers direct LAN requests.

**Why these choices.**
- **No dependencies:** scrypt and TOTP are a few lines on top of
  `node:crypto`. An auth library (or "Better Auth") would bring tables,
  migrations and much more code for one form.
- **Two steps:** password managers (Proton Pass included) recognise a plain
  sign-in form. One form that mixed in a code field wasn't recognised.
- **Hashed session keys:** the file alone can't sign anyone in, and sessions
  survive updates.
- **"Remember me" off by default:** the safe choice on a shared computer
  costs one click on your own.
- **Lockout per account, not per IP:** the LAN port lets anyone fake
  forwarding headers, so an IP limit would be easy to dodge. The cost is
  that someone who knows a user name can lock that account out for 15
  minutes.
- **LAN-only first run:** until the admin exists, whoever reaches set-up
  first would own the server. Requests through NPM or Cloudflare carry
  forwarding headers and are refused.

## 8. Registration switch, invite code, and invitations

**Decision.**
- Registration is off by default; the admin turns it on.
- While it's on, registering needs an invite code the admin can replace.
- Workspace invitations wait until the invited person accepts or declines.

**Why.** An open sign-up on a public URL would hand anyone their own
storage and server processes. The code limits sign-up to people you gave it
to. Invitations need consent, so nobody gets added to a workspace against
their will.

## 9. MCP over HTTPS, bridged to the stock MCP server

**Decision.** `/mcp/<workspace id>` speaks MCP's Streamable HTTP transport.
For each client session the gateway starts the unchanged stdio MCP server
(`apps/mcp`) on that workspace's folder and relays messages both ways, using
the official SDK's two transports. Auth is a personal bearer token per
account, shown in Settings → MCP. Each account may have at most 5 sessions,
and an idle one stops after an hour.

**Why this is best.**
- All 42 Kanbini tools work as shipped, with no upstream changes.
- Bearer tokens work in Claude Code, Cursor, VS Code, and Claude Desktop
  through `mcp-remote`.
- JSON replies pass proxies more easily than event streams.

**Turned down.** An OAuth server, which only Claude.ai and ChatGPT
connectors need: much more code and more to secure.

**Cost.** One process per MCP session. That's why the cap exists: clients
that reconnect without ending their session no longer pile up processes.

## 10. Isolation with Node's permission model

**Problem.** Some Kanbini features take server file paths from the user:
- MCP "add attachment" reads any path;
- the Obsidian push writes to any folder.

On a desktop that's your own computer. On a shared server it exposed every
account's data.

**Decision.** Each app process (and each MCP server process) runs with:
- `--permission`;
- read access to its own folder and the app's code;
- write access to its own folder only;
- `--allow-addons`, for the SQLite driver.

Its socket and temp folder live in its own folder.

**Why this is best.**
- **Covers every path:** it closes every path-taking feature at once,
  including ones upstream adds later. Blocking features one by one would be
  whack-a-mole.
- **Built in:** it's part of Node 22, so there's nothing to install.
- **Tested in the real image:** SQLite works, and outside reads and writes
  fail with `ERR_ACCESS_DENIED`. The smoke test checks it on every build.

**Turned down.**
- **A system user per account:** needs root and user management in the
  container.
- **A container per account:** see decision 5.
- **Patching the upstream features:** conflicts, and misses future ones.

**Cost.** The SQLite driver, being native code, isn't itself limited. It
only opens the database file the app names, and users can't run SQL.

## 11. A tab stays on the workspace it opened

**Problem.** The open workspace was stored per sign-in. Switching workspace
in one tab sent another tab's edits somewhere else.

**Decision.**
- With each page, the gateway sets a small cookie naming the workspace.
- The bridge reads it once at load and prefixes every call with
  `/w/<workspace id>`.
- The gateway checks membership on each pinned call; if you were removed, it
  answers 410 and the tab reloads.
- File links carry no workspace, so the gateway serves each file from
  whichever of your workspaces holds it. File names contain a fresh id, so
  there's never a clash.

**Why this is best.** It fixes the problem without changing the UI's code:
only the bridge and the gateway know about it.

**Turned down.** Putting the workspace in every page URL: the UI builds its
file links itself, so that would mean editing upstream files.

## 12. Request size limits

**Decision.** 100 MB per uploaded file and 5 MB per other API call
(`limits.ts`). The gateway refuses a request that declares a bigger body
before forwarding it. The app counts the bytes of bodies that don't declare
a size.

**Why.** Cloudflare already caps uploads at 100 MB, but the LAN address
doesn't. Without a limit, one account could fill the disk, and a full disk
breaks every account's saves. Refusing at the front door means no partial
upload is ever stored, and the browser gets a clean "too large" instead of a
broken connection.

**Cost.** No per-account storage quota yet: many 100 MB uploads can still
add up.

## 13. Sign-in, Admin and Workspaces pages as server-rendered HTML in the app's style

**Decision.** `pages.ts` renders plain HTML forms that load the app's own
built stylesheet and use its classes. The gateway serves that stylesheet to
signed-out visitors too: it's open-source CSS with no user data. The pages
follow the theme each person picked in the app. The only script is the
app's one-line theme check, allowed by its hash in a strict CSP.

**Why this is best.** Real HTML forms work without JavaScript and suit
password managers. Reusing the app's stylesheet makes the pages look like
Kanbini without a second design system.

**Turned down.** Rebuilding these pages as a React app: more code and a
looser CSP, for pages that are mostly forms.

**Cost.** @shadcn/lint reads React, not HTML strings, so these pages are
checked by eye in the browser.

## 14. The account menu in the header, built from the app's components

**Decision.** A React component made from the app's own `Button` and
`Popover`. It's inserted right after the header's Settings button at build
time (a guarded swap). React is deduplicated so it shares the app's copy.

**Why.** It belongs where account menus usually are, styled like its
neighbours, and the linter can check it.

## 15. @shadcn/lint on Oxlint, scoped to apps/web

**Decision.** It runs in the Docker build, with six rules against the app's
components and theme. Linting stops at `apps/web`.

**Why.** It catches restyled components, raw colours and unknown classes in
the code the web edition owns. Upstream's files aren't linted: they aren't ours to
change.

## 16. Separate bundles for the gateway and the app

**Decision.** Two server builds, `gateway.cjs` and `server.cjs`.

**Why.** Built together, the bundler put shared helper code in the app's
file, and the gateway then ran the app's startup code. That made it open a
database and fail. Separate builds keep each bundle whole.

## 17. Deployment

**Decisions.**
- **Named volume.** All data lives in one Docker volume, `kanbini-data`, so
  there are no host-folder permission problems.
- **Port 8080 on the LAN.** It's published on the host's network so Nginx
  Proxy Manager, on another machine, can reach it.
- **Cloudflare Full (strict).** Proxied DNS and an origin certificate in
  NPM: settings, not code.
- **Timezone.** `TZ` comes from `.env`, so "due today" and daily backups
  follow local time.
- **Shutdown.** A 1-minute stop grace lets every app write its export and
  backup.
- **Proxy-friendly live updates.** The live-update stream sends
  `X-Accel-Buffering: no` so nginx doesn't hold it back, and a heartbeat
  every 25 seconds so Cloudflare doesn't drop idle connections.
- **Published image.** `.github/workflows/docker.yml` builds the image
  with the standard Docker actions and pushes it to ghcr.io on each `v*`
  tag, the same trigger as the desktop release, so users can pull instead
  of building. Pull requests only build it. It's amd64 only for now: arm64
  through QEMU is slow and untested.

---

## Known limits and next steps

- **No password reset or 2FA change in the app.** Today it means editing
  `/data/accounts.json`.
- **Nothing records who made a change.** Inside a workspace, comments and
  activity don't name the person, and undo works per board, not per person.
- **No per-account storage quota.**
- **App processes run until a restart.** Stopping idle ones would save
  memory if accounts grow.
- **Board exports pile up** in each folder's `downloads`; cleaning them up
  would help.
- **Invitations don't expire,** and nobody is notified outside the app.
