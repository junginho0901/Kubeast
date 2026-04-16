package k8s

import (
	"context"
	"fmt"
	"sync"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ── Mutating Webhook Configurations ─────────────────────────────────────────

// GetMutatingWebhookConfigurations lists all MutatingWebhookConfigurations.
func (s *Service) GetMutatingWebhookConfigurations(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AdmissionregistrationV1().MutatingWebhookConfigurations().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list mutatingwebhookconfigurations: %w", err)
	}
	return formatMutatingWebhookConfigList(list.Items), nil
}

// DescribeMutatingWebhookConfiguration returns detailed info about a MutatingWebhookConfiguration.
func (s *Service) DescribeMutatingWebhookConfiguration(ctx context.Context, name string) (map[string]interface{}, error) {
	var mwc *admissionregistrationv1.MutatingWebhookConfiguration
	var events *corev1.EventList
	var mwcErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		mwc, mwcErr = s.Clientset().AdmissionregistrationV1().MutatingWebhookConfigurations().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=MutatingWebhookConfiguration", name),
		})
	}()
	wg.Wait()

	if mwcErr != nil {
		return nil, fmt.Errorf("get mutatingwebhookconfiguration %s: %w", name, mwcErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatMutatingWebhookConfigSummary(mwc)

	// Additional metadata
	result["uid"] = string(mwc.UID)
	result["resource_version"] = mwc.ResourceVersion
	result["generation"] = mwc.Generation
	result["annotations"] = mwc.Annotations
	result["labels"] = mwc.Labels

	// Webhooks detail
	result["webhooks"] = formatMutatingWebhooks(mwc.Webhooks)

	// Events
	eventList := make([]map[string]interface{}, 0, len(events.Items))
	for _, e := range events.Items {
		eventList = append(eventList, map[string]interface{}{
			"type":       e.Type,
			"reason":     e.Reason,
			"message":    e.Message,
			"count":      e.Count,
			"first_time": toISO(&e.FirstTimestamp),
			"last_time":  toISO(&e.LastTimestamp),
			"source":     e.Source.Component,
		})
	}
	result["events"] = eventList

	return result, nil
}

// DeleteMutatingWebhookConfiguration deletes a MutatingWebhookConfiguration.
func (s *Service) DeleteMutatingWebhookConfiguration(ctx context.Context, name string) error {
	return s.Clientset().AdmissionregistrationV1().MutatingWebhookConfigurations().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatMutatingWebhookConfigList(items []admissionregistrationv1.MutatingWebhookConfiguration) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, formatMutatingWebhookConfigSummary(&items[i]))
	}
	return result
}

func formatMutatingWebhookConfigSummary(mwc *admissionregistrationv1.MutatingWebhookConfiguration) map[string]interface{} {
	return map[string]interface{}{
		"name":          mwc.Name,
		"webhooks_count": len(mwc.Webhooks),
		"labels":        mwc.Labels,
		"created_at":    toISO(&mwc.CreationTimestamp),
	}
}

func formatMutatingWebhooks(webhooks []admissionregistrationv1.MutatingWebhook) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(webhooks))
	for _, wh := range webhooks {
		w := map[string]interface{}{
			"name":                      wh.Name,
			"admission_review_versions": wh.AdmissionReviewVersions,
			"failure_policy":            ptrToString((*string)(wh.FailurePolicy)),
			"match_policy":              ptrToString((*string)(wh.MatchPolicy)),
			"side_effects":              ptrToString((*string)(wh.SideEffects)),
			"timeout_seconds":           ptrInt32(wh.TimeoutSeconds),
			"reinvocation_policy":       ptrToString((*string)(wh.ReinvocationPolicy)),
			"rules":                     formatWebhookRules(wh.Rules),
		}

		// Client config
		cc := map[string]interface{}{}
		if wh.ClientConfig.URL != nil {
			cc["url"] = *wh.ClientConfig.URL
		}
		if wh.ClientConfig.Service != nil {
			svc := map[string]interface{}{
				"name":      wh.ClientConfig.Service.Name,
				"namespace": wh.ClientConfig.Service.Namespace,
			}
			if wh.ClientConfig.Service.Path != nil {
				svc["path"] = *wh.ClientConfig.Service.Path
			}
			if wh.ClientConfig.Service.Port != nil {
				svc["port"] = *wh.ClientConfig.Service.Port
			}
			cc["service"] = svc
		}
		if wh.ClientConfig.CABundle != nil {
			cc["ca_bundle"] = len(wh.ClientConfig.CABundle) > 0
		}
		w["client_config"] = cc

		// Namespace selector
		if wh.NamespaceSelector != nil {
			w["namespace_selector"] = formatLabelSelector(wh.NamespaceSelector)
		}
		// Object selector
		if wh.ObjectSelector != nil {
			w["object_selector"] = formatLabelSelector(wh.ObjectSelector)
		}

		result = append(result, w)
	}
	return result
}

// ── Validating Webhook Configurations ───────────────────────────────────────

// GetValidatingWebhookConfigurations lists all ValidatingWebhookConfigurations.
func (s *Service) GetValidatingWebhookConfigurations(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AdmissionregistrationV1().ValidatingWebhookConfigurations().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list validatingwebhookconfigurations: %w", err)
	}
	return formatValidatingWebhookConfigList(list.Items), nil
}

