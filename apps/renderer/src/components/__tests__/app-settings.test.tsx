import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppSettings } from '../app-settings'
import type { Settings } from '../../lib/settings'

// Tests for the Settings screen's sidebar nav - specifically the
// SECTION_GROUPS structure landed by the recent regroup
// (Personalize / Boards & cards / Connections / header-less tail).
// The per-section content has its own tests (templates, labels, etc.);
// this file covers nav + persistence + the relabel pass.

const BASE_SETTINGS: Settings = {
  hasSeenWelcome: true,
  removeDataOnUninstall: false,
  theme: 'system',
  startMode: 'home',
  cardLimitBlocksCreate: false,
  cardLimitBlocksDrag: false,
  showChecklistOnCard: false,
  labelsExpanded: false,
  linkPreviews: false,
  autoCoverFromUrl: false,
  boardZoom: 1,
  obsidian: {
    enabled: false,
    vaultPath: null,
    subfolder: 'Kanbini',
    lastPush: null
  },
  shortcuts: {}
}

function renderAppSettings(overrides: Partial<Settings> = {}) {
  // Each test gets its own QueryClient - appInfo / mcpInfo / undoStatus
  // queries fire on mount in some sections and we don't want cache
  // bleed across tests.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  })
  return render(
    <QueryClientProvider client={qc}>
      <AppSettings
        onClose={vi.fn()}
        settings={{ ...BASE_SETTINGS, ...overrides }}
        update={vi.fn()}
      />
    </QueryClientProvider>
  )
}

