package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A list page starts from the list API and then applies live updates, so one object has to read the same both ways.
// These cases take an object as the API server sends it through the real list code and the real live update code;
// watchRows.cases.test.ts then runs the page's own functions over what they gave. UPDATE_WATCH_ROW_CASES=1 writes the
// file; otherwise the test fails when the file is not what the code gives now.
const watchRowCasesFile = "../../../../frontend/src/services/watchRows.cases.json"

const (
	ingressWeb = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z","labels":{"team":"a"},"annotations":{"note":"kept"}},
		"spec":{"ingressClassName":"nginx","tls":[{"hosts":["example.test"],"secretName":"web-tls"}],
		"rules":[{"host":"example.test","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"web","port":{"number":80}}}}]}}]},
		"status":{"loadBalancer":{"ingress":[{"ip":"192.0.2.1"}]}}}`
	ingressDefaultBackendOnly = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},
		"spec":{"defaultBackend":{"service":{"name":"fallback","port":{"number":80}}}},"status":{}}`
	ingressAnnotatedClass = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z","annotations":{"kubernetes.io/ingress.class":"nginx"}},
		"spec":{"rules":[{"host":"example.test"}]},"status":{}}`
	ingressNoClass = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},
		"spec":{"rules":[{"host":"example.test"}]},"status":{}}`
	ingressEmpty = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},"spec":{},"status":{}}`
	ingressFull  = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},
		"spec":{"ingressClassName":"traefik","tls":[{"secretName":"no-hosts"}],
		"rules":[{"host":"b.example.test","http":{"paths":[{"path":"/b","pathType":"Exact","backend":{"service":{"name":"zeta","port":{"name":"http"}}}}]}},
		{"host":"a.example.test","http":{"paths":[{"path":"/a","pathType":"Prefix","backend":{"service":{"name":"alpha","port":{"number":8080}}}}]}}]},
		"status":{"loadBalancer":{"ingress":[{"hostname":"lb.example.test","ports":[{"port":443,"protocol":"TCP"}]}]}}}`

	vaSpec   = `"spec":{"attacher":"csi.example.test","nodeName":"node-a","source":{"persistentVolumeName":"pv-a"}}`
	vaMeta   = `{"apiVersion":"storage.k8s.io/v1","kind":"VolumeAttachment","metadata":{"name":"disk-a","creationTimestamp":"2026-11-01T00:00:00Z"},`
	vaFailed = vaMeta + vaSpec + `,"status":{"attached":false,"attachError":{"time":"2026-11-05T00:00:00Z","message":"attach failed"}}}`
	vaOK     = vaMeta + vaSpec + `,"status":{"attached":true}}`
	vaDetErr = vaMeta + vaSpec + `,"status":{"attached":true,"detachError":{"time":"2026-11-05T00:00:00Z","message":"detach failed"}}}`
	vaOff    = vaMeta + vaSpec + `,"status":{"attached":false}}`
	vaNoStat = vaMeta + vaSpec + `}`

	cronMeta = `{"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"daily","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},`
	cronJob  = `"jobTemplate":{"spec":{"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"app","image":"example.test/app:1"}]}}}}`
	cronOld  = cronMeta + `"spec":{"schedule":"0 9 * * *","timeZone":"Asia/Seoul","concurrencyPolicy":"Allow",` + cronJob + `},
		"status":{"active":[{"kind":"Job","name":"daily-1","namespace":"demo"}],"lastScheduleTime":"2026-11-05T00:00:00Z","lastSuccessfulTime":"2026-11-05T00:01:00Z"}}`
	cronNoZone = cronMeta + `"spec":{"schedule":"0 9 * * *","concurrencyPolicy":"Allow",` + cronJob + `},
		"status":{"lastScheduleTime":"2026-11-06T09:00:00Z","lastSuccessfulTime":"2026-11-06T09:01:00Z"}}`
	cronUTC = cronMeta + `"spec":{"schedule":"0 9 * * *","timeZone":"Etc/UTC","concurrencyPolicy":"Allow",` + cronJob + `},
		"status":{"lastScheduleTime":"2026-11-06T09:00:00Z","lastSuccessfulTime":"2026-11-06T09:01:00Z"}}`
	cronNoRuns = cronMeta + `"spec":{"schedule":"0 9 * * *","timeZone":"Asia/Seoul","concurrencyPolicy":"Allow",` + cronJob + `},"status":{}}`
	cronOther  = cronMeta + `"spec":{"schedule":"30 1 * * *","suspend":true,"concurrencyPolicy":"Forbid",
		"jobTemplate":{"spec":{"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"new","image":"example.test/new:2"},{"name":"side","image":"example.test/side:1"}]}}}}},"status":{}}`

	svcMeta          = `{"apiVersion":"v1","kind":"Service","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},`
	svcPlain         = svcMeta + `"spec":{"type":"ClusterIP","clusterIP":"10.0.0.1","selector":{"app":"web"},"ports":[{"name":"http","port":80,"targetPort":8080,"protocol":"TCP"}]},"status":{"loadBalancer":{}}}`
	svcOtherSelector = svcMeta + `"spec":{"type":"ClusterIP","clusterIP":"10.0.0.1","selector":{"app":"new"},"ports":[{"name":"http","port":80,"targetPort":8080,"protocol":"TCP"}]},"status":{"loadBalancer":{}}}`
	svcExternalName  = svcMeta + `"spec":{"type":"ExternalName","externalName":"db.example.test"},"status":{"loadBalancer":{}}}`
	svcBalanced      = svcMeta + `"spec":{"type":"LoadBalancer","clusterIP":"10.0.0.1","externalIPs":["192.0.2.9"],"selector":{"app":"web"},
		"ports":[{"name":"http","port":80,"targetPort":"http","nodePort":30080,"protocol":"TCP","appProtocol":"http"}]},
		"status":{"loadBalancer":{"ingress":[{"ip":"192.0.2.1"},{"hostname":"lb.example.test"}]}}}`
	svcPending = svcMeta + `"spec":{"type":"LoadBalancer","clusterIP":"10.0.0.1","selector":{"app":"web"},
		"ports":[{"name":"http","port":80,"targetPort":"http","nodePort":30080,"protocol":"TCP"}]},"status":{"loadBalancer":{}}}`
	svcPendingWithIPs = svcMeta + `"spec":{"type":"LoadBalancer","clusterIP":"10.0.0.1","externalIPs":["192.0.2.9"],"selector":{"app":"web"},
		"ports":[{"name":"http","port":80,"targetPort":"http","nodePort":30080,"protocol":"TCP"}]},"status":{"loadBalancer":{}}}`
	svcClusterIPs = svcMeta + `"spec":{"type":"ClusterIP","clusterIP":"10.0.0.1","externalIPs":["192.0.2.9","192.0.2.1"],"selector":{"app":"web"},"ports":[{"name":"http","port":80,"targetPort":8080,"protocol":"TCP"}]},"status":{"loadBalancer":{}}}`

	epMeta     = `{"apiVersion":"v1","kind":"Endpoints","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"}`
	epPort     = `"ports":[{"name":"http","port":80,"protocol":"TCP"}]`
	epFull     = epMeta + `,"subsets":[{"addresses":[{"ip":"10.0.0.1","nodeName":"node-a","targetRef":{"kind":"Pod","name":"web-1","namespace":"demo","uid":"u-1"}}],"notReadyAddresses":[{"ip":"10.0.0.2"}],` + epPort + `}]}`
	epAllReady = epMeta + `,"subsets":[{"addresses":[{"ip":"10.0.0.1","nodeName":"node-a","targetRef":{"kind":"Pod","name":"web-1","namespace":"demo","uid":"u-1"}},{"ip":"10.0.0.2"}],` + epPort + `}]}`
	epNone     = epMeta + `}`

	icFull = `{"apiVersion":"networking.k8s.io/v1","kind":"IngressClass","metadata":{"name":"nginx","creationTimestamp":"2026-11-01T00:00:00Z","labels":{"team":"a"},
		"annotations":{"ingressclass.kubernetes.io/is-default-class":"true"},"finalizers":["example.test/keep"]},
		"spec":{"controller":"example.test/nginx","parameters":{"apiGroup":"example.test","kind":"Params","name":"p","scope":"Namespace","namespace":"demo"}}}`
	icPlain = `{"apiVersion":"networking.k8s.io/v1","kind":"IngressClass","metadata":{"name":"nginx","creationTimestamp":"2026-11-01T00:00:00Z"},"spec":{"controller":"example.test/nginx"}}`

	npHead     = `{"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	npTags     = `,"labels":{"team":"a"},"annotations":{"note":"kept"},"finalizers":["example.test/keep"]`
	npRuleSpec = `"spec":{"podSelector":{"matchLabels":{"app":"web"}},"policyTypes":["Ingress","Egress"],
		"ingress":[{"from":[{"podSelector":{"matchLabels":{"role":"client"}}},{"namespaceSelector":{"matchLabels":{"team":"back"}}},
		{"podSelector":{"matchExpressions":[{"key":"tier","operator":"In","values":["b","a"]}]},"namespaceSelector":{}},
		{"ipBlock":{"cidr":"10.0.0.0/8","except":["10.1.0.0/16"]}}],
		"ports":[{"protocol":"TCP","port":8000,"endPort":9000},{"protocol":"UDP","port":"dns"}]}],
		"egress":[{"to":[{"podSelector":{"matchLabels":{"app":"db"}},"namespaceSelector":{"matchLabels":{"team":"db"}}}],"ports":[{"protocol":"TCP","port":5432}]}]}}`
	npRules       = npHead + npTags + `},` + npRuleSpec
	npRulesNoTags = npHead + `},` + npRuleSpec
	npNoRules     = npHead + npTags + `},"spec":{"podSelector":{},"policyTypes":["Ingress","Egress"]}}`

	pvMeta   = `{"apiVersion":"v1","kind":"PersistentVolume","metadata":{"name":"disk-a","creationTimestamp":"2026-11-01T00:00:00Z"},`
	pvSize   = `"capacity":{"storage":"1024Mi"},"accessModes":["ReadWriteOnce"],"persistentVolumeReclaimPolicy":"Retain","volumeMode":"Filesystem"`
	pvCSI    = `"storageClassName":"fast","claimRef":{"namespace":"demo","name":"claim-a"},"csi":{"driver":"csi.example.test","volumeHandle":"vol-1"}`
	pvBound  = pvMeta + `"spec":{` + pvSize + `,` + pvCSI + `},"status":{"phase":"Bound"}}`
	pvFailed = pvMeta + `"spec":{` + pvSize + `,` + pvCSI + `},"status":{"phase":"Failed","reason":"Broken","message":"disk gone"}}`
	pvFree   = pvMeta + `"spec":{` + pvSize + `,"hostPath":{"path":"/data"}},"status":{"phase":"Available"}}`

	depHead      = `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	depTags      = `,"labels":{"team":"a"}`
	depTemplate  = `"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"app","image":"example.test/app:1"}]}}`
	depSpecOld   = `"spec":{"replicas":2,` + depTemplate + `}`
	depSpecNew   = `"spec":{"replicas":3,"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"app","image":"example.test/app:2"},{"name":"side","image":"example.test/side:1"}]}}}`
	depAvailable = `{"type":"Available","status":"True","reason":"MinimumReplicasAvailable"}`
	depDone      = `"status":{"replicas":2,"readyReplicas":2,"availableReplicas":2,"updatedReplicas":2,"conditions":[` + depAvailable + `,{"type":"Progressing","status":"True","reason":"NewReplicaSetAvailable"}]}`
	depStuck     = `"status":{"replicas":3,"readyReplicas":2,"availableReplicas":2,"updatedReplicas":1,"unavailableReplicas":1,"conditions":[` + depAvailable + `,{"type":"Progressing","status":"False","reason":"ProgressDeadlineExceeded"}]}`
	depStarting  = `"status":{"replicas":3,"updatedReplicas":1,"unavailableReplicas":3,"conditions":[{"type":"Available","status":"False","reason":"MinimumReplicasUnavailable"},{"type":"Progressing","status":"True","reason":"ReplicaSetUpdated"}]}`
	depOKTagged  = depHead + depTags + `},` + depSpecOld + `,` + depDone + `}`
	depOKPlain   = depHead + `},` + depSpecOld + `,` + depDone + `}`
	depStuckAll  = depHead + depTags + `},` + depSpecNew + `,` + depStuck + `}`
	depStartAll  = depHead + depTags + `},` + depSpecNew + `,` + depStarting + `}`

	rsHead       = `{"apiVersion":"apps/v1","kind":"ReplicaSet","metadata":{"name":"web-1","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	rsOwner      = `,"ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"web","uid":"u-1","controller":true}]`
	rsController = `,"ownerReferences":[{"apiVersion":"example.test/v1","kind":"Rollout","name":"web","uid":"u-2","controller":true}]`
	rsTemplate   = `"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"app","image":"example.test/app:1"}]}}`
	rsTwo        = `"spec":{"replicas":2,` + rsTemplate + `}`
	rsZero       = `"spec":{"replicas":0,` + rsTemplate + `}`
	rsReady      = `"status":{"replicas":2,"readyReplicas":2,"availableReplicas":2}`
	rsNotYet     = `"status":{"replicas":2}`
	rsOwned      = rsHead + rsOwner + `},` + rsTwo + `,` + rsReady + `}`
	rsFree       = rsHead + `},` + rsTwo + `,` + rsReady + `}`
	rsTaken      = rsHead + rsController + `},` + rsTwo + `,` + rsReady + `}`
	rsNoneReady  = rsHead + rsOwner + `},` + rsTwo + `,` + rsNotYet + `}`
	rsScaledDown = rsHead + rsOwner + `},` + rsZero + `,"status":{"replicas":0}}`

	hpaHead   = `{"apiVersion":"autoscaling/v2","kind":"HorizontalPodAutoscaler","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	hpaTags   = `,"labels":{"team":"a"}`
	hpaTarget = `"scaleTargetRef":{"apiVersion":"apps/v1","kind":"Deployment","name":"web"},"minReplicas":2,"maxReplicas":5`
	hpaObject = `"describedObject":{"apiVersion":"v1","kind":"Service","name":"web"}`
	hpaFive   = `"spec":{` + hpaTarget + `,"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":80}}},
		{"type":"Pods","pods":{"metric":{"name":"qps"},"target":{"type":"AverageValue","averageValue":"10"}}},
		{"type":"Object","object":{` + hpaObject + `,"metric":{"name":"rps"},"target":{"type":"Value","value":"100"}}},
		{"type":"External","external":{"metric":{"name":"queue"},"target":{"type":"Value","value":"5"}}},
		{"type":"ContainerResource","containerResource":{"name":"memory","container":"app","target":{"type":"AverageValue","averageValue":"1Gi"}}}]}`
	hpaNoMetric = `"spec":{` + hpaTarget + `}`
	hpaRead     = `"status":{"currentReplicas":3,"desiredReplicas":4,"lastScaleTime":"2026-11-05T00:00:00Z","currentMetrics":[
		{"type":"Resource","resource":{"name":"cpu","current":{"averageUtilization":60}}},
		{"type":"Pods","pods":{"metric":{"name":"qps"},"current":{"averageValue":"7"}}},
		{"type":"Object","object":{` + hpaObject + `,"metric":{"name":"rps"},"current":{"value":"90"}}},
		{"type":"External","external":{"metric":{"name":"queue"},"current":{"value":"3"}}},
		{"type":"ContainerResource","containerResource":{"name":"memory","container":"app","current":{"averageValue":"500Mi"}}}],
		"conditions":[{"type":"ScalingActive","status":"True","reason":"ValidMetricFound"}]}`
	hpaUnread    = `"status":{"currentReplicas":3,"desiredReplicas":0,"conditions":[{"type":"ScalingActive","status":"False","reason":"FailedGetResourceMetric"}]}`
	hpaFull      = hpaHead + hpaTags + `},` + hpaFive + `,` + hpaRead + `}`
	hpaNotRead   = hpaHead + `},` + hpaFive + `,` + hpaUnread + `}`
	hpaNoMetrics = hpaHead + `},` + hpaNoMetric + `,` + hpaUnread + `}`

	cmHead  = `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"conf","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	cmValue = "fake-config-value-for-tests"
	cmFull  = cmHead + `,"labels":{"team":"a"}},"data":{"b":"` + cmValue + `","a":"` + cmValue + `"},"binaryData":{"c":"eA=="}}`
	cmOne   = cmHead + `},"data":{"only":"` + cmValue + `"}}`
	cmNone  = cmHead + `}}`

	secretHead = `{"apiVersion":"v1","kind":"Secret","type":"Opaque","metadata":{"name":"creds","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	// a value as the API server sends it, and the same value in the annotation kubectl apply writes
	secretValue   = "fake-secret-value-for-tests"
	secretEncoded = "ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXRlc3Rz"
	secretApplied = `"kubectl.kubernetes.io/last-applied-configuration":"{\"stringData\":{\"password\":\"` + secretValue + `\"}}"`
	secretFull    = secretHead + `,"labels":{"team":"a"},"annotations":{` + secretApplied + `}},"data":{"user":"` + secretEncoded + `","password":"` + secretEncoded + `"}}`
	secretNone    = secretHead + `}}`

	saHead  = `{"apiVersion":"v1","kind":"ServiceAccount","metadata":{"name":"runner","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	saFull  = saHead + `,"labels":{"team":"a"},"annotations":{"note":"kept"}},"secrets":[{"name":"runner-token"}],"imagePullSecrets":[{"name":"registry"}]}`
	saPlain = saHead + `}}`

	roleHead  = `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"Role","metadata":{"name":"reader","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	roleFull  = roleHead + `,"labels":{"team":"a"},"annotations":{"note":"kept"}},"rules":[{"apiGroups":[""],"resources":["pods"],"verbs":["get"]},{"apiGroups":["apps"],"resources":["deployments"],"verbs":["list"]}]}`
	rolePlain = roleHead + `}}`

	podHead = `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"web-1","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	podTags = `,"labels":{"app":"web"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"web-abc","uid":"u-1","controller":true}]`
	podGone = `,"deletionTimestamp":"2026-11-06T00:00:00Z"`
	// a value a container holds in the object, which no row carries
	podEnvValue = "fake-env-value-for-tests"
	podRefSpec  = `"spec":{"nodeName":"node-a","serviceAccountName":"runner","priorityClassName":"high","containers":[{"name":"app","image":"example.test/app:1",
		"ports":[{"name":"http","containerPort":8080,"protocol":"TCP"}],"resources":{"requests":{"cpu":"100m"},"limits":{"memory":"1024Mi"}},
		"env":[{"name":"MODE","value":"` + podEnvValue + `"},{"name":"TOKEN","valueFrom":{"secretKeyRef":{"name":"creds-env","key":"token"}}},{"name":"CONF","valueFrom":{"configMapKeyRef":{"name":"conf-env","key":"conf"}}}],
		"envFrom":[{"configMapRef":{"name":"conf-from"}},{"prefix":"S_","secretRef":{"name":"creds-from"}}],
		"volumeMounts":[{"name":"cfg","mountPath":"/etc/cfg","readOnly":true}],"securityContext":{"runAsNonRoot":true,"capabilities":{"drop":["ALL"]}}}],
		"volumes":[{"name":"cfg","configMap":{"name":"conf-vol"}},{"name":"sec","secret":{"secretName":"creds-vol"}},{"name":"all","projected":{"sources":[{"configMap":{"name":"conf-proj"}},{"secret":{"name":"creds-proj"}}]}}],
		"imagePullSecrets":[{"name":"registry"}]}`
	podPlainSpec   = `"spec":{"nodeName":"node-a","containers":[{"name":"app","image":"example.test/app:1"}]}`
	podSidecarSpec = `"spec":{"nodeName":"node-a","initContainers":[{"name":"side","image":"example.test/side:1","restartPolicy":"Always"}],"containers":[{"name":"app","image":"example.test/app:1"}]}`
	podInitSpec    = `"spec":{"nodeName":"node-a","initContainers":[{"name":"setup","image":"example.test/setup:1"}],"containers":[{"name":"app","image":"example.test/app:1"}]}`
	podClaimSpec   = `"spec":{"nodeName":"node-a","containers":[{"name":"app","image":"example.test/app:1"}],"resourceClaims":[{"name":"gpu","resourceClaimName":"claim-a"},{"name":"tmpl","resourceClaimTemplateName":"template-a"}]}`
	podConditions  = `"conditions":[{"type":"Initialized","status":"True"},{"type":"Ready","status":"True"}]`
	podNotReady    = `"conditions":[{"type":"Initialized","status":"True"},{"type":"Ready","status":"False"}]`
	podLastCrash   = `"lastState":{"terminated":{"exitCode":1,"reason":"Error","startedAt":"2026-11-01T00:00:10Z","finishedAt":"2026-11-01T00:00:50Z"}}`
	podAppRunning  = `{"name":"app","image":"example.test/app:1","imageID":"","ready":true,"restartCount":2,"state":{"running":{"startedAt":"2026-11-01T00:01:00Z"}},` + podLastCrash + `}`
	podRunning     = `"status":{"phase":"Running","podIP":"10.0.0.7",` + podConditions + `,"containerStatuses":[` + podAppRunning + `]}`
	podCrashing    = `"status":{"phase":"Running","podIP":"10.0.0.7",` + podNotReady + `,"containerStatuses":[{"name":"app","image":"example.test/app:1","imageID":"","ready":false,"restartCount":3,"state":{"waiting":{"reason":"CrashLoopBackOff","message":"back-off restarting"}},` + podLastCrash + `}]}`
	podNodeLost    = `"status":{"phase":"Running","reason":"NodeLost","message":"node stopped answering","podIP":"10.0.0.7",` + podConditions + `,"containerStatuses":[` + podAppRunning + `]}`
	podExitCode    = `"status":{"phase":"Failed","containerStatuses":[{"name":"app","image":"example.test/app:1","imageID":"","ready":false,"restartCount":0,"state":{"terminated":{"exitCode":2,"startedAt":"2026-11-01T00:01:00Z","finishedAt":"2026-11-01T00:02:00Z"}}}]}`
	podInitFailed  = `"status":{"phase":"Pending","conditions":[{"type":"Initialized","status":"False"},{"type":"Ready","status":"False"}],
		"initContainerStatuses":[{"name":"setup","image":"example.test/setup:1","imageID":"","ready":false,"restartCount":4,"state":{"terminated":{"exitCode":1,"reason":"Error","startedAt":"2026-11-01T00:01:00Z","finishedAt":"2026-11-01T00:02:00Z"}}}],
		"containerStatuses":[{"name":"app","image":"example.test/app:1","imageID":"","ready":false,"restartCount":0,"state":{"waiting":{"reason":"PodInitializing"}}}]}`
	podSidecarUp = `"status":{"phase":"Running","podIP":"10.0.0.7",` + podConditions + `,
		"initContainerStatuses":[{"name":"side","image":"example.test/side:1","imageID":"","ready":true,"started":true,"restartCount":1,"state":{"running":{"startedAt":"2026-11-01T00:00:30Z"}}}],
		"containerStatuses":[` + podAppRunning + `]}`
	podSidecarNotReady = `"status":{"phase":"Running","podIP":"10.0.0.7",` + podNotReady + `,
		"initContainerStatuses":[{"name":"side","image":"example.test/side:1","imageID":"","ready":false,"started":true,"restartCount":0,"state":{"running":{"startedAt":"2026-11-01T00:00:30Z"}}}],
		"containerStatuses":[` + podAppRunning + `]}`
	podSidecarStarting = `"status":{"phase":"Running","podIP":"10.0.0.7","conditions":[{"type":"Initialized","status":"False"},{"type":"Ready","status":"False"}],
		"initContainerStatuses":[{"name":"side","image":"example.test/side:1","imageID":"","ready":false,"started":false,"restartCount":0,"state":{"running":{"startedAt":"2026-11-01T00:00:30Z"}}}],
		"containerStatuses":[{"name":"app","image":"example.test/app:1","imageID":"","ready":false,"restartCount":0,"state":{"waiting":{"reason":"PodInitializing"}}}]}`
	podSidecarCrashing = `"status":{"phase":"Running","podIP":"10.0.0.7",` + podNotReady + `,
		"initContainerStatuses":[{"name":"side","image":"example.test/side:1","imageID":"","ready":false,"started":false,"restartCount":3,"state":{"waiting":{"reason":"CrashLoopBackOff"}}}],
		"containerStatuses":[` + podAppRunning + `]}`
	podOfDeploy   = podHead + podTags + `},` + podPlainSpec + `,` + podRunning + `}`
	podBare       = podHead + `},` + podPlainSpec + `,` + podRunning + `}`
	podDeleting   = podHead + podTags + podGone + `},` + podPlainSpec + `,` + podRunning + `}`
	podCrashLoop  = podHead + podTags + `},` + podPlainSpec + `,` + podCrashing + `}`
	podAllRefs    = podHead + podTags + `},` + podRefSpec + `,` + podRunning + `}`
	podLostNode   = podHead + podTags + podGone + `},` + podPlainSpec + `,` + podNodeLost + `}`
	podExited     = podHead + podTags + `},` + podPlainSpec + `,` + podExitCode + `}`
	podInitError  = podHead + podTags + `},` + podInitSpec + `,` + podInitFailed + `}`
	podWithSide   = podHead + podTags + `},` + podSidecarSpec + `,` + podSidecarUp + `}`
	podSideUnfit  = podHead + podTags + `},` + podSidecarSpec + `,` + podSidecarNotReady + `}`
	podSideStart  = podHead + podTags + `},` + podSidecarSpec + `,` + podSidecarStarting + `}`
	podSideCrash  = podHead + podTags + `},` + podSidecarSpec + `,` + podSidecarCrashing + `}`
	podWithClaims = podHead + podTags + `},` + podClaimSpec + `,` + podRunning + `}`

	dsHead     = `{"apiVersion":"apps/v1","kind":"DaemonSet","metadata":{"name":"agent","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},`
	dsSelector = `"selector":{"matchLabels":{"app":"agent"}}`
	dsOnSSD    = `"spec":{` + dsSelector + `,"template":{"metadata":{"labels":{"app":"agent"}},"spec":{"nodeSelector":{"disk":"ssd"},"containers":[{"name":"app","image":"example.test/app:1"}]}}}`
	dsAnyNode  = `"spec":{` + dsSelector + `,"template":{"metadata":{"labels":{"app":"agent"}},"spec":{"containers":[{"name":"app","image":"example.test/app:2"},{"name":"side","image":"example.test/side:1"}]}}}`
	dsAllUp    = `"status":{"desiredNumberScheduled":3,"currentNumberScheduled":3,"numberReady":3,"updatedNumberScheduled":3,"numberAvailable":3}`
	dsOneDown  = `"status":{"desiredNumberScheduled":3,"currentNumberScheduled":3,"numberReady":2,"updatedNumberScheduled":1,"numberAvailable":2,"numberUnavailable":1,"numberMisscheduled":1}`
	dsNoneUp   = `"status":{"desiredNumberScheduled":3,"currentNumberScheduled":3,"numberReady":1,"updatedNumberScheduled":3,"numberAvailable":0,"numberUnavailable":3}`
	dsNoNode   = `"status":{"desiredNumberScheduled":0,"currentNumberScheduled":0,"numberReady":0}`
	dsPicky    = dsHead + dsOnSSD + `,` + dsAllUp + `}`
	dsAny      = dsHead + dsAnyNode + `,` + dsAllUp + `}`
	dsDown     = dsHead + dsOnSSD + `,` + dsOneDown + `}`
	dsNone     = dsHead + dsOnSSD + `,` + dsNoneUp + `}`
	dsIdle     = dsHead + dsOnSSD + `,` + dsNoNode + `}`

	jobHead     = `{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"daily-1","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	jobOwner    = `,"ownerReferences":[{"apiVersion":"batch/v1","kind":"CronJob","name":"daily","uid":"u-1","controller":true}]`
	jobTemplate = `"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"app","image":"example.test/app:1"},{"name":"side","image":"example.test/side:1"}]}}`
	jobRunSpec  = `"spec":{"completions":1,"parallelism":1,` + jobTemplate + `}`
	jobStopped  = `"spec":{"completions":1,"parallelism":1,"suspend":true,` + jobTemplate + `}`
	jobNoCount  = `"spec":{` + jobTemplate + `}`
	jobQueue    = `"spec":{"parallelism":3,` + jobTemplate + `}`
	jobActive   = `"status":{"active":1,"startTime":"2026-11-06T11:00:00Z"}`
	jobLeaving  = `,"deletionTimestamp":"2026-11-06T12:00:00Z"`
	jobToFail   = `"status":{"active":1,"failed":1,"startTime":"2026-11-06T11:00:00Z","conditions":[{"type":"FailureTarget","status":"True","reason":"BackoffLimitExceeded"}]}`
	jobToEnd    = `"status":{"active":1,"succeeded":1,"startTime":"2026-11-06T11:00:00Z","conditions":[{"type":"SuccessCriteriaMet","status":"True","reason":"CompletionsReached"}]}`
	jobResumed  = `"status":{"active":1,"startTime":"2026-11-06T11:00:00Z","conditions":[{"type":"Suspended","status":"False"}]}`
	jobHeld     = `"status":{"conditions":[{"type":"Suspended","status":"True"}]}`
	jobDone     = `"status":{"succeeded":1,"startTime":"2026-11-06T11:00:00Z","completionTime":"2026-11-06T11:00:30Z","conditions":[{"type":"Complete","status":"True"}]}`
	jobBroken   = `"status":{"failed":2,"startTime":"2026-11-06T11:00:00Z","conditions":[{"type":"Failed","status":"True","reason":"BackoffLimitExceeded"}]}`
	jobOwned    = jobHead + jobOwner + `},` + jobRunSpec + `,` + jobActive + `}`
	jobFree     = jobHead + `},` + jobRunSpec + `,` + jobActive + `}`
	jobSuspend  = jobHead + jobOwner + `},` + jobStopped + `,` + jobHeld + `}`
	jobFinished = jobHead + jobOwner + `},` + jobRunSpec + `,` + jobDone + `}`
	jobFailed   = jobHead + jobOwner + `},` + jobRunSpec + `,` + jobBroken + `}`
	jobDefaults = jobHead + `},` + jobNoCount + `,` + jobActive + `}`
	jobInQueue  = jobHead + `},` + jobQueue + `,` + jobActive + `}`
	jobDeleting = jobHead + jobLeaving + `},` + jobRunSpec + `,` + jobActive + `}`
	jobDoneGone = jobHead + jobLeaving + `},` + jobRunSpec + `,` + jobDone + `}`
	jobFailing  = jobHead + `},` + jobRunSpec + `,` + jobToFail + `}`
	jobEnding   = jobHead + `},` + jobRunSpec + `,` + jobToEnd + `}`
	jobGoingOn  = jobHead + `},` + jobRunSpec + `,` + jobResumed + `}`

	stsHead     = `{"apiVersion":"apps/v1","kind":"StatefulSet","metadata":{"name":"db","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},`
	stsTemplate = `"selector":{"matchLabels":{"app":"db"}},"serviceName":"db-headless","template":{"metadata":{"labels":{"app":"db"}},"spec":{"containers":[{"name":"db","image":"example.test/db:1"}]}}`
	stsTwo      = `"spec":{"replicas":2,` + stsTemplate + `}`
	stsZero     = `"spec":{"replicas":0,` + stsTemplate + `}`
	stsNew      = `"spec":{"replicas":2,"selector":{"matchLabels":{"app":"db"}},"serviceName":"db-new","template":{"metadata":{"labels":{"app":"db"}},"spec":{"containers":[{"name":"db","image":"example.test/db:2"},{"name":"side","image":"example.test/side:1"}]}}}`
	stsUp       = stsHead + stsTwo + `,"status":{"replicas":2,"readyReplicas":2,"currentReplicas":2,"updatedReplicas":2,"availableReplicas":2}}`
	stsRolling  = stsHead + stsNew + `,"status":{"replicas":2,"readyReplicas":1,"currentReplicas":1,"updatedReplicas":1,"availableReplicas":1}}`
	stsDown     = stsHead + stsTwo + `,"status":{"replicas":2,"readyReplicas":0,"currentReplicas":2,"updatedReplicas":2,"availableReplicas":0}}`
	stsIdle     = stsHead + stsZero + `,"status":{"replicas":0}}`

	tagsOf    = `,"labels":{"team":"a"},"annotations":{"note":"kept"}`
	crHead    = `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRole","metadata":{"name":"reader","creationTimestamp":"2026-11-01T00:00:00Z"`
	crFull    = crHead + tagsOf + `},"rules":[{"apiGroups":[""],"resources":["pods"],"verbs":["get"]},{"nonResourceURLs":["/healthz"],"verbs":["get"]}]}`
	crPlain   = crHead + `}}`
	refBinder = `"roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"reader"}`
	whoBound  = `"subjects":[{"kind":"User","apiGroup":"rbac.authorization.k8s.io","name":"someone@example.test"},{"kind":"ServiceAccount","name":"runner","namespace":"demo"}]`
	crbHead   = `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRoleBinding","metadata":{"name":"readers","creationTimestamp":"2026-11-01T00:00:00Z"`
	crbFull   = crbHead + tagsOf + `},` + refBinder + `,` + whoBound + `}`
	crbNone   = crbHead + `},` + refBinder + `}`
	rbHead    = `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"RoleBinding","metadata":{"name":"readers","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	rbFull    = rbHead + tagsOf + `},` + refBinder + `,` + whoBound + `}`
	rbNone    = rbHead + `},` + refBinder + `}`

	pcHead  = `{"apiVersion":"scheduling.k8s.io/v1","kind":"PriorityClass","metadata":{"name":"high","creationTimestamp":"2026-11-01T00:00:00Z"`
	pcFull  = pcHead + `,"labels":{"team":"a"}},"value":1000,"globalDefault":true,"preemptionPolicy":"Never","description":"for the front"}`
	pcPlain = pcHead + `},"value":1000}`

	rcHead = `{"apiVersion":"node.k8s.io/v1","kind":"RuntimeClass","metadata":{"name":"gvisor","creationTimestamp":"2026-11-01T00:00:00Z"`
	rcFull = rcHead + `,"labels":{"team":"a"}},"handler":"runsc","overhead":{"podFixed":{"cpu":"250m","memory":"1024Mi"}},
		"scheduling":{"nodeSelector":{"sandbox":"yes"},"tolerations":[{"key":"sandbox","operator":"Exists","effect":"NoSchedule"}]}}`
	rcPlain = rcHead + `},"handler":"runsc"}`

	whMeta = `"metadata":{"name":"policy","creationTimestamp":"2026-11-01T00:00:00Z"`
	// a CA bundle as the API server sends it: not a secret, but a row counts the webhooks and does not carry them
	whCA    = "ZmFrZS1jYS1idW5kbGUtZm9yLXRlc3Rz"
	vwcFull = `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingWebhookConfiguration",` + whMeta + `,"labels":{"team":"a"}},"webhooks":[` + whEntryOne + `,` + whEntryTwo + `]}`
	vwcNone = `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingWebhookConfiguration",` + whMeta + `}}`
	mwcFull = `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"MutatingWebhookConfiguration",` + whMeta + `,"labels":{"team":"a"}},"webhooks":[` + whEntryOne + `,` + whEntryTwo + `]}`
	mwcNone = `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"MutatingWebhookConfiguration",` + whMeta + `}}`

	whEntryOne = `{"name":"one.example.test","clientConfig":{"url":"https://hook.example.test/","caBundle":"` + whCA + `"},"rules":[{"apiGroups":["example.test"],"apiVersions":["v1"],"operations":["CREATE"],"resources":["things"]}],"sideEffects":"None","admissionReviewVersions":["v1"]}`
	whEntryTwo = `{"name":"two.example.test","clientConfig":{"url":"https://hook.example.test/","caBundle":"` + whCA + `"},"rules":[{"apiGroups":["example.test"],"apiVersions":["v1"],"operations":["CREATE"],"resources":["things"]}],"sideEffects":"None","admissionReviewVersions":["v1"]}`

	leaseHead = `{"apiVersion":"coordination.k8s.io/v1","kind":"Lease","metadata":{"name":"node-a","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	leaseHeld = leaseHead + `,"labels":{"team":"a"}},"spec":{"holderIdentity":"node-a","leaseDurationSeconds":40,"leaseTransitions":3,"acquireTime":"2026-11-05T00:00:00.123456Z","renewTime":"2026-11-06T11:59:50.654321Z"}}`
	leaseMore = leaseHead + `,"labels":{"team":"a"}},"spec":{"holderIdentity":"node-b","leaseDurationSeconds":15,"leaseTransitions":4,"acquireTime":"2026-11-06T12:00:00.000000Z","renewTime":"2026-11-06T12:00:00.000000Z"}}`
	leaseFree = leaseHead + `},"spec":{}}`

	lrHead = `{"apiVersion":"v1","kind":"LimitRange","metadata":{"name":"limits","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	lrFull = lrHead + `,"labels":{"team":"a"}},"spec":{"limits":[{"type":"Container","default":{"cpu":"500m"},"defaultRequest":{"memory":"1024Mi"},"max":{"cpu":"2"},"min":{"cpu":"10m"}},{"type":"Pod","max":{"memory":"2Gi"}}]}}`
	lrOne  = lrHead + `},"spec":{"limits":[{"type":"PersistentVolumeClaim","max":{"storage":"100Gi"}}]}}`
	lrNone = lrHead + `},"spec":{"limits":[]}}`

	rqHead = `{"apiVersion":"v1","kind":"ResourceQuota","metadata":{"name":"quota","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	rqFull = rqHead + `,"labels":{"team":"a"}},"spec":{"hard":{"pods":"10","requests.memory":"1024Mi"}},"status":{"hard":{"pods":"10","requests.memory":"1024Mi"},"used":{"pods":"3","requests.memory":"512Mi"}}}`
	rqOne  = rqHead + `},"spec":{"hard":{"pods":"20"}},"status":{"hard":{"pods":"20"},"used":{"pods":"4"}}}`
	rqNone = rqHead + `},"spec":{"hard":{"pods":"20"}}}`

	pdbHead    = `{"apiVersion":"policy/v1","kind":"PodDisruptionBudget","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"`
	pdbHealthy = `"status":{"currentHealthy":3,"desiredHealthy":2,"disruptionsAllowed":1,"expectedPods":3}`
	pdbMin     = pdbHead + `,"labels":{"team":"a"}},"spec":{"minAvailable":2,"selector":{"matchLabels":{"app":"web"}},"unhealthyPodEvictionPolicy":"AlwaysAllow"},` + pdbHealthy + `}`
	pdbMax     = pdbHead + `},"spec":{"maxUnavailable":"50%","selector":{"matchExpressions":[{"key":"app","operator":"In","values":["web"]}]}},` + pdbHealthy + `}`
	pdbNoPods  = pdbHead + `},"spec":{"minAvailable":"50%"},"status":{"currentHealthy":0,"desiredHealthy":0,"disruptionsAllowed":0,"expectedPods":0}}`

	crdHead = `{"apiVersion":"apiextensions.k8s.io/v1","kind":"CustomResourceDefinition","metadata":{"name":"widgets.example.test","creationTimestamp":"2026-11-01T00:00:00Z"`
	crdSpec = `"group":"example.test","scope":"Namespaced","names":{"kind":"Widget","plural":"widgets"}`
	crdTwo  = crdHead + `,"labels":{"team":"a"},"annotations":{"note":"kept"}},"spec":{` + crdSpec + `,"versions":[{"name":"v1beta1","served":true,"storage":false},{"name":"v1","served":true,"storage":true}]}}`
	crdOne  = crdHead + `},"spec":{` + crdSpec + `,"versions":[{"name":"v1beta1","served":false,"storage":false},{"name":"v1","served":true,"storage":true}]}}`
)

type watchRowSource struct {
	name, resource, before, after string
	// what the page shows once the update is applied, written by hand so a wrong row on both sides still fails
	shows map[string]interface{}
}

func watchRowSources() []watchRowSource {
	ingressShows := func(class, hosts, backends, addresses, rules string, tls int) map[string]interface{} {
		return map[string]interface{}{"class": class, "hosts": hosts, "backends": backends, "addresses": addresses, "rules": rules, "tls": tls}
	}
	vaShows := func(attached bool, status, errorText string) map[string]interface{} {
		return map[string]interface{}{"attached": attached, "status": status, "error": errorText}
	}
	cronShows := func(schedule string, suspend bool, active int, policy, lastSchedule, lastSuccessful, zone, containers, images interface{}) map[string]interface{} {
		return map[string]interface{}{
			"schedule": schedule, "suspend": suspend, "active": active, "concurrency_policy": policy,
			"last_schedule_time": lastSchedule, "last_successful_time": lastSuccessful, "time_zone": zone,
			"containers": containers, "images": images,
		}
	}
	svcShows := func(typ, clusterIP, externalIP, ports, selector string) map[string]interface{} {
		return map[string]interface{}{"type": typ, "cluster_ip": clusterIP, "external_ip": externalIP, "ports": ports, "selector": selector}
	}
	epShows := func(ready, notReady int, addresses, ports string) map[string]interface{} {
		return map[string]interface{}{"ready": ready, "not_ready": notReady, "addresses": addresses, "ports": ports}
	}
	icShows := func(isDefault bool, parameters string, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"controller": "example.test/nginx", "default": isDefault, "parameters": parameters, "labels": labels}
	}
	noTags := map[string]interface{}{}
	teamA := map[string]interface{}{"team": "a"}
	// the drawer's lines of the rules: who, then which ports
	npRuleLines := map[string][]interface{}{
		"ingress": {"pods role=client in this namespace ; every pod in namespaces team=back ; pods tier in (a,b) in every namespace ; addresses 10.0.0.0/8 (except 10.1.0.0/16) | TCP 8000-9000, UDP dns"},
		"egress":  {"pods app=db in namespaces team=db | TCP 5432"},
	}
	npShows := func(selector string, ingress, egress []interface{}, deny string, labels, annotations map[string]interface{}, finalizers []interface{}) map[string]interface{} {
		return map[string]interface{}{
			"pod_selector": selector, "types": "Ingress, Egress", "ingress_rules": len(ingress), "egress_rules": len(egress),
			"default_deny": deny, "ingress": ingress, "egress": egress, "labels": labels, "annotations": annotations, "finalizers": finalizers,
		}
	}
	note := map[string]interface{}{"note": "kept"}
	keep := []interface{}{"example.test/keep"}
	none := []interface{}{}
	depShows := func(ready string, updated, available int, status, title, badge, bucket, image string, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{
			"ready": ready, "updated": updated, "available": available, "status": status, "title": title,
			"badge": badge, "bucket": bucket, "image": image, "labels": labels,
		}
	}
	rsShows := func(current, desired, ready, available int, status, owner string) map[string]interface{} {
		return map[string]interface{}{
			"current": current, "desired": desired, "ready": ready, "available": available, "status": status,
			"containers": "app", "images": "example.test/app:1", "selector": "app=web", "owner": owner,
		}
	}
	hpaShows := func(replicas string, active bool, lastScale interface{}, metrics []interface{}, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{
			"reference": "Deployment/web", "min": 2, "max": 5, "replicas": replicas, "scaling_active": active,
			"last_scale_time": lastScale, "metrics": metrics, "labels": labels,
		}
	}
	// each metric's type and name, its target, and what the controller last read
	hpaReadLines := []interface{}{"Resource cpu 80 60", "Pods qps 10 7", "Object rps 100 90", "External queue 5 3", "ContainerResource memory 1Gi 500Mi"}
	hpaUnreadLines := []interface{}{"Resource cpu 80 -", "Pods qps 10 -", "Object rps 100 -", "External queue 5 -", "ContainerResource memory 1Gi -"}
	cmShows := func(count int, keys, binary []interface{}, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"data_count": count, "data_keys": keys, "binary_keys": binary, "labels": labels}
	}
	secretShows := func(count int, keys []interface{}, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"type": "Opaque", "data_count": count, "data_keys": keys, "labels": labels}
	}
	saShows := func(count int, secrets, pullSecrets []interface{}, withPullSecrets bool, labels, annotations map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{
			"secrets": count, "secrets_list": secrets, "image_pull_secrets": pullSecrets, "with_pull_secrets": withPullSecrets,
			"labels": labels, "annotations": annotations,
		}
	}
	roleShows := func(rules int, labels, annotations map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"rules_count": rules, "labels": labels, "annotations": annotations}
	}
	pvShows := func(status, class, claim, source, reason, message string) map[string]interface{} {
		return map[string]interface{}{
			"status": status, "storage_class": class, "capacity": "1Gi", "access_modes": "ReadWriteOnce", "reclaim_policy": "Retain",
			"claim": claim, "volume_mode": "Filesystem", "source": source, "reason": reason, "message": message,
		}
	}
	noNames := []interface{}{}
	ofDeploy := []interface{}{"ReplicaSet/web-abc"}
	appWeb := map[string]interface{}{"app": "web"}
	podShows := func(status, phase, ready string, restarts int, owners []interface{}, labels map[string]interface{}, reason, message, health string) map[string]interface{} {
		return map[string]interface{}{
			"status": status, "phase": phase, "ready": ready, "restarts": restarts, "node": "node-a",
			"owners": owners, "labels": labels, "reason": reason, "message": message, "health": health,
			"config_map_refs": noNames, "secret_refs": noNames, "service_account": "-", "claims": noNames,
		}
	}
	with := func(shows map[string]interface{}, more map[string]interface{}) map[string]interface{} {
		for k, v := range more {
			shows[k] = v
		}
		return shows
	}
	dsShows := func(ready string, current, desired, updated, available int, status, selector, images string) map[string]interface{} {
		return map[string]interface{}{
			"ready": ready, "current": current, "desired": desired, "updated": updated, "available": available,
			"status": status, "node_selector": selector, "images": images,
		}
	}
	jobShows := func(completions, status, badge, duration, start string, owners []interface{}) map[string]interface{} {
		return map[string]interface{}{
			"completions": completions, "status": status, "badge": badge, "duration": duration, "start_time": start,
			"owners": owners, "containers": "app, side", "images": "example.test/app:1, example.test/side:1",
		}
	}
	ofCronJob := []interface{}{"CronJob/daily"}
	stsShows := func(ready, updated string, available int, status, service, images string) map[string]interface{} {
		return map[string]interface{}{"ready": ready, "updated": updated, "available": available, "status": status, "service": service, "images": images}
	}
	crShows := func(rules int, labels, annotations map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"rules_count": rules, "labels": labels, "annotations": annotations}
	}
	bindingShows := func(count int, subjects []interface{}, labels, annotations map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"role": "ClusterRole/reader", "subjects_count": count, "subjects": subjects, "labels": labels, "annotations": annotations}
	}
	bound := []interface{}{"User/someone@example.test", "ServiceAccount/runner"}
	pcShows := func(global bool, preemption, description string, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"value": 1000, "global_default": global, "preemption_policy": preemption, "description": description, "labels": labels}
	}
	rcShows := func(overhead, selector map[string]interface{}, tolerations int, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"handler": "runsc", "overhead": overhead, "node_selector": selector, "tolerations": tolerations, "labels": labels}
	}
	whShows := func(count int, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"webhooks_count": count, "labels": labels}
	}
	leaseShows := func(holder string, duration, transitions, renew, acquire interface{}, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"holder": holder, "duration": duration, "transitions": transitions, "renew_time": renew, "acquire_time": acquire, "labels": labels}
	}
	lrShows := func(types string, limits []interface{}, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"types": types, "limits": limits, "labels": labels}
	}
	rqShows := func(requests int, hard, used, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"requests": requests, "hard": hard, "used": used, "labels": labels}
	}
	pdbShows := func(min, max string, allowed int, current string, desired, expected int, selector string, labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{
			"min_available": min, "max_unavailable": max, "allowed": allowed, "current": current, "desired": desired, "expected": expected,
			"selector": selector, "labels": labels,
		}
	}
	crdShows := func(versions string, labels, annotations map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"group": "example.test", "versions": versions, "scope": "Namespaced", "kind": "Widget", "labels": labels, "annotations": annotations}
	}
	return []watchRowSource{
		{"a ClusterRole whose rules, labels and annotations went away shows none", "clusterroles", crFull, crPlain, crShows(0, noTags, noTags)},
		{"a ClusterRole that gained them shows them", "clusterroles", crPlain, crFull, crShows(2, teamA, note)},
		{"a ClusterRoleBinding whose subjects, labels and annotations went away shows none", "clusterrolebindings", crbFull, crbNone, bindingShows(0, none, noTags, noTags)},
		{"a ClusterRoleBinding that gained them shows them", "clusterrolebindings", crbNone, crbFull, bindingShows(2, bound, teamA, note)},
		{"a RoleBinding whose subjects, labels and annotations went away shows none", "rolebindings", rbFull, rbNone, bindingShows(0, none, noTags, noTags)},
		{"a RoleBinding that gained them shows them", "rolebindings", rbNone, rbFull, bindingShows(2, bound, teamA, note)},
		{"a PriorityClass no longer the default, its description and labels gone, says so", "priorityclasses", pcFull, pcPlain, pcShows(false, "PreemptLowerPriority", "", noTags)},
		{"a PriorityClass that gained them shows them", "priorityclasses", pcPlain, pcFull, pcShows(true, "Never", "for the front", teamA)},
		{"a RuntimeClass whose overhead, scheduling and labels went away shows none", "runtimeclasses", rcFull, rcPlain, rcShows(nil, nil, 0, noTags)},
		{"a RuntimeClass that gained them shows them", "runtimeclasses", rcPlain, rcFull, rcShows(map[string]interface{}{"cpu": "250m", "memory": "1Gi"}, map[string]interface{}{"sandbox": "yes"}, 1, teamA)},
		{"a ValidatingWebhookConfiguration left with no webhook counts none, its labels gone", "validatingwebhookconfigurations", vwcFull, vwcNone, whShows(0, noTags)},
		{"a ValidatingWebhookConfiguration that gained webhooks counts them", "validatingwebhookconfigurations", vwcNone, vwcFull, whShows(2, teamA)},
		{"a MutatingWebhookConfiguration left with no webhook counts none, its labels gone", "mutatingwebhookconfigurations", mwcFull, mwcNone, whShows(0, noTags)},
		{"a MutatingWebhookConfiguration that gained webhooks counts them", "mutatingwebhookconfigurations", mwcNone, mwcFull, whShows(2, teamA)},
		{"a Lease its holder let go of shows no holder, duration or times", "leases", leaseHeld, leaseFree, leaseShows("-", "-", "-", nil, nil, noTags)},
		{"a Lease that was taken shows its holder with its times to the second", "leases", leaseFree, leaseHeld, leaseShows("node-a", 40, 3, "2026-11-06T11:59:50Z", "2026-11-05T00:00:00Z", teamA)},
		{"a Lease that changed hands shows the new holder and times", "leases", leaseHeld, leaseMore, leaseShows("node-b", 15, 4, "2026-11-06T12:00:00Z", "2026-11-06T12:00:00Z", teamA)},
		{"a LimitRange left with no limit lists no type, its labels gone", "limitranges", lrFull, lrNone, lrShows("-", none, noTags)},
		{"a LimitRange of other limits lists only those", "limitranges", lrFull, lrOne, lrShows("PersistentVolumeClaim", []interface{}{"PersistentVolumeClaim max storage=100Gi"}, noTags)},
		{"a LimitRange that gained limits lists each with its values", "limitranges", lrNone, lrFull, lrShows("Container, Pod", []interface{}{"Container default cpu=500m defaultRequest memory=1Gi max cpu=2 min cpu=10m", "Pod max memory=2Gi"}, teamA)},
		{"a ResourceQuota the controller has not counted yet shows nothing used, its labels gone", "resourcequotas", rqFull, rqNone, rqShows(0, noTags, noTags, noTags)},
		{"a ResourceQuota left with one limit counts only it", "resourcequotas", rqFull, rqOne, rqShows(1, map[string]interface{}{"pods": "20"}, map[string]interface{}{"pods": "4"}, noTags)},
		{"a ResourceQuota the controller counted shows what is used", "resourcequotas", rqNone, rqFull, rqShows(2, map[string]interface{}{"pods": "10", "requests.memory": "1Gi"}, map[string]interface{}{"pods": "3", "requests.memory": "512Mi"}, teamA)},
		{"a PodDisruptionBudget moved from min available to max unavailable shows only that, its labels gone", "poddisruptionbudgets", pdbMin, pdbMax, pdbShows("-", "50%", 1, "3/2", 2, 3, "-", noTags)},
		{"a PodDisruptionBudget moved back shows min available and its selector", "poddisruptionbudgets", pdbMax, pdbMin, pdbShows("2", "-", 1, "3/2", 2, 3, "app=web", teamA)},
		{"a PodDisruptionBudget with no pods left counts none, with no selector", "poddisruptionbudgets", pdbMin, pdbNoPods, pdbShows("50%", "-", 0, "0/0", 0, 0, "-", noTags)},
		{"a CustomResourceDefinition no longer serving a version lists only the served one", "customresourcedefinitions", crdTwo, crdOne, crdShows("v1 (storage)", noTags, noTags)},
		{"a CustomResourceDefinition that serves a version again lists both", "customresourcedefinitions", crdOne, crdTwo, crdShows("v1 (storage), v1beta1", teamA, note)},
		{"a pod being deleted reads Terminating, whatever its containers do", "pods", podOfDeploy, podDeleting, podShows("Terminating", "Running", "1/1", 2, ofDeploy, appWeb, "-", "-", "warn Terminating")},
		{"a pod past its crash loop keeps no reason or message of it", "pods", podCrashLoop, podOfDeploy, podShows("Running", "Running", "1/1", 2, ofDeploy, appWeb, "-", "-", "ok Running")},
		{"a pod in a crash loop says why", "pods", podOfDeploy, podCrashLoop, podShows("CrashLoopBackOff", "Running", "0/1", 3, ofDeploy, appWeb, "CrashLoopBackOff", "back-off restarting", "error CrashLoopBackOff")},
		{"a pod its controller let go of names no owner and no labels", "pods", podOfDeploy, podBare, podShows("Running", "Running", "1/1", 2, noNames, noTags, "-", "-", "ok Running")},
		{"a pod that holds no reference lists none, whatever the row before it listed", "pods", podAllRefs, podOfDeploy, podShows("Running", "Running", "1/1", 2, ofDeploy, appWeb, "-", "-", "ok Running")},
		{"a pod that holds references lists each once, in order", "pods", podOfDeploy, podAllRefs, with(podShows("Running", "Running", "1/1", 2, ofDeploy, appWeb, "-", "-", "ok Running"), map[string]interface{}{
			"config_map_refs": []interface{}{"conf-env", "conf-from", "conf-proj", "conf-vol"},
			"secret_refs":     []interface{}{"creds-env", "creds-from", "creds-proj", "creds-vol", "registry"},
			"service_account": "runner",
		})},
		{"a pod whose init container failed reads Init:Error with its restarts", "pods", podOfDeploy, podInitError, podShows("Init:Error", "Pending", "0/1", 4, ofDeploy, appWeb, "PodInitializing", "-", "error Error")},
		{"a pod with a sidecar counts it in READY and RESTARTS", "pods", podOfDeploy, podWithSide, podShows("Running", "Running", "2/2", 3, ofDeploy, appWeb, "-", "-", "ok Running")},
		{"a pod whose sidecar is up but not ready warns, as READY says", "pods", podOfDeploy, podSideUnfit, podShows("Running", "Running", "1/2", 2, ofDeploy, appWeb, "-", "-", "warn NotReady")},
		{"a pod whose sidecar has not started is still initializing", "pods", podOfDeploy, podSideStart, podShows("Init:0/1", "Running", "0/2", 0, ofDeploy, appWeb, "PodInitializing", "-", "warn PodInitializing")},
		{"a pod whose sidecar crashes is an error", "pods", podOfDeploy, podSideCrash, podShows("Init:CrashLoopBackOff", "Running", "1/2", 5, ofDeploy, appWeb, "-", "-", "error CrashLoopBackOff")},
		{"a pod being deleted on a node that stopped answering reads Unknown", "pods", podOfDeploy, podLostNode, podShows("Unknown", "Running", "1/1", 2, ofDeploy, appWeb, "NodeLost", "node stopped answering", "warn Terminating")},
		{"a failed pod whose container names only its exit code prints that", "pods", podOfDeploy, podExited, podShows("ExitCode:2", "Failed", "0/1", 0, ofDeploy, appWeb, "-", "-", "error Failed")},
		{"a pod that holds a claim and a template lists both", "pods", podOfDeploy, podWithClaims, with(podShows("Running", "Running", "1/1", 2, ofDeploy, appWeb, "-", "-", "ok Running"), map[string]interface{}{"claims": []interface{}{"claim-a", "template-a"}})},
		{"a DaemonSet whose node selector went away shows none, with its new images", "daemonsets", dsPicky, dsAny, dsShows("3/3", 3, 3, 3, 3, "Healthy", "-", "example.test/app:2, example.test/side:1")},
		{"a DaemonSet that gained a node selector shows it", "daemonsets", dsAny, dsPicky, dsShows("3/3", 3, 3, 3, 3, "Healthy", "disk=ssd", "example.test/app:1")},
		{"a DaemonSet with a pod down is Degraded", "daemonsets", dsPicky, dsDown, dsShows("2/3", 3, 3, 1, 2, "Degraded", "disk=ssd", "example.test/app:1")},
		{"a DaemonSet with none available is Unavailable, however many read ready", "daemonsets", dsPicky, dsNone, dsShows("1/3", 3, 3, 3, 0, "Unavailable", "disk=ssd", "example.test/app:1")},
		{"a DaemonSet with no node to run on is Idle", "daemonsets", dsPicky, dsIdle, dsShows("0/0", 0, 0, 0, 0, "Idle", "disk=ssd", "example.test/app:1")},
		{"a Job its CronJob let go of names no owner", "jobs", jobOwned, jobFree, jobShows("0/1", "Running", "badge-success", "60m", "2026-11-06T11:00:00Z", noNames)},
		{"a suspended Job reads Suspended, with no start time or duration left", "jobs", jobOwned, jobSuspend, jobShows("0/1", "Suspended", "badge-warning", "-", "-", ofCronJob)},
		{"a Job resumed, its Suspended condition false, is running", "jobs", jobSuspend, jobGoingOn, jobShows("0/1", "Running", "badge-success", "60m", "2026-11-06T11:00:00Z", noNames)},
		{"a Job being deleted reads Terminating", "jobs", jobFree, jobDeleting, jobShows("0/1", "Terminating", "badge-warning", "60m", "2026-11-06T11:00:00Z", noNames)},
		{"a finished Job being deleted still reads Complete", "jobs", jobFinished, jobDoneGone, jobShows("1/1", "Complete", "badge-success", "30s", "2026-11-06T11:00:00Z", noNames)},
		{"a Job on its way to Failed reads FailureTarget", "jobs", jobFree, jobFailing, jobShows("0/1", "FailureTarget", "badge-error", "60m", "2026-11-06T11:00:00Z", noNames)},
		{"a Job on its way to Complete reads SuccessCriteriaMet", "jobs", jobFree, jobEnding, jobShows("1/1", "SuccessCriteriaMet", "badge-success", "60m", "2026-11-06T11:00:00Z", noNames)},
		{"a work queue of three counts one of three", "jobs", jobFree, jobInQueue, jobShows("0/1 of 3", "Running", "badge-success", "60m", "2026-11-06T11:00:00Z", noNames)},
		{"a Job that finished says so with its run time", "jobs", jobOwned, jobFinished, jobShows("1/1", "Complete", "badge-success", "30s", "2026-11-06T11:00:00Z", ofCronJob)},
		{"a Job that failed says so and runs to now", "jobs", jobOwned, jobFailed, jobShows("0/1", "Failed", "badge-error", "60m", "2026-11-06T11:00:00Z", ofCronJob)},
		{"a Job with no completions set wants one", "jobs", jobFree, jobDefaults, jobShows("0/1", "Running", "badge-success", "60m", "2026-11-06T11:00:00Z", noNames)},
		{"a StatefulSet rolling out shows its new service name and images", "statefulsets", stsUp, stsRolling, stsShows("1/2", "1/2", 1, "Degraded", "db-new", "example.test/db:2, example.test/side:1")},
		{"a StatefulSet with none available is Unavailable", "statefulsets", stsUp, stsDown, stsShows("0/2", "2/2", 0, "Unavailable", "db-headless", "example.test/db:1")},
		{"a StatefulSet scaled to none is Idle", "statefulsets", stsUp, stsIdle, stsShows("0/0", "0/0", 0, "Idle", "db-headless", "example.test/db:1")},
		{"an Ingress left with only its default backend shows no host, class, address or TLS", "ingresses", ingressWeb, ingressDefaultBackendOnly, ingressShows("-", "-", "-", "-", "-", 0)},
		{"an Ingress whose class annotation went away shows no class", "ingresses", ingressAnnotatedClass, ingressNoClass, ingressShows("-", "example.test", "-", "-", "example.test:/*", 0)},
		{"an Ingress that gained its rules, address and TLS shows them", "ingresses", ingressEmpty, ingressFull, ingressShows("traefik", "b.example.test, a.example.test", "alpha, zeta", "lb.example.test", "b.example.test:/b, a.example.test:/a", 1)},
		{"a VolumeAttachment that recovered is Attached with no error left", "volumeattachments", vaFailed, vaOK, vaShows(true, "Attached", "-")},
		{"a VolumeAttachment that failed to attach shows the error", "volumeattachments", vaOK, vaFailed, vaShows(false, "Error", "attach failed")},
		{"a VolumeAttachment that finished detaching is Detached with no error left", "volumeattachments", vaDetErr, vaOff, vaShows(false, "Detached", "-")},
		{"a VolumeAttachment with no status yet is not attached", "volumeattachments", vaOK, vaNoStat, vaShows(false, "Detached", "-")},
		{"a CronJob whose time zone was cleared shows none, with its new run times", "cronjobs", cronOld, cronNoZone, cronShows("0 9 * * *", false, 0, "Allow", "2026-11-06T09:00:00Z", "2026-11-06T09:01:00Z", nil, "app", "example.test/app:1")},
		{"a CronJob whose time zone changed shows the new one", "cronjobs", cronOld, cronUTC, cronShows("0 9 * * *", false, 0, "Allow", "2026-11-06T09:00:00Z", "2026-11-06T09:01:00Z", "Etc/UTC", "app", "example.test/app:1")},
		{"a CronJob whose status lost its run times shows none", "cronjobs", cronOld, cronNoRuns, cronShows("0 9 * * *", false, 0, "Allow", nil, nil, "Asia/Seoul", "app", "example.test/app:1")},
		{"a CronJob whose schedule, policy and containers changed shows the new ones", "cronjobs", cronOld, cronOther, cronShows("30 1 * * *", true, 0, "Forbid", nil, nil, nil, "new, side", "example.test/new:2, example.test/side:1")},
		{"a Service that became ExternalName shows its name, no cluster IP, port or selector", "services", svcPlain, svcExternalName, svcShows("ExternalName", "-", "db.example.test", "-", "-")},
		{"a Service whose load balancer and node port went away shows neither", "services", svcBalanced, svcPlain, svcShows("ClusterIP", "10.0.0.1", "<none>", "TCP 80->8080", "app=web")},
		{"a Service that gained a load balancer shows its addresses before its external IPs", "services", svcPlain, svcBalanced, svcShows("LoadBalancer", "10.0.0.1", "192.0.2.1,lb.example.test,192.0.2.9", "TCP 80->http (node:30080)", "app=web")},
		{"a LoadBalancer with no address yet reads pending", "services", svcPlain, svcPending, svcShows("LoadBalancer", "10.0.0.1", "<pending>", "TCP 80->http (node:30080)", "app=web")},
		{"a LoadBalancer with no address and external IPs reads the IPs", "services", svcPending, svcPendingWithIPs, svcShows("LoadBalancer", "10.0.0.1", "192.0.2.9", "TCP 80->http (node:30080)", "app=web")},
		{"a ClusterIP Service with external IPs reads them in order", "services", svcPlain, svcClusterIPs, svcShows("ClusterIP", "10.0.0.1", "192.0.2.9,192.0.2.1", "TCP 80->8080", "app=web")},
		{"a Service whose selector alone changed keeps every other cell", "services", svcPlain, svcOtherSelector, svcShows("ClusterIP", "10.0.0.1", "<none>", "TCP 80->8080", "app=new")},
		{"Endpoints with no subsets left show no address or port", "endpoints", epFull, epNone, epShows(0, 0, "-", "-")},
		{"Endpoints whose not-ready address became ready list it once", "endpoints", epFull, epAllReady, epShows(2, 0, "10.0.0.1, 10.0.0.2", "http:80/TCP")},
		{"Endpoints that gained their addresses show them", "endpoints", epNone, epFull, epShows(1, 1, "10.0.0.1 | not-ready: 10.0.0.2", "http:80/TCP")},
		{"an IngressClass no longer the default, its parameters and labels gone, says so", "ingressclasses", icFull, icPlain, icShows(false, "-", noTags)},
		{"an IngressClass that gained parameters and the default mark shows them", "ingressclasses", icPlain, icFull, icShows(true, "Params.example.test/p (Namespace) ns=demo", teamA)},
		{"a NetworkPolicy whose rules went away shows none and keeps its labels and finalizers", "networkpolicies", npRules, npNoRules, npShows("*", []interface{}{}, []interface{}{}, "Ingress + Egress", teamA, note, keep)},
		{"a NetworkPolicy that gained its rules words them as the object has them", "networkpolicies", npNoRules, npRules, npShows("app=web", npRuleLines["ingress"], npRuleLines["egress"], "-", teamA, note, keep)},
		{"a NetworkPolicy whose labels, annotations and finalizers went away shows none", "networkpolicies", npRules, npRulesNoTags, npShows("app=web", npRuleLines["ingress"], npRuleLines["egress"], "-", noTags, noTags, none)},
		{"a Deployment whose rollout recovered is Available with no reason left, its labels gone", "deployments", depStuckAll, depOKPlain, depShows("2/2", 2, 2, "Available", "Available", "badge-success", "healthy", "example.test/app:1", noTags)},
		{"a Deployment past its progress deadline is Failed with the reason while its old pods stay available", "deployments", depOKTagged, depStuckAll, depShows("2/3", 1, 2, "Failed", "Failed: ProgressDeadlineExceeded", "badge-error", "unavailable", "example.test/app:2", teamA)},
		{"a Deployment starting a rollout with none available is Progressing, drawn as unavailable", "deployments", depOKTagged, depStartAll, depShows("0/3", 1, 0, "Progressing", "Progressing", "badge-error", "unavailable", "example.test/app:2", teamA)},
		{"a Deployment that came out of a stuck rollout keeps no count or reason of it", "deployments", depStuckAll, depOKTagged, depShows("2/2", 2, 2, "Available", "Available", "badge-success", "healthy", "example.test/app:1", teamA)},
		{"a ReplicaSet freed of its owner shows none", "replicasets", rsOwned, rsFree, rsShows(2, 2, 2, 2, "Healthy", "-")},
		{"a ReplicaSet another controller took names it by kind", "replicasets", rsFree, rsTaken, rsShows(2, 2, 2, 2, "Healthy", "Rollout/web")},
		{"a ReplicaSet that lost its available pods is Unavailable", "replicasets", rsOwned, rsNoneReady, rsShows(2, 2, 0, 0, "Unavailable", "web")},
		{"a ReplicaSet scaled to none is Idle with no count left", "replicasets", rsOwned, rsScaledDown, rsShows(0, 0, 0, 0, "Idle", "web")},
		{"an HPA that lost its readings, last scale and labels shows none", "horizontalpodautoscalers", hpaFull, hpaNotRead, hpaShows("3/-", false, nil, hpaUnreadLines, noTags)},
		{"an HPA that read its metrics shows every reading and target", "horizontalpodautoscalers", hpaNotRead, hpaFull, hpaShows("3/4", true, "2026-11-05T00:00:00Z", hpaReadLines, teamA)},
		{"an HPA with no metric left says what the controller wants", "horizontalpodautoscalers", hpaNotRead, hpaNoMetrics, hpaShows("3/0", false, nil, none, noTags)},
		{"a ConfigMap whose keys all went away lists none", "configmaps", cmFull, cmNone, cmShows(0, none, none, noTags)},
		{"a ConfigMap left with one key lists only it", "configmaps", cmFull, cmOne, cmShows(1, []interface{}{"only"}, none, noTags)},
		{"a ConfigMap that gained keys lists them in order", "configmaps", cmNone, cmFull, cmShows(2, []interface{}{"a", "b"}, []interface{}{"c"}, teamA)},
		{"a Secret whose keys all went away lists none", "secrets", secretFull, secretNone, secretShows(0, none, noTags)},
		{"a Secret that gained keys lists their names in order", "secrets", secretNone, secretFull, secretShows(2, []interface{}{"password", "user"}, teamA)},
		{"a ServiceAccount that lost its secrets and pull secrets lists none", "serviceaccounts", saFull, saPlain, saShows(0, none, none, false, noTags, noTags)},
		{"a ServiceAccount that gained them lists them", "serviceaccounts", saPlain, saFull, saShows(1, []interface{}{"runner-token"}, []interface{}{"registry"}, true, teamA, note)},
		{"a Role whose rules, labels and annotations went away shows none", "roles", roleFull, rolePlain, roleShows(0, noTags, noTags)},
		{"a Role that gained them shows them", "roles", rolePlain, roleFull, roleShows(2, teamA, note)},
		{"a PersistentVolume freed of its claim shows no claim, class, reason or message", "persistentvolumes", pvFailed, pvFree, pvShows("Available", "-", "-", "HostPath", "-", "-")},
		{"a PersistentVolume that bound shows its claim and source", "persistentvolumes", pvFree, pvBound, pvShows("Bound", "fast", "demo/claim-a", "CSI", "-", "-")},
		{"a PersistentVolume that failed shows why and keeps every other cell", "persistentvolumes", pvBound, pvFailed, pvShows("Failed", "fast", "demo/claim-a", "CSI", "Broken", "disk gone")},
	}
}

// listAPI answers every list with the one object it holds, as an API server does, and hands back the row the list
// endpoint makes of it.
type listAPI struct {
	mu     sync.Mutex
	object string
	svc    *k8s.Service
}

type oneClusterRegistry struct{ info cluster.Info }

func (r oneClusterRegistry) List(context.Context) ([]cluster.Info, error) {
	return []cluster.Info{r.info}, nil
}
func (r oneClusterRegistry) Get(context.Context, cluster.ID) (*cluster.Info, error) {
	return &r.info, nil
}
func (r oneClusterRegistry) Default(context.Context) (cluster.ID, error) { return r.info.ID, nil }

func newListAPI(t *testing.T) *listAPI {
	t.Helper()
	a := &listAPI{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		var meta struct{ APIVersion, Kind string }
		if err := json.Unmarshal([]byte(a.object), &meta); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"apiVersion":%q,"kind":%q,"metadata":{},"items":[%s]}`, meta.APIVersion, meta.Kind+"List", a.object)
	}))
	t.Cleanup(server.Close)
	kubeconfig := `apiVersion: v1
kind: Config
clusters: [{name: t, cluster: {server: "` + server.URL + `"}}]
contexts: [{name: t, context: {cluster: t, user: t}}]
current-context: t
users: [{name: t, user: {token: not-a-real-token}}]
`
	reg := oneClusterRegistry{cluster.Info{ID: "t", Mode: cluster.ModeExternal, KubeconfigBlob: kubeconfig}}
	svc, err := k8s.NewService(context.Background(), reg, false, nil, k8s.ServiceOptions{MaxClusters: 2})
	if err != nil {
		t.Fatal(err)
	}
	a.svc = svc
	return a
}

