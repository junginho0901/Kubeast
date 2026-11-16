import { PodSummaryTab } from './PodSummaryTab'
import { PodLogsTab } from './PodLogsTab'
import { PodDescribeTab } from './PodDescribeTab'
import { PodRbacTab } from './PodRbacTab'
import { DescribeFailure } from '@/components/resource-detail/DescribeFailure'
import { PodExecPanel } from './PodExecPanel'
import { useClusterView } from './ClusterViewContext'
import { Loader2 } from 'lucide-react'
import type { PodReadShown } from './podDetailRead'

// 활성 탭에 해당하는 본문을 렌더. PodLogsTab 은 selectedPod 변경 시 강제 remount
// (key) — dev/StrictMode/HMR 조합에서 'No logs available.' stuck 회피.

interface Props {
  manifest: string | undefined
  describeData: any
  describeError?: unknown
  podRead?: PodReadShown
}

export function PodDetailTabBody({ manifest, describeData, describeError, podRead = 'none' }: Props) {
  const {
    tr,
    na,
    emptyValue,
    selectedPod,
    selectedContainer,
    setSelectedContainer,
    containerSearchQuery,
    setContainerSearchQuery,
    activeTab,
    showExec,
  } = useClusterView()

  if (!selectedPod) return null

  // Summary, Logs and Exec show the pod's containers, which a window opened from a box's row reads first
  const waits = podRead !== 'none' && (activeTab === 'summary' || activeTab === 'logs' || activeTab === 'exec')
  if (waits) {
    return (
      <div className="flex-1 p-6 overflow-y-auto" data-testid="cluster-view-pod-read">
        {podRead === 'reading' ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            {tr('common.loading', 'Loading...')}
          </div>
        ) : (
          <DescribeFailure error={podRead.error} className="py-4" about={{ kind: 'Pod', name: selectedPod.name, namespace: selectedPod.namespace }} />
        )}
      </div>
    )
  }

  return (
    <div className={`flex-1 p-6 ${showExec ? 'overflow-hidden' : 'overflow-y-auto'}`}>
      {activeTab === 'summary' && (
        <PodSummaryTab
          pod={selectedPod}
          containerSearchQuery={containerSearchQuery}
          onContainerSearchChange={setContainerSearchQuery}
          na={na}
          emptyValue={emptyValue}
          tr={tr}
        />
      )}

      {activeTab === 'logs' && (
        <PodLogsTab
          // pod 가 바뀌면 PodLogsTab 자체를 강제 unmount/remount.
          // dep 변경으로 effect 만 재실행하는 흐름은 closure-local
          // 변수로 격리해도 dev/StrictMode/HMR 조합에서 'No logs
          // available.' 가 stuck 처럼 인식되는 케이스가 남아 있어,
          // 가장 robust 한 방법으로 컴포넌트 인스턴스 자체를 새로
          // 만든다. 같은 pod 의 컨테이너 전환은 dep 변경으로 처리되어
          // remount 안 일어남.
          key={`${selectedPod.namespace}/${selectedPod.name}`}
          pod={selectedPod}
          selectedContainer={selectedContainer}
          onSelectContainer={setSelectedContainer}
          containerSearchQuery={containerSearchQuery}
          onContainerSearchChange={setContainerSearchQuery}
          tr={tr}
        />
      )}

      {activeTab === 'describe' && !describeData && <DescribeFailure error={describeError} className="py-4" about={{ kind: 'Pod', name: selectedPod.name, namespace: selectedPod.namespace }} />}
      {activeTab === 'describe' && describeData && (
        <PodDescribeTab data={describeData} na={na} tr={tr} />
      )}

      {activeTab === 'rbac' && <PodRbacTab pod={selectedPod} tr={tr} />}

      {activeTab === 'manifest' && (
        <div className="h-full bg-slate-900 rounded-lg p-4 font-mono text-sm text-slate-300 overflow-x-auto overflow-y-auto">
          <pre>{manifest || tr('clusterView.manifest.loading', 'Loading...')}</pre>
        </div>
      )}

      {activeTab === 'exec' && <PodExecPanel />}
    </div>
  )
}
