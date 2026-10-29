import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useSearchParams } from 'react-router-dom'

/** The address's parameters with the namespace chosen; 'all' (or none) drops ?namespace=, the rest stays. */
export function withNamespace(prev: URLSearchParams, value: SetStateAction<string>): URLSearchParams {
  const next = new URLSearchParams(prev)
  const namespace = typeof value === 'function' ? value(prev.get('namespace') || 'all') : value
  if (!namespace || namespace === 'all') next.delete('namespace')
  else next.set('namespace', namespace)
  return next
}

// The namespace a list page shows, kept in the address as ?namespace= so a link or a reload opens the same one;
// 'all' (no parameter) is every namespace. Other parameters (cluster, detail) stay as they are.
export function useNamespaceParam(): [string, Dispatch<SetStateAction<string>>] {
  const [params, setParams] = useSearchParams()
  const selected = params.get('namespace') || 'all'
  const select = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => setParams((prev) => withNamespace(prev, value), { replace: true }),
    [setParams],
  )
  return [selected, select]
}
