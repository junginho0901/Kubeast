import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabFocus } from 'monaco-editor/editor/browser/config/tabFocus.js'
import { EditorOptions } from 'monaco-editor/editor/common/config/editorOptions.js'
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
  refs: [] as { current: unknown }[], effects: [] as (() => void)[], onMount: null as unknown,
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
vi.mock('@/components/monaco/CodeEditor', () => ({
  default: (props: { onMount?: unknown }) => {
    state.onMount = props.onMount
    return null
  },
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const LABELS = { title: 't', refresh: 'r', copy: 'c', edit: 'EDIT', apply: 'APPLY', applying: 'a', cancel: 'CANCEL', loading: 'l', error: 'err', readonly: 'ro', editHint: 'h', applied: 'd', refreshing: 'f' }

type Node = ReactElement<{ children?: unknown; onClick?: () => unknown; disabled?: boolean }>
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

// A page whose focus is on the body (it fell there) and the three places the focus may go; a disabled one takes no focus,
// as a browser's disabled button does not.
function page() {
  const doc = { activeElement: null as unknown, body: { isConnected: true } }
  doc.activeElement = doc.body
  const place = (name: string) => {
    const p = { name, isConnected: true, disabled: false, focus: () => { if (!p.disabled) doc.activeElement = p } }
    return p
  }
  const places = { editor: place('editor'), edit: place('Edit'), apply: place('Apply') }
  state.refs[REF.editor] = { current: places.editor }
  state.refs[REF.edit] = { current: places.edit }
  state.refs[REF.apply] = { current: places.apply }
  vi.stubGlobal('document', doc)
  return { doc, places }
}

function render(editing: boolean, onApply: (next: string) => Promise<boolean> = async () => true, read: { isLoading?: boolean; value?: string } = {}) {
  state.initial[SLOT.editing] = editing
  let tree: unknown = null
  const Grab = () => {
    tree = YamlEditor({ value: 'a: 1\n', canEdit: true, isLoading: false, onApply, labels: LABELS, ...read })
    return tree as ReactElement
  }
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Grab)))
  return { tree, html }
}
const runEffects = () => { for (const effect of state.effects) effect() }

