// The dot beside a cluster's name, from the health the registry stores (auth-service: healthy after a good check,
// unreachable after a failed Test) or a Test result just made.
export function healthDotClass(status: string | undefined): string {
  if (status === 'healthy') return 'bg-green-500'
  if (status === 'unreachable' || status === 'unhealthy' || status === 'disconnected') return 'bg-red-500'
  return 'bg-slate-500'
}
