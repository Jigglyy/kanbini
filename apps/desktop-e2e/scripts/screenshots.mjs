// Generate README/marketing screenshots of the real Electron app.
//
// Boots Kanbini against a throwaway userData dir (so it never touches
// the developer's real board), seeds an attractive demo dataset over
// the 127.0.0.1 control channel (the same HTTP API the MCP server
// uses), then drives the renderer to each headline surface and writes
// a PNG per view into docs/screenshots/.
//
// Run after a desktop build is in place:
//   node apps/desktop-e2e/scripts/prepare.mjs      # build + ABI align
//   node apps/desktop-e2e/scripts/screenshots.mjs  # this script
//
// Captured at a 2x device scale factor for crisp output. The window is
// parked off-screen (KANBINI_E2E_HEADLESS=1) so it renders at full rate
// without stealing focus; Playwright screenshots over CDP regardless.

import { _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_ENTRY = resolve(here, '../../desktop/out/main/index.js')
const OUT_DIR = resolve(here, '../../../docs/screenshots')

// The renderer area every shot is framed at (CSS px; 2x on disk).
const VIEW = { width: 1440, height: 900 }

// Due dates are stored as LOCAL midnight (what the date picker writes),
// so "Today" / "Tomorrow" / "Yesterday" read right on the badges.
function day(offset) {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime()
}

// The renderer's accent palette (ACCENT_PALETTE in
// packages/shared/src/palette.ts). The control channel stores a colour
// as given (only the MCP server translates names), so pass the values.
const A = {
  red: 'oklch(0.63 0.19 25)',
  amber: 'oklch(0.76 0.14 85)',
  lime: 'oklch(0.74 0.17 140)',
  green: 'oklch(0.64 0.15 160)',
  teal: 'oklch(0.68 0.10 195)',
  sky: 'oklch(0.69 0.13 230)',
  blue: 'oklch(0.60 0.16 262)',
  indigo: 'oklch(0.56 0.17 292)',
  purple: 'oklch(0.62 0.18 322)'
}

async function waitForDiscovery(userDataDir, timeoutMs = 10_000) {
  const start = Date.now()
  const path = join(userDataDir, 'mcp.json')
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      await sleep(150)
    }
  }
  throw new Error(`mcp.json did not appear at ${path}`)
}

function makeApi(port, token) {
  const base = `http://127.0.0.1:${port}`
  const auth = { Authorization: `Bearer ${token}` }
  return {
    get: (p) => fetch(base + p, { headers: auth }),
    post: async (p, body) => {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        throw new Error(
          `POST ${p} -> ${res.status}: ${await res.text()} for ${JSON.stringify(body).slice(0, 300)}`
        )
      }
      return res.json()
    }
  }
}

// A cover image for one card, drawn in the renderer's own canvas so the
// script needs no image files or extra dependencies: a warm gradient
// with three columns of little cards (it's the "illustrations" card).
function drawCover() {
  const W = 1200
  const H = 560
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const bg = g.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#ffb38a')
  bg.addColorStop(0.5, '#e0679f')
  bg.addColorStop(1, '#6d5cf6')
  g.fillStyle = bg
  g.fillRect(0, 0, W, H)
  const glow = (x, y, r, color) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, color)
    rg.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = rg
    g.fillRect(0, 0, W, H)
  }
  glow(180, 90, 360, 'rgba(255,255,255,0.35)')
  glow(1060, 520, 420, 'rgba(40,20,120,0.35)')
  const rect = (x, y, w, h, r) => {
    g.beginPath()
    g.roundRect(x, y, w, h, r)
  }
  const accents = ['#6d5cf6', '#e0679f', '#f59e0b', '#10b981', '#3b82f6']
  const columns = [
    [300, [92, 64, 118]],
    [515, [72, 120]],
    [730, [104, 70, 64]]
  ]
  let k = 0
  for (const [x, heights] of columns) {
    rect(x, 100, 190, 380, 24)
    g.fillStyle = 'rgba(255,255,255,0.20)'
    g.fill()
    let y = 122
    for (const h of heights) {
      g.save()
      g.shadowColor = 'rgba(30,10,60,0.28)'
      g.shadowBlur = 20
      g.shadowOffsetY = 8
      rect(x + 14, y, 162, h, 14)
      g.fillStyle = 'rgba(255,255,255,0.95)'
      g.fill()
      g.restore()
      rect(x + 30, y + 18, 46, 10, 5)
      g.fillStyle = accents[k++ % accents.length]
      g.fill()
      rect(x + 30, y + 38, 116, 8, 4)
      g.fillStyle = 'rgba(40,30,70,0.18)'
      g.fill()
      if (h > 70) {
        rect(x + 30, y + 54, 80, 8, 4)
        g.fill()
      }
      y += h + 14
    }
  }
  return c.toDataURL('image/png').split(',')[1]
}

