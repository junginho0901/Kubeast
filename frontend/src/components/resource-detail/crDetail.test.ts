import { describe, expect, it } from 'vitest'
import type { CRDInfo } from '@/services/api/types'
import { apiParam, fromParam, toParam } from '../detailParam'
import { customResourceTarget, detailTarget, drawerResourceType, needsCustomResourceLookup, otherFields } from './crDetail'

// test2 serves Widget from two groups (its own qa.example.com and the number check's), and the number check's
// BackendTLSPolicy of another group than Gateway API's
const crd = (name: string, kind: string, version: string, served?: string[]): CRDInfo => ({
  name, kind, version, served_versions: served, group: name.slice(name.indexOf('.') + 1), scope: 'Namespaced',
})
const CRDS: CRDInfo[] = [
  crd('widgets.qa.example.com', 'Widget', 'v1', ['v1']),
  crd('widgets.numbers.kubeast.io', 'Widget', 'v1', ['v1', 'v1beta1']),
  crd('backendtlspolicies.numbers.kubeast.io', 'BackendTLSPolicy', 'v1', ['v1']),
  crd('verticalpodautoscalers.autoscaling.k8s.io', 'VerticalPodAutoscaler', 'v1', ['v1', 'v1beta2']),
  crd('gateways.networking.istio.io', 'Gateway', 'v1', ['v1']),
]

describe('detailTarget', () => {
  it('keeps the apiVersion where it picks the drawer: a Kind of another group than its drawer\'s', () => {
    expect(detailTarget('Widget', 'num-w1', 'e2e-cr', 'numbers.kubeast.io/v1')).toEqual({ kind: 'Widget', name: 'num-w1', namespace: 'e2e-cr', apiVersion: 'numbers.kubeast.io/v1' })
    expect(detailTarget('Gateway', 'gw', 'mesh', 'networking.istio.io/v1').apiVersion).toBe('networking.istio.io/v1')
    expect(detailTarget('BackendTLSPolicy', 'p', 'ns', 'numbers.kubeast.io/v1').apiVersion).toBe('numbers.kubeast.io/v1')
  })

  it('leaves a built-in kind as it was (no apiVersion, so its link stays ?detail=<Kind>/<namespace>/<name>)', () => {
    for (const [kind, apiVersion] of [['Pod', 'v1'], ['Deployment', 'apps/v1'], ['HorizontalPodAutoscaler', 'autoscaling/v2'],
      ['Gateway', 'gateway.networking.k8s.io/v1'], ['VerticalPodAutoscaler', 'autoscaling.k8s.io/v1'], ['CustomResourceDefinition', 'apiextensions.k8s.io/v1']]) {
      expect(detailTarget(kind, 'x', 'ns', apiVersion)).toEqual({ kind, name: 'x', namespace: 'ns' })
    }
    expect(detailTarget('Node', 'n1', '', undefined, { metadata: {} })).toEqual({ kind: 'Node', name: 'n1', namespace: undefined, rawJson: { metadata: {} } })
  })
})

