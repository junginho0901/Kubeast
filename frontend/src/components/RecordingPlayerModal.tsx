import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, Loader2, X } from 'lucide-react'

import { ActionFailure } from '@/components/ActionFailure'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useDownload } from '@/hooks/useDownload'
import { recordingCastUrl, recordingDownloadUrl, recordingTextUrl } from '@/services/api/recordings'

// Replays a terminal session recording (asciicast) in the browser. The player
// is loaded on demand so it stays out of the main bundle. Opening the modal
// reads the recording, which the server audits (admin.session.read).

interface Props {
  recordingId: string
  title?: string
  onClose: () => void
}

type PlayerHandle = { dispose: () => void }

export default function RecordingPlayerModal({ recordingId, title, onClose }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const holder = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  // the .cast and the text are taken as files with one fetch each: a refusal says why in the window, not in a tab
  // that the error's JSON would open
  const { start: startDownload, busy: downloading, failure: downloadFailure } = useDownload()

  useEffect(() => {
    let player: PlayerHandle | null = null
    let cancelled = false
    ;(async () => {
      try {
        const [lib] = await Promise.all([import('asciinema-player'), import('asciinema-player/dist/bundle/asciinema-player.css')])
        if (cancelled || !holder.current) return
        player = lib.create({ url: recordingCastUrl(recordingId), fetchOpts: { credentials: 'same-origin' } }, holder.current, {
          autoPlay: true,
          fit: 'width',
          terminalFontSize: '13px',
          idleTimeLimit: 2,
          theme: 'monokai',
        })
      } catch (e: any) {
        setError(e?.message || 'player failed to load')
      }
    })()
    return () => {
      cancelled = true
      player?.dispose()
    }
  }, [recordingId])

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="w-full max-w-5xl rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={tr('recordings.player.title', 'Session recording')}
        data-testid="recording-player-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-ink">{tr('recordings.player.title', 'Session recording')}</h3>
            {title && <p className="text-xs text-slate-400 truncate">{title}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void startDownload('cast', recordingDownloadUrl(recordingId), `${recordingId}.cast`)}
              disabled={!!downloading}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              data-testid="recording-download-cast"
            >
              {downloading === 'cast' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {downloading === 'cast' ? tr('common.downloading', 'Downloading...') : '.cast'}
            </button>
            <button
              type="button"
              onClick={() => void startDownload('text', recordingTextUrl(recordingId), `${recordingId}.txt`)}
              disabled={!!downloading}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              data-testid="recording-download-text"
            >
              {downloading === 'text' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              {downloading === 'text' ? tr('common.downloading', 'Downloading...') : tr('recordings.player.text', 'Text')}
            </button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-ink" aria-label={tr('recordings.player.close', 'Close')}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <ActionFailure error={downloadFailure?.error} action="download" testId="recording-download-failed" className="mb-3" />
        {error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : (
          <div ref={holder} className="rounded-lg overflow-hidden bg-black min-h-[200px]" data-testid="recording-player" />
        )}
      </div>
    </ModalOverlay>
  )
}
