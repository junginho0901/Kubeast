import { describe, expect, it } from 'vitest'
import { fillTraceTemplate, podServiceName } from './traceLinks'

const id = '4bf92f3577b34da6a3ce929d0e0e4736'

describe('fillTraceTemplate', () => {
  it('fills the placeholders, URL-encoded', () => {
    expect(fillTraceTemplate('https://jaeger.example.com/trace/{{traceId}}', { traceId: id })).toBe(`https://jaeger.example.com/trace/${id}`)
    expect(
      fillTraceTemplate('https://tempo.example.com/search?q={{ service }}&ns={{namespace}}&c={{cluster}}', {
        service: 'web api',
        namespace: 'apps',
        cluster: 'alpha&x=1',
      }),
    ).toBe('https://tempo.example.com/search?q=web%20api&ns=apps&c=alpha%26x%3D1')
  })

  it('gives no link without a template, with a placeholder left empty, or for a non-web result', () => {
    expect(fillTraceTemplate(undefined, { traceId: id })).toBeNull()
    expect(fillTraceTemplate('', { traceId: id })).toBeNull()
    expect(fillTraceTemplate('https://x/trace/{{traceId}}', {})).toBeNull()
    expect(fillTraceTemplate('https://x/search?service={{service}}&pod={{pod}}', { service: 'web' })).toBeNull()
    expect(fillTraceTemplate('{{service}}', { service: 'javascript:alert(1)' })).toBeNull()
    expect(fillTraceTemplate('javascript:alert({{traceId}})', { traceId: id })).toBeNull()
  })
})

describe('podServiceName', () => {
  const owned = { name: 'web-7d9c8-abcde', labels: { 'pod-template-hash': '7d9c8' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7d9c8' }] }

  it('follows the OpenTelemetry order', () => {
    expect(podServiceName({ ...owned, annotations: { 'resource.opentelemetry.io/service.name': 'checkout' }, labels: { ...owned.labels, 'app.kubernetes.io/name': 'n' } })).toBe('checkout')
    expect(podServiceName({ ...owned, labels: { ...owned.labels, 'app.kubernetes.io/instance': 'i', 'app.kubernetes.io/name': 'n' } })).toBe('i')
    expect(podServiceName({ ...owned, labels: { ...owned.labels, 'app.kubernetes.io/name': 'n' } })).toBe('n')
    expect(podServiceName(owned)).toBe('web')
  })

  it('falls back to the other owners, then the pod', () => {
    expect(podServiceName({ name: 'db-0', ownerReferences: [{ kind: 'StatefulSet', name: 'db' }] })).toBe('db')
    expect(podServiceName({ name: 'agent-x1', ownerReferences: [{ kind: 'DaemonSet', name: 'agent' }] })).toBe('agent')
    expect(podServiceName({ name: 'm-2910-q', ownerReferences: [{ kind: 'Job', name: 'm-2910' }] })).toBe('m-2910')
    // a ReplicaSet whose name does not end with the hash stays as it is
    expect(podServiceName({ name: 'p', labels: { 'pod-template-hash': 'zz' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'rs-1' }] })).toBe('rs-1')
    expect(podServiceName({ name: 'bare' })).toBe('bare')
  })
})
