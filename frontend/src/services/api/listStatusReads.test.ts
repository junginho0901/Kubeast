import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A list's empty row says what the API client saw of that list (services/listStatusStore, keyed by the API segment).
// A read beside the list in the same segment — the GPU metrics next to the GPU lists, a Service drawer's Prometheus
// sums next to the Services list — is not the list: its 502 must not read as "Could not load gpu (server error 502):
// GPU metric gpu_util: …" over a list that answered, and its answer must not clear a failure of the list.

type Answer = { status: number; data?: unknown }
type Modules = {
  store: typeof import('../listStatusStore')
  client: typeof import('./client')['client']
  gpuApi: typeof import('./gpu')['gpuApi']
  networkApi: typeof import('./network')['networkApi']
}

const GPU_LIST = { total_gpu_capacity: 0, total_gpu_allocatable: 0, total_gpu_used: 0, total_gpu_waiting: 0, gpu_nodes: [], gpu_pods: [] }
const PROMETHEUS_SILENT = 'GPU metric gpu_util: metrics store error: prometheus request failed (status 503): store down'

let m: Modules
let answers: Record<string, Answer>

const answering = (routes: Record<string, Answer>) => {
  answers = routes
  m.client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const a = answers[String(config.url)]
    if (!a) throw new Error(`no answer for ${config.url}`)
    if (a.status >= 400) {
      throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { status: a.status, statusText: '', data: a.data, headers: {}, config })
    }
    return { data: a.data, status: a.status, statusText: 'OK', headers: {}, config }
  }
}
const settled = (p: Promise<unknown>) => p.then(() => undefined, () => undefined)

beforeEach(async () => {
  // the stores listen on window from their first import: a fresh set of modules hears this window's events
  vi.resetModules()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '' } }))
  m = {
    store: await import('../listStatusStore'),
    client: (await import('./client')).client,
    gpuApi: (await import('./gpu')).gpuApi,
    networkApi: (await import('./network')).networkApi,
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the GPU lists and the GPU metrics beside them', () => {
  it('a list that answered keeps no failure when only the metrics read failed', async () => {
    answering({
      '/cluster/gpu/dashboard': { status: 200, data: GPU_LIST },
      '/cluster/gpu/metrics': { status: 502, data: { detail: PROMETHEUS_SILENT } },
    })
    await m.gpuApi.getGPUDashboard()
    await settled(m.gpuApi.getGPUMetrics())
    expect(m.store.getListStatus('gpu')).toBeUndefined()
  })

  it("the metrics answering does not clear the list's own failure", async () => {
    answering({
      '/cluster/gpu/dashboard': { status: 502, data: { detail: 'list nodes: the server is currently unable to handle the request' } },
      '/cluster/gpu/metrics': { status: 200, data: { available: true, gpu_count: 0, gpus: [] } },
    })
    await settled(m.gpuApi.getGPUDashboard())
    await m.gpuApi.getGPUMetrics()
    expect(m.store.getListStatus('gpu')).toEqual({ state: 'error', code: 502, reason: 'list nodes: the server is currently unable to handle the request' })
  })

  it("a failure of the list itself is still the list's, with the server's reason", async () => {
    answering({ '/cluster/gpu/dashboard': { status: 500, data: { detail: 'list pods: etcd timed out' } } })
    await settled(m.gpuApi.getGPUDashboard())
    expect(m.store.getListStatus('gpu')).toEqual({ state: 'error', code: 500, reason: 'list pods: etcd timed out' })
  })
})

describe("the Services list and a Service drawer's backend sums", () => {
  const usage = '/cluster/namespaces/web/services/api/backend-usage'

  it('the sums failing on a silent Prometheus leave the list as it answered', async () => {
    answering({
      '/cluster/namespaces/web/services': { status: 200, data: [] },
      [usage]: { status: 502, data: { detail: 'metrics store error: prometheus proxy request failed (status 503)' } },
    })
    await m.networkApi.getServices('web')
    await settled(m.networkApi.serviceBackendUsage('web', 'api'))
    expect(m.store.getListStatus('services')).toBeUndefined()
  })

  it("a failure of the Services list is still the list's", async () => {
    answering({
      '/cluster/namespaces/web/services': { status: 500, data: { detail: 'list services: etcd timed out' } },
      [usage]: { status: 200, data: { available: true } },
    })
    await settled(m.networkApi.getServices('web'))
    await m.networkApi.serviceBackendUsage('web', 'api')
    expect(m.store.getListStatus('services')).toEqual({ state: 'error', code: 500, reason: 'list services: etcd timed out' })
  })
})