// The editor back to read-only after an Apply, rendered and its effects run, the next render holding what they said last
// about where the focus goes. `reading`: the drawer reads the YAML again after every Apply under a new key
// (`invalidateAfterApply`), so it loads with no text and Edit is disabled until that read answers.
function renderAfterApply(places: ReturnType<typeof page>['places'], reading: boolean) {
  state.slot = 0
  state.ref = 0
  state.effects = []
  state.sets = {}
  const edit = findButton(render(false, undefined, reading ? { isLoading: true, value: '' } : {}).tree, LABELS.edit)!
  places.edit.disabled = edit.props.disabled === true
  runEffects()
  const said = state.sets[SLOT.focusNext]
  if (said) state.initial[SLOT.focusNext] = said[said.length - 1]
}

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

  it('Edit pressed before Monaco has mounted sends the focus to the editor once it mounts', () => {
    const { doc } = page()
    state.refs[REF.editor] = { current: null }
    const nextRender = () => {
      for (const [slot, said] of Object.entries(state.sets)) state.initial[Number(slot)] = said[said.length - 1]
      state.slot = 0
      state.ref = 0
      state.effects = []
      state.sets = {}
    }
    findButton(render(false).tree, LABELS.edit)!.props.onClick!()
    expect(state.sets[SLOT.focusNext]).toEqual(['editor'])
    nextRender()
    render(true)
    runEffects()
    expect(doc.activeElement).toBe(doc.body)
    const made = monacoEditor()
    const editor = Object.assign(made.editor, { focus: () => { doc.activeElement = editor } })
    try {
      ;(state.onMount as (editor: unknown, monaco: unknown) => void)(editor, made.monaco)
      nextRender()
      render(true)
      runEffects()
      expect(doc.activeElement).toBe(editor)
    } finally {
      editor.dispose()
    }
  })

  it('Edit, Apply and Cancel are three buttons to React, so the pressed Edit leaves the page and its focus falls', () => {
    const edit = findButton(render(false).tree, LABELS.edit)!
    state.slot = 0
    state.ref = 0
    state.effects = []
    const editing = render(true).tree
    const keys = [edit, findButton(editing, LABELS.apply)!, findButton(editing, LABELS.cancel)!].map((b) => b.key)
    expect(keys.every((k) => k !== null)).toBe(true)
    expect(new Set(keys).size).toBe(3)
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

  it('a saved or unchanged Apply sends it to Edit once the YAML read again after it has come, while Edit is disabled', async () => {
    const { doc, places } = page()
    await findButton(render(true, async () => true).tree, LABELS.apply)!.props.onClick!()
    expect(state.sets[SLOT.focusNext]).toEqual(['edit'])
    state.initial[SLOT.focusNext] = 'edit'
    renderAfterApply(places, true)
    expect(places.edit.disabled).toBe(true)
    expect(doc.activeElement).toBe(doc.body)
    renderAfterApply(places, false)
    expect(places.edit.disabled).toBe(false)
    expect(doc.activeElement).toBe(places.edit)
  })

  it('a focus the reader moved while that read went on stays where they put it', () => {
    const { doc, places } = page()
    state.initial[SLOT.focusNext] = 'edit'
    renderAfterApply(places, true)
    const close = { isConnected: true }
    doc.activeElement = close
    renderAfterApply(places, false)
    expect(doc.activeElement).toBe(close)
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

// Monaco's own Tab switch and editor option. Ctrl+M runs editor.action.toggleTabFocusMode, which flips the switch and
// tells a screen reader (`ctrlM` flips it; the command's module needs a browser to load). The stand-in editor works its
// `tabFocusMode` out as Monaco's editor does (editorConfiguration.js): the option's own compute with the switch in its
// env, worked out again when the switch moves, and a change event only when that value moved.
type Change = { hasChanged: (id: number) => boolean }
function monacoEditor(option = false) {
  const id = EditorOptions.tabFocusMode.id
  const changes = new Set<(e: Change) => void>()
  const ends = new Set<() => void>()
  const compute = () => EditorOptions.tabFocusMode.compute({ tabFocusMode: option || TabFocus.getTabFocusMode() }, null, option)
  let value = compute()
  const recompute = () => {
    const next = compute()
    if (next === value) return
    value = next
    for (const listener of [...changes]) listener({ hasChanged: (changed) => changed === id })
  }
  const switched = TabFocus.onDidChangeTabFocus(recompute)
  const editor = {
    getOption: (asked: number) => (asked === id ? value : undefined),
    onDidChangeConfiguration: (listener: (e: Change) => void) => {
      changes.add(listener)
      return { dispose: () => changes.delete(listener) }
    },
    onDidDispose: (listener: () => void) => {
      ends.add(listener)
      return { dispose: () => ends.delete(listener) }
    },
    updateOptions: (next: { tabFocusMode: boolean }) => {
      option = next.tabFocusMode
      recompute()
    },
    dispose: () => {
      switched.dispose()
      changes.clear()
      for (const end of ends) end()
    },
  }
  return { editor, monaco: { editor: { EditorOption: { tabFocusMode: id } } } }
}

describe('YamlEditor’s hint follows Monaco’s Tab switch, which the editor option does not report', () => {
  const ctrlM = () => TabFocus.setTabFocusMode(!TabFocus.getTabFocusMode())
  const shown = () => state.sets[SLOT.tabMovesFocus]
  const open: { dispose: () => void }[] = []
  function mount(option = false) {
    state.slot = 0
    state.ref = 0
    state.effects = []
    state.sets = {}
    render(true)
    const made = monacoEditor(option)
    open.push(made.editor)
    ;(state.onMount as (editor: unknown, monaco: unknown) => void)(made.editor, made.monaco)
    return made.editor
  }
  beforeEach(() => {
    state.initial = {}
    state.refs = []
    state.sets = {}
    vi.stubGlobal('navigator', { platform: 'Win32' })
  })
  afterEach(() => {
    for (const editor of open.splice(0)) editor.dispose()
    TabFocus.setTabFocusMode(false)
    vi.unstubAllGlobals()
  })

  it('Ctrl+M says Tab moves the focus, and a second press says it indents again', () => {
    const editor = mount()
    expect(shown()).toEqual([false])
    ctrlM()
    expect(editor.getOption(EditorOptions.tabFocusMode.id)).toBe(false)
    expect(shown()).toEqual([false, true])
    ctrlM()
    expect(shown()).toEqual([false, true, false])
  })

  it('an editor opened while the switch is on, from another editor of the page, says so at once', () => {
    ctrlM()
    mount()
    expect(shown()).toEqual([true])
  })

  it('the editor option counts too, and a closed editor hears the switch no more', () => {
    const editor = mount()
    editor.updateOptions({ tabFocusMode: true })
    expect(shown()).toEqual([false, true])
    editor.updateOptions({ tabFocusMode: false })
    editor.dispose()
    ctrlM()
    expect(shown()).toEqual([false, true, false])
  })
})
