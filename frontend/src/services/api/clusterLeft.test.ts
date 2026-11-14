import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// After a switch nothing of the cluster before may reach the screen. A read the client sent to the selected cluster
// that answers once another one is selected ends as a cancel (a list page's Refresh writes its rows into the cache
// after its read, under a key that names no cluster), and the stores drop the status events of requests sent while
// another cluster was selected (a late 403, timeout, "not installed" or answer of the cluster just left).

type Answer = { status: number; data?: unknown; headers?: Record<string, string> } | 'timeout'
type Modules = {
  client: typeof import('./client')['client']
  ref: typeof import('../clusterRef')
  forbidden: typeof import('../forbiddenStore')
  store: typeof import('../listStatusStore')
  readFailure: typeof import('@/hooks/useRefresh')['readFailure']
}

let m: Modules
// answers wait here until the test gives them
let waiting: Map<string, (a: Answer) => void>

const holdAnswers = () => {
  waiting = new Map()
  m.client.defaults.adapter = (config: InternalAxiosRequestConfig) => new Promise((resolve, reject) => {
    waiting.set(String(config.url), (a) => {
      if (a === 'timeout') reject(new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED', config))
      else if (a.status >= 400) {
        reject(new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { status: a.status, statusText: '', data: a.data, headers: {}, config }))
      } else resolve({ data: a.data, status: a.status, statusText: 'OK', headers: a.headers ?? {}, config })
    })
  })
}
const sent = async (url: string) => {
  await vi.waitFor(() => expect(waiting.has(url)).toBe(true))
}
const answer = (url: string, a: Answer) => {
  const give = waiting.get(url)
  if (!give) throw new Error(`no request for ${url}`)
  waiting.delete(url)
  give(a)
}
const outcome = (p: Promise<unknown>) => p.then((r) => ({ ok: r }), (e) => ({ failed: e }))
const fire = (type: string, detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent(type, { detail }))

beforeEach(async () => {
  // the stores listen on window from their first import: a fresh set of modules hears this window's events
  vi.resetModules()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '' } }))
  m = {
    client: (await import('./client')).client,
    ref: await import('../clusterRef'),
    forbidden: await import('../forbiddenStore'),
    store: await import('../listStatusStore'),
    readFailure: (await import('@/hooks/useRefresh')).readFailure,
  }
  m.ref.setCurrentClusterRef('a')
  holdAnswers()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a read of the cluster just left', () => {
  // Deployments.tsx's Refresh, as every list page writes it
  const refreshOf = (qc: QueryClient, key: unknown[]) => m.readFailure(async () => {
    const data = (await m.client.get('/cluster/deployments/all')).data
    qc.removeQueries({ queryKey: key })
    qc.setQueryData(key, data)
  })

  it("does not put its rows in the new cluster's list when a Refresh's answer comes after the switch", async () => {
    const qc = new QueryClient()
    const key = ['workloads', 'deployments', 'all']
    const refresh = refreshOf(qc, key)
    await sent('/cluster/deployments/all')
    m.ref.setCurrentClusterRef('b')
    answer('/cluster/deployments/all', { status: 200, data: ['web of a'] })
    await refresh

    expect(qc.getQueryData(key)).toBeUndefined()
  })

  it('a Refresh on the cluster it was pressed on writes its rows', async () => {
    const qc = new QueryClient()
    const key = ['workloads', 'deployments', 'all']
    const refresh = refreshOf(qc, key)
    await sent('/cluster/deployments/all')
    answer('/cluster/deployments/all', { status: 200, data: ['web of a'] })

    expect(await refresh).toBeNull()
    expect(qc.getQueryData(key)).toEqual(['web of a'])
  })

  it('ends as a cancel when it fails after the switch, and the new cluster keeps no failure of it', async () => {
    const timedOut = outcome(m.client.get('/cluster/pods/all'))
    const refused = outcome(m.client.get('/cluster/secrets/all'))
    await sent('/cluster/pods/all')
    await sent('/cluster/secrets/all')
    m.ref.setCurrentClusterRef('b')
    answer('/cluster/pods/all', 'timeout')
    answer('/cluster/secrets/all', { status: 403, data: { detail: 'secrets is forbidden' } })

    for (const r of [await timedOut, await refused]) {
      expect('failed' in r && axios.isCancel(r.failed), JSON.stringify(r)).toBe(true)
    }
    expect(m.store.getListStatus('pods')).toBeUndefined()
    expect(m.store.isKindServed('secrets')).toBe(false)
    expect(m.forbidden.forbiddenLabels()).toEqual([])
  })

  it('a read naming its own cluster, a read of a service that is no cluster\'s and a write answer as before', async () => {
    const named = outcome(m.client.get('/cluster/hygiene', { params: { cluster: 'a' } }))
    const me = outcome(m.client.get('/auth/me'))
    const created = outcome(m.client.post('/cluster/namespaces', { name: 'made' }))
    await sent('/cluster/hygiene')
    await sent('/auth/me')
    await sent('/cluster/namespaces')
    m.ref.setCurrentClusterRef('b')
    answer('/cluster/hygiene', { status: 200, data: 'report of a' })
    answer('/auth/me', { status: 200, data: 'me' })
    answer('/cluster/namespaces', { status: 201, data: 'made' })

    expect(await named).toMatchObject({ ok: { data: 'report of a' } })
    expect(await me).toMatchObject({ ok: { data: 'me' } })
    expect(await created).toMatchObject({ ok: { data: 'made' } })
  })

  it("a refusal or failure of a read sent under the cluster left goes into none of the new cluster's stores", async () => {
    // named its own cluster, so it is answered; what it says is still not the new cluster's
    const refused = outcome(m.client.get('/cluster/prometheus/status', { params: { cluster: 'a' } }))
    const failed = outcome(m.client.get('/cluster/hygiene', { params: { cluster: 'a' } }))
    await sent('/cluster/prometheus/status')
    await sent('/cluster/hygiene')
    m.ref.setCurrentClusterRef('b')
    answer('/cluster/prometheus/status', { status: 403 })
    answer('/cluster/hygiene', { status: 502, data: { detail: 'hygiene scan failed' } })
    await refused
    await failed

    expect(m.forbidden.forbiddenLabels()).toEqual([])
    expect(m.store.isKindServed('prometheus')).toBe(false)
    expect(m.store.getListStatus('hygiene')).toBeUndefined()
  })

  it("a refusal of the cluster on screen is still said", async () => {
    const refused = outcome(m.client.get('/cluster/secrets/all'))
    await sent('/cluster/secrets/all')
    answer('/cluster/secrets/all', { status: 403 })
    await refused

    expect(m.forbidden.forbiddenLabels()).toEqual(['Secret'])
  })
})

