import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ListView, Mutation } from '@kanbini/shared'
import { ACCENTS } from '../../lib/palette'
import { ListEditor } from '../list-menu'
import { ContextMenu } from '../ui/context-menu'

// Tests for the ListEditor - the body of the per-list pencil / right-
// click context menu. Covers the surfaces three ADRs converge on:
//   - rename via input
//   - color pick (ACCENTS swatches + "None")
//   - sort cards: Manual + created / added / due / title / priority
//     modes (ADR-0032 + follow-up)
//   - card limit (wip limit) with positive-integer validation (ADR-0026)
//   - on-card-enter automation (ADR-0041): None / Complete / Uncomplete
//   - "Save as template" (only renders when onSaveAsTemplate is supplied)
//   - delete with inline confirm

/** Open the menu for real: its fly-out rows need a ContextMenu around
 *  them. The editor's own `close` prop stays the test's spy. */
function renderMenu(node: React.ReactElement): void {
  render(
    <ContextMenu menu={() => node}>
      {(open) => <button onContextMenu={open}>open menu</button>}
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByRole('button', { name: 'open menu' }), {
    clientX: 10,
    clientY: 10
  })
}
/** Open the fly-out whose row starts with `label`. */
function openFlyout(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }))
}

function makeList(overrides: Partial<ListView> = {}): ListView {
  return {
    id: 'list-1',
    name: 'Todo',
    color: null,
    closed: false,
    position: 'a',
    wipLimit: null,
    sortMode: null,
    onEnter: null,
    cardDensity: null,
    visibleCardLimit: null,
    cards: [],
    ...overrides
  }
}

