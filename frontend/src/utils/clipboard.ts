// Copies text: the Clipboard API, else — a page over http, a refused permission — a hidden textarea and
// execCommand('copy'). True only when one of them said it copied, so a button shows "Copied" only then. The
// textarea goes inside the window the button is in (a modal keeps focus inside itself), is removed whatever
// happens, and focus goes back to the button.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // the fallback below
  }
  let area: HTMLTextAreaElement | null = null
  const before = document.activeElement as HTMLElement | null
  try {
    area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    const host = before?.closest?.('[role="dialog"], [aria-modal="true"]') ?? document.body
    host.appendChild(area)
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area?.remove()
    before?.focus?.()
  }
}
