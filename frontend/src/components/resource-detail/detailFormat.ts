// Time formatting helpers shared by the resource detail views — the same
// formats as the lists (utils/time): an age as kubectl prints it, an absolute
// time as YYYY-MM-DD HH:mm:ss in the viewer's time zone.
import { formatAge, formatTime } from '@/utils/time'

export const fmtRel = formatAge
export const fmtTs = formatTime
export const fmtPodAge = formatAge
