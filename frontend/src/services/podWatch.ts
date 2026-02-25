import type { PodInfo } from './api'

export type PodWatchEvent = {
  type: string
  pod: PodInfo
  resource_version?: string | null
}

type PodWatchOptions = {
  namespace?: string
  resourceVersion?: string
  timeoutSeconds?: number
  onEvent: (event: PodWatchEvent) => void
  onError?: (error: any) => void
}

export function startPodWatch(options: PodWatchOptions): EventSource {
  const params = new URLSearchParams()
  if (options.resourceVersion) params.set('resourceVersion', options.resourceVersion)
  if (options.timeoutSeconds) params.set('timeout_seconds', String(options.timeoutSeconds))

  const base = '/api/v1/cluster'
  const path = options.namespace
    ? `/namespaces/${options.namespace}/pods/watch`
    : '/pods/watch'
  const url = `${base}${path}${params.toString() ? `?${params.toString()}` : ''}`

  const source = new EventSource(url)

  const handle = (evt: MessageEvent) => {
    try {
      const parsed = JSON.parse(evt.data)
      options.onEvent(parsed as PodWatchEvent)
    } catch (err) {
      options.onError?.(err)
    }
  }

  source.addEventListener('ADDED', handle)
  source.addEventListener('MODIFIED', handle)
  source.addEventListener('DELETED', handle)
  source.addEventListener('ERROR', handle)
  source.onerror = (err) => options.onError?.(err)

  return source
}
