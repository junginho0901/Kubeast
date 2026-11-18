import { afterEach, describe, expect, it, vi } from 'vitest'

// The Monitoring page draws no number of its own: each tab reads its metrics every 5 s and is drawn again only for what
// it shows. These tests run the page in react-dom with a few DOM parts, the tabs stood in by components that hold
// their read and are not drawn again by it, and count the page's renders across the tab's reads.

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

const counts = vi.hoisted(() => ({ page: 0, tab: 0, reads: 0 }))
vi.mock('react-i18next', () => ({
  useTranslation: () => {
    counts.page += 1 // only the page asks for it: the tabs are stood in
    return { t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }
  },
}))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/services/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/api')>()
  return { ...real, api: { ...real.api, getNamespaces: async () => [] } }
})
// a tab holding its 5 s read, as MonitoringNodes does, drawn again by nothing of that read
vi.mock('@/pages/monitoring/MonitoringNodes', async () => {
  const { useQuery } = await import('@tanstack/react-query')
  return {
    default: function NodesTab() {
      counts.tab += 1
      useQuery({ queryKey: ['node-metrics', 'c1'], queryFn: async () => { counts.reads += 1; return [{ name: 'n1', cpu: '1m' }] }, notifyOnChangeProps: [] })
      return null
    },
  }
})
vi.mock('@/pages/monitoring/MonitoringPods', () => ({ default: () => null }))

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import Monitoring from './Monitoring'

let root: Root | null = null
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  Object.assign(counts, { page: 0, tab: 0, reads: 0 })
})

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot((document as unknown as { container: () => Element }).container())
  await act(async () => { root!.render(createElement(QueryClientProvider, { client }, createElement(Monitoring))) })
  await act(async () => { await client.refetchQueries({ queryKey: ['namespaces'] }) })
  await vi.waitFor(() => expect(client.getQueryData(['node-metrics', 'c1'])).toBeDefined())
  // the page's own read (the namespaces) tells its observer on a later tick: let it land before counting
  await act(async () => { await new Promise((done) => setTimeout(done, 20)) })
  return client
}

describe('the Monitoring page across its tab\'s reads', () => {
  it('is not drawn again, nor its tab, by a read of the tab\'s metrics', async () => {
    const client = await open()
    const before = { page: counts.page, tab: counts.tab, reads: counts.reads }
    for (let i = 0; i < 3; i++) {
      await act(async () => { await client.refetchQueries({ queryKey: ['node-metrics'] }) })
    }
    expect({ page: counts.page, tab: counts.tab, reads: counts.reads }).toEqual({ ...before, reads: before.reads + 3 })
  })

  it('watches nothing of the whole query cache, so a cache event asks the page nothing', async () => {
    const client = await open()
    expect(client.getQueryCache().hasListeners()).toBe(false)
  })
})
