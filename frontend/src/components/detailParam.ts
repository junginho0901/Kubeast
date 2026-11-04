import type { ResourceDetailTarget } from './ResourceDetailContext'

// The open drawer as the query keeps it: ?detail=<Kind>/<namespace>/<name> (<Kind>/<name> for cluster-scoped kinds),
// plus detailApi=<apiVersion> when the caller names one. A custom resource instance's drawer names its own Kind and
// the resource that serves it — detailApi=<group>/<version>/<plural>, the path the API server serves it at — so a link
// opens the same object of the same CRD at the same version (a Kind may be served by two groups).

type CustomResource = { kind: string; group: string; version: string; plural: string }

function customResourceOf(t: ResourceDetailTarget): CustomResource | null {
  if (t.kind !== 'CustomResourceInstance') return null
  const rj = (t.rawJson ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const kind = text(rj.kind)
  const group = text(rj.group)
  const version = text(rj.version)
  const plural = text(rj.crd_name).split('.')[0]
  return /^[A-Za-z][A-Za-z0-9]*$/.test(kind) && group && version && plural ? { kind, group, version, plural } : null
}

export function toParam(t: ResourceDetailTarget): string {
  return [customResourceOf(t)?.kind ?? t.kind, t.namespace, t.name].filter(Boolean).join('/')
}

export function apiParam(t: ResourceDetailTarget): string {
  const cr = customResourceOf(t)
  return cr ? `${cr.group}/${cr.version}/${cr.plural}` : t.apiVersion ?? ''
}

export function keyOf(t: ResourceDetailTarget | null): string {
  return t ? `${toParam(t)}|${apiParam(t)}` : '|'
}

export function fromParam(value: string | null, api: string | null): ResourceDetailTarget | null {
  if (!value) return null
  const parts = value.split('/')
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) return null
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(parts[0])) return null
  const target: ResourceDetailTarget = parts.length === 3
    ? { kind: parts[0], namespace: parts[1], name: parts[2] }
    : { kind: parts[0], name: parts[1] }
  const cr = api ? /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(api) : null
  if (cr) {
    const [, group, version, plural] = cr
    return { ...target, kind: 'CustomResourceInstance', rawJson: { kind: target.kind, group, version, crd_name: `${plural}.${group}` } }
  }
  return api ? { ...target, apiVersion: api } : target
}
