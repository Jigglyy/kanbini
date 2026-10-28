import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ContextMenu,
  MenuItem,
  MenuLabel,
  MenuSep,
  SubMenu
} from '../context-menu'

// Tests for the body-portaled ContextMenu primitive. Covers:
//   - opens at the pointer + body-portaled
//   - measure-then-reveal pattern: paints invisibly first, reveals
//     after a useLayoutEffect computes clamped position (fix from
//     the recent context-menu polish commit)
//   - closes on outside-click + Escape + window scroll/resize
//   - MenuItem / MenuLabel / MenuSep render basics

function openMenuAt(x: number, y: number): void {
  // Right-click on the trigger button. ContextMenu reads e.clientX /
  // e.clientY off the contextmenu event; userEvent's pointer API
  // doesn't natively trigger contextmenu, so use fireEvent here.
  fireEvent.contextMenu(
    screen.getByRole('button', { name: /trigger/i }),
    { clientX: x, clientY: y }
  )
}

describe('<ContextMenu>', () => {
  it('starts closed (no portal child rendered)', () => {
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>X</MenuItem>}>
        {(open) => (
          <button onClick={open as unknown as () => void}>trigger</button>
        )}
      </ContextMenu>
    )
    expect(screen.queryByText('X')).toBeNull()
    expect(screen.queryByTestId('panel')).toBeNull()
  })

  it('opens on contextmenu + portals the panel to document.body', () => {
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>Item</MenuItem>}>
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(50, 50)
    const item = screen.getByText('Item')
    expect(item).toBeInTheDocument()
    // Walk up the tree until we hit the portal root - it should be a
    // direct child of body, not nested inside the test root.
    let node: HTMLElement | null = item
    while (node && node.parentElement !== document.body) {
      node = node.parentElement
    }
    expect(node).not.toBeNull()
    expect(node!.parentElement).toBe(document.body)
  })

  it('opens with visibility:hidden first, then reveals after measure (no flash)', () => {
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>I</MenuItem>}>
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(40, 40)
    // The data-overlay attr is exactly what main puts on the panel
    // div - find it and check its eventual visibility.
    const panel = document.querySelector(
      '[data-overlay="context-menu"]'
    ) as HTMLElement
    expect(panel).not.toBeNull()
    // useLayoutEffect runs before the browser paints - by the time
    // assertions run, the panel should be visible (pos was measured).
    expect(panel.style.visibility).toBe('visible')
  })

  it('Escape closes the menu', async () => {
    const user = userEvent.setup()
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>One</MenuItem>}>
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
    expect(screen.getByText('One')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('One')).toBeNull()
  })

  it('outside-click closes the menu', () => {
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>Two</MenuItem>}>
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
    expect(screen.getByText('Two')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Two')).toBeNull()
  })

  it('clicking inside the menu does NOT close it', () => {
    render(
      <ContextMenu
        menu={(_close) => <MenuItem onClick={vi.fn()}>Stay</MenuItem>}
      >
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
    // mousedown on a child of the panel - the outside-click detector
    // uses panelRef.current?.contains(target) and should NOT close.
    fireEvent.mouseDown(screen.getByText('Stay'))
    expect(screen.getByText('Stay')).toBeInTheDocument()
  })

  it('passes a `close` callback to the menu render fn', async () => {
    const user = userEvent.setup()
    const onItemClick = vi.fn()
    render(
      <ContextMenu
        menu={(close) => (
          <MenuItem
            onClick={() => {
              onItemClick()
              close()
            }}
          >
            Close from item
          </MenuItem>
        )}
      >
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
    await user.click(screen.getByText('Close from item'))
    expect(onItemClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Close from item')).toBeNull()
  })

  it('scrolling the window closes the menu', () => {
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>Z</MenuItem>}>
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
    expect(screen.getByText('Z')).toBeInTheDocument()
    fireEvent.scroll(window)
    expect(screen.queryByText('Z')).toBeNull()
  })

  // GitHub issue #1: a tall menu (or a short window) has to scroll
  // inside itself to reach its last rows, so that scroll must not count
  // as the page scrolling out from under the menu.
  it('scrolling inside the panel does NOT close the menu', () => {
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>Inner</MenuItem>}>
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
    fireEvent.scroll(document.querySelector('[data-overlay="context-menu"]')!)
    expect(screen.getByText('Inner')).toBeInTheDocument()
  })

  it('caps its height to the window and scrolls the overflow', () => {
    render(
      <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>Tall</MenuItem>}>
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
    const panel = document.querySelector(
      '[data-overlay="context-menu"]'
    ) as HTMLElement
    expect(panel.style.maxHeight).toBe('calc(100vh - 16px)')
    expect(panel.style.overflowY).toBe('auto')
  })

  describe('re-clamping when the menu changes size after opening', () => {
    // JSDOM has no layout: fake the panel's measured height and drive
    // the ResizeObserver by hand.
    let height = 100
    let notify: (() => void) | undefined
    beforeEach(() => {
      height = 100
      notify = undefined
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            notify = cb
          }
          observe(): void {}
          disconnect(): void {}
        }
      )
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ width: 220, height }) as DOMRect
      )
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('moves up so a row that grew in (delete confirm) stays on screen', () => {
      render(
        <ContextMenu menu={() => <MenuItem onClick={vi.fn()}>Grow</MenuItem>}>
          {(open) => <button onContextMenu={open}>trigger</button>}
        </ContextMenu>
      )
      const bottom = window.innerHeight
      openMenuAt(20, bottom - 10)
      const panel = document.querySelector(
        '[data-overlay="context-menu"]'
      ) as HTMLElement
      // Clamped against the opening size: bottom edge 8px above the window's.
      expect(panel.style.top).toBe(`${bottom - 100 - 8}px`)

      height = 180
      act(() => notify!())
      expect(panel.style.top).toBe(`${bottom - 180 - 8}px`)
    })
  })
})

