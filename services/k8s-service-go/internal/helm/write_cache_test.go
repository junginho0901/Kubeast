package helm

import (
	"context"
	"errors"
	"io"
	"testing"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chartutil"
	kubefake "helm.sh/helm/v3/pkg/kube/fake"
	"helm.sh/helm/v3/pkg/release"
	"helm.sh/helm/v3/pkg/storage"
	"helm.sh/helm/v3/pkg/storage/driver"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// With Redis off the cache is the in-memory one. A read without force_refresh, what an AI tool sends, must see a
// Helm write as soon as the write returns. These run the real Helm actions against in-memory release storage.

const (
	testNS      = "demo"
	testRelease = "web"
)

type helmFixture struct {
	svc   *Service
	store *storage.Storage
	mem   *driver.Memory
	kube  *kubefake.FailingKubeClient
	calls int
	// failCall makes the n-th action config fail: the read after a write that already landed.
	failCall int
}

func newHelmFixture(t *testing.T) *helmFixture {
	t.Helper()
	f := &helmFixture{
		mem:  driver.NewMemory(),
		kube: &kubefake.FailingKubeClient{PrintingKubeClient: kubefake.PrintingKubeClient{Out: io.Discard}},
	}
	f.store = storage.Init(f.mem)
	f.svc = &Service{cache: cache.New("", 0, 0, "")}
	f.svc.configOverride = func(_ context.Context, namespace string) (*action.Configuration, error) {
		f.calls++
		if f.failCall != 0 && f.calls == f.failCall {
			return nil, errors.New("read after the write failed")
		}
		f.mem.SetNamespace(namespace)
		return &action.Configuration{
			Releases:     f.store,
			KubeClient:   f.kube,
			Capabilities: chartutil.DefaultCapabilities,
			Log:          func(string, ...interface{}) {},
		}, nil
	}
	f.mem.SetNamespace(testNS)
	f.seed(t, testRelease, 1, release.StatusSuperseded)
	f.seed(t, testRelease, 2, release.StatusDeployed)
	f.seed(t, "other", 1, release.StatusDeployed)
	return f
}

func (f *helmFixture) seed(t *testing.T, name string, revision int, status release.Status) {
	t.Helper()
	rel := &release.Release{
		Name:      name,
		Namespace: testNS,
		Version:   revision,
		Info:      &release.Info{Status: status},
		Chart: &chart.Chart{
			Metadata: &chart.Metadata{APIVersion: "v2", Name: "demo-chart", Version: "1.0.0"},
		},
	}
	if err := f.store.Create(rel); err != nil {
		t.Fatal(err)
	}
}

func identity(user string) context.Context {
	ctx := cluster.WithID(context.Background(), "c1")
	return auth.WithPayload(ctx, auth.TokenPayload{UserID: user, Email: user + "@example.com", Perms: auth.PermissionMatrix{"c1": {"*"}}})
}

// The scopes a read may be cached under: the screen's namespace and the AI tool's default of every namespace, by two users.
var cachedScopes = []struct {
	user, namespace string
}{{"admin", testNS}, {"admin", ""}, {"reader", testNS}, {"reader", ""}}

func (f *helmFixture) fillCache(t *testing.T) {
	t.Helper()
	for _, s := range cachedScopes {
		out, err := f.svc.ListReleases(identity(s.user), s.namespace, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if web := find(out, testRelease); web == nil || web.Revision != 2 || web.Status != "deployed" {
			t.Fatalf("before the write, %s in %q: %+v", s.user, s.namespace, out)
		}
	}
}

func find(out []ReleaseSummary, name string) *ReleaseSummary {
	for i := range out {
		if out[i].Name == name {
			return &out[i]
		}
	}
	return nil
}

// checkEveryScope runs want on what each scope's read without force_refresh returns.
func (f *helmFixture) checkEveryScope(t *testing.T, want func(web *ReleaseSummary) bool) {
	t.Helper()
	f.failCall = 0
	for _, s := range cachedScopes {
		out, err := f.svc.ListReleases(identity(s.user), s.namespace, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if !want(find(out, testRelease)) {
			t.Errorf("%s in %q still reads the old list: %+v", s.user, s.namespace, find(out, testRelease))
		}
		if find(out, "other") == nil {
			t.Errorf("%s in %q lost the other release: %+v", s.user, s.namespace, out)
		}
	}
}

func TestListWithoutForceSeesAnUninstall(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	if _, err := f.svc.Uninstall(identity("admin"), testNS, testRelease, false, false); err != nil {
		t.Fatal(err)
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web == nil })
}

func TestListWithoutForceSeesAnUninstallThatKeptHistory(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	if _, err := f.svc.Uninstall(identity("admin"), testNS, testRelease, true, false); err != nil {
		t.Fatal(err)
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web != nil && web.Status == "uninstalled" })
}

func TestListWithoutForceSeesARollback(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	if _, err := f.svc.Rollback(identity("admin"), testNS, testRelease, 1, false); err != nil {
		t.Fatal(err)
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web != nil && web.Revision == 3 })
}

