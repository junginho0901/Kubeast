// The drawer a row of these screens opens: the object it names, with the apiVersion the server gives beside its Kind
// (detailTarget keeps it only where it picks the drawer, so a Kind two groups serve opens the right group's object);
// null where the row names no object.
import type { ResourceDetailTarget } from '@/components/ResourceDetailContext'
import { detailTarget } from '@/components/resource-detail/crDetail'
import type { HygieneFinding } from '@/services/api/hygiene'
import type { OptimizationRow, PolicyReportResult } from '@/services/api/types'

export function policyResultTarget(r: PolicyReportResult): ResourceDetailTarget | null {
  return r.kind && r.name ? detailTarget(r.kind, r.name, r.namespace, r.api_version) : null
}

// "API" findings name an API version, not an object.
export function hygieneFindingTarget(f: HygieneFinding): ResourceDetailTarget | null {
  return f.kind !== 'API' && f.name ? detailTarget(f.kind, f.name, f.namespace, f.api_version) : null
}

export function optimizationRowTarget(r: OptimizationRow): ResourceDetailTarget {
  return detailTarget(r.kind, r.name, r.namespace, r.api_version)
}
