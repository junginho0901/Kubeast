import { describe, expect, it } from 'vitest'
import { clusterNodeQueries, nodeInstanceSelector, nodeQueries } from './nodeMetrics'

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
  const q = nodeQueries('node-1', ['10.0.1.1'])

  it('asks node-exporter by instance or hostmetrics by k8s_node_name, each reduced to one series', () => {
    for (const promql of Object.values(q)) {
      const [left, right] = promql.split(') or (')
      expect(left).toContain(nodeInstanceSelector('node-1', ['10.0.1.1']))
      expect(right).toContain('k8s_node_name="node-1"')
      expect(left).not.toMatch(/\bsystem_/)
      expect(right).not.toMatch(/\bnode_/)
      expect(promql).not.toMatch(/ by ?\(/)
    }
    expect(q.network_rx).toBe(
      '(sum(rate(node_network_receive_bytes_total{device!="lo",instance=~"(?:node-1|10\\\\.0\\\\.1\\\\.1)(?::[0-9]+)?"}[5m]))) or ' +
        '(sum(max without (otel_scope_name, otel_scope_version) (rate(system_network_io_bytes_total{direction="receive",device!="lo",k8s_node_name="node-1"}[5m]))))',
    )
  })

  it('takes CPU as idle per logical CPU, memory as used over system.memory.limit, the root filesystem as free over its states', () => {
    const one = (s: string) => `max without (otel_scope_name, otel_scope_version) (${s})`
    expect(q.cpu).toContain(`(100 * (1 - sum(${one('rate(system_cpu_time_seconds_total{state="idle",k8s_node_name="node-1"}[5m])')}) / sum(${one('system_cpu_logical_count{k8s_node_name="node-1"}')})))`)
    expect(q.memory).toContain(`100 * sum(${one('system_memory_usage_bytes{state="used",k8s_node_name="node-1"}')}) / sum(${one('system_memory_limit_bytes{k8s_node_name="node-1"}')})`)
    expect(q.filesystem).toContain(`sum(${one('system_filesystem_usage_bytes{state="free",mountpoint="/",k8s_node_name="node-1"}')}) / sum(${one('system_filesystem_usage_bytes{mountpoint="/",k8s_node_name="node-1"}')})`)
  })

  it('counts a hostmetrics series once when two collector versions both wrote it (the minutes after an upgrade)', () => {
    for (const promql of [...Object.values(q), ...Object.values(clusterNodeQueries())]) {
      const hostmetricsSide = promql.split(') or (')[1]
      for (const sum of hostmetricsSide.match(/sum\((?!max without \(otel_scope_name, otel_scope_version\) \()/g) ?? []) {
        expect.fail(`a hostmetrics sum without the version de-duplication: ${sum} in ${hostmetricsSide}`)
      }
    }
  })

  it('leaves out the disk devices node-exporter leaves out', () => {
    const quoted = /device!~("(?:[^"\\]|\\.)*")/.exec(q.disk_read)![1]
    const re = new RegExp(`^(?:${JSON.parse(quoted)})$`)
    for (const dev of ['sda1', 'vda2', 'xvda1', 'nvme0n1p1', 'loop0', 'ram0', 'zram0']) expect(re.test(dev), dev).toBe(true)
    for (const dev of ['sda', 'vda', 'xvda', 'nvme0n1', 'nvme10n1', 'dm-0']) expect(re.test(dev), dev).toBe(false)
  })
})

describe('clusterNodeQueries', () => {
  it('adds up every node, node-exporter first, with no empty selector', () => {
    const c = clusterNodeQueries()
    expect(c.cpu.startsWith('(100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)) or (')).toBe(true)
    expect(c.memory).toContain('sum(max without (otel_scope_name, otel_scope_version) (system_memory_limit_bytes))')
    for (const promql of Object.values(c)) {
      expect(promql).not.toContain('{}')
      expect(promql).not.toContain(',}')
    }
  })
})
