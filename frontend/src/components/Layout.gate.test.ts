import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import Layout from './Layout'
import ConfirmProvider from './ConfirmProvider'
import { PageContextProvider } from './PageContextProvider'
import { ClusterProvider } from '@/contexts/ClusterProvider'

// What Layout draws in a page's place for each answer of the cluster list, as it draws it: the page only once the
// selection is settled (ClusterGate), the "no accessible cluster" placeholder only on an answer of none for someone
// who is not a global admin, and the loading line while it waits — also for a global admin, and on the account page.

type List = { clusters: string[] } | 'pending' | 'failed'

function draw({ list, url, admin = false }: { list: List; url: string; admin?: boolean }): 'page' | 'waits' | 'no cluster' | string {
  // a list that failed is drawn as its failure, not asked again on the first draw
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['me'], {
    id: 'u1', name: 'u1', role: { id: 2, name: admin ? 'Admin' : 'Member', permissions: [] }, created_at: '', updated_at: '',
    permissions_matrix: admin ? { '*': ['*'] } : { self: ['resource.objects.read'], default: ['resource.objects.read'] },
  })
  if (typeof list === 'object') qc.setQueryData(['clusters-accessible'], list.clusters.map((id) => ({ id, display_name: id })))
  if (list === 'failed') {
    const q = qc.getQueryCache().build(qc, { queryKey: ['clusters-accessible'] })
    q.setState({ ...q.state, status: 'error', error: new Error('Request failed with status code 500'), errorUpdatedAt: Date.now(), errorUpdateCount: 2, fetchFailureCount: 2 })
  }
  // as App draws it
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] },
    createElement(QueryClientProvider, { client: qc },
      createElement(PageContextProvider, null, createElement(ConfirmProvider, null,
        createElement(ClusterProvider, null,
          createElement(Routes, null,
            createElement(Route, { path: '/', element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement('p', null, 'the page') }),
              createElement(Route, { path: 'account', element: createElement('p', null, 'the page') })))))))))
  const found = [html.includes('<p>the page</p>') && 'page', html.includes('data-testid="route-loading"') && 'waits', html.includes('data-testid="no-accessible-cluster"') && 'no cluster'].filter(Boolean)
  return found.length === 1 ? found[0] as string : `drew ${JSON.stringify(found)}`
}

describe('Layout and the cluster list', () => {
  it('draws the page once the selection is one of the clusters listed, and waits before', () => {
    expect([
      draw({ list: { clusters: ['self'] }, url: '/?cluster=self' }),
      draw({ list: { clusters: ['default', 'self'] }, url: '/' }),
      draw({ list: { clusters: ['self'] }, url: '/?cluster=gone' }),
      draw({ list: 'pending', url: '/?cluster=self' }),
      draw({ list: 'pending', url: '/' }),
    ]).toEqual(['page', 'waits', 'waits', 'waits', 'waits'])
  })

  it('waits for a global admin and on the account page too', () => {
    expect([
      draw({ list: 'pending', url: '/', admin: true }),
      draw({ list: { clusters: ['default'] }, url: '/account' }),
      draw({ list: { clusters: ['default'] }, url: '/account?cluster=default' }),
    ]).toEqual(['waits', 'waits', 'page'])
  })

  it('says there is no cluster to reach only on an answer of none, and not to a global admin', () => {
    expect([
      draw({ list: { clusters: [] }, url: '/' }),
      draw({ list: { clusters: [] }, url: '/', admin: true }),
      draw({ list: { clusters: [] }, url: '/account' }),
      draw({ list: 'failed', url: '/' }),
    ]).toEqual(['no cluster', 'page', 'page', 'page'])
  })

  it('draws the page on a list that could not be read: the selection there is read, as the screens did before', () => {
    expect([draw({ list: 'failed', url: '/?cluster=self' }), draw({ list: 'failed', url: '/', admin: true })]).toEqual(['page', 'page'])
  })
})
