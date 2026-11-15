{{- define "kubeast.namespace" -}}
{{ .Release.Namespace }}
{{- end -}}

{{/* Group slug of a Kubeast role name, as services/pkg/auth/impersonation.go
     computes it: A-Z, U+0130 and U+212A lowered, a-z 0-9 . _ - kept, other
     ASCII "-", any other character "~" and its code point in four hex digits
     ("~~" and six above U+FFFF), read from printf's %+q escape. */}}
{{- define "kubeast.roleSlug" -}}
{{- range $c := splitList "" (trim .) -}}
{{- if regexMatch `^[a-z0-9._-]$` $c -}}{{ $c }}
{{- else if regexMatch `^[A-Z]$` $c -}}{{ lower $c }}
{{- else if eq $c "\u0130" -}}i
{{- else if eq $c "\u212a" -}}k
{{- else if regexMatch `^[\x00-\x7f]$` $c -}}-
{{- else -}}
{{- $q := printf "%+q" $c -}}
{{- if regexMatch `^"\\u[0-9a-f]{4}"$` $q -}}~{{ substr 3 7 $q }}
{{- else if regexMatch `^"\\U00[0-9a-f]{6}"$` $q -}}~~{{ substr 5 11 $q }}
{{- else -}}~fffd
{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "kubeast.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: kubeast
{{- end -}}

{{- /* The Secret every service reads its credentials from. */ -}}
{{- define "kubeast.secretsName" -}}
{{ .Values.secrets.existingSecret | default "kubeast-secrets" }}
{{- end -}}

{{- /* "true" when the chart's Redis runs one user per service (redis.acl): with the chart's own Secrets, with
       redis.acl.existingSecret, or with secrets.existingSecret once redis.acl.existingSecretHasKeys says it holds
       the users' passwords. Values only, never whether a key exists. */ -}}
{{- define "kubeast.redisAcl" -}}
{{- if and .Values.redis.enabled .Values.redis.acl.enabled (or (not .Values.secrets.existingSecret) .Values.redis.acl.existingSecretHasKeys .Values.redis.acl.existingSecret) }}true{{ end -}}
{{- end -}}

{{- /* The Secret holding the Redis users' passwords: redis.acl.existingSecret, else secrets.existingSecret, else the
       chart's kubeast-redis-users. */ -}}
{{- define "kubeast.redisUsersSecretName" -}}
{{ .Values.redis.acl.existingSecret | default .Values.secrets.existingSecret | default "kubeast-redis-users" }}
{{- end -}}

{{- /* The other way out of a missing Redis user key, for the acl container's message. */ -}}
{{- define "kubeast.redisUsersWayOut" -}}
{{- if .Values.redis.acl.existingSecret -}}
unset redis.acl.existingSecret
{{- else if .Values.secrets.existingSecret -}}
set redis.acl.existingSecretHasKeys=false
{{- else -}}
set redis.acl.enabled=false
{{- end -}}
{{- end -}}

{{/*
The chart's Redis users (Valkey ACL file). The redis pod's first container adds each password's SHA-256 where
${k8s_service} and ${probe} stand, so no password is in this text, the pod spec or Valkey's arguments.
- default: off and allowed nothing, so a connection that has not signed in as a user below gets NOAUTH. AUTH and
  HELLO, which sign in, take no rule.
- k8s-service: keys and channels under kubeast: only, and the commands of internal/cache and internal/clustersync —
  single-key reads, writes and deletes, SCAN for the pattern deletes, publish and subscribe (the cluster change
  notices), PING and SELECT (REDIS_DB). The cluster versions are in the database, so no hash or MULTI/EXEC. go-redis's CLIENT SETINFO and CLIENT MAINT_NOTIFICATIONS on connect are
  refused, which it ignores. No FLUSHALL, FLUSHDB, KEYS, CONFIG, DEBUG, ACL, MONITOR, EVAL or SCRIPT.
- probe: PING, for the readiness and liveness probes.
- tool-server (with the AI on): the cluster change notice channel, to listen to, and no key — SUBSCRIBE, UNSUBSCRIBE,
  PING (go-redis checks a subscription with it) and SELECT. It publishes nothing and reads no cache key.
Every command named must exist in the image's Valkey, or Valkey refuses the file and does not start. A command the
code starts to use is added here with a case in tests/redis_test.yaml; the services' tests hold what their code sends
to these lines (services/pkg/redisacl).
*/}}
{{/*
maxmemory of the chart's Redis, in bytes: 80% of resources.redis.limits.memory, so Valkey evicts before the container
reaches its limit (the rest is Valkey's own memory and the allocator's). Without a limit, 80% of 128Mi, the chart's
default limit. The quantity is bytes or a number with a Kubernetes suffix (Ki Mi Gi Ti Pi Ei, k M G T P E, m).
*/}}
{{- define "kubeast.redisMaxmemory" -}}
{{- $limit := "128Mi" -}}
{{- with index .Values.resources "redis" }}{{ with .limits }}{{ with .memory }}{{ $limit = toString . }}{{ end }}{{ end }}{{ end -}}
{{- $re := "^([0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E|m)?$" -}}
{{- if not (regexMatch $re $limit) }}{{ fail (printf "resources.redis.limits.memory %q is not a memory quantity (bytes, or a number with Ki, Mi, Gi, k, M, G …)" $limit) }}{{ end -}}
{{- $units := dict "" 1 "m" 0.001 "k" 1000 "M" 1000000 "G" 1000000000 "T" 1000000000000 "P" 1000000000000000 "E" 1000000000000000000 "Ki" 1024 "Mi" 1048576 "Gi" 1073741824 "Ti" 1099511627776 "Pi" 1125899906842624 "Ei" 1152921504606846976 -}}
{{- mulf (regexReplaceAll $re $limit "${1}" | float64) (index $units (regexReplaceAll $re $limit "${2}")) 0.8 | floor | int64 -}}
{{- end -}}

{{- define "kubeast.redisUsersAcl" -}}
user default off resetkeys resetchannels -@all
user k8s-service on #${k8s_service} resetkeys ~kubeast:* resetchannels &kubeast:* -@all +ping +select +get +set +del +unlink +scan +publish +subscribe +unsubscribe
user probe on #${probe} resetkeys resetchannels -@all +ping
{{- if .Values.ai.enabled }}
user tool-server on #${tool_server} resetkeys resetchannels &kubeast:clusters:changed:* -@all +ping +select +subscribe +unsubscribe
{{- end }}
{{- end -}}

{{- /* The keys of the Redis users' passwords the redis pod reads, space-separated: tool-server's with the AI on. */ -}}
{{- define "kubeast.redisUserKeys" -}}
REDIS_K8S_SERVICE_PASSWORD REDIS_PROBE_PASSWORD{{ if .Values.ai.enabled }} REDIS_TOOL_SERVER_PASSWORD{{ end }}
{{- end -}}

{{/*
DATABASE_URL — the one URL every service reads. The Go services (pgx) and the
ai-service (asyncpg, via app/db_ssl.py) both take libpq's sslmode / sslrootcert
from it; with postgresql.sslMode unset the drivers use their default (prefer).
Called with (dict "Values" .Values "password" <the password secret.yaml
settled on>): the value may be generated, so the caller passes it in.
*/}}
{{- /*
ALLOWED_ORIGINS: the Ingress host as an origin (scheme from ingress.tls) and
every entry of gateway.allowedOrigins, comma-joined; empty with neither.
*/ -}}
{{- define "kubeast.allowedOrigins" -}}
{{- $list := list -}}
{{- if and .Values.ingress.enabled .Values.ingress.host -}}
{{- $list = append $list (printf "%s://%s" (ternary "https" "http" (eq (toString .Values.ingress.tls) "true")) .Values.ingress.host) -}}
{{- end -}}
{{- range .Values.gateway.allowedOrigins -}}
{{- $list = append $list . -}}
{{- end -}}
{{- join "," $list -}}
{{- end -}}

{{- /*
The gateway's accesslog.conf with gateway.accessLog.upstreamTimes: nginx's
"combined" fields, then the request's time, the service's connect, header and
response times, the service's address and the client's port, to the same
place as nginx's default log. Empty when off, so the ConfigMap and the pods'
checksum stay as without it. dig: the values of an earlier release, kept by
--reuse-values, have no gateway.accessLog.
*/ -}}
{{- define "kubeast.gatewayAccessLog" -}}
{{- if eq (toString (dig "accessLog" "upstreamTimes" false .Values.gateway)) "true" -}}
log_format upstream_times '$remote_addr - $remote_user [$time_local] '
                          '"$request" $status $body_bytes_sent '
                          '"$http_referer" "$http_user_agent" '
                          '$request_time $upstream_connect_time $upstream_header_time '
                          '$upstream_response_time $upstream_addr $remote_port';
access_log /var/log/nginx/access.log upstream_times;
{{- end -}}
{{- end -}}

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
customCAs: extra certificate authorities for outbound TLS, every entry's keys
merged into /etc/kubeast/ca. Go reads every file of SSL_CERT_DIR on top of the
image's bundle file; ai-service (httpx) gets CUSTOM_CA_DIR instead, because
httpx would let SSL_CERT_DIR replace its bundle.
*/}}
{{- define "kubeast.customCAVolumeMount" -}}
{{- if .Values.customCAs }}
- name: custom-ca
  mountPath: /etc/kubeast/ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "kubeast.customCAVolume" -}}
{{- if .Values.customCAs }}
- name: custom-ca
  projected:
    sources:
      {{- range .Values.customCAs }}
      {{- if and .secret .configMap }}
      {{- fail "customCAs: an entry names a secret or a configMap, not both" }}
      {{- else if .secret }}
      - secret:
          name: {{ .secret | quote }}
      {{- else if .configMap }}
      - configMap:
          name: {{ .configMap | quote }}
      {{- else }}
      {{- fail "customCAs: every entry needs secret or configMap" }}
      {{- end }}
      {{- end }}
{{- end }}
{{- end -}}

