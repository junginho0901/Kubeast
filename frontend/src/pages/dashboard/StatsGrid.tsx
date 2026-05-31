import type { LucideIcon } from 'lucide-react'
import type { ResourceType } from './types'

// Dashboard top Stats Grid — 6개 카드 (Namespaces / Pods / Services / Deployments
// / PVCs / Nodes). 클릭 시 onStatClick(resourceType) 로 모달 열기.
// JSX 분리만, 동작 변경 없음.

export interface StatItem {
  name: string
  resourceType: ResourceType
  value: number
  icon: LucideIcon
  color: string
  bgColor: string
}

interface Props {
  stats: StatItem[]
  onStatClick: (type: ResourceType) => void
}

export function StatsGrid({ stats, onStatClick }: Props) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {stats.map((stat) => (
        <button
          key={stat.name}
          onClick={() => onStatClick(stat.resourceType)}
          className="card hover:border-primary-500 transition-colors text-left cursor-pointer"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-400">{stat.name}</p>
              <p className="mt-2 text-3xl font-bold text-white">{stat.value}</p>
            </div>
            <div className={`p-3 rounded-lg ${stat.bgColor}`}>
              <stat.icon className={`w-6 h-6 ${stat.color}`} />
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
