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
