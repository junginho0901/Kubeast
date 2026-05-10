// Resource graph 노드 호버 시 우측에 뜨는 미니 프리뷰 카드
//
// frontend/src/pages/ResourceGraph.tsx 의 Glance 함수를 컴포넌트로 추출.
// position 은 viewport 기준 fixed.

import type { ResourceGraphNode } from '@/services/api'
import { kindIcon, statusColor } from './constants'

interface Props {
  node: ResourceGraphNode | null
  position: { x: number; y: number }
}

export function Glance({ node, position }: Props) {
  if (!node) return null

  const borderColor = statusColor(node.status)

  return (
    <div
      className="fixed z-[200] bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-3 min-w-[220px] max-w-[300px] pointer-events-none"
      style={{ left: position.x + 16, top: position.y - 10 }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">{kindIcon[node.kind] || '📄'}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] text-slate-400">{node.kind}</div>
          <div className="text-xs font-semibold text-white truncate">{node.name}</div>
        </div>
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: borderColor, boxShadow: `0 0 6px ${borderColor}` }} />
      </div>

      <div className="space-y-1 text-[10px]">
        <div className="flex justify-between"><span className="text-slate-400">Status</span><span className="text-white">{node.status}</span></div>
        {node.ready && <div className="flex justify-between"><span className="text-slate-400">Ready</span><span className="text-white">{node.ready}</span></div>}
        {node.namespace && <div className="flex justify-between"><span className="text-slate-400">Namespace</span><span className="text-white">{node.namespace}</span></div>}
        {node.nodeName && <div className="flex justify-between"><span className="text-slate-400">Node</span><span className="text-white">{node.nodeName}</span></div>}
        {node.ownerKind && <div className="flex justify-between"><span className="text-slate-400">Owner</span><span className="text-white">{node.ownerKind}</span></div>}
        {node.instanceLabel && <div className="flex justify-between"><span className="text-slate-400">Instance</span><span className="text-white">{node.instanceLabel}</span></div>}
      </div>
    </div>
  )
}
