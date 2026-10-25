// Resource Graph traffic lines: which sources the cluster has, where each line's ends go on the graph, how a
// line looks, and the NetworkPolicy check a dropped line opens. Pure functions; ResourceGraph and
// useResourceGraphLayout draw with them.

import { Position } from '@xyflow/react'
import type { ClusterFeatures, ResourceGraphNode, TrafficEnd, TrafficLine } from '@/services/api'
import type { NetpolCheckInitial, OtherKind } from '@/components/resource-detail/NetworkPolicyCheckModal'
import { networkFlowsEnabledFor } from '@/utils/features'

// structure: the objects and how they relate (as before) · traffic: who talks to whom · both: the two together
export type GraphView = 'structure' | 'traffic' | 'both'
// relay: the recent flows of the cluster's Hubble Relay · 1h/24h: the Hubble metrics in its Prometheus
export type TrafficSource = 'relay' | '1h' | '24h'

export function trafficSources(features: ClusterFeatures | null | undefined, clusterId: string): TrafficSource[] {
  const out: TrafficSource[] = []
  if (networkFlowsEnabledFor(features, clusterId)) out.push('relay')
  if (features?.prometheus?.enabled === true) out.push('1h', '24h')
  return out
}

export function trafficParams(source: TrafficSource): { source: 'relay' | 'metrics'; range?: string } {
  return source === 'relay' ? { source: 'relay' } : { source: 'metrics', range: source }
}

export type LineState = 'allowed' | 'dropped' | 'mixed'

export function lineState(l: TrafficLine): LineState {
  if (l.dropped > 0) return l.allowed > 0 ? 'mixed' : 'dropped'
  return 'allowed'
}

export const lineColor: Record<LineState, string> = { allowed: '#10b981', dropped: '#ef4444', mixed: '#f59e0b' }

// The kind of a stand-in node: an end the graph does not show (another namespace, outside the cluster's pods,
// or a kind the filters hide).
export const PEER_KIND = 'TrafficPeer'

export interface TrafficPeerNode extends ResourceGraphNode {
  end: TrafficEnd
}

export function isPeer(n: ResourceGraphNode): n is TrafficPeerNode {
  return n.kind === PEER_KIND
}

// Kinds a line end can be, in the order a "namespace/name" end without a kind is looked up.
const END_KINDS = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']

// anchorOf is where an end goes: a node the graph shows, else a stand-in.
export function anchorOf(e: TrafficEnd, shown: Map<string, ResourceGraphNode>): { id: string; peer?: TrafficPeerNode } {
  if (e.namespace && e.name) {
    for (const kind of e.kind ? [e.kind] : END_KINDS) {
      const id = `${kind}/${e.namespace}/${e.name}`
      if (shown.has(id)) return { id }
    }
    const id = `traffic:${e.namespace}/${e.kind ?? ''}/${e.name}`
    return { id, peer: { id, kind: PEER_KIND, name: e.name, namespace: e.namespace, status: '', end: e } }
  }
  if (e.namespace) {
    const id = `traffic:ns:${e.namespace}`
    return { id, peer: { id, kind: PEER_KIND, name: e.namespace, namespace: e.namespace, status: '', end: e } }
  }
  const outside = e.outside || 'unknown'
  const id = `traffic:out:${outside}`
  return { id, peer: { id, kind: PEER_KIND, name: outside, namespace: '', status: '', end: e } }
}

export interface TrafficEdge {
  id: string
  source: string
  target: string
  line: TrafficLine
  state: LineState
  width: number
}

// buildTraffic places the lines: their ends' nodes or stand-ins, a width from 1.5 to 4 by how busy the line is
// next to the busiest. A line from a node to itself (pods of one workload talking) is counted, not drawn.
export function buildTraffic(lines: TrafficLine[], shown: Map<string, ResourceGraphNode>): { peers: TrafficPeerNode[]; edges: TrafficEdge[]; selfLoops: number } {
  const peers = new Map<string, TrafficPeerNode>()
  const edges: TrafficEdge[] = []
  let selfLoops = 0
  const busiest = Math.max(1, ...lines.map((l) => l.allowed + l.dropped))
  lines.forEach((line, i) => {
    const from = anchorOf(line.from, shown)
    const to = anchorOf(line.to, shown)
    if (from.id === to.id) {
      selfLoops++
      return
    }
    for (const a of [from, to]) if (a.peer && !peers.has(a.id)) peers.set(a.id, a.peer)
    const width = 1.5 + (2.5 * Math.log1p(line.allowed + line.dropped)) / Math.log1p(busiest)
    edges.push({ id: `traffic-${i}`, source: from.id, target: to.id, line, state: lineState(line), width: Math.round(width * 10) / 10 })
  })
  return { peers: [...peers.values()], edges, selfLoops }
}

