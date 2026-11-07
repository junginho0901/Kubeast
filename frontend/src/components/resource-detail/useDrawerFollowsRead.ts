import { useEffect, useMemo } from 'react'
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { followsObjectForChat } from './drawerObjectLayer'

type RawObject = Record<string, unknown>

// Row fields a drawer reads before the object's own, which it works out from the object when they are not there: left in,
// the old number would sit beside the new rows.
const ROW_FIELDS_OF_THE_OBJECT: Record<string, string[]> = {
  EndpointSlice: ['labels', 'annotations', 'endpoints_total', 'endpoints_ready', 'endpoints_not_ready', 'service_name', 'managed_by', 'address_type'],
  IngressClass: ['is_default'],
}

// What a drawer's body reads: the row it opened with, its object as the drawer's own read has it now (ResourceDetailDrawer,
// objectReadInterval) over it. The row keeps what only the list works out; a Secret's read is an audited reveal and is
// not this read. That read already goes on while the Info tab is open, so following it costs no request of its own.
export function drawerBody(kind: string, row: RawObject | undefined, live: RawObject | undefined): RawObject | undefined {
  if (!row) return live
  if (!live || !followsObjectForChat(kind)) return row
  const kept = Object.fromEntries(Object.entries(row).filter(([field]) => !ROW_FIELDS_OF_THE_OBJECT[kind]?.includes(field)))
  return { ...kept, ...live }
}

// The answer of each drawer that reads one and has no watch of its object. A workload, an HPA, a binding and the others
// useDrawerFollowsObject serves read theirs on the watch's frames; a NetworkPolicy has a watch of its own and a Lease reads
// every five seconds. useDrawerFollowsRead.test.ts holds each key to the drawer that reads it.
export function answerKeyOf(kind: string, namespace: string | null | undefined, name: string): QueryKey | null {
  switch (kind) {
    case 'Pod': return ['pod-describe', namespace, name]
    case 'Service': return ['service-describe', namespace, name]
    case 'ServiceAccount': return ['serviceaccount-describe', namespace, name]
    case 'ConfigMap': return ['configmap-describe', namespace, name]
    case 'Role': return ['role-describe', namespace, name]
    case 'Gateway': return ['gateway-describe', namespace, name]
    case 'GatewayClass': return ['gatewayclass-describe', name]
    case 'HTTPRoute': return ['httproute-describe', namespace, name]
    case 'GRPCRoute': return ['grpcroute-describe', namespace, name]
    case 'ReferenceGrant': return ['referencegrant-describe', namespace, name]
    case 'BackendTLSPolicy': return ['backendtlspolicy-describe', namespace, name]
    case 'DeviceClass': return ['deviceclass-describe', name]
    case 'ResourceClaim': return ['resourceclaim-describe', namespace, name]
    case 'ResourceClaimTemplate': return ['resourceclaimtemplate-describe', namespace, name]
    case 'ResourceSlice': return ['resourceslice-describe', name]
    case 'VerticalPodAutoscaler': return ['vpa-describe', namespace, name]
    case 'Ingress': return ['ingress-describe', namespace, name]
    case 'IngressClass': return ['ingressclass-describe', name]
    case 'Endpoints': return ['endpoints-describe', namespace, name]
    case 'EndpointSlice': return ['endpointslice-describe', namespace, name]
    case 'PersistentVolume': return ['pv-describe', name]
    case 'PersistentVolumeClaim': return ['pvc-describe', namespace, name]
    case 'StorageClass': return ['storageclass-describe', name]
    case 'VolumeAttachment': return ['volumeattachment-describe', name]
    case 'ValidatingAdmissionPolicy':
    case 'MutatingAdmissionPolicy':
      return ['admissionpolicy-describe', kind, name]
    default:
      return null
  }
}

const versionOf = (object: unknown) => ((object as { metadata?: { resourceVersion?: unknown } } | undefined)?.metadata?.resourceVersion as string | undefined) || undefined

// readFollower reads a drawer's answer again when the object's read says it changed: the answer holds more than the object
// (events, what the server works out), and one read per change at most every ten seconds is what a quiet object never pays.
export function readFollower(client: QueryClient, answerKey: QueryKey | null) {
  let seen: string | undefined
  return {
    onRead(object: unknown) {
      const version = versionOf(object)
      if (!version) return
      const changed = seen !== undefined && seen !== version
      seen = version
      if (changed && answerKey) void client.invalidateQueries({ queryKey: answerKey })
    },
  }
}

export function useDrawerFollowsRead(kind: string, namespace: string | null | undefined, name: string, live: unknown) {
  const client = useQueryClient()
  const keyDep = JSON.stringify(answerKeyOf(kind, namespace, name))
  const follower = useMemo(() => readFollower(client, JSON.parse(keyDep) as QueryKey | null), [client, keyDep])
  const version = versionOf(live)
  useEffect(() => {
    follower.onRead(version ? { metadata: { resourceVersion: version } } : undefined)
  }, [follower, version])
}
