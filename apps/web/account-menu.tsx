// The account menu at the right of the app header, next to Settings: who is
// signed in, the open workspace, and the gateway's pages. The desktop UI has
// no accounts, so the web build inserts this into App.tsx (vite.config.ts),
// built from the app's own components.
import { ChevronDown, LayoutGrid, LogOut, Shield, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover } from '@/components/ui/popover'
import { base } from './bridge'

type Account = {
  username: string
  admin: boolean
  workspace: { id: string; name: string; role: 'owner' | 'manager' | 'editor' | 'viewer' }
  invites: number
}

/** How many workspace invitations wait for an answer. */
function InviteCount({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className="rounded-full bg-primary px-1.5 text-xs font-medium tabular-nums text-primary-foreground">
      {count}
      <span className="sr-only"> workspace {count === 1 ? 'invitation' : 'invitations'}</span>
    </span>
  )
}

export function AccountMenu() {
  const [account, setAccount] = useState<Account | null>(null)
  useEffect(() => {
    // Again on focus, so an invitation sent meanwhile shows up.
    const load = (): void =>
      void fetch(`${location.origin}${base}/account`)
        .then((r) => (r.ok ? r.json() : null))
        .then((next: Account | null) => next && setAccount(next))
        .catch(() => {})
    load()
    addEventListener('focus', load)
    return () => removeEventListener('focus', load)
  }, [])
  if (!account) return null
  const viewOnly = account.workspace.role === 'viewer'

  const signOut = (): void =>
    void fetch(`${location.origin}/logout`, { method: 'POST' }).finally(() => location.assign('/login'))
  return (
    <Popover
      width={248}
      align="right"
      trigger={({ open, toggle }) => (
        <Button variant="ghost" size="sm" onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
          <UserRound className="size-4" />
          <span className="text-foreground">{account.username}</span>
          <span className="hidden text-muted-foreground sm:inline">{account.workspace.name}</span>
          {viewOnly && <span className="rounded-full border border-border px-1.5 text-xs text-muted-foreground">View only</span>}
          <InviteCount count={account.invites} />
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      )}
    >
      {() => (
        <nav aria-label="Account" className="flex flex-col gap-1">
          <div className="grid gap-0.5 px-2 pb-1">
            <p className="text-sm font-medium">{account.username}</p>
            <p className="text-xs text-muted-foreground">
              In {account.workspace.name}
              {viewOnly && ': you can view, not change'}
            </p>
          </div>
          <Button asChild variant="ghost" size="sm" className="justify-start">
            <a href="/workspaces">
              <LayoutGrid className="size-4" />
              Workspaces
              <InviteCount count={account.invites} />
            </a>
          </Button>
          {account.admin && (
            <Button asChild variant="ghost" size="sm" className="justify-start">
              <a href="/admin">
                <Shield className="size-4" />
                Admin
              </a>
            </Button>
          )}
          <Button variant="ghost" size="sm" className="justify-start" onClick={signOut}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </nav>
      )}
    </Popover>
  )
}
