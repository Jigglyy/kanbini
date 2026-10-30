import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BoardExportDialog, splitPath } from '../board-export'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// The export dialog: pick 'Just the lists' or 'Lists and all cards',
// main asks where to save and writes the file (@kanbini/db
// board-file.test.ts covers the file itself).

const renderDialog = (onClose = vi.fn()) =>
  render(<BoardExportDialog boardId="b1" boardName="Garden" onClose={onClose} />)

describe('splitPath', () => {
  it('splits on either separator', () => {
    expect(splitPath('C:\\Users\\me\\Documents\\Garden.kanbini')).toEqual({
      name: 'Garden.kanbini',
      folder: 'C:\\Users\\me\\Documents'
    })
    expect(splitPath('/home/me/Garden.kanbini')).toEqual({
      name: 'Garden.kanbini',
      folder: '/home/me'
    })
    expect(splitPath('Garden.kanbini')).toEqual({ name: 'Garden.kanbini', folder: '' })
  })
})

describe('<BoardExportDialog>', () => {
  it('exports everything by default', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderDialog()
    expect(screen.getByRole('radio', { name: /lists and all cards/i })).toBeChecked()
    await user.click(screen.getByRole('button', { name: /^export…$/i }))
    expect(mock.boardExport).toHaveBeenCalledWith({ boardId: 'b1', content: 'cards' })
  })

  it('exports just the lists when picked', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderDialog()
    await user.click(screen.getByRole('radio', { name: /just the lists/i }))
    await user.click(screen.getByRole('button', { name: /^export…$/i }))
    expect(mock.boardExport).toHaveBeenCalledWith({ boardId: 'b1', content: 'lists' })
  })

  it('stays open when the save dialog is cancelled', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    kanbiniMock().boardExport.mockResolvedValueOnce(null)
    renderDialog(onClose)
    await user.click(screen.getByRole('button', { name: /^export…$/i }))
    expect(screen.getByRole('heading', { name: 'Export “Garden”' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says where the file went and can show it', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    const path = 'C:\\Users\\me\\Documents\\Garden.kanbini'
    mock.boardExport.mockResolvedValueOnce({ path, bytes: 2048, skippedAttachments: 0 })
    renderDialog()
    await user.click(screen.getByRole('button', { name: /^export…$/i }))
    expect(await screen.findByRole('heading', { name: 'Exported “Garden”' })).toBeInTheDocument()
    expect(screen.getByText('Garden.kanbini')).toBeInTheDocument()
    expect(screen.getByText('C:\\Users\\me\\Documents')).toBeInTheDocument()
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument()
    expect(screen.queryByText(/missing from this computer/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /show in folder/i }))
    expect(mock.showInFolder).toHaveBeenCalledWith({ path })
  })

  it('mentions attachments that were missing', async () => {
    const user = userEvent.setup()
    kanbiniMock().boardExport.mockResolvedValueOnce({
      path: '/tmp/Garden.kanbini',
      bytes: 10,
      skippedAttachments: 2
    })
    renderDialog()
    await user.click(screen.getByRole('button', { name: /^export…$/i }))
    expect(
      await screen.findByText(/2 attachments are missing from this computer/)
    ).toBeInTheDocument()
  })

  it('shows an error and lets you try again', async () => {
    const user = userEvent.setup()
    kanbiniMock().boardExport.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    renderDialog()
    await user.click(screen.getByRole('button', { name: /^export…$/i }))
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^export…$/i })).toBeEnabled()
  })
})
