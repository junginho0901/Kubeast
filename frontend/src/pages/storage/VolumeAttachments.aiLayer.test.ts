import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import VolumeAttachments from './VolumeAttachments'

// The floating chat counts the same errors as the screen's Errors card and status badge.

type Layer = { summary?: string; data?: { stats?: { total?: number; with_error?: number }; problematic_items?: { name: string }[] } }
const layers: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input) layers.push(input) } }))
vi.mock('@/services/useKubeWatchList', () => ({ useKubeWatchList: () => {}, LIST_GATHER_MS: 100 }))
vi.mock('@/hooks/useCanCreate', () => ({ useCanCreate: () => false }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/components/ResourceYamlCreateDialog', () => ({ default: () => null }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation'], defaultNS: 'translation',
    resources: { en: { translation: en } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { layers.length = 0 })

function open(rows: unknown[]): { html: string; layer: Layer } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  client.setQueryData(['storage', 'volumeattachments'], rows)
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client }, createElement(VolumeAttachments)))))
  return { html, layer: layers[layers.length - 1] }
}

const base = { attacher: 'csi', persistent_volume_name: 'pv', node_name: 'n1', created_at: '2026-11-01T00:00:00Z' }
const healthy = { ...base, name: 'va-ok', attached: true }
const failed = { ...base, name: 'va-failed', attached: false, attach_error: { message: 'rpc error', time: '2026-11-01T00:00:00Z' } }
// the API server keeps an error with no message: the screen does not read it as an error
const noMessage = { ...base, name: 'va-no-message', attached: true, attach_error: { message: '', time: '2026-11-01T00:00:00Z' } }
const noDetachMessage = { ...base, name: 'va-no-detach-message', attached: true, detach_error: { message: '', time: '2026-11-01T00:00:00Z' } }
const detachFailed = { ...base, name: 'va-detach-failed', attached: true, detach_error: { message: 'still in use', time: '2026-11-01T00:00:00Z' } }

describe('VolumeAttachments floating chat layer', () => {
  it('counts an error only when it has a message, as the Errors card does', () => {
    const { layer } = open([healthy, failed, noMessage, noDetachMessage, detachFailed])
    expect(layer.data?.stats).toEqual({ total: 5, with_error: 2 })
    expect(layer.summary).toContain('오류 2')
  })

  it('lists as a problem what the screen shows as Error', () => {
    const { layer } = open([healthy, failed, noMessage, noDetachMessage, detachFailed])
    expect(layer.data?.problematic_items?.map((row) => row.name).sort()).toEqual(['va-detach-failed', 'va-failed'])
  })

  it('says nothing is wrong when no error has a message', () => {
    const { layer } = open([healthy, noMessage])
    expect(layer.data?.stats).toEqual({ total: 2, with_error: 0 })
    expect(layer.summary).not.toContain('오류')
    expect(layer.data?.problematic_items ?? []).toEqual([])
  })
})
