import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// AI Models, "Which model answers": what each use's field shows and may choose, what a pick sends, what a refusal says,
// and the field the chart decides. The card runs in react-dom with a few DOM parts and the app's real query client; the
// dropdown is stood in by one that keeps what it was given.

vi.hoisted(() => {
  class FakeNode {
    nodeType: number
    nodeName: string
    ownerDocument: unknown
    childNodes: FakeNode[] = []
    parentNode: FakeNode | null = null
    nodeValue: string | null = null
    namespaceURI = 'http://www.w3.org/1999/xhtml'
    style: Record<string, string> = {}
    attributes: Record<string, string> = {}
    constructor(type: number, name: string, doc: unknown) { this.nodeType = type; this.nodeName = name; this.ownerDocument = doc }
    get tagName() { return this.nodeName }
    get localName() { return this.nodeName.toLowerCase() }
    get firstChild() { return this.childNodes[0] ?? null }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
    get textContent(): string { return this.nodeType === 3 ? (this.nodeValue ?? '') : this.childNodes.map((c) => c.textContent).join('') }
    set textContent(v: string) {
      this.childNodes = []
      if (v) this.appendChild(Object.assign(new FakeNode(3, '#text', this.ownerDocument), { nodeValue: v }))
    }
    appendChild(c: FakeNode) { return this.insertBefore(c, null) }
    insertBefore(c: FakeNode, ref: FakeNode | null) {
      c.parentNode?.removeChild(c)
      const at = ref ? this.childNodes.indexOf(ref) : -1
      if (at < 0) this.childNodes.push(c)
      else this.childNodes.splice(at, 0, c)
      c.parentNode = this
      return c
    }
    removeChild(c: FakeNode) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c }
    setAttribute(k: string, v: unknown) { this.attributes[k] = String(v) }
    removeAttribute(k: string) { delete this.attributes[k] }
    addEventListener() {}
    removeEventListener() {}
  }
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  document.createElement = (tag: string) => new FakeNode(1, tag.toUpperCase(), document)
  document.createElementNS = (_ns: string, tag: string) => new FakeNode(1, tag, document)
  document.createTextNode = (v: string) => Object.assign(new FakeNode(3, '#text', document), { nodeValue: v })
  document.container = () => new FakeNode(1, 'DIV', document)
  const window = Object.assign(new EventTarget(), {
    document,
    location: { search: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    HTMLIFrameElement: class {},
  })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

type Dropdown = {
  label: string; value: string; disabled?: boolean; placeholder?: string; testId: string
  options: { value: string; label: string; listHint?: string; disabled?: boolean }[]
  onChange: (value: string) => void
}
const shown = vi.hoisted(() => ({ dropdowns: new Map<string, unknown>(), catalog: {} as unknown, english: true }))
vi.mock('@/components/CustomDropdown', () => ({
  default: (props: Dropdown) => { shown.dropdowns.set(props.testId, props); return null },
}))
const fill = (text: string, o: Record<string, unknown> = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(o[name]))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // the catalog's words, which must be there for every key the card asks for, the English ones as the call's default
    t: (key: string, o: Record<string, unknown>) => {
      const text = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], shown.catalog)
      if (typeof text !== 'string') throw new Error(`no ${key} in the catalog`)
      if (shown.english && text !== o.defaultValue) throw new Error(`${key} reads "${text}" in the catalog and "${o.defaultValue}" by default`)
      return fill(text, o)
    },
  }),
}))

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { api, type ModelConfigResponse, type ModelUseState } from '@/services/api'
import { ConfirmContext, type ConfirmOptions } from '@/services/confirm'
import ModelUses from './ModelUses'

const config = (id: number, name: string, enabled = true) => ({ id, name, provider: 'openai', model: `${name}-model`, enabled }) as unknown as ModelConfigResponse
const CONFIGS = [config(1, 'chat'), config(2, 'strong'), config(3, 'off', false), config(4, 'old', false)]
const state = (fields: Partial<ModelUseState>): ModelUseState => ({
  use: 'investigation', on: true, choice: null, answers: { id: 1, name: 'chat' }, by: 'chat', problem: '', chart_model: '', daily_token_budget: null, ...fields,
})
const USES = [
  state({ daily_token_budget: 200000 }),
  state({ use: 'investigate_now', choice: { id: 2, name: 'strong', enabled: true }, answers: { id: 2, name: 'strong' }, by: 'choice', daily_token_budget: 0 }),
  state({ use: 'optimization', choice: { id: 4, name: 'old', enabled: false } }),
]
const CHART = state({ choice: { id: 2, name: 'strong', enabled: true }, answers: { id: 1, name: 'chat' }, by: 'chart', chart_model: 'chat' })
const refusal = (status: number, detail: string) => ({ response: { status, data: { detail } }, message: `Request failed with status code ${status}` })

