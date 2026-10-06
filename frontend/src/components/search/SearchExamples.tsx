import { useTranslation } from 'react-i18next'
import { Lightbulb } from 'lucide-react'

interface ExampleQuery {
  label: string
  types: string[]
  query: string
  /** i18n key under advancedSearch.examples; `description` is the English default */
  key: string
  description: string
}

const EXAMPLES: ExampleQuery[] = [
  {
    label: 'Pod',
    types: ['pods'],
    query: 'status.phase !== "Running"',
    key: 'podsNotRunning',
    description: 'Pods that are not Running',
  },
  {
    label: 'All',
    types: [],
    query: 'metadata.labels?.app === "nginx"',
    key: 'labelApp',
    description: 'Everything labelled app=nginx',
  },
  {
    label: 'Deployment',
    types: ['deployments'],
    query: 'spec.replicas > 3',
    key: 'replicasOver3',
    description: 'Deployments with more than 3 replicas',
  },
  {
    label: 'Pod',
    types: ['pods'],
    query: 'status.containerStatuses?.some(c => c.restartCount > 5)',
    key: 'restartsOver5',
    description: 'Pods restarted more than 5 times',
  },
  {
    label: 'ConfigMap',
    types: ['configmaps'],
    query: '!!data',
    key: 'configMapWithData',
    description: 'ConfigMaps that carry data',
  },
  {
    label: 'Job',
    types: ['jobs'],
    query: 'spec.suspend === false && status.succeeded > 0',
    key: 'completedJobs',
    description: 'Active jobs that have completed',
  },
  {
    label: 'Service',
    types: ['services'],
    query: 'spec.type === "LoadBalancer"',
    key: 'loadBalancerServices',
    description: 'Services of type LoadBalancer',
  },
  {
    label: 'PVC',
    types: ['persistentvolumeclaims'],
    query: 'status.phase === "Pending"',
    key: 'pendingPvcs',
    description: 'PVCs stuck in Pending',
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
              <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-sky-500/10 text-sky-400 font-semibold uppercase">
                {ex.label}
              </span>
              <span className="text-xs text-slate-500">{t(`advancedSearch.examples.${ex.key}`, ex.description)}</span>
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
