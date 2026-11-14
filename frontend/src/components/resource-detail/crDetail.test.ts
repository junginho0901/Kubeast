import { describe, expect, it } from 'vitest'
import type { CRDInfo } from '@/services/api/types'
import { apiParam, fromParam, toParam } from '../detailParam'
import drawerSource from '../ResourceDetailDrawer.tsx?raw'
import { customResourceTarget, detailTarget, drawerObjectKey, drawerResourceType, needsCustomResourceLookup, objectResourceType, otherFields } from './crDetail'

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

// Karpenter's NodePool and EC2NodeClass are both often "default"; a drawer moving from one to the other is another object.
describe('drawerObjectKey', () => {
  const cr = (crd_name: string, kind: string) => ({ kind: 'CustomResourceInstance', name: 'default', rawJson: { kind, crd_name, group: crd_name.slice(crd_name.indexOf('.') + 1), version: 'v1' } })
  const nodePool = cr('nodepools.karpenter.sh', 'NodePool')
  const nodeClass = cr('ec2nodeclasses.karpenter.k8s.aws', 'EC2NodeClass')

  it('tells apart two custom resources of one namespace and name by their CRD', () => {
    expect(drawerObjectKey(nodePool)).not.toBe(drawerObjectKey(nodeClass))
    expect(drawerObjectKey(nodePool)).toBe(drawerObjectKey(cr('nodepools.karpenter.sh', 'NodePool')))
    expect(objectResourceType(nodePool)).toBe('nodepools.karpenter.sh')
    expect(objectResourceType(nodeClass)).toBe('ec2nodeclasses.karpenter.k8s.aws')
  })

  it('tells apart one Kind and name of two groups by the apiVersion the caller named', () => {
    const of = (apiVersion?: string) => drawerObjectKey({ kind: 'Gadget', namespace: 'shop', name: 'x', apiVersion })
    expect(of('a.example.com/v1')).not.toBe(of('b.example.com/v1'))
    expect(of(undefined)).not.toBe(of('b.example.com/v1'))
    expect(drawerObjectKey({ kind: 'ConfigMap', namespace: 'a', name: 'x' })).not.toBe(drawerObjectKey({ kind: 'ConfigMap', namespace: 'b', name: 'x' }))
  })

  it('keys the drawer\'s YAML window and its save line, so neither carries over to the next object', () => {
    expect(drawerSource).toContain("const objectId = target ? drawerObjectKey(target) : ''")
    expect(drawerSource).toMatch(/<YamlEditor\s+key=\{objectId\}/)
    expect(drawerSource).toContain('toast={applyToast?.of === objectId ? applyToast : null}')
  })

  it('keys the Info tab and the Delete window too, so a value shown, a terminal or a Delete opened do not carry over', () => {
    expect(drawerSource).toContain('<div className="p-5 space-y-6 text-sm" key={objectId}>')
    expect(drawerSource).toContain('if (deleteDialogOpen && deleteFor !== objectId) setDeleteDialogOpen(false)')
    expect(drawerSource).toMatch(/setDeleteFor\(objectId\)\s+setDeleteDialogOpen\(true\)/)
  })
})

// A kind with no drawer of its own that two groups serve (no CRD of either, so no custom resource drawer): the drawer
// reads and saves the one the caller or its row named, as kubectl get <resource>.<group>; the Kind alone reads the group
// discovery prefers.
describe('objectResourceType of a kind with no drawer of its own', () => {
  it('names the group of the apiVersion the caller named, else the row\'s', () => {
    expect(objectResourceType({ kind: 'Gadget', apiVersion: 'b.example.com/v1' })).toBe('gadget.b.example.com')
    expect(objectResourceType({ kind: 'Gadget', rawJson: { apiVersion: 'a.example.com/v1' } })).toBe('gadget.a.example.com')
    expect(objectResourceType({ kind: 'Gadget', apiVersion: 'b.example.com/v1', rawJson: { apiVersion: 'a.example.com/v1' } })).toBe('gadget.b.example.com')
  })

  it('stays as it was for the core group, no apiVersion and a kind with a drawer of its own', () => {
    expect(objectResourceType({ kind: 'PodTemplate', rawJson: { apiVersion: 'v1' } })).toBe('podtemplate')
    expect(objectResourceType({ kind: 'Gadget' })).toBe(drawerResourceType('Gadget'))
    expect(objectResourceType({ kind: 'Deployment', rawJson: { apiVersion: 'apps/v1' } })).toBe('deployments.apps')
  })

  it('keeps two of one Kind and name of two groups apart in the drawer\'s views', () => {
    expect(drawerObjectKey({ kind: 'Gadget', namespace: 'shop', name: 'x', rawJson: { apiVersion: 'a.example.com/v1' } }))
      .not.toBe(drawerObjectKey({ kind: 'Gadget', namespace: 'shop', name: 'x', rawJson: { apiVersion: 'b.example.com/v1' } }))
  })

  it('is what the drawer reads its object as and keeps the read under', () => {
    expect(drawerSource).toContain("const objectType = target ? objectResourceType(target) : ''")
    expect(drawerSource).toContain("['resource-json', kind, ns, name, objectType]")
    expect(drawerSource).toContain('queryFn: () => api.getResourceJson(objectType, name, ns || undefined),')
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
