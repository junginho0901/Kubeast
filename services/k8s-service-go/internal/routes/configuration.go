package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterConfiguration — ConfigMap / Secret / generic resources +
// scheduling-and-policy resources (HPA, VPA, PDB, PriorityClass,
// RuntimeClass, ResourceQuota, LimitRange) + admission-webhook configs
// + Lease.
//
// Grouping rationale: these are all "configuration & policy" objects
// that sit one layer below workload spec. Splitting hairs (HPA into
// workloads.go, etc.) would scatter related routes across files.
func RegisterConfiguration(r chi.Router, h *handler.Handler) {
	// ConfigMaps
	r.Get("/api/v1/configmaps/all", h.GetAllConfigMaps)
	r.Get("/api/v1/namespaces/{namespace}/configmaps", h.GetConfigMaps)
	r.Get("/api/v1/namespaces/{namespace}/configmaps/{name}/describe", h.DescribeConfigMap)
	r.Get("/api/v1/namespaces/{namespace}/configmaps/{name}/yaml", h.GetConfigMapYAML)
	r.Delete("/api/v1/namespaces/{namespace}/configmaps/{name}", h.DeleteConfigMap)

	// Secrets
	r.Get("/api/v1/secrets/all", h.GetAllSecrets)
	r.Get("/api/v1/namespaces/{namespace}/secrets", h.GetSecrets)
	r.Get("/api/v1/namespaces/{namespace}/secrets/{name}/describe", h.DescribeSecret)
	r.Get("/api/v1/namespaces/{namespace}/secrets/{name}/yaml", h.GetSecretYAML)
	r.Delete("/api/v1/namespaces/{namespace}/secrets/{name}", h.DeleteSecret)

	// Generic resources
	r.Get("/api/v1/resources", h.GetGenericResources)
	r.Post("/api/v1/search", h.SearchResources)
	r.Get("/api/v1/resources/json", h.GetGenericResourceJSON)
	r.Get("/api/v1/resources/yaml", h.GetGenericResourceYAML)
	r.Post("/api/v1/resources/yaml/apply", h.ApplyResourceYAML)
	r.Post("/api/v1/resources/yaml/create", h.CreateResourcesFromYAML)
	r.Get("/api/v1/resources/describe", h.DescribeGenericResource)

	// HPA
	r.Get("/api/v1/hpas/all", h.GetAllHPAs)
	r.Get("/api/v1/namespaces/{namespace}/hpas", h.GetHPAs)
	r.Get("/api/v1/namespaces/{namespace}/hpas/{name}/describe", h.DescribeHPA)
	r.Get("/api/v1/namespaces/{namespace}/hpas/{name}/yaml", h.GetHPAYAML)
	r.Delete("/api/v1/namespaces/{namespace}/hpas/{name}", h.DeleteHPA)

	// VPA
	r.Get("/api/v1/vpas/all", h.GetAllVPAs)
	r.Get("/api/v1/namespaces/{namespace}/vpas", h.GetVPAs)
	r.Get("/api/v1/namespaces/{namespace}/vpas/{name}/describe", h.DescribeVPA)
	r.Get("/api/v1/namespaces/{namespace}/vpas/{name}/yaml", h.GetVPAYAML)
	r.Delete("/api/v1/namespaces/{namespace}/vpas/{name}", h.DeleteVPA)

	// PDB
	r.Get("/api/v1/pdbs/all", h.GetAllPDBs)
	r.Get("/api/v1/namespaces/{namespace}/pdbs", h.GetPDBs)
	r.Get("/api/v1/namespaces/{namespace}/pdbs/{name}/describe", h.DescribePDB)
	r.Get("/api/v1/namespaces/{namespace}/pdbs/{name}/yaml", h.GetPDBYAML)
	r.Delete("/api/v1/namespaces/{namespace}/pdbs/{name}", h.DeletePDB)

	// PriorityClass (cluster-scoped)
	r.Get("/api/v1/priorityclasses", h.GetPriorityClasses)
	r.Get("/api/v1/priorityclasses/{name}/describe", h.DescribePriorityClass)
	r.Get("/api/v1/priorityclasses/{name}/yaml", h.GetPriorityClassYAML)
	r.Delete("/api/v1/priorityclasses/{name}", h.DeletePriorityClass)

	// RuntimeClass (cluster-scoped)
	r.Get("/api/v1/runtimeclasses", h.GetRuntimeClasses)
	r.Get("/api/v1/runtimeclasses/{name}/describe", h.DescribeRuntimeClass)
	r.Get("/api/v1/runtimeclasses/{name}/yaml", h.GetRuntimeClassYAML)
	r.Delete("/api/v1/runtimeclasses/{name}", h.DeleteRuntimeClass)

	// ResourceQuota (namespace-scoped)
	r.Get("/api/v1/resourcequotas/all", h.GetAllResourceQuotas)
	r.Get("/api/v1/namespaces/{namespace}/resourcequotas", h.GetResourceQuotas)
	r.Get("/api/v1/namespaces/{namespace}/resourcequotas/{name}/describe", h.DescribeResourceQuota)
	r.Get("/api/v1/namespaces/{namespace}/resourcequotas/{name}/yaml", h.GetResourceQuotaYAML)
	r.Delete("/api/v1/namespaces/{namespace}/resourcequotas/{name}", h.DeleteResourceQuota)

	// LimitRange (namespace-scoped)
	r.Get("/api/v1/limitranges/all", h.GetAllLimitRanges)
	r.Get("/api/v1/namespaces/{namespace}/limitranges", h.GetLimitRanges)
	r.Get("/api/v1/namespaces/{namespace}/limitranges/{name}/describe", h.DescribeLimitRange)
	r.Get("/api/v1/namespaces/{namespace}/limitranges/{name}/violations", h.ListPodsViolatingLimitRange)
	r.Get("/api/v1/namespaces/{namespace}/limitranges/{name}/yaml", h.GetLimitRangeYAML)
	r.Delete("/api/v1/namespaces/{namespace}/limitranges/{name}", h.DeleteLimitRange)

	// MutatingWebhookConfiguration (cluster-scoped)
	r.Get("/api/v1/mutatingwebhookconfigurations", h.GetMutatingWebhookConfigurations)
	r.Get("/api/v1/mutatingwebhookconfigurations/{name}/describe", h.DescribeMutatingWebhookConfiguration)
	r.Get("/api/v1/mutatingwebhookconfigurations/{name}/yaml", h.GetMutatingWebhookConfigurationYAML)
	r.Delete("/api/v1/mutatingwebhookconfigurations/{name}", h.DeleteMutatingWebhookConfiguration)

	// ValidatingWebhookConfiguration (cluster-scoped)
	r.Get("/api/v1/validatingwebhookconfigurations", h.GetValidatingWebhookConfigurations)
	r.Get("/api/v1/validatingwebhookconfigurations/{name}/describe", h.DescribeValidatingWebhookConfiguration)
	r.Get("/api/v1/validatingwebhookconfigurations/{name}/yaml", h.GetValidatingWebhookConfigurationYAML)
	r.Delete("/api/v1/validatingwebhookconfigurations/{name}", h.DeleteValidatingWebhookConfiguration)

	// Lease (namespace-scoped)
	r.Get("/api/v1/leases/all", h.GetAllLeases)
	r.Get("/api/v1/namespaces/{namespace}/leases", h.GetLeases)
	r.Get("/api/v1/namespaces/{namespace}/leases/{name}/describe", h.DescribeLease)
	r.Get("/api/v1/namespaces/{namespace}/leases/{name}/yaml", h.GetLeaseYAML)
	r.Delete("/api/v1/namespaces/{namespace}/leases/{name}", h.DeleteLease)
}
