// The gateway's own pages: sign-in, the 2FA step, registration, workspaces
// and admin. They wear the app's own look: they load its built stylesheet
// (theme tokens, light and dark) and use its classes, with the logo above.
// No scripts beyond the app's first-paint theme line; the optional 2FA
// panel opens with CSS alone.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { renderSVG } from 'uqr'
import logo from '../renderer/src/assets/logo.png?inline'
import { MIN_PASSWORD, type Role, ROLES, roleOf, type Space, type User, userDir, validSecret, type Workspace } from './accounts'
import { base32Encode } from './totp'

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The app's built stylesheet. The gateway serves it to signed-out visitors too. */
export const appCss = (() => {
  try {
    const html = readFileSync(join(__dirname, '../web/index.html'), 'utf8')
    const href = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1]
    return href ? { href, body: readFileSync(join(__dirname, '../web', href)) } : undefined
  } catch {
    return undefined // no web build (local runs): the pages fall back to the browser's defaults
  }
})()

// The app's index.html runs this before paint, so these pages follow the
// theme each person picked inside Kanbini (stored in this browser). The last
// line also draws native controls (checkboxes) in that theme, not the OS's.
const THEME_SCRIPT =
  "try{var t=JSON.parse(localStorage.getItem('kanbini.settings')||'{}').theme||'system';" +
  "document.documentElement.dataset.theme=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'}" +
  "catch(e){document.documentElement.dataset.theme='dark'}" +
  "document.documentElement.style.colorScheme=document.documentElement.dataset.theme"
const AUTH_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; " +
  `script-src 'sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}'; ` +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

// The app's control classes (components/ui/button.tsx, its text inputs).
const INPUT =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground caret-primary placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const CODE_INPUT =
  'h-12 w-full rounded-md border border-input bg-background px-3 text-center text-xl font-medium tracking-widest tabular-nums text-foreground caret-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const PRIMARY =
  'inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card'
const LINK =
  'rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const BUTTON =
  'inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
// Beside a text input (h-10), so the two line up.
const BUTTON_TALL = BUTTON.replace('h-9', 'h-10')
const SECONDARY =
  'inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const SECONDARY_TALL = SECONDARY.replace('h-9', 'h-10')
const DANGER =
  'inline-flex h-9 items-center justify-center rounded-md border border-danger/40 px-4 text-sm font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const SUBHEADING = 'text-sm font-semibold'
const HINT = 'text-xs text-muted-foreground'
const LIST = 'divide-y divide-border rounded-md border border-border'
const ROW = 'flex flex-wrap items-center justify-between gap-3 px-4 py-3'
// A destructive button that only works once "Sure" is ticked (no scripts, no dialog).
const confirmed = (button: string) =>
  `<label class="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" required class="size-4 accent-primary"> Sure</label>${button}`

// lucide "circle-alert", the app's icon set.
const ALERT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 size-4 shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>'
const errorBox = (error = '') =>
  error
    ? `<div role="alert" class="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm text-danger">${ALERT_ICON}<p>${esc(error)}</p></div>`
    : ''

const heading = (title: string, intro = '') =>
  `<div class="grid gap-1.5"><h1 class="text-lg font-semibold tracking-tight">${title}</h1>${
    intro ? `<p class="text-sm text-muted-foreground">${intro}</p>` : ''
  }</div>`

// One labelled field. Explicit types, ids and autocomplete tokens let
// password managers tell the user name, password and code fields apart.
const field = (id: string, label: string, input: string, hint = '') =>
  `<div class="grid gap-2"><label for="${id}" class="text-sm font-medium">${label}</label>${input}${
    hint ? `<p id="${id}-hint" class="text-xs text-muted-foreground">${hint}</p>` : ''
  }</div>`
const codeInput = (cls: string, attrs = '') =>
  `<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" class="${cls}"${attrs}>`