func TestListWithoutForceSeesAnUpgrade(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	if _, err := f.svc.UpgradeValues(identity("admin"), testNS, testRelease, "replicas: 2\n", false); err != nil {
		t.Fatal(err)
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web != nil && web.Revision == 3 && web.Status == "deployed" })
}

// A rollback that landed and could not be read back answers without an error: the list must still see it.
func TestListWithoutForceSeesARollbackWhoseReadBackFailed(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	f.calls = 0
	// Rollback builds an action config for the two reads before the write, one for the write, then one for the read back.
	f.failCall = 4
	res, err := f.svc.Rollback(identity("admin"), testNS, testRelease, 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.NewRevision != 0 {
		t.Fatalf("the read back was expected to fail: %+v", res)
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web != nil && web.Revision == 3 })
}

// A write that failed half way recorded a failed revision: the list must show it, not the state before the attempt.
func TestListWithoutForceSeesAFailedUpgrade(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	f.kube.UpdateError = errors.New("the API server refused the update")
	if _, err := f.svc.UpgradeValues(identity("admin"), testNS, testRelease, "replicas: 2\n", false); err == nil {
		t.Fatal("the upgrade was expected to fail")
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web != nil && web.Revision == 3 && web.Status == "failed" })
}

func TestListWithoutForceSeesAFailedRollback(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	f.kube.UpdateError = errors.New("the API server refused the update")
	if _, err := f.svc.Rollback(identity("admin"), testNS, testRelease, 1, false); err == nil {
		t.Fatal("the rollback was expected to fail")
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web != nil && web.Revision == 3 && web.Status == "failed" })
}

func TestListWithoutForceSeesAFailedUninstall(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	f.kube.BuildError = errors.New("the API server refused the delete")
	if _, err := f.svc.Uninstall(identity("admin"), testNS, testRelease, true, false); err == nil {
		t.Fatal("the uninstall was expected to fail")
	}
	f.checkEveryScope(t, func(web *ReleaseSummary) bool { return web != nil && web.Status == "uninstalling" })
}

// A dry run changes nothing, so it keeps the cached list: the cached answer stays even when storage moved underneath.
func TestDryRunKeepsTheCachedList(t *testing.T) {
	for name, dry := range map[string]func(s *Service) error{
		"uninstall": func(s *Service) error {
			_, err := s.Uninstall(identity("admin"), testNS, testRelease, false, true)
			return err
		},
		"rollback": func(s *Service) error {
			_, err := s.Rollback(identity("admin"), testNS, testRelease, 1, true)
			return err
		},
		"upgrade": func(s *Service) error {
			_, err := s.UpgradeValues(identity("admin"), testNS, testRelease, "replicas: 2\n", true)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newHelmFixture(t)
			f.fillCache(t)
			f.mem.SetNamespace(testNS)
			f.seed(t, "added-outside", 1, release.StatusDeployed)
			if err := dry(f.svc); err != nil {
				t.Fatal(err)
			}
			out, err := f.svc.ListReleases(identity("admin"), testNS, "", false)
			if err != nil {
				t.Fatal(err)
			}
			if find(out, "added-outside") != nil {
				t.Fatalf("the dry run dropped the cached list: %+v", out)
			}
		})
	}
}

// force_refresh, the page's Refresh, always reads the cluster.
func TestForceRefreshReadsPastTheCache(t *testing.T) {
	f := newHelmFixture(t)
	f.fillCache(t)
	f.mem.SetNamespace(testNS)
	f.seed(t, "added-outside", 1, release.StatusDeployed)
	out, err := f.svc.ListReleases(identity("admin"), testNS, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if find(out, "added-outside") == nil {
		t.Fatalf("force read the cache: %+v", out)
	}
}
