import fs from 'node:fs'
import path from 'node:path'

import { GW, ancestor, arg, condition } from './number-check.gateway-shared'

// The number check's VPA, custom resource and Gateway policy objects on test2 — number-check.vpa-fixture.yaml,
// number-check.cr-crd.yaml with number-check.cr-instances.yaml, number-check.gwpol-crd.yaml with two policies of its
// kind — and the statuses a controller would write (none runs there), which number-check-lists.spec.ts and
// number-check-cr-drawers.spec.ts both make, each in a namespace of its own.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Kubectl = (args: string, input?: string) => string

const read = (name: string) => fs.readFileSync(path.join(__dirname, name), 'utf8')
const inNamespace = (text: string, ns: string) => text.replace(/\be2e-numbers\b/g, ns)

// VPAs: num-vpa-b lists another condition before RecommendationProvided, num-vpa-c has none
export const vpaFixture = (ns: string) => inNamespace(read('number-check.vpa-fixture.yaml'), ns)
export const VPA_STATUS: [string, Obj][] = [
  ['num-vpa-a', {
    conditions: [condition('RecommendationProvided', 'True')],
    recommendation: { containerRecommendations: [{ containerName: 'app', target: { cpu: '25m', memory: '64Mi' } }] },
  }],
  ['num-vpa-b', {
    conditions: [condition('LowConfidence', 'True'), condition('RecommendationProvided', 'False', 'NotEnoughData')],
    recommendation: { containerRecommendations: [
      { containerName: 'db', target: { cpu: '100m', memory: '256Mi' } },
      { containerName: 'sidecar', target: { cpu: '10m', memory: '16Mi' } },
    ] },
  }],
]
export function writeVpaStatus(kubectl: Kubectl, ns: string) {
  for (const [name, status] of VPA_STATUS) {
    kubectl(`patch verticalpodautoscaler ${name} -n ${ns} --subresource=status --type=merge -p=${arg({ status })}`)
  }
}

// The fields of VPA 1.6 and 1.7 (vertical-pod-autoscaler-1.8.1's vpa-v1-crd-gen.yaml has the same): the wide columns
// MinReplicas and OOMSeconds (spec.updatePolicy.minReplicas, evictAfterOOMSeconds), the pod's startupBoost and a
// container policy's OOM, memory aggregation and startup boost settings. An older CRD refuses them, so the VPA that
// sets them is made only where the CRD prints those columns.
export const VPA17_MISSING = 'test2\'s VPA CRD prints no MinReplicas or OOMSeconds column (older than vertical-pod-autoscaler-1.7.0): apply vpa-v1-crd-gen.yaml of vertical-pod-autoscaler-1.8.1 there'
export function vpaPrintsWideColumns(kubectl: Kubectl): boolean {
  const crd = JSON.parse(kubectl('get crd verticalpodautoscalers.autoscaling.k8s.io -o json'))
  const v1 = (crd.spec.versions as Obj[]).find((v) => v.name === 'v1')
  const names = (v1?.additionalPrinterColumns ?? []).map((c: Obj) => c.name)
  return names.includes('MinReplicas') && names.includes('OOMSeconds')
}
export const vpa17 = (ns: string, name: string): Obj => ({
  apiVersion: 'autoscaling.k8s.io/v1', kind: 'VerticalPodAutoscaler', metadata: { name, namespace: ns },
  spec: {
    targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
    updatePolicy: { updateMode: 'InPlace', minReplicas: 2, evictAfterOOMSeconds: 300, evictionRequirements: [{ resources: ['cpu', 'memory'], changeRequirement: 'TargetHigherThanRequests' }] },
    recommenders: [{ name: 'num-recommender' }],
    startupBoost: { cpu: { type: 'Factor', factor: 2, durationSeconds: 10 } },
    resourcePolicy: {
      containerPolicies: [
        { containerName: 'app', oomBumpUpRatio: '1.5', oomMinBumpUp: '100Mi', memoryAggregationIntervalSeconds: 3600, memoryAggregationIntervalCount: 8, startupBoost: { cpu: { type: 'Quantity', quantity: '500m' } } },
        { containerName: '*', mode: 'Off', oomBumpUpRatio: 2 },
      ],
    },
  },
})

// the Widget kind (cluster-scoped CRD, one for both specs) and its instances in namespace ns
export const CR_CRD = read('number-check.cr-crd.yaml')
export const crInstances = (ns: string) => inNamespace(read('number-check.cr-instances.yaml'), ns)
// num-w1 changed once (generation 2), two statuses with the Ready condition after another one
export function writeWidgetStatus(kubectl: Kubectl, ns: string) {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
  kubectl(`patch widget.numbers.kubeast.io num-w1 -n ${ns} --type=merge -p=${arg({ spec: { size: 'xlarge' } })}`)
  kubectl(`patch widget.numbers.kubeast.io num-w1 -n ${ns} --subresource=status --type=merge -p=${arg({ status: { conditions: [condition('Ready', 'True')], lastSeen: ago(5) } })}`)
  kubectl(`patch widget.numbers.kubeast.io num-w3 -n ${ns} --subresource=status --type=merge -p=${arg({ status: { conditions: [condition('Synced', 'True'), condition('Ready', 'False')], lastSeen: ago(90) } })}`)
}

// the Gateway policy kind of another group (cluster-scoped CRD) and two policies of it in namespace ns: one targets a
// Service's section, one a Gateway; one accepted by its one Gateway, one by one of two
export const GWPOL_CRD = read('number-check.gwpol-crd.yaml')
export const NUM_SVC = { group: '', kind: 'Service', name: 'num-svc' }
export const numbersPolicies = (ns: string): Obj[] => [
  { apiVersion: 'numbers.kubeast.io/v1', kind: 'BackendTLSPolicy', metadata: { name: 'num-gp-1', namespace: ns }, spec: { targetRefs: [{ ...NUM_SVC, sectionName: 'https' }] } },
  { apiVersion: 'numbers.kubeast.io/v1', kind: 'BackendTLSPolicy', metadata: { name: 'num-gp-2', namespace: ns }, spec: { targetRef: { group: GW, kind: 'Gateway', name: 'num-gw-a' } } },
]
export function writeNumbersPolicyStatus(kubectl: Kubectl, ns: string) {
  const status = (name: string, s: Obj) =>
    kubectl(`patch backendtlspolicies.numbers.kubeast.io ${name} -n ${ns} --subresource=status --type=merge -p=${arg({ status: s })}`)
  status('num-gp-1', { ancestors: [ancestor('num-gw-a', [condition('Accepted', 'True')])] })
  status('num-gp-2', {
    ancestors: [ancestor('num-gw-a', [condition('Accepted', 'True')]), ancestor('num-gw-b', [condition('Accepted', 'False', 'Conflicted')])],
  })
}