// endText names an end in one line: namespace/name for a pod or workload, the namespace alone, or what is outside.
export function endText(e: TrafficEnd): string {
  if (e.namespace && e.name) return `${e.namespace}/${e.name}`
  return e.namespace || e.outside || 'unknown'
}

const OPENABLE = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'])

// openableEnd: an end with a drawer — a pod or workload Kubeast can open.
export function openableEnd(e: TrafficEnd): e is TrafficEnd & { kind: string; name: string; namespace: string } {
  return !!(e.kind && e.name && e.namespace && OPENABLE.has(e.kind))
}

const CHECK_KINDS: Record<string, OtherKind> = { Pod: 'pod', Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset' }

const checkable = (e: TrafficEnd) => !!(e.namespace && e.name && e.kind && CHECK_KINDS[e.kind])

export interface LineCheck {
  self: string
  selfName: string
  namespace: string
  initial: NetpolCheckInitial
}

// checkFor fills the NetworkPolicy check for a dropped line from the side the check can name (a pod,
// Deployment, StatefulSet or DaemonSet): the other end by kind, or by address when it is outside the pods and a
// connection gives one. The port when the line has only one; without it the check covers every declared port.
export function checkFor(line: TrafficLine): LineCheck | null {
  if (line.dropped === 0) return null
  const one = line.ports?.length === 1 ? line.ports[0] : undefined
  const port = one?.port ? String(one.port) : undefined
  const protocol = one?.protocol && ['TCP', 'UDP', 'SCTP'].includes(one.protocol) ? one.protocol : undefined
  const conn = line.connections?.[0]
  const sides: [TrafficEnd, TrafficEnd, boolean, string | undefined][] = [
    [line.from, line.to, true, conn?.destination.ip],
    [line.to, line.from, false, conn?.source.ip],
  ]
  for (const [self, other, outgoing, otherIP] of sides) {
    if (!checkable(self)) continue
    const base = { outgoing, port, protocol }
    let initial: NetpolCheckInitial | null = null
    if (checkable(other)) initial = { ...base, kind: CHECK_KINDS[other.kind!], namespace: other.namespace, name: other.name }
    else if (other.outside && otherIP) initial = { ...base, kind: 'ip', ip: otherIP }
    if (initial) return { self: `${CHECK_KINDS[self.kind!]}/${self.namespace}/${self.name}`, selfName: self.name!, namespace: self.namespace!, initial }
  }
  return null
}

// pointOnBezier is the point at t (0 to 1) of the curve React Flow's getBezierPath draws (curvature 0.25, the
// same control points as @xyflow/system getControlWithCurvature).
export function pointOnBezier(t: number, e: { sourceX: number; sourceY: number; sourcePosition: Position; targetX: number; targetY: number; targetPosition: Position }): [number, number] {
  const offset = (distance: number) => (distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance))
  const control = (pos: Position, x1: number, y1: number, x2: number, y2: number): [number, number] => {
    switch (pos) {
      case Position.Left: return [x1 - offset(x1 - x2), y1]
      case Position.Right: return [x1 + offset(x2 - x1), y1]
      case Position.Top: return [x1, y1 - offset(y1 - y2)]
      default: return [x1, y1 + offset(y2 - y1)]
    }
  }
  const [c1x, c1y] = control(e.sourcePosition, e.sourceX, e.sourceY, e.targetX, e.targetY)
  const [c2x, c2y] = control(e.targetPosition, e.targetX, e.targetY, e.sourceX, e.sourceY)
  const u = 1 - t
  const at = (a: number, b: number, c: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
  return [at(e.sourceX, c1x, c2x, e.targetX), at(e.sourceY, c1y, c2y, e.targetY)]
}

// roundedPath is an SVG path through the points with each corner rounded by up to r (less on a short leg).
export function roundedPath(points: { x: number; y: number }[], r: number): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const k = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    const toward = (p: { x: number; y: number }) => {
      const len = Math.hypot(p.x - b.x, p.y - b.y) || 1
      return { x: b.x + ((p.x - b.x) / len) * k, y: b.y + ((p.y - b.y) / len) * k }
    }
    const [p1, p2] = [toward(a), toward(c)]
    d += ` L ${p1.x} ${p1.y} Q ${b.x} ${b.y} ${p2.x} ${p2.y}`
  }
  const last = points[points.length - 1]
  return `${d} L ${last.x} ${last.y}`
}
