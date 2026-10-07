package gitops

import "testing"

func TestDetectTrackingAnnotation(t *testing.T) {
	cfg := Config{Enabled: true, Mode: ModeWarn, TrackingAnnotation: DefaultTrackingAnnotation}
	web := Object{Group: "apps", Kind: "Deployment", Namespace: "service-alpha", Name: "web",
		Annotations: map[string]string{DefaultTrackingAnnotation: "alpha-jobplanet:apps/Deployment:service-alpha/web"}}
	if r := cfg.Detect(web); !r.Managed || r.App != "alpha-jobplanet" || r.Method != "annotation" {
		t.Fatalf("self-referencing annotation: %+v", r)
	}
	// A core-group object: the group is empty in the tracking id.
	cm := Object{Kind: "ConfigMap", Namespace: "default", Name: "cm",
		Annotations: map[string]string{DefaultTrackingAnnotation: "app:/ConfigMap:default/cm"}}
	if r := cfg.Detect(cm); !r.Managed || r.App != "app" {
		t.Fatalf("core group: %+v", r)
	}
	// The annotation names another object (copied from a template): not managed.
	pod := Object{Kind: "Pod", Namespace: "service-alpha", Name: "web-abc",
		Annotations: map[string]string{DefaultTrackingAnnotation: "alpha-jobplanet:apps/Deployment:service-alpha/web"}}
	if r := cfg.Detect(pod); r.Managed {
		t.Fatalf("copied annotation must not claim the pod: %+v", r)
	}
	for _, bad := range []string{"", "alpha", "alpha:apps/Deployment", "alpha:Deployment:service-alpha/web", ":apps/Deployment:service-alpha/web"} {
		o := web
		o.Annotations = map[string]string{DefaultTrackingAnnotation: bad}
		if r := cfg.Detect(o); r.Managed {
			t.Errorf("malformed %q must not match: %+v", bad, r)
		}
	}
}

func TestDetectInstanceLabel(t *testing.T) {
	obj := Object{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: "n",
		Labels: map[string]string{"app.kubernetes.io/instance": "my-app"}}
	off := Config{Enabled: true, TrackingAnnotation: DefaultTrackingAnnotation}
	if r := off.Detect(obj); r.Managed {
		t.Fatalf("label tracking is off by default: %+v", r)
	}
	on := off
	on.InstanceLabel = "app.kubernetes.io/instance"
	if r := on.Detect(obj); !r.Managed || r.App != "my-app" || r.Method != "label" {
		t.Fatalf("label tracking on: %+v", r)
	}
	// The annotation wins over the label when both are present.
	obj.Annotations = map[string]string{DefaultTrackingAnnotation: "ann-app:apps/Deployment:ns/n"}
	if r := on.Detect(obj); r.App != "ann-app" || r.Method != "annotation" {
		t.Fatalf("annotation first: %+v", r)
	}
}

func TestDisabledAndMode(t *testing.T) {
	obj := Object{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: "n",
		Annotations: map[string]string{DefaultTrackingAnnotation: "a:apps/Deployment:ns/n"}}
	if r := (Config{Enabled: false, TrackingAnnotation: DefaultTrackingAnnotation}).Detect(obj); r.Managed {
		t.Fatalf("disabled must not detect: %+v", r)
	}
	if (Config{Enabled: true, Mode: ModeWarn}).Blocks() || !(Config{Enabled: true, Mode: ModeBlock}).Blocks() || (Config{Enabled: false, Mode: ModeBlock}).Blocks() {
		t.Fatal("Blocks: only enabled+block")
	}
	t.Setenv("GITOPS_ARGOCD_ENABLED", "true")
	t.Setenv("GITOPS_ARGOCD_MODE", "BLOCK")
	t.Setenv("GITOPS_ARGOCD_URL", "https://argocd.example.com/")
	c := LoadFromEnv()
	if !c.Enabled || c.Mode != ModeBlock || c.TrackingAnnotation != DefaultTrackingAnnotation || c.InstanceLabel != "" || c.URL != "https://argocd.example.com" {
		t.Fatalf("env: %+v", c)
	}
	t.Setenv("GITOPS_ARGOCD_MODE", "nonsense")
	if LoadFromEnv().Mode != ModeWarn {
		t.Fatal("unknown mode falls back to warn")
	}
}
