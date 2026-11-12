// Smoke test against a FRESH web edition container: it creates its own accounts.
//   docker run --rm -d --name kanbini-smoke -p 18080:8080 kanbini-kanbini
//   node --experimental-strip-types apps/web/smoke.mjs http://<host>:18080; docker rm -f kanbini-smoke
// Checks set-up, registration, the admin page, sign-in and that accounts
// don't share boards, then the app itself: a test board + card + attachment.
import assert from 'node:assert/strict'
import net from 'node:net'
import { base32Decode, totp, totpStep } from './totp.ts'

const base = process.argv[2] ?? 'http://localhost:18080'
const stamp = Date.now()
const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers })
const post = (path, form, headers = {}) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams(form) })
const cookieOf = (res, name = 'kanbini_session') => ({
  cookie: res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)).split(';')[0]
})
const apiAs = (auth) => async (channel, arg, headers = {}, body = JSON.stringify(arg)) => {
  const res = await fetch(`${base}/api/${channel}`, { method: 'POST', headers: { ...auth, ...headers }, body })
  assert.equal(res.status, 200, `${channel}: ${res.status} ${await res.clone().text()}`)
  return res.json()
}

// Before the first account: everything leads to set-up, which refuses proxied requests.
assert.equal((await get('/')).headers.get('location'), '/register')
assert.equal((await get('/login')).headers.get('location'), '/register')
assert.equal((await fetch(`${base}/api/boards:list`, { method: 'POST' })).status, 401)
assert.equal((await fetch(`${base}/api/events`)).status, 401)
assert.equal((await get('/register', { 'x-forwarded-for': '1.2.3.4' })).status, 403)
assert.equal((await post('/register', {}, { 'cf-connecting-ip': '1.2.3.4' })).status, 403)

// The first account is the admin, here with an authenticator app.
const setup = await (await get('/register')).text()
assert.doesNotMatch(setup, /name="invite"/)
assert.match(setup, /<svg[^>]*viewBox/)
const secret = setup.match(/name="secret" value="([A-Z2-7]+)"/)[1]
const code = (offset = 0) => totp(base32Decode(secret), totpStep() + offset)
const adminForm = { username: `Admin${stamp}`, password: `admin-pass-${stamp}`, confirm: `admin-pass-${stamp}`, twofa: '1', secret }
assert.equal((await post('/register', { ...adminForm, password: 'short', confirm: 'short', code: code() })).status, 400)
assert.equal((await post('/register', { ...adminForm, confirm: 'different-password', code: code() })).status, 400)
assert.equal((await post('/register', { ...adminForm, username: 'x', code: code() })).status, 400)
assert.equal((await post('/register', { ...adminForm, code: '000000' })).status, 400)
const adminRes = await post('/register', { ...adminForm, code: code() })
assert.equal(adminRes.status, 303)
assert.match(adminRes.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/)
const admin = cookieOf(adminRes)
const adminAccount = await (await get('/account', admin)).json()
assert.equal(adminAccount.username, adminForm.username.toLowerCase())
assert.equal(adminAccount.admin, true)
assert.equal(adminAccount.workspace.name, 'My boards')
assert.equal(adminAccount.invites, 0)

// Registration starts closed.
assert.equal((await get('/register')).status, 403)
assert.equal((await post('/register', { username: 'someone' })).status, 403)
assert.doesNotMatch(await (await get('/login')).text(), /Create an account/)

// The admin turns it on; the invite code is on the admin page.
assert.equal((await post('/admin', { action: 'open' }, admin)).status, 303)
const adminPage = await (await get('/admin', admin)).text()
assert.match(adminPage, /Registration is on/)
const invite = adminPage.match(/<code class="select-all[^"]*">([A-Z2-7]{4}-[A-Z2-7]{4})<\/code>/)[1]
assert.match(await (await get('/login')).text(), /Create an account/)

