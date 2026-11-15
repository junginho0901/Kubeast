import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The real provider in react-dom under a MemoryRouter, with the few DOM parts it touches (as ClusterProvider.test.ts).

vi.hoisted(() => {
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  const window = Object.assign(new EventTarget(), { document, location: { search: '' }, HTMLIFrameElement: class {} })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

import { act, createElement, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { ClusterViewProvider } from './ClusterViewProvider'
import { useClusterView } from './ClusterViewContext'
import type { ClusterViewContextValue } from './ClusterViewContext'

const container = {
  nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument: document, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null,
} as unknown as HTMLElement

const i18n = i18next.createInstance()
let root: Root
let view: ClusterViewContextValue
const moves: string[] = []

// every navigation, by its kind and address (a new location key each, also to the same address)
function Probe() {
  view = useClusterView()
  const location = useLocation()
  const type = useNavigationType()
  useLayoutEffect(() => { moves.push(`${type} ${location.search}`) }, [location.key, location.search, type])
  return null
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: {} })
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n },
      createElement(MemoryRouter, { initialEntries: ['/cluster-view?cluster=self'] },
        createElement(ClusterViewProvider, null, createElement(Probe)))))
  })
})

afterAll(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})

describe("the node's own view in the address", () => {
  it('pushes opening and closing, replaces a page turned, and navigates nowhere when the address would stay', async () => {
    moves.length = 0
    await act(async () => view.openNodeView('n1'))
    await act(async () => view.openNodeView('n1'))
    await act(async () => view.moveNodeView({ page: 2 }))
    await act(async () => view.moveNodeView({ page: 2 }))
    await act(async () => view.setNodeViewPage(2))
    await act(async () => view.openNodeView('n2'))
    await act(async () => view.closeNodeView())
    await act(async () => view.closeNodeView())
    expect(moves).toEqual([
      'PUSH ?cluster=self&node=n1',
      'REPLACE ?cluster=self&node=n1&nodePage=2',
      'PUSH ?cluster=self&node=n2',
      'PUSH ?cluster=self',
    ])
  })
})
