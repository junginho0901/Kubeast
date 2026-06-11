import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { handleUnauthorized, getAccessToken } from '@/services/auth'
import { getCurrentClusterID } from '@/services/clusterRef'

/*
 * FUTURE — exec session audit log persistence.
 *
 * Today exec output is wired directly between the kubelet WS and xterm.js;
 * nothing is persisted. Operators have asked us to record exec sessions to
 * an audit DB so post-hoc forensics is possible (who ran what command in
 * which pod, when, and what came back).
 *
 * Implementation sketch (out of scope for this PR — see refactor-plan.md
 * Out-of-Scope #4):
 *   - new DB table `pod_exec_sessions` (id, actor, pod, namespace, container,
 *     command, started_at, ended_at) + `pod_exec_chunks` (session_id, ts,
 *     direction, payload_bytes)
 *   - audit_writer.go gains a streaming writer used by the ws handler in
 *     k8s-service exec.go to mirror stdout/stderr (caps payload + sampling
 *     to keep DB bounded)
 *   - frontend captures input keystrokes (already on `term.onData`) and
 *     POSTs them alongside session start/end markers so the audit log can
 *     be replayed deterministically
 *   - admin UI page to list & replay sessions
 *
 * Skipping in this drop because it spans DB migration + new service code +
 * UI page, which is too large for a single agent run.
 */

interface PodExecTerminalProps {
  podName: string
  namespace: string
  container: string
  command?: string
  onClose: () => void
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

export default function PodExecTerminal({ podName, namespace, container, command = '/bin/sh', onClose }: PodExecTerminalProps) {
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

    term.writeln(t('pods.exec.connectingTo', {
      defaultValue: 'Connecting to {{pod}}/{{container}}...',
      pod: podName,
      container,
    }))

    const token = getAccessToken()
    const clusterId = getCurrentClusterID()
    const wsUrl = buildWsUrl(
      `/api/v1/cluster/namespaces/${namespace}/pods/${podName}/exec/ws`,
      {
        container,
        command,
        ...(clusterId ? { cluster: clusterId } : {}),
        ...(token ? { token } : {}),
      }
    )
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const decoder = new TextDecoder()

    ws.onopen = () => {
      setStatus('connected')
      term.writeln(t('pods.exec.connected', { defaultValue: 'Connected.' }))
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
      term.writeln(t('pods.exec.connectionError', { defaultValue: 'Connection error.' }))
    }

    ws.onclose = (event) => {
      if (event.code === 1008) {
        handleUnauthorized()
      }
      term.writeln(t('pods.exec.disconnected', { defaultValue: 'Disconnected.' }))
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
  }, [podName, namespace, container, command])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2">
        <div>
          <p className="text-sm font-semibold text-white">
            {t('pods.exec.title', {
              defaultValue: 'Exec: {{pod}} / {{container}}',
              pod: podName,
              container,
            })}
          </p>
          <p className="text-xs text-slate-400">
            {status === 'connecting'
              ? t('pods.exec.statusConnecting', { defaultValue: 'Connecting...' })
              : status === 'connected'
                ? t('pods.exec.statusConnected', { defaultValue: 'Connected' })
                : t('pods.exec.statusError', { defaultValue: 'Connection error' })}
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
