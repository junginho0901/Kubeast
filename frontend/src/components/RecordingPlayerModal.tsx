import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, X } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
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
            <h3 className="text-lg font-semibold text-white">{tr('recordings.player.title', 'Session recording')}</h3>
            {title && <p className="text-xs text-slate-400 truncate">{title}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={recordingDownloadUrl(recordingId)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
              data-testid="recording-download-cast"
            >
              <Download className="w-3.5 h-3.5" /> .cast
            </a>
            <a
              href={recordingTextUrl(recordingId)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
              data-testid="recording-download-text"
            >
              <FileText className="w-3.5 h-3.5" /> {tr('recordings.player.text', 'Text')}
            </a>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label={tr('recordings.player.close', 'Close')}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        {error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : (
          <div ref={holder} className="rounded-lg overflow-hidden bg-black min-h-[200px]" data-testid="recording-player" />
        )}
      </div>
    </ModalOverlay>
  )
}
