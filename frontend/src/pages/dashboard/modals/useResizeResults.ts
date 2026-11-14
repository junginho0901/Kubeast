import { useState } from 'react'

// The Optimization window's "Apply without restart" results, by row: a result is of the rows it was applied to while
// the window was open on their namespace, so another namespace, or the window opened again, starts with none (the
// window stays mounted while closed).
export function useResizeResults<T>(open: boolean, namespace: string): [Record<string, T>, (next: (results: Record<string, T>) => Record<string, T>) => void] {
  const [results, setResults] = useState<Record<string, T>>({})
  const [resultsOf, setResultsOf] = useState({ open, namespace })
  const other = resultsOf.open !== open || resultsOf.namespace !== namespace
  if (other) {
    setResultsOf({ open, namespace })
    setResults({})
  }
  return [other ? {} : results, setResults]
}
