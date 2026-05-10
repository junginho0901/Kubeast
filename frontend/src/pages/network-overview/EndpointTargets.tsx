// Service detail 의 Endpoints ready/not-ready target 리스트 표시 컴포넌트
//
// frontend/src/pages/Network.tsx 의 renderEndpointTargets 함수를 컴포넌트로 추출.
// JSX 만 다루며 외부 상태/콜백 없음.

import type { EndpointInfo } from '@/services/api'

type Tone = 'success' | 'warning'

function TargetList({
  title,
  targets,
  addresses,
  tone,
}: {
  title: string
  targets: EndpointInfo['ready_targets'] | undefined
  addresses: string[] | undefined
  tone: Tone
}) {
  const list = Array.isArray(targets) ? targets : []
  const ips = addresses || []
  const border = tone === 'success' ? 'border-emerald-800/60' : 'border-amber-800/60'
  const bg = tone === 'success' ? 'bg-emerald-950/20' : 'bg-amber-950/20'
  const label = tone === 'success' ? 'text-emerald-300' : 'text-amber-300'

  if (list.length === 0) {
    if (ips.length === 0) {
      return (
        <div className="text-xs text-slate-400">
          {title}: (없음)
        </div>
      )
    }
    return (
      <div>
        <div className={`text-xs ${label}`}>{title}</div>
        <pre className="mt-1 text-xs text-slate-200 whitespace-pre-wrap break-words bg-slate-900/30 border border-slate-700 rounded-md p-2 max-h-44 overflow-y-auto font-mono">
          {ips.join('\n')}
        </pre>
      </div>
    )
  }

  return (
    <div>
      <div className={`text-xs ${label}`}>{title}</div>
      <div className="mt-2 space-y-2">
        {list.map((t, idx) => {
          const ip = t.ip ?? ''
          const ref = t.target_ref
          const refName = ref?.name ? `${ref.kind || 'Target'}:${ref.name}` : null
          const nodeName = t.node_name ?? null

          return (
            <div
              key={`${title}-${ip}-${idx}`}
              className={`rounded-md border ${border} ${bg} px-2 py-1.5`}
            >
              <div className="font-mono text-xs text-slate-200">{ip || '(ip 없음)'}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-300">
                {refName ? <span>{refName}</span> : <span className="text-slate-400">(targetRef 없음)</span>}
                {nodeName ? <span className="text-slate-400">{`node=${nodeName}`}</span> : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function EndpointTargets({ endpoint }: { endpoint: EndpointInfo | null }) {
  if (!endpoint) return <>(없음)</>

  return (
    <div className="space-y-4">
      <TargetList
        title="Ready targets (max 50)"
        targets={endpoint.ready_targets}
        addresses={endpoint.ready_addresses}
        tone="success"
      />
      <TargetList
        title="Not-ready targets (max 50)"
        targets={endpoint.not_ready_targets}
        addresses={endpoint.not_ready_addresses}
        tone="warning"
      />
    </div>
  )
}
