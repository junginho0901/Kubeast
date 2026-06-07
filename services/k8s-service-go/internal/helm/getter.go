package helm

import (
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/cli-runtime/pkg/genericclioptions"
	"k8s.io/client-go/discovery"
	memory "k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

// restConfigGetter implements genericclioptions.RESTClientGetter directly from a
// live *rest.Config (a per-cluster client bundle's config), bypassing the
// kubeconfig-FILE resolution that helm.sh/helm/v3/pkg/kube.GetConfig performs.
//
// This is what makes Helm cluster-aware: the config is resolved per request from
// the ?cluster= entry in the context (see Service.defaultGetter), so list/get/
// rollback all target the same cluster as every other k8s-service handler — not
// the single legacy /app/kubeconfig.yaml the old path was pinned to.
//
// action.Configuration.Init only consumes ToRESTConfig / ToDiscoveryClient /
// ToRESTMapper (storage driver "secrets" is REST-config based); ToRawKubeConfigLoader
// is used solely for namespace resolution, for which the default ConfigFlags
// loader is sufficient.
type restConfigGetter struct {
	cfg       *rest.Config
	namespace string
}

func (g *restConfigGetter) ToRESTConfig() (*rest.Config, error) { return g.cfg, nil }

func (g *restConfigGetter) ToDiscoveryClient() (discovery.CachedDiscoveryInterface, error) {
	dc, err := discovery.NewDiscoveryClientForConfig(g.cfg)
	if err != nil {
		return nil, err
	}
	// Cache discovery in-memory for the lifetime of this getter (one helm call).
	return memory.NewMemCacheClient(dc), nil
}

func (g *restConfigGetter) ToRESTMapper() (meta.RESTMapper, error) {
	dc, err := g.ToDiscoveryClient()
	if err != nil {
		return nil, err
	}
	return restmapper.NewDeferredDiscoveryRESTMapper(dc), nil
}

func (g *restConfigGetter) ToRawKubeConfigLoader() clientcmd.ClientConfig {
	cf := genericclioptions.NewConfigFlags(false)
	cf.Namespace = &g.namespace
	return cf.ToRawKubeConfigLoader()
}
