export type SetupMode = 'in_cluster' | 'external'
export type WizardPage = 'cluster' | 'ai-model'

export type StepPhase = 'validate' | 'save' | 'rollout' | 'connect'

export interface StepDef {
  phase: StepPhase
  labelKey: string
  fallback: string
}

export const STEPS: StepDef[] = [
  { phase: 'validate', labelKey: 'setup.steps.validate', fallback: 'Validate' },
  { phase: 'save',     labelKey: 'setup.steps.save',     fallback: 'Save config' },
  { phase: 'rollout',  labelKey: 'setup.steps.rollout',  fallback: 'Restart service' },
  { phase: 'connect',  labelKey: 'setup.steps.connect',  fallback: 'Connect cluster' },
]
