import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import { PageContextProvider } from '@/components/PageContextProvider'
import { podDrawerStatus, podLastStates, podLastStateText } from '@/pages/workloads/pods/podHelpers'
import { fmtTs } from './detailFormat'
import PodInfo from './PodInfo'

const crashed = (name: string, reason: string, exit_code = 137) => ({
  name,
  state: { running: {} },
  last_state: { terminated: { reason, exit_code, finished_at: '2026-11-06T10:00:00Z' } },
})

// The Status tile is what the Pods list and kubectl print; what happened before, and the pod's own reason, have rows
// of their own, so nothing the tile used to say goes missing.
describe('the Pod drawer\'s Status tile', () => {
  it('is the Status the list shows, not a container\'s last crash', () => {
    expect(podDrawerStatus({ status: 'Running', containers: [crashed('app', 'OOMKilled')] }, 'Running')).toBe('Running')
    expect(podDrawerStatus({ status: 'Running', status_reason: 'Evicted' }, 'Running')).toBe('Running')
    expect(podDrawerStatus({ status: 'ContainerStatusUnknown', status_reason: 'Evicted' }, 'Failed')).toBe('ContainerStatusUnknown')
    expect(podDrawerStatus({ status: 'CrashLoopBackOff', containers: [crashed('app', 'Error', 1)] }, 'Running')).toBe('CrashLoopBackOff')
  })

  it('keeps kubectl\'s word for a pod initializing, being deleted or held by gates', () => {
    expect(podDrawerStatus({ status: 'Terminating', status_reason: 'CrashLoopBackOff' }, 'Running')).toBe('Terminating')
    expect(podDrawerStatus({ status: 'Init:Error', status_reason: 'PodInitializing' }, 'Pending')).toBe('Init:Error')
    expect(podDrawerStatus({ status: 'SchedulingGated' }, 'Pending')).toBe('SchedulingGated')
  })

  it('without a Status from the server is the phase', () => {
    expect(podDrawerStatus(undefined, 'Running')).toBe('Running')
    expect(podDrawerStatus({}, '-')).toBe('-')
  })
})

describe('a pod\'s last states', () => {
  it('names each container that ended before, with why, the exit code and when', () => {
    expect(podLastStates([crashed('app', 'OOMKilled'), { name: 'quiet', state: { running: {} }, last_state: {} }, crashed('side', 'Error', 1)])).toEqual([
      { container: 'app', reason: 'OOMKilled', exit_code: 137, finished_at: '2026-11-06T10:00:00Z' },
      { container: 'side', reason: 'Error', exit_code: 1, finished_at: '2026-11-06T10:00:00Z' },
    ])
  })

  it('keeps a container that ended without a reason, and has none for a container that never ended', () => {
    expect(podLastStates([{ name: 'app', last_state: { terminated: { exit_code: 2 } } }])).toEqual([{ container: 'app', reason: '', exit_code: 2, finished_at: undefined }])
    expect(podLastStates([{ name: 'app', state: { running: {} } }, {}])).toEqual([])
  })

  it('reads "-" with none, the reason and exit code with one, and each container\'s name with several', () => {
    expect(podLastStateText([])).toBe('-')
    expect(podLastStateText(podLastStates([crashed('app', 'OOMKilled')]))).toBe('OOMKilled (exit code 137)')
    expect(podLastStateText(podLastStates([crashed('app', 'OOMKilled'), crashed('side', 'Error', 1)]))).toBe('app: OOMKilled (exit code 137), side: Error (exit code 1)')
    expect(podLastStateText([{ container: 'app', reason: '', exit_code: 2 }])).toBe('exit code 2')
  })
})

describe('the Pod drawer', () => {
  const i18n = i18next.createInstance()
  beforeAll(async () => {
    await i18n.use(initReactI18next).init({ lng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation', resources: { en: { translation: en, detail: {} } }, interpolation: { escapeValue: false } })
  })
  const render = (describeAnswer: Record<string, unknown>) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['pod-describe', 'ns', 'p'], describeAnswer)
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
      createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(PodInfo, { name: 'p', namespace: 'ns' }))))))
  }
  const row = (html: string, label: string) => {
    const at = html.indexOf(`>${label}</span>`)
    if (at < 0) return `no ${label} row`
    return html.slice(at).match(/<span class="text-ink font-medium break-all">(.*?)<\/span>/)?.[1]
  }
  const tile = (html: string) => html.match(/>Status<\/div><div[^>]*>(.*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '')

  it('moves a Running pod\'s last crash from the Status tile to its own row', () => {
    const html = render({ phase: 'Running', status: 'Running', ready: '1/1', containers: [{ ...crashed('app', 'OOMKilled'), ready: true }] })
    expect(tile(html)).toBe('Running')
    expect(row(html, 'Last State')).toBe(`OOMKilled (exit code 137, ${fmtTs('2026-11-06T10:00:00Z')})`)
    expect(row(html, 'Reason')).toBe('-')
    expect(row(html, 'Message')).toBe('-')
  })

  it('keeps a pod\'s own reason on screen when its Status says something else', () => {
    const html = render({ phase: 'Failed', status: 'ContainerStatusUnknown', status_reason: 'Evicted', status_message: 'The node was low on memory.', ready: '0/1', containers: [{ name: 'app' }] })
    expect(tile(html)).toBe('ContainerStatusUnknown')
    expect(row(html, 'Reason')).toBe('Evicted')
    expect(row(html, 'Message')).toBe('The node was low on memory.')
    expect(row(html, 'Last State')).toBe('-')
  })

  it('tells the floating chat the same words', () => {
    const src = readFileSync(fileURLToPath(new URL('./PodInfo.tsx', import.meta.url)), 'utf8')
    for (const field of ['status: desc?.status', 'status_reason: desc?.status_reason', 'last_states: podLastStates(containers)']) expect(src, field).toContain(field)
  })
})
