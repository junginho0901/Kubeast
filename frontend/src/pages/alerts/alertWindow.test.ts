import { describe, expect, it } from 'vitest'
import source from './AlertInbox.tsx?raw'

// The alert window follows ?alert=, which back, forward and a link change while it is open. Each alert gets a window of
// its own, so a note being typed, the report and silence windows and a save under way do not carry over to the next
// alert (alert-inbox.spec.ts moves the window with a note typed).
describe('the alert window', () => {
  it('is one window per alert', () => {
    expect(source).toMatch(/<AlertDetailModal key=\{openId\} id=\{openId\}/)
  })

  it('writes a save\'s or an investigation\'s answer to the alert it was asked for, not the one open when it comes', () => {
    expect(source).toContain('mutationFn: ({ alert, marks }: { alert: string; marks: AlertInboxMarks }) => api.setAlertInboxMarks(alert, marks),')
    expect(source).toContain('mutationFn: (alert: string) => api.investigateAlertInboxItem(alert),')
    expect(source.match(/queryClient\.setQueryData\(\['alert-inbox', 'one', alert\], fresh\)/g)).toHaveLength(2)
    expect(source).not.toContain("setQueryData(['alert-inbox', 'one', id]")
    for (const call of source.match(/save\.mutate\([^)]*\)/g) ?? []) expect(call).toContain('alert: id')
    expect(source).toContain('start.mutate(id)')
  })
})
