import { Terminal } from 'lucide-react'
import ContainerKvRow from './ContainerKvRow'
import {
  formatContainerCommand,
  formatContainerSecurityContext,
  formatProbe,
  toEntryPairs,
  toMounts,
  toPorts,
} from './podInfoFormatters'
import { fmtTs } from '../DetailCommon'

interface Props {
  container: any
  index: number
  variant: 'container' | 'init'
  onExec?: (name: string) => void
  canExec?: boolean
  execTooltip?: string
  keyPrefix?: string
}

export default function ContainerCard({
  container: c,
  index: i,
  variant,
  onExec,
  canExec,
  execTooltip,
  keyPrefix,
}: Props) {
  const state = c.state || {}
  const stateKey = Object.keys(state).find(k => state[k]) || 'unknown'
  const stateDetail = state[stateKey] || {}
  const ready = c.ready !== undefined ? c.ready : undefined
  const requests = c.requests ?? c?.resources?.requests
  const limits = c.limits ?? c?.resources?.limits
  const mounts = c.volume_mounts ?? c.volumeMounts
  const envCount = typeof c.env_count === 'number'
    ? c.env_count
    : (Array.isArray(c.env) ? c.env.length : undefined)

  const isContainer = variant === 'container'
  const namePrefix = isContainer ? 'container' : 'init'
  const kp = keyPrefix ?? namePrefix

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white break-words">{c.name || `${namePrefix}-${i + 1}`}</span>
        <div className="flex items-center gap-2">
          {isContainer && canExec && stateKey === 'running' && onExec && (
            <button
              onClick={() => onExec(c.name)}
              className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-emerald-400 transition-colors"
              title={execTooltip}
            >
              <Terminal className="w-3.5 h-3.5" />
            </button>
          )}
          {isContainer && ready !== undefined && (
            <span className={`w-2 h-2 rounded-full ${ready ? 'bg-emerald-400' : 'bg-red-400'}`} />
          )}
          <span className="text-[11px] text-slate-400">{stateKey}</span>
        </div>
      </div>
      <div className="divide-y divide-slate-800/70">
        <ContainerKvRow label="Image">
          <span className="font-mono break-all">{c.image || '-'}</span>
        </ContainerKvRow>
        <ContainerKvRow label="Command">
          <span className="font-mono break-words whitespace-pre-wrap">{formatContainerCommand(c.command, c.args)}</span>
        </ContainerKvRow>
        <ContainerKvRow label="Restarts">
          <span className="font-mono">{String(c.restart_count ?? c.restartCount ?? 0)}</span>
        </ContainerKvRow>
        {stateDetail.reason && (
          <ContainerKvRow label="Reason">
            <span className="text-amber-300 break-words">{stateDetail.reason}</span>
          </ContainerKvRow>
        )}
        {stateDetail.message && (
          <ContainerKvRow label="Message">
            <span className="text-red-300 break-words whitespace-pre-wrap">{stateDetail.message}</span>
          </ContainerKvRow>
        )}
        {isContainer && stateDetail.started_at && (
          <ContainerKvRow label="Started">
            <span className="text-slate-200">{fmtTs(stateDetail.started_at)}</span>
          </ContainerKvRow>
        )}
        {toPorts(c.ports).length > 0 && (
          <ContainerKvRow label="Ports">
            <div className="flex flex-wrap gap-1">
              {toPorts(c.ports).map((port, idx) => (
                <span key={`${port}-${idx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                  {port}
                </span>
              ))}
            </div>
          </ContainerKvRow>
        )}
        {toEntryPairs(requests).length > 0 && (
          <ContainerKvRow label="Requests">
            <div className="flex flex-wrap gap-1">
              {toEntryPairs(requests).map(([k, v]) => (
                <span key={`req-${kp}-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                  {k}={v}
                </span>
              ))}
            </div>
          </ContainerKvRow>
        )}
        {toEntryPairs(limits).length > 0 && (
          <ContainerKvRow label="Limits">
            <div className="flex flex-wrap gap-1">
              {toEntryPairs(limits).map(([k, v]) => (
                <span key={`lim-${kp}-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                  {k}={v}
                </span>
              ))}
            </div>
          </ContainerKvRow>
        )}
        {typeof envCount === 'number' && (
          <ContainerKvRow label="Env">
            <span className="text-slate-200 font-mono">{envCount}</span>
          </ContainerKvRow>
        )}
        {toMounts(mounts).length > 0 && (
          <ContainerKvRow label="Mounts">
            <div className="flex flex-wrap gap-1">
              {toMounts(mounts).map((mount, idx) => (
                <span key={`${mount}-${idx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                  {mount}
                </span>
              ))}
            </div>
          </ContainerKvRow>
        )}
        {formatProbe(c.livenessProbe) && (
          <ContainerKvRow label="Liveness Probe">
            <span className="font-mono break-words">{formatProbe(c.livenessProbe)}</span>
          </ContainerKvRow>
        )}
        {formatProbe(c.readinessProbe) && (
          <ContainerKvRow label="Readiness Probe">
            <span className="font-mono break-words">{formatProbe(c.readinessProbe)}</span>
          </ContainerKvRow>
        )}
        {formatProbe(c.startupProbe) && (
          <ContainerKvRow label="Startup Probe">
            <span className="font-mono break-words">{formatProbe(c.startupProbe)}</span>
          </ContainerKvRow>
        )}
        {formatContainerSecurityContext(c.securityContext).length > 0 && (
          <>
            {formatContainerSecurityContext(c.securityContext).map(([label, val]) => (
              <ContainerKvRow key={`sec-${kp}-${label}`} label={label}>
                <span className="font-mono">{val}</span>
              </ContainerKvRow>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
