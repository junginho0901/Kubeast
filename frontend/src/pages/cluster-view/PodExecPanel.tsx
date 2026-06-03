import { CheckCircle, ChevronDown } from 'lucide-react'
import PodExecTerminal from '@/components/PodExecTerminal'
import { useClusterView } from './ClusterViewContext'

// Exec 탭의 본체 — container/shell 커스텀 dropdown + PodExecTerminal.
// PodExecTerminal 의 key 는 ns-name-container-command 조합으로 강제 remount (=
// container/shell 바꿀 때마다 새 세션). useClusterEffects 가 외부 클릭 close 처리.

export function PodExecPanel() {
  const {
    selectedPod,
    execContainer, setExecContainer,
    execCommand, setExecCommand,
    isExecContainerDropdownOpen, setIsExecContainerDropdownOpen,
    isExecShellDropdownOpen, setIsExecShellDropdownOpen,
    execContainerDropdownRef, execShellDropdownRef,
    selectTab,
  } = useClusterView()

  if (!selectedPod) return null

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 mb-2">
        {/* Container 커스텀 드롭다운 */}
        <div className="relative" ref={execContainerDropdownRef}>
          <button
            onClick={() => {
              setIsExecContainerDropdownOpen(!isExecContainerDropdownOpen)
              setIsExecShellDropdownOpen(false)
            }}
            className="h-8 px-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[160px] justify-between"
          >
            <span className="text-xs font-medium truncate">{execContainer || '-'}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isExecContainerDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {isExecContainerDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[200px] overflow-y-auto">
              {selectedPod.containers?.map((c: any) => (
                <button
                  key={c.name}
                  onClick={() => {
                    setExecContainer(c.name)
                    setIsExecContainerDropdownOpen(false)
                  }}
                  className="w-full px-3 py-2 text-left text-xs text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg"
                >
                  {execContainer === c.name && <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />}
                  <span className={execContainer === c.name ? 'font-medium' : ''}>{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Shell 커스텀 드롭다운 */}
        <div className="relative" ref={execShellDropdownRef}>
          <button
            onClick={() => {
              setIsExecShellDropdownOpen(!isExecShellDropdownOpen)
              setIsExecContainerDropdownOpen(false)
            }}
            className="h-8 px-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[120px] justify-between"
          >
            <span className="text-xs font-medium">{execCommand}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isExecShellDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {isExecShellDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50">
              {['/bin/sh', '/bin/bash', '/bin/ash', 'sh'].map((sh) => (
                <button
                  key={sh}
                  onClick={() => {
                    setExecCommand(sh)
                    setIsExecShellDropdownOpen(false)
                  }}
                  className="w-full px-3 py-2 text-left text-xs text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg"
                >
                  {execCommand === sh && <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />}
                  <span className={execCommand === sh ? 'font-medium' : ''}>{sh}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-[400px] rounded-lg overflow-hidden border border-slate-700">
        <PodExecTerminal
          key={`${selectedPod.namespace}-${selectedPod.name}-${execContainer}-${execCommand}`}
          podName={selectedPod.name}
          namespace={selectedPod.namespace}
          container={execContainer}
          command={execCommand}
          onClose={() => selectTab('summary')}
        />
      </div>
    </div>
  )
}