const aside = (text: string, href: string, action: string) =>
  `<p class="text-sm text-muted-foreground">${text} <a href="${href}" class="${LINK}">${action}</a></p>`

function authPage(res: ServerResponse, status: number, title: string, card: string, below = '', wide = false): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': AUTH_CSP, 'cache-control': 'no-store' })
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${title} · Kanbini</title>
<script>${THEME_SCRIPT}</script>
${appCss ? `<link rel="stylesheet" href="${appCss.href}">` : ''}
<link rel="icon" type="image/png" href="${logo}">
</head>
<body class="bg-background font-sans text-foreground antialiased selection:bg-primary/30">
<main class="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
  <div class="flex items-center gap-2.5">
    <img src="${logo}" alt="" width="36" height="36" class="size-9">
    <span class="text-xl font-semibold tracking-tight">Kanbini</span>
  </div>
  <section class="w-full ${wide ? 'max-w-3xl' : 'max-w-sm'} rounded-lg border border-border bg-card p-6 shadow-sm sm:p-8">${card}</section>
  ${below}
</main>
</body>
</html>`)
}

export function login(
  res: ServerResponse,
  status: number,
  opts: { open: boolean; error?: string; username?: string; remember?: boolean }
): void {
  authPage(
    res,
    status,
    'Sign in',
    `<form id="login" method="post" action="/login" class="grid gap-5">
    ${heading('Sign in')}
    ${errorBox(opts.error)}
    ${field('username', 'User name', `<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(opts.username ?? '')}" class="${INPUT}" required${opts.username ? '' : ' autofocus'}>`)}
    ${field('password', 'Password', `<input id="password" name="password" type="password" autocomplete="current-password" class="${INPUT}" required${opts.username ? ' autofocus' : ''}>`)}
    <label for="remember" class="flex cursor-pointer items-start gap-3">
      <input type="checkbox" id="remember" name="remember" value="1" class="mt-0.5 size-4 shrink-0 accent-primary"${opts.remember ? ' checked' : ''}>
      <span class="grid gap-0.5">
        <span class="text-sm font-medium">Remember me</span>
        <span class="text-xs text-muted-foreground">Stay signed in on this device for 30 days. Leave it off on a shared computer.</span>
      </span>
    </label>
    <button type="submit" class="${PRIMARY}">Sign in</button>
  </form>`,
    opts.open ? aside('New here?', '/register', 'Create an account') : ''
  )
}

/** Sign-in step 2, only for accounts with 2FA. */
export function loginCode(res: ServerResponse, status: number, error = ''): void {
  authPage(
    res,
    status,
    'Two-factor code',
    `<form id="login-code" method="post" action="/login/code" class="grid gap-5">
    ${heading('Two-factor code', 'Open your authenticator app and enter the 6&#8209;digit code for Kanbini.')}
    ${errorBox(error)}
    ${field('code', 'Code', codeInput(CODE_INPUT, ' required autofocus'))}
    <button type="submit" class="${PRIMARY}">Verify</button>
  </form>`,
    aside('Not you?', '/login', 'Use a different account')
  )
}

export function register(
  res: ServerResponse,
  status: number,
  opts: { first: boolean; error?: string; form?: URLSearchParams }
): void {
  const form = opts.form ?? new URLSearchParams()
  // Keep the key across a failed submit, so a code already scanned still works.
  const given = form.get('secret')
  const secret = validSecret(given) ? given : base32Encode(randomBytes(20))
  const link = `otpauth://totp/Kanbini?secret=${secret}&issuer=Kanbini`
  authPage(
    res,
    status,
    opts.first ? 'Set up' : 'Create an account',
    `<form id="register" method="post" action="/register" class="group grid gap-5">
    ${
      opts.first
        ? heading('Set up Kanbini', 'This first account is the admin. It turns registration on and off and manages accounts.')
        : heading('Create your account', 'You get your own private boards, and can join workspaces others share with you.')
    }
    ${errorBox(opts.error)}
    ${opts.first ? '' : field('invite', 'Invite code', `<input id="invite" name="invite" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(form.get('invite') ?? '')}" class="${INPUT}" aria-describedby="invite-hint" required>`, 'Ask the person who runs this Kanbini.')}
    ${field('username', 'User name', `<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9._\\-]{3,32}" maxlength="32" value="${esc(form.get('username') ?? '')}" class="${INPUT}" aria-describedby="username-hint" required${opts.first ? ' autofocus' : ''}>`, '3 to 32 letters, digits, dots, dashes or underscores.')}
    ${field('password', 'Password', `<input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" class="${INPUT}" aria-describedby="password-hint" required>`, `At least ${MIN_PASSWORD} characters.`)}
    ${field('confirm', 'Repeat password', `<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" class="${INPUT}" required>`)}
    <div class="rounded-md border border-border transition-colors has-[#twofa:checked]:border-primary/50">
      <label for="twofa" class="flex cursor-pointer items-start gap-3 rounded-md p-3 transition-colors hover:bg-muted/50">
        <input type="checkbox" name="twofa" id="twofa" value="1" class="mt-0.5 size-4 shrink-0 accent-primary"${form.get('twofa') ? ' checked' : ''}>
        <span class="grid gap-0.5">
          <span class="text-sm font-medium">Two-factor authentication</span>
          <span class="text-xs text-muted-foreground">Optional. Signing in will also ask for a code from an authenticator app.</span>
        </span>
      </label>
      <div class="hidden gap-4 border-t border-border p-4 group-has-[#twofa:checked]:grid">
        <p class="text-sm text-muted-foreground">Scan this with your authenticator app, or type in the key below it.</p>
        <figure class="justify-self-center rounded-md bg-white p-2" aria-label="QR code for your authenticator app">${renderSVG(link).replace('<svg ', '<svg class="size-36" ')}</figure>
        <div class="grid justify-items-center gap-1.5 text-center">
          <code class="select-all text-balance font-mono text-sm tracking-wide text-foreground">${secret.match(/.{1,4}/g)!.join(' ')}</code>
          <a href="${link}" class="${LINK} text-sm">Open in authenticator app</a>
        </div>
        ${field('code', 'Code from the app', codeInput(INPUT))}
      </div>
    </div>
    <input type="hidden" name="secret" value="${secret}">
    <button type="submit" class="${PRIMARY}">Create account</button>
  </form>`,
    opts.first ? '' : aside('Already have an account?', '/login', 'Sign in')
  )
}

export function closed(res: ServerResponse): void {
  authPage(
    res,
    403,
    'Registration closed',
    heading('Registration is closed', 'New accounts are turned off right now. Ask the person who runs this Kanbini to turn registration on.'),
    aside('Already have an account?', '/login', 'Sign in')
  )
}

export function setupBlocked(res: ServerResponse): void {
  authPage(
    res,
    403,
    'Set up',
    heading(
      'Finish set-up on your network',
      "Until the first account exists, set-up only opens on this server's own address on your network (for example http://10.0.0.5:8080), not through a proxy. That way nobody else can claim it first."
    )
  )
}

const backToBoards = `<a href="/" class="${LINK} text-sm">Back to boards</a>`

export function admin(res: ServerResponse, opts: { registration: boolean; inviteCode: string; users: User[] }): void {
  const date = (t: number) => new Date(t).toISOString().slice(0, 10)
  authPage(
    res,
    200,
    'Admin',
    `<div class="grid gap-6">
    ${heading('Admin', 'Who can join, and the accounts on this server.')}
    <div class="${LIST}">
      <form method="post" action="/admin" class="${ROW}">
        <div class="grid gap-0.5">
          <p class="text-sm font-medium">Registration is ${opts.registration ? 'on' : 'off'}</p>
          <p class="${HINT}">${opts.registration ? 'People with the invite code can create an account.' : 'Nobody can create an account.'}</p>
        </div>
        <button name="action" value="${opts.registration ? 'close' : 'open'}" class="${opts.registration ? SECONDARY : BUTTON}">Turn ${opts.registration ? 'off' : 'on'}</button>
      </form>
      <form method="post" action="/admin" class="${ROW}">
        <div class="grid gap-0.5">
          <p class="text-sm font-medium">Invite code</p>
          <code class="select-all font-mono text-sm tracking-wide">${esc(opts.inviteCode)}</code>
          <p class="${HINT}">Share it with the people you want in. A new code stops the old one working.</p>
        </div>
        <button name="action" value="invite" class="${SECONDARY}">New code</button>
      </form>
    </div>
    <div class="grid gap-3">
      <h2 class="${SUBHEADING}">Accounts</h2>
      <ul class="${LIST}">${opts.users
        .map(
          (u) => `
        <li class="${ROW}">
          <div class="grid min-w-0 gap-0.5">
            <p class="text-sm font-medium">${esc(u.username)}${u.admin ? ` <span class="${HINT}">admin</span>` : ''}</p>
            <p class="${HINT}">2FA ${u.totpSecret ? 'on' : 'off'} · since ${date(u.created)} · <code class="break-all">${esc(userDir(u))}</code></p>
          </div>
          ${
            u.admin
              ? ''
              : `<form method="post" action="/admin" class="flex items-center gap-3">
            <input type="hidden" name="id" value="${esc(u.id)}">
            ${confirmed(`<button name="action" value="remove" class="${DANGER}">Remove</button>`)}
          </form>`
          }
        </li>`
        )
        .join('')}
      </ul>
      <p class="${HINT}">Removing an account signs it out and stops its sign-in. Its folder stays on disk.</p>
    </div>
  </div>`,
    backToBoards,
    true
  )
}

const roleLabel = (role: string) => (role === 'owner' ? 'Owner' : (ROLES.find((r) => r.role === role)?.label ?? role))
const asRole = (role: string) => (role === 'owner' ? 'the owner' : `${role === 'editor' ? 'an' : 'a'} ${role}`)
const SELECT =
  'h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function workspaces(
  res: ServerResponse,
  status: number,
  opts: {
    user: User
    /** The workspace the account has open, and the one whose details show. */
    open: Space
    selected: Space
    spaces: Space[]
    /** The selected workspace's members and pending invitations. */
    members: { id: string; name: string; role: string; invited: boolean }[]
    /** Invitations waiting for this account. */
    incoming: { workspace: Workspace; by: string; role: Role }[]
    /** Workspaces this account owns or manages: the ones it can share. */
    managed: Workspace[]
    /** Everyone with access to (or an invitation to) one of those. */
    people: { name: string; access: { workspace: Workspace; role: 'owner' | Role; invited: boolean }[] }[]
    /** The share form's values: a person being changed, or a submit to show again. */
    editing?: { username: string; access: Map<string, string> }
    error?: string
  }
): void {
  const { user, open: current, selected, editing } = opts
  const idForm = (id: string, buttons: string) => `<form method="post" action="/workspaces" class="flex items-center gap-3">
            <input type="hidden" name="id" value="${esc(id)}">${buttons}
          </form>`
  const count = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

  const invitations = opts.incoming.length
    ? `<div class="grid gap-3">
      <h2 class="${SUBHEADING}">Invitations</h2>
      <ul class="${LIST}">${opts.incoming
        .map(
          ({ workspace, by, role }) => `
        <li class="${ROW}">
          <p class="text-sm"><strong class="font-medium">${esc(by)}</strong> invited you to <strong class="font-medium">${esc(workspace.name)}</strong> as ${asRole(role)}</p>
          ${idForm(
            workspace.id,
            `<button name="action" value="decline" class="${SECONDARY}">Decline</button>
            <button name="action" value="accept" class="${BUTTON}">Accept</button>`
          )}
        </li>`
        )
        .join('')}
      </ul>
    </div>`
    : ''

  const yours = `<div class="grid gap-3">
      <h2 class="${SUBHEADING}">Your workspaces</h2>
      <ul class="${LIST}">${opts.spaces
        .map(
          (s) => `
        <li class="${ROW}">
          <div class="grid gap-0.5">
            <p class="text-sm font-medium">${esc(s.name)}</p>
            <p class="${HINT}">${s.workspace ? `${roleLabel(roleOf(s.workspace, user.id) ?? '')} · ${count(s.workspace.members.length)}` : 'Only you'}</p>
          </div>
          <div class="flex items-center gap-3">
            ${s.workspace ? `<a href="/workspaces?workspace=${s.id}#details" class="${SECONDARY}"${s.id === selected.id ? ' aria-current="true"' : ''}>Details</a>` : ''}
            ${s.id === current.id ? `<span class="${HINT}">Open now</span>` : idForm(s.id, `<button name="action" value="switch" class="${SECONDARY}">Open</button>`)}
          </div>
        </li>`
        )
        .join('')}
      </ul>
    </div>`

  // Details of one workspace: members, and what this account may do with it.
  const ws = selected.workspace
  const role = ws ? roleOf(ws, user.id) : undefined
  const name = esc(selected.name)
  const withId = (body: string, cls = 'flex flex-wrap items-center gap-3') => `<form method="post" action="/workspaces" class="${cls}">
        <input type="hidden" name="id" value="${esc(selected.id)}">${body}
      </form>`
  const others = opts.members.filter((m) => !m.invited && m.role !== 'owner')
  const details = ws
    ? `<section id="details" class="grid gap-4 border-t border-border pt-6" aria-labelledby="details-heading">
      <div class="grid gap-0.5">
        <h2 id="details-heading" class="text-base font-semibold">${name}</h2>
        <p class="${HINT}">You're ${asRole(role ?? 'editor')} here${selected.id === current.id ? ', and it’s open now' : ''}.</p>
      </div>
      <ul class="${LIST}">${opts.members
        .map(
          (m) => `
        <li class="${ROW}">
          <p class="text-sm">${esc(m.name)}</p>
          <span class="${HINT}">${roleLabel(m.role)}${m.invited ? ', invited' : ''}</span>
        </li>`
        )
        .join('')}
      </ul>
      ${
        role === 'owner' || role === 'manager'
          ? withId(
              `<div class="min-w-48 flex-1">${field('rename', 'Name', `<input id="rename" name="name" maxlength="60" value="${name}" class="${INPUT}" required>`)}</div>
        <button name="action" value="rename" class="${SECONDARY_TALL}">Rename</button>`,
              'flex flex-wrap items-end gap-3'
            )
          : ''
      }
      ${
        role === 'owner'
          ? others.length
            ? withId(
                `<div class="grid gap-2">
          <label for="new-owner" class="text-sm font-medium">Make someone else the owner</label>
          <div class="flex flex-wrap items-center gap-3">
            <select id="new-owner" name="to" class="${SELECT}">${others.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select>
            ${confirmed(`<button name="action" value="transfer" class="${SECONDARY}">Make owner</button>`)}
          </div>
          <p class="${HINT}">You stay on as a manager.</p>
        </div>`,
                'grid'
              )
            : `<p class="${HINT}">To hand ${name} over, invite someone first; once they've joined you can make them the owner.</p>`
          : ''
      }
      ${
        role === 'owner'
          ? withId(
              `<div class="grid gap-2">
          <p class="text-sm font-medium">Delete ${name}</p>
          <p class="${HINT}">It disappears for everyone, boards and all. The server keeps a copy of its folder, so the admin can bring it back.</p>
          <div class="flex flex-wrap items-center gap-3">${confirmed(`<button name="action" value="delete" class="${DANGER}">Delete ${name}</button>`)}</div>
        </div>`,
              'grid border-t border-border pt-4'
            )
          : withId(confirmed(`<button name="action" value="leave" class="${DANGER}">Leave ${name}</button>`), 'flex flex-wrap items-center gap-3 border-t border-border pt-4')
      }
    </section>`
    : ''

  // One form for every workspace this account can share: a role (or no access) per workspace.
  const shareForm = opts.managed.length
    ? `<section id="share" class="grid gap-4 border-t border-border pt-6" aria-labelledby="share-heading">
      <div class="grid gap-0.5">
        <h2 id="share-heading" class="text-base font-semibold">${editing ? `Access for ${esc(editing.username)}` : 'Invite people'}</h2>
        <p class="${HINT}">Pick what they can do in each of your workspaces. New people get an invitation and join once they accept; people already in a workspace get the new role at once.</p>
      </div>
      <form method="post" action="/workspaces" class="grid gap-4">
        ${field('username', 'User name', `<input id="username" name="username" type="text" placeholder="Their user name" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(editing?.username ?? '')}" class="${INPUT}" required>`)}
        <ul class="${LIST}">${opts.managed
          .map((w) => {
            const chosen = editing?.access.get(w.id) ?? 'none'
            const control =
              chosen === 'owner'
                ? `<span class="${HINT}">Owner</span>`
                : `<select id="role-${w.id}" name="role:${w.id}" class="${SELECT}">
              <option value="none"${chosen === 'none' ? ' selected' : ''}>No access</option>
              ${ROLES.map((r) => `<option value="${r.role}"${chosen === r.role ? ' selected' : ''}>${r.label}</option>`).join('')}
            </select>`
            return `
          <li class="${ROW}">
            <label for="role-${w.id}" class="text-sm font-medium">${esc(w.name)}</label>
            ${control}
          </li>`
          })
          .join('')}
        </ul>
        <p class="${HINT}">${ROLES.map((r) => `<strong class="font-medium text-foreground">${r.label}</strong> ${r.can}`).join('. ')}.</p>
        <div class="flex items-center gap-3">
          <button name="action" value="share" class="${BUTTON_TALL}">${editing ? 'Save access' : 'Send invitations'}</button>
          ${editing ? `<a href="/workspaces" class="${LINK} text-sm">Cancel</a>` : ''}
        </div>
      </form>
    </section>`
    : `<p class="text-sm text-muted-foreground">To invite people, create a workspace below. You can share the ones you own or manage.</p>`

  const people = opts.people.length
    ? `<section id="people" class="grid gap-3" aria-labelledby="people-heading">
      <h2 id="people-heading" class="${SUBHEADING}">People</h2>
      <ul class="${LIST}">${opts.people
        .map(
          (p) => `
        <li class="${ROW}">
          <div class="grid min-w-0 gap-0.5">
            <p class="text-sm font-medium">${esc(p.name)}</p>
            <p class="${HINT}">${p.access.map((a) => `${esc(a.workspace.name)}: ${roleLabel(a.role)}${a.invited ? ' (invited)' : ''}`).join(' · ')}</p>
          </div>
          <a href="/workspaces?person=${encodeURIComponent(p.name)}#share" class="${SECONDARY}">Change</a>
        </li>`
        )
        .join('')}
      </ul>
    </section>`
    : ''

  authPage(
    res,
    status,
    'Workspaces',
    `<div class="grid gap-6">
    ${heading('Workspaces', "Your own boards are private. A workspace's boards belong to everyone in it, and edits show up live for all of them.")}
    ${errorBox(opts.error)}
    ${invitations}
    ${yours}
    ${details}
    ${shareForm}
    ${people}
    <form method="post" action="/workspaces" class="flex flex-wrap items-end gap-3 border-t border-border pt-6">
      <div class="min-w-48 flex-1">${field('name', 'New workspace', `<input id="name" name="name" maxlength="60" placeholder="A name, like Design team" class="${INPUT}" required>`)}</div>
      <button name="action" value="create" class="${BUTTON_TALL}">Create</button>
    </form>
  </div>`,
    backToBoards,
    true
  )
}