// A second account, through the proxy this time, without 2FA.
const userForm = { username: `user${stamp}`, password: `user-pass-${stamp}`, confirm: `user-pass-${stamp}` }
const proxied = { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' }
assert.equal((await post('/register', { ...userForm, invite: 'WRON-GCOD' }, proxied)).status, 400)
const userRes = await post('/register', { ...userForm, invite: invite.toLowerCase() }, proxied)
assert.equal(userRes.status, 303)
assert.match(userRes.headers.get('set-cookie'), /; Secure/)
const user = cookieOf(userRes)
assert.equal((await post('/register', { ...userForm, invite }, proxied)).status, 400, 'user name taken')
assert.equal((await get('/admin', user)).status, 403)
assert.equal((await post('/admin', { action: 'close' }, user)).status, 403)

// Each account has its own boards.
const api = apiAs(admin)
const userApi = apiAs(user)
await userApi('board:mutate', { type: 'board.create', name: `private ${stamp}` })
assert.ok((await userApi('boards:list')).some((b) => b.name === `private ${stamp}`))
assert.ok(!(await api('boards:list')).some((b) => b.name === `private ${stamp}`))
const account = async (auth) => (await get('/account', auth)).json()
const adminHome = (await account(admin)).workspace.id
const userHome = (await account(user)).workspace.id

// Shared workspaces: the admin makes one and invites the user by name.
const workspacesAs = (auth, form) => post('/workspaces', form, auth)
assert.equal((await workspacesAs(admin, { action: 'create', name: 'Team <b>' })).status, 303)
const team = (await account(admin)).workspace // creating opens it
assert.equal(team.name, 'Team <b>')
assert.match(await (await get('/workspaces', admin)).text(), /Team &lt;b&gt;/)
// Inviting: one form, a role (or no access) per workspace the inviter owns or manages.
const shareAs = (auth, username, role) => workspacesAs(auth, { action: 'share', username, [`role:${team.id}`]: role })
assert.equal((await shareAs(admin, 'no-such-user', 'editor')).status, 400)
assert.equal((await shareAs(admin, userForm.username, 'none')).status, 400, 'pick at least one role')
assert.equal((await shareAs(admin, adminForm.username, 'viewer')).status, 400, "that's you")
// An invitation waits for an answer, and says which role it offers.
const inviteUser = () => shareAs(admin, userForm.username.toUpperCase(), 'viewer')
assert.equal((await inviteUser()).status, 303)
assert.equal((await inviteUser()).status, 303, 'sending it again changes nothing')
assert.equal((await account(user)).invites, 1)
assert.match(await (await get('/workspaces', user)).text(), /invited you to <strong[^>]*>Team &lt;b&gt;<\/strong> as a viewer/)
assert.match(await (await get('/workspaces', admin)).text(), /Team &lt;b&gt;: Viewer \(invited\)/)
assert.equal((await workspacesAs(user, { action: 'switch', id: team.id })).status, 403, 'not a member yet')
assert.equal((await workspacesAs(user, { action: 'switch', id: adminHome })).status, 403, "not someone else's boards")
assert.equal((await workspacesAs(user, { action: 'decline', id: team.id })).status, 303)
assert.equal((await account(user)).invites, 0)
assert.equal((await workspacesAs(user, { action: 'accept', id: team.id })).status, 404, 'a declined invitation is gone')
assert.equal((await inviteUser()).status, 303)
assert.equal((await shareAs(admin, userForm.username, 'none')).status, 303)
assert.equal((await account(user)).invites, 0, 'the owner took it back')
assert.equal((await inviteUser()).status, 303)
assert.equal((await workspacesAs(user, { action: 'accept', id: team.id })).status, 303)
assert.equal((await account(user)).workspace.id, team.id, 'accepting opens the workspace')
assert.equal((await account(user)).invites, 0)
// Both see the workspace's boards, and one's edit reaches the other live.
const userEvents = (await fetch(`${base}/api/events`, { headers: user })).body.getReader()
await api('board:mutate', { type: 'board.create', name: `team ${stamp}` })
// A stream that ends early fails the run instead of hanging it.
const readText = async (reader) => {
  const { value, done } = await reader.read()
  assert.ok(!done, 'the event stream ended')
  return new TextDecoder().decode(value)
}
for (let text = ''; !text.includes('board:changed'); ) text += await readText(userEvents)
await userEvents.cancel()
assert.ok((await userApi('boards:list')).some((b) => b.name === `team ${stamp}`))
assert.ok(!(await userApi('boards:list')).some((b) => b.name === `private ${stamp}`), 'own boards stay private')
// A viewer reads but can't change anything: the server refuses it, whatever the page shows.
assert.equal((await account(user)).workspace.role, 'viewer')
const userMutate = (name) =>
  fetch(`${base}/api/board:mutate`, { method: 'POST', headers: { ...user, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'board.create', name }) })
