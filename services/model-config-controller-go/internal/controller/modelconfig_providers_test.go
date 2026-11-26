package controller

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/model-config-controller-go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The providers ai-service can call. bedrock, geminivertexai and anthropicvertexai were accepted with no code to call
// them and are refused now.
var callableProviders = []string{"anthropic", "azureopenai", "claude-code", "gemini", "ollama", "openai"}

func TestProviderSetHoldsTheCallableProvidersOnly(t *testing.T) {
	if got := v1alpha1.ProviderSet.List(); !reflect.DeepEqual(got, callableProviders) {
		t.Fatalf("ProviderSet = %v, want %v", got, callableProviders)
	}
}

func TestTheCRDProviderEnumIsProviderSet(t *testing.T) {
	crd, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "helm", "kubeast", "templates", "model-config-crd.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^ +provider:\n +type: string\n +default: openai\n +enum: \[([^\]]*)\]$`).FindSubmatch(crd)
	if m == nil {
		t.Fatal("the CRD's spec.provider enum was not found")
	}
	var enum []string
	for _, v := range strings.Split(string(m[1]), ",") {
		enum = append(enum, strings.TrimSpace(v))
	}
	sort.Strings(enum)
	if want := v1alpha1.ProviderSet.List(); !reflect.DeepEqual(enum, want) {
		t.Fatalf("CRD enum = %v, ProviderSet = %v", enum, want)
	}
}

func TestParseSpec_RefusesAProviderItCannotCall(t *testing.T) {
	r := &ModelConfigReconciler{}
	parse := func(provider string) error {
		_, err := r.parseSpec(&v1alpha1.ModelConfig{
			ObjectMeta: metav1.ObjectMeta{Name: "mc"},
			Spec:       v1alpha1.ModelConfigSpec{Provider: provider, Model: "m"},
		})
		return err
	}
	for _, p := range []string{"bedrock", "geminivertexai", "anthropicvertexai", "Bedrock", "custom", "unknown"} {
		err := parse(p)
		if err == nil || err.Error() != "unsupported provider: "+strings.ToLower(p) {
			t.Fatalf("provider %q: got %v, want unsupported provider", p, err)
		}
	}
	for _, p := range callableProviders {
		if err := parse(p); err != nil {
			t.Fatalf("provider %q: %v", p, err)
		}
	}
}
