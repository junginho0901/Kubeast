import { describe, expect, it } from 'vitest'
import { getBezierPath, Position } from '@xyflow/react'
import type { ClusterFeatures, NetflowGroup, ResourceGraphNode, TrafficLine } from '@/services/api'
import { anchorOf, boxHeight, buildTraffic, byPort, checkFor, endText, lineState, MAX_ROWS, pointOnBezier, portText, rowCenter, roundedPath, trafficParams, trafficSources, PEER_KIND } from './traffic'

const node = (kind: string, namespace: string, name: string): ResourceGraphNode => ({ id: `${kind}/${namespace}/${name}`, kind, name, namespace, status: 'Running' })
const shown = new Map([node('Deployment', 'shop', 'web'), node('Deployment', 'shop', 'client'), node('Pod', 'shop', 'debug'), node('StatefulSet', 'shop', 'db')].map((n) => [n.id, n]))
const line = (from: TrafficLine['from'], to: TrafficLine['to'], allowed: number, dropped = 0, extra: Partial<TrafficLine> = {}): TrafficLine => ({ from, to, allowed, dropped, ...extra })
const web = { namespace: 'shop', kind: 'Deployment', name: 'web' }
const client = { namespace: 'shop', kind: 'Deployment', name: 'client' }

describe('trafficSources', () => {
  const features = (relay: string[], prometheus: boolean) => ({ prometheus: { enabled: prometheus }, networkFlows: { enabled: relay.length > 0, clusters: relay } }) as unknown as ClusterFeatures
  it('offers the Relay only for a cluster it reads, and the metrics with Prometheus', () => {
    expect(trafficSources(features(['c1'], true), 'c1')).toEqual(['relay', '1h', '24h'])
    expect(trafficSources(features(['c1'], false), 'c2')).toEqual([])
    expect(trafficSources(features([], true), 'c1')).toEqual(['1h', '24h'])
    expect(trafficSources(undefined, 'c1')).toEqual([])
  })
  it('asks the server for the source', () => {
    expect(trafficParams('relay')).toEqual({ source: 'relay' })
    expect(trafficParams('24h')).toEqual({ source: 'metrics', range: '24h' })
  })
})

describe('anchorOf', () => {
  it('puts an end on the node the graph shows', () => {
    expect(anchorOf(web, shown)).toEqual({ id: 'Deployment/shop/web' })
    // a metric's "namespace/name" without a kind: the pod, else a workload of that name
    expect(anchorOf({ namespace: 'shop', name: 'debug' }, shown)).toEqual({ id: 'Pod/shop/debug' })
    expect(anchorOf({ namespace: 'shop', name: 'db' }, shown)).toEqual({ id: 'StatefulSet/shop/db' })
  })
  it('makes a stand-in for what the graph does not show', () => {
    const other = anchorOf({ namespace: 'kube-system', kind: 'Deployment', name: 'coredns' }, shown)
    expect(other.id).toBe('traffic:kube-system/Deployment/coredns')
    expect(other.peer).toMatchObject({ kind: PEER_KIND, name: 'coredns', namespace: 'kube-system', end: { kind: 'Deployment' } })
    // a kind the filters hide is a stand-in too, not a node of another kind with that name
    expect(anchorOf({ namespace: 'shop', kind: 'DaemonSet', name: 'web' }, shown).id).toBe('traffic:shop/DaemonSet/web')
    expect(anchorOf({ namespace: 'ops' }, shown).id).toBe('traffic:ns:ops')
    expect(anchorOf({ outside: 'github.com' }, shown)).toMatchObject({ id: 'traffic:out:github.com', peer: { name: 'github.com', namespace: '' } })
    expect(anchorOf({}, shown).id).toBe('traffic:out:unknown')
  })
})

