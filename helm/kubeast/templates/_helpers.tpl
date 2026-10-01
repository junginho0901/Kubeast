{{- define "kubeast.namespace" -}}
{{ .Release.Namespace }}
{{- end -}}

{{- define "kubeast.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: kubeast
{{- end -}}

{{- /* The Secret every service reads its credentials from. */ -}}
{{- define "kubeast.secretsName" -}}
{{ .Values.secrets.existingSecret | default "kubeast-secrets" }}
{{- end -}}

{{/*
DATABASE_URL — the one URL every service reads. The Go services (pgx) and the
ai-service (asyncpg, via app/db_ssl.py) both take libpq's sslmode / sslrootcert
from it; with postgresql.sslMode unset the drivers use their default (prefer).
Called with (dict "Values" .Values "password" <the password secret.yaml
settled on>): the value may be generated, so the caller passes it in.
*/}}
{{- define "kubeast.databaseUrl" -}}
{{- $p := .Values.postgresql -}}
{{- $host := ternary "postgres" ($p.externalHost | default "") $p.enabled -}}
{{- $port := ternary 5432 ($p.externalPort | default 5432) $p.enabled -}}
postgresql+asyncpg://{{ $p.user }}:{{ .password }}@{{ $host }}:{{ $port }}/{{ $p.database }}
{{- if $p.sslMode -}}
?sslmode={{ $p.sslMode }}
{{- if $p.sslRootCert.secretName -}}
&sslrootcert={{ include "kubeast.dbCAPath" . }}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Server CA for TLS verification of the database (postgresql.sslRootCert):
mounted read-only from a Secret into every database client pod.
*/}}
{{- define "kubeast.dbCAPath" -}}
/etc/kubeast/db-ca/{{ .Values.postgresql.sslRootCert.key | default "ca.crt" }}
{{- end -}}

{{- define "kubeast.dbCAVolumeMount" -}}
{{- if .Values.postgresql.sslRootCert.secretName }}
- name: db-ca
  mountPath: /etc/kubeast/db-ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "kubeast.dbCAVolume" -}}
{{- if .Values.postgresql.sslRootCert.secretName }}
- name: db-ca
  secret:
    secretName: {{ .Values.postgresql.sslRootCert.secretName }}
{{- end }}
{{- end -}}

{{/* Same, with the volumeMounts: / volumes: keys, for pods that have none otherwise. */}}
{{- define "kubeast.dbCAVolumeMountsBlock" -}}
{{- if .Values.postgresql.sslRootCert.secretName }}
volumeMounts:
  {{- include "kubeast.dbCAVolumeMount" . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "kubeast.dbCAVolumesBlock" -}}
{{- if .Values.postgresql.sslRootCert.secretName }}
volumes:
  {{- include "kubeast.dbCAVolume" . | nindent 2 }}
{{- end }}
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

{{/*
Pods that read kubeast-config / kubeast-secrets through envFrom roll when either
changes (Helm "automatically roll deployments" pattern). The Secret template's
generated values (admin password, signing key) are reused across upgrades, so
the checksum only moves when a value really changed.
*/}}
{{- define "kubeast.configChecksum" -}}
{{ print (include (print $.Template.BasePath "/configmap.yaml") .) (include (print $.Template.BasePath "/secret.yaml") .) | sha256sum }}
{{- end -}}

{{- define "kubeast.resources" -}}
{{- $r := index .root.Values.resources .key }}
{{- if $r }}
resources:
  {{- toYaml $r | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
EKS IAM authentication: the k8s-service and tool-server pods run
aws-iam-authenticator with the credentials the EKS pod identity webhook injects
for the annotated ServiceAccount (IRSA). Empty when aws.irsaRoleArn is unset.
*/}}
{{- define "kubeast.awsServiceAccountAnnotations" -}}
{{- if .Values.aws.irsaRoleArn }}
annotations:
  eks.amazonaws.com/role-arn: {{ .Values.aws.irsaRoleArn | quote }}
  eks.amazonaws.com/sts-regional-endpoints: "true"
{{- end }}
{{- end -}}

{{- define "kubeast.awsEnv" -}}
{{- if .Values.aws.region }}
- name: AWS_REGION
  value: {{ .Values.aws.region | quote }}
- name: AWS_STS_REGIONAL_ENDPOINTS
  value: "regional"
{{- end }}
{{- end -}}