let root: Root | null = null
let container: Element
let uses: ModelUseState[]
let asked: ConfirmOptions[]
let answer: boolean
const listed = vi.spyOn(api, 'listModelUses')
const put = vi.spyOn(api, 'setModelUse')

beforeEach(() => {
  uses = USES
  asked = []
  answer = true
  shown.catalog = en
  shown.english = true
  listed.mockReset().mockImplementation(async () => uses)
  put.mockReset().mockImplementation(async () => uses)
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  shown.dropdowns.clear()
})

const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 10)) })

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = (document as unknown as { container: () => Element }).container()
  root = createRoot(container)
  const confirm = async (o: ConfirmOptions) => { asked.push(o); return answer }
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client }, createElement(ConfirmContext.Provider, { value: confirm }, createElement(ModelUses, { configs: CONFIGS }))))
  })
  await settle()
}

type Drawn = { attributes?: Record<string, string>; childNodes: Drawn[]; textContent: string }
const all = (node: Drawn): Drawn[] => [node, ...node.childNodes.flatMap(all)]
const byId = (id: string) => all(container as unknown as Drawn).filter((n) => n.attributes?.['data-testid'] === id)
const textOf = (id: string) => byId(id).map((n) => n.textContent).join('|')
// react-dom keeps an element's props on its node; the stand-in document delivers no events
const press = async (id: string) => {
  const node = byId(id)[0] as unknown as Record<string, { onClick?: () => void; disabled?: boolean }>
  const props = node[Object.keys(node).find((k) => k.startsWith('__reactProps$')) as string]
  expect(props.disabled).toBeFalsy()
  await act(async () => { props.onClick?.() })
  await settle()
}
const field = (use: string) => shown.dropdowns.get(`model-use-${use}-select`) as Dropdown
const choose = async (use: string, value: string) => {
  await act(async () => { field(use).onChange(value) })
  await settle()
}

describe('what each use shows', () => {
  it('its choice, what it may be given and what answers it now, with the one sentence on a stronger model', async () => {
    await open()
    expect([...shown.dropdowns.keys()]).toEqual(['model-use-investigation-select', 'model-use-investigate_now-select', 'model-use-optimization-select'])
    expect(['investigation', 'investigate_now', 'optimization'].map((use) => field(use).label)).toEqual(['Alert investigations', 'Investigate now', 'Optimization explanation'])
    expect(['investigation', 'investigate_now', 'optimization'].map((use) => field(use).value)).toEqual(['', '2', '4'])
    // a disabled model is offered only where it is the choice, and cannot be picked
    expect(field('investigation').options.map((o) => [o.value, o.label, !!o.disabled])).toEqual([['', 'Active model', false], ['1', 'chat', false], ['2', 'strong', false]])
    expect(field('investigate_now').options[0].label).toBe('Same as alert investigations')
    expect(field('optimization').options.map((o) => [o.value, !!o.disabled])).toEqual([['', false], ['1', false], ['2', false], ['4', true]])
    expect(field('investigation').options[1].listHint).toContain('chat-model')
    expect(textOf('model-use-investigation')).toBe('Answers now: chatDaily budget: 200,000 tokens (UTC). It counts tokens, not money, whichever model answers.')
    expect(textOf('model-use-investigate_now')).toBe('Answers now: strongNo daily budget.')
    expect(textOf('model-use-optimization')).toBe('"old" is disabled, so it does not answer.Answers now: chat')
    expect(textOf('model-uses-stronger')).toBe('Finding the cause of a hard problem goes better with a stronger model. It is slower and more expensive.')
    expect(put).not.toHaveBeenCalled()
  })

  it('nothing until the server answered', async () => {
    listed.mockImplementation(() => new Promise(() => {}))
    await open()
    expect(byId('model-uses')).toHaveLength(0)
    expect(shown.dropdowns.size).toBe(0)
  })

  it("the server's reason, and no field, for who may not read it or when the read failed", async () => {
    listed.mockRejectedValue(refusal(403, 'Admin access required'))
    await open()
    expect(textOf('model-uses-error')).toBe('Could not read which model answers: Admin access required')
    expect(byId('model-uses-error')[0].attributes?.role).toBe('alert')
    expect(shown.dropdowns.size).toBe(0)
    expect(listed).toHaveBeenCalledTimes(1)
  })
})

