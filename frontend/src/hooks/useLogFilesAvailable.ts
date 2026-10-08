import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'

// Whether the log files view (chart features.logFiles) applies to pods in
// namespace: the feature is on, the namespace is listed (or none are) and the
// user holds resource.pod.logfile on the selected cluster.
export function useLogFilesAvailable(namespace: string): boolean {
  const { data } = useClusterFeatures()
  const { has } = usePermission()
  const lf = data?.logFiles
  if (!lf?.enabled || !has('resource.pod.logfile')) return false
  return !lf.namespaces?.length || lf.namespaces.includes(namespace)
}