describe('buildTraffic', () => {
  it('draws each line between its ends, one stand-in per end, busier lines wider', () => {
    const dns = { namespace: 'kube-system', kind: 'Deployment', name: 'coredns' }
    const { peers, edges, selfLoops } = buildTraffic([
      line(client, web, 1000),
      line({ namespace: 'shop', kind: 'Deployment', name: 'stranger' }, web, 0, 20),
      line(client, dns, 10),
      line(web, dns, 1),
      line(web, web, 50),
    ], shown)
    expect(selfLoops).toBe(1)
    expect(peers.map((p) => p.id).sort()).toEqual(['traffic:kube-system/Deployment/coredns', 'traffic:shop/Deployment/stranger'])
    expect(edges.map((e) => [e.source, e.target, e.state])).toEqual([
      ['Deployment/shop/client', 'Deployment/shop/web', 'allowed'],
      ['traffic:shop/Deployment/stranger', 'Deployment/shop/web', 'dropped'],
      ['Deployment/shop/client', 'traffic:kube-system/Deployment/coredns', 'allowed'],
      ['Deployment/shop/web', 'traffic:kube-system/Deployment/coredns', 'allowed'],
    ])
    expect(edges[0].width).toBe(4)
    expect(edges[3].width).toBeGreaterThanOrEqual(1.5)
    expect(edges[3].width).toBeLessThan(edges[2].width)
  })
  it('handles no lines', () => {
    expect(buildTraffic([], shown)).toEqual({ peers: [], edges: [], selfLoops: 0 })
  })
})

describe('lineState and endText', () => {
  it('reads a line', () => {
    expect(lineState(line(client, web, 3))).toBe('allowed')
    expect(lineState(line(client, web, 0, 2))).toBe('dropped')
    expect(lineState(line(client, web, 3, 2))).toBe('mixed')
    expect(endText(web)).toBe('shop/web')
    expect(endText({ namespace: 'ops' })).toBe('ops')
    expect(endText({ outside: 'world' })).toBe('world')
  })
})

describe('checkFor', () => {
  const conn = (srcIP?: string, dstIP?: string) => ({ source: { ip: srcIP }, destination: { ip: dstIP } }) as NetflowGroup
  it('opens the check from the source for a dropped line, with its only port', () => {
    expect(checkFor(line({ namespace: 'shop', kind: 'Deployment', name: 'stranger' }, web, 0, 5, { ports: [{ protocol: 'TCP', port: 80 }] }))).toEqual({
      self: 'deployment/shop/stranger', selfName: 'stranger', namespace: 'shop',
      initial: { outgoing: true, kind: 'deployment', namespace: 'shop', name: 'web', port: '80', protocol: 'TCP' },
    })
  })
  it('has no port when the line has several, and none for an allowed line', () => {
    const l = line(client, { namespace: 'shop', kind: 'Pod', name: 'debug' }, 1, 1, { ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 81 }] })
    expect(checkFor(l)?.initial).toEqual({ outgoing: true, kind: 'pod', namespace: 'shop', name: 'debug', port: undefined, protocol: undefined })
    expect(checkFor(line(client, web, 5))).toBeNull()
  })
  it('asks from the destination when the source cannot be named', () => {
    // the world reaching web: by the address of a connection
    expect(checkFor(line({ outside: 'world' }, web, 0, 2, { connections: [conn('203.0.113.5', '10.244.0.9')] }))).toMatchObject({
      self: 'deployment/shop/web', initial: { outgoing: false, kind: 'ip', ip: '203.0.113.5' },
    })
    // a CronJob (the check cannot name it) talking to web
    expect(checkFor(line({ namespace: 'shop', kind: 'CronJob', name: 'report' }, web, 0, 1))).toBeNull()
    // web to the world without an address
    expect(checkFor(line(web, { outside: 'world' }, 0, 1))).toBeNull()
    expect(checkFor(line(web, { outside: 'world' }, 0, 1, { connections: [conn(undefined, '1.1.1.1')] }))?.initial).toMatchObject({ outgoing: true, kind: 'ip', ip: '1.1.1.1' })
  })
})

describe('pointOnBezier', () => {
  it('follows the curve React Flow draws: its middle is getBezierPath\'s label point', () => {
    const positions = [Position.Left, Position.Right, Position.Top, Position.Bottom]
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1600 - 800
    for (let i = 0; i < 500; i++) {
      const e = { sourceX: rnd(), sourceY: rnd(), sourcePosition: positions[i % 4], targetX: rnd(), targetY: rnd(), targetPosition: positions[(i >> 2) % 4] }
      const [, labelX, labelY] = getBezierPath(e)
      const [x, y] = pointOnBezier(0.5, e)
      expect(Math.abs(x - labelX)).toBeLessThan(1e-6)
      expect(Math.abs(y - labelY)).toBeLessThan(1e-6)
    }
  })
  it('starts at the source and ends at the target', () => {
    const e = { sourceX: 0, sourceY: 0, sourcePosition: Position.Right, targetX: 300, targetY: 200, targetPosition: Position.Left }
    expect(pointOnBezier(0, e)).toEqual([0, 0])
    expect(pointOnBezier(1, e)).toEqual([300, 200])
    // two lines crossing between two rows: at 0.65 their counts are apart
    const down = pointOnBezier(0.65, e)
    const up = pointOnBezier(0.65, { ...e, sourceY: 200, targetY: 0 })
    expect(Math.abs(down[1] - up[1])).toBeGreaterThan(80)
  })
})

