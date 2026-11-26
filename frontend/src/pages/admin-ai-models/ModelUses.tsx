import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import CustomDropdown, { type DropdownOption } from '@/components/CustomDropdown'
import { ActionFailure } from '@/components/ActionFailure'
import { getModelLabel } from '@/constants/modelCatalog'
import { api, type ChosenUse, type ModelConfigResponse, type ModelUseState } from '@/services/api'
import { useConfirm } from '@/services/confirm'
import { failureText } from '@/utils/failureText'
import { linesOf, type Tr } from './perUse'

const LABEL: Record<ChosenUse, string> = {
  investigation: 'Alert investigations',
  investigate_now: 'Investigate now',
  optimization: 'Optimization explanation',
}

// Which model answers the uses that have none of their own until one is chosen here. The chat's is Activate on a card
// below, the floating assistant's and the history summaries' is the economy tier in a model's form.
export default function ModelUses({ configs }: { configs: ModelConfigResponse[] }) {
  const { t } = useTranslation()
  const tr: Tr = (key, fb, o) => t(key, { defaultValue: fb, ...o })
  const qc = useQueryClient()
  const confirm = useConfirm()
  const uses = useQuery({ queryKey: ['model-configs', 'uses'], queryFn: () => api.listModelUses() })
  const choose = useMutation({
    mutationFn: ({ use, configId }: { use: ChosenUse; configId: number | null }) => api.setModelUse(use, configId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-configs'] }), // the cards' "Used for" too
  })
  if (uses.isPending) return null

  const label = (use: ChosenUse) => tr(`admin.aiModels.use.${use}`, LABEL[use])
  const asBefore = (use: ChosenUse) =>
    tr(`admin.aiModels.perUse.asBefore.${use}`, use === 'investigate_now' ? 'Same as alert investigations' : 'Active model')

  const options = (u: ModelUseState): DropdownOption[] => [
    { value: '', label: asBefore(u.use), testId: `model-use-${u.use}-none` },
    ...configs
      .filter((c) => c.enabled || c.id === u.choice?.id)
      .map((c) => ({ value: String(c.id), label: c.name, listHint: getModelLabel(c.provider, c.model), disabled: !c.enabled, testId: `model-use-${u.use}-${c.id}` })),
  ]

  const pick = async (u: ModelUseState, value: string) => {
    const configId = value ? Number(value) : null
    if (configId === (u.choice?.id ?? null)) return
    const name = configId === null ? u.chart_model || asBefore(u.use) : configs.find((c) => c.id === configId)?.name
    // it changes where the use's data goes and what it costs: say so before it runs
    const ok = await confirm({
      title: tr('admin.aiModels.perUse.confirmTitle', 'Change the model'),
      message: configId === null
        ? tr('admin.aiModels.perUse.confirmClear', 'Take away the choice for {{use}}? After that it runs on: {{name}}.', { use: label(u.use), name })
        : tr('admin.aiModels.perUse.confirmChoose', 'Use "{{name}}" for {{use}}? What it reads then goes to that model, at that model\'s price.', { use: label(u.use), name }),
      confirmLabel: tr('admin.aiModels.perUse.confirm', 'Change'),
    })
    if (ok) choose.mutate({ use: u.use, configId })
  }

  return (
    <div className="card min-w-0 space-y-5" data-testid="model-uses">
      <div>
        <h2 className="text-lg font-semibold text-ink">{tr('admin.aiModels.perUse.title', 'Which model answers')}</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">
          {tr('admin.aiModels.perUse.intro', 'The chat runs on the active model, and the floating assistant and history summaries on an economy one when there is one. Choose a model for the rest here.')}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-400" data-testid="model-uses-stronger">
          {tr('admin.aiModels.perUse.stronger', 'Finding the cause of a hard problem goes better with a stronger model. It is slower and more expensive.')}
        </p>
      </div>
      {uses.isError && !uses.data ? (
        <p role="alert" className="text-sm text-notice-text-failed break-words" data-testid="model-uses-error">
          {tr('admin.aiModels.perUse.readFailed', 'Could not read which model answers: {{reason}}', { reason: failureText(uses.error) })}
        </p>
      ) : (
        <div className="grid divide-y divide-hairline md:grid-cols-3 md:divide-x md:divide-y-0">
          {uses.data?.map((u) => (
            <div key={u.use} className="min-w-0 py-4 first:pt-0 last:pb-0 md:px-5 md:py-0 md:first:pl-0 md:last:pr-0" data-testid={`model-use-${u.use}`}>
              {u.chart_model ? (
                <CustomDropdown
                  label={label(u.use)}
                  options={[{ value: 'chart', label: tr('admin.aiModels.perUse.fromChart', 'Set in the chart: {{name}}', { name: u.chart_model }) }]}
                  value="chart"
                  onChange={() => {}}
                  disabled
                  testId={`model-use-${u.use}-select`}
                />
              ) : (
                <CustomDropdown
                  label={label(u.use)}
                  options={options(u)}
                  value={u.choice ? String(u.choice.id) : ''}
                  onChange={(value) => void pick(u, value)}
                  placeholder={u.choice?.name}
                  disabled={choose.isPending}
                  testId={`model-use-${u.use}-select`}
                />
              )}
              {linesOf(u, tr).map((line) => (
                <p key={line.text} className={`mt-2 text-xs leading-relaxed break-words ${line.problem ? 'text-notice-text-warning' : 'text-slate-400'}`}>{line.text}</p>
              ))}
              {u.chart_model && u.choice && (
                // the locked field does not show it, and it answers again once the chart names no model, a disabled one not then either
                <div className="mt-2 flex items-start justify-end gap-2 text-xs" data-testid={`model-use-${u.use}-kept`}>
                  {u.choice.enabled && (
                    <span className="min-w-0 flex-1 break-words text-notice-text-warning">
                      {tr('admin.aiModels.perUse.kept', '"{{name}}" is chosen here and applies once the chart names no model.', { name: u.choice.name })}
                    </span>
                  )}
                  <button type="button" className="btn-row shrink-0" disabled={choose.isPending} onClick={() => void pick(u, '')} data-testid={`model-use-${u.use}-take-away`}>
                    {tr('admin.aiModels.perUse.takeAway', 'Take away')}
                  </button>
                </div>
              )}
              {choose.variables?.use === u.use && <ActionFailure error={choose.error} action="change" testId={`model-use-${u.use}-error`} className="mt-1" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
