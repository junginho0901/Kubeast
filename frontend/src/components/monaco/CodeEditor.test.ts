import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// What is typed stays typed. The real @monaco-editor/react runs in react-dom with the few DOM parts it touches; monaco
// is a text with a list of listeners. No act: it runs the effects of a render with the render, and the keys here come
// between the two, as they do on a busy page.

vi.hoisted(() => {
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  const window = Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
})

const monaco = vi.hoisted(() => {
  type Change = { isFlush: boolean }
  type Options = { model: { text: string }; readOnly?: boolean }
  // written: the texts the library set
  type Made = { written: string[]; type: (keys: string) => void; insert: (text: string) => void; listeners: () => number; getValue: () => string }
  const made: Made[] = []
  const create = (_node: unknown, options: Options) => {
    const { model } = options
    const listeners = new Set<(change: Change) => void>()
    const written: string[] = []
    const tell = (change: Change) => {
      // as monaco's: one added while the event is given out waits for the next event, one disposed is passed over
      for (const listener of [...listeners]) if (listeners.has(listener)) listener(change)
    }
    const set = (text: string, change: Change) => {
      model.text = text
      tell(change)
    }
    const editor = {
      written,
      type: (keys: string) => set(model.text + keys, { isFlush: false }),
      // an input method, dictation: an event for each character, all after the last of them is in
      insert: (text: string) => {
        model.text += text
        for (const _ of text) tell({ isFlush: false })
      },
      listeners: () => listeners.size,
      getModel: () => model,
      getValue: () => model.text,
      getOption: () => !!options.readOnly,
      updateOptions: (next: Partial<Options>) => { Object.assign(options, next) },
      setValue: (text: string) => { written.push(text); set(text, { isFlush: true }) },
      executeEdits: (_source: string, [edit]: { text: string }[]) => { written.push(edit.text); set(edit.text, { isFlush: false }) },
      onDidChangeModelContent: (listener: (change: Change) => void) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
      pushUndoStop() {}, saveViewState() {}, restoreViewState() {}, dispose() {},
    }
    made.push(editor)
    return editor
  }
  return {
    made,
    Uri: { parse: (path: string) => path },
    editor: {
      EditorOption: { readOnly: 0 },
      create,
      createModel: (text: string) => ({ text, getFullModelRange: () => null, dispose() {} }),
      getModel: () => null,
      setTheme() {},
      setModelLanguage() {},
      onDidChangeMarkers: () => ({ dispose() {} }),
    },
  }
})

vi.mock('./MonacoEditor', async () => {
  const library = await vi.importActual<typeof import('@monaco-editor/react')>('@monaco-editor/react')
  library.loader.config({ monaco: monaco as never })
  return { default: library.default }
})

import { createElement, StrictMode, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CodeEditor, { type EditorProps } from './CodeEditor'

const element = (tag: string): object => ({
  nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag.toUpperCase(), namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument: page, style: {}, textContent: '', childNodes: [], firstChild: null,
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
  appendChild() {}, insertBefore() {}, removeChild() {},
})
const page: object = { ...document, createElement: element }

let root: Root
let errors: MockInstance<typeof console.error>
// the text of every render on the page, in order, and what the page's own onChange was given
let shown: string[] = []
let given: (string | undefined)[] = []
let setText: (text: string) => void = () => {}
let waiting: { text: string; go: () => void }[] = []

// The page around an editor: it keeps the text, as the search box and the YAML editors do, and an edit undoes what it
// said of the text before.
function Page({ start, editor }: { start: string; editor?: Partial<EditorProps> }) {
  const [text, set] = useState(start)
  const [, setCopied] = useState(false)
  useEffect(() => { setCopied(false) }, [text])
  useLayoutEffect(() => {
    setText = set
    shown.push(text)
    waiting.filter((w) => w.text === text).forEach((w) => w.go())
  }, [text])
  return createElement(CodeEditor, {
    value: text,
    onChange: (next) => { given.push(next); set(next ?? '') },
    loading: '',
    ...editor,
  })
}

// resolves once a render of this text is on the page; its effects run in a task of their own, after it
const onPage = (text: string) => new Promise<void>((go) => { waiting.push({ text, go }) })
// turns of the event loop, for React's renders and effects to have had theirs on a busy machine too
const settled = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 3))
}

const open = async (children: ReactNode) => {
  root = createRoot(element('div') as HTMLElement)
  root.render(children)
  for (let i = 0; i < 200 && monaco.made.length === 0; i += 1) await settled()
  await settled()
  expect(monaco.made.length).toBeGreaterThan(0)
  return monaco.made[monaco.made.length - 1]
}

