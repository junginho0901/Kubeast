// Display helpers for access requests (admin page and the account section).

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes % 60 === 0) return `${minutes / 60} h`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export { formatTime as formatWhen } from '@/utils/time'
