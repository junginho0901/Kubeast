import { FileCode, Shield, Terminal } from 'lucide-react'
import { useClusterView } from './ClusterViewContext'
import { pickMainContainer } from './types'
import type { DetailTab } from './types'

// 6 탭 버튼 (Summary / Logs / Describe / RBAC / Manifest / Exec).
// Logs / Exec 클릭 시 메인 컨테이너 자동 선택. Exec 은 admin 권한 있을 때만 노출.

interface Props {
  isAdmin: boolean
}

export function PodDetailTabs({ isAdmin }: Props) {
  const {
    tr,
    selectedPod,
    activeTab,
    selectTab,
    setSelectedContainer,
    setExecContainer,
  } = useClusterView()

  if (!selectedPod) return null

  const handleClickLogs = () => {
    const main = pickMainContainer(selectedPod)
    if (main) setSelectedContainer(main)
    selectTab('logs')
  }

  const handleClickExec = () => {
    const main = selectedPod.containers?.[0]?.name || ''
    setExecContainer(main)
    selectTab('exec')
  }

  const tabClass = (t: DetailTab) =>
    `px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
      activeTab === t
        ? 'text-primary-400 border-b-2 border-primary-400'
        : 'text-slate-400 hover:text-white'
    }`

  return (
    <div className="flex gap-2 px-6 pt-4 border-b border-slate-700">
      <button onClick={() => selectTab('summary')} className={tabClass('summary')}>
        {tr('clusterView.tabs.summary', 'Summary')}
      </button>
      <button onClick={handleClickLogs} className={tabClass('logs')}>
        <Terminal className="w-4 h-4" />
        {tr('clusterView.tabs.logs', 'Logs')}
      </button>
      <button onClick={() => selectTab('describe')} className={tabClass('describe')}>
        <FileCode className="w-4 h-4" />
        {tr('clusterView.tabs.describe', 'Describe')}
      </button>
      <button onClick={() => selectTab('rbac')} className={tabClass('rbac')}>
        <Shield className="w-4 h-4" />
        {tr('clusterView.tabs.rbac', 'RBAC')}
      </button>
      <button onClick={() => selectTab('manifest')} className={tabClass('manifest')}>
        <FileCode className="w-4 h-4" />
        {tr('clusterView.tabs.manifest', 'Manifest')}
      </button>
      {isAdmin && (
        <button onClick={handleClickExec} className={tabClass('exec')}>
          <Terminal className="w-4 h-4" />
          {tr('clusterView.tabs.exec', 'Exec')}
        </button>
      )}
    </div>
  )
}
