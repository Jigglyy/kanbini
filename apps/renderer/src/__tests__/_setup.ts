import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { resetKanbiniMock } from './_kanbini-mock'

// Per-test reset. Three things every renderer test starts from:
//
// 1. Unmount any React roots from the previous test (RTL's `render`
//    leaves them in the JSDOM body otherwise - fine for assertions,
//    bad for tests that look up by role and find the leftover tree).
// 2. Fresh `window.kanbini` bridge mock so an IPC stub set up in
//    test A doesn't leak into test B.
// 3. Clear localStorage so the `useSettings` blob / boards-home sort
//    key / etc. don't carry state across tests.
afterEach(() => {
  cleanup()
})
beforeEach(() => {
  resetKanbiniMock()
  window.localStorage.clear()
  // sessionStorage too - same reasoning; some hooks use it for
  // ephemeral state (e.g. boards-home archived toggle).
  window.sessionStorage.clear()
})

// matchMedia is touched by useSettings (system-theme listener) and
// the dnd-kit pointer sensor. JSDOM exposes the property name as
// `undefined` (so `'matchMedia' in window` is true), not as a real
// function - overwrite unconditionally with a no-op stub matching
// the spec shape so the code under test sees a valid MediaQueryList.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false)
  })
})

// JSDOM doesn't implement Element.scrollIntoView. The command palette
// calls it on keyboard nav to keep the selected row in view; tests
// just need it to be a no-op rather than throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn()
}
