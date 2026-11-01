import type { CRDInfo } from '@/services/api'

// The versions the API serves, sorted, as kubectl's VERSIONS column lists them (apiextensions-apiserver v0.37
// tableconvertor) — a version not served left out — from a CRD object's spec.versions.
export function servedVersions(versions: unknown): string[] {
  if (!Array.isArray(versions)) return []
  return versions
    .filter((v) => v?.served === true && typeof v?.name === 'string')
    .map((v) => v.name as string)
    .sort()
}

// The Versions cell: the served versions with the storage version marked, e.g. "v1 (storage), v1beta1". A row from
// a server without served_versions shows its storage version alone.
export function crdVersionsText(crd: Pick<CRDInfo, 'version' | 'served_versions'>): string {
  const served = crd.served_versions ?? (crd.version ? [crd.version] : [])
  return served.map((v) => (v === crd.version ? `${v} (storage)` : v)).join(', ')
}
