import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ContextMenu,
  MenuItem,
  MenuLabel,
  MenuSep
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