{{- define "kubeast.customCAGoEnv" -}}
{{- if .Values.customCAs }}
- name: SSL_CERT_DIR
  value: /etc/kubeast/ca
{{- end }}
{{- end -}}

{{/* The database CA and the custom CAs, with the volumeMounts: / volumes: keys, for pods that have none otherwise. */}}
{{- define "kubeast.serviceVolumeMountsBlock" -}}
{{- if or .Values.postgresql.sslRootCert.secretName .Values.customCAs }}
volumeMounts:
  {{- with include "kubeast.dbCAVolumeMount" . }}{{ . | trim | nindent 2 }}{{ end }}
  {{- with include "kubeast.customCAVolumeMount" . }}{{ . | trim | nindent 2 }}{{ end }}
{{- end }}
{{- end -}}

{{- define "kubeast.serviceVolumesBlock" -}}
{{- if or .Values.postgresql.sslRootCert.secretName .Values.customCAs }}
volumes:
  {{- with include "kubeast.dbCAVolume" . }}{{ . | trim | nindent 2 }}{{ end }}
  {{- with include "kubeast.customCAVolume" . }}{{ . | trim | nindent 2 }}{{ end }}
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

{{/* Secret volume file mode: 0440 is read through the fsGroup above, which podSecurity off leaves to the platform. */}}
{{- define "kubeast.secretMode" -}}
{{- if .Values.podSecurity.enabled }}0440{{ else }}0444{{ end }}
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
startupProbe of a service that opens its port only after waiting for the
database at boot; liveness and readiness start once it passes. 180 s covers the
longest wait (auth-service and session-service: 60 s for the database, at most
5 s a ping, then 60 s for the schema; k8s-service: AUDIT_DB_WAIT_SEC 90 s, then up to 10 s in
k8s.NewService) and 60 s of migrations. Usage, with the liveness path and port:
  {{ include "kubeast.startupProbe" (dict "path" "/health" "port" 8004) }}
