import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import viewSrc from './NetworkFlows.tsx?raw'
import type { NetflowGroup } from '@/services/api/types'
import { checkInitial, endLabel, isSelf, policyRefs } from './netflowText'

const web = { namespace: 'shop', pod: 'web-1', workload: { kind: 'Deployment', name: 'web' }, port: 80 }
const client = { namespace: 'shop', pod: 'client-1', workload: { kind: 'Deployment', name: 'client' } }
const group = (g: Partial<NetflowGroup>): NetflowGroup => ({
  source: client, destination: web, protocol: 'TCP', observed: ['ingress'], verdict: 'DROPPED', count: 3, replies: 0, first: '', last: '', ...g,
})

describe('netflowText', () => {
  it('finds the drawer side of a connection', () => {
    expect(isSelf(web, { kind: 'Pod', namespace: 'shop', name: 'web-1' })).toBe(true)
    expect(isSelf(web, { kind: 'Deployment', namespace: 'shop', name: 'web' })).toBe(true)
    expect(isSelf(web, { kind: 'Deployment', namespace: 'other', name: 'web' })).toBe(false)
    expect(isSelf(client, { kind: 'Pod', namespace: 'shop', name: 'web-1' })).toBe(false)
  })

  it('takes Calico’s pod set as the pod whose generated name it covers', () => {
    const set = { namespace: 'shop', pod: 'web-787b7df48d-*', workload: { kind: 'Deployment', name: 'web' } }
    expect(isSelf(set, { kind: 'Pod', namespace: 'shop', name: 'web-787b7df48d-4fdhd' })).toBe(true)
    expect(isSelf(set, { kind: 'Pod', namespace: 'shop', name: 'web-787b7df48d-4fdhd-x' })).toBe(false)
    expect(isSelf({ namespace: 'shop', pod: 'kindnet-*' }, { kind: 'Pod', namespace: 'shop', name: 'kindnet-extra-ab12c' })).toBe(false)
    expect(isSelf({ namespace: 'shop', pod: 'kindnet-*' }, { kind: 'Pod', namespace: 'shop', name: 'kindnet-ab12c' })).toBe(true)
    expect(checkInitial({ source: client, destination: set, verdict: 'FORWARDED', count: 1 } as never, { kind: 'Pod', namespace: 'shop', name: 'web-787b7df48d-4fdhd' }))
      .toMatchObject({ outgoing: false, kind: 'deployment', name: 'client' })
  })

  it('names an end the shortest clear way', () => {
    expect(endLabel(client, 'shop')).toBe('Deployment/client')
    expect(endLabel({ ...client, namespace: 'ops' }, 'shop')).toBe('ops/Deployment/client')
    expect(endLabel({ namespace: 'shop', pod: 'job-x' }, 'shop')).toBe('job-x')
    expect(endLabel({ namespace: 'secret-team', ip: '10.0.0.9' }, 'shop')).toBe('secret-team (10.0.0.9)')
    expect(endLabel({ ip: '140.82.112.3', names: ['github.com'] }, 'shop')).toBe('github.com (140.82.112.3)')
    expect(endLabel({}, 'shop')).toBe('-')
  })

  it('fills the NetworkPolicy check for a dropped connection, from the drawer side', () => {
    // web's drawer: client came in on 80
    expect(checkInitial(group({}), { kind: 'Deployment', namespace: 'shop', name: 'web' }))
      .toEqual({ outgoing: false, kind: 'deployment', namespace: 'shop', name: 'client', port: '80', protocol: 'TCP' })
    // client's drawer: it went out to web on 80
    expect(checkInitial(group({}), { kind: 'Pod', namespace: 'shop', name: 'client-1' }))
      .toEqual({ outgoing: true, kind: 'deployment', namespace: 'shop', name: 'web', port: '80', protocol: 'TCP' })
    // a Job's pod is checked as the pod, an address as the address
    expect(checkInitial(group({ source: { namespace: 'shop', pod: 'job-x', workload: { kind: 'Job', name: 'job' } } }), { kind: 'Pod', namespace: 'shop', name: 'web-1' }))
      .toMatchObject({ kind: 'pod', name: 'job-x' })
    expect(checkInitial(group({ source: { ip: '203.0.113.5' } }), { kind: 'Pod', namespace: 'shop', name: 'web-1' }))
      .toMatchObject({ kind: 'ip', ip: '203.0.113.5' })
    // neither end is the drawer's object
    expect(checkInitial(group({}), { kind: 'Pod', namespace: 'shop', name: 'other' })).toBeNull()
    // ICMP is not something NetworkPolicy ports name
    expect(checkInitial(group({ protocol: 'ICMPv4' }), { kind: 'Deployment', namespace: 'shop', name: 'web' })?.protocol).toBeUndefined()
  })

  it('lists the policies the plugin reported', () => {
    expect(policyRefs(group({ policies: { ingress_allowed_by: [{ namespace: 'shop', name: 'web-only-client' }], egress_denied_by: [{ name: 'cluster-deny' }] } })))
      .toEqual({ allowed: ['shop/web-only-client'], denied: ['cluster-deny'] })
  })

  it('every key the section uses is in both catalogs with the same placeholders', () => {
    const lookup = (c: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], c) as string | undefined
    const keys = new Set([...viewSrc.matchAll(/'(netflows\.[\w.]+)'/g)].map((m) => m[1]))
    expect(keys.size).toBeGreaterThan(15)
    const holes = (s?: string) => [...(s ?? '').matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join(',')
    for (const key of keys) {
      expect(lookup(en, key), `en ${key}`).toBeTypeOf('string')
      expect(lookup(ko, key), `ko ${key}`).toBeTypeOf('string')
      expect(holes(lookup(ko, key)), key).toBe(holes(lookup(en, key)))
    }
  })
})
