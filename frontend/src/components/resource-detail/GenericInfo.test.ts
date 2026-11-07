import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import { enforceTokenBudget, MAX_LAYER_BYTES } from '@/utils/aiContext/tokenBudget'
import GenericInfo from './GenericInfo'

// A kind with no drawer of its own shows what its object says; the floating chat is told what the window shows.

type Layer = { source?: string; summary: string; data?: Record<string, any> }
const layers: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input) layers.push(input) } }))

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

const object = (over: Record<string, unknown> = {}) => ({
  apiVersion: 'example.com/v1',
  kind: 'Gadget',
  metadata: {
    name: 'x', namespace: 'ns', uid: 'uid-1', creationTimestamp: '2026-11-01T00:00:00Z',
    labels: { team: 'a' },
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"password":"fake-value-for-test"}', 'example.com/note': 'kept' },
  },
  spec: {
    replicas: 2, type: 'ClusterIP', clusterIP: '10.0.0.1', nodeName: 'node-1', serviceAccountName: 'sa-1',
    containers: [{ name: 'app', image: 'example.com/app:1', env: [{ name: 'A', value: 'x'.repeat(50) }] }],
    ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
  },
  status: { phase: 'Running', replicas: 2, readyReplicas: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'Fine', message: 'ok' }] },
  ...over,
})

const events = [{ type: 'Normal', reason: 'Seen', message: 'seen once', count: 1 }]

const layerOf = (rawJson: Record<string, unknown>, kind = 'Gadget', listed: unknown[] = events) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['generic-describe', kind, 'ns', 'x'], { events: listed })
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
    createElement(GenericInfo, { name: 'x', namespace: 'ns', kind, rawJson }))))
  const layer = layers.filter((l) => l.source === `${kind}Info`).at(-1)
  return { html, data: enforceTokenBudget({ source: layer?.source ?? '', summary: layer?.summary ?? '', data: layer?.data }).data as Record<string, any> }
}

describe('what the window of a kind with no drawer of its own tells the floating chat', () => {
  it('is what it shows of the object', () => {
    const { html, data } = layerOf(object())
    for (const value of ['example.com/v1', 'uid-1', 'Running', '10.0.0.1', 'node-1', 'sa-1', 'example.com/app:1', 'team']) {
      expect(html, value).toContain(value)
    }
    expect(data).toMatchObject({
      kind: 'Gadget', name: 'x', namespace: 'ns',
      api_version: 'example.com/v1', uid: 'uid-1', created_at: '2026-11-01T00:00:00Z',
      labels: { team: 'a' },
      spec: { replicas: 2, type: 'ClusterIP', clusterIP: '10.0.0.1', nodeName: 'node-1', serviceAccountName: 'sa-1' },
      status: { phase: 'Running', replicas: 2, readyReplicas: 1 },
      events,
    })
    expect(data.spec.containers[0]).toMatchObject({ name: 'app', image: 'example.com/app:1' })
    expect(data.status.conditions).toEqual([{ type: 'Ready', status: 'True', reason: 'Fine', message: 'ok' }])
  })

  it('names the annotations and holds none of their values, which can repeat a whole object', () => {
    const { data } = layerOf(object())
    expect(data.annotations).toEqual(['kubectl.kubernetes.io/last-applied-configuration', 'example.com/note'])
    expect(JSON.stringify(data)).not.toContain('fake-value-for-test')
  })

  it('stays what the window shows when the object is past the layer\'s limit, and says what it left out', () => {
    const large = object({
      spec: { ...object().spec, rules: Array.from({ length: 400 }, (_, i) => ({ name: `rule-${i}`, text: 'y'.repeat(60) })) },
      status: { ...object().status, history: Array.from({ length: 400 }, (_, i) => ({ at: i, text: 'z'.repeat(60) })) },
    })
    const { data } = layerOf(large)
    expect(data.__truncated__).toBeUndefined()
    expect(new Blob([JSON.stringify(data)]).size).toBeLessThanOrEqual(MAX_LAYER_BYTES)
    expect(data).toMatchObject({ kind: 'Gadget', name: 'x', api_version: 'example.com/v1', labels: { team: 'a' }, events })
    expect(data.spec).toMatchObject({ replicas: 2, nodeName: 'node-1' })
    expect(data.spec.containers).toEqual([{ name: 'app', image: 'example.com/app:1' }])
    expect(data.spec.rules).toBeUndefined()
    expect(data.status).toMatchObject({ phase: 'Running', readyReplicas: 1 })
    expect(data.status.conditions).toHaveLength(1)
    expect(data.status.history).toBeUndefined()
    expect(data.object_cut).toEqual(['spec', 'status'])
  })

  it('leaves out the status only when the spec alone was enough', () => {
    const large = object({ spec: { ...object().spec, rules: Array.from({ length: 400 }, (_, i) => ({ name: `rule-${i}`, text: 'y'.repeat(60) })) } })
    const { data } = layerOf(large)
    expect(data.object_cut).toEqual(['spec'])
    expect(data.status).toEqual(object().status)
  })

  it('keeps the newest events, how many there are and the rest of the layer when the events alone are past the limit', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      type: 'Normal', reason: `Seen${i}`, message: 'm'.repeat(80), count: 1,
      last_timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    }))
    const { data } = layerOf(object(), 'Gadget', many)
    expect(data.__truncated__).toBeUndefined()
    expect(new Blob([JSON.stringify(data)]).size).toBeLessThanOrEqual(MAX_LAYER_BYTES)
    expect(data.object_cut).toContain('events')
    expect(data.events_total).toBe(300)
    expect(data.events.length).toBeGreaterThan(0)
    expect(data.events.length).toBeLessThan(300)
    expect(data.events[0].reason).toBe('Seen299')
    expect(data).toMatchObject({ kind: 'Gadget', api_version: 'example.com/v1', status: { phase: 'Running' } })
  })

  it('says nothing was cut when all of it fits', () => {
    expect(layerOf(object()).data).not.toHaveProperty('object_cut')
  })

  it('holds no value of a Secret that comes to this window', () => {
    const { data } = layerOf(object({ kind: 'Secret', data: { password: 'ZmFrZS12YWx1ZS1mb3ItdGVzdA==' }, stringData: { password: 'fake-value-for-test' } }), 'Secret')
    const text = JSON.stringify(data)
    expect(text).not.toContain('fake-value-for-test')
    expect(text).not.toContain('ZmFrZS12YWx1ZS1mb3ItdGVzdA==')
  })
})
