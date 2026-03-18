import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { handleUnauthorized, getAccessToken } from '@/services/auth'

interface NodeShellTerminalProps {
  nodeName: string
  namespace?: string
  image?: string
  onClose: () => void
  title?: string
}

const buildWsUrl = (path: string, params?: Record<string, string>) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const rawWsBase = (import.meta.env.VITE_WS_URL || '').trim()
  let wsBase = rawWsBase
  if (wsBase && wsBase.startsWith('http')) {
    wsBase = wsBase.replace(/^http/, 'ws')
  }
  if (!wsBase) {
    wsBase = `${protocol}//${window.location.host}`
  }
  wsBase = wsBase.replace(/\/$/, '')
  const query = params ? `?${new URLSearchParams(params).toString()}` : ''
  return `${wsBase}${path}${query}`
}

export default function NodeShellTerminal({ nodeName, namespace, image, onClose, title }: NodeShellTerminalProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      theme: {
        background: '#0b1220',
        foreground: '#e2e8f0',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    if (containerRef.current) {
      term.open(containerRef.current)
      fit.fit()
    }

    term.writeln(t('nodes.shell.connectingTo', 'Connecting to {{node}}...', { node: nodeName }))

    const token = getAccessToken()
    const wsUrl = buildWsUrl(`/api/v1/cluster/nodes/${nodeName}/debug-shell/ws`, {
      ...(namespace ? { namespace } : {}),
      ...(image ? { image } : {}),
      ...(token ? { token } : {}),
    })
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const decoder = new TextDecoder()

    ws.onopen = () => {
      setStatus('connected')
      term.writeln(t('nodes.shell.connected', 'Connected.'))
      term.focus()
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.writeln(event.data)
        return
      }
      const buffer = new Uint8Array(event.data)
      if (buffer.length === 0) return
      const channel = buffer[0]
      const payload = buffer.slice(1)
      const text = decoder.decode(payload)
      if (channel === 1 || channel === 2) {
        term.write(text)
      } else if (channel === 3) {
        term.writeln(text)
      }
    }

    ws.onerror = () => {
      setStatus('error')
      term.writeln(t('nodes.shell.connectionError', 'Connection error.'))
    }

    ws.onclose = (event) => {
      if (event.code === 1008) {
        handleUnauthorized()
      }
      term.writeln(t('nodes.shell.disconnected', 'Disconnected.'))
    }

    const disposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    const handleResize = () => fit.fit()
    window.addEventListener('resize', handleResize)

    termRef.current = term
    fitRef.current = fit

    return () => {
      window.removeEventListener('resize', handleResize)
      disposable.dispose()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.send('exit\r')
        } catch {}
        ws.close()
      }
      term.dispose()
    }
  }, [nodeName])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2">
        <div>
          <p className="text-sm font-semibold text-white">
            {title || t('nodes.shell.title', 'Shell: {{node}}', { node: nodeName })}
          </p>
          <p className="text-xs text-slate-400">
            {status === 'connecting'
              ? t('nodes.shell.statusConnecting', 'Connecting...')
              : status === 'connected'
                ? t('nodes.shell.statusConnected', 'Connected')
                : t('nodes.shell.statusError', 'Connection error')}
          </p>
        </div>
        <button
          type="button"
          className="text-slate-400 hover:text-white"
          onClick={() => {
            try {
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send('exit\r')
              }
            } catch {}
            onClose()
          }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 bg-slate-950" ref={containerRef} />
    </div>
  )
}
