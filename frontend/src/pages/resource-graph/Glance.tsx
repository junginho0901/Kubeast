// Resource graph 노드 호버 · 키보드 초점 때 우측에 뜨는 미니 프리뷰 카드
//
// frontend/src/pages/ResourceGraph.tsx 의 Glance 함수를 컴포넌트로 추출.
// position 은 viewport 기준 fixed. 카드 왼쪽 16px(before)은 노드 끝까지 이어진 칸이라 포인터가 노드에서 카드로 옮겨도
// 카드가 남는다(WCAG 2.2 1.4.13 — useGlance).

import { useTranslation } from 'react-i18next'
import type { ResourceGraphNode } from '@/services/api'
import { kindIcon, nodeColor } from './constants'

interface Props {
  node: ResourceGraphNode | null
  position: { x: number; y: number }
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function Glance({ node, position, onMouseEnter, onMouseLeave }: Props) {
  const { t } = useTranslation()
  if (!node) return null

  const borderColor = nodeColor(node)

  return (
    <div
      className="fixed z-200 bg-slate-800 border border-hairline rounded-xl shadow-xl p-4 min-w-[220px] max-w-[300px] before:absolute before:inset-y-0 before:-left-4 before:w-4"
      style={{ left: position.x + 16, top: position.y - 10 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">{kindIcon[node.kind] || '📄'}</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400">{node.group ? t('resourceGraph.group.title', { defaultValue: '{{kind}} group', kind: node.kind }) : node.kind}</div>
          <div className="text-sm font-semibold text-ink break-all">{node.group && node.kind === 'Pod' ? node.ownerName : node.name}</div>
        </div>
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: borderColor }} />
      </div>

      <div className="space-y-1.5 text-xs break-all">
        <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.status', 'Status')}</span><span className="text-ink">{node.status}</span></div>
        {node.ready && <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.ready', 'Ready')}</span><span className="text-ink">{node.ready}</span></div>}
        {node.namespace && <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.namespace', 'Namespace')}</span><span className="text-ink">{node.namespace}</span></div>}
        {node.nodeName && <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.node', 'Node')}</span><span className="text-ink">{node.nodeName}</span></div>}
        {node.ownerKind && <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.owner', 'Owner')}</span><span className="text-ink">{node.group ? `${node.ownerKind}/${node.ownerName}` : node.ownerKind}</span></div>}
        {node.group && <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.members', 'In this box')}</span><span className="text-ink">{node.count}</span></div>}
        {node.group && (node.restarted ?? 0) > 0 && <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.restarted', 'Restarted')}</span><span className="text-ink">{node.restarted}</span></div>}
        {node.instanceLabel && <div className="flex justify-between"><span className="text-slate-400">{t('resourceGraph.glance.instance', 'Instance')}</span><span className="text-ink">{node.instanceLabel}</span></div>}
      </div>
    </div>
  )
}