*/}}
{{- define "kubeast.startupProbe" -}}
{{- $period := 5 -}}
startupProbe:
  httpGet:
    path: {{ .path }}
    port: {{ .port }}
  periodSeconds: {{ $period }}
  failureThreshold: {{ div 180 $period }}
{{- end -}}

{{/* A pod behind a Service answers podShutdown.preStopSeconds more while its endpoint leaves, then gets SIGTERM with the 30 s its shutdown fits in. */}}
{{- define "kubeast.preStopSeconds" -}}
{{- $s := .Values.podShutdown.preStopSeconds -}}
{{- if or (not (or (kindIs "float64" $s) (kindIs "int64" $s) (kindIs "int" $s))) (lt (float64 $s) 0.0) (ne (float64 $s) (float64 (int $s))) -}}
{{- fail (printf "podShutdown.preStopSeconds must be a whole number of seconds, 0 or more (0 = no wait): %v" $s) -}}
{{- end -}}
{{- int $s -}}
{{- end -}}

{{- define "kubeast.preStop" -}}
{{- $s := int (include "kubeast.preStopSeconds" .) -}}
{{- if gt $s 0 -}}
lifecycle:
  preStop:
    sleep:
      seconds: {{ $s }}
{{- end -}}
{{- end -}}

{{/* A grace period: the preStop wait, what the process waits for after SIGTERM — a drain's wait and close wait (.drain)
     and the 25 s its shutdown takes (k8s-service: the server and the recorder) — and 5 s to spare. */}}
{{- define "kubeast.graceSeconds" -}}
{{- add .preStop (.drain | default 0) 25 5 -}}
{{- end -}}

{{- define "kubeast.terminationGrace" -}}
terminationGracePeriodSeconds: {{ include "kubeast.graceSeconds" (dict "preStop" (include "kubeast.preStopSeconds" .)) }}
{{- end -}}

