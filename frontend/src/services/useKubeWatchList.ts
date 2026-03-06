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
      queryClient.setQueryData(options.queryKey, (prev: any[] | undefined) =>
        applyWatchEvent(prev, event)
      )
    }

    let cleanup: (() => void) | undefined
    watchMultiplexer.subscribe(msg, handle).then((fn) => {
      cleanup = fn
    })

    return () => {
      cleanup?.()
    }
  }, [options.enabled, options.path, query, JSON.stringify(options.queryKey)])
}
