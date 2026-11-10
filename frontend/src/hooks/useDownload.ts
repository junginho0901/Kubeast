import { useCallback, useRef, useState } from 'react'

import { responseFailure } from '@/utils/failureText'

// A file the server makes and names, taken with one fetch (same origin, the session cookie) instead of a link: a
// refusal is said where it was pressed with the server's reason (ActionFailure 'download'), where a link left it to
// the browser's download bar or opened the error's JSON in the tab. While it comes, `busy` names it and its button
// says so; once it is in, it is saved under the server's name (Content-Disposition) or the one given.
export type DownloadFailure = { key: string; error: unknown }

export function useDownload() {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<DownloadFailure | null>(null)
  const running = useRef(false)
  const start = useCallback(async (key: string, url: string, name: string) => {
    if (running.current) return
    running.current = true
    setBusy(key)
    setFailure(null)
    try {
      const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!res.ok) {
        setFailure({ key, error: await responseFailure(res) })
        return
      }
      saveBlob(await res.blob(), fileNameOf(res.headers.get('Content-Disposition')) ?? name)
    } catch (error) {
      setFailure({ key, error })
    } finally {
      running.current = false
      setBusy(null)
    }
  }, [])
  return { start, busy, failure }
}

// The file name a Content-Disposition gives: RFC 6266's filename* (UTF-8, percent-encoded) first, else filename,
// quoted as Go's %q writes it or bare.
export function fileNameOf(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (star) {
    try { return decodeURIComponent(star[1].trim()) } catch { /* the plain name below */ }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header)
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1')
  const bare = /filename\s*=\s*([^;\s]+)/.exec(header)
  return bare ? bare[1] : null
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // the click hands the file to the browser before the address is let go
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
