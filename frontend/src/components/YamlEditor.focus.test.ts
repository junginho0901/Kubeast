import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import YamlEditor from './YamlEditor'

// D5 keyboard flow 1-7 and 1-10: Edit and Apply turn into other buttons when pressed, so the focus fell to the page.
// The server renderer keeps no state and runs no effect: the editor's state is set by the order of its useState calls,
// its refs by the order of its useRef calls, and its effects are run by hand against a page of stand-ins.

const SLOT = { editing: 1, applying: 2, focusNext: 8, tabMovesFocus: 9 }
const REF = { editor: 0, edit: 1, apply: 2 }
const state = vi.hoisted(() => ({
  slot: 0, ref: 0, initial: {} as Record<number, unknown>, sets: {} as Record<number, unknown[]>,
  refs: [] as { current: unknown }[], effects: [] as (() => void)[],
}))
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  return {
    ...real,
    useState: (initial: unknown) => {
      const slot = state.slot++
      return [slot in state.initial ? state.initial[slot] : initial, (value: unknown) => { (state.sets[slot] ??= []).push(value) }]
    },
    useRef: (initial: unknown) => state.refs[state.ref++] ?? { current: initial },
    useEffect: (effect: () => void) => { state.effects.push(effect) },
  }
})
vi.mock('@/components/monaco/CodeEditor', () => ({ default: () => null }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const LABELS = { title: 't', refresh: 'r', copy: 'c', edit: 'EDIT', apply: 'APPLY', applying: 'a', cancel: 'CANCEL', loading: 'l', error: 'err', readonly: 'ro', editHint: 'h', applied: 'd', refreshing: 'f' }

type Node = ReactElement<{ children?: unknown; onClick?: () => unknown }>
const findButton = (node: unknown, label: string): Node | null => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findButton(item, label)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return null
  const element = node as Node
  return element.type === 'button' && element.props.children === label ? element : findButton(element.props.children, label)
}

// A page whose focus is on the body (it fell there) and the three places the focus may go.
function page() {
  const doc = { activeElement: null as unknown, body: { isConnected: true } }
  doc.activeElement = doc.body
  const place = (name: string) => {
    const p = { name, isConnected: true, focus: () => { doc.activeElement = p } }
    return p
  }
  const places = { editor: place('editor'), edit: place('Edit'), apply: place('Apply') }
  state.refs[REF.editor] = { current: places.editor }
  state.refs[REF.edit] = { current: places.edit }
  state.refs[REF.apply] = { current: places.apply }
  vi.stubGlobal('document', doc)
  return { doc, places }
}

function render(editing: boolean, onApply: (next: string) => Promise<boolean> = async () => true) {
  state.initial[SLOT.editing] = editing
  let tree: unknown = null
  const Grab = () => {
    tree = YamlEditor({ value: 'a: 1\n', canEdit: true, isLoading: false, onApply, labels: LABELS })
    return tree as ReactElement
  }
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Grab)))
  return { tree, html }
}
const runEffects = () => { for (const effect of state.effects) effect() }

describe('YamlEditor keeps the focus when its buttons change', () => {
  beforeEach(() => {
    state.slot = 0
    state.ref = 0
    state.initial = {}
    state.sets = {}
    state.refs = []
    state.effects = []
    vi.stubGlobal('navigator', { platform: 'Win32' })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('Edit sends the focus to the editor', () => {
    const { doc, places } = page()
    findButton(render(false).tree, LABELS.edit)!.props.onClick!()
    expect(state.sets[SLOT.focusNext]).toEqual(['editor'])
    state.slot = 0
    state.ref = 0
    state.effects = []
    state.initial[SLOT.focusNext] = 'editor'
    render(true)
    runEffects()
    expect(doc.activeElement).toBe(places.editor)
  })

  it('a saved Apply sends it to Edit, back in the place of Apply', async () => {
    const { doc, places } = page()
    await findButton(render(true, async () => true).tree, LABELS.apply)!.props.onClick!()
    expect(state.sets[SLOT.focusNext]).toEqual(['edit'])
    state.slot = 0
    state.ref = 0
    state.effects = []
    state.initial[SLOT.focusNext] = 'edit'
    render(false)
    runEffects()
    expect(doc.activeElement).toBe(places.edit)
  })

  it('an Apply that saved nothing, declined or refused, gives it back to Apply once Apply works again', async () => {
    page()
    await findButton(render(true, async () => false).tree, LABELS.apply)!.props.onClick!()
    expect(state.sets[SLOT.focusNext]).toEqual(['apply'])
    state.sets = {}
    state.slot = 0
    await findButton(render(true, async () => { throw new Error('managed by Argo CD') }).tree, LABELS.apply)!.props.onClick!()
    expect(state.sets[SLOT.focusNext]).toEqual(['apply'])
  })

  it('waits while Apply is disabled, then focuses it', () => {
    const { doc, places } = page()
    state.initial[SLOT.focusNext] = 'apply'
    state.initial[SLOT.applying] = true
    render(true)
    runEffects()
    expect(doc.activeElement).toBe(doc.body)
    state.slot = 0
    state.ref = 0
    state.effects = []
    state.initial[SLOT.applying] = false
    render(true)
    runEffects()
    expect(doc.activeElement).toBe(places.apply)
  })

  it('Cancel sends it to Edit, and a focus the reader moved meanwhile stays', () => {
    const { doc, places } = page()
    findButton(render(true).tree, LABELS.cancel)!.props.onClick!()
    expect(state.sets[SLOT.focusNext]).toEqual(['edit'])
    const search = { isConnected: true }
    doc.activeElement = search
    state.slot = 0
    state.ref = 0
    state.effects = []
    state.initial[SLOT.focusNext] = 'edit'
    render(false)
    runEffects()
    expect(doc.activeElement).toBe(search)
    expect(doc.activeElement).not.toBe(places.edit)
  })
})

describe('YamlEditor says how to leave the editor by keyboard (WCAG 2.2 2.1.2)', () => {
  beforeEach(() => {
    state.slot = 0
    state.ref = 0
    state.initial = {}
    state.refs = []
    state.effects = []
  })
  afterEach(() => vi.unstubAllGlobals())

  const hint = (html: string) => /data-testid="yaml-editor-tab-hint"[^>]*>([^<]*)</.exec(html)?.[1]

  it('while editing, names Monaco’s Tab switch for the platform, and says what Tab does now', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(hint(render(true).html)).toBe('Tab indents. Press Ctrl+M to move the focus with Tab instead.')
    state.slot = 0
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    state.initial[SLOT.tabMovesFocus] = true
    expect(hint(render(true).html)).toBe('Tab moves the focus out of the editor. Press Ctrl+Shift+M to indent with Tab again.')
    state.slot = 0
    state.initial[SLOT.tabMovesFocus] = false
    void i18n.changeLanguage('ko')
    expect(hint(render(true).html)).toBe('Tab은 들여쓰기합니다. Tab으로 초점을 옮기려면 Ctrl+Shift+M을 누르세요.')
    void i18n.changeLanguage('en')
  })

  it('says nothing while the editor is read-only, where Tab already leaves it', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(hint(render(false).html)).toBeUndefined()
  })
})
