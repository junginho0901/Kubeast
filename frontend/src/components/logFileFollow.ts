// What a followed log file does with its event stream (LogFilesView). Lines and notices go on screen; the server's
// "end", its error event or the session's end stop following. A dropped connection (the server going away in an
// upgrade, a network cut) does not: the browser connects again after the server's retry time and sends the mark of
// the last line it got (Last-Event-ID), from which k8s-service goes on. The mark comes after each batch of lines, so a
// cut in the middle of a batch (a proxy, the network) shows again the lines of that batch the browser already had; a
// server that leaves ends between batches and repeats none. Each reconnect is its own audited read, its row saying
// where it went on from. A stream refused at the account's cap (the event `stream-limit`) stops too.
import { SESSION_ENDED_EVENT } from '@/services/auth'
import { STREAM_LIMIT_EVENT } from '@/utils/serverShutdown'

// EventSource.CONNECTING, which the tests' stand-in has no class for.
export const SOURCE_CONNECTING = 0

export interface FollowSource {
  readyState: number
  onopen: ((e: Event) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  addEventListener(type: string, listener: (e: Event) => void): void
  close(): void
}

export type FollowStop = { kind: 'end' } | { kind: 'session'; code: string } | { kind: 'limit' } | { kind: 'error'; reason?: string }

export interface FollowHandlers {
  line(text: string): void
  notice(text: string): void
  reconnecting(on: boolean): void
  stopped(why: FollowStop): void
}

export function followLogFile(es: FollowSource, h: FollowHandlers): void {
  es.onopen = () => h.reconnecting(false)
  es.onmessage = (e) => h.line(e.data)
  es.addEventListener('notice', (e) => h.notice((e as MessageEvent).data))
  es.addEventListener('end', () => {
    es.close()
    h.reconnecting(false)
    h.stopped({ kind: 'end' })
  })
  es.addEventListener(SESSION_ENDED_EVENT, (e) => {
    es.close()
    h.reconnecting(false)
    h.stopped({ kind: 'session', code: (e as MessageEvent).data })
  })
  es.addEventListener(STREAM_LIMIT_EVENT, () => {
    es.close()
    h.reconnecting(false)
    h.stopped({ kind: 'limit' })
  })
  es.addEventListener('error', (e) => {
    const reason = (e as MessageEvent).data as string | undefined
    if (!reason && es.readyState === SOURCE_CONNECTING) {
      h.reconnecting(true)
      return
    }
    es.close()
    h.reconnecting(false)
    h.stopped({ kind: 'error', reason: reason || undefined })
  })
}