describe('<ListEditor>', () => {
  it('rename commits the new value through list.update on blur', () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    const input = screen.getByDisplayValue('Todo')
    fireEvent.change(input, { target: { value: 'Doing' } })
    fireEvent.blur(input)
    expect(apply).toHaveBeenCalledWith(
      {
        type: 'list.update',
        id: 'list-1',
        patch: { name: 'Doing' }
      },
      expect.any(Function)
    )
  })

  it('rename via Enter blurs the input + commits', () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={close} />)
    const input = screen.getByDisplayValue('Todo')
    fireEvent.change(input, { target: { value: 'Doing' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Enter fires close (per the source); blur runs the rename.
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('rename no-ops when the trimmed value matches current name', () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    const input = screen.getByDisplayValue('Todo')
    fireEvent.change(input, { target: { value: '  Todo  ' } })
    fireEvent.blur(input)
    expect(apply).not.toHaveBeenCalled()
  })

  it('color picker swatch fires list.update + closes the menu', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={close} />)
    openFlyout('Colour')
    // First swatch (ACCENTS[0]) is the first aria-label matching
    // /Colour /.
    const swatches = screen.getAllByLabelText(/^Colour /)
    await user.click(swatches[0]!)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'list.update',
        id: 'list-1',
        patch: expect.objectContaining({ color: expect.stringContaining('oklch') })
      }),
      expect.any(Function)
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('clicking the already-selected colour is a no-op (no mutation, still closes)', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    // A list already on a standard swatch colour: that swatch is the
    // ring'd current one. Clicking it must not fire a redundant
    // list.update (which would log a junk undo entry).
    const color = ACCENTS[0]
    renderMenu(<ListEditor list={makeList({ color })} apply={apply} close={close} />)
    openFlyout('Colour')
    await user.click(screen.getByLabelText(`Colour ${color}`))
    expect(apply).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('"None" colour clears the list colour', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <ListEditor
        list={makeList({ color: 'oklch(0.62 0.15 250)' })}
        apply={apply}
        close={vi.fn()}
      />
    )
    openFlyout('Colour')
    // Two "None" buttons in the editor - the colour row's + the
    // on-enter row's. The colour one is first in DOM order.
    const noneButtons = screen.getAllByRole('button', { name: 'None' })
    await user.click(noneButtons[0]!)
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { color: null }
    })
  })

  it('sort cards: clicking "Newest created" fires list.update with created-desc', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    openFlyout('Sort cards')
    await user.click(screen.getByRole('button', { name: 'Newest created' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { sortMode: 'created-desc' }
    })
  })

  it('sort cards: "Recently added" fires the added-desc mode', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    openFlyout('Sort cards')
    await user.click(screen.getByRole('button', { name: 'Recently added' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { sortMode: 'added-desc' }
    })
  })

  it('sort cards: "Due date" / "Priority" / "A to Z" wire their modes', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    openFlyout('Sort cards')
    await user.click(screen.getByRole('button', { name: 'Due date' }))
    await user.click(screen.getByRole('button', { name: 'Priority' }))
    await user.click(screen.getByRole('button', { name: 'A to Z' }))
    expect(apply.mock.calls.map((c) => c[0])).toEqual([
      { type: 'list.update', id: 'list-1', patch: { sortMode: 'due-asc' } },
      { type: 'list.update', id: 'list-1', patch: { sortMode: 'priority-desc' } },
      { type: 'list.update', id: 'list-1', patch: { sortMode: 'title-asc' } }
    ])
  })

  it('sort cards: clicking the already-active mode is a no-op (close only)', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(
      <ListEditor
        list={makeList({ sortMode: 'created-desc' })}
        apply={apply}
        close={close}
      />
    )
    openFlyout('Sort cards')
    await user.click(screen.getByRole('button', { name: 'Newest created' }))
    expect(apply).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('sort cards: Manual reverts to null', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <ListEditor
        list={makeList({ sortMode: 'created-desc' })}
        apply={apply}
        close={vi.fn()}
      />
    )
    openFlyout('Sort cards')
    await user.click(screen.getByRole('button', { name: 'Manual' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { sortMode: null }
    })
  })

  it('on-enter: clicking Complete sets the rule', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    openFlyout('On card enter')
    await user.click(screen.getByRole('button', { name: 'Complete' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { onEnter: { kind: 'complete' } }
    })
  })

  it('on-enter: None clears the rule on a list that has one', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <ListEditor
        list={makeList({ onEnter: { kind: 'complete' } })}
        apply={apply}
        close={vi.fn()}
      />
    )
    openFlyout('On card enter')
    await user.click(
      within(screen.getByRole('menu', { name: 'On card enter' })).getByRole('button', {
        name: 'None'
      })
    )
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { onEnter: null }
    })
  })

  it('wip limit: typing a positive integer + clicking Set fires list.update', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    openFlyout('Card limit')
    const input = screen.getByPlaceholderText('None')
    await user.type(input, '5')
    await user.click(screen.getByRole('button', { name: 'Set' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { wipLimit: 5 }
    })
  })

  it('wip limit: clearing the input commits null', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <ListEditor
        list={makeList({ wipLimit: 5 })}
        apply={apply}
        close={vi.fn()}
      />
    )
    openFlyout('Card limit')
    const input = screen.getByDisplayValue('5')
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: 'Set' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.update',
      id: 'list-1',
      patch: { wipLimit: null }
    })
  })

  it('wip limit: rejects a non-positive value (no mutation fires)', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    openFlyout('Card limit')
    const input = screen.getByPlaceholderText('None')
    // type "-1" - number input may reject the minus depending on the
    // browser; for safety set the raw value via change.
    fireEvent.change(input, { target: { value: '-1' } })
    await user.click(screen.getByRole('button', { name: 'Set' }))
    expect(apply).not.toHaveBeenCalled()
  })

  it('Delete shows a confirm row; confirming fires list.delete', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(
      <ListEditor
        list={makeList({ cards: [{} as never, {} as never] })}
        apply={apply}
        close={close}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Delete list' }))
    // After clicking, the confirm row appears with a count.
    expect(screen.getByText(/Delete .* and its 2 cards/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'list.delete',
      id: 'list-1'
    })
    expect(close).toHaveBeenCalled()
  })

  it('Delete Cancel restores the action row + does not delete', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Delete list' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByRole('button', { name: 'Delete list' })
    ).toBeInTheDocument()
    expect(apply).not.toHaveBeenCalled()
  })

  it('"Save as template" only renders when onSaveAsTemplate is supplied', () => {
    renderMenu(
      <ListEditor list={makeList()} apply={vi.fn()} close={vi.fn()} />
    )
    expect(
      screen.queryByRole('button', { name: /save as template/i })
    ).toBeNull()
    cleanup()
    renderMenu(
      <ListEditor
        list={makeList()}
        apply={vi.fn()}
        close={vi.fn()}
        onSaveAsTemplate={vi.fn()}
      />
    )
    expect(
      screen.getByRole('button', { name: /save as template/i })
    ).toBeInTheDocument()
  })

  it('"Save as template" click fires the callback + closes the menu', async () => {
    const user = userEvent.setup()
    const onSaveAsTemplate = vi.fn()
    const close = vi.fn()
    renderMenu(
      <ListEditor
        list={makeList()}
        apply={vi.fn()}
        close={close}
        onSaveAsTemplate={onSaveAsTemplate}
      />
    )
    await user.click(screen.getByRole('button', { name: /save as template/i }))
    expect(onSaveAsTemplate).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Cards: Compact sets the list density with an optimistic projection', async () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={close} />)
    openFlyout('Cards')
    expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compact' }))
    expect(apply).toHaveBeenCalledWith(
      { type: 'list.update', id: 'list-1', patch: { cardDensity: 'compact' } },
      expect.any(Function)
    )
    // The projection flips the cached list's density.
    const project = apply.mock.calls[0]![1] as (b: unknown) => {
      lists: Array<{ cardDensity: string | null }>
    }
    const projected = project({
      project: { id: 'p', name: 'P' },
      board: { id: 'b', name: 'B', color: null, background: null, swimlaneMode: null },
      labels: [],
      lists: [makeList()]
    })
    expect(projected.lists[0]!.cardDensity).toBe('compact')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Cards: clicking the active density just closes the menu', async () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(
      <ListEditor list={makeList({ cardDensity: 'compact' })} apply={apply} close={close} />
    )
    openFlyout('Cards')
    expect(screen.getByRole('button', { name: 'Compact' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compact' }))
    expect(apply).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Cards: Full clears a compact list back to null', async () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <ListEditor list={makeList({ cardDensity: 'compact' })} apply={apply} close={vi.fn()} />
    )
    openFlyout('Cards')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Full' }))
    expect(apply).toHaveBeenCalledWith(
      { type: 'list.update', id: 'list-1', patch: { cardDensity: null } },
      expect.any(Function)
    )
  })

  it('Show at most: All is active by default, and 20 sets the limit', async () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(<ListEditor list={makeList()} apply={apply} close={vi.fn()} />)
    openFlyout('Cards')
    expect(screen.getByRole('button', { name: 'Show all cards' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show at most 20 cards' }))
    expect(apply).toHaveBeenCalledWith(
      { type: 'list.update', id: 'list-1', patch: { visibleCardLimit: 20 } },
      expect.any(Function)
    )
  })

  it('Show at most: All clears a limit back to null', async () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <ListEditor list={makeList({ visibleCardLimit: 10 })} apply={apply} close={vi.fn()} />
    )
    openFlyout('Cards')
    expect(screen.getByRole('button', { name: 'Show at most 10 cards' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all cards' }))
    expect(apply).toHaveBeenCalledWith(
      { type: 'list.update', id: 'list-1', patch: { visibleCardLimit: null } },
      expect.any(Function)
    )
  })

  it('the rows read the list: sort, cards, on card enter and card limit', () => {
    renderMenu(
      <ListEditor
        list={makeList({
          sortMode: 'due-asc',
          cardDensity: 'compact',
          visibleCardLimit: 10,
          onEnter: { kind: 'complete' },
          wipLimit: 5
        })}
        apply={vi.fn()}
        close={vi.fn()}
      />
    )
    const row = (label: string) =>
      screen.getByRole('button', { name: new RegExp(`^${label}`) })
    expect(row('Colour')).toHaveTextContent('None')
    expect(row('Sort cards')).toHaveTextContent('Due date')
    expect(row('Cards')).toHaveTextContent('Compact · first 10')
    expect(row('On card enter')).toHaveTextContent('Complete')
    expect(row('Card limit')).toHaveTextContent('5')
    // The options wait in the fly-outs.
    expect(screen.queryByRole('button', { name: 'Newest created' })).toBeNull()
  })
})
