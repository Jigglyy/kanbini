// Accounts and shared workspaces for the browser version, in
// <data>/accounts.json (readable by the app only). Each account has its own
// boards in <data>/users/<id>; each shared workspace has boards its members
// edit together in <data>/workspaces/<id>. Every one of those folders gets
// its own app process (see ./gateway.ts).
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { base32Decode, base32Encode, totp, totpStep } from './totp'

export type User = {
  id: string
  username: string
  salt: string // base64
  hash: string // base64 scrypt of the password
  totpSecret: string | null // base32; null = no authenticator app
  admin: boolean
  created: number
  mcpToken?: string // bearer token for /mcp, made on first use
}
/** What a member may do in a workspace. The owner can do everything. */
export type Role = 'viewer' | 'editor' | 'manager'
export const ROLES: { role: Role; label: string; can: string }[] = [
  { role: 'viewer', label: 'Viewer', can: 'sees the boards' },
  { role: 'editor', label: 'Editor', can: 'also changes them' },
  { role: 'manager', label: 'Manager', can: 'also invites and removes people' }
]
export type Invite = { userId: string; by: string; at: number; role?: Role }
export type Workspace = {
  id: string
  name: string
  owner: string
  members: string[]
  roles?: Record<string, Role> // per member except the owner
  invites?: Invite[] // waiting for the invited account to accept or decline
  created: number
}
type Store = { registration: boolean; inviteCode: string; users: User[]; workspaces: Workspace[] }

export const dataRoot = process.env['KANBINI_DATA'] ?? resolve('data')
const file = join(dataRoot, 'accounts.json')

/** A set of boards: an account's own (id = the account's id) or a shared workspace. */
export type Space = { id: string; name: string; dir: string; workspace?: Workspace }
const personal = (user: User): Space => ({ id: user.id, name: 'My boards', dir: join(dataRoot, 'users', user.id) })
const shared = (w: Workspace): Space => ({ id: w.id, name: w.name, dir: join(dataRoot, 'workspaces', w.id), workspace: w })
export const userDir = (user: User) => personal(user).dir
/** What this account can open: its own boards first, then its workspaces. */
export const spacesOf = (user: User): Space[] => [
  personal(user),
  ...store.workspaces.filter((w) => w.members.includes(user.id)).map(shared)
]
export const spaceFor = (user: User, id: string | undefined) => spacesOf(user).find((s) => s.id === id)

export const newInviteCode = () => base32Encode(randomBytes(5)).replace(/(.{4})/, '$1-')

export const store: Store = (() => {
  try {
    const loaded = JSON.parse(readFileSync(file, 'utf8')) as Store
    loaded.workspaces ??= [] // files from before workspaces
    return loaded
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { registration: false, inviteCode: newInviteCode(), users: [], workspaces: [] }
  }
})()