async function seed(api, page) {
  const m = (body) => api.post('/mutate', body)

  // Start from a blank slate - drop the auto-seeded Welcome Board so
  // the home grid shows only the demo boards.
  const boards = await (await api.get('/boards')).json()
  const welcome = boards.find((b) => b.name === 'Welcome Board')
  if (welcome) await m({ type: 'board.delete', id: welcome.id })

  // ── Hero board: Product Roadmap ───────────────────────────────────
  const roadmap = await m({ type: 'board.create', name: 'Product Roadmap' })
  await m({
    type: 'board.update',
    id: roadmap.id,
    patch: {
      color: A.indigo,
      background: { kind: 'gradient', preset: 'dusk' },
      pinned: true
    }
  })

  const label = async (name, color) =>
    (await m({ type: 'label.create', boardId: roadmap.id, name, color })).id
  const L = {
    feature: await label('Feature', A.blue),
    bug: await label('Bug', A.red),
    design: await label('Design', A.purple),
    docs: await label('Docs', A.teal),
    research: await label('Research', A.lime)
  }

  const list = (boardId, name, color) => m({ type: 'list.create', boardId, name, color })
  const backlog = await list(roadmap.id, 'Backlog', A.sky)
  const inProgress = await list(roadmap.id, 'In Progress', A.amber)
  const inReview = await list(roadmap.id, 'In Review', A.purple)
  const done = await list(roadmap.id, 'Done', A.green)

  async function card(listId, title, opts = {}) {
    const { priority, labels, due, completed, description, repeat } = opts
    const c = await m({
      type: 'card.create',
      listId,
      title,
      ...(priority ? { priority } : {})
    })
    const patch = {}
    if (due !== undefined) patch.dueAt = due
    if (description !== undefined) patch.description = description
    if (repeat) patch.repeat = repeat
    if (Object.keys(patch).length) await m({ type: 'card.update', id: c.id, patch })
    // Completed on its own so it logs the "completed" activity the
    // agenda's "Recently completed" section reads.
    if (completed) await m({ type: 'card.update', id: c.id, patch: { completed: true } })
    if (labels?.length) await m({ type: 'card.setLabels', id: c.id, labelIds: labels })
    return c.id
  }

  async function checklist(cardId, name, items) {
    const cl = await m({ type: 'checklist.create', cardId, name })
    for (const [text, ticked] of items) {
      const it = await m({ type: 'checklistItem.create', checklistId: cl.id, text })
      if (ticked) {
        await m({ type: 'checklistItem.update', id: it.id, patch: { completed: true } })
      }
    }
  }

  await card(backlog.id, 'Offline-first sync engine', {
    priority: 'high',
    labels: [L.feature, L.research],
    due: day(12)
  })
  const cert = await card(backlog.id, 'Code-signing certificate', {
    priority: 'medium',
    labels: [L.research],
    due: day(0)
  })
  await card(backlog.id, 'Dark mode contrast pass', { priority: 'low', labels: [L.design] })
  await card(backlog.id, 'Keyboard shortcut cheatsheet', { labels: [L.docs] })
  await card(backlog.id, 'SQLite WAL checkpoint stalls', {
    priority: 'medium',
    labels: [L.bug, L.research]
  })

  // The rich card: description, checklist, a "waiting on" link, and a
  // human + an AI comment. It's the one the card-detail shot opens.
  const installer = await card(inProgress.id, 'Ship the Windows installer', {
    priority: 'high',
    labels: [L.feature],
    due: day(1),
    description:
      'One download that just works: an installer, a portable folder, and a ' +
      'single portable `.exe`.\n\n' +
      'A **Which file do I download?** table sits at the top of the ' +
      'downloads page.'
  })
  await checklist(installer, 'Release', [
    ['Build all three downloads in CI', true],
    ['Check every artifact before upload', true],
    ['Write the release notes', false],
    ['Sign the installer', false]
  ])
  await m({ type: 'card.addBlocker', id: installer, blockerId: cert })
  await m({
    type: 'comment.create',
    cardId: installer,
    body: 'Portable zip tested on a clean Windows VM. Starts in under a second.'
  })
  await m({
    type: 'comment.create',
    cardId: installer,
    author: 'ai',
    body:
      'Ticked the two CI items and linked this card to the certificate, ' +
      'since signing is waiting on it.'
  })

  const illustrations = await card(inProgress.id, 'Onboarding illustrations', {
    priority: 'medium',
    labels: [L.design]
  })
  const cover = await page.evaluate(drawCover)
  const att = await api.post('/attachments', {
    cardId: illustrations,
    filename: 'onboarding.png',
    content: cover,
    encoding: 'base64'
  })
  await m({ type: 'card.update', id: illustrations, patch: { coverAttachmentId: att.id } })

  await card(inProgress.id, 'Weekly release notes', {
    labels: [L.docs],
    due: day(3),
    repeat: { unit: 'week', every: 1 }
  })

  await card(inReview.id, 'Export round-trip test', {
    priority: 'medium',
    labels: [L.docs],
    due: day(2)
  })
  await card(inReview.id, 'Label bar overflow on narrow windows', {
    priority: 'urgent',
    labels: [L.bug],
    due: day(-1)
  })

  await card(done.id, 'MCP write tools', { labels: [L.feature], completed: true })
  await card(done.id, 'Board background presets', { labels: [L.design], completed: true })
  await card(done.id, 'Trello import', { labels: [L.feature], completed: true })

  // ── Secondary boards for the home grid + the agenda ───────────────
  async function simpleBoard(name, { color, gradient, lists }) {
    const b = await m({ type: 'board.create', name })
    const patch = {}
    if (color) patch.color = color
    if (gradient) patch.background = { kind: 'gradient', preset: gradient }
    if (Object.keys(patch).length) await m({ type: 'board.update', id: b.id, patch })
    for (const [listName, cards] of lists) {
      const l = await list(b.id, listName)
      for (const c of cards) {
        const [title, opts] = typeof c === 'string' ? [c, {}] : c
        await card(l.id, title, opts)
      }
    }
    return b
  }

  await simpleBoard('Trip to Japan', {
    gradient: 'ocean',
    lists: [
      [
        'Itinerary',
        [['Book flights', { due: day(5), priority: 'high' }], 'Reserve ryokan in Kyoto', 'JR Pass order']
      ],
      ['Packing', ['Power adapters', 'Pocket wifi']],
      ['Booked', ['Tokyo hotel']]
    ]
  })
  await simpleBoard('Reading List', {
    color: A.teal,
    lists: [
      ['To read', ['Designing Data-Intensive Apps', 'Release It!', 'The Pragmatic Programmer']],
      ['Reading', ['Crafting Interpreters']],
      ['Finished', [['Project Hail Mary', { completed: true }]]]
    ]
  })
  await simpleBoard('Home Renovation', {
    gradient: 'sunset',
    lists: [
      ['Quotes', ['Kitchen counters', 'Repaint hallway']],
      ['Scheduled', [['Electrician visit', { due: day(0) }]]]
    ]
  })
  await simpleBoard('Content Calendar', {
    gradient: 'rose',
    lists: [
      ['Ideas', ['Offline-first deep dive', 'MCP walkthrough video', 'Release recap video']],
      ['Drafting', [['Release blog post', { due: day(4) }]]],
      ['Published', ['Why local-first matters']]
    ]
  })
  await simpleBoard('Fitness', {
    color: A.green,
    lists: [
      ['This week', ['Long run 10k', 'Mobility session']],
      ['Log', ['Mon - push', 'Wed - pull']]
    ]
  })

  return { roadmap }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-shots-'))

  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  }
  env.KANBINI_USERDATA_OVERRIDE = userDataDir
  env.KANBINI_E2E_HEADLESS = '1'
  env.NODE_ENV = 'development'

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--force-device-scale-factor=2'],
    env
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Frame the renderer at exactly VIEW. setContentSize is unreliable
    // for an off-screen window, so size the window and correct by the
    // difference the renderer reports.
    const fit = async () => {
      for (let i = 0; i < 3; i++) {
        const inner = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
        if (inner.w === VIEW.width && inner.h === VIEW.height) return
        await app.evaluate(
          ({ BrowserWindow }, { dw, dh }) => {
            const w = BrowserWindow.getAllWindows()[0]
            const [ow, oh] = w.getSize()
            w.setSize(ow + dw, oh + dh)
          },
          { dw: VIEW.width - inner.w, dh: VIEW.height - inner.h }
        )
        await sleep(250)
      }
    }
    await fit()

    const { port, token } = await waitForDiscovery(userDataDir)
    const api = makeApi(port, token)
    const { roadmap } = await seed(api, page)

    const setSettings = async (patch) => {
      await page.evaluate((p) => {
        const raw = localStorage.getItem('kanbini.settings')
        const s = raw ? JSON.parse(raw) : {}
        localStorage.setItem('kanbini.settings', JSON.stringify({ ...s, ...p }))
      }, patch)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await fit()
    }

    // Dark theme + named label chips for the main set, welcome modal
    // skipped; the reload paints the seeded data fresh.
    await setSettings({ theme: 'dark', labelsExpanded: true, hasSeenWelcome: true })

    // The in-list card runs a one-shot WAAPI height tween on reflow
    // (hooks/useSmoothHeight.ts) and pins an inline `height` while it
    // plays. A screenshot taken mid-tween can freeze that pinned (older,
    // shorter) height and the card's `overflow-hidden` clips its last
    // row. Before each capture, wait for every running animation to
    // finish, then release any inline height pin so cards sit at their
    // true auto height. Not a product bug - the live app settles the
    // tween in ~200ms; this just keeps the static capture clean.
    const settle = async () => {
      await page
        .waitForFunction(() => document.getAnimations().length === 0, null, {
          timeout: 5000
        })
        .catch(() => {})
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-card-id]')) {
          if (el instanceof HTMLElement && el.style.height) el.style.height = ''
        }
      })
      await page.waitForTimeout(150)
    }

    const shot = async (name) => {
      await settle()
      await page.screenshot({
        path: join(OUT_DIR, `${name}.png`),
        animations: 'disabled',
        caret: 'hide'
      })
      console.log(`  wrote ${name}.png`)
    }

    // Park the pointer in an empty corner so no hover state leaks in.
    const restMouse = () => page.mouse.move(VIEW.width - 8, VIEW.height - 8)
    const cardEl = (title) =>
      page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })
    const openRoadmap = async () => {
      await page.getByText('Product Roadmap', { exact: true }).click()
      await page.getByRole('heading', { name: /^Backlog\b/ }).waitFor()
      await restMouse()
      await sleep(900)
    }

    // ── Home: agenda + boards ──────────────────────────────────────
    await page.getByRole('heading', { name: /your boards/i }).waitFor()
    await page.getByRole('region', { name: 'Agenda' }).waitFor()
    await page.getByText('Product Roadmap', { exact: true }).waitFor()
    await restMouse()
    await sleep(700)
    await shot('home')

    // ── Board view (hero) ──────────────────────────────────────────
    await openRoadmap()
    await shot('board')

    // ── Card detail ────────────────────────────────────────────────
    await cardEl('Ship the Windows installer')
      .getByText('Ship the Windows installer', { exact: true })
      .click()
    const detail = page.getByRole('dialog', { name: 'Ship the Windows installer' })
    await detail.waitFor()
    await restMouse()
    await sleep(1000)
    await shot('card-detail')
    // Same card, scrolled down to the comments (one from the AI) and
    // the activity feed.
    await detail.getByText('Comments', { exact: true }).evaluate((el) =>
      el.scrollIntoView({ block: 'start' })
    )
    await sleep(500)
    await shot('card-activity')
    await page.keyboard.press('Escape')
    await detail.waitFor({ state: 'detached' })
    await sleep(300)

    // ── Right-click menu with a fly-out open ───────────────────────
    await cardEl('Offline-first sync engine').click({ button: 'right' })
    const labelsRow = page.getByRole('button', { name: /^Labels/ })
    await labelsRow.click()
    await page.locator('[data-submenu-panel]').waitFor()
    const panel = (await page.locator('[data-submenu-panel]').boundingBox()) ?? { x: 0, y: 0 }
    // Rest the pointer inside the fly-out so it reads as "hovering here".
    await page.mouse.move(panel.x + 60, panel.y + 52)
    await sleep(500)
    await shot('card-menu')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await sleep(300)

    // ── Multi-select + the floating bulk-action bar ────────────────
    for (const t of ['Dark mode contrast pass', 'Keyboard shortcut cheatsheet', 'SQLite WAL checkpoint stalls']) {
      await cardEl(t).getByText(t, { exact: true }).click({ modifiers: ['Control'] })
    }
    // Drop focus so the last clicked card doesn't keep its checkbox
    // column revealed (:focus-within).
    await page.evaluate(() => document.activeElement?.blur())
    await restMouse()
    await sleep(500)
    await shot('multi-select')
    await page.keyboard.press('Escape')
    await sleep(300)

    // ── Command palette / cross-board search ───────────────────────
    await page.keyboard.press('Control+f')
    await sleep(350)
    await page.keyboard.type('release', { delay: 45 })
    await sleep(900)
    await shot('command-palette')
    await page.keyboard.press('Escape')
    await sleep(400)

    // ── Swimlanes (group by priority) ──────────────────────────────
    await page.getByRole('button', { name: 'Rename board' }).click()
    await page.getByRole('button', { name: 'Priority', exact: true }).click()
    await page.getByRole('heading', { name: 'Urgent' }).waitFor()
    await page.keyboard.press('Escape') // close the board-settings popover
    await restMouse()
    await sleep(900)
    await shot('swimlanes')
    await api.post('/mutate', {
      type: 'board.update',
      id: roadmap.id,
      patch: { swimlaneMode: null }
    })

    // ── Light theme, with the default compact label bars ───────────
    // On the plain board surface (no wallpaper) so the theme shows.
    await api.post('/mutate', {
      type: 'board.update',
      id: roadmap.id,
      patch: { background: null }
    })
    await setSettings({ theme: 'light', labelsExpanded: false })
    await openRoadmap()
    await shot('board-light')

    console.log(`\nScreenshots written to ${OUT_DIR}`)
  } finally {
    try {
      await app.close()
    } catch {
      /* ignore */
    }
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