describe('the stores and the cluster a status event names', () => {
  beforeEach(() => m.ref.setCurrentClusterRef('b'))

  it("drop a refusal of the cluster before and keep the selected cluster's", async () => {
    const { FORBIDDEN_EVENT } = await import('./client')
    fire(FORBIDDEN_EVENT, { url: '/cluster/pods/all', list: true, cluster: 'a' })
    expect(m.forbidden.forbiddenLabels()).toEqual([])
    expect(m.store.isKindServed('pods')).toBe(false)

    fire(FORBIDDEN_EVENT, { url: '/cluster/pods/all', list: true, cluster: 'b' })
    expect(m.forbidden.forbiddenLabels()).toEqual(['Pod'])
    expect(m.store.isKindServed('pods')).toBe(true)
  })

  it('a read of the cluster before that answered does not take away a refusal of the selected one', async () => {
    const { FORBIDDEN_EVENT, LIST_STATUS_EVENT } = await import('./client')
    vi.stubGlobal('window', Object.assign(window, { location: { search: '?namespace=web' } }))
    fire(FORBIDDEN_EVENT, { url: '/cluster/namespaces/other/configmaps', list: true, cluster: 'b' })
    fire(LIST_STATUS_EVENT, { url: '/cluster/namespaces/web/configmaps', state: 'ok', cluster: 'a' })
    expect(m.forbidden.forbiddenLabels()).toEqual(['ConfigMap'])

    fire(LIST_STATUS_EVENT, { url: '/cluster/namespaces/web/configmaps', state: 'ok', cluster: 'b' })
    expect(m.forbidden.forbiddenLabels()).toEqual([])
  })

  it('drop a failure and a "not installed" of the cluster before, and its answer clears nothing of the selected one', async () => {
    const { LIST_STATUS_EVENT } = await import('./client')
    fire(LIST_STATUS_EVENT, { url: '/cluster/pods/all', state: 'error', code: undefined, cluster: 'a' })
    fire(LIST_STATUS_EVENT, { url: '/cluster/gateways/all', state: 'notInstalled', cluster: 'a' })
    expect(m.store.getListStatus('pods')).toBeUndefined()
    expect(m.store.getListStatus('gateways')).toBeUndefined()
    expect(m.store.isKindServed('gateways')).toBe(false)

    fire(LIST_STATUS_EVENT, { url: '/cluster/httproutes/all', state: 'notInstalled', cluster: 'b' })
    fire(LIST_STATUS_EVENT, { url: '/cluster/httproutes/all', state: 'ok', cluster: 'a' })
    expect(m.store.getListStatus('httproutes')).toEqual({ state: 'notInstalled' })
    expect(m.store.isKindServed('httproutes')).toBe(false)
  })
})