func (a *listAPI) row(t *testing.T, resource, object string) map[string]interface{} {
	t.Helper()
	a.mu.Lock()
	a.object = object
	a.mu.Unlock()
	ctx := context.Background()
	var rows []map[string]interface{}
	var err error
	switch resource {
	case "ingresses":
		rows, err = a.svc.GetIngresses(ctx, "demo")
	case "volumeattachments":
		rows, err = a.svc.GetVolumeAttachments(ctx)
	case "cronjobs":
		rows, err = a.svc.GetCronJobs(ctx, "demo")
	case "services":
		rows, err = a.svc.GetServices(ctx, "demo")
	case "endpoints":
		rows, err = a.svc.GetEndpoints(ctx, "demo")
	case "ingressclasses":
		rows, err = a.svc.GetIngressClasses(ctx)
	case "networkpolicies":
		rows, err = a.svc.GetNetworkPolicies(ctx, "demo")
	case "persistentvolumes":
		rows, err = a.svc.GetPVs(ctx)
	case "deployments":
		rows, err = a.svc.GetDeployments(ctx, "demo")
	case "replicasets":
		rows, err = a.svc.GetReplicaSets(ctx, "demo")
	case "horizontalpodautoscalers":
		rows, err = a.svc.GetHPAs(ctx, "demo")
	case "configmaps":
		rows, err = a.svc.GetConfigMaps(ctx, "demo")
	case "secrets":
		rows, err = a.svc.GetSecrets(ctx, "demo")
	case "serviceaccounts":
		rows, err = a.svc.GetServiceAccounts(ctx, "demo")
	case "roles":
		rows, err = a.svc.GetRoles(ctx, "demo")
	case "pods":
		rows, err = a.svc.GetPods(ctx, "demo", "")
	case "daemonsets":
		rows, err = a.svc.GetDaemonSets(ctx, "demo")
	case "jobs":
		rows, err = a.svc.GetJobs(ctx, "demo")
	case "statefulsets":
		rows, err = a.svc.GetStatefulSets(ctx, "demo")
	case "clusterroles":
		rows, err = a.svc.GetClusterRoles(ctx)
	case "clusterrolebindings":
		rows, err = a.svc.GetClusterRoleBindings(ctx)
	case "rolebindings":
		rows, err = a.svc.GetRoleBindings(ctx, "demo")
	case "priorityclasses":
		rows, err = a.svc.GetPriorityClasses(ctx)
	case "runtimeclasses":
		rows, err = a.svc.GetRuntimeClasses(ctx)
	case "validatingwebhookconfigurations":
		rows, err = a.svc.GetValidatingWebhookConfigurations(ctx)
	case "mutatingwebhookconfigurations":
		rows, err = a.svc.GetMutatingWebhookConfigurations(ctx)
	case "leases":
		rows, err = a.svc.GetLeases(ctx, "demo")
	case "limitranges":
		rows, err = a.svc.GetLimitRanges(ctx, "demo")
	case "resourcequotas":
		rows, err = a.svc.GetResourceQuotas(ctx, "demo")
	case "poddisruptionbudgets":
		rows, err = a.svc.GetPDBs(ctx, "demo")
	case "customresourcedefinitions":
		rows, err = a.svc.GetCRDs(ctx)
	default:
		t.Fatalf("no list for %s", resource)
	}
	if err != nil {
		t.Fatalf("list %s: %v", resource, err)
	}
	if len(rows) != 1 {
		t.Fatalf("list %s: %d rows", resource, len(rows))
	}
	return asJSONRow(t, rows[0])
}