beforeEach(() => {
  monaco.made.length = 0
  shown = []
  given = []
  waiting = []
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  root.unmount()
  await settled()
  // "flushSync was called from inside a lifecycle method" among them
  const said = errors.mock.calls.map((call) => String(call[0]))
  errors.mockRestore()
  expect(said).toEqual([])
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('an editor whose page keeps the text (value and onChange)', () => {
  it.each([
    ['the page', (p: ReactNode) => p],
    ['the page in StrictMode', (p: ReactNode) => createElement(StrictMode, null, p)],
  ])('never has an earlier text written over keys pressed before it came back: %s', async (_name, around) => {
    const editor = await open(around(createElement(Page, { start: '' })))

    const first = onPage('m')
    editor.type('m')
    await first
    editor.type('e')
    const third = onPage('met')
    editor.type('t')
    await third
    editor.type('a')
    editor.type('d')
    await settled()

    expect(editor.written).toEqual([])
    expect(editor.getValue()).toBe('metad')
    expect(shown[shown.length - 1]).toBe('metad')
    expect(given).toEqual(['m', 'me', 'met', 'meta', 'metad'])
  })

  it('has the text of an edit on the page as soon as the edit is done', async () => {
    const editor = await open(createElement(Page, { start: 'a' }))
    editor.type('b')
    expect(shown).toEqual(['a', 'ab'])
    editor.type('c')
    expect(shown).toEqual(['a', 'ab', 'abc'])
    expect(editor.listeners()).toBe(1)
  })

  it('takes a long text put in at once, told a character at a time', async () => {
    const editor = await open(createElement(Page, { start: '' }))
    const yaml = 'kind: ConfigMap\n'.repeat(20)
    editor.insert(yaml)
    expect(shown).toEqual(['', yaml])
    await settled()
    expect(shown).toEqual(['', yaml])
    expect(editor.written).toEqual([])
    expect(new Set(given)).toEqual(new Set([yaml]))
  })

  it('takes a text set outside it: an example, a clear, the text it opened with', async () => {
    const editor = await open(createElement(Page, { start: 'kind: Pod' }))
    editor.type('s')
    for (const text of ['metadata.name === "a"', '', 'kind: Pod']) {
      setText(text)
      await settled()
      expect(editor.getValue()).toBe(text)
    }
    expect(editor.written).toEqual(['metadata.name === "a"', '', 'kind: Pod'])
    // the library keeps its own writes to itself
    expect(given).toEqual(['kind: Pods'])

    editor.type('s')
    await settled()
    expect(editor.getValue()).toBe('kind: Pods')
    expect(shown[shown.length - 1]).toBe('kind: Pods')
  })

  it('shows a new text while it is read-only, and is edited once it is not', async () => {
    const readOnly = (text: string, on: boolean) => createElement(CodeEditor, {
      value: text,
      onChange: (next) => { given.push(next) },
      options: { readOnly: on },
      loading: '',
    })
    const editor = await open(readOnly('replicas: 1', true))
    root.render(readOnly('replicas: 2', true))
    await settled()
    expect(editor.getValue()).toBe('replicas: 2')
    // setValue, in an effect of the library: told to the page as before
    expect(given).toEqual(['replicas: 2'])

    root.render(readOnly('replicas: 2', false))
    await settled()
    editor.type('0')
    expect(given).toEqual(['replicas: 2', 'replicas: 20'])
    expect(editor.written).toEqual(['replicas: 2'])
  })
})

describe('an editor that keeps its own text', () => {
  it('with no onChange only shows the value it is given', async () => {
    const shows = (text: string) => createElement(CodeEditor, { value: text, options: { readOnly: true }, loading: '' })
    const editor = await open(shows('a: 1'))
    expect(editor.getValue()).toBe('a: 1')
    expect(editor.listeners()).toBe(0)
    root.render(shows('a: 2'))
    await settled()
    expect(editor.getValue()).toBe('a: 2')
    expect(editor.written).toEqual(['a: 2'])
  })

  it('with a default value has nothing written back, and its page renders in its own time', async () => {
    const editor = await open(createElement(Page, { start: 'a', editor: { value: undefined, defaultValue: 'a' } }))
    editor.type('b')
    expect(given).toEqual(['ab'])
    expect(shown).toEqual(['a'])
    await settled()
    expect(shown).toEqual(['a', 'ab'])
    expect(editor.getValue()).toBe('ab')
    expect(editor.written).toEqual([])
  })
})
