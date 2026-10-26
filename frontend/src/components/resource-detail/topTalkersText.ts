import type { NfmEnd, NfmRow } from '@/services/api/types'

// The drawer's object: a pod, or a workload whose pods NFM names.
export type TalkerSelf = { kind: string; namespace: string; name: string }

export function isSelf(e: NfmEnd, self: TalkerSelf): boolean {
  if (e.namespace !== self.namespace) return false
  if (self.kind === 'Pod') return e.pod === self.name
  return e.workload?.kind === self.kind && e.workload?.name === self.name
}

// The two ends of a row from the object's side: its own pod and the peer. A row between two of its own pods
// (one workload talking to itself) keeps NFM's order.
export function sides(r: NfmRow, self: TalkerSelf): { own: NfmEnd; peer: NfmEnd } {
  return isSelf(r.local, self) ? { own: r.local, peer: r.remote } : { own: r.remote, peer: r.local }
}

// A peer by its workload, pod or Service name (with its namespace when it is not the object's), else its address.
export function peerLabel(e: NfmEnd, namespace: string): string {
  const name = e.workload ? `${e.workload.kind}/${e.workload.name}` : e.pod || (e.service ? `Service/${e.service}` : '')
  if (name) return e.namespace && e.namespace !== namespace ? `${e.namespace}/${name}` : name
  if (e.namespace) return e.ip ? `${e.namespace} (${e.ip})` : e.namespace
  return e.ip || '-'
}

// Zones of a row: one zone, or the object's and the peer's when they differ.
export function zones(own: NfmEnd, peer: NfmEnd): string {
  if (!own.az && !peer.az) return '-'
  if (!peer.az || own.az === peer.az) return own.az || '-'
  return `${own.az || '?'} → ${peer.az}`
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

// A value in NFM's unit: bytes as people read them, counts as they are.
export function formatValue(value: number, unit?: string): string {
  if (unit !== 'Bytes') return value.toLocaleString('en-US')
  let v = value
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${UNITS[i]}`
}
