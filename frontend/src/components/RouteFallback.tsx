import { Loader2 } from 'lucide-react'

// Shown while a lazily loaded route chunk is fetched.
export default function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" data-testid="route-loading">
      <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
    </div>
  )
}
