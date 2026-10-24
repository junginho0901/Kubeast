import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import viewSrc from './NetworkDrops.tsx?raw'
import type { NetdropResult } from '@/services/api/types'
import { checkInitial, peerLabel, rows } from './netdropText'

// What the Cilium kind cluster answers for Deployment web (deploy/kind/cilium-demo.yaml).
const res: NetdropResult = {
  available: true, source: 'hubble', style: 'labels', namespace: 'flows-demo', kind: 'Deployment', name: 'web', range: '1h0m0s',
  incoming: { total: 43, reasons: [{ reason: 'POLICY_DENIED', count: 43 }], peers: [
    { namespace: 'flows-demo', workload: 'stranger', kind: 'Deployment', reason: 'POLICY_DENIED', count: 40 },
    { namespace: 'ops', reason: 'POLICY_DENIED', count: 3 },
  ] },
  outgoing: { total: 5, reasons: [{ reason: 'UNSUPPORTED_L3_PROTOCOL', count: 5 }], peers: [{ reason: 'UNSUPPORTED_L3_PROTOCOL', count: 5 }] },
}

describe('netdropText', () => {
  it('lists both sides, the most drops first', () => {
    expect(rows(res).map((r) => [r.direction, r.count])).toEqual([['incoming', 40], ['outgoing', 5], ['incoming', 3]])
    // an unavailable answer carries null lists
    expect(rows({ ...res, incoming: { total: 0, reasons: null, peers: null }, outgoing: { total: 0, reasons: null, peers: null } })).toEqual([])
  })

  it('names the other end the shortest clear way', () => {
    expect(peerLabel({ namespace: 'flows-demo', workload: 'stranger', kind: 'Deployment', reason: '', count: 1 }, 'flows-demo')).toBe('Deployment/stranger')
    expect(peerLabel({ namespace: 'ops', workload: 'scanner', kind: 'DaemonSet', reason: '', count: 1 }, 'flows-demo')).toBe('ops/DaemonSet/scanner')
    expect(peerLabel({ namespace: 'db', pod: 'postgres-0', reason: '', count: 1 }, 'flows-demo')).toBe('db/postgres-0')
    expect(peerLabel({ namespace: 'ops', reason: '', count: 1 }, 'flows-demo')).toBe('ops')
    expect(peerLabel({ reason: '', count: 1 }, 'flows-demo')).toBe('')
  })

  it('opens the NetworkPolicy check for a policy drop, from the drawer side', () => {
    const [stranger, unknown, redacted] = rows(res)
    expect(checkInitial(stranger)).toEqual({ outgoing: false, kind: 'deployment', namespace: 'flows-demo', name: 'stranger' })
    expect(checkInitial({ ...stranger, direction: 'outgoing' })?.outgoing).toBe(true)
    // a pod-style peer is checked as the pod; a CronJob's as nothing the check knows
    expect(checkInitial({ direction: 'incoming', namespace: 'db', pod: 'postgres-0', reason: 'POLICY_DENIED', count: 1 })).toMatchObject({ kind: 'pod', name: 'postgres-0' })
    expect(checkInitial({ direction: 'incoming', namespace: 'db', workload: 'backup', kind: 'CronJob', reason: 'POLICY_DENIED', count: 1 })).toBeNull()
    // not a policy drop, an unnamed peer, a peer shown by namespace only
    expect(checkInitial({ ...stranger, reason: 'CT_MAP_INSERTION_FAILED' })).toBeNull()
    expect(checkInitial(unknown)).toBeNull()
    expect(checkInitial(redacted)).toBeNull()
  })

  it('every key the section uses is in both catalogs with the same placeholders', () => {
    const lookup = (c: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], c) as string | undefined
    const keys = new Set([...viewSrc.matchAll(/'(netdrops\.[\w.]+)'/g)].map((m) => m[1]))
    expect(keys.size).toBeGreaterThan(14)
    const holes = (s?: string) => [...(s ?? '').matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join(',')
    for (const key of keys) {
      expect(lookup(en, key), `en ${key}`).toBeTypeOf('string')
      expect(lookup(ko, key), `ko ${key}`).toBeTypeOf('string')
      expect(holes(lookup(ko, key)), key).toBe(holes(lookup(en, key)))
    }
  })
})
