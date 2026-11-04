import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import ko from '../../i18n/locales/ko.json'
import { api } from '@/services/api'
import { client } from '@/services/api/client'
import PolicyViolations from './PolicyViolations'
import { readViolations, violationsAfterInfo, violationsNameTheResource, violationsView } from './violationsView'

// The "Policy violations" section of every drawer a policy report can name: Pod's form for any kind, the rows of a
// cluster-scoped resource from the ClusterPolicyReports, and why when the reports could not be read.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['translation', 'detail'],
    defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} }, ko: { translation: ko, detail: (ko as { detail: Record<string, string> }).detail } },
    interpolation: { escapeValue: false },
  })
})
afterEach(() => vi.restoreAllMocks())

const row = (result: string, policy: string, kind = 'ConfigMap', name = 'cm-a') => ({ namespace: 'shop', kind, name, policy, rule: 'r', result, severity: 'high', message: `${policy} says ${result}`, report: 'rep' })
const REFUSED = 'clusterpolicyreports.wgpolicyk8s.io is forbidden: User "u" cannot list resource "clusterpolicyreports"'
const axiosError = (status: number, detail?: string) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: detail ? { detail } : {} } })
const ON = { data: { installed: true } }

describe('violationsView', () => {
  it('shows nothing while the feature is off, the user is not given reports, the status is unknown or the CRD is missing', () => {
    expect(violationsView(false, ON, { data: { rows: [] } })).toEqual({ show: 'nothing' })
    expect(violationsView(true, { error: axiosError(403, 'no permission') }, {})).toEqual({ show: 'nothing' })
    expect(violationsView(true, {}, {})).toEqual({ show: 'nothing' })
    expect(violationsView(true, { data: { installed: false } }, {})).toEqual({ show: 'nothing' })
    // the not-installed answer of a report kind the cluster does not serve
    expect(violationsView(true, ON, { data: [] })).toEqual({ show: 'nothing' })
  })

  it('says why the reports could not be read: the server\'s reason, else the error', () => {
    expect(violationsView(true, ON, { error: axiosError(403, REFUSED) })).toEqual({ show: 'error', reason: REFUSED })
    expect(violationsView(true, ON, { error: axiosError(502) })).toEqual({ show: 'error', reason: 'Request failed with status code 502' })
    expect(violationsView(true, { error: axiosError(500, 'discovery failed') }, {})).toEqual({ show: 'error', reason: 'discovery failed' })
    // a refetch that failed is said, not the rows it had
    expect(violationsView(true, ON, { data: { rows: [row('fail', 'p')] }, error: axiosError(403, REFUSED) })).toEqual({ show: 'error', reason: REFUSED })
  })

  it('is loading until the answer comes, then the fail, warn and error rows in the answer\'s order', () => {
    expect(violationsView(true, ON, {})).toEqual({ show: 'loading' })
    const rows = [row('fail', 'a'), row('pass', 'b'), row('warn', 'c'), row('skip', 'd'), row('error', 'e')]
    expect(violationsView(true, ON, { data: { rows } })).toEqual({ show: 'rows', rows: [rows[0], rows[2], rows[4]] })
    expect(violationsView(true, ON, { data: { rows: [row('pass', 'b')] } })).toEqual({ show: 'rows', rows: [] })
  })
})

describe('which drawers', () => {
  it('a workload\'s rows name their resource (its pods); every other kind\'s are its own', () => {
    for (const k of ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']) expect(violationsNameTheResource(k), k).toBe(true)
    for (const k of ['Pod', 'ConfigMap', 'Service', 'Namespace', 'ClusterRole', 'Widget']) expect(violationsNameTheResource(k), k).toBe(false)
  })

  it('every drawer but Pod\'s and the workloads\' gets the section after its own', () => {
    expect(violationsAfterInfo('Pod', 'shop')).toBe(false)
    expect(violationsAfterInfo('Deployment', 'shop')).toBe(false)
    expect(violationsAfterInfo('CronJob', 'shop')).toBe(false)
    for (const [k, ns] of [['ConfigMap', 'shop'], ['Service', 'shop'], ['Secret', 'shop'], ['Namespace', undefined], ['Node', undefined], ['ClusterRole', undefined], ['CustomResourceInstance', 'shop'], ['VerticalPodAutoscaler', 'shop']] as const) {
      expect(violationsAfterInfo(k, ns), k).toBe(true)
    }
  })

  it('the drawer renders it after the Info content for those kinds, with the object\'s own Kind', () => {
    const src = readFileSync(fileURLToPath(new URL('../ResourceDetailDrawer.tsx', import.meta.url)), 'utf8')
    expect(src).toMatch(/\) : renderInfoContent\(\)\}\s*\{!unreadable && !resolving && violationsAfterInfo\(kind, ns\) && <PolicyViolations kind=\{displayKind\} namespace=\{ns \?\? ''\} name=\{name\} \/>\}/)
  })

  it('a namespaced resource reads its namespace\'s reports, a cluster-scoped one the cluster reports', async () => {
    const ns = vi.spyOn(api, 'getResourcePolicyReports').mockResolvedValue([])
    const cluster = vi.spyOn(api, 'getClusterResourcePolicyReports').mockResolvedValue([])
    await readViolations('shop', 'ConfigMap', 'cm-a')
    await readViolations('', 'Namespace', 'shop')
    expect(ns.mock.calls).toEqual([['shop', 'ConfigMap', 'cm-a']])
    expect(cluster.mock.calls).toEqual([['Namespace', 'shop']])
  })

  it('the cluster route is /cluster/policyreports/resource with the kind and name', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: { rows: [] } })
    await api.getClusterResourcePolicyReports('Namespace', 'shop')
    await api.getClusterResourcePolicyReports('ClusterRole', 'admin', true)
    expect(get.mock.calls).toEqual([
      ['/cluster/policyreports/resource', { params: { kind: 'Namespace', name: 'shop', force_refresh: undefined } }],
      ['/cluster/policyreports/resource', { params: { kind: 'ClusterRole', name: 'admin', force_refresh: true } }],
    ])
  })
})

