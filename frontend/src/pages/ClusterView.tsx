import { ClusterViewProvider } from './cluster-view/ClusterViewContext'
import { ClusterViewBody } from './cluster-view/ClusterViewBody'

// 페이지 root: state Provider 만 wrap. 실제 로직은 ClusterViewBody.
export default function ClusterView() {
  return (
    <ClusterViewProvider>
      <ClusterViewBody />
    </ClusterViewProvider>
  )
}
