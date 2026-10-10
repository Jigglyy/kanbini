import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppSettings } from '../app-settings'
import type { Settings } from '../../lib/settings'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the Settings screen's sidebar nav - specifically the
// SECTION_GROUPS structure landed by the recent regroup
// (Personalize / Boards & cards / Connections / header-less tail).
// The per-section content has its own tests (templates, labels, etc.);
// this file covers nav + persistence + the relabel pass.

const BASE_SETTINGS: Settings = {
  hasSeenWelcome: true,
  removeDataOnUninstall: false,
  theme: 'system',
  weekStart: 'locale',
  startMode: 'home',
  startBoardId: null,
  cardLimitBlocksCreate: false,
  cardLimitBlocksDrag: false,
  showChecklistOnCard: false,
  listsScrollSeparately: true,
  labelsExpanded: false,
  showCardNumbers: true,
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

// M5-B / ADR-0049 - the "Remove my data when uninstalling" toggle in
// Settings → Backup & restore. Only the NSIS uninstaller can act on it,
// so it shows only in an INSTALLED copy (appInfo.installed: main sees
// the uninstaller next to Kanbini.exe). The portable folder (ADR-0071)
// has no uninstaller: no toggle, and nothing written to the registry.
// The mock bridge defaults to installed: false.
function mockAppInfo(installed: boolean) {
  return {
    version: '0.0.0',
    versions: { electron: 'test', chrome: 'test', node: 'test' },
    paths: {
      userData: '/mock',
      db: '/mock/db',
      attachments: '/mock/att',
      export: '/mock/export',
      notices: '/mock/NOTICES.md'
    },
    platform: 'win32',
    installed
  }
}

describe('<AppSettings> Backup & restore - uninstall toggle', () => {
  it('is hidden in the portable app, which never touches the registry', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    const bridge = kanbiniMock()
    bridge.appInfo.mockResolvedValue(mockAppInfo(false))
    renderAppSettings()
    await user.click(screen.getByRole('button', { name: 'Backup & restore' }))
    // Wait for appInfo so a gated section would have rendered.
    await screen.findByText(/App data/i)
    expect(screen.queryByLabelText(/Remove my data when uninstalling/i)).toBeNull()
    expect(bridge.uninstallSetRemoveDataOnUninstall).not.toHaveBeenCalled()
  })

  it('shows in an installed copy and syncs the choice to the registry on mount', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    const bridge = kanbiniMock()
    bridge.appInfo.mockResolvedValue(mockAppInfo(true))
    renderAppSettings()
    await user.click(screen.getByRole('button', { name: 'Backup & restore' }))
    expect(
      await screen.findByLabelText(/Remove my data when uninstalling/i)
    ).toBeInTheDocument()
    // The mount-side sync writes the current value to HKCU so a
    // registry-out-of-sync state self-heals as soon as Settings opens.
    expect(bridge.uninstallSetRemoveDataOnUninstall).toHaveBeenCalledWith(false)
  })

  it('clicking it updates the setting', async () => {
    const user = userEvent.setup()
    const { kanbiniMock } = await import('../../__tests__/_kanbini-mock')
    const bridge = kanbiniMock()
    bridge.appInfo.mockResolvedValue(mockAppInfo(true))
    const update = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings onClose={vi.fn()} settings={BASE_SETTINGS} update={update} />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Backup & restore' }))
    await user.click(await screen.findByLabelText(/Remove my data when uninstalling/i))
    expect(update).toHaveBeenCalledWith({ removeDataOnUninstall: true })
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
      platform: 'linux',
      installed: false
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

describe('<AppSettings> Cards section', () => {
  it('offers "Scroll each list on its own", reflecting and updating the setting', async () => {
    const user = userEvent.setup()
    const update = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={{ ...BASE_SETTINGS, listsScrollSeparately: true }}
          update={update}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Cards' }))
    const toggle = screen.getByRole('checkbox', { name: /Scroll each list on its own/ })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(update).toHaveBeenCalledWith({ listsScrollSeparately: false })
  })
})

describe('<AppSettings> Cards - card numbers', () => {
  it('offers "Show card numbers", reflecting and updating the setting', async () => {
    const user = userEvent.setup()
    const update = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={{ ...BASE_SETTINGS, showCardNumbers: true }}
          update={update}
        />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Cards' }))
    const toggle = screen.getByRole('checkbox', { name: /Show card numbers/ })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(update).toHaveBeenCalledWith({ showCardNumbers: false })
  })
})

describe('<AppSettings> AI integration - Claude Code plugin', () => {
  it('shows the two commands that install the Kanbini plugin', async () => {
    const user = userEvent.setup()
    renderAppSettings()
    await user.click(screen.getByRole('button', { name: 'AI integration' }))
    expect(await screen.findByText(/using claude code\?/i)).toBeInTheDocument()
    expect(
      screen.getByText(/\/plugin marketplace add Jigglyy\/kanbini/)
    ).toHaveTextContent(
      '/plugin marketplace add Jigglyy/kanbini /plugin install kanbini@kanbini'
    )
  })
})

describe('<AppSettings> Cards - week start', () => {
  it('picks the first day of the week for the due-date shortcuts', async () => {
    const user = userEvent.setup()
    const update = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings onClose={vi.fn()} settings={BASE_SETTINGS} update={update} />
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Cards' }))
    const select = screen.getByRole('combobox', { name: /week starts on/i })
    expect(select).toHaveValue('locale')
    await user.selectOptions(select, 'sunday')
    expect(update).toHaveBeenCalledWith({ weekStart: 'sunday' })
  })
})

describe('<AppSettings> Startup - a specific board', () => {
  function renderWith(settings: Partial<Settings>, update = vi.fn()) {
    kanbiniMock().listBoards.mockResolvedValue([
      { id: 'b-old', name: 'Old', archived: true } as never,
      { id: 'b1', name: 'Work', archived: false } as never,
      { id: 'b2', name: 'Home', archived: false } as never
    ])
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    render(
      <QueryClientProvider client={qc}>
        <AppSettings
          onClose={vi.fn()}
          settings={{ ...BASE_SETTINGS, ...settings }}
          update={update}
        />
      </QueryClientProvider>
    )
    return { update, qc }
  }

  it('choosing it pre-picks the first unarchived board', async () => {
    const user = userEvent.setup()
    const { update, qc } = renderWith({})
    await user.click(screen.getByRole('button', { name: 'Startup' }))
    await waitFor(() => expect(qc.getQueryData(['boardsList'])).toBeDefined())
    await user.click(screen.getByRole('radio', { name: /a specific board/i }))
    expect(update).toHaveBeenCalledWith({ startMode: 'board', startBoardId: 'b1' })
  })

  it('lists only unarchived boards and switches the pick', async () => {
    const user = userEvent.setup()
    const { update } = renderWith({ startMode: 'board', startBoardId: 'b1' })
    await user.click(screen.getByRole('button', { name: 'Startup' }))
    const select = await screen.findByRole('combobox', { name: /board to open/i })
    await waitFor(() =>
      expect(Array.from((select as HTMLSelectElement).options).map((o) => o.text)).toEqual([
        'Work',
        'Home'
      ])
    )
    await user.selectOptions(select, 'b2')
    expect(update).toHaveBeenCalledWith({ startBoardId: 'b2' })
  })
})
