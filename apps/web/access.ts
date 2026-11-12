// Who may send what to the gateway: what a workspace viewer may call, and
// which requests a browser can only have sent from another site. Pure, so
// access.test.ts covers it without starting the gateway.
import type { IncomingHttpHeaders } from 'node:http'

// What a viewer may call: reading, plus the app's own bookkeeping. Anything
// else (and anything upstream adds later) is refused for viewers.
export const VIEWER_CHANNELS: ReadonlySet<string> = new Set([
  'boards:list', 'board:getView', 'search:cards', 'agenda:get', 'archived:get', 'undo:status',
  'backups:list', 'template:list', 'board:export', 'app:info', 'mcp:info', 'window:prefs',
  'tray:recentBoards', 'shell:showInFolder', 'notices:open'
])

// The MCP tools a viewer's AI may use: the read-only ones.
export const VIEWER_TOOLS: ReadonlySet<string> = new Set([
  'kanbini_list_boards', 'kanbini_get_board', 'kanbini_get_card', 'kanbini_get_list_cards',
  'kanbini_get_agenda', 'kanbini_search_cards', 'kanbini_list_archived'
])

export const VIEW_ONLY = 'You can only view this workspace. Ask its owner or a manager for edit access.'

/** True when a browser sent this request from a page on another site (or
 *  another port or subdomain of this one), which is what a forged request
 *  looks like. Session cookies are SameSite=Lax, but "site" ignores the port
 *  and the subdomain, so another service on the same NAS or domain counts as
 *  the same site; this compares the exact origin.
 *
 *  Browsers send Sec-Fetch-Site on every request; older ones send at least an
 *  Origin with a cross-origin POST. A request with neither didn't come from a
 *  browser, so no signed-in browser's cookie can be riding along on it. */
export function crossSite(headers: IncomingHttpHeaders): boolean {
  const site = headers['sec-fetch-site']
  if (site !== undefined) return site !== 'same-origin' && site !== 'none'
  const origin = headers.origin
  if (origin === undefined) return false
  try {
    return new URL(origin).host !== headers.host
  } catch {
    return true // `Origin: null` (a sandboxed frame, a privacy redirect) or garbage
  }
}
