package controller

import (
	"context"
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/model-config-controller-go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestParseSpec_DefaultsAndBaseURL(t *testing.T) {
	r := &ModelConfigReconciler{}

	mc := &v1alpha1.ModelConfig{
		ObjectMeta: metav1.ObjectMeta{Name: "mc"},
		Spec: v1alpha1.ModelConfigSpec{
			Model:  "gpt-4o-mini",
			OpenAI: &v1alpha1.OpenAIConfig{BaseURL: " https://openai.example/v1 "},
		},
	}

	data, err := r.parseSpec(mc)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if data.Provider != "openai" {
		t.Fatalf("expected provider openai, got %s", data.Provider)
	}
	if data.BaseURL != "https://openai.example/v1" {
		t.Fatalf("expected baseURL trimmed, got %q", data.BaseURL)
	}
	if !data.TLSVerify || !data.Enabled || data.IsDefault {
		t.Fatalf("expected defaults tlsVerify/enabled true, isDefault false")
	}

	mc = &v1alpha1.ModelConfig{
		ObjectMeta: metav1.ObjectMeta{Name: "mc-azure"},
		Spec: v1alpha1.ModelConfigSpec{
			Provider:    "azureopenai",
			Model:       "gpt-4o-mini",
			AzureOpenAI: &v1alpha1.AzureOpenAIConfig{AzureEndpoint: "https://azure.example"},
		},
	}
	data, err = r.parseSpec(mc)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if data.BaseURL != "https://azure.example" {
		t.Fatalf("expected azure baseURL, got %q", data.BaseURL)
	}

	mc = &v1alpha1.ModelConfig{
		ObjectMeta: metav1.ObjectMeta{Name: "mc-ollama"},
		Spec: v1alpha1.ModelConfigSpec{
			Provider: "ollama",
			Model:    "llama3",
			Ollama:   &v1alpha1.OllamaConfig{Host: "http://ollama:11434"},
		},
	}
	data, err = r.parseSpec(mc)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if data.BaseURL != "http://ollama:11434" {
		t.Fatalf("expected ollama host as baseURL, got %q", data.BaseURL)
	}

	mc = &v1alpha1.ModelConfig{
		ObjectMeta: metav1.ObjectMeta{Name: "mc-subscription"},
		Spec: v1alpha1.ModelConfigSpec{
			Provider:  "claude-code",
			Model:     "claude-sonnet-5-5",
			APIKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
		},
	}
	data, err = r.parseSpec(mc)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if data.Provider != "claude-code" || data.BaseURL != "" || data.APIKeyEnv != "CLAUDE_CODE_OAUTH_TOKEN" {
		t.Fatalf("expected claude-code without a base URL, got %+v", data)
	}
}

func TestParseSpec_Tier(t *testing.T) {
	r := &ModelConfigReconciler{}
	spec := func(tier string) *v1alpha1.ModelConfig {
		return &v1alpha1.ModelConfig{
			ObjectMeta: metav1.ObjectMeta{Name: "mc"},
			Spec:       v1alpha1.ModelConfigSpec{Model: "m", OpenAI: &v1alpha1.OpenAIConfig{}, Tier: tier},
		}
	}
	for in, want := range map[string]string{"": "default", "default": "default", " Economy ": "economy"} {
		data, err := r.parseSpec(spec(in))
		if err != nil || data.Tier != want {
			t.Fatalf("tier %q: got %q, %v; want %q", in, data.Tier, err, want)
		}
	}
	if _, err := r.parseSpec(spec("cheap")); err == nil {
		t.Fatalf("an unknown tier must be refused")
	}
}

func TestParseSpec_RejectUnsupportedProvider(t *testing.T) {
	r := &ModelConfigReconciler{}
	mc := &v1alpha1.ModelConfig{
		ObjectMeta: metav1.ObjectMeta{Name: "mc"},
		Spec: v1alpha1.ModelConfigSpec{
			Provider: "unknown",
			Model:    "gpt-4o-mini",
		},
	}
	if _, err := r.parseSpec(mc); err == nil {
		t.Fatal("expected error for unsupported provider")
	}
}

func TestResolveSecret(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = v1alpha1.AddToScheme(scheme)

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "api-key",
			Namespace: "ns",
		},
		Data: map[string][]byte{
			"API_KEY": []byte("secret-value"),
		},
	}

	client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(secret).Build()
	r := &ModelConfigReconciler{Client: client, Scheme: scheme}

	mc := &v1alpha1.ModelConfig{
		ObjectMeta: metav1.ObjectMeta{Name: "mc", Namespace: "ns"},
		Spec: v1alpha1.ModelConfigSpec{
			Provider: "openai",
			Model:    "gpt-4o-mini",
			APIKeySecretRef: &v1alpha1.SecretKeyRef{
				Name: "api-key",
				Key:  "API_KEY",
			},
		},
	}

	hash, state, msg, err := r.resolveSecret(context.Background(), mc)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	expected := fmt.Sprintf("%x", sha256.Sum256([]byte("secret-value")))
	if hash != expected {
		t.Fatalf("expected hash %s, got %s", expected, hash)
	}
	if state != metav1.ConditionTrue || msg != "Secret resolved" {
		t.Fatalf("expected secret resolved, got %s / %s", state, msg)
	}
}

