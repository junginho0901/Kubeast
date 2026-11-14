// What the Endpoints, ReplicaSet, StorageClass and VolumeAttachment drawers show, read the way the lists and
// kubectl read it, kept out of the components so it can be tested.

import type { EndpointInfo, ReplicaSetInfo, VolumeAttachmentInfo } from '@/services/api'
import { replicaSetOwner } from '@/pages/workloads/replicasets/replicaSetHelpers'
import { statusLabel } from '@/pages/storage/volumeattachments/volumeAttachmentHelpers'

type Port = NonNullable<EndpointInfo['ports']>[number]
type Target = NonNullable<EndpointInfo['ready_targets']>[number]

// An Endpoints as the drawer shows it: the list's row (k8s-service internal/endpoints) with each subset's ready and
// not-ready addresses and ports, as kubectl describe endpoints lists them.
export interface EndpointsView {
  ready_count: number
  not_ready_count: number
  ready_addresses: string[]
  not_ready_addresses: string[]
  ready_targets: Target[]
  not_ready_targets: Target[]
  ports: Port[]
  subsets: Array<{ addresses: string[]; not_ready_addresses: string[]; ports: Port[] }>
  labels: Record<string, string>
  annotations: Record<string, string>
  uid?: string
  resource_version?: string
  generation?: number
  created_at?: string
  events: Array<Record<string, unknown>>
}

type Raw = Record<string, any>
const ips = (list: unknown): string[] => (Array.isArray(list) ? list.map((a: Raw) => String(a?.ip ?? '')).filter(Boolean) : [])
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

// The describe answer when it came; else the row a list passed (it has the counts); else null — the object a link
// reads has no counts, so nothing is shown from it rather than 0.
export function endpointsView(describe: unknown, rawJson: Record<string, unknown> | undefined): EndpointsView | null {
  const src = (describe && typeof describe === 'object' ? describe : rawJson && 'ready_count' in rawJson ? rawJson : null) as Raw | null
  if (!src) return null
  const meta = (src.metadata ?? {}) as Raw
  return {
    ready_count: Number(src.ready_count ?? 0),
    not_ready_count: Number(src.not_ready_count ?? 0),
    ready_addresses: arr<string>(src.ready_addresses),
    not_ready_addresses: arr<string>(src.not_ready_addresses),
    ready_targets: arr<Target>(src.ready_targets),
    not_ready_targets: arr<Target>(src.not_ready_targets),
    ports: arr<Port>(src.ports),
    // describe: not_ready_addresses; the list's row: notReadyAddresses
    subsets: arr<Raw>(src.subsets).map((s) => ({
      addresses: ips(s.addresses),
      not_ready_addresses: ips(s.not_ready_addresses ?? s.notReadyAddresses),
      ports: arr<Port>(s.ports),
    })),
    labels: (src.labels ?? meta.labels ?? {}) as Record<string, string>,
    annotations: (src.annotations ?? meta.annotations ?? {}) as Record<string, string>,
    uid: src.uid ?? meta.uid,
    resource_version: src.resource_version ?? meta.resourceVersion,
    // an Endpoints has no spec, so no generation (0): no row
    generation: Number(src.generation ?? meta.generation ?? 0) || undefined,
    created_at: src.created_at ?? meta.creationTimestamp,
    events: arr<Record<string, unknown>>(src.events),
  }
}

// The Owner row: the list's Owner column (the controller reference — a Deployment by its name, another kind as
// kind/name), none when the ReplicaSet has no owner.
export function replicaSetOwnerRow(describe: Pick<ReplicaSetInfo, 'owner_deployment' | 'owner_references'> | null | undefined): string | null {
  if (!describe || !(describe.owner_references ?? []).length) return null
  const owner = replicaSetOwner(describe)
  return owner === '-' ? null : owner
}

// A StorageClass's allowedTopologies as kubectl describe prints them, a term a line: "Term 0: key in [a, b], …"
export function allowedTopologyLines(topologies: unknown): string[] {
  return arr<Raw>(topologies).map((term, i) => {
    const exprs = arr<Raw>(term?.match_label_expressions ?? term?.matchLabelExpressions)
    const text = exprs.map((e) => {
      const values = arr<string>(e?.values)
      return `${String(e?.key ?? '')} in${values.length ? ` [${values.join(', ')}]` : ''}`
    }).join(', ')
    return `Term ${i}: ${text || '-'}`
  })
}

// The Ingress drawer's class rows, from the describe answer: it reads the IngressClass the Ingress names (DescribeIngress)
// and is read again when the Ingress changes. The list's row has the source as the drawer opened and no controller.
export function ingressClassRows(describe: Raw | null | undefined, row: Raw | null | undefined): { source: string; controller: string; isDefault: string } {
  const from = (key: string) => (describe && key in describe ? describe[key] : row?.[key])
  const source = from('class_source')
  const controller = from('class_controller')
  const isDefault = from('class_is_default')
  return {
    source: typeof source === 'string' && source ? source : '-',
    controller: typeof controller === 'string' && controller ? controller : '-',
    isDefault: isDefault == null ? '-' : isDefault ? 'Yes' : 'No',
  }
}

// A VolumeAttachment's Status as its list's column says it (an attach or detach error first), and kubectl's
// ATTACHED (status.attached) beside it
export function volumeAttachmentState(src: Pick<VolumeAttachmentInfo, 'attached' | 'attach_error' | 'detach_error'>): { status: string; attached: 'Yes' | 'No' | '-' } {
  return {
    status: statusLabel(src as VolumeAttachmentInfo),
    attached: src.attached === true ? 'Yes' : src.attached === false ? 'No' : '-',
  }
}
