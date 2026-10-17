import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// Shown while provider claude-code (a Claude subscription's setup-token) is picked in a model form; with the
// reason first when this install cannot run it yet (the forms then keep Test and Save off).
export default function ClaudeSubscriptionNotice({ unavailableReason }: { unavailableReason?: string | null }) {
  const { t } = useTranslation()
  return (
    <div role="note" data-testid="claude-subscription-notice" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 space-y-1">
      {unavailableReason && (
        <p data-testid="provider-unavailable" className="font-semibold text-red-300">
          {t('admin.aiModels.providerUnavailable', { reason: unavailableReason, defaultValue: 'Not available on this install: {{reason}}' })}
        </p>
      )}
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {t('admin.aiModels.subscriptionTitle', { defaultValue: 'Personal use only' })}
      </p>
      <p>{t('admin.aiModels.subscriptionTerms', { defaultValue: "A Claude Pro/Max subscription is for its owner's own use (Anthropic's terms). Use it only in a Kubeast that you alone use, not in an install shared with a team or other users." })}</p>
      <p>{t('admin.aiModels.subscriptionSetup', { defaultValue: 'Needs the chart value ai.providers.claudeCode.enabled (it runs the ai-service image with Claude Code) and the claude setup-token value in CLAUDE_CODE_OAUTH_TOKEN (ai.claudeCodeOAuthToken).' })}</p>
    </div>
  )
}
