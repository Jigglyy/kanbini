import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { NodeView, ViewMutationRecord } from '@tiptap/pm/view'

// Code blocks with a small "copy" button (descriptions, comments, and the
// editor). A plain ProseMirror node view rather than a React one: it's
// built synchronously (no portal per code block in every comment) and
// works the same in the editable and read-only editors.
//
//   <div class="code-block">
//     <pre><code class="language-x">…</code></pre>   <- contentDOM = code
//     <button class="code-copy">                     <- outside contentDOM
//   </div>
//
// The button sits outside the contentDOM, so `stopEvent` keeps ProseMirror
// from treating clicks on it as editing and `ignoreMutation` keeps the
// icon swap from re-rendering the node. Its click also stops propagation:
// the description's read-only view is itself a click-to-edit button, and
// copying shouldn't open the editor. Hidden until the block is hovered
// (or the button focused), see `.code-copy` in index.css.

// lucide "copy" + "check" (ISC, the same icon set as lucide-react).
const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const COPY_ICON = `<svg ${SVG_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`
const CHECK_ICON = `<svg ${SVG_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`

/** How long the button shows the check after a copy. */
export const COPIED_MS = 1500

export function createCodeBlockView(
  initial: PMNode,
  opts: {
    languageClassPrefix: string
    /** Defaults to the system clipboard; tests pass a stub. */
    copy?: (text: string) => Promise<void>
  }
): NodeView {
  let node = initial
  const copy = opts.copy ?? ((text: string) => navigator.clipboard.writeText(text))

  const dom = document.createElement('div')
  dom.className = 'code-block'
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  pre.appendChild(code)
  dom.appendChild(pre)

  const setLanguage = (language: unknown): void => {
    if (typeof language === 'string' && language !== '') {
      code.className = opts.languageClassPrefix + language
    } else {
      code.removeAttribute('class')
    }
  }
  setLanguage(node.attrs['language'])

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'code-copy'
  button.contentEditable = 'false'
  let timer: ReturnType<typeof setTimeout> | undefined
  const showCopied = (copied: boolean): void => {
    button.innerHTML = copied ? CHECK_ICON : COPY_ICON
    button.title = copied ? 'Copied' : 'Copy code'
    button.setAttribute('aria-label', copied ? 'Copied' : 'Copy code')
    if (copied) button.dataset['copied'] = ''
    else delete button.dataset['copied']
  }
  showCopied(false)
  // Keep the editor's caret and focus where they were.
  button.addEventListener('mousedown', (e) => e.preventDefault())
  button.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    copy(node.textContent)
      .then(() => {
        showCopied(true)
        clearTimeout(timer)
        timer = setTimeout(() => showCopied(false), COPIED_MS)
      })
      .catch(() => {})
  })
  dom.appendChild(button)

  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      setLanguage(node.attrs['language'])
      return true
    },
    stopEvent: (event) => event.target instanceof Node && button.contains(event.target),
    ignoreMutation: (m: ViewMutationRecord) =>
      m.type !== 'selection' && !code.contains(m.target),
    destroy() {
      clearTimeout(timer)
    }
  }
}

/** CodeBlockLowlight (syntax colours) + the copy button. Configure it
 *  exactly like CodeBlockLowlight. */
export const CodeBlockWithCopy = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node }) =>
      createCodeBlockView(node, { languageClassPrefix: this.options.languageClassPrefix ?? '' })
  }
})
