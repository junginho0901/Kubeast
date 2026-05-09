import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { watchMultiplexer } from './watchMultiplexer'

type WatchEvent = {
  type?: string
  object?: any
}

const applyWatchEvent = (prev: any[] | undefined, event: WatchEvent) => {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const name = obj?.name || obj?.metadata?.name
  const namespace = obj?.namespace || obj?.metadata?.namespace
  if (!name) return items

  const key = namespace ? `${namespace}/${name}` : name
  const index = items.findIndex((item) => {
    const itemName = item?.name || item?.metadata?.name
    const itemNs = item?.namespace || item?.metadata?.namespace
    const itemKey = itemNs ? `${itemNs}/${itemName}` : itemName
    return itemKey === key
  })

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) {
    items[index] = obj
  } else {
    items.push(obj)
  }

  return items
}

export function useKubeWatchList(options: {
  enabled: boolean
  queryKey: any[]
  path: string
  query?: string
  applyEvent?: (prev: any[] | undefined, event: WatchEvent) => any[]
  onEvent?: (event: WatchEvent) => void
}) {
  const queryClient = useQueryClient()
  const query = options.query ?? 'watch=1'

  useEffect(() => {
    if (!options.enabled) return

    const msg = {
      type: 'REQUEST' as const,
      clusterId: 'default',
      path: options.path,
      query,
    }

    const handle = (message: any) => {
      if (message?.type !== 'DATA') return
      const event = message?.data as WatchEvent
      queryClient.setQueryData(options.queryKey, (prev: any[] | undefined) => {
        // list 가 도착하기 전 (prev=undefined) 의 watch event 는 무시.
        // K8s watch with resourceVersion="" 는 LIST 의 모든 item 을 ADDED
        // event 로 stream 하는데, list 응답보다 일부 event 가 먼저 도착하면
        // setQueryData 가 빈 prev → 부분 array 를 만들어 useQuery 의 list
        // 응답을 race 로 덮어쓰거나 partial render 발생. list 가 정상적으로
        // 도착하면 그 시점부터의 watch event 만 apply 해야 정합성 유지.
        if (prev === undefined) return undefined
        return (options.applyEvent ?? applyWatchEvent)(prev, event)
      })
      options.onEvent?.(event)
    }

    let cleanup: (() => void) | undefined
    watchMultiplexer.subscribe(msg, handle).then((fn) => {
      cleanup = fn
    })

    return () => {
      cleanup?.()
    }
  }, [
    options.enabled,
    options.path,
    query,
    options.applyEvent,
    options.onEvent,
    JSON.stringify(options.queryKey),
  ])
}
