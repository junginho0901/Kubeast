import { type ReactNode } from 'react'
import { useDetailLabel } from '../useDetailLabel'

export default function ContainerKvRow({ label, children }: { label: string; children: ReactNode }) {
  const dl = useDetailLabel()
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 items-start py-1.5">
      <span className="text-xs text-slate-400 break-words">{dl(label)}</span>
      <div className="min-w-0 text-sm text-slate-100 break-words">{children}</div>
    </div>
  )
}
