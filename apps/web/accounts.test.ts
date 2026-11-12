import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, totp, totpStep } from './totp'

// accounts.ts reads <KANBINI_DATA>/accounts.json when it loads, so point it
// at an empty folder first. Each test file gets its own module copy.
const dataDir = mkdtempSync(join(tmpdir(), 'kanbini-accounts-'))
let a: typeof import('./accounts')
beforeAll(async () => {
  process.env['KANBINI_DATA'] = dataDir
  a = await import('./accounts')
})
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const PASSWORD = 'correct horse battery'
const form = (fields: Record<string, string>) => new URLSearchParams(fields)
async function account(username: string, extra: Record<string, string> = {}) {
  const made = await a.register(form({ username, password: PASSWORD, confirm: PASSWORD, invite: a.store.inviteCode, ...extra }))
  if (typeof made === 'string') throw new Error(made)
  return made
}
const signIn = (username: string, password: string, device?: string) =>
  a.checkPassword(form({ username, password }), device)
async function failTenTimes(username: string, device?: string) {
  for (let i = 0; i < 10; i++) expect(await signIn(username, 'wrong password', device)).toBe('Wrong user name or password.')
}

describe('registration', () => {
  it('makes the first account the admin, without an invite code', async () => {
    const first = await a.register(form({ username: 'admin', password: PASSWORD, confirm: PASSWORD }))
    expect(typeof first === 'object' && first.admin).toBe(true)
  })

  it('needs the invite code after that, and makes ordinary accounts', async () => {
    expect(await a.register(form({ username: 'nocode', password: PASSWORD, confirm: PASSWORD, invite: 'WRONG-CODE' }))).toBe(
      'That invite code is wrong.'
    )
    expect((await account('second')).admin).toBe(false)
  })
})

describe('sign-in lockout', () => {
  it('locks an account after ten wrong passwords, even for the right one', async () => {
    await account('locky')
    await failTenTimes('locky')
    expect(await signIn('locky', PASSWORD)).toMatch(/^Too many wrong tries for this account/)
  })

  it('still lets a browser that signed in before get in', async () => {
    const owner = await account('owner1')
    const device = a.deviceCookie(owner) // what startSession set at an earlier sign-in
    await failTenTimes('owner1') // a stranger, guessing
    expect(await signIn('owner1', PASSWORD)).toMatch(/^Too many wrong tries/)
    expect(await signIn('owner1', PASSWORD, device)).toMatchObject({ id: owner.id })
  })

  it('gives a trusted browser its own ten tries', async () => {
    const owner = await account('owner2')
    const device = a.deviceCookie(owner)
    await failTenTimes('owner2', device)
    expect(await signIn('owner2', PASSWORD, device)).toBe('Too many wrong tries from this browser. Wait 15 minutes.')
    // ...which doesn't lock the account for its other browsers.
    expect(await signIn('owner2', PASSWORD, a.deviceCookie(owner))).toMatchObject({ id: owner.id })
  })

  it('trusts a device cookie only for its own account, and only as issued', async () => {
    const alice = await account('alice')
    const bob = await account('bob')
    const cookie = a.deviceCookie(alice)
    expect(a.trustedDevice(alice, cookie)).toBeTruthy()
    expect(a.trustedDevice(bob, cookie)).toBeUndefined()
    const [id, device] = cookie.split('.')
    expect(a.trustedDevice(alice, `${id}.${device}.${'A'.repeat(43)}`)).toBeUndefined()
    expect(a.trustedDevice(alice, `${id}.other.${cookie.split('.')[2]}`)).toBeUndefined()
    expect(a.trustedDevice(alice, 'garbage')).toBeUndefined()
    expect(a.trustedDevice(alice, undefined)).toBeUndefined()
  })
})

describe('two-factor codes', () => {
  it('takes each code once, even the one used to register', async () => {
    const secret = base32Encode(randomBytes(20))
    const key = base32Decode(secret)
    const now = totpStep()
    const user = await account('twofa', { twofa: '1', secret, code: totp(key, now) })
    expect(a.checkCode(user, totp(key, now))).toMatch(/wrong or already used/)
    expect(a.checkCode(user, totp(key, now + 1))).toBe('') // the next step (clock drift allowance)
    expect(a.checkCode(user, totp(key, now + 1))).toMatch(/wrong or already used/)
  })
})