describe('roundedPath', () => {
  it('goes through the route with rounded corners, smaller on a short leg', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], 8)).toBe('M 0 0 L 100 0')
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], 8)).toBe('M 0 0 L 92 0 Q 100 0 100 8 L 100 50')
    // a 6 px leg rounds by 3 at most
    expect(roundedPath([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 50 }], 8)).toBe('M 0 0 L 3 0 Q 6 0 6 3 L 6 50')
    expect(roundedPath([], 8)).toBe('')
  })
})

describe('portText', () => {
  it('names the ports short', () => {
    expect(portText([{ protocol: 'TCP', port: 80 }])).toBe('80')
    expect(portText([{ protocol: 'UDP', port: 53 }])).toBe('UDP 53')
    expect(portText([{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }])).toBe('80, 443')
    expect(portText([{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }, { protocol: 'TCP', port: 8080 }])).toBe('80 +2')
    expect(portText(undefined)).toBe('')
  })
})

describe('byPort', () => {
  const edge = (id: string, source: string, target: string, ports: TrafficLine['ports'], allowed = 0, dropped = 0) =>
    ({ id, source, target, line: line({ name: source }, { name: target }, allowed, dropped, { ports }), state: 'allowed' as const, width: 1.5 })
  it('splits a line by port, ending at its row in the receiving box', () => {
    const { edges, rows } = byPort([
      edge('a', 'client', 'web', [{ protocol: 'TCP', port: 80, allowed: 6 }, { protocol: 'TCP', port: 8080, allowed: 1 }], 7),
      edge('b', 'stranger', 'web', [{ protocol: 'TCP', port: 80, dropped: 3 }], 0, 3),
      edge('c', 'client', 'dns', [{ protocol: 'UDP', port: 53, allowed: 4 }], 4),
      edge('d', 'x', 'web', undefined, 5), // the metrics: no ports, one edge
    ])
    expect(rows.get('web')).toEqual([
      { key: 'TCP/80', text: 'TCP 80', allowed: 6, dropped: 3 },
      { key: 'TCP/8080', text: 'TCP 8080', allowed: 1, dropped: 0 },
    ])
    expect(rows.get('dns')).toEqual([{ key: 'UDP/53', text: 'UDP 53', allowed: 4, dropped: 0 }])
    expect(edges.map((e) => [e.id, e.lineId, e.row, e.rowText, e.allowed, e.dropped, e.state])).toEqual([
      ['a:TCP/80', 'a', 'TCP/80', 'TCP 80', 6, 0, 'allowed'],
      ['a:TCP/8080', 'a', 'TCP/8080', 'TCP 8080', 1, 0, 'allowed'],
      ['b:TCP/80', 'b', 'TCP/80', 'TCP 80', 0, 3, 'dropped'],
      ['c:UDP/53', 'c', 'UDP/53', 'UDP 53', 4, 0, 'allowed'],
      ['d', 'd', undefined, undefined, 5, 0, 'allowed'],
    ])
    expect(edges[0].width).toBe(4) // the busiest share
  })
  it('keeps the busiest rows and puts the rest on a last "+n" row', () => {
    const ports = Array.from({ length: MAX_ROWS + 2 }, (_, i) => ({ protocol: 'TCP', port: 9000 + i, allowed: i === 0 ? 1 : 10 + i }))
    const { edges, rows } = byPort([edge('a', 'client', 'web', ports, 100)])
    const list = rows.get('web')!
    expect(list).toHaveLength(MAX_ROWS)
    expect(list[list.length - 1]).toMatchObject({ key: 'more', text: '+3' })
    // 9000 (quietest) is on the "+3" row, with the next two quietest
    expect(list.map((r) => r.key)).not.toContain('TCP/9000')
    const more = edges.find((e) => e.row === 'more')!
    expect(more.allowed).toBe(1 + 11 + 12)
  })
  it('places the rows below the box head', () => {
    expect(boxHeight(0)).toBe(60)
    expect(boxHeight(2)).toBe(60 + 36 + 6)
    expect(rowCenter(0)).toBe(72)
    expect(rowCenter(1)).toBe(90)
  })
})