assert.equal((await userMutate(`viewer ${stamp}`)).status, 403)
assert.ok(!(await userApi('boards:list')).some((b) => b.name === `viewer ${stamp}`))
// A tab stays on the workspace it loaded with (/w/<id>/...), whatever another tab opens.
const pinnedList = (auth, spaceId) => fetch(`${base}/w/${spaceId}/api/boards:list`, { method: 'POST', headers: auth })
assert.ok((await (await pinnedList(user, userHome)).json()).some((b) => b.name === `private ${stamp}`), 'a tab on My boards')
assert.ok((await (await pinnedList(user, team.id)).json()).some((b) => b.name === `team ${stamp}`), 'a tab on the workspace')
assert.equal((await pinnedList(user, adminHome)).status, 410, "not someone else's boards")
assert.match((await get('/', user)).headers.get('set-cookie') ?? '', new RegExp(`kanbini_space=${team.id}`), 'the page learns its workspace')

// MCP over HTTP: Settings > MCP gives the URL and a personal token.
const info = await api('mcp:info')
assert.equal(info.paths.mcpJson, `${base}/mcp/${team.id}`)
assert.match(info.snippets.mcpClientJson, /"type": "http"/)
const rpc = (url, bearer, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}`, ...headers },
    body: JSON.stringify(body)
  })
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }
assert.equal((await rpc(info.paths.mcpJson, 'wrong-token', initialize)).status, 401)
const userToken = (await userApi('mcp:info')).channel.token
assert.notEqual(userToken, info.channel.token)
assert.equal((await rpc(`${base}/mcp/${adminHome}`, userToken, initialize)).status, 404, "not someone else's boards")
const opened = await rpc(info.paths.mcpJson, info.channel.token, initialize)
assert.equal(opened.status, 200)
const mcpSession = { 'mcp-session-id': opened.headers.get('mcp-session-id') }
assert.ok(mcpSession['mcp-session-id'])
await rpc(info.paths.mcpJson, info.channel.token, { jsonrpc: '2.0', method: 'notifications/initialized' }, mcpSession)
const listed = await (
  await rpc(info.paths.mcpJson, info.channel.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kanbini_list_boards', arguments: {} } }, mcpSession)
).json()
assert.match(listed.result.content[0].text, new RegExp(`team ${stamp}`))
// The server's other files stay out of reach: each app touches only its own folder.
const teamBoard = (await api('boards:list')).find((b) => b.name === `team ${stamp}`)
await api('board:mutate', { type: 'list.create', boardId: teamBoard.id, name: 'Todo' })
await api('board:mutate', { type: 'card.create', listId: (await api('board:getView', { boardId: teamBoard.id })).lists[0].id, title: 'probe' })
const probe = (await api('board:getView', { boardId: teamBoard.id })).lists[0].cards[0]
const attachPath = async (path) =>
  (await (await rpc(info.paths.mcpJson, info.channel.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kanbini_add_attachment', arguments: { cardId: probe.id, path } } }, mcpSession)).json()).result
assert.ok(!(await attachPath(`/data/workspaces/${team.id}/mcp.json`)).isError, 'a file in its own folder attaches')
for (const path of ['/data/accounts.json', '/data/sessions.json', `/data/users/${userHome}/kanbini.sqlite`, '/etc/passwd']) {
  assert.ok((await attachPath(path)).isError, `MCP must not read ${path}`)
}
const obsidian = await fetch(`${base}/api/obsidian:push`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ vaultPath: '/data', subfolder: 'smoke' }) })
assert.notEqual(obsidian.status, 200, 'no writing outside its own folder')
assert.equal((await rpc(info.paths.mcpJson, userToken, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, mcpSession)).status, 404, "not someone else's session")
// A viewer's AI may only read.
const viewerOpened = await rpc(info.paths.mcpJson, userToken, initialize)
const viewerSession = { 'mcp-session-id': viewerOpened.headers.get('mcp-session-id') }
const viewerCall = async (name, args) =>
  (await (await rpc(info.paths.mcpJson, userToken, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, viewerSession)).json()).result
assert.ok(!(await viewerCall('kanbini_list_boards', {})).isError, 'a viewer reads through MCP')
const refused = await viewerCall('kanbini_batch', { ops: [] })
assert.ok(refused.isError && /only view/.test(refused.content[0].text), 'a viewer writes nothing through MCP')
assert.equal((await fetch(info.paths.mcpJson, { method: 'DELETE', headers: { authorization: `Bearer ${info.channel.token}`, ...mcpSession } })).status, 200)
// At most 5 MCP sessions per account: a 6th replaces the oldest.
const sessionIds = []
for (let i = 0; i < 6; i++) sessionIds.push((await rpc(info.paths.mcpJson, info.channel.token, initialize)).headers.get('mcp-session-id'))
const toolsList = { jsonrpc: '2.0', id: 5, method: 'tools/list' }
assert.equal((await rpc(info.paths.mcpJson, info.channel.token, toolsList, { 'mcp-session-id': sessionIds[0] })).status, 404, 'the oldest session was closed')
assert.equal((await rpc(info.paths.mcpJson, info.channel.token, toolsList, { 'mcp-session-id': sessionIds[5] })).status, 200)

// Changing a role applies at once, without a new invitation.
assert.equal((await shareAs(admin, userForm.username, 'editor')).status, 303)
assert.equal((await account(user)).workspace.role, 'editor')
assert.equal((await account(user)).invites, 0)
assert.equal((await userMutate(`editor ${stamp}`)).status, 200, 'an editor changes boards')
// Only owners and managers share.
const shareForm = new RegExp(`name="role:${team.id}"`)
assert.doesNotMatch(await (await get('/workspaces', user)).text(), shareForm, 'an editor gets no share form')
assert.equal((await shareAs(user, adminForm.username, 'viewer')).status, 400, 'an editor shares nothing')
assert.equal((await shareAs(admin, userForm.username, 'manager')).status, 303)
assert.match(await (await get('/workspaces', user)).text(), shareForm, 'a manager can share')
assert.match(await (await get(`/workspaces?person=${userForm.username}`, admin)).text(), /<option value="manager" selected>/, 'Change fills in the current role')

// Details: rename (owner or manager), hand over (owner), delete (owner), leave (others).
assert.equal((await workspacesAs(user, { action: 'rename', id: team.id, name: 'Team <b> 2' })).status, 303, 'a manager renames')
assert.equal((await account(admin)).workspace.name, 'Team <b> 2')
assert.equal((await workspacesAs(admin, { action: 'leave', id: team.id })).status, 400, "the owner hands over first, or deletes")
assert.equal((await workspacesAs(user, { action: 'transfer', id: team.id, to: userHome })).status, 403, 'only the owner hands over')
assert.equal((await workspacesAs(admin, { action: 'transfer', id: team.id, to: userHome })).status, 303)
assert.equal((await account(user)).workspace.role, 'owner')
assert.equal((await account(admin)).workspace.role, 'manager', 'the old owner stays on as a manager')
assert.equal((await workspacesAs(user, { action: 'transfer', id: team.id, to: adminHome })).status, 303, 'and hands it back')
assert.equal((await account(admin)).workspace.role, 'owner')
assert.match(await (await get(`/workspaces?workspace=${team.id}`, admin)).text(), /value="delete"/, 'the owner sees Delete')
assert.doesNotMatch(await (await get(`/workspaces?workspace=${team.id}`, user)).text(), /value="delete"/, 'others see Leave instead')
// Deleting: a separate workspace, opened once so it has a folder to keep.
assert.equal((await workspacesAs(admin, { action: 'create', name: 'Temp' })).status, 303)
const temp = (await account(admin)).workspace
assert.equal((await pinnedList(admin, temp.id)).status, 200)
assert.equal((await workspacesAs(admin, { action: 'switch', id: team.id })).status, 303)
assert.equal((await workspacesAs(user, { action: 'delete', id: temp.id })).status, 403, 'only the owner deletes')
assert.equal((await workspacesAs(admin, { action: 'delete', id: temp.id })).status, 303)
assert.equal((await pinnedList(admin, temp.id)).status, 410, 'a deleted workspace is gone for its tabs')
assert.doesNotMatch(await (await get('/workspaces', admin)).text(), />Temp</)

// The owner takes the user out (no access), and they land back on their own boards.
assert.equal((await shareAs(admin, userForm.username, 'none')).status, 303)
assert.equal((await account(user)).workspace.id, userHome)
assert.ok(!(await userApi('boards:list')).some((b) => b.name === `team ${stamp}`))
assert.equal((await workspacesAs(user, { action: 'switch', id: team.id })).status, 403)
assert.equal((await pinnedList(user, team.id)).status, 410, 'a tab still on the workspace is turned away')
// Leaving: back in as an editor, then out by their own choice.
assert.equal((await shareAs(admin, userForm.username, 'editor')).status, 303)
assert.equal((await workspacesAs(user, { action: 'accept', id: team.id })).status, 303)
assert.equal((await workspacesAs(user, { action: 'leave', id: team.id })).status, 303)
assert.equal((await pinnedList(user, team.id)).status, 410, 'a member who left is turned away')

// Sign-in step 1 is user name + password only (what password managers fill);
// accounts with 2FA then give a code on a page of its own.
const loginPage = await (await get('/login')).text()
assert.match(loginPage, /id="username" name="username" type="text" autocomplete="username"/)
assert.match(loginPage, /id="password" name="password" type="password" autocomplete="current-password"/)
assert.doesNotMatch(loginPage, /one-time-code/)
const signIn = (form) => post('/login', form)
assert.equal((await signIn({ username: userForm.username, password: 'wrong-password' })).status, 401)
const userSignIn = await signIn({ username: userForm.username, password: userForm.password })
assert.equal(userSignIn.headers.get('location'), '/', 'no 2FA: signed in at once')
// "Remember me" off: the cookie ends with the browser. On: it lasts 30 days.
assert.match(loginPage, /name="remember"/)
const sessionCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('kanbini_session='))
assert.doesNotMatch(sessionCookie(userSignIn), /Max-Age/)
const remembered = await signIn({ username: userForm.username, password: userForm.password, remember: '1' })
assert.match(sessionCookie(remembered), /Max-Age=2592000/)
assert.equal((await get('/login/code')).headers.get('location'), '/login', 'no code step without a password first')
const step1 = await signIn({ username: adminForm.username, password: adminForm.password, remember: '1' })
assert.equal(step1.headers.get('location'), '/login/code')
const pending = cookieOf(step1, 'kanbini_2fa')
assert.match(await (await get('/login/code', pending)).text(), /autocomplete="one-time-code"/)
assert.equal((await post('/login/code', { code: '000000' }, pending)).status, 401)
const step2 = await post('/login/code', { code: code(1) }, pending) // the set-up code is spent
assert.equal(step2.headers.get('location'), '/')
assert.match(sessionCookie(step2), /Max-Age=2592000/, 'the choice carries through the code step')
assert.equal((await post('/login/code', { code: code(1) }, pending)).headers.get('location'), '/login', 'the code step ends')
const again = cookieOf(await signIn({ username: adminForm.username, password: adminForm.password }), 'kanbini_2fa')
assert.equal((await post('/login/code', { code: code(1) }, again)).status, 401, 'a code works once')

// Tries sent all at once still count: ten wrong passwords, then the lockout.
const tries = await Promise.all(Array.from({ length: 30 }, () => signIn({ username: `ghost${stamp}`, password: 'wrong-password' }).then((r) => r.text())))
assert.equal(tries.filter((t) => /Wrong user name/.test(t)).length, 10)
assert.equal(tries.filter((t) => /Too many wrong tries/.test(t)).length, 20)

// When the admin removes an account that owns a workspace, the member with the
// highest role takes over, not whoever joined first.
assert.equal((await workspacesAs(user, { action: 'create', name: 'Owned' })).status, 303)
const owned = (await account(user)).workspace
const shareOwned = (username, role) => workspacesAs(user, { action: 'share', username, [`role:${owned.id}`]: role })
assert.equal((await shareOwned(adminForm.username, 'viewer')).status, 303)
assert.equal((await workspacesAs(admin, { action: 'accept', id: owned.id })).status, 303)
assert.equal((await workspacesAs(admin, { action: 'switch', id: team.id })).status, 303) // accepting opened it
const thirdForm = { username: `third${stamp}`, password: `third-pass-${stamp}`, confirm: `third-pass-${stamp}`, invite }
const third = cookieOf(await post('/register', thirdForm))
assert.equal((await shareOwned(thirdForm.username, 'editor')).status, 303)
assert.equal((await workspacesAs(third, { action: 'accept', id: owned.id })).status, 303)

// Removing an account ends its sessions and its sign-in.
assert.equal((await post('/admin', { action: 'remove', id: userHome }, admin)).status, 303)
assert.equal((await fetch(`${base}/api/boards:list`, { method: 'POST', headers: user })).status, 401)
assert.equal((await signIn({ username: userForm.username, password: userForm.password })).status, 401)
assert.equal((await account(third)).workspace.role, 'owner', 'the editor took over, not the viewer who joined first')
assert.equal((await post('/admin', { action: 'close' }, admin)).status, 303)

// The app itself, as the admin.
const auth = admin
const page = await fetch(base, { headers: auth })
assert.equal(page.status, 200)
assert.match(page.headers.get('content-security-policy'), /script-src 'self'.*frame-ancestors 'none'/)
assert.match(await page.text(), /<div id="root">/)

// Live updates: a write reaches the event stream.
const stream = await fetch(`${base}/api/events`, { headers: auth })
assert.equal(stream.headers.get('content-type'), 'text/event-stream')
const reader = stream.body.getReader()
const nextEvent = async () => {
  let text = ''
  while (!text.includes('event: board:changed')) text += await readText(reader)
  return text
}

const name = `smoke ${Date.now()}`
const created = nextEvent()
await api('board:mutate', { type: 'board.create', name })
await created
const board = (await api('boards:list')).find((b) => b.name === name)
assert.ok(board, 'board created')
await api('board:mutate', { type: 'list.create', boardId: board.id, name: 'Todo' })
const view = await api('board:getView', { boardId: board.id })
const listId = view.lists[0].id
await api('board:mutate', { type: 'card.create', listId, title: 'smoke card' })
const card = (await api('board:getView', { boardId: board.id })).lists[0].cards[0]
assert.equal(card.title, 'smoke card')

// Upload (stands in for the native file dialog), then fetch it back.
const content = `hello ${Date.now()}`
const att = await api('attachment:add', null, {
  'x-kanbini-filename': encodeURIComponent('hello world.txt'),
  'x-kanbini-arg': encodeURIComponent(JSON.stringify({ cardId: card.id }))
}, content)
assert.equal(att.filename, 'hello world.txt')
const file = await fetch(`${base}/kanbini-file/${att.relPath.split('/').map(encodeURIComponent).join('/')}`, { headers: auth })
assert.equal(file.status, 200)
assert.equal(await file.text(), content)
assert.match(file.headers.get('content-security-policy'), /sandbox/)

// No way out of the attachment folders.
for (const p of ['..%2Fkanbini.sqlite', 'attachments/..%2F..%2Fkanbini.sqlite', '..%2F..%2F..%2Fetc%2Fpasswd']) {
  const r = await fetch(`${base}/kanbini-file/${p}`, { headers: auth })
  assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`)
}
assert.notEqual((await fetch(`${base}/..%2F..%2Fpackages/db/drizzle/meta/_journal.json`, { headers: auth })).status, 200)

