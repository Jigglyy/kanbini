# Kanbini web edition: in a browser, with Docker

`apps/web` runs the desktop app's own main process under Node, with a small
stand-in for Electron (`electron-shim.ts`), and serves the unchanged
renderer to any browser. The desktop sources are untouched, so upstream
releases merge in with `git fetch upstream && git merge upstream/main`.
If `pnpm-lock.yaml` conflicts, take upstream's and run `pnpm install`.

It has accounts. Each account has its own private boards, and people can
share boards through workspaces. `gateway.ts` handles sign-in, registration,
workspaces, the admin page and MCP. Each set of boards (an account's own,
or a workspace) runs in a separate copy of the app (`server.ts`) on its own
data folder. Each copy listens only on a socket in that folder and may read
or write no other files (Node's permission model), so every request goes
through the gateway and no account can reach another's data.

Why it's built this way, and what was turned down:
[DECISIONS.md](DECISIONS.md).

## Run

```sh
printf 'TZ=Europe/Berlin\nKANBINI_PORT=8080\n' > .env
docker compose up -d --build
```

`TZ` sets the clock for "due today" and the daily backup.

### From the published image

Each release (a `v*` tag) also publishes the image to
`ghcr.io/jigglyy/kanbini`, tagged with the version (for example `0.18.0`), the minor
version (`0.18`) and `latest`. To use it instead of building, replace
`build: .` in `docker-compose.yml` with:

```yaml
    image: ghcr.io/jigglyy/kanbini:latest
```

Then `docker compose pull && docker compose up -d`. A manual run of the
*Docker image* workflow publishes the branch name instead (e.g. `main`).
After the first publish, the maintainer may need to set the package's
visibility to public once (GitHub > Packages > kanbini > Package settings),
since new packages can start private.

## First account

Open `http://<host>:8080` on your network. The first account you create is
the admin. Pick a user name and a password (at least 10 characters).
2FA is optional: tick it, scan the QR code with an authenticator app
(Google Authenticator, 1Password, Bitwarden, Aegis...) or type in the key,
then enter the app's current code.

Until the first account exists, set-up only answers direct requests, not
ones through Nginx Proxy Manager or Cloudflare. That stops someone on the
internet from claiming it first, so do this step on the LAN address.

## Registration and the admin page

The admin opens **Admin** (the menu under their name, top right) to:

- **Turn registration on or off.** It starts off. While it's on, the sign-in
  page links to *Create an account*.
- **See the invite code.** Registering needs it, so share it with the people
  you want in. *New code* stops the old one working.
- **See the accounts** (user name, 2FA, data folder) and **remove** any but
  the admin. Removal signs the account out and stops its sign-in. Its data
  folder stays on disk. A workspace it owned passes to the member with the
  highest role (manager, then editor, then viewer).

New accounts choose a user name, a password and optional 2FA. Each starts
with its own empty set of boards.

## Workspaces: working together

Your own boards are private. To share boards, open **Workspaces** from the
menu under your name, at the right of the header next to Settings:

- **Create** a workspace. You become its owner and it opens.
- **Invite people** (one form for all your workspaces): type a user name and
  pick a role for each workspace you own or manage:
  - **Viewer** sees the boards.
  - **Editor** also changes them.
  - **Manager** also invites and removes people.
  - **No access** keeps them out.
- They get a badge on their name in the header and the invitation under
  Workspaces, where they **accept** or **decline**. They see nothing of a
  workspace until they accept. Members see its boards together, and changes
  show up live for everyone.
- **People** lists everyone you share with and their role in each
  workspace. **Change** lets you give them other roles, which apply at once,
  or set **No access** to take them out or cancel the invitation.
- Viewers can't change anything: the server refuses it, and their AI gets
  read-only MCP tools. The header shows **View only** for them.
- **Open** switches between your own boards and your workspaces. **Details**
  shows a workspace's members and what you can do with it:
  - **Rename** (owner or manager).
  - **Make someone else the owner** (owner; they become owner and you a
    manager).
  - **Delete** (owner).
  - **Leave** (everyone else).
- **Deleting** removes the workspace for everyone at once. Its folder is
  kept in `/data/deleted/<id>-<time>`. To bring it back, move that folder to
  `/data/workspaces/<id>` and add the workspace to `accounts.json` again
  (ask whoever runs the server).

Sharing works per workspace, not per board: Kanbini keeps one database per
set of boards. To bring an existing board in, export it from your own
boards and import it in the workspace (boards home > Import board).

Each browser tab stays on the workspace it opened, even if you switch
workspace in another tab. A tab on a workspace you were removed from reloads
onto your own boards.

## Signing in

- Sign in with your user name and password. Accounts with 2FA then get a
  second page that asks for the authenticator code. The two steps are
  separate forms so password managers recognise the sign-in form and fill it.
- **Remember me** keeps you signed in on that device for 30 days. Without
  it, you're signed out when the browser closes (12 hours at most). Either
  way, sessions survive restarts and updates. They're saved in
  `/data/sessions.json` under a hash of the cookie, so the file alone signs
  nobody in.
- Your browser or password manager remembers the password itself; the app
  never stores it.
- Each 2FA code works once.
- Ten wrong tries in 15 minutes lock that account's sign-in for 15 minutes.
  Ten wrong invite codes do the same for registration. A restart clears both.
- There's no password reset or 2FA change in the app yet.

## Update and check

Update: pull the new code, then `docker compose up -d --build`. The smoke
test creates its own accounts, so run it against a fresh container:

```sh
docker run --rm -d --name kanbini-smoke -p 18080:8080 kanbini-kanbini
node --experimental-strip-types apps/web/smoke.mjs http://<host>:18080; docker rm -f kanbini-smoke
```

## Lint

`apps/web` is linted with [@shadcn/lint](https://github.com/shadcn-ui/lint)
on Oxlint, against the app's own components (`apps/renderer/src/components/ui`)
and theme (`apps/renderer/src/index.css`). The rules in `.oxlintrc.json`
reject restyling a component, raw palette colors, arbitrary values, inline
styles, unknown classes and dynamic class strings. The Docker build runs it,
so a violation stops the build. Run it yourself with
`pnpm --filter @kanbini/web run lint`.

It checks React components, so it covers the account menu
(`account-menu.tsx`). The sign-in, register, admin and workspaces pages
are plain HTML from `pages.ts`, which it can't read.

## Data

Everything lives in the `kanbini-data` volume (`/data` in the container):

- `accounts.json` holds the accounts, the registration switch and the invite
  code. Passwords are stored as scrypt hashes. Only the app can read it.
- `sessions.json` holds the signed-in sessions (hashed), readable only by
  the app.
- `users/<id>/` holds one account's own boards, and `workspaces/<id>/` one
  workspace's. Each has the SQLite file, attachments, a plain-text export
  written on every `docker stop`, daily backups (last 7 days) that
  Settings > Backup & restore can restore, and the app's socket and temp
  folder.

Uploads are limited to 100 MB per file and other requests to 5 MB, so one
account can't fill the disk. Larger ones get "too large" (413).

To copy everything out: `docker cp kanbini:/data ./kanbini-data-copy`.

## Behind Nginx Proxy Manager and Cloudflare (Full strict)

1. **Cloudflare DNS:** a proxied (orange cloud) record for your hostname,
   pointing at the public IP of the machine running NPM.
2. **Cloudflare SSL/TLS:** encryption mode **Full (strict)**. Under
   SSL/TLS > Origin Server, create an Origin Certificate for the hostname
   and keep the certificate and private key.
3. **NPM > SSL Certificates > Add > Custom:** upload that certificate and
   key. Let's Encrypt with the Cloudflare DNS challenge also works.
4. **NPM > Proxy Hosts > Add:** your hostname, scheme `http`, forward
   host `<docker host IP>`, port `8080`. On the SSL tab pick the
   certificate, and turn on Force SSL and HTTP/2.

No custom nginx config is needed. Live updates use server-sent events; the
server sends `X-Accel-Buffering: no` so nginx doesn't buffer them, and a
heartbeat every 25 s so Cloudflare doesn't drop idle connections.
Cloudflare limits uploads to 100 MB per file on the Free and Pro plans.

Optional: put a Cloudflare Access policy on the hostname for a second
sign-in in front of Kanbini's own.

## AI tools (MCP)

MCP works over HTTPS through the proxy, one endpoint per workspace:
`https://<your domain>/mcp/<workspace id>`. Each account has a personal
token. **Settings > MCP** shows the endpoint for the workspace you have
open, your token, a JSON snippet and a ready `claude mcp add` command.

- **Claude Code:** run the command from Settings > MCP, or save the
  snippet as `.mcp.json` in your project.
- **Cursor and others** that take a URL plus headers: use the snippet.
- **Claude Desktop:** add it through the `mcp-remote` helper:
  `{ "command": "npx", "args": ["mcp-remote", "<endpoint>", "--header", "Authorization: Bearer <token>"] }`.
- **Claude.ai and ChatGPT connectors** need OAuth sign-in, which isn't built.

The token works for every workspace you're in, and stops working when your
account is removed. Changes an AI makes show up live in open browser tabs.
Each account can have 5 MCP sessions at once; a new one closes the oldest,
and an idle one stops after an hour.

The stdio server still works from the Docker host:
`docker exec -i -e KANBINI_USERDATA_OVERRIDE=/data/users/<id> kanbini node apps/mcp/dist/index.js`.

## What differs from the desktop app

- File pickers are the browser's; board exports download as files.
- Attachments download from their name, or from the Download button on the
  row. The desktop app has neither: its files sit in a folder on your
  computer.
- Paste an image onto an open card with Ctrl/Cmd+V as usual.
- Hidden because they need a desktop or server folders nobody can open:
  - Settings: Window (tray), Obsidian, Export now, Restore from folder,
    Data location;
  - About: Runtime and Third-party software.

  Restore a dated backup from Settings > Backup & restore instead.
- The welcome dialog, About and the backup list describe the shared server
  rather than a desktop app. All these changes are listed in `WEB_SWAPS` in
  `swaps.ts`, and the build (and `pnpm test`) stops if upstream changes one of them.
- Theme, shortcuts and other preferences are kept per browser.