// DescribeValidatingWebhookConfiguration returns detailed info about a ValidatingWebhookConfiguration.
func (s *Service) DescribeValidatingWebhookConfiguration(ctx context.Context, name string) (map[string]interface{}, error) {
	var vwc *admissionregistrationv1.ValidatingWebhookConfiguration
	var events *corev1.EventList
	var vwcErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		vwc, vwcErr = s.Clientset().AdmissionregistrationV1().ValidatingWebhookConfigurations().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=ValidatingWebhookConfiguration", name),
		})
	}()
	wg.Wait()

	if vwcErr != nil {
		return nil, fmt.Errorf("get validatingwebhookconfiguration %s: %w", name, vwcErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatValidatingWebhookConfigSummary(vwc)

	// Additional metadata
	result["uid"] = string(vwc.UID)
	result["resource_version"] = vwc.ResourceVersion
	result["generation"] = vwc.Generation
	result["annotations"] = vwc.Annotations
	result["labels"] = vwc.Labels

	// Webhooks detail
	result["webhooks"] = formatValidatingWebhooks(vwc.Webhooks)

	// Events
	eventList := make([]map[string]interface{}, 0, len(events.Items))
	for _, e := range events.Items {
		eventList = append(eventList, map[string]interface{}{
			"type":       e.Type,
			"reason":     e.Reason,
			"message":    e.Message,
			"count":      e.Count,
			"first_time": toISO(&e.FirstTimestamp),
			"last_time":  toISO(&e.LastTimestamp),
			"source":     e.Source.Component,
		})
	}
	result["events"] = eventList

	return result, nil
}

// DeleteValidatingWebhookConfiguration deletes a ValidatingWebhookConfiguration.
func (s *Service) DeleteValidatingWebhookConfiguration(ctx context.Context, name string) error {
	return s.Clientset().AdmissionregistrationV1().ValidatingWebhookConfigurations().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatValidatingWebhookConfigList(items []admissionregistrationv1.ValidatingWebhookConfiguration) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, formatValidatingWebhookConfigSummary(&items[i]))
	}
	return result
}

func formatValidatingWebhookConfigSummary(vwc *admissionregistrationv1.ValidatingWebhookConfiguration) map[string]interface{} {
	return map[string]interface{}{
		"name":          vwc.Name,
		"webhooks_count": len(vwc.Webhooks),
		"labels":        vwc.Labels,
		"created_at":    toISO(&vwc.CreationTimestamp),
	}
}

func formatValidatingWebhooks(webhooks []admissionregistrationv1.ValidatingWebhook) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(webhooks))
	for _, wh := range webhooks {
		w := map[string]interface{}{
			"name":                      wh.Name,
			"admission_review_versions": wh.AdmissionReviewVersions,
			"failure_policy":            ptrToString((*string)(wh.FailurePolicy)),
			"match_policy":              ptrToString((*string)(wh.MatchPolicy)),
			"side_effects":              ptrToString((*string)(wh.SideEffects)),
			"timeout_seconds":           ptrInt32(wh.TimeoutSeconds),
			"rules":                     formatWebhookRules(wh.Rules),
		}

		// Client config
		cc := map[string]interface{}{}
		if wh.ClientConfig.URL != nil {
			cc["url"] = *wh.ClientConfig.URL
		}
		if wh.ClientConfig.Service != nil {
			svc := map[string]interface{}{
				"name":      wh.ClientConfig.Service.Name,
				"namespace": wh.ClientConfig.Service.Namespace,
			}
			if wh.ClientConfig.Service.Path != nil {
				svc["path"] = *wh.ClientConfig.Service.Path
			}
			if wh.ClientConfig.Service.Port != nil {
				svc["port"] = *wh.ClientConfig.Service.Port
			}
			cc["service"] = svc
		}
		if wh.ClientConfig.CABundle != nil {
			cc["ca_bundle"] = len(wh.ClientConfig.CABundle) > 0
		}
		w["client_config"] = cc

		// Namespace selector
		if wh.NamespaceSelector != nil {
			w["namespace_selector"] = formatLabelSelector(wh.NamespaceSelector)
		}
		// Object selector
		if wh.ObjectSelector != nil {
			w["object_selector"] = formatLabelSelector(wh.ObjectSelector)
		}

		result = append(result, w)
	}
	return result
}

// ── Shared helpers ──────────────────────────────────────────────────────────

func formatWebhookRules(rules []admissionregistrationv1.RuleWithOperations) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(rules))
	for _, rule := range rules {
		ops := make([]string, 0, len(rule.Operations))
		for _, op := range rule.Operations {
			ops = append(ops, string(op))
		}
		r := map[string]interface{}{
			"api_groups":   rule.APIGroups,
			"api_versions": rule.APIVersions,
			"operations":   ops,
			"resources":    rule.Resources,
		}
		if rule.Scope != nil {
			r["scope"] = string(*rule.Scope)
		}
		result = append(result, r)
	}
	return result
}

func formatLabelSelector(sel *metav1.LabelSelector) map[string]interface{} {
	result := map[string]interface{}{}
	if sel.MatchLabels != nil {
		result["match_labels"] = sel.MatchLabels
	}
	if len(sel.MatchExpressions) > 0 {
		exprs := make([]map[string]interface{}, 0, len(sel.MatchExpressions))
		for _, expr := range sel.MatchExpressions {
			exprs = append(exprs, map[string]interface{}{
				"key":      expr.Key,
				"operator": string(expr.Operator),
				"values":   expr.Values,
			})
		}
		result["match_expressions"] = exprs
	}
	return result
}

func ptrToString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func ptrInt32(p *int32) int32 {
	if p == nil {
		return 0
	}
	return *p
}
