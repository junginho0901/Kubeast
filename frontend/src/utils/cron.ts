import { Cron } from 'croner'

// When a CronJob schedule fires next, read the way Kubernetes reads it: five
// fields or a macro (@hourly …), day-of-month OR day-of-week when both are set,
// in spec.timeZone. Without a time zone the controller uses the
// kube-controller-manager's zone, which a browser cannot know — the browser's
// zone stands in and the screen says so.
export function nextCronRun(schedule: string | null | undefined, timeZone?: string | null, from: Date = new Date()): Date | null {
  if (!schedule?.trim()) return null
  try {
    const job = new Cron(schedule.trim(), { timezone: timeZone || undefined, paused: true })
    const next = job.nextRun(from)
    job.stop()
    return next ?? null
  } catch {
    return null
  }
}
