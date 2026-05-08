// Resources 페이지의 탭 네비게이션. Resources.tsx 에서 추출 (Phase 3.5.a).
//
// 7개 리소스 타입 (Deployments / Pods / Services / ReplicaSets / HPA / PDB /
// PVCs) 사이 전환. tabs 정의는 부모에서 만들어 prop 으로 전달 — 아이콘이 외부
// lucide-react import 라 컴포넌트 안에서 새로 import 해도 되지만 부모에서
// 통째로 넘기는 게 props 타입을 단순하게 유지.

import type { ComponentType } from 'react'
import type { ResourceType } from './types'

export interface TabConfig {
  id: ResourceType
  name: string
  icon: ComponentType<{ className?: string }>
}

interface Props {
  tabs: TabConfig[]
  activeTab: ResourceType
  onTabChange: (tab: ResourceType) => void
}

export function TabNavigation({ tabs, activeTab, onTabChange }: Props) {
  return (
    <div className="flex gap-2 border-b border-slate-700">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`
            flex items-center gap-2 px-4 py-3 font-medium transition-colors
            border-b-2 -mb-px
            ${activeTab === tab.id
              ? 'border-primary-500 text-white'
              : 'border-transparent text-slate-400 hover:text-white'
            }
          `}
        >
          <tab.icon className="w-4 h-4" />
          {tab.name}
        </button>
      ))}
    </div>
  )
}
