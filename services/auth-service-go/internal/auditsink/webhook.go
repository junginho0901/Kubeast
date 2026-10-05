package auditsink

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// WebhookConfig: an outbound HTTP POST per batch in one of these formats.
//
//	json       {"source":"kubeast","events":[…]}; optional X-Kubeast-Signature: sha256=<hmac> (Secret key hmacSecret)
//	slack      Slack incoming webhook (Secret key url)
//	teams      Teams Workflows "post to a channel when a webhook request is received" — an Adaptive Card (Secret key url)
//	discord    Discord channel webhook (Secret key url)
//	telegram   Bot API sendMessage to chatId (Secret key botToken)
//	pagerduty  Events API v2, one trigger per event, dedup key kubeast-audit-<id> (Secret key routingKey)
//
// URL may also sit in the config when it is not a secret (an in-cluster
// receiver); for telegram and pagerduty it overrides the public API address.
type WebhookConfig struct {
	Format   string `yaml:"format"`
	URL      string `yaml:"url"`
	ChatID   string `yaml:"chatId"`
	Severity string `yaml:"severity"` // pagerduty: info | warning (default) | error | critical; failures are sent as error at least
}

const chatLinesPerMessage = 20

type webhookSink struct {
	cfg    WebhookConfig
	url    string
	hmac   string
	token  string
	key    string
	client *http.Client
}

func newWebhookSink(s SinkConfig) (Sink, error) {
	c := s.Webhook
	if c.Format == "" {
		c.Format = "json"
	}
	w := &webhookSink{cfg: c, hmac: s.secret("hmacSecret"), client: &http.Client{Timeout: 15 * time.Second}}
	w.url = s.secret("url")
	if w.url == "" {
		w.url = c.URL
	}
	switch c.Format {
	case "json", "slack", "teams", "discord":
		if w.url == "" {
			return nil, fmt.Errorf("webhook %s needs a url (the sink Secret's url key, or webhook.url)", c.Format)
		}
	case "telegram":
		w.token = s.secret("botToken")
		if w.token == "" || c.ChatID == "" {
			return nil, errors.New("telegram needs the sink Secret's botToken and webhook.chatId")
		}
		if w.url == "" {
			w.url = "https://api.telegram.org"
		}
	case "pagerduty":
		w.key = s.secret("routingKey")
		if w.key == "" {
			return nil, errors.New("pagerduty needs the sink Secret's routingKey")
		}
		if w.url == "" {
			w.url = "https://events.pagerduty.com/v2/enqueue"
		}
		switch c.Severity {
		case "", "info", "warning", "error", "critical":
		default:
			return nil, fmt.Errorf("webhook.severity %q: info, warning, error or critical", c.Severity)
		}
	default:
		return nil, fmt.Errorf("webhook.format %q: json, slack, teams, discord, telegram or pagerduty", c.Format)
	}
	return w, nil
}

func (w *webhookSink) Send(ctx context.Context, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	switch w.cfg.Format {
	case "json":
		body, err := json.Marshal(map[string]any{"source": "kubeast", "events": events})
		if err != nil {
			return err
		}
		headers := map[string]string{}
		if w.hmac != "" {
			m := hmac.New(sha256.New, []byte(w.hmac))
			m.Write(body)
			headers["X-Kubeast-Signature"] = "sha256=" + hex.EncodeToString(m.Sum(nil))
		}
		return w.post(ctx, w.url, body, headers)
	case "pagerduty":
		for _, e := range events {
			if err := w.post(ctx, w.url, mustJSON(pagerDutyEvent(w.key, w.cfg.Severity, e)), nil); err != nil {
				return err
			}
		}
		return nil
	}
	// chat formats: chunks of lines
	for start := 0; start < len(events); start += chatLinesPerMessage {
		end := start + chatLinesPerMessage
		if end > len(events) {
			end = len(events)
		}
		var body []byte
		target := w.url
		switch w.cfg.Format {
		case "slack":
			body = mustJSON(slackMessage(events, start, end))
		case "teams":
			body = mustJSON(teamsMessage(events, start, end))
		case "discord":
			body = mustJSON(discordMessage(events, start, end))
		case "telegram":
			body = mustJSON(map[string]any{"chat_id": w.cfg.ChatID, "text": truncate(chatText(events, start, end), 4000), "disable_web_page_preview": true})
			target = strings.TrimRight(w.url, "/") + "/bot" + w.token + "/sendMessage"
		}
		if err := w.post(ctx, target, body, nil); err != nil {
			return err
		}
	}
	return nil
}

func chatText(events []Event, start, end int) string {
	var b strings.Builder
	b.WriteString(Summary(events[start:end]))
	for _, e := range events[start:end] {
		b.WriteString("\n• ")
		b.WriteString(e.Line())
	}
	return b.String()
}

func slackMessage(events []Event, start, end int) map[string]any {
	var lines []string
	for _, e := range events[start:end] {
		lines = append(lines, "• "+slackEscape(e.Line()))
	}
	title := slackEscape(Summary(events[start:end]))
	return map[string]any{
		"text": title,
		"blocks": []map[string]any{
			{"type": "section", "text": map[string]string{"type": "mrkdwn", "text": "*" + title + "*"}},
			{"type": "section", "text": map[string]string{"type": "mrkdwn", "text": truncate(strings.Join(lines, "\n"), 2900)}},
		},
	}
}

// slackEscape: &, < and > are control characters in Slack mrkdwn.
func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func teamsMessage(events []Event, start, end int) map[string]any {
	body := []map[string]any{{"type": "TextBlock", "text": Summary(events[start:end]), "weight": "Bolder", "wrap": true}}
	for _, e := range events[start:end] {
		body = append(body, map[string]any{"type": "TextBlock", "text": e.Line(), "wrap": true, "spacing": "Small"})
	}
	return map[string]any{
		"type": "message",
		"attachments": []map[string]any{{
			"contentType": "application/vnd.microsoft.card.adaptive",
			"contentUrl":  nil,
			"content": map[string]any{
				"$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
				"type":    "AdaptiveCard",
				"version": "1.4",
				"body":    body,
			},
		}},
	}
}

func discordMessage(events []Event, start, end int) map[string]any {
	return map[string]any{"username": "Kubeast", "content": truncate(chatText(events, start, end), 1990)}
}

func pagerDutyEvent(routingKey, severity string, e Event) map[string]any {
	if severity == "" {
		severity = "warning"
	}
	if e.Result == "failure" && (severity == "info" || severity == "warning") {
		severity = "error"
	}
	return map[string]any{
		"routing_key":  routingKey,
		"event_action": "trigger",
		"dedup_key":    fmt.Sprintf("kubeast-audit-%d", e.ID),
		"payload": map[string]any{
			"summary":        truncate(e.Line(), 1000),
			"source":         "kubeast",
			"severity":       severity,
			"timestamp":      e.Time.UTC().Format(time.RFC3339),
			"component":      e.Service,
			"group":          e.Cluster,
			"class":          e.Action,
			"custom_details": e,
		},
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func (w *webhookSink) post(ctx context.Context, url string, body []byte, headers map[string]string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "kubeast-audit-sink")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := w.client.Do(req)
	if err != nil {
		return fmt.Errorf("webhook %s: %w", w.cfg.Format, redactToken(err, w.token))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("webhook %s: HTTP %d: %s", w.cfg.Format, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	return nil
}

// redactToken keeps a Telegram bot token (part of the URL) out of error text,
// which ends up in logs and the cursor table.
func redactToken(err error, token string) error {
	if token == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), token, "<token>"))
}