{{/*
Annotations of one of the chart's ServiceAccounts: serviceAccounts.<key>.annotations,
over the aws.irsaRoleArn role when eksAuth (k8s-service and tool-server run
aws-iam-authenticator with the credentials the EKS pod identity webhook injects).
Empty when neither is set.
*/}}
{{- define "kubeast.serviceAccountAnnotations" -}}
{{- $a := dict -}}
{{- if and .eksAuth .root.Values.aws.irsaRoleArn -}}
{{- $_ := set $a "eks.amazonaws.com/role-arn" .root.Values.aws.irsaRoleArn -}}
{{- $_ := set $a "eks.amazonaws.com/sts-regional-endpoints" "true" -}}
{{- end -}}
{{- $a = mergeOverwrite $a (dig .key "annotations" dict (.root.Values.serviceAccounts | default dict)) -}}
{{- with $a -}}
annotations:
  {{- toYaml . | nindent 2 }}
{{- end -}}
{{- end -}}

{{- define "kubeast.awsEnv" -}}
{{- if .Values.aws.region }}
- name: AWS_REGION
  value: {{ .Values.aws.region | quote }}
- name: AWS_STS_REGIONAL_ENDPOINTS
  value: "regional"
{{- end }}
{{- end -}}

{{/* "true" when any audit sink writes files (auth-service then mounts audit.fileSinkVolume). */}}
{{- define "kubeast.auditFileSinks" -}}
{{- range .Values.audit.sinks }}{{ if eq (toString .type) "file" }}true{{ end }}{{ end }}
{{- end -}}

{{/* k8s-service volumes for terminal session recording (spool, file store, store Secret): (dict "root" $ "spool" bool).
     The spool is where the terminals open (SERVER_ROLE all or stream); k8s-service of role api only reads the store. */}}
{{- define "kubeast.recordingVolumeMounts" -}}
{{- with .root }}
{{- if .Values.sessionRecording.enabled }}
{{- if $.spool }}
- name: recording-spool
  mountPath: /var/lib/kubeast-recordings
{{- end }}
{{- if eq (toString .Values.sessionRecording.storage) "file" }}
- name: recording-store
  mountPath: /var/lib/kubeast-recordings-store
{{- end }}
{{- if .Values.sessionRecording.secret }}
- name: recording-secret
  mountPath: /etc/kubeast/recording-secret
  readOnly: true
{{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "kubeast.recordingVolumes" -}}
{{- with .root }}
{{- if .Values.sessionRecording.enabled }}
{{- if $.spool }}
- name: recording-spool
  {{- toYaml (.Values.sessionRecording.spoolVolume | default (dict "emptyDir" (dict))) | nindent 2 }}
{{- end }}
{{- if eq (toString .Values.sessionRecording.storage) "file" }}
- name: recording-store
  {{- toYaml .Values.sessionRecording.fileVolume | nindent 2 }}
{{- end }}
{{- if .Values.sessionRecording.secret }}
- name: recording-secret
  secret:
    secretName: {{ .Values.sessionRecording.secret }}
    defaultMode: {{ include "kubeast.secretMode" . }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
"true" when auth-service reads Google Workspace groups at sign-in (auth.oidc.googleGroups).
*/}}
{{- define "kubeast.googleGroups" -}}
{{- with .Values.auth.oidc -}}
{{- if and .enabled .googleGroups.enabled -}}
{{- if not .googleGroups.credentialsSecret -}}
{{- fail "auth.oidc.googleGroups needs credentialsSecret: a Secret with credentials.json (external_account or service_account)" -}}
{{- end -}}
true
{{- end -}}
{{- end -}}
{{- end }}


{{/*
The gateway's nginx.conf: files/nginx.conf as written, or with streams.enabled the terminals' and followed logs'
locations (the ones holding exec/ws, logs/stream, logfiles/stream and debug-shell/ws, each with its 3600 s timeouts)
sent to k8s-service-stream, plus a location for a node shell as API clients open it. The upstream is in
conf.d/kubeast/streams.conf. tests/streams_test.yaml counts the locations that changed, so an edit of the file that
this no longer matches fails there.
*/}}
{{- define "kubeast.gatewayNginxConf" -}}
{{- $conf := .Files.Get "files/nginx.conf" -}}
{{- if .Values.streams.enabled -}}
{{- $conf = regexReplaceAll `(location ~ \^/api/v1/[^\n]*(?:\(exec/ws\|logs/stream\|logfiles/stream\)|debug-shell/ws)\$ \{\n(?:[ \t]*rewrite [^\n]*\n)?[ \t]*proxy_pass http://)k8s-service;` $conf "${1}k8s-service-stream;" -}}
{{- $nodeShell := `        # A node shell as API clients open it (streams.enabled): to the stream server, kept open while quiet.
        location ~ ^/api/v1/nodes/[^/]+/debug-shell/ws$ {
            proxy_pass http://k8s-service-stream;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $forwarded_proto;
            proxy_cache_bypass $http_upgrade;
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
        }

` -}}
{{- $conf = replace "        location /api/v1/nodes {\n" (print $nodeShell "        location /api/v1/nodes {\n") $conf -}}
{{- end -}}
{{- $conf -}}
{{- end -}}
