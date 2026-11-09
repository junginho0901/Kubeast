import { InfoSection, Tx } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'
import { usePagination } from '../usePagination'

// A RoleBinding's or ClusterRoleBinding's "Subjects": the count of each kind over all of them, then the subjects ten to
// a page. namespace is a RoleBinding's own, which a ServiceAccount subject without one is in.
export function BindingSubjects({ subjects, namespace }: { subjects: any[]; namespace?: string }) {
  const { items: paged, page, nav } = usePagination(subjects, 10)
  if (subjects.length === 0) {
    return (
      <InfoSection title="Subjects">
        <p className="text-xs text-slate-500"><Tx>No subjects defined.</Tx></p>
      </InfoSection>
    )
  }
  const counts: Record<string, number> = {}
  for (const s of subjects) {
    const k = String(s?.kind || 'Unknown')
    counts[k] = (counts[k] || 0) + 1
  }
  return (
    <InfoSection title="Subjects ({{n}})" titleValues={{ n: subjects.length }}>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {Object.entries(counts).map(([k, c]) => (
          <span key={k} className="rounded-sm border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-200">
            {k}: <span className="font-mono">{String(c)}</span>
          </span>
        ))}
      </div>
      <div data-testid="binding-subjects">
        <div className="space-y-2">
          {paged.map((subj: any, idx: number) => {
            const saNamespace = subj.namespace ?? namespace
            return (
              <div key={(page - 1) * 10 + idx} className="rounded-sm border border-slate-800 bg-slate-900/40 p-3 space-y-1.5" data-testid="binding-subject">
                <div className="text-xs text-slate-300 space-y-1">
                  <div>
                    <span className="text-[11px] text-slate-500 mr-2"><Tx>Kind:</Tx></span>
                    <span className="font-mono">{subj.kind || '-'}</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-slate-500 mr-2"><Tx>Name:</Tx></span>
                    {subj.kind === 'ServiceAccount' && subj.name && saNamespace ? (
                      <ResourceLink kind="ServiceAccount" name={subj.name} namespace={saNamespace} />
                    ) : (
                      <span className="font-mono">{subj.name || '-'}</span>
                    )}
                  </div>
                  {subj.namespace && (
                    <div>
                      <span className="text-[11px] text-slate-500 mr-2"><Tx>Namespace:</Tx></span>
                      <span className="font-mono">{subj.namespace}</span>
                    </div>
                  )}
                  {subj.apiGroup && (
                    <div>
                      <span className="text-[11px] text-slate-500 mr-2"><Tx>API Group:</Tx></span>
                      <span className="font-mono">{subj.apiGroup}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {nav}
      </div>
    </InfoSection>
  )
}
