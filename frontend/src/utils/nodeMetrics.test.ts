import { describe, expect, it } from 'vitest'
import { nodeInstanceSelector, nodeQueries } from './nodeMetrics'

// The regular expression inside the PromQL string, as Prometheus reads it.
function regexOf(sel: string): RegExp {
  const quoted = sel.slice('instance=~'.length)
  return new RegExp(`^${JSON.parse(quoted)}$`)
}

describe('nodeInstanceSelector', () => {
  const sel = nodeInstanceSelector('ip-10-0-1-1.ap-northeast-2.compute.internal', ['10.0.1.1', 'fd00::1'])

  it('matches the node name or one of its addresses, with or without a port', () => {
    const re = regexOf(sel)
    for (const instance of [
      'ip-10-0-1-1.ap-northeast-2.compute.internal',
      'ip-10-0-1-1.ap-northeast-2.compute.internal:9100',
      '10.0.1.1:9100',
      '10.0.1.1',
      '[fd00::1]:9100',
    ]) {
      expect(re.test(instance), instance).toBe(true)
    }
  })

  it('matches the whole value only: no other node, no address that merely looks alike', () => {
    const re = regexOf(sel)
    for (const instance of ['10.0.1.10:9100', '10.0.111:9100', 'ip-10-0-1-10.ap-northeast-2.compute.internal:9100', 'x10.0.1.1:9100', '10.0.1.1:9100x']) {
      expect(re.test(instance), instance).toBe(false)
    }
    expect(regexOf(nodeInstanceSelector('node-1')).test('node-10:9100')).toBe(false)
  })

  it('is a valid PromQL string: backslashes doubled, no duplicate hosts', () => {
    expect(nodeInstanceSelector('a.b', ['a.b', '1.2.3.4'])).toBe('instance=~"(?:a\\\\.b|1\\\\.2\\\\.3\\\\.4)(?::[0-9]+)?"')
  })
})

describe('nodeQueries', () => {
  it('puts the selector in every query and adds up disk and network devices', () => {
    const q = nodeQueries('instance=~"x"')
    for (const promql of Object.values(q)) expect(promql).toContain('instance=~"x"')
    expect(q.network_rx).toBe('sum by(instance)(rate(node_network_receive_bytes_total{device!="lo",instance=~"x"}[5m]))')
    expect(q.disk_read.startsWith('sum by(instance)(')).toBe(true)
  })
})
