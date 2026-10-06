import { type ReactNode } from 'react'
import { useDetailLabel } from '../useDetailLabel'

export default function ContainerKvRow({ label, children }: { label: string; children: ReactNode }) {
  const dl = useDetailLabel()
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 items-start py-1.5">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{dl(label)}</span>
      <div className="text-xs text-slate-100">{children}</div>
    </div>
  )
}