func TestMergeConditionsPreservesTransitionTime(t *testing.T) {
	oldTime := metav1.NewTime(time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))
	existing := []metav1.Condition{
		{
			Type:               "Synced",
			Status:             metav1.ConditionTrue,
			Reason:             "Synced",
			Message:            "ok",
			LastTransitionTime: oldTime,
		},
	}
	updates := []metav1.Condition{
		{
			Type:    "Synced",
			Status:  metav1.ConditionTrue,
			Reason:  "Synced",
			Message: "ok",
		},
	}
	out := mergeConditions(existing, updates...)
	if len(out) != 1 {
		t.Fatalf("expected 1 condition, got %d", len(out))
	}
	if !out[0].LastTransitionTime.Time.Equal(oldTime.Time) {
		t.Fatalf("expected LastTransitionTime to be preserved")
	}

	updates[0].Status = metav1.ConditionFalse
	out = mergeConditions(existing, updates...)
	if out[0].LastTransitionTime.Time.Equal(oldTime.Time) {
		t.Fatalf("expected LastTransitionTime to change on status change")
	}
}

func TestConditionsEqual(t *testing.T) {
	a := []metav1.Condition{{Type: "Synced", Status: metav1.ConditionTrue, Reason: "Ok", Message: "ok"}}
	b := []metav1.Condition{{Type: "Synced", Status: metav1.ConditionTrue, Reason: "Ok", Message: "ok"}}
	if !conditionsEqual(a, b) {
		t.Fatal("expected conditions equal")
	}
	b[0].Message = "changed"
	if conditionsEqual(a, b) {
		t.Fatal("expected conditions not equal when message differs")
	}
}

func TestProviderLabel(t *testing.T) {
	mc := &v1alpha1.ModelConfig{Spec: v1alpha1.ModelConfigSpec{Provider: "OpenAI"}}
	if providerLabel(mc) != "openai" {
		t.Fatalf("expected openai, got %s", providerLabel(mc))
	}
	mc.Spec.Provider = ""
	if providerLabel(mc) != "unknown" {
		t.Fatalf("expected unknown for empty provider")
	}
}

func TestParseSpec_LimitsAndCACert(t *testing.T) {
	r := &ModelConfigReconciler{}
	n := func(v int64) *int64 { return &v }
	parse := func(spec v1alpha1.ModelConfigSpec) (modelConfigData, error) {
		return r.parseSpec(&v1alpha1.ModelConfig{ObjectMeta: metav1.ObjectMeta{Name: "mc"}, Spec: spec})
	}

	// the two limits as numbers in the options, next to Ollama's options; the CA certificate trimmed
	data, err := parse(v1alpha1.ModelConfigSpec{Provider: "ollama", Model: "llama3", MaxTokens: n(8000), ToolResultChars: n(3000),
		CACert: " -----BEGIN CERTIFICATE-----\n", Ollama: &v1alpha1.OllamaConfig{Options: map[string]string{"num_ctx": "8192"}}})
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]interface{}{"num_ctx": "8192", "max_tokens": int64(8000), "tool_result_chars": int64(3000)}; fmt.Sprint(data.Options) != fmt.Sprint(want) {
		t.Fatalf("options: %v, want %v", data.Options, want)
	}
	if data.CACert != "-----BEGIN CERTIFICATE-----" {
		t.Fatalf("caCert: %q", data.CACert)
	}

	// the provider section's maxTokens when spec.maxTokens is empty; spec.maxTokens first
	for _, c := range []struct {
		spec v1alpha1.ModelConfigSpec
		want interface{}
	}{
		{v1alpha1.ModelConfigSpec{Model: "m", OpenAI: &v1alpha1.OpenAIConfig{MaxTokens: n(900)}}, int64(900)},
		{v1alpha1.ModelConfigSpec{Provider: "anthropic", Model: "m", Anthropic: &v1alpha1.AnthropicConfig{MaxTokens: n(700)}}, int64(700)},
		{v1alpha1.ModelConfigSpec{Model: "m", MaxTokens: n(32000), OpenAI: &v1alpha1.OpenAIConfig{MaxTokens: n(900)}}, int64(32000)},
		// another provider's section is not this provider's
		{v1alpha1.ModelConfigSpec{Provider: "anthropic", Model: "m", OpenAI: &v1alpha1.OpenAIConfig{MaxTokens: n(900)}}, nil},
	} {
		data, err := parse(c.spec)
		if err != nil {
			t.Fatal(err)
		}
		got := interface{}(nil)
		if data.Options != nil {
			got = data.Options["max_tokens"]
		}
		if got != c.want {
			t.Fatalf("%+v: max_tokens %v, want %v", c.spec, got, c.want)
		}
	}

	// nothing set: no options at all (the row's options stay NULL)
	if data, _ := parse(v1alpha1.ModelConfigSpec{Model: "m"}); data.Options != nil {
		t.Fatalf("options without limits: %v", data.Options)
	}

	// out of range (a resource stored before the schema had the bounds): refused with the field's name
	for _, spec := range []v1alpha1.ModelConfigSpec{
		{Model: "m", MaxTokens: n(0)}, {Model: "m", MaxTokens: n(1_000_001)},
		{Model: "m", ToolResultChars: n(999)}, {Model: "m", ToolResultChars: n(200_001)},
	} {
		if _, err := parse(spec); err == nil {
			t.Fatalf("%+v must be refused", spec)
		}
	}
}