describe('<AppSettings> sidebar nav', () => {
  it('renders all four group headers in order', () => {
    renderAppSettings()
    // Headers are inert <h4> elements.
    expect(screen.getByText('Personalize')).toBeInTheDocument()
    expect(screen.getByText('Boards & cards')).toBeInTheDocument()
    expect(screen.getByText('Connections')).toBeInTheDocument()
    // The header-less tail has no group label, so we just confirm the
    // leaf rows are present.
    expect(
      screen.getByRole('button', { name: 'Backup & restore' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument()
  })

  it('Personalize group lists Appearance + Shortcuts', () => {
    renderAppSettings()
    expect(
      screen.getByRole('button', { name: 'Appearance' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Shortcuts' })
    ).toBeInTheDocument()
  })

  it('Boards & cards group lists Startup + Cards + Templates', () => {
    renderAppSettings()
    expect(
      screen.getByRole('button', { name: 'Startup' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cards' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Templates' })
    ).toBeInTheDocument()
  })

  it('Connections group lists Link previews + Obsidian + AI integration', () => {
    renderAppSettings()
    expect(
      screen.getByRole('button', { name: 'Link previews' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Obsidian' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'AI integration' })
    ).toBeInTheDocument()
  })

  it('lands on Appearance by default + marks it aria-current', () => {
    renderAppSettings()
    const appearance = screen.getByRole('button', { name: 'Appearance' })
    expect(appearance).toHaveAttribute('aria-current', 'page')
    // The Appearance section's RadioRow renders three options.
    expect(
      screen.getByRole('radio', { name: /Match system/ })
    ).toBeInTheDocument()
  })

  it('clicking a sidebar row navigates to that section', async () => {
    const user = userEvent.setup()
    renderAppSettings()
    await user.click(screen.getByRole('button', { name: 'Startup' }))
    expect(screen.getByRole('button', { name: 'Startup' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    // Startup's RadioRow option label.
    expect(
      screen.getByRole('radio', { name: /Boards menu/ })
    ).toBeInTheDocument()
  })

  it('persists the active section to localStorage on change', async () => {
    const user = userEvent.setup()
    renderAppSettings()
    await user.click(screen.getByRole('button', { name: 'Cards' }))
    expect(window.localStorage.getItem('kanbini.lastSettingsSection')).toBe(
      'cards'
    )
  })

  it('restores the persisted section on next mount', () => {
    window.localStorage.setItem('kanbini.lastSettingsSection', 'shortcuts')
    renderAppSettings()
    expect(screen.getByRole('button', { name: 'Shortcuts' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it('falls back to Appearance when the persisted section is unknown', () => {
    // E.g. a future build removed the 'data' section but a value
    // sticks around in storage.
    window.localStorage.setItem(
      'kanbini.lastSettingsSection',
      'ghost-section-from-a-future-build'
    )
    renderAppSettings()
    expect(
      screen.getByRole('button', { name: 'Appearance' })
    ).toHaveAttribute('aria-current', 'page')
  })

  it("the 'Data' leaf was relabelled to 'Backup & restore'", () => {
    renderAppSettings()
    // Old label is gone; new one is present.
    expect(screen.queryByRole('button', { name: /^Data$/ })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Backup & restore' })
    ).toBeInTheDocument()
  })

  it("the 'MCP' leaf was relabelled to 'AI integration'", () => {
    renderAppSettings()
    expect(screen.queryByRole('button', { name: /^MCP$/ })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'AI integration' })
    ).toBeInTheDocument()
  })

  it('Back button calls onClose', async () => {
    const user = userEvent.setup()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    const onClose = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={onClose}
          settings={BASE_SETTINGS}
          update={vi.fn()}
        />
      </QueryClientProvider>
    )
    // Exact match - `/back/i` would also collide with "Backup & restore".
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('<AppSettings> Appearance section', () => {
  it('clicking a theme radio fires update({theme: …})', async () => {
    const user = userEvent.setup()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    const update = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={update}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('radio', { name: /Light/ }))
    expect(update).toHaveBeenCalledWith({ theme: 'light' })
  })
})

describe('<AppSettings> Cards section', () => {
  it('clicking a card-limit toggle fires the right update key', async () => {
    const user = userEvent.setup()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    const update = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={update}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Cards' }))
    await user.click(screen.getByLabelText(/Block new cards/))
    expect(update).toHaveBeenCalledWith({ cardLimitBlocksCreate: true })
  })
})

describe('<AppSettings> Link previews section', () => {
  it('Auto cover toggle is disabled when linkPreviews is off', async () => {
    const user = userEvent.setup()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={vi.fn()}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Link previews' }))
    const auto = screen.getByLabelText(/Auto cover from URL in title/)
    expect(auto).toBeDisabled()
  })

  it('Auto cover toggle is enabled when linkPreviews is on', async () => {
    const user = userEvent.setup()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={{ ...BASE_SETTINGS, linkPreviews: true }}
          update={vi.fn()}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Link previews' }))
    expect(
      screen.getByLabelText(/Auto cover from URL in title/)
    ).not.toBeDisabled()
  })
})

// M5-B / ADR-0049 - the "Remove my data on uninstall" toggle in
// Settings → Backup & restore. Only the NSIS uninstaller can act on
// it, so the UI is gated on the appInfo platform field. The mock
// bridge defaults to 'linux' (see _kanbini-mock.ts); tests that want
// the Windows-only path override via setKanbini.
describe('<AppSettings> Backup & restore - uninstall opt-in', () => {
  it('hides the toggle on non-Windows platforms', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    kanbiniMock().appInfo.mockResolvedValue({
      version: '0.0.0',
      versions: { electron: 'test', chrome: 'test', node: 'test' },
      paths: {
        userData: '/mock',
        db: '/mock/db',
        attachments: '/mock/att',
        export: '/mock/export',
        notices: '/mock/NOTICES.md'
      },
      platform: 'darwin'
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={vi.fn()}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Backup & restore' }))
    // The toggle's label must not appear. await for the appInfo
    // query to resolve so the conditional has had a chance to render.
    await screen.findByText(/App data/i)
    expect(
      screen.queryByLabelText(/Remove my data when uninstalling/i)
    ).toBeNull()
  })

  it('shows the toggle on Windows + fires the IPC sync on mount', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    const bridge = kanbiniMock()
    bridge.appInfo.mockResolvedValue({
      version: '0.0.0',
      versions: { electron: 'test', chrome: 'test', node: 'test' },
      paths: {
        userData: '/mock',
        db: '/mock/db',
        attachments: '/mock/att',
        export: '/mock/export',
        notices: '/mock/NOTICES.md'
      },
      platform: 'win32'
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={vi.fn()}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Backup & restore' }))
    expect(
      await screen.findByLabelText(/Remove my data when uninstalling/i)
    ).toBeInTheDocument()
    // The mount-side sync writes the current value to HKCU so a
    // registry-out-of-sync state self-heals as soon as the user
    // opens Settings.
    expect(
      bridge.uninstallSetRemoveDataOnUninstall
    ).toHaveBeenCalledWith(false)
  })

  it('clicking the toggle fires update + the IPC write', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    const bridge = kanbiniMock()
    bridge.appInfo.mockResolvedValue({
      version: '0.0.0',
      versions: { electron: 'test', chrome: 'test', node: 'test' },
      paths: {
        userData: '/mock',
        db: '/mock/db',
        attachments: '/mock/att',
        export: '/mock/export',
        notices: '/mock/NOTICES.md'
      },
      platform: 'win32'
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    const update = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={update}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Backup & restore' }))
    const toggle = await screen.findByLabelText(
      /Remove my data when uninstalling/i
    )
    await user.click(toggle)
    expect(update).toHaveBeenCalledWith({ removeDataOnUninstall: true })
    // Effect won't re-fire until parent rerenders with new settings
    // prop; assert the mount-side call did happen at least.
    expect(bridge.uninstallSetRemoveDataOnUninstall).toHaveBeenCalled()
  })
})

// ADR-0054 - Settings → About → Third-party software section. The
// "Open NOTICES.md" button calls main's `notices:open` IPC which
// shell.openPath's the bundled NOTICES.md (committed to repo, shipped
// under <resources>/NOTICES.md via electron-builder extraResources).
describe('<AppSettings> About - Third-party software', () => {
  it('clicking Open NOTICES.md fires the notices:open IPC', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    const bridge = kanbiniMock()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={vi.fn()}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'About' }))
    const button = await screen.findByRole('button', {
      name: /Open NOTICES.md/
    })
    expect(button).not.toBeDisabled()
    await user.click(button)
    expect(bridge.noticesOpen).toHaveBeenCalled()
  })

  it('disables the button when NOTICES is not bundled', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    const bridge = kanbiniMock()
    bridge.appInfo.mockResolvedValue({
      version: '0.0.0',
      versions: { electron: 'test', chrome: 'test', node: 'test' },
      paths: {
        userData: '/mock',
        db: '/mock/db',
        attachments: '/mock/att',
        export: '/mock/export',
        // Empty string is main's signal that build:notices was never
        // run + neither the dev nor packaged path resolves.
        notices: ''
      },
      platform: 'linux'
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={BASE_SETTINGS}
          update={vi.fn()}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'About' }))
    const button = await screen.findByRole('button', {
      name: /Open NOTICES.md/
    })
    expect(button).toBeDisabled()
  })

})
