import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Cancel and Create stay in the window at every window height: from the frame, which stops at the window's height, down to
// the editor, each box may be shorter than what it holds. Drawn with the real frame. The server renderer draws no portal
// and keeps no state, so a refusal and the objects made before it are put where the window keeps them.

const held = vi.hoisted(() => ({ error: null as string | null, made: [] as { kind: string; name: string; namespace: string }[] }))
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  return {
    ...real,
    useState: (initial: unknown) => {
      if (initial === null) return [held.error, () => {}]
      if (Array.isArray(initial)) return [held.made, () => {}]
      return real.useState(initial)
    },
  }
})
vi.mock('./ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/monaco/CodeEditor', () => ({ default: ({ height }: { height: string }) => createElement('section', { 'data-editor': height }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/services/api', () => ({ api: {} }))

import '@/i18n'
import ResourceYamlCreateDialog from './ResourceYamlCreateDialog'
import { YAML_EDITOR_MAX, yamlEditorHeight } from './modalStyles'

interface Box { attrs: string; classes: string[]; children: Box[]; parent: Box | null }

function boxes(html: string): Box {
  const root: Box = { attrs: '', classes: [], children: [], parent: null }
  let at = root
  for (const [, close, attrs, selfClosed] of html.matchAll(/<(\/?)[a-z][a-z0-9]*([^>]*?)(\/?)>/g)) {
    if (close) {
      at = at.parent!
      continue
    }
    const box: Box = { attrs, classes: /class="([^"]*)"/.exec(attrs)?.[1].split(' ') ?? [], children: [], parent: at }
    at.children.push(box)
    if (!selfClosed) at = box
  }
  return root
}
const find = (box: Box, attr: string): Box | null => {
  for (const child of box.children) {
    const found = child.attrs.includes(attr) ? child : find(child, attr)
    if (found) return found
  }
  return null
}

const YAML_60 = Array.from({ length: 60 }, (_, i) => `k${i}: v`).join('\n')
// the window's parts: the frame's three, the one that scrolls, the editor's box and what fills it
function draw(yaml: string) {
  const root = boxes(renderToStaticMarkup(createElement(ResourceYamlCreateDialog, { title: 'Create Pod', initialYaml: yaml, namespace: 'demo', onClose: () => {} })))
  const frame = find(root, 'data-testid="yaml-create-dialog"')!
  const fill = find(root, 'data-editor="100%"')!.parent!
  return { root, frame, title: frame.children[0], body: frame.children[1], buttons: frame.children[2], part: fill.parent!.parent!, editorBox: fill.parent!, fill }
}

describe('the Create from YAML window', () => {
  beforeEach(() => {
    held.error = null
    held.made = []
  })

  it('keeps Cancel and Create in the window: the part between the title and them gives up the height', () => {
    const { frame, title, body, buttons, part } = draw(YAML_60)
    expect(frame.classes).toEqual(expect.arrayContaining(['max-h-[calc(100vh-2rem)]', 'flex', 'flex-col']))
    expect(frame.children).toEqual([title, body, buttons])
    expect(find(title, 'id="')).not.toBeNull()
    expect(buttons.children.map((b) => b.attrs.includes('type="button"'))).toEqual([true, true])
    for (const kept of [title, buttons]) expect(kept.classes).not.toContain('min-h-0')
    expect(body.classes).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'flex', 'flex-col']))
    expect(body.children).toEqual([part])
    expect(part.classes).toEqual(expect.arrayContaining(['min-h-0', 'flex', 'flex-col', 'overflow-y-auto']))
  })

  it('takes it off the editor first, which fills the box it is left and scrolls in it', () => {
    for (const yaml of ['kind: Pod', YAML_60]) {
      const { part, editorBox, fill } = draw(yaml)
      expect(editorBox.parent).toBe(part)
      expect(editorBox.attrs).toContain(`style="height:${yamlEditorHeight(yaml)}px"`)
      expect(editorBox.classes).toEqual(expect.arrayContaining(['relative', 'min-h-24', 'overflow-hidden']))
      expect(editorBox.classes.filter((c) => ['shrink-0', 'flex-none'].includes(c))).toEqual([])
      expect(fill.classes).toEqual(expect.arrayContaining(['absolute', 'inset-0']))
    }
    expect(yamlEditorHeight(YAML_60)).toBe(YAML_EDITOR_MAX)
  })

  it('scrolls a long refusal in a box of its own, by the keyboard too, so the editor keeps the rest of the height', () => {
    held.error = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
    const { root, part } = draw(YAML_60)
    const refusal = find(root, 'data-testid="yaml-create-error"')!
    expect(refusal.parent).toBe(part)
    // shrink-0: a box that scrolls has no least height of its own, and the editor gives up height before it
    expect(refusal.classes).toEqual(expect.arrayContaining(['max-h-40', 'shrink-0', 'overflow-y-auto', 'whitespace-pre-wrap']))
    expect(refusal.attrs).toContain('tabindex="0"')
  })

  it('keeps a refusal and what was made before it with the editor, above the buttons', () => {
    held.error = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
    held.made = [{ kind: 'ConfigMap', name: 'a', namespace: 'demo' }]
    const refused = draw(YAML_60)
    for (const id of ['yaml-create-error', 'yaml-create-made-before']) expect(find(refused.root, `data-testid="${id}"`)?.parent, id).toBe(refused.part)
    expect(refused.part.classes).toContain('overflow-y-auto')
    held.error = null
    const empty = draw('')
    expect(find(empty.root, 'data-testid="yaml-create-empty"')?.parent).toBe(empty.part)
  })
})
