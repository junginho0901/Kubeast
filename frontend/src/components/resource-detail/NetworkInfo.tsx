import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import ServiceDetail from './network-info/ServiceDetail'
import IngressDetail from './network-info/IngressDetail'
import IngressClassDetail from './network-info/IngressClassDetail'
import NetworkPolicyDetail from './network-info/NetworkPolicyDetail'
import EndpointSliceDetail from './network-info/EndpointSliceDetail'
import EndpointDetail from './network-info/EndpointDetail'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function NetworkInfo({ name, namespace, kind, rawJson }: Props) {
  // rawJson 의 spec/status 를 extras 로 추가 — base 에는 sanitize 된 raw 가 이미 있지만
  // network 리소스는 spec/status 가 핵심이라 명시적으로 다시 노출.
  const extras = rawJson
    ? { spec: rawJson.spec, status: rawJson.status }
    : undefined
  useResourceDetailOverlay({ kind, name, namespace, extras })

  if (kind === 'Service') return <ServiceDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'Ingress') return <IngressDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'IngressClass') return <IngressClassDetail name={name} rawJson={rawJson} />
  if (kind === 'NetworkPolicy') return <NetworkPolicyDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'EndpointSlice') return <EndpointSliceDetail name={name} namespace={namespace} rawJson={rawJson} />
  return <EndpointDetail name={name} namespace={namespace} kind={kind} rawJson={rawJson} />
}
