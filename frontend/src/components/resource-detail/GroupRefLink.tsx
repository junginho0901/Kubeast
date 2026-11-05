import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { referenceApiVersion, referenceNeedsVersion } from './crDetail'
import { ResourceLink } from './ResourceLink'

interface GroupRefLinkProps {
  group: string
  kind: string
  name: string
  namespace?: string
}

// A link to an object a reference names by group and Kind but no version (a Gateway API parentRef or backendRef). It
// draws as ResourceLink; once the CRD list (the drawer's own query, so the drawer it opens finds it read) has come, it
// opens that group's object at its CRD's preferred version, and until then, or without such a CRD, by Kind as before.
export function GroupRefLink({ group, kind, name, namespace }: GroupRefLinkProps) {
  const { data: crds } = useQuery({
    queryKey: ['custom-resources', 'crds'],
    queryFn: () => api.getCRDs(false),
    enabled: referenceNeedsVersion(group, kind),
    staleTime: 60_000,
    retry: false,
  })
  return <ResourceLink kind={kind} name={name} namespace={namespace} apiVersion={referenceApiVersion(group, kind, crds)} />
}
