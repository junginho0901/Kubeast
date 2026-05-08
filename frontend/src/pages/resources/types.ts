// Resources 페이지에서 공유되는 type. Resources.tsx 에서 추출 (Phase 3.5).

export type ResourceType =
  | 'services'
  | 'deployments'
  | 'replicasets'
  | 'hpas'
  | 'pdbs'
  | 'pods'
  | 'pvcs'