describe('workspaces and roles', () => {
  async function team(prefix: string) {
    const owner = await account(`${prefix}-owner`)
    const workspace = a.createWorkspace(owner, `${prefix} team`)
    if (typeof workspace === 'string') throw new Error(workspace)
    const space = a.spaceFor(owner, workspace.id)!
    return { owner, workspace, space }
  }
  const join = (by: Parameters<typeof a.share>[0], who: { username: string; id: string }, workspaceId: string, role: 'viewer' | 'editor' | 'manager') => {
    const shared = a.share(by, who.username, new Map([[workspaceId, role]]))
    if (typeof shared === 'string') throw new Error(shared)
    expect(a.answerInvite(who as never, workspaceId, true)).toBeTruthy()
  }

  it('makes an invitation, not a member, until it is accepted', async () => {
    const { owner, workspace } = await team('invite')
    const guest = await account('invite-guest')
    expect(a.share(owner, 'invite-guest', new Map([[workspace.id, 'editor']]))).toMatchObject({ target: { id: guest.id } })
    expect(a.roleOf(workspace, guest.id)).toBeUndefined()
    expect(a.accessOf(workspace, guest.id)).toEqual({ role: 'editor', invited: true })
    a.answerInvite(guest, workspace.id, true)
    expect(a.roleOf(workspace, guest.id)).toBe('editor')
  })

  it('lets viewers read only, and only owners and managers manage', async () => {
    const { owner, workspace, space } = await team('roles')
    const viewer = await account('roles-viewer')
    const manager = await account('roles-manager')
    join(owner, viewer, workspace.id, 'viewer')
    join(owner, manager, workspace.id, 'manager')
    expect(a.canEdit(space, viewer.id)).toBe(false)
    expect(a.canEdit(space, manager.id)).toBe(true)
    expect(a.canEdit(a.spaceFor(viewer, viewer.id)!, viewer.id)).toBe(true) // their own boards
    expect(a.canManage(workspace, viewer.id)).toBe(false)
    expect(a.canManage(workspace, manager.id)).toBe(true)
    expect(a.managedBy(manager).map((w) => w.id)).toContain(workspace.id)
  })

  it('never changes the owner’s access through sharing', async () => {
    const { owner, workspace } = await team('keep')
    const manager = await account('keep-manager')
    join(owner, manager, workspace.id, 'manager')
    a.share(manager, owner.username, new Map([[workspace.id, 'none']]))
    expect(a.roleOf(workspace, owner.id)).toBe('owner')
  })

  it('takes someone out with "none" and reports it', async () => {
    const { owner, workspace } = await team('out')
    const editor = await account('out-editor')
    join(owner, editor, workspace.id, 'editor')
    const result = a.share(owner, editor.username, new Map([[workspace.id, 'none']]))
    expect(typeof result === 'object' && result.removedFrom.map((w) => w.id)).toEqual([workspace.id])
    expect(a.roleOf(workspace, editor.id)).toBeUndefined()
  })

  it('hands a removed owner’s workspace to the highest role, not the longest member', async () => {
    const { owner, workspace } = await team('handover')
    const viewer = await account('handover-viewer')
    const manager = await account('handover-manager')
    join(owner, viewer, workspace.id, 'viewer') // joined first
    join(owner, manager, workspace.id, 'manager')
    a.removeMember(workspace, owner.id)
    expect(workspace.owner).toBe(manager.id)
    expect(a.roleOf(workspace, manager.id)).toBe('owner')
  })

  it('keeps the old owner on as a manager after a hand-over', async () => {
    const { owner, workspace } = await team('transfer')
    const editor = await account('transfer-editor')
    join(owner, editor, workspace.id, 'editor')
    expect(a.transferOwnership(workspace, editor.id)).toBe(true)
    expect(a.roleOf(workspace, editor.id)).toBe('owner')
    expect(a.roleOf(workspace, owner.id)).toBe('manager')
  })

  it('caps how many workspaces one account owns', async () => {
    const owner = await account('hoarder')
    for (let i = 0; i < a.MAX_OWNED_WORKSPACES; i++) expect(typeof a.createWorkspace(owner, `space ${i}`)).toBe('object')
    expect(a.createWorkspace(owner, 'one more')).toMatch(/^You own 20 workspaces/)
  })

  it('limits how many unknown names one account can try', async () => {
    const { owner, workspace } = await team('probe')
    const access = new Map([[workspace.id, 'viewer' as const]])
    for (let i = 0; i < 20; i++) expect(a.share(owner, `nobody-${i}`, access)).toBe('No account has that user name.')
    // From here on, even a real name gets the same answer, so the list of
    // accounts can't be read off one name at a time.
    expect(a.share(owner, 'admin', access)).toBe('Too many names that match no account. Wait 15 minutes.')
  })
})
