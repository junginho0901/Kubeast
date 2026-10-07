import { describe, expect, it } from 'vitest'

import { argoAppUrl, detectArgoApp, type ArgoConfig } from './gitops'

const cfg: ArgoConfig = { enabled: true, mode: 'warn', url: 'https://argocd.example.com', trackingAnnotation: 'argocd.argoproj.io/tracking-id', instanceLabel: '' }
const web = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'service-alpha', annotations: { 'argocd.argoproj.io/tracking-id': 'alpha-jobplanet:apps/Deployment:service-alpha/web' } } }

describe('detectArgoApp', () => {
  it('reads a self-referencing tracking annotation', () => {
    expect(detectArgoApp(web, 'Deployment', cfg)).toEqual({ app: 'alpha-jobplanet', method: 'annotation' })
    const cm = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm', namespace: 'default', annotations: { 'argocd.argoproj.io/tracking-id': 'app:/ConfigMap:default/cm' } } }
    expect(detectArgoApp(cm, 'ConfigMap', cfg)).toEqual({ app: 'app', method: 'annotation' })
  })
  it('ignores an annotation that names another object', () => {
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-abc', namespace: 'service-alpha', annotations: web.metadata.annotations } }
    expect(detectArgoApp(pod, 'Pod', cfg)).toBeNull()
  })
  it('uses the instance label only when configured', () => {
    const labelled = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'n', namespace: 'ns', labels: { 'app.kubernetes.io/instance': 'my-app' } } }
    expect(detectArgoApp(labelled, 'Deployment', cfg)).toBeNull()
    expect(detectArgoApp(labelled, 'Deployment', { ...cfg, instanceLabel: 'app.kubernetes.io/instance' })).toEqual({ app: 'my-app', method: 'label' })
  })
  it('is off when the feature is off or the object is missing', () => {
    expect(detectArgoApp(web, 'Deployment', { ...cfg, enabled: false })).toBeNull()
    expect(detectArgoApp(web, 'Deployment', undefined)).toBeNull()
    expect(detectArgoApp(null, 'Deployment', cfg)).toBeNull()
  })
  it('links to the application page when the UI url is set', () => {
    expect(argoAppUrl(cfg, 'alpha-jobplanet')).toBe('https://argocd.example.com/applications/alpha-jobplanet')
    expect(argoAppUrl({ ...cfg, url: '' }, 'x')).toBeNull()
  })
})
