import type { CustomResourceListFailure } from '@/services/api'

type Tr = (key: string, fallback: string, options?: Record<string, unknown>) => string

export interface CrReadNoticeLine {
  testId: 'cr-instances-forbidden' | 'cr-instances-load-error'
  text: string
  /** each failure's own message, shown on hover */
  title?: string
}

// What the instances screen says about the CRDs it could not list, in the lists' shared words: the kinds the cluster
// refused in one line, the kinds whose list failed otherwise one line per status code.
export function crReadNotice(forbidden: string[] | undefined, failed: CustomResourceListFailure[] | undefined, tr: Tr): CrReadNoticeLine[] {
  const lines: CrReadNoticeLine[] = []
  if (forbidden?.length) {
    lines.push({
      testId: 'cr-instances-forbidden',
      text: tr('common.forbiddenEmpty', 'You do not have permission to view {{resource}} in this cluster.', { resource: forbidden.join(', ') }),
    })
  }
  const byCode = new Map<number, CustomResourceListFailure[]>()
  for (const f of failed ?? []) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f])
  for (const [code, list] of [...byCode].sort((a, b) => a[0] - b[0])) {
    const resource = list.map((f) => f.kind).join(', ')
    lines.push({
      testId: 'cr-instances-load-error',
      text: code
        ? tr('common.loadErrorEmpty', 'Could not load {{resource}} (server error {{code}}).', { resource, code })
        : tr('common.loadErrorEmptyNetwork', 'Could not load {{resource}} (no response from the server).', { resource }),
      title: list.map((f) => `${f.kind}: ${f.error}`).join('\n'),
    })
  }
  return lines
}
