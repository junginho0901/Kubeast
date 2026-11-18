export interface ExampleQuery {
  label: string
  types: string[]
  query: string
  /** i18n key under advancedSearch.examples; `description` is the English default */
  key: string
  description: string
}

// Each query is one the engine reads (jsep with no plugins) and computes (simple-eval): no arrow functions, no `!!`.
export const EXAMPLE_QUERIES: ExampleQuery[] = [
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
    query: 'status.containerStatuses[0].restartCount > 5',
    key: 'restartsOver5',
    description: 'Pods whose first container restarted more than 5 times',
  },
  {
    label: 'ConfigMap',
    types: ['configmaps'],
    query: 'data != null',
    key: 'configMapWithData',
    description: 'ConfigMaps that carry data',
  },
  {
    label: 'Job',
    types: ['jobs'],
    // the API sets completionTime when the Job finishes successfully, and only then (its Complete condition)
    query: 'spec.suspend === false && status.completionTime != null',
    key: 'completedJobs',
    description: 'Completed jobs (not suspended)',
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
