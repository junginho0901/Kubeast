import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import { PageContextCtx, type PageContextValue } from '@/components/PageContext'
import VPAInfo from './VPAInfo'
import { vpaPolicyExtraRows, vpaStartupBoostText, vpaValue } from './vpaDetail'

// The VPA drawer shows the fields of VPA 1.6 and 1.7 (vertical-pod-autoscaler-1.8.1's vpa-v1-crd-gen.yaml): the wide
// columns MinReplicas and OOMSeconds, the pod's startupBoost, and each container policy's OOM, memory aggregation and
// startup boost settings, as the server's row passes them on.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} } }, interpolation: { escapeValue: false },
  })
})

describe('vpa values', () => {
  it('a value as written, "-" when left out', () => {
    expect([null, undefined, ''].map(vpaValue)).toEqual(['-', '-', '-'])
    expect([0, 2, 300, '1.5', '100Mi'].map(vpaValue)).toEqual(['0', '2', '300', '1.5', '100Mi'])
  })

  it('startupBoost: each resource\'s policy, the API\'s field names in its order', () => {
    expect(vpaStartupBoostText({ cpu: { durationSeconds: 10, factor: 2, type: 'Factor' } })).toBe('cpu (type: Factor, factor: 2, durationSeconds: 10)')
    expect(vpaStartupBoostText({ cpu: { quantity: '500m', type: 'Quantity' } })).toBe('cpu (type: Quantity, quantity: 500m)')
    // a field a later API adds comes after the known ones; a second resource after the first by name
    expect(vpaStartupBoostText({ memory: { type: 'Factor', factor: 3, zeta: 'z' }, cpu: { type: 'Factor', factor: 2 } }))
      .toBe('cpu (type: Factor, factor: 2); memory (type: Factor, factor: 3, zeta: z)')
    expect([undefined, null, {}, []].map(vpaStartupBoostText)).toEqual(['-', '-', '-', '-'])
  })

  it('the container policies\' second table: every policy\'s row once any sets one of the fields, else none', () => {
    const app = { container_name: 'app', oom_bump_up_ratio: '1.5', oom_min_bump_up: '100Mi', memory_aggregation_interval_seconds: 3600, memory_aggregation_interval_count: 8, startup_boost: { cpu: { type: 'Factor', factor: 2 } } }
    expect(vpaPolicyExtraRows([app, { container_name: '*', mode: 'Off' }])).toEqual([
      ['app', '1.5', '100Mi', '3600', '8', 'cpu (type: Factor, factor: 2)'],
      ['*', '-', '-', '-', '-', '-'],
    ])
    expect(vpaPolicyExtraRows([{ container_name: 'app', oom_bump_up_ratio: 2 }])).toEqual([['app', '2', '-', '-', '-', '-']])
    expect(vpaPolicyExtraRows([{ container_name: 'app', mode: 'Auto' }])).toEqual([])
    expect(vpaPolicyExtraRows([])).toEqual([])
  })
})

const DESCRIBE = {
  name: 'web', namespace: 'shop', uid: 'u-1', created_at: '2026-11-04T01:02:03Z', target_ref_kind: 'Deployment', target_ref_name: 'web',
  update_mode: 'InPlace', min_replicas: 2, evict_after_oom_seconds: 300, startup_boost: { cpu: { type: 'Factor', factor: 2, durationSeconds: 10 } },
  container_policies: [
    { container_name: 'app', mode: 'Auto', oom_bump_up_ratio: '1.5', oom_min_bump_up: '100Mi', memory_aggregation_interval_seconds: 3600, memory_aggregation_interval_count: 8 },
    { container_name: 'sidecar', mode: 'Off' },
  ],
  conditions: [], recommendations: [], events: [], labels: {}, annotations: {},
}
// the floating chat's registry the drawer reports to, which these renders do not read
const PAGE = { registerLayer: () => {}, unregisterLayer: () => {}, getSnapshot: () => ({}), consumeContextChanged: () => false } as unknown as PageContextValue
function drawer(describe: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['vpa-describe', 'shop', 'web'], describe)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
    createElement(PageContextCtx.Provider, { value: PAGE }, createElement(VPAInfo, { name: 'web', namespace: 'shop' })))))
}
// a section's text, from its title to the next section
const section = (html: string, title: string) => {
  const at = html.indexOf(`>${title}</p>`)
  if (at < 0) return `no ${title} section`
  const next = html.indexOf('<div class="rounded-lg border', at)
  return html.slice(at + 1, next < 0 ? undefined : next).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

describe('VPAInfo', () => {
  it('Update Policy: the mode, MinReplicas, OOMSeconds and the startup boost', () => {
    expect(section(drawer(DESCRIBE), 'Update Policy'))
      .toBe('Update Policy Update Mode InPlace Min Replicas 2 Evict After OOM Seconds 300 Startup Boost cpu (type: Factor, factor: 2, durationSeconds: 10)')
  })

  it('Container Policies: the policies\' table, then their OOM, memory aggregation and startup boost', () => {
    const part = section(drawer(DESCRIBE), 'Container Policies')
    expect(part).toContain('Container OOM Bump Up Ratio OOM Min Bump Up Memory Aggregation Interval Seconds Memory Aggregation Interval Count Startup Boost app 1.5 100Mi 3600 8 - sidecar - - - - -')
  })

  it('a VPA without them (or an older CRD): "-" in Update Policy and no second table', () => {
    const old = { ...DESCRIBE, update_mode: 'Auto', min_replicas: null, evict_after_oom_seconds: null, startup_boost: null, container_policies: [{ container_name: 'app', mode: 'Auto' }] }
    const html = drawer(old)
    expect(section(html, 'Update Policy')).toBe('Update Policy Update Mode Auto Min Replicas - Evict After OOM Seconds - Startup Boost -')
    expect(section(html, 'Container Policies')).not.toContain('OOM Bump Up Ratio')
  })
})
