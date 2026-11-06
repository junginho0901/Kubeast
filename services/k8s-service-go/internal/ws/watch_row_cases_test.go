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
	return []watchRowSource{
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
		// External IP is the list's own value here; kubectl prints the externalName, a list matter these cases do not change
		{"a Service that became ExternalName shows no cluster IP, port or selector", "services", svcPlain, svcExternalName, svcShows("ExternalName", "-", "<none>", "-", "-")},
		{"a Service whose load balancer and node port went away shows neither", "services", svcBalanced, svcPlain, svcShows("ClusterIP", "10.0.0.1", "<none>", "TCP 80->8080", "app=web")},
		{"a Service that gained a load balancer shows it", "services", svcPlain, svcBalanced, svcShows("LoadBalancer", "10.0.0.1", "192.0.2.9,192.0.2.1,lb.example.test", "TCP 80->http (node:30080)", "app=web")},
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
// changes nothing about who may open the watch.
func TestAWatchOfTheseListsStaysInsideANamespaceGrant(t *testing.T) {
	scoped := auth.TokenPayload{
		Perms:      auth.PermissionMatrix{"self": {"resource.*.read"}},
		Namespaces: map[string][]string{"self": {"team-a"}},
	}
	for path, allowed := range map[string]bool{
		"/api/v1/services":                                                false,
		"/api/v1/endpoints":                                               false,
		"/api/v1/networkpolicies":                                         false,
		"/api/v1/pvs":                                                     false,
		"/api/v1/ingressclasses":                                          false,
		"/api/v1/namespaces/team-b/services":                              false,
		"/api/v1/namespaces/team-b/endpoints":                             false,
		"/api/v1/namespaces/team-b/networkpolicies":                       false,
		"/api/v1/namespaces/team-a/services":                              true,
		"/api/v1/namespaces/team-a/endpoints":                             true,
		"/api/v1/namespaces/team-a/networkpolicies":                       true,
		"/apis/apps/v1/deployments":                                       false,
		"/apis/apps/v1/replicasets":                                       false,
		"/apis/autoscaling/v2/horizontalpodautoscalers":                   false,
		"/api/v1/configmaps":                                              false,
		"/api/v1/secrets":                                                 false,
		"/api/v1/serviceaccounts":                                         false,
		"/api/v1/roles":                                                   false,
		"/apis/apps/v1/namespaces/team-b/deployments":                     false,
		"/apis/apps/v1/namespaces/team-b/replicasets":                     false,
		"/apis/autoscaling/v2/namespaces/team-b/horizontalpodautoscalers": false,
		"/api/v1/namespaces/team-b/configmaps":                            false,
		"/api/v1/namespaces/team-b/secrets":                               false,
		"/api/v1/namespaces/team-b/serviceaccounts":                       false,
		"/api/v1/namespaces/team-b/roles":                                 false,
		"/apis/apps/v1/namespaces/team-a/deployments":                     true,
		"/apis/apps/v1/namespaces/team-a/replicasets":                     true,
		"/apis/autoscaling/v2/namespaces/team-a/horizontalpodautoscalers": true,
		"/api/v1/namespaces/team-a/configmaps":                            true,
		"/api/v1/namespaces/team-a/secrets":                               true,
		"/api/v1/namespaces/team-a/serviceaccounts":                       true,
		"/api/v1/namespaces/team-a/roles":                                 true,
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
