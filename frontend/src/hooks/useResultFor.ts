import { useCallback, useState } from 'react'

// A line a screen shows about what it last did — a stream that stopped, a download that failed, a connection test's
// answer — held with the inputs it was about (`inputs`, compared as JSON). It shows while they stay and is gone once
// they change, so it never stands under another container, file or setting. The setter keeps the inputs of the render
// it came from: an answer that arrives after the inputs changed is held for the inputs it was asked with.
export function useResultFor<T>(inputs: unknown): [T | null, (result: T | null) => void] {
  const key = JSON.stringify(inputs)
  const [held, setHeld] = useState<{ key: string; result: T } | null>(null)
  const set = useCallback((result: T | null) => setHeld(result === null ? null : { key, result }), [key])
  return [held !== null && held.key === key ? held.result : null, set]
}
