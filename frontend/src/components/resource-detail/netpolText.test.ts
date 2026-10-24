import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import textSrc from './netpolText.ts?raw'
import viewSrc from './NetworkPolicies.tsx?raw'
import modalSrc from './NetworkPolicyCheckModal.tsx?raw'
import detailSrc from './network-info/NetworkPolicyDetail.tsx?raw'
import { peerOf, peerText, portOf, portsText, reasonText, resultLabel, selectorText, unevaluatedText, type Tr } from './netpolText'

type Catalog = Record<string, unknown>

function lookup(catalog: Catalog, key: string): string | undefined {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Catalog | undefined)?.[k], catalog)
  return typeof v === 'string' ? v : undefined
}

function trFor(catalog: Catalog): Tr {
  return (key, fallback, options) => (lookup(catalog, key) ?? fallback).replace(/{{(\w+)}}/g, (_, k) => String(options?.[k]))
}

const tr = trFor(en)

describe('netpolText', () => {
  it('describes each kind of peer', () => {
    expect(peerText({ pod_selector: 'role=client' }, tr)).toBe('pods role=client in this namespace')
    expect(peerText({ pod_selector: '' }, tr)).toBe('every pod in this namespace')
    expect(peerText({ namespace_selector: 'team=ops' }, tr)).toBe('every pod in namespaces team=ops')
    expect(peerText({ namespace_selector: '', pod_selector: 'app=probe' }, tr)).toBe('pods app=probe in every namespace')
    expect(peerText({ cidr: '10.0.0.0/8', except: ['10.1.0.0/16'] }, tr)).toBe('addresses 10.0.0.0/8 (except 10.1.0.0/16)')
  })

  it('describes ports, results, reasons and other policy kinds', () => {
    expect(portsText([], tr)).toBe('every port')
    expect(portsText([{ protocol: 'UDP' }, { protocol: 'TCP', port: '8000', end_port: 9000 }, { protocol: 'TCP', port: 'http' }], tr)).toBe('every UDP port, TCP 8000-9000, TCP http')
    expect(resultLabel('mixed', tr)).toBe('Differs by port or pod')
    expect(reasonText('pod_ip_block', trFor(ko))).toContain('ipBlock')
    expect(reasonText('something-new', tr)).toBe('something-new')
    expect(unevaluatedText([{ kind: 'CiliumNetworkPolicy', group: 'cilium.io', count: -1 }, { kind: 'AdminNetworkPolicy', group: 'policy.networking.k8s.io', count: 2 }], tr))
      .toBe('CiliumNetworkPolicy (cilium.io, count unknown), AdminNetworkPolicy (policy.networking.k8s.io, 2)')
  })

  it('writes a LabelSelector as apimachinery does, and reads peers and ports of the object', () => {
    expect(selectorText({})).toBe('')
    expect(selectorText(undefined)).toBe('')
    expect(selectorText({ matchLabels: { tier: 'front', app: 'web' }, matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'dev'] }, { key: 'canary', operator: 'DoesNotExist' }, { key: 'team', operator: 'Exists' }, { key: 'zone', operator: 'NotIn', values: ['b'] }] }))
      .toBe('app=web,!canary,env in (dev,prod),team,tier=front,zone notin (b)')
    // a peer that only has matchExpressions is not "every pod"
    expect(peerText(peerOf({ podSelector: { matchExpressions: [{ key: 'role', operator: 'NotIn', values: ['client'] }] } }), tr)).toBe('pods role notin (client) in this namespace')
    expect(peerText(peerOf({ namespaceSelector: {}, podSelector: { matchLabels: { app: 'probe' } } }), tr)).toBe('pods app=probe in every namespace')
    expect(peerText(peerOf({ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8'] } }), tr)).toBe('addresses 0.0.0.0/0 (except 10.0.0.0/8)')
    expect(portsText([portOf({}), portOf({ protocol: 'UDP', port: 53 }), portOf({ port: 8000, endPort: 9000 })], tr)).toBe('every TCP port, UDP 53, TCP 8000-9000')
  })

  it('every key it uses is in both catalogs with the same placeholders', () => {
    const keys = new Set([...`${textSrc}${viewSrc}${modalSrc}${detailSrc}`.matchAll(/'(netpolCheck\.[\w.]+)'/g)].map((m) => m[1]))
    expect(keys.size).toBeGreaterThan(50)
    const holes = (s: string | undefined) => [...(s ?? '').matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join(',')
    for (const key of keys) {
      expect(lookup(en, key), `en ${key}`).toBeTypeOf('string')
      expect(lookup(ko, key), `ko ${key}`).toBeTypeOf('string')
      expect(holes(lookup(ko, key)), key).toBe(holes(lookup(en, key)))
    }
  })
})
