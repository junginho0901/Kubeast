import { lazy, Suspense } from 'react'
import { useCluster } from '@/contexts/ClusterContext'
import { useResourceDetail } from './ResourceDetailContext'

// The drawer bundles every resource kind's info panel, the YAML editor and the
// exec terminal; fetch it the first time a resource is opened.
const ResourceDetailDrawer = lazy(() => import('./ResourceDetailDrawer'))

export default function LazyResourceDetailDrawer() {
  const { target } = useResourceDetail()
  // a drawer of another cluster starts again: its tab, a YAML being edited and a message of the cluster before go
  const { currentCluster } = useCluster()
  if (!target) return null
  return (
    <Suspense fallback={null}>
      <ResourceDetailDrawer key={currentCluster} />
    </Suspense>
  )
}
