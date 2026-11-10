import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Copy, Check, ShieldCheck, Container, X } from 'lucide-react'
import { copyText } from '@/utils/clipboard'
import { api } from '@/services/api'
import type { ServiceAccountInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { applyServiceAccountWatchEvent } from '@/pages/security/serviceaccounts/serviceAccountWatchNormalize'
import { InfoSection, InfoRow, KeyValueTags, EventsSection, StatusBadge, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { useDetailLabel } from './useDetailLabel'
import { usePagination } from './usePagination'
import { ResourceLink } from './ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { podTableStatus } from '@/pages/workloads/pods/podHelpers'
import { secretDescribeForAI } from './secretDescribeForAI'
import { useDrawerFollowsObject } from './useDrawerFollowsObject'
import { useNamespacePodTable } from './useNamespacePodTable'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function SecretInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const { open: openDetail } = useResourceDetail()

  const enabled = !!namespace && !!name

  const usingPods = useNamespacePodTable({
    enabled,
    namespace,
    filter: { secret: name },
    queryKey: ['secret-used-by-pods', namespace, name],
    keeps: (p) => (Array.isArray(p?.secret_refs) ? p.secret_refs : []).includes(name),
  })

  const { data: nsSAs } = useQuery({
    queryKey: ['secret-used-by-sas', namespace, name],
    queryFn: () => api.getServiceAccounts(namespace),
    enabled,
    staleTime: 5_000,
  })
  useKubeWatchList({
    enabled,
    queryKey: ['secret-used-by-sas', namespace, name],
    path: `/api/v1/namespaces/${namespace}/serviceaccounts`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyServiceAccountWatchEvent(prev as ServiceAccountInfo[] | undefined, event),
  })

  const usingSAs =(Array.isArray(nsSAs) ? nsSAs : []).filter((sa: any) => {
    const refs = [
      ...(Array.isArray(sa?.secrets_list) ? sa.secrets_list : []),
      ...(Array.isArray(sa?.image_pull_secrets) ? sa.image_pull_secrets : []),
    ]
    return refs.includes(name)
  })
  const { items: pagedUsingSAs, nav: usingSAsNav } = usePagination(usingSAs, 10)

  const { data: describe, isLoading } = useQuery({
    queryKey: ['secret-describe', namespace, name],
    queryFn: () => api.describeSecret(namespace, name),
    enabled: !!namespace && !!name,
    retry: false,
  })
  // Its object is not read every ten seconds as the others' are: that read is an audited reveal.
  useDrawerFollowsObject({
    enabled: !!describe,
    describeKey: ['secret-describe', namespace, name],
    path: `/api/v1/namespaces/${namespace}/secrets`,
    name,
  })

  useResourceDetailOverlay({ kind: 'Secret', name, namespace, describe: secretDescribeForAI(describe) })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const secretType = (describe?.type as string | undefined) ?? (rawJson?.type as string | undefined) ?? '-'
  const dataKeys = useMemo(
    () => (Array.isArray(describe?.data_keys) ? (describe.data_keys as string[]) : []),
    [describe?.data_keys],
  )
  const dataSizes = useMemo(
    () => (describe?.data_sizes as Record<string, number> | undefined) ?? {},
    [describe?.data_sizes],
  )
  const dataValues = useMemo(
    () => (describe?.data_values as Record<string, string> | undefined) ?? {},
    [describe?.data_values],
  )
  const canReveal = describe?.can_reveal === true
  const immutable = describe?.immutable as boolean | undefined
  const ownerRefs = Array.isArray(describe?.owner_references) ? describe.owner_references as Array<{ kind: string; name: string; uid: string }> : []

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
            <span className="inline-flex rounded-sm border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] font-mono">
              {secretType}
            </span>
          } />
          <InfoRow label={tr('secretInfo.created', 'Created')} value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
          {immutable !== undefined && (
            <InfoRow label={tr('secretInfo.immutable', 'Immutable')} value={immutable ? 'Yes' : 'No'} />
          )}
          <InfoRow label={tr('secretInfo.dataKeys', 'Data Keys')} value={String(describe?.data_count ?? dataKeys.length)} />
        </div>
      </InfoSection>

      {tlsInfo && (
        <InfoSection title={tr('secretInfo.tlsCertInfo', 'TLS Certificate Info')}>
          <div className="space-y-2">
            <InfoRow label={tr('secretInfo.type', 'Type')} value={
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-emerald-700/50 bg-emerald-900/30 px-2 py-0.5 text-[11px] font-mono text-emerald-300">
                <ShieldCheck className="w-3 h-3" /> TLS
              </span>
            } />
            <InfoRow label="tls.crt" value={
              <span className="text-xs text-slate-300">
                {tlsInfo.hasCert ? (
                  <>
                    {tlsInfo.certSize !== undefined && <span className="font-mono">{tlsInfo.certSize} bytes</span>}
                    {tlsInfo.isPem && <span className="ml-2 text-[10px] text-emerald-400/80"><Tx>(PEM format)</Tx></span>}
                  </>
                ) : <span className="text-slate-500 italic"><Tx>not present</Tx></span>}
              </span>
            } />
            <InfoRow label="tls.key" value={
              <span className="text-xs text-slate-300">
                {tlsInfo.hasKey ? (
                  tlsInfo.keySize !== undefined ? <span className="font-mono">{tlsInfo.keySize} bytes</span> : <span><Tx>present</Tx></span>
                ) : <span className="text-slate-500 italic"><Tx>not present</Tx></span>}
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
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-slate-600 bg-slate-800 px-2 py-0.5 text-[11px] font-mono text-slate-300">
                <Container className="w-3 h-3" /> Docker Config
              </span>
            } />
            <InfoRow label={tr('secretInfo.registries', 'Registries')} value={
              <div className="space-y-1">
                {dockerInfo.registries.map((reg) => (
                  <div key={reg.url} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-slate-200 break-all">{reg.url}</span>
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
          <p className="text-[11px] text-amber-400/80 mb-2">{tr('secretInfo.maskedHint', 'Values are hidden without the resource.secret.reveal permission.')}</p>
        )}

        {dataKeys.length > DATA_PER_PAGE && (
          <div className="mb-2">
            <input
              type="text"
              placeholder={tr('secretInfo.searchKeys', 'Search keys...')}
              value={dataSearch}
              onChange={(e) => { setDataSearch(e.target.value); setDataPage(1) }}
              className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-sm text-xs text-ink placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500"
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
              <button type="button" onClick={() => setDataPage((p) => Math.max(1, p - 1))} disabled={dataPage <= 1} className="px-2 py-0.5 text-[10px] rounded-sm border border-slate-700 text-slate-400 disabled:opacity-40"><Tx>Prev</Tx></button>
              <button type="button" onClick={() => setDataPage((p) => Math.min(dataTotalPages, p + 1))} disabled={dataPage >= dataTotalPages} className="px-2 py-0.5 text-[10px] rounded-sm border border-slate-700 text-slate-400 disabled:opacity-40"><Tx>Next</Tx></button>
            </div>
          </div>
        )}
      </InfoSection>

      {ownerRefs.length > 0 && (
        <InfoSection title={tr('secretInfo.ownerReferences', 'Owner References')}>
          <div className="space-y-1">
            {ownerRefs.map((ref) => (
              <div key={ref.uid} className="flex items-center gap-2 text-xs">
                <span className="inline-flex rounded-sm border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-slate-300">{ref.kind}</span>
                <span className="text-ink font-medium">{ref.name}</span>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {enabled && (
        <InfoSection title="Used By Pods ({{n}})" titleValues={{ n: usingPods.total }}>
          {usingPods.note}
          {usingPods.loading ? (
            <p className="text-xs text-slate-400"><Tx>Loading...</Tx></p>
          ) : usingPods.total === 0 ? (
            <p className="text-xs text-slate-400"><Tx>No pod in this namespace directly references this Secret.</Tx></p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <Th className="text-left py-1">Pod</Th>
                    <Th className="text-left py-1">Status</Th>
                    <Th className="text-left py-1">Ready</Th>
                    <Th className="text-left py-1">Node</Th>
                    <Th className="text-left py-1">Age</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {usingPods.items.map((p) => (
                    <tr
                      key={`${p.namespace}/${p.name}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                    >
                      <td className="py-1 pr-2 font-mono">{p.name}</td>
                      <td className="py-1 pr-2"><StatusBadge status={podTableStatus(p)} /></td>
                      <td className="py-1 pr-2">{p.ready ?? '-'}</td>
                      <td className="py-1 pr-2 truncate max-w-[160px]">{p.node_name || '-'}</td>
                      <td className="py-1 pr-2 text-slate-400">{fmtRel(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {usingPods.nav}
            </div>
          )}
        </InfoSection>
      )}

      {enabled && (
        <InfoSection title="Used By ServiceAccounts ({{n}})" titleValues={{ n: usingSAs.length }}>
          {usingSAs.length === 0 ? (
            <p className="text-xs text-slate-400"><Tx>No ServiceAccount in this namespace references this Secret.</Tx></p>
          ) : (
            <div className="space-y-1 text-xs text-slate-200">
              {pagedUsingSAs.map((sa: any) => {
                const inPull = (sa?.image_pull_secrets ?? []).includes(name)
                const inMount = (sa?.secrets_list ?? []).includes(name)
                const tags: string[] = []
                if (inMount) tags.push('mount')
                if (inPull) tags.push('imagePullSecret')
                return (
                  <div key={`${sa.namespace}/${sa.name}`} className="flex items-center gap-2">
                    <ResourceLink kind="ServiceAccount" name={sa.name} namespace={sa.namespace} />
                    <span className="text-[10px] text-slate-400">({tags.join(', ')})</span>
                  </div>
                )
              })}
              {usingSAsNav}
            </div>
          )}
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

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />
    </div>
  )
}

function SecretDataRow({ dataKey, size, value, canReveal }: { dataKey: string; size?: number; value?: string; canReveal: boolean }) {
  const dl = useDetailLabel()
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const [notCopied, setNotCopied] = useState(false)
  const sizeStr = size !== undefined ? `${size} bytes` : ''

  const handleCopy = async () => {
    if (!value) return
    const ok = await copyText(value)
    setCopied(ok)
    setNotCopied(!ok)
    setTimeout(() => { setCopied(false); setNotCopied(false) }, ok ? 1500 : 3000)
  }

  return (
    <div className="rounded-sm border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-mono text-xs text-slate-200 break-all">{dataKey}</span>
          {sizeStr && <span className="text-[10px] text-slate-500 shrink-0">{sizeStr}</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
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
                className="p-1 rounded-sm hover:bg-slate-700 text-slate-400 hover:text-ink transition-colors"
                title={dl(visible ? 'Hide' : 'Show')}
              >
                {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              {canReveal && value && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 rounded-sm hover:bg-slate-700 text-slate-400 hover:text-ink transition-colors"
                  title={notCopied ? t('common.copyFailed', { defaultValue: 'Not copied: the browser did not take it. Select the text and copy it yourself.' }) : dl('Copy value')}
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : notCopied ? <X className="w-3.5 h-3.5 text-red-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {visible && canReveal && value !== undefined && (
        <div className="px-3 pb-2 border-t border-slate-800">
          <pre className="text-[11px] text-slate-300 whitespace-pre-wrap wrap-break-word mt-1.5 max-h-[200px] overflow-y-auto font-mono">
            {value || <span className="text-slate-600 italic"><Tx>(empty)</Tx></span>}
          </pre>
        </div>
      )}
    </div>
  )
}
