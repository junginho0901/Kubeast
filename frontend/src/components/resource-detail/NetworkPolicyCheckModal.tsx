import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { api } from '@/services/api'
import type { NetpolCheck, NetpolCheckResult, NetpolSide } from '@/services/api/types'
import CustomDropdown from '@/components/CustomDropdown'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { useAIContext } from '@/hooks/useAIContext'
import { reasonText, resultLabel, ruleName, unevaluatedText, type Tr } from './netpolText'

// The window that asks k8s-service whether NetworkPolicy allows one connection between this pod or
// workload and another end (a pod, a workload, a Service or an address), and shows which policy and
// rule decide.

const KINDS = ['pod', 'deployment', 'statefulset', 'daemonset', 'service', 'ip'] as const
export type OtherKind = (typeof KINDS)[number]
const KIND_LABEL: Record<OtherKind, string> = { pod: 'Pod', deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet', service: 'Service', ip: '' }
const RESULT_BADGE: Record<string, string> = { allowed: 'badge-success', denied: 'badge-error', unknown: 'badge-warning', mixed: 'badge-warning' }
const LABEL = 'block text-xs font-semibold text-slate-400 mb-1'
const INPUT = 'h-10 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 text-sm font-mono text-white focus:border-primary-500 focus:outline-hidden'

async function names(kind: OtherKind, namespace: string): Promise<string[]> {
  const list: { name: string }[] =
    kind === 'pod' ? await api.getPods(namespace)
      : kind === 'deployment' ? await api.getDeployments(namespace)
        : kind === 'statefulset' ? await api.getStatefulSets(namespace)
          : kind === 'daemonset' ? await api.getDaemonSets(namespace)
            : await api.getServices(namespace)
  return list.map((o) => o.name).sort()
}

function SideLine({ title, side, tr }: { title: string; side: NetpolSide; tr: Tr }) {
  let summary: string
  if (!side.isolated) summary = tr('netpolCheck.sideNotIsolated', 'not isolated: allowed')
  else if (side.allowed_by.length > 0) summary = tr('netpolCheck.sideAllowedBy', 'allowed by {{rules}}', { rules: side.allowed_by.map((r) => ruleName(r.policy, r.rule, tr)).join(', ') })
  else summary = tr('netpolCheck.sideIsolatedBy', 'isolated by {{policies}}', { policies: side.policies.join(', ') })
  const details = side.allowed_by.length > 0 ? [] : [...side.undecided, ...side.misses]
  return (
    <div className="text-xs" data-testid="netpol-side">
      <span className="text-slate-400">{title}: </span>
      <span className={`badge ${RESULT_BADGE[side.result]} mr-1.5`}>{resultLabel(side.result, tr)}</span>
      <span className="text-slate-200">{summary}</span>
      {details.length > 0 && (
        <ul className="mt-0.5 ml-3 list-disc list-inside text-slate-400">
          {details.map((m, i) => (
            <li key={i} data-testid="netpol-miss">
              <span className="font-mono text-slate-300">{ruleName(m.policy, m.rule, tr)}</span>: {reasonText(m.reason, tr)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CheckRow({ c, res, tr }: { c: NetpolCheck; res: NetpolCheckResult; tr: Tr }) {
  const src = res.source.name || res.source.ref
  const dst = res.destination.name || res.destination.ref
  return (
    <li className="rounded-sm border border-slate-800 bg-slate-900/60 p-2.5 space-y-1" data-testid="netpol-check-row">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`badge ${RESULT_BADGE[c.result]}`} data-testid="netpol-check-result">{resultLabel(c.result, tr)}</span>
        <span className="font-mono text-slate-200">{c.protocol} {c.port || '-'}</span>
        {c.service_port && <span className="text-slate-400">{tr('netpolCheck.servicePort', 'Service port {{port}}', { port: c.service_port })}</span>}
        {c.pods && c.pods.length > 0 && <span className="text-slate-500 break-all">{tr('netpolCheck.pods', 'pods: {{pods}}', { pods: c.pods.join(', ') })}</span>}
      </div>
      {c.egress && <SideLine title={tr('netpolCheck.outgoingFrom', 'Outgoing from {{name}}', { name: src })} side={c.egress} tr={tr} />}
      {c.ingress && <SideLine title={tr('netpolCheck.incomingTo', 'Incoming to {{name}}', { name: dst })} side={c.ingress} tr={tr} />}
      {c.notes.map((n) => <p key={n} className="text-xs text-amber-300">{reasonText(n, tr)}</p>)}
    </li>
  )
}

// What a flow row fills in (NetworkFlows): the other end, the port and the direction; the check then runs at once.
export interface NetpolCheckInitial {
  outgoing: boolean
  kind: OtherKind
  namespace?: string
  name?: string
  ip?: string
  port?: string
  protocol?: string
}

export default function NetworkPolicyCheckModal({ self, selfName, namespace, onClose, initial }: { self: string; selfName: string; namespace: string; onClose: () => void; initial?: NetpolCheckInitial }) {
  const { t } = useTranslation()
  const tr: Tr = (key, fallback, options) => t(key, { defaultValue: fallback, ...options })
  const [outgoing, setOutgoing] = useState(initial?.outgoing ?? true)
  const [kind, setKind] = useState<OtherKind>(initial?.kind ?? 'pod')
  const [otherNs, setOtherNs] = useState(initial?.namespace ?? namespace)
  const [otherName, setOtherName] = useState(initial?.name ?? '')
  const [ip, setIP] = useState(initial?.ip ?? '')
  const [port, setPort] = useState(initial?.port ?? '')
  const [protocol, setProtocol] = useState(initial?.protocol ?? 'TCP')

  const namespaces = useQuery({ queryKey: ['cluster', 'namespaces', 'names'], queryFn: async () => (await api.getNamespaces()).map((n) => n.name).sort(), retry: false })
  const nameList = useQuery({ queryKey: ['cluster', 'netpol-check-names', kind, otherNs], queryFn: () => names(kind, otherNs), enabled: kind !== 'ip' && !!otherNs, retry: false })
  const check = useMutation({
    mutationFn: () => {
      const other = kind === 'ip' ? ip.trim() : `${kind}/${otherNs}/${otherName}`
      return outgoing ? api.checkNetworkPolicy(self, other, port.trim(), protocol) : api.checkNetworkPolicy(other, self, port.trim(), protocol)
    },
  })
  const kinds = KINDS.filter((k) => outgoing || k !== 'service')
  const ready = kind === 'ip' ? ip.trim() !== '' : otherName !== ''
  // Opened from a flow: the connection is known, so answer it straight away.
  useEffect(() => {
    if (initial) check.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const res = check.data
  const errorText = (check.error as any)?.response?.data?.detail ?? (check.error as any)?.response?.data?.error ?? (check.error as Error | null)?.message
  useAIContext({
    source: 'NetworkPolicyCheckModal',
    summary: `NetworkPolicy 연결 확인 창 — ${self}`,
    data: { action: 'networkpolicy-check', self, result: res ? { result: res.result, source: res.source.ref, destination: res.destination.ref, checks: res.checks, unevaluated: res.unevaluated } : undefined, error: errorText },
  }, [self, res, errorText])

  return (
    <ModalFrame
      title={tr('netpolCheck.title', 'Check a connection')}
      subtitle={tr('netpolCheck.subtitle', 'Whether NetworkPolicy allows it, and which policy and rule decide.')}
      icon={<ShieldCheck className="w-5 h-5 text-primary-400 mt-0.5" />}
      size="lg"
      body="scroll"
      onClose={onClose}
      testId="netpol-check-modal"
      footer={
        <>
          <button type="button" className={modalButton.cancel} onClick={onClose}>{tr('common.close', 'Close')}</button>
          <button type="button" className={modalButton.primary} disabled={!ready || check.isPending} onClick={() => check.mutate()} data-testid="netpol-check-run">
            {check.isPending ? tr('netpolCheck.running', 'Checking…') : tr('netpolCheck.run', 'Check')}
          </button>
        </>
      }
    >
      <div className="px-6 pb-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <CustomDropdown
            label={tr('netpolCheck.direction', 'Direction')}
            value={outgoing ? 'out' : 'in'}
            onChange={(v) => {
              setOutgoing(v === 'out')
              if (v === 'in' && kind === 'service') setKind('pod')
            }}
            options={[
              { value: 'out', label: tr('netpolCheck.directionOut', 'From {{name}} to the other end', { name: selfName }), testId: 'netpol-check-direction-opt-out' },
              { value: 'in', label: tr('netpolCheck.directionIn', 'From the other end to {{name}}', { name: selfName }), testId: 'netpol-check-direction-opt-in' },
            ]}
            testId="netpol-check-direction"
          />
          <CustomDropdown
            label={tr('netpolCheck.otherKind', 'Other end')}
            value={kind}
            onChange={(v) => {
              setKind(v as OtherKind)
              setOtherName('')
            }}
            options={kinds.map((k) => ({ value: k, label: k === 'ip' ? tr('netpolCheck.ipAddress', 'IP address') : KIND_LABEL[k], testId: `netpol-check-kind-opt-${k}` }))}
            testId="netpol-check-kind"
          />
        </div>
        {kind === 'ip' ? (
          <div>
            <label className={LABEL} htmlFor="netpol-check-ip">{tr('netpolCheck.ipAddress', 'IP address')}</label>
            <input id="netpol-check-ip" className={INPUT} value={ip} onChange={(e) => setIP(e.target.value)} placeholder="203.0.113.10" data-testid="netpol-check-ip" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <CustomDropdown
              label="Namespace"
              value={otherNs}
              onChange={(v) => {
                setOtherNs(v)
                setOtherName('')
              }}
              options={(namespaces.data ?? [namespace]).map((n) => ({ value: n, label: n, testId: `netpol-check-namespace-opt-${n}` }))}
              testId="netpol-check-namespace"
            />
            <CustomDropdown
              label={tr('netpolCheck.name', 'Name')}
              value={otherName}
              onChange={setOtherName}
              placeholder={nameList.isLoading ? tr('common.loading', 'Loading...') : tr('netpolCheck.pickName', 'Choose one')}
              options={(nameList.data ?? []).map((n) => ({ value: n, label: n, testId: `netpol-check-name-opt-${n}` }))}
              testId="netpol-check-name"
            />
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={LABEL} htmlFor="netpol-check-port">{tr('netpolCheck.port', 'Port')}</label>
            <input id="netpol-check-port" className={INPUT} value={port} onChange={(e) => setPort(e.target.value)} placeholder={tr('netpolCheck.portPlaceholder', 'Every declared port')} data-testid="netpol-check-port" />
          </div>
          <CustomDropdown
            label={tr('netpolCheck.protocol', 'Protocol')}
            value={protocol}
            onChange={setProtocol}
            options={['TCP', 'UDP', 'SCTP'].map((p) => ({ value: p, label: p, testId: `netpol-check-protocol-opt-${p}` }))}
            testId="netpol-check-protocol"
          />
        </div>

        {errorText && <p className="text-xs text-red-300 break-words" data-testid="netpol-check-error">{errorText}</p>}
        {res && (
          <div className="space-y-2" data-testid="netpol-check-answer">
            <div className="flex items-center gap-2 text-sm">
              <span className={`badge ${RESULT_BADGE[res.result]}`} data-testid="netpol-check-overall">{resultLabel(res.result, tr)}</span>
              <span className="text-slate-300 font-mono break-all">{res.source.ref} → {res.destination.ref}</span>
            </div>
            <ul className="space-y-2">{res.checks.map((c, i) => <CheckRow key={i} c={c} res={res} tr={tr} />)}</ul>
            {res.notes.map((n) => <p key={n} className="text-xs text-amber-300" data-testid="netpol-check-note">{reasonText(n, tr)}</p>)}
            {[res.source, res.destination].filter((e) => e.namespace && !e.namespace_labels_known).map((e) => (
              <p key={e.ref} className="text-xs text-amber-300">{tr('netpolCheck.labelsUnknown', 'The labels of namespace {{namespace}} could not be read with your permissions.', { namespace: e.namespace })}</p>
            ))}
            {res.truncated && <p className="text-xs text-slate-400">{tr('netpolCheck.truncated', 'Only the first 50 pods were read.')}</p>}
            {res.unevaluated.length > 0 && (
              <p className="text-xs text-amber-300" data-testid="netpol-check-unevaluated">
                {tr('netpolCheck.unevaluatedCheck', 'Not part of this check: {{list}}. These can also allow or block the connection.', { list: unevaluatedText(res.unevaluated, tr) })}
              </p>
            )}
          </div>
        )}
      </div>
    </ModalFrame>
  )
}
