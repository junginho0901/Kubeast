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
			if err := w.post(ctx, w.url, pagerDutyBody(w.key, w.cfg.Severity, e), nil); err != nil {
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
			for _, card := range teamsBodies(events, start, end) {
				if err := w.post(ctx, target, card, nil); err != nil {
					return err
				}
			}
			continue
		case "discord":
			body = mustJSON(discordMessage(events, start, end))
		case "telegram":
			body = mustJSON(map[string]any{"chat_id": w.cfg.ChatID, "text": truncate(chatText(events, start, end, nil), 4000), "disable_web_page_preview": true})
			target = strings.TrimRight(w.url, "/") + "/bot" + w.token + "/sendMessage"
		}
		if err := w.post(ctx, target, body, nil); err != nil {
			return err
		}
	}
	return nil
}

// chatText is a batch as lines; escape makes a line plain words for a channel that reads markup.
func chatText(events []Event, start, end int, escape *strings.Replacer) string {
	var b strings.Builder
	b.WriteString(Summary(events[start:end]))
	for _, e := range events[start:end] {
		b.WriteString("\n• ")
		if escape != nil {
			b.WriteString(escape.Replace(e.Line()))
		} else {
			b.WriteString(e.Line())
		}
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

// teamsMaxBytes keeps a card under the 28 KB Teams takes in one message.
const teamsMaxBytes = 24 << 10

// teamsBodies is the card for events[start:end], split in halves while a card
// is over teamsMaxBytes; a card of one line still over it has the line cut to
// 1000 characters.
func teamsBodies(events []Event, start, end int) [][]byte {
	if body := mustJSON(teamsMessage(events, start, end, 0)); len(body) <= teamsMaxBytes {
		return [][]byte{body}
	}
	if end-start == 1 {
		return [][]byte{mustJSON(teamsMessage(events, start, end, 1000))}
	}
	mid := start + (end-start)/2
	return append(teamsBodies(events, start, mid), teamsBodies(events, mid, end)...)
}

// teamsMessage: lineMax > 0 cuts each line to that many characters.
func teamsMessage(events []Event, start, end, lineMax int) map[string]any {
	body := []map[string]any{{"type": "TextBlock", "text": Summary(events[start:end]), "weight": "Bolder", "wrap": true}}
	for _, e := range events[start:end] {
		line := e.Line()
		if lineMax > 0 {
			line = truncate(line, lineMax)
		}
		// A TextBlock reads Markdown and a line holds what a request wrote; a TextRun reads none.
		body = append(body, map[string]any{"type": "RichTextBlock", "spacing": "Small", "inlines": []map[string]any{{"type": "TextRun", "text": line}}})
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

// discordMarkup are the characters Discord reads as formatting, links and mentions.
var discordMarkup = strings.NewReplacer(`\`, `\\`, `*`, `\*`, `_`, `\_`, `~`, `\~`, "`", "\\`", `|`, `\|`, `>`, `\>`, `<`, `\<`, `[`, `\[`, `]`, `\]`, `#`, `\#`)

// discordMessage: a line holds what a request wrote, so it stays words, calls nobody and pulls in no preview of an address.
func discordMessage(events []Event, start, end int) map[string]any {
	const suppressEmbeds = 1 << 2
	return map[string]any{
		"username":         "Kubeast",
		"content":          truncate(chatText(events, start, end, discordMarkup), 1990),
		"allowed_mentions": map[string]any{"parse": []string{}},
		"flags":            suppressEmbeds,
	}
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

// pagerDutyMaxEventBytes is the largest event the Events API v2 takes.
const pagerDutyMaxEventBytes = 512000

// pagerDutyCutDetails is custom_details without the row's before and after.
type pagerDutyCutDetails struct {
	Event
	Note string `json:"note"`
}

// pagerDutyBody is the event as JSON. Over pagerDutyMaxEventBytes, which
// PagerDuty refuses with a 400 on every retry, custom_details drops the row's
// before and after, and then every field but a note, as Alertmanager and
// Grafana drop custom details past that size.
func pagerDutyBody(routingKey, severity string, e Event) []byte {
	ev := pagerDutyEvent(routingKey, severity, e)
	body := mustJSON(ev)
	if len(body) <= pagerDutyMaxEventBytes {
		return body
	}
	payload := ev["payload"].(map[string]any)
	cut := e
	cut.Before, cut.After = nil, nil
	payload["custom_details"] = pagerDutyCutDetails{Event: cut, Note: "before and after removed: the event was over the 512000 bytes PagerDuty takes"}
	if body = mustJSON(ev); len(body) <= pagerDutyMaxEventBytes {
		return body
	}
	payload["custom_details"] = map[string]string{"note": "custom details removed: the event was over the 512000 bytes PagerDuty takes"}
	return mustJSON(ev)
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
