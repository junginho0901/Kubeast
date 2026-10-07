package main

import (
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

func TestGitopsObjects(t *testing.T) {
	one := `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"ns","annotations":{"argocd.argoproj.io/tracking-id":"app:apps/Deployment:ns/web"}}}`
	objs, err := gitopsObjects([]byte(one))
	if err != nil || len(objs) != 1 || objs[0].Group != "apps" || objs[0].Kind != "Deployment" || objs[0].Name != "web" {
		t.Fatalf("single: %+v %v", objs, err)
	}
	list := `{"kind":"List","apiVersion":"v1","items":[` + one + `,{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"cm"}}]}`
	objs, err = gitopsObjects([]byte(list))
	if err != nil || len(objs) != 2 || objs[1].Group != "" || objs[1].Kind != "ConfigMap" {
		t.Fatalf("list: %+v %v", objs, err)
	}
	if objs, _ := gitopsObjects([]byte(`{"apiVersion":"v1","kind":"","metadata":{}}`)); len(objs) != 0 {
		t.Fatalf("nameless: %+v", objs)
	}
}

func TestGitopsRefuseObjectsBlocksManaged(t *testing.T) {
	saved := gitopsCfg
	defer func() { gitopsCfg = saved }()
	gitopsCfg = gitops.Config{Enabled: true, Mode: gitops.ModeBlock, TrackingAnnotation: gitops.DefaultTrackingAnnotation}
	managed := gitops.Object{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: "web",
		Annotations: map[string]string{gitops.DefaultTrackingAnnotation: "app:apps/Deployment:ns/web"}}
	free := gitops.Object{Kind: "ConfigMap", Namespace: "ns", Name: "cm"}
	if err := gitopsRefuseObjects(nil, nil, []gitops.Object{free}, false); err != nil {
		t.Fatalf("unmanaged must pass: %v", err)
	}
	err := gitopsRefuseObjects(nil, nil, []gitops.Object{free, managed}, false)
	if err == nil || err.Error() != "conflict: Deployment ns/web is managed by Argo CD application app; change it in Git" {
		t.Fatalf("managed must be refused with the app name: %v", err)
	}
	gitopsCfg.Mode = gitops.ModeWarn
	if err := gitopsRefuseObjects(nil, nil, []gitops.Object{managed}, false); err != nil {
		t.Fatalf("warn mode must pass: %v", err)
	}
}
