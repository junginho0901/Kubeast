import { lazy, Suspense } from 'react'
import { useResourceDetail } from './ResourceDetailContext'

// The drawer bundles every resource kind's info panel, the YAML editor and the
// exec terminal; fetch it the first time a resource is opened.
const ResourceDetailDrawer = lazy(() => import('./ResourceDetailDrawer'))

export default function LazyResourceDetailDrawer() {
  const { target } = useResourceDetail()
  if (!target) return null
  return (
    <Suspense fallback={null}>
      <ResourceDetailDrawer />
    </Suspense>
  )
}