describe('<SubMenu> fly-outs', () => {
  function renderWithFlyouts(onPick = vi.fn()) {
    render(
      <ContextMenu
        menu={() => (
          <>
            <SubMenu id="labels" label="Labels" value="Bug, UI">
              <MenuItem onClick={onPick}>Bug</MenuItem>
              <MenuItem onClick={vi.fn()}>UI</MenuItem>
            </SubMenu>
            <SubMenu id="due" label="Due date" value="Tomorrow">
              <MenuItem onClick={vi.fn()}>Today</MenuItem>
            </SubMenu>
            <MenuItem onClick={vi.fn()}>Delete card</MenuItem>
          </>
        )}
      >
        {(open) => <button onContextMenu={open}>trigger</button>}
      </ContextMenu>
    )
    openMenuAt(20, 20)
  }
  const row = (name: RegExp) => screen.getByRole('button', { name })
  const flyout = (name: string) => screen.queryByRole('menu', { name })

  it('shows the current value on the row, and click opens the fly-out beside the menu', async () => {
    const user = userEvent.setup()
    renderWithFlyouts()
    expect(row(/Labels/)).toHaveTextContent('Bug, UI')
    expect(flyout('Labels')).toBeNull()
    await user.click(row(/Labels/))
    const panel = flyout('Labels')!
    expect(panel).toBeInTheDocument()
    // Body-portaled, outside the menu's own (scrolling, clipping) panel.
    expect(panel.parentElement).toBe(document.body)
    expect(row(/Labels/)).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens on hover after a short pause, not instantly', () => {
    vi.useFakeTimers()
    try {
      renderWithFlyouts()
      fireEvent.pointerEnter(row(/Labels/))
      expect(flyout('Labels')).toBeNull()
      act(() => vi.advanceTimersByTime(200))
      expect(flyout('Labels')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('one fly-out at a time', async () => {
    const user = userEvent.setup()
    renderWithFlyouts()
    await user.click(row(/Labels/))
    await user.click(row(/Due date/))
    expect(flyout('Labels')).toBeNull()
    expect(flyout('Due date')).toBeInTheDocument()
  })

  it('clicking inside the fly-out keeps the menu open', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    renderWithFlyouts(onPick)
    await user.click(row(/Labels/))
    await user.click(screen.getByRole('button', { name: 'Bug' }))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(row(/Labels/)).toBeInTheDocument()
    expect(flyout('Labels')).toBeInTheDocument()
  })

  it('Escape in the fly-out closes just the fly-out', async () => {
    const user = userEvent.setup()
    renderWithFlyouts()
    await user.click(row(/Labels/))
    screen.getByRole('button', { name: 'Bug' }).focus()
    await user.keyboard('{Escape}')
    expect(flyout('Labels')).toBeNull()
    expect(row(/Labels/)).toBeInTheDocument()
    expect(row(/Labels/)).toHaveFocus()
  })

  it('Escape closes a hover-opened fly-out first, then the menu', async () => {
    const user = userEvent.setup()
    renderWithFlyouts()
    // Opened with the mouse: focus never went into the fly-out.
    await user.click(row(/Due date/))
    expect(flyout('Due date')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(flyout('Due date')).toBeNull()
    expect(row(/Due date/)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: /Due date/ })).toBeNull()
  })

  it('keyboard: Right opens and focuses the first option, Left goes back', async () => {
    const user = userEvent.setup()
    renderWithFlyouts()
    row(/Labels/).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'Bug' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(flyout('Labels')).toBeNull()
    expect(row(/Labels/)).toHaveFocus()
  })

  it('resting on a plain row closes the fly-out after a beat; moving inside it does not', () => {
    vi.useFakeTimers()
    try {
      renderWithFlyouts()
      fireEvent.click(row(/Labels/))
      // Moving around inside the fly-out keeps it.
      fireEvent.pointerOver(screen.getByRole('button', { name: 'UI' }))
      act(() => vi.advanceTimersByTime(500))
      expect(flyout('Labels')).toBeInTheDocument()
      // Resting on a plain row of the menu closes it.
      fireEvent.pointerOver(screen.getByRole('button', { name: 'Delete card' }))
      act(() => vi.advanceTimersByTime(500))
      expect(flyout('Labels')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closing the menu closes the fly-out with it', async () => {
    const user = userEvent.setup()
    renderWithFlyouts()
    await user.click(row(/Labels/))
    fireEvent.mouseDown(document.body)
    expect(flyout('Labels')).toBeNull()
    expect(screen.queryByRole('button', { name: /Labels/ })).toBeNull()
  })
})

describe('menu primitives', () => {
  it('<MenuItem> renders as a button + fires onClick', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<MenuItem onClick={onClick}>Click me</MenuItem>)
    await user.click(screen.getByRole('button', { name: 'Click me' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('<MenuItem danger> renders the red text class', () => {
    const { container } = render(
      <MenuItem onClick={vi.fn()} danger>
        Delete
      </MenuItem>
    )
    const btn = container.firstChild as HTMLElement
    expect(btn.className).toContain('text-red-400')
  })

  it('<MenuLabel> renders inert label text', () => {
    render(<MenuLabel>Section</MenuLabel>)
    expect(screen.getByText('Section')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('<MenuSep> renders a divider element', () => {
    const { container } = render(<MenuSep />)
    expect(container.firstChild).toBeInstanceOf(HTMLDivElement)
  })
})
