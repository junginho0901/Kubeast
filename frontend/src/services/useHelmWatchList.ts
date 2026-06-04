import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HelmReleaseSummary } from './api'

// Helm release watch — Server-Sent Events 로 cluster + namespace 별 release
// 변화를 실시간 push. backend 가 Helm Secret 을 decode 해서 보내주므로 K8s
// native watch multiplexer 와는 별도 endpoint (/api/v1/helm/releases/stream).
//
// 이전엔 WebSocket 이었으나 단방향 read-only 라 SSE 로 전환 — frontend
// retry/backoff/cancelled flag 코드 제거 (EventSource 가 자동 reconnect).
// ping/pong 도 backend 의 ': keepalive\n\n' comment 라인으로 자동 처리.

type HelmWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED'

interface HelmWatchEvent {
  type: HelmWatchEventType
  object: HelmReleaseSummary
}

export interface UseHelmWatchListOptions {
  /**
   * cluster id. 현재는 "default" 만 의미. multi-cluster 전환 시 callsite 한 줄
   * 변경으로 끝나도록 파라미터로 둠.
   */
  cluster: string
  /**
   * namespace filter. Empty/undefined = cluster-wide watch.
   */
  namespace?: string
  /**
   * gate the connection (e.g. wait until the initial REST list resolves).
   */
  enabled?: boolean
  /**
   * react-query key whose cache the hook should mutate. The page's
   * useQuery must use the same key for the watch to take effect. Pass
   * `null` to disable list-cache mutation entirely.
   */
  queryKey: readonly unknown[] | null
  /**
   * Called for every release event after the cache has been mutated.
   * Captured by ref so changing this prop does not tear down the stream.
   */
  onEvent?: (event: HelmWatchEvent) => void
}

export type { HelmWatchEvent }

const buildHelmWatchURL = (cluster: string, namespace?: string): string => {
  const params = new URLSearchParams({ cluster })
  if (namespace) params.set('namespace', namespace)
  // 같은 origin → cookie auth 자동 (withCredentials)
  return `/api/v1/helm/releases/stream?${params.toString()}`
}

const releaseKey = (rel: HelmReleaseSummary): string =>
  `${rel.namespace}/${rel.name}`

const applyHelmWatchEvent = (
  prev: HelmReleaseSummary[] | undefined,
  event: HelmWatchEvent,
): HelmReleaseSummary[] => {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event.object
  if (!obj?.name || !obj?.namespace) return items
  const key = releaseKey(obj)
  const idx = items.findIndex((item) => releaseKey(item) === key)

  if (event.type === 'DELETED') {
    if (idx >= 0) items.splice(idx, 1)
    return items
  }

  // Helm increments revision on every install/upgrade/rollback. Only accept
  // ADDED/MODIFIED if the revision is at least the cached one — out-of-order
  // delivery from a re-list would otherwise rewind the UI to a stale state.
  if (idx >= 0) {
    const existing = items[idx]
    if (existing.revision > obj.revision) return items
    items[idx] = obj
  } else {
    items.push(obj)
  }

  return items
}

/**
 * useHelmWatchList — /api/v1/helm/releases/stream 에 SSE 로 구독하고 named
 * react-query cache 를 Helm release Secret 변화에 따라 갱신.
 *
 * EventSource 가 자동 reconnect 처리 (idle timeout / 네트워크 일시 끊김).
 * JWT auth 는 cookie 로 자동 (withCredentials).
 */
export function useHelmWatchList(options: UseHelmWatchListOptions): void {
  const queryClient = useQueryClient()
  const { cluster, namespace, enabled = true, queryKey } = options

  // Stringify queryKey — array identity 가 매 render 마다 다르지만 contents 만 중요.
  const queryKeyDep = JSON.stringify(queryKey)

  // onEvent 를 ref 로 받아 prop 변경이 stream 을 끊지 않게.
  const onEventRef = useRef(options.onEvent)
  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    if (!enabled) return

    const url = buildHelmWatchURL(cluster, namespace)
    const es = new EventSource(url, { withCredentials: true })

    es.onmessage = (raw: MessageEvent) => {
      try {
        const msg = JSON.parse(raw.data) as HelmWatchEvent
        if (queryKey !== null) {
          queryClient.setQueryData(queryKey, (prev: HelmReleaseSummary[] | undefined) =>
            applyHelmWatchEvent(prev, msg),
          )
        }
        onEventRef.current?.(msg)
      } catch (err) {
        console.warn('helm watch parse error', err)
      }
    }

    // backend 가 startSecretWatch 실패 시 보내는 named 'error' 이벤트.
    es.addEventListener('error', (e) => {
      // EventSource 의 onerror 도 같은 핸들러로 들어옴 — readyState 로 구분.
      // CLOSED = 영구 실패 (autoreconnect 안 함). CONNECTING = 일시 끊김.
      if (es.readyState === EventSource.CLOSED) {
        console.warn('helm watch sse closed (permanent)')
        return
      }
      // CONNECTING 은 brower 가 알아서 재시도 — 우리가 할 일 0.
      const errData = (e as MessageEvent).data
      if (errData) {
        console.warn('helm watch sse error frame', errData)
      }
    })

    return () => {
      es.close()
    }
  }, [cluster, namespace, enabled, queryClient, queryKeyDep])
}
