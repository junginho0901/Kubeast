import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Copy, Check, ShieldCheck, Container } from 'lucide-react'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  KeyValueTags,
  EventsTable,
  fmtRel,
  fmtTs,
} from './DetailCommon'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function SecretInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const { data: describe, isLoading } = useQuery({
    queryKey: ['secret-describe', namespace, name],
    queryFn: () => api.describeSecret(namespace, name),
    enabled: !!namespace && !!name,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const secretType = (describe?.type as string | undefined) ?? (rawJson?.type as string | undefined) ?? '-'
  const dataKeys = Array.isArray(describe?.data_keys) ? describe.data_keys as string[] : []
  const dataSizes = (describe?.data_sizes as Record<string, number> | undefined) ?? {}
  const dataValues = (describe?.data_values as Record<string, string> | undefined) ?? {}
  const canReveal = describe?.can_reveal === true
  const immutable = describe?.immutable as boolean | undefined
  const ownerRefs = Array.isArray(describe?.owner_references) ? describe.owner_references as Array<{ kind: string; name: string; uid: string }> : []
  const events = Array.isArray(describe?.events) ? describe.events : []

  const [dataSearch, setDataSearch] = useState('')
  const [dataPage, setDataPage] = useState(1)
  const DATA_PER_PAGE = 10

  const filteredDataKeys = useMemo(() => {
    if (!dataSearch.trim()) return dataKeys
    const q = dataSearch.toLowerCase()
    return dataKeys.filter((k: string) => k.toLowerCase().includes(q))
  }, [dataKeys, dataSearch])

  const pagedDataKeys = useMemo(() => {
    const start = (dataPage - 1) * DATA_PER_PAGE
    return filteredDataKeys.slice(start, start + DATA_PER_PAGE)
  }, [filteredDataKeys, dataPage])

  const dataTotalPages = Math.max(1, Math.ceil(filteredDataKeys.length / DATA_PER_PAGE))

  const tlsInfo = useMemo(() => {
    if (secretType !== 'kubernetes.io/tls') return null
    try {
      const certB64 = dataValues['tls.crt']
      const keyB64 = dataValues['tls.key']
      const certSize = dataSizes['tls.crt']
      const keySize = dataSizes['tls.key']
      let pemText: string | null = null
      if (certB64) {
        try { pemText = window.atob(certB64) } catch { /* not valid base64 */ }
      }
      const isPem = pemText?.includes('-----BEGIN CERTIFICATE-----') ?? false
      return { certSize, keySize, isPem, hasCert: !!certB64, hasKey: !!keyB64 }
    } catch {
      return null
    }
  }, [secretType, dataValues, dataSizes])

  const dockerInfo = useMemo(() => {
    if (secretType !== 'kubernetes.io/dockerconfigjson') return null
    try {
      const raw = dataValues['.dockerconfigjson']
      if (!raw) return null
      const decoded = window.atob(raw)
      const parsed = JSON.parse(decoded) as { auths?: Record<string, { username?: string }> }
      if (!parsed.auths) return null
      const registries = Object.entries(parsed.auths).map(([url, auth]) => ({
        url,
        username: auth?.username,
      }))
      return { registries }
    } catch {
      return null
    }
  }, [secretType, dataValues])

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <InfoSection title={tr('secretInfo.basicInfo', 'Basic Info')}>
        <div className="space-y-2">
          <InfoRow label="Kind" value="Secret" />
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label={tr('secretInfo.type', 'Type')} value={
            <span className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] font-mono">
              {secretType}
            </span>
          } />
          <InfoRow label={tr('secretInfo.created', 'Created')} value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
          {immutable !== undefined && (
            <InfoRow label={tr('secretInfo.immutable', 'Immutable')} value={
              <span className={`badge ${immutable ? 'badge-warning' : 'badge-info'}`}>{immutable ? 'Yes' : 'No'}</span>
            } />
          )}
          <InfoRow label={tr('secretInfo.dataKeys', 'Data Keys')} value={String(describe?.data_count ?? dataKeys.length)} />
        </div>
      </InfoSection>

      {tlsInfo && (
        <InfoSection title={tr('secretInfo.tlsCertInfo', 'TLS Certificate Info')}>
          <div className="space-y-2">
            <InfoRow label={tr('secretInfo.type', 'Type')} value={
              <span className="inline-flex items-center gap-1.5 rounded border border-emerald-700/50 bg-emerald-900/30 px-2 py-0.5 text-[11px] font-mono text-emerald-300">
                <ShieldCheck className="w-3 h-3" /> TLS
              </span>
            } />
            <InfoRow label="tls.crt" value={
              <span className="text-xs text-slate-300">
                {tlsInfo.hasCert ? (
                  <>
                    {tlsInfo.certSize !== undefined && <span className="font-mono">{tlsInfo.certSize} bytes</span>}
                    {tlsInfo.isPem && <span className="ml-2 text-[10px] text-emerald-400/80">(PEM format)</span>}
                  </>
                ) : <span className="text-slate-500 italic">not present</span>}
              </span>
            } />
            <InfoRow label="tls.key" value={
              <span className="text-xs text-slate-300">
                {tlsInfo.hasKey ? (
                  tlsInfo.keySize !== undefined ? <span className="font-mono">{tlsInfo.keySize} bytes</span> : <span>present</span>
                ) : <span className="text-slate-500 italic">not present</span>}
              </span>
            } />
            <div className="mt-1 px-1">
              <p className="text-[10px] text-slate-500 italic">
                {tr('secretInfo.tlsHint', 'Use `openssl x509 -in tls.crt -text -noout` for full certificate details.')}
              </p>
            </div>
          </div>
        </InfoSection>
      )}

      {dockerInfo && dockerInfo.registries.length > 0 && (
        <InfoSection title={tr('secretInfo.dockerConfigInfo', 'Docker Registry Info')}>
          <div className="space-y-2">
            <InfoRow label={tr('secretInfo.type', 'Type')} value={
              <span className="inline-flex items-center gap-1.5 rounded border border-blue-700/50 bg-blue-900/30 px-2 py-0.5 text-[11px] font-mono text-blue-300">
                <Container className="w-3 h-3" /> Docker Config
              </span>
            } />
            <InfoRow label={tr('secretInfo.registries', 'Registries')} value={
              <div className="space-y-1">
                {dockerInfo.registries.map((reg) => (
                  <div key={reg.url} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-cyan-300 break-all">{reg.url}</span>
                    {reg.username && (
                      <span className="text-[10px] text-slate-400">
                        ({tr('secretInfo.user', 'user')}: <span className="font-mono text-slate-300">{reg.username}</span>)
                      </span>
                    )}
                  </div>
                ))}
              </div>
            } />
          </div>
        </InfoSection>
      )}

      <InfoSection title={`${tr('secretInfo.data', 'Data')} (${filteredDataKeys.length}${dataSearch ? ` / ${dataKeys.length}` : ''})`}>
        {!canReveal && (
          <p className="text-[11px] text-amber-400/80 mb-2">{tr('secretInfo.maskedHint', 'Values are hidden for read-only users.')}</p>
        )}

        {dataKeys.length > DATA_PER_PAGE && (
          <div className="mb-2">
            <input
              type="text"
              placeholder={tr('secretInfo.searchKeys', 'Search keys...')}
              value={dataSearch}
              onChange={(e) => { setDataSearch(e.target.value); setDataPage(1) }}
              className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>
        )}

        {pagedDataKeys.length > 0 ? (
          <div className="space-y-1">
            {pagedDataKeys.map((key: string) => (
              <SecretDataRow
                key={key}
                dataKey={key}
                size={dataSizes[key]}
                value={dataValues[key]}
                canReveal={canReveal}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">{dataSearch ? tr('secretInfo.noMatchingKeys', 'No matching keys.') : tr('secretInfo.noData', 'No data entries.')}</p>
        )}

        {filteredDataKeys.length > DATA_PER_PAGE && (
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-slate-500">{dataPage} / {dataTotalPages}</span>
            <div className="flex gap-1">
              <button type="button" onClick={() => setDataPage((p) => Math.max(1, p - 1))} disabled={dataPage <= 1} className="px-2 py-0.5 text-[10px] rounded border border-slate-700 text-slate-400 disabled:opacity-40">Prev</button>
              <button type="button" onClick={() => setDataPage((p) => Math.min(dataTotalPages, p + 1))} disabled={dataPage >= dataTotalPages} className="px-2 py-0.5 text-[10px] rounded border border-slate-700 text-slate-400 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </InfoSection>

      {ownerRefs.length > 0 && (
        <InfoSection title={tr('secretInfo.ownerReferences', 'Owner References')}>
          <div className="space-y-1">
            {ownerRefs.map((ref) => (
              <div key={ref.uid} className="flex items-center gap-2 text-xs">
                <span className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-slate-300">{ref.kind}</span>
                <span className="text-white font-medium">{ref.name}</span>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && (
        <InfoSection title="Labels">
          <KeyValueTags data={labels} />
        </InfoSection>
      )}

      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}

      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events} />
        </InfoSection>
      )}
    </div>
  )
}

function SecretDataRow({ dataKey, size, value, canReveal }: { dataKey: string; size?: number; value?: string; canReveal: boolean }) {
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const sizeStr = size !== undefined ? `${size} bytes` : ''

  const handleCopy = async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-mono text-xs text-cyan-300 break-all">{dataKey}</span>
          {sizeStr && <span className="text-[10px] text-slate-500 flex-shrink-0">{sizeStr}</span>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          {!canReveal ? (
            <span className="font-mono text-xs text-slate-500">{'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}</span>
          ) : (
            <>
              {!visible && (
                <span className="font-mono text-xs text-slate-400">{'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}</span>
              )}
              <button
                type="button"
                onClick={() => setVisible((v) => !v)}
                className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                title={visible ? 'Hide' : 'Show'}
              >
                {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              {canReveal && value && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                  title="Copy value"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {visible && canReveal && value !== undefined && (
        <div className="px-3 pb-2 border-t border-slate-800">
          <pre className="text-[11px] text-slate-300 whitespace-pre-wrap break-words mt-1.5 max-h-[200px] overflow-y-auto font-mono">
            {value || <span className="text-slate-600 italic">{'(empty)'}</span>}
          </pre>
        </div>
      )}
    </div>
  )
}
