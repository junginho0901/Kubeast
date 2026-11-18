import { afterAll, describe, expect, it, vi } from 'vitest'

// The Layout's session check, run in react-dom with the few DOM parts it touches (nothing it renders is an element, as
// in ClusterProvider.test.ts): only the server's 401 to /auth/me leaves for the sign-in page and empties the cache.
vi.hoisted(() => {
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  const window = Object.assign(new EventTarget(), { document, location: { search: '' }, HTMLIFrameElement: class {} })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSignInOnSessionEnd } from './useSignInOnSessionEnd'

const container = {
  nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument: document, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null,
} as unknown as HTMLElement

afterAll(() => {
  vi.unstubAllGlobals()
})

async function afterSessionRead(isError: boolean, error: unknown): Promise<{ path: string; cached: unknown }> {
  const client = new QueryClient()
  client.setQueryData(['workloads', 'pods'], ['web-1'])
  let path = ''
  function Where() {
    path = useLocation().pathname
    return null
  }
  function Check() {
    useSignInOnSessionEnd(isError, error)
    return null
  }
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ['/workloads/pods'] },
      createElement(QueryClientProvider, { client }, createElement(Where), createElement(Check))))
  })
  const seen = { path, cached: client.getQueryData(['workloads', 'pods']) }
  await act(async () => root.unmount())
  return seen
}

const answered = (status: number) => ({ response: { status } })

describe('the layout after a failed read of the session', () => {
  it('keeps the page and its rows when the server could not answer', async () => {
    for (const failure of [answered(503), answered(500), answered(429), new Error('Network Error')]) {
      expect(await afterSessionRead(true, failure)).toEqual({ path: '/workloads/pods', cached: ['web-1'] })
    }
  })

  it('goes to sign in, the cache emptied, on the server\'s 401', async () => {
    expect(await afterSessionRead(true, answered(401))).toEqual({ path: '/login', cached: undefined })
  })

  it('does nothing while the read has not failed', async () => {
    expect(await afterSessionRead(false, null)).toEqual({ path: '/workloads/pods', cached: ['web-1'] })
  })
})
