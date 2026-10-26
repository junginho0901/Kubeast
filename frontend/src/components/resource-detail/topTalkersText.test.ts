import { describe, expect, it } from 'vitest'
import type { NfmRow } from '@/services/api/types'
import { formatValue, isSelf, peerLabel, sides, zones } from './topTalkersText'

const web = { namespace: 'shop', pod: 'web-6d9f7c8b5-abcde', workload: { kind: 'Deployment', name: 'web' }, ip: '10.0.1.10', az: 'apne2-az1' }
const pay = { namespace: 'pay', pod: 'pay-7f8e6d5c4-xyzab', workload: { kind: 'Deployment', name: 'pay' }, ip: '10.0.3.40', az: 'apne2-az3' }

describe('top talkers text', () => {
  it('finds the object at either end', () => {
    const self = { kind: 'Deployment', namespace: 'shop', name: 'web' }
    const out: NfmRow = { local: web, remote: pay, port: 9000, value: 1200, category: 'INTER_AZ' }
    const back: NfmRow = { local: pay, remote: web, port: 80, value: 700, category: 'INTER_AZ' }
    expect(sides(out, self)).toEqual({ own: web, peer: pay })
    expect(sides(back, self)).toEqual({ own: web, peer: pay })
    expect(isSelf(web, { kind: 'Pod', namespace: 'shop', name: 'web-6d9f7c8b5-abcde' })).toBe(true)
    expect(isSelf(web, { kind: 'Pod', namespace: 'pay', name: 'web-6d9f7c8b5-abcde' })).toBe(false)
    expect(isSelf(web, { kind: 'StatefulSet', namespace: 'shop', name: 'web' })).toBe(false)
  })

  it('names a peer by workload, pod, Service or address', () => {
    expect(peerLabel(pay, 'shop')).toBe('pay/Deployment/pay')
    expect(peerLabel({ namespace: 'shop', pod: 'db-0' }, 'shop')).toBe('db-0')
    expect(peerLabel({ namespace: 'shop', service: 'api' }, 'shop')).toBe('Service/api')
    expect(peerLabel({ namespace: 'pay', ip: '10.0.3.40' }, 'shop')).toBe('pay (10.0.3.40)')
    expect(peerLabel({ ip: '52.95.1.1' }, 'shop')).toBe('52.95.1.1')
    expect(peerLabel({}, 'shop')).toBe('-')
  })

  it('shows one zone or the crossing', () => {
    expect(zones(web, pay)).toBe('apne2-az1 → apne2-az3')
    expect(zones(web, { ...pay, az: 'apne2-az1' })).toBe('apne2-az1')
    expect(zones(web, { ip: '52.95.1.1' })).toBe('apne2-az1')
    expect(zones({}, {})).toBe('-')
  })

  it('formats bytes and counts', () => {
    expect(formatValue(512, 'Bytes')).toBe('512 B')
    expect(formatValue(5 * 1024 * 1024 * 1024, 'Bytes')).toBe('5.0 GB')
    expect(formatValue(12345, 'Count')).toBe('12,345')
    expect(formatValue(7)).toBe('7')
  })
})