describe('customResourceTarget', () => {
  it('opens each group\'s Widget with its own CRD', () => {
    const raw = { apiVersion: 'qa.example.com/v1', kind: 'Widget', metadata: { name: 'qa-widget', namespace: 'qa-sweep' } }
    expect(customResourceTarget(detailTarget('Widget', 'qa-widget', 'qa-sweep', 'qa.example.com/v1', raw), CRDS)).toEqual({
      kind: 'CustomResourceInstance', name: 'qa-widget', namespace: 'qa-sweep',
      rawJson: { ...raw, group: 'qa.example.com', version: 'v1', crd_name: 'widgets.qa.example.com' },
    })
    expect(customResourceTarget(detailTarget('Widget', 'num-w1', 'e2e-cr', 'numbers.kubeast.io/v1beta1'), CRDS)).toEqual({
      kind: 'CustomResourceInstance', name: 'num-w1', namespace: 'e2e-cr',
      rawJson: { kind: 'Widget', group: 'numbers.kubeast.io', version: 'v1beta1', crd_name: 'widgets.numbers.kubeast.io' },
    })
    expect(customResourceTarget(detailTarget('BackendTLSPolicy', 'num-gp-1', 'e2e-cr', 'numbers.kubeast.io/v1'), CRDS).rawJson?.crd_name).toBe('backendtlspolicies.numbers.kubeast.io')
    expect(customResourceTarget(detailTarget('Gateway', 'gw', 'mesh', 'networking.istio.io/v1'), CRDS).kind).toBe('CustomResourceInstance')
  })

  it('reads a version the CRD no longer serves (an old event\'s) at its storage version', () => {
    expect(customResourceTarget(detailTarget('Widget', 'qa-widget', 'qa-sweep', 'qa.example.com/v1alpha1'), CRDS).rawJson).toEqual({
      kind: 'Widget', group: 'qa.example.com', version: 'v1', crd_name: 'widgets.qa.example.com',
    })
  })

  it('leaves the target as it is without a CRD of that group, before the CRD list answers and for a kind\'s own group', () => {
    const csi = detailTarget('CSIDriver', 'csi', undefined, 'storage.k8s.io/v1')
    expect(customResourceTarget(csi, CRDS)).toBe(csi)
    const widget = detailTarget('Widget', 'w', 'ns', 'other.example.com/v1')
    expect(customResourceTarget(widget, CRDS)).toBe(widget)
    expect(customResourceTarget(detailTarget('Widget', 'w', 'ns', 'qa.example.com/v1'), undefined).kind).toBe('Widget')
    const vpa = { kind: 'VerticalPodAutoscaler', name: 'v', namespace: 'ns', apiVersion: 'autoscaling.k8s.io/v1' }
    expect(customResourceTarget(vpa, CRDS)).toBe(vpa)
    expect(needsCustomResourceLookup(vpa)).toBe(false)
  })

  it('opens the same object from the link the drawer leaves', () => {
    const asked = detailTarget('Widget', 'num-alt-1', 'e2e-cr', 'qa.example.com/v1')
    expect([toParam(asked), apiParam(asked)]).toEqual(['Widget/e2e-cr/num-alt-1', 'qa.example.com/v1'])
    const back = fromParam(toParam(asked), apiParam(asked))
    expect(back).toEqual(asked)
    expect(customResourceTarget(back!, CRDS).rawJson?.crd_name).toBe('widgets.qa.example.com')
  })
})

// test2 serves the number check's backendtlspolicies at numbers.kubeast.io's preferred version and Gateway API's at
// v1alpha3, not its group's preferred v1: k8s-service answers the name alone with the first (matchResource)
describe('drawerResourceType', () => {
  it('names a kind of a group with its group, so the drawer reads and saves the object it draws', () => {
    expect(drawerResourceType('BackendTLSPolicy')).toBe('backendtlspolicies.gateway.networking.k8s.io')
    expect(drawerResourceType('Gateway')).toBe('gateways.gateway.networking.k8s.io')
    expect(drawerResourceType('Deployment')).toBe('deployments.apps')
    expect(drawerResourceType('VerticalPodAutoscaler')).toBe('verticalpodautoscalers.autoscaling.k8s.io')
  })

  it('leaves a core kind and a kind with no drawer of its own as they were', () => {
    expect(drawerResourceType('ConfigMap')).toBe('configmap')
    expect(drawerResourceType('Secret')).toBe('secret')
    expect(drawerResourceType('PodTemplate')).toBe('podtemplate')
  })
})

describe('otherFields', () => {
  it('lists the fields beside spec and status by name, as kubectl describe prints them', () => {
    expect(otherFields({ summary: { pass: 1 }, results: [{ policy: 'p' }], scope: { kind: 'Pod' }, Zone: 'a' }).map(([k]) => k)).toEqual(['Zone', 'results', 'scope', 'summary'])
    expect(otherFields({ results: [1, 2] })).toEqual([['results', [1, 2]]])
  })

  it('has none without fields', () => {
    expect(otherFields(undefined)).toEqual([])
    expect(otherFields(null)).toEqual([])
    expect(otherFields([['a', 1]])).toEqual([])
  })
})