// Requests over the size limits are refused before anything is stored.
// (A raw socket: a normal client won't declare a body it doesn't send.)
const statusOf = (path, headers) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base)
    const socket = net.connect(Number(port || 80), hostname, () =>
      socket.write(`POST ${path} HTTP/1.1\r\nHost: ${hostname}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    )
    socket.once('data', (d) => (resolve(Number(String(d).split(' ')[1])), socket.destroy()))
    socket.on('error', reject)
  })
const uploadHeaders = { 'x-kanbini-filename': 'big.bin', 'x-kanbini-arg': encodeURIComponent(JSON.stringify({ cardId: card.id })) }
assert.equal(await statusOf('/api/attachment:add', { ...auth, ...uploadHeaders, 'content-length': 101 * 1024 * 1024 }), 413)
assert.equal(await statusOf('/api/board:mutate', { ...auth, 'content-type': 'application/json', 'content-length': 6 * 1024 * 1024 }), 413)

// Board export lands as a download.
const exported = await api('board:export', { boardId: board.id, content: 'cards' })
const dl = await fetch(`${base}/download/${encodeURIComponent(exported.path.split('/').pop())}`, { headers: auth })
assert.equal(dl.status, 200)
assert.match(dl.headers.get('content-disposition'), /attachment/)
assert.ok((await dl.arrayBuffer()).byteLength > 0)

// File links carry no workspace: they're served from whichever of your workspaces has them.
assert.equal((await workspacesAs(admin, { action: 'switch', id: adminHome })).status, 303)
assert.equal((await fetch(`${base}/kanbini-file/${att.relPath.split('/').map(encodeURIComponent).join('/')}`, { headers: auth })).status, 200)
assert.equal((await workspacesAs(admin, { action: 'switch', id: team.id })).status, 303)

await api('board:mutate', { type: 'board.delete', id: board.id })
await reader.cancel()

// Signing out ends the session.
assert.equal((await fetch(`${base}/logout`, { method: 'POST', headers: auth })).status, 204)
assert.equal((await fetch(`${base}/api/boards:list`, { method: 'POST', headers: auth })).status, 401)
console.log('smoke OK')
