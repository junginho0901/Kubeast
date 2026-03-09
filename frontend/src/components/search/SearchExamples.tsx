import { useTranslation } from 'react-i18next'
import { Lightbulb } from 'lucide-react'

interface ExampleQuery {
  label: string
  types: string[]
  query: string
  description: string
}

const EXAMPLES: ExampleQuery[] = [
  {
    label: 'Pod',
    types: ['pods'],
    query: 'status.phase !== "Running"',
    description: 'Running 상태가 아닌 파드 찾기',
  },
  {
    label: 'All',
    types: [],
    query: 'metadata.labels?.app === "nginx"',
    description: 'app=nginx 라벨이 있는 모든 리소스',
  },
  {
    label: 'Deployment',
    types: ['deployments'],
    query: 'spec.replicas > 3',
    description: '레플리카가 3개 초과인 디플로이먼트',
  },
  {
    label: 'Pod',
    types: ['pods'],
    query: 'status.containerStatuses?.some(c => c.restartCount > 5)',
    description: '재시작 5회 초과 파드',
  },
  {
    label: 'ConfigMap',
    types: ['configmaps'],
    query: '!!data',
    description: 'data가 있는 ConfigMap',
  },
  {
    label: 'Job',
    types: ['jobs'],
    query: 'spec.suspend === false && status.succeeded > 0',
    description: '완료된 활성 잡',
  },
  {
    label: 'Service',
    types: ['services'],
    query: 'spec.type === "LoadBalancer"',
    description: 'LoadBalancer 타입 서비스',
  },
  {
    label: 'PVC',
    types: ['persistentvolumeclaims'],
    query: 'status.phase === "Pending"',
    description: 'Pending 상태인 PVC',
  },
]

interface Props {
  onSelect: (types: string[], query: string) => void
}

export default function SearchExamples({ onSelect }: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <div className="flex items-center gap-2 text-slate-400">
        <Lightbulb className="w-5 h-5" />
        <span className="text-sm font-medium">
          {t('advancedSearch.examplesTitle', 'Example Queries')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 justify-center max-w-2xl">
        {EXAMPLES.map((ex, i) => (
          <button
            key={i}
            onClick={() => onSelect(ex.types, ex.query)}
            className="group flex flex-col items-start gap-1 px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 hover:border-sky-500/30 hover:bg-slate-800 transition-all text-left"
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 font-semibold uppercase">
                {ex.label}
              </span>
              <span className="text-xs text-slate-500">{ex.description}</span>
            </div>
            <code className="text-xs text-slate-300 font-mono group-hover:text-sky-300 transition-colors">
              {ex.query}
            </code>
          </button>
        ))}
      </div>
    </div>
  )
}
