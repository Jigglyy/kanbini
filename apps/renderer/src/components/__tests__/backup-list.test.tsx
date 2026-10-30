import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BackupInfo, ImportSummary } from '@kanbini/shared'
import { BackupList, backupWhen } from '../backup-list'
import { renderWithQuery } from '../../__tests__/_render'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Settings > Backup & restore > Daily backups: the list of dated backups
// and its Restore (with an inline confirm). The backups themselves are
// @kanbini/db backups.test.ts.

const at = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).getTime()

describe('backupWhen', () => {
  const now = at(2026, 10, 30, 12, 0)
  it('says Today / Yesterday, then the date', () => {
    expect(backupWhen(at(2026, 10, 30, 9, 5), now)).toMatch(/^Today, /)
    expect(backupWhen(at(2026, 10, 29, 23, 59), now)).toMatch(/^Yesterday, /)
    const older = backupWhen(at(2026, 10, 27, 18, 4), now)
    expect(older).not.toMatch(/Today|Yesterday/)
    expect(older).toMatch(/27/)
  })
})

function backup(over: Partial<BackupInfo>): BackupInfo {
  return { name: '2026-10-30', kind: 'daily', takenAt: Date.now(), boards: 2, cards: 14, ...over }
}

const summary: ImportSummary = {
  importedAt: 0,
  sourceRoot: '/b',
  formatVersion: 2,
  counts: {
    projects: 1,
    boards: 2,
    lists: 4,
    cards: 14,
    labels: 0,
    cardLabels: 0,
    cardDependencies: 0,
    checklists: 0,
    checklistItems: 0,
    comments: 0,
    attachments: 0,
    activities: 0,
    descriptionsFromMd: 0,
    attachmentFilesCopied: 0
  }
}

describe('<BackupList>', () => {
  it('says when there are none yet', async () => {
    renderWithQuery(<BackupList folder="/u/backups" />)
    expect(await screen.findByText(/No backups yet/)).toBeInTheDocument()
    expect(screen.getByText('/u/backups')).toBeInTheDocument()
  })

  it('lists each backup with what it holds, marking the safety copies', async () => {
    kanbiniMock().backupsList.mockResolvedValue([
      backup({ name: '2026-10-30_14-02-09-before-restore', kind: 'before-restore', cards: 20 }),
      backup({ name: '2026-10-29', takenAt: Date.now() - 86_400_000, boards: 1, cards: 1 })
    ])
    renderWithQuery(<BackupList />)
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Before a restore')).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('2 boards · 20 cards')
    expect(rows[1]).toHaveTextContent(/^Yesterday/)
    expect(rows[1]).toHaveTextContent('1 board · 1 card')
  })

  it('restores only after the confirm, then says what came back', async () => {
    const user = userEvent.setup()
    const k = kanbiniMock()
    k.backupsList.mockResolvedValue([backup({})])
    k.backupsRestore.mockResolvedValue(summary)
    renderWithQuery(<BackupList />)
    await user.click(await screen.findByRole('button', { name: 'Restore…' }))
    expect(k.backupsRestore).not.toHaveBeenCalled()
    expect(screen.getByText('Replace everything with this?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(k.backupsRestore).toHaveBeenCalledWith({ name: '2026-10-30' })
    expect(await screen.findByText(/Restored Today/)).toHaveTextContent('2 boards, 14 cards')
    // The list is fetched again: the restore added a safety copy.
    await waitFor(() => expect(k.backupsList).toHaveBeenCalledTimes(2))
  })

  it('Cancel backs out of the confirm', async () => {
    const user = userEvent.setup()
    const k = kanbiniMock()
    k.backupsList.mockResolvedValue([backup({})])
    renderWithQuery(<BackupList />)
    await user.click(await screen.findByRole('button', { name: 'Restore…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Restore…' })).toBeInTheDocument()
    expect(k.backupsRestore).not.toHaveBeenCalled()
  })

  it('shows a failed restore', async () => {
    const user = userEvent.setup()
    const k = kanbiniMock()
    k.backupsList.mockResolvedValue([backup({})])
    k.backupsRestore.mockRejectedValue(new Error('disk full'))
    renderWithQuery(<BackupList />)
    await user.click(await screen.findByRole('button', { name: 'Restore…' }))
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('disk full')).toBeInTheDocument()
  })
})