// asJSONRow is the row as it goes over the wire, so an int32 and an int64 of one value compare equal.
func asJSONRow(t *testing.T, row map[string]interface{}) map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func liveRow(t *testing.T, resource, object string) map[string]interface{} {
	t.Helper()
	var obj unstructured.Unstructured
	if err := obj.UnmarshalJSON([]byte(object)); err != nil {
		t.Fatal(err)
	}
	return asJSONRow(t, objectToInfo(resource, &obj))
}

// The live update of an object carries the row the list API gives for the same object, every key and value.
func TestLiveUpdateRowIsTheListRow(t *testing.T) {
	api := newListAPI(t)
	seen := map[string]bool{}
	for _, c := range watchRowSources() {
		for _, object := range []string{c.before, c.after} {
			if seen[object] {
				continue
			}
			seen[object] = true
			list, live := api.row(t, c.resource, object), liveRow(t, c.resource, object)
			if !reflect.DeepEqual(live, list) {
				listJSON, _ := json.Marshal(list)
				liveJSON, _ := json.Marshal(live)
				t.Errorf("%s (%s):\n live %s\n list %s", c.name, c.resource, liveJSON, listJSON)
			}
		}
	}
}

type watchRowCase struct {
	Name     string                 `json:"name"`
	Resource string                 `json:"resource"`
	Before   map[string]interface{} `json:"before"`
	Event    map[string]interface{} `json:"event"`
	After    map[string]interface{} `json:"after"`
	Shows    map[string]interface{} `json:"shows"`
}

