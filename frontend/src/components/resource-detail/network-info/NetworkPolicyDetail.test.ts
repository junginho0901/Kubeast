import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import { PageContextCtx, type PageContextValue } from '@/components/PageContext'
import { networkPolicyToRawJson } from '@/pages/network/networkpolicies/networkPolicyHelpers'
import { applyNetworkPolicyToDrawer } from '@/pages/network/networkpolicies/networkPolicyWatchNormalize'
import NetworkPolicyDetail from './NetworkPolicyDetail'

const selector = (labels: Record<string, string>) => ({ match_labels: labels, match_expressions: [] })
const rowWith = (app: string, label: string, finalizers: string[]) => ({
  name: 'web',
  namespace: 'demo',
  pod_selector: selector({ app: 'web' }),
  policy_types: ['Ingress'],
  ingress_rules: 1,
  egress_rules: 0,
  ingress: [{ from: [{ pod_selector: selector({ app }) }], ports: [{ protocol: 'TCP', port: '80' }] }],
  egress: [],
  labels: { team: label },
  annotations: {},
  finalizers,
  created_at: '2026-11-01T00:00:00Z',
})

// what the drawer draws for a row it was opened from, once the query the list page invalidates holds an answer
function drawn(opened: Record<string, unknown>, answer?: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (answer) client.setQueryData(['networkpolicy-describe', 'demo', 'web'], answer)
  return renderToStaticMarkup(createElement(
    PageContextCtx.Provider,
    { value: { registerLayer: () => {}, unregisterLayer: () => {} } as unknown as PageContextValue },
    createElement(
      QueryClientProvider,
      { client },
      createElement(NetworkPolicyDetail, { name: 'web', namespace: 'demo', rawJson: opened }),
    ),
  ))
}

describe('an open NetworkPolicy drawer', () => {
  const opened = networkPolicyToRawJson(rowWith('old-client', 'label-old', []) as any)

  beforeAll(async () => {
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { translation: en, detail: {} } },
      ns: ['translation', 'detail'],
      defaultNS: 'translation',
      interpolation: { escapeValue: false },
    })
  })

  it('shows the row it was opened from until an answer comes', () => {
    const html = drawn(opened)
    expect(html).toContain('pods app=old-client in this namespace')
    expect(html).toContain('label-old')
  })

  it('shows the rules, labels and finalizers the object has now, not those of the row it was opened from', () => {
    const html = drawn(opened, rowWith('new-client', 'label-new', ['example.test/keep']))
    expect(html).toContain('pods app=new-client in this namespace')
    expect(html).not.toContain('old-client')
    expect(html).toContain('label-new')
    expect(html).not.toContain('label-old')
    expect(html).toContain('example.test/keep')
  })

  it('shows no rule the object no longer has', () => {
    const html = drawn(opened, { ...rowWith('new-client', 'label-old', []), ingress: [], ingress_rules: 0, default_deny_ingress: true })
    expect(html).not.toContain('old-client')
    expect(html).not.toContain('netpol-rule-peers')
    expect(html).toContain('Default Deny Ingress')
  })

  it('takes a live update of this policy, and of no other', () => {
    const shown = rowWith('old-client', 'label-old', [])
    const updated = rowWith('new-client', 'label-new', [])
    expect(applyNetworkPolicyToDrawer(shown, { type: 'MODIFIED', object: updated }, 'web')).toEqual(updated)
    expect(applyNetworkPolicyToDrawer(shown, { type: 'MODIFIED', object: { ...updated, name: 'other' } }, 'web')).toBe(shown)
  })

  it('keeps what it shows when the policy is deleted', () => {
    const shown = rowWith('old-client', 'label-old', [])
    expect(applyNetworkPolicyToDrawer(shown, { type: 'DELETED', object: rowWith('new-client', 'label-new', []) }, 'web')).toBe(shown)
  })
})
