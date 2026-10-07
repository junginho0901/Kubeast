import type { ClusterFeatures } from '@/services/api'

// The Argo CD Application that manages an object, read from the marks Argo CD
// leaves on it — the same rule k8s-service applies before a write: the
// tracking annotation ("app:group/Kind:namespace/name") counts only when it
// names this very object; the instance label only when the chart names one.
export interface ArgoManaged {
  app: string
  method: 'annotation' | 'label'
}

export type ArgoConfig = NonNullable<ClusterFeatures['gitops']>['argocd']

export function detectArgoApp(rawJson: Record<string, unknown> | null | undefined, kind: string, cfg: ArgoConfig | undefined): ArgoManaged | null {
  if (!cfg?.enabled || !rawJson) return null
  const meta = (rawJson.metadata ?? {}) as Record<string, unknown>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const apiVersion = String(rawJson.apiVersion ?? '')
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
  const name = String(meta.name ?? '')
  const namespace = String(meta.namespace ?? '')

  const id = annotations[cfg.trackingAnnotation]
  if (id) {
    const [app, gk, nn] = id.split(':')
    if (app && gk && nn !== undefined && gk === `${group}/${kind}` && nn === `${namespace}/${name}`) {
      return { app, method: 'annotation' }
    }
  }
  if (cfg.instanceLabel && labels[cfg.instanceLabel]) {
    return { app: labels[cfg.instanceLabel], method: 'label' }
  }
  return null
}

export function argoAppUrl(cfg: ArgoConfig | undefined, app: string): string | null {
  return cfg?.url ? `${cfg.url}/applications/${encodeURIComponent(app)}` : null
}
