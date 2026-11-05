import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/react'
import { buildExtensions } from '../markdown-editor'
import { COPIED_MS, createCodeBlockView } from '../code-block-copy'

// The copy button on code blocks. Driven through a real TipTap editor
// (the same extension set descriptions and comments use, Markdown in),
// so the node view, lowlight and the markdown parser are all the real
// ones.

const MD = ['Some text', '', '```ts', 'const a = 1', 'console.log(a)', '```'].join('\n')

let editor: Editor | null = null
let writeText: ReturnType<typeof vi.fn>

const mount = (content: string, editable = true): HTMLElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor = new Editor({ element: el, extensions: buildExtensions(), content, editable })
  return el
}
const copyButton = (root: HTMLElement): HTMLButtonElement => {
  const b = root.querySelector<HTMLButtonElement>('button.code-copy')
  if (!b) throw new Error('no copy button')
  return b
}
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  })
})

afterEach(() => {
  editor?.destroy()
  editor = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('code block copy button', () => {
  it('renders one button per code block, outside the code itself', () => {
    const root = mount(`${MD}\n\n\`\`\`\nsecond\n\`\`\``)
    const blocks = root.querySelectorAll('.code-block')
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      const button = block.querySelector('button.code-copy')!
      expect(button.getAttribute('aria-label')).toBe('Copy code')
      expect(block.querySelector('pre code')!.contains(button)).toBe(false)
    }
    // The language still reaches the <code> element, and lowlight still
    // colours the code inside it.
    expect(root.querySelector('pre code')!.className).toBe('language-ts')
    expect(root.querySelector('pre code .hljs-keyword')?.textContent).toBe('const')
  })

  it('saves the same Markdown as before', () => {
    mount(MD)
    const md = (editor!.storage as unknown as { markdown: { getMarkdown: () => string } })
      .markdown.getMarkdown()
    expect(md).toBe(MD)
  })

  it("copies the block's text exactly, without the markdown fence", async () => {
    const root = mount(MD, false)
    copyButton(root).click()
    expect(writeText).toHaveBeenCalledWith('const a = 1\nconsole.log(a)')
  })

  it('shows a check for a moment after copying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const root = mount(MD, false)
    const button = copyButton(root)
    button.click()
    await vi.waitFor(() => expect(button.getAttribute('aria-label')).toBe('Copied'))
    expect(button.hasAttribute('data-copied')).toBe(true)
    vi.advanceTimersByTime(COPIED_MS)
    expect(button.getAttribute('aria-label')).toBe('Copy code')
    expect(button.hasAttribute('data-copied')).toBe(false)
  })

  it("doesn't let the click reach the surface around it", () => {
    // The description's read-only view is a click-to-edit button.
    const root = mount(MD, false)
    const outer = vi.fn()
    root.addEventListener('click', outer)
    copyButton(root).click()
    expect(outer).not.toHaveBeenCalled()
  })

  it('copies what the block holds now, after an edit', async () => {
    const root = mount(MD)
    editor!.commands.setContent('```\nchanged\n```')
    await flush()
    copyButton(root).click()
    expect(writeText).toHaveBeenCalledWith('changed')
  })

  it('a failed copy leaves the button as it was', async () => {
    writeText.mockRejectedValue(new Error('Document is not focused'))
    const root = mount(MD, false)
    const button = copyButton(root)
    button.click()
    await flush()
    expect(button.getAttribute('aria-label')).toBe('Copy code')
  })

  it("tells ProseMirror to leave the button's events and icon swaps alone", () => {
    mount(MD)
    const nv = createCodeBlockView(editor!.state.doc.child(1), { languageClassPrefix: 'language-' })
    const button = nv.dom.querySelector('button')!
    const at = (target: Node): Event => {
      const ev = new MouseEvent('mousedown')
      Object.defineProperty(ev, 'target', { value: target })
      return ev
    }
    expect(nv.stopEvent!(at(button))).toBe(true)
    expect(nv.stopEvent!(at(nv.contentDOM!))).toBe(false)
    const mutation = (type: string, target: Node) =>
      ({ type, target }) as unknown as MutationRecord
    expect(nv.ignoreMutation!(mutation('attributes', button))).toBe(true)
    expect(nv.ignoreMutation!(mutation('characterData', nv.contentDOM!))).toBe(false)
    nv.destroy!()
  })
})
