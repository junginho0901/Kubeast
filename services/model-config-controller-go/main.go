package main

import (
	"os"

	"github.com/junginho0901/kube-assistant/model-config-controller-go/api/v1alpha1"
	"github.com/junginho0901/kube-assistant/model-config-controller-go/internal/controller"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func main() {
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(v1alpha1.AddToScheme(scheme))

	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

	metricsAddr := envOrDefault("METRICS_ADDR", ":8080")
	probeAddr := envOrDefault("HEALTH_PROBE_ADDR", ":8081")

	opts := ctrl.Options{
		Scheme: scheme,
		Metrics: server.Options{
			BindAddress: metricsAddr,
		},
		HealthProbeBindAddress: probeAddr,
	}
	if ns := os.Getenv("WATCH_NAMESPACE"); ns != "" {
		opts.Cache = cache.Options{
			DefaultNamespaces: map[string]cache.Config{ns: {}},
		}
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), opts)
	if err != nil {
		os.Exit(1)
	}

	reconciler := &controller.ModelConfigReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}
	if err := reconciler.SetupWithManager(mgr); err != nil {
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		os.Exit(1)
	}

	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		os.Exit(1)
	}
}

func envOrDefault(key, value string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return value
}
