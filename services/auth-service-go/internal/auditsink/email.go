package auditsink

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// EmailConfig: one mail per batch over SMTP. tls = starttls (default, port
// 587), tls (implicit, 465) or none (a local relay such as Mailpit). Login
// comes from the sink Secret (username, password) and is refused without TLS.
type EmailConfig struct {
	Host string   `yaml:"host"`
	Port int      `yaml:"port"`
	TLS  string   `yaml:"tls"`
	From string   `yaml:"from"`
	To   []string `yaml:"to"`
}

type emailSink struct {
	cfg      EmailConfig
	username string
	password string
	timeout  time.Duration
}

func newEmailSink(s SinkConfig) (Sink, error) {
	c := s.Email
	if c.Host == "" || c.From == "" || len(c.To) == 0 {
		return nil, errors.New("email needs host, from and at least one to address")
	}
	if c.TLS == "" {
		c.TLS = "starttls"
	}
	if c.TLS != "starttls" && c.TLS != "tls" && c.TLS != "none" {
		return nil, fmt.Errorf("email.tls %q: starttls, tls or none", c.TLS)
	}
	if c.Port == 0 {
		c.Port = map[string]int{"starttls": 587, "tls": 465, "none": 25}[c.TLS]
	}
	e := &emailSink{cfg: c, username: s.secret("username"), password: s.secret("password"), timeout: 20 * time.Second}
	if e.username != "" && c.TLS == "none" {
		return nil, errors.New("email login over a connection without TLS is refused (set email.tls)")
	}
	return e, nil
}

func (e *emailSink) message(events []Event, now time.Time) []byte {
	var b bytes.Buffer
	header := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	header("From", e.cfg.From)
	header("To", strings.Join(e.cfg.To, ", "))
	header("Subject", mime.QEncoding.Encode("utf-8", Summary(events)))
	header("Date", now.UTC().Format(time.RFC1123Z))
	header("Message-ID", fmt.Sprintf("<kubeast-audit-%d-%d@kubeast>", events[0].ID, events[len(events)-1].ID))
	header("MIME-Version", "1.0")
	header("Content-Type", `text/plain; charset="utf-8"`)
	header("Content-Transfer-Encoding", "8bit")
	b.WriteString("\r\n")
	for _, ev := range events {
		b.WriteString("- " + ev.Line() + "\r\n")
	}
	b.WriteString("\r\n-- records (NDJSON) --\r\n")
	for _, ev := range events {
		line, _ := json.Marshal(ev)
		b.Write(line)
		b.WriteString("\r\n")
	}
	return b.Bytes()
}

func (e *emailSink) Send(ctx context.Context, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	addr := net.JoinHostPort(e.cfg.Host, strconv.Itoa(e.cfg.Port))
	dialer := &net.Dialer{Timeout: e.timeout}
	var conn net.Conn
	var err error
	if e.cfg.TLS == "tls" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: e.cfg.Host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	_ = conn.SetDeadline(time.Now().Add(e.timeout))
	c, err := smtp.NewClient(conn, e.cfg.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp: %w", err)
	}
	defer c.Close()
	if e.cfg.TLS == "starttls" {
		if err := c.StartTLS(&tls.Config{ServerName: e.cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if e.username != "" {
		if err := c.Auth(smtp.PlainAuth("", e.username, e.password, e.cfg.Host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(e.cfg.From); err != nil {
		return fmt.Errorf("smtp mail from: %w", err)
	}
	for _, to := range e.cfg.To {
		if err := c.Rcpt(to); err != nil {
			return fmt.Errorf("smtp rcpt %s: %w", to, err)
		}
	}
	wc, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := wc.Write(e.message(events, time.Now())); err != nil {
		wc.Close()
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("smtp data end: %w", err)
	}
	return c.Quit()
}