export function save(): void {
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

const scryptHash = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>
export const MIN_PASSWORD = 10
const USERNAME = /^[a-z0-9._-]{3,32}$/

// Ten wrong tries in 15 minutes locks that account's sign-in (or, for wrong
// invite codes, registration) until the window passes.
const WINDOW_MS = 15 * 60_000
const failures = new Map<string, number[]>()
function lockedOut(key: string): boolean {
  const recent = (failures.get(key) ?? []).filter((t) => t > Date.now() - WINDOW_MS)
  failures.set(key, recent)
  return recent.length >= 10
}
const fail = (key: string) => failures.set(key, [...(failures.get(key) ?? []), Date.now()])

// Each code signs in once.
const lastSteps = new Map<string, number>() // user id -> step

/** The step of a valid, unused code: the current one or either neighbour (clock drift). */
function matchCode(secret: string, raw: string | null, after: number): number | undefined {
  const code = (raw ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) return undefined
  const key = base32Decode(secret)
  return [0, -1, 1]
    .map((d) => totpStep() + d)
    .find((s) => s > after && timingSafeEqual(Buffer.from(totp(key, s)), Buffer.from(code)))
}

export function validSecret(secret: string | null): secret is string {
  try {
    return secret !== null && base32Decode(secret).length >= 16
  } catch {
    return false
  }
}

const normalize = (code: string | null) => (code ?? '').replace(/[\s-]/g, '').toUpperCase()

/** A new account from the registration form, or what's wrong with the form.
 *  The first account needs no invite code and becomes the admin. */
export async function register(form: URLSearchParams): Promise<User | string> {
  const first = store.users.length === 0
  if (!first) {
    if (lockedOut('invite')) return 'Too many wrong invite codes. Wait 15 minutes.'
    const given = Buffer.from(normalize(form.get('invite')))
    const wanted = Buffer.from(normalize(store.inviteCode))
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      fail('invite')
      return 'That invite code is wrong.'
    }
  }
  const username = (form.get('username') ?? '').trim().toLowerCase()
  const password = form.get('password') ?? ''
  const secret = form.get('twofa') ? form.get('secret') : null
  if (!USERNAME.test(username)) return 'Use 3 to 32 characters for the user name: letters, digits, dots, dashes or underscores.'
  if (store.users.some((u) => u.username === username)) return 'That user name is taken.'
  if (password.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`
  if (password !== form.get('confirm')) return "The passwords don't match."
  let step: number | undefined
  if (form.get('twofa')) {
    if (!validSecret(secret)) return 'Reload the page and scan the new code.'
    step = matchCode(secret, form.get('code'), 0)
    if (step === undefined) return "That code didn't match. Use the newest code from the app."
  }
  const salt = randomBytes(16)
  const hash = await scryptHash(password, salt, 32)
  // Checked again: another registration may have finished while this one hashed.
  if (store.users.some((u) => u.username === username)) return 'That user name is taken.'
  if (first !== (store.users.length === 0)) return 'Reload the page and try again.'
  const user: User = {
    id: randomBytes(8).toString('hex'),
    username,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    totpSecret: form.get('twofa') ? secret : null,
    admin: first,
    created: Date.now()
  }
  store.users.push(user)
  save()
  if (step !== undefined) lastSteps.set(user.id, step)
  return user
}

const dummySalt = randomBytes(16)

const lockedMessage = 'Too many wrong tries for this account. Wait 15 minutes.'

/** Sign-in step 1: the account the user name and password match, or why not.
 *  An account with 2FA still owes a code (checkCode) before it's signed in. */
export async function checkPassword(form: URLSearchParams): Promise<User | string> {
  const username = (form.get('username') ?? '').trim().toLowerCase()
  const key = `user:${username}`
  if (lockedOut(key)) return lockedMessage
  const user = store.users.find((u) => u.username === username)
  // Hash even for an unknown name, so timing doesn't tell which names exist.
  const given = await scryptHash(form.get('password') ?? '', user ? Buffer.from(user.salt, 'base64') : dummySalt, 32)
  if (!user || !timingSafeEqual(given, Buffer.from(user.hash, 'base64'))) {
    fail(key)
    return 'Wrong user name or password.'
  }
  return user
}

/** Sign-in step 2, for accounts with 2FA: '' when the code is right, else why not. */
export function checkCode(user: User, code: string | null): string {
  const key = `user:${user.username}`
  if (lockedOut(key)) return lockedMessage
  const step = matchCode(user.totpSecret!, code, lastSteps.get(user.id) ?? 0)
  if (step === undefined) {
    fail(key)
    return 'That code is wrong or already used. Wait for a new one, then try again.'
  }
  lastSteps.set(user.id, step)
  return ''
}

export function createWorkspace(owner: User, name: string): Workspace | string {
  const clean = name.trim()
  if (!clean || clean.length > 60) return 'Give the workspace a name of up to 60 characters.'
  const workspace = { id: randomBytes(8).toString('hex'), name: clean, owner: owner.id, members: [owner.id], created: Date.now() }
  store.workspaces.push(workspace)
  save()
  return workspace
}

/** Renames the workspace; '' when done, else what's wrong. */
export function renameWorkspace(workspace: Workspace, name: string): string {
  const clean = name.trim()
  if (!clean || clean.length > 60) return 'Give the workspace a name of up to 60 characters.'
  workspace.name = clean
  save()
  return ''
}

/** Makes a member the owner. The old owner stays on as a manager. */
export function transferOwnership(workspace: Workspace, toUserId: string | null): boolean {
  const current = toUserId ? roleOf(workspace, toUserId) : undefined
  if (!toUserId || !current || current === 'owner') return false
  const roles = (workspace.roles ??= {})
  roles[workspace.owner] = 'manager'
  delete roles[toUserId]
  workspace.owner = toUserId
  save()
  return true
}

/** Takes the workspace off the list; its folder is the caller's to put away. */
export function deleteWorkspace(workspace: Workspace): void {
  store.workspaces = store.workspaces.filter((w) => w !== workspace)
  save()
}

/** The account's role in the workspace, or undefined when it isn't a member.
 *  Members from before roles existed are editors, which is what they could do. */
export function roleOf(workspace: Workspace, userId: string): 'owner' | Role | undefined {
  if (workspace.owner === userId) return 'owner'
  if (!workspace.members.includes(userId)) return undefined
  return workspace.roles?.[userId] ?? 'editor'
}
export const canManage = (workspace: Workspace, userId: string) => ['owner', 'manager'].includes(roleOf(workspace, userId) ?? '')
/** Viewers only read; an account's own boards and every other role can change. */
export const canEdit = (space: Space, userId: string) => !space.workspace || roleOf(space.workspace, userId) !== 'viewer'
/** The workspaces this account can invite people to. */
export const managedBy = (user: User) => store.workspaces.filter((w) => canManage(w, user.id))

/** What `target` has in `workspace`: a role, an invitation with one, or nothing. */
export function accessOf(workspace: Workspace, targetId: string): { role: 'owner' | Role; invited: boolean } | undefined {
  const role = roleOf(workspace, targetId)
  if (role) return { role, invited: false }
  const pending = workspace.invites?.find((i) => i.userId === targetId)
  return pending && { role: pending.role ?? 'editor', invited: true }
}

/** Sets what the named account may do in each workspace `by` manages: a role
 *  (an invitation when it isn't a member yet, a change when it is) or 'none'
 *  (taken out, or the invitation cancelled). The owner's access never changes.
 *  Returns that account and the workspaces it was taken out of, or what's wrong. */
export function share(
  by: User,
  username: string,
  access: Map<string, Role | 'none'>
): { target: User; removedFrom: Workspace[] } | string {
  const target = store.users.find((u) => u.username === username.trim().toLowerCase())
  if (!target) return 'No account has that user name.'
  if (target.id === by.id) return 'That’s you. Pick someone else.'
  const anyAccess = managedBy(by).some((w) => accessOf(w, target.id))
  if (!anyAccess && [...access.values()].every((choice) => choice === 'none')) return 'Pick a role in at least one workspace.'
  const removedFrom: Workspace[] = []
  for (const workspace of managedBy(by)) {
    const choice = access.get(workspace.id)
    const current = roleOf(workspace, target.id)
    if (choice === undefined || current === 'owner') continue
    const pending = workspace.invites?.find((i) => i.userId === target.id)
    if (choice === 'none') {
      if (pending) workspace.invites = workspace.invites!.filter((i) => i !== pending)
      if (current) {
        removeMember(workspace, target.id)
        removedFrom.push(workspace)
      }
    } else if (current) {
      ;(workspace.roles ??= {})[target.id] = choice
    } else if (pending) {
      pending.role = choice
    } else {
      ;(workspace.invites ??= []).push({ userId: target.id, by: by.id, at: Date.now(), role: choice })
    }
  }
  save()
  return { target, removedFrom }
}

/** The invitations waiting for this account, with their workspaces. */
export const invitesFor = (user: User) =>
  store.workspaces.flatMap((workspace) =>
    (workspace.invites ?? []).filter((i) => i.userId === user.id).map((i) => ({ workspace, invite: i }))
  )

/** Ends the account's invitation to the workspace: it joins, with the offered
 *  role, when accepted. Returns the workspace, or undefined when there was no
 *  such invitation. */
export function answerInvite(user: User, workspaceId: string | null, accept: boolean): Workspace | undefined {
  const workspace = store.workspaces.find((w) => w.id === workspaceId && w.invites?.some((i) => i.userId === user.id))
  if (!workspace) return undefined
  const pending = workspace.invites!.find((i) => i.userId === user.id)!
  workspace.invites = workspace.invites!.filter((i) => i !== pending)
  if (accept && !workspace.members.includes(user.id)) {
    workspace.members.push(user.id)
    ;(workspace.roles ??= {})[user.id] = pending.role ?? 'editor'
  }
  save()
  return workspace
}

/** Takes the account out of the workspace. The next member inherits ownership;
 *  a workspace left empty is dropped from the list (its folder stays on disk). */
export function removeMember(workspace: Workspace, userId: string): void {
  workspace.members = workspace.members.filter((id) => id !== userId)
  if (workspace.roles) delete workspace.roles[userId]
  if (workspace.owner === userId && workspace.members[0]) {
    workspace.owner = workspace.members[0]
    if (workspace.roles) delete workspace.roles[workspace.owner] // the owner has no role entry
  }
  if (workspace.members.length === 0) store.workspaces = store.workspaces.filter((w) => w !== workspace)
  save()
}

export function removeUser(user: User): void {
  store.users = store.users.filter((u) => u !== user)
  for (const workspace of store.workspaces) {
    workspace.invites = workspace.invites?.filter((i) => i.userId !== user.id)
    if (workspace.members.includes(user.id)) removeMember(workspace, user.id)
  }
  save()
}

/** The account's bearer token for the MCP endpoint (Settings > MCP shows it). */
export function mcpToken(user: User): string {
  if (!user.mcpToken) {
    user.mcpToken = randomBytes(32).toString('base64url')
    save()
  }
  return user.mcpToken
}

const sha = (s: string) => createHash('sha256').update(s).digest()
export function userByMcpToken(given: string): User | undefined {
  const wanted = sha(given)
  return store.users.find((u) => u.mcpToken !== undefined && timingSafeEqual(sha(u.mcpToken), wanted))
}