func TestWatchRowCasesFixture(t *testing.T) {
	api := newListAPI(t)
	cases := []watchRowCase{}
	for _, c := range watchRowSources() {
		cases = append(cases, watchRowCase{
			Name:     c.name,
			Resource: c.resource,
			Before:   api.row(t, c.resource, c.before),
			Event:    liveRow(t, c.resource, c.after),
			After:    api.row(t, c.resource, c.after),
			Shows:    c.shows,
		})
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(cases); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_WATCH_ROW_CASES") == "1" {
		if err := os.WriteFile(watchRowCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(watchRowCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_WATCH_ROW_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("watchRows.cases.json is not what the list and the live update give now: rerun with UPDATE_WATCH_ROW_CASES=1 and check the page's test")
	}
}

// An object the typed conversion refuses still reaches the page: by its name, with spec and status nested as
// genericToInfo sends them, which the page's normalizers read (watchRows.cases.test.ts).
func TestLiveRowOfAnObjectThatDoesNotConvertKeepsItsNameAndNestedSpec(t *testing.T) {
	for resource, object := range map[string]string{
		"ingresses":                `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"odd","namespace":"demo"},"spec":{"rules":"not a list"}}`,
		"volumeattachments":        `{"apiVersion":"storage.k8s.io/v1","kind":"VolumeAttachment","metadata":{"name":"odd"},"spec":{"attacher":7},"status":{"attached":true}}`,
		"cronjobs":                 `{"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"odd","namespace":"demo"},"spec":{"schedule":7}}`,
		"services":                 `{"apiVersion":"v1","kind":"Service","metadata":{"name":"odd","namespace":"demo"},"spec":{"ports":"not a list"}}`,
		"ingressclasses":           `{"apiVersion":"networking.k8s.io/v1","kind":"IngressClass","metadata":{"name":"odd"},"spec":{"controller":7}}`,
		"networkpolicies":          `{"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"odd","namespace":"demo"},"spec":{"ingress":"not a list"}}`,
		"persistentvolumes":        `{"apiVersion":"v1","kind":"PersistentVolume","metadata":{"name":"odd"},"spec":{"accessModes":"not a list"}}`,
		"deployments":              `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"odd","namespace":"demo"},"spec":{"replicas":"not a number"}}`,
		"replicasets":              `{"apiVersion":"apps/v1","kind":"ReplicaSet","metadata":{"name":"odd","namespace":"demo"},"spec":{"replicas":"not a number"}}`,
		"horizontalpodautoscalers": `{"apiVersion":"autoscaling/v2","kind":"HorizontalPodAutoscaler","metadata":{"name":"odd","namespace":"demo"},"spec":{"maxReplicas":"not a number"}}`,
		"daemonsets":               `{"apiVersion":"apps/v1","kind":"DaemonSet","metadata":{"name":"odd","namespace":"demo"},"spec":{"minReadySeconds":"not a number"}}`,
		"jobs":                     `{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"odd","namespace":"demo"},"spec":{"completions":"not a number"}}`,
	} {
		row := liveRow(t, resource, object)
		if row["name"] != "odd" || row["spec"] == nil {
			t.Errorf("%s: %v, want the name and the nested spec", resource, row)
		}
	}
	// Endpoints have no spec: their payload sits beside the metadata, and the page reads it from there.
	row := liveRow(t, "endpoints", `{"apiVersion":"v1","kind":"Endpoints","metadata":{"name":"odd","namespace":"demo"},"subsets":"not a list"}`)
	if row["name"] != "odd" || row["subsets"] != "not a list" {
		t.Errorf("endpoints: %v, want the name and the subsets as they came", row)
	}
	// So with a ServiceAccount's and a Role's: names and rules, nothing a list hides.
	row = liveRow(t, "serviceaccounts", `{"apiVersion":"v1","kind":"ServiceAccount","metadata":{"name":"odd","namespace":"demo"},"secrets":[{"name":"t"}],"imagePullSecrets":[{"name":"r"}],"automountServiceAccountToken":"not a bool"}`)
	if row["name"] != "odd" || row["secrets"] == nil || row["imagePullSecrets"] == nil {
		t.Errorf("serviceaccounts: %v, want the name and the secrets as they came", row)
	}
	row = liveRow(t, "roles", `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"Role","metadata":{"name":"odd","namespace":"demo"},"rules":[{"verbs":"not a list"}]}`)
	if row["name"] != "odd" || row["rules"] == nil {
		t.Errorf("roles: %v, want the name and the rules as they came", row)
	}
	// These hold their payload beside the metadata too.
	for _, c := range []struct {
		resource, object string
		beside           []string
	}{
		{"clusterroles", `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRole","metadata":{"name":"odd"},"rules":[{"verbs":"not a list"}]}`, []string{"rules"}},
		{"clusterrolebindings", `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRoleBinding","metadata":{"name":"odd"},"roleRef":{"kind":"ClusterRole","name":"r"},"subjects":"not a list"}`, []string{"roleRef", "subjects"}},
		{"rolebindings", `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"RoleBinding","metadata":{"name":"odd","namespace":"demo"},"roleRef":{"kind":"Role","name":"r"},"subjects":"not a list"}`, []string{"roleRef", "subjects"}},
		{"priorityclasses", `{"apiVersion":"scheduling.k8s.io/v1","kind":"PriorityClass","metadata":{"name":"odd"},"value":7,"globalDefault":"not a bool","preemptionPolicy":"Never","description":"d"}`, []string{"value", "globalDefault", "preemptionPolicy", "description"}},
		{"runtimeclasses", `{"apiVersion":"node.k8s.io/v1","kind":"RuntimeClass","metadata":{"name":"odd"},"handler":"h","scheduling":"not an object"}`, []string{"handler"}},
		{"leases", `{"apiVersion":"coordination.k8s.io/v1","kind":"Lease","metadata":{"name":"odd","namespace":"demo"},"spec":{"leaseDurationSeconds":"not a number","holderIdentity":"h"}}`, []string{"spec"}},
		{"limitranges", `{"apiVersion":"v1","kind":"LimitRange","metadata":{"name":"odd","namespace":"demo"},"spec":{"limits":"not a list"}}`, []string{"spec"}},
		{"resourcequotas", `{"apiVersion":"v1","kind":"ResourceQuota","metadata":{"name":"odd","namespace":"demo"},"spec":{"hard":"not a map"}}`, []string{"spec"}},
		{"poddisruptionbudgets", `{"apiVersion":"policy/v1","kind":"PodDisruptionBudget","metadata":{"name":"odd","namespace":"demo"},"spec":{"selector":"not an object"}}`, []string{"spec"}},
	} {
		row := liveRow(t, c.resource, c.object)
		if row["name"] != "odd" {
			t.Errorf("%s: %v, want the name", c.resource, row)
		}
		for _, field := range c.beside {
			if row[field] == nil {
				t.Errorf("%s: %v, want %s as it came", c.resource, row, field)
			}
		}
	}
	// A webhook configuration that does not convert says how many webhooks it has, not what each is given.
	for _, resource := range []string{"validatingwebhookconfigurations", "mutatingwebhookconfigurations"} {
		row := liveRow(t, resource, `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"X","metadata":{"name":"odd"},"webhooks":[{"name":7,"clientConfig":{"caBundle":"`+whCA+`"}},{"name":"b"}]}`)
		raw, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		if row["name"] != "odd" || row["webhooks_count"] != float64(2) || strings.Contains(string(raw), whCA) {
			t.Errorf("%s: %s, want the name and a count of 2 with no webhook in it", resource, raw)
		}
	}
}

// A Secret's and a ConfigMap's rows name their keys and never hold a value: not the data, not the same value in the
// annotation kubectl apply writes, not when the object does not convert.
func TestALiveOrListRowOfASecretOrConfigMapHoldsNoValue(t *testing.T) {
	api := newListAPI(t)
	check := func(what string, row map[string]interface{}, values ...string) {
		t.Helper()
		raw, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range values {
			if strings.Contains(string(raw), value) {
				t.Errorf("%s holds the value %q: %s", what, value, raw)
			}
		}
		for _, key := range []string{"data", "binaryData", "stringData", "annotations", "data_values"} {
			if _, ok := row[key]; ok {
				t.Errorf("%s has the key %q: %s", what, key, raw)
			}
		}
	}
	secretValues := []string{secretValue, secretEncoded}
	check("the list row of a Secret", api.row(t, "secrets", secretFull), secretValues...)
	check("the live row of a Secret", liveRow(t, "secrets", secretFull), secretValues...)
	check("the live row of a Secret whose data does not convert", liveRow(t, "secrets",
		secretHead+`,"annotations":{`+secretApplied+`}},"data":{"password":"`+secretValue+`!"}}`), secretValues...)
	check("the live row of a Secret with a field that does not convert", liveRow(t, "secrets",
		secretHead+`,"annotations":{`+secretApplied+`}},"data":{"password":"`+secretEncoded+`"},"immutable":"not a bool"}`), secretValues...)
	check("the list row of a ConfigMap", api.row(t, "configmaps", cmFull), cmValue)
	check("the live row of a ConfigMap", liveRow(t, "configmaps", cmFull), cmValue)
	check("the live row of a ConfigMap that does not convert", liveRow(t, "configmaps",
		cmHead+`},"data":{"a":"`+cmValue+`"},"immutable":"not a bool"}`), cmValue)
}

// A row names what a container refers to and never holds what it is given: not an environment value and, for a kind that
// holds a pod template, not its commands or probes; not when the object does not convert either, where the row carries
// the object's spec for the page to read.
func TestALiveRowHoldsNoEnvironmentValue(t *testing.T) {
	const (
		value  = "fake-env-value-for-tests"
		secret = "fake-probe-header-for-tests"
		arg    = "fake-arg-value-for-tests"
		attr   = "fake-volume-attribute-for-tests"
		note   = "fake-template-annotation-for-tests"
	)
	container := `{"name":"app","image":"example.test/app:1","env":[{"name":"MODE","value":"` + value + `"}],"args":["--token=` + arg + `"],
		"livenessProbe":{"httpGet":{"path":"/","port":80,"httpHeaders":[{"name":"X-Token","value":"` + secret + `"}]}}}`
	podSpec := `"containers":[` + container + `],"initContainers":[` + container + `],"volumes":[{"name":"v","csi":{"driver":"d","volumeAttributes":{"token":"` + attr + `"}}}]`
	template := `"template":{"metadata":{"annotations":{"note":"` + note + `"}},"spec":{` + podSpec + `}}`
	every := []string{value, secret, arg, attr, note}
	// a pod's row lists its containers' commands, as the list's does
	notArg := []string{value, secret, attr, note}
	for _, c := range []struct {
		resource, object string
		values           []string
	}{
		{"pods", `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p","namespace":"demo"},"spec":{` + podSpec + `}}`, notArg},
		{"pods", `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p","namespace":"demo"},"spec":{"nodeName":7,` + podSpec + `}}`, notArg},
		{"deployments", `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"d","namespace":"demo"},"spec":{` + template + `}}`, every},
		{"deployments", `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"d","namespace":"demo"},"spec":{"replicas":"not a number",` + template + `}}`, every},
		{"replicasets", `{"apiVersion":"apps/v1","kind":"ReplicaSet","metadata":{"name":"r","namespace":"demo"},"spec":{` + template + `}}`, every},
		{"replicasets", `{"apiVersion":"apps/v1","kind":"ReplicaSet","metadata":{"name":"r","namespace":"demo"},"spec":{"replicas":"not a number",` + template + `}}`, every},
		{"statefulsets", `{"apiVersion":"apps/v1","kind":"StatefulSet","metadata":{"name":"s","namespace":"demo"},"spec":{` + template + `}}`, every},
		{"statefulsets", `{"apiVersion":"apps/v1","kind":"StatefulSet","metadata":{"name":"s","namespace":"demo"},"spec":{"replicas":"not a number",` + template + `}}`, every},
		{"daemonsets", `{"apiVersion":"apps/v1","kind":"DaemonSet","metadata":{"name":"a","namespace":"demo"},"spec":{` + template + `}}`, every},
		{"daemonsets", `{"apiVersion":"apps/v1","kind":"DaemonSet","metadata":{"name":"a","namespace":"demo"},"spec":{"minReadySeconds":"not a number",` + template + `}}`, every},
		{"jobs", `{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"j","namespace":"demo"},"spec":{` + template + `}}`, every},
		{"jobs", `{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"j","namespace":"demo"},"spec":{"completions":"not a number",` + template + `}}`, every},
		{"cronjobs", `{"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"c","namespace":"demo"},"spec":{"schedule":"0 9 * * *","jobTemplate":{"spec":{` + template + `}}}}`, every},
		{"cronjobs", `{"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"c","namespace":"demo"},"spec":{"schedule":7,"jobTemplate":{"spec":{` + template + `}}}}`, every},
	} {
		raw, err := json.Marshal(liveRow(t, c.resource, c.object))
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range c.values {
			if strings.Contains(string(raw), v) {
				t.Errorf("the live row of %s holds %q: %s", c.object[:60], v, raw)
			}
		}
	}
	if raw, _ := json.Marshal(newListAPI(t).row(t, "pods", podAllRefs)); strings.Contains(string(raw), value) {
		t.Errorf("the list row of a pod holds an environment value: %s", raw)
	}
	// what the pages read of such a row stays: the containers' names and images, and what they refer to
	row := liveRow(t, "deployments", `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"d","namespace":"demo"},"spec":{"replicas":"not a number","selector":{"matchLabels":{"app":"a"}},
		"template":{"metadata":{"labels":{"app":"a"}},"spec":{"nodeSelector":{"disk":"ssd"},"containers":[{"name":"app","image":"example.test/app:1","envFrom":[{"configMapRef":{"name":"conf"}}],"env":[{"name":"T","valueFrom":{"secretKeyRef":{"name":"creds","key":"t"}}}]}],
		"volumes":[{"name":"v","secret":{"secretName":"tls"}},{"name":"p","projected":{"sources":[{"configMap":{"name":"proj"}}]}}]}}}}`)
	raw, err := json.Marshal(row["spec"])
	if err != nil {
		t.Fatal(err)
	}
	for _, kept := range []string{`"replicas":"not a number"`, `"matchLabels":{"app":"a"}`, `"nodeSelector":{"disk":"ssd"}`, `"image":"example.test/app:1"`, `"name":"app"`, `"configMapRef":{"name":"conf"}`, `"secretKeyRef":{"key":"t","name":"creds"}`, `"secretName":"tls"`, `"configMap":{"name":"proj"}`} {
		if !strings.Contains(string(raw), kept) {
			t.Errorf("the row's spec lost %s: %s", kept, raw)
		}
	}
}

// The list caps its address preview and counts every address; a live update has to read the same, not list them all.
func TestLiveEndpointsRowKeepsTheListsCapOnItsAddressPreview(t *testing.T) {
	addresses := make([]string, 0, 60)
	for i := 1; i <= 60; i++ {
		addresses = append(addresses, fmt.Sprintf(`{"ip":"10.0.0.%d"}`, i))
	}
	object := epMeta + `,"subsets":[{"addresses":[` + strings.Join(addresses, ",") + `],` + epPort + `}]}`
	list, live := newListAPI(t).row(t, "endpoints", object), liveRow(t, "endpoints", object)
	if !reflect.DeepEqual(live, list) {
		t.Errorf("live row is not the list's: live ready_count %v, %d addresses; list ready_count %v, %d addresses",
			live["ready_count"], lenOf(live["ready_addresses"]), list["ready_count"], lenOf(list["ready_addresses"]))
	}
}

func lenOf(v interface{}) int {
	list, _ := v.([]interface{})
	return len(list)
}

// These lists are watched as the user and a grant limited to namespaces stays in them: the row a live update carries
// changes nothing about who may open the watch. A kind of the cluster goes on to ask the cluster (clusterListRefusal).
func TestAWatchOfTheseListsStaysInsideANamespaceGrant(t *testing.T) {
	scoped := auth.TokenPayload{
		Perms:      auth.PermissionMatrix{"self": {"resource.*.read"}},
		Namespaces: map[string][]string{"self": {"team-a"}},
	}
	for path, allowed := range map[string]bool{
		"/api/v1/services":                                                  false,
		"/api/v1/endpoints":                                                 false,
		"/api/v1/networkpolicies":                                           false,
		"/api/v1/pvs":                                                       true,
		"/api/v1/ingressclasses":                                            true,
		"/api/v1/namespaces":                                                false,
		"/api/v1/namespaces/team-b/services":                                false,
		"/api/v1/namespaces/team-b/endpoints":                               false,
		"/api/v1/namespaces/team-b/networkpolicies":                         false,
		"/api/v1/namespaces/team-a/services":                                true,
		"/api/v1/namespaces/team-a/endpoints":                               true,
		"/api/v1/namespaces/team-a/networkpolicies":                         true,
		"/apis/apps/v1/deployments":                                         false,
		"/apis/apps/v1/replicasets":                                         false,
		"/apis/autoscaling/v2/horizontalpodautoscalers":                     false,
		"/api/v1/configmaps":                                                false,
		"/api/v1/secrets":                                                   false,
		"/api/v1/serviceaccounts":                                           false,
		"/api/v1/roles":                                                     false,
		"/apis/apps/v1/namespaces/team-b/deployments":                       false,
		"/apis/apps/v1/namespaces/team-b/replicasets":                       false,
		"/apis/autoscaling/v2/namespaces/team-b/horizontalpodautoscalers":   false,
		"/api/v1/namespaces/team-b/configmaps":                              false,
		"/api/v1/namespaces/team-b/secrets":                                 false,
		"/api/v1/namespaces/team-b/serviceaccounts":                         false,
		"/api/v1/namespaces/team-b/roles":                                   false,
		"/apis/apps/v1/namespaces/team-a/deployments":                       true,
		"/apis/apps/v1/namespaces/team-a/replicasets":                       true,
		"/apis/autoscaling/v2/namespaces/team-a/horizontalpodautoscalers":   true,
		"/api/v1/namespaces/team-a/configmaps":                              true,
		"/api/v1/namespaces/team-a/secrets":                                 true,
		"/api/v1/namespaces/team-a/serviceaccounts":                         true,
		"/api/v1/namespaces/team-a/roles":                                   true,
		"/api/v1/pods":                                                      false,
		"/api/v1/daemonsets":                                                false,
		"/api/v1/jobs":                                                      false,
		"/api/v1/namespaces/team-b/pods":                                    false,
		"/apis/apps/v1/namespaces/team-b/daemonsets":                        false,
		"/apis/apps/v1/namespaces/team-b/statefulsets":                      false,
		"/apis/batch/v1/namespaces/team-b/jobs":                             false,
		"/apis/batch/v1/namespaces/team-b/cronjobs":                         false,
		"/api/v1/namespaces/team-a/pods":                                    true,
		"/apis/apps/v1/namespaces/team-a/daemonsets":                        true,
		"/apis/apps/v1/namespaces/team-a/statefulsets":                      true,
		"/apis/batch/v1/namespaces/team-a/jobs":                             true,
		"/apis/batch/v1/namespaces/team-a/cronjobs":                         true,
		"/api/v1/rolebindings":                                              false,
		"/api/v1/limitranges":                                               false,
		"/api/v1/resourcequotas":                                            false,
		"/apis/coordination.k8s.io/v1/leases":                               false,
		"/apis/policy/v1/poddisruptionbudgets":                              false,
		"/api/v1/namespaces/team-b/rolebindings":                            false,
		"/api/v1/namespaces/team-b/limitranges":                             false,
		"/api/v1/namespaces/team-b/resourcequotas":                          false,
		"/apis/rbac.authorization.k8s.io/v1/namespaces/team-b/rolebindings": false,
		"/apis/coordination.k8s.io/v1/namespaces/team-b/leases":             false,
		"/apis/policy/v1/namespaces/team-b/poddisruptionbudgets":            false,
		"/api/v1/namespaces/team-a/rolebindings":                            true,
		"/api/v1/namespaces/team-a/limitranges":                             true,
		"/api/v1/namespaces/team-a/resourcequotas":                          true,
		"/apis/rbac.authorization.k8s.io/v1/namespaces/team-a/rolebindings": true,
		"/apis/coordination.k8s.io/v1/namespaces/team-a/leases":             true,
		"/apis/policy/v1/namespaces/team-a/poddisruptionbudgets":            true,
	} {
		reason := namespaceScopeRefusal(scoped, "self", path)
		if (reason == "") != allowed {
			t.Errorf("%s: refusal %q, want allowed %v", path, reason, allowed)
		}
	}
	if reason := namespaceScopeRefusal(auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"*"}}}, "self", "/api/v1/ingressclasses"); reason != "" {
		t.Errorf("a grant with no namespace limit was refused: %s", reason)
	}
}
