package k8s

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/scheme"
)

// switchOffReviewsFile is what the first screens of three people sent on main b4d6a944, before the checks could be
// shared. A body's sha256 follows client-go's encoding: after a dependency bump record it again from main's code, not
// from a branch that changes the checks (UPDATE_SWITCH_OFF_REVIEWS=1 writes it from the code it runs in).
const switchOffReviewsFile = "testdata/switch_off_reviews.json"

// sentReview is one review as the cluster got it: who it went out as, what it asks and its bytes.
type sentReview struct {
	User, Groups                                        string
	Verb, Group, Resource, Subresource, Namespace, Name string
	Bytes                                               int
	SHA256                                              string
}

// With the switch off the screens' checks go out as they did before it: as the person, as many, the same questions and
// the same bytes as recorded on main.
func TestWithTheSwitchOffTheChecksGoOutAsBefore(t *testing.T) {
	var namespaces []string
	for i := 0; i < 20; i++ {
		namespaces = append(namespaces, fmt.Sprintf("ns-%02d", i))
	}
	nodes := []string{"n0", "n1", "n2", "n3"}
	var pods []corev1.Pod
	var objs []k8sruntime.Object
	for i, ns := range namespaces {
		for _, node := range nodes {
			pods = append(pods, nodePod(ns, ns+"-"+node, node))
		}
		objs = append(objs, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}},
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: fmt.Sprintf("d%d", i)}},
			overviewPod(ns, "p", corev1.PodRunning))
	}
	grants := map[string][]string{"wide@example.com": {""}, "five@example.com": namespaces[:5], "twenty@example.com": namespaces}
	people := []struct {
		user string
		ctx  context.Context
	}{
		{"wide@example.com", wideCaller("wide@example.com")},
		{"five@example.com", grantCaller("five@example.com", namespaces[:5]...)},
		{"twenty@example.com", grantCaller("twenty@example.com", namespaces...)},
	}
	got := map[string][]sentReview{}
	for _, p := range people {
		api := &clusterAPI{pods: pods, namespaces: namespaces, review: rbac(grants)}
		s, b := api.start(t, objs...)
		firstScreens(s, b, p.ctx, nodes)
		for _, c := range api.calls {
			if c.verb != "review" {
				continue
			}
			review := &authorizationv1.SelfSubjectAccessReview{}
			if _, _, err := scheme.Codecs.UniversalDeserializer().Decode([]byte(c.body), nil, review); err != nil {
				t.Fatal(err)
			}
			ra := review.Spec.ResourceAttributes
			sum := sha256.Sum256([]byte(c.body))
			got[p.user] = append(got[p.user], sentReview{c.user, c.groups, ra.Verb, ra.Group, ra.Resource, ra.Subresource, ra.Namespace, ra.Name, len(c.body), hex.EncodeToString(sum[:])})
		}
		slices.SortFunc(got[p.user], func(x, y sentReview) int {
			return strings.Compare(fmt.Sprint(x), fmt.Sprint(y))
		})
	}
	if os.Getenv("UPDATE_SWITCH_OFF_REVIEWS") == "1" {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(switchOffReviewsFile, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(switchOffReviewsFile)
	if err != nil {
		t.Fatal(err)
	}
	var want map[string][]sentReview
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	for _, p := range people {
		bytes := 0
		for _, r := range got[p.user] {
			bytes += r.Bytes
		}
		t.Logf("%s: %d reviews of %d bytes", p.user, len(got[p.user]), bytes)
		if !slices.Equal(got[p.user], want[p.user]) {
			t.Errorf("%s: the reviews differ from those main sent:\n got %+v\nwant %+v", p.user, got[p.user], want[p.user])
		}
	}
}