describe('a pick', () => {
  it('says what it changes, sends the choice and reads the uses again', async () => {
    await open()
    uses = [USES[0], USES[1], state({ use: 'optimization', choice: { id: 2, name: 'strong', enabled: true }, answers: { id: 2, name: 'strong' }, by: 'choice' })]
    await choose('optimization', '2')
    expect(asked).toEqual([{ title: 'Change the model', confirmLabel: 'Change',
      message: 'Use "strong" for Optimization explanation? What it reads then goes to that model, at that model\'s price.' }])
    expect(put.mock.calls).toEqual([['optimization', 2]])
    expect(listed).toHaveBeenCalledTimes(2)
    expect(field('optimization').value).toBe('2')
    expect(textOf('model-use-optimization')).toBe('Answers now: strong')
  })

  it('of no model takes the choice away, saying what answers after', async () => {
    await open()
    await choose('investigate_now', '')
    expect(asked[0].message).toBe('Take away the choice for Investigate now? After that it runs on: Same as alert investigations.')
    expect(put.mock.calls).toEqual([['investigate_now', null]])
  })

  it('that was not confirmed, or is the choice already, sends nothing', async () => {
    await open()
    answer = false
    await choose('investigation', '2')
    expect(asked).toHaveLength(1)
    await choose('investigate_now', '2')
    await choose('investigation', '')
    expect(asked).toHaveLength(1)
    expect(put).not.toHaveBeenCalled()
  })

  it('locks every field while it is sent', async () => {
    await open()
    let done: (v: ModelUseState[]) => void = () => {}
    put.mockImplementation(() => new Promise((ok) => { done = ok }))
    await choose('investigation', '2')
    expect(['investigation', 'investigate_now', 'optimization'].map((use) => field(use).disabled)).toEqual([true, true, true])
    await act(async () => { done(uses) })
    await settle()
    expect(field('investigation').disabled).toBe(false)
  })
})

describe('a refused pick', () => {
  it.each([
    [409, 'features.alertInvestigation.model names "chat" in the chart, which decides for alert investigations'],
    [400, 'API key is missing for model config "strong" (provider=openai)'],
    [403, 'Admin access required'],
    [503, 'audit unavailable'],
  ])('says the server\'s reason under its own field (%i) and leaves the choice', async (status, detail) => {
    await open()
    put.mockRejectedValue(refusal(status, detail))
    await choose('investigation', '2')
    expect(textOf('model-use-investigation-error')).toBe(`Not changed: ${detail}`)
    expect(byId('model-use-investigate_now-error')).toHaveLength(0)
    expect(field('investigation').value).toBe('')
    expect(listed).toHaveBeenCalledTimes(1)
  })

  it('goes with the next one', async () => {
    await open()
    put.mockRejectedValueOnce(refusal(503, 'audit unavailable'))
    await choose('investigation', '2')
    await choose('optimization', '1')
    expect(byId('model-use-investigation-error')).toHaveLength(0)
    expect(byId('model-use-optimization-error')).toHaveLength(0)
  })
})

describe('a use the chart decides', () => {
  it('is locked on the chart\'s model and says the choice made here, which can be taken away', async () => {
    uses = [CHART, ...USES.slice(1)]
    await open()
    expect([field('investigation').disabled, field('investigation').options]).toEqual([true, [{ value: 'chart', label: 'Set in the chart: chat' }]])
    expect(byId('model-use-investigation-kept')[0].childNodes[0].textContent).toBe('"strong" is chosen here and applies once the chart names no model.')
    uses = [{ ...CHART, choice: null }, ...USES.slice(1)]
    await press('model-use-investigation-take-away')
    expect(asked[0].message).toBe('Take away the choice for Alert investigations? After that it runs on: chat.')
    expect(put.mock.calls).toEqual([['investigation', null]])
    expect(byId('model-use-investigation-kept')).toHaveLength(0)
  })

  it('says a refusal of that too, and asks before it', async () => {
    uses = [CHART]
    await open()
    answer = false
    await press('model-use-investigation-take-away')
    expect(put).not.toHaveBeenCalled()
    answer = true
    put.mockRejectedValue(refusal(503, 'audit unavailable'))
    await press('model-use-investigation-take-away')
    expect(textOf('model-use-investigation-error')).toBe('Not changed: audit unavailable')
    expect(byId('model-use-investigation-kept')).toHaveLength(1)
  })

  it('has no such line without a choice, and a use the chart leaves alone has none either', async () => {
    uses = [{ ...CHART, choice: null }, ...USES.slice(1)]
    await open()
    for (const use of ['investigation', 'investigate_now', 'optimization']) expect(byId(`model-use-${use}-kept`)).toHaveLength(0)
  })

  it('reads in Korean', async () => {
    shown.catalog = ko
    shown.english = false
    uses = [CHART]
    await open()
    expect(field('investigation').options[0].label).toBe('차트에서 정함: chat')
    expect(byId('model-use-investigation-kept')[0].childNodes[0].textContent).toBe('여기서 고른 "strong" 모델은 차트가 모델을 정하지 않으면 적용됩니다.')
    expect(textOf('model-use-investigation-take-away')).toBe(ko.admin.aiModels.perUse.takeAway)
    await press('model-use-investigation-take-away')
    expect(asked[0].title).toBe('모델 바꾸기')
  })
})
