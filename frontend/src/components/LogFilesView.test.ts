import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { LogFilesView } from './LogFilesView'

// What the box says when the server refuses the read, by the reason k8s-service answers with.

vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
vi.mock('@/hooks/usePrometheusQuery', () => ({ useClusterFeatures: () => ({ data: undefined }) }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const refused = (status: number, reason: string, detail: string) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { reason, detail } } })

const render = (error: unknown, lng = 'en') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  const q = qc.getQueryCache().build(qc, { queryKey: ['log-files', 'c1', 'kubeast', 'auth-0', 'app'] })
  q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(QueryClientProvider, { client: qc }, createElement(LogFilesView, { namespace: 'kubeast', pod: 'auth-0', container: 'app' }))))
  return /data-testid="logfile-output"[^>]*><pre[^>]*>([^<]*)<\/pre>/.exec(html)?.[1].replace(/&#x27;/g, "'") ?? ''
}

// protectedns.Refusal's words for Kubeast's own namespace
const SERVER_WORDS = "forbidden: namespace kubeast holds Kubeast's own credentials on this cluster: only a global admin may read its Secrets, change anything in it or run commands in its pods"

describe('the log files box, when the server refuses', () => {
  it('says a namespace Kubeast guards is why, and who may read there', () => {
    const said = render(refused(403, 'protected_namespace', SERVER_WORDS))
    expect(said).toBe(en.clusterView.logFiles.errors.protected_namespace)
    expect(said).toContain('global admin')
    expect(said).toContain('resource.node.shell')
  })

  it('says it in Korean, not in the server\'s words', () => {
    const said = render(refused(403, 'protected_namespace', SERVER_WORDS), 'ko')
    expect(said).toBe(ko.clusterView.logFiles.errors.protected_namespace)
    expect(said).not.toContain('forbidden:')
    expect(said).toContain('전역 관리자')
  })

  it('keeps what it said of the cluster refusing pods/exec', () => {
    expect(render(refused(403, 'forbidden', 'pods/exec is forbidden'))).toBe(en.clusterView.logFiles.errors.forbidden)
  })

  it('says the server\'s words for a reason it has no text for', () => {
    expect(render(refused(403, 'some_later_reason', 'the server says why'))).toBe('the server says why')
  })
})
