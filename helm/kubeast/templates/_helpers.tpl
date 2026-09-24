{{- define "kubeast.namespace" -}}
{{ .Release.Namespace }}
{{- end -}}

{{- define "kubeast.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: kubeast
{{- end -}}

{{- define "kubeast.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
postgresql+asyncpg://{{ .Values.postgresql.user }}:{{ .Values.postgresql.password }}@postgres:5432/{{ .Values.postgresql.database }}
{{- else -}}
postgresql+asyncpg://{{ .Values.postgresql.user }}:{{ .Values.postgresql.password }}@{{ .Values.postgresql.externalHost }}:{{ .Values.postgresql.externalPort | default 5432 }}/{{ .Values.postgresql.database }}
{{- end -}}
{{- end -}}

{{- define "kubeast.databaseUrlGo" -}}
{{- if .Values.postgresql.enabled -}}
postgres://{{ .Values.postgresql.user }}:{{ .Values.postgresql.password }}@postgres:5432/{{ .Values.postgresql.database }}?sslmode=disable
{{- else -}}
postgres://{{ .Values.postgresql.user }}:{{ .Values.postgresql.password }}@{{ .Values.postgresql.externalHost }}:{{ .Values.postgresql.externalPort | default 5432 }}/{{ .Values.postgresql.database }}?sslmode=disable
{{- end -}}
{{- end -}}

{{/*
Pod-level security (Pod Security Standards "restricted"). Every workload runs
as a fixed non-root uid; images carry the matching USER. Usage:
  {{ include "kubeast.podSecurityContext" (dict "root" $ "uid" 65532 "fsGroup" 70) }}
*/}}
{{- define "kubeast.podSecurityContext" -}}
{{- if .root.Values.podSecurity.enabled }}
securityContext:
  runAsNonRoot: true
  runAsUser: {{ .uid }}
  runAsGroup: {{ .uid }}
  {{- if .fsGroup }}
  fsGroup: {{ .fsGroup }}
  {{- end }}
  seccompProfile:
    type: {{ .root.Values.podSecurity.seccompProfile }}
{{- if and (hasKey .root.Values.podSecurity "hostUsers") (not .root.Values.podSecurity.hostUsers) (not .skipHostUsers) }}
hostUsers: false
{{- end }}
{{- end }}
{{- end -}}

{{- define "kubeast.containerSecurityContext" -}}
{{- if .Values.podSecurity.enabled }}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: {{ .Values.podSecurity.readOnlyRootFilesystem }}
  capabilities:
    drop: ["ALL"]
{{- end }}
{{- end -}}

{{/* zone + hostname spread, both soft — meaningful once replicas > 1 */}}
{{- define "kubeast.topologySpread" -}}
{{- if .root.Values.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    matchLabelKeys: ["pod-template-hash"]
    labelSelector:
      matchLabels:
        app: {{ .app }}
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    matchLabelKeys: ["pod-template-hash"]
    labelSelector:
      matchLabels:
        app: {{ .app }}
{{- end }}
{{- end -}}

{{- define "kubeast.resources" -}}
{{- $r := index .root.Values.resources .key }}
{{- if $r }}
resources:
  {{- toYaml $r | nindent 2 }}
{{- end }}
{{- end -}}