// the section rendered with a seeded cache: the features, the status and the resource's answer (or its error)
function render(lng: string, kind: string, namespace: string, answer: { data?: unknown; error?: unknown }, installed = true) {
  // an errored query is not fetched again on mount, so the server render shows the error
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['clusters-accessible'], [])
  qc.setQueryData(['cluster-features', ''], { policyReports: { enabled: true } })
  qc.setQueryData(['cluster', 'policyreports', 'status'], { enabled: true, installed, group: 'wgpolicyk8s.io/v1alpha2' })
  const key = ['cluster', 'policyreports', 'resource', namespace, kind, 'cm-a']
  if (answer.data !== undefined) qc.setQueryData(key, answer.data)
  if (answer.error) {
    qc.getQueryCache().build(qc, { queryKey: key }, {
      data: undefined, dataUpdateCount: 0, dataUpdatedAt: 0, error: answer.error as Error, errorUpdateCount: 1, errorUpdatedAt: Date.now(),
      fetchFailureCount: 1, fetchFailureReason: answer.error as Error, fetchMeta: null, isInvalidated: false, status: 'error', fetchStatus: 'idle',
    })
  }
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(QueryClientProvider, { client: qc }, createElement(PolicyViolations, { kind, namespace, name: 'cm-a' }))))
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const heads = (html: string) => [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])

describe('PolicyViolations', () => {
  it('a ConfigMap\'s rows in Pod\'s form: result, policy/rule, severity, message — no resource column', () => {
    const html = render('en', 'ConfigMap', 'shop', { data: { rows: [row('fail', 'need-team'), row('pass', 'ok'), row('warn', 'no-plain')] } })
    expect(text(html).startsWith('Policy violations')).toBe(true)
    expect(heads(html)).toEqual(['Result', 'Policy', 'Severity', 'Message'])
    expect(html.match(/data-testid="policy-violation-row"/g)?.length).toBe(2)
    expect(text(html)).toContain('fail need-team /r high need-team says fail')
    expect(text(html)).toContain('warn no-plain /r high no-plain says warn')
  })

  it('a workload\'s rows name the pod or the workload they are about', () => {
    const html = render('en', 'Deployment', 'shop', { data: { rows: [row('fail', 'p', 'Pod', 'web-1')] } })
    expect(heads(html)).toEqual(['Result', 'Policy', 'Severity', 'Resource', 'Message'])
    expect(text(html)).toContain('Pod/web-1')
  })

  it('a cluster-scoped resource (namespace "") reads its own answer: "None" without a violation', () => {
    const html = render('en', 'Namespace', '', { data: { rows: [row('pass', 'ns-quota', 'Namespace', 'cm-a')] } })
    expect(text(html)).toBe('Policy violations None')
  })

  it('"Loading..." until the answer comes', () => {
    expect(text(render('en', 'ConfigMap', 'shop', {}))).toBe('Policy violations Loading...')
  })

  it('says why the reports could not be read, in English and Korean', () => {
    expect(text(render('en', 'Namespace', '', { error: axiosError(403, REFUSED) }))).toBe(`Policy violations Could not load the policy reports: ${REFUSED}`)
    expect(text(render('ko', 'Namespace', '', { error: axiosError(403, REFUSED) }))).toContain(`정책 보고서를 불러오지 못했습니다: ${REFUSED}`)
    expect(text(render('en', 'Namespace', '', { error: new Error('') }))).toBe('Policy violations Could not load the policy reports')
  })

  it('draws nothing on a cluster without the PolicyReport CRD', () => {
    expect(render('en', 'ConfigMap', 'shop', { data: { rows: [row('fail', 'p')] } }, false)).toBe('')
  })
})
