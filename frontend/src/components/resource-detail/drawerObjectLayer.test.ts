import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import { enforceTokenBudget } from '@/utils/aiContext/tokenBudget'
import { ResourceDetailContext, type ResourceDetailTarget } from '../ResourceDetailContext'
import ResourceDetailDrawer from '../ResourceDetailDrawer'
import { ConfirmContext } from '@/services/confirm'
import { OBJECT_READ_EVERY_MS, drawerObjectLayer, followsObjectForChat, objectReadInterval } from './drawerObjectLayer'
import { objectResourceType } from './crDetail'

// A list row is the list's answer when the drawer opened. What the floating chat is told of the object is the object.

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => false }) }))
type Layer = { source?: string; summary: string; data?: Record<string, unknown> }
const layers: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input) layers.push(input) } }))
// the kinds' own views are not under test here
vi.mock('./ClusterRoleInfo', () => ({ default: () => null }))
vi.mock('./SecretInfo', () => ({ default: () => null }))
vi.mock('./PolicyViolations', () => ({ default: () => null }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  layers.length = 0
})

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } })
const objectOf = (replicas: number, extra: Record<string, unknown> = {}) => ({ metadata: { name: 'x', annotations: { 'a.example.com/b': 'long text' }, managedFields: [{ manager: 'kubectl' }] }, status: { replicas }, ...extra })

function drawerLayer(target: ResourceDetailTarget, live?: unknown, error?: unknown): Layer | undefined {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  const key = ['resource-json', target.kind, target.namespace, target.name, objectResourceType(target)]
  if (live) qc.setQueryData(key, live)
  if (error) {
    const q = qc.getQueryCache().build(qc, { queryKey: key })
    q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
  }
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
    createElement(ConfirmContext.Provider, { value: async () => true },
      createElement(ResourceDetailContext.Provider, { value: { target, open: () => {}, close: () => {}, goBack: () => {}, canGoBack: false } },
        createElement(ResourceDetailDrawer))))))
  return layers.filter((l) => l.source === 'ResourceDetailDrawer').at(-1)
}
const replicas = (layer?: Layer) => ((layer?.data?.raw as { status?: { replicas?: number } } | undefined)?.status?.replicas)
const row = { kind: 'ClusterRole', name: 'x', rawJson: objectOf(1) }

describe('what a drawer tells the floating chat of its object', () => {
  it('is the object as it is now, not the row it opened from', () => {
    const layer = drawerLayer(row, objectOf(5))
    expect(replicas(layer)).toBe(5)
    expect(layer?.data).not.toHaveProperty('raw_from')
  })

  it('is the row until the object has answered, and says it is the row', () => {
    const layer = drawerLayer(row)
    expect(replicas(layer)).toBe(1)
    expect(layer?.data?.raw_from).toBe('list_row_when_opened')
  })

  it('says the read failed when the object is gone, keeping the last it had', () => {
    const layer = drawerLayer(row, undefined, httpError(404))
    expect(replicas(layer)).toBe(1)
    expect(layer?.data?.raw_read_status).toBe(404)
  })

  it('leaves out what it always left out', () => {
    const raw = drawerLayer(row, objectOf(5))?.data?.raw as { metadata: Record<string, unknown> }
    expect(raw.metadata.managedFields).toBeUndefined()
    expect(raw.metadata.annotations).toEqual(['a.example.com/b'])
  })

  it('holds no value of a Secret, whichever answer it reads', () => {
    const secret = { kind: 'Secret', name: 'x', namespace: 'ns', rawJson: objectOf(1, { data: { password: 'ZmFrZQ==' }, stringData: { password: 'fake' } }) }
    for (const live of [undefined, objectOf(5, { data: { password: 'ZmFrZQ==' }, stringData: { password: 'fake' } })]) {
      const text = JSON.stringify(drawerLayer(secret, live)?.data)
      expect(text).not.toContain('ZmFrZQ==')
      expect(text).not.toContain('"fake"')
    }
  })

  // the token budget turns a layer past its limit into a stub with nothing in it
  it('keeps what fits of a large object, and says what it left out', () => {
    const large = objectOf(5, { spec: { containers: [{ env: 'x'.repeat(20_000) }] } })
    const layer = drawerLayer(row, large)
    const kept = enforceTokenBudget({ source: layer!.source!, summary: layer!.summary, data: layer!.data })
    expect(kept.data).not.toHaveProperty('__truncated__')
    expect(kept.data?.name).toBe('x')
    expect(replicas(kept as Layer)).toBe(5)
    expect(kept.data?.raw_omitted).toEqual(['spec'])
  })
})

describe('drawerObjectLayer', () => {
  it('leaves spec out first, then status, and keeps the metadata', () => {
    const big = 'x'.repeat(20_000)
    const out = drawerObjectLayer({ row: undefined, live: objectOf(5, { spec: { a: big }, status: { b: big } }), secret: false })
    expect(out.raw_omitted).toEqual(['spec', 'status'])
    expect((out.raw as { metadata: { name: string } }).metadata.name).toBe('x')
  })

  it('has nothing to say with no object', () => {
    expect(drawerObjectLayer({ row: undefined, live: undefined, secret: false })).toEqual({})
    expect(drawerObjectLayer({ row: undefined, live: undefined, secret: false, readStatus: 403 })).toEqual({ raw_read_status: 403 })
  })
})

describe('reading the object again for the chat', () => {
  it('skips what cannot be read this way', () => {
    // the generic read of a Secret is an audited reveal for whoever may reveal it
    expect(followsObjectForChat('Secret')).toBe(false)
    // these load their own object, and a custom resource is named by its CRD
    expect(followsObjectForChat('Node')).toBe(false)
    expect(followsObjectForChat('Namespace')).toBe(false)
    expect(followsObjectForChat('CustomResourceInstance')).toBe(false)
    expect(followsObjectForChat('Deployment')).toBe(true)
    expect(followsObjectForChat('Widget')).toBe(true)
  })

  it('goes on after a failure that may pass and stops on an answer that will not change', () => {
    expect(objectReadInterval(true, null)).toBe(OBJECT_READ_EVERY_MS)
    expect(objectReadInterval(true, httpError(503))).toBe(OBJECT_READ_EVERY_MS)
    expect(objectReadInterval(true, new Error('Network Error'))).toBe(OBJECT_READ_EVERY_MS)
    for (const status of [400, 403, 404]) expect(objectReadInterval(true, httpError(status))).toBe(false)
    expect(objectReadInterval(false, null)).toBe(false)
  })

  it('has no clock while a watch of the object answers: the watch says when to read', () => {
    expect(objectReadInterval(true, null, true)).toBe(false)
    expect(objectReadInterval(true, null, false)).toBe(OBJECT_READ_EVERY_MS)
  })

  it('reads again after a failure that may pass even with a watch that answers, which says nothing until the object changes', () => {
    expect(objectReadInterval(true, httpError(503), true)).toBe(OBJECT_READ_EVERY_MS)
    expect(objectReadInterval(true, new Error('Network Error'), true)).toBe(OBJECT_READ_EVERY_MS)
    for (const status of [400, 403, 404]) expect(objectReadInterval(true, httpError(status), true)).toBe(false)
  })
})
