import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { ResizeResult } from '@/services/api/types'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { bytesToMiB, cpuToMillis, memoryToBytes } from '@/utils/resourceQuantity'

const inputClass = 'h-10 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 text-sm font-mono text-white focus:border-primary-500 focus:outline-hidden disabled:opacity-50'

interface Props {
  namespace: string
  pod: string
  container: string
  requests?: { cpu?: string; memory?: string }
  onClose: () => void
}

// Pod → container → "Adjust resources": the container's requests on this one running pod, through the same resize
// call the Optimization table uses (kind Pod). The server keeps the QoS class and skips what needs a restart.
export default function ContainerResizeModal({ namespace, pod, container, requests, onClose }: Props) {
  const { t } = useTranslation()
  const tr = (k: string, fb: string, o?: Record<string, unknown>) => t(k, { defaultValue: fb, ...o })
  const queryClient = useQueryClient()
  const currentCpu = cpuToMillis(requests?.cpu)
  const currentMem = bytesToMiB(memoryToBytes(requests?.memory))
  const [cpu, setCpu] = useState(currentCpu === null ? '' : String(currentCpu))
  const [mem, setMem] = useState(currentMem === null ? '' : String(currentMem))
  const [result, setResult] = useState<ResizeResult | null>(null)

  const cpuN = cpu.trim() === '' ? null : Number(cpu)
  const memN = mem.trim() === '' ? null : Number(mem)
  const valid = (v: number | null) => v === null || (Number.isInteger(v) && v > 0)
  const cpuChanged = cpuN !== null && cpuN !== currentCpu
  const memChanged = memN !== null && memN !== currentMem
  const canSubmit = valid(cpuN) && valid(memN) && (cpuChanged || memChanged)

  const resize = useMutation({
    mutationFn: () =>
      api.resizeOptimization(namespace, {
        kind: 'Pod', name: pod, container,
        ...(cpuChanged ? { cpu_request_m: cpuN as number } : {}),
        ...(memChanged ? { mem_request_bytes: (memN as number) * 1024 * 1024 } : {}),
      }),
    onSuccess: (res) => {
      setResult(res)
      queryClient.invalidateQueries({ queryKey: ['pod-describe', namespace, pod] })
    },
  })
  const row = result?.pods[0]
  const errorText = (resize.error as any)?.response?.data?.detail ?? (resize.error as any)?.response?.data?.error ?? (resize.error as Error | null)?.message

  return (
    <ModalFrame
      size="sm"
      title={tr('pods.resize.title', 'Adjust resources')}
      subtitle={`${pod} · ${container}`}
      onClose={onClose}
      busy={resize.isPending}
      testId="pod-resize-modal"
      footer={
        <>
          <button type="button" className={modalButton.cancel} onClick={onClose} data-testid="pod-resize-close">
            {result ? tr('common.close', 'Close') : tr('common.cancel', 'Cancel')}
          </button>
          {!result && (
            <button type="button" className={modalButton.primary} disabled={!canSubmit || resize.isPending} onClick={() => resize.mutate()} data-testid="pod-resize-submit">
              {tr('pods.resize.apply', 'Apply without restart')}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-400">{tr('pods.resize.hint', 'Requests of this container on this pod only; the QoS class is kept and a resource whose policy needs a restart is skipped. The next rollout restores the template values.')}</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-semibold text-slate-400 mb-1">{tr('pods.resize.cpu', 'CPU request (m)')}</span>
            <input className={inputClass} inputMode="numeric" value={cpu} onChange={(e) => setCpu(e.target.value)} disabled={!!result} data-testid="pod-resize-cpu" />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-slate-400 mb-1">{tr('pods.resize.memory', 'Memory request (MiB)')}</span>
            <input className={inputClass} inputMode="numeric" value={mem} onChange={(e) => setMem(e.target.value)} disabled={!!result} data-testid="pod-resize-memory" />
          </label>
        </div>
        {errorText && <p className="text-sm text-red-300" data-testid="pod-resize-error">{errorText}</p>}
        {result && (
          <p className="text-sm text-slate-200" data-testid="pod-resize-result" data-result={row?.result ?? 'error'}>
            {tr(`pods.resize.outcome.${row?.result ?? 'error'}`, row?.result ?? 'error')}
            {row ? (row.reason ? ` — ${row.reason}` : '') : ' — no-pod'}
          </p>
        )}
      </div>
    </ModalFrame>
  )
}
