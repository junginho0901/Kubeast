import { PodSummaryTab } from './PodSummaryTab'
import { PodLogsTab } from './PodLogsTab'
import { PodDescribeTab } from './PodDescribeTab'
import { PodRbacTab } from './PodRbacTab'
import { PodExecPanel } from './PodExecPanel'
import { useClusterView } from './ClusterViewContext'

// 활성 탭에 해당하는 본문을 렌더. PodLogsTab 은 selectedPod 변경 시 강제 remount
// (key) — dev/StrictMode/HMR 조합에서 'No logs available.' stuck 회피.

interface Props {
  manifest: string | undefined
  describeData: any
}

export function PodDetailTabBody({ manifest, describeData }: Props) {
  const {
    tr,
    locale,
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

  return (
    <div className={`flex-1 p-6 ${showExec ? 'overflow-hidden' : 'overflow-y-auto'}`}>
      {activeTab === 'summary' && (
        <PodSummaryTab
          pod={selectedPod}
          containerSearchQuery={containerSearchQuery}
          onContainerSearchChange={setContainerSearchQuery}
          locale={locale}
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

      {activeTab === 'describe' && describeData && (
        <PodDescribeTab data={describeData} locale={locale} na={na} tr={tr} />
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
