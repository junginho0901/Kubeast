import type { LucideIcon } from 'lucide-react'
import type { ResourceType } from './types'

// Dashboard top Stats Grid — 6개 카드 (Namespaces / Pods / Services / Deployments
// / PVCs / Nodes). 클릭 시 onStatClick(resourceType) 로 모달 열기.
// JSX 분리만, 동작 변경 없음.

export interface StatItem {
  name: string
  resourceType: ResourceType
  value: number | string
  icon: LucideIcon
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
          data-testid={`stat-${stat.resourceType}`}
          onClick={() => onStatClick(stat.resourceType)}
          className="card hover:border-primary-500 transition-colors text-left cursor-pointer"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-slate-400">{stat.name}</p>
              <p data-testid={`stat-value-${stat.resourceType}`} className="mt-2 text-2xl font-semibold text-white tabular-nums">
                {stat.value}
              </p>
            </div>
            <stat.icon className="w-5 h-5 text-slate-500" aria-hidden="true" />
          </div>
        </button>
      ))}
    </div>
  )
}
