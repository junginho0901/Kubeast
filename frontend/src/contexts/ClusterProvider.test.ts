import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// After a cluster switch nothing of the cluster before is drawn as the new one's — not in one commit. React Router
// applies the URL change in a transition, and the page re-mounted under the new cluster (Layout's key) used to read
// the old cache, refusals and notices before an effect after that render emptied them. These tests run
// the real provider in react-dom with the few DOM parts it touches while nothing it renders is an element, and note
// what each commit shows (layout effects run for every commit, painted or not).

vi.hoisted(() => {
  const stored = new Map<string, string>()
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  const window = Object.assign(new EventTarget(), {
    document,
    location: { search: '' },
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => { stored.set(k, String(v)) },
      removeItem: (k: string) => { stored.delete(k) },
    },
    HTMLIFrameElement: class {},
  })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

import { act, createElement, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { InternalAxiosRequestConfig } from 'axios'
import { AxiosError } from 'axios'

import { ClusterProvider } from './ClusterProvider'
import { useCluster } from './ClusterContext'
import { client } from '@/services/api/client'
import { useForbiddenLabels } from '@/services/forbiddenStore'
import { announceCreated, useCreatedNotice } from '@/services/createdNoticeStore'
import { recordWatchFrame, useWatchProblem } from '@/services/watchProblemStore'

client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const cluster = String((config.params as { cluster?: string } | undefined)?.cluster ?? '')
  if (config.url === '/cluster/secrets/all') {
    throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { status: 403, statusText: '', data: {}, headers: {}, config })
  }
  return { data: config.url === '/cluster/pods/all' ? `pods of ${cluster}` : null, status: 200, statusText: 'OK', headers: {}, config }
}

const container = {
  nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument: document, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null,
} as unknown as HTMLElement

let root: Root
let pick: (id: string) => void = () => {}

// give the answers and TanStack's notifications their turn
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)) })
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await settle()
  expect(ok()).toBe(true)
}

function Picker() {
  pick = useCluster().setCurrentCluster
  return null
}

const mount = async (body: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ['/?cluster=a'] },
      createElement(QueryClientProvider, { client: qc },
        createElement(ClusterProvider, null, createElement(Picker), body))))
  })
}

beforeEach(async () => {
  if (root) await act(async () => root.unmount())
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('a cluster switch', () => {
  type Shown = { cluster: string; rows: unknown; refused: string[]; notice: unknown; watch: unknown }
  const commits: Shown[] = []

  // a list page as Layout mounts it: under a key of the cluster, with the lines above it
  function Page() {
    const { currentCluster } = useCluster()
    const { data } = useQuery({ queryKey: ['workloads', 'pods', 'all'], queryFn: async () => (await client.get('/cluster/pods/all')).data })
    const refused = useForbiddenLabels()
    const notice = useCreatedNotice()
    const watch = useWatchProblem()
    useLayoutEffect(() => { commits.push({ cluster: currentCluster, rows: data, refused, notice, watch }) })
    return null
  }
  function Screen() {
    const { currentCluster } = useCluster()
    return createElement(Page, { key: currentCluster || 'default' })
  }

  it("draws the new cluster with none of the old one's rows, refusals, created line or watch problems", async () => {
    commits.length = 0
    await mount(createElement(Screen))
    await until(() => commits.at(-1)?.rows === 'pods of a')
    await act(async () => {
      await client.get('/cluster/secrets/all').catch(() => undefined)
      announceCreated('/', [{ kind: 'ConfigMap', name: 'made-on-a' }])
      recordWatchFrame('a\n/api/v1/pods?watch=1', { type: 'ERROR', error: { reason: 'forbidden' } })
    })
    await settle()
    expect(commits.at(-1)).toMatchObject({ cluster: 'a', rows: 'pods of a', refused: ['Secret'], watch: 'forbidden' })
    expect(commits.at(-1)?.notice).not.toBeNull()

    commits.length = 0
    await act(async () => pick('b'))
    await until(() => commits.at(-1)?.rows === 'pods of b')

    const onB = commits.filter((c) => c.cluster === 'b')
    expect(onB.length).toBeGreaterThan(0)
    expect(onB.filter((c) => c.rows === 'pods of a' || c.refused.length > 0 || c.notice !== null || c.watch !== undefined)).toEqual([])
    // and the cluster before is never drawn with the new one's rows
    expect(commits.filter((c) => c.cluster === 'a' && c.rows === 'pods of b')).toEqual([])
  })
})
