import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ActivityView, CardView, LabelView } from '@kanbini/shared'
import { Activity } from '../activity'

// Tests for the per-card Activity feed. Specifically the `describe()`
// table - each activity type renders its own short line. Regressions
// here are easy: add a new activity type in the DB, forget to add a
// branch in the renderer, the feed quietly shows the raw type name.

const labels: LabelView[] = [
  { id: 'l1', name: 'Bug', color: 'oklch(0.62 0.17 25)' },
  { id: 'l2', name: 'Feature', color: 'oklch(0.62 0.15 250)' }
]

function makeActivity(
  overrides: Partial<ActivityView> = {}
): ActivityView {
  return {
    id: 'a1',
    cardId: 'c1',
    type: 'created',
    data: null,
    createdAt: Date.now(),
    ...overrides
  }
}

function renderActivities(rows: ActivityView[]) {
  const card: CardView = {
    id: 'c1',
    title: 'Card',
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: rows
  }
  return render(<Activity card={card} labels={labels} />)
}

describe('<Activity>', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('shows the "no activity yet" hint for an empty feed', () => {
    renderActivities([])
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument()
  })

  it('one row per activity entry', () => {
    renderActivities([
      makeActivity({ id: 'a1', type: 'created' }),
      makeActivity({ id: 'a2', type: 'completed' })
    ])
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('relative-time format: "just now" / "12m" / "3h" / "2d"', () => {
    const now = Date.parse('2026-05-25T12:00:00Z')
    renderActivities([
      makeActivity({ id: 'a1', type: 'created', createdAt: now - 30_000 }), // 30 s
      makeActivity({
        id: 'a2',
        type: 'completed',
        createdAt: now - 12 * 60_000
      }), // 12m
      makeActivity({
        id: 'a3',
        type: 'reopened',
        createdAt: now - 3 * 60 * 60_000
      }), // 3h
      makeActivity({
        id: 'a4',
        type: 'description',
        createdAt: now - 2 * 24 * 60 * 60_000
      }) // 2d
    ])
    expect(screen.getByText('just now')).toBeInTheDocument()
    expect(screen.getByText('12m')).toBeInTheDocument()
    expect(screen.getByText('3h')).toBeInTheDocument()
    expect(screen.getByText('2d')).toBeInTheDocument()
  })

  it("describes 'created' as 'created this card'", () => {
    renderActivities([makeActivity({ type: 'created' })])
    expect(screen.getByText('created this card')).toBeInTheDocument()
  })

  it("describes 'renamed' with the new title", () => {
    renderActivities([
      makeActivity({ type: 'renamed', data: { to: 'New title' } })
    ])
    // The label is split across nodes (description + <strong>).
    expect(screen.getByText('New title')).toBeInTheDocument()
  })

  it("describes complete / reopen", () => {
    renderActivities([
      makeActivity({ id: 'a1', type: 'completed' }),
      makeActivity({ id: 'a2', type: 'reopened' })
    ])
    expect(screen.getByText('marked complete')).toBeInTheDocument()
    expect(screen.getByText('marked incomplete')).toBeInTheDocument()
  })

  it("describes due-set with the formatted date", () => {
    const due = Date.parse('2026-06-01T12:00:00Z')
    renderActivities([
      makeActivity({ type: 'due-set', data: { dueAt: due } })
    ])
    // Locale-agnostic - assert the year is in the rendered string.
    expect(screen.getByText(/2026/)).toBeInTheDocument()
  })

  it("describes due-cleared / description / cover-* / priority-* with short labels", () => {
    renderActivities([
      makeActivity({ id: 'a1', type: 'due-cleared' }),
      makeActivity({ id: 'a2', type: 'description' }),
      makeActivity({ id: 'a3', type: 'cover-set' }),
      makeActivity({ id: 'a4', type: 'cover-cleared' }),
      makeActivity({
        id: 'a5',
        type: 'priority-set',
        data: { priority: 'high' }
      }),
      makeActivity({ id: 'a6', type: 'priority-cleared' })
    ])
    expect(screen.getByText('cleared the due date')).toBeInTheDocument()
    expect(screen.getByText('updated the description')).toBeInTheDocument()
    expect(screen.getByText('set a cover image')).toBeInTheDocument()
    expect(screen.getByText('cleared the cover image')).toBeInTheDocument()
    expect(screen.getByText(/set priority to/)).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('cleared the priority')).toBeInTheDocument()
  })

  it("describes 'moved' with the destination list name", () => {
    renderActivities([
      makeActivity({
        type: 'moved',
        data: { toListId: 'l-done', toListName: 'Done' }
      })
    ])
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText(/moved to/)).toBeInTheDocument()
  })

  it("describes 'moved' with a generic fallback when toListName is missing", () => {
    renderActivities([
      makeActivity({
        type: 'moved',
        data: { toListId: 'l-x' }
      })
    ])
    expect(screen.getByText(/another list/i)).toBeInTheDocument()
  })

  it("describes 'labels' with added / removed chips", () => {
    renderActivities([
      makeActivity({
        type: 'labels',
        data: {
          added: [{ id: 'l1', name: 'Bug' }],
          removed: [{ id: 'l2', name: 'Feature' }]
        }
      })
    ])
    expect(screen.getByText('added')).toBeInTheDocument()
    expect(screen.getByText('removed')).toBeInTheDocument()
    expect(screen.getByText('Bug')).toBeInTheDocument()
    expect(screen.getByText('Feature')).toBeInTheDocument()
  })

  it("renders a label that no longer exists as a theme-aware neutral chip", () => {
    // A label deleted since the activity was logged isn't in `labels`,
    // so it falls back to bg-muted/text-muted-foreground (theme tokens)
    // instead of a hardcoded dark chip that read wrong in light theme.
    renderActivities([
      makeActivity({
        type: 'labels',
        data: { added: [{ id: 'ghost', name: 'Gone' }], removed: [] }
      })
    ])
    const chip = screen.getByText('Gone')
    expect(chip.className).toContain('bg-muted')
    expect(chip.className).toContain('text-muted-foreground')
  })

  it("describes 'labels' as plain 'updated labels' when both arrays are empty", () => {
    renderActivities([
      makeActivity({ type: 'labels', data: { added: [], removed: [] } })
    ])
    expect(screen.getByText('updated labels')).toBeInTheDocument()
  })

  it("describes 'ai-comment' as 'AI posted a comment'", () => {
    renderActivities([makeActivity({ type: 'ai-comment' })])
    expect(screen.getByText('AI posted a comment')).toBeInTheDocument()
  })

  it("describes checklist add / remove with the name", () => {
    renderActivities([
      makeActivity({
        id: 'a1',
        type: 'checklist-added',
        data: { name: 'Steps' }
      }),
      makeActivity({
        id: 'a2',
        type: 'checklist-removed',
        data: { name: 'Old' }
      })
    ])
    expect(screen.getByText(/added checklist/)).toBeInTheDocument()
    expect(screen.getByText('Steps')).toBeInTheDocument()
    expect(screen.getByText(/removed checklist/)).toBeInTheDocument()
    expect(screen.getByText('Old')).toBeInTheDocument()
  })

  it("describes attachment add / remove with the filename", () => {
    renderActivities([
      makeActivity({
        id: 'a1',
        type: 'attachment-added',
        data: { filename: 'pic.png' }
      }),
      makeActivity({
        id: 'a2',
        type: 'attachment-removed',
        data: { filename: 'old.pdf' }
      })
    ])
    expect(screen.getByText(/attached/)).toBeInTheDocument()
    expect(screen.getByText('pic.png')).toBeInTheDocument()
    expect(screen.getByText(/removed/)).toBeInTheDocument()
    expect(screen.getByText('old.pdf')).toBeInTheDocument()
  })

  it("describes ADR-0041 rule-completed / rule-uncompleted lines", () => {
    renderActivities([
      makeActivity({ id: 'a1', type: 'rule-completed' }),
      makeActivity({ id: 'a2', type: 'rule-uncompleted' })
    ])
    expect(
      screen.getByText('auto-marked complete on entry')
    ).toBeInTheDocument()
    expect(
      screen.getByText('auto-marked incomplete on entry')
    ).toBeInTheDocument()
  })

  it("falls back to the raw type string for an unrecognised activity kind", () => {
    // Forward-compat: a future build that adds a new activity type
    // shouldn't crash the feed - it should show the raw type so the
    // user knows *something* happened.
    renderActivities([makeActivity({ type: 'future-kind' as never })])
    expect(screen.getByText('future-kind')).toBeInTheDocument()
  })
})
