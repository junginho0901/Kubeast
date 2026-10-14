import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'
import { useCluster } from '@/contexts/ClusterContext'
import { logSearchEnabledFor } from '@/utils/features'

// Whether log search (chart features.logSearch) applies on the selected cluster: the log store
// is configured for it and the user holds resource.pod.read there. The cluster still decides
// per namespace (get pods/log as the user); the view shows its answer.
export function useLogSearchAvailable(): boolean {
  const { data } = useClusterFeatures()
  const { has } = usePermission()
  const { currentCluster } = useCluster()
  return logSearchEnabledFor(data, currentCluster) && has('resource.pod.read')
}
